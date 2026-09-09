// The main loop: plan -> approve -> dispatch cards (parallel) -> check -> merge back -> docs.
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getAdapter } from '../adapters/index.ts';
import { type Config, roleConfig, STATE_DIR } from '../config.ts';
import { buildCommonContext, cardFiles } from '../context/common.ts';
import { extractPaths, openMemory } from '../context/memory.ts';
import { worktreesDir } from '../paths.ts';
import * as store from '../board/store.ts';
import { allTerminal, blockUnreachable, readyCards } from '../board/scheduler.ts';
import * as git from '../git/worktree.ts';
import { CHECK_SCHEMA, DOCS_SCHEMA, PLANNER_SCHEMA, WORKER_SCHEMA } from '../roles/schemas.ts';
import * as P from '../roles/prompts.ts';
import { type AgentRegistry, runAgent, markFailed } from './agentProcess.ts';
import type { Board, Card, CheckResult, DocsResult, PlannerResult, Task, WorkerResult } from '../types.ts';

export interface OrchestratorHooks {
  /** Called after every board change. */
  onBoardChange?: (board: Board) => void;
  /** Human-readable progress line. */
  log?: (msg: string) => void;
  /** Return once the user has approved the (possibly edited) board. */
  approve?: (board: Board) => Promise<void>;
}

export interface Orchestrator {
  board: Board;
  registry: AgentRegistry;
  /** Run the planner and populate the board. */
  plan(): Promise<void>;
  /** Run all cards + docs until the board is terminal. */
  execute(): Promise<void>;
  abort(): void;
}

