// Modal dialogs: confirm (safe choice focused, a danger variant, a typed-word variant), a notice with
// several actions, prompt (one line or several, with validation), picker (filterable, single or multi,
// with a description strip), a long-text viewer and a busy spinner. Each has a plain state with
// render/key functions, and a `…Modal` constructor that wraps it in the `Modal` interface the app shell
// stacks over the page.
//
// Confirm and notice share one body: paragraphs (line breaks kept), a preformatted detail shown whole,
// a list, a note; it scrolls when it is taller than the screen, and the buttons always show.
//
// A modal renders only its box; `placeModal` dims the page behind it and puts the box on top.
// Keys return `{ value }` when the modal is finished, undefined while it stays open.
import type { ChalkInstance } from 'chalk';
import type { Key, Mouse } from '../screen.ts';
import { c, type Glyphs } from '../theme.ts';
import { chop, cell, fit, plainText, repeat, width, wrapParagraphs } from '../text.ts';
import { colourless, dim, frame, overlay, panel, place, type Lazy, type Rect, type Rendered, type Size } from './compose.ts';
import { createInput, inputKey, inputValue, renderInput, type InputState } from './input.ts';
import { createTextarea, renderTextarea, textareaKey, textareaRows, textareaValue, type TextareaState } from './textarea.ts';
import { checkedIds, createList, listKey, listMouse, renderList, selectedItem, type ListItem, type ListState } from './list.ts';
import { createScroll, expandTabs, renderScroll, scrollInfo, scrollKey, scrollMouse, scrollPosition, toggleWrap, type ScrollState } from './scroll.ts';
import { spinnerFrame } from './bits.ts';

/** What the app shell stacks over a page. Mouse reports are relative to the box's top-left cell. */
export interface Modal<T> {
  render(size: Size, g: Glyphs, now: number): Rendered;
  key(k: Key): { value: T } | undefined;
  mouse?(m: Mouse): { value: T } | undefined;
  /** Centred (default) or near the top (the command palette). */
  placement?: 'center' | 'top';
  /** The value the modal settles with when the app closes it (quit): its cancel. */
  cancel: T;
  /** True while it animates (a spinner), so the shell keeps repainting. */
  animating?(): boolean;
}

/** The page dimmed with `box` placed over it; `rect` is where the box landed, for mouse hits. */
export function placeModal(page: string[], box: Rendered, size: Size, at: 'center' | 'top' = 'center'): Rendered & { rect: Rect } {
  const rows = Math.min(size.rows, box.lines.length);
  // Each box line is measured once: for the box's width and to skip padding lines that already fit.
  const widths = box.lines.map((l) => width(l));
  const cols = Math.min(size.cols, Math.max(0, ...widths));
  const { top, left } = place({ rows, cols }, size, at);
  const lines = overlay(frame(dim(page), size), box.lines.slice(0, rows).map((l, i) => (widths[i] === cols ? l : cell(l, cols))), top, left);
  const inside = box.cursor && box.cursor.row >= 0 && box.cursor.row < rows && box.cursor.col >= 0 && box.cursor.col < cols;
  const cursor = inside ? { row: top + box.cursor!.row, col: left + box.cursor!.col } : undefined;
  return { lines: frame(lines, size), cursor, rect: { top, left, rows, cols } };
}

/**
 * A button: focused ones are filled (red when they destroy something). Without colour: `[ Delete ]`.
 * `compact` keeps one cell of padding on each side instead of two (`[Delete]` without colour).
 */
export function button(label: string, focused: boolean, danger = false, compact = false): string {
  const text = plainText(label);
  const pad = compact ? ' ' : '  ';
  if (colourless()) return focused ? (compact ? `[${text}]` : `[ ${text} ]`) : `${pad}${text}${pad}`;
  const style = focused ? (danger ? c.buttonDanger : c.buttonFocus) : c.button;
  return style(`${pad}${text}${pad}`);
}

export interface ButtonSpec {
  label: string;
  focused?: boolean;
  danger?: boolean;
  /** Shown dimmed and never focused: not available yet (a typed confirmation not typed). */
  off?: boolean;
}
/** Where a button of a `buttonRow` landed, relative to the block. */
export interface ButtonHit { index: number; row: number; from: number; to: number }

function buttonText(b: ButtonSpec, compact: boolean): string {
  if (!b.off) return button(b.label, Boolean(b.focused), b.danger, compact);
  const pad = compact ? ' ' : '  ';
  const t = `${pad}${plainText(b.label)}${pad}`;
  return colourless() ? t : c.button.dim(t);
}

/**
 * Buttons right-aligned in `w` cells, two apart. When they do not fit, their padding shrinks; when they
 * still do not, they wrap onto more rows (each right-aligned), so no button falls off the edge.
 */
