// Frame composition for the widget kit: every widget renders a block of exactly rows × cols cells,
// and these helpers cut, place and frame such blocks. All of it understands the SGR styles chalk emits
// and wide characters; a wide character cut in half by a boundary becomes spaces, never half a glyph.
import { stripVTControlCharacters } from 'node:util';
import chalk, { type ChalkInstance } from 'chalk';
import type { Mouse } from '../screen.ts';
import { c, type Glyphs } from '../theme.ts';
import { cell, fit, graphemeStops, measure, plainText, repeat, width } from '../text.ts';

export interface Size { rows: number; cols: number }
export interface Cursor { row: number; col: number }
/** A rendered block and, when something in it is being edited, where the terminal cursor goes. */
export interface Rendered { lines: string[]; cursor?: Cursor }
export interface Rect { top: number; left: number; rows: number; cols: number }

/** Named colours for content a caller does not style itself (table cells, list meta, info values). */
export type Tone = 'text' | 'subtle' | 'muted' | 'faint' | 'accent' | 'ok' | 'warn' | 'bad' | 'info';
export function tone(t: Tone | undefined): ChalkInstance {
  return c[t ?? 'text'];
}

/** True when chalk emits no styles at all (NO_COLOR, a dumb pipe): widgets then mark state with glyphs. */
export function colourless(): boolean {
  return chalk.level === 0;
}

/**
 * A placeholder (an example, what an empty field means) as it reads in a field: faint, and in
 * parentheses without colour, so it cannot pass for a value that is already there. Plain text in.
 */
export function placeholder(text: string): string {
  const t = plainText(text);
  return colourless() && t ? `(${t})` : t;
}

