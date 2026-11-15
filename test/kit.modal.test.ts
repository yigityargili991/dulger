import { test } from 'node:test';
import assert from 'node:assert/strict';
import { c, glyphs } from '../src/tui/theme.ts';
import { width } from '../src/tui/text.ts';
import {
  badge, breadcrumb, busyModal, confirmModal, createToasts, emptyState, helpModal, hintBar, keyHint, nextExpiry, paletteModal, pickerModal, pill,
  placeModal, progress, promptModal, pruneToasts, pushToast, renderToasts, scrollbar, spinnerFrame, viewerModal, type Modal,
} from '../src/tui/kit/index.ts';
import { disabledReason } from '../src/tui/kit/palette.ts';
import { SIZES, assertFrame, ch, g, key, plain, press, text, wheel, withColour } from './kit.helpers.ts';

const page = (rows: number, cols: number) => Array.from({ length: rows }, (_, i) => `page row ${i} `.repeat(20).slice(0, cols));

function every<T>(make: () => Modal<T>, label: string): void {
  for (const set of ['nerd', 'unicode', 'ascii'] as const) {
    for (const [rows, cols] of SIZES) {
      const m = make();
      const box = m.render({ rows, cols }, glyphs(set), 1000);
      assert.ok(box.lines.length <= rows, `${label} ${cols}x${rows}: box taller than the screen`);
      for (const l of box.lines) assert.ok(width(l) <= cols, `${label} ${cols}x${rows}: box wider than the screen`);
      const placed = placeModal(page(rows, cols), box, { rows, cols }, m.placement);
      assertFrame(placed.lines, rows, cols, `${label} ${set}`);
      if (placed.cursor) assert.ok(placed.cursor.row < rows && placed.cursor.col < cols, `${label} cursor at ${cols}x${rows}`);
    }
  }
}

test('every modal fits every size and glyph set', () => {
  every(() => confirmModal({ title: 'Delete run r12', message: 'Delete run r12, its worktrees and branches? This cannot be undone.', danger: true, confirm: 'Delete' }), 'confirm');
  every(() => confirmModal({ title: 'Stop', message: 'Stop card c3?', typed: 'stop' }), 'typed');
  every(() => promptModal({ title: 'Goal', message: 'Describe it.', value: '日本語 '.repeat(20) }), 'prompt');
  every(() => promptModal({ title: 'Notes', multiline: true, value: 'a\nb\nc' }), 'multiline');
  every(() => pickerModal({ title: 'Model', options: Array.from({ length: 30 }, (_, i) => ({ value: `m${i}`, label: `model ${i}`, meta: 'claude' })) }), 'picker');
  every(() => viewerModal({ title: 'diff', text: '+a\n-b\n'.repeat(50), diff: true }), 'viewer');
  every(() => busyModal('Asking the endpoint…', 0), 'busy');
  every(() => paletteModal([{ id: 'a', title: 'Go to Settings', group: 'Navigation', shortcut: '3', description: 'Open the settings tab' }]), 'palette');
  every(() => helpModal([{ title: 'Page', keys: [{ key: '↑↓', label: 'move' }] }, { title: 'Everywhere', keys: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, label: `thing ${i}` })) }]), 'help');
});

test('placeModal dims the page and centres the box', () => withColour(() => {
  const m = confirmModal({ title: 'T', message: 'Sure?' });
  const placed = placeModal(page(24, 80), m.render({ rows: 24, cols: 80 }, g, 0), { rows: 24, cols: 80 });
  assert.ok(placed.rect.top > 0 && placed.rect.left > 0);
  assert.ok(placed.lines[0]!.startsWith(c.faint('\0').split('\0')[0]!), 'the page behind is faint');
}));

