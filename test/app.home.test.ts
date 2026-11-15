// The Home tab (src/app/pages/home.ts) driven through the real shell against a temporary repository:
// layout at every size and in every glyph set, the Goal box (focus, modes, multi-line, history, the
// short-goal question), the Roles box with its blockers and fixes, the Runs box and resume, the
// palette's commands, and `?`, where what the boxes mean is said.
// Starting runs is the launcher's (test/app.run.test.ts); here it is a recording fake.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { createApp } from '../src/app/shell.ts';
import { createHomePage } from '../src/app/pages/home.ts';
import { appCommands } from '../src/app/global.ts';
import type { GoalMode, LaunchOutcome, Launcher } from '../src/app/run.ts';
import { sessionConfig } from '../src/replModels.ts';
import { findSetting } from '../src/settings.ts';
import { history } from '../src/ui/prompt.ts';
import type { IconSet } from '../src/tui/theme.ts';
import type { NavParams, PageFactory } from '../src/app/types.ts';
import type { Session } from '../src/repl.ts';
import type { CardStatus } from '../src/types.ts';
import { SIZES, assertFrame, ch, fakeScreens, key, press, withColour } from './kit.helpers.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-app-home-data-'));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-app-home-home-'));

function repo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

function addRun(root: string, goal: string, statuses: CardStatus[], minutesAgo = 0): string {
  const b = createBoard(root, goal);
  b.createdAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  b.cards = store.cardsFromPlan({ cards: statuses.map((_, i) => ({ id: `c${i + 1}`, title: `Card ${i + 1}`, description: 'd', acceptanceCriteria: [], dependsOn: [], verify: [], tasks: [{ id: 't1', title: 't', instructions: 'i' }] })) });
  statuses.forEach((s, i) => { b.cards[i]!.status = s; });
  if (statuses.every((s) => s === 'done')) b.docs = { status: 'done' };
  b.costUsd = 0.42;
  store.saveBoard(root, b);
  return b.runId;
}

interface Call { fn: string; args: unknown[] }

function setup(t: TestContext, o: { root?: string; session?: Partial<Session>; rows?: number; cols?: number; icons?: IconSet; outcome?: LaunchOutcome | Promise<LaunchOutcome> } = {}) {
  const root = o.root ?? repo(t);
  const session: Session = { overrides: { harness: 'fake' }, yes: false, quiet: false, allowDirty: false, ...o.session };
  const visits: Array<{ page: string; params?: NavParams }> = [];
  const calls: Call[] = [];
  const launcher: Launcher = {
    goal: async (_ctx, goal: string, mode?: GoalMode) => { calls.push({ fn: 'goal', args: [goal, mode] }); return o.outcome ?? { kind: 'finished', runId: 'r', landed: 1 }; },
    resume: async (_ctx, runId, opts) => { calls.push({ fn: 'resume', args: [runId, opts] }); return { kind: 'stopped', runId }; },
    retry: async (_ctx, runId, cardId) => { calls.push({ fn: 'retry', args: [runId, cardId] }); return { kind: 'blocked' }; },
  };
  const prompts: Array<{ nested: boolean; closed: boolean }> = [];
  const screens = fakeScreens(o.rows ?? 40, o.cols ?? 120);
  const other = (id: string): PageFactory => () => ({
    id, title: id[0]!.toUpperCase() + id.slice(1),
    activate: (params) => { visits.push(params ? { page: id, params } : { page: id }); },
    render: () => ({ lines: [`${id} page`] }), onKey: () => false, hints: () => [],
  });
  const home: PageFactory = (ctx) => createHomePage(ctx, { launcher });
  const app = createApp({
    repoRoot: root, session, version: 't', config: () => sessionConfig(root, session), icons: o.icons ?? 'unicode', branch: () => 'main',
    pages: [home, ...['runs', 'settings', 'models', 'providers', 'memory', 'doctor'].map(other)], openScreen: screens.factory,
    // The app-wide entries the real app adds, with a line prompt that only records how it ran.
    commands: (ctx) => appCommands(ctx, { linePrompt: async (_root, _session, _version, opts) => { prompts.push({ nested: opts.nested, closed: screens.made.at(-1)!.closed > 0 }); } }),
  });
  const done = app.run();
  t.after(async () => { app.quit(); await done; });
  return {
    root, session, app, screens, visits, calls, prompts,
    get s() { return screens.current; },
    get text() { return screens.current.text; },
    get flat() { return screens.current.text.replace(/[▌│╭╮╰╯]/g, ' ').replace(/\s+/g, ' '); },
    /** The help overlay's text alone, as one line of words (the page behind it left out). */
    get help() {
      const lines = screens.current.text.split('\n');
      const top = lines.findIndex((l) => l.includes('─ Help '));
      if (top < 0) return '';
      const from = lines[top]!.indexOf('╭');
      const to = lines[top]!.indexOf('╮', from);
      const out: string[] = [];
      for (const l of lines.slice(top + 1)) { if ([...l][from] === '╰') break; out.push([...l].slice(from + 1, to).join('')); }
      return out.join(' ').replace(/[┃│]/g, ' ').replace(/\s+/g, ' ').trim();
    },
    /** Re-read the repository, as coming back to the tab does. */
    reload() { app.ctx.navigate('runs'); app.ctx.navigate('home'); },
  };
}

