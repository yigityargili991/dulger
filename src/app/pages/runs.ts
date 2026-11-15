// The Runs tab: every run, newest first, its state a glyph; the selected run's facts as label and
// value, and its cards. Actions are keys (the footer shows the ones the run allows, `?` all of them, an
// off one says why when pressed). Wide terminals show the list and the run side by side; narrow ones
// one pane at a time, Tab switching between them.
import { relative } from 'node:path';
import * as store from '../../board/store.ts';
import { cardCounts, runSummaries, type RunSummary } from '../../runs.ts';
import { c, type Glyphs } from '../../tui/theme.ts';
import { fit, plainText, width, wrapParagraphs } from '../../tui/text.ts';
import {
  compose, createList, emptyState, hit, listCapturesText, listKey, listMouse, listScroll, panel, selectId, selectedItem, setItems,
  shownItems, splitCols, splitRows, type HelpGroup, type Hint, type ListItem, type Rect, type Rendered, type Size,
} from '../../tui/kit/index.ts';
import { fmtSpend } from '../../ui/ansi.ts';
import type { AppContext, NavParams, Page, PageCommand } from '../types.ts';
import { launchResume as defaultResume, launchRetry as defaultRetry } from '../run.ts';
import { createPlanEditPage, type PlanEditOptions } from './planEdit.ts';
import { createReviewPage, type ReviewOptions } from './review.ts';
import { age, cardChecks, cardReason, cardStatusLabel, lockHolder, runActions, runDetail, when, type ActionId, type RunAction, type RunDetail } from './runs.data.ts';
import { cleanFlow, retryFlow, viewCard, viewReport } from './runs.flows.ts';
import { settingNames } from '../resume.ts';
import {
  cardTableKey, cardTableMouse, cardTableRows, cardTableWidth, createCardTable, errorState, factLines, renderCardTable, renderRunList,
  runListWidth, setCards, statusLook,
  type Fact, type RunRow,
} from './runs.render.ts';

/** What the page starts; tests replace these. */
export interface RunsDeps {
  launchResume: typeof defaultResume;
  launchRetry: typeof defaultRetry;
  review: (ctx: AppContext, runId: string, o?: ReviewOptions) => Page;
  planEdit: (ctx: AppContext, runId: string, o?: PlanEditOptions) => Page;
}

/** Below this width the list and the run take turns. */
const SPLIT_COLS = 110;
const BADGE_TTL_MS = 3000;

export const ACTION_KEYS: Record<ActionId, string> = { review: 'v', resume: 'r', retry: 't', edit: 'e', merge: 'm', report: 'p' };

type Detail = RunDetail | { id: string; error: string };
const EMPTY: Rect = { top: 0, left: 0, rows: 0, cols: 0 };

