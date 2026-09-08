#!/usr/bin/env node
// usta — command line entry point.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, STATE_DIR, type Config } from './config.ts';
import * as store from './board/store.ts';
import * as git from './git/worktree.ts';
import { createBoard, createOrchestrator } from './runner/orchestrator.ts';
import { createLiveView, renderBoard, type LiveView } from './ui/table.ts';
import { bold, cyan, dim, green, red, yellow, fmtCost, cursor } from './ui/ansi.ts';
import type { Board, HarnessName } from './types.ts';

const USAGE = `usta — multi-agent kanban orchestrator (wraps Claude Code / Codex)

Usage:
  usta run "<goal>" [options]     plan a board for the goal, then execute it
  usta resume <runId> [options]   continue an interrupted run
  usta board [runId]              print a run's board (latest when omitted)
  usta runs                       list runs
  usta clean                      remove leftover worktrees and wip branches

Options:
  --harness <claude|codex|fake>   backend for all roles (default: claude)
  --concurrency <n>               parallel cards (default: 3)
  --max-attempts <n>              checker retries per card (default: 2)
  --model <name>                  model for all roles
  --yes                           skip the board approval pause
  --no-docs                       skip the documentation agent
  --merge                         merge the result branch into the current branch when done
  --allow-dirty                   run even with uncommitted changes
  --repo <path>                   repository to work in (default: cwd)
  --quiet                         no live table, log lines only

Per-role overrides live in <repo>/.usta/config.json, e.g.
  { "roles": { "planner": { "harness": "claude", "model": "opus" }, "worker": { "harness": "codex" } } }`;

