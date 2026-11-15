// Toasts: short notices that expire on their own; the shell shows them at the top right. Time is
// passed in, so tests decide what "now" is.
import { P, c, type Glyphs } from '../theme.ts';
import { cell, plainText, width, wrapParagraphs } from '../text.ts';
import chalk from 'chalk';
import { colourless } from './compose.ts';

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';
export interface Toast { id: number; message: string; kind: ToastKind; until: number }
export interface Toasts { items: Toast[]; next: number }

/** How long each kind stays (ms): errors stay long enough to be read. */
export const TOAST_TTL: Record<ToastKind, number> = { info: 3000, ok: 3000, warn: 5000, error: 8000 };
const MAX_SHOWN = 4;
/** A message longer than this many rows ends in an ellipsis; anything shorter (a path, an error) is shown whole. */
const MAX_LINES = 6;

export function createToasts(): Toasts {
  return { items: [], next: 1 };
}

/** Add a toast; the same message again just stays up longer. */
export function pushToast(t: Toasts, message: string, kind: ToastKind, now: number, ttl = TOAST_TTL[kind]): Toast {
  const same = t.items.find((x) => x.message === message && x.kind === kind);
  if (same) { same.until = now + ttl; return same; }
  const toast = { id: t.next++, message, kind, until: now + ttl };
  t.items.push(toast);
  if (t.items.length > 8) t.items.shift();
  return toast;
}

/** Drop expired toasts; true when something went. */
export function pruneToasts(t: Toasts, now: number): boolean {
  const before = t.items.length;
  t.items = t.items.filter((x) => x.until > now);
  return t.items.length !== before;
}

/** When the next toast expires, so the shell knows to keep repainting until then. */
export function nextExpiry(t: Toasts): number | undefined {
  return t.items.length ? Math.min(...t.items.map((x) => x.until)) : undefined;
}

export function dismissToast(t: Toasts, id: number): void {
  t.items = t.items.filter((x) => x.id !== id);
}

const COLOUR: Record<ToastKind, string> = { info: P.blue, ok: P.green, warn: P.yellow, error: P.red };

function icon(kind: ToastKind, g: Glyphs): string {
  return kind === 'ok' ? g.check : kind === 'warn' ? g.warn : kind === 'error' ? g.cross : g.info;
}

/**
 * The live toasts as a block of equal-width rows (newest last), at most `maxCols` wide and `maxRows`
 * tall; older toasts are dropped first. A message wraps whole, a long path or token broken across rows
 * rather than cut, up to six rows; a long one makes the block wider (up to 60% of the screen).
 */
export function renderToasts(t: Toasts, maxCols: number, maxRows: number, g: Glyphs, now: number): string[] {
  const live = t.items.filter((x) => x.until > now).slice(-MAX_SHOWN);
  if (!live.length || maxCols < 8 || maxRows < 1) return [];
  const longest = Math.max(...live.map((x) => width(plainText(x.message))));
  const w = Math.min(maxCols, Math.max(16, Math.min(Math.max(64, Math.floor(maxCols * 0.6)), longest + 6)));
  const textW = w - 5;
  const blocks = live.map((x) => {
    const kindStyle = chalk.hex(COLOUR[x.kind]);
    const lines = wrapParagraphs(x.message, textW, MAX_LINES);
    const plain = colourless();
    return lines.map((l, i) => {
      const lead = i === 0 ? kindStyle(icon(x.kind, g)) : ' ';
      const body = ` ${lead} ${c.text(l)}`;
      if (plain) return cell(`${g.edge}${body}`, w);
      return kindStyle(g.edge) + c.bg(cell(body, w - width(g.edge)));
    });
  });
  const out: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (out.length + blocks[i]!.length > maxRows) break;
    out.unshift(...blocks[i]!);
  }
  return out;
}
