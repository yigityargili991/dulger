// Fixtures for the Runs tab and result review tests (not a test file itself): temporary repositories
// with runs in every state, written as boards or made by the fake harness, and the app driven on a
// fake screen.
import type { TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { createApp } from '../src/app/shell.ts';
import type { AppContext, Page, PageFactory } from '../src/app/types.ts';
import type { IconSet } from '../src/tui/theme.ts';
import type { Board, PlannerResult } from '../src/types.ts';
import { fakeScreens } from './kit.helpers.ts';

process.env.DULGER_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'dulger-app-runs-data-'));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-app-runs-home-'));

export const config = (): Config => ({ ...structuredClone(DEFAULT_CONFIG), harness: 'fake', docs: false, progressIntervalSec: 0, concurrency: 1, maxReplans: 0 });

export function repo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-runs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']);
  git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git.git(root, ['add', '.']);
  git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

/** Commit files on the run's branch, as landed cards would; returns the new tip. */
export function land(root: string, board: Pick<Board, 'runId' | 'runBranch'>, files: Record<string, string | Buffer>): string {
  const wt = join(root, '..', `${board.runId}-wt-${Math.random().toString(36).slice(2)}`);
  git.git(root, ['worktree', 'add', '-q', wt, board.runBranch]);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, file)), { recursive: true });
    writeFileSync(join(wt, file), text);
  }
  git.git(wt, ['add', '.']);
  git.git(wt, ['commit', '-qm', `land ${Object.keys(files).join(' ')}`]);
  const ref = git.git(wt, ['rev-parse', 'HEAD']);
  git.git(root, ['worktree', 'remove', '--force', wt]);
  return ref;
}

export const plan = (): PlannerResult => ({ cards: [
  { id: 'c1', title: 'Parse the config', description: 'Read config.json and validate it.', acceptanceCriteria: ['rejects bad JSON'], dependsOn: [], verify: ['node --test test/config.test.js'],
    tasks: [{ id: 't1', title: 'Implement the parser', instructions: 'Write it' }] },
  { id: 'c2', title: 'Add the health endpoint', description: 'Serve GET /health.', acceptanceCriteria: ['returns 200'], dependsOn: ['c1'],
    verify: ['npm test', "curl -fsS http://localhost:3000/health | grep -q '\"ok\":true' && echo 'the endpoint answers with ok, which is what the acceptance criteria ask for'"],
    tasks: [{ id: 't1', title: 'Write the handler', instructions: 'Write it' }] },
  { id: 'c3', title: 'Document it', description: 'Docs.', acceptanceCriteria: ['README mentions it'], dependsOn: ['c2'], verify: [], tasks: [{ id: 't1', title: 'Docs', instructions: 'Write it' }] },
] });

const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

/** Landed, verified on its current tip, documented: ready to merge. */
export function readyRun(root: string, id = 'r-ready', files: Record<string, string | Buffer> = { 'feature.txt': 'new\n' }): Board {
  const b = createBoard(root, 'Add a feature file', id);
  b.cards = store.cardsFromPlan(plan());
  for (const c of b.cards) c.status = 'done';
  b.cards[0]!.verification = [{ command: 'node --test test/config.test.js', ok: true, exitCode: 0, durationMs: 1200, output: 'ok' }];
  const ref = land(root, b, files);
  b.settings = { version: 1, config: config() };
  b.finalVerification = { ref, results: [{ command: 'node --test test/config.test.js', ok: true, exitCode: 0, durationMs: 1500, output: '' }] };
  b.docs = { status: 'done', summary: 'Documented the feature.' };
  b.costUsd = 0.42;
  b.createdAt = ago(1);
  store.saveBoard(root, b);
  return b;
}

