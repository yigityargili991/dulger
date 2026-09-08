// Core data model for usta. Everything here is plain JSON so the board can be
// written to disk, edited by hand, and reloaded.

export type CardStatus = 'backlog' | 'in_progress' | 'review' | 'done' | 'failed' | 'blocked';
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
  summary?: string;
  costUsd: number;
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
  | { type: 'result'; costUsd?: number; output?: unknown; text?: string };

// Board-level events appended to events.jsonl.
export interface BoardEvent {
  at: string;
  type: string;
  cardId?: string;
  taskId?: string;
  message?: string;
  data?: unknown;
}
