// Starting a run: a fresh board with its result branch, and the git exclude entries usta needs.
import { randomBytes } from 'node:crypto';
import { STATE_DIR } from '../config.ts';
import * as git from '../git/worktree.ts';
import * as store from './store.ts';
import type { Board } from '../types.ts';

export function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${randomBytes(2).toString('hex')}`;
}

export function createBoard(repoRoot: string, goal: string, runId = newRunId()): Board {
  const board: Board = {
    runId, goal,
    baseRef: git.headRef(repoRoot),
    baseBranch: git.currentBranch(repoRoot),
    runBranch: `usta/${runId}`,
    createdAt: new Date().toISOString(),
    cards: [],
    docs: { status: 'pending' },
    costUsd: 0,
  };
  if (!git.branchExists(repoRoot, board.runBranch)) git.createBranch(repoRoot, board.runBranch, board.baseRef);
  // context/ and config.json stay committable.
  git.excludeFromGit(repoRoot, [`${STATE_DIR}/*`, `!${STATE_DIR}/context`, `!${STATE_DIR}/config.json`], [`${STATE_DIR}/`]);
  store.saveBoard(repoRoot, board);
  return board;
}
