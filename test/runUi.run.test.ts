// Real runBoard calls on the fake harness: the view is closed whatever stops the run after it opened
// (on a terminal and on the app's lent screen), a board file's branch and id are only data, and --yes
// keeps a whole record of what it accepted while agents' messages reach the plain output plain.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createLauncher } from '../src/app/run.ts';
import { sessionConfig } from '../src/replModels.ts';
import { SETTLE_MS } from '../src/tui/tui.ts';
import type { Session } from '../src/repl.ts';
import type { PlannerResult } from '../src/types.ts';
import { fakeScreens, key } from './kit.helpers.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-runui-data-'));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-runui-home-'));
const config: Config = { ...structuredClone(DEFAULT_CONFIG), harness: 'fake', docs: false, progressIntervalSec: 0, concurrency: 1, maxReplans: 0 };
/** A configuration the orchestrator trips over after preflight passed and the view opened. */
const broken = { ...config, memory: undefined } as unknown as Config;

function repo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-runui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

function terminal(t: TestContext): void {
  const was = { out: process.stdout.isTTY, inp: process.stdin.isTTY };
  process.stdout.isTTY = true;
  process.stdin.isTTY = true;
  t.after(() => { process.stdout.isTTY = was.out; process.stdin.isTTY = was.inp; });
}

async function until(fn: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const plan = (verify: string[] = []): PlannerResult => ({ cards: [{ id: 'c1', title: 'One', description: 'Implement one thing', acceptanceCriteria: ['done'], dependsOn: [], verify, tasks: [{ id: 't1', title: 'Implement', instructions: 'Write something' }] }] });
const goodCheck = () => ({ pass: true, feedback: [], summary: 'looks good' });

test('a run that fails after its view opened closes the view first: screen, timer and keys', async (t) => {
  const root = repo(t);
  terminal(t);
  t.mock.method(console, 'log', () => {});
  const screens = fakeScreens(24, 80);
  await assert.rejects(runBoard(root, createBoard(root, 'goal'), broken, { yes: true, quiet: false, merge: false, fresh: true, interactive: true, silent: true, screen: screens.factory }));
  assert.equal(screens.made.length, 1, 'the view had opened');
  assert.equal(screens.current.closed, 1, 'and it was closed');
  // The fake screen throws on a paint after close: a timer left behind would fail this test from here.
  await pause(250);
  screens.current.key(key('ctrl', 'c'));
});

test('from the app, a run that fails after its view opened gives the screen back and the app tells the error', async (t) => {
  const root = repo(t);
  terminal(t);
  const session: Session = { overrides: { harness: 'fake' }, yes: true, quiet: false, allowDirty: false };
  const screens = fakeScreens(24, 100);
  const page = { id: 'home', title: 'Home', render: () => ({ lines: ['home page'] }), onKey: () => false, hints: () => [] };
  const app = createApp({ repoRoot: root, session, version: 't', config: () => sessionConfig(root, session), icons: 'unicode', branch: () => 'main', pages: [() => page], openScreen: screens.factory });
  const done = app.run();
  t.after(async () => { app.quit(); await done; });
  const launcher = createLauncher({
    runGoal: async (r, _s, goal, o = {}) => {
      const b = createBoard(r, goal);
      const outcome = await runBoard(r, b, broken, { yes: true, quiet: false, merge: false, fresh: true, interactive: true, silent: o.silent, screen: o.screen });
      return { runId: b.runId, runBranch: b.runBranch, ...outcome };
    },
  });
  const launched = launcher.goal(app.ctx, 'Break after the view opened');
  await until(() => /reading 'location'/.test(screens.current.text), `the error in the app:\n${screens.current.text}`);
  const shown = screens.current.text;
  await pause(250);
  assert.equal(screens.current.text, shown, 'nothing paints over the app afterwards');
  assert.match(shown, /location/, 'the error itself is told');
  screens.current.key(key('escape'));
  await launched;
});

test('cancelling a run whose board names some other branch deletes the run, never that branch', async (t) => {
  const root = repo(t);
  terminal(t);
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: plan(), checker: goodCheck, delayMs: 1 }));
  t.mock.method(console, 'log', () => {});
  git.git(root, ['branch', 'keep-me']);
  const b = createBoard(root, 'goal');
  b.runBranch = 'keep-me';
  store.saveBoard(root, b);
  const screens = fakeScreens(30, 110);
  const run = resumeRun(root, config, b.runId, { quiet: false, merge: false, interactive: true, silent: true, screen: screens.factory });
  await until(() => /Dispatch/.test(screens.current.text), 'the plan review');
  await pause(SETTLE_MS + 20);
  for (let i = 0; i < 3; i++) screens.current.key(key('right'));
  screens.current.key(key('enter'));
  await until(() => /Delete run/.test(screens.current.text), 'the confirmation');
  screens.current.key(key('right'));
  screens.current.key(key('enter'));
  assert.deepEqual(await run, { landed: 0, aborted: true });
  assert.ok(!existsSync(store.runDir(root, b.runId)), 'the run is gone');
  assert.ok(git.branchExists(root, 'keep-me'), 'the branch the board named is not');
});

