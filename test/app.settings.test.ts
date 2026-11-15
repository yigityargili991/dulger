// The Settings tab against a temporary repository: the form is the settings table, drawn as labels and
// values; a change applies at once and a refused one changes nothing; the page counts what Save would
// write (roles and providers other pages changed included), and Save, Discard and the profile actions
// confirm with the facts, write and report in a few words. What the page used to explain is in help.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as git from '../src/git/worktree.ts';
import { createApp } from '../src/app/shell.ts';
import { createSettingsPage, profileNameError } from '../src/app/pages/settings.ts';
import { readView, restoreSession, sessionDiff, settingSections } from '../src/app/pages/settings.data.ts';
import type { AppContext, NavParams, Page, PageFactory } from '../src/app/types.ts';
import { saveProfile } from '../src/profiles.ts';
import { userConfigFile } from '../src/sandbox.ts';
import { sessionConfig, setRoleModel } from '../src/replModels.ts';
import { defineProvider } from '../src/replProviders.ts';
import { SESSION_SETTINGS } from '../src/settings.ts';
import type { Session } from '../src/repl.ts';
import { confirmModal, type Field, type NumberField } from '../src/tui/kit/index.ts';
import { glyphs } from '../src/tui/theme.ts';
import { width } from '../src/tui/text.ts';
import { SIZES, assertFrame, ch, fakeScreens, g, key, plain, press, withColour } from './kit.helpers.ts';

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-app-settings-home-'));
process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-app-settings-data-'));

function repo(t: TestContext, stored?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  if (stored) { mkdirSync(join(root, '.dulger'), { recursive: true }); writeFileSync(join(root, '.dulger/config.json'), JSON.stringify(stored)); }
  return root;
}

const fresh = (o: Partial<Session> = {}): Session => ({ overrides: {}, yes: false, quiet: false, allowDirty: false, ...o });

/** A tab that records how it was navigated to. */
function stub(id: string, title: string, log: string[]): PageFactory {
  return () => ({ id, title, activate: (p?: NavParams) => { log.push(`${id}${p ? ` ${JSON.stringify(p)}` : ''}`); }, render: () => ({ lines: [`${title} stub`] }), onKey: () => false, hints: () => [] });
}

function setup(t: TestContext, o: { stored?: object; session?: Session; rows?: number; cols?: number; root?: string } = {}) {
  const root = o.root ?? repo(t, o.stored);
  const session = o.session ?? fresh();
  const screens = fakeScreens(o.rows ?? 40, o.cols ?? 120);
  const log: string[] = [];
  let page!: Page;
  let ctx!: AppContext;
  let now = 1_000_000;
  const app = createApp({
    repoRoot: root, session, version: '1.0.0', config: () => sessionConfig(root, session),
    pages: [(c) => { ctx = c; page = createSettingsPage(c); return page; }, stub('models', 'Models', log), stub('providers', 'Providers', log)],
    openScreen: screens.factory, icons: 'unicode', now: () => now, branch: () => 'main',
  });
  const done = app.run();
  t.after(async () => { app.quit(); await done; });
  return {
    root, session, log, app, get page() { return page; }, get ctx() { return ctx; }, get s() { return screens.current; },
    advance(ms: number) { now += ms; },
    /** The form row for a label, as drawn. */
    row(label: string) { return screens.current.text.split('\n').find((l) => /^│ [❯ ] /.test(l) && l.slice(4).startsWith(label)) ?? ''; },
  };
}

const settle = async () => { for (let i = 0; i < 4; i++) await sleep(0); };

/** Everything the page's help says, as one text. */
const helpText = (page: Page) => (page.help?.() ?? []).flatMap((h) => [h.title, ...[h.text ?? []].flat(), ...h.keys.map((k) => `${k.key} ${k.label}`)]).join('\n');

