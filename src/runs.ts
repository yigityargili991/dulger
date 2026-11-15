// Runs as data: what a run list shows, what a run changed, whether its result can merge and the merge
// itself, the failed cards a retry can pick, and the cleanup of leftovers. Nothing here prints; the
// CLI and the prompt (commands.ts, runViews.ts) print what these return.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CliError } from './errors.ts';
import { STATE_DIR } from './config.ts';
import * as store from './board/store.ts';
import * as git from './git/worktree.ts';
import { acquireRunLock, liveLockHolder, lockOwner } from './board/lock.ts';
import { worktreesDir } from './paths.ts';
import { sandboxDir } from './sandbox.ts';
import { fmtSpend } from './ui/ansi.ts';
import type { Board, Card } from './types.ts';

export type RunStatus = 'stopped' | 'paused' | 'in progress / interrupted' | 'needs attention' | 'planning incomplete' | 'ready to resume' | 'finished';

/** The run's state as its board records it. See runState for the state with the process taken into account. */
export function runStatus(board: Board): RunStatus {
  if (board.halted || board.checkpoint?.phase === 'stopped') return 'stopped';
  if (board.paused || board.checkpoint?.phase === 'paused') return 'paused';
  if (['running', 'docs', 'verifying'].includes(board.checkpoint?.phase ?? '') || board.cards.some((c) => ['in_progress', 'review'].includes(c.status))) return 'in progress / interrupted';
  if (board.cards.some((c) => c.status === 'failed')) return 'needs attention';
  if (board.finalVerification?.results.some((r) => !r.ok) || board.docs?.status === 'failed') return 'needs attention';
  if (!board.cards.length) return 'planning incomplete';
  if (board.cards.some((c) => c.status === 'backlog' || c.status === 'blocked') || board.docs?.status === 'pending' || board.docs?.status === 'running') return 'ready to resume';
  return 'finished';
}

/**
 * The run's state, taking its process into account: "paused" only while a dulger process holds the run
 * (one that was killed while paused is interrupted, like one killed while running).
 */
export function runState(root: string, board: Board): RunStatus {
  const st = runStatus(board);
  if (st === 'paused' && liveLockHolder(root, board.runId) === undefined) return 'in progress / interrupted';
  return st;
}

/** Cards a replan replaced are not part of the plan any more: counted apart, never in the total. */
export function cardCounts(cards: Card[]): { done: number; failed: number; total: number; replaced: number } {
  const live = cards.filter((c) => c.status !== 'replaced');
  return {
    done: live.filter((c) => c.status === 'done').length,
    failed: live.filter((c) => c.status === 'failed').length,
    total: live.length,
    replaced: cards.length - live.length,
  };
}

/**
 * A run's start time for ordering. A board that cannot be read takes the time its id names (dulger's
 * ids start with the local date and minute); one with neither sorts as the oldest.
 */
function startKey(root: string, id: string): string {
  try {
    const at = store.loadBoard(root, id).createdAt;
    if (at && Number.isFinite(Date.parse(at))) return new Date(at).toISOString();
  } catch { /* fall back to the id */ }
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(id);
  if (m) {
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    if (Number.isFinite(t.getTime())) return t.toISOString();
  }
  return '';
}

/** Run ids by start time, oldest first (ties by id): what "the latest run" means everywhere. */
export function runsByStart(root: string): string[] {
  const keyed = store.listRuns(root).map((id) => ({ id, at: startKey(root, id) }));
  return keyed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((x) => x.id);
}

/** Ids of the runs that are not finished, oldest first by start; unreadable boards are left out. */
export function recoverableRuns(root: string): string[] {
  return runsByStart(root).filter((id) => { try { return runState(root, store.loadBoard(root, id)) !== 'finished'; } catch { return false; } });
}

/** `runId` when it names a run, the most recently started run when omitted. Throws CliError for no runs or an unknown id. */
export function latestRun(repoRoot: string, runId?: string): string {
  const id = runId ?? runsByStart(repoRoot).at(-1);
  if (!id) throw new CliError('no runs found');
  if (!store.listRuns(repoRoot).includes(id)) throw new CliError(`no run ${id}`);
  return id;
}

