import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRole, HarnessName } from './types.ts';

export interface RoleConfig {
  harness?: HarnessName;
  model?: string;
  maxBudgetUsd?: number;
}

export interface Config {
  harness: HarnessName;
  roles: Partial<Record<AgentRole, RoleConfig>>;
  concurrency: number;
  maxAttempts: number;       // checker-fail retries per card
  maxContinuations: number;  // "done:false" resumes per task
  stallTimeoutSec: number;
  docs: boolean;
  checker: { allowedCommands: string[] };
  codex: { bypassSandbox: boolean };
}

export const DEFAULT_CONFIG: Config = {
  harness: 'claude',
  roles: {},
  concurrency: 3,
  maxAttempts: 2,
  maxContinuations: 2,
  stallTimeoutSec: 600,
  docs: true,
  checker: { allowedCommands: ['npm test', 'npm run test', 'pytest', 'cargo test', 'go test'] },
  codex: { bypassSandbox: false },
};

export const STATE_DIR = '.usta';

/** Defaults <- <repo>/.usta/config.json <- CLI overrides. */
export function loadConfig(repoRoot: string, overrides: Partial<Config> = {}): Config {
  const file = join(repoRoot, STATE_DIR, 'config.json');
  const fromFile: Partial<Config> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...overrides,
    roles: { ...DEFAULT_CONFIG.roles, ...fromFile.roles, ...overrides.roles },
    checker: { ...DEFAULT_CONFIG.checker, ...fromFile.checker, ...overrides.checker },
    codex: { ...DEFAULT_CONFIG.codex, ...fromFile.codex, ...overrides.codex },
  };
}

/** Resolve which harness / model a given role should use. */
export function roleConfig(config: Config, role: AgentRole): Required<Pick<RoleConfig, 'harness'>> & RoleConfig {
  const r = config.roles[role] ?? {};
  return { ...r, harness: r.harness ?? config.harness };
}
