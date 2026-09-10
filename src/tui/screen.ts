// The terminal side of the full-screen view: alternate screen, raw keys, and a frame painter that
// only rewrites the rows that changed, so a redraw every 100ms costs almost nothing.
import { cell } from './text.ts';

export type Key =
  | { name: 'char'; ch: string }
  | { name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'backspace' | 'delete' | 'tab' | 'shift-tab' | 'home' | 'end' | 'pageup' | 'pagedown' }
  | { name: 'ctrl'; ch: string };

const NAMED: Record<string, Key> = {
  '\x1b[A': { name: 'up' }, '\x1b[B': { name: 'down' }, '\x1b[C': { name: 'right' }, '\x1b[D': { name: 'left' },
  '\x1bOA': { name: 'up' }, '\x1bOB': { name: 'down' }, '\x1bOC': { name: 'right' }, '\x1bOD': { name: 'left' },
  '\x1b[H': { name: 'home' }, '\x1b[F': { name: 'end' }, '\x1bOH': { name: 'home' }, '\x1bOF': { name: 'end' },
  '\x1b[1~': { name: 'home' }, '\x1b[4~': { name: 'end' }, '\x1b[3~': { name: 'delete' },
  '\x1b[5~': { name: 'pageup' }, '\x1b[6~': { name: 'pagedown' }, '\x1b[Z': { name: 'shift-tab' },
};

/** Split one chunk of raw stdin into keys. A lone ESC is the escape key; unknown sequences are dropped. */
export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === '\x1b') {
      const m = data.slice(i).match(/^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Z])/);
      if (m) {
        const k = NAMED[m[0]];
        if (k) keys.push(k);
        i += m[0].length;
      } else {
        keys.push({ name: 'escape' });
        i++;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') keys.push({ name: 'enter' });
    else if (ch === '\x7f' || ch === '\b') keys.push({ name: 'backspace' });
    else if (ch === '\t') keys.push({ name: 'tab' });
    else if (ch < ' ') keys.push({ name: 'ctrl', ch: String.fromCharCode(ch.charCodeAt(0) + 96) });
    else {
      // Take a whole grapheme so surrogate pairs and combining marks stay together.
      const cp = data.codePointAt(i)!;
      const s = String.fromCodePoint(cp);
      keys.push({ name: 'char', ch: s });
      i += s.length;
      continue;
    }
    i++;
  }
  return keys;
}

export interface Screen {
  rows: number;
  cols: number;
  /** Paint a full frame: exactly `rows` lines, each cut or padded to `cols`. */
  paint(lines: string[], cursor?: { row: number; col: number }): void;
  onKey(fn: (k: Key) => void): void;
  onResize(fn: () => void): void;
  close(): void;
}

export function openScreen(out: NodeJS.WriteStream = process.stdout, inp: NodeJS.ReadStream = process.stdin): Screen {
  let prev: string[] = [];
  let keyHandler: (k: Key) => void = () => {};
  let resizeHandler: () => void = () => {};

  const onData = (buf: Buffer | string) => { for (const k of parseKeys(buf.toString())) keyHandler(k); };
  const onResize = () => { prev = []; out.write('\x1b[2J'); resizeHandler(); };
  // Whatever ends the process, leave the terminal usable.
  let closed = false;
  const restore = () => { if (!closed) out.write('\x1b[0m\x1b[?1049l\x1b[?25h'); };
  process.on('exit', restore);

  out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
  inp.setRawMode?.(true);
  inp.resume();
  inp.setEncoding('utf8');
  inp.on('data', onData);
  out.on('resize', onResize);

  const screen: Screen = {
    get rows() { return Math.max(10, out.rows ?? 24); },
    get cols() { return Math.max(40, out.columns ?? 80); },
    paint(lines, cursor) {
      const { rows, cols } = screen;
      let buf = '\x1b[?25l';
      for (let r = 0; r < rows; r++) {
        const line = cell(lines[r] ?? '', cols) + '\x1b[0m';
        if (prev[r] === line) continue;
        buf += `\x1b[${r + 1};1H${line}`;
        prev[r] = line;
      }
      prev.length = rows;
      if (cursor) buf += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
      out.write(buf);
    },
    onKey(fn) { keyHandler = fn; },
    onResize(fn) { resizeHandler = fn; },
    close() {
      closed = true;
      process.off('exit', restore);
      inp.off('data', onData);
      out.off('resize', onResize);
      inp.setRawMode?.(false);
      inp.pause();
      out.write('\x1b[0m\x1b[2J\x1b[H\x1b[?1049l\x1b[?25h');
    },
  };
  return screen;
}
