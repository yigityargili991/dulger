// All vertical space is allocated here. Prompt and navigation survive shrinking; optional
// sections appear only when they can show both a heading and content. Heights always sum to rows.
// `agents` and `log` count content rows; each shown one also has a heading row above it.
export interface Layout {
  header: number;
  gap: number;
  board: number;
  agents: number;
  log: number;
  /** The plan review's row of actions. */
  actions: number;
  prompt: number;
  footer: number;
}

export type Pane = 'board' | 'agents' | 'log';

export interface LayoutOptions {
  /** A prompt line is open. */
  prompt?: boolean;
  /** The plan review's action row. */
  actions?: boolean;
  /** Rows the main area (board, card or plan) would use. */
  boardLines: number;
  agentLines: number;
  /** Whether the agents section exists at all (the plan review leaves it out). */
  agents?: boolean;
  /** One pane takes every row between the header and the bottom rows. */
  zoom?: Pane;
  /** The most of the content the main area takes while a log is shown (default 2/3). */
  boardShare?: number;
  /**
   * Rows the log has. Given, a main area that wants more than its share (a plan that scrolls) also gets
   * the log rows that would stay empty; the log keeps a few, so new lines still show.
   */
  logLines?: number;
}

export const CARD_ROWS = 5;
/** The fewest log rows a main area that wants the log's empty ones leaves it. */
const LOG_KEPT = 3;
const MIN_COLUMN_WIDTH = 18;

export function compactBoard(cols: number, rows: number, columns: number): boolean {
  return Math.floor((cols - (columns - 1)) / columns) < MIN_COLUMN_WIDTH || rows < CARD_ROWS + 1;
}

export function layout(rows: number, o: LayoutOptions): Layout {
  let free = Math.max(0, rows);
  const take = (n: number) => { const used = Math.min(free, n); free -= used; return used; };
  const prompt = take(o.prompt ? 1 : 0);
  const footer = take(1);
  const header = take(1);
  // The actions are also keys (Enter, Ctrl-C), so the row gives way before the main area does.
  const actions = o.actions && free >= 3 ? take(1) : 0;
  const gap = free >= 12 ? take(1) : 0;
  const fixed = { header, gap, actions, prompt, footer };
  // A zoomed list keeps its heading; with no room for both it is drawn as the board would be.
  if (o.zoom === 'board' || (o.zoom && free < 2)) return { ...fixed, board: free, agents: 0, log: 0 };
  if (o.zoom === 'agents') return { ...fixed, board: 0, agents: free - 1, log: 0 };
  if (o.zoom === 'log') return { ...fixed, board: 0, agents: 0, log: free - 1 };
  // A board row has priority. Each secondary section needs a heading and at least one row.
  const list: Pane[] = o.agents === false ? ['log'] : ['agents', 'log'];
  const sections = Math.min(list.length, Math.floor(Math.max(0, free - 1) / 3));
  const shown = list.slice(0, sections);
  const content = free - sections;
  const agents = shown.includes('agents') ? Math.max(1, Math.min(o.agentLines, Math.floor(content / 3))) : 0;
  if (!shown.includes('log')) return { ...fixed, board: content - agents, agents, log: 0 };
  const cap = Math.max(1, Math.ceil(content * (o.boardShare ?? 2 / 3)));
  let board = Math.min(o.boardLines, Math.max(1, content - agents - 1), cap);
  if (o.logLines !== undefined && board < o.boardLines) {
    const share = content - agents - board;
    const log = Math.max(Math.min(LOG_KEPT, share), Math.min(share, o.logLines));
    board = Math.min(o.boardLines, content - agents - log);
  }
  return { ...fixed, board, agents, log: content - agents - board };
}
