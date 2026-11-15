// Every session setting, as one typed table: its name, what it does, which kind of value it takes, how
// to read it from a session and that session's effective config, and how a value is applied. The
// prompt's /set, its completion and a settings form all read this table, so they cannot drift.
//
// `config` is always the session's effective config, sessionConfig(repoRoot, session), computed again
// after every change. apply() changes the session only, never the config it is given.
import { isDeepStrictEqual } from 'node:util';
import { CliError } from './errors.ts';
import { DEFAULT_CONFIG, JEV_ENDPOINTS, ROUTERS, harnessNames, loadConfig, roleConfig, userSettings, type Config, type Router } from './config.ts';
import { SANDBOX_MODES, type SandboxMode } from './sandbox.ts';
import { MODEL_ROLES, sessionConfig } from './replModels.ts';
import type { IconSet } from './tui/theme.ts';
import type { Session } from './repl.ts';
import type { AgentRole } from './types.ts';

export type SettingGroup = 'Execution' | 'Limits' | 'Session' | 'Interface';
/** The groups in the order a form shows them. */
export const SETTING_GROUPS: readonly SettingGroup[] = ['Execution', 'Limits', 'Session', 'Interface'];

export type ToggleKey = 'docs' | 'yes' | 'quiet' | 'dirty' | 'tui' | 'mouse' | 'routing';
export type CountKey = 'concurrency' | 'attempts' | 'replans';
export type DollarsKey = 'budget' | 'card-budget';
export type SecondsKey = 'progress';
export type ChoiceKey = 'harness' | 'icons' | 'sandbox' | 'router';
export type SettingKey = ToggleKey | CountKey | DollarsKey | SecondsKey | ChoiceKey;

/** A setting's typed value: on/off, a whole number, dollars or seconds (undefined = off), or one of its options. */
export type SettingValue<K extends SettingKey = SettingKey> =
  K extends ToggleKey ? boolean : K extends CountKey ? number : K extends DollarsKey | SecondsKey ? number | undefined : string;

export interface SettingOption { value: string; label: string; description: string }
/** What a choice's options can depend on: the backends the session can run, harnessNames(config), and the planner's. */
export interface ChoiceContext { harnesses: readonly string[]; planner?: string }

interface SettingBase<K extends SettingKey> {
  key: K;
  label: string;
  /** The line prompt's wording: a short phrase for its completion menu, which may name the command's syntax. */
  description: string;
  /** For a settings form: one sentence on what the setting does and what it trades off, without command syntax. */
  help: string;
  group: SettingGroup;
  /** repository: saveSessionConfig writes it (harness and routing to the user's file). session: it lasts until dulger exits and is never written. */
  scope: 'repository' | 'session';
  read(session: Session, config: Config): SettingValue<K>;
  /** Validates `value`, then changes `session`. Throws CliError with a message a form can show. */
  apply(session: Session, config: Config, value: SettingValue<K>): void;
}
export interface ToggleSetting extends SettingBase<ToggleKey> { kind: 'toggle' }
/** A whole number of at least `min` (and at most `max`, when there is one). */
export interface CountSetting extends SettingBase<CountKey> { kind: 'count'; min: number; max?: number }
/** Dollars above 0, or undefined for no limit. */
export interface DollarsSetting extends SettingBase<DollarsKey> { kind: 'dollars' }
/** Whole seconds, or undefined (0 too) for off; `onSeconds` is what turning it on picks. */
export interface SecondsSetting extends SettingBase<SecondsKey> { kind: 'seconds'; onSeconds: number }
export interface ChoiceSetting extends SettingBase<ChoiceKey> { kind: 'choice'; options(ctx: ChoiceContext): SettingOption[] }
export type SessionSetting = ToggleSetting | CountSetting | DollarsSetting | SecondsSetting | ChoiceSetting;

type Meta<K extends SettingKey> = Pick<SettingBase<K>, 'key' | 'label' | 'description' | 'help' | 'group' | 'scope'>;

function toggle(meta: Meta<ToggleKey>, read: (s: Session, c: Config) => boolean, write: (s: Session, c: Config, v: boolean) => void): ToggleSetting {
  return { ...meta, kind: 'toggle', read, apply(session, config, value) {
    if (typeof value !== 'boolean') throw new CliError(`${meta.key} takes on or off`);
    write(session, config, value);
  } };
}

