import { CliError } from '../errors.ts';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runDir } from './store.ts';

interface Owner { pid: number; host: string; token: string }

/** Acquire exclusive execution; the returned release only removes this owner's lock. */
export function acquireRunLock(root: string, id: string): () => void {
  const dir = runDir(root, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'execution.lock');
  const owner: Owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  if (!createLock(path, owner)) recoverLock(dir, id, owner);
  return () => releaseLock(path, owner.token);
}

function readOwner(path: string): Owner {
  return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as Owner;
}

function createLock(path: string, owner: Owner): boolean {
  try { mkdirSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
  try { writeFileSync(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 }); }
  catch (e) { rmSync(path, { recursive: true }); throw e; }
  return true;
}

/** Only a confirmed dead process on this host makes a lock recoverable. */
function ownerIsDead(owner: Owner): boolean {
  if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function recoverLock(dir: string, id: string, owner: Owner): void {
  const path = join(dir, 'execution.lock');
  const recovery = join(dir, 'recovery.lock');
  try { mkdirSync(recovery); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    throw new CliError(`Run ${id} is busy recovering its execution lock. Try again shortly.`);
  }
  try {
    let previous: Owner | undefined;
    try { previous = readOwner(path); }
    catch (e) {
      // An owner may still be writing its identity. Do not steal an incomplete lock.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new CliError(`Unreadable execution lock for ${id}; inspect ${path}.`);
    }
    if (!previous || !ownerIsDead(previous)) throw new CliError(`Run ${id} is already in use, or its lock cannot be verified. Inspect ${path} before retrying.`);
    rmSync(path, { recursive: true });
    if (!createLock(path, owner)) throw new CliError(`Run ${id} was acquired by another process. Try again later.`);
  } finally { rmSync(recovery, { recursive: true, force: true }); }
}

function releaseLock(path: string, token: string): void {
  try { if (readOwner(path).token === token) rmSync(path, { recursive: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
