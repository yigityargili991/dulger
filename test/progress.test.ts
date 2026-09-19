// The progress reporter: while a card runs, a lightweight headless agent turns its live activity
// into a note on the card. These tests drive it through the fake adapter with a slow worker, so
// real sweeps happen on a real orchestrator loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wt from '../src/git/worktree.ts';
import { createOrchestrator } from '../src/runner/orchestrator.ts';
import { createBoard } from '../src/board/create.ts';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { createFakeAdapter, type FakeScript } from '../src/adapters/fake.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import * as store from '../src/board/store.ts';
import { buildReport } from '../src/ui/report.ts';
import type { PlannerResult } from '../src/types.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-data-'));

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dulger-progress-'));
  wt.git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  wt.git(dir, ['add', '.']);
  wt.git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return dir;
}

const oneCard = (tasks = 1): PlannerResult => ({
  cards: [{ id: 'c1', title: 'Slow card', description: 'Takes a while on purpose.', acceptanceCriteria: ['it exists'], dependsOn: [], verify: [],
    tasks: Array.from({ length: tasks }, (_, i) => ({ id: `t${i + 1}`, title: `step ${i + 1}`, instructions: 'Create the file' })) }],
});

const base: Config = { ...DEFAULT_CONFIG, harness: 'fake', concurrency: 2, maxAttempts: 2, stallTimeoutSec: 10, docs: false };

const events = (repo: string, runId: string) =>
  readFileSync(join(repo, '.dulger', 'runs', runId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; cardId?: string; message?: string });

test('while a card runs, the reporter writes a note on it and charges the run, not the card', async () => {
  const reporterPrompts: string[] = [];
  const script: FakeScript = {
    planner: oneCard(),
    delayMs: 100, // the worker runs ~200ms; the 50ms sweep lands inside it
    checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }),
    reporter: (o, i) => { reporterPrompts.push(o.prompt); return { note: `note ${i + 1}: writing the file`, attention: 'the worker keeps rewriting the same file' }; },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-progress');
  const log: string[] = [];
  const orch = createOrchestrator(repo, board, { ...base, progressIntervalSec: 0.05 }, { log: (m) => log.push(m) });
  await orch.plan();
  await orch.execute();

  assert.equal(board.cards[0]!.status, 'done');
  assert.ok(board.cards[0]!.progress, 'the card carries a progress note');
  assert.match(board.cards[0]!.progress!.note, /note \d+: writing the file/);
  assert.ok(Date.parse(board.cards[0]!.progress!.at!) > 0, 'the note is timestamped');
  assert.match(board.cards[0]!.progress!.attention!, /rewriting the same file/);

  const saved = store.loadBoard(repo, 'run-progress');
  assert.equal(saved.cards[0]!.progress!.note, board.cards[0]!.progress!.note, 'the note survives the board round-trip');

  const ev = events(repo, 'run-progress');
  assert.ok(ev.some((e) => e.type === 'progress' && e.cardId === 'c1' && /note \d+: writing the file/.test(e.message ?? '')), 'each note is a board event');
  assert.ok(log.some((l) => /c1 progress: note \d+: writing the file/.test(l)), 'each note is a log line');

  const reporters = [...orch.registry.statuses.values()].filter((s) => s.role === 'reporter');
  assert.ok(reporters.length >= 1, 'the reporter ran as its own agent');
  assert.equal(reporters[0]!.harness, 'fake');
  assert.match(reporterPrompts[0]!, /## Card c1: Slow card \[in progress\]/, 'the digest names the card');
  assert.match(reporterPrompts[0]!, /- t1 \[running\] step 1/, 'the digest shows the task states');
  assert.match(reporterPrompts[0]!, /worker on fake, \d+ turns? over \d+s/, 'the digest shows the live agent');
  assert.match(reporterPrompts[0]!, /fake worker thinking/, 'the digest carries the worker history');
  assert.ok(!reporterPrompts[0]!.includes('Previous note'), 'the first note has no predecessor');

  // Reporting is a run-level service: the card's spend is its own work (worker + checker); the
  // reporter's tokens land on the run.
  assert.equal(board.cards[0]!.costUsd, 0.02, 'worker + checker, no reporter cost on the card');
  assert.ok(board.costUsd > board.cards[0]!.costUsd + 0.01, 'the reporter is charged to the run');
});

