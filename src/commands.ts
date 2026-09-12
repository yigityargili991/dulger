// What the CLI and the interactive prompt both do: run boards, print them, curate memory, clean up.
// Errors meant for the user are thrown as CliError; the callers decide whether to exit or to carry on.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, type Config } from './config.ts';
import * as store from './board/store.ts';
import { resetInterrupted, retryCard } from './board/scheduler.ts';
import * as git from './git/worktree.ts';
import { createOrchestrator, type Orchestrator } from './runner/orchestrator.ts';
import { createBoard } from './board/create.ts';
import { extractPaths, openMemory, type Learning } from './context/memory.ts';
import { worktreesDir } from './paths.ts';
import { createLiveView, renderBoard, type LiveView } from './ui/table.ts';
import { buildReport } from './ui/report.ts';
import { ask } from './ui/prompt.ts';
import { bold, cyan, dim, green, red, yellow, fmtSpend, terminalWidth } from './ui/ansi.ts';
import { fit, logLine, wrap } from './tui/text.ts';
import { ensureKeys } from './replProviders.ts';
import { createTui, tuiUsable } from './tui/tui.ts';
import { resolveIcons } from './tui/theme.ts';
import type { AgentStatus, Board, Card } from './types.ts';

export class CliError extends Error {}

export interface RunOptions {
  yes: boolean;
  quiet: boolean;
  merge: boolean;
  fresh: boolean;
  /** Inside the interactive prompt: an interrupted run returns instead of exiting the process. */
  interactive?: boolean;
}

export interface RunOutcome {
  landed: number;
  aborted: boolean;
}

/**
 * What a run shows while it happens: the full-screen view on a terminal, the redrawn table when the
 * screen is too small, plain log lines when quiet or piped. Every variant can ask the person a question.
 */
interface RunUi {
  update(): void;
  note(msg: string): void;
  setPhase(phase: string): void;
  /** In the plain variants the board is printed and `intro` explains the choice; the full-screen view shows `hint` instead. */
  ask(q: { label: string; intro: string; hint: string }): Promise<string | undefined>;
  close(): void;
}

function createUi(repoRoot: string, board: Board, config: Config, o: RunOptions, agents: () => Iterable<AgentStatus>, onInterrupt: () => void): RunUi {
  const quiet = o.quiet || !process.stdout.isTTY || !tuiUsable();
  if (!quiet && config.tui.enabled && tuiUsable()) {
    const tui = createTui({ getBoard: () => board, getAgents: agents, icons: resolveIcons(config.tui.icons), onInterrupt });
    return { update: tui.update, note: tui.note, setPhase: tui.setPhase, ask: (q) => tui.ask(q.label, q.hint), close: () => { tui.close(); } };
  }
  // The table is up while agents run and comes down for a question; the next phase brings it back.
  let view: LiveView | undefined;
  const show = () => { if (!quiet && !view) view = createLiveView(() => board, agents); };
  const hide = () => { view?.stop(); view = undefined; };
  process.on('SIGINT', onInterrupt);
  show();
  return {
    update: () => view?.update(),
    note: (msg) => (view ? view.note(msg) : console.log(logLine(`${dim(new Date().toISOString().slice(11, 19))} ${msg}`, terminalWidth(200)))),
    setPhase: (phase) => { if (phase !== 'plan ready') show(); },
    async ask(q) {
      hide();
      console.log();
      printBoard(board);
      console.log(`\n${q.intro}`);
      return ask(`${bold(cyan(q.label))} ${dim('›')} `);
    },
    close() {
      hide();
      process.off('SIGINT', onInterrupt);
    },
  };
}

interface Run {
  ui: RunUi;
  orch: Orchestrator;
  aborted: boolean;
}

