// Runs one adapter call while keeping a live AgentStatus updated from the event stream,
// with a stall watchdog that kills the process when no events arrive for too long.
import { join } from 'node:path';
import type { Adapter, AdapterResult, AdapterRunOptions } from '../adapters/types.ts';
import type { AgentEvent, AgentRole, AgentStatus, HarnessName } from '../types.ts';

export interface AgentRegistry {
  statuses: Map<string, AgentStatus>;
  /** Called on every status change so the UI can redraw / log. */
  onChange: (status: AgentStatus, event?: AgentEvent) => void;
}

export interface RunAgentOptions {
  registry: AgentRegistry;
  adapter: Adapter;
  role: AgentRole;
  harness: HarnessName;
  cardId?: string;
  taskId?: string;
  logDir: string;
  logName: string;
  stallTimeoutSec: number;
  parentSignal: AbortSignal;
  run: Omit<AdapterRunOptions, 'onEvent' | 'signal' | 'logFile'>;
}

let counter = 0;

export async function runAgent(o: RunAgentOptions): Promise<AdapterResult> {
  const id = `a${++counter}`;
  const status: AgentStatus = {
    id, role: o.role, harness: o.harness, cardId: o.cardId, taskId: o.taskId,
    state: 'starting', turns: 0, startedAt: Date.now(),
  };
  o.registry.statuses.set(id, status);
  o.registry.onChange(status);

  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  o.parentSignal.addEventListener('abort', onParentAbort, { once: true });

  let stalled = false;
  let timer: NodeJS.Timeout | undefined;
  const resetWatchdog = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, o.stallTimeoutSec * 1000);
  };
  resetWatchdog();

  const onEvent = (e: AgentEvent) => {
    resetWatchdog();
    status.state = 'running';
    switch (e.type) {
      case 'text': status.lastMessage = e.text; status.currentTool = undefined; break;
      case 'tool': status.currentTool = e.name; status.lastMessage = describeTool(e); break;
      case 'tool_result': status.currentTool = undefined; break;
      case 'turn': status.turns++; break;
      case 'warning': status.lastMessage = `warning: ${e.text}`; break;
      case 'result': if (e.costUsd !== undefined) status.costUsd = e.costUsd; break;
    }
    o.registry.onChange(status, e);
  };

  let result: AdapterResult;
  try {
    result = await o.adapter.run({ ...o.run, onEvent, signal: ctrl.signal, logFile: join(o.logDir, o.logName + '.jsonl') });
    if (stalled) result = { ...result, ok: false, error: `no output for ${o.stallTimeoutSec}s; killed as stalled` };
    else if (o.parentSignal.aborted) result = { ...result, ok: false, error: 'aborted' };
  } catch (err) {
    result = { ok: false, text: '', exitCode: -1, error: (err as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
    o.parentSignal.removeEventListener('abort', onParentAbort);
  }
  status.endedAt = Date.now();
  status.state = stalled ? 'stalled' : result.ok ? 'done' : 'failed';
  o.registry.onChange(status);
  return result;
}

/** Show a card's finished agents as failed (the card did not make it, e.g. the checker gave up on it). */
export function markFailed(registry: AgentRegistry, cardId: string): void {
  for (const s of registry.statuses.values()) {
    if (s.cardId === cardId && s.state === 'done') s.state = 'failed';
  }
}

function describeTool(e: Extract<AgentEvent, { type: 'tool' }>): string {
  const input = e.input as Record<string, unknown> | string | undefined;
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return e.name;
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? input.prompt;
  return typeof v === 'string' ? v : e.name;
}
