// The app shell: owns the terminal and draws a header (brand, repository and branch, a settings
// summary, the version), a tab bar, the active page's body and a footer of key hints. Modals stack
// over the dimmed page, toasts sit at the top right (beside the tabs when there is room), the
// palette and help are shell modals. The Icons and Mouse settings apply at once; in ASCII the
// whole frame is ASCII.
//
// Keys: the top modal gets everything; otherwise the top page of the active tab, and only keys it
// does not use reach the shell. Digits and [ ] switch tabs only from a tab's own page (never over a
// pushed one); Alt-digit always does. Nothing here knows what a page shows.
//
// Lifecycle: a page is activated when it shows and deactivated when it stops showing; before it is
// dropped for good (popped, cleared by navigate, the app quitting) it is asked `canLeave`, and once
// dropped it gets `dispose`, exactly once. A single-page host (`single`) has no tabs, and popping its
// page closes it.
//
// The terminal: `suspend` closes it and opens it again afterwards; `lend` keeps it open and lets
// another full-screen view draw on it meanwhile (`lending`).
import { basename } from 'node:path';
import type { Config } from '../config.ts';
import type { Session } from '../repl.ts';
import * as git from '../git/worktree.ts';
import type { Key, Mouse, Screen } from '../tui/screen.ts';
import { P, c, glyphs, resolveIcons, segments, type Glyphs, type IconSet } from '../tui/theme.ts';
import { asciiText, fit, plainText, spread, width } from '../tui/text.ts';
import {
  busyModal, confirmModal, createToasts, disabledReason, emptyState, frame, helpModal, hintBar, keyHint, nextExpiry, overlay, paletteModal,
  pickerModal, placeModal, promptModal, pruneToasts, pushToast, renderTabs, renderToasts, tabAt, viewerModal,
  type HelpGroup, type Hint, type Modal, type PaletteCommand, type Rect, type Rendered, type Size, type TabBar, type ToastKind,
} from '../tui/kit/index.ts';
import type { AppContext, LeaveReason, NavParams, Page, PageCommand, PageFactory } from './types.ts';
import { TERMS } from './look.ts';

export interface AppOptions {
  repoRoot: string;
  session: Session;
  version: string;
  /** The effective configuration, read fresh each time. */
  config: () => Config;
  /** Tab roots, in order. */
  pages: PageFactory[];
  /** Opens the terminal; called again each time `suspend` gives it back. */
  openScreen: () => Screen;
  /** Default: the configured icons (`config().tui.icons`, DULGER_ICONS wins). */
  icons?: IconSet;
  /** Default: Date.now. */
  now?: () => number;
  /** The branch shown in the header (default: asks git, refreshed when the app gets the terminal back). */
  branch?: () => string;
  /** Repaint interval while something animates (default 100ms). */
  tickMs?: number;
  /** App-wide palette entries, on every tab after the page's own (grouped under "App" unless they name a group). */
  commands?: (ctx: AppContext) => PageCommand[];
  /**
   * One page and no tabs (`pages` should hold one): no tab bar, no tab keys or "Go to" entries, and
   * popping the page (Esc, `ctx.pop()`) closes the app once it agrees.
   */
  single?: boolean;
}

export interface App {
  /** Open the screen and run until the person quits. */
  run(): Promise<void>;
  readonly ctx: AppContext;
  /** Paint now; tests use it after changing the fake screen's size. */
  paint(): void;
  /** End the app now, without asking the pages (the program is going away); every page is disposed. */
  quit(): void;
}

interface Tab { root: Page; stack: Page[] }
interface OpenModal { modal: Modal<unknown>; resolve: (v: unknown) => void; rect?: Rect; busy?: boolean }

const QUIT_WINDOW_MS = 2000;

