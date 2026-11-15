// REPL model choices are a session layer above CLI/global pins and repository settings.
//
// The headless model API: every role's resolved backend and model (describeRoleModel), typed setters
// for a role and the global pin, the model-set presets, the models to offer for a backend, and what
// keeps a setup from starting. Setters take the session's effective config, sessionConfig(repoRoot,
// session), and throw CliError with a message a form can show.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, harnessNames, loadConfig, roleConfig, STATE_DIR, USER_KEYS, userSettings, type Config } from './config.ts';
import { CliError } from './errors.ts';
import { plainText } from './tui/text.ts';
import { keySource } from './keys.ts';
import { userConfigFile } from './sandbox.ts';
import type { Session } from './repl.ts';
import type { AgentRole, HarnessName, ModelTier } from './types.ts';

export const MODEL_ROLES: AgentRole[] = ['planner', 'worker', 'checker', 'docs', 'reporter'];
const ALIASES: Record<string, { harness: HarnessName; model: string }> = {
  fable: { harness: 'claude', model: DEFAULT_CONFIG.routing.models.claude!.high! },
  opus: { harness: 'claude', model: 'opus' },
  sonnet: { harness: 'claude', model: 'sonnet' },
  haiku: { harness: 'claude', model: 'haiku' },
  astra: { harness: 'codex', model: DEFAULT_CONFIG.routing.models.codex!.high! },
  sol: { harness: 'codex', model: DEFAULT_CONFIG.routing.models.codex!.medium! },
  luna: { harness: 'codex', model: DEFAULT_CONFIG.routing.models.codex!.low! },
};

/** The shorthand names /model takes, in the order /help lists them, with what each one resolves to. */
export const MODEL_ALIASES: Array<{ name: string; harness: HarnessName; model: string }> =
  Object.entries(ALIASES).map(([name, alias]) => ({ name, ...alias }));