function startRun(repoRoot: string, board: Board, config: Config, o: RunOptions): Run {
  console.log(`${bold(cyan('dulger'))} run ${board.runId} on ${dim(repoRoot)} (harness: ${config.harness}, concurrency: ${config.concurrency})`);
  const run = { aborted: false } as Run;
  const onInterrupt = () => {
    run.aborted = true;
    run.ui.note(red('interrupted — stopping agents, saving board…'));
    run.orch.abort();
    if (!o.interactive) setTimeout(() => process.exit(130), 3000).unref();
  };
  let orch: Orchestrator | undefined;
  run.ui = createUi(repoRoot, board, config, o, () => orch?.registry.statuses.values() ?? [], onInterrupt);
  orch = createOrchestrator(repoRoot, board, config, { log: run.ui.note, onBoardChange: run.ui.update });
  run.orch = orch;
  return run;
}

const PLAN_INTRO = `${dim('Reply to change the plan (same planner session).')} ${bold('Enter')} or ${bold('go')} dispatches, ${bold('cancel')} deletes the run, Ctrl-C keeps it in the backlog.`;
const PLAN_HINT = `${bold('⏎')} dispatch · type to revise the plan · ${bold('cancel')} · ${bold('^c')} keep in the backlog`;

export type Reply = { kind: 'go' } | { kind: 'cancel' } | { kind: 'revise'; text: string };

/** What a line typed at the plan prompt means: an empty line or a word of assent dispatches. */
export function readReply(line: string): Reply {
  const text = line.trim();
  if (!text || /^(go|run|dispatch|yes|y)$/i.test(text)) return { kind: 'go' };
  if (/^(cancel|abort|drop|discard)$/i.test(text)) return { kind: 'cancel' };
  return { kind: 'revise', text };
}

/**
 * The pause after planning, as a conversation: every reply revises the plan in the planner's own
 * session until the person dispatches or cancels. Ctrl-C leaves the run in the backlog.
 */
async function converse(run: Run, repoRoot: string, board: Board): Promise<'go' | 'cancel' | 'backlog'> {
  const intro = `${PLAN_INTRO} ${dim(`Edit ${store.boardPath(repoRoot, board.runId)} by hand if you prefer.`)}`;
  while (true) {
    run.ui.setPhase('plan ready');
    const line = await run.ui.ask({ label: 'plan', intro, hint: PLAN_HINT });
    if (line === undefined) return 'backlog';
    const reply = readReply(line);
    if (reply.kind !== 'revise') return reply.kind;
    run.ui.setPhase('revising the plan');
    await run.orch.plan(reply.text).catch((err: Error) => run.ui.note(red('error: ') + err.message));
  }
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
  if (o.merge && landed > 0 && !run.aborted) {
    git.git(repoRoot, ['merge', '--no-edit', board.runBranch]);
    mergedInto = git.currentBranch(repoRoot);
  }
  console.log();
  process.stdout.write(report(repoRoot, board, { mergedInto }));
  const failed = board.cards.filter((c) => c.status !== 'done' && c.status !== 'replaced');
  if (failed.length) console.log(dim(`  failed worktrees kept in ${join(worktreesDir(repoRoot), board.runId)}/`));
  return { landed, aborted: run.aborted || Boolean(board.halted) };
}

function leaveInBacklog(run: Run, board: Board): RunOutcome {
  run.ui.close();
  console.log(dim(`not dispatched; \`dulger resume ${board.runId}\` runs it later`));
  return { landed: 0, aborted: true };
}

function cancelRun(run: Run, repoRoot: string, board: Board): RunOutcome {
  run.ui.close();
  store.removeRun(repoRoot, board.runId);
  git.deleteBranch(repoRoot, board.runBranch);
  console.log(dim(`run ${board.runId} deleted`));
  return { landed: 0, aborted: true };
}

