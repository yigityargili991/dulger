// A one-row tab bar. It returns where each tab landed so a click can be mapped back to a tab.
// As the width shrinks: all titles with numbers; titles only; the active title whole with the others
// shortened (to 8, 6, 5, 4, then 3 characters); a window of shortened tabs around the active one,
// with ‹ and › where tabs are left out; numbers only; finally the active title alone, cut to fit.
import { c } from '../theme.ts';
import { cell, fit, plainText, repeat, width } from '../text.ts';
import { colourless, graphemes } from './compose.ts';

export interface TabItem { id: string; title: string; badge?: string }
export interface TabSpan { index: number; from: number; to: number }
export interface TabBar { line: string; spans: TabSpan[] }

interface Part { index: number; n: string; title: string; b: string }
interface Try { parts: Part[]; left?: boolean; right?: boolean }

/** `numbers`: show the 1…9 shortcut before each title (default true). */
export function renderTabs(tabs: TabItem[], active: number, cols: number, o: { numbers?: boolean } = {}): TabBar {
  if (cols <= 0 || !tabs.length) return { line: cell('', Math.max(0, cols)), spans: [] };
  const plain = colourless();
  const at = Math.max(0, Math.min(active, tabs.length - 1));
  const label = (i: number, numbered: boolean, max = Infinity): Part => {
    const t = tabs[i]!;
    return { index: i, n: numbered && i < 9 ? `${i + 1} ` : '', title: fit(plainText(t.title), max), b: t.badge ? ` ${plainText(t.badge)}` : '' };
  };
  // A short name: the title's first `k` characters, no ellipsis (Sett, Prov): still a word to read.
  const short = (i: number, k: number): Part => ({ index: i, n: '', title: graphemes(plainText(tabs[i]!.title)).slice(0, k).join(''), b: '' });
  const number = (i: number): Part => ({ index: i, n: String(i + 1), title: '', b: '' });
  const ARROW = 2;
  const total = (x: Try) => x.parts.reduce((s, p) => s + width(p.n + p.title + p.b) + 2, 0) + Math.max(0, x.parts.length - 1) + 1 + (x.left ? ARROW : 0) + (x.right ? ARROW : 0);
  const numbers = o.numbers !== false;
  const all = tabs.map((_, i) => i);
  const tries: Try[] = [
    { parts: all.map((i) => label(i, numbers)) },
    { parts: all.map((i) => label(i, false)) },
    ...[8, 6, 5, 4, 3].map((k) => ({ parts: all.map((i) => (i === at ? label(i, false) : short(i, k))) })),
  ];
  // A window around the active tab: as many shortened neighbours as fit, nearest first.
  for (const k of [4, 3]) {
    let from = at;
    let to = at;
    const win = (a: number, b: number): Try => ({ parts: all.slice(a, b + 1).map((i) => (i === at ? label(i, false) : short(i, k))), left: a > 0, right: b < tabs.length - 1 });
    for (let grew = true; grew;) {
      grew = false;
      if (to + 1 < tabs.length && total(win(from, to + 1)) <= cols) { to++; grew = true; }
      if (from > 0 && total(win(from - 1, to)) <= cols) { from--; grew = true; }
    }
    if (to > from) tries.push(win(from, to));
  }
  tries.push({ parts: all.map(number) });
  const chosen = tries.find((x) => total(x) <= cols) ?? { parts: [label(at, false, Math.max(1, cols - 3))] };

  let line = ' ';
  let col = 1;
  const spans: TabSpan[] = [];
  if (chosen.left) { line += c.muted('‹ '); col += ARROW; }
  chosen.parts.forEach((p, k) => {
    const text = `${p.n}${p.title}${p.b}`;
    const w = width(text) + 2;
    if (col + w > cols) return;
    let seg: string;
    if (p.index === at) seg = plain ? `[${text}]` : c.tab(` ${text} `);
    else seg = ` ${c.faint(p.n)}${c.subtle(p.title)}${p.b ? c.muted(p.b) : ''} `;
    spans.push({ index: p.index, from: col, to: col + w });
    line += seg;
    col += w;
    if (k < chosen.parts.length - 1 && col < cols) { line += ' '; col += 1; }
  });
  if (chosen.right && col + ARROW <= cols) { line += c.muted(' ›'); col += ARROW; }
  return { line: cell(line + repeat(' ', Math.max(0, cols - col)), cols), spans };
}

/** The tab under column `col`, if any. */
export function tabAt(bar: TabBar, col: number): number | undefined {
  return bar.spans.find((s) => col >= s.from && col < s.to)?.index;
}
