// A multi-line text area: soft wrap at word boundaries, a cursor that moves across wrapped rows and
// keeps its column, pasted newlines, vertical scrolling, a placeholder that keeps its line breaks, and
// optional history (↑ on the first row, ↓ on the last). Whether Enter inserts a newline or submits is
// the caller's choice (`submitOnEnter`); Alt-Enter does the other one, Ctrl-S always submits.
import type { Key } from '../screen.ts';
import { wordLeft, wordRight } from '../editor.ts';
import { c } from '../theme.ts';
import { cell, graphemeStops, nextStop, pasteText, plainText, prevStop, width, wrapParagraphs } from '../text.ts';
import { colourless, frame, wrapRanges, type Rendered, type Size } from './compose.ts';

export interface TextareaState {
  /** Logical lines as code points. */
  lines: string[][];
  row: number;
  col: number;
  /** The column ↑/↓ try to keep while moving through rows of different lengths. */
  goal?: number;
  /** First visible wrapped row; written back by rendering, with `height` and `width`. */
  top: number;
  height: number;
  width: number;
  /** Shown faint while empty; its own line breaks are kept and long lines wrap. */
  placeholder: string;
  submitOnEnter: boolean;
  /** Earlier entries, most recent first (read each time, so a shared list can grow). */
  history?: () => readonly string[];
  /** Which history entry is shown (-1: what was typed), and that text while walking. */
  recall: number;
  draft: string;
}

export interface TextareaOptions {
  value?: string;
  placeholder?: string;
  submitOnEnter?: boolean;
  /** What ↑ on the first row and ↓ on the last walk through, most recent first. Without it those keys are the caller's. */
  history?: readonly string[] | (() => readonly string[]);
}

export function createTextarea(o: TextareaOptions = {}): TextareaState {
  const h = o.history;
  const s: TextareaState = {
    lines: [[]], row: 0, col: 0, top: 0, height: 1, width: 0, placeholder: o.placeholder ?? '', submitOnEnter: Boolean(o.submitOnEnter),
    history: h === undefined ? undefined : typeof h === 'function' ? h : () => h, recall: -1, draft: '',
  };
  setTextareaValue(s, o.value ?? '');
  return s;
}

export function textareaValue(s: TextareaState): string {
  return s.lines.map((l) => l.join('')).join('\n');
}

/** Replace the text; the cursor goes to the end, and a history walk starts over. */
export function setTextareaValue(s: TextareaState, value: string): void {
  setText(s, value);
  s.recall = -1;
}

function setText(s: TextareaState, value: string): void {
  s.lines = pasteText(value + '\n', true).split('\n').map((l) => [...l]);
  if (!s.lines.length) s.lines = [[]];
  s.row = s.lines.length - 1;
  s.col = s.lines[s.row]!.length;
  s.goal = undefined;
}

/** ↑ past the first row: an older entry; ↓ past the last: a newer one, then what was typed. */
function walkHistory(s: TextareaState, dir: -1 | 1): boolean {
  if (!s.history) return false;
  const past = s.history();
  if (dir < 0 && s.recall + 1 < past.length) {
    if (s.recall < 0) s.draft = textareaValue(s);
    s.recall++;
    setText(s, past[s.recall]!);
  } else if (dir > 0 && s.recall >= 0) {
    s.recall--;
    setText(s, s.recall < 0 ? s.draft : past[s.recall]!);
  }
  // With history the edge keys are the area's, even when there is nothing further to show.
  return true;
}

interface VRow { line: number; start: number; end: number; last: boolean }

/** The wrap width: one cell is kept free so the cursor can sit after a full row. */
function wrapWidth(s: TextareaState): number {
  return s.width > 1 ? s.width - 1 : Infinity;
}

function rangesOf(s: TextareaState, line: number): Array<[number, number]> {
  const cps = s.lines[line]!;
  const w = wrapWidth(s);
  return w === Infinity ? [[0, cps.length]] : wrapRanges(cps, w);
}

function visualRows(s: TextareaState): VRow[] {
  const out: VRow[] = [];
  s.lines.forEach((_, line) => {
    const r = rangesOf(s, line);
    r.forEach(([start, end], i) => out.push({ line, start, end, last: i === r.length - 1 }));
  });
  return out;
}

