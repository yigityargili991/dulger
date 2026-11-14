// The prediction is drawn with escapes the terminal must undo again, so these tests drive the real
// ask() through fake streams and read the bytes back. Nothing here mocks the drawing code itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ask, history } from '../src/ui/prompt.ts';
import { suggestCommand, suggestPlan, type PredictContext, type Suggestion } from '../src/replCommands.ts';

// readline echoes keys verbatim and never calls the completer when it thinks the terminal is dumb,
// which is what it sees in the test runner. Nothing below would be drawn at all.
process.env.TERM = 'xterm-256color';

const ctx: PredictContext = {
  harnesses: ['claude', 'codex', 'fake', 'openai'],
  providers: ['openai', 'deepseek'],
  roles: ['planner', 'worker', 'checker', 'docs', 'reporter'],
  aliases: [
    { name: 'fable', harness: 'claude', model: 'claude-fable-5-1' },
    { name: 'sonnet', harness: 'claude', model: 'sonnet' },
  ],
  runIds: ['run-a', 'run-b'],
  cards: ['card-7'],
  memory: ['a1b2c3d4e5f6'],
};

const commands = (line: string) => suggestCommand(line, ctx);
/** Escape codes are not part of what these tests are about, and colour is off when stdout is piped. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

interface Session {
  /** What each key wrote, in order. */
  steps: string[];
  /** Everything written before the first key, the prompt included. */
  head: string;
  answer: string | undefined;
}

function fakeInput(tty = true): NodeJS.ReadStream {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode?: boolean): unknown };
  input.isTTY = tty;
  input.setRawMode = () => input;
  return input as unknown as NodeJS.ReadStream;
}

async function session(keys: string[], suggest?: (line: string) => Suggestion, columns = 60, prompt = 'dulger › '): Promise<Session> {
  const chunks: string[] = [];
  const output = {
    isTTY: true,
    columns,
    rows: 24,
    write: (s: unknown) => chunks.push(String(s)) > 0,
    on: () => {}, off: () => {}, once: () => {}, removeListener: () => {}, emit: () => {}, end: () => {},
  } as unknown as NodeJS.WriteStream;
  let answer: string | undefined;
  const input = fakeInput();
  const pending = ask(prompt, { suggest, input, output }).then((a) => { answer = a; });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  await settle();
  const head = chunks.splice(0).join('');
  const steps: string[] = [];
  for (const key of keys) {
    (input as unknown as PassThrough).write(key);
    await settle();
    steps.push(chunks.splice(0).join(''));
  }
  await pending;
  return { steps, head, answer };
}

test('the rest of the word is drawn dim after the cursor, and Tab takes it', async () => {
  const s = await session(['/', 'm', 'o', 'd', '\t', '\r'], commands);
  assert.equal(plain(s.steps[0]!), '/\n  35 matches · keep typing to narrow them\x1b[1A\x1b[11G', 'too many to list, so they are counted');
  assert.ok(plain(s.steps[1]!).includes('\n  /memory  what agents learned: list, add, rm, compact, path'), 'each match says what it does');
  assert.equal(plain(s.steps[2]!), '\x1b[Jodel\x1b[3D', 'clear the old prediction before echoing the key');
  assert.equal(plain(s.steps[3]!), '\x1b[Jdel\x1b[2D');
  assert.equal(plain(s.steps[4]!), '\x1b[Jel', 'clear the ghost before readline inserts the accepted text');
  assert.equal(s.answer, '/model', 'Tab inserted exactly what the ghost showed');
});

test('when several words fit they are listed under the line, and the cursor is put back', async () => {
  const s = await session(['/', 'r', 'e', '\t', '\r'], commands);
  const rows = plain(s.steps[2]!);
  assert.ok(rows.startsWith('\x1b[Je'), 'what was drawn is cleared before readline writes');
  assert.equal((rows.match(/\n/g) ?? []).length, 5, 'one row per match');
  for (const row of ['\n  /review', '\n  /report', '\n  /resume', '\n  /retry', '\n  /replans']) assert.ok(rows.includes(row), row);
  assert.ok(rows.endsWith('\x1b[5A\x1b[13G'), `the cursor ends up after /re again: ${JSON.stringify(rows.slice(-14))}`);
  assert.equal(plain(s.steps[3]!), rows.replace('\x1b[Je', '\x1b[J'), 'Tab has nothing to add, so the same list is redrawn');
  assert.equal(s.answer, '/re');
});

test('a word offered into an empty token brings its own space, and a finished line is left alone', async () => {
  const s = await session([...'/budget ', '\t', '\r'], commands);
  assert.equal(plain(s.steps[7]!), ' off \x1b[4D', 'the value and the space that ends the argument');
  assert.equal(plain(s.steps[8]!), '\x1b[Joff ', 'Tab takes it, and /budget is then past its last argument');
  assert.equal(s.answer, '/budget off ');
});

test('Tab inserts exactly the ghost that was drawn, for every kind of word', async () => {
  for (const line of ['/mod', '/budget ', '/set i', '/model w', '/bo', '/', '/memory r']) {
    const s = await session([...line, '\t', '\r'], commands);
    assert.equal(s.answer, line + commands(line).ghost, JSON.stringify(line));
  }
});

