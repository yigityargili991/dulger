// Pure rendering for the full-screen run view: given the board, the agents and the UI state, produce
// one frame of exactly rows × cols cells and where things landed (panes, cards, buttons, how far each
// pane scrolls), so the caller can map clicks and page sizes. Nothing here touches the terminal, so
// the layout can be tested with plain strings. Dialogs are the caller's: it places them over this.
import type { ChalkInstance } from 'chalk';
import type { AgentStatus, Board, Card, CardStatus, Task } from '../types.ts';
import { fmtCost, fmtDuration, fmtSpend, fmtTokens } from '../ui/ansi.ts';
import { usageTokens } from '../usage.ts';
import { P, c, role as roleColour, segments, status as statusColour, window as windowColour, type Glyphs, type Segment } from './theme.ts';
import { layout, compactBoard, CARD_ROWS, type Pane } from './layout.ts';
import { bar, cell, fit, plainText, repeat, spread, width, wrap } from './text.ts';
import {
  barLabel, beside, button, colourless, frame, keyHint, panel, pill, scrollbar, selectableRow, softWrap,
  type HelpGroup, type Hint, type Rect, type Size,
} from './kit/index.ts';

export type { Pane } from './layout.ts';

export interface Prompt {
  label: string;
  text: string;
  cursor: number;
  hint: string;
  /** The dim prediction shown after the cursor, empty when there is none. */
  ghost?: string;
  /** Shown faint while nothing is typed and nothing is predicted. */
  placeholder?: string;
}

export type Focus = Pane | 'input';
export type PlanAction = 'dispatch' | 'revise' | 'edit' | 'cancel' | 'backlog';

/**
 * The plan pause's choices, in the order the action row shows them; `short` when the row is narrow,
 * `key` in the footer, `what` in help.
 */
export const PLAN_ACTIONS: ReadonlyArray<{ id: PlanAction; label: string; short: string; key: string; what: string; danger?: boolean }> = [
  { id: 'dispatch', label: 'Dispatch', short: 'Go', key: 'dispatch', what: 'start the workers' },
  { id: 'revise', label: 'Revise', short: 'Revise', key: 'revise', what: 'reply to the planner' },
  { id: 'edit', label: 'Edit plan', short: 'Edit', key: 'edit', what: 'edit it yourself' },
  { id: 'cancel', label: 'Cancel run', short: 'Cancel', key: 'cancel', what: 'delete run and plan', danger: true },
  { id: 'backlog', label: 'Keep in backlog', short: 'Later', key: 'backlog', what: 'resume runs it later' },
];

/** The plan pause as a review screen. The reply line is the view's `prompt`. */
export interface ReviewState {
  /** The caller's warnings about the plan (cards too big for one reviewer, foundations doing too much). */
  warnings: string[];
  /** The focused action, an index into PLAN_ACTIONS. */
  button: number;
  /** The last revision: what the person asked, and what it changed. */
  revision?: Revision;
}

/** What a revision of the plan was asked for and what it changed, card by card. */
export interface Revision {
  /** The reply the person sent the planner. */
  asked: string;
  /** The planner could not revise it: the plan is the one from before. */
  failed?: boolean;
  added: string[];
  removed: string[];
  edited: string[];
}

export interface ViewState {
  board: Board;
  agents: AgentStatus[];
  /** Log lines, oldest first, already timestamped. */
  notes: string[];
  startedAt: number;
  now: number;
  rows: number;
  cols: number;
  g: Glyphs;
  phase: string;
  /** Selected card id, and the open one when a card is expanded. */
  selected?: string;
  open?: string;
  openScroll: number;
  /** Log lines below the view; 0 follows the tail. */
  logScroll: number;
  focus: Focus;
  prompt?: Prompt;
  /** The pane drawn at full height. */
  zoom?: Pane;
  /** The selected agent in the agents pane (default: the first). */
  agentSel?: string;
  review?: ReviewState;
  /** First row of the plan shown while it is reviewed or revised. */
  planScroll?: number;
  /** Pause, stop and instruct work now. */
  controls?: boolean;
  /** Wheel and clicks are reported (help mentions them). */
  mouse?: boolean;
}

export interface Limits { max: number; page: number }

export interface Hits {
  /** Each shown pane, its heading included. */
  panes: Partial<Record<Pane, Rect>>;
  /** Card boxes on the board, or rows of the compact list. */
  cards: Array<{ id: string; rect: Rect }>;
  /** The board's columns and the cards in each, for the wheel. */
  columns: Array<{ left: number; cols: number; ids: string[] }>;
  agents: Array<{ id: string; row: number }>;
  buttons: Array<{ id: PlanAction; row: number; from: number; to: number }>;
  prompt?: number;
  /** How far the open card, the plan and the log scroll, and how much is a page. */
  detail?: Limits;
  plan?: Limits;
  log?: Limits;
  agentPage: number;
}

export interface Frame { lines: string[]; cursor?: { row: number; col: number }; compact: boolean; hits: Hits }

export interface Column { title: string; statuses: CardStatus[]; cards: Card[] }

const COLUMNS: Array<{ title: string; statuses: CardStatus[]; always: boolean }> = [
  { title: 'BACKLOG', statuses: ['backlog'], always: true },
  { title: 'IN PROGRESS', statuses: ['in_progress'], always: true },
  { title: 'REVIEW', statuses: ['review'], always: true },
  { title: 'DONE', statuses: ['done'], always: true },
  { title: 'FAILED', statuses: ['failed', 'blocked', 'replaced'], always: false },
];

/** The columns shown for a board: the failed column only once something is in it. */
export function columns(board: Board): Column[] {
  return COLUMNS
    .map((col) => ({ title: col.title, statuses: col.statuses, always: col.always, cards: board.cards.filter((k) => col.statuses.includes(k.status)) }))
    .filter((col) => col.always || col.cards.length > 0)
    .map(({ title, statuses, cards }) => ({ title, statuses, cards }));
}

/** The phase while the planner revises the plan (commands.ts sets it). */
export const REVISING = 'revising';

/** The plan is on screen: while it waits for a go, and while the planner revises it. */
export function planMode(s: Pick<ViewState, 'review' | 'phase' | 'board'>): boolean {
  return Boolean(s.review) || (s.phase === REVISING && s.board.cards.length > 0);
}

const live = (a: AgentStatus) => a.state === 'running' || a.state === 'starting';

/** Agents as the pane lists them: the live ones first, then the finished ones, newest first. */
export function orderedAgents(agents: AgentStatus[]): AgentStatus[] {
  return [...agents.filter(live), ...agents.filter((a) => !live(a)).reverse()];
}

/** The card stop and instruct act on: the selected agent's while the agents pane has focus, else the board's selection. */
export function targetCard(s: Pick<ViewState, 'focus' | 'agents' | 'agentSel' | 'board' | 'selected'>): string | undefined {
  if (s.focus === 'agents') {
    const list = orderedAgents(s.agents);
    const a = list.find((x) => x.id === s.agentSel) ?? list[0];
    if (a?.cardId && s.board.cards.some((k) => k.id === a.cardId)) return a.cardId;
  }
  return s.selected;
}

/** The card the controls act on, and whether it can still be stopped or instructed. */
function controlsFor(s: ViewState): { id?: string; stop: boolean; instruct: boolean } {
  const id = targetCard(s);
  const card = s.board.cards.find((k) => k.id === id);
  return {
    id,
    stop: Boolean(card && ['backlog', 'in_progress', 'review'].includes(card.status)),
    instruct: Boolean(card && card.status !== 'done' && card.status !== 'replaced'),
  };
}

