import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyCards, blockUnreachable, allTerminal } from '../src/board/scheduler.ts';
import { cardsFromPlan, validateBoard } from '../src/board/store.ts';
import type { Board } from '../src/types.ts';

function board(): Board {
  return {
    runId: 'r', goal: 'g', baseRef: 'x', baseBranch: 'main', runBranch: 'usta/r', createdAt: '', costUsd: 0,
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
