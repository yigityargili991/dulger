// Starting runs from the app (src/app/run.ts): the checks before the terminal is handed over, the
// dialogs for problems and failures, and what the app shows when a run comes back — with the functions
// that run agents replaced, plus one real run on the fake harness.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { createFakeAdapter, DEFAULT_FAKE_SCRIPT } from '../src/adapters/fake.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import { CliError } from '../src/errors.ts';
import { createApp } from '../src/app/shell.ts';
import { createLauncher, readable, runProblems, type LaunchDeps } from '../src/app/run.ts';
import { renderNotice, createNotice } from '../src/tui/kit/index.ts';
import { sessionConfig } from '../src/replModels.ts';
import { findSetting } from '../src/settings.ts';
import { history } from '../src/ui/prompt.ts';
import { glyphs } from '../src/tui/theme.ts';
import { width } from '../src/tui/text.ts';
import type { AppContext, NavParams, Page, PageFactory } from '../src/app/types.ts';
import type { Session } from '../src/repl.ts';
import type { CardStatus, PlannerResult } from '../src/types.ts';
import type { SessionRun } from '../src/sessionRuns.ts';
import { snapshotSettings } from '../src/runSettings.ts';
import { keptWorktrees } from '../src/app/pages/runs.data.ts';
import type { Config } from '../src/config.ts';
import { SIZES, assertFrame, ch, fakeScreens, key, plain } from './kit.helpers.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-app-run-data-'));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-app-run-home-'));

function repo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

const plan = (n = 2): PlannerResult => ({
  cards: Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, title: `Card ${i + 1}`, description: 'Do it', acceptanceCriteria: ['done'], dependsOn: [], verify: [], tasks: [{ id: 't1', title: 'Do', instructions: 'Write something' }] })),
});

/** A board in the store as a run would leave it. */
function leaveRun(root: string, goal: string, statuses: CardStatus[]): SessionRun & { runId: string } {
  const b = createBoard(root, goal);
  b.cards = store.cardsFromPlan(plan(statuses.length));
  statuses.forEach((s, i) => { b.cards[i]!.status = s; });
  store.saveBoard(root, b);
  return { runId: b.runId, runBranch: b.runBranch, landed: statuses.filter((s) => s === 'done').length, aborted: false };
}

interface Visit { page: string; params?: NavParams }

/** The real shell with pages that record where the launcher sends the person. */
function setup(t: TestContext, o: { root?: string; session?: Partial<Session> } = {}) {
  const root = o.root ?? repo(t);
  const session: Session = { overrides: { harness: 'fake' }, yes: false, quiet: false, allowDirty: false, ...o.session };
  const visits: Visit[] = [];
  const page = (id: string): PageFactory => () => ({
    id, title: id[0]!.toUpperCase() + id.slice(1),
    activate: (params) => { if (params) visits.push({ page: id, params }); else visits.push({ page: id }); },
    render: (size) => ({ lines: [`${id} page ${size.rows}x${size.cols}`] }),
    onKey: () => false,
    hints: () => [],
  });
  const screens = fakeScreens(24, 100);
  const app = createApp({
    repoRoot: root, session, version: 't', config: () => sessionConfig(root, session), icons: 'unicode', branch: () => 'main',
    pages: ['home', 'runs', 'settings', 'models', 'providers', 'doctor'].map(page), openScreen: screens.factory,
  });
  const done = app.run();
  t.after(async () => { app.quit(); await done; });
  visits.length = 0;
  const pushed: string[] = [];
  const reviewPage = (_ctx: AppContext, runId: string): Page => { pushed.push(runId); return { id: `review:${runId}`, title: `Review ${runId}`, render: () => ({ lines: ['review'] }), onKey: () => false, hints: () => [] }; };
  return {
    root, session, app, ctx: app.ctx, screens, visits, pushed, reviewPage,
    get text() { return screens.current.text; },
    /** The screen as one line of words: toasts and dialogs wrap wherever the width says. */
    get flat() { return screens.current.text.replace(/[▌│╭╮╰╯]/g, ' ').replace(/\s+/g, ' '); },
  };
}

const tick = () => sleep(5);

