import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/ui/report.ts';
import { width } from '../src/tui/text.ts';
import type { Board, Card } from '../src/types.ts';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

function card(id: string, extra: Partial<Card>): Card {
  return { id, title: `Card ${id}`, description: '', acceptanceCriteria: [], dependsOn: [], verify: [], status: 'done', attempts: 0, feedback: [], costUsd: 0, tasks: [], ...extra };
}

const board: Board = {
  runId: 'r1', goal: long(40), baseRef: 'abcdef0123', baseBranch: 'main', runBranch: 'dulger/r1', createdAt: '', costUsd: 3.5,
  halted: { reason: 'run budget of $3 reached ($3.50 spent)\nsecond line of the reason', at: '' },
  docs: { status: 'done', summary: 'Updated README.\nAnd the changelog.' },
  cards: [
    card('c1', {
      title: 'A landed card with a long title that goes on and on and on and on and on and on and on',
      attempts: 1, costUsd: 1.25, verify: ['npm test', 'npm run build'],
      verification: [{ command: 'npm test', ok: true, exitCode: 0, durationMs: 10, output: '' }, { command: 'npm run build', ok: true, exitCode: 0, durationMs: 10, output: '' }],
      review: `First sentence of the review.\nSecond paragraph ${long(60)}`,
      reviewNotes: ['note one', `note two ${long(50)}`],
      tasks: [
        { id: 't1', cardId: 'c1', title: 'first', instructions: '', status: 'done', attempts: 1, result: { summary: long(80), filesChanged: ['a.ts', 'b.ts'], done: true, remaining: [], learnings: [] } },
        { id: 'fix1', cardId: 'c1', kind: 'fix', title: 'Address review feedback', feedback: ['x'], instructions: '', status: 'done', attempts: 1, result: { summary: 'fixed', filesChanged: ['a.ts'], done: true, remaining: [], learnings: [] } },
      ],
    }),
    card('c2', { status: 'failed', failure: 'work', attempts: 2, feedback: ['first round', `blocking problem on line one\nmore detail on line two ${long(30)}`], review: 'rejected because', verify: ['npm test'], verification: [{ command: 'npm test', ok: false, exitCode: 1, durationMs: 5, output: 'boom' }] }),
    card('c3', { status: 'blocked', reason: 'blocked: dependency c2 did not complete' }),
  ],
};
const stat = ' a.ts | 10 +++\n b.ts |  2 -\n 2 files changed, 10 insertions(+), 2 deletions(-)';

test('the compact report is short, width-bounded and points at --full', () => {
  const out = strip(buildReport(board, { diffStat: stat, width: 60 }));
  const lines = out.trimEnd().split('\n');
  for (const l of lines) assert.ok(width(l) <= 60, `line too wide: ${l}`);
  assert.match(out, /^Run r1 .*\nGoal: word0 word1 .*…\n/);
  assert.match(out, /\n  c1 A landed card with a long title that goes on and on an…\n     review: First sentence of the review\.\n     spent: \$1\.25 · review rounds: 2 · verified: ✓ 2\n     2 notes\n/, 'a stats line that does not fit breaks instead of losing its tail');
  assert.match(strip(buildReport(board, {})), /\n     spent: \$1\.25 · review rounds: 2 · verified: ✓ 2 · 2 notes\n/, 'and stays on one line when it fits');
  assert.ok(!out.includes('word79') && !out.includes('note one') && !out.includes('files:'), 'no task summaries, notes or file lists');
  assert.match(out, /\nNot landed\n  c2 Card c2 — failed after 2 review rounds\n     last feedback: blocking problem on line one\n     verified: ✗ npm test \(exit 1\)\n  c3 Card c3 — blocked by a failed dependency\n     reason: blocked: dependency c2 did not complete\n/);
  assert.ok(!out.includes('rejected because'), 'no review text for failed cards');
  assert.match(out, /\nDocumentation\n  Updated README\.\n\nChanges\n  2 files changed, 10 insertions\(\+\), 2 deletions\(-\)\n\nNext\n  the run stopped itself: run budget of \$3 reached/);
  assert.match(out, /\n  dulger retry c2 r1\n        # one more review round/, 'a comment that does not fit goes under the command');
  assert.match(out, /dulger resume r1/);
  assert.match(out, /the 2 reviewer notes are worth a follow-up run \(dulger\n  report --full lists them\)/, 'the hint wraps rather than truncates');
  assert.equal(strip(buildReport(board, {})).split('\n')[1]!.length <= 100, true, 'default width is 100');
});

test('the full report has everything, wrapped to the width', () => {
  const out = strip(buildReport(board, { diffStat: stat, width: 60, full: true }));
  const lines = out.trimEnd().split('\n');
  for (const l of lines) assert.ok(width(l) <= 60, `line too wide: ${l}`);
  assert.ok(out.includes('word79'), 'task summaries are there');
  assert.match(out, /     t1 first: word0 word1[^\n]*\n {15}word/, 'a hanging indent follows the label');
  assert.match(out, /     review: First sentence of the review\.\n {13}Second paragraph/, 'paragraph breaks survive');
  assert.match(out, /     note: note one\n     note: note two/);
  assert.match(out, /files: a\.ts, b\.ts/);
  assert.match(out, /review rounds: 2 \(fix tasks: Address review feedback\)/);
  assert.match(out, /verified: ✓ npm test · ✓ npm run build/);
  assert.match(out, /last feedback: blocking problem on line one\n {20}more detail/);
  assert.match(out, /review: rejected because/);
  assert.match(out, /\nChanges\n  a\.ts \| 10 \+\+\+\n  b\.ts \|  2 -\n  2 files changed/);
  assert.match(out, /the run stopped itself: run budget of \$3 reached[\s\S]*line of the reason/);
  assert.match(out, /the 2 reviewer notes above are worth a follow-up run/);
});
