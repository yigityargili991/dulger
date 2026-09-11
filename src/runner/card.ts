// One card's life: worktree -> tasks (sequential, with continuations and retries) -> commit -> sync
// with the result branch -> check -> land. Review rejections and merge conflicts append fix tasks; the
// card fails after maxAttempts rejections or when a task is out of tries.
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
import { runVerification, verificationFeedback, verificationSummary } from './verify.ts';
import type { Card, CheckResult, Task, WorkerResult } from '../types.ts';

const CONFLICT_FEEDBACK = (files: string) =>
  `Merging the result branch (other cards' work) into this card produced conflicts in: ${files}. The files now contain conflict markers (<<<<<<< / >>>>>>>). Resolve them keeping the intent of both sides, remove the markers, and make sure everything still works.`;

/**
 * A card's state machine. Every loop runs the pending tasks, then reviews and lands under the merge
 * queue; a rejection or a merge conflict appends a fix task and loops again. Exits: landed, failed, or
 * aborted (the board stays resumable).
 */
export async function runCard(rt: Runtime, card: Card): Promise<void> {
  const cwd = prepareWorktree(rt, card);
  let conflicts = 0;
  let checkFailures = 0;
  while (!rt.signal.aborted) {
    const tasks = await runPendingTasks(rt, card, cwd);
    if (tasks !== 'done') {
      if (rt.signal.aborted) return;
      return finishCard(rt, card, cwd, 'failed', [tasks.reason], tasks.failure);
    }
    const outcome = await reviewAndLand(rt, card, cwd);
    switch (outcome.kind) {
      case 'aborted':
        return;
      case 'landed':
        return landed(rt, card, cwd, outcome.verdict);
      case 'rejected':
        if (!rejected(rt, card, outcome.verdict)) return finishCard(rt, card, cwd, 'failed');
        break;
      case 'check_failed':
        // Not the card's fault: no round spent, no fix task. One retry, then resume takes it.
        if (++checkFailures > 1) return finishCard(rt, card, cwd, 'failed', [`reviewer could not run: ${outcome.error}`], 'infrastructure');
        rt.log(`card ${card.id}: reviewer could not run (${outcome.error}); trying the review again`);
        rt.save('card_check_failed', { cardId: card.id, message: outcome.error });
        break;
      case 'conflict':
        // Each round means the result branch moved, so the number of rounds is bounded by the number of cards.
        if (++conflicts > rt.board.cards.length) return finishCard(rt, card, cwd, 'failed', [`merge conflicts could not be resolved in ${outcome.files}`]);
        conflicted(rt, card, outcome.files);
        break;
    }
  }
}

type Outcome =
  | { kind: 'landed'; verdict: CheckResult }
  | { kind: 'aborted' }
  | { kind: 'rejected'; verdict: CheckResult }
  | { kind: 'check_failed'; error: string }
  | { kind: 'conflict'; files: string };

/** The card's worktree on its wip branch, reused when resuming. */
function prepareWorktree(rt: Runtime, card: Card): string {
  const cwd = store.worktreeDir(rt.repoRoot, rt.board.runId, card.id);
  card.branch = `dulger-wip/${rt.board.runId}/${card.id}`;
  card.status = 'in_progress';
  if (!existsSync(join(cwd, '.git'))) {
    git.createWorktree(rt.repoRoot, cwd, card.branch, rt.board.runBranch);
    rt.setupWorktree(cwd);
  }
  rt.save('card_started', { cardId: card.id });
  rt.log(`card ${card.id} started (${card.tasks.length} task${card.tasks.length === 1 ? '' : 's'})`);
  return cwd;
}

type TasksOutcome = 'done' | { failure: 'work' | 'infrastructure'; reason: string };

/**
 * Tasks run one after another in the worktree. A task that fails (agent crashed, stalled, or answered
 * badly) is tried again in a fresh session up to maxAttempts times. An agent that never answered is
 * dulger's failure; a worker that answered but could not finish is the card's.
 */
