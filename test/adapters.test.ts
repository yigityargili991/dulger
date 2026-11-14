import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeParser, buildClaudeArgs, claudeAdapter, claudeProjectDir, claudeProjectSlug } from '../src/adapters/claude.ts';
import { createCodexParser, buildCodexArgs } from '../src/adapters/codex.ts';
import { extractJson, spawnLines, STOP_GRACE_MS } from '../src/adapters/process.ts';
import type { AdapterRunOptions } from '../src/adapters/types.ts';
import { sandboxNote } from '../src/roles/prompts.ts';
import type { Sandbox, SandboxExtra, SandboxKind } from '../src/sandbox.ts';
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
  parse('{"type":"assistant","message":{"id":"m9","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"cargo build"}}]}}');
  const denied = parse('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":true,"content":"Permission to use Bash has been denied because Claude Code is running in don\'t ask mode."}]}}');
  assert.deepEqual(denied, [{ type: 'denied', command: 'cargo build' }, { type: 'tool_result' }], 'a refused command is reported by name');
  const failedNotDenied = parse('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":true,"content":"error: could not compile"}]}}');
  assert.deepEqual(failedNotDenied.map((e) => e.type), ['tool_result'], 'a command that ran and failed is not a denial');
  assert.deepEqual(parse('{"type":"user","message":{"content":"the echoed prompt"}}'), []);
  assert.deepEqual(parse('{"type":"rate_limit_event"}'), [], 'no windows, no event');
  assert.deepEqual(parse('{"type":"system","subtype":"thinking_tokens","estimated_tokens":3000,"estimated_tokens_delta":100}'), [{ type: 'thinking' }], 'thinking is progress: it must feed the stall watchdog');
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
  assert.ok(!ro.includes('p') && ro.includes('-p'), 'the prompt goes on stdin, not on the command line (argv strings are capped at 128 KiB)');
  assert.ok(ro.includes('--strict-mcp-config'), 'read-only agents never get MCP servers');
  assert.ok(buildClaudeArgs({ ...base, access: 'readonly', mcp: true }).includes('--strict-mcp-config'), 'not even when MCP is on');
  assert.ok(!buildClaudeArgs({ ...base, access: 'write', mcp: true }).includes('--strict-mcp-config'), 'write agents get them when MCP is on');
  assert.ok(buildClaudeArgs({ ...base, access: 'write', mcp: false }).includes('--strict-mcp-config'), 'and not when it is off');
  assert.ok(ro.join(' ').includes('Bash(npm test)'));
  assert.ok(ro.join(' ').includes('Bash(cargo --version)'), 'version probes are allowed');
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

test('configured reviewer commands are prefixes; the card\'s verify commands are allowed only exactly as written', () => {
  const base = { prompt: 'p', systemPrompt: 's', cwd: '/x', logFile: '/dev/null', onEvent() {}, signal: new AbortController().signal, access: 'readonly' } as const;
  const args = buildClaudeArgs({ ...base, allowedCommands: ['npm test'], exactCommands: ['node scripts/check.js', 'pytest tests/*.py'] });
  const rules = args[args.indexOf('--allowedTools') + 1]!.split(',');
  assert.ok(rules.includes('Bash(npm test)') && rules.includes('Bash(npm test *)'), 'a configured command keeps its arguments');
  assert.ok(rules.includes('Bash(node scripts/check.js)'));
  assert.ok(!rules.some((r) => r.startsWith('Bash(node scripts/check.js ')), 'a verify command gets no wildcard variant');
  assert.ok(!rules.some((r) => r.includes('pytest')), 'a verify command with a `*` would be a wildcard rule, so it is left out');
});

