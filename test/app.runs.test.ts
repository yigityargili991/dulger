// The Runs tab against temporary repositories: the list in every state (an unreadable board as a row),
// the selected run's facts and cards, the keys that start each action (an off one toasts why), what `?`
// says about the selected run, navigation parameters, cleanup, the narrow one-pane layout and every
// size down to 1×1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createRunsPage, type RunsDeps } from '../src/app/pages/runs.ts';
import type { Page } from '../src/app/types.ts';
import type { ReviewOptions } from '../src/app/pages/review.ts';
import type { IconSet } from '../src/tui/theme.ts';
import { SIZES, assertFrame, ch, key, press, wheel } from './kit.helpers.ts';
import { app, attentionRun, homePage, land, missingBranchRun, plan, readyRun, realRun, repo, unreadableRun, unstartedRun } from './app.runs.fixtures.ts';
import { createBoard } from '../src/board/create.ts';
import { worktreesDir } from '../src/paths.ts';

/** The Runs tab with recorded launches and stand-in sub-pages. */
function runsApp(root: string, size?: { rows: number; cols: number }, icons?: IconSet) {
  const calls: string[] = [];
  const stub = (id: string): Page => ({ id, title: id, render: () => ({ lines: [`stub ${id}`] }), onKey: () => false, hints: () => [] });
  const deps: Partial<RunsDeps> = {
    launchResume: async (_ctx, id, o = {}) => { calls.push(`resume ${id}${o.currentSettings ? ' current' : ''}`); },
    launchRetry: async (_ctx, id, card) => { calls.push(`retry ${id} ${card}`); },
    review: (_ctx, id, o?: ReviewOptions) => { calls.push(`review ${id}${o?.merge ? ' merge' : ''}`); return stub(`review-${id}`); },
    planEdit: (_ctx, id) => { calls.push(`edit ${id}`); return stub(`plan-${id}`); },
  };
  const a = app(root, [homePage, (ctx) => createRunsPage(ctx, deps)], size, icons);
  a.ctx.navigate('runs');
  return { ...a, calls };
}

const rowOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle));

/** The run's pane (right of the list on a wide screen) as one line of words: its facts wrap wherever the width says. */
function pane(text: string): string {
  const lines = text.split('\n');
  const head = lines.find((l) => (l.match(/╭/g) ?? []).length >= 2) ?? '';
  const at = [...head].findIndex((ch, i) => ch === '╭' && i > 0);
  return lines.map((l) => [...l].slice(Math.max(0, at)).join('')).join('\n').replace(/[│╭╮╰╯─▌]/g, ' ').replace(/\s+/g, ' ');
}

/** The help overlay's text alone, as one line of words. */
function help(text: string): string {
  const lines = text.split('\n');
  const top = lines.findIndex((l) => l.includes('─ Help '));
  if (top < 0) return '';
  const from = [...lines[top]!].indexOf('╭');
  const to = [...lines[top]!].indexOf('╮', from);
  const out: string[] = [];
  for (const l of lines.slice(top + 1)) { if ([...l][from] === '╰') break; out.push([...l].slice(from + 1, to).join('')); }
  return out.join(' ').replace(/[┃│]/g, ' ').replace(/\s+/g, ' ').trim();
}

test('no runs: an empty state of a few words, and Enter goes to Home', async (t) => {
  const root = repo(t);
  const a = runsApp(root);
  assert.match(a.s.text, /No runs yet/);
  assert.doesNotMatch(a.s.text, /A run is a goal/, 'nothing under it');
  assert.match(a.s.text, /⏎ home/);
  for (const [rows, cols] of SIZES) { a.s.resize(rows, cols); assertFrame(a.s.lines, rows, cols, 'empty runs'); }
  a.s.resize(24, 80);
  a.s.key(key('enter'));
  assert.match(a.s.text, /home page/);
  await a.quit();
});