function count(meta: Meta<CountKey>, min: number, read: (c: Config) => number, write: (s: Session, v: number) => void): CountSetting {
  return { ...meta, kind: 'count', min, read: (_s, c) => read(c), apply(session, _config, value) {
    if (!Number.isInteger(value) || value < 0) throw new CliError(`${meta.key} takes a whole number`);
    if (value < min) throw new CliError(`${meta.key} is at least ${min}`);
    write(session, value);
  } };
}

function dollars(meta: Meta<DollarsKey>, read: (c: Config) => number | undefined, write: (s: Session, v: number | undefined) => void): DollarsSetting {
  return { ...meta, kind: 'dollars', read: (_s, c) => read(c), apply(session, _config, value) {
    if (value !== undefined && !(typeof value === 'number' && value > 0)) throw new CliError(`${meta.key} takes dollars or off`);
    write(session, value);
  } };
}

function choice(meta: Meta<ChoiceKey>, options: (ctx: ChoiceContext) => SettingOption[], read: (s: Session, c: Config) => string, write: (s: Session, c: Config, v: string) => void, invalid?: (values: string[]) => string): ChoiceSetting {
  return { ...meta, kind: 'choice', options, read, apply(session, config, value) {
    const values = options({ harnesses: harnessNames(config) }).map((o) => o.value);
    if (!values.includes(value)) throw new CliError(invalid ? invalid(values) : `${meta.key} is ${values.slice(0, -1).join(', ')} or ${values.at(-1)}`);
    write(session, config, value);
  } };
}

const ICONS: Record<IconSet | 'auto', Omit<SettingOption, 'value'>> = {
  // The app shows the value itself, as the config and the flags spell it; help has the description.
  nerd: { label: 'nerd', description: 'glyphs from a Nerd Font' },
  unicode: { label: 'unicode', description: 'plain Unicode glyphs' },
  ascii: { label: 'ascii', description: 'ASCII only' },
  auto: { label: 'auto', description: 'pick from the terminal' },
};

const HARNESSES: Record<string, string> = {
  claude: 'the Claude Code CLI',
  codex: 'the Codex CLI',
  fake: 'scripted agents, no model calls',
};

const JEV: Record<Exclude<Router, 'planner'>, string> = { 'jev-openrouter': 'Jev · OpenRouter', 'jev-typesafe': 'Jev · TypeSafe', 'jev-local': 'Jev · local' };

/** Who tags each task's difficulty, as the first start asks it and Settings offers it; `planner` names the planner's backend. */
export function routerOptions(planner?: string): SettingOption[] {
  return ROUTERS.map((value) => value === 'planner'
    ? { value, label: planner ? `Planner (${planner})` : 'Planner', description: "the planner's own tags" }
    : { value, label: JEV[value], description: JEV_ENDPOINTS[value].apiKeyEnv ?? JEV_ENDPOINTS[value].baseUrl });
}

/** Whether the first interactive start still asks for the router: the user's own config file names none. */
export function routerUnset(): boolean {
  return userSettings().routing?.router === undefined;
}

const SANDBOX: Record<SandboxMode, Omit<SettingOption, 'value'>> = {
  off: { label: 'off', description: 'run every command with your privileges' },
  auto: { label: 'auto', description: 'sandbox the commands where the runtime works, warn where not' },
  required: { label: 'required', description: 'start no run without the sandbox' },
};

