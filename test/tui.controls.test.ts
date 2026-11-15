// Live controls as dialogs: stopping a card still takes the typed word, instructions are a multi-line
// dialog, a paused run is unmistakable, help lists what works now, and keys never leak between a
// dialog and the board. Ctrl-C inside a dialog cancels the dialog; outside one it stops the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ch, key, plain } from './kit.helpers.ts';
import { agent, board, card, find, rig, viewState } from './tui.helpers.ts';
import { render } from '../src/tui/view.ts';

test('stopping a card takes the typed word in a dialog; a wrong word keeps it open, Esc and Ctrl-C cancel it', () => {
  const r = rig();
  try {
    r.s.key(ch('x'));
    assert.match(r.text(), /Stop c1/);
    assert.match(r.text(), /Card c1/, 'the card it stops, as a fact');
    r.s.key(key('enter'));
    assert.deepEqual(r.stopped, [], 'Enter alone stops nothing');
    r.s.type('stp');
    r.s.key(key('enter'));
    assert.match(r.text(), /Stop c1/, 'a wrong word keeps it open');
    assert.deepEqual(r.stopped, []);
    r.s.key(key('ctrl', 'c'));
    assert.doesNotMatch(r.text(), /Stop c1/);
    assert.equal(r.interrupts, 0, 'Ctrl-C closed the dialog, not the run');
    r.s.key(ch('x'));
    r.s.key(key('escape'));
    assert.deepEqual(r.stopped, []);
    r.s.key(ch('x'));
    r.s.type('stop');
    r.s.key(key('enter'));
    assert.deepEqual(r.stopped, ['c1']);
    assert.match(r.text(), /Stopping c1/, 'and says it did');
  } finally { r.tui.close(); }
});

test('a card that cannot stop or take instructions says its state instead of asking', () => {
  const r = rig({ board: board([card('c1', 'done'), card('c2', 'replaced')]) });
  try {
    r.s.key(ch('x'));
    assert.match(r.text(), /c1 done/);
    assert.doesNotMatch(r.text(), /Type stop/);
    r.s.key(ch('i'));
    assert.match(r.text(), /c1 done/);
  } finally { r.tui.close(); }
});

test('instructions are a multi-line dialog: Alt-Enter adds a line, Enter saves, nothing typed saves nothing', () => {
  const r = rig();
  try {
    r.s.key(ch('i'));
    assert.match(r.text(), /Instruct c1/);
    r.s.key(key('enter'));
    assert.deepEqual(r.guided, [], 'an empty dialog saves nothing');
    r.s.key(ch('i'));
    r.s.type('keep the API');
    r.s.key(key('alt-enter'));
    r.s.type('pause first');
    assert.equal(r.pauses, 0, 'typing p in the dialog is text, not pause');
    r.s.key({ name: 'paste', text: '\nand a test' });
    r.s.key(key('enter'));
    assert.deepEqual(r.guided, ['c1:keep the API\npause first\nand a test']);
    assert.match(r.text(), /Saved for c1/);
  } finally { r.tui.close(); }
});

test('the controls follow the agents pane: x and i act on the selected agent\'s card', () => {
  const agents = [agent('a1', { cardId: 'c1', state: 'running' }), agent('a2', { cardId: 'c2', state: 'running' })];
  const r = rig({ agents });
  try {
    r.s.key(key('tab'));
    assert.match(r.bar(), /x stop/);
    r.s.key(key('down'));
    r.s.key(ch('x'));
    assert.match(r.text(), /Stop c2/);
    r.s.type('stop');
    r.s.key(key('enter'));
    assert.deepEqual(r.stopped, ['c2']);
  } finally { r.tui.close(); }
});

test('a paused run shows a pill in the header, and the footer offers resume', () => {
  const r = rig();
  try {
    assert.doesNotMatch(r.s.lines[0]!, /paused/);
    r.s.key(ch('p'));
    assert.equal(r.pauses, 1);
    r.tui.update();
    assert.match(r.text().split('\n')[0]!, /‖ paused/);
    assert.match(r.bar(), /‖ paused.*p resume/);
    r.s.key(ch('p'));
    r.tui.update();
    assert.doesNotMatch(r.text().split('\n')[0]!, /paused/);
  } finally { r.tui.close(); }
});