export function buttonRow(buttons: ButtonSpec[], w: number): { lines: string[]; hits: ButtonHit[] } {
  const cols = Math.max(1, w);
  const total = (parts: string[], gap: number) => parts.reduce((n, p) => n + width(p), 0) + gap * Math.max(0, parts.length - 1);
  let parts = buttons.map((b) => buttonText(b, false));
  let gap = 2;
  if (total(parts, gap) > cols) { parts = buttons.map((b) => buttonText(b, true)); gap = 1; }
  const rows: number[][] = [];
  let row: number[] = [];
  let used = 0;
  parts.forEach((p, i) => {
    const pw = width(p);
    if (row.length && used + gap + pw > cols) { rows.push(row); row = []; used = 0; }
    used += (row.length ? gap : 0) + pw;
    row.push(i);
  });
  if (row.length) rows.push(row);
  const lines: string[] = [];
  const hits: ButtonHit[] = [];
  rows.forEach((r, ri) => {
    const text = r.map((i) => parts[i]!).join(repeat(' ', gap));
    const tw = width(text);
    const start = Math.max(0, cols - tw);
    lines.push(tw <= cols ? repeat(' ', start) + text : fit(text, cols, ''));
    let at = start;
    for (const i of r) {
      const pw = width(parts[i]!);
      hits.push({ index: i, row: ri, from: at, to: Math.min(cols, at + pw) });
      at += pw + gap;
    }
  });
  return { lines, hits };
}

interface DialogOptions { title: string; width: number; border?: ChalkInstance; footer?: Lazy<string> }

/**
 * A dialog box at most `size`: rounded border, title, two cells of padding. `content` gets the inner
 * width and the most rows it may use, and returns its lines (and cursor) — the box shrinks to fit.
 * `inset` is where the content's top-left cell landed in the box, for mapping clicks.
 */
function dialog(size: Size, g: Glyphs, o: DialogOptions, content: (w: number, maxRows: number) => Rendered): Rendered & { inset: { row: number; col: number } } {
  const cols = Math.max(1, Math.min(size.cols, o.width));
  const pad = size.rows < 7 || cols < 24 ? 1 : 2;
  const border = size.rows >= 3 && cols >= 6;
  const innerW = Math.max(1, border ? cols - 2 - pad * 2 : cols);
  const maxRows = Math.max(1, size.rows - (border ? 2 : 0));
  const body = content(innerW, maxRows);
  const rows = Math.min(size.rows, body.lines.length + (border ? 2 : 0));
  const framed = border && rows >= 3;
  const box = panel({ rows, cols }, { g, title: o.title, focused: true, mark: false, pad, border: o.border, footer: o.footer }, () => body);
  return { ...box, inset: framed ? { row: 1, col: 1 + pad } : { row: 0, col: 0 } };
}

/**
 * Blocks stacked with breathing room while it fits: blank lines between blocks first, then one above
 * and one below. `offsets` is the first row of each block (the tail last).
 */
function arrange(blocks: string[][], maxRows: number, tail: string[] = []): { lines: string[]; offsets: number[] } {
  const parts = tail.length ? [...blocks, tail] : blocks;
  let spare = Math.max(0, maxRows - parts.reduce((n, b) => n + b.length, 0));
  const between = Math.min(spare, parts.length - 1);
  spare -= between;
  const lines: string[] = spare >= 1 ? [''] : [];
  const offsets: number[] = [];
  parts.forEach((b, i) => {
    if (i > 0 && parts.length - i <= between) lines.push('');
    offsets.push(lines.length);
    lines.push(...b);
  });
  if (spare >= 2) lines.push('');
  return { lines, offsets };
}

// ---- the body confirm and notice share ----

/** A row of a dialog's list: `label  value`, the value wrapped under itself. */
export interface DialogItem { label: string; value?: string }

/** What a dialog says, top to bottom. Plain text, sanitized when drawn. */
export interface DialogText {
  /** Paragraphs: the text's own line breaks are kept and each line is word-wrapped. */
  message: string;
  /** Preformatted text shown whole (a command, a path, output): line breaks and spacing kept, a long token broken across rows, never cut. */
  detail?: string;
  /** A list after the message, one row each (more when a value wraps). */
  items?: Array<string | DialogItem>;
  /** Muted text at the end, e.g. what is not affected. */
  note?: string;
}

/** Where a dialog's body is scrolled to; written back by rendering. */
interface BodyScroll { top: number; visible: number; total: number; overflow: boolean }

