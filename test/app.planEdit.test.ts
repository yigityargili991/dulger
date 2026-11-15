// The plan editor page driven through the real shell against a temporary repository. The page shows
// labels and values only; what it used to explain is in help, so prose is asserted there (helpText)
// and the page is asserted on its state: values, glyphs, the dialogs' facts.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { acquireRunLock } from '../src/board/lock.ts';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { createApp } from '../src/app/shell.ts';
import { createPlanEditPage } from '../src/app/pages/planEdit.ts';
import { buildSections, rowHelp } from '../src/app/pages/planEdit.rows.ts';
import type { AppContext, Page, PageFactory } from '../src/app/types.ts';
import type { Board, PlannerResult } from '../src/types.ts';
import type { IconSet } from '../src/tui/theme.ts';
import { SIZES, assertFrame, ch, fakeScreens, g, key, press } from './kit.helpers.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-app-plan-data-'));
const config: Config = { ...structuredClone(DEFAULT_CONFIG), harness: 'fake' };
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r)); };
const RUN = 'r1';

const PLAN: PlannerResult = { cards: [
  { id: 'c1', title: 'Parse the config', description: 'Read the config file', acceptanceCriteria: ['reads JSON'], dependsOn: [], verify: [],
    tasks: [{ id: 't1', title: 'Implement', instructions: 'Write the parser', complexity: 'high' }] },
  { id: 'c2', title: 'Add the endpoint', description: 'Serve /health', acceptanceCriteria: ['returns 200'], dependsOn: ['c1'], verify: ['npm test'],
    tasks: [{ id: 't1', title: 'Implement', instructions: 'Add the route' }] },
  { id: 'c3', title: 'Write docs', description: 'Document it', acceptanceCriteria: [], dependsOn: [], verify: [],
    tasks: [{ id: 't1', title: 'Docs', instructions: 'Write the README section' }] },
] };

function repo(t: TestContext, edit?: (b: Board) => void): { root: string; board: Board } {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  git.git(root, ['commit', '-q', '--allow-empty', '-m', 'initial']);
  const board = createBoard(root, 'Add a health endpoint', RUN);
  board.cards = store.cardsFromPlan(structuredClone(PLAN));
  edit?.(board);
  store.saveBoard(root, board);
  return { root, board };
}

const held = (root: string) => { try { acquireRunLock(root, RUN)(); return false; } catch { return true; } };
const saved = (root: string) => store.loadBoard(root, RUN);
const events = (root: string) => (existsSync(join(store.runDir(root, RUN), 'events.jsonl')) ? readFileSync(join(store.runDir(root, RUN), 'events.jsonl'), 'utf8') : '');

function host(id: string, title: string, box: { ctx?: AppContext }): PageFactory {
  return (ctx) => {
    box.ctx = ctx;
    const page: Page = { id, title, render: () => ({ lines: [`${title} page`] }), onKey: () => false, hints: () => [] };
    return page;
  };
}

function setup(root: string, o: { rows?: number; cols?: number; icons?: IconSet; push?: boolean } = {}) {
  const screens = fakeScreens(o.rows ?? 40, o.cols ?? 120);
  const box: { ctx?: AppContext } = {};
  const app = createApp({
    repoRoot: root, session: { overrides: {}, yes: false, quiet: false, allowDirty: false }, version: '1.0.0', config: () => config,
    pages: [host('runs', 'Runs', box), host('home', 'Home', {})], openScreen: screens.factory, icons: o.icons ?? 'unicode', branch: () => 'main',
  });
  const done = app.run();
  const calls: boolean[] = [];
  let page: Page | undefined;
  const open = () => { page = createPlanEditPage(box.ctx!, RUN, { done: (s) => { calls.push(s); } }); box.ctx!.push(page); };
  if (o.push !== false) open();
  return {
    app, done, calls, open, screens, get ctx() { return box.ctx!; }, get s() { return screens.current; }, get page() { return page!; },
    async close() { app.quit(); await done; },
  };
}

