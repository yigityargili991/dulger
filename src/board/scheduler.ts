import type { Board, Card, CardStatus } from '../types.ts';

const TERMINAL: ReadonlySet<CardStatus> = new Set(['done', 'failed', 'blocked']);

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
        return dep && (dep.status === 'failed' || dep.status === 'blocked');
      });
      if (deadDep) {
        card.status = 'blocked';
        card.feedback.push(`blocked: dependency ${deadDep} did not complete`);
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
 * Prepare a board loaded from disk for `usta resume`: cards that were being worked on or reviewed
 * when the run stopped go back to the backlog with their unfinished tasks pending (finished tasks
 * and their worktrees are kept), and a docs agent that was running is scheduled again.
 * Returns the cards that were reset.
 */
export function resetInterrupted(board: Board): Card[] {
  const reset: Card[] = [];
  for (const card of board.cards) {
    if (card.status !== 'in_progress' && card.status !== 'review') continue;
    card.status = 'backlog';
    for (const t of card.tasks) if (t.status !== 'done') t.status = 'pending';
    reset.push(card);
  }
  if (board.docs?.status === 'running') board.docs = { status: 'pending' };
  return reset;
}
