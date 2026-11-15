import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAIAdapter, retryDelayMs } from '../src/adapters/openai.ts';
import { apiTools, executeApiTool } from '../src/adapters/apiTools.ts';
import { childEnv } from '../src/childEnv.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { getAdapter } from '../src/adapters/index.ts';
import type { AdapterRunOptions } from '../src/adapters/types.ts';

function setup(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), 'dulger-api-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const opts: AdapterRunOptions = { cwd, prompt: 'do work', systemPrompt: 'test', access: 'write', model: 'test-model', logFile: join(cwd, 'log.jsonl'), signal: new AbortController().signal, onEvent: () => {}, schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'], additionalProperties: false } };
  const config = { ...DEFAULT_CONFIG.providers.ollama!, maxTurns: 4 };
  return { cwd, opts, config };
}
/** Set environment variables for one test and put the old values back after it. */
function withEnv(t: { after(fn: () => void): void }, vars: Record<string, string>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, vars);
}
const final = (content = '{"done":true}') => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 } } });
const call = (name: string, args: object) => ({ choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'reasoning kept for DeepSeek', tool_calls: [{ id: 'tool-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 20 } });

test('API agent executes tools, preserves reasoning, reports tokens and resumes a saved transcript', async (t) => {
  const { cwd, opts, config } = setup(t);
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, '/v1/chat/completions');
    const body = JSON.parse(init.body as string); requests.push(body);
    return Response.json(requests.length === 1 ? call('write_file', { path: 'out.txt', content: 'hello' }) : final());
  });
  const adapter = createOpenAIAdapter('ollama', config);
  const result = await adapter.run(opts);
  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(cwd, 'out.txt'), 'utf8'), 'hello');
  assert.deepEqual(result.usage, { input: 120, cacheRead: 30, cacheWrite: 0, output: 30 });
  assert.equal(requests[1].messages[2].reasoning_content, 'reasoning kept for DeepSeek');
  assert.equal(requests[1].messages[3].role, 'tool');
  const resumed = await createOpenAIAdapter('ollama', config).run({ ...opts, prompt: 'revise', resumeSessionId: result.sessionId });
  assert.equal(resumed.ok, true);
  assert.equal(requests[2].messages.at(-1).content, 'revise');
  assert.equal(requests[2].messages[1].content, 'do work');
});

test('read-only tool denial is enforced, reported and recoverable', async (t) => {
  const { cwd, opts, config } = setup(t);
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++n === 1 ? call('write_file', { path: 'bad.txt', content: 'bad' }) : final()));
  const result = await createOpenAIAdapter('ollama', config).run({ ...opts, access: 'readonly' });
  assert.equal(result.ok, true);
  assert.equal(result.denied?.length, 1);
  assert.equal(existsSync(join(cwd, 'bad.txt')), false);
  await assert.rejects(executeApiTool('run_command', { command: 'echo allowed; echo injected' }, { ...opts, access: 'readonly', allowedCommands: ['echo allowed'] }), /not approved/);
  assert.match(await executeApiTool('run_command', { command: 'echo allowed' }, { ...opts, access: 'readonly', allowedCommands: ['echo allowed'] }), /exit 0\nallowed/);
});

test('run_command does not see agent credentials; a reviewer runs its exact commands and nothing longer', async (t) => {
  const { opts } = setup(t);
  withEnv(t, { OPENAI_API_KEY: 'a', DULGER_TEST_PROVIDER_KEY: 'p', NPM_TOKEN: 'npm' });
  const probe = 'echo "[$OPENAI_API_KEY][$DULGER_TEST_PROVIDER_KEY][$NPM_TOKEN]"';
  const commandEnv = childEnv({ providers: { custom: { ...DEFAULT_CONFIG.providers.openai!, apiKeyEnv: 'DULGER_TEST_PROVIDER_KEY' } } });
  assert.equal(await executeApiTool('run_command', { command: probe }, { ...opts, commandEnv }), 'exit 0\n[][][npm]\n');
  assert.equal(await executeApiTool('run_command', { command: probe }, opts), 'exit 0\n[][p][npm]\n', 'without one, the fixed names are still dropped');
  const reviewer = { ...opts, access: 'readonly' as const, exactCommands: [probe], commandEnv };
  const runCommand = apiTools(reviewer).find((x) => x.function.name === 'run_command');
  assert.ok(runCommand?.function.description.includes(JSON.stringify(probe)), 'the tool lists the exact commands');
  assert.equal(await executeApiTool('run_command', { command: probe }, reviewer), 'exit 0\n[][][npm]\n');
  await assert.rejects(executeApiTool('run_command', { command: `${probe} extra` }, reviewer), /not approved/);
});

