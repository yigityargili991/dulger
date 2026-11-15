// Runs as data: summaries (an unreadable board included), changed files, merge readiness and the merge,
// failed cards, cleanup, and starting work from a session without the prompt's merge offer.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { createFakeAdapter, DEFAULT_FAKE_SCRIPT } from '../src/adapters/fake.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import { cardCounts, cleanLeftovers, cleanLeftoversReport, changedFiles, failedCards, fileDiff, latestRun, mergeBlockers, mergeRunBranch, recoverableRuns, runsByStart, runState, runStatus, runSummaries } from '../src/runs.ts';
import { keptWorktrees, leftovers } from '../src/app/pages/runs.data.ts';
import { acquireRunLock } from '../src/board/lock.ts';
import { clean, mergeRun, showRuns } from '../src/commands.ts';
import { runGoal, runOrder, runResume, runRetry } from '../src/sessionRuns.ts';
import { worktreesDir } from '../src/paths.ts';
import { CliError } from '../src/errors.ts';
import type { Session } from '../src/repl.ts';
import type { Board, PlannerResult } from '../src/types.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-runs-data-'));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-runs-home-'));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dulger-runs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

/** Put a commit on the run's branch, as a landed card would. */
function landOnRunBranch(root: string, board: Board, file: string, text: string): string {
  const wt = join(root, '..', `${board.runId}-wt-${Math.random().toString(36).slice(2)}`);
  git.git(root, ['worktree', 'add', '-q', wt, board.runBranch]);
  writeFileSync(join(wt, file), text);
  git.git(wt, ['add', '.']); git.git(wt, ['commit', '-qm', `add ${file}`]);
  const ref = git.git(wt, ['rev-parse', 'HEAD']);
  git.git(root, ['worktree', 'remove', '--force', wt]);
  return ref;
}

test('run summaries list every run, and an unreadable board as data instead of a throw', (t) => {
  const root = fixture(t);
  assert.deepEqual(runSummaries(root), []);
  const a = createBoard(root, 'first goal', 'run-a');
  a.cards = store.cardsFromPlan(plan());
  a.cards[0]!.status = 'done'; a.costUsd = 1.5; a.docs = { status: 'skipped' };
  store.saveBoard(root, a);
  createBoard(root, 'second goal', 'run-b');
  writeFileSync(store.boardPath(root, 'run-b'), '{ not json');
  const all = runSummaries(root);
  // By start time, oldest first; a board that cannot be read and has no date in its id is the oldest.
  assert.deepEqual(all.map((r) => r.id), ['run-b', 'run-a']);
  const first = all.find((r) => r.id === 'run-a');
  const second = all.find((r) => r.id === 'run-b');
  assert.deepEqual(first, {
    id: 'run-a', readable: true, status: 'finished', goal: 'first goal', createdAt: a.createdAt,
    cards: { done: 1, failed: 0, total: 1, replaced: 0 }, costUsd: 1.5, spend: '$1.50', branch: 'dulger/run-a',
  });
  assert.equal(second!.id, 'run-b');
  assert.equal(second!.readable, false);
  assert.ok(!second!.readable && /JSON/.test(second!.error), 'the reason, readable');
  assert.deepEqual(recoverableRuns(root), []);

  const out: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => out.push(args.join(' ')));
  showRuns(root);
  assert.equal(out.length, 2, 'the list goes on past the broken run');
  // Oldest first by start time, the undated broken board first.
  assert.match(out[0]!, /^run-b {2}.*unreadable board/);
  assert.match(out[1]!, /^run-a {2}1\/1 done {2}\$1\.50 {2}.*first goal/);
});

test('merge readiness is data, and the merge says what it did', (t) => {
  const root = fixture(t);
  const b = createBoard(root, 'merge me', 'merge');
  const ref = landOnRunBranch(root, b, 'feature.txt', 'new\n');
  b.settings = { version: 1, config: {} as never };
  store.saveBoard(root, b);
  assert.deepEqual(mergeBlockers(root, b).map((x) => x.code), ['unverified']);

  b.finalVerification = { ref, results: [{ command: 'true', ok: true, exitCode: 0, durationMs: 1, output: '' }] };
  b.docs = { status: 'failed' };
  writeFileSync(join(root, 'README.md'), 'dirty\n');
  assert.deepEqual(mergeBlockers(root, b).map((x) => x.code), ['docs-unfinished', 'dirty-tree']);
  git.git(root, ['checkout', '--', 'README.md']);

  b.docs = { status: 'done' };
  b.finalVerification = { ref: 'stale', results: [] };
  assert.deepEqual(mergeBlockers(root, b), [{ code: 'verification-failed', message: 'Final verification failed or is stale. Resume the run to verify its current result before merging.' }]);

  b.finalVerification = { ref, results: [] };
  store.saveBoard(root, b);
  assert.deepEqual(mergeBlockers(root, b), []);
  assert.deepEqual(changedFiles(root, b), ['feature.txt']);
  assert.match(fileDiff(root, b, 'feature.txt'), /^\+new$/m);
  assert.deepEqual(mergeRunBranch(root, 'merge'), { runId: 'merge', branch: 'dulger/merge', into: 'main' });
  assert.equal(readFileSync(join(root, 'feature.txt'), 'utf8'), 'new\n');

  git.deleteBranch(root, b.runBranch);
  assert.deepEqual(mergeBlockers(root, b).map((x) => x.code), ['branch-missing'], 'a deleted branch is a reason, not a git error');
  assert.throws(() => changedFiles(root, b), (e: unknown) => e instanceof CliError && e.message === 'dulger/merge no longer exists');
  assert.throws(() => mergeRun(root, 'merge'), { message: 'dulger/merge no longer exists' });
  assert.throws(() => mergeRunBranch(root, 'nope'), { message: 'no run nope' });
});

