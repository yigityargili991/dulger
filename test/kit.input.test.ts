// Raw input across reads, mouse reports the views cannot use, and the terminal given back on a signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInputDecoder, openScreen, parseInput, parseKeys, type InputEvent, type Key, type Mouse, type ScreenOptions } from '../src/tui/screen.ts';

const keysOf = (events: InputEvent[]): Key[] => events.flatMap((e) => (e.type === 'key' ? [e.key] : []));
const miceOf = (events: InputEvent[]): Mouse[] => events.flatMap((e) => (e.type === 'mouse' ? [e.mouse] : []));

/** Fake terminal streams; `output` collects what was written. */
function streams(o: { raw?: boolean } = {}) {
  const sink = { output: '' };
  const out = Object.assign(new EventEmitter(), { rows: 10, columns: 40, write: (s: string) => { sink.output += s; return true; } });
  const inp = Object.assign(new EventEmitter(), { isRaw: Boolean(o.raw), setRawMode: (raw: boolean) => { inp.isRaw = raw; }, resume: () => {}, pause: () => {}, setEncoding: () => {} });
  const open = (opts?: ScreenOptions) => openScreen(out as unknown as NodeJS.WriteStream, inp as unknown as NodeJS.ReadStream, opts);
  return { sink, out, inp, open };
}

test('a paste whose end marker is split across two reads ends there, and keys after it are keys again', () => {
  const d = createInputDecoder();
  assert.deepEqual(d('\x1b[200~hello world\x1b[20'), []);
  assert.deepEqual(keysOf(d('1~')), [{ name: 'paste', text: 'hello world' }]);
  assert.deepEqual(keysOf(d('q\x03')), [{ name: 'char', ch: 'q' }, { name: 'ctrl', ch: 'c' }], 'q and Ctrl-C are not swallowed');
  // Split at every place inside the marker, and with the marker in a later read of a long paste.
  for (let cut = 1; cut < 6; cut++) {
    const dd = createInputDecoder();
    const marker = '\x1b[201~';
    assert.deepEqual(dd('\x1b[200~a'), []);
    assert.deepEqual(dd('b'.repeat(5000) + marker.slice(0, cut)), []);
    assert.deepEqual(keysOf(dd(marker.slice(cut) + 'x')), [{ name: 'paste', text: 'a' + 'b'.repeat(5000) }, { name: 'char', ch: 'x' }], `cut after ${cut}`);
  }
});

test('an unterminated paste is taken as it stands after a quiet spell, so it cannot swallow input forever', async () => {
  const d = createInputDecoder();
  d('\x1b[200~no end in sight');
  assert.equal(d.holding(), 'paste');
  assert.deepEqual(keysOf(d.flush()), [{ name: 'paste', text: 'no end in sight' }]);
  assert.equal(d.holding(), undefined);
  assert.deepEqual(keysOf(d('q')), [{ name: 'char', ch: 'q' }]);
  // A paste given up on whose rest then arrives with its end marker: the rest is paste too, not keys.
  d('\x1b[200~stalled');
  d.flush();
  assert.deepEqual(keysOf(d(' rest\rmore\x1b[201~q')), [{ name: 'paste', text: ' rest\rmore' }, { name: 'char', ch: 'q' }]);

  const { inp, open } = streams();
  const screen = open({ pasteMs: 30 });
  const got: Key[] = [];
  screen.onKey((k) => got.push(k));
  try {
    inp.emit('data', '\x1b[200~first part');
    await sleep(15);
    inp.emit('data', ' second part');
    await sleep(15);
    assert.deepEqual(got, [], 'a paste that keeps arriving keeps waiting');
    await sleep(40);
    assert.deepEqual(got, [{ name: 'paste', text: 'first part second part' }]);
    inp.emit('data', 'q');
    assert.deepEqual(got.at(-1), { name: 'char', ch: 'q' }, 'the next key is a key');
  } finally { screen.close(); }
});

test('escape sequences cut by a read are carried to the next read, never typed', () => {
  const d = createInputDecoder();
  assert.deepEqual(d('\x1b'), []);
  assert.deepEqual(keysOf(d('[A')), [{ name: 'up' }], 'an arrow split after ESC');
  assert.deepEqual(d('x\x1b[1;'), [{ type: 'key', key: { name: 'char', ch: 'x' } }]);
  assert.deepEqual(keysOf(d('5C')), [{ name: 'ctrl-right' }]);
  assert.deepEqual(d('\x1b[<0;10'), [], 'an SGR mouse report split in its parameters');
  assert.deepEqual(miceOf(d(';5M')), [{ kind: 'press', button: 'left', row: 4, col: 9, shift: false, alt: false, ctrl: false }]);
  assert.deepEqual(keysOf(d('x\x1b[20')), [{ name: 'char', ch: 'x' }], 'a paste start split');
  assert.deepEqual(keysOf(d('0~rm -rf /\r\x1b[201~')), [{ name: 'paste', text: 'rm -rf /\r' }], 'its text is a paste: no Enter, no letters typed');
  assert.deepEqual(d('\x1bO'), []);
  assert.deepEqual(keysOf(d('P')), [{ name: 'f1' }]);
});

