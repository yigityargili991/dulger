import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wt from '../src/git/worktree.ts';
import { REVIEW_DIFF_MAX_CHARS } from '../src/git/worktree.ts';
import { createOrchestrator, planWarnings } from '../src/runner/orchestrator.ts';
import { createBoard } from '../src/board/create.ts';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { createFakeAdapter, DEFAULT_FAKE_SCRIPT, type FakeScript } from '../src/adapters/fake.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import { openMemory } from '../src/context/memory.ts';
import { buildReport } from '../src/ui/report.ts';
import { resetInterrupted, retryCard } from '../src/board/scheduler.ts';
import * as store from '../src/board/store.ts';
import type { PlannerResult } from '../src/types.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-data-'));

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dulger-orch-'));
  wt.git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  wt.git(dir, ['add', '.']);
  wt.git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return dir;
}

const config: Config = { ...DEFAULT_CONFIG, harness: 'fake', concurrency: 2, maxAttempts: 2, stallTimeoutSec: 10 };

test('happy path: parallel cards, retry after checker rejection, dependency, docs', async () => {
  const worker: FakeScript['worker'] = (o, i) => ({ ...DEFAULT_FAKE_SCRIPT.worker!(o, i), learnings: ['Fake learning: outputs live in out/'] });
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, worker, delayMs: 5 }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run1');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, config, { log: (m) => events.push(m) });
  await orch.plan();
  assert.equal(board.cards.length, 3);
  await orch.execute();

  assert.deepEqual(board.cards.map((c) => c.status), ['done', 'done', 'done']);
  // The merge queue: no two checkers ran at the same time.
  const checks = [...orch.registry.statuses.values()].filter((s) => s.role === 'checker').sort((a, b) => a.startedAt - b.startedAt);
  assert.equal(checks.length, 4, 'c1 twice, c2, c3');
  for (let i = 1; i < checks.length; i++) assert.ok(checks[i]!.startedAt >= checks[i - 1]!.endedAt!, `checker ${i} started before ${i - 1} ended`);
  const c1 = board.cards[0]!;
  assert.equal(c1.attempts, 1, 'c1 was rejected once');
  // The rejection appends a fix task instead of rerunning the finished ones.
  assert.deepEqual(c1.tasks.map((t) => [t.id, t.kind, t.status, t.attempts]), [['t1', undefined, 'done', 1], ['fix1', 'fix', 'done', 1]]);
  assert.deepEqual(c1.tasks[1]!.feedback, ['Fake checker: please retry once']);
  assert.equal(c1.tasks[1]!.title, 'Address review feedback');
  assert.deepEqual(c1.reviewNotes, ['Fake note: consider a helper'], 'non-blocking notes are kept on the card, not turned into work');
  assert.match(c1.summary!, /Wrote c1-t1\.txt Wrote c1-fix1\.txt/);
  assert.equal(board.docs?.status, 'done');
  const files = wt.git(repo, ['ls-tree', '-r', '--name-only', 'dulger/run1']).split('\n').sort();
  assert.deepEqual(files, ['DOCS.md', 'README.md', 'out/c1-fix1.txt', 'out/c1-t1.txt', 'out/c2-t1.txt', 'out/c2-t2.txt', 'out/c3-t1.txt']);
  assert.equal(wt.currentBranch(repo), 'main');
  assert.equal(wt.git(repo, ['branch', '--list', 'dulger-wip/*']), '', 'wip branches cleaned up');
  assert.ok(!existsSync(store.worktreeDir(repo, 'run1', 'c1')));
  assert.ok(!existsSync(join(repo, '.dulger', 'worktrees')), 'worktrees are not nested in the repo');
  const learnings = openMemory(repo, config.memory).load();
  assert.equal(learnings.length, 1);

  assert.equal(c1.review, 'looks good', 'the final review summary is kept on the card');
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const report = strip(buildReport(board, { diffStat: ' 3 files changed' }));
  const full = strip(buildReport(board, { diffStat: ' 3 files changed', full: true }));
  assert.match(report, /^Run run1  main @ [0-9a-f]{7} → dulger\/run1\nGoal: demo\nLanded 3 of 3 cards, docs updated · spent \$0\.1\d · \d+k tokens \(74% cached, \d+ out\)/);
  assert.deepEqual(board.usage, { input: 2200, cacheRead: 7700, cacheWrite: 550, output: 550 });
  assert.match(report, /Plan windows at the end of the run: 5h 35% · 7d 23%/);
  assert.equal(board.rateLimits?.windows.length, 2, 'the latest reading is kept on the board');
  // Compact: three lines per card, nothing verbose.
  assert.match(report, /\nLanded\n  c1 Create greeting module\n     review: looks good\n     spent: \$0\.0\d · \dk tokens · review rounds: 2 · verified: nothing · 1 note\n  c2 /);
  assert.ok(!report.includes('Wrote c1-t1.txt') && !report.includes('note: Fake note') && !report.includes('files:'));
  assert.match(report, /\nDocumentation\n  Wrote DOCS\.md/);
  assert.match(report, /\nChanges\n  3 files changed/);
  assert.match(report, /\nNext\n  git merge dulger\/run1/);
  assert.match(report, /the reviewer note is worth a follow-up run \(dulger report --full lists them\)/);
  assert.ok(!report.includes('Not landed'));
  // Full: everything, wrapped.
  assert.match(full, /spent: \$0\.0\d · \dk tokens \(74% cached/);
  assert.match(full, /\nLanded\n  c1 .*\n     t1 write module: Wrote c1-t1\.txt/);
  assert.match(full, /files: out\/c1-fix1\.txt, out\/c1-t1\.txt/);
  assert.match(full, /review rounds: 2 \(fix tasks: Address review feedback\)/);
  assert.match(full, /review: looks good/);
  assert.match(full, /note: Fake note: consider a helper/);
  assert.match(full, /the reviewer note above is worth a follow-up run/);
  assert.match(learnings[0]!.text, /Fake learning/);
  assert.equal(learnings[0]!.seen, 5, 'one sighting per task of each landed card, the fix task included');
  assert.ok(learnings[0]!.files.includes('out/c1-t1.txt') && learnings[0]!.files.includes('out/c1-fix1.txt'));
  assert.ok(!existsSync(join(repo, '.dulger', 'memory.jsonl')), 'memory is not stored in the repo');
  assert.ok(events.some((e) => /c1 rejected/.test(e)));
  // c3 must not start before c1 and c2 are done.
  const idx = (re: RegExp) => events.findIndex((e) => re.test(e));
  assert.ok(idx(/card c3 started/) > idx(/card c1 done/) && idx(/card c3 started/) > idx(/card c2 done/));
});