function itemLines(items: Array<string | DialogItem>, w: number, g: Glyphs): string[] {
  const rows = items.map((i) => (typeof i === 'string' ? { label: i } : i));
  const lead = `${c.accent(g.bullet)} `;
  const lw = width(g.bullet) + 1;
  const labelW = Math.min(Math.max(0, ...rows.filter((r) => r.value !== undefined).map((r) => width(plainText(r.label)))) + 2, Math.floor(w * 0.5));
  const out: string[] = [];
  for (const r of rows) {
    if (r.value === undefined) {
      wrapParagraphs(r.label, Math.max(1, w - lw)).forEach((l, i) => out.push((i ? repeat(' ', lw) : lead) + c.text(l)));
      continue;
    }
    const values = wrapParagraphs(r.value, Math.max(1, w - lw - labelW));
    (values.length ? values : ['']).forEach((v, i) => out.push(
      (i ? repeat(' ', lw + labelW) : lead + c.text(cell(fit(plainText(r.label), Math.max(1, labelW - 1)), labelW))) + c.subtle(v),
    ));
  }
  return out;
}

/** The detail block: each line whole, broken by cell rather than cut. */
function detailLines(text: string, w: number): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').flatMap((l) => chop(expandTabs(l), Math.max(1, w)));
}

function bodyBlocks(o: DialogText, w: number, g: Glyphs): string[][] {
  const blocks = [
    o.message ? wrapParagraphs(o.message, w).map((l) => (l ? c.text(l) : '')) : [],
    o.detail ? detailLines(o.detail, w).map((l) => c.subtle(l)) : [],
    o.items?.length ? itemLines(o.items, w, g) : [],
    o.note ? wrapParagraphs(o.note, w).map((l) => (l ? c.muted(l) : '')) : [],
  ];
  return blocks.filter((b) => b.length);
}

/** The widest line the body wants, for sizing the box. */
function bodyWidth(o: DialogText): number {
  const lines = [
    ...o.message.split('\n'),
    ...(o.detail ?? '').split('\n').map((l) => `  ${l}`),
    ...(o.items ?? []).map((i) => (typeof i === 'string' ? `   ${i}` : `   ${i.label}    ${i.value ?? ''}`)),
  ];
  return Math.max(0, ...lines.map((l) => width(plainText(l))));
}

/**
 * Lay a body out over `maxRows`: the blocks, then `fixed` rows (a typed field, an error), then the
 * buttons. When everything fits there is breathing room as before; when it does not, the blocks become
 * one scrolling window above the fixed rows and the buttons, which always show.
 */
function flow(blocks: string[][], fixed: string[], buttons: string[], maxRows: number, s: BodyScroll): { lines: string[]; fixedAt: number; buttonsAt: number } {
  const bare = blocks.reduce((n, b) => n + b.length, 0);
  const tail = fixed.length + buttons.length;
  if (bare + tail <= maxRows) {
    const parts = fixed.length ? [...blocks, fixed] : blocks;
    const { lines, offsets } = arrange(parts, maxRows, buttons);
    Object.assign(s, { top: 0, visible: bare, total: bare, overflow: false });
    return { lines, fixedAt: fixed.length ? offsets[parts.length - 1]! : -1, buttonsAt: offsets.at(-1)! };
  }
  const content = blocks.flatMap((b, i) => (i ? ['', ...b] : b));
  const gap = maxRows - tail >= 4 ? 1 : 0;
  const rows = Math.max(0, maxRows - tail - gap);
  s.total = content.length;
  s.visible = Math.max(1, rows);
  s.overflow = true;
  s.top = Math.max(0, Math.min(s.top, content.length - rows));
  const shown = rows ? content.slice(s.top, s.top + rows) : [];
  let lines = [...shown, ...(gap && shown.length ? [''] : []), ...fixed, ...buttons];
  let fixedAt = fixed.length ? lines.length - tail : -1;
  let buttonsAt = lines.length - buttons.length;
  // Too short even for the fixed rows and the buttons: the top goes first.
  const cut = Math.max(0, lines.length - maxRows);
  if (cut) { lines = lines.slice(cut); fixedAt = fixedAt >= cut ? fixedAt - cut : -1; buttonsAt -= cut; }
  return { lines, fixedAt, buttonsAt };
}

function bodyScroll(s: BodyScroll, d: number): void {
  s.top = Math.max(0, Math.min(Math.max(0, s.total - s.visible), s.top + d));
}

/** Arrows, paging and the wheel scroll a body that does not fit; true when the key was one of those. */
function bodyKey(s: BodyScroll, k: Key): boolean {
  const page = Math.max(1, s.visible - 1);
  switch (k.name) {
    case 'up': bodyScroll(s, -1); return true;
    case 'down': bodyScroll(s, 1); return true;
    case 'pageup': bodyScroll(s, -page); return true;
    case 'pagedown': bodyScroll(s, page); return true;
    default: return false;
  }
}

