import { CliError } from './errors.ts';
import { acquireRunLock } from './board/lock.ts';
import { snapshotSettings, originalSettings, settingsChanges } from './runSettings.ts';
import { requirePreflight, cardModelIssues } from './preflight.ts';
import { editPlan } from './planEditor.ts';
import { select } from './tui/select.ts';
import { pager } from './tui/pager.ts';
// What the CLI and the interactive prompt both do: run boards, print them, curate memory, clean up.
// Errors meant for the user are thrown as CliError; the callers decide whether to exit or to carry on.
import { join } from 'node:path';
import { STATE_DIR, type Config } from './config.ts';
import * as store from './board/store.ts';
import { resetInterrupted, retryCard } from './board/scheduler.ts';
import * as git from './git/worktree.ts';
import { createOrchestrator, verifyCommands, type Orchestrator, type OrchestratorHooks } from './runner/orchestrator.ts';
import { createBoard } from './board/create.ts';
import { addMemory, compactMemory, listMemory, memoryPath, removeMemory, type Learning } from './context/memory.ts';
import { worktreesDir } from './paths.ts';
import { RESULT_BLOCKERS, cleanLeftovers, latestRun, mergeBlockers, mergeRunBranch, runSummaries } from './runs.ts';
import { createLiveView, renderBoard, type LiveView } from './ui/table.ts';
import { buildReport } from './ui/report.ts';
import { ask } from './ui/prompt.ts';
import { NO_SUGGESTION, type Candidate, type Suggestion } from './replCommands.ts';
import { bold, clockTime, cyan, dim, green, printable, red, yellow, fmtDuration, terminalWidth } from './ui/ansi.ts';
import { checkpoint } from './board/lifecycle.ts';
import { chop, fit, logLine, plainText, wrap } from './tui/text.ts';
import { ensureKeys } from './replProviders.ts';
import { createTui, tuiUsable, type ApproveOptions, type ReplyKind } from './tui/tui.ts';
import { REVISING, shownCommand, type Revision } from './tui/view.ts';
import { resolveIcons } from './tui/theme.ts';
import type { Screen } from './tui/screen.ts';
import type { AgentStatus, Board, Card } from './types.ts';

export { CliError } from './errors.ts';
export { latestRun } from './runs.ts';

export interface RunOptions {
  /** Skip the plan pause. resume and retry set it for a board that already has cards. */
  yes: boolean;
  /**
   * The person's own --yes (the flag, or /yes on): a plan off a terminal is dispatched without a review,
   * and verify commands a replan adds are accepted. Never set on the person's behalf.
   */
  assumeYes?: boolean;
  quiet: boolean;
  merge: boolean;
  fresh: boolean;
  /** Inside the interactive prompt: an interrupted run returns instead of exiting the process. */
  interactive?: boolean;
  /** Explicitly replace a saved run configuration with the current settings. */
  currentSettings?: boolean;
  /**
   * The person already chose the settings a resume uses (the app's resume dialog), as `currentSettings`
   * says: a resume whose saved settings differ does not ask again.
   */
  settingsChosen?: boolean;
  /**
   * Started from the app, which reports the outcome itself: nothing is printed on the normal screen
   * around the live view (the banner, the report, where failed worktrees are kept, the backlog and
   * deletion notices), and missing keys are not asked for there (the app checks them first).
   */
  silent?: boolean;
  /**
   * Opens the terminal the full-screen view draws on, and the plan editor opened from it (the app lends
   * its own, so the screen never drops back to the shell); given, the full-screen view is used.
   */
  screen?: () => Screen;
  /** Internal mutation performed only after the execution lock is held. */
  prepare?: (board: Board) => void;
}

export interface RunOutcome {
  landed: number;
  aborted: boolean;
}

/**
 * What a run shows while it happens: the full-screen view on a terminal, the redrawn table when the
 * screen is too small, plain log lines when quiet or piped. Every variant can ask the person a question.
 */
export interface RunUi {
  update(): void;
  /**
   * A log line. `whole` keeps every character of it on record (the commands --yes accepted): the plain
   * variants print it uncut, the full-screen log breaks it into rows instead of cutting it.
   */
  note(msg: string, o?: { whole?: boolean }): void;
  setPhase(phase: string): void;
  /** The full-screen view: the plan editor opens full-screen too. */
  readonly fullScreen?: boolean;
  /**
   * In the plain variants the board is printed (not with `brief`) and `intro` explains the choice. The
   * full-screen view asks `review` as its plan review screen and `typed` as a typed-confirmation dialog
   * (answering with the word when it was typed); it asks nothing else, and answers anything else as
   * dismissed. `details` (what `intro` lists) go to its log either way. `history` replaces what ↑ recalls;
   * aborting `signal` closes the question unanswered.
   */
  ask(q: RunQuestion): Promise<string | undefined>;
  close(): void;
}

