// The Doctor tab: it paints "checking" before the checks block, runs them only when shown (fresh) or
// asked, and is one list: each check as glyph, name and a short value (what is wrong, for one that
// fails), the counts in the border. Help leads with the selected check's whole detail, the line
// prompt's commands rephrased, and Enter goes to the tab that fixes it — mapped from the labels the
// real preflight produces. What the statuses mean and what the checks cannot prove are in help too.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as git from '../src/git/worktree.ts';
import { createApp } from '../src/app/shell.ts';
import { createDoctorPage } from '../src/app/pages/doctor.ts';
import { describeCheck, summarize } from '../src/app/pages/doctor.checks.ts';
import type { AppContext, NavParams, Page, PageFactory } from '../src/app/types.ts';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { preflight, type PreflightCheck } from '../src/preflight.ts';
import { sessionConfig } from '../src/replModels.ts';
import type { Session } from '../src/repl.ts';
import { glyphs } from '../src/tui/theme.ts';
import { SIZES, assertFrame, ch, fakeScreens, key, press, withColour } from './kit.helpers.ts';

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-app-doctor-home-'));
process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-app-doctor-data-'));
delete process.env.OPENAI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;

function repo(t: TestContext, stored?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  if (stored) { mkdirSync(join(root, '.dulger'), { recursive: true }); writeFileSync(join(root, '.dulger/config.json'), JSON.stringify(stored)); }
  return root;
}

const fresh = (o: Partial<Session> = {}): Session => ({ overrides: {}, yes: false, quiet: false, allowDirty: false, ...o });
const config = (o: Partial<Config> = {}): Config => ({ ...structuredClone(DEFAULT_CONFIG), harness: 'fake', ...o });
/** Everything the page's help says, as one text. */
const helpText = (page: Page) => (page.help?.() ?? []).flatMap((h) => [h.title, ...[h.text ?? []].flat(), ...h.keys.map((k) => `${k.key} ${k.label}`)]).join('\n');

const LONG = 'off: agents and verify commands run with your privileges. '.repeat(6) + 'THE END OF THE DETAIL';
const MADE_UP: PreflightCheck[] = [
  { label: 'Git repository', status: 'pass', detail: 'Branch main' },
  { label: 'Working tree', status: 'pass', detail: 'Uncommitted edits are allowed for this session; they are excluded from agent worktrees.' },
  { label: 'openai credentials', status: 'error', detail: 'Set OPENAI_API_KEY or use /provider openai key.' },
  { label: 'worker model', status: 'error', detail: 'Choose a model for openai in /setup.' },
  { label: 'Sandbox', status: 'warning', detail: LONG },
  { label: 'Something new', status: 'warning', detail: 'A check this page has never heard of.' },
];

function stub(id: string, log: string[]): PageFactory {
  return () => ({ id, title: id, activate: (p?: NavParams) => { log.push(`${id}${p ? ` ${JSON.stringify(p)}` : ''}`); }, render: () => ({ lines: [`${id} stub`] }), onKey: () => false, hints: () => [] });
}

function setup(t: TestContext, o: { checks?: PreflightCheck[] | (() => PreflightCheck[]); rows?: number; cols?: number; staleMs?: number; session?: Session } = {}) {
  const root = repo(t);
  const session = o.session ?? fresh({ overrides: { harness: 'openai' } });
  const screens = fakeScreens(o.rows ?? 40, o.cols ?? 120);
  const log: string[] = [];
  const calls: Config[] = [];
  let now = 1_000_000;
  let page!: Page;
  let ctx!: AppContext;
  const source = o.checks ?? MADE_UP;
  const app = createApp({
    repoRoot: root, session, version: '1.0.0', config: () => sessionConfig(root, session),
    pages: [stub('home', log), (c) => { ctx = c; page = createDoctorPage(c, { delayMs: 0, staleMs: o.staleMs, checks: (_r, cfg) => { calls.push(cfg); return typeof source === 'function' ? source() : source; } }); return page; },
      stub('settings', log), stub('models', log), stub('providers', log)],
    openScreen: screens.factory, icons: 'unicode', now: () => now, branch: () => 'main',
  });
  const done = app.run();
  t.after(async () => { app.quit(); await done; });
  return { root, session, log, calls, get page() { return page; }, get ctx() { return ctx; }, get s() { return screens.current; }, advance(ms: number) { now += ms; } };
}