function bodyWheel(s: BodyScroll, m: Mouse): boolean {
  if (m.kind !== 'wheel-up' && m.kind !== 'wheel-down') return false;
  bodyScroll(s, m.kind === 'wheel-up' ? -3 : 3);
  return true;
}

/** `↑↓ 3-10/24` in the bottom border while the body scrolls. */
function scrollHint(s: BodyScroll): string {
  return s.overflow ? c.muted(`↑↓ ${s.top + 1}-${Math.min(s.total, s.top + s.visible)}/${s.total}`) : '';
}

/** An error under a field or in a dialog, wrapped whole (a path is broken across rows, never cut). */
function errorLines(error: string, w: number, g: Glyphs, max = 4): string[] {
  const lead = width(g.warn) + 1;
  return wrapParagraphs(error, Math.max(1, w - lead), max).map((l, i) => c.bad(`${i ? repeat(' ', lead) : `${g.warn} `}${l}`));
}

// ---- confirm ----

export interface ConfirmOptions {
  title: string;
  /** Paragraphs: line breaks are kept. */
  message: string;
  /** Preformatted text shown whole under the message (a path, a command). */
  detail?: string;
  /** A list after the message: what Save writes, what Discard puts back. */
  items?: Array<string | DialogItem>;
  /** Muted text after the list. */
  note?: string;
  /** Text of the confirming button (default "Confirm"; "Delete" and the like for danger). */
  confirm?: string;
  cancel?: string;
  /** A red border and button: the action destroys or discards something. `y` does not answer it. */
  danger?: boolean;
  /** A word to type before Enter confirms, like the run view's "type stop". */
  typed?: string;
}

export interface ConfirmState extends BodyScroll {
  o: ConfirmOptions;
  /** The safe choice is focused first. */
  focus: 'confirm' | 'cancel';
  input?: InputState;
  error?: string;
  buttons: Array<{ id: 'confirm' | 'cancel'; row: number; from: number; to: number }>;
}

export function createConfirm(o: ConfirmOptions): ConfirmState {
  // No placeholder in the typed field: without colour a faint word would read as already typed.
  return { o, focus: 'cancel', input: o.typed ? createInput() : undefined, buttons: [], top: 0, visible: 1, total: 0, overflow: false };
}

function typedOk(s: ConfirmState): boolean {
  return !s.o.typed || inputValue(s.input!).trim() === s.o.typed;
}

export function renderConfirm(s: ConfirmState, size: Size, g: Glyphs): Rendered {
  const o = s.o;
  const extra = Boolean(o.items?.length || o.detail);
  const want = Math.max(44, Math.min(extra ? 76 : 68, bodyWidth(o) + 8));
  let cursor: Rendered['cursor'];
  const box = dialog(size, g, { title: o.title, width: want, border: o.danger ? c.bad : undefined, footer: () => scrollHint(s) }, (w, maxRows) => {
    const off = Boolean(o.typed) && !typedOk(s);
    const confirmFocused = o.typed ? typedOk(s) : s.focus === 'confirm';
    const row = buttonRow([
      { label: o.cancel ?? 'Cancel', focused: !o.typed && s.focus === 'cancel' },
      { label: o.confirm ?? 'Confirm', focused: confirmFocused, danger: o.danger, off },
    ], w);
    const typedRows = o.typed ? [c.muted(fit(`Type ${plainText(o.typed)}`, w)), ''] : [];
    const errRows = s.error ? errorLines(s.error, w, g) : [];
    const f = flow(bodyBlocks(o, w, g), [...typedRows, ...errRows], row.lines, maxRows, s);
    if (o.typed && s.input && f.fixedAt >= 0) {
      const at = f.fixedAt + 1;
      const r = renderInput(s.input, Math.min(w, 24), { focused: true, field: true });
      if (at < f.lines.length) {
        f.lines[at] = r.line;
        cursor = { row: at, col: r.cursor ?? 0 };
      }
    }
    s.buttons = row.hits.map((h) => ({ id: h.index === 0 ? 'cancel' as const : 'confirm' as const, row: f.buttonsAt + h.row, from: h.from, to: h.to }));
    return { lines: f.lines.slice(0, maxRows), cursor };
  });
  // Buttons were measured in content cells; clicks arrive in box cells.
  for (const b of s.buttons) { b.row += box.inset.row; b.from += box.inset.col; b.to += box.inset.col; }
  return box;
}

