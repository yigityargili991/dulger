// Where usta keeps per-project state outside the repository: $XDG_DATA_HOME/usta/<project>/.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import * as git from './git/worktree.ts';

export function userDataDir(): string {
  if (process.env.USTA_DATA_DIR) return process.env.USTA_DATA_DIR;
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdg, 'usta');
}

function originUrl(repoRoot: string): string | undefined {
  const url = git.git(repoRoot, ['remote', 'get-url', 'origin'], { allowFail: true }).trim();
  if (!url) return undefined;
  return url.toLowerCase().replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/:/, '/').replace(/\.git$/, '').replace(/\/+$/, '');
}

/** Origin URL when there is one (shared by clones), otherwise this checkout's path. */
export function repoKey(repoRoot: string): string {
  const origin = originUrl(repoRoot);
  if (origin) return origin.replace(/[^\w.-]+/g, '-').slice(0, 100);
  const name = basename(repoRoot).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'repo';
  return `${name}-${createHash('sha1').update(repoRoot).digest('hex').slice(0, 12)}`;
}

export function projectDataDir(repoRoot: string): string {
  return join(userDataDir(), repoKey(repoRoot));
}

export function worktreesDir(repoRoot: string): string {
  return join(projectDataDir(repoRoot), 'worktrees');
}