test('file tools reject traversal, symlinks and git metadata', async (t) => {
  const { cwd, opts } = setup(t);
  symlinkSync(tmpdir(), join(cwd, 'link'));
  for (const path of ['../escape', 'link/escape', '.git/config', '.dulger/config.json']) {
    await assert.rejects(executeApiTool('write_file', { path, content: 'no' }, opts), /outside|protected|symlink/);
  }
  writeFileSync(join(cwd, 'ok.txt'), 'one\ntwo');
  assert.equal(await executeApiTool('read_file', { path: 'ok.txt', line: 2 }, opts), '2: two');
});

test('malformed output repairs are bounded and partial usage is retained', async (t) => {
  const { opts, config } = setup(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(final('{"done":"yes"}')); });
  const result = await createOpenAIAdapter('ollama', { ...config, maxTurns: 2 }).run(opts);
  assert.equal(result.ok, false);
  assert.match(result.error!, /maxTurns/);
  assert.equal(calls, 2);
  assert.equal(result.usage?.output, 20);
});

test('credentials use headers only; HTTP rate limits and missing credentials fail clearly', async (t) => {
  const { cwd, opts, config } = setup(t);
  const old = process.env.DULGER_TEST_API_KEY;
  process.env.DULGER_TEST_API_KEY = 'test-secret';
  t.after(() => { if (old === undefined) delete process.env.DULGER_TEST_API_KEY; else process.env.DULGER_TEST_API_KEY = old; });
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-secret');
    assert.equal((init.body as string).includes('test-secret'), false);
    return new Response('test-secret', { status: 429 });
  });
  const adapter = createOpenAIAdapter('deepseek', { ...config, apiKeyEnv: 'DULGER_TEST_API_KEY', retries: 0 });
  const result = await adapter.run(opts);
  assert.match(result.error!, /429 rate limit/);
  assert.equal(readFileSync(join(cwd, 'log.jsonl'), 'utf8').includes('test-secret'), false);
  delete process.env.DULGER_TEST_API_KEY;
  assert.match((await adapter.run(opts)).error!, /Set DULGER_TEST_API_KEY/);
});

test('aborted calls never fetch and cached adapters respect each configuration', async (t) => {
  const { opts, config } = setup(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch'); });
  const result = await createOpenAIAdapter('ollama', config).run({ ...opts, signal: AbortSignal.abort() });
  assert.equal(result.error, 'aborted');
  const a = { ...DEFAULT_CONFIG };
  const b = { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers, ollama: { ...config, baseUrl: 'http://other/v1' } } };
  assert.equal(getAdapter('ollama', a), getAdapter('ollama', a));
  assert.notEqual(getAdapter('ollama', a), getAdapter('ollama', b));
});

test('API backend plans, routes tasks, edits a worktree, reviews and lands a complete card', async (t) => {
  const { cwd, config: provider } = setup(t);
  const git = await import('../src/git/worktree.ts');
  const { createBoard } = await import('../src/board/create.ts');
  const { createOrchestrator } = await import('../src/runner/orchestrator.ts');
  const dataDir = process.env.DULGER_DATA_DIR;
  process.env.DULGER_DATA_DIR = join(cwd, 'data');
  t.after(() => { if (dataDir === undefined) delete process.env.DULGER_DATA_DIR; else process.env.DULGER_DATA_DIR = dataDir; });
  git.git(cwd, ['init', '-q', '-b', 'main']);
  git.git(cwd, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
  const models: Array<[string, string]> = [];
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const role = body.messages[0].content.match(/\[role:(\w+)\]/)[1];
    models.push([role, body.model]);
    if (role === 'planner') return Response.json(final(JSON.stringify({ assumptions: [], omitted: [], cards: [{
      id: 'c1', title: 'Greeting', description: 'Add a greeting', acceptanceCriteria: ['greeting exists'], dependsOn: [], verify: [],
      tasks: [{ id: 't1', title: 'Write greeting', instructions: 'Write hello.txt', complexity: 'low' }],
    }] })));
    if (role === 'worker') {
      if (!body.messages.some((m: { role: string }) => m.role === 'tool')) return Response.json(call('write_file', { path: 'hello.txt', content: 'hello\n' }));
      return Response.json(final(JSON.stringify({ summary: 'Added greeting', filesChanged: ['hello.txt'], done: true, remaining: [], learnings: [] })));
    }
    return Response.json(final(JSON.stringify({ pass: true, feedback: [], notes: [], summary: 'Greeting is correct' })));
  });
  const config = { ...DEFAULT_CONFIG, harness: 'ollama' as const, docs: false, providers: { ollama: provider }, routing: { ...DEFAULT_CONFIG.routing, models: { ollama: { low: 'small', medium: 'medium', high: 'strong' } } } };
  const board = createBoard(cwd, 'Add greeting', 'api-run');
  const orch = createOrchestrator(cwd, board, config);
  await orch.plan();
  await orch.execute();
  assert.equal(board.cards[0]?.status, 'done');
  assert.equal(git.git(cwd, ['show', 'dulger/api-run:hello.txt']), 'hello');
  assert.deepEqual(models, [['planner', 'strong'], ['worker', 'small'], ['worker', 'small'], ['checker', 'strong']]);
  assert.equal([...orch.registry.statuses.values()].find((s) => s.role === 'worker')?.model, 'small');
});

