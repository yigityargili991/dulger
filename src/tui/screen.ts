// The terminal side of the full-screen view: alternate screen, raw keys, and a frame painter that
// only rewrites the rows that changed, so a redraw every 100ms costs almost nothing.
// Input decoding understands xterm-style modified keys, bracketed paste and SGR (1006) mouse reports.
import { cell } from './text.ts';

type Named = 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'backspace' | 'delete' | 'tab' | 'shift-tab' | 'home' | 'end' | 'pageup' | 'pagedown';
type Movement = 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown' | 'delete';
/** An arrow or navigation key with Ctrl, Alt or Shift held, as xterm reports it (`\x1b[1;5C` is ctrl-right). */
export type ModifiedKey = `${'ctrl' | 'alt' | 'shift'}-${Movement}`;
export type FunctionKey = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12';

export type Key =
  | { name: 'char'; ch: string }
  | { name: Named }
  | { name: 'ctrl'; ch: string }
  /** ESC directly followed by a printable character in the same read: Alt (Meta) + that character. */
  | { name: 'alt'; ch: string }
  | { name: ModifiedKey | FunctionKey | 'alt-enter' | 'alt-backspace' }
  /** A bracketed paste, whole: pasted newlines arrive here, never as Enter. Raw text; sanitize before display. */
  | { name: 'paste'; text: string };

