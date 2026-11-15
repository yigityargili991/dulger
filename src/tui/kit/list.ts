// A selectable, scrolling list: optional type-to-filter with fuzzy matching and highlights, optional
// multi-select, secondary text and right-aligned meta per row, an empty state, paging and the wheel.
//
// Rendering writes back only scroll bookkeeping (`top`, `height`, `offset`) so the view stays put
// while the selection moves inside it, and so PgUp/PgDn and clicks know the page the person sees.
import chalk from 'chalk';
import type { Key, Mouse } from '../screen.ts';
import { c, type Glyphs } from '../theme.ts';
import { cell, fit, midFit, pasteText, plainText, repeat, width } from '../text.ts';
import { colourless, frame, graphemes, highlight, onBackground, tone, type ScrollInfo, type Size, type Tone } from './compose.ts';
import { rankFilter, type MatchMode } from './fuzzy.ts';
import { scrollbar } from './bits.ts';

export interface ListItem {
  /** Stable identity: selection and checks follow it across `setItems`. */
  id: string;
  /** Plain text (sanitized when drawn). */
  label: string;
  /** Muted text after the label. */
  detail?: string;
  /** Right-aligned text, e.g. a date or a state. */
  meta?: string;
  metaTone?: Tone;
  /** Trusted, already-styled prefix such as a status glyph. */
  icon?: string;
  /** Drawn faint; skipped by the arrow keys (unless the list says otherwise) and never activated. */
  disabled?: boolean;
  /** Extra words the filter matches on but that are not shown: whole words and substrings, ranked below matches on what is shown. */
  keywords?: string;
}

/** `type`: printable keys filter directly (pickers). `slash`: `/` starts filtering (pages with letter shortcuts). */
export type FilterMode = 'off' | 'type' | 'slash';

export interface ListState {
  items: ListItem[];
  /** Index into the shown (filtered) rows. */
  index: number;
  top: number;
  /** Rows of items at the last render: the page size for PgUp/PgDn. */
  height: number;
  /** Rows above the first item at the last render (the filter line). */
  offset: number;
  filter: FilterMode;
  query: string;
  /** `slash` mode: the query is being typed. */
  filtering: boolean;
  multi: boolean;
  checked: Set<string>;
  empty: string;
  /** Best matches first while filtering (default); false keeps the item order. */
  sort: boolean;
  /** How the typed filter matches what is shown: `fuzzy` (in order, gaps allowed) or `words` (substrings). */
  match: MatchMode;
  /** The arrow keys pass over disabled rows (default); false lets them rest there (to read why). */
  skipDisabled: boolean;
  cache?: { items: ListItem[]; query: string; shown: ShownItem[] };
}

export interface ShownItem { item: ListItem; index: number; positions: number[] }

export interface ListOptions {
  filter?: FilterMode;
  multi?: boolean;
  selected?: string;
  checked?: string[];
  empty?: string;
  sort?: boolean;
  /**
   * `fuzzy` (default): the letters in order, gaps allowed, word starts and runs ranked first; for
   * commands and names. `words`: every typed word must appear as typed (a substring), the item that is
   * the query exactly first, then those that start with it; for lists of sentences such as run goals.
   */
  match?: MatchMode;
  /** false: the arrow keys stop on disabled rows too (they are still never activated). Default true. */
  skipDisabled?: boolean;
}

export function createList(items: ListItem[], o: ListOptions = {}): ListState {
  const s: ListState = {
    items, index: 0, top: 0, height: 1, offset: 0, filter: o.filter ?? 'off', query: '', filtering: false,
    multi: Boolean(o.multi), checked: new Set(o.checked ?? []), empty: o.empty ?? 'Nothing here yet.', sort: o.sort ?? true,
    match: o.match ?? 'fuzzy', skipDisabled: o.skipDisabled ?? true,
  };
  if (o.selected !== undefined) selectId(s, o.selected);
  else s.index = firstEnabled(s, 0, 1);
  return s;
}

/** Replace the items, keeping the selection on the same id when it is still there. */
export function setItems(s: ListState, items: ListItem[]): void {
  const keep = selectedItem(s)?.id;
  s.items = items;
  s.cache = undefined;
  const ids = new Set(items.map((i) => i.id));
  for (const id of [...s.checked]) if (!ids.has(id)) s.checked.delete(id);
  if (keep === undefined || !selectId(s, keep)) s.index = Math.max(0, Math.min(s.index, shownItems(s).length - 1));
}