const tick = () => sleep(5);

test('Home at every size and in every glyph set: exactly the frame, nothing throws', (t) => {
  const root = repo(t);
  addRun(root, 'Add a health check endpoint with a test 日本語', ['done', 'done'], 30);
  addRun(root, 'Half way there', ['done', 'failed', 'backlog'], 5);
  writeFileSync(join(root, 'README.md'), 'dirty\n');
  for (const icons of ['unicode', 'ascii', 'nerd'] as const) {
    const h = setup(t, { root, icons });
    for (const [rows, cols] of SIZES) {
      h.s.resize(rows, cols);
      withColour(() => h.app.paint());
      assertFrame(h.s.lines, rows, cols, `home ${icons}`);
      for (const k of ['tab', 'tab', 'tab']) { h.s.key(key(k)); assertFrame(h.s.lines, rows, cols, `home ${icons} focus`); }
    }
  }
});

test('a short screen never hides the focused panel', (t) => {
  const root = repo(t);
  addRun(root, 'Squeezed out', ['done']);
  const h = setup(t, { root, rows: 12, cols: 44 });
  h.s.key(key('escape'));
  assert.match(h.text, /╭─ (❯ )?Runs/, 'focus went to the runs, so they show');
  assert.match(h.text, /Squeezed out/);
  h.s.resize(8, 30);
  assert.match(h.text, /Squeezed out/);
  h.s.key(key('tab'));
  assert.match(h.text, /What should the agents/, 'the goal box');
});

test('120×40: the three boxes hold values only: the goal box, the runs, the roles and the settings that change a run', (t) => {
  const h = setup(t);
  const text = h.text;
  assert.match(text, /╭─ ❯ Goal/);
  assert.match(text, /\[Run\] Plan /, 'the mode switch in the border, Run on');
  assert.match(text, /\(What should the agents build\?\)/, 'a short placeholder');
  assert.match(text, /╭─ Roles/);
  assert.match(text, /╭─ Runs/);
  // `--harness fake` is a session change: each role is marked, and no model is shown (the backend's default).
  for (const role of ['Planner', 'Worker', 'Reviewer', 'Docs', 'Reporter']) assert.match(text, new RegExp(`${role}\\s+fake ✎`));
  assert.doesNotMatch(text, /default model/);
  // Named as Settings names them, label then value.
  assert.match(text, new RegExp(`${findSetting('concurrency')!.label}\\s+3`));
  assert.match(text, new RegExp(`${findSetting('attempts')!.label}\\s+2`));
  assert.match(text, new RegExp(`${findSetting('sandbox')!.label}\\s+\\w+`));
  assert.doesNotMatch(text, new RegExp(findSetting('budget')!.label), 'no budget, no row');
  assert.doesNotMatch(text, new RegExp(findSetting('yes')!.label), 'plan approval on: no row');
  assert.match(text, /No runs yet/);
  // No sentences: none of what used to explain the page.
  for (const gone of [/How a run goes/, /Readiness checks/, /changed this session/, /What will run/, /Enter starts the run/, /wait for your go/, /unfinished ·/]) assert.doesNotMatch(text, gone);
  assert.ok(h.s.cursor, 'the composer has the cursor on arrival');
});

