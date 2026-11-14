import { CliError } from './errors.ts';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_CONFIG, type Config, type ApiConfig } from './config.ts';
import type { Board } from './types.ts';

// The sandbox is the machine's policy, not the run's: it is never saved with a run or a profile, never
// compared on resume, and never restored from a board, so the current machine policy always applies.
export type SavedConfig = Omit<Config, 'sandbox'>;
export interface SettingsSnapshot { version: 1; config: SavedConfig }
/** Persist only supported settings, never environment values or unknown credential fields. */
export function snapshotSettings(config: SavedConfig): SettingsSnapshot {
  const clean = Object.fromEntries([...Object.keys(DEFAULT_CONFIG).filter((key) => key !== 'sandbox'), 'budgetUsd', 'cardBudgetUsd', 'worktreeSetup'].map((key) => [key, config[key as keyof SavedConfig]])) as unknown as SavedConfig;
  clean.providers = Object.fromEntries(Object.entries(config.providers).map(([name, p]) => {
    const url = new URL(p!.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new CliError(`Provider ${name}: use an API key environment variable; endpoint URLs must not contain credentials, queries or fragments.`);
    const { baseUrl, apiKeyEnv, model, maxTurns, maxTokens, tokenParameter, timeoutSec, retries, commandTimeoutSec } = p!;
    return [name, { baseUrl, apiKeyEnv, model, maxTurns, maxTokens, tokenParameter, timeoutSec, retries, commandTimeoutSec } satisfies ApiConfig];
  }));
  clean.roles = Object.fromEntries(Object.entries(config.roles).map(([role, value]) => {
    const { harness, model, maxBudgetUsd } = value;
    return [role, { harness, model, maxBudgetUsd }];
  }));
  return { version: 1, config: JSON.parse(JSON.stringify(clean)) as SavedConfig };
}
/** The run's saved settings, under the current machine's sandbox (a hand-edited board's `sandbox` included). */
export function originalSettings(board: Board, current: Config): Config {
  if (!board.settings) return current;
  if (board.settings.version !== 1) throw new CliError('This run uses a newer settings format. Update dulger before resuming.');
  return { ...structuredClone(board.settings.config), sandbox: current.sandbox };
}
export function settingsChanges(original: SavedConfig, current: SavedConfig): string[] {
  const before = snapshotSettings(original).config;
  const after = snapshotSettings(current).config;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !isDeepStrictEqual(before[key as keyof SavedConfig], after[key as keyof SavedConfig]));
}
