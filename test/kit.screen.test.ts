import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInputDecoder, openScreen, parseInput, parseKeys, type Key, type Mouse } from '../src/tui/screen.ts';
import { createEditor, edit } from '../src/tui/editor.ts';
import { pasteText } from '../src/tui/text.ts';

test('parseKeys keeps every old answer', () => {
  assert.deepEqual(parseKeys('\x1b[A\x1b[B\x1b[C\x1b[D\x1bOA'), [{ name: 'up' }, { name: 'down' }, { name: 'right' }, { name: 'left' }, { name: 'up' }]);
  assert.deepEqual(parseKeys('\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[3~\x1b[5~\x1b[6~\x1b[Z'),
    ['home', 'end', 'home', 'end', 'delete', 'pageup', 'pagedown', 'shift-tab'].map((name) => ({ name })));
  assert.deepEqual(parseKeys('\x1b'), [{ name: 'escape' }], 'a lone ESC is still escape');
  assert.deepEqual(parseKeys('\x1b[99z\x1b[?1;2c'), [], 'unknown and private sequences are dropped, not typed');
});

test('parseKeys: modified arrows, function keys and Alt', () => {
  assert.deepEqual(parseKeys('\x1b[1;5C\x1b[1;5D'), [{ name: 'ctrl-right' }, { name: 'ctrl-left' }]);
  assert.deepEqual(parseKeys('\x1b[1;3D\x1b[1;2A\x1b[1;6C'), [{ name: 'alt-left' }, { name: 'shift-up' }, { name: 'ctrl-right' }], 'ctrl wins over shift');
  assert.deepEqual(parseKeys('\x1b[5;5~\x1b[3;5~\x1b[1;5H'), [{ name: 'ctrl-pageup' }, { name: 'ctrl-delete' }, { name: 'ctrl-home' }]);
  assert.deepEqual(parseKeys('\x1b\x1b[D'), [{ name: 'alt-left' }], 'ESC-prefixed arrows are Alt arrows');
  assert.deepEqual(parseKeys('\x1bOP\x1bOS\x1b[15~\x1b[24~\x1b[1;2P\x1b[[A'), ['f1', 'f4', 'f5', 'f12', 'f1', 'f1'].map((name) => ({ name })));
  assert.deepEqual(parseKeys('\x1bb\x1b1\x1bé'), [{ name: 'alt', ch: 'b' }, { name: 'alt', ch: '1' }, { name: 'alt', ch: 'é' }]);
  assert.deepEqual(parseKeys('\x1b\r\x1b\x7f'), [{ name: 'alt-enter' }, { name: 'alt-backspace' }]);
  assert.deepEqual(parseKeys('\x1b\x1b'), [{ name: 'escape' }, { name: 'escape' }]);
  assert.deepEqual(parseKeys('\x1b\x03'), [{ name: 'escape' }, { name: 'ctrl', ch: 'c' }], 'ESC before a control key is escape');
});

test('bracketed paste arrives as one key and its newlines never submit', () => {
  assert.deepEqual(parseKeys('a\x1b[200~line one\r\nline two\x1b[201~b'), [{ name: 'char', ch: 'a' }, { name: 'paste', text: 'line one\r\nline two' }, { name: 'char', ch: 'b' }]);
  assert.deepEqual(parseKeys('\x1b[200~cut off'), [{ name: 'paste', text: 'cut off' }], 'a paste cut by the chunk is taken as it stands');
  const decode = createInputDecoder();
  assert.deepEqual(decode('x\x1b[200~first\n'), [{ type: 'key', key: { name: 'char', ch: 'x' } }]);
  assert.deepEqual(decode('second'), [], 'still inside the paste');
  assert.deepEqual(decode('\nthird\x1b[201~\r'), [{ type: 'key', key: { name: 'paste', text: 'first\nsecond\nthird' } }, { type: 'key', key: { name: 'enter' } }]);
  assert.equal(pasteText('one\r\ntwo\n'), 'one two', 'one line: newlines become spaces, the trailing one goes');
  assert.equal(pasteText('a\tb\nc\x1b[31m!\x07', true), 'a    b\nc!', 'several lines: tabs expand, escapes go');
});

