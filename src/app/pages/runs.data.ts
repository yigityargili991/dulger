// What the Runs tab and the result review show about a run, as data: its state against git (branch,
// merged, merge blockers, a live owner), the actions it allows and why the others are off, and the
// texts the viewers show (a card, the report). Nothing here draws; the pages style what this returns.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, type Config } from '../../config.ts';
import { liveLockHolder } from '../../board/lock.ts';
import * as store from '../../board/store.ts';
import * as git from '../../git/worktree.ts';
import { worktreesDir } from '../../paths.ts';
import { planEditBlocker } from '../../planEditor.ts';
import {
  cardCounts, failedCards, mergeBlockers, runInUse, runState, wipRunOf, RESULT_BLOCKERS,
  type BusyRun, type FailedCard, type MergeBlocker, type MergeBlockerCode, type RunStatus,
} from '../../runs.ts';
import { settingNames } from '../resume.ts';
import { settingsChanges } from '../../runSettings.ts';
import { sandboxDir } from '../../sandbox.ts';
import { fmtCost, fmtDuration, fmtSpend, fmtTokens } from '../../ui/ansi.ts';
import { buildReport } from '../../ui/report.ts';
import { usageTokens } from '../../usage.ts';
import type { Glyphs } from '../../tui/theme.ts';
import type { Board, Card, VerificationResult } from '../../types.ts';

const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

/** The process id of another live dulger on this machine that holds the run's execution lock. */
export const lockHolder = liveLockHolder;

export type FinalState = 'passed' | 'failed' | 'stale' | 'none-configured' | 'not-run' | 'not-recorded';

export interface RunDetail {
  id: string;
  board: Board;
  status: RunStatus;
  /** The branch checked out in the repository: where a merge lands. */
  into: string;
  branchExists: boolean;
  /** The result branch's commit, when it exists. */
  tip?: string;
  /** The result branch still points at the run's base: there is nothing to merge. */
  noChanges: boolean;
  /** The result is already part of `into`. */
  merged: boolean;
  blockers: MergeBlocker[];
  /** Another dulger process working on this run right now. */
  holder?: number;
  /**
   * A merge stopped in the working tree, when there is one: `ours` is true only when its MERGE_HEAD is
   * this run's branch tip (so dulger may offer to abort it); a merge the person started has `ours` false.
   */
  mergeHalt?: { ours: boolean; conflicts: string[] };
  /** Settings that differ between the run's saved snapshot and the session; undefined when the run saved none. */
  settingsDiff?: string[];
  failed: FailedCard[];
  /** Why the plan cannot be edited, when it cannot. */
  planBlocker?: string;
  final: FinalState;
  /** Where the worktrees of cards that did not land are kept (a retry goes on in them), when there are any. */
  kept?: string;
}

/** Everything the pages need to know about one readable run. Asks git a few questions; never throws for git trouble. */
export function runDetail(root: string, board: Board, config?: () => Config): RunDetail {
  const into = safe(() => git.currentBranch(root), '?');
  const branchExists = safe(() => git.branchExists(root, board.runBranch), false);
  // The board's refs cannot start with "-" (validateBoard refuses that), so rev-parse reads them as refs.
  const tip = branchExists ? safe(() => git.git(root, ['rev-parse', board.runBranch]), undefined) : undefined;
  const noChanges = branchExists && tip !== undefined && tip === safe(() => git.git(root, ['rev-parse', board.baseRef]), '');
  const merged = branchExists && !noChanges && safe(() => git.isAncestor(root, board.runBranch, 'HEAD'), false);
  const blockers = safe(() => mergeBlockers(root, board), [{ code: 'branch-missing', message: `${board.runBranch} could not be checked` } as MergeBlocker]);
  let settingsDiff: string[] | undefined;
  if (board.settings && config) settingsDiff = safe(() => settingsChanges(board.settings!.config, config()), []);
  const fv = board.finalVerification;
  const final: FinalState = !fv ? (board.settings ? 'not-run' : 'not-recorded')
    : !fv.results.length ? 'none-configured'
      : fv.results.some((r) => !r.ok) ? 'failed'
        : tip !== undefined && fv.ref !== tip ? 'stale' : 'passed';
  const halt = mergeState(root);
  return {
    id: board.runId, board, status: runState(root, board), into, branchExists, tip, noChanges, merged, blockers,
    holder: lockHolder(root, board.runId), settingsDiff, failed: failedCards(board),
    planBlocker: board.cards.length ? planEditBlocker(board) : undefined, final, kept: keptWorktrees(root, board),
    mergeHalt: halt ? { ours: tip !== undefined && halt.head === tip, conflicts: halt.conflicts } : undefined,
  };
}