export function createRunsPage(ctx: AppContext, deps: Partial<RunsDeps> = {}): Page {
  // Read again at every render: the Icons setting applies at once.
  let g = ctx.g;
  const launchResume = deps.launchResume ?? defaultResume;
  const launchRetry = deps.launchRetry ?? defaultRetry;
  const review = deps.review ?? createReviewPage;
  const planEdit = deps.planEdit ?? createPlanEditPage;

  let rows = new Map<string, RunRow>();
  let loadError: string | undefined;
  // Goals are sentences: every typed word must appear, and the goal typed exactly comes first.
  const list = createList([], { filter: 'slash', match: 'words', empty: 'No runs yet' });
  /** Runs another dulger process holds right now: while there are any, the page reads them again each second. */
  let held = new Set<string>();
  let poll: ReturnType<typeof setInterval> | undefined;
  const details = new Map<string, Detail>();
  const cards = createCardTable();
  let cardsFor: string | undefined;
  let focus: 'list' | 'detail' = 'list';
  let runTop = 0;
  let runInfo = { total: 0, visible: 0 };
  let split = true;
  let cols = 100;
  let rects = { list: EMPTY, run: EMPTY, cards: EMPTY };
  let recoverable = { at: -Infinity, count: 0 };

  const message = (e: unknown) => plainText(e instanceof Error ? e.message : String(e));
  /** Work started from a key or a click: a failure becomes an error toast, never an unhandled rejection. */
  const guard = (p: Promise<unknown>) => { p.catch((e) => ctx.toast(message(e) || 'Error', 'error')); };

  function reload(): void {
    let all: RunSummary[] = [];
    loadError = undefined;
    // Newest first by when they started (runSummaries is oldest first by start time).
    try { all = runSummaries(ctx.repoRoot).reverse(); } catch (e) { loadError = message(e); }
    held = new Set(all.filter((s) => s.readable && lockHolder(ctx.repoRoot, s.id) !== undefined).map((s) => s.id));
    rows = new Map(all.map((s) => [s.id, { summary: s, running: s.readable && s.status === 'in progress / interrupted' && held.has(s.id) }]));
    const items: ListItem[] = all.map((s) => {
      const lk = statusLook(s.readable ? s.status : 'unreadable', g);
      return { id: s.id, label: s.readable ? s.goal : s.id, keywords: `${s.id} ${lk.label}${s.readable ? '' : ` ${s.error}`}` };
    });
    setItems(list, items);
    details.clear();
    recoverable = { at: ctx.now(), count: all.filter((s) => s.readable && s.status !== 'finished').length };
  }

  /** While a run is held by another process, read again each second, so it never shows stale. */
  function watch(): void {
    if (poll || !held.size) return;
    poll = setInterval(() => {
      reload();
      if (!held.size) unwatch();
      ctx.redraw();
    }, 1000);
    poll.unref?.();
  }
  function unwatch(): void {
    if (poll) clearInterval(poll);
    poll = undefined;
  }

  const selected = (): RunRow | undefined => { const it = selectedItem(list); return it ? rows.get(it.id) : undefined; };

  function detailOf(id: string): Detail {
    let d = details.get(id);
    if (!d) {
      try { d = runDetail(ctx.repoRoot, store.loadBoard(ctx.repoRoot, id), ctx.config); } catch (e) { d = { id, error: message(e) }; }
      details.set(id, d);
    }
    return d;
  }

  const current = (): Detail | undefined => { const r = selected(); return r ? detailOf(r.summary.id) : undefined; };
  const readable = (d: Detail | undefined): d is RunDetail => Boolean(d && !('error' in d));

  /** Keep the cards table on the selected run; a different run starts at its first card. */
  function sync(): void {
    const d = current();
    const id = d?.id;
    if (id !== cardsFor) { cardsFor = id; runTop = 0; setCards(cards, readable(d) ? d.board.cards : [], true); }
    else if (readable(d)) setCards(cards, d.board.cards, false);
    if (focus === 'detail' && !readable(d)) focus = 'list';
  }

  const actionsOf = (d: RunDetail): Array<RunAction & { key: string }> => runActions(d).map((a) => ({ ...a, key: ACTION_KEYS[a.id] }));

  async function act(id: ActionId): Promise<void> {
    const row = selected();
    if (!row) { ctx.toast('No run selected', 'info'); return; }
    details.delete(row.summary.id);
    const d = detailOf(row.summary.id);
    if (!readable(d)) { ctx.toast(`Board unreadable: ${d.error}`, 'warn'); return; }
    const a = runActions(d).find((x) => x.id === id)!;
    if (!a.enabled) { ctx.toast(`${a.label}: ${a.note}`, 'warn'); return; }
    switch (id) {
      case 'review': ctx.push(review(ctx, d.id)); return;
      case 'merge': ctx.push(review(ctx, d.id, { section: 'merge', merge: true })); return;
      case 'edit': ctx.push(planEdit(ctx, d.id, { done: () => { details.delete(d.id); } })); return;
      case 'report': await viewReport(ctx, d.board, cols, d.merged ? d.into : undefined); return;
      // The launcher asks first, with the choice of settings when the run's differ from the session's.
      case 'resume': await launchResume(ctx, d.id); break;
      case 'retry': {
        const card = cards.cards[cards.index];
        await retryFlow(ctx, d, focus === 'detail' ? card?.id : undefined, launchRetry);
        break;
      }
    }
    reload();
  }

  function openCard(): void {
    const d = current();
    const card = readable(d) ? d.board.cards[cards.index] : undefined;
    if (card) guard(viewCard(ctx, card));
  }

  // ---- drawing ----

  function runFacts(d: RunDetail, w: number): string[] {
    const b = d.board;
    const lk = statusLook(d.status, g, Boolean(d.holder));
    const count = (st: string) => b.cards.filter((x) => x.status === st).length;
    const extra = [['failed', count('failed')], ['blocked', count('blocked')], ['replaced', count('replaced')]]
      .filter(([, n]) => n).map(([what, n]) => `${n} ${what}`);
    const ago = age(b.createdAt, ctx.now());
    const n = cardCounts(b.cards);
    const branchState = !d.branchExists ? 'gone' : d.merged ? `merged → ${d.into}` : d.noChanges ? 'no changes' : '';
    const facts: Array<Fact | undefined> = [
      { label: 'Status', glyph: lk.paint(lk.glyph), paint: lk.paint, value: d.holder ? `${lk.label} · pid ${d.holder}` : lk.label },
      b.halted ? { label: 'Stopped', value: b.halted.reason, paint: c.warn } : undefined,
      { label: 'Branch', paint: d.branchExists ? c.text : c.bad, value: branchState ? `${b.runBranch} · ${branchState}` : b.runBranch },
      { label: 'Base', value: `${b.baseBranch} @ ${b.baseRef.slice(0, 7)}` },
      { label: 'Spend', value: fmtSpend(b) },
      { label: 'Started', value: `${when(b.createdAt)} · ${ago}` },
      { label: 'Cards', value: b.cards.length ? [`${n.done}/${n.total} done`, ...extra].join(' · ') : 'none', paint: count('failed') ? c.bad : c.text },
      finalFact(d, g),
      docsFact(d),
      d.settingsDiff?.length ? { label: 'Settings', value: `differ: ${settingNames(d.settingsDiff)}`, paint: c.muted } : undefined,
      d.kept ? { label: 'Worktrees', value: d.kept, paint: c.muted } : undefined,
    ];
    return factLines(facts.filter((f): f is Fact => Boolean(f)), w);
  }

  function runLines(d: RunDetail, w: number): string[] {
    return [...wrapGoal(d.board.goal, w), '', ...runFacts(d, w)];
  }

  function unreadableLines(d: { id: string; error: string }, w: number): string[] {
    const lk = statusLook('unreadable', g);
    return factLines([
      { label: 'Status', glyph: lk.paint(lk.glyph), value: lk.label, paint: lk.paint },
      { label: 'Error', value: d.error, paint: c.bad },
      { label: 'Board', value: relative(ctx.repoRoot, store.boardPath(ctx.repoRoot, d.id)), paint: c.muted },
    ], w);
  }

  /** How wide the run's boxes want to be: the widest fact and the cards (titles and reasons whole), at least 44. */
  function detailWidth(d: Detail | undefined): number {
    if (!readable(d)) return 48;
    return Math.max(44, ...runLines(d, 200).map((l) => width(l)), cardTableWidth(cards, g)) + 4;
  }

  function renderDetail(area: Rect): Array<{ rect: Rect; block: string[] | Rendered }> {
    const d = current();
    rects.run = EMPTY;
    rects.cards = EMPTY;
    runInfo = { total: 0, visible: 0 };
    // Each box as tall as its rows and as wide as its content, up to the room there is.
    const sized = (want: { rows: number; cols: number }): Rect => ({ ...area, rows: Math.min(area.rows, want.rows), cols: Math.min(area.cols, want.cols) });
    if (!d) {
      const r = sized({ rows: 3, cols: 44 });
      return [{ rect: r, block: panel(r, { g, title: 'Run' }, (inner) => emptyState(inner, { title: 'No run' }, g)) }];
    }
    if (!readable(d)) {
      const want = unreadableLines(d, 200);
      const r = sized({ cols: Math.max(44, ...want.map((l) => width(l))) + 4, rows: 0 });
      const lines = unreadableLines(d, Math.max(1, r.cols - 4));
      r.rows = Math.min(area.rows, lines.length + 2);
      rects.run = r;
      return [{ rect: r, block: panel(r, { g, title: d.id, focused: false }, () => lines) }];
    }
    // As wide as the widest fact and the cards, at least 44 columns.
    const wantW = detailWidth(d);
    const w = Math.min(area.cols, wantW);
    const innerW = Math.max(1, w - 4);
    const lines = runLines(d, innerW);
    // The cards and the box's two borders (no header row).
    const cardsWant = cardTableRows(cards) + 2;
    const cardsMin = Math.min(cardsWant, 6, Math.max(0, area.rows - 3));
    const runH = Math.max(Math.min(3, area.rows), Math.min(lines.length + 2, area.rows - cardsMin));
    const runRect: Rect = { top: area.top, left: area.left, rows: runH, cols: w };
    const cardsRect: Rect = { top: area.top + runH, left: area.left, rows: Math.max(0, Math.min(cardsWant, area.rows - runH)), cols: w };
    rects.run = runRect;
    rects.cards = cardsRect;
    const visible = Math.max(0, runRect!.rows - 2);
    runTop = Math.max(0, Math.min(runTop, Math.max(0, lines.length - visible)));
    runInfo = { total: lines.length, visible };
    const counted = cardCounts(d.board.cards);
    return [
      { rect: runRect!, block: panel(runRect!, { g, title: d.id, scroll: { top: runTop, total: lines.length, visible } },
        (inner) => lines.slice(runTop, runTop + inner.rows)) },
      { rect: cardsRect!, block: panel(cardsRect!, { g, title: 'Cards', focused: focus === 'detail', badge: c.muted(`${counted.done}/${counted.total}`) },
        (inner) => renderCardTable(cards, inner, g, { focused: focus === 'detail' })) },
    ];
  }

  function render(size: Size): Rendered {
    g = ctx.g;
    cols = size.cols;
    rects = { list: EMPTY, run: EMPTY, cards: EMPTY };
    if (loadError) return { lines: errorState(size, 'Runs unreadable', loadError) };
    if (!list.items.length) return { lines: emptyState(size, { title: 'No runs yet' }, g) };
    sync();
    const area: Rect = { top: 0, left: 0, ...size };
    split = size.cols >= SPLIT_COLS;
    const shown = shownItems(list).length;
    const listBlock = (r: Rect) => panel(r, {
      g, title: 'Runs', focused: focus === 'list', badge: c.muted(list.query ? `${shown}/${list.items.length}` : String(list.items.length)), scroll: () => listScroll(list),
    }, (inner) => renderRunList(list, rows, inner, g, { focused: focus === 'list', now: ctx.now() }));
    // The list as tall as its rows (and its filter line) and as wide as its widest run, 44 to 76 columns.
    // Beside the run, the list gives way (down to 44) before the run's boxes would be cut.
    const listWant = runListWidth(list, rows, g, ctx.now()) + 4;
    const room = split ? size.cols - 1 - detailWidth(current()) : size.cols;
    const listW = Math.min(size.cols, Math.max(44, Math.min(76, listWant, room)));
    const listH = Math.min(size.rows, Math.max(1, shown) + 2 + (list.filtering || list.query ? 1 : 0));
    if (split) {
      const l: Rect = { top: 0, left: 0, rows: listH, cols: listW };
      rects.list = l;
      return compose(size, [{ rect: l, block: listBlock(l) }, ...renderDetail({ top: 0, left: listW + 1, rows: size.rows, cols: size.cols - listW - 1 })]);
    }
    if (focus === 'list') { const l: Rect = { ...area, rows: listH, cols: listW }; rects.list = l; return compose(size, [{ rect: l, block: listBlock(l) }]); }
    return compose(size, renderDetail(area));
  }

  // ---- keys and mouse ----

  function onKey(k: Parameters<Page['onKey']>[0]): boolean {
    if (!list.items.length) {
      if (k.name === 'enter') { ctx.navigate('home'); return true; }
      if (k.name === 'char' && k.ch === 'c') { guard(cleanFlow(ctx).then(reload)); return true; }
      return false;
    }
    if (focus === 'list' && listCapturesText(list)) {
      if (listKey(list, k)) { sync(); return true; }
      if (k.name === 'tab' || k.name === 'shift-tab') { list.filtering = false; return toDetail(); }
      return false;
    }
    if (focus === 'list') {
      if (k.name === 'enter') { guard(act('review')); return true; }
      if (k.name === 'tab' || k.name === 'shift-tab' || k.name === 'right') return toDetail();
      if (listKey(list, k)) { sync(); return true; }
    } else {
      if (k.name === 'tab' || k.name === 'shift-tab' || k.name === 'escape' || k.name === 'left') { focus = 'list'; return true; }
      if (k.name === 'enter') { openCard(); return true; }
      if (k.name === 'char' && k.ch === '/') { focus = 'list'; list.filtering = true; return true; }
      // Paging moves the run's facts and actions when they do not fit; the arrows move the cards.
      if (k.name === 'pageup' || k.name === 'pagedown') { scrollRun(k.name === 'pageup' ? -Math.max(1, runInfo.visible - 1) : Math.max(1, runInfo.visible - 1)); return true; }
      if (cardTableKey(cards, k)) return true;
    }
    if (k.name !== 'char') return false;
    const action = (Object.keys(ACTION_KEYS) as ActionId[]).find((id) => ACTION_KEYS[id] === k.ch);
    if (action) { guard(act(action)); return true; }
    if (k.ch === 'c') { guard(cleanFlow(ctx).then(reload)); return true; }
    return false;
  }

  function toDetail(): boolean {
    if (!readable(current())) { if (current()) ctx.toast('Board unreadable', 'info'); return true; }
    focus = 'detail';
    return true;
  }

  function scrollRun(by: number): void {
    runTop = Math.max(0, Math.min(Math.max(0, runInfo.total - runInfo.visible), runTop + by));
  }

  /** Panel content starts one row down and two columns in (border and padding). */
  const inside = (m: Parameters<NonNullable<Page['onMouse']>>[0]) => ({ ...m, row: m.row - 1, col: m.col - 2 });

  function onMouse(m: Parameters<NonNullable<Page['onMouse']>>[0]): boolean {
    // A click on the pane that does not have focus only focuses it and selects; it never opens.
    const inList = hit(m, rects.list);
    if (inList) {
      const was = focus;
      if (m.kind === 'press') focus = 'list';
      const r = listMouse(list, inside(inList));
      sync();
      if (r === 'activate' && was === 'list') guard(act('review'));
      return true;
    }
    const inCards = hit(m, rects.cards);
    if (inCards) {
      const was = focus;
      if (m.kind === 'press') focus = 'detail';
      if (cardTableMouse(cards, inside(inCards)) === 'activate' && was === 'detail') openCard();
      return true;
    }
    const inRun = hit(m, rects.run);
    if (inRun && (m.kind === 'wheel-up' || m.kind === 'wheel-down')) { scrollRun(m.kind === 'wheel-up' ? -3 : 3); return true; }
    return Boolean(inRun);
  }

  // ---- hints, palette, help ----

  /** The run's own actions that are on, most useful first: what the footer has room for. */
  const ORDER: ActionId[] = ['resume', 'merge', 'retry', 'edit'];
  const SHORT: Record<ActionId, string> = { review: 'review', resume: 'resume', retry: 'retry', edit: 'edit', merge: 'merge', report: 'report' };

  function hints(): Hint[] {
    if (!list.items.length) return [{ key: g.enter, label: 'home' }];
    if (focus === 'list' && listCapturesText(list)) return [{ key: g.enter, label: 'done' }, { key: 'esc', label: 'clear' }];
    const d = current();
    // An unreadable board offers nothing but the list.
    if (!readable(d)) return [{ key: '/', label: 'filter' }, { key: 'c', label: 'clean' }];
    const on = ORDER.filter((id) => runActions(d).find((a) => a.id === id)?.enabled);
    const acts = on.slice(0, 2).map((id) => ({ key: ACTION_KEYS[id], label: SHORT[id] }));
    if (focus === 'detail') return [{ key: g.enter, label: 'card' }, ...acts, { key: 'tab', label: 'runs' }];
    return [{ key: g.enter, label: 'review' }, ...acts, { key: 'tab', label: split ? 'cards' : 'run' }];
  }

  function commands(): PageCommand[] {
    const d = current();
    const acts: PageCommand[] = readable(d)
      // Off actions stay in the palette, dimmed; choosing one says why.
      ? actionsOf(d).map((a) => ({ id: a.id, title: a.id === 'merge' ? `Merge ${d.board.runBranch} → ${d.into}` : a.label, shortcut: a.key, disabled: a.enabled ? undefined : `${a.label}: ${a.note}`, run: () => act(a.id) }))
      : [];
    const card = readable(d) ? d.board.cards[cards.index] : undefined;
    return [
      ...acts,
      { id: 'card', title: card ? `Open card ${card.id}` : 'Open card', shortcut: g.enter, disabled: card ? undefined : 'No cards', run: openCard },
      { id: 'filter', title: 'Filter runs', shortcut: '/', run: () => { focus = 'list'; list.filtering = true; } },
      { id: 'clean', title: 'Clean leftovers', shortcut: 'c', run: () => cleanFlow(ctx).then(reload) },
      { id: 'reload', title: 'Reload runs', run: reload },
    ];
  }

  /** `?` leads with what is selected: the card in the cards pane, else the run. */
  function focusedGroup(): HelpGroup | undefined {
    const d = current();
    if (!d) return undefined;
    if (!readable(d)) return { title: d.id, keys: [], text: `Its board cannot be read, so dulger cannot show its cards, resume it or merge its result until it can. Other runs are not affected. ${d.error}` };
    const card = d.board.cards[cards.index];
    if (focus === 'detail' && card) {
      const why = cardReason(card);
      return { title: `${card.id} ${fit(plainText(card.title), 60)}`, keys: [], text: `${cardStatusLabel(card)}${why ? `: ${why.split('\n')[0]}` : '.'} Enter opens the card: description, criteria, tasks, verify commands and their results, review feedback.` };
    }
    const lk = statusLook(d.status, g, Boolean(d.holder));
    const holder = d.holder ? ` Another dulger process (pid ${d.holder}) is running it; nothing that changes it can start here.` : d.status === 'in progress / interrupted' ? ' It was interrupted while cards were in progress.' : '';
    return { title: fit(plainText(d.board.goal), 60), keys: [], text: `${d.id}: ${lk.label}.${holder}` };
  }

  function help(): HelpGroup[] {
    const d = current();
    // Every action of the selected run, an off one with why.
    const runKeys: Hint[] = readable(d)
      ? actionsOf(d).map((a) => ({ key: a.key, label: a.enabled ? `${a.label.toLowerCase()}: ${a.note}` : `${a.label.toLowerCase()} (off: ${a.note})` }))
      : (Object.keys(ACTION_KEYS) as ActionId[]).map((id) => ({ key: ACTION_KEYS[id], label: SHORT[id] }));
    return [
      ...[focusedGroup()].filter((x): x is HelpGroup => Boolean(x)),
      { title: 'Selected run', keys: runKeys },
      { title: 'Runs', keys: [
        { key: '↑↓  j k', label: 'move' }, { key: '/', label: 'filter by goal, status or id' }, { key: g.enter, label: 'review the result' },
        { key: 'tab', label: split ? 'move to the cards' : 'show the run' }, { key: 'esc', label: 'clear the filter' },
      ] },
      { title: 'Cards', keys: [
        { key: '↑↓', label: 'move' }, { key: g.enter, label: 'open the card' }, { key: 'pgup pgdn', label: 'scroll the run details' },
        { key: 'tab  esc', label: split ? 'back to the runs' : 'back to the list' },
      ] },
      { title: 'Repository', keys: [{ key: 'c', label: 'clean leftover worktrees (asks first)' }] },
      { title: 'About', keys: [], text: [
        `${g.play} ready to resume, ${g.interrupted} interrupted, ${g.running} running, ${g.cross} needs attention, ${g.pause} paused, ${g.block} stopped, ${g.planner} not planned, ${g.check} finished.`,
        'Verified is the final verification on the result: none means no verify commands were configured, so nothing checked it; cards only means only the cards\' own checks ran. Worktrees is where the cards that did not land keep theirs, for a retry. Settings names what differs between the run\'s saved settings and this session\'s; a resume asks which to use.',
        'Clean removes leftover card worktrees and dulger-wip branches; run boards, result branches and your own branches are kept.',
      ] },
    ];
  }

  return {
    id: 'runs',
    title: 'Runs',
    activate(params?: NavParams) {
      reload();
      watch();
      const run = params?.run;
      if (typeof run === 'string' && rows.has(run)) {
        if (!selectId(list, run)) { list.query = ''; list.filtering = false; list.cache = undefined; selectId(list, run); }
        sync();
        if (readable(current())) focus = 'detail';
      }
    },
    deactivate: unwatch,
    dispose: unwatch,
    render,
    onKey,
    onMouse,
    hints,
    commands,
    help,
    capturesText: () => focus === 'list' && listCapturesText(list),
    badge() {
      if (ctx.now() - recoverable.at > BADGE_TTL_MS) {
        try { recoverable = { at: ctx.now(), count: runSummaries(ctx.repoRoot).filter((s) => s.readable && s.status !== 'finished').length }; }
        catch { recoverable = { at: ctx.now(), count: 0 }; }
      }
      return recoverable.count ? `${g.play}${recoverable.count}` : undefined;
    },
  };
}

