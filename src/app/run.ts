// Starting work from the app: a new goal, a resume, a retry. A resume first asks (resume.ts): what is
// left, and which settings when the run's differ from the session's. Each one then checks what it can
// without running anything (uncommitted changes, roles without a model, providers without a key) and
// shows those blockers as short state lines with the page that fixes them. Then the live run view gets
// the terminal: lent (ctx.lend), so the screen never drops to the shell, or given away (ctx.suspend)
// when the run prints plain lines instead. The run prints nothing of its own on the normal screen
// (silent): when the app is back a few words say how the run ended, and it opens what there is to look
// at: the review of a result, or the run on the Runs tab. They never reject: every failure is shown to
// the person here, its message in full.
//
// The functions that actually run something are injectable (createLauncher), so all of this is tested
// without agents; the exported launch* functions use the real ones.
import { roleConfig, type Config } from '../config.ts';
import { CliError } from '../errors.ts';
import * as git from '../git/worktree.ts';
import * as store from '../board/store.ts';
import { keySource } from '../keys.ts';
import { MODEL_ROLES, setupIssues } from '../replModels.ts';
import { failedCards, runState, type RunStatus } from '../runs.ts';
import { preflight, type PreflightCheck } from '../preflight.ts';
import { originalSettings } from '../runSettings.ts';
import { fullScreenRun } from '../commands.ts';
import { runGoal, runOrder, runResume, runRetry, type SessionRun } from '../sessionRuns.ts';
import { history } from '../ui/prompt.ts';
import { fit, plainText } from '../tui/text.ts';
import type { Glyphs } from '../tui/theme.ts';
import type { Screen } from '../tui/screen.ts';
import type { Session } from '../repl.ts';
import type { Board } from '../types.ts';
import { createReviewPage } from './pages/review.ts';
import { describeCheck } from './pages/doctor.checks.ts';
import { commitSettingsFlow, settingsOnlyDirty as onlySettingsDirty } from './pages/settings.flows.ts';
import { noticeModal, type NoticeAction } from '../tui/kit/index.ts';
import { ROLE_NOUNS } from './look.ts';
import { resumeDialog } from './resume.ts';
import type { AppContext, NavParams, Page } from './types.ts';

/** `run` plans and waits at the plan for a go; `order` always talks the plan through with the planner first. */
export type GoalMode = 'run' | 'order';

// ---- what would stop a run ----

/** Something that keeps a run from starting, and the page that fixes it. */
export interface RunProblem {
  /** Stable: `dirty`, `config`, `model:<role>`, `key:<provider>`, `check:<preflight label>`. */
  id: string;
  /** A short state line: `dirty tree`, `no key: groq`, `codex not found`. */
  title: string;
  /** What is wrong and how it is fixed, in a sentence or two: for `?`. */
  detail: string;
  /** Data a dialog shows beside the title: the check's or the tool's own message, a file, a variable. */
  message?: string;
  /** The page that fixes it; `label` is that page's name, for a button. */
  fix: { label: string; page: string; params?: NavParams };
  /** The only uncommitted change is the saved settings file: "Commit settings" fixes it on the spot. */
  commit?: boolean;
}

/** Whether the saved settings file is the only uncommitted change, so committing it unblocks a run (Settings decides). */
export function settingsOnlyDirty(repoRoot: string): boolean {
  try { return onlySettingsDirty(repoRoot); } catch { return false; }
}

/** Commit just the settings file (Settings asks first, naming the branch and the message); true when committed. */
export function commitSettings(ctx: AppContext): Promise<boolean> {
  return commitSettingsFlow(ctx);
}

export interface ProblemOptions {
  /** Check the working tree (a new goal); resume and retry continue where the run was, as the CLI does. */
  tree?: boolean;
  /** Check that every enabled role on an API provider has a model (default true). */
  models?: boolean;
  /** The configuration the run will use (default: the session's). */
  config?: Config;
}

/**
 * What stops a run now, cheapest checks only (one git call, no model or backend calls): uncommitted
 * changes unless the session allows them, enabled roles on a provider without a model, and providers a
 * role uses without a key. Never throws: an unreadable configuration is a problem too.
 */