test('80×24 keeps the roles beside the goal and the runs', (t) => {
  const root = repo(t);
  addRun(root, 'An older goal', ['done'], 60);
  const h = setup(t, { root, rows: 24, cols: 80 });
  const text = h.text;
  assert.match(text, /Goal/);
  assert.match(text, /Planner\s+fake/);
  assert.match(text, /Reporter\s+fake/);
  assert.match(text, /✓\s+An older goal\s+1\/1\s+\$0\.42\s+1h/, 'glyph, goal, cards, spend and age');
  assert.doesNotMatch(text, /finished/, 'the glyph says it');
});

test('the composer has focus and captures text; Esc leaves it so digits switch tabs again', (t) => {
  const h = setup(t);
  h.s.type('2 [q?');
  assert.match(h.text, /\[1 Home\]/, 'still on Home');
  assert.match(h.text, /│ 2 \[q\?/, 'typed into the goal');
  h.s.key(key('escape'));
  h.s.type('2');
  assert.match(h.text, /\[2 Runs\]/);
});

test('Enter on an empty goal says what is missing; Enter on a goal starts it; Alt-Enter adds a line', async (t) => {
  const h = setup(t);
  h.s.key(key('enter'));
  await tick();
  assert.deepEqual(h.calls, []);
  assert.match(h.flat, /Type a goal/, 'it says what is missing');
  h.s.type('Add a health check');
  h.s.key(key('alt-enter'));
  h.s.type('with a test');
  assert.match(h.text, /│ Add a health check\s+│/);
  assert.match(h.text, /│ with a test\s+│/);
  h.s.key(key('enter'));
  await tick();
  assert.deepEqual(h.calls, [{ fn: 'goal', args: ['Add a health check\nwith a test', 'run'] }]);
  assert.match(h.text, /What should the agents build\?/, 'the composer is empty again');
});

test('a goal of fewer than three words is confirmed first; No keeps it for editing', async (t) => {
  const h = setup(t);
  h.s.type('fix it');
  h.s.key(key('enter'));
  await tick();
  assert.match(h.text, /Short goal/);
  assert.match(h.flat, /Run "fix it"/);
  assert.match(h.flat, /Edit\W+Run/, 'Edit keeps it in the box');
  h.s.type('n');
  await tick();
  assert.deepEqual(h.calls, []);
  assert.match(h.text, /│ fix it\s+│/);
  h.s.key(key('enter'));
  await tick();
  h.s.type('y');
  await tick();
  assert.deepEqual(h.calls, [{ fn: 'goal', args: ['fix it', 'run'] }]);
});

test('Ctrl-T switches to Plan and back; the mode goes with the goal; a click on a chip picks it', async (t) => {
  const h = setup(t);
  h.s.key(key('ctrl', 't'));
  assert.match(h.text, /Run \[Plan\]/);
  assert.match(h.text, /⏎ plan/, 'the footer says what Enter does now');
  h.s.key(key('f1'));
  assert.match(h.help, /^Goal · Plan Plan: talk the plan through with the planner before anything is built/, '? says what the mode does');
  h.s.key(key('escape'));
  h.s.type('Talk this one through');
  h.s.key(key('enter'));
  await tick();
  assert.deepEqual(h.calls.at(-1), { fn: 'goal', args: ['Talk this one through', 'order'] });
  // The chips sit in the composer's top border (row 2 of the screen): click Run.
  const row = h.text.split('\n')[2]!;
  h.s.mouse(press(2, row.indexOf('Run ')));
  assert.match(h.text, /\[Run\] Plan /);
  h.s.mouse(press(2, h.text.split('\n')[2]!.indexOf('Plan')));
  assert.match(h.text, /Run \[Plan\]/);
});

test('with plan approval off, the Roles box says so', (t) => {
  const h = setup(t, { session: { yes: true } });
  assert.match(h.text, new RegExp(`${findSetting('yes')!.label}\\s+on`));
  h.s.key(key('f1'));
  assert.match(h.help, /unless Skip plan approval is on/);
});

test('a goal that never ran comes back; ↑ and ↓ walk earlier goals', async (t) => {
  const h = setup(t, { outcome: { kind: 'blocked' } });
  history.unshift('/status', 'y', 'An earlier goal from the prompt');
  h.s.type('Blocked by a dirty tree');
  h.s.key(key('enter'));
  await tick();
  assert.match(h.text, /│ Blocked by a dirty tree\s+│/, 'restored for editing');
  for (let i = 0; i < 30; i++) h.s.key(key('ctrl', 'u'));
  assert.match(h.text, /What should the agents build\?/);
  h.s.key(key('up'));
  assert.match(h.text, /│ An earlier goal from the prompt\s+│/, 'commands and one-word answers are skipped');
  h.s.key(key('down'));
  assert.match(h.text, /What should the agents build\?/, 'back to what was being typed');
});

test('Tab and Shift-Tab move between the panels; the footer follows', (t) => {
  const root = repo(t);
  addRun(root, 'A finished goal', ['done']);
  const h = setup(t, { root });
  assert.match(h.text, /⏎ start {2}\^t plan {2}tab next {2}F1 help/, 'while the goal box has the keyboard ? is typed into it, so the bar names F1');
  h.s.key(key('tab'));
  assert.match(h.text, /⏎ change {2}↑↓ move {2}tab next/);
  h.s.key(key('tab'));
  assert.match(h.text, /⏎ open {2}n goal {2}tab next/);
  h.s.key(key('tab'));
  assert.match(h.text, /⏎ start/);
  h.s.key(key('shift-tab'));
  assert.match(h.text, /⏎ open/);
  h.s.type('n');
  assert.match(h.text, /⏎ start/, 'n goes back to the goal');
});

test('Roles: each row opens the page that changes it, blockers first as short state lines with their fix', (t) => {
  const root = repo(t);
  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify({ roles: { worker: { harness: 'ollama' } } }));
  git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'config']);
  writeFileSync(join(root, 'README.md'), 'dirty\n');
  const h = setup(t, { root });
  assert.match(h.text, /! dirty tree/);
  assert.match(h.text, /! no model: worker/);
  assert.match(h.text, /Worker\s+ollama no model/);
  assert.match(h.text, /Home !2/, 'counted on the tab, glyph and number');
  assert.doesNotMatch(h.text, /Fix before running|to fix|Settings ›/);
  h.s.key(key('tab'));
  assert.match(h.text, /⏎ fix/);
  h.s.key(key('f1'));
  assert.match(h.help, /^dirty tree The working tree has uncommitted changes/, '? explains the selected row first');
  h.s.key(key('escape'));
  h.s.key(key('enter'));
  assert.deepEqual(h.visits.at(-1), { page: 'settings', params: { key: 'dirty' } });
  h.app.ctx.navigate('home');
  h.s.key(key('tab'));
  h.s.key(key('home'));
  h.s.key(key('down'));
  h.s.key(key('enter'));
  assert.deepEqual(h.visits.at(-1), { page: 'models', params: { role: 'worker' } });
  h.app.ctx.navigate('home');
  h.s.key(key('tab'));
  h.s.key(key('home'));
  for (let i = 0; i < 3; i++) h.s.key(key('down'));
  h.s.key(key('enter'));
  assert.deepEqual(h.visits.at(-1), { page: 'models', params: { role: 'worker' } }, 'the worker role row');
  h.app.ctx.navigate('home');
  h.s.key(key('tab'));
  h.s.key(key('end'));
  h.s.key(key('enter'));
  assert.deepEqual(h.visits.at(-1), { page: 'settings', params: { key: 'sandbox' } }, 'the last row');
  h.app.ctx.navigate('home');
  h.s.key(key('tab'));
  h.s.key(key('end'));
  h.s.key(key('up'));
  h.s.key(key('left'));
  h.s.key(key('right'));
  h.s.key(key('enter'));
  assert.deepEqual(h.visits.at(-1), { page: 'settings', params: { key: 'attempts' } }, 'one row up; ← and → move by a row too');
});

