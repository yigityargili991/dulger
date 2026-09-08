# usta

**usta** (Turkish: master craftsman) is a small, dependency-free TypeScript framework that turns one
goal into a kanban board and has a crew of coding agents work through it. It is a *wrapper*: every agent
is a headless [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex)
process spawned with a prompt, a working directory and a JSON schema for its answer. usta itself never
calls an LLM API.

```
usta run "Add CSV export to the reports page"
```

1. **Planner** (the main agent) explores the repo and writes a kanban board: cards with acceptance
   criteria and 1–4 sequential tasks each, plus dependencies between cards.
2. You review the board (edit the JSON if you like) and press Enter.
3. **Workers** execute tasks. Every card gets its own git branch and worktree, so cards run in parallel
   without touching each other. A worker that reports `done: false` is resumed in the same session.
4. A **checker** reviews each finished card against its acceptance criteria (it can run the tests).
   Rejections go back to the workers with feedback, up to `maxAttempts`.
5. Passed cards are merged onto the result branch `usta/<runId>`. Failed cards block their dependents.
6. A **documentation agent** updates README / docs / CHANGELOG for the merged work.
7. A live terminal table shows the board and every agent's state, current tool and last message.

Your checkout is never modified: the result lands on `usta/<runId>` for you to review and merge.

## Requirements

- Node **24+** (the code is TypeScript run directly by Node; no build step)
- `git`
- `claude` and/or `codex` on your `PATH`, logged in

## Install

```sh
git clone <this repo> usta && cd usta
npm install          # only installs typescript for `npm run typecheck`
npm link             # puts `usta` on your PATH (or run `node src/cli.ts`)
```

## Usage

```
usta run "<goal>" [options]     plan a board for the goal, then execute it
usta resume [runId]             continue an interrupted run
usta board [runId]              print a run's board
usta runs                       list runs
usta clean                      remove leftover worktrees and wip branches

--harness <claude|codex|fake>   backend for all roles (default: claude)
--concurrency <n>               parallel cards (default: 3)
--max-attempts <n>              checker retries per card (default: 2)
--model <name>                  model for all roles
--yes                           skip the board approval pause
--no-docs                       skip the documentation agent
--merge                         merge the result branch into the current branch when done
--allow-dirty                   run even with uncommitted changes
--repo <path>                   repository to work in (default: cwd)
--quiet                         no live table, log lines only
```

Try it without spending tokens: `usta run --harness fake --yes "demo"` in any git repo.

## Configuration

Optional `<repo>/.usta/config.json`; CLI flags override it.

```json
{
  "harness": "claude",
  "concurrency": 3,
  "maxAttempts": 2,
  "maxContinuations": 2,
  "stallTimeoutSec": 600,
  "docs": true,
  "roles": {
    "planner": { "harness": "claude", "model": "opus" },
    "worker":  { "harness": "codex" },
    "checker": { "maxBudgetUsd": 1 }
  },
  "checker": { "allowedCommands": ["npm test", "pytest"] },
  "codex": { "bypassSandbox": false }
}
```

Roles can mix harnesses: plan with Claude, implement with Codex, review with Claude.

## Common context

Everything in `<repo>/.usta/context/*.md` is prepended to every agent's prompt: conventions,
architecture notes, "how to run the tests", anything you would tell a new teammate. Workers report
`learnings` (non-obvious facts about the codebase) and usta appends them to
`.usta/context/learnings.md`, so later agents in the same run and in future runs see them.

## What lives where

```
<repo>/.usta/
  config.json                 optional configuration
  context/*.md                common context you write; learnings.md is appended by usta
  runs/<runId>/board.json     the kanban — source of truth, editable, resumable
  runs/<runId>/events.jsonl   every state transition
  runs/<runId>/logs/*.jsonl   raw event stream of every agent process
  worktrees/<cardId>/         per-card git worktrees (removed when the card merges; kept on failure)
```

Git branches: `usta/<runId>` is the result; `usta-wip/<runId>/<cardId>` are per-card work branches
that disappear when the card merges. `.usta/` is added to `.git/info/exclude` automatically.

## Permissions and safety

- Workers and the docs agent run with write access to their worktree: Claude Code with
  `--permission-mode bypassPermissions`, Codex with `--sandbox workspace-write`.
- Planner and checker are read-only: Claude Code gets only Read/Grep/Glob and a short allow-list of
  Bash commands (plus `checker.allowedCommands`); Codex gets `--sandbox read-only`.
- Agents are told never to run git commands; usta commits, merges and cleans up.
- An agent that produces no events for `stallTimeoutSec` is killed and counted as a failed attempt.
- `Ctrl-C` stops all agents, saves the board, and prints the `usta resume` command.

## Adding a harness

Implement the `Adapter` interface in `src/adapters/types.ts`: spawn the CLI, translate its output into
`AgentEvent`s (`init`, `text`, `tool`, `tool_result`, `turn`, `result`), and return the parsed JSON
answer. Register it in `src/adapters/index.ts`. `src/adapters/fake.ts` is the smallest example.

## Development

```sh
npm run typecheck
npm test
```