export function runProblems(ctx: Pick<AppContext, 'repoRoot' | 'session' | 'config'>, o: ProblemOptions = {}): RunProblem[] {
  const out: RunProblem[] = [];
  if (o.tree !== false && !ctx.session.allowDirty) {
    let clean = true;
    try { clean = git.isClean(ctx.repoRoot); } catch { /* not a repository any more: the run says so */ }
    if (!clean) {
      const onlySettings = settingsOnlyDirty(ctx.repoRoot);
      out.push(onlySettings ? {
        id: 'dirty', title: 'settings uncommitted', message: '.dulger/config.json',
        detail: 'The only uncommitted change is .dulger/config.json, the settings saved to the repository. A run starts from the last commit, so it would not use them: commit the file, or allow uncommitted changes for this session in Settings.',
        fix: { label: 'Settings', page: 'settings', params: { key: 'dirty' } }, commit: true,
      } : {
        id: 'dirty', title: 'dirty tree',
        detail: 'The working tree has uncommitted changes. A run starts from the last commit, so the agents would not see them: commit them first, or allow uncommitted changes for this session in Settings.',
        fix: { label: 'Settings', page: 'settings', params: { key: 'dirty' } },
      });
    }
  }
  let config: Config;
  try {
    config = o.config ?? ctx.config();
  } catch (e) {
    out.push({
      id: 'config', title: 'settings unreadable', message: errorText(e),
      detail: `dulger's settings for this repository cannot be read: ${errorText(e)}`,
      fix: { label: 'Doctor', page: 'doctor' },
    });
    return out;
  }
  if (o.models !== false) {
    for (const issue of setupIssues(config)) {
      const role = MODEL_ROLES.find((r) => issue.startsWith(`${r} `));
      if (!role) continue;
      const harness = roleConfig(config, role).harness;
      const noun = ROLE_NOUNS[role];
      out.push({
        id: `model:${role}`, title: `no model: ${noun}`, message: harness,
        detail: `The ${noun} runs on ${harness}, an API provider that needs a model to be named. Choose one for the ${noun} on Models.`,
        fix: { label: 'Models', page: 'models', params: { role } },
      });
    }
  }
  for (const name of keylessProviders(config)) {
    const env = config.providers[name]!.apiKeyEnv!;
    out.push({
      id: `key:${name}`, title: `no key: ${name}`, message: env,
      detail: `${name} needs an API key in ${env}, which is neither set in the environment nor stored. Add it on Providers; it is kept in your own keys file, never in the repository.`,
      fix: { label: 'Providers', page: 'providers', params: { provider: name } },
    });
  }
  return out;
}

/** Page names for the fix buttons, as the tabs name them. */
const PAGE_NAMES: Record<string, string> = { settings: 'Settings', models: 'Models', providers: 'Providers', doctor: 'Doctor', runs: 'Runs' };

/** A failed readiness check as a short state line. */
function checkTitle(label: string, harnesses: readonly string[]): string {
  const role = /^(planner|worker|checker|docs|reporter) budget$/.exec(label);
  if (role) return `${ROLE_NOUNS[role[1] as keyof typeof ROLE_NOUNS]} budget unsupported`;
  if (harnesses.includes(label)) return `${label} not found`;
  switch (label) {
    case 'Git repository': return 'no commits';
    case 'Git identity': return 'no git identity';
    case 'Worktree directory': return 'worktrees not writable';
    case 'Settings': return 'invalid settings';
    case 'Sandbox': return 'sandbox unavailable';
    default: return `${plainText(label).toLowerCase()} failed`;
  }
}

/**
 * The readiness checks a run makes before it starts (preflight), as problems, for what runProblems does
 * not already cover: a backend's command missing, the settings unusable, a role budget a backend cannot
 * count, no git identity. Spawns each backend's `--version`, so it is made at a launch, or cached
 * (cachedReadiness), never while drawing.
 */
