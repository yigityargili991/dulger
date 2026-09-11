import { test } from 'node:test';
import assert from 'node:assert/strict';
import chalk from 'chalk';
import { parseKeys } from '../src/tui/screen.ts';
import { cell, fit, logLine, plainText, spread, width, wrap } from '../src/tui/text.ts';
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

test('logLine keeps the first line, marks the rest, fits the width and closes colours', () => {
  assert.equal(logLine('a\nb', 20), 'a …');
  assert.equal(logLine('only one line', 20), 'only one line');
  assert.equal(logLine('a\n\n', 20), 'a', 'blank continuation lines do not count');
  assert.equal(width(logLine('x'.repeat(50), 20)), 20);
  const coloured = logLine('\x1b[33mwarn\ndetail\x1b[0m', 20);
  assert.ok(coloured.endsWith('\x1b[0m'), 'a colour opened on line one is closed');
  assert.equal(plainText(coloured), 'warn …');
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
  return { id, title: `Card ${id}`, description: 'does things', acceptanceCriteria: ['works'], dependsOn: [], verify: [], status, attempts: 0, feedback: [], costUsd: 0,
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

test('responsive frames stay bounded across tiny, narrow, short and full viewports', () => {
  const b = board([card('c1', 'backlog', { title: '日本語 👩‍💻 title\nsecond line\x1b[2J' }), card('c2', 'failed')]);
  for (const rows of [1, 2, 3, 4, 5, 6, 8, 12, 15, 16, 24, 40]) {
    for (const cols of [1, 5, 12, 30, 60, 79, 80, 100, 160]) {
      for (const open of [undefined, 'c1']) {
        for (const prompt of [undefined, { label: 'a very long prompt label', text: 'hi日本語'.repeat(20), cursor: 100, hint: 'hint' }]) {
          const f = render(state(b, { rows, cols, open, prompt, focus: 'input', selected: 'c1', notes: ['a\nb\x1b[H'] }));
          assert.equal(f.lines.length, rows, `${cols}x${rows}`);
          for (const line of f.lines) {
            assert.ok(width(line) <= cols, `overflow at ${cols}x${rows}: ${plain(line)}`);
            assert.doesNotMatch(plain(line), /[\r\n\x1b]/);
          }
          if (prompt) {
            assert.ok(f.cursor);
            assert.ok(f.cursor.row >= 0 && f.cursor.row < rows);
            assert.ok(f.cursor.col >= 0 && f.cursor.col < cols, `${cols}x${rows} cursor ${f.cursor.col}`);
          }
        }
      }
    }
  }
  const compact = render(state(b, { rows: 12, cols: 40, selected: 'c2' })).lines.map(plain).join('\n');
  assert.match(compact, /c2/);
  assert.doesNotMatch(compact, /Resize to/);
});

test('external text loses its ANSI before app styles are applied', () => {
  const raw = '\x1b[32mhello\nworld\x1b[2J\x1b]0;bad title\x07\x1b[0m';
  const content = plainText(raw);
  assert.equal(content, 'hello world');
  const line = cell('\x1b[31m' + content + '\x1b[0m', 20);
  assert.equal(plain(line), 'hello world         ');
  assert.match(line, /\x1b\[31m/);
  assert.equal(width(line), 20);
});

test('compact board keyboard navigation follows the displayed list across statuses', async () => {
  const { createTui } = await import('../src/tui/tui.ts');
  const b = board([card('c1', 'backlog'), card('c2', 'done')]);
  let key: (key: import('../src/tui/screen.ts').Key) => void = () => {};
  let lines: string[] = [];
  const tui = createTui({ getBoard: () => b, getAgents: () => [], icons: 'ascii', onInterrupt: () => {}, screen: {
    rows: 12, cols: 40, paint: (frame) => { lines = frame; }, onKey: (fn) => { key = fn; }, onResize: () => {}, close: () => {},
  } });
  try {
    key({ name: 'down' }); key({ name: 'enter' });
    assert.match(lines.map(plain).join('\n'), /c2 Card c2/);
    assert.doesNotMatch(lines.map(plain).join('\n'), /c1 Card c1/);
  } finally { tui.close(); }
});

test('screen uses physical dimensions on resize, clips renderer output and restores terminal modes', async () => {
  const { EventEmitter } = await import('node:events');
  const { openScreen } = await import('../src/tui/screen.ts');
  let output = '';
  const out = Object.assign(new EventEmitter(), { rows: 4, columns: 8, write: (s: string) => { output += s; return true; } });
  const inp = Object.assign(new EventEmitter(), { isRaw: true, setRawMode: (raw: boolean) => { inp.isRaw = raw; }, resume: () => {}, pause: () => {}, setEncoding: () => {} });
  const screen = openScreen(out as unknown as NodeJS.WriteStream, inp as unknown as NodeJS.ReadStream);
  try {
    screen.paint([plainText('hello\nworld\x1b[2J')], { row: 20, col: 99 });
    assert.equal(screen.rows, 4);
    assert.equal(screen.cols, 8);
    assert.doesNotMatch(output.slice(output.indexOf('\x1b[H') + 3), /\n|\x1b\[2J/);
    assert.match(output, /\x1b\[4;8H/);
    out.rows = 2; out.columns = 3; out.emit('resize');
    output = '';
    screen.paint(['long row', 'another', 'invisible'], { row: 4, col: 6 });
    assert.equal(screen.rows, 2);
    assert.match(output, /\x1b\[2;3H/);
    assert.doesNotMatch(output, /invisible/);
  } finally { screen.close(); }
  assert.equal(inp.isRaw, true, 'restore the previous raw mode');
  assert.match(output, /\x1b\[\?7h/);
  const closed = output;
  screen.close(); screen.paint(['ignored']);
  assert.equal(output, closed);
});


test('plain text makes complete, partial and unknown terminal sequences inert', () => {
  for (const input of [
    '\x1b[31mred\x1b[0m', '\x1b[2Jclear', '\x1b]8;;https://example.com\x07link\x1b]8;;\x07',
    '\x1b]52;c;clipboard\x1b\\', '\x1bPpayload\x1b\\', '\x9b2J', '\x1b[31', '\x1b]unterminated',
    '\x1b_unknown\x1b\\', '\r\n\t\b\x00\x7f\x85',
  ]) {
    const clean = plainText(input);
    assert.doesNotMatch(clean, /\p{Cc}/u);
    assert.equal(plainText(clean), clean, 'sanitizing again does not change display text');
  }
  assert.equal(plainText('a   b\tc'), 'a   b c', 'keep editable spaces intact');
  assert.equal(plainText('日本語 e\u0301 👩‍💻'), '日本語 e\u0301 👩‍💻');
});

test('renderer strips external styling before adding its own, without changing board data', () => {
  const injected = '\x1b[8mcontent\x1b[0m\n\x1b[2J\x1b]52;c;payload\x07';
  const item = card('c1', 'in_progress', {
    title: injected, description: injected, acceptanceCriteria: [injected], review: injected,
    feedback: [injected], reviewNotes: [injected],
  });
  item.tasks[0]!.title = injected;
  const b = board([item]);
  b.goal = injected;
  const agent: AgentStatus = { id: 'a1', role: 'worker', harness: 'fake', model: injected, cardId: 'c1', taskId: 't1',
    state: 'running', turns: 1, history: [injected], lastMessage: injected, startedAt: 0 };
  const level = chalk.level;
  chalk.level = 3;
  try {
    for (const open of [undefined, 'c1']) {
      const frame = render(state(b, { rows: 60, cols: 120, open, agents: [agent], notes: [injected], phase: injected,
        prompt: { label: injected, text: 'a   b', cursor: 3, hint: injected }, focus: 'input' }));
      const styled = frame.lines.join('');
      assert.match(styled, /\x1b\[/, 'app colours are still present');
      assert.doesNotMatch(styled, /\x1b\[8m/, 'external conceal style is gone');
      assert.doesNotMatch(plain(styled), /\p{Cc}/u, 'only app-generated SGR sequences reach the screen');
      const prompt = plain(frame.lines[frame.cursor!.row]!);
      assert.equal(prompt[frame.cursor!.col], ' ', 'cursor remains inside the three editable spaces');
    }
  } finally { chalk.level = level; }
  assert.equal(item.title, injected, 'source data and logs keep their original content');
});
