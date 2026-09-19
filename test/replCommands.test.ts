// The command vocabulary and what a half-typed line predicts. Nothing here touches a terminal: the
// prompt only has to draw what these functions return.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NO_SUGGESTION, SETTING_KEYS, suggestCommand, suggestPlan, type PredictContext, type Suggestion } from '../src/replCommands.ts';

const ctx: PredictContext = {
  harnesses: ['claude', 'codex', 'fake', 'openai'],
  providers: ['openai', 'deepseek'],
  roles: ['planner', 'worker', 'checker', 'docs', 'reporter'],
  aliases: [
    { name: 'fable', harness: 'claude', model: 'claude-fable-5-1' },
    { name: 'sonnet', harness: 'claude', model: 'sonnet' },
  ],
  runIds: ['2026-01-01-a', '2026-01-02-b'],
  cards: ['card-7'],
  memory: ['a1b2c3d4e5f6'],
};

const words = (s: Suggestion) => s.candidates.map((c) => c.text);
const why = (s: Suggestion, text: string) => s.candidates.find((c) => c.text === text)?.description;

test('goals and unknown commands are not predicted at all', () => {
  for (const line of ['', 'fix the flaky test', ' /mod', '/nope', '/nope x', '/runs ', '/clean x']) {
    assert.deepEqual(suggestCommand(line, ctx), NO_SUGGESTION, JSON.stringify(line));
  }
  assert.deepEqual(suggestCommand('/runs ', ctx), NO_SUGGESTION, 'a command with no arguments predicts nothing');
});

test('the command names complete as they are typed, and describe themselves', () => {
  const all = suggestCommand('/', ctx);
  assert.equal(all.candidates.length, 34);
  assert.equal(all.partial, '/', 'the slash is part of the word being completed');
  assert.equal(all.ghost, '', 'nothing beyond the slash is shared by every command');
  assert.equal(why(all, '/memory'), 'what agents learned: list, add, rm, compact, path');

  assert.deepEqual(words(suggestCommand('/mo', ctx)), ['/model']);
  assert.equal(suggestCommand('/mo', ctx).ghost, 'del', 'Tab takes the rest of the word only');
  assert.deepEqual(words(suggestCommand('/m', ctx)), ['/merge', '/memory', '/model']);
  assert.equal(suggestCommand('/m', ctx).ghost, '', 'three matches share nothing beyond what is typed');
  assert.deepEqual(words(suggestCommand('/MO', ctx)), ['/model'], 'matching ignores case');
  assert.equal(suggestCommand('/MODEL ', ctx).ghost, 'planner ', 'the words offered are lower case as they are');
});

test('a word that is still empty is offered the best value with a space after it', () => {
  assert.equal(suggestCommand('/budget ', ctx).ghost, 'off ');
  assert.equal(suggestCommand('/runs', ctx).ghost, '');
  assert.equal(suggestCommand('/', ctx).ghost, '', 'with nothing to choose from nothing is guessed');
  assert.equal(suggestPlan('').ghost, 'go ', 'Enter dispatches, so the plan prompt offers go');
});

test('/model predicts roles, aliases, backends and the two choices', () => {
  const roles = suggestCommand('/model ', ctx);
  assert.deepEqual(words(roles), ['planner', 'worker', 'checker', 'docs', 'reporter', 'fable', 'sonnet']);
  assert.equal(why(roles, 'fable'), 'claude / claude-fable-5-1');
  assert.equal(why(roles, 'worker'), "the worker's backend and model");
  assert.equal(why(roles, 'reporter'), "the progress reporter's backend and model");

  assert.equal(suggestCommand('/model p', ctx).ghost, 'lanner');
  const backend = suggestCommand('/model planner ', ctx);
  assert.deepEqual(words(backend).slice(0, 4), ['claude', 'codex', 'fake', 'openai']);
  assert.ok(words(backend).includes('auto') && words(backend).includes('reset'));
  assert.equal(backend.ghost, 'claude ');
  assert.deepEqual(words(suggestCommand('/model worker openai ', ctx)), ['auto'], 'a harness can be pinned to its own default');
  assert.deepEqual(suggestCommand('/model planner claude nope', ctx).candidates, []);
  assert.deepEqual(suggestCommand('/model typo ', ctx), NO_SUGGESTION, 'an unknown role has no arguments');
});