/** Everything the page's help says, as one text. */
const helpText = (page: Page) => (page.help?.() ?? []).flatMap((h) => [h.title, ...[h.text ?? []].flat(), ...h.keys.map((k) => `${k.key} ${k.label}`)]).join('\n');
/** The footer: the breadcrumb and the key bar. */
const footer = (s: { text: string }) => s.text.split('\n').at(-1)!;
/** The column where the editor panel's border starts (right of the card list). */
const editorLeft = (s: { text: string }) => { const l = s.text.split('\n').find((x) => x.includes('╮ ╭'))!; return l.indexOf('╮ ╭') + 2; };

/** Focus the editor and select its n-th row (0 = Title). */
function row(s: { key(k: ReturnType<typeof key>): void; text: string }, n: number) {
  if (!s.text.includes('↑↓ field')) s.key(key('tab'));
  s.key(ch('g'));
  for (let i = 0; i < n; i++) s.key(key('down'));
}

// c1's rows: 0 title, 1 description, 2 criterion, 3 add criterion, 4 dep c2 (loops), 5 dep c3, 6 add command, 7 backend, 8 task title, 9 task instructions.

test('layout: cards with tasks and dependencies on the left, the card editor on the right; every size fits', async (t) => {
  const { root } = repo(t);
  for (const icons of ['unicode', 'ascii', 'nerd'] as const) {
    const { s, page, close } = setup(root, { icons });
    if (icons === 'unicode') {
      const text = s.text;
      assert.match(text, /Goal {2}Add a health endpoint\s*\n/, 'the goal, and no edit badge beside it');
      assert.match(text, /c1 {2}Parse the config/);
      assert.match(text, /│ {5}1 task {2,}│/, 'a card that waits for nothing: its tasks only');
      assert.match(text, /1 task · after c1/);
      assert.match(text, /Title[\s\S]*Parse the config[\s\S]*Description[\s\S]*Acceptance criteria[\s\S]*reads JSON[\s\S]*Waits for/);
      assert.match(text, /⊘ c2 {2}Add the endpoint/, 'a card that waits for this one cannot be chosen: a blocked glyph');
      assert.match(text, /□ c3 {2}Write docs/);
      assert.match(text, /Task t1 · high\s/);
      assert.match(text, /╭─ c1 ─/, 'the editor is titled with the card id; its title is the first row');
      assert.doesNotMatch(text, /starts first|waits for c1|no edits|Edits stay|This card starts|dulger runs these|Session settings choose|difficulty|Add a criterion|Add a command/, 'labels and values only');
      assert.doesNotMatch(text, /unsaved|^ !/m, 'no status line without an error or unsaved edits');
      assert.match(footer(s), /^ Runs › Edit plan {2}↑↓ card {2}⏎ edit {2}esc back {2}\? help\s*$/, 'the breadcrumb and a short key bar');
      const top = text.split('\n').find((l) => l.includes('Cards'))!;
      assert.ok(top.indexOf('╮') < 30, `the card list is as wide as its cards need: ${top.indexOf('╮')}`);
      assert.match(helpText(page), /Edits stay in this draft until \^s saves them/, 'what the page used to say is in help');
      assert.match(helpText(page), /^Cards\nUnder each card: its tasks/m, 'help leads with what is selected');
    }
    for (const [rows, cols] of [...SIZES, [16, 60], [30, 69], [30, 70]] as Array<[number, number]>) {
      s.resize(rows, cols);
      assertFrame(s.lines, rows, cols, icons);
    }
    s.key(key('tab'));
    s.resize(24, 60);
    assertFrame(s.lines, 24, 60, 'single pane');
    assert.match(s.text, /Acceptance criteria/, 'narrow: the focused pane fills the width');
    await close();
  }
});

test('the lock is held while the editor is visible and released on tab switch, suspend, save and quit', async (t) => {
  const { root } = repo(t);
  const h = setup(root);
  const { ctx, calls, close } = h;
  assert.equal(held(root), true, 'open: locked');
  h.s.key({ name: 'alt', ch: '2' });
  assert.match(h.s.text, /Home page/);
  assert.equal(held(root), false, 'another tab: released');
  h.s.key(ch('1'));
  assert.match(h.s.text, /Parse the config/);
  assert.equal(held(root), true, 'back: locked again');
  await ctx.suspend(() => { assert.equal(held(root), false, 'suspended: released'); });
  assert.equal(held(root), true, 'after suspend: locked again');
  assert.match(h.s.text, /Parse the config/, 'the editor is back on the new screen');
  h.s.key(key('ctrl', 'd'));
  await tick();
  assert.equal(held(root), false, 'quit: released');
  assert.deepEqual(calls, [false], 'quitting a clean editor reports it closed unsaved');
  await close();
});

