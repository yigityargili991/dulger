// The vocabulary of the interactive prompt: what each command is for, which values its arguments take,
// and what a half-typed line predicts next. Pure and free of IO, so the plain prompt, the full-screen
// view and the tests all read the same table; the values that change per repository (run ids, card
// ids, configured providers) arrive in a PredictContext.
import type { AgentRole } from './types.ts';

export interface Candidate {
  text: string;
  description: string;
}

/** A shorthand name /model takes, with the pair it resolves to. */
export interface Alias {
  name: string;
  harness: string;
  model: string;
}

/** Everything the prediction needs that is not fixed in this file. */
export interface PredictContext {
  /** Backends a role can run on: claude, codex, fake and every configured provider. */
  harnesses: string[];
  /** Providers /provider can define or edit, the configured ones first. */
  providers: string[];
  /** The roles /model names. */
  roles: AgentRole[];
  /** Model shorthands, in the order /help lists them. */
  aliases: Alias[];
  /** Run ids, newest last, as the store lists them. */
  runIds: string[];
  /** Failed cards of the latest run, for /retry. */
  cards: string[];
  /** Ids of what agents learned, for /memory rm. */
  memory: string[];
}

export interface Suggestion {
  /** Exactly what Tab inserts: the best guess, or the rest of the word the matches share. Empty when Tab has nothing to add. */
  ghost: string;
  /** Matches for the token being typed, best first. */
  candidates: Candidate[];
  /** The token itself, the word Tab completes. */
  partial: string;
}

export const NO_SUGGESTION: Suggestion = Object.freeze({ ghost: '', candidates: [], partial: '' });

const ON_OFF: Candidate[] = [
  { text: 'on', description: 'turn it on' },
  { text: 'off', description: 'turn it off' },
];

const OFF_ONLY: Candidate[] = [{ text: 'off', description: 'no limit' }];

const ICON_SETS: Candidate[] = [
  { text: 'nerd', description: 'glyphs from a Nerd Font' },
  { text: 'unicode', description: 'plain Unicode glyphs' },
  { text: 'ascii', description: 'ASCII only' },
  { text: 'auto', description: 'pick from the terminal' },
];

const MEMORY_SUBS: Candidate[] = [
  { text: 'list', description: 'what agents learned, oldest first' },
  { text: 'add', description: 'add a note: /memory add "text"' },
  { text: 'rm', description: 'forget one: /memory rm <id>' },
  { text: 'compact', description: 'merge the notes into fewer, denser ones' },
  { text: 'path', description: 'where the memory file lives' },
];

const SANDBOX_CHOICES: Candidate[] = [
  { text: 'off', description: 'run every command with your privileges' },
  { text: 'auto', description: 'sandbox the commands where the runtime works, warn where not' },
  { text: 'required', description: 'start no run without the sandbox' },
];

const REPORT_FLAGS: Candidate[] = [{ text: 'full', description: 'every summary, review and note' }];
const CONFIG_SUBS: Candidate[] = [{ text: 'save', description: 'persist the settings to .dulger/config.json' }];
const MODEL_CHOICES: Candidate[] = [
  { text: 'auto', description: "the backend's default model" },
  { text: 'reset', description: 'restore the repository settings' },
];

const ROLE_WORD: Record<AgentRole, string> = { planner: 'planner', worker: 'worker', checker: 'reviewer', docs: 'docs agent', reporter: 'progress reporter' };

/** A setting: what /set takes first, and the same key as a command of its own. */
interface SettingSpec {
  key: string;
  description: string;
  values?(ctx: PredictContext): Candidate[];
}

export const SETTINGS: SettingSpec[] = [
  { key: 'harness', description: 'the backend every role runs on', values: (ctx) => named(ctx.harnesses, 'run on this backend') },
  { key: 'concurrency', description: 'how many cards run at once' },
  { key: 'attempts', description: 'review rounds per card, tries per task' },
  { key: 'replans', description: 'how many times a failed run replans' },
  { key: 'model', description: 'the global model pin, or off', values: (ctx) => [...modelNames(ctx), { text: 'off', description: 'drop the global pin' }] },
  { key: 'docs', description: 'run a documentation agent after the code', values: () => ON_OFF },
  { key: 'progress', description: 'live progress notes on running cards: on, off, or seconds between', values: () => ON_OFF },
  { key: 'yes', description: 'skip the board approval pause', values: () => ON_OFF },
  { key: 'quiet', description: 'log lines instead of the live view', values: () => ON_OFF },
  { key: 'dirty', description: 'run with uncommitted changes', values: () => ON_OFF },
  { key: 'tui', description: 'the full-screen view, off for the table', values: () => ON_OFF },
  { key: 'icons', description: 'which glyph set the view uses', values: () => ICON_SETS },
  { key: 'routing', description: 'route each task to a model tier', values: () => ON_OFF },
  { key: 'budget', description: 'stop the run at a spend: /budget <usd>|off', values: () => OFF_ONLY },
  { key: 'card-budget', description: 'fail a card at a spend: /card-budget <usd>|off', values: () => OFF_ONLY },
  { key: 'sandbox', description: 'confine Claude Code agents, verify commands, setup and API shells: off, auto or required (this session)', values: () => SANDBOX_CHOICES },
];