export interface RunQuestion {
  label: string;
  intro: string;
  hint: string;
  suggest?(line: string): Suggestion;
  details?: string[];
  history?: string[];
  signal?: AbortSignal;
  /** The plan pause: what a typed reply asks for, warnings to read with the plan, and the last revision. */
  review?: { read(line: string): ReplyKind; warnings: string[]; revision?: Revision };
  /** A word to type before anything happens, and the shell commands it approves, each shown whole. */
  typed?: Omit<ApproveOptions, 'signal'>;
  /** A follow-up question (a confirmation): the plain variants print `intro` without the board again. */
  brief?: boolean;
}

/** A message made plain, its own line breaks kept: what an agent or a board file put in it reaches no terminal as escapes. */
export function plainLines(msg: string): string {
  return msg.split(/\r?\n/).map((line) => plainText(line)).join('\n');
}

/** Rows for the full-screen log, which cuts long lines: every character kept. */
const logRows = (msg: string) => chop(msg, Math.max(20, (process.stdout.columns ?? 100) - 12));

/** Whether a run shows the full-screen view, with `config` and the session's quiet. */
export function fullScreenRun(config: Config, quiet: boolean): boolean {
  return !quiet && config.tui.enabled && tuiUsable();
}

function createUi(repoRoot: string, board: Board, config: Config, o: RunOptions, agents: () => Iterable<AgentStatus>, onInterrupt: () => void, controls: Pick<Orchestrator, 'togglePause' | 'stopCard' | 'guideCard'> | undefined, log: string[]): RunUi {
  const quiet = o.quiet || !process.stdout.isTTY || !tuiUsable();
  if (o.screen || fullScreenRun(config, quiet)) {
    const tui = createTui({ getBoard: () => board, getAgents: agents, icons: resolveIcons(config.tui.icons), onInterrupt, controls, mouse: config.tui.mouse, screen: o.screen?.(), notes: log });
    return {
      fullScreen: true,
      update: tui.update, setPhase: tui.setPhase, close: () => { tui.close(); },
      note: (msg, n) => { if (n?.whole) for (const line of logRows(msg)) tui.note(line); else tui.note(msg); },
      ask: async (q) => {
        // The log keeps a record of what was asked. Its pane cuts long lines, so details are broken up there.
        for (const d of q.details ?? []) for (const line of logRows(d)) tui.note(line);
        if (q.review) return tui.reviewPlan({ ...q.review, history: q.history, suggest: q.suggest, signal: q.signal });
        if (q.typed) return (await tui.approve({ ...q.typed, signal: q.signal })) ? q.typed.word : undefined;
        return undefined;
      },
    };
  }
  // The table is up while agents run and comes down for a question; the next phase brings it back.
  let view: LiveView | undefined;
  // Cards may still run while a question is open: their log lines wait for the answer instead of breaking the prompt line.
  let held: Array<{ msg: string; whole?: boolean }> | undefined;
  const show = () => { if (!quiet && !view) view = createLiveView(() => board, agents); };
  const hide = () => { view?.stop(); view = undefined; };
  // Messages carry what agents and board files say: made plain before they reach the terminal.
  const note = (msg: string, n?: { whole?: boolean }) => {
    if (held) { held.push({ msg, whole: n?.whole }); return; }
    if (view) { for (const line of n?.whole ? logRows(msg) : [msg]) view.note(line); return; }
    console.log(printable(n?.whole ? `${dim(clockTime())} ${plainText(msg)}` : logLine(`${dim(clockTime())} ${plainLines(msg)}`, terminalWidth(200))));
  };
  process.on('SIGINT', onInterrupt);
  show();
  return {
    update: () => view?.update(),
    note,
    setPhase: (phase) => { if (phase !== 'plan ready') show(); },
    async ask(q) {
      hide();
      console.log();
      if (!q.brief) { printBoard(board); console.log(); }
      console.log(q.intro);
      held = [];
      try {
        return await ask(`${bold(cyan(q.label))} ${dim('›')} `, { suggest: q.suggest, history: q.history, signal: q.signal });
      } finally {
        const lines = held;
        held = undefined;
        for (const { msg, whole } of lines) note(msg, { whole });
      }
    },
    close() {
      hide();
      process.off('SIGINT', onInterrupt);
    },
  };
}

/** What the plan pause needs of a run; tests give it a stand-in. */
export interface PlanPauseRun {
  ui: RunUi;
  orch: Pick<Orchestrator, 'plan'>;
  /** Ctrl-C stopped the run. */
  aborted: boolean;
  /** The view again, after the plan editor had the terminal. */
  reopen(): RunUi;
}

interface Run extends PlanPauseRun {
  orch: Orchestrator;
}

