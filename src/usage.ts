// Token usage in the four buckets both harnesses report. Totals are derived, never stored on their own.
import type { Usage } from './types.ts';

export function addUsage(total: Usage | undefined, more: Usage): Usage {
  const t = total ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return { input: t.input + more.input, cacheRead: t.cacheRead + more.cacheRead, cacheWrite: t.cacheWrite + more.cacheWrite, output: t.output + more.output };
}

export function usageTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

/** Share of the prompt that came from cache, 0..1 (0 when nothing was read). */
export function cachedShare(u: Usage): number {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return prompt ? u.cacheRead / prompt : 0;
}