test('a goal is not predicted, and neither is a prompt that has nothing to suggest', async () => {
  const s = await session(['f', 'i', 'x', '\r'], commands);
  assert.deepEqual(s.steps.map(plain), ['f', 'i', 'x', '\r\n'], 'a goal line is only echoed');
  assert.equal(s.answer, 'fix');

  const bare = await session(['/', 'm', 'o', '\r']);
  assert.equal(bare.answer, '/mo');
  assert.equal(plain(bare.steps[2]!), 'o', 'without a suggest function nothing is drawn');
});

test('a cursor that is not at the end of the line is left to readline', async () => {
  const s = await session(['/', 'm', 'o', '\x1b[D', '\r'], commands);
  assert.equal(plain(s.steps[3]!), '\x1b[J\x1b[1D', 'erase before moving left so the typed o remains visible');
  assert.equal(s.answer, '/mo');
});

test('the plan prompt offers go before anything is typed, and cancel completes', async () => {
  const s = await session(['\r'], suggestPlan, 60, 'plan › ');
  const head = plain(s.head);
  assert.ok(head.includes('go \x1b[3D'), 'Enter dispatches, so go is the ghost');
  assert.ok(head.includes('\n  go '), 'and the two answers are listed');
  assert.ok(head.includes('\n  cancel  delete the run and go back to the prompt'));
  assert.ok(head.endsWith('\x1b[2A\x1b[8G'), 'the cursor ends up after the prompt again');
  assert.equal(s.answer, '');

  const typed = await session(['c', '\t', '\r'], suggestPlan, 60, 'plan › ');
  assert.equal(typed.answer, 'cancel', 'Tab completes the word; Enter then takes it');
});

test('a terminal too narrow for the list, or a line ending on the last column, is not drawn into', async () => {
  const narrow = await session(['/', 'r', 'e', '\r'], commands, 19);
  assert.equal(plain(narrow.steps[2]!), 'e', 'no room for a list, so nothing is drawn');

  const edge = await session(['/', 'm', 'o', '\r'], commands, 12);
  assert.ok(!plain(edge.steps[2]!).includes('del'), 'a line that may have wrapped is left alone');
});

test('a terminal that is not one gets no line at all', async () => {
  const chunks: string[] = [];
  const output = { isTTY: true, columns: 60, write: (s: unknown) => chunks.push(String(s)) > 0, on: () => {}, off: () => {}, once: () => {} } as unknown as NodeJS.WriteStream;
  const answer = await ask('dulger › ', { suggest: commands, input: fakeInput(false), output });
  assert.equal(answer, undefined);
  assert.deepEqual(chunks, []);
});

test('Tab does not complete a command with a mid-line cursor', async () => {
  const s = await session(['/model', '\x1b[D', '\x1b[D', '\t', '\r'], commands);
  assert.equal(s.answer, '/model', 'Tab must not insert the prefix completion into the middle');
  assert.equal(plain(s.steps[3]!), '', 'no completion or drawing mid-line');
});

test('Enter clears an unaccepted prediction before advancing to the next line', async () => {
  const s = await session(['/', 'm', 'o', '\r'], commands);
  assert.equal(s.answer, '/mo');
  assert.equal(plain(s.steps[3]!), '\x1b[J\r\n', 'the displayed line must not retain the unaccepted del');
  const plan = await session(['\r'], suggestPlan);
  assert.equal(plan.answer, '');
  assert.equal(plain(plan.steps[0]!), '\x1b[J\r\n', 'clear the whole candidate menu before submission');
});

test('pasted input paints only one menu, and abort clears it', async () => {
  const s = await session(['/re', '\x03'], commands);
  assert.equal((plain(s.steps[0]!).match(/\n  \/report/g) ?? []).length, 1);
  assert.equal(s.answer, undefined);
  assert.equal(plain(s.steps[1]!), '\x1b[J\n');
});

test('prediction respects UTF-16 readline cursor positions and wrapped input', async () => {
  const suggest = (line: string): Suggestion => ({ ghost: 'tail', partial: line, candidates: [] });
  const unicode = await session(['😀', '\t', '\r'], suggest);
  assert.ok(plain(unicode.steps[0]!).includes('tail\x1b[4D'), 'the cursor is at the end after a surrogate pair');
  assert.equal(unicode.answer, '😀tail');
  const menu = (line: string): Suggestion => ({ ghost: '', partial: line, candidates: [
    { text: 'first', description: 'choice one' }, { text: 'second', description: 'choice two' },
  ] });
  const wrapped = await session(['a'.repeat(25), '\r'], menu, 20);
  assert.ok(!plain(wrapped.steps[0]!).includes('choice'), 'no menu on a wrapped line');
});

test('a confirmation recalls nothing typed earlier, and its signal closes it unanswered', async () => {
  const output = { isTTY: true, columns: 60, rows: 24, write: () => true, on: () => {}, off: () => {}, once: () => {}, removeListener: () => {}, emit: () => {}, end: () => {} } as unknown as NodeJS.WriteStream;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  history.unshift('yes');
  try {
    const input = fakeInput();
    const confirm = ask('approve › ', { input, output, history: [] });
    await settle();
    for (const key of ['\x1b[A', '\r']) { (input as unknown as PassThrough).write(key); await settle(); }
    assert.equal(await confirm, '', 'up finds no earlier yes, so Enter sends an empty line');
    assert.equal(history[0], 'yes', 'and the shared history is left alone');
    const controller = new AbortController();
    const pending = ask('approve › ', { input: fakeInput(), output, history: [], signal: controller.signal });
    controller.abort();
    assert.equal(await pending, undefined);
  } finally { history.shift(); }
});