test('learnings are stored when their card lands, never for a card that does not', async () => {
  const repo = tempRepo();
  const memory = openMemory(repo, config.memory);
  const learned = { c1: 'Widgets need frobnication before rendering anything visible', c2: 'Farewell helpers return plain strings without trailing punctuation' } as Record<string, string>;
  const atReview: string[][] = [];
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 1,
    worker: (o, i) => ({ ...DEFAULT_FAKE_SCRIPT.worker!(o, i), learnings: [learned[o.prompt.match(/Card id: (\S+)/)![1]!] ?? 'unused'] }),
    checker: (o) => {
      atReview.push(memory.load().map((l) => l.cardId));
      return /Card under review: c1 /.test(o.prompt) ? { pass: false, feedback: ['never good enough'], summary: '' } : { pass: true, feedback: [], summary: 'ok' };
    },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const board = createBoard(repo, 'demo', 'run-learn');
  const orch = createOrchestrator(repo, board, { ...config, docs: false, maxReplans: 0, concurrency: 1 }, {});
  await orch.plan();
  await orch.execute();

  assert.deepEqual(board.cards.map((c) => c.status), ['failed', 'done', 'blocked']);
  assert.equal(board.cards[0]!.tasks.filter((t) => t.status === 'done').length, 2, 'c1 finished tasks that reported learnings');
  assert.ok(atReview.every((ids) => !ids.includes('c1')), 'nothing is learned from a card while it is under review');
  const learnings = memory.load();
  assert.deepEqual(learnings.map((l) => [l.cardId, l.text, l.seen]), [['c2', learned.c2, 2]], 'only the landed card taught the memory');
  assert.deepEqual(learnings[0]!.files.sort(), ['out/c2-t1.txt', 'out/c2-t2.txt']);
  const log = readFileSync(join(repo, '.dulger', 'runs', 'run-learn', 'events.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"type":"learnings"'));
  assert.equal(log.length, 1);
  assert.match(log[0]!, /"cardId":"c2"/);
});

test('a task whose agent fails is tried again in a fresh session before the card gives up', async () => {
  let c1Calls = 0;
  const worker: FakeScript['worker'] = (o, i) => {
    if (/Card id: c1\b/.test(o.prompt) && ++c1Calls === 1) throw new Error('simulated agent crash');
    return DEFAULT_FAKE_SCRIPT.worker!(o, i);
  };
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, worker, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }), delayMs: 1 }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-retry');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();
  const c1 = board.cards[0]!;
  assert.equal(c1.status, 'done');
  assert.equal(c1.tasks[0]!.attempts, 2, 'one failure, one success');
  assert.equal(c1.attempts, 0, 'a task retry is not a review round');
  assert.ok(events.some((e) => /task c1\/t1 failed; trying again \(2\/2\)/.test(e)));
  const log = readFileSync(join(repo, '.dulger', 'runs', 'run-retry', 'events.jsonl'), 'utf8');
  assert.match(log, /"type":"task_retry"/);

  // Out of tries: the card fails, no fix task, dependents blocked.
  c1Calls = 0;
  const always: FakeScript['worker'] = (o, i) => { if (/Card id: c1\b/.test(o.prompt)) throw new Error('still broken'); return DEFAULT_FAKE_SCRIPT.worker!(o, i); };
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, worker: always, delayMs: 1 }));
  const board2 = createBoard(repo, 'demo', 'run-retry-2');
  const orch2 = createOrchestrator(repo, board2, { ...config, docs: false, maxReplans: 0 }, {});
  await orch2.plan();
  await orch2.execute();
  assert.equal(board2.cards[0]!.status, 'failed');
  assert.equal(board2.cards[0]!.tasks[0]!.attempts, 2);
  assert.deepEqual(board2.cards[0]!.tasks.map((t) => t.id), ['t1']);
  assert.equal(board2.cards[2]!.status, 'blocked');
});

