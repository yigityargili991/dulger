import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glyphs } from '../src/tui/theme.ts';
import {
  checkedIds, columnWidths, createList, createTable, fuzzy, fuzzyFilter, listCapturesText, listKey, listMouse, renderList, renderTable,
  renderTabs, selectedItem, selectedRow, setItems, setRows, shownItems, tabAt, tableKey, tableMouse, type ListItem,
} from '../src/tui/kit/index.ts';
import { SIZES, assertFrame, ch, g, key, plain, press, text, wheel } from './kit.helpers.ts';

const items = (n: number): ListItem[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `Item ${i}`, detail: i % 2 ? 'odd' : 'even', meta: `${i}m` }));

test('fuzzy: order matters, word starts and runs score higher, smart case, terms', () => {
  assert.ok(fuzzy('gts', 'Go to Settings'));
  assert.equal(fuzzy('stg', 'Go to Settings')?.positions.length, 3);
  assert.equal(fuzzy('xyz', 'Go to Settings'), undefined);
  assert.equal(fuzzy('', 'anything')?.score, 0);
  assert.ok(fuzzy('set', 'Settings')!.score > fuzzy('set', 'reset the thing')!.score, 'a prefix beats a mid-word match');
  assert.ok(fuzzy('gs', 'Go to Settings')!.score > fuzzy('gs', 'bigrams')!.score, 'word starts beat inner letters');
  assert.equal(fuzzy('Set', 'reset'), undefined, 'an upper-case query matches case-sensitively');
  assert.ok(fuzzy('set', 'SETTINGS'));
  assert.ok(fuzzy('go set', 'Go to Settings'), 'every term must match');
  assert.equal(fuzzy('go xyz', 'Go to Settings'), undefined);
  assert.deepEqual(fuzzy('日本', 'これは日本語')?.positions, [3, 4], 'positions count graphemes');
  const ranked = fuzzyFilter(['Reset session', 'Settings', 'Go to Settings'], 'sett', (s) => s).map((r) => r.item);
  assert.equal(ranked[0], 'Settings');
});

test('list renders exactly at every size, in all glyph sets, with the empty and filter states', () => {
  for (const set of ['nerd', 'unicode', 'ascii'] as const) {
    for (const [rows, cols] of SIZES) {
      for (const s of [createList(items(50), { filter: 'type' }), createList([], { empty: 'Nothing yet' }), createList(items(3), { multi: true, checked: ['i1'] })]) {
        assertFrame(renderList(s, { rows, cols }, glyphs(set), { focused: true, scrollbar: true }), rows, cols, `list ${set}`);
      }
    }
  }
  const empty = createList([], { empty: 'No runs yet.' });
  assert.match(text(renderList(empty, { rows: 3, cols: 30 }, g)), /No runs yet\./);
});

test('list: the selection is marked without colour and stays in a view that only moves when it must', () => {
  const s = createList(items(30));
  const frame = (rows = 5) => renderList(s, { rows, cols: 30 }, g, { focused: true }).map(plain);
  assert.match(frame()[0]!, /^❯ Item 0/, 'pointer marks the selection');
  for (let i = 0; i < 6; i++) listKey(s, key('down'));
  assert.equal(s.index, 6);
  const f = frame();
  assert.match(f[4]!, /^❯ Item 6/, 'the view scrolled just enough');
  listKey(s, key('up'));
  assert.match(frame()[3]!, /^❯ Item 5/, 'moving back up inside the view does not scroll it');
  listKey(s, key('pagedown'));
  assert.equal(s.index, 9, 'a page is the visible height less one');
  listKey(s, key('end'));
  assert.equal(selectedItem(s)?.id, 'i29');
  listKey(s, key('home'));
  assert.equal(s.index, 0);
  assert.match(frame()[0]!, /Item 0\s+even\s+0m$|Item 0  even\s+0m$/, 'detail after the label, meta at the right');
});

