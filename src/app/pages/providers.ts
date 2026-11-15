// The Providers tab: the configured API providers as a table (name, base URL, default model, where
// the key comes from; never the key), the well-known ones not set up yet as `+ name` rows to add, and
// the selected one's facts with its actions as buttons. Labels and values only: `?` says what the
// selected provider or the focused button is. The add/edit form is providers.form.ts. Definitions are
// session-only until saved (Ctrl-S here or in Settings), which writes the endpoint and the variable's
// name, never the key.
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_CONFIG, roleConfig, userSettings, type Config } from '../../config.ts';
import { MODEL_ROLES, applyModelSet, describeRoleModel, setRoleModel } from '../../replModels.ts';
import {
  KNOWN_PROVIDERS, KNOWN_PROVIDER_URLS, defaultKeyEnv, defineProvider, providerNameError, providerSummaries, storeProviderKey,
  type ProviderSummary,
} from '../../replProviders.ts';
import { keySource, keysFile } from '../../keys.ts';
import { sessionChanges } from '../../settings.ts';
import { c } from '../../tui/theme.ts';
import { plainText, width, wrapParagraphs } from '../../tui/text.ts';
import {
  compose, createForm, createTable, fieldHelp, fieldOf, focusKey, focusedField, formHeight, formHints, formKey, formMouse, formScroll,
  hit, panel, renderForm, renderTable, setRows, setSections, tableKey, tableMouse, tableScroll,
  type FormEvent, type FormSection, type FormState, type HelpGroup, type Hint, type Rect, type TableColumn, type TableRow,
} from '../../tui/kit/index.ts';
import type { AgentRole } from '../../types.ts';
import type { AppContext, NavParams, Page, PageCommand } from '../types.ts';
import { ROLE_NAMES, ROLE_NOUNS } from '../look.ts';
import { chooseModel, defaultLister, friendly, homePath, keyState, redactUrl, type ModelLister } from './models.shared.ts';
import { createProviderFormPage, enterKey } from './providers.form.ts';
import { saveSettings } from './settings.flows.ts';

export interface ProvidersPageOptions {
  /** Lists an endpoint's models (default: ask it over the network). */
  listModels?: ModelLister;
}

type Origin = 'session' | 'yours' | 'repository' | 'built in';

type Row =
  | { id: string; kind: 'configured'; name: string; p: ProviderSummary; usedBy: AgentRole[]; origin: Origin }
  | { id: string; kind: 'known'; name: string; baseUrl: string; keyEnv?: string }
  | { id: string; kind: 'custom' };

/** Cells between columns, as the table draws them. */
const GAP = 2;

/** What `?` says about the page, under the selected item and the keys. */
const ABOUT = [
  'Keys are never shown: typed masked, kept in your keys file (mode 600), never in the repository. The environment wins over the keys file.',
  'Changes last for this session; ^s lists what it writes and where, then saves.',
  'A model list that fails: the base URL ends before /chat/completions (usually /v1); s replaces a refused key.',
];

/** The table's columns, without a header: provider, endpoint, default model, and the key as a glyph. */
function columns(g: AppContext['g']): TableColumn[] {
  return [
    { title: '', min: 8 },
    { title: '', flex: 1, min: 12 },
    { title: '', min: 5 },
    { title: '', width: Math.max(width(g.check), width(g.warn)) },
  ];
}

/** Where the key comes from, as a sentence for help (the table shows a glyph, the facts a word). */
function keyHelp(env: string | undefined): string {
  if (!env) return 'Called without a key.';
  switch (keySource(env)) {
    case 'environment': return `Key: from your environment (${env}).`;
    case 'keys file': return `Key: ${env}, stored in your keys file.`;
    case 'unreadable': return 'Key: your keys file cannot be read (invalid JSON).';
    default: return `Key: ${env} is not set; s sets it.`;
  }
}

const ORIGIN_HELP: Record<Origin, string> = {
  session: 'Defined this session, not saved yet: ^s saves it to your config file.',
  yours: 'Defined by your own config file, for every repository.',
  repository: "Defined by the repository's settings.",
  'built in': 'Built in.',
};

