// What the CLI and the interactive prompt both do: run boards, print them, curate memory, clean up.
// Errors meant for the user are thrown as CliError; the callers decide whether to exit or to carry on.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, type Config } from './config.ts';
import * as store from './board/store.ts';
import { resetInterrupted } from './board/scheduler.ts';
import * as git from './git/worktree.ts';
import { createOrchestrator } from './runner/orchestrator.ts';
import { createBoard } from './board/create.ts';
import { extractPaths, openMemory, type Learning } from './context/memory.ts';
import { worktreesDir } from './paths.ts';
import { createLiveView, renderBoard, type LiveView } from './ui/table.ts';
import { buildReport } from './ui/report.ts';
import { ask } from './ui/prompt.ts';
import { bold, cyan, dim, green, red, yellow, fmtSpend } from './ui/ansi.ts';
import type { Board } from './types.ts';

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

export async function runBoard(repoRoot: string, board: Board, config: Config, o: RunOptions): Promise<RunOutcome> {
  console.log(`${bold(cyan('dulger'))} run ${board.runId} on ${dim(repoRoot)} (harness: ${config.harness}, concurrency: ${config.concurrency})`);
  const quiet = o.quiet || !process.stdout.isTTY;
  let view: LiveView | undefined;
  const log = (msg: string) => (view ? view.note(msg) : console.log(`${dim(new Date().toISOString().slice(11, 19))} ${msg}`));
  const orch = createOrchestrator(repoRoot, board, config, { log, onBoardChange: () => view?.update() });
  const agents = () => orch.registry.statuses.values();
  if (!quiet) view = createLiveView(() => board, agents);

  let aborted = false;
  const onSigint = () => {
    aborted = true;
    log(red('interrupted — stopping agents, saving board…'));
    orch.abort();
    if (!o.interactive) setTimeout(() => process.exit(130), 3000).unref();
  };
  process.once('SIGINT', onSigint);

  try {
    if (o.fresh) {
      await orch.plan();
      view?.stop();
      view = undefined;
      printBoard(board);
      if (!o.yes) {
        const path = store.boardPath(repoRoot, board.runId);
        console.log(`\nEdit ${cyan(path)} if you like, then press ${bold('Enter')} to dispatch (Ctrl-C to leave it in the backlog).`);
        if (process.stdin.isTTY) {
          const answer = await ask('');
          if (answer === undefined) {
            console.log(dim(`not dispatched; \`dulger resume ${board.runId}\` runs it later`));
            return { landed: 0, aborted: true };
          }
        } else {
          console.log('(non-interactive: continuing)');
        }
        board.cards = store.loadBoard(repoRoot, board.runId).cards;
      }
      if (!quiet) view = createLiveView(() => board, agents);
    }
    await orch.execute();
  } finally {
    view?.stop();
    process.off('SIGINT', onSigint);
  }

  console.log();
  printBoard(board);
  const landed = board.cards.filter((c) => c.status === 'done').length;
  let mergedInto: string | undefined;
  if (o.merge && landed > 0 && !aborted) {
    git.git(repoRoot, ['merge', '--no-edit', board.runBranch]);
    mergedInto = git.currentBranch(repoRoot);
  }
  console.log();
  process.stdout.write(report(repoRoot, board, mergedInto));
  const failed = board.cards.filter((c) => c.status !== 'done' && c.status !== 'replaced');
  if (failed.length) console.log(dim(`  failed worktrees kept in ${join(worktreesDir(repoRoot), board.runId)}/`));
  return { landed, aborted };
}

