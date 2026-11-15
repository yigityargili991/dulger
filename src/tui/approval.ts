// The dialog that approves shell commands a replan adds: the kit's typed confirmation (field, buttons,
// border), with each command shown whole (soft-wrapped, never cut, control characters spelled out) in
// a list that scrolls when it is long. The kit's own confirm wraps its message as prose and would cut
// a long token, so the list is drawn here. Only the typed word approves; Enter on anything else, Esc,
// Ctrl-C or a click outside refuses at once, as the plain prompt does.
import type { Key, Mouse } from './screen.ts';
import { c, type Glyphs } from './theme.ts';
import { cell, plainText, width, wrap } from './text.ts';
import { buttonRow, createInput, inputKey, inputValue, panel, renderInput, scrollbar, type InputState, type Modal, type Rendered, type Size } from './kit/index.ts';
import { commandRows, shownCommand } from './view.ts';

export interface ApprovalItem { command: string; detail?: string }

export interface ApprovalOptions {
  title: string;
  /** What is asked and why; wrapped as prose. */
  message: string;
  items: ApprovalItem[];
  /** The word to type, compared trimmed and ignoring case. */
  word: string;
  /** Above the field: what typing the word does, and what anything else does. */
  prompt: string;
  confirm: string;
  cancel: string;
}

export interface ApprovalState {
  o: ApprovalOptions;
  input: InputState;
  /** First row of the command list shown; `height` and `total` are written back by rendering. */
  top: number;
  height: number;
  total: number;
  /** Where the buttons landed, in box cells, for clicks. */
  buttons: Array<{ id: 'confirm' | 'cancel'; row: number; from: number; to: number }>;
}

export function createApproval(o: ApprovalOptions): ApprovalState {
  // No placeholder: without colour a faint `yes` would read as already typed, and Enter would refuse.
  return { o, input: createInput(), top: 0, height: 1, total: 0, buttons: [] };
}

function typed(s: ApprovalState): boolean {
  return inputValue(s.input).trim().toLowerCase() === s.o.word.trim().toLowerCase();
}

export function renderApproval(s: ApprovalState, size: Size, g: Glyphs): Rendered {
  const o = s.o;
  const longest = Math.max(0, ...o.items.map((it) => width(plainText(shownCommand(it.command)))));
  const cols = Math.max(1, Math.min(size.cols, Math.max(60, Math.min(100, longest + 12))));
  const framed = size.rows >= 3 && cols >= 6;
  const pad = !framed ? 0 : size.rows < 10 || cols < 30 ? 1 : 2;
  const w = framed ? Math.max(1, cols - 2 - pad * 2) : cols;
  const maxRows = Math.max(1, size.rows - (framed ? 2 : 0));

  const listRows = (lw: number) => o.items.flatMap((it) => [
    ...commandRows(it.command, lw),
    ...(it.detail ? wrap(it.detail, Math.max(1, lw - 4)).map((l) => '    ' + c.muted(l)) : []),
  ]);
  const message = wrap(o.message, w).map((l) => c.text(l));
  const prompt = wrap(o.prompt, w).map((l) => c.muted(l));
  // The kit's row: right-aligned, shrinking its padding and then wrapping, so no label is ever cut.
  const ok = typed(s);
  const row = buttonRow([{ label: o.cancel }, { label: o.confirm, focused: ok, off: !ok }], w);

  // The field, the buttons and one row of the list always show; then the prompt, a few commands,
  // the message, breathing room, and the rest of the list.
  let budget = maxRows - 2 - row.lines.length;
  const take = (want: number) => { const n = Math.max(0, Math.min(budget, want)); budget -= n; return n; };
  let all = listRows(w);
  const promptN = take(prompt.length);
  let listN = 1 + take(Math.min(all.length, 4) - 1);
  const messageN = take(message.length);
  const gaps = take(3);
  listN += take(all.length - listN);
  const scrolling = all.length > listN && w > 6;
  if (scrolling) all = listRows(w - 2);
  s.total = all.length;
  s.height = listN;
  s.top = Math.max(0, Math.min(s.top, all.length - listN));
  const sb = scrolling ? scrollbar(listN, s.top, all.length, listN, g, true) : [];
  const list = all.slice(s.top, s.top + listN).map((l, r) => (scrolling ? cell(l, w - 2) + ' ' + sb[r] : l));
  while (list.length < listN) list.push(scrolling ? cell('', w - 2) + ' ' + (sb[list.length] ?? '') : '');

  const lines: string[] = [];
  if (messageN) { lines.push(...message.slice(0, messageN)); if (gaps >= 1) lines.push(''); }
  lines.push(...list);
  if (gaps >= 2) lines.push('');
  lines.push(...prompt.slice(0, promptN));
  const inputRow = lines.length;
  const field = renderInput(s.input, Math.min(w, 24), { focused: true, field: true });
  lines.push(field.line);
  if (gaps >= 3) lines.push('');
  const buttonsAt = lines.length;
  lines.push(...row.lines);

  const inset = framed ? { row: 1, col: 1 + pad } : { row: 0, col: 0 };
  s.buttons = row.hits.map((h) => ({ id: h.index === 0 ? 'cancel' as const : 'confirm' as const, row: buttonsAt + h.row + inset.row, from: h.from + inset.col, to: h.to + inset.col }));
  const rows = Math.min(size.rows, lines.length + (framed ? 2 : 0));
  return panel({ rows, cols }, { g, title: o.title, focused: true, mark: false, pad, border: c.warn }, () => ({
    lines, cursor: { row: inputRow, col: field.cursor ?? 0 },
  }));
}

export function approvalKey(s: ApprovalState, k: Key): { value: boolean } | undefined {
  if (k.name === 'escape' || (k.name === 'ctrl' && (k.ch === 'c' || k.ch === 'd'))) return { value: false };
  // Enter answers whatever is typed: only the word approves, so a stray Enter refuses.
  if (k.name === 'enter') return { value: typed(s) };
  const by = (d: number) => { s.top = Math.max(0, Math.min(Math.max(0, s.total - s.height), s.top + d)); };
  const page = Math.max(1, s.height - 1);
  switch (k.name) {
    case 'up': by(-1); return undefined;
    case 'down': by(1); return undefined;
    case 'pageup': by(-page); return undefined;
    case 'pagedown': by(page); return undefined;
    default: inputKey(s.input, k); return undefined;
  }
}

export function approvalMouse(s: ApprovalState, m: Mouse): { value: boolean } | undefined {
  if (m.kind === 'wheel-up' || m.kind === 'wheel-down') {
    s.top = Math.max(0, Math.min(Math.max(0, s.total - s.height), s.top + (m.kind === 'wheel-up' ? -3 : 3)));
    return undefined;
  }
  if (m.kind !== 'press' || m.button !== 'left') return undefined;
  const b = s.buttons.find((x) => x.row === m.row && m.col >= x.from && m.col < x.to);
  if (!b) return undefined;
  if (b.id === 'cancel') return { value: false };
  return typed(s) ? { value: true } : undefined;
}

export function approvalModal(o: ApprovalOptions): Modal<boolean> & { state: ApprovalState } {
  const state = createApproval(o);
  return { state, cancel: false, render: (size, g) => renderApproval(state, size, g), key: (k) => approvalKey(state, k), mouse: (m) => approvalMouse(state, m) };
}
