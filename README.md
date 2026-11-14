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
checkout is never touched: the result arrives on a branch named `dulger/<runId>`. Running `dulger`
with no arguments opens a prompt where you pick the backend and models first. To try it without
spending anything, add `--harness fake`: the whole pipeline runs with no model.

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
| `dulger` | Interactive prompt. Type a goal, or `/help` for the commands |
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
a cheaper or stronger model for each task, based on how hard the planner says it is.

## Configuration

Settings live in `<repo>/.dulger/config.json`. All are optional, and flags override the file.

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
