import type { Adapter } from './types.ts';

export interface HarnessCapabilities {
  toolFree: boolean;
  continuation: boolean;
  modelDiscovery: boolean;
  costReporting: boolean;
  executable?: string;
}
export const CLAUDE_CAPABILITIES: HarnessCapabilities = { toolFree: true, continuation: true, modelDiscovery: false, costReporting: true, executable: 'claude' };
export const CODEX_CAPABILITIES: HarnessCapabilities = { toolFree: false, continuation: true, modelDiscovery: false, costReporting: false, executable: 'codex' };
export const API_CAPABILITIES: HarnessCapabilities = { toolFree: true, continuation: true, modelDiscovery: true, costReporting: false };
export const FAKE_CAPABILITIES: HarnessCapabilities = { toolFree: true, continuation: true, modelDiscovery: false, costReporting: true };
/** Custom adapters must opt into optional behavior. */
export function capabilities(adapter: Adapter): HarnessCapabilities {
  return adapter.capabilities ?? { toolFree: false, continuation: false, modelDiscovery: false, costReporting: false };
}
