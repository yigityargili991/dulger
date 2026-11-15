// The Settings tab: every session setting as a form built from the settings table (src/settings.ts),
// applied to the session as it changes. The page shows labels and values only: ✎ marks what differs
// from the saved config, a short tag marks session-only fields, and `?` explains the
// focused field. Saving (s, Ctrl-S; the same dialog Models and Providers open),
// discarding the session's changes and the profiles are keys.
import { CliError } from '../../errors.ts';
import { applyProfile, profileNameError, profileSummaries, readProfiles, saveProfile, type ProfileSummary } from '../../profiles.ts';
import { sessionConfig } from '../../replModels.ts';
import { SESSION_SETTINGS, applySetting, findSetting } from '../../settings.ts';
import type { Session } from '../../repl.ts';
import { c } from '../../tui/theme.ts';
import { plainText, wrapParagraphs } from '../../tui/text.ts';
import {
  compose, createForm, fieldHelp, focusKey, focusedField, formCapturesText, formHeight, formHints, formKey, formMouse, formScroll, formWidth,
  hit, panel, renderForm, setSections, type FieldValue, type FormEvent, type Hint, type Rect,
} from '../../tui/kit/index.ts';
import type { AppContext, HelpGroup, NavParams, Page, PageCommand } from '../types.ts';
import { fieldToValue, readView, restoreSession, sessionDiff, settingSections, startValue, type SettingsView } from './settings.data.ts';
import { saveSettings } from './settings.flows.ts';

/** The rule saveProfile applies, checked while the name is typed (it lives with the profiles). */
export { profileNameError };

const message = (e: unknown): string => plainText(e instanceof Error ? e.message : String(e)) || 'Something went wrong.';

