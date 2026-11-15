// The Models tab: the five roles with the backend and model each would run on now and its state; the
// selected role's facts (how its model is chosen, where the choice comes from); editing a role,
// whole-team presets and the global pin. The page shows values only; `?` explains the focused role or
// action and how a model is chosen. Every change lives in the session until it is saved (^s).
import { harnessNames, modelTier, roleConfig, type Config } from '../../config.ts';
import { capabilities } from '../../adapters/capabilities.ts';
import { getAdapter } from '../../adapters/index.ts';
import {
  MODEL_ROLES, MODEL_SETS, applyModelSet, describeRoleModel, resetRoleModel, setGlobalModel, setRoleAuto, setRoleModel,
  setupIssues, type ModelSetName, type RoleModelSummary,
} from '../../replModels.ts';
import { rolesAffected, sessionChanges } from '../../settings.ts';
import { c } from '../../tui/theme.ts';
import { cell, fit, plainText, width, wrapParagraphs } from '../../tui/text.ts';
import {
  compose, createList, createTable, frame, hit, listKey, listMouse, panel, renderList, renderScroll, renderTable,
  scrollInfo, scrollKey, scrollLines, scrollMouse, selectedItem, setItems, setRows, setScrollLines, splitCols, tableKey, tableMouse, tableWidth,
  type HelpGroup, type Hint, type ListItem, type PickOption, type Rect, type TableColumn, type TableRow, type Tone,
} from '../../tui/kit/index.ts';
import type { AgentRole, ModelTier } from '../../types.ts';
import { ROLE_JOBS, ROLE_NAMES, ROLE_NOUNS, TERMS, roleFromWord, roleGlyph } from '../look.ts';
import type { AppContext, Page, PageCommand } from '../types.ts';
import { backendDetail, chooseModel, defaultLister, friendly, keyState, type ModelLister } from './models.shared.ts';
import { saveSettings } from './settings.flows.ts';

export interface ModelsPageOptions {
  /** Lists an endpoint's models (default: ask it over the network). */
  listModels?: ModelLister;
}

/** Something wrong with a role: a short state line on the page, the whole sentence in help, and its fix. */
interface Problem { short: string; text: string; tone: 'bad' | 'warn' | 'muted'; fix?: { label: string; run(): void | Promise<void> } }
interface RoleRow { role: AgentRole; s: RoleModelSummary; skipped: boolean; problems: Problem[]; state: { text: string; tone: Tone }; changed: boolean }
interface Data { config: Config; rows: RoleRow[]; issues: string[]; pin?: string; changed: boolean }

type TeamAction = 'set' | 'one' | 'pin' | 'backend' | 'routing';

// No header: glyph and role, backend, then the model only when it is pinned, then a state only when
// something is wrong.
const COLUMNS: TableColumn[] = [
  { title: '', min: 6 },
  { title: '', min: 6 },
  { title: '' },
  { title: '' },
];

const TIERS: readonly ModelTier[] = ['low', 'medium', 'high'];
/** The label column of the role's facts. */
const LABEL = 9;

function modelText(s: RoleModelSummary): string {
  if (s.model === '(model required)') return 'none';
  if (s.model === '(harness default)') return TERMS.defaultModel;
  return s.model;
}

function fromText(s: RoleModelSummary, changed: boolean): string {
  switch (s.source) {
    case 'session role': return 'this session';
    case 'global pin': return 'global pin';
    case 'repository reset': return 'repository';
    default: return changed ? 'this session' : 'repository';
  }
}

/** How the role's model is chosen, in a sentence or two: for help. */
function chosenHelp(config: Config, s: RoleModelSummary): string {
  const p = config.providers[s.harness];
  if (s.mode === 'pinned') return s.role === 'worker' ? 'Pinned: task difficulty and retry escalation do not change it.' : 'Pinned: the tier this role would get is ignored.';
  if (s.mode === 'auto tiers') {
    if (s.role === 'worker') return 'Automatic: each task\'s difficulty picks the tier, and a failed attempt or a fix task runs one tier up. A pin would override both.';
    return modelTier(s.role) === 'high'
      ? 'Automatic: planning and review always use the high tier. A pin would replace the tier model.'
      : 'Automatic: docs and progress notes always use the low tier. A pin would replace the tier model.';
  }
  if (s.model === '(model required)') return `${s.harness} has no default model, and a run cannot start without one.`;
  if (s.harness === 'fake') return '';
  if (!p) return `The ${s.harness} CLI's own default model. ${config.routing.enabled ? `${s.harness} has no tier map here.` : 'Routing is off.'} A pin would choose this role's model.`;
  return `${s.harness}'s default model. ${config.routing.enabled ? `${s.harness} has no tier map, so its default is used.` : 'Routing is off.'} A pin would choose this role's model.`;
}

