import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSession, type SetupPrompts } from '../src/sessionSetup.ts';
import { sessionConfig, saveSessionConfig } from '../src/replModels.ts';
import { roleConfig } from '../src/config.ts';
import type { Session } from '../src/repl.ts';
import type { Selection, SelectOptions } from '../src/tui/select.ts';
import type { Task } from '../src/types.ts';
import { userConfigFile } from '../src/sandbox.ts';

// Saves write roles into the user's config file: keep the real one out of these tests.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-setup-home-'));

function fixture(t: TestContext, stored: object = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'dulger-setup-'));
  t.after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(userConfigFile(), { force: true }); });
  mkdirSync(join(repo, '.dulger'));
  const path = join(repo, '.dulger/config.json');
  writeFileSync(path, JSON.stringify(stored));
  const session: Session = { overrides: {}, yes: false, quiet: false, allowDirty: false };
  return { repo, path, session };
}
function prompts(steps: Array<Selection | ((o: SelectOptions) => Selection)>, answers: Array<string | undefined> = []) {
  const menus: SelectOptions[] = [];
  const messages: string[] = [];
  const io: SetupPrompts = {
    async select(o) {
      menus.push(o);
      assert.ok(steps.length, `unexpected menu: ${o.title}`);
      const step = steps.shift();
      const result = typeof step === 'function' ? step(o) : step;
      if (typeof result === 'string') assert.ok(o.choices.some((c) => c.value === result), `missing option ${result} in ${o.title}`);
      return result;
    },
    async ask() { assert.ok(answers.length, 'unexpected text prompt'); return answers.shift(); },
    async models() { return ['remote-small', 'remote-large']; },
    say(message) { messages.push(message); },
  };
  return { io, menus, messages };
}
const task: Task = { id: 't1', cardId: 'c1', title: 'task', instructions: '', status: 'pending', attempts: 1, complexity: 'low' };

test('Start preserves effective repository and CLI settings without saving', async (t) => {
  const { repo, path, session } = fixture(t, { harness: 'codex', roles: { checker: { harness: 'claude', model: 'sonnet' } } });
  session.model = 'command-line-pin';
  const before = structuredClone(session);
  const disk = readFileSync(path, 'utf8');
  const { io } = prompts([(o) => {
    assert.equal(o.selected, 'start');
    assert.match(o.choices.find((c) => c.value === 'role:worker')!.label, /codex.*command-line-pin/);
    return 'start';
  }]);
  assert.equal(await setupSession(repo, session, io), true);
  assert.deepEqual(session, before);
  assert.equal(readFileSync(path, 'utf8'), disk);
});

test('switching harness clears stale pins and automatic workers follow planner difficulty', async (t) => {
  const { repo, session } = fixture(t, { roles: { worker: { harness: 'claude', model: 'old-model', maxBudgetUsd: 8 } } });
  session.model = 'old-global';
  session.modelRoles = { checker: 'reset' };
  const { io } = prompts(['harness', 'codex', 'start']);
  assert.equal(await setupSession(repo, session, io), true);
  const config = sessionConfig(repo, session);
  assert.equal(roleConfig(config, 'worker', { task }).model, 'gpt-6-luna');
  assert.equal(roleConfig(config, 'worker', { task: { ...task, complexity: 'high' } }).model, 'gpt-6-astra');
  assert.equal(roleConfig(config, 'worker', { task: { ...task, attempts: 2 } }).model, 'gpt-6.1-sol');
  assert.equal(roleConfig(config, 'worker').maxBudgetUsd, 8);
  assert.equal(roleConfig(config, 'checker').harness, 'codex');
});

test('balanced set pins the worker across difficulty and retries; role pins can override it', async (t) => {
  const { repo, session } = fixture(t);
  const { io } = prompts(['set', 'balanced', 'role:checker', 'codex', 'pin', 'model:gpt-6-astra', 'start']);
  await setupSession(repo, session, io);
  const config = sessionConfig(repo, session);
  assert.equal(roleConfig(config, 'worker', { task }).model, 'sonnet');
  assert.equal(roleConfig(config, 'worker', { task: { ...task, complexity: 'high', attempts: 3 } }).model, 'sonnet');
  assert.equal(roleConfig(config, 'checker').model, 'gpt-6-astra');
  assert.equal(roleConfig(config, 'docs').model, 'haiku');
});

test('a custom model for every role overrides old role and global pins, and saves only explicitly', async (t) => {
  const { repo, path, session } = fixture(t, { roles: { worker: { model: 'old' } }, unrelated: 'keep' });
  session.model = 'global';
  const disk = readFileSync(path, 'utf8');
  const { io, messages } = prompts(['model', 'custom', 'start'], ['with spaces', 'custom-v2']);
  await setupSession(repo, session, io);
  const config = sessionConfig(repo, session);
  assert.equal(roleConfig(config, 'worker', { task }).model, 'custom-v2');
  assert.equal(roleConfig(config, 'planner').model, 'custom-v2');
  assert.equal(messages.length, 1);
  assert.equal(readFileSync(path, 'utf8'), disk);
  saveSessionConfig(repo, session);
  assert.equal(readFileSync(path, 'utf8'), disk, 'roles go to the user file only');
  assert.equal(JSON.parse(readFileSync(userConfigFile(), 'utf8')).roles.worker.model, 'custom-v2');
});

test('cancel rolls back the whole draft, including after changing a harness', async (t) => {
  const { repo, session } = fixture(t);
  const original = structuredClone(session);
  const { io } = prompts(['harness', 'codex', 'role:worker', null]);
  assert.equal(await setupSession(repo, session, io), false);
  assert.deepEqual(session, original);
});

test('back out of a nested menu retains the draft; restore returns to opening settings', async (t) => {
  const { repo, session } = fixture(t);
  const original = structuredClone(session);
  const { io } = prompts(['harness', 'codex', 'role:worker', undefined, 'restore', 'start']);
  assert.equal(await setupSession(repo, session, io), true);
  assert.deepEqual(session, original);
});

test('an API provider without a model blocks Start and recovers with the endpoint model list', async (t) => {
  const { repo, session } = fixture(t, { harness: 'ollama' });
  const { io } = prompts(['start', (o) => { assert.match(o.description!, /needs a model/); return 'model'; }, 'model:remote-small', 'start']);
  await setupSession(repo, session, io);
  assert.equal(roleConfig(sessionConfig(repo, session), 'worker').model, 'remote-small');
});

test('offline provider model discovery falls back to a custom ID and preserves role changes', async (t) => {
  const { repo, session } = fixture(t, { harness: 'ollama' });
  const { io } = prompts(['model', (o) => { assert.match(o.description!, /Could not load models/); return 'custom'; }, 'start'], ['local:model']);
  io.models = async () => { throw new Error('endpoint offline'); };
  await setupSession(repo, session, io);
  assert.equal(roleConfig(sessionConfig(repo, session), 'planner').model, 'local:model');
});

test('role auto removes a global pin while preserving the other roles', async (t) => {
  const { repo, session } = fixture(t);
  session.model = 'global-pin';
  const { io } = prompts(['role:worker', 'claude', 'auto', 'start']);
  await setupSession(repo, session, io);
  const config = sessionConfig(repo, session);
  assert.equal(roleConfig(config, 'worker', { task }).model, 'haiku');
  assert.equal(roleConfig(config, 'planner').model, 'global-pin');
});