test('list: disabled rows are skipped, ids survive setItems', () => {
  const s = createList([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', disabled: true }, { id: 'c', label: 'C' }]);
  listKey(s, key('down'));
  assert.equal(selectedItem(s)?.id, 'c');
  setItems(s, [{ id: 'z', label: 'Z' }, { id: 'c', label: 'C again' }]);
  assert.equal(selectedItem(s)?.label, 'C again', 'selection follows the id');
});

test('list: type-to-filter narrows, highlights, sorts and clears; slash mode leaves letters to the page', () => {
  const s = createList([{ id: 'r', label: 'Reset session' }, { id: 's', label: 'Settings' }, { id: 'm', label: 'Models' }], { filter: 'type' });
  assert.equal(listCapturesText(s), true);
  for (const c of 'set') listKey(s, ch(c));
  assert.deepEqual(shownItems(s).map((r) => r.item.id), ['s', 'r'], 'best first');
  assert.equal(selectedItem(s)?.id, 's');
  assert.match(text(renderList(s, { rows: 4, cols: 30 }, g, { focused: true })), /set_?\s+2\/3/);
  listKey(s, key('backspace'));
  assert.equal(s.query, 'se');
  assert.equal(listKey(s, key('escape')), true, 'Esc clears the filter first');
  assert.equal(s.query, '');
  assert.equal(listKey(s, key('escape')), false, 'then Esc is the caller\'s');
  listKey(s, { name: 'paste', text: 'mod\n' });
  assert.equal(selectedItem(s)?.id, 'm');

  const p = createList(items(10), { filter: 'slash' });
  assert.equal(listKey(p, ch('d')), false, 'letters are left alone until / is pressed');
  assert.equal(listCapturesText(p), false);
  listKey(p, ch('/'));
  assert.equal(listCapturesText(p), true);
  for (const c of 'item 7') listKey(p, ch(c));
  assert.equal(selectedItem(p)?.id, 'i7');
  listKey(p, key('enter'));
  assert.equal(p.filtering, false, 'Enter stops typing and keeps the filter');
  assert.equal(shownItems(p).length, 1);
  assert.equal(listKey(p, key('enter')), false, 'the next Enter is the caller\'s (open the item)');
});

test('list: multi-select with checkboxes, Ctrl-A for all', () => {
  const s = createList(items(4), { multi: true });
  listKey(s, ch(' '));
  listKey(s, key('down'));
  listKey(s, key('down'));
  listKey(s, ch(' '));
  assert.deepEqual(checkedIds(s), ['i0', 'i2']);
  assert.match(text(renderList(s, { rows: 4, cols: 20 }, g)), /▣ Item 0/);
  listKey(s, key('ctrl', 'a'));
  assert.deepEqual(checkedIds(s), ['i0', 'i1', 'i2', 'i3']);
  listKey(s, key('ctrl', 'a'));
  assert.deepEqual(checkedIds(s), []);
  assert.match(text(renderList(createList(items(1), { multi: true }), { rows: 1, cols: 20 }, glyphs('ascii'))), /\[ \] Item 0/);
});

test('list: clicks select then activate, the wheel scrolls and drags the selection along', () => {
  const s = createList(items(40), { filter: 'type' });
  renderList(s, { rows: 6, cols: 30 }, g);
  assert.equal(listMouse(s, press(0, 3)), false, 'the filter line is not an item');
  assert.equal(listMouse(s, press(3, 3)), true);
  assert.equal(selectedItem(s)?.id, 'i2');
  assert.equal(listMouse(s, press(3, 3)), 'activate', 'a click on the selected row activates it');
  listMouse(s, wheel('down'));
  listMouse(s, wheel('down'));
  assert.equal(s.top, 6);
  assert.equal(s.index, 6, 'the selection was dragged into view');
});

test('table: widths, alignment, dropped columns, selection and mouse', () => {
  const columns = [
    { title: 'ID', width: 3 }, { title: 'Title', flex: 1 }, { title: 'Cost', width: 6, align: 'right' as const }, { title: 'Turns', width: 5, align: 'right' as const, optional: true },
  ];
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, cells: [`c${i}`, `Card number ${i} 日本語`, `$${i}.00`, String(i)] }));
  const t = createTable(columns, rows);
  for (const [r, c] of SIZES) for (const set of ['nerd', 'ascii'] as const) assertFrame(renderTable(t, { rows: r, cols: c }, glyphs(set), { focused: true }), r, c, 'table');
  const f = renderTable(t, { rows: 5, cols: 40 }, g, { focused: true }).map(plain);
  assert.match(f[0]!, /^ {2}ID\s+Title\s+Cost\s+Turns$/);
  assert.match(f[1]!, /^❯ c0 +Card number 0 .* +\$0\.00 +0$/);
  assert.deepEqual(columnWidths(columns, rows, 20).slice(-1), [0], 'the optional column goes first when narrow');
  tableKey(t, key('end'));
  assert.equal(selectedRow(t)?.id, 'c19');
  renderTable(t, { rows: 5, cols: 40 }, g);
  tableKey(t, key('home'));
  renderTable(t, { rows: 5, cols: 40 }, g);
  assert.equal(tableMouse(t, press(2, 5)), true);
  assert.equal(selectedRow(t)?.id, 'c1');
  assert.equal(tableMouse(t, press(2, 5)), 'activate');
  assert.equal(tableMouse(t, press(0, 5)), false, 'the header is not a row');
  setRows(t, rows.slice(1));
  assert.equal(selectedRow(t)?.id, 'c1', 'selection follows the id');
  assert.match(text(renderTable(createTable(columns, [], { empty: 'No cards' }), { rows: 3, cols: 30 }, g)), /No cards/);
});