test('confirm: the safe choice has the focus; y/n, arrows, Esc; danger; clicks', () => {
  const m = confirmModal({ title: 'Merge', message: 'Merge r12?', confirm: 'Merge' });
  assert.equal(m.state.focus, 'cancel');
  assert.match(text(m.render({ rows: 24, cols: 80 }, g, 0).lines), /\[ Cancel \]\s+Merge/, 'without colour the focused button is bracketed');
  assert.deepEqual(m.key(key('enter')), { value: false }, 'Enter on the default answer is the safe one');
  const m2 = confirmModal({ title: 'Merge', message: 'Merge r12?' });
  m2.key(key('right'));
  assert.deepEqual(m2.key(key('enter')), { value: true });
  assert.deepEqual(confirmModal({ title: 't', message: 'm' }).key(ch('y')), { value: true });
  assert.deepEqual(confirmModal({ title: 't', message: 'm' }).key(ch('n')), { value: false });
  assert.deepEqual(confirmModal({ title: 't', message: 'm' }).key(key('escape')), { value: false });
  assert.deepEqual(confirmModal({ title: 't', message: 'm' }).key(key('ctrl', 'c')), { value: false });
  const m3 = confirmModal({ title: 'Merge', message: 'Merge r12?' });
  m3.render({ rows: 24, cols: 80 }, g, 0);
  const yes = m3.state.buttons.find((b) => b.id === 'confirm')!;
  assert.deepEqual(m3.mouse!(press(yes.row, yes.from + 1)), { value: true });
  const risky = confirmModal({ title: 'Delete', message: 'Gone for good.', danger: true });
  assert.equal(risky.key(ch('y')), undefined, 'one stray y never confirms a danger dialog');
  assert.equal(risky.key(ch('Y')), undefined);
  assert.deepEqual(risky.key(ch('n')), { value: false }, 'n still cancels it');
  withColour(() => {
    const danger = confirmModal({ title: 'Delete', message: 'Gone for good.', danger: true }).render({ rows: 24, cols: 80 }, g, 0);
    assert.ok(danger.lines[0]!.startsWith(c.bad('\0').split('\0')[0]!), 'a danger dialog has a red border');
  });
});

test('confirm with a typed word: only the exact word confirms', () => {
  const m = confirmModal({ title: 'Stop card c3', message: 'Completed work is kept.', typed: 'stop' });
  assert.match(text(m.render({ rows: 24, cols: 80 }, g, 0).lines), /│  Type stop\s+│/, 'the word to type, and nothing more');
  assert.equal(m.key(ch('y')), undefined, 'y is just a letter here');
  m.key(key('backspace'));
  for (const x of 'sto') m.key(ch(x));
  assert.equal(m.key(key('enter')), undefined);
  assert.match(text(m.render({ rows: 24, cols: 80 }, g, 0).lines), /! Type stop/, 'a wrong word repeats the word, as an error');
  m.key(ch('p'));
  assert.ok(m.render({ rows: 24, cols: 80 }, g, 0).cursor, 'the word is typed at a cursor');
  assert.deepEqual(m.key(key('enter')), { value: true });
});

test('prompt: Enter submits, validation keeps it open with a message, Esc cancels, multi-line', () => {
  const m = promptModal({ title: 'Goal', validate: (v) => (v.length < 3 ? 'Too short.' : undefined) });
  m.key(ch('a'));
  assert.equal(m.key(key('enter')), undefined);
  assert.match(text(m.render({ rows: 24, cols: 80 }, g, 0).lines), /Too short\./);
  m.key(ch('b'));
  assert.doesNotMatch(text(m.render({ rows: 24, cols: 80 }, g, 0).lines), /Too short/, 'typing clears the message');
  m.key({ name: 'paste', text: 'c\nd' });
  assert.deepEqual(m.key(key('enter')), { value: 'abc d' }, 'a pasted newline did not submit');
  assert.deepEqual(promptModal({ title: 't' }).key(key('escape')), { value: undefined });
  const multi = promptModal({ title: 'Notes', multiline: true });
  multi.key(ch('a'));
  multi.key(key('alt-enter'));
  multi.key({ name: 'paste', text: 'b\nc' });
  assert.deepEqual(multi.key(key('enter')), { value: 'a\nb\nc' });
  const secret = promptModal({ title: 'Key', secret: true });
  for (const x of 'hunter2') secret.key(ch(x));
  assert.doesNotMatch(text(secret.render({ rows: 24, cols: 80 }, g, 0).lines), /hunter2/);
});

