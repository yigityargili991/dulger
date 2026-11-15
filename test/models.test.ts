// The headless model API: role summaries, typed setters, model sets, candidate models and setup issues.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODEL_ROLES, MODEL_SETS, applyModelSet, candidateModels, describeRoleModel, resetRoleModel, sessionConfig,
  setGlobalModel, setRoleAuto, setRoleModel, setupIssues,
} from '../src/replModels.ts';
import { roleConfig } from '../src/config.ts';
import type { Session } from '../src/repl.ts';
import type { AgentRole } from '../src/types.ts';

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-models-home-'));
delete process.env.DEEPSEEK_API_KEY;

function repo(t: TestContext, stored: object = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dulger-models-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify(stored));
  return root;
}
const fresh = (): Session => ({ overrides: {}, yes: false, quiet: false, allowDirty: false });

test('describeRoleModel reports backend, model, mode, source, tiers and a missing key as data', (t) => {
  const root = repo(t);
  const session = fresh();
  const planner = describeRoleModel(sessionConfig(root, session), session, 'planner');
  assert.deepEqual(planner, {
    role: 'planner', harness: 'claude', model: 'fable', mode: 'auto tiers', source: 'repository/default', disabled: false,
    tiers: [{ tier: 'low', model: 'haiku' }, { tier: 'medium', model: 'sonnet' }, { tier: 'high', model: 'fable' }], missingKeyEnv: undefined,
  });
  setRoleModel(session, sessionConfig(root, session), 'worker', 'deepseek');
  const worker = describeRoleModel(sessionConfig(root, session), session, 'worker');
  assert.equal(worker.source, 'session role');
  assert.equal(worker.model, 'deepseek-flash');
  assert.equal(worker.missingKeyEnv, 'DEEPSEEK_API_KEY');
});

test('role setters pin, unpin and reset without parsing words, and refuse what cannot run', (t) => {
  const root = repo(t, { roles: { worker: { harness: 'codex', model: 'repo-worker' } } });
  const session = fresh();
  const config = () => sessionConfig(root, session);
  const resolve = (role: AgentRole) => roleConfig(config(), role);

  setGlobalModel(session, 'global-pin');
  setRoleModel(session, config(), 'planner', 'ollama', 'qwen3:8b');
  assert.deepEqual([resolve('planner').harness, resolve('planner').model], ['ollama', 'qwen3:8b']);
  assert.equal(resolve('checker').model, 'global-pin');

  setRoleAuto(session, config(), 'planner');
  assert.equal(resolve('planner').harness, 'ollama', 'auto keeps the backend');
  assert.equal(config().roles.planner?.model, undefined, 'and drops the pin');

  setRoleModel(session, config(), 'worker', 'fake', 'x');
  resetRoleModel(session, 'worker');
  assert.deepEqual([resolve('worker').harness, resolve('worker').model], ['codex', 'repo-worker']);
  assert.equal(describeRoleModel(config(), session, 'worker').source, 'repository reset');

  setGlobalModel(session, undefined);
  assert.equal(session.model, undefined);

  const before = structuredClone(session);
  assert.throws(() => setRoleModel(session, config(), 'worker', 'nowhere', 'm'), { message: /^harness is one of claude, codex, fake/ });
  assert.throws(() => setRoleModel(session, config(), 'worker', 'claude', 'has space'), /model IDs cannot/);
  assert.throws(() => setRoleModel(session, config(), 'worker', 'claude', ''), /model IDs cannot/);
  assert.throws(() => setRoleModel(session, config(), 'boss' as AgentRole, 'claude'), /unknown model role/);
  assert.throws(() => setGlobalModel(session, 'a\tb'), /model IDs cannot/);
  assert.deepEqual(session, before);
});

test('model sets are data, apply as before, and refuse unknown sets and backends', (t) => {
  const root = repo(t);
  assert.deepEqual(MODEL_SETS.map((s) => s.value), ['auto', 'balanced', 'low', 'high']);
  assert.ok(MODEL_SETS.every((s) => s.label && s.description));
  const session = fresh();
  session.model = 'stale';
  applyModelSet(session, sessionConfig(root, session), 'claude', 'balanced');
  const config = sessionConfig(root, session);
  assert.equal(session.model, undefined);
  assert.deepEqual(MODEL_ROLES.map((r) => roleConfig(config, r).model), ['fable', 'sonnet', 'fable', 'haiku', 'haiku']);
  const before = structuredClone(session);
  assert.throws(() => applyModelSet(session, config, 'claude', 'medium' as never), /model set is one of auto, balanced, low, high/);
  assert.throws(() => applyModelSet(session, config, 'nowhere', 'auto'), /harness is one of/);
  assert.deepEqual(session, before);
});

test('candidate models: current first, then tiers, aliases, the provider model and the remote list, once each', (t) => {
  const root = repo(t, { providers: { deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } } });
  const config = sessionConfig(root, fresh());
  assert.deepEqual(candidateModels(config, 'claude', 'opus'), ['opus', 'haiku', 'sonnet', 'fable']);
  assert.deepEqual(candidateModels(config, 'codex'), ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']);
  assert.deepEqual(candidateModels(config, 'deepseek', undefined, ['deepseek-pro', 'deepseek-flash']), ['deepseek-flash', 'deepseek-pro']);
  assert.deepEqual(candidateModels(config, 'ollama'), []);
});

test('setup issues name an enabled role on a provider without a model, and skip disabled roles', (t) => {
  const root = repo(t, { harness: 'ollama' });
  const config = sessionConfig(root, fresh());
  assert.deepEqual(setupIssues(config).map((i) => i.split(' ')[0]), ['planner', 'worker', 'checker', 'docs', 'reporter']);
  assert.deepEqual(setupIssues({ ...config, docs: false, progressIntervalSec: 0 }).map((i) => i.split(' ')[0]), ['planner', 'worker', 'checker']);
  assert.match(setupIssues(config)[0]!, /^planner on ollama needs a model/);
});

test('a failed model listing names its cause in a few words, without advice', async () => {
  const { endpointError } = await import('../src/app/pages/models.shared.ts');
  const p = { baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: undefined } as unknown as import('../src/config.ts').ApiConfig;
  const fetchFailed = (cause: object) => Object.assign(new TypeError('fetch failed'), { cause });
  assert.equal(endpointError(fetchFailed({ code: 'ECONNREFUSED' }), p), '127.0.0.1:9: connection refused');
  assert.equal(endpointError(fetchFailed({ code: 'ENOTFOUND' }), p), '127.0.0.1:9: host not found');
  assert.equal(endpointError(fetchFailed({ message: 'bad port' }), p), '127.0.0.1:9: port blocked by fetch');
  assert.equal(endpointError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), p), '127.0.0.1:9: no answer in 15 s');
  assert.equal(endpointError(new Error('HTTP 404 from 127.0.0.1:9'), p), '127.0.0.1:9: no model list here (HTTP 404)');
  assert.equal(endpointError(new Error('HTTP 401 from x'), { ...p, apiKeyEnv: 'X_KEY' }), '127.0.0.1:9: key refused (HTTP 401, X_KEY)');
  assert.equal(endpointError(new Error('HTTP 401 from x'), p), '127.0.0.1:9: needs a key (HTTP 401)');
  assert.equal(endpointError(new Error('something odd'), p), 'something odd', 'anything else is the tool\'s own message');
});
