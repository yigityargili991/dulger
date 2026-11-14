# Terminal workflow contract

Source: the approved UX roadmap in this task, README configuration and recovery rules,
and the existing CLI/worktree lifecycle. This is an English developer tool operated
with a keyboard. No new web, locale, payment or identity workflows are introduced.

## Shared ownership

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | `src/tui/select.ts` | DESIGN.md | Filtered keyboard list | `test/select.test.ts` |
| Read-only detail | `src/tui/pager.ts` | This contract | Reports, diffs, checks, settings | `test/runUi.test.ts` |
| Form | `src/sessionSetup.ts`, `src/planEditor.ts` | README.md | Session and plan drafts | `test/sessionSetup.test.ts`, `test/features.test.ts` |
| Run navigation | `src/runViews.ts` | README.md | Browser and result review | `test/features.test.ts`, PTY smoke |
| Feedback | Shared menus, pager and run log | DESIGN.md | Textual errors and recovery | `test/select.test.ts`, `test/runUi.test.ts` |
| Live controls | `src/tui/tui.ts`, `src/runner/dispatch.ts` | README.md | Selected-card controls | `test/runUi.test.ts`, `test/features.test.ts` |
| Persistence | `src/board/store.ts`, `src/runSettings.ts`, `src/board/lock.ts` | README.md | Atomic snapshots and exclusive execution | `test/features.test.ts` |


## Flows

- Setup starts with current settings. Start applies the draft; cancel leaves the
  active session unchanged. Loading a profile changes the draft. Saving a named
  profile is an explicit immediate write; replacing one requires confirmation.
- Profiles are local to the repository in `.dulger/profiles.json`. They include
  supported execution settings but no environment values or API key values.
- Readiness checks run before an agent call and are also available from setup or
  `/doctor`. They do not make paid probes or claim that a present credential is valid.
- The run browser handles empty lists and unreadable runs with a correction message.
  An unfinished-run prompt offers recovery on startup without automatically running it.
- Plan edits apply only to unstarted cards. Save validates the whole dependency graph
  and records an event. Cancelling discards the draft. Shell commands are edited
  individually, so pipes in a command retain their shell meaning.
- Resume keeps original saved settings. Applying current settings is explicit and
  shows differing sections first. The CLI exposes `--current-settings`; old runs
  without a snapshot use the current settings.
- Pause stops new card dispatch while active cards finish. Stop card requires typing
  `stop`, cancels that card, preserves its worktree, and leaves it available for retry.
  It does not trigger a planner replan. Added instructions affect the next worker
  attempt, not a call already in progress.
- A fresh plan is approved at the plan prompt. Off a terminal it is not dispatched without `--yes`:
  the board is printed with its verify commands, the run stays in the backlog with a non-zero exit,
  and resume is the explicit go. `--yes` dispatches unreviewed and logs the verify commands it accepted.
  Resume and retry of a board that has cards dispatch without asking.
- A replan that adds verify commands not already on the board or in `checker.allowedCommands`
  (exact string match) requires typing `yes`, like stop requires `stop`; the prompt recalls no
  history and predicts nothing. Enter, other text, dismissal, the view closing or the run stopping
  refuse it: the replan is dropped and the board is unchanged. Active cards keep running while it is
  open. The person's `--yes` (or `/yes on`) accepts and logs them; without a terminal or `--yes` they
  are refused. The internal skip of the plan pause on resume and retry never accepts them.
- Live control keystrokes do not act as shortcuts while typing into a prompt.
  Ctrl-C within a control prompt cancels the action; outside prompts it stops the run.
- Review remains open until dismissed. Files open in the shared diff pager. Merge
  names the source and destination and requires explicit confirmation; errors return
  to review. Failed or stale final verification blocks merging through dulger.
- Final verification runs the unique commands from landed cards on the final branch,
  including documentation changes. No configured commands is stated explicitly.
- Execution, plan editing, merge and cleanup respect execution locks. Dead local
  owners can be recovered; unverifiable owners fail closed with the lock path.

## Verification

`test/features.test.ts` covers profiles, snapshots, locks, preflight, plan validation,
controls, cancellation, final verification and resume, and plan and replan approval
(`test/orchestrator.test.ts` covers the replan side). `test/runUi.test.ts` and
`test/prompt.test.ts` cover control and confirmation prompts, keyboard isolation, paging
and resize. Existing setup and TUI tests cover cancellation and tiny/large terminal
dimensions. Real PTY smoke checks use only the fake harness in a temporary repository.
