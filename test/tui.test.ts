import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys } from '../src/tui/screen.ts';
import { cell, fit, spread, width, wrap } from '../src/tui/text.ts';
import { createEditor, edit, submit } from '../src/tui/editor.ts';
import { columns, render, type ViewState } from '../src/tui/view.ts';
import { glyphs, resolveIcons } from '../src/tui/theme.ts';
import type { AgentStatus, Board, Card } from '../src/types.ts';

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('parseKeys: sequences, control keys and multi-byte characters', () => {
  assert.deepEqual(parseKeys('\x1b[A\x1b[D'), [{ name: 'up' }, { name: 'left' }]);
  assert.deepEqual(parseKeys('\x1b'), [{ name: 'escape' }]);
  assert.deepEqual(parseKeys('\x03'), [{ name: 'ctrl', ch: 'c' }]);
  assert.deepEqual(parseKeys('\r'), [{ name: 'enter' }]);
  assert.deepEqual(parseKeys('\x7f'), [{ name: 'backspace' }]);
  assert.deepEqual(parseKeys('\x1b[Z'), [{ name: 'shift-tab' }]);
  assert.deepEqual(parseKeys('aé😀'), [{ name: 'char', ch: 'a' }, { name: 'char', ch: 'é' }, { name: 'char', ch: '😀' }]);
  assert.deepEqual(parseKeys('\x1b[99z'), [], 'unknown sequences are dropped, not typed');
});

test('fit and cell respect escapes and wide characters', () => {
  assert.equal(width('\x1b[31mab\x1b[0m'), 2);
  assert.equal(plain(fit('hello world', 6)), 'hello…');
  assert.equal(fit('hi', 6), 'hi');
  assert.equal(width(fit('\x1b[1m日本語テキスト\x1b[0m', 7)), 7);
  assert.equal(width(cell('x', 5)), 5);
  assert.equal(width(cell('a'.repeat(9), 5)), 5);
  assert.equal(width(spread('left', 'right', 20)), 20);
  assert.equal(plain(spread('left', 'right', 20)).endsWith('right'), true);
});

test('wrap breaks on words and caps the line count', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  const capped = wrap('one two three four five six', 9, 2);
  assert.equal(capped.length, 2);
  assert.ok(capped[1]!.endsWith('…'));
});

test('editor: typing, cursor keys, kill keys and history', () => {
  const history: string[] = ['older', 'newest'].reverse();
  const e = createEditor(history);
  for (const ch of 'hello') edit(e, { name: 'char', ch });
  edit(e, { name: 'left' });
  edit(e, { name: 'char', ch: 'X' });
  assert.equal(e.text, 'hellXo');
  edit(e, { name: 'backspace' });
  assert.equal(e.text, 'hello');
  edit(e, { name: 'ctrl', ch: 'a' });
  edit(e, { name: 'ctrl', ch: 'k' });
  assert.equal(e.text, '');
  edit(e, { name: 'up' });
  assert.equal(e.text, 'newest');
  edit(e, { name: 'up' });
  assert.equal(e.text, 'older');
  edit(e, { name: 'down' });
  edit(e, { name: 'down' });
  assert.equal(e.text, '', 'past the newest entry the draft comes back');
  for (const ch of 'go') edit(e, { name: 'char', ch });
  assert.equal(edit(e, { name: 'enter' }), 'submit');
  assert.equal(submit(e), 'go');
  assert.equal(history[0], 'go');
  assert.equal(e.text, '');
});

function card(id: string, status: Card['status'], extra: Partial<Card> = {}): Card {
  return { id, title: `Card ${id}`, description: 'does things', acceptanceCriteria: ['works'], dependsOn: [], status, attempts: 0, feedback: [], costUsd: 0,
    tasks: [{ id: 't1', cardId: id, title: 'task', instructions: '', status: status === 'done' ? 'done' : 'pending', attempts: 0 }], ...extra };
}

