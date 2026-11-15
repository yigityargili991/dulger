// The command palette: every command the app knows, fuzzy-filtered as you type, with its group,
// shortcut and description. It sits near the top of the screen like an editor's palette.
import type { Key, Mouse } from '../screen.ts';
import { c, type Glyphs } from '../theme.ts';
import { fit, plainText, repeat, wrapParagraphs } from '../text.ts';
import { panel, type Rendered, type Size } from './compose.ts';
import { createList, listKey, listMouse, renderList, selectedItem, type ListState } from './list.ts';
import type { Modal } from './modal.ts';

export interface PaletteCommand {
  id: string;
  title: string;
  /** Shown before the title ("Runs: Resume latest") and matched by the filter. */
  group?: string;
  /** Key text shown at the right, e.g. "^P" or "3". */
  shortcut?: string;
  description?: string;
  /**
   * Not available now: listed dimmed, never selected first and never run. A string says why, and the app
   * toasts it when the command is chosen (see disabledReason).
   */
  disabled?: boolean | string;
}

export interface PaletteState {
  commands: PaletteCommand[];
  list: ListState;
  listAt?: { row: number; col: number };
  /** The disabled command just chosen: the strip says why it did not run. */
  refused?: string;
}

/** Why a disabled command cannot run (what the app toasts when it is chosen); undefined when it can. */
export function disabledReason(cmd: PaletteCommand): string | undefined {
  return cmd.disabled ? reasonOf(cmd) : undefined;
}

function reasonOf(cmd: PaletteCommand): string {
  return typeof cmd.disabled === 'string' && cmd.disabled.trim() ? plainText(cmd.disabled) : 'Not available now.';
}

export function createPalette(commands: PaletteCommand[]): PaletteState {
  const list = createList(commands.map((cmd) => ({
    id: cmd.id,
    label: cmd.group ? `${cmd.group}: ${cmd.title}` : cmd.title,
    meta: cmd.shortcut,
    metaTone: 'accent',
    keywords: cmd.description,
    disabled: Boolean(cmd.disabled),
  })), { filter: 'type', empty: 'No commands', skipDisabled: false });
  return { commands, list };
}

export function renderPalette(s: PaletteState, size: Size, g: Glyphs): Rendered {
  const cols = Math.max(1, Math.min(size.cols, 76));
  const framed = size.rows >= 3 && cols >= 6;
  // The palette opens a sixth of the way down (placement 'top'): where there is room, stay clear of
  // that offset and of the last row, so the box never sits on the app's footer.
  const reserve = size.rows >= 12 ? Math.floor(size.rows / 6) + 1 : 0;
  const avail = Math.max(1, size.rows - reserve - (framed ? 2 : 0));
  // Names and shortcut keys only: a command's description is matched by the filter but not drawn,
  // and a disabled one is dimmed (choosing it says why, through the app).
  const listRows = Math.max(1, Math.min(1 + Math.max(1, s.commands.length), 14, avail));
  const rows = Math.min(size.rows - reserve, listRows + (framed ? 2 : 0));
  const box = panel({ rows, cols }, { g, title: 'Commands', focused: true, mark: false, pad: 1 }, (inner) =>
    renderList(s.list, { rows: Math.min(listRows, inner.rows), cols: inner.cols }, g, { focused: true, scrollbar: true }));
  s.listAt = framed && box.lines.length >= 3 ? { row: 1, col: 2 } : { row: 0, col: 0 };
  return box;
}

/**
 * `{ value: id }` for the command chosen, `{ value: undefined }` to close. A disabled command is chosen
 * too: the caller says why instead of running it (`disabledReason`).
 */
export function paletteKey(s: PaletteState, k: Key): { value: string | undefined } | undefined {
  if (k.name === 'ctrl' && (k.ch === 'c' || k.ch === 'd' || k.ch === 'p')) return { value: undefined };
  if (k.name === 'ctrl' && k.ch === 'n') { listKey(s.list, { name: 'down' }); return undefined; }
  if (k.name === 'enter') {
    const it = selectedItem(s.list);
    return it ? { value: it.id } : undefined;
  }
  s.refused = undefined;
  if (listKey(s.list, k)) return undefined;
  if (k.name === 'escape') return { value: undefined };
  return undefined;
}

export function paletteMouse(s: PaletteState, m: Mouse): { value: string | undefined } | undefined {
  if (!s.listAt) return undefined;
  const r = listMouse(s.list, { ...m, row: m.row - s.listAt.row, col: m.col - s.listAt.col });
  if (r === 'activate') {
    const it = selectedItem(s.list);
    return it ? { value: it.id } : undefined;
  }
  if (r) s.refused = undefined;
  return undefined;
}

export function paletteModal(commands: PaletteCommand[]): Modal<string | undefined> & { state: PaletteState } {
  const state = createPalette(commands);
  return { state, cancel: undefined, placement: 'top', render: (size, g) => renderPalette(state, size, g), key: (k) => paletteKey(state, k), mouse: (m) => paletteMouse(state, m) };
}