/** The rows the filter lets through, best match first, with the label positions to highlight. */
export function shownItems(s: ListState): ShownItem[] {
  const query = s.filter === 'off' ? '' : s.query;
  if (s.cache && s.cache.items === s.items && s.cache.query === query) return s.cache.shown;
  const shown = query.trim()
    ? rankFilter(s.items, query, (it) => `${plainText(it.label)}${it.detail ? ` ${plainText(it.detail)}` : ''}`, (it) => plainText(it.keywords ?? ''), { mode: s.match, sort: s.sort })
      .map(({ item, index, match }) => ({ item, index, positions: match.positions.filter((p) => p < graphemes(plainText(item.label)).length) }))
    : s.items.map((item, index) => ({ item, index, positions: [] }));
  s.cache = { items: s.items, query, shown };
  return shown;
}

export function selectedItem(s: ListState): ListItem | undefined {
  return shownItems(s)[s.index]?.item;
}

/** Put the selection on `id`; false when it is not among the shown rows. */
export function selectId(s: ListState, id: string): boolean {
  const i = shownItems(s).findIndex((r) => r.item.id === id);
  if (i < 0) return false;
  s.index = i;
  return true;
}

/** Checked ids in item order. */
export function checkedIds(s: ListState): string[] {
  return s.items.filter((i) => s.checked.has(i.id)).map((i) => i.id);
}

/** Whether printable keys are going into the filter, so a page should not treat them as shortcuts. */
export function listCapturesText(s: ListState): boolean {
  return s.filter === 'type' || (s.filter === 'slash' && s.filtering);
}

export function listScroll(s: ListState): ScrollInfo {
  return { top: s.top, total: shownItems(s).length, visible: s.height };
}

function firstEnabled(s: ListState, from: number, dir: 1 | -1): number {
  const rows = shownItems(s);
  for (let i = from; i >= 0 && i < rows.length; i += dir) if (!rows[i]!.item.disabled) return i;
  return Math.max(0, Math.min(from, rows.length - 1));
}

function move(s: ListState, delta: number): void {
  const rows = shownItems(s);
  if (!rows.length) { s.index = 0; return; }
  const target = Math.max(0, Math.min(rows.length - 1, s.index + delta));
  if (!s.skipDisabled) { s.index = target; return; }
  const dir = delta >= 0 ? 1 : -1;
  let i = target;
  while (i >= 0 && i < rows.length && rows[i]!.item.disabled) i += dir;
  if (i < 0 || i >= rows.length) { i = target; while (i >= 0 && i < rows.length && rows[i]!.item.disabled) i -= dir; }
  s.index = i >= 0 && i < rows.length ? i : s.index;
}

function setQuery(s: ListState, q: string): void {
  const keep = selectedItem(s)?.id;
  s.query = q;
  s.top = 0;
  // With a filter typed, the best match is on top; with it cleared, go back to what was selected.
  if (q.trim()) s.index = firstEnabled(s, 0, 1);
  else if (keep === undefined || !selectId(s, keep)) s.index = firstEnabled(s, 0, 1);
}

/** Apply a key. True when the list used it; Enter is left to the caller (activate the selection). */
export function listKey(s: ListState, k: Key): boolean {
  const typing = s.filter === 'type' || (s.filter === 'slash' && s.filtering);
  const page = Math.max(1, s.height - 1);
  switch (k.name) {
    case 'up': move(s, -1); return true;
    case 'down': move(s, 1); return true;
    case 'pageup': move(s, -page); return true;
    case 'pagedown': move(s, page); return true;
    case 'home': s.index = firstEnabled(s, 0, 1); return true;
    case 'end': s.index = firstEnabled(s, shownItems(s).length - 1, -1); return true;
    case 'ctrl':
      if (k.ch === 'u' && typing && s.query) { setQuery(s, ''); return true; }
      if (k.ch === 'a' && s.multi) {
        const ids = shownItems(s).filter((r) => !r.item.disabled).map((r) => r.item.id);
        const all = ids.every((id) => s.checked.has(id));
        for (const id of ids) { if (all) s.checked.delete(id); else s.checked.add(id); }
        return true;
      }
      return false;
    case 'escape':
      if (s.filter === 'slash' && s.filtering) { s.filtering = false; setQuery(s, ''); return true; }
      if (s.filter !== 'off' && s.query) { setQuery(s, ''); return true; }
      return false;
    case 'enter':
      if (s.filter === 'slash' && s.filtering) { s.filtering = false; return true; }
      return false;
    case 'backspace':
      if (!typing) return false;
      if (!s.query && s.filter === 'slash') { s.filtering = false; return true; }
      if (!s.query) return s.filter === 'type';
      setQuery(s, [...s.query].slice(0, -1).join(''));
      return true;
    case 'paste':
      if (!typing) return false;
      setQuery(s, s.query + pasteText(k.text));
      return true;
    case 'char': {
      if (k.ch === ' ' && s.multi) {
        const it = selectedItem(s);
        if (it && !it.disabled) { if (s.checked.has(it.id)) s.checked.delete(it.id); else s.checked.add(it.id); }
        return true;
      }
      if (typing) { const ch = plainText(k.ch); if (ch) setQuery(s, s.query + ch); return true; }
      if (s.filter === 'slash' && k.ch === '/') { s.filtering = true; return true; }
      if (k.ch === 'j') { move(s, 1); return true; }
      if (k.ch === 'k') { move(s, -1); return true; }
      if (k.ch === 'g') { s.index = firstEnabled(s, 0, 1); return true; }
      if (k.ch === 'G') { s.index = firstEnabled(s, shownItems(s).length - 1, -1); return true; }
      return false;
    }
    default: return false;
  }
}

