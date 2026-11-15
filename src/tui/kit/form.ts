// A settings form: sections of fields — toggles, choices (←/→ cycle, Enter opens a dropdown), numbers
// (stepper, typing digits edits, optional "off" state for money and limits), text and secrets (edited
// in place while focused), read-only info and buttons. ↑/↓/Tab/Shift-Tab move between fields. A form
// draws labels, values, a changed mark, a short tag and errors; the focused field's description is
// for the page's help (`fieldHelp`), and a description strip, section notes and hints are drawn only
// when a page asks. A disabled field says why only when it is tried (`onRefuse`). Keys must be
// distinct (checked).
//
// The form changes field values itself and reports what happened: `formKey` returns false (not
// used), true (used) or an event — a committed change or a pressed button — for the page to act on.
import { stripVTControlCharacters } from 'node:util';
import type { Key, Mouse } from '../screen.ts';
import { c, type Glyphs } from '../theme.ts';
import { cell, fit, plainText, repeat, width, wrapParagraphs } from '../text.ts';
import { colourless, frame, onBackground, overlay, panel, placeholder, tone, type Rendered, type Size, type Tone } from './compose.ts';
import { createInput, inputKey, inputValue, renderInput, setInputValue, type InputState } from './input.ts';
import { createList, listCapturesText, listKey, listMouse, renderList, selectedItem, type ListState } from './list.ts';
import type { Hint } from './bits.ts';

export type FieldValue = string | number | boolean | undefined;

interface FieldBase {
  /** Identity: focus and events refer to it. */
  key: string;
  label: string;
  /** What the field does: for the page's help (`fieldHelp`), and the strip when a page asks for one. */
  description?: string;
  /** Marked after the value: it differs from what is saved. */
  changed?: boolean;
  /**
   * Drawn faint and inert: the focus can rest on it, and trying to change it calls the form's
   * `onRefuse` with the reason (a string here) instead. The reason is not drawn.
   */
  disabled?: boolean | string;
  /** An error from outside, e.g. a failed save; cleared when the value changes. Drawn under the row. */
  error?: string;
  /** A short word after the value, e.g. `session`. */
  tag?: string;
  /** Muted text at the right end of the row; drawn only when the page asks for hints. */
  hint?: string;
}

export interface ToggleField extends FieldBase { kind: 'toggle'; value: boolean; on?: string; off?: string }
export interface ChoiceOption { value: string; label?: string; description?: string }
export interface ChoiceField extends FieldBase { kind: 'choice'; value: string; options: ChoiceOption[] }
export interface NumberField extends FieldBase {
  kind: 'number';
  /** undefined is "off" and only allowed when `optional`. */
  value: number | undefined;
  min?: number;
  max?: number;
  /** ←/→ step (default 1). */
  step?: number;
  /** Digits after the point, for display and rounding (default 0: integers). */
  decimals?: number;
  /** Allows "off": Delete turns it off, stepping below `min` turns it off, typing turns it on. */
  optional?: boolean;
  offLabel?: string;
  /** Before the number, e.g. "$". */
  prefix?: string;
  /** After the number, e.g. "s". */
  unit?: string;
}
export interface TextField extends FieldBase {
  kind: 'text' | 'secret';
  value: string;
  placeholder?: string;
  /** A message when the value is not acceptable; checked when the field is left or Enter is pressed. */
  validate?: (value: string) => string | undefined;
}
export interface InfoField extends FieldBase {
  kind: 'info'; value: string; tone?: Tone;
  /** Wrap the value onto more rows under itself instead of cutting it (a path, a reason): it is read whole. */
  wrap?: boolean;
}
/** A button; `label` is its text. */
export interface ActionField extends FieldBase { kind: 'action'; danger?: boolean }
export type Field = ToggleField | ChoiceField | NumberField | TextField | InfoField | ActionField;

export interface FormSection { title?: string; description?: string; fields: Field[] }

export type FormEvent =
  | { type: 'change'; key: string; value: FieldValue; field: Field }
  | { type: 'action'; key: string; field: ActionField };

export interface FormState {
  sections: FormSection[];
  /** Key of the focused field. */
  focus?: string;
  /** Text or number being typed into the focused field. Text fields are edited whenever focused. */
  editing?: { key: string; input: InputState; original: string; replace?: boolean };
  dropdown?: { key: string; list: ListState };
  /** The last failed validation of the focused field. */
  invalid?: { key: string; message: string };
  top: number;
  height: number;
  /** Rows of the whole form at the last render (with `top` and `height`: where the view is, for a scrollbar). */
  total?: number;
  /** Written by rendering, for mouse hits: where each visible field row and the dropdown landed. */
  hits: Array<{ key: string; row: number; valueFrom: number }>;
  dropRect?: { top: number; left: number; rows: number; cols: number; pad: number };
  /** Called with a disabled field's reason when the person tries to change it (a page toasts it). */
  onRefuse?: (reason: string, field: Field) => void;
}

