# Changelog

## 0.1.0 — 2026-09-10

First release.

- `dulger run` turns a goal into a kanban board planned by a Claude Code or Codex agent, then executes it
  with parallel workers in per-card git worktrees.
- A checker reviews every card against its acceptance criteria; rejections become fix tasks.
- Review and merge form a merge queue: cards land on `dulger/<runId>` by fast-forward in the state the
  checker approved.
- The planner replans the remaining work when a card fails.
- A documentation agent updates README / docs / CHANGELOG for the merged work.
- Interrupted runs are resumable with `dulger resume`.
- Workers' learnings are stored as structured memory outside the repository and selected per prompt.
- `--harness fake` runs the whole pipeline without spending tokens.
- Runs report dollars when the harness does (Claude Code) and token usage for every harness (Codex
  reports no prices), split into uncached input, cache reads, cache writes and output; the report shows
  the cached share and output per card.
- Claude Code runs also report the account's plan-window utilization (5-hour and 7-day) as last seen,
  in the live header and the report. Codex does not put it on its output stream.
- Workers and the docs agent get the user's MCP servers (off with `claude.mcp: false`); the planner and
  checker never do, since their restricted tool set would inline every schema for tools they may not call.
- The checker reviews like a senior engineer: tests are read, not just run; design fit and failure modes
  count; non-blocking notes are recorded on the board instead of costing a rework round.
- The goal is the contract: the planner must deliver what it asks with the technologies it names, state
  its assumptions and anything it left out, and never substitute something easier. Both lists are shown
  with the board before dispatch.
- `/order` and `dulger order` plan in a conversation with the planner (same session, revisions on your
  feedback) before dispatching.
- `dulger` with no arguments opens an interactive prompt: type goals, merge results between runs,
  slash-commands for boards, reports, memory and settings.
- Every run ends with a report of what landed (per card summary, files, review verdict and notes,
  failures, docs, diff stat, next steps); `dulger report` prints it again.
- A task whose agent crashes, stalls or answers badly is tried again in a fresh session (up to
  `maxAttempts`) instead of failing the card on the first transient error.
- `worktreeSetup` runs a command (e.g. `npm ci`) once in every new worktree.
- The planner is told which commands the checker may run, and the default allow-list includes typecheck,
  lint and build scripts.
