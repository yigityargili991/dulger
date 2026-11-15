// The headless provider API: summaries, validation, a typed define, and keys kept in the user's keys file.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWN_PROVIDERS, KNOWN_PROVIDER_URLS, defaultKeyEnv, defineProvider, providerCommand, providerNameError, providerSummaries,
  providerUrlError, storeProviderKey, type Prompts,
} from '../src/replProviders.ts';
import { saveSessionConfig, sessionConfig } from '../src/replModels.ts';
import { keySource, keysFile, readKey, storeKey } from '../src/keys.ts';
import type { Session } from '../src/repl.ts';
import { userConfigFile } from '../src/sandbox.ts';

const home = mkdtempSync(join(tmpdir(), 'dulger-providers-home-'));
process.env.XDG_CONFIG_HOME = home;
delete process.env.OPENAI_API_KEY;
delete process.env.MY_API_API_KEY;

function repo(t: TestContext, stored: object = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dulger-providers-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(userConfigFile(), { force: true }); });
  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify(stored));
  return root;
}
const fresh = (): Session => ({ overrides: {}, yes: false, quiet: false, allowDirty: false });

test('names and base URLs are validated with messages a form can show', () => {
  assert.equal(providerNameError('my-api'), undefined);
  assert.equal(providerNameError('9lives'), 'provider names are letters, digits, - and _: "9lives"');
  assert.equal(providerNameError('a b'), 'provider names are letters, digits, - and _: "a b"');
  assert.equal(providerNameError('codex'), 'codex is a CLI backend and needs no provider entry');
  assert.equal(providerUrlError('https://api.example.com/v1'), undefined);
  assert.equal(providerUrlError('http://localhost:11434/v1'), undefined);
  assert.equal(providerUrlError('ftp://example.com'), 'the base URL must start with http:// or https://');
  assert.match(providerUrlError('http://')!, /not a valid URL/);
  for (const url of ['https://user:sk-secret@example.com/v1', 'https://example.com/v1?api_key=x', 'https://example.com/v1#frag']) {
    assert.match(providerUrlError(url)!, /must not contain credentials, a query or a fragment/, url);
  }
  assert.equal(defaultKeyEnv('my-api'), 'MY_API_API_KEY');
  assert.equal(defaultKeyEnv('ollama'), undefined);
  assert.equal(KNOWN_PROVIDER_URLS.openrouter, 'https://openrouter.ai/api/v1');
  assert.ok(KNOWN_PROVIDERS.includes('groq'));
});