/** Plan (when fresh), talk the plan through unless --yes, then execute. */
export async function runBoard(repoRoot: string, board: Board, config: Config, o: RunOptions): Promise<RunOutcome> {
  if (process.stdin.isTTY) await ensureKeys(config);
  const run = startRun(repoRoot, board, config, o);
  if (o.fresh) {
    try {
      run.ui.setPhase('planning');
      await run.orch.plan();
    } catch (err) {
      run.ui.close();
      throw err;
    }
    if (!o.yes && process.stdin.isTTY) {
      switch (await converse(run, repoRoot, board)) {
        case 'backlog': return leaveInBacklog(run, board);
        case 'cancel': return cancelRun(run, repoRoot, board);
        case 'go': board.cards = store.loadBoard(repoRoot, board.runId).cards; // the board file may have been edited by hand
      }
    }
  }
  return executeRun(run, repoRoot, board, o);
}

/** Plan a new run for the goal in a conversation with the planner, then execute it. */
export function orderRun(repoRoot: string, goal: string, config: Config, o: Omit<RunOptions, 'yes' | 'fresh'>): Promise<RunOutcome> {
  return runBoard(repoRoot, createBoard(repoRoot, goal), config, { ...o, yes: false, fresh: true });
}

export async function resumeRun(repoRoot: string, config: Config, runId: string | undefined, o: Omit<RunOptions, 'yes' | 'fresh'>): Promise<RunOutcome> {
  const board = store.loadBoard(repoRoot, latestRun(repoRoot, runId));
  const reset = resetInterrupted(board);
  if (reset.length) console.log(yellow(`reset ${reset.length} interrupted card(s) to backlog (their worktrees are reused if present)`));
  return runBoard(repoRoot, board, config, { ...o, yes: true, fresh: false });
}

/** Give one failed card another round (its last rejection is its first task), then run the board on. */
export async function retryRun(repoRoot: string, config: Config, cardId: string | undefined, runId: string | undefined, o: Omit<RunOptions, 'yes' | 'fresh'>): Promise<RunOutcome> {
  if (!cardId) throw new CliError('dulger retry needs a card id, e.g. dulger retry c7');
  const board = store.loadBoard(repoRoot, latestRun(repoRoot, runId));
  let card: Card;
  try { card = retryCard(board, cardId); } catch (err) { throw new CliError((err as Error).message); }
  const fix = card.tasks.find((t) => t.status === 'pending' && t.kind === 'fix');
  console.log(yellow(`card ${card.id} back in the backlog with one more review round${fix ? ` (first: ${fix.title}: ${fix.feedback?.at(-1)?.split('\n')[0] ?? ''})` : ''}`));
  const reset = resetInterrupted(board);
  if (reset.length) console.log(yellow(`reset ${reset.length} interrupted card(s) to backlog (their worktrees are reused if present)`));
  return runBoard(repoRoot, board, config, { ...o, yes: true, fresh: false });
}

export function latestRun(repoRoot: string, runId?: string): string {
  const id = runId ?? store.listRuns(repoRoot).at(-1);
  if (!id) throw new CliError('no runs found');
  if (!store.listRuns(repoRoot).includes(id)) throw new CliError(`no run ${id}`);
  return id;
}

/** The end-of-run report, with the diff stat when the result branch still exists. */
export function report(repoRoot: string, board: Board, o: { mergedInto?: string; full?: boolean } = {}): string {
  const diffStat = git.branchExists(repoRoot, board.runBranch) ? git.diffStat(repoRoot, board.baseRef, board.runBranch) : undefined;
  return buildReport(board, { diffStat, mergedInto: o.mergedInto, full: o.full, width: terminalWidth() });
}

export function showBoard(repoRoot: string, runId?: string): void {
  printBoard(store.loadBoard(repoRoot, latestRun(repoRoot, runId)));
}

export function showReport(repoRoot: string, runId?: string, o: { full?: boolean } = {}): void {
  process.stdout.write(report(repoRoot, store.loadBoard(repoRoot, latestRun(repoRoot, runId)), o));
}

export function showRuns(repoRoot: string): void {
  const ids = store.listRuns(repoRoot);
  if (!ids.length) { console.log(dim('no runs yet')); return; }
  for (const id of ids) {
    const b = store.loadBoard(repoRoot, id);
    const done = b.cards.filter((c) => c.status === 'done').length;
    console.log(fit(`${id}  ${done}/${b.cards.length} done  ${fmtSpend(b)}  ${dim(b.goal)}`, terminalWidth()));
  }
}

