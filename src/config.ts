import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRole, HarnessName } from './types.ts';

export interface RoleConfig {
  harness?: HarnessName;
  model?: string;
  maxBudgetUsd?: number;
}

export interface MemoryConfig {
  location: 'user' | 'repo';  // user: ~/.local/share/dulger/<project>/, repo: <repo>/.dulger/
  maxItems: number;           // per prompt
  maxChars: number;
}

export interface Config {
  harness: HarnessName;
  roles: Partial<Record<AgentRole, RoleConfig>>;
  concurrency: number;
  maxAttempts: number;       // review rounds per card (each rejection adds a fix task)
  maxReplans: number;        // planner reruns after a card failed
  maxContinuations: number;  // "done:false" resumes per task
  stallTimeoutSec: number;
  docs: boolean;
  checker: { allowedCommands: string[] };
  claude: { mcp: boolean };  // inherit the user's MCP servers (off: far smaller prompts, no late-connect cache misses)
  codex: { bypassSandbox: boolean };
  memory: MemoryConfig;
}

export const DEFAULT_CONFIG: Config = {
  harness: 'claude',
  roles: {},
  concurrency: 3,
  maxAttempts: 2,
  maxReplans: 1,
  maxContinuations: 2,
  stallTimeoutSec: 600,
  docs: true,
  checker: { allowedCommands: ['npm test', 'npm run test', 'pytest', 'cargo test', 'go test'] },
  claude: { mcp: false },
  codex: { bypassSandbox: false },
  memory: { location: 'user', maxItems: 40, maxChars: 6000 },
};

export const STATE_DIR = '.dulger';

/** Defaults <- <repo>/.dulger/config.json <- CLI overrides. */
export function loadConfig(repoRoot: string, overrides: Partial<Config> = {}): Config {
  const file = join(repoRoot, STATE_DIR, 'config.json');
  const fromFile: Partial<Config> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...overrides,
    roles: { ...DEFAULT_CONFIG.roles, ...fromFile.roles, ...overrides.roles },
    checker: { ...DEFAULT_CONFIG.checker, ...fromFile.checker, ...overrides.checker },
    claude: { ...DEFAULT_CONFIG.claude, ...fromFile.claude, ...overrides.claude },
    codex: { ...DEFAULT_CONFIG.codex, ...fromFile.codex, ...overrides.codex },
    memory: { ...DEFAULT_CONFIG.memory, ...fromFile.memory, ...overrides.memory },
  };
}

/** Resolve which harness / model a given role should use. */
export function roleConfig(config: Config, role: AgentRole): Required<Pick<RoleConfig, 'harness'>> & RoleConfig {
  const r = config.roles[role] ?? {};
  return { ...r, harness: r.harness ?? config.harness };
}
