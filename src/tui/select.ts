// Shared keyboard listbox for session setup. Rendering and terminal ownership stay in the TUI.
import { openScreen, type Screen } from './screen.ts';
import { c } from './theme.ts';
import { cell, pasteText, plainText, wrap } from './text.ts';

export interface Choice { value: string; label: string; description?: string }
export interface SelectOptions {
  title: string;
  description?: string;
  choices: Choice[];
  selected?: string;
  backLabel?: string;
}
/** undefined goes back; null cancels setup completely. */
export type Selection = string | undefined | null;

export function select(options: SelectOptions, suppliedScreen?: Screen): Promise<Selection> {
  if (!suppliedScreen && !(process.stdin.isTTY && process.stdout.isTTY)) return Promise.resolve(null);
  const screen = suppliedScreen ?? openScreen();
  return new Promise((resolve) => {
    let query = '';
    let index = Math.max(0, options.choices.findIndex((o) => o.value === options.selected));
    let closed = false;
    const matches = () => options.choices.filter((o) => `${o.label} ${o.description ?? ''}`.toLowerCase().includes(query.toLowerCase()));
    const paint = () => {
      if (!closed) screen.paint(renderSelect(options, matches(), index, query, screen.rows, screen.cols));
    };
    const finish = (answer: Selection) => {
      if (closed) return;
      closed = true;
      screen.close();
      resolve(answer);
    };
    screen.onKey((key) => {
      if (closed) return;
      const choices = matches();
      switch (key.name) {
        case 'ctrl':
          if (key.ch === 'c' || key.ch === 'd') return finish(null);
          if (key.ch === 'u') { query = ''; index = 0; }
          break;
        case 'escape':
          if (query) { query = ''; index = 0; break; }
          return finish(undefined);
        case 'enter': if (choices[index]) return finish(choices[index]!.value); break;
        case 'up': case 'shift-tab': index = Math.max(0, index - 1); break;
        case 'down': case 'tab': index = Math.min(choices.length - 1, index + 1); break;
        case 'home': index = 0; break;
        case 'end': index = choices.length - 1; break;
        case 'pageup': index = Math.max(0, index - Math.max(1, screen.rows - 10)); break;
        case 'pagedown': index = Math.min(choices.length - 1, index + Math.max(1, screen.rows - 10)); break;
        case 'char': query += key.ch; index = 0; break;
        case 'paste': query += pasteText(key.text); index = 0; break;
        case 'backspace': query = [...query].slice(0, -1).join(''); index = 0; break;
      }
      index = Math.max(0, index);
      paint();
    });
    screen.onResize(paint);
    paint();
  });
}

export function renderSelect(o: SelectOptions, choices: Choice[], index: number, query: string, rows: number, cols: number): string[] {
  const selected = choices[index];
  if (rows === 1) return [cell(plainText(selected?.label ?? 'No matches'), cols)];
  const w = Math.max(1, cols - 4);
  const header = rows >= 16
    ? [c.brand(' dulger '), '', `  ${c.bold(plainText(o.title))}`, ...wrap(o.description ?? '', w, 2).map((s) => `  ${c.muted(s)}`), `  ${c.muted(query ? `Filter: ${plainText(query)}` : 'Type to filter')}`, '']
    : [`  ${c.bold(plainText(o.title))}${query ? ` / ${plainText(query)}` : ''}`,
      ...(rows >= 8 ? wrap(o.description ?? '', w, 2).map((s) => `  ${c.muted(s)}`) : [])];
  const detail = rows >= 10 && selected
    ? ['', ...wrap(`${selected.label}${selected.description ? ` — ${selected.description}` : ''}`, w, Math.min(3, Math.floor(rows / 5))).map((s) => `  ${c.muted(s)}`)]
    : [];
  const capacity = Math.max(1, rows - header.length - detail.length - 1);
  const first = Math.max(0, Math.min(index - Math.floor(capacity / 2), choices.length - capacity));
  const visible = choices.slice(first, first + capacity).map((choice, i) => {
    const active = first + i === index;
    return `  ${active ? c.selected('> ') : '  '}${(active ? c.bold : c.text)(plainText(choice.label))}`;
  });
  if (!choices.length) visible.push(`  ${c.warn('No matches. Backspace or Ctrl-U clears the filter.')}`);
  while (visible.length < capacity) visible.push('');
  const position = choices.length > capacity ? ` ${index + 1}/${choices.length}` : '';
  const footer = c.muted(` ↑↓ choose · Enter select · Esc ${query ? 'clear' : o.backLabel ?? 'back'} · ^C cancel${position}`);
  return [...header, ...visible, ...detail, footer].slice(0, rows).map((line) => cell(line, cols));
}