test('the form is the settings table: every setting, in its group, as the field its kind calls for', (t) => {
  const root = repo(t);
  const session = fresh();
  const view = readView(root, session);
  const sections = settingSections(view, session, { errors: new Map() });
  const fields = sections.flatMap((s) => s.fields);
  const settings = fields;
  assert.deepEqual(settings.map((f) => f.key).sort(), SESSION_SETTINGS.map((s) => s.key).sort(), 'a setting added to the table appears');
  const by = (k: string) => fields.find((f) => f.key === k)!;
  for (const s of SESSION_SETTINGS) {
    const f = by(s.key);
    assert.equal(f.label, s.label);
    assert.ok(f.description?.startsWith(s.help), `${s.key} uses the form wording`);
    assert.doesNotMatch(f.description!, /\/\w+ </, `${s.key}: no command syntax`);
    const expected = { toggle: 'toggle', count: 'number', dollars: 'number', seconds: 'number', choice: 'choice' }[s.kind];
    assert.equal(f.kind, expected, s.key);
    if (s.kind === 'count') assert.equal((f as NumberField).min, s.min);
    if (s.kind === 'dollars' || s.kind === 'seconds') assert.equal((f as NumberField).optional, true, `${s.key} can be off`);
    if (s.scope === 'session') {
      assert.equal(f.tag, 'session', `${s.key}: a one-word tag on the row`);
      assert.match(f.description!, /Session only: never saved\./, `${s.key}: and what it means in help`);
    }
    assert.equal(f.hint, undefined, `${s.key}: no hint beside the value`);
  }
  assert.deepEqual(sections.map((s) => s.title), ['Execution', 'Limits', 'Session', 'Interface']);
  assert.ok(sections.every((s) => !s.description), 'no section notes');
  assert.match(by('harness').description!, /Models tab/, 'per-role choices are in help, and m is the key');
  assert.ok(fields.every((f) => f.kind !== 'action'), 'values only: save, discard, profiles and Models are keys, not rows');
  for (const s of SESSION_SETTINGS) assert.ok(s.help && !/\/[a-z]/.test(s.help), `${s.key} help has no command`);
});

test('renders at every size and in every glyph set, and the frame is always exact', async (t) => {
  const env = setup(t);
  for (const [rows, cols] of SIZES) {
    env.s.resize(rows, cols);
    assertFrame(env.s.lines, rows, cols, 'shell');
    for (const set of ['nerd', 'unicode', 'ascii'] as const) {
      const page = createSettingsPage({ ...env.ctx, g: glyphs(set) });
      page.activate?.();
      withColour(() => assertFrame(page.render({ rows, cols }).lines, rows, cols, `settings ${set}`));
    }
  }
  env.s.resize(40, 120);
  const lines = env.s.text.split('\n');
  const top = lines.find((l) => /Settings ─/.test(l))!;
  assert.ok(top.trimEnd().length < 60, `the panel is as wide as the form needs, not the terminal: ${top.trimEnd().length}`);
  assert.doesNotMatch(env.s.text, /This session|Matches the repository|unsaved change|session only|saved:|Save settings|Models per role/, 'labels and values only');
  assert.match(env.s.text, /│ ❯ Backend\s+‹ claude ▾ ›\s+│/);
  assert.match(env.s.text, /│ {3}Skip approval\s+○ off\s+session\s+│/, 'a session-only field carries its tag');
  const at = (label: string) => env.s.text.split('\n').find((l) => l.includes(` ${label} `))!.indexOf('session');
  assert.equal(at('Skip approval'), at('Sandbox'), 'the tags are in one column');
  assert.match(lines.at(-1)!, /^ ↑↓ field {2}←→ change {2}s save {2}\? help\s*$/, 'the key bar of the mock-up');
  env.s.resize(24, 80);
  assert.match(env.s.text, /Backend[\s\S]*Icons/, 'at 80×24 the form fits but its last row');
  env.ctx.navigate('settings', { key: 'mouse' });
  assert.match(env.s.text, /Mouse/, 'which scrolls into view');
});

