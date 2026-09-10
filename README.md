# dulger

A kanban of coding agents. Give it a goal; a planner turns it into cards, workers build the cards in
parallel git worktrees, a reviewer checks each one, and the result lands on a branch for you to merge.
Every agent is a headless [Claude Code](https://claude.com/claude-code) or
[Codex](https://github.com/openai/codex) process. No API keys, no build step.

```sh
cd your-repo
dulger                       # interactive prompt: type a goal, or /help
dulger run "Add CSV export to the reports page"
```

## Install

Node 24+, git, and `claude` or `codex` on your PATH.

```sh
npx @zamazingobjk/dulger                    # run without installing
npm install -g @zamazingobjk/dulger         # or install the `dulger` command
```

From a checkout of https://gitlab.com/zamazingo99/dulger: `npm install && npm link`.

## How a run works

1. **Plan.** The planner explores the repo and writes cards: acceptance criteria, 1–4 tasks each,
   dependencies. It lists its assumptions and anything it left out of the goal. You read the board
   and press Enter, or use `/order` to talk it through first.
2. **Build.** Each card gets its own worktree and branch. Workers run its tasks in sequence; cards run
   in parallel.
3. **Verify.** Each card names the commands that prove it (build, tests, lint); the planner picks
   them from the project. Once the card's work is committed and synced with the result branch, dulger
   runs them itself. A non-zero exit sends the card back to a worker with the output, without paying
   for a review. Whether it builds is a fact dulger establishes, not a claim an agent makes.
4. **Review.** One card at a time is reviewed in that combined state, with the verify results in
   hand, and lands by fast-forward. A rejection adds a fix task and a second review, up to
   `maxAttempts`. Non-blocking remarks become notes on the board, and so does every command the
   reviewer asked for and was refused.
5. **Replan.** If a card fails, the planner replans the remaining work once.
6. **Docs.** A documentation agent updates README / CHANGELOG for what landed.
7. **Report.** What landed, what did not, what was verified, files, reviewer notes, spend, next step.

Your checkout is untouched. The result is on `dulger/<runId>`; `git merge` it when you are happy.

## The screen

On a terminal a run takes the whole screen: the cards as columns, the agents under them with what
each one is doing, the log, and a prompt line whenever the run asks you something. Arrow keys (or
hjkl) select a card, Enter opens it (description, acceptance criteria, tasks, review remarks, the
agent's last actions), Esc closes it, PgUp/PgDn scroll the log. Tab moves between the prompt and the
board while a question is open. Ctrl-C stops the agents and saves the board. When the run ends the
screen goes away and the report prints where you can scroll back to it.

Icons come from a Nerd Font when the terminal is ghostty, kitty, WezTerm, Alacritty or foot, and are
plain Unicode elsewhere; `"tui": { "icons": "nerd" }` in the config or `DULGER_ICONS=nerd` forces it,
`ascii` works on anything. `--quiet`, a pipe, a screen under 80×16, or `"tui": { "enabled": false }`
fall back to log lines.

## Commands

```
dulger                        interactive prompt (/order /board /report /runs /resume /merge /memory /help, /harness /model … for settings)
dulger init [path]            git init (if needed) plus a first commit, so runs have a base
dulger run "<goal>"           plan, pause for approval, execute
dulger order "<goal>"         plan in a conversation with the planner, then execute
dulger resume [runId]         continue an interrupted run
dulger board | report [runId] print a run's board / what it landed
dulger runs                   list runs
dulger memory [list|add|rm|compact|path]
dulger clean                  remove leftover worktrees and wip branches

--harness claude|codex|fake   --model <name>        --concurrency <n>     --max-attempts <n>
--yes                         --no-docs             --merge               --allow-dirty
--repo <path>                 --quiet               --max-replans <n>     --version
```

`--harness fake` runs the whole pipeline without an LLM, for trying things out.

## Configuration

`<repo>/.dulger/config.json`, all optional; flags override it.

```jsonc
{
  "harness": "claude",             // default for every role
  "roles": { "worker": { "harness": "codex" }, "planner": { "model": "opus" } },
  "concurrency": 3,
  "maxAttempts": 2,                // review rounds per card, and tries per task
  "maxReplans": 1,
  "stallTimeoutSec": 600,          // kill an agent that goes silent this long
  "docs": true,
  "checker": { "allowedCommands": ["npm test", "npm run typecheck"] },   // what the reviewer may run, on top of the card's verify commands
  "verifyTimeoutSec": 600,         // a verify command that runs longer is killed and counts as failed
  "worktreeSetup": "npm ci",       // run once in every new worktree
  "claude": { "mcp": true },       // workers get your MCP servers; the planner and reviewer never do
  "codex": { "bypassSandbox": false },
  "memory": { "location": "user", "maxItems": 40, "maxChars": 6000 },
  "tui": { "enabled": true, "icons": "auto" }   // full-screen run view; icons nerd | unicode | ascii | auto
}
```

## Context and memory

- **You write** `<repo>/.dulger/context/*.md`: conventions, architecture, how to run tests. Included
  verbatim in every prompt. Commit it.
- **Agents learn.** Workers report facts about the codebase; dulger stores them outside the repo, folds
  duplicates and paraphrases, and gives each agent the ones relevant to its card. `dulger memory`
  lists, adds, removes and compacts them.

## Where things live

```
<repo>/.dulger/context/*.md             your notes (committed)
<repo>/.dulger/config.json              configuration (committed)
<repo>/.dulger/runs/<runId>/            board.json, events.jsonl, logs/   (git-ignored)
~/.local/share/dulger/<project>/        memory.jsonl, worktrees/          (per origin URL; $XDG_DATA_HOME or $DULGER_DATA_DIR)
```

Branches: `dulger/<runId>` is the result, `dulger-wip/<runId>/<card>` are work branches that disappear
when a card lands.

## Safety

- Workers write only inside their worktree (`bypassPermissions` / `workspace-write`). Planner and
  reviewer are read-only, with an allow-list of commands. A refused command is logged and noted on
  the card, so a review that had to take something on trust says so.
- The verify commands come from the planner and run with your shell's privileges in the card's
  worktree, the same access the workers already have there. Read them on the board before dispatching.
- Agents never run git; dulger commits, merges, cleans up.
- Ctrl-C stops the agents and saves the board. `dulger resume` picks it up.

## Known limitations

Codex reports tokens but no prices and no plan-window figure, so its runs show only tokens. The
documentation agent's commit is the one piece of work nobody reviews. Old runs are never deleted;
remove `.dulger/runs/<runId>` by hand. Workers run with `bypassPermissions`, so inside their worktree
they have whatever your Claude Code or Codex login has, MCP servers included.

## Development

```sh
npm run typecheck && npm test
```

To add a harness, implement `Adapter` in `src/adapters/types.ts` and register it in
`src/adapters/index.ts`; `src/adapters/fake.ts` is the smallest example.
