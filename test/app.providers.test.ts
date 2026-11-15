// The Providers tab and its add/edit form, driven through the real shell against a temporary
// repository and a temporary keys file. A key typed here must never reach a frame: every assertion on
// a key in a rendered frame proves its absence. The page draws labels, values and glyphs; what it used
// to explain is in help, and dialogs state their facts.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app/shell.ts';
import { createProvidersPage } from '../src/app/pages/providers.ts';
import type { NavParams, Page, PageFactory } from '../src/app/types.ts';
import { roleConfig, type ApiConfig } from '../src/config.ts';
import { keysFile, readKey } from '../src/keys.ts';
import { MODEL_ROLES, sessionConfig } from '../src/replModels.ts';
import type { Session } from '../src/repl.ts';
import type { IconSet } from '../src/tui/theme.ts';
import { SIZES, assertFrame, ch, fakeScreens, key, press, type FakeScreen } from './kit.helpers.ts';

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-app-providers-home-'));
for (const v of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'MYLLM_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[v];

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function repo(t: TestContext, stored: object = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-providers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify(stored));
  return root;
}

function recorder(id: string, log: Array<{ id: string; params?: NavParams }>): PageFactory {
  return () => ({ id, title: id, activate: (params) => { log.push({ id, params }); }, render: () => ({ lines: [`${id} page`] }), onKey: () => false, hints: () => [] });
}

function setup(t: TestContext, o: { stored?: object; user?: object; rows?: number; cols?: number; icons?: IconSet; lister?: (p: ApiConfig) => Promise<string[]> } = {}) {
  // A keys file of its own per test, so a key one test stores is not another's.
  const home = mkdtempSync(join(tmpdir(), 'dulger-app-providers-home-'));
  process.env.XDG_CONFIG_HOME = home;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (o.user) { mkdirSync(join(home, 'dulger')); writeFileSync(join(home, 'dulger/config.json'), JSON.stringify(o.user)); }
  const root = repo(t, o.stored);
  const session: Session = { overrides: {}, yes: false, quiet: false, allowDirty: false };
  const screens = fakeScreens(o.rows ?? 40, o.cols ?? 120);
  const visits: Array<{ id: string; params?: NavParams }> = [];
  const asked: ApiConfig[] = [];
  const lister = o.lister ?? (async () => ['llama-a', 'llama-b']);
  let page!: Page;
  const pages: PageFactory[] = [
    (ctx) => { page = createProvidersPage(ctx, { listModels: (p) => { asked.push(p); return lister(p); } }); return page; },
    recorder('models', visits), recorder('settings', visits),
  ];
  const app = createApp({ repoRoot: root, session, version: '1.0.0', config: () => sessionConfig(root, session), pages, openScreen: screens.factory, icons: o.icons ?? 'unicode', branch: () => 'main' });
  const done = app.run();
  t.after(async () => { app.quit(); await done; });
  const disk = readFileSync(join(root, '.dulger/config.json'), 'utf8');
  return {
    root, session, screens, visits, asked, app, config: () => sessionConfig(root, session),
    get s() { return screens.current; },
    get page() { return page; },
    /** The repository's config file is exactly as it was: nothing here writes it. */
    untouched: () => assert.equal(readFileSync(join(root, '.dulger/config.json'), 'utf8'), disk, 'the repository config was not written'),
  };
}

/** Select the list row whose provider cell starts with `name`. */
function selectRow(s: FakeScreen, name: string): void {
  for (let i = 0; i < 12; i++) s.key(key('up'));
  for (let i = 0; i < 12 && !new RegExp(`❯ (\\+ )?${name}\\b`).test(s.text); i++) s.key(key('down'));
  assert.match(s.text, new RegExp(`❯ (\\+ )?${name}\\b`), `row ${name}`);
}

/** Everything a page's help says, as one text. */
const helpText = (page: Page) => (page.help?.() ?? []).flatMap((h) => [h.title, ...[h.text ?? []].flat(), ...h.keys.map((k) => `${k.key} ${k.label}`)]).join('\n');

/** Type `secret` one character at a time, checking that no frame ever shows any of it. */
function typeSecret(s: FakeScreen, secret: string): void {
  for (const c of secret) {
    s.type(c);
    assert.doesNotMatch(s.text, /SECRET|sk-/, 'no part of the key is drawn');
  }
}