const SGR = /(\x1b\[[0-9;:]*m)/;
const RESET = /^\x1b\[0*m$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Cells [from, to) of a styled line. Styles active at `from` are re-opened, and the result ends with a
 * reset when it carries any style. A wide character straddling either edge becomes spaces.
 */
export function slice(line: string, from: number, to = Infinity): string {
  if (to <= from) return '';
  let out = '';
  let col = 0;
  let style = '';
  let open = false;
  let styled = false;
  const enter = () => { if (!open) { open = true; if (style) { out += style; styled = true; } } };
  outer: for (const part of line.split(SGR)) {
    if (part.startsWith('\x1b')) {
      style = RESET.test(part) ? '' : style + part;
      if (open) { out += part; styled = true; }
      continue;
    }
    for (const { segment } of segmenter.segment(part)) {
      if (col >= to) break outer;
      const w = measure(segment);
      if (w === 0) { if (col >= from) { enter(); out += segment; } continue; }
      const end = col + w;
      if (col >= from && end <= to) { enter(); out += segment; }
      else if (end > from && col < to) { enter(); out += ' '.repeat(Math.min(end, to) - Math.max(col, from)); }
      col = end;
    }
  }
  return styled ? out + '\x1b[0m' : out;
}

/** Exactly `size`: each line cut or padded to cols, rows padded with blank lines or cut. */
export function frame(lines: string[], size: Size): string[] {
  const rows = Math.max(0, size.rows);
  const out: string[] = [];
  for (let r = 0; r < rows; r++) out.push(cell(lines[r] ?? '', Math.max(0, size.cols)));
  return out;
}

/** `box` drawn over `base` with its top-left cell at (top, left). Rows of `base` outside the box are kept. */
export function overlay(base: string[], box: string[], top: number, left: number): string[] {
  const out = base.slice();
  box.forEach((line, i) => {
    const r = top + i;
    if (r < 0 || r >= out.length) return;
    const row = out[r]!;
    const bw = width(line);
    const l = Math.max(0, left);
    const head = cell(slice(row, 0, l), l);
    // Everything right of the box; empty when the box reaches the end (no need to measure the row).
    const tail = slice(row, l + bw);
    out[r] = head + line + tail;
  });
  return out;
}

/** The frame behind a modal: same text, styles dropped, painted faint. */
export function dim(lines: string[]): string[] {
  return lines.map((line) => c.faint(stripVTControlCharacters(line)));
}

/** Blocks side by side, each cut or padded to its width, `gap` blank cells between them. */
export function beside(blocks: string[][], widths: number[], rows: number, gap = 0): string[] {
  const out: string[] = [];
  const spacer = repeat(' ', gap);
  for (let r = 0; r < rows; r++) {
    out.push(blocks.map((b, i) => cell(b[r] ?? '', Math.max(0, widths[i] ?? 0))).filter((_, i) => (widths[i] ?? 0) > 0).join(spacer));
  }
  return out;
}

/** Blocks one above the other, each line cut or padded to `cols`. */
export function stack(blocks: string[][], cols: number): string[] {
  return blocks.flat().map((line) => cell(line, cols));
}

export type SplitSpec = number | { flex?: number; min?: number; max?: number };

/**
 * Divide `total` cells among `specs` with `gap` cells between parts: numbers are fixed sizes (taken
 * first, cut when they do not fit), `{ flex }` parts share what is left in proportion, respecting `min`
 * while there is room. The sizes always sum to total minus the gaps (or less when total is tiny).
 */
export function split(total: number, specs: SplitSpec[], gap = 0): number[] {
  const n = specs.length;
  if (!n) return [];
  let free = Math.max(0, total - gap * (n - 1));
  const sizes = specs.map(() => 0);
  specs.forEach((s, i) => {
    if (typeof s === 'number') { sizes[i] = Math.min(free, Math.max(0, s)); free -= sizes[i]!; }
  });
  // Flexbox-style resolution: share by weight; a part whose share breaks its min or max is frozen
  // there and the rest is shared again among the others.
  let open = specs.map((s, i) => ({ s, i })).filter((x) => typeof x.s !== 'number') as Array<{ s: { flex?: number; min?: number; max?: number }; i: number }>;
  while (open.length) {
    const weight = open.reduce((sum, x) => sum + Math.max(0, x.s.flex ?? 1), 0) || 1;
    const ideal = (x: { s: { flex?: number } }) => free * Math.max(0, x.s.flex ?? 1) / weight;
    const low = open.filter((x) => x.s.min !== undefined && ideal(x) < x.s.min);
    const high = low.length ? [] : open.filter((x) => x.s.max !== undefined && ideal(x) > x.s.max);
    const frozen = low.length ? low : high;
    if (!frozen.length) {
      let left = free;
      for (const x of open) { const n = Math.floor(ideal(x)); sizes[x.i] = n; left -= n; }
      for (const x of open) { if (left <= 0) break; sizes[x.i]!++; left--; }
      break;
    }
    for (const x of frozen) {
      const n = Math.max(0, Math.min(free, low.length ? x.s.min! : x.s.max!));
      sizes[x.i] = n;
      free -= n;
    }
    open = open.filter((x) => !frozen.includes(x));
  }
  return sizes;
}

/** Rects for `split` along columns (side by side) inside `area`. */
export function splitCols(area: Rect, specs: SplitSpec[], gap = 0): Rect[] {
  let left = area.left;
  return split(area.cols, specs, gap).map((cols) => { const r = { top: area.top, left, rows: area.rows, cols }; left += cols + gap; return r; });
}

/** Rects for `split` along rows (stacked) inside `area`. */
export function splitRows(area: Rect, specs: SplitSpec[], gap = 0): Rect[] {
  let top = area.top;
  return split(area.rows, specs, gap).map((rows) => { const r = { top, left: area.left, rows, cols: area.cols }; top += rows + gap; return r; });
}

/**
 * Paint blocks into a blank frame at their rects. Widgets report a cursor only while focused, so the
 * cursor kept is that of the last block reporting one, moved to frame coordinates.
 */
export function compose(size: Size, parts: Array<{ rect: Rect; block: string[] | Rendered }>): Rendered {
  let lines = frame([], size);
  let cursor: Cursor | undefined;
  for (const { rect, block } of parts) {
    if (rect.rows <= 0 || rect.cols <= 0) continue;
    const r = toRendered(block);
    lines = overlay(lines, frame(r.lines, rect), rect.top, rect.left);
    if (r.cursor) cursor = { row: rect.top + r.cursor.row, col: rect.left + r.cursor.col };
  }
  return { lines, cursor };
}

export function toRendered(x: string[] | Rendered): Rendered {
  return Array.isArray(x) ? { lines: x } : x;
}

/** A mouse report relative to `rect`, or undefined when it falls outside. */
export function hit(m: Mouse, rect: Rect): Mouse | undefined {
  if (m.row < rect.top || m.row >= rect.top + rect.rows || m.col < rect.left || m.col >= rect.left + rect.cols) return undefined;
  return { ...m, row: m.row - rect.top, col: m.col - rect.left };
}

/** The escape that opens a chalk style, so a background can be re-opened after an inner reset. */
function opener(style: ChalkInstance): string {
  return style('\u0000').split('\u0000')[0] ?? '';
}

/** A full-width row on a background that survives the resets inside `line`. */
export function onBackground(line: string, cols: number, bg: ChalkInstance): string {
  const open = opener(bg);
  const body = cell(line, cols);
  if (!open) return body;
  return open + body.replace(/\x1b\[0*m|\x1b\[49m/g, (m) => m + open) + '\x1b[0m';
}

/**
 * Which rows of a `rows`-tall scrollbar are thumb, for a viewport of `visible` rows at `top` over
 * `total`. Empty when everything fits.
 */
export function thumb(rows: number, top: number, total: number, visible: number): boolean[] {
  if (rows <= 0 || total <= visible || total <= 0) return [];
  const size = Math.max(1, Math.min(rows, Math.round(rows * visible / total)));
  const maxTop = Math.max(1, total - visible);
  const start = Math.round((rows - size) * Math.max(0, Math.min(top, maxTop)) / maxTop);
  return Array.from({ length: rows }, (_, i) => i >= start && i < start + size);
}

export interface ScrollInfo { top: number; total: number; visible: number }

/** A value, or a function giving it — evaluated after the body rendered. */
export type Lazy<T> = T | (() => T);
const lazy = <T>(v: Lazy<T>): T => (typeof v === 'function' ? (v as () => T)() : v);

export interface PanelOptions {
  g: Glyphs;
  /** Plain text; sanitized here. */
  title?: string;
  /** Trusted styled text at the right of the top border, e.g. a count. Dropped first when narrow. */
  badge?: Lazy<string>;
  /** Trusted styled text in the bottom border, e.g. a position. */
  footer?: Lazy<string>;
  /** Mauve border and bold title. */
  focused?: boolean;
  /**
   * Draws a scrollbar in the right border when total exceeds visible. Pass a function (e.g.
   * `() => listScroll(list)`) so it is read after the body rendered and knows the real height.
   */
  scroll?: Lazy<ScrollInfo | undefined>;
  /** Blank cells between the border and the content on each side (default 1). */
  pad?: number;
  /** Border colour instead of the focus colours (a danger dialog is red). */
  border?: ChalkInstance;
  /**
   * Without colour a focused panel puts the pointer before its title, so the panel with the keyboard
   * shows (as in the run view). Default true; dialogs, which always have it, pass false.
   */
  mark?: boolean;
}

/**
 * A rounded, titled border around `body`, which renders into the inner size. Below 3 rows or 6
 * columns the border is dropped and the body gets the whole area: content before decoration.
 */
export function panel(size: Size, o: PanelOptions, body: (inner: Size) => string[] | Rendered): Rendered {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return { lines: frame([], size) };
  if (rows < 3 || cols < 6) {
    const r = toRendered(body(size));
    return { lines: frame(r.lines, size), cursor: r.cursor };
  }
  const { g } = o;
  const pad = Math.max(0, Math.min(o.pad ?? 1, Math.floor((cols - 3) / 2)));
  const inner = { rows: rows - 2, cols: cols - 2 - pad * 2 };
  const r = toRendered(body(inner));
  const content = frame(r.lines, inner);
  const edge = o.border ?? (o.focused ? c.selected : c.border);
  const [tl, tr, bl, br] = g.corners;

  const marked = Boolean(o.focused && o.mark !== false && colourless());
  const plainTitle = o.title ? plainText(o.title) : '';
  const titleText = marked ? (plainTitle ? `${g.pointer} ${plainTitle}` : g.pointer) : plainTitle;
  const title = titleText ? (o.focused ? c.accent.bold : c.subtle) : c.text;
  const span = cols - 2;
  const badgeText = o.badge === undefined ? '' : lazy(o.badge);
  const footerText = o.footer === undefined ? '' : lazy(o.footer);
  const scroll = o.scroll === undefined ? undefined : lazy(o.scroll);
  let top: string;
  {
    // ╭─ Title ───── badge ─╮ — the badge goes first when space runs out, then the title is cut.
    const badge = badgeText ? ` ${badgeText} ` : '';
    const wantTitle = titleText ? Math.min(width(titleText), 10) + 2 : 0;
    const badgeW = badge && 1 + wantTitle + width(badge) + 1 <= span ? width(badge) : 0;
    const titleRoom = span - 1 - (badgeW ? badgeW + 1 : 0) - 2;
    const t = titleText && titleRoom >= 1 ? ` ${fit(titleText, titleRoom)} ` : '';
    const fill = Math.max(0, span - 1 - width(t) - (badgeW ? badgeW + 1 : 0));
    top = edge(tl + g.h) + (t ? title(t) : '') + edge(repeat(g.h, fill)) + (badgeW ? badge + edge(g.h) : '') + edge(tr);
  }
  let bottom: string;
  {
    const f = footerText ? ` ${footerText} ` : '';
    const fw = width(f) + 2 <= span ? width(f) : 0;
    bottom = edge(bl + g.h) + (fw ? f : '') + edge(repeat(g.h, span - 1 - fw)) + edge(br);
  }
  const bar = scroll ? thumb(inner.rows, scroll.top, scroll.total, scroll.visible) : [];
  const thumbStyle = o.focused ? c.selected : c.muted;
  const lines = [top];
  const sidePad = repeat(' ', pad);
  content.forEach((line, i) => {
    const right = bar.length ? (bar[i] ? thumbStyle(g.thumb) : edge(g.track)) : edge(g.v);
    lines.push(edge(g.v) + sidePad + line + sidePad + right);
  });
  lines.push(bottom);
  const cursor = r.cursor ? { row: r.cursor.row + 1, col: r.cursor.col + 1 + pad } : undefined;
  return { lines: lines.map((l) => cell(l, cols)), cursor };
}

/** Where a box of `box` size sits centred (or near the top) in `size`. */
export function place(box: Size, size: Size, at: 'center' | 'top' = 'center'): { top: number; left: number } {
  const left = Math.max(0, Math.floor((size.cols - box.cols) / 2));
  const top = at === 'top'
    ? Math.max(0, Math.min(Math.floor(size.rows / 6), size.rows - box.rows))
    : Math.max(0, Math.floor((size.rows - box.rows) / 2));
  return { top, left };
}

/** Highlight the graphemes at `positions` (indices into the grapheme list of plain `text`). */
export function highlight(text: string, positions: Iterable<number>, base: (s: string) => string, hl: (s: string) => string): string {
  const marks = new Set(positions);
  if (!marks.size) return base(text);
  let out = '';
  let run = '';
  let lit = false;
  let i = 0;
  for (const { segment } of segmenter.segment(text)) {
    const on = marks.has(i++);
    if (on !== lit && run) { out += lit ? hl(run) : base(run); run = ''; }
    lit = on;
    run += segment;
  }
  if (run) out += lit ? hl(run) : base(run);
  return out;
}

/** Plain text split into graphemes. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/**
 * Soft-wrap boundaries for a line of code points into rows of at most `w` cells: [start, end) pairs of
 * code point offsets. Breaks after the last space that fits, else mid-word; spaces are kept
 * (indentation survives). Each grapheme is measured whole, as the terminal draws it (an emoji with its
 * variation selector is two cells, not one), and never split. An empty line is one empty row.
 */
export function wrapRanges(cps: string[], w: number): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  const max = Math.max(1, w);
  // Work in graphemes: stops[k] is where grapheme k starts, in code points.
  const stops = graphemeStops(cps);
  const n = stops.length - 1;
  const widths = Array.from({ length: n }, (_, k) => measure(cps.slice(stops[k]!, stops[k + 1]!).join('')));
  const space = (k: number) => stops[k + 1]! - stops[k]! === 1 && cps[stops[k]!] === ' ';
  let start = 0;
  let used = 0;
  let lastSpace = -1;
  for (let k = 0; k < n; k++) {
    const cw = widths[k]!;
    while (used + cw > max && k > start) {
      const end = lastSpace >= start ? lastSpace + 1 : k;
      rows.push([stops[start]!, stops[end]!]);
      start = end;
      used = 0;
      lastSpace = -1;
      for (let j = start; j < k; j++) { used += widths[j]!; if (space(j)) lastSpace = j; }
    }
    used += cw;
    if (space(k)) lastSpace = k;
  }
  rows.push([stops[start]!, cps.length]);
  return rows;
}

/** Plain text soft-wrapped into rows of at most `w` cells, nothing dropped, spaces kept. */
export function softWrap(text: string, w: number): string[] {
  const cps = [...text];
  return wrapRanges(cps, w).map(([s, e]) => cps.slice(s, e).join(''));
}
