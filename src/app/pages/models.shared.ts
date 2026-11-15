// Shared by the Models and Providers pages: backend and key wording, and choosing a model for a
// backend (what is configured plus, for an API provider with a usable key, what its endpoint lists).
// Role names live with the rest of the app's vocabulary in src/app/look.ts.
import { homedir } from 'node:os';
import type { ApiConfig, Config } from '../../config.ts';
import { listModels } from '../../adapters/models.ts';
import { keySource, readKey } from '../../keys.ts';
import { candidateModels } from '../../replModels.ts';
import { providerUrlError, redactUrl } from '../../replProviders.ts';
import { plainText } from '../../tui/text.ts';
import type { PickOption, Tone } from '../../tui/kit/index.ts';
import type { AppContext } from '../types.ts';

/** Lists an endpoint's models; injectable so tests never touch the network. */
export type ModelLister = (provider: ApiConfig) => Promise<string[]>;
export const defaultLister: ModelLister = listModels;

/** One line on what a backend is. */
export function backendDetail(config: Config, name: string): string {
  if (name === 'claude') return 'Claude Code CLI';
  if (name === 'codex') return 'Codex CLI';
  if (name === 'fake') return 'local demo, no model calls';
  const p = config.providers[name];
  return p ? plainText(redactUrl(p.baseUrl)) : '';
}

/** Where a key would come from, as a value; never the key. */
export function keyState(env: string | undefined): { text: string; short: string; tone: Tone; missing: boolean } {
  if (!env) return { text: 'not needed', short: 'not needed', tone: 'muted', missing: false };
  const source = keySource(env);
  if (source === 'environment') return { text: `env ${env}`, short: 'environment', tone: 'ok', missing: false };
  if (source === 'keys file') return { text: 'keys file', short: 'keys file', tone: 'ok', missing: false };
  if (source === 'unreadable') return { text: 'keys file unreadable', short: 'unreadable', tone: 'bad', missing: true };
  return { text: `missing (${env})`, short: 'missing', tone: 'bad', missing: true };
}


export function homePath(p: string): string {
  const home = homedir();
  return home && p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p;
}

/** The message of anything thrown, as one sentence fit for a toast. */
export function friendly(e: unknown): string {
  const text = plainText(e instanceof Error ? e.message : String(e)).trim() || 'Something went wrong.';
  return text[0]!.toUpperCase() + text.slice(1);
}

export function modelIdError(v: string): string | undefined {
  return !v ? 'Model ID is empty' : /[\s\p{Cc}]/u.test(v) ? 'No spaces or control characters' : undefined;
}

/**
 * Why talking to an endpoint failed, as a few words: fetch only says "fetch failed" and hides the reason
 * (connection refused, a name that does not resolve, a timeout) in its cause. No advice: what to check
 * is in help. The provider's key is cut out should it ever appear.
 */
export function endpointError(e: unknown, provider: ApiConfig): string {
  const err = e as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | undefined;
  const message = plainText(typeof err?.message === 'string' ? err.message : String(e)).trim();
  const code = typeof err?.cause?.code === 'string' ? err.cause.code : '';
  const causeText = typeof err?.cause?.message === 'string' ? plainText(err.cause.message) : '';
  let where = 'the endpoint';
  try { where = new URL(provider.baseUrl).host || where; } catch { /* an invalid URL is caught before asking */ }
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  let text: string;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') text = `${where}: no answer in 15 s`;
  else if (code === 'ECONNREFUSED') text = `${where}: connection refused`;
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') text = `${where}: host not found`;
  else if (code === 'ECONNRESET' || code === 'EPIPE') text = `${where}: connection closed`;
  else if (/CERT|SSL|TLS/i.test(code + causeText)) text = `${where}: certificate not accepted (${plainText(code || causeText)})`;
  else if (/bad port/i.test(causeText)) text = `${where}: port blocked by fetch`;
  else if ((status === '401' || status === '403') && provider.apiKeyEnv) text = `${where}: key refused (HTTP ${status}, ${provider.apiKeyEnv})`;
  else if (status === '401' || status === '403') text = `${where}: needs a key (HTTP ${status})`;
  else if (status === '404') text = `${where}: no model list here (HTTP 404)`;
  else if (status && status.startsWith('5')) text = `${where}: server error (HTTP ${status})`;
  else if (status === '429') text = `${where}: rate limited (HTTP 429)`;
  else text = `${message || 'no answer'}${code && !message.includes(code) ? ` (${plainText(code)})` : causeText && !message.includes(causeText) ? ` (${causeText})` : ''}`;
  const key = provider.apiKeyEnv ? readKey(provider.apiKeyEnv) : undefined;
  if (key && key.length >= 4) text = text.split(key).join('[key]');
  return text;
}

