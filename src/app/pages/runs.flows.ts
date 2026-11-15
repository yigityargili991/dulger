// The run actions both the Runs tab and the result review offer, as dialogs over the current page:
// merge (blockers first, then an explicit confirmation naming source and destination), retry a
// failed card, clean leftovers, abort a merge stopped by conflicts, and the card and report viewers.
// Each one shows its own outcome and never throws.
import * as git from '../../git/worktree.ts';
import { cleanLeftoversReport, mergeRunBranch, type MergedRun } from '../../runs.ts';
import { plainText } from '../../tui/text.ts';
import type { AppContext } from '../types.ts';
import { launchRetry } from '../run.ts';
import { settingNames } from '../resume.ts';
import type { Board, Card } from '../../types.ts';
import { cardText, diffSummary, errorText, leftovers, mergeOff, mergeState, reportText, type RunDetail } from './runs.data.ts';

export type MergeOutcome =
  | { kind: 'merged'; merged: MergedRun }
  | { kind: 'failed'; text: string; conflicts?: string[] }
  /** Nothing happened: blocked, cancelled or already merged; the reason was shown. */
  | { kind: 'none' };

/**
 * Merge a run's result after an explicit confirmation that names the source and the destination.
 * Blockers are said instead of trying. A failure is returned with its full text for the caller to show.
 */
export async function mergeFlow(ctx: AppContext, d: RunDetail): Promise<MergeOutcome> {
  const branch = plainText(d.board.runBranch);
  const into = plainText(d.into);
  const off = mergeOff(d);
  if (off) { ctx.toast(d.merged ? `Merged → ${into}` : `Merge: ${off}`, d.merged ? 'info' : 'warn'); return { kind: 'none' }; }
  const stat = diffSummary(ctx.repoRoot, d.board);
  const total = d.board.cards.filter((c) => c.status !== 'replaced').length;
  const landed = d.board.cards.filter((c) => c.status === 'done').length;
  const yes = await ctx.confirm({
    title: 'Merge', message: `${branch} → ${into}`,
    items: [
      ...(stat ? [{ label: 'Changes', value: stat }] : []),
      // Only what landed comes along: say so when that is not everything.
      ...(landed < total ? [{ label: 'Landed', value: `${landed}/${total} cards` }] : []),
    ],
    confirm: 'Merge',
  });
  if (!yes) { ctx.toast('Not merged', 'info'); return { kind: 'none' }; }
  try {
    const merged = await ctx.busy('Merging…', async () => mergeRunBranch(ctx.repoRoot, d.id));
    ctx.toast(`Merged → ${merged.into}`, 'ok');
    return { kind: 'merged', merged };
  } catch (e) {
    const conflicts = mergeState(ctx.repoRoot)?.conflicts;
    ctx.toast(conflicts ? `Conflicts: ${conflicts.length} file${conflicts.length === 1 ? '' : 's'}` : 'Merge failed', 'error');
    return { kind: 'failed', text: errorText(e), conflicts };
  }
}

/** Undo a merge that stopped with conflicts: the checked-out branch goes back to how it was. */
export async function abortMergeFlow(ctx: AppContext): Promise<boolean> {
  const state = mergeState(ctx.repoRoot);
  if (!state) { ctx.toast('No merge in progress', 'info'); return false; }
  const into = plainText(safeBranch(ctx.repoRoot));
  const n = state.conflicts.length;
  const yes = await ctx.confirm({
    title: 'Abort merge', message: `${into} back to before the merge`,
    items: state.conflicts.length ? [{ label: 'Conflicts', value: state.conflicts.map((f) => plainText(f)).join(', ') }] : undefined,
    // What goes is not on screen anywhere else.
    note: `Discards staged resolutions${n ? ` and the ${n} conflicted file${n === 1 ? '' : 's'}` : ''}.`,
    confirm: 'Abort', danger: true,
  });
  if (!yes) return false;
  try {
    await ctx.busy('Aborting…', async () => git.git(ctx.repoRoot, ['merge', '--abort']));
    ctx.toast('Merge aborted', 'ok');
    return true;
  } catch (e) {
    ctx.toast(errorText(e), 'error');
    return false;
  }
}