/** "Automatic" in the model picker, with a short tag: the model (or tiers) it means on this backend. */
function autoOption(config: Config, role: AgentRole, harness: string): { label: string; detail: string } {
  const p = config.providers[harness];
  const fallback = p ? (p.model ?? 'none') : TERMS.defaultModel;
  const tiers = config.routing.models[harness];
  if (!config.routing.enabled) return { label: 'Backend default', detail: `${p ? (p.model ?? 'none') : fallback} · ${TERMS.routingOff}` };
  if (!tiers) return { label: 'Automatic', detail: p ? (p.model ?? 'none') : fallback };
  if (role === 'worker') return { label: 'Automatic tiers', detail: `by task: ${TIERS.map((t) => tiers[t] ?? fallback).join(' / ')}` };
  const t = modelTier(role);
  return { label: 'Automatic tiers', detail: `${t} tier: ${tiers[t] ?? fallback}` };
}

function reporterSkipped(config: Config, harness: string): boolean {
  try { return !capabilities(getAdapter(harness, config)).toolFree; } catch { return false; }
}

/** What a Whole team action does, for help. */
function teamHelp(id: string | undefined, h: string): string {
  switch (id as TeamAction | undefined) {
    case 'set': return `A preset for every role on ${h}: automatic tiers, balanced, or one tier for all. It replaces each role's own choice and the global pin.`;
    case 'one': return `Pins all five roles to one model on ${h}, replacing their own choices.`;
    case 'pin': return 'A model for every role without a choice of its own, whatever its backend. Choices made per role win over it.';
    case 'backend': return 'Runs every role on one backend with automatic tiers, resetting each role\'s own choice and the global pin.';
    case 'routing': return 'Whether automatic choices follow each task\'s difficulty. It is switched in Settings.';
    default: return '';
  }
}

const TEAM_LABELS: Record<TeamAction, string> = {
  set: 'Model set…', one: 'One model…', pin: 'Global pin…', backend: 'Backend…', routing: TERMS.routing,
};

