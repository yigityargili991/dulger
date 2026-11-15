// What the Settings page shows, computed from the settings table and the session: the form's fields,
// how the session differs from the saved config, and from the session as the app found
// it. No drawing and no dialogs here, so the page's logic can be checked against a temporary repo.
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { loadConfig, roleConfig, STATE_DIR, type Config } from '../../config.ts';
import { MODEL_ROLES, sessionConfig } from '../../replModels.ts';
import {
  SESSION_SETTINGS, SETTING_GROUPS, formatSetting, sessionChanges, settingOptions,
  type SessionChanges, type SessionSetting, type SettingKey, type SettingValue,
} from '../../settings.ts';
import type { Session } from '../../repl.ts';
import type { AgentRole } from '../../types.ts';
import type { Field, FieldValue, FormSection } from '../../tui/kit/index.ts';
import { ROLE_NOUNS } from '../look.ts';

/** The flags a session starts with when nothing was passed: what "saved" means for session-only settings. */
const fresh = (): Session => ({ overrides: {}, yes: false, quiet: false, allowDirty: false });

export interface SettingsView {
  /** The session's effective config. */
  config: Config;
  /** What the saved files give on their own: the repository's, under the user's USER_KEYS. */
  saved: Config;
  changes: SessionChanges;
  /** Roles with a choice of their own that differs from the saved one (`changes.roles`). */
  roles: AgentRole[];
  /** Changes Save would write: repository settings, roles and providers. */
  unsaved: number;
  /** Session-only settings that differ from their defaults (never saved). */
  sessionOnly: SettingKey[];
}

/** Read everything the page shows. Throws what loadConfig throws for a broken config file. */
export function readView(repoRoot: string, session: Session): SettingsView {
  const config = sessionConfig(repoRoot, session);
  const saved = loadConfig(repoRoot);
  const changes = sessionChanges(repoRoot, session);
  const repoChanged = changes.settings.filter((k) => scopeOf(k) === 'repository');
  const roles = changes.roles;
  return {
    config, saved, changes, roles,
    unsaved: repoChanged.length + roles.length + changes.providers.length,
    sessionOnly: changes.settings.filter((k) => scopeOf(k) === 'session'),
  };
}

function scopeOf(key: SettingKey): 'repository' | 'session' {
  return SESSION_SETTINGS.find((s) => s.key === key)?.scope ?? 'repository';
}

export function configPath(repoRoot: string): string {
  return join(repoRoot, STATE_DIR, 'config.json');
}

/** The value as a form shows it: on/off, $5.00, 120s, a choice's label. */
export function showValue(s: SessionSetting, value: SettingValue, config: Config): string {
  if (s.kind === 'choice') return settingOptions(s, config).find((o) => o.value === value)?.label ?? String(value);
  if (s.kind === 'dollars' && typeof value === 'number') return `$${value.toFixed(2)}`;
  return formatSetting(s.key, value);
}

export function savedValue(s: SessionSetting, view: SettingsView): SettingValue {
  return s.read(fresh(), view.saved);
}

/** One role as it runs now, for the list of changes: "claude / sonnet". */
export function roleSummary(config: Config, role: AgentRole): string {
  const rc = roleConfig(config, role);
  return `${rc.harness} / ${rc.model ?? (config.providers[rc.harness] ? 'model required' : config.routing.enabled && config.routing.models[rc.harness] ? 'routed' : 'default model')}`;
}

export function providerChange(view: SettingsView, name: string): 'added' | 'removed' | 'changed' {
  const now = Object.hasOwn(view.config.providers, name);
  const before = Object.hasOwn(view.saved.providers, name);
  return now && !before ? 'added' : !now && before ? 'removed' : 'changed';
}