async function runPendingTasks(rt: Runtime, card: Card, cwd: string): Promise<TasksOutcome> {
  for (const task of card.tasks) {
    while (task.status !== 'done') {
      const r = await runTask(rt, card, task, cwd);
      if (rt.signal.aborted) return { failure: 'infrastructure', reason: 'aborted' };
      if (r.result) break;
      if (task.attempts >= rt.config.maxAttempts) {
        return r.error
          ? { failure: 'infrastructure', reason: `task ${task.id} could not run: ${r.error}` }
          : { failure: 'work', reason: `task ${task.id} was not finished after ${task.attempts} tries; see logs` };
      }
      rt.log(`task ${card.id}/${task.id} failed; trying again (${task.attempts + 1}/${rt.config.maxAttempts})`);
      rt.save('task_retry', { cardId: card.id, taskId: task.id });
    }
  }
  return 'done';
}

/** Commit, then under the merge queue: sync with the result branch, review the integrated state, land. */
async function reviewAndLand(rt: Runtime, card: Card, cwd: string): Promise<Outcome> {
  const { board, signal } = rt;
  card.status = 'review';
  git.commitAll(cwd, `dulger: ${card.id} ${card.title}`);
  rt.save('card_review', { cardId: card.id });
  if (rt.integrating()) rt.log(`card ${card.id} waiting for the merge queue`);
  return rt.integrate(async () => {
    const merged = git.mergeFrom(cwd, board.runBranch, { keepConflicts: true });
    if (!merged.ok) return { kind: 'conflict', files: merged.conflicts?.join(', ') ?? '' };
    if (!verify(rt, card, cwd)) return { kind: 'rejected', verdict: { pass: false, feedback: verificationFeedback(card.verification ?? []), summary: '' } };
    if (signal.aborted) return { kind: 'aborted' };
    const checked = await check(rt, card, cwd);
    if (signal.aborted) return { kind: 'aborted' };
    if (!checked.verdict) return { kind: 'check_failed', error: checked.error };
    const { verdict } = checked;
    if (!verdict.pass) return { kind: 'rejected', verdict };
    if (!git.land(cwd, board.runBranch)) throw new Error(`result branch ${board.runBranch} moved while ${card.id} held the merge queue`);
    return { kind: 'landed', verdict };
  });
}

function landed(rt: Runtime, card: Card, cwd: string, verdict: CheckResult): void {
  recordReview(card, verdict);
  card.summary = card.tasks.map((t) => t.result?.summary).filter(Boolean).join(' ');
  finishCard(rt, card, cwd, 'done');
}

/** A review round is spent. True when the card gets another round via a fix task, false when it is out of rounds. */
function rejected(rt: Runtime, card: Card, verdict: CheckResult): boolean {
  recordReview(card, verdict);
  const feedback = verdict.feedback.length ? verdict.feedback : [verdict.summary || 'checker rejected the card without details'];
  card.feedback.push(...feedback);
  card.attempts++;
  if (card.attempts >= rt.config.maxAttempts) return false;
  rt.log(`card ${card.id} rejected (attempt ${card.attempts}/${rt.config.maxAttempts}): ${feedback.at(-1)}`);
  appendFixTask(card, 'Address review feedback', feedback);
  rt.save('card_retry', { cardId: card.id, message: feedback.at(-1) });
  return true;
}

/** Another card's landed work conflicts with this one: not a review failure, so no round is spent. */
function conflicted(rt: Runtime, card: Card, files: string): void {
  rt.log(`card ${card.id} conflicts with merged work in ${files}; resolving`);
  appendFixTask(card, 'Resolve merge conflicts', [CONFLICT_FEEDBACK(files)]);
  rt.save('card_conflict', { cardId: card.id, message: files });
}