/** The run's folder of card worktrees, while a card that did not land still has one there. */
export function keptWorktrees(root: string, board: Board): string | undefined {
  const dir = safe(() => join(worktreesDir(root), board.runId), undefined);
  if (!dir) return undefined;
  const left = board.cards.filter((c) => c.status !== 'done' && c.status !== 'replaced');
  return left.some((c) => existsSync(join(dir, c.id))) ? dir : undefined;
}

/** A merge blocker as a short state: `not verified`, `verify failed`, `dirty tree`. */
export function blockerReason(b: MergeBlocker, d?: Pick<RunDetail, 'final'>): string {
  const text: Record<MergeBlockerCode, string> = {
    unverified: 'not verified',
    'verification-failed': d?.final === 'stale' ? 'verify stale' : 'verify failed',
    'docs-unfinished': 'docs unfinished',
    'branch-missing': 'branch gone',
    'dirty-tree': 'dirty tree',
  };
  return text[b.code] ?? b.message;
}

/** True when a resume would repair what blocks the merge. */
export function resumeFixes(d: RunDetail): boolean {
  return d.blockers.some((b) => RESULT_BLOCKERS.includes(b.code));
}

export type ActionId = 'review' | 'resume' | 'retry' | 'edit' | 'merge' | 'report';
export interface RunAction {
  id: ActionId;
  label: string;
  enabled: boolean;
  /** What it does when enabled (for help); why not when disabled, in a few words (toasted when pressed). */
  note: string;
}

/** Why nothing that changes the run can start: another process has it. */
const inUse = (d: RunDetail) => (d.holder ? `in use: pid ${d.holder}` : undefined);

/** What the cards' own verify commands established: none had any, one failed, all passed, or not all ran. */
export function cardChecks(b: Board): 'none' | 'failed' | 'passed' | 'unrun' {
  const checked = b.cards.filter((x) => x.status !== 'replaced' && x.verify.length);
  if (!checked.length) return 'none';
  if (checked.some((x) => x.verification?.some((r) => !r.ok))) return 'failed';
  if (checked.every((x) => x.verification?.length && x.verification.every((r) => r.ok))) return 'passed';
  return 'unrun';
}

/** Why the result cannot be merged now, in a few words, or undefined when it can. */
export function mergeOff(d: RunDetail): string | undefined {
  if (d.merged) return `merged → ${d.into}`;
  if (!d.branchExists) return 'branch gone';
  if (d.noChanges) return 'no changes';
  const busy = inUse(d);
  if (busy) return busy;
  // A merge the person started themselves is left alone; dulger will not merge over it.
  if (d.mergeHalt && !d.mergeHalt.ours) return 'merge in progress';
  if (d.blockers.length) return [...new Set(d.blockers.map((b) => blockerReason(b, d)))].join(', ');
  return undefined;
}

/** Why the run cannot be resumed now, or undefined when it can. */
export function resumeOff(d: RunDetail): string | undefined {
  const busy = inUse(d);
  if (busy) return busy;
  if (d.status === 'finished' && !resumeFixes(d)) return 'finished';
  return undefined;
}