export type RunSummary =
  | {
    id: string;
    readable: true;
    status: RunStatus;
    goal: string;
    createdAt: string;
    /** `total` leaves out cards a replan replaced; `replaced` counts those. */
    cards: { done: number; failed: number; total: number; replaced: number };
    costUsd: number;
    /** "$1.23 · 45k tokens", or "-" when nothing was reported. */
    spend: string;
    /** The result branch, dulger/<runId>. */
    branch: string;
  }
  /** board.json could not be read or is not a valid board; `error` says why. */
  | { id: string; readable: false; error: string };

/** One entry per run, oldest first by start time. Never throws for a broken board. */
export function runSummaries(repoRoot: string): RunSummary[] {
  return runsByStart(repoRoot).map((id): RunSummary => {
    let b: Board;
    try { b = store.loadBoard(repoRoot, id); } catch (e) { return { id, readable: false, error: (e as Error).message }; }
    return {
      id, readable: true, status: runState(repoRoot, b), goal: b.goal, createdAt: b.createdAt,
      cards: cardCounts(b.cards), costUsd: b.costUsd, spend: fmtSpend(b), branch: b.runBranch,
    };
  });
}

type RunRefs = Pick<Board, 'baseRef' | 'runBranch'>;

function requireBranch(repoRoot: string, board: RunRefs): void {
  if (!git.branchExists(repoRoot, board.runBranch)) throw new CliError(`${board.runBranch} no longer exists`);
}

/** Files the result branch changed against the run's base. Throws CliError when the branch is gone. */
export function changedFiles(repoRoot: string, board: RunRefs): string[] {
  requireBranch(repoRoot, board);
  // `--end-of-options` so a board ref can never be read as a git option (board refs are also guarded on load).
  return git.git(repoRoot, ['diff', '--name-only', '-z', '--end-of-options', board.baseRef, board.runBranch]).split('\0').filter(Boolean);
}

