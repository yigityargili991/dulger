import * as git from '../git/worktree.ts';
import * as store from '../board/store.ts';
import { childEnv } from '../childEnv.ts';
import { runVerification, verificationSummary } from './verify.ts';
import type { Runtime } from './runtime.ts';

/** Verify the exact final result, including documentation, without checking out the user's branch. */
export async function verifyFinalResult(rt: Runtime): Promise<void> {
  const commands = [...new Set(rt.board.cards.filter((c) => c.status === 'done').flatMap((c) => c.verify))];
  const ref = git.git(rt.repoRoot, ['rev-parse', rt.board.runBranch]);
  if (rt.board.finalVerification?.ref === ref && rt.board.finalVerification.results.length === commands.length && rt.board.finalVerification.results.every((r, i) => r.ok && r.command === commands[i])) return;
  const cwd = store.worktreeDir(rt.repoRoot, rt.board.runId, '_final-verification');
  const branch = `dulger-wip/${rt.board.runId}/_final-verification`;
  let results: Awaited<ReturnType<typeof runVerification>> = [];
  if (commands.length) {
    rt.log(`verifying final result: ${commands.join(', ')}`);
    git.createWorktree(rt.repoRoot, cwd, branch, ref);
    try {
      await rt.setupWorktree(cwd);
      results = await runVerification(cwd, commands, { timeoutSec: rt.config.verifyTimeoutSec, signal: rt.signal, env: childEnv(rt.config), sandbox: rt.sandbox });
    } finally { git.removeWorktree(rt.repoRoot, cwd, branch); }
  }
  if (rt.signal.aborted) return;
  rt.board.finalVerification = { ref, results };
  rt.save('final_verified');
  rt.log(commands.length ? `final verification: ${verificationSummary(results)}` : 'final verification: no commands configured');
}
