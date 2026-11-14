// The environment for the commands dulger runs on code an agent wrote: verify commands, worktree setup,
// and the API tools' shell and git. They execute the worker's tests and build scripts, so they must not
// see the credentials that pay for the agents. Only these names are dropped, never a pattern: a project's
// own NPM_TOKEN or DATABASE_PASSWORD still reaches its setup and tests. The CLI harnesses (process.ts)
// are not run with this; they need their own credentials.
import type { Config } from './config.ts';

const AGENT_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'DEEPSEEK_API_KEY'];

/** A copy of process.env without the agent credentials and, given a config, every provider's apiKeyEnv. */
export function childEnv(config?: Pick<Config, 'providers'>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of AGENT_CREDENTIALS) delete env[name];
  for (const provider of Object.values(config?.providers ?? {})) if (provider?.apiKeyEnv) delete env[provider.apiKeyEnv];
  return env;
}
