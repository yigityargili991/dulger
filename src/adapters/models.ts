// The models an OpenAI-style endpoint offers, so a person picks from a list instead of typing an id.
import type { ApiConfig } from '../config.ts';
import { readKey } from '../keys.ts';

export async function listModels(provider: ApiConfig): Promise<string[]> {
  const url = new URL(provider.baseUrl.replace(/\/+$/, '') + '/models');
  const key = provider.apiKeyEnv ? readKey(provider.apiKeyEnv) : undefined;
  const response = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.host}`);
  const body = await response.json() as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  if (!ids.length) throw new Error(`${url.host} listed no models`);
  return [...new Set(ids)].sort();
}
