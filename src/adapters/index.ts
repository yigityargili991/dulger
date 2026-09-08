import type { HarnessName } from '../types.ts';
import type { Config } from '../config.ts';
import type { Adapter } from './types.ts';
import { claudeAdapter } from './claude.ts';
import { createCodexAdapter } from './codex.ts';
import { createFakeAdapter } from './fake.ts';

export type { Adapter, AdapterRunOptions, AdapterResult } from './types.ts';

const cache = new Map<HarnessName, Adapter>();

/** Replace the adapter used for a harness name (tests inject scripted fakes this way). */
export function registerAdapter(name: HarnessName, adapter: Adapter): void {
  cache.set(name, adapter);
}

export function getAdapter(name: HarnessName, config: Config): Adapter {
  let a = cache.get(name);
  if (a) return a;
  switch (name) {
    case 'claude': a = claudeAdapter; break;
    case 'codex': a = createCodexAdapter({ bypassSandbox: config.codex.bypassSandbox }); break;
    case 'fake': a = createFakeAdapter(); break;
    default: throw new Error(`unknown harness: ${name as string}`);
  }
  cache.set(name, a);
  return a;
}