test('in a run, worktree setup, verify commands and the API tools\' shell never see the agent credentials', async (t) => {
  const { cwd, config: provider } = setup(t);
  const git = await import('../src/git/worktree.ts');
  const { createBoard } = await import('../src/board/create.ts');
  const { createOrchestrator } = await import('../src/runner/orchestrator.ts');
  withEnv(t, { ANTHROPIC_API_KEY: 'leak-a', DULGER_TEST_PROVIDER_KEY: 'leak-p', NPM_TOKEN: 'npm-ok', DULGER_DATA_DIR: join(cwd, 'data') });
  git.git(cwd, ['init', '-q', '-b', 'main']);
  git.git(cwd, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
  const probe = 'echo "[$ANTHROPIC_API_KEY][$DULGER_TEST_PROVIDER_KEY][$NPM_TOKEN]"';
  const clean = '[][][npm-ok]';
  const setupLog = join(mkdtempSync(join(tmpdir(), 'dulger-api-setup-')), 'setup.log');
  let reviewerTool = '';
  let reviewerSaw = '';
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const role = body.messages[0].content.match(/\[role:(\w+)\]/)[1];
    const result = body.messages.find((m: { role: string }) => m.role === 'tool');
    if (role === 'planner') return Response.json(final(JSON.stringify({ assumptions: [], omitted: [], cards: [{
      id: 'c1', title: 'Probe', description: '', acceptanceCriteria: [], dependsOn: [], verify: [probe],
      tasks: [{ id: 't1', title: 'Probe', instructions: 'Write the probe', complexity: 'low' }],
    }] })));
    if (role === 'worker') return Response.json(result ? final(JSON.stringify({ summary: 'probed', filesChanged: ['probe.txt'], done: true, remaining: [], learnings: [] })) : call('run_command', { command: `${probe} > probe.txt` }));
    if (!result) {
      reviewerTool = body.tools.find((x: { function: { name: string } }) => x.function.name === 'run_command').function.description;
      return Response.json(call('run_command', { command: probe }));
    }
    reviewerSaw = result.content;
    return Response.json(final(JSON.stringify({ pass: true, feedback: [], notes: [], summary: 'ok' })));
  });
  const config = { ...DEFAULT_CONFIG, harness: 'ollama' as const, docs: false, worktreeSetup: `${probe} > ${setupLog}`, providers: { ollama: { ...provider, model: 'm', apiKeyEnv: 'DULGER_TEST_PROVIDER_KEY' } } };
  const board = createBoard(cwd, 'Probe', 'api-env');
  const orch = createOrchestrator(cwd, board, config);
  await orch.plan();
  await orch.execute();
  const c1 = board.cards[0]!;
  assert.equal(c1.status, 'done', c1.reason);
  assert.equal(git.git(cwd, ['show', 'dulger/api-env:probe.txt']), clean, 'the worker\'s shell');
  assert.equal(readFileSync(setupLog, 'utf8').trim(), clean, 'worktree setup');
  assert.equal(c1.verification![0]!.output, clean, 'the verification gate');
  assert.equal(board.finalVerification!.results[0]!.output, clean, 'final verification');
  assert.ok(reviewerTool.includes(JSON.stringify(probe)), 'the reviewer may run the verify command');
  assert.equal(reviewerSaw, `exit 0\n${clean}\n`, 'and it ran without the credentials');
});

