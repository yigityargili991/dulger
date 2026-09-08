// The "common context": what every agent in a run gets to see, regardless of role.
//   1. user-authored .usta/context/*.md files (conventions, architecture notes, ...)
//   2. learnings.md, appended by the orchestrator from worker results
//   3. a generated summary of the run: goal + board state
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import type { Board } from '../types.ts';

export function contextDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR, 'context');
}

export function readUserContext(repoRoot: string): string {
  const dir = contextDir(repoRoot);
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `### ${f}\n\n${readFileSync(join(dir, f), 'utf8').trim()}`)
    .join('\n\n');
}

export function appendLearnings(repoRoot: string, cardId: string, learnings: string[]): void {
  const items = learnings.map((l) => l.trim()).filter(Boolean);
  if (items.length === 0) return;
  mkdirSync(contextDir(repoRoot), { recursive: true });
  const file = join(contextDir(repoRoot), 'learnings.md');
  if (!existsSync(file)) appendFileSync(file, '# Learnings\n\nAppended automatically by usta from worker reports.\n');
  appendFileSync(file, `\n<!-- card ${cardId} -->\n` + items.map((l) => `- ${l}`).join('\n') + '\n');
}

export function boardSummary(board: Board): string {
  if (board.cards.length === 0) return '(no cards yet)';
  return board.cards
    .map((c) => {
      const deps = c.dependsOn.length ? ` (after ${c.dependsOn.join(', ')})` : '';
      const summary = c.summary ? ` — ${c.summary}` : '';
      return `- [${c.status}] ${c.id}: ${c.title}${deps}${summary}`;
    })
    .join('\n');
}

export function buildCommonContext(repoRoot: string, board: Board): string {
  const user = readUserContext(repoRoot);
  const parts = [
    `## Run\n\n- run id: ${board.runId}\n- goal: ${board.goal}\n- result branch: ${board.runBranch}`,
    `## Board\n\n${boardSummary(board)}`,
  ];
  if (user) parts.push(`## Project context\n\n${user}`);
  return parts.join('\n\n');
}
