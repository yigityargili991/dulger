# Changelog

## Unreleased

- Jev, TypeSafe's calibrated scoring model, can tag each task's difficulty instead of the planner.
  `routing.router` is `planner` (the default), `jev-openrouter` (`OPENROUTER_API_KEY`),
  `jev-typesafe` (`TYPESAFE_API_KEY`) or `jev-local` (a llama-server running clef-flash on
  `http://127.0.0.1:8080`); `routing.jev` changes the endpoint, e.g. its port. The first interactive
  `dulger`, `dulger run` or `dulger order` asks which and saves the answer in your own config file;
  Router in Settings and `/router` change it later. When Jev fails, the run keeps the planner's tags
  and logs a warning.
- The default model tiers are current again. On Claude Code the high tier is the `fable` alias, not
  `claude-fable-5-1`, so all three tiers (`haiku`, `sonnet`, `fable`) follow the newest model of their
  family. The Codex tiers are `gpt-6-luna`, `gpt-6.1-sol` and `gpt-6-astra` (were `gpt-5.6-luna`,
  `gpt-5.6-sol`, `gpt-6-astra`). A `routing.models` entry in `.dulger/config.json` still wins.
- The README is now a short introduction. The full manual moved to `docs/manual.md`, and the
  documentation site is built from it.
- `dulger` with no arguments opens the dulger app when stdin and stdout are terminals, the full-screen
  view is on and `--quiet` is not given. Its tabs: Home (a Goal box with a Run / Plan switch, the
  latest runs, and a Roles box with each role's backend, the settings that change a run and anything
  that would stop one), Runs (every run with its state, facts and cards; review, resume, retry, edit
  plan, merge, full report and clean leftovers are keys), Settings (every session setting in one form;
  save to the repository, discard, profiles), Models (each role's backend and model, model sets, the
  global pin), Providers (API providers, masked key entry, the models an endpoint lists), Memory (add,
  remove and compact what agents learned) and Doctor (the readiness checks, each one jumping to its
  fix). A result opens in a review: the report, the changed files with coloured diffs, verification,
  and a merge that shows its source, destination and blockers and asks before merging. An unstarted
  plan opens in a plan editor: cards, tasks, dependencies as checkboxes that cannot form a loop, verify
  commands shown whole, a worker override, undo, and Ctrl-S that validates the whole plan before
  saving; it holds the run's lock only while it is on screen.
- The screens show state only: labels, values, glyphs and counts, in boxes sized to what they hold.
  What a row means and what each key does are in Help (`?`, or F1 while typing), which starts with
  the selected item; the footer is a short key bar ending in `? help`. Tab badges are a glyph and a
  number (`▶2` unfinished runs, `✎2` unsaved settings, `!1`, `✗1`, `✓`), `✎` marks what this session
  changed, `●` a switch that is on, `◌` an interrupted run, and the selection in a box without the
  keyboard is `›`; with ASCII icons the whole frame is ASCII. An action that cannot run now says why
  when you press it (`Resume: finished`). Dialogs are a title, the facts as rows and their buttons;
  notices are a few words at the top right. Ctrl-P or `:` opens a command palette of names and keys.
  Alt-1 to Alt-9 switch tabs everywhere; bare digits and `[` `]` only on a tab's own page. The mouse
  and bracketed paste work throughout.
- Changes in the app apply to the session. Nothing is written to the repository until Save to
  repository (`s`), which shows the files and every change it writes (values the form has no field for
  included), writes a role only when it differs, and never writes the session settings (Skip
  approval, Quiet output, Allow dirty tree, Sandbox) or API keys. After a save, Commit settings…
  offers to commit `.dulger/config.json` alone, with the message `dulger: save settings`, after a
  confirmation that names the branch; Not now is the default and dulger never commits on its own.
  Quitting does not ask about unsaved session settings; one line printed after the app closes names
  them. A page with unsaved edits (the plan editor, a provider form) asks before it closes. `q` quits
  from a tab's own page only; over a page opened on top of a tab, Ctrl-D quits.