test('the header shows the cards done of all of them as a bar, and the failed ones', () => {
  const r = rig({ rows: 30, cols: 120, board: board([card('c1', 'done'), card('c2', 'failed'), card('c3', 'in_progress'), card('c4', 'replaced')]) });
  try {
    assert.match(r.text().split('\n')[0]!, /━+╌+ 1\/3 ✗1/, 'replaced cards do not count');
  } finally { r.tui.close(); }
});

test('help lists every key that works now, and only those', () => {
  const r = rig({ rows: 40, cols: 120 });
  try {
    r.s.key(ch('?'));
    // Help scrolls: read every page of it.
    let seen = r.text();
    for (let i = 0; i < 6; i++) { r.s.key(key('pagedown')); seen += r.text(); }
    for (const want of ['Board', 'Agents', 'Log', 'Panes', 'Run', 'pause new cards', 'stop (type stop)', 'instruct next attempt', 'stop agents, save board', 'scrolls the pane', 'its work and worktree are kept']) {
      assert.ok(seen.replace(/\s+/g, ' ').includes(want), want);
    }
    r.s.key(key('escape'));
    r.s.key(key('enter'));
    r.s.key(key('f1'));
    assert.match(r.text(), /Open card/, 'an open card adds its keys');
    r.s.key(ch('q'));
  } finally { r.tui.close(); }
  const quiet = rig({ rows: 40, cols: 120, controls: false, mouse: false });
  try {
    quiet.s.key(ch('?'));
    assert.doesNotMatch(quiet.text(), /pause new cards|scrolls the pane/, 'no controls, no mouse: not listed');
  } finally { quiet.tui.close(); }
});

test('a paste outside a prompt is never taken as keys, and Ctrl-C outside a dialog stops the run', () => {
  const r = rig();
  try {
    r.s.key({ name: 'paste', text: 'pxi' });
    assert.equal(r.pauses, 0);
    assert.doesNotMatch(r.text(), /Stop c1|Instruct c1/);
    r.s.key(key('ctrl', 'c'));
    assert.equal(r.interrupts, 1);
  } finally { r.tui.close(); }
});

test('closing the view answers an open dialog as dismissed', async () => {
  const r = rig();
  r.s.key(ch('x'));
  r.s.type('stop');
  const approved = r.tui.approve({ title: 'Approve', message: 'm', items: [{ command: 'echo hi' }], word: 'yes', prompt: 'Type yes', confirm: 'Run', cancel: 'Drop' });
  r.tui.close();
  assert.equal(await approved, false);
  assert.deepEqual(r.stopped, [], 'the stop dialog under it did not stop the card either');
  assert.equal(r.s.closed, 1);
});

test('instructions for a card that finished while they were typed are not claimed as saved', () => {
  const b = board([card('c1', 'in_progress'), card('c2', 'in_progress')]);
  const r = rig({ board: b });
  try {
    r.s.key(ch('i'));
    r.s.type('use the API');
    b.cards[0]!.status = 'done';
    r.s.key(key('enter'));
    assert.deepEqual(r.guided, [], 'nothing was handed on');
    const said = r.text().replace(/[\s▌]+/g, ' ');
    assert.match(said, /c1 done: not saved/);
    assert.doesNotMatch(r.text(), /Saved for c1/);
  } finally { r.tui.close(); }
});