function startRun(repoRoot: string, board: Board, config: Config, o: RunOptions): Run {
  if (!o.silent) console.log(`${bold(cyan('dulger'))} run ${plainText(board.runId)} on ${dim(repoRoot)} (harness: ${config.harness}, concurrency: ${config.concurrency})`);
  const run = { aborted: false } as Run;
  // One log for the run: a view reopened after the plan editor goes on with it.
  const log: string[] = [];
  let orch: Orchestrator | undefined;
  const onInterrupt = () => {
    run.aborted = true;
    run.ui.note(red('interrupted — stopping agents, saving board…'));
    orch?.abort();
    if (!o.interactive) setTimeout(() => process.exit(130), 3000).unref();
  };
  run.reopen = () => createUi(repoRoot, board, config, o, () => orch?.registry.statuses.values() ?? [], onInterrupt, { togglePause: () => run.orch.togglePause(), stopCard: (id) => run.orch.stopCard(id), guideCard: (id, text) => run.orch.guideCard(id, text) }, log);
  run.ui = run.reopen();
  try {
    orch = createOrchestrator(repoRoot, board, config, { log: (msg) => run.ui.note(msg), onBoardChange: () => run.ui.update(), approveCommands: approveReplanCommands(o, () => run.ui) });
  } catch (err) {
    // The view is up already: it comes down (screen, timer, keys) before the error is told, on the shell or in the app.
    run.ui.close();
    throw err;
  }
  run.orch = orch;
  return run;
}

/** Commands for the record, each in backticks as it will run, anything that would hide spelled out. */
const commandList = (commands: string[]) => commands.map((c) => `\`${shownCommand(c)}\``).join(', ') || 'none';

/**
 * The person's go for verify commands a replan adds. Their own --yes accepts them. On a terminal they are
 * asked, and only a typed `yes` approves: the question can appear while they are moving around the board,
 * so Enter, another word, or a dismissed question never runs a new shell command. Otherwise nobody can say yes.
 */
export function approveReplanCommands(o: Pick<RunOptions, 'assumeYes'>, ui: () => Pick<RunUi, 'ask' | 'note' | 'setPhase'>, terminal = Boolean(process.stdin.isTTY)): NonNullable<OrchestratorHooks['approveCommands']> {
  return async (commands, cards, signal) => {
    if (o.assumeYes) {
      ui().note(yellow(`--yes: accepted the replan's new verify commands: ${commandList(commands)}`), { whole: true });
      return true;
    }
    if (!terminal) {
      ui().note(yellow('nobody can approve new verify commands here (stdin is not a terminal); --yes accepts them'));
      return false;
    }
    const using = (c: string) => cards.filter((k) => k.verify.some((v) => v.trim() === c));
    const usedBy = (c: string) => using(c).map((k) => `${plainText(k.id)} ${plainText(k.title)}`).join(', ');
    const cardsUsing = (c: string) => using(c).map((k) => plainText(k.id)).join(', ');
    const details = [
      yellow('The replan adds verify commands nobody has approved; dulger would run them in a shell:'),
      ...commands.map((c) => `  ${plainText(shownCommand(c))}  ${dim(`for ${usedBy(c)}`)}`),
    ];
    const answer = await ui().ask({
      label: 'approve', details, history: [], signal,
      intro: `${details.join('\n')}\nType ${bold('yes')} to run them and apply the replan. Anything else drops the replan; running cards carry on.`,
      hint: `type ${bold('yes')} to run the new verify commands listed in the log · anything else drops the replan`,
      // The dialog: the commands whole, the cards each is for, the word to type. Help says the rest.
      typed: {
        title: 'New verify commands',
        message: '',
        items: commands.map((c) => ({ command: c, detail: cardsUsing(c) })),
        word: 'yes',
        prompt: 'type yes',
        confirm: 'Run', cancel: 'Drop',
      },
    });
    ui().setPhase('running');
    return answer?.trim().toLowerCase() === 'yes';
  };
}

const PLAN_INTRO = `${dim('Reply to change the plan (same planner session).')} ${bold('Enter')} or ${bold('go')} dispatches, ${bold('cancel')} deletes the run, Ctrl-C keeps it in the backlog. Type /edit to edit cards directly.`;
const PLAN_HINT = `${bold('⏎')} dispatch · /edit cards · type to revise the plan · ${bold('cancel')} · ${bold('^c')} keep in the backlog`;

export type Reply = { kind: 'go' } | { kind: 'cancel' } | { kind: 'revise'; text: string };

/** What a line typed at the plan prompt means: an empty line or a word of assent dispatches. */
export function readReply(line: string): Reply {
  const text = line.trim();
  if (!text || /^(go|run|dispatch|yes|y)$/i.test(text)) return { kind: 'go' };
  if (/^(cancel|abort|drop|discard)$/i.test(text)) return { kind: 'cancel' };
  return { kind: 'revise', text };
}

/** What a line typed at the plan asks for, `/edit` included; the full-screen review confirms a cancel with it. */
export function planAction(line: string): ReplyKind {
  return line.trim() === '/edit' ? 'edit' : readReply(line).kind;
}

