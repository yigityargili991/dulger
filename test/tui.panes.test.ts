// The panes of the run view: Tab moves focus between the board, the agents and the log, a focused
// pane scrolls and zooms, the log follows its tail until the person scrolls up, the open card reads as
// sections with a scrollbar, and the mouse scrolls and clicks where it points. Every frame is exactly
// rows × cols, whatever is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/tui/view.ts';
import { SIZES, assertFrame, ch, fakeScreens, key, plain, press, wheel } from './kit.helpers.ts';
import { agent, board, card, find, rig, viewState } from './tui.helpers.ts';
import { createTui } from '../src/tui/tui.ts';

/** The pane with the keyboard: without colour its heading carries the pointer; the board has no heading. */
const focusOf = (lines: string[]) => (lines.some((l) => /─── ❯ agents/.test(plain(l))) ? 'agents' : lines.some((l) => /─── ❯ log/.test(plain(l))) ? 'log' : 'board');
/** The row of the first line matching `re`, plain. */
const rowOf = (lines: string[], re: RegExp) => { const i = lines.findIndex((l) => re.test(plain(l))); return i < 0 ? undefined : i; };
const LOG = /─── (❯ )?log/;

test('Tab moves focus from the board to the agents to the log and round; Shift-Tab goes back', () => {
  const r = rig({ rows: 30, cols: 130, agents: [agent('a1', { cardId: 'c1' })] });
  try {
    assert.equal(focusOf(r.s.lines), 'board', 'the board has focus first');
    assert.match(r.bar(), /⏎ open/);
    r.s.key(key('tab'));
    assert.equal(focusOf(r.s.lines), 'agents');
    assert.match(r.bar(), /⏎ card/);
    r.s.key(key('tab'));
    assert.equal(focusOf(r.s.lines), 'log');
    assert.match(r.bar(), /↑↓ scroll/);
    r.s.key(key('tab'));
    assert.equal(focusOf(r.s.lines), 'board');
    r.s.key(key('shift-tab'));
    assert.equal(focusOf(r.s.lines), 'log', 'back to the log');
  } finally { r.tui.close(); }
});

test('z zooms the focused pane to full height and Esc brings the others back', () => {
  const r = rig({ rows: 30, cols: 100, agents: [agent('a1', { cardId: 'c1' })] });
  try {
    for (let i = 0; i < 5; i++) r.tui.note(`line ${i}`);
    r.s.key(key('tab')); r.s.key(key('tab'));
    r.s.key(ch('z'));
    const log = rowOf(r.s.lines, LOG);
    assert.ok(log !== undefined && log <= 2, 'the log heading moved to the top');
    assert.equal(find(r.s.lines, 'agents '), undefined, 'the agents pane made room');
    assert.equal(find(r.s.lines, 'BACKLOG'), undefined, 'and so did the board');
    r.s.key(key('tab'));
    assert.ok(find(r.s.lines, 'BACKLOG'), 'Tab moves the zoom with the focus');
    assert.equal(rowOf(r.s.lines, LOG), undefined);
    r.s.key(key('escape'));
    assert.ok(find(r.s.lines, 'BACKLOG') && rowOf(r.s.lines, LOG) && find(r.s.lines, 'agents'), 'all panes are back');
  } finally { r.tui.close(); }
});

test('the zoomed log wraps every line whole; scrolled up it stays put while lines arrive, and End follows again', () => {
  const r = rig({ rows: 20, cols: 60 });
  try {
    const long = `card c1 rejected: ${'word '.repeat(40)}end-of-it`;
    r.tui.note(long);
    r.tui.note('first\nsecond line of the same entry');
    for (let i = 0; i < 30; i++) r.tui.note(`filler ${i}`);
    r.s.key(key('tab')); r.s.key(key('tab'));
    r.s.key(ch('z'));
    for (let i = 0; i < 40; i++) r.s.key(key('up'));
    const text = r.text();
    assert.match(text, /end-of-it/, 'nothing of the long line is cut');
    assert.equal((text.match(/word/g) ?? []).length, 40);
    assert.match(text, /\n\s+second line of the same entry/, 'an entry with several lines shows each');
    // The text, without the heading's count and the scrollbar column, which do change.
    const view = () => r.s.lines.slice(1, -1).map((l) => plain(l).replace(/▼\d+/, '').replace(/[┃│]$/, '')).join('\n');
    const shown = view();
    r.tui.note('a later line');
    r.tui.note('and another');
    assert.equal(view(), shown, 'the view did not move');
    assert.match(r.text(), /log .*▼\d+/, 'the heading counts what waits below');
    assert.match(r.bar(), /end follow/);
    r.s.key(key('end'));
    assert.match(r.text(), /and another/);
    assert.doesNotMatch(r.text(), /log .*▼\d/);
    r.tui.note('following again');
    assert.match(r.text(), /following again/, 'at the end it follows the tail');
  } finally { r.tui.close(); }
});