test('a card that keeps failing blocks its dependents; docs still run for merged work', async () => {
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 5,
    checker: (opts) => (/Card under review: c1 /.test(opts.prompt) ? { pass: false, feedback: ['never good enough'], summary: '' } : { pass: true, feedback: [], summary: 'ok' }),
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run2');
  const orch = createOrchestrator(repo, board, { ...config, maxReplans: 0 }, {});
  await orch.plan();
  await orch.execute();

  const byId = Object.fromEntries(board.cards.map((c) => [c.id, c]));
  assert.equal(byId.c1!.status, 'failed');
  assert.equal(byId.c1!.attempts, 2);
  assert.deepEqual(byId.c1!.tasks.map((t) => [t.id, t.status]), [['t1', 'done'], ['fix1', 'done'], ['fix2', 'pending']], 'the final rejection stays on the card as a pending fix task');
  assert.equal(byId.c1!.failure, 'work');
  assert.deepEqual(byId.c1!.feedback, ['never good enough', 'never good enough']);
  assert.equal(byId.c2!.status, 'done');
  assert.equal(byId.c3!.status, 'blocked');
  assert.match(byId.c3!.reason!, /dependency c1/);
  const kept = store.worktreeDir(repo, 'run2', 'c1');
  assert.ok(existsSync(kept) && !kept.startsWith(repo), 'failed worktree is kept for inspection, outside the repo');
  assert.equal(board.docs?.status, 'done');
  const files = wt.git(repo, ['ls-tree', '-r', '--name-only', 'dulger/run2']).split('\n').sort();
  assert.deepEqual(files, ['DOCS.md', 'README.md', 'out/c2-t1.txt', 'out/c2-t2.txt']);
  assert.match(buildReport(board, {}), /dulger retry c1 run2/);

  // One more round: the pending fix task runs first, then the review; c3 is unblocked behind it.
  assert.throws(() => retryCard(board, 'c2'), /card c2 is done, not failed/);
  assert.throws(() => retryCard(board, 'nope'), /no card nope/);
  const workerCalls: string[] = [];
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, delayMs: 1, worker: (o, i) => { workerCalls.push(o.prompt.match(/Task id: (\S+)\s+Card id: (\S+)/)!.slice(1, 3).reverse().join('/')); return DEFAULT_FAKE_SCRIPT.worker!(o, i); }, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  const saved = store.loadBoard(repo, 'run2');
  assert.equal(retryCard(saved, 'c1').attempts, 1, 'one round is given back');
  assert.equal(saved.cards[2]!.status, 'backlog');
  const orch2 = createOrchestrator(repo, saved, { ...config, maxReplans: 0 }, {});
  await orch2.execute();
  assert.deepEqual(saved.cards.map((c) => c.status), ['done', 'done', 'done']);
  assert.deepEqual(workerCalls, ['c1/fix2', 'c3/t1'], 'only the pending fix task and the unblocked card ran');
  assert.deepEqual(saved.cards[0]!.tasks.map((t) => t.status), ['done', 'done', 'done']);
});

test('a merge conflict with landed work is resolved by a fix task and does not cost an attempt', async () => {
  const plan: PlannerResult = {
    cards: ['c1', 'c2'].map((id) => ({ id, title: id, description: '', acceptanceCriteria: [], dependsOn: [], tasks: [{ id: 't1', title: 'write', instructions: '' }] })),
  };
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 5,
    planner: plan,
    checker: () => ({ pass: true, feedback: [], summary: 'ok' }),
    worker: (o) => {
      const [, taskId, cardId] = o.prompt.match(/Task id: (\S+)\s+Card id: (\S+)/)!;
      const file = join(o.cwd, 'shared.txt');
      if (taskId!.startsWith('fix')) {
        assert.match(o.prompt, /conflict markers/);
        const merged = readFileSync(file, 'utf8').split('\n').filter((l) => l && !/^(<{7}|={7}|>{7})/.test(l)).sort().join('\n') + '\n';
        writeFileSync(file, merged);
        return { summary: 'resolved', filesChanged: ['shared.txt'], done: true, remaining: [], learnings: [] };
      }
      writeFileSync(file, `line from ${cardId}\n`);
      return { summary: `wrote ${cardId}`, filesChanged: ['shared.txt'], done: true, remaining: [], learnings: [] };
    },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run4');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();

  assert.deepEqual(board.cards.map((c) => c.status), ['done', 'done']);
  assert.deepEqual(board.cards.map((c) => c.attempts), [0, 0], 'conflicts do not count as review attempts');
  const conflicted = board.cards.filter((c) => c.tasks.some((t) => t.kind === 'fix'));
  assert.equal(conflicted.length, 1);
  assert.deepEqual(conflicted[0]!.tasks.map((t) => t.title), ['write', 'Resolve merge conflicts']);
  assert.ok(events.some((e) => /conflicts with merged work in shared.txt/.test(e)));
  assert.equal(wt.git(repo, ['show', 'dulger/run4:shared.txt']), 'line from c1\nline from c2');
});

