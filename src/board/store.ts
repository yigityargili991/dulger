import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { worktreesDir } from '../paths.ts';
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

export function worktreeDir(repoRoot: string, runId: string, cardId: string): string {
  return join(worktreesDir(repoRoot), runId, cardId);
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
  for (const c of board.cards) {
    // Boards from older versions.
    c.verify ??= [];
    if (c.status === 'failed' && (!c.failure || c.feedback.at(-1) === 'a task failed; see logs')) {
      const agentNeverAnswered = c.tasks.some((t) => t.status === 'failed' && !t.result);
      c.failure = c.feedback.some((f) => /^checker failed to run:/.test(f)) || agentNeverAnswered ? 'infrastructure' : 'work';
    }
  }
  validateBoard(board);
  return board;
}

/** Delete a run's directory (board, events, logs). The caller removes its branch. */
export function removeRun(repoRoot: string, runId: string): void {
  rmSync(runDir(repoRoot, runId), { recursive: true, force: true });
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
    verify: c.verify ?? [],
    status: 'backlog',
    attempts: 0,
    feedback: [],
    costUsd: 0,
    tasks: c.tasks.map<Task>((t) => ({
      id: t.id,
      cardId: c.id,
      title: t.title,
      instructions: t.instructions,
      complexity: t.complexity,
      status: 'pending',
      attempts: 0,
    })),
  }));
}

/**
 * Apply a replan: the planner's cards replace every card that is still waiting (backlog or blocked).
 * Done, running and failed cards stay. New cards get fresh ids when the planner reused one, and
 * references between the new cards follow the rename. Throws (and changes nothing) when the
 * result would not be a valid board.
 */
export function applyReplan(board: Board, plan: PlannerResult): { replaced: Card[]; added: Card[] } {
  const n = (board.replans ?? 0) + 1;
  const taken = new Set(board.cards.map((c) => c.id));
  const rename = new Map<string, string>();
  for (const c of plan.cards) {
    if (!taken.has(c.id)) { taken.add(c.id); continue; }
    let id = `${c.id}-r${n}`;
    for (let k = 2; taken.has(id); k++) id = `${c.id}-r${n}.${k}`;
    rename.set(c.id, id);
    taken.add(id);
  }
  const added = cardsFromPlan({
    cards: plan.cards.map((c) => ({ ...c, id: rename.get(c.id) ?? c.id, dependsOn: (c.dependsOn ?? []).map((d) => rename.get(d) ?? d) })),
  });
  const replaced = board.cards.filter((c) => c.status === 'backlog' || c.status === 'blocked');
  validateBoard({ ...board, cards: [...board.cards, ...added] });
  for (const c of replaced) {
    c.status = 'replaced';
    c.feedback.push(`replaced by replan ${n}`);
  }
  board.cards.push(...added);
  board.replans = n;
  return { replaced, added };
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
      if (t.complexity !== undefined && !['low', 'medium', 'high'].includes(t.complexity)) throw new Error(`task ${card.id}/${t.id} has invalid complexity`);
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