/** Show the Doctor tab and let its checks run. */
async function open(env: ReturnType<typeof setup>) {
  env.ctx.navigate('doctor');
  await sleep(5);
}

test('the page paints "checking" before the checks run, then the counts, the list and the selected check in full', async (t) => {
  const env = setup(t);
  assert.equal(env.page.badge?.(), undefined, 'nothing is run to draw the tab bar');
  assert.equal(env.calls.length, 0);
  env.ctx.navigate('doctor');
  assert.match(env.s.text, /⠋ checking/, 'a spinner and a word');
  assert.equal(env.page.animating?.(), true, 'the spinner turns');
  assert.equal(env.calls.length, 0, 'the frame came first');
  await sleep(5);
  assert.equal(env.calls.length, 1);
  assert.equal(env.page.animating?.(), false);
  const text = env.s.text;
  assert.match(text, /─ ❯ Checks ─+ ✗2 !2 ✓2 ─╮/, 'the counts in the border');
  assert.doesNotMatch(text, /must be fixed|need a look|a run can start|no paid model calls/, 'no summary sentences');
  assert.match(helpText(env.page), /no paid model calls and cannot prove a key is valid/, 'what the checks cannot prove is in help');
  assert.match(text, /✓ Git repository\s+main │/, 'glyph, name, short value');
  assert.match(text, /✓ Working tree\s+dirty · allowed │/);
  assert.match(text, /✗ openai credentials\s+no key │/);
  assert.match(text, /│ {3}! Something new\s+a check this page has n… │/, 'a check this page does not know says what is wrong in the words of its detail');
  assert.doesNotMatch(text, /\s(pass|error|warning) │/, 'the glyph says the status');
  assert.match(text, /\[2 Doctor ✗2\]/, 'the tab badge counts the errors');
  // One list, as wide as its rows: no detail pane, no button.
  const top = text.split('\n').find((l) => l.includes('Checks'))!;
  assert.ok(top.trimEnd().length < 50, `the panel is as wide as its rows: ${top.trimEnd().length}`);
  assert.doesNotMatch(text, /No API key for openai|Add a key for openai/, 'the detail is in help');
  // The first error is selected: what to fix comes first.
  assert.match(text, /│ ❯ ✗ openai credentials/);
  assert.match(text.split('\n').at(-1)!, /^ ↑↓ check {2}⏎ fix {2}r recheck {2}\? help\s*$/, 'the key bar');
  const help = env.page.help!();
  assert.equal(help[0]!.title, 'openai credentials', 'help leads with the selected check');
  assert.match([help[0]!.text ?? []].flat().join(' '), /^No API key for openai\. Add one on the Providers tab/, 'its whole detail');
  assert.doesNotMatch(helpText(env.page), /\/provider|\/setup/, 'no command syntax');
  assert.deepEqual(help[0]!.keys.map((k) => `${k.key} ${k.label}`), ['⏎ Add a key for openai'], 'and where Enter goes');
});

test('every detail is in help whole, a long one scrolls there, and an unknown check is shown as it is with no action', async (t) => {
  const env = setup(t);
  await open(env);
  env.s.key(key('down'));
  env.s.key(key('down'));
  assert.match(env.s.text, /│ ❯ ! Sandbox\s+off │/, 'the mode, from the detail');
  assert.equal([env.page.help!()[0]!.text ?? []].flat().join(' '), LONG, 'the whole detail');
  env.s.key(key('down'));
  assert.equal(env.page.help!()[0]!.text, 'A check this page has never heard of.');
  assert.ok(!env.page.hints().some((h) => h.label === 'fix'), 'no action offered');
  env.s.key(key('enter'));
  assert.deepEqual(env.log, ['home'], 'enter does nothing there');
  const small = setup(t, { rows: 14, cols: 60 });
  await open(small);
  small.s.key(key('down'));
  small.s.key(key('down'));
  small.s.key(ch('?'));
  assert.match(small.s.text, /Sandbox/);
  for (let i = 0; i < 40; i++) small.s.key(key('down'));
  assert.match(small.s.text.replace(/[│┃\s]+/g, ' '), /THE END OF THE DETAIL|They run when the tab is shown/, 'help scrolls past it');
  small.s.key(key('escape'));
});

