// The verification gate: the commands a card's plan names (build, tests, lint) are run by dulger itself
// in the card's worktree, after its work is committed and synced with the result branch. Whether they
// pass is a fact the harness establishes, not a judgement an agent makes; a failure sends the card back
// with the output before any reviewer is paid to look at it.
import { spawnSync } from 'node:child_process';
import type { VerificationResult } from '../types.ts';

const OUTPUT_TAIL = 3000;

export function runVerification(cwd: string, commands: string[], opts: { timeoutSec: number; signal?: AbortSignal }): VerificationResult[] {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    if (opts.signal?.aborted) break;
    const started = Date.now();
    const r = spawnSync(command, {
      cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });
    const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const output = timedOut ? `${out}\n[dulger: killed after ${opts.timeoutSec}s]`.trim() : r.error && !r.status ? `${out}\n${r.error.message}`.trim() : out;
    results.push({
      command, ok: r.status === 0 && !r.error, exitCode: r.status ?? -1, durationMs: Date.now() - started,
      output: output.length > OUTPUT_TAIL ? '…' + output.slice(-OUTPUT_TAIL) : output,
    });
  }
  return results;
}

/** What the implementing agent gets back when the gate fails: one item per failed command, with its output. */
export function verificationFeedback(results: VerificationResult[]): string[] {
  return results.filter((r) => !r.ok).map((r) => `\`${r.command}\` failed (exit ${r.exitCode}). Make it pass; its output was:\n${r.output || '(no output)'}`);
}

/** One line per command for prompts, boards and reports. */
export function verificationSummary(results: VerificationResult[]): string {
  return results.map((r) => `${r.ok ? 'ok' : 'FAILED'} ${r.command}${r.ok ? '' : ` (exit ${r.exitCode})`}`).join(', ');
}
