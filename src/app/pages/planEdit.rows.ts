// The plan editor's content as data and pixels: the rows a card's editor shows (one per editable
// value, list item, dependency checkbox and add button), grouped in sections, and the renderers for
// the editor pane and the card list. Labels and values only: what a section or row means is in help
// (rowHelp). Pure: the page owns the draft and the modals.
import type { Card } from '../../types.ts';
import { c, type Glyphs } from '../../tui/theme.ts';
import { cell, fit, plainText, repeat, width } from '../../tui/text.ts';
import { shownCommand } from '../../tui/view.ts';
import { colourless, followRange, frame, onBackground, softWrap, type Size } from '../../tui/kit/index.ts';

export type RowKind =
  | 'title' | 'description' | 'criterion' | 'addCriterion' | 'dep' | 'verify' | 'addVerify'
  | 'harness' | 'model' | 'taskTitle' | 'taskInstructions';

export interface EditorRow {
  /** Stable identity, so the selection survives rebuilding the rows after an edit. */
  key: string;
  kind: RowKind;
  /** Position in the criteria or verify list. */
  index?: number;
  depId?: string;
  taskId?: string;
  /** A label column before the value (worker and task rows). */
  label?: string;
  /** The value, raw: sanitized when drawn. */
  text: string;
  placeholder?: string;
  checked?: boolean;
  /** Why a dependency cannot be chosen (it would make the plan wait for itself): toasted when tried, never drawn. */
  disabled?: string;
  /** A shell command the person approves by saving: always shown whole (every value is; this marks why). */
  whole?: boolean;
  prefix?: string;
}

export interface Section { id: string; title: string; changed: boolean; rows: EditorRow[] }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Ids of the draft cards that differ from the saved plan. */
export function changedCards(draft: Card[], saved: Card[]): string[] {
  const byId = new Map(saved.map((x) => [x.id, x]));
  return draft.filter((x) => !same(x, byId.get(x.id))).map((x) => x.id);
}

/**
 * Cards that wait for `id`, directly or through others, each with the cards in between: choosing one
 * of them as a dependency of `id` would make the plan wait for itself.
 */
export function dependents(cards: Card[], id: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const queue: string[] = [id];
  const via = new Map<string, string[]>([[id, []]]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const x of cards) {
      if (!x.dependsOn.includes(cur) || via.has(x.id)) continue;
      const chain = cur === id ? [] : [cur, ...via.get(cur)!];
      via.set(x.id, chain);
      out.set(x.id, chain);
      queue.push(x.id);
    }
  }
  return out;
}

