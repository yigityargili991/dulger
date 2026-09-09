import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClaudeParser, buildClaudeArgs } from '../src/adapters/claude.ts';
import { createCodexParser, buildCodexArgs } from '../src/adapters/codex.ts';
import { extractJson } from '../src/adapters/process.ts';
import type { AgentEvent } from '../src/types.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim().split('\n');

test('claude stream-json parses into normalised events', () => {
  const events: AgentEvent[] = fixture('claude-stream.jsonl').flatMap(createClaudeParser());
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'init');
  assert.ok(types.includes('tool'));
  assert.equal(types.filter((t) => t === 'turn').length, 2, 'one turn per message id, not per content block line');
  assert.equal(types.filter((t) => t === 'tool_result').length, 2);
  assert.ok(!types.includes('warning'));
  const tools = events.filter((e) => e.type === 'tool').map((e) => e.name);
  assert.deepEqual(tools, ['Bash', 'StructuredOutput']);
  const result = events.at(-1);
  assert.equal(result?.type, 'result');
  if (result?.type === 'result') {
    assert.deepEqual(result.output, { ok: true, note: 'hi' });
    assert.ok(result.costUsd! > 0);
    assert.deepEqual(result.usage, { input: 66, cacheRead: 43700, cacheWrite: 22370, output: 828 });
    assert.equal(result.isError, false);
  }
});

test('claude parser reports format drift and errors instead of hiding them', () => {
  const parse = createClaudeParser();
  const noSession = parse('{"type":"system","subtype":"init"}');
  assert.equal(noSession[0]?.type, 'warning');
  const noSpend = parse('{"type":"result","subtype":"success","result":"ok"}');
  assert.deepEqual(noSpend.map((e) => e.type), ['warning', 'result']);
  const failed = parse('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Reached max turns","total_cost_usd":0.5}').at(-1);
  assert.equal(failed?.type, 'result');
  if (failed?.type === 'result') { assert.equal(failed.isError, true); assert.equal(failed.error, 'Reached max turns'); }
  const parallel = parse('{"type":"user","message":{"content":[{"type":"tool_result"},{"type":"tool_result"}]}}');
  assert.equal(parallel.length, 2, 'one tool_result per block');
  assert.deepEqual(parse('{"type":"user","message":{"content":"the echoed prompt"}}'), []);
  assert.deepEqual(parse('{"type":"rate_limit_event"}'), [], 'no windows, no event');
  const rl = parse('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.35,"resetsAt":1789002000},"seven_day":{"utilization":0.23}}}}')[0];
  assert.equal(rl?.type, 'rate_limit');
  if (rl?.type === 'rate_limit') {
    assert.equal(rl.limits.status, 'allowed');
    assert.deepEqual(rl.limits.windows, [{ name: 'five_hour', utilization: 0.35, resetsAt: '2026-09-10T01:00:00.000Z' }, { name: 'seven_day', utilization: 0.23, resetsAt: undefined }]);
  }
});

test('codex jsonl parses into normalised events', () => {
  const parser = createCodexParser();
  const events = fixture('codex-stream.jsonl').flatMap((l) => parser.parse(l));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['init', 'text', 'turn', 'tool', 'tool_result', 'turn', 'text', 'turn'], 'a turn per completed item');
  const init = events[0];
  if (init?.type === 'init') assert.match(init.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(parser.usage, { input: 33771 - 16640, cacheRead: 16640, cacheWrite: 0, output: 61 }, 'cached tokens are carved out of the prompt total');
  assert.equal(parser.error, undefined);
});

test('codex parser reports format drift, advisory errors and failed turns', () => {
  const p = createCodexParser();
  assert.equal(p.parse('{"type":"thread.started"}')[0]?.type, 'warning');
  assert.equal(p.parse('{"type":"turn.completed"}')[0]?.type, 'warning');
  const advisory = p.parse('{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened"}}');
  assert.equal(advisory[0]?.type, 'warning');
  assert.equal(p.error, undefined, 'an error item is advisory');
  assert.deepEqual(p.parse('{"type":"item.completed","item":{"id":"i","type":"reasoning","text":"…"}}'), [], 'unknown items are ignored');
  p.parse('{"type":"turn.failed","error":{"message":"stream disconnected"}}');
  assert.equal(p.error, 'stream disconnected');
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
  assert.ok(ro.includes('--strict-mcp-config'), 'read-only agents never get MCP servers');
  assert.ok(buildClaudeArgs({ ...base, access: 'readonly', mcp: true }).includes('--strict-mcp-config'), 'not even when MCP is on');
  assert.ok(!buildClaudeArgs({ ...base, access: 'write', mcp: true }).includes('--strict-mcp-config'), 'write agents get them when MCP is on');
  assert.ok(buildClaudeArgs({ ...base, access: 'write', mcp: false }).includes('--strict-mcp-config'), 'and not when it is off');
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
