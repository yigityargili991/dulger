import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select, renderSelect, type SelectOptions } from '../src/tui/select.ts';
import type { Screen, Key } from '../src/tui/screen.ts';
import { width } from '../src/tui/text.ts';
const options: SelectOptions = { title: 'Choose harness', description: 'Pick a backend.', choices: [
  { value: 'claude', label: 'Claude Code', description: 'Local CLI' },
  { value: 'codex', label: 'Codex', description: 'Another CLI' },
  { value: 'fake', label: 'Fake', description: 'No model calls' },
] };
function screen() {
  let key = (_k: Key) => {};
  let resize = () => {};
  let closed = 0;
  let lines: string[] = [];
  const s: Screen = { rows: 24, cols: 80, paint(frame) { lines = frame; }, onKey(fn) { key = fn; }, onResize(fn) { resize = fn; }, close() { closed++; } };
  return { s, key: (k: Key) => key(k), resize: () => resize(), get closed() { return closed; }, get lines() { return lines; } };
}

test('keyboard selection starts on the current value and restores the terminal once', async () => {
  const mock = screen();
  const result = select({ ...options, selected: 'codex' }, mock.s);
  mock.key({ name: 'down' });
  mock.key({ name: 'enter' });
  mock.key({ name: 'enter' });
  assert.equal(await result, 'fake');
  assert.equal(mock.closed, 1);
});

test('filtering, no matches, clear, back and cancellation are distinct', async () => {
  const mock = screen();
  const result = select(options, mock.s);
  for (const ch of 'xyz') mock.key({ name: 'char', ch });
  assert.match(mock.lines.join(''), /No matches/);
  mock.key({ name: 'enter' });
  assert.equal(mock.closed, 0);
  mock.key({ name: 'ctrl', ch: 'u' });
  mock.key({ name: 'char', ch: 'c' });
  mock.key({ name: 'char', ch: 'o' });
  mock.key({ name: 'char', ch: 'd' });
  mock.key({ name: 'char', ch: 'e' });
  mock.key({ name: 'char', ch: 'x' });
  mock.key({ name: 'enter' });
  assert.equal(await result, 'codex');
  for (const [key, expected] of [[{ name: 'escape' }, undefined], [{ name: 'ctrl', ch: 'c' }, null], [{ name: 'ctrl', ch: 'd' }, null]] as const) {
    const m = screen(); const pending = select(options, m.s); m.key(key); assert.equal(await pending, expected); assert.equal(m.closed, 1);
  }
});

test('scrolling and resize keep the focused option visible', async () => {
  const mock = screen();
  const choices = Array.from({ length: 100 }, (_, i) => ({ value: String(i), label: `Model ${i}` }));
  const result = select({ ...options, choices }, mock.s);
  mock.key({ name: 'end' });
  assert.match(mock.lines.join(''), /Model 99/);
  mock.s.rows = 8; mock.s.cols = 30; mock.resize();
  assert.equal(mock.lines.length, 8);
  assert.match(mock.lines.join(''), /Model 99/);
  mock.key({ name: 'pageup' });
  mock.key({ name: 'enter' });
  assert.equal(await result, '98');
});

test('menu frames fit tiny and narrow terminals and sanitize provider text', () => {
  const injection = '\x1b[2J\x1b]52;c;data\x07';
  const choices = [{ value: 'first', label: `模型 ${'very long '.repeat(25)}${injection}`, description: 'Remote model' }];
  for (const rows of [1, 2, 5, 10, 12, 24]) for (const cols of [1, 8, 30, 80]) {
    const lines = renderSelect({ ...options, title: `Title${injection}`, choices }, choices, 0, '', rows, cols);
    assert.equal(lines.length, rows, `${cols}x${rows}`);
    for (const line of lines) { assert.ok(width(line) <= cols); assert.ok(!line.includes('\x1b[2J') && !line.includes('\x1b]52;')); }
  }
});