test('a lock held by someone else: the page says so, keeps nothing locked, and tries again on r', async (t) => {
  const { root } = repo(t);
  const other = acquireRunLock(root, RUN);
  const { s, page, calls, close } = setup(root);
  assert.match(s.text, /Run in use/);
  assert.match(s.text.replace(/\s+/g, ' '), /! Run r1 is already in use, or its lock cannot be verified\. Inspect .*execution\.lock before retrying\./, 'the lock\'s own message, whole');
  assert.match(footer(s), /r retry {2}esc back {2}\? help/);
  assert.match(helpText(page), /^Run in use\nAnother process holds the run's execution lock/m);
  s.key(ch('r'));
  assert.match(s.text, /Still in use/);
  other();
  s.key(ch('r'));
  assert.match(s.text, /Parse the config/);
  assert.equal(held(root), true);
  s.key(key('escape'));
  await tick();
  assert.equal(held(root), false);
  assert.deepEqual(calls, [false]);
  assert.match(s.text, /Runs page/);
  await close();
});

test('edit a title, see it marked, save: validated, written, an event recorded, done(true) once, the page closes', async (t) => {
  const { root } = repo(t);
  const { s, calls, close } = setup(root);
  row(s, 0);
  s.key(key('enter'));
  assert.match(s.text, /Title of c1/);
  s.key(key('ctrl', 'u'));
  s.key(key('enter'));
  assert.match(s.text, /The title cannot be empty/);
  s.type('Parse and validate the config');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /✎ c1 {2}Parse and validate/);
  assert.match(s.text, /Title ✎/, 'the changed section is marked');
  assert.match(s.text, /\n ✎ c1 unsaved\s*\n/, 'the status line: unsaved edits, in a few words');
  assert.match(footer(s), /\^s save/, 'save is a key once there is something to save');
  assert.equal(saved(root).cards[0]!.title, 'Parse the config', 'nothing is written before saving');
  s.key(key('ctrl', 's'));
  await tick();
  assert.equal(saved(root).cards[0]!.title, 'Parse and validate the config');
  assert.match(events(root), /plan_edited/);
  assert.deepEqual(calls, [true]);
  assert.match(s.text, /Runs page/);
  assert.match(s.text, /Plan saved · c1/);
  assert.equal(held(root), false, 'saved: released');
  await close();
  assert.deepEqual(calls, [true], 'quitting afterwards does not call done again');
});

test('a draft that fails validation is not saved and not lost; the message is shown', async (t) => {
  const { root } = repo(t, (b) => { b.cards[0]!.worker = { harness: 'nowhere' }; });
  const { s, calls, close } = setup(root);
  assert.match(s.text, /\n ! c1: choose a configured worker harness\./, 'the validation message itself, on the status line');
  row(s, 1);
  s.key(key('enter'));
  s.type(' and check it');
  s.key(key('enter'));
  await tick();
  s.key(key('ctrl', 's'));
  await tick();
  assert.match(s.text, /Not saved: c1: choose a configured worker harness/);
  assert.match(s.text, /Read the config file and check it/, 'the draft is kept');
  assert.deepEqual(calls, []);
  assert.equal(held(root), true, 'still editing: still locked');
  assert.equal(saved(root).cards[0]!.description, 'Read the config file');
  // Fix it: back to session settings.
  row(s, 7);
  assert.match(s.text, /Backend\s+nowhere/);
  s.key(ch('d'));
  assert.match(s.text, /Backend\s+session settings/);
  s.key(key('ctrl', 's'));
  await tick();
  assert.deepEqual(calls, [true]);
  const c1 = saved(root).cards[0]!;
  assert.equal(c1.description, 'Read the config file and check it');
  assert.equal(c1.worker, undefined);
  await close();
});

