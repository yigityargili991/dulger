// The plan editor: an unstarted run's cards on the left, the selected card's editor on the right.
// Every value is its own row — title, description, each acceptance criterion, a checkbox per card it
// may wait for, each verify command shown whole, the worker, each task — edited in a dialog, never as
// typed syntax. Edits go to a draft; Save validates the whole plan (savePlanDraft) and records it.
// The page shows labels and values only: a status line appears only for an error or unsaved edits, and
// `?` explains the selected row (rowHelp), the keys and the page.
//
// Locking: while the page is visible it holds the run's execution lock, as /edit does for its whole
// edit. It is released on every deactivate (a tab switch, suspend, leaving) and taken again on
// activate, when the board is re-read: a plan that started meanwhile is blocked, one changed by
// someone else is reloaded or, with edits pending, the person chooses. Nothing can leak: no path keeps
// the lock while hidden, and dispose releases it once more. A caller that holds the lock itself (a
// live run) passes `lockHeld`, and the page then never takes or releases it.
//
// Leaving: the shell asks canLeave before the page is dropped (Esc, Back, navigate, quit); unsaved
// edits are asked about there. dispose tells the caller, exactly once, whether the plan was saved.
import { acquireRunLock } from '../../board/lock.ts';
import { loadBoard } from '../../board/store.ts';
import { BUILTIN_HARNESSES, harnessNames, type Config } from '../../config.ts';
import { planEditBlocker, savePlanDraft, validatePlanDraft } from '../../planEditor.ts';
import { candidateModels } from '../../replModels.ts';
import { originalSettings } from '../../runSettings.ts';
import type { Board, Card } from '../../types.ts';
import { c, type Glyphs } from '../../tui/theme.ts';
import { cell, fit, pasteText, plainText, repeat, width, wrapParagraphs } from '../../tui/text.ts';
import { shownCommand } from '../../tui/view.ts';
import {
  badge, compose, emptyState, frame, hit, noticeModal, panel, splitCols, splitRows, type HelpGroup, type Hint, type Rect, type Rendered, type Size,
} from '../../tui/kit/index.ts';
import type { Key } from '../../tui/screen.ts';
import type { AppContext, LeaveReason, Page, PageCommand } from '../types.ts';
import { buildSections, cardsWidth, changedCards, renderCards, renderEditor, rowHelp, type EditorRow, type Section } from './planEdit.rows.ts';

export interface PlanEditOptions {
  /** Called exactly once when the editor closes, however it closes: true when the plan was saved. */
  done?(saved: boolean): void;
  /** The caller holds the run's execution lock for the whole edit (a live run): never take or release it. */
  lockHeld?: boolean;
}

type State = 'ready' | 'blocked' | 'locked' | 'error';
const EMPTY_RECT: Rect = { top: 0, left: 0, rows: 0, cols: 0 };
const HISTORY = 100;

