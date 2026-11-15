import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, roleConfig, type Config } from '../src/config.ts';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { acquireRunLock } from '../src/board/lock.ts';
import { createOrchestrator } from '../src/runner/orchestrator.ts';
import { createFakeAdapter, DEFAULT_FAKE_SCRIPT } from '../src/adapters/fake.ts';
import { registerAdapter, getAdapter } from '../src/adapters/index.ts';
import { capabilities } from '../src/adapters/capabilities.ts';
import { snapshotSettings, originalSettings, settingsChanges } from '../src/runSettings.ts';
import { saveProfile, readProfiles, applyProfile } from '../src/profiles.ts';
import { sessionConfig } from '../src/replModels.ts';
import { preflight, cardModelIssues } from '../src/preflight.ts';
import { editPlan, validatePlanDraft } from '../src/planEditor.ts';
import { runStatus, recoverableRuns } from '../src/runViews.ts';
import { approveReplanCommands, mergeRun, runBoard, resumeRun, type RunUi } from '../src/commands.ts';
import { runVerification } from '../src/runner/verify.ts';
import type { Session } from '../src/repl.ts';
import type { PlannerResult } from '../src/types.ts';
import type { Selection, SelectOptions } from '../src/tui/select.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-feature-data-'));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-feature-home-'));
const config: Config = { ...structuredClone(DEFAULT_CONFIG), harness: 'fake', docs: false, progressIntervalSec: 0, concurrency: 1, maxReplans: 0 };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dulger-features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}
const plan = (verify: string[] = []): PlannerResult => ({ cards: [{ id: 'c1', title: 'One', description: 'Implement one thing', acceptanceCriteria: ['done'], dependsOn: [], verify, tasks: [{ id: 't1', title: 'Implement', instructions: 'Write something' }] }] });
const goodCheck = () => ({ pass: true, feedback: [], summary: 'looks good' });
const fake = () => createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: plan(), checker: goodCheck, delayMs: 1 });

test('snapshot excludes unknown credential fields, is independent and detects changes', () => {
  const c = structuredClone(config);
  (c as unknown as Record<string, unknown>).apiKey = 'SECRET';
  (c.providers.openai as unknown as Record<string, unknown>).apiKey = 'SECRET';
  const snapshot = snapshotSettings(c);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  c.concurrency = 20;
  assert.equal(snapshot.config.concurrency, 1);
  assert.deepEqual(settingsChanges(snapshot.config, c), ['concurrency']);
  const b = { settings: snapshot } as Parameters<typeof originalSettings>[0];
  assert.equal(originalSettings(b, c).concurrency, 1);
  c.providers.openai!.baseUrl = 'https://host/v1?api_key=SECRET';
  assert.throws(() => snapshotSettings(c), /must not contain/);
});

test('profiles preserve the complete model mix and disabled budgets above repository defaults', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify({ budgetUsd: 99, roles: { worker: { model: 'old', maxBudgetUsd: 9 } } }));
  const c = structuredClone(config); c.roles.checker = { harness: 'codex', model: 'custom' };
  saveProfile(root, 'Local development', c);
  assert.throws(() => saveProfile(root, 'Local development', c), /already exists/);
  assert.throws(() => saveProfile(root, '../escape', c), /1–60/);
  const session: Session = { overrides: {}, model: 'old-global', modelRoles: { worker: { model: 'stale' } }, yes: true, quiet: false, allowDirty: false };
  applyProfile(session, readProfiles(root)['Local development']!);
  const effective = sessionConfig(root, session);
  assert.equal(effective.budgetUsd, undefined);
  assert.equal(roleConfig(effective, 'worker').model, undefined);
  assert.equal(roleConfig(effective, 'worker').maxBudgetUsd, undefined);
  assert.equal(roleConfig(effective, 'checker').model, 'custom');
  assert.equal(session.yes, true);
});

test('run locks exclude another process, release cleanly, and recover dead owners', (t) => {
  const root = fixture(t); const b = createBoard(root, 'test', 'locked');
  const release = acquireRunLock(root, b.runId);
  assert.throws(() => acquireRunLock(root, b.runId), /already in use/);
  const code = `import { acquireRunLock } from ${JSON.stringify(new URL('../src/board/lock.ts', import.meta.url).href)}; try { acquireRunLock(${JSON.stringify(root)}, 'locked'); process.exit(2); } catch { process.exit(0); }`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code]).status, 0);
  release(); release();
  const dir = join(store.runDir(root, b.runId), 'execution.lock');
  mkdirSync(dir);
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147483647, host: hostname(), token: 'dead' }));
  const again = acquireRunLock(root, b.runId); again();
  assert.ok(!existsSync(dir));
});