test('leaving with edits asks first; the safe default keeps editing; discarding writes nothing and calls done(false)', async (t) => {
  const { root } = repo(t);
  const before = readFileSync(store.boardPath(root, RUN), 'utf8');
  const { s, calls, close } = setup(root);
  row(s, 2);
  s.key(ch('d'));
  assert.match(s.text, /Criterion removed/);
  s.key(key('escape'));
  assert.match(s.text, /Discard plan edits/);
  assert.match(s.text, /Edited {2}c1/, 'the facts: whose edits go');
  assert.match(s.text, /\[ Keep editing \]\s+Discard/, 'the safe choice first');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Edit plan/, 'Enter on the default keeps editing');
  assert.deepEqual(calls, []);
  s.key(key('escape'));
  s.key(key('right'));
  s.key(key('enter'));
  await tick();
  assert.deepEqual(calls, [false]);
  assert.match(s.text, /Runs page/);
  assert.match(s.text, /Plan edits discarded/);
  assert.equal(readFileSync(store.boardPath(root, RUN), 'utf8'), before);
  assert.doesNotMatch(events(root), /plan_edited/);
  assert.equal(held(root), false);
  await close();
});

test('a started plan cannot be edited: the page says why, holds no lock, and only goes back', async (t) => {
  const { root } = repo(t, (b) => { b.cards[1]!.status = 'in_progress'; });
  const { s, page, calls, close } = setup(root);
  assert.match(s.text, /Plan started/);
  assert.doesNotMatch(s.text, /Only an unstarted plan/, 'a state, not a sentence');
  assert.match(helpText(page), /^Plan started\nOnly an unstarted plan can be edited/m, 'why, in help');
  assert.equal(held(root), false);
  assert.match(footer(s), /Edit plan {2}esc back {2}\? help/, 'nothing to retry');
  s.key(key('ctrl', 's'));
  s.key(ch('r'));
  assert.match(s.text, /Plan started/);
  s.key(key('ctrl', 'p'));
  assert.match(s.text, /Leave editor/);
  assert.doesNotMatch(s.text, /Save plan/);
  s.key(key('escape'));
  s.key(key('escape'));
  await tick();
  assert.deepEqual(calls, [false]);
  assert.match(s.text, /Runs page/);
  await close();
});

test('dependencies are checkboxes that never allow a loop; verify commands are whole, added, reordered, removed and undone', async (t) => {
  const { root } = repo(t);
  const { s, page, calls, close } = setup(root, { rows: 40, cols: 100 });
  row(s, 4);
  assert.doesNotMatch(footer(s), /space/, 'a card that cannot be chosen offers no key');
  assert.match(helpText(page), /^Waits for\n[\s\S]*c2 waits for c1\./m, 'why it cannot be chosen is in help');
  s.key(ch(' '));
  await tick();
  assert.match(s.text, /Loop: c2 waits for c1/, 'and in a short toast when it is tried');
  assert.doesNotMatch(s.text, /▣ c2/, 'not checked');
  s.key(key('down'));
  assert.match(footer(s), /space check/);
  s.key(ch(' '));
  assert.match(s.text, /after c3/, 'c1 now waits for c3');
  // A long command with pipes, added under Verify commands, is shown whole.
  const long = 'npm test -- --grep "config parser" 2>&1 | tee /tmp/out.txt | grep -v DEBUG | tail -n 200 && echo "all config parser tests passed fine"';
  s.key(key('down'));
  s.key(ch('a'));
  assert.match(s.text, /New verify command for c1/);
  s.key({ name: 'paste', text: long });
  s.key(key('enter'));
  await tick();
  s.key(ch('a'));
  s.type('echo a | cat');
  s.key(key('enter'));
  await tick();
  // The editor's content: right of its left border, without the border and scrollbar cells.
  const left = editorLeft(s);
  const editor = s.text.split('\n').slice(3, -1).map((l) => l.slice(left + 1)).join('').replace(/[│┃]/g, '').replace(/\s+/g, '');
  assert.ok(editor.includes(long.replace(/\s+/g, '')), 'the long command is shown whole, wrapped, nothing cut');
  assert.match(helpText(page), /^Verify commands\n.*Saving the plan approves running them/m, 'what saving them means is in help');
  assert.doesNotMatch(s.text, /tail -n 2…/);
  s.key(ch('K'));
  s.key(ch('u'));
  s.key(ch('K'));
  s.key(ch('d'));
  assert.match(s.text, /Command removed/);
  s.key(ch('u'));
  s.key(key('ctrl', 's'));
  await tick();
  assert.deepEqual(calls, [true]);
  const c1 = saved(root).cards[0]!;
  assert.deepEqual(c1.dependsOn, ['c3']);
  assert.deepEqual(c1.verify, ['echo a | cat', long], 'pipes kept, order as reordered');
  await close();
});

