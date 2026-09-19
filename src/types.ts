// Core data model for dulger. Everything here is plain JSON so the board can be
// written to disk, edited by hand, and reloaded.

export type CardStatus = 'backlog' | 'in_progress' | 'review' | 'done' | 'failed' | 'blocked' | 'replaced';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type AgentRole = 'planner' | 'worker' | 'checker' | 'docs' | 'reporter';
/** The built-in backends, or the name of any entry under config.providers (an OpenAI-style API). */
export type HarnessName = 'claude' | 'codex' | 'fake' | 'ollama' | 'deepseek' | 'openai' | (string & {});
export type ModelTier = 'low' | 'medium' | 'high';

// ---- Structured results returned by each role (enforced via JSON schema) ----

export interface PlannerResult {
  /** Decisions the planner made where the goal was open (language, framework, scope). */
  assumptions?: string[];
  /** Parts of the goal the planner did not plan, each with the reason. */
  omitted?: string[];
  cards: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
    /** Shell commands dulger runs in the card's worktree before review; exit 0 means pass. */
    verify?: string[];
    tasks: Array<{ id: string; title: string; instructions: string; complexity?: ModelTier }>;
  }>;
}

export interface WorkerResult {
  summary: string;
  filesChanged: string[];
  done: boolean;
  remaining: string[];
  learnings: string[];
}

export interface CheckResult {
  pass: boolean;
  feedback: string[];
  /** Non-blocking review observations; recorded on the card, never sent back as a fix task. */
  notes?: string[];
  summary: string;
}

export interface DocsResult {
  summary: string;
  filesChanged: string[];
}

/** What the progress reporter says about an in-progress card: a human note, plus a flag when something looks wrong. */
export interface ReporterResult {
  note: string;
  /** Empty when nothing looks wrong; set when the agent seems stuck, repeating itself or off the card's scope. */
  attention: string;
}

// ---- Kanban ----

export interface Task {
  complexity?: ModelTier;
  id: string;
  cardId: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  attempts: number;
  sessionId?: string;
  result?: WorkerResult;
  /** Why the last attempt produced no answer (crash, stall, limit); cleared when an attempt answers. */
  error?: string;
  /** Set on tasks dulger appends after a rejection: they address `feedback` instead of implementing new work. */
  kind?: 'fix';
  feedback?: string[];
}

export interface Card {
  worker?: import('./config.ts').RoleConfig;
  guidance?: string[];
  stopped?: boolean;
  worktreeReady?: boolean;
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  /** Commands dulger itself runs before every review; a failure sends the card back without a reviewer. */
  verify: string[];
  /** The latest run of `verify`, in order. */
  verification?: VerificationResult[];
  tasks: Task[];
  status: CardStatus;
  attempts: number;
  branch?: string;
  /** What reviewers said had to change, every round. */
  feedback: string[];
  /** Why dulger itself stopped the card: blocked, replaced, over budget, a step it could not run. */
  reason?: string;
  /** Non-blocking observations from reviews, shown on the board. */
  reviewNotes?: string[];
  /** The final reviewer's summary of what the card does and why it passed or failed. */
  review?: string;
  /** infrastructure = dulger could not run a step; resume retries it, nothing replans it. */
  failure?: 'work' | 'infrastructure';
  summary?: string;
  costUsd: number;
  usage?: Usage;
  /** The progress reporter's latest note while the card runs, and when it was written. */
  progress?: { at: string; note: string; attention?: string };
}

export interface Board {
  settings?: import('./runSettings.ts').SettingsSnapshot;
  checkpoint?: { phase: 'planning' | 'ready' | 'running' | 'paused' | 'stopped' | 'docs' | 'verifying' | 'finished'; at: string };
  finalVerification?: { ref: string; results: VerificationResult[] };
  paused?: boolean;
  runId: string;
  goal: string;
  baseRef: string;
  baseBranch: string;
  runBranch: string;
  createdAt: string;
  cards: Card[];
  docs?: { status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; summary?: string };
  costUsd: number;
  usage?: Usage;
  /** Plan-window utilization as last reported by the harness during this run. */
  rateLimits?: RateLimits;
  /** Times the planner was asked to replan after a card failed. */
  replans?: number;
  /** Set when dulger stopped the run itself (the harness account hit its usage limit); resume clears it. */
  halted?: { reason: string; at: string };
  /** What the planner decided on its own, what it left out, and the session to continue the conversation. */
  plan?: { sessionId?: string; assumptions: string[]; omitted: string[]; revisions: number };
}

/** One command of the verification gate as dulger ran it. */
export interface VerificationResult {
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  /** stdout and stderr, the tail of it when long. */
  output: string;
}

/** Token usage of one agent call or a whole run: uncached input, prompt cache reads and writes, output. */
export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * The harness account's plan windows as last reported during a run (Claude Code sends one reading per
 * call; Codex reports none on its stream). A snapshot, never summed: the latest reading is the truth.
 */
export interface RateLimits {
  at: string;
  status?: string;
  windows: Array<{ name: string; utilization: number; resetsAt?: string }>;
}

// ---- Live agent status (derived from adapter events, shown in the TUI) ----

export type AgentState = 'starting' | 'running' | 'done' | 'failed' | 'stalled';

export interface AgentStatus {
  model?: string;
  id: string;
  role: AgentRole;
  harness: HarnessName;
  cardId?: string;
  taskId?: string;
  state: AgentState;
  currentTool?: string;
  lastMessage?: string;
  turns: number;
  /** The last few things the agent said or did, oldest first. */
  history: string[];
  startedAt: number;
  endedAt?: number;
  costUsd?: number;
}

// Normalised event stream that every adapter produces.
export type AgentEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input?: unknown }
  | { type: 'tool_result' }
  /** The harness refused a command the agent asked to run (its permission mode or allowlist said no). */
  | { type: 'denied'; command: string }
  | { type: 'thinking' }
  | { type: 'turn' }
  /** The harness output something dulger did not expect (format drift); the run goes on. */
  | { type: 'warning'; text: string }
  /** The harness reported the account's plan-window utilization. */
  | { type: 'rate_limit'; limits: RateLimits }
  | { type: 'result'; costUsd?: number; usage?: Usage; output?: unknown; text?: string; isError?: boolean; error?: string };

// Board-level events appended to events.jsonl.
export type BoardEventType =
  | 'planned' | 'replanned' | 'replan_failed'
  | 'card_started' | 'card_review' | 'card_verify_failed' | 'card_check_failed' | 'card_retry' | 'card_conflict' | 'card_blocked' | 'card_done' | 'card_failed'
  | 'task_started' | 'task_done' | 'task_failed' | 'task_retry' | 'learnings'
  | 'docs_started' | 'docs_done' | 'docs_failed' | 'docs_skipped'
  | 'progress' | 'checkpoint' | 'plan_edited' | 'card_stopped' | 'card_guidance' | 'final_verified'
  | 'aborted' | 'halted' | 'finished';

export interface BoardEvent {
  at: string;
  type: BoardEventType;
  cardId?: string;
  taskId?: string;
  message?: string;
  data?: unknown;
}