export function confirmKey(s: ConfirmState, k: Key): { value: boolean } | undefined {
  if (k.name === 'escape' || (k.name === 'ctrl' && (k.ch === 'c' || k.ch === 'd'))) return { value: false };
  if (bodyKey(s, k)) return undefined;
  if (s.o.typed) {
    if (k.name === 'enter') {
      if (typedOk(s)) return { value: true };
      s.error = `Type ${s.o.typed}`;
      return undefined;
    }
    s.error = undefined;
    inputKey(s.input!, k);
    return undefined;
  }
  switch (k.name) {
    case 'left': case 'right': case 'tab': case 'shift-tab':
      s.focus = s.focus === 'confirm' ? 'cancel' : 'confirm';
      return undefined;
    case 'enter': return { value: s.focus === 'confirm' };
    case 'char':
      // One stray letter must not destroy anything: a danger confirm needs its button and Enter.
      if ((k.ch === 'y' || k.ch === 'Y') && !s.o.danger) return { value: true };
      if (k.ch === 'n' || k.ch === 'N' || k.ch === 'q') return { value: false };
      if (k.ch === 'h' || k.ch === 'l') s.focus = s.focus === 'confirm' ? 'cancel' : 'confirm';
      if (k.ch === 'j') bodyScroll(s, 1);
      if (k.ch === 'k') bodyScroll(s, -1);
      return undefined;
    default: return undefined;
  }
}

export function confirmMouse(s: ConfirmState, m: Mouse): { value: boolean } | undefined {
  if (bodyWheel(s, m)) return undefined;
  if (m.kind !== 'press' || m.button !== 'left') return undefined;
  const b = s.buttons.find((x) => x.row === m.row && m.col >= x.from && m.col < x.to);
  if (!b) return undefined;
  if (b.id === 'cancel') return { value: false };
  return typedOk(s) ? { value: true } : undefined;
}

export function confirmModal(o: ConfirmOptions): Modal<boolean> & { state: ConfirmState } {
  const state = createConfirm(o);
  return { state, cancel: false, render: (size, g) => renderConfirm(state, size, g), key: (k) => confirmKey(state, k), mouse: (m) => confirmMouse(state, m) };
}

// ---- prompt ----

export interface PromptOptions {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  /** Several lines in a text area instead of one line. */
  multiline?: boolean;
  /** With `multiline`: Enter submits and Alt-Enter adds a line (default), or the other way round. */
  submitOnEnter?: boolean;
  secret?: boolean;
  /** A message when the value is not acceptable; the prompt stays open and shows it. */
  validate?: (value: string) => string | undefined;
}

export interface PromptState {
  o: PromptOptions;
  input?: InputState;
  area?: TextareaState;
  error?: string;
}

export function createPrompt(o: PromptOptions): PromptState {
  return o.multiline
    ? { o, area: createTextarea({ value: o.value, placeholder: o.placeholder, submitOnEnter: o.submitOnEnter ?? true }) }
    : { o, input: createInput({ value: o.value, placeholder: o.placeholder, mask: o.secret }) };
}

export function promptValue(s: PromptState): string {
  return s.area ? textareaValue(s.area) : inputValue(s.input!);
}

export function renderPrompt(s: PromptState, size: Size, g: Glyphs): Rendered {
  const o = s.o;
  let cursor: Rendered['cursor'];
  const multi = Boolean(s.area);
  // Title, message, the field: no key hints (Enter submits, Esc cancels, as everywhere).
  return dialog(size, g, { title: o.title, width: multi ? 76 : 64 }, (w, maxRows) => {
    const err = s.error ? errorLines(s.error, w, g, Math.max(1, maxRows - 3)) : [];
    // The area starts at three rows and grows with what is typed, up to eight (then it scrolls).
    const wanted = multi ? Math.min(8, Math.max(3, textareaRows(s.area!, w) + 1)) : 1;
    const areaRows = multi ? Math.max(1, Math.min(wanted, maxRows - err.length - 2 - (o.message ? 2 : 0))) : 1;
    const message = o.message ? wrapParagraphs(o.message, w, Math.max(1, maxRows - areaRows - err.length - 2)).map((l) => c.muted(l)) : [];
    const field = Array.from({ length: areaRows }, () => '');
    const blocks = message.length ? [message, [...field, ...err]] : [[...field, ...err]];
    const { lines, offsets } = arrange(blocks, maxRows);
    const at = offsets[offsets.length - 1]!;
    if (s.area) {
      const r = renderTextarea(s.area, { rows: areaRows, cols: w }, { focused: true });
      r.lines.forEach((l, i) => { lines[at + i] = c.bg(cell(l, w)); });
      if (r.cursor) cursor = { row: at + r.cursor.row, col: r.cursor.col };
    } else {
      const r = renderInput(s.input!, w, { focused: true, field: true });
      lines[at] = r.line;
      cursor = { row: at, col: r.cursor ?? 0 };
    }
    return { lines: lines.slice(0, maxRows), cursor: cursor && cursor.row < maxRows ? cursor : undefined };
  });
}

