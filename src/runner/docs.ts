// The documentation agent: one write session on top of the merged result, merged back like a card.
import * as store from '../board/store.ts';
import * as git from '../git/worktree.ts';
import { DOCS_SCHEMA } from '../roles/schemas.ts';
import * as P from '../roles/prompts.ts';
import { markFailed } from './agentProcess.ts';
import type { Runtime } from './runtime.ts';
import type { DocsResult } from '../types.ts';

export async function runDocs(rt: Runtime): Promise<void> {
  const { board, config, log, save } = rt;
  if (!config.docs) { board.docs = { status: 'skipped' }; save('docs_skipped'); return; }
  if (!board.cards.some((c) => c.status === 'done')) { board.docs = { status: 'skipped', summary: 'nothing merged' }; save('docs_skipped'); return; }
  const cwd = store.worktreeDir(rt.repoRoot, board.runId, 'docs');
  const branch = `usta-wip/${board.runId}/docs`;
  board.docs = { status: 'running' };
  save('docs_started');
  log('documentation agent started');
  git.createWorktree(rt.repoRoot, cwd, branch, board.runBranch);
  const stat = git.diffStat(cwd, board.baseRef);
  const r = await rt.agent<DocsResult>('docs', {
    prompt: P.docsPrompt(board, stat, rt.context({ root: cwd })), systemPrompt: P.docsSystem(), cwd, schema: DOCS_SCHEMA, access: 'write',
  }, { cardId: 'docs', logName: 'docs' });
  rt.addCost(undefined, r.costUsd);
  let status: 'done' | 'failed' = 'failed';
  if (r.ok && r.output) {
    git.commitAll(cwd, 'usta: update documentation');
    const merged = git.mergeBack(cwd, board.runBranch, branch);
    if (merged.ok) status = 'done';
    board.docs = merged.ok ? { status, summary: r.output.summary } : { status, summary: `merge conflict: ${merged.conflicts?.join(', ')}` };
  } else {
    board.docs = { status, summary: r.error };
    markFailed(rt.registry, 'docs');
  }
  if (status === 'done') git.removeWorktree(rt.repoRoot, cwd, branch);
  save(`docs_${status}`);
  log(`documentation ${status}${board.docs.summary ? `: ${board.docs.summary}` : ''}`);
}
