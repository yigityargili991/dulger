// Pure rendering for the full-screen view: given the board, the agents and the UI state, produce one
// frame of lines. Nothing here touches the terminal, so the layout can be tested with plain strings.
import type { AgentStatus, Board, Card, CardStatus, Task } from '../types.ts';
import { fmtCost, fmtDuration, fmtSpend, fmtTokens } from '../ui/ansi.ts';
import { usageTokens } from '../usage.ts';
import { P, c, role as roleColour, segments, status as statusColour, window as windowColour, type Glyphs } from './theme.ts';
import { layout, compactBoard, CARD_ROWS } from './layout.ts';
import { bar, cell, fit, plainText, repeat, spread, width, wrap } from './text.ts';

export interface Prompt { label: string; text: string; cursor: number; hint: string }

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
  /** Lines scrolled up from the bottom of the log. */
  logScroll: number;
  focus: 'board' | 'input';
  prompt?: Prompt;
}

export interface Frame { lines: string[]; cursor?: { row: number; col: number }; compact: boolean }

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

export function render(s: ViewState): Frame {
  const { rows, cols, g } = s;
  const agentRows = agentLines(s);
  const openCard = s.open ? s.board.cards.find((k) => k.id === s.open) : undefined;
  const boardBody = openCard ? cardDetail(s, openCard, Math.max(1, cols - 2)) : undefined;
  const needed = boardBody ? boardBody.length : 1 + Math.max(1, ...columns(s.board).map((col) => col.cards.length)) * CARD_ROWS;
  const areas = layout(rows, Boolean(s.prompt), needed, agentRows.length);
  const boardH = areas.board;
  const lines: string[] = [];
  if (areas.header) lines.push(statusBar(s));
  if (areas.gap) lines.push('');
  if (boardBody && boardH) {
    const maxScroll = Math.max(0, boardBody.length - boardH);
    const from = Math.min(s.openScroll, maxScroll);
    const shown = boardBody.slice(from, from + boardH).map((l) => ' ' + l);
    if (from > 0) shown[0] = spread(shown[0]!, c.muted(`${g.up} ${from} more `), cols);
    if (from < maxScroll) shown[shown.length - 1] = spread(shown[shown.length - 1]!, c.muted(`${g.down} ${maxScroll - from} more `), cols);
    lines.push(...pad(shown, boardH));
  } else if (boardH) {
    lines.push(...boardPane(s, boardH));
  }
  const running = s.agents.filter((a) => a.state === 'running' || a.state === 'starting').length;
  if (areas.agents) {
    lines.push(separator(g, cols, `agents ${running ? c.warn(`${running} running`) : c.muted('idle')}`));
    lines.push(...pad(agentRows.slice(0, areas.agents), areas.agents));
  }
  if (areas.log) {
    lines.push(separator(g, cols, `log${s.logScroll ? c.muted(` ${g.up} ${s.logScroll}`) : ''}`));
    lines.push(...logPane(s, areas.log));
  }
  let cursor: Frame['cursor'];
  if (s.prompt && areas.prompt) {
    const p = promptLine(s.prompt, cols);
    lines.push(p.line);
    if (s.focus === 'input') cursor = { row: lines.length - 1, col: p.cursorCol };
  }
  if (areas.footer) lines.push(bottomBar(s));
  return { lines: pad(lines, rows).map((line) => fit(line, cols)), cursor, compact: compactBoard(cols, boardH, columns(s.board).length) };
}

