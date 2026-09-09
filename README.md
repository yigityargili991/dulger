# dulger

**dulger** (Turkish *dülger*: carpenter) is a small, dependency-free TypeScript framework that turns one
goal into a kanban board and has a crew of coding agents work through it. It is a *wrapper*: every agent
is a headless [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex)
process spawned with a prompt, a working directory and a JSON schema for its answer. dulger itself never
calls an LLM API.

```
dulger run "Add CSV export to the reports page"
```

1. **Planner** (the main agent) explores the repo and writes a kanban board: cards with acceptance
   criteria and 1–4 sequential tasks each, plus dependencies between cards.
2. You review the board (edit the JSON if you like) and press Enter.
3. **Workers** execute tasks. Every card gets its own git branch and worktree, so cards run in parallel
   without touching each other. A worker that reports `done: false` is resumed in the same session.
4. A **checker** reviews each finished card the way a senior engineer reviews a pull request: it runs
   the project's checks, reads the tests and the surrounding code, and judges correctness, failure modes
   and fit with the codebase, not only the acceptance criteria. Style remarks and pre-existing problems
   go into non-blocking *notes* shown on the board. A rejection appends a *fix task* to the card: one worker session that addresses the reviewer's
   points in the same worktree, without redoing the finished tasks. The card is then reviewed again,
   up to `maxAttempts` rounds. If syncing the result branch into the card conflicts with work other
   cards landed meanwhile, a fix task resolves the conflicts before the review; that does not count as
   a review round.
5. Review and merge form a *merge queue*: one card at a time syncs the result branch into its
   worktree, is reviewed in that combined state, and lands on `dulger/<runId>` by fast-forward. What
   the checker approves is exactly what lands.
6. When a card fails, the **planner replans**: it sees what merged, what is still running, what failed
   and why, and the cards that were waiting, and returns a new set of cards for the remaining work.
   Waiting cards are replaced; done and running cards are never touched. After `maxReplans`
   replans, a failed card simply blocks its dependents.
7. A **documentation agent** updates README / docs / CHANGELOG for the merged work.
8. A live terminal table shows the board and every agent's state, current tool and last message.

Your checkout is never modified: the result lands on `dulger/<runId>` for you to review and merge.

## Requirements

- Node **24+** (the code is TypeScript run directly by Node; no build step)
- `git`
- `claude` and/or `codex` on your `PATH`, logged in

## Install

From a checkout:

```sh
git clone <this repo> dulger && cd dulger
npm install          # only installs typescript for `npm run typecheck`
npm link             # puts `dulger` on your PATH (or run `node src/cli.ts`)
```

Or from a tarball: `npm pack` produces `dulger-<version>.tgz`, and `npm install -g dulger-<version>.tgz`
installs the `dulger` command. There is no build step either way: `bin/dulger.js` strips the types of
dulger's own files at load time, because Node refuses to do that for packages under `node_modules`.

## Usage

```
dulger run "<goal>" [options]     plan a board for the goal, then execute it
dulger resume [runId]             continue an interrupted run
dulger board [runId]              print a run's board
dulger runs                       list runs
dulger clean                      remove leftover worktrees and wip branches
dulger memory [list|add|rm|compact|path]   inspect and curate what agents learned about the repo

--harness <claude|codex|fake>   backend for all roles (default: claude)
--concurrency <n>               parallel cards (default: 3)
--max-attempts <n>              review rounds per card (default: 2)
--max-replans <n>               replans after a card failed (default: 1)
--model <name>                  model for all roles
--yes                           skip the board approval pause
--no-docs                       skip the documentation agent
--merge                         merge the result branch into the current branch when done
--allow-dirty                   run even with uncommitted changes
--repo <path>                   repository to work in (default: cwd)
--quiet                         no live table, log lines only
--version                       print dulger's version
```

Try it without spending tokens: `dulger run --harness fake --yes "demo"` in any git repo.

## Configuration

Optional `<repo>/.dulger/config.json`; CLI flags override it.

```json
{
  "harness": "claude",
  "concurrency": 3,
  "maxAttempts": 2,
  "maxReplans": 1,
  "maxContinuations": 2,
  "stallTimeoutSec": 600,
  "docs": true,
  "roles": {
    "planner": { "harness": "claude", "model": "opus" },
    "worker":  { "harness": "codex" },
    "checker": { "maxBudgetUsd": 1 }
  },
  "checker": { "allowedCommands": ["npm test", "npm run typecheck", "pytest"] },
  "worktreeSetup": "npm ci",
  "claude": { "mcp": false },
  "codex": { "bypassSandbox": false },
  "memory": { "location": "user", "maxItems": 40, "maxChars": 6000 }
}
```

