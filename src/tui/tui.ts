// The full-screen run view: the board as columns of cards, the agents and the log as panes, and the
// moments a run asks something: the plan review (dispatch, revise, edit, cancel, keep for later), the
// dialogs that stop or instruct a card and approve new shell commands, and help. Keys act on the
// focused pane. Ctrl-C inside a dialog cancels the dialog; outside one it means what it means
// everywhere else in dulger: stop the agents and come back (at the plan: keep it for later).
//
// What appears without the person asking (the plan review once the planner is done, the approval of a
// replan's commands) ignores Enter and clicks for a moment, so a key or click meant for what was there
// before never answers it. An approval that arrives while another dialog is open waits for it to close.
import type { AgentStatus, Board } from '../types.ts';
import { history } from '../ui/prompt.ts';
import { clockTime } from '../ui/ansi.ts';
import type { Suggestion } from '../replCommands.ts';
import { createEditor, edit, insertText, submit, type Editor } from './editor.ts';
import { openScreen, type Key, type Mouse, type Screen } from './screen.ts';
import { c, glyphs, type IconSet } from './theme.ts';
import { cell, fit, plainText, width } from './text.ts';
import {
  confirmModal, createToasts, helpModal, hit, overlay, placeModal, promptModal, pruneToasts, pushToast, renderToasts,
  type Modal, type Rect, type Rendered, type ToastKind,
} from './kit/index.ts';
import { approvalModal, type ApprovalOptions } from './approval.ts';
import {
  PLAN_ACTIONS, columns, focusOrder, helpGroups, orderedAgents, planMode, render, targetCard,
  type Focus, type Frame, type Limits, type Pane, type PlanAction, type Revision, type ViewState,
} from './view.ts';

export interface TuiOptions {
  getBoard(): Board;
  getAgents(): Iterable<AgentStatus>;
  icons: IconSet;
  /** Ctrl-C while no dialog is open and the plan is not under review. */
  onInterrupt(): void;
  screen?: Screen;
  controls?: { togglePause(): boolean; stopCard(id: string): void; guideCard(id: string, text: string): void };
  /** Report the wheel and clicks (`config.tui.mouse`); off leaves the mouse to the terminal's selection. */
  mouse?: boolean;
  /** The log to carry on: a view reopened for the same run (after the plan editor) keeps what was logged. */
  notes?: string[];
  /** The clock the input guards read (default Date.now); tests move it by hand. */
  now?: () => number;
}

/** What a reply typed at the plan asks for (commands.ts `planAction`). */
export type ReplyKind = 'go' | 'cancel' | 'edit' | 'revise';

export interface PlanReviewOptions {
  /** What a typed reply means; a cancel is confirmed here before it is answered. */
  read(line: string): ReplyKind;
  /** Warnings about the plan, listed with the planner's own notes. */
  warnings?: string[];
  /** What ↑ recalls in the reply line (the shared prompt history by default). */
  history?: string[];
  /** What Tab completes in the reply line once something is typed (`go`, `cancel`, `/edit`). */
  suggest?: (line: string) => Suggestion;
  /** The revision this plan came from: the reply that asked for it and the cards it changed. */
  revision?: Revision;
  signal?: AbortSignal;
}

export interface ApproveOptions extends ApprovalOptions { signal?: AbortSignal }

export interface Tui {
  /** Something on the board or an agent changed. */
  update(): void;
  /** A log line; timestamped here. */
  note(msg: string): void;
  /** What the run is doing, for the bottom bar. */
  setPhase(phase: string): void;
  /**
   * The plan pause as a review screen. Resolves with what the plan prompt would have been given: ''
   * for Dispatch, the typed reply (a revision, `go`, `/edit`), '/edit' for Edit plan, 'cancel' once the
   * deletion is confirmed, undefined to keep the run in the backlog (Ctrl-C, the action, `signal`).
   */
  reviewPlan(o: PlanReviewOptions): Promise<string | undefined>;
  /**
   * Shell commands to approve in a typed-confirmation dialog: true only when the word was typed. While
   * another dialog is open it waits for that one to close.
   */
  approve(o: ApproveOptions): Promise<boolean>;
  /** Leave the alternate screen. The log lines are returned so the caller can keep what matters. */
  close(): string[];
}