test('picker: the filter line shows once something is typed, or when the options do not fit', () => {
  const few = pickerModal({ title: 'Retry', options: [{ value: 'c2', label: 'c2' }, { value: 'c4', label: 'c4' }] });
  const shown = () => text(few.render({ rows: 24, cols: 80 }, g, 0).lines);
  assert.doesNotMatch(shown(), /⌕/, 'two options need no search line');
  few.key(ch('4'));
  assert.match(shown(), /⌕ 4/, 'typing still filters, and shows what was typed');
  assert.deepEqual(few.key(key('enter')), { value: ['c4'] });
  const many = pickerModal({ title: 'Model', options: Array.from({ length: 40 }, (_, i) => ({ value: `m${i}`, label: `model-${i}` })) });
  assert.match(text(many.render({ rows: 24, cols: 80 }, g, 0).lines), /⌕/, 'a list longer than the box has it from the start');
});

test('prompt fields show their extent without colour, and a multi-line area grows with its text', () => {
  const p = promptModal({ title: 'Stop', placeholder: 'stop' });
  const row = () => plain(p.render({ rows: 24, cols: 80 }, g, 0).lines.find((l) => l.includes('['))!);
  assert.match(row(), /│ {2}\[\(stop\)\s+\] {2}│/, 'brackets, the way buttons become [ … ]');
  p.key(ch('s'));
  const r = p.render({ rows: 24, cols: 80 }, g, 0);
  assert.match(plain(r.lines[r.cursor!.row]!).slice(r.cursor!.col - 2, r.cursor!.col), /\[s/, 'the cursor is after what was typed, inside the brackets');
  assert.doesNotMatch(withColour(() => text(p.render({ rows: 24, cols: 80 }, g, 0).lines)), /\[s/, 'with colour the background shows it');
  const m = promptModal({ title: 'Reply', multiline: true, placeholder: 'reply' });
  const tall = () => m.render({ rows: 40, cols: 100 }, g, 0).lines.length;
  const small = tall();
  for (let i = 0; i < 4; i++) { m.key(ch('x')); m.key(key('alt-enter')); }
  assert.ok(tall() > small, `grows with the text: ${small} → ${tall()}`);
  for (let i = 0; i < 20; i++) { m.key(ch('x')); m.key(key('alt-enter')); }
  assert.equal(tall(), small + 5, 'up to eight rows, then it scrolls');
});

test('picker: filter, single and multi, Esc clears the filter before cancelling, clicks', () => {
  const options = ['haiku', 'sonnet', 'opus', 'gpt-5.6-sol', 'gpt-6-astra', 'qwen3:8b', 'deepseek-flash', 'llama3'].map((v) => ({ value: v, label: v }));
  const m = pickerModal({ title: 'Model', options, selected: 'opus' });
  assert.deepEqual(m.key(key('enter')), { value: ['opus'] }, 'starts on the current value');
  const f = pickerModal({ title: 'Model', options });
  for (const x of 'gpt6') f.key(ch(x));
  assert.deepEqual(f.key(key('enter')), { value: ['gpt-6-astra'] });
  const e = pickerModal({ title: 'Model', options });
  e.key(ch('z'));
  assert.equal(e.key(key('escape')), undefined, 'the first Esc clears the filter');
  assert.deepEqual(e.key(key('escape')), { value: undefined });
  const multi = pickerModal({ title: 'Cards', options: options.slice(0, 3), multi: true });
  multi.key(ch(' '));
  multi.key(key('ctrl', 'n'));
  multi.key(ch(' '));
  assert.deepEqual(multi.key(key('enter')), { value: ['haiku', 'sonnet'] });
  const none = pickerModal({ title: 'Cards', options: options.slice(0, 3), multi: true });
  none.key(key('down'));
  assert.deepEqual(none.key(key('enter')), { value: ['sonnet'] }, 'with nothing checked, the highlighted one');
  const click = pickerModal({ title: 'Cards', options: options.slice(0, 3) });
  click.render({ rows: 24, cols: 80 }, g, 0);
  const at = click.state.listAt!;
  const third = at.row + click.state.list.offset + 2;
  assert.equal(click.mouse!(press(third, at.col + 3)), undefined, 'the first click selects');
  assert.deepEqual(click.mouse!(press(third, at.col + 3)), { value: ['opus'] }, 'the second picks');
  // Every picker filters as the person types, however few its options.
  const few = pickerModal({ title: 'Backend', options: ['fake', 'claude', 'codex'].map((v) => ({ value: v, label: v })), selected: 'fake' });
  for (const x of 'claude') few.key(ch(x));
  assert.deepEqual(few.key(key('enter')), { value: ['claude'] });
});

test('viewer: scrolls, wraps, closes', () => {
  const m = viewerModal({ title: 'Report', text: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') });
  const first = text(m.render({ rows: 24, cols: 80 }, g, 0).lines);
  assert.match(first, /line 0/);
  assert.match(first, /1-\d+\/200/);
  m.key(key('pagedown'));
  m.mouse!(wheel('down'));
  assert.doesNotMatch(text(m.render({ rows: 24, cols: 80 }, g, 0).lines), /line 0\b/);
  m.key(ch('w'));
  assert.equal(m.state.scroll.wrap, false);
  assert.deepEqual(m.key(ch('q')), { value: undefined });
});

test('busy: a spinner with the elapsed time that ignores keys', () => {
  const m = busyModal('Saving…', 0);
  assert.equal(m.key(key('escape')), undefined);
  assert.equal(m.animating!(), true);
  assert.match(text(m.render({ rows: 24, cols: 80 }, g, 3200).lines), /Saving… 3s/);
  assert.notEqual(spinnerFrame(g, 0), spinnerFrame(g, 80));
});

test('palette: fuzzy filtering over title, group and description; Enter returns the id', () => {
  const m = paletteModal([
    { id: 'go:settings', title: 'Go to Settings', group: 'Navigation', shortcut: '3' },
    { id: 'go:runs', title: 'Go to Runs', group: 'Navigation', shortcut: '2' },
    { id: 'resume', title: 'Resume latest run', group: 'Runs', description: 'continue where it stopped' },
    { id: 'off', title: 'Disabled thing', disabled: true },
  ]);
  assert.equal(m.placement, 'top');
  for (const x of 'gtset') m.key(ch(x));
  assert.match(text(m.render({ rows: 24, cols: 80 }, g, 0).lines), /❯ Navigation: Go to Settings\s+3/);
  assert.deepEqual(m.key(key('enter')), { value: 'go:settings' });
  const d = paletteModal([{ id: 'resume', title: 'Resume latest run', description: 'continue where it stopped' }, { id: 'x', title: 'Other' }]);
  for (const x of 'continue') d.key(ch(x));
  assert.deepEqual(d.key(key('enter')), { value: 'resume' }, 'descriptions are searched');
  const off = paletteModal([{ id: 'off', title: 'Disabled', disabled: true }]);
  assert.deepEqual(off.key(key('enter')), { value: 'off' }, 'a disabled command is chosen: the app says why and does not run it');
  assert.equal(disabledReason({ id: 'off', title: 'Disabled', disabled: true }), 'Not available now.');
  assert.equal(disabledReason({ id: 'ok', title: 'Fine' }), undefined);
  assert.deepEqual(off.key(key('ctrl', 'p')), { value: undefined }, 'Ctrl-P again closes it');
});

test('help: groups in two columns when wide, scrolls when tall, closes on ? Esc q', () => {
  const groups = [{ title: 'Runs', keys: [{ key: 'enter', label: 'open' }, { key: 'r', label: 'resume' }] }, { title: 'Everywhere', keys: [{ key: '?', label: 'help' }] }];
  const wide = text(helpModal(groups).render({ rows: 24, cols: 120 }, g, 0).lines);
  assert.match(wide, /Runs\s+Everywhere/, 'two columns');
  const narrow = text(helpModal(groups).render({ rows: 24, cols: 50 }, g, 0).lines);
  assert.doesNotMatch(narrow, /Runs\s+Everywhere/);
  const long = helpModal([{ title: 'Many', keys: Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, label: `l${i}` })) }]);
  long.render({ rows: 12, cols: 50 }, g, 0);
  long.key(key('pagedown'));
  assert.doesNotMatch(text(long.render({ rows: 12, cols: 50 }, g, 0).lines), /k0 /);
  for (const k of [ch('?'), key('escape'), ch('q'), key('f1')]) assert.deepEqual(helpModal(groups).key(k), { value: undefined });
});

test('toasts expire by the clock passed in, stack newest last, and repeat instead of piling up', () => {
  const t = createToasts();
  pushToast(t, 'Saved', 'ok', 0);
  pushToast(t, 'The endpoint did not answer', 'error', 100);
  assert.equal(nextExpiry(t), 3000);
  const shown = renderToasts(t, 60, 10, g, 200);
  assert.equal(shown.length, 2);
  assert.match(plain(shown[1]!), /✗ The endpoint did not answer/);
  assert.equal(new Set(shown.map((l) => width(l))).size, 1, 'one width for the whole stack');
  assert.equal(pruneToasts(t, 3001), true);
  assert.equal(t.items.length, 1);
  assert.equal(pruneToasts(t, 3002), false);
  pushToast(t, 'The endpoint did not answer', 'error', 5000);
  assert.equal(t.items.length, 1, 'the same message again just stays longer');
  assert.equal(t.items[0]!.until, 13000);
  assert.deepEqual(renderToasts(t, 60, 10, g, 20000), []);
  for (const [rows, cols] of SIZES) {
    const many = createToasts();
    for (let i = 0; i < 6; i++) pushToast(many, `message ${i} ${'long '.repeat(i * 3)}`, 'warn', 0);
    const out = renderToasts(many, cols, rows, g, 1);
    assert.ok(out.length <= rows);
    for (const l of out) assert.ok(width(l) <= Math.max(cols, 16) && (cols < 8 || width(l) <= cols));
  }
});

test('bits: pills and badges, progress, scrollbar, key hints, breadcrumbs, empty states', () => {
  assert.equal(pill('done', 'ok'), '[done]', 'without colour a pill is bracketed');
  assert.equal(badge('12'), '(12)');
  withColour(() => assert.equal(plain(pill('done', 'ok')), ' done '));
  assert.equal(plain(progress(0.5, 20, g)), '━━━━━━━━╌╌╌╌╌╌╌  50%');
  assert.equal(width(progress(2, 9, g)), 9);
  assert.equal(width(progress(NaN, 3, g)), 3);
  assert.deepEqual(scrollbar(3, 0, 3, 3, g), [' ', ' ', ' ']);
  assert.equal(scrollbar(4, 0, 8, 4, g).map(plain).join(''), '┃┃││');
  const bar = hintBar(' left ', [{ key: 'a', label: 'first' }, { key: 'b', label: 'second' }, { key: 'c', label: 'third' }], 30);
  assert.equal(width(bar), 30);
  assert.match(plain(bar), /a first\s+b second\s+$/, 'hints that do not fit are dropped from the end, whole');
  assert.doesNotMatch(plain(bar), /third|thi/);
  assert.equal(plain(keyHint('q', 'quit')), ' q quit ');
  assert.equal(plain(breadcrumb(['Runs', 'r12', 'diff'], g, 40)), 'Runs › r12 › diff');
  assert.equal(plain(breadcrumb(['Runs', 'r12', 'last part'], g, 19)), '… › r12 › last part', 'cut from the left so the current place stays');
  assert.ok(width(breadcrumb(['Runs', 'r12', 'a long last part'], g, 10)) <= 10);
  for (const [rows, cols] of SIZES) assertFrame(emptyState({ rows, cols }, { title: 'No runs yet', message: 'Type a goal on the Home tab to start one.', hint: 'Press 1' }, g), rows, cols, 'empty');
  const e = text(emptyState({ rows: 8, cols: 60 }, { title: 'No runs yet', message: 'Type a goal on the Home tab.', hint: 'Press 1' }, g));
  assert.match(e, /No runs yet/, 'an empty state is its title');
  assert.doesNotMatch(e, /Type a goal|Press 1|∅/, 'and nothing under it');
});

test('buttons: a compact form, and a row that shrinks its padding, then wraps, so no button falls off', async () => {
  const { button, buttonRow } = await import('../src/tui/kit/index.ts');
  assert.equal(button('Delete', true, false, true), '[Delete]');
  assert.equal(button('Delete', false, false, true), ' Delete ');
  const five = ['Close', 'Dispatch', 'Revise', 'Edit plan', 'Cancel run'].map((label, i) => ({ label, focused: i === 1 }));
  const wide = buttonRow(five, 80);
  assert.equal(wide.lines.length, 1);
  assert.match(plain(wide.lines[0]!), /^\s+Close\s{2,}\[ Dispatch \]/);
  const narrow = buttonRow(five, 40);
  assert.ok(narrow.lines.length >= 2, 'wrapped');
  for (const l of narrow.lines) assert.ok(width(l) <= 40);
  assert.equal(narrow.hits.length, 5, 'every button has a place');
  assert.match(text(narrow.lines), /Cancel run/);
  const tight = buttonRow(five.slice(0, 3), 34);
  assert.equal(tight.lines.length, 1, 'compact padding first');
  assert.match(plain(tight.lines[0]!), /\[Dispatch\]/);
});

test('confirm: paragraphs, a list, a preformatted detail and a note; a body taller than the box scrolls; typed has no placeholder', () => {
  const m = confirmModal({ title: 'Save', message: 'First paragraph.\n\nSecond one.', detail: 'npm test -- --grep "a b" | tail -n 50', items: [{ label: 'Backend', value: 'claude → fake' }, 'A plain item'], note: 'Nothing else changes.', confirm: 'Save' });
  const shown = text(m.render({ rows: 24, cols: 80 }, g, 0).lines);
  assert.match(shown, /First paragraph\.\s+│\n│\s+│\n│\s+Second one\./, 'the blank line between paragraphs stays');
  assert.match(shown, /npm test -- --grep "a b" \| tail -n 50/);
  assert.match(shown, /· Backend\s+claude → fake/);
  assert.match(shown, /· A plain item/);
  assert.match(shown, /Nothing else changes\./);
  const long = confirmModal({ title: 'Discard', message: 'Put these back:', items: Array.from({ length: 40 }, (_, i) => ({ label: `Setting ${i}`, value: String(i) })), confirm: 'Discard', danger: true });
  const first = text(long.render({ rows: 20, cols: 80 }, g, 0).lines);
  assert.match(first, /↑↓ 1-\d+\/\d+/);
  assert.match(first, /Cancel \]\s+Discard/, 'the buttons always show');
  long.key(key('pagedown'));
  long.key(key('pagedown'));
  long.key(key('pagedown'));
  assert.match(text(long.render({ rows: 20, cols: 80 }, g, 0).lines), /Setting 39/);
  long.mouse!(wheel('up'));
  assert.equal(long.key(ch('y')), undefined, 'a danger confirm is not answered by y');
  long.key(key('right'));
  assert.deepEqual(long.key(key('enter')), { value: true }, 'its button, focused, and Enter answer it');
  const typed = confirmModal({ title: 'Stop', message: 'Stop it?', typed: 'stop' });
  assert.equal(typed.state.input!.placeholder, '', 'no placeholder: without colour it would read as typed');
  for (const [rows, cols] of SIZES) {
    const r = long.render({ rows, cols }, g, 0);
    assert.ok(r.lines.length <= rows && r.lines.every((l) => width(l) <= cols), `${cols}x${rows}`);
  }
});