/** Fakes for what runs agents, recording each call. */
function fakes(result: (root: string, goal: string) => SessionRun | Promise<SessionRun>) {
  const calls: Array<{ fn: string; session: Session; args: unknown[] }> = [];
  const deps: Partial<LaunchDeps> = {
    runGoal: async (root, session, goal) => { calls.push({ fn: 'goal', session, args: [goal] }); return result(root, goal); },
    runOrder: async (root, session, goal) => { calls.push({ fn: 'order', session, args: [goal] }); return result(root, goal); },
    runResume: async (root, session, runId, o) => { calls.push({ fn: 'resume', session, args: [runId, o] }); return result(root, runId ?? ''); },
    runRetry: async (root, session, cardId, runId) => { calls.push({ fn: 'retry', session, args: [cardId, runId] }); return result(root, runId ?? ''); },
  };
  return { calls, deps };
}

test('run problems: uncommitted changes, roles without a model, providers without a key, an unreadable config', (t) => {
  const { root, session, ctx } = setup(t);
  assert.deepEqual(runProblems(ctx), []);
  writeFileSync(join(root, 'README.md'), 'changed\n');
  const [dirty] = runProblems(ctx);
  assert.equal(dirty!.id, 'dirty');
  assert.equal(dirty!.title, 'dirty tree', 'a short state line');
  assert.deepEqual(dirty!.fix, { label: 'Settings', page: 'settings', params: { key: 'dirty' } });
  assert.doesNotMatch(dirty!.detail, /\/\w/, 'no slash commands');
  assert.deepEqual(runProblems(ctx, { tree: false }), [], 'resume and retry do not look at the tree');
  session.allowDirty = true;
  assert.deepEqual(runProblems(ctx), []);

  mkdirSync(join(root, '.dulger'), { recursive: true });
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify({
    roles: { worker: { harness: 'ollama' }, checker: { harness: 'groq' } },
    providers: { groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'DULGER_TEST_MISSING_KEY', model: 'm' } },
  }));
  delete process.env.DULGER_TEST_MISSING_KEY;
  const ids = runProblems(ctx).map((p) => p.id);
  assert.deepEqual(ids, ['model:worker', 'key:groq']);
  const [model, keyless] = runProblems(ctx);
  assert.equal(model!.title, 'no model: worker');
  assert.deepEqual(model!.fix, { label: 'Models', page: 'models', params: { role: 'worker' } });
  assert.equal(keyless!.title, 'no key: groq');
  assert.equal(keyless!.message, 'DULGER_TEST_MISSING_KEY', 'the variable, as data for the dialog');
  assert.deepEqual(keyless!.fix, { label: 'Providers', page: 'providers', params: { provider: 'groq' } });
  assert.match(keyless!.detail, /DULGER_TEST_MISSING_KEY/);
  assert.deepEqual(runProblems(ctx, { models: false }).map((p) => p.id), ['key:groq']);
  process.env.DULGER_TEST_MISSING_KEY = 'x';
  t.after(() => { delete process.env.DULGER_TEST_MISSING_KEY; });
  assert.deepEqual(runProblems(ctx).map((p) => p.id), ['model:worker']);

  writeFileSync(join(root, '.dulger/config.json'), '{ broken');
  const [broken] = runProblems(ctx);
  assert.equal(broken!.id, 'config');
  assert.equal(broken!.fix.page, 'doctor');
});