export function createProvidersPage(ctx: AppContext, o: ProvidersPageOptions = {}): Page {
  const g = ctx.g;
  const lister = o.listModels ?? defaultLister;
  const cache = new Map<string, string[]>();
  const COLUMNS = columns(g);
  const table = createTable(COLUMNS, [], { empty: 'No providers' });
  let rows: Row[] = [];
  let config: Config | undefined;
  let error: string | undefined;
  let focus: 'list' | 'detail' = 'list';
  let detail: { id: string; form: FormState } | undefined;
  let want: string | undefined;
  let rects: { list?: Rect; detail?: Rect } = {};
  let badgeAt = -Infinity;
  let badgeText: string | undefined;

  // ---- data ----

  function load(): void {
    try {
      const cfg = ctx.config();
      let changed: string[] = [];
      try { changed = sessionChanges(ctx.repoRoot, ctx.session).providers; } catch { /* shown as unchanged */ }
      const mine = userSettings().providers ?? {};
      const configured: Row[] = providerSummaries(cfg).map((p) => ({
        id: `p:${p.name}`, kind: 'configured', name: p.name, p,
        usedBy: MODEL_ROLES.filter((r) => roleConfig(cfg, r).harness === p.name),
        origin: changed.includes(p.name) ? 'session' : mine[p.name] ? 'yours' : isDeepStrictEqual(cfg.providers[p.name], DEFAULT_CONFIG.providers[p.name]) ? 'built in' : 'repository',
      }));
      const known: Row[] = KNOWN_PROVIDERS.filter((n) => !cfg.providers[n]).map((n) => ({ id: `add:${n}`, kind: 'known', name: n, baseUrl: KNOWN_PROVIDER_URLS[n]!, keyEnv: defaultKeyEnv(n) }));
      rows = [...configured, ...known, { id: 'add:', kind: 'custom' }];
      config = cfg;
      error = undefined;
    } catch (e) {
      rows = [];
      config = undefined;
      error = friendly(e);
    }
    setRows(table, rows.map(toTableRow));
    if (want) { const i = rows.findIndex((r) => r.id === want); if (i >= 0) table.index = i; want = undefined; }
    syncDetail(true);
  }

  function toTableRow(r: Row): TableRow {
    // Not set up yet: `+` and the name; the selected one's URL and key variable are in its facts.
    if (r.kind === 'custom') return { id: r.id, cells: ['+ another…', '', '', ''], tones: ['accent'] };
    if (r.kind === 'known') return { id: r.id, cells: [`+ ${r.name}`, '', '', ''], tones: ['accent'] };
    // The key as a glyph: there (environment or keys file), missing or unreadable, or nothing when none is needed.
    const k = keyState(r.p.apiKeyEnv);
    const key = !r.p.apiKeyEnv ? undefined : k.missing ? c.bad(g.warn) : c.ok(g.check);
    return {
      id: r.id,
      cells: [r.origin === 'session' ? `${r.name} ${g.modified}` : r.name, redactUrl(r.p.baseUrl), r.p.model ?? '—', ''],
      tones: [r.origin === 'session' ? 'warn' : 'text', 'subtle', r.p.model ? 'text' : 'warn'],
      icons: [undefined, undefined, undefined, key],
    };
  }

  const selected = (): Row | undefined => rows[table.index];
  const configuredName = (): string | undefined => { const r = selected(); return r?.kind === 'configured' ? r.name : undefined; };

  /** The selected row's facts as label/value rows, then its actions as buttons (what each does is in help). */
  function detailSections(r: Row): FormSection[] {
    if (r.kind === 'custom') {
      return [{ fields: [
        { kind: 'action', key: 'add', label: 'Add…', description: 'A form for any OpenAI-compatible endpoint (a hosted service, a gateway, or a local server such as vLLM): its name, base URL, key variable, key and default model.' },
      ] }];
    }
    if (r.kind === 'known') {
      const k = keyState(r.keyEnv);
      return [
        { fields: [
          { kind: 'info', key: 'info-url', label: 'Base URL', value: r.baseUrl, wrap: true },
          { kind: 'info', key: 'info-env', label: 'Key variable', value: r.keyEnv ?? '—', tone: r.keyEnv ? 'text' : 'muted' },
          { kind: 'info', key: 'info-key', label: 'Key', value: r.keyEnv ? k.short : '—', tone: k.tone },
        ] },
        { fields: [
          { kind: 'action', key: 'add', label: 'Add…', description: `Opens the form with ${r.name}'s URL and key variable filled in.` },
        ] },
      ];
    }
    const { p, name } = r;
    const k = keyState(p.apiKeyEnv);
    const used = r.usedBy.map((x) => ROLE_NOUNS[x]).join(', ');
    return [
      { fields: [
        { kind: 'info', key: 'info-url', label: 'Base URL', value: redactUrl(p.baseUrl), wrap: true },
        { kind: 'info', key: 'info-model', label: 'Default model', value: p.model ?? '—', tone: p.model ? 'text' : 'warn', wrap: true },
        { kind: 'info', key: 'info-env', label: 'Key variable', value: p.apiKeyEnv ?? '—', tone: p.apiKeyEnv ? 'text' : 'muted', wrap: true },
        // Without a key variable there is no key to have: the dash says it.
        { kind: 'info', key: 'info-key', label: 'Key', value: p.apiKeyEnv ? k.short : '—', tone: k.tone },
        { kind: 'info', key: 'info-used', label: 'Used by', value: used || '—', tone: used ? 'text' : 'muted', wrap: true },
        { kind: 'info', key: 'info-origin', label: 'Defined by', value: r.origin, tone: r.origin === 'session' ? 'warn' : 'muted' },
      ] },
      { fields: [
        { kind: 'action', key: 'edit', label: 'Edit…', description: 'Change its base URL, key variable or default model.' },
        ...(p.apiKeyEnv ? [{ kind: 'action' as const, key: 'key', label: k.missing ? 'Set key…' : 'Replace key…',
          description: `Typed masked and stored as ${p.apiKeyEnv} in ${homePath(keysFile())} (mode 600): never in the repository, never shown again.` }] : []),
        { kind: 'action', key: 'model', label: 'Model…', description: 'Pick its default model from what the endpoint lists, or enter an ID.' },
        { kind: 'action', key: 'all', label: 'All roles…', description: `Every role runs on ${name} with automatic tiers; their own choices and the global pin are reset.` },
        { kind: 'action', key: 'one', label: 'One role…', description: `Run one role on ${name}, then refine its model on Models.` },
        ...(r.origin === 'session' ? [{ kind: 'action' as const, key: 'save', label: 'Save…',
          description: 'Lists what is written, then saves it with the other session changes: the endpoint and the key variable\'s name go to your config file, never the key.' }] : []),
      ] },
    ];
  }

  /** What the selected row is, for help when the list has the focus. */
  function rowHelp(r: Row | undefined): HelpGroup | undefined {
    if (!r) return undefined;
    if (r.kind === 'custom') return { title: 'Another provider', keys: [], text: 'Any OpenAI-compatible endpoint: a hosted service, a gateway, or a local server such as vLLM. Enter opens the form.' };
    if (r.kind === 'known') return { title: r.name, keys: [], text: `A well-known OpenAI-compatible endpoint, not set up yet. Enter opens the form with its URL and key variable filled in.` };
    const text = [
      `Roles that run on ${r.name} call this endpoint directly.`,
      r.p.model ? '' : 'No default model: a role on it needs one before a run.',
      keyHelp(r.p.apiKeyEnv),
      ORIGIN_HELP[r.origin],
    ].filter(Boolean).join(' ');
    return { title: r.name, keys: [], text };
  }

  /** Keep the detail form on the selected row; rebuilt in place when its data changed. */
  function syncDetail(reload = false): void {
    const r = selected();
    if (!r) { detail = undefined; return; }
    if (!detail || detail.id !== r.id) detail = { id: r.id, form: createForm(detailSections(r)) };
    else if (reload) setSections(detail.form, detailSections(r));
  }

  /** The width the table wants: each column's widest cell (with its glyph), the gaps and the pointer. */
  function tableWidth(): number {
    const cells = rows.map(toTableRow);
    const cellW = (r: TableRow, i: number) => width(plainText(r.cells[i] ?? '')) + (r.icons?.[i] ? width(r.icons[i]!) + (r.cells[i] ? 1 : 0) : 0);
    const cols = COLUMNS.map((col, i) => col.width ?? Math.max(width(col.title), ...cells.map((r) => cellW(r, i))));
    return width(g.pointer) + 1 + cols.reduce((a, b) => a + b, 0) + GAP * (COLUMNS.length - 1);
  }

  // ---- actions ----

  async function perform(fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); } catch (e) { ctx.toast(friendly(e), 'error'); } finally { load(); ctx.redraw(); }
  }
  const act = (fn: () => void | Promise<void>) => { void perform(fn); };

  function openForm(name?: string): void {
    ctx.push(createProviderFormPage(ctx, { name, lister, cache, saved: (n) => { want = `p:${n}`; } }));
  }

  function open(r: Row | undefined): void {
    if (!r) return;
    openForm(r.kind === 'custom' ? undefined : r.name);
  }

  async function keyFor(name: string): Promise<void> {
    const p = ctx.config().providers[name];
    if (!p) return;
    if (!p.apiKeyEnv) { ctx.toast(`${name}: no key variable`, 'info'); return; }
    await enterKey(ctx, name, p.apiKeyEnv, (key) => storeProviderKey(ctx.config(), name, key));
  }

  async function modelFor(name: string): Promise<void> {
    const p = ctx.config().providers[name];
    if (!p) return;
    const choice = await chooseModel(ctx, { title: `Default model for ${name}`, harness: name, current: p.model, lister, cache });
    if (!choice || choice.auto) return;
    defineProvider(ctx.session, ctx.config(), name, { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, model: choice.model });
    ctx.toast(`${name} → ${choice.model}`, 'ok');
  }

  async function useForAll(name: string): Promise<void> {
    const cfg = ctx.config();
    const p = cfg.providers[name];
    if (!p) return;
    const tiers = cfg.routing.models[name];
    // The facts: the backend, the model it brings, routing, and what is reset (the person's own choices).
    const yes = await ctx.confirm({
      title: `Use ${name} for all roles`,
      message: '',
      items: [
        { label: 'Backend', value: name },
        { label: 'Model', value: tiers ? 'tiers' : p.model ?? '—' },
        { label: 'Routing', value: 'on' },
        { label: 'Resets', value: 'role choices, global pin' },
      ],
      confirm: `Use ${name}`,
    });
    if (!yes) return;
    applyModelSet(ctx.session, ctx.config(), name, 'auto');
    ctx.toast(`All roles → ${name}`, 'ok');
    if (!p.model && !tiers) await modelFor(name);
    if (keyState(p.apiKeyEnv).missing) ctx.toast(`No key for ${name}`, 'warn');
  }

  async function useForOne(name: string): Promise<void> {
    const cfg = ctx.config();
    if (!cfg.providers[name]) return;
    const role = await ctx.pick({
      title: `Run one role on ${name}`,
      options: MODEL_ROLES.map((r) => {
        const rc = roleConfig(cfg, r);
        return { value: r, label: ROLE_NAMES[r], meta: `${rc.harness}${rc.model ? ` · ${rc.model}` : ''}` };
      }),
    });
    if (!role) return;
    setRoleModel(ctx.session, ctx.config(), role as AgentRole, name);
    ctx.toast(`${ROLE_NAMES[role as AgentRole]} → ${name}`, 'ok');
    ctx.navigate('models', { role });
  }

  /** The action named `key` on the selected row; false when it does not apply there. */
  function run(key: string): boolean {
    const r = selected();
    const name = configuredName();
    switch (key) {
      case 'add': if (r?.kind === 'known') openForm(r.name); else openForm(); return true;
      case 'edit': if (!name) return false; openForm(name); return true;
      case 'key': if (!name) return false; act(() => keyFor(name)); return true;
      case 'model': if (!name) return false; act(() => modelFor(name)); return true;
      case 'all': if (!name) return false; act(() => useForAll(name)); return true;
      case 'one': if (!name) return false; act(() => useForOne(name)); return true;
      case 'save': act(save); return true;
      default: return false;
    }
  }

  async function save(): Promise<void> { await saveSettings(ctx); }

  function onFormEvent(r: FormEvent): void {
    if (r.type === 'action') run(r.key);
  }

  // Not j, k, g or G: the list moves with those.
  const SHORTCUTS: Record<string, string> = { e: 'edit', s: 'key', m: 'model', u: 'all', o: 'one', a: 'add' };

  // ---- the page ----

  return {
    id: 'providers',
    title: 'Providers',

    activate(params?: NavParams) {
      cache.clear();
      const name = typeof params?.provider === 'string' && !providerNameError(params.provider) ? params.provider : undefined;
      if (name) {
        try { want = ctx.config().providers[name] ? `p:${name}` : `add:${KNOWN_PROVIDERS.includes(name) ? name : ''}`; } catch { want = undefined; }
      }
      load();
      if (name) focus = 'list';
      // Sent here to set a missing key (Models' fix): land on Set key… in its actions.
      if (name && params?.action === 'key' && detail && fieldOf(detail.form, 'key')) { focus = 'detail'; focusKey(detail.form, 'key'); }
      if (params?.add === true && !error) openForm(name);
    },

    badge() {
      // Providers some enabled role runs on that cannot be called yet; recounted at most once a second.
      const t = ctx.now();
      if (t - badgeAt > 1000) {
        badgeAt = t;
        try {
          const cfg = ctx.config();
          const used = new Set(MODEL_ROLES.filter((r) => !describeRoleModel(cfg, ctx.session, r).disabled).map((r) => roleConfig(cfg, r).harness));
          const n = [...used].filter((h) => keyState(cfg.providers[h]?.apiKeyEnv).missing).length;
          badgeText = n ? `${g.warn}${n}` : undefined;
        } catch { badgeText = undefined; }
      }
      return badgeText;
    },

    render(size) {
      if (!config) {
        // The reader's own message is the content: it names what is wrong with the file.
        rects = {};
        const w = Math.max(1, Math.min(size.cols - 4, 76));
        const why = error ?? 'unreadable';
        const lines = wrapParagraphs(`${g.warn} ${/config\.json/.test(why) ? why : `.dulger/config.json: ${why}`}`, w).map((l) => c.bad(l));
        const rect = { top: 0, left: 0, rows: Math.min(size.rows, lines.length + 2), cols: Math.min(size.cols, w + 4) };
        return compose(size, [{ rect, block: panel(rect, { g, title: 'Providers', focused: true }, () => lines) }]);
      }
      // Two boxes as wide as the table needs (the facts wrap a long value under itself, so moving the
      // selection never changes the width), each as tall as its rows; the list keeps its rows first
      // when the screen is short, and the facts scroll.
      const form = detail?.form;
      const cols = Math.min(size.cols, tableWidth() + 4);
      const listNeed = rows.length + 2;
      const factsNeed = form ? formHeight(form, Math.max(1, cols - 4), g, { titles: false }) + 2 : 0;
      const listRows = size.rows < 12 ? size.rows : Math.min(listNeed, Math.max(6, size.rows - Math.min(factsNeed, 9)));
      const factsRows = Math.min(factsNeed, size.rows - listRows);
      const listRect: Rect = { top: 0, left: 0, rows: listRows, cols };
      const detailRect: Rect | undefined = factsRows >= 3 ? { top: listRows, left: 0, rows: factsRows, cols } : undefined;
      rects = { list: listRect, detail: detailRect };
      if (!rects.detail && focus === 'detail') focus = 'list';
      const unsaved = rows.filter((r) => r.kind === 'configured' && r.origin === 'session').length;
      const parts = [{
        rect: listRect,
        block: panel(listRect, {
          g, title: 'Providers', focused: focus === 'list', scroll: () => tableScroll(table),
          badge: unsaved ? c.warn(`${g.modified}${unsaved}`) : undefined,
        }, (inner) => renderTable(table, inner, g, { focused: focus === 'list', header: false })),
      }];
      const r = selected();
      if (detailRect && r && detail) {
        const title = r.kind === 'custom' ? 'New provider' : r.name;
        const d = detail;
        parts.push({ rect: detailRect, block: panel(detailRect, { g, title, focused: focus === 'detail', scroll: () => formScroll(d.form) },
          (inner) => renderForm(d.form, inner, g, { focused: focus === 'detail', follow: focus === 'detail', titles: false })) });
      }
      return compose(size, parts);
    },

    onKey(k) {
      if (!config) {
        if (k.name === 'char' && k.ch === 'r') { load(); return true; }
        return false;
      }
      if ((k.name === 'tab' || k.name === 'shift-tab') && rects.detail && detail && focusedField(detail.form)) { focus = focus === 'list' ? 'detail' : 'list'; return true; }
      if (k.name === 'ctrl' && k.ch === 's') { act(save); return true; }
      if (focus === 'detail' && detail) {
        const r = formKey(detail.form, k);
        if (typeof r === 'object') { onFormEvent(r); return true; }
        if (r) return true;
        if (k.name === 'escape') { focus = 'list'; return true; }
      } else {
        if (tableKey(table, k)) { syncDetail(); return true; }
        if (k.name === 'enter') { open(selected()); return true; }
      }
      if (k.name === 'char' && SHORTCUTS[k.ch]) {
        const action = SHORTCUTS[k.ch]!;
        if (k.ch === 'a') { openForm(); return true; }
        if (!run(action)) ctx.toast('Not set up', 'info');
        return true;
      }
      return false;
    },

    onMouse(m) {
      if (!config) return false;
      const inList = rects.list && hit(m, rects.list);
      if (inList) {
        focus = 'list';
        const r = tableMouse(table, { ...inList, row: inList.row - 1, col: inList.col - 2 });
        syncDetail();
        if (r === 'activate') open(selected());
        return true;
      }
      const inDetail = rects.detail && hit(m, rects.detail);
      if (inDetail && detail) {
        if (focusedField(detail.form)) focus = 'detail';
        const r = formMouse(detail.form, { ...inDetail, row: inDetail.row - 1, col: inDetail.col - 2 });
        if (typeof r === 'object') onFormEvent(r);
        return true;
      }
      return false;
    },

    hints(): Hint[] {
      if (!config) return [{ key: 'r', label: 'retry' }];
      if (focus === 'detail' && detail) return [...formHints(detail.form).slice(0, 2), { key: 'tab', label: 'list' }];
      const r = selected();
      if (r?.kind !== 'configured') return [{ key: '↑↓', label: 'provider' }, { key: 'enter', label: 'add' }];
      const out: Hint[] = [{ key: '↑↓', label: 'provider' }, { key: 'enter', label: 'edit' }];
      if (r.p.apiKeyEnv) out.push({ key: 's', label: 'key' });
      out.push({ key: 'm', label: 'model' });
      if (out.length < 4 && rows.some((x) => x.kind === 'configured' && x.origin === 'session')) out.push({ key: '^s', label: 'save' });
      return out;
    },

    commands(): PageCommand[] {
      if (!config) return [{ id: 'reload', title: 'Reload providers', shortcut: 'r', run: () => load() }];
      const out: PageCommand[] = [];
      const name = configuredName();
      if (name) {
        const k = keyState(config.providers[name]?.apiKeyEnv);
        out.push(
          { id: 'edit', title: `Edit ${name}…`, shortcut: 'e', run: () => { openForm(name); } },
          ...(config.providers[name]?.apiKeyEnv ? [{ id: 'key', title: `${k.missing ? 'Set' : 'Replace'} the key for ${name}…`, shortcut: 's', run: () => perform(() => keyFor(name)) }] : []),
          { id: 'model', title: `Choose ${name}'s default model…`, shortcut: 'm', run: () => perform(() => modelFor(name)) },
          { id: 'all', title: `Use ${name} for all roles…`, shortcut: 'u', run: () => perform(() => useForAll(name)) },
          { id: 'one', title: `Use ${name} for one role…`, shortcut: 'o', run: () => perform(() => useForOne(name)) },
        );
      }
      // The selected provider's actions and the page's own; no entry per row (the list is for choosing).
      out.push({ id: 'add', title: 'Add a provider…', shortcut: 'a', run: () => { openForm(); } });
      out.push({ id: 'save', title: 'Save the providers…', shortcut: '^s', run: save });
      return out;
    },

    help(): HelpGroup[] {
      if (!config) return [{ title: 'Providers', keys: [{ key: 'r', label: 'read the settings again' }] }, { title: 'About', keys: [], text: ABOUT }];
      // The focused button when the facts have the focus, else the selected row.
      const focused = focus === 'detail' && detail ? fieldHelp(detail.form) : rowHelp(selected());
      return [
        ...(focused ? [focused] : []),
        { title: 'Providers', keys: [
          { key: '↑↓', label: 'choose a provider' },
          { key: 'enter  e', label: 'edit it, or add the highlighted one' },
          { key: 'a', label: 'add another provider' },
          { key: 'tab', label: 'list / actions' },
        ] },
        { title: 'On a provider', keys: [
          { key: 's', label: 'set or replace its key' },
          { key: 'm', label: 'choose its default model' },
          { key: 'u', label: 'use it for all roles' },
          { key: 'o', label: 'use it for one role' },
        ] },
        { title: 'Saving', keys: [{ key: '^s', label: 'save, not the keys' }] },
        { title: 'About', keys: [], text: [`Key: ${g.check} set, ${g.warn} missing or unreadable, blank when the endpoint takes none.`, ...ABOUT] },
      ];
    },
  };
}