/** One SGR mouse report. Rows and columns are 0-based screen cells. */
export interface Mouse {
  kind: 'press' | 'release' | 'drag' | 'move' | 'wheel-up' | 'wheel-down';
  button: 'left' | 'middle' | 'right' | 'none';
  row: number;
  col: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export type InputEvent = { type: 'key'; key: Key } | { type: 'mouse'; mouse: Mouse };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const CSI = /^\x1b\[([<?>=]?)([0-9;:]*)([ -/]*)([@-~])/;
const SS3 = /^\x1bO([A-Za-z])/;
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const LINUX_F = /^\x1b\[\[([A-E])/;

const FINAL: Record<string, Movement> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDE: Record<number, Movement | FunctionKey> = {
  1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete', 5: 'pageup', 6: 'pagedown',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
};
const SS3_F: Record<string, FunctionKey> = { P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
const MOVEMENTS = new Set<string>(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'delete']);

/** xterm's modifier parameter is 1 + (shift 1 | alt 2 | ctrl 4); Ctrl wins over Alt, Alt over Shift. */
function modified(base: Movement, mod: number | undefined): Key {
  const bits = (mod ?? 1) - 1;
  if (bits <= 0) return { name: base };
  const prefix = bits & 4 ? 'ctrl' : bits & 2 ? 'alt' : 'shift';
  return { name: `${prefix}-${base}` };
}

function csiKey(params: string, final: string): Key | undefined {
  const nums = params.split(';').map((p) => Number.parseInt(p, 10));
  const move = FINAL[final];
  if (move) return modified(move, nums[1]);
  if (final === 'Z') return { name: 'shift-tab' };
  if (final === '~') {
    const k = TILDE[nums[0] ?? -1];
    if (!k) return undefined;
    return k.startsWith('f') ? { name: k as FunctionKey } : modified(k as Movement, nums[1]);
  }
  const f = SS3_F[final];
  return f ? { name: f } : undefined;
}

/** An SGR report as a Mouse; undefined for what the views have no use for (buttons 8-11, a sideways wheel). */
function mouseEvent(b: number, x: number, y: number, released: boolean): Mouse | undefined {
  if (b & 128) return undefined;
  const low = b & 3;
  const mods = { shift: Boolean(b & 4), alt: Boolean(b & 8), ctrl: Boolean(b & 16) };
  const at = { row: Math.max(0, y - 1), col: Math.max(0, x - 1) };
  if (b & 64) return low < 2 ? { kind: low === 1 ? 'wheel-down' : 'wheel-up', button: 'none', ...at, ...mods } : undefined;
  const button = (['left', 'middle', 'right', 'none'] as const)[low]!;
  const kind = released ? 'release' : b & 32 ? (button === 'none' ? 'move' : 'drag') : 'press';
  return { kind, button, ...at, ...mods };
}

/**
 * An X10 report (ESC [ M and three bytes, each 32 + the value), sent by a terminal that ignores the SGR
 * request. A release does not say which button; coordinates past 95 do not survive UTF-8 decoding.
 */
function x10Event(cb: number, cx: number, cy: number): Mouse | undefined {
  if ([cb, cx, cy].some((n) => n < 32 || n > 127)) return undefined;
  const b = cb - 32;
  return mouseEvent(b, cx - 32, cy - 32, (b & 3) === 3 && !(b & 96));
}

// What a read can end in when it cut an escape sequence short: the rest is in the next read.
const CSI_OPEN = /^\x1b\[[<?>=]?[0-9;:]*[ -/]*$/;
const PARTIAL = [/^\x1b$/, CSI_OPEN, /^\x1b\[\[$/, /^\x1bO$/, /^\x1b\x1b(\[[<?>=]?[0-9;:]*[ -/]*)?$/, /^\x1b\[M[\s\S]{0,2}$/];

interface Decoded {
  events: InputEvent[];
  /** A bracketed paste started but did not end: its text so far. */
  pending?: string;
  /** An escape sequence the read cut short (only when not `final`). */
  carry?: string;
}

/**
 * Decode one chunk. Not `final` (a stream), an escape sequence cut off by the chunk's end comes back as
 * `carry` for the next read. `final` (a whole input, or a held prefix given up on), it is decoded as it
 * stands: a lone ESC is Escape, ESC [ and ESC O are Alt with that key, a cut-off sequence with parameters
 * is dropped, never typed.
 */
function decode(data: string, final: boolean): Decoded {
  const events: InputEvent[] = [];
  const key = (k: Key) => events.push({ type: 'key', key: k });
  const mouse = (m: Mouse | undefined) => { if (m) events.push({ type: 'mouse', mouse: m }); };
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === '\x1b') {
      const rest = data.slice(i);
      if (rest.startsWith(PASTE_START)) {
        const end = rest.indexOf(PASTE_END, PASTE_START.length);
        if (end < 0) return { events, pending: rest.slice(PASTE_START.length) };
        key({ name: 'paste', text: rest.slice(PASTE_START.length, end) });
        i += end + PASTE_END.length;
        continue;
      }
      if (!final && PARTIAL.some((re) => re.test(rest))) return { events, carry: rest };
      if (rest.startsWith('\x1b[M')) {
        // X10 mouse: consumed whole (or what is left of it), never typed.
        if (rest.length >= 6) mouse(x10Event(rest.charCodeAt(3), rest.charCodeAt(4), rest.charCodeAt(5)));
        i += Math.min(6, rest.length);
        continue;
      }
      const sgr = rest.match(MOUSE);
      if (sgr) { mouse(mouseEvent(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4] === 'm')); i += sgr[0].length; continue; }
      const lf = rest.match(LINUX_F);
      if (lf) { key({ name: `f${'ABCDE'.indexOf(lf[1]!) + 1}` as FunctionKey }); i += lf[0].length; continue; }
      const csi = rest.match(CSI);
      if (csi) {
        const k = csi[1] || csi[3] ? undefined : csiKey(csi[2]!, csi[4]!);
        if (k) key(k);
        i += csi[0].length;
        continue;
      }
      // A sequence with parameters that never got its final byte: drop it rather than type "[<0;12".
      if (rest.length > 2 && CSI_OPEN.test(rest)) { i = data.length; continue; }
      const ss3 = rest.match(SS3);
      if (ss3) {
        const k = FINAL[ss3[1]!] ? { name: FINAL[ss3[1]!]! } : SS3_F[ss3[1]!] ? { name: SS3_F[ss3[1]!]! } : undefined;
        if (k) key(k as Key);
        i += ss3[0].length;
        continue;
      }
      const next = data[i + 1];
      // ESC ESC [ ... is how some terminals send Alt with an arrow.
      if (next === '\x1b') {
        const inner = data.slice(i + 1).match(CSI);
        const k = inner && !inner[1] && !inner[3] ? csiKey(inner[2]!, inner[4]!) : undefined;
        if (inner && k) {
          const base = k.name.replace(/^(ctrl|alt|shift)-/, '');
          key(MOVEMENTS.has(base) ? { name: `alt-${base}` as ModifiedKey } : k);
          i += 1 + inner[0].length;
          continue;
        }
      }
      if (next === '\r' || next === '\n') { key({ name: 'alt-enter' }); i += 2; continue; }
      if (next === '\x7f' || next === '\b') { key({ name: 'alt-backspace' }); i += 2; continue; }
      if (next !== undefined && next >= ' ' && next !== '\x7f') {
        const s = String.fromCodePoint(data.codePointAt(i + 1)!);
        key({ name: 'alt', ch: s });
        i += 1 + s.length;
        continue;
      }
      key({ name: 'escape' });
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') key({ name: 'enter' });
    else if (ch === '\x7f' || ch === '\b') key({ name: 'backspace' });
    else if (ch === '\t') key({ name: 'tab' });
    else if (ch < ' ') key({ name: 'ctrl', ch: String.fromCharCode(ch.charCodeAt(0) + 96) });
    else {
      // Take a whole code point so surrogate pairs stay together.
      const cp = data.codePointAt(i)!;
      const s = String.fromCodePoint(cp);
      key({ name: 'char', ch: s });
      i += s.length;
      continue;
    }
    i++;
  }
  return { events };
}

/** Keys and mouse reports in one chunk; a paste cut off by the chunk's end is taken as it stands. */
export function parseInput(data: string): InputEvent[] {
  const { events, pending } = decode(data, true);
  if (pending !== undefined) events.push({ type: 'key', key: { name: 'paste', text: pending } });
  return events;
}

/** Split one chunk of raw stdin into keys. A lone ESC is the escape key; unknown sequences are dropped. */
export function parseKeys(data: string): Key[] {
  return parseInput(data).flatMap((e) => (e.type === 'key' ? [e.key] : []));
}

/**
 * A stateful decoder for a stream of reads. It is called with each read, and holds back what the read
 * cut short until the next one: a bracketed paste (it arrives as one key however many reads it spans,
 * and its end marker may itself be split) and an escape sequence (`\x1b[` | `A`). `holding()` says what
 * is held; `flush()` gives up waiting and decodes it as it stands (a lone ESC is Escape, a paste is
 * taken as far as it came). `openScreen` flushes after a short quiet spell.
 */
export interface InputDecoder {
  (chunk: string): InputEvent[];
  holding(): 'escape' | 'paste' | undefined;
  flush(): InputEvent[];
}

export function createInputDecoder(): InputDecoder {
  // A paste in progress: its reads so far, and their last few characters, where an end marker split
  // by the read would have begun (searching only there keeps a huge paste from being copied per read).
  let paste: { parts: string[]; edge: string } | undefined;
  const pasteOf = (text: string) => ({ parts: [text], edge: text.slice(-(PASTE_END.length - 1)) });
  let carry = '';
  /** A paste was given up on: when the next read brings its end marker, what comes before it is still paste. */
  let tail = false;
  const feed = (chunk: string): InputEvent[] => {
    let data = chunk;
    const out: InputEvent[] = [];
    if (tail) {
      tail = false;
      const end = paste === undefined && !carry ? data.indexOf(PASTE_END) : -1;
      if (end >= 0 && !data.slice(0, end).includes(PASTE_START)) {
        out.push({ type: 'key', key: { name: 'paste', text: data.slice(0, end) } });
        data = data.slice(end + PASTE_END.length);
      }
    }
    if (paste !== undefined) {
      // Search where the last read left off too: the end marker can straddle two reads.
      const probe = paste.edge + data;
      const end = probe.indexOf(PASTE_END);
      if (end < 0) { paste.parts.push(data); paste.edge = probe.slice(-(PASTE_END.length - 1)); return out; }
      const all = paste.parts.join('') + data;
      const at = all.length - data.length - paste.edge.length + end;
      out.push({ type: 'key', key: { name: 'paste', text: all.slice(0, at) } });
      paste = undefined;
      data = all.slice(at + PASTE_END.length);
    } else if (carry) {
      const held = carry;
      carry = '';
      // A lone ESC (or two) followed by something that cannot continue a sequence was the Escape key.
      const lone = held === '\x1b' || held === '\x1b\x1b';
      if (!lone || data[0] === '[' || (held === '\x1b' && data[0] === 'O')) data = held + data;
      else out.push(...decode(held, true).events);
    }
    const r = decode(data, false);
    out.push(...r.events);
    paste = r.pending === undefined ? undefined : pasteOf(r.pending);
    carry = r.carry ?? '';
    return out;
  };
  return Object.assign(feed, {
    holding: () => (paste !== undefined ? 'paste' as const : carry ? 'escape' as const : undefined),
    flush: (): InputEvent[] => {
      const out: InputEvent[] = [];
      if (carry) { out.push(...decode(carry, true).events); carry = ''; }
      if (paste !== undefined) { out.push({ type: 'key', key: { name: 'paste', text: paste.parts.join('') } }); paste = undefined; tail = true; }
      return out;
    },
  });
}

export interface Screen {
  rows: number;
  cols: number;
  /** Paint trusted renderer output: exactly `rows` lines, each cut or padded to `cols`. */
  paint(lines: string[], cursor?: { row: number; col: number }): void;
  onKey(fn: (k: Key) => void): void;
  /** Mouse reports, when the screen was opened with `mouse: true`. Optional so simple fakes need not have it. */
  onMouse?(fn: (m: Mouse) => void): void;
  onResize(fn: () => void): void;
  /** Turn mouse reporting on or off while open (the Mouse setting changed). Optional so simple fakes need not have it. */
  setMouse?(on: boolean): void;
  close(): void;
}

export interface ScreenOptions {
  /** Report clicks and the wheel (SGR 1006). Off by default: it takes text selection away from the terminal. */
  mouse?: boolean;
  /** Bracketed paste, so a pasted newline is never Enter. On by default. */
  paste?: boolean;
  /** How long a lone ESC at the end of a read waits for the rest of a sequence before it is Escape (25ms). */
  escapeMs?: number;
  /** How long a bracketed paste may go quiet without its end marker before it is taken as it stands (2s). */
  pasteMs?: number;
}

const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const MODES_OFF = `${MOUSE_OFF}\x1b[?2004l`;
const RESTORE = `\x1b[0m${MODES_OFF}\x1b[?7h\x1b[?1049l\x1b[?25h`;
const ESCAPE_MS = 25;
const PASTE_MS = 2000;

// ---- the terminals screens are open on ----
//
// Screens are counted per input stream. The first one takes the terminal (alternate screen, raw mode)
// and the last one to close gives it back. A screen opened while another is open on the same terminal
// takes the input and the drawing over until it closes, then hands them back, so two never read the
// same keys and the inner one cannot drop the outer one out of full-screen mode.

interface Layer { release(): void; reclaim(): void; close(): void }
interface Terminal { out: NodeJS.WriteStream; inp: NodeJS.ReadStream; wasRaw: boolean; layers: Layer[] }
const terminals = new WeakMap<object, Terminal>();
const live = new Set<Terminal>();
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const;

function restoreTerminal(t: Terminal): void {
  try { t.inp.setRawMode?.(t.wasRaw); } catch { /* the terminal may be gone (SIGHUP) */ }
  try { t.out.write(RESTORE); } catch { /* likewise */ }
}

// Whatever ends the process, leave the terminal usable: a normal exit or a crash runs this.
const onExit = () => { for (const t of live) restoreTerminal(t); };

// A signal kills the process without an exit event, so it is caught: the terminal is given back, then
// the signal is raised again with nobody listening, which ends the process as it would have. When some
// other code listens for the signal too (the plain run view stops its agents on SIGINT), it is theirs.
const onSignal = (sig: NodeJS.Signals) => {
  if (process.listenerCount(sig) > 1) return;
  for (const t of [...live]) for (const l of [...t.layers]) { try { l.close(); } catch { /* keep going */ } }
  unwatch();
  process.kill(process.pid, sig);
};
const signalHandlers = new Map<NodeJS.Signals, () => void>(SIGNALS.map((sig) => [sig, () => onSignal(sig)]));

function watch(): void {
  process.on('exit', onExit);
  for (const [sig, fn] of signalHandlers) process.on(sig, fn);
}

function unwatch(): void {
  process.off('exit', onExit);
  for (const [sig, fn] of signalHandlers) process.off(sig, fn);
}

export function openScreen(out: NodeJS.WriteStream = process.stdout, inp: NodeJS.ReadStream = process.stdin, opts: ScreenOptions = {}): Screen {
  let prev: string[] = [];
  let keyHandler: (k: Key) => void = () => {};
  let mouseHandler: (m: Mouse) => void = () => {};
  let resizeHandler: () => void = () => {};
  const decoder = createInputDecoder();
  let closed = false;
  let attached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held = 0;
  let mouseOn = Boolean(opts.mouse);

  // Input is delivered one event at a time, in the order it came. The first event of a read is handled
  // at once; the rest wait for setImmediate, which runs after every pending promise continuation. A key
  // that closes a dialog has its answer applied in such a continuation, so a key typed right behind it
  // (in the same read) sees the result: Ctrl-S right after Enter saves what was entered. Held input (an
  // ESC, a paste) joins the same queue, so nothing overtakes what came before it.
  const queue: InputEvent[] = [];
  let pumping = false;
  const pump = () => {
    const e = queue.shift();
    if (!e || !attached) { pumping = false; queue.length = 0; return; }
    pumping = true;
    try {
      if (e.type === 'key') keyHandler(e.key);
      else mouseHandler(e.mouse);
    } finally {
      if (queue.length) setImmediate(pump);
      else pumping = false;
    }
  };
  const dispatch = (events: InputEvent[]) => {
    queue.push(...events);
    if (!pumping) pump();
  };
  // What a read cut short waits a moment for the next read; then it is taken as it stands. The give-up
  // runs after the event loop has read whatever input is already waiting (I/O comes before setImmediate),
  // so the rest of a sequence queued behind a slow key handler still joins up instead of being typed.
  const wait = () => {
    const mine = ++held;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const what = decoder.holding();
    if (!what) return;
    timer = setTimeout(() => {
      timer = undefined;
      setImmediate(() => { if (attached && held === mine) dispatch(decoder.flush()); });
    }, what === 'escape' ? opts.escapeMs ?? ESCAPE_MS : opts.pasteMs ?? PASTE_MS);
    timer.unref?.();
  };
  const onData = (buf: Buffer | string) => {
    const events = decoder(buf.toString());
    wait();
    dispatch(events);
  };
  const onResize = () => { prev = []; out.write('\x1b[2J'); resizeHandler(); };
  const attach = () => {
    if (attached) return;
    attached = true;
    inp.on('data', onData);
    out.on('resize', onResize);
  };
  const detach = () => {
    if (!attached) return;
    attached = false;
    inp.off('data', onData);
    out.off('resize', onResize);
    if (timer) clearTimeout(timer);
    timer = undefined;
    held++;
  };
  // This screen's own modes, for when it takes over from or back from another screen on the terminal.
  const modes = () => `\x1b[?25l\x1b[?7l\x1b[2J\x1b[H${opts.paste === false ? '\x1b[?2004l' : '\x1b[?2004h'}${mouseOn ? MOUSE_ON : MOUSE_OFF}`;

  const known = terminals.get(inp);
  const term: Terminal = known ?? { out, inp, wasRaw: Boolean(inp.isRaw), layers: [] };
  if (known) known.layers.at(-1)?.release();
  else {
    terminals.set(inp, term);
    live.add(term);
    if (live.size === 1) watch();
  }
  const layer: Layer = {
    release: detach,
    reclaim: () => { if (closed) return; out.write(modes()); prev = []; attach(); resizeHandler(); },
    close: () => screen.close(),
  };
  term.layers.push(layer);

  out.write(known ? modes() : `\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H${opts.paste === false ? '' : '\x1b[?2004h'}${opts.mouse ? MOUSE_ON : ''}`);
  inp.setRawMode?.(true);
  inp.resume();
  inp.setEncoding('utf8');
  attach();

  const screen: Screen = {
    get rows() { return Math.max(1, out.rows ?? 24); },
    get cols() { return Math.max(1, out.columns ?? 80); },
    paint(lines, cursor) {
      // Closed, or covered by a screen opened over it on the same terminal.
      if (closed || !attached) return;
      const { rows, cols } = screen;
      let buf = '\x1b[?25l';
      for (let r = 0; r < rows; r++) {
        const line = cell(lines[r] ?? '', cols) + '\x1b[0m';
        if (prev[r] === line) continue;
        buf += `\x1b[${r + 1};1H${line}`;
        prev[r] = line;
      }
      prev.length = rows;
      if (cursor) buf += `\x1b[${Math.max(1, Math.min(rows, cursor.row + 1))};${Math.max(1, Math.min(cols, cursor.col + 1))}H\x1b[?25h`;
      out.write(buf);
    },
    onKey(fn) { keyHandler = fn; },
    onMouse(fn) { mouseHandler = fn; },
    onResize(fn) { resizeHandler = fn; },
    setMouse(on) {
      if (closed || on === mouseOn) return;
      mouseOn = on;
      if (attached) out.write(on ? MOUSE_ON : MOUSE_OFF);
    },
    close() {
      if (closed) return;
      closed = true;
      detach();
      const i = term.layers.indexOf(layer);
      if (i >= 0) term.layers.splice(i, 1);
      if (term.layers.length) {
        // Another screen is still open on this terminal: the one now on top gets it back.
        if (i === term.layers.length) term.layers.at(-1)!.reclaim();
        return;
      }
      terminals.delete(inp);
      live.delete(term);
      if (!live.size) unwatch();
      term.inp.setRawMode?.(term.wasRaw);
      term.inp.pause();
      term.out.write(`\x1b[0m${MODES_OFF}\x1b[?7h\x1b[2J\x1b[H\x1b[?1049l\x1b[?25h`);
    },
  };
  return screen;
}