test('a goal that lands cards: the terminal is handed over, then Runs selects it and the review opens', async (t) => {
  const s = setup(t);
  const { calls, deps } = fakes((root, goal) => leaveRun(root, goal, ['done', 'done']));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const before = s.screens.made.length;
  const out = await launcher.goal(s.ctx, '  Add a hello script  ');
  assert.equal(out.kind, 'finished');
  assert.deepEqual(calls.map((c) => [c.fn, c.args[0]]), [['goal', 'Add a hello script']]);
  assert.equal(calls[0]!.session, s.session, 'the session itself when nothing was waved through');
  assert.equal(s.screens.made[before - 1]!.closed, 1, 'the app gave the terminal away');
  assert.equal(s.screens.made.length, before + 1, 'and took it back');
  const runId = (out as { runId: string }).runId;
  assert.deepEqual(s.visits.filter((v) => v.page === 'runs'), [{ page: 'runs', params: { run: runId } }]);
  assert.deepEqual(s.pushed, [runId]);
  assert.match(s.flat, /2\/2 landed → dulger\//);
  assert.match(s.text, /Runs › Review/, 'the review sits over the Runs tab, so Back lands on the run');
  assert.equal(history[0], 'Add a hello script', 'the goal joins the shared history');

  assert.equal((await launcher.goal(s.ctx, 'Talk it through first', 'order')).kind, 'finished');
  assert.equal(calls.at(-1)!.fn, 'order');
});

test('an empty goal does nothing but say so; a goal that comes back without cards says what happened', async (t) => {
  const s = setup(t);
  const { calls, deps } = fakes((root, goal) => leaveRun(root, goal, ['failed', 'failed']));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  assert.deepEqual(await launcher.goal(s.ctx, '   '), { kind: 'blocked' });
  assert.equal(calls.length, 0);
  assert.match(s.text, /Type a goal/);

  const out = await launcher.goal(s.ctx, 'Make everything fail');
  assert.equal(out.kind, 'finished');
  assert.deepEqual(s.pushed, [], 'nothing to review');
  assert.deepEqual(s.visits.at(-1), { page: 'runs', params: { run: (out as { runId: string }).runId } });
  assert.match(s.flat, /Nothing landed · 2 failed/);
});

test('a run stopped or left in the backlog: Runs selects it and the toast says where it stands', async (t) => {
  const s = setup(t);
  let statuses: CardStatus[] = ['backlog', 'backlog', 'backlog'];
  const { deps } = fakes((root, goal) => ({ ...leaveRun(root, goal, statuses), aborted: true }));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const out = await launcher.goal(s.ctx, 'Leave it in the backlog');
  assert.equal(out.kind, 'stopped');
  assert.deepEqual(s.visits.at(-1), { page: 'runs', params: { run: (out as { runId: string }).runId } });
  assert.match(s.flat, /Not dispatched · 3 cards/);
  assert.deepEqual(s.pushed, []);

  statuses = ['done', 'in_progress', 'backlog'];
  await launcher.goal(s.ctx, 'Stop it half way');
  assert.match(s.flat, /Stopped · 1\/3 done/);
});

test('a plan discarded at the plan pause leaves nothing to show', async (t) => {
  const s = setup(t);
  const { deps } = fakes((root, goal) => {
    const r = leaveRun(root, goal, []);
    store.removeRun(root, r.runId);
    return { ...r, aborted: true };
  });
  const out = await createLauncher({ ...deps, reviewPage: s.reviewPage }).goal(s.ctx, 'Never mind this one');
  assert.equal(out.kind, 'cancelled');
  assert.equal(s.visits.some((v) => v.page === 'runs'), false, 'stays where it was');
  assert.match(s.flat, /Plan discarded/);
});

test('uncommitted changes stop a goal with a dialog: open Settings, or start this one run anyway', async (t) => {
  const s = setup(t);
  writeFileSync(join(s.root, 'README.md'), 'changed\n');
  const { calls, deps } = fakes((root, goal) => leaveRun(root, goal, ['done']));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });

  let p = launcher.goal(s.ctx, 'Build it on a dirty tree');
  await tick();
  assert.match(s.text, /Uncommitted changes/);
  assert.match(s.flat, /· dirty tree/, 'the blocker as its state');
  assert.match(s.flat, /Start anyway: last commit only/, 'the one consequence that is not on screen');
  assert.match(s.flat, /Close .*Settings.* Start anyway/);
  s.screens.current.key(key('enter'));
  assert.deepEqual(await p, { kind: 'blocked' });
  assert.equal(calls.length, 0);
  assert.deepEqual(s.visits.at(-1), { page: 'settings', params: { key: 'dirty' } }, 'the fix is focused first');

  p = launcher.goal(s.ctx, 'Build it on a dirty tree');
  await tick();
  s.screens.current.key(key('right'));
  s.screens.current.key(key('enter'));
  assert.equal((await p).kind, 'finished');
  assert.equal(calls[0]!.session.allowDirty, true, 'this run may start from the last commit');
  assert.equal(s.session.allowDirty, false, 'the session still refuses a dirty tree');

  p = launcher.goal(s.ctx, 'Build it on a dirty tree');
  await tick();
  s.screens.current.key(key('escape'));
  assert.deepEqual(await p, { kind: 'blocked' });
});

