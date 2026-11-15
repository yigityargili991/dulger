// The Home tab, the front door: three boxes of values, and `?` for what they mean.
//
// - Goal: the composer, focused on arrival. Enter starts, Alt-Enter adds a line, ↑/↓ at its edges recall
//   earlier goals, Ctrl-T (or a click on the switch in its border) picks Run or Plan. Esc leaves it.
// - Runs: the latest runs as glyph, goal, cards, spend and age; Enter opens one on Runs, r resumes.
// - Roles: what stops a run (on top, Enter fixes it), each role's backend, and the few settings that
//   change a run; each row opens the page that changes it.
//
// Tab and Shift-Tab move between the boxes. Data is read in activate(), never while drawing.
import type { Config } from '../../config.ts';
import { MODEL_ROLES, describeRoleModel, type RoleModelSummary } from '../../replModels.ts';
import { runSummaries, type RunSummary } from '../../runs.ts';
import { findSetting, readSetting, rolesAffected, sessionChanges, type SettingKey } from '../../settings.ts';
import { liveLockHolder } from '../../board/lock.ts';
import { history } from '../../ui/prompt.ts';
import { c, type Glyphs } from '../../tui/theme.ts';
import { cell, fit, plainText, width } from '../../tui/text.ts';
import type { Key } from '../../tui/screen.ts';
import {
  compose, createTable, createTextarea, emptyState, follow, hit, panel, pill, renderTable, renderTextarea, selectableRow,
  selectedRow, setRows, setTextareaValue, tableKey, tableMouse, tableScroll, tableWidth, textareaKey, textareaValue,
  type Rect, type Rendered, type Size, type TableRow, type Tone,
} from '../../tui/kit/index.ts';
import { ROLE_NAMES, ROLE_NOUNS, roleGlyph, statusLook, timeAgo } from '../look.ts';
import { cachedReadiness, commitSettings, createLauncher, runProblems, type GoalMode, type Launcher, type RunProblem } from '../run.ts';
import type { AppContext, HelpGroup, Hint, NavParams, Page, PageCommand } from '../types.ts';

export interface HomeOptions {
  /** What starts runs (default: the real launcher). */
  launcher?: Launcher;
}

type Focus = 'composer' | 'setup' | 'runs';
const FOCI: Focus[] = ['composer', 'setup', 'runs'];
/** Runs shown here; the Runs tab has all of them. */
const RECENT = 20;
const PLACEHOLDER = 'What should the agents build?';

// ---- data ----

interface SettingInfo { key: SettingKey; label: string; about: string; when?: (v: unknown) => boolean }
/**
 * The settings that change what a run does, named as Settings names them. Docs is a role row already;
 * the budget shows when there is one, plan approval only when it is skipped.
 */
const RUN_SETTINGS: SettingInfo[] = ([
  { key: 'concurrency', about: 'How many cards are built at the same time.' },
  { key: 'attempts', about: 'How often the reviewer can send a card back before it counts as failed.' },
  { key: 'budget', about: 'The run stops, resumable, once it has spent this much.', when: (v) => v !== undefined },
  { key: 'sandbox', about: 'Whether agents, verify commands and setup run confined. This session only; never saved to the repository.' },
  { key: 'yes', about: 'On: a run builds straight away, nobody reads the plan first. This session only.', when: (v) => Boolean(v) },
] as Array<Omit<SettingInfo, 'label'>>).map((info) => ({ ...info, label: findSetting(info.key)?.label ?? info.key }));

interface Data {
  roles: Array<{ s: RoleModelSummary; changed: boolean }>;
  settings: Array<SettingInfo & { value: string; tone: Tone; changed: boolean }>;
  problems: RunProblem[];
  runs: RunSummary[];
  unfinished: string[];
  approval: boolean;
  /** Runs another dulger process holds now: shown as running, and read again while there are any. */
  held: Set<string>;
}