/** Every session setting, in the order /set lists them. */
export const SESSION_SETTINGS: readonly SessionSetting[] = [
  // People read "backend"; the key and the config field stay `harness`.
  choice({ key: 'harness', label: 'Backend', description: 'the backend every role runs on', group: 'Execution', scope: 'repository',
    help: 'The backend all roles run on, unless a role has its own; backends differ in cost, speed and models.' },
    (ctx) => ctx.harnesses.map((h) => ({ value: h, label: h, description: Object.hasOwn(HARNESSES, h) ? HARNESSES[h]! : 'an API provider' })),
    (_s, c) => c.harness, (s, _c, v) => { s.overrides.harness = v; },
    (values) => `harness is one of ${values.join(', ')}`),
  count({ key: 'concurrency', label: 'Parallel cards', description: 'how many cards run at once', group: 'Limits', scope: 'repository',
    help: 'How many cards are built at the same time; more finishes sooner but spends faster and makes conflicts between cards more likely.' },
    1, (c) => c.concurrency, (s, v) => { s.overrides.concurrency = v; }),
  count({ key: 'attempts', label: 'Review rounds', description: 'review rounds per card, tries per task', group: 'Limits', scope: 'repository',
    help: 'How many build-and-review rounds a card gets, and tries a task gets, before it fails; more rounds rescue more cards but cost more.' },
    1, (c) => c.maxAttempts, (s, v) => { s.overrides.maxAttempts = v; }),
  count({ key: 'replans', label: 'Replans', description: 'how many times a failed run replans', group: 'Limits', scope: 'repository',
    help: 'How many times the planner may rework the remaining plan after a card fails; 0 never replans, so a failed card stays failed.' },
    0, (c) => c.maxReplans, (s, v) => { s.overrides.maxReplans = v; }),
  toggle({ key: 'docs', label: 'Docs agent', description: 'run a documentation agent after the code', group: 'Execution', scope: 'repository',
    help: 'Runs an agent after the cards land that updates the README and changelog for what changed; off saves that call.' },
    (_s, c) => c.docs, (s, _c, v) => { s.overrides.docs = v; }),
  {
    key: 'progress', label: 'Progress notes', description: 'live progress notes on running cards: on, off, or seconds between', group: 'Execution', scope: 'repository',
    help: 'Seconds between notes a cheap model writes on what each running card is doing; shorter keeps the board current but makes more calls.',
    kind: 'seconds', onSeconds: DEFAULT_CONFIG.progressIntervalSec,
    read: (_s, c) => (c.progressIntervalSec === 0 ? undefined : c.progressIntervalSec),
    apply(session, _config, value) {
      if (value !== undefined && !(Number.isInteger(value) && value >= 0)) throw new CliError('progress takes a whole number');
      session.overrides.progressIntervalSec = value ?? 0;
    },
  },
  toggle({ key: 'yes', label: 'Skip approval', description: 'skip the board approval pause', group: 'Session', scope: 'session',
    help: 'Dispatches the plan without pausing for your approval, and accepts new verify commands a replan brings; faster, but nobody reads the plan first.' },
    (s) => s.yes, (s, _c, v) => { s.yes = v; }),
  toggle({ key: 'quiet', label: 'Quiet output', description: 'log lines instead of the live view', group: 'Session', scope: 'session',
    help: 'Prints plain log lines during a run instead of the live view; easier to keep in a log, but without the live board and its controls.' },
    (s) => s.quiet, (s, _c, v) => { s.quiet = v; }),
  toggle({ key: 'dirty', label: 'Allow dirty tree', description: 'run with uncommitted changes', group: 'Session', scope: 'session',
    help: 'Lets a run start while the working tree has uncommitted edits; the agents start from the last commit, so those edits are not part of their work.' },
    (s) => s.allowDirty, (s, _c, v) => { s.allowDirty = v; }),
  // The tui and routing objects are replaced whole, so they start from the effective values: changing one
  // field keeps what the repository set for the others.
  toggle({ key: 'tui', label: 'Full screen', description: 'the full-screen app and live view, off for the line prompt and table', group: 'Interface', scope: 'repository',
    help: 'Follows runs in the live view and opens dulger as this app (from the next start); off prints a plain table and starts the line prompt, for terminals that draw these screens badly.' },
    (_s, c) => c.tui.enabled, (s, c, v) => { s.overrides.tui = { ...c.tui, enabled: v }; }),
  choice({ key: 'icons', label: 'Icons', description: 'which glyph set the view uses', group: 'Interface', scope: 'repository',
    help: 'Which glyphs the screens draw with; Nerd Font glyphs need a patched font, ASCII reads in any terminal.' },
    () => Object.entries(ICONS).map(([value, o]) => ({ value, ...o })),
    (_s, c) => c.tui.icons, (s, c, v) => { s.overrides.tui = { ...c.tui, icons: v as IconSet | 'auto' }; }),
  toggle({ key: 'mouse', label: 'Mouse', description: 'wheel scrolling and clicks in the full-screen views, off for text selection', group: 'Interface', scope: 'repository',
    help: 'Wheel scrolling and clicks in the full-screen screens; off leaves the mouse to the terminal, so text can be selected as usual.' },
    (_s, c) => c.tui.mouse, (s, c, v) => { s.overrides.tui = { ...c.tui, mouse: v }; }),
  toggle({ key: 'routing', label: 'Routing', description: 'route each task to a model tier', group: 'Execution', scope: 'repository',
    help: 'Gives each task a cheaper or stronger model by its difficulty, stepping up on retries; off runs each role on its default or chosen model.' },
    (_s, c) => c.routing.enabled, (s, c, v) => { s.overrides.routing = { ...c.routing, enabled: v }; }),
  choice({ key: 'router', label: 'Router', description: 'who tags each task low, medium or high', group: 'Execution', scope: 'repository',
    help: "Who rates each task's difficulty, and so its model tier: the planner itself, or Jev, TypeSafe's scoring model; when Jev fails, the planner's tags stand." },
    (ctx) => routerOptions(ctx.planner),
    (_s, c) => c.routing.router, (s, c, v) => { s.overrides.routing = { ...c.routing, router: v as Router }; }),
  dollars({ key: 'budget', label: 'Run budget', description: 'stop the run at a spend: /budget <usd>|off', group: 'Limits', scope: 'repository',
    help: 'Stops the run once it has spent this much, leaving it to resume later; off sets no limit. Backends that report only tokens are not counted.' },
    (c) => c.budgetUsd, (s, v) => { s.overrides.budgetUsd = v; }),
  dollars({ key: 'card-budget', label: 'Card budget', description: 'fail a card at a spend: /card-budget <usd>|off', group: 'Limits', scope: 'repository',
    help: 'Fails a card once it has spent this much, so one stubborn card cannot use up the run; off sets no limit.' },
    (c) => c.cardBudgetUsd, (s, v) => { s.overrides.cardBudgetUsd = v; }),
  // Kept apart from overrides, which saveSessionConfig writes.
  choice({ key: 'sandbox', label: 'Sandbox', description: 'confine Claude Code agents, verify commands, setup and API shells: off, auto or required (this session)', group: 'Session', scope: 'session',
    help: 'Confines Claude Code agents and the verify, setup and API tool commands to their worktree and allowed hosts; required starts no run without it.' },
    () => SANDBOX_MODES.map((value) => ({ value, ...SANDBOX[value] })),
    (_s, c) => c.sandbox.mode, (s, _c, v) => { s.sandbox = v as SandboxMode; }),
];