test('a failed card triggers a replan that replaces the waiting cards', async () => {
  const prompts: string[] = [];
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 5,
    checker: (opts) => (/Card under review: c1 /.test(opts.prompt) ? { pass: false, feedback: ['never good enough'], summary: '' } : { pass: true, feedback: [], summary: 'ok' }),
    planner: (opts, i) => {
      if (i === 0) return DEFAULT_FAKE_SCRIPT.planner as PlannerResult;
      prompts.push(opts.prompt);
      // Reuses the id c3 on purpose: it must be renamed, and c4's dependency must follow the rename.
      return { cards: [
        { id: 'c3', title: 'Wire CLI without greeting', description: '', acceptanceCriteria: [], dependsOn: ['c2'], tasks: [{ id: 't1', title: 'write cli', instructions: '' }] },
        { id: 'c4', title: 'Smoke test', description: '', acceptanceCriteria: [], dependsOn: ['c3'], tasks: [{ id: 't1', title: 'test', instructions: '' }] },
      ] };
    },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run5');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();

  const byId = Object.fromEntries(board.cards.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId), ['c1', 'c2', 'c3', 'c3-r1', 'c4']);
  assert.equal(byId.c1!.status, 'failed');
  assert.equal(byId.c2!.status, 'done');
  assert.equal(byId.c3!.status, 'replaced');
  assert.match(byId.c3!.reason!, /replaced by replan 1/);
  assert.equal(byId['c3-r1']!.status, 'done');
  assert.deepEqual(byId.c4!.dependsOn, ['c3-r1']);
  assert.equal(byId.c4!.status, 'done');
  assert.equal(board.replans, 1);
  assert.equal(prompts.length, 1, 'planner asked to replan once');
  assert.match(prompts[0]!, /## Failed cards[\s\S]*### c1: Create greeting module \[failed\][\s\S]*never good enough/);
  assert.match(prompts[0]!, /## Waiting cards[\s\S]*### c3: Wire CLI \[backlog\]/);
  assert.ok(events.some((e) => /replanned: 2 new cards \(c3-r1, c4\), 1 replaced/.test(e)), events.join('\n'));
  const files = wt.git(repo, ['ls-tree', '-r', '--name-only', 'dulger/run5']).split('\n').sort();
  assert.deepEqual(files, ['README.md', 'out/c2-t1.txt', 'out/c2-t2.txt', 'out/c3-r1-t1.txt', 'out/c4-t1.txt']);
});

test('worktreeSetup runs once in every new worktree, before its first agent', async () => {
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, delayMs: 5 }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-setup');
  const events: string[] = [];
  const setupLog = join(mkdtempSync(join(tmpdir(), 'dulger-setup-')), 'setup.log'); // outside the worktrees, so it is not committed
  const orch = createOrchestrator(repo, board, { ...config, worktreeSetup: `echo "$PWD" >> ${setupLog}` }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();
  assert.deepEqual(board.cards.map((c) => c.status), ['done', 'done', 'done']);
  const ran = readFileSync(setupLog, 'utf8').trim().split('\n');
  assert.equal(ran.length, 4, 'three cards and the docs worktree');
  assert.equal(new Set(ran).size, 4, 'each worktree was set up exactly once');
  // The shell reports the physical path ($PWD resolves symlinks, e.g. /var -> /private/var on macOS);
  // the expected path keeps the logical one. Compare physical to physical.
  const phys = (p: string) => p.replace(tmpdir(), realpathSync(tmpdir()));
  for (const id of ['c1', 'c2', 'c3', 'docs']) assert.ok(ran.includes(phys(store.worktreeDir(repo, 'run-setup', id))), `${id} worktree was set up`);
  assert.ok(!events.some((e) => e.includes('setup failed')));

  const failing = createBoard(repo, 'demo', 'run-setup-fail');
  const orch2 = createOrchestrator(repo, failing, { ...config, docs: false, concurrency: 1, worktreeSetup: 'echo boom >&2; exit 3' }, { log: (m) => events.push(m) });
  await orch2.plan();
  await orch2.execute();
  assert.ok(events.some((e) => e.includes('worktree setup failed') && e.includes('boom')), 'failure is logged with stderr');
  assert.deepEqual(failing.cards.map((c) => c.status), ['failed', 'failed', 'blocked'], 'failed setup stops agent calls and remains recoverable');
  assert.ok(failing.cards.filter((c) => c.status === 'failed').every((c) => c.failure === 'infrastructure'));
});

test('plan(feedback) revises in the same planner session and records assumptions', async () => {
  const seen: Array<{ resume?: string; prompt: string }> = [];
  const defaultCards = (DEFAULT_FAKE_SCRIPT.planner as PlannerResult).cards;
  const planner: FakeScript['planner'] = (o, i) => {
    seen.push({ resume: o.resumeSessionId, prompt: o.prompt });
    return i === 0
      ? { assumptions: ['Assumed TypeScript'], omitted: ['No deploy: nowhere to deploy to'], cards: defaultCards }
      : { assumptions: ['Assumed TypeScript', 'Dropped c3 as asked'], omitted: [], cards: defaultCards.slice(0, 2) };
  };
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner, delayMs: 1 }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-order');
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, {});
  await orch.plan();
  assert.equal(board.cards.length, 3);
  assert.deepEqual(board.plan, { sessionId: 'fake-planner-0', assumptions: ['Assumed TypeScript'], omitted: ['No deploy: nowhere to deploy to'], revisions: 0 });
  await orch.plan('drop the third card');
  assert.equal(board.cards.length, 2);
  assert.equal(board.plan?.revisions, 1);
  assert.deepEqual(board.plan?.omitted, []);
  assert.equal(seen[1]?.resume, 'fake-planner-0', 'the revision continues the planner session');
  assert.match(seen[1]!.prompt, /drop the third card/);
  assert.equal(store.loadBoard(repo, 'run-order').plan?.revisions, 1, 'the revision is persisted');
});

test('resuming a finished run does not start the documentation agent again', async () => {
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, delayMs: 1, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-docs-once');
  const first = createOrchestrator(repo, board, config, {});
  await first.plan();
  await first.execute();
  assert.equal(board.docs?.status, 'done');

  const resumed = store.loadBoard(repo, 'run-docs-once');
  resetInterrupted(resumed);
  const events: string[] = [];
  await createOrchestrator(repo, resumed, config, { log: (m) => events.push(m) }).execute();
  assert.equal(resumed.docs?.status, 'done');
  assert.ok(events.some((e) => e === 'documentation already done'));
  const log = readFileSync(join(repo, '.dulger', 'runs', 'run-docs-once', 'events.jsonl'), 'utf8');
  assert.equal((log.match(/"type":"docs_started"/g) ?? []).length, 1, 'the docs agent ran once across run and resume');
});

test('abort stops dispatching and leaves the board resumable', async () => {
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, delayMs: 50 }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run3');
  const orch = createOrchestrator(repo, board, { ...config, concurrency: 1 }, {});
  await orch.plan();
  setTimeout(() => orch.abort(), 120);
  await orch.execute();
  assert.ok(board.cards.some((c) => c.status !== 'done'));
  assert.notEqual(board.docs?.status, 'done');
});