export function buildSections(cards: Card[], card: Card, saved: Card | undefined, g: Glyphs): Section[] {
  const sections: Section[] = [];
  sections.push({ id: 'title', title: 'Title', changed: !same(card.title, saved?.title), rows: [
    { key: 'title', kind: 'title', text: card.title, placeholder: 'no title' },
  ] });
  sections.push({ id: 'description', title: 'Description', changed: !same(card.description, saved?.description), rows: [
    { key: 'description', kind: 'description', text: card.description, placeholder: 'no description' },
  ] });
  sections.push({ id: 'criteria', title: 'Acceptance criteria', changed: !same(card.acceptanceCriteria, saved?.acceptanceCriteria), rows: [
    ...card.acceptanceCriteria.map((text, i): EditorRow => ({ key: `crit:${i}`, kind: 'criterion', index: i, text, prefix: `${g.bullet} ` })),
    { key: 'crit:+', kind: 'addCriterion', text: 'add' },
  ] });

  const loops = dependents(cards, card.id);
  const others = cards.filter((x) => x.id !== card.id);
  const known = new Set(cards.map((x) => x.id));
  const deps: EditorRow[] = others.map((x) => {
    const checked = card.dependsOn.includes(x.id);
    const chain = loops.get(x.id);
    // A loop already in the plan (a hand edit) can still be undone.
    const disabled = chain && !checked ? `waits for ${card.id}${chain.length ? ` via ${chain.join(', ')}` : ''}` : undefined;
    return { key: `dep:${x.id}`, kind: 'dep', depId: x.id, text: `${x.id}  ${x.title}`, checked, disabled };
  });
  for (const id of card.dependsOn.filter((d) => !known.has(d))) deps.push({ key: `dep:${id}`, kind: 'dep', depId: id, text: `${id}  no such card`, checked: true });
  // The only card waits for nothing: no heading over an empty list.
  if (deps.length) sections.push({ id: 'deps', title: 'Waits for', changed: !same(card.dependsOn, saved?.dependsOn), rows: deps });

  sections.push({
    id: 'verify', title: 'Verify commands', changed: !same(card.verify, saved?.verify),
    rows: [
      ...card.verify.map((text, i): EditorRow => ({ key: `verify:${i}`, kind: 'verify', index: i, text, prefix: '$ ', whole: true })),
      { key: 'verify:+', kind: 'addVerify', text: 'add' },
    ],
  });

  const harness = card.worker?.harness;
  const model = card.worker?.model;
  sections.push({
    id: 'worker', title: 'Worker', changed: !same(card.worker, saved?.worker),
    rows: [
      { key: 'harness', kind: 'harness', label: 'Backend', text: harness ?? '', placeholder: 'session settings' },
      ...(harness ? [{ key: 'model', kind: 'model' as const, label: 'Model', text: model ?? '', placeholder: 'automatic' }] : []),
    ],
  });

  for (const t of card.tasks) {
    const before = saved?.tasks.find((x) => x.id === t.id);
    sections.push({
      id: `task:${t.id}`, title: `Task ${t.id}${t.complexity ? ` · ${t.complexity}` : ''}`,
      changed: !same(t.title, before?.title) || !same(t.instructions, before?.instructions),
      rows: [
        { key: `task:${t.id}:title`, kind: 'taskTitle', taskId: t.id, label: 'Title', text: t.title, placeholder: 'untitled' },
        { key: `task:${t.id}:instructions`, kind: 'taskInstructions', taskId: t.id, label: 'Instructions', text: t.instructions, placeholder: 'no instructions' },
      ],
    });
  }
  return sections;
}

/** What `?` says about the selected row: its section's label and what it does (the words the editor used to show). */
export function rowHelp(card: Card, row: EditorRow, g: Glyphs): { title: string; text: string[] } {
  switch (row.kind) {
    case 'title': return { title: 'Title', text: ['The card\'s name on the board. Required.'] };
    case 'description': return { title: 'Description', text: ['What the card delivers, for the worker and the reviewer. Required.'] };
    case 'criterion': case 'addCriterion':
      return { title: 'Acceptance criteria', text: ['Each is one thing the reviewer checks before the card passes.'] };
    case 'dep': return { title: 'Waits for', text: [
      'This card starts once the checked cards have landed.',
      `${g.block} a card that already waits for this one: choosing it would make the plan wait for itself.`,
      ...(row.disabled ? [`${row.depId} ${row.disabled}.`] : []),
    ] };
    case 'verify': case 'addVerify': return { title: 'Verify commands', text: [
      'dulger runs these in the card\'s worktree before every review; exit status 0 passes. Saving the plan approves running them.',
      'Each is shown whole, exactly as it will run: line breaks, tabs and control characters are spelled out. Pipes, quotes and redirections keep their meaning.',
      'A command a text box would change (a tab, a control or format character) is not edited in place: it can be removed or replaced, never silently rewritten.',
    ] };
    case 'harness': return { title: 'Backend', text: [
      'The backend that builds this card.',
      'session settings: the session\'s backend, with the model routed by task difficulty.',
    ] };
    case 'model': return { title: 'Model', text: [
      'A pinned model is used for every task and retry of this card: it overrides task difficulty.',
      'automatic: by task difficulty, or the backend\'s default.',
    ] };
    case 'taskTitle': case 'taskInstructions': {
      const t = card.tasks.find((x) => x.id === row.taskId);
      return { title: `Task ${row.taskId ?? ''}`.trim(), text: [
        `What the worker does for this task of ${card.id}. Instructions are required.`,
        ...(t?.complexity ? [`${t.complexity}: the task's difficulty, which routes the model when none is pinned.`] : []),
      ] };
    }
  }
}