test('transient HTTP errors are retried with backoff before the agent fails', async (t) => {
  const { opts, config } = setup(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls <= 2) return new Response('busy', { status: calls === 1 ? 429 : 503, headers: { 'retry-after': '0' } });
    return Response.json(final());
  });
  const result = await createOpenAIAdapter('ollama', { ...config, retries: 3 }).run(opts);
  assert.equal(result.ok, true);
  assert.equal(calls, 3);

  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('busy', { status: 429, headers: { 'retry-after': '0' } }); });
  const persistent = await createOpenAIAdapter('ollama', { ...config, retries: 2 }).run(opts);
  assert.equal(persistent.ok, false);
  assert.equal(calls, 3, 'the first try plus two retries');
  assert.match(persistent.error!, /429 rate limit after 2 retries/);

  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('nope', { status: 401 }); });
  assert.match((await createOpenAIAdapter('ollama', config).run(opts)).error!, /HTTP 401;/);
  assert.equal(calls, 1, 'a client error is not retried');

  assert.equal(retryDelayMs(null, 0), 1000);
  assert.equal(retryDelayMs(null, 2), 9000);
  assert.equal(retryDelayMs(null, 9), 30_000);
  assert.equal(retryDelayMs('2', 0), 2000);
  assert.equal(retryDelayMs(new Date(Date.now() + 5000).toUTCString(), 0) > 3000, true);
});

test('run_command is killed after the configured timeout', async (t) => {
  const { opts } = setup(t);
  const started = Date.now();
  const out = await executeApiTool('run_command', { command: 'sleep 5; echo late' }, opts, 1);
  assert.match(out, /cancelled or timed out/);
  assert.ok(!out.includes('late'));
  assert.ok(Date.now() - started < 4000);
});

test('a failed request carries the server\'s own error message, redacted and cut short', async (t) => {
  const { opts, config } = setup(t);
  const old = process.env.DULGER_TEST_API_KEY;
  process.env.DULGER_TEST_API_KEY = 'sk-secret-123';
  t.after(() => { if (old === undefined) delete process.env.DULGER_TEST_API_KEY; else process.env.DULGER_TEST_API_KEY = old; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'model not found: qwen/nope (key sk-secret-123)\n' + 'x'.repeat(300) } }, { status: 400 }));
  const result = await createOpenAIAdapter('openrouter', { ...config, apiKeyEnv: 'DULGER_TEST_API_KEY' }).run(opts);
  assert.match(result.error!, /^openrouter HTTP 400 \(model not found: qwen\/nope \(key \[REDACTED\]\) x+…\); check endpoint/);
  assert.ok(!result.error!.includes('sk-secret-123'));
  assert.ok(result.error!.length < 320);

  t.mock.method(globalThis, 'fetch', async () => new Response('<html>bad gateway</html>', { status: 502 }));
  const html = await createOpenAIAdapter('ollama', { ...config, retries: 0 }).run(opts);
  assert.match(html.error!, /^ollama HTTP 502; check endpoint/, 'a body that is not JSON adds nothing');
});

test('listModels reads an OpenAI-style /models answer with the key in the header', async (t) => {
  const { listModels } = await import('../src/adapters/models.ts');
  const old = process.env.DULGER_TEST_API_KEY; process.env.DULGER_TEST_API_KEY = 'k';
  t.after(() => { if (old === undefined) delete process.env.DULGER_TEST_API_KEY; else process.env.DULGER_TEST_API_KEY = old; });
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(url.toString(), 'https://api.deepseek.com/models');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer k');
    return Response.json({ object: 'list', data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }, { id: 'deepseek-chat' }, { name: 'not-an-id' }] });
  });
  assert.deepEqual(await listModels({ ...DEFAULT_CONFIG.providers.deepseek!, apiKeyEnv: 'DULGER_TEST_API_KEY' }), ['deepseek-chat', 'deepseek-reasoner']);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  await assert.rejects(listModels(DEFAULT_CONFIG.providers.deepseek!), /HTTP 401 from api\.deepseek\.com/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
  await assert.rejects(listModels(DEFAULT_CONFIG.providers.deepseek!), /listed no models/);
});

test('tool-free reporting omits tools and refuses unsolicited tool calls', async (t) => {
  const { cwd, opts, config } = setup(t);
  writeFileSync(join(cwd, 'private.txt'), 'must not read this');
  let n = 0;
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.tools, undefined, 'tool-free requests must not advertise any tools');
    assert.ok(!body.messages[0].content.includes('Use the supplied tools'));
    if (++n === 1) return Response.json(call('read_file', { path: 'private.txt' }));
    assert.match(body.messages.at(-1).content, /not allowed for none access/);
    assert.ok(!JSON.stringify(body).includes('must not read this'));
    return Response.json(final());
  });
  const result = await createOpenAIAdapter('ollama', config).run({ ...opts, access: 'none' });
  assert.equal(result.ok, true);
  assert.equal(result.denied?.length, 1);
  for (const tool of ['read_file', 'list_files', 'git_diff', 'write_file', 'run_command']) {
    await assert.rejects(executeApiTool(tool, {}, { ...opts, access: 'none', allowedCommands: ['npm test'] }), /not allowed for none access/);
  }
});