function pad(lines: string[], n: number): string[] {
  const out = lines.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

function separator(g: Glyphs, cols: number, label: string): string {
  const head = c.border(repeat(g.h, 3)) + ' ' + label + ' ';
  return head + c.border(repeat(g.h, Math.max(0, cols - width(head))));
}

// ---- status bar ----

function statusBar(s: ViewState): string {
  const { board, g, cols } = s;
  const left = segments([
    { text: `${g.branch} dulger`, bg: P.mauve, fg: P.base, bold: true },
    { text: plainText(board.runId), bg: P.surface1, fg: P.text },
  ], g.sep, 'right');
  const rightItems = [
    { text: `${g.clock} ${fmtDuration(s.now - s.startedAt)}`, bg: P.surface0, fg: P.subtext0 },
    { text: `${g.coin} ${spendText(board)}`, bg: P.surface1, fg: P.text },
  ];
  if (board.rateLimits) rightItems.push({ text: windowsText(board), bg: P.surface2, fg: P.text });
  const right = segments(rightItems, g.sepLeft, 'left');
  const goalW = cols - width(left) - width(right) - 3;
  const goal = goalW > 8 ? ' ' + c.muted(fit(plainText(board.goal), goalW)) : '';
  return spread(left + goal, right, cols);
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

function boardPane(s: ViewState, height: number): string[] {
  const { cols, g } = s;
  if (s.board.cards.length === 0) {
    const msg = `${c.accent(spinner(s))} ${c.muted(`${plainText(s.phase)}…`)}`;
    const line = repeat(' ', Math.max(0, Math.floor((cols - width(msg)) / 2))) + msg;
    return pad(['', line], height);
  }
  const colsList = columns(s.board);
  const n = colsList.length;
  const colW = Math.floor((cols - (n - 1)) / n);
  if (compactBoard(cols, height, n)) {
    const cards = colsList.flatMap((col) => col.cards);
    const selected = cards.findIndex((card) => card.id === s.selected);
    const from = Math.max(0, selected - height + 1);
    return pad(cards.slice(from, from + height).map((card) => {
      const label = `${cardIcon(s, card)} ${plainText(card.id)} ${plainText(card.title)} · ${card.status.replace('_', ' ')}`;
      return fit(card.id === s.selected ? c.selected(label) : label, cols);
    }), height);
  }
  const perCol = Math.max(1, Math.floor((height - 1) / CARD_ROWS));
  const grid: string[][] = colsList.map((col) => {
    const sel = col.cards.findIndex((k) => k.id === s.selected);
    const from = sel >= perCol ? sel - perCol + 1 : 0;
    const shown = col.cards.slice(from, from + perCol);
    const count = statusColour[col.statuses[0]!](String(col.cards.length));
    const head = c.bold(c.muted(col.title)) + ' ' + count;
    const more = col.cards.length - from - shown.length;
    const scrolled = from > 0 ? c.muted(`${g.up}${from}`) : '';
    const lines = [spread(head, scrolled, colW)];
    for (const card of shown) lines.push(...cardBox(s, card, colW));
    if (more > 0) lines[lines.length - 1] = spread(c.muted(` ${g.down} ${more} more`), '', colW);
    return lines;
  });
  const out: string[] = [];
  for (let r = 0; r < height; r++) out.push(grid.map((col) => cell(col[r] ?? '', colW)).join(' '));
  return out;
}

function agentFor(s: ViewState, card: Card): AgentStatus | undefined {
  const mine = s.agents.filter((a) => a.cardId === card.id);
  return mine.find((a) => a.state === 'running' || a.state === 'starting') ?? mine.at(-1);
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

/** Five rows: border, title, state line, agent line, border. */
function cardBox(s: ViewState, card: Card, w: number): string[] {
  const { g } = s;
  const inner = w - 2;
  const selected = card.id === s.selected;
  const edge = selected ? c.selected : c.border;
  const title = `${cardIcon(s, card)} ${c.bold(plainText(card.id))} ${plainText(card.title)}`;
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
    case 'review': return statusColour.review(`review · round ${card.attempts + 1}`);
    case 'done': return c.ok(fmtSpend(card));
    case 'failed': case 'blocked': return c.bad(plainText(card.reason ?? card.feedback.at(-1) ?? card.status));
    case 'replaced': return c.faint('replaced by a replan');
  }
}

function agentLine(s: ViewState, card: Card): string {
  const a = agentFor(s, card);
  switch (card.status) {
    case 'in_progress': case 'review':
      return a ? roleColour[a.role](s.g[a.role]) + ' ' + c.muted(plainText(a.lastMessage ?? a.state)) : '';
    case 'done': return c.muted(plainText(card.review ?? card.summary ?? ''));
    case 'failed': case 'blocked': return c.muted(`${card.attempts} attempt${card.attempts === 1 ? '' : 's'} · ${fmtSpend(card)}`);
    default: return card.reviewNotes?.length ? c.warn(`${s.g.note} ${plainText(card.reviewNotes.at(-1) ?? '')}`) : '';
  }
}

// ---- open card ----

function cardDetail(s: ViewState, card: Card, w: number): string[] {
  const { g } = s;
  const out: string[] = [];
  const right = `${statusColour[card.status](card.status.replace('_', ' '))} ${c.muted(`· attempt ${card.attempts + 1} · ${fmtSpend(card)}`)}`;
  out.push(spread(`${cardIcon(s, card)} ${c.bold(plainText(card.id))} ${c.bold(plainText(card.title))}`, right, w));
  out.push(...wrap(card.description, w, 4).map((l) => c.muted(l)));
  if (card.dependsOn.length) out.push(c.muted(`after ${plainText(card.dependsOn.join(', '))}`));
  out.push('');

  const half = w < 50 ? w : Math.floor((w - 2) / 2);
  const left = [c.accent('Acceptance'), ...card.acceptanceCriteria.map((a) => `${c.muted(g.bullet)} ${fit(plainText(a), half - 2)}`)];
  if (card.acceptanceCriteria.length === 0) left.push(c.faint('none given'));
  const rightCol = [c.accent('Tasks')];
  for (const t of card.tasks) {
    const a = s.agents.filter((x) => x.taskId === t.id && x.cardId === card.id).at(-1);
    const tag = t.kind === 'fix' ? c.warn('fix ') : '';
    const meta = a && t.status === 'running' ? c.muted(` ${plainText(a.id)} · ${a.turns}t · ${fmtDuration(s.now - a.startedAt)}`) : a ? c.faint(` ${plainText(a.id)}`) : '';
    rightCol.push(spread(`${taskIcon(s, t)} ${tag}${c.bold(plainText(t.id))} ${plainText(t.title)}`, meta, half));
    if (t.status === 'running' && a?.lastMessage) rightCol.push(c.muted(`  ${fit(plainText(a.lastMessage), half - 2)}`));
    else if (t.status === 'done' && t.result?.summary) rightCol.push(c.faint(`  ${fit(plainText(t.result.summary), half - 2)}`));
  }
  if (w < 50) out.push(...left, '', ...rightCol);
  else for (let i = 0; i < Math.max(left.length, rightCol.length); i++) out.push(cell(left[i] ?? '', half) + '  ' + cell(rightCol[i] ?? '', half));

  if (card.verification?.length) {
    out.push('');
    out.push(c.accent('Verification'));
    for (const r of card.verification) out.push(fit(`${r.ok ? c.ok(g.check) : c.bad(g.cross)} ${plainText(r.command)}${r.ok ? '' : c.bad(` exit ${r.exitCode}`)} ${c.muted(`${(r.durationMs / 1000).toFixed(1)}s`)}`, w));
  }
  if (card.reason || card.feedback.length || card.reviewNotes?.length || card.review) {
    out.push('');
    out.push(c.accent('Review'));
    if (card.reason) out.push(...wrap(card.reason, w - 2).map((l, i) => (i ? '  ' : `${c.bad(g.warn)} `) + c.bad(l)));
    for (const f of card.feedback) out.push(...wrap(f, w - 2).map((l, i) => (i ? '  ' : `${c.bad(g.warn)} `) + c.bad(l)));
    for (const n of card.reviewNotes ?? []) out.push(...wrap(n, w - 2).map((l, i) => (i ? '  ' : `${c.warn(g.note)} `) + c.warn(l)));
    if (card.review) out.push(...wrap(card.review, w).map((l) => c.muted(l)));
  }

  const a = agentFor(s, card);
  if (a) {
    out.push('');
    const elapsed = fmtDuration((a.endedAt ?? s.now) - a.startedAt);
    out.push(`${roleColour[a.role](g[a.role])} ${c.bold(plainText(a.id))} ${roleColour[a.role](a.role)} ${c.muted(`· ${a.state} · ${a.turns} turns · ${elapsed}${a.costUsd ? ` · ${fmtCost(a.costUsd)}` : ''}`)}`);
    for (const h of a.history.slice(-8)) out.push(c.muted(`  ${fit(plainText(h), w - 2)}`));
  }
  return out;
}

// ---- agents ----

function agentLines(s: ViewState): string[] {
  const { g, cols } = s;
  const live = s.agents.filter((a) => a.state === 'running' || a.state === 'starting');
  const past = s.agents.filter((a) => !(a.state === 'running' || a.state === 'starting')).slice(-8).reverse();
  const lines: string[] = [];
  for (const a of [...live, ...past]) {
    const liveNow = a.state === 'running' || a.state === 'starting';
    const icon = liveNow ? c.warn(spinner(s)) : a.state === 'done' ? c.ok(g.check) : c.bad(g.cross);
    const where = a.cardId ? (a.taskId ? `${a.cardId}/${a.taskId}` : a.cardId) : 'run';
    const paint = liveNow ? c.text : c.muted;
    const head = `${icon} ${c.bold(plainText(a.id).padEnd(3))} ${roleColour[a.role](g[a.role] + ' ' + a.role.padEnd(7))} ${paint(plainText(where).padEnd(9))} ${c.muted(plainText(a.model ?? a.harness))} ${c.muted(fmtDuration((a.endedAt ?? s.now) - a.startedAt).padStart(5))} ${c.muted(`${a.turns}t`.padStart(4))}  `;
    const tail = liveNow ? c.text(plainText(a.lastMessage ?? a.state)) : c.muted(plainText(a.state === 'stalled' ? 'stalled' : (a.lastMessage ?? a.state)));
    lines.push(head + fit(tail, cols - width(head)));
  }
  if (lines.length === 0) lines.push(c.faint('  no agents yet'));
  return lines;
}

// ---- log ----

function logPane(s: ViewState, height: number): string[] {
  const end = Math.max(0, s.notes.length - s.logScroll);
  const shown = s.notes.slice(Math.max(0, end - height), end);
  return pad(shown.map((l) => ' ' + fit(plainText(l), s.cols - 1)), height);
}

// ---- prompt and key hints ----

function promptLine(p: Prompt, cols: number): { line: string; cursorCol: number } {
  const head = cols >= 12 ? ` ${c.accent(c.bold(fit(plainText(p.label), Math.min(12, cols - 8))))} ${c.muted('›')} ` : '';
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
  return { line: head + visible, cursorCol: headW + width(chars.slice(from, cursor).join('')) };
}

function bottomBar(s: ViewState): string {
  const { g, cols } = s;
  const key = (k: string, what: string) => `${c.key(` ${k} `)}${c.keyText(`${what} `)}`;
  let hints: string;
  if (s.prompt && s.focus === 'input') {
    hints = key('tab', 'board') + key('↑↓', 'history') + c.keyText(` ${plainText(s.prompt.hint)}`);
  } else if (s.open) {
    hints = key('↑↓', 'scroll') + key('esc', 'back') + (s.prompt ? key('tab', 'prompt') : key('^c', 'stop'));
  } else {
    hints = key('←→↑↓', 'select') + key(g.enter, 'open') + key('pgup/dn', 'log') + (s.prompt ? key('tab', 'prompt') : key('^c', 'stop'));
  }
  const phase = c.bar(c.accent(` ${g.play} `) + c.text(plainText(s.phase)) + ' ');
  const gap = cols - width(phase) - width(hints) - 1;
  if (gap < 0) return fit(phase + hints, cols, '');
  return phase + c.bar(repeat(' ', gap)) + hints + c.bar(' ');
}
