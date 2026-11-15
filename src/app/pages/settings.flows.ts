// Saving the session's settings, as a dialog over whatever page asks: Settings
// (s, Ctrl-S), Models and Providers (Ctrl-S) and the app-wide palette entry all use this one, so the
// confirmation always lists exactly what is written and what is not.
import * as git from '../../git/worktree.ts';
import { plannedSave, saveSessionConfig } from '../../replModels.ts';
import { plainText } from '../../tui/text.ts';
import { noticeModal } from '../../tui/kit/index.ts';
import type { AppContext } from '../types.ts';
import { homePath } from './models.shared.ts';
import { OTHER_SETTINGS, configPath, extraWriteItems, readView, saveItems } from './settings.data.ts';

/** The repository's settings file, as git names it (relative to the root). */
export const SETTINGS_FILE = '.dulger/config.json';
/** The message of the commit Commit settings makes. */
export const SETTINGS_COMMIT_MESSAGE = 'dulger: save settings';

const message = (e: unknown): string => plainText(e instanceof Error ? e.message : String(e)) || 'Something went wrong.';

/**
 * Show what Save writes, ask, write it. True when something was saved; every outcome is a toast.
 * `written` runs as soon as the file is written, before the notice about committing it, so the page
 * behind that notice already shows the saved state.
 */
export async function saveSettings(ctx: AppContext, o: { written?: () => void } = {}): Promise<boolean> {
  let items: ReturnType<typeof saveItems>;
  try { items = saveItems(readView(ctx.repoRoot, ctx.session), ctx.session); } catch (e) { ctx.toast(message(e), 'error'); return false; }
  // Any field the form cannot name (worktree setup, checker commands, …) is listed from the same merge
  // the save performs, so the dialog is exactly what lands in the file. A read error here is surfaced by
  // the write below, with the message the tests expect.
  let files = configPath(ctx.repoRoot);
  try {
    const plan = plannedSave(ctx.repoRoot, ctx.session);
    const extra = extraWriteItems(plan, items);
    // The extras name the unnamed fields, so drop the generic row.
    if (extra.length) items = items.filter((i) => i.label !== OTHER_SETTINGS);
    items = [...items, ...extra];
    files = [plan, plan.user].filter((d) => d.keys.length).map((d) => homePath(d.path)).join('\n') || files;
  } catch { /* the write reports it */ }
  if (!items.length) { ctx.toast('Nothing to save', 'info'); return false; }
  // The facts: the files written (the repository's, your own or both), then each change. What is never written is in help.
  const yes = await ctx.confirm({ title: 'Save settings', message: '', detail: files, items, confirm: 'Save' });
  if (!yes) return false;
  try {
    saveSessionConfig(ctx.repoRoot, ctx.session);
  } catch (e) {
    ctx.toast(`Not saved: ${message(e)}`, 'error');
    ctx.redraw();
    return false;
  }
  o.written?.();
  ctx.redraw();
  // The file is now an uncommitted change, and a run starts only from a clean tree (or with uncommitted
  // changes allowed): say so, and offer the commit, which the person may decline.
  let uncommitted = false;
  try { uncommitted = git.hasChanges(ctx.repoRoot, SETTINGS_FILE); } catch { /* not a repository: nothing to commit */ }
  if (!uncommitted) { ctx.toast('Saved', 'ok'); return true; }
  // Only a change to a file git already tracks keeps a run from starting; a file that is new to git
  // does not count as an uncommitted change (isClean ignores untracked files), so do not claim it does.
  let blocks = false;
  try { blocks = git.dirtyPaths(ctx.repoRoot).includes(SETTINGS_FILE); } catch { /* as above */ }
  const choice = await ctx.modal(noticeModal({
    title: 'Saved · not committed',
    // The one consequence the person cannot see from here: the next run will not start.
    message: blocks ? `${ctx.g.warn} blocks the next run` : '',
    detail: SETTINGS_FILE,
    actions: [{ id: 'commit', label: 'Commit settings…' }],
    close: 'Not now',
  }));
  if (choice === 'commit') await commitSettingsFlow(ctx);
  else ctx.toast('Saved · not committed', 'ok');
  return true;
}

/**
 * True when the repository's settings file is the only uncommitted change in the tree: the case where
 * committing it (Commit settings) is all that stands between the person and a run.
 */
export function settingsOnlyDirty(repoRoot: string): boolean {
  try {
    const dirty = git.dirtyPaths(repoRoot);
    return dirty.length === 1 && dirty[0] === SETTINGS_FILE;
  } catch {
    return false;
  }
}

/**
 * Commit the settings file alone, after a confirmation that names the branch and the commit message
 * (declining is the default). Other staged work stays staged and out of the commit. The person's hooks
 * and identity are used; when git refuses, its whole output is shown. Resolves true when the commit was made.
 */
export async function commitSettingsFlow(ctx: AppContext): Promise<boolean> {
  let branch: string;
  let others: string[];
  try {
    if (!git.hasChanges(ctx.repoRoot, SETTINGS_FILE)) { ctx.toast('Nothing to commit', 'info'); return false; }
    branch = git.currentBranch(ctx.repoRoot);
    others = git.dirtyPaths(ctx.repoRoot).filter((p) => p !== SETTINGS_FILE);
  } catch (e) {
    ctx.toast(message(e), 'error');
    return false;
  }
  // The facts: branch, message, the one file, and what stays out of the commit (staged work stays staged).
  const yes = await ctx.confirm({
    title: 'Commit settings',
    message: '',
    items: [
      { label: 'Branch', value: branch },
      { label: 'Message', value: SETTINGS_COMMIT_MESSAGE },
      { label: 'File', value: SETTINGS_FILE },
      ...(others.length ? [{ label: 'Left out', value: `${others.length} other file${others.length === 1 ? '' : 's'}` }] : []),
    ],
    confirm: 'Commit',
    cancel: 'Not now',
  });
  if (!yes) return false;
  try {
    const id = git.commitOnly(ctx.repoRoot, SETTINGS_FILE, SETTINGS_COMMIT_MESSAGE);
    ctx.toast(`Committed ${id} → ${branch}`, 'ok');
    return true;
  } catch (e) {
    // git's own output is the content; nothing was committed and the file is as it was.
    const out = e instanceof git.GitError ? [e.stderr, e.stdout].map((x) => x.trim()).filter(Boolean).join('\n') : '';
    await ctx.modal(noticeModal({ title: 'Commit refused', tone: 'bad', message: '', detail: out || message(e) }));
    return false;
  } finally {
    ctx.redraw();
  }
}