test('a disabled role opens the setting that turns it on', (t) => {
  const h = setup(t, { session: { overrides: { harness: 'fake', docs: false } } });
  assert.match(h.text, /Docs\s+off/);
  assert.doesNotMatch(h.text, new RegExp(findSetting('docs')!.label), 'the role row says it; no setting row repeats it');
  h.s.key(key('tab'));
  for (let i = 0; i < 3; i++) h.s.key(key('down'));
  h.s.key(key('enter'));
  assert.deepEqual(h.visits.at(-1), { page: 'settings', params: { key: 'docs' } });
});

test('recent runs: newest first with status, cards and spend; Enter opens it on Runs; r resumes an unfinished one', async (t) => {
  const root = repo(t);
  const old = addRun(root, 'An old finished one', ['done', 'done'], 90);
  const half = addRun(root, 'A newer unfinished', ['done', 'backlog'], 2);
  const h = setup(t, { root });
  const text = h.text;
  assert.ok(text.indexOf('A newer unfinished') < text.indexOf('An old finished one'), 'newest first');
  assert.match(text, /▶\s+A newer unfinished\s+1\/2\s+\$0\.42\s+2m/);
  assert.match(text, /✓\s+An old finished one\s+2\/2\s+\$0\.42\s+1h/);
  assert.match(text, /─ ▶1 ─/, 'the unfinished ones counted in the border, glyph and number');
  assert.doesNotMatch(text, /unfinished( ·|$)|runs? (is|are) unfinished/m, 'no words for it');
  // Every box as tall as its rows: the goal one row, the runs two, the roles its rows and no more.
  const lines = text.split('\n');
  const top = lines.findIndex((l) => l.startsWith('╭─ ❯ Goal'));
  assert.ok(lines[top + 2]!.startsWith('╰'), 'the goal box: one row');
  assert.ok(lines[top + 3]!.startsWith('╭─ Runs'), 'the runs box right under it');
  assert.ok(lines[top + 6]!.startsWith('╰'), 'the runs box: two rows for two runs');
  const roles = [...lines[top]!].indexOf('╭', 1);
  assert.equal([...lines[top + 10]!][roles], '╰', 'the roles box: 5 roles, a blank, 3 settings');
  assert.ok(lines[top + 11]!.trim() === '', 'and nothing under the boxes');
  h.s.key(key('escape'));
  assert.match(h.text, / r resume /, 'the newest run is unfinished: r is offered in the footer');
  h.s.key(key('enter'));
  assert.deepEqual(h.visits.at(-1), { page: 'runs', params: { run: half } });
  h.app.ctx.navigate('home');
  h.s.key(key('escape'));
  h.s.key(key('down'));
  assert.doesNotMatch(h.text, / r resume /, 'not for a finished one');
  h.s.key(key('enter'));
  assert.deepEqual(h.visits.at(-1), { page: 'runs', params: { run: old } });
  h.app.ctx.navigate('home');
  h.s.key(key('escape'));
  h.s.type('r');
  await tick();
  assert.deepEqual(h.calls, [{ fn: 'resume', args: [half, undefined] }], 'the launcher asks first, as from Runs and Review');
});