/** Two fields with one key would share focus and events: refuse that where the form is built. */
function assertKeys(sections: FormSection[]): void {
  const seen = new Set<string>();
  for (const x of sections.flatMap((sec) => sec.fields)) {
    if (seen.has(x.key)) throw new Error(`form: two fields have the key "${x.key}"; keys must be distinct`);
    seen.add(x.key);
  }
}

export function createForm(sections: FormSection[], o: { focus?: string; onRefuse?: (reason: string, field: Field) => void } = {}): FormState {
  assertKeys(sections);
  const f: FormState = { sections, top: 0, height: 1, hits: [], onRefuse: o.onRefuse };
  const start = o.focus && focusable(fieldOf(f, o.focus)) ? o.focus : focusables(f)[0]?.key;
  if (start) setFocus(f, start);
  return f;
}

export function formFields(f: FormState): Field[] {
  return f.sections.flatMap((s) => s.fields);
}

export function fieldOf(f: FormState, key: string): Field | undefined {
  return formFields(f).find((x) => x.key === key);
}

export function focusedField(f: FormState): Field | undefined {
  return f.focus === undefined ? undefined : fieldOf(f, f.focus);
}

// A disabled field takes the focus too, so trying it can say why (onRefuse); only info rows are passed over.
function focusable(x: Field | undefined): boolean {
  return Boolean(x && x.kind !== 'info');
}

/** Why a disabled field cannot be used, as given (or a plain word when none was). */
function reasonOf(x: Field): string {
  return typeof x.disabled === 'string' && x.disabled.trim() ? x.disabled : 'Not available';
}

/** What the focused field is, for a page's help: its label and description (and the chosen option's). */
export function fieldHelp(f: FormState): { title: string; keys: Hint[]; text: string[] } | undefined {
  const x = focusedField(f);
  if (!x) return undefined;
  const option = x.kind === 'choice' ? x.options.find((op) => op.value === x.value) : undefined;
  const text = [
    x.description ?? '',
    option?.description ? `${plainText(option.label ?? option.value)}: ${option.description}` : '',
    typeof x.disabled === 'string' && x.disabled ? x.disabled : '',
  ].filter(Boolean);
  return text.length ? { title: plainText(x.label), keys: [], text } : undefined;
}

function focusables(f: FormState): Field[] {
  return formFields(f).filter(focusable);
}

/**
 * Replace the sections (after the page reloaded its data), keeping the focus and any text being typed
 * into a field that is still there.
 */
export function setSections(f: FormState, sections: FormSection[]): void {
  assertKeys(sections);
  const before = formFields(f).map((x) => x.key);
  f.sections = sections;
  const keep = f.focus && focusable(fieldOf(f, f.focus)) ? f.focus : nearest(f, before, f.focus);
  if (f.editing && f.editing.key !== keep) f.editing = undefined;
  if (f.dropdown && f.dropdown.key !== keep) f.dropdown = undefined;
  if (f.invalid && f.invalid.key !== keep) f.invalid = undefined;
  f.focus = undefined;
  if (keep) setFocus(f, keep, true);
}

/**
 * Where the focus goes when its field can no longer take it (it became disabled or went away): the next
 * focusable field after where it was, else the one before, never back to the top.
 */
function nearest(f: FormState, before: string[], key: string | undefined): string | undefined {
  const now = formFields(f);
  const at = key === undefined ? -1 : before.indexOf(key);
  if (at >= 0) {
    for (const k of before.slice(at + 1)) { const x = now.find((y) => y.key === k); if (focusable(x)) return k; }
    for (const k of before.slice(0, at).reverse()) { const x = now.find((y) => y.key === k); if (focusable(x)) return k; }
  }
  return focusables(f)[0]?.key;
}

/** Move the focus to `key` without committing anything (programmatic focus). */
export function focusKey(f: FormState, key: string): boolean {
  if (!focusable(fieldOf(f, key))) return false;
  f.editing = undefined;
  f.dropdown = undefined;
  f.invalid = undefined;
  setFocus(f, key);
  return true;
}

function setFocus(f: FormState, key: string, keepEdit = false): void {
  f.focus = key;
  const x = fieldOf(f, key);
  if (x && (x.kind === 'text' || x.kind === 'secret') && !(keepEdit && f.editing?.key === key)) {
    f.editing = { key, input: createInput({ value: x.value, mask: x.kind === 'secret', placeholder: x.placeholder }), original: x.value };
  }
}

/** True while keys are typed into a field: single-letter shortcuts must not fire. */
export function formCapturesText(f: FormState): boolean {
  return Boolean(f.editing) || Boolean(f.dropdown && listCapturesText(f.dropdown.list));
}

function fmtNumber(x: NumberField, v = x.value): string {
  if (v === undefined) return x.offLabel ?? 'off';
  return `${x.prefix ?? ''}${v.toFixed(x.decimals ?? 0)}${x.unit ? ` ${x.unit}` : ''}`;
}