test('a lone ESC is Escape: right away for a whole input, after a short wait on a stream, and never Alt with the next read', async () => {
  assert.deepEqual(parseKeys('\x1b'), [{ name: 'escape' }], 'parseKeys is synchronous and unchanged');
  assert.deepEqual(parseKeys('\x1b\x1b'), [{ name: 'escape' }, { name: 'escape' }]);
  assert.deepEqual(parseKeys('\x1b['), [{ name: 'alt', ch: '[' }], 'Alt-[ as one read');
  assert.deepEqual(parseKeys('\x1b[<0;10'), [], 'a cut-off report given up on is dropped, not typed');
  const d = createInputDecoder();
  assert.deepEqual(d('\x1b'), []);
  assert.equal(d.holding(), 'escape');
  assert.deepEqual(keysOf(d('q')), [{ name: 'escape' }, { name: 'char', ch: 'q' }], 'Esc then q in two reads: not Alt-q');
  d('\x1b\x1b');
  assert.deepEqual(keysOf(d('2')), [{ name: 'escape' }, { name: 'escape' }, { name: 'char', ch: '2' }]);
  d('\x1b');
  assert.deepEqual(keysOf(d.flush()), [{ name: 'escape' }]);
  assert.deepEqual(keysOf(parseInput('\x1bq')), [{ name: 'alt', ch: 'q' }], 'ESC and a key in one read is still Alt');

  const { inp, open } = streams();
  const screen = open();
  const got: Array<{ k: Key; at: number }> = [];
  screen.onKey((k) => got.push({ k, at: Date.now() }));
  try {
    const t0 = Date.now();
    inp.emit('data', '\x1b');
    assert.equal(got.length, 0, 'held for a moment in case the rest follows');
    await sleep(60);
    assert.deepEqual(got.map((x) => x.k), [{ name: 'escape' }]);
    assert.ok(got[0]!.at - t0 < 50, `Escape came after ${got[0]!.at - t0}ms`);
    inp.emit('data', '\x1b');
    inp.emit('data', '[B');
    await sleep(40);
    assert.deepEqual(got.slice(1).map((x) => x.k), [{ name: 'down' }], 'the rest arrived: one key, no Escape');
  } finally { screen.close(); }
});

test('a held ESC is not given up on while the rest of its sequence is already waiting behind a slow handler', async () => {
  // Real I/O: a child writes "x" and ESC, then "[A" a little later; the handler for x is slower than the wait.
  const child = spawn(process.execPath, ['-e', "process.stdout.write('x\\x1b'); setTimeout(() => process.stdout.write('[A'), 30); setTimeout(() => {}, 600)"], { stdio: ['ignore', 'pipe', 'inherit'] });
  const out = Object.assign(new EventEmitter(), { rows: 10, columns: 40, write: () => true });
  const screen = openScreen(out as unknown as NodeJS.WriteStream, child.stdout as unknown as NodeJS.ReadStream);
  const got: Key[] = [];
  screen.onKey((k) => {
    got.push(k);
    if (k.name === 'char' && k.ch === 'x') { const t = Date.now(); while (Date.now() - t < 200) { /* a slow, synchronous handler */ } }
  });
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(got, [{ name: 'char', ch: 'x' }, { name: 'up' }], 'Up, not Escape and two letters');
  } finally { screen.close(); child.kill(); }
});

test('mouse: buttons 8-11 and the sideways wheel are ignored; X10 reports are decoded, never typed', () => {
  const mice = (s: string) => miceOf(parseInput(s));
  assert.deepEqual(mice('\x1b[<128;5;5M\x1b[<129;5;5M\x1b[<130;5;5m'), [], 'back/forward buttons press nothing');
  assert.deepEqual(mice('\x1b[<66;5;5M\x1b[<67;5;5M'), [], 'a sideways swipe does not scroll up');
  assert.deepEqual(mice('\x1b[<64;5;5M\x1b[<65;5;5M').map((m) => m.kind), ['wheel-up', 'wheel-down']);
  assert.deepEqual(parseKeys('\x1b[<128;5;5Mq'), [{ name: 'char', ch: 'q' }]);
  // X10: ESC [ M, then 32 + button, column, row.
  const x10 = (b: number, col: number, row: number) => `\x1b[M${String.fromCharCode(32 + b, 32 + col, 32 + row)}`;
  assert.deepEqual(mice(x10(0, 10, 5)), [{ kind: 'press', button: 'left', row: 4, col: 9, shift: false, alt: false, ctrl: false }]);
  assert.deepEqual(mice(x10(3, 10, 5)).map((m) => [m.kind, m.button]), [['release', 'none']]);
  assert.deepEqual(mice(x10(64, 1, 1)).map((m) => m.kind), ['wheel-up']);
  assert.deepEqual(parseKeys(`${x10(0, 10, 5)}${x10(3, 10, 5)}ok`), [{ name: 'char', ch: 'o' }, { name: 'char', ch: 'k' }], 'nothing of a report is typed');
  assert.deepEqual(parseKeys('\x1b[M���ok'), [{ name: 'char', ch: 'o' }, { name: 'char', ch: 'k' }], 'a report past column 95 is dropped whole');
  const d = createInputDecoder();
  assert.deepEqual(d('\x1b[M !'), [], 'an X10 report split by the read waits');
  assert.deepEqual(miceOf(d('%z')).length, 1);
});

