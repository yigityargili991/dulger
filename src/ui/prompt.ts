// One line of input from the terminal. A readline interface exists only while a question is open, so
// Ctrl-C reaches the process (and the running agents) at every other time.
import { createInterface } from 'node:readline';

/** Most recent first, as readline keeps it. Shared by every prompt in the process. */
export const history: string[] = [];

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
export function ask(prompt: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, history: [...history], historySize: 200 });
    let settled = false;
    const done = (answer: string | undefined) => {
      if (settled) return;
      settled = true;
      if (answer?.trim() && answer !== history[0]) history.unshift(answer);
      rl.close();
      if (answer === undefined) process.stdout.write('\n');
      resolve(answer);
    };
    rl.question(prompt, (answer) => done(answer));
    rl.on('SIGINT', () => done(undefined));
    rl.on('close', () => done(undefined));
  });
}