test('runs that came back changed are read again when Home is shown', (t) => {
  const h = setup(t);
  assert.match(h.text, /No runs yet/);
  addRun(h.root, 'Made while away', ['done']);
  h.reload();
  assert.match(h.text, /Made while away/);
});

test('the palette offers every action, and the line prompt runs nested with the terminal handed over', async (t) => {
  const root = repo(t);
  addRun(root, 'Unfinished business', ['backlog']);
  const h = setup(t, { root });
  h.s.key(key('ctrl', 'p'));
  const palette = h.text;
  for (const title of ['New goal', 'Plan a goal', 'Switch to Plan', 'Resume run']) assert.match(palette, new RegExp(`│ . ${title} `));
  assert.doesNotMatch(palette, /Home: /, 'the page\'s own commands carry no prefix');
  h.s.key(key('escape'));
  for (const title of ['Open the line prompt', 'Check readiness', 'Save settings']) {
    h.s.key(key('ctrl', 'p'));
    h.s.type(title.toLowerCase());
    assert.match(h.text, new RegExp(`App: ${title}`), 'app-wide, from every tab');
    h.s.key(key('escape'));
    h.s.key(key('escape'));
  }
  h.s.key(key('ctrl', 'p'));
  h.s.type('new goal');
  assert.doesNotMatch(h.text, /App: New goal/, 'offered once, as Home\'s own');
  h.s.key(key('ctrl', 'u'));
  h.s.type('line prompt');
  h.s.key(key('enter'));
  await tick();
  assert.deepEqual(h.prompts, [{ nested: true, closed: true }], 'the app closed its screen before the prompt ran');
  assert.match(h.flat, /Back from the line prompt\./);

  h.s.key(key('ctrl', 'p'));
  h.s.type('plan a goal');
  h.s.key(key('enter'));
  await tick();
  assert.match(h.text, /Run \[Plan\]/);

  h.s.key(key('ctrl', 'p'));
  h.s.type('resume run');
  h.s.key(key('enter'));
  await tick();
  assert.equal(h.calls.at(-1)!.fn, 'resume');
});