test('preflight reports missing models, keys and unsupported role budgets without agent calls', (t) => {
  const root = fixture(t);
  const c = structuredClone(config);
  c.harness = 'openai'; c.providers.openai!.apiKeyEnv = 'DULGER_TEST_MISSING_KEY_723901';
  delete process.env.DULGER_TEST_MISSING_KEY_723901;
  c.roles.worker = { maxBudgetUsd: 2 };
  const checks = preflight(root, c);
  assert.ok(checks.some((r) => r.status === 'error' && r.label === 'worker model'));
  assert.ok(checks.some((r) => r.status === 'error' && r.label === 'openai credentials'));
  assert.ok(checks.some((r) => r.status === 'error' && r.label === 'worker budget'));
  assert.equal(capabilities(getAdapter('codex', c)).toolFree, false);
  assert.equal(capabilities(getAdapter('openai', c)).modelDiscovery, true);
  assert.ok(!preflight(root, config).some((r) => r.status === 'error'));
  const cards = store.cardsFromPlan(plan()); cards[0]!.worker = { harness: 'openai' };
  assert.ok(cardModelIssues(c, cards).some((message) => message.includes('choose a worker model')));
});

test('plan editor validates dependencies, persists pins, preserves shell pipes and rolls back cancel', async (t) => {
  const root = fixture(t); const b = createBoard(root, 'edit', 'edit');
  b.cards = store.cardsFromPlan(plan()); store.saveBoard(root, b);
  const steps: Selection[] = ['c1', 'description', undefined];
  const io = { select: async (_o: SelectOptions) => steps.shift(), ask: async () => 'Changed draft' };
  assert.equal(await editPlan(root, b, config, io), false);
  assert.equal(b.cards[0]!.description, 'Implement one thing');
  const choices: Selection[] = ['c1', 'verify', ':add', 'c1', 'worker', 'fake', ':save'];
  const values = ['echo a | cat', 'my-model'];
  assert.equal(await editPlan(root, b, config, { select: async () => choices.shift(), ask: async () => values.shift() }), true);
  assert.deepEqual(store.loadBoard(root, b.runId).cards[0]!.verify, ['echo a | cat']);
  assert.equal(roleConfig(config, 'worker', { card: b.cards[0], task: { ...b.cards[0]!.tasks[0]!, attempts: 5, complexity: 'high' } }).model, 'my-model');
  const bad = structuredClone(b); bad.cards[0]!.dependsOn = ['missing'];
  assert.throws(() => validatePlanDraft(bad, config), /unknown card/);
});

test('pause drains active cards, stops new dispatch, and resumes; user guidance reaches the next worker', async (t) => {
  const root = fixture(t);
  const p = plan(); p.cards.push({ ...p.cards[0]!, id: 'c2', dependsOn: ['c1'] });
  const prompts: string[] = [];
  registerAdapter('fake', createFakeAdapter({ planner: p, checker: goodCheck, worker: (o, i) => { prompts.push(o.prompt); return DEFAULT_FAKE_SCRIPT.worker!(o, i); }, delayMs: 15 }));
  const b = createBoard(root, 'controls', 'controls');
  const orch = createOrchestrator(root, b, config);
  await orch.plan();
  let paused = false;
  let activeDone!: () => void;
  const drained = new Promise<void>((r) => activeDone = r);
  const controlled = createOrchestrator(root, b, config, { onBoardChange: () => {
    if (!paused && b.cards[0]!.status === 'in_progress') { paused = true; controlled.togglePause(); }
    if (b.cards[0]!.status === 'done') activeDone();
  } });
  const executing = controlled.execute();
  await drained;
  assert.equal(b.cards[1]!.status, 'backlog');
  assert.equal(b.paused, true);
  controlled.guideCard('c2', 'Keep the public API unchanged');
  controlled.togglePause();
  await executing;
  assert.equal(b.cards[1]!.status, 'done');
  assert.ok(prompts.at(-1)!.includes('Keep the public API unchanged'));
  assert.equal(b.checkpoint?.phase, 'finished');
  const interrupted = structuredClone(b); interrupted.checkpoint = { phase: 'stopped', at: new Date().toISOString() };
  assert.equal(runStatus(interrupted), 'stopped');
});

