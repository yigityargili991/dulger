import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerification, verificationFeedback } from '../src/runner/verify.ts';

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

test('runVerification stops at an aborted signal', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  assert.deepEqual(await runVerification('/', ['true'], { timeoutSec: 1, signal: ctrl.signal }), []);
});
