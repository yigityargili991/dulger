import { test } from 'node:test';
import assert from 'node:assert/strict';
import { c, glyphs } from '../src/tui/theme.ts';
import { width } from '../src/tui/text.ts';
import {
  beside, compose, dim, frame, highlight, hit, onBackground, overlay, panel, place, slice, softWrap, split, splitCols, stack, thumb, wrapRanges,
} from '../src/tui/kit/index.ts';
import { SIZES, assertFrame, g, plain, press, text, withColour } from './kit.helpers.ts';

test('slice cuts cells, keeps styles open across the cut and closes them', () => withColour(() => {
  const line = `ab${c.ok('cdef')}gh`;
  assert.equal(plain(slice(line, 3, 6)), 'def');
  const open = c.ok('\0').split('\0')[0]!;
  assert.ok(open && slice(line, 3, 6).startsWith(open), 'the colour active at the cut is re-opened');
  assert.ok(slice(line, 3, 6).endsWith('\x1b[0m'));
  assert.equal(slice('plain', 1, 3), 'la', 'unstyled text gets no escapes');
  assert.equal(plain(slice(line, 5)), 'fgh', 'open-ended');
  assert.equal(slice('abc', 2, 2), '');
}));

test('slice never splits a wide character: the halves become spaces', () => {
  assert.equal(slice('日本語', 1, 5), ' 本 ');
  assert.equal(width(slice('日本語', 1, 5)), 4);
  assert.equal(slice('a😀b', 0, 2), 'a ');
  assert.equal(slice('👩‍💻x', 0, 2), '👩‍💻', 'a ZWJ sequence is one grapheme');
  assert.equal(slice('éx', 0, 1), 'é', 'combining marks stay with their letter');
});

test('overlay puts a box over styled and wide text without changing row widths', () => withColour(() => {
  const base = frame([c.info('0123456789'), '日本語日本語日本語', `${c.warn('xx')}😀😀😀yy`], { rows: 3, cols: 12 });
  const out = overlay(base, [c.bad('[box]'), '[box]'], 1, 3);
  assertFrame(out, 3, 12, 'overlay');
  assert.equal(plain(out[0]!), '0123456789  ');
  assert.equal(plain(out[1]!), '日 [box]本… ', 'the cut wide characters became spaces');
  assert.equal(plain(out[2]!), 'xx [box]yy  ', 'emoji under the box are covered, the one cut at its edge became a space');
  assert.deepEqual(overlay(base, ['zz'], 5, 0), base, 'rows outside the frame are ignored');
}));

test('dim drops styles and paints the frame faint', () => withColour(() => {
  const d = dim([c.bad('red') + c.bg(' bg ')]);
  assert.equal(plain(d[0]!), 'red bg ');
  assert.ok(!d[0]!.includes(c.bg('\0').split('\0')[0]!), 'backgrounds are gone');
}));

test('split and its rects divide space exactly', () => {
  assert.deepEqual(split(100, [20, { flex: 1 }, { flex: 2 }], 1), [20, 26, 52]);
  assert.deepEqual(split(10, [20, { flex: 1 }]), [10, 0], 'fixed parts are cut first');
  assert.deepEqual(split(30, [{ flex: 1, min: 25 }, { flex: 1 }]), [25, 5], 'a minimum is frozen and the rest shared again');
  assert.deepEqual(split(10, [{ flex: 1, max: 3 }, { flex: 1 }]), [3, 7]);
  for (const total of [0, 1, 7, 80, 121]) {
    const s = split(total, [{ flex: 1 }, 5, { flex: 3 }], 1);
    assert.equal(s.reduce((a, b) => a + b, 0), Math.max(0, total - 2), `total ${total}`);
  }
  const rects = splitCols({ top: 2, left: 0, rows: 5, cols: 41 }, [{ flex: 1 }, { flex: 1 }], 1);
  assert.deepEqual(rects, [{ top: 2, left: 0, rows: 5, cols: 20 }, { top: 2, left: 21, rows: 5, cols: 20 }]);
});