test('each mapped check opens the tab that fixes it, with the right parameters', async (t) => {
  const env = setup(t);
  await open(env);
  env.s.key(key('enter'));
  assert.deepEqual(env.log.at(-1), 'providers {"provider":"openai","add":true}');
  await open(env);
  env.s.key(key('down'));
  env.s.key(key('enter'));
  assert.deepEqual(env.log.at(-1), 'models {"role":"worker"}');
  await open(env);
  env.s.key(key('home'));
  env.s.key(key('down'));
  env.s.key(key('enter'));
  assert.deepEqual(env.log.at(-1), 'settings {"key":"dirty"}');
  await open(env);
  env.s.key(key('end'));
  env.s.key(key('up'));
  env.s.key(key('enter'));
  assert.deepEqual(env.log.at(-1), 'settings {"key":"sandbox"}');
  await open(env);
  const commands = env.page.commands!();
  assert.deepEqual(commands.map((c) => c.title), ['Run checks again'], 'no entry per check: Enter is the fix');
  assert.ok(commands.every((c) => c.group === undefined));
});

test('the checks run when the tab is shown and stale or changed, and on r — never on a key or a repaint', async (t) => {
  const env = setup(t, { staleMs: 60_000 });
  await open(env);
  assert.equal(env.calls.length, 1);
  for (const k of [key('down'), key('up'), key('end'), key('home'), ch('x')]) env.s.key(k);
  env.ctx.redraw();
  assert.equal(env.calls.length, 1, 'keys and repaints do not run them');
  env.ctx.navigate('home');
  await open(env);
  assert.equal(env.calls.length, 1, 'shown again soon, with nothing changed: the results stand');
  env.s.key(ch('r'));
  assert.match(env.s.text, /checking/);
  await sleep(5);
  assert.equal(env.calls.length, 2);
  env.ctx.navigate('home');
  env.session.allowDirty = true;
  await open(env);
  assert.equal(env.calls.length, 3, 'a changed session runs them again');
  assert.match(env.s.text, /Allow uncommitted changes is on for this session|openai credentials/);
  env.ctx.navigate('home');
  env.advance(61_000);
  await open(env);
  assert.equal(env.calls.length, 4, 'old results are checked again');
  // Leaving before the checks start calls them off.
  env.ctx.navigate('home');
  env.advance(61_000);
  env.ctx.navigate('doctor');
  env.ctx.navigate('home');
  await sleep(5);
  assert.equal(env.calls.length, 4);
});

test('the badge: the error count, or a check mark once nothing must be fixed; a runner that throws is a finding', async (t) => {
  let checks: PreflightCheck[] = [{ label: 'Git repository', status: 'pass', detail: 'Branch main' }, { label: 'Sandbox', status: 'warning', detail: 'off' }];
  const env = setup(t, { checks: () => checks });
  await open(env);
  assert.equal(env.page.badge?.(), '✓');
  assert.match(env.s.text, /─ ❯ Checks ─+ !1 ✓1 ─╮/, 'no ✗: a run can start');
  checks = [];
  env.s.key(ch('r'));
  await sleep(5);
  assert.match(env.s.text, /No checks ran/);
  assert.deepEqual(env.page.hints().map((h) => h.key), ['r']);
  const boom = setup(t, { checks: () => { throw new Error('spawn exploded'); } });
  await open(boom);
  assert.match(boom.s.text, /✗ Settings\s+checks failed │/);
  assert.match(helpText(boom.page), /The checks could not run: spawn exploded/, 'the message, whole, in help');
  assert.equal(boom.page.badge?.(), '✗1', 'a glyph and a number');
});

test('a config that cannot be read is shown as the finding, not a crash', async (t) => {
  const env = setup(t);
  writeFileSync(join(env.root, 'x'), '');
  mkdirSync(join(env.root, '.dulger'), { recursive: true });
  writeFileSync(join(env.root, '.dulger/config.json'), '{ nope');
  await open(env);
  assert.match(env.s.text, /✗ Settings\s+unreadable │/);
  assert.match(helpText(env.page), /The settings cannot be read/);
  assert.equal(env.calls.length, 0);
  env.s.key(key('enter'));
  assert.deepEqual(env.log.at(-1), 'settings');
});