test('a change applies to the session at once, is marked against the saved value, and the header follows', async (t) => {
  const env = setup(t, { stored: { harness: 'fake', concurrency: 3 } });
  assert.match(env.s.text.split('\n')[0]!, /fake ·/);
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('right'));
  assert.equal(env.session.overrides.concurrency, 4);
  assert.match(env.row('Parallel cards'), /❯ Parallel cards\s+‹ 4 › ✎/, 'the value, then the changed mark');
  assert.match(helpText(env.page), /^Parallel cards\n.*Saved: 3\./m, 'help leads with the focused field, and says the saved value');
  assert.match(env.s.text, /Settings ─+ ✎1 ─╮/, 'the panel badge counts unsaved changes');
  env.ctx.navigate('settings', { key: 'harness' });
  env.s.key(key('left'));
  assert.equal(env.session.overrides.harness, 'codex');
  assert.match(env.s.text.split('\n')[0]!, /codex ·/, 'the header summary follows');
  assert.match(env.s.text, /\[1 Settings ✎2\]/, 'the tab badge counts unsaved changes');
  // Turning a limit on starts from a sensible amount, stepping below the smallest turns it off.
  env.ctx.navigate('settings', { key: 'budget' });
  env.s.key(key('right'));
  assert.equal(env.session.overrides.budgetUsd, 10);
  env.s.key(key('delete'));
  assert.equal(env.session.overrides.budgetUsd, undefined);
  env.ctx.navigate('settings', { key: 'progress' });
  env.s.key(key('delete'));
  assert.equal(env.session.overrides.progressIntervalSec, 0);
  env.s.key(key('right'));
  assert.equal(env.session.overrides.progressIntervalSec, 120, 'progress comes back at its usual interval');
  env.ctx.navigate('settings', { key: 'dirty' });
  env.s.key(ch(' '));
  assert.equal(env.session.allowDirty, true);
  assert.match(env.row('Allow dirty tree'), /● on\s+session/, 'no ✎: Save does not write a session-only setting');
  assert.doesNotMatch(env.row('Allow dirty tree'), /✎/);
  assert.match(env.s.text, /\[1 Settings ✎2\]/, 'session-only changes are not unsaved ones');
});