test('the list: newest first, a glyph per state, cards, spend and age, no header; an unreadable board is a row', async (t) => {
  const root = repo(t);
  missingBranchRun(root, 'r1-missing');
  unstartedRun(root, 'r2-unstarted');
  attentionRun(root, 'r3-attention');
  unreadableRun(root, 'r4-broken');
  readyRun(root, 'r5-ready');
  const a = runsApp(root);
  let text = a.s.text;
  // Newest first by when each run started; a board that cannot be read (no date) is the oldest.
  const order = ['Add a feature', 'Add a health', 'Refactor the', 'Write the mi', 'r4-broken'].map((n) => rowOf(text, n));
  assert.ok(order.every((r) => r > 0), text);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'newest by start time first');
  // The glyph says the state (the run's pane spells it out); the goal keeps its room.
  assert.match(text, /✓\s+Add a feature file\s+3\/3\s+\$0\.42\s+1h/);
  assert.match(text, /Add a health endpoint with a con/, 'the goal column has room to tell runs apart');
  assert.match(text, /! +r4-broken +│/, 'the row is the run id; its pane has the error');
  assert.match(text, /2 Runs ▶2/, 'the tab badge is a glyph and a number');
  assert.doesNotMatch(text, /Goal\s+Cards|Status\s+Goal/, 'no header row');
  // The list box as tall as its five runs, closed right under the last one.
  const at = rowOf(text, 'r4-broken');
  assert.ok(text.split('\n')[at + 1]!.startsWith('╰'), 'the list box ends under its last run');
  assert.equal(at - rowOf(text, '╭─ ❯ Runs'), 5, 'five rows for five runs');
  // Wider, still no words beside the glyphs: those two states have glyphs of their own.
  a.s.resize(40, 160);
  text = a.s.text;
  assert.match(text.split('\n')[rowOf(text, 'Add a feature file')]!, /│ . ✓\s+Add a feature file\s+3\/3\s+\$0\.42\s+1h/);
  assert.match(text.split('\n')[rowOf(text, 'Add a health')]!, /│ . ✗\s+Add a health/);
  await a.quit();
});

test('the selected run: goal, facts as label and value, cards with failure reasons; its actions are keys, explained in ?', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  const a = runsApp(root);
  const text = a.s.text;
  assert.match(text, /╭─ r3-attention ─/, 'the pane is titled by the run id');
  assert.match(text, /Add a health endpoint with a config parser/);
  assert.match(text, /Status\s+✗ needs attention/);
  assert.match(text, /Branch\s+dulger\/r3-attention/);
  assert.match(text, /Base\s+main @ [0-9a-f]{7}/);
  assert.match(text, /Cards\s+1\/3 done · 1 failed · 1 blocked/);
  assert.match(pane(text), /Verified ✗ 1\/1 failed · npm run lint/);
  assert.match(text, /Docs\s+skipped/);
  assert.match(pane(text), /Settings differ: Parallel cards/, 'named as on Settings, not by config keys');
  assert.match(text, /✗\s+c2\s+Add the health endpoint\s+×3/, 'tries past the first round, as ×N');
  assert.match(text, /✓\s+c1\s+Parse the config\s+\$0\.30/, 'one round: no tries shown');
  assert.doesNotMatch(text, /ID\s+Title|Tries\s+Spend/, 'no header row');
  assert.match(text, /Still failing: expected \{"ok":true\}\./, 'a failed card shows why under it');
  assert.match(text, /blocked: depends on c2, which failed/);
  assert.doesNotMatch(pane(text), /Next|Retry a failed card|— /, 'no list of actions with captions');
  assert.match(text, /⏎ review {2}r resume {2}t retry {2}tab cards {2}\? help/, 'the keys this run allows');
  a.s.key(key('f1'));
  const said = help(a.s.text);
  assert.match(said, /^Add a health endpoint with a config parser r3-attention: needs attention\./, 'the selected run first');
  assert.match(said, /r resume: asks first, and which settings: this session's differ in Parallel cards/, 'one resume, which asks when the settings differ');
  assert.match(said, /t retry card: one more review round for a failed card: c2/);
  assert.match(said, /e edit plan \(off: work started\)/);
  assert.match(said, /m merge \(off: verify failed\)/);
  assert.doesNotMatch(a.s.text, /dulger (resume|retry)|\/resume|git merge/, 'no command syntax');
  await a.quit();
});