test('table: when the first column was dropped and a minimum stops shrinking, the last column standing is cut, not dropped', () => {
  const columns = [{ title: 'When', width: 10, optional: true }, { title: 'Goal', width: 40, min: 30 }];
  assert.deepEqual(columnWidths(columns, [], 20), [0, 20]);
  const t = createTable(columns, [{ id: 'a', cells: ['5m ago', 'add a health endpoint to the api'] }]);
  const shown = renderTable(t, { rows: 3, cols: 22 }, g).map(plain);
  assert.match(shown[0]!, /Goal/);
  assert.match(shown[1]!, /add a health/);
  for (const cols of [1, 3, 8, 21, 40, 60]) assert.ok(columnWidths(columns, [], cols).some((w) => w > 0), `something shows at ${cols}`);
});

test('tabs: numbers, active marker without colour, shrinking, click mapping', () => {
  const tabs = ['Home', 'Runs', 'Settings', 'Models', 'Providers', 'Memory', 'Doctor'].map((t) => ({ id: t.toLowerCase(), title: t }));
  const wide = renderTabs(tabs, 2, 100);
  assert.match(plain(wide.line), /1 Home {3}2 Runs {2}\[3 Settings\] {2}4 Models/, 'colourless: the active tab is bracketed');
  assert.equal(tabAt(wide, wide.spans[1]!.from), 1);
  assert.equal(tabAt(wide, 0), undefined);
  const narrow = renderTabs(tabs, 2, 40);
  assert.match(plain(narrow.line), /^ ‹ {2}Runs {2}\[Settings\] {2}Mode {3}Prov {2}›/, 'narrow: the active title whole, the tabs around it by short names, arrows where some are left out');
  assert.equal(tabAt(narrow, narrow.spans.find((x) => x.index === 3)!.from), 3, 'a short name maps to its tab');
  assert.match(plain(renderTabs(tabs, 0, 60).line), /\[Home\] {2}Runs {3}Settin {3}Models {3}Provid {3}Memory {3}Doctor/, 'at 60 columns every tab still has a readable name');
  for (const [cols, active] of [[60, 0], [50, 3], [40, 6], [30, 3]] as const) {
    assert.doesNotMatch(plain(renderTabs(tabs, active, cols).line), /(^|\s)\d(\s|$)/, `no bare digits at ${cols} columns`);
  }
  for (const cols of [1, 3, 8, 20, 40, 60, 100]) {
    const bar = renderTabs(tabs, 6, cols);
    assertFrame([bar.line], 1, cols, 'tabs');
    for (const s of bar.spans) assert.ok(s.to <= cols);
  }
  assert.equal(tabAt(renderTabs(tabs, 6, 8), 2), 6, 'the last fallback still maps to the real tab');
});

test('list: keepMeta cuts a long label instead of dropping the meta; a middle cut keeps a path\'s file name', () => {
  const s = createList([{ id: 'a', label: 'src/very/deeply/nested/folder/structure/component.ts', meta: '+12 -3' }]);
  const plainRow = plain(renderList(s, { rows: 1, cols: 40 }, g)[0]!);
  assert.doesNotMatch(plainRow, /\+12 -3/, 'by default a long label pushes the meta out (unchanged)');
  const kept = plain(renderList(s, { rows: 1, cols: 40 }, g, { keepMeta: true, cut: 'middle' })[0]!);
  assert.match(kept, /\+12 -3$/);
  assert.match(kept, /^› src\/very.*….*component\.ts\s+\+12 -3$/, 'both ends of the path stay');
  for (const [rows, cols] of SIZES) assertFrame(renderList(s, { rows, cols }, g, { keepMeta: true, cut: 'middle' }), rows, cols, 'keepMeta');
});

