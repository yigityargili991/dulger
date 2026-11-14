#!/usr/bin/env node
import { preflight, preflightText } from './preflight.ts';
// dulger — command line entry point.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { BUILTIN_HARNESSES, DEFAULT_CONFIG, PROVIDER_DEFAULTS, loadConfig, type Config } from './config.ts';
import * as git from './git/worktree.ts';
import { createBoard } from './board/create.ts';
import { CliError, clean, initRepo, memoryCommand, orderRun, resumeRun, retryRun, runBoard, showBoard, showReport, showRuns } from './commands.ts';
import { repl } from './repl.ts';
import { SANDBOX_MODES, type SandboxMode } from './sandbox.ts';
import { red, cursor } from './ui/ansi.ts';
import type { HarnessName } from './types.ts';

const USAGE = `dulger — multi-agent kanban orchestrator (wraps Claude Code / Codex)

Usage:
  dulger                          choose harness and models, then enter goals (/help for commands)
  dulger init [path]              create a git repository with a first commit, ready for runs
  dulger run "<goal>" [options]   plan a board for the goal, then execute it
  dulger order "<goal>" [options] plan in a conversation with the planner, then execute
  dulger resume <runId> [options] continue an interrupted run
  dulger retry <card> [runId]     give a failed card one more review round, then continue the run
                                  (--max-attempts <n> for more rounds)
  dulger board [runId]            print a run's board (latest when omitted)
  dulger report [runId] [--full]  print what a run landed (latest when omitted; --full: every summary, review and note)
  dulger runs                     list runs
  dulger doctor                   check readiness without a model call
  dulger clean                    remove leftover worktrees and wip branches
  dulger memory [list]            show what agents learned about this repo
  dulger memory add "<text>"      record a learning by hand
  dulger memory rm <id>           delete a learning
  dulger memory compact           drop learnings about files that no longer exist
  dulger memory path              print the memory file's location

Options:
  --harness <name>                backend for all roles: claude, codex, fake, or a providers.<name> entry
                                  (ollama, deepseek, openai built in; default: claude)
  --concurrency <n>               parallel cards (default: 3)
  --max-attempts <n>              review rounds per card (default: 2)
  --max-replans <n>               replans after a card failed (default: 1)
  --model <name>                  pin one model for all roles
  --no-routing                    use harness defaults instead of task tiers
  --base-url <url>                 API base URL for the selected API harness
  --api-key-env <name>             environment variable holding its API key
  --current-settings              resume/retry using current settings instead of the saved run settings
  --yes                           dispatch the plan without reviewing it (needed when not on a terminal);
                                  also accepts the new verify commands a replan adds
  --no-docs                       skip the documentation agent
  --no-progress                   no live progress notes on in-progress cards
  --progress-interval <sec>       how often a lightweight agent notes each running card's progress (default: 120)
  --merge                         merge the result branch into the current branch when done
  --allow-dirty                   run even with uncommitted changes
  --budget <usd>                  stop the run (resumable) once it has spent this much
  --card-budget <usd>             fail a card once it has spent this much
  --sandbox <mode>                off | auto | required: run verify commands, worktree setup and the API
                                  tools' shell in the process sandbox (default: ~/.config/dulger/config.json,
                                  else off; dulger doctor says whether it works here)
  --repo <path>                   repository to work in (default: cwd)
  --quiet                         no full-screen view or live table, log lines only
  --version                       print dulger's version

Per-role overrides live in <repo>/.dulger/config.json, e.g.
  { "roles": { "planner": { "harness": "claude", "model": "opus" }, "worker": { "harness": "codex" } } }
The sandbox policy lives only in your own ~/.config/dulger/config.json ($XDG_CONFIG_HOME), e.g.
  { "sandbox": { "mode": "auto", "domains": { "setup": ["registry.npmjs.org"] } } }`;