export function createModelsPage(ctx: AppContext, o: ModelsPageOptions = {}): Page {
  const g = ctx.g;
  const lister = o.listModels ?? defaultLister;
  const cache = new Map<string, string[]>();
  const table = createTable(COLUMNS, []);
  const team = createList([]);
  let focus: 'roles' | 'team' = 'roles';
  let data: Data | undefined;
  let error: string | undefined;
  let teamShown = false;
  let rects: { roles?: Rect; team?: Rect; detail?: Rect } = {};
  // The role's facts scroll when they are taller than their pane; they start at the top for each role.
  const detailView = scrollLines([]);
  let detailFor: AgentRole | undefined;
  let badgeAt = -Infinity;
  let badgeText: string | undefined;

  // ---- data ----

  function rowFor(config: Config, role: AgentRole, changed: boolean): RoleRow {
    const s = describeRoleModel(config, ctx.session, role);
    const needsModel = s.model === '(model required)';
    const skipped = role === 'reporter' && !s.disabled && reporterSkipped(config, s.harness);
    const problems: Problem[] = [];
    if (s.disabled) {
      problems.push(role === 'docs'
        ? { short: 'Docs agent off', text: 'The documentation agent is off, so this role does not run.', tone: 'muted', fix: { label: 'Turn it on in Settings', run: () => ctx.navigate('settings', { key: 'docs' }) } }
        : { short: 'Progress notes off', text: 'Progress notes are off, so the reporter does not run.', tone: 'muted', fix: { label: 'Turn them on in Settings', run: () => ctx.navigate('settings', { key: 'progress' }) } });
    } else {
      if (needsModel) problems.push({ short: `no model on ${s.harness}`, text: `${s.harness} has no model for the ${ROLE_NOUNS[role]}, and a run cannot start without one.`, tone: 'bad', fix: { label: 'Choose a model', run: () => editRole(role, true) } });
      if (s.missingKeyEnv) problems.push({ short: `no key: ${s.missingKeyEnv}`, text: `${s.harness} has no key: ${s.missingKeyEnv} is not set.`, tone: 'bad', fix: { label: `Set ${s.harness}'s key on Providers`, run: () => ctx.navigate('providers', { provider: s.harness, action: 'key' }) } });
      if (skipped) problems.push({ short: 'no tool-free mode', text: `${s.harness} cannot run without its tools, so progress notes are skipped.`, tone: 'warn', fix: { label: 'Choose another backend', run: () => editRole(role) } });
    }
    const state: RoleRow['state'] = s.disabled ? { text: 'off', tone: 'muted' }
      : needsModel ? { text: `${g.warn} model`, tone: 'bad' }
      : s.missingKeyEnv ? { text: `${g.warn} key`, tone: 'bad' }
      : skipped ? { text: 'skipped', tone: 'warn' }
      : { text: '', tone: 'ok' };
    return { role, s, skipped, problems, state, changed };
  }

  function load(): void {
    try {
      const config = ctx.config();
      let changedRoles: AgentRole[] = [];
      try { changedRoles = rolesAffected(sessionChanges(ctx.repoRoot, ctx.session), config); } catch { /* a broken file shows below */ }
      const rows = MODEL_ROLES.map((r) => rowFor(config, r, changedRoles.includes(r)));
      data = { config, rows, issues: setupIssues(config), pin: ctx.session.model, changed: changedRoles.length > 0 || Boolean(ctx.session.model) };
      error = undefined;
    } catch (e) {
      data = undefined;
      error = friendly(e);
    }
    setRows(table, (data?.rows ?? []).map(toTableRow));
    setItems(team, teamItems());
  }

  function toTableRow(r: RoleRow): TableRow {
    const { s } = r;
    const off = s.disabled;
    // The model only when it is pinned (the default needs no saying); ✎ when this session changed the
    // role's choice, and Save would write it.
    const model = [s.mode === 'pinned' ? modelText(s) : '', r.changed ? g.modified : ''].filter(Boolean).join(' ');
    return {
      id: r.role,
      cells: [ROLE_NAMES[r.role], s.harness, model, r.state.text],
      icons: [roleGlyph(g, r.role)],
      tones: [off ? 'muted' : 'text', off ? 'muted' : 'subtle', off ? 'muted' : s.model === '(model required)' ? 'bad' : r.changed ? 'warn' : 'text', r.state.tone],
    };
  }

  function teamItems(): ListItem[] {
    const config = data?.config;
    if (!config) return [];
    return [
      { id: 'set', label: TEAM_LABELS.set },
      { id: 'one', label: TEAM_LABELS.one },
      { id: 'pin', label: TEAM_LABELS.pin, meta: data?.pin ? plainText(data.pin) : 'none' },
      { id: 'backend', label: TEAM_LABELS.backend, meta: config.harness },
      { id: 'routing', label: TEAM_LABELS.routing, meta: config.routing.enabled ? 'on' : 'off' },
    ];
  }

  const selectedRole = (): RoleRow | undefined => data?.rows[table.index];
  const firstFix = (): Problem['fix'] => selectedRole()?.problems.find((p) => p.fix)?.fix;

  // ---- actions ----

  async function perform(fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); } catch (e) { ctx.toast(friendly(e), 'error'); } finally { load(); ctx.redraw(); }
  }
  const act = (fn: () => void | Promise<void>) => { void perform(fn); };

  /** The role's backend and model now, for a toast: `codex · gpt-6.1-sol`. */
  function summary(role: AgentRole): string {
    const s = describeRoleModel(ctx.config(), ctx.session, role);
    return `${s.harness} · ${modelText(s)}`;
  }

  function harnessOptions(config: Config, role?: AgentRole, current?: string): PickOption[] {
    return harnessNames(config).map((h) => {
      const p = config.providers[h];
      const tiers = config.routing.models[h];
      const key = p ? keyState(p.apiKeyEnv) : undefined;
      const tags = [
        h === current ? 'current' : '',
        key?.missing ? 'no key' : p && !p.model && !tiers ? 'no model' : '',
        role === 'reporter' && reporterSkipped(config, h) ? 'no notes' : '',
      ];
      return { value: h, label: h, meta: tags.filter(Boolean).join(' · ') || undefined };
    });
  }

  async function editRole(role: AgentRole, modelOnly = false): Promise<void> {
    const name = ROLE_NAMES[role];
    const config = ctx.config();
    const before = roleConfig(config, role);
    let harness = before.harness;
    for (;;) {
      if (!modelOnly) {
        const picked = await ctx.pick({ title: `${name}: backend`, options: harnessOptions(config, role, before.harness), selected: harness });
        if (picked === undefined) return;
        harness = picked;
      }
      const pinned = harness === before.harness ? config.roles[role]?.model : undefined;
      const choice = await chooseModel(ctx, {
        title: `${name}: model on ${harness}`, harness, current: pinned, lister, cache,
        auto: { ...autoOption(config, role, harness), selected: !pinned },
      });
      if (choice === undefined) { if (modelOnly) return; continue; }
      setRoleModel(ctx.session, ctx.config(), role, harness, choice.auto ? undefined : choice.model);
      ctx.toast(`${name} → ${summary(role)}`, 'ok');
      return;
    }
  }

  function autoRole(role: AgentRole): void {
    setRoleAuto(ctx.session, ctx.config(), role);
    ctx.toast(`${ROLE_NAMES[role]} → auto · ${summary(role)}`, 'ok');
  }

  function resetRole(role: AgentRole): void {
    resetRoleModel(ctx.session, role);
    ctx.toast(`${ROLE_NAMES[role]} reset · ${summary(role)}`, 'ok');
  }

  async function modelSet(): Promise<void> {
    const config = ctx.config();
    const h = config.harness;
    // The pinned sets pin each role to a tier's model: on a backend without tier models there is
    // nothing to pin, so only Automatic is offered there, and the others say why in their tag.
    const tiers = config.routing.models[h];
    const routingOn = config.routing.enabled;
    const picked = await ctx.pick({
      title: `Model set on ${h}`,
      options: MODEL_SETS.map((s) => ({ value: s.value, label: s.label, disabled: s.value !== 'auto' && !tiers, meta: s.value !== 'auto' && !tiers ? 'no tier models' : undefined })),
    });
    if (!picked) return;
    const label = MODEL_SETS.find((s) => s.value === picked)?.label ?? picked;
    if (picked !== 'auto' && routingOn) {
      // The consequence the person cannot see from the set's name: routing goes off with it.
      const yes = await ctx.confirm({
        title: `${label} turns routing off`, message: '',
        items: [{ label: 'Set', value: label }, { label: 'Backend', value: h }, { label: TERMS.routing, value: 'on → off' }],
        confirm: 'Apply',
      });
      if (!yes) return;
    }
    applyModelSet(ctx.session, ctx.config(), h, picked as ModelSetName);
    ctx.toast(`${label} on ${h}${picked !== 'auto' && routingOn ? ` · ${TERMS.routingOff}` : ''}`, 'ok');
  }

  async function oneModel(): Promise<void> {
    const config = ctx.config();
    const choice = await chooseModel(ctx, { title: `One model for every role on ${config.harness}`, harness: config.harness, lister, cache });
    if (!choice || choice.auto) return;
    for (const role of MODEL_ROLES) setRoleModel(ctx.session, ctx.config(), role, config.harness, choice.model);
    ctx.toast(`Every role → ${config.harness} · ${choice.model}`, 'ok');
  }

  async function globalPin(): Promise<void> {
    const config = ctx.config();
    const pin = ctx.session.model;
    const choice = await chooseModel(ctx, {
      title: 'Global pin', harness: config.harness, current: pin, lister, cache,
      auto: { label: 'No global pin', detail: pin ? 'clears it' : undefined, selected: !pin },
    });
    if (!choice) return;
    if (choice.auto) {
      setGlobalModel(ctx.session, undefined);
      ctx.toast(pin ? 'Global pin cleared' : 'No global pin', 'ok');
      return;
    }
    setGlobalModel(ctx.session, choice.model);
    ctx.toast(`Global pin ${choice.model}`, 'ok');
  }

  function clearPin(): void {
    setGlobalModel(ctx.session, undefined);
    ctx.toast('Global pin cleared', 'ok');
  }

  async function backendForAll(): Promise<void> {
    const config = ctx.config();
    const picked = await ctx.pick({ title: 'Backend for every role', options: harnessOptions(config, undefined, config.harness), selected: config.harness });
    if (!picked) return;
    // What is replaced is the consequence: every role's own choice and the pin.
    const yes = await ctx.confirm({
      title: `Run every role on ${picked}`, message: '',
      items: [
        { label: 'Backend', value: picked },
        { label: 'Models', value: 'automatic tiers' },
        { label: TERMS.routing, value: 'on' },
        { label: 'Replaces', value: `each role's choice${ctx.session.model ? ', the global pin' : ''}` },
      ],
      confirm: 'Switch',
    });
    if (!yes) return;
    applyModelSet(ctx.session, ctx.config(), picked, 'auto');
    ctx.toast(`Every role → ${picked} · automatic tiers`, 'ok');
  }

  function runTeam(id: string | undefined): void {
    switch (id as TeamAction | undefined) {
      case 'set': act(modelSet); break;
      case 'one': act(oneModel); break;
      case 'pin': act(globalPin); break;
      case 'backend': act(backendForAll); break;
      case 'routing': ctx.navigate('settings', { key: 'routing' }); break;
    }
  }

  async function save(): Promise<void> { await saveSettings(ctx); }

  function select(role: string): void {
    const r = roleFromWord(role);
    const i = r ? MODEL_ROLES.indexOf(r) : -1;
    if (i >= 0) { table.index = i; focus = 'roles'; }
  }

  // ---- drawing ----

  /** The selected role's facts as label and value rows, then its problems as short state lines. */
  function detailLines(r: RoleRow, w: number): string[] {
    const config = data!.config;
    const { s } = r;
    const out: string[] = [];
    const kv = (label: string, value: string, paint: (x: string) => string = c.text) => {
      wrapParagraphs(value, Math.max(1, w - LABEL)).forEach((l, i) => out.push(cell(i ? '' : c.muted(label), LABEL) + paint(l)));
    };
    // Rows that say something the roster does not: the model when pinned, the tiers automatic choices
    // use, where a choice comes from when it is not the saved one, the key. The default needs no row.
    if (s.mode === 'pinned') kv('Model', `${modelText(s)} · pinned`);
    if (s.mode === 'auto tiers') kv('Tiers', s.tiers.map((t) => `${t.tier} ${t.model}`).join(' · '), c.subtle);
    const from = fromText(s, r.changed);
    if (from !== 'repository') kv('From', `${from} ${g.modified}`, c.warn);
    const p = config.providers[s.harness];
    // A missing key is a problem line below; a key that is there says where it comes from.
    if (p?.apiKeyEnv) { const k = keyState(p.apiKeyEnv); if (!k.missing) kv('Key', k.text, c[k.tone]); }
    if (r.problems.length) out.push('');
    for (const pr of r.problems) {
      const paint = pr.tone === 'muted' ? c.muted : c[pr.tone];
      out.push(paint(fit(`${g.warn} ${pr.short}`, Math.max(1, w))));
    }
    return out;
  }

  /** Blockers, as short state lines: `! Planner on openai needs a model`. */
  function banner(cols: number, rows: number): string[] {
    const issues = data?.issues ?? [];
    const shown = issues.slice(0, rows);
    return shown.map((issue, i) => {
      const more = i === shown.length - 1 && issues.length > shown.length ? ` +${issues.length - shown.length} more` : '';
      // setupIssues starts with the role's id (the line prompt's word) and ends with advice; people read
      // the role's name and the state.
      const plain = plainText(issue).split(';')[0]!.trim();
      const role = roleFromWord(plain.split(' ')[0] ?? '');
      const text = role ? `${ROLE_NAMES[role]}${plain.slice(plain.indexOf(' '))}` : `${plain[0]?.toUpperCase() ?? ''}${plain.slice(1)}`;
      return cell(c.bad(fit(`${g.warn} ${text}${more}`, cols)), cols);
    });
  }

  return {
    id: 'models',
    title: 'Models',

    activate(params) {
      cache.clear();
      load();
      if (typeof params?.role === 'string') select(params.role);
    },

    badge() {
      // Asked on every paint of every tab; the config is read at most once a second for it.
      const t = ctx.now();
      if (t - badgeAt > 1000) {
        badgeAt = t;
        try { const n = setupIssues(ctx.config()).length; badgeText = n ? `${g.warn}${n}` : undefined; } catch { badgeText = undefined; }
      }
      return badgeText;
    },

    render(size) {
      if (!data) {
        // The reader's own message is the content.
        const w = Math.max(1, Math.min(size.cols - 4, 76));
        const lines = wrapParagraphs(`${g.warn} ${error ?? 'unreadable'}`, w).map((l) => c.bad(l));
        const rect = { top: 0, left: 0, rows: Math.min(size.rows, lines.length + 2), cols: Math.min(size.cols, w + 4) };
        return compose(size, [{ rect, block: panel(rect, { g, title: 'Models', focused: true }, () => lines) }]);
      }
      const issueRows = data.issues.length ? (size.rows >= 16 ? Math.min(2, data.issues.length) : size.rows >= 9 ? 1 : 0) : 0;
      // Each box as wide and as tall as its content: the roster and the whole-team list side by side
      // (stacked when they do not fit), and under them the selected role's facts, when it has any.
      const row = selectedRole();
      const teamW = Math.max(...team.items.map((it) => width(g.pointer) + 1 + width(plainText(it.label)) + (it.meta ? 2 + width(plainText(it.meta)) : 0))) + 4;
      const rosterW = Math.min(size.cols, Math.max(24, tableWidth(table, g) + 4));
      const side = rosterW + 1 + teamW <= size.cols;
      const avail = Math.max(0, size.rows - issueRows);
      const rosterRows = Math.min(avail, 2 + data.rows.length);
      const teamRows = team.items.length + 2;
      let teamRect: Rect | undefined;
      let below = issueRows + rosterRows;
      if (side) {
        teamRect = { top: issueRows, left: rosterW + 1, rows: Math.min(avail, teamRows), cols: teamW };
        below = issueRows + Math.max(rosterRows, teamRect.rows);
      } else if (size.rows - below >= teamRows) {
        teamRect = { top: below, left: 0, rows: teamRows, cols: Math.min(size.cols, Math.max(teamW, rosterW)) };
        below += teamRows;
      }
      const facts = row ? detailLines(row, 200) : [];
      const factsW = Math.min(size.cols, Math.max(rosterW, 20, ...facts.map((l) => width(l) + 4)));
      const factsRows = row ? detailLines(row, Math.max(1, factsW - 4)).length + 2 : 0;
      const room = size.rows - below;
      const detailRect: Rect | undefined = facts.length && room >= 3 ? { top: below, left: 0, rows: Math.min(room, factsRows), cols: factsW } : undefined;
      teamShown = Boolean(teamRect && teamRect.rows >= 3);
      if (!teamShown && focus === 'team') focus = 'roles';
      const rosterRect: Rect = { top: issueRows, left: 0, rows: rosterRows, cols: rosterW };
      rects = { roles: rosterRect, team: teamShown ? teamRect : undefined, detail: detailRect };
      const parts: Array<{ rect: Rect; block: string[] | { lines: string[] } }> = [];
      if (issueRows) parts.push({ rect: { top: 0, left: 0, rows: issueRows, cols: size.cols }, block: banner(size.cols, issueRows) });
      const changedRoles = data.rows.filter((r) => r.changed).length;
      parts.push({
        rect: rosterRect,
        block: panel(rosterRect, {
          g, title: 'Roles', focused: focus === 'roles',
          badge: changedRoles ? c.warn(`${g.modified}${changedRoles}`) : undefined,
          // Without the team list, its two states are the roster's footer.
          footer: teamShown ? undefined : () => c.muted(`${data!.config.routing.enabled ? TERMS.routingOn : TERMS.routingOff}${data!.pin ? ` · pin ${plainText(data!.pin)}` : ''}`),
        }, (inner) => renderTable(table, inner, g, { focused: focus === 'roles', header: false })),
      });
      if (detailRect && row) {
        parts.push({
          rect: detailRect,
          block: panel(detailRect, { g, title: ROLE_NAMES[row.role], scroll: () => scrollInfo(detailView) }, (inner) => {
            setScrollLines(detailView, detailLines(row, inner.cols), { keep: detailFor === row.role });
            detailFor = row.role;
            return renderScroll(detailView, inner, g);
          }),
        });
      }
      if (teamShown && teamRect) {
        parts.push({ rect: teamRect, block: panel(teamRect, { g, title: 'Whole team', focused: focus === 'team' }, (inner) => frame(renderList(team, inner, g, { focused: focus === 'team' }), inner)) });
      }
      return compose(size, parts);
    },

    onKey(k) {
      if (!data) {
        if (k.name === 'char' && k.ch === 'r') { load(); return true; }
        return false;
      }
      if ((k.name === 'tab' || k.name === 'shift-tab') && teamShown) { focus = focus === 'roles' ? 'team' : 'roles'; return true; }
      if (k.name === 'ctrl' && k.ch === 's') { act(save); return true; }
      // The roster is five rows, so the page keys scroll the role's facts instead.
      if ((k.name === 'pageup' || k.name === 'pagedown') && scrollKey(detailView, k)) return true;
      const role = selectedRole()?.role;
      if (focus === 'team') {
        if (listKey(team, k)) return true;
        if (k.name === 'enter') { runTeam(selectedItem(team)?.id); return true; }
      } else {
        if (tableKey(table, k)) return true;
        if (k.name === 'enter' && role) { act(() => editRole(role)); return true; }
      }
      if (k.name !== 'char') return false;
      switch (k.ch) {
        case 'e': if (role) act(() => editRole(role)); return true;
        case 'a': if (role) act(() => autoRole(role)); return true;
        case 'r': if (role) act(() => resetRole(role)); return true;
        case 'f': { const fix = firstFix(); if (fix) act(fix.run); else ctx.toast('Nothing to fix', 'info'); return true; }
        case 's': act(modelSet); return true;
        case 'o': act(oneModel); return true;
        case 'p': act(globalPin); return true;
        case 'b': act(backendForAll); return true;
        default: return false;
      }
    },

    onMouse(m) {
      if (!data) return false;
      const inRoles = rects.roles && hit(m, rects.roles);
      if (inRoles) {
        focus = 'roles';
        const r = tableMouse(table, { ...inRoles, row: inRoles.row - 1, col: inRoles.col - 2 });
        const role = selectedRole()?.role;
        if (r === 'activate' && role) act(() => editRole(role));
        return true;
      }
      const inDetail = rects.detail && hit(m, rects.detail);
      if (inDetail && (m.kind === 'wheel-up' || m.kind === 'wheel-down')) { scrollMouse(detailView, m); return true; }
      const inTeam = rects.team && hit(m, rects.team);
      if (inTeam) {
        focus = 'team';
        if (listMouse(team, { ...inTeam, row: inTeam.row - 1, col: inTeam.col - 2 }) === 'activate') runTeam(selectedItem(team)?.id);
        return true;
      }
      return false;
    },

    hints(): Hint[] {
      if (!data) return [{ key: 'r', label: 'retry' }];
      const saveHint = data.changed ? [{ key: '^s', label: 'save' }] : [];
      if (focus === 'team') return [{ key: '↑↓', label: 'move' }, { key: 'enter', label: 'run' }, { key: 'tab', label: 'roles' }, ...saveHint];
      // The keys for the selected role, then saving when something changed (else the team list).
      const fourth = firstFix() ? [{ key: 'f', label: 'fix' }] : saveHint.length ? saveHint : teamShown ? [{ key: 'tab', label: 'team' }] : [{ key: 's', label: 'set' }];
      return [{ key: '↑↓', label: 'role' }, { key: 'enter', label: 'edit' }, { key: 'a', label: 'auto' }, ...fourth];
    },

    commands(): PageCommand[] {
      if (!data) return [{ id: 'reload', title: 'Read the model settings again', shortcut: 'r', run: () => load() }];
      const row = selectedRole();
      const name = row ? ROLE_NOUNS[row.role] : '';
      const h = data.config.harness;
      const out: PageCommand[] = [];
      if (row) {
        out.push(
          { id: 'edit', title: `Edit the ${name}'s backend and model…`, shortcut: 'enter', run: () => perform(() => editRole(row.role)) },
          { id: 'auto', title: `Make the ${name} automatic on its backend`, shortcut: 'a', run: () => perform(() => autoRole(row.role)) },
          { id: 'reset', title: `Reset the ${name} to the saved setting`, shortcut: 'r', run: () => perform(() => resetRole(row.role)) },
        );
        row.problems.forEach((p, i) => { if (p.fix) out.push({ id: `fix-${i}`, title: `Fix the ${name}: ${p.fix.label}`, description: p.text, shortcut: i === row.problems.findIndex((x) => x.fix) ? 'f' : undefined, run: () => perform(p.fix!.run) }); });
      }
      out.push(
        { id: 'set', title: 'Apply a model set to every role…', shortcut: 's', description: teamHelp('set', h), run: () => perform(modelSet) },
        { id: 'one', title: 'One model for every role…', shortcut: 'o', description: teamHelp('one', h), run: () => perform(oneModel) },
        { id: 'pin', title: 'Set the global pin…', shortcut: 'p', description: teamHelp('pin', h), run: () => perform(globalPin) },
        ...(data.pin ? [{ id: 'unpin', title: `Clear the global pin (${plainText(data.pin)})`, run: () => perform(clearPin) }] : []),
        { id: 'backend', title: 'Run every role on one backend…', shortcut: 'b', description: teamHelp('backend', h), run: () => perform(backendForAll) },
        { id: 'routing', title: `Turn model routing ${data.config.routing.enabled ? 'off' : 'on'} (in Settings)`, description: teamHelp('routing', h), run: () => ctx.navigate('settings', { key: 'routing' }) },
        { id: 'save', title: 'Save the model choices…', shortcut: '^s', run: save },
      );
      return out;
    },

    help(): HelpGroup[] {
      const groups: HelpGroup[] = [];
      // The focused item first: the selected role (what it does, how its model is chosen, what is wrong
      // and how f fixes it), or the highlighted whole-team action.
      const row = selectedRole();
      if (data && focus === 'team') {
        const it = selectedItem(team);
        if (it) groups.push({ title: plainText(it.label).replace(/…$/, ''), keys: [], text: teamHelp(it.id, data.config.harness) });
      } else if (data && row) {
        const s = row.s;
        groups.push({ title: ROLE_NAMES[row.role], keys: [], text: [
          ROLE_JOBS[row.role],
          `${s.harness}: ${backendDetail(data.config, s.harness) || 'an API provider'}. ${chosenHelp(data.config, s)}`.trim(),
          ...row.problems.map((p) => (p.fix ? `${p.text} f: ${p.fix.label}.` : p.text)),
        ] });
      }
      groups.push(
        { title: 'Roles', keys: [
          { key: '↑↓', label: 'choose a role' },
          { key: 'enter  e', label: 'edit its backend and model' },
          { key: 'a', label: 'automatic on its backend' },
          { key: 'r', label: 'reset to the saved setting' },
          { key: 'f', label: 'fix the role\'s problem' },
          { key: 'pgup pgdn', label: 'scroll its facts' },
          { key: 'click', label: 'select; click again to edit' },
        ] },
        { title: 'Whole team', keys: [
          { key: 's', label: 'apply a model set' },
          { key: 'o', label: 'one model for every role' },
          { key: 'p', label: 'set or clear the global pin' },
          { key: 'b', label: 'one backend for every role' },
          { key: 'tab', label: 'roles / whole team' },
        ] },
        { title: 'Saving', keys: [{ key: '^s', label: 'save settings' }] },
        { title: 'About', keys: [], text: [
          'A choice made for one role wins over the global pin, which wins over the saved settings.',
          'Automatic tiers follow the task: workers by difficulty and one tier up on retries, planner and reviewer high, docs and reporter low. A pinned model ignores both.',
          `${g.modified} marks a choice changed this session; it lasts until dulger exits unless saved (^s).`,
        ] },
      );
      return groups;
    },
  };
}