/** The actions a run offers, each enabled or disabled with the reason. */
export function runActions(d: RunDetail): RunAction[] {
  const b = d.board;
  const resume = resumeOff(d);
  const busy = inUse(d);
  const merge = mergeOff(d);
  const unstarted = b.cards.filter((c) => c.status === 'backlog').length;
  const n = cardCounts(b.cards);
  return [
    { id: 'review', label: 'Review', enabled: true, note: 'the report, the changed files, verification and the merge' },
    {
      id: 'resume', label: b.cards.length ? 'Resume' : 'Plan again', enabled: !resume,
      note: resume ?? (resumeFixes(d) && d.status === 'finished' ? 'verifies the current result again (asks first)'
        : !b.settings ? 'with the current settings (asks first)'
          : d.settingsDiff?.length ? `asks first, and which settings: this session's differ in ${settingNames(d.settingsDiff)}` : 'with its saved settings (asks first)'),
    },
    {
      id: 'retry', label: 'Retry card', enabled: !busy && d.failed.length > 0,
      note: busy ?? (d.failed.length ? `one more review round for a failed card: ${d.failed.map((c) => c.id).join(', ')}` : 'no failed card'),
    },
    {
      id: 'edit', label: 'Edit plan', enabled: !busy && b.cards.length > 0 && !d.planBlocker,
      note: busy ?? (!b.cards.length ? 'no plan' : d.planBlocker ? 'work started'
        : `${unstarted} unstarted card${unstarted === 1 ? '' : 's'}: titles, descriptions, criteria, dependencies, verify commands, worker`),
    },
    { id: 'merge', label: 'Merge', enabled: !merge, note: merge ?? (n.done < n.total ? `what landed (${n.done} of ${n.total} cards) into ${d.into}, after a confirmation` : `into ${d.into}, after a confirmation`) },
    { id: 'report', label: 'Report', enabled: true, note: 'everything the run recorded' },
  ];
}

// ---- formatting ----

/** "$0.42", "12k tok" or "-": a spend that fits a table column. */
export function shortSpend(x: { costUsd: number; usage?: Card['usage'] }): string {
  if (x.costUsd > 0) return fmtCost(x.costUsd);
  if (x.usage) return `${fmtTokens(usageTokens(x.usage))} tok`;
  return '-';
}

