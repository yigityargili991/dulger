// Drawing pieces shared by the Runs tab and the result review: the run list with columns, the cards
// table (a failed card carries its reason on a second line), labelled facts, and an error state.
// How a run's state and a card's status look comes from the app's shared look (src/app/look.ts).
//
// The run list keeps the kit's list state and key reducer and only draws its rows in columns that
// give way one by one as the width shrinks, so filtering, paging and the wheel behave like the kit's.
import type { ChalkInstance } from 'chalk';
import type { Mouse, Key } from '../../tui/screen.ts';
import { c, type Glyphs } from '../../tui/theme.ts';
import { cell, fit, plainText, repeat, width, wrapParagraphs } from '../../tui/text.ts';
import {
  colourless, columnWidths, follow, followRange, frame, highlight, listFilterLine, onBackground, selectableRow, shownItems,
  type ListState, type Size, type TableColumn,
} from '../../tui/kit/index.ts';
import type { RunSummary } from '../../runs.ts';
import type { Card } from '../../types.ts';
import { cardLook, statusLook } from '../look.ts';
import { age, cardReason, cardTries, shortSpend } from './runs.data.ts';

export { cardLook, statusLook, type Look, type RunState } from '../look.ts';

// ---- the run list ----

export interface RunRow { summary: RunSummary; running: boolean }

/**
 * Runs as rows of columns: status glyph (every state has its own), goal, cards done/total, spend, age;
 * no header. When narrow the spend goes first, then the age, the cards. Keeps the list's scroll bookkeeping.
 */
export function renderRunList(s: ListState, rows: Map<string, RunRow>, size: Size, g: Glyphs, o: { focused: boolean; now: number }): string[] {
  const { rows: h, cols } = size;
  if (h <= 0 || cols <= 0) return frame([], size);
  const shown = shownItems(s);
  s.index = Math.max(0, Math.min(s.index, shown.length - 1));
  const lines: string[] = [];
  if ((s.filtering || s.query) && h >= 2) lines.push(listFilterLine(s, cols, g));
  s.offset = lines.length;
  const height = Math.max(0, h - lines.length);
  s.height = Math.max(1, height);
  s.top = follow(s.top, s.index, s.height, shown.length);
  if (!shown.length && height > 0) {
    lines.push('  ' + c.muted(fit(s.query ? `No matches for "${plainText(s.query)}"` : s.empty, Math.max(0, cols - 2))));
    return frame(lines, size);
  }

  const pw = width(g.pointer) + 1;
  const w = Math.max(0, cols - pw);
  const data = shown.map((r) => rows.get(r.item.id));
  const look = (d: RunRow | undefined) => statusLook(d?.summary.readable ? d.summary.status : 'unreadable', g, d?.running);
  const cardsText = (d: RunRow | undefined) => (d?.summary.readable ? (d.summary.cards.total ? `${d.summary.cards.done}/${d.summary.cards.total}` : '-') : '');
  const spendText = (d: RunRow | undefined) => (d?.summary.readable ? shortSpend(d.summary) : '');
  const ageText = (d: RunRow | undefined) => (d?.summary.readable ? age(d.summary.createdAt, o.now) : '');
  const widest = (f: (d: RunRow | undefined) => string) => Math.max(0, ...data.map((d) => width(f(d))));
  const glyphW = Math.max(1, ...data.map((d) => width(look(d).glyph)));
  const cardsW = widest(cardsText);
  const spendW = widest(spendText);
  const ageW = widest(ageText);
  // Most to least: the goal keeps room to tell runs apart before the spend goes, then the age, the cards.
  const plans = [
    { spend: true, age: true, cards: true, goal: 24 },
    { spend: false, age: true, cards: true, goal: 16 },
    { spend: false, age: false, cards: true, goal: 10 },
    { spend: false, age: false, cards: false, goal: 0 },
  ];
  const used = (p: typeof plans[number]) => glyphW + 2
    + (p.cards && cardsW ? cardsW + 2 : 0) + (p.spend && spendW ? spendW + 2 : 0) + (p.age && ageW ? ageW + 2 : 0);
  const plan = plans.find((p) => w - used(p) >= p.goal) ?? plans.at(-1)!;
  const goalW = Math.max(0, w - used(plan));

  for (let r = 0; r < height && s.top + r < shown.length; r++) {
    const i = s.top + r;
    const row = shown[i]!;
    const d = data[i];
    const selected = i === s.index;
    const lk = look(d);
    let body = lk.paint(cell(lk.glyph, glyphW)) + '  ';
    if (d?.summary.readable) {
      const base = selected ? c.text.bold : c.text;
      const goal = plainText(d.summary.goal);
      body += cell(highlight(fit(goal, goalW), row.positions, base, (t) => c.match(t)), goalW);
    } else {
      // The board's error is on the run's own pane.
      body += cell((selected ? c.muted.bold : c.muted)(plainText(row.item.id)), goalW);
    }
    const right = (text: string, w2: number, paint: ChalkInstance) => `  ${paint(repeat(' ', w2 - width(text)) + text)}`;
    if (plan.cards && cardsW) body += right(cardsText(d), cardsW, d?.summary.readable && d.summary.cards.failed ? c.bad : c.subtle);
    if (plan.spend && spendW) body += right(spendText(d), spendW, c.muted);
    if (plan.age && ageW) body += right(ageText(d), ageW, c.muted);
    lines.push(selectableRow(body, cols, g, selected, o.focused));
  }
  return frame(lines, size);
}