function changed(x: Field, value: FieldValue): FormEvent {
  x.error = undefined;
  return { type: 'change', key: x.key, value, field: x };
}

/** Finish typing into the focused field. 'invalid' keeps the focus there with a message. */
function commit(f: FormState): FormEvent | 'invalid' | undefined {
  const e = f.editing;
  if (!e) return undefined;
  const x = fieldOf(f, e.key);
  if (!x) { f.editing = undefined; return undefined; }
  const raw = inputValue(e.input);
  if (x.kind === 'text' || x.kind === 'secret') {
    const message = x.validate?.(raw);
    if (message) { f.invalid = { key: x.key, message }; return 'invalid'; }
    f.invalid = undefined;
    f.editing = undefined;
    if (raw === e.original) return undefined;
    x.value = raw;
    return changed(x, raw);
  }
  if (x.kind === 'number') {
    const text = raw.trim();
    let value: number | undefined;
    if (!text) {
      if (!x.optional) { f.invalid = { key: x.key, message: 'Enter a number.' }; return 'invalid'; }
      value = undefined;
    } else {
      // Plain decimal notation only: Number() would also take 0x10, 0b11, 1e3 and Infinity.
      const n = DECIMAL.test(text) ? Number(text) : NaN;
      if (!Number.isFinite(n)) { f.invalid = { key: x.key, message: `"${plainText(text)}" is not a number.` }; return 'invalid'; }
      const d = x.decimals ?? 0;
      value = Number(n.toFixed(d));
      if ((x.min !== undefined && value < x.min) || (x.max !== undefined && value > x.max)) {
        const range = x.min !== undefined && x.max !== undefined ? `between ${fmtNumber(x, x.min)} and ${fmtNumber(x, x.max)}`
          : x.min !== undefined ? `at least ${fmtNumber(x, x.min)}` : `at most ${fmtNumber(x, x.max)}`;
        f.invalid = { key: x.key, message: `Must be ${range}.` };
        return 'invalid';
      }
    }
    f.invalid = undefined;
    f.editing = undefined;
    if (value === x.value) return undefined;
    x.value = value;
    return changed(x, value);
  }
  f.editing = undefined;
  return undefined;
}

/** Commit, then move the focus by `delta` fields; stays put (consumed) when the value is invalid. */
function moveFocus(f: FormState, delta: number): boolean | FormEvent {
  const r = commit(f);
  if (r === 'invalid') return true;
  const list = focusables(f);
  if (!list.length) return r ?? false;
  const at = Math.max(0, list.findIndex((x) => x.key === f.focus));
  const next = list[Math.max(0, Math.min(list.length - 1, at + delta))]!;
  if (next.key !== f.focus) { f.invalid = undefined; setFocus(f, next.key); }
  return r ?? true;
}

function step(x: NumberField, dir: 1 | -1): FormEvent | true {
  const s = x.step ?? 1;
  const d = x.decimals ?? 0;
  let v: number | undefined;
  if (x.value === undefined) {
    if (dir < 0) return true;
    v = x.min ?? 0;
  } else {
    v = Number((x.value + dir * s).toFixed(d));
    // A step finer than the digits shown rounds back to the same value: move by one shown digit instead.
    if (v === x.value) v = Number((x.value + dir * 10 ** -d).toFixed(d));
    if (x.min !== undefined && v < x.min) v = x.optional ? undefined : x.min;
    if (v !== undefined && x.max !== undefined && v > x.max) v = x.max;
  }
  if (v === x.value) return true;
  x.value = v;
  return changed(x, v);
}

function cycle(x: ChoiceField, dir: 1 | -1): FormEvent | true {
  if (!x.options.length) return true;
  const at = x.options.findIndex((o) => o.value === x.value);
  const next = x.options[((at < 0 ? 0 : at + dir) + x.options.length) % x.options.length]!;
  if (next.value === x.value) return true;
  x.value = next.value;
  return changed(x, next.value);
}

function openDropdown(f: FormState, x: ChoiceField): void {
  // Names only: an option's description is for help, not the list.
  const list = createList(x.options.map((o) => ({ id: o.value, label: o.label ?? o.value })), {
    selected: x.value, filter: 'type', sort: true,
  });
  f.dropdown = { key: x.key, list };
}

function choose(f: FormState): boolean | FormEvent {
  const d = f.dropdown;
  if (!d) return false;
  f.dropdown = undefined;
  const x = fieldOf(f, d.key);
  const picked = selectedItem(d.list);
  if (!x || x.kind !== 'choice' || !picked || picked.id === x.value) return true;
  x.value = picked.id;
  return changed(x, picked.id);
}

