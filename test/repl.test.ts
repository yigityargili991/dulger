import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, type Session } from '../src/repl.ts';
import { sessionConfig } from '../src/replModels.ts';
import { DEFAULT_CONFIG, loadConfig, roleConfig } from '../src/config.ts';

function setup(t: TestContext, stored: object = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'dulger-repl-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, '.dulger'));
  const file = join(repo, '.dulger/config.json');
  writeFileSync(file, JSON.stringify(stored));
  const session: Session = { overrides: {}, yes: false, quiet: false, allowDirty: false };
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args.join(' ')));
  const run = (text: string) => command(text, repo, session);
  const resolve = (role: Parameters<typeof roleConfig>[1]) => roleConfig(sessionConfig(repo, session), role);
  return { repo, file, session, output, run, resolve };
}

test('REPL sets mixed role models and shows effective choices without writing configuration', async (t) => {
  const { file, run, resolve, output } = setup(t);
  const before = readFileSync(file, 'utf8');
  await run('/model planner fable');
  await run('/model worker deepseek');
  await run('/model checker sonnet');
  await run('/model docs haiku');
  assert.equal(resolve('planner').harness, 'claude');
  assert.equal(resolve('planner').model, 'claude-fable-5-1');
  assert.equal(resolve('worker').harness, 'deepseek');
  assert.equal(resolve('worker').model, 'deepseek-flash');
  assert.equal(resolve('checker').model, 'sonnet');
  assert.equal(resolve('docs').model, 'haiku');
  await run('/model');
  assert.match(output.at(-1)!, /planner.*claude.*claude-fable-5-1.*pinned/);
  assert.match(output.at(-1)!, /worker.*deepseek.*deepseek-flash.*provider\/harness default/);
  await run('/model planner astra');
  assert.equal(resolve('planner').harness, 'codex');
  assert.equal(resolve('planner').model, 'gpt-6-astra');
  await run('/status');
  assert.match(output.at(-1)!, /planner.*gpt-6-astra/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('explicit backend/model pairs support custom endpoints and model tags', async (t) => {
  const { run, resolve, output } = setup(t);
  await run('/model worker ollama qwen3:8b');
  assert.equal(resolve('worker').harness, 'ollama');
  assert.equal(resolve('worker').model, 'qwen3:8b');
  await run('/model worker openai vendor/custom-model');
  assert.equal(resolve('worker').harness, 'openai');
  assert.equal(resolve('worker').model, 'vendor/custom-model');
  await run('/model worker ollama');
  assert.equal(resolve('worker').model, undefined);
  assert.match(output.at(-1)!, /model required/);
});

test('auto keeps the backend, removes pins and reports the active routing policy', async (t) => {
  const { run, resolve, output, session, repo } = setup(t, { roles: { worker: { model: 'repository-pin', maxBudgetUsd: 5 } } });
  await run('/model worker sol');
  await run('/model worker auto');
  assert.equal(resolve('worker').harness, 'codex');
  assert.equal(sessionConfig(repo, session).roles.worker?.model, undefined);
  assert.equal(resolve('worker').model, 'gpt-5.6-sol');
  assert.equal(resolve('worker').maxBudgetUsd, 5);
  assert.match(output.at(-1)!, /auto tiers/);
  assert.match(output.at(-1)!, /low: gpt-5.6-luna.*high: gpt-6-astra/);
  await run('/routing off');
  await run('/model worker');
  assert.equal(resolve('worker').model, undefined);
  assert.match(output.at(-1)!, /provider\/harness default/);
});

test('role choices override global pins in either order; reset restores the repository role', async (t) => {
  const { run, resolve, output } = setup(t, { harness: 'claude', roles: { worker: { harness: 'codex', model: 'repo-worker' } } });
  await run('/model global-pin');
  await run('/model planner astra');
  assert.equal(resolve('planner').model, 'gpt-6-astra');
  assert.equal(resolve('worker').model, 'global-pin');
  await run('/model next-global-pin');
  assert.equal(resolve('planner').model, 'gpt-6-astra');
  assert.equal(resolve('worker').model, 'next-global-pin');
  assert.match(output.at(-1)!, /explicit role choices and resets take precedence/);
  await run('/model worker deepseek');
  await run('/model worker reset');
  assert.equal(resolve('worker').harness, 'codex');
  assert.equal(resolve('worker').model, 'repo-worker');
  assert.match(output.at(-1)!, /repository reset/);
  await run('/model off');
  assert.equal(resolve('planner').model, 'gpt-6-astra');
  assert.equal(resolve('checker').model, 'claude-fable-5-1');
});

test('/set model uses the same parser, and bad commands leave the session unchanged', async (t) => {
  const { run, resolve, session } = setup(t);
  await run('/set model planner astra');
  assert.equal(resolve('planner').model, 'gpt-6-astra');
  const before = structuredClone(session);
  for (const text of ['/model worker typo', '/model typo deepseek', '/model planner astra extra', '/model worker codex model extra', '/config unknown']) {
    await assert.rejects(run(text));
    assert.deepEqual(session, before);
  }
});

test('/config save persists the effective mix, removes old pins for auto, and preserves unrelated fields', async (t) => {
  const stored = {
    custom: { keep: true }, concurrency: 7,
    roles: { planner: { model: 'old', maxBudgetUsd: 2, customRoleSetting: 'keep' }, worker: { model: 'old-worker' } },
    providers: { openai: { baseUrl: 'https://example.invalid/v1', apiKeyEnv: 'TEST_PROVIDER_KEY', customProviderSetting: 'keep' } },
    routing: { models: { codex: { low: 'my-luna' } } },
  };
  const { repo, file, run, session } = setup(t, stored);
  await run('/model planner astra');
  await run('/model worker codex');
  await run('/model worker auto');
  await run('/concurrency 4');
  await run('/yes on'); await run('/quiet on'); await run('/dirty on');
  await run('/config save');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.concurrency, 4);
  assert.deepEqual(saved.custom, stored.custom);
  assert.deepEqual(saved.providers, stored.providers);
  assert.deepEqual(saved.routing, stored.routing);
  assert.equal(saved.roles.planner.customRoleSetting, 'keep');
  assert.equal(saved.roles.planner.maxBudgetUsd, 2);
  assert.equal(saved.roles.planner.model, 'gpt-6-astra');
  assert.equal(saved.roles.worker.harness, 'codex');
  assert.equal(Object.hasOwn(saved.roles.worker, 'model'), false);
  assert.equal(Object.hasOwn(saved, 'yes'), false);
  assert.equal(Object.hasOwn(saved, 'quiet'), false);
  assert.equal(Object.hasOwn(saved, 'allowDirty'), false);
  const fresh: Session = { ...session, overrides: {}, modelRoles: undefined, model: undefined };
  for (const role of ['planner', 'worker', 'checker', 'docs'] as const) {
    assert.deepEqual(roleConfig(sessionConfig(repo, fresh), role), roleConfig(sessionConfig(repo, session), role));
  }
  assert.equal(roleConfig(loadConfig(repo), 'worker', { task: { id: 't1', cardId: 'c1', title: '', instructions: '', complexity: 'low', status: 'pending', attempts: 0 } }).model, 'my-luna');
  assert.deepEqual(readdirSync(join(repo, '.dulger')), ['config.json']);
});

test('/config save persists global pins with role exceptions and creates a missing config', async (t) => {
  const { repo, file, run, session } = setup(t);
  rmSync(join(repo, '.dulger'), { recursive: true });
  await run('/model global-pin');
  await run('/model worker deepseek');
  await run('/config save');
  assert.ok(existsSync(file));
  const reloaded = loadConfig(repo);
  assert.equal(roleConfig(reloaded, 'planner').model, 'global-pin');
  assert.equal(roleConfig(reloaded, 'worker').model, 'deepseek-flash');
  assert.equal(DEFAULT_CONFIG.roles.planner, undefined);
  assert.equal(session.model, 'global-pin');
});

test('a malformed existing config is never replaced by save', async (t) => {
  const { file, run } = setup(t);
  writeFileSync(file, '{ malformed');
  await assert.rejects(run('/config save'));
  assert.equal(readFileSync(file, 'utf8'), '{ malformed');
});

test('/report full is a flag, not a run id', async (t) => {
  const { run } = setup(t);
  await assert.rejects(run('/report full'), /no runs found/);
  await assert.rejects(run('/report --full'), /no runs found/);
});

test('/provider defines a backend from the prompt and keeps its key in the user keys file', async (t) => {
  const { session, run, output, file, resolve } = setup(t);
  const home = mkdtempSync(join(tmpdir(), 'dulger-keys-'));
  const oldXdg = process.env.XDG_CONFIG_HOME; const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.XDG_CONFIG_HOME = home; delete process.env.OPENROUTER_API_KEY;
  t.after(() => { rmSync(home, { recursive: true, force: true }); if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg; if (oldKey !== undefined) process.env.OPENROUTER_API_KEY = oldKey; });
  const { providerCommand } = await import('../src/replProviders.ts');
  const { readKey, keysFile } = await import('../src/keys.ts');

  const answers = ['', '', 'qwen/qwen3-coder'];
  const secrets = ['sk-or-test-123'];
  const asked: string[] = [];
  const prompts = { ask: async (q: string) => { asked.push(q); return answers.shift(); }, askSecret: async (q: string) => { asked.push(q); return secrets.shift(); } };
  const lines = await providerCommand(join(file, '..', '..'), session, ['openrouter'], prompts);
  assert.match(asked[0]!, /Base URL.*openrouter\.ai\/api\/v1/);
  assert.match(asked[1]!, /OPENROUTER_API_KEY/);
  assert.match(asked[3]!, /API key for \$OPENROUTER_API_KEY/);
  assert.match(lines.join('\n'), /openrouter: https:\/\/openrouter\.ai\/api\/v1 · qwen\/qwen3-coder · key in \$OPENROUTER_API_KEY[\s\S]*key stored in .*keys\.json \(mode 600\)/);
  assert.equal(readKey('OPENROUTER_API_KEY'), 'sk-or-test-123');
  assert.equal(keysFile(), join(home, 'dulger', 'keys.json'));
  assert.equal(readFileSync(keysFile(), 'utf8').includes('sk-or-test-123'), true);
  process.env.OPENROUTER_API_KEY = 'from-env';
  assert.equal(readKey('OPENROUTER_API_KEY'), 'from-env', 'the environment wins');
  delete process.env.OPENROUTER_API_KEY;

  await run('/harness openrouter');
  assert.equal(resolve('worker').harness, 'openrouter');
  assert.equal(resolve('worker').model, 'qwen/qwen3-coder');
  await run('/provider');
  assert.match(output.at(-1)!, /openrouter.*openrouter\.ai.*qwen\/qwen3-coder.*\$OPENROUTER_API_KEY \(keys file\)/);
  await run('/config save');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.providers.openrouter.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(JSON.stringify(saved).includes('sk-or-test-123'), false, 'the key never reaches the repository config');

  assert.deepEqual(await providerCommand(join(file, '..', '..'), session, ['claude'], prompts), ['claude is a CLI backend and needs no provider entry']);
  assert.deepEqual(await providerCommand(join(file, '..', '..'), session, ['x'], { ...prompts, ask: async () => undefined }), ['cancelled']);
});