const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
/**
 * What draws nothing or passes for something it is not: control and format characters (a newline, a
 * right-to-left override, a zero-width joiner), surrogates, private-use and unassigned code points, line
 * and paragraph separators, spaces other than the plain one (a shell does not split words on them), and
 * the fillers and joiners that are invisible though they are letters or marks.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}   -   　͏ᅟᅠ឴឵᠋-᠏ㅤﾠ]/u;
const SELECTOR = /[︀-️\u{e0100}-\u{e01ef}]/u;
const EMOJI = /\p{Emoji}/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * A shell command as it will run, for a person approving it: every character kept, and every one that
 * would hide, reorder or pass for something else spelled out as `\n`, `\t` or `\u{…}`. A variation
 * selector stays only where it picks an emoji's form; anywhere else it draws nothing, so it is spelled out.
 */
export function shownCommand(cmd: string): string {
  if (PRINTABLE_ASCII.test(cmd)) return cmd;
  let out = '';
  let prev = '';
  for (const ch of cmd) {
    const keep = SELECTOR.test(ch) ? (ch === '︎' || ch === '️') && EMOJI.test(prev) : !HIDDEN.test(ch);
    out += keep ? ch : NAMED[ch] ?? `\\u{${ch.codePointAt(0)!.toString(16)}}`;
    prev = ch;
  }
  return out;
}

/**
 * A command in rows of at most `w` cells, soft-wrapped and never cut: `$ ` first, continuations indented.
 * Too narrow for the lead and a wide character beside it, the rows are the command alone.
 */
export function commandRows(cmd: string, w: number, lead = c.accent('$')): string[] {
  const shown = shownCommand(cmd);
  if (w < 4) return softWrap(shown, Math.max(1, w)).map((r) => c.text(r));
  return softWrap(shown, w - 2).map((r, i) => (i ? '  ' : `${lead} `) + c.text(r));
}

export function render(s: ViewState): Frame {
  const { rows, cols } = s;
  const hits: Hits = { panes: {}, cards: [], columns: [], agents: [], buttons: [], agentPage: 1 };
  const plan = planMode(s);
  const openCard = !plan && s.open ? s.board.cards.find((k) => k.id === s.open) : undefined;
  const zoom = plan && s.zoom === 'agents' ? undefined : s.zoom;
  const agents = orderedAgents(s.agents);
  // The document is laid out once at the panel's usual inner width; the panel reuses it.
  const docW = Math.max(1, cols - 4);
  const doc = plan ? { w: docW, lines: planDoc(s, docW) } : openCard ? { w: docW, lines: cardDoc(s, openCard, docW) } : undefined;
  const boardLines = doc ? doc.lines.length + 2 : 1 + Math.max(1, ...columns(s.board).map((col) => col.cards.length)) * CARD_ROWS;
  const areas = layout(rows, {
    prompt: Boolean(s.prompt), actions: Boolean(s.review), boardLines, agentLines: Math.max(1, agents.length),
    agents: !plan, zoom, boardShare: plan ? 0.75 : undefined,
    // A plan longer than the screen takes the log's empty rows; while it runs the log fills soon enough.
    logLines: plan ? s.notes.length : undefined,
  });
  const lines: string[] = [];
  if (areas.header) lines.push(statusBar(s));
  if (areas.gap) lines.push('');
  if (areas.board) {
    const rect = { top: lines.length, left: 0, rows: areas.board, cols };
    hits.panes.board = rect;
    const focused = s.focus === 'board';
    let block: string[];
    if (plan) { const r = planPanel(s, rect, focused, doc); block = r.lines; hits.plan = r.limits; }
    else if (openCard) { const r = cardPanel(s, openCard, rect, focused, doc); block = r.lines; hits.detail = r.limits; }
    else block = boardPane(s, rect, hits);
    lines.push(...rowsOf(block, rect.rows));
  }
  if (areas.agents) {
    const top = lines.length;
    const rect = { top: top + 1, left: 0, rows: areas.agents, cols };
    hits.panes.agents = { ...rect, top, rows: rect.rows + 1 };
    const body = agentsPane(s, agents, rect, zoom === 'agents', hits);
    lines.push(agentsHeading(s, agents, cols, body.from, body.shown, zoom === 'agents'));
    lines.push(...rowsOf(body.lines, rect.rows));
  }
  if (areas.log) {
    const top = lines.length;
    const rect = { top: top + 1, left: 0, rows: areas.log, cols };
    hits.panes.log = { ...rect, top, rows: rect.rows + 1 };
    const body = logPane(s, rect, zoom === 'log');
    hits.log = body.limits;
    lines.push(logHeading(s, cols, body.scroll, zoom === 'log'));
    lines.push(...rowsOf(body.lines, rect.rows));
  }
  if (areas.actions && s.review) lines.push(actionsRow(s, cols, lines.length, hits));
  let cursor: Frame['cursor'];
  if (s.prompt && areas.prompt) {
    hits.prompt = lines.length;
    const p = promptLine(s.prompt, cols, s.focus === 'input');
    lines.push(p.line);
    if (s.focus === 'input') cursor = { row: lines.length - 1, col: p.cursorCol };
  }
  if (areas.footer) lines.push(footerLine(s, cols));
  return { lines: rowsOf(lines, rows).map((l) => exact(l, cols)), cursor, compact: compactBoard(cols, areas.board, columns(s.board).length), hits };
}

// Measuring a styled line is the costly part of a frame (box-drawing characters miss string-width's
// ASCII shortcut), so panes only count their rows and every line is measured once, here at the end.

/** `n` rows: cut, or padded with empty ones. */
function rowsOf(lines: string[], n: number): string[] {
  const out = lines.slice(0, Math.max(0, n));
  while (out.length < n) out.push('');
  return out;
}

/** Exactly `w` cells with one measurement when the line fits, which nearly every line does. */
function exact(line: string, w: number): string {
  const lw = width(line);
  return lw <= w ? line + repeat(' ', w - lw) : cell(line, w);
}

/** A pane heading: a rule with the title, mauve while the pane has focus, `right` before the end. */
function separator(g: Glyphs, cols: number, label: string, right: string, focused: boolean): string {
  const rule = focused ? c.selected : c.border;
  // Without colour the focus would not show at all.
  const mark = focused && colourless() ? `${g.pointer} ` : '';
  const head = rule(repeat(g.h, 3)) + ' ' + mark + (focused ? c.bold(label) : label) + ' ';
  const tail = right ? ' ' + right + ' ' + rule(g.h) : '';
  const fill = cols - width(head) - width(tail);
  if (fill < 1) return fit(head + rule(repeat(g.h, Math.max(0, cols - width(head)))), cols, '');
  return head + rule(repeat(g.h, fill)) + tail;
}


// ---- status bar ----

function cardCounts(board: Board): { total: number; done: number; failed: number } {
  const cards = board.cards.filter((k) => k.status !== 'replaced');
  return {
    total: cards.length,
    done: cards.filter((k) => k.status === 'done').length,
    failed: cards.filter((k) => k.status === 'failed' || k.status === 'blocked').length,
  };
}

