import type { AgentEvent, RateLimits, Usage } from '../types.ts';

export interface AdapterRunOptions {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  /** JSON schema the final answer must match. */
  schema?: object;
  /** none = digest-only reporter, readonly = planner/checker, write = worker/docs. */
  access: 'none' | 'readonly' | 'write';
  model?: string;
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  /** Raw event stream from the harness is appended here, one JSON line per event. */
  logFile: string;
  onEvent: (e: AgentEvent) => void;
  signal: AbortSignal;
  /** Bash command prefixes a readonly agent may run (checker running tests). */
  allowedCommands?: string[];
  /**
   * Give write agents the user's MCP servers (config.claude.mcp, on by default); read-only agents never get
   * them. Only the Claude adapter acts on it: Claude Code inlines every MCP tool schema when ToolSearch is
   * unavailable (~70k tokens per read-only agent) and has --strict-mcp-config to skip them. Codex showed no
   * measurable prompt cost from its configured servers under `codex exec`, and its `-c mcp_servers={}`
   * override merges into the config file rather than replacing it, so there is nothing to switch off there.
   */
  mcp?: boolean;
}

export interface AdapterResult {
  ok: boolean;
  /** Parsed structured output (when a schema was given). */
  output?: unknown;
  /** Final plain-text answer. */
  text: string;
  sessionId?: string;
  costUsd?: number;
  /** Token usage by bucket; the only spend figure some harnesses report. */
  usage?: Usage;
  /** The account's plan windows as last reported by this call, when the harness tells. */
  rateLimits?: RateLimits;
  /** Format drift noticed while parsing the harness output; logged, never fatal. */
  warnings?: string[];
  /** Commands the harness refused to run for the agent; the agent worked around them or gave up. */
  denied?: string[];
  exitCode: number;
  error?: string;
}

export interface Adapter {
  capabilities?: import('./capabilities.ts').HarnessCapabilities;
  name: string;
  run(opts: AdapterRunOptions): Promise<AdapterResult>;
}