Roles can mix harnesses: plan with Claude, implement with Codex, review with Claude.

`checker.allowedCommands` is the complete list of shell commands the reviewer may run (default: `npm test`,
`npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`, `pytest`, `cargo test`, `go test`).
The planner is told this list so that acceptance criteria only rely on commands the reviewer can run.

`worktreeSetup` runs once in every new worktree before its first agent, from the worktree's root.
Worktrees are fresh checkouts, so without it every worker starts by installing dependencies itself.
A failing setup command is logged and the card goes ahead anyway.

## Common context

Every agent's prompt starts with the run summary and the board, followed by two kinds of context:

**Project context you write.** Everything in `<repo>/.dulger/context/*.md` is included verbatim:
conventions, architecture notes, "how to run the tests", anything you would tell a new teammate.
This directory is meant to be committed so the whole team shares it (dulger excludes the rest of
`.dulger/` from git but leaves `context/` and `config.json` visible).

**Memory the agents build.** Workers report `learnings` (non-obvious facts about the codebase) and
dulger stores them as one JSON record per line, with the run, card, harness, and the files each
learning is about. Identical learnings are merged rather than repeated. When a prompt is built, dulger
picks the learnings worth including instead of dumping all of them: learnings from the current run
first, then learnings about the files the card touches, then the most reported ones, within
`memory.maxItems` / `memory.maxChars`. Learnings whose files no longer exist are skipped.

By default the memory file lives outside the repository in `$XDG_DATA_HOME/dulger/<project>/memory.jsonl`
(`~/.local/share/dulger/…`). `<project>` is the normalised `origin` URL (so every clone of a repository
shares one memory and forks get their own) or, without a remote, the checkout path. Memory is never
shared between different projects. Set `"memory": { "location": "repo" }` to keep it at `.dulger/memory.jsonl` instead,
or `DULGER_DATA_DIR` to move the whole data directory. `dulger memory` lists the learnings with their ids;
`rm` deletes one, `add` records one by hand, `compact` drops the stale ones, `path` prints the file.

## What lives where

```
<repo>/.dulger/
  config.json                 optional configuration (committable)
  context/*.md                project context you write (committable)
  runs/<runId>/board.json     the kanban — source of truth, editable, resumable
  runs/<runId>/events.jsonl   every state transition
  runs/<runId>/logs/*.jsonl   raw event stream of every agent process

~/.local/share/dulger/<project>/          <project> = origin URL or checkout path ($XDG_DATA_HOME, DULGER_DATA_DIR)
  memory.jsonl                          learnings reported by workers
  worktrees/<runId>/<cardId>/           per-card git worktrees (removed when the card merges; kept on failure)
```

Worktrees live outside the checkout so tools that walk the repository (test runners, linters, type
checkers, the agents' own searches) never see other cards' copies of the code.

Git branches: `dulger/<runId>` is the result; `dulger-wip/<runId>/<cardId>` are per-card work branches
that disappear when the card merges. `dulger clean` removes leftover worktrees and wip branches.
`.dulger/*` is added to `.git/info/exclude` automatically, with `context/` and `config.json`
re-included so they can be committed.

## Permissions and safety

- Workers and the docs agent run with write access to their worktree: Claude Code with
  `--permission-mode bypassPermissions`, Codex with `--sandbox workspace-write`.
- Planner and checker are read-only: Claude Code gets only Read/Grep/Glob and a short allow-list of
  Bash commands (plus `checker.allowedCommands`); Codex gets `--sandbox read-only`.
- Agents are told never to run git commands; dulger commits, merges and cleans up.
- Claude Code agents do not load your MCP servers (`--strict-mcp-config`). With the restricted tool set the
  planner and checker use, every MCP tool schema would be inlined into the prompt (tens of thousands of
  tokens per agent), and servers attaching mid-session invalidate the prompt cache. Set
  `"claude": { "mcp": true }` if your agents need them.
- An agent that produces no events for `stallTimeoutSec` is killed and counted as a failed attempt.
- `Ctrl-C` stops all agents, saves the board, and prints the `dulger resume` command.

## Adding a harness

Implement the `Adapter` interface in `src/adapters/types.ts`: spawn the CLI, translate its output into
`AgentEvent`s (`init`, `text`, `tool`, `tool_result`, `turn`, `result`), and return the parsed JSON
answer. Register it in `src/adapters/index.ts`. `src/adapters/fake.ts` is the smallest example.

## Development

```sh
npm run typecheck
npm test
```