test('the agents pane lists every agent when zoomed, with what the selected one did lately', () => {
  const agents = Array.from({ length: 14 }, (_, i) => agent(`a${i + 1}`, { cardId: 'c1', taskId: 't1', history: [`a${i + 1} read src/file${i}.ts`, `a${i + 1} edited it`] }));
  const r = rig({ rows: 40, cols: 120, agents });
  try {
    r.s.key(key('tab'));
    r.s.key(ch('z'));
    for (const a of agents) assert.ok(find(r.s.lines, `${a.id} `), `${a.id} is listed`);
    assert.match(r.text(), /a14 edited it/, 'the newest agent is selected first, and its history shows');
    r.s.key(key('end'));
    assert.match(r.text(), /a1 read src\/file0\.ts/);
    r.s.key(key('enter'));
    assert.match(r.text(), /c1 Card c1/, 'Enter opens the agent\'s card');
  } finally { r.tui.close(); }
  const narrow = rig({ rows: 24, cols: 80, agents });
  try {
    narrow.s.key(key('tab'));
    narrow.s.key(ch('z'));
    assert.match(narrow.text(), /── .*a14 worker/, 'below the list on a narrow screen, under a rule');
  } finally { narrow.tui.close(); }
});

test('the open card reads as sections with a scrollbar: verify commands, activity, review; scrolling stops at the end', () => {
  const long = card('c1', 'in_progress', {
    acceptanceCriteria: Array.from({ length: 12 }, (_, i) => `criterion ${i}`),
    verify: ['npm test', `node -e "${'x'.repeat(90)}"`],
    verification: [{ command: 'npm test', ok: false, exitCode: 1, durationMs: 1200, output: '' }],
    feedback: ['make the tests pass'],
    guidance: ['keep the API'],
  });
  const agents = [agent('a1', { cardId: 'c1', taskId: 't1', state: 'running', history: ['Read greet.js', 'Edit greet.js'] })];
  const r = rig({ rows: 24, cols: 80, board: board([long]), agents });
  try {
    r.s.key(key('enter'));
    const top = r.text();
    assert.match(top, /c1 Card c1/);
    assert.match(top, /Instructions/);
    assert.match(top, /┃/, 'a scrollbar thumb');
    assert.match(top, /1-\d+\/\d+/, 'and where in the card the view is');
    let seen = top;
    for (let i = 0; i < 40; i++) { r.s.key(key('down')); seen += r.text(); }
    for (const want of ['Verify', 'exit 1 · 1.2s', 'Activity', 'Edit greet.js', 'Review', 'make the tests pass', 'x'.repeat(60)]) assert.ok(seen.includes(want), want);
    const bottom = r.text();
    r.s.key(key('up'));
    assert.notEqual(r.text(), bottom, 'past the end, one key back moves at once');
    r.s.key(key('escape'));
    assert.match(r.text(), /BACKLOG/);
  } finally { r.tui.close(); }
});

test('the mouse: the wheel scrolls the pane under the pointer, a click selects a card and a second opens it', () => {
  const r = rig({ rows: 30, cols: 100, board: board([card('c1', 'in_progress'), card('c2', 'in_progress')]) });
  try {
    for (let i = 0; i < 40; i++) r.tui.note(`entry ${i}`);
    const log = rowOf(r.s.lines, LOG)!;
    r.s.mouse(wheel('up', log + 2, 10));
    assert.match(r.text(), /log .*▼3/, 'the wheel scrolled the log, not the board');
    assert.match(r.text(), /❯ \S c1 Card c1/);
    const c2 = find(r.s.lines, 'c2 Card c2')!;
    r.s.mouse(press(c2.row, c2.col));
    assert.match(r.text(), /❯ \S c2 Card c2/, 'a click selects');
    assert.doesNotMatch(r.text(), /attempt 1/);
    r.s.mouse(press(c2.row, c2.col));
    assert.match(r.text(), /in progress · attempt 1/, 'a second click opens it');
    const agentsRow = find(r.s.lines, 'agents')!;
    r.s.mouse(press(agentsRow.row, 2));
    assert.equal(focusOf(r.s.lines), 'agents', 'a click on a pane gives it focus');
  } finally { r.tui.close(); }
});