test('several problems are listed together and only the first one’s fix is offered, with no way around them', async (t) => {
  const s = setup(t);
  writeFileSync(join(s.root, 'README.md'), 'changed\n');
  mkdirSync(join(s.root, '.dulger'), { recursive: true });
  writeFileSync(join(s.root, '.dulger/config.json'), JSON.stringify({ roles: { planner: { harness: 'ollama' } } }));
  git.git(s.root, ['add', '.dulger/config.json']);
  const { calls, deps } = fakes((root, goal) => leaveRun(root, goal, ['done']));
  const p = createLauncher({ ...deps, reviewPage: s.reviewPage }).goal(s.ctx, 'Plan it with no model');
  await tick();
  assert.match(s.text, /Cannot start/);
  assert.match(s.flat, /· dirty tree · no model: planner ollama/, 'each blocker, with its backend');
  assert.doesNotMatch(s.text, /Start anyway/);
  s.screens.current.key(key('escape'));
  assert.deepEqual(await p, { kind: 'blocked' });
  assert.equal(calls.length, 0);
});

test('a preflight failure is shown whole, with Doctor and the run it left behind', async (t) => {
  const s = setup(t);
  let left = '';
  const { deps } = fakes((root, goal) => {
    left = createBoard(root, goal).runId;
    throw new CliError('Preflight needs attention:\nFIX Git identity: Set user.name.\nFIX claude: Install claude on PATH and check claude --version.\nFIX planner model: Choose a model for ollama in /setup.');
  });
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const p = launcher.goal(s.ctx, 'This will not start');
  await tick();
  const shown = s.text;
  assert.match(shown, /Cannot start/);
  assert.doesNotMatch(shown, /These readiness checks failed/, 'the checks say it');
  assert.match(shown, /✗ Git identity: Set user\.name\./);
  assert.match(shown, /✗ claude: Install claude on PATH and check claude --version\./);
  assert.match(shown, /Choose a model for ollama on the Models tab\./, 'slash commands said the app’s way');
  assert.doesNotMatch(shown, /\/setup/);
  assert.match(s.flat, new RegExp(`Kept as ${left}`));
  assert.match(s.flat, /Close .*Doctor.* Open run/);
  s.screens.current.key(key('enter'));
  assert.deepEqual(await p, { kind: 'error', runId: left });
  assert.deepEqual(s.visits.at(-1), { page: 'doctor' });

  const again = launcher.goal(s.ctx, 'This will not start either');
  await tick();
  s.screens.current.key(key('right'));
  s.screens.current.key(key('enter'));
  await again;
  assert.deepEqual(s.visits.at(-1), { page: 'runs', params: { run: left } });
});

test('any other error is shown by its message, never a stack, and nothing rejects', async (t) => {
  const s = setup(t);
  const { deps } = fakes(() => { throw new Error('boom: the adapter fell over'); });
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const p = launcher.goal(s.ctx, 'Something odd happens');
  await tick();
  assert.match(s.text, /╭─ Error/);
  assert.match(s.text, /boom: the adapter fell over/);
  assert.doesNotMatch(s.text, /at .*\.ts:\d+/);
  s.screens.current.key(key('escape'));
  assert.equal((await p).kind, 'error');
});

test('resume and retry check the run first, then hand over with the run id', async (t) => {
  const s = setup(t);
  const { calls, deps } = fakes((root, runId) => ({ runId, runBranch: `dulger/${runId}`, landed: 0, aborted: true }));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });

  let p = launcher.resume(s.ctx, 'nope');
  await tick();
  assert.match(s.text, /Cannot resume nope/);
  assert.match(s.flat, /No run nope/);
  s.screens.current.key(key('enter'));
  assert.deepEqual(await p, { kind: 'blocked' });

  const run = leaveRun(s.root, 'Half done', ['done', 'failed', 'backlog']);
  writeFileSync(join(s.root, 'README.md'), 'changed\n');
  const resumed = launcher.resume(s.ctx, run.runId, { currentSettings: true });
  await tick();
  assert.match(s.flat, /Settings session/, 'asked first, naming the settings it uses');
  s.screens.current.key(ch('y'));
  assert.equal((await resumed).kind, 'stopped', 'a dirty tree does not stop a resume');
  assert.deepEqual(calls.at(-1)!.args, [run.runId, { currentSettings: true, settingsChosen: true, silent: true, screen: undefined }]);
  assert.match(s.flat, /Stopped · 1\/3 done · 1 failed/);

  p = launcher.retry(s.ctx, run.runId, 'c1');
  await tick();
  assert.match(s.text, /Nothing to retry/);
  assert.match(s.flat, /c1 Card 1 · done/, 'the card and its status');
  s.screens.current.key(key('enter'));
  assert.deepEqual(await p, { kind: 'blocked' });
  assert.equal(calls.length, 1);

  await launcher.retry(s.ctx, run.runId, 'c2');
  assert.deepEqual(calls.at(-1), { fn: 'retry', session: s.session, args: ['c2', run.runId] });
});

