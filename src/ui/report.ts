// The end-of-run report: what landed, what did not, and what to do next. Built from the board alone
// (plus an optional diff stat) so `dulger report` can print it again at any time.
import { bold, cyan, dim, green, red, yellow, fmtSpendDetail, fmtWindows } from './ansi.ts';
import type { Board, Card, RateLimits } from '../types.ts';

export interface ReportOptions {
  /** `git diff --stat base...result`, when the caller has it. */
  diffStat?: string;
  /** Branch the result was merged into, when --merge ran. */
  mergedInto?: string;
}

export function buildReport(board: Board, opts: ReportOptions = {}): string {
  const cards = board.cards.filter((c) => c.status !== 'replaced');
  const landed = cards.filter((c) => c.status === 'done');
  const notLanded = cards.filter((c) => c.status !== 'done');
  const docs = board.docs;
  const out: string[] = [];
  const h = (s: string) => out.push('', bold(cyan(s)));

  out.push(bold(`Run ${board.runId}`) + dim(`  ${board.baseBranch} @ ${board.baseRef.slice(0, 7)} → ${board.runBranch}${opts.mergedInto ? ` (merged into ${opts.mergedInto})` : ''}`));
  out.push(dim('Goal: ') + board.goal);
  const docsLine = docs ? (docs.status === 'done' ? 'docs updated' : docs.status === 'skipped' ? 'docs skipped' : `docs ${docs.status}`) : 'no docs';
  const count = `${landed.length} of ${cards.length} card${cards.length === 1 ? '' : 's'}`;
  out.push(`Landed ${landed.length === cards.length ? green(count) : yellow(count)}, ${docsLine} · spent ${fmtSpendDetail(board)}` + (board.replans ? dim(` · replanned ${board.replans}×`) : ''));

  if (board.rateLimits) out.push(`Plan windows at the end of the run: ${fmtWindows(board.rateLimits)}` + resetHint(board.rateLimits));
  if (landed.length) {
    h('Landed');
    for (const c of landed) out.push(...cardLines(c));
  }
  if (notLanded.length) {
    out.push('', bold(red('Not landed')));
    for (const c of notLanded) {
      const why = c.status === 'failed' && c.failure === 'infrastructure' ? 'dulger could not run a step; resume retries it' : c.status === 'failed' ? `failed after ${c.attempts} review round${c.attempts === 1 ? '' : 's'}` : c.status === 'blocked' ? 'blocked by a failed dependency' : c.status;
      out.push(`  ${bold(c.id)} ${c.title} ${red(`— ${why}`)}`);
      const last = c.feedback.at(-1);
      if (last) out.push(`     ${dim('last feedback:')} ${last.split('\n')[0]}`);
      out.push(...verifiedLine(c));
      if (c.review) out.push(`     ${dim('review:')} ${c.review}`);
    }
  }
  if (docs?.summary) { h('Documentation'); out.push(`  ${docs.summary}`); }
  const stat = opts.diffStat?.replace(/^\n+/, '').trimEnd();
  if (stat) { h('Changes'); out.push(...stat.split('\n').map((l) => dim(' ' + l))); }

  h('Next');
  if (board.halted) out.push(yellow(`  the run stopped itself: ${board.halted.reason}`));
  if (opts.mergedInto) out.push(`  the result is on ${green(opts.mergedInto)}`);
  else if (landed.length) out.push(`  git merge ${green(board.runBranch)}     ${dim(`# or: git diff ${board.baseBranch}...${board.runBranch}`)}`);
  else out.push(dim('  nothing landed'));
  if (notLanded.length) out.push(`  dulger resume ${board.runId}      ${dim('# retry the cards that did not land')}`);
  const notes = landed.reduce((n, c) => n + (c.reviewNotes?.length ?? 0), 0);
  if (notes) out.push(dim(notes === 1 ? '  the reviewer note above is worth a follow-up run' : `  the ${notes} reviewer notes above are worth a follow-up run`));
  return out.join('\n') + '\n';
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
function verifiedLine(c: Card): string[] {
  if (!c.verify.length) return [yellow('     verified: nothing (the plan named no verify commands)')];
  if (!c.verification?.length) return [];
  return [`     ${dim('verified:')} ${c.verification.map((r) => (r.ok ? green(`✓ ${r.command}`) : red(`✗ ${r.command} (exit ${r.exitCode})`))).join(dim(' · '))}`];
}

function cardLines(c: Card): string[] {
  const lines = [`  ${bold(c.id)} ${c.title}`];
  for (const t of c.tasks) {
    if (!t.result) continue;
    lines.push(`     ${dim(t.id)} ${t.title}: ${t.result.summary}`);
  }
  const files = [...new Set(c.tasks.flatMap((t) => t.result?.filesChanged ?? []))].sort();
  if (files.length) lines.push(dim(`     files: ${files.join(', ')}`));
  if (c.costUsd > 0 || c.usage) lines.push(dim(`     spent: ${fmtSpendDetail(c)}`));
  if (c.attempts) lines.push(dim(`     review rounds: ${c.attempts + 1} (fix tasks: ${c.tasks.filter((t) => t.kind === 'fix').map((t) => t.title).join('; ')})`));
  lines.push(...verifiedLine(c));
  if (c.review) lines.push(`     ${dim('review:')} ${c.review}`);
  for (const n of c.reviewNotes ?? []) lines.push(yellow(`     note: ${n}`));
  return lines;
}
