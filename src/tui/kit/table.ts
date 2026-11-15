// A table: column definitions (fixed, automatic or flexible widths, alignment, droppable columns),
// a header row, row selection and scrolling, cells with an optional styled icon. Like the list,
// rendering writes back only scroll bookkeeping (`top`, `height`, `offset`). `renderListTable` draws
// a list's shown items as table rows, so a list can filter and select while the rows have columns.
import type { Key, Mouse } from '../screen.ts';
import { c, type Glyphs } from '../theme.ts';
import { cell, fit, plainText, repeat, width } from '../text.ts';
import { frame, tone, type ScrollInfo, type Size, type Tone } from './compose.ts';
import { follow, listFilterLine, listShowsFilter, selectableRow, shownItems, type ListItem, type ListState } from './list.ts';

export interface TableColumn {
  title: string;
  /** A fixed width in cells. */
  width?: number;
  /** A share of the space left after fixed and automatic columns. Without width or flex a column fits its content (up to 32). */
  flex?: number;
  /** The narrowest a column gets before the table drops columns (default: the title's width, at least 3). */
  min?: number;
  align?: 'left' | 'right' | 'center';
  /** Dropped first, from the right, when the table is too narrow. */
  optional?: boolean;
}

export interface TableRow {
  id: string;
  /** Plain text per column (sanitized when drawn). */
  cells: string[];
  tones?: Array<Tone | undefined>;
  /** Trusted, already-styled text drawn before a cell's text, e.g. a glyph in its own colour. */
  icons?: Array<string | undefined>;
  disabled?: boolean;
}

/** Cells an icon takes before its cell's text (the icon, and a space when text follows). */
function iconWidth(r: TableRow, i: number): number {
  const icon = r.icons?.[i];
  return icon ? width(icon) + (r.cells[i] ? 1 : 0) : 0;
}

export interface TableState {
  columns: TableColumn[];
  rows: TableRow[];
  index: number;
  top: number;
  height: number;
  offset: number;
  empty: string;
}

const GAP = 2;
const AUTO_MAX = 32;

export function createTable(columns: TableColumn[], rows: TableRow[], o: { selected?: string; empty?: string } = {}): TableState {
  const s: TableState = { columns, rows, index: 0, top: 0, height: 1, offset: 1, empty: o.empty ?? 'Nothing here yet.' };
  if (o.selected !== undefined) s.index = Math.max(0, rows.findIndex((r) => r.id === o.selected));
  return s;
}

/** Replace the rows, keeping the selection on the same id when it is still there. */
export function setRows(s: TableState, rows: TableRow[]): void {
  const keep = s.rows[s.index]?.id;
  s.rows = rows;
  const i = keep === undefined ? -1 : rows.findIndex((r) => r.id === keep);
  s.index = i >= 0 ? i : Math.max(0, Math.min(s.index, rows.length - 1));
}

export function selectedRow(s: TableState): TableRow | undefined {
  return s.rows[s.index];
}

export function tableScroll(s: TableState): ScrollInfo {
  return { top: s.top, total: s.rows.length, visible: s.height };
}

