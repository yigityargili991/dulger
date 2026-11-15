// The Doctor tab: the readiness checks a run makes before it starts (preflight), as one list: status
// glyph, name and a short value that says what is wrong, with the counts in its border. Enter goes to
// the tab that fixes the selected check; `?` leads with that check's whole detail. The checks spawn
// processes and block for a moment, so they run after a "checking" frame has been painted, when the
// tab is first shown, when the settings changed or the results grew old, and on request.
import type { Config } from '../../config.ts';
import { keySource } from '../../keys.ts';
import { preflight, type PreflightCheck } from '../../preflight.ts';
import { c, type Glyphs } from '../../tui/theme.ts';
import { fit, plainText, width } from '../../tui/text.ts';
import {
  compose, createList, emptyState, hit, listKey, listMouse, listScroll, panel, renderList, selectedItem, selectId, setItems, spinnerFrame,
  type Hint, type ListItem, type Rect,
} from '../../tui/kit/index.ts';
import type { AppContext, HelpGroup, Page, PageCommand } from '../types.ts';
import { describeCheck, summarize, type DoctorCheck } from './doctor.checks.ts';

export interface DoctorPageOptions {
  /** Runs the checks; preflight by default. Tests pass made-up ones. */
  checks?: (repoRoot: string, config: Config, o: { allowDirty: boolean }) => PreflightCheck[];
  /** How long results count as current when the tab is shown again (default a minute). */
  staleMs?: number;
  /** How long the "checking" frame stays up before the checks block (default 20ms). */
  delayMs?: number;
}

const message = (e: unknown): string => plainText(e instanceof Error ? e.message : String(e)) || 'Something went wrong.';

function statusGlyph(s: PreflightCheck['status'], g: Glyphs): string {
  return s === 'pass' ? c.ok(g.check) : s === 'warning' ? c.warn(g.warn) : c.bad(g.cross);
}

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * The row's value. A check that fails or needs a look always says what is wrong: its own short value,
 * or else the first words of its detail (a check this page does not know yet).
 */
function rowValue(ch: DoctorCheck): string | undefined {
  if (ch.value) return plainText(ch.value);
  if (ch.status === 'pass') return undefined;
  // Its first sentence, cut: a tool's own "fatal: …" keeps what follows the colon.
  const first = plainText(ch.detail).split(/[.;](\s|$)/)[0]!.trim();
  return first ? fit(first.charAt(0).toLowerCase() + first.slice(1), 24) : ch.status;
}

/** What `?` says about the page, under the selected check and the keys. */
const about = (g: Glyphs): string[] => [
  `${g.cross} must be fixed before a run starts, ${g.warn} needs a look, ${g.check} passes. The border counts each; the tab counts what must be fixed, or shows ${g.check} when nothing does.`,
  'These checks make no paid model calls and cannot prove a key is valid; the first agent call does that.',
  'They run when the tab is shown after the settings changed or a minute passed, and on r.',
];