test('beside and stack lay blocks out at exact widths', () => {
  assertFrame(beside([['a', 'b'], ['日本語日本語']], [3, 4], 3, 1), 3, 8, 'beside');
  assert.equal(text(beside([['a'], ['b']], [2, 2], 1, 1)), 'a  b ');
  assertFrame(stack([['x'], ['y', '日本語日本語']], 5), 3, 5, 'stack');
});

test('compose paints rects and moves the focused cursor into frame coordinates', () => {
  const r = compose({ rows: 4, cols: 10 }, [
    { rect: { top: 0, left: 0, rows: 2, cols: 5 }, block: ['ab', 'cd'] },
    { rect: { top: 2, left: 5, rows: 2, cols: 5 }, block: { lines: ['ef'], cursor: { row: 0, col: 1 } } },
  ]);
  assertFrame(r.lines, 4, 10, 'compose');
  assert.deepEqual(r.cursor, { row: 2, col: 6 });
  assert.equal(plain(r.lines[2]!), '     ef   ');
  assert.deepEqual(hit(press(3, 7), { top: 2, left: 5, rows: 2, cols: 5 })?.row, 1);
  assert.equal(hit(press(0, 0), { top: 2, left: 5, rows: 2, cols: 5 }), undefined);
});

test('panel: title, badge, footer, focus colour, scrollbar, and every size fits', () => {
  for (const [rows, cols] of SIZES) {
    for (const set of ['nerd', 'unicode', 'ascii'] as const) {
      const r = panel({ rows, cols }, { g: glyphs(set), title: 'A long panel title 日本語', badge: '12', footer: '3/40', focused: true, scroll: { top: 3, total: 50, visible: 5 } },
        (inner) => ({ lines: Array.from({ length: inner.rows }, (_, i) => `row ${i} ${'x'.repeat(inner.cols)}`), cursor: { row: 0, col: 0 } }));
      assertFrame(r.lines, rows, cols, `panel ${set}`);
    }
  }
  const r = panel({ rows: 6, cols: 30 }, { g, title: 'Runs', badge: '12', footer: '1/3', scroll: { top: 0, total: 20, visible: 4 } }, () => ({ lines: ['hello'], cursor: { row: 0, col: 2 } }));
  assert.equal(plain(r.lines[0]!), '╭─ Runs ──────────────── 12 ─╮');
  assert.equal(plain(r.lines[1]!), '│ hello                      ┃');
  assert.equal(plain(r.lines[5]!), '╰─ 1/3 ──────────────────────╯');
  assert.deepEqual(r.cursor, { row: 1, col: 4 }, 'the body cursor is moved inside the border and padding');
  const tiny = panel({ rows: 2, cols: 10 }, { g, title: 'Runs' }, (inner) => [`${inner.rows}x${inner.cols}`]);
  assert.equal(plain(tiny.lines[0]!).trim(), '2x10', 'below 3 rows the border goes and the content keeps the space');
  withColour(() => {
    const focused = panel({ rows: 3, cols: 10 }, { g, title: 'T', focused: true }, () => []).lines[0]!;
    const idle = panel({ rows: 3, cols: 10 }, { g, title: 'T' }, () => []).lines[0]!;
    assert.ok(focused.startsWith(c.selected('\0').split('\0')[0]!), 'mauve border when focused');
    assert.ok(idle.startsWith(c.border('\0').split('\0')[0]!), 'surface border otherwise');
    assert.notEqual(focused, idle);
  });
  const lazy = panel({ rows: 5, cols: 20 }, { g, scroll: () => ({ top: 0, total: 10, visible: 3 }), footer: () => 'late' }, () => []);
  assert.match(text(lazy.lines), /late/, 'footer and scroll may be functions, read after the body rendered');
});