/** The words the plan takes, as the prediction lists them: true wherever the run was started. */
const PLAN_WORDS: Candidate[] = [
  { text: 'go', description: 'dispatch the plan as it stands (Enter does the same)' },
  { text: 'cancel', description: 'delete this run and its plan (asks first)' },
  { text: '/edit', description: 'change cards, tasks and verify commands yourself' },
];

/** What Tab completes at the plan: `go`, `cancel` and `/edit`, as the first word of the line. */
export function suggestReply(line: string): Suggestion {
  if (/\s/.test(line)) return NO_SUGGESTION;
  const typed = line.toLowerCase();
  const candidates = PLAN_WORDS.filter((w) => w.text.startsWith(typed));
  if (!candidates.length) return NO_SUGGESTION;
  if (!line) return { ghost: `${candidates[0]!.text} `, candidates, partial: '' };
  // The rest of the word every match shares.
  let shared = candidates[0]!.text;
  for (const w of candidates) while (!w.text.startsWith(shared)) shared = shared.slice(0, -1);
  return { ghost: shared.slice(line.length), candidates, partial: line };
}

/** What a revision changed, card by card: the review marks these. */
export function planChanges(before: Card[], after: Card[]): Pick<Revision, 'added' | 'removed' | 'edited'> {
  const key = (k: Card) => JSON.stringify([k.title, k.description, k.acceptanceCriteria, k.dependsOn, k.verify, k.tasks.map((t) => [t.id, t.title, t.instructions, t.complexity ?? null]), k.worker ?? null]);
  const was = new Map(before.map((k) => [k.id, key(k)]));
  const now = new Set(after.map((k) => k.id));
  return {
    added: after.filter((k) => !was.has(k.id)).map((k) => k.id),
    removed: before.filter((k) => !now.has(k.id)).map((k) => k.id),
    edited: after.filter((k) => was.has(k.id) && was.get(k.id) !== key(k)).map((k) => k.id),
  };
}

/**
 * planWarnings as the review lists them: the card and its numbers (`c1: 5 tasks, 4 waiting`). What makes
 * them worth a warning is in the review's help; the plain prompt and the log keep the full sentences.
 */
export function reviewWarnings(cards: Card[]): string[] {
  const out: string[] = [];
  for (const c of cards) {
    const waiting = cards.filter((o) => o.dependsOn.includes(c.id)).length;
    const big = c.tasks.length > 3;
    const foundation = waiting >= 3 && c.tasks.length > 2;
    if (big || foundation) out.push(`${plainText(c.id)}: ${c.tasks.length} tasks${foundation ? `, ${waiting} waiting` : ''}`);
  }
  return out;
}

/** The revision for the plain prompt, which prints its intro instead of a review screen. */
function revisionText(r: Revision): string {
  const changed = [...r.added.map((id) => `${id} (new)`), ...r.edited.map((id) => `${id} (changed)`), ...r.removed.map((id) => `${id} (removed)`)];
  const what = r.failed ? red('the planner could not revise the plan; this is the plan from before (the log says why)')
    : changed.length ? `the planner changed ${plainText(changed.join(', '))}` : 'the planner kept every card as it was';
  return `${dim('You asked:')} ${plainText(r.asked)}\n${dim('Result:')} ${what}`;
}

/**
 * Deleting the run from the plain plan prompt asks first, as the review does: only a typed yes deletes,
 * Enter or anything else keeps it, and nothing typed earlier is recalled.
 */
async function confirmDeletion(ui: RunUi, board: Board): Promise<boolean> {
  const answer = await ui.ask({
    label: 'delete', brief: true, history: [],
    intro: `${yellow(`Delete run ${plainText(board.runId)}, its plan and its branch ${plainText(board.runBranch)}?`)} Nothing has been built yet. Type ${bold('yes')} to delete it; Enter or anything else keeps it.`,
    hint: `type ${bold('yes')} to delete the run · anything else keeps it`,
  });
  return /^(y|yes)$/i.test(answer?.trim() ?? '');
}

/**
 * The pause after planning, as a conversation: every reply revises the plan in the planner's own
 * session until the person dispatches or cancels. Ctrl-C leaves the run in the backlog, also while the
 * planner revises it. Exported for tests.
 */