function fail(msg: string): never {
  console.error(red('error: ') + msg);
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      harness: { type: 'string' }, concurrency: { type: 'string' }, 'max-attempts': { type: 'string' }, model: { type: 'string' },
      yes: { type: 'boolean', short: 'y' }, 'no-docs': { type: 'boolean' }, merge: { type: 'boolean' }, 'allow-dirty': { type: 'boolean' },
      repo: { type: 'string' }, quiet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  if (v.help || !cmd) { console.log(USAGE); return; }

  const repoRoot = git.repoRoot(v.repo ?? process.cwd());
  const overrides: Partial<Config> = {};
  if (v.harness) overrides.harness = v.harness as HarnessName;
  if (v.concurrency) overrides.concurrency = Number(v.concurrency);
  if (v['max-attempts']) overrides.maxAttempts = Number(v['max-attempts']);
  if (v['no-docs']) overrides.docs = false;
  const config = loadConfig(repoRoot, overrides);
  if (v.model) for (const role of ['planner', 'worker', 'checker', 'docs'] as const) config.roles[role] = { ...config.roles[role], model: v.model };

  switch (cmd) {
    case 'run': {
      if (!arg) fail('usta run needs a goal, e.g. usta run "add a /health endpoint"');
      if (!v['allow-dirty'] && !git.isClean(repoRoot)) fail('working tree has uncommitted changes (commit them or pass --allow-dirty)');
      const board = createBoard(repoRoot, arg);
      await runBoard(repoRoot, board, config, { yes: Boolean(v.yes), quiet: Boolean(v.quiet), merge: Boolean(v.merge), fresh: true });
      break;
    }
    case 'resume': {
      const runId = arg ?? store.listRuns(repoRoot).at(-1);
      if (!runId) fail('no runs found');
      const board = store.loadBoard(repoRoot, runId);
      let reset = 0;
      for (const c of board.cards) {
        if (c.status === 'in_progress' || c.status === 'review') { c.status = 'backlog'; c.tasks.forEach((t) => { if (t.status !== 'done') t.status = 'pending'; }); reset++; }
      }
      if (board.docs?.status === 'running') board.docs = { status: 'pending' };
      if (reset) console.log(yellow(`reset ${reset} interrupted card(s) to backlog (their worktrees are reused if present)`));
      await runBoard(repoRoot, board, config, { yes: true, quiet: Boolean(v.quiet), merge: Boolean(v.merge), fresh: false });
      break;
    }
    case 'board': {
      const runId = arg ?? store.listRuns(repoRoot).at(-1);
      if (!runId) fail('no runs found');
      printBoard(store.loadBoard(repoRoot, runId));
      break;
    }
    case 'runs': {
      for (const id of store.listRuns(repoRoot)) {
        const b = store.loadBoard(repoRoot, id);
        const done = b.cards.filter((c) => c.status === 'done').length;
        console.log(`${id}  ${done}/${b.cards.length} done  ${fmtCost(b.costUsd)}  ${dim(b.goal)}`);
      }
      break;
    }
    case 'clean': {
      const dir = join(repoRoot, STATE_DIR, 'worktrees');
      if (existsSync(dir)) for (const d of readdirSync(dir)) { git.removeWorktree(repoRoot, join(dir, d)); console.log(`removed worktree ${d}`); }
      const wip = git.git(repoRoot, ['branch', '--list', 'usta-wip/*', '--format=%(refname:short)'], { allowFail: true }).split('\n').filter(Boolean);
      for (const b of wip) { git.git(repoRoot, ['branch', '-D', b], { allowFail: true }); console.log(`deleted branch ${b}`); }
      break;
    }
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

async function runBoard(repoRoot: string, board: Board, config: Config, o: { yes: boolean; quiet: boolean; merge: boolean; fresh: boolean }): Promise<void> {
  console.log(`${bold(cyan('usta'))} run ${board.runId} on ${dim(repoRoot)} (harness: ${config.harness}, concurrency: ${config.concurrency})`);
  const quiet = o.quiet || !process.stdout.isTTY;
  let view: LiveView | undefined;
  const log = (msg: string) => (view ? view.note(msg) : console.log(`${dim(new Date().toISOString().slice(11, 19))} ${msg}`));
  const orch = createOrchestrator(repoRoot, board, config, { log, onBoardChange: () => view?.update() });
  const agents = () => orch.registry.statuses.values();
  if (!quiet) view = createLiveView(() => board, agents);

  const onSigint = () => {
    log(red('interrupted — stopping agents, saving board…'));
    orch.abort();
    setTimeout(() => process.exit(130), 3000).unref();
  };
  process.once('SIGINT', onSigint);

  try {
    if (o.fresh) {
      await orch.plan();
      view?.stop();
      view = undefined;
      printBoard(board);
      if (!o.yes) {
        const path = store.boardPath(repoRoot, board.runId);
        console.log(`\nEdit ${cyan(path)} if you like, then press ${bold('Enter')} to dispatch (Ctrl-C to abort).`);
        await waitForEnter();
        const edited = store.loadBoard(repoRoot, board.runId);
        board.cards = edited.cards;
        if (!process.stdout.isTTY) console.log('(non-interactive: continuing)');
      }
      if (!quiet) view = createLiveView(() => board, agents);
    }
    await orch.execute();
  } finally {
    view?.stop();
    process.off('SIGINT', onSigint);
  }

  console.log();
  printBoard(board);
  const done = board.cards.filter((c) => c.status === 'done').length;
  console.log(`\n${done}/${board.cards.length} cards merged, docs: ${board.docs?.status ?? 'n/a'}, cost ${fmtCost(board.costUsd)}`);
  const failed = board.cards.filter((c) => c.status !== 'done');
  for (const c of failed) console.log(red(`  ${c.id} ${c.status}: ${c.feedback.at(-1) ?? ''}`));
  console.log(`\nResult branch: ${green(board.runBranch)}`);
  if (o.merge && done > 0) {
    git.git(repoRoot, ['merge', '--no-edit', board.runBranch]);
    console.log(green(`merged ${board.runBranch} into ${git.currentBranch(repoRoot)}`));
  } else if (done > 0) {
    console.log(`  git merge ${board.runBranch}     # or: git diff ${board.baseBranch}...${board.runBranch}`);
  }
  if (failed.length) console.log(`  usta resume ${board.runId}      # retry after fixing; failed worktrees kept in ${STATE_DIR}/worktrees/`);
}

function printBoard(board: Board): void {
  console.log(bold(`Board ${board.runId}`) + dim(`  goal: ${board.goal}`));
  console.log(renderBoard(board, Math.max(60, process.stdout.columns ?? 100)).join('\n'));
  for (const c of board.cards) {
    const deps = c.dependsOn.length ? dim(` after ${c.dependsOn.join(',')}`) : '';
    console.log(`  ${bold(c.id)} ${c.title}${deps}`);
    for (const t of c.tasks) console.log(dim(`     ${t.id} ${t.title}`));
  }
}

function waitForEnter(): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });
}

if (process.stdout.isTTY) process.on('exit', () => process.stdout.write(cursor.show));
main(process.argv.slice(2)).catch((err) => fail((err as Error).stack ?? String(err)));