test('a refused value shows the table\'s error on the field and changes nothing', async (t) => {
  const env = setup(t);
  // Typed past the form's own minimum: refused before the table is asked.
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('enter'));
  env.s.key(key('backspace'));
  env.s.type('0');
  env.s.key(key('enter'));
  assert.match(env.s.text, /Must be at least 1/);
  assert.equal(env.session.overrides.concurrency, undefined);
  env.s.key(key('escape'));
  // A provider another page removed while this form still offers it: the table refuses it.
  defineProvider(env.session, sessionConfig(env.root, env.session), 'groq', { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' });
  env.ctx.navigate('settings', { key: 'harness' });
  delete env.session.overrides.providers;
  const before = structuredClone(env.session);
  env.s.key(key('left'));
  assert.deepEqual(env.session, before, 'the session is unchanged');
  assert.match(env.s.text, /harness is one of claude, codex, fake/);
  assert.match(env.row('Backend'), /claude/, 'the field shows the value the session still has');
});

test('the page counts roles and providers that other pages changed, and lists them', async (t) => {
  const env = setup(t);
  setRoleModel(env.session, sessionConfig(env.root, env.session), 'worker', 'claude', 'opus');
  defineProvider(env.session, sessionConfig(env.root, env.session), 'groq', { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' });
  env.ctx.navigate('settings');
  assert.match(env.s.text, /Settings ─+ ✎2 ─╮/);
  env.s.key(ch('s'));
  await settle();
  assert.match(env.s.text, /Worker model\s+claude \/ opus/, 'the save lists them');
  assert.match(env.s.text, /Provider groq\s+added/);
  env.s.key(key('escape'));
  await settle();
  // A harness change moves every role, but it is one change: the harness's.
  const other = fresh({ overrides: { harness: 'fake' } });
  assert.equal(readView(env.root, other).unsaved, 1);
});

test('Save confirms with what will be written and where, writes it, and says what it saved', async (t) => {
  const env = setup(t, { stored: { concurrency: 3, verifyTimeoutSec: 99 } });
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('right'));
  env.ctx.navigate('settings', { key: 'sandbox' });
  env.s.key(key('right'));
  assert.equal(env.session.sandbox, 'auto');
  env.s.key(ch('s'));
  await settle();
  const dialog = env.s.text;
  assert.match(dialog, /Save settings/);
  assert.match(dialog, /Parallel cards\s+3 → 4/);
  assert.ok(dialog.includes(join(env.root, '.dulger/config.json')) && !dialog.includes(userConfigFile()), 'the repository file only');
  assert.doesNotMatch(dialog, /Not written|API keys|Write these|· Sandbox/, 'the file and the changes, nothing else; a session-only setting is not listed');
  env.s.key(ch('n'));
  await settle();
  assert.equal(JSON.parse(readFileSync(join(env.root, '.dulger/config.json'), 'utf8')).concurrency, 3, 'cancel writes nothing');
  env.s.key(ch('s'));
  await settle();
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  const saved = JSON.parse(readFileSync(join(env.root, '.dulger/config.json'), 'utf8'));
  assert.equal(saved.concurrency, 4);
  assert.equal(saved.verifyTimeoutSec, 99, 'the rest of the file stays');
  assert.equal(saved.sandbox, undefined, 'the sandbox is never written');
  assert.match(env.s.text, /Saved · not committed/, 'the file is now an uncommitted change');
  assert.match(env.s.text, /│\s+\.dulger\/config\.json\s+│/);
  assert.doesNotMatch(env.s.text, /blocks the next run/, 'a file git does not track yet keeps no run from starting, and the notice does not claim it does');
  assert.match(env.s.text, /\[ Not now \]\s+Commit settings…/, 'declining is the default');
  env.s.key(key('enter'));
  await settle();
  assert.match(env.s.text, /Saved · not committed/, 'the toast');
  assert.doesNotMatch(env.s.text, /✎/, 'nothing unsaved now');
  assert.equal(git.git(env.root, ['log', '--format=%s', '-1']), 'initial', 'nothing was committed');
  env.s.key(ch('s'));
  await settle();
  assert.match(env.s.text, /Nothing to save/);
});

test('Save names each file it writes: the backend goes to your own config file, the rest to the repository\'s', async (t) => {
  const env = setup(t, { stored: { concurrency: 3 }, session: fresh({ overrides: { harness: 'fake', concurrency: 4 } }) });
  env.s.key(ch('s'));
  await settle();
  assert.ok(env.s.text.includes(join(env.root, '.dulger/config.json')) && env.s.text.includes(userConfigFile()), 'both files');
  env.s.key(ch('n'));
});

test('a save that fails is an error message, and nothing changes', async (t) => {
  const env = setup(t, { stored: {} });
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('right'));
  writeFileSync(join(env.root, '.dulger/config.json'), '[1]');
  env.ctx.navigate('settings');
  env.s.key(ch('s'));
  await settle();
  env.s.key(ch('y'));
  await settle();
  assert.match(env.s.text.replace(/\s+/g, ' '), /Not saved: .*config\.json must contain a JSON object/);
  assert.equal(readFileSync(join(env.root, '.dulger/config.json'), 'utf8'), '[1]');
});

test('Discard confirms with the list and puts the session back as the app found it', async (t) => {
  const start = fresh({ overrides: { harness: 'fake' }, yes: true });
  const env = setup(t, { session: start });
  const snapshot = structuredClone(start);
  env.s.key(ch('d'));
  await settle();
  assert.match(env.s.text, /Nothing to discard/);
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('right'));
  setRoleModel(env.session, sessionConfig(env.root, env.session), 'checker', 'claude', 'opus');
  env.ctx.navigate('settings', { key: 'yes' });
  env.s.key(ch(' '));
  env.s.key(ch('d'));
  await settle();
  assert.match(env.s.text, /Discard session changes/);
  assert.match(env.s.text, /Parallel cards\s+4 → 3/);
  assert.match(env.s.text, /Reviewer model/);
  assert.match(env.s.text, /Skip approval\s+off → on/);
  assert.doesNotMatch(env.s.text, /Nothing on disk|Put these back/, 'the list and the buttons');
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  assert.deepEqual(env.session, snapshot);
  assert.equal(env.ctx.session, env.session, 'the same object: the shell and other pages see it');
  assert.match(env.s.text, /Discarded 3 changes/);
});

