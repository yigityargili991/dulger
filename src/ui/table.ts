// Live terminal view: kanban columns on top, one row per agent below.
// Redraws in place on a TTY; prints one log line per change otherwise.
import { bold, dim, red, green, yellow, cyan, magenta, cursor, pad, truncate, fmtDuration, fmtCost } from './ansi.ts';
import type { AgentStatus, Board, Card, CardStatus } from '../types.ts';

const COLUMNS: Array<{ title: string; statuses: CardStatus[] }> = [
  { title: 'BACKLOG', statuses: ['backlog'] },
  { title: 'IN PROGRESS', statuses: ['in_progress'] },
  { title: 'REVIEW', statuses: ['review'] },
  { title: 'DONE', statuses: ['done'] },
  { title: 'FAILED / BLOCKED', statuses: ['failed', 'blocked'] },
];

const colour: Record<CardStatus, (s: string) => string> = {
  backlog: dim, in_progress: yellow, review: magenta, done: green, failed: red, blocked: red,
};

function cardLabel(c: Card): string {
  const done = c.tasks.filter((t) => t.status === 'done').length;
  const progress = c.status === 'in_progress' ? ` ${done}/${c.tasks.length}` : '';
  const attempts = c.attempts > 0 ? ` (#${c.attempts + 1})` : '';
  return `${c.id} ${c.title}${progress}${attempts}`;
}

export function renderBoard(board: Board, width: number): string[] {
  const colWidth = Math.max(12, Math.floor((width - COLUMNS.length + 1) / COLUMNS.length));
  const cols = COLUMNS.map((col) => board.cards.filter((c) => col.statuses.includes(c.status)));
  const rows = Math.max(1, ...cols.map((c) => c.length));
  const lines: string[] = [];
  lines.push(COLUMNS.map((c) => bold(pad(truncate(c.title, colWidth - 1), colWidth))).join(' '));
  for (let r = 0; r < rows; r++) {
    lines.push(cols.map((cards) => {
      const c = cards[r];
      const text = c ? cardLabel(c) : r === 0 ? '-' : '';
      const cell = pad(truncate(text, colWidth - 1), colWidth);
      return c ? colour[c.status](cell) : dim(cell);
    }).join(' '));
  }
  return lines;
}

const stateColour: Record<AgentStatus['state'], (s: string) => string> = {
  starting: dim, running: yellow, done: green, failed: red, stalled: red,
};

export function renderAgents(statuses: Iterable<AgentStatus>, width: number, now = Date.now()): string[] {
  const all = [...statuses];
  // Running agents first, then the most recently finished ones; cap so the table fits.
  const running = all.filter((s) => s.state === 'starting' || s.state === 'running');
  const finished = all.filter((s) => !(s.state === 'starting' || s.state === 'running')).slice(-5);
  const rowsToShow = [...running, ...finished];
  const fixed = [6, 8, 10, 8, 6, 8, 12];
  const lastWidth = Math.max(10, width - fixed.reduce((a, b) => a + b + 1, 0));
  const head = ['AGENT', 'ROLE', 'CARD/TASK', 'STATE', 'TURNS', 'ELAPSED', 'TOOL', 'LAST'];
  const widths = [...fixed, lastWidth];
  const lines = [bold(head.map((h, i) => pad(h, widths[i]!)).join(' '))];
  if (rowsToShow.length === 0) lines.push(dim('(no agents yet)'));
  for (const s of rowsToShow) {
    const elapsed = fmtDuration((s.endedAt ?? now) - s.startedAt);
    const where = s.cardId ? (s.taskId ? `${s.cardId}/${s.taskId}` : s.cardId) : '-';
    const cells = [s.id, s.role, where, s.state, String(s.turns), elapsed, s.currentTool ?? '', s.lastMessage ?? ''];
    lines.push(cells.map((c, i) => {
      const cell = pad(truncate(c, widths[i]! - 1), widths[i]!);
      return i === 3 ? stateColour[s.state](cell) : cell;
    }).join(' '));
  }
  return lines;
}

export function renderHeader(board: Board, startedAt: number, width: number, now = Date.now()): string {
  const left = `${bold(cyan('usta'))}  run ${board.runId}   goal: `;
  const right = `   elapsed ${fmtDuration(now - startedAt)}   cost ${fmtCost(board.costUsd)}`;
  const goalWidth = Math.max(10, width - (left.length - 12) - right.length);
  return left + truncate(board.goal, goalWidth) + right;
}

export interface LiveView {
  update(): void;
  stop(): void;
  /** Print a message that survives redraws (goes above the live area / to the log). */
  note(msg: string): void;
}

export function createLiveView(getBoard: () => Board, getAgents: () => Iterable<AgentStatus>, opts: { intervalMs?: number; out?: NodeJS.WriteStream } = {}): LiveView {
  const out = opts.out ?? process.stdout;
  const startedAt = Date.now();
  const isTTY = Boolean(out.isTTY);
  const notes: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let lastHeight = 0;

  const frame = (): string => {
    const width = Math.max(60, out.columns ?? 100);
    const lines = [
      renderHeader(getBoard(), startedAt, width),
      '',
      ...renderBoard(getBoard(), width),
      dim('─'.repeat(width)),
      ...renderAgents(getAgents(), width),
    ];
    if (notes.length) lines.push(dim('─'.repeat(width)), ...notes.slice(-6).map(dim));
    return lines.join('\n');
  };

  const draw = () => {
    if (!isTTY) return;
    const text = frame();
    const height = text.split('\n').length;
    // Move to the top of the previous frame and overwrite it; clear the rest if it shrank.
    out.write((lastHeight ? `\x1b[${lastHeight}A` : '') + '\r' + text.split('\n').map((l) => cursor.clearLine + '\r' + l).join('\n') + '\n' + cursor.clearToEnd);
    lastHeight = height;
  };

  if (isTTY) {
    out.write(cursor.hide);
    timer = setInterval(draw, opts.intervalMs ?? 500);
    draw();
  }

  return {
    update() { if (isTTY) draw(); },
    stop() {
      if (timer) clearInterval(timer);
      if (isTTY) { draw(); out.write(cursor.show); }
    },
    note(msg) {
      const line = `${dim(new Date().toISOString().slice(11, 19))} ${msg}`;
      if (isTTY) { notes.push(line); draw(); } else out.write(line + '\n');
    },
  };
}
