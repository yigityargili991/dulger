// /provider: define an OpenAI-style backend from the prompt: endpoint, key, then a model picked from
// what the endpoint reports. Anything about to run on a provider without its key asks for it first.
//
// The headless provider API sits underneath: summaries, the known endpoints, validation, and a typed
// define that writes session.overrides.providers. Keys themselves are stored by keys.ts, never here.
import { BUILTIN_HARNESSES, PROVIDER_DEFAULTS, harnessNames, type ApiConfig, type Config } from './config.ts';
import { CliError } from './errors.ts';
import { keySource, keysFile, storeKey } from './keys.ts';
import { listModels } from './adapters/models.ts';
import { sessionConfig } from './replModels.ts';
import { ask, askSecret } from './ui/prompt.ts';
import { bold, dim, green, yellow } from './ui/ansi.ts';
import type { Session } from './repl.ts';

export interface Prompts {
  ask(question: string): Promise<string | undefined>;
  askSecret(question: string): Promise<string | undefined>;
  say(line: string): void;
  models(provider: ApiConfig): Promise<string[]>;
}

export const terminalPrompts: Prompts = { ask, askSecret, say: (l) => console.log(l), models: listModels };

/** The endpoints /provider knows a default base URL for. */
export const KNOWN_PROVIDER_URLS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com', ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1', groq: 'https://api.groq.com/openai/v1', together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1', fireworks: 'https://api.fireworks.ai/inference/v1',
};

/** The endpoints /provider has a default URL for, so the prompt can offer them as it is typed. */
export const KNOWN_PROVIDERS: string[] = Object.keys(KNOWN_PROVIDER_URLS);

/** Where a key would come from right now: the environment wins over the user's keys file. */
export type KeySource = ReturnType<typeof keySource>;

export interface ProviderSummary {
  name: string;
  baseUrl: string;
  /** Absent: the provider has no model yet, and a role on it needs one. */
  model?: string;
  /** The variable its key is read from; absent for a provider without a key (ollama). */
  apiKeyEnv?: string;
  /** Present exactly when apiKeyEnv is. */
  keySource?: KeySource;
}

function summarize(name: string, p: ApiConfig): ProviderSummary {
  return { name, baseUrl: p.baseUrl, model: p.model, apiKeyEnv: p.apiKeyEnv, keySource: p.apiKeyEnv ? keySource(p.apiKeyEnv) : undefined };
}

/** Every configured provider, in config order. Reveals no key, only where it would come from. */
export function providerSummaries(config: Pick<Config, 'providers'>): ProviderSummary[] {
  return Object.entries(config.providers).flatMap(([name, p]) => (p ? [summarize(name, p)] : []));
}

