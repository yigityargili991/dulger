// One card's life: worktree -> tasks (sequential, with continuations) -> commit -> sync with the
// result branch -> check -> land. Review rejections and merge conflicts append fix tasks; the card
// fails after maxAttempts rejections.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { roleConfig } from '../config.ts';
import { cardFiles } from '../context/common.ts';
import { extractPaths } from '../context/memory.ts';
import * as store from '../board/store.ts';
import * as git from '../git/worktree.ts';
import { CHECK_SCHEMA, WORKER_SCHEMA } from '../roles/schemas.ts';
import * as P from '../roles/prompts.ts';
import { markFailed } from './agentProcess.ts';
import type { Runtime } from './runtime.ts';
import type { Card, CheckResult, Task, WorkerResult } from '../types.ts';

const CONFLICT_FEEDBACK = (files: string) =>
  `Merging the result branch (other cards' work) into this card produced conflicts in: ${files}. The files now contain conflict markers (<<<<<<< / >>>>>>>). Resolve them keeping the intent of both sides, remove the markers, and make sure everything still works.`;

export async function runCard(rt: Runtime, card: Card): Promise<void> {
  const { board, config, log, save, signal } = rt;
  const cwd = store.worktreeDir(rt.repoRoot, board.runId, card.id);
  card.branch = `dulger-wip/${board.runId}/${card.id}`;
  card.status = 'in_progress';
  if (!existsSync(join(cwd, '.git'))) git.createWorktree(rt.repoRoot, cwd, card.branch, board.runBranch);
  save('card_started', { cardId: card.id });
  log(`card ${card.id} started (${card.tasks.length} task${card.tasks.length === 1 ? '' : 's'})`);

  let conflicts = 0;
  while (true) {
    if (signal.aborted) return;
    // Tasks run sequentially in the card's worktree.
    let failed = false;
    for (const task of card.tasks) {
      if (task.status === 'done') continue;
      const res = await runTask(rt, card, task, cwd);
      if (!res) { failed = true; break; }
    }
    if (signal.aborted) return;
    if (failed) return finishCard(rt, card, cwd, 'failed', ['a task failed; see logs']);

    card.status = 'review';
    git.commitAll(cwd, `dulger: ${card.id} ${card.title}`);
    save('card_review', { cardId: card.id });
    if (rt.integrating()) log(`card ${card.id} waiting for the merge queue`);
    // Sync, review and land as one unit: the reviewer sees the integrated state, and nothing lands in between.
    const outcome = await rt.integrate(async (): Promise<Outcome> => {
      const merged = git.mergeFrom(cwd, board.runBranch, { keepConflicts: true });
      if (!merged.ok) return { kind: 'conflict', files: merged.conflicts?.join(', ') ?? '' };
      const verdict = await check(rt, card, cwd);
      if (signal.aborted) return { kind: 'aborted' };
      if (!verdict.pass) return { kind: 'rejected', verdict };
      if (!git.land(cwd, board.runBranch)) throw new Error(`result branch ${board.runBranch} moved while ${card.id} held the merge queue`);
      return { kind: 'landed' };
    });

    switch (outcome.kind) {
      case 'aborted':
        return;
      case 'landed':
        card.summary = card.tasks.map((t) => t.result?.summary).filter(Boolean).join(' ');
        return finishCard(rt, card, cwd, 'done');
      case 'rejected': {
        const { verdict } = outcome;
        const feedback = verdict.feedback.length ? verdict.feedback : [verdict.summary || 'checker rejected the card without details'];
        card.feedback.push(...feedback);
        card.attempts++;
        if (card.attempts >= config.maxAttempts) return finishCard(rt, card, cwd, 'failed');
        log(`card ${card.id} rejected (attempt ${card.attempts}/${config.maxAttempts}): ${feedback.at(-1)}`);
        // Retry: keep the worktree and the finished tasks; append one fix task that addresses the feedback.
        retry(card, 'Address review feedback', feedback);
        save('card_retry', { cardId: card.id, message: feedback.at(-1) });
        break;
      }
      case 'conflict': {
        // Another card's work conflicts with this one. That is not a review failure: resolve it with a
        // fix task without spending an attempt. Each round means the result branch moved, so the number
        // of rounds is bounded by the number of cards.
        if (++conflicts > board.cards.length) return finishCard(rt, card, cwd, 'failed', [`merge conflicts could not be resolved in ${outcome.files}`]);
        log(`card ${card.id} conflicts with merged work in ${outcome.files}; resolving`);
        retry(card, 'Resolve merge conflicts', [CONFLICT_FEEDBACK(outcome.files)]);
        save('card_conflict', { cardId: card.id, message: outcome.files });
        break;
      }
    }
  }
}