const NUMERIC = /^[0-9.]$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Apply a key. False when the form did not use it; true or an event when it did. */
export function formKey(f: FormState, k: Key): boolean | FormEvent {
  if (f.dropdown) {
    if (k.name === 'enter') return choose(f);
    if (listKey(f.dropdown.list, k)) return true;
    if (k.name === 'escape' || k.name === 'tab' || k.name === 'shift-tab') { f.dropdown = undefined; return true; }
    return true;
  }
  const x = focusedField(f);
  if (!x) return false;
  switch (k.name) {
    case 'up': case 'shift-tab': return moveFocus(f, -1);
    case 'down': case 'tab': return moveFocus(f, 1);
    case 'pageup': return moveFocus(f, -Math.max(1, f.height - 4));
    case 'pagedown': return moveFocus(f, Math.max(1, f.height - 4));
    case 'escape': {
      const e = f.editing;
      if (!e) return false;
      if (x.kind === 'number') { f.editing = undefined; f.invalid = undefined; return true; }
      if (inputValue(e.input) !== e.original || f.invalid) { setInputValue(e.input, e.original); f.invalid = undefined; return true; }
      return false;
    }
  }
  if (f.editing) {
    if (k.name === 'enter') {
      const r = commit(f);
      if (r === 'invalid') return true;
      if (x.kind === 'text' || x.kind === 'secret') { const m = moveFocus(f, 1); return r ?? m; }
      return r ?? true;
    }
    if (x.kind === 'number' && k.name === 'char' && !NUMERIC.test(k.ch) && k.ch !== '-') return true;
    // A number opened with Enter shows its value; the first thing typed replaces it, as in a selected field.
    if (f.editing.replace) {
      f.editing.replace = false;
      if (k.name === 'char' || k.name === 'paste' || k.name === 'backspace') setInputValue(f.editing.input, '');
      if (k.name === 'backspace') return true;
    }
    const before = inputValue(f.editing.input);
    const used = inputKey(f.editing.input, k);
    if (inputValue(f.editing.input) !== before) f.invalid = undefined;
    return used === true;
  }
  const activate = k.name === 'enter' || (k.name === 'char' && k.ch === ' ');
  if (x.disabled) {
    // Trying to change it says why; nothing else happens. A key the field would not take when enabled
    // (a page shortcut, ? for help, a digit for a tab) is left alone.
    const typing = k.name === 'char' && (x.kind === 'text' || x.kind === 'secret' || (x.kind === 'number' && /^[+=-]$/.test(k.ch)));
    const tries = activate || typing || k.name === 'paste'
      || (x.kind !== 'action' && (k.name === 'left' || k.name === 'right' || k.name === 'delete' || k.name === 'backspace'));
    if (!tries) return false;
    f.onRefuse?.(reasonOf(x), x);
    return true;
  }
  switch (x.kind) {
    case 'toggle':
      if (activate || k.name === 'left' || k.name === 'right') { x.value = !x.value; return changed(x, x.value); }
      return false;
    case 'choice':
      if (k.name === 'left') return cycle(x, -1);
      if (k.name === 'right') return cycle(x, 1);
      if (activate) { openDropdown(f, x); return true; }
      return false;
    case 'number': {
      // `-` steps down when the field cannot go below zero, else it starts typing a negative number.
      if (k.name === 'left' || (k.name === 'char' && k.ch === '-' && x.min !== undefined && x.min >= 0)) return step(x, -1);
      if (k.name === 'right' || (k.name === 'char' && (k.ch === '+' || k.ch === '='))) return step(x, 1);
      const begin = (text: string, replace = false) => {
        f.editing = { key: x.key, input: createInput({ value: text }), original: x.value === undefined ? '' : String(x.value), replace };
      };
      // Digits are not typed into a field that is only focused: they stay tab keys. Enter starts typing.
      if (k.name === 'char' && k.ch === '-') { begin('-'); return true; }
      if (k.name === 'enter') { begin(x.value === undefined ? '' : String(x.value), true); return true; }
      if ((k.name === 'delete' || k.name === 'backspace') && x.optional) {
        if (x.value === undefined) return true;
        x.value = undefined;
        return changed(x, undefined);
      }
      if (k.name === 'backspace') { begin(x.value === undefined ? '' : String(x.value).slice(0, -1)); return true; }
      return false;
    }
    case 'action':
      if (activate) return { type: 'action', key: x.key, field: x };
      return false;
    default:
      return false;
  }
}

/** Where the form is scrolled to, for a panel's scrollbar (`panel(…, { scroll: () => formScroll(form) })`). */
export function formScroll(f: FormState): { top: number; total: number; visible: number } {
  return { top: f.top, total: f.total ?? 0, visible: f.height };
}

