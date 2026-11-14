import { CliError } from './errors.ts';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoSetsSandbox, roleConfig, STATE_DIR, type Config } from './config.ts';
import { sandboxCheck, sandboxStatus, userConfigFile } from './sandbox.ts';
import { getAdapter } from './adapters/index.ts';
import { capabilities } from './adapters/capabilities.ts';
import { keySource } from './keys.ts';
import * as git from './git/worktree.ts';
import { worktreesDir } from './paths.ts';
import { snapshotSettings } from './runSettings.ts';
import type { AgentRole } from './types.ts';

export interface PreflightCheck { label: string; status: 'pass' | 'warning' | 'error'; detail: string }
/** `forRun`: the checks before a run, which asks the sandbox runtime nothing when the sandbox is off. */
export function preflight(root: string, config: Config, o: { forRun?: boolean } = {}): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const add = (label: string, status: PreflightCheck['status'], detail: string) => checks.push({ label, status, detail });
  const check = (label: string, fn: () => string) => { try { add(label, 'pass', fn()); } catch (e) { add(label, 'error', (e as Error).message); } };
  check('Git repository', () => { if (!git.hasCommits(root)) throw new CliError('Create an initial commit with dulger init.'); return `Branch ${git.currentBranch(root)}`; });
  check('Git identity', () => { git.git(root, ['var', 'GIT_COMMITTER_IDENT']); return 'Commit identity available'; });
  if (!git.isClean(root)) add('Working tree', 'warning', 'Uncommitted edits are excluded from agent worktrees. Commit them or explicitly allow a dirty checkout.');
  check('Worktree directory', () => {
    let path = worktreesDir(root);
    while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
    accessSync(path, constants.W_OK | constants.X_OK);
    return 'Parent directory is writable';
  });
  check('Settings', () => {
    snapshotSettings(config);
    for (const key of ['concurrency', 'maxAttempts', 'verifyTimeoutSec', 'stallTimeoutSec'] as const) if (!Number.isFinite(config[key]) || config[key] < 1) throw new CliError(`${key} must be at least 1.`);
    return 'Configuration can be saved with the run';
  });
  const seen = new Set<string>();
  for (const role of ['planner', 'worker', 'checker', 'docs', 'reporter'] as AgentRole[]) {
    if ((role === 'docs' && !config.docs) || (role === 'reporter' && config.progressIntervalSec <= 0)) continue;
    const rc = roleConfig(config, role);
    const caps = capabilities(getAdapter(rc.harness, config));
    if (role === 'reporter' && !caps.toolFree) { add('Progress reporter', 'warning', `${rc.harness} cannot run without tools; progress notes are skipped. Choose a Claude/API reporter.`); continue; }
    const provider = config.providers[rc.harness];
    if (provider && !rc.model) add(`${role} model`, 'error', `Choose a model for ${rc.harness} in /setup.`);
    if (rc.maxBudgetUsd !== undefined && !caps.costReporting) add(`${role} budget`, 'error', `${rc.harness} does not report dollar cost; remove this role's maxBudgetUsd.`);
    if (seen.has(rc.harness)) continue;
    seen.add(rc.harness);
    if (caps.executable) check(rc.harness, () => {
      const r = spawnSync(caps.executable!, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (r.error || r.status !== 0) throw new CliError(`Install ${caps.executable} on PATH and check ${caps.executable} --version.`);
      return `${r.stdout.trim().split('\n')[0]}; account access is checked on the first call`;
    });
    if (provider?.apiKeyEnv) add(`${rc.harness} credentials`, keySource(provider.apiKeyEnv) === 'missing' ? 'error' : 'pass', keySource(provider.apiKeyEnv) === 'missing' ? `Set ${provider.apiKeyEnv} or use /provider ${rc.harness} key.` : `Available through ${provider.apiKeyEnv}; validity is checked on the first call`);
    if (!caps.costReporting && (config.budgetUsd !== undefined || config.cardBudgetUsd !== undefined)) add(`${rc.harness} spend`, 'warning', 'Dollar limits cannot account for this harness. Tokens are still recorded.');
  }
  if (config.worktreeSetup) add('Worktree setup', 'warning', `Will run in each new worktree: ${config.worktreeSetup}`);
  const sandbox = sandboxCheck(sandboxStatus(config.sandbox.mode, { probeOff: !o.forRun }));
  add('Sandbox', sandbox.status, sandbox.detail);
  if (repoSetsSandbox(root)) add('Repository sandbox key', 'warning', `${join(root, STATE_DIR, 'config.json')} sets "sandbox"; it is ignored. The sandbox confines code from the repository, so its policy comes only from ${userConfigFile()}, --sandbox and the session.`);
  return checks;
}
export function preflightText(checks: PreflightCheck[]): string {
  return checks.map((c) => `${c.status === 'pass' ? 'OK' : c.status === 'warning' ? 'NOTE' : 'FIX'} ${c.label}: ${c.detail}`).join('\n');
}
export function requirePreflight(root: string, config: Config): void {
  const checks = preflight(root, config, { forRun: true });
  const errors = checks.filter((c) => c.status === 'error');
  if (errors.length) throw new CliError(`Preflight needs attention:\n${preflightText(errors)}`);
}

/** Card overrides are resolved after planning, before any worker is dispatched. */
export function cardModelIssues(config: Config, cards: import('./types.ts').Card[]): string[] {
  const issues = new Set<string>();
  for (const card of cards) {
    if (['done', 'failed', 'blocked', 'replaced'].includes(card.status)) continue;
    for (const task of card.tasks) {
      const rc = roleConfig(config, 'worker', { card, task });
      const adapter = getAdapter(rc.harness, config);
      const provider = config.providers[rc.harness];
      if (provider && !rc.model) issues.add(`${card.id}: choose a worker model for ${rc.harness}.`);
      if (provider?.apiKeyEnv && keySource(provider.apiKeyEnv) === 'missing') issues.add(`${card.id}: set ${provider.apiKeyEnv} or use /provider ${rc.harness} key.`);
      if (rc.maxBudgetUsd !== undefined && !capabilities(adapter).costReporting) issues.add(`${card.id}: ${rc.harness} cannot enforce maxBudgetUsd; remove the worker role's dollar budget.`);
    }
  }
  return [...issues];
}