/** "now", "5m", "3h", "2d": how long ago `iso` was. */
export function age(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

/** "2026-11-15 14:03", local time. */
export function when(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "1.2s", or "01:05" past a minute. */
export function duration(ms: number): string {
  return ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : fmtDuration(ms);
}

/** Review rounds so far, or undefined for a card no worker has touched. */
export function cardTries(c: Card): number | undefined {
  const started = ['done', 'failed', 'review', 'in_progress'].includes(c.status) || c.tasks.some((t) => t.attempts > 0);
  return started ? c.attempts + 1 : undefined;
}

export function cardStatusLabel(c: Card): string {
  return c.status === 'in_progress' ? 'in progress' : c.status;
}

/** Why a card did not land, in one line: dulger's reason, else the reviewer's last word. */
export function cardReason(c: Card): string | undefined {
  if (c.status === 'failed') return c.reason ?? c.feedback.at(-1) ?? (c.failure === 'infrastructure' ? 'dulger could not run a step' : undefined);
  if (c.status === 'blocked' || c.status === 'replaced') return c.reason;
  return undefined;
}

// ---- texts for the viewers ----

const lines = (s: string | undefined): string[] => (s ?? '').replace(/\r\n?/g, '\n').split('\n');
const indent = (s: string | undefined, pad = '  '): string[] => lines(s).map((l) => pad + l);

function resultLine(r: VerificationResult, g: Glyphs): string[] {
  const [first = '', ...rest] = lines(r.command);
  return [
    `  ${r.ok ? g.check : g.cross} ${first}${rest.length ? '' : `   exit ${r.exitCode} · ${duration(r.durationMs)}`}`,
    ...rest.map((l) => `    ${l}`),
    ...(rest.length ? [`    exit ${r.exitCode} · ${duration(r.durationMs)}`] : []),
  ];
}

/** Everything about one card, for a scrollable viewer: commands and outputs whole. */
export function cardText(card: Card, g: Glyphs): string {
  const out: string[] = [];
  const tries = card.status === 'backlog' ? 'not started' : `attempt ${card.attempts + 1}`;
  out.push(`${card.id}  ${card.title}`, `${cardStatusLabel(card)} · ${tries} · ${fmtSpend(card)}`);
  if (card.dependsOn.length) out.push(`after ${card.dependsOn.join(', ')}`);
  if (card.worker) out.push(`worker: ${card.worker.harness ?? 'the session backend'} / ${card.worker.model ?? 'automatic model'}`);
  if (card.stopped) out.push('stopped by you');
  const why = cardReason(card);
  if (why && card.status !== 'done') out.push('', card.status === 'failed' ? 'Why it failed' : card.status === 'blocked' ? 'Why it is blocked' : 'Why', ...indent(why));
  out.push('', 'Description', ...indent(card.description || '(none)'));
  out.push('', 'Acceptance criteria', ...(card.acceptanceCriteria.length ? card.acceptanceCriteria.flatMap((a) => indent(a, `  ${g.bullet} `)) : ['  none given']));
  for (const note of card.guidance ?? []) out.push('', 'Your instruction', ...indent(note));
  out.push('', 'Tasks');
  if (!card.tasks.length) out.push('  none');
  for (const t of card.tasks) {
    const mark = t.status === 'done' ? g.check : t.status === 'failed' ? g.cross : g.dot;
    out.push(`  ${mark} ${t.id} ${t.title}${t.kind === 'fix' ? ' (fix)' : ''} · ${t.status}${t.attempts ? ` · ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}` : ''}${t.complexity ? ` · ${t.complexity}` : ''}`);
    if (t.result?.summary) out.push(...indent(t.result.summary, '      '));
    if (t.result?.filesChanged.length) out.push(`      files: ${t.result.filesChanged.join(', ')}`);
    if (t.result?.remaining.length) out.push(`      left to do: ${t.result.remaining.join('; ')}`);
    if (t.error) out.push(...indent(`error: ${t.error}`, '      '));
    for (const f of t.feedback ?? []) out.push(...indent(`addresses: ${f}`, '      '));
  }
  out.push('', 'Verify commands');
  if (!card.verify.length) out.push('  none');
  for (const cmd of card.verify) { const [first = '', ...rest] = lines(cmd); out.push(`  $ ${first}`, ...rest.map((l) => `    ${l}`)); }
  if (card.verification?.length) {
    out.push('', 'Verification (the last run)');
    for (const r of card.verification) {
      out.push(...resultLine(r, g));
      if (!r.ok && r.output.trim()) out.push(...indent(r.output.trimEnd(), '      '));
    }
  } else if (card.verify.length) out.push('', 'Verification', '  not run');
  if (card.feedback.length) { out.push('', 'Review feedback'); card.feedback.forEach((f, i) => out.push(...indent(f, `  ${i + 1}. `).map((l, j) => (j ? `     ${l.trimStart()}` : l)))); }
  if (card.reviewNotes?.length) { out.push('', 'Review notes'); for (const n of card.reviewNotes) out.push(...indent(n, `  ${g.note} `)); }
  // "Final" only for a card that landed; a card still going (or one that did not land) shows its last one.
  if (card.review) out.push('', card.status === 'done' ? 'Final review' : 'Last review', ...indent(card.review));
  if (card.progress) out.push('', `Progress (${when(card.progress.at)})`, ...indent(card.progress.note), ...(card.progress.attention ? indent(`attention: ${card.progress.attention}`) : []));
  return out.join('\n');
}

/**
 * The end-of-run report as the line prompt prints it, minus its "Next" section: that one names CLI
 * commands, and the app offers those steps as actions instead. The diff stat is the one `dulger report` uses.
 */
export function reportText(root: string, board: Board, width: number, mergedInto?: string): string {
  const diffStat = safe(() => (git.branchExists(root, board.runBranch) ? git.diffStat(root, board.baseRef, board.runBranch) : undefined), undefined);
  const text = buildReport(board, { full: true, width: Math.max(30, width), diffStat, mergedInto });
  const all = text.replace(/\n$/, '').split('\n');
  const plain = all.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const next = plain.lastIndexOf('Next');
  return (next > 0 ? all.slice(0, plain[next - 1] === '' ? next - 1 : next) : all).join('\n');
}

/** The last line of `git diff --stat`: "3 files changed, 40 insertions(+), 2 deletions(-)". */
export function diffSummary(root: string, board: Board): string | undefined {
  return safe(() => git.diffStat(root, board.baseRef, board.runBranch).split('\n').at(-1)?.trim() || undefined, undefined);
}

/** `+12 -3` per changed file (`bin` for binaries); missing entries mean git gave no count. */
export function numstat(root: string, board: Board): Map<string, string> {
  const out = new Map<string, string>();
  const raw = safe(() => git.git(root, ['diff', '--numstat', '--no-renames', '-z', '--end-of-options', board.baseRef, board.runBranch]), '');
  for (const rec of raw.split('\0')) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.+)$/s);
    if (m) out.set(m[3]!, m[1] === '-' ? 'bin' : `+${m[1]} -${m[2]}`);
  }
  return out;
}