/** How wide the run list wants to be: every run's glyph, whole goal, cards, spend and age, with the pointer. */
export function runListWidth(s: ListState, rows: Map<string, RunRow>, g: Glyphs, now: number): number {
  const data = s.items.map((it) => rows.get(it.id));
  const widest = (f: (d: RunRow) => string) => Math.max(0, ...data.map((d) => (d ? width(f(d)) : 0)));
  const glyphW = Math.max(1, ...data.map((d) => width(statusLook(d?.summary.readable ? d.summary.status : 'unreadable', g, d?.running).glyph)));
  const goalW = widest((d) => plainText(d.summary.readable ? d.summary.goal : d.summary.id));
  const cardsW = widest((d) => (d.summary.readable ? (d.summary.cards.total ? `${d.summary.cards.done}/${d.summary.cards.total}` : '-') : ''));
  const spendW = widest((d) => (d.summary.readable ? shortSpend(d.summary) : ''));
  const ageW = widest((d) => (d.summary.readable ? age(d.summary.createdAt, now) : ''));
  return width(g.pointer) + 1 + glyphW + 2 + goalW + [cardsW, spendW, ageW].reduce((n, w) => n + (w ? w + 2 : 0), 0);
}

// ---- the cards table ----

export interface CardTable {
  cards: Card[];
  index: number;
  /** First visual row in view (a card with a reason takes two). */
  top: number;
  height: number;
  /** Rows above the first card row (none since the header went; kept for the mouse). */
  offset: number;
  /** Visual row → card index, from the last render. */
  map: number[];
}

export function createCardTable(): CardTable {
  return { cards: [], index: 0, top: 0, height: 1, offset: 0, map: [] };
}

export function setCards(t: CardTable, cards: Card[], reset: boolean): void {
  const keep = t.cards[t.index]?.id;
  t.cards = cards;
  const i = reset || keep === undefined ? -1 : cards.findIndex((x) => x.id === keep);
  t.index = i >= 0 ? i : 0;
  if (reset) t.top = 0;
}

// No header: state glyph, id, title, tries and spend read as what they are. The status is its glyph
// (the word is in `?`); tries show only past the first round, as `×2`, so the number says what it is.
// Titles are empty so columns are as wide as their values.
const COLUMNS: TableColumn[] = [
  { title: '' },
  { title: '' },
  { title: '', flex: 1, min: 8 },
  { title: '', align: 'right', optional: true },
  { title: '', align: 'right', optional: true },
];

/** `×2` once a card took more than one round; nothing for one round or none. */
function triesText(card: Card): string {
  const n = cardTries(card);
  return n !== undefined && n > 1 ? `×${n}` : '';
}