test('a board that names itself another run is refused before anything runs or is deleted', async (t) => {
  const root = repo(t);
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: plan(), checker: goodCheck, delayMs: 1 }));
  t.mock.method(console, 'log', () => {});
  const b = createBoard(root, 'goal');
  store.saveBoard(root, b);
  const path = store.boardPath(root, b.runId);
  writeFileSync(path, readFileSync(path, 'utf8').replace(`"runId": "${b.runId}"`, '"runId": "../../.."'));
  // The store refuses it on load now; the run's own check (loadRun) stays behind it.
  await assert.rejects(resumeRun(root, config, b.runId, { quiet: true, merge: false }), /names itself|must match/);
  assert.ok(existsSync(path), 'nothing was removed');
  assert.equal(lockOwner(root, b.runId), undefined, 'and no lock is left');
});

test('--yes keeps the whole record of the commands it accepted, and what agents say reaches the plain output plain', async (t) => {
  const root = repo(t);
  const long = `node -e "${'x'.repeat(320)}" && test -f README.md`;
  // c1 never passes review and c2 waits for it, so the run replans; the replan's answer is invalid in a hostile way.
  const first = plan([long]); first.cards.push({ ...first.cards[0]!, id: 'c2', title: 'Two', dependsOn: ['c1'] });
  registerAdapter('fake', createFakeAdapter({
    planner: (_o, i) => (i === 0 ? first : { cards: [{ ...plan().cards[0]!, id: 'c3', title: 'Three', dependsOn: ['zz\x1b]2;owned'] }] }),
    checker: (o) => (/Card under review: c1 /.test(o.prompt) ? { pass: false, feedback: ['not yet'], summary: '' } : goodCheck()),
    delayMs: 1,
  }));
  const out: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => { out.push(a.join(' ')); });
  await runBoard(root, createBoard(root, 'goal'), { ...config, maxReplans: 1 }, { yes: true, assumeYes: true, quiet: true, merge: false, fresh: true });
  const text = out.join('\n');
  assert.ok(out.some((l) => l.includes(`--yes: dispatching without a review; verify commands: \`${long}\``)), 'the accepted command is on record whole, on one line');
  assert.match(text, /replan failed/);
  assert.doesNotMatch(text.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, 'no escape from the planner reached the terminal');
});

test('`dulger runs` piped prints no escape sequence, also where a long goal is cut', async (t) => {
  const root = repo(t);
  const { showRuns } = await import('../src/commands.ts');
  const b = createBoard(root, `Refactor the greeting module into a class with full test coverage and ${'more words '.repeat(20)}`);
  store.saveBoard(root, b);
  const out: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => { out.push(a.join(' ')); });
  showRuns(root);
  assert.ok(out.some((l) => l.includes('Refactor the greeting') && l.endsWith('…')), out.join('\n'));
  for (const l of out) assert.doesNotMatch(l, /\x1b/, JSON.stringify(l));
});