export function readinessProblems(ctx: Pick<AppContext, 'repoRoot' | 'session'>, config: Config): RunProblem[] {
  let checks: PreflightCheck[];
  try { checks = preflight(ctx.repoRoot, config, { forRun: true, allowDirty: ctx.session.allowDirty }); } catch (e) {
    return [{ id: 'check:preflight', title: 'checks failed', message: errorText(e), detail: errorText(e), fix: { label: 'Doctor', page: 'doctor' } }];
  }
  const harnesses = [...new Set(MODEL_ROLES.map((r) => { try { return roleConfig(config, r).harness; } catch { return ''; } }))];
  // Roles without a model and providers without a key are runProblems' (with their own fix).
  return checks.filter((c) => c.status === 'error' && !/ (model|credentials)$/.test(c.label)).map((c): RunProblem => {
    const d = (() => { try { return describeCheck(c, config); } catch { return { ...c, action: undefined }; } })();
    const page = d.action?.page ?? 'doctor';
    return {
      id: `check:${c.label}`, title: checkTitle(c.label, harnesses), detail: d.detail,
      // The check's own words, except for a missing command, which the title already says.
      message: harnesses.includes(c.label) ? undefined : c.detail,
      fix: { label: PAGE_NAMES[page] ?? page, page, params: d.action?.params },
    };
  });
}

const READINESS_TTL_MS = 30_000;
const readinessCache = new Map<string, { at: number; problems: RunProblem[] }>();

/** readinessProblems for Home: kept for a while per repository and settings, so tab switches do not spawn. */
export function cachedReadiness(ctx: Pick<AppContext, 'repoRoot' | 'session' | 'config' | 'now'>): RunProblem[] {
  let config: Config;
  try { config = ctx.config(); } catch { return []; }
  const key = JSON.stringify([ctx.repoRoot, ctx.session.allowDirty, config]);
  const hit = readinessCache.get(key);
  if (hit && ctx.now() - hit.at < READINESS_TTL_MS) return hit.problems;
  const problems = readinessProblems(ctx, config);
  readinessCache.set(key, { at: ctx.now(), problems });
  return problems;
}

/** The providers a run would ask a key for before it starts (what ensureKeys asks on the line prompt). */
function keylessProviders(config: Config): string[] {
  const used = new Set([config.harness, ...Object.values(config.roles).map((r) => r?.harness).filter((h): h is string => Boolean(h))]);
  return [...used].filter((name) => {
    const env = config.providers[name]?.apiKeyEnv;
    return Boolean(env) && keySource(env!) === 'missing';
  });
}

// ---- launching ----

/** How a launch ended; pages that want to react (Home restores a goal that never ran) read it. */
export type LaunchOutcome =
  | { kind: 'blocked' }
  | { kind: 'error'; runId?: string }
  | { kind: 'cancelled'; runId: string }
  | { kind: 'stopped'; runId: string; status?: RunStatus }
  | { kind: 'finished'; runId: string; landed: number };

/** What actually runs things; tests replace them. */
export interface LaunchDeps {
  runGoal: typeof runGoal;
  runOrder: typeof runOrder;
  runResume: typeof runResume;
  runRetry: typeof runRetry;
  reviewPage: (ctx: AppContext, runId: string) => Page;
  /** The readiness checks made before anything starts (the real preflight; tests replace it). */
  readiness: typeof readinessProblems;
}

export interface Launcher {
  goal(ctx: AppContext, goal: string, mode?: GoalMode): Promise<LaunchOutcome>;
  /** Asks first (the resume dialog); `currentSettings` given, the settings are not asked about. */
  resume(ctx: AppContext, runId: string, o?: { currentSettings?: boolean }): Promise<LaunchOutcome>;
  retry(ctx: AppContext, runId: string, cardId: string): Promise<LaunchOutcome>;
}

const REAL: LaunchDeps = { runGoal, runOrder, runResume, runRetry, reviewPage: createReviewPage, readiness: readinessProblems };