/** Save `config` with the run, as runBoard does when a run starts. */
function saveSettings(root: string, runId: string, config: Config): void {
  const b = store.loadBoard(root, runId);
  b.settings = snapshotSettings(config);
  store.saveBoard(root, b);
}

test('resume asks first: the run, what is left and the settings it keeps; Enter cancels, confirming passes the choice on', async (t) => {
  const s = setup(t);
  const { calls, deps } = fakes((root, runId) => ({ runId, runBranch: `dulger/${runId}`, landed: 0, aborted: true }));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const run = leaveRun(s.root, 'Finish the parser', ['done', 'in_progress', 'backlog', 'failed']);
  saveSettings(s.root, run.runId, sessionConfig(s.root, s.session));
  let p = launcher.resume(s.ctx, run.runId);
  await tick();
  assert.match(s.text, new RegExp(`Resume ${run.runId}`));
  assert.match(s.flat, /Finish the parser/);
  assert.match(s.flat, /Done 1\/4 · To build 2 · 1 interrupted · Failed 1 · stays failed/, 'what is left, as numbers');
  assert.doesNotMatch(s.flat, /· Settings/, 'the same settings: nothing to say');
  assert.doesNotMatch(s.flat, /Use session settings/, 'nothing to choose');
  s.screens.current.key(key('enter'));
  assert.deepEqual(await p, { kind: 'blocked' });
  assert.equal(calls.length, 0, 'Enter is on Cancel: resuming starts agents');
  p = launcher.resume(s.ctx, run.runId);
  await tick();
  s.screens.current.key(ch('y'));
  await p;
  assert.deepEqual(calls.map((c) => c.args), [[run.runId, { currentSettings: false, settingsChosen: true, silent: true, screen: undefined }]], 'the run is told the settings are chosen, so it does not ask');

  const empty = leaveRun(s.root, 'Plan me again', []);
  p = launcher.resume(s.ctx, empty.runId);
  await tick();
  assert.match(s.flat, /Plan none, plans again/);
  assert.match(s.flat, /Settings session/, 'saved none: it goes on with this session\'s');
  s.screens.current.key(key('escape'));
  assert.deepEqual(await p, { kind: 'blocked' });
});