/**
 * A merge stopped in the working tree: its MERGE_HEAD commit and the paths still in conflict; undefined
 * when no merge is in progress. The caller decides whether it is dulger's by comparing `head` to a run
 * branch tip — a merge the person started has a different MERGE_HEAD and must not be aborted here.
 */
export function mergeState(root: string): { head: string; conflicts: string[] } | undefined {
  const head = safe(() => git.git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }), '');
  if (!head) return undefined;
  return { head, conflicts: safe(() => git.git(root, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).split('\n').filter(Boolean), []) };
}

/** The full text of a failure: the message, and what git printed besides (a conflict's file list is on stdout). */
export function errorText(e: unknown): string {
  if (e instanceof git.GitError) return [e.message, e.stdout.trim(), e.stderr.trim() && !e.message.includes(e.stderr.trim()) ? e.stderr.trim() : ''].filter(Boolean).join('\n\n');
  return e instanceof Error ? e.message : String(e);
}

/**
 * What a cleanup would remove, read without touching anything, so the confirmation can say it: the
 * worktrees, branches and folders that go (a run in use by another process is left out and listed in
 * `busy`), and `retries`, the runs whose failed cards keep a worktree a retry would have gone on in.
 */
export function leftovers(root: string): { worktrees: string[]; branches: string[]; dirs: string[]; busy: BusyRun[]; retries: string[] } {
  const busy = safe(() => store.listRuns(root).flatMap((id) => { const r = runInUse(root, id); return r ? [{ id, reason: r }] : []; }), [] as BusyRun[]);
  const held = new Set(busy.map((b) => b.id));
  const worktrees = safe(() => git.listWorktrees(root).filter((w) => w.branch?.startsWith('dulger-wip/') && !held.has(wipRunOf(w.branch) ?? '')).map((w) => w.path), []);
  const branches = safe(() => git.git(root, ['branch', '--list', 'dulger-wip/*', '--format=%(refname:short)'], { allowFail: true }).split('\n').filter((b) => b && !held.has(wipRunOf(b) ?? '')), []);
  const dirs = safe(() => [worktreesDir(root), join(root, STATE_DIR, 'worktrees'), sandboxDir(root)].filter((d) => existsSync(d) && hasOwnLeftovers(d, held)), []);
  const retries = safe(() => store.listRuns(root).filter((id) => {
    if (held.has(id)) return false;
    try { return Boolean(keptWorktrees(root, store.loadBoard(root, id))); } catch { return false; }
  }), []);
  return { worktrees, branches, dirs, busy, retries };
}

/** Whether a dulger folder holds anything besides the folders of runs in use (only those would be left). */
function hasOwnLeftovers(dir: string, held: Set<string>): boolean {
  if (!held.size) return true;
  try { return readdirSync(dir).some((child) => !held.has(child)); } catch { return true; }
}