// ---- drawing ----

const LABEL_W = 13;

/** A value's lines, nothing dropped: its own line breaks kept, long lines wrapped at spaces (or mid-word when one is too long). */
function valueLines(row: EditorRow, w: number): string[] {
  if (!row.text.trim()) return [c.faint(fit(plainText(row.placeholder ?? ''), w))];
  // A shell command is shown exactly as the live run view shows it (shownCommand): every character kept,
  // newlines and format/control characters spelled out, so nothing in it can hide or reorder what runs.
  if (row.whole) return softWrap(shownCommand(row.text), w).map((l) => c.text(l));
  const source = row.text.replace(/\r\n?/g, '\n').split('\n');
  return source.flatMap((line) => softWrap(plainText(line), w)).map((l) => c.text(l));
}

function rowLines(row: EditorRow, w: number, g: Glyphs, selected: boolean): string[] {
  switch (row.kind) {
    case 'addCriterion': case 'addVerify':
      return [(selected ? c.accent : c.muted)(fit(`+ ${row.text}`, w))];
    case 'dep': {
      // A card that would make the plan wait for itself: a blocked glyph in the box's place, dimmed (the
      // glyph reads without colour); why is toasted when it is tried, and in help.
      const bw = Math.max(width(g.checkOn), width(g.checkOff));
      const box = row.checked ? c.accent(g.checkOn) : row.disabled ? c.faint(g.block) : c.muted(g.checkOff);
      const text = plainText(row.text);
      if (row.disabled) return [fit(`${cell(box, bw)} ${c.faint(text)}`, w)];
      return [fit(`${cell(box, bw)} ${(selected ? c.text.bold : c.text)(text)}`, w)];
    }
    default: break;
  }
  if (row.label) {
    const lw = Math.min(LABEL_W, Math.max(1, Math.floor(w / 3)));
    const vw = Math.max(1, w - lw - 1);
    return valueLines(row, vw).map((v, i) => cell(i ? '' : c.subtle(fit(row.label!, lw)), lw) + ' ' + v);
  }
  if (row.prefix) {
    const pw = width(row.prefix);
    return valueLines(row, Math.max(1, w - pw)).map((v, i) => (i ? repeat(' ', pw) : c.muted(row.prefix!)) + v);
  }
  return valueLines(row, w);
}

export interface EditorView {
  lines: string[];
  /** The row key under each line, for clicks. */
  hits: Array<string | undefined>;
  top: number;
  /** Lines in the whole editor, for the scrollbar. */
  total: number;
}