test('the list: configured providers with URL, model and a key glyph; known ones to add; the selected one\'s facts', (t) => {
  process.env.OPENAI_API_KEY = 'sk-env-SECRET-1';
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  const { s, page } = setup(t);
  const text = s.text;
  // No header; no model is a dash; the key is a glyph (none when the endpoint takes no key).
  assert.match(text, /❯ ollama\s+http:\/\/localhost:11434\/v1\s+—\s+│/);
  assert.match(text, /deepseek\s+https:\/\/api\.deepseek\.com\s+deepseek-flash\s+!\s+│/, 'missing');
  assert.match(text, /openai\s+https:\/\/api\.openai\.com\/v1\s+—\s+✓\s+│/, 'from the environment');
  for (const name of ['openrouter', 'groq', 'together', 'mistral', 'fireworks']) assert.match(text, new RegExp(`│ {3}\\+ ${name}\\s+│`), `${name}: + and the name`);
  assert.match(text, /\+ another…\s+│/);
  assert.doesNotMatch(text, /Provider\s+Base URL|\badd\b|not needed|environment|missing|none/, 'no header, no words a glyph or a dash says');
  assert.doesNotMatch(text, /keys are never shown|set up\)|OpenAI-compatible|api\.groq\.com/, 'state only: no captions, and a provider not set up is a name');
  // The selected provider's facts are values, not sentences.
  assert.match(text, /Default model\s+—\s/);
  assert.match(text, /Key variable\s+—\s/);
  assert.match(text, /Key\s+—\s/, 'no key variable: no key to have');
  assert.match(text, /Used by\s+—/);
  assert.match(text, /Defined by\s+built in/);
  assert.doesNotMatch(text, /none yet|called without a key|no role yet|Actions/);
  assert.doesNotMatch(text, /SECRET|sk-env/, 'a key from the environment is never drawn');
  assert.doesNotMatch(text, /\/provider|\/config|config\.json/, 'no command syntax in the UI');
  const groups = page.help!();
  assert.equal(groups[0]!.title, 'ollama', 'help leads with the selected provider');
  assert.match(helpText(page), /No default model: a role on it needs one[\s\S]*Called without a key/, 'and what its values mean');
  assert.match(helpText(page), /About\n[\s\S]*Key: ✓ set, ! missing or unreadable[\s\S]*Keys are never shown/, 'the glyphs are explained in help');
});

test('Defined by: yours for a provider in your own config file, over the repository\'s', (t) => {
  const corp = { baseUrl: 'https://llm.corp/v1' };
  const { s, page } = setup(t, { stored: { providers: { corp, side: corp } }, user: { providers: { corp } } });
  selectRow(s, 'corp');
  assert.match(s.text, /Defined by\s+yours/);
  assert.match(helpText(page), /Defined by your own config file/);
  selectRow(s, 'side');
  assert.match(s.text, /Defined by\s+repository/);
});

test('every size fits, in every glyph set, down to 1×1', (t) => {
  for (const icons of ['unicode', 'ascii', 'nerd'] as const) {
    const { s, app } = setup(t, { icons });
    for (const [rows, cols] of SIZES) {
      s.resize(rows, cols);
      assertFrame(s.lines, rows, cols, `providers ${icons}`);
    }
    s.resize(24, 80);
    assert.match(s.text, /Providers/);
    assert.match(s.text, /Base URL/);
    app.ctx.navigate('providers', { provider: 'groq', add: true });
    for (const [rows, cols] of SIZES) {
      s.resize(rows, cols);
      assertFrame(s.lines, rows, cols, `provider form ${icons}`);
    }
  }
});