test('worker override: a backend from the configured ones and a model, typed IDs validated as the plan is', async (t) => {
  const { root } = repo(t);
  const { s, page, calls, close } = setup(root);
  row(s, 7);
  assert.match(helpText(page), /^Backend\nThe backend that builds this card\./m);
  s.key(key('enter'));
  assert.match(s.text, /Worker for c1/);
  assert.match(s.text, /❯ Session settings\s/);
  assert.doesNotMatch(s.text, /routed by task difficulty|A pinned model/, 'names and tags only');
  for (const h of ['claude', 'codex', 'fake']) assert.match(s.text, new RegExp(`${h}\\s+built in`));
  for (let i = 0; i < 3; i++) s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Model for c1 on fake/);
  assert.match(s.text, /❯ Automatic\s+│/, 'Automatic, without an explanation beside it');
  assert.doesNotMatch(s.text, /backend's default/);
  s.key(key('end'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Model ID for c1/);
  assert.match(s.text, /model id/, 'a placeholder of a few words');
  s.key(key('enter'));
  assert.match(s.text, /The model ID cannot be empty\./, 'what is wrong, not what to do');
  s.type('my model');
  s.key(key('enter'));
  assert.match(s.text, /Model IDs cannot contain spaces or control characters\./);
  s.key(key('ctrl', 'u'));
  s.type('my-model');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Backend\s+fake/);
  assert.match(s.text, /Model\s+my-model/);
  assert.doesNotMatch(s.text, /A pinned model overrides/, 'no note under the worker');
  assert.match(helpText(page), /^Model\nA pinned model is used for every task and retry of this card/m, 'the selected row\'s meaning is in help');
  assert.match(s.text, /1 task · my-/, 'the card list shows the pin');
  s.key(key('ctrl', 's'));
  await tick();
  assert.deepEqual(calls, [true]);
  assert.deepEqual(saved(root).cards[0]!.worker, { harness: 'fake', model: 'my-model' });
  await close();
});

test('task title and instructions, description: multi-line edits land in the draft', async (t) => {
  const { root } = repo(t);
  const { s, calls, close } = setup(root);
  row(s, 9);
  s.key(key('enter'));
  assert.match(s.text, /Instructions for task t1/);
  s.key({ name: 'alt-enter' });
  s.type('Keep the public API.');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Write the parser\s*│?\s*\n/);
  assert.match(s.text, /Keep the public API\./);
  row(s, 8);
  s.key(key('enter'));
  s.key(key('ctrl', 'u'));
  s.type('Implement the parser');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Task t1 · high ✎/);
  s.key(key('ctrl', 's'));
  await tick();
  assert.deepEqual(calls, [true]);
  const task = saved(root).cards[0]!.tasks[0]!;
  assert.equal(task.instructions, 'Write the parser\nKeep the public API.');
  assert.equal(task.title, 'Implement the parser');
  await close();
});

