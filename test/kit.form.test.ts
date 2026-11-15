import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glyphs } from '../src/tui/theme.ts';
import {
  createForm, fieldHelp, fieldOf, focusKey, focusedField, formCapturesText, formHints, formKey, formMouse, renderForm, setSections,
  type FormEvent, type FormSection,
} from '../src/tui/kit/index.ts';
import { SIZES, assertFrame, ch, g, key, plain, press, text } from './kit.helpers.ts';

function sections(): FormSection[] {
  return [
    { title: 'Session', description: 'Session only until saved.', fields: [
      { kind: 'choice', key: 'harness', label: 'Harness', value: 'claude', description: 'Which backend runs the agents.',
        options: [{ value: 'claude', description: 'Claude Code CLI' }, { value: 'codex' }, { value: 'fake' }] },
      { kind: 'number', key: 'concurrency', label: 'Concurrency', value: 3, min: 1, max: 8, description: 'Agents at once.' },
      { kind: 'toggle', key: 'docs', label: 'Docs agent', value: true },
      { kind: 'info', key: 'where', label: 'Config file', value: '.dulger/config.json' },
      { kind: 'toggle', key: 'locked', label: 'Locked', value: false, disabled: 'Set by your user config.' },
    ] },
    { title: 'Limits', fields: [
      { kind: 'number', key: 'budget', label: 'Budget', value: undefined, optional: true, prefix: '$', decimals: 2, step: 0.5, min: 0.5 },
      { kind: 'text', key: 'url', label: 'Base URL', value: 'https://x', validate: (v) => (v.startsWith('http') ? undefined : 'Must start with http') },
      { kind: 'secret', key: 'apiKey', label: 'API key', value: '' },
      { kind: 'action', key: 'save', label: 'Save' },
    ] },
  ];
}

const change = (r: boolean | FormEvent) => (typeof r === 'object' && r.type === 'change' ? r : undefined);

test('form renders exactly at every size and glyph set, editing or not, dropdown open or not', () => {
  for (const set of ['nerd', 'unicode', 'ascii'] as const) {
    for (const [rows, cols] of SIZES) {
      const f = createForm(sections());
      assertFrame(renderForm(f, { rows, cols }, glyphs(set)).lines, rows, cols, `form ${set}`);
      formKey(f, key('enter'));
      assertFrame(renderForm(f, { rows, cols }, glyphs(set)).lines, rows, cols, `form dropdown ${set}`);
      focusKey(f, 'url');
      const r = renderForm(f, { rows, cols }, glyphs(set));
      assertFrame(r.lines, rows, cols, `form editing ${set}`);
      if (r.cursor) { assert.ok(r.cursor.row < rows && r.cursor.col < cols, `cursor inside at ${cols}x${rows}`); }
    }
  }
});

test('up/down/tab move between fields, past info rows; a lean form draws values only, and help has the descriptions', () => {
  const f = createForm(sections());
  assert.equal(focusedField(f)?.key, 'harness');
  const view = () => text(renderForm(f, { rows: 20, cols: 60 }, g).lines);
  assert.match(view(), /❯ Harness\s+‹ claude ▾ ›/);
  assert.doesNotMatch(view(), /Which backend runs the agents|Session only until saved|Claude Code CLI/, 'no strip, no section notes');
  assert.deepEqual(fieldHelp(f), { title: 'Harness', keys: [], text: ['Which backend runs the agents.', 'claude: Claude Code CLI'] }, 'the focused field\'s label and description, for help');
  formKey(f, key('down'));
  formKey(f, key('tab'));
  assert.equal(focusedField(f)?.key, 'docs');
  formKey(f, key('down'));
  assert.equal(focusedField(f)?.key, 'locked', 'an info row is passed over; a disabled field takes the focus');
  formKey(f, key('down'));
  assert.equal(focusedField(f)?.key, 'budget');
  formKey(f, key('shift-tab'));
  formKey(f, key('shift-tab'));
  assert.equal(focusedField(f)?.key, 'docs');
  const strip = text(renderForm(f, { rows: 20, cols: 60 }, g, { strip: true, notes: true }).lines);
  assert.match(strip, /Session only until saved\./, 'a page may still ask for the notes and the strip');
});

