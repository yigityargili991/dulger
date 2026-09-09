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
import * as store from '../src/board/store.ts';
import type { PlannerResult } from '../src/types.ts';

process.env.USTA_DATA_DIR = mkdtempSync(join(tmpdir(), 'usta-data-'));

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usta-orch-'));
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
  assert.match(c1.summary!, /Wrote c1-t1\.txt Wrote c1-fix1\.txt/);
  assert.equal(board.docs?.status, 'done');
  const files = wt.git(repo, ['ls-tree', '-r', '--name-only', 'usta/run1']).split('\n').sort();
  assert.deepEqual(files, ['DOCS.md', 'README.md', 'out/c1-fix1.txt', 'out/c1-t1.txt', 'out/c2-t1.txt', 'out/c2-t2.txt', 'out/c3-t1.txt']);
  assert.equal(wt.currentBranch(repo), 'main');
  assert.equal(wt.git(repo, ['branch', '--list', 'usta-wip/*']), '', 'wip branches cleaned up');
  assert.ok(!existsSync(store.worktreeDir(repo, 'run1', 'c1')));
  assert.ok(!existsSync(join(repo, '.usta', 'worktrees')), 'worktrees are not nested in the repo');
  const learnings = openMemory(repo, config.memory).load();
  assert.equal(learnings.length, 1);
  assert.match(learnings[0]!.text, /Fake learning/);
  assert.ok(learnings[0]!.seen >= 4, `seen ${learnings[0]!.seen}`);
  assert.ok(learnings[0]!.files.includes('out/c1-t1.txt'));
  assert.ok(!existsSync(join(repo, '.usta', 'memory.jsonl')), 'memory is not stored in the repo');
  assert.ok(events.some((e) => /c1 rejected/.test(e)));
  // c3 must not start before c1 and c2 are done.
  const idx = (re: RegExp) => events.findIndex((e) => re.test(e));
  assert.ok(idx(/card c3 started/) > idx(/card c1 done/) && idx(/card c3 started/) > idx(/card c2 done/));
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
  const files = wt.git(repo, ['ls-tree', '-r', '--name-only', 'usta/run2']).split('\n').sort();
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
  assert.equal(wt.git(repo, ['show', 'usta/run4:shared.txt']), 'line from c1\nline from c2');
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
  const files = wt.git(repo, ['ls-tree', '-r', '--name-only', 'usta/run5']).split('\n').sort();
  assert.deepEqual(files, ['README.md', 'out/c2-t1.txt', 'out/c2-t2.txt', 'out/c3-r1-t1.txt', 'out/c4-t1.txt']);
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