test('the verification gate sends a card back with the command output before any reviewer runs', async () => {
  const plan: PlannerResult = {
    cards: [{ id: 'c1', title: 'Gated', description: 'x', acceptanceCriteria: [], dependsOn: [], verify: ['test -f out/fixed.txt', 'echo hello'],
      tasks: [{ id: 't1', title: 'first', instructions: 'Create the first file' }] }],
  };
  const checkerPrompts: string[] = [];
  const script: FakeScript = {
    planner: plan,
    worker: (o, i) => {
      // The fix task is the one that satisfies the gate; the first task does not.
      if (/was not accepted/.test(o.prompt)) { writeFileSync(join(o.cwd, 'out', 'fixed.txt'), 'ok\n'); return { summary: 'fixed', filesChanged: ['out/fixed.txt'], done: true, remaining: [], learnings: [] }; }
      return DEFAULT_FAKE_SCRIPT.worker!(o, i);
    },
    checker: (o) => { checkerPrompts.push(o.prompt); return { pass: true, feedback: [], notes: [], summary: 'ok' }; },
    delayMs: 1,
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'gate', 'run-gate');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();

  const c1 = board.cards[0]!;
  assert.equal(c1.status, 'done');
  assert.equal(c1.attempts, 1, 'the failed gate costs a review round');
  assert.equal(checkerPrompts.length, 1, 'no reviewer ran for the state that failed verification');
  assert.match(c1.tasks[1]!.feedback![0]!, /`test -f out\/fixed.txt` failed \(exit 1\)/);
  assert.ok(events.some((e) => /c1 verification failed: FAILED test -f out\/fixed.txt \(exit 1\)/.test(e)), events.join('\n'));
  assert.deepEqual(c1.verification!.map((r) => [r.command, r.ok]), [['test -f out/fixed.txt', true], ['echo hello', true]], 'the latest run is what the board keeps');
  assert.equal(c1.verification![1]!.output, 'hello');
  assert.match(checkerPrompts[0]!, /## Verification run by dulger\n\n- passed: `test -f out\/fixed.txt`/, 'the reviewer sees what dulger established');
  const saved = store.loadBoard(repo, 'run-gate');
  assert.deepEqual(saved.cards[0]!.verify, c1.verify);
  assert.match(buildReport(saved, { full: true }), /verified:.*test -f out\/fixed.txt.*echo hello/);
  assert.match(buildReport(saved, {}).replace(/\x1b\[[0-9;]*m/g, ''), /verified: ✓ 2/);
});

test('a reviewer that cannot run is an infrastructure failure: no round spent, no fix task, no replan, and resume retries it', async () => {
  let checkerCalls = 0;
  let plannerCalls = 0;
  const broken: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 1,
    planner: (o, i) => { plannerCalls++; return DEFAULT_FAKE_SCRIPT.planner as PlannerResult; },
    checker: (o) => { checkerCalls++; if (/Card under review: c1 /.test(o.prompt)) throw new Error('spawn E2BIG'); return { pass: true, feedback: [], notes: [], summary: 'ok' }; },
  };
  registerAdapter('fake', createFakeAdapter(broken));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-infra');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();

  const c1 = board.cards[0]!;
  assert.equal(c1.status, 'failed');
  assert.equal(c1.failure, 'infrastructure');
  assert.equal(c1.attempts, 0, 'no review round was spent');
  assert.deepEqual(c1.tasks.map((t) => t.kind), [undefined], 'no fix task was sent to a worker');
  assert.match(c1.reason!, /reviewer could not run: spawn E2BIG/);
  assert.ok(events.some((e) => /card c1: reviewer could not run \(spawn E2BIG\); trying the review again/.test(e)), events.join('\n'));
  assert.ok(events.some((e) => /card c1 failed on dulger's side/.test(e)));
  assert.equal(plannerCalls, 1, 'no replan for an infrastructure failure');
  assert.equal(board.cards[2]!.status, 'blocked');
  assert.match(buildReport(board, {}), /c1 .*dulger could not run a step; resume retries it/);
  const worktree = store.worktreeDir(repo, 'run-infra', 'c1');
  assert.ok(existsSync(join(worktree, 'out', 'c1-t1.txt')), 'the finished work is kept');

  // Resume with a working reviewer.
  const workerCalls: string[] = [];
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, delayMs: 1, worker: (o, i) => { workerCalls.push(o.prompt.match(/Card id: (\S+)/)![1]!); return DEFAULT_FAKE_SCRIPT.worker!(o, i); }, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  const saved = store.loadBoard(repo, 'run-infra');
  assert.deepEqual(resetInterrupted(saved).map((c) => c.id), ['c1']);
  assert.equal(saved.cards[2]!.status, 'backlog', 'the blocked dependant gets another chance');
  const orch2 = createOrchestrator(repo, saved, { ...config, docs: false }, {});
  await orch2.execute();
  assert.deepEqual(saved.cards.map((c) => c.status), ['done', 'done', 'done']);
  assert.deepEqual(workerCalls, ['c3'], 'c1 needed no worker: its tasks were done');
  assert.equal(saved.cards[0]!.failure, undefined);
});

test('a replan agent that dies gets one more session before the replan counts as failed', async () => {
  const plannerCalls: number[] = [];
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 1,
    checker: (opts) => (/Card under review: c1 /.test(opts.prompt) ? { pass: false, feedback: ['never good enough'], summary: '' } : { pass: true, feedback: [], summary: 'ok' }),
    planner: (opts, i) => {
      plannerCalls.push(i);
      if (i === 0) return DEFAULT_FAKE_SCRIPT.planner as PlannerResult;
      if (i === 1) throw new Error('no output for 600s; killed as stalled');
      return { cards: [{ id: 'c4', title: 'Smoke test', description: '', acceptanceCriteria: [], dependsOn: ['c2'], verify: [], tasks: [{ id: 't1', title: 'test', instructions: '' }] }] };
    },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-replan-retry');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();
  assert.deepEqual(plannerCalls, [0, 1, 2]);
  assert.ok(events.some((e) => /replan agent failed \(no output for 600s; killed as stalled\); trying again/.test(e)), events.join('\n'));
  assert.equal(board.replans, 1);
  assert.equal(board.cards.find((c) => c.id === 'c4')?.status, 'done');
});

/** c1 never passes review, so a replan answers with `cards`. c2 verifies with `true`, which puts `true` on the board. */
function replanScript(cards: PlannerResult['cards'], systemPrompts: string[] = []): FakeScript {
  const first = structuredClone(DEFAULT_FAKE_SCRIPT.planner as PlannerResult);
  first.cards[1]!.verify = ['true'];
  return {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 1,
    checker: (opts) => (/Card under review: c1 /.test(opts.prompt) ? { pass: false, feedback: ['never good enough'], summary: '' } : { pass: true, feedback: [], summary: 'ok' }),
    planner: (opts, i) => { if (i === 0) return first; systemPrompts.push(opts.systemPrompt); return { cards }; },
  };
}
const smoke = (verify: string[], id = 'c4'): PlannerResult['cards'][number] => ({ id, title: 'Smoke test', description: '', acceptanceCriteria: [], dependsOn: ['c2'], verify, tasks: [{ id: 't1', title: 'test', instructions: '' }] });

test('a replan that only reuses approved verify commands is applied without asking', async () => {
  const systemPrompts: string[] = [];
  registerAdapter('fake', createFakeAdapter(replanScript([smoke(['true', ' test -f README.md '])], systemPrompts)));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-replan-approved');
  let asked = 0;
  const orch = createOrchestrator(repo, board, { ...config, docs: false, checker: { allowedCommands: ['test -f README.md'] } }, { approveCommands: async () => { asked++; return false; } });
  await orch.plan();
  await orch.execute();
  assert.equal(asked, 0, 'on the board or in checker.allowedCommands means approved');
  assert.equal(board.cards.find((c) => c.id === 'c4')?.status, 'done');
  assert.match(systemPrompts[0]!, /Reuse the verify commands already on the board where they fit: true\./);
});

test('a replan that adds a verify command is applied once the person approves it', async () => {
  const asked: Array<{ commands: string[]; cards: string[] }> = [];
  registerAdapter('fake', createFakeAdapter(replanScript([smoke(['true', 'echo new-check'], 'c3')])));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-replan-yes');
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, { approveCommands: async (commands, cards) => { asked.push({ commands, cards: cards.map((c) => c.id) }); return true; } });
  await orch.plan();
  await orch.execute();
  assert.deepEqual(asked, [{ commands: ['echo new-check'], cards: ['c3-r1'] }], 'asked once, about the new command only, naming the card as it lands');
  assert.equal(board.cards.find((c) => c.id === 'c3-r1')?.status, 'done');
  assert.equal(board.cards.find((c) => c.id === 'c3')?.status, 'replaced');
});

test('a replan whose new verify command is refused, or that nobody can approve, leaves the board as it is', async () => {
  for (const [name, hooks] of [['refused', { approveCommands: async () => false }], ['no hook', {}]] as const) {
    registerAdapter('fake', createFakeAdapter(replanScript([smoke(['echo new-check'])])));
    const repo = tempRepo();
    const board = createBoard(repo, 'demo', 'run-replan-no');
    const logs: string[] = [];
    const orch = createOrchestrator(repo, board, { ...config, docs: false }, { ...hooks, log: (m) => logs.push(m) });
    await orch.plan();
    await orch.execute();
    assert.deepEqual(board.cards.map((c) => c.id), ['c1', 'c2', 'c3'], name);
    assert.equal(board.cards[2]!.status, 'blocked', `${name}: the waiting card was not replaced`);
    assert.equal(board.replans, 1, name);
    const events = readFileSync(join(store.runDir(repo, board.runId), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.match(events.find((e) => e.type === 'replan_failed')?.message ?? '', /^refused because its new verify command was not approved: `echo new-check`$/, name);
    assert.ok(logs.some((l) => l.startsWith('replan failed: refused because')), name);
    assert.ok(!existsSync(store.worktreeDir(repo, board.runId, 'c4')), `${name}: nothing ran the new command`);
  }
});

test('an approved command does not approve a longer one that starts with it', async () => {
  const asked: string[][] = [];
  registerAdapter('fake', createFakeAdapter(replanScript([smoke(['npm test', 'npm test; echo x', 'true && curl x'])])));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-replan-prefix');
  const orch = createOrchestrator(repo, board, { ...config, docs: false, checker: { allowedCommands: ['npm test'] } }, { approveCommands: async (commands) => { asked.push(commands); return false; } });
  await orch.plan();
  await orch.execute();
  assert.deepEqual(asked, [['npm test; echo x', 'true && curl x']]);
});

test('stopping the run while a replan waits for approval refuses it instead of hanging', { timeout: 5000 }, async () => {
  registerAdapter('fake', createFakeAdapter(replanScript([smoke(['echo new-check'])])));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-replan-abort');
  let taken = false;
  const orch = createOrchestrator(repo, board, { ...config, docs: false }, { approveCommands: (_commands, _cards, signal) => {
    signal.addEventListener('abort', () => { taken = true; });
    setTimeout(() => orch.abort(), 5);
    return new Promise<boolean>(() => {}); // never answered
  } });
  await orch.plan();
  await orch.execute();
  assert.equal(taken, true, 'the question is told to go away');
  assert.ok(!board.cards.some((c) => c.id === 'c4'));
  assert.equal(board.checkpoint?.phase, 'stopped');
});

test('planWarnings flags cards too big to review and foundation cards that do too much', () => {
  const card = (id: string, tasks: number, dependsOn: string[] = []) => ({
    id, title: id, description: '', acceptanceCriteria: [], dependsOn, verify: [], status: 'backlog' as const, attempts: 0, feedback: [], costUsd: 0,
    tasks: Array.from({ length: tasks }, (_, i) => ({ id: `t${i + 1}`, cardId: id, title: '', instructions: '', status: 'pending' as const, attempts: 0 })),
  });
  assert.deepEqual(planWarnings([card('c1', 2), card('c2', 3, ['c1']), card('c3', 1, ['c1'])]), []);
  const w = planWarnings([card('c1', 4), card('c2', 1, ['c1']), card('c3', 1, ['c1']), card('c4', 1, ['c1'])]);
  assert.equal(w.length, 2);
  assert.match(w[0]!, /c1 has 4 tasks; a card this big/);
  assert.match(w[1]!, /c1 has 4 tasks and 3 cards wait for it/);
});

test('a diff too large for one prompt is reviewed file by file from the worktree', async () => {
  const checkerPrompts: string[] = [];
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 1,
    worker: (o, i) => {
      const r = DEFAULT_FAKE_SCRIPT.worker!(o, i);
      if (/Card id: c1\b/.test(o.prompt)) writeFileSync(join(o.cwd, 'out', 'big.txt'), 'x'.repeat(REVIEW_DIFF_MAX_CHARS + 1000) + '\n');
      return r;
    },
    checker: (o) => { checkerPrompts.push(o.prompt); return { pass: true, feedback: [], notes: [], summary: 'ok' }; },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-bigdiff');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, { ...config, docs: false, concurrency: 1 }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();
  assert.deepEqual(board.cards.map((c) => c.status), ['done', 'done', 'done']);
  const c1Prompt = checkerPrompts.find((p) => /Card under review: c1 /.test(p))!;
  assert.match(c1Prompt, /too large to include here\. Read it in the worktree one file at a time with\n`git diff dulger\/run-bigdiff\.\.\.HEAD -- <path>`/);
  assert.match(c1Prompt, /out\/big\.txt\s+\|/, 'the file list is the stat');
  assert.ok(!c1Prompt.includes('xxxxxxxxxx'), 'the content itself is not in the prompt');
  assert.ok(c1Prompt.length < 20_000, `prompt stays small (${c1Prompt.length} chars)`);
  const c2Prompt = checkerPrompts.find((p) => /Card under review: c2 /.test(p))!;
  assert.match(c2Prompt, /```diff\n[\s\S]*written by fake worker/, 'a small diff is still inline');
  assert.ok(events.some((e) => /card c1: diff is \d+ KB over 2 files; the reviewer reads it file by file/.test(e)), events.join('\n'));
});

test('an agent hitting the usage limit stops the run; nothing else is dispatched and resume continues it', async () => {
  const limit = "You've hit your session limit · resets 3:40am (Europe/Berlin)";
  const started: string[] = [];
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 5,
    worker: (o, i) => {
      const card = o.prompt.match(/Card id: (\S+)/)![1]!;
      started.push(card);
      if (card === 'c2') throw new Error(limit);
      return DEFAULT_FAKE_SCRIPT.worker!(o, i);
    },
    checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }),
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-limit');
  const events: string[] = [];
  const orch = createOrchestrator(repo, board, { ...config, concurrency: 1 }, { log: (m) => events.push(m) });
  await orch.plan();
  await orch.execute();

  assert.equal(board.halted?.reason, limit);
  assert.ok(events.some((e) => /stopping the run: You've hit your session limit/.test(e)), events.join('\n'));
  const byId = Object.fromEntries(board.cards.map((c) => [c.id, c]));
  assert.equal(byId.c1!.status, 'done');
  assert.equal(byId.c2!.status, 'in_progress', 'the card that hit the limit is not failed');
  assert.equal(byId.c2!.tasks[0]!.attempts, 1, 'no retry into the same wall');
  assert.equal(byId.c3!.status, 'backlog');
  assert.deepEqual(started, ['c1', 'c2'], 'nothing was dispatched after the limit');
  assert.equal(board.docs?.status, 'pending', 'docs did not run');
  const log = readFileSync(join(repo, '.dulger', 'runs', 'run-limit', 'events.jsonl'), 'utf8');
  assert.match(log, /"type":"halted"/);
  assert.ok(!/"type":"aborted"/.test(log));
  assert.match(buildReport(board, {}), /the run stopped itself: You've hit your session limit/);

  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, delayMs: 1, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  const saved = store.loadBoard(repo, 'run-limit');
  assert.deepEqual(resetInterrupted(saved).map((c) => c.id), ['c2']);
  assert.equal(saved.halted, undefined);
  const orch2 = createOrchestrator(repo, saved, config, {});
  await orch2.execute();
  assert.deepEqual(saved.cards.map((c) => c.status), ['done', 'done', 'done']);
  assert.equal(saved.docs?.status, 'done');
});

test('a worker that answers but cannot finish is a work failure; an agent that never answers is an infrastructure failure', async () => {
  const notDone: FakeScript['worker'] = (o, i) => (/Card id: c1\b/.test(o.prompt)
    ? { summary: 'stuck', filesChanged: [], done: false, remaining: ['everything'], learnings: [] }
    : DEFAULT_FAKE_SCRIPT.worker!(o, i));
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, worker: notDone, delayMs: 1, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-notdone');
  const orch = createOrchestrator(repo, board, { ...config, docs: false, maxReplans: 0, maxContinuations: 0 }, {});
  await orch.plan();
  await orch.execute();
  assert.equal(board.cards[0]!.status, 'failed');
  assert.equal(board.cards[0]!.failure, 'work');
  assert.match(board.cards[0]!.reason!, /task t1 was not finished after 2 tries/);

  const crash: FakeScript['worker'] = (o, i) => { if (/Card id: c1\b/.test(o.prompt)) throw new Error('boom'); return DEFAULT_FAKE_SCRIPT.worker!(o, i); };
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, worker: crash, delayMs: 1, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  const board2 = createBoard(repo, 'demo', 'run-crash');
  const orch2 = createOrchestrator(repo, board2, { ...config, docs: false, maxReplans: 0 }, {});
  await orch2.plan();
  await orch2.execute();
  assert.equal(board2.cards[0]!.failure, 'infrastructure');
  assert.match(board2.cards[0]!.reason!, /task t1 could not run: boom/);

  // A board written before failures were classified: the failed task never got an answer.
  board2.cards[0]!.failure = undefined;
  store.saveBoard(repo, board2);
  assert.equal(store.loadBoard(repo, 'run-crash').cards[0]!.failure, 'infrastructure');
});

test('a later review round sees its earlier notes as settled', async () => {
  const prompts: string[] = [];
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 1,
    checker: (o, i) => {
      if (/Card under review: c1 /.test(o.prompt)) prompts.push(o.prompt);
      return i === 0 ? { pass: false, feedback: ['fix the thing'], notes: ['the handle tolerance is in image pixels'], summary: '' } : { pass: true, feedback: [], notes: [], summary: 'ok' };
    },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-notes');
  const orch = createOrchestrator(repo, board, { ...config, docs: false, concurrency: 1 }, {});
  await orch.plan();
  await orch.execute();
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0]!.includes('Notes from earlier rounds'));
  assert.match(prompts[1]!, /## Notes from earlier rounds \(non-blocking then, non-blocking now\)\n\n- the handle tolerance is in image pixels/);
  assert.match(prompts[1]!, /Earlier review rounds asked for these fixes[\s\S]*fix the thing/);
});

test('a retried task is told about its earlier attempt; unreported files are shown to the reviewer; notes do not repeat', async () => {
  const workerPrompts: string[] = [];
  const checkerPrompts: string[] = [];
  let c1Calls = 0;
  const script: FakeScript = {
    ...DEFAULT_FAKE_SCRIPT,
    delayMs: 1,
    worker: (o, i) => {
      if (/Card id: c1\b/.test(o.prompt)) {
        workerPrompts.push(o.prompt);
        if (++c1Calls === 1) throw new Error('simulated agent crash');
        writeFileSync(join(o.cwd, 'stray.txt'), 'reformatted\n');
      }
      return DEFAULT_FAKE_SCRIPT.worker!(o, i);
    },
    checker: (o, i) => {
      if (/Card under review: c1 /.test(o.prompt)) checkerPrompts.push(o.prompt);
      const notes = ['same note every round'];
      return i === 0 ? { pass: false, feedback: ['once more'], notes, summary: '' } : { pass: true, feedback: [], notes, summary: 'ok' };
    },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-context');
  const orch = createOrchestrator(repo, board, { ...config, docs: false, concurrency: 1 }, {});
  await orch.plan();
  await orch.execute();
  const c1 = board.cards[0]!;
  assert.equal(c1.status, 'done');
  assert.ok(!workerPrompts[0]!.includes('ran once before'));
  assert.match(workerPrompts[1]!, /This task ran once before in this worktree[\s\S]*It ended without an answer: simulated agent crash/);
  assert.match(checkerPrompts[0]!, /Files in the diff that no task reported changing[\s\S]*- stray\.txt/);
  assert.ok(!/- out\/c1-t1\.txt/.test(checkerPrompts[0]!.split('no task reported')[1]!.split('##')[0]!), 'reported files are not listed');
  assert.deepEqual(c1.reviewNotes, ['same note every round']);
});

test('budgets: a card over its budget fails, a run over its budget stops itself', async () => {
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, delayMs: 1, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-cardbudget');
  const orch = createOrchestrator(repo, board, { ...config, docs: false, maxReplans: 0, cardBudgetUsd: 0.005, concurrency: 1 }, {});
  await orch.plan();
  await orch.execute();
  const c2 = board.cards[1]!;
  assert.equal(c2.status, 'failed');
  assert.match(c2.reason!, /card budget of \$0\.005 reached \(\$0\.01 spent\)/);
  assert.equal(c2.tasks[0]!.status, 'done');
  assert.equal(c2.tasks[1]!.status, 'pending', 'the budget is checked before each task');
  assert.equal(c2.attempts, 0, 'and before the review, so no reviewer ran');
  assert.equal(c2.failure, 'work', 'retry can give it another go once the budget is raised');

  const board2 = createBoard(repo, 'demo', 'run-budget');
  const events: string[] = [];
  const orch2 = createOrchestrator(repo, board2, { ...config, docs: false, budgetUsd: 0.03, concurrency: 1 }, { log: (m) => events.push(m) });
  await orch2.plan();
  await orch2.execute();
  assert.match(board2.halted!.reason, /run budget of \$0\.03 reached/);
  assert.ok(board2.cards.some((c) => c.status === 'backlog' || c.status === 'in_progress'), 'the rest waits for a resume');
  assert.ok(events.some((e) => /stopping the run: run budget/.test(e)));
});
