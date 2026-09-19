// The full-screen run view: the board as columns of cards, the agents, the log, and a prompt line for
// the moments a run asks something (dispatch? revise the plan?). Keys move around the board; Ctrl-C
// means what it means everywhere else in dulger: stop the agents and come back.
import type { AgentStatus, Board } from '../types.ts';
import { history } from '../ui/prompt.ts';
import type { Suggestion } from '../replCommands.ts';
import { createEditor, edit, insertText, submit, type Editor } from './editor.ts';
import { openScreen, type Key, type Screen } from './screen.ts';
import { glyphs, type IconSet } from './theme.ts';
import { columns, render, type ViewState } from './view.ts';

export interface TuiOptions {
  getBoard(): Board;
  getAgents(): Iterable<AgentStatus>;
  icons: IconSet;
  /** Ctrl-C while no prompt is open. */
  onInterrupt(): void;
  screen?: Screen;
  controls?: { togglePause(): boolean; stopCard(id: string): void; guideCard(id: string, text: string): void };
}

export interface Tui {
  /** Something on the board or an agent changed. */
  update(): void;
  /** A log line; timestamped here. */
  note(msg: string): void;
  /** What the run is doing, for the bottom bar. */
  setPhase(phase: string): void;
  /** Show the prompt line and wait for a line; undefined on Ctrl-C / Ctrl-D. */
  ask(label: string, hint: string, suggest?: (line: string) => Suggestion): Promise<string | undefined>;
  /** Leave the alternate screen. The log lines are returned so the caller can keep what matters. */
  close(): string[];
}

/** Whether the full-screen view can run here. */
export function tuiUsable(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export function createTui(o: TuiOptions): Tui {
  const screen = o.screen ?? openScreen();
  const g = glyphs(o.icons);
  const notes: string[] = [];
  const startedAt = Date.now();
  let phase = 'starting';
  let selected: string | undefined;
  let open: string | undefined;
  let openScroll = 0;
  let logScroll = 0;
  let focus: ViewState['focus'] = 'board';
  let prompt: { label: string; hint: string; suggest?: (line: string) => Suggestion; editor: Editor; resolve: (v: string | undefined) => void } | undefined;
  let closed = false;
  let compact = false;

  /** What the prompt predicts for what is typed, dimmed after the cursor. Nothing to predict mid-line. */
  const ghost = (): string => {
    const e = prompt?.editor;
    return e && prompt?.suggest && e.cursor === [...e.text].length ? prompt.suggest(e.text).ghost : '';
  };

  const state = (): ViewState => {
    const board = o.getBoard();
    if (!selected || !board.cards.some((k) => k.id === selected)) selected = columns(board).find((col) => col.cards.length)?.cards[0]?.id;
    if (open && !board.cards.some((k) => k.id === open)) open = undefined;
    return {
      board, agents: [...o.getAgents()], notes, startedAt, now: Date.now(), rows: screen.rows, cols: screen.cols, g, phase: phase === 'running' && ['docs', 'verifying'].includes(board.checkpoint?.phase ?? '') ? board.checkpoint!.phase : board.paused ? 'paused · p resume · x stop card · i instruct' : phase === 'running' && o.controls ? 'running · p pause · x stop card · i instruct' : phase,
      selected, open, openScroll, logScroll, focus,
      prompt: prompt && { label: prompt.label, hint: prompt.hint, ghost: ghost(), text: prompt.editor.text, cursor: prompt.editor.cursor },
    };
  };

  const paint = () => {
    if (closed) return;
    const f = render(state());
    compact = f.compact;
    screen.paint(f.lines, f.cursor);
  };

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

  const onKey = (k: Key) => {
    if (closed) return;
    if (k.name === 'ctrl' && (k.ch === 'c' || (k.ch === 'd' && prompt))) {
      if (prompt) finishPrompt(undefined);
      else o.onInterrupt();
      return paint();
    }
    if (prompt && focus === 'input') {
      const g = ghost();
      if (k.name === 'tab' && g) insertText(prompt.editor, g);
      else if (k.name === 'tab' || k.name === 'escape') focus = 'board';
      else if (edit(prompt.editor, k) === 'submit') finishPrompt(submit(prompt.editor));
      return paint();
    }
    const controllable = !prompt && phase === 'running' && !['docs', 'verifying', 'finished'].includes(o.getBoard().checkpoint?.phase ?? '');
    switch (k.name) {
      case 'tab': if (prompt) focus = 'input'; break;
      case 'escape': if (open) { open = undefined; openScroll = 0; } else if (prompt) focus = 'input'; break;
      case 'enter': if (open) { open = undefined; openScroll = 0; } else if (selected) { open = selected; openScroll = 0; } break;
      case 'left': move(-1, 0); break;
      case 'right': move(1, 0); break;
      case 'up': if (open) openScroll = Math.max(0, openScroll - 1); else move(0, -1); break;
      case 'down': if (open) openScroll++; else move(0, 1); break;
      case 'pageup': logScroll = Math.min(Math.max(0, notes.length - 1), logScroll + 5); break;
      case 'pagedown': logScroll = Math.max(0, logScroll - 5); break;
      case 'home': logScroll = Math.max(0, notes.length - 1); break;
      case 'end': logScroll = 0; break;
      case 'char':
        if (controllable && o.controls && k.ch === 'p') {
          o.controls.togglePause();
        } else if (controllable && o.controls && selected && (k.ch === 'x' || k.ch === 'i')) {
          const id = selected;
          const stopping = k.ch === 'x';
          prompt = { label: stopping ? `stop ${id}` : `instruct ${id}`, hint: stopping ? 'Type stop to cancel this card; completed work is kept. Ctrl-C cancels this action.' : 'Instructions apply to the next worker attempt. Ctrl-C cancels this action.', editor: createEditor([]), resolve: (value) => {
            if (stopping && value?.trim() === 'stop') o.controls!.stopCard(id);
            else if (!stopping && value?.trim()) o.controls!.guideCard(id, value);
          } };
          focus = 'input';
        } else if (k.ch === 'h') move(-1, 0);
        else if (k.ch === 'l') move(1, 0);
        else if (k.ch === 'k') { if (open) openScroll = Math.max(0, openScroll - 1); else move(0, -1); }
        else if (k.ch === 'j') { if (open) openScroll++; else move(0, 1); }
        else if (k.ch === 'q' && prompt) finishPrompt(undefined);
        break;
    }
    paint();
  };

  const finishPrompt = (value: string | undefined) => {
    const p = prompt;
    prompt = undefined;
    focus = 'board';
    p?.resolve(value);
  };

  screen.onKey(onKey);
  screen.onResize(paint);
  const timer = setInterval(paint, 100);
  paint();

  return {
    update: paint,
    note(msg) {
      notes.push(`${new Date().toISOString().slice(11, 19)}  ${msg}`);
      paint();
    },
    setPhase(p) { phase = p; paint(); },
    ask(label, hint, suggest) {
      return new Promise((resolve) => {
        prompt = { label, hint, suggest, editor: createEditor(history), resolve };
        focus = 'input';
        paint();
      });
    },
    close() {
      if (closed) return notes;
      closed = true;
      clearInterval(timer);
      if (prompt) finishPrompt(undefined);
      screen.close();
      return notes;
    },
  };
}