test('adding a known provider: prefilled form, masked key into the keys file, model from the endpoint, then saved for the session', async (t) => {
  const env = setup(t);
  const { s, app, session, asked, untouched, config } = env;
  app.ctx.navigate('providers', { provider: 'groq', add: true });
  assert.match(s.text, /New provider/);
  assert.match(s.text, /Name\s+\[?groq/);
  assert.match(s.text, /Base URL\s+https:\/\/api\.groq\.com\/openai\/v1/);
  assert.match(s.text, /Key variable\s+GROQ_API_KEY/);
  assert.match(s.text, /Key\s+missing\s/);
  assert.doesNotMatch(s.text, /OpenAI-compatible|API key\s|Model\s{2}/, 'no notes and no section titles');
  assert.match(s.text, /Providers › groq/, 'the breadcrumb names it');

  for (let i = 0; i < 3; i++) s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /API key for groq/);
  assert.match(s.text, /GROQ_API_KEY → /, 'the prompt says which variable and where it goes');
  assert.match(s.text, /stored at once/);
  typeSecret(s, 'sk-groq-SECRET-42');
  s.key(key('enter'));
  await tick();
  assert.doesNotMatch(s.text, /SECRET|sk-groq/);
  assert.match(s.text, /Key for groq stored/);
  assert.match(s.text, /Key\s+keys file/);
  assert.equal(readKey('GROQ_API_KEY'), 'sk-groq-SECRET-42', 'the key is in the keys file');
  assert.equal(statSync(keysFile()).mode & 0o777, 0o600);

  s.key(key('down'));
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(asked[0]!.apiKeyEnv, 'GROQ_API_KEY');
  assert.ok(!JSON.stringify(asked[0]).includes('SECRET'), 'the lister gets the variable name, not the key');
  assert.match(s.text, /groq: 2 listed/);
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Default model\s+llama-b/);

  s.key(key('ctrl', 'o'));
  await tick();
  assert.deepEqual(
    { baseUrl: session.overrides.providers?.groq?.baseUrl, apiKeyEnv: session.overrides.providers?.groq?.apiKeyEnv, model: session.overrides.providers?.groq?.model },
    { baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', model: 'llama-b' },
  );
  assert.ok(!JSON.stringify(session).includes('SECRET'), 'the session never holds the key');
  assert.ok(config().providers.groq);
  assert.match(s.text, /Added groq/);
  assert.match(s.text, /❯ groq ✎\s+https:\/\/api\.groq\.com\/openai\/v1\s+llama-b\s+✓/, 'back on the list with it selected');
  assert.match(s.text, /Providers ─+ ✎1 ─╮/, 'the panel counts what this session defined');
  assert.match(s.text, /Defined by\s+session/);
  assert.match(s.text, /Save…/, 'and Save… among its buttons');
  assert.match(helpText(env.page), /Defined this session, not saved yet/, 'what it means is in help');
  assert.doesNotMatch(s.text, /SECRET/);
  untouched();
});

test('skipping the key leaves a clear "missing" state; Esc on a changed form asks before discarding', async (t) => {
  const { s, app, session } = setup(t);
  app.ctx.navigate('providers', { provider: 'openrouter', add: true });
  for (let i = 0; i < 3; i++) s.key(key('down'));
  s.key(key('enter'));
  await tick();
  s.key(key('escape'));
  await tick();
  assert.match(s.text, /No key stored/);
  assert.match(s.text, /Key\s+missing\s/);
  s.key(key('down'));
  s.type('qwen-coder');
  s.key(key('enter'));
  s.key(key('escape'));
  await tick();
  assert.match(s.text, /Discard changes/);
  assert.match(s.text, /· Default model\s+qwen-coder/, 'the dialog lists what is lost');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /New provider/, 'the safe choice keeps the form');
  s.key(key('escape'));
  await tick();
  // Discard changes is a danger confirm: take the focused button and Enter (y no longer accepts one).
  s.key(key('right'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /❯ \+ openrouter/);
  assert.equal(session.overrides.providers, undefined, 'nothing was defined');
});

test('the form validates name, URL and key variable with readable messages', async (t) => {
  const { s, session } = setup(t);
  s.key(ch('a'));
  await tick();
  assert.match(s.text, /Name\s+\[?\(e\.g\. groq\)/);
  s.key(key('ctrl', 'o'));
  await tick();
  assert.match(s.text, /Give the provider a name/);
  s.type('9x');
  s.key(key('enter'));
  assert.match(s.text, /Provider names are letters, digits, - and _/);
  s.key(key('backspace'));
  s.key(key('backspace'));
  s.type('myllm');
  s.key(key('enter'));
  assert.match(s.text, /Key variable\s+MYLLM_API_KEY/, 'a new name gets its default key variable');
  s.key(key('ctrl', 'o'));
  await tick();
  assert.match(s.text, /Enter the base URL/);
  s.type('https://user:pw@llm.example.com/v1');
  s.key(key('enter'));
  assert.match(s.text, /must not contain credentials/);
  for (let i = 0; i < 40; i++) s.key(key('backspace'));
  s.type('https://llm.example.com/v1');
  s.key(key('enter'));
  s.type(' X');
  s.key(key('enter'));
  assert.match(s.text.replace(/[│\s]+/g, ' '), /The key variable must be an environment variable name: letters, digits and _, not starting with a digit \(e\.g\. GROQ_API_KEY\)\./, 'whole, under the field');
  s.key(key('backspace'));
  s.key(key('backspace'));
  s.key(key('ctrl', 'o'));
  await tick();
  assert.equal(session.overrides.providers?.myllm?.baseUrl, 'https://llm.example.com/v1');
  assert.equal(session.overrides.providers?.myllm?.model, undefined);
  assert.match(s.text, /Added myllm · no model · no key/, 'what it still lacks, as state words');
  assert.match(s.text, /myllm ✎/);
});

test('typing the name of a provider that is already set up edits it instead', async (t) => {
  const { s } = setup(t);
  s.key(ch('a'));
  await tick();
  s.type('deepseek');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /deepseek exists: editing it/);
  assert.match(s.text, /Edit deepseek/);
  assert.match(s.text, /Name\s+deepseek\s+fixed/);
  assert.match(s.text, /Default model\s+deepseek-flash/);
});

