// The live run view as the app starts it: on the app's own terminal (lent, never given back to the
// shell), silent on the normal screen, the plan editor page opened from the plan review while the run
// holds its lock, a resume whose settings were chosen in the app's dialog, and the run view's details
// (local log times, the plan review giving the log's empty rows to the plan). Real runBoard calls on the
// fake harness, on fake screens, with the terminal flags set as on a terminal.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { lockOwner } from '../src/board/lock.ts';
import { createBoard } from '../src/board/create.ts';
import { createFakeAdapter, DEFAULT_FAKE_SCRIPT } from '../src/adapters/fake.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { resumeRun, runBoard } from '../src/commands.ts';
import { createApp } from '../src/app/shell.ts';
import { createLauncher, type LaunchDeps } from '../src/app/run.ts';
import { sessionConfig } from '../src/replModels.ts';
import { snapshotSettings } from '../src/runSettings.ts';
import { clockTime } from '../src/ui/ansi.ts';
import { SETTLE_MS } from '../src/tui/tui.ts';
import { render } from '../src/tui/view.ts';
import type { Screen } from '../src/tui/screen.ts';
import type { Session } from '../src/repl.ts';
import type { PlannerResult } from '../src/types.ts';
import { ch, fakeScreens, key } from './kit.helpers.ts';
import { board as viewBoard, card, rig, viewState } from './tui.helpers.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-handover-data-'));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-handover-home-'));
const config: Config = { ...structuredClone(DEFAULT_CONFIG), harness: 'fake', docs: false, progressIntervalSec: 0, concurrency: 1, maxReplans: 0 };

function repo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-handover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

const plan: PlannerResult = { cards: [
  { id: 'c1', title: 'Greeting module', description: 'Add greet.js', acceptanceCriteria: ['greets'], dependsOn: [], verify: [], tasks: [{ id: 't1', title: 'write', instructions: 'Create greet.js' }] },
  { id: 'c2', title: 'Wire the CLI', description: 'cli.js prints it', acceptanceCriteria: ['prints'], dependsOn: ['c1'], verify: [], tasks: [{ id: 't1', title: 'write', instructions: 'Create cli.js' }] },
] };
const fake = () => createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: plan, checker: () => ({ pass: true, feedback: [], summary: 'ok' }), delayMs: 1 });

/** stdin and stdout as on a terminal, for this test only: the run view and the plan review are used. */
function terminal(t: TestContext): void {
  const was = { out: process.stdout.isTTY, inp: process.stdin.isTTY };
  process.stdout.isTTY = true;
  process.stdin.isTTY = true;
  t.after(() => { process.stdout.isTTY = was.out; process.stdin.isTTY = was.inp; });
}

/** Wait until `fn` holds (the run moves on its own timers). */
async function until(fn: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The plan review ignores Enter and clicks for a moment after it appears: a person reads it first. */
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS + 20));

/** console.log, recorded (the run would print its banner and report there). */
function printed(t: TestContext): string[] {
  const out: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => { out.push(a.join(' ')); });
  return out;
}

test('Edit plan in the plan review opens the plan editor page on the run\'s lock, then the review comes back with the edit', async (t) => {
  const root = repo(t);
  terminal(t);
  registerAdapter('fake', fake());
  const out = printed(t);
  const screens = fakeScreens(30, 110);
  const b = createBoard(root, 'Add a hello script');
  const run = runBoard(root, b, config, { yes: false, quiet: false, merge: false, fresh: true, interactive: true, silent: true, screen: screens.factory });
  await until(() => /Dispatch/.test(screens.current.text), 'the plan review');
  assert.match(screens.current.text, /Greeting module/);
  const review = screens.current;
  await settle();
  review.key(key('right'));
  review.key(key('right'));
  review.key(key('enter'));
  await until(() => screens.made.length >= 2 && /Edit plan/.test(screens.current.text) && /c2 {2}Wire the CLI/.test(screens.current.text), 'the plan editor');
  const editor = screens.current;
  assert.doesNotMatch(editor.text, /in use|already in use/, 'the editor does not try to take the lock the run holds');
  assert.equal(lockOwner(root, b.runId)?.pid, process.pid, 'the run holds its lock while the plan is edited');
  if (!editor.text.includes('↑↓ field')) editor.key(key('tab'));
  editor.key(ch('g'));
  editor.key(key('enter'));
  assert.match(editor.text, /Title of c1/);
  editor.key(key('ctrl', 'u'));
  editor.type('Greet in two languages');
  editor.key(key('enter'));
  await until(() => /c1 unsaved/.test(editor.text), 'the edit in the draft');
  editor.key(key('ctrl', 's'));
  await until(() => screens.made.length >= 3 && /Dispatch/.test(screens.current.text), `the plan review again: ${screens.made.length} screens\n${screens.current.text}`);
  const back = screens.current;
  assert.match(back.text, /Greet in two languages/, 'the review shows the edited plan');
  assert.match(back.text, /plan edited by you/, 'and the log says so, after what was logged before');
  assert.match(back.text, /plan ready|planned/i);
  await settle();
  back.key(key('enter'));
  const outcome = await run;
  assert.deepEqual(outcome, { landed: 2, aborted: false });
  const saved = store.loadBoard(root, b.runId);
  assert.equal(saved.cards[0]!.title, 'Greet in two languages');
  assert.match(readFileSync(join(store.runDir(root, b.runId), 'events.jsonl'), 'utf8'), /plan_edited/);
  assert.equal(lockOwner(root, b.runId), undefined, 'released when the run ended');
  assert.deepEqual(out, [], 'silent: no banner, report or kept-worktrees line on the normal screen');
});

