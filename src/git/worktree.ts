// Git plumbing for per-card isolation. Every card works on its own branch in its own worktree;
// finished cards are merged back onto the run branch, which is never checked out anywhere.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
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

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

export function headRef(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export function currentBranch(cwd: string): string {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function isClean(cwd: string): boolean {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no']) === '';
}

export function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) !== '';
}

export function createBranch(cwd: string, branch: string, from: string): void {
  git(cwd, ['branch', '--no-track', branch, from]);
}

/** Create (or recreate) a worktree for `branch` at `path`, starting from `from`. */
export function createWorktree(repo: string, path: string, branch: string, from: string): void {
  removeWorktree(repo, path, branch);
  git(repo, ['worktree', 'add', '--no-checkout', '-b', branch, path, from]);
  git(path, ['checkout', '--quiet']);
}

export function removeWorktree(repo: string, path: string, branch?: string): void {
  if (existsSync(path)) {
    git(repo, ['worktree', 'remove', '--force', path], { allowFail: true });
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  git(repo, ['worktree', 'prune'], { allowFail: true });
  if (branch && branchExists(repo, branch)) git(repo, ['branch', '-D', branch], { allowFail: true });
}

/** Stage everything (except .usta/) and commit. Returns false when there was nothing to commit. */
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ['add', '-A', '--', '.', ':(exclude).usta']);
  if (git(cwd, ['diff', '--cached', '--quiet'], { allowFail: true }) === '' && git(cwd, ['diff', '--cached', '--name-only']) === '') return false;
  git(cwd, ['-c', 'user.name=usta', '-c', 'user.email=usta@localhost', 'commit', '--quiet', '--no-verify', '-m', message]);
  return true;
}

export function diff(cwd: string, from: string, to = 'HEAD', maxChars = 120_000): string {
  const out = git(cwd, ['diff', `${from}...${to}`]);
  return out.length > maxChars ? out.slice(0, maxChars) + `\n\n[... diff truncated at ${maxChars} chars ...]` : out;
}

export function diffStat(cwd: string, from: string, to = 'HEAD'): string {
  return git(cwd, ['diff', '--stat', `${from}...${to}`]);
}

export interface MergeBackResult {
  ok: boolean;
  conflicts?: string[];
}

/**
 * Bring the run branch's latest state into the card worktree, then fast-forward the run
 * branch to the card branch. The run branch must not be checked out anywhere.
 */
export function mergeBack(worktree: string, runBranch: string, cardBranch: string, opts: { keepConflicts?: boolean } = {}): MergeBackResult {
  try {
    git(worktree, ['-c', 'user.name=usta', '-c', 'user.email=usta@localhost', 'merge', '--quiet', '--no-edit', runBranch]);
  } catch (e) {
    const conflicts = git(worktree, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).split('\n').filter(Boolean);
    // keepConflicts leaves the conflict markers in place so an agent can resolve them;
    // the next commitAll() then completes the merge.
    if (!opts.keepConflicts || conflicts.length === 0) git(worktree, ['merge', '--abort'], { allowFail: true });
    return { ok: false, conflicts: conflicts.length ? conflicts : [(e as Error).message] };
  }
  git(worktree, ['branch', '-f', runBranch, cardBranch]);
  return { ok: true };
}

export function log(cwd: string, range: string, n = 50): string {
  return git(cwd, ['log', '--oneline', `-n${n}`, range], { allowFail: true });
}

/** Add a pattern to .git/info/exclude (per-clone ignore that is never committed). */
export function excludeFromGit(repo: string, pattern: string): void {
  const gitDir = git(repo, ['rev-parse', '--git-common-dir']);
  const infoDir = join(repo, gitDir, 'info');
  const file = join(infoDir, 'exclude');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').includes(pattern)) return;
  mkdirSync(infoDir, { recursive: true });
  appendFileSync(file, (current.endsWith('\n') || current === '' ? '' : '\n') + pattern + '\n');
}
