# dulger

A kanban of coding agents. Give it a goal; a planner turns it into cards, workers build the cards in
parallel git worktrees, a reviewer checks each one, and the result lands on a branch for you to merge.
Agents use headless [Claude Code](https://claude.com/claude-code) or
[Codex](https://github.com/openai/codex), or connect directly to Ollama, DeepSeek and OpenAI-compatible APIs.
CLI backends use your existing login; API backends use environment variables. No build step.

```sh
cd your-repo
dulger                       # interactive prompt: type a goal, or /help
dulger run "Add CSV export to the reports page"
```

## Install

Node 24+ and git. CLI backends also need `claude` or `codex` on your PATH; direct API backends do not.

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
   reviewer asked for and was refused. A reviewer that cannot run at all is dulger's failure, not
   the card's: no round is spent, no worker is asked to fix it, and `dulger resume` retries the card
   from its worktree.
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
dulger board | report [runId] print a run's board / what it landed
dulger runs                   list runs
dulger memory [list|add|rm|compact|path]
dulger clean                  remove leftover worktrees and wip branches

--harness <name>              --model <name>        --concurrency <n>     --max-attempts <n>
--yes                         --no-docs             --merge               --allow-dirty
--base-url <url>              --api-key-env <name>  --no-routing
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
  "budgetUsd": 200,                // stop the run (resumable) at this spend; --budget on the command line
  "cardBudgetUsd": 50,             // fail a card at this spend; --card-budget
  "worktreeSetup": "npm ci",       // run once in every new worktree
  "claude": { "mcp": true },       // workers get your MCP servers; the planner and reviewer never do
  "codex": { "bypassSandbox": false },
  "memory": { "location": "user", "maxItems": 40, "maxChars": 6000 },
  "tui": { "enabled": true, "icons": "auto" }   // full-screen run view; icons nerd | unicode | ascii | auto
}
```

## Model routing

Automatic routing is on by default. The planner labels each task `low`, `medium` or `high` complexity.

| Tier | Claude Code | Codex |
| --- | --- | --- |
| Low: mechanical edits, simple docs | `haiku` | `gpt-5.6-luna` |
| Medium: routine features, fixes, tests | `sonnet` | `gpt-5.6-sol` |
| High: architecture, security, difficult debugging | `claude-fable-5-1` | `gpt-6-astra` |

Planning and review always use high: what the reviewer misses lands unseen. Documentation uses low.
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

In the prompt, `/provider openrouter` asks for the base URL, the key variable and the model, and when
the variable is not set, for the key itself, typed without echo and stored in
`~/.config/dulger/keys.json` (mode 600, never in a repository; an exported variable always wins).
`/provider` lists every provider and where its key comes from; `/provider <name> key` replaces a key.
`/config save` then writes the endpoint and the variable name to the repository config.

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
- Ctrl-C stops the agents and saves the board. `dulger resume` picks it up, and also retries cards
  that failed on dulger's side (a reviewer that would not start, an agent that hung) rather than on
  their work. When the harness account hits its usage limit the run stops itself the same way, so a
  reset window is not spent on cards that cannot run.
- Before you dispatch, the log warns about cards too big for one reviewer and foundation cards that
  do more than the cards waiting for them need. Those are the plans that fail late and expensively.

## Known limitations

Codex reports tokens but no prices and no plan-window figure, so its runs show only tokens. The
documentation agent's commit is the one piece of work nobody reviews. Old runs are never deleted;
remove `.dulger/runs/<runId>` by hand. CLI workers use their configured harness permissions and integrations; direct API workers use local file
and shell tools. Provider-specific tool calling behavior can vary; an OpenAI-style key alone does not
guarantee that an endpoint supports the required Chat Completions tools.

## Development

```sh
npm run typecheck && npm test
```

To add a harness, implement `Adapter` in `src/adapters/types.ts` and register it in
`src/adapters/index.ts`; `src/adapters/fake.ts` is the smallest example.