export async function converse(run: PlanPauseRun, repoRoot: string, board: Board, config: Config, o: RunOptions): Promise<'go' | 'cancel' | 'backlog'> {
  // From the app (silent) the person did not type a command and has no shell beside it: the board file is not theirs to edit.
  const intro = o.silent ? PLAN_INTRO : `${PLAN_INTRO} ${dim(`Edit ${store.boardPath(repoRoot, board.runId)} by hand if you prefer.`)}`;
  let revision: Revision | undefined;
  while (true) {
    run.ui.setPhase('plan ready');
    const line = await run.ui.ask({
      label: 'plan', intro: revision ? `${revisionText(revision)}\n${intro}` : intro, hint: PLAN_HINT, suggest: suggestReply,
      review: { read: planAction, warnings: reviewWarnings(board.cards), revision },
    });
    if (line === undefined) return 'backlog';
    if (line.trim() === '/edit') {
      revision = undefined;
      const full = run.ui.fullScreen;
      run.ui.close();
      let saved = false;
      try { saved = full ? await editInApp(repoRoot, board, config, o) : await editPlan(repoRoot, board, config); } finally { run.ui = run.reopen(); }
      if (saved) run.ui.note('plan edited by you');
      continue;
    }
    const reply = readReply(line);
    // The review confirmed a cancel before answering it; the plain prompt asks here.
    if (reply.kind === 'cancel' && !run.ui.fullScreen && !(await confirmDeletion(run.ui, board))) {
      run.ui.note('the run is kept');
      continue;
    }
    if (reply.kind !== 'revise') return reply.kind;
    run.ui.setPhase(REVISING);
    const before = structuredClone(board.cards);
    let failed = false;
    await run.orch.plan(reply.text).catch((err: Error) => { failed = true; run.ui.note(red('error: ') + err.message); });
    // A revision that did not happen leaves the plan from before, which is ready as it was.
    if ((failed || run.aborted) && board.cards.length && board.checkpoint?.phase === 'planning') {
      checkpoint(board, 'ready');
      store.saveBoard(repoRoot, board);
    }
    // Ctrl-C while the planner revised it: the plan stays as it was, in the backlog.
    if (run.aborted) return 'backlog';
    revision = { asked: reply.text, failed, ...planChanges(before, board.cards) };
  }
}

/**
 * The app's plan editor, full-screen, while the run holds its lock (the editor leaves the lock alone);
 * the board's cards are read back afterwards, as editPlan leaves them. True when the plan was saved.
 */
async function editInApp(repoRoot: string, board: Board, config: Config, o: RunOptions): Promise<boolean> {
  // Loaded here: the app reaches this module through its launcher, so a static import would be a cycle.
  const [{ runPage }, { createPlanEditPage }] = await Promise.all([import('./app/index.ts'), import('./app/pages/planEdit.ts')]);
  let saved = false;
  try {
    await runPage({
      repoRoot, config: () => config, openScreen: o.screen, icons: resolveIcons(config.tui.icons),
      page: (ctx) => createPlanEditPage(ctx, board.runId, { lockHeld: true, done: (s) => { saved = s; } }),
    });
  } finally {
    board.cards = store.loadBoard(repoRoot, board.runId).cards;
  }
  return saved;
}

/** Dispatch the cards, then close the view and print what happened. */
async function executeRun(run: Run, repoRoot: string, board: Board, o: RunOptions): Promise<RunOutcome> {
  try {
    run.ui.setPhase('running');
    await run.orch.execute();
  } finally {
    run.ui.close();
  }
  const landed = board.cards.filter((c) => c.status === 'done').length;
  let mergedInto: string | undefined;
  if (o.merge && landed > 0 && !run.aborted && !board.halted) {
    if (!ownBranch(board)) throw new CliError(`The board names ${plainText(board.runBranch)} as its result branch, not dulger/${plainText(board.runId)}; merge it yourself after checking it.`);
    assertMergeReady(repoRoot, board);
    if (!git.isClean(repoRoot)) throw new CliError('Working tree has uncommitted changes; commit them before merging.');
    git.git(repoRoot, ['merge', '--no-edit', board.runBranch]);
    mergedInto = git.currentBranch(repoRoot);
  }
  if (!o.silent) {
    console.log();
    process.stdout.write(report(repoRoot, board, { mergedInto }));
    const failed = board.cards.filter((c) => c.status !== 'done' && c.status !== 'replaced');
    if (failed.length) console.log(dim(`  failed worktrees kept in ${join(worktreesDir(repoRoot), board.runId)}/`));
  }
  return { landed, aborted: run.aborted || Boolean(board.halted) };
}

function leaveInBacklog(run: Run, board: Board, o: RunOptions): RunOutcome {
  run.ui.close();
  const id = plainText(board.runId);
  if (!o.silent) console.log(dim(board.cards.length ? `not dispatched; \`dulger resume ${id}\` runs it later` : `interrupted while planning; \`dulger resume ${id}\` plans it again`));
  return { landed: 0, aborted: true };
}

/** Off a terminal nobody saw the plan or its verify commands: it waits in the backlog for an explicit go. */
function leaveUnreviewed(run: Run, board: Board): RunOutcome {
  run.ui.close();
  console.log();
  printBoard(board);
  console.log(`\n${yellow('not dispatched: nobody could review the plan here (stdin is not a terminal)')}`);
  const id = plainText(board.runId);
  console.log(dim(`\`dulger resume ${id}\` dispatches it as it is (\`dulger board ${id}\` shows it again); rerun with --yes to dispatch without a review`));
  return { landed: 0, aborted: true };
}