export function sessionConfig(repoRoot: string, session: Session): Config {
  const config = loadConfig(repoRoot, session.overrides, session.sandbox);
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

type RoleChoice = { harness: HarnessName; model?: string } | 'auto' | 'reset';

type ModelCommand =
  | { kind: 'show'; role?: AgentRole }
  | { kind: 'global'; model?: string }
  | { kind: 'role'; role: AgentRole; choice: RoleChoice };

function assertModelId(model: string): void {
  if (!model || /[\s\p{Cc}]/u.test(model)) throw new CliError('model IDs cannot be empty or contain spaces or control characters');
}

function assertRole(role: AgentRole): void {
  if (!MODEL_ROLES.includes(role)) throw new CliError(`unknown model role; choose ${MODEL_ROLES.join(', ')}`);
}

/** Run `role` on `harness` with `model` pinned, or routed / on the backend's default model when `model` is omitted. */
export function setRoleModel(session: Session, config: Config, role: AgentRole, harness: HarnessName, model?: string): void {
  assertRole(role);
  if (!harnessNames(config).includes(harness)) throw new CliError(`harness is one of ${harnessNames(config).join(', ')}`);
  if (model !== undefined) assertModelId(model);
  session.modelRoles = { ...session.modelRoles, [role]: { harness, model } };
}

/** Keep the role's current backend and drop its model pin, so routing or the backend's default picks (/model <role> auto). */
export function setRoleAuto(session: Session, config: Config, role: AgentRole): void {
  assertRole(role);
  setRoleModel(session, config, role, roleConfig(config, role).harness);
}

/** Give `role` the repository's backend and model again, over a global pin (/model <role> reset). */
export function resetRoleModel(session: Session, role: AgentRole): void {
  assertRole(role);
  session.modelRoles = { ...session.modelRoles, [role]: 'reset' };
}

/** Pin every role without a choice of its own to `model`; undefined drops the pin (/model <name>|off). */
export function setGlobalModel(session: Session, model: string | undefined): void {
  if (model !== undefined) assertModelId(model);
  session.model = model;
}

function parseRoleChoice(words: string[], harnesses: string[]): RoleChoice {
  const [name, model, ...extra] = words;
  if (words.length === 1 && (name === 'auto' || name === 'reset')) return name;
  if (!name || extra.length) throw new CliError('use /model <role> <harness> [model|auto]');
  if (harnesses.includes(name)) return { harness: name as HarnessName, model: model === 'auto' ? undefined : model };
  if (!model && Object.hasOwn(ALIASES, name)) return { ...ALIASES[name]! };
  const known = !model && Object.values(ALIASES).find((alias) => alias.model === name);
  if (known) return { ...known };
  throw new CliError('choose fable, opus, sonnet, haiku, astra, sol, luna, or an explicit <harness> <model> pair');
}

/** /model, /model <role>, /model <role> <choice>, and the existing global /model <name>|off. */
export function configureModel(repoRoot: string, session: Session, input: string): string {
  const config = sessionConfig(repoRoot, session);
  const command = parseModelCommand(input, harnessNames(config));
  applyModelCommand(session, config, command);
  return modelOverview(repoRoot, session, command.kind === 'global' ? undefined : command.role);
}

/** Parse and validate the complete input before touching session state. */
function parseModelCommand(input: string, harnesses: string[]): ModelCommand {
  const [target, ...args] = input.trim().split(/\s+/).filter(Boolean);
  if (!target) return { kind: 'show' };

  const role = MODEL_ROLES.find((role) => role === target);
  if (!role) {
    if (args.length) throw new CliError(`unknown model role; choose ${MODEL_ROLES.join(', ')}`);
    return { kind: 'global', model: target === 'off' ? undefined : target };
  }

  if (!args.length) return { kind: 'show', role };
  return { kind: 'role', role, choice: parseRoleChoice(args, harnesses) };
}

function applyModelCommand(session: Session, config: Config, command: ModelCommand): void {
  if (command.kind === 'show') return;
  if (command.kind === 'global') { setGlobalModel(session, command.model); return; }
  const { role, choice } = command;
  if (choice === 'auto') setRoleAuto(session, config, role);
  else if (choice === 'reset') resetRoleModel(session, role);
  else setRoleModel(session, config, role, choice.harness, choice.model);
}

export function modelOverview(repoRoot: string, session: Session, onlyRole?: AgentRole): string {
  const config = sessionConfig(repoRoot, session);
  const roles = onlyRole ? [onlyRole] : MODEL_ROLES;
  const summaries = roles.map((role) => describeRoleModel(config, session, role));
  return [modelOverviewHeader(session.model), ...summaries.flatMap(formatRoleModel)].join('\n');
}

/** Where a role's model choice comes from: its own session choice, a session reset, the global pin, or the repository. */
export type RoleModelSource = 'session role' | 'repository reset' | 'global pin' | 'repository/default';

/** One role as it would run now. */
export interface RoleModelSummary {
  role: AgentRole;
  harness: HarnessName;
  /** The resolved model, or "(model required)" on a provider without one, or "(harness default)". */
  model: string;
  mode: 'pinned' | 'auto tiers' | 'provider/harness default';
  source: RoleModelSource;
  /** docs with documentation off, the reporter with progress notes off. */
  disabled: boolean;
  /** The low/medium/high models routing picks from; empty when the role is pinned or routing does not apply. */
  tiers: Array<{ tier: ModelTier; model: string }>;
  /** The provider's key variable when no key is set for it (environment or keys file). */
  missingKeyEnv?: string;
}

/** `config` is the session's effective config, sessionConfig(repoRoot, session). */
export function describeRoleModel(config: Config, session: Session, role: AgentRole): RoleModelSummary {
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
    disabled: (role === 'docs' && !config.docs) || (role === 'reporter' && !(config.progressIntervalSec > 0)),
    tiers,
    missingKeyEnv: provider?.apiKeyEnv && keySource(provider.apiKeyEnv) === 'missing' ? provider.apiKeyEnv : undefined,
  };
}

function roleModelSource(session: Session, role: AgentRole): RoleModelSource {
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
    `${summary.role.padEnd(8)} ${summary.harness} / ${plainText(summary.model)}`,
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
    lines.push(`          set ${plainText(summary.missingKeyEnv)} in your environment, or /provider ${plainText(summary.harness)} key, before running`);
  }
  return lines;
}

export type ModelSetName = 'auto' | 'balanced' | 'low' | 'high';
export interface ModelSet { value: ModelSetName; label: string; description: string }

