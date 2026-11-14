---
version: alpha
name: Dulger terminal UI
description: A keyboard-operated workbench for choosing agents and following a kanban run.
colors:
  primary: '#cba6f7'
  background: '#1e1e2e'
  surface: '#313244'
  text: '#cdd6f4'
  muted: '#7f849c'
  warning: '#f9e2af'
typography:
  mono:
    fontFamily: 'ui-monospace, monospace'
omitted:
  - section: rounded
    reason: Terminal cells have no pixel corner radii.
  - section: spacing
    reason: Geometry is expressed in terminal rows and columns, not CSS lengths.
  - section: components
    reason: Component styles consume the canonical Chalk theme; ownership and behavior are documented below.
---

# Dulger terminal design

## Overview

Dulger is a developer's terminal workbench: a compact kanban board, agent activity,
and explicit model choices. The setup screen's signature is its roster of roles and
resolved models, so the person can see what will run before entering a goal.
Keep it consistent with the existing run screen, not a web onboarding wizard.
English labels and the user's terminal font are the current product contract;
there is no market-specific visual or language policy.

Runtime tokens remain canonical in `src/tui/theme.ts`. This document records that
existing identity; it does not generate or independently redefine runtime colors.

## Colors

The Catppuccin Mocha palette comes from the shared theme. Primary maps to
`P.mauve` / `c.selected`, background to `P.base`, surface to `P.surface0`, text to
`P.text` / `c.text`, muted to `P.overlay1` / `c.muted`, and warning to
`P.yellow` / `c.warn`. Setup and the board share these tokens.
Selection also uses a `>` marker and bold type; it remains visible without color.
The terminal and Chalk control color capability and background rendering.

## Typography

Use the configured terminal monospace font without changing its size or family.
Titles and the active option are bold; descriptions are secondary. Model IDs
retain their exact casing. Sanitize external control sequences for display and
measure wide characters with the existing terminal text helpers.

## Layout

Use available physical terminal dimensions. The shared picker reserves a header,
a scrollable option list, focused-option detail, and one key-hint row. Narrow or
short terminals reduce decoration before hiding choices. The focused option
stays visible during scrolling and resizing. Below ten rows, omit the detail
panel. Every frame fits its available rows and columns.

## Elevation & Depth

Use the existing tonal header and selection color. There are no shadows,
animation, or overlapping popups. A picker temporarily owns the alternate screen
and restores the terminal on selection, back, or cancellation.

## Shapes

Rows and simple text markers carry hierarchy. Labels never require Nerd Font
glyphs. Keep the setup view usable with plain Unicode arrows and ASCII markers.

## Components

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | `src/tui/select.ts` | This document and `src/tui/theme.ts` | Filterable keyboard menu | `test/select.test.ts`, real PTY checks |
| Form | `src/sessionSetup.ts` | The manual's configuration rules (`docs/manual.md`) and `src/replModels.ts` | Session draft, per-role override | `test/sessionSetup.test.ts` |
| Terminal lifecycle | `src/tui/screen.ts` | Existing run screen | Alternate screen, raw keys, resize | `test/tui.test.ts` |

Arrow keys and Tab move selection; Enter chooses; Home/End and Page Up/Down
navigate long lists. Typing filters locally; Backspace edits and Ctrl-U clears.
Escape clears a filter first, then goes back. Ctrl-C/Ctrl-D cancel the entire
setup. Menus restore focus to the edited setting when returning to the overview.
No matching options is an explicit state and cannot be submitted.

The session is a draft until Start session. Cancelling leaves the prior session
unchanged. Start does not launch agents or save files. `/config save` remains the
explicit persistence action. Nested cancellation retains the outer draft.
Changing the global harness resets role overrides to its automatic tiers; the
menu states this before selection. Pins override planner difficulty and retry
escalation. Missing provider models block Start with a correction hint.

Endpoint model discovery has a bounded request timeout, visible loading text,
and a manual-ID fallback for missing keys or unavailable endpoints. Keys use the
existing provider flow; setup never displays, requests, or stores secrets.
No automatic motion is introduced.

## Do's and Don'ts

- Show resolved per-role choices before the session starts.
- Use shared terminal rendering, theme, and model-resolution code.
- Preserve repository and CLI settings when Start is accepted without edits.
- Do not silently write config, launch agents, or change backends on cancellation.
- Do not claim pinned workers still follow planner difficulty.
- Keep noninteractive commands and existing command-line overrides usable.

## Run management surfaces

The setup roster, run browser and plan editor reuse the filterable listbox. Reports,
readiness checks, setting differences and file diffs share `src/tui/pager.ts`; its
header and footer stay within the terminal while content scrolls. Run detail keeps
status, goal and spend visible before presenting recovery or merge actions.
`UX-CONTRACT.md` records navigation, draft, confirmation and recovery semantics.
Live controls use the existing prompt editor and status bar, with textual hints;
no additional palette, fonts, modal system or animation is introduced.

## Documentation website

The public documentation is a separate content surface, preserving the original site's 46rem
reading column, wrapping text navigation, system sans-serif prose and monospace examples.
`docs/style.css` owns the existing light/dark web palette and shared page styling; terminal tokens
do not apply to the website. `docs/build.mjs` owns the common navigation, version label and footer.
Content comes from `docs/manual.md` and CHANGELOG, with existing routes retained. Use semantic headings,
a skip link, visible focus, browser-native links and locally scrolling code/tables on small screens.
There is no client-side state, animation, font download or theme flash.