/** The plain-text diff of one changed file ('' when git has no text diff for it, e.g. a binary). */
export function fileDiff(repoRoot: string, board: RunRefs, file: string): string {
  requireBranch(repoRoot, board);
  return git.git(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--end-of-options', board.baseRef, board.runBranch, '--', file]);
}

export interface FailedCard {
  id: string;
  title: string;
  /** Why it failed: dulger's own reason, else the reviewer's last feedback. */
  reason?: string;
}

/** The cards a retry can give another round, in board order. */
export function failedCards(board: Board): FailedCard[] {
  return board.cards.filter((c) => c.status === 'failed').map((c) => ({ id: c.id, title: c.title, reason: c.reason ?? c.feedback.at(-1) }));
}

/** unverified, verification-failed and docs-unfinished: resume the run first. The other two are about the checkout. */
export type MergeBlockerCode = 'unverified' | 'verification-failed' | 'docs-unfinished' | 'branch-missing' | 'dirty-tree';
export interface MergeBlocker { code: MergeBlockerCode; message: string }

/** Codes about the run's result itself; the rest are about the branch and the checkout. */
export const RESULT_BLOCKERS: readonly MergeBlockerCode[] = ['unverified', 'verification-failed', 'docs-unfinished'];

/** Why the run's result cannot be merged into the current branch now, in the order a merge reports them; [] when it can. */
export function mergeBlockers(repoRoot: string, board: Board): MergeBlocker[] {
  const out: MergeBlocker[] = [];
  const branch = git.branchExists(repoRoot, board.runBranch);
  const final = board.finalVerification;
  if (board.settings && !final) out.push({ code: 'unverified', message: 'The final result has not been verified. Resume the run before merging.' });
  else if (final && (final.results.some((r) => !r.ok) || (branch && final.ref !== git.git(repoRoot, ['rev-parse', board.runBranch])))) {
    out.push({ code: 'verification-failed', message: 'Final verification failed or is stale. Resume the run to verify its current result before merging.' });
  }
  if (board.docs?.status === 'failed' || board.docs?.status === 'running') out.push({ code: 'docs-unfinished', message: 'Documentation is unfinished. Resume the run before merging.' });
  if (!branch) out.push({ code: 'branch-missing', message: `${board.runBranch} no longer exists` });
  if (!git.isClean(repoRoot)) out.push({ code: 'dirty-tree', message: 'working tree has uncommitted changes; commit them before merging' });
  return out;
}

export interface MergedRun { runId: string; branch: string; into: string }

/**
 * Merge a run's result branch (the newest run's when omitted) into the current branch, under the run's
 * lock. Throws CliError for no runs, an unknown id, a busy run or the first merge blocker; GitError when
 * git refuses the merge (conflicts are left in the working tree, as git leaves them).
 */
export function mergeRunBranch(repoRoot: string, runId?: string): MergedRun {
  const id = latestRun(repoRoot, runId);
  const release = acquireRunLock(repoRoot, id);
  try {
    const board = store.loadBoard(repoRoot, id);
    const [blocker] = mergeBlockers(repoRoot, board);
    if (blocker) throw new CliError(blocker.message);
    // runBranch is guarded on load (never starts with "-" and matches the run), so the merge message stays clean.
    git.git(repoRoot, ['merge', '--no-edit', board.runBranch]);
    return { runId: id, branch: board.runBranch, into: git.currentBranch(repoRoot) };
  } finally { release(); }
}

/** A run Clean leaves alone, and why. */
export interface BusyRun { id: string; reason: string }

/**
 * Why a run must not be touched by Clean right now, or undefined: another live dulger process holds it,
 * or a dulger on another machine does (its liveness cannot be checked from here).
 */
export function runInUse(root: string, id: string): string | undefined {
  const pid = liveLockHolder(root, id);
  if (pid !== undefined) return `in use by another dulger process (pid ${pid})`;
  const owner = lockOwner(root, id);
  if (owner && owner.host !== hostname()) return `locked by dulger on ${owner.host}`;
  return undefined;
}

/** The run a work-in-progress branch belongs to: dulger-wip/<runId>/<card>. */
export function wipRunOf(branch: string | undefined): string | undefined {
  return branch?.match(/^dulger-wip\/([^/]+)\//)?.[1];
}

/**
 * Remove leftover card worktrees, dulger's worktree and sandbox folders and the wip branches, with every
 * run that can be locked locked. A run another process holds is left alone (its worktrees, folders and
 * branches stay) and reported in `skipped`; the rest is cleaned.
 */
export function cleanLeftoversReport(repoRoot: string): { removed: string[]; skipped: BusyRun[] } {
  const removed: string[] = [];
  const releases: Array<() => void> = [];
  const busy = new Map<string, string>();
  try {
    for (const id of store.listRuns(repoRoot)) {
      const inUse = runInUse(repoRoot, id);
      if (inUse) { busy.set(id, inUse); continue; }
      try { releases.push(acquireRunLock(repoRoot, id)); } catch (e) {
        if (!(e instanceof CliError)) throw e;
        busy.set(id, e.message);
      }
    }
    for (const w of git.listWorktrees(repoRoot).filter((w) => w.branch?.startsWith('dulger-wip/'))) {
      if (busy.has(wipRunOf(w.branch) ?? '')) continue;
      git.removeWorktree(repoRoot, w.path);
      removed.push(`removed worktree ${w.path} (${w.branch})`);
    }
    for (const dir of [worktreesDir(repoRoot), join(repoRoot, STATE_DIR, 'worktrees'), sandboxDir(repoRoot)]) {
      if (!existsSync(dir)) continue;
      if (!busy.size) { rmSync(dir, { recursive: true, force: true }); removed.push(`removed ${dir}`); continue; }
      // Something is in use: remove each run's folder but those, one by one.
      for (const child of readdirSync(dir)) {
        if (busy.has(child)) continue;
        rmSync(join(dir, child), { recursive: true, force: true });
        removed.push(`removed ${join(dir, child)}`);
      }
    }
    const wip = git.git(repoRoot, ['branch', '--list', 'dulger-wip/*', '--format=%(refname:short)'], { allowFail: true }).split('\n').filter(Boolean);
    for (const b of wip) {
      if (busy.has(wipRunOf(b) ?? '')) continue;
      git.git(repoRoot, ['branch', '-D', b], { allowFail: true });
      removed.push(`deleted branch ${b}`);
    }
  } finally { for (const release of releases.reverse()) release(); }
  return { removed, skipped: [...busy].map(([id, reason]) => ({ id, reason })) };
}

/** cleanLeftoversReport as lines, for the CLI and the prompt: what went, then each run left alone and why. */
export function cleanLeftovers(repoRoot: string): string[] {
  const { removed, skipped } = cleanLeftoversReport(repoRoot);
  return [...removed, ...skipped.map((s) => `left run ${s.id} alone: ${s.reason}`)];
}
