// A one-line editor for the prompt at the bottom of the full-screen view: readline's essentials
// (cursor movement, kill keys, history) without readline, which cannot share the terminal in raw mode.
import type { Key } from './screen.ts';

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
    case 'backspace': { if (e.cursor === 0) return; const a = chars(); a.splice(e.cursor - 1, 1); set(a, e.cursor - 1); return; }
    case 'delete': { const a = chars(); a.splice(e.cursor, 1); set(a, e.cursor); return; }
    case 'left': e.cursor = Math.max(0, e.cursor - 1); return;
    case 'right': e.cursor = Math.min(chars().length, e.cursor + 1); return;
    case 'home': e.cursor = 0; return;
    case 'end': e.cursor = chars().length; return;
    case 'up': recall(e, e.index + 1); return;
    case 'down': recall(e, e.index - 1); return;
    case 'enter': return 'submit';
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
