// The help overlay: keys grouped under headings, in two columns when every line fits in one, else in
// one column with long descriptions wrapped (never cut); scrollable when it is not tall enough. Help is
// where a page explains itself: a group may carry a short paragraph (`text`) under its title, and a
// page leads with the focused item (its label and what it does), then its keys.
import type { Key, Mouse } from '../screen.ts';
import { c, type Glyphs } from '../theme.ts';
import { cell, fit, plainText, repeat, width, wrapParagraphs } from '../text.ts';
import { panel, type Rendered, type Size } from './compose.ts';
import type { Hint } from './bits.ts';
import type { Modal } from './modal.ts';

export interface HelpGroup {
  title: string;
  /** Keys and what they do (may be empty when the group is only `text`). */
  keys: Hint[];
  /** A short paragraph (or several) under the title, wrapped: what the focused item or the page is. */
  text?: string | string[];
}
export interface HelpState { title: string; groups: HelpGroup[]; top: number; height: number; total: number }

export function createHelp(groups: HelpGroup[], title = 'Help'): HelpState {
  return { title, groups: groups.filter((gr) => gr.keys.length || paragraphs(gr).length), top: 0, height: 1, total: 0 };
}

function paragraphs(gr: HelpGroup): string[] {
  const t = gr.text === undefined ? [] : Array.isArray(gr.text) ? gr.text : [gr.text];
  return t.map((x) => plainText(x).trim()).filter(Boolean);
}

function groupLines(gr: HelpGroup, w: number, keyW: number): string[] {
  const lines = [c.accent.bold(fit(plainText(gr.title), w))];
  paragraphs(gr).forEach((p, i) => {
    if (i) lines.push('');
    for (const l of wrapParagraphs(p, Math.max(1, w))) lines.push(cell(c.text(l), w));
  });
  if (paragraphs(gr).length && gr.keys.length) lines.push('');
  const labelW = Math.max(1, w - keyW - 2);
  for (const k of gr.keys) {
    const key = cell(c.text.bold(plainText(k.key)), keyW);
    // A description that does not fit wraps under itself; a long word (a path) is broken, never cut.
    const parts = wrapParagraphs(k.label, labelW);
    (parts.length ? parts : ['']).forEach((l, i) => lines.push(cell(`${i ? repeat(' ', keyW) : key}  ${c.muted(l)}`, w)));
  }
  return lines;
}

/** Whether every key line of every group fits a column of `w` cells without wrapping. */
function fitsColumn(groups: HelpGroup[], w: number, keyW: number): boolean {
  // A paragraph reads better across the full width: two columns only when no group has one.
  return groups.every((gr) => !paragraphs(gr).length && width(plainText(gr.title)) <= w && gr.keys.every((k) => keyW + 2 + width(plainText(k.label)) <= w));
}

export function renderHelp(s: HelpState, size: Size, g: Glyphs): Rendered {
  const cols = Math.max(1, Math.min(size.cols - (size.cols >= 50 ? 4 : 0), 100));
  const rowsMax = Math.max(1, size.rows - (size.rows >= 20 ? 2 : 0));
  const keyW = Math.min(14, Math.max(3, ...s.groups.flatMap((gr) => gr.keys.map((k) => width(plainText(k.key))))));
  const innerW = Math.max(1, cols - 4);
  const half = Math.floor((innerW - 3) / 2);
  const two = innerW >= 70 && s.groups.length > 1 && fitsColumn(s.groups, half, keyW);
  const colW = two ? half : innerW;
  const blocks = s.groups.map((gr) => groupLines(gr, colW, keyW));
  let content: string[];
  if (two) {
    // Fill the left column until about half the lines are in it, then the right one.
    const total = blocks.reduce((n, b) => n + b.length + 1, 0);
    const left: string[] = [];
    const right: string[] = [];
    for (const b of blocks) {
      const target = left.length < total / 2 - 1 ? left : right;
      if (target.length) target.push('');
      target.push(...b);
    }
    content = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => cell(left[i] ?? '', colW) + '   ' + (right[i] ?? ''));
  } else {
    content = blocks.flatMap((b, i) => (i ? ['', ...b] : b));
  }
  const rows = Math.min(rowsMax, content.length + 2);
  s.total = content.length;
  s.height = Math.max(1, rows - 2);
  s.top = Math.max(0, Math.min(s.top, Math.max(0, content.length - s.height)));
  return panel({ rows, cols }, {
    g, title: s.title, focused: true, mark: false,
    scroll: { top: s.top, total: content.length, visible: s.height },
  }, (inner) => content.slice(s.top, s.top + inner.rows));
}

export function helpKey(s: HelpState, k: Key): { value: undefined } | undefined {
  if (k.name === 'escape' || k.name === 'enter' || k.name === 'f1' || (k.name === 'char' && (k.ch === 'q' || k.ch === '?')) || (k.name === 'ctrl' && (k.ch === 'c' || k.ch === 'd'))) return { value: undefined };
  const max = Math.max(0, s.total - s.height);
  if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) s.top = Math.max(0, s.top - 1);
  if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) s.top = Math.min(max, s.top + 1);
  if (k.name === 'pageup') s.top = Math.max(0, s.top - s.height);
  if (k.name === 'pagedown') s.top = Math.min(max, s.top + s.height);
  return undefined;
}

export function helpMouse(s: HelpState, m: Mouse): undefined {
  const max = Math.max(0, s.total - s.height);
  if (m.kind === 'wheel-up') s.top = Math.max(0, s.top - 3);
  if (m.kind === 'wheel-down') s.top = Math.min(max, s.top + 3);
  return undefined;
}

export function helpModal(groups: HelpGroup[], title?: string): Modal<undefined> & { state: HelpState } {
  const state = createHelp(groups, title);
  return { state, cancel: undefined, render: (size, g) => renderHelp(state, size, g), key: (k) => helpKey(state, k), mouse: (m) => helpMouse(state, m) };
}