/** What Save would write, one line each, in form order. */
export function saveItems(view: SettingsView, session: Session): Array<{ label: string; value?: string }> {
  const items: Array<{ label: string; value?: string }> = [];
  for (const s of SESSION_SETTINGS) {
    if (s.scope !== 'repository' || !view.changes.settings.includes(s.key)) continue;
    items.push({ label: s.label, value: `${showValue(s, savedValue(s, view), view.saved)} → ${showValue(s, s.read(session, view.config), view.config)}` });
  }
  for (const role of view.roles) items.push({ label: `${cap(ROLE_NOUNS[role])} model`, value: roleSummary(view.config, role) });
  for (const name of view.changes.providers) items.push({ label: `Provider ${name}`, value: providerChange(view, name) });
  if (view.changes.unsaved && !items.length) items.push({ label: OTHER_SETTINGS, value: 'from a profile or flags' });
  return items;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The save list's row for changes the form cannot name (dropped when the extras name them). */
export const OTHER_SETTINGS = 'Other settings';

/** The config keys the settings form, its roles and its providers already account for in the Save dialog. */
const FORM_WRITTEN_KEYS = new Set([
  'harness', 'concurrency', 'maxAttempts', 'maxReplans', 'docs', 'progressIntervalSec',
  'routing', 'budgetUsd', 'cardBudgetUsd', 'tui', 'roles', 'providers',
]);

/** A written value shown whole, so a shell field (worktreeSetup, checker commands) is never cut or hidden. */
function writeValue(v: unknown): string {
  return v === undefined ? 'removed' : JSON.stringify(v);
}

/**
 * Rows for keys the save writes that the form cannot name (from the same merge the save performs), so
 * the dialog lists exactly what lands in .dulger/config.json. `shown` is what the form already lists.
 */
export function extraWriteItems(diff: { before: Record<string, unknown>; after: Record<string, unknown>; keys: string[] }, shown: Array<{ label: string }>): Array<{ label: string; value?: string }> {
  const already = new Set(shown.map((i) => i.label));
  const out: Array<{ label: string; value?: string }> = [];
  for (const key of diff.keys) {
    if (FORM_WRITTEN_KEYS.has(key) || already.has(key)) continue;
    const before = diff.before[key];
    out.push({ label: key, value: before === undefined ? `added ${writeValue(diff.after[key])}` : `${writeValue(before)} → ${writeValue(diff.after[key])}` });
  }
  return out;
}

/** How two sessions differ in effect, for Discard: settings, roles and providers, in form order. */
export function sessionDiff(repoRoot: string, now: Session, before: Session): { items: Array<{ label: string; value?: string }>; differs: boolean } {
  const a = sessionConfig(repoRoot, now);
  const b = sessionConfig(repoRoot, before);
  const items: Array<{ label: string; value?: string }> = [];
  for (const s of SESSION_SETTINGS) {
    const x = s.read(now, a);
    const y = s.read(before, b);
    if (!isDeepStrictEqual(x, y)) items.push({ label: s.label, value: `${showValue(s, x, a)} → ${showValue(s, y, b)}` });
  }
  // As for Save: a role that only follows the harness is that setting's change, not one of its own.
  for (const r of MODEL_ROLES) if (!isDeepStrictEqual(plain(a.roles[r] ?? {}), plain(b.roles[r] ?? {}))) items.push({ label: `${cap(ROLE_NOUNS[r])} model`, value: `${roleSummary(a, r)} → ${roleSummary(b, r)}` });
  for (const name of new Set([...Object.keys(a.providers), ...Object.keys(b.providers)])) {
    if (isDeepStrictEqual(plain(a.providers[name]), plain(b.providers[name]))) continue;
    items.push({ label: `Provider ${name}`, value: !b.providers[name] ? 'removed' : !a.providers[name] ? 'restored' : 'edits undone' });
  }
  const differs = items.length > 0 || !isDeepStrictEqual(plain(a), plain(b));
  if (differs && !items.length) items.push({ label: 'Settings this page does not show', value: 'from a profile' });
  return { items, differs };
}

function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * What the app changed and nobody saved: repository settings, role models and providers that differ
 * from the saved files and from how the session started (so a value that came with a command-line
 * flag does not count). Session-only switches are never saved, so they are not listed. Labels, in form order.
 */
export function unsavedInApp(repoRoot: string, session: Session, start: Session): string[] {
  const now = sessionChanges(repoRoot, session);
  const before = sessionChanges(repoRoot, start);
  const a = sessionConfig(repoRoot, session);
  const b = sessionConfig(repoRoot, start);
  const out: string[] = [];
  for (const s of SESSION_SETTINGS) {
    if (s.scope !== 'repository' || !now.settings.includes(s.key)) continue;
    if (isDeepStrictEqual(s.read(session, a), s.read(start, b))) continue;
    out.push(s.label);
  }
  for (const r of now.roles) if (!before.roles.includes(r) || !isDeepStrictEqual(plain(a.roles[r] ?? {}), plain(b.roles[r] ?? {}))) out.push(`${ROLE_NOUNS[r]} model`);
  for (const p of now.providers) if (!isDeepStrictEqual(plain(a.providers[p]), plain(b.providers[p]))) out.push(`provider ${p}`);
  return out;
}

/** The one line printed on the normal terminal after the app exits, when it changed something nobody saved. */
export function exitNote(repoRoot: string, session: Session, start: Session): string | undefined {
  let lost: string[];
  try { lost = unsavedInApp(repoRoot, session, start); } catch { return undefined; }
  if (!lost.length) return undefined;
  const list = lost.length <= 4 ? lost.join(', ') : `${lost.slice(0, 3).join(', ')} and ${lost.length - 3} more`;
  return `Not saved: ${list} (changed in the app this session). "Save settings" on the Settings tab keeps changes for the next start.`;
}

/** Put `session` back to `snapshot` in place: other pages and the shell hold the same object. */
export function restoreSession(session: Session, snapshot: Session): void {
  const target = session as unknown as Record<string, unknown>;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(session, structuredClone(snapshot));
}

/** A typed value from what a form field reports, or the same value back for the table to refuse. */
export function fieldToValue(s: SessionSetting, v: FieldValue): SettingValue {
  switch (s.kind) {
    case 'toggle': return v as boolean;
    case 'count': return v as number;
    case 'dollars': case 'seconds': return v === undefined ? undefined : (v as number);
    case 'choice': return String(v);
  }
}

/** What turning an "off" field on starts from: the saved value when there is one, else a sensible amount. */
export function startValue(s: SessionSetting, view: SettingsView): number | undefined {
  const saved = savedValue(s, view);
  if (typeof saved === 'number') return saved;
  if (s.kind === 'seconds') return s.onSeconds;
  if (s.kind === 'dollars') return s.key === 'budget' ? 10 : 2;
  return undefined;
}

export interface FieldOptions {
  /** Errors the table gave for the last value tried, by setting. */
  errors: ReadonlyMap<string, string>;
}

/** The form: one section per group in the table's order, each setting as the field its kind calls for. */
export function settingSections(view: SettingsView, session: Session, o: FieldOptions): FormSection[] {
  const sections: FormSection[] = SETTING_GROUPS.map((group) => ({
    title: group,
    // Values only: saving, discarding, profiles and the Models tab are keys (s, d, l, a, m), not rows.
    fields: SESSION_SETTINGS.filter((s) => s.group === group).map((s) => settingField(s, view, session, o.errors.get(s.key))),
  })).filter((s) => s.fields.length);
  return sections;
}

function settingField(s: SessionSetting, view: SettingsView, session: Session, error?: string): Field {
  const value = s.read(session, view.config);
  // ✎ means Save would write it: a session-only setting has no saved value to differ from.
  const changed = s.scope === 'repository' && view.changes.settings.includes(s.key);
  const saved = savedValue(s, view);
  const notes = [s.help];
  if (s.key === 'harness') notes.push('A role can have a backend of its own on the Models tab (m).');
  // DULGER_ICONS wins over the setting: say so where the setting would seem to do nothing.
  const env = process.env.DULGER_ICONS;
  const iconsEnv = s.key === 'icons' && (env === 'nerd' || env === 'unicode' || env === 'ascii') ? `DULGER_ICONS=${env} wins` : '';
  if (iconsEnv) notes.push(`The environment sets DULGER_ICONS=${env}, which wins over this setting until it is unset.`);
  // A card budget at or above the run budget never fails a card before the run stops.
  const run = view.config.budgetUsd;
  const card = view.config.cardBudgetUsd;
  const over = s.key === 'card-budget' && run !== undefined && card !== undefined && card >= run ? 'not below the run budget' : '';
  if (over) notes.push(`It is not below the run budget (${'$'}${run!.toFixed(2)}), so the run stops before any card reaches it.`);
  // On the row: the value, ✎ when it differs from the saved one, and a one-word tag. The rest is help.
  if (s.scope === 'session') notes.push('Session only: never saved.');
  else if (changed) notes.push(`Saved: ${showValue(s, saved, view.saved)}.`);
  const tag = iconsEnv ? 'env' : over ? '≥ run' : s.scope === 'session' ? 'session' : undefined;
  const base = { key: s.key, label: s.label, description: notes.join(' '), changed, error, tag };
  switch (s.kind) {
    case 'toggle': return { ...base, kind: 'toggle', value: Boolean(value) };
    case 'count': return { ...base, kind: 'number', value: value as number, min: s.min, max: s.max };
    // Any amount above zero is allowed when typed; the arrows move in half dollars and step below
    // the smallest amount to off.
    case 'dollars': return { ...base, kind: 'number', value: value as number | undefined, optional: true, prefix: '$', decimals: 2, step: 0.5, min: 0.01, offLabel: 'off' };
    case 'seconds': return { ...base, kind: 'number', value: value as number | undefined, optional: true, unit: 's', step: 30, min: 1, offLabel: 'off' };
    case 'choice': return { ...base, kind: 'choice', value: String(value), options: settingOptions(s, view.config).map((op) => ({ value: op.value, label: op.label, description: op.description })) };
  }
}