test('a frame that cannot be drawn says so instead of ending the process, and Ctrl-C still stops the run', () => {
  let broken = false;
  const b = board([card('c1', 'in_progress')]);
  const r = rig({ board: b });
  try {
    // A board that throws while it is read: the view's timer and keys must not crash on it.
    Object.defineProperty(b, 'cards', { get: () => { if (broken) throw new Error('board went away'); return [card('c1', 'in_progress')]; } });
    broken = true;
    assert.doesNotThrow(() => r.tui.update());
    assert.match(r.text(), /✗ board went away/);
    assert.doesNotThrow(() => r.s.key(key('ctrl', 'c')));
    assert.equal(r.interrupts, 1);
    broken = false;
    r.tui.update();
    assert.doesNotMatch(r.text(), /board went away/, 'and it draws again once it can');
  } finally { r.tui.close(); }
});

test('stopping a card that has not started names what else will not start, and the dialog closes when the card moves on', () => {
  const b = board([card('c1', 'in_progress'), card('c2', 'backlog'), card('c3', 'backlog', { dependsOn: ['c2'] })]);
  const r = rig({ board: b, rows: 30, cols: 100 });
  const flat = () => r.text().replace(/[\s│▌]+/g, ' ');
  try {
    r.s.key(ch('x'));
    assert.match(flat(), /Stop c2/, 'the first backlog card is selected');
    assert.match(flat(), /Card c2 · not started/, 'the card, and that it has not started');
    assert.match(flat(), /c3 will not start either/, 'the one consequence nobody would see');
    b.cards[1]!.status = 'in_progress';
    r.tui.update();
    assert.doesNotMatch(flat(), /Stop c2/, 'it started meanwhile: the dialog is gone rather than wrong');
    assert.match(flat(), /c2 started/);
    r.s.key(ch('x'));
    assert.match(flat(), /Stop c2/);
    assert.doesNotMatch(flat(), /not started/, 'a running card has no consequence line');
    b.cards[1]!.status = 'done';
    r.tui.update();
    assert.doesNotMatch(flat(), /Stop c2/);
    assert.match(flat(), /c2 done/);
    r.s.type('stop');
    r.s.key(key('enter'));
    assert.deepEqual(r.stopped, [], 'the word typed afterwards stopped nothing');
  } finally { r.tui.close(); }
});

test('a stopped card says so on the board instead of counting attempts', () => {
  const r = rig({ board: board([card('c1', 'failed', { stopped: true, reason: 'Stopped by user; retry this card to continue.' }), card('c2', 'failed', { attempts: 2 })]), rows: 30, cols: 120 });
  try {
    assert.match(r.text(), /│ stopped /, 'one word where the reason sentence was');
    assert.doesNotMatch(r.text(), /Stopped by user/);
    assert.match(r.text(), /2 rounds/);
    assert.doesNotMatch(r.text(), /0 attempts/);
  } finally { r.tui.close(); }
});

test('the header keeps some of the goal when paused at 80 columns, and shows an amount without a second dollar sign', () => {
  const b = board([card('c1', 'in_progress'), card('c2', 'backlog'), card('c3', 'backlog')], { runId: '20261115-0226-4049', goal: 'Build the board walkthrough four', paused: true, costUsd: 0.05, usage: { input: 5000, cacheRead: 0, cacheWrite: 0, output: 0 } });
  for (const cols of [80, 120]) {
    const header = plain(render(viewState(b, { rows: 24, cols, phase: 'running', now: 3000 })).lines[0]!);
    assert.match(header, /paused/);
    assert.match(header, /Build the/, `${cols}: ${header}`);
    assert.match(header, /\$0\.05/);
    assert.doesNotMatch(header, /\$ \$/, `${cols}: ${header}`);
  }
});

test('toasts sit at the top right of the first pane, not over the bottom rows the person reads', () => {
  const r = rig({ rows: 30, cols: 100 });
  try {
    for (let i = 0; i < 40; i++) r.tui.note(`log line ${i}`);
    r.s.key(ch('x'));
    r.s.type('stop');
    r.s.key(key('enter'));
    const at = find(r.s.lines, 'Stopping c1')!;
    assert.ok(at && at.row <= 3, `the toast is near the top: row ${at?.row}`);
    assert.match(plain(r.s.lines.at(-2)!), /log line 39/, 'the newest log line is not covered');
  } finally { r.tui.close(); }
});