/** Widths per column for `cols` cells of content (after the pointer); 0 means the column is dropped. */
export function columnWidths(columns: TableColumn[], rows: TableRow[], cols: number): number[] {
  const desired = columns.map((col, i) => {
    if (col.width !== undefined) return col.width;
    if (col.flex !== undefined) return 0;
    const content = rows.reduce((m, r) => Math.max(m, width(plainText(r.cells[i] ?? '')) + iconWidth(r, i)), width(plainText(col.title)));
    return Math.min(AUTO_MAX, content);
  });
  const minOf = (i: number) => Math.max(1, columns[i]!.min ?? Math.max(3, Math.min(width(plainText(columns[i]!.title)), desired[i]! || 99)));
  const visible = columns.map(() => true);
  // A column with nothing in it (no title, no cell) takes no room and no gap.
  const need = () => {
    const shown = visible.map((v, i) => (v && (columns[i]!.flex !== undefined || desired[i]! > 0) ? i : -1)).filter((i) => i >= 0);
    return shown.reduce((sum, i) => sum + (columns[i]!.flex !== undefined ? minOf(i) : desired[i]!), 0) + GAP * Math.max(0, shown.length - 1);
  };
  // Drop optional columns from the right until the rest fit at their natural or minimum widths.
  for (let i = columns.length - 1; i >= 0 && need() > cols; i--) if (columns[i]!.optional) visible[i] = false;
  const widths = columns.map((col, i) => (!visible[i] ? 0 : col.flex !== undefined ? minOf(i) : desired[i]!));
  const shownCount = () => visible.filter((v, i) => v && widths[i]! > 0).length;
  let total = widths.reduce((a, b) => a + b, 0) + GAP * Math.max(0, shownCount() - 1);
  // Still too wide: shave the widest columns down towards their minimums, then drop from the right.
  while (total > cols) {
    let widest = -1;
    widths.forEach((w, i) => { if (visible[i] && w > minOf(i) && (widest < 0 || w > widths[widest]!)) widest = i; });
    if (widest < 0) break;
    widths[widest]!--;
    total--;
  }
  // The last column standing is never dropped (it is cut to fit below), whichever column that is.
  for (let i = columns.length - 1; i >= 0 && total > cols && shownCount() > 1; i--) {
    if (!visible[i]) continue;
    total -= widths[i]! + (widths[i]! > 0 ? GAP : 0);
    widths[i] = 0;
    visible[i] = false;
  }
  if (total > cols) { const first = visible.indexOf(true); if (first >= 0) widths[first] = Math.max(0, widths[first]! - (total - cols)); total = cols; }
  // Hand what is left to the flexible columns by weight.
  let free = cols - total;
  const flex = columns.map((col, i) => ({ i, f: visible[i] ? col.flex ?? 0 : 0 })).filter((x) => x.f > 0);
  const weight = flex.reduce((s, x) => s + x.f, 0);
  if (weight && free > 0) {
    const pool = free;
    for (const { i, f } of flex) { const add = Math.floor(pool * f / weight); widths[i]! += add; free -= add; }
    for (const { i } of flex) { if (free <= 0) break; widths[i]!++; free--; }
  }
  return widths;
}

/** The width the table needs (pointer, columns at their content width, gaps), so a page need not stretch it. */
export function tableWidth(s: TableState, g: Glyphs): number {
  const widths = columnWidths(s.columns.map((col) => ({ ...col, flex: undefined })), s.rows, 100_000);
  return width(g.pointer) + 1 + widths.reduce((a, b) => a + b, 0) + GAP * Math.max(0, widths.filter((w) => w > 0).length - 1);
}

function align(text: string, w: number, how: TableColumn['align']): string {
  const t = fit(text, w);
  const pad = Math.max(0, w - width(t));
  if (how === 'right') return repeat(' ', pad) + t;
  if (how === 'center') return repeat(' ', Math.floor(pad / 2)) + t + repeat(' ', pad - Math.floor(pad / 2));
  return t + repeat(' ', pad);
}

function line(cells: string[], widths: number[]): string {
  return cells.filter((_, i) => widths[i]! > 0).join(repeat(' ', GAP));
}