function statusBar(s: ViewState): string {
  const { board, g, cols } = s;
  const brand: Segment = { text: `${g.branch} dulger`, bg: P.mauve, fg: P.base, bold: true };
  const run: Segment = { text: plainText(board.runId), bg: P.surface1, fg: P.text };
  const paused = board.paused ? ' ' + pill(`${g.pause} paused`, 'warn') : '';
  const counts = cardCounts(board);
  const progress = (barW: number): Segment[] => {
    if (!counts.total) return [];
    if (planMode(s)) return [{ text: `${counts.total} card${counts.total === 1 ? '' : 's'}`, bg: P.surface1, fg: P.text }];
    const lit = barW ? bar(counts.done / counts.total, barW, g.barOn, g.barOff, c.ok, c.faint) + ' ' : '';
    const failed = counts.failed ? ' ' + c.bad(`${g.cross}${counts.failed}`) : '';
    return [{ text: `${lit}${counts.done}/${counts.total}${failed}`, bg: P.surface1, fg: P.text }];
  };
  const clock: Segment = { text: `${g.clock} ${fmtDuration(s.now - s.startedAt)}`, bg: P.surface0, fg: P.subtext0 };
  // An amount already starts with its sign: a `$` glyph in front of it would say it twice.
  const spent = spendText(board);
  const spend: Segment = { text: g.coin === '$' && spent.startsWith('$') ? spent : `${g.coin} ${spent}`, bg: P.surface1, fg: P.text };
  const windows: Segment[] = board.rateLimits?.windows.length ? [{ text: windowsText(board), bg: P.surface2, fg: P.text }] : [];
  // Richest first; the goal fills whatever is left in the middle.
  const rights: Segment[][] = [
    [...progress(10), clock, spend, ...windows],
    [...progress(5), clock, spend, ...windows],
    [...progress(5), clock, spend],
    [...progress(0), clock, spend],
    [...progress(0), spend],
    progress(0),
    [],
  ];
  const lefts = [segments([brand, run], g.sep, 'right') + paused, segments([brand], g.sep, 'right') + paused, paused.trim()];
  const goalText = plainText(board.goal);
  const line = (left: string, right: string, goalW: number) => spread(left + (goalW > 8 ? ' ' + c.muted(fit(goalText, goalW)) : ''), right, cols);
  // The goal says what the run is: a narrower bar or no plan windows leave room for some of it, and
  // while paused (the pill takes its share, and the clock means less) so does the clock.
  const want = Math.min(width(goalText), 12);
  for (const r of rights.slice(0, board.paused ? 5 : 4)) {
    const right = r.length ? segments(r, g.sepLeft, 'left') : '';
    const goalW = cols - width(lefts[0]!) - width(right) - 3;
    if (goalW > 8 && goalW >= want) return line(lefts[0]!, right, goalW);
  }
  for (const left of lefts) {
    for (const r of rights) {
      const right = r.length ? segments(r, g.sepLeft, 'left') : '';
      if (width(left) + width(right) + 1 > cols) continue;
      return line(left, right, cols - width(left) - width(right) - 3);
    }
  }
  return fit(segments([brand], g.sep, 'right'), cols, '');
}

function spendText(board: Board): string {
  const parts: string[] = [];
  if (board.costUsd > 0) parts.push(fmtCost(board.costUsd));
  if (board.usage) parts.push(`${fmtTokens(usageTokens(board.usage))} tok`);
  return parts.join(' · ') || '—';
}

function windowsText(board: Board): string {
  const names: Record<string, string> = { five_hour: '5h', seven_day: '7d' };
  return board.rateLimits!.windows
    .map((w) => `${plainText(names[w.name] ?? w.name)} ${windowColour(w.utilization)(`${Math.round(w.utilization * 100)}%`)}`)
    .join(' ');
}

// ---- board columns ----

function boardPane(s: ViewState, rect: Rect, hits: Hits): string[] {
  const { cols, g } = s;
  const height = rect.rows;
  const focused = s.focus === 'board';
  if (s.board.cards.length === 0) {
    const msg = `${c.accent(spinner(s))} ${c.muted(`${plainText(s.phase)}…`)}`;
    const line = repeat(' ', Math.max(0, Math.floor((cols - width(msg)) / 2))) + msg;
    return height >= 2 ? ['', line] : [line];
  }
  const colsList = columns(s.board);
  const n = colsList.length;
  const colW = Math.floor((cols - (n - 1)) / n);
  if (compactBoard(cols, height, n)) {
    const cards = colsList.flatMap((col) => col.cards);
    const selected = cards.findIndex((card) => card.id === s.selected);
    const from = Math.max(0, selected - height + 1);
    hits.columns.push({ left: 0, cols, ids: cards.map((k) => k.id) });
    return cards.slice(from, from + height).map((card, i) => {
      hits.cards.push({ id: card.id, rect: { top: rect.top + i, left: 0, rows: 1, cols } });
      const label = `${cardIcon(s, card)} ${plainText(card.id)} ${plainText(card.title)} ${c.muted(`· ${card.status.replace('_', ' ')}`)}`;
      return selectableRow(label, cols, g, card.id === s.selected, focused);
    });
  }
  const perCol = Math.max(1, Math.floor((height - 1) / CARD_ROWS));
  const grid: string[][] = colsList.map((col, ci) => {
    const left = ci * (colW + 1);
    hits.columns.push({ left, cols: colW, ids: col.cards.map((k) => k.id) });
    const sel = col.cards.findIndex((k) => k.id === s.selected);
    const from = sel >= perCol ? sel - perCol + 1 : 0;
    const shown = col.cards.slice(from, from + perCol);
    const count = statusColour[col.statuses[0]!](String(col.cards.length));
    const head = c.bold(c.muted(col.title)) + ' ' + count;
    const more = col.cards.length - from - shown.length;
    const scrolled = from > 0 ? c.muted(`${g.up}${from}`) : '';
    const lines = [spread(head, scrolled, colW)];
    shown.forEach((card, k) => {
      hits.cards.push({ id: card.id, rect: { top: rect.top + 1 + k * CARD_ROWS, left, rows: CARD_ROWS, cols: colW } });
      lines.push(...cardBox(s, card, colW, focused));
    });
    if (more > 0) lines[lines.length - 1] = spread(c.muted(` ${g.down}${more}`), '', colW);
    return lines;
  });
  const out: string[] = [];
  for (let r = 0; r < height; r++) out.push(grid.map((col) => cell(col[r] ?? '', colW)).join(' '));
  return out;
}

function agentFor(s: ViewState, card: Card): AgentStatus | undefined {
  // Reporters describe the card's agent; they are not it. The card box and detail show the worker.
  const mine = s.agents.filter((a) => a.cardId === card.id && a.role !== 'reporter');
  return mine.find(live) ?? mine.at(-1);
}

function spinner(s: ViewState): string {
  return s.g.spinner[Math.floor(s.now / 80) % s.g.spinner.length]!;
}

function cardIcon(s: ViewState, card: Card): string {
  const { g } = s;
  const paint = statusColour[card.status];
  switch (card.status) {
    case 'backlog': return paint(g.dot);
    case 'in_progress': return paint(spinner(s));
    case 'review': return paint(g.checker);
    case 'done': return paint(g.check);
    case 'failed': return paint(g.cross);
    case 'blocked': return paint(g.block);
    case 'replaced': return paint(g.dot);
  }
}

function taskIcon(s: ViewState, t: Task): string {
  const { g } = s;
  switch (t.status) {
    case 'pending': return c.muted(g.dot);
    case 'running': return c.warn(spinner(s));
    case 'done': return c.ok(g.check);
    case 'failed': return c.bad(g.cross);
  }
}