test('SIGTERM, SIGHUP and an outside SIGINT give the terminal back and then end the process as the signal would', () => {
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    const before = process.listeners(sig);
    const { sink, inp, open } = streams();
    const screen = open({ mouse: true });
    const handler = process.listeners(sig).find((l) => !before.includes(l));
    assert.ok(handler, `${sig} is watched while a screen is open`);
    const kills: Array<[number, string | number | undefined]> = [];
    const realKill = process.kill;
    process.kill = ((pid: number, s?: string | number) => { kills.push([pid, s]); return true; }) as typeof process.kill;
    try {
      sink.output = '';
      (handler as (s: NodeJS.Signals) => void)(sig);
    } finally { process.kill = realKill; }
    for (const mode of ['\x1b[?1049l', '\x1b[?1000l', '\x1b[?2004l', '\x1b[?25h', '\x1b[?7h']) assert.ok(sink.output.includes(mode), `${sig}: ${JSON.stringify(mode)} written`);
    assert.equal(inp.isRaw, false, `${sig}: raw mode given back`);
    assert.deepEqual(kills, [[process.pid, sig]], `${sig}: raised again`);
    assert.ok(!process.listeners(sig).includes(handler!), `${sig}: no longer caught, so raising it again ends the process`);
    screen.close();
  }
});

test('a SIGINT someone else handles (the plain run view) is left to them; closing the screen stops watching', () => {
  const theirs = () => {};
  process.on('SIGINT', theirs);
  const before = process.listeners('SIGINT');
  const { sink, inp, open } = streams();
  const screen = open();
  try {
    const mine = process.listeners('SIGINT').find((l) => !before.includes(l))!;
    const realKill = process.kill;
    let killed = false;
    process.kill = (() => { killed = true; return true; }) as typeof process.kill;
    try { sink.output = ''; (mine as (s: NodeJS.Signals) => void)('SIGINT'); } finally { process.kill = realKill; }
    assert.equal(killed, false);
    assert.equal(sink.output, '', 'the screen stays as it is');
    assert.equal(inp.isRaw, true);
  } finally {
    screen.close();
    process.off('SIGINT', theirs);
  }
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) assert.equal(process.listenerCount(sig), 0, `${sig} is not watched once the screen is closed`);
});

test('a second screen on the same terminal takes the input over and hands it back; the terminal leaves full-screen mode once', () => {
  const { sink, inp, out, open } = streams();
  const outer = open({ mouse: true });
  const outerKeys: string[] = [];
  let outerRepaints = 0;
  outer.onKey((k) => outerKeys.push(k.name === 'char' ? k.ch : k.name));
  outer.onResize(() => { outerRepaints++; });
  const inner = open({ mouse: false });
  const innerKeys: string[] = [];
  inner.onKey((k) => innerKeys.push(k.name === 'char' ? k.ch : k.name));
  inp.emit('data', 'a');
  assert.deepEqual([outerKeys, innerKeys], [[], ['a']], 'only the top screen reads');
  sink.output = '';
  outer.paint(['outer frame']);
  assert.equal(sink.output, '', 'the covered screen does not draw');
  inner.close();
  assert.doesNotMatch(sink.output, /\x1b\[\?1049l/, 'still full-screen');
  assert.match(sink.output, /\x1b\[\?1000h/, 'the outer screen\'s mouse mode is back');
  assert.equal(outerRepaints, 1, 'and it is asked to repaint');
  assert.equal(inp.isRaw, true);
  inp.emit('data', 'b');
  assert.deepEqual(outerKeys, ['b']);
  outer.paint(['outer frame']);
  assert.match(sink.output, /outer frame/);
  outer.close();
  assert.match(sink.output, /\x1b\[\?1049l/);
  assert.equal(inp.isRaw, false);
  assert.equal(inp.listenerCount('data'), 0);
  assert.equal(out.listenerCount('resize'), 0);
});