test('editing: the name is fixed; a changed model is saved for the session only', async (t) => {
  const { s, session, untouched } = setup(t);
  selectRow(s, 'deepseek');
  s.key(key('enter'));
  assert.match(s.text, /Edit deepseek/);
  assert.match(s.text, /Name\s+deepseek\s+fixed/);
  assert.doesNotMatch(s.text, /Changes last for this session/, 'no notes on the form');
  s.key(key('f1'));
  assert.match(s.text, /Base URL[\s\S]*before \/chat\/completions/, 'help leads with the focused field');
  assert.match(s.text, /defines the provider for this session/, 'and says what saving the form does');
  s.key(key('escape'));
  for (let i = 0; i < 3; i++) s.key(key('down'));
  for (let i = 0; i < 20; i++) s.key(key('backspace'));
  s.type('deepseek-pro');
  s.key(key('ctrl', 'o'));
  await tick();
  assert.equal(session.overrides.providers?.deepseek?.model, 'deepseek-pro');
  assert.equal(session.overrides.providers?.deepseek?.maxTurns, 40, 'other fields are kept');
  assert.match(s.text, /Updated deepseek · no key/);
  untouched();
});

test('actions: enter a key, re-pick the model, use for all roles, use for one role', async (t) => {
  const { s, session, config, visits, asked } = setup(t);
  selectRow(s, 'deepseek');
  s.key(ch('s'));
  await tick();
  assert.match(s.text, /API key for deepseek/);
  typeSecret(s, 'sk-ds-SECRET-7');
  s.key(key('enter'));
  await tick();
  assert.equal(readKey('DEEPSEEK_API_KEY'), 'sk-ds-SECRET-7');
  assert.match(s.text, /deepseek\s+https:\/\/api\.deepseek\.com\s+deepseek-flash\s+✓/);
  assert.match(s.text, /Key\s+keys file/, 'and where it is, in the facts');
  assert.doesNotMatch(s.text, /SECRET|sk-ds/);

  s.key(ch('m'));
  await tick();
  assert.equal(asked.length, 1, 'with a key the endpoint is asked');
  assert.match(s.text, /Default model for deepseek/);
  s.key(key('down'));
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.equal(session.overrides.providers?.deepseek?.model, 'llama-b');

  s.key(ch('u'));
  await tick();
  assert.match(s.text, /Use deepseek for all roles/);
  assert.match(s.text, /Backend\s+deepseek/, 'the facts: backend, model, routing and what is reset');
  assert.match(s.text, /Model\s+llama-b\s/);
  assert.match(s.text, /Routing\s+on/);
  assert.match(s.text, /Resets\s+role choices, global pin/);
  s.key(ch('y'));
  await tick();
  for (const r of MODEL_ROLES) assert.equal(roleConfig(config(), r).harness, 'deepseek', r);
  assert.match(s.text, /All roles → deepseek/);
  assert.match(s.text.replace(/[│\s]+/g, ' '), /Used by planner, worker, reviewer, docs agent, progress reporter /, 'whole, wrapped under itself when long');

  selectRow(s, 'openai');
  s.key(ch('o'));
  await tick();
  assert.match(s.text, /Run one role on openai/);
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.deepEqual(session.modelRoles?.worker, { harness: 'openai', model: undefined });
  assert.deepEqual(visits.at(-1), { id: 'models', params: { role: 'worker' } }, 'then to Models to refine it');
});

