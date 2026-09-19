import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTui } from '../src/tui/tui.ts';
import { pager } from '../src/tui/pager.ts';
import type { Screen, Key } from '../src/tui/screen.ts';
import { width } from '../src/tui/text.ts';
import type { Board } from '../src/types.ts';
function mockScreen() {
  let key = (_k: Key) => {}; let resize = () => {}; let closed = 0; let lines: string[] = [];
  const screen: Screen = { rows: 20, cols: 80, paint(frame) { lines = frame; }, onKey(fn) { key = fn; }, onResize(fn) { resize = fn; }, close() { closed++; } };
  return { screen, key: (k: Key) => key(k), resize: () => resize(), get closed() { return closed; }, get lines() { return lines; } };
}
const board: Board = { runId: 'ui', goal: 'test', baseRef: 'abc', baseBranch: 'main', runBranch: 'dulger/ui', createdAt: new Date().toISOString(), costUsd: 0, cards: [{ id: 'c1', title: 'Card', description: '', dependsOn: [], acceptanceCriteria: [], verify: [], tasks: [], status: 'in_progress', attempts: 0, feedback: [], costUsd: 0 }] };
test('live controls require stop confirmation, cancel independently and never consume prompt typing', async () => {
  const mock = mockScreen(); const stopped: string[] = []; const guidance: string[] = []; let pauses = 0; let interrupts = 0;
  const tui = createTui({ screen: mock.screen, getBoard: () => board, getAgents: () => [], icons: 'ascii', onInterrupt() { interrupts++; }, controls: { togglePause() { pauses++; return true; }, stopCard(id) { stopped.push(id); }, guideCard(id, text) { guidance.push(`${id}:${text}`); } } });
  try {
    tui.setPhase('running'); mock.key({ name: 'char', ch: 'p' }); assert.equal(pauses, 1);
    mock.key({ name: 'char', ch: 'x' }); mock.key({ name: 'ctrl', ch: 'c' }); assert.deepEqual(stopped, []); assert.equal(interrupts, 0);
    mock.key({ name: 'char', ch: 'x' }); for (const ch of 'stop') mock.key({ name: 'char', ch }); mock.key({ name: 'enter' }); assert.deepEqual(stopped, ['c1']);
    mock.key({ name: 'char', ch: 'i' }); for (const ch of 'keep API') mock.key({ name: 'char', ch }); mock.key({ name: 'enter' }); assert.deepEqual(guidance, ['c1:keep API']);
    const answer = tui.ask('plan', 'reply'); for (const ch of 'pix') mock.key({ name: 'char', ch }); mock.key({ name: 'enter' }); assert.equal(await answer, 'pix'); assert.equal(pauses, 1);
  } finally { tui.close(); }
  assert.equal(mock.closed, 1);
});
test('pager scrolls and reflows long diffs, strips control sequences and restores terminal once', async () => {
  const mock = mockScreen();
  const pending = pager('Diff', Array.from({ length: 100 }, (_, i) => `line ${i} ${'wide '.repeat(20)}`).join('\n') + '\x1b[2J', mock.screen);
  mock.key({ name: 'end' }); assert.ok(mock.lines.join('\n').includes('line 99'));
  mock.screen.cols = 30; mock.screen.rows = 8; mock.resize();
  assert.equal(mock.lines.length, 8); assert.ok(mock.lines.every((s) => width(s) <= 30));
  assert.ok(!mock.lines.join('\n').includes('\x1b[2J'));
  mock.key({ name: 'escape' }); mock.key({ name: 'escape' }); await pending;
  assert.equal(mock.closed, 1);
});