function load(ctx: AppContext): Data {
  // The readiness checks (a backend's command missing, …) are cached, so this spawns at most every half minute.
  const d: Data = { roles: [], settings: [], problems: [...runProblems(ctx), ...cachedReadiness(ctx)], runs: [], unfinished: [], approval: !ctx.session.yes, held: new Set() };
  let config: Config | undefined;
  try { config = ctx.config(); } catch { config = undefined; }
  if (config) {
    let changes: ReturnType<typeof sessionChanges> | undefined;
    try { changes = sessionChanges(ctx.repoRoot, ctx.session); } catch { changes = undefined; }
    const affected = changes ? rolesAffected(changes, config) : [];
    d.roles = MODEL_ROLES.map((role) => ({ s: describeRoleModel(config, ctx.session, role), changed: affected.includes(role) }));
    d.settings = RUN_SETTINGS.flatMap((info) => {
      const v = readSetting(ctx.session, config, info.key);
      const changed = Boolean(changes?.settings.includes(info.key));
      // A changed setting shows even at its quiet value, so the ✎ is never hidden.
      if (info.when && !info.when(v) && !changed) return [];
      return [{ ...info, ...settingValue(info.key, v), changed }];
    });
  }
  // Newest first by when they started: run ids made in the same minute differ only in a random suffix.
  try { d.runs = runSummaries(ctx.repoRoot).reverse().sort((a, b) => started(b) - started(a)); } catch { d.runs = []; }
  // recoverableRuns' rule, from the summaries already read: readable and not finished.
  d.unfinished = d.runs.filter((r) => r.readable && r.status !== 'finished').map((r) => r.id);
  d.held = new Set(d.runs.slice(0, RECENT).filter((r) => r.readable && liveLockHolder(ctx.repoRoot, r.id) !== undefined).map((r) => r.id));
  return d;
}

function settingValue(key: SettingKey, v: unknown): { value: string; tone: Tone } {
  // Config values are untrusted (a hand-edited config can hold anything), so every displayed value is
  // run through plainText before it is styled and measured. Values read as Settings shows them.
  switch (key) {
    case 'budget': return v === undefined ? { value: 'off', tone: 'muted' } : { value: `$${plainText(String(v))}`, tone: 'text' };
    case 'yes': return v ? { value: 'on', tone: 'warn' } : { value: 'off', tone: 'muted' };
    case 'sandbox': return { value: plainText(String(v)), tone: v === 'off' ? 'muted' : 'ok' };
    default: return { value: plainText(String(v)), tone: 'text' };
  }
}

