import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, roleConfig } from '../src/config.ts';
import { cardsFromPlan } from '../src/board/store.ts';
import type { Task } from '../src/types.ts';

const task = (extra: Partial<Task> = {}): Task => ({ id: 't1', cardId: 'c1', title: 'task', instructions: '', status: 'running', attempts: 1, ...extra });

test('routing uses requested tiers, escalates retries, and preserves explicit overrides', () => {
  for (const [harness, low, medium, high] of [
    ['claude', 'haiku', 'sonnet', 'claude-fable-5-1'], ['codex', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'],
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
  assert.equal(roleConfig({ ...DEFAULT_CONFIG, roles: { worker: { harness: 'codex' } } }, 'worker').model, 'gpt-5.6-sol');
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

test('planned task difficulty survives board creation and affects review', () => {
  const card = cardsFromPlan({ cards: [{ id: 'c1', title: '', description: '', acceptanceCriteria: [], dependsOn: [], tasks: [{ id: 't1', title: '', instructions: '', complexity: 'high' }] }] })[0]!;
  assert.equal(card.tasks[0]?.complexity, 'high');
  assert.equal(roleConfig(DEFAULT_CONFIG, 'checker', { card }).model, 'claude-fable-5-1');
});