export function createApp(o: AppOptions): App {
  const now = o.now ?? Date.now;
  // One glyph object for the app's life: when the Icons setting changes it is refilled in place, so a
  // page that kept `ctx.g` from its creation draws with the new set too. Fixed when `icons` is given.
  let iconSet: IconSet = o.icons ?? safeIcons(o.config);
  const g: Glyphs = { ...glyphs(iconSet) };
  /** Key names as the footer and help spell them: Enter as the glyph set's ⏎ (Enter in ASCII). */
  const keyName = (k: string) => k.replace(/\benter\b/g, g.enter);
  /** In ASCII the whole frame is ASCII: the arrows, dots, dashes and ellipses pages write are spelled out. */
  const asciiFrame = (lines: string[]) => (iconSet === 'ascii' ? lines.map(asciiText) : lines);
  const tickMs = o.tickMs ?? 100;
  const toasts = createToasts();
  const modals: OpenModal[] = [];
  let screen: Screen | undefined;
  let tabs: Tab[] = [];
  let active = 0;
  let started = false;
  let finished = false;
  let done: () => void = () => {};
  const finishedPromise = new Promise<void>((resolve) => { done = resolve; });
  let timer: ReturnType<typeof setInterval> | undefined;
  let ctrlCAt: number | undefined;
  const header = { summary: '', version: '', branch: '' };
  let headerDirty = true;
  /** The session the header was last computed for; a key press only recomputes it when the session changed. */
  let headerFor: string | undefined;
  let tabBar: TabBar = { line: '', spans: [] };
  let layoutRows = { tabs: -1, bodyTop: 0, bodyRows: 0 };
  const single = Boolean(o.single);
  /** The request whose pages are being asked `canLeave`; a newer request replaces it. */
  let leaving: { token: number; reason: LeaveReason } | undefined;
  let leaveSeq = 0;
  const disposed = new WeakSet<Page>();

  const current = (): Page => { const t = tabs[active]!; return t.stack.at(-1) ?? t.root; };

  const report = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    pushToast(toasts, plainText(msg) || 'Something went wrong.', 'error', now());
  };

  const activate = (p: Page, params?: NavParams) => {
    try {
      const r = p.activate?.(params);
      if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).then(() => paint(), (e) => { report(e); paint(); });
    } catch (e) { report(e); }
  };
  const deactivate = (p: Page) => { try { p.deactivate?.(); } catch (e) { report(e); } };
  const dispose = (p: Page) => {
    if (disposed.has(p)) return;
    disposed.add(p);
    try { p.dispose?.(); } catch (e) { report(e); }
  };

  // ---- modals ----

  const openModal = <T>(m: Modal<T>, extra: Partial<OpenModal> = {}): Promise<T> => {
    if (finished) return Promise.resolve(m.cancel);
    return new Promise<T>((resolve) => {
      modals.push({ modal: m as Modal<unknown>, resolve: resolve as (v: unknown) => void, ...extra });
      paint();
    });
  };
  const closeModal = (entry: OpenModal, value: unknown) => {
    const i = modals.indexOf(entry);
    if (i >= 0) modals.splice(i, 1);
    entry.resolve(value);
  };

  // ---- navigation ----

  // While the terminal is away (suspend, lend) nothing shows: pages are neither put away nor woken up
  // by navigation then; the page showing on the way back is activated once, by comeBack.
  const away = () => !screen;
  /** Params a navigate made while away brings, for the page it activates when the terminal is back. */
  let backWith: { page: Page; params?: NavParams } | undefined;

  const switchTo = (i: number) => {
    if (i < 0 || i >= tabs.length || i === active) return;
    if (!away()) deactivate(current());
    active = i;
    if (!away()) activate(current());
  };

  /**
   * Ask `asks` (top of each stack first) whether they may be dropped, then `proceed`. Synchronous
   * answers keep it synchronous; a page with an open question holds the request until it is answered.
   * A newer request replaces an unanswered one; a throw or a rejection counts as yes.
   */
  const guard = (asks: Array<{ page: Page; tab: number }>, reason: LeaveReason, proceed: () => void): void => {
    const token = ++leaveSeq;
    leaving = { token, reason };
    const live = () => !finished && leaving?.token === token;
    const step = (i: number): void => {
      if (!live()) return;
      if (i >= asks.length) { leaving = undefined; proceed(); return; }
      const { page, tab } = asks[i]!;
      if (!page.canLeave) { step(i + 1); return; }
      let answer: boolean | Promise<boolean>;
      try { answer = page.canLeave(reason); } catch (e) { report(e); step(i + 1); return; }
      if (answer && typeof (answer as Promise<boolean>).then === 'function') {
        // A page that asks a question is shown behind it; one that answers at once is not woken up.
        if (tab !== active) switchTo(tab);
        paint();
        (answer as Promise<boolean>).then(
          (ok) => { if (!live()) return; if (ok === false) leaving = undefined; else step(i + 1); paint(); },
          (e) => { if (!live()) return; report(e); step(i + 1); paint(); },
        );
        return;
      }
      // A page that refuses is shown, so the person sees what stayed and why.
      if (answer === false) { leaving = undefined; if (tab !== active) switchTo(tab); paint(); return; }
      step(i + 1);
    };
    step(0);
  };

  /** End now: settle the modals, put the page away, dispose every page, give the terminal back. */
  const end = () => {
    if (finished) return;
    finished = true;
    leaving = undefined;
    for (const m of modals.splice(0)) m.resolve(m.modal.cancel);
    if (started && screen) deactivate(current());
    for (const t of tabs) {
      for (const p of [...t.stack].reverse()) dispose(p);
      dispose(t.root);
    }
    stopTick();
    screen?.close();
    screen = undefined;
    done();
  };

  /** The person asked to quit: every page agrees first (the showing tab's first), then the app ends. */
  const quit = () => {
    if (finished) return;
    if (leaving?.reason === 'quit') { end(); return; }
    const order = [active, ...tabs.map((_, i) => i).filter((i) => i !== active)];
    const asks = order.flatMap((ti) => [...tabs[ti]!.stack].reverse().concat(tabs[ti]!.root).map((page) => ({ page, tab: ti })));
    guard(asks, 'quit', end);
  };

  const ctx: AppContext = {
    repoRoot: o.repoRoot,
    session: o.session,
    startSession: structuredClone(o.session),
    version: o.version,
    config: o.config,
    g,
    now,
    // Async page work (after a dialog) can change the session too, so the header summary is read again.
    redraw: () => { headerDirty = true; headerFor = undefined; paint(); },
    navigate(pageId, params) {
      if (finished) return;
      const i = tabs.findIndex((t) => t.root.id === pageId);
      if (i < 0) { pushToast(toasts, `No page called ${plainText(pageId)}`, 'warn', now()); paint(); return; }
      const dropped = [...tabs[i]!.stack].reverse();
      guard(dropped.map((page) => ({ page, tab: i })), 'navigate', () => {
        if (!away()) deactivate(current());
        const t = tabs[i]!;
        // Only what was there when asked goes; a page pushed meanwhile stays on top.
        t.stack = t.stack.filter((p) => !dropped.includes(p));
        active = i;
        const params_ = current() === t.root ? params : undefined;
        if (away()) backWith = { page: current(), params: params_ };
        else activate(current(), params_);
        for (const p of dropped) dispose(p);
        paint();
      });
    },
    push(page) {
      if (finished) return;
      if (!away()) deactivate(current());
      tabs[active]!.stack.push(page);
      if (!away()) activate(page);
      paint();
    },
    pop() {
      if (finished) return;
      const t = tabs[active]!;
      const page = t.stack.at(-1);
      if (!page) {
        if (single) guard([{ page: t.root, tab: active }], 'back', end);
        return;
      }
      guard([{ page, tab: active }], 'back', () => {
        if (t.stack.at(-1) !== page) return;
        t.stack.pop();
        if (tabs[active] === t && !away()) { deactivate(page); activate(current()); }
        dispose(page);
        paint();
      });
    },
    toast(message, kind: ToastKind = 'info') { pushToast(toasts, message, kind, now()); paint(); },
    confirm: (opts) => openModal(confirmModal(opts)),
    prompt: (opts) => openModal(promptModal(opts)),
    pick: (opts) => openModal(pickerModal({ ...opts, multi: false })).then((v) => v?.[0]),
    pickMany: (opts) => openModal(pickerModal({ ...opts, multi: true })),
    view: (opts) => openModal(viewerModal(opts)).then(() => undefined),
    modal: (m) => openModal(m),
    async busy(label, work) {
      const m = busyModal(label, now());
      let entry: OpenModal | undefined;
      // The spinner covers what was open when the work began, never a question the work (or anything
      // else) opened since: that one stays on top, where its keys go.
      const before = new Set(modals);
      // Work that settles quickly never flashes a spinner.
      const show = setTimeout(() => {
        if (finished) return;
        entry = { modal: m as Modal<unknown>, resolve: () => {}, busy: true };
        let at = 0;
        modals.forEach((x, i) => { if (before.has(x)) at = i + 1; });
        modals.splice(at, 0, entry);
        paint();
      }, 120);
      show.unref?.();
      try {
        return await (typeof work === 'function' ? work() : work);
      } finally {
        clearTimeout(show);
        if (entry) closeModal(entry, undefined);
        paint();
      }
    },
    async suspend(fn) {
      if (!screen || finished) return await fn();
      deactivate(current());
      stopTick();
      screen.close();
      screen = undefined;
      try {
        return await fn();
      } finally {
        if (!finished) {
          openTerminal();
          comeBack();
        }
      }
    },
    async lend(fn) {
      if (!screen || finished) return await fn(undefined);
      const mine = screen;
      deactivate(current());
      stopTick();
      // The app's handlers drop events while `screen` is not theirs.
      screen = undefined;
      const loan = lending(mine, asciiFrame);
      try {
        return await fn(loan.open);
      } finally {
        // Whatever the borrowers left open stops drawing and listening now.
        loan.end();
        if (finished) mine.close();
        else {
          attach(mine);
          comeBack();
        }
      }
    },
    quit,
  };

  tabs = o.pages.map((make) => ({ root: make(ctx), stack: [] }));
  if (!tabs.length) throw new Error('createApp needs at least one page');

  // ---- palette and help ----

  const globalHelp: HelpGroup = {
    title: 'Everywhere',
    keys: [
      ...(single ? [] : [{ key: '1-9  alt-1-9', label: 'switch tab' }, { key: '[  ]', label: 'previous / next tab' }]),
      { key: '^p  :', label: 'command palette' },
      { key: '?  F1', label: 'this help' },
      { key: 'esc', label: single ? 'back (closes this page)' : 'back' },
      { key: 'q  ^d', label: 'quit' },
      { key: '^c ^c', label: 'quit (press twice)' },
    ],
  };

  const openHelp = () => {
    const page = current();
    const own = safe(() => page.help?.(), undefined) ?? [{ title: page.title, keys: safe(() => page.hints(), []) }];
    // Over a pushed page bare digits and [ ] are not tab keys, and q does not always quit: say what is true here.
    const pushed = tabs[active]!.stack.length > 0;
    const global = pushed && !single
      ? { ...globalHelp, keys: globalHelp.keys.map((h) => (h.key === '1-9  alt-1-9' ? { key: 'alt-1-9', label: 'switch tab (bare digits only on a tab\'s own page)' } : h.key === 'q  ^d' ? { key: '^d', label: 'quit (q only on a tab\'s own page)' } : h)).filter((h) => h.key !== '[  ]') }
      : pushed ? { ...globalHelp, keys: globalHelp.keys.map((h) => (h.key === 'q  ^d' ? { key: '^d', label: 'quit' } : h)) } : globalHelp;
    const groups = [...own, global].map((gr) => ({ ...gr, keys: gr.keys.map((h) => ({ ...h, key: keyName(h.key) })) }));
    void openModal(helpModal(groups, 'Help'));
  };

  const openPalette = () => {
    const page = current();
    const own: PageCommand[] = safe(() => page.commands?.() ?? [], []);
    // An app-wide entry the page offers itself (Home's "New goal") is listed once, as the page's.
    const titleKey = (t: string) => plainText(t).replace(/…$/u, '').trim().toLowerCase();
    const ownTitles = new Set(own.map((cmd) => titleKey(cmd.title)));
    const everywhere: PageCommand[] = safe(() => o.commands?.(ctx) ?? [], []).filter((cmd) => !ownTitles.has(titleKey(cmd.title)));
    // The page's own commands carry no prefix (they are this page's); "Go to Home" says what it does;
    // only what another part of the app offers says so (App).
    const entries: Array<PaletteCommand & { run(): void | Promise<unknown> }> = [
      ...own.map((cmd) => ({ ...cmd, id: `page:${cmd.id}` })),
      ...(tabs[active]!.stack.length || single ? [{ id: 'app:back', title: single ? 'Close' : 'Back', shortcut: 'esc', run: () => ctx.pop() }] : []),
      ...(single ? [] : tabs.map((t, i) => ({ id: `go:${t.root.id}`, title: `Go to ${t.root.title}`, shortcut: i < 9 ? String(i + 1) : undefined, run: () => switchTo(i) }))),
      ...everywhere.map((cmd) => ({ ...cmd, id: `app:${cmd.id}`, group: cmd.group ?? 'App' })),
      { id: 'app:help', title: 'Help', shortcut: '?', run: openHelp },
      { id: 'app:quit', title: 'Quit', shortcut: 'q', run: quit },
    ];
    void openModal(paletteModal(entries)).then((id) => {
      const cmd = entries.find((e) => e.id === id);
      if (!cmd || finished) return;
      // A disabled command says why, briefly, and does not run.
      const why = disabledReason(cmd);
      if (why) { pushToast(toasts, plainText(why), 'info', now()); paint(); return; }
      Promise.resolve().then(() => cmd.run()).catch(report).finally(() => paint());
    });
  };

  // ---- keys and mouse ----

  const capturing = () => safe(() => Boolean(current().capturesText?.()), false);

  const ctrlC = () => {
    const t = now();
    if (ctrlCAt !== undefined && t - ctrlCAt < QUIT_WINDOW_MS) { quit(); return; }
    ctrlCAt = t;
    pushToast(toasts, '^c again quits', 'warn', t, QUIT_WINDOW_MS);
  };

  const shellKey = (k: Key) => {
    const text = capturing();
    switch (k.name) {
      case 'escape': ctx.pop(); return;
      case 'f1': openHelp(); return;
      case 'ctrl':
        if (k.ch === 'p') openPalette();
        else if (k.ch === 'd') quit();
        else if (k.ch === 'c') ctrlC();
        return;
      case 'alt':
        if (/^[1-9]$/.test(k.ch)) switchTo(Number(k.ch) - 1);
        return;
      case 'alt-left': case 'ctrl-pageup': switchTo((active - 1 + tabs.length) % tabs.length); return;
      case 'alt-right': case 'ctrl-pagedown': switchTo((active + 1) % tabs.length); return;
      case 'char':
        if (text) return;
        // Bare digits and [ ] switch tabs only from a tab's own page: over a pushed page (a form, a
        // review, the plan editor) they are never a tab switch. Alt-digit always is.
        if (tabs[active]!.stack.length && /^[1-9[\]]$/.test(k.ch)) return;
        if (/^[1-9]$/.test(k.ch)) switchTo(Number(k.ch) - 1);
        else if (k.ch === '[') switchTo((active - 1 + tabs.length) % tabs.length);
        else if (k.ch === ']') switchTo((active + 1) % tabs.length);
        else if (k.ch === '?') openHelp();
        else if (k.ch === ':') openPalette();
        // Like the digits: q quits from a tab's own page only, so a stray letter typed over a form, the
        // review or the plan editor never ends the app. Ctrl-D always quits.
        else if (k.ch === 'q' && !tabs[active]!.stack.length) quit();
        return;
    }
  };

  const onKey = (k: Key) => {
    if (!screen || finished) return;
    headerDirty = true;
    try {
      const top = modals.at(-1);
      if (top) {
        if (top.busy) { if (k.name === 'ctrl' && k.ch === 'c') ctrlC(); return paint(); }
        const r = top.modal.key(k);
        if (r) closeModal(top, r.value);
        return paint();
      }
      if (current().onKey(k)) return paint();
      shellKey(k);
    } catch (e) { report(e); }
    paint();
  };

  const onMouse = (m: Mouse) => {
    if (!screen || finished) return;
    try {
      const top = modals.at(-1);
      if (top) {
        if (top.busy) return;
        const wheel = m.kind === 'wheel-up' || m.kind === 'wheel-down';
        const r = top.rect;
        const inside = r && m.row >= r.top && m.row < r.top + r.rows && m.col >= r.left && m.col < r.left + r.cols;
        if (r && (inside || wheel)) {
          const res = top.modal.mouse?.({ ...m, row: m.row - r.top, col: m.col - r.left });
          if (res) closeModal(top, res.value);
        } else if (m.kind === 'press') {
          // A click outside a dialog cancels it.
          closeModal(top, top.modal.cancel);
        }
        return paint();
      }
      if (m.kind === 'press' && m.row === layoutRows.tabs) {
        const i = tabAt(tabBar, m.col);
        if (i !== undefined) switchTo(i);
        return paint();
      }
      const local = { ...m, row: m.row - layoutRows.bodyTop };
      const inBody = local.row >= 0 && local.row < layoutRows.bodyRows;
      if ((inBody || m.kind === 'wheel-up' || m.kind === 'wheel-down' || m.kind === 'release' || m.kind === 'drag') && current().onMouse?.(local)) return paint();
    } catch (e) { report(e); }
    paint();
  };

  // ---- drawing ----

  // The settings summary is re-read after every key (pages change the session); the branch only
  // when the app starts or gets the terminal back, since asking git costs a process.
  const refreshHeader = () => {
    headerDirty = false;
    // Reading the effective config costs file reads; after a key press it is done again only when the
    // session changed (a setting, a profile). redraw() and getting the terminal back always read it.
    const now = safe(() => JSON.stringify(o.session), '');
    if (now && now === headerFor && header.branch) return;
    headerFor = now;
    // Settings that change how the terminal is used apply at once: the icon set and mouse reporting.
    if (!o.icons) {
      const want = safeIcons(o.config);
      if (want !== iconSet) { iconSet = want; Object.assign(g, glyphs(want)); }
    }
    screen?.setMouse?.(safe(() => o.config().tui.mouse !== false, true));
    if (!header.branch) header.branch = safe(() => (o.branch ?? (() => git.currentBranch(o.repoRoot)))(), '?') || '?';
    let summary: string;
    try {
      const cfg = o.config();
      // The backend and the state that changes how a run behaves: the sandbox, routing when it is off, a pin.
      summary = [cfg.harness, `sandbox ${cfg.sandbox.mode}`, cfg.routing.enabled ? '' : TERMS.routingOff, o.session.model ? `pin ${o.session.model}` : ''].filter(Boolean).join(' · ');
    } catch {
      summary = 'config error';
    }
    header.summary = plainText(summary);
    header.version = plainText(/^\d/.test(o.version) ? `v${o.version}` : o.version);
  };

  const headerLine = (cols: number): string => {
    const repo = plainText(basename(o.repoRoot));
    const brand = { text: `${g.branch} dulger`, bg: P.mauve, fg: P.base, bold: true };
    const where = [{ text: repo, bg: P.surface1, fg: P.text }, { text: `${g.branch} ${plainText(header.branch)}`, bg: P.surface0, fg: P.subtext0 }];
    const { summary } = header;
    const rights = [[{ text: summary, bg: P.surface0, fg: P.subtext0 }], []].map((r) => r.filter((x) => x.text));
    const lefts = [[brand, ...where], [brand, where[0]!], [brand]];
    for (const l of lefts) {
      for (const r of rights) {
        const left = segments(l, g.sep, 'right');
        const right = r.length ? segments(r, g.sepLeft, 'left') : '';
        if (width(left) + width(right) + 1 <= cols) return spread(left, right, cols);
      }
    }
    return fit(segments([brand], g.sep, 'right'), cols, '');
  };

  /**
   * The key bar: the page's keys for what is selected (at most four), Esc on a pushed page, then
   * `? help`. A tab's own page is not named (the tab bar says it); a pushed page keeps its breadcrumb.
   * Everything else is in help and the palette.
   */
  const footerLine = (cols: number): string => {
    const t = tabs[active]!;
    const pushed = t.stack.length > 0 || single;
    let left = '';
    if (pushed) {
      const crumbs = [...(single ? [] : [t.root.title]), ...t.stack.map((p) => p.title), ...(single ? [t.root.title] : [])].map((s) => plainText(s));
      const sep = ` ${g.crumb} `;
      let text = crumbs.join(sep);
      const budget = Math.max(8, Math.floor(cols / 3));
      if (width(text) > budget) text = fit(crumbs.at(-1)!, budget);
      const parts = text.split(sep);
      left = c.bar(' ' + parts.map((p, i) => (i === parts.length - 1 ? c.text.bold(p) : c.muted(p))).join(c.faint(sep)) + ' ');
    }
    const page = safe(() => current().hints(), [] as Hint[]).slice(0, 4).map((h) => ({ ...h, key: keyName(h.key) }));
    const esc = pushed && page.length < 4 && !page.some((h) => h.key === 'esc') ? [{ key: 'esc', label: 'back' }] : [];
    // While a text field has the keyboard `?` is typed into it, so the bar names the key that does open help.
    const help = { key: capturing() ? 'F1' : '?', label: 'help' };
    let shown = [...page, ...esc];
    const used = (hs: Hint[]) => width(left) + [...hs, help].reduce((n, h) => n + width(keyHint(h.key, h.label)), 0);
    while (shown.length && used(shown) > cols) shown = shown.slice(0, -1);
    const line = left + [...shown, help].map((h) => keyHint(h.key, h.label)).join('');
    return width(line) >= cols ? fit(line, cols, '') : line + c.bar(' '.repeat(cols - width(line)));
  };

  const renderPage = (page: Page, size: Size): Rendered => {
    try {
      const r = page.render(size);
      return { lines: frame(Array.isArray(r?.lines) ? r.lines : [], size), cursor: r?.cursor };
    } catch (e) {
      // The error is data: it is the title (an empty state draws nothing else).
      return { lines: emptyState(size, { title: `${plainText(page.title)} failed to draw: ${plainText(e instanceof Error ? e.message : String(e))}` }, g) };
    }
  };

  function paint(): void {
    if (!screen || finished) return;
    const t = now();
    pruneToasts(toasts, t);
    if (ctrlCAt !== undefined && t - ctrlCAt >= QUIT_WINDOW_MS) ctrlCAt = undefined;
    if (headerDirty) refreshHeader();
    const size = { rows: Math.max(1, screen.rows), cols: Math.max(1, screen.cols) };
    const { rows, cols } = size;
    const footer = rows >= 2 ? 1 : 0;
    const head = rows >= 3 ? 1 : 0;
    const tabRow = rows >= 5 && !single ? 1 : 0;
    const bodyRows = Math.max(0, rows - footer - head - tabRow);
    let lines: string[] = [];
    if (head) lines.push(headerLine(cols));
    layoutRows = { tabs: -1, bodyTop: 0, bodyRows };
    if (tabRow) {
      tabBar = renderTabs(tabs.map((tab) => ({ id: tab.root.id, title: tab.root.title, badge: safe(() => tab.root.badge?.(), undefined) })), active, cols);
      layoutRows.tabs = lines.length;
      lines.push(tabBar.line);
    }
    layoutRows.bodyTop = lines.length;
    const page = current();
    const body = bodyRows ? renderPage(page, { rows: bodyRows, cols }) : { lines: [] };
    lines.push(...body.lines);
    let cursor = body.cursor ? { row: body.cursor.row + layoutRows.bodyTop, col: body.cursor.col } : undefined;
    if (footer) lines.push(footerLine(cols));
    lines = frame(lines, size);

    const top = modals.at(-1);
    if (top) {
      let box: Rendered;
      try { box = top.modal.render(size, g, t); } catch (e) { box = { lines: [c.bad(fit(`${g.cross} ${plainText(e instanceof Error ? e.message : String(e))}`, cols))] }; }
      const placed = placeModal(lines, box, size, top.modal.placement);
      lines = placed.lines;
      cursor = placed.cursor;
      top.rect = placed.rect;
    }
    // Toasts sit at the top right: on the tab row beside the tabs when there is room (it is empty
    // there), else from the body's first row (a panel's title border), growing down; never over the
    // status lines and strips pages keep at the bottom. Long ones wrap whole (paths, errors).
    const tabsEnd = tabRow ? Math.max(0, ...tabBar.spans.map((x) => x.to)) : cols;
    const from = tabRow ? layoutRows.tabs : layoutRows.bodyTop;
    const shown = renderToasts(toasts, Math.max(0, cols - 2), Math.max(0, rows - footer - from), g, t);
    if (shown.length) {
      const w = width(shown[0]!);
      const left = Math.max(0, cols - w - 1);
      const top = tabRow && left < tabsEnd + 2 ? layoutRows.bodyTop : from;
      lines = overlay(lines, shown.slice(0, Math.max(0, rows - footer - top)), top, left);
    }
    screen.paint(asciiFrame(lines), cursor);
    scheduleTick(page);
  }

  const animating = (page: Page) =>
    modals.some((m) => m.modal.animating?.()) || nextExpiry(toasts) !== undefined || ctrlCAt !== undefined || safe(() => Boolean(page.animating?.()), false);

  function scheduleTick(page: Page): void {
    const need = animating(page);
    if (need && !timer) {
      timer = setInterval(() => paint(), tickMs);
      timer.unref?.();
    } else if (!need && timer) stopTick();
  }

  function stopTick(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  /** Back from `suspend` or `lend`: everything may have changed meanwhile. */
  function comeBack(): void {
    headerDirty = true;
    header.branch = '';
    const page = current();
    const params = backWith?.page === page ? backWith.params : undefined;
    backWith = undefined;
    activate(page, params);
    paint();
  }

  function openTerminal(): void {
    attach(o.openScreen());
  }

  function attach(mine: Screen): void {
    screen = mine;
    // Events from a screen that has since been closed or replaced are dropped.
    mine.onKey((k) => { if (screen === mine) onKey(k); });
    mine.onMouse?.((m) => { if (screen === mine) onMouse(m); });
    mine.onResize(() => { if (screen === mine) paint(); });
  }

  return {
    ctx,
    paint,
    quit: end,
    run() {
      if (started) return finishedPromise;
      started = true;
      if (finished) return finishedPromise;
      openTerminal();
      const page = current();
      activate(page, backWith?.page === page ? backWith.params : undefined);
      backWith = undefined;
      paint();
      return finishedPromise;
    },
  };
}