export function promptKey(s: PromptState, k: Key): { value: string | undefined } | undefined {
  if (k.name === 'escape' || (k.name === 'ctrl' && (k.ch === 'c' || k.ch === 'd'))) return { value: undefined };
  const r = s.area ? textareaKey(s.area, k) : inputKey(s.input!, k);
  if (r !== 'submit') { if (r) s.error = undefined; return undefined; }
  const value = promptValue(s);
  const message = s.o.validate?.(value);
  if (message) { s.error = message; return undefined; }
  return { value };
}

export function promptModal(o: PromptOptions): Modal<string | undefined> & { state: PromptState } {
  const state = createPrompt(o);
  return { state, cancel: undefined, render: (size, g) => renderPrompt(state, size, g), key: (k) => promptKey(state, k) };
}

// ---- picker ----

export interface PickOption {
  value: string;
  label: string;
  /** Muted text after the label, cut when the row is short of room. */
  detail?: string;
  meta?: string;
  /** What the option means, in a sentence or two: shown whole in a strip under the list while it is highlighted. */
  description?: string;
  disabled?: boolean;
  keywords?: string;
}

export interface PickOptions {
  title: string;
  message?: string;
  options: PickOption[];
  /** The value(s) selected (single) or checked (multi) at the start. */
  selected?: string | string[];
  multi?: boolean;
  /** Multi: Enter with nothing checked answers [] (default: the highlighted option, as if checked). */
  allowNone?: boolean;
  /** Type to filter (default true: every picker filters as the person types). */
  filter?: boolean;
  /** How typing matches the options (default fuzzy; `words` for options that are sentences). */
  match?: 'fuzzy' | 'words';
  empty?: string;
}

export interface PickerState { o: PickOptions; list: ListState; listAt?: { row: number; col: number } }

export function createPicker(o: PickOptions): PickerState {
  const items: ListItem[] = o.options.map((op) => ({ id: op.value, label: op.label, detail: op.detail, meta: op.meta, disabled: op.disabled, keywords: op.keywords }));
  const sel = Array.isArray(o.selected) ? o.selected : o.selected !== undefined ? [o.selected] : [];
  const list = createList(items, {
    filter: o.filter === false ? 'off' : 'type', match: o.match, multi: o.multi, empty: o.empty ?? 'Nothing to choose',
    selected: sel[0], checked: o.multi ? sel : [],
  });
  return { o, list };
}

export function renderPicker(s: PickerState, size: Size, g: Glyphs): Rendered {
  const o = s.o;
  const widest = Math.max(20, ...o.options.map((op) => width(plainText(op.label)) + (op.detail ? width(plainText(op.detail)) + 2 : 0) + (op.meta ? width(plainText(op.meta)) + 2 : 0)));
  const described = o.options.some((op) => op.description);

  // A long message (a reason, a path) widens the box, as a long option does.
  const said = o.message ? Math.min(78, Math.max(0, ...o.message.split('\n').map((l) => width(plainText(l)))) + 8) : 0;
  const want = Math.max(40, Math.min(90, Math.max(widest + 12, said)));
  let at = 0;
  const box = dialog(size, g, { title: o.title, width: want }, (w, maxRows) => {
    // The message is read whole when there is room (a reason, a path), leaving the list three rows.
    const message = o.message ? wrapParagraphs(o.message, w, Math.max(2, Math.min(12, maxRows - 3 - Math.min(3, o.options.length + 1)))).map((l) => c.muted(l)) : [];
    // The filter line appears once something is typed (or when the options do not fit).
    const filterRow = s.list.filter === 'type' && s.list.query ? 1 : 0;
    const listWant = Math.max(1, o.options.length) + filterRow;
    // The strip keeps one height for every option, so the box does not jump as the highlight moves.
    // Names only: an option's description is not drawn (the strip is gone).
    const descRows = 0;
    let msgBlock = message.length ? message.length + 1 : 0;
    let descBlock = descRows ? descRows + 1 : 0;
    const room = () => maxRows - msgBlock - descBlock;
    if (room() < Math.min(3, listWant)) descBlock = 0;
    if (room() < Math.min(3, listWant)) msgBlock = 0;
    const listRows = Math.max(1, Math.min(listWant, room()));
    const lines = msgBlock ? [...message, ''] : [];
    at = lines.length;
    lines.push(...renderList(s.list, { rows: listRows, cols: w }, g, { focused: true, scrollbar: true }));
    if (descBlock) {
      const desc = o.options.find((op) => op.value === selectedItem(s.list)?.id)?.description;
      const text = desc ? wrapParagraphs(desc, w, descRows) : [];
      lines.push(c.faint(repeat(g.h, w)));
      for (let i = 0; i < descRows; i++) lines.push(cell(c.muted(text[i] ?? ''), w));
    }
    return { lines: lines.slice(0, maxRows) };
  });
  s.listAt = { row: at + box.inset.row, col: box.inset.col };
  return box;
}