test('resume with settings that differ: the differences are listed, the run\'s own come first, either choice reaches the run', async (t) => {
  const s = setup(t);
  const { calls, deps } = fakes((root, runId) => ({ runId, runBranch: `dulger/${runId}`, landed: 0, aborted: true }));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const run = leaveRun(s.root, 'Two left', ['done', 'backlog', 'backlog']);
  saveSettings(s.root, run.runId, { ...sessionConfig(s.root, s.session), concurrency: 1, docs: false });
  s.session.overrides.concurrency = 4;
  // Wrapped: an async function returning the launch would wait for it.
  const ask = async () => { const p = launcher.resume(s.ctx, run.runId); await tick(); return { p }; };

  let { p } = await ask();
  const flat = s.flat;
  assert.match(flat, /Done 1\/3 · To build 2/);
  assert.match(flat, /Settings run → session/);
  assert.match(flat, /Parallel cards\s+1 → 4/);
  assert.match(flat, new RegExp(`${findSetting('docs')!.label}\\s+off → on`));
  assert.match(flat, /Use session: saved with the run/, 'the one consequence that is not on screen');
  assert.match(flat, /Cancel\W+Keep original\W+Use session/);
  assert.doesNotMatch(flat, /Details/, 'every difference is in the list');
  assertFrame(s.screens.current.lines, 24, 100, 'resume dialog');
  s.screens.current.key(key('enter'));
  assert.deepEqual(await p, { kind: 'blocked' }, 'Enter on Cancel');
  assert.equal(calls.length, 0);

  ({ p } = await ask());
  s.screens.current.key(key('right'));
  s.screens.current.key(key('enter'));
  await p;
  assert.deepEqual(calls.at(-1)!.args, [run.runId, { currentSettings: false, settingsChosen: true, silent: true, screen: undefined }], 'the original settings, first after Cancel');

  ({ p } = await ask());
  s.screens.current.key(key('right'));
  s.screens.current.key(key('right'));
  s.screens.current.key(key('enter'));
  await p;
  assert.deepEqual(calls.at(-1)!.args, [run.runId, { currentSettings: true, settingsChosen: true, silent: true, screen: undefined }], 'this session\'s, explicitly');

  ({ p } = await ask());
  s.screens.current.key(key('ctrl', 'c'));
  assert.deepEqual(await p, { kind: 'blocked' }, 'Ctrl-C cancels the dialog');
  assert.equal(calls.length, 2);
  for (const [rows, cols] of SIZES) {
    ({ p } = await ask());
    s.screens.current.resize(rows, cols);
    assertFrame(s.screens.current.lines, rows, cols, 'resume dialog');
    s.screens.current.resize(24, 100);
    s.screens.current.key(key('escape'));
    await p;
  }
});

test('resume: a difference the list cannot say is one step away, in Details; the problems checked are the chosen settings\'', async (t) => {
  const s = setup(t);
  const { calls, deps } = fakes((root, runId) => ({ runId, runBranch: `dulger/${runId}`, landed: 0, aborted: true }));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const run = leaveRun(s.root, 'Odd settings', ['backlog']);
  saveSettings(s.root, run.runId, { ...sessionConfig(s.root, s.session), stallTimeoutSec: 60 });
  const p = launcher.resume(s.ctx, run.runId);
  await tick();
  assert.match(s.flat, /Differ\s+Stall timeout/, 'named, not by its config key');
  assert.match(s.flat, /Cancel\W+Details\W+Keep original\W+Use session/);
  s.screens.current.key(key('right'));
  s.screens.current.key(key('enter'));
  await tick();
  assert.match(s.flat, /Stall timeout Run: 60 Session: 600/);
  s.screens.current.key(key('escape'));
  await tick();
  assert.match(s.flat, /Keep original/, 'back in the dialog');
  s.screens.current.key(key('right'));
  s.screens.current.key(key('right'));
  s.screens.current.key(key('right'));
  s.screens.current.key(key('enter'));
  await p;
  assert.equal((calls.at(-1)!.args[1] as { currentSettings: boolean }).currentSettings, true);
});

test('a resume whose provider has no key is stopped before the terminal is handed over', async (t) => {
  const s = setup(t);
  mkdirSync(join(s.root, '.dulger'), { recursive: true });
  writeFileSync(join(s.root, '.dulger/config.json'), JSON.stringify({ providers: { groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'DULGER_TEST_NO_KEY', model: 'm' } }, roles: { docs: { harness: 'groq' } } }));
  delete process.env.DULGER_TEST_NO_KEY;
  const run = leaveRun(s.root, 'Needs groq', ['backlog']);
  const { calls, deps } = fakes((root, runId) => ({ runId, runBranch: '', landed: 0, aborted: false }));
  const p = createLauncher({ ...deps, reviewPage: s.reviewPage }).resume(s.ctx, run.runId);
  await tick();
  s.screens.current.key(ch('y'));
  await tick();
  assert.match(s.text, /Cannot start/);
  assert.match(s.flat, /no key: groq DULGER_TEST_NO_KEY/);
  s.screens.current.key(key('enter'));
  assert.deepEqual(await p, { kind: 'blocked' });
  assert.deepEqual(s.visits.at(-1), { page: 'providers', params: { provider: 'groq' } });
  assert.equal(calls.length, 0);
});

