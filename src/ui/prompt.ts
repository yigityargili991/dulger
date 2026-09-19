// One line of input from the terminal. A readline interface exists only while a question is open, so
// Ctrl-C reaches the process (and the running agents) at every other time.
//
// While a line is typed it is also predicted: the rest of the word sits dim after the cursor, Tab takes
// it (readline's own completion), and when several words fit a dim list is drawn under the line. The
// drawing is readline's to lose, so it is done defensively: only when the cursor is at the end of the
// line, never across a wrap, and cleared again before readline reads the next key.
import { createInterface, type Interface } from 'node:readline';
import { dim, cursor } from './ansi.ts';
import type { Suggestion } from '../replCommands.ts';
import { fit, width } from '../tui/text.ts';

/** Most recent first, as readline keeps it. Shared by every prompt in the process. */
export const history: string[] = [];

export interface AskOptions {
  /** What the line predicts. Without it nothing is drawn and Tab only offers the history. */
  suggest?(line: string): Suggestion;
  /** Both default to the process streams; the tests pass fakes. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** Like ask(), but what is typed is not echoed. For keys. Reads raw stdin: readline echoes on its own. */
export function askSecret(prompt: string): Promise<string | undefined> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    let buffer = '';
    const done = (answer: string | undefined) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
      resolve(answer);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003' || ch === '\u0004') return done(undefined);
        if (ch === '\r' || ch === '\n') return done(buffer);
        if (ch === '\u007f' || ch === '\b') buffer = buffer.slice(0, -1);
        else if (ch >= ' ') buffer += ch;
      }
    };
    input.on('data', onData);
  });
}

/** Resolve with the line, or undefined on Ctrl-C / Ctrl-D. Undefined immediately when stdin is not a terminal. */
export function ask(prompt: string, o: AskOptions = {}): Promise<string | undefined> {
  const input = o.input ?? process.stdin;
  const output = o.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const rl = createInterface({
      input, output, terminal: true, history: [...history], historySize: 200,
      completer: o.suggest ? (line: string): [string[], string] => {
        if (rl.cursor !== rl.line.length) return [[], ''];
        const s = o.suggest!(line);
        return [s.ghost ? [`${s.partial}${s.ghost}`] : [], s.partial];
      } : undefined,
    });
    const predictor = o.suggest && output.isTTY ? createPredictor(prompt, output, o.suggest, rl, input) : undefined;
    let settled = false;
    const done = (answer: string | undefined) => {
      if (settled) return;
      settled = true;
      predictor?.stop();
      if (answer?.trim() && answer !== history[0]) history.unshift(answer);
      rl.close();
      if (answer === undefined) output.write('\n');
      resolve(answer);
    };
    predictor?.start();
    rl.question(prompt, (answer) => done(answer));
    rl.on('SIGINT', () => done(undefined));
    rl.on('close', () => done(undefined));
  });
}

const MENU_LIMIT = 6;

/** The dim list under the line: what each match does, or a count when more match than are worth listing. */
function menuRows(s: Suggestion, cols: number): string[] {
  if (s.candidates.length < 2 || cols < 20) return [];
  if (s.candidates.length > MENU_LIMIT) return [fit(`  ${s.candidates.length} matches · keep typing to narrow them`, cols)];
  const column = Math.max(...s.candidates.map((c) => c.text.length)) + 2;
  return s.candidates.map((c) => fit(`  ${c.text.padEnd(column)}${c.description}`, cols));
}

interface Predictor {
  /** Clear predictions before readline handles each key. */
  start(): void;
  stop(): void;
}

/**
 * Ghost text and the dim match list. readline's cursor is a model of the line rather than of the screen,
 * so everything drawn after the cursor is taken back before readline writes: the keypress listener here
 * runs first, clears what we own, and redraws on the next tick, once readline has moved on.
 */
function createPredictor(prompt: string, output: NodeJS.WriteStream, suggest: (line: string) => Suggestion, rl: Interface, input: NodeJS.ReadStream): Predictor {
  const head = width(prompt.split('\n').at(-1)!);
  let painted = false;
  let stopped = false;
  let queued = false;

  /** Safe at any time: only what we drew is cleared, and only from where the cursor is standing. */
  const erase = () => {
    if (!painted) return;
    output.write(cursor.clearToEnd);
    painted = false;
  };

  const beforeKey = () => {
    erase();
    scheduleDraw();
  };

  const scheduleDraw = () => {
    if (stopped || queued) return;
    queued = true;
    process.nextTick(() => { queued = false; draw(); });
  };

  const draw = () => {
    if (stopped) return;
    const cols = output.columns && output.columns > 0 ? output.columns : 80;
    const line = rl.line;
    if (rl.cursor !== line.length) return erase();
    const s = suggest(line);
    const used = head + width(line);
    // A line ending on the last column may or may not have wrapped, and a ghost that would wrap cannot
    // be taken back with a cursor move: both are left to readline.
    if (used >= cols) return erase();
    const rows = menuRows(s, cols);
    const ghost = s.ghost && used + width(s.ghost) < cols ? s.ghost : '';
    if (!ghost && !rows.length) return erase();
    let out = ghost ? dim(ghost) + `\x1b[${width(ghost)}D` : '';
    if (rows.length) out += rows.map((row) => `\n${dim(row)}`).join('') + `\x1b[${rows.length}A\x1b[${used + 1}G`;
    painted = true;
    output.write(out);
  };

  return {
    start() {
      input.prependListener('keypress', beforeKey);
      scheduleDraw();
    },
    stop() {
      stopped = true;
      input.off('keypress', beforeKey);
      erase();
    },
  };
}
