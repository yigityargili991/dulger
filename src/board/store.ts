import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import type { Board, BoardEvent, Card, PlannerResult, Task } from '../types.ts';

export function runDir(repoRoot: string, runId: string): string {
  return join(repoRoot, STATE_DIR, 'runs', runId);
}

export function boardPath(repoRoot: string, runId: string): string {
  return join(runDir(repoRoot, runId), 'board.json');
}

export function logDir(repoRoot: string, runId: string): string {
  return join(runDir(repoRoot, runId), 'logs');
}

export function worktreeDir(repoRoot: string, cardId: string): string {
  return join(repoRoot, STATE_DIR, 'worktrees', cardId);
}

/** Atomic write: write to a temp file, then rename over the target. */
export function saveBoard(repoRoot: string, board: Board): void {
  const dir = runDir(repoRoot, board.runId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(logDir(repoRoot, board.runId), { recursive: true });
  const target = boardPath(repoRoot, board.runId);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n');
  renameSync(tmp, target);
}

export function loadBoard(repoRoot: string, runId: string): Board {
  const board = JSON.parse(readFileSync(boardPath(repoRoot, runId), 'utf8')) as Board;
  validateBoard(board);
  return board;
}

export function listRuns(repoRoot: string): string[] {
  const dir = join(repoRoot, STATE_DIR, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, 'board.json'))).sort();
}

export function appendEvent(repoRoot: string, runId: string, ev: Omit<BoardEvent, 'at'>): void {
  const full: BoardEvent = { at: new Date().toISOString(), ...ev };
  appendFileSync(join(runDir(repoRoot, runId), 'events.jsonl'), JSON.stringify(full) + '\n');
}

/** Turn the planner's output into fresh cards on the board. */
export function cardsFromPlan(plan: PlannerResult): Card[] {
  return plan.cards.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    acceptanceCriteria: c.acceptanceCriteria ?? [],
    dependsOn: c.dependsOn ?? [],
    status: 'backlog',
    attempts: 0,
    feedback: [],
    costUsd: 0,
    tasks: c.tasks.map<Task>((t) => ({
      id: t.id,
      cardId: c.id,
      title: t.title,
      instructions: t.instructions,
      status: 'pending',
      attempts: 0,
    })),
  }));
}

/** Throws with a readable message when the board is structurally broken (e.g. after hand edits). */
export function validateBoard(board: Board): void {
  const ids = new Set<string>();
  for (const card of board.cards) {
    if (!card.id || !/^[A-Za-z0-9_-]+$/.test(card.id)) throw new Error(`card has invalid id: ${JSON.stringify(card.id)}`);
    if (ids.has(card.id)) throw new Error(`duplicate card id: ${card.id}`);
    ids.add(card.id);
    if (!Array.isArray(card.tasks) || card.tasks.length === 0) throw new Error(`card ${card.id} has no tasks`);
    const taskIds = new Set<string>();
    for (const t of card.tasks) {
      if (!t.id) throw new Error(`card ${card.id} has a task without an id`);
      if (taskIds.has(t.id)) throw new Error(`card ${card.id} has duplicate task id ${t.id}`);
      taskIds.add(t.id);
      t.cardId = card.id;
    }
  }
  for (const card of board.cards) {
    for (const dep of card.dependsOn) {
      if (!ids.has(dep)) throw new Error(`card ${card.id} depends on unknown card ${dep}`);
      if (dep === card.id) throw new Error(`card ${card.id} depends on itself`);
    }
  }
  // Cycle check (DFS).
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`dependency cycle: ${[...path, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const dep of byId.get(id)!.dependsOn) visit(dep, [...path, id]);
    state.set(id, 'done');
  };
  for (const c of board.cards) visit(c.id, []);
}