test('a real goal on the fake harness runs through the launcher, prints nothing of its own and opens its review', async (t) => {
  const s = setup(t, { session: { yes: true, quiet: true, overrides: { harness: 'fake', docs: false, progressIntervalSec: 0, concurrency: 1, maxReplans: 0, maxAttempts: 1 } } });
  // c2 never passes review, so its worktree is kept: the line prompt would print where.
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: plan(2), checker: (o) => (/Card under review: c2 /.test(o.prompt) ? { pass: false, feedback: ['not yet'], summary: 'no' } : { pass: true, feedback: [], summary: 'ok' }), delayMs: 1 }));
  const printed: string[] = [];
  const written: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => { printed.push(a.join(' ')); });
  // Passed through: the test runner's own reports travel on stdout too (as buffers).
  const write = process.stdout.write.bind(process.stdout) as (...a: unknown[]) => boolean;
  t.mock.method(process.stdout, 'write', (chunk: unknown, ...rest: unknown[]) => { if (typeof chunk === 'string') written.push(chunk); return write(chunk, ...rest); });
  const out = await createLauncher({ reviewPage: s.reviewPage }).goal(s.ctx, 'Make two real things');
  t.mock.restoreAll();
  assert.equal(out.kind, 'finished');
  assert.equal((out as { landed: number }).landed, 1);
  const runId = (out as { runId: string }).runId;
  assert.deepEqual(s.pushed, [runId]);
  assert.equal(git.currentBranch(s.root), 'main', 'nothing merged');
  // Quiet: the log lines are the live view. Nothing else: no banner, no report, no kept-worktrees line.
  assert.ok(printed.length > 0, 'the log lines still print');
  for (const line of printed) assert.match(line, /^\d\d:\d\d:\d\d /, `only log lines: ${line}`);
  assert.doesNotMatch(printed.join('\n'), /dulger run|failed worktrees kept|^Run /m);
  assert.deepEqual(written, [], 'and no report written to stdout');
  const kept = keptWorktrees(s.root, store.loadBoard(s.root, runId));
  assert.ok(kept && existsSync(join(kept, 'c2')), 'the app knows where the failed card\'s worktree is');
});