test('choice: arrows cycle, Enter opens a dropdown that picks', () => {
  const f = createForm(sections());
  assert.equal(change(formKey(f, key('right')))?.value, 'codex');
  assert.equal(change(formKey(f, key('left')))?.value, 'claude');
  assert.equal(change(formKey(f, key('left')))?.value, 'fake', 'it wraps around');
  assert.equal(formKey(f, key('enter')), true);
  assert.ok(f.dropdown);
  assert.match(text(renderForm(f, { rows: 20, cols: 60 }, g).lines), /╭─+╮[\s\S]*codex/);
  assert.deepEqual(formHints(f).map((h) => h.label), ['choose', 'select', 'close']);
  formKey(f, key('up'));
  const picked = change(formKey(f, key('enter')));
  assert.equal(picked?.value, 'codex');
  assert.equal(f.dropdown, undefined);
  formKey(f, key('enter'));
  assert.equal(formKey(f, key('escape')), true, 'Esc closes the dropdown');
  assert.equal(f.dropdown, undefined);
});

test('number: steppers clamp, Enter starts typing and the first digit replaces the value, bad input is refused with a message', () => {
  const f = createForm(sections(), { focus: 'concurrency' });
  assert.equal(change(formKey(f, key('right')))?.value, 4);
  for (let i = 0; i < 10; i++) formKey(f, key('right'));
  assert.equal(fieldOf(f, 'concurrency')!.kind === 'number' && (fieldOf(f, 'concurrency') as { value: number }).value, 8, 'clamped at max');
  assert.equal(formKey(f, ch('1')), false, 'a digit on a field that is only focused is not the form\'s: it can switch tabs');
  assert.equal(formCapturesText(f), false);
  assert.equal(formKey(f, key('enter')), true);
  assert.equal(formCapturesText(f), true, 'Enter starts typing a number');
  assert.match(plain(renderForm(f, { rows: 20, cols: 60 }, g).lines.find((l) => l.includes('Concurrency'))!), /Concurrency\s+\[8\s+\]/, 'showing the value, in a field whose extent shows without colour');
  formKey(f, ch('1'));
  formKey(f, ch('2'));
  assert.equal(formKey(f, key('enter')), true, 'out of range: refused');
  assert.match(text(renderForm(f, { rows: 20, cols: 60 }, g).lines), /Must be between 1 and 8\./);
  formKey(f, key('end'));
  assert.match(text(renderForm(f, { rows: 20, cols: 60 }, g).lines), /Must be between/, 'moving the cursor keeps the message');
  formKey(f, key('down'));
  assert.equal(focusedField(f)?.key, 'concurrency', 'an invalid value keeps the focus');
  formKey(f, key('backspace'));
  assert.equal(change(formKey(f, key('enter')))?.value, 1);
  assert.equal(formCapturesText(f), false);
  formKey(f, key('enter'));
  formKey(f, ch('5'));
  assert.equal(formKey(f, key('escape')), true, 'Esc cancels typing');
  assert.equal((fieldOf(f, 'concurrency') as { value: number }).value, 1);
  assert.equal(formKey(f, ch('x')), false, 'letters are not the number\'s');
});

test('optional number (money): off, stepping in and out of off, Delete turns it off', () => {
  const f = createForm(sections(), { focus: 'budget' });
  const view = () => plain(renderForm(f, { rows: 20, cols: 60 }, g).lines.find((l) => l.includes('Budget'))!);
  assert.match(view(), /Budget\s+‹ off ›/);
  assert.equal(formKey(f, key('left')), true, 'nothing below off');
  assert.equal(change(formKey(f, key('right')))?.value, 0.5);
  assert.match(view(), /\$0\.50/);
  assert.equal(change(formKey(f, key('right')))?.value, 1);
  formKey(f, key('left'));
  assert.equal(change(formKey(f, key('left')))?.value, undefined, 'stepping below the minimum turns it off');
  formKey(f, key('enter'));
  formKey(f, ch('2'));
  formKey(f, ch('.'));
  formKey(f, ch('5'));
  assert.equal(change(formKey(f, key('enter')))?.value, 2.5);
  assert.equal(change(formKey(f, key('delete')))?.value, undefined);
  assert.deepEqual(formHints(f).map((h) => h.key).slice(-1), ['del']);
});

