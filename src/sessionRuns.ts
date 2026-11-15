// Starting work from a session: what a goal, /order, /resume and /retry do at the prompt, up to and
// including the run, and nothing after it. The caller decides what follows (the prompt offers a review
// and merge when cards landed). runBoard still draws the run itself: the plan conversation, the live
// view and its questions. The app passes `silent` and its own screen (SessionRunOptions).
import { CliError } from './errors.ts';
import * as git from './git/worktree.ts';
import * as store from './board/store.ts';
import { createBoard } from './board/create.ts';
import { latestRun } from './runs.ts';
import { resumeRun, retryRun, runBoard, type RunOptions } from './commands.ts';
import type { Screen } from './tui/screen.ts';
import { sessionConfig } from './replModels.ts';
import type { Session } from './repl.ts';

/** The run that was worked on and how it ended: `landed` cards done, `aborted` when stopped, left in the backlog, cancelled or halted. */
export interface SessionRun {
  runId: string;
  runBranch: string;
  landed: number;
  aborted: boolean;
}

const DIRTY = 'working tree has uncommitted changes (commit them, or /dirty on)';

function requireClean(repoRoot: string, session: Session): void {
  if (!session.allowDirty && !git.isClean(repoRoot)) throw new CliError(DIRTY);
}

/** How the app starts a run (RunOptions says more): the line prompt passes none of these. */
export interface SessionRunOptions {
  /** Print nothing on the normal screen around the live view: the app reports the outcome itself. */
  silent?: boolean;
  /** The terminal the full-screen view draws on, lent by the app. */
  screen?: () => Screen;
}

/** The session's flags as run options: its own --yes / /yes on, quiet, never merging, and returning on interrupt. */
function runOptions(session: Session, o: SessionRunOptions = {}): Omit<RunOptions, 'yes' | 'fresh'> {
  return { assumeYes: session.yes, quiet: session.quiet, merge: false, interactive: true, silent: o.silent, screen: o.screen };
}

/**
 * A goal typed at the prompt: plan it, talk the plan through unless the session says yes, then execute.
 * Throws CliError for uncommitted changes (unless the session allows them) and whatever runBoard throws.
 */
export async function runGoal(repoRoot: string, session: Session, goal: string, o: SessionRunOptions = {}): Promise<SessionRun> {
  const config = sessionConfig(repoRoot, session);
  requireClean(repoRoot, session);
  const board = createBoard(repoRoot, goal);
  const outcome = await runBoard(repoRoot, board, config, { ...runOptions(session, o), yes: session.yes, fresh: true });
  return { runId: board.runId, runBranch: board.runBranch, ...outcome };
}

/** /order: like runGoal, but the plan is always talked through with the planner, whatever the session's yes. */
export async function runOrder(repoRoot: string, session: Session, goal: string, o: SessionRunOptions = {}): Promise<SessionRun> {
  requireClean(repoRoot, session);
  const config = sessionConfig(repoRoot, session);
  // orderRun, keeping the board for its id.
  const board = createBoard(repoRoot, goal);
  const outcome = await runBoard(repoRoot, board, config, { ...runOptions(session, o), yes: false, fresh: true });
  return { runId: board.runId, runBranch: board.runBranch, ...outcome };
}

/** Which settings a resume uses, and whether the person already chose (the app asked). */
export interface ResumeOptions extends SessionRunOptions {
  /** This session's settings instead of the run's saved ones. */
  currentSettings?: boolean;
  /** `currentSettings` is the person's answer: a run whose saved settings differ does not ask again. */
  settingsChosen?: boolean;
}

/**
 * Continue a run (the newest when `runId` is omitted) with its saved settings, or this session's with
 * `currentSettings`. Throws CliError for no runs or an unknown id.
 */
export async function runResume(repoRoot: string, session: Session, runId?: string, o: ResumeOptions = {}): Promise<SessionRun> {
  const config = sessionConfig(repoRoot, session);
  const id = latestRun(repoRoot, runId);
  const { runBranch } = store.loadBoard(repoRoot, id);
  const outcome = await resumeRun(repoRoot, config, id, { ...runOptions(session, o), currentSettings: o.currentSettings, settingsChosen: o.settingsChosen });
  return { runId: id, runBranch, ...outcome };
}

/**
 * Give the failed card `cardId` one more review round in a run (the newest when omitted), then run the
 * board on. Throws CliError for a missing card id, no runs or an unknown run; Error when the card is not failed.
 * `settingsChosen` as for runResume (the app keeps the run's saved settings for a retry).
 */
export async function runRetry(repoRoot: string, session: Session, cardId: string, runId?: string, o: ResumeOptions = {}): Promise<SessionRun> {
  const config = sessionConfig(repoRoot, session);
  if (!cardId) throw new CliError('dulger retry needs a card id, e.g. dulger retry c7');
  const id = latestRun(repoRoot, runId);
  const { runBranch } = store.loadBoard(repoRoot, id);
  const outcome = await retryRun(repoRoot, config, cardId, id, { ...runOptions(session, o), currentSettings: o.currentSettings, settingsChosen: o.settingsChosen });
  return { runId: id, runBranch, ...outcome };
}