/** The presets /setup offers for every role at once, in its order. */
export const MODEL_SETS: readonly ModelSet[] = [
  { value: 'auto', label: 'Automatic tiers', description: 'Planner and reviewer use high; workers follow task difficulty and escalate on retries; docs and reporter use low.' },
  { value: 'balanced', label: 'Balanced set', description: 'Pin workers to medium, planner and reviewer to high, docs and reporter to low. Ignores task difficulty.' },
  { value: 'low', label: 'Low tier for every role', description: 'Pin every role to the configured low-tier model. Ignores task difficulty and retry escalation.' },
  { value: 'high', label: 'High tier for every role', description: 'Pin every role to the configured high-tier model. Ignores task difficulty and retry escalation.' },
];

/**
 * Apply a complete set on `harness`, explicitly replacing old backend and model pins (the global pin
 * included). Throws CliError for a harness `config` cannot run or a set that is not in MODEL_SETS.
 */
export function applyModelSet(draft: Session, config: Config, harness: string, set: ModelSetName): void {
  if (!harnessNames(config).includes(harness)) throw new CliError(`harness is one of ${harnessNames(config).join(', ')}`);
  if (!MODEL_SETS.some((s) => s.value === set)) throw new CliError(`model set is one of ${MODEL_SETS.map((s) => s.value).join(', ')}`);
  draft.overrides.harness = harness;
  draft.overrides.routing = { ...config.routing, enabled: set === 'auto' };
  draft.model = undefined;
  draft.modelRoles = {};
  for (const role of MODEL_ROLES) {
    const tier: ModelTier = set === 'balanced' ? (role === 'worker' ? 'medium' : role === 'planner' || role === 'checker' ? 'high' : 'low') : set === 'high' ? 'high' : 'low';
    const model = set === 'auto' ? undefined : config.routing.models[harness]?.[tier] ?? config.providers[harness]?.model;
    draft.modelRoles[role] = { harness, model };
  }
}

/** What keeps a setup from starting: an enabled role on an API provider with no model. One readable line each. */
export function setupIssues(config: Config): string[] {
  const issues: string[] = [];
  for (const role of MODEL_ROLES) {
    if ((role === 'docs' && !config.docs) || (role === 'reporter' && config.progressIntervalSec <= 0)) continue;
    const rc = roleConfig(config, role);
    if (config.providers[rc.harness] && !rc.model) issues.push(`${role} on ${rc.harness} needs a model; choose one for all roles or edit that role.`);
  }
  return issues;
}

/**
 * The models to offer for `harness` without asking anyone: `current` first, then its routing tiers, the
 * aliases on it and its provider's model, then `remote` (what listModels(provider) returned, when it was
 * asked). No duplicates; any other model ID can still be typed.
 */
export function candidateModels(config: Config, harness: string, current?: string, remote: readonly string[] = []): string[] {
  return [...new Set([
    ...(current ? [current] : []),
    ...Object.values(config.routing.models[harness] ?? {}).filter((m): m is string => Boolean(m)),
    ...MODEL_ALIASES.filter((a) => a.harness === harness).map((a) => a.model),
    ...(config.providers[harness]?.model ? [config.providers[harness]!.model!] : []),
    ...remote,
  ])];
}

/** A role's resolved run, for deciding whether its entry really differs from the repository's. */
function roleSignature(config: Config, role: AgentRole): unknown {
  const rc = roleConfig(config, role);
  return { harness: rc.harness, model: rc.model, maxBudgetUsd: rc.maxBudgetUsd, pinned: config.roles[role]?.model };
}

/** As JSON would store it: an entry with `model: undefined` is the same as one without the key. */
function plainValue(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** A base URL fit to write into a config file: never a credential, query or fragment (the key is its variable). */
function assertSavableUrl(name: string, url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new CliError(`Provider ${name}: the base URL must not contain credentials, a query or a fragment; the key goes in its environment variable.`);
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    // A non-URL string is left to the definers' own validation; it is not a credential leak.
  }
}

type Planned = { path: string; existing: Record<string, unknown>; merged: Record<string, unknown> };
/** Top-level config keys, each with any of its fields. */
type ConfigPatch = { [K in keyof Config]?: Partial<Config[K]> };

