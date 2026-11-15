// Colours and glyphs for the full-screen view. The palette is Catppuccin Mocha; chalk downsamples it
// for terminals without truecolor. Glyphs come in three sets so the view reads on any font.
import chalk, { type ChalkInstance } from 'chalk';
import type { AgentRole, CardStatus } from '../types.ts';

export type IconSet = 'nerd' | 'unicode' | 'ascii';

// chalk only listens to FORCE_COLOR; NO_COLOR (https://no-color.org) turns the screens colourless too,
// as it does the plain output (src/ui/ansi.ts). An explicit FORCE_COLOR still wins.
if (process.env.NO_COLOR && process.env.FORCE_COLOR === undefined) chalk.level = 0;

export const P = {
  base: '#1e1e2e', mantle: '#181825', surface0: '#313244', surface1: '#45475a', surface2: '#585b70',
  overlay0: '#6c7086', overlay1: '#7f849c', subtext0: '#a6adc8', text: '#cdd6f4',
  blue: '#89b4fa', lavender: '#b4befe', sapphire: '#74c7ec', sky: '#89dceb', teal: '#94e2d5',
  green: '#a6e3a1', yellow: '#f9e2af', peach: '#fab387', red: '#f38ba8', mauve: '#cba6f7', pink: '#f5c2e7',
};

export const c = {
  text: chalk.hex(P.text),
  muted: chalk.hex(P.overlay1),
  faint: chalk.hex(P.surface2),
  accent: chalk.hex(P.mauve),
  ok: chalk.hex(P.green),
  warn: chalk.hex(P.yellow),
  bad: chalk.hex(P.red),
  info: chalk.hex(P.blue),
  bold: chalk.bold,
  /** Status-bar segments: brand, run id, the rest. */
  brand: chalk.bgHex(P.mauve).hex(P.base).bold,
  seg1: chalk.bgHex(P.surface1).hex(P.text),
  seg2: chalk.bgHex(P.surface0).hex(P.subtext0),
  /** Foreground colours matching the segment backgrounds, for powerline separators. */
  sepBrand: chalk.hex(P.mauve),
  sepSeg1: chalk.hex(P.surface1),
  sepSeg2: chalk.hex(P.surface0),
  bar: chalk.bgHex(P.mantle),
  key: chalk.bgHex(P.mantle).hex(P.mauve).bold,
  keyText: chalk.bgHex(P.mantle).hex(P.overlay1),
  selected: chalk.hex(P.mauve),
  border: chalk.hex(P.surface1),
  fill: chalk.hex(P.mauve),
  track: chalk.hex(P.surface1),
  bg: chalk.bgHex(P.surface0),
  // Widget kit (src/tui/kit).
  /** Secondary text that still has to be read: values, column headers. */
  subtle: chalk.hex(P.subtext0),
  /** Fuzzy-match highlight inside a label. */
  match: chalk.hex(P.mauve).bold,
  /** Buttons: idle, focused, and focused when the action destroys something. */
  button: chalk.bgHex(P.surface1).hex(P.text),
  buttonFocus: chalk.bgHex(P.mauve).hex(P.base).bold,
  buttonDanger: chalk.bgHex(P.red).hex(P.base).bold,
  /** The active tab. */
  tab: chalk.bgHex(P.mauve).hex(P.base).bold,
} satisfies Record<string, ChalkInstance>;

export const status: Record<CardStatus, ChalkInstance> = {
  backlog: chalk.hex(P.overlay1), in_progress: chalk.hex(P.yellow), review: chalk.hex(P.mauve),
  done: chalk.hex(P.green), failed: chalk.hex(P.red), blocked: chalk.hex(P.peach), replaced: chalk.hex(P.surface2),
};

export const role: Record<AgentRole, ChalkInstance> = {
  planner: chalk.hex(P.lavender), worker: chalk.hex(P.blue), checker: chalk.hex(P.mauve), docs: chalk.hex(P.teal),
  reporter: chalk.hex(P.sky),
};

export const window = (utilization: number): ChalkInstance =>
  utilization >= 0.9 ? chalk.hex(P.red) : utilization >= 0.7 ? chalk.hex(P.peach) : chalk.hex(P.green);

export interface Glyphs {
  check: string; cross: string; dot: string; play: string; block: string; branch: string; clock: string; coin: string;
  planner: string; worker: string; checker: string; docs: string; reporter: string;
  sep: string; sepLeft: string; sepThin: string;
  barOn: string; barOff: string;
  spinner: string[];
  corners: [string, string, string, string]; h: string; v: string;
  up: string; down: string; bullet: string; note: string; warn: string;
  enter: string;
  // Widget kit (src/tui/kit). Several ASCII forms are wider than one cell; widgets measure them.
  /** The selected row in a list that has the keyboard. In ASCII no other glyph is this one. */
  pointer: string;
  /** The selected row in a list that does not have the keyboard (without colour the two must differ). */
  pointerIdle: string;
  checkOn: string; checkOff: string; radioOn: string; radioOff: string; toggleOn: string; toggleOff: string;
  /** Scrollbar thumb and track, drawn one cell wide. */
  thumb: string; track: string;
  /** Cycle a choice left or right; the caret marks a field that opens a dropdown. */
  prev: string; next: string; caret: string;
  search: string; info: string; mask: string;
  /** A value changed and not saved yet (a form field, a tab). Never the same glyph as a toggle that is on. */
  modified: string;
  /** Something live: a run in progress. */
  running: string;
  /** A run whose process is gone before it finished (it can be resumed): the hollow form of `running`. */
  interrupted: string;
  crumb: string; empty: string;
  /** The coloured edge on the left of a toast. */
  edge: string;
  // Live run view (src/tui/view.ts).
  /** A paused run, in the header pill and the footer. */
  pause: string;
}

