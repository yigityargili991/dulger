// Card scheduling and live controls share ownership of active card lifetimes.
import { checkpoint, transitionCard } from '../board/lifecycle.ts';
import { allTerminal, blockUnreachable, readyCards } from '../board/scheduler.ts';
import { markFailed } from './agentProcess.ts';
import { runCard } from './card.ts';
import type { Runtime } from './runtime.ts';
import type { Card } from '../types.ts';

export function createDispatcher(rt: Runtime, replan: (failed: Card[]) => Promise<void>, abort: () => void) {
  const { board, config, signal, log, save } = rt;
  const controllers = new Map<string, AbortController>();
  const inFlight = new Map<string, Promise<void>>();
  let wake: (() => void) | undefined;
  const notify = () => wake?.();

  async function executeCard(card: Card, cardSignal: AbortSignal): Promise<void> {
    try {
      const cardRt: Runtime = {
        ...rt, signal: cardSignal,
        agent(role, request, ids) {
          const signal = request.signal ? AbortSignal.any([cardSignal, request.signal]) : cardSignal;
          return rt.agent(role, { ...request, signal }, ids);
        },
      };
      await runCard(cardRt, card);
    } catch (err) {
      const message = (err as Error).message;
      transitionCard(card, 'failed', `internal error: ${message}`, 'infrastructure');
      markFailed(rt.registry, card.id);
      log(`card ${card.id} crashed: ${message}`);
      save('card_failed', { cardId: card.id, message });
    } finally {
      if (card.stopped && card.status !== 'done') {
        transitionCard(card, 'failed', 'Stopped by user; retry this card to continue.');
        save('card_stopped', { cardId: card.id });
      }
      controllers.delete(card.id);
      inFlight.delete(card.id);
      notify();
    }
  }

  function dispatchReadyCards(): void {
    for (const card of blockUnreachable(board)) {
      log(`card ${card.id} ${card.reason}`);
      save('card_blocked', { cardId: card.id, message: card.reason });
    }
    for (const card of readyCards(board, config.concurrency)) {
      const controller = new AbortController();
      controllers.set(card.id, controller);
      inFlight.set(card.id, executeCard(card, AbortSignal.any([signal, controller.signal])));
    }
  }

  async function handleFailures(handled: Set<string>): Promise<void> {
    const failed = board.cards.filter((card) => card.status === 'failed' && !handled.has(card.id));
    for (const card of failed) {
      handled.add(card.id);
      if (card.failure === 'infrastructure') log(`card ${card.id} failed on dulger's side, not on its work; resuming the run retries it from its worktree`);
    }
    const byWork = failed.filter((card) => card.failure !== 'infrastructure' && !card.stopped);
    if (byWork.length && (board.replans ?? 0) < config.maxReplans) await replan(byWork);
  }

  async function run(): Promise<void> {
    // Resumed failures have already been handled; only new failures trigger replanning.
    const handled = new Set(board.cards.filter((card) => card.status === 'failed').map((card) => card.id));
    signal.addEventListener('abort', notify);
    try {
      while ((!allTerminal(board) || board.paused) && !signal.aborted) {
        if (board.paused) {
          await new Promise<void>((resolve) => { wake = resolve; if (signal.aborted) resolve(); });
          wake = undefined;
          continue;
        }
        await handleFailures(handled);
        if (signal.aborted) break;
        dispatchReadyCards();
        if (!inFlight.size) {
          if (allTerminal(board)) break;
          throw new Error('scheduler stuck: no runnable cards and nothing in flight');
        }
        await Promise.race(inFlight.values());
      }
      await Promise.all(inFlight.values());
    } catch (err) {
      abort();
      await Promise.allSettled(inFlight.values());
      throw err;
    } finally {
      signal.removeEventListener('abort', notify);
      wake = undefined;
    }
  }

  return {
    run,
    togglePause() {
      board.paused = !board.paused;
      checkpoint(board, board.paused ? 'paused' : 'running');
      save('checkpoint');
      log(board.paused ? 'Scheduling paused; active cards continue. Press p to resume.' : 'Scheduling resumed.');
      notify();
      return board.paused;
    },
    stopCard(id: string) {
      const card = board.cards.find((c) => c.id === id);
      if (!card || !['backlog', 'in_progress', 'review'].includes(card.status)) return;
      card.stopped = true;
      const controller = controllers.get(id);
      if (controller) controller.abort();
      else transitionCard(card, 'failed', 'Stopped by user; retry this card to continue.');
      save('card_stopped', { cardId: id });
      log(`Stopping ${id}; completed work is kept for retry.`);
      notify();
    },
    guideCard(id: string, text: string) {
      const card = board.cards.find((c) => c.id === id);
      if (!card || !text.trim() || ['done', 'replaced'].includes(card.status)) return;
      card.guidance = [...(card.guidance ?? []), text.trim()];
      save('card_guidance', { cardId: id });
      log(`Instructions saved for ${id}'s next worker attempt; an active call keeps its current instructions.`);
    },
  };
}