export async function resumeRun(repoRoot: string, config: Config, runId: string | undefined, o: Omit<RunOptions, 'yes' | 'fresh'>): Promise<RunOutcome> {
  const board = store.loadBoard(repoRoot, latestRun(repoRoot, runId));
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
export function report(repoRoot: string, board: Board, mergedInto?: string): string {
  const diffStat = git.branchExists(repoRoot, board.runBranch) ? git.diffStat(repoRoot, board.baseRef, board.runBranch) : undefined;
  return buildReport(board, { diffStat, mergedInto });
}

export function showBoard(repoRoot: string, runId?: string): void {
  printBoard(store.loadBoard(repoRoot, latestRun(repoRoot, runId)));
}

export function showReport(repoRoot: string, runId?: string): void {
  process.stdout.write(report(repoRoot, store.loadBoard(repoRoot, latestRun(repoRoot, runId))));
}

export function showRuns(repoRoot: string): void {
  const ids = store.listRuns(repoRoot);
  if (!ids.length) { console.log(dim('no runs yet')); return; }
  for (const id of ids) {
    const b = store.loadBoard(repoRoot, id);
    const done = b.cards.filter((c) => c.status === 'done').length;
    console.log(`${id}  ${done}/${b.cards.length} done  ${fmtSpend(b)}  ${dim(b.goal)}`);
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

export function printBoard(board: Board): void {
  console.log(bold(`Board ${board.runId}`) + dim(`  goal: ${board.goal}`));
  console.log(renderBoard(board, Math.max(60, process.stdout.columns ?? 100)).join('\n'));
  for (const c of board.cards) {
    const deps = c.dependsOn.length ? dim(` after ${c.dependsOn.join(',')}`) : '';
    console.log(`  ${bold(c.id)} ${c.title}${deps}`);
    for (const t of c.tasks) console.log(dim(`     ${t.id} ${t.title}`));
    for (const n of c.reviewNotes ?? []) console.log(yellow(`     note: ${n}`));
  }
  printPlanNotes(board);
}

/** What the planner decided on its own and what it left out: read this before dispatching. */
export function printPlanNotes(board: Board): void {
  const p = board.plan;
  if (!p) return;
  for (const a of p.assumptions) console.log(yellow(`  assumes: ${a}`));
  for (const o of p.omitted) console.log(red(`  left out: ${o}`));
}

/**
 * Plan with the planner in a conversation: show the board, take feedback, revise in the same session,
 * until the person says go (dispatch) or cancel (delete the run). Ctrl-C leaves the run in the backlog.
 */
export async function orderRun(repoRoot: string, goal: string, config: Config, o: Omit<RunOptions, 'yes' | 'fresh'>): Promise<RunOutcome> {
  const board = createBoard(repoRoot, goal);
  const log = (msg: string) => console.log(`${dim(new Date().toISOString().slice(11, 19))} ${msg}`);
  const orch = createOrchestrator(repoRoot, board, config, { log });
  await orch.plan();
  while (true) {
    console.log();
    printBoard(board);
    console.log(dim(`\nReply to change the plan (same planner session). ${bold('go')} dispatches, ${bold('cancel')} deletes the run, Ctrl-C keeps it in the backlog. Edit ${store.boardPath(repoRoot, board.runId)} by hand if you prefer.`));
    const answer = await ask(`${bold(cyan('order'))} ${dim('›')} `);
    if (answer === undefined) {
      console.log(dim(`kept in the backlog; \`dulger resume ${board.runId}\` runs it later`));
      return { landed: 0, aborted: true };
    }
    const text = answer.trim();
    if (!text) continue;
    if (/^\/?(go|run|dispatch|yes|y)$/i.test(text)) break;
    if (/^\/?(cancel|abort|drop|discard)$/i.test(text)) {
      store.removeRun(repoRoot, board.runId);
      git.deleteBranch(repoRoot, board.runBranch);
      console.log(dim(`run ${board.runId} deleted`));
      return { landed: 0, aborted: true };
    }
    try {
      await orch.plan(text);
    } catch (err) {
      console.error(red('error: ') + (err as Error).message);
    }
  }
  board.cards = store.loadBoard(repoRoot, board.runId).cards;
  return runBoard(repoRoot, board, config, { ...o, yes: true, fresh: false });
}