test('a missing key or a failing endpoint is a note in the model picker, and errors never carry the key', async (t) => {
  process.env.DEEPSEEK_API_KEY = 'sk-redact-SECRET-9';
  t.after(() => { delete process.env.DEEPSEEK_API_KEY; });
  const { s, asked, session } = setup(t, { lister: async () => { throw new Error('401: key sk-redact-SECRET-9 was rejected'); } });
  selectRow(s, 'openai');
  s.key(ch('m'));
  await tick();
  assert.equal(asked.length, 0, 'no key: the endpoint is not asked');
  assert.match(s.text, /! openai: no key \(OPENAI_API_KEY\)/);
  s.key(key('end'));
  s.key(key('enter'));
  await tick();
  s.type('gpt-x');
  s.key(key('enter'));
  await tick();
  assert.equal(session.overrides.providers?.openai?.model, 'gpt-x', 'typing an ID works without the list');
  selectRow(s, 'deepseek');
  s.key(ch('m'));
  await tick();
  assert.equal(asked.length, 1);
  assert.match(s.text, /! deepseek: 401: key \[key\]/, 'the tool\'s own message');
  assert.doesNotMatch(s.text, /SECRET|sk-redact/);
});

test('activate({ provider, add }) selects or opens it; bad or unknown values are ignored', (t) => {
  const { s, app } = setup(t);
  app.ctx.navigate('providers', { provider: 'openai' });
  assert.match(s.text, /❯ openai/);
  app.ctx.navigate('providers', { provider: 'not a name!' });
  assert.match(s.text, /❯ openai/, 'an invalid name changes nothing');
  app.ctx.navigate('providers', { provider: 'mistral' });
  assert.match(s.text, /❯ \+ mistral/);
  app.ctx.navigate('providers', { provider: 'openai', add: true });
  assert.match(s.text, /Edit openai/, 'add on a configured provider edits it');
  app.ctx.navigate('providers', { provider: 'brand-new', add: true });
  assert.match(s.text, /Name\s+\[?brand-new/);
  assert.match(s.text, /Key variable\s+BRAND_NEW_API_KEY/);
});

test('keys, palette and help: Tab to the actions, ^s to Settings, every action titled', async (t) => {
  const { s, page } = setup(t);
  selectRow(s, 'deepseek');
  s.key(key('tab'));
  assert.match(s.text, /❯ \[ Edit… \]/, 'the focused button');
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /API key for deepseek/, 'the actions are buttons too');
  s.key(key('escape'));
  await tick();
  s.key(key('tab'));
  s.key(key('ctrl', 's'));
  await tick();
  assert.match(s.text, /Save settings|Nothing to save/, '^s saves here, showing what first');
  s.key(key('escape'));
  s.key(ch('1'));
  const ids = page.commands!().map((c) => c.id);
  assert.deepEqual(ids, ['edit', 'key', 'model', 'all', 'one', 'add', 'save'], 'the selected provider\'s actions and the page\'s: no entry per row');
  assert.ok(page.commands!().every((c) => !c.group), 'no group of its own');
  for (const title of ['Edit deepseek', 'Set the key for deepseek', "Choose deepseek's default model", 'Use deepseek for all roles', 'Use deepseek for one role', 'Add a provider', 'Save the providers']) {
    s.key(key('ctrl', 'p'));
    s.type(title);
    assert.match(s.text, new RegExp(`❯ (Providers: )?${title}`), title);
    s.key(key('escape'));
    s.key(key('escape'));
  }
  s.key(ch('?'));
  assert.match(s.text, /On a provider/);
  assert.match(s.text, /not the keys/);
  assert.match(s.text, /Keys are never shown/);
  s.key(key('escape'));
  assert.ok(page.hints().length <= 4, 'at most four keys in the footer');
  s.key(key('tab'));
  assert.equal(page.help!()[0]!.title, 'Set key…', 'with the buttons focused, help leads with the focused one');
});

