# dulger

dulger runs a team of coding agents on your repository. You give it a goal. A planner splits the goal
into cards, workers build each card in its own git worktree, a reviewer checks each one, and the
finished work lands on a branch for you to merge.

It drives [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex),
or talks directly to Ollama, DeepSeek and any OpenAI-compatible API.

**Full documentation: [yigityargili991.github.io/dulger](https://yigityargili991.github.io/dulger/)**

## Quick start

You need Node 24 or newer and git. For the Claude Code or Codex backend, `claude` or `codex` must be
installed and logged in.

```sh
npm install -g @zamazingobjk/dulger     # or run it once: npx @zamazingobjk/dulger
cd your-repo
dulger run "Add CSV export to the reports page"
```

dulger shows you the plan and waits. Press Enter to start it, or type a reply to change it. Your
checkout is never touched: the result arrives on a branch named `dulger/<runId>`. To try it without
spending anything, add `--harness fake`: the whole pipeline runs with no model.

Running `dulger` with no arguments opens the dulger app. On Home you type a goal and see which backend
each role will use, with its model when you have pinned one; the other tabs list your runs (review,
resume, retry, merge) and change settings, models, API providers and keys, the agents' memory and the
readiness checks. Changes last for the session until you save them, and dulger commits the
repository's settings file only when you ask; after you quit, one line names anything you did not save. The
screens show values only: `?` (F1 while you type) explains the selected item and the keys, and Ctrl-P
lists every command.

```text
 ⎇ dulger  shop  ⎇ main                                                        claude · sandbox off
  1 Home   2 Runs ▶1   3 Settings   4 Models   5 Providers   6 Memory   7 Doctor
╭─ Goal ─────────────────────────────────────────  Run  Plan  ─╮ ╭─ Roles ───────────────╮
│ What should the agents build?                                │ │ › ✦ Planner  claude   │
╰──────────────────────────────────────────────────────────────╯ │   ⚒ Worker   claude   │
╭─ Runs ────────────────────────────────────────────────── ▶1 ─╮ │   ◎ Reviewer claude   │
│ › ▶  Show a health check on the status page  0/3  $0.01  15h │ │   ≡ Docs     claude   │
│   ✓  Add CSV export to the reports page      3/3  $0.11  15h │ │   ◔ Reporter claude   │
╰──────────────────────────────────────────────────────────────╯ │                       │
                                                                 │   Parallel cards  3   │
                                                                 │   Review rounds   2   │
                                                                 │   Sandbox         off │
                                                                 ╰───────────────────────╯

 ⏎ start  ^t plan  tab next  F1 help
```

## What happens in a run

1. **Plan.** The planner reads the repository and writes cards, each with acceptance criteria.
2. **Build.** Every card gets its own worktree and branch. Cards are built in parallel.
3. **Verify.** dulger runs each card's build and test commands itself. A failure goes back to a worker.
4. **Review.** A reviewer reads the diff. A rejected card gets a fix task and a second review.
5. **Replan.** If a card fails for good, the planner replans what is left, once.
6. **Docs.** A documentation agent updates the README and changelog for what landed.
7. **Final check.** The verify commands run again on the finished result.
8. **Report.** What landed, what did not, and what it cost.

## Commands

| Command | What it does |
| --- | --- |
| `dulger` | The app: goals, runs, review and merge, settings, models, providers. With `--quiet` or the full-screen view off, a line prompt (`/help` lists its commands) |
| `dulger run "<goal>"` | Plan, wait for your approval, then build |
| `dulger order "<goal>"` | Talk the plan through with the planner first |
| `dulger resume [runId]` | Continue a run that was stopped |
| `dulger retry <card> [runId]` | Give a failed card another round |
| `dulger board [runId]` | Show a run's cards |
| `dulger report [runId]` | Show what a run landed |
| `dulger doctor` | Check the setup without calling a model |

`dulger --help` lists the flags. The ones you will use most are `--harness`, `--model`,
`--concurrency`, `--budget` and `--yes` (start without reviewing the plan).

## Backends

| Backend | Select with | Needs |
| --- | --- | --- |
| Claude Code (default) | `--harness claude` | `claude`, logged in |
| Codex | `--harness codex` | `codex`, logged in |
| Ollama | `--harness ollama --model <model>` | A local model with tool calling |
| DeepSeek | `--harness deepseek` | `DEEPSEEK_API_KEY` |
| Other OpenAI-compatible API | `--harness openai --base-url <url> --api-key-env <NAME> --model <model>` | The key in that variable |

Each role (planner, worker, reviewer, docs) can use its own backend and model. By default dulger picks
a cheaper or stronger model for each task, based on how hard the planner says it is. Jev, TypeSafe's
calibrated scoring model, can rate the tasks instead, through OpenRouter, TypeSafe's API or a local
llama-server: dulger asks which on its first start, and Settings changes it.

## Configuration

Settings live in `<repo>/.dulger/config.json`. All are optional, flags override the file, and the
app's Save to repository writes the session's changes into it. The backend, role models, routing and
API providers you save go to your own `~/.config/dulger/config.json` instead, and apply in every
project.

```json
{ "harness": "claude", "concurrency": 3, "worktreeSetup": "npm ci" }
```

Notes for the agents, such as conventions and how to run the tests, go in
`<repo>/.dulger/context/*.md`. They are included in every prompt.

## Safety

- Without the sandbox, Claude Code agents can read and write anything you can. Codex agents stay
  inside Codex's own sandbox.
- Each card's verify commands are shell commands the planner wrote. Read them before you start a run.
- The sandbox limits Claude Code agents and verify commands to their worktree and to the network hosts
  you allow. It is off by default. To turn it on, put `{"sandbox": {"mode": "auto"}}` in
  `~/.config/dulger/config.json`, then run `dulger doctor`.
- For a harder boundary, run dulger inside a container or VM.

The docs explain [what the sandbox does and does not protect](https://yigityargili991.github.io/dulger/how-a-run-works/#sandbox).

## Development

```sh
npm install
npm run typecheck && npm test
```

The full manual is `docs/manual.md`; the site is built from it. MIT licensed.