test('coming back after the plan changed elsewhere: reloaded without edits; with edits the person chooses', async (t) => {
  const { root } = repo(t);
  const { s, calls, close } = setup(root);
  s.key({ name: 'alt', ch: '2' });
  const b = saved(root); b.cards[2]!.title = 'Write the docs elsewhere'; store.saveBoard(root, b);
  s.key(ch('1'));
  assert.match(s.text, /Write the docs elsewhere/);
  assert.match(s.text, /Plan changed elsewhere · reloaded/, 'a short toast');
  // Now with an edit pending.
  row(s, 0);
  s.key(key('enter'));
  s.type('!');
  s.key(key('enter'));
  await tick();
  s.key({ name: 'alt', ch: '2' });
  const b2 = saved(root); b2.cards[2]!.title = 'Docs, third version'; store.saveBoard(root, b2);
  s.key(ch('1'));
  assert.match(s.text, /─ Plan changed elsewhere ─/);
  assert.match(s.text, /Reload drops your edits to c1, c3/, 'the one consequence: what Reload drops');
  assert.match(s.text, /\[ Keep draft \]\s+Reload/, 'the safe choice first');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Parse the config!/, 'the draft was kept');
  assert.match(s.text, /Draft kept/);
  s.key({ name: 'alt', ch: '2' });
  const b3 = saved(root); b3.cards[2]!.title = 'Docs, fourth version'; store.saveBoard(root, b3);
  s.key(ch('1'));
  s.key(key('right'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Docs, fourth version/);
  assert.doesNotMatch(s.text, /Parse the config!/, 'reloaded: the edit was dropped');
  assert.match(s.text, /Reloaded · edits dropped/);
  assert.doesNotMatch(s.text, /unsaved/, 'no edits, no status line');
  // The plan started while the editor was in the background.
  s.key({ name: 'alt', ch: '2' });
  const b4 = saved(root); b4.cards[0]!.status = 'in_progress'; store.saveBoard(root, b4);
  s.key(ch('1'));
  assert.match(s.text, /Plan started/);
  assert.equal(held(root), false);
  s.key(key('escape'));
  await tick();
  assert.deepEqual(calls, [false]);
  await close();
});

test('quitting with edits asks; the palette and help name every action; clicks choose cards and fields', async (t) => {
  const { root } = repo(t);
  const { s, page, calls, close, done } = setup(root);
  s.key(key('ctrl', 'p'));
  for (const title of ['Save plan', 'Leave editor', 'Edit field', 'Add criterion', 'Add verify command', 'Choose worker', 'Undo', 'Revert c1', 'Go to editor']) {
    assert.match(s.text, new RegExp(`│ [❯ ] ${title}\\s`), `${title}: the page's own, without its name`);
  }
  assert.doesNotMatch(s.text, /Edit plan: /);
  s.key(key('escape'));
  const disabled = Object.fromEntries((page.commands?.() ?? []).map((cmd) => [cmd.id, cmd.disabled]));
  assert.deepEqual([disabled.save, disabled.undo, disabled.revert], ['Nothing to save', 'Nothing to undo', 'No edits to c1'], 'a disabled command says why, in a few words, when chosen');
  s.key(ch('?'));
  assert.match(s.text, /save: validates the whole plan/);
  assert.match(s.text, /move a criterion or command/);
  s.key(key('escape'));
  const lines = s.text.split('\n');
  const r = lines.findIndex((l) => l.includes('c3  Write docs') && l.indexOf('c3  Write docs') < 30);
  s.mouse(press(r, 6));
  assert.match(s.text, /╭─ c3 ─/, 'the editor shows the clicked card');
  s.mouse(press(r, 6));
  assert.match(s.text, /↑↓ field/, 'a second click moves into the editor');
  const left = editorLeft(s);
  const at = (needle: string) => s.text.split('\n').findIndex((l, i) => i > 3 && l.includes(needle) && l.indexOf(needle) > left);
  s.mouse(press(at('Document it'), 60));
  assert.match(s.text, /❯ Document it/, 'a click selects a field');
  assert.doesNotMatch(s.text, /Description of c3/);
  s.mouse(press(at('Write docs'), 60));
  s.mouse(press(at('Write docs'), 60));
  assert.match(s.text, /Title of c3/, 'clicking the selected field edits it');
  s.type(' and examples');
  s.key(key('enter'));
  await tick();
  s.key(key('ctrl', 'd'));
  assert.match(s.text, /Quit and discard plan edits/);
  assert.match(s.text, /Edited {2}c3/);
  assert.match(s.text, /\[ Keep editing \]\s+Quit/);
  s.key(key('enter'));
  await tick();
  assert.deepEqual(calls, []);
  s.key(key('ctrl', 'd'));
  s.key(key('right'));
  s.key(key('enter'));
  await done;
  assert.deepEqual(calls, [false]);
  assert.equal(held(root), false);
  assert.equal(saved(root).cards[2]!.title, 'Write docs');
  await close();
});

