// REPL model choices are a session layer above CLI/global pins and repository settings.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, roleConfig, STATE_DIR, type Config, type RoleConfig } from './config.ts';
import { CliError } from './commands.ts';
import { plainText } from './tui/text.ts';
import type { Session } from './repl.ts';
import type { AgentRole, HarnessName, ModelTier } from './types.ts';

export const MODEL_ROLES: AgentRole[] = ['planner', 'worker', 'checker', 'docs'];
const HARNESSES: HarnessName[] = ['claude', 'codex', 'deepseek', 'ollama', 'openai', 'fake'];
const ALIASES: Record<string, { harness: HarnessName; model: string }> = {
  fable: { harness: 'claude', model: DEFAULT_CONFIG.routing.models.claude!.high! },
  opus: { harness: 'claude', model: 'opus' },
  sonnet: { harness: 'claude', model: 'sonnet' },
  haiku: { harness: 'claude', model: 'haiku' },
  astra: { harness: 'codex', model: DEFAULT_CONFIG.routing.models.codex!.high! },
  sol: { harness: 'codex', model: DEFAULT_CONFIG.routing.models.codex!.medium! },
  luna: { harness: 'codex', model: DEFAULT_CONFIG.routing.models.codex!.low! },
};

export function sessionConfig(repoRoot: string, session: Session): Config {
  const config = loadConfig(repoRoot, session.overrides);
  if (session.model) {
    for (const role of MODEL_ROLES) config.roles[role] = { ...config.roles[role], model: session.model };
  }
  for (const role of MODEL_ROLES) {
    const choice = session.modelRoles?.[role];
    if (choice === 'reset') {
      const repo = loadConfig(repoRoot);
      config.roles[role] = { ...repo.roles[role], harness: repo.roles[role]?.harness ?? repo.harness };
    } else if (choice) {
      config.roles[role] = { ...config.roles[role], ...choice };
    }
  }
  return config;
}

type RoleChoice = RoleConfig | 'auto' | 'reset';

type ModelCommand =
  | { kind: 'show'; role?: AgentRole }
  | { kind: 'global'; model?: string }
  | { kind: 'role'; role: AgentRole; choice: RoleChoice };

function parseRoleChoice(words: string[]): RoleChoice {
  const [name, model, ...extra] = words;
  if (words.length === 1 && (name === 'auto' || name === 'reset')) return name;
  if (!name || extra.length) throw new CliError('use /model <role> <harness> [model|auto]');
  if (HARNESSES.includes(name as HarnessName)) return { harness: name as HarnessName, model: model === 'auto' ? undefined : model };
  if (!model && Object.hasOwn(ALIASES, name)) return { ...ALIASES[name]! };
  const known = !model && Object.values(ALIASES).find((alias) => alias.model === name);
  if (known) return { ...known };
  throw new CliError('choose fable, opus, sonnet, haiku, astra, sol, luna, or an explicit <harness> <model> pair');
}

/** /model, /model <role>, /model <role> <choice>, and the existing global /model <name>|off. */
export function configureModel(repoRoot: string, session: Session, input: string): string {
  const command = parseModelCommand(input);
  applyModelCommand(repoRoot, session, command);
  return modelOverview(repoRoot, session, command.kind === 'global' ? undefined : command.role);
}

/** Parse and validate the complete input before touching session state. */
function parseModelCommand(input: string): ModelCommand {
  const [target, ...args] = input.trim().split(/\s+/).filter(Boolean);
  if (!target) return { kind: 'show' };

  const role = MODEL_ROLES.find((role) => role === target);
  if (!role) {
    if (args.length) throw new CliError(`unknown model role; choose ${MODEL_ROLES.join(', ')}`);
    return { kind: 'global', model: target === 'off' ? undefined : target };
  }

  if (!args.length) return { kind: 'show', role };
  return { kind: 'role', role, choice: parseRoleChoice(args) };
}

function applyModelCommand(repoRoot: string, session: Session, command: ModelCommand): void {
  if (command.kind === 'show') return;
  if (command.kind === 'global') {
    session.model = command.model;
    return;
  }

  let choice: RoleConfig | 'reset';
  if (command.choice === 'auto') {
    const current = roleConfig(sessionConfig(repoRoot, session), command.role);
    choice = { harness: current.harness, model: undefined };
  } else {
    choice = command.choice;
  }
  session.modelRoles = { ...session.modelRoles, [command.role]: choice };
}

