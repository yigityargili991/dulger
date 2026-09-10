# Changelog

## Unreleased

- The verification gate: every card names the commands that prove it (`verify`, chosen by the planner
  from the project's real build, test and lint commands). dulger runs them itself after the card's work
  is committed and synced; a failure sends the card back with the output before any reviewer runs.
  Results are on the board, in the reviewer's prompt, in the TUI and in the report. `verifyTimeoutSec`
  bounds each command.
- The reviewer's allow-list includes the card's verify commands, and `cargo build`, `cargo check`,
  `cargo clippy`, `go build` and `go vet` by default. The reviewer is told to report criteria it could
  not check as unverified rather than accept the implementer's word.
- Commands Claude Code refuses to run for the planner or reviewer are logged, shown in the agent's
  history, and recorded as a review note on the card.

## 0.2.1 — 2026-09-10

- `dulger init [path]`: `git init` when needed plus a first commit, so a fresh directory is ready for runs.
  Outside a repository, or in one without commits, dulger now says so in one line instead of a stack trace.
- Every setting is its own prompt command (`/harness`, `/model`, `/concurrency`, `/attempts`, `/replans`,
  `/docs`, `/yes`, `/quiet`, `/dirty`, `/tui`, `/icons`); with no argument they show the current value.
  `/set` remains as an alias.

## 0.2.0 — 2026-09-10

- A full-screen run view on terminals: cards as columns with progress and the agent's current action,
  the agents and the log below, keyboard navigation, and an open-card view with tasks, review remarks
  and the agent's recent actions. The dispatch pause and the `/order` conversation happen inside it.
  Nerd Font icons on terminals that usually have one, Unicode elsewhere (`tui.icons`, `DULGER_ICONS`).
- `dulger run` accepts plan revisions at its approval pause, the way `dulger order` does.
- First dependencies: `chalk` (truecolor with fallbacks) and `string-width` (wide characters and icons
  line up in the columns).

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