function packageVersion(): string {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

function findRepoRoot(dir: string): string {
  try {
    return git.repoRoot(dir);
  } catch (err) {
    if (err instanceof git.GitError && /not a git repository/i.test(err.stderr)) {
      throw new CliError(`${dir} is not inside a git repository (dulger needs one for its branches and worktrees; dulger init sets one up)`);
    }
    throw err;
  }
}

function readConfig(repoRoot: string, overrides: Partial<Config>, sandbox?: SandboxMode): Config {
  try { return loadConfig(repoRoot, overrides, sandbox); } catch (err) { throw new CliError(`config: ${(err as Error).message}`); }
}

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      harness: { type: 'string' }, concurrency: { type: 'string' }, 'max-attempts': { type: 'string' }, 'max-replans': { type: 'string' }, model: { type: 'string' },
      'no-routing': { type: 'boolean' }, 'base-url': { type: 'string' }, 'api-key-env': { type: 'string' },
      budget: { type: 'string' }, 'card-budget': { type: 'string' }, full: { type: 'boolean' },
      'progress-interval': { type: 'string' }, 'no-progress': { type: 'boolean' },
      'current-settings': { type: 'boolean' }, sandbox: { type: 'string' },
      yes: { type: 'boolean', short: 'y' }, 'no-docs': { type: 'boolean' }, merge: { type: 'boolean' }, 'allow-dirty': { type: 'boolean' },
      repo: { type: 'string' }, quiet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
    },
  });
  const [cmd, arg] = positionals;
  if (v.version) { console.log(packageVersion()); return; }
  if (v.help) { console.log(USAGE); return; }
  if (!cmd && !(process.stdin.isTTY && process.stdout.isTTY)) { console.log(USAGE); return; }

  if (cmd === 'init') { initRepo(arg ?? v.repo ?? process.cwd()); return; }
  if (v.sandbox !== undefined && !SANDBOX_MODES.includes(v.sandbox as SandboxMode)) throw new CliError(`--sandbox is ${SANDBOX_MODES.join(', ')}`);
  const sandbox = v.sandbox as SandboxMode | undefined;

  const repoRoot = findRepoRoot(v.repo ?? process.cwd());
  // Runs branch off HEAD, so a repository without a single commit has nothing to work on yet.
  if ((cmd === undefined || cmd === 'run' || cmd === 'order' || cmd === 'resume' || cmd === 'retry') && !git.hasCommits(repoRoot)) {
    throw new CliError(`${repoRoot} has no commits yet; dulger init makes the first one`);
  }
  const overrides: Partial<Config> = {};
  if (v.harness) overrides.harness = v.harness as HarnessName;
  if (v.concurrency) overrides.concurrency = Number(v.concurrency);
  if (v['max-attempts']) overrides.maxAttempts = Number(v['max-attempts']);
  if (v['max-replans']) overrides.maxReplans = Number(v['max-replans']);
  if (v['no-docs']) overrides.docs = false;
  if (v['no-progress']) overrides.progressIntervalSec = 0;
  if (v['progress-interval']) overrides.progressIntervalSec = Number(v['progress-interval']);
  if (v.budget) overrides.budgetUsd = Number(v.budget);
  if (v['card-budget']) overrides.cardBudgetUsd = Number(v['card-budget']);
  if (v['no-routing']) overrides.routing = { ...DEFAULT_CONFIG.routing, enabled: false };
  if (v['base-url'] || v['api-key-env']) {
    // The harness may be a name this repo has never configured: --base-url defines it on the spot.
    const { harness: _named, ...rest } = overrides;
    const loaded = readConfig(repoRoot, rest);
    const name = v.harness ?? loaded.harness;
    const provider = loaded.providers[name];
    if (!provider && !v['base-url']) throw new CliError(`${name} is not a configured API provider; give --base-url to define it`);
    if (!provider && BUILTIN_HARNESSES.includes(name)) throw new CliError(`${name} is a CLI backend; --base-url and --api-key-env apply to API providers`);
    const baseUrl = v['base-url'] ?? provider!.baseUrl;
    overrides.providers = { [name]: { ...PROVIDER_DEFAULTS, ...provider, baseUrl, ...(v['api-key-env'] ? { apiKeyEnv: v['api-key-env'] } : {}) } };
  }
  const config = readConfig(repoRoot, overrides, sandbox);
  if (v.model) for (const role of ['planner', 'worker', 'checker', 'docs', 'reporter'] as const) config.roles[role] = { ...config.roles[role], model: v.model };
  const runOpts = { currentSettings: Boolean(v['current-settings']), quiet: Boolean(v.quiet), merge: Boolean(v.merge), assumeYes: Boolean(v.yes) };

  switch (cmd) {
    case undefined:
      await repl(repoRoot, { overrides, model: v.model, yes: Boolean(v.yes), quiet: Boolean(v.quiet), allowDirty: Boolean(v['allow-dirty']), sandbox }, packageVersion());
      break;
    case 'run': {
      if (!arg) throw new CliError('dulger run needs a goal, e.g. dulger run "add a /health endpoint"');
      if (!v['allow-dirty'] && !git.isClean(repoRoot)) throw new CliError('working tree has uncommitted changes (commit them or pass --allow-dirty)');
      const r = await runBoard(repoRoot, createBoard(repoRoot, arg), config, { ...runOpts, yes: Boolean(v.yes), fresh: true });
      if (r.aborted) process.exitCode = 130;
      break;
    }
    case 'order': {
      if (!arg) throw new CliError('dulger order needs a goal');
      if (!v['allow-dirty'] && !git.isClean(repoRoot)) throw new CliError('working tree has uncommitted changes (commit them or pass --allow-dirty)');
      const r = await orderRun(repoRoot, arg, config, runOpts);
      if (r.aborted) process.exitCode = 130;
      break;
    }
    case 'retry': {
      const r = await retryRun(repoRoot, config, arg, positionals[2], runOpts);
      if (r.aborted) process.exitCode = 130;
      break;
    }
    case 'resume': {
      const r = await resumeRun(repoRoot, config, arg, runOpts);
      if (r.aborted) process.exitCode = 130;
      break;
    }
    case 'board': showBoard(repoRoot, arg); break;
    case 'report': showReport(repoRoot, arg, { full: Boolean(v.full) }); break;
    case 'runs': showRuns(repoRoot); break;
    case 'doctor': {
      const checks = preflight(repoRoot, config);
      console.log(preflightText(checks));
      if (checks.some((c) => c.status === 'error')) process.exitCode = 1;
      break;
    }
    case 'clean': clean(repoRoot); break;
    case 'memory': memoryCommand(repoRoot, config, arg ?? 'list', positionals.slice(2)); break;
    default:
      throw new CliError(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

if (process.stdout.isTTY) process.on('exit', () => process.stdout.write(cursor.show));
main(process.argv.slice(2)).catch((err) => {
  console.error(red('error: ') + (err instanceof CliError ? err.message : ((err as Error).stack ?? String(err))));
  process.exit(1);
});
