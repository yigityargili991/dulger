#!/usr/bin/env node
// dulger — command line entry point.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { loadConfig, type Config } from './config.ts';
import * as git from './git/worktree.ts';
import { createBoard } from './board/create.ts';
import { CliError, clean, memoryCommand, orderRun, resumeRun, runBoard, showBoard, showReport, showRuns } from './commands.ts';
import { repl } from './repl.ts';
import { red, cursor } from './ui/ansi.ts';
import type { HarnessName } from './types.ts';

const USAGE = `dulger — multi-agent kanban orchestrator (wraps Claude Code / Codex)

Usage:
  dulger                          interactive prompt: type goals, /help for commands
  dulger run "<goal>" [options]   plan a board for the goal, then execute it
  dulger order "<goal>" [options] plan in a conversation with the planner, then execute
  dulger resume <runId> [options] continue an interrupted run
  dulger board [runId]            print a run's board (latest when omitted)
  dulger report [runId]           print what a run landed (latest when omitted)
  dulger runs                     list runs
  dulger clean                    remove leftover worktrees and wip branches
  dulger memory [list]            show what agents learned about this repo
  dulger memory add "<text>"      record a learning by hand
  dulger memory rm <id>           delete a learning
  dulger memory compact           drop learnings about files that no longer exist
  dulger memory path              print the memory file's location

Options:
  --harness <claude|codex|fake>   backend for all roles (default: claude)
  --concurrency <n>               parallel cards (default: 3)
  --max-attempts <n>              review rounds per card (default: 2)
  --max-replans <n>               replans after a card failed (default: 1)
  --model <name>                  model for all roles
  --yes                           skip the board approval pause
  --no-docs                       skip the documentation agent
  --merge                         merge the result branch into the current branch when done
  --allow-dirty                   run even with uncommitted changes
  --repo <path>                   repository to work in (default: cwd)
  --quiet                         no live table, log lines only
  --version                       print dulger's version

Per-role overrides live in <repo>/.dulger/config.json, e.g.
  { "roles": { "planner": { "harness": "claude", "model": "opus" }, "worker": { "harness": "codex" } } }`;

function packageVersion(): string {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      harness: { type: 'string' }, concurrency: { type: 'string' }, 'max-attempts': { type: 'string' }, 'max-replans': { type: 'string' }, model: { type: 'string' },
      yes: { type: 'boolean', short: 'y' }, 'no-docs': { type: 'boolean' }, merge: { type: 'boolean' }, 'allow-dirty': { type: 'boolean' },
      repo: { type: 'string' }, quiet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
    },
  });
  const [cmd, arg] = positionals;
  if (v.version) { console.log(packageVersion()); return; }
  if (v.help) { console.log(USAGE); return; }
  if (!cmd && !(process.stdin.isTTY && process.stdout.isTTY)) { console.log(USAGE); return; }

  const repoRoot = git.repoRoot(v.repo ?? process.cwd());
  const overrides: Partial<Config> = {};
  if (v.harness) overrides.harness = v.harness as HarnessName;
  if (v.concurrency) overrides.concurrency = Number(v.concurrency);
  if (v['max-attempts']) overrides.maxAttempts = Number(v['max-attempts']);
  if (v['max-replans']) overrides.maxReplans = Number(v['max-replans']);
  if (v['no-docs']) overrides.docs = false;
  const config = loadConfig(repoRoot, overrides);
  if (v.model) for (const role of ['planner', 'worker', 'checker', 'docs'] as const) config.roles[role] = { ...config.roles[role], model: v.model };
  const runOpts = { quiet: Boolean(v.quiet), merge: Boolean(v.merge) };

  switch (cmd) {
    case undefined:
      await repl(repoRoot, { overrides, model: v.model, yes: Boolean(v.yes), quiet: Boolean(v.quiet), allowDirty: Boolean(v['allow-dirty']) }, packageVersion());
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
    case 'resume': {
      const r = await resumeRun(repoRoot, config, arg, runOpts);
      if (r.aborted) process.exitCode = 130;
      break;
    }
    case 'board': showBoard(repoRoot, arg); break;
    case 'report': showReport(repoRoot, arg); break;
    case 'runs': showRuns(repoRoot); break;
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