- The backend, the roles' backends and models, routing and API providers are saved to your own
  `~/.config/dulger/config.json` (Save and `/config save`), no longer to `.dulger/config.json`, so they
  and the keys stored for those providers follow you into every project, and they win over a
  repository's own values. A provider that a saved role uses and only the repository defines is copied
  there too. Saving only these leaves the repository's file as it was.
- The app uses one name per thing: Docs agent, Skip approval, Run budget, Card budget, Routing and Full
  screen in Settings and on Home, `default model` on Models, and the backend, `sandbox <mode>`,
  `routing off` or `pin <model>` in the header.
- The setup menu and the unfinished-runs question no longer come first: Home shows the session and
  the unfinished runs. The line prompt opens instead of the app with `--quiet` or the full-screen view
  off, without menus, and from the palette (Open the line prompt; `/quit` goes back to the app with the
  same session). Its slash commands work as before, `/setup` opens the menu, and `/mouse on|off` is new.
- A goal, resume or retry started from the app runs the readiness checks on the settings it will use
  first: a failing check, uncommitted changes, a role without a model or a provider without a key stop
  it in a dialog with a button for the page that fixes it, before any run record is made, and the goal
  stays in its box. When `.dulger/config.json` is the only uncommitted change, Commit is the first
  button and the launch carries on after the commit; Home lists the same as a short line, and Doctor
  agrees with Home that uncommitted changes the session does not allow are an error.
- The live run view is rebuilt on the same widgets. The plan pause is a review screen: the planner's
  assumptions and what it left out, dulger's warnings, and every card with its tasks, dependencies and
  verify commands shown whole (`verify —` when it has none), with Dispatch, Revise, Edit plan, Cancel
  run and Keep in backlog. Enter still dispatches, typed text still revises the plan and Ctrl-C still
  keeps it in the backlog; Edit plan opens the plan editor and comes back to the review, and Cancel run
  now asks before it deletes the run. A reply typed and not sent is never taken as a go: Enter or
  Dispatch goes back to it. Tab completes `go`, `cancel` and `/edit`. Enter and clicks are ignored for
  300 ms after the review appears, after a revision and after a resize, and after a revision the plan
  opens with your reply and what the planner did, marking cards `new` or `changed`. Stopping a card and
  approving the new verify commands a replan brings are dialogs that still need the typed words `stop`
  and `yes`; an approval waits while another dialog is open and ignores input for its first 300 ms.
  Instructions for a card are a multi-line dialog. Tab cycles the board, the agents and the log, `z`
  zooms a pane, help lists the keys that work now, the header keeps the goal in view, shows the cards
  done as a bar and marks a paused run, and the log follows the newest lines until you scroll up.
- Resuming from the app (Home, Runs or the review) asks once, in one dialog: the goal, what is done and
  what resuming will build, and, when the run's saved settings differ from the session's, each
  difference by its Settings name with Keep original or Use session (and Details for the rest). The run
  then goes on without asking again. A retry from the app keeps the run's saved settings and its card
  picker says so when the session's differ.
- A run started from the app draws its live view on the app's screen and prints nothing on the normal
  screen: no banner, no report underneath the app, no flash of the shell in between. The app shows
  the outcome itself when the run ends.
- Times in the run log, in the live view and in plain log lines, are local time instead of UTC, like
  the other times dulger shows.
- A new setting, `tui.mouse` (default `true`; Mouse in Settings, `/mouse`), turns wheel scrolling and
  clicks in the full-screen views on or off; off leaves the mouse to the terminal for selecting text.
  Mouse and Icons apply at once. `NO_COLOR` turns the colour off in the full-screen views too, which
  then put the pointer before the focused box's title, bracket the active tab, buttons, labels and
  typed fields, and put placeholders in parentheses.
- "The latest run" is now the most recently started one everywhere: on Home and Runs, and for
  `dulger resume`, `board`, `report` and `merge` without a run id; `dulger runs` lists by start time.
- Clean leftovers, in the app and as `dulger clean`, leaves runs another dulger process is using alone
  and says so, cleans the rest, and warns that the worktrees failed cards keep for a retry go too and
  that the folders are shared by local clones of the repository.