test('mouse: a click selects a row and a second click opens it', (t) => {
  const { s } = setup(t);
  const row = s.text.split('\n').findIndex((l) => /\+ groq/.test(l));
  s.mouse(press(row, 6));
  assert.match(s.text, /❯ \+ groq/);
  s.mouse(press(row, 6));
  assert.match(s.text, /New provider/);
  assert.match(s.text, /Name\s+\[?groq/);
});

test('a broken configuration is an error state, not a crash', (t) => {
  const { s, root } = setup(t);
  writeFileSync(join(root, '.dulger/config.json'), '{ broken');
  s.key(ch('2'));
  s.key(ch('1'));
  assert.match(s.text, /! \.dulger\/config\.json: \S/, 'the reader\'s own message, naming the file');
  writeFileSync(join(root, '.dulger/config.json'), '{}');
  s.key(ch('r'));
  assert.match(s.text, /deepseek/);
});

test('the provider form asks before its changes are lost to navigate or quit, and Cancel asks too', async (t) => {
  const { s, app, session } = setup(t);
  app.ctx.navigate('providers', { provider: 'groq', add: true });
  s.key(key('down'));
  s.type('x');
  s.key(key('enter'));
  s.key({ name: 'alt', ch: '2' });
  assert.match(s.text, /models page/, 'a tab switch does not ask');
  app.ctx.navigate('providers', { provider: 'groq', add: true });
  assert.match(s.text, /Discard changes/, 'shown again over its form and asked');
  assert.match(s.text, /· Base URL/, 'listing what is lost');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /New provider/, 'kept');
  s.key(key('ctrl', 'd'));
  await tick();
  assert.match(s.text, /Quit with unsaved changes\?/);
  s.key(key('escape'));
  await tick();
  assert.match(s.text, /New provider/);
  assert.equal(session.overrides.providers, undefined, 'nothing was defined');
});

test('the provider form: clearing the key variable moves on; typing on a row that takes none does nothing; Enter on an empty model lists models; ^s is not its key', async (t) => {
  const env = setup(t);
  const { s } = env;
  selectRow(s, '\\+ another');
  s.key(key('enter'));
  await tick();
  s.type('localllm');
  s.key(key('enter'));
  s.type('http://127.0.0.1:9/v1');
  s.key(key('enter'));
  assert.match(s.text, /❯ Key variable/);
  s.key(key('ctrl', 'u'));
  s.key(key('enter'));
  assert.doesNotMatch(s.text, /❯ Name/, 'item 8: focus did not jump back to Name');
  assert.match(s.text, /❯ \[ Set key… \]/, 'it moved on, to "Set key…", disabled without a key variable, not "Replace key…"');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /No key variable/, 'pressing it says why, and only then');
  assert.doesNotMatch(s.text, /API key for/, 'and asks for no key');
  s.key(key('down'));
  assert.match(s.text, /❯ Default model/);
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Default model for localllm/, 'Enter on an empty Default model opens the model picker');
  s.key(key('escape'));
  await tick();
  s.key(key('down'));
  assert.match(s.text, /❯ \[ List models… \]/);
  s.type('gsk-1234');
  await tick();
  assert.doesNotMatch(s.text, /No typing here/, 'stray typing on a button row does nothing, silently');
  assert.match(s.text, /New provider|localllm/, 'still on the form: no shortcut or tab switch fired');
  assert.equal(env.visits.length, 0);
  s.key(key('ctrl', 's'));
  await tick();
  assert.match(s.text, /\^o adds here/);
  env.untouched();
});

test('a key stored from the form stays stored when the form is cancelled, and leaving says so', async (t) => {
  const env = setup(t);
  const { s } = env;
  selectRow(s, '\\+ together');
  s.key(key('enter'));
  await tick();
  for (let i = 0; i < 3; i++) s.key(key('down'));
  assert.match(s.text, /❯ \[ Set key… \]/);
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /TOGETHER_API_KEY → [\s\S]*stored at once/, 'the prompt says it is stored at once');
  typeSecret(s, 'tg-SECRET-key');
  s.key(key('enter'));
  await tick();
  s.key(key('escape'));
  await tick();
  assert.match(s.text, /TOGETHER_API_KEY stays stored/);
  assert.equal(readKey('TOGETHER_API_KEY'), 'tg-SECRET-key');
  env.untouched();
});

test('sent from Models to set a missing key, Providers lands on Set key… in that provider\'s actions', async (t) => {
  const env = setup(t);
  env.app.ctx.navigate('providers', { provider: 'deepseek', action: 'key' });
  await tick();
  assert.match(env.s.text, /❯ deepseek/);
  assert.match(env.s.text, /❯ \[ Set key… \]/, 'the action is focused, ready for Enter');
});
