# dulger

A kanban of coding agents. Give it a goal; a planner turns it into cards, workers build the cards in
parallel git worktrees, a reviewer checks each one, and the result lands on a branch for you to merge.
Agents use headless [Claude Code](https://claude.com/claude-code) or
[Codex](https://github.com/openai/codex), or connect directly to Ollama, DeepSeek and OpenAI-compatible APIs.
CLI backends use your existing login; API backends use environment variables. No build step.

```sh
cd your-repo
dulger                       # the app: type a goal, see what will run, review and merge results
dulger run "Add CSV export to the reports page"
```

## Install

Node 24+ and git. CLI backends also need `claude` or `codex` on your PATH; direct API backends do not.

```sh
npx @zamazingobjk/dulger                    # run without installing
npm install -g @zamazingobjk/dulger         # or install the `dulger` command
```

From a checkout of https://github.com/yigityargili991/dulger: `npm install && npm link`.

## Session setup

`dulger` with no arguments opens the dulger app: a full-screen workbench for the repository you are
in. It opens when stdin and stdout are both terminals, the full-screen view is on (`tui.enabled`, the
default) and `--quiet` is not given; otherwise `dulger` opens the [line prompt](#the-line-prompt).
The session starts from the repository's `.dulger/config.json`, [your own config
file](#configuration) and the flags you pass, so `dulger --harness codex --concurrency 2` starts with
those, and `dulger --yes` starts with plan approval off. What you change in the app lasts for the
session; nothing is written to the repository until you save it. Direct commands such as `dulger run`
and `dulger resume` keep their flag-driven behavior.

The header shows the repository and its branch, then the backend and the sandbox mode, with
`routing off` when model routing is off and `pin <model>` while a global pin is set. Below it are
seven tabs. A tab's badge is a glyph and a number: `▶2` unfinished runs, `✎3` unsaved settings, `!1`
problems that stop a run (Home) or notes compaction would drop (Memory), `✗1` failing checks or `✓`
(Doctor). On a narrow terminal the tab names are shortened, and `‹` `›` show that tabs are out of view.

| Tab | What you do there |
| --- | --- |
| Home | Type a goal and start it; see what will run; resume an unfinished run |
| Runs | Every run with its state and cards: review, resume, retry, edit the plan, merge, clean up |
| Settings | Every session setting; save them or discard them; profiles |
| Models | Each role's backend and model, model sets and the global pin |
| Providers | API providers, their keys and default models |
| Memory | What agents learned about the repository |
| Doctor | The readiness checks, each with the tab that fixes it |

The pages show state and nothing else: labels, values, glyphs and counts. What a row means, what a
key does and why an action cannot run now are in the help overlay, which opens with what is
selected; this manual explains the rest.

### Getting around

- `?` opens **Help** for the page, F1 while you are typing in a field (where `?` is typed). It starts
  with the selected item and what it does, then the page's keys, then a short About, then the keys
  that work everywhere.
- Alt-1 to Alt-9, or a click on a tab, switch tabs from anywhere. On a tab's own page `1` to `9` do the
  same and `[` and `]` go to the previous or next tab; over a page opened on top of a tab (a review,
  the plan editor, a provider form) bare digits and brackets do nothing.
- Ctrl-P or `:` opens the command palette: the page's actions and the tabs by name with their keys
  (`Go to Home  1`), and the app-wide entries (New goal, Check readiness, Save settings, Open the
  line prompt, Help, Quit). Type to filter it; names that match come first. An
  action that cannot run now is dimmed, and choosing it says why.
- Esc goes back from a page opened over a tab, as **Back** in the palette does (**Close** for the plan
  editor opened from a run).
- Ctrl-D quits, and so does Ctrl-C pressed twice within two seconds; `q` quits on a tab's own page. A
  page with unsaved edits (the plan editor, a provider form) asks first. Session settings you changed
  and did not save are not asked about: after the app closes, one line names them.

The footer is a short key bar: the few keys that matter for what is selected, then `? help` (`F1
help` while you type). A page opened on top of a tab also shows where you are (`Runs › Review …`).
Everything else (the palette, Tab, `q`, zoom and the rest) is listed in help. An action that cannot
run now is not listed with a reason; pressing its key shows the reason in a notice, such as
`Resume: finished`, and help gives it too. Keys are handled in the order you type them, also when you
type faster than a dialog opens or closes.

While you type into a field, the digits, `[`, `]`, `?`, `:` and `q` go into the field (Alt-1 to
Alt-9, F1 and Ctrl-P still work); Esc leaves it. Dialogs are a title, the facts as rows and their
buttons; they take every key while they are open, the safe choice has the focus and Esc cancels. A
plain confirmation also takes `y` and `n`; one that deletes or discards something takes `n` but
never `y`: move to its button and press Enter. A typed confirmation reads `Type stop` (or `type
yes`). Pickers list names with a short tag at the right; their filter line appears once you type, or
when the list does not fit. Notices are a few words (`Saved`, `Merged → main`) at the top right,
beside the tabs when there is room; an error shows the tool's own message.

The mouse works too: click a tab, a row or a button, and the wheel scrolls the pane under the pointer.
The first click on a panel selects; a second click on the selected row opens it. A click outside a
dialog cancels it. Mouse off in Settings, `/mouse off` at the line prompt or `"tui": { "mouse": false }`
leaves the mouse to the terminal, so you can select text as usual; the setting applies at once.
Pasted text is always text: a pasted line break never presses Enter.

Boxes are as large as what they hold. In a box the selected row is marked `❯` while it has the
keyboard and `›` otherwise. `✎` marks a value this session changed, `●` a switch that is on (and a
running run), `◌` an interrupted run, `!` something to look at; ages read `now`, `5m`, `3h`. With
ASCII icons the whole screen is drawn in ASCII, and these are `*`, `-`, `~`, `o`, `%` and `!`.

### Home

Home has three boxes: **Goal**, **Runs** and **Roles**. The cursor starts in the Goal box (placeholder
`What should the agents build?`), which grows with what you type. Press Enter to start the goal;
Alt-Enter adds a line, and ↑/↓ on the first or last line bring back earlier goals: the ones typed this
session, then the goals of earlier runs, also after a restart. A goal of one or two words is confirmed
first (**Short goal**: Edit / Run). Ctrl-T switches between the two ways a goal starts, shown as
`Run  Plan` in the box's border:

- **Run** plans the goal and waits for your go at the plan, like `dulger run`. With plan approval off
  (Skip approval in Settings, or `--yes`) it builds straight away.
- **Plan** talks the plan through with the planner first, like `dulger order`.

Before anything starts, the app checks what would stop the run with the settings it will use:
uncommitted changes, a role on an API provider without a model, a provider without a key, and every
readiness check that fails (see [Doctor](#doctor)). A dialog (**Cannot start**) lists the problems and
has a button for the page that fixes the first one; no run is created and the goal stays in the box.
Uncommitted changes alone can be waved through for this one run (the dialog is then **Uncommitted
changes**) with **Start anyway**: the agents start
from the last commit and your edits stay where they are. When the only uncommitted change is
`.dulger/config.json`, the dialog is **Settings uncommitted** and its first button, **Commit**, commits
that file and goes on with the launch. Then the [live run view](#the-screen) takes the terminal, and
the goal box is cleared. When the run ends the app comes back: with the review of the result when
cards landed (notice `2/3 landed → dulger/…`), otherwise with the run selected on Runs and a notice
of what happened (`Not dispatched · 3 cards`, `Stopped · 1/3 done · 1 failed`, `Plan discarded`). A
goal that did not run stays in the box.

**Runs** lists the latest twenty runs, most recently started first: a state glyph, the goal, cards
done, spend and age; the box's badge counts the unfinished ones (`▶2`). `r` resumes the selected run,
or the latest unfinished one, after a confirmation; Enter opens a run on Runs.

**Roles** starts with anything that would stop a run, as short lines (`dirty tree`, `settings
uncommitted`, `no model: worker`, `no key: groq`, `codex not found`); Enter on one goes to its fix.
Readiness errors are checked again about every 30 seconds. Then every role with its backend, and its
model when it is pinned; then Parallel cards, Review rounds and
Sandbox, and Run budget and Skip approval when they are set. `✎` marks what this session changed.
Enter on a row opens the page that changes it.

Tab and Shift-Tab move between the boxes, Esc leaves the goal box and `n` goes back to it.

### Settings

Settings is one box of every session setting, a label and a value each, in four groups:

- **Execution:** Backend, Docs agent, Progress notes, Routing, Router.
- **Limits:** Parallel cards, Review rounds, Replans, Run budget, Card budget (both in dollars). A card
  budget at or above the run budget is tagged `≥ run`, since it can never fail a card before the run
  stops.
- **Session:** Skip approval, Quiet output, Allow dirty tree, Sandbox, each tagged `session`. These
  last until dulger exits and are never written to the repository.
- **Interface:** Full screen, Icons, Mouse. Icons and Mouse apply at once; Icons is tagged `env` when
  `DULGER_ICONS` overrides it. Full screen decides what `dulger` opens from the next start: the app,
  or with it off the line prompt (and a plain table during runs).

Choice values are spelled as the configuration file spells them (`off`, `auto`, `nerd`). Help
explains the selected setting. Harness is what the configuration file and the flags call the
backend: `"harness"` and `--harness`.

↑/↓ and Tab move between fields; ←/→ change a choice, step a number or flip a switch; Enter opens a
choice's list or starts typing a number, and the first key you type replaces the value; Delete turns
a budget off. A digit typed on a number field that is not being edited switches tabs, as anywhere
else. A change applies to the session at once; `✎` after a value marks one that differs from the
saved settings, and the box's badge counts them (`✎2`).

- **`s`** (or Ctrl-S here, Ctrl-S on Models and Providers, or the palette) saves the session's changes.
  Its dialog shows the files and each change it will write (`Parallel cards  4 → 5`), asks, then writes
  those changes into `.dulger/config.json` and keeps everything else in the file. The backend, roles,
  routing and providers go to [your own config file](#configuration) instead, with any provider they
  use that only this repository defines, and apply in every project. Values the form has no field for
  (a worktree setup command, checker commands) are listed too, by their name in the configuration
  file, and a shell command is shown whole. A role is written only when it differs from the saved one.
  Session settings and API keys are never written, and a provider URL with credentials, a query or a
  fragment is refused.
- **Commit settings…** is offered after a save that leaves the file uncommitted, in a dialog titled
  **Saved · not committed**; when git already tracks the file it adds `! blocks the next run`, since a
  run does not start while a tracked file has uncommitted changes (a file that is new to git does not
  stop a run). It commits `.dulger/config.json` alone, with the message `dulger: save settings`, after a
  confirmation whose rows are the branch, the message, the file and how many other changed files are
  left out; **Not now** is the default, anything else you have staged stays staged and out of the
  commit, and if git refuses (a hook, for example) its whole output is shown. dulger never commits the
  file on its own.
- **`d`** discards the session's changes, putting every setting, model choice and provider back to how
  they were when dulger started, after a confirmation that lists them. Nothing on disk changes.
- **`l`** loads a profile and **`a`** saves the settings as one: see [Profiles](#profiles). **`m`**
  opens Models.

Quitting with unsaved changes does not ask. When the app closes, one line on the terminal names what
you changed in it and did not save (values that came only from command-line flags do not count).

### Models

Models has a **Roles** box with the five roles (planner, worker, reviewer, docs and the progress
reporter): each role's glyph, name and backend, its model when it is pinned, `✎` when this session
changed it, and a state only when something is wrong (`! model` for an API provider without a model,
`! key` for a missing key, `off`, or `skipped` for a reporter its backend cannot run). Beside it is the
**Whole team** box. A box of facts for the selected role (its tiers, where the choice comes from)
appears when there is something to show; PgUp/PgDn and the wheel scroll it. `f` goes to the fix of a
role that cannot run: for a missing key, straight to **Set key…** on Providers.

- Enter or `e` edits a role: its backend, then its model. The models offered are the configured ones
  and, for an API provider with a key, the ones its endpoint lists; **Enter a model ID…** takes any
  other. When the endpoint cannot be listed, the picker names the condition (`host: connection
  refused`, an unknown host, a timeout, a rejected key, a missing endpoint, rate limiting, a server
  error).
- `a` makes the role automatic on its backend; `r` resets it to its saved setting.
- **Whole team** (Tab moves there): **Model set…** (`s`: automatic tiers, balanced, or the low or high
  tier for every role), **One model…** (`o`, one model pinned for every role), **Global pin…** (`p`),
  **Backend…** (`b`, every role on one backend with automatic tiers) and **Routing**, which opens the
  setting. On a backend without tier models the sets that pin a tier are disabled, and a set that
  would turn routing off asks first.

A choice made for one role wins over the global pin, which wins over the saved settings. The
changes last for the session; Ctrl-S saves them to your own config file, for every project.
[Model routing](#model-routing) explains the tiers.

### Providers

Providers lists the configured API providers, one row each: name, base URL, default model (`—` when
none) and a key mark (`✓` set, `!` missing, blank when none is needed). Below them are `+` rows for
well-known providers not set up yet (OpenRouter, Groq, Together, Mistral, Fireworks) and **+ another…**
for any OpenAI-compatible endpoint. The box under the list shows the selected provider's facts (base
URL, default model, key variable, key, which roles use it, where it is defined) and its actions:
**Edit…**, **Set key…**, **Model…**, **All roles…** and **One role…**, or **Add…** for one not set up.
The key itself is never shown.

Enter on a provider opens its form: name, base URL (the part before `/chat/completions`), key variable,
key and default model. A known name fills in its URL and key variable. The key variable must be an
environment variable name: letters, digits and `_`, not starting with a digit. **Set key…** asks for
the key without showing it and stores it in `~/.config/dulger/keys.json` (mode 600) as soon as you
press Enter, never in the repository; an exported variable of the same name still wins, and a key
stored this way stays stored even if you then leave the form without adding the provider (the form
says so). **List models…**, or Enter on an empty Default model, asks the endpoint for its list; without
a key or an answer you type the model ID. A base URL with credentials, a query or a fragment is
refused, and credentials in a URL that is already configured are masked wherever the app or
`/provider` shows it. **Add provider** or **Save changes** (Ctrl-O in the form) defines it for the
session; Ctrl-S in the form only says that Ctrl-O adds it and Ctrl-S on Providers saves it. Esc
reverts the field being typed, then leaves the form, asking first when something changed. A letter
typed on a row that takes no typing (a button, the key's status) does nothing; `q` does not
quit from the form (Ctrl-D does).

If your keys file is not valid JSON, dulger never overwrites it: storing a key is refused with the
file named, and the provider's key reads as unreadable until you fix or remove the file.

On the list, `s` sets or replaces the selected provider's key, `m` picks its default model, `u` runs
every role on it, `o` runs one role on it, `e` edits it and `a` adds another. Ctrl-S on the list saves
the provider definitions with the other session changes, into your own config file: the endpoint and
the key variable's name, never the key. A provider and the key you stored for it then work in every
project. [Direct API backends](#direct-api-backends) covers what a provider needs.

### Doctor

Doctor is the list of readiness checks a run makes before it starts: the Git repository and identity,
uncommitted changes, the worktree directory and worktree setup command, each backend's command-line
tool, keys, role models and budgets, the settings file and the sandbox. Each row is a glyph (`✗` must
be fixed, `!` needs a look, `✓` passes), the check's name and a short value (`main`, `off`, `not
found`, `no key`, `dirty`); the box's badge counts each kind (`✗1 !2 ✓4`) and its border says when the
checks ran. Help starts with the selected check's full detail. Enter on a check that another page
fixes goes there. Doctor agrees with Home: uncommitted changes the session does not allow are an
error. The checks run when you open the tab, again when the settings changed or a minute has passed,
and on `r`.

`/doctor` at the line prompt and `dulger doctor` print the same checks. Blocking checks also run before
agent calls. These checks do not make paid requests or verify account/model access; provider
authentication and model availability are established by the first real call. A failing worktree
setup stops that card before its agents run and can be retried with resume.

### The line prompt

With `--quiet` or the full-screen view off, `dulger` opens a line-by-line prompt instead of the app,
and **Open the line prompt** in the palette opens it inside the app with the same session; `/quit` or
Ctrl-D there goes back to the app. It starts with one line of the current settings and no menus. Type
a goal to run it, or a slash command; `/help` lists them and [Commands](#commands) has the summary.
Settings changed here are session-only until `/config save`.

`/setup` opens a keyboard menu for the session. The current settings are already selected; press Enter
on **Start session** to keep them, or change the Backend for all roles (which resets role overrides
to its automatic tiers), the Model set (automatic routing, a balanced set, or the configured low or
high tier for every role), one model for all roles, or a separate backend and model for each role.
It also loads and saves profiles, sets parallel cards and budgets, and checks readiness. Model lists
include configured IDs and, for API providers with credentials available, the endpoint's models; you
can always enter a custom model ID. Arrow keys select, Enter accepts and typing filters a list; Escape
clears the filter or goes back, and Ctrl-C cancels setup and keeps the previous settings. An automatic
worker follows the planner's task difficulty and escalates on retries; a pinned worker model overrides
both. API providers without a model must have one chosen before starting.

## Profiles, recovery and run controls

### Profiles

A profile is a named set of settings and model choices, kept for this repository in
`.dulger/profiles.json`. On Settings, `a` (**Save as profile** in the palette) asks for a name (up to 60
letters, numbers, spaces, dots, underscores and hyphens) and writes the profile at once; a name that
is already taken asks before replacing it. `l` (**Load profile**) lists the profiles with their
backend, parallel cards and budgets, and replaces the session's settings and model choices with the
chosen one's; the sandbox and the session settings stay as they are, and nothing is written to the
repository. The `/setup` menu at the line prompt loads and saves profiles too. API key values and
environment values are never copied into a profile. A `profiles.json` that is not valid JSON, or not
in a format dulger knows, is reported as such and left alone. Dollar limits cannot account for
harnesses that report tokens without prices.

### Runs

The Runs list has every run, most recently started first, each row a state glyph, the goal, cards
done, spend and age: `▶` ready to resume, `◌` interrupted (also a paused run whose dulger process has
gone), `●` running, `✗` needs attention, `‖` paused, `⊘` stopped, `✦` not planned, `✓` finished. `/`
filters by goal, status or run id: every word you type must appear, and an exact goal comes first.
The tab's badge counts the unfinished runs (`▶2`).

The selected run's box is titled with its run id and shows its whole goal and label/value rows:
Status, Stopped (why, when the run stopped itself), Branch (`· gone`, `· merged → main` or `· no
changes` when that applies), Base, Spend, Started, Cards (`2/3 done · 1 failed · 1 replaced`; cards a
replan replaced are counted apart), Verified (`3 passed`, `1/1 failed · <command>`, `stale`, `none`,
`cards only`, `not yet`), Docs, `Settings differ: …` when this session's settings differ from the
ones the run was saved with, and Worktrees when cards that did not land keep theirs. The **Cards** box
under it lists each card's glyph, id, title, `×N` when it took more than one review round, and spend.

The actions are keys; the footer shows the ones that apply, and help lists all of them with what they
do or why they are off:

| Key | Action |
| --- | --- |
| `v`, or Enter in the list | Review the result: report, changed files, verification, merge |
| `r` | Resume the run, or plan it again when it has no plan yet; asks first (see [Resume and retry](#resume-and-retry)) |
| `t` | Retry a failed card: pick one (**Retry card**), it gets another review round, then the run goes on |
| `e` | Edit the plan, while no card has started |
| `m` | Merge the result into the checked-out branch, after a confirmation |
| `p` | The full report |
| `c` | Clean leftovers: leftover worktrees and `dulger-wip/` branches, after a confirmation |

Tab moves to the run's cards, where Enter opens a card whole: description, criteria, tasks, verify
commands and their results, review feedback. A run that another dulger process is working on shows
its process id in Status, is refreshed every second while it is listed, and no action that would
change it runs. A board that cannot be read is listed with its error and its path; the other runs are
not affected. A board whose `runId` does not match its folder, or whose branch or base names could be
read as git options, is refused with a message saying how to repair it, and dulger deletes or merges a
branch only when it is exactly `dulger/<runId>`.

**Clean leftovers** first lists what it will remove, as rows: Worktrees, Branches, Folders (dulger's
worktree and sandbox folders), Retry worktrees (the ones failed cards keep for a retry, which then
starts over) and Left alone (runs another dulger process is using, which are not touched). It says
that the folders are shared by every local clone of the repository and that uncommitted work in a
worktree is lost. The notice afterwards counts what went (`3 leftovers removed`). `dulger clean` does
the same and says which runs it skipped.

"The latest run", which `dulger resume`, `board`, `report` and `merge` use without a run id, is the
most recently started one, as on Runs; `dulger runs` lists by start time. At the line prompt,
**`/runs`** opens a searchable run browser with report, diff, resume, retry and plan-edit actions while
the full-screen view is on; otherwise it prints the list, as `dulger runs` does.

### Review and merge

The review opens after a run that landed cards, and with `v` on Runs. It stays open until you go back
with Esc; the result stays on its branch. Its four sections are `s`, `f`, `v` and `m`, named in a bar
at the top with their state (the number of files, the verification, `ready`, `blocked` or `Merged`):

- **Summary:** the full report.
- **Files:** the changed files with their added and removed lines, and the selected file's diff beside
  them, coloured. ↑/↓ choose a file, PgUp/PgDn scroll its diff, Tab moves between the list and the
  diff, `w` wraps long lines, Enter shows the diff full screen and `/` filters the files. A file name
  too long for the list keeps its end; the diff's title has the whole path.
- **Verification:** the final verification and each card's verify commands, with exit code and
  duration, and the output of every failure. Its badge says `passed`, `failed`, `stale`, `none`, or,
  when only the cards had verify commands, `cards passed`, `card failed` or `cards only`.
- **Merge:** rows From (the run branch and its diff stat), Into (the branch checked out in your
  repository), State (`ready`, or each thing that blocks the merge) and Not landed (cards that did not
  land), then a Merge button. Enter, or `m` again, opens the **Merge** confirmation (`dulger/<runId> →
  main` and the changes); the run branch is kept, and the section then reads Merged. A failed merge is
  shown here in full. A merge dulger started that stopped on conflicts lists the files: resolve them in
  your editor and commit, or `a` aborts that merge and puts your branch back as it was (the
  confirmation says what is lost, staged resolutions included). A merge you started yourself is named
  as yours, blocks merging until you finish or abort it, and is never aborted from the app.

`r` and `t` resume and retry from here as on Runs. **`/review [runId]`** at the line prompt opens the
review as a menu (verification and the full report, the changed files with their diffs, merge with a
confirmation), and a run started there offers it when it lands work.

### Editing a plan

A plan can be edited until its first card starts: with `e` on Runs or **Edit plan** at the plan
review, which open the plan editor, or with **`/edit [runId]`** at the line prompt (and `/edit` at the
plan prompt outside the full-screen view), which use a menu: choose a card, then the value to change;
**Save plan edits** validates and applies them all, Escape discards them.

The plan editor shows the goal, the cards on the left and the selected card's values on the right:
title, description, each acceptance criterion, a checkbox for every card it can wait for, each verify
command shown whole, exactly as the run view shows it (control and invisible characters spelled out),
the worker's backend and model, and each task's title and instructions. Enter edits the selected value
in a dialog; `a` adds a criterion or command, `d` removes one (or a dependency, or the worker pin),
`K` and `J` move one, Space checks a dependency and ←/→ change the worker's backend. A card that would
make the plan wait for itself is shown dimmed with `⊘` and cannot be checked; trying says why. `u` or
Ctrl-Z undoes the last edit. Ctrl-S validates the whole plan, dependency graph included, saves it and
records an event; Esc with unsaved edits asks before discarding them. A status line appears only when
there is something to say: `! Not saved`, what keeps the plan from being saved, or which cards have
unsaved edits (`✎ c1, c2 unsaved`). Commands are edited one at a time, so pipes keep their shell
meaning, and a command confirmed unchanged stays as it was. A command containing a tab or a control or
format character cannot be edited in place, since a text box could silently change what runs: it is
shown as it will run, and you can remove it or type a replacement. Letters that are no key here, `q`
included, do nothing; only Alt-1 to Alt-9 or a click on a tab leaves the editor for another tab.

Opened from Runs, the editor holds the run while it is on screen, so no other dulger process can start
or edit it meanwhile; a plan that changed elsewhere while it was in the background is reloaded, or,
with edits pending, you choose. Opened from the plan review, it edits the plan of the run that is
waiting and goes back to the review when it closes.

### Resume and retry

- **Resume** keeps the run's saved execution settings unless you choose otherwise. In the app (`r` on
  Home, Runs or the review) it asks first, in the **Resume <runId>** dialog: the goal, then rows Done
  (`0/3`), To build (with how many were interrupted) and Failed (which stay failed). When this
  session's settings differ from the ones the run started with, a `Settings  run → session` row lists
  each difference by its Settings name (`Parallel cards  3 → 5`), and the buttons are **Keep original**,
  **Use session** and, when more differs than the rows show, **Details**; Use session saves those
  settings with the run.
  At the line prompt `/resume [runId]` asks which to use when they differ and can show the differences
  first; `/resume [runId] current` and `--current-settings` on the command line use the current
  settings without asking, and `dulger resume` without it keeps the saved ones. Old runs without saved
  settings use current settings.
- **Retry** gives a failed card one more review round, starting from its last rejection; the cards
  blocked behind it get another chance and the rest of the run continues. A retry from the app keeps
  the settings the run started with, and the **Retry card** picker names them when this session's
  differ.

### Controls while cards run

While cards run in the [live run view](#the-screen):

- **`p`** pauses and resumes dispatch. Active cards finish while paused, and the header says paused.
- **`x`** stops the selected card. The dialog (**Stop c1**, the card's title, `Type stop`, Keep / Stop)
  needs the word `stop`; the card's worktree is kept and a retry continues it. A card that has not
  started yet shows `· not started`: it is marked stopped and does not start in this run, nor do the
  cards waiting for it, which the dialog names (`c3 will not start either`). The dialog closes by
  itself if the card starts or finishes meanwhile. Nothing is replanned.
- **`i`** adds instructions for the card's next worker attempt, in a multi-line dialog (**Instruct c1**,
  placeholder `next attempt`; Alt-Enter adds a line). A call already running keeps the instructions it
  has. Instructions appear in the card, and the notice `Saved for c1` comes only when they were saved.

These keys act on the selected card, or with the agents pane focused on the selected agent's card.
They are not shortcuts while a dialog or a prompt has the keyboard.

### Final verification and run locks

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
   dependencies. It lists its assumptions and anything it left out of the goal. You read the plan and
   press Enter to dispatch it, or type what to change and the planner revises it; Plan on
   Home (`dulger order`, `/order`) talks it through first. Off a terminal (a pipe, CI) nothing is
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
   first, listing each such command whole, and only a typed `yes` (or `--yes`) applies the replan;
   otherwise it is dropped and the board stays as it was.
6. **Docs.** A documentation agent updates README / CHANGELOG for what landed.
7. **Final verification.** Rerun the landed cards' commands after documentation on the exact result
   revision. Failed or stale checks block dulger's merge actions.
8. **Report.** What landed, what did not, what was verified, files, reviewer notes, spend, next step.

Your checkout is untouched. The result is on `dulger/<runId>`; `git merge` it when you are happy.

## The screen

On a terminal a run takes the whole screen. The header shows the run, its goal (which keeps its room
before the rest), the cards done as a bar with the failed ones counted beside it, the time since the
run started, the spend (`$0.03 · 3k tok`) and, when the backend reports them, the account's plan
windows; a paused run is marked paused. Below come the cards as columns, the agents with what each one
is doing, and the log. A card box shows its state in a word or two (`round 2`, `3 rounds`, `stopped`,
`replaced`). An in-progress card shows the progress reporter's latest note under its title (with a
warning marker when the reporter flagged something); a fresh note always beats the raw agent line,
and both are in the card when you open it. Notices appear at the top right (`Stopping c1`, `c1
done`).

The footer shows the run's phase and the keys for what is focused: `⏎ open  x stop  i instruct  p
pause` on the board, `esc close  x stop  i instruct` on an open card, `⏎ card` on the agents, `↑↓
scroll` on the log, then `? help`. Help (`?` or F1) lists every key that works at that moment and
explains stop, pause and instructions.

| Key | What it does |
| --- | --- |
| Arrow keys or `h` `j` `k` `l` | Select a card |
| Enter | Open the selected card: description, acceptance criteria, tasks, verify commands, review remarks, your instructions, the agent's last actions. Enter or Esc closes it |
| Tab, Shift-Tab | Move between the board, the agents and the log |
| `z` | Zoom the focused pane to the full height: every agent with the selected one's recent history, or every log line wrapped whole. `z` or Esc goes back |
| PgUp/PgDn, Home/End | Scroll the log |
| `p`, `x`, `i` | Pause, stop a card, add instructions: see [Controls while cards run](#controls-while-cards-run) |
| `?` or F1 | Help: the keys that work right now |
| Ctrl-C | Stop the agents and save the board |

With the agents pane focused, ↑/↓ select an agent and Enter opens its card; closing that card goes
back to the agents pane. The log follows the newest lines until you scroll up; then new lines wait
below (`▼N` counts them) and End follows again. With the mouse on, the wheel scrolls the pane under the
pointer, a click selects a card and a second click opens it.

**The plan review.** After planning, the board makes way for the plan as one document, its badge
counting cards, tasks and verify commands: what the planner assumed and what it left out of the goal
(**Left out**), dulger's warnings about the plan (`c1: 5 tasks, 4 waiting`: a card too big for one
reviewer, or one too many others wait for), then every card with its acceptance criteria (`done
when`), tasks, dependencies and verify commands, shown whole at any width, with control and invisible
characters spelled out; a card without verify commands shows `verify —`. Below it are five actions,
and ←/→ choose one; the footer's Enter word follows the chosen action (`⏎ dispatch  ←→ action  ^c
backlog`):

- **Dispatch** (Enter, the default) starts the workers on these cards.
- **Revise** opens the reply line (placeholder `ask for changes`); typing anything does the same.
  Enter sends the reply and the planner revises the plan in the same session; ↑/↓ recall earlier
  replies, Tab completes `go`, `cancel` and `/edit`, and Esc goes back to the plan with the text kept.
  While the planner revises, the phase reads `revising`.
- **Edit plan** opens the [plan editor](#editing-a-plan) to change cards, tasks and verify commands
  yourself, then comes back to the review.
- **Cancel run**, or a typed `cancel`, asks first (**Delete run <runId>**: the plan and the branch, Keep
  / Delete), then deletes the run, its plan and its branch.
- **Keep in backlog**, or Ctrl-C, keeps the plan; `dulger resume` dispatches it later.

A reply you typed and did not send is never taken as a go: while one is waiting, Enter or a click on
Dispatch goes back to the reply (the footer then reads `⏎ reply`). Esc on the plan keeps the action you
chose. For 300 ms after the review appears, after each revision and after the terminal is resized,
Enter and clicks on the actions are ignored, so a key pressed before you could read the plan does not
dispatch it. After a revision the plan starts with your reply (`› fewer cards`), then what the planner
did (`removed c3`, or `✗ not revised` when the revision failed), and each card that is new or changed is
marked `new` or `changed`. Help explains the actions, `verify` and these marks.

**Dialogs during a run.** A replan that brings new verify commands opens **New verify commands**: each
command whole with the cards it is for, a field that wants `type yes`, and Drop / Run. Only the typed
word runs them; anything else, Esc or Ctrl-C drops the replan while running cards carry on. It ignores
keys and clicks for its first 300 ms, and if another dialog is open when it arrives it waits for that
one to close (notice `Approval waiting`). Stopping a card takes the typed word `stop`. Inside a dialog
Esc and Ctrl-C cancel the dialog; outside one, Ctrl-C stops the run, or at the plan review keeps the
plan in the backlog. Ctrl-C while the planner is still planning or revising stops cleanly: the run
waits, and `dulger run` prints `interrupted while planning; dulger resume <runId> plans it again` and
exits with status 130. If a run cannot be set up after the view opened, the view closes and the error
is shown.

Started from the app, the run view draws on the app's screen and nothing is printed underneath; when
the run ends the app comes back with the review or the run on Runs. (With Quiet output on or the
full-screen view off, the app steps aside for the run's log lines and returns when it ends.) Started
with `dulger run` or from the line prompt, the screen goes away when the run ends and the report
prints where you can scroll back to it. Times in the log, as everywhere in dulger, are local. The line
prompt predicts commands and their arguments as you type: see
[Command prediction](#command-prediction).

Icons come from a Nerd Font when the terminal is ghostty, kitty, WezTerm, Alacritty or foot, and are
plain Unicode elsewhere; `"tui": { "icons": "nerd" }` in the config or `DULGER_ICONS=nerd` forces it,
`ascii` works on anything. With `NO_COLOR` set the full-screen views draw no colour: the selected row
keeps its pointer, the focused box and pane put the pointer before their title, the active tab,
buttons and labels are bracketed, a typed field is drawn in brackets and placeholders in parentheses. Narrow or short terminals use a compact card list; the layout reserves
space for input and hides secondary sections as space runs out. `--quiet` or a pipe uses log lines;
`"tui": { "enabled": false }` uses the legacy table, and `dulger` then opens the line prompt instead
of the app.

The plain output (log lines, the table, the printed board and report) cleans every text that came
from the board or an agent of terminal control sequences, spells verify commands out the same way as
the full-screen view, and carries no escape sequences at all when it goes to a pipe. Its plan prompt
works as the plan review does: Enter or `go` dispatches, a reply revises (then `You asked: …` and
`Result: …` say what the planner did), and `cancel`, `abort`, `drop` or `discard` ask before deleting
the run: type `yes` to delete it; Enter or anything else keeps it. In the report, a card that did not
land says why: stopped by you, its verify commands failed and it never reached review, failed before
its review, not started, or interrupted while in progress or in review.

## Commands

```
dulger                        the app (Home, Runs, Settings, Models, Providers, Memory, Doctor);
                              the line prompt with --quiet or the full-screen view off
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

At the [line prompt](#the-line-prompt) a typed goal runs, and slash commands do the rest: `/order`,
`/board`, `/report`, `/runs`, `/review`, `/edit`, `/resume`, `/retry`, `/merge`, `/memory`, `/clean`,
`/doctor`, `/setup`, `/status`, `/model`, `/provider` and `/config save`, a command per setting
(`/harness`, `/concurrency`, `/attempts`, `/replans`, `/docs`, `/progress`, `/yes`, `/quiet`, `/dirty`,
`/routing`, `/router`, `/tui`, `/icons`, `/mouse`, `/budget`, `/card-budget`, `/sandbox`, or `/set <key> <value>`
for any of them), `/help` and `/quit`. `/help` says what each one takes.

## Command prediction

The line prompt knows what each command takes, so a half-typed line is completed from it:

- The rest of the word is shown dim after the cursor, and **Tab** takes it.
- When several words fit they are listed under the line, each with what it does. More than a handful
  match? Then the count is shown instead: keep typing to narrow them.
- Arguments are completed wherever they are known, and from the repository where they live: run ids for
  `/board`, `/report`, `/resume`, `/merge` and `/retry`; the latest run's failed cards for `/retry`;
  roles, aliases, backends and harnesses for `/model`; configured providers for `/provider`; what agents
  learned for `/memory rm`; each setting's own values for `/set` and for the setting commands; `save`
  for `/config`.
- The plan prompt outside the full-screen view completes `go`, `cancel` and `/edit`, and so does the
  full-screen plan review's reply line once something is typed (Tab takes the word there too).

Prediction is only ever drawn, never typed. A goal line (anything that does not start with `/`), a
cursor in the middle of the line, a line past its last argument, and a terminal too narrow for the list
are all left alone.

## Configuration

`<repo>/.dulger/config.json`, all optional; flags override it. `harness`, `roles`, `routing` and
`providers` are yours: Save and `/config save` write them to your own `~/.config/dulger/config.json`
(`$XDG_CONFIG_HOME`), never into a repository, and there they win over a repository's file in every
project. A profile, flags and the session override both.

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
  "tui": { "enabled": true, "icons": "auto", "mouse": true }   // the app and the run view; icons nerd | unicode | ascii | auto
}
```

With `tui.enabled` off, `dulger` opens the line prompt and runs print a plain table. With `tui.mouse`
off, the full-screen views leave the mouse to the terminal, so text can be selected as usual; it is on
by default. The Interface settings in the app (Full screen, Icons, Mouse) change these for a
session and save them like any other setting.

The [sandbox](#sandbox) is not configured here: a repository does not get to set its own confinement.

## Model routing

Automatic routing is on by default. Each task is tagged `low`, `medium` or `high` complexity, by the
router, and its tier picks the model.

| Tier | Claude Code | Codex |
| --- | --- | --- |
| Low: mechanical edits, simple docs | `haiku` | `gpt-6-luna` |
| Medium: routine features, fixes, tests | `sonnet` | `gpt-6.1-sol` |
| High: architecture, security, difficult debugging | `fable` | `gpt-6-astra` |

Planning and review always use high: what the reviewer misses lands unseen. Documentation and the
progress reporter use low. The reporter works from a digest of the worker's live activity, never
touches the worktree, and its cost lands on the run, not the card.
Tool-free reporting is supported by Claude Code and API providers. Codex CLI cannot disable every
built-in tool, so a Codex reporter is skipped with a log message; set `roles.reporter.harness` to
`claude` or a configured API provider to use progress notes with Codex workers.
Unlabelled tasks on older boards use medium. A failed worker attempt retries one tier up; continuations
keep the same model and session. Fix tasks and merge-conflict resolution run one tier up. Selected models
appear in the log and live agent list. The Claude tiers are Claude Code's
[model aliases](https://code.claude.com/docs/en/model-config), so each follows the newest model of its
family that your Claude Code serves; put a full model ID in the map to hold a tier on one version.
Codex has no aliases, so its tiers are model IDs.
You can use `opus` as the high tier by changing the map. Availability depends on your account and installed CLI.

`routing.router` says who tags the tasks:

| Router | Tags with | Needs |
| --- | --- | --- |
| `planner` (default) | the planner's own tags | nothing |
| `jev-openrouter` | Jev, TypeSafe's calibrated scoring model, on OpenRouter (`typesafe/jev-1.14`) | `OPENROUTER_API_KEY` |
| `jev-typesafe` | Jev on TypeSafe's API (`jev-latest`) | `TYPESAFE_API_KEY` |
| `jev-local` | clef-flash on a local llama-server, `http://127.0.0.1:8080` | the server running |

With Jev the planner still tags each task, then Jev scores it and its tier replaces the tag. On any Jev
failure (no key, no answer, an HTTP error, a missing score) the run keeps the planner's tags and logs a
warning. The first interactive `dulger`, `dulger run` or `dulger order` asks which router to use and
saves the answer in your own config file; dismissed, it is asked again on the next start, and without
a terminal (CI) nothing is asked and the planner tags. Router in Settings, `/router` or
`/set router` changes it later. `routing.jev` changes the endpoint's `baseUrl`, `apiKeyEnv` or
`model`, e.g. for a local server on another port:

```json
{ "routing": { "router": "jev-local", "jev": { "baseUrl": "http://127.0.0.1:1235" } } }
```

`--model` pins all roles and overrides routing; `roles.<role>.model` pins just that role.
Use `--no-routing`, Routing in Settings, `/routing off`, or `"routing": { "enabled": false }` to
use harness defaults. The global pin on Models, or `/model off`, clears the session-wide pin.
Configure tier IDs in `.dulger/config.json` or, for every project, your own config file:

```json
{
  "routing": {
    "models": {
      "claude": { "low": "haiku", "medium": "sonnet", "high": "fable" },
      "codex": { "low": "gpt-6-luna", "medium": "gpt-6.1-sol", "high": "gpt-6-astra" },
      "ollama": { "low": "your-small-model", "medium": "your-coder-model", "high": "your-large-model" }
    }
  }
}
```

## Choose models in the REPL

In the app, the [Models](#models) tab does this with pickers: choose a role, then its backend and
model, or apply a model set to every role. At the line prompt, `/model` configures a mixed-model run
without editing JSON:

```text
/model planner fable
/model worker deepseek
/model checker sonnet
/model docs haiku
/model reporter haiku
/model
```

Use `astra` instead of `fable` for Codex planning. Shorthand names are `fable`, `opus`, `sonnet` and
`haiku` (Claude Code's aliases), and `astra`, `sol` and `luna` (the Codex tiers; their full model IDs
also work). A backend name alone,
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
- `/model worker reset` restores the role's saved harness/model (or the saved defaults),
  bypassing the session's global model pin for that role. Other shared settings still apply.
- `/model <name>` sets a global fallback pin; explicit session role choices and resets take precedence,
  regardless of command order. `/model off` clears that global pin and keeps the role choices.
  The overview always shows which setting applies. `/set model ...` accepts the same arguments.
- `/progress` shows the progress reporter's interval; `/progress on|off|<sec>` changes it
  (`--no-progress` and `--progress-interval <sec>` do the same on the command line). It is on with
  a 120-second interval by default, and `roles.reporter` picks its backend and model like any role.
- Changes remain session-only until `/config save` (Save settings in the app). Saving writes
  explicit configuration changes to `.dulger/config.json` and the effective model mix (backend, roles,
  routing, providers) to your own config file, for every project, and preserves unrelated settings.
  `yes`, `quiet`, `dirty` and `sandbox` remain session-only. API keys stay in environment variables
  or your own keys file; saving provider settings persists only the configured environment-variable
  name, not its value.

The repository's file is committable, like a hand-written configuration. API endpoint settings passed
through `--base-url` and `--api-key-env` can also be saved this way.

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

In the app, the [Providers](#providers) tab adds and edits providers with a form: base URL, key
variable, the key (masked) and a default model picked from what the endpoint lists. A run that would
use a provider without a key does not start: the app names the provider and offers to open Providers.

In the line prompt, `/provider deepseek` (or any name) asks for the base URL, then for the key when it
is not already available, typed without echo and stored in `~/.config/dulger/keys.json` (mode 600,
never in a repository; an exported variable always wins), then lists the models the endpoint reports
so you pick one by number or by typing part of its name. `/provider` lists every provider and where
its key comes from; `/provider <name> key` replaces a key, `/provider <name> model` re-picks the model.
`/config save` then writes the endpoint and the variable name to your own config file, so the provider
and its key work in every project. Selecting a provider whose key is missing, in the line prompt or at
the start of a run there, asks for the key on the spot.

Persist endpoint settings in `.dulger/config.json` or your own config file. Store the **environment
variable name**, never the key itself: the repository's file is committable. A base URL that contains
credentials, a query or a fragment is refused, in the app, at `/provider`, on save and from
`--base-url`: the key goes in its variable.
Credentials already in a configured URL are masked wherever the app or `/provider` shows it, and
`/provider` does not offer such a URL as its default.
`/harness ollama`, `/harness deepseek` and `/harness openai` also work in the line prompt, as Backend
does in Settings. The base URL is the prefix before `/chat/completions`.

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
  gives each agent the ones relevant to its card.
- **The Memory tab** lists those notes in one box, the most recently seen first (`s` sorts the other
  way): a glyph (`!` for a note compaction would drop), the note and how long ago it was last seen. The
  box's badge counts the notes and their characters (`4 notes · 345 chars`); the tab's badge counts the
  notes compaction would drop (`!1`). The selected note's box has rows Seen, Last, From (run, card and
  backend), Files (a file missing from your checkout is marked `missing`) and Id. `a` adds a note of your
  own, `d` removes the selected one after a confirmation that quotes it, and `c` compacts after showing
  what it would merge and drop: repeated sightings fold into one entry, and notes none of whose files
  are in this checkout go, also when those files exist on a result branch that is not merged yet; notes
  that name no files stay. `/` filters, Enter reads a note whole, and `p` shows the memory file's whole
  path. Help explains the file's location, the prompt limits (`memory.maxItems`, `memory.maxChars`) and
  compaction. `dulger memory` and `/memory` list, add, remove and compact them from the command line.

## Where things live

```
<repo>/.dulger/context/*.md             your notes (committed)
<repo>/.dulger/config.json              configuration (committed)
<repo>/.dulger/profiles.json            named profiles, written only by Save as profile
<repo>/.dulger/runs/<runId>/            board.json, events.jsonl, logs/   (git-ignored)
~/.local/share/dulger/<project>/        memory.jsonl, worktrees/, sandbox/ (per origin URL; $XDG_DATA_HOME or $DULGER_DATA_DIR)
~/.config/dulger/config.json            your backend, roles, routing and providers for every project, and your sandbox policy ($XDG_CONFIG_HOME)
~/.config/dulger/keys.json              API keys you entered (mode 600); an exported variable wins
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
  verify commands, the latter exactly as written; Codex runs theirs in its read-only sandbox. A verify
  or configured command that is blank or contains `*`, `(`, `)`, `\\`, a trailing `\` or a control
  character such as a newline is not offered to a Claude Code reviewer, whose permission rules would
  read it as a different rule. A refused command is logged and noted on the card, so a review that
  had to take something on trust says so. The progress reporter gets the activity digest in its
  prompt and no commands at all; it has nothing to refuse.
- The verify commands come from the planner and run in the card's worktree with your shell's
  privileges, the same access unsandboxed Claude Code workers have there, or confined by the
  [sandbox](#sandbox) when it is on. Read them before dispatching: the plan review shows each one
  whole under its card, as do `dulger board` and the plan prompt outside the full-screen view, and the
  plan editor and `/edit` show them. Dispatching approves them, and so does saving an edited plan; `--yes` approves them unread, and off a terminal nothing is dispatched
  without it. A replan's verify commands that are not already on the board or in
  `checker.allowedCommands` (exact match) need a typed `yes`, or `--yes`, or the replan is dropped.
  They, `worktreeSetup` and the API tools' shell commands get your environment without the credentials
  dulger runs agents with: every provider's `apiKeyEnv`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and `DEEPSEEK_API_KEY`. Your project's
  own variables pass through. Claude Code and Codex, and the commands they run, still get your whole
  environment.
- Agents never run git; dulger commits, merges, cleans up. dulger's commits, merges and branch updates
  in worktrees run no git hooks. Merging the result branch into your branch runs your repository's
  hooks like any merge, including any the run added, so read the diff first.
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
  checkout are read-only, and so is the repository's `.git`, its hooks and config included. Hook
  locations inside the tree (a relative `core.hooksPath`, a hook manager's config) are ordinary files a
  worker may write, except an existing `.claude/`, `.husky/` or `.githooks/`, which are read-only;
  dulger's own git commands in worktrees run no hooks. The runtime itself protects shell rc files,
  `.gitconfig`, `.gitmodules`, `.mcp.json`, `.vscode/`, `.idea/`, `.claude/commands` and
  `.claude/agents`;
- **reads** everything your user can except `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`,
  `~/.config/gcloud`, `~/.config/gh`, `~/.config/dulger`, `~/.netrc`, `~/.npmrc`, `~/.docker`,
  `~/.kube`, `~/.git-credentials`, the agents' own credentials (`~/.claude`, `~/.claude.json`,
  `~/.codex`; hidden from commands, not from Claude Code, which needs them), the other cards'
  worktrees and temp dirs, and what you add with `denyRead`;
- **connects** only to the hosts you grant for its kind. With none, every connection is refused,
  your machine's own localhost and unix sockets (Docker's included) too.

**Claude Code agents.** The worker, the reviewer and the documentation agent run in their worktree;
the reviewer's permission mode still keeps it from editing files, but the tests it re-runs can write
their build output. Those re-runs are in the reviewer's sandbox, with an agent's grants: a host a
verify command needs must be in `domains.agent` too, and a path it writes outside the worktree in
`allowWrite`, for the reviewer's re-run to work. The planner runs in your checkout, which stays
read-only. The progress reporter has no tools and is not wrapped. On top of what a command gets, an
agent

- reaches `api.anthropic.com`, `claude.ai` and `platform.claude.com` (the last two to refresh a
  login), the host of `ANTHROPIC_BASE_URL` when you use a gateway, and the hosts in `domains.agent`;
- reads its own state, `~/.claude/.credentials.json` included: a sandboxed agent can still read the
  login it runs with. That state is read-only except the session's transcript directory,
  `~/.claude/projects/<working directory>/` (under `$CLAUDE_CONFIG_DIR` when that is set), which
  dulger creates before the call so that resuming a session and structured answers work. Claude Code
  logs the other writes it cannot make (`~/.claude.json`, plugin caches, locks) and carries on. The
  planner's directory is the one your own Claude Code sessions in this repository use, so the
  planner can add its own session there but change nothing already there except the session it
  resumes: your sessions' files and `memory/`, Claude Code's auto-memory that later sessions read,
  stay read-only;
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
(`$XDG_CONFIG_HOME/dulger/config.json`), under `sandbox`; besides it, only `harness`, `roles`,
`routing` and `providers` are read from that file ([Configuration](#configuration)). A `sandbox` key
in `<repo>/.dulger/config.json` or in a profile is ignored, and `dulger doctor` and the run say so. A run never saves the sandbox with its settings, so a resume uses this machine's policy as
it is now. `--sandbox off|auto|required`, Sandbox in Settings, `/sandbox` and `/set sandbox` change
the mode for one command or session; neither Save settings nor `/config save` saves it.

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
  one could not clean up, dulger removes untracked empty leftovers before it commits, also when the
  run is resumed without the sandbox. Nothing appears in your checkout, where the planner runs:
  nothing is writable there.
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
