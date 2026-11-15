// A scroll view for long text — reports, logs, unified diffs — with soft wrap or horizontal
// scrolling, a scrollbar and a position indicator. Rendering writes back the scroll bookkeeping
// (`top`, `left`, `height`, `width`) and caches the wrapped rows per width. `scrollLines` makes one over
// lines that already carry their own styles: their plain text wraps and scrolls, each row is painted
// from the styled line it came from.
import type { Key, Mouse } from '../screen.ts';
import { c, type Glyphs } from '../theme.ts';
import { cell, plainText, width } from '../text.ts';
import { frame, slice, softWrap, type ScrollInfo, type Size } from './compose.ts';
import { scrollbar } from './bits.ts';

export interface ScrollState {
  /** Source lines, raw: sanitized when drawn. Over styled lines, their plain text. */
  lines: string[];
  /** The styled lines `lines` is the plain text of, when the view was made with `scrollLines`. */
  styled?: string[];
  wrap: boolean;
  /** Colour the text as a unified diff. */
  diff: boolean;
  /** When text changes while the view is at the bottom, stay at the bottom (logs). */
  follow: boolean;
  top: number;
  left: number;
  height: number;
  width: number;
  cache?: { width: number; wrap: boolean; diff: boolean; lines: string[]; rows: string[]; longest: number };
}

export interface ScrollOptions { wrap?: boolean; diff?: boolean; follow?: boolean }

export function createScroll(text: string, o: ScrollOptions = {}): ScrollState {
  return { lines: splitLines(text), wrap: o.wrap ?? true, diff: Boolean(o.diff), follow: Boolean(o.follow), top: 0, left: 0, height: 1, width: 0 };
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Replace the text. The position is kept (or stays at the bottom when following). */
export function setScrollText(s: ScrollState, text: string): void {
  const atBottom = s.top >= Math.max(0, visualRows(s).length - s.height);
  s.lines = splitLines(text);
  s.styled = undefined;
  s.cache = undefined;
  if (s.follow && atBottom) s.top = Number.MAX_SAFE_INTEGER;
}

/**
 * A scroll view over lines that are already styled (built from sanitized text with the theme's styles).
 * Their plain text is what wraps, scrolls and is measured; each row keeps the styles of its line.
 */
export function scrollLines(lines: string[], o: Omit<ScrollOptions, 'diff'> = {}): ScrollState {
  const s = createScroll('', o);
  setScrollLines(s, lines);
  return s;
}

/** Replace a styled view's lines; back at the top unless `keep` (or following at the bottom). */
export function setScrollLines(s: ScrollState, lines: string[], o: { keep?: boolean } = {}): void {
  const atBottom = s.top >= Math.max(0, visualRows(s).length - s.height);
  s.styled = lines.length ? lines.slice() : [''];
  s.lines = s.styled.map((l) => plainText(l));
  s.diff = false;
  s.cache = undefined;
  if (!o.keep) { s.top = 0; s.left = 0; }
  if (s.follow && atBottom) s.top = Number.MAX_SAFE_INTEGER;
}

export function toggleWrap(s: ScrollState): void {
  // Keep roughly the same place: the source line at the top stays near the top.
  const rows = visualRows(s);
  const ratio = rows.length ? s.top / rows.length : 0;
  s.wrap = !s.wrap;
  s.left = 0;
  s.cache = undefined;
  s.top = Math.round(ratio * visualRows(s).length);
}

/** Tabs to spaces (git and most editors show diffs this way), so columns line up. */
export function expandTabs(line: string, tab = 4): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(tab - (width(out) % tab));
    else out += ch;
  }
  return out;
}

const META = /^(index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to)/;

/** One plain line of a unified diff, coloured: file headers, hunks, additions, removals, metadata. */
export function styleDiffLine(line: string): string {
  if (line.startsWith('diff ')) return c.info.bold(line);
  if (line.startsWith('+++') || line.startsWith('---')) return c.text.bold(line);
  if (META.test(line)) return c.muted(line);
  if (line.startsWith('@@')) {
    const end = line.indexOf('@@', 2);
    return end > 0 ? c.accent(line.slice(0, end + 2)) + c.muted(line.slice(end + 2)) : c.accent(line);
  }
  if (line.startsWith('+')) return c.ok(line);
  if (line.startsWith('-')) return c.bad(line);
  if (line.startsWith('\\')) return c.faint(line);
  if (line.startsWith('Binary files')) return c.warn(line);
  return c.text(line);
}