test('Load profile lists each profile with its harness, cards and budgets as a tag, and applies it', async (t) => {
  const env = setup(t);
  env.s.key(ch('l'));
  await settle();
  assert.match(env.s.text, /No profiles/);
  saveProfile(env.root, 'cheap', { ...sessionConfig(env.root, fresh()), harness: 'fake', concurrency: 7, budgetUsd: 5 });
  saveProfile(env.root, 'big', { ...sessionConfig(env.root, fresh()), concurrency: 2 });
  env.ctx.navigate('settings');
  env.s.key(ch('l'));
  await settle();
  assert.doesNotMatch(env.s.text, /replaces this session/, 'names and tags only');
  assert.match(env.s.text, /cheap\s+fake · 7 parallel · run \$5/);
  assert.match(env.s.text, /big\s+claude · 2 parallel\s/);
  env.s.key(key('enter'));
  await settle();
  assert.equal(sessionConfig(env.root, env.session).concurrency, 7);
  assert.equal(sessionConfig(env.root, env.session).harness, 'fake');
  assert.match(env.s.text, /Loaded cheap/);
  assert.match(env.s.text.split('\n')[0]!, /fake ·/, 'the header follows after the dialog');
});

test('a malformed or unusable profiles file is an error message, not a crash', async (t) => {
  const env = setup(t);
  mkdirSync(join(env.root, '.dulger'), { recursive: true });
  writeFileSync(join(env.root, '.dulger/profiles.json'), '{ not json');
  env.ctx.navigate('settings');
  env.s.key(ch('l'));
  await settle();
  assert.match(env.s.text, /not valid JSON/);
  env.s.key(ch('a'));
  await settle();
  env.s.type('x');
  env.s.key(key('enter'));
  await settle();
  assert.match(env.s.text, /not valid JSON/);
  // A profile naming a backend this config does not have is refused whole.
  const snapshot = { version: 1, config: { ...sessionConfig(env.root, fresh()), harness: 'nowhere' } };
  writeFileSync(join(env.root, '.dulger/profiles.json'), JSON.stringify({ odd: snapshot }));
  const before = structuredClone(env.session);
  env.s.key(ch('l'));
  await settle();
  env.s.key(key('enter'));
  await settle();
  assert.deepEqual(env.session, before);
  assert.match(env.s.text, /Not loaded: /);
});

test('Save as profile checks the name as saveProfile does and confirms before replacing one', async (t) => {
  const env = setup(t);
  assert.equal(profileNameError('fast and cheap'), undefined);
  assert.match(profileNameError('a/b')!, /letters, numbers/);
  assert.match(profileNameError('')!, /letters/);
  env.s.key(ch('a'));
  await settle();
  assert.match(env.s.text, /Save as profile/);
  env.s.type('no/slash');
  env.s.key(key('enter'));
  assert.match(env.s.text, /Use 1–60 letters/);
  for (let i = 0; i < 8; i++) env.s.key(key('backspace'));
  env.s.type('fast');
  env.s.key(key('enter'));
  await settle();
  const file = join(env.root, '.dulger/profiles.json');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).fast);
  assert.match(env.s.text, /Saved profile fast/);
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('right'));
  env.s.key(ch('a'));
  await settle();
  env.s.type('fast');
  env.s.key(key('enter'));
  await settle();
  assert.match(env.s.text, /Replace profile/);
  env.s.key(key('escape'));
  await settle();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).fast.config.concurrency, 3, 'kept');
  env.s.key(ch('a'));
  await settle();
  env.s.type('fast');
  env.s.key(key('enter'));
  await settle();
  // Replace is a danger confirm: take the focused button and Enter (y no longer accepts one).
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).fast.config.concurrency, 4, 'replaced');
  assert.match(env.s.text, /Replaced profile fast/);
});

test('navigation: a key param focuses that field, unknown ones are ignored, and m goes to the Models tab', async (t) => {
  const env = setup(t);
  env.ctx.navigate('settings', { key: 'sandbox' });
  assert.match(env.row('Sandbox'), /❯ Sandbox/);
  env.ctx.navigate('settings', { key: 'nope' });
  env.ctx.navigate('settings', { key: 42 });
  assert.match(env.s.text, /Settings/);
  env.s.key(ch('m'));
  await settle();
  assert.deepEqual(env.log, ['models']);
  env.ctx.navigate('settings', { key: 'harness' });
  env.s.key(key('down'));
  assert.match(env.row('Docs agent'), /❯ Docs agent/, 'no Models row under the backend: m is the key');
});

