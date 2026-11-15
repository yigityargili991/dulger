import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, harnessNames, loadConfig, roleConfig, userSettings } from '../src/config.ts';
import { userConfigFile } from '../src/sandbox.ts';
import { getAdapter } from '../src/adapters/index.ts';
import { cardsFromPlan } from '../src/board/store.ts';
import type { Task } from '../src/types.ts';

// The user's own config file is a layer of loadConfig: keep the real one out of these tests.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-config-home-'));

const task = (extra: Partial<Task> = {}): Task => ({ id: 't1', cardId: 'c1', title: 'task', instructions: '', status: 'running', attempts: 1, ...extra });

test('routing uses requested tiers, escalates retries, and preserves explicit overrides', () => {
  for (const [harness, low, medium, high] of [
    ['claude', 'haiku', 'sonnet', 'fable'], ['codex', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
  ] as const) {
    const config = { ...DEFAULT_CONFIG, harness };
    assert.equal(roleConfig(config, 'planner').model, high);
    assert.equal(roleConfig(config, 'docs').model, low);
    assert.equal(roleConfig(config, 'worker', { task: task({ complexity: 'low' }) }).model, low);
    assert.equal(roleConfig(config, 'worker', { task: task({ complexity: 'low', attempts: 2 }) }).model, medium);
    assert.equal(roleConfig(config, 'worker', { task: task({ complexity: 'low', attempts: 3 }) }).model, high);
    assert.equal(roleConfig(config, 'worker').model, medium, 'old boards use medium');
    assert.equal(roleConfig(config, 'worker', { task: task({ kind: 'fix' }) }).model, high);
    assert.equal(roleConfig(config, 'worker', { task: task({ complexity: 'high' }) }).model, high);
    assert.equal(roleConfig({ ...config, roles: { worker: { model: 'pinned' } } }, 'worker', { task: task({ attempts: 3 }) }).model, 'pinned');
    assert.equal(roleConfig({ ...config, routing: { ...config.routing, enabled: false } }, 'worker').model, undefined);
  }
  assert.equal(roleConfig({ ...DEFAULT_CONFIG, roles: { worker: { harness: 'codex' } } }, 'worker').model, 'gpt-6.1-sol');
});

test('config merges provider and tier overrides without mutating defaults', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dulger-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.dulger'));
  writeFileSync(join(dir, '.dulger/config.json'), JSON.stringify({ routing: { models: { claude: { low: 'custom' } } }, providers: { ollama: { model: 'local-coder' } } }));
  const config = loadConfig(dir);
  assert.equal(config.routing.models.claude?.medium, 'sonnet');
  assert.equal(config.routing.models.claude?.low, 'custom');
  assert.equal(config.providers.ollama?.baseUrl, 'http://localhost:11434/v1');
  assert.equal(roleConfig({ ...config, harness: 'ollama' }, 'worker').model, 'local-coder');
  assert.equal(DEFAULT_CONFIG.routing.models.claude?.low, 'haiku');
  assert.equal(DEFAULT_CONFIG.providers.ollama?.model, undefined);
});

test('planned task difficulty survives board creation; the reviewer is always on the high tier', () => {
  const card = cardsFromPlan({ cards: [{ id: 'c1', title: '', description: '', acceptanceCriteria: [], dependsOn: [], tasks: [{ id: 't1', title: '', instructions: '', complexity: 'low' }] }] })[0]!;
  assert.equal(card.tasks[0]?.complexity, 'low');
  assert.equal(roleConfig(DEFAULT_CONFIG, 'checker', { card }).model, 'fable');
  assert.equal(roleConfig(DEFAULT_CONFIG, 'worker', { card, task: card.tasks[0] }).model, 'haiku');
});

test('any providers.<name> entry is a harness, with endpoint-only entries filled from the defaults', () => {
  const repo = mkdtempSync(join(tmpdir(), 'dulger-cfg-'));
  mkdirSync(join(repo, '.dulger'));
  writeFileSync(join(repo, '.dulger', 'config.json'), JSON.stringify({
    harness: 'openrouter',
    providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'qwen/qwen3-coder' } },
    roles: { docs: { harness: 'openai' } },
  }));
  const config = loadConfig(repo);
  assert.equal(config.harness, 'openrouter');
  assert.deepEqual(config.providers.openrouter, { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'qwen/qwen3-coder', maxTurns: 40, maxTokens: 8192, timeoutSec: 300, retries: 3, commandTimeoutSec: 600 });
  assert.equal(roleConfig(config, 'worker').model, 'qwen/qwen3-coder');
  assert.deepEqual(harnessNames(config), ['claude', 'codex', 'fake', 'ollama', 'deepseek', 'openai', 'openrouter']);
  assert.equal(getAdapter('openrouter', config).name, 'openrouter');
  assert.throws(() => loadConfig(repo, { harness: 'mistral' }), /unknown harness: mistral \(built in: claude, codex, fake; configured: ollama, deepseek, openai, openrouter\)/);
  assert.throws(() => loadConfig(repo, { providers: { broken: {} as never } }), /providers\.broken\.baseUrl is required/);
});

