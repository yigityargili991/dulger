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

/**
 * Who holds the run's execution lock, read without touching it: undefined when nobody does or the
 * owner file cannot be read (an owner still writing it, a broken lock). Says nothing about liveness.
 */
export function lockOwner(root: string, id: string): { pid: number; host: string } | undefined {
  try {
    const o = readOwner(join(runDir(root, id), 'execution.lock')) as Partial<Owner> | null;
    if (!o || typeof o.pid !== 'number' || typeof o.host !== 'string') return undefined;
    return { pid: o.pid, host: o.host };
  } catch { return undefined; }
}

/**
 * The process id of another live dulger on this machine that holds the run's execution lock, or
 * undefined when nobody does, the owner is this process, on another host, or gone. A process we may
 * not signal (EPERM) is alive.
 */
export function liveLockHolder(root: string, id: string): number | undefined {
  const owner = lockOwner(root, id);
  const pid = owner?.pid;
  if (!owner || owner.host !== hostname() || pid === undefined || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
  try { process.kill(pid, 0); return pid; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : undefined; }
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
