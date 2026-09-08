// The common context every agent gets: run summary, board, selected learnings, user .md files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import type { Board, Card } from '../types.ts';
import { extractPaths, renderLearnings, type MemoryStore } from './memory.ts';

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

/** Files changed by the card's tasks plus existing paths its text mentions. */
export function cardFiles(card: Card, root: string): string[] {
  const changed = card.tasks.flatMap((t) => t.result?.filesChanged ?? []);
  const text = [card.description, ...card.acceptanceCriteria, ...card.tasks.map((t) => `${t.title}\n${t.instructions}`)].join('\n');
  const mentioned = extractPaths(text, root);
  return [...new Set([...changed, ...mentioned])];
}

export interface ContextOptions {
  files?: string[];
  root?: string;
}

const LEARNINGS_NOTE = 'Reported by previous agents on this codebase; verify before relying on them.';

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

export function buildCommonContext(repoRoot: string, board: Board, memory: MemoryStore, opts: ContextOptions = {}): string {
  const learnings = memory.select({ runId: board.runId, files: opts.files, root: opts.root ?? repoRoot });
  const user = readUserContext(repoRoot);
  const sections = [
    section('Run', `- run id: ${board.runId}\n- goal: ${board.goal}\n- result branch: ${board.runBranch}`),
    section('Board', boardSummary(board)),
    learnings.length ? section('Learnings from earlier work', `${LEARNINGS_NOTE}\n\n${renderLearnings(learnings)}`) : '',
    user ? section('Project context', user) : '',
  ];
  return sections.filter(Boolean).join('\n\n');
}