/** Five rows: border, title, state line, agent line, border. The selected card's border is mauve while the board has focus. */
function cardBox(s: ViewState, card: Card, w: number, focused: boolean): string[] {
  const { g } = s;
  const inner = w - 2;
  const selected = card.id === s.selected;
  const edge = selected ? (focused ? c.selected : c.subtle) : c.border;
  const mark = selected && colourless() ? `${g.pointer} ` : '';
  const title = `${mark}${cardIcon(s, card)} ${c.bold(plainText(card.id))} ${plainText(card.title)}`;
  const body = [title, stateLine(s, card, inner - 2), agentLine(s, card)]
    .map((l) => edge(g.v) + ' ' + cell(l, inner - 2) + ' ' + edge(g.v));
  const top = edge(g.corners[0] + repeat(g.h, inner) + g.corners[1]);
  const bottom = edge(g.corners[2] + repeat(g.h, inner) + g.corners[3]);
  return [top, ...body, bottom];
}

function stateLine(s: ViewState, card: Card, w: number): string {
  const { g } = s;
  const done = card.tasks.filter((t) => t.status === 'done').length;
  const total = card.tasks.length;
  switch (card.status) {
    case 'backlog': {
      const waiting = card.dependsOn.filter((d) => s.board.cards.find((k) => k.id === d)?.status !== 'done');
      return waiting.length ? c.muted(`after ${plainText(waiting.join(', '))}`) : c.muted(`${total} task${total === 1 ? '' : 's'}`);
    }
    case 'in_progress': {
      const label = `${done}/${total}${card.attempts ? ` #${card.attempts + 1}` : ''}`;
      const barW = Math.max(3, w - width(label) - 1);
      return bar(total ? done / total : 0, barW, g.barOn, g.barOff, c.fill, c.track) + ' ' + c.muted(label);
    }
    case 'review': return statusColour.review(`round ${card.attempts + 1}`);
    case 'done': return c.ok(fmtSpend(card));
    // Why it failed is data (the reviewer's or a tool's words); a stop is the person's own doing.
    case 'failed': case 'blocked': return c.bad(card.stopped ? 'stopped' : plainText(card.reason ?? card.feedback.at(-1) ?? card.status));
    case 'replaced': return c.faint('replaced');
  }
}

/** How long a progress note is still shown as the card's line before the live agent message takes back over. */
const NOTE_FRESH_MS = 5 * 60_000;

/** The reporter's note, when it is fresh enough to still describe what the card is doing. */
function progressLine(s: ViewState, card: Card): string | undefined {
  const p = card.progress;
  if (!p || s.now - Date.parse(p.at) > NOTE_FRESH_MS) return undefined;
  const body = roleColour.reporter(s.g.reporter) + ' ' + c.info(plainText(p.note));
  return p.attention ? body + c.warn(` — ${plainText(p.attention)}`) : body;
}

function agentLine(s: ViewState, card: Card): string {
  const a = agentFor(s, card);
  switch (card.status) {
    case 'in_progress': {
      const note = progressLine(s, card);
      if (note) return note;
      return a ? roleColour[a.role](s.g[a.role]) + ' ' + c.muted(plainText(a.lastMessage ?? a.state)) : '';
    }
    case 'review':
      return a ? roleColour[a.role](s.g[a.role]) + ' ' + c.muted(plainText(a.lastMessage ?? a.state)) : '';
    case 'done': return c.muted(plainText(card.review ?? card.summary ?? ''));
    case 'failed': case 'blocked': {
      const what = !card.stopped && card.attempts ? `${card.attempts} round${card.attempts === 1 ? '' : 's'}` : '';
      return c.muted([what, fmtSpend(card)].filter(Boolean).join(' · '));
    }
    default: return card.reviewNotes?.length ? c.warn(`${s.g.note} ${plainText(card.reviewNotes.at(-1) ?? '')}`) : '';
  }
}

// ---- documents: the open card and the plan ----

/** A titled panel over a document of lines, scrolled to `scroll` (clamped), with a scrollbar and position. */
type Doc = { w: number; lines: string[] };

function docPanel(size: Size, o: { g: Glyphs; title: string; badge?: string; focused: boolean }, doc: (w: number) => string[], scroll: number, pre?: Doc): { lines: string[]; limits: Limits } {
  let top = 0;
  let total = 0;
  let visible = 1;
  const r = panel(size, {
    // Without colour the kit's panel marks the focused one itself.
    g: o.g, title: o.title, badge: o.badge, focused: o.focused,
    footer: () => (total > visible ? c.muted(`${top + 1}-${Math.min(total, top + visible)}/${total}`) : ''),
    scroll: () => ({ top, total, visible }),
  }, (inner) => {
    const all = pre && pre.w === inner.cols ? pre.lines : doc(inner.cols);
    total = all.length;
    visible = Math.max(1, inner.rows);
    top = Math.max(0, Math.min(scroll, total - visible));
    return all.slice(top, top + inner.rows);
  });
  return { lines: r.lines, limits: { max: Math.max(0, total - visible), page: Math.max(1, visible - 1) } };
}

/** Plain `text` wrapped under `lead`, continuation rows indented as far as the lead is wide. */
function hang(lead: string, text: string, w: number, paint: ChalkInstance): string[] {
  const lw = width(lead);
  return wrap(text, Math.max(1, w - lw)).map((l, i) => (i ? repeat(' ', lw) : lead) + paint(l));
}

const turns = (n: number) => `${n} turn${n === 1 ? '' : 's'}`;

function statusLabel(status: CardStatus): string {
  return status.replace('_', ' ');
}

function cardPanel(s: ViewState, card: Card, rect: Rect, focused: boolean, pre?: Doc): { lines: string[]; limits: Limits } {
  const badge = `${statusColour[card.status](statusLabel(card.status))} ${c.muted(`· attempt ${card.attempts + 1} · ${fmtSpend(card)}`)}`;
  return docPanel(rect, { g: s.g, title: `${card.id} ${card.title}`, badge, focused }, (w) => cardDoc(s, card, w), s.openScroll, pre);
}