test('mouse: a click selects a check, a second one opens its fix; a click beside the list does nothing', async (t) => {
  const env = setup(t);
  await open(env);
  const lines = env.s.text.split('\n');
  const row = lines.findIndex((l) => l.includes('worker model') || l.includes('Worker model'));
  env.s.mouse(press(row, 6));
  assert.match(env.s.text, /│ ❯ ✗ Worker model/);
  env.s.mouse(press(row, 6));
  assert.deepEqual(env.log.at(-1), 'models {"role":"worker"}');
  await open(env);
  env.s.mouse(press(row, 100));
  assert.deepEqual(env.log.slice(-1), ['models {"role":"worker"}'], 'no jump from outside the list');
});

test('renders at every size and in every glyph set, before and after the checks', async (t) => {
  const env = setup(t);
  for (const [rows, cols] of SIZES) {
    for (const set of ['nerd', 'unicode', 'ascii'] as const) {
      const page = createDoctorPage({ ...env.ctx, g: glyphs(set) }, { delayMs: 0, checks: () => MADE_UP });
      withColour(() => assertFrame(page.render({ rows, cols }).lines, rows, cols, `doctor before ${set}`));
      await page.activate?.();
      withColour(() => assertFrame(page.render({ rows, cols }).lines, rows, cols, `doctor ${set}`));
    }
  }
  await open(env);
  for (const [rows, cols] of SIZES) {
    env.s.resize(rows, cols);
    assertFrame(env.s.lines, rows, cols, 'shell');
  }
  env.s.resize(24, 80);
  assert.match(env.s.text, /Checks/);
  assert.match(env.s.text, /│ ❯ ✗ openai credentials\s+no key │/);
  env.s.resize(8, 60);
  assert.match(env.s.text, /❯ ✗ openai credentials/, 'shorter than the list, it scrolls to the selection');
});