test('a later note is told what the previous one said, and the note reaches the report output', async () => {
  const reporterPrompts: string[] = [];
  const script: FakeScript = {
    planner: oneCard(2), // two slow tasks keep the card in progress across several sweeps
    delayMs: 100,
    checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }),
    reporter: (o, i) => { reporterPrompts.push(o.prompt); return { note: `note ${i + 1}`, attention: '' }; },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-progress-2');
  const orch = createOrchestrator(repo, board, { ...base, progressIntervalSec: 0.05 }, { log: () => {} });
  await orch.plan();
  await orch.execute();

  assert.ok(reporterPrompts.length >= 2, `at least two notes over a long card (got ${reporterPrompts.length})`);
  assert.equal(board.cards[0]!.progress!.note, `note ${reporterPrompts.length}`);
  assert.match(reporterPrompts[1]!, /## Previous note \(say what changed since, not the same words\)\n\nnote 1/, 'later notes see their predecessor');
  // The report shows where a running card was when the run stopped; ask it for that shape by hand.
  const interrupted = { ...board, cards: board.cards.map((c) => ({ ...c, status: 'in_progress' as const })) };
  const text = buildReport(interrupted, {}).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /progress: note \d+/);
});

test('progressIntervalSec 0 disables the reporter entirely', async () => {
  let reporterCalls = 0;
  const script: FakeScript = {
    planner: oneCard(),
    delayMs: 100,
    checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }),
    reporter: () => { reporterCalls++; return { note: 'should not run', attention: '' }; },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-noprogress');
  const orch = createOrchestrator(repo, board, { ...base, progressIntervalSec: 0 }, { log: () => {} });
  await orch.plan();
  await orch.execute();
  assert.equal(board.cards[0]!.status, 'done');
  assert.equal(reporterCalls, 0, 'no reporter call was made');
  assert.equal(board.cards[0]!.progress, undefined);
  assert.ok(!events(repo, 'run-noprogress').some((e) => e.type === 'progress'));
});

test('a reporter that fails is logged and never costs the card its run', async () => {
  const script: FakeScript = {
    planner: oneCard(),
    delayMs: 100,
    checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }),
    reporter: () => { throw new Error('reporter model is overloaded'); },
  };
  registerAdapter('fake', createFakeAdapter(script));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-reporter-fails');
  const log: string[] = [];
  const orch = createOrchestrator(repo, board, { ...base, progressIntervalSec: 0.05 }, { log: (m) => log.push(m) });
  await orch.plan();
  await orch.execute();

  assert.equal(board.cards[0]!.status, 'done', 'the card landed anyway');
  assert.equal(board.cards[0]!.progress, undefined, 'no note was invented');
  assert.ok(log.some((l) => /progress reporter for c1 gave no note: reporter model is overloaded/.test(l)), log.join('\n'));
  assert.ok(!events(repo, 'run-reporter-fails').some((e) => e.type === 'progress'), 'a failed reporter writes no event');
});

test('short runs under the default interval never pay for a reporter', async () => {
  registerAdapter('fake', createFakeAdapter({ planner: oneCard(), delayMs: 1, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'run-short');
  const orch = createOrchestrator(repo, board, base, { log: () => {} });
  await orch.plan();
  await orch.execute();
  assert.equal(board.cards[0]!.status, 'done');
  assert.equal([...orch.registry.statuses.values()].filter((s) => s.role === 'reporter').length, 0, 'the default 120s never fires in a fast run');
  assert.ok(!events(repo, 'run-short').some((e) => e.type === 'progress'));
  assert.equal(board.costUsd, 0.03, 'planner + worker + checker only');
});
test('a reporter-only rate limit never halts the worker on another backend', async () => {
  registerAdapter('fake', createFakeAdapter({ planner: oneCard(), delayMs: 40, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) }));
  let calls = 0;
  registerAdapter('limited-reporter', { name: 'limited-reporter', async run(o) {
    calls++;
    assert.equal(o.access, 'none');
    return { ok: false, text: '', exitCode: 1, error: 'reporter provider HTTP 429 rate limit' };
  } });
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'reporter-only-limit');
  const log: string[] = [];
  const orch = createOrchestrator(repo, board, { ...base, progressIntervalSec: 0.01, roles: { reporter: { harness: 'limited-reporter' } } }, { log: (m) => log.push(m) });
  await orch.plan();
  await orch.execute();
  assert.ok(calls > 0);
  assert.equal(board.halted, undefined);
  assert.equal(board.cards[0]!.status, 'done');
  assert.ok(log.some((m) => m.includes('gave no note: reporter provider HTTP 429')));
});