test('help leads with what has focus, then the keys of every box, then what the boxes mean', (t) => {
  const root = repo(t);
  addRun(root, 'Selected in the runs', ['done', 'backlog'], 3);
  const h = setup(t, { root });
  h.s.key(key('f1'));
  let text = h.text;
  for (const group of ['Goal · Run', 'Goal', 'Roles', 'Runs', 'Home', 'About', 'Everywhere']) assert.match(text, new RegExp(group));
  assert.match(h.help, /^Goal · Run Run: the planner splits the goal into cards and waits at the plan for your go/, 'what used to sit on the page, first');
  assert.match(text, /Run or Plan/);
  assert.match(text, /resume unfinished/);
  assert.match(h.help, /✎ marks what this session changed/);
  h.s.key(key('escape'));
  h.s.key(key('escape'));
  h.s.key(key('f1'));
  assert.match(h.help, /^Selected in the runs \S+: ready to resume, 1 of 2 cards done\. Enter opens it on Runs\. r resumes it\./, 'the selected run first');
  h.s.key(key('escape'));
  h.s.key(key('tab'));
  h.s.key(key('tab'));
  h.s.key(key('down'));
  h.s.key(key('f1'));
  assert.match(h.help, /^Worker fake picks its own default model\. Enter changes it on Models\. Changed this session\./, 'the selected row first');
});

test('a click focuses a panel; a second click on a row opens it', (t) => {
  const root = repo(t);
  const id = addRun(root, 'Click me', ['done']);
  const h = setup(t, { root });
  const lines = h.text.split('\n');
  const at = lines.findIndex((l) => l.includes('Click me'));
  h.s.mouse(press(at, lines[at]!.indexOf('Click me')));
  assert.match(h.text, /⏎ open/);
  h.s.mouse(press(at, lines[at]!.indexOf('Click me')));
  assert.deepEqual(h.visits.at(-1), { page: 'runs', params: { run: id } });
  h.app.ctx.navigate('home');
  const again = h.text.split('\n');
  const reviewer = again.findIndex((l) => l.includes('Reviewer'));
  h.s.mouse(press(reviewer, again[reviewer]!.indexOf('Reviewer')));
  h.s.mouse(press(reviewer, again[reviewer]!.indexOf('Reviewer')));
  assert.deepEqual(h.visits.at(-1), { page: 'models', params: { role: 'checker' } });
});

test('an unreadable config or board is shown, never thrown', (t) => {
  const root = repo(t);
  addRun(root, 'Fine', ['done']);
  const broken = createBoard(root, 'broken');
  writeFileSync(store.boardPath(root, broken.runId), '{ nope');
  mkdirSync(join(root, '.dulger'), { recursive: true });
  writeFileSync(join(root, '.dulger/config.json'), '{ broken');
  const h = setup(t, { root });
  assert.match(h.text, /! settings unreadable/);
  assert.match(h.text, new RegExp(`!\\s+${broken.runId}`), 'the glyph says it cannot be read');
  assert.match(h.text, /Fine/);
  void ch;
});