test('the mouse focuses a field and flips a switch; the palette and help list the actions', async (t) => {
  const env = setup(t);
  const lines = env.s.text.split('\n');
  const at = lines.findIndex((l) => l.includes(' Docs agent'));
  const col = lines[at]!.indexOf('● on');
  env.s.mouse(press(at, col));
  env.s.mouse(press(at, col));
  assert.equal(env.session.overrides.docs, false);
  const commands = env.page.commands!().map((c) => c.title);
  for (const title of ['Save settings…', 'Discard session changes', 'Load profile…', 'Save as profile…', 'Models per role']) assert.ok(commands.includes(title), title);
  assert.ok(!commands.some((t) => t.startsWith('Go to ')), 'no entry per field');
  const groups = env.page.help!();
  assert.equal(groups[0]!.title, 'Docs agent', 'help leads with the focused field');
  assert.ok([groups[0]!.text ?? []].flat().join(' ').length > 20, 'and what it does');
  const help = helpText(env.page);
  assert.match(help, /save settings/);
  assert.match(help, /load profile/);
  assert.match(help, /About\n[\s\S]*session: lasts until dulger exits/, 'the page\'s concepts, last');
  assert.deepEqual(env.page.hints().map((h) => h.key), ['↑↓', '←→', 's'], 'at most four keys');
});

test('a broken config file shows what is wrong instead of the form, and no key throws', async (t) => {
  const env = setup(t, { stored: {} });
  writeFileSync(join(env.root, '.dulger/config.json'), '{ broken');
  env.ctx.navigate('settings');
  assert.match(env.s.text, /! .*config\.json/, 'the reader\'s own message, naming the file');
  assert.doesNotMatch(env.s.text, /Backend/);
  for (const k of [key('right'), key('enter'), ch('s'), ch('d'), ch(' ')]) env.s.key(k);
  await settle();
  assert.doesNotMatch(env.s.text, /failed to draw/);
});

test('the data helpers: a diff of two sessions, and restoring keeps the object', (t) => {
  const root = repo(t);
  const a = fresh({ overrides: { concurrency: 5 }, sandbox: 'auto' });
  const b = fresh();
  const diff = sessionDiff(root, a, b);
  assert.equal(diff.differs, true);
  assert.deepEqual(diff.items.map((i) => i.label), ['Parallel cards', 'Sandbox']);
  assert.equal(sessionDiff(root, b, fresh()).differs, false);
  const target = a;
  restoreSession(target, b);
  assert.deepEqual(target, b);
  assert.equal(target.sandbox, undefined);
});

test('the save confirm (the kit\'s, with a list) fits any size, scrolls a long list and shows the path whole', () => {
  const path = '/a/very/long/path/'.repeat(8) + 'config.json';
  const m = confirmModal({ title: 'Save', message: 'Write these changes:', detail: path, items: Array.from({ length: 60 }, (_, i) => ({ label: `Setting ${i}`, value: `${i} → ${i + 1}` })), note: 'Not written: keys.', confirm: 'Save' });
  for (const [rows, cols] of SIZES) {
    const r = m.render({ rows, cols }, g, 0);
    assert.ok(r.lines.length <= rows, `${rows}x${cols}`);
    for (const line of r.lines) assert.ok(width(line) <= cols, `${rows}x${cols}: ${plain(line)}`);
  }
  const big = m.render({ rows: 40, cols: 120 }, g, 0).lines.map(plain).join('\n');
  assert.ok(big.replace(/[│\s]/g, '').includes(path), 'the path is shown whole, broken across rows, never cut');
  assert.match(big, /↑↓ 1-\d+\/\d+/, 'a list taller than the box scrolls instead of being cut');
  assert.doesNotMatch(big, /Setting 59/);
  m.key(key('pagedown')); m.key(key('pagedown')); m.key(key('pagedown'));
  assert.match(m.render({ rows: 40, cols: 120 }, g, 0).lines.map(plain).join('\n'), /Setting 59[\s\S]*Not written: keys\./);
  assert.equal(m.key(key('enter'))?.value, false, 'the safe choice is focused first');
  m.key(key('right'));
  assert.equal(m.key(key('enter'))?.value, true);
  assert.equal(m.key(ch('n'))?.value, false);
  assert.equal(m.key(key('escape'))?.value, false);
  assert.equal(m.key(ch('y'))?.value, true);
});

