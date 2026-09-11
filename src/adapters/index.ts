import type { HarnessName } from '../types.ts';
import type { Config } from '../config.ts';
import type { Adapter } from './types.ts';
import { claudeAdapter } from './claude.ts';
import { createCodexAdapter } from './codex.ts';
import { createFakeAdapter } from './fake.ts';
import { createOpenAIAdapter } from './openai.ts';

export type { Adapter, AdapterRunOptions, AdapterResult } from './types.ts';

const cache = new Map<HarnessName, Adapter>();
const configured = new WeakMap<Config, Map<HarnessName, Adapter>>();

/** Replace the adapter used for a harness name (tests inject scripted fakes this way). */
export function registerAdapter(name: HarnessName, adapter: Adapter): void {
  cache.set(name, adapter);
}

export function getAdapter(name: HarnessName, config: Config): Adapter {
  let a = cache.get(name);
  if (a) return a;
  let adapters = configured.get(config);
  if (!adapters) { adapters = new Map(); configured.set(config, adapters); }
  a = adapters.get(name);
  if (a) return a;
  switch (name) {
    case 'claude': a = claudeAdapter; break;
    case 'codex': a = createCodexAdapter({ bypassSandbox: config.codex.bypassSandbox }); break;
    case 'fake': a = createFakeAdapter(); break;
    case 'ollama': case 'deepseek': case 'openai': {
      const provider = config.providers[name];
      if (!provider) throw new Error(`missing providers.${name} configuration`);
      a = createOpenAIAdapter(name, provider);
      break;
    }
    default: throw new Error(`unknown harness: ${name as string}`);
  }
  adapters.set(name, a);
  return a;
}
