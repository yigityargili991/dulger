import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markFailed, runAgent, type AgentRegistry } from '../src/runner/agentProcess.ts';
import type { Adapter, AdapterResult } from '../src/adapters/types.ts';
import type { AgentStatus } from '../src/types.ts';

function registry(): AgentRegistry {
  return { statuses: new Map(), onChange: () => {} };
}

function adapter(result: Partial<AdapterResult>): Adapter {
  return { name: 'stub', async run(o) { o.onEvent({ type: 'turn' }); return { ok: true, text: '', exitCode: 0, ...result }; } };
}

async function run(reg: AgentRegistry, a: Adapter, ids: { cardId?: string; taskId?: string }): Promise<AgentStatus> {
  await runAgent({
    registry: reg, adapter: a, role: 'worker', harness: 'fake', ...ids, logDir: mkdtempSync(join(tmpdir(), 'dulger-agent-')), logName: 'x',
    stallTimeoutSec: 10, parentSignal: new AbortController().signal,
    run: { prompt: '', systemPrompt: '', cwd: '.', access: 'write' },
  });
  return [...reg.statuses.values()].at(-1)!;
}

test('agent status reflects the adapter result', async () => {
  const reg = registry();
  assert.equal((await run(reg, adapter({ ok: true }), { cardId: 'c1', taskId: 't1' })).state, 'done');
  assert.equal((await run(reg, adapter({ ok: false, error: 'boom' }), { cardId: 'c1', taskId: 't1' })).state, 'failed');
  const throwing: Adapter = { name: 'stub', async run() { throw new Error('spawn failed'); } };
  assert.equal((await run(reg, throwing, { cardId: 'c1' })).state, 'failed');
});

test('markFailed only touches the given card', async () => {
  const reg = registry();
  const ok = adapter({ ok: true });
  await run(reg, ok, { cardId: 'c1', taskId: 't1' });
  await run(reg, ok, { cardId: 'c2', taskId: 't1' });
  await run(reg, ok, { cardId: 'c2' });
  markFailed(reg, 'c2');
  assert.deepEqual([...reg.statuses.values()].map((s) => `${s.cardId}/${s.taskId ?? '-'}:${s.state}`), ['c1/t1:done', 'c2/t1:failed', 'c2/-:failed']);
});