/**
 * A mouse report relative to the list's top-left cell. A click selects the row under it and returns
 * 'activate' when that row was already selected; the wheel scrolls three rows and drags the selection
 * along when it would leave the view.
 */
export function listMouse(s: ListState, m: Mouse): boolean | 'activate' {
  const rows = shownItems(s);
  if (m.kind === 'wheel-up' || m.kind === 'wheel-down') {
    const d = m.kind === 'wheel-up' ? -3 : 3;
    s.top = Math.max(0, Math.min(Math.max(0, rows.length - s.height), s.top + d));
    if (s.index < s.top) move(s, s.top - s.index);
    else if (s.index >= s.top + s.height) move(s, s.top + s.height - 1 - s.index);
    return true;
  }
  if (m.kind !== 'press' || m.button !== 'left') return false;
  const i = s.top + m.row - s.offset;
  if (m.row < s.offset || i < 0 || i >= rows.length || m.row - s.offset >= s.height) return false;
  // A disabled row is not selected by a click, unless the list lets the selection rest on it (to say why).
  if (rows[i]!.item.disabled && s.skipDisabled) return true;
  if (i === s.index) return 'activate';
  s.index = i;
  return true;
}

export interface ListRenderOptions {
  focused?: boolean;
  /** A one-cell scrollbar in the last column when the rows do not fit (default false: panels draw their own). */
  scrollbar?: boolean;
  /** Text for the filter line while it is empty in `type` mode. */
  placeholder?: string;
  /** Keep each row's meta when the label is long, cutting the label instead (default: the meta goes first). */
  keepMeta?: boolean;
  /** Where a label that does not fit is cut: at the end (default) or in the middle, so a path keeps its file name. */
  cut?: 'end' | 'middle';
}

/**
 * Whether the list draws its filter line in `rows` rows. In `type` mode: once something is typed, or when
 * the items do not all fit (a short list needs no search line). In `slash` mode: while typing or filtered.
 */
export function listShowsFilter(s: ListState, rows: number): boolean {
  const type = s.filter === 'type' && (Boolean(s.query) || s.items.length > rows);
  return (type || (s.filter === 'slash' && (s.filtering || Boolean(s.query)))) && rows >= 2;
}

/** The filter line a list draws above its rows: the query with a caret while typing, and `shown/total` once filtered. */
export function listFilterLine(s: ListState, cols: number, g: Glyphs, placeholder?: string): string {
  const shown = shownItems(s);
  const typing = s.filter === 'type' || s.filtering;
  const caret = typing ? (colourless() ? '_' : chalk.inverse(' ')) : '';
  const q = s.query ? c.text(plainText(s.query)) + caret : caret + c.faint(placeholder ?? '');
  const count = s.query ? c.muted(`${shown.length}/${s.items.length}`) : '';
  const head = `${c.accent(g.search)} ${q}`;
  const cw = width(count);
  return cw && width(head) + cw + 2 <= cols ? cell(head, cols - cw - 1) + ' ' + count : cell(head, cols);
}