/** Key hints for the focused field, for the page's footer. */
export function formHints(f: FormState): Hint[] {
  if (f.dropdown) return [{ key: '↑↓', label: 'choose' }, { key: 'enter', label: 'select' }, { key: 'esc', label: 'close' }];
  const x = focusedField(f);
  const nav = { key: '↑↓', label: 'field' };
  if (!x) return [];
  if (f.editing) {
    if (x.kind === 'number') return [{ key: 'enter', label: 'set' }, { key: 'esc', label: 'cancel' }, nav];
    return [nav, { key: 'enter', label: 'next' }, { key: 'esc', label: 'revert' }];
  }
  switch (x.kind) {
    case 'toggle': return [nav, { key: '←→', label: 'change' }, { key: 'space', label: 'toggle' }];
    case 'choice': return [nav, { key: '←→', label: 'change' }, { key: 'enter', label: 'list' }];
    case 'number': return [nav, { key: '←→', label: 'change' }, { key: 'enter', label: 'type' }, ...(x.optional ? [{ key: 'del', label: 'off' }] : [])];
    case 'action': return [nav, { key: 'enter', label: actionWord(x.label) }];
    default: return [nav];
  }
}

/** A button's label as a footer hint after "enter": lower case, no ellipsis, no second "enter". */
function actionWord(label: string): string {
  const t = plainText(label).replace(/(\.\.\.|…)\s*$/u, '').trim().toLowerCase();
  return t.replace(/^enter\s+/, '') || 'press';
}

/** Clicks focus a row; a click on the focused value toggles, opens the list, or presses the button. */
export function formMouse(f: FormState, m: Mouse): boolean | FormEvent {
  if (f.dropdown && f.dropRect) {
    const r = f.dropRect;
    const inside = m.row >= r.top && m.row < r.top + r.rows && m.col >= r.left && m.col < r.left + r.cols;
    if (m.kind === 'press' && !inside) { f.dropdown = undefined; return true; }
    if (!inside) return true;
    const res = listMouse(f.dropdown.list, { ...m, row: m.row - r.top - 1, col: m.col - r.left - 1 - r.pad });
    if (m.kind === 'press' && res) return choose(f);
    return true;
  }
  if (m.kind === 'wheel-up') return moveFocus(f, -1);
  if (m.kind === 'wheel-down') return moveFocus(f, 1);
  if (m.kind !== 'press' || m.button !== 'left') return false;
  const hitRow = f.hits.find((h) => h.row === m.row);
  if (!hitRow) return false;
  const x = fieldOf(f, hitRow.key);
  if (!x || !focusable(x)) return false;
  if (x.disabled && f.focus === x.key && m.col >= hitRow.valueFrom) { f.onRefuse?.(reasonOf(x), x); return true; }
  if (f.focus !== x.key) {
    const r = commit(f);
    if (r === 'invalid') return true;
    f.invalid = undefined;
    setFocus(f, x.key);
    if (x.kind !== 'action' || m.col < hitRow.valueFrom) return r ?? true;
  }
  if (m.col < hitRow.valueFrom) return true;
  switch (x.kind) {
    case 'toggle': x.value = !x.value; return changed(x, x.value);
    case 'choice': openDropdown(f, x); return true;
    case 'action': return { type: 'action', key: x.key, field: x };
    default: return true;
  }
}

interface Row { kind: 'section' | 'note' | 'why' | 'blank' | 'field' | 'more' | 'error'; text?: string; field?: Field }

/** The error a field shows: its failed validation while focused, or one from outside. */
function errorOf(f: FormState, x: Field): string | undefined {
  return (f.invalid && f.invalid.key === x.key ? f.invalid.message : undefined) ?? x.error;
}

/**
 * Rows of the form; `valueW` is where a wrapped info value and an error continue (under the value).
 * Section notes and disabled reasons only when the page asks for them.
 */
function rowsOf(f: FormState, w: number, indent: number, valueW: number, o: FormRenderOptions, g: Glyphs, errors: boolean): Row[] {
  const rows: Row[] = [];
  f.sections.forEach((s, i) => {
    if (i > 0) rows.push({ kind: 'blank' });
    if (s.title && o.titles !== false) rows.push({ kind: 'section', text: s.title });
    // Long words (paths) are broken across rows, never cut.
    if (s.description && o.notes) for (const l of wrapParagraphs(s.description, Math.max(1, w), 3)) rows.push({ kind: 'note', text: l });
    for (const x of s.fields) {
      rows.push({ kind: 'field', field: x });
      if (x.kind === 'info' && x.wrap && valueW > 0) for (const l of wrapParagraphs(x.value, valueW).slice(1)) rows.push({ kind: 'more', text: l, field: x });
      // An error is data: whole, under the value (the strip shows it instead when there is one).
      const err = errors ? errorOf(f, x) : undefined;
      if (err) {
        const lead = width(g.warn) + 1;
        wrapParagraphs(err, Math.max(1, valueW - lead), 4).forEach((l, j) => rows.push({ kind: 'error', text: `${j ? repeat(' ', lead) : `${g.warn} `}${l}`, field: x }));
      }
      if (typeof x.disabled === 'string' && x.disabled && o.reasons) for (const l of wrapParagraphs(x.disabled, Math.max(1, w - indent), 3)) rows.push({ kind: 'why', text: l });
    }
  });
  return rows;
}

