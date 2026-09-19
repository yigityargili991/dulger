// The progress reporter: while cards run, a lightweight headless agent turns each in-progress card's
// live activity into a one-line note stored on the card and shown under it. It works from the
// activity digest only, so it is one cheap call on the low-tier model per card per interval, and a
// reporter that fails costs the note, never the card.
import { allTerminal } from '../board/scheduler.ts';
import { REPORTER_SCHEMA } from '../roles/schemas.ts';
import * as P from '../roles/prompts.ts';
import type { Runtime } from './runtime.ts';
import type { AgentStatus, Card, ReporterResult } from '../types.ts';

export interface ProgressReporter {
  /** Resolves once the loop has stopped and its last sweep finished. */
  done: Promise<void>;
  /** Stop ticking and cancel in-flight reporter calls. */
  stop(): void;
}

/**
 * A sweep every `progressIntervalSec` seconds (0 disables the reporter): every in-progress card with
 * a live working agent gets one reporter call. The loop ends when the board is terminal, the run is
 * aborted, or `stop()` is called (the orchestrator does that before docs and before returning).
 */
export function startProgressReporter(rt: Runtime): ProgressReporter {
  let stopped = false;
  const ctrl = new AbortController();
  let wake: (() => void) | undefined;
  const sleep = (sec: number) => new Promise<void>((resolve) => {
    const t = setTimeout(() => { wake = undefined; resolve(); }, sec * 1000);
    wake = () => { clearTimeout(t); wake = undefined; resolve(); };
  });
  const counts = new Map<string, number>();
  const done = (async () => {
    while (!stopped && !rt.signal.aborted && rt.config.progressIntervalSec > 0 && !allTerminal(rt.board)) {
      await sleep(rt.config.progressIntervalSec);
      if (stopped || rt.signal.aborted || allTerminal(rt.board)) return;
      const running = rt.board.cards.filter((c) => c.status === 'in_progress');
      await Promise.all(running.map((card) => reportCard(rt, card, counts, ctrl.signal).catch((err) => {
        if (!stopped && !rt.signal.aborted) rt.log(`progress reporter for ${card.id} failed: ${(err as Error).message}`);
      })));
    }
  })();
  return { done, stop() { stopped = true; ctrl.abort(); wake?.(); } };
}

/** One note for one card. Failed calls are logged and tried again next sweep. */
async function reportCard(rt: Runtime, card: Card, counts: Map<string, number>, signal: AbortSignal): Promise<void> {
  const agent = liveWorker(rt, card.id);
  if (!agent) return; // between tasks: nothing live to describe
  const graceSec = Math.min(30, rt.config.progressIntervalSec / 2);
  if (Date.now() - agent.startedAt < graceSec * 1000) return; // just started; the next sweep says something worth reading
  const n = (counts.get(card.id) ?? 0) + 1;
  counts.set(card.id, n);
  const r = await rt.agent<ReporterResult>('reporter', {
    prompt: P.reporterPrompt(card, agent, Date.now(), card.progress?.note),
    systemPrompt: P.reporterSystem(),
    cwd: rt.repoRoot,
    schema: REPORTER_SCHEMA,
    access: 'none',
    signal,
  }, { cardId: card.id, logName: `${card.id}.progress.${n}` });
  rt.addCost(undefined, r.costUsd, r.usage); // run-level service: the card's budget measures its work
  if (signal.aborted || rt.signal.aborted) return;
  if (!r.ok || !r.output?.note?.trim()) {
    if (!rt.signal.aborted) rt.log(`progress reporter for ${card.id} gave no note${r.error ? `: ${r.error}` : ''}`);
    return;
  }
  // The card may have landed, failed or been blocked while the reporter was thinking; a note on a
  // dead card narrates nothing, so it is dropped rather than stored.
  if (card.status !== 'in_progress' && card.status !== 'review') return;
  card.progress = { at: new Date().toISOString(), note: r.output.note.trim(), attention: r.output.attention?.trim() || undefined };
  rt.save('progress', { cardId: card.id, message: card.progress.note });
  rt.log(`${card.id} progress: ${card.progress.note}${card.progress.attention ? ` — attention: ${card.progress.attention}` : ''}`);
}

/** The card's live working agent; reporters never count as the card's own agent. */
export function liveWorker(rt: Runtime, cardId: string): AgentStatus | undefined {
  let found: AgentStatus | undefined;
  for (const s of rt.registry.statuses.values()) {
    if (s.cardId === cardId && s.role === 'worker' && (s.state === 'running' || s.state === 'starting')) found = s;
  }
  return found;
}