test('thumb, place, highlight, background rows and soft wrap', () => {
  assert.deepEqual(thumb(4, 0, 4, 4), [], 'nothing to scroll');
  assert.deepEqual(thumb(4, 0, 8, 4), [true, true, false, false]);
  assert.deepEqual(thumb(4, 4, 8, 4), [false, false, true, true]);
  assert.deepEqual(place({ rows: 4, cols: 10 }, { rows: 24, cols: 80 }), { top: 10, left: 35 });
  assert.deepEqual(place({ rows: 4, cols: 10 }, { rows: 24, cols: 80 }, 'top'), { top: 4, left: 35 });
  withColour(() => {
    const h = highlight('settings', [0, 1], (s) => s, (s) => `[${s}]`);
    assert.equal(h, '[se]ttings');
    const row = onBackground(`a${c.bad('b')}\x1b[0mc`, 6, c.bg);
    assert.equal(width(row), 6);
    const bgOpen = c.bg('\0').split('\0')[0]!;
    assert.equal(row.split(bgOpen).length - 1, 2, 'the background opens the row and re-opens after the inner reset');
  });
  assert.deepEqual(softWrap('the quick brown fox', 10), ['the quick ', 'brown fox']);
  assert.deepEqual(softWrap('    indented code', 8), ['    ', 'indented', ' code'], 'spaces are kept');
  assert.deepEqual(softWrap('日本語日本語', 5), ['日本', '語日', '本語']);
  assert.deepEqual(wrapRanges([], 5), [[0, 0]]);
  assert.deepEqual(softWrap('abc', 1), ['a', 'b', 'c']);
  assert.deepEqual(softWrap('日', 1), ['日'], 'a character wider than the row still makes progress');
});

test('without colour a focused panel puts the pointer before its title; dialogs do not; with colour nothing changes', () => {
  const focused = plain(panel({ rows: 3, cols: 30 }, { g, title: 'Runs', focused: true }, () => []).lines[0]!);
  const idle = plain(panel({ rows: 3, cols: 30 }, { g, title: 'Runs' }, () => []).lines[0]!);
  assert.match(focused, /^╭─ ❯ Runs ─/);
  assert.match(idle, /^╭─ Runs ─/);
  assert.match(plain(panel({ rows: 3, cols: 30 }, { g, title: 'Discard?', focused: true, mark: false }, () => []).lines[0]!), /^╭─ Discard\? ─/);
  withColour(() => assert.match(plain(panel({ rows: 3, cols: 30 }, { g, title: 'Runs', focused: true }, () => []).lines[0]!), /^╭─ Runs ─/));
});

test('glyphs: "changed" is never a toggle that is on; in ASCII nothing doubles as the pointer, and frames can be made ASCII', async () => {
  const { asciiText } = await import('../src/tui/text.ts');
  for (const set of ['nerd', 'unicode', 'ascii'] as const) {
    const gl = glyphs(set);
    assert.notEqual(gl.modified, gl.toggleOn, `${set}: changed vs on`);
    assert.notEqual(gl.pointer, gl.pointerIdle, `${set}: focused vs unfocused selection`);
    assert.equal(width(gl.pointer), width(gl.pointerIdle));
  }
  const a = glyphs('ascii') as unknown as Record<string, unknown>;
  for (const [name, v] of Object.entries(a)) if (name !== 'pointer') assert.notEqual(v, a.pointer, `ascii ${name} is not the pointer`);
  const line = '╭─ Runs · 3 ─╮ ↑↓ move → open … — “quoted” ✓ ✗ 日本語';
  const out = asciiText(line);
  assert.equal(out, '+- Runs - 3 -+ ^v move > open . - "quoted" v x 日本語');
  assert.equal(width(out), width(line), 'every row keeps its width');
  withColour(() => assert.equal(plain(asciiText(c.accent('a → b'))), 'a > b', 'styles are kept'));
});
