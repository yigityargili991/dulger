// Git plumbing for per-card isolation. Every card works on its own branch in its own worktree;
// finished cards are merged back onto the run branch, which is never checked out anywhere.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class GitError extends Error {
  stdout: string;
  stderr: string;
  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trimEnd();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    if (opts.allowFail) return (err.stdout ?? '').trimEnd();
    throw new GitError(`git ${args.join(' ')} failed (${err.status}): ${(err.stderr ?? '').trim()}`, err.stdout ?? '', err.stderr ?? '');
  }
}

/**
 * git for dulger's own commits, merges and branch updates in and about worktrees, with no hooks: a relative
 * core.hooksPath, or a hook manager configured in the tree, would run files a worker wrote, unsandboxed, and
 * `--no-verify` skips only two hooks.
 */
function plumbing(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  return git(cwd, ['-c', 'core.hooksPath=/dev/null', ...args], opts);
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

export function headRef(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export function currentBranch(cwd: string): string {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** False on a freshly initialised repository whose HEAD points at an unborn branch. */
export function hasCommits(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }) !== '';
}

export function isClean(cwd: string): boolean {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no']) === '';
}

export function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) !== '';
}

export function deleteBranch(cwd: string, branch: string): void {
  plumbing(cwd, ['branch', '-D', branch], { allowFail: true });
}

export function createBranch(cwd: string, branch: string, from: string): void {
  plumbing(cwd, ['branch', '--no-track', branch, from]);
}

/** Create (or recreate) a worktree for `branch` at `path`, starting from `from`. */
export function createWorktree(repo: string, path: string, branch: string, from: string): void {
  removeWorktree(repo, path, branch);
  plumbing(repo, ['worktree', 'add', '--no-checkout', '-b', branch, path, from]);
  plumbing(path, ['checkout', '--quiet']);
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
}

/** Worktrees git knows about (from `git worktree list --porcelain`), the main checkout included. */
export function listWorktrees(repo: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  for (const block of git(repo, ['worktree', 'list', '--porcelain']).split('\n\n')) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    out.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] });
  }
  return out;
}

export function removeWorktree(repo: string, path: string, branch?: string): void {
  if (existsSync(path)) {
    plumbing(repo, ['worktree', 'remove', '--force', path], { allowFail: true });
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  plumbing(repo, ['worktree', 'prune'], { allowFail: true });
  if (branch && branchExists(repo, branch)) plumbing(repo, ['branch', '-D', branch], { allowFail: true });
}

/** Stage everything (except .dulger/) and commit. Returns false when there was nothing to commit. */
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ['add', '-A', '--', '.', ':(exclude).dulger']);
  if (git(cwd, ['diff', '--cached', '--quiet'], { allowFail: true }) === '' && git(cwd, ['diff', '--cached', '--name-only']) === '') return false;
  plumbing(cwd, ['-c', 'user.name=dulger', '-c', 'user.email=dulger@localhost', 'commit', '--quiet', '--no-verify', '-m', message]);
  return true;
}

export interface ReviewDiff {
  /** Absent when over the limit; the reviewer reads it file by file instead. */
  text?: string;
  stat: string;
  chars: number;
  files: string[];
}

export const REVIEW_DIFF_MAX_CHARS = 120_000;

export function reviewDiff(cwd: string, from: string, to = 'HEAD', maxChars = REVIEW_DIFF_MAX_CHARS): ReviewDiff {
  const out = git(cwd, ['diff', `${from}...${to}`]);
  const files = git(cwd, ['diff', '--name-only', `${from}...${to}`]).split('\n').filter(Boolean);
  return { text: out.length > maxChars ? undefined : out, stat: diffStat(cwd, from, to), chars: out.length, files };
}

export function diffStat(cwd: string, from: string, to = 'HEAD'): string {
  return git(cwd, ['diff', '--stat', `${from}...${to}`]);
}

export interface MergeResult {
  ok: boolean;
  conflicts?: string[];
}

/**
 * Merge `branch` into the worktree's HEAD. With keepConflicts the conflict markers are left in
 * place so an agent can resolve them; the next commitAll() then completes the merge.
 */
export function mergeFrom(worktree: string, branch: string, opts: { keepConflicts?: boolean } = {}): MergeResult {
  try {
    plumbing(worktree, ['-c', 'user.name=dulger', '-c', 'user.email=dulger@localhost', 'merge', '--quiet', '--no-edit', branch]);
    return { ok: true };
  } catch (e) {
    const conflicts = git(worktree, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).split('\n').filter(Boolean);
    if (!opts.keepConflicts || conflicts.length === 0) plumbing(worktree, ['merge', '--abort'], { allowFail: true });
    return { ok: false, conflicts: conflicts.length ? conflicts : [(e as Error).message] };
  }
}

export function isAncestor(cwd: string, ancestor: string, ref: string): boolean {
  try { git(cwd, ['merge-base', '--is-ancestor', ancestor, ref]); return true; } catch { return false; }
}

/**
 * Fast-forward `runBranch` to the worktree's HEAD. Returns false (and does nothing) when the run
 * branch has moved since it was last merged in, i.e. HEAD does not contain it. The run branch
 * must not be checked out anywhere.
 */
export function land(worktree: string, runBranch: string): boolean {
  if (!isAncestor(worktree, runBranch, 'HEAD')) return false;
  plumbing(worktree, ['branch', '-f', runBranch, 'HEAD']);
  return true;
}

export function log(cwd: string, range: string, n = 50): string {
  return git(cwd, ['log', '--oneline', `-n${n}`, range], { allowFail: true });
}

/** Ensure `patterns` are in .git/info/exclude; drop any `remove`d legacy ones. */
export function excludeFromGit(repo: string, patterns: string[], remove: string[] = []): void {
  const gitDir = git(repo, ['rev-parse', '--git-common-dir']);
  const infoDir = join(repo, gitDir, 'info');
  const file = join(infoDir, 'exclude');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = current.split('\n');
  const kept = lines.filter((l) => !remove.includes(l.trim()));
  const missing = patterns.filter((p) => !kept.some((l) => l.trim() === p));
  if (missing.length === 0 && kept.length === lines.length) return;
  mkdirSync(infoDir, { recursive: true });
  const body = kept.join('\n').replace(/\n*$/, '');
  writeFileSync(file, (body ? body + '\n' : '') + missing.join('\n') + (missing.length ? '\n' : ''));
}