test('a refused value\'s message is carried on its field when the form is rebuilt', (t) => {
  const root = repo(t);
  const field: Field | undefined = settingSections(readView(root, fresh()), fresh(), { errors: new Map([['concurrency', 'concurrency is at least 1']]) })
    .flatMap((s) => s.fields).find((f) => f.key === 'concurrency');
  assert.equal(field?.error, 'concurrency is at least 1', 'a refused value is shown on its field');
});

test('Save lists fields the form cannot name (worktree setup, checker), from the same merge, and writes them', async (t) => {
  const env = setup(t);
  env.session.overrides.worktreeSetup = 'npm ci';
  env.session.overrides.checker = { allowedCommands: ['make test'] };
  env.ctx.navigate('settings');
  await settle();
  env.s.key(ch('s'));
  await settle();
  assert.match(env.s.text, /worktreeSetup/);
  assert.match(env.s.text, /npm ci/);
  assert.match(env.s.text, /checker/);
  assert.doesNotMatch(env.s.text, /Other settings/, 'the extras name them, so no vague row');
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  const saved = JSON.parse(readFileSync(join(env.root, '.dulger/config.json'), 'utf8'));
  assert.equal(saved.worktreeSetup, 'npm ci', 'written exactly as the dialog said');
  assert.deepEqual(saved.checker, { allowedCommands: ['make test'] });
});

test('Commit settings after a save commits .dulger/config.json alone, on the named branch; other staged work stays staged', async (t) => {
  const env = setup(t, { stored: { concurrency: 3 } });
  git.git(env.root, ['add', '.dulger/config.json']);
  git.git(env.root, ['commit', '-qm', 'settings']);
  const { settingsOnlyDirty } = await import('../src/app/pages/settings.flows.ts');
  assert.equal(settingsOnlyDirty(env.root), false, 'a clean tree');
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('right'));
  env.s.key(ch('s'));
  await settle();
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  assert.equal(settingsOnlyDirty(env.root), true, 'the saved file is the only uncommitted change');
  assert.match(env.s.text, /! blocks the next run/, 'a tracked file with changes does keep a run from starting, and the notice says so');
  writeFileSync(join(env.root, 'README.md'), 'staged edit\n');
  git.git(env.root, ['add', 'README.md']);
  assert.equal(settingsOnlyDirty(env.root), false);
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  const ask = env.s.text;
  assert.match(ask, /Commit settings/);
  assert.match(ask, /Branch\s+main/);
  assert.match(ask, /Message\s+dulger: save settings/);
  assert.match(ask, /File\s+\.dulger\/config\.json/);
  assert.match(ask, /Left out\s+1 other file/, 'the staged edit is named as left out');
  assert.match(ask, /\[ Not now \]\s+Commit/, 'declining is the default');
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  assert.equal(git.git(env.root, ['log', '--format=%s', '-1']), 'dulger: save settings');
  assert.deepEqual(git.git(env.root, ['show', '--name-only', '--format=', 'HEAD']).trim(), '.dulger/config.json', 'only the settings file is in the commit');
  assert.equal(git.git(env.root, ['status', '--porcelain']), 'M  README.md', 'the staged edit is still staged');
  assert.match(env.s.text, /Committed [0-9a-f]+ → main/);
});