/** Edit an unstarted run's plan (cards, tasks, dependencies, verify commands, worker). Pushed over a tab. */
export function createPlanEditPage(ctx: AppContext, runId: string, o: PlanEditOptions = {}): Page {
  const g = ctx.g;
  let state: State = 'error';
  let reason = 'not opened';
  /** The plan as saved: the base of the draft and what edits are compared with. */
  let board: Board | undefined;
  let draft: Board | undefined;
  let release: (() => void) | undefined;
  /** Saved: leaving needs no question, and the caller hears true. */
  let saved = false;
  /** Disposed: the page is gone, late dialog answers change nothing. */
  let closed = false;
  let config: Config | undefined;
  /** Undo steps: the cards before each edit, and where the selection was. */
  let history: Array<{ cards: Card[]; card: number; row: string | undefined }> = [];
  let problem: string | undefined;
  let saveError: string | undefined;
  let focus: 'cards' | 'editor' = 'cards';
  let cardIndex = 0;
  let rowKey: string | undefined;
  let rowIndex = 0;
  let editorTop = 0;
  let cardsTop = 0;
  let layout = { cards: EMPTY_RECT, editor: EMPTY_RECT, cardHits: [] as Array<number | undefined>, rowHits: [] as Array<string | undefined>, single: false };

  // ---- the lock ----

  const lock = (): boolean => {
    if (release || o.lockHeld) return true;
    try {
      release = acquireRunLock(ctx.repoRoot, runId);
      return true;
    } catch (e) {
      state = 'locked';
      reason = text(e);
      return false;
    }
  };
  const unlock = () => {
    const r = release;
    release = undefined;
    try { r?.(); } catch (e) { ctx.toast(`Lock not released: ${text(e)}`, 'error'); }
  };

  // ---- the draft ----

  const cards = (): Card[] => draft?.cards ?? [];
  const card = (): Card | undefined => cards()[cardIndex];
  const savedCard = (id: string): Card | undefined => board?.cards.find((x) => x.id === id);
  const edited = (): string[] => (draft && board ? changedCards(draft.cards, board.cards) : []);
  const dirty = () => edited().length > 0;

  /** The settings the run was planned with: the worker harnesses a card may name are checked against them. */
  const settings = (): Config => {
    if (!config) config = originalSettings(board!, ctx.config());
    return config;
  };

  const revalidate = () => {
    if (!draft) { problem = undefined; return; }
    try { validatePlanDraft(draft, settings()); problem = undefined; } catch (e) { problem = text(e); }
  };

  const sections = (): Section[] => {
    const x = card();
    return x ? buildSections(cards(), x, savedCard(x.id), g) : [];
  };
  const rows = (): EditorRow[] => sections().flatMap((s) => s.rows);
  const currentRow = (): EditorRow | undefined => {
    const all = rows();
    const found = rowKey === undefined ? -1 : all.findIndex((r) => r.key === rowKey);
    if (found >= 0) { rowIndex = found; return all[found]; }
    rowIndex = Math.max(0, Math.min(rowIndex, all.length - 1));
    const r = all[rowIndex];
    rowKey = r?.key;
    return r;
  };
  const selectRow = (i: number) => {
    const all = rows();
    if (!all.length) return;
    rowIndex = Math.max(0, Math.min(all.length - 1, i));
    rowKey = all[rowIndex]!.key;
  };

  /** Apply one edit to the selected card: remembered for undo, then the plan is checked again. */
  const change = (fn: (x: Card) => void, select?: string) => {
    const x = card();
    if (!x || !draft || state !== 'ready') return;
    remember();
    fn(x);
    if (select !== undefined) rowKey = select;
    saveError = undefined;
    revalidate();
    ctx.redraw();
  };

  const remember = () => {
    history.push({ cards: structuredClone(draft!.cards), card: cardIndex, row: rowKey });
    if (history.length > HISTORY) history.shift();
  };

  const undo = () => {
    const prev = history.pop();
    if (!prev || !draft) { ctx.toast('Nothing to undo', 'info'); return; }
    draft.cards = prev.cards;
    if (prev.card !== cardIndex) { cardIndex = prev.card; editorTop = 0; }
    rowKey = prev.row;
    saveError = undefined;
    revalidate();
    ctx.toast('Undone', 'info');
  };

  const revertCard = () => {
    const x = card();
    const saved = x && savedCard(x.id);
    if (!x || !saved || !draft) return;
    if (!edited().includes(x.id)) { ctx.toast(`No edits to ${x.id}`, 'info'); return; }
    remember();
    draft.cards[cardIndex] = structuredClone(saved);
    saveError = undefined;
    revalidate();
    ctx.toast(`Reverted ${x.id}`, 'info');
  };

  // ---- opening, leaving, saving ----

  const open = () => {
    config = undefined;
    if (!lock()) return;
    let fresh: Board;
    try {
      fresh = loadBoard(ctx.repoRoot, runId);
    } catch (e) {
      // The reader's message is the content; the page's title says the plan could not be read.
      state = 'error';
      reason = text(e);
      unlock();
      return;
    }
    const blocker = planEditBlocker(fresh);
    if (blocker) {
      state = 'blocked';
      reason = blocker;
      board = fresh;
      // Nothing can be saved, so the run must not stay locked by a page that only says why.
      unlock();
      return;
    }
    state = 'ready';
    if (!draft || !board) {
      board = fresh;
      draft = structuredClone(fresh);
      history = [];
      revalidate();
      return;
    }
    // Back from another tab or from a suspended terminal: has the saved plan changed underneath?
    const moved = JSON.stringify(fresh.cards) !== JSON.stringify(board.cards);
    const pending = dirty();
    board = fresh;
    if (!moved) { revalidate(); return; }
    if (!pending) {
      draft = structuredClone(fresh);
      history = [];
      ctx.toast('Plan changed elsewhere · reloaded', 'info');
      revalidate();
      return;
    }
    revalidate();
    const mine = changedCards(draft.cards, fresh.cards);
    // The facts and the buttons; the one consequence they cannot see is what Reload drops.
    void ctx.confirm({
      title: 'Plan changed elsewhere',
      message: `Reload drops your edits to ${mine.join(', ') || 'the plan'}`,
      confirm: 'Reload',
      cancel: 'Keep draft',
      danger: true,
    }).then((yes) => {
      if (!yes || closed || !board) { if (!yes && !closed) ctx.toast('Draft kept', 'info'); ctx.redraw(); return; }
      draft = structuredClone(board);
      history = [];
      saveError = undefined;
      ctx.toast('Reloaded · edits dropped', 'info');
      revalidate();
      ctx.redraw();
    });
  };

  const save = () => {
    if (state !== 'ready' || !board || !draft) return;
    const changed = edited();
    if (!changed.length) { ctx.toast('Nothing to save', 'info'); return; }
    if (!release && !lock()) { ctx.toast(reason, 'error'); return; }
    try {
      savePlanDraft(ctx.repoRoot, board, draft, settings());
    } catch (e) {
      saveError = text(e);
      ctx.toast(`Not saved: ${saveError}`, 'error');
      return;
    }
    ctx.toast(`Plan saved · ${changed.join(', ')}`, 'ok');
    saved = true;
    // The shell pops the page and disposes it, which tells the caller.
    ctx.pop();
  };

  /** Edits that leaving would lose (kept while the run is locked by someone else, too). */
  const unsaved = () => !saved && (state === 'ready' || state === 'locked') && dirty();

  const canLeave = (reason: LeaveReason): boolean | Promise<boolean> => {
    if (!unsaved()) return true;
    // The facts: which cards' edits are discarded; the saved plan stays as it was.
    const items = [{ label: 'Edited', value: edited().join(', ') }];
    return ctx.confirm(reason === 'quit'
      ? { title: 'Quit and discard plan edits', message: '', items, confirm: 'Quit', cancel: 'Keep editing', danger: true }
      : { title: 'Discard plan edits', message: '', items, confirm: 'Discard', cancel: 'Keep editing', danger: true });
  };

  const dispose = () => {
    if (closed) return;
    closed = true;
    const discarded = unsaved();
    unlock();
    if (discarded) ctx.toast('Plan edits discarded', 'info');
    try { o.done?.(saved); } catch (e) { ctx.toast(text(e), 'error'); }
  };

  const retry = () => {
    open();
    // Opened, the page shows the plan; still locked, it would look the same without a word.
    if (state === 'locked') ctx.toast('Still in use', 'warn');
  };

  // ---- editing the selected row ----

  const notEmpty = (what: string) => (v: string) => (v.trim() ? undefined : `${what} cannot be empty.`);

  // Dialogs: a title, the value, a placeholder of a few words; what a field means is in help (rowHelp).
  const editText = async (o: { title: string; value: string; multiline?: boolean; what: string; placeholder?: string }): Promise<string | undefined> => {
    const v = await ctx.prompt({ title: o.title, value: o.value, multiline: o.multiline, placeholder: o.placeholder, validate: notEmpty(o.what) });
    return v === undefined || closed ? undefined : v.trim();
  };

  const pickWorker = async (x: Card) => {
    let cfg: Config;
    try { cfg = settings(); } catch (e) { ctx.toast(text(e), 'error'); return; }
    const names = harnessNames(cfg);
    const current = x.worker?.harness;
    const options = [
      { value: ':session', label: 'Session settings' },
      ...names.map((h) => ({ value: h, label: h, meta: BUILTIN_HARNESSES.includes(h) ? 'built in' : 'provider' })),
      ...(current && !names.includes(current) ? [{ value: current, label: current, meta: 'not configured' }] : []),
    ];
    const picked = await ctx.pick({ title: `Worker for ${x.id}`, options, selected: current ?? ':session' });
    if (picked === undefined || closed) return;
    if (picked === ':session') { if (x.worker) change((y) => { y.worker = undefined; }, 'harness'); return; }
    if (picked !== current) change((y) => { y.worker = { harness: picked, model: undefined }; }, 'harness');
    await pickModel(x);
  };

  const pickModel = async (x: Card) => {
    const harness = x.worker?.harness;
    if (!harness) return;
    let cfg: Config;
    try { cfg = settings(); } catch (e) { ctx.toast(text(e), 'error'); return; }
    const current = x.worker?.model;
    const tiers = cfg.routing.models[harness] ?? {};
    const tierOf = (m: string) => Object.entries(tiers).filter(([, v]) => v === m).map(([k]) => k).join('/');
    const options = [
      { value: ':auto', label: 'Automatic' },
      ...candidateModels(cfg, harness, current).map((m) => ({ value: m, label: m, meta: tierOf(m) ? `${tierOf(m)} tier` : m === current ? 'current' : undefined })),
      { value: ':other', label: 'Other model ID…' },
    ];
    const picked = await ctx.pick({ title: `Model for ${x.id} on ${harness}`, options, selected: current ?? ':auto' });
    if (picked === undefined || closed) return;
    let model: string | undefined;
    if (picked === ':auto') model = undefined;
    else if (picked === ':other') {
      const typed = await ctx.prompt({
        title: `Model ID for ${x.id}`, value: current ?? '', placeholder: 'model id',
        validate: (v) => (!v.trim() ? 'The model ID cannot be empty.' : /[\s\p{Cc}]/u.test(v.trim()) ? 'Model IDs cannot contain spaces or control characters.' : undefined),
      });
      if (typed === undefined || closed) return;
      model = typed.trim();
    } else model = picked;
    if (model !== current) change((y) => { y.worker = { harness, model }; }, 'model');
  };

  const cycleWorker = (dir: 1 | -1) => {
    const x = card();
    if (!x) return;
    let names: string[];
    try { names = harnessNames(settings()); } catch (e) { ctx.toast(text(e), 'error'); return; }
    const ring = [undefined, ...names];
    const at = Math.max(0, ring.indexOf(x.worker?.harness));
    const next = ring[(at + dir + ring.length) % ring.length];
    change((y) => { y.worker = next ? { harness: next, model: undefined } : undefined; }, 'harness');
  };

  const toggleDep = (row: EditorRow) => {
    if (row.disabled) { ctx.toast(`Loop: ${row.depId} ${row.disabled}`, 'warn'); return; }
    const id = row.depId!;
    change((y) => {
      y.dependsOn = y.dependsOn.includes(id) ? y.dependsOn.filter((d) => d !== id) : [...y.dependsOn, id];
    });
  };

  const addCriterion = async (after?: number) => {
    const x = card();
    if (!x) return;
    const v = await editText({ title: `New criterion for ${x.id}`, value: '', what: 'A criterion' });
    if (v === undefined) return;
    const at = after === undefined ? x.acceptanceCriteria.length : after + 1;
    change((y) => { y.acceptanceCriteria.splice(at, 0, v); }, `crit:${at}`);
  };

  const addVerify = async (after?: number) => {
    const x = card();
    if (!x) return;
    const v = await editText({ title: `New verify command for ${x.id}`, value: '', what: 'A command', placeholder: 'shell command' });
    if (v === undefined) return;
    const at = after === undefined ? x.verify.length : after + 1;
    change((y) => { y.verify.splice(at, 0, v); }, `verify:${at}`);
  };

  /**
   * A command can be edited in place only when the prompt would hand it back unchanged: no tab, control
   * or format character, nothing the text box would alter. Otherwise editing it could silently rewrite
   * what runs, so it is shown but not edited; the person removes it or types a replacement instead.
   */
  const editableCommand = (cmd: string): boolean => {
    const round = cmd.includes('\n') ? pasteText(cmd + '\n', true) : plainText(cmd);
    return round === cmd;
  };

  const editVerify = async (x: Card, i: number) => {
    const command = x.verify[i] ?? '';
    if (!editableCommand(command)) {
      // The command whole, as it will run (shownCommand spells out what a text box would change), what
      // is in it that keeps it from being edited here, and the choices. Why is in help.
      const choice = await ctx.modal(noticeModal({
        title: `Verify command ${i + 1} of ${x.id}`,
        tone: 'warn',
        message: `${g.warn} not editable: ${command.includes('\t') ? 'tab' : 'special character'}`,
        detail: shownCommand(command),
        actions: [{ id: 'replace', label: 'Replace', primary: true }, { id: 'remove', label: 'Remove' }],
        close: 'Keep',
      }));
      if (closed) return;
      if (choice === 'remove') { change((y) => { y.verify.splice(i, 1); }); ctx.toast('Command removed', 'info'); return; }
      if (choice !== 'replace') return;
      const v = await editText({ title: `New verify command ${i + 1} of ${x.id}`, value: '', what: 'A command', placeholder: 'shell command' });
      if (v !== undefined && v !== command) change((y) => { y.verify[i] = v; });
      return;
    }
    // A command with line breaks (a heredoc) is edited as several lines, so none of them is lost.
    const v = await editText({ title: `Verify command ${i + 1} of ${x.id}`, value: command, multiline: command.includes('\n'), what: 'A command' });
    if (v !== undefined && v !== command) change((y) => { y.verify[i] = v; });
  };

  const editRow = async () => {
    const x = card();
    const row = currentRow();
    if (!x || !row || state !== 'ready') return;
    switch (row.kind) {
      case 'title': {
        const v = await editText({ title: `Title of ${x.id}`, value: x.title, what: 'The title' });
        if (v !== undefined && v !== x.title) change((y) => { y.title = v; });
        return;
      }
      case 'description': {
        const v = await editText({ title: `Description of ${x.id}`, value: x.description, multiline: true, what: 'The description' });
        if (v !== undefined && v !== x.description) change((y) => { y.description = v; });
        return;
      }
      case 'criterion': {
        const i = row.index!;
        const v = await editText({ title: `Criterion ${i + 1} of ${x.id}`, value: x.acceptanceCriteria[i] ?? '', what: 'A criterion' });
        if (v !== undefined && v !== x.acceptanceCriteria[i]) change((y) => { y.acceptanceCriteria[i] = v; });
        return;
      }
      case 'addCriterion': return addCriterion();
      case 'dep': return toggleDep(row);
      case 'verify': return editVerify(x, row.index!);
      case 'addVerify': return addVerify();
      case 'harness': return pickWorker(x);
      case 'model': return pickModel(x);
      case 'taskTitle': case 'taskInstructions': {
        const t = x.tasks.find((y) => y.id === row.taskId);
        if (!t) return;
        const isTitle = row.kind === 'taskTitle';
        const v = await editText(isTitle
          ? { title: `Title of task ${t.id}`, value: t.title, what: 'The title' }
          : { title: `Instructions for task ${t.id}`, value: t.instructions, multiline: true, what: 'The instructions' });
        if (v === undefined) return;
        if (isTitle ? v === t.title : v === t.instructions) return;
        change((y) => { const u = y.tasks.find((z) => z.id === t.id)!; if (isTitle) u.title = v; else u.instructions = v; });
        return;
      }
    }
  };

  const removeRow = () => {
    const row = currentRow();
    if (!row) return;
    switch (row.kind) {
      case 'criterion': change((y) => { y.acceptanceCriteria.splice(row.index!, 1); }); ctx.toast('Criterion removed', 'info'); return;
      case 'verify': change((y) => { y.verify.splice(row.index!, 1); }); ctx.toast('Command removed', 'info'); return;
      case 'dep': if (row.checked) toggleDep(row); return;
      case 'harness': if (card()?.worker) change((y) => { y.worker = undefined; }); return;
      case 'model': if (card()?.worker?.model) change((y) => { y.worker = { ...y.worker!, model: undefined }; }); return;
      default: ctx.toast('Not removable', 'info');
    }
  };

  const moveItem = (dir: 1 | -1) => {
    const row = currentRow();
    if (!row || (row.kind !== 'criterion' && row.kind !== 'verify')) { ctx.toast('Not reorderable', 'info'); return; }
    const list = (y: Card) => (row.kind === 'criterion' ? y.acceptanceCriteria : y.verify);
    const x = card()!;
    const i = row.index!;
    const j = i + dir;
    if (j < 0 || j >= list(x).length) return;
    const prefix = row.kind === 'criterion' ? 'crit' : 'verify';
    change((y) => { const l = list(y); [l[i], l[j]] = [l[j]!, l[i]!]; }, `${prefix}:${j}`);
  };

  const add = () => {
    const row = currentRow();
    if (row?.kind === 'criterion' || row?.kind === 'addCriterion') return addCriterion(row.kind === 'criterion' ? row.index : undefined);
    if (row?.kind === 'verify' || row?.kind === 'addVerify') return addVerify(row.kind === 'verify' ? row.index : undefined);
    ctx.toast('Nothing to add here', 'info');
    return undefined;
  };

  const selectCard = (i: number) => {
    const n = cards().length;
    if (!n) return;
    const next = Math.max(0, Math.min(n - 1, i));
    if (next !== cardIndex) { cardIndex = next; rowKey = undefined; rowIndex = 0; editorTop = 0; }
  };

  // ---- drawing ----

  /** Only an error or unsaved edits, in a few words (an error keeps its own message); nothing otherwise. */
  const statusLine = (cols: number): string | undefined => {
    const ids = edited();
    if (saveError) return c.bad(fit(`${g.warn} Not saved: ${plainText(saveError)}`, cols));
    if (problem) return c.warn(fit(`${g.warn} ${plainText(problem)}`, cols));
    if (ids.length) return unsavedLine(ids, cols, g);
    return undefined;
  };

  const headerLine = (cols: number): string => fit(`${c.muted('Goal')}  ${c.text(plainText(draft?.goal ?? ''))}`, cols);

  const renderReady = (size: Size): Rendered => {
    const area: Rect = { top: 0, left: 0, ...size };
    const framed = size.rows >= 6;
    const status = framed ? statusLine(size.cols - 2) : undefined;
    const [head, body, foot] = !framed ? [EMPTY_RECT, area, EMPTY_RECT]
      : status ? splitRows(area, [1, { flex: 1 }, 1]) as [Rect, Rect, Rect]
        : [...splitRows(area, [1, { flex: 1 }]) as [Rect, Rect], EMPTY_RECT];
    const parts: Array<{ rect: Rect; block: string[] | Rendered }> = [];
    if (framed) parts.push({ rect: head, block: [' ' + headerLine(size.cols - 2)] });
    if (status) parts.push({ rect: foot, block: [' ' + status] });
    const single = body.cols < 70;
    let cardsRect = EMPTY_RECT;
    let editorRect = EMPTY_RECT;
    if (single) {
      if (focus === 'cards') cardsRect = body; else editorRect = body;
    } else {
      // The card list takes the width its cards need (within bounds), not a share of the terminal.
      const want = cardsWidth(cards(), g) + 4;
      [cardsRect, editorRect] = splitCols(body, [Math.max(24, Math.min(40, Math.floor(body.cols * 0.4), want)), { flex: 1 }], 1) as [Rect, Rect];
    }
    const ids = new Set(edited());
    let cardHits: Array<number | undefined> = [];
    let rowHits: Array<string | undefined> = [];
    if (cardsRect.rows > 0) {
      parts.push({ rect: cardsRect, block: panel(cardsRect, {
        g, title: 'Cards', focused: focus === 'cards', badge: badge(`${cardIndex + 1}/${cards().length}`),
      }, (inner) => {
        const v = renderCards(cards(), ids, cardIndex, inner, g, { focused: focus === 'cards', top: cardsTop });
        cardsTop = v.top;
        cardHits = v.hits;
        return v.lines;
      }) });
    }
    if (editorRect.rows > 0) {
      const x = card();
      let total = 0;
      let visible = 1;
      // The card's id: its title is the first row, and its sections carry the changed marks.
      parts.push({ rect: editorRect, block: panel(editorRect, {
        g, title: x ? x.id : 'Card', focused: focus === 'editor',
        scroll: () => ({ top: editorTop, total, visible }),
      }, (inner) => {
        const secs = sections();
        currentRow();
        const v = renderEditor(secs, rowKey, inner, g, { focused: focus === 'editor', top: editorTop });
        editorTop = v.top;
        rowHits = v.hits;
        visible = inner.rows;
        total = v.total;
        return v.lines;
      }) });
    }
    layout = { cards: cardsRect, editor: editorRect, cardHits, rowHits, single };
    return compose(size, parts);
  };

  const render = (size: Size): Rendered => {
    if (state === 'ready' && draft) return renderReady(size);
    // A started plan is a state (why is in help); a lock or a read that failed shows its own message,
    // and edits kept meanwhile are named.
    if (state === 'blocked') return { lines: emptyState(size, { title: 'Plan started' }, g) };
    const ids = state === 'locked' && draft && dirty() ? edited() : [];
    return { lines: messageState(size, state === 'locked' ? 'Run in use' : 'Plan unreadable', reason, state === 'locked' ? 'warn' : 'bad', ids, g) };
  };

  // ---- input ----

  const editorKey = (k: Key): boolean => {
    const all = rows();
    const row = currentRow();
    switch (k.name) {
      case 'up': selectRow(rowIndex - 1); return true;
      case 'down': selectRow(rowIndex + 1); return true;
      case 'pageup': selectRow(rowIndex - 5); return true;
      case 'pagedown': selectRow(rowIndex + 5); return true;
      case 'home': selectRow(0); return true;
      case 'end': selectRow(all.length - 1); return true;
      case 'enter': void editRow(); return true;
      case 'delete': removeRow(); return true;
      case 'alt-up': case 'shift-up': moveItem(-1); return true;
      case 'alt-down': case 'shift-down': moveItem(1); return true;
      case 'left': if (row?.kind === 'harness') { cycleWorker(-1); return true; } focus = 'cards'; return true;
      case 'right': if (row?.kind === 'harness') { cycleWorker(1); return true; } return true;
      case 'char':
        switch (k.ch) {
          case 'j': selectRow(rowIndex + 1); return true;
          case 'k': selectRow(rowIndex - 1); return true;
          case 'g': selectRow(0); return true;
          case 'G': selectRow(all.length - 1); return true;
          case ' ': if (row?.kind === 'dep') toggleDep(row); else void editRow(); return true;
          case 'e': void editRow(); return true;
          case 'a': void add(); return true;
          case 'd': removeRow(); return true;
          case 'K': moveItem(-1); return true;
          case 'J': moveItem(1); return true;
        }
        return false;
      default: return false;
    }
  };

  const cardsKey = (k: Key): boolean => {
    switch (k.name) {
      case 'up': selectCard(cardIndex - 1); return true;
      case 'down': selectCard(cardIndex + 1); return true;
      case 'pageup': selectCard(cardIndex - 5); return true;
      case 'pagedown': selectCard(cardIndex + 5); return true;
      case 'home': selectCard(0); return true;
      case 'end': selectCard(cards().length - 1); return true;
      case 'enter': case 'right': focus = 'editor'; return true;
      case 'char':
        switch (k.ch) {
          case 'j': selectCard(cardIndex + 1); return true;
          case 'k': selectCard(cardIndex - 1); return true;
          case 'g': selectCard(0); return true;
          case 'G': selectCard(cards().length - 1); return true;
          case 'l': case 'e': focus = 'editor'; return true;
        }
        return false;
      default: return false;
    }
  };

  // Esc and Ctrl-D are the shell's: it asks canLeave before the page goes. (q is not a quit key over a pushed page.)
  const onKey = (k: Key): boolean => {
    if (state !== 'ready') {
      if (k.name === 'char' && k.ch === 'r' && state !== 'blocked') { retry(); return true; }
      return false;
    }
    if (k.name === 'ctrl' && k.ch === 's') { save(); return true; }
    if ((k.name === 'ctrl' && k.ch === 'z') || (k.name === 'char' && k.ch === 'u')) { undo(); return true; }
    if (k.name === 'tab' || k.name === 'shift-tab') { focus = focus === 'cards' ? 'editor' : 'cards'; return true; }
    if (focus === 'cards' ? cardsKey(k) : editorKey(k)) return true;
    // Typing that is no key here (a word typed while no field is open) does nothing, rather than quit
    // (q) or reach another page; ? and : still open help and the palette.
    if ((k.name === 'char' && k.ch !== '?' && k.ch !== ':') || k.name === 'paste') {
      return true;
    }
    return false;
  };

  const onMouse: NonNullable<Page['onMouse']> = (m) => {
    if (state !== 'ready') return false;
    const wheel = m.kind === 'wheel-up' ? -1 : m.kind === 'wheel-down' ? 1 : 0;
    const inCards = hit(m, layout.cards);
    const inEditor = hit(m, layout.editor);
    // Panel content starts one row down and two columns in.
    if (inCards) {
      if (wheel) { selectCard(cardIndex + wheel); return true; }
      if (m.kind !== 'press') return false;
      const i = layout.cardHits[inCards.row - 1];
      if (i === undefined) { focus = 'cards'; return true; }
      if (i === cardIndex && focus === 'cards') focus = 'editor';
      else { focus = 'cards'; selectCard(i); }
      return true;
    }
    if (inEditor) {
      if (wheel) { selectRow(rowIndex + wheel); return true; }
      if (m.kind !== 'press') return false;
      const key = layout.rowHits[inEditor.row - 1];
      const was = focus;
      focus = 'editor';
      if (key === undefined) return true;
      if (key === rowKey && was === 'editor') void editRow();
      else { rowKey = key; currentRow(); }
      return true;
    }
    return false;
  };

  // ---- discoverability ----

  /** The selected row's own keys: at most two, so the bar keeps ↑↓, the save key when there is something to save, and room for esc. */
  const rowHints = (): Hint[] => {
    const row = currentRow();
    const edit = { key: g.enter, label: 'edit' };
    switch (row?.kind) {
      case 'criterion': case 'verify': return [edit, { key: 'd', label: 'remove' }];
      case 'addCriterion': case 'addVerify': return [{ key: g.enter, label: 'add' }];
      case 'dep': return row.disabled ? [] : [{ key: 'space', label: row.checked ? 'uncheck' : 'check' }];
      case 'harness': return [{ key: g.enter, label: 'choose' }, { key: '←→', label: 'change' }];
      case 'model': return [{ key: g.enter, label: 'choose' }, { key: 'd', label: 'automatic' }];
      default: return [edit];
    }
  };

  const hints = (): Hint[] => {
    // The shell adds "esc back" for a pushed page while there is room; help says when Esc asks first.
    if (state !== 'ready') return state === 'blocked' ? [] : [{ key: 'r', label: 'retry' }];
    const save = dirty() ? [{ key: '^s', label: 'save' }] : [];
    if (focus === 'cards') return [{ key: '↑↓', label: 'card' }, { key: g.enter, label: 'edit' }, ...save];
    return [{ key: '↑↓', label: 'field' }, ...rowHints(), ...save];
  };

  const commands = (): PageCommand[] => {
    if (state !== 'ready') {
      return [
        ...(state !== 'blocked' ? [{ id: 'retry', title: 'Try again', shortcut: 'r', run: retry }] : []),
        { id: 'leave', title: 'Leave editor', shortcut: 'esc', run: () => ctx.pop() },
      ];
    }
    const x = card();
    const row = currentRow();
    const pending = edited();
    return [
      { id: 'save', title: 'Save plan', shortcut: '^s', disabled: pending.length ? false : 'Nothing to save', run: save },
      { id: 'leave', title: pending.length ? 'Discard and leave' : 'Leave editor', shortcut: 'esc', run: () => ctx.pop() },
      { id: 'edit', title: 'Edit field', shortcut: g.enter, disabled: row ? false : 'No field', run: editRow },
      { id: 'addCriterion', title: 'Add criterion', run: () => addCriterion() },
      { id: 'addVerify', title: 'Add verify command', run: () => addVerify() },
      { id: 'worker', title: 'Choose worker', run: () => (x ? pickWorker(x) : undefined) },
      { id: 'undo', title: 'Undo', shortcut: 'u', disabled: history.length ? false : 'Nothing to undo', run: undo },
      { id: 'revert', title: x ? `Revert ${x.id}` : 'Revert card', disabled: !x ? 'No card' : pending.includes(x.id) ? false : `No edits to ${x.id}`, run: revertCard },
      { id: 'focus', title: focus === 'cards' ? 'Go to editor' : 'Go to cards', shortcut: 'tab', run: () => { focus = focus === 'cards' ? 'editor' : 'cards'; } },
    ];
  };

  /** The selected thing first: the focused row (its label and what it does), or what the card list shows. */
  const focusedHelp = (): HelpGroup | undefined => {
    if (focus === 'cards') {
      return { title: 'Cards', keys: [], text: `Under each card: its tasks, the cards it waits for (after …) and a pinned model or backend. ${g.modified} marks a card with unsaved edits.` };
    }
    const x = card();
    const row = currentRow();
    if (!x || !row) return undefined;
    const h = rowHelp(x, row, g);
    return { title: h.title, keys: [], text: h.text };
  };

  const help = (): HelpGroup[] => {
    const leave = { key: 'esc', label: 'go back' };
    if (state === 'blocked') return [{ title: 'Plan started', keys: [], text: reason }, { title: 'Plan', keys: [leave] }];
    if (state !== 'ready') {
      const what = state === 'locked'
        ? ['Another process holds the run\'s execution lock: the plan cannot be edited until it is released.', ...(draft && dirty() ? ['Your unsaved edits are kept while this page is open.'] : [])]
        : [reason];
      return [{ title: state === 'locked' ? 'Run in use' : 'Plan unreadable', keys: [], text: what }, { title: 'Plan', keys: [{ key: 'r', label: 'try opening the plan again' }, leave] }];
    }
    const focused = focusedHelp();
    return [
      ...(focused ? [focused] : []),
      { title: 'Plan', keys: [
        { key: '^s', label: 'save: validates the whole plan' }, { key: 'esc', label: 'leave (asks before discarding edits)' },
        { key: 'u  ^z', label: 'undo the last edit' }, { key: 'tab', label: 'cards / editor' },
      ] },
      { title: 'Cards', keys: [{ key: '↑↓  j k', label: 'choose a card' }, { key: `${g.enter}  →`, label: 'edit it' }] },
      { title: 'Editor', keys: [
        { key: '↑↓  j k', label: 'move between fields' }, { key: `${g.enter}  e`, label: 'edit the field' },
        { key: 'space', label: 'check / uncheck a dependency' }, { key: 'a', label: 'add a criterion or command' },
        { key: 'd  del', label: 'remove a criterion, command, dependency or worker pin' },
        { key: 'K J  alt-↑↓', label: 'move a criterion or command' }, { key: '←→', label: 'change the worker backend' },
      ] },
      { title: 'About', keys: [], text: [
        `Edits stay in this draft until ^s saves them. ${g.modified} marks unsaved edits; a line marked ${g.warn} is what keeps the plan from being saved.`,
        'The run is held for editing while this page shows. If the saved plan changes meanwhile, it is reloaded; with edits pending you choose: keep your draft (saving replaces the other change) or reload.',
      ] },
    ];
  };

  return {
    id: `plan:${runId}`,
    title: 'Edit plan',
    activate() {
      if (!closed) open();
    },
    deactivate() {
      unlock();
    },
    canLeave,
    dispose,
    render,
    onKey,
    onMouse,
    hints,
    commands,
    help,
  };
}

