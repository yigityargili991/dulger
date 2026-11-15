// Fuzzy matching for filters and the command palette. The scoring follows the idea popularised by fzf
// (reimplemented here, no code taken): characters must appear in order; matches at word starts and runs
// of consecutive characters score higher, gaps cost a little. Space-separated terms must all match.
// Smart case: a query with an upper-case letter matches case-sensitively.
import { graphemes } from './compose.ts';

export interface Match {
  score: number;
  /** Grapheme indices of the matched characters in the text, ascending. */
  positions: number[];
}

const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 9;
const BONUS_START = 10;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 6;
const PENALTY_GAP_START = 3;
const PENALTY_GAP = 1;

const SEPARATOR = /[\s/\\\-_.:,;|()[\]{}'"]/u;

function bonusAt(chars: string[], i: number): number {
  if (i === 0) return BONUS_START;
  const prev = chars[i - 1]!;
  const ch = chars[i]!;
  if (SEPARATOR.test(prev)) return BONUS_BOUNDARY;
  if (/\p{Ll}/u.test(prev) && /\p{Lu}/u.test(ch)) return BONUS_CAMEL;
  if (/\D/u.test(prev) && /\d/u.test(ch)) return BONUS_CAMEL;
  return 0;
}

/** One term against the text: a forward scan finds where the match can end, a backward scan tightens it. */
function matchTerm(term: string[], text: string[], fold: (s: string) => string): Match | undefined {
  if (!term.length) return { score: 0, positions: [] };
  const t = text.map(fold);
  const q = term.map(fold);
  let qi = 0;
  let end = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === q[qi]) { qi++; if (qi === q.length) { end = i; break; } }
  }
  if (end < 0) return undefined;
  // Walk back from the end to find the latest start, which gives the shortest window.
  qi = q.length - 1;
  let start = end;
  for (let i = end; i >= 0; i--) {
    if (t[i] === q[qi]) { qi--; if (qi < 0) { start = i; break; } }
  }
  // Inside the window, take each query character as early as it appears after a boundary when it can;
  // otherwise greedily. Score as we go.
  const positions: number[] = [];
  qi = 0;
  for (let i = start; i <= end && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    // Prefer a later occurrence at a word boundary when the rest still fits before `end`.
    let pick = i;
    if (bonusAt(text, i) === 0) {
      for (let j = i + 1; j <= end; j++) {
        if (t[j] === q[qi] && bonusAt(text, j) > 0 && fits(t, q, qi + 1, j + 1, end)) { pick = j; break; }
      }
    }
    positions.push(pick);
    i = pick;
    qi++;
  }
  let score = 0;
  let prev = -2;
  for (const p of positions) {
    score += SCORE_MATCH + bonusAt(text, p);
    if (p === prev + 1) score += BONUS_CONSECUTIVE;
    else if (prev >= 0) score -= PENALTY_GAP_START + PENALTY_GAP * (p - prev - 2);
    prev = p;
  }
  // A leading gap costs a little so earlier matches win ties.
  score -= Math.min(positions[0] ?? 0, 10) * 0.1;
  return { score, positions };
}

function fits(t: string[], q: string[], from: number, i: number, end: number): boolean {
  let qi = from;
  for (let k = i; k <= end && qi < q.length; k++) if (t[k] === q[qi]) qi++;
  return qi === q.length;
}

/** Match `query` against `text`; undefined when some term does not match. An empty query matches everything. */
export function fuzzy(query: string, text: string): Match | undefined {
  const terms = query.trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return { score: 0, positions: [] };
  const sensitive = /\p{Lu}/u.test(query);
  const fold = sensitive ? (s: string) => s : (s: string) => s.toLowerCase();
  const chars = graphemes(text);
  let score = 0;
  const positions = new Set<number>();
  for (const term of terms) {
    const m = matchTerm(graphemes(term), chars, fold);
    if (!m) return undefined;
    score += m.score;
    for (const p of m.positions) positions.add(p);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

/**
 * Items whose text matches, best first; ties keep their original order. `text` gives what to match on
 * for each item (it should be plain text: positions index its graphemes).
 */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, sort = true): Array<{ item: T; index: number; match: Match }> {
  const out: Array<{ item: T; index: number; match: Match }> = [];
  items.forEach((item, index) => {
    const match = fuzzy(query, text(item));
    if (match) out.push({ item, index, match });
  });
  if (sort && query.trim()) out.sort((a, b) => b.match.score - a.match.score || a.index - b.index);
  return out;
}

/**
 * Words and substrings, for lists of sentences (run goals) where a loose subsequence would match almost
 * anything: every space-separated term must appear in `text` as it is typed (smart case, as above). The
 * text that is the query exactly scores highest, then one that starts with it, then terms found at word
 * starts, earlier and in the query's order. Positions cover every matched character.
 */
export function wordMatch(query: string, text: string): Match | undefined {
  const q = query.trim().replace(/\s+/gu, ' ');
  const terms = q.split(' ').filter(Boolean);
  if (!terms.length) return { score: 0, positions: [] };
  const sensitive = /\p{Lu}/u.test(query);
  const fold = (s: string) => (sensitive ? s : s.toLowerCase());
  const chars = graphemes(text);
  const folded = chars.map(fold);
  const hay = folded.join('');
  // Grapheme index of each code unit of `hay`.
  const at: number[] = [];
  folded.forEach((g, i) => { for (let k = 0; k < g.length; k++) at.push(i); });
  const whole = fold(text.trim().replace(/\s+/gu, ' '));
  let score = whole === fold(q) ? 1000 : whole.startsWith(fold(q)) ? 500 : 0;
  const positions = new Set<number>();
  let last = -1;
  for (const term of terms) {
    const t = fold(term);
    // Prefer an occurrence at a word start, then any.
    let idx = -1;
    for (let from = hay.indexOf(t); from >= 0; from = hay.indexOf(t, from + 1)) {
      if (idx < 0) idx = from;
      const g = at[from]!;
      if (g === 0 || SEPARATOR.test(chars[g - 1]!)) { idx = from; break; }
    }
    if (idx < 0) return undefined;
    const g = at[idx]!;
    score += (g === 0 || SEPARATOR.test(chars[g - 1]!) ? 30 : 10) + (idx > last ? 5 : 0) - Math.min(g, 50) * 0.1;
    last = idx;
    for (let k = idx; k < idx + t.length; k++) positions.add(at[k]!);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

export type MatchMode = 'fuzzy' | 'words';

/**
 * Items ranked for `query`: what is shown (`text`) is matched first, in `mode`; extra words (`more`:
 * descriptions, keywords) only as whole words and substrings, and below every match on what is shown,
 * so a title match is never outranked by a description. `positions` index graphemes of `text`.
 */
export function rankFilter<T>(items: T[], query: string, text: (item: T) => string, more: (item: T) => string, o: { mode?: MatchMode; sort?: boolean } = {}): Array<{ item: T; index: number; match: Match }> {
  const out: Array<{ item: T; index: number; match: Match }> = [];
  const shown = o.mode === 'words' ? wordMatch : fuzzy;
  items.forEach((item, index) => {
    const t = text(item);
    const m = shown(query, t);
    if (m) { out.push({ item, index, match: { score: 1e6 + m.score, positions: m.positions } }); return; }
    const extra = more(item);
    const w = extra ? wordMatch(query, `${t} ${extra}`) : undefined;
    if (w) out.push({ item, index, match: { score: w.score, positions: [] } });
  });
  if (o.sort !== false && query.trim()) out.sort((a, b) => b.match.score - a.match.score || a.index - b.index);
  return out;
}