test('leaving the plan editor without saving goes back to the review with the plan unchanged', async (t) => {
  const root = repo(t);
  terminal(t);
  registerAdapter('fake', fake());
  const out = printed(t);
  const screens = fakeScreens(30, 110);
  const b = createBoard(root, 'Add a hello script');
  const run = runBoard(root, b, config, { yes: false, quiet: false, merge: false, fresh: true, interactive: true, silent: true, screen: screens.factory });
  await until(() => /Dispatch/.test(screens.current.text), 'the plan review');
  await settle();
  screens.current.key(key('right'));
  screens.current.key(key('right'));
  screens.current.key(key('enter'));
  await until(() => screens.made.length >= 2 && /Edit plan/.test(screens.current.text), 'the plan editor');
  screens.current.key(key('escape'));
  await until(() => screens.made.length >= 3 && /Dispatch/.test(screens.current.text), 'the plan review again');
  assert.doesNotMatch(screens.current.text, /plan edited by you/);
  // Keep in backlog: silent, so nothing is printed about it.
  screens.current.key(key('ctrl', 'c'));
  assert.deepEqual(await run, { landed: 0, aborted: true });
  assert.deepEqual(store.loadBoard(root, b.runId).cards.map((c) => c.title), ['Greeting module', 'Wire the CLI']);
  assert.deepEqual(out, [], 'silent: no "not dispatched" line either');
});

test('without silent the line prompt\'s output stays as it was: the banner and the report', async (t) => {
  const root = repo(t);
  registerAdapter('fake', fake());
  const out = printed(t);
  const write = process.stdout.write.bind(process.stdout) as (...a: unknown[]) => boolean;
  const written: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: unknown, ...rest: unknown[]) => { if (typeof chunk === 'string') written.push(chunk); return write(chunk, ...rest); });
  const b = createBoard(root, 'Print it all');
  await runBoard(root, b, config, { yes: true, quiet: true, merge: false, fresh: true });
  assert.match(out[0]!, new RegExp(`^dulger run ${b.runId} on `));
  assert.match(written.join(''), new RegExp(`Run ${b.runId}`), 'the report');

  out.length = 0;
  written.length = 0;
  const quiet = createBoard(root, 'Print nothing');
  await runBoard(root, quiet, config, { yes: true, quiet: true, merge: false, fresh: true, silent: true });
  assert.ok(out.every((l) => /^\d\d:\d\d:\d\d /.test(l)), 'only the plain view\'s log lines');
  assert.deepEqual(written, []);
});

test('a resume whose settings were chosen in the app does not ask again, and runs with the chosen ones', async (t) => {
  const root = repo(t);
  terminal(t);
  registerAdapter('fake', fake());
  printed(t);
  const make = () => {
    const b = createBoard(root, 'Resume me');
    b.cards = store.cardsFromPlan(structuredClone(plan));
    b.settings = snapshotSettings({ ...config, concurrency: 1 });
    store.saveBoard(root, b);
    return b.runId;
  };
  const current = { ...config, concurrency: 5 };
  // Without the choice, runBoard would open its own picker on the bare terminal here.
  for (const [currentSettings, want] of [[false, 1], [true, 5]] as const) {
    const id = make();
    const screens = fakeScreens(24, 80);
    const r = await resumeRun(root, current, id, { quiet: false, merge: false, interactive: true, silent: true, screen: screens.factory, currentSettings, settingsChosen: true });
    assert.deepEqual(r, { landed: 2, aborted: false });
    assert.equal(store.loadBoard(root, id).settings!.config.concurrency, want, currentSettings ? 'this session\'s, as chosen' : 'the run\'s own');
    assert.equal(screens.made.length, 1, 'the run view drew on the screen it was given');
  }
});