/**
 * The result branch dulger gave the run. The board file says which branch that is, and a board file is
 * only data: a name it holds is given to git (deleted, merged, diffed) only when it is that one, so it
 * can never be another branch, nor read as an option.
 */
export function ownBranch(board: Pick<Board, 'runId' | 'runBranch'>): boolean {
  return typeof board.runBranch === 'string' && board.runBranch === `dulger/${board.runId}` && !board.runBranch.startsWith('-');
}

function cancelRun(run: Run, repoRoot: string, board: Board, o: RunOptions): RunOutcome {
  run.ui.close();
  store.removeRun(repoRoot, board.runId);
  if (ownBranch(board)) git.deleteBranch(repoRoot, board.runBranch);
  else if (!o.silent) console.log(yellow(`left the branch ${plainText(board.runBranch)} alone: the run's own would be dulger/${plainText(board.runId)}`));
  if (!o.silent) console.log(dim(`run ${plainText(board.runId)} deleted`));
  return { landed: 0, aborted: true };
}

/**
 * A run's board as its directory holds it. A board that names itself another run was edited by hand:
 * its id would point the run's files, lock and branch elsewhere, so it is refused.
 */
function loadRun(repoRoot: string, id: string): Board {
  const board = store.loadBoard(repoRoot, id);
  if (board.runId !== id) throw new CliError(`The board of run ${id} names itself ${JSON.stringify(plainText(String(board.runId)))}; it was edited by hand. Set its runId back to ${id} before running it.`);
  return board;
}

/** Plan (when fresh), talk the plan through unless --yes (off a terminal it needs --yes), then execute. */
export async function runBoard(repoRoot: string, board: Board, config: Config, o: RunOptions): Promise<RunOutcome> {
  const release = acquireRunLock(repoRoot, board.runId);
  let run: Run | undefined;
  try {
    // Reload under the lock: a different process may have completed work since the menu opened.
    if (!o.fresh) Object.assign(board, loadRun(repoRoot, board.runId));
    // The snapshot leaves the sandbox out: it is this machine's policy, whatever the run was saved with.
    config = { ...snapshotSettings(config).config, sandbox: config.sandbox };
    if (!o.fresh) {
      const original = originalSettings(board, config);
      const changes = settingsChanges(original, config);
      if (board.settings && changes.length && !o.currentSettings && !o.settingsChosen && o.interactive && !o.quiet && process.stdin.isTTY && process.stdout.isTTY) {
        const answer = await select({ title: 'Resume settings', description: `Current settings differ in: ${changes.join(', ')}.`, choices: [
          { value: 'original', label: 'Keep original run settings' },
          { value: 'inspect', label: 'Inspect setting differences' },
          { value: 'current', label: 'Use current settings for this run' },
        ] });
        if (!answer) return { landed: 0, aborted: true };
        if (answer === 'inspect') {
          await pager('Setting differences', changes.map((key) => `${key}\nOriginal: ${JSON.stringify(original[key as keyof Config], null, 2)}\nCurrent: ${JSON.stringify(config[key as keyof Config], null, 2)}`).join('\n\n'));
          const apply = await select({ title: 'Choose resume settings', choices: [{ value: 'original', label: 'Keep original run settings' }, { value: 'current', label: 'Use current settings for this run' }] });
          if (!apply) return { landed: 0, aborted: true };
          o = { ...o, currentSettings: apply === 'current' };
        } else o = { ...o, currentSettings: answer === 'current' };
      }
      if (!o.currentSettings) config = original;
    }
    if (process.stdin.isTTY && !o.silent) await ensureKeys(config);
    requirePreflight(repoRoot, config);
    o.prepare?.(board);
    board.settings = snapshotSettings(config);
    store.saveBoard(repoRoot, board);
    run = startRun(repoRoot, board, config, o);
    if (o.fresh || !board.cards.length) {
      run.ui.setPhase('planning');
      // Ctrl-C while planning is a stop, not a failure: the run waits, and resume plans it again.
      try { await run.orch.plan(); } catch (err) { if (!run.aborted) throw err; }
      if (run.aborted) return leaveInBacklog(run, board, o);
      if (!o.yes && process.stdin.isTTY) {
        switch (await converse(run, repoRoot, board, config, o)) {
          case 'backlog': return leaveInBacklog(run, board, o);
          case 'cancel': return cancelRun(run, repoRoot, board, o);
          case 'go': board.cards = store.loadBoard(repoRoot, board.runId).cards;
        }
      } else if (!o.yes && !o.assumeYes) return leaveUnreviewed(run, board);
      else run.ui.note(yellow(`--yes: dispatching without a review; verify commands: ${commandList(verifyCommands(board.cards))}`), { whole: true });
    }
    const issues = cardModelIssues(config, board.cards);
    if (issues.length) throw new CliError(issues.join('\n'));
    return await executeRun(run, repoRoot, board, o);
  } finally { run?.ui.close(); release(); }
}

