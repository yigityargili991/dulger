// The verification gate: the commands a card's plan names (build, tests, lint) are run by dulger itself
// in the card's worktree, after its work is committed and synced with the result branch. Whether they
// pass is a fact the harness establishes, not a judgement an agent makes; a failure sends the card back
// with the output before any reviewer is paid to look at it.
import { spawn } from 'node:child_process';
import { childEnv } from '../childEnv.ts';
import type { VerificationResult } from '../types.ts';

const OUTPUT_TAIL = 3000;

/** `env` is the commands' environment; callers pass childEnv(config), and the default still drops the fixed agent credentials. */
export async function runVerification(cwd: string, commands: string[], opts: { timeoutSec: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    if (opts.signal?.aborted) break;
    results.push(await new Promise<VerificationResult>((resolve) => {
      const started = Date.now();
      let output = '';
      let truncated = false;
      let reason: string | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...(opts.env ?? childEnv()), CI: '1', NO_COLOR: '1' } });
      const append = (text: string) => { output += text; if (output.length > OUTPUT_TAIL) { output = output.slice(-OUTPUT_TAIL); truncated = true; } };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', append); child.stderr.on('data', append);
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
      };
      const stop = (why: string) => {
        if (reason) return;
        reason = why;
        kill('SIGTERM');
        escalation = setTimeout(() => kill('SIGKILL'), 1000);
      };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop(`killed after ${opts.timeoutSec}s`), opts.timeoutSec * 1000);
      opts.signal?.addEventListener('abort', abort, { once: true });
      if (opts.signal?.aborted) abort();
      child.on('error', (err) => { reason = err.message; });
      child.on('close', (code) => {
        if (reason) kill('SIGKILL');
        clearTimeout(timer); clearTimeout(escalation);
        opts.signal?.removeEventListener('abort', abort);
        resolve({ command, ok: code === 0 && !reason, exitCode: code ?? -1, durationMs: Date.now() - started, output: `${truncated ? '…' : ''}${output.trim()}${reason ? `\n[dulger: ${reason}]` : ''}`.trim() });
      });
    }));
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