- A merge you started yourself is never aborted by dulger: the review names it as yours and blocks
  merging the run until you finish or abort it. Abort is offered only for a merge dulger started for
  that run, and its confirmation says what is lost.
- A provider URL that contains credentials, a query or a fragment is refused: in the app, at
  `/provider`, when settings are saved and from `--base-url`. Credentials already in a configured URL
  are masked wherever the app or `/provider` shows it.
- Text from the board and from agents is cleaned of terminal control sequences everywhere it is
  printed, not only in the full-screen view: the plain table, log lines, the printed board and the
  report. Piped output carries no escape sequences. Verify commands are spelled out the same way in
  every view, invisible characters included, and the plan editor will not edit a command a text box
  could silently change (a tab, a control or format character): remove it or type a new one.
- A board whose `runId` does not match its folder, or whose branch or base names start with `-` and
  could be read as git options, is refused with a message saying how to repair it, and dulger deletes or
  merges a branch only when it is exactly `dulger/<runId>`.
- A keys file that is not valid JSON is never overwritten: storing a key is refused with the file
  named, and keys read from it show as unreadable.
- Terminal input: a paste whose end marker, or an escape sequence, is split across two reads is put
  back together instead of turning into typed keys, an unterminated paste is taken as it stands after
  2 s, and keys are handled in the order they were typed. SIGTERM, SIGHUP and an outside SIGINT give the
  terminal back (raw mode, mouse and paste modes, cursor) before the process ends.
- The plain plan prompt asks before deleting a run on `cancel`, `abort`, `drop` or `discard`: only a
  typed `yes` deletes. It completes `/edit`, and after a revision prints what you asked and what the
  planner did. Ctrl-C while the planner plans or revises stops cleanly; `dulger run` prints how to plan
  it again and exits with status 130.
- The report says why a card did not land in plain words: stopped by you, its verify commands failed
  and it never reached review, failed before its review, not started, or interrupted.
- `/icons` and `/routing off` no longer reset the other `tui` and `routing` fields to their defaults,
  which could overwrite a repository's tier models on `/config save`.
- `dulger runs` lists a run whose board cannot be read as unreadable and carries on with the others
  instead of stopping.
- Merging a run whose result branch was deleted says that the branch no longer exists.
- `/order` at the line prompt offers to review and merge the run it created when cards landed, not
  the newest run in the list.
- A `.dulger/profiles.json` that is not valid JSON, or not an object of profiles, gives an error that
  names the file instead of a parser message.
- `dulger --help` shows `dulger resume [runId]` (latest when omitted), and the line prompt's `/help`
  describes `/setup`, `/runs` and how the full-screen view is turned off for good more accurately.

## 0.7.2 — 2026-11-14

- The project moved from GitLab to GitHub: the repository and issues are at
  https://github.com/yigityargili991/dulger, and CI runs on GitHub Actions. The documentation site
  moved from Railway to GitHub Pages at https://yigityargili991.github.io/dulger/; its links are
  relative, so it works at a domain root or under a path. The package's repository and bugs links
  point at the GitHub repository and its homepage at the site.

## 0.7.0 — 2026-11-14

- A process sandbox, new and built on Anthropic's sandbox runtime (a beta research preview), for
  Claude Code agents and the commands dulger runs on agents' code: verify commands, final
  verification, `worktreeSetup`, and the API tools' shell and `git diff`. Each agent call and each
  command runs in its own `srt` process that writes only its worktree and a temp dir, cannot read
  your credentials or other cards' worktrees, and reaches only the hosts you grant. Claude Code
  agents (planner, workers, reviewer, documentation; not the tool-free progress reporter) also reach
  Anthropic's API and a gateway set in `ANTHROPIC_BASE_URL`, plus `sandbox.domains.agent`, and can
  still read their own login. The planner writes nothing in your checkout. Of `~/.claude` only the
  session's transcript directory is writable; the planner's is the one your own sessions in the
  repository use, so there it can only add its session and continue the one it resumes, never change
  your transcripts or the auto-memory. Card ids that differ only in case or in `_` against `-` would
  share a transcript directory, so a plan or replan with such ids is refused. Claude Code's own Bash
  sandbox is switched off inside, your MCP servers and hooks run inside with the agent (SessionStart
  hooks cannot run), and the agents are told what the sandbox allows. A sandboxed agent stays in
  dulger's process group, so closing the terminal ends it as it ends an unsandboxed one. Codex keeps
  its own sandbox and is not wrapped. `sandbox.mode` is `off` (the default, and every run says so),
  `auto` or `required` (no run starts where the runtime does not work); `dulger doctor` says whether
  it works here. Placeholder files a killed sandbox left in a worktree are removed before dulger
  commits, also when the run is resumed without the sandbox.