const AUTO = '\u0000auto';
const CUSTOM = '\u0000custom';

export type ModelChoice = { auto: true } | { auto: false; model: string };

export interface ChooseModelOptions {
  title: string;
  /** The backend the model is for. */
  harness: string;
  /** The endpoint to ask, e.g. a form's draft; default: the configured provider called `harness`. */
  provider?: ApiConfig;
  /** Selected and listed first. */
  current?: string;
  /** A first option that is not a model ("Automatic", "No global pin"), with a short tag. */
  auto?: { label: string; detail?: string; selected?: boolean };
  lister: ModelLister;
  /** Lists already fetched, by endpoint, so the second picker does not ask again. */
  cache: Map<string, string[]>;
}

/**
 * Loads the endpoint's list when it can be asked (a valid URL and, when it has a key variable, a key),
 * then offers the configured candidates, that list and "Enter a model ID…". A missing key or a failed
 * request is one short status line in the picker, never a dead end. Undefined when cancelled.
 */
export async function chooseModel(ctx: AppContext, o: ChooseModelOptions): Promise<ModelChoice | undefined> {
  const config = ctx.config();
  const provider = o.provider ?? config.providers[o.harness];
  const { remote, note } = await remoteModels(ctx, o.harness, provider, o.lister, o.cache);
  const models = candidateModels(config, o.harness, o.current, remote);
  const tiers = config.routing.models[o.harness] ?? {};
  const meta = (m: string): string | undefined => {
    if (m === o.current) return 'current';
    const t = (['low', 'medium', 'high'] as const).filter((x) => tiers[x] === m);
    if (t.length) return `${t.join('/')} tier`;
    return provider?.model === m ? 'default' : undefined;
  };
  const options: PickOption[] = [
    ...(o.auto ? [{ value: AUTO, label: o.auto.label, meta: o.auto.detail }] : []),
    ...models.map((m) => ({ value: `m:${m}`, label: m, meta: meta(m) })),
    { value: CUSTOM, label: 'Enter a model ID…' },
  ];
  const message = note;
  let selected = o.auto?.selected ? AUTO : o.current ? `m:${o.current}` : undefined;
  for (;;) {
    const picked = await ctx.pick({ title: o.title, message, options, selected });
    if (picked === undefined) return undefined;
    if (picked === AUTO) return { auto: true };
    if (picked !== CUSTOM) return { auto: false, model: picked.slice(2) };
    const typed = await ctx.prompt({ title: 'Model ID', value: o.current, placeholder: 'model id', validate: (v) => modelIdError(v.trim()) });
    if (typed !== undefined) return { auto: false, model: typed.trim() };
    selected = CUSTOM;
  }
}

/** The endpoint's own list, and one short status line about it for the picker. */
async function remoteModels(ctx: AppContext, name: string, provider: ApiConfig | undefined, lister: ModelLister, cache: Map<string, string[]>): Promise<{ remote: string[]; note?: string }> {
  if (!provider) return { remote: [] };
  const who = plainText(name) || 'endpoint';
  const warn = (text: string) => `${ctx.g.warn} ${who}: ${text}`;
  if (providerUrlError(provider.baseUrl)) return { remote: [], note: warn('no valid base URL') };
  if (provider.apiKeyEnv && keySource(provider.apiKeyEnv) === 'missing') return { remote: [], note: warn(`no key (${plainText(provider.apiKeyEnv)})`) };
  const id = `${provider.baseUrl}\n${provider.apiKeyEnv ?? ''}`;
  const hit = cache.get(id);
  if (hit) return { remote: hit, note: `${who}: ${hit.length} listed` };
  try {
    const got = await ctx.busy(`${who}: listing models`, () => Promise.resolve().then(() => lister(provider)));
    const list = (Array.isArray(got) ? got : []).filter((m): m is string => typeof m === 'string' && !modelIdError(m));
    cache.set(id, list);
    return { remote: list, note: list.length ? `${who}: ${list.length} listed` : warn('none listed') };
  } catch (e) {
    return { remote: [], note: warn(endpointError(e, provider)) };
  }
}

export { redactUrl };