function cursorVisual(s: TextareaState, rows: VRow[]): { vrow: number; x: number } {
  let vrow = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.line === s.row && r.start <= s.col) vrow = i;
    if (r.line > s.row) break;
  }
  const r = rows[vrow]!;
  return { vrow, x: width(s.lines[r.line]!.slice(r.start, s.col).join('')) };
}

function moveVertical(s: TextareaState, delta: number): boolean {
  const rows = visualRows(s);
  const { vrow, x } = cursorVisual(s, rows);
  let target = vrow + delta;
  if (target < 0 || target >= rows.length) {
    // A single step past the edge is the caller's (move to another field); a page step clamps.
    if (Math.abs(delta) <= 1) return false;
    if (target < 0 && vrow === 0) { s.row = 0; s.col = 0; return true; }
    if (target >= rows.length && vrow === rows.length - 1) { s.row = s.lines.length - 1; s.col = s.lines[s.row]!.length; return true; }
    target = Math.max(0, Math.min(rows.length - 1, target));
  }
  const goal = s.goal ?? x;
  const r = rows[target]!;
  const cps = s.lines[r.line]!;
  const maxCol = rowEnd(cps, r);
  // Whole graphemes, measured as drawn, until the goal column would be passed.
  const stops = graphemeStops(cps);
  let col = r.start;
  let used = 0;
  for (let k = stops.indexOf(r.start); k >= 0 && k < stops.length - 1 && stops[k]! < maxCol; k++) {
    const w = width(cps.slice(stops[k]!, stops[k + 1]!).join(''));
    if (used + w > goal) break;
    used += w;
    col = stops[k + 1]!;
  }
  s.row = r.line;
  s.col = col;
  s.goal = goal;
  return true;
}

/** The last place the cursor may sit on a visual row: its end on a line's last row, else before its last grapheme (the end is the next row's start). */
function rowEnd(cps: string[], r: VRow): number {
  return r.last ? r.end : Math.max(r.start, prevStop(cps, r.end));
}

function insert(s: TextareaState, text: string): void {
  const parts = text.split('\n');
  const line = s.lines[s.row]!;
  const before = line.slice(0, s.col);
  const after = line.slice(s.col);
  if (parts.length === 1) {
    const add = [...parts[0]!];
    s.lines[s.row] = [...before, ...add, ...after];
    s.col += add.length;
    return;
  }
  const first = [...before, ...parts[0]!];
  const middle = parts.slice(1, -1).map((p) => [...p]);
  const lastText = [...parts[parts.length - 1]!];
  s.lines.splice(s.row, 1, first, ...middle, [...lastText, ...after]);
  s.row += parts.length - 1;
  s.col = lastText.length;
}

function newline(s: TextareaState): void {
  insert(s, '\n');
}

