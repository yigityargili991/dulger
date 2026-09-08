import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseClaudeLine, buildClaudeArgs } from '../src/adapters/claude.ts';
import { parseCodexLine, buildCodexArgs } from '../src/adapters/codex.ts';
import { extractJson } from '../src/adapters/process.ts';
import type { AgentEvent } from '../src/types.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim().split('\n');

test('claude stream-json parses into normalised events', () => {
  const events: AgentEvent[] = fixture('claude-stream.jsonl').flatMap(parseClaudeLine);
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'init');
  assert.ok(types.includes('tool'));
  assert.ok(types.includes('tool_result'));
  const tools = events.filter((e) => e.type === 'tool').map((e) => e.name);
  assert.deepEqual(tools, ['Bash', 'StructuredOutput']);
  const result = events.at(-1);
  assert.equal(result?.type, 'result');
  if (result?.type === 'result') {
    assert.deepEqual(result.output, { ok: true, note: 'hi' });
    assert.ok(result.costUsd! > 0);
  }
});

test('codex jsonl parses into normalised events', () => {
  const events = fixture('codex-stream.jsonl').flatMap(parseCodexLine);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['init', 'text', 'tool', 'tool_result', 'text', 'turn']);
  const init = events[0];
  if (init?.type === 'init') assert.match(init.sessionId, /^[0-9a-f-]{36}$/);
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Result: {"a":[1,2]} done'), { a: [1, 2] });
  assert.equal(extractJson('no json here'), undefined);
});

test('arg builders encode access mode', () => {
  const base = { prompt: 'p', systemPrompt: 's', cwd: '/x', logFile: '/dev/null', onEvent() {}, signal: new AbortController().signal } as const;
  const ro = buildClaudeArgs({ ...base, access: 'readonly', allowedCommands: ['npm test'] });
  assert.ok(ro.includes('dontAsk'));
  assert.ok(ro.join(' ').includes('Bash(npm test)'));
  const rw = buildClaudeArgs({ ...base, access: 'write', schema: { type: 'object' } });
  assert.ok(rw.includes('bypassPermissions') && rw.includes('--json-schema'));
  const resumed = buildClaudeArgs({ ...base, access: 'write', resumeSessionId: 'abc' });
  assert.ok(resumed.includes('--resume') && !resumed.includes('--append-system-prompt'));

  const cx = buildCodexArgs({ ...base, access: 'readonly' }, { lastMessage: '/l' }, {});
  assert.deepEqual(cx.slice(-3), ['--sandbox', 'read-only', '-']);
  const cxr = buildCodexArgs({ ...base, access: 'write', resumeSessionId: 'id1' }, { lastMessage: '/l' }, {});
  assert.deepEqual(cxr.slice(0, 3), ['exec', 'resume', 'id1']);
  assert.ok(!cxr.includes('-C') && !cxr.includes('--sandbox'));
});
