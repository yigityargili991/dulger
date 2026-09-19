import type { Board, Card, CardStatus } from '../types.ts';

/** Consistent state cleanup at each persisted card boundary. */
export function transitionCard(card: Card, status: CardStatus, reason?: string, failure?: Card['failure']): void {
  card.status = status;
  card.reason = reason;
  card.failure = status === 'failed' ? failure ?? 'work' : undefined;
}
export function checkpoint(board: Board, phase: NonNullable<Board['checkpoint']>['phase']): void {
  board.checkpoint = { phase, at: new Date().toISOString() };
}
