// API keys entered at the prompt live in one user-level file, never in a repository. The environment
// still wins, so CI and shells with the variable exported behave as before.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function keysFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'dulger', 'keys.json');
}

function readAll(): Record<string, string> {
  try { return JSON.parse(readFileSync(keysFile(), 'utf8')) as Record<string, string>; } catch { return {}; }
}

export function readKey(envName: string): string | undefined {
  return process.env[envName] || readAll()[envName] || undefined;
}

/** Where a key would come from right now, for showing without revealing it. */
export function keySource(envName: string): 'environment' | 'keys file' | 'missing' {
  if (process.env[envName]) return 'environment';
  return readAll()[envName] ? 'keys file' : 'missing';
}

export function storeKey(envName: string, value: string): string {
  const file = keysFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...readAll(), [envName]: value }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
