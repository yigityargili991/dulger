#!/usr/bin/env node
// dulger — command line entry point.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, STATE_DIR, type Config } from './config.ts';
import * as store from './board/store.ts';
import { resetInterrupted } from './board/scheduler.ts';
import * as git from './git/worktree.ts';
import { createOrchestrator } from './runner/orchestrator.ts';
import { createBoard } from './board/create.ts';
import { extractPaths, openMemory, type Learning } from './context/memory.ts';
import { worktreesDir } from './paths.ts';
import { createLiveView, renderBoard, type LiveView } from './ui/table.ts';
import { bold, cyan, dim, green, red, yellow, fmtSpend, cursor } from './ui/ansi.ts';
import type { Board, HarnessName } from './types.ts';

const USAGE = `dulger — multi-agent kanban orchestrator (wraps Claude Code / Codex)

Usage:
  dulger run "<goal>" [options]     plan a board for the goal, then execute it
  dulger resume <runId> [options]   continue an interrupted run
  dulger board [runId]              print a run's board (latest when omitted)
  dulger runs                       list runs
  dulger clean                      remove leftover worktrees and wip branches
  dulger memory [list]              show what agents learned about this repo
  dulger memory add "<text>"        record a learning by hand
  dulger memory rm <id>             delete a learning
  dulger memory compact             drop learnings about files that no longer exist
  dulger memory path                print the memory file's location

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

function fail(msg: string): never {
  console.error(red('error: ') + msg);
  process.exit(1);
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
  if (v.help || !cmd) { console.log(USAGE); return; }

  const repoRoot = git.repoRoot(v.repo ?? process.cwd());
  const overrides: Partial<Config> = {};
  if (v.harness) overrides.harness = v.harness as HarnessName;
  if (v.concurrency) overrides.concurrency = Number(v.concurrency);
  if (v['max-attempts']) overrides.maxAttempts = Number(v['max-attempts']);
  if (v['max-replans']) overrides.maxReplans = Number(v['max-replans']);
  if (v['no-docs']) overrides.docs = false;
  const config = loadConfig(repoRoot, overrides);
  if (v.model) for (const role of ['planner', 'worker', 'checker', 'docs'] as const) config.roles[role] = { ...config.roles[role], model: v.model };

  switch (cmd) {
    case 'run': {
      if (!arg) fail('dulger run needs a goal, e.g. dulger run "add a /health endpoint"');
      if (!v['allow-dirty'] && !git.isClean(repoRoot)) fail('working tree has uncommitted changes (commit them or pass --allow-dirty)');
      const board = createBoard(repoRoot, arg);
      await runBoard(repoRoot, board, config, { yes: Boolean(v.yes), quiet: Boolean(v.quiet), merge: Boolean(v.merge), fresh: true });
      break;
    }
    case 'resume': {
      const runId = arg ?? store.listRuns(repoRoot).at(-1);
      if (!runId) fail('no runs found');
      const board = store.loadBoard(repoRoot, runId);
      const reset = resetInterrupted(board);
      if (reset.length) console.log(yellow(`reset ${reset.length} interrupted card(s) to backlog (their worktrees are reused if present)`));
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
        console.log(`${id}  ${done}/${b.cards.length} done  ${fmtSpend(b)}  ${dim(b.goal)}`);
      }
      break;
    }
    case 'clean': {
      for (const w of git.listWorktrees(repoRoot).filter((w) => w.branch?.startsWith('dulger-wip/'))) {
        git.removeWorktree(repoRoot, w.path);
        console.log(`removed worktree ${w.path} (${w.branch})`);
      }
      for (const dir of [worktreesDir(repoRoot), join(repoRoot, STATE_DIR, 'worktrees')]) {
        if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); console.log(`removed ${dir}`); }
      }
      const wip = git.git(repoRoot, ['branch', '--list', 'dulger-wip/*', '--format=%(refname:short)'], { allowFail: true }).split('\n').filter(Boolean);
      for (const b of wip) { git.git(repoRoot, ['branch', '-D', b], { allowFail: true }); console.log(`deleted branch ${b}`); }
      break;
    }
    case 'memory':
      memoryCommand(repoRoot, config, arg ?? 'list', positionals.slice(2));
      break;
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

async function runBoard(repoRoot: string, board: Board, config: Config, o: { yes: boolean; quiet: boolean; merge: boolean; fresh: boolean }): Promise<void> {
  console.log(`${bold(cyan('dulger'))} run ${board.runId} on ${dim(repoRoot)} (harness: ${config.harness}, concurrency: ${config.concurrency})`);
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
  const total = board.cards.filter((c) => c.status !== 'replaced').length;
  console.log(`\n${done}/${total} cards merged, docs: ${board.docs?.status ?? 'n/a'}, spent ${fmtSpend(board)}`);
  const failed = board.cards.filter((c) => c.status !== 'done' && c.status !== 'replaced');
  for (const c of failed) console.log(red(`  ${c.id} ${c.status}: ${c.feedback.at(-1) ?? ''}`));
  console.log(`\nResult branch: ${green(board.runBranch)}`);
  if (o.merge && done > 0) {
    git.git(repoRoot, ['merge', '--no-edit', board.runBranch]);
    console.log(green(`merged ${board.runBranch} into ${git.currentBranch(repoRoot)}`));
  } else if (done > 0) {
    console.log(`  git merge ${board.runBranch}     # or: git diff ${board.baseBranch}...${board.runBranch}`);
  }
  if (failed.length) console.log(`  dulger resume ${board.runId}      # retry after fixing; failed worktrees kept in ${join(worktreesDir(repoRoot), board.runId)}/`);
}

