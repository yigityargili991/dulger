import { openScreen, type Screen } from './screen.ts';
import { c } from './theme.ts';
import { cell, plainText, wrap } from './text.ts';

/** Read-only, bounded detail view shared by reports, diffs, checks and settings. */
export function pager(title: string, text: string, supplied?: Screen): Promise<void> {
  if (!supplied && !(process.stdin.isTTY && process.stdout.isTTY)) { console.log(plainText(`${title}\n${text}`)); return Promise.resolve(); }
  const screen = supplied ?? openScreen();
  return new Promise((resolve) => {
    let offset = 0;
    let closed = false;
    const lines = () => text.split('\n').flatMap((line) => wrap(line || ' ', Math.max(1, screen.cols - 2)));
    const paint = () => {
      if (closed) return;
      const all = lines();
      const height = Math.max(1, screen.rows - 2);
      offset = Math.max(0, Math.min(offset, all.length - height));
      const frame = [c.bold(` ${plainText(title)}`), ...all.slice(offset, offset + height).map((line) => ` ${line}`)];
      while (frame.length < screen.rows - 1) frame.push('');
      frame.push(c.muted(` ↑↓ scroll · PgUp/PgDn · Esc back · ${offset + 1}/${all.length}`));
      screen.paint(frame.slice(0, screen.rows).map((line) => cell(line, screen.cols)));
    };
    screen.onKey((key) => {
      if (closed) return;
      if (['escape', 'enter'].includes(key.name) || (key.name === 'char' && key.ch === 'q') || (key.name === 'ctrl' && ['c', 'd'].includes(key.ch))) {
        closed = true; screen.close(); resolve(); return;
      }
      if (key.name === 'up') offset--;
      if (key.name === 'down') offset++;
      if (key.name === 'pageup') offset -= Math.max(1, screen.rows - 2);
      if (key.name === 'pagedown') offset += Math.max(1, screen.rows - 2);
      if (key.name === 'home') offset = 0;
      if (key.name === 'end') offset = lines().length;
      paint();
    });
    screen.onResize(paint);
    paint();
  });
}