function cardCells(t: CardTable, g: Glyphs): string[][] {
  return t.cards.map((card) => [cardLook(card, g).glyph, card.id, card.title, triesText(card), shortSpend(card)].map((x) => plainText(x)));
}

/** How wide the cards table wants to be: each column at its widest value (titles whole), and the pointer. */
export function cardTableWidth(t: CardTable, g: Glyphs): number {
  const cells = cardCells(t, g);
  if (!cells.length) return width(g.pointer) + 1 + width('No cards');
  const widths = COLUMNS.map((_, i) => Math.max(0, ...cells.map((cl) => width(cl[i]!))));
  const pw = width(g.pointer) + 1;
  // A card's reason sits under its title, from the title's column: room for its first line too, up to
  // 40 cells (a longer one is cut, so the run list beside keeps its room; the card has it whole).
  const titleAt = pw + widths.slice(0, 2).reduce((n, w) => n + (w ? w + 2 : 0), 0);
  const reasons = t.cards.map((card) => cardReason(card)).filter((x): x is string => Boolean(x)).map((r) => Math.min(40, width(plainText(r.split('\n').find((l) => l.trim()) ?? r))));
  return Math.max(pw + widths.reduce((n, w) => n + w, 0) + 2 * Math.max(0, widths.filter((w) => w > 0).length - 1), ...reasons.map((w) => titleAt + w));
}

/** Rows the cards take: one each, and one more under a card that did not land and says why. */
export function cardTableRows(t: CardTable): number {
  return Math.max(1, t.cards.length + t.cards.filter((card) => cardReason(card)).length);
}

export function renderCardTable(t: CardTable, size: Size, g: Glyphs, o: { focused: boolean }): string[] {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return frame([], size);
  const pw = width(g.pointer) + 1;
  const cells = cardCells(t, g);
  const widths = columnWidths(COLUMNS, cells.map((cl, i) => ({ id: String(i), cells: cl })), Math.max(0, cols - pw));
  const join = (parts: string[]) => parts.filter((_, i) => widths[i]! > 0).join('  ');
  const align = (text: string, i: number) => {
    const w = widths[i]!;
    const cut = fit(text, w);
    const pad = repeat(' ', Math.max(0, w - width(cut)));
    return COLUMNS[i]!.align === 'right' ? pad + cut : cut + pad;
  };
  const out: string[] = [];
  t.offset = out.length;
  const height = Math.max(0, rows - out.length);
  t.height = Math.max(1, height);
  if (!t.cards.length) {
    if (height) out.push(repeat(' ', pw) + c.muted(fit('No cards', Math.max(0, cols - pw))));
    t.map = [];
    return frame(out, size);
  }
  t.index = Math.max(0, Math.min(t.index, t.cards.length - 1));
  // Visual rows: each card, and its reason under the title when it did not land.
  const visual: Array<{ card: number; reason?: string }> = [];
  t.cards.forEach((card, i) => {
    visual.push({ card: i });
    const why = cardReason(card);
    if (why && widths[2]! > 0) visual.push({ card: i, reason: why.split('\n').find((l) => l.trim()) ?? why });
  });
  const first = visual.findIndex((v) => v.card === t.index);
  const last = first + (visual[first + 1]?.card === t.index ? 1 : 0);
  t.top = followRange(t.top, first, last + 1, t.height, visual.length);
  t.map = visual.map((v) => v.card);
  const titleAt = pw + widths.slice(0, 2).reduce((n, w) => n + (w ? w + 2 : 0), 0);
  for (let r = 0; r < height && t.top + r < visual.length; r++) {
    const v = visual[t.top + r]!;
    const card = t.cards[v.card]!;
    const selected = v.card === t.index;
    const lk = cardLook(card, g);
    const faded = card.status === 'replaced';
    if (v.reason !== undefined) {
      const paint = card.status === 'failed' ? c.bad : faded ? c.faint : lk.paint;
      const line = cell(repeat(' ', titleAt) + paint(fit(plainText(v.reason), Math.max(0, cols - titleAt))), cols);
      out.push(selected && o.focused && !colourless() ? onBackground(line, cols, c.bg) : line);
      continue;
    }
    const cl = cells[v.card]!;
    const strong = (p: ChalkInstance) => (selected ? p.bold : p);
    const parts = [
      (faded ? c.faint : lk.paint)(align(cl[0]!, 0)),
      strong(faded ? c.faint : c.text)(align(cl[1]!, 1)),
      strong(faded ? c.faint : c.text)(align(cl[2]!, 2)),
      c.muted(align(cl[3]!, 3)),
      c.muted(align(cl[4]!, 4)),
    ];
    out.push(selectableRow(join(parts), cols, g, selected, o.focused));
  }
  return frame(out, size);
}