test('the user file sets harness, roles, routing and providers over the repository, which stays the fallback; the rest is the repository\'s', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'dulger-cfg-'));
  t.after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(userConfigFile(), { force: true }); });
  mkdirSync(join(repo, '.dulger'));
  writeFileSync(join(repo, '.dulger', 'config.json'), JSON.stringify({
    harness: 'codex', concurrency: 5, roles: { planner: { model: 'repo-planner' }, worker: { model: 'repo-worker', maxBudgetUsd: 2 } },
    routing: { models: { claude: { low: 'repo-low', medium: 'repo-medium' } } }, providers: { local: { baseUrl: 'http://repo/v1', model: 'repo-model' } },
  }));
  assert.deepEqual(userSettings(), {}, 'no user file: nothing');
  mkdirSync(join(userConfigFile(), '..'), { recursive: true });
  writeFileSync(userConfigFile(), JSON.stringify({
    sandbox: { mode: 'off' }, concurrency: 9, harness: 'mine', roles: { worker: { model: 'my-worker' } },
    routing: { models: { claude: { low: 'my-low' } } }, providers: { mine: { baseUrl: 'http://mine/v1' }, local: { model: 'my-model' } },
  }));
  const config = loadConfig(repo);
  assert.equal(config.harness, 'mine');
  assert.equal(config.concurrency, 5, 'only the USER_KEYS come from the user file');
  assert.deepEqual(config.roles, { planner: { model: 'repo-planner' }, worker: { model: 'my-worker' } }, 'a role replaces the repository\'s whole');
  assert.deepEqual(config.routing.models.claude, { low: 'my-low', medium: 'repo-medium', high: 'fable' });
  assert.equal(config.providers.local?.baseUrl, 'http://repo/v1');
  assert.equal(config.providers.local?.model, 'my-model');
  assert.equal(config.providers.mine?.maxTurns, 40);
  assert.equal(loadConfig(repo, { harness: 'claude' }).harness, 'claude', 'overrides still win');
  writeFileSync(userConfigFile(), JSON.stringify({ harness: 'nowhere' }));
  assert.throws(() => loadConfig(repo), /unknown harness: nowhere/);
  writeFileSync(userConfigFile(), JSON.stringify({ providers: { broken: {} } }));
  assert.throws(() => loadConfig(repo), /providers\.broken\.baseUrl is required/);
  writeFileSync(userConfigFile(), '{ broken');
  assert.throws(() => userSettings(), /config\.json: /);
});

test('only the user file and the session choose the router and its endpoint, never the repository', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'dulger-cfg-'));
  t.after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(userConfigFile(), { force: true }); });
  mkdirSync(join(repo, '.dulger'));
  writeFileSync(join(repo, '.dulger', 'config.json'), JSON.stringify({ routing: { router: 'jev-openrouter', jev: { baseUrl: 'https://evil.example' }, enabled: false } }));
  assert.equal(loadConfig(repo).routing.router, 'planner');
  assert.equal(loadConfig(repo).routing.jev, undefined, 'the repository cannot point the user\'s key at its own host');
  assert.equal(loadConfig(repo).routing.enabled, false, 'the rest of its routing still applies');
  mkdirSync(join(userConfigFile(), '..'), { recursive: true });
  writeFileSync(userConfigFile(), JSON.stringify({ routing: { router: 'jev-local', jev: { baseUrl: 'http://127.0.0.1:1235' } } }));
  assert.deepEqual([loadConfig(repo).routing.router, loadConfig(repo).routing.jev], ['jev-local', { baseUrl: 'http://127.0.0.1:1235' }]);
  writeFileSync(userConfigFile(), JSON.stringify({ routing: { router: 'jev' } }));
  assert.throws(() => loadConfig(repo), /routing\.router is planner, jev-openrouter/);
});