- The sandbox policy is read only from your own `~/.config/dulger/config.json`, `--sandbox` and
  `/sandbox`: a `sandbox` key in a repository's `.dulger/config.json` or a profile is ignored and
  reported, runs never save it, and resume always uses the machine's current policy.
- Learnings reach the memory only when their card lands. A card that fails, is stopped or is
  replaced no longer adds what its workers reported to the memory that later planners, workers and
  reviewers read. When a card lands, every task's learnings are kept, fix tasks included.
- A card's verify commands, which the planner writes, are allowed to the reviewer only exactly as
  written; `checker.allowedCommands` on Claude Code still accept added arguments. A verify or
  configured command that is blank or contains `*`, `(`, `)`, `\\`, a trailing `\` or a control
  character is not offered to a Claude Code reviewer, because its permission rules would read it as
  another rule: `*` is a wildcard, and a `)` followed by a space or comma ends the rule, so
  `echo "a) Bash"` would allow all of Bash. An API reviewer's `run_command` lists the verify commands
  and runs them as exact commands.
- Verify commands, final verification, `worktreeSetup`, and the API tools' shell commands and
  `git diff` no longer receive the credentials dulger runs agents with: every configured provider's
  `apiKeyEnv`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY`, `CODEX_API_KEY` and `DEEPSEEK_API_KEY`. Other variables, such as a project's
  `NPM_TOKEN`, still pass through. Claude Code and Codex themselves keep their environment.
- dulger's own git commands in worktrees and on its branches (creating and removing worktrees, its
  commits, merges and branch updates) no longer run git hooks. `--no-verify` skipped only pre-commit
  and commit-msg, so post-checkout, post-commit, post-merge, prepare-commit-msg and
  reference-transaction hooks ran with your privileges, and with a relative `core.hooksPath` or a hook
  manager configured in the tree they were files a worker wrote. Merging the result branch into your
  branch (`--merge`, `/merge`) still runs your repository's hooks.
- A plan nobody could review is no longer dispatched. Without a terminal (piped stdin, CI) and
  without `--yes`, a new run, an order, or a resume of a run that has no cards yet plans, prints the
  board and stops with a non-zero exit; the run waits in the backlog. `dulger resume <runId>`
  dispatches it as it is, or rerun with `--yes`. A plan dispatched unreviewed because of `--yes` logs
  the verify commands it will run. `dulger board` and the plan prompt outside the full-screen view
  now list each card's verify commands.
- Verify commands a replan adds need approval. When the planner's new cards use a command that is
  neither on the board already nor in `checker.allowedCommands` (exact match, so `npm test; curl x | sh`
  is not `npm test`), the run asks before applying the replan and only a typed `yes` accepts. Enter,
  any other answer or dismissing the question drop the replan and leave the board as it was; running
  cards carry on meanwhile. Stopping the run drops it too, without counting it against `maxReplans`.
  `--yes` accepts them and logs which; it now reaches `dulger order`, `resume` and `retry` too, and
  `/yes on` does the same. Without a terminal or `--yes` the replan is dropped. The replanning
  planner is told to reuse the board's commands.
- The README documents running the whole of dulger in a container or VM of your own, for a boundary
  the process sandbox does not give: the box works on a clone of its own and the host takes out only
  the result branch with `git fetch`, which runs none of that clone's hooks. It also covers the box's
  own credentials, egress, a non-root user, and the process sandbox inside a container.