/** The setting called `key`, or undefined for a word that is not one. */
export function findSetting(key: string): SessionSetting | undefined {
  return SESSION_SETTINGS.find((s) => s.key === key);
}

function spec(key: SettingKey): SessionSetting {
  const s = findSetting(key);
  if (!s) throw new CliError(`unknown setting "${key}" (see /help)`);
  return s;
}

/** The setting's current value for this session. */
export function readSetting<K extends SettingKey>(session: Session, config: Config, key: K): SettingValue<K> {
  return spec(key).read(session, config) as SettingValue<K>;
}

/** Validate and apply a typed value; throws CliError with a message a form can show. */
export function applySetting<K extends SettingKey>(session: Session, config: Config, key: K, value: SettingValue<K>): void {
  (spec(key).apply as (s: Session, c: Config, v: SettingValue<K>) => void)(session, config, value);
}

/** A choice's options for this config; [] for any other kind. */
export function settingOptions(setting: SessionSetting, config: Config): SettingOption[] {
  return setting.kind === 'choice' ? setting.options({ harnesses: harnessNames(config), planner: roleConfig(config, 'planner').harness }) : [];
}

/** The value as the prompt shows it: on/off, a number, 120s, $5, a choice, and off for no limit. */
export function formatSetting(key: SettingKey, value: SettingValue): string {
  const s = spec(key);
  switch (s.kind) {
    case 'toggle': return value ? 'on' : 'off';
    case 'count': return String(value);
    case 'seconds': return value === undefined ? 'off' : `${value}s`;
    case 'dollars': return value === undefined ? 'off' : `$${value}`;
    case 'choice': return String(value);
  }
}

