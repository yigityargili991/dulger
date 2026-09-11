// What every step of a run shares: the board and how to persist it, the registry the UI watches,
// memory, prompt context, cost accounting, and one way to run an agent for a role.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { getAdapter } from '../adapters/index.ts';
import type { AdapterResult, AdapterRunOptions } from '../adapters/types.ts';
import { type Config, roleConfig } from '../config.ts';
import { buildCommonContext, type ContextOptions } from '../context/common.ts';
import { openMemory, type MemoryStore } from '../context/memory.ts';
import * as store from '../board/store.ts';
import { type AgentRegistry, runAgent } from './agentProcess.ts';
import type { AgentRole, Board, BoardEvent, BoardEventType, Card, Usage } from '../types.ts';
import { yellow } from '../ui/ansi.ts';
import { addUsage } from '../usage.ts';

export interface RunHooks {
  /** Called after every board change. */
  onBoardChange?: (board: Board) => void;
  /** Human-readable progress line. */
  log?: (msg: string) => void;
  /** Stop the run: an agent reported that the account cannot run anything more right now. */
  halt?: (reason: string) => void;
}

export const USAGE_LIMIT = /hit your \w+ limit|usage limit|rate.?limit|too many requests|\b429\b/i;

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
  /** Charge an agent call to the run and, when given, to its card. */
  addCost(card: Card | undefined, cost?: number, usage?: Usage): void;
  /** Run config.worktreeSetup in a freshly created worktree (installs dependencies and the like). */
  setupWorktree(cwd: string): void;
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
    const card = board.cards.find((c) => c.id === ids.cardId);
    const task = card?.tasks.find((t) => t.id === ids.taskId);
    const rc = roleConfig(config, role, { card, task });
    hooks.log?.(`${role}${ids.cardId ? ` ${ids.cardId}${ids.taskId ? `/${ids.taskId}` : ''}` : ''} → ${rc.harness}${rc.model ? ` / ${rc.model}` : ''}`);
    const r = await runAgent({
      registry, adapter: getAdapter(rc.harness, config), role, harness: rc.harness,
      cardId: ids.cardId, taskId: ids.taskId, logDir, logName: ids.logName,
      stallTimeoutSec: config.stallTimeoutSec, parentSignal: signal,
      run: { ...request, model: rc.model, maxBudgetUsd: rc.maxBudgetUsd, mcp: config.claude.mcp },
    });
    for (const w of r.warnings ?? []) hooks.log?.(yellow(`${rc.harness} ${role}: ${w}`));
    if (!r.ok && r.error && USAGE_LIMIT.test(r.error) && !signal.aborted) hooks.halt?.(r.error);
    if (r.denied?.length) hooks.log?.(yellow(`${role}${ids.cardId ? ` ${ids.cardId}` : ''} was denied ${r.denied.length === 1 ? 'a command' : `${r.denied.length} commands`}: ${r.denied.join('; ')}`));
    if (r.rateLimits) board.rateLimits = r.rateLimits; // a snapshot: the latest reading wins
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
    addCost(card, cost, usage) {
      if (cost) {
        board.costUsd += cost;
        if (card) card.costUsd += cost;
      }
      if (usage) {
        board.usage = addUsage(board.usage, usage);
        if (card) card.usage = addUsage(card.usage, usage);
      }
    },
    setupWorktree(cwd) {
      if (!config.worktreeSetup) return;
      try {
        execSync(config.worktreeSetup, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 });
      } catch (err) {
        const e = err as { stderr?: Buffer; message: string };
        const tail = e.stderr?.toString().trim().split('\n').slice(-3).join(' | ') || e.message;
        hooks.log?.(`worktree setup failed in ${cwd}: ${tail}`);
      }
    },
    context: (opts = {}) => buildCommonContext(repoRoot, board, memory, opts),
  };
}