export function renderTable(s: TableState, size: Size, g: Glyphs, o: { focused?: boolean; header?: boolean } = {}): string[] {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return frame([], size);
  const pw = width(g.pointer) + 1;
  const widths = columnWidths(s.columns, s.rows, Math.max(0, cols - pw));
  const lines: string[] = [];
  if (o.header !== false && rows >= 2) {
    lines.push(repeat(' ', pw) + line(s.columns.map((col, i) => c.subtle.bold(align(plainText(col.title), widths[i]!, col.align))), widths));
  }
  s.offset = lines.length;
  const height = Math.max(0, rows - lines.length);
  s.height = Math.max(1, height);
  s.index = Math.max(0, Math.min(s.index, s.rows.length - 1));
  s.top = follow(s.top, s.index, s.height, s.rows.length);
  if (!s.rows.length && height) lines.push(repeat(' ', pw) + c.muted(fit(plainText(s.empty), Math.max(0, cols - pw))));
  for (let r = 0; r < height && s.top + r < s.rows.length; r++) {
    const i = s.top + r;
    const row = s.rows[i]!;
    const selected = i === s.index;
    const cells = s.columns.map((col, ci) => {
      const paint = row.disabled ? c.faint : tone(row.tones?.[ci]);
      const w = widths[ci]!;
      const iw = Math.min(w, iconWidth(row, ci));
      const text = align(plainText(row.cells[ci] ?? ''), w - iw, col.align);
      const icon = iw ? cell(row.icons![ci]!, iw) : '';
      return icon + (selected && !row.disabled ? paint.bold(text) : paint(text));
    });
    lines.push(selectableRow(line(cells, widths), cols, g, selected, Boolean(o.focused)));
  }
  return frame(lines, size).map((l) => cell(l, cols));
}

export function tableKey(s: TableState, k: Key): boolean {
  const page = Math.max(1, s.height - 1);
  const last = s.rows.length - 1;
  const to = (i: number) => { s.index = Math.max(0, Math.min(last, i)); return true; };
  switch (k.name) {
    case 'up': return to(s.index - 1);
    case 'down': return to(s.index + 1);
    case 'pageup': return to(s.index - page);
    case 'pagedown': return to(s.index + page);
    case 'home': return to(0);
    case 'end': return to(last);
    case 'char':
      if (k.ch === 'j') return to(s.index + 1);
      if (k.ch === 'k') return to(s.index - 1);
      if (k.ch === 'g') return to(0);
      if (k.ch === 'G') return to(last);
      return false;
    default: return false;
  }
}

/** Relative to the table's top-left cell; 'activate' for a click on the selected row. */
export function tableMouse(s: TableState, m: Mouse): boolean | 'activate' {
  if (m.kind === 'wheel-up' || m.kind === 'wheel-down') {
    const d = m.kind === 'wheel-up' ? -3 : 3;
    s.top = Math.max(0, Math.min(Math.max(0, s.rows.length - s.height), s.top + d));
    s.index = Math.max(s.top, Math.min(s.index, s.top + s.height - 1, s.rows.length - 1));
    return true;
  }
  if (m.kind !== 'press' || m.button !== 'left') return false;
  const i = s.top + m.row - s.offset;
  if (m.row < s.offset || i < 0 || i >= s.rows.length || m.row - s.offset >= s.height) return false;
  if (i === s.index) return 'activate';
  s.index = i;
  return true;
}

export interface ListTableOptions {
  focused?: boolean;
  header?: boolean;
  /** The filter line's text while nothing is typed. */
  placeholder?: string;
  /** Shown when no row is left (default: the list's empty text, or "No matches" while filtered). */
  empty?: string;
}

/**
 * A list's shown items as table rows: the list filters (its filter line on top), selects and pages,
 * the table draws columns. Writes the list's scroll bookkeeping back (`top`, `height`, and an `offset`
 * that counts the header), so `listKey` and `listMouse` work on what is drawn.
 */
export function renderListTable(list: ListState, columns: TableColumn[], rowOf: (item: ListItem) => TableRow, size: Size, g: Glyphs, o: ListTableOptions = {}): string[] {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return frame([], size);
  const lines = listShowsFilter(list, rows) ? [listFilterLine(list, cols, g, o.placeholder)] : [];
  const empty = o.empty ?? (list.query ? `No matches for "${plainText(list.query)}"` : list.empty);
  const t = createTable(columns, shownItems(list).map((r) => rowOf(r.item)), { empty });
  t.index = list.index;
  t.top = list.top;
  const body = renderTable(t, { rows: rows - lines.length, cols }, g, { focused: o.focused, header: o.header });
  list.index = t.index;
  list.top = t.top;
  list.height = t.height;
  list.offset = lines.length + t.offset;
  return frame([...lines, ...body], size);
}