function memoryCommand(repoRoot: string, config: Config, sub: string, args: string[]): void {
  const memory = openMemory(repoRoot, config.memory);
  switch (sub) {
    case 'list': {
      const items = memory.load();
      if (items.length === 0) { console.log(dim(`no learnings yet (${memory.path})`)); return; }
      for (const l of items) console.log(formatLearning(l));
      console.log(dim(`\n${items.length} learning(s) in ${memory.path}`));
      return;
    }
    case 'add': {
      const text = args[0];
      if (!text) fail('dulger memory add needs a text');
      const added = memory.add([{ text, files: extractPaths(text, repoRoot), runId: 'manual', cardId: 'manual', harness: config.harness }]);
      console.log(added.length ? green(`added ${added[0]!.id}`) : yellow('already known'));
      return;
    }
    case 'rm': {
      const id = args[0];
      if (!id) fail('dulger memory rm needs an id');
      console.log(memory.remove(id) ? green(`removed ${id}`) : yellow(`no learning with id ${id}`));
      return;
    }
    case 'compact': {
      const { kept, dropped } = memory.compact(repoRoot);
      for (const l of dropped) console.log(dim(`dropped ${l.id}: ${l.text}`));
      console.log(`${kept} kept, ${dropped.length} dropped`);
      return;
    }
    case 'path':
      console.log(memory.path);
      return;
    default:
      fail(`unknown memory command "${sub}"`);
  }
}

function formatLearning(l: Learning): string {
  const meta = dim(`${l.lastSeenAt.slice(0, 10)} ×${l.seen} ${l.runId}/${l.cardId}`);
  const files = l.files.slice(0, 3).join(', ') + (l.files.length > 3 ? ', …' : '');
  return `${cyan(l.id)} ${meta}\n  ${l.text}${files ? dim(`  [${files}]`) : ''}`;
}

function printBoard(board: Board): void {
  console.log(bold(`Board ${board.runId}`) + dim(`  goal: ${board.goal}`));
  console.log(renderBoard(board, Math.max(60, process.stdout.columns ?? 100)).join('\n'));
  for (const c of board.cards) {
    const deps = c.dependsOn.length ? dim(` after ${c.dependsOn.join(',')}`) : '';
    console.log(`  ${bold(c.id)} ${c.title}${deps}`);
    for (const t of c.tasks) console.log(dim(`     ${t.id} ${t.title}`));
    for (const n of c.reviewNotes ?? []) console.log(yellow(`     note: ${n}`));
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
