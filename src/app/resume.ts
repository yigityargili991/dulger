// The one question the app asks before a run goes on (Home, Runs and Review all resume through the
// launcher): the run, what is left as numbers, and, when the run's saved settings differ from this
// session's, each difference as `setting  run → session` and which to use, the run's own first. The
// answer is passed into the run, so runBoard does not ask again; the CLI and the line prompt keep
// runBoard's own question.
import { isDeepStrictEqual } from 'node:util';
import type { Config } from '../config.ts';
import { MODEL_ROLES } from '../replModels.ts';
import type { Session } from '../repl.ts';
import { originalSettings, settingsChanges } from '../runSettings.ts';
import { SESSION_SETTINGS, type SettingKey } from '../settings.ts';
import { fit, plainText } from '../tui/text.ts';
import { noticeModal, type DialogItem, type NoticeAction } from '../tui/kit/index.ts';
import type { Board } from '../types.ts';
import { ROLE_NOUNS } from './look.ts';
import { roleSummary, showValue } from './pages/settings.data.ts';
import type { AppContext } from './types.ts';

/** Which settings a resume runs with: the run's saved ones or this session's. */
export type SettingsChoice = 'original' | 'current';

const BLANK: Session = { overrides: {}, yes: false, quiet: false, allowDirty: false };
/** The config field each repository setting reads, to tell which differences the list already says. */
const FIELD: Partial<Record<SettingKey, string>> = {
  harness: 'harness', concurrency: 'concurrency', attempts: 'maxAttempts', replans: 'maxReplans', docs: 'docs', progress: 'progressIntervalSec',
  tui: 'tui', icons: 'tui', mouse: 'tui', routing: 'routing', router: 'routing', budget: 'budgetUsd', 'card-budget': 'cardBudgetUsd',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Names for the saved-settings fields no form setting stands for. */
const OTHER_NAMES: Record<string, string> = {
  roles: 'Role models', providers: 'Providers', worktreeSetup: 'Worktree setup', checker: 'Reviewer commands',
  maxContinuations: 'Task continuations', stallTimeoutSec: 'Stall timeout', verifyTimeoutSec: 'Verify timeout',
  claude: 'Claude Code options', codex: 'Codex options', memory: 'Memory',
};

/** A saved-settings field as people read it: the setting's own label (as on Settings), never the config key. */
export function settingName(key: string): string {
  const settings = SESSION_SETTINGS.filter((s) => FIELD[s.key] === key);
  if (settings.length === 1) return settings[0]!.label;
  if (settings.length > 1) return `${settings[0]!.group} settings`;
  return OTHER_NAMES[key] ?? key;
}

/** Several fields, named and joined: "Parallel cards, Worktree setup". */
export function settingNames(keys: readonly string[]): string {
  return [...new Set(keys.map(settingName))].join(', ');
}

/** The part of a saved value that differs, for Details: only the providers or roles that are not the same. */
function differing(key: string, a: unknown, b: unknown): [unknown, unknown] {
  if ((key !== 'providers' && key !== 'roles') || !a || !b || typeof a !== 'object' || typeof b !== 'object') return [a, b];
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const names = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((n) => !isDeepStrictEqual(x[n], y[n]));
  const pick = (o: Record<string, unknown>) => Object.fromEntries(names.filter((n) => o[n] !== undefined).map((n) => [n, o[n]]));
  return [pick(x), pick(y)];
}

export interface SettingDifferences {
  /** One row per difference a person can read: the setting, then `run → session`. */
  items: DialogItem[];
  /** Settings that differ in ways the rows do not show (by their name in the configuration). */
  other: string[];
  /** Every differing setting with both values whole, for a viewer. */
  full: string;
}

/** How this session's settings (`current`) differ from the ones a run saved (`saved`); none when they match. */
export function settingDifferences(saved: Config, current: Config): SettingDifferences | undefined {
  const keys = settingsChanges(saved, current);
  if (!keys.length) return undefined;
  const items: DialogItem[] = [];
  const said = new Set<string>();
  const row = (label: string, was: string, now: string, field: string) => {
    items.push({ label, value: `${plainText(was)} → ${plainText(now)}` });
    said.add(field);
  };
  // A value that cannot be described (a saved harness this machine does not know) is left to Details.
  const attempt = (fn: () => void) => { try { fn(); } catch { /* listed under "other" */ } };
  for (const s of SESSION_SETTINGS) {
    const field = FIELD[s.key];
    if (s.scope !== 'repository' || !field || !keys.includes(field)) continue;
    attempt(() => {
      const was = s.read(BLANK, saved);
      const now = s.read(BLANK, current);
      if (!isDeepStrictEqual(was, now)) row(s.label, showValue(s, was, saved), showValue(s, now, current), field);
    });
  }
  for (const role of MODEL_ROLES) {
    attempt(() => {
      const was = roleSummary(saved, role);
      const now = roleSummary(current, role);
      if (was !== now) row(`${cap(ROLE_NOUNS[role])} model`, was, now, 'roles');
    });
  }
  if (keys.includes('providers')) {
    for (const name of new Set([...Object.keys(saved.providers), ...Object.keys(current.providers)])) {
      const a = saved.providers[name];
      const b = current.providers[name];
      if (isDeepStrictEqual(a, b)) continue;
      // Where a provider came from (this session, the repository's file, a profile) is not known here:
      // say only how the run's settings and this session's compare.
      items.push({ label: `Provider ${plainText(name)}`, value: !b ? 'run only' : !a ? 'session only' : 'differs' });
      said.add('providers');
    }
  }
  const show = (v: unknown) => JSON.stringify(v, null, 2) ?? 'not set';
  // Details shows each differing field by its name, and of providers and roles only the entries that differ.
  const full = keys.map((k) => {
    const [a, b] = differing(k, saved[k as keyof Config], current[k as keyof Config]);
    return `${settingName(k)}\n  Run: ${show(a).replace(/\n/g, '\n  ')}\n  Session: ${show(b).replace(/\n/g, '\n  ')}`;
  }).join('\n\n');
  return { items, other: keys.filter((k) => !said.has(k)), full };
}

/**
 * What is left of `board`, as rows: why it stopped, the cards done, the ones resuming builds (and how
 * many of those were interrupted), and the failed ones, which a resume leaves failed.
 */
export function resumeWork(board: Board): DialogItem[] {
  const cards = board.cards.filter((c) => c.status !== 'replaced');
  const out: DialogItem[] = [];
  if (board.halted) out.push({ label: 'Stopped', value: fit(plainText(board.halted.reason), 100) });
  if (!cards.length) {
    out.push({ label: 'Plan', value: 'none, plans again' });
    return out;
  }
  const done = cards.filter((c) => c.status === 'done').length;
  const again = cards.filter((c) => c.status === 'in_progress' || c.status === 'review' || (c.status === 'failed' && c.failure === 'infrastructure')).length;
  const waiting = cards.filter((c) => c.status === 'backlog' || c.status === 'blocked').length;
  const failed = cards.filter((c) => c.status === 'failed' && c.failure !== 'infrastructure').length;
  out.push({ label: 'Done', value: `${done}/${cards.length}` });
  out.push({ label: 'To build', value: again ? `${again + waiting} · ${again} interrupted` : String(waiting) });
  if (failed) out.push({ label: 'Failed', value: `${failed} · stay${failed === 1 ? 's' : ''} failed` });
  return out;
}

/**
 * Ask before resuming `board`. When its saved settings differ from this session's and `preset` does
 * not say which to use, the dialog lists the differences and offers both, the run's own first; otherwise
 * it is a plain confirmation naming the settings it will use. Undefined when the person cancels.
 */
export async function resumeDialog(ctx: AppContext, board: Board, preset?: SettingsChoice): Promise<SettingsChoice | undefined> {
  const current = ctx.config();
  const message = fit(plainText(board.goal), 160);
  const work = resumeWork(board);
  const title = `Resume ${plainText(board.runId)}`;
  // A run from before settings were saved has nothing to keep: it runs with this session's.
  const diff = board.settings ? settingDifferences(originalSettings(board, current), current) : undefined;
  if (!diff || preset) {
    // Which settings it goes on with, when that is a choice someone made (or there was none to make).
    const used = !board.settings || preset === 'current' ? 'session' : diff ? 'original' : undefined;
    const items = used ? [...work, { label: 'Settings', value: used }] : work;
    const ok = await ctx.confirm({ title, message, items, confirm: 'Resume' });
    return ok ? preset ?? (board.settings ? 'original' : 'current') : undefined;
  }
  const items: DialogItem[] = [...work, { label: 'Settings', value: 'run → session' }, ...diff.items];
  if (diff.other.length) items.push({ label: diff.items.length ? 'Also' : 'Differ', value: settingNames(diff.other) });
  const actions: NoticeAction[] = [
    ...(diff.other.length ? [{ id: 'details', label: 'Details' }] : []),
    { id: 'original', label: 'Keep original' },
    { id: 'current', label: 'Use session' },
  ];
  for (;;) {
    const choice = await ctx.modal(noticeModal({
      title, message, items, actions, close: 'Cancel',
      // Not visible anywhere else: going on with this session's settings replaces the run's.
      note: 'Use session: saved with the run',
    }));
    if (choice !== 'details') return choice === 'original' || choice === 'current' ? choice : undefined;
    await ctx.view({ title: `${plainText(board.runId)} settings`, text: diff.full });
  }
}