test('from the app a full-screen run borrows the app\'s terminal; a quiet one gets the shell\'s screen', async (t) => {
  const root = repo(t);
  terminal(t);
  const session: Session = { overrides: { harness: 'fake' }, yes: false, quiet: false, allowDirty: false };
  const screens = fakeScreens(24, 100);
  const page = { id: 'home', title: 'Home', render: () => ({ lines: ['home page'] }), onKey: () => false, hints: () => [] };
  const app = createApp({ repoRoot: root, session, version: 't', config: () => sessionConfig(root, session), icons: 'unicode', branch: () => 'main', pages: [() => page, () => ({ ...page, id: 'runs', title: 'Runs' })], openScreen: screens.factory });
  const done = app.run();
  t.after(async () => { app.quit(); await done; });
  const seen: Array<{ screen?: () => Screen; silent?: boolean }> = [];
  const deps: Partial<LaunchDeps> = {
    runGoal: async (r, _s, goal, o = {}) => {
      seen.push(o);
      const view = o.screen?.();
      view?.paint(['the live view'], undefined);
      if (view) assert.match(screens.current.text, /^the live view/, 'drawn on the app\'s screen');
      view?.close();
      const b = createBoard(r, goal);
      store.saveBoard(r, b);
      return { runId: b.runId, runBranch: b.runBranch, landed: 0, aborted: true };
    },
    reviewPage: () => page,
  };
  const launcher = createLauncher(deps);
  await launcher.goal(app.ctx, 'Draw on the app terminal');
  assert.equal(seen[0]!.silent, true);
  assert.ok(seen[0]!.screen, 'lent');
  assert.equal(screens.made.length, 1, 'the app never left the alternate screen');
  assert.equal(screens.current.closed, 0);
  assert.match(screens.current.text.replace(/\s+/g, ' '), /stopped before (its|the) plan/i, 'and reports the outcome itself');

  session.quiet = true;
  await launcher.goal(app.ctx, 'Plain lines on the normal screen');
  assert.equal(seen[1]!.screen, undefined, 'plain log lines need the normal screen');
  assert.equal(screens.made.length, 2, 'given away and taken back');
  assert.equal(screens.made[0]!.closed, 1);
});

test('log lines carry the local time, as every other time dulger shows', () => {
  assert.equal(clockTime(new Date(2026, 10, 15, 0, 46, 5)), '00:46:05');
  const r = rig({ rows: 24, cols: 80 });
  try {
    const before = clockTime();
    r.tui.note('something happened');
    const after = clockTime();
    const line = r.text().split('\n').find((l) => l.includes('something happened'))!;
    assert.ok(line.includes(before) || line.includes(after), line);
  } finally { r.tui.close(); }
});

test('a plan longer than a tall screen takes the log\'s empty rows; a full log keeps its share', () => {
  const cards = Array.from({ length: 12 }, (_, i) => card(`c${i + 1}`, 'backlog', { verify: ['npm test'] }));
  const b = viewBoard(cards);
  const at = (notes: number) => render(viewState(b, {
    rows: 60, cols: 120, phase: 'plan ready', notes: Array.from({ length: notes }, (_, i) => `12:00:0${i % 10}  line ${i}`),
    review: { warnings: [], button: 0 }, prompt: { label: 'reply', text: '', cursor: 0, hint: '', placeholder: 'type here' },
  }));
  const few = at(3);
  const many = at(40);
  assert.equal(few.hits.panes.log!.rows, 1 + 3, 'a heading and the few rows a log keeps');
  assert.ok(few.hits.panes.board!.rows > many.hits.panes.board!.rows, 'the plan got the rows');
  assert.ok(many.hits.panes.log!.rows >= 12, `the log keeps its share when it has lines: ${many.hits.panes.log!.rows}`);
  // Nothing is left blank between the log and the actions: the last log row is the last note.
  const rows = few.lines;
  const actions = rows.findIndex((l) => /Dispatch/.test(l));
  assert.match(rows[actions - 1]!, /line 2/);
});
