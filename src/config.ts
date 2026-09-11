import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRole, HarnessName, ModelTier, Card, Task } from './types.ts';
import type { IconSet } from './tui/theme.ts';

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

export interface ApiConfig {
  baseUrl: string;
  apiKeyEnv?: string;
  model?: string;
  maxTurns: number;
  maxTokens: number;
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  timeoutSec: number;
}

export interface RoutingConfig {
  enabled: boolean;
  models: Partial<Record<HarnessName, Partial<Record<ModelTier, string>>>>;
}

export interface Config {
  harness: HarnessName;
  roles: Partial<Record<AgentRole, RoleConfig>>;
  routing: RoutingConfig;
  providers: Partial<Record<HarnessName, ApiConfig>>;
  concurrency: number;
  maxAttempts: number;       // review rounds per card (each rejection adds a fix task)
  maxReplans: number;        // planner reruns after a card failed
  maxContinuations: number;  // "done:false" resumes per task
  stallTimeoutSec: number;
  docs: boolean;
  /** Bash prefixes the reviewer may run on top of a card's own verify commands. */
  checker: { allowedCommands: string[] };
  /** Seconds one verify command may take before dulger kills it and counts it as failed. */
  verifyTimeoutSec: number;
  /** Shell command run once in every new worktree before agents use it (e.g. "npm ci"). */
  worktreeSetup?: string;
  claude: { mcp: boolean };  // give the user's MCP servers to the agents that can use them (workers, docs); planner and checker never get them
  codex: { bypassSandbox: boolean };
  memory: MemoryConfig;
  /** The full-screen run view on a terminal; icons: nerd | unicode | ascii | auto (nerd on ghostty, kitty, wezterm, alacritty, foot). */
  tui: { enabled: boolean; icons: IconSet | 'auto' };
}

export const DEFAULT_CONFIG: Config = {
  harness: 'claude',
  roles: {},
  routing: {
    enabled: true,
    models: {
      claude: { low: 'haiku', medium: 'sonnet', high: 'claude-fable-5-1' },
      codex: { low: 'gpt-5.6-luna', medium: 'gpt-5.6-sol', high: 'gpt-6-astra' },
    },
  },
  providers: {
    ollama: { baseUrl: 'http://localhost:11434/v1', maxTurns: 40, maxTokens: 8192, timeoutSec: 300 },
    deepseek: { baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-flash', maxTurns: 40, maxTokens: 8192, timeoutSec: 300 },
    openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', maxTurns: 40, maxTokens: 8192, timeoutSec: 300 },
  },
  concurrency: 3,
  maxAttempts: 2,
  maxReplans: 1,
  maxContinuations: 2,
  stallTimeoutSec: 600,
  docs: true,
  checker: { allowedCommands: ['npm test', 'npm run test', 'npm run typecheck', 'npm run lint', 'npm run build', 'pytest', 'cargo test', 'cargo build', 'cargo check', 'cargo clippy', 'go test', 'go build', 'go vet'] },
  verifyTimeoutSec: 600,
  claude: { mcp: true },
  codex: { bypassSandbox: false },
  memory: { location: 'user', maxItems: 40, maxChars: 6000 },
  tui: { enabled: true, icons: 'auto' },
};

export const STATE_DIR = '.dulger';

/** Defaults <- <repo>/.dulger/config.json <- CLI overrides. */
export function loadConfig(repoRoot: string, overrides: Partial<Config> = {}): Config {
  const file = join(repoRoot, STATE_DIR, 'config.json');
  const fromFile: Partial<Config> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const models = { ...DEFAULT_CONFIG.routing.models };
  const providers = { ...DEFAULT_CONFIG.providers };
  for (const source of [fromFile, overrides]) {
    for (const [name, tiers] of Object.entries(source.routing?.models ?? {})) {
      const key = name as HarnessName;
      models[key] = { ...models[key], ...tiers };
    }
    for (const [name, provider] of Object.entries(source.providers ?? {})) {
      const key = name as HarnessName;
      providers[key] = { ...providers[key], ...provider } as ApiConfig;
    }
  }
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...overrides,
    roles: { ...DEFAULT_CONFIG.roles, ...fromFile.roles, ...overrides.roles },
    routing: { ...DEFAULT_CONFIG.routing, ...fromFile.routing, ...overrides.routing, models },
    providers,
    checker: { ...DEFAULT_CONFIG.checker, ...fromFile.checker, ...overrides.checker },
    claude: { ...DEFAULT_CONFIG.claude, ...fromFile.claude, ...overrides.claude },
    codex: { ...DEFAULT_CONFIG.codex, ...fromFile.codex, ...overrides.codex },
    memory: { ...DEFAULT_CONFIG.memory, ...fromFile.memory, ...overrides.memory },
    tui: { ...DEFAULT_CONFIG.tui, ...fromFile.tui, ...overrides.tui },
  };
  for (const harness of [config.harness, ...Object.values(config.roles).map((r) => r.harness).filter(Boolean)]) {
    if (!['claude', 'codex', 'fake', 'ollama', 'deepseek', 'openai'].includes(harness!)) throw new Error(`unknown harness: ${harness}`);
  }
  return config;
}

/** Resolve which harness / model a given role should use. */
export function roleConfig(config: Config, role: AgentRole, context: { card?: Card; task?: Task } = {}): Required<Pick<RoleConfig, 'harness'>> & RoleConfig {
  const r = config.roles[role] ?? {};
  const harness = r.harness ?? config.harness;
  const tier = modelTier(role, context);
  return { ...r, harness, model: r.model ?? (config.routing.enabled ? config.routing.models[harness]?.[tier] : undefined) ?? config.providers[harness]?.model };
}

/** Planning gets the strongest model; ordinary work/review gets medium. Retry one tier up. */
export function modelTier(role: AgentRole, { card, task }: { card?: Card; task?: Task } = {}): ModelTier {
  if (role === 'planner') return 'high';
  if (role === 'docs') return 'low';
  const tiers: ModelTier[] = ['low', 'medium', 'high'];
  if (role === 'checker') return card?.tasks.some((t) => t.complexity === 'high' || t.kind === 'fix') ? 'high' : 'medium';
  const base = tiers.indexOf(task?.complexity ?? 'medium');
  const escalation = task?.kind === 'fix' ? 1 : Math.max(0, (task?.attempts ?? 1) - 1);
  return tiers[Math.min(2, base + escalation)]!;
}
