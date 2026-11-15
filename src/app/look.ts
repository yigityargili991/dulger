// The app's shared vocabulary and look: what each role is called (the checker is the reviewer to
// everyone but the config file), its glyph and colour, what it does; how a run's state and a card's
// status read (word, glyph, colour); how long ago something was. Every page takes these from here, so
// a role or a state reads the same on Home, Runs, Models, Doctor and the plan editor.
import chalk, { type ChalkInstance } from 'chalk';
import type { RunStatus } from '../runs.ts';
import { P, c, role as roleColour, status as statusColour, type Glyphs } from '../tui/theme.ts';
import type { AgentRole, Card } from '../types.ts';

// ---- one name per thing ----

/**
 * What the app calls the things it shows, the same on every page and in the header. Config keys, CLI
 * flags and the line prompt's commands keep their own names (yes, docs, budget, routing).
 */
export const TERMS = {
  /** The pause where the person reads the plan and says go; the session's "yes" skips it. */
  approval: 'Plan approval',
  approvalOn: 'asks',
  approvalOff: 'skipped',
  /** The Settings switch for that pause (on skips it). */
  approvalSkip: 'Skip approval',
  /** The role that updates the docs after the cards land, and its switch. */
  docs: 'Docs agent',
  runBudget: 'Run budget',
  cardBudget: 'Card budget',
  /** A role's model when its backend picks it (the CLI's own default, or the demo's). */
  defaultModel: 'default model',
  /** The setting that gives tasks a model tier by difficulty, and how the header and Models say its state. */
  routing: 'Routing',
  routingOn: 'routing on',
  routingOff: 'routing off',
} as const;

/** "routing on" / "routing off", or the global pin when there is one: the header's middle part. */
export function routingWords(routingEnabled: boolean, pin?: string): string {
  return pin ? `pin ${pin}` : routingEnabled ? TERMS.routingOn : TERMS.routingOff;
}

/** Names for tables, titles and buttons. */
export const ROLE_NAMES: Record<AgentRole, string> = {
  planner: 'Planner', worker: 'Worker', checker: 'Reviewer', docs: 'Docs', reporter: 'Reporter',
};

/** Names inside a sentence: "the reviewer", "the docs agent". */
export const ROLE_NOUNS: Record<AgentRole, string> = {
  planner: 'planner', worker: 'worker', checker: 'reviewer', docs: 'docs agent', reporter: 'progress reporter',
};

export const ROLE_JOBS: Record<AgentRole, string> = {
  planner: 'Splits the goal into cards and plans each one.',
  worker: 'Builds each card in its own worktree.',
  checker: 'Reviews each card before it lands.',
  docs: 'Updates the documentation after the cards land.',
  reporter: 'Writes the short progress notes on running cards.',
};

/** The role's glyph in the role's colour. */
export function roleGlyph(g: Glyphs, role: AgentRole): string {
  return roleColour[role](g[role]);
}

/** A role from a word people or links use: its id, or a name ("reviewer"). */
export function roleFromWord(word: string): AgentRole | undefined {
  const w = word.trim().toLowerCase();
  return (Object.keys(ROLE_NAMES) as AgentRole[]).find((r) => r === w || ROLE_NAMES[r].toLowerCase() === w || ROLE_NOUNS[r] === w);
}

// ---- run and card states ----

export type RunState = RunStatus | 'unreadable';
/** `label` where there is room, `short` in a narrow column; both say the same thing. */
export interface Look { glyph: string; paint: ChalkInstance; label: string; short: string }

/** A glyph, a colour and a word per state, so the state reads with colour, with glyphs alone or as text. */
export function statusLook(st: RunState, g: Glyphs, running = false): Look {
  switch (st) {
    case 'finished': return { glyph: g.check, paint: c.ok, label: 'finished', short: 'finished' };
    case 'needs attention': return { glyph: g.cross, paint: c.bad, label: 'needs attention', short: 'attention' };
    case 'ready to resume': return { glyph: g.play, paint: c.info, label: 'ready to resume', short: 'resumable' };
    case 'in progress / interrupted': return running
      ? { glyph: g.running, paint: c.warn, label: 'running', short: 'running' }
      : { glyph: g.interrupted, paint: c.warn, label: 'interrupted', short: 'interrupted' };
    case 'paused': return { glyph: g.pause, paint: c.accent, label: 'paused', short: 'paused' };
    case 'stopped': return { glyph: g.block, paint: chalk.hex(P.peach), label: 'stopped', short: 'stopped' };
    case 'planning incomplete': return { glyph: g.planner, paint: chalk.hex(P.lavender), label: 'planning incomplete', short: 'not planned' };
    case 'unreadable': return { glyph: g.warn, paint: chalk.hex(P.pink), label: 'unreadable', short: 'unreadable' };
  }
}

/** A card's status as a glyph and its colour. */
export function cardLook(card: Pick<Card, 'status'>, g: Glyphs): { glyph: string; paint: ChalkInstance } {
  const paint = statusColour[card.status];
  switch (card.status) {
    case 'done': return { glyph: g.check, paint };
    case 'failed': return { glyph: g.cross, paint };
    case 'blocked': return { glyph: g.block, paint };
    case 'in_progress': return { glyph: g.play, paint };
    case 'review': return { glyph: g.checker, paint };
    default: return { glyph: g.dot, paint };
  }
}

// ---- time ----

/**
 * An age for a column that says what it is: "now", "5m", "3h", "4d", then the date; "" for a date that
 * cannot be read. `{ ago: true }` gives the long form for running text ("just now", "5m ago").
 */
export function timeAgo(iso: string, now: number, o: { ago?: boolean } = {}): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const ago = o.ago ? ' ago' : '';
  if (s < 60) return o.ago ? 'just now' : 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m${ago}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${ago}`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d${ago}`;
  return localStamp(iso).slice(0, 10);
}

/** Local `YYYY-MM-DD HH:MM`, or the text as it is when it is not a date. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