test('SGR mouse reports: press, release, drag, wheel, modifiers, 0-based cells', () => {
  const mice = (s: string) => parseInput(s).flatMap((e) => (e.type === 'mouse' ? [e.mouse] : []));
  const base = { shift: false, alt: false, ctrl: false };
  assert.deepEqual(mice('\x1b[<0;10;5M'), [{ kind: 'press', button: 'left', row: 4, col: 9, ...base }]);
  assert.deepEqual(mice('\x1b[<0;10;5m'), [{ kind: 'release', button: 'left', row: 4, col: 9, ...base }]);
  assert.deepEqual(mice('\x1b[<2;1;1M'), [{ kind: 'press', button: 'right', row: 0, col: 0, ...base }]);
  assert.deepEqual(mice('\x1b[<32;3;4M'), [{ kind: 'drag', button: 'left', row: 3, col: 2, ...base }]);
  assert.deepEqual(mice('\x1b[<64;1;1M\x1b[<65;1;1M').map((m: Mouse) => m.kind), ['wheel-up', 'wheel-down']);
  assert.deepEqual(mice('\x1b[<16;2;2M')[0]!.ctrl, true);
  assert.deepEqual(parseKeys('\x1b[<0;10;5Mq'), [{ name: 'char', ch: 'q' }], 'mouse reports are never typed as keys');
});

test('openScreen: old two-argument calls work; paste always, mouse on request; both restored', async () => {
  const run = async (opts?: { mouse?: boolean }) => {
    let output = '';
    const out = Object.assign(new EventEmitter(), { rows: 5, columns: 10, write: (s: string) => { output += s; return true; } });
    const inp = Object.assign(new EventEmitter(), { isRaw: false, setRawMode: (raw: boolean) => { inp.isRaw = raw; }, resume: () => {}, pause: () => {}, setEncoding: () => {} });
    const screen = opts ? openScreen(out as unknown as NodeJS.WriteStream, inp as unknown as NodeJS.ReadStream, opts) : openScreen(out as unknown as NodeJS.WriteStream, inp as unknown as NodeJS.ReadStream);
    const keys: Key[] = [];
    const mice: Mouse[] = [];
    screen.onKey((k) => keys.push(k));
    screen.onMouse?.((m) => mice.push(m));
    const opened = output;
    inp.emit('data', '\x1b[200~pasted\nline');
    inp.emit('data', '\x1b[201~\x1b[<0;2;3M');
    // The second event of a read is delivered after pending continuations have run.
    await new Promise((r) => setImmediate(r));
    screen.close();
    return { opened, closed: output.slice(opened.length), keys, mice };
  };
  const plainRun = await run();
  assert.match(plainRun.opened, /\x1b\[\?2004h/, 'bracketed paste is on with the screen');
  assert.doesNotMatch(plainRun.opened, /\x1b\[\?1000h/, 'no mouse unless asked');
  assert.deepEqual(plainRun.keys, [{ name: 'paste', text: 'pasted\nline' }], 'a paste across two reads is one key');
  assert.match(plainRun.closed, /\x1b\[\?2004l/);
  const mouseRun = await run({ mouse: true });
  assert.match(mouseRun.opened, /\x1b\[\?1000h.*\x1b\[\?1006h/);
  assert.equal(mouseRun.mice.length, 1);
  assert.deepEqual([mouseRun.mice[0]!.row, mouseRun.mice[0]!.col], [2, 1]);
  assert.match(mouseRun.closed, /\x1b\[\?1006l.*\x1b\[\?1000l/, 'mouse reporting is switched off on close');
});

test('the process-exit restore path switches mouse and paste off', () => {
  let output = '';
  const out = Object.assign(new EventEmitter(), { rows: 5, columns: 10, write: (s: string) => { output += s; return true; } });
  const inp = Object.assign(new EventEmitter(), { isRaw: false, setRawMode: () => {}, resume: () => {}, pause: () => {}, setEncoding: () => {} });
  const before = process.listeners('exit');
  const screen = openScreen(out as unknown as NodeJS.WriteStream, inp as unknown as NodeJS.ReadStream, { mouse: true });
  const restore = process.listeners('exit').find((l) => !before.includes(l))!;
  output = '';
  (restore as () => void)();
  assert.match(output, /\x1b\[\?1000l/);
  assert.match(output, /\x1b\[\?2004l/);
  assert.match(output, /\x1b\[\?1049l/);
  screen.close();
  assert.ok(!process.listeners('exit').includes(restore), 'closing removes the exit hook');
});

test('editor: a paste is one line, Ctrl/Alt arrows move by word', () => {
  const e = createEditor([]);
  edit(e, { name: 'paste', text: 'npm test\nnpm run build\n' });
  assert.equal(e.text, 'npm test npm run build');
  assert.equal(edit(e, { name: 'paste', text: '\r\n' }), undefined, 'a pasted newline does not submit');
  edit(e, { name: 'home' });
  edit(e, { name: 'ctrl-right' });
  assert.equal(e.cursor, 3);
  edit(e, { name: 'ctrl-right' });
  assert.equal(e.cursor, 8);
  edit(e, { name: 'alt', ch: 'b' });
  assert.equal(e.cursor, 4);
  edit(e, { name: 'end' });
  edit(e, { name: 'alt-backspace' });
  assert.equal(e.text.trimEnd(), 'npm test npm run');
});