test('notice: in the kit, several actions, line breaks kept, the primary one focused', async () => {
  const { noticeModal } = await import('../src/tui/kit/index.ts');
  const m = noticeModal({ title: 'Cannot start', message: 'Two things:\nFIX one\nFIX two', tone: 'warn', actions: [{ id: 'fix', label: 'Open Doctor', primary: true }, { id: 'go', label: 'Start anyway' }] });
  const shown = text(m.render({ rows: 24, cols: 80 }, g, 0).lines);
  assert.match(shown, /Two things:\s+│\n│\s+FIX one/);
  assert.match(shown, /Close\s+\[ Open Doctor \]\s+Start anyway/);
  assert.deepEqual(m.key(key('enter')), { value: 'fix' });
  m.key(key('right'));
  assert.deepEqual(m.key(key('enter')), { value: 'go' });
  assert.deepEqual(m.key(key('escape')), { value: undefined });
});

test('picker: names and a short tag, no description strip or key hints; an explicit empty multi-selection', () => {
  const m = pickerModal({ title: 'Backend', options: [
    { value: 'claude', label: 'claude', meta: 'current', description: 'The Claude Code CLI, with its own login and model choices; costs are reported in dollars.' },
    { value: 'fake', label: 'fake', description: 'A local demo: canned work, no model calls.' },
  ] });
  const first = text(m.render({ rows: 24, cols: 80 }, g, 0).lines);
  assert.match(first, /❯ claude\s+current/, 'the name and its tag');
  assert.doesNotMatch(first, /Claude Code CLI|local demo|select|esc cancel/, 'no descriptions, no key hints');
  const none = pickerModal({ title: 'Wait for', options: [{ value: 'c1', label: 'c1' }, { value: 'c2', label: 'c2' }], multi: true, allowNone: true });
  assert.deepEqual(none.key(key('enter')), { value: [] }, 'nothing checked: nothing chosen');
  for (const [rows, cols] of SIZES) {
    const r = m.render({ rows, cols }, g, 0);
    assert.ok(r.lines.length <= rows && r.lines.every((l) => width(l) <= cols), `${cols}x${rows}`);
  }
});