/** The variable a new provider's key is read from: <NAME>_API_KEY, none for ollama. */
export function defaultKeyEnv(name: string): string | undefined {
  return name === 'ollama' ? undefined : `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/** Why `name` cannot be a provider, or undefined when it can. */
export function providerNameError(name: string): string | undefined {
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) return `provider names are letters, digits, - and _: ${JSON.stringify(name)}`;
  if (BUILTIN_HARNESSES.includes(name)) return `${name} is a CLI backend and needs no provider entry`;
  return undefined;
}

/**
 * Why `url` cannot be a provider's base URL, or undefined when it can. It is saved into a
 * config file, so credentials, queries and fragments are refused (the key goes in its variable instead).
 */
export function providerUrlError(url: string): string | undefined {
  if (!/^https?:\/\//.test(url)) return 'the base URL must start with http:// or https://';
  let parsed: URL;
  try { parsed = new URL(url); } catch { return `the base URL is not a valid URL: ${JSON.stringify(url)}`; }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return 'the base URL must not contain credentials, a query or a fragment; the key goes in its environment variable';
  return undefined;
}

function keyEnvError(env: string | undefined): string | undefined {
  return env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)
    ? `the key variable must be an environment variable name (letters, digits and _, not starting with a digit): ${JSON.stringify(env)}`
    : undefined;
}

function modelError(model: string | undefined): string | undefined {
  return model && /[\s\p{Cc}]/u.test(model) ? 'model IDs cannot contain spaces or control characters' : undefined;
}

/** A provider entry as a form fills it in: undefined apiKeyEnv means no key, undefined (or empty) model means none yet. */
export interface ProviderInput { baseUrl: string; apiKeyEnv?: string; model?: string }

/**
 * Define `name`, or replace an existing entry's base URL, key variable and model; its other fields
 * (maxTokens, timeouts, ...) are kept. Session only until saveSessionConfig, which writes the endpoint and
 * the variable's name, never the key. Throws CliError for a bad name, URL, key variable or model ID.
 */
export function defineProvider(session: Session, config: Config, name: string, input: ProviderInput): ProviderSummary {
  const problem = providerNameError(name) ?? providerUrlError(input.baseUrl) ?? keyEnvError(input.apiKeyEnv) ?? modelError(input.model);
  if (problem) throw new CliError(problem);
  const entry: ApiConfig = { ...PROVIDER_DEFAULTS, ...config.providers[name], baseUrl: input.baseUrl, apiKeyEnv: input.apiKeyEnv, model: input.model || undefined };
  session.overrides.providers = { ...session.overrides.providers, [name]: entry };
  return summarize(name, entry);
}

/** Store the key for a configured provider in the user's keys file (keys.ts); returns that file. Throws CliError when there is nowhere to put it. */
export function storeProviderKey(config: Pick<Config, 'providers'>, name: string, key: string): string {
  const provider = config.providers[name];
  if (!provider) throw new CliError(`${name} is not a configured provider`);
  if (!provider.apiKeyEnv) throw new CliError(`${name} has no key variable`);
  if (!key.trim()) throw new CliError('the key is empty');
  return storeKey(provider.apiKeyEnv, key.trim());
}

/** `/provider` lists, `/provider <name>` defines or edits one, `/provider <name> key` re-enters its key, `/provider <name> model` re-picks its model. */
export async function providerCommand(repoRoot: string, session: Session, args: string[], prompts: Prompts = terminalPrompts): Promise<string[]> {
  const [name, sub] = args;
  const config = sessionConfig(repoRoot, session);
  if (!name) return listProviders(config);
  const badName = providerNameError(name);
  if (badName) return [badName];
  const current = config.providers[name];
  if (sub === 'key') {
    if (!current?.apiKeyEnv) return [`${name} has no key variable; run /provider ${name} first`];
    return enterKey(current.apiKeyEnv, prompts);
  }
  if (sub === 'model') {
    if (!current) return [`${name} is not configured; run /provider ${name} first`];
    const model = await chooseModel(current, prompts);
    if (model === undefined) return ['cancelled'];
    try { defineProvider(session, config, name, { baseUrl: current.baseUrl, apiKeyEnv: current.apiKeyEnv, model }); }
    catch (err) { if (err instanceof CliError) return [err.message]; throw err; }
    return [green(`${name}: model ${model}`), dim('session only until /config save')];
  }
  if (sub) return ['use /provider, /provider <name>, /provider <name> key, or /provider <name> model'];

  // An older config can carry a URL with credentials: it is neither shown as the default nor kept by Enter.
  const kept = current?.baseUrl && !providerUrlError(current.baseUrl) ? current.baseUrl : undefined;
  const baseUrl = await answer(prompts, 'Base URL (the part before /chat/completions)', kept ?? KNOWN_PROVIDER_URLS[name]);
  if (baseUrl === undefined) return ['cancelled'];
  const badUrl = providerUrlError(baseUrl);
  if (badUrl) return [badUrl];
  const apiKeyEnv = current?.apiKeyEnv ?? defaultKeyEnv(name);
  const out: string[] = [];
  if (apiKeyEnv && keySource(apiKeyEnv) === 'missing') {
    const stored = await enterKey(apiKeyEnv, prompts);
    out.push(...stored);
    if (keySource(apiKeyEnv) === 'missing') return [...out, yellow(`${name} needs its key before its models can be listed; run /provider ${name} again once you have it`)];
  }
  const draft: ApiConfig = { ...PROVIDER_DEFAULTS, ...current, baseUrl, apiKeyEnv };
  const model = await chooseModel(draft, prompts);
  if (model === undefined) return [...out, 'cancelled'];
  let p: ProviderSummary;
  try { p = defineProvider(session, config, name, { baseUrl, apiKeyEnv, model }); }
  catch (err) { if (err instanceof CliError) return [...out, err.message]; throw err; }
  out.push(green(`${name}: ${redactUrl(p.baseUrl)} · ${p.model ?? dim('(model required)')} · ${p.apiKeyEnv ? `key in $${p.apiKeyEnv} (${p.keySource})` : 'no key'}`));
  out.push(dim('session only until /config save, which writes the endpoint and the variable name (never the key) to your config file'));
  out.push(dim(`use it with /harness ${name}, or /model <role> ${name}`));
  return out;
}

/**
 * Before a run: every provider a role will use must have its key. In a terminal the key is asked for
 * on the spot; otherwise the run fails later with the variable's name.
 */
export async function ensureKeys(config: Config, prompts: Prompts = terminalPrompts): Promise<void> {
  const used = new Set([config.harness, ...Object.values(config.roles).map((r) => r?.harness).filter((h): h is string => Boolean(h))]);
  for (const name of used) {
    const provider = config.providers[name];
    if (!provider?.apiKeyEnv || keySource(provider.apiKeyEnv) !== 'missing') continue;
    if (!harnessNames(config).includes(name)) continue;
    prompts.say(yellow(`${name} needs $${provider.apiKeyEnv}, which is not set.`));
    for (const line of await enterKey(provider.apiKeyEnv, prompts)) prompts.say(line);
  }
}

async function answer(prompts: Prompts, question: string, fallback: string | undefined): Promise<string | undefined> {
  const line = await prompts.ask(`${question}${fallback ? ` ${dim(`[${fallback}]`)}` : ''}: `);
  if (line === undefined) return undefined;
  return line.trim() || fallback || '';
}

async function enterKey(envName: string, prompts: Prompts): Promise<string[]> {
  const key = await prompts.askSecret(`API key for $${envName} ${dim('(not echoed; stored in ' + keysFile() + ', Enter to skip)')}: `);
  if (!key?.trim()) return [yellow(`no key stored; export ${envName} or run /provider <name> key before a run`)];
  return [green(`key stored in ${storeKey(envName, key.trim())} (mode 600)`)];
}

const PAGE = 20;

/** Pick from the endpoint's model list by number, exact id, or a word that narrows the list; typed ids are accepted when the list cannot be fetched. */
async function chooseModel(provider: ApiConfig, prompts: Prompts): Promise<string | undefined> {
  let models: string[];
  try {
    models = await prompts.models(provider);
  } catch (err) {
    prompts.say(yellow(`could not list models (${(err as Error).message}); type the model id`));
    return answer(prompts, 'Model', provider.model);
  }
  let shown = models;
  for (;;) {
    const page = shown.slice(0, PAGE);
    prompts.say(page.map((m, i) => `  ${String(i + 1).padStart(2)}  ${m}${m === provider.model ? dim('  (current)') : ''}`).join('\n'));
    if (shown.length > PAGE) prompts.say(dim(`  … ${shown.length - PAGE} more; type part of a name to narrow the list`));
    const line = await prompts.ask(`Model ${dim(`[number or name${provider.model ? `; Enter keeps ${provider.model}` : ''}]`)}: `);
    if (line === undefined) return undefined;
    const text = line.trim();
    if (!text) { if (provider.model) return provider.model; continue; }
    if (/^\d+$/.test(text) && page[Number(text) - 1]) return page[Number(text) - 1];
    if (models.includes(text)) return text;
    const narrowed = models.filter((m) => m.toLowerCase().includes(text.toLowerCase()));
    if (narrowed.length === 1) return narrowed[0];
    if (!narrowed.length) { prompts.say(yellow(`no model matches ${JSON.stringify(text)}`)); continue; }
    shown = narrowed;
  }
}

/**
 * A provider URL as it may be shown: credentials in it (`https://user:secret@host`) are masked. New
 * URLs with credentials are refused, but an older config file can still carry one.
 */
export function redactUrl(url: string): string {
  return url.replace(/^([A-Za-z][\w+.-]*:\/\/)[^/@]*@/, '$1•••@');
}

function listProviders(config: Pick<Config, 'providers'>): string[] {
  const rows = providerSummaries(config).map((p) => {
    const key = p.apiKeyEnv ? `$${p.apiKeyEnv} (${p.keySource})` : 'no key';
    return `  ${bold(p.name.padEnd(11))} ${redactUrl(p.baseUrl)} · ${p.model ?? dim('(model required)')} · ${key}`;
  });
  return ['providers (/provider <name> defines or edits one, /provider <name> model re-picks its model):', ...rows];
}
