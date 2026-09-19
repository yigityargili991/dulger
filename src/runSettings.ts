import { CliError } from './errors.ts';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_CONFIG, type Config, type ApiConfig } from './config.ts';
import type { Board } from './types.ts';

export interface SettingsSnapshot { version: 1; config: Config }
/** Persist only supported settings, never environment values or unknown credential fields. */
export function snapshotSettings(config: Config): SettingsSnapshot {
  const clean = Object.fromEntries([...Object.keys(DEFAULT_CONFIG), 'budgetUsd', 'cardBudgetUsd', 'worktreeSetup'].map((key) => [key, config[key as keyof Config]])) as unknown as Config;
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
  return { version: 1, config: JSON.parse(JSON.stringify(clean)) as Config };
}
export function originalSettings(board: Board, current: Config): Config {
  if (!board.settings) return current;
  if (board.settings.version !== 1) throw new CliError('This run uses a newer settings format. Update dulger before resuming.');
  return structuredClone(board.settings.config);
}
export function settingsChanges(original: Config, current: Config): string[] {
  const before = snapshotSettings(original).config;
  const after = snapshotSettings(current).config;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !isDeepStrictEqual(before[key as keyof Config], after[key as keyof Config]));
}
