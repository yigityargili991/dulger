// Core data model for dulger. Everything here is plain JSON so the board can be
// written to disk, edited by hand, and reloaded.

export type CardStatus = 'backlog' | 'in_progress' | 'review' | 'done' | 'failed' | 'blocked' | 'replaced';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type AgentRole = 'planner' | 'worker' | 'checker' | 'docs';
export type HarnessName = 'claude' | 'codex' | 'fake';

// ---- Structured results returned by each role (enforced via JSON schema) ----

export interface PlannerResult {
  cards: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
    tasks: Array<{ id: string; title: string; instructions: string }>;
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

// ---- Kanban ----

export interface Task {
  id: string;
  cardId: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  attempts: number;
  sessionId?: string;
  result?: WorkerResult;
  /** Set on tasks dulger appends after a rejection: they address `feedback` instead of implementing new work. */
  kind?: 'fix';
  feedback?: string[];
}

export interface Card {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  tasks: Task[];
  status: CardStatus;
  attempts: number;
  branch?: string;
  feedback: string[];
  /** Non-blocking observations from reviews, shown on the board. */
  reviewNotes?: string[];
  /** The final reviewer's summary of what the card does and why it passed or failed. */
  review?: string;
  summary?: string;
  costUsd: number;
  tokens?: number;
}

export interface Board {
  runId: string;
  goal: string;
  baseRef: string;
  baseBranch: string;
  runBranch: string;
  createdAt: string;
  cards: Card[];
  docs?: { status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; summary?: string };
  costUsd: number;
  tokens?: number;
  /** Times the planner was asked to replan after a card failed. */
  replans?: number;
}

// ---- Live agent status (derived from adapter events, shown in the TUI) ----

export type AgentState = 'starting' | 'running' | 'done' | 'failed' | 'stalled';

export interface AgentStatus {
  id: string;
  role: AgentRole;
  harness: HarnessName;
  cardId?: string;
  taskId?: string;
  state: AgentState;
  currentTool?: string;
  lastMessage?: string;
  turns: number;
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
  | { type: 'turn' }
  | { type: 'result'; costUsd?: number; tokens?: number; output?: unknown; text?: string };

// Board-level events appended to events.jsonl.
export type BoardEventType =
  | 'planned' | 'replanned' | 'replan_failed'
  | 'card_started' | 'card_review' | 'card_retry' | 'card_conflict' | 'card_blocked' | 'card_done' | 'card_failed'
  | 'task_started' | 'task_done' | 'task_failed' | 'learnings'
  | 'docs_started' | 'docs_done' | 'docs_failed' | 'docs_skipped'
  | 'aborted' | 'finished';

export interface BoardEvent {
  at: string;
  type: BoardEventType;
  cardId?: string;
  taskId?: string;
  message?: string;
  data?: unknown;
}