test('keys start each action; an off one says why in a toast instead', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  unstartedRun(root, 'r2-unstarted');
  const a = runsApp(root);
  a.s.key(ch('r'));
  a.s.key(ch('R'));
  await a.settle();
  assert.deepEqual(a.calls, ['resume r3-attention'], 'R is not a key of its own any more');
  a.s.key(ch('e'));
  assert.match(a.s.text, /Edit plan: work started/);
  a.s.key(ch('m'));
  assert.match(a.s.text, /Merge: verify failed/);
  a.s.key(ch('t'));
  await a.settle();
  assert.match(a.s.text, /Retry card[\s\S]*c2\s+Add the health endpoint/);
  a.s.key(key('enter'));
  await a.settle();
  assert.equal(a.calls.at(-1), 'retry r3-attention c2');
  a.s.key(key('enter'));
  assert.equal(a.calls.at(-1), 'review r3-attention', 'Enter on the list opens the review');
  a.s.key(key('escape'));
  a.s.key(key('down'));
  a.s.key(ch('e'));
  assert.equal(a.calls.at(-1), 'edit r2-unstarted', 'an unstarted plan can be edited');
  a.s.key(key('escape'));
  a.s.key(ch('t'));
  assert.match(a.s.text, /Retry card: no failed card/);
  a.s.key(ch('r'));
  await a.settle();
  assert.equal(a.calls.at(-1), 'resume r2-unstarted');
  await a.quit();
});

test('merge from Runs opens the review asking to merge; a ready run allows it', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5-ready');
  const a = runsApp(root);
  assert.match(a.s.text, /⏎ review {2}m merge/);
  a.s.key(key('f1'));
  assert.match(help(a.s.text), /m merge: into main, after a confirmation/);
  a.s.key(key('escape'));
  a.s.key(ch('m'));
  assert.equal(a.calls.at(-1), 'review r5-ready merge');
  await a.quit();
});

test('cards: Tab moves focus to them, Enter opens a card whole, p shows the report without command syntax', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  const a = runsApp(root);
  a.s.key(key('tab'));
  assert.match(a.s.text, /⏎ card/);
  a.s.key(key('down'));
  a.s.key(key('enter'));
  const card = a.s.text;
  assert.match(card, /c2 Add the health endpoint/);
  assert.match(card, /Why it failed/);
  assert.match(card, /Acceptance criteria/);
  assert.match(card, /Verify commands/);
  assert.match(card, /\$ npm test/);
  assert.match(card, /✗ npm test {3}exit 1 · 4\.3s/);
  assert.match(card, /not ok 1 - GET \/health/);
  assert.match(card, /Review feedback/);
  a.s.key(key('end'));
  a.s.key(key('escape'));
  a.s.key(key('escape'));
  assert.match(a.s.text, /⏎ review/, 'Esc in the cards goes back to the list');
  a.s.key(ch('p'));
  const report = a.s.text;
  assert.match(report, /Report r3-attention/);
  assert.match(report, /Not landed/);
  assert.doesNotMatch(report, /dulger (resume|retry)|git merge/, 'the CLI "Next" section is left out');
  a.s.key(key('escape'));
  await a.quit();
});

test('filter by goal, status or id with /; Esc clears it', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  readyRun(root, 'r5-ready');
  unstartedRun(root, 'r2-unstarted');
  const a = runsApp(root);
  a.s.type('/attention');
  assert.equal(a.ctx ? true : false, true);
  assert.match(a.s.text, /Add a health endpoint/);
  assert.doesNotMatch(a.s.text, /Add a feature file\s/);
  assert.match(a.s.text, /1\/3/);
  a.s.key(key('escape'));
  assert.match(a.s.text, /Add a feature file/);
  a.s.type('/r2-un');
  a.s.key(key('enter'));
  assert.match(a.s.text, /╭─ r2-unstarted/);
  a.s.key(ch('q'));
  assert.match(a.s.text, /╭─ r2-unstarted/, 'once the filter is done, letters are shortcuts again (q quits)');
  await a.done;
});