test('a commit git refuses (a hook) is shown in full and leaves the file as it was', async (t) => {
  const env = setup(t, { stored: { concurrency: 3 } });
  mkdirSync(join(env.root, '.git/hooks'), { recursive: true });
  writeFileSync(join(env.root, '.git/hooks/pre-commit'), '#!/bin/sh\necho "pre-commit: lint failed in src/app.ts line 3" >&2\nexit 1\n', { mode: 0o755 });
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('right'));
  env.s.key(ch('s'));
  await settle();
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  assert.match(env.s.text, /Commit refused/);
  assert.match(env.s.text, /pre-commit: lint failed in src\/app\.ts line 3/);
  assert.equal(git.git(env.root, ['log', '--format=%s', '-1']), 'initial');
  assert.match(git.git(env.root, ['status', '--porcelain', '--untracked-files=all']), /\?\? \.dulger\/config\.json/, 'still a new, uncommitted file');
});

test('after the app exits, one line says what was changed in it and not saved; flags from the command line and saved changes do not count', async (t) => {
  const { exitNote } = await import('../src/app/pages/settings.data.ts');
  // The session started with a command-line flag (--concurrency 6) the person never touched in the app.
  const env = setup(t, { stored: { concurrency: 3 }, session: fresh({ overrides: { concurrency: 6 } }) });
  const start = env.ctx.startSession as Session;
  assert.equal(exitNote(env.root, env.session, start), undefined, 'a flag value is not "changed in the app"');
  env.ctx.navigate('settings', { key: 'docs' });
  env.s.key(ch(' '));
  env.ctx.navigate('settings', { key: 'sandbox' });
  env.s.key(key('right'));
  const note = exitNote(env.root, env.session, start)!;
  assert.match(note, /^Not saved: Docs agent \(changed in the app this session\)\./, 'the Docs switch is named; the session-only sandbox is not');
  assert.match(note, /"Save settings" on the Settings tab keeps changes/);
  env.s.key(ch('s'));
  await settle();
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  env.s.key(key('enter'));
  await settle();
  assert.equal(exitNote(env.root, env.session, start), undefined, 'once saved, nothing is lost');
  assert.equal(env.ctx.startSession.overrides.concurrency, 6, 'the start snapshot is never changed');
});

test('a card budget not below the run budget gets a note on the field; Save does not write an empty "roles"', async (t) => {
  const env = setup(t, { stored: { concurrency: 3 } });
  env.ctx.navigate('settings', { key: 'budget' });
  env.s.key(key('right'));
  env.ctx.navigate('settings', { key: 'card-budget' });
  env.s.key(key('right'));
  for (let i = 0; i < 30; i++) env.s.key(key('right'));
  assert.match(env.row('Card budget'), /✎ {2}≥ run/, 'a short tag on the row');
  assert.match(helpText(env.page), /not below the run budget/, 'and why, in help');
  env.ctx.navigate('settings', { key: 'concurrency' });
  env.s.key(key('right'));
  env.s.key(ch('s'));
  await settle();
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  const saved = JSON.parse(readFileSync(join(env.root, '.dulger/config.json'), 'utf8'));
  assert.equal(saved.concurrency, 4);
  assert.ok(!Object.hasOwn(saved, 'roles'), 'no "roles": {} noise');
});

test('Router sits under Routing with the first start\'s labels, and Save writes it to your own config file', async (t) => {
  const env = setup(t, { stored: { concurrency: 3 } });
  t.after(() => rmSync(userConfigFile(), { force: true }));
  const lines = env.s.text.split('\n');
  assert.ok(lines.findIndex((l) => /Router/.test(l)) === lines.findIndex((l) => /Routing/.test(l)) + 1, 'the row after Routing');
  assert.match(env.row('Router'), /Planner \(claude\)/);
  env.ctx.navigate('settings', { key: 'router' });
  env.s.key(key('right'));
  assert.equal(env.session.overrides.routing?.router, 'jev-openrouter');
  assert.match(env.row('Router'), /Jev · OpenRouter.*✎/);
  env.s.key(ch('s'));
  await settle();
  assert.match(env.s.text, /Router\s+Planner \(claude\) → Jev · OpenRouter/);
  assert.ok(env.s.text.includes(userConfigFile()), 'your own file');
  env.s.key(key('right'));
  env.s.key(key('enter'));
  await settle();
  assert.equal(JSON.parse(readFileSync(userConfigFile(), 'utf8')).routing.router, 'jev-openrouter');
});