test('stopping one card retains its worktree and does not trigger replanning', async (t) => {
  const root = fixture(t); registerAdapter('fake', createFakeAdapter({ planner: plan(), checker: goodCheck, delayMs: 10 }));
  const b = createBoard(root, 'stop one', 'stop');
  let stop = false;
  const orch = createOrchestrator(root, b, { ...config, maxReplans: 1 }, { onBoardChange: () => {
    if (!stop && b.cards[0]?.tasks[0]?.status === 'running') { stop = true; orch.stopCard('c1'); }
  } });
  await orch.plan(); await orch.execute();
  assert.equal(b.cards[0]!.status, 'failed');
  assert.equal(b.cards[0]!.stopped, true);
  assert.equal(b.replans, undefined);
  assert.ok(existsSync(store.worktreeDir(root, b.runId, 'c1')));
  assert.match(b.cards[0]!.reason!, /Stopped by user/);
});

test('verification stays responsive, cancels subprocesses, and skips later commands', async (t) => {
  const root = fixture(t); const controller = new AbortController();
  const pending = runVerification(root, ['sleep 20', 'touch should-not-exist'], { timeoutSec: 30, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const results = await pending;
  assert.equal(results.length, 1); assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.output, /cancelled/);
  assert.ok(results[0]!.durationMs < 2500);
  assert.ok(!existsSync(join(root, 'should-not-exist')));
});

test('final verification catches documentation regressions and merge refuses the failing result', async (t) => {
  const root = fixture(t); const c = { ...config, docs: true };
  registerAdapter('fake', createFakeAdapter({ planner: plan(['test ! -f broken']), checker: goodCheck, docs: (o) => { writeFileSync(join(o.cwd, 'broken'), 'oops'); return { summary: 'Broke the result', filesChanged: ['broken'] }; } }));
  const b = createBoard(root, 'final check', 'final');
  const orch = createOrchestrator(root, b, c); await orch.plan(); await orch.execute();
  assert.equal(b.cards[0]!.verification![0]!.ok, true);
  assert.equal(b.finalVerification!.results[0]!.ok, false);
  assert.equal(runStatus(b), 'needs attention');
  assert.ok(recoverableRuns(root).includes('final'));
  assert.throws(() => mergeRun(root, b.runId), /Final verification failed/);
  assert.equal(git.currentBranch(root), 'main');
});

test('resume uses original settings by default and explicit current settings replace them', async (t) => {
  const root = fixture(t); registerAdapter('fake', fake());
  const b = createBoard(root, 'snapshot', 'snapshot');
  await runBoard(root, b, config, { yes: true, quiet: true, merge: false, fresh: true });
  const current = { ...config, concurrency: 7 };
  await resumeRun(root, current, b.runId, { quiet: true, merge: false });
  assert.equal(store.loadBoard(root, b.runId).settings!.config.concurrency, 1);
  await resumeRun(root, current, b.runId, { quiet: true, merge: false, currentSettings: true });
  assert.equal(store.loadBoard(root, b.runId).settings!.config.concurrency, 7);
  assert.ok(!existsSync(join(store.runDir(root, b.runId), 'execution.lock')));
});

test('a fresh plan off a terminal is not dispatched without --yes; resume is the go, and --yes logs what it accepted', async (t) => {
  const root = fixture(t);
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: plan(['test -f README.md']), checker: goodCheck, delayMs: 1 }));
  const out: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => out.push(args.join(' ')));
  const b = createBoard(root, 'unreviewed', 'unreviewed');
  assert.deepEqual(await runBoard(root, b, config, { yes: false, quiet: true, merge: false, fresh: true }), { landed: 0, aborted: true });
  const saved = store.loadBoard(root, b.runId);
  assert.deepEqual(saved.cards.map((c) => c.status), ['backlog']);
  assert.equal(saved.checkpoint?.phase, 'ready');
  assert.ok(!existsSync(store.worktreeDir(root, b.runId, 'c1')), 'nothing was dispatched');
  const text = out.join('\n');
  assert.match(text, /Board unreviewed[\s\S]*\$ test -f README\.md/, 'the board is printed with its verify commands');
  assert.match(text, /not dispatched: nobody could review the plan here \(stdin is not a terminal\)/);
  assert.match(text, /`dulger resume unreviewed` dispatches it as it is \(`dulger board unreviewed` shows it again\); rerun with --yes/);
  assert.equal((await resumeRun(root, config, b.runId, { quiet: true, merge: false })).landed, 1, 'an explicit resume dispatches it');

  out.length = 0;
  const accepted = createBoard(root, 'accepted', 'accepted');
  assert.equal((await runBoard(root, accepted, config, { yes: true, assumeYes: true, quiet: true, merge: false, fresh: true })).landed, 1);
  assert.match(out.join('\n'), /--yes: dispatching without a review; verify commands: `test -f README\.md`/);
});