function pickResult(s: PickerState): { value: string[] | undefined } | undefined {
  const current = selectedItem(s.list);
  if (s.o.multi) {
    const ids = checkedIds(s.list);
    if (ids.length || s.o.allowNone) return { value: ids };
    return current && !current.disabled ? { value: [current.id] } : undefined;
  }
  return current && !current.disabled ? { value: [current.id] } : undefined;
}

export function pickerKey(s: PickerState, k: Key): { value: string[] | undefined } | undefined {
  if (k.name === 'ctrl' && (k.ch === 'c' || k.ch === 'd')) return { value: undefined };
  if (k.name === 'enter') return pickResult(s);
  // Inside a modal Ctrl-P / Ctrl-N are free for moving, as in fzf.
  if (k.name === 'ctrl' && (k.ch === 'p' || k.ch === 'n')) { listKey(s.list, { name: k.ch === 'p' ? 'up' : 'down' }); return undefined; }
  if (listKey(s.list, k)) return undefined;
  if (k.name === 'escape' || (k.name === 'char' && k.ch === 'q')) return { value: undefined };
  return undefined;
}

export function pickerMouse(s: PickerState, m: Mouse): { value: string[] | undefined } | undefined {
  if (!s.listAt) return undefined;
  const r = listMouse(s.list, { ...m, row: m.row - s.listAt.row, col: m.col - s.listAt.col });
  if (r === 'activate') {
    if (!s.o.multi) return pickResult(s);
    const it = selectedItem(s.list);
    if (it && !it.disabled) { if (s.list.checked.has(it.id)) s.list.checked.delete(it.id); else s.list.checked.add(it.id); }
  }
  return undefined;
}

export function pickerModal(o: PickOptions): Modal<string[] | undefined> & { state: PickerState } {
  const state = createPicker(o);
  return { state, cancel: undefined, render: (size, g) => renderPicker(state, size, g), key: (k) => pickerKey(state, k), mouse: (m) => pickerMouse(state, m) };
}

// ---- viewer ----

export interface ViewOptions { title: string; text: string; diff?: boolean; wrap?: boolean }
export interface ViewerState { o: ViewOptions; scroll: ScrollState }

export function createViewer(o: ViewOptions): ViewerState {
  return { o, scroll: createScroll(o.text, { wrap: o.wrap ?? !o.diff, diff: o.diff }) };
}

export function renderViewer(s: ViewerState, size: Size, g: Glyphs): Rendered {
  // Leave a margin so the header and footer still show around it.
  const cols = Math.max(1, size.cols - (size.cols >= 60 ? 8 : size.cols >= 30 ? 2 : 0));
  const rows = Math.max(1, size.rows - (size.rows >= 16 ? 4 : size.rows >= 8 ? 2 : 0));
  const box = panel({ rows, cols }, { g, title: s.o.title, focused: true, mark: false, footer: () => c.muted(scrollPosition(s.scroll)), pad: 1, scroll: () => scrollInfo(s.scroll) },
    (inner) => renderScroll(s.scroll, inner, g, { focused: true }));
  return box;
}

export function viewerKey(s: ViewerState, k: Key): { value: undefined } | undefined {
  if (k.name === 'escape' || k.name === 'enter' || (k.name === 'char' && k.ch === 'q') || (k.name === 'ctrl' && (k.ch === 'c' || k.ch === 'd'))) return { value: undefined };
  if (k.name === 'char' && k.ch === 'w') { toggleWrap(s.scroll); return undefined; }
  scrollKey(s.scroll, k);
  return undefined;
}

export function viewerModal(o: ViewOptions): Modal<undefined> & { state: ViewerState } {
  const state = createViewer(o);
  return { state, cancel: undefined, render: (size, g) => renderViewer(state, size, g), key: (k) => viewerKey(state, k), mouse: (m) => { scrollMouse(state.scroll, m); return undefined; } };
}

// ---- busy ----

export interface BusyState { label: string; startedAt: number }

export function createBusy(label: string, now: number): BusyState {
  return { label, startedAt: now };
}

export function renderBusy(s: BusyState, size: Size, g: Glyphs, now: number): Rendered {
  const secs = Math.floor((now - s.startedAt) / 1000);
  const label = plainText(s.label);
  const want = Math.max(30, Math.min(64, width(label) + 14));
  return dialog(size, g, { title: 'Working', width: want }, (w) => {
    const elapsed = secs >= 1 ? c.muted(` ${secs}s`) : '';
    const line = `${c.accent(spinnerFrame(g, now))} ${c.text(fit(label, Math.max(1, w - 2 - width(elapsed))))}${elapsed}`;
    return { lines: size.rows >= 5 ? ['', line, ''] : [line] };
  });
}