test('the list\'s filter line is the kit\'s for lists drawn elsewhere; renderListTable draws a filtered list as columns', async () => {
  const { listFilterLine, renderListTable, followRange } = await import('../src/tui/kit/index.ts');
  const s = createList(items(30), { filter: 'slash' });
  listKey(s, ch('/'));
  for (const x of 'item 2') listKey(s, ch(x));
  assert.match(plain(listFilterLine(s, 40, g)), /⌕ item 2_\s+\d+\/30$/);
  const cols = [{ title: 'Name', flex: 1 }, { title: 'Detail', width: 6 }, { title: 'Age', width: 4, align: 'right' as const }];
  const rowOf = (it: ListItem) => ({ id: it.id, cells: [it.label, it.detail ?? '', it.meta ?? ''], icons: [c('✓')] });
  const lines = renderListTable(s, cols, rowOf, { rows: 8, cols: 40 }, g, { focused: true });
  assertFrame(lines, 8, 40, 'list table');
  assert.match(plain(lines[0]!), /⌕ item 2/, 'the filter line first');
  assert.match(plain(lines[1]!), /Name\s+Detail\s+Age/, 'then the header');
  assert.match(plain(lines[2]!), /❯ ✓ Item 2\s+even\s+2m/, 'icons before the cell text');
  assert.equal(s.offset, 2, 'clicks know about the filter line and the header');
  assert.equal(listMouse(s, press(3, 4)), true);
  assert.equal(selectedItem(s)?.id, 'i20');
  listKey(s, key('enter'));
  for (const [rows, w] of SIZES) assertFrame(renderListTable(s, cols, rowOf, { rows, cols: w }, g), rows, w, 'list table sizes');
  assert.equal(followRange(0, 10, 13, 5, 40), 8, 'the whole item in view');
  assert.equal(followRange(0, 10, 13, 5, 40, 9), 8, 'with its heading when that fits');
  assert.equal(followRange(0, 10, 20, 5, 40), 10, 'taller than the view: from its start');
  assert.equal(followRange(30, 2, 3, 5, 40), 2);
});

const c = (t: string) => t;

test('list: the words filter matches substrings, the exact item first, then those that start with the query', () => {
  const goals = ['Build the board walkthrough four', 'Build the board walkthrough three', 'Build the board walkthrough two', 'Build the board walkthrough', 'Two-factor login']
    .map((label, i) => ({ id: `r${i}`, label, keywords: `20261115-020${i}` }));
  const s = createList(goals, { filter: 'slash', match: 'words' });
  listKey(s, ch('/'));
  for (const x of 'walkthrough two') listKey(s, ch(x));
  assert.deepEqual(shownItems(s).map((r) => r.item.label), ['Build the board walkthrough two'], 'every word must appear as typed: no loose subsequences');
  assert.equal(selectedItem(s)?.id, 'r2');
  listKey(s, key('ctrl', 'u'));
  for (const x of 'build the board walkthrough') listKey(s, ch(x));
  assert.equal(shownItems(s)[0]!.item.label, 'Build the board walkthrough', 'the exact goal comes first');
  listKey(s, key('ctrl', 'u'));
  for (const x of 'two') listKey(s, ch(x));
  assert.deepEqual(shownItems(s).map((r) => r.item.id), ['r4', 'r2'], 'one that starts with the word ranks above one that has it inside');
  listKey(s, key('ctrl', 'u'));
  for (const x of '0202') listKey(s, ch(x));
  assert.deepEqual(shownItems(s).map((r) => r.item.id), ['r2'], 'keywords (a run id) still match');
  assert.deepEqual(shownItems(createList(goals, { filter: 'type' })).length, 5, 'fuzzy stays the default');
  const fz = createList(goals, { filter: 'type' });
  for (const x of 'walkthrough two') listKey(fz, ch(x));
  assert.ok(shownItems(fz).length > 1, 'fuzzy (the palette\'s) matches letters in order');
});

test('list and table without colour: the full pointer only where the keyboard is; a focused panel marks its title', () => {
  const s = createList(items(3));
  assert.match(plain(renderList(s, { rows: 3, cols: 30 }, g, { focused: true })[0]!), /^❯ Item 0/);
  assert.match(plain(renderList(s, { rows: 3, cols: 30 }, g, { focused: false })[0]!), /^› Item 0/, 'a lighter pointer in a panel without the keyboard');
  const ascii = glyphs('ascii');
  assert.match(plain(renderList(s, { rows: 3, cols: 30 }, ascii, { focused: true })[0]!), /^\* Item 0/);
  assert.match(plain(renderList(s, { rows: 3, cols: 30 }, ascii, { focused: false })[0]!), /^- Item 0/);
  const t = createTable([{ title: 'Name' }], [{ id: 'a', cells: ['alpha'] }]);
  assert.match(plain(renderTable(t, { rows: 3, cols: 20 }, g, { focused: false })[1]!), /^› alpha/);
});