export function createLauncher(over: Partial<LaunchDeps> = {}): Launcher {
  const d: LaunchDeps = { ...REAL, ...over };

  /**
   * Hand the terminal to `work`, then report. The full-screen view gets the app's terminal on loan (it
   * draws there, and nothing flashes in between); plain log lines need the shell's screen. Errors are
   * shown in full; the run they left behind is named.
   */
  async function run(ctx: AppContext, work: (screen: (() => Screen) | undefined) => Promise<SessionRun>, known?: string): Promise<LaunchOutcome> {
    const before = new Set(safeRuns(ctx.repoRoot));
    let full = false;
    try { full = fullScreenRun(ctx.config(), ctx.session.quiet); } catch { full = false; }
    let r: SessionRun;
    try {
      r = full ? await ctx.lend((open) => work(open)) : await ctx.suspend(() => work(undefined));
    } catch (err) {
      const left = known ?? safeRuns(ctx.repoRoot).find((id) => !before.has(id));
      await showFailure(ctx, err, left);
      return { kind: 'error', runId: left };
    }
    return outcome(ctx, d, r);
  }

  /** The readiness checks on the session's settings ([] when they cannot be read: runProblems says so). */
  const sessionReadiness = (ctx: AppContext): RunProblem[] => {
    let config: Config;
    try { config = ctx.config(); } catch { return []; }
    return d.readiness(ctx, config);
  };

  // Whatever fails before the terminal is handed over (an unreadable board, a newer settings format).
  const guard = async (ctx: AppContext, fn: () => Promise<LaunchOutcome>): Promise<LaunchOutcome> => {
    try { return await fn(); } catch (err) { await showFailure(ctx, err, undefined, true).catch(() => undefined); return { kind: 'error' }; }
  };

  return {
    goal: (ctx, goal, mode = 'run') => guard(ctx, async () => {
      const text = goal.trim();
      if (!text) { ctx.toast('Type a goal', 'warn'); return { kind: 'blocked' }; }
      remember(text);
      let session: Session = ctx.session;
      // Every check, the readiness checks included, before a run record exists: a problem leaves no run behind.
      for (;;) {
        const problems = [...runProblems(ctx), ...sessionReadiness(ctx)];
        if (!problems.length) break;
        const choice = await showProblems(ctx, problems, { startAnyway: true });
        if (choice === 'committed') continue;
        if (choice !== 'start') return { kind: 'blocked' };
        // Only this run: the session keeps refusing a dirty tree.
        session = { ...ctx.session, allowDirty: true };
        break;
      }
      const start = mode === 'order' ? d.runOrder : d.runGoal;
      return run(ctx, (screen) => start(ctx.repoRoot, session, text, { silent: true, screen }));
    }),

    resume: (ctx, runId, o = {}) => guard(ctx, async () => {
      const board = await readBoard(ctx, runId, 'resume');
      if (!board) return { kind: 'blocked' };
      const choice = await resumeDialog(ctx, board, o.currentSettings === undefined ? undefined : o.currentSettings ? 'current' : 'original');
      if (!choice) return { kind: 'blocked' };
      const current = choice === 'current';
      // Check the settings the run will use: its saved ones unless the person chose this session's.
      const config = current ? ctx.config() : originalSettings(board, ctx.config());
      const problems = [...runProblems(ctx, { tree: false, config, models: current || !board.settings }), ...d.readiness(ctx, config)];
      if (problems.length) { await showProblems(ctx, problems); return { kind: 'blocked' }; }
      return run(ctx, (screen) => d.runResume(ctx.repoRoot, ctx.session, runId, { currentSettings: current, settingsChosen: true, silent: true, screen }), runId);
    }),

    retry: (ctx, runId, cardId) => guard(ctx, async () => {
      const board = await readBoard(ctx, runId, 'retry');
      if (!board) return { kind: 'blocked' };
      const card = board.cards.find((c) => c.id === cardId);
      if (!card || !failedCards(board).some((c) => c.id === cardId)) {
        await ctx.modal(noticeModal({
          title: 'Nothing to retry', tone: 'warn', message: '',
          items: card ? [{ label: plainText(cardId), value: `${plainText(card.title)} · ${card.status.replace('_', ' ')}` }] : [{ label: plainText(cardId), value: `not in ${plainText(runId)}` }],
        }));
        return { kind: 'blocked' };
      }
      const config = originalSettings(board, ctx.config());
      const problems = [...runProblems(ctx, { tree: false, config, models: !board.settings }), ...d.readiness(ctx, config)];
      if (problems.length) { await showProblems(ctx, problems); return { kind: 'blocked' }; }
      // A retry goes on with the settings the run started with (the retry dialog says so), unasked.
      return run(ctx, (screen) => d.runRetry(ctx.repoRoot, ctx.session, cardId, runId, { settingsChosen: true, silent: true, screen }), runId);
    }),
  };
}