test('navigate with { run } selects that run and shows it; unknown runs are ignored', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  readyRun(root, 'r5-ready');
  const a = runsApp(root, { rows: 24, cols: 80 });
  a.ctx.navigate('runs', { run: 'r3-attention' });
  assert.match(a.s.text, /╭─ r3-attention/);
  assert.match(a.s.text, /⏎ card/, 'the run is shown with its cards focused');
  a.ctx.navigate('runs', { run: 'nope' });
  assert.match(a.s.text, /Runs/);
  a.ctx.navigate('runs', { run: 42 });
  assertFrame(a.s.lines, 24, 80);
  await a.quit();
});

test('narrow: one pane at a time; Tab shows the run, Tab or Esc goes back to the list', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  readyRun(root, 'r5-ready');
  const a = runsApp(root, { rows: 24, cols: 80 });
  assert.doesNotMatch(a.s.text, /╭─ r5-ready/);
  assert.match(a.s.text, /tab run/);
  a.s.key(key('tab'));
  assert.match(a.s.text, /╭─ r5-ready/);
  assert.doesNotMatch(a.s.text, /Add a health endpoint/);
  a.s.key(key('escape'));
  assert.match(a.s.text, /Add a health endpoint/);
  a.s.key(key('tab'));
  a.s.key(key('tab'));
  assert.match(a.s.text, /Add a health endpoint/);
  await a.quit();
});

test('every size fits, from 1×1 up, with the list, the cards or a filter focused', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  unreadableRun(root, 'r4-broken');
  readyRun(root, 'r5-ready');
  const a = runsApp(root);
  for (const step of ['list', 'cards', 'unreadable', 'filter']) {
    if (step === 'cards') { a.s.key(key('down')); a.s.key(key('down')); a.s.key(key('tab')); }
    if (step === 'unreadable') { a.s.key(key('tab')); a.s.key(key('up')); }
    if (step === 'filter') a.s.type('/zz');
    for (const [rows, cols] of SIZES) { a.s.resize(rows, cols); assertFrame(a.s.lines, rows, cols, step); }
    a.s.resize(40, 120);
  }
  await a.quit();
});

test('the unreadable run says what is wrong and offers nothing that needs its board', async (t) => {
  const root = repo(t);
  unreadableRun(root, 'r4-broken');
  const a = runsApp(root);
  assert.match(a.s.text, /Status\s+! unreadable/);
  assert.match(a.s.text, /Error\s+.*JSON/, 'the error itself');
  assert.match(a.s.text, /\.dulger\/runs\/r4-broken\/board\.json/);
  assert.doesNotMatch(a.s.text, /⏎ review/, 'nothing that needs the board is offered');
  a.s.key(ch('r'));
  assert.match(a.s.text, /Board unreadable/);
  assert.deepEqual(a.calls, []);
  await a.quit();
});

test('clean leftovers confirms first, saying what goes, then shows what it removed', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5-ready');
  git.createBranch(root, 'dulger-wip/r5-ready/c1', 'HEAD');
  const a = runsApp(root);
  a.s.key(ch('c'));
  assert.match(a.s.text, /Clean leftovers/);
  assert.match(a.s.text, /Branches\s+1 dulger-wip\/…/, 'what goes, as rows');
  assert.match(a.s.text, /shared by every local/, 'the confirmation says the worktree folders are shared by clones');
  assert.match(a.s.text, /is lost/, 'and what is lost with them');
  a.s.key(key('enter'));
  await a.settle();
  assert.equal(git.branchExists(root, 'dulger-wip/r5-ready/c1'), true, 'the safe choice is focused first');
  a.s.key(ch('c'));
  a.s.key(key('right'));
  a.s.key(key('enter'));
  await a.settle();
  assert.equal(git.branchExists(root, 'dulger-wip/r5-ready/c1'), false);
  assert.match(a.s.text, /deleted branch dulger-wip\/r5-ready\/c1/);
  assert.match(a.s.text, /1 leftover removed/);
  a.s.key(key('escape'));
  a.s.key(ch('c'));
  assert.match(a.s.text, /Nothing to clean/);
  await a.quit();
});