## 0.6.0 — 2026-09-19

- Added readiness checks, repository-local named profiles, execution limits in setup, a searchable
  run browser, direct plan editing, live pause/stop/instruction controls, and a persistent result
  review with per-file diffs and explicit merge confirmation.
- Runs preserve versioned execution settings and checkpoints. Resume defaults to those settings;
  `--current-settings` explicitly replaces them. Execution, edit, merge and cleanup use run locks.
  Harness capabilities now describe tool-free mode, continuation, discovery and cost reporting.
- Final verification reruns landed cards' commands after documentation, records the exact result
  revision, and blocks merging on failed or stale checks. Verification and worktree setup keep the
  terminal responsive and support cancellation. Failed setup stops agents and is retried on resume.

- Interactive sessions start with a keyboard menu for the harness, model set, a model for all roles,
  and per-role overrides. It previews effective models, supports filtering and custom model IDs,
  and reads API provider model lists when credentials are available. Start applies the draft only
  to the session; cancel preserves the old settings. `/setup` reopens it and `/config save` persists
  choices. `--yes`, `--quiet`, a disabled TUI, and direct CLI commands keep the non-menu path.

- Reporter failures no longer halt workers; pending reports are cancelled before documentation,
  and their final cost and usage are saved even when the run is stopped. Reporters run without tools
  on Claude Code and API providers. Codex reporters are skipped with a configuration hint because
  Codex CLI cannot disable every built-in tool.
- Prompt predictions are cleared before cursor movement and submission. Tab leaves mid-line input
  unchanged, and pasted input draws its suggestions once.

- Card-wise progress reporting while a run is in flight: every `progressIntervalSec` seconds
  (default 120), a lightweight headless agent summarizes what each in-progress card's worker has
  been doing — from the live activity digest only, on the low-tier model — and writes a one-line
  note onto the card. The note takes the card's line in the full-screen view while it is fresh
  (with a warning marker when the reporter flagged something: a worker going in circles, stuck or
  off-scope), appears in the card detail with its age, in `dulger board` output, and in the report
  for cards that never finished, and is a `progress` event in the run log. The reporter never
  touches the worktree, its cost lands on the run rather than the card, a reporter that fails
  only costs the note, and a note that arrives after its card landed, failed or was blocked is
  dropped rather than stored. Configure it with `progressIntervalSec`, `--progress-interval <sec>`,
  `--no-progress` or `/progress on|off|<sec>`; `roles.reporter` picks its backend and model like
  any role, and `--model`/`/model reporter` pin it. Zero disables it.

- The prompt predicts what you are typing. The rest of the word is drawn dim after the cursor and Tab
  takes it; when several words fit they are listed under the line with a one-line description each, or
  counted when there are too many to list. It completes arguments too: roles, aliases, backends and
  harnesses for `/model`, configured providers for `/provider`, run ids for `/board`, `/report`,
  `/resume`, `/merge` and `/retry`, the latest run's failed cards for `/retry`, learned ids for
  `/memory rm`, each setting's values for `/set` and the setting commands, and `go`/`cancel` at the
  plan approval pause. It never types anything you did not ask for: goals, a mid-line cursor and a line
  past its last argument are left alone. `/help` now lists `/concurrency` too.

## 0.5.0 — 2026-09-12

- The website: https://dulger-site-production.up.railway.app, a static Astro site dulger built from its
  own README in one $17 run; the README and the package's homepage link to it.
- Provider setup asks for the key first and then lists the endpoint's models to pick from, by number
  or by narrowing on part of a name; `/provider <name> model` re-picks. Choosing a provider whose key
  is missing, in the prompt or when a run starts, asks for the key on the spot.

- The report is compact by default: three lines per landed card (title, the reviewer's first sentence,
  spend / rounds / verify / note count), one reason line per card that did not land, the diff-stat
  total, and the next steps. `dulger report --full` (and `/report full`) prints every task summary,
  review, note and diff-stat line, wrapped to the terminal. Everything is fitted to the terminal width,
  the board is printed once per run (at the approval pause, assumptions wrapped) rather than again after
  it, and log lines are one line each.