const launcher = createLauncher();

/** Plan and run a new goal. */
export async function launchGoal(ctx: AppContext, goal: string, mode: GoalMode = 'run'): Promise<void> {
  await launcher.goal(ctx, goal, mode);
}

/** Ask, then continue a run with its saved settings or this session's, as the person chose (or `currentSettings` says). */
export async function launchResume(ctx: AppContext, runId: string, o: { currentSettings?: boolean } = {}): Promise<void> {
  await launcher.resume(ctx, runId, o);
}

/** Give a failed card one more review round, then run the board on. */
export async function launchRetry(ctx: AppContext, runId: string, cardId: string): Promise<void> {
  await launcher.retry(ctx, runId, cardId);
}

// ---- after the run ----

async function outcome(ctx: AppContext, d: LaunchDeps, r: SessionRun): Promise<LaunchOutcome> {
  if (!safeRuns(ctx.repoRoot).includes(r.runId)) {
    // Discarded at the plan: the run and its branch are gone.
    ctx.toast('Plan discarded', 'info');
    return { kind: 'cancelled', runId: r.runId };
  }
  let board: Board | undefined;
  try { board = store.loadBoard(ctx.repoRoot, r.runId); } catch { board = undefined; }
  ctx.navigate('runs', { run: r.runId });
  if (!board) {
    ctx.toast(`${r.runId}: board unreadable`, 'warn');
    return { kind: 'stopped', runId: r.runId };
  }
  const cards = board.cards.filter((c) => c.status !== 'replaced');
  const done = cards.filter((c) => c.status === 'done').length;
  const failed = cards.filter((c) => c.status === 'failed').length;
  const status = runState(ctx.repoRoot, board);
  if (r.aborted) {
    ctx.toast(stoppedText(board, status, done, cards.length, failed), 'warn');
    return { kind: 'stopped', runId: r.runId, status };
  }
  if (r.landed > 0) {
    try { ctx.push(d.reviewPage(ctx, r.runId)); } catch (e) { ctx.toast(`Review: ${errorText(e)}`, 'error'); }
    const unverified = board.finalVerification?.results.some((v) => !v.ok);
    const landed = `${r.landed}/${cards.length} landed → ${board.runBranch}`;
    ctx.toast(failed ? `${landed} · ${failed} failed` : unverified ? `${landed} · verify failed` : landed, failed || unverified ? 'warn' : 'ok');
    return { kind: 'finished', runId: r.runId, landed: r.landed };
  }
  ctx.toast(cards.length ? `Nothing landed${failed ? ` · ${failed} failed` : ''}` : 'No cards planned', 'warn');
  return { kind: 'finished', runId: r.runId, landed: 0 };
}

/** Said on Runs, where the run is selected and its keys are in the footer. */
function stoppedText(board: Board, status: RunStatus, done: number, total: number, failed: number): string {
  if (board.halted) return `Stopped: ${fit(plainText(board.halted.reason), 60)}`;
  if (!total || status === 'planning incomplete') return 'Stopped before the plan';
  if (board.cards.every((c) => c.status === 'backlog' || c.status === 'blocked' || c.status === 'replaced')) return `Not dispatched · ${total} card${total === 1 ? '' : 's'}`;
  return `Stopped · ${done}/${total} done${failed ? ` · ${failed} failed` : ''}`;
}

// ---- dialogs ----

/**
 * The problems in one dialog: the first one's fix is the primary action. Resolves 'start' for "start
 * anyway", and 'committed' once "Commit settings" committed the settings file (the caller checks again).
 */
