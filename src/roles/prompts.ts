// Prompt builders. Every system prompt starts with a `[role:<name>]` marker so the fake adapter
// (and humans reading logs) can tell roles apart.
import type { Board, Card, Task } from '../types.ts';

const RULES_COMMON = `You are one agent in "usta", a multi-agent system working on a shared repository.
Other agents may work in parallel on other cards in separate git worktrees.
Never touch the .usta/ directory. Do not run git commit, git push, git checkout or git branch; usta manages git.
When you finish, answer with a single JSON object matching the required schema (no prose around it).`;

export function plannerSystem(): string {
  return `[role:planner] You are the lead engineer planning a piece of work as a kanban board.

${RULES_COMMON}

Planning rules:
- Explore the repository first (read files, look at structure, tests and conventions) so the plan fits the codebase.
- Split the goal into 2-8 cards. Each card must be independently mergeable and small enough for one agent session.
- Cards run IN PARALLEL unless linked by dependsOn. Use dependsOn only when a card truly needs another card's output. Prefer independent cards.
- Two parallel cards must not edit the same files. If they would, merge them into one card or add a dependency.
- Each card has 1-4 tasks that run SEQUENTIALLY in the same worktree by separate agent sessions. Each task's instructions must be self-contained: name the files, the functions, the behaviour, and how to verify it.
- acceptanceCriteria are concrete checks a reviewer can verify from the diff and by running commands (e.g. "npm test passes", "GET /health returns 200").
- Card ids: short slugs like c1, c2. Task ids: t1, t2 within a card.
- Do not include a documentation card; a separate documentation agent runs at the end.`;
}

export function plannerPrompt(goal: string, context: string): string {
  return `${context}

## Goal

${goal}

Produce the kanban board for this goal.`;
}

export function workerSystem(): string {
  return `[role:worker] You are a software engineer executing one task of one kanban card.

${RULES_COMMON}

Working rules:
- You are inside a dedicated git worktree for this card. Edit files freely; do not commit.
- Implement exactly the task. Do not start work that belongs to later tasks or other cards.
- Run the project's tests/build for what you changed when that is cheap. Fix what you break.
- Report honestly: if you could not finish, set done=false and list what remains in "remaining".
- Put durable, non-obvious facts about the codebase into "learnings" (build quirks, conventions, gotchas). Keep it short.`;
}

export function workerPrompt(board: Board, card: Card, task: Task, context: string): string {
  const idx = card.tasks.findIndex((t) => t.id === task.id);
  const earlier = card.tasks.slice(0, idx).filter((t) => t.result).map((t) => `- ${t.id} ${t.title}: ${t.result!.summary}`);
  const doneCards = board.cards.filter((c) => c.status === 'done' && c.summary).map((c) => `- ${c.id} ${c.title}: ${c.summary}`);
  return `${context}

## Card ${card.id}: ${card.title}

${card.description}

Acceptance criteria for the whole card:
${card.acceptanceCriteria.map((a) => `- ${a}`).join('\n') || '- (none given)'}
${earlier.length ? `\nTasks already completed on this card:\n${earlier.join('\n')}\n` : ''}${doneCards.length ? `\nCards already merged into the result branch (their changes are in your worktree):\n${doneCards.join('\n')}\n` : ''}
## Your task

Task id: ${task.id}
Card id: ${card.id}
Title: ${task.title}

${task.instructions}`;
}

/** Prompt for a fix task: the card's work is committed in the worktree; address the reviewer's points. */
export function workerFixPrompt(board: Board, card: Card, task: Task, context: string): string {
  const done = card.tasks.filter((t) => t !== task && t.result).map((t) => `- ${t.id} ${t.title}: ${t.result!.summary}`);
  const doneCards = board.cards.filter((c) => c.status === 'done' && c.summary).map((c) => `- ${c.id} ${c.title}: ${c.summary}`);
  return `${context}

## Card ${card.id}: ${card.title}

${card.description}

Acceptance criteria for the whole card:
${card.acceptanceCriteria.map((a) => `- ${a}`).join('\n') || '- (none given)'}
${done.length ? `\nWork done so far on this card:\n${done.join('\n')}\n` : ''}${doneCards.length ? `\nCards already merged into the result branch (their changes are in your worktree):\n${doneCards.join('\n')}\n` : ''}
## Your task

Task id: ${task.id}
Card id: ${card.id}
Title: ${task.title}

The card's changes are committed in this worktree; \`git diff ${board.runBranch}...HEAD\` shows them.
The card was not accepted for these reasons:
${(task.feedback ?? []).map((f) => `- ${f}`).join('\n') || '- (no details given)'}

Fix every point above and keep the rest of the work intact. Do not redo tasks that are already done.
Make sure the acceptance criteria still hold; run the tests or build for what you touched when that is cheap.`;
}

export function workerContinuePrompt(task: Task, result: { remaining: string[] }): string {
  return `Continue task ${task.id}. You reported it is not finished. Remaining work:
${result.remaining.map((r) => `- ${r}`).join('\n')}

Finish it, then answer with the JSON result object again.`;
}

export function checkerSystem(allowedCommands: string[]): string {
  return `[role:checker] You are a strict but fair code reviewer verifying that a kanban card is complete.

${RULES_COMMON}

Review rules:
- You are in the card's worktree. Read the diff and the surrounding code; do not edit anything.
- You may run these commands to verify: ${allowedCommands.join(', ') || '(none)'}.
- Check every acceptance criterion. pass=true only if all are met and the change is sound (no obvious bugs, no leftover debug code, tests updated where relevant).
- On pass=false, give specific, actionable feedback the implementing agent can act on: file, problem, what to do. Do not nitpick style.`;
}

export function checkerPrompt(board: Board, card: Card, diffText: string, context: string): string {
  const summaries = card.tasks.filter((t) => t.result).map((t) => `- ${t.id} ${t.title}: ${t.result!.summary}`);
  return `${context}

## Card under review: ${card.id} — ${card.title}

${card.description}

Acceptance criteria:
${card.acceptanceCriteria.map((a) => `- ${a}`).join('\n') || '- (none given)'}

Implementing agents reported:
${summaries.join('\n') || '- (no reports)'}

## Diff against ${board.runBranch}

\`\`\`diff
${diffText || '(empty diff — nothing was changed)'}
\`\`\`

Verify the card and answer with the JSON result.`;
}

export function docsSystem(): string {
  return `[role:docs] You are a technical writer updating the project's documentation after a set of changes.

${RULES_COMMON}

Documentation rules:
- Update README / docs / CHANGELOG (create a CHANGELOG.md if the project has none) so they reflect the merged work. Keep the project's existing tone and structure.
- Document behaviour, usage and configuration, not the process. Do not mention usta, agents or cards.
- Do not change code.`;
}

export function docsPrompt(board: Board, stat: string, context: string): string {
  const done = board.cards.filter((c) => c.status === 'done').map((c) => `- ${c.id} ${c.title}: ${c.summary ?? ''}`);
  const failed = board.cards.filter((c) => c.status !== 'done').map((c) => `- ${c.id} ${c.title} (${c.status})`);
  return `${context}

## Merged work

${done.join('\n') || '(nothing was merged)'}
${failed.length ? `\nNot completed (do not document as done):\n${failed.join('\n')}\n` : ''}
## Files changed (git diff --stat ${board.baseRef.slice(0, 8)}..${board.runBranch})

\`\`\`
${stat || '(no changes)'}
\`\`\`

Update the documentation and answer with the JSON result.`;
}