test('toggle and action', () => {
  const f = createForm(sections(), { focus: 'docs' });
  assert.equal(change(formKey(f, ch(' ')))?.value, false);
  assert.equal(change(formKey(f, key('enter')))?.value, true);
  focusKey(f, 'save');
  const r = formKey(f, key('enter'));
  assert.deepEqual(typeof r === 'object' && r.type === 'action' ? r.key : undefined, 'save');
  assert.equal(formKey(f, ch('q')), false, 'unused letters are the page\'s');
  assert.match(text(renderForm(createForm(sections(), { focus: 'save' }), { rows: 20, cols: 60 }, g).lines), /\[ Save \]/, 'the focused button is bracketed without colour');
});

test('text: edited while focused, validated on leaving, Esc reverts, changes reported once', () => {
  const f = createForm(sections(), { focus: 'url' });
  assert.equal(formCapturesText(f), true);
  for (const c of 'abc') formKey(f, ch(c));
  formKey(f, key('home'));
  formKey(f, key('delete'));
  formKey(f, key('delete'));
  formKey(f, key('delete'));
  formKey(f, key('delete'));
  formKey(f, key('delete'));
  formKey(f, key('delete'));
  formKey(f, key('delete'));
  formKey(f, key('delete'));
  assert.equal(formKey(f, key('down')), true);
  assert.equal(focusedField(f)?.key, 'url', 'invalid: the focus stays');
  assert.match(text(renderForm(f, { rows: 20, cols: 60 }, g).lines), /Must start with http/);
  assert.equal(formKey(f, key('escape')), true, 'Esc reverts the text');
  assert.equal(formKey(f, key('escape')), false, 'and an unchanged field leaves Esc to the page');
  formKey(f, key('end'));
  formKey(f, { name: 'paste', text: '/v1\n' });
  const r = change(formKey(f, key('enter')));
  assert.equal(r?.value, 'https://x/v1', 'Enter commits and moves on');
  assert.equal(focusedField(f)?.key, 'apiKey');
  const rendered = renderForm(f, { rows: 20, cols: 60 }, g);
  assert.ok(rendered.cursor, 'the focused text field shows the cursor');
  for (const c of 'sk-123') formKey(f, ch(c));
  assert.doesNotMatch(text(renderForm(f, { rows: 20, cols: 60 }, g).lines), /sk-123/, 'secrets are masked');
  assert.equal(change(formKey(f, key('down')))?.value, 'sk-123');
  assert.match(text(renderForm(f, { rows: 20, cols: 60 }, g).lines), /API key\s+••••••/);
});

test('changed marks, external errors, disabled reasons, and setSections keeps focus and typing', () => {
  const s = sections();
  s[0]!.fields[1]!.changed = true;
  s[1]!.fields[0]!.error = 'Save failed: read-only file';
  const f = createForm(s, { focus: 'budget' });
  const view = text(renderForm(f, { rows: 24, cols: 70 }, g).lines);
  assert.match(view, /Concurrency\s+3 ✎/, 'the changed mark follows the value');
  assert.match(view, /Budget\s+.*\n\s+! Save failed: read-only file/, 'an error is drawn under its field');
  focusKey(f, 'url');
  formKey(f, ch('!'));
  const fresh = sections();
  setSections(f, fresh);
  assert.equal(focusedField(f)?.key, 'url');
  assert.equal(f.editing?.input.editor.text, 'https://x!', 'what was being typed survives a reload');
  assert.equal(focusKey(f, 'where'), false, 'info rows cannot take the focus');
});