test('with the mouse off, clicks and the wheel are left to the terminal', () => {
  const screens = fakeScreens(24, 80);
  const b = board([card('c1', 'in_progress'), card('c2', 'in_progress')]);
  const tui = createTui({ screen: screens.factory(), getBoard: () => b, getAgents: () => [], icons: 'unicode', onInterrupt: () => {}, mouse: false });
  try {
    tui.setPhase('running');
    const c2 = find(screens.current.lines, 'c2 Card c2')!;
    screens.current.mouse(press(c2.row, c2.col));
    screens.current.mouse(press(c2.row, c2.col));
    assert.doesNotMatch(screens.current.text, /attempt 1/);
  } finally { tui.close(); }
});

test('every frame is exactly rows × cols, whatever is open, zoomed or focused', () => {
  const b = board([card('c1', 'in_progress', { title: '日本語 👩‍💻 title\nsecond\x1b[2J', verify: ['npm test'] }), card('c2', 'failed'), card('c3', 'done')], { paused: true, rateLimits: { at: '', windows: [{ name: 'five_hour', utilization: 0.4 }] } });
  const agents = Array.from({ length: 12 }, (_, i) => agent(`a${i}`, { cardId: 'c1', state: i < 2 ? 'running' : 'done', history: ['x'.repeat(200)] }));
  const notes = Array.from({ length: 50 }, (_, i) => `12:00:0${i % 10}  note ${i} ${'y'.repeat(i * 3)}`);
  const states = [
    {}, { open: 'c1' }, { open: 'c1', zoom: 'board' as const }, { zoom: 'log' as const, focus: 'log' as const, logScroll: 7 },
    { zoom: 'agents' as const, focus: 'agents' as const, agentSel: 'a5' }, { focus: 'log' as const, logScroll: 1000 },
    { prompt: { label: 'approve', text: 'ye', cursor: 2, hint: 'type yes' }, focus: 'input' as const },
    { phase: 'revising' }, { controls: true, mouse: true },
  ];
  for (const [rows, cols] of [...SIZES, [16, 50] as [number, number], [60, 200] as [number, number]]) {
    for (const over of states) {
      const f = render(viewState(b, { rows, cols, agents, notes, selected: 'c1', ...over }));
      assertFrame(f.lines, rows, cols, JSON.stringify(Object.keys(over)));
      if (f.cursor) assert.ok(f.cursor.row < rows && f.cursor.col < cols);
    }
  }
});

test('a card opened from the agents pane hands the keys back to it when it closes, zoomed as it was', () => {
  const agents = [agent('a1', { cardId: 'c2', state: 'running' }), agent('a2', { cardId: 'c1', state: 'running' })];
  const r = rig({ agents, rows: 30, cols: 100 });
  try {
    r.s.key(key('tab'));
    r.s.key(key('enter'));
    assert.match(r.text(), /c2 Card c2/, 'the agent\'s card is open');
    r.s.key(key('escape'));
    assert.equal(focusOf(r.s.lines), 'agents', 'Esc: back on the agents pane');
    r.s.key(ch('z'));
    assert.match(r.bar(), /z unzoom/);
    assert.doesNotMatch(r.text(), /BACKLOG/, 'and z zooms the agents, not the board');
    r.s.key(key('enter'));
    r.s.key(key('enter'));
    assert.equal(focusOf(r.s.lines), 'agents', 'Enter closes it too, back to the zoomed agents');
    assert.doesNotMatch(r.text(), /BACKLOG/);
    r.s.key(key('escape'));
    // Opened from the board, a card goes back to the board.
    r.s.key(key('shift-tab'));
    r.s.key(key('enter'));
    r.s.key(key('escape'));
    assert.match(r.bar(), /⏎ open/);
  } finally { r.tui.close(); }
});