function safeBranch(root: string): string {
  try { return git.currentBranch(root); } catch { return 'the current branch'; }
}

/** Pick one of the failed cards (the given one first) and give it another round. */
export async function retryFlow(ctx: AppContext, d: RunDetail, preselect?: string, launch = launchRetry): Promise<boolean> {
  if (!d.failed.length) { ctx.toast('No failed card', 'info'); return false; }
  if (d.holder) { ctx.toast(`In use: pid ${d.holder}`, 'warn'); return false; }
  // A retry keeps the settings the run started with (the launcher passes that on): one line when that
  // is not what this session would use, since nothing else on screen says it.
  const card = await ctx.pick({
    title: 'Retry card',
    message: d.settingsDiff?.length ? `Settings: the run's · differ: ${settingNames(d.settingsDiff)}` : undefined,
    options: d.failed.map((c) => ({ value: c.id, label: `${c.id}  ${c.title}` })),
    selected: d.failed.some((c) => c.id === preselect) ? preselect : undefined,
  });
  if (!card) return false;
  await launch(ctx, d.id, card);
  return true;
}

/**
 * Remove what runs left behind, after a confirmation that says what goes (the worktrees failed cards
 * keep for a retry included) and which runs are left alone because another process is using them;
 * then show what was removed.
 */
export async function cleanFlow(ctx: AppContext): Promise<void> {
  const found = leftovers(ctx.repoRoot);
  const n = found.worktrees.length + found.branches.length + found.dirs.length;
  const busy = found.busy.length;
  if (!n) {
    ctx.toast(busy ? `Nothing to clean · ${busy} run${busy === 1 ? '' : 's'} in use` : 'Nothing to clean', 'ok');
    return;
  }
  const items = [
    ...(found.worktrees.length ? [{ label: 'Worktrees', value: String(found.worktrees.length) }] : []),
    ...(found.branches.length ? [{ label: 'Branches', value: `${found.branches.length} dulger-wip/…` }] : []),
    ...(found.dirs.length ? [{ label: 'Folders', value: 'worktree, sandbox' }] : []),
    // A retry of these runs' failed cards starts over without them.
    ...(found.retries.length ? [{ label: 'Retry worktrees', value: found.retries.map((id) => plainText(id)).join(', ') }] : []),
    ...found.busy.map((b) => ({ label: 'Left alone', value: `${plainText(b.id)}: ${b.reason}` })),
  ];
  const yes = await ctx.confirm({
    title: 'Clean leftovers', message: '', items,
    // What cannot be seen from here: other clones share these folders, and edits in a worktree go with it.
    note: 'The folders are shared by every local clone of this repository; uncommitted work in a worktree is lost.',
    confirm: 'Clean', danger: true,
  });
  if (!yes) return;
  try {
    const { removed, skipped } = await ctx.busy('Cleaning…', async () => cleanLeftoversReport(ctx.repoRoot));
    const left = skipped.length ? ` · ${skipped.length} in use` : '';
    ctx.toast(removed.length ? `${removed.length} leftover${removed.length === 1 ? '' : 's'} removed${left}` : `Nothing removed${left}`, 'ok');
    const lines = [...removed, ...skipped.map((s) => `left run ${s.id} alone: ${s.reason}`)];
    if (lines.length) await ctx.view({ title: 'Cleaned', text: lines.join('\n') });
  } catch (e) {
    ctx.toast(errorText(e), 'error');
  }
}

export function viewCard(ctx: AppContext, card: Card): Promise<void> {
  return ctx.view({ title: `${card.id} ${card.title}`, text: cardText(card, ctx.g) });
}

/** The full report in a viewer, laid out for the viewer's width on a `cols`-wide screen. */
export function viewReport(ctx: AppContext, board: Board, cols: number, mergedInto?: string): Promise<void> {
  const width = Math.max(30, cols - (cols >= 60 ? 12 : 4));
  return ctx.view({ title: `Report ${board.runId}`, text: reportText(ctx.repoRoot, board, width, mergedInto) });
}
