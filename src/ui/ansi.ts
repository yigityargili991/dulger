// Tiny ANSI helpers. No dependencies.
import type { RateLimits, Usage } from '../types.ts';
import { cachedShare, usageTokens } from '../usage.ts';
import { plainText } from '../tui/text.ts';

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
}

/**
 * `s` as it may be printed. Without colour (a pipe, NO_COLOR) nothing styles the output, so a reset
 * that cutting a line to the width left in it is taken out too: a log or a pipe gets text only.
 */
export function printable(s: string): string {
  return enabled ? s : s.replace(/\x1b\[[0-9;:]*m/g, '');
}

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const magenta = wrap(35);
export const cyan = wrap(36);

export const cursor = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  home: '\x1b[H',
  clearScreen: '\x1b[2J',
  clearLine: '\x1b[2K',
  clearToEnd: '\x1b[J',
};

/** Visible length, ignoring escape codes. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').length;
}

/** Truncate to `width` visible chars, adding an ellipsis. Input must be free of escapes. */
export function truncate(s: string, width: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  if (width <= 1) return flat.slice(0, width);
  return flat.slice(0, width - 1) + '…';
}

/** Right-pad to `width` visible chars (never shrinks). */
export function pad(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + ' '.repeat(width - len);
}

/** "14:03:07", the time a log line carries: local, like every other time dulger shows. */
export function clockTime(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtCost(usd: number | undefined): string {
  return usd === undefined ? '-' : `$${usd.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

/** "$1.23 · 45k tokens"; dollars only when a harness reported them, tokens whenever known. */
export function fmtSpend(x: { costUsd: number; usage?: Usage }): string {
  const parts: string[] = [];
  if (x.costUsd > 0) parts.push(fmtCost(x.costUsd));
  if (x.usage) parts.push(`${fmtTokens(usageTokens(x.usage))} tokens`);
  return parts.join(' · ') || '-';
}

const WINDOW_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d' };

/** "5h 35% · 7d 23%": how much of each plan window is used, per the harness's last report. */
export function fmtWindows(rl: RateLimits): string {
  return rl.windows.map((w) => `${WINDOW_NAMES[w.name] ?? plainText(String(w.name))} ${Math.round(w.utilization * 100)}%`).join(' · ');
}

/** "$1.23 · 45k tokens (91% cached, 2k out)": the spend with the usage split that explains it. */
/** Columns to lay out for: the terminal's, or `fallback` when the output is not one. Never under 60. */
export function terminalWidth(fallback = 100, out: { columns?: number } = process.stdout): number {
  return Math.max(60, out.columns ?? fallback);
}

export function fmtSpendDetail(x: { costUsd: number; usage?: Usage }): string {
  const u = x.usage;
  if (!u) return fmtSpend(x);
  return `${fmtSpend(x)} (${Math.round(cachedShare(u) * 100)}% cached, ${fmtTokens(u.output)} out)`;
}