/** Whether the full-screen view can run here. */
export function tuiUsable(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** How long something that appeared unasked ignores Enter and clicks: shorter than anyone reacts to it. */
export const SETTLE_MS = 300;

interface OpenModal {
  modal: Modal<unknown>;
  done: (value: unknown) => void;
  rect?: Rect;
  settleUntil?: number;
  /** Whether what the dialog says still holds (the card it is about may have moved on); checked before each frame. */
  stale?: () => string | undefined;
}
interface PromptLine { label: string; hint: string; placeholder?: string; suggest?: (line: string) => Suggestion; editor: Editor }
interface Review { o: PlanReviewOptions; button: number; resolve: (v: string | undefined) => void; confirm?: OpenModal; settleUntil: number }
interface Waiting { show(): void; refuse(): void }

const STOPPABLE = new Set(['backlog', 'in_progress', 'review']);
/** A card's status as one word for a toast. */
const statusWord = (status: string): string => status.replace('_', ' ');
const INSTRUCTABLE = (status: string) => status !== 'done' && status !== 'replaced';

export function createTui(o: TuiOptions): Tui {
  const screen = o.screen ?? openScreen(process.stdout, process.stdin, { mouse: o.mouse });
  const mouseOn = o.screen ? Boolean(o.screen.onMouse) && o.mouse !== false : Boolean(o.mouse);
  const clock = o.now ?? Date.now;
  const g = glyphs(o.icons);
  const notes: string[] = o.notes ?? [];
  const startedAt = Date.now();
  const toasts = createToasts();
  const modals: OpenModal[] = [];
  /** Approvals that arrived while another dialog was open, oldest first. */
  const waiting: Waiting[] = [];
  let phase = 'starting';
  let selected: string | undefined;
  let open: string | undefined;
  let openScroll = 0;
  let logScroll = 0;
  let planScroll = 0;
  let focus: Focus = 'board';
  let zoom: Pane | undefined;
  let agentSel: string | undefined;
  /** A card opened from the agents pane goes back there when it closes. */
  let openedFrom: { zoom?: Pane } | undefined;
  /** The plan review's reply line; there is no other prompt. */
  let prompt: PromptLine | undefined;
  let review: Review | undefined;
  let last: Frame | undefined;
  let closed = false;
  let compact = false;

  const settling = (until: number | undefined): boolean => until !== undefined && clock() < until;

  /** What the reply predicts for what is typed, dimmed after the cursor. Nothing on an empty line or mid-line. */
  const ghost = (): string => {
    const e = prompt?.editor;
    return e && prompt?.suggest && e.text.trim() && e.cursor === [...e.text].length ? prompt.suggest(e.text).ghost : '';
  };

  const controllable = (board: Board): boolean =>
    Boolean(o.controls) && !review && phase === 'running' && !['docs', 'verifying', 'finished'].includes(board.checkpoint?.phase ?? '');

  const isPlan = (): boolean => planMode({ review: review && { warnings: [], button: 0 }, phase, board: o.getBoard() });

  const state = (now = Date.now()): ViewState => {
    const board = o.getBoard();
    if (!selected || !board.cards.some((k) => k.id === selected)) selected = columns(board).find((col) => col.cards.length)?.cards[0]?.id;
    if (open && !board.cards.some((k) => k.id === open)) { open = undefined; openedFrom = undefined; }
    const agents = [...o.getAgents()];
    if (agentSel && !agents.some((a) => a.id === agentSel)) agentSel = undefined;
    if (focus === 'input' && !prompt) focus = 'board';
    const checkpoint = board.checkpoint?.phase ?? '';
    const shown = phase === 'running' && ['docs', 'verifying'].includes(checkpoint) ? checkpoint : phase === 'running' && board.paused ? 'paused' : phase;
    return {
      board, agents, notes, startedAt, now, rows: screen.rows, cols: screen.cols, g, phase: shown,
      selected, open, openScroll, logScroll, focus, zoom, agentSel, planScroll,
      review: review && { warnings: review.o.warnings ?? [], button: review.button, revision: review.o.revision },
      controls: controllable(board), mouse: mouseOn,
      prompt: prompt && { label: prompt.label, hint: prompt.hint, placeholder: prompt.placeholder, ghost: ghost(), text: prompt.editor.text, cursor: prompt.editor.cursor },
    };
  };

  const draw = () => {
    const now = Date.now();
    pruneToasts(toasts, now);
    const f = render(state(now));
    last = f;
    compact = f.compact;
    // A position past the end comes back to it, so the next key moves the view at once.
    if (f.hits.detail) openScroll = Math.min(openScroll, f.hits.detail.max);
    if (f.hits.plan) planScroll = Math.min(planScroll, f.hits.plan.max);
    if (f.hits.log) logScroll = Math.min(logScroll, f.hits.log.max);
    let lines = f.lines;
    let cursor = f.cursor;
    const size = { rows: screen.rows, cols: screen.cols };
    const top = modals.at(-1);
    if (top) {
      let box: Rendered;
      try { box = top.modal.render(size, g, now); } catch (err) { box = { lines: [c.bad(fit(plainText(`${g.cross} ${(err as Error).message}`), size.cols))] }; }
      const placed = placeModal(lines, box, size, top.modal.placement);
      lines = placed.lines;
      cursor = placed.cursor;
      top.rect = placed.rect;
    }
    // Toasts sit at the top right, from the blank row under the header (when there is one) over the first
    // pane's title row: the reply line, the plan's actions and the newest log lines stay readable. On a
    // short screen there is no room for them.
    const shown = renderToasts(toasts, Math.max(0, size.cols - 2), size.rows >= 16 ? 4 : size.rows >= 10 ? 2 : 0, g, now);
    if (shown.length) {
      const first = Math.min(...Object.values(f.hits.panes).map((r) => r.top), Math.max(0, size.rows - 1 - shown.length));
      const top = first >= 2 ? first - 1 : first;
      lines = overlay(lines, shown, Math.max(0, top), Math.max(0, size.cols - width(shown[0]!) - 1));
    }
    screen.paint(lines, cursor);
  };

  /** A frame that cannot be drawn says so instead of ending the process, and the keys keep working. */
  const drawFailed = (err: unknown) => {
    last = undefined;
    try {
      const { rows, cols } = screen;
      const lines = Array.from({ length: rows }, () => cell('', cols));
      lines[0] = cell(c.bad(fit(plainText(`${g.cross} ${(err as Error)?.message ?? String(err)}`), cols)), cols);
      lines[rows - 1] = cell(c.muted(fit(review ? ' ^c backlog' : ' ^c stop', cols)), cols);
      screen.paint(lines);
    } catch { /* the terminal itself is gone */ }
  };

  /** A dialog whose subject moved on (the card it would stop started or finished) closes and says why. */
  const dropStale = () => {
    const top = modals.at(-1);
    const why = top?.stale?.();
    if (top && why) { closeModal(top, top.modal.cancel); toast(why, 'warn'); }
  };

  const paint = () => {
    if (closed) return;
    try { dropStale(); draw(); } catch (err) { drawFailed(err); }
  };

  const toast = (message: string, kind: ToastKind = 'info') => { pushToast(toasts, plainText(message), kind, Date.now()); };

  // ---- dialogs ----

  /** `done` runs as the dialog closes, before the key that closed it returns. */
  const openModal = <T>(m: Modal<T>, done: (value: T) => void = () => {}, settle = false): OpenModal => {
    const entry: OpenModal = { modal: m as Modal<unknown>, done: done as (value: unknown) => void, settleUntil: settle ? clock() + SETTLE_MS : undefined };
    if (closed) { done(m.cancel); return entry; }
    modals.push(entry);
    paint();
    return entry;
  };
  const closeModal = (entry: OpenModal, value: unknown) => {
    const i = modals.indexOf(entry);
    if (i < 0) return;
    modals.splice(i, 1);
    entry.done(value);
    // The dialog an approval waited for is gone: the approval is next.
    if (!modals.length && !closed) waiting.shift()?.show();
  };

  const openHelp = () => { openModal(helpModal(helpGroups(state()), 'Help')); };

  /** The card a control acts on, if it is still on the board. */
  const target = () => {
    const board = o.getBoard();
    const id = targetCard({ focus, agents: [...o.getAgents()], agentSel, board, selected });
    return board.cards.find((k) => k.id === id);
  };

  const stopDialog = () => {
    const card = target();
    if (!card) return;
    if (!STOPPABLE.has(card.status)) { toast(`${card.id} ${statusWord(card.status)}`, 'warn'); return; }
    const board = o.getBoard();
    const id = plainText(card.id);
    const started = card.status !== 'backlog';
    // The card, and for one that has not started the consequence nobody would see: what waits for it does not start either.
    const waiting = board.cards.filter((k) => k.dependsOn.includes(card.id) && STOPPABLE.has(k.status)).map((k) => plainText(k.id));
    const message = started ? plainText(card.title) : `${plainText(card.title)} · not started${waiting.length ? `\n${waiting.join(', ')} will not start either` : ''}`;
    const entry = openModal(confirmModal({ title: `Stop ${id}`, message, confirm: 'Stop', cancel: 'Keep', danger: true, typed: 'stop' }), (ok) => {
      if (!ok) return;
      if (!STOPPABLE.has(card.status)) { toast(`${card.id} ${statusWord(card.status)}`, 'warn'); return; }
      o.controls?.stopCard(card.id);
      toast(started ? `Stopping ${card.id}` : `${card.id} stopped`, 'ok');
    });
    entry.stale = () => {
      if (!STOPPABLE.has(card.status)) return `${card.id} ${statusWord(card.status)}`;
      if (!started && card.status !== 'backlog') return `${card.id} started`;
      return undefined;
    };
  };

  const instructDialog = () => {
    const card = target();
    if (!card) return;
    if (!INSTRUCTABLE(card.status)) { toast(`${card.id} ${statusWord(card.status)}`, 'warn'); return; }
    const given = card.guidance?.length ?? 0;
    openModal(promptModal({
      title: `Instruct ${plainText(card.id)}`,
      message: `${plainText(card.title)}${given ? ` · ${given} given` : ''}`,
      multiline: true, placeholder: 'next attempt',
    }), (value) => {
      if (!value?.trim()) return;
      // The card may have landed or been replaced while this was typed: then nothing would use them.
      if (!INSTRUCTABLE(card.status)) { toast(`${card.id} ${statusWord(card.status)}: not saved`, 'warn'); return; }
      o.controls?.guideCard(card.id, value);
      toast(`Saved for ${card.id}`, 'ok');
    });
  };

  // ---- the plan review ----

  const finishReview = (value: string | undefined) => {
    const r = review;
    if (!r) return;
    review = undefined;
    prompt = undefined;
    focus = 'board';
    zoom = undefined;
    if (r.confirm) closeModal(r.confirm, false);
    r.resolve(value);
  };

  const confirmCancel = () => {
    const r = review;
    if (!r) return;
    const b = o.getBoard();
    r.confirm = openModal(confirmModal({
      title: `Delete run ${plainText(b.runId)}`,
      message: '',
      items: ['plan', `branch ${plainText(b.runBranch)}`],
      confirm: 'Delete', cancel: 'Keep', danger: true,
    }), (ok) => {
      if (review !== r) return;
      r.confirm = undefined;
      if (ok) finishReview('cancel');
    });
  };

  const act = (id: PlanAction) => {
    switch (id) {
      case 'dispatch':
        // A reply typed and not sent would be lost by dispatching: go back to it instead. (No toast: it
        // would sit on the reply line itself; the footer and the actions row say what Enter does.)
        if (prompt?.editor.text.trim()) { focus = 'input'; return; }
        finishReview('');
        return;
      case 'revise': focus = 'input'; return;
      case 'edit': finishReview('/edit'); return;
      case 'cancel': confirmCancel(); return;
      case 'backlog': finishReview(undefined); return;
    }
  };

  /** Enter in the reply line: nothing typed goes back to the plan; a cancel asks first; the rest is the answer. */
  const sendReply = () => {
    const r = review!;
    const e = prompt!.editor;
    if (!e.text.trim()) { focus = 'board'; return; }
    if (r.o.read(e.text) === 'cancel') { submit(e); focus = 'board'; confirmCancel(); return; }
    finishReview(submit(e));
  };

  // ---- moving around ----

  const move = (dCol: number, dRow: number) => {
    const cols = columns(o.getBoard()).filter((col) => col.cards.length);
    if (!cols.length) return;
    if (compact) {
      const cards = cols.flatMap((col) => col.cards);
      const current = Math.max(0, cards.findIndex((card) => card.id === selected));
      selected = cards[Math.max(0, Math.min(cards.length - 1, current + dRow + dCol))]!.id;
      return;
    }
    let ci = cols.findIndex((col) => col.cards.some((k) => k.id === selected));
    if (ci < 0) { selected = cols[0]!.cards[0]!.id; return; }
    let ri = cols[ci]!.cards.findIndex((k) => k.id === selected);
    ci = Math.max(0, Math.min(cols.length - 1, ci + dCol));
    ri = Math.max(0, Math.min(cols[ci]!.cards.length - 1, ri + dRow));
    selected = cols[ci]!.cards[ri]!.id;
  };

  /** A document position after a key: rows down from the top, within `l` (unknown before the first frame). */
  const scrolled = (v: number, key: string, l: Limits | undefined): number => {
    const max = l?.max ?? Number.MAX_SAFE_INTEGER;
    const page = l?.page ?? 5;
    const to = key === 'up' ? v - 1 : key === 'down' ? v + 1 : key === 'pageup' ? v - page : key === 'pagedown' ? v + page : key === 'home' ? 0 : key === 'end' ? max : v;
    return Math.max(0, Math.min(max, to));
  };

  /** The log counts entries below the view, so up is more. */
  const logNav = (key: string, by = 1) => {
    const l = last?.hits.log;
    const max = l?.max ?? notes.length;
    const page = l?.page ?? 5;
    const to = key === 'up' ? logScroll + by : key === 'down' ? logScroll - by : key === 'pageup' ? logScroll + page : key === 'pagedown' ? logScroll - page : key === 'home' ? max : key === 'end' ? 0 : logScroll;
    logScroll = Math.max(0, Math.min(max, to));
  };

  const agentNav = (key: string) => {
    const list = orderedAgents([...o.getAgents()]);
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((a) => a.id === agentSel));
    const page = last?.hits.agentPage ?? 5;
    const to = key === 'up' ? i - 1 : key === 'down' ? i + 1 : key === 'pageup' ? i - page : key === 'pagedown' ? i + page : key === 'home' ? 0 : key === 'end' ? list.length - 1 : i;
    agentSel = list[Math.max(0, Math.min(list.length - 1, to))]!.id;
  };

  const nav = (key: string) => {
    const hits = last?.hits;
    switch (focus) {
      case 'board':
        if (isPlan()) { planScroll = scrolled(planScroll, key, hits?.plan); return; }
        if (open) { openScroll = scrolled(openScroll, key, hits?.detail); return; }
        if (key === 'left') move(-1, 0);
        else if (key === 'right') move(1, 0);
        else if (key === 'up') move(0, -1);
        else if (key === 'down') move(0, 1);
        // The board has no pages of its own; these have always scrolled the log.
        else logNav(key);
        return;
      case 'agents': agentNav(key); return;
      case 'log': logNav(key); return;
      default: return;
    }
  };

  /** Tab order over what is on screen (every pane while one is zoomed, since Tab moves the zoom). */
  const cycle = (d: 1 | -1) => {
    const order = focusOrder({ review: review && { warnings: [], button: 0 }, prompt: prompt && { label: '', text: '', cursor: 0, hint: '' }, phase, board: o.getBoard() })
      .filter((f) => f === 'input' || zoom || last?.hits.panes[f]);
    if (!order.length) return;
    const next = order[(order.indexOf(focus) + d + order.length) % order.length]!;
    focus = next;
    if (zoom && next !== 'input') zoom = next;
  };

  const closeCard = () => {
    open = undefined;
    openScroll = 0;
    // Opened from the agents pane, it hands the keys back there, zoomed as it was.
    const from = openedFrom;
    openedFrom = undefined;
    if (from && focus === 'board') { focus = 'agents'; zoom = from.zoom; }
  };

  const enter = () => {
    if (focus === 'board') {
      if (isPlan()) return;
      if (open) closeCard();
      else if (selected) { open = selected; openScroll = 0; openedFrom = undefined; }
      return;
    }
    if (focus === 'agents') {
      const list = orderedAgents([...o.getAgents()]);
      const a = list.find((x) => x.id === agentSel) ?? list[0];
      if (!a?.cardId || !o.getBoard().cards.some((k) => k.id === a.cardId)) return;
      openedFrom = { zoom };
      selected = a.cardId;
      open = a.cardId;
      openScroll = 0;
      focus = 'board';
      if (zoom) zoom = 'board';
    }
  };

  // ---- keys ----

  /** Keys in the reply line. */
  const promptKey = (k: Key) => {
    const p = prompt!;
    const gh = ghost();
    if (k.name === 'tab' && gh) insertText(p.editor, gh);
    else if (k.name === 'tab') cycle(1);
    else if (k.name === 'shift-tab') cycle(-1);
    else if (k.name === 'escape') focus = 'board';
    else if (edit(p.editor, k) === 'submit' && review) sendReply();
  };

  const reviewKey = (k: Key) => {
    const r = review!;
    switch (k.name) {
      // Just shown, the review takes no Enter: one pressed for what was there before must not dispatch.
      case 'enter': if (!settling(r.settleUntil)) act(PLAN_ACTIONS[r.button]!.id); return;
      case 'left': r.button = Math.max(0, r.button - 1); return;
      case 'right': r.button = Math.min(PLAN_ACTIONS.length - 1, r.button + 1); return;
      case 'tab': cycle(1); return;
      case 'shift-tab': cycle(-1); return;
      // Esc never moves the choice: least of all onto Dispatch.
      case 'escape': if (zoom) zoom = undefined; return;
      case 'up': case 'down': case 'pageup': case 'pagedown': case 'home': case 'end': nav(k.name); return;
      // Typed text revises the plan, as it always has: the first key starts the reply.
      case 'char': if (prompt) { focus = 'input'; edit(prompt.editor, k); } return;
      default: return;
    }
  };

  const paneKey = (k: Key) => {
    switch (k.name) {
      case 'tab': cycle(1); return;
      case 'shift-tab': cycle(-1); return;
      case 'escape':
        if (zoom) zoom = undefined;
        else if (open) closeCard();
        return;
      case 'enter': enter(); return;
      case 'left': case 'right': case 'up': case 'down': case 'pageup': case 'pagedown': case 'home': case 'end': nav(k.name); return;
      case 'char': break;
      default: return;
    }
    const ctl = controllable(o.getBoard());
    switch (k.ch) {
      case 'h': nav('left'); return;
      case 'l': nav('right'); return;
      case 'k': nav('up'); return;
      case 'j': nav('down'); return;
      case 'z': zoom = zoom ? undefined : focus === 'input' ? 'board' : focus; return;
      case 'p': if (ctl) o.controls!.togglePause(); return;
      case 'x': if (ctl) stopDialog(); return;
      case 'i': if (ctl) instructDialog(); return;
      default: return;
    }
  };

  const handleKey = (k: Key) => {
    if (k.name === 'ctrl' && (k.ch === 'c' || (k.ch === 'd' && review))) {
      if (review) finishReview(undefined);
      else o.onInterrupt();
      return;
    }
    if (k.name === 'f1' || (k.name === 'char' && k.ch === '?' && focus !== 'input')) { openHelp(); return; }
    if (focus === 'input' && prompt) { promptKey(k); return; }
    // A paste is text, never keys: it goes into the reply, or nowhere.
    if (k.name === 'paste') { if (review && prompt) { focus = 'input'; edit(prompt.editor, k); } return; }
    if (review) { reviewKey(k); return; }
    paneKey(k);
  };

  const onKey = (k: Key) => {
    if (closed) return;
    try {
      const top = modals.at(-1);
      if (top) {
        // A dialog that appeared unasked takes no keys at first: they were typed for what was there.
        if (!settling(top.settleUntil)) {
          const r = top.modal.key(k);
          if (r) closeModal(top, r.value);
        }
      } else handleKey(k);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    paint();
  };

  // ---- mouse ----

  const wheel = (pane: Pane, d: number, m: Mouse) => {
    const hits = last!.hits;
    if (pane === 'board') {
      if (isPlan()) { planScroll = Math.max(0, Math.min(hits.plan?.max ?? 0, planScroll + 3 * d)); return; }
      if (open) { openScroll = Math.max(0, Math.min(hits.detail?.max ?? 0, openScroll + 3 * d)); return; }
      const col = hits.columns.find((x) => m.col >= x.left && m.col < x.left + x.cols) ?? hits.columns[0];
      if (!col?.ids.length) return;
      const i = col.ids.indexOf(selected ?? '');
      selected = col.ids[i < 0 ? 0 : Math.max(0, Math.min(col.ids.length - 1, i + d))];
      return;
    }
    if (pane === 'agents') { agentNav(d < 0 ? 'up' : 'down'); return; }
    logNav(d < 0 ? 'up' : 'down', 3);
  };

  const pointer = (m: Mouse) => {
    const hits = last?.hits;
    if (!hits) return;
    const pane = (Object.entries(hits.panes) as Array<[Pane, Rect]>).find(([, r]) => hit(m, r))?.[0];
    if (m.kind === 'wheel-up' || m.kind === 'wheel-down') { if (pane) wheel(pane, m.kind === 'wheel-up' ? -1 : 1, m); return; }
    if (m.kind !== 'press' || m.button !== 'left') return;
    const b = hits.buttons.find((x) => x.row === m.row && m.col >= x.from && m.col < x.to);
    if (b && review) {
      // The actions row has just appeared where something else was: a click aimed at that does nothing.
      if (settling(review.settleUntil)) return;
      review.button = Math.max(0, PLAN_ACTIONS.findIndex((a) => a.id === b.id));
      if (focus === 'input') focus = 'board';
      act(b.id);
      return;
    }
    if (prompt && hits.prompt === m.row) { focus = 'input'; return; }
    if (!pane) return;
    focus = pane;
    if (zoom) zoom = pane;
    if (review || isPlan()) return;
    if (pane === 'board' && !open) {
      const card = hits.cards.find((x) => hit(m, x.rect));
      if (card && card.id === selected) { open = card.id; openScroll = 0; openedFrom = undefined; } else if (card) selected = card.id;
    }
    if (pane === 'agents') {
      const a = hits.agents.find((x) => x.row === m.row);
      if (a) agentSel = a.id;
    }
  };

  const onMouse = (m: Mouse) => {
    if (closed) return;
    try {
      const top = modals.at(-1);
      if (top) {
        const r = top.rect;
        const wheelKind = m.kind === 'wheel-up' || m.kind === 'wheel-down';
        if (!wheelKind && settling(top.settleUntil)) { /* just appeared: the click was meant for what was there */ }
        else if (r && (hit(m, r) || wheelKind)) {
          const res = top.modal.mouse?.({ ...m, row: m.row - r.top, col: m.col - r.left });
          if (res) closeModal(top, res.value);
        } else if (m.kind === 'press') {
          // A click outside a dialog dismisses it, as in the app.
          closeModal(top, top.modal.cancel);
        }
      } else pointer(m);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    paint();
  };

  const onResize = () => {
    // Whatever moved under the pointer settles again.
    const until = clock() + SETTLE_MS;
    if (review) review.settleUntil = until;
    const top = modals.at(-1);
    if (top?.settleUntil !== undefined) top.settleUntil = until;
    paint();
  };

  screen.onKey(onKey);
  if (mouseOn) screen.onMouse?.(onMouse);
  screen.onResize(onResize);
  const timer = setInterval(paint, 100);
  paint();

  return {
    update: paint,
    note(msg) {
      notes.push(`${clockTime()}  ${msg}`);
      // Scrolled up, the view stays where it is: the newest lines wait below it.
      if (logScroll > 0) logScroll++;
      paint();
    },
    setPhase(p) { phase = p; paint(); },
    reviewPlan(opts) {
      return new Promise((resolve) => {
        if (opts.signal?.aborted || closed) return resolve(undefined);
        finishReview(undefined);
        review = { o: opts, button: 0, resolve, settleUntil: clock() + SETTLE_MS };
        prompt = { label: 'reply', hint: '', placeholder: 'ask for changes', suggest: opts.suggest, editor: createEditor(opts.history ?? history) };
        focus = 'board';
        zoom = undefined;
        planScroll = 0;
        opts.signal?.addEventListener('abort', () => { if (review?.resolve === resolve) { finishReview(undefined); paint(); } }, { once: true });
        paint();
      });
    },
    approve(opts) {
      return new Promise((resolve) => {
        if (opts.signal?.aborted || closed) return resolve(false);
        let entry: OpenModal | undefined;
        let settled = false;
        const answer = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
        const wait: Waiting = {
          show: () => { entry = openModal(approvalModal(opts), (v) => answer(v === true), true); },
          refuse: () => answer(false),
        };
        // Another dialog has the keyboard: what is typed there stays there, and this one comes next.
        if (modals.length) {
          waiting.push(wait);
          toast('Approval waiting', 'warn');
          paint();
        } else wait.show();
        opts.signal?.addEventListener('abort', () => {
          const i = waiting.indexOf(wait);
          if (i >= 0) waiting.splice(i, 1);
          if (entry) closeModal(entry, false);
          answer(false);
          paint();
        }, { once: true });
      });
    },
    close() {
      if (closed) return notes;
      closed = true;
      clearInterval(timer);
      // Whatever was open or waiting is answered as dismissed: no dialog approves anything on the way out.
      for (const m of modals.splice(0)) m.done(m.modal.cancel);
      for (const w of waiting.splice(0)) w.refuse();
      finishReview(undefined);
      screen.close();
      return notes;
    },
  };
}
