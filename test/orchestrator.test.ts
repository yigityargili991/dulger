import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wt from '../src/git/worktree.ts';
import { createOrchestrator } from '../src/runner/orchestrator.ts';
import { createBoard } from '../src/board/create.ts';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { createFakeAdapter, DEFAULT_FAKE_SCRIPT, type FakeScript } from '../src/adapters/fake.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import { openMemory } from '../src/context/memory.ts';
import { buildReport } from '../src/ui/report.ts';
import { resetInterrupted } from '../src/board/scheduler.ts';
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
  const report = buildReport(board, { diffStat: ' 3 files changed' }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(report, /^Run run1  main @ [0-9a-f]{7} → dulger\/run1\nGoal: demo\nLanded 3 of 3 cards, docs updated · spent \$0\.1\d · \d+k tokens \(74% cached, \d+ out\)/);
  assert.match(report, /spent: \$0\.0\d · \dk tokens \(74% cached/);
  assert.deepEqual(board.usage, { input: 2200, cacheRead: 7700, cacheWrite: 550, output: 550 });
  assert.match(report, /Plan windows at the end of the run: 5h 35% · 7d 23%/);
  assert.equal(board.rateLimits?.windows.length, 2, 'the latest reading is kept on the board');
  assert.match(report, /\nLanded\n  c1 .*\n     t1 .*Wrote c1-t1\.txt/);
  assert.match(report, /files: out\/c1-fix1\.txt, out\/c1-t1\.txt/);
  assert.match(report, /review rounds: 2 \(fix tasks: Address review feedback\)/);
  assert.match(report, /review: looks good/);
  assert.match(report, /note: Fake note: consider a helper/);
  assert.match(report, /\nDocumentation\n  Wrote DOCS\.md/);
  assert.match(report, /\nChanges\n  3 files changed/);
  assert.match(report, /\nNext\n  git merge dulger\/run1/);
  assert.ok(!report.includes('Not landed'));
  assert.match(learnings[0]!.text, /Fake learning/);
  assert.ok(learnings[0]!.seen >= 4, `seen ${learnings[0]!.seen}`);
  assert.ok(learnings[0]!.files.includes('out/c1-t1.txt'));
  assert.ok(!existsSync(join(repo, '.dulger', 'memory.jsonl')), 'memory is not stored in the repo');
  assert.ok(events.some((e) => /c1 rejected/.test(e)));
  // c3 must not start before c1 and c2 are done.
  const idx = (re: RegExp) => events.findIndex((e) => re.test(e));
  assert.ok(idx(/card c3 started/) > idx(/card c1 done/) && idx(/card c3 started/) > idx(/card c2 done/));
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
  assert.deepEqual(byId.c1!.tasks.map((t) => t.id), ['t1', 'fix1'], 'one fix round before giving up; no fix task after the final rejection');
  assert.deepEqual(byId.c1!.feedback, ['never good enough', 'never good enough']);
  assert.equal(byId.c2!.status, 'done');
  assert.equal(byId.c3!.status, 'blocked');
  assert.match(byId.c3!.feedback.at(-1)!, /dependency c1/);
  const kept = store.worktreeDir(repo, 'run2', 'c1');
  assert.ok(existsSync(kept) && !kept.startsWith(repo), 'failed worktree is kept for inspection, outside the repo');
  assert.equal(board.docs?.status, 'done');
  const files = wt.git(repo, ['ls-tree', '-r', '--name-only', 'dulger/run2']).split('\n').sort();
  assert.deepEqual(files, ['DOCS.md', 'README.md', 'out/c2-t1.txt', 'out/c2-t2.txt']);
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
  assert.match(byId.c3!.feedback.at(-1)!, /replaced by replan 1/);
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
  for (const id of ['c1', 'c2', 'c3', 'docs']) assert.ok(ran.includes(store.worktreeDir(repo, 'run-setup', id)), `${id} worktree was set up`);
  assert.ok(!events.some((e) => e.includes('setup failed')));

  const failing = createBoard(repo, 'demo', 'run-setup-fail');
  const orch2 = createOrchestrator(repo, failing, { ...config, docs: false, concurrency: 1, worktreeSetup: 'echo boom >&2; exit 3' }, { log: (m) => events.push(m) });
  await orch2.plan();
  await orch2.execute();
  assert.ok(events.some((e) => e.includes('worktree setup failed') && e.includes('boom')), 'failure is logged with stderr');
  assert.deepEqual(failing.cards.map((c) => c.status), ['done', 'done', 'done'], 'a failed setup does not stop the card');
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
