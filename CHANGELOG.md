# Changelog

## 0.1.0 — 2026-09-09

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
- Runs report dollars when the harness does (Claude Code) and tokens for every harness (Codex reports
  no prices).
- Claude Code agents skip the user's MCP servers unless `claude.mcp` is set.
- The checker reviews like a senior engineer: tests are read, not just run; design fit and failure modes
  count; non-blocking notes are recorded on the board instead of costing a rework round.
- Every run ends with a report of what landed (per card summary, files, review verdict and notes,
  failures, docs, diff stat, next steps), saved as `report.md` and printed again by `dulger report`.
- `worktreeSetup` runs a command (e.g. `npm ci`) once in every new worktree.
- The planner is told which commands the checker may run, and the default allow-list includes typecheck,
  lint and build scripts.