function board(cards: Card[]): Board {
  return { runId: 'r1', goal: 'a goal', baseRef: 'x', baseBranch: 'master', runBranch: 'dulger/r1', createdAt: '', cards, costUsd: 0 };
}

function state(b: Board, over: Partial<ViewState> = {}): ViewState {
  return { board: b, agents: [], notes: [], startedAt: 0, now: 1000, rows: 30, cols: 100, g: glyphs('unicode'), phase: 'running', openScroll: 0, logScroll: 0, focus: 'board', ...over };
}

test('columns hide the failed column until something lands in it', () => {
  assert.deepEqual(columns(board([card('c1', 'backlog')])).map((c) => c.title), ['BACKLOG', 'IN PROGRESS', 'REVIEW', 'DONE']);
  assert.deepEqual(columns(board([card('c1', 'failed')])).map((c) => c.title), ['BACKLOG', 'IN PROGRESS', 'REVIEW', 'DONE', 'FAILED']);
});

test('render fills the screen exactly and puts the cursor on the prompt', () => {
  const b = board([card('c1', 'backlog'), card('c2', 'in_progress'), card('c3', 'done')]);
  const f = render(state(b));
  assert.equal(f.lines.length, 30);
  for (const l of f.lines) assert.ok(width(l) <= 100, `line too wide: ${plain(l)}`);
  const text = f.lines.map(plain).join('\n');
  assert.match(text, /BACKLOG 1/);
  assert.match(text, /c2 Card c2/);
  assert.equal(f.cursor, undefined);

  const withPrompt = render(state(b, { prompt: { label: 'order', text: 'abc', cursor: 3, hint: 'h' }, focus: 'input' }));
  assert.ok(withPrompt.cursor);
  assert.equal(withPrompt.cursor!.row, 28, 'prompt sits above the bottom bar');
  assert.match(plain(withPrompt.lines[28]!), /order › abc/);
});

test('render shows the open card with its tasks and the agent history', () => {
  const b = board([card('c1', 'in_progress', { feedback: ['fix the tests'] })]);
  const a: AgentStatus = { id: 'a1', role: 'worker', harness: 'fake', cardId: 'c1', taskId: 't1', state: 'running', turns: 3, history: ['Read foo.ts', 'thinking'], startedAt: 0 };
  const text = render(state(b, { agents: [a], open: 'c1', selected: 'c1' })).lines.map(plain).join('\n');
  assert.match(text, /Acceptance/);
  assert.match(text, /t1 task/);
  assert.match(text, /fix the tests/);
  assert.match(text, /Read foo\.ts/);
});

test('resolveIcons: the environment wins, then the preference, then the terminal', () => {
  const saved = { ...process.env };
  try {
    process.env.DULGER_ICONS = 'ascii';
    assert.equal(resolveIcons('nerd'), 'ascii');
    delete process.env.DULGER_ICONS;
    assert.equal(resolveIcons('unicode'), 'unicode');
    process.env.TERM_PROGRAM = 'ghostty';
    assert.equal(resolveIcons('auto'), 'nerd');
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    process.env.TERM = 'xterm-256color';
    assert.equal(resolveIcons('auto'), 'unicode');
  } finally {
    process.env = saved;
  }
});

test('readReply: assent dispatches, a few words cancel, anything else revises', async () => {
  const { readReply } = await import('../src/commands.ts');
  assert.deepEqual(readReply(''), { kind: 'go' });
  assert.deepEqual(readReply('  GO '), { kind: 'go' });
  assert.deepEqual(readReply('y'), { kind: 'go' });
  assert.deepEqual(readReply('cancel'), { kind: 'cancel' });
  assert.deepEqual(readReply('drop'), { kind: 'cancel' });
  assert.deepEqual(readReply('go with raylib instead'), { kind: 'revise', text: 'go with raylib instead' });
  assert.deepEqual(readReply(' yes, but add tests '), { kind: 'revise', text: 'yes, but add tests' });
});
