// /provider: define an OpenAI-style backend from the prompt: endpoint, key, then a model picked from
// what the endpoint reports. Anything about to run on a provider without its key asks for it first.
import { PROVIDER_DEFAULTS, harnessNames, type ApiConfig, type Config } from './config.ts';
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

const KNOWN_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com', ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1', groq: 'https://api.groq.com/openai/v1', together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1', fireworks: 'https://api.fireworks.ai/inference/v1',
};

/** The endpoints /provider has a default URL for, so the prompt can offer them as it is typed. */
export const KNOWN_PROVIDERS: string[] = Object.keys(KNOWN_URLS);

/** `/provider` lists, `/provider <name>` defines or edits one, `/provider <name> key` re-enters its key, `/provider <name> model` re-picks its model. */
export async function providerCommand(repoRoot: string, session: Session, args: string[], prompts: Prompts = terminalPrompts): Promise<string[]> {
  const [name, sub] = args;
  const config = sessionConfig(repoRoot, session);
  if (!name) return listProviders(config.providers);
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) return [`provider names are letters, digits, - and _: ${JSON.stringify(name)}`];
  if (['claude', 'codex', 'fake'].includes(name)) return [`${name} is a CLI backend and needs no provider entry`];
  const current = config.providers[name];
  if (sub === 'key') {
    if (!current?.apiKeyEnv) return [`${name} has no key variable; run /provider ${name} first`];
    return enterKey(current.apiKeyEnv, prompts);
  }
  if (sub === 'model') {
    if (!current) return [`${name} is not configured; run /provider ${name} first`];
    const model = await chooseModel(current, prompts);
    if (model === undefined) return ['cancelled'];
    session.overrides.providers = { ...session.overrides.providers, [name]: { ...current, model } };
    return [green(`${name}: model ${model}`), dim('session only until /config save')];
  }
  if (sub) return ['use /provider, /provider <name>, /provider <name> key, or /provider <name> model'];

  const baseUrl = await answer(prompts, 'Base URL (the part before /chat/completions)', current?.baseUrl ?? KNOWN_URLS[name]);
  if (baseUrl === undefined) return ['cancelled'];
  if (!/^https?:\/\//.test(baseUrl)) return ['the base URL must start with http:// or https://'];
  const apiKeyEnv = current?.apiKeyEnv ?? (name === 'ollama' ? undefined : `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`);
  const out: string[] = [];
  if (apiKeyEnv && keySource(apiKeyEnv) === 'missing') {
    const stored = await enterKey(apiKeyEnv, prompts);
    out.push(...stored);
    if (keySource(apiKeyEnv) === 'missing') return [...out, yellow(`${name} needs its key before its models can be listed; run /provider ${name} again once you have it`)];
  }
  const draft: ApiConfig = { ...PROVIDER_DEFAULTS, ...current, baseUrl, apiKeyEnv };
  const model = await chooseModel(draft, prompts);
  if (model === undefined) return [...out, 'cancelled'];
  session.overrides.providers = { ...session.overrides.providers, [name]: { ...draft, model: model || undefined } };
  out.push(green(`${name}: ${baseUrl} · ${model || dim('(model required)')} · ${apiKeyEnv ? `key in $${apiKeyEnv} (${keySource(apiKeyEnv)})` : 'no key'}`));
  out.push(dim('session only until /config save, which writes the endpoint and the variable name (never the key) to .dulger/config.json'));
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

function listProviders(providers: Partial<Record<string, ApiConfig>>): string[] {
  const rows = Object.entries(providers).map(([name, p]) => {
    if (!p) return '';
    const key = p.apiKeyEnv ? `$${p.apiKeyEnv} (${keySource(p.apiKeyEnv)})` : 'no key';
    return `  ${bold(name.padEnd(11))} ${p.baseUrl} · ${p.model ?? dim('(model required)')} · ${key}`;
  }).filter(Boolean);
  return ['providers (/provider <name> defines or edits one, /provider <name> model re-picks its model):', ...rows];
}