type Outcome =
  | { kind: 'landed' }
  | { kind: 'aborted' }
  | { kind: 'rejected'; verdict: CheckResult }
  | { kind: 'conflict'; files: string };

/** One worker task, resuming the same session while the worker reports done=false (up to maxContinuations). */
async function runTask(rt: Runtime, card: Card, task: Task, cwd: string): Promise<WorkerResult | undefined> {
  const { board, config, log, save } = rt;
  task.status = 'running';
  task.attempts++;
  save('task_started', { cardId: card.id, taskId: task.id });
  const sys = P.workerSystem();
  const ctx = rt.context({ files: cardFiles(card, cwd), root: cwd });
  let prompt = task.kind === 'fix' ? P.workerFixPrompt(board, card, task, ctx) : P.workerPrompt(board, card, task, ctx);
  let sessionId: string | undefined;
  let last: WorkerResult | undefined;

  for (let cont = 0; cont <= config.maxContinuations; cont++) {
    const r = await rt.agent<WorkerResult>('worker', {
      prompt, systemPrompt: sys, cwd, schema: WORKER_SCHEMA, access: 'write', resumeSessionId: sessionId,
    }, { cardId: card.id, taskId: task.id, logName: `${card.id}.${task.id}.${task.attempts}${cont ? `.cont${cont}` : ''}` });
    rt.addCost(card, r.costUsd);
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
    log(`task ${card.id}/${task.id} not done (${last.remaining.length} items left), continuing…`);
    prompt = P.workerContinuePrompt(task, last);
  }
  task.result = last;
  task.status = last?.done ? 'done' : 'failed';
  save(task.status === 'done' ? 'task_done' : 'task_failed', { cardId: card.id, taskId: task.id, message: last?.summary });
  if (task.status === 'done' && last) {
    const added = rt.memory.add(last.learnings.map((text) => ({
      text, runId: board.runId, cardId: card.id, harness: roleConfig(config, 'worker').harness,
      files: [...last.filesChanged, ...extractPaths(text, cwd)],
    })));
    if (added.length) save('learnings', { cardId: card.id, taskId: task.id, data: added.map((l) => l.id) });
  }
  return task.status === 'done' ? last : undefined;
}

/** Ask the checker to review the card's diff on top of the synced result branch. A checker that fails to run counts as a rejection. */
async function check(rt: Runtime, card: Card, cwd: string): Promise<CheckResult> {
  const { board, config } = rt;
  const diffText = git.diff(cwd, board.runBranch);
  const r = await rt.agent<CheckResult>('checker', {
    prompt: P.checkerPrompt(board, card, diffText, rt.context({ files: cardFiles(card, cwd), root: cwd })),
    systemPrompt: P.checkerSystem(config.checker.allowedCommands), cwd, schema: CHECK_SCHEMA, access: 'readonly',
    allowedCommands: config.checker.allowedCommands,
  }, { cardId: card.id, logName: `${card.id}.check.${card.attempts + 1}` });
  rt.addCost(card, r.costUsd);
  return r.ok && r.output ? r.output : { pass: false, feedback: [`checker failed to run: ${r.error}`], summary: '' };
}

/** Put the card back to work with one fix task that carries `feedback`. */
function retry(card: Card, title: string, feedback: string[]): void {
  const n = card.tasks.filter((t) => t.kind === 'fix').length + 1;
  card.tasks.push({
    id: `fix${n}`, cardId: card.id, kind: 'fix', title, feedback,
    instructions: feedback.join('\n'), status: 'pending', attempts: 0,
  });
  card.status = 'in_progress';
}

function finishCard(rt: Runtime, card: Card, cwd: string, status: 'done' | 'failed', feedback: string[] = []): void {
  card.status = status;
  card.feedback.push(...feedback);
  if (status === 'done') {
    git.removeWorktree(rt.repoRoot, cwd, card.branch);
    rt.log(`card ${card.id} done → merged into ${rt.board.runBranch}`);
  } else {
    markFailed(rt.registry, card.id);
    rt.log(`card ${card.id} FAILED: ${card.feedback.at(-1) ?? ''} (worktree kept at ${cwd})`);
  }
  rt.save(`card_${status}`, { cardId: card.id });
}