test('a sandboxed Claude call switches Claude Code\'s own sandbox off and tells the agent; an unsandboxed one is as it was', () => {
  const base = { prompt: 'p', systemPrompt: '[role:worker] s', cwd: '/x', logFile: '/dev/null', onEvent() {}, signal: new AbortController().signal, access: 'write', model: 'haiku', mcp: true } as const;
  assert.deepEqual(buildClaudeArgs(base), ['-p', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', '[role:worker] s', '--model', 'haiku', '--permission-mode', 'bypassPermissions']);
  const wrapped = buildClaudeArgs(base, { writable: true });
  assert.deepEqual(wrapped, ['-p', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', `[role:worker] s\n\n${sandboxNote(true)}`, '--model', 'haiku', '--settings', '{"sandbox":{"enabled":false}}', '--permission-mode', 'bypassPermissions']);
  assert.match(sandboxNote(true), /only this worktree and \$TMPDIR are writable[\s\S]*\.bashrc, \.gitconfig, \.mcp\.json and \.vscode[\s\S]*do not report them as changes/);
  const planner = buildClaudeArgs({ ...base, systemPrompt: '[role:planner] s', access: 'readonly' }, { writable: false });
  assert.equal(planner[planner.indexOf('--append-system-prompt') + 1], `[role:planner] s\n\n${sandboxNote(false)}`, 'in the checkout nothing but $TMPDIR is writable, and it is told so');
  assert.doesNotMatch(sandboxNote(false), /worktree/);
  const resumed = buildClaudeArgs({ ...base, resumeSessionId: 'abc' }, { writable: true });
  assert.ok(!resumed.includes('--append-system-prompt') && resumed.includes('{"sandbox":{"enabled":false}}'), 'a resumed session keeps its first system prompt; the inner sandbox stays off');
  for (const access of ['write', 'readonly', 'none'] as const) {
    assert.ok(!buildClaudeArgs({ ...base, access }).join('\n').includes('sandbox'), `${access}: no sandbox note or setting when not sandboxed`);
  }
});

test('the transcript directory is named the way Claude Code 2.1 names it', (t) => {
  assert.equal(claudeProjectSlug('/home/u/.local/share/dulger/gitlab.com-me-app/worktrees/20261114-2007-506c/c1'), '-home-u--local-share-dulger-gitlab-com-me-app-worktrees-20261114-2007-506c-c1');
  // Both checked against Claude Code 2.1.325, which made exactly these directories for these working directories.
  assert.equal(claudeProjectSlug(`/mnt/dulger-slug-probe/${'a'.repeat(120)}/Wörk tree.v2/c1`), `-mnt-dulger-slug-probe-${'a'.repeat(120)}-W-rk-tree-v2-c1`);
  const long = claudeProjectSlug(`/mnt/dulger-slug-probe/${'a'.repeat(200)}/Wörk tree.v2/c1`);
  assert.equal(long, `-mnt-dulger-slug-probe-${'a'.repeat(177)}-f0ijge`, 'over 200 characters: cut, then a hash of the whole path');
  const root = mkdtempSync(join(tmpdir(), 'dulger-slug-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'link'));
  const env = { CLAUDE_CONFIG_DIR: join(root, 'config') };
  assert.equal(claudeProjectDir(join(root, 'link'), env), join(root, 'config', 'projects', claudeProjectSlug(join(root, 'real'))), 'symlinks resolved, as Claude Code sees its cwd');
  assert.equal(claudeProjectDir('/no/such/dir', {}).split('/').slice(-3).join('/'), '.claude/projects/-no-such-dir');
});

/** A sandbox that runs what it is given without srt, so the adapter's sandboxed path runs anywhere. */
function stubSandbox(writable: boolean): Sandbox & { calls: Array<{ kind: SandboxKind; cwd: string; command: string[]; extra?: SandboxExtra; existed: boolean[] }> } {
  const calls: Array<{ kind: SandboxKind; cwd: string; command: string[]; extra?: SandboxExtra; existed: boolean[] }> = [];
  return {
    calls,
    status: { mode: 'required', active: true, available: true },
    // srt exits 0 after passing a SIGTERM on, and so does this shell.
    wrap(kind, cwd, command, env, extra) {
      calls.push({ kind, cwd, command: command as string[], extra, existed: [...(extra?.allowWrite ?? []), ...(extra?.denyWrite ?? [])].map((p) => existsSync(p)) });
      // Not the last command, so the shell cannot exec it and lose the trap.
      return { bin: '/bin/sh', args: ['-c', 'trap "exit 0" TERM; "$@"; exit $?', 'sh', ...(command as string[])], env };
    },
    writable: () => writable,
    scrub: () => [],
    dispose() {},
  };
}

function fakeClaude(t: TestContext): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dulger-fake-claude-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname}" "$@"\n`);
  chmodSync(bin, 0o755);
  const saved = { bin: process.env.DULGER_CLAUDE_BIN, config: process.env.CLAUDE_CONFIG_DIR };
  process.env.DULGER_CLAUDE_BIN = bin;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config');
  t.after(() => {
    for (const [key, value] of [['DULGER_CLAUDE_BIN', saved.bin], ['CLAUDE_CONFIG_DIR', saved.config]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config: join(dir, 'config') };
}

test('the Claude adapter spawns through the sandbox when it is active, with its transcript directory made writable first', async (t) => {
  const { dir } = fakeClaude(t);
  const cwd = mkdtempSync(join(dir, 'wt-'));
  const opts: AdapterRunOptions = { prompt: '{}', systemPrompt: '[role:worker] s', cwd, logFile: join(dir, 'log.jsonl'), onEvent() {}, signal: new AbortController().signal, access: 'write', schema: { type: 'object' } };
  const sandbox = stubSandbox(true);
  const r = await claudeAdapter.run({ ...opts, sandbox });
  assert.equal(r.ok, true, r.error);
  const transcripts = claudeProjectDir(cwd);
  assert.deepEqual(sandbox.calls.map((c) => [c.kind, c.cwd, c.command[0], c.extra]), [['agent', cwd, process.env.DULGER_CLAUDE_BIN, { allowWrite: [transcripts], denyWrite: [] }]]);
  assert.deepEqual(sandbox.calls[0]!.existed, [true], 'created before srt starts: a grant on a missing path grants nothing');
  assert.deepEqual(sandbox.calls[0]!.command.slice(1), buildClaudeArgs(opts, { writable: true }));
  const report = r.output as { argv: string[]; stdin: string };
  assert.deepEqual(report.argv, buildClaudeArgs(opts, { writable: true }), 'what the sandbox was handed is what ran');
  assert.equal(report.stdin, '{}');
  assert.deepEqual(readdirSync(transcripts).filter((f) => f.endsWith('.jsonl')), [`${r.sessionId}.jsonl`], 'the session was saved where it was looked for');

  const checkout = mkdtempSync(join(dir, 'checkout-'));
  const planner = stubSandbox(false);
  const p = await claudeAdapter.run({ ...opts, cwd: checkout, systemPrompt: '[role:planner] s', access: 'readonly', sandbox: planner });
  assert.equal(p.ok, true, p.error);
  const own = claudeProjectDir(checkout);
  assert.deepEqual(planner.calls[0]!.extra, { allowWrite: [own], denyWrite: [join(own, 'memory')] }, 'outside a worktree the auto-memory stays read-only');
  assert.deepEqual(planner.calls[0]!.existed, [true, true], 'memory/ exists before srt starts, or srt would create it');

  const reporter = stubSandbox(true);
  assert.equal((await claudeAdapter.run({ ...opts, access: 'none', sandbox: reporter })).ok, true);
  assert.deepEqual(reporter.calls, [], 'the tool-free reporter is not wrapped');
  const off = { ...stubSandbox(true), status: { mode: 'off' as const, active: false } };
  const plain = await claudeAdapter.run({ ...opts, sandbox: off });
  assert.deepEqual([off.calls, (plain.output as { argv: string[] }).argv], [[], buildClaudeArgs(opts)], 'inactive: spawned as it always was');
});

test('a sandboxed Claude call that was stopped is not a success although srt exits 0, and an unsaved session is not offered for resuming', async (t) => {
  const { dir } = fakeClaude(t);
  const cwd = mkdtempSync(join(dir, 'wt-'));
  const opts: AdapterRunOptions = { prompt: JSON.stringify({ sleepMs: 30_000 }), systemPrompt: '[role:worker] s', cwd, logFile: join(dir, 'log.jsonl'), onEvent() {}, signal: new AbortController().signal, access: 'write', sandbox: stubSandbox(true) };
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 300);
  const stopped = await claudeAdapter.run({ ...opts, signal: ctrl.signal });
  assert.deepEqual([stopped.ok, stopped.exitCode, stopped.error], [false, 0, 'aborted'], 'exit 0: it went on the SIGTERM, not a SIGKILL');

  const unsaved = await claudeAdapter.run({ ...opts, prompt: JSON.stringify({ transcript: false }) });
  assert.equal(unsaved.ok, true, unsaved.error);
  assert.equal(unsaved.sessionId, undefined, 'a follow-up starts a new session instead of failing on --resume');
  assert.match(unsaved.warnings?.join('\n') ?? '', /^session [0-9a-f-]{36} was not saved in .*\/projects\/.*, so it cannot be resumed$/);
  const plain = await claudeAdapter.run({ ...opts, prompt: JSON.stringify({ transcript: false }), sandbox: undefined });
  assert.ok(plain.sessionId && !plain.warnings, 'unsandboxed, the session is taken as reported');
});

test('a sandboxed harness gets a process group of its own, SIGTERM first and SIGKILL after the grace period, and nothing of it outlives it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dulger-spawn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = `dulger-spawn-${process.pid}-${Date.now()}`;
  const run = (script: string, o: { sandboxed?: boolean; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}) => {
    const lines: string[] = [];
    return spawnLines({ bin: '/bin/sh', args: ['-c', script, marker], cwd: dir, logFile: join(dir, 'log'), signal: o.signal ?? new AbortController().signal, onLine: (l) => lines.push(l), sandboxed: o.sandboxed, env: o.env }).then((r) => ({ ...r, lines }));
  };
  const ownGroup = (await run('ps -o pgid= -p $$')).lines[0]!.trim();
  assert.equal(ownGroup, (await run('ps -o pgid= -p $PPID')).lines[0]!.trim(), 'unsandboxed: the harness stays in dulger\'s group, as before');
  const own = await run('echo $$; ps -o pgid= -p $$', { sandboxed: true });
  assert.equal(own.lines[1]!.trim(), own.lines[0], 'sandboxed: a group of its own');
  assert.deepEqual((await run('echo "$DULGER_SPAWN_TEST"', { env: { DULGER_SPAWN_TEST: 'given' } })).lines, ['given']);

  // A child that left something running in the background (srt's bridges, say) does not leave it behind.
  await run(`sleep 67 >/dev/null 2>&1 & echo started`, { sandboxed: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(spawnSync('pgrep', ['-f', `^sleep 67$`]).stdout.toString().trim(), '', 'the group went with it');

  const ctrl = new AbortController();
  const started = Date.now();
  setTimeout(() => ctrl.abort(), 200);
  const stubborn = await run('trap "" TERM; sleep 68; echo late', { sandboxed: true, signal: ctrl.signal });
  const took = Date.now() - started;
  assert.ok(took >= STOP_GRACE_MS && took < STOP_GRACE_MS + 3000, `a child that ignores SIGTERM is killed after the grace period (${took}ms)`);
  assert.deepEqual(stubborn.lines, []);
});

test('tool-free CLI requests disable Claude tools and reject unsupported Codex calls', () => {
  const opts = { prompt: 'digest', systemPrompt: '[role:reporter]', cwd: '/x', logFile: '/dev/null', onEvent() {}, signal: new AbortController().signal, access: 'none', mcp: true, allowedCommands: ['npm test'] } as const;
  const claude = buildClaudeArgs({ ...opts, allowedCommands: [...opts.allowedCommands] });
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(claude.includes('--strict-mcp-config'));
  assert.ok(claude.includes('--disable-slash-commands'));
  assert.ok(claude.includes('{"disableAllHooks":true}'));
  assert.ok(!claude.includes('--allowedTools'));
  assert.throws(() => buildCodexArgs({ ...opts, allowedCommands: [] }, { lastMessage: '/l' }, { bypassSandbox: true }), /does not support tool-free reporting/);
});