/** Unreadable boards (no date) go last. */
function started(r: RunSummary): number {
  const t = r.readable ? Date.parse(r.createdAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/** A run as a row: its state's glyph in the state's colour (every state has its own), goal, cards, spend, age. */
function runRow(r: RunSummary, g: Glyphs, now: number, running = false): TableRow {
  const lk = statusLook(r.readable ? r.status : 'unreadable', g, running);
  const icons = [lk.paint(lk.glyph)];
  if (!r.readable) return { id: r.id, cells: ['', r.id, '', '', ''], tones: [undefined, 'muted'], icons };
  const spend = r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : r.spend;
  return {
    id: r.id,
    cells: ['', r.goal, r.cards.total ? `${r.cards.done}/${r.cards.total}` : '-', spend, timeAgo(r.createdAt, now)],
    tones: [undefined, undefined, r.cards.failed ? 'bad' : 'subtle', 'muted', 'muted'],
    icons,
  };
}

/**
 * Earlier goals, most recent first: what was typed in this session (the shared prompt history without its
 * commands and one-word answers), then the goals of earlier runs, so ↑ brings them back after a restart.
 */
function goalHistory(runGoals: readonly string[] = []): string[] {
  const seen = new Set<string>();
  return [...history, ...runGoals].filter((h) => {
    const t = h.trim();
    if (!t || t.startsWith('/') || /^(y|yes|n|no|go|run|dispatch|cancel|quit|exit|q)$/i.test(t) || seen.has(t)) return false;
    seen.add(t);
    return true;
  }).map((h) => h.trim());
}

// ---- the Roles box: one selectable row per thing, blank rows between the groups ----

interface Item {
  id: string;
  left: string;
  right?: string;
  /** For `?`: the row's name and what it is. */
  label: string;
  about: string;
  /** The footer's word for Enter. */
  verb: string;
  go(): void;
}
type Row = Item | null;
interface Hitbox { id: string; row: number }

export function createHomePage(ctx: AppContext, o: HomeOptions = {}): Page {
  // Read again at every render: the Icons setting applies at once.
  let g = ctx.g;
  const launcher = o.launcher ?? createLauncher();
  // Up on the first row and down on the last walk the goal history, like the line prompt's.
  const area = createTextarea({ submitOnEnter: true, history: () => goalHistory(data.runs.flatMap((r) => (r.readable ? [r.goal] : []))) });
  const table = createTable([
    // No header: glyph, goal, cards, spend and age read as what they are; narrow drops the age first.
    { title: '', min: 1 },
    { title: '', flex: 1, min: 16 },
    { title: '', align: 'right' },
    { title: '', align: 'right' },
    { title: '', align: 'right', optional: true },
  ], [], { empty: 'No runs yet' });
  let data: Data = { roles: [], settings: [], problems: [], runs: [], unfinished: [], approval: true, held: new Set() };
  let poll: ReturnType<typeof setInterval> | undefined;
  let focus: Focus = 'composer';
  let mode: GoalMode = 'run';
  let selected = '';
  let setupTop = 0;
  let hits: Hitbox[] = [];
  let rows: Row[] = [];
  let rects: { composer?: Rect; setup?: Rect; runs?: Rect } = {};
  let modeHit: { run: [number, number]; order: [number, number] } | undefined;
  let launching = false;

  const reload = () => {
    data = load(ctx);
    rows = buildRows();
    setRows(table, data.runs.slice(0, RECENT).map((r) => runRow(r, ctx.g, ctx.now(), data.held.has(r.id) && r.readable && r.status === 'in progress / interrupted')));
  };

  /** While a listed run is held by another process, read again each second, so its state is never stale. */
  const watch = () => {
    if (poll || !data.held.size) return;
    poll = setInterval(() => {
      reload();
      if (!data.held.size) unwatch();
      ctx.redraw();
    }, 1000);
    poll.unref?.();
  };
  const unwatch = () => { if (poll) clearInterval(poll); poll = undefined; };

  // ---- actions ----

  const goTo = (page: string, params?: NavParams) => ctx.navigate(page, params);

  const setMode = (m: GoalMode) => { mode = m; };

  async function submit(): Promise<void> {
    const text = textareaValue(area).trim();
    if (launching) return;
    if (!text) { ctx.toast('Type a goal', 'info'); return; }
    if (text.split(/\s+/).length < 3) {
      const ok = await ctx.confirm({
        title: 'Short goal', confirm: mode === 'order' ? 'Plan' : 'Run', cancel: 'Edit',
        message: `${mode === 'order' ? 'Plan' : 'Run'} "${fit(plainText(text), 48)}"`,
      });
      if (!ok) return;
    }
    launching = true;
    try {
      // The goal stays in the box while a launch dialog is open; it goes once a run started from it, and
      // stays for editing when none did (blocked, discarded at the plan, or an error before a run existed).
      const out = await launcher.goal(ctx, text, mode);
      const unused = out.kind === 'blocked' || out.kind === 'cancelled' || (out.kind === 'error' && !out.runId);
      if (!unused && textareaValue(area).trim() === text) setTextareaValue(area, '');
    } finally {
      launching = false;
      ctx.redraw();
    }
  }

  async function resume(id: string | undefined): Promise<void> {
    const run = data.runs.find((r) => r.id === id);
    if (!run || !run.readable || !data.unfinished.includes(run.id)) {
      ctx.toast(data.unfinished.length ? 'Run finished' : 'No unfinished run', 'info');
      return;
    }
    // The launcher asks first: what is left, and which settings when the run's differ from this session's.
    await launcher.resume(ctx, run.id);
  }

  const latestUnfinished = () => data.unfinished[0];
  const selectedRun = () => (data.runs.length ? selectedRow(table)?.id : undefined);
  const selectedUnfinished = () => { const id = selectedRun(); return id && data.unfinished.includes(id) ? id : undefined; };

  const newGoal = (m?: GoalMode) => { if (m) setMode(m); focus = 'composer'; };

  // ---- Goal ----

  const modeBadge = (): string => {
    const chip = (label: string, on: boolean) => (on ? pill(label, 'accent') : c.muted(` ${label} `));
    return chip('Run', mode === 'run') + chip('Plan', mode === 'order');
  };

  /** Rows the text needs at `cols`, for sizing the composer to what was typed. */
  const textRows = (cols: number): number => {
    const w = Math.max(1, cols - 1);
    return textareaValue(area).split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(width(l) / w)), 0);
  };

  /** As tall as what is typed (the placeholder's one row when empty), up to ten rows, five on a short screen. */
  const composerHeight = (size: Size, cols: number): number => {
    const max = size.rows >= 30 ? 10 : 5;
    const text = textareaValue(area) ? textRows(Math.max(1, cols - 4)) : Math.ceil((width(PLACEHOLDER) + 2) / Math.max(1, cols - 4));
    return Math.max(1, Math.min(max, text)) + 2;
  };

  function renderComposer(r: Rect): Rendered {
    const focused = focus === 'composer';
    const span = r.cols - 2;
    const b = modeBadge();
    // Where the mode chips land in the top border (the panel draws ` badge ` before `─╮`), for clicks.
    const wantTitle = width('Goal') + 2;
    const shown = r.rows >= 3 && r.cols >= 6 && 1 + wantTitle + width(b) + 2 + 1 <= span;
    if (shown) {
      const start = r.cols - 2 - (width(b) + 2) + 1;
      const runW = width(mode === 'run' ? pill('Run', 'accent') : c.muted(' Run '));
      modeHit = { run: [start, start + runW], order: [start + runW, start + width(b)] };
    } else modeHit = undefined;
    return panel(r, { g, title: 'Goal', focused, badge: b }, (inner) => {
      area.placeholder = PLACEHOLDER;
      return renderTextarea(area, inner, { focused });
    });
  }

  function composerKey(k: Key): boolean {
    const r = textareaKey(area, k);
    if (r === 'submit') { void submit(); return true; }
    if (r) return true;
    if (k.name === 'escape') { focus = data.runs.length ? 'runs' : 'setup'; return true; }
    return false;
  }

  // ---- Roles ----

  function roleItem(x: { s: RoleModelSummary; changed: boolean }): Item {
    const s = x.s;
    const harness = plainText(s.harness);
    // The model only when it is pinned, as on Models: a routed tier or a backend's default is what the
    // backend does anyway, and help (the focused role) says which models that is.
    const model = (() => {
      if (s.disabled) return '';
      if (s.model === '(model required)') return c.bad('no model');
      return s.mode === 'pinned' ? c.text(plainText(s.model)) : '';
    })();
    const name = ROLE_NAMES[s.role].padEnd(8);
    const noun = ROLE_NOUNS[s.role];
    const left = s.disabled
      ? `${roleGlyph(g, s.role)} ${c.faint(name)} ${c.faint('off')}`
      : `${roleGlyph(g, s.role)} ${c.text(name)} ${c.subtle(harness)}${model ? ` ${model}` : ''}`;
    let about: string;
    if (s.disabled) about = s.role === 'docs' ? 'Off: the documentation agent is turned off. Enter turns it on in Settings.' : 'Off: progress notes are turned off. Enter turns them on in Settings.';
    else if (s.mode === 'pinned') about = `Pinned to ${plainText(s.model)} on ${harness}${s.source === 'session role' ? ' for this session' : s.source === 'global pin' ? ', the model pinned for every role this session' : ' by the saved settings'}. Enter changes it on Models.`;
    else if (s.mode === 'auto tiers' && s.role === 'worker') about = `Auto tiers: ${s.tiers.map((t) => `${plainText(t.model)} for ${t.tier === 'low' ? 'easy' : t.tier} tasks`).join(', ')}; a retry goes one tier up. Enter changes it on Models.`;
    else if (s.mode === 'auto tiers') about = `Auto tiers: the ${s.role === 'planner' || s.role === 'checker' ? 'high' : 'low'} tier, ${plainText(s.model)}. Enter changes it on Models.`;
    else if (s.model === '(model required)') about = `${harness} is an API provider and needs a model named for the ${noun}. Enter chooses one on Models.`;
    else if (s.model === '(harness default)') about = `${harness} picks its own default model. Enter changes it on Models.`;
    else about = `${plainText(s.model)}, the model ${harness} is set up with. Enter changes it on Models.`;
    if (s.missingKeyEnv) about += ` ${plainText(s.missingKeyEnv)} is not set.`;
    if (x.changed) about += ' Changed this session.';
    const go = () => {
      if (s.disabled) goTo('settings', { key: s.role === 'docs' ? 'docs' : 'progress' });
      else goTo('models', { role: s.role });
    };
    return { id: `role:${s.role}`, left, right: x.changed ? c.accent(g.modified) : undefined, label: ROLE_NAMES[s.role], about, verb: 'change', go };
  }

  function settingItems(): Item[] {
    const labelW = Math.max(0, ...data.settings.map((s) => width(s.label)));
    return data.settings.map((s) => ({
      id: `set:${s.key}`,
      left: `${c.muted(cell(s.label, labelW))}  ${(s.tone === 'text' ? c.text.bold : c[s.tone])(s.value)}`,
      right: s.changed ? c.accent(g.modified) : undefined,
      label: s.label,
      about: `${s.about}${s.changed ? ' Changed this session.' : ''} Enter changes it in Settings.`,
      verb: 'change',
      go: () => goTo('settings', { key: s.key }),
    }));
  }

  function problemItem(p: RunProblem): Item {
    const left = `${c.warn(g.warn)} ${c.text(plainText(p.title))}`;
    if (p.commit) {
      return {
        id: `fix:${p.id}`, left, label: p.title, verb: 'commit',
        about: `${p.detail} Enter commits .dulger/config.json (it asks first).`,
        go: () => { void commitSettings(ctx).then((ok) => { if (ok) { reload(); ctx.redraw(); } }); },
      };
    }
    return { id: `fix:${p.id}`, left, label: p.title, about: `${p.detail} Enter opens ${p.fix.label}.`, verb: 'fix', go: () => goTo(p.fix.page, p.fix.params) };
  }

  /** Blockers, roles, settings; a blank row between the groups. */
  function buildRows(): Row[] {
    const groups = [data.problems.map(problemItem), data.roles.map(roleItem), settingItems()].filter((x) => x.length);
    return groups.flatMap((gr, i) => (i ? [null, ...gr] : gr));
  }

  const items = (): Item[] => rows.filter((r): r is Item => r !== null);
  const currentItem = (): Item | undefined => items().find((i) => i.id === selected) ?? items()[0];

  /** How wide the Roles box wants to be: its widest row, the pointer, the border and padding. */
  const setupWidth = (): number => {
    const pw = width(g.pointer) + 1;
    return Math.max(16, ...items().map((it) => pw + width(it.left) + (it.right ? 1 + width(it.right) : 0))) + 4;
  };

  function renderSetup(r: Rect): Rendered {
    const focused = focus === 'setup';
    const innerH = Math.max(1, r.rows - 2);
    // Short of room, the blank rows go first.
    const shown = rows.length <= innerH ? rows : rows.filter((x) => x !== null);
    if (!items().some((i) => i.id === selected)) selected = items()[0]?.id ?? '';
    const cur = currentItem();
    return panel(r, {
      g, title: 'Roles', focused,
      scroll: () => (shown.length > innerH ? { top: setupTop, total: shown.length, visible: innerH } : undefined),
    }, (inner) => {
      hits = [];
      const selRow = shown.findIndex((x) => x?.id === cur?.id);
      setupTop = follow(setupTop, Math.max(0, selRow), inner.rows, shown.length);
      const lines: string[] = [];
      for (let i = setupTop; i < Math.min(shown.length, setupTop + inner.rows); i++) {
        const it = shown[i];
        if (!it) { lines.push(''); continue; }
        const pw = width(g.pointer) + 1;
        const body = it.right && width(it.left) + width(it.right) + 1 <= inner.cols - pw ? `${it.left} ${it.right}` : it.left;
        hits.push({ id: it.id, row: lines.length });
        lines.push(selectableRow(body, inner.cols, g, it.id === cur?.id, focused));
      }
      return lines;
    });
  }

  function moveSetup(dir: 'up' | 'down' | 'home' | 'end'): void {
    const all = items();
    if (!all.length) return;
    const idx = Math.max(0, all.findIndex((i) => i.id === selected));
    const to = dir === 'home' ? 0 : dir === 'end' ? all.length - 1 : idx + (dir === 'up' ? -1 : 1);
    selected = all[Math.max(0, Math.min(all.length - 1, to))]!.id;
  }

  function setupKey(k: Key): boolean {
    switch (k.name) {
      case 'up': case 'down': case 'home': case 'end': moveSetup(k.name); return true;
      case 'left': moveSetup('up'); return true;
      case 'right': moveSetup('down'); return true;
      case 'enter': currentItem()?.go(); return true;
      case 'char':
        if (k.ch === 'j') { moveSetup('down'); return true; }
        if (k.ch === 'k') { moveSetup('up'); return true; }
        if (k.ch === 'g') { moveSetup('home'); return true; }
        if (k.ch === 'G') { moveSetup('end'); return true; }
        return false;
      default: return false;
    }
  }

  // ---- Runs ----

  function renderRuns(r: Rect): Rendered {
    const focused = focus === 'runs';
    const n = data.unfinished.length;
    return panel(r, {
      g, title: 'Runs', focused,
      badge: n ? c.info(`${g.play}${n}`) : undefined,
      scroll: () => (table.rows.length ? tableScroll(table) : undefined),
    }, (inner) => {
      if (!data.runs.length) return emptyState(inner, { title: 'No runs yet' }, g);
      return renderTable(table, inner, g, { focused, header: false });
    });
  }

  function runsKey(k: Key): boolean {
    if (tableKey(table, k)) return true;
    if (k.name === 'enter') { const id = selectedRun(); if (id) goTo('runs', { run: id }); return true; }
    return false;
  }

  // ---- layout ----

  /**
   * How wide the goal and the runs want to be: the runs' columns with the longest goal whole (the
   * table's own natural width caps a column), the placeholder, the border's switch; at most 100.
   */
  const leftWidth = (): number => {
    const goalW = Math.max(0, ...table.rows.map((r) => width(plainText(r.cells[1] ?? ''))));
    // The goal column at its whole width, never under its 16-cell minimum (narrower drops the age).
    const runsW = data.runs.length ? tableWidth(table, g) - Math.min(goalW, 32) + Math.max(goalW, 16) + 4 : width('No runs yet') + 8;
    return Math.min(100, Math.max(40, runsW, width(PLACEHOLDER) + 5, width('Goal') + width(modeBadge()) + 10));
  };

  /** The Runs box's rows: one per run shown, or the empty state's one. */
  const runsHeight = (): number => Math.max(1, table.rows.length) + 2;

  /**
   * Each box as tall as its rows and as wide as its content, up to the room there is (a box that does
   * not fit scrolls). Roles sits beside the goal and the runs while those keep 36 columns; else the
   * three are stacked, and on a short screen the last ones give way, the focused one always shown.
   */
  function layout(size: Size): { composer?: Rect; setup?: Rect; runs?: Rect } {
    const all: Rect = { top: 0, left: 0, ...size };
    // Too small for three boxes: only the focused one, whole.
    if (size.rows < 9 || size.cols < 30) return { [focus]: all };
    const right = Math.min(setupWidth(), 48, size.cols);
    const setupNat = rows.length + 2;
    if (size.cols - right - 1 >= 36) {
      const leftW = Math.max(36, Math.min(leftWidth(), size.cols - right - 1));
      const compH = Math.min(size.rows, composerHeight(size, leftW));
      const runsH = Math.max(0, Math.min(size.rows - compH, runsHeight()));
      return {
        composer: { top: 0, left: 0, rows: compH, cols: leftW },
        runs: { top: compH, left: 0, rows: runsH, cols: leftW },
        setup: { top: 0, left: leftW + 1, rows: Math.min(size.rows, setupNat), cols: right },
      };
    }
    const w = Math.min(size.cols, Math.max(leftWidth(), right));
    const compH = composerHeight(size, w);
    const rest = size.rows - compH;
    // The roles first, leaving the runs at least three rows when there is room for them.
    const setupH = Math.min(setupNat, Math.max(3, rest - Math.min(runsHeight(), 3)));
    const runsH = Math.max(0, Math.min(runsHeight(), rest - setupH));
    const stacked = {
      composer: { top: 0, left: 0, rows: compH, cols: w },
      setup: { top: compH, left: 0, rows: setupH, cols: w },
      runs: { top: compH + setupH, left: 0, rows: runsH, cols: w },
    };
    // The focused box always shows, alone if need be.
    return (stacked[focus]?.rows ?? 0) >= 3 ? stacked : { [focus]: all };
  }

  const cycle = (d: 1 | -1) => { focus = FOCI[(FOCI.indexOf(focus) + d + FOCI.length) % FOCI.length]!; };

  // ---- help, hints, commands ----

  const enter = g.enter;
  const toggle = (): Hint => ({ key: '^t', label: mode === 'run' ? 'plan' : 'run' });
  const hints = (): Hint[] => {
    if (focus === 'composer') return [{ key: enter, label: mode === 'run' ? 'start' : 'plan' }, toggle(), { key: 'tab', label: 'next' }];
    if (focus === 'setup') return [{ key: enter, label: currentItem()?.verb ?? 'open' }, { key: '↑↓', label: 'move' }, { key: 'tab', label: 'next' }];
    if (!data.runs.length) return [{ key: 'n', label: 'goal' }, { key: 'tab', label: 'next' }];
    return [
      { key: enter, label: 'open' },
      ...(selectedUnfinished() ? [{ key: 'r', label: 'resume' }] : []),
      { key: 'n', label: 'goal' }, { key: 'tab', label: 'next' },
    ];
  };

  const RUN_TEXT = 'Run: the planner splits the goal into cards and waits at the plan for your go (unless Skip plan approval is on). Workers build each card in its own worktree, a reviewer checks every card, and the result lands on its own branch for you to review and merge.';
  const PLAN_TEXT = 'Plan: talk the plan through with the planner before anything is built; it is built once you say go.';

  /** `?` leads with what has focus: the goal box, the selected row, the selected run. */
  function focusedGroup(): HelpGroup | undefined {
    if (focus === 'composer') return { title: mode === 'run' ? 'Goal · Run' : 'Goal · Plan', text: mode === 'run' ? RUN_TEXT : PLAN_TEXT, keys: [] };
    if (focus === 'setup') { const it = currentItem(); return it ? { title: plainText(it.label), text: it.about, keys: [] } : undefined; }
    const run = data.runs.find((r) => r.id === selectedRun());
    if (!run) return undefined;
    if (!run.readable) return { title: run.id, text: 'Its board cannot be read. Enter opens it on Runs, which says why.', keys: [] };
    const lk = statusLook(run.status, g, data.held.has(run.id) && run.status === 'in progress / interrupted');
    const resumable = data.unfinished.includes(run.id) ? ' r resumes it.' : '';
    return { title: fit(plainText(run.goal), 60), text: `${run.id}: ${lk.label}, ${run.cards.done} of ${run.cards.total} cards done. Enter opens it on Runs.${resumable}`, keys: [] };
  }

  const help = (): HelpGroup[] => {
    const groups: Record<Focus, HelpGroup> = {
      composer: { title: 'Goal', keys: [
        { key: enter, label: 'start it' },
        { key: `alt-${enter}`, label: 'add a line' },
        { key: '^t', label: 'Run or Plan' },
        { key: '↑↓', label: 'earlier goals' },
        { key: 'esc', label: 'leave the goal box' },
      ] },
      setup: { title: 'Roles', keys: [
        { key: '↑↓', label: 'move' },
        { key: enter, label: 'fix or change it' },
      ] },
      runs: { title: 'Runs', keys: [
        { key: '↑↓', label: 'move' },
        { key: enter, label: 'open on Runs' },
        { key: 'r', label: 'resume unfinished' },
      ] },
    };
    return [
      ...[focusedGroup()].filter((x): x is HelpGroup => Boolean(x)),
      groups[focus],
      ...FOCI.filter((f) => f !== focus).map((f) => groups[f]),
      { title: 'Home', keys: [
        { key: 'tab  shift-tab', label: 'next / previous box' },
        { key: 'n', label: 'type a new goal' },
      ] },
      { title: 'About', keys: [], text: [
        `Roles: what stops a run (${g.warn}) comes first; then each role's backend, with its model when one is pinned; then the settings that change a run. ${g.modified} marks what this session changed. Enter opens the page that fixes or changes a row.`,
        `Runs: the latest ${RECENT}, newest first, with their cards done, spend and age; ${g.play}N counts the unfinished ones. All of them are on the Runs tab.`,
      ] },
    ];
  };

  const commands = (): PageCommand[] => {
    const text = textareaValue(area).trim();
    // The selected run when it is unfinished (as r does on Runs), else the latest unfinished one.
    const latest = selectedUnfinished() ?? latestUnfinished();
    return [
      { id: 'new', title: 'New goal', shortcut: 'n', run: () => newGoal('run') },
      { id: 'together', title: 'Plan a goal', run: () => newGoal('order') },
      { id: 'start', title: mode === 'order' ? 'Plan this goal' : 'Start this goal', shortcut: enter, disabled: text ? undefined : 'No goal', run: () => submit() },
      { id: 'mode', title: mode === 'run' ? 'Switch to Plan' : 'Switch to Run', shortcut: '^t', run: () => setMode(mode === 'run' ? 'order' : 'run') },
      { id: 'resume', title: 'Resume run', shortcut: 'r', disabled: latest ? undefined : 'No unfinished run', run: () => resume(latest) },
      { id: 'clear', title: 'Clear the goal', disabled: text ? undefined : 'Goal box empty', run: () => { setTextareaValue(area, ''); } },
      ...data.problems.map((p) => ({ id: `fix:${p.id}`, title: `Fix: ${p.title}`, run: () => goTo(p.fix.page, p.fix.params) })),
    ];
  };

  return {
    id: 'home',
    title: 'Home',
    activate() {
      reload();
      watch();
      focus = 'composer';
      // Arriving shows the newest run selected, so r and Enter act on what was just done.
      table.index = 0;
    },
    deactivate: unwatch,
    dispose: unwatch,
    render(size) {
      g = ctx.g;
      rows = buildRows();
      rects = layout(size);
      const parts: Array<{ rect: Rect; block: Rendered }> = [];
      // The composer last, so its cursor is the one kept.
      if (rects.setup) parts.push({ rect: rects.setup, block: renderSetup(rects.setup) });
      if (rects.runs) parts.push({ rect: rects.runs, block: renderRuns(rects.runs) });
      if (rects.composer) parts.push({ rect: rects.composer, block: renderComposer(rects.composer) });
      return compose(size, parts);
    },
    onKey(k) {
      if (k.name === 'tab' || k.name === 'shift-tab') { cycle(k.name === 'tab' ? 1 : -1); return true; }
      if (k.name === 'ctrl' && k.ch === 't') { setMode(mode === 'run' ? 'order' : 'run'); return true; }
      if (focus === 'composer') return composerKey(k);
      if (k.name === 'char' && (k.ch === 'n' || k.ch === 'i')) { newGoal(); return true; }
      if (k.name === 'char' && k.ch === 'r') { void resume(focus === 'runs' ? selectedUnfinished() ?? latestUnfinished() : latestUnfinished()); return true; }
      return focus === 'setup' ? setupKey(k) : runsKey(k);
    },
    onMouse(m) {
      const inComposer = rects.composer && hit(m, rects.composer);
      if (inComposer) {
        if (m.kind !== 'press') return true;
        focus = 'composer';
        if (inComposer.row === 0 && modeHit) {
          if (inComposer.col >= modeHit.run[0] && inComposer.col < modeHit.run[1]) setMode('run');
          else if (inComposer.col >= modeHit.order[0] && inComposer.col < modeHit.order[1]) setMode('order');
        }
        return true;
      }
      const inSetup = rects.setup && hit(m, rects.setup);
      if (inSetup) {
        if (m.kind === 'wheel-up' || m.kind === 'wheel-down') { moveSetup(m.kind === 'wheel-up' ? 'up' : 'down'); return true; }
        if (m.kind !== 'press') return true;
        // The first click on a box only focuses it; a click on the selected row of a focused one opens it.
        const was = focus;
        focus = 'setup';
        // Content starts one row down (the border).
        const box = hits.find((h) => h.row === inSetup.row - 1);
        if (box) { if (box.id === selected && was === 'setup') currentItem()?.go(); else selected = box.id; }
        return true;
      }
      const inRuns = rects.runs && hit(m, rects.runs);
      if (inRuns) {
        const was = focus;
        if (m.kind === 'press') focus = 'runs';
        const r = tableMouse(table, { ...inRuns, row: inRuns.row - 1, col: inRuns.col - 2 });
        if (r === 'activate' && was === 'runs') { const id = selectedRun(); if (id) goTo('runs', { run: id }); }
        return true;
      }
      return false;
    },
    hints,
    help,
    commands,
    capturesText: () => focus === 'composer',
    badge: () => (data.problems.length ? `${g.warn}${data.problems.length}` : undefined),
  };
}
