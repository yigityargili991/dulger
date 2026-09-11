import type { Board, Card, CardStatus } from '../types.ts';

const TERMINAL: ReadonlySet<CardStatus> = new Set(['done', 'failed', 'blocked', 'replaced']);

export function isTerminal(card: Card): boolean {
  return TERMINAL.has(card.status);
}

export function allTerminal(board: Board): boolean {
  return board.cards.every(isTerminal);
}

export function runningCount(board: Board): number {
  return board.cards.filter((c) => c.status === 'in_progress' || c.status === 'review').length;
}

/**
 * Mark backlog cards whose dependencies can never complete as `blocked`.
 * Returns the cards that were newly blocked.
 */
export function blockUnreachable(board: Board): Card[] {
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  const newlyBlocked: Card[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const card of board.cards) {
      if (card.status !== 'backlog') continue;
      const deadDep = card.dependsOn.find((d) => {
        const dep = byId.get(d);
        return dep && (dep.status === 'failed' || dep.status === 'blocked' || dep.status === 'replaced');
      });
      if (deadDep) {
        card.status = 'blocked';
        const why = `blocked: dependency ${deadDep} did not complete`;
        if (card.feedback.at(-1) !== why) card.feedback.push(why);
        newlyBlocked.push(card);
        changed = true;
      }
    }
  }
  return newlyBlocked;
}

/** Backlog cards whose deps are all done, limited by free concurrency slots. Order preserved. */
export function readyCards(board: Board, concurrency: number): Card[] {
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  const free = Math.max(0, concurrency - runningCount(board));
  if (free === 0) return [];
  return board.cards
    .filter((c) => c.status === 'backlog' && c.dependsOn.every((d) => byId.get(d)?.status === 'done'))
    .slice(0, free);
}

/**
 * Prepare a board loaded from disk for `dulger resume`: cards that were being worked on or reviewed
 * when the run stopped, and cards that failed on dulger's side rather than on their work, go back to
 * the backlog with their unfinished tasks pending (finished tasks and their worktrees are kept), and
 * a docs agent that was running is scheduled again.
 * Returns the cards that were reset.
 */
export function resetInterrupted(board: Board): Card[] {
  const reset: Card[] = [];
  for (const card of board.cards) {
    const infra = card.status === 'failed' && card.failure === 'infrastructure';
    if (card.status !== 'in_progress' && card.status !== 'review' && !infra) continue;
    card.status = 'backlog';
    card.failure = undefined;
    if (infra) {
      const before = card.tasks.length;
      card.tasks = card.tasks.filter((t) => t.status === 'done' || t.kind !== 'fix');
      card.attempts = Math.max(0, card.attempts - (before - card.tasks.length));
      for (const t of card.tasks) if (t.status !== 'done') t.attempts = 0;
    }
    for (const t of card.tasks) if (t.status !== 'done') t.status = 'pending';
    reset.push(card);
  }
  // blockUnreachable() re-blocks what is still unreachable.
  if (reset.length) for (const card of board.cards) if (card.status === 'blocked') card.status = 'backlog';
  if (board.docs?.status === 'running' || board.halted) board.docs = { status: 'pending' };
  board.halted = undefined;
  return reset;
}