## 0.4.0 — 2026-09-12

Runs
- A run stops itself when the harness account hits its usage limit or the run reaches `budgetUsd`
  (`--budget`): nothing else is dispatched, the card in flight stays resumable, the report says why, and
  `dulger resume` continues. `cardBudgetUsd` (`--card-budget`) fails a card at that spend, checked
  before each task and before review.
- Failures are classified. A worker that answered but could not finish, or a card the reviewer
  rejected, failed on its work. An agent that never answered, or a reviewer that could not run, is
  dulger's failure: no round is spent, no fix task is sent, nothing is replanned, and `dulger resume`
  retries the card from its worktree with finished tasks kept.
- `dulger retry <card>` (and `/retry`) gives a card that failed on its work one more review round
  (`--max-attempts` for more). Its last rejection stays on the card as a pending fix task, so the retry
  starts by addressing exactly that, and the cards blocked behind it get another chance. Docs run
  again after a retry or resume lands more work.
- The prompt for Claude Code goes on stdin instead of the command line; a large diff used to make the
  reviewer fail to spawn (`E2BIG`), which then read as a rejection. A diff too large for one prompt is
  no longer truncated: the reviewer gets the file list and reads it file by file in the worktree.
- The stall watchdog counts the model's thinking as progress. A replan agent that dies gets a second
  session before the replan counts as failed.
- The planner is told how big a card may be, that a foundation card holds only what its dependants
  need, and that a card producing a GUI must give the verify gate a headless self-test. dulger warns
  on the board about cards with more than three tasks and foundation cards that do too much.
- A retried task is told that it ran before, what that session reported or why it died, and that the
  worktree may hold its leftovers.

Reviewer
- Always runs on the high routing tier: review quality is the gate.
- Told to raise every blocking problem in the first round and, later, to block only on what a fix
  failed to address or newly broke. Its own earlier notes are shown to it as settled.
- Sees which files in the diff no task reported changing, to catch reformatting and work outside the
  card. Notes are recorded once; the board printout shows a count of notes, the report lists them.
- Read-only agents may run version probes such as `cargo --version`.

Models and backends
- Routing, on by default: the planner and reviewer use the high tier, workers the tier of their task's
  complexity as labelled by the planner (one tier up per retry), docs the low tier. With Claude that
  is fable / sonnet / haiku unless a role is pinned; `--no-routing` or `"routing": { "enabled": false }`
  restores harness defaults. Explicit `--model` and per-role pins win.
- Direct OpenAI-style API backends, new and so far exercised only under tests: ollama, deepseek and
  openai are built in, and any `providers.<name>` entry (openrouter, groq, a self-hosted vLLM…) is a
  backend with its own key variable, model and tier map. `--harness <name> --base-url … --api-key-env …`
  defines one for a run. Agents get a small coding toolset (list, read, write, diff, shell) inside the
  worktree; requests are retried on 429/5xx with backoff; `commandTimeoutSec` bounds the shell tool; a
  failed request carries the server's own error message, redacted.
- `/provider <name>` defines a backend from the prompt, key included: typed without echo and kept in
  `~/.config/dulger/keys.json` (mode 600), read when the key's environment variable is not set.
  `/provider` lists providers and where their keys come from.
- `/model <role> <choice>` mixes backends and models per role in the prompt, `/model` shows the
  effective routing, `/config save` persists session settings (endpoints and variable names, never keys).

Terminal
- The full-screen view adapts to the viewport: compact cards on narrow screens, input space reserved
  on short ones, no minimum-size gate. Agent output is sanitised before styling; raw mode and the cursor
  are restored on close.

Board format
- Cards carry `verify` and `verification`, `failure` (work or infrastructure) and `reason` (why dulger
  stopped the card; `feedback` now holds only what reviewers said); tasks carry `complexity` and the
  last `error`; the board carries `halted`. Boards from earlier versions are read into this shape on
  load.

## 0.3.0 — 2026-09-10

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