/** What the strip says for a field: its description, then the chosen option's (or the highlighted one's). */
function stripText(f: FormState, x: Field | undefined): string {
  if (!x) return '';
  let option: string | undefined;
  if (x.kind === 'choice') {
    const id = f.dropdown?.key === x.key ? selectedItem(f.dropdown.list)?.id : x.value;
    option = x.options.find((op) => op.value === id)?.description;
  }
  return [x.description, option].filter(Boolean).join(' — ');
}

/** Text rows for the strip: what the longest description needs, from 2 up to a share of the form. */
function stripTextRows(f: FormState, rows: number, cols: number, g: Glyphs): number {
  if (rows < 10) return 1;
  const cap = rows >= 30 ? 6 : rows >= 20 ? 4 : rows >= 16 ? 3 : 2;
  const need = Math.max(2, ...focusables(f).map((x) => wrapParagraphs(stripText(f, x), Math.max(1, cols - 2)).length));
  // An error on the focused field may need more for a moment: it is read whole.
  const error = currentError(f);
  const errNeed = error ? wrapParagraphs(error, Math.max(1, cols - 2 - width(g.warn) - 1)).length : 0;
  return Math.min(cap, Math.max(need, errNeed));
}

function currentError(f: FormState): string | undefined {
  return (f.invalid && f.invalid.key === f.focus ? f.invalid.message : undefined) ?? focusedField(f)?.error;
}

export interface FormRenderOptions {
  focused?: boolean;
  /** The strip under the form with the focused field's description (default false: help has it). */
  strip?: boolean;
  /** Section descriptions under their titles (default false). */
  notes?: boolean;
  /** Fields' right-hand hints (default false). */
  hints?: boolean;
  /** Disabled fields' reasons under their rows (default false: trying the field says why). */
  reasons?: boolean;
  /** Section titles (default true). */
  titles?: boolean;
  /**
   * Scroll so the focused field shows (default true). False leaves the view where it is, for a form
   * shown beside the list that has the focus, so it reads from its top.
   */
  follow?: boolean;
  /** Fix the label column's width; by default it fits the longest label while the values keep their room. */
  labelWidth?: number;
}

/** The label column the form wants: its longest label, two cells of air. */
function labelWidthOf(f: FormState): number {
  return Math.max(4, ...formFields(f).filter((x) => x.kind !== 'action').map((x) => width(plainText(x.label)) + 2));
}

/**
 * The width the form needs, so a page sizes its panel to the form instead of stretching it: the
 * pointer, the label column and the widest value with its mark and tag (a text field gets room for 24).
 */
export function formWidth(f: FormState, g: Glyphs): number {
  return width(g.pointer) + 1 + labelWidthOf(f) + 2 + valuesWidth(f, g);
}

/** The value column the form wants: its widest value with its mark and tag. */
function valuesWidth(f: FormState, g: Glyphs): number {
  const pw = width(g.pointer) + 1;
  const at = tagColumn(f, g);
  const values = formFields(f).map((x) => {
    if (x.kind === 'action') return width(plainText(x.label)) + 4 + (x.tag ? 2 + width(plainText(x.tag)) : 0) - pw - labelWidthOf(f) - 2;
    const shown = value(f, x, 200, g, true);
    const v = x.kind === 'text' || x.kind === 'secret' ? Math.max(24, width(plainText(x.value))) : width(shown.text) - (shown.lead ?? 0);
    return x.tag ? at + 2 + width(plainText(x.tag)) : v + (x.changed ? 1 + width(g.modified) : 0);
  });
  return Math.max(8, ...values);
}

/** Where the tags start, from the value column: after the widest tagged value (focused) and its mark, so they line up. */
function tagColumn(f: FormState, g: Glyphs): number {
  return Math.max(0, ...formFields(f).filter((x) => x.kind !== 'action' && x.tag).map((x) => {
    const shown = value(f, x, 200, g, true);
    return width(shown.text) - (shown.lead ?? 0) + (x.changed ? 1 + width(g.modified) : 0);
  }));
}

/**
 * Where the columns go at `cols`: the labels get what they need while the values keep theirs, and
 * never less than 45% of the width (a long label is cut before a value is).
 */
function columns(f: FormState, cols: number, g: Glyphs, o: FormRenderOptions): { pw: number; labelW: number; valueFrom: number; valueW: number } {
  const pw = width(g.pointer) + 1;
  const cap = Math.max(Math.floor((cols - pw) * 0.45), cols - pw - 2 - valuesWidth(f, g));
  const labelW = Math.max(1, Math.min(o.labelWidth ?? labelWidthOf(f), cap));
  const valueFrom = pw + labelW + 2;
  return { pw, labelW, valueFrom, valueW: Math.max(0, cols - valueFrom) };
}

/** The rows the form draws at `cols` (no strip): a page sizes its panel to it instead of stretching it. */
export function formHeight(f: FormState, cols: number, g: Glyphs, o: FormRenderOptions = {}): number {
  const { pw, valueW } = columns(f, cols, g, o);
  return rowsOf(f, cols - pw, 2, valueW, o, g, true).length;
}