/** One worker task, resuming the same session while the worker reports done=false (up to maxContinuations). */
async function runTask(rt: Runtime, card: Card, task: Task, cwd: string): Promise<{ result?: WorkerResult; error?: string }> {
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
    rt.addCost(card, r.costUsd, r.usage);
    sessionId = r.sessionId;
    task.sessionId = sessionId;
    if (!r.ok || !r.output) {
      task.status = 'failed';
      save('task_failed', { cardId: card.id, taskId: task.id, message: r.error });
      log(`task ${card.id}/${task.id} failed: ${r.error}`);
      return { error: r.error ?? 'no answer' };
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
  return task.status === 'done' ? { result: last } : {};
}

/**
 * The verification gate: run the card's verify commands in its worktree. False when one fails; the card
 * then goes back to work with the output, without a reviewer looking at it first.
 */
function verify(rt: Runtime, card: Card, cwd: string): boolean {
  if (!card.verify.length) { card.verification = undefined; return true; }
  rt.log(`card ${card.id} verifying: ${card.verify.join(', ')}`);
  card.verification = runVerification(cwd, card.verify, { timeoutSec: rt.config.verifyTimeoutSec, signal: rt.signal });
  const failed = card.verification.filter((r) => !r.ok);
  if (!failed.length) return true;
  rt.log(`card ${card.id} verification failed: ${verificationSummary(failed)}`);
  rt.save('card_verify_failed', { cardId: card.id, message: verificationSummary(failed) });
  return false;
}

/** Review the card's diff on top of the synced result branch; no verdict when the checker could not run. */
async function check(rt: Runtime, card: Card, cwd: string): Promise<{ verdict: CheckResult; error?: undefined } | { verdict?: undefined; error: string }> {
  const { board, config } = rt;
  const diff = git.reviewDiff(cwd, board.runBranch);
  if (!diff.text) rt.log(`card ${card.id}: diff is ${Math.round(diff.chars / 1024)} KB over ${diff.files.length} files; the reviewer reads it file by file`);
  const allowedCommands = [...new Set([...config.checker.allowedCommands, ...card.verify])];
  const r = await rt.agent<CheckResult>('checker', {
    prompt: P.checkerPrompt(board, card, diff, rt.context({ files: cardFiles(card, cwd), root: cwd })),
    systemPrompt: P.checkerSystem(allowedCommands), cwd, schema: CHECK_SCHEMA, access: 'readonly',
    allowedCommands,
  }, { cardId: card.id, logName: `${card.id}.check.${card.attempts + 1}` });
  rt.addCost(card, r.costUsd, r.usage);
  // A reviewer that could not run something worked from trust instead of evidence; that belongs on the board.
  if (r.denied?.length) card.reviewNotes = [...(card.reviewNotes ?? []), `reviewer was denied: ${r.denied.join('; ')}`];
  return r.ok && r.output ? { verdict: r.output } : { error: r.error ?? 'no verdict returned' };
}

/** Keep the reviewer's verdict on the card: the latest summary, and every non-blocking note (shown on the board, never sent back as work). */
function recordReview(card: Card, verdict: CheckResult): void {
  if (verdict.summary) card.review = verdict.summary;
  if (verdict.notes?.length) card.reviewNotes = [...(card.reviewNotes ?? []), ...verdict.notes];
}

/** Put the card back to work with one fix task that carries `feedback`; finished tasks stay finished. */
function appendFixTask(card: Card, title: string, feedback: string[]): void {
  const n = card.tasks.filter((t) => t.kind === 'fix').length + 1;
  card.tasks.push({
    id: `fix${n}`, cardId: card.id, kind: 'fix', title, feedback,
    instructions: feedback.join('\n'), status: 'pending', attempts: 0,
  });
  card.status = 'in_progress';
}

function finishCard(rt: Runtime, card: Card, cwd: string, status: 'done' | 'failed', feedback: string[] = [], failure: 'work' | 'infrastructure' = 'work'): void {
  card.status = status;
  card.feedback.push(...feedback);
  card.failure = status === 'failed' ? failure : undefined;
  if (status === 'done') {
    git.removeWorktree(rt.repoRoot, cwd, card.branch);
    rt.log(`card ${card.id} done → merged into ${rt.board.runBranch}`);
  } else {
    markFailed(rt.registry, card.id);
    rt.log(`card ${card.id} FAILED: ${card.feedback.at(-1) ?? ''} (worktree kept at ${cwd})`);
  }
  rt.save(`card_${status}`, { cardId: card.id });
}
