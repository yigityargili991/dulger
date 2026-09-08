import type { AgentEvent } from '../types.ts';

export interface AdapterRunOptions {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  /** JSON schema the final answer must match. */
  schema?: object;
  /** readonly = planner/checker, write = worker/docs. */
  access: 'readonly' | 'write';
  model?: string;
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  /** Raw event stream from the harness is appended here, one JSON line per event. */
  logFile: string;
  onEvent: (e: AgentEvent) => void;
  signal: AbortSignal;
  /** Bash command prefixes a readonly agent may run (checker running tests). */
  allowedCommands?: string[];
}

export interface AdapterResult {
  ok: boolean;
  /** Parsed structured output (when a schema was given). */
  output?: unknown;
  /** Final plain-text answer. */
  text: string;
  sessionId?: string;
  costUsd?: number;
  exitCode: number;
  error?: string;
}

export interface Adapter {
  name: string;
  run(opts: AdapterRunOptions): Promise<AdapterResult>;
}
