# dulger

A kanban of coding agents. Give it a goal; a planner turns it into cards, workers build the cards in
parallel git worktrees, a reviewer checks each one, and the result lands on a branch for you to merge.
Agents use headless [Claude Code](https://claude.com/claude-code) or
[Codex](https://github.com/openai/codex), or connect directly to Ollama, DeepSeek and OpenAI-compatible APIs.
CLI backends use your existing login; API backends use environment variables. No build step.

Website: [dulger-site-production.up.railway.app](https://dulger-site-production.up.railway.app) — the
docs as pages, generated from this README and CHANGELOG on releases and documentation updates.

```sh
cd your-repo
dulger                       # choose harness and models, then type a goal
dulger run "Add CSV export to the reports page"
```

## Install

Node 24+ and git. CLI backends also need `claude` or `codex` on your PATH; direct API backends do not.

```sh
npx @zamazingobjk/dulger                    # run without installing
npm install -g @zamazingobjk/dulger         # or install the `dulger` command
```

From a checkout of https://gitlab.com/zamazingo99/dulger: `npm install && npm link`.

## Session setup

Starting `dulger` in a terminal opens a keyboard menu before the goal prompt. The current repository
and CLI settings are already selected; press Enter on **Start session** to keep them, or change:

- **Harness:** Claude Code, Codex, the fake demo, or a configured API provider. Changing it resets
  role overrides to that harness's automatic tiers.
- **Model set:** automatic routing, a balanced set (high planner/reviewer, medium worker, low
  docs/reporter), or the configured low/high tier for every role.
- **One model for all roles**, or a separate harness and model for each role. Model lists include
  configured IDs and, for API providers with credentials available, the endpoint's models.
  You can always enter a custom model ID if the endpoint is unavailable.

Arrow keys select, Enter accepts, and typing filters a list. Escape clears the filter or goes back;
Ctrl-C cancels setup. The overview shows the effective model for every role before starting.
An automatic worker follows the planner's task difficulty and escalates on retries. A pinned worker
model overrides both. API providers without a model must have one chosen before starting.

Choices are session-only until `/config save`. `/setup` reopens the menu between runs; cancelling
keeps the previous settings. `--yes`, `--quiet`, or a disabled TUI skip automatic setup.
Direct commands such as `dulger run` and `dulger resume` keep their existing flag-driven behavior.

## Profiles, recovery and run controls

Setup can save a named profile, load it into the draft, and adjust parallel cards and run/card
budgets. Profiles live in `.dulger/profiles.json` for this repository. Saving a profile is an
explicit write; replacing one asks first. API key values and environment values are never copied.
Dollar limits cannot account for harnesses that report tokens without prices.

Choose **Check readiness**, use `/doctor`, or run `dulger doctor` to check executables, key
availability, model configuration, Git identity and worktree-directory access. Blocking checks also
run before agent calls. These checks do not make paid requests or verify account/model access;
provider authentication and model availability are established by the first real call.
A failing worktree setup now stops that card before its agents run and can be retried with resume.

- **`/runs`** opens a searchable run browser on a terminal, with report, diff, resume, retry and
  plan-edit actions. Noninteractive output remains a list. Startup surfaces unfinished runs.
- **`/edit [runId]`**, or **`/edit` at plan approval**, edits an unstarted plan: titles, descriptions,
  acceptance criteria, task instructions, dependencies, verification commands and worker models.
  Save validates the dependency graph; cancel discards edits. Commands are edited individually.
- **`/resume [runId]`** keeps the run's saved execution settings. Interactive resume can show the
  differences and choose current settings; `/resume [runId] current` or CLI `--current-settings`
  explicitly replaces them. Old runs without saved settings use current settings.
- While cards run, **p** pauses/resumes dispatch. Active cards finish while paused. **x** stops the
  selected card after typing `stop`; its worktree is kept and `/retry` resumes it. **i** adds
  instructions for the next worker attempt, leaving a call already running unchanged. Instructions
  appear in card detail. These controls do not intercept typing in a prompt.
- **`/review [runId]`** opens the persistent result review: full report, verification, feedback and
  per-file diffs. Merge names the target branch and asks for confirmation. The same review opens
  after an interactive run lands work.

After documentation, dulger reruns the unique verification commands of landed cards in a temporary
worktree on the exact final result. Failed or stale verification blocks dulger's merge actions;
resume rechecks the result. A run with no verification commands says so. Verification is cancellable
and its subprocesses are stopped on interruption. A failed final check does not automatically call
an agent to repair it: inspect its output, fix the result branch, then resume to recheck.

Runs store versioned execution settings and lifecycle checkpoints. Execution locks prevent two
processes from running or editing the same run; merge and cleanup respect these locks too. A dead
local owner's execution lock is recovered automatically. A lock whose owner cannot be verified
requires inspection of the displayed path.

## How a run works

1. **Plan.** The planner explores the repo and writes cards: acceptance criteria, 1–4 tasks each,
   dependencies. It lists its assumptions and anything it left out of the goal. You read the board
   and press Enter, or use `/order` to talk it through first. Off a terminal (a pipe, CI) nothing is
   dispatched without `--yes`: the board is printed, the run waits in the backlog, and
   `dulger resume <runId>` dispatches it.
2. **Build.** Each card gets its own worktree and branch. Workers run its tasks in sequence; cards run
   in parallel. While a card is in progress, a lightweight progress reporter summarizes what its
   worker is doing onto the card — one cheap headless call every `progressIntervalSec` seconds on the
   low-tier model, so the board explains itself without you reading raw agent logs.
3. **Verify.** Each card names the commands that prove it (build, tests, lint); the planner picks
   them from the project. Once the card's work is committed and synced with the result branch, dulger
   runs them itself. A non-zero exit sends the card back to a worker with the output, without paying
   for a review. Whether it builds is a fact dulger establishes, not a claim an agent makes.
4. **Review.** One card at a time is reviewed in that combined state, with the verify results in
   hand, and lands by fast-forward. A rejection adds a fix task and a second review, up to
   `maxAttempts`. Non-blocking remarks become notes on the board, and so does every command the
   reviewer asked for and was refused. A reviewer that cannot run at all is dulger's failure, not
   the card's: no round is spent, no worker is asked to fix it, and `dulger resume` retries the card
   from its worktree.
5. **Replan.** If a card fails, the planner replans the remaining work once. When its cards bring a
   verify command that is not already on the board or in `checker.allowedCommands`, the run asks
   first and only a typed `yes` (or `--yes`) applies the replan; otherwise it is dropped and the
   board stays as it was.
6. **Docs.** A documentation agent updates README / CHANGELOG for what landed.
7. **Final verification.** Rerun the landed cards' commands after documentation on the exact result
   revision. Failed or stale checks block dulger's merge actions.
8. **Report.** What landed, what did not, what was verified, files, reviewer notes, spend, next step.

Your checkout is untouched. The result is on `dulger/<runId>`; `git merge` it when you are happy.

## The screen

On a terminal a run takes the whole screen: the cards as columns, the agents under them with what
each one is doing, the log, and a prompt line whenever the run asks you something. An in-progress
card shows the progress reporter's latest note under its title (with a warning marker when the
reporter flagged something); a fresh note always beats the raw agent line, and both are in the card
when you open it. Arrow keys (or
hjkl) select a card, Enter opens it (description, acceptance criteria, tasks, review remarks, the
agent's last actions), Esc closes it, PgUp/PgDn scroll the log. Tab moves between the prompt and the
board while a question is open; with the prompt focused, Tab takes the dim prediction instead — see
[Command prediction](#command-prediction). Ctrl-C stops the agents and saves the board. When the run ends the
screen goes away and the report prints where you can scroll back to it.

Icons come from a Nerd Font when the terminal is ghostty, kitty, WezTerm, Alacritty or foot, and are
plain Unicode elsewhere; `"tui": { "icons": "nerd" }` in the config or `DULGER_ICONS=nerd` forces it,
`ascii` works on anything. Narrow or short terminals use a compact card list; the layout reserves space
for input and hides secondary sections as space runs out. `--quiet` or a pipe uses log lines;
`"tui": { "enabled": false }` uses the legacy table.

## Commands

```
dulger                        interactive prompt (/order /board /report /runs /resume /merge /memory /help, /harness /model … for settings)
dulger init [path]            git init (if needed) plus a first commit, so runs have a base
dulger run "<goal>"           plan, pause for approval, execute
dulger order "<goal>"         plan in a conversation with the planner, then execute
dulger resume [runId]         continue an interrupted run
dulger retry <card> [runId]   give a failed card one more review round, then continue the run
dulger board | report [runId] print a run's board / what it landed (report --full: every summary, review and note)
dulger runs                   list runs
dulger doctor                 check backend and repository readiness without a model call
dulger memory [list|add|rm|compact|path]
dulger clean                  remove leftover worktrees and wip branches

--harness <name>              --model <name>        --concurrency <n>     --max-attempts <n>
--yes                         --no-docs             --merge               --allow-dirty
--base-url <url>              --api-key-env <name>  --no-routing
--repo <path>                 --quiet               --max-replans <n>     --version
--no-progress                 --progress-interval <sec>
--current-settings            --budget <usd>         --card-budget <usd>
--sandbox off|auto|required
```

`--harness fake` runs the whole pipeline without an LLM, for trying things out.

## Command prediction

The prompt knows what each command takes, so a half-typed line is completed from it, in `dulger` and on
the full-screen view's prompt line alike:

- The rest of the word is shown dim after the cursor, and **Tab** takes it.
- When several words fit they are listed under the line, each with what it does. More than a handful
  match? Then the count is shown instead: keep typing to narrow them.
- Arguments are completed wherever they are known, and from the repository where they live: run ids for
  `/board`, `/report`, `/resume`, `/merge` and `/retry`; the latest run's failed cards for `/retry`;
  roles, aliases, backends and harnesses for `/model`; configured providers for `/provider`; what agents
  learned for `/memory rm`; each setting's own values for `/set` and for the setting commands; `save`
  for `/config`.
- The plan approval prompt completes `go` and `cancel`, the same words Enter and a plain `cancel` mean.

Prediction is only ever drawn, never typed. A goal line (anything that does not start with `/`), a
cursor in the middle of the line, a line past its last argument, and a terminal too narrow for the list
are all left alone.

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
  "progressIntervalSec": 120,       // a lightweight agent notes each running card this often; 0 disables it
  "checker": { "allowedCommands": ["npm test", "npm run typecheck"] },   // what the reviewer may run, on top of the card's verify commands
  "verifyTimeoutSec": 600,         // a verify command that runs longer is killed and counts as failed
  "budgetUsd": 200,                // stop the run (resumable) at this spend; --budget on the command line
  "cardBudgetUsd": 50,             // fail a card at this spend; --card-budget
  "worktreeSetup": "npm ci",       // run once in every new worktree
  "claude": { "mcp": true },       // workers get your MCP servers; the planner and reviewer never do
  "codex": { "bypassSandbox": false },
  "memory": { "location": "user", "maxItems": 40, "maxChars": 6000 },
  "tui": { "enabled": true, "icons": "auto" }   // full-screen run view; icons nerd | unicode | ascii | auto
}
```

The [sandbox](#sandbox) is not configured here: a repository does not get to set its own confinement.

## Model routing

Automatic routing is on by default. The planner labels each task `low`, `medium` or `high` complexity.

| Tier | Claude Code | Codex |
| --- | --- | --- |
| Low: mechanical edits, simple docs | `haiku` | `gpt-5.6-luna` |
| Medium: routine features, fixes, tests | `sonnet` | `gpt-5.6-sol` |
| High: architecture, security, difficult debugging | `claude-fable-5-1` | `gpt-6-astra` |

Planning and review always use high: what the reviewer misses lands unseen. Documentation and the
progress reporter use low. The reporter works from a digest of the worker's live activity, never
touches the worktree, and its cost lands on the run, not the card.
Tool-free reporting is supported by Claude Code and API providers. Codex CLI cannot disable every
built-in tool, so a Codex reporter is skipped with a log message; set `roles.reporter.harness` to
`claude` or a configured API provider to use progress notes with Codex workers.
Unlabelled tasks on older boards use medium. A failed worker attempt retries one tier up; continuations
keep the same model and session. Fix tasks and merge-conflict resolution run one tier up. Selected models
appear in the log and live agent list. The Fable model ID follows the
[Claude Code configuration docs](https://support.claude.com/en/articles/11940350-claude-code-model-configuration).
You can use `opus` as the high tier by changing the map. Availability depends on your account and installed CLI.

`--model` pins all roles and overrides routing; `roles.<role>.model` pins just that role.
Use `--no-routing`, `/routing off`, or `"routing": { "enabled": false }` to use harness defaults.
`/model off` clears the session-wide pin. Configure tier IDs in `.dulger/config.json`:

```json
{
  "routing": {
    "models": {
      "claude": { "low": "haiku", "medium": "sonnet", "high": "claude-fable-5-1" },
      "codex": { "low": "gpt-5.6-luna", "medium": "gpt-5.6-sol", "high": "gpt-6-astra" },
      "ollama": { "low": "your-small-model", "medium": "your-coder-model", "high": "your-large-model" }
    }
  }
}
```

## Choose models in the REPL

Configure a mixed-model run without editing JSON:

```text
/model planner fable
/model worker deepseek
/model checker sonnet
/model docs haiku
/model reporter haiku
/model
```

Use `astra` instead of `fable` for Codex planning. Shorthand names are `fable`, `opus`, `sonnet`,
`haiku`, `astra`, `sol` and `luna`; their known full model IDs also work. A backend name alone,
such as `deepseek` or `codex`, uses that backend's tier routing or configured default model.
Custom model names use an explicit backend/model pair:

```text
/model worker ollama qwen3:8b
/model worker openai vendor/custom-model
/model worker auto
/model worker reset
/config save
```

- `/model` shows every role's effective backend, model, pin/routing mode and source. `/model worker`
  shows just one role; `/status` includes the overview. Missing API-key environment variables and
  missing provider models are shown before you start a run.
- `/model worker auto` removes the worker's model pin on its current backend. It follows `/routing`:
  tier routing when enabled, provider/harness defaults when disabled. APIs without a tier map use
  their configured default model.
- `/model worker reset` restores the repository's role harness/model (or repository defaults),
  bypassing the session's global model pin for that role. Other shared settings still apply.
- `/model <name>` sets a global fallback pin; explicit session role choices and resets take precedence,
  regardless of command order. `/model off` clears that global pin and keeps the role choices.
  The overview always shows which setting applies. `/set model ...` accepts the same arguments.
- `/progress` shows the progress reporter's interval; `/progress on|off|<sec>` changes it
  (`--no-progress` and `--progress-interval <sec>` do the same on the command line). It is on with
  a 120-second interval by default, and `roles.reporter` picks its backend and model like any role.
- Changes remain session-only until `/config save`. Saving writes explicit configuration changes,
  including the effective model mix, to `.dulger/config.json` and preserves unrelated settings.
  `yes`, `quiet` and `dirty` remain session-only. API keys stay in environment variables; saving
  provider settings persists only the configured environment-variable name, not its value.

The saved file is committable, like a hand-written configuration. API endpoint settings passed through
`--base-url` and `--api-key-env` can also be saved this way.

## Direct API backends

Use a model with Chat Completions function/tool calling support. These backends have a built-in coding
loop with file listing, reading, writing, diff inspection and shell commands. They do not require
Claude Code or Codex. See [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) and
[DeepSeek tool calling](https://api-docs.deepseek.com/guides/tool_calls/).

```sh
# Ollama: select a tool-capable model you have already pulled. No key needed locally.
dulger run "Add CSV export" --harness ollama --model your-local-coder

# DeepSeek: export DEEPSEEK_API_KEY in your shell first.
dulger run "Add CSV export" --harness deepseek

# Any compatible service: export MY_LLM_KEY first, then provide its API base URL and model.
dulger run "Add CSV export" --harness openai --model your-model \
  --base-url https://your-provider.example/v1 --api-key-env MY_LLM_KEY
```

Any name under `providers` is a backend. Give it a `baseUrl`, the **environment variable name** holding
its key, and a default model; the rest is filled from the defaults. So OpenRouter, Together, Groq or a
self-hosted vLLM sit next to the built-in three under their own names, each with its own tier map:

```json
{
  "harness": "openrouter",
  "providers": {
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "model": "qwen/qwen3-coder" }
  },
  "routing": { "models": { "openrouter": { "low": "qwen/qwen3-coder", "medium": "qwen/qwen3-coder", "high": "anthropic/claude-sonnet-4.5" } } }
}
```

`dulger run "..." --harness openrouter --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY --model qwen/qwen3-coder`
defines the same thing for one run without touching the file. A rejected request reports the server's
own error message (with the key redacted), so a wrong model name reads as such.

In the prompt, `/provider deepseek` (or any name) asks for the base URL, then for the key when it is
not already available, typed without echo and stored in `~/.config/dulger/keys.json` (mode 600, never
in a repository; an exported variable always wins), then lists the models the endpoint reports so you
pick one by number or by typing part of its name. `/provider` lists every provider and where its key
comes from; `/provider <name> key` replaces a key, `/provider <name> model` re-picks the model.
`/config save` then writes the endpoint and the variable name to the repository config. Selecting a
provider whose key is missing, in the prompt or at the start of a run, asks for the key on the spot.

Persist endpoint settings in `.dulger/config.json`. Store the **environment variable name**, never the
key itself: this file is committable. `/harness ollama`, `/harness deepseek` and `/harness openai` also
work in the interactive prompt. The base URL is the prefix before `/chat/completions`.

```json
{
  "harness": "openai",
  "providers": {
    "openai": {
      "baseUrl": "https://your-provider.example/v1",
      "apiKeyEnv": "MY_LLM_KEY",
      "model": "your-model",
      "maxTurns": 40,
      "maxTokens": 8192,
      "tokenParameter": "max_tokens",
      "timeoutSec": 300,
      "retries": 3,
      "commandTimeoutSec": 600
    },
    "ollama": { "baseUrl": "http://localhost:11434/v1", "model": "your-local-coder" }
  }
}
```

DeepSeek defaults to `https://api.deepseek.com`, `DEEPSEEK_API_KEY` and `deepseek-flash`. OpenAI defaults
to `https://api.openai.com/v1`, `OPENAI_API_KEY` and requires a model. Ollama requires a model as well.
Each API provider uses `providers.<name>.model` when no role, CLI or tier model is set. API tier maps
are opt-in; you choose the model IDs available on your endpoint. Partial configuration merges with defaults.

`maxTurns` bounds the tool/answer loop; `maxTokens` caps each response. OpenAI uses the
`max_completion_tokens` request field on `api.openai.com`; other hosts default to `max_tokens`.
Set `tokenParameter` explicitly if your endpoint requires a different spelling. Calls are cancelled on interrupt or timeout.
A 429 or 5xx answer is retried up to `retries` times with backoff (`Retry-After` honoured); only a limit
that persists through the retries stops the run. Shell commands the agent runs are killed after
`commandTimeoutSec`.
API runs report tokens, not estimated dollars; `maxBudgetUsd` is rejected because these providers do
not supply reliable cost figures. API conversation transcripts are saved with private file permissions
alongside the run logs so planner revisions and worker continuations can resume.

File tools reject paths outside the worktree, symlinks, `.git` and `.dulger`. Read-only roles have no
file-writing tool and can run only exact approved commands. Workers' shell commands, and explicitly
approved test commands, run with your OS user's privileges; this is not an OS sandbox. The API tools
do not load MCP servers.

## Context and memory

- **You write** `<repo>/.dulger/context/*.md`: conventions, architecture, how to run tests. Included
  verbatim in every prompt. Commit it.
- **Agents learn.** Workers report facts about the codebase; dulger keeps those of cards that land (a
  card that fails teaches nothing), stores them outside the repo, folds duplicates and paraphrases, and
  gives each agent the ones relevant to its card. `dulger memory` lists, adds, removes and compacts them.

## Where things live

```
<repo>/.dulger/context/*.md             your notes (committed)
<repo>/.dulger/config.json              configuration (committed)
<repo>/.dulger/runs/<runId>/            board.json, events.jsonl, logs/   (git-ignored)
~/.local/share/dulger/<project>/        memory.jsonl, worktrees/, sandbox/ (per origin URL; $XDG_DATA_HOME or $DULGER_DATA_DIR)
~/.config/dulger/config.json            your sandbox policy, never a repository's ($XDG_CONFIG_HOME)
```

Branches: `dulger/<runId>` is the result, `dulger-wip/<runId>/<card>` are work branches that disappear
when a card lands.

## Safety

- Workers start in their card's worktree. Codex keeps them there: its `workspace-write` sandbox limits
  their writes to the worktree and temporary directories (unless `codex.bypassSandbox` is on). Claude
  Code's `bypassPermissions` skips permission prompts and confines nothing, so without the
  [sandbox](#sandbox) Claude Code workers can read and write whatever your user can; with it they
  write only their worktree and reach only Anthropic's API and the hosts you grant. API workers' file
  tools stay inside the worktree; their shell commands do not, unless the sandbox is on. Planner and reviewer are read-only. On Claude Code and API
  backends they run only allowed commands: for the reviewer, `checker.allowedCommands` and the card's
  verify commands, the latter exactly as written; Codex runs theirs in its read-only sandbox. A
  refused command is logged and noted on the card, so a review that had to take something on trust
  says so. The progress reporter gets the activity digest in its prompt and no commands at all; it has
  nothing to refuse.
- The verify commands come from the planner and run in the card's worktree with your shell's
  privileges, the same access unsandboxed Claude Code workers have there, or confined by the
  [sandbox](#sandbox) when it is on. Read them before dispatching: `dulger board`
  and the plan prompt outside the full-screen view list them under each card, and `/edit` shows them.
  Dispatching approves them; `--yes` approves them unread, and off a terminal nothing is dispatched
  without it. A replan's verify commands that are not already on the board or in
  `checker.allowedCommands` (exact match) need a typed `yes`, or `--yes`, or the replan is dropped.
  They, `worktreeSetup` and the API tools' shell commands get your environment without the credentials
  dulger runs agents with: every provider's `apiKeyEnv`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and `DEEPSEEK_API_KEY`. Your project's
  own variables pass through. Claude Code and Codex, and the commands they run, still get your whole
  environment.
- Agents never run git; dulger commits, merges, cleans up.
- Ctrl-C stops the agents and saves the board. `dulger resume` picks it up, and also retries cards
  that failed on dulger's side (a reviewer that would not start, an agent that hung) rather than on
  their work. When the harness account hits its usage limit the run stops itself the same way, so a
  reset window is not spent on cards that cannot run.
- Before you dispatch, the log warns about cards too big for one reviewer and foundation cards that
  do more than the cards waiting for them need. Those are the plans that fail late and expensively.

## Sandbox

New in this version, and built on Anthropic's sandbox runtime
([`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime), pinned
at 0.0.83), which its authors label a beta research preview. It is off unless you turn it on.

With it on, Claude Code agents and the commands dulger itself runs on code an agent wrote run in a
process sandbox: verify commands (the gate and final verification), `worktreeSetup`, and the API
tools' `run_command` and `git_diff`. Each agent call and each command gets its own `srt` process with
its own policy: bubblewrap on Linux, Seatbelt on macOS. Codex is not wrapped: it keeps its own
sandbox (`workspace-write` for workers, `read-only` otherwise, none with `codex.bypassSandbox`), and
bubblewrap cannot start inside bubblewrap. Agents on an [API backend](#direct-api-backends) run inside
dulger's own process: their file tools stay in the worktree, and their shell and git run in the sandbox.

A sandboxed command or Claude Code agent

- **writes** only its own worktree (a card's, the documentation's or final verification's, never
  your own checkout), a private temp dir (`$TMPDIR`, kept under `~/.local/share/dulger/<project>/sandbox/`
  and removed when the run finishes), and what you grant with `allowWrite`. `$HOME`, `/tmp` and your
  checkout are read-only. `.claude/`, `.husky/` and `.githooks/` in the worktree are read-only when they
  exist; the runtime itself protects shell rc files, `.gitconfig`, `.gitmodules`, `.mcp.json`,
  `.vscode/`, `.idea/`, `.claude/commands` and `.claude/agents`, and git's hooks and config;
- **reads** everything your user can except `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`,
  `~/.config/gcloud`, `~/.config/gh`, `~/.config/dulger`, `~/.netrc`, `~/.npmrc`, `~/.docker`,
  `~/.kube`, `~/.git-credentials`, the agents' own credentials (`~/.claude`, `~/.claude.json`,
  `~/.codex`; hidden from commands, not from Claude Code, which needs them), the other cards'
  worktrees and temp dirs, and what you add with `denyRead`;
- **connects** only to the hosts you grant for its kind. With none, every connection is refused,
  your machine's own localhost and unix sockets (Docker's included) too.

**Claude Code agents.** The worker, the reviewer and the documentation agent run in their worktree;
the reviewer's permission mode still keeps it from editing files, but the tests it re-runs can write
their build output. The planner runs in your checkout, which stays read-only. The progress reporter
has no tools and is not wrapped. On top of what a command gets, an agent

- reaches `api.anthropic.com`, `claude.ai` and `platform.claude.com` (the last two to refresh a
  login), the host of `ANTHROPIC_BASE_URL` when you use a gateway, and the hosts in `domains.agent`;
- reads its own state, `~/.claude/.credentials.json` included: a sandboxed agent can still read the
  login it runs with. That state is read-only except the session's transcript directory,
  `~/.claude/projects/<working directory>/` (under `$CLAUDE_CONFIG_DIR` when that is set), which
  dulger creates before the call so that resuming a session and structured answers work. Claude Code
  logs the other writes it cannot make (`~/.claude.json`, plugin caches, locks) and carries on. The
  planner's directory is the one your own Claude Code sessions in this repository use, so the
  planner could write there, but not to its `memory/`: Claude Code's auto-memory, which later
  sessions read, stays read-only;
- runs with Claude Code's own Bash sandbox switched off, since that cannot start inside this one.
  dulger passes `--settings '{"sandbox":{"enabled":false}}'`, which overrides your user and project
  settings but not managed ones;
- is told in its system prompt what it can write, and that the placeholder files described under
  Limitations are not its own;
- runs your MCP servers, plugins and hooks inside the sandbox with it. A server or hook that needs
  the network needs its host in `domains.agent`, and one that writes outside the worktree needs
  `allowWrite` (a server started with `uv run` needs `~/.cache/uv`). The claude.ai connectors go
  through `mcp-proxy.anthropic.com`: granting it hands the agents your connected accounts.
  SessionStart hooks do not run at all, because Claude Code cannot create its `~/.claude/session-env/`
  inside; other hooks do.

Bedrock and Vertex endpoints are not added for you: list their hosts in `domains.agent`. Their
credential files (`~/.aws`, `~/.config/gcloud`) are hidden, and `allowRead` would open them to every
sandboxed command; dulger has not been tried with either in the sandbox.

If Claude Code ever names its transcript directory differently from dulger, the session is not saved
and the run log says so. A worker that reported unfinished work then gets a new session instead of a
continuation, which costs a task attempt, and a plan revision plans afresh with your reply.

What it does not do:

- Reads are open apart from that list. A secret anywhere else your user can read (another project's
  `.env`, a browser profile) is readable; hide it with `denyRead`.
- Every allowed host is a way out for what a command could read, and an agent always reaches
  Anthropic's API. Grant as few as you can, and never one where anybody can publish (a code host, a
  paste site).
- No CPU, memory or process limits: a command can still load the machine until its timeout.
- The kernel is shared. This is not a virtual machine; a kernel exploit gets out. For a harder
  boundary, see [Running dulger in a container or VM](#running-dulger-in-a-container-or-vm).
- The environment is unchanged: commands still get it without the agent credentials, Claude Code with
  them, and your other variables (a project's `NPM_TOKEN`) still pass.

**Modes.** `off` (the default) wraps nothing, and every run says so in its first lines. `auto` wraps
agents and commands where the runtime works and, where it does not, runs them as before and says why
at the start of the run, with the fix. `required` starts no run where the runtime does not work: the check
before the run fails before any planning. `dulger doctor` shows the mode, whether the runtime works
here (it runs one real sandboxed command to find out), and what to install when it does not.

**The policy is yours, not the repository's.** It is read from `~/.config/dulger/config.json`
(`$XDG_CONFIG_HOME/dulger/config.json`), under `sandbox`; nothing else in that file is read yet. A
`sandbox` key in `<repo>/.dulger/config.json` or in a profile is ignored, and `dulger doctor` and the
run say so. A run never saves the sandbox with its settings, so a resume uses this machine's policy as
it is now. `--sandbox off|auto|required`, `/sandbox` and `/set sandbox` change the mode for one
command or session; `/config save` does not save it.

```jsonc
{
  "sandbox": {
    "mode": "auto",                           // off | auto | required
    "allowWrite": ["~/.cargo/registry"],      // writable on top of the worktree and its temp dir; literal paths, missing ones skipped
    "allowRead": ["~/.npmrc"],                // readable although the built-in list hides it (a file by its exact path)
    "denyRead": ["~/work/other-client"],      // hidden on top of the built-in list
    "domains": {
      "setup": ["registry.npmjs.org"],        // worktreeSetup
      "verify": [],                           // verify commands, final verification, the API tools' shell and git
      "agent": []                             // Claude Code agents and their MCP servers, on top of Anthropic's API
    }
  }
}
```

Paths are absolute or start with `~/`; hosts are `example.com`, `*.example.com` or `host:port`.
Anything else in `sandbox`, or a setting misspelled, is an error rather than a policy that silently
grants less or more.

Recipes:

- **npm.** `npm ci` (in `worktreeSetup`) installs offline when every package is in your `~/.npm` cache,
  which only needs reading. For a cache miss grant `"setup": ["registry.npmjs.org"]` and
  `"allowWrite": ["~/.npm"]`; a registry token in `~/.npmrc` also needs `"allowRead": ["~/.npmrc"]`.
  `npm test` with `node --test` runs as it is.
- **cargo.** `cargo build` and `cargo test` without dependencies run as they are. With crates.io
  dependencies grant `"index.crates.io"` and `"static.crates.io"` to the kind that downloads them
  (`setup` with `"worktreeSetup": "cargo fetch"`, otherwise `verify`) and `"allowWrite": ["~/.cargo/registry"]`.

Requirements:

- **Linux:** `bubblewrap`, `socat` and `ripgrep` on `PATH`: `sudo pacman -S bubblewrap socat ripgrep`,
  `sudo apt install bubblewrap socat ripgrep` or `sudo dnf install bubblewrap socat ripgrep`.
  Ubuntu 24.04 and later restrict the unprivileged user namespaces bubblewrap needs; the runtime's
  README explains the `kernel.apparmor_restrict_unprivileged_userns` setting.
- **macOS:** nothing to install (Seatbelt is part of the system). Not yet tried with dulger.
- **Windows:** not supported natively; run dulger in WSL2, where the Linux requirements apply.

Limitations:

- While a sandboxed command or agent runs in a worktree, the runtime mounts empty read-only
  placeholders over the protected names that do not exist there (`.bashrc` and the other shell rc
  files, `.gitconfig`, `.gitmodules`, `.mcp.json`, `.ripgreprc`, `.vscode`, `.idea`, `.claude/`). So
  neither can create `.vscode`, `.gitmodules`, `.mcp.json`, a shell rc file or
  `.claude/commands|agents`, nor change an existing `.claude/`, `.husky/` or `.githooks/`: a task
  that has to edit them fails in the sandbox. A verify command that checks `git status` is clean sees
  the placeholders as untracked, and so does an agent. They go when the command or agent ends; when
  one could not clean up, dulger removes untracked empty leftovers before it commits. Nothing appears
  in your checkout, where the planner runs: nothing is writable there.
- Inside, `git status`, `diff` and `log` work; `git add`, `commit` and `stash` do not (the repository's
  `.git` stays read-only). dulger does the committing.
- Each command or agent call costs about 0.2 s and 90 MB more. A Claude Code call measured no slower
  (13 s sandboxed against 15 s without, in one comparison), since the MCP servers it cannot reach
  fail at once.
- Whether the runtime works is checked once per dulger process: after installing what was missing,
  start dulger again.

## Running dulger in a container or VM

The sandbox shares your kernel and leaves reads mostly open. For a harder boundary, a separate kernel
or a machine with none of your credentials on it, put the whole of dulger in a box you bring: a
container, a dev container or a VM; dulger does not manage boxes. Use one for unattended runs, for a
repository you do not fully trust, and on a machine with credentials you would not hand to an agent.

**What goes in:** dulger, the agent CLI, the project's toolchain, git with a user name and email
(dulger commits) and a clone of the repository. dulger's other state, worktrees included, lives under
`$DULGER_DATA_DIR` (default `~/.local/share/dulger`), so nothing is mounted from your home. Keep it
next to the clone, not in the box's throwaway home: a resumed card whose worktree has gone starts
again from the result branch, without its finished tasks' work. A box gone mid-run leaves the run
locked by an owner dulger cannot check: with no box on it, remove `.dulger/runs/<runId>/execution.lock`.

**Work on a clone, fetch the result.** A writable mount of your checkout is a way out of the box:
anything inside can change files your host later runs, `.git/hooks` and `.git/config` included. Give
the box its own clone in a directory that holds nothing else, made with `git clone --no-local` (a
plain local clone hardlinks your object files into it), and take only the result branch out with
`git fetch`: it copies commits, checks nothing out, runs none of that repository's hooks and ignores
its `uploadpack.packObjectsHook`. Run nothing else there: `git status` runs the box's `core.fsmonitor`
and `git checkout` its hooks, and so can a shell prompt or an editor that runs git in that folder. To
read nothing of it, fetch from a bundle the box writes (`git bundle create <file> dulger/<runId>`).

**Credentials:** the box's own, not a mounted `~/.claude` or `~/.codex`. For Claude Code, an API key in
`ANTHROPIC_API_KEY` or a [`claude setup-token`](https://code.claude.com/docs/en/authentication) token
(valid a year, model requests only, needs a Pro, Max, Ultra, Team or Enterprise plan) in
`CLAUDE_CODE_OAUTH_TOKEN`; for an API provider, its `apiKeyEnv`. dulger keeps them from verify commands,
`worktreeSetup` and the API tools' shell; the agent CLI has them and can read all the box holds.

**Network:** a box with open egress can still send out whatever is in it. The `init-firewall.sh` of the
[Claude Code dev container](https://code.claude.com/docs/en/devcontainer) is a starting point: it
drops outbound traffic except to npm, Anthropic's API, GitHub's ranges and a few VS Code and telemetry
hosts, lets DNS, SSH and the host's /24 through, and needs the `NET_ADMIN` and `NET_RAW` capabilities.
Anybody can push to GitHub or over SSH, so trim it. Or use the runtime's `--network`; `none` cuts all.

**Not as root:** on Linux and macOS, Claude Code refuses `bypassPermissions`, which dulger's workers
use, as root or under `sudo` ([permission modes](https://code.claude.com/docs/en/permission-modes)).
It refused in a podman container too. Give the image a non-root user; the Node images have `node`.

**The process sandbox inside:** bubblewrap cannot start in an unprivileged container. In rootless
podman, `dulger doctor --sandbox auto` reported the tools missing, and with them installed said
`bwrap: Can't mount proc on /newroot/proc: Operation not permitted`. `auto` then runs without the
sandbox and says so, and `required` starts no run. Leave `sandbox.mode` `off` there: the box is the
boundary. In a VM the [Linux requirements](#sandbox) apply (not tried).

**Options:** a podman or docker container, as below. The Claude Code dev container brings Claude
Code, that firewall and a non-root user, and mounts your checkout: run dulger on a separate clone
(not tried). [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) gives each sandbox a microVM
with its own kernel, egress through a host proxy (deny by default, plus a default allow list), and a
`--clone` mode the host fetches from as a `sandbox-<name>` remote; dulger, not a listed agent, would
go in its Shell sandbox (not tried). Any VM or cloud machine, fetching the result over ssh (not tried).
Claude Code's [sandbox environments](https://code.claude.com/docs/en/sandbox-environments) compares them.

```dockerfile
FROM docker.io/library/node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && npm install -g @zamazingobjk/dulger @anthropic-ai/claude-code
USER node
RUN git config --global user.name dulger && git config --global user.email dulger@localhost
```

Add the project's toolchain before `USER node`. Then, from your repository (`--userns=keep-id` lets
the image's `node` user write `~/boxes/myapp` as you under rootless podman):

```sh
podman build -t dulger-box ~/boxes/image                 # holds the Containerfile above
git clone --no-local . ~/boxes/myapp/repo
podman run --rm --userns=keep-id -v ~/boxes/myapp:/work -w /work/repo \
  -e DULGER_DATA_DIR=/work/dulger-data -e CLAUDE_CODE_OAUTH_TOKEN \
  dulger-box dulger run "Add CSV export" --yes --quiet
git ls-remote ~/boxes/myapp/repo 'dulger/*'              # the run's branch
git fetch ~/boxes/myapp/repo dulger/<runId>:dulger/<runId>
git diff main...dulger/<runId>                           # review, then git merge dulger/<runId>
```

Tried as written, with `--network=none --harness fake --no-progress` in place of
`-e CLAUDE_CODE_OAUTH_TOKEN` (the box's token, from your shell); a run with Claude Code was not.

## Known limitations

Codex reports tokens but no prices and no plan-window figure, so its runs show only tokens. The
documentation agent's commit has final command verification but no additional agent review. Old runs are never deleted;
remove `.dulger/runs/<runId>` by hand. CLI workers use their configured harness permissions and integrations; direct API workers use local file
and shell tools. Provider-specific tool calling behavior can vary; an OpenAI-style key alone does not
guarantee that an endpoint supports the required Chat Completions tools.

## Development

```sh
npm run typecheck && npm test
```

To add a harness, implement `Adapter` in `src/adapters/types.ts` and register it in
`src/adapters/index.ts`; `src/adapters/fake.ts` is the smallest example.
