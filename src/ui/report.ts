// The end-of-run report: what landed, what did not, and what to do next. Built from the board alone
// (plus an optional diff stat) so `dulger report` can print it again at any time. Compact by default;
// `full` adds every task summary, review, note and diff-stat line, wrapped to the width.
import { bold, cyan, dim, green, red, yellow, fmtSpend, fmtSpendDetail, fmtWindows } from './ansi.ts';
import { fit, width as cells, wrap } from '../tui/text.ts';
import type { Board, Card, RateLimits } from '../types.ts';

export interface ReportOptions {
  /** `git diff --stat base...result`, when the caller has it. */
  diffStat?: string;
  /** Branch the result was merged into, when --merge ran. */
  mergedInto?: string;
  /** Columns to fit lines to; 100 when unknown. */
  width?: number;
  /** Every task summary, review, note and diff-stat line; the default is the compact form. */
  full?: boolean;
}

export function buildReport(board: Board, opts: ReportOptions = {}): string {
  const w = opts.width ?? 100;
  const full = opts.full ?? false;
  const cards = board.cards.filter((c) => c.status !== 'replaced');
  const landed = cards.filter((c) => c.status === 'done');
  const notLanded = cards.filter((c) => c.status !== 'done');
  const docs = board.docs;
  const out: string[] = [];
  const h = (s: string) => out.push('', bold(cyan(s)));
  const one = (s: string) => fit(s, w);

  out.push(one(bold(`Run ${board.runId}`) + dim(`  ${board.baseBranch} @ ${board.baseRef.slice(0, 7)} → ${board.runBranch}${opts.mergedInto ? ` (merged into ${opts.mergedInto})` : ''}`)));
  out.push(...(full ? labelled('Goal:', board.goal, w, 0) : [one(dim('Goal: ') + board.goal)]));
  const docsLine = docs ? (docs.status === 'done' ? 'docs updated' : docs.status === 'skipped' ? 'docs skipped' : `docs ${docs.status}`) : 'no docs';
  const count = `${landed.length} of ${cards.length} card${cards.length === 1 ? '' : 's'}`;
  out.push(one(`Landed ${landed.length === cards.length ? green(count) : yellow(count)}, ${docsLine} · spent ${fmtSpendDetail(board)}` + (board.replans ? dim(` · replanned ${board.replans}×`) : '')));

  if (board.rateLimits) out.push(one(`Plan windows at the end of the run: ${fmtWindows(board.rateLimits)}` + resetHint(board.rateLimits)));
  if (landed.length) {
    h('Landed');
    for (const c of landed) out.push(...(full ? fullCard(c, w) : compactCard(c, w)));
  }
  if (notLanded.length) {
    out.push('', bold(red('Not landed')));
    for (const c of notLanded) {
      const why = c.status === 'failed' && c.failure === 'infrastructure' ? 'dulger could not run a step; resume retries it' : c.status === 'failed' ? `failed after ${c.attempts} review round${c.attempts === 1 ? '' : 's'}` : c.status === 'blocked' ? 'blocked by a failed dependency' : c.status;
      out.push(one(`  ${bold(c.id)} ${c.title} ${red(`— ${why}`)}`));
      const last = c.feedback.at(-1);
      if (full) {
        if (c.reason) out.push(...labelled('reason:', c.reason, w));
        if (last) out.push(...labelled('last feedback:', last, w));
        out.push(...verifiedLine(c, w));
        if (c.progress) out.push(...labelled('progress:', c.progress.note + (c.progress.attention ? ` (attention: ${c.progress.attention})` : ''), w));
        if (c.review) out.push(...labelled('review:', c.review, w));
      } else {
        if (c.reason) out.push(one(`     ${dim('reason:')} ${firstLine(c.reason)}`));
        else if (last) out.push(one(`     ${dim('last feedback:')} ${firstLine(last)}`));
        const failed = c.verification?.find((r) => !r.ok);
        if (failed) out.push(one(red(`     verified: ✗ ${failed.command} (exit ${failed.exitCode})`)));
        if (c.status === 'in_progress' && c.progress) out.push(one(cyan(`     ${dim('progress:')} ${firstLine(c.progress.note)}`)));
      }
    }
  }
  if (docs?.summary) {
    h('Documentation');
    out.push(...(full ? wrap(docs.summary, w - 2).map((l) => `  ${l}`) : [one(`  ${firstLine(docs.summary)}`)]));
  }
  if (board.finalVerification) {
    h('Final verification');
    if (!board.finalVerification.results.length) out.push('  No verification commands configured.');
    for (const r of board.finalVerification.results) {
      out.push(one(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.command} (exit ${r.exitCode})`));
      if (full && !r.ok) out.push(...wrap(r.output, w - 4).map((line) => `    ${line}`));
    }
  }
  const stat = opts.diffStat?.replace(/^\n+/, '').trimEnd();
  if (stat) {
    h('Changes');
    const lines = stat.split('\n');
    out.push(...(full ? lines : lines.slice(-1)).map((l) => one(dim(' ' + l))));
  }

  h('Next');
  if (board.halted) out.push(...(full ? wrap(`the run stopped itself: ${board.halted.reason}`, w - 2).map((l) => yellow(`  ${l}`)) : [one(yellow(`  the run stopped itself: ${firstLine(board.halted.reason)}`))]));
  if (opts.mergedInto) out.push(`  the result is on ${green(opts.mergedInto)}`);
  else if (board.finalVerification?.results.some((r) => !r.ok) || board.docs?.status === 'failed') out.push(...command(`dulger resume ${board.runId}`, 'repair or recheck the final result before merging', w));
  else if (landed.length) out.push(...command(`git merge ${green(board.runBranch)}`, `or: git diff ${board.baseBranch}...${board.runBranch}`, w));
  else out.push(dim('  nothing landed'));
  const retryable = notLanded.filter((c) => c.status === 'failed' && c.failure !== 'infrastructure');
  for (const c of retryable) out.push(...command(`dulger retry ${c.id} ${board.runId}`, 'one more review round for it, then the rest of the run (--max-attempts <n> for more)', w));
  if (notLanded.some((c) => !retryable.includes(c))) out.push(...command(`dulger resume ${board.runId}`, 'continue with the cards that were interrupted', w));
  const notes = landed.reduce((n, c) => n + (c.reviewNotes?.length ?? 0), 0);
  if (notes) {
    const what = notes === 1 ? 'the reviewer note' : `the ${notes} reviewer notes`;
    const hint = full ? `${what} above ${notes === 1 ? 'is' : 'are'} worth a follow-up run` : `${what} ${notes === 1 ? 'is' : 'are'} worth a follow-up run (dulger report --full lists them)`;
    out.push(...wrap(hint, w - 2).map((l) => dim(`  ${l}`)));
  }
  return out.join('\n') + '\n';
}

/** A command to copy, with its explanation beside it when that fits and under it when not. */
function command(cmd: string, why: string, w: number): string[] {
  const inline = `  ${cmd}      ${dim(`# ${why}`)}`;
  if (cells(inline) <= w) return [inline];
  return [`  ${cmd}`, ...wrap(`# ${why}`, w - 8).map((l) => dim(`        ${l}`))];
}

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim()) ?? '';

/** `label` on the first line, the text wrapped after it with a hanging indent. Paragraph breaks survive. */
function labelled(label: string, text: string, w: number, indent = 5): string[] {
  const pad = ' '.repeat(indent);
  const hang = ' '.repeat(indent + cells(label) + 1);
  const body = text.split('\n').filter((l) => l.trim()).flatMap((l) => wrap(l, w - hang.length));
  return body.map((l, i) => (i ? hang + l : `${pad}${dim(label)} ${l}`));
}

/** " (5h resets 14:00)" for the fullest window, when the harness said when. */
function resetHint(rl: RateLimits): string {
  const fullest = [...rl.windows].sort((a, b) => b.utilization - a.utilization)[0];
  if (!fullest?.resetsAt) return '';
  const t = new Date(fullest.resetsAt);
  const label = fullest.name === 'five_hour' ? '5h' : fullest.name === 'seven_day' ? '7d' : fullest.name;
  return dim(` (${label} resets ${t.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })})`);
}

/** What dulger itself established about the card, or that it established nothing. */
function verifiedLine(c: Card, w: number): string[] {
  if (!c.verify.length) return [yellow('     verified: nothing (the plan named no verify commands)')];
  if (!c.verification?.length) return [];
  return [fit(`     ${dim('verified:')} ${c.verification.map((r) => (r.ok ? green(`✓ ${r.command}`) : red(`✗ ${r.command} (exit ${r.exitCode})`))).join(dim(' · '))}`, w)];
}

function verifiedPart(c: Card): string | undefined {
  if (!c.verify.length) return yellow('verified: nothing');
  if (!c.verification?.length) return undefined;
  const failed = c.verification.find((r) => !r.ok);
  return failed ? red(`verified: ✗ ${failed.command} (exit ${failed.exitCode})`) : green(`verified: ✓ ${c.verification.length}`);
}

/** Three lines: the card, the reviewer's first sentence, the numbers. */
function compactCard(c: Card, w: number): string[] {
  const lines = [fit(`  ${bold(c.id)} ${c.title}`, w)];
  if (c.review) lines.push(fit(`     ${dim('review:')} ${firstLine(c.review)}`, w));
  const notes = c.reviewNotes?.length ?? 0;
  const parts = [
    c.costUsd > 0 || c.usage ? dim(`spent: ${fmtSpend(c)}`) : '',
    c.attempts ? dim(`review rounds: ${c.attempts + 1}`) : '',
    verifiedPart(c) ?? '',
    notes ? yellow(`${notes} note${notes === 1 ? '' : 's'}`) : '',
  ].filter(Boolean);
  lines.push(...joined(parts, w));
  return lines;
}

/** Parts on one line separated by ` · `, breaking onto further lines when the width runs out. */
function joined(parts: string[], w: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line ? `${line}${dim(' · ')}${part}` : `     ${part}`;
    if (line && cells(candidate) > w) { lines.push(line); line = `     ${part}`; } else line = candidate;
  }
  if (line) lines.push(fit(line, w));
  return lines;
}

function fullCard(c: Card, w: number): string[] {
  const lines = [fit(`  ${bold(c.id)} ${c.title}`, w)];
  for (const t of c.tasks) {
    if (!t.result) continue;
    lines.push(...labelled(`${t.id} ${t.title}:`, t.result.summary, w));
  }
  const files = [...new Set(c.tasks.flatMap((t) => t.result?.filesChanged ?? []))].sort();
  if (files.length) lines.push(...labelled('files:', files.join(', '), w).map(dim));
  if (c.costUsd > 0 || c.usage) lines.push(dim(`     spent: ${fmtSpendDetail(c)}`));
  const fixes = c.tasks.filter((t) => t.kind === 'fix').map((t) => t.title);
  if (c.attempts) lines.push(fit(dim(`     review rounds: ${c.attempts + 1}${fixes.length ? ` (fix tasks: ${fixes.join('; ')})` : ''}`), w));
  lines.push(...verifiedLine(c, w));
  if (c.review) lines.push(...labelled('review:', c.review, w));
  for (const n of c.reviewNotes ?? []) lines.push(...labelled('note:', n, w).map(yellow));
  return lines;
}
