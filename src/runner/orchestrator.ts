// The run: plan -> (approval happens in the CLI) -> dispatch ready cards in parallel -> docs.
// Card and docs lifecycles live in card.ts and docs.ts; this file only schedules them.
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { worktreesDir } from '../paths.ts';
import * as store from '../board/store.ts';
import { allTerminal, blockUnreachable, readyCards } from '../board/scheduler.ts';
import { PLANNER_SCHEMA } from '../roles/schemas.ts';
import * as P from '../roles/prompts.ts';
import { markFailed, type AgentRegistry } from './agentProcess.ts';
import { runCard } from './card.ts';
import { yellow } from '../ui/ansi.ts';
import { runDocs } from './docs.ts';
import { createRuntime, type AgentRequest, type RunHooks } from './runtime.ts';
import type { Board, Card, PlannerResult } from '../types.ts';

export type OrchestratorHooks = RunHooks;

/** Warnings shown before the board is dispatched. */
export function planWarnings(cards: Card[]): string[] {
  const out: string[] = [];
  for (const c of cards) {
    const dependants = cards.filter((o) => o.dependsOn.includes(c.id)).length;
    if (c.tasks.length > 3) out.push(`${c.id} has ${c.tasks.length} tasks; a card this big produces a diff one reviewer cannot read, split it`);
    if (dependants >= 3 && c.tasks.length > 2) out.push(`${c.id} has ${c.tasks.length} tasks and ${dependants} cards wait for it; nothing else runs until it lands, so it should be the minimum the others need`);
  }
  return out;
}

export interface Orchestrator {
  board: Board;
  registry: AgentRegistry;
  /** Run the planner and populate the board. With `feedback`, continue the planner's session and revise the board. */
  plan(feedback?: string): Promise<void>;
  /** Run all cards + docs until the board is terminal. */
  execute(): Promise<void>;
  abort(): void;
}