test('help: one column with wrapped descriptions when two columns would cut them', () => {
  const groups = [
    { title: 'Selected run', keys: [{ key: 'v', label: 'review: report, files, verification and the merge, after a confirmation' }, { key: 'r', label: 'resume (saved settings)' }] },
    { title: 'Everywhere', keys: [{ key: '?', label: 'help' }] },
  ];
  const at80 = text(helpModal(groups).render({ rows: 24, cols: 80 }, g, 0).lines);
  assert.doesNotMatch(at80, /Selected run\s+Everywhere/, 'one column');
  assert.doesNotMatch(at80, /…/, 'nothing cut');
  assert.match(at80, /review: report, files, verification and the merge, after a/);
  assert.match(text(helpModal(groups).render({ rows: 24, cols: 40 }, g, 0).lines), /confirmation/, 'wrapped under itself when narrow');
});

test('palette: a disabled command is dimmed, never first, says why when highlighted and when chosen; title matches rank above descriptions', () => {
  const m = paletteModal([
    { id: 'merge', title: 'Merge into main', group: 'Review', disabled: 'Not now: the run changed nothing.' },
    { id: 'resume', title: 'Resume the run', group: 'Review', shortcut: 'r', description: 'Continue where it stopped.' },
    { id: 'quiet', title: 'Go to Quiet output', group: 'Settings', description: 'Print one line per card, not the full-screen view.' },
    { id: 'line', title: 'Open the line prompt', group: 'App' },
    { id: 'plan', title: 'Plan together', group: 'Home', description: 'Talk the plan through with the planner first.' },
  ]);
  const shown = () => text(m.render({ rows: 24, cols: 80 }, g, 0).lines);
  assert.match(shown(), /❯ Review: Resume the run/, 'the first enabled command is selected, not the disabled one above it');
  assert.equal(m.key(key('up')), undefined);
  assert.match(shown(), /❯ Review: Merge into main/, 'the arrows can rest on it');
  assert.doesNotMatch(shown(), /Not now|Continue where it stopped/, 'no reasons or descriptions on the palette');
  assert.deepEqual(m.key(key('enter')), { value: 'merge' }, 'choosing it hands it back; the app says why (disabledReason) instead of running it');
  m.key(key('down'));
  for (const x of 'line') m.key(ch(x));
  assert.match(shown(), /❯ App: Open the line prompt[\s\S]*Settings: Go to Quiet output/, 'a title match ranks above a description match');
  assert.deepEqual(m.key(key('enter')), { value: 'line' });
  const loose = paletteModal([{ id: 'plan', title: 'Plan together', group: 'Home', description: 'Talk the plan through with the planner first.' }]);
  for (const x of 'allow') loose.key(ch(x));
  assert.match(text(loose.render({ rows: 24, cols: 80 }, g, 0).lines), /No matches/, 'descriptions match by words, not scattered letters');
});

test('dialog errors and picker messages are wrapped whole, long words broken across rows rather than cut', () => {
  const path = '/tmp/claude-1000/-home-yigit-yargili-Documents-dev-dulger/90e96d89-2999-481c-ae1e-e174c4b22d83/scratchpad/walk/data';
  const squeeze = (lines: string[]) => plain(lines.join('')).replace(/[\s│╭╮╰╯─]/g, '');
  const p = promptModal({ title: 'Name', validate: () => `Cannot write ${path}: permission denied` });
  p.key(ch('x'));
  p.key(key('enter'));
  assert.ok(squeeze(p.render({ rows: 24, cols: 60 }, g, 0).lines).includes(`Cannotwrite${path}:permissiondenied`.replace(/\s/g, '')));
  const pick = pickerModal({ title: 'Retry', message: `The retry uses the settings the run started with, not this session's (they differ in harness and model routing). Its worktrees are in ${path}.`, options: [{ value: 'a', label: 'c1' }] });
  assert.ok(squeeze(pick.render({ rows: 24, cols: 70 }, g, 0).lines).includes(`notthissession's(theydifferinharnessandmodelrouting).Itsworktreesarein${path}.`));
});