/** The open card as sections: what it is, acceptance and tasks, verify, progress, its agents' activity, review. */
function cardDoc(s: ViewState, card: Card, w: number): string[] {
  const { g } = s;
  const out: string[] = [];
  const gap = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  const heading = (t: string) => out.push(c.accent.bold(fit(t, w)));

  const facts: string[] = [];
  if (card.dependsOn.length) {
    facts.push(`after ${card.dependsOn.map((d) => {
      const dep = s.board.cards.find((k) => k.id === d);
      return `${plainText(d)}${dep && dep.status !== 'done' ? ` (${statusLabel(dep.status)})` : ''}`;
    }).join(', ')}`);
  }
  if (card.worker) facts.push(`worker ${plainText(card.worker.harness ?? 'session harness')} / ${plainText(card.worker.model ?? 'automatic')}`);
  if (facts.length) out.push(...wrap(facts.join(' · '), w).map((l) => c.muted(l)));
  out.push(...wrap(card.description, w).map((l) => c.subtle(l)));
  if (card.guidance?.length) {
    gap();
    heading('Instructions');
    for (const note of card.guidance) out.push(...hang(`${g.bullet} `, note, w, c.info));
  }

  gap();
  const half = w < 60 ? w : Math.floor((w - 2) / 2);
  const left = [c.accent.bold('Acceptance')];
  for (const a of card.acceptanceCriteria) left.push(...hang(`${c.muted(g.bullet)} `, a, half, c.text));
  if (card.acceptanceCriteria.length === 0) left.push(c.faint('—'));
  const right = [c.accent.bold('Tasks')];
  for (const t of card.tasks) {
    const a = s.agents.filter((x) => x.taskId === t.id && x.cardId === card.id).at(-1);
    const tag = t.kind === 'fix' ? c.warn('fix ') : '';
    const meta = a && t.status === 'running' ? c.muted(` ${plainText(a.id)} · ${a.turns}t · ${fmtDuration(s.now - a.startedAt)}`) : a ? c.faint(` ${plainText(a.id)}`) : '';
    right.push(spread(`${taskIcon(s, t)} ${tag}${c.bold(plainText(t.id))} ${plainText(t.title)}`, meta, half));
    if (t.status === 'running' && a?.lastMessage) right.push(c.muted(`  ${fit(plainText(a.lastMessage), half - 2)}`));
    else if (t.status === 'done' && t.result?.summary) right.push(c.faint(`  ${fit(plainText(t.result.summary), half - 2)}`));
    else if (t.error) right.push(c.bad(`  ${fit(plainText(t.error), half - 2)}`));
  }
  if (card.tasks.length === 0) right.push(c.faint('—'));
  if (w < 60) out.push(...left, '', ...right);
  else for (let i = 0; i < Math.max(left.length, right.length); i++) out.push(cell(left[i] ?? '', half) + '  ' + cell(right[i] ?? '', half));

  if (card.verify.length) {
    gap();
    heading('Verify');
    for (const cmd of card.verify) {
      const r = card.verification?.find((v) => v.command.trim() === cmd.trim());
      const lead = r ? (r.ok ? c.ok(g.check) : c.bad(g.cross)) : c.accent('$');
      const rows = commandRows(cmd, w, lead);
      const meta = r ? c.muted(`${r.ok ? '' : c.bad(`exit ${r.exitCode} · `)}${(r.durationMs / 1000).toFixed(1)}s`) : '';
      if (meta && rows.length === 1 && width(rows[0]!) + width(meta) + 2 <= w) rows[0] = spread(rows[0]!, meta, w);
      else if (meta) rows.push(`  ${meta}`);
      out.push(...rows);
    }
  } else {
    gap();
    heading('Verify');
    out.push(c.faint('—'));
  }

  if (card.progress) {
    const p = card.progress;
    gap();
    out.push(spread(`${roleColour.reporter(g.reporter)} ${c.accent.bold('Progress')}`, c.muted(`${fmtDuration(Math.max(0, s.now - Date.parse(p.at)))} ago`), w));
    for (const l of wrap(p.note, w - 2)) out.push(c.info(`  ${l}`));
    if (p.attention) for (const l of wrap(p.attention, w - 2)) out.push(c.warn(`${g.warn} ${l}`));
  }

  // The card's own agents: the one that speaks for it now with what it did lately, then the earlier ones.
  const mine = s.agents.filter((a) => a.cardId === card.id && a.role !== 'reporter');
  const current = agentFor(s, card);
  if (current) {
    gap();
    heading('Activity');
    for (const a of [current, ...mine.filter((x) => x !== current).reverse()]) {
      const elapsed = fmtDuration((a.endedAt ?? s.now) - a.startedAt);
      const where = a.taskId ? ` ${plainText(a.taskId)}` : '';
      out.push(fit(`${roleColour[a.role](g[a.role])} ${c.bold(plainText(a.id))} ${roleColour[a.role](a.role)}${c.muted(`${where} · ${a.state} · ${turns(a.turns)} · ${elapsed}${a.costUsd ? ` · ${fmtCost(a.costUsd)}` : ''}`)}`, w));
      if (a === current) for (const h of a.history.slice(-12)) out.push(c.muted(`  ${fit(plainText(h), w - 2)}`));
    }
  }

  if (card.reason || card.feedback.length || card.reviewNotes?.length || card.review) {
    gap();
    heading('Review');
    if (card.reason) out.push(...hang(`${c.bad(g.warn)} `, card.stopped ? 'stopped' : card.reason, w, c.bad));
    for (const f of card.feedback) out.push(...hang(`${c.bad(g.warn)} `, f, w, c.bad));
    for (const n of card.reviewNotes ?? []) out.push(...hang(`${c.warn(g.note)} `, n, w, c.warn));
    if (card.review) out.push(...wrap(card.review, w).map((l) => c.muted(l)));
  }
  return out;
}

function planPanel(s: ViewState, rect: Rect, focused: boolean, pre?: Doc): { lines: string[]; limits: Limits } {
  const cards = s.board.cards;
  const tasks = cards.reduce((n, k) => n + k.tasks.length, 0);
  const commands = new Set(cards.flatMap((k) => k.verify.map((v) => v.trim()))).size;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const badge = s.review
    ? c.muted(`${plural(cards.length, 'card')} · ${plural(tasks, 'task')} · ${commands} verify`)
    : c.warn(`${spinner(s)} revising…`);
  const revisions = s.board.plan?.revisions ?? 0;
  return docPanel(rect, { g: s.g, title: revisions ? `Plan · revision ${revisions}` : 'Plan', badge, focused }, (w) => planDoc(s, w), s.planScroll ?? 0, pre);
}

/**
 * The plan as a document: what the planner assumed and left out first (they are short and change what
 * the cards mean), then each card with its acceptance, tasks and verify commands shown whole.
 */
export function planDoc(s: Pick<ViewState, 'board' | 'g' | 'review'>, w: number): string[] {
  const { board, g } = s;
  const out: string[] = [];
  // A gutter of labels while there is room; below that, labels on their own rows.
  const roomy = w >= 40;
  // Prose is laid out to fit, but on a narrow pane a lead (a bullet, a long id) can be wider than the
  // room left beside it: those rows are cut. Command rows are laid out to fit and are never cut.
  const prose = (line: string) => out.push(roomy ? line : fit(line, w));
  const notes = (title: string, items: string[], paint: ChalkInstance) => {
    if (!items.length) return;
    out.push(c.accent.bold(fit(title, w)));
    for (const it of items) for (const l of hang(`${paint(g.bullet)} `, it, w, paint)) prose(l);
    out.push('');
  };
  // After a revision: the reply that asked for it first; the cards carry `new` / `changed`, and what
  // went or did not happen is one state line.
  const revision = s.review?.revision;
  if (revision) {
    for (const l of hang(`${c.muted('›')} `, revision.asked, w, c.info)) prose(l);
    if (revision.failed) prose(c.bad(`${g.cross} not revised`));
    else if (revision.removed.length) prose(`${c.bad('removed')} ${c.text(plainText(revision.removed.join(', ')))}`);
    out.push('');
  }
  const mark = (id: string): string => {
    if (!revision || revision.failed) return '';
    if (revision.added.includes(id)) return ' ' + c.ok('new');
    return revision.edited.includes(id) ? ' ' + c.warn('changed') : '';
  };
  notes('Assumptions', board.plan?.assumptions ?? [], c.warn);
  notes('Left out', board.plan?.omitted ?? [], c.bad);
  notes('Warnings', s.review?.warnings ?? [], c.warn);
  // Indents give way on a tiny pane, so a command keeps at least three cells per row.
  const indent = roomy ? 4 : Math.min(2, Math.max(0, w - 3));
  const gutter = roomy ? 11 : 0;
  const rowIndent = roomy ? indent + gutter : Math.min(4, Math.max(0, w - 3));
  const bodyW = Math.max(1, w - rowIndent);
  const block = (label: string, rows: string[], command = false) => {
    if (!rows.length) return;
    if (roomy) {
      rows.forEach((r, i) => out.push(repeat(' ', indent) + (i ? repeat(' ', gutter) : c.muted(label.padEnd(gutter))) + r));
      return;
    }
    prose(repeat(' ', indent) + c.muted(label));
    for (const r of rows) {
      if (command) out.push(repeat(' ', rowIndent) + r);
      else prose(repeat(' ', rowIndent) + r);
    }
  };
  for (const card of board.cards) {
    const deps = card.dependsOn.length ? c.muted(`after ${plainText(card.dependsOn.join(', '))}`) : '';
    const lead = `${c.bold(plainText(card.id))}${mark(card.id)}  `;
    const titleW = Math.max(1, w - (deps && w >= 50 ? width(deps) + 2 : 0));
    const titleRows = hang(lead, card.title, titleW, c.text.bold).map((r) => fit(r, w));
    titleRows[0] = deps && w >= 50 ? spread(titleRows[0]!, deps, w) : titleRows[0]!;
    out.push(...titleRows);
    if (deps && w < 50) prose(repeat(' ', indent) + deps);
    for (const l of wrap(card.description, Math.max(1, w - indent))) out.push(repeat(' ', indent) + c.subtle(l));
    block('done when', card.acceptanceCriteria.flatMap((a) => hang(`${c.muted(g.bullet)} `, a, bodyW, c.text)));
    block('tasks', card.tasks.flatMap((t) => hang(`${c.bold(plainText(t.id))} `, t.title + (t.complexity ? ` (${t.complexity})` : ''), bodyW, c.text)));
    if (card.verify.length) block('verify', card.verify.flatMap((v) => commandRows(v, bodyW)), true);
    else block('verify', [c.faint('—')]);
    if (card.worker) block('worker', [c.text(fit(`${plainText(card.worker.harness ?? 'session harness')} / ${plainText(card.worker.model ?? 'automatic')}`, bodyW))]);
    out.push('');
  }
  if (out.at(-1) === '') out.pop();
  return out;
}

