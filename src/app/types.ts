// Contracts between the app shell (src/app/shell.ts) and its pages (src/app/pages/*). A page draws
// only the body area between the tab bar and the footer; the shell owns the terminal, the header,
// tabs, footer, modals, toasts, the palette and help.
import type { Config } from '../config.ts';
import type { Session } from '../repl.ts';
import type { Key, Mouse, Screen } from '../tui/screen.ts';
import type { Glyphs } from '../tui/theme.ts';
import type {
  ConfirmOptions, HelpGroup, Hint, Modal, PaletteCommand, PickOptions, PromptOptions, Rendered, Size, ToastKind, ViewOptions,
} from '../tui/kit/index.ts';

export type { ConfirmOptions, HelpGroup, Hint, Modal, PickOptions, PromptOptions, Rendered, Size, ToastKind, ViewOptions };

/** Parameters passed to a page by `navigate`, e.g. `{ run: 'r12' }`. */
export type NavParams = Record<string, string | number | boolean | undefined>;

/**
 * Why a page is about to be dropped: Esc or Back pops it (`back`), `navigate` clears its tab's stack
 * (`navigate`), or the app quits (`quit`).
 */
export type LeaveReason = 'back' | 'navigate' | 'quit';

/** A palette entry a page contributes; `id` only needs to be unique within the page. */
export interface PageCommand extends PaletteCommand {
  /** Errors (thrown or rejected) become an error toast. */
  run(): void | Promise<unknown>;
}

export interface Page {
  /** Stable id: `navigate(id)` finds a tab by its root page's id. */
  readonly id: string;
  /** Tab title, breadcrumb part and palette group. */
  readonly title: string;
  /**
   * Called whenever the page becomes visible: its tab is chosen, the page above it is popped, the app
   * gets the terminal back after `suspend`, or `navigate` brings `params`. Reload data here. A returned
   * promise is not awaited before drawing; the shell repaints when it settles and toasts a rejection.
   */
  activate?(params?: NavParams): void | Promise<void>;
  /** Called when the page stops being visible (another tab, a pushed page, suspend, quit). */
  deactivate?(): void;
  /**
   * Asked before the page is dropped for good (see LeaveReason); resolve false to stay. The page asks
   * its own question (a confirm naming what would be lost). A page in a tab that is not showing is
   * shown when it asks (returns a promise) or refuses, so the question is asked over it; one that
   * answers yes at once is not woken up. Switching tabs never asks: the page stays on its
   * tab's stack and only gets deactivate (and activate when its tab is shown again). A throw or a
   * rejection counts as yes and is shown as an error, so a broken page cannot keep anyone in; asking
   * to quit again while a quit is being asked about quits without asking.
   */
  canLeave?(reason: LeaveReason): boolean | Promise<boolean>;
  /**
   * Called exactly once when the page leaves its stack for good: popped, dropped by `navigate`, or the
   * app ended. It comes after `deactivate` and after the page now showing was activated, so it may
   * push or navigate. Release what the page holds here.
   */
  dispose?(): void;
  /** The body area: exactly `size.rows` lines of `size.cols` cells (the shell cuts or pads anyway). */
  render(size: Size): Rendered;
  /** True when the page used the key. Unused keys go to the shell (tabs, help, palette, quit, Esc = back). */
  onKey(key: Key): boolean;
  /** Mouse reports with rows and columns relative to the body area. */
  onMouse?(m: Mouse): boolean;
  /** Footer hints for the page, most important first; the shell adds its own and drops what does not fit. */
  hints(): Hint[];
  /** Palette entries; shown first, grouped under the page title unless they name a group. */
  commands?(): PageCommand[];
  /** Help overlay groups for this page (default: one group made of `hints()`). */
  help?(): HelpGroup[];
  /** True while a text field has focus: the shell then leaves digits, [ ] ? : q alone. */
  capturesText?(): boolean;
  /** True while something on the page moves (a spinner): the shell keeps repainting. */
  animating?(): boolean;
  /** A short badge next to the tab title, e.g. a count. Only asked of tab roots. */
  badge?(): string | undefined;
}

