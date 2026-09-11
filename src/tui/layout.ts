// All vertical space is allocated here. Prompt and navigation survive shrinking; optional
// sections appear only when they can show both a heading and content. Heights always sum to rows.
export interface Layout {
  header: number;
  gap: number;
  board: number;
  agents: number;
  log: number;
  prompt: number;
  footer: number;
}

export const CARD_ROWS = 5;
const MIN_COLUMN_WIDTH = 18;

export function compactBoard(cols: number, rows: number, columns: number): boolean {
  return Math.floor((cols - (columns - 1)) / columns) < MIN_COLUMN_WIDTH || rows < CARD_ROWS + 1;
}

export function layout(rows: number, hasPrompt: boolean, boardLines: number, agentLines: number): Layout {
  let free = Math.max(0, rows);
  const take = (n: number) => { const used = Math.min(free, n); free -= used; return used; };
  const prompt = take(hasPrompt ? 1 : 0);
  const footer = take(1);
  const header = take(1);
  const gap = free >= 12 ? take(1) : 0;
  // A board row has priority. Each secondary section needs a heading and at least one row.
  const sections = Math.min(2, Math.floor(Math.max(0, free - 1) / 3));
  const content = free - sections;
  const agents = sections >= 1 ? Math.max(1, Math.min(agentLines, Math.floor(content / 3))) : 0;
  const board = Math.min(boardLines, Math.max(free ? 1 : 0, content - agents - (sections === 2 ? 1 : 0)), Math.max(1, Math.ceil(content * 2 / 3)));
  const log = sections === 2 ? content - agents - board : 0;
  return { header, gap, board: sections < 2 ? content - agents : board, agents, log, prompt, footer };
}