export function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${randomBytes(2).toString('hex')}`;
}

export function createBoard(repoRoot: string, goal: string, runId = newRunId()): Board {
  const board: Board = {
    runId, goal,
    baseRef: git.headRef(repoRoot),
    baseBranch: git.currentBranch(repoRoot),
    runBranch: `usta/${runId}`,
    createdAt: new Date().toISOString(),
    cards: [],
    docs: { status: 'pending' },
    costUsd: 0,
  };
  if (!git.branchExists(repoRoot, board.runBranch)) git.createBranch(repoRoot, board.runBranch, board.baseRef);
  // context/ and config.json stay committable.
  git.excludeFromGit(repoRoot, [`${STATE_DIR}/*`, `!${STATE_DIR}/context`, `!${STATE_DIR}/config.json`], [`${STATE_DIR}/`]);
  store.saveBoard(repoRoot, board);
  return board;
}

export function createOrchestrator(repoRoot: string, board: Board, config: Config, hooks: OrchestratorHooks = {}): Orchestrator {
  const ctrl = new AbortController();
  const registry: AgentRegistry = { statuses: new Map(), onChange: () => hooks.onBoardChange?.(board) };
  const log = (msg: string) => hooks.log?.(msg);
  const logs = store.logDir(repoRoot, board.runId);
  mkdirSync(logs, { recursive: true });
  const memory = openMemory(repoRoot, config.memory);
  const context = (opts: Parameters<typeof buildCommonContext>[3] = {}) => buildCommonContext(repoRoot, board, memory, opts);

  const save = (type: string, extra: Partial<{ cardId: string; taskId: string; message: string; data: unknown }> = {}) => {
    store.saveBoard(repoRoot, board);
    store.appendEvent(repoRoot, board.runId, { type, ...extra });
    hooks.onBoardChange?.(board);
  };

  const addCost = (card: Card | undefined, cost?: number) => {
    if (!cost) return;
    board.costUsd += cost;
    if (card) card.costUsd += cost;
  };

  const agent = <T>(role: Parameters<typeof roleConfig>[1], run: Omit<Parameters<typeof runAgent>[0]['run'], 'model' | 'maxBudgetUsd'>, ids: { cardId?: string; taskId?: string; logName: string }) => {
    const rc = roleConfig(config, role);
    return runAgent({
      registry, adapter: getAdapter(rc.harness, config), role, harness: rc.harness,
      cardId: ids.cardId, taskId: ids.taskId, logDir: logs, logName: ids.logName,
      stallTimeoutSec: config.stallTimeoutSec, parentSignal: ctrl.signal,
      run: { ...run, model: rc.model, maxBudgetUsd: rc.maxBudgetUsd },
    }).then((r) => ({ ...r, output: r.output as T | undefined }));
  };

  // ---- planner ----
  async function plan(): Promise<void> {
    log('planning…');
    const r = await agent<PlannerResult>('planner', {
      prompt: P.plannerPrompt(board.goal, context({ root: repoRoot })), systemPrompt: P.plannerSystem(), cwd: repoRoot, schema: PLANNER_SCHEMA, access: 'readonly',
    }, { logName: 'planner' });
    addCost(undefined, r.costUsd);
    if (!r.ok || !r.output?.cards?.length) throw new Error(`planner failed: ${r.error ?? 'no cards returned'}`);
    board.cards = store.cardsFromPlan(r.output);
    store.validateBoard(board);
    save('planned', { data: { cards: board.cards.length } });
    log(`planned ${board.cards.length} cards`);
  }

  // ---- one task (with continuations) ----
  async function runTask(card: Card, task: Task, cwd: string): Promise<WorkerResult | undefined> {
    task.status = 'running';
    task.attempts++;
    save('task_started', { cardId: card.id, taskId: task.id });
    const sys = P.workerSystem();
    const ctx = context({ files: cardFiles(card, cwd), root: cwd });
    let prompt = task.kind === 'fix' ? P.workerFixPrompt(board, card, task, ctx) : P.workerPrompt(board, card, task, ctx);
    let sessionId: string | undefined;
    let last: WorkerResult | undefined;

    for (let cont = 0; cont <= config.maxContinuations; cont++) {
      const r = await agent<WorkerResult>('worker', {
        prompt, systemPrompt: sys, cwd, schema: WORKER_SCHEMA, access: 'write', resumeSessionId: sessionId,
      }, { cardId: card.id, taskId: task.id, logName: `${card.id}.${task.id}.${task.attempts}${cont ? `.cont${cont}` : ''}` });
      addCost(card, r.costUsd);
      sessionId = r.sessionId;
      task.sessionId = sessionId;
      if (!r.ok || !r.output) {
        task.status = 'failed';
        save('task_failed', { cardId: card.id, taskId: task.id, message: r.error });
        log(`task ${card.id}/${task.id} failed: ${r.error}`);
        return undefined;
      }
      last = r.output;
      if (last.done || !sessionId) break;
      // Progress check: the worker says it is not finished -> resume the same session.
      log(`task ${card.id}/${task.id} not done (${last.remaining.length} items left), continuing…`);
      prompt = P.workerContinuePrompt(task, last);
    }
    task.result = last;
    task.status = last?.done ? 'done' : 'failed';
    save(task.status === 'done' ? 'task_done' : 'task_failed', { cardId: card.id, taskId: task.id, message: last?.summary });
    if (task.status === 'done' && last) {
      const added = memory.add(last.learnings.map((text) => ({
        text, runId: board.runId, cardId: card.id, harness: roleConfig(config, 'worker').harness,
        files: [...last.filesChanged, ...extractPaths(text, cwd)],
      })));
      if (added.length) save('learnings', { cardId: card.id, taskId: task.id, data: added.map((l) => l.id) });
    }
    return task.status === 'done' ? last : undefined;
  }

  // ---- one card: worktree -> tasks -> commit -> check -> merge ----
  async function runCard(card: Card): Promise<void> {
    const cwd = store.worktreeDir(repoRoot, board.runId, card.id);
    card.branch = `usta-wip/${board.runId}/${card.id}`;
    card.status = 'in_progress';
    if (!existsSync(join(cwd, '.git'))) git.createWorktree(repoRoot, cwd, card.branch, board.runBranch);
    save('card_started', { cardId: card.id });
    log(`card ${card.id} started (${card.tasks.length} task${card.tasks.length === 1 ? '' : 's'})`);

    while (true) {
      if (ctrl.signal.aborted) return;
      // Tasks run sequentially in the card's worktree.
      let failed = false;
      for (const task of card.tasks) {
        if (task.status === 'done') continue;
        const res = await runTask(card, task, cwd);
        if (!res) { failed = true; break; }
      }
      if (ctrl.signal.aborted) return;
      if (failed) return finishCard(card, cwd, 'failed', ['a task failed; see logs']);

      card.status = 'review';
      git.commitAll(cwd, `usta: ${card.id} ${card.title}`);
      save('card_review', { cardId: card.id });
      const diffText = git.diff(cwd, board.runBranch);
      const check = await agent<CheckResult>('checker', {
        prompt: P.checkerPrompt(board, card, diffText, context({ files: cardFiles(card, cwd), root: cwd })),
        systemPrompt: P.checkerSystem(config.checker.allowedCommands), cwd, schema: CHECK_SCHEMA, access: 'readonly',
        allowedCommands: config.checker.allowedCommands,
      }, { cardId: card.id, logName: `${card.id}.check.${card.attempts + 1}` });
      addCost(card, check.costUsd);
      if (ctrl.signal.aborted) return;

      const verdict: CheckResult = check.ok && check.output ? check.output : { pass: false, feedback: [`checker failed to run: ${check.error}`], summary: '' };
      let fix: { title: string; feedback: string[] };
      if (verdict.pass) {
        const merged = git.mergeBack(cwd, board.runBranch, card.branch, { keepConflicts: true });
        if (merged.ok) {
          card.summary = card.tasks.map((t) => t.result?.summary).filter(Boolean).join(' ');
          return finishCard(card, cwd, 'done');
        }
        fix = {
          title: 'Resolve merge conflicts',
          feedback: [`Merging the result branch (other cards' work) into this card produced conflicts in: ${merged.conflicts?.join(', ')}. The files now contain conflict markers (<<<<<<< / >>>>>>>). Resolve them keeping the intent of both sides, remove the markers, and make sure everything still works.`],
        };
      } else {
        fix = {
          title: 'Address review feedback',
          feedback: verdict.feedback.length ? verdict.feedback : [verdict.summary || 'checker rejected the card without details'],
        };
      }

      card.feedback.push(...fix.feedback);
      card.attempts++;
      if (card.attempts >= config.maxAttempts) return finishCard(card, cwd, 'failed');
      log(`card ${card.id} rejected (attempt ${card.attempts}/${config.maxAttempts}): ${card.feedback.at(-1)}`);
      // Retry: keep the worktree and the finished tasks; append one fix task that addresses the feedback.
      card.tasks.push(fixTask(card, fix.title, fix.feedback));
      card.status = 'in_progress';
      save('card_retry', { cardId: card.id, message: card.feedback.at(-1) });
    }
  }

  function fixTask(card: Card, title: string, feedback: string[]): Task {
    const n = card.tasks.filter((t) => t.kind === 'fix').length + 1;
    return {
      id: `fix${n}`, cardId: card.id, kind: 'fix', title, feedback,
      instructions: feedback.join('\n'), status: 'pending', attempts: 0,
    };
  }

  function finishCard(card: Card, cwd: string, status: 'done' | 'failed', feedback: string[] = []): void {
    card.status = status;
    card.feedback.push(...feedback);
    if (status === 'done') {
      git.removeWorktree(repoRoot, cwd, card.branch);
      log(`card ${card.id} done → merged into ${board.runBranch}`);
    } else {
      markFailed(registry, card.id);
      log(`card ${card.id} FAILED: ${card.feedback.at(-1) ?? ''} (worktree kept at ${cwd})`);
    }
    save(`card_${status}`, { cardId: card.id });
  }

  // ---- docs ----
  async function runDocs(): Promise<void> {
    if (!config.docs) { board.docs = { status: 'skipped' }; save('docs_skipped'); return; }
    if (!board.cards.some((c) => c.status === 'done')) { board.docs = { status: 'skipped', summary: 'nothing merged' }; save('docs_skipped'); return; }
    const cwd = store.worktreeDir(repoRoot, board.runId, 'docs');
    const branch = `usta-wip/${board.runId}/docs`;
    board.docs = { status: 'running' };
    save('docs_started');
    log('documentation agent started');
    git.createWorktree(repoRoot, cwd, branch, board.runBranch);
    const stat = git.diffStat(cwd, board.baseRef);
    const r = await agent<DocsResult>('docs', {
      prompt: P.docsPrompt(board, stat, context({ root: cwd })), systemPrompt: P.docsSystem(), cwd, schema: DOCS_SCHEMA, access: 'write',
    }, { cardId: 'docs', logName: 'docs' });
    addCost(undefined, r.costUsd);
    if (r.ok && r.output) {
      git.commitAll(cwd, 'usta: update documentation');
      const merged = git.mergeBack(cwd, board.runBranch, branch);
      board.docs = merged.ok ? { status: 'done', summary: r.output.summary } : { status: 'failed', summary: `merge conflict: ${merged.conflicts?.join(', ')}` };
    } else {
      board.docs = { status: 'failed', summary: r.error };
      markFailed(registry, 'docs');
    }
    if (board.docs.status === 'done') git.removeWorktree(repoRoot, cwd, branch);
    save(`docs_${board.docs.status}`);
    log(`documentation ${board.docs.status}${board.docs.summary ? `: ${board.docs.summary}` : ''}`);
  }

  // ---- main loop ----
  async function execute(): Promise<void> {
    if (board.cards.length === 0) throw new Error('board has no cards; run plan() first');
    mkdirSync(join(worktreesDir(repoRoot), board.runId), { recursive: true });
    const inFlight = new Map<string, Promise<void>>();

    while (!allTerminal(board) && !ctrl.signal.aborted) {
      for (const c of blockUnreachable(board)) log(`card ${c.id} blocked: ${c.feedback.at(-1)}`);
      for (const card of readyCards(board, config.concurrency)) {
        inFlight.set(card.id, runCard(card).catch((err) => {
          card.status = 'failed';
          card.feedback.push(`internal error: ${(err as Error).message}`);
          log(`card ${card.id} crashed: ${(err as Error).message}`);
        }).finally(() => inFlight.delete(card.id)));
      }
      if (inFlight.size === 0) {
        if (allTerminal(board)) break;
        if (blockUnreachable(board).length === 0) throw new Error('scheduler stuck: no runnable cards and nothing in flight');
        continue;
      }
      save('tick');
      await Promise.race(inFlight.values());
    }
    await Promise.all(inFlight.values());
    if (ctrl.signal.aborted) { save('aborted'); return; }
    await runDocs();
    try { rmdirSync(join(worktreesDir(repoRoot), board.runId)); } catch { /* not empty: failed worktrees are kept */ }
    save('finished');
  }

  return {
    board, registry, plan, execute,
    abort() { ctrl.abort(); },
  };
}
