import { CliError } from './errors.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Session } from './repl.ts';
import { snapshotSettings, type SettingsSnapshot } from './runSettings.ts';
import { MODEL_ROLES } from './replModels.ts';

export function readProfiles(root: string): Record<string, SettingsSnapshot> {
  const path = join(root, '.dulger', 'profiles.json');
  if (!existsSync(path)) return {};
  const profiles = JSON.parse(readFileSync(path, 'utf8')) as Record<string, SettingsSnapshot>;
  for (const [name, p] of Object.entries(profiles)) if (p.version !== 1 || !p.config) throw new CliError(`Profile ${name} has an unsupported format.`);
  return profiles;
}
export function saveProfile(root: string, name: string, config: Config, overwrite = false): void {
  if (!/^[\w][\w .-]{0,59}$/.test(name)) throw new CliError('Use 1–60 letters, numbers, spaces, dots, underscores or hyphens for the profile name.');
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