export const SETTING_KEYS: string[] = SETTINGS.map((s) => s.key);

interface CommandSpec {
  name: string;
  summary: string;
  /** Values for the token at `index`, given the tokens already on the line. */
  args?(ctx: PredictContext, tokens: string[], index: number): Candidate[];
}

const COMMANDS: CommandSpec[] = [
  { name: 'doctor', summary: 'check readiness without a model call' },
  { name: 'review', summary: 'browse result diffs and verification', args: (ctx, _t, i) => i === 1 ? runNames(ctx) : [] },
  { name: 'edit', summary: 'edit an unstarted plan', args: (ctx, _t, i) => i === 1 ? runNames(ctx) : [] },
  { name: 'setup', summary: 'choose harness, model set and role overrides in a menu' },
  { name: 'order', summary: 'plan with the planner in a conversation, then dispatch' },
  { name: 'board', summary: "print a run's board", args: (ctx, _t, i) => (i === 1 ? runNames(ctx) : []) },
  { name: 'report', summary: 'print what a run landed (full: every summary, review and note)', args: (ctx, _t, i) => (i === 1 ? [...runNames(ctx), ...REPORT_FLAGS] : []) },
  { name: 'runs', summary: 'browse runs and recovery actions' },
  { name: 'resume', summary: 'continue an interrupted run', args: (ctx, _t, i) => (i === 1 ? runNames(ctx) : i === 2 ? [{ text: 'current', description: 'use current settings instead of saved settings' }] : []) },
  { name: 'retry', summary: 'give a failed card one more review round, then continue', args: (ctx, _t, i) => (i === 1 ? cardNames(ctx) : i === 2 ? runNames(ctx) : []) },
  { name: 'merge', summary: "merge a run's result branch into the current branch", args: (ctx, _t, i) => (i === 1 ? runNames(ctx) : []) },
  {
    name: 'memory',
    summary: 'what agents learned: list, add, rm, compact, path',
    args: (ctx, tokens, i) => (i === 1 ? MEMORY_SUBS : i === 2 && tokens[1]?.toLowerCase() === 'rm' ? idNames(ctx.memory, 'forget this note') : []),
  },
  { name: 'clean', summary: 'remove leftover worktrees and wip branches' },
  { name: 'status', summary: "settings and every role's effective model" },
  { name: 'model', summary: "show or set a role's backend and model", args: modelArgs },
  {
    name: 'provider',
    summary: 'list, define or edit an API provider',
    args: (ctx, _t, i) =>
      i === 1
        ? named(ctx.providers, 'define or edit this provider')
        : i === 2
          ? [{ text: 'key', description: 'enter or replace its API key' }, { text: 'model', description: "re-pick from the endpoint's models" }]
          : [],
  },
  { name: 'config', summary: 'write the session settings to .dulger/config.json', args: (_ctx, _t, i) => (i === 1 ? CONFIG_SUBS : []) },
  ...SETTINGS.filter((s) => s.key !== 'model').map((s) => ({ name: s.key, summary: s.description, args: (ctx: PredictContext, _t: string[], i: number) => (i === 1 ? s.values?.(ctx) ?? [] : []) })),
  { name: 'set', summary: 'any setting in one command: /set <key> <value>', args: (ctx, tokens, i) => (i === 1 ? settingNames() : i === 2 ? settingValues(tokens[1]?.toLowerCase(), ctx) : []) },
  { name: 'help', summary: 'this list' },
  { name: 'quit', summary: 'leave (Ctrl-D too)' },
];