/** c1 done, c2 failed with feedback and a failing verify command, c3 blocked; final verification failed. */
export function attentionRun(root: string, id = 'r-attention'): Board {
  const b = createBoard(root, 'Add a health endpoint with a config parser', id);
  b.cards = store.cardsFromPlan(plan());
  const ref = land(root, b, { 'config.js': 'export const parse = JSON.parse;\n' });
  b.cards[0]!.status = 'done';
  b.cards[0]!.costUsd = 0.3;
  b.cards[1]!.status = 'failed';
  b.cards[1]!.failure = 'work';
  b.cards[1]!.attempts = 2;
  b.cards[1]!.feedback = ['The handler returns 500 when the config is missing.', 'Still failing: expected {"ok":true}.'];
  b.cards[1]!.verification = [{ command: 'npm test', ok: false, exitCode: 1, durationMs: 4321, output: 'not ok 1 - GET /health\n# fail 1' }];
  b.cards[2]!.status = 'blocked';
  b.cards[2]!.reason = 'blocked: depends on c2, which failed';
  b.settings = { version: 1, config: { ...config(), concurrency: 4 } };
  b.finalVerification = { ref, results: [{ command: 'npm run lint', ok: false, exitCode: 2, durationMs: 800, output: 'lint: 3 problems\nsrc/a.ts: unused import' }] };
  b.docs = { status: 'skipped' };
  b.createdAt = ago(30);
  store.saveBoard(root, b);
  return b;
}

/** Planned, nothing started. */
export function unstartedRun(root: string, id = 'r-unstarted'): Board {
  const b = createBoard(root, 'Refactor the scheduler', id);
  b.cards = store.cardsFromPlan(plan());
  b.checkpoint = { phase: 'ready', at: ago(70) };
  b.createdAt = ago(72);
  store.saveBoard(root, b);
  return b;
}

/** Finished, but its branch was deleted. */
export function missingBranchRun(root: string, id = 'r-missing'): Board {
  const b = createBoard(root, 'Write the migration guide', id);
  b.cards = store.cardsFromPlan({ cards: [{ ...plan().cards[2]!, dependsOn: [] }] });
  b.cards[0]!.status = 'done';
  b.docs = { status: 'done' };
  b.createdAt = ago(96);
  store.saveBoard(root, b);
  git.deleteBranch(root, b.runBranch);
  return b;
}

export function unreadableRun(root: string, id = 'r-broken'): void {
  createBoard(root, 'broken', id);
  writeFileSync(store.boardPath(root, id), '{ not json');
}

/** A real run from the fake harness, finished in well under a second. */
export async function realRun(root: string, t: TestContext): Promise<string> {
  const { createFakeAdapter, DEFAULT_FAKE_SCRIPT } = await import('../src/adapters/fake.ts');
  const { registerAdapter } = await import('../src/adapters/index.ts');
  const { runGoal } = await import('../src/sessionRuns.ts');
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: { cards: [plan().cards[2]!].map((c) => ({ ...c, dependsOn: [] })) }, checker: () => ({ pass: true, feedback: [], summary: 'ok' }), delayMs: 1 }));
  t.mock.method(console, 'log', () => {});
  const r = await runGoal(root, { overrides: { harness: 'fake', docs: false, progressIntervalSec: 0, concurrency: 1, maxReplans: 0 }, yes: true, quiet: true, allowDirty: false }, 'Write the docs');
  t.mock.restoreAll();
  return r.runId;
}

export const homePage: PageFactory = () => ({ id: 'home', title: 'Home', render: () => ({ lines: ['home page'] }), onKey: () => false, hints: () => [] });

/** The app with `pages` on a fake screen; `settle` lets dialogs and async handlers run. */
export function app(root: string, pages: PageFactory[], size: { rows: number; cols: number } = { rows: 40, cols: 120 }, icons: IconSet = 'unicode') {
  const screens = fakeScreens(size.rows, size.cols);
  let ctx: AppContext | undefined;
  const wrapped = pages.map((make) => (c: AppContext): Page => { ctx = c; return make(c); });
  const a = createApp({ repoRoot: root, session: { overrides: { harness: 'fake' }, yes: false, quiet: false, allowDirty: false }, version: 'test', config, pages: wrapped, openScreen: screens.factory, icons, branch: () => 'main' });
  const done = a.run();
  return {
    app: a, done, screens,
    get ctx() { return ctx!; },
    get s() { return screens.current; },
    async settle(n = 4) { for (let i = 0; i < n; i++) await sleep(0); },
    async quit() { a.quit(); await done; },
  };
}