test('resuming a board without cards plans it, then follows the fresh-run rule', async (t) => {
  const root = fixture(t); registerAdapter('fake', fake());
  t.mock.method(console, 'log', () => {});
  const b = createBoard(root, 'empty', 'empty');
  assert.equal((await resumeRun(root, config, b.runId, { quiet: true, merge: false })).aborted, true);
  assert.deepEqual(store.loadBoard(root, b.runId).cards.map((c) => c.status), ['backlog']);
  assert.equal((await resumeRun(root, config, b.runId, { quiet: true, merge: false })).landed, 1);
});

test('verify commands a replan adds are accepted by the person\'s --yes, not by the yes resume and retry set', async (t) => {
  const root = fixture(t);
  // c1 never passes review; c2 waits for it, so the run replans instead of ending.
  const first = plan(['true']); first.cards.push({ ...first.cards[0]!, id: 'c2', title: 'Two', dependsOn: ['c1'] });
  const script = () => createFakeAdapter({
    planner: (_o, i) => (i === 0 ? first : { cards: [{ ...plan().cards[0]!, id: 'c3', title: 'Three', verify: ['echo new-check'] }] }),
    checker: (o) => (/Card under review: c1 /.test(o.prompt) ? { pass: false, feedback: ['not yet'], summary: '' } : goodCheck()),
    delayMs: 1,
  });
  const out: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => out.push(args.join(' ')));
  const c = { ...config, maxReplans: 1 };

  registerAdapter('fake', script());
  const accepted = createBoard(root, 'replan yes', 'replan-yes');
  await runBoard(root, accepted, c, { yes: true, assumeYes: true, quiet: true, merge: false, fresh: true });
  assert.equal(accepted.cards.find((k) => k.id === 'c3')?.status, 'done');
  assert.match(out.join('\n'), /--yes: accepted the replan's new verify commands: `echo new-check`/);

  out.length = 0;
  registerAdapter('fake', script());
  const refused = createBoard(root, 'replan no', 'replan-no');
  await runBoard(root, refused, c, { yes: true, quiet: true, merge: false, fresh: true });
  assert.deepEqual(refused.cards.map((k) => [k.id, k.status]), [['c1', 'failed'], ['c2', 'blocked']]);
  assert.match(out.join('\n'), /nobody can approve new verify commands here \(stdin is not a terminal\); --yes accepts them/);
  assert.match(out.join('\n'), /replan failed: refused because its new verify command was not approved: `echo new-check`/);
});

test('on a terminal only a typed yes approves new verify commands', async () => {
  const card = { ...store.cardsFromPlan(plan(['echo new-check']))[0]!, id: 'c3-r1', title: 'Smoke' };
  const signal = new AbortController().signal;
  type Question = Parameters<RunUi['ask']>[0];
  const questions: Question[] = []; const phases: string[] = []; const notes: string[] = [];
  const ui = (answer: string | undefined) => () => ({ ask: async (q: Question) => { questions.push(q); return answer; }, note: (m: string) => { notes.push(m); }, setPhase: (p: string) => { phases.push(p); } });
  for (const [answer, ok] of [['', false], [undefined, false], ['y', false], ['go', false], ['yes', true], ['  YES ', true]] as const) {
    assert.equal(await approveReplanCommands({}, ui(answer), true)(['echo new-check'], [card], signal), ok, `answer ${JSON.stringify(answer)}`);
  }
  assert.match(questions[0]!.intro, /echo new-check {2}for c3-r1 Smoke[\s\S]*Type yes to run them/);
  assert.ok(questions[0]!.details?.some((d) => /echo new-check {2}for c3-r1 Smoke/.test(d)), 'the full-screen view logs what the plain prompt lists');
  assert.deepEqual(questions[0]!.history, [], 'nothing typed earlier can answer it');
  assert.equal(questions[0]!.signal, signal);
  assert.deepEqual([...new Set(phases)], ['running'], 'the live view comes back afterwards');

  questions.length = 0;
  assert.equal(await approveReplanCommands({ assumeYes: true }, ui(undefined), false)(['echo new-check'], [card], signal), true);
  assert.equal(await approveReplanCommands({}, ui('yes'), false)(['echo new-check'], [card], signal), false, 'off a terminal nobody can say yes');
  assert.equal(questions.length, 0);
  assert.match(notes.join('\n'), /--yes: accepted the replan's new verify commands: `echo new-check`/);
});

test('lock recovery preserves incomplete, invalid and foreign owners; release preserves a replacement owner', (t) => {
  const root = fixture(t);
  const board = createBoard(root, 'lock ownership', 'ownership');
  const path = join(store.runDir(root, board.runId), 'execution.lock');
  const ownerPath = join(path, 'owner.json');
  mkdirSync(path);
  assert.throws(() => acquireRunLock(root, board.runId), /cannot be verified/);
  assert.ok(existsSync(path));
  writeFileSync(ownerPath, 'not JSON');
  assert.throws(() => acquireRunLock(root, board.runId), /Unreadable execution lock/);
  for (const owner of [
    { pid: 2147483647, host: 'another-host', token: 'foreign' },
    { pid: 0, host: hostname(), token: 'invalid' },
  ]) {
    writeFileSync(ownerPath, JSON.stringify(owner));
    assert.throws(() => acquireRunLock(root, board.runId), /cannot be verified/);
    assert.ok(existsSync(ownerPath));
  }
  rmSync(path, { recursive: true });
  const release = acquireRunLock(root, board.runId);
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, host: hostname(), token: 'replacement' }));
  release();
  assert.ok(existsSync(path), 'an old release callback cannot delete another owner’s lock');
});