/** What the plan prompt offers: the same words readReply accepts, so Tab and Enter agree. */
const PLAN_CHOICES: Candidate[] = [
  { text: 'go', description: 'dispatch the plan as it stands (Enter does the same)' },
  { text: 'cancel', description: 'delete the run and go back to the prompt' },
];

/** The word after the slash, or the argument the command is actually waiting for. A goal predicts nothing. */
export function suggestCommand(line: string, ctx: PredictContext): Suggestion {
  if (!line.startsWith('/')) return NO_SUGGESTION;
  const { tokens, partial, index } = splitLine(line);
  if (index === 0) {
    const candidates = commandNames().filter((c) => c.text.toLowerCase().startsWith(partial.toLowerCase()));
    return candidates.length ? build(candidates, partial) : NO_SUGGESTION;
  }
  const spec = COMMANDS.find((c) => c.name === tokens[0]!.slice(1).toLowerCase());
  return spec?.args ? build(spec.args(ctx, tokens, index), partial) : NO_SUGGESTION;
}

/** The plan/approval pause. A second word revises the plan rather than choosing, so it predicts nothing. */
export function suggestPlan(line: string): Suggestion {
  const { partial, index } = splitLine(line);
  return index === 0 ? build(PLAN_CHOICES, partial) : NO_SUGGESTION;
}

/** The tokens on the line, the token being typed (empty just after a space) and where that token sits. */
function splitLine(line: string): { tokens: string[]; partial: string; index: number } {
  const body = line.trimEnd();
  const tokens = body ? body.split(/\s+/) : [];
  const partial = !line || /\s$/.test(line) ? '' : (tokens[tokens.length - 1] ?? '');
  return { tokens, partial, index: partial ? tokens.length - 1 : tokens.length };
}

/** Matches for the partial token, best first, and what Tab would insert after it as ghost text. */
function build(values: Candidate[], partial: string): Suggestion {
  const prefix = partial.toLowerCase();
  const candidates = values.filter((c) => c.text.toLowerCase().startsWith(prefix));
  return { ghost: insertion(candidates, partial).slice(partial.length), candidates, partial };
}

/** What Tab inserts for the matches: the best guess when the word is still empty, otherwise what they all share. */
function insertion(candidates: Candidate[], partial: string): string {
  const first = candidates[0];
  if (!first) return partial;
  if (!partial) return `${first.text} `;
  let end = first.text.length;
  for (const c of candidates) {
    let i = 0;
    while (i < end && c.text[i]?.toLowerCase() === first.text[i]!.toLowerCase()) i++;
    end = i;
  }
  return first.text.slice(0, end);
}

function commandNames(): Candidate[] {
  return COMMANDS.map((c) => ({ text: `/${c.name}`, description: c.summary }));
}

function roleNames(ctx: PredictContext): Candidate[] {
  return ctx.roles.map((role) => ({ text: role, description: `the ${ROLE_WORD[role]}'s backend and model` }));
}

function modelNames(ctx: PredictContext): Candidate[] {
  return ctx.aliases.map((a) => ({ text: a.name, description: `${a.harness} / ${a.model}` }));
}

function modelArgs(ctx: PredictContext, tokens: string[], index: number): Candidate[] {
  if (index === 1) return [...roleNames(ctx), ...modelNames(ctx)];
  if (!ctx.roles.some((role) => role.toLowerCase() === tokens[1]?.toLowerCase())) return [];
  if (index === 2) return [...named(ctx.harnesses, 'use this backend'), ...modelNames(ctx), ...MODEL_CHOICES];
  return index === 3 ? MODEL_CHOICES.slice(0, 1) : [];
}

function runNames(ctx: PredictContext): Candidate[] {
  return [...ctx.runIds].reverse().map((id, i) => ({ text: id, description: i === 0 ? 'the latest run' : i === 1 ? 'the run before it' : 'an earlier run' }));
}

function cardNames(ctx: PredictContext): Candidate[] {
  return ctx.cards.map((id) => ({ text: id, description: 'a card that did not land' }));
}

function idNames(ids: string[], description: string): Candidate[] {
  return ids.map((id) => ({ text: id, description }));
}

function named(values: string[], description: string): Candidate[] {
  return values.map((value) => ({ text: value, description }));
}

function settingNames(): Candidate[] {
  return SETTINGS.map((s) => ({ text: s.key, description: s.description }));
}

function settingValues(key: string | undefined, ctx: PredictContext): Candidate[] {
  return SETTINGS.find((s) => s.key === key)?.values?.(ctx) ?? [];
}