// ---- agents ----

function agentsHeading(s: ViewState, agents: AgentStatus[], cols: number, from: number, shown: number, zoomed: boolean): string {
  const running = agents.filter(live).length;
  const label = `agents ${running ? c.warn(`${running} running`) : c.muted('idle')}`;
  const right = agents.length > shown && shown > 0 ? `${from + 1}-${from + shown}/${agents.length}` : '';
  return separator(s.g, cols, label, right ? c.muted(right) : '', s.focus === 'agents');
}

function agentsPane(s: ViewState, agents: AgentStatus[], rect: Rect, zoomed: boolean, hits: Hits): { lines: string[]; from: number; shown: number } {
  const focused = s.focus === 'agents';
  if (!agents.length) return { lines: [], from: 0, shown: 0 };
  const sel = Math.max(0, agents.findIndex((a) => a.id === s.agentSel));
  if (!zoomed || rect.rows < 3) return agentList(s, agents, rect, sel, focused, hits);
  // Zoomed: every agent, and what the selected one did lately beside or below the list.
  const a = agents[sel]!;
  if (rect.cols >= 100) {
    const lw = Math.min(Math.floor(rect.cols * 0.55), 96);
    const list = agentList(s, agents, { ...rect, cols: lw }, sel, focused, hits);
    const hist = agentHistory(s, a, { rows: rect.rows, cols: rect.cols - lw - 2 });
    return { ...list, lines: beside([frame(list.lines, { rows: rect.rows, cols: lw }), hist], [lw, rect.cols - lw - 2], rect.rows, 2) };
  }
  const listRows = Math.max(1, Math.min(agents.length, Math.ceil(rect.rows / 2)));
  const list = agentList(s, agents, { ...rect, rows: listRows }, sel, focused, hits);
  const hist = agentHistory(s, a, { rows: rect.rows - listRows, cols: rect.cols }, true);
  return { ...list, lines: [...frame(list.lines, { rows: listRows, cols: rect.cols }), ...hist] };
}

function agentList(s: ViewState, agents: AgentStatus[], rect: Rect, sel: number, focused: boolean, hits: Hits): { lines: string[]; from: number; shown: number } {
  const { g } = s;
  const h = rect.rows;
  // The selection stays in view; without one moved down, the newest agents are at the top.
  const from = Math.max(0, Math.min(sel - h + 1, agents.length - h));
  const over = agents.length > h && rect.cols > 6;
  const w = over ? rect.cols - 1 : rect.cols;
  const sb = over ? scrollbar(h, from, agents.length, h, g, focused) : [];
  hits.agentPage = Math.max(1, h - 1);
  const lines: string[] = [];
  for (let r = 0; r < h; r++) {
    const a = agents[from + r];
    if (!a) { lines.push(cell('', w) + (sb[r] ?? '')); continue; }
    hits.agents.push({ id: a.id, row: rect.top + r });
    lines.push(selectableRow(agentRow(s, a, Math.max(0, w - width(g.pointer) - 1)), w, g, focused && from + r === sel, focused) + (sb[r] ?? ''));
  }
  return { lines, from, shown: Math.min(h, agents.length - from) };
}

function agentRow(s: ViewState, a: AgentStatus, w: number): string {
  const { g } = s;
  const liveNow = live(a);
  const icon = liveNow ? c.warn(spinner(s)) : a.state === 'done' ? c.ok(g.check) : c.bad(g.cross);
  const where = a.cardId ? (a.taskId ? `${a.cardId}/${a.taskId}` : a.cardId) : 'run';
  const paint = liveNow ? c.text : c.muted;
  const head = `${icon} ${c.bold(plainText(a.id).padEnd(3))} ${roleColour[a.role](g[a.role] + ' ' + a.role.padEnd(8))} ${paint(plainText(where).padEnd(9))} ${c.muted(plainText(a.model ?? a.harness))} ${c.muted(fmtDuration((a.endedAt ?? s.now) - a.startedAt).padStart(5))} ${c.muted(`${a.turns}t`.padStart(4))}  `;
  const tail = liveNow ? c.text(plainText(a.lastMessage ?? a.state)) : c.muted(plainText(a.state === 'stalled' ? 'stalled' : (a.lastMessage ?? a.state)));
  return fit(head + fit(tail, Math.max(0, w - width(head))), w);
}

/** The selected agent's header and its recent history, wrapped, the newest at the bottom. Below the list, the header is a rule. */
function agentHistory(s: ViewState, a: AgentStatus, size: Size, rule = false): string[] {
  const { g } = s;
  if (size.rows <= 0 || size.cols <= 0) return [];
  const where = a.cardId ? (a.taskId ? `${a.cardId}/${a.taskId}` : a.cardId) : 'run';
  const elapsed = fmtDuration((a.endedAt ?? s.now) - a.startedAt);
  const title = `${roleColour[a.role](g[a.role])} ${c.bold(plainText(a.id))} ${roleColour[a.role](a.role)} ${c.muted(`${plainText(where)} · ${plainText(a.model ?? a.harness)} · ${a.state} · ${turns(a.turns)} · ${elapsed}${a.costUsd ? ` · ${fmtCost(a.costUsd)}` : ''}`)}`;
  const head = rule ? fit(`${c.border(repeat(g.h, 2))} ${title} ${c.border(repeat(g.h, size.cols))}`, size.cols, '') : fit(title, size.cols);
  const rows = a.history.flatMap((h) => hang(`${c.faint(g.bullet)} `, h, size.cols, c.text));

  const room = Math.max(0, size.rows - 1);
  return frame([head, ...rows.slice(Math.max(0, rows.length - room))], size);
}

// ---- log ----

