// Tiny ANSI helpers. No dependencies.

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const magenta = wrap(35);
export const cyan = wrap(36);

export const cursor = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  home: '\x1b[H',
  clearScreen: '\x1b[2J',
  clearLine: '\x1b[2K',
  clearToEnd: '\x1b[J',
};

/** Visible length, ignoring escape codes. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').length;
}

/** Truncate to `width` visible chars, adding an ellipsis. Input must be free of escapes. */
export function truncate(s: string, width: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  if (width <= 1) return flat.slice(0, width);
  return flat.slice(0, width - 1) + '…';
}

/** Right-pad to `width` visible chars (never shrinks). */
export function pad(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + ' '.repeat(width - len);
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtCost(usd: number | undefined): string {
  return usd === undefined ? '-' : `$${usd.toFixed(2)}`;
}