export function renderForm(f: FormState, size: Size, g: Glyphs, o: FormRenderOptions = {}): Rendered {
  const { rows, cols } = size;
  f.hits = [];
  f.dropRect = undefined;
  if (rows <= 0 || cols <= 0) return { lines: frame([], size) };
  const focused = o.focused !== false;
  const textRows = o.strip && rows >= 6 ? stripTextRows(f, rows, cols, g) : 0;
  const stripRows = !o.strip ? 0 : rows >= 10 ? textRows + 1 : rows >= 6 ? 1 : 0;
  const bodyRows = rows - stripRows;
  const { pw, labelW, valueFrom, valueW } = columns(f, cols, g, o);
  const tagAt = tagColumn(f, g);
  const all = rowsOf(f, cols - pw, 2, valueW, o, g, !stripRows);

  // Keep the focused row in view, and its section heading when it is the section's first field.
  const at = o.follow === false ? -1 : all.findIndex((r) => r.field?.key === f.focus);
  f.height = Math.max(1, bodyRows);
  if (at >= 0) {
    let head = at;
    while (head > 0 && !['field', 'blank', 'more'].includes(all[head - 1]!.kind)) head--;
    if (head < f.top) f.top = head;
    if (at < f.top) f.top = at;
    if (at >= f.top + bodyRows) f.top = at - bodyRows + 1;
  }
  f.top = Math.max(0, Math.min(f.top, Math.max(0, all.length - bodyRows)));
  f.total = all.length;

  const lines: string[] = [];
  let cursor: Rendered['cursor'];
  for (let r = f.top; r < Math.min(all.length, f.top + bodyRows); r++) {
    const row = all[r]!;
    if (row.kind === 'blank') { lines.push(''); continue; }
    if (row.kind === 'section') { lines.push(cell(' ' + c.accent.bold(fit(plainText(row.text!), cols - 1)), cols)); continue; }
    if (row.kind === 'note') { lines.push(cell(' ' + c.muted(row.text!), cols)); continue; }
    if (row.kind === 'why') { lines.push(cell(repeat(' ', pw + 2) + c.muted(row.text!), cols)); continue; }
    if (row.kind === 'more') { lines.push(cell(repeat(' ', valueFrom) + tone((row.field as InfoField).tone ?? 'subtle')(row.text!), cols)); continue; }
    if (row.kind === 'error') { lines.push(cell(repeat(' ', valueFrom) + c.bad(row.text!), cols)); continue; }
    const x = row.field!;
    const isFocus = x.key === f.focus;
    const sel = isFocus && focused;
    f.hits.push({ key: x.key, row: lines.length, valueFrom });
    if (x.kind === 'action') {
      const label = plainText(x.label);
      const style = sel ? (x.danger ? c.buttonDanger : c.buttonFocus) : x.disabled ? c.faint : c.button;
      const button = colourless() ? (sel ? `[ ${label} ]` : `  ${label}  `) : style(` ${label} `);
      const after = o.hints && x.hint ? '  ' + c.muted(plainText(x.hint)) : x.tag ? '  ' + c.muted(plainText(x.tag)) : '';
      lines.push(cell(pointer(g, sel, isFocus) + button + after, cols));
      continue;
    }
    // After the value: the changed mark, then a short tag (`session`).
    const mark = x.changed ? ' ' + c.warn(g.modified) : '';
    const labelStyle = x.disabled ? c.faint : sel ? c.text.bold : c.subtle;
    const label = cell(labelStyle(fit(plainText(x.label), labelW)), labelW);
    const room = Math.max(0, valueW - width(mark) - (x.tag ? 2 + width(plainText(x.tag)) : 0));
    const v = x.disabled ? { text: c.faint(stripVTControlCharacters(value(f, x, room, g, false).text)) } : value(f, x, room, g, sel);
    // Tags line up in one column after the widest tagged value.
    const used = width(v.text) - Math.min(2, v.lead ?? 0) + width(mark);
    const tag = x.tag ? repeat(' ', Math.max(2, tagAt + 2 - used)) + c.muted(plainText(x.tag)) : '';
    const marked = v.text + mark + tag;
    const hint = o.hints && x.hint ? c.muted(plainText(x.hint)) : '';
    const lead = Math.min(2, v.lead ?? 0);
    const span = valueW + lead;
    const valuePart = hint && width(marked) + width(hint) + 2 <= span ? cell(marked, span - width(hint) - 1) + ' ' + hint : cell(marked, span);
    let line = pointer(g, sel, isFocus) + label + repeat(' ', 2 - lead) + valuePart;
    if (sel && !colourless()) line = onBackground(line, cols, c.bg);
    if (v.cursor !== undefined) cursor = { row: lines.length, col: valueFrom + v.cursor };
    lines.push(cell(line, cols));
  }
  let out = frame(lines, { rows: bodyRows, cols });

  if (f.dropdown) {
    const hitRow = f.hits.find((h) => h.key === f.dropdown!.key);
    if (hitRow) {
      const list = f.dropdown.list;
      const items = list.items.length + (list.filter === 'type' && list.query ? 1 : 0);
      const widest = Math.max(...list.items.map((i) => width(plainText(i.label)) + (i.detail ? width(plainText(i.detail)) + 2 : 0)), 8);
      // As wide as its options with their descriptions want, moving left over the labels when the
      // value column alone is too narrow, so a description is not cut while the form has room.
      const dw = Math.max(8, Math.min(cols, widest + 6));
      const left = Math.max(0, Math.min(valueFrom - 2, cols - dw));
      const below = bodyRows - hitRow.row - 1;
      const above = hitRow.row;
      const want = items + 2;
      const downward = below >= Math.min(want, 5) || below >= above;
      const dh = Math.max(3, Math.min(want, downward ? below : above));
      const top = downward ? hitRow.row + 1 : Math.max(0, hitRow.row - dh);
      if (dh >= 3 && top + dh <= bodyRows) {
        const box = panel({ rows: dh, cols: dw }, { g, focused: true, mark: false }, (inner) => renderList(list, inner, g, { focused: true }));
        out = overlay(out, box.lines, top, left);
        f.dropRect = { top, left, rows: dh, cols: dw, pad: 1 };
        cursor = undefined;
      }
    }
  }

  if (stripRows) {
    const x = focusedField(f);
    const error = currentError(f);
    const room = textRows;
    const lead = width(g.warn) + 1;
    // Errors and descriptions wrap with long words (paths) broken across rows, never cut.
    const errLines = error ? wrapParagraphs(error, Math.max(1, cols - 2 - lead), room).map((l, i) => c.bad((i ? repeat(' ', lead) : `${g.warn} `) + l)) : [];
    const desc = stripText(f, x);
    const left = room - errLines.length;
    const descLines = left > 0 && desc ? wrapParagraphs(desc, Math.max(1, cols - 2), left).map((l) => c.muted(l)) : [];
    const text = [...errLines, ...descLines];
    const strip = stripRows > 1 ? [c.faint(repeat(g.h, cols)), ...text.map((l) => ' ' + l)] : text.map((l) => ' ' + l);
    out = [...out, ...frame(strip, { rows: stripRows, cols })];
  }
  return { lines: frame(out, size), cursor };
}

