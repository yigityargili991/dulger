// Shared helpers for the live run view tests (not a test file itself): boards, agents and a run view
// on a fake screen with the controls recorded.
import { createTui, type Tui } from '../src/tui/tui.ts';
import { glyphs } from '../src/tui/theme.ts';
import { width } from '../src/tui/text.ts';
import type { ViewState } from '../src/tui/view.ts';
import type { AgentStatus, Board, Card } from '../src/types.ts';
import { fakeScreens, plain, type FakeScreen } from './kit.helpers.ts';

export function card(id: string, status: Card['status'], extra: Partial<Card> = {}): Card {
  return {
    id, title: `Card ${id}`, description: 'does things', acceptanceCriteria: ['works'], dependsOn: [], verify: [], status, attempts: 0, feedback: [], costUsd: 0,
    tasks: [{ id: 't1', cardId: id, title: 'task', instructions: '', status: status === 'done' ? 'done' : 'pending', attempts: 0 }], ...extra,
  };
}

export function board(cards: Card[], extra: Partial<Board> = {}): Board {
  return { runId: 'r1', goal: 'a goal', baseRef: 'x', baseBranch: 'master', runBranch: 'dulger/r1', createdAt: '', cards, costUsd: 0, ...extra };
}

export function agent(id: string, extra: Partial<AgentStatus> = {}): AgentStatus {
  return { id, role: 'worker', harness: 'fake', state: 'done', turns: 2, history: [], startedAt: 0, endedAt: 1000, ...extra };
}

export function viewState(b: Board, over: Partial<ViewState> = {}): ViewState {
  return { board: b, agents: [], notes: [], startedAt: 0, now: 1000, rows: 30, cols: 100, g: glyphs('unicode'), phase: 'running', openScroll: 0, logScroll: 0, focus: 'board', ...over };
}

export interface Rig {
  tui: Tui;
  s: FakeScreen;
  b: Board;
  agents: AgentStatus[];
  stopped: string[];
  guided: string[];
  pauses: number;
  interrupts: number;
  /** With `settle: true`: move the clock the view's input guards read. */
  advance(ms: number): void;
  /** The footer, plain. */
  bar(): string;
  /** The whole screen, plain. */
  text(): string;
}

/**
 * A run view on a fake screen, phase `running` unless told otherwise, with every control recorded. Its
 * input guards (what appeared unasked ignores Enter and clicks for a moment) see a second pass between
 * any two reads of the clock, so they never get in the way; `settle: true` stops the clock, and
 * `advance` moves it, to test them.
 */
export function rig(o: { rows?: number; cols?: number; board?: Board; agents?: AgentStatus[]; phase?: string; mouse?: boolean; controls?: boolean; settle?: boolean } = {}): Rig {
  const screens = fakeScreens(o.rows ?? 24, o.cols ?? 80);
  const b = o.board ?? board([card('c1', 'in_progress'), card('c2', 'in_progress'), card('c3', 'done')]);
  const agents = o.agents ?? [];
  const r = { b, agents, stopped: [] as string[], guided: [] as string[], pauses: 0, interrupts: 0 } as Rig;
  let now = 1_000_000;
  r.advance = (ms) => { now += ms; };
  r.tui = createTui({
    now: o.settle ? () => now : () => (now += 1000),
    screen: screens.factory(), getBoard: () => b, getAgents: () => agents, icons: 'unicode', mouse: o.mouse ?? true,
    onInterrupt: () => { r.interrupts++; },
    controls: o.controls === false ? undefined : {
      togglePause: () => { r.pauses++; b.paused = !b.paused; return Boolean(b.paused); },
      stopCard: (id) => { r.stopped.push(id); },
      guideCard: (id, text) => { r.guided.push(`${id}:${text}`); },
    },
  });
  r.s = screens.current;
  r.bar = () => plain(r.s.lines.at(-1) ?? '');
  r.text = () => r.s.text;
  if (o.phase !== undefined) r.tui.setPhase(o.phase);
  else r.tui.setPhase('running');
  return r;
}

/** Let promise callbacks run. */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Whether a promise has settled yet, and with what. */
export function track<T>(p: Promise<T>): { done: boolean; value?: T } {
  const t: { done: boolean; value?: T } = { done: false };
  p.then((v) => { t.done = true; t.value = v; });
  return t;
}

/** Row and column of the first cell of `needle` on the screen. */
export function find(lines: string[], needle: string): { row: number; col: number } | undefined {
  for (let row = 0; row < lines.length; row++) {
    const at = plain(lines[row]!).indexOf(needle);
    if (at >= 0) return { row, col: width(plain(lines[row]!).slice(0, at)) };
  }
  return undefined;
}