test('a real run from the fake harness shows as finished, with no verify commands stated', async (t) => {
  const root = repo(t);
  const id = await realRun(root, t);
  const a = runsApp(root);
  assert.match(a.s.text, new RegExp(`╭─ ${id}`));
  assert.match(a.s.text, /✓ finished/);
  assert.match(a.s.text, /Verified\s+! none/, 'nothing checked the result');
  assert.equal(store.loadBoard(root, id).cards.length, 1);
  await a.quit();
});

test('mouse: a click selects a run, a second opens its review; the wheel moves the cards', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  readyRun(root, 'r5-ready');
  const a = runsApp(root);
  const row = rowOf(a.s.text, 'Add a health');
  a.s.mouse(press(row, 6));
  assert.match(a.s.text, /╭─ r3-attention/);
  a.s.mouse(press(row, 6));
  assert.equal(a.calls.at(-1), 'review r3-attention');
  a.s.key(key('escape'));
  const cards = rowOf(a.s.text, 'Parse the config');
  a.s.mouse(press(cards, 80));
  assert.match(a.s.text, /⏎ card/, 'a click on a card focuses the cards');
  a.s.mouse(wheel('down', cards, 80));
  a.s.key(key('enter'));
  assert.match(a.s.text, /c2 Add the health endpoint/, 'the wheel moved to c2');
  await a.quit();
});

test('palette and help list every action; choosing an off one says why', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  const a = runsApp(root);
  a.s.key(key('ctrl', 'p'));
  a.s.type('merge');
  assert.match(a.s.text, /│ . Merge dulger\/r3-attention → main/, 'no page prefix');
  // An action that is off is listed (dimmed) but never selected first; choosing it says why and runs nothing.
  a.s.key(key('up'));
  a.s.key(key('enter'));
  await a.settle();
  assert.match(a.s.text, /Merge: verify failed/);
  assert.deepEqual(a.calls, [], 'choosing it runs nothing');
  a.s.key(ch('?'));
  const said = help(a.s.text);
  assert.match(said, /Selected run/);
  assert.match(said, /retry card/);
  assert.match(said, /clean leftover worktrees/);
  assert.match(said, /About/);
  await a.quit();
});