/** Merge a run's result branch into the current branch. */
export function mergeRun(repoRoot: string, runId?: string): void {
  const board = store.loadBoard(repoRoot, latestRun(repoRoot, runId));
  if (!git.branchExists(repoRoot, board.runBranch)) throw new CliError(`${board.runBranch} no longer exists`);
  if (!git.isClean(repoRoot)) throw new CliError('working tree has uncommitted changes; commit them before merging');
  git.git(repoRoot, ['merge', '--no-edit', board.runBranch]);
  console.log(green(`merged ${board.runBranch} into ${git.currentBranch(repoRoot)}`));
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
  for (const w of git.listWorktrees(repoRoot).filter((w) => w.branch?.startsWith('dulger-wip/'))) {
    git.removeWorktree(repoRoot, w.path);
    console.log(`removed worktree ${w.path} (${w.branch})`);
  }
  for (const dir of [worktreesDir(repoRoot), join(repoRoot, STATE_DIR, 'worktrees')]) {
    if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); console.log(`removed ${dir}`); }
  }
  const wip = git.git(repoRoot, ['branch', '--list', 'dulger-wip/*', '--format=%(refname:short)'], { allowFail: true }).split('\n').filter(Boolean);
  for (const b of wip) { git.git(repoRoot, ['branch', '-D', b], { allowFail: true }); console.log(`deleted branch ${b}`); }
}

export function memoryCommand(repoRoot: string, config: Config, sub: string, args: string[]): void {
  const memory = openMemory(repoRoot, config.memory);
  switch (sub) {
    case 'list': {
      const items = memory.load();
      if (items.length === 0) { console.log(dim(`no learnings yet (${memory.path})`)); return; }
      for (const l of items) console.log(formatLearning(l));
      console.log(dim(`\n${items.length} learning(s) in ${memory.path}`));
      return;
    }
    case 'add': {
      const text = args[0];
      if (!text) throw new CliError('memory add needs a text');
      const added = memory.add([{ text, files: extractPaths(text, repoRoot), runId: 'manual', cardId: 'manual', harness: config.harness }]);
      console.log(added.length ? green(`added ${added[0]!.id}`) : yellow('already known'));
      return;
    }
    case 'rm': {
      const id = args[0];
      if (!id) throw new CliError('memory rm needs an id');
      console.log(memory.remove(id) ? green(`removed ${id}`) : yellow(`no learning with id ${id}`));
      return;
    }
    case 'compact': {
      const { kept, dropped, merged } = memory.compact(repoRoot);
      for (const l of dropped) console.log(dim(`dropped ${l.id}: ${l.text}`));
      console.log(`${kept} kept, ${dropped.length} dropped, ${merged} duplicate sighting${merged === 1 ? '' : 's'} folded`);
      return;
    }
    case 'path':
      console.log(memory.path);
      return;
    default:
      throw new CliError(`unknown memory command "${sub}"`);
  }
}

function formatLearning(l: Learning): string {
  const meta = dim(`${l.lastSeenAt.slice(0, 10)} ×${l.seen} ${l.runId}/${l.cardId}`);
  const files = l.files.slice(0, 3).join(', ') + (l.files.length > 3 ? ', …' : '');
  return `${cyan(l.id)} ${meta}\n  ${l.text}${files ? dim(`  [${files}]`) : ''}`;
}

export function printBoard(board: Board, width = terminalWidth()): void {
  console.log(fit(bold(`Board ${board.runId}`) + dim(`  goal: ${board.goal}`), width));
  console.log(renderBoard(board, width).join('\n'));
  for (const c of board.cards) {
    const deps = c.dependsOn.length ? dim(` after ${c.dependsOn.join(',')}`) : '';
    console.log(fit(`  ${bold(c.id)} ${c.title}${deps}`, width));
    for (const t of c.tasks) console.log(fit(dim(`     ${t.id} ${t.title}`), width));
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