test('settings predict their own values, and /set predicts the same vocabulary', () => {
  assert.deepEqual(words(suggestCommand('/set ', ctx)), SETTING_KEYS);
  assert.equal(suggestCommand('/set ', ctx).ghost, 'harness ');
  assert.deepEqual(words(suggestCommand('/set i', ctx)), ['icons']);
  assert.equal(suggestCommand('/set icons ', ctx).ghost, 'nerd ');
  assert.equal(suggestCommand('/set docs ', ctx).ghost, 'on ', 'two values share on, so only that is offered');
  assert.equal(why(suggestCommand('/set dirty ', ctx), 'off'), 'turn it off');
  assert.deepEqual(words(suggestCommand('/harness c', ctx)), ['claude', 'codex']);
  assert.equal(suggestCommand('/harness c', ctx).ghost, '');
  assert.equal(suggestCommand('/harness openai', ctx).ghost, '');
  assert.equal(suggestCommand('/yes ', ctx).ghost, 'on ');
  assert.deepEqual(suggestCommand('/set budget ', ctx).candidates.length, 1);
  assert.deepEqual(suggestCommand('/set nope ', ctx), NO_SUGGESTION);
});

test('run ids, card ids and learned ids come from the repository, newest first', () => {
  const board = suggestCommand('/board ', ctx);
  assert.deepEqual(words(board), ['2026-01-02-b', '2026-01-01-a']);
  assert.equal(why(board, '2026-01-02-b'), 'the latest run');
  assert.equal(board.ghost, '2026-01-02-b ', 'the newest run is what /board shows by default');
  assert.equal(suggestCommand('/board 2026', ctx).ghost, '-01-0', 'runs that start the same way complete as far as they agree');

  const retry = suggestCommand('/retry ', ctx);
  assert.deepEqual(words(retry), ['card-7']);
  assert.equal(why(retry, 'card-7'), 'a card that did not land');
  assert.deepEqual(words(suggestCommand('/retry card-7 ', ctx)), ['2026-01-02-b', '2026-01-01-a'], 'and then the run to retry in');

  assert.deepEqual(words(suggestCommand('/memory rm ', ctx)), ['a1b2c3d4e5f6']);
  assert.equal(suggestCommand('/memory rm a', ctx).ghost, '1b2c3d4e5f6');
  assert.deepEqual(words(suggestCommand('/memory l', ctx)), ['list']);
  assert.deepEqual(suggestCommand('/memory add ', ctx), NO_SUGGESTION, 'a note is free text');

  assert.equal(suggestCommand('/report ', ctx).ghost, '2026-01-02-b ');
  assert.equal(suggestCommand('/report full', ctx).ghost, '');
  assert.deepEqual(suggestCommand('/config ', ctx).candidates.map((c) => c.text), ['save']);
  assert.deepEqual(words(suggestCommand('/provider openai ', ctx)), ['key', 'model']);
  assert.equal(suggestCommand('/provider openai k', ctx).ghost, 'ey');
  assert.deepEqual(words(suggestCommand('/merge ', ctx)), ['2026-01-02-b', '2026-01-01-a']);
});

test('a line past its last argument predicts nothing', () => {
  for (const line of [
    '/docs on ',
    '/board run-b ',
    '/runs 1 ',
    '/config save ',
    '/memory rm a1b2c3d4e5f6 ',
    '/retry card-7 2026-01-02-b ',
    '/provider openai key ',
    '/set docs on ',
    '/model worker claude sonnet ',
    '/report full ',
  ]) {
    assert.deepEqual(suggestCommand(line, ctx), NO_SUGGESTION, JSON.stringify(line));
  }
});

test('the plan prompt predicts the two answers readReply takes, and nothing else', () => {
  const empty = suggestPlan('');
  assert.deepEqual(words(empty), ['go', 'cancel']);
  assert.equal(why(empty, 'go'), 'dispatch the plan as it stands (Enter does the same)');
  assert.equal(empty.ghost, 'go ');
  assert.equal(suggestPlan('c').ghost, 'ancel');
  assert.equal(suggestPlan('go').ghost, '', 'a word that is already complete needs no prediction');
  assert.deepEqual(suggestPlan('go with raylib instead'), NO_SUGGESTION, 'a second word revises the plan');
  assert.equal(suggestPlan('g').ghost, 'o');
  assert.equal(suggestPlan('  ').ghost, 'go ', 'spaces alone are a line that is still empty');
});

test('the help text and the predicted commands are the same list', () => {
  const source = readFileSync(new URL('../src/repl.ts', import.meta.url), 'utf8');
  const head = source.indexOf('const HELP = `');
  const help = source.slice(head, source.indexOf('`;', head));
  const documented = new Set([...help.matchAll(/\/([a-z][a-z-]*)/g)].map((m) => m[1]!));
  const predicted = new Set(suggestCommand('/', ctx).candidates.map((c) => c.text.slice(1)));
  assert.deepEqual([...predicted].filter((name) => !documented.has(name)), [], 'commands missing from /help');
  assert.deepEqual([...documented].filter((name) => !predicted.has(name)), [], 'help lines with no command behind them');
});