const ON = /^(on|true|yes)$/i;
const OFF = /^(off|false|no)$/i;

/**
 * The typed value a word at the prompt stands for: on/off/true/false/yes/no for a toggle, a whole number
 * (raised to the minimum) for a count, on/off or seconds for progress, dollars or off for a budget, and
 * the word itself for a choice (apply checks it). Throws CliError with the prompt's messages.
 */
export function parseSetting(key: SettingKey, text: string): SettingValue {
  const s = spec(key);
  const whole = () => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0) throw new CliError(`${key} takes a whole number`);
    return n;
  };
  switch (s.kind) {
    case 'toggle':
      if (!ON.test(text) && !OFF.test(text)) throw new CliError(`${key} takes on or off`);
      return ON.test(text);
    case 'count': return Math.max(s.min, whole());
    // on restores the default interval; off stops the reporter; a number is seconds between notes.
    case 'seconds': return ON.test(text) ? s.onSeconds : OFF.test(text) ? undefined : whole();
    case 'dollars': {
      const usd = text === 'off' ? undefined : Number(text);
      if (usd !== undefined && !(usd > 0)) throw new CliError(`${key} takes dollars or off`);
      return usd;
    }
    case 'choice': return text;
  }
}

/** What the session has changed against the repository, as a settings form marks it. */
export interface SessionChanges {
  /** Settings whose value differs from what the repository's config and the default flags give (session-only ones included). */
  settings: SettingKey[];
  /**
   * Roles with a choice of their own (backend, model pin or budget) that changes how they run against the
   * repository. A role that only follows a changed harness or routing setting is not listed: that change
   * is the setting's, already in `settings`.
   */
  roles: AgentRole[];
  /** Provider entries the session adds or edits. */
  providers: string[];
  /** Whether the effective config differs from the saved one, i.e. there is something saveSessionConfig would persist. */
  unsaved: boolean;
}

/** Compare the session with what <repo>/.dulger/config.json gives on its own. Throws what loadConfig throws for a broken file. */
export function sessionChanges(repoRoot: string, session: Session): SessionChanges {
  const current = sessionConfig(repoRoot, session);
  const saved = loadConfig(repoRoot);
  const fresh: Session = { overrides: {}, yes: false, quiet: false, allowDirty: false };
  const settings = SESSION_SETTINGS.filter((s) => !isDeepStrictEqual(s.read(session, current), s.read(fresh, saved))).map((s) => s.key);
  const role = (c: Config, r: AgentRole) => {
    const rc = roleConfig(c, r);
    return { harness: rc.harness, model: rc.model, maxBudgetUsd: rc.maxBudgetUsd, pinned: c.roles[r]?.model };
  };
  // Both: the role runs differently, and its own entry is what differs (not the harness it follows).
  const roles = MODEL_ROLES.filter((r) => !isDeepStrictEqual(role(current, r), role(saved, r))
    && !isDeepStrictEqual(plain(current.roles[r] ?? {}), plain(saved.roles[r] ?? {})));
  const providers = [...new Set([...Object.keys(current.providers), ...Object.keys(saved.providers)])]
    .filter((name) => !isDeepStrictEqual(plain(current.providers[name]), plain(saved.providers[name])));
  const { sandbox: _current, ...now } = current;
  const { sandbox: _saved, ...before } = saved;
  return { settings, roles, providers, unsaved: !isDeepStrictEqual(plain(now), plain(before)) };
}

/**
 * Roles that run differently from the repository because of this session: their own choice changed
 * (`changes.roles`), or they have no backend of their own and the Backend or routing setting changed.
 * For marking what a run would use; what Save writes for roles is `changes.roles`.
 */
export function rolesAffected(changes: SessionChanges, config: Config): AgentRole[] {
  const follows = changes.settings.includes('harness') || changes.settings.includes('routing');
  return MODEL_ROLES.filter((r) => changes.roles.includes(r) || (follows && !config.roles[r]?.harness));
}

/** As JSON would store it: an entry with `model: undefined` is the same as one without the key. */
function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