/** Keep `index` visible, moving the view as little as possible. */
export function follow(top: number, index: number, height: number, total: number): number {
  let t = top;
  if (index < t) t = index;
  if (index >= t + height) t = index - height + 1;
  return Math.max(0, Math.min(t, Math.max(0, total - height)));
}

/**
 * Keep rows [from, to) visible, moving the view as little as possible: an item taller than the view
 * shows from its start. `head` (a heading above it) comes along when the whole stretch fits.
 */
export function followRange(top: number, from: number, to: number, height: number, total: number, head = from): number {
  let t = top;
  if (to - from > height) t = from;
  else {
    const start = to - head <= height ? head : from;
    if (start < t) t = start;
    if (to > t + height) t = to - height;
  }
  return Math.max(0, Math.min(t, Math.max(0, total - height)));
}

/** A row painted as selected: the pointer, bold text, and (when focused) the surface background. */
export function selectableRow(body: string, cols: number, g: Glyphs, selected: boolean, focused: boolean): string {
  const pw = width(g.pointer) + 1;
  if (cols <= pw) return cell(selected ? (focused ? g.pointer : g.pointerIdle) : '', cols);
  // The full pointer only where the keyboard is; a lighter one marks the selection in other panels.
  const marker = selected && focused ? c.accent(g.pointer) + ' ' : selected ? cell(c.muted(g.pointerIdle), pw) : repeat(' ', pw);
  const line = marker + cell(body, cols - pw);
  return selected && focused && !colourless() ? onBackground(line, cols, c.bg) : line;
}

export function renderList(s: ListState, size: Size, g: Glyphs, o: ListRenderOptions = {}): string[] {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return frame([], size);
  const shown = shownItems(s);
  s.index = Math.max(0, Math.min(s.index, shown.length - 1));
  const lines: string[] = [];
  if (listShowsFilter(s, rows)) lines.push(listFilterLine(s, cols, g, o.placeholder));
  s.offset = lines.length;
  const height = Math.max(0, rows - lines.length);
  s.height = Math.max(1, height);
  s.top = follow(s.top, s.index, s.height, shown.length);
  // The scrollbar spans the item rows only, one blank cell away from the meta column.
  const bar = o.scrollbar && cols > 6 && shown.length > height ? scrollbar(height, s.top, shown.length, height, g, o.focused) : undefined;
  const w = bar ? cols - 2 : cols;
  const items: string[] = [];
  if (!shown.length && height > 0) {
    const msg = s.query ? `No matches for "${plainText(s.query)}"` : s.empty;
    items.push(cell('  ' + c.muted(fit(plainText(msg), Math.max(0, w - 2))), w));
  }
  for (let r = 0; r < height && s.top + r < shown.length; r++) {
    const i = s.top + r;
    items.push(itemRow(s, shown[i]!, w, g, i === s.index, Boolean(o.focused), o));
  }
  const body = frame(items, { rows: height, cols: w }).map((line, r) => (bar ? line + ' ' + bar[r]! : line));
  return frame([...lines, ...body], size);
}

function itemRow(s: ListState, row: ShownItem, cols: number, g: Glyphs, selected: boolean, focused: boolean, o: ListRenderOptions = {}): string {
  const it = row.item;
  const label = plainText(it.label);
  const base = it.disabled ? c.faint : selected ? c.text.bold : c.text;
  const lead = [
    s.multi ? (s.checked.has(it.id) ? c.accent(g.checkOn) : c.muted(g.checkOff)) + ' ' : '',
    it.icon ? it.icon + ' ' : '',
  ].join('');
  const meta = it.meta ? (it.disabled ? c.faint : tone(it.metaTone ?? 'muted'))(plainText(it.meta)) : '';
  const inner = cols - width(g.pointer) - 1;
  const mw = width(meta);
  // Room for the label when the meta is kept beside it (up to half the row for the meta).
  const keep = Boolean(o.keepMeta && mw && mw * 2 <= inner);
  const room = Math.max(1, (keep ? inner - mw - 1 : inner) - width(lead));
  const cutMiddle = o.cut === 'middle' && width(label) > room;
  const body = lead + (cutMiddle ? base(midFit(label, room)) : highlight(label, row.positions, base, (t) => c.match(t)));
  const detail = it.detail ? '  ' + c.muted(plainText(it.detail)) : '';
  const left = body + detail;
  const text = mw && (keep || width(body) + mw + 2 <= inner) ? cell(left, inner - mw - 1) + ' ' + meta : left;
  return selectableRow(text, cols, g, selected, focused);
}