test('the notice dialog fits every size, keeps line breaks and scrolls long text', () => {
  const g = glyphs('unicode');
  const message = ['First line.', '', ...Array.from({ length: 30 }, (_, i) => `Check ${i + 1}: something to read in full`)].join('\n');
  for (const [rows, cols] of SIZES) {
    const s = createNotice({ title: 'Problems', message, actions: [{ id: 'a', label: 'Open Doctor', primary: true }] });
    const r = renderNotice(s, { rows, cols }, g);
    assert.ok(r.lines.length <= rows, `${rows}x${cols}: ${r.lines.length} rows`);
    for (const l of r.lines) assert.ok(width(l) <= cols, `${rows}x${cols}: ${width(l)} wide`);
  }
  const s = createNotice({ title: 'Problems', message, actions: [{ id: 'a', label: 'Open Doctor', primary: true }] });
  const text = (rows: number) => renderNotice(s, { rows, cols: 80 }, g).lines.map(plain).join('\n');
  const first = text(12);
  assert.match(first, /First line\.\s+│\n│\s+│\n│\s+Check 1:/, 'the blank line is kept');
  assert.match(first, /↑↓ 1-/, 'says it scrolls');
  s.top = 100;
  assert.match(text(12), /Check 30:/);
  assert.match(text(12), /Close\s+\[? ?Open Doctor/);
});

test('the notice dialog over the app frames exactly at every size', async (t) => {
  const s = setup(t);
  const { deps } = fakes(() => { throw new CliError('Preflight needs attention:\nFIX a: one\nFIX b: two'); });
  const p = createLauncher({ ...deps, reviewPage: s.reviewPage }).goal(s.ctx, 'Show the dialog please');
  await tick();
  for (const [rows, cols] of SIZES) {
    s.screens.current.resize(rows, cols);
    assertFrame(s.screens.current.lines, rows, cols, 'notice');
  }
  s.screens.current.resize(24, 100);
  s.screens.current.key(key('escape'));
  await p;
});

test('readable() says slash commands the app’s way and marks preflight lines', () => {
  const g = glyphs('ascii');
  assert.equal(readable('working tree has uncommitted changes (commit them, or /dirty on)', g), 'working tree has uncommitted changes (commit them, or allow uncommitted changes in Settings)');
  assert.equal(readable('c1: set GROQ_API_KEY or use /provider groq key.', g), 'c1: set GROQ_API_KEY or add its key on the Providers tab.');
  assert.equal(readable('FIX x: Choose a model for ollama in /setup.\nNOTE y: z\nOK w: v', g), 'x x: Choose a model for ollama on the Models tab.\n! y: z\nv w: v');
  assert.equal(readable('unknown setting "x" (see /help)', g), 'unknown setting "x"');
});

test('a readiness check that fails stops a goal before any run record exists', async (t) => {
  // Concurrency 0 is a readiness error (preflight's Settings check): nothing spawns for it.
  const s = setup(t, { session: { overrides: { harness: 'fake', concurrency: 0 } } });
  const { calls, deps } = fakes((root, goal) => leaveRun(root, goal, ['done']));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const p = launcher.goal(s.ctx, 'A goal that cannot start yet');
  await tick();
  assert.match(s.flat, /Cannot start/);
  assert.match(s.flat, /invalid settings concurrency must be at least 1/, 'the state, and the check\'s own words');
  s.screens.current.key(key('escape'));
  assert.deepEqual(await p, { kind: 'blocked' }, 'blocked, so Home keeps the goal in its box');
  assert.equal(calls.length, 0, 'nothing ran');
  assert.deepEqual(store.listRuns(s.root), [], 'no run record was made');
});

test('when the saved settings file is the only uncommitted change, the launch offers to commit it and goes on', async (t) => {
  const s = setup(t);
  mkdirSync(join(s.root, '.dulger'), { recursive: true });
  writeFileSync(join(s.root, '.dulger/config.json'), '{}\n');
  git.git(s.root, ['add', '.dulger/config.json']);
  git.git(s.root, ['commit', '-qm', 'settings']);
  writeFileSync(join(s.root, '.dulger/config.json'), '{ "concurrency": 2 }\n');
  const { calls, deps } = fakes((root, goal) => leaveRun(root, goal, ['done']));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const p = launcher.goal(s.ctx, 'Build it after the commit');
  await tick();
  assert.match(s.flat, /Settings uncommitted/);
  assert.match(s.flat, /settings uncommitted \.dulger\/config\.json/, 'the file is named');
  assert.match(s.flat, /\[ Commit \]/, 'committing is the first choice');
  s.screens.current.key(key('enter'));
  await tick();
  assert.match(s.flat, /Commit settings/);
  assert.match(s.flat, /Branch\s+main/);
  s.screens.current.key(ch('y'));
  await p;
  assert.equal(calls.at(-1)?.fn, 'goal', 'the launch went on once the file was committed');
  assert.equal(git.isClean(s.root), true);
});

test('resume differences say how the run and this session compare, and Details shows only what differs', async (t) => {
  const s = setup(t);
  const { deps } = fakes((root, runId) => ({ runId, runBranch: `dulger/${runId}`, landed: 0, aborted: true }));
  const launcher = createLauncher({ ...deps, reviewPage: s.reviewPage });
  const run = leaveRun(s.root, 'Provider later', ['backlog']);
  // Saved with a stall timeout the list cannot name, so Details is offered.
  saveSettings(s.root, run.runId, { ...sessionConfig(s.root, s.session), stallTimeoutSec: 60 });
  // A provider set up after the run started (in the repository's file, or this session: it cannot tell which).
  s.session.overrides.providers = { local: { baseUrl: 'http://localhost:1234/v1', maxTurns: 40, maxTokens: 8192, timeoutSec: 300, retries: 3, commandTimeoutSec: 600 } };
  const p = launcher.resume(s.ctx, run.runId);
  await tick();
  assert.match(s.flat, /Provider local\s+session only/);
  assert.doesNotMatch(s.flat, /added in this session/, 'it does not claim where it came from');
  s.screens.current.key(key('right'));
  s.screens.current.key(key('enter'));
  await tick();
  assert.match(s.flat, / settings /, 'Details opened');
  assert.match(s.flat, /Providers Run: \{\} Session: \{ "local"/, 'named, and only the provider that differs');
  assert.doesNotMatch(s.flat, /"ollama"|"deepseek"/, 'not every built-in provider');
  s.screens.current.key(key('escape'));
  await tick();
  s.screens.current.key(key('escape'));
  await p;
});