test('a config value carrying a terminal escape is drawn as plain text, never a raw escape', async (t) => {
  const root = repo(t);
  // A hostile repository config: the backend name and a setting value carry OSC escapes.
  const evil = 'evil\u001b]52;c;eA==\u0007';
  mkdirSync(join(root, '.dulger'), { recursive: true });
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify({
    harness: evil, concurrency: '\u001b]0;HIJACK\u0007',
    providers: { [evil]: { baseUrl: 'https://e.invalid/v1', apiKeyEnv: 'EVIL_KEY_NOT_SET' } },
  }));
  const env = setup(t, { root });
  await tick();
  for (const [rows, cols] of [[24, 80], [40, 120]] as const) {
    env.screens.current.resize(rows, cols);
    assertFrame(env.s.lines, rows, cols, 'home with a hostile config');
  }
  assert.ok(!env.s.text.includes('\u0007') && !env.s.text.includes('\u001b]'), 'no OSC escape reaches the frame');
});

test('the goal stays in the box while a launch dialog is open, and goes once a run started from it', async (t) => {
  let finish!: (out: LaunchOutcome) => void;
  const pending = new Promise<LaunchOutcome>((r) => { finish = r; });
  const h = setup(t, { outcome: pending });
  h.s.type('Add a health check endpoint with a test');
  h.s.key(key('enter'));
  await tick();
  assert.equal(h.calls.length, 1, 'the launch is under way (its dialog would be open now)');
  // The box is as wide as it needs to be for no runs: the goal wraps in it, and it grows a row.
  assert.match(h.text, /│ Add a health check endpoint with a\s+│[^\n]*\n│ test\s+│/, 'the goal is still in the box');
  finish({ kind: 'finished', runId: 'r', landed: 1 });
  await tick();
  assert.doesNotMatch(h.text, /│ Add a health check/, 'cleared once the run started');
  assert.match(h.text, /What should the agents build\?/);
});

test('↑ in an empty box brings back the goals of earlier runs, after a restart too', async (t) => {
  const root = repo(t);
  addRun(root, 'An earlier run from yesterday', ['done'], 60 * 24);
  history.length = 0;
  const h = setup(t, { root });
  h.s.key(key('up'));
  assert.match(h.text, /│ An earlier run from yesterday/);
});

test('Roles lists a readiness problem too (cached, from the checks a run makes)', async (t) => {
  // Concurrency 0 fails preflight's Settings check; nothing needs to spawn for it.
  const h = setup(t, { session: { overrides: { harness: 'fake', concurrency: 0 } } });
  assert.match(h.text, /! invalid settings/);
  assert.match(h.text, /Home !1/, 'counted on the tab');
});

test('a run held by another process is read again each second while Home shows it', async (t) => {
  const root = repo(t);
  const id = addRun(root, 'Running elsewhere', ['in_progress']);
  const lock = join(store.runDir(root, id), 'execution.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'x' }));
  const h = setup(t, { root });
  assert.match(h.text, /●\s+Running elsewhere/, 'running: its own glyph');
  assert.doesNotMatch(h.text, /\b(running|interrupted)\b/, 'no state words in the list');
  rmSync(lock, { recursive: true });
  await sleep(1300);
  assert.match(h.text, /◌\s+Running elsewhere/, 'interrupted, updated without leaving the tab');
});

test('when only the saved settings file is uncommitted, Home names it and offers to commit it', async (t) => {
  const root = repo(t);
  mkdirSync(join(root, '.dulger'), { recursive: true });
  writeFileSync(join(root, '.dulger/config.json'), '{}\n');
  git.git(root, ['add', '.dulger/config.json']);
  git.git(root, ['commit', '-qm', 'settings']);
  writeFileSync(join(root, '.dulger/config.json'), '{ "concurrency": 2 }\n');
  const h = setup(t, { root });
  assert.match(h.text, /! settings uncommitted/);
  h.s.key(key('tab'));
  assert.match(h.text, /⏎ commit/, 'Enter commits it (asking first)');
  h.s.key(key('f1'));
  assert.match(h.help, /^settings uncommitted The only uncommitted change is \.dulger\/config\.json/, 'the file is named in ?');
});