test('mouse: a click focuses, a click on the value acts, the wheel moves the focus', () => {
  const f = createForm(sections());
  renderForm(f, { rows: 20, cols: 60 }, g);
  const row = (k: string) => f.hits.find((h) => h.key === k)!;
  assert.equal(formMouse(f, press(row('docs').row, 2)), true);
  assert.equal(focusedField(f)?.key, 'docs');
  renderForm(f, { rows: 20, cols: 60 }, g);
  assert.equal(change(formMouse(f, press(row('docs').row, row('docs').valueFrom + 1)))?.value, false);
  formMouse(f, press(row('harness').row, row('harness').valueFrom + 2));
  formMouse(f, press(row('harness').row, row('harness').valueFrom + 2));
  assert.ok(f.dropdown, 'a click on a focused choice opens its list');
  renderForm(f, { rows: 20, cols: 60 }, g);
  const d = f.dropRect!;
  // Under the border and the filter line every dropdown has: claude, then codex.
  const picked = change(formMouse(f, press(d.top + 1 + f.dropdown!.list.offset + 1, d.left + 4)));
  assert.equal(picked?.value, 'codex', 'a click in the list picks');
  formMouse(f, { kind: 'wheel-down', button: 'none', row: 0, col: 0, shift: false, alt: false, ctrl: false });
  assert.equal(focusedField(f)?.key, 'concurrency');
});

test('two fields with one key are refused where the form is built', () => {
  const dup: FormSection[] = [{ fields: [{ kind: 'toggle', key: 'x', label: 'A', value: true }, { kind: 'toggle', key: 'x', label: 'B', value: false }] }];
  assert.throws(() => createForm(dup), /two fields have the key "x"/);
  const f = createForm(sections());
  assert.throws(() => setSections(f, dup), /keys must be distinct/);
});

test('a disabled field says why only when it is tried: the reason goes to onRefuse, nothing changes, nothing is drawn', () => {
  const refused: string[] = [];
  const s: FormSection[] = [{ fields: [
    { kind: 'toggle', key: 'a', label: 'First', value: true },
    { kind: 'action', key: 'b', label: 'Set key…', disabled: 'no key variable' },
    { kind: 'toggle', key: 'c', label: 'Third', value: false, disabled: 'set by your user config', tag: 'session' },
  ] }];
  const f = createForm(s, { onRefuse: (reason) => refused.push(reason) });
  const view = text(renderForm(f, { rows: 20, cols: 60 }, g).lines);
  assert.doesNotMatch(view, /no key variable|set by your user config/, 'the reason is not on the page');
  assert.match(view, /Third\s+○ off  session/, 'a short tag after the value');
  formKey(f, key('down'));
  assert.equal(focusedField(f)?.key, 'b', 'the focus can rest on it');
  assert.equal(formKey(f, key('enter')), true, 'pressing it is used, and refused');
  formKey(f, key('down'));
  assert.equal(formKey(f, ch(' ')), true);
  assert.equal((fieldOf(f, 'c') as { value: boolean }).value, false, 'its value did not change');
  assert.deepEqual(refused, ['no key variable', 'set by your user config']);
  for (const x of ['s', '?', '2']) assert.equal(formKey(f, ch(x)), false, `${x}: a key the field would not take when enabled is the page's (a shortcut, help, a tab)`);
  assert.deepEqual(refused, ['no key variable', 'set by your user config'], 'and is not refused');
  assert.deepEqual(fieldHelp(f)?.text, ['set by your user config'], 'help says why too');
});

test('the dropdown strip describes the highlighted option; hints name a button without saying enter twice; follow: false keeps the top', () => {
  const f = createForm(sections());
  formKey(f, key('enter'));
  const open = text(renderForm(f, { rows: 20, cols: 60 }, g).lines);
  assert.match(open, /❯ claude/);
  assert.doesNotMatch(open, /Claude Code CLI/, 'a dropdown lists names only');
  formKey(f, key('escape'));
  const b = createForm([{ fields: [{ kind: 'action', key: 'k', label: 'Enter a key…' }, { kind: 'action', key: 'm', label: 'Models per role…' }] }]);
  assert.deepEqual(formHints(b).map((h) => `${h.key} ${h.label}`).slice(-1), ['enter a key']);
  formKey(b, key('down'));
  assert.deepEqual(formHints(b).map((h) => h.label).slice(-1), ['models per role']);
  const tall = createForm(sections(), { focus: 'save' });
  const top = text(renderForm(tall, { rows: 8, cols: 60 }, g, { follow: false }).lines);
  assert.match(top, /Session/, 'not following the focus: the form reads from its top');
  assert.match(text(renderForm(tall, { rows: 8, cols: 60 }, g).lines), /Save/);
});