export function createOrchestrator(repoRoot: string, board: Board, config: Config, hooks: OrchestratorHooks = {}): Orchestrator {
  const ctrl = new AbortController();
  const rt = createRuntime(repoRoot, board, config, { ...hooks, halt }, ctrl.signal);
  const { log, save } = rt;

  function halt(reason: string): void {
    if (board.halted) return;
    board.halted = { reason, at: new Date().toISOString() };
    log(yellow(`stopping the run: ${reason}; dulger resume continues it later`));
    save('halted', { message: reason });
    ctrl.abort();
  }

  /** First call: plan the goal. Later calls: revise the board with the person's feedback, in the planner's own session. */
  async function plan(feedback?: string): Promise<void> {
    const revising = feedback !== undefined;
    const revision = revising ? (board.plan?.revisions ?? 0) + 1 : 0;
    log(revising ? `revising the plan (${revision})…` : 'planning…');

    const r = await rt.agent<PlannerResult>('planner', plannerRequest(feedback), { logName: revising ? `planner.rev${revision}` : 'planner' });
    rt.addCost(undefined, r.costUsd, r.usage);
    if (!r.ok || !r.output?.cards?.length) throw new Error(`planner failed: ${r.error ?? 'no cards returned'}`);

    applyPlan(r.output, r.sessionId, revision);
    save('planned', { data: { cards: board.cards.length, revision } });
    log(`${revising ? 'revised' : 'planned'}: ${board.cards.length} cards`);
    for (const w of planWarnings(board.cards)) log(yellow(`plan: ${w}`));
  }

  /** A follow-up in the planner's session when there is one to continue; otherwise a fresh plan, with the feedback appended to the goal. */
  function plannerRequest(feedback?: string): AgentRequest {
    const base = { systemPrompt: P.plannerSystem(config.checker.allowedCommands), cwd: repoRoot, schema: PLANNER_SCHEMA, access: 'readonly' as const };
    const session = board.plan?.sessionId;
    if (feedback !== undefined && session) return { ...base, prompt: P.planRevisionPrompt(feedback), resumeSessionId: session };
    const goal = feedback === undefined ? board.goal : `${board.goal}\n\nThe person ordering the work added: ${feedback}`;
    return { ...base, prompt: P.plannerPrompt(goal, rt.context({ root: repoRoot })) };
  }

  /** Replace the cards with the planner's answer; keep the old ones if the new board is invalid. */
  function applyPlan(output: PlannerResult, sessionId: string | undefined, revision: number): void {
    const previous = board.cards;
    board.cards = store.cardsFromPlan(output);
    try {
      store.validateBoard(board);
    } catch (err) {
      board.cards = previous;
      throw err;
    }
    board.plan = { sessionId, assumptions: output.assumptions ?? [], omitted: output.omitted ?? [], revisions: revision };
  }

  /** Ask the planner for a new set of remaining cards after `failed` cards gave up. Leaves the board as is when it cannot. */
  async function replan(failed: Card[]): Promise<void> {
    const n = (board.replans ?? 0) + 1;
    const waiting = board.cards.filter((c) => c.status === 'backlog' || c.status === 'blocked');
    log(`card${failed.length === 1 ? '' : 's'} ${failed.map((c) => c.id).join(', ')} failed; replanning (${n}/${config.maxReplans})…`);
    const request = {
      prompt: P.replanPrompt(board, failed, waiting, rt.context({ root: repoRoot })),
      systemPrompt: P.replanSystem(board.cards.map((c) => c.id), config.checker.allowedCommands), cwd: repoRoot, schema: PLANNER_SCHEMA, access: 'readonly' as const,
    };
    // A planner that died made no decision, so it does not count against maxReplans.
    let r = await rt.agent<PlannerResult>('planner', request, { logName: `replan${n}` });
    rt.addCost(undefined, r.costUsd, r.usage);
    if (!ctrl.signal.aborted && !r.ok) {
      log(`replan agent failed (${r.error}); trying again`);
      r = await rt.agent<PlannerResult>('planner', request, { logName: `replan${n}.retry` });
      rt.addCost(undefined, r.costUsd, r.usage);
    }
    if (ctrl.signal.aborted) return;
    try {
      if (!r.ok || !r.output) throw new Error(r.error ?? 'no output');
      const { replaced, added } = store.applyReplan(board, r.output);
      save('replanned', { data: { replaced: replaced.map((c) => c.id), added: added.map((c) => c.id) } });
      log(`replanned: ${added.length} new card${added.length === 1 ? '' : 's'}${added.length ? ` (${added.map((c) => c.id).join(', ')})` : ''}, ${replaced.length} replaced`);
    } catch (err) {
      board.replans = n;
      save('replan_failed', { message: (err as Error).message });
      log(`replan failed: ${(err as Error).message}`);
    }
  }

  async function execute(): Promise<void> {
    if (board.cards.length === 0) throw new Error('board has no cards; run plan() first');
    mkdirSync(join(worktreesDir(repoRoot), board.runId), { recursive: true });
    const inFlight = new Map<string, Promise<void>>();
    // Failures present at the start (a resumed run) were dealt with before; only new ones trigger a replan.
    const handledFailures = new Set(board.cards.filter((c) => c.status === 'failed').map((c) => c.id));

    while (!allTerminal(board) && !ctrl.signal.aborted) {
      const failed = board.cards.filter((c) => c.status === 'failed' && !handledFailures.has(c.id));
      for (const c of failed) handledFailures.add(c.id);
      const byWork = failed.filter((c) => c.failure !== 'infrastructure');
      for (const c of failed) if (c.failure === 'infrastructure') log(`card ${c.id} failed on dulger's side, not on its work; dulger resume retries it from its worktree`);
      if (byWork.length && (board.replans ?? 0) < config.maxReplans) await replan(byWork);
      if (ctrl.signal.aborted) break;
      for (const c of blockUnreachable(board)) {
        log(`card ${c.id} ${c.reason}`);
        save('card_blocked', { cardId: c.id, message: c.reason });
      }
      for (const card of readyCards(board, config.concurrency)) {
        inFlight.set(card.id, runCard(rt, card).catch((err) => {
          card.status = 'failed';
          markFailed(rt.registry, card.id);
          card.reason = `internal error: ${(err as Error).message}`;
          log(`card ${card.id} crashed: ${(err as Error).message}`);
          save('card_failed', { cardId: card.id, message: (err as Error).message });
        }).finally(() => inFlight.delete(card.id)));
      }
      if (inFlight.size === 0) {
        if (allTerminal(board)) break;
        throw new Error('scheduler stuck: no runnable cards and nothing in flight');
      }
      await Promise.race(inFlight.values());
    }
    await Promise.all(inFlight.values());
    if (ctrl.signal.aborted) { if (!board.halted) save('aborted'); return; }
    await runDocs(rt);
    try { rmdirSync(join(worktreesDir(repoRoot), board.runId)); } catch { /* not empty: failed worktrees are kept */ }
    save('finished');
  }

  return {
    board, registry: rt.registry, plan, execute,
    abort() { ctrl.abort(); },
  };
}