/** Plan a new run for the goal in a conversation with the planner, then execute it. */
export function orderRun(repoRoot: string, goal: string, config: Config, o: Omit<RunOptions, 'yes' | 'fresh'>): Promise<RunOutcome> {
  return runBoard(repoRoot, createBoard(repoRoot, goal), config, { ...o, yes: false, fresh: true });
}

export async function resumeRun(repoRoot: string, config: Config, runId: string | undefined, o: Omit<RunOptions, 'yes' | 'fresh'>): Promise<RunOutcome> {
  const board = loadRun(repoRoot, latestRun(repoRoot, runId));
  return runBoard(repoRoot, board, config, { ...o, yes: Boolean(board.cards.length), fresh: false, prepare: (b) => { resetInterrupted(b); } });
}

/** Give one failed card another round (its last rejection is its first task), then run the board on. */
export async function retryRun(repoRoot: string, config: Config, cardId: string | undefined, runId: string | undefined, o: Omit<RunOptions, 'yes' | 'fresh'>): Promise<RunOutcome> {
  if (!cardId) throw new CliError('dulger retry needs a card id, e.g. dulger retry c7');
  const board = loadRun(repoRoot, latestRun(repoRoot, runId));
  return runBoard(repoRoot, board, config, { ...o, yes: true, fresh: false, prepare: (b) => { retryCard(b, cardId); resetInterrupted(b); } });
}

/** The end-of-run report, with the diff stat when the result branch still exists. */
export function report(repoRoot: string, board: Board, o: { mergedInto?: string; full?: boolean } = {}): string {
  // Names from the board file go to git only when they cannot be read as options.
  const safe = ownBranch(board) && typeof board.baseRef === 'string' && !board.baseRef.startsWith('-');
  const diffStat = safe && git.branchExists(repoRoot, board.runBranch) ? git.diffStat(repoRoot, board.baseRef, board.runBranch) : undefined;
  return buildReport(board, { diffStat, mergedInto: o.mergedInto, full: o.full, width: terminalWidth() });
}

export function showBoard(repoRoot: string, runId?: string): void {
  printBoard(store.loadBoard(repoRoot, latestRun(repoRoot, runId)));
}

export function showReport(repoRoot: string, runId?: string, o: { full?: boolean } = {}): void {
  process.stdout.write(report(repoRoot, store.loadBoard(repoRoot, latestRun(repoRoot, runId)), o));
}

export function showRuns(repoRoot: string): void {
  const runs = runSummaries(repoRoot);
  if (!runs.length) { console.log(dim('no runs yet')); return; }
  for (const r of runs) {
    if (!r.readable) { console.log(printable(fit(`${plainText(r.id)}  ${red('unreadable board')}  ${dim(plainText(r.error))}`, terminalWidth()))); continue; }
    console.log(printable(fit(`${plainText(r.id)}  ${r.cards.done}/${r.cards.total} done  ${r.spend}  ${dim(plainText(r.goal))}`, terminalWidth())));
  }
}

/** Merge a run's result branch into the current branch. */
export function mergeRun(repoRoot: string, runId?: string): void {
  const merged = mergeRunBranch(repoRoot, runId);
  console.log(green(`merged ${plainText(merged.branch)} into ${plainText(merged.into)}`));
}

/** The result itself is ready to merge: verified, current, documented. The checkout is checked separately. */
function assertMergeReady(root: string, board: Board): void {
  const blocker = mergeBlockers(root, board).find((b) => RESULT_BLOCKERS.includes(b.code));
  if (blocker) throw new CliError(blocker.message);
}

/**
 * Make `dir` something dulger can run in: a git repository with at least one commit. Creates the
 * repository when there is none and commits whatever is there (except .dulger/) when the branch
 * is still unborn. A repository that already has commits is left alone.
 */
export function initRepo(dir: string): void {
  let repoRoot: string;
  try {
    repoRoot = git.repoRoot(dir);
    console.log(dim(`already a git repository: ${repoRoot}`));
  } catch {
    git.git(dir, ['init', '--quiet']);
    repoRoot = git.repoRoot(dir);
    console.log(green(`initialised git repository in ${repoRoot}`));
  }
  git.excludeFromGit(repoRoot, [`${STATE_DIR}/*`, `!${STATE_DIR}/context`, `!${STATE_DIR}/config.json`], [`${STATE_DIR}/`]);
  if (git.hasCommits(repoRoot)) { console.log(dim(`${git.currentBranch(repoRoot)} already has commits; nothing to do`)); return; }
  git.git(repoRoot, ['add', '-A', '--', '.', `:(exclude)${STATE_DIR}`]);
  const staged = git.git(repoRoot, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  try {
    git.git(repoRoot, ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'Initial commit']);
  } catch (err) {
    if (err instanceof git.GitError && /tell me who you are|user\.(name|email)/i.test(err.stderr)) {
      throw new CliError('git has no identity configured; set user.name and user.email (git config --global user.name "…"), then rerun dulger init');
    }
    throw err;
  }
  console.log(green(`committed ${staged.length} file(s) as the initial commit on ${git.currentBranch(repoRoot)}`));
}