function text(e: unknown): string {
  return plainText(e instanceof Error ? e.message : String(e)) || 'Something went wrong.';
}

/** `✎ c1, c2 unsaved`: the cards whose edits are only in the draft. */
function unsavedLine(ids: string[], cols: number, g: Glyphs): string {
  return fit(`${c.warn(g.modified)} ${c.text(`${ids.join(', ')} unsaved`)}`, cols);
}

/**
 * A page that cannot show the plan: a few words, then the tool's own message whole (a lock names its
 * file), then the cards whose edits are kept meanwhile. One block, centred.
 */
function messageState(size: Size, title: string, message: string, tone: 'warn' | 'bad', ids: string[], g: Glyphs): string[] {
  const { rows, cols } = size;
  if (rows <= 0 || cols <= 0) return frame([], size);
  const w = Math.max(1, Math.min(cols - 2, 64));
  const said = wrapParagraphs(`${g.warn} ${message}`, w).map((l) => c[tone](l));
  const body = [...said, ...(ids.length ? ['', unsavedLine(ids, w, g)] : [])];
  const bw = Math.max(width(plainText(title)), ...body.map((l) => width(l)));
  const head = repeat(' ', Math.max(0, Math.floor((bw - width(plainText(title))) / 2))) + c.muted(fit(plainText(title), w));
  const lines = [head, '', ...body].slice(0, rows);
  const top = Math.max(0, Math.floor((rows - lines.length) / 2));
  const left = repeat(' ', Math.max(0, Math.floor((cols - bw) / 2)));
  return frame([...Array.from({ length: top }, () => ''), ...lines.map((l) => cell(left + l, cols))], size);
}