test('failed cards carry why they failed, and cleanup returns the lines it prints', (t) => {
  const root = fixture(t);
  const b = createBoard(root, 'failures', 'fails');
  b.cards = store.cardsFromPlan(plan());
  b.cards.push({ ...b.cards[0]!, id: 'c2', title: 'Two' });
  b.cards[0]!.status = 'failed'; b.cards[0]!.reason = 'over budget';
  b.cards[1]!.status = 'failed'; b.cards[1]!.feedback = ['first', 'last word'];
  assert.deepEqual(failedCards(b), [{ id: 'c1', title: 'One', reason: 'over budget' }, { id: 'c2', title: 'Two', reason: 'last word' }]);

  git.createBranch(root, 'dulger-wip/fails/c1', 'HEAD');
  mkdirSync(join(worktreesDir(root), 'fails'), { recursive: true });
  const lines = cleanLeftovers(root);
  assert.ok(lines.includes(`removed ${worktreesDir(root)}`), lines.join('\n'));
  assert.ok(lines.includes('deleted branch dulger-wip/fails/c1'));
  assert.equal(git.branchExists(root, 'dulger-wip/fails/c1'), false);
  assert.ok(!existsSync(worktreesDir(root)));
  const out: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => out.push(args.join(' ')));
  clean(root);
  assert.deepEqual(out, [], 'nothing left to remove');
});

const plan = (): PlannerResult => ({ cards: [{ id: 'c1', title: 'One', description: 'Implement one thing', acceptanceCriteria: ['done'], dependsOn: [], verify: [], tasks: [{ id: 't1', title: 'Implement', instructions: 'Write something' }] }] });

test('starting work from a session returns the run and its outcome, and merges nothing', async (t) => {
  const root = fixture(t);
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: plan(), checker: () => ({ pass: true, feedback: [], summary: 'ok' }), delayMs: 1 }));
  t.mock.method(console, 'log', () => {});
  const session: Session = { overrides: { harness: 'fake', docs: false, progressIntervalSec: 0, concurrency: 1, maxReplans: 0 }, yes: true, quiet: true, allowDirty: false };

  const goal = await runGoal(root, session, 'make a thing');
  assert.equal(goal.landed, 1);
  assert.equal(goal.aborted, false);
  assert.equal(goal.runBranch, `dulger/${goal.runId}`);
  assert.equal(store.loadBoard(root, goal.runId).goal, 'make a thing');
  assert.equal(git.currentBranch(root), 'main');
  assert.equal(git.git(root, ['rev-list', '--count', 'main']), '1', 'the result stays on its branch');

  const ordered = await runOrder(root, session, 'order a thing');
  assert.notEqual(ordered.runId, goal.runId);
  assert.equal(ordered.landed, 1);

  const resumed = await runResume(root, session, goal.runId);
  assert.equal(resumed.runId, goal.runId);
  assert.equal(resumed.runBranch, goal.runBranch);
  // "The latest run" is the most recently started (the order run), not the last id in string order: two
  // runs started in the same minute differ only in a random suffix.
  assert.equal((await runResume(root, session)).runId, ordered.runId, 'the most recently started run when none is named');

  await assert.rejects(runRetry(root, session, ''), { message: 'dulger retry needs a card id, e.g. dulger retry c7' });
  await assert.rejects(runRetry(root, session, 'c1', 'nope'), { message: 'no run nope' });
  await assert.rejects(runRetry(root, session, 'c1', goal.runId), /not failed/);

  writeFileSync(join(root, 'README.md'), 'dirty\n');
  await assert.rejects(runGoal(root, session, 'x'), { message: 'working tree has uncommitted changes (commit them, or /dirty on)' });
  await assert.rejects(runOrder(root, session, 'x'), /uncommitted changes/);
});

test('a board whose refs or runId could be a git option, a mismatch, or a path is refused, not run', (t) => {
  const root = fixture(t);
  // A ref that starts with "-" would become a git option when a diff or merge runs.
  const b1 = createBoard(root, 'Dashed ref', 'r1');
  b1.baseRef = '--output=/tmp/x';
  store.saveBoard(root, b1);
  assert.throws(() => store.loadBoard(root, 'r1'), /baseRef must not start with "-"/);
  const s1 = runSummaries(root).find((r) => r.id === 'r1');
  assert.equal(s1?.readable, false, 'listed as unreadable, never run');

  // A board.json whose runId does not match its directory cannot stand in for another run.
  const b2 = createBoard(root, 'Mismatch', 'r2');
  b2.runId = 'r9';
  writeFileSync(store.boardPath(root, 'r2'), JSON.stringify(b2));
  assert.throws(() => store.loadBoard(root, 'r2'), /they must match/);

  // A run id that is a path is refused at the source, in the store and in the lock.
  assert.throws(() => store.runDir(root, '../evil'), /plain name/);
  assert.throws(() => store.loadBoard(root, 'a/b'), /plain name/);
  assert.throws(() => acquireRunLock(root, '..'), /plain name/);
});