function visualRows(s: ScrollState): string[] {
  const w = Math.max(1, s.width || 80);
  const k = s.cache;
  if (k && k.lines === s.lines && k.width === w && k.wrap === s.wrap && k.diff === s.diff) return k.rows;
  const rows: string[] = [];
  let longest = 0;
  if (s.styled) {
    // Styled lines: wrap the plain text, cut each row out of the styled line at the same cells.
    s.lines.forEach((plain, i) => {
      const styled = s.styled![i] ?? plain;
      longest = Math.max(longest, width(plain));
      if (!s.wrap) { rows.push(styled); return; }
      let at = 0;
      for (const part of plain ? softWrap(plain, w) : ['']) { const pw = width(part); rows.push(slice(styled, at, at + pw)); at += pw; }
    });
    s.cache = { width: w, wrap: s.wrap, diff: s.diff, lines: s.lines, rows, longest };
    return rows;
  }
  for (const raw of s.lines) {
    const clean = plainText(expandTabs(raw));
    const paint = s.diff ? styleDiffLine : (t: string) => c.text(t);
    if (s.wrap) {
      // Diffs wrap by character so nothing reflows; their colour comes from the whole line.
      const parts = clean ? softWrap(clean, w) : [''];
      if (s.diff) {
        const styled = styleDiffLine(clean);
        let at = 0;
        for (const part of parts) { const pw = width(part); rows.push(slice(styled, at, at + pw)); at += pw; }
      } else {
        for (const part of parts) rows.push(paint(part));
      }
    } else {
      rows.push(paint(clean));
      longest = Math.max(longest, width(clean));
    }
  }
  s.cache = { width: w, wrap: s.wrap, diff: s.diff, lines: s.lines, rows, longest };
  return rows;
}

export function scrollInfo(s: ScrollState): ScrollInfo {
  return { top: s.top, total: visualRows(s).length, visible: s.height };
}

/** `12-40/340 3%` — the rows in view and how many there are; `all 12` when everything fits. */
export function scrollPosition(s: ScrollState): string {
  const total = visualRows(s).length;
  if (total <= s.height) return `${total} line${total === 1 ? '' : 's'}`;
  const pct = Math.round((s.top / Math.max(1, total - s.height)) * 100);
  return `${s.top + 1}-${Math.min(total, s.top + s.height)}/${total} ${pct}%`;
}

export interface ScrollRenderOptions {
  focused?: boolean;
  /** Draw a scrollbar in the last column (default false: a panel draws it in its border from `scrollInfo`). */
  scrollbar?: boolean;
}

export function renderScroll(s: ScrollState, size: Size, g: Glyphs, o: ScrollRenderOptions = {}): string[] {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return frame([], size);
  // Decide on the scrollbar with the full width first, so the wrap width is stable between frames.
  s.width = cols;
  s.height = rows;
  let all = visualRows(s);
  const bar = o.scrollbar === true && cols > 4 && all.length > rows;
  if (bar) { s.width = cols - 1; all = visualRows(s); }
  const w = bar ? cols - 1 : cols;
  s.top = Math.max(0, Math.min(s.top, Math.max(0, all.length - rows)));
  const longest = s.cache?.longest ?? 0;
  s.left = s.wrap ? 0 : Math.max(0, Math.min(s.left, Math.max(0, longest - w)));
  const shown = all.slice(s.top, s.top + rows).map((line) => cell(s.wrap ? line : slice(line, s.left, s.left + w), w));
  const out = frame(shown, { rows, cols: w });
  if (bar) {
    const sb = scrollbar(rows, s.top, all.length, rows, g, o.focused);
    for (let r = 0; r < rows; r++) out[r] = out[r]! + sb[r]!;
  }
  return out;
}

export function scrollKey(s: ScrollState, k: Key): boolean {
  const page = Math.max(1, s.height - 1);
  const total = () => visualRows(s).length;
  const by = (d: number) => { s.top = Math.max(0, Math.min(Math.max(0, total() - s.height), s.top + d)); return true; };
  const side = (d: number) => { if (s.wrap) return false; s.left = Math.max(0, s.left + d); return true; };
  switch (k.name) {
    case 'up': return by(-1);
    case 'down': return by(1);
    case 'pageup': return by(-page);
    case 'pagedown': return by(page);
    case 'home': s.top = 0; s.left = 0; return true;
    case 'end': s.top = Math.max(0, total() - s.height); return true;
    case 'left': return side(-8);
    case 'right': return side(8);
    case 'char':
      switch (k.ch) {
        case 'j': return by(1);
        case 'k': return by(-1);
        case ' ': return by(page);
        case 'b': return by(-page);
        case 'g': s.top = 0; return true;
        case 'G': s.top = Math.max(0, total() - s.height); return true;
        case 'h': return side(-8);
        case 'l': return side(8);
      }
      return false;
    default: return false;
  }
}

export function scrollMouse(s: ScrollState, m: Mouse): boolean {
  if (m.kind === 'wheel-up' || m.kind === 'wheel-down') {
    const d = m.kind === 'wheel-up' ? -3 : 3;
    s.top = Math.max(0, Math.min(Math.max(0, visualRows(s).length - s.height), s.top + d));
    return true;
  }
  return false;
}
