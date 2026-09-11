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
        card.reason = `blocked: dependency ${deadDep} did not complete`;
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
/**
 * Put a failed card back to work with one more review round: its pending fix task (the last rejection)
 * runs first, finished tasks and the worktree are kept, and the cards blocked behind it get another chance.
 */
export function retryCard(board: Board, cardId: string): Card {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`no card ${cardId}`);
  if (card.status !== 'failed') throw new Error(`card ${cardId} is ${card.status.replace('_', ' ')}, not failed`);
  card.status = 'backlog';
  card.failure = undefined;
  card.reason = undefined;
  card.attempts = Math.max(0, card.attempts - 1);
  // A card rejected before fix tasks were kept on failure: its uncovered feedback becomes the fix task now.
  const covered = new Set(card.tasks.flatMap((t) => t.feedback ?? []));
  const uncovered = card.feedback.filter((f) => !covered.has(f));
  if (card.tasks.every((t) => t.status === 'done') && uncovered.length) { appendFixTask(card, 'Address review feedback', uncovered); card.status = 'backlog'; }
  for (const t of card.tasks) if (t.status !== 'done') { t.status = 'pending'; t.attempts = 0; }
  for (const c of board.cards) if (c.status === 'blocked') { c.status = 'backlog'; c.reason = undefined; }
  board.halted = undefined;
  if (board.docs?.status === 'done') board.docs = { status: 'pending' };
  return card;
}

/** Put the card back to work with one fix task that carries `feedback`; finished tasks stay finished. */
export function appendFixTask(card: Card, title: string, feedback: string[]): void {
  const n = card.tasks.filter((t) => t.kind === 'fix').length + 1;
  card.tasks.push({
    id: `fix${n}`, cardId: card.id, kind: 'fix', title, feedback,
    instructions: feedback.join('\n'), status: 'pending', attempts: 0,
  });
  card.status = 'in_progress';
}

export function resetInterrupted(board: Board): Card[] {
  const reset: Card[] = [];
  for (const card of board.cards) {
    const infra = card.status === 'failed' && card.failure === 'infrastructure';
    if (card.status !== 'in_progress' && card.status !== 'review' && !infra) continue;
    card.status = 'backlog';
    card.failure = undefined;
    card.reason = undefined;
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
  if (reset.length) for (const card of board.cards) if (card.status === 'blocked') { card.status = 'backlog'; card.reason = undefined; }
  if (board.docs?.status === 'running' || board.halted || (reset.length && board.docs?.status === 'done')) board.docs = { status: 'pending' };
  board.halted = undefined;
  return reset;
}