/** Two cards, for the counting and status tests. */
const twoCards = (): PlannerResult => ({ cards: ['c1', 'c2'].map((id) => ({ ...plan().cards[0]!, id })) });

/** Hold a run's execution lock as a live dulger process would (the test runner's parent is alive). */
function holdLock(root: string, runId: string): void {
  const lock = join(store.runDir(root, runId), 'execution.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'x' }));
}

test('a paused run is paused only while a dulger process holds it; killed, it is interrupted', (t) => {
  const root = fixture(t);
  const b = createBoard(root, 'paused one', 'p1');
  b.cards = store.cardsFromPlan(twoCards());
  b.paused = true;
  store.saveBoard(root, b);
  assert.equal(runStatus(b), 'paused', 'the board says paused');
  assert.equal(runState(root, b), 'in progress / interrupted', 'nobody holds it: its process is gone');
  holdLock(root, 'p1');
  assert.equal(runState(root, b), 'paused', 'a live process holds it: it is paused');
  const [summary] = runSummaries(root);
  assert.ok(summary!.readable && summary!.status === 'paused');
});

test('"the latest run" is the most recently started, whatever the ids say; Runs order follows start times', (t) => {
  const root = fixture(t);
  // Ids in one order, start times in the other (two runs in one minute differ only in a random suffix).
  const later = createBoard(root, 'started second', '20261115-0300-0000');
  const earlier = createBoard(root, 'started first', '20261115-0300-ffff');
  later.createdAt = '2026-11-15T03:00:30.000Z';
  earlier.createdAt = '2026-11-15T03:00:10.000Z';
  store.saveBoard(root, later);
  store.saveBoard(root, earlier);
  assert.deepEqual(runsByStart(root), ['20261115-0300-ffff', '20261115-0300-0000']);
  assert.equal(latestRun(root), '20261115-0300-0000', 'the one started last, not the last id');
  assert.deepEqual(runSummaries(root).map((r) => r.id), ['20261115-0300-ffff', '20261115-0300-0000']);
});

test('cards a replan replaced are not counted in the total, and are counted apart', (t) => {
  const root = fixture(t);
  const b = createBoard(root, 'replanned', 'rp');
  b.cards = store.cardsFromPlan(twoCards());
  b.cards[0]!.status = 'done';
  b.cards[1]!.status = 'replaced';
  store.saveBoard(root, b);
  assert.deepEqual(cardCounts(b.cards), { done: 1, failed: 0, total: 1, replaced: 1 });
  const s = runSummaries(root)[0]!;
  assert.ok(s.readable && s.cards.total === 1 && s.cards.replaced === 1);
});

test('Clean leaves a run another process holds alone and cleans the rest; afterwards no worktree is said to be kept', (t) => {
  const root = fixture(t);
  const busy = createBoard(root, 'in use', 'busy');
  const free = createBoard(root, 'idle', 'free');
  free.cards = store.cardsFromPlan(twoCards());
  free.cards[0]!.status = 'failed';
  store.saveBoard(root, free);
  holdLock(root, 'busy');
  for (const id of ['busy', 'free']) {
    git.createBranch(root, `dulger-wip/${id}/c1`, 'HEAD');
    mkdirSync(join(worktreesDir(root), id, 'c1'), { recursive: true });
  }
  assert.ok(keptWorktrees(root, free), 'the failed card keeps its worktree for a retry');
  const found = leftovers(root);
  assert.deepEqual(found.busy.map((x) => x.id), ['busy'], 'the run in use is named');
  assert.deepEqual(found.branches, ['dulger-wip/free/c1'], 'and left out of what goes');
  assert.deepEqual(found.retries, ['free'], 'the retry worktrees that go are said');

  const { removed, skipped } = cleanLeftoversReport(root);
  assert.deepEqual(skipped.map((x) => x.id), ['busy']);
  assert.match(skipped[0]!.reason, /in use by another dulger process \(pid \d+\)/);
  assert.ok(removed.some((l) => l === 'deleted branch dulger-wip/free/c1'));
  assert.equal(git.branchExists(root, 'dulger-wip/busy/c1'), true, 'the busy run keeps its branch');
  assert.equal(existsSync(join(worktreesDir(root), 'busy', 'c1')), true, 'and its worktree');
  assert.equal(existsSync(join(worktreesDir(root), 'free')), false);
  assert.equal(keptWorktrees(root, store.loadBoard(root, 'free')), undefined, 'nothing is claimed to be kept once it is gone');
  assert.ok(busy);
});