function logHeading(s: ViewState, cols: number, scroll: number, zoomed: boolean): string {
  // How many entries wait below a log scrolled up.
  const right = scroll > 0 ? `${s.g.down}${scroll}` : '';
  return separator(s.g, cols, 'log', right ? c.muted(right) : '', s.focus === 'log');
}

/** A log line with its time muted; the text was made plain before it was cut. */
function styleNote(line: string): string {
  const m = /^(\d\d:\d\d:\d\d)(.*)$/.exec(line);
  return m ? c.muted(m[1]!) + c.text(m[2]!) : c.text(line);
}

/** One log entry wrapped to `w`: every line of it, the time once, continuation rows under the text. */
function noteRows(note: string, w: number): string[] {
  const ts = /^(\d\d:\d\d:\d\d) {2}/.exec(note);
  const indent = ts ? Math.min(10, Math.max(0, w - 1)) : 0;
  const body = ts ? note.slice(ts[0].length) : note;
  const rows: string[] = [];
  for (const part of body.split('\n')) {
    for (const r of softWrap(plainText(part), Math.max(1, w - indent))) {
      rows.push(rows.length === 0 && ts ? c.muted(cell(ts[1]!, indent)) + c.text(r) : repeat(' ', indent) + c.text(r));
    }
  }
  return rows;
}

/**
 * The log, the newest at the bottom. Unzoomed each entry is one row, cut; zoomed every entry is
 * wrapped whole. `logScroll` counts entries below the view, so new entries never move a view scrolled up.
 */
function logPane(s: ViewState, rect: Rect, wrapped: boolean): { lines: string[]; limits: Limits; scroll: number } {
  const { g } = s;
  const h = rect.rows;
  const n = s.notes.length;
  const over = n > h && rect.cols > 6;
  const w = over ? rect.cols - 1 : rect.cols;
  const bodyW = Math.max(1, w - 1);
  let lines: string[];
  let from: number;
  let end: number;
  let max: number;
  let page: number;
  if (!wrapped) {
    max = Math.max(0, n - h);
    end = n - Math.min(Math.max(0, s.logScroll), max);
    from = Math.max(0, end - h);
    lines = s.notes.slice(from, end).map((l) => ' ' + styleNote(fit(plainText(l), bodyW)));
    page = Math.max(1, h - 1);
  } else {
    // The furthest back the view goes: the first entries just fill it.
    let filled = 0;
    let k = 0;
    const head: string[] = [];
    while (k < n && filled < h) { const r = noteRows(s.notes[k]!, bodyW); head.push(...r); filled += r.length; k++; }
    max = filled >= h ? n - k : 0;
    const scroll = Math.min(Math.max(0, s.logScroll), max);
    end = n - scroll;
    if (scroll > 0 && scroll === max) {
      from = 0;
      lines = head.slice(0, h);
    } else {
      let rows: string[] = [];
      let i = end - 1;
      while (i >= 0 && rows.length < h) { rows = [...noteRows(s.notes[i]!, bodyW), ...rows]; i--; }
      from = i + 1;
      lines = rows.slice(Math.max(0, rows.length - h));
    }
    page = Math.max(1, end - from - 1);
    lines = lines.map((l) => ' ' + l);
  }
  const sb = over ? scrollbar(h, from, n, Math.max(1, end - from), g, s.focus === 'log') : [];
  const out = rowsOf(lines, h).map((l, r) => (sb.length ? exact(l, w) + (sb[r] ?? '') : l));
  return { lines: out, limits: { max, page }, scroll: n - end };
}

// ---- the plan's actions, the prompt and the footer ----

function actionsRow(s: ViewState, cols: number, row: number, hits: Hits): string {
  const focused = s.focus !== 'input';
  const chosen = s.review!.button;
  for (const short of [false, true]) {
    let line = ' ';
    const spans: Hits['buttons'] = [];
    PLAN_ACTIONS.forEach((a, i) => {
      const b = button(short ? a.short : a.label, focused && i === chosen, a.danger);
      if (i) line += ' ';
      spans.push({ id: a.id, row, from: width(line), to: width(line) + width(b) });
      line += b;
    });
    if (width(line) > cols && !short) continue;
    hits.buttons.push(...spans.filter((b) => b.from < cols).map((b) => ({ ...b, to: Math.min(b.to, cols) })));
    return fit(line, cols, '');
  }
  return '';
}

function promptLine(p: Prompt, cols: number, focused: boolean): { line: string; cursorCol: number } {
  const label = focused ? c.accent(c.bold(fit(plainText(p.label), Math.min(12, cols - 8)))) : c.muted(fit(plainText(p.label), Math.min(12, cols - 8)));
  const head = cols >= 12 ? ` ${label} ${c.muted('›')} ` : '';
  const headW = width(head);
  const avail = Math.max(1, cols - headW);
  const chars = [...plainText(p.text)];
  const rawCursor = Math.max(0, Math.min(p.cursor, [...p.text].length));
  const cursor = Math.min(chars.length, [...plainText([...p.text].slice(0, rawCursor).join(''))].length);
  // Slide the visible window so the cursor stays on screen.
  let from = 0;
  while (width(chars.slice(from, cursor).join('')) >= avail) from++;
  let visible = chars.slice(from).join('');
  if (width(visible) > avail) visible = fit(visible, avail, '');
  // The prediction belongs after what is typed: only show it with the cursor at the end of the line.
  const ghost = p.ghost && cursor === chars.length ? fit(p.ghost, Math.max(0, avail - width(visible)), '') : '';
  const placeholder = !chars.length && !ghost && p.placeholder ? c.faint(fit(plainText(p.placeholder), avail)) : '';
  return { line: head + visible + (ghost ? c.muted(ghost) : placeholder), cursorCol: headW + width(chars.slice(from, cursor).join('')) };
}

/** The plan review's reply holds text that was not sent: Dispatch would drop it, so Enter goes back to it instead. */
export function unsentReply(s: Pick<ViewState, 'review' | 'prompt'>): boolean {
  return Boolean(s.review && s.prompt?.text.trim());
}

interface Ranked extends Hint { p: number }
const h = (key: string, label: string, p: number): Ranked => ({ key, label, p });

/** The tab order: the review has the plan, the log and the reply; the board view adds the agents, and an open question. */
export function focusOrder(s: Pick<ViewState, 'review' | 'prompt' | 'phase' | 'board'>): Focus[] {
  if (planMode(s)) return s.prompt ? ['board', 'log', 'input'] : ['board', 'log'];
  return s.prompt ? ['board', 'agents', 'log', 'input'] : ['board', 'agents', 'log'];
}


/**
 * The footer: the few keys that matter for what has the keyboard now, as single words, and `? help`
 * for the rest (rank: lower stays longer on a narrow screen).
 */
