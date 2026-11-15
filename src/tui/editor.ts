// A one-line editor for the prompt at the bottom of the full-screen view: readline's essentials
// (cursor movement, kill keys, history) without readline, which cannot share the terminal in raw mode.
import type { Key } from './screen.ts';
import { nextStop, pasteText, prevStop } from './text.ts';

export interface Editor {
  text: string;
  cursor: number;
  /** Most recent first, shared with the plain prompt so both remember the same lines. */
  history: string[];
  index: number;
  draft: string;
}

export function createEditor(history: string[]): Editor {
  return { text: '', cursor: 0, history, index: -1, draft: '' };
}

/** Apply one key; 'submit' when Enter was pressed. */
export function edit(e: Editor, k: Key): 'submit' | undefined {
  const chars = () => [...e.text];
  const set = (arr: string[], cursor: number) => { e.text = arr.join(''); e.cursor = Math.max(0, Math.min(cursor, arr.length)); };
  switch (k.name) {
    case 'char': { const a = chars(); a.splice(e.cursor, 0, k.ch); set(a, e.cursor + 1); return; }
    // A character is a whole grapheme: an emoji with its variation selector, a letter with its accent.
    case 'backspace': { if (e.cursor === 0) return; const a = chars(); const i = prevStop(a, e.cursor); a.splice(i, e.cursor - i); set(a, i); return; }
    case 'delete': { const a = chars(); a.splice(e.cursor, nextStop(a, e.cursor) - e.cursor); set(a, e.cursor); return; }
    case 'left': e.cursor = prevStop(chars(), e.cursor); return;
    case 'right': e.cursor = nextStop(chars(), e.cursor); return;
    case 'home': e.cursor = 0; return;
    case 'end': e.cursor = chars().length; return;
    case 'up': recall(e, e.index + 1); return;
    case 'down': recall(e, e.index - 1); return;
    case 'enter': return 'submit';
    // A paste is one line here: its newlines become spaces and nothing in it submits.
    case 'paste': insertText(e, pasteText(k.text)); return;
    case 'ctrl-left': e.cursor = wordLeft(chars(), e.cursor); return;
    case 'ctrl-right': e.cursor = wordRight(chars(), e.cursor); return;
    case 'alt-backspace': { const a = chars(); const i = wordLeft(a, e.cursor); a.splice(i, e.cursor - i); set(a, i); return; }
    case 'ctrl-delete': { const a = chars(); a.splice(e.cursor, wordRight(a, e.cursor) - e.cursor); set(a, e.cursor); return; }
    case 'alt':
      switch (k.ch) {
        case 'b': e.cursor = wordLeft(chars(), e.cursor); return;
        case 'f': e.cursor = wordRight(chars(), e.cursor); return;
        case 'd': { const a = chars(); a.splice(e.cursor, wordRight(a, e.cursor) - e.cursor); set(a, e.cursor); return; }
      }
      return;
    case 'ctrl':
      switch (k.ch) {
        case 'a': e.cursor = 0; return;
        case 'e': e.cursor = chars().length; return;
        case 'u': set(chars().slice(e.cursor), 0); return;
        case 'k': set(chars().slice(0, e.cursor), e.cursor); return;
        case 'w': {
          const a = chars();
          let i = e.cursor;
          while (i > 0 && a[i - 1] === ' ') i--;
          while (i > 0 && a[i - 1] !== ' ') i--;
          a.splice(i, e.cursor - i);
          set(a, i);
          return;
        }
      }
      return;
  }
}

/** Insert text at the cursor, which is what taking a prediction does. */
export function insertText(e: Editor, text: string): void {
  const a = [...e.text];
  a.splice(e.cursor, 0, ...text);
  e.text = a.join('');
  e.cursor = Math.min(a.length, e.cursor + [...text].length);
}

// Marks (accents, variation selectors) belong to the word their letter is in.
const WORD = /[\p{L}\p{M}\p{N}_]/u;

/** Where Ctrl-Left / Alt-B lands: the start of the word before the cursor. */
export function wordLeft(a: string[], cursor: number): number {
  let i = Math.min(cursor, a.length);
  while (i > 0 && !WORD.test(a[i - 1]!)) i--;
  while (i > 0 && WORD.test(a[i - 1]!)) i--;
  return i;
}

/** Where Ctrl-Right / Alt-F lands: the end of the word after the cursor. */
export function wordRight(a: string[], cursor: number): number {
  let i = Math.max(0, cursor);
  while (i < a.length && !WORD.test(a[i]!)) i++;
  while (i < a.length && WORD.test(a[i]!)) i++;
  return i;
}

function recall(e: Editor, index: number): void {
  if (index < -1 || index >= e.history.length) return;
  if (e.index === -1) e.draft = e.text;
  e.index = index;
  e.text = index === -1 ? e.draft : e.history[index]!;
  e.cursor = [...e.text].length;
}

/** Take the line out of the editor and remember it. */
export function submit(e: Editor): string {
  const line = e.text;
  if (line.trim() && line !== e.history[0]) e.history.unshift(line);
  e.text = '';
  e.cursor = 0;
  e.index = -1;
  e.draft = '';
  return line;
}
