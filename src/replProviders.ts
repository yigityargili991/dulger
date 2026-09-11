// /provider: define an OpenAI-style backend from the prompt, key included, without editing JSON.
import { PROVIDER_DEFAULTS, type ApiConfig } from './config.ts';
import { keySource, keysFile, storeKey } from './keys.ts';
import { sessionConfig } from './replModels.ts';
import { ask, askSecret } from './ui/prompt.ts';
import { bold, dim, green, yellow } from './ui/ansi.ts';
import type { Session } from './repl.ts';

export interface Prompts {
  ask(question: string): Promise<string | undefined>;
  askSecret(question: string): Promise<string | undefined>;
}

const KNOWN_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com', ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1', groq: 'https://api.groq.com/openai/v1', together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1', fireworks: 'https://api.fireworks.ai/inference/v1',
};

/** `/provider` lists, `/provider <name>` defines or edits one, `/provider <name> key` only re-enters its key. */
export async function providerCommand(repoRoot: string, session: Session, args: string[], prompts: Prompts = { ask, askSecret }): Promise<string[]> {
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
  if (sub) return [`use /provider, /provider <name>, or /provider <name> key`];

  const baseUrl = await answer(prompts, 'Base URL (the part before /chat/completions)', current?.baseUrl ?? KNOWN_URLS[name]);
  if (baseUrl === undefined) return ['cancelled'];
  if (!/^https?:\/\//.test(baseUrl)) return ['the base URL must start with http:// or https://'];
  const suggested = current?.apiKeyEnv ?? (name === 'ollama' ? '' : `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`);
  const apiKeyEnv = await answer(prompts, 'Environment variable holding the API key (empty for none)', suggested);
  if (apiKeyEnv === undefined) return ['cancelled'];
  const model = await answer(prompts, 'Default model', current?.model ?? '');
  if (model === undefined) return ['cancelled'];

  const provider: ApiConfig = { ...PROVIDER_DEFAULTS, ...current, baseUrl, apiKeyEnv: apiKeyEnv || undefined, model: model || undefined };
  session.overrides.providers = { ...session.overrides.providers, [name]: provider };
  const out = [green(`${name}: ${baseUrl}${model ? ` · ${model}` : ''}${apiKeyEnv ? ` · key in $${apiKeyEnv}` : ' · no key'}`)];
  if (apiKeyEnv && keySource(apiKeyEnv) === 'missing') out.push(...await enterKey(apiKeyEnv, prompts));
  out.push(dim(`session only until /config save, which writes the endpoint and the variable name (never the key) to .dulger/config.json`));
  out.push(dim(`use it with /harness ${name}, or /model <role> ${name} <model>`));
  return out;
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

function listProviders(providers: Partial<Record<string, ApiConfig>>): string[] {
  const rows = Object.entries(providers).map(([name, p]) => {
    if (!p) return '';
    const key = p.apiKeyEnv ? `$${p.apiKeyEnv} (${keySource(p.apiKeyEnv)})` : 'no key';
    return `  ${bold(name.padEnd(11))} ${p.baseUrl} · ${p.model ?? dim('(model required)')} · ${key}`;
  }).filter(Boolean);
  return ['providers (/provider <name> defines or edits one):', ...rows];
}