/**
 * Screens on `real` for other full-screen views while the app lends it: `open` makes one, with `real`'s
 * size, painting and input. Views stack: the newest open one draws and gets the keys; closing it gives
 * them back to the one below (which is asked to repaint), whatever order they close in. Closing only
 * lets go of the input, never of the terminal. `end` (the loan is over) closes them all, so a view that
 * forgot to close, or a timer it left behind, can no longer draw over the app or take its keys.
 */
function lending(real: Screen, frame: (lines: string[]) => string[] = (l) => l): { open: () => Screen; end: () => void } {
  const none = () => {};
  interface View { key: (k: Key) => void; mouse: (m: Mouse) => void; resize: () => void }
  const views: View[] = [];
  let live = true;
  const install = (repaint: boolean) => {
    const top = live ? views.at(-1) : undefined;
    real.onKey(top?.key ?? none);
    real.onMouse?.(top?.mouse ?? none);
    real.onResize(top?.resize ?? none);
    if (top && repaint) top.resize();
  };
  const open = (): Screen => {
    const me: View = { key: none, mouse: none, resize: none };
    const showing = () => live && views.at(-1) === me;
    views.push(me);
    install(false);
    const screen: Screen = {
      get rows() { return real.rows; },
      get cols() { return real.cols; },
      paint(lines, cursor) { if (showing()) real.paint(frame(lines), cursor); },
      onKey(fn) { me.key = fn; if (showing()) real.onKey(fn); },
      onResize(fn) { me.resize = fn; if (showing()) real.onResize(fn); },
      close() {
        const i = views.indexOf(me);
        if (i < 0) return;
        views.splice(i, 1);
        if (i === views.length) install(true);
      },
    };
    if (real.onMouse) screen.onMouse = (fn) => { me.mouse = fn; if (showing()) real.onMouse!(fn); };
    if (real.setMouse) screen.setMouse = (on) => { if (showing()) real.setMouse!(on); };
    return screen;
  };
  return {
    open,
    end: () => { live = false; views.length = 0; install(false); },
  };
}

function safeIcons(config: () => Config): IconSet {
  try { return resolveIcons(config().tui.icons); } catch { return resolveIcons('auto'); }
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
