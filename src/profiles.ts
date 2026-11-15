import { CliError } from './errors.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Session } from './repl.ts';
import { snapshotSettings, type SettingsSnapshot } from './runSettings.ts';
import { MODEL_ROLES } from './replModels.ts';

const PROFILE_NAME = /^[\w][\w .-]{0,59}$/;

/** Why `name` cannot name a profile, or undefined when it can: the rule saveProfile applies, for checking while it is typed. */
export function profileNameError(name: string): string | undefined {
  return PROFILE_NAME.test(name) ? undefined : 'Use 1–60 letters, numbers, spaces, dots, underscores or hyphens, starting with a letter or number.';
}

/** The saved profiles by name. Throws CliError for a profiles.json that is not valid JSON or has an unsupported format. */
export function readProfiles(root: string): Record<string, SettingsSnapshot> {
  const path = join(root, '.dulger', 'profiles.json');
  if (!existsSync(path)) return {};
  let profiles: Record<string, SettingsSnapshot>;
  try {
    profiles = JSON.parse(readFileSync(path, 'utf8')) as Record<string, SettingsSnapshot>;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new CliError(`.dulger/profiles.json is not valid JSON (${e.message}); fix or remove the file to use profiles again.`);
  }
  if (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles)) throw new CliError('.dulger/profiles.json must contain a JSON object of profiles.');
  for (const [name, p] of Object.entries(profiles)) if (p?.version !== 1 || !p.config) throw new CliError(`Profile ${name} has an unsupported format.`);
  return profiles;
}
export interface ProfileSummary { name: string; harness: string; concurrency: number; budgetUsd?: number; cardBudgetUsd?: number }

/** One line's worth per saved profile, in file order. Throws what readProfiles throws (an unsupported or broken profiles.json). */
export function profileSummaries(root: string): ProfileSummary[] {
  return Object.entries(readProfiles(root)).map(([name, p]) => ({
    name, harness: p.config.harness, concurrency: p.config.concurrency, budgetUsd: p.config.budgetUsd, cardBudgetUsd: p.config.cardBudgetUsd,
  }));
}

export function saveProfile(root: string, name: string, config: Config, overwrite = false): void {
  const bad = profileNameError(name);
  if (bad) throw new CliError(bad);
  const profiles = readProfiles(root);
  if (Object.hasOwn(profiles, name) && !overwrite) throw new CliError(`Profile ${name} already exists. Choose Replace profile to overwrite it.`);
  Object.defineProperty(profiles, name, { value: snapshotSettings(config), enumerable: true, writable: true, configurable: true });
  const dir = join(root, '.dulger');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'profiles.json');
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
export function applyProfile(session: Session, profile: SettingsSnapshot): void {
  if (profile.version !== 1) throw new CliError('Unsupported profile version.');
  session.overrides = { ...structuredClone(profile.config), budgetUsd: profile.config.budgetUsd, cardBudgetUsd: profile.config.cardBudgetUsd, worktreeSetup: profile.config.worktreeSetup };
  session.overrides.roles = Object.fromEntries(MODEL_ROLES.map((role) => [role, { ...profile.config.roles[role] }]));
  session.model = undefined;
  session.modelRoles = Object.fromEntries(MODEL_ROLES.map((role) => [role, { harness: profile.config.roles[role]?.harness ?? profile.config.harness, model: profile.config.roles[role]?.model }]));
}