test('lockHeld: a caller that holds the lock (a live run) keeps it; the page never takes or releases it', async (t) => {
  const { root } = repo(t);
  const release = acquireRunLock(root, RUN);
  t.after(() => { try { release(); } catch { /* released below */ } });
  const screens = fakeScreens(40, 120);
  const calls: boolean[] = [];
  const { runPage } = await import('../src/app/index.ts');
  const closed = runPage({
    repoRoot: root, config: () => config, openScreen: screens.factory, icons: 'unicode',
    page: (ctx) => createPlanEditPage(ctx, RUN, { lockHeld: true, done: (s) => { calls.push(s); } }),
  });
  const s = screens.current;
  assert.match(s.text, /Parse the config/, 'opens although the run is locked: by its caller');
  assert.doesNotMatch(s.text, /Run in use/);
  row(s, 0);
  s.key(key('enter'));
  s.type('!');
  s.key(key('enter'));
  await tick();
  s.key(key('escape'));
  assert.match(s.text, /Discard plan edits/, 'leaving with edits still asks');
  s.key(key('enter'));
  await tick();
  s.key(key('ctrl', 's'));
  await closed;
  assert.deepEqual(calls, [true], 'done once, saved');
  assert.equal(saved(root).cards[0]!.title, 'Parse the config!');
  assert.equal(held(root), true, 'the caller still holds the lock');
  release();
  assert.equal(held(root), false);
});

test('done fires exactly once on every way out: Back from the palette, navigate, and quitting with edits', async (t) => {
  const { root } = repo(t);
  {
    const { s, calls, close } = setup(root);
    s.key(key('ctrl', 'p'));
    s.type('back');
    s.key(key('enter'));
    await tick();
    assert.match(s.text, /Runs page/);
    assert.deepEqual(calls, [false]);
    assert.equal(held(root), false);
    await close();
    assert.deepEqual(calls, [false]);
  }
  {
    const { s, ctx, calls, close } = setup(root);
    row(s, 0);
    s.key(key('enter'));
    s.type('?');
    s.key(key('enter'));
    await tick();
    s.key({ name: 'alt', ch: '2' });
    assert.equal(held(root), false, 'hidden: released');
    ctx.navigate('runs');
    assert.match(s.text, /Discard plan edits/, 'the editor is shown again and asks');
    assert.equal(held(root), true);
    s.key(key('enter'));
    await tick();
    assert.match(s.text, /Edit plan/, 'kept');
    assert.deepEqual(calls, []);
    ctx.navigate('runs');
    // A danger confirm takes the focused button and Enter (y no longer accepts a danger confirm).
    s.key(key('right'));
    s.key(key('enter'));
    await tick();
    assert.match(s.text, /Runs page/);
    assert.deepEqual(calls, [false]);
    assert.equal(held(root), false);
    assert.equal(saved(root).cards[0]!.title, 'Parse the config');
    await close();
    assert.deepEqual(calls, [false]);
  }
});

test('a verify command the dialog cannot represent is shown as the live view shows it and never silently rewritten', async (t) => {
  const tabCmd = "grep -qP 'x\ty' data.tsv"; // contains a literal tab
  const { root } = repo(t, (b) => { b.cards[0]!.verify = ['npm test', tabCmd]; });
  const { s, page, calls, close } = setup(root, { rows: 40, cols: 100 });
  // It is drawn with the tab spelled out (\t), never as a raw tab that could hide what runs.
  assert.ok(!s.text.includes('\t'), 'no raw tab reaches the frame');
  assert.match(s.text, /\$ grep -qP 'x\\ty' data\.tsv/, 'the tab is shown escaped, as the live run view shows it');
  // Opening the ordinary command and confirming without typing is a no-op (no silent rewrite).
  row(s, 6);
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Verify command 1 of c1/);
  s.key(key('enter'));
  await tick();
  assert.doesNotMatch(s.text, /unsaved/, 'an unchanged open changes nothing');
  // The tab command cannot be edited in place: it offers remove or replace, not a text box.
  row(s, 7);
  assert.match(helpText(page), /never silently rewritten/, 'why, in help');
  s.key(key('enter'));
  await tick();
  const notice = s.text;
  assert.match(notice, /Verify command 2 of c1/);
  assert.match(notice, /! not editable: tab/, 'what keeps it from being edited, in a few words');
  assert.match(notice, /│\s+grep -qP 'x\\ty' data\.tsv\s+│/, 'the command whole, as it will run');
  assert.match(notice, /Keep\s+\[ Replace \]\s+Remove/);
  assert.doesNotMatch(notice, /silently rewrite|Remove it/, 'the facts and the buttons');
  s.key(key('escape'));
  await tick();
  s.key(key('ctrl', 's'));
  await tick();
  assert.deepEqual(calls, [], 'nothing was saved: no edit was made');
  assert.deepEqual(saved(root).cards[0]!.verify, ['npm test', tabCmd], 'the commands are untouched');
  await close();
});