test('define writes the session overrides only, keeps the entry\'s other fields, and summarises without the key', (t) => {
  const root = repo(t, { providers: { openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', maxTokens: 1234 } } });
  const session = fresh();
  const disk = readFileSync(join(root, '.dulger/config.json'), 'utf8');
  const made = defineProvider(session, sessionConfig(root, session), 'my-api', { baseUrl: 'https://llm.example.com/v1', apiKeyEnv: 'MY_API_API_KEY', model: 'm1' });
  assert.deepEqual(made, { name: 'my-api', baseUrl: 'https://llm.example.com/v1', model: 'm1', apiKeyEnv: 'MY_API_API_KEY', keySource: 'missing' });
  const edited = defineProvider(session, sessionConfig(root, session), 'openai', { baseUrl: 'https://proxy.example.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: '' });
  assert.equal(edited.model, undefined, 'an empty model is none yet');
  const config = sessionConfig(root, session);
  assert.equal(config.providers.openai?.maxTokens, 1234, 'fields the define does not name are kept');
  assert.equal(config.providers['my-api']?.maxTurns, 40, 'a new entry gets the provider defaults');
  assert.equal(readFileSync(join(root, '.dulger/config.json'), 'utf8'), disk, 'nothing is written until saved');

  const summaries = providerSummaries(config);
  assert.deepEqual(summaries.map((p) => p.name), ['ollama', 'deepseek', 'openai', 'my-api']);
  assert.deepEqual(summaries.find((p) => p.name === 'ollama'), { name: 'ollama', baseUrl: 'http://localhost:11434/v1', model: undefined, apiKeyEnv: undefined, keySource: undefined });

  const before = structuredClone(session);
  assert.throws(() => defineProvider(session, config, 'claude', { baseUrl: 'https://x.example/v1' }), /CLI backend/);
  assert.throws(() => defineProvider(session, config, 'leaky', { baseUrl: 'https://u:p@x.example/v1' }), /credentials/);
  assert.throws(() => defineProvider(session, config, 'leaky', { baseUrl: 'https://x.example/v1', apiKeyEnv: 'A B' }), /key variable/);
  // A pasted API key must not pass as a key variable name (it is not an environment variable name).
  assert.throws(() => defineProvider(session, config, 'leaky', { baseUrl: 'https://x.example/v1', apiKeyEnv: 'sk-proj-abc123' }), /environment variable name/);
  assert.throws(() => defineProvider(session, config, 'leaky', { baseUrl: 'https://x.example/v1', model: 'two words' }), /model IDs/);
  assert.deepEqual(session, before);
});

test('a key is stored in the user keys file, never in a config file', (t) => {
  const root = repo(t);
  const session = fresh();
  defineProvider(session, sessionConfig(root, session), 'my-api', { baseUrl: 'https://llm.example.com/v1', apiKeyEnv: 'MY_API_API_KEY', model: 'm1' });
  const config = sessionConfig(root, session);
  assert.equal(storeProviderKey(config, 'my-api', '  sk-test-1  '), keysFile());
  assert.equal(keysFile(), join(home, 'dulger', 'keys.json'));
  assert.equal(readKey('MY_API_API_KEY'), 'sk-test-1');
  assert.equal(keySource('MY_API_API_KEY'), 'keys file');
  assert.equal(providerSummaries(config).find((p) => p.name === 'my-api')?.keySource, 'keys file');
  assert.throws(() => storeProviderKey(config, 'nowhere', 'k'), /not a configured provider/);
  assert.throws(() => storeProviderKey(config, 'ollama', 'k'), /has no key variable/);
  assert.throws(() => storeProviderKey(config, 'my-api', '   '), /the key is empty/);
  assert.deepEqual(saveSessionConfig(root, session), [userConfigFile()], 'the provider goes to the user config file');
  assert.equal(readFileSync(userConfigFile(), 'utf8').includes('sk-test-1'), false);
  assert.equal(JSON.parse(readFileSync(userConfigFile(), 'utf8')).providers['my-api'].apiKeyEnv, 'MY_API_API_KEY');
});

test('/provider refuses a base URL that would carry a credential into the repository', async (t) => {
  const root = repo(t);
  const session = fresh();
  const prompts: Prompts = { ask: async () => 'https://user:sk-secret@llm.example.com/v1', askSecret: async () => undefined, say: () => {}, models: async () => [] };
  const lines = await providerCommand(root, session, ['my-api'], prompts);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /must not contain credentials/);
  assert.equal(session.overrides.providers, undefined);
});

test('storeKey refuses an unparseable keys file instead of overwriting it, and keys show unreadable', (t) => {
  const prev = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'dulger-keys-'));
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; rmSync(dir, { recursive: true, force: true }); });
  const file = keysFile();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '{ "OPENAI_API_KEY": "sk-keep", }\n'); // a trailing comma: hand-edited, not valid JSON
  assert.throws(() => storeKey('GROQ_API_KEY', 'sk-new'), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8').includes('sk-keep'), true, 'the existing keys are left untouched');
  assert.equal(readFileSync(file, 'utf8').includes('sk-new'), false, 'the new key is not written');
  assert.equal(keySource('OPENAI_API_KEY'), 'unreadable');
  assert.equal(readKey('OPENAI_API_KEY'), undefined, 'reading does not crash; the key is treated as absent');
});

test('a URL with credentials in an older config is masked by /provider and never offered as the default', async (t) => {
  const root = repo(t, { providers: { corp: { baseUrl: 'https://alice:s3cr3t@llm.corp.example/v1', apiKeyEnv: 'CORP_API_KEY', model: 'm1' } } });
  const listed = (await providerCommand(root, fresh(), [])).join('\n');
  assert.match(listed, /corp/);
  assert.match(listed, /https:\/\/•••@llm\.corp\.example\/v1/, 'the host stays readable, the credentials do not');
  assert.doesNotMatch(listed, /s3cr3t|alice/);
  const asked: string[] = [];
  const prompts: Prompts = {
    ask: async (q) => { asked.push(q); return undefined; },
    askSecret: async () => undefined,
    say: (line) => { asked.push(line); },
    models: async () => [],
  };
  await providerCommand(root, fresh(), ['corp'], prompts);
  assert.ok(asked.length > 0, 'the base URL was asked for');
  assert.doesNotMatch(asked.join('\n'), /s3cr3t|alice/, 'the old URL is not shown as the default');
});