function pointer(g: Glyphs, sel: boolean, isFocus: boolean): string {
  const pw = width(g.pointer) + 1;
  return sel ? c.accent(g.pointer) + ' ' : isFocus ? cell(c.muted(g.pointerIdle), pw) : repeat(' ', pw);
}

/**
 * A field's value as drawn. `lead` is how much of it hangs left of the value column: the focused
 * value's ‹ arrow sits in the gap after the label, so every value starts in the same column.
 */
function value(f: FormState, x: Field, w: number, g: Glyphs, sel: boolean): { text: string; cursor?: number; lead?: number } {
  if (w <= 0) return { text: '' };
  const lead = sel ? width(g.prev) + 1 : 0;
  const arrows = (inner: string) => ({ text: sel ? `${c.accent(g.prev)} ${inner} ${c.accent(g.next)}` : inner, lead });
  switch (x.kind) {
    case 'toggle':
      return { text: x.value ? `${c.ok(g.toggleOn)} ${c.text(plainText(x.on ?? 'on'))}` : `${c.muted(g.toggleOff)} ${c.muted(plainText(x.off ?? 'off'))}` };
    case 'choice': {
      const op = x.options.find((o) => o.value === x.value);
      const label = plainText(op?.label ?? x.value);
      const room = Math.max(1, w - 2 * (width(g.prev) + 1));
      return arrows((sel ? c.text.bold : c.text)(fit(label, room)) + (sel ? ' ' + c.muted(g.caret) : ''));
    }
    case 'number': {
      if (f.editing?.key === x.key) {
        const boxW = Math.max(1, Math.min(w, 18));
        const r = renderInput(f.editing.input, boxW, { focused: sel, field: true });
        return { text: r.line, cursor: r.cursor };
      }
      const text = fmtNumber(x);
      return arrows(x.value === undefined ? c.muted(text) : (sel ? c.text.bold : c.text)(text));
    }
    case 'text': case 'secret': {
      if (f.editing?.key === x.key) {
        const r = renderInput(f.editing.input, w, { focused: sel, field: true });
        return { text: r.line, cursor: r.cursor };
      }
      if (!x.value) return { text: c.faint(placeholder(x.placeholder ?? (x.kind === 'secret' ? 'not set' : ''))) };
      if (x.kind === 'secret') return { text: c.text(repeat(g.mask, Math.min(12, [...x.value].length))) };
      return { text: c.text(plainText(x.value)) };
    }
    case 'info': return { text: tone(x.tone ?? 'subtle')(x.wrap ? (wrapParagraphs(x.value, w)[0] ?? '') : plainText(x.value)) };
    default: return { text: '' };
  }
}