const GLYPHS: Record<IconSet, Glyphs> = {
  nerd: {
    check: '', cross: '', dot: '', play: '', block: '', branch: '', clock: '', coin: '',
    planner: '', worker: '', checker: '', docs: '', reporter: '\uF0E1',
    sep: '', sepLeft: '', sepThin: '',
    barOn: '━', barOff: '╌',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    corners: ['╭', '╮', '╰', '╯'], h: '─', v: '│',
    up: '', down: '', bullet: '·', note: '', warn: '',
    enter: '⏎',
    pointer: '❯', pointerIdle: '›',
    checkOn: '', checkOff: '', radioOn: '', radioOff: '', toggleOn: '', toggleOff: '',
    thumb: '┃', track: '│',
    prev: '', next: '', caret: '',
    search: '', info: '', mask: '•', modified: '\uF040', running: '●', interrupted: '\uF10C', crumb: '›', empty: '', edge: '▌',
    pause: '\uF04C',
  },
  unicode: {
    check: '✓', cross: '✗', dot: '·', play: '▶', block: '⊘', branch: '⎇', clock: '◷', coin: '$',
    planner: '✦', worker: '⚒', checker: '◎', docs: '≡', reporter: '◔',
    sep: '', sepLeft: '', sepThin: '│',
    barOn: '━', barOff: '╌',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    corners: ['╭', '╮', '╰', '╯'], h: '─', v: '│',
    up: '▲', down: '▼', bullet: '·', note: '»', warn: '!',
    enter: '⏎',
    pointer: '❯', pointerIdle: '›',
    checkOn: '▣', checkOff: '□', radioOn: '◉', radioOff: '○', toggleOn: '●', toggleOff: '○',
    thumb: '┃', track: '│',
    prev: '‹', next: '›', caret: '▾',
    search: '⌕', info: 'i', mask: '•', modified: '✎', running: '●', interrupted: '◌', crumb: '›', empty: '∅', edge: '▌',
    pause: '‖',
  },
  ascii: {
    check: 'v', cross: 'x', dot: '.', play: '>', block: '#', branch: 'Y', clock: 't', coin: '$',
    planner: 'P', worker: 'W', checker: 'C', docs: 'D', reporter: 'R',
    sep: '', sepLeft: '', sepThin: '|',
    barOn: '=', barOff: '-',
    spinner: ['|', '/', '-', '\\'],
    corners: ['+', '+', '+', '+'], h: '-', v: '|',
    up: '^', down: 'v', bullet: '-', note: '>', warn: '!',
    enter: 'Enter',
    pointer: '*', pointerIdle: '-',
    checkOn: '[x]', checkOff: '[ ]', radioOn: '(*)', radioOff: '( )', toggleOn: '[x]', toggleOff: '[ ]',
    thumb: '#', track: '|',
    prev: '<', next: '>', caret: 'v',
    search: '/', info: 'i', mask: '#', modified: '~', running: 'o', interrupted: '%', crumb: '>', empty: '-', edge: '|',
    pause: '||',
  },
};

/** DULGER_ICONS wins; "auto" picks nerd on terminals whose users almost always run a Nerd Font. */
export function resolveIcons(pref: IconSet | 'auto'): IconSet {
  const env = process.env.DULGER_ICONS;
  if (env === 'nerd' || env === 'unicode' || env === 'ascii') return env;
  if (pref !== 'auto') return pref;
  if (process.env.TERM === 'linux') return 'ascii';
  const term = `${process.env.TERM_PROGRAM ?? ''} ${process.env.TERM ?? ''}`.toLowerCase();
  return /ghostty|kitty|wezterm|alacritty|foot/.test(term) ? 'nerd' : 'unicode';
}

export function glyphs(set: IconSet): Glyphs {
  return GLYPHS[set];
}

export function roleGlyph(g: Glyphs, r: AgentRole): string {
  return g[r];
}

export interface Segment { text: string; bg: string; fg: string; bold?: boolean }

/**
 * Powerline-style segments. `flow` is the direction the arrows point: a left-aligned group points
 * right, a right-aligned group points left. With an empty separator the segments simply touch.
 */
export function segments(items: Segment[], sep: string, flow: 'right' | 'left'): string {
  let out = '';
  items.forEach((it, i) => {
    let style = chalk.bgHex(it.bg).hex(it.fg);
    if (it.bold) style = style.bold;
    const body = style(` ${it.text} `);
    if (flow === 'right') {
      const next = items[i + 1];
      const arrow = sep ? (next ? chalk.bgHex(next.bg).hex(it.bg)(sep) : chalk.hex(it.bg)(sep)) : '';
      out += body + arrow;
    } else {
      const prevItem = items[i - 1];
      const arrow = sep ? (prevItem ? chalk.bgHex(prevItem.bg).hex(it.bg)(sep) : chalk.hex(it.bg)(sep)) : '';
      out += arrow + body;
    }
  });
  return out;
}