test('shutdown cancels a pending reporter and persists its cost before docs or returning', async (t) => {
  for (const ending of ['finished', 'aborted', 'halted'] as const) await t.test(ending, async () => {
    let startReporter!: () => void;
    const reporterStarted = new Promise<void>((resolve) => { startReporter = resolve; });
    let reporterAborted = false;
    let docsStarted = false;
    const fake = createFakeAdapter({ planner: oneCard(), delayMs: 20, checker: () => ({ pass: true, feedback: [], notes: [], summary: 'ok' }) });
    registerAdapter('fake', { name: 'fake', async run(o) {
      if (o.systemPrompt.startsWith('[role:worker]')) {
        await reporterStarted; // ensure this run has an in-flight reporter
        if (ending === 'halted') return { ok: false, text: '', exitCode: 1, error: 'worker usage limit' };
      }
      if (o.systemPrompt.startsWith('[role:docs]')) {
        docsStarted = true;
        assert.equal(reporterAborted, true, 'stop reporting before docs starts');
      }
      return fake.run(o);
    } });
    registerAdapter('slow-reporter', { name: 'slow-reporter', async run(o) {
      assert.equal(o.access, 'none');
      startReporter();
      await new Promise<void>((resolve) => {
        const aborted = () => { reporterAborted = true; resolve(); };
        if (o.signal.aborted) aborted();
        else o.signal.addEventListener('abort', aborted, { once: true });
      });
      // A backend can report spend, and even output, as it shuts down.
      return { ok: true, text: '', output: { note: 'late note', attention: '' }, exitCode: 0, costUsd: 0.5,
        usage: { input: 123, output: 10, cacheRead: 0, cacheWrite: 0 } };
    } });
    const repo = tempRepo();
    const board = createBoard(repo, 'demo', `pending-reporter-${ending}`);
    const orch = createOrchestrator(repo, board, { ...base, docs: true, progressIntervalSec: 0.01, roles: { reporter: { harness: 'slow-reporter' } } });
    await orch.plan();
    const execution = orch.execute();
    await reporterStarted;
    if (ending === 'aborted') orch.abort();
    // Bound the regression: the broken implementation otherwise waits for the 10s watchdog.
    const timeout = setTimeout(() => orch.abort(), 2000);
    try { await execution; } finally { clearTimeout(timeout); }
    assert.equal(reporterAborted, true);
    assert.equal(docsStarted, ending === 'finished');
    if (ending === 'finished') assert.equal(board.cards[0]!.status, 'done');
    if (ending === 'halted') assert.match(board.halted!.reason, /worker usage limit/);
    assert.equal(board.cards[0]!.progress, undefined, 'cancelled output never becomes a note');
    const saved = store.loadBoard(repo, board.runId);
    assert.ok(board.costUsd >= 0.5, 'the cancelled reporter is still charged');
    assert.ok(board.cards[0]!.costUsd < 0.5, 'reporting never spends the card budget');
    assert.equal(saved.costUsd, board.costUsd);
    assert.deepEqual(saved.usage, board.usage);
    assert.ok(!events(repo, board.runId).some((e) => e.type === 'progress'));
    if (ending === 'finished') assert.equal(events(repo, board.runId).at(-1)!.type, 'finished');
  });
});

test('reporter spend still enforces the run budget and persists usage when it halts', async () => {
  registerAdapter('fake', createFakeAdapter({ planner: oneCard(), delayMs: 40 }));
  registerAdapter('costly-reporter', { name: 'costly-reporter', async run() {
    return { ok: true, text: '', output: { note: 'working', attention: '' }, exitCode: 0, costUsd: 0.5,
      usage: { input: 123, output: 10, cacheRead: 0, cacheWrite: 0 } };
  } });
  const repo = tempRepo();
  const board = createBoard(repo, 'demo', 'reporter-budget');
  const orch = createOrchestrator(repo, board, { ...base, budgetUsd: 0.2, progressIntervalSec: 0.01, roles: { reporter: { harness: 'costly-reporter' } } });
  await orch.plan();
  await orch.execute();
  assert.match(board.halted!.reason, /run budget/);
  assert.ok(board.costUsd >= 0.5);
  assert.equal(board.cards[0]!.costUsd, 0);
  assert.equal(board.cards[0]!.progress, undefined, 'do not write a note after the budget halt');
  const saved = store.loadBoard(repo, board.runId);
  assert.equal(saved.costUsd, board.costUsd);
  assert.deepEqual(saved.usage, board.usage);
});
