// What every step of a run shares: the board and how to persist it, the registry the UI watches,
// memory, prompt context, cost accounting, and one way to run an agent for a role.
import { mkdirSync } from 'node:fs';
import { getAdapter } from '../adapters/index.ts';
import type { AdapterResult, AdapterRunOptions } from '../adapters/types.ts';
import { type Config, roleConfig } from '../config.ts';
import { buildCommonContext, type ContextOptions } from '../context/common.ts';
import { openMemory, type MemoryStore } from '../context/memory.ts';
import * as store from '../board/store.ts';
import { type AgentRegistry, runAgent } from './agentProcess.ts';
import type { AgentRole, Board, BoardEvent, BoardEventType, Card } from '../types.ts';

export interface RunHooks {
  /** Called after every board change. */
  onBoardChange?: (board: Board) => void;
  /** Human-readable progress line. */
  log?: (msg: string) => void;
}

/** What a step passes to run an agent; model, budget, logging and cancellation are filled in per role. */
export type AgentRequest = Omit<AdapterRunOptions, 'onEvent' | 'signal' | 'logFile' | 'model' | 'maxBudgetUsd'>;

export type AgentResult<T> = Omit<AdapterResult, 'output'> & { output?: T };

export interface Runtime {
  repoRoot: string;
  board: Board;
  config: Config;
  registry: AgentRegistry;
  memory: MemoryStore;
  /** Aborted when the run is stopped; every agent is cancelled through it. */
  signal: AbortSignal;
  log(msg: string): void;
  /** Persist the board, append a board event, and notify the UI. Every state change goes through here. */
  save(type: BoardEventType, extra?: Omit<BoardEvent, 'at' | 'type'>): void;
  addCost(card: Card | undefined, cost?: number, tokens?: number): void;
  /** The common prompt context (run, board, learnings, project notes) for a given working directory. */
  context(opts?: ContextOptions): string;
  agent<T>(role: AgentRole, request: AgentRequest, ids: { cardId?: string; taskId?: string; logName: string }): Promise<AgentResult<T>>;
  /**
   * The merge queue: run `fn` while no other card is syncing, reviewing or landing. Only one card
   * at a time may hold it, so what the checker reviews is exactly what lands on the result branch.
   */
  integrate<T>(fn: () => Promise<T>): Promise<T>;
  /** True when another card currently holds the merge queue. */
  integrating(): boolean;
}

export function createRuntime(repoRoot: string, board: Board, config: Config, hooks: RunHooks, signal: AbortSignal): Runtime {
  const registry: AgentRegistry = { statuses: new Map(), onChange: () => hooks.onBoardChange?.(board) };
  const logDir = store.logDir(repoRoot, board.runId);
  mkdirSync(logDir, { recursive: true });
  const memory = openMemory(repoRoot, config.memory);

  async function agent<T>(role: AgentRole, request: AgentRequest, ids: { cardId?: string; taskId?: string; logName: string }): Promise<AgentResult<T>> {
    const rc = roleConfig(config, role);
    const r = await runAgent({
      registry, adapter: getAdapter(rc.harness, config), role, harness: rc.harness,
      cardId: ids.cardId, taskId: ids.taskId, logDir, logName: ids.logName,
      stallTimeoutSec: config.stallTimeoutSec, parentSignal: signal,
      run: { ...request, model: rc.model, maxBudgetUsd: rc.maxBudgetUsd, mcp: config.claude.mcp },
    });
    return { ...r, output: r.output as T | undefined };
  }

  let queue: Promise<unknown> = Promise.resolve();
  let holders = 0;
  function integrate<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => { holders++; try { return await fn(); } finally { holders--; } });
    queue = run.catch(() => {});
    return run;
  }

  return {
    repoRoot, board, config, registry, memory, signal, agent, integrate, integrating: () => holders > 0,
    log: (msg) => hooks.log?.(msg),
    save(type, extra = {}) {
      store.saveBoard(repoRoot, board);
      store.appendEvent(repoRoot, board.runId, { type, ...extra });
      hooks.onBoardChange?.(board);
    },
    addCost(card, cost, tokens) {
      if (cost) {
        board.costUsd += cost;
        if (card) card.costUsd += cost;
      }
      if (tokens) {
        board.tokens = (board.tokens ?? 0) + tokens;
        if (card) card.tokens = (card.tokens ?? 0) + tokens;
      }
    },
    context: (opts = {}) => buildCommonContext(repoRoot, board, memory, opts),
  };
}