function finalFact(d: RunDetail, g: Glyphs): Fact {
  const results = d.board.finalVerification?.results ?? [];
  const failed = results.filter((r) => !r.ok);
  switch (d.final) {
    case 'passed': return { label: 'Verified', glyph: c.ok(g.check), paint: c.ok, value: `${results.length} passed` };
    case 'failed': return { label: 'Verified', glyph: c.bad(g.cross), paint: c.bad, value: `${failed.length}/${results.length} failed · ${failed[0]!.command}` };
    case 'stale': return { label: 'Verified', glyph: c.warn(g.warn), paint: c.warn, value: 'stale' };
    case 'none-configured': {
      // Not "none" when a card had verify commands (one that failed, say, and did not land).
      const cards = cardChecks(d.board);
      if (cards === 'none') return { label: 'Verified', glyph: c.warn(g.warn), paint: c.warn, value: 'none' };
      return { label: 'Verified', glyph: c.warn(g.warn), paint: cards === 'failed' ? c.bad : c.warn, value: cards === 'failed' ? 'cards only · card failed' : 'cards only' };
    }
    case 'not-run': return { label: 'Verified', paint: c.muted, value: 'not yet' };
    case 'not-recorded': return { label: 'Verified', paint: c.muted, value: 'not recorded' };
  }
}

function docsFact(d: RunDetail): Fact {
  switch (d.board.docs?.status) {
    case 'done': return { label: 'Docs', value: 'updated', paint: c.ok };
    case 'skipped': return { label: 'Docs', value: 'skipped', paint: c.muted };
    case 'failed': return { label: 'Docs', value: 'failed', paint: c.bad };
    case 'running': return { label: 'Docs', value: 'interrupted', paint: c.warn };
    case 'pending': return { label: 'Docs', value: 'pending', paint: c.muted };
    default: return { label: 'Docs', value: 'off', paint: c.muted };
  }
}

function wrapGoal(goal: string, w: number): string[] {
  return wrapParagraphs(goal, w).map((l) => (l ? c.text.bold(l) : ''));
}
