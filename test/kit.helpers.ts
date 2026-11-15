// Shared helpers for the kit and app tests (not a test file itself).
import assert from 'node:assert/strict';
import chalk from 'chalk';
import type { Key, Mouse, Screen } from '../src/tui/screen.ts';
import { glyphs } from '../src/tui/theme.ts';
import { width } from '../src/tui/text.ts';

export const g = glyphs('unicode');
export const plain = (s: string): string => s.replace(/\x1b\[[0-9;:]*m/g, '');
export const text = (lines: string[]): string => lines.map(plain).join('\n');

/** From the degenerate to the roomy. */
export const SIZES: Array<[number, number]> = [[1, 1], [1, 6], [2, 3], [3, 12], [4, 9], [5, 20], [8, 30], [12, 44], [24, 80], [40, 120]];

/** Exactly rows × cols cells, single-line rows, and no escapes but SGR styles. */
export function assertFrame(lines: string[], rows: number, cols: number, label = ''): void {
  assert.equal(lines.length, rows, `${label} ${cols}x${rows}: ${lines.length} rows`);
  for (const line of lines) {
    assert.equal(width(line), cols, `${label} ${cols}x${rows}: row is ${width(line)} wide: ${JSON.stringify(plain(line))}`);
    assert.doesNotMatch(plain(line), /[\r\n\x1b\x07]/, `${label} ${cols}x${rows}: control characters`);
  }
}

/** Run with truecolour styles on (tests otherwise run colourless). */
export function withColour<T>(fn: () => T): T {
  const level = chalk.level;
  chalk.level = 3;
  try { return fn(); } finally { chalk.level = level; }
}

export const key = (name: string, ch?: string): Key => (ch === undefined ? { name } : { name, ch }) as Key;
export const ch = (c: string): Key => ({ name: 'char', ch: c });
export const press = (row: number, col: number): Mouse => ({ kind: 'press', button: 'left', row, col, shift: false, alt: false, ctrl: false });
export const wheel = (dir: 'up' | 'down', row = 0, col = 0): Mouse => ({ kind: dir === 'up' ? 'wheel-up' : 'wheel-down', button: 'none', row, col, shift: false, alt: false, ctrl: false });

export interface FakeScreen {
  screen: Screen;
  key(k: Key): void;
  type(s: string): void;
  mouse(m: Mouse): void;
  resize(rows: number, cols: number): void;
  readonly lines: string[];
  readonly cursor: { row: number; col: number } | undefined;
  readonly closed: number;
  readonly text: string;
}

/** A Screen that records frames. `factory()` makes a fresh one each call (for suspend/resume). */
export function fakeScreens(rows = 24, cols = 80) {
  const made: FakeScreen[] = [];
  const size = { rows, cols };
  const make = (): FakeScreen => {
    let keyFn = (_k: Key) => {};
    let mouseFn = (_m: Mouse) => {};
    let resizeFn = () => {};
    let lines: string[] = [];
    let cursor: { row: number; col: number } | undefined;
    let closed = 0;
    const screen: Screen = {
      get rows() { return size.rows; },
      get cols() { return size.cols; },
      paint(l, c) { if (closed) throw new Error('painted after close'); lines = l; cursor = c; },
      onKey(fn) { keyFn = fn; },
      onMouse(fn) { mouseFn = fn; },
      onResize(fn) { resizeFn = fn; },
      close() { closed++; },
    };
    const fake: FakeScreen = {
      screen,
      key: (k) => keyFn(k),
      type: (s) => { for (const c of s) keyFn({ name: 'char', ch: c }); },
      mouse: (m) => mouseFn(m),
      resize: (r, c) => { size.rows = r; size.cols = c; resizeFn(); },
      get lines() { return lines; },
      get cursor() { return cursor; },
      get closed() { return closed; },
      get text() { return text(lines); },
    };
    made.push(fake);
    return fake;
  };
  return { factory: () => make().screen, made, get current() { return made.at(-1)!; } };
}