test('number: only plain decimals are numbers; a step finer than the digits shown still moves; - starts a negative number when one is allowed', () => {
  const number = (o: Record<string, unknown> = {}) => createForm([{ fields: [{ kind: 'number', key: 'n', label: 'N', value: 4, min: 1, max: 16, ...o } as FormSection['fields'][number]] }]);
  const commitPaste = (pasted: string, o: Record<string, unknown> = {}) => {
    const f = number(o);
    formKey(f, key('enter'));
    formKey(f, key('ctrl', 'u'));
    formKey(f, { name: 'paste', text: pasted });
    const r = formKey(f, key('enter'));
    return { value: (fieldOf(f, 'n') as { value: number | undefined }).value, changed: change(r)?.value, message: f.invalid?.message };
  };
  for (const bad of ['0x10', '0b11', '1e1', '.5e1', 'Infinity', '1_0', '--3', '5-', '.']) {
    const r = commitPaste(bad);
    assert.equal(r.value, 4, `${bad} is refused`);
    assert.match(r.message ?? '', /is not a number/, bad);
  }
  for (const [good, want] of [['12', 12], [' 7 ', 7], ['+3', 3], ['5.', 5], ['.5', 0.5]] as const) {
    assert.equal(commitPaste(good, { decimals: 1, min: 0 }).changed, want, `${good} is ${want}`);
  }
  const coarse = createForm([{ fields: [{ kind: 'number', key: 'n', label: 'N', value: 2, step: 0.5, decimals: 0 }] }]);
  const seen: unknown[] = [];
  for (let i = 0; i < 3; i++) { formKey(coarse, key('left')); seen.push((fieldOf(coarse, 'n') as { value: number }).value); }
  assert.deepEqual(seen, [1, 0, -1], 'not stuck at 2');
  const signed = createForm([{ fields: [{ kind: 'number', key: 'n', label: 'Offset', value: 0 }] }]);
  assert.equal(formKey(signed, ch('-')), true);
  assert.equal(formCapturesText(signed), true, 'with no minimum, - starts typing');
  formKey(signed, ch('3'));
  assert.equal(change(formKey(signed, key('enter')))?.value, -3);
  const unsigned = createForm([{ fields: [{ kind: 'number', key: 'n', label: 'Count', value: 3, min: 0 }] }]);
  assert.equal(change(formKey(unsigned, ch('-')))?.value, 2, 'with a minimum of 0 or more, - steps down');
});

test('paths and errors in a form are read whole: the strip wraps them (long words broken, not cut), an info field can wrap', () => {
  const path = '/tmp/claude-1000/-home-yigit-yargili-Documents-dev-dulger/90e96d89-2999-481c-ae1e-e174c4b22d83/scratchpad/walk/config/dulger/keys.json';
  const f = createForm([{ fields: [
    { kind: 'text', key: 'name', label: 'Profile name', value: '', description: `Keys are stored in ${path}.`, validate: () => 'Use 1–60 letters, numbers, spaces, dots, underscores or dashes; the name becomes a file name.' },
    { kind: 'info', key: 'file', label: 'Memory file', value: path, wrap: true },
  ] }]);
  const squeeze = (lines: string[]) => plain(lines.join('')).replace(/\s+/g, '');
  const first = renderForm(f, { rows: 24, cols: 70 }, g, { strip: true }).lines;
  assertFrame(first, 24, 70, 'form with paths');
  assert.ok(squeeze(first).includes(`Keysarestoredin${path}.`), 'the description strip, when asked for, shows the whole path');
  assert.ok(squeeze(first).includes(path), 'the wrapped info value shows the whole path');
  assert.doesNotMatch(plain(first.join('\n')), /…/, 'nothing is cut');
  formKey(f, ch('x'));
  formKey(f, key('enter'));
  const err = renderForm(f, { rows: 24, cols: 70 }, g).lines;
  assert.ok(squeeze(err).includes('Use1–60letters,numbers,spaces,dots,underscoresordashes;thenamebecomesafilename.'), 'the error is whole');
  for (const [rows, cols] of SIZES) assertFrame(renderForm(f, { rows, cols }, g).lines, rows, cols, 'form with an error');
});