export function modelOverview(repoRoot: string, session: Session, onlyRole?: AgentRole): string {
  const config = sessionConfig(repoRoot, session);
  const roles = onlyRole ? [onlyRole] : MODEL_ROLES;
  const summaries = roles.map((role) => describeRoleModel(config, session, role));
  return [modelOverviewHeader(session.model), ...summaries.flatMap(formatRoleModel)].join('\n');
}

interface RoleModelSummary {
  role: AgentRole;
  harness: HarnessName;
  model: string;
  mode: 'pinned' | 'auto tiers' | 'provider/harness default';
  source: string;
  disabled: boolean;
  tiers: Array<{ tier: ModelTier; model: string }>;
  missingKeyEnv?: string;
}

function describeRoleModel(config: Config, session: Session, role: AgentRole): RoleModelSummary {
  const resolved = roleConfig(config, role);
  const provider = config.providers[resolved.harness];
  const tierModels = config.routing.enabled ? config.routing.models[resolved.harness] : undefined;
  const pinned = Boolean(config.roles[role]?.model);
  let mode: RoleModelSummary['mode'] = 'provider/harness default';
  if (pinned) mode = 'pinned';
  else if (tierModels) mode = 'auto tiers';

  const tiers: RoleModelSummary['tiers'] = [];
  if (!pinned && tierModels) {
    for (const tier of ['low', 'medium', 'high'] as const) {
      tiers.push({ tier, model: tierModels[tier] ?? provider?.model ?? '(harness default)' });
    }
  }

  return {
    role,
    harness: resolved.harness,
    model: resolved.model ?? (provider ? '(model required)' : '(harness default)'),
    mode,
    source: roleModelSource(session, role),
    disabled: role === 'docs' && !config.docs,
    tiers,
    missingKeyEnv: provider?.apiKeyEnv && !process.env[provider.apiKeyEnv] ? provider.apiKeyEnv : undefined,
  };
}

function roleModelSource(session: Session, role: AgentRole): string {
  const selected = session.modelRoles?.[role];
  if (selected === 'reset') return 'repository reset';
  if (selected) return 'session role';
  if (session.model) return 'global pin';
  return 'repository/default';
}

function modelOverviewHeader(globalModel?: string): string {
  if (globalModel) return `global model fallback: ${plainText(globalModel)} (explicit role choices and resets take precedence)`;
  return 'models (role choices take precedence over global pins; /config save persists settings)';
}

function formatRoleModel(summary: RoleModelSummary): string[] {
  const fields = [
    `${summary.role.padEnd(7)} ${summary.harness} / ${plainText(summary.model)}`,
    summary.mode,
    summary.source,
  ];
  if (summary.disabled) fields.push('disabled');
  const lines = [`  ${fields.join(' · ')}`];

  if (summary.tiers.length) {
    const tiers = summary.tiers.map(({ tier, model }) => `${tier}: ${plainText(model)}`);
    lines.push(`          ${tiers.join(' · ')}`);
  }
  if (summary.missingKeyEnv) {
    lines.push(`          set ${plainText(summary.missingKeyEnv)} in your environment before running`);
  }
  return lines;
}

/** Merge only explicit session settings, keeping unrelated/unknown repository fields. */
export function saveSessionConfig(repoRoot: string, session: Session): string {
  const dir = join(repoRoot, STATE_DIR);
  const path = join(dir, 'config.json');
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  if (!isObject(existing)) throw new CliError('config.json must contain a JSON object');
  const effective = sessionConfig(repoRoot, session);
  const patch: Partial<Config> = { ...session.overrides, roles: { ...session.overrides.roles } };
  for (const role of MODEL_ROLES) {
    if (session.model || session.modelRoles?.[role] !== undefined) patch.roles![role] = effective.roles[role] ?? {};
  }
  // Role objects replace their old values so `auto` can remove a previously saved model pin.
  const merged = merge(existing, patch);
  merged.roles = { ...(isObject(existing.roles) ? existing.roles : {}), ...patch.roles };
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `config.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  return path;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base: Record<string, unknown>, patch: object): Record<string, unknown> {
  const entries = Object.entries(patch).map(([key, value]) => [
    key, isObject(base[key]) && isObject(value) ? merge(base[key], value) : value,
  ]);
  return { ...base, ...Object.fromEntries(entries) };
}