/** A spinner box; it ignores keys (the shell closes it when the work settles). */
export function busyModal(label: string, now: number): Modal<undefined> & { state: BusyState } {
  const state = createBusy(label, now);
  return { state, cancel: undefined, render: (size, g, t) => renderBusy(state, size, g, t), key: () => undefined, animating: () => true };
}

// ---- notice ----

export interface NoticeAction {
  id: string;
  label: string;
  /** Focused when the dialog opens (default: the close button, the safe choice). */
  primary?: boolean;
  danger?: boolean;
}

/** News the person has to read whole, with several actions: why a run cannot start, the error it stopped with. */
export interface NoticeOptions extends DialogText {
  title: string;
  tone?: 'info' | 'warn' | 'bad';
  actions?: NoticeAction[];
  /** The label of the button that only closes (default "Close"). */
  close?: string;
}

export interface NoticeState extends BodyScroll {
  o: NoticeOptions;
  /** Index into [close, ...actions]. */
  focus: number;
  buttons: Array<{ index: number; row: number; from: number; to: number }>;
}

export function createNotice(o: NoticeOptions): NoticeState {
  const primary = (o.actions ?? []).findIndex((a) => a.primary);
  return { o, focus: primary >= 0 ? primary + 1 : 0, top: 0, visible: 1, total: 0, overflow: false, buttons: [] };
}

function noticeChoices(s: NoticeState): Array<{ id: string | undefined; label: string; danger?: boolean }> {
  return [{ id: undefined, label: s.o.close ?? 'Close' }, ...(s.o.actions ?? []).map((a) => ({ id: a.id, label: a.label, danger: a.danger }))];
}

export function renderNotice(s: NoticeState, size: Size, g: Glyphs): Rendered {
  const o = s.o;
  const border = o.tone === 'bad' ? c.bad : o.tone === 'warn' ? c.warn : undefined;
  const choices = noticeChoices(s);
  // Wide enough for the buttons at their full padding, when the screen allows.
  const buttonsW = choices.reduce((n, x) => n + width(plainText(x.label)) + 4, 0) + 2 * (choices.length - 1);
  const want = Math.max(46, Math.min(78, Math.max(bodyWidth(o), buttonsW) + 8));
  const box = dialog(size, g, { title: o.title, width: want, border, footer: () => scrollHint(s) }, (w, maxRows) => {
    const row = buttonRow(choices.map((x, i) => ({ label: x.label, focused: i === s.focus, danger: x.danger })), w);
    const f = flow(bodyBlocks(o, w, g), [], row.lines, maxRows, s);
    s.buttons = row.hits.map((h) => ({ index: h.index, row: f.buttonsAt + h.row, from: h.from, to: h.to }));
    return { lines: f.lines.slice(0, maxRows) };
  });
  for (const b of s.buttons) { b.row += box.inset.row; b.from += box.inset.col; b.to += box.inset.col; }
  return box;
}

export function noticeKey(s: NoticeState, k: Key): { value: string | undefined } | undefined {
  const n = noticeChoices(s).length;
  if (bodyKey(s, k)) return undefined;
  switch (k.name) {
    case 'escape': return { value: undefined };
    case 'ctrl': return k.ch === 'c' || k.ch === 'd' ? { value: undefined } : undefined;
    case 'enter': return { value: noticeChoices(s)[s.focus]?.id };
    case 'left': case 'shift-tab': s.focus = (s.focus + n - 1) % n; return undefined;
    case 'right': case 'tab': s.focus = (s.focus + 1) % n; return undefined;
    case 'char':
      if (k.ch === 'q') return { value: undefined };
      if (k.ch === 'j') bodyScroll(s, 1);
      if (k.ch === 'k') bodyScroll(s, -1);
      return undefined;
    default: return undefined;
  }
}

export function noticeMouse(s: NoticeState, m: Mouse): { value: string | undefined } | undefined {
  if (bodyWheel(s, m)) return undefined;
  if (m.kind !== 'press' || m.button !== 'left') return undefined;
  const b = s.buttons.find((x) => x.row === m.row && m.col >= x.from && m.col < x.to);
  return b ? { value: noticeChoices(s)[b.index]?.id } : undefined;
}

/** Resolves with the chosen action's id, or undefined when closed. */
export function noticeModal(o: NoticeOptions): Modal<string | undefined> & { state: NoticeState } {
  const state = createNotice(o);
  return { state, cancel: undefined, render: (size, g) => renderNotice(state, size, g), key: (k) => noticeKey(state, k), mouse: (m) => noticeMouse(state, m) };
}