export function clean(repoRoot: string): void {
  for (const line of cleanLeftovers(repoRoot)) console.log(line);
}

export function memoryCommand(repoRoot: string, config: Config, sub: string, args: string[]): void {
  switch (sub) {
    case 'list': {
      const { path, items } = listMemory(repoRoot, config);
      if (items.length === 0) { console.log(dim(`no learnings yet (${path})`)); return; }
      for (const l of items) console.log(formatLearning(l));
      console.log(dim(`\n${items.length} learning(s) in ${path}`));
      return;
    }
    case 'add': {
      const added = addMemory(repoRoot, config, args[0] ?? '');
      console.log(added ? green(`added ${added.id}`) : yellow('already known'));
      return;
    }
    case 'rm': {
      const id = args[0] ?? '';
      console.log(removeMemory(repoRoot, config, id) ? green(`removed ${id}`) : yellow(`no learning with id ${id}`));
      return;
    }
    case 'compact': {
      const { kept, dropped, merged } = compactMemory(repoRoot, config);
      for (const l of dropped) console.log(dim(`dropped ${plainText(l.id)}: ${plainText(l.text)}`));
      console.log(`${kept} kept, ${dropped.length} dropped, ${merged} duplicate sighting${merged === 1 ? '' : 's'} folded`);
      return;
    }
    case 'path':
      console.log(memoryPath(repoRoot, config.memory));
      return;
    default:
      throw new CliError(`unknown memory command "${sub}"`);
  }
}

/** What agents learned, as `dulger memory list` prints it; the text is theirs, so it is made plain. */
function formatLearning(l: Learning): string {
  const meta = dim(`${plainText(String(l.lastSeenAt).slice(0, 10))} ×${l.seen} ${plainText(l.runId)}/${plainText(l.cardId)}`);
  const files = l.files.slice(0, 3).map((f) => plainText(f)).join(', ') + (l.files.length > 3 ? ', …' : '');
  return `${cyan(plainText(l.id))} ${meta}\n  ${plainText(l.text)}${files ? dim(`  [${files}]`) : ''}`;
}

/**
 * The board as the plain variants print it, for the person deciding whether to dispatch. Everything on
 * it came from the planner or a board file, so it is made plain first: an escape in a title could
 * otherwise hide the cards after it, verify commands included.
 */
export function printBoard(board: Board, width = terminalWidth()): void {
  console.log(printable(fit(bold(`Board ${plainText(board.runId)}`) + dim(`  goal: ${plainText(board.goal)}`), width)));
  console.log(renderBoard(board, width).join('\n'));
  for (const c of board.cards) {
    const deps = c.dependsOn.length ? dim(` after ${plainText(c.dependsOn.join(','))}`) : '';
    console.log(printable(fit(`  ${bold(plainText(c.id))} ${plainText(c.title)}${deps}`, width)));
    for (const t of c.tasks) console.log(printable(fit(dim(`     ${plainText(t.id)} ${plainText(t.title)}`), width)));
    // dulger runs these in a shell and dispatching approves them: shown whole, never cut to the width, and
    // spelled out as the full-screen review shows them (a newline as \n, a right-to-left override as \u{202e}).
    for (const v of c.verify) console.log(dim(`     $ ${shownCommand(v)}`));
    if (c.progress && (c.status === 'in_progress' || c.status === 'review')) {
      const p = c.progress;
      const ago = dim(` (${fmtDuration(Math.max(0, Date.now() - Date.parse(p.at)))} ago)`);
      console.log(printable(fit(cyan(`     ◔ ${plainText(p.note)}`) + (p.attention ? yellow(` — ${plainText(p.attention)}`) : '') + ago, width)));
    }
    const notes = c.reviewNotes?.length ?? 0;
    if (notes) console.log(yellow(`     ${notes} reviewer note${notes === 1 ? '' : 's'}`) + dim(' (dulger report --full lists them)'));
  }
  printPlanNotes(board, width);
}

/** What the planner decided on its own and what it left out: read this before dispatching. */
export function printPlanNotes(board: Board, width = terminalWidth()): void {
  const p = board.plan;
  if (!p) return;
  const hanging = (label: string, text: string, paint: (s: string) => string) => {
    const indent = ' '.repeat(label.length + 3);
    for (const [i, line] of wrap(text, width - indent.length).entries()) console.log(paint(i ? indent + line : `  ${label} ${line}`));
  };
  for (const a of p.assumptions) hanging('assumes:', a, yellow);
  for (const o of p.omitted) hanging('left out:', o, red);
}