/** A profiles file that cannot be read is a message, never a crash; readProfiles already names the file. */
function profilesError(e: unknown): string {
  return e instanceof CliError ? message(e) : `The profiles file .dulger/profiles.json cannot be used: ${message(e)}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A profile in the picker: its backend, cards at a time and budgets, as a short tag. */
function profileTag(p: ProfileSummary): string {
  return [p.harness, `${p.concurrency} parallel`, p.budgetUsd !== undefined ? `run $${p.budgetUsd}` : '', p.cardBudgetUsd !== undefined ? `card $${p.cardBudgetUsd}` : '']
    .filter(Boolean).join(' · ');
}

/** What `?` says about the page, under the focused field and the keys. */
const ABOUT = [
  `✎ marks a value that differs from the saved one; s lists the changes and where they go, then writes them.`,
  'session: lasts until dulger exits and is never saved; nor are API keys.',
  'env: DULGER_ICONS is set and wins over the setting. ≥ run: the card budget is not below the run budget.',
  'A role can have a backend or model of its own on the Models tab (m).',
];

export function createSettingsPage(ctx: AppContext): Page {
  const g = ctx.g;
  // What Discard goes back to: the session as the app found it (one snapshot, kept by the shell).
  const snapshot = ctx.startSession as Session;
  const errors = new Map<string, string>();
  // A field that cannot change says why when it is tried, and only then.
  const form = createForm([], { onRefuse: (reason) => ctx.toast(plainText(reason), 'info') });
  let view: SettingsView | undefined;
  let loadError: string | undefined;
  let formRect: Rect = { top: 0, left: 0, rows: 0, cols: 0 };
  let unsavedCount = 0;
  let badgeAt = -Infinity;
  /** Rows the form had at the last render, for the scrollbar. */
  let formRows = 0;

  const refresh = () => {
    try {
      view = readView(ctx.repoRoot, ctx.session);
      loadError = undefined;
    } catch (e) {
      view = undefined;
      loadError = message(e);
    }
    setSections(form, view ? settingSections(view, ctx.session, { errors }) : []);
    unsavedCount = view?.unsaved ?? 0;
    badgeAt = ctx.now();
  };
  // Async work (after a dialog) changes the session outside a key press; repaint so the header follows.
  const done = () => { refresh(); ctx.redraw(); };

  const change = (key: string, value: FieldValue) => {
    const s = findSetting(key);
    if (!s) return;
    try {
      applySetting(ctx.session, ctx.config(), s.key, fieldToValue(s, value));
      errors.delete(key);
    } catch (e) {
      // The table refused it: the field shows why and the session keeps its value.
      errors.set(key, message(e));
    }
    refresh();
  };

  async function save(): Promise<void> {
    refresh();
    if (!view) { ctx.toast(loadError ?? 'Settings unreadable', 'error'); return; }
    await saveSettings(ctx, { written: done });
    done();
  }

  async function discard(): Promise<void> {
    let diff: ReturnType<typeof sessionDiff>;
    try { diff = sessionDiff(ctx.repoRoot, ctx.session, snapshot); } catch (e) { ctx.toast(message(e), 'error'); return; }
    if (!diff.differs) { ctx.toast('Nothing to discard', 'info'); return; }
    // The facts: each change as now → as dulger started. Nothing on disk changes (help says so).
    const yes = await ctx.confirm({ title: 'Discard session changes', message: '', items: diff.items, confirm: 'Discard', danger: true });
    if (!yes) return;
    restoreSession(ctx.session, snapshot);
    errors.clear();
    ctx.toast(`Discarded ${plural(diff.items.length, 'change')}`, 'ok');
    done();
  }

  async function loadProfile(): Promise<void> {
    let list: ProfileSummary[];
    try { list = profileSummaries(ctx.repoRoot); } catch (e) { ctx.toast(profilesError(e), 'error'); done(); return; }
    if (!list.length) { ctx.toast('No profiles', 'info'); return; }
    const name = await ctx.pick({
      title: 'Load profile',
      options: list.map((p) => ({ value: p.name, label: p.name, meta: profileTag(p) })),
    });
    if (name === undefined) return;
    const before = structuredClone(ctx.session);
    try {
      const all = readProfiles(ctx.repoRoot);
      if (!Object.hasOwn(all, name)) throw new CliError(`Profile ${name} is no longer in .dulger/profiles.json.`);
      applyProfile(ctx.session, all[name]!);
      // A profile naming a backend this config cannot run would break every page: refuse it whole.
      sessionConfig(ctx.repoRoot, ctx.session);
      errors.clear();
      ctx.toast(`Loaded ${plainText(name)}`, 'ok');
    } catch (e) {
      restoreSession(ctx.session, before);
      ctx.toast(e instanceof SyntaxError ? profilesError(e) : `Not loaded: ${message(e)}`, 'error');
    }
    done();
  }

  async function saveAsProfile(): Promise<void> {
    const typed = await ctx.prompt({ title: 'Save as profile', placeholder: 'name', validate: (v) => profileNameError(v.trim()) });
    if (typed === undefined) return;
    const name = typed.trim();
    let exists: boolean;
    try { exists = Object.hasOwn(readProfiles(ctx.repoRoot), name); } catch (e) { ctx.toast(profilesError(e), 'error'); return; }
    if (exists) {
      const replace = await ctx.confirm({ title: 'Replace profile', message: name, confirm: 'Replace', danger: true });
      if (!replace) return;
    }
    try {
      saveProfile(ctx.repoRoot, name, ctx.config(), exists);
      ctx.toast(`${exists ? 'Replaced' : 'Saved'} profile ${name}`, 'ok');
    } catch (e) {
      ctx.toast(e instanceof SyntaxError ? profilesError(e) : `Not saved: ${message(e)}`, 'error');
    }
    done();
  }

  const actions: Record<string, () => void | Promise<void>> = {
    save, discard, 'load-profile': loadProfile, 'save-profile': saveAsProfile,
    models: () => ctx.navigate('models'),
  };
  const act = (key: string) => {
    const run = actions[key];
    if (!run) return;
    Promise.resolve().then(run).catch((e) => ctx.toast(message(e), 'error'));
  };

  const handle = (r: boolean | FormEvent): boolean => {
    if (typeof r !== 'object') return r;
    if (r.type === 'change') change(r.key, r.value);
    else act(r.key);
    return true;
  };

  const SHORTCUTS: Record<string, string> = { s: 'save', d: 'discard', l: 'load-profile', a: 'save-profile', m: 'models' };

  const page: Page = {
    id: 'settings',
    title: 'Settings',
    activate(params?: NavParams) {
      refresh();
      const key = params?.key;
      if (typeof key === 'string' && findSetting(key)) focusKey(form, key);
    },
    render(size) {
      // One panel, as wide as the form needs and as tall as its rows: values only, ✎n unsaved in the border.
      const n = view?.unsaved ?? 0;
      const tag = n ? c.warn(`${g.modified}${n}`) : '';
      if (loadError || !view) {
        formRect = { top: 0, left: 0, rows: 0, cols: 0 };
        // The reader's own message is the content: it names the file and what is wrong with it.
        const w = Math.max(1, Math.min(size.cols - 4, 76));
        const why = loadError ?? 'unreadable';
        const lines = wrapParagraphs(`${g.warn} ${/config\.json/.test(why) ? why : `.dulger/config.json: ${why}`}`, w).map((l) => c.bad(l));
        const rect = { top: 0, left: 0, rows: Math.min(size.rows, lines.length + 2), cols: Math.min(size.cols, w + 4) };
        return compose(size, [{ rect, block: panel(rect, { g, title: 'Settings', focused: true }, () => lines) }]);
      }
      // A refused value's message is read whole: the panel widens for it instead of cutting it.
      const erring = errors.size > 0 || Boolean(form.invalid);
      const cols = Math.min(size.cols, Math.max(formWidth(form, g) + 4, erring ? 76 : 0));
      const rows = Math.min(size.rows, formHeight(form, Math.max(1, cols - 4), g, { titles: false }) + 2);
      const rect = { top: 0, left: 0, rows, cols };
      const framed = rows >= 3 && cols >= 6;
      const block = panel(rect, { g, title: 'Settings', focused: true, badge: tag, scroll: () => ({ ...formScroll(form), visible: formRows }) }, (inner) => {
        formRows = inner.rows;
        formRect = { top: framed ? 1 : 0, left: framed ? 2 : 0, rows: inner.rows, cols: inner.cols };
        return renderForm(form, inner, g, { focused: true, titles: false });
      });
      return compose(size, [{ rect, block }]);
    },
    onKey(k) {
      if (!view) return false;
      const x = focusedField(form);
      // Turning a limit on starts from its saved value (or a sensible amount), not from the smallest step.
      if (x?.kind === 'number' && x.value === undefined && !form.editing && (k.name === 'right' || (k.name === 'char' && (k.ch === '+' || k.ch === '=')))) {
        const s = findSetting(x.key);
        const start = s ? startValue(s, view) : undefined;
        if (start !== undefined) { change(x.key, start); return true; }
      }
      const r = formKey(form, k);
      if (r !== false) return handle(r);
      if (k.name === 'ctrl' && k.ch === 's') { act('save'); return true; }
      if (k.name === 'char' && !formCapturesText(form) && Object.hasOwn(SHORTCUTS, k.ch)) { act(SHORTCUTS[k.ch]!); return true; }
      return false;
    },
    onMouse(m) {
      const local = hit(m, formRect);
      if (!local && m.kind !== 'wheel-up' && m.kind !== 'wheel-down') return false;
      return handle(formMouse(form, local ?? { ...m, row: -1, col: -1 }));
    },
    hints() {
      const own = formHints(form);
      if (form.editing || form.dropdown || !view) return own;
      return [...own.slice(0, 2), { key: 's', label: 'save' }] satisfies Hint[];
    },
    help(): HelpGroup[] {
      const focused = fieldHelp(form);
      return [
        ...(focused ? [focused] : []),
        { title: 'Fields', keys: [
          { key: '↑↓  tab', label: 'move' },
          { key: '←→', label: 'change, step, flip' },
          { key: 'space', label: 'flip a switch' },
          { key: 'enter', label: 'open a list, type a number' },
          { key: 'del', label: 'turn a limit off' },
          { key: 'esc', label: 'stop typing' },
        ] },
        { title: 'Actions', keys: [
          { key: 's  ^s', label: 'save settings' },
          { key: 'd', label: 'discard session changes' },
          { key: 'l', label: 'load profile' },
          { key: 'a', label: 'save as profile' },
          { key: 'm', label: 'Models tab' },
        ] },
        { title: 'About', keys: [], text: ABOUT },
      ];
    },
    commands(): PageCommand[] {
      return [
        { id: 'save', title: 'Save settings…', shortcut: 's', run: save },
        { id: 'discard', title: 'Discard session changes', shortcut: 'd', run: discard },
        { id: 'load-profile', title: 'Load profile…', shortcut: 'l', run: loadProfile },
        { id: 'save-profile', title: 'Save as profile…', shortcut: 'a', run: saveAsProfile },
        { id: 'models', title: 'Models per role', shortcut: 'm', run: () => ctx.navigate('models') },
      ];
    },
    capturesText: () => formCapturesText(form),
    // Other tabs change the session too, so the count is read again, at most once a second.
    badge: () => {
      if (ctx.now() - badgeAt >= 1000) {
        badgeAt = ctx.now();
        try { unsavedCount = readView(ctx.repoRoot, ctx.session).unsaved; } catch { unsavedCount = 0; }
      }
      // The changed glyph says what the number counts: unsaved changes.
      return unsavedCount ? `${g.modified}${unsavedCount}` : undefined;
    },
  };
  refresh();
  return page;
}