test('typing that is no key in the editor does nothing: no quit, no tab switch; help does not offer bare digits over it', async (t) => {
  const { root } = repo(t);
  const h = setup(root);
  h.s.key(ch('q'));
  h.s.key(ch('x'));
  h.s.key(ch('2'));
  assert.doesNotMatch(h.s.text, /Not a key/, 'a stray letter does nothing, silently');
  assert.match(h.s.text, /Edit plan/, 'still in the editor');
  h.s.key(ch('?'));
  assert.match(h.s.text, /alt-1-9\s+switch tab \(bare digits only on a tab's own page\)/);
  assert.doesNotMatch(h.s.text, /1-9  alt-1-9/);
  await h.close();
});

test('the key bar holds at most four keys on every row, save only with edits; help leads with the selected row', async (t) => {
  const { root } = repo(t);
  const { s, page, close } = setup(root);
  assert.deepEqual(page.hints().map((h) => h.label), ['card', 'edit'], 'nothing to save yet');
  const titles: string[] = [];
  for (let i = 0; i < 10; i++) {
    row(s, i);
    const hints = page.hints();
    assert.ok(hints.length <= 4, `row ${i}: ${hints.map((h) => h.label).join(' ')}`);
    assert.equal(hints[0]!.label, 'field');
    assert.ok(hints.every((h) => !h.label.includes(' ')), `row ${i}: single words`);
    titles.push(page.help!()[0]!.title);
  }
  assert.deepEqual(titles, ['Title', 'Description', 'Acceptance criteria', 'Acceptance criteria', 'Waits for', 'Waits for', 'Verify commands', 'Backend', 'Task t1', 'Task t1']);
  assert.match(helpText(page), /^Task t1\nWhat the worker does for this task of c1\.[\s\S]*high: the task's difficulty/m);
  row(s, 2);
  s.key(ch('d'));
  const hints = page.hints();
  assert.ok(hints.length <= 4 && hints.at(-1)!.label === 'save', 'with an edit, save joins the bar');
  assert.ok(page.help!().some((h) => h.title === 'About'), 'the page\'s concepts, last');
  await close();
});

test('rows: the only card has no Waits for heading; a dependency on a missing card is shown and can be unchecked', () => {
  const [only] = store.cardsFromPlan(structuredClone({ cards: [PLAN.cards[0]!] }));
  assert.ok(!buildSections([only!], only!, only, g).some((s) => s.id === 'deps'), 'no heading over an empty list');
  const [a, b] = store.cardsFromPlan(structuredClone({ cards: [PLAN.cards[0]!, PLAN.cards[2]!] }));
  a!.dependsOn = ['c9'];
  const deps = buildSections([a!, b!], a!, a, g).find((s) => s.id === 'deps')!;
  assert.deepEqual(deps.rows.map((r) => [r.text, r.checked]), [['c3  Write docs', false], ['c9  no such card', true]]);
  const loop = buildSections(store.cardsFromPlan(structuredClone(PLAN)), store.cardsFromPlan(structuredClone(PLAN))[0]!, undefined, g).find((s) => s.id === 'deps')!.rows[0]!;
  assert.equal(loop.disabled, 'waits for c1', 'the reason is data on the row, toasted when tried');
  assert.match(rowHelp(a!, loop, g).text.join(' '), /c2 waits for c1\./);
});