test('aborting a paused dispatcher wakes it without starting cards or documentation', { timeout: 2000 }, async (t) => {
  const root = fixture(t);
  registerAdapter('fake', fake());
  const board = createBoard(root, 'paused abort', 'paused-abort');
  const orch = createOrchestrator(root, board, config);
  await orch.plan();
  orch.togglePause();
  const executing = orch.execute();
  await new Promise<void>((resolve) => setImmediate(resolve));
  orch.abort();
  await executing;
  assert.deepEqual(board.cards.map((card) => card.status), ['backlog']);
  assert.equal(board.checkpoint?.phase, 'stopped');
  assert.ok([...orch.registry.statuses.values()].every((agent) => agent.role === 'planner'));
  assert.equal(store.loadBoard(root, board.runId).checkpoint?.phase, 'stopped');
});

test('profiles: a malformed profiles file is a CliError naming the file; the name rule is shared', async (t) => {
  const root = fixture(t);
  const { profileNameError } = await import('../src/profiles.ts');
  const { CliError } = await import('../src/errors.ts');
  mkdirSync(join(root, '.dulger'), { recursive: true });
  writeFileSync(join(root, '.dulger', 'profiles.json'), '{ not json');
  assert.throws(() => readProfiles(root), (e: unknown) => e instanceof CliError && /profiles\.json is not valid JSON/.test((e as Error).message));
  writeFileSync(join(root, '.dulger', 'profiles.json'), '[]');
  assert.throws(() => readProfiles(root), /must contain a JSON object/);
  assert.equal(profileNameError('fast and cheap'), undefined);
  assert.match(profileNameError('a/b')!, /letters, numbers/);
  assert.throws(() => saveProfile(root, 'a/b', config), /letters, numbers/);
});

test('lockOwner reads who holds a run lock without touching it', async (t) => {
  const root = fixture(t);
  const { lockOwner } = await import('../src/board/lock.ts');
  const b = createBoard(root, 'goal', 'r-lock');
  store.saveBoard(root, b);
  assert.equal(lockOwner(root, b.runId), undefined);
  const release = acquireRunLock(root, b.runId);
  assert.deepEqual(lockOwner(root, b.runId), { pid: process.pid, host: hostname() });
  assert.deepEqual(lockOwner(root, b.runId), { pid: process.pid, host: hostname() }, 'reading twice changes nothing');
  release();
  assert.equal(lockOwner(root, b.runId), undefined);
});

test('preflight: a dirty tree the session allows passes; without it, the warning the CLI prints stays', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'README.md'), 'changed\n');
  const tree = (o?: { allowDirty?: boolean }) => preflight(root, config, o).find((c) => c.label === 'Working tree');
  assert.deepEqual(tree(), { label: 'Working tree', status: 'warning', detail: 'Uncommitted edits are excluded from agent worktrees. Commit them or explicitly allow a dirty checkout.' });
  assert.equal(tree({ allowDirty: true })?.status, 'pass');
  assert.match(tree({ allowDirty: true })!.detail, /allowed for this session/);
});