/** `path`'s object with `patch` merged in. Role objects replace their old values so `auto` can remove a saved model pin. */
function planned(path: string, patch: ConfigPatch): Planned {
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  if (!isObject(existing)) throw new CliError('config.json must contain a JSON object');
  const merged = merge(existing, patch);
  if (patch.roles) {
    merged.roles = { ...(isObject(existing.roles) ? existing.roles : {}), ...patch.roles };
    // An empty roles object says nothing: it is not written unless the file had one already.
    if (!Object.keys(merged.roles as object).length && !Object.hasOwn(existing, 'roles')) delete merged.roles;
  }
  return { path, existing, merged };
}

/** The exact objects saveSessionConfig would write: the repository file, then the user's with the USER_KEYS. */
function plannedMerge(repoRoot: string, session: Session): [Planned, Planned] {
  const effective = sessionConfig(repoRoot, session);
  const saved = loadConfig(repoRoot);
  // The sandbox is never written into a repository; one that came in with a profile goes no further.
  const { sandbox: _never, ...overrides } = session.overrides;
  const patch: Partial<Config> = { ...overrides, roles: { ...session.overrides.roles } };
  // A role is written only when its run really differs from the saved one: an "auto" that changes
  // nothing is not persisted, so a later Backend change still moves the role.
  for (const role of MODEL_ROLES) {
    const changed = !isDeepStrictEqual(roleSignature(effective, role), roleSignature(saved, role))
      && !isDeepStrictEqual(plainValue(effective.roles[role] ?? {}), plainValue(saved.roles[role] ?? {}));
    if (changed) patch.roles![role] = effective.roles[role] ?? {};
  }
  const pick = (user: boolean) => Object.fromEntries(Object.entries(patch).filter(([k]) => (USER_KEYS as readonly string[]).includes(k) === user)) as Partial<Config>;
  const user = pick(true);
  // The user file holds in every repository, so a provider it names that only this one defines goes with it.
  const mine = userSettings();
  for (const harness of [user.harness ?? mine.harness, ...Object.values({ ...mine.roles, ...user.roles }).map((r) => r.harness)]) {
    const defined = { ...DEFAULT_CONFIG.providers, ...mine.providers, ...user.providers };
    if (harness && effective.providers[harness] && !defined[harness]) user.providers = { ...user.providers, [harness]: effective.providers[harness] };
  }
  for (const [name, provider] of Object.entries(user.providers ?? {})) {
    if (provider) assertSavableUrl(name, provider.baseUrl);
  }
  return [planned(join(repoRoot, STATE_DIR, 'config.json'), pick(false)), planned(userConfigFile(), user)];
}

/** What Save would change in one file: the top-level keys that differ, and both objects. */
export interface SaveDiff {
  path: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Top-level keys the save adds or changes in the file (none when it is not written). */
  keys: string[];
}

/** Compute what a Save would write without writing it, the repository file's diff with the user file's as `user`, so a dialog can list exactly what the save does. */
export function plannedSave(repoRoot: string, session: Session): SaveDiff & { user: SaveDiff } {
  const [repo, user] = plannedMerge(repoRoot, session).map(({ path, existing, merged }): SaveDiff => {
    const keys = [...new Set([...Object.keys(existing), ...Object.keys(merged)])]
      .filter((k) => !isDeepStrictEqual(existing[k], plainValue(merged[k])));
    return { path, before: existing, after: merged, keys };
  });
  return { ...repo!, user: user! };
}

/**
 * Merge only explicit session settings, keeping unrelated/unknown fields: the USER_KEYS into the user's
 * config file, the rest into the repository's. Returns the files written (repository first); a file the
 * save would not change is not touched. Refuses a credential in a URL.
 */
export function saveSessionConfig(repoRoot: string, session: Session): string[] {
  const [repo, user] = plannedMerge(repoRoot, session);
  return [writeChanged(repo), writeChanged(user, 0o700)].filter((path): path is string => path !== undefined);
}

/** Merge `patch` into the user's config file, keeping every key it does not name; the path when the file changed. */
export function saveUserConfig(patch: ConfigPatch): string | undefined {
  return writeChanged(planned(userConfigFile(), patch), 0o700);
}

/** Write a planned file through a temp file and a rename when it changes; a new file gets mode 0o600, a new directory `dirMode`. */
function writeChanged({ path, existing, merged }: Planned, dirMode?: number): string | undefined {
  if (isDeepStrictEqual(existing, plainValue(merged))) return undefined;
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const tmp = join(dirname(path), `config.${randomUUID()}.tmp`);
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