export type PageFactory = (ctx: AppContext) => Page;

/** Given to every page. Everything here is safe to call from key handlers and async work. */
export interface AppContext {
  readonly repoRoot: string;
  readonly session: Session;
  /**
   * The session as the app found it, command-line flags included: what Settings' Discard goes back to,
   * and what the note printed after the app exits compares with. Never changed.
   */
  readonly startSession: Readonly<Session>;
  readonly version: string;
  /** The effective configuration (`sessionConfig(repoRoot, session)`), read fresh on every call. */
  config(): Config;
  readonly g: Glyphs;
  /** The clock the shell uses (injectable for tests). */
  now(): number;
  /** Repaint soon (after async work changed what a page shows). */
  redraw(): void;
  /**
   * Switch to the tab whose root page has `pageId`, closing pages pushed over it (each asked first, see
   * `canLeave`), and activate it with `params`. Unknown ids are a toast, never an error. While the
   * terminal is away (`suspend`, `lend`) pages are moved but not activated; the page showing when it is
   * back is activated once, with these params when it is the one navigated to.
   */
  navigate(pageId: string, params?: NavParams): void;
  /** Show `page` over the current tab (a breadcrumb in the footer; unused Esc pops it). */
  push(page: Page): void;
  /**
   * Close the top pushed page of the current tab once it agrees (`canLeave`); nothing when there is
   * none. On a single-page host (`runPage`) popping the page itself closes the host.
   */
  pop(): void;
  toast(message: string, kind?: ToastKind): void;
  /** Resolves true only when the person confirmed. The safe choice has focus first. */
  confirm(o: ConfirmOptions): Promise<boolean>;
  /** The text entered, or undefined when cancelled. */
  prompt(o: PromptOptions): Promise<string | undefined>;
  /** One option's value, or undefined when cancelled. */
  pick(o: Omit<PickOptions, 'multi'>): Promise<string | undefined>;
  /**
   * The checked values, or undefined when cancelled. With nothing checked: the highlighted one, or []
   * with `allowNone` (for "none of these" being an answer).
   */
  pickMany(o: Omit<PickOptions, 'multi'>): Promise<string[] | undefined>;
  /** A scrollable viewer for long text or a diff; resolves when closed. */
  view(o: ViewOptions): Promise<void>;
  /** Any kit modal, or one of your own built on the `Modal` interface. */
  modal<T>(m: Modal<T>): Promise<T>;
  /**
   * A spinner over the page while `work` runs; resolves or rejects with it. A dialog the work (or anything
   * else) opens meanwhile shows above the spinner and gets the keys.
   */
  busy<T>(label: string, work: Promise<T> | (() => Promise<T>)): Promise<T>;
  /**
   * Give the terminal away completely (the screen is closed), run `fn`, then take it back, re-activate
   * the current page and repaint — also when `fn` throws, which is then rethrown. This is how the live
   * run view and legacy prompts run from inside the app.
   */
  suspend<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * Lend the terminal to another full-screen view (the live run view) instead of giving it away: the
   * app stops drawing and listening, and `fn` gets `open`, which makes a screen on the app's terminal
   * for that view; closing that screen hands the terminal back to the app, never to the shell, so
   * nothing flickers in between. Views opened on one loan stack: the newest draws and gets the keys,
   * and closing it (in any order) gives them back to the one below. When `fn` settles every screen it
   * opened is closed, so a view left open cannot draw over the app. Afterwards the current page is
   * re-activated and repainted, as after `suspend`, also when `fn` throws. `open` is undefined when the
   * app has no terminal to lend.
   */
  lend<T>(fn: (open: (() => Screen) | undefined) => T | Promise<T>): Promise<T>;
  /** Leave the app (`run()` resolves) once every open page agrees (`canLeave`), as q does. */
  quit(): void;
}