/** The editor pane: section headings and rows; the selected row stays in view with its heading. */
export function renderEditor(sections: Section[], selected: string | undefined, size: Size, g: Glyphs, o: { focused: boolean; top: number }): EditorView {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return { lines: frame([], size), hits: [], top: 0, total: 0 };
  const pw = width(g.pointer) + 1;
  const w = Math.max(1, cols - pw);
  const all: string[] = [];
  const hits: Array<string | undefined> = [];
  let range: [number, number] | undefined;
  let head = 0;
  sections.forEach((s, si) => {
    if (si > 0) { all.push(''); hits.push(undefined); }
    const heading = all.length;
    all.push(cell(' ' + c.accent.bold(fit(plainText(s.title), Math.max(1, cols - 3))) + (s.changed ? ' ' + c.warn(g.modified) : ''), cols));
    hits.push(undefined);
    s.rows.forEach((row, ri) => {
      const isSel = row.key === selected;
      const body = rowLines(row, w, g, isSel && o.focused);
      const start = all.length;
      body.forEach((line, i) => {
        const pointer = isSel && i === 0 ? (o.focused ? c.accent(g.pointer) : c.muted(g.pointer)) + ' ' : repeat(' ', pw);
        let text = cell(pointer + line, cols);
        if (isSel && o.focused && !colourless()) text = onBackground(text, cols, c.bg);
        all.push(text);
        hits.push(row.key);
      });
      if (isSel) { range = [start, all.length]; head = ri === 0 ? heading : start; }
    });
  });
  // The selected row stays in view, with its heading when that fits too (a taller row from its start).
  const top = range ? followRange(o.top, range[0], range[1], rows, all.length, head) : Math.max(0, Math.min(o.top, Math.max(0, all.length - rows)));
  return { lines: frame(all.slice(top, top + rows), size), hits: hits.slice(top, top + rows), top, total: all.length };
}

export interface CardsView { lines: string[]; hits: Array<number | undefined>; top: number; per: number }

/** The second line of a card in the list: tasks, then what it waits for and a pinned worker when there are any. */
function cardMeta(card: Card): string {
  const tasks = `${card.tasks.length} task${card.tasks.length === 1 ? '' : 's'}`;
  const after = card.dependsOn.length ? ` · after ${card.dependsOn.join(', ')}` : '';
  const pin = card.worker?.harness ? ` · ${card.worker.model ?? card.worker.harness}` : '';
  return plainText(`${tasks}${after}${pin}`);
}

/** The cells the card list needs for its widest card (pointer, mark, id, title; the meta line), without the panel's frame. */
export function cardsWidth(cards: Card[], g: Glyphs): number {
  const lead = width(g.pointer) + 1 + width(g.modified) + 1;
  return Math.max(0, ...cards.map((x) => lead + Math.max(width(plainText(x.id)) + 2 + width(plainText(x.title)), width(cardMeta(x)))));
}

/** The card list: id and title, then tasks, what the card waits for and a pinned worker; edited cards marked. */
export function renderCards(cards: Card[], edited: Set<string>, index: number, size: Size, g: Glyphs, o: { focused: boolean; top: number }): CardsView {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return { lines: frame([], size), hits: [], top: 0, per: 1 };
  const per = rows >= 4 ? 2 : 1;
  const visible = Math.max(1, Math.floor(rows / per));
  let top = Math.max(0, Math.min(o.top, Math.max(0, cards.length - visible)));
  if (index < top) top = index;
  if (index >= top + visible) top = index - visible + 1;
  const pw = width(g.pointer) + 1;
  const mw = width(g.modified) + 1;
  const lines: string[] = [];
  const hits: Array<number | undefined> = [];
  for (let i = top; i < Math.min(cards.length, top + visible); i++) {
    const card = cards[i]!;
    const sel = i === index;
    const mark = edited.has(card.id) ? c.warn(g.modified) + ' ' : repeat(' ', mw);
    const title = `${mark}${(sel ? c.text.bold : c.text)(plainText(card.id))}  ${(sel ? c.text.bold : c.subtle)(plainText(card.title))}`;
    const meta = repeat(' ', mw) + c.muted(cardMeta(card));
    const body = per === 2 ? [title, meta] : [title];
    body.forEach((line, j) => {
      const pointer = sel && j === 0 ? (o.focused ? c.accent(g.pointer) : c.muted(g.pointer)) + ' ' : repeat(' ', pw);
      let text = cell(pointer + line, cols);
      if (sel && o.focused && !colourless()) text = onBackground(text, cols, c.bg);
      lines.push(text);
      hits.push(i);
    });
  }
  if (!cards.length) lines.push(c.muted(fit('No cards', cols)));
  return { lines: frame(lines, size), hits, top, per };
}
