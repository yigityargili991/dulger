// API keys entered at the prompt live in one user-level file, never in a repository. The environment
// still wins, so CI and shells with the variable exported behave as before.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.ts';

export function keysFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'dulger', 'keys.json');
}

/** The stored keys, or undefined when the file exists but cannot be read (unparseable or not an object). */
function parseKeys(): Record<string, string> | undefined {
  let raw: string;
  try { raw = readFileSync(keysFile(), 'utf8'); } catch { return {}; }
  try {
    const o = JSON.parse(raw) as unknown;
    if (o !== null && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, string>;
  } catch { /* unparseable */ }
  return undefined;
}

export function readKey(envName: string): string | undefined {
  if (process.env[envName]) return process.env[envName];
  // A keys file that cannot be read is treated as holding nothing, so the app does not crash; the key
  // then shows as unreadable/missing and the first agent call reports the real failure.
  return parseKeys()?.[envName] || undefined;
}

/**
 * Where a key would come from right now, for showing without revealing it. `unreadable`: the keys file
 * exists but is not valid JSON, so dulger will not touch it; the key is neither confirmed nor stored.
 */
export function keySource(envName: string): 'environment' | 'keys file' | 'missing' | 'unreadable' {
  if (process.env[envName]) return 'environment';
  const all = parseKeys();
  if (all === undefined) return 'unreadable';
  return all[envName] ? 'keys file' : 'missing';
}

/**
 * Store a key in the user's keys file (mode 600), keeping the keys already there. Throws CliError, and
 * writes nothing, when the file exists but is not valid JSON: overwriting it would lose those keys.
 */
export function storeKey(envName: string, value: string): string {
  const file = keysFile();
  let existing: Record<string, string> = {};
  if (existsSync(file)) {
    const all = parseKeys();
    if (all === undefined) throw new CliError(`Your keys file ${file} is not valid JSON; fix or remove it before storing a key (overwriting it would lose the keys already in it).`);
    existing = all;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...existing, [envName]: value }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
