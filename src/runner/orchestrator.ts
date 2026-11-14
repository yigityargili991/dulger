import { checkpoint } from '../board/lifecycle.ts';
import { verifyFinalResult } from './finalVerification.ts';
// The run: plan -> (approval happens in the CLI) -> dispatch ready cards in parallel -> docs.
// Dispatch owns scheduling and live controls; this module coordinates the run phases.
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { worktreesDir } from '../paths.ts';
import * as store from '../board/store.ts';
import { PLANNER_SCHEMA } from '../roles/schemas.ts';
import * as P from '../roles/prompts.ts';
import type { AgentRegistry } from './agentProcess.ts';
import { createDispatcher } from './dispatch.ts';
import { startProgressReporter } from './progress.ts';
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

/** The distinct verify commands of these cards, trimmed. */
export function verifyCommands(cards: Card[]): string[] {
  return [...new Set(cards.flatMap((c) => c.verify.map((v) => v.trim())))];
}

export interface Orchestrator {
  board: Board;
  registry: AgentRegistry;
  /** Run the planner and populate the board. With `feedback`, continue the planner's session and revise the board. */
  plan(feedback?: string): Promise<void>;
  /** Run all cards + docs until the board is terminal. */
  execute(): Promise<void>;
  abort(): void;
  togglePause(): boolean;
  stopCard(id: string): void;
  guideCard(id: string, text: string): void;
}

export function createOrchestrator(repoRoot: string, board: Board, config: Config, hooks: OrchestratorHooks = {}): Orchestrator {
  const ctrl = new AbortController();
  const rt = createRuntime(repoRoot, board, config, { ...hooks, halt }, ctrl.signal);
  const { log, save } = rt;
  const dispatch = createDispatcher(rt, replan, () => ctrl.abort());

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
    checkpoint(board, 'planning');
    save('checkpoint');
    log(revising ? `revising the plan (${revision})…` : 'planning…');

    const r = await rt.agent<PlannerResult>('planner', plannerRequest(feedback), { logName: revising ? `planner.rev${revision}` : 'planner' });
    rt.addCost(undefined, r.costUsd, r.usage);
    if (!r.ok || !r.output?.cards?.length) throw new Error(`planner failed: ${r.error ?? 'no cards returned'}`);

    applyPlan(r.output, r.sessionId, revision);
    checkpoint(board, 'ready');
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

  /**
   * Ask the planner for a new set of remaining cards after `failed` cards gave up. Leaves the board as is
   * when it cannot, or when the person does not approve the verify commands it adds.
   */
  async function replan(failed: Card[]): Promise<void> {
    const n = (board.replans ?? 0) + 1;
    const waiting = board.cards.filter((c) => c.status === 'backlog' || c.status === 'blocked');
    log(`card${failed.length === 1 ? '' : 's'} ${failed.map((c) => c.id).join(', ')} failed; replanning (${n}/${config.maxReplans})…`);
    const request = {
      prompt: P.replanPrompt(board, failed, waiting, rt.context({ root: repoRoot })),
      systemPrompt: P.replanSystem(board.cards.map((c) => c.id), config.checker.allowedCommands, verifyCommands(board.cards)), cwd: repoRoot, schema: PLANNER_SCHEMA, access: 'readonly' as const,
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
      // A dry run on a copy validates the answer and names the cards as they would land.
      const proposed = store.applyReplan(structuredClone(board), r.output).added;
      const unapproved = unapprovedCommands(proposed);
      if (unapproved.length) {
        const approved = await approve(unapproved, proposed.filter((c) => c.verify.some((v) => unapproved.includes(v.trim()))));
        // Stopped while asking, the person made no decision: like a dead planner, it does not count.
        if (ctrl.signal.aborted) return;
        if (!approved) throw new Error(`refused because its new verify command${unapproved.length === 1 ? ' was' : 's were'} not approved: ${unapproved.map((c) => `\`${c}\``).join(', ')}`);
      }
      const { replaced, added } = store.applyReplan(board, r.output);
      save('replanned', { data: { replaced: replaced.map((c) => c.id), added: added.map((c) => c.id) } });
      log(`replanned: ${added.length} new card${added.length === 1 ? '' : 's'}${added.length ? ` (${added.map((c) => c.id).join(', ')})` : ''}, ${replaced.length} replaced`);
    } catch (err) {
      board.replans = n;
      save('replan_failed', { message: (err as Error).message });
      log(`replan failed: ${(err as Error).message}`);
    }
  }

  /**
   * The verify commands in `cards` that nobody approved: on no card of the board (every card got there
   * through an approval, whatever its status now) and not in checker.allowedCommands. Exact matches
   * only: these strings go to a shell, so `npm test; curl x | sh` does not ride on an approved `npm test`.
   */
  function unapprovedCommands(cards: Card[]): string[] {
    const approved = new Set([...verifyCommands(board.cards), ...config.checker.allowedCommands.map((c) => c.trim())]);
    return verifyCommands(cards).filter((c) => !approved.has(c));
  }

  /** The person's go for new verify commands. No hook, a failing one, or the run stopping all mean no; a stopped run never waits on the answer. */
  async function approve(commands: string[], cards: Card[]): Promise<boolean> {
    if (!hooks.approveCommands) return false;
    const signal = ctrl.signal;
    const stopped = new Promise<boolean>((resolve) => {
      if (signal.aborted) resolve(false);
      else signal.addEventListener('abort', () => resolve(false), { once: true });
    });
    return Promise.race([hooks.approveCommands(commands, cards, signal).then((ok) => ok === true, () => false), stopped]);
  }

  async function execute(): Promise<void> {
    if (board.cards.length === 0) throw new Error('board has no cards; run plan() first');
    mkdirSync(join(worktreesDir(repoRoot), board.runId), { recursive: true });
    checkpoint(board, 'running');
    save('checkpoint');
    const progress = startProgressReporter(rt);
    try {
      await dispatch.run();
    } finally {
      progress.stop();
      await progress.done;
      // Cancelled and discarded notes still cost tokens, including on halted runs.
      if (ctrl.signal.aborted) checkpoint(board, 'stopped');
      store.saveBoard(repoRoot, board);
    }
    if (ctrl.signal.aborted) { if (!board.halted) save('aborted'); return; }
    checkpoint(board, 'docs');
    save('checkpoint');
    await runDocs(rt);
    if (ctrl.signal.aborted) { checkpoint(board, 'stopped'); save('aborted'); return; }
    checkpoint(board, 'verifying');
    save('checkpoint');
    await verifyFinalResult(rt);
    try { rmdirSync(join(worktreesDir(repoRoot), board.runId)); } catch { /* not empty: failed worktrees are kept */ }
    // A retry or resume writes them afresh, so a finished run keeps no sandbox settings or temp dirs.
    if (!ctrl.signal.aborted) rt.sandbox.dispose();
    checkpoint(board, ctrl.signal.aborted ? 'stopped' : 'finished');
    save(ctrl.signal.aborted ? 'aborted' : 'finished');
  }

  return {
    board, registry: rt.registry, plan, execute,
    abort() { ctrl.abort(); },
    togglePause: dispatch.togglePause,
    stopCard: dispatch.stopCard,
    guideCard: dispatch.guideCard,
  };
}
