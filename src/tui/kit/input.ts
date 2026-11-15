// A single-line input on top of the prompt editor (src/tui/editor.ts): placeholder, optional mask,
// and horizontal scrolling that keeps the cursor in view and only moves when it has to.
import type { Key } from '../screen.ts';
import { createEditor, edit, type Editor } from '../editor.ts';
import { c } from '../theme.ts';
import { cell, fit, plainText, width } from '../text.ts';
import { colourless, onBackground, placeholder, slice } from './compose.ts';

export interface InputState {
  editor: Editor;
  placeholder: string;
  /** Shown instead of each character (secrets). */
  mask?: string;
  /** First visible cell; written back by rendering. */
  scroll: number;
}

export interface InputOptions {
  value?: string;
  placeholder?: string;
  /** true masks with `•`; a string masks with that string. */
  mask?: boolean | string;
  /** What ↑/↓ recall, most recent first; without it ↑/↓ are left to the caller (to move between fields). */
  history?: string[];
}

export function createInput(o: InputOptions = {}): InputState {
  const editor = createEditor(o.history ?? []);
  const s: InputState = { editor, placeholder: o.placeholder ?? '', mask: o.mask === true ? '•' : o.mask || undefined, scroll: 0 };
  setInputValue(s, o.value ?? '');
  return s;
}

export function inputValue(s: InputState): string {
  return s.editor.text;
}

export function setInputValue(s: InputState, value: string): void {
  s.editor.text = plainText(value);
  s.editor.cursor = [...s.editor.text].length;
}

const EDITING = new Set<Key['name']>(['backspace', 'delete', 'left', 'right', 'home', 'end', 'paste', 'ctrl-left', 'ctrl-right', 'alt-backspace', 'ctrl-delete']);

/** Apply a key. 'submit' on Enter, true when the input used the key, false when it is the caller's. */
export function inputKey(s: InputState, k: Key): boolean | 'submit' {
  const e = s.editor;
  if (k.name === 'enter') return 'submit';
  if (k.name === 'char') {
    const ch = plainText(k.ch);
    if (!ch) return true;
    edit(e, { name: 'char', ch });
    return true;
  }
  if ((k.name === 'up' || k.name === 'down') && e.history.length) { edit(e, k); return true; }
  if (k.name === 'ctrl' && ['a', 'e', 'u', 'k', 'w'].includes(k.ch)) { edit(e, k); return true; }
  if (k.name === 'alt' && ['b', 'f', 'd'].includes(k.ch)) { edit(e, k); return true; }
  if (EDITING.has(k.name)) { edit(e, k); return true; }
  return false;
}

export interface InputRenderOptions {
  focused?: boolean;
  /** Paint the field's extent on the surface colour, so an empty field is still visible. */
  field?: boolean;
}

/** One row of `cols` cells and, when focused, the cursor column within it. */
export function renderInput(s: InputState, cols: number, o: InputRenderOptions = {}): { line: string; cursor?: number } {
  if (cols <= 0) return { line: '' };
  const cps = [...s.editor.text];
  const shown = s.mask ? cps.map(() => s.mask!) : cps;
  const cursorCell = width(shown.slice(0, s.editor.cursor).join(''));
  const total = width(shown.join(''));
  // Without colour a field has no background to show its extent: it is drawn in brackets instead.
  const boxed = Boolean(o.field) && colourless() && cols >= 3;
  // One spare cell at the end so the cursor can sit after the last character.
  const avail = Math.max(1, boxed ? cols - 2 : cols);
  let scroll = Math.max(0, Math.min(s.scroll, Math.max(0, total + 1 - avail)));
  if (cursorCell < scroll) scroll = cursorCell;
  if (cursorCell >= scroll + avail) scroll = cursorCell - avail + 1;
  s.scroll = scroll;
  let text: string;
  if (!cps.length && s.placeholder) text = c.faint(fit(placeholder(s.placeholder), avail));
  else text = slice(shown.join(''), scroll, scroll + avail);
  const line = boxed ? `[${cell(text, avail)}]` : o.field ? onBackground(text, cols, c.bg) : cell(text, cols);
  return { line, cursor: o.focused ? (boxed ? 1 : 0) + Math.min(avail - 1, cursorCell - scroll) : undefined };
}
