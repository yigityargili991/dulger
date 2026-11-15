import * as store from './board/store.ts';
import * as git from './git/worktree.ts';
import { buildReport } from './ui/report.ts';
import { fmtSpend } from './ui/ansi.ts';
import { select } from './tui/select.ts';
import { pager } from './tui/pager.ts';
import { changedFiles, failedCards, fileDiff, runStatus, runSummaries } from './runs.ts';

export { recoverableRuns, runStatus, type RunStatus } from './runs.ts';

interface RunActions { resume(id: string): Promise<void>; retry(id: string, card: string): Promise<void>; merge(id: string): void; edit(id: string): Promise<void> }
export async function browseRuns(root: string, actions: RunActions): Promise<void> {
  let selected: string | undefined;
  for (;;) {
    const choices = runSummaries(root).reverse().map((r) => r.readable
      ? { value: r.id, label: `${r.id} · ${r.status} · ${r.goal}`, description: `${r.cards.done}/${r.cards.total} cards · ${r.spend} · ${r.branch}` }
      : { value: r.id, label: `${r.id} · unreadable board`, description: 'Inspect this run’s board.json before recovery.' });
    if (!choices.length) { await pager('Runs', 'No runs yet. Enter a goal to start your first run.'); return; }
    const id = await select({ title: 'Runs', description: 'Search by goal, status or run ID. Select a run to review or recover it.', choices, selected });
    if (!id) return;
    selected = id;
    try {
      const b = store.loadBoard(root, id);
      const choice = await select({ title: b.goal, description: `${id} · ${runStatus(b)} · ${fmtSpend(b)}`, choices: [
        { value: 'review', label: 'Review result and diffs' },
        { value: 'resume', label: b.cards.length ? 'Resume run' : 'Restart planning', description: 'Continue using saved settings, or explicitly choose current settings.' },
        { value: 'retry', label: 'Retry a failed card' },
        { value: 'edit', label: 'Edit unstarted plan' },
      ] });
      if (choice === null) return;
      if (choice === 'review') await reviewRun(root, id, actions.merge);
      if (choice === 'resume') await actions.resume(id);
      if (choice === 'edit') await actions.edit(id);
      if (choice === 'retry') {
        const failed = failedCards(b);
        if (!failed.length) { await pager('Retry', 'No failed cards. Use Resume run for interrupted work.'); continue; }
        const card = await select({ title: 'Retry card', choices: failed.map((c) => ({ value: c.id, label: `${c.id} ${c.title}`, description: c.reason })) });
        if (card) await actions.retry(id, card);
      }
    } catch (e) { await pager('Run needs attention', (e as Error).message); }
  }
}
export async function reviewRun(root: string, id: string, merge: (id: string) => void): Promise<void> {
  for (;;) {
    const b = store.loadBoard(root, id);
    const choice = await select({ title: 'Review result', description: `${b.goal} · ${runStatus(b)} · ${fmtSpend(b)}`, choices: [
      { value: 'report', label: 'Verification, feedback and full report' },
      { value: 'files', label: 'Browse changed files and diffs' },
      { value: 'merge', label: `Merge into ${git.currentBranch(root)}`, description: `Merge ${b.runBranch}; a confirmation follows.` },
      { value: 'back', label: 'Leave result on its branch' },
    ] });
    if (!choice || choice === 'back') return;
    try {
      if (choice === 'report') await pager('Run report', buildReport(b, { full: true, width: Math.max(30, (process.stdout.columns ?? 100) - 2) }));
      if (choice === 'files') {
        const files = changedFiles(root, b);
        if (!files.length) { await pager('Changes', 'No changed files.'); continue; }
        for (;;) {
          const file = await select({ title: 'Changed files', choices: files.map((f) => ({ value: f, label: f })) });
          if (!file) break;
          await pager(file, fileDiff(root, b, file) || 'No text diff available.');
        }
      }
      if (choice === 'merge') {
        const answer = await select({ title: 'Merge result?', description: `${b.runBranch} will be merged into ${git.currentBranch(root)}. Review unfinished cards and feedback first.`, choices: [{ value: 'back', label: 'Back to review' }, { value: 'merge', label: 'Merge result' }] });
        if (answer === 'merge') { merge(id); await pager('Merged', `${b.runBranch} is now merged into ${git.currentBranch(root)}.`); return; }
      }
    } catch (e) { await pager('Review needs attention', (e as Error).message); }
  }
}