/** Apply a key: 'submit', true when used, false when it is the caller's (Tab, Esc, ↑ on the first row…). */
export function textareaKey(s: TextareaState, k: Key): boolean | 'submit' {
  const line = () => s.lines[s.row]!;
  const keepGoal = k.name === 'up' || k.name === 'down' || k.name === 'pageup' || k.name === 'pagedown';
  if (!keepGoal) s.goal = undefined;
  switch (k.name) {
    case 'char': { const ch = plainText(k.ch); if (ch) insert(s, ch); return true; }
    case 'paste': insert(s, pasteText(k.text, true)); return true;
    case 'enter': if (s.submitOnEnter) return 'submit'; newline(s); return true;
    case 'alt-enter': if (!s.submitOnEnter) return 'submit'; newline(s); return true;
    // Characters are whole graphemes: an emoji with its variation selector goes in one step.
    case 'backspace':
      if (s.col > 0) { const i = prevStop(line(), s.col); line().splice(i, s.col - i); s.col = i; return true; }
      if (s.row > 0) { const prev = s.lines[s.row - 1]!; s.col = prev.length; prev.push(...line()); s.lines.splice(s.row, 1); s.row--; return true; }
      return true;
    case 'delete':
      if (s.col < line().length) { line().splice(s.col, nextStop(line(), s.col) - s.col); return true; }
      if (s.row < s.lines.length - 1) { line().push(...s.lines[s.row + 1]!); s.lines.splice(s.row + 1, 1); }
      return true;
    case 'left':
      if (s.col > 0) s.col = prevStop(line(), s.col);
      else if (s.row > 0) { s.row--; s.col = line().length; }
      return true;
    case 'right':
      if (s.col < line().length) s.col = nextStop(line(), s.col);
      else if (s.row < s.lines.length - 1) { s.row++; s.col = 0; }
      return true;
    case 'ctrl-left': case 'alt-left':
      if (s.col === 0 && s.row > 0) { s.row--; s.col = line().length; } else s.col = wordLeft(line(), s.col);
      return true;
    case 'ctrl-right': case 'alt-right':
      if (s.col === line().length && s.row < s.lines.length - 1) { s.row++; s.col = 0; } else s.col = wordRight(line(), s.col);
      return true;
    case 'up': return moveVertical(s, -1) || walkHistory(s, -1);
    case 'down': return moveVertical(s, 1) || walkHistory(s, 1);
    case 'pageup': return moveVertical(s, -Math.max(2, s.height - 1)) || true;
    case 'pagedown': return moveVertical(s, Math.max(2, s.height - 1)) || true;
    case 'home': { const rows = visualRows(s); s.col = rows[cursorVisual(s, rows).vrow]!.start; return true; }
    case 'end': {
      const rows = visualRows(s);
      const r = rows[cursorVisual(s, rows).vrow]!;
      s.col = rowEnd(line(), r);
      return true;
    }
    case 'ctrl-home': s.row = 0; s.col = 0; return true;
    case 'ctrl-end': s.row = s.lines.length - 1; s.col = line().length; return true;
    case 'alt-backspace': { const i = wordLeft(line(), s.col); line().splice(i, s.col - i); s.col = i; return true; }
    case 'alt':
      if (k.ch === 'b') { s.col = wordLeft(line(), s.col); return true; }
      if (k.ch === 'f') { s.col = wordRight(line(), s.col); return true; }
      return false;
    case 'ctrl':
      switch (k.ch) {
        case 's': return 'submit';
        case 'a': s.col = 0; return true;
        case 'e': s.col = line().length; return true;
        case 'u': line().splice(0, s.col); s.col = 0; return true;
        case 'k': line().splice(s.col); return true;
        case 'w': { const i = wordLeft(line(), s.col); line().splice(i, s.col - i); s.col = i; return true; }
      }
      return false;
    default: return false;
  }
}

export interface TextareaRenderOptions { focused?: boolean }

/** The rows the text (or its placeholder) takes at `cols`, so a dialog can size the area to it. */
export function textareaRows(s: TextareaState, cols: number): number {
  if (cols <= 0) return 1;
  const empty = s.lines.length === 1 && !s.lines[0]!.length;
  if (empty) return s.placeholder ? Math.max(1, wrapParagraphs(colourless() ? `(${s.placeholder.trim()})` : s.placeholder, cols).length) : 1;
  const before = s.width;
  s.width = cols;
  const n = visualRows(s).length;
  s.width = before;
  return Math.max(1, n);
}

export function renderTextarea(s: TextareaState, size: Size, o: TextareaRenderOptions = {}): Rendered {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return { lines: frame([], size) };
  s.width = cols;
  s.height = rows;
  const vrows = visualRows(s);
  const { vrow, x } = cursorVisual(s, vrows);
  if (vrow < s.top) s.top = vrow;
  if (vrow >= s.top + rows) s.top = vrow - rows + 1;
  s.top = Math.max(0, Math.min(s.top, Math.max(0, vrows.length - rows)));
  const empty = s.lines.length === 1 && !s.lines[0]!.length;
  const lines: string[] = [];
  if (empty && s.placeholder) {
    // Without colour the placeholder is in parentheses, so it cannot pass for typed text.
    lines.push(...wrapParagraphs(colourless() ? `(${s.placeholder.trim()})` : s.placeholder, cols, rows).map((l) => c.faint(l)));
  } else {
    for (let r = s.top; r < Math.min(vrows.length, s.top + rows); r++) {
      const v = vrows[r]!;
      lines.push(cell(c.text(s.lines[v.line]!.slice(v.start, v.end).join('')), cols));
    }
  }
  return { lines: frame(lines, size), cursor: o.focused ? { row: vrow - s.top, col: Math.min(cols - 1, x) } : undefined };
}
