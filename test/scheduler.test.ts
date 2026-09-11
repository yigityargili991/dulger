import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyCards, blockUnreachable, allTerminal, resetInterrupted } from '../src/board/scheduler.ts';
import { applyReplan, cardsFromPlan, validateBoard } from '../src/board/store.ts';
import type { Board } from '../src/types.ts';

function board(): Board {
  return {
    runId: 'r', goal: 'g', baseRef: 'x', baseBranch: 'main', runBranch: 'dulger/r', createdAt: '', costUsd: 0,
    cards: cardsFromPlan({
      cards: [
        { id: 'a', title: 'A', description: '', acceptanceCriteria: [], dependsOn: [], tasks: [{ id: 't1', title: '', instructions: '' }] },
        { id: 'b', title: 'B', description: '', acceptanceCriteria: [], dependsOn: ['a'], tasks: [{ id: 't1', title: '', instructions: '' }] },
        { id: 'c', title: 'C', description: '', acceptanceCriteria: [], dependsOn: [], tasks: [{ id: 't1', title: '', instructions: '' }] },
        { id: 'd', title: 'D', description: '', acceptanceCriteria: [], dependsOn: ['b'], tasks: [{ id: 't1', title: '', instructions: '' }] },
      ],
    }),
  };
}

test('readyCards respects deps and concurrency', () => {
  const b = board();
  assert.deepEqual(readyCards(b, 5).map((c) => c.id), ['a', 'c']);
  assert.deepEqual(readyCards(b, 1).map((c) => c.id), ['a']);
  b.cards[0]!.status = 'in_progress';
  assert.deepEqual(readyCards(b, 1).map((c) => c.id), []);
  b.cards[0]!.status = 'done';
  assert.deepEqual(readyCards(b, 5).map((c) => c.id), ['b', 'c']);
});

test('blockUnreachable cascades through failed deps', () => {
  const b = board();
  b.cards[0]!.status = 'failed';
  const blocked = blockUnreachable(b).map((c) => c.id).sort();
  assert.deepEqual(blocked, ['b', 'd']);
  assert.equal(b.cards[2]!.status, 'backlog');
  assert.equal(allTerminal(b), false);
});

test('validateBoard rejects cycles and unknown deps', () => {
  const b = board();
  validateBoard(b);
  b.cards[0]!.dependsOn = ['d'];
  assert.throws(() => validateBoard(b), /cycle/);
  b.cards[0]!.dependsOn = ['zzz'];
  assert.throws(() => validateBoard(b), /unknown card/);
});

test('resetInterrupted sends interrupted cards back to the backlog and keeps finished tasks', () => {
  const b = board();
  const [a, bb, c, d] = b.cards as [Board['cards'][0], Board['cards'][0], Board['cards'][0], Board['cards'][0]];
  a.status = 'done'; a.tasks[0]!.status = 'done';
  bb.status = 'in_progress';
  bb.tasks.push({ id: 'fix1', cardId: 'b', kind: 'fix', feedback: ['x'], title: 'fix', instructions: 'x', status: 'running', attempts: 1 });
  bb.tasks[0]!.status = 'done';
  c.status = 'review'; c.tasks[0]!.status = 'done';
  d.status = 'failed'; d.tasks[0]!.status = 'failed';
  b.docs = { status: 'running' };

  assert.deepEqual(resetInterrupted(b).map((x) => x.id), ['b', 'c']);
  assert.deepEqual(b.cards.map((x) => x.status), ['done', 'backlog', 'backlog', 'failed']);
  assert.deepEqual(bb.tasks.map((t) => t.status), ['done', 'pending'], 'the fix task is retried, the finished task is kept');
  assert.equal(c.tasks[0]!.status, 'done', 'a card interrupted in review keeps its work and is reviewed again');
  assert.equal(d.tasks[0]!.status, 'failed', 'terminal cards are untouched');
  assert.deepEqual(b.docs, { status: 'pending' });
});

test('resetInterrupted retries a card that failed on dulger\'s side, drops its stale fix task and unblocks its dependants', () => {
  const b = board();
  const [a, bb, c, d] = b.cards as [Board['cards'][0], Board['cards'][0], Board['cards'][0], Board['cards'][0]];
  a.status = 'done'; a.tasks[0]!.status = 'done';
  bb.status = 'failed'; bb.failure = 'infrastructure'; bb.tasks[0]!.status = 'done';
  bb.tasks.push({ id: 'fix1', cardId: 'b', kind: 'fix', feedback: ['checker failed to run: spawn E2BIG'], title: 'fix', instructions: 'x', status: 'failed', attempts: 2 });
  c.status = 'failed'; c.failure = 'work';
  d.status = 'blocked'; d.feedback.push('blocked: dependency b did not complete');

  assert.deepEqual(resetInterrupted(b).map((x) => x.id), ['b']);
  assert.deepEqual(b.cards.map((x) => x.status), ['done', 'backlog', 'failed', 'backlog']);
  assert.equal(bb.failure, undefined);
  assert.deepEqual(bb.tasks.map((t) => t.id), ['t1'], 'the fix task that asked a worker to fix dulger is gone');
  assert.equal(c.status, 'failed', 'a card that failed on its work stays failed');
  assert.deepEqual(blockUnreachable(b), [], 'd is reachable again');
});

test('applyReplan replaces waiting cards, renames reused ids and rejects broken plans', () => {
  const b = board();
  const [a, bb, c, d] = b.cards;
  a!.status = 'failed'; c!.status = 'in_progress'; d!.status = 'blocked';
  assert.throws(() => applyReplan(b, { cards: [{ id: 'x', title: '', description: '', acceptanceCriteria: [], dependsOn: ['nope'], tasks: [{ id: 't1', title: '', instructions: '' }] }] }), /unknown card/);
  assert.deepEqual(b.cards.map((x) => x.status), ['failed', 'backlog', 'in_progress', 'blocked'], 'a rejected plan changes nothing');
  assert.equal(b.replans, undefined);

  const { replaced, added } = applyReplan(b, { cards: [
    { id: 'b', title: 'B again', description: '', acceptanceCriteria: [], dependsOn: ['c'], tasks: [{ id: 't1', title: '', instructions: '' }] },
    { id: 'e', title: 'E', description: '', acceptanceCriteria: [], dependsOn: ['b'], tasks: [{ id: 't1', title: '', instructions: '' }] },
  ] });
  assert.deepEqual(replaced.map((x) => x.id), ['b', 'd']);
  assert.deepEqual(added.map((x) => [x.id, x.dependsOn]), [['b-r1', ['c']], ['e', ['b-r1']]]);
  assert.deepEqual(b.cards.map((x) => `${x.id}:${x.status}`), ['a:failed', 'b:replaced', 'c:in_progress', 'd:replaced', 'b-r1:backlog', 'e:backlog']);
  assert.equal(b.replans, 1);
  assert.equal(allTerminal(b), false);
  assert.deepEqual(readyCards(b, 5).map((x) => x.id), [], 'b-r1 waits for c');
});