export function footerHints(s: ViewState): { items: Ranked[]; note?: string } {
  const { g } = s;
  const enter = g.enter;
  const p = s.prompt;
  const help = h('?', 'help', 0.5);
  if (s.review) {
    if (p && s.focus === 'input') return { items: [h(enter, 'send', 0), ...(p.ghost ? [h('tab', 'take', 0.8)] : []), h('esc', 'plan', 1), help] };
    const a = PLAN_ACTIONS[s.review.button] ?? PLAN_ACTIONS[0]!;
    // With a reply typed and not sent, Enter goes back to it instead of dispatching.
    const what = a.id === 'dispatch' && unsentReply(s) ? 'reply' : a.key;
    return { items: [h(enter, what, 0), h('←→', 'action', 1), h('^c', 'backlog', 2), help] };
  }
  const items: Ranked[] = [];
  const zoomed = s.zoom !== undefined && s.zoom === s.focus;
  if (zoomed) items.push(h('z', 'unzoom', 0.3));
  const controls = s.controls ? controlsFor(s) : undefined;
  switch (s.focus) {
    case 'board':
      if (planMode(s)) items.push(h('↑↓', 'scroll', 0.4), h('^c', 'stop', 2));
      else if (s.open) items.push(h('esc', 'close', 0.4));
      else items.push(h(enter, 'open', 0.4));
      break;
    case 'agents': items.push(h(enter, 'card', 0.4)); break;
    case 'log': items.push(s.logScroll > 0 ? h('end', 'follow', 0.4) : h('↑↓', 'scroll', 0.4)); break;
    default: break;
  }
  if (controls) {
    if (controls.stop) items.push(h('x', 'stop', 1));
    if (controls.instruct) items.push(h('i', 'instruct', 1.2));
    if (!s.open) items.push(h('p', s.board.paused ? 'resume' : 'pause', 1.4));
  } else if (!planMode(s) && !zoomed) items.push(h('z', 'zoom', 1.5));
  return { items: [...items.slice(0, 4), help] };
}

function phaseLabel(s: ViewState): string {
  if (s.board.paused && !planMode(s)) return c.bar(c.warn(` ${s.g.pause} `) + c.warn.bold(plainText(s.phase)) + ' ');
  return barLabel(s.g.play, s.phase);
}

/**
 * The key bar, drawn as the app shell draws its own: the run's phase on the left (where a pushed page
 * shows its breadcrumb), then the keys left-aligned and `? help` last.
 */
function footerLine(s: ViewState, cols: number): string {
  const { items } = footerHints(s);
  const left = phaseLabel(s);
  const help = items.at(-1)!;
  let shown = items.slice(0, -1);
  const used = (xs: Ranked[]) => width(left) + 1 + [...xs, help].reduce((n, x) => n + width(keyHint(x.key, x.label)), 0);
  // Drop the least important keys until the rest fits, keeping their order.
  while (shown.length && used(shown) > cols) {
    const worst = shown.reduce((a, b) => (b.p > a.p ? b : a));
    shown = shown.filter((x) => x !== worst);
  }
  const line = left + c.bar(' ') + [...shown, help].map((x) => keyHint(x.key, x.label)).join('');
  return width(line) >= cols ? fit(line, cols, '') : line + c.bar(repeat(' ', cols - width(line)));
}

/** A help group with a short paragraph under its title (the kit's `HelpGroup.text`). */
export type HelpTopic = HelpGroup & { text?: string | string[] };

/**
 * Help for what is on screen: the focused pane or the review first, with what the screen leaves
 * unsaid, then the other keys. Keys stay within 9 cells and labels within 23, so the kit's two
 * columns show them whole from 80 columns up.
 */
export function helpGroups(s: ViewState): HelpTopic[] {
  const { g } = s;
  const enter = g.enter;
  const k = (key: string, label: string) => ({ key, label });
  const paging = [k('PgUp PgDn', 'a page at a time'), k('Home End', 'top / bottom')];
  const everywhere = (ctrlC: string): HelpTopic => ({ title: 'Everywhere', keys: [k('? F1', 'this help'), k('^c', ctrlC)] });
  if (s.review) {
    return [
      {
        title: 'Plan review',
        text: PLAN_ACTIONS.map((a) => `${a.label}: ${a.what}${a.id === 'cancel' ? ' (asks first)' : ''}.`).join(' '),
        keys: [
          k(enter, 'do the chosen action'),
          k('← →', 'choose an action'),
          k('type', 'reply to the planner'),
          k('↑ ↓', 'scroll the plan or log'),
          ...paging,
          k('tab', 'plan, log, reply'),
          ...(s.mouse ? [k('wheel', 'scrolls the pane'), k('click', 'an action or a pane')] : []),
        ],
      },
      {
        title: 'Reply',
        text: 'A reply typed and not sent keeps Enter on the plan from dispatching: it goes back to the reply.',
        keys: [k(enter, 'send; cancel asks first'), k('tab', 'complete the word'), k('↑ ↓', 'earlier replies'), k('esc', 'back, text kept')],
      },
      everywhere('keep the run for later'),
      {
        title: 'About',
        text: [
          'verify: the shell commands dulger runs in the card\'s worktree before each review; dispatching approves them. — means none: the reviewer judges by reading.',
          'new, changed, removed: what the last revision did to a card.',
          'Warnings: a card of more than three tasks makes a diff one reviewer cannot read; a card three others wait for (waiting) should be the least they need.',
        ],
        keys: [],
      },
    ];
  }
  const board: HelpTopic = planMode(s)
    ? { title: 'Plan', text: 'The planner is revising the plan.', keys: [k('↑ ↓', 'scroll the plan'), ...paging] }
    : s.open
      ? { title: 'Open card', keys: [k('↑ ↓', 'scroll the card'), ...paging, k(`esc ${enter}`, 'close it')] }
      : { title: 'Board', keys: [k('←→↑↓ hjkl', 'select a card'), k(enter, 'open the card'), k('PgUp PgDn', 'scroll the log'), k('Home End', 'oldest / newest log')] };
  const agents: HelpTopic = { title: 'Agents', keys: [k('↑ ↓', 'select an agent'), k(enter, 'open its card'), k('z', 'all agents, history')] };
  const log: HelpTopic = { title: 'Log', text: 'Scrolled up, new lines wait below; ↓ counts them.', keys: [k('↑ ↓', 'scroll; new lines wait'), k('Home End', 'oldest / follow newest'), k('z', 'every line, wrapped')] };
  const panes: HelpTopic = { title: 'Panes', keys: [
    k('tab', 'next pane'),
    k('shift-tab', 'the other way'),
    k('z', 'zoom the pane, and back'),
    k('esc', 'unzoom or close card'),
    ...(s.mouse ? [k('wheel', 'scrolls the pane')] : []),
    ...(s.mouse && !planMode(s) ? [k('click', 'select; again: open')] : []),
  ] };
  const ordered = s.focus === 'agents' && !planMode(s) ? [agents, board, log] : s.focus === 'log' ? [log, board, ...(planMode(s) ? [] : [agents])] : [board, ...(planMode(s) ? [] : [agents]), log];
  // The focused pane first, then what the run's own keys do, then the rest.
  const groups: HelpTopic[] = [ordered[0]!];
  if (s.controls) {
    const { stop, instruct } = controlsFor(s);
    groups.push({
      title: 'Run',
      text: 'x stops the card once you type stop: its work and worktree are kept and a retry continues it; a card that has not started does not start, nor do the cards waiting for it. Nothing is replanned. p pauses new cards while active ones finish; i gives the next worker attempt instructions (a call already running keeps its own).',
      keys: [
        k('p', s.board.paused ? 'resume new cards' : 'pause new cards'),
        ...(stop ? [k('x', 'stop (type stop)')] : []),
        ...(instruct ? [k('i', 'instruct next attempt')] : []),
      ],
    });
  }
  groups.push(...ordered.slice(1), panes, everywhere('stop agents, save board'));
  // What the approval dialog no longer says: it may appear at any time while cards run.
  groups.push({
    title: 'New verify commands',
    text: 'A replan brought shell commands nobody approved. dulger runs them in each card\'s worktree. Typing yes runs them and applies the replan; anything else drops it, and running cards carry on.',
    keys: [],
  });
  return groups;
}