export function createDoctorPage(ctx: AppContext, o: DoctorPageOptions = {}): Page {
  const g = ctx.g;
  const runChecks = o.checks ?? ((root: string, config: Config, x: { allowDirty: boolean }) => preflight(root, config, x));
  const staleMs = o.staleMs ?? 60_000;
  let state: 'idle' | 'checking' | 'done' = 'idle';
  let results: DoctorCheck[] = [];
  let ranAt: number | undefined;
  let fingerprint = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const list = createList([], { empty: 'No checks' });
  let listRect: Rect = { top: 0, left: 0, rows: 0, cols: 0 };

  // What the checks depend on beyond the repository: the effective config, the session's switches and
  // which provider keys are present (a key added on Providers changes no config).
  const currentFingerprint = (): string => {
    try {
      const config = ctx.config();
      const keys = Object.values(config.providers).map((p) => (p?.apiKeyEnv ? keySource(p.apiKeyEnv) : ''));
      return JSON.stringify([config, keys, ctx.session.allowDirty]);
    } catch (e) { return `error ${message(e)}`; }
  };

  const ids = (checks: DoctorCheck[]) => {
    const seen = new Map<string, number>();
    return checks.map((ch) => { const n = seen.get(ch.label) ?? 0; seen.set(ch.label, n + 1); return n ? `${ch.label}#${n}` : ch.label; });
  };
  const selected = (): DoctorCheck | undefined => {
    const id = selectedItem(list)?.id;
    const all = ids(results);
    const i = id === undefined ? -1 : all.indexOf(id);
    return i >= 0 ? results[i] : undefined;
  };

  function run(): void {
    const first = ranAt === undefined;
    let config: Config | undefined;
    let checks: PreflightCheck[];
    let failed = false;
    try {
      config = ctx.config();
      checks = runChecks(ctx.repoRoot, config, { allowDirty: ctx.session.allowDirty });
    } catch (e) {
      // A config that cannot be read, or checks that could not run, is itself the finding, not a broken page.
      failed = true;
      checks = [{ label: 'Settings', status: 'error', detail: config ? `The checks could not run: ${message(e)}` : `The settings cannot be read: ${message(e)}` }];
    }
    results = checks.map((ch): DoctorCheck => {
      if (failed) return { ...ch, value: config ? 'checks failed' : 'unreadable', action: { title: 'Open Settings', page: 'settings' } };
      try { return describeCheck(ch, config!); } catch { return { ...ch }; }
    });
    ranAt = ctx.now();
    fingerprint = currentFingerprint();
    state = 'done';
    const keep = selectedItem(list)?.id;
    const all = ids(results);
    // A row is the status glyph, the name and a short value; the glyph says the status.
    setItems(list, results.map((ch, i): ListItem => ({
      id: all[i]!, label: plainText(ch.label), icon: statusGlyph(ch.status, g), meta: rowValue(ch),
    })));
    // The first time, start where attention is needed; after that, stay on the check that was open.
    const firstIssue = results.findIndex((ch) => ch.status === 'error');
    const target = first || keep === undefined ? all[firstIssue >= 0 ? firstIssue : Math.max(0, results.findIndex((ch) => ch.status !== 'pass'))] : keep;
    if (target !== undefined) selectId(list, target);
  }

  /** Paint "checking" first, then block on the checks. Resolves once they ran (or were called off). */
  const schedule = (): Promise<void> => {
    if (pending) return pending;
    state = 'checking';
    pending = new Promise<void>((resolve) => {
      settle = () => { timer = undefined; pending = undefined; settle = undefined; resolve(); };
      timer = setTimeout(() => { try { run(); } finally { settle?.(); } }, o.delayMs ?? 20);
    });
    return pending;
  };
  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    state = ranAt === undefined ? 'idle' : 'done';
    settle?.();
  };
  const rerun = () => { void schedule().then(() => ctx.redraw()); };

  const fix = (ch: DoctorCheck | undefined) => {
    if (!ch?.action) return false;
    ctx.navigate(ch.action.page, ch.action.params);
    return true;
  };

  // ---- drawing ----

  /** The counts in the list's border: `✗7 !2 ✓4`, each in its colour, zeros left out. */
  const counts = (): string => {
    const s = summarize(results);
    return [
      s.error ? c.bad(`${g.cross}${s.error}`) : '',
      s.warning ? c.warn(`${g.warn}${s.warning}`) : '',
      s.pass ? c.ok(`${g.check}${s.pass}`) : '',
    ].filter(Boolean).join(' ');
  };

  const page: Page = {
    id: 'doctor',
    title: 'Doctor',
    activate() {
      if (state === 'checking') return pending;
      const stale = ranAt === undefined || ctx.now() - ranAt >= staleMs || currentFingerprint() !== fingerprint;
      return stale ? schedule() : undefined;
    },
    deactivate: cancel,
    render(size) {
      if (state !== 'done') return { lines: emptyState(size, { title: `${spinnerFrame(g, ctx.now())} checking` }, g) };
      if (!results.length) return { lines: emptyState(size, { title: 'No checks ran' }, g) };
      // One panel, as wide and as tall as its rows (pointer, glyph, name, two spaces, value) and its badge.
      const rowW = Math.max(18, ...results.map((x) => {
        const v = rowValue(x);
        return 4 + width(plainText(x.label)) + (v ? 2 + width(v) : 0);
      }), width(plainText(counts())) + 14);
      listRect = { top: 0, left: 0, rows: Math.min(size.rows, results.length + 2), cols: Math.min(size.cols, rowW + 4) };
      return compose(size, [{ rect: listRect, block: panel(listRect, {
        g, title: 'Checks', focused: true, badge: counts(),
        footer: ranAt !== undefined ? () => c.muted(`checked ${clock(ranAt!)}`) : undefined, scroll: () => listScroll(list),
      }, (inner) => renderList(list, inner, g, { focused: true, keepMeta: true })) }]);
    },
    onKey(k) {
      if (state !== 'done') {
        // Nothing to move while the checks run; r would only queue the same run.
        return k.name === 'char' && k.ch === 'r';
      }
      if (k.name === 'char' && k.ch === 'r') { rerun(); return true; }
      if (k.name === 'enter') { fix(selected()); return true; }
      return listKey(list, k);
    },
    onMouse(m) {
      if (state !== 'done') return false;
      const inList = hit(m, listRect);
      if (!inList) return false;
      const r = listMouse(list, { ...inList, row: inList.row - 1, col: inList.col - 2 });
      if (r === 'activate') fix(selected());
      return true;
    },
    hints(): Hint[] {
      if (state !== 'done') return [];
      if (!results.length) return [{ key: 'r', label: 'recheck' }];
      const ch = selected();
      return [
        { key: '↑↓', label: 'check' },
        ...(ch?.action ? [{ key: g.enter, label: ch.status === 'pass' ? 'open' : 'fix' }] : []),
        { key: 'r', label: 'recheck' },
      ];
    },
    help(): HelpGroup[] {
      // The selected check first: its whole detail, and where Enter goes (the action's whole title).
      const ch = state === 'done' ? selected() : undefined;
      const focused: HelpGroup[] = ch ? [{
        title: plainText(ch.label),
        keys: ch.action ? [{ key: g.enter, label: ch.action.title }] : [],
        text: plainText(ch.detail),
      }] : [];
      return [
        ...focused,
        { title: 'Doctor', keys: [
          { key: '↑↓', label: 'choose a check' },
          { key: g.enter, label: 'go where the selected check is fixed' },
          { key: 'r', label: 'run the checks again' },
        ] },
        { title: 'About', keys: [], text: about(g) },
      ];
    },
    commands(): PageCommand[] {
      return [{ id: 'rerun', title: 'Run checks again', description: 'Run the readiness checks again.', shortcut: 'r', run: rerun }];
    },
    animating: () => state === 'checking',
    // Known only once the checks ran: they are not run just to draw the tab bar.
    badge: () => {
      if (ranAt === undefined) return undefined;
      const n = summarize(results).error;
      return n ? `${g.cross}${n}` : g.check;
    },
  };
  return page;
}