export function cardTableKey(t: CardTable, k: Key): boolean {
  const last = t.cards.length - 1;
  const to = (i: number) => { t.index = Math.max(0, Math.min(last, i)); return true; };
  const page = Math.max(1, Math.floor(t.height / 2));
  switch (k.name) {
    case 'up': return to(t.index - 1);
    case 'down': return to(t.index + 1);
    case 'pageup': return to(t.index - page);
    case 'pagedown': return to(t.index + page);
    case 'home': return to(0);
    case 'end': return to(last);
    case 'char':
      if (k.ch === 'j') return to(t.index + 1);
      if (k.ch === 'k') return to(t.index - 1);
      if (k.ch === 'g') return to(0);
      if (k.ch === 'G') return to(last);
      return false;
    default: return false;
  }
}

/** Relative to the table's top-left cell; 'activate' for a click on the selected card. */
export function cardTableMouse(t: CardTable, m: Mouse): boolean | 'activate' {
  if (m.kind === 'wheel-up' || m.kind === 'wheel-down') {
    t.index = Math.max(0, Math.min(t.cards.length - 1, t.index + (m.kind === 'wheel-up' ? -1 : 1)));
    return true;
  }
  if (m.kind !== 'press' || m.button !== 'left') return false;
  const v = t.map[t.top + m.row - t.offset];
  if (m.row < t.offset || v === undefined) return false;
  if (v === t.index) return 'activate';
  t.index = v;
  return true;
}

// ---- facts and actions ----

export interface Fact { label: string; value: string; paint?: ChalkInstance; /** Trusted, styled: drawn before the value. */ glyph?: string }

/** `Label    value`, the value wrapped under itself, a long word (a path) broken across rows, never cut. Values are plain text (sanitized here). */
export function factLines(facts: Fact[], w: number): string[] {
  const labelW = Math.min(14, Math.max(0, ...facts.map((f) => width(f.label))) + 2);
  const out: string[] = [];
  for (const f of facts) {
    const gw = f.glyph ? width(f.glyph) + 1 : 0;
    const room = Math.max(4, w - labelW - gw);
    const body = wrapParagraphs(f.value.replace(/\s+/g, ' '), room);
    (body.length ? body : ['']).forEach((l, i) => {
      const head = i ? repeat(' ', labelW + gw) : c.muted(cell(fit(f.label, labelW - 1), labelW)) + (f.glyph ? f.glyph + ' ' : '');
      out.push(fit(head + (f.paint ?? c.text)(l), w));
    });
  }
  return out;
}

/**
 * A page that cannot show what it is for: a few words, and under them the error itself (it is data),
 * both centred.
 */
export function errorState(size: Size, title: string, error: string | undefined): string[] {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return frame([], size);
  const w = Math.max(1, Math.min(cols - 4, 76));
  const body = [c.bad.bold(fit(plainText(title), w)), ...(error ? ['', ...wrapParagraphs(plainText(error), w).map((l) => c.muted(l))] : [])];
  const top = Math.max(0, Math.floor((rows - body.length) / 2));
  const centre = (l: string) => repeat(' ', Math.max(0, Math.floor((cols - width(l)) / 2))) + l;
  return frame([...Array.from({ length: top }, () => ''), ...body.slice(0, rows - top).map(centre)], size);
}
