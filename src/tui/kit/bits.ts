// Small pieces shared by the widgets, the app shell and the run view: pills, progress, the spinner,
// scrollbars, the key-hint bar, breadcrumbs and empty states.
import chalk from 'chalk';
import { P, c, type Glyphs } from '../theme.ts';
import { bar, cell, fit, plainText, repeat, width, wrap } from '../text.ts';
import { colourless, frame, thumb, type Size, type Tone } from './compose.ts';

const TONE_BG: Record<Tone, string> = {
  text: P.surface1, subtle: P.surface1, muted: P.surface0, faint: P.surface0,
  accent: P.mauve, ok: P.green, warn: P.yellow, bad: P.red, info: P.blue,
};

/** A filled label: ` done ` on green. Without colour it reads `[done]`. Text is sanitized. */
export function pill(text: string, t: Tone = 'accent'): string {
  const body = plainText(text);
  if (colourless()) return `[${body}]`;
  const fg = t === 'text' || t === 'subtle' || t === 'muted' || t === 'faint' ? P.text : P.base;
  return chalk.bgHex(TONE_BG[t]).hex(fg).bold(` ${body} `);
}

/** A quiet chip: tone-coloured text on the surface colour, for counts and states in panel titles. */
export function badge(text: string, t: Tone = 'subtle'): string {
  const body = plainText(text);
  if (colourless()) return `(${body})`;
  return chalk.bgHex(P.surface0).hex(t === 'text' || t === 'subtle' ? P.subtext0 : toneHex(t))(` ${body} `);
}

function toneHex(t: Tone): string {
  switch (t) {
    case 'ok': return P.green;
    case 'warn': return P.yellow;
    case 'bad': return P.red;
    case 'info': return P.blue;
    case 'accent': return P.mauve;
    case 'muted': return P.overlay1;
    case 'faint': return P.surface2;
    default: return P.text;
  }
}

/** `ratio` of a `w`-cell bar lit, with the percentage after it when there is room. */
export function progress(ratio: number, w: number, g: Glyphs, o: { label?: boolean; tone?: Tone } = {}): string {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const label = o.label === false ? '' : ` ${Math.round(r * 100)}%`.padStart(5);
  const barW = Math.max(0, w - width(label));
  if (barW < 3) return cell(c.muted(label.trim()), Math.max(0, w));
  const lit = o.tone ? (s: string) => c[o.tone!](s) : c.fill;
  return bar(r, barW, g.barOn, g.barOff, lit, c.track) + c.muted(label);
}

/** The spinner frame for `now` (ms); the same clock as the run view, so spinners agree. */
export function spinnerFrame(g: Glyphs, now: number): string {
  return g.spinner[Math.floor(now / 80) % g.spinner.length]!;
}

/** A one-cell-wide scrollbar column of `rows` cells; blank cells when everything fits. */
export function scrollbar(rows: number, top: number, total: number, visible: number, g: Glyphs, focused = false): string[] {
  const marks = thumb(rows, top, total, visible);
  if (!marks.length) return Array.from({ length: Math.max(0, rows) }, () => ' ');
  return marks.map((on) => (on ? (focused ? c.selected : c.muted)(g.thumb) : c.faint(g.track)));
}

export interface Hint { key: string; label: string }

/** One key hint in the footer style: the key in mauve on the bar, its meaning muted. */
export function keyHint(key: string, label: string): string {
  return `${c.key(` ${key} `)}${c.keyText(`${label} `)}`;
}

/**
 * The footer bar: `left` (trusted, already styled for the bar) then the hints right-aligned on the
 * mantle background. Given a list, hints are dropped from the end until the rest fits; given a
 * pre-joined string (the run view), it is cut instead.
 */
export function hintBar(left: string, hints: string | Hint[], cols: number): string {
  let text = typeof hints === 'string' ? hints : hints.map((h) => keyHint(h.key, h.label)).join('');
  if (typeof hints !== 'string') {
    let n = hints.length;
    while (n > 0 && width(left) + width(text) + 1 > cols) {
      n--;
      text = hints.slice(0, n).map((h) => keyHint(h.key, h.label)).join('');
    }
  }
  const gap = cols - width(left) - width(text) - 1;
  if (gap < 0) return fit(left + text, cols, '');
  return left + c.bar(repeat(' ', gap)) + text + c.bar(' ');
}

/** The left segment of a footer: a glyph and a label on the bar, like the run view's phase. */
export function barLabel(glyph: string, label: string): string {
  return c.bar(c.accent(` ${glyph} `) + c.text(plainText(label)) + ' ');
}

/** `Runs › r12 › diff`, cut from the left when it does not fit so the current place stays visible. */
export function breadcrumb(parts: string[], g: Glyphs, cols: number): string {
  const clean = parts.map((p) => plainText(p));
  const sep = ` ${g.crumb} `;
  for (let from = 0; from < clean.length; from++) {
    const shown = clean.slice(from);
    const text = (from ? `…${sep}` : '') + shown.join(sep);
    if (width(text) <= cols || from === clean.length - 1) {
      const styled = (from ? c.muted(`…${sep}`) : '') + shown.map((p, i) => (i === shown.length - 1 ? c.text.bold(p) : c.muted(p))).join(c.faint(sep));
      return fit(styled, cols);
    }
  }
  return '';
}

export interface EmptyOptions {
  /** A few words: what is (not) here. */
  title: string;
  /** Accepted for older callers and not drawn: an empty state is its title, nothing under it. */
  message?: string;
  /** Accepted and not drawn, as `message`. */
  hint?: string;
  /** Accepted and not drawn. */
  icon?: string;
}

/** A centred empty state: its title, muted, and nothing else. */
export function emptyState(size: Size, o: EmptyOptions, _g: Glyphs): string[] {
  const { rows, cols } = size;
  if (rows <= 0) return [];
  const w = Math.max(1, Math.min(cols - 2, 64));
  const lines = [c.muted(fit(plainText(o.title), w))];
  const topPad = Math.max(0, Math.floor((rows - lines.length) / 2));
  const centred = lines.map((l) => repeat(' ', Math.max(0, Math.floor((cols - width(l)) / 2))) + l);
  return frame([...Array.from({ length: topPad }, () => ''), ...centred], size);
}