test('a run another dulger process is working on reads as running, and nothing that changes it starts', async (t) => {
  const root = repo(t);
  const b = attentionRun(root, 'r3-attention');
  b.cards[1]!.status = 'in_progress';
  b.checkpoint = { phase: 'running', at: new Date().toISOString() };
  store.saveBoard(root, b);
  const lock = join(store.runDir(root, b.runId), 'execution.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'x' }));
  const a = runsApp(root);
  assert.match(a.s.text, /●\s+Add a health[^\n]*\s1\/3/, 'running: its own glyph, no word in the list');
  assert.doesNotMatch(a.s.text.split('\n')[rowOf(a.s.text, 'Add a health')]!.slice(0, 60), /running/);
  assert.match(pane(a.s.text), new RegExp(`Status ● running · pid ${process.ppid}`));
  assert.doesNotMatch(a.s.text, / r resume | t retry /, 'nothing that changes it is offered');
  a.s.key(ch('r'));
  assert.match(a.s.text, new RegExp(`Resume: in use: pid ${process.ppid}`), 'pressed anyway, it says why');
  a.s.key(ch('t'));
  await a.settle();
  assert.deepEqual(a.calls, []);
  rmSync(lock, { recursive: true });
  a.ctx.navigate('runs');
  assert.match(pane(a.s.text), /Status ◌ interrupted/, 'without a live owner it was interrupted');
  assert.match(a.s.text, /◌\s+Add a health/, 'its own glyph in the list');
  await a.quit();
});

test('every glyph set draws every state, and every size still fits', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  unstartedRun(root, 'r2-unstarted');
  unreadableRun(root, 'r4-broken');
  readyRun(root, 'r5-ready');
  const stopped = missingBranchRun(root, 'r1-stopped');
  stopped.halted = { reason: 'usage limit', at: new Date().toISOString() };
  store.saveBoard(root, stopped);
  const paused = unstartedRun(root, 'r0-paused');
  paused.paused = true;
  store.saveBoard(root, paused);
  // Paused only while a dulger process holds the run (one killed while paused reads as interrupted).
  const lock = join(store.runDir(root, 'r0-paused'), 'execution.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'x' }));
  for (const icons of ['ascii', 'nerd'] as const) {
    const a = runsApp(root, { rows: 40, cols: 160 }, icons);
    const text = a.s.text;
    assert.match(text, /finished/, `${icons}: the selected run's state is spelled out in its pane`);
    if (icons === 'ascii') {
      // Each state is told apart by its glyph alone, without colour too.
      assert.match(text, /\* v\s+Add a feature file/, 'ascii: the pointer and the check are plain characters');
      assert.match(text, /x\s+Add a health/);
      assert.match(text, /\|\|\s+Refactor the scheduler/, 'paused');
      assert.match(text, />\s+Refactor the scheduler/, 'ready to resume');
      assert.match(text, /#\s+Write the migration guide/, 'stopped');
      assert.match(text, /!\s+r4-broken/, 'unreadable');
    }
    for (const step of ['list', 'cards']) {
      if (step === 'cards') a.s.key(key('tab'));
      for (const [rows, cols] of SIZES) { a.s.resize(rows, cols); assertFrame(a.s.lines, rows, cols, `${icons} ${step}`); }
      a.s.resize(40, 160);
    }
    await a.quit();
  }
});

test('a result that changed after it was verified is stale: merging waits, and resume offers to verify it again', async (t) => {
  const root = repo(t);
  const b = readyRun(root, 'r5-ready');
  land(root, b, { 'late.txt': 'after verification\n' });
  const a = runsApp(root);
  assert.match(pane(a.s.text), /Verified ! stale/);
  assert.match(a.s.text, /⏎ review {2}r resume/);
  a.s.key(key('f1'));
  assert.match(help(a.s.text), /r resume: verifies the current result again \(asks first\)/);
  assert.match(help(a.s.text), /m merge \(off: verify stale\)/);
  a.s.key(key('escape'));
  a.s.key(ch('r'));
  await a.settle();
  assert.deepEqual(a.calls, ['resume r5-ready']);
  await a.quit();
});

/** Hold a run's execution lock as a live dulger process would. */
function holdLock(root: string, runId: string): string {
  const lock = join(store.runDir(root, runId), 'execution.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'x' }));
  return lock;
}

test('a run held by another process is read again each second while it is on screen', async (t) => {
  const root = repo(t);
  const b = attentionRun(root, 'r3-attention');
  b.cards[1]!.status = 'in_progress';
  b.checkpoint = { phase: 'running', at: new Date().toISOString() };
  store.saveBoard(root, b);
  const lock = holdLock(root, b.runId);
  const a = runsApp(root);
  assert.match(pane(a.s.text), /Status ● running · pid/);
  rmSync(lock, { recursive: true });
  await new Promise((r) => setTimeout(r, 1300));
  assert.match(pane(a.s.text), /Status ◌ interrupted/, 'it updated without leaving the tab');
  await a.quit();
});

test('clean leftovers names a run in use and leaves it alone, and says a retry of failed cards starts over', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3-attention');
  readyRun(root, 'r5-busy');
  holdLock(root, 'r5-busy');
  git.createBranch(root, 'dulger-wip/r5-busy/c1', 'HEAD');
  git.createBranch(root, 'dulger-wip/r3-attention/c2', 'HEAD');
  mkdirSync(join(worktreesDir(root), 'r3-attention', 'c2'), { recursive: true });
  const a = runsApp(root);
  a.s.key(ch('c'));
  await a.settle();
  const text = a.s.text;
  assert.match(text, /Left alone\s+r5-busy: /);
  assert.match(text, /Branches\s+1 dulger-wip/, 'the busy run is left out of the count');
  assert.match(text, /Retry worktrees\s+r3-attention/, 'the runs whose failed cards lose the worktree a retry would go on in');
  a.s.key(key('right'));
  a.s.key(key('enter'));
  await a.settle();
  assert.equal(git.branchExists(root, 'dulger-wip/r5-busy/c1'), true, 'the busy run is left alone');
  assert.equal(git.branchExists(root, 'dulger-wip/r3-attention/c2'), false, 'the rest is cleaned');
  await a.quit();
});

test('the filter matches words, puts the goal typed exactly first, and the selected goal is readable whole', async (t) => {
  const root = repo(t);
  for (const [id, goal] of [['w1', 'Build the board walkthrough'], ['w2', 'Build the board walkthrough two'], ['w3', 'Build the board walkthrough three'], ['w4', 'Build the board walkthrough four']] as const) {
    const b = createBoard(root, goal, id);
    b.cards = store.cardsFromPlan(plan());
    store.saveBoard(root, b);
  }
  const a = runsApp(root);
  a.s.key(ch('/'));
  a.s.type('walkthrough two');
  assert.match(a.s.text, /1\/4/, 'every word must appear: only "two" matches');
  a.s.key(key('enter'));
  assert.match(pane(a.s.text), /Build the board walkthrough two/, 'its goal is readable whole in its pane');
  a.s.key(ch('v'));
  assert.equal(a.calls.at(-1), 'review w2', 'the run that matched is the one opened');
  a.s.key(key('escape'));
  a.s.key(ch('/'));
  for (let i = 0; i < 'walkthrough two'.length; i++) a.s.key(key('backspace'));
  a.s.type('Build the board walkthrough');
  assert.match(a.s.text, /╭─ w1 /, 'the goal typed exactly comes first');
  await a.quit();
});

test('card counts leave out cards a replan replaced, and mention them apart', async (t) => {
  const root = repo(t);
  const b = attentionRun(root, 'r3-attention');
  b.cards[2]!.status = 'replaced';
  store.saveBoard(root, b);
  const a = runsApp(root);
  assert.match(a.s.text, /1\/2/, 'the list counts 2 cards, not 3');
  assert.match(pane(a.s.text), /Cards 1\/2 done · 1 failed · 1 replaced/);
  assert.match(pane(a.s.text), /Cards 1\/2 › ✓ c1/, 'the cards panel too, with no header');
  await a.quit();
});

test('? says what the plan editor changes', async (t) => {
  const root = repo(t);
  unstartedRun(root, 'r2-unstarted');
  const a = runsApp(root);
  assert.match(a.s.text, /e edit/);
  a.s.key(key('f1'));
  assert.match(help(a.s.text), /e edit plan: 3 unstarted cards: titles, descriptions, criteria, dependencies, verify commands, worker/);
  await a.quit();
});

test('Verified does not say "none configured" when a card had verify commands', async (t) => {
  const root = repo(t);
  const b = readyRun(root, 'r6');
  b.finalVerification = { ref: b.finalVerification!.ref, results: [] };
  b.cards[1]!.status = 'failed';
  b.cards[1]!.verification = [{ command: 'node -e "process.exit(3)"', ok: false, exitCode: 3, durationMs: 10, output: 'boom' }];
  store.saveBoard(root, b);
  const a = runsApp(root);
  assert.match(pane(a.s.text), /Verified ! cards only · card failed/);
  assert.doesNotMatch(pane(a.s.text), /Verified ! none/);
  await a.quit();
});