test('the real preflight: its labels map to the right actions in a temporary repository', async (t) => {
  const root = repo(t, {
    harness: 'codex', budgetUsd: 5, sandbox: { mode: 'auto' },
    roles: { planner: { harness: 'openai' }, checker: { harness: 'openai', maxBudgetUsd: 2 } },
  });
  writeFileSync(join(root, 'README.md'), 'changed\n');
  const cfg = sessionConfig(root, fresh());
  const checks = preflight(root, cfg);
  const labels = checks.map((c) => c.label);
  for (const want of ['Git repository', 'Git identity', 'Working tree', 'planner model', 'checker model', 'checker budget', 'openai credentials', 'openai spend', 'codex spend', 'codex', 'Progress reporter', 'Sandbox', 'Repository sandbox key']) {
    assert.ok(labels.includes(want), `preflight still says "${want}" (it said: ${labels.join(', ')})`);
  }
  const shown = new Map(checks.map((c) => [c.label, describeCheck(c, cfg)]));
  const action = (label: string) => shown.get(label)?.action;
  assert.deepEqual(action('Working tree'), { title: 'Allow uncommitted changes in Settings', page: 'settings', params: { key: 'dirty' } });
  assert.deepEqual(action('planner model')?.params, { role: 'planner' });
  assert.equal(action('planner model')?.page, 'models');
  assert.deepEqual(action('checker model')?.params, { role: 'checker' });
  assert.deepEqual(action('checker budget')?.params, { role: 'checker' });
  assert.deepEqual(action('openai credentials'), { title: 'Add a key for openai', page: 'providers', params: { provider: 'openai', add: true } });
  assert.deepEqual(action('openai spend')?.params, { key: 'budget' });
  assert.deepEqual(action('Progress reporter')?.params, { role: 'reporter' });
  assert.deepEqual(action('Sandbox')?.params, { key: 'sandbox' });
  assert.deepEqual(action('Repository sandbox key')?.params, { key: 'sandbox' });
  assert.equal(action('Git repository'), undefined);
  assert.equal(shown.get('planner model')!.label, 'Planner model');
  assert.equal(shown.get('checker model')!.label, 'Reviewer model');
  assert.equal(shown.get('codex')!.label, 'codex command');
  if (shown.get('codex')!.status === 'error') assert.deepEqual(action('codex')?.params, { key: 'harness' });
  for (const [label, c] of shown) {
    assert.doesNotMatch(c.detail, /(^|\s)\/(provider|setup|config|doctor)\b/, `${label}: no slash command`);
    assert.doesNotMatch(c.detail, /"sandbox": \{/, `${label}: no JSON to edit`);
  }
  assert.match(shown.get('openai credentials')!.detail, /OPENAI_API_KEY/);
  // The short values the list shows beside each name.
  assert.equal(shown.get('Git repository')!.value, 'main');
  assert.equal(shown.get('Working tree')!.value, 'dirty');
  assert.equal(shown.get('openai credentials')!.value, 'no key');
  assert.equal(shown.get('planner model')!.value, 'none');
  assert.equal(shown.get('checker budget')!.value, 'unsupported');
  assert.equal(shown.get('openai spend')!.value, 'tokens only');
  assert.equal(shown.get('Progress reporter')!.value, 'skipped');
  assert.match(shown.get('Sandbox')!.value ?? '', /^(off|auto|required)/);
  assert.equal(shown.get('Repository sandbox key')!.value, 'ignored');
  assert.match(shown.get('codex')!.value ?? '', shown.get('codex')!.status === 'error' ? /^not found$/ : /\d/);
  // A label this page does not know is kept as it is.
  assert.deepEqual(describeCheck({ label: 'Quantum flux', status: 'warning', detail: 'x' }, cfg), { label: 'Quantum flux', status: 'warning', detail: 'x' });
  assert.deepEqual(summarize(checks.map((c) => ({ status: c.status }))).canRun, !checks.some((c) => c.status === 'error'));
});

test('the sandbox detail drops its config-file instructions and keeps the link; the dirty switch is noticed', () => {
  const cfg = config();
  const off = describeCheck({ label: 'Sandbox', status: 'warning', detail: 'off: agents run with your privileges. The runtime works here. Set "sandbox": { "mode": "auto" } in /home/x/.config/dulger/config.json, or pass --sandbox auto, to confine Claude Code agents and those commands; https://example.org/dulger/how-a-run-works/#sandbox says what it does and does not confine.' }, cfg);
  assert.match(off.detail, /^off: agents run with your privileges\. The runtime works here\. Choose auto or required in Settings/);
  assert.match(off.detail, /https:\/\/example\.org\/dulger\/how-a-run-works\/#sandbox/);
  assert.doesNotMatch(off.detail, /--sandbox|"mode"/);
  const dirty = describeCheck({ label: 'Working tree', status: 'warning', detail: 'x' }, cfg, { allowDirty: true });
  assert.match(dirty.detail, /Allow uncommitted changes is on for this session, so a run starts anyway/);
  const noCommit = describeCheck({ label: 'Git repository', status: 'error', detail: 'Create an initial commit with dulger init.' }, cfg);
  assert.match(noCommit.detail, /Make a first commit/);
});

test('uncommitted changes the session does not allow stop a run, so the Doctor says no run can start, as Home does', async (t) => {
  const env = setup(t, { checks: [
    { label: 'Git repository', status: 'pass', detail: 'Branch main' },
    { label: 'Working tree', status: 'warning', detail: 'Uncommitted edits are excluded from agent worktrees. Commit them or explicitly allow a dirty checkout.' },
    { label: 'Worktree setup', status: 'warning', detail: 'Will run in each new worktree: npm ci' },
  ] });
  await open(env);
  const text = env.s.text;
  assert.match(text, /─ ❯ Checks ─+ ✗1 !1 ✓1 ─╮/, 'counted as one to fix: no run can start');
  assert.equal(env.page.badge?.(), '✗1');
  assert.match(text, /✗ Working tree\s+dirty │/);
  assert.match(helpText(env.page), /so a run cannot start/);
  env.s.key(key('down'));
  const setupText = [env.page.help!()[0]!.text ?? []].flat().join(' ');
  assert.match(setupText, /name a setup command that runs as a shell command in every new worktree/, 'what it is');
  assert.match(setupText, /npm ci/);
  assert.match(env.s.text, /! Worktree setup\s+npm ci │/, 'the command is the row\'s value');
  assert.match(setupText, /Nothing needs fixing if it is the command you expect/, 'why it is listed, and that it needs no fix');
  assert.ok(!env.page.hints().some((h) => h.label === 'fix'), 'and no fix is offered');
});
