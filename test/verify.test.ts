import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerification, verificationFeedback } from '../src/runner/verify.ts';
import { childEnv } from '../src/childEnv.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

test('runVerification records exit codes, output tails and timeouts per command', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dulger-verify-'));
  const r = await runVerification(cwd, ['echo out; echo err >&2', 'exit 3', 'seq 1 5000', 'sleep 5'], { timeoutSec: 1 });
  assert.deepEqual(r.map((x) => [x.ok, x.exitCode]), [[true, 0], [false, 3], [true, 0], [false, -1]]);
  assert.equal(r[0]!.output, 'out\nerr');
  assert.ok(r[2]!.output.startsWith('…') && r[2]!.output.endsWith('5000'), 'long output keeps its tail');
  assert.match(r[3]!.output, /killed after 1s/);
  assert.ok(r[3]!.durationMs < 3000);
  const fb = verificationFeedback(r);
  assert.equal(fb.length, 2);
  assert.match(fb[0]!, /^`exit 3` failed \(exit 3\)/);
});

test('verify commands do not see the credentials dulger runs agents with; the project\'s own secrets pass through', async (t) => {
  const vars = { ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'b', DULGER_TEST_PROVIDER_KEY: 'c', NPM_TOKEN: 'npm', DATABASE_PASSWORD: 'db' };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, vars);
  const config = { providers: { ...DEFAULT_CONFIG.providers, custom: { ...DEFAULT_CONFIG.providers.openai!, apiKeyEnv: 'DULGER_TEST_PROVIDER_KEY' } } };
  const cwd = mkdtempSync(join(tmpdir(), 'dulger-verify-'));
  const echo = 'echo "[$ANTHROPIC_API_KEY][$CLAUDE_CODE_OAUTH_TOKEN][$DULGER_TEST_PROVIDER_KEY][$NPM_TOKEN][$DATABASE_PASSWORD]"';
  assert.equal((await runVerification(cwd, [echo], { timeoutSec: 5, env: childEnv(config) }))[0]!.output, '[][][][npm][db]');
  assert.equal((await runVerification(cwd, [echo], { timeoutSec: 5 }))[0]!.output, '[][][c][npm][db]', 'without a config only the fixed names are dropped');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'a', 'dulger keeps its own environment');
});

test('runVerification stops at an aborted signal', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  assert.deepEqual(await runVerification('/', ['true'], { timeoutSec: 1, signal: ctrl.signal }), []);
});