async function showProblems(ctx: AppContext, problems: RunProblem[], o: { startAnyway?: boolean } = {}): Promise<string | undefined> {
  const first = problems[0]!;
  // Only uncommitted changes can be waved through, and only for this one run.
  const anyway = o.startAnyway && problems.every((p) => p.id === 'dirty');
  const commit = problems.some((p) => p.commit);
  // Each blocker as its state line, with the check's or the tool's own message beside it.
  const items = problems.map((p) => (p.message ? { label: p.title, value: readable(p.message, ctx.g) } : p.title));
  const actions: NoticeAction[] = commit
    ? [{ id: 'commit', label: 'Commit', primary: true }, { id: 'fix', label: first.fix.label }]
    : [{ id: 'fix', label: first.fix.label, primary: true }];
  if (anyway) actions.push({ id: 'start', label: 'Start anyway' });
  const title = commit && problems.length === 1 ? 'Settings uncommitted' : anyway ? 'Uncommitted changes' : 'Cannot start';
  // What Start anyway leaves out is not on screen anywhere else.
  const note = anyway ? 'Start anyway: last commit only' : undefined;
  const choice = await ctx.modal(noticeModal({ title, message: '', items, note, tone: 'warn', actions }));
  if (choice === 'fix') ctx.navigate(first.fix.page, first.fix.params);
  if (choice === 'commit') return (await commitSettings(ctx)) ? 'committed' : undefined;
  return choice;
}

async function showFailure(ctx: AppContext, err: unknown, runId?: string, beforeStart = false): Promise<void> {
  const raw = errorText(err);
  const preflight = /^Preflight needs attention/.test(raw);
  const known = runId !== undefined && safeRuns(ctx.repoRoot).includes(runId);
  // The error is the message, whole; preflight's lines get their glyphs.
  const message = readable(preflight ? raw.replace(/^Preflight needs attention:\s*/, '') : raw, ctx.g);
  const actions: NoticeAction[] = [];
  if (preflight) actions.push({ id: 'doctor', label: 'Doctor', primary: true });
  if (known) actions.push({ id: 'run', label: 'Open run' });
  const title = !(err instanceof CliError) ? 'Error' : preflight || beforeStart ? 'Cannot start' : 'Run failed';
  const choice = await ctx.modal(noticeModal({ title, message, items: known ? [{ label: 'Kept as', value: runId! }] : undefined, tone: 'bad', actions }));
  if (choice === 'doctor') ctx.navigate('doctor');
  else if (choice === 'run' && runId) ctx.navigate('runs', { run: runId });
}

async function readBoard(ctx: AppContext, runId: string, what: 'resume' | 'retry'): Promise<Board | undefined> {
  try {
    return store.loadBoard(ctx.repoRoot, runId);
  } catch (e) {
    const missing = !safeRuns(ctx.repoRoot).includes(runId);
    await ctx.modal(noticeModal({
      title: `Cannot ${what} ${runId}`, tone: 'bad',
      message: missing ? `No run ${runId}` : errorText(e),
    }));
    return undefined;
  }
}

// ---- helpers ----

/** Slash commands in messages shared with the line prompt, said the app's way. */
const PHRASES: Array<[RegExp, string]> = [
  [/ in \/setup\b/g, ' on the Models tab'],
  [/ or use \/provider \S+ key\b/g, ' or add its key on the Providers tab'],
  [/,? or \/provider <name> key\b/g, ', or add the key on the Providers tab'],
  [/,? or \/dirty on\b/g, ', or allow uncommitted changes in Settings'],
  [/ \((?:see|try) \/help\)/g, ''],
];

/** `message` with the app's wording for slash commands and preflight's FIX/NOTE/OK markers as glyphs. */
export function readable(message: string, g: Glyphs): string {
  let m = message;
  for (const [re, to] of PHRASES) m = m.replace(re, to);
  return m.split('\n').map((line) => line.replace(/^FIX /, `${g.cross} `).replace(/^NOTE /, `${g.warn} `).replace(/^OK /, `${g.check} `)).join('\n');
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeRuns(repoRoot: string): string[] {
  try { return store.listRuns(repoRoot); } catch { return []; }
}

/** Goals go into the history the line prompt shares, most recent first, like a line typed there. */
function remember(goal: string): void {
  if (history[0] !== goal) history.unshift(goal);
  if (history.length > 200) history.length = 200;
}
