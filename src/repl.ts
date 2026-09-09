// The interactive prompt: type a goal to run it, slash-commands for everything else. The run itself
// looks exactly like `dulger run`; between runs you decide whether the result merges into your branch.
import { loadConfig, type Config } from './config.ts';
import * as store from './board/store.ts';
import { createBoard } from './board/create.ts';
import * as git from './git/worktree.ts';
import { ask } from './ui/prompt.ts';
import { bold, cyan, dim, green, red, yellow } from './ui/ansi.ts';
import { CliError, clean, latestRun, memoryCommand, mergeRun, resumeRun, runBoard, showBoard, showReport, showRuns } from './commands.ts';
import type { HarnessName } from './types.ts';

export interface Session {
  overrides: Partial<Config>;
  model?: string;
  yes: boolean;
  quiet: boolean;
  allowDirty: boolean;
}

const HELP = `Type a goal to plan and run it. Commands:
  /board [runId]      print a run's board (latest when omitted)
  /report [runId]     print what a run landed
  /runs               list runs
  /resume [runId]     continue an interrupted run
  /merge [runId]      merge a run's result branch into the current branch
  /memory [list|add "<text>"|rm <id>|compact|path]
  /clean              remove leftover worktrees and wip branches
  /set <key> <value>  harness claude|codex|fake · concurrency <n> · attempts <n> · replans <n>
                      model <name>|off · docs on|off · yes on|off · quiet on|off · dirty on|off
  /status             show the current settings
  /help               this text
  /quit               leave (Ctrl-D too; Ctrl-C during a run stops the agents and comes back here)`;

export async function repl(repoRoot: string, session: Session, version: string): Promise<void> {
  const config = () => {
    const c = loadConfig(repoRoot, session.overrides);
    if (session.model) for (const role of ['planner', 'worker', 'checker', 'docs'] as const) c.roles[role] = { ...c.roles[role], model: session.model };
    return c;
  };
  console.log(`${bold(cyan('dulger'))} ${dim(version)}  ${dim(repoRoot)} ${dim('on')} ${git.currentBranch(repoRoot)}`);
  console.log(dim(`${settingsLine(session, config())}\ntype a goal, or /help`));

  while (true) {
    const line = await ask(`\n${bold(cyan('dulger'))} ${dim('›')} `);
    if (line === undefined) break;
    const text = line.trim();
    if (!text) continue;
    try {
      if (text.startsWith('/')) {
        if (await command(text, repoRoot, session, config)) break;
      } else {
        await goal(text, repoRoot, session, config());
      }
    } catch (err) {
      console.error(red('error: ') + (err instanceof CliError ? err.message : ((err as Error).stack ?? String(err))));
    }
  }
  console.log(dim('bye'));
}

async function goal(text: string, repoRoot: string, session: Session, config: Config): Promise<void> {
  if (!session.allowDirty && !git.isClean(repoRoot)) throw new CliError('working tree has uncommitted changes (commit them, or /set dirty on)');
  const board = createBoard(repoRoot, text);
  const r = await runBoard(repoRoot, board, config, { yes: session.yes, quiet: session.quiet, merge: false, fresh: true, interactive: true });
  if (r.aborted) { console.log(dim(`run ${board.runId} stopped; /resume continues it`)); return; }
  if (r.landed > 0) await offerMerge(repoRoot, board.runId, board.runBranch);
}

async function offerMerge(repoRoot: string, runId: string, runBranch: string): Promise<void> {
  const branch = git.currentBranch(repoRoot);
  const answer = await ask(`\nMerge ${green(runBranch)} into ${bold(branch)}? ${dim('[Y/n]')} `);
  if (answer === undefined || /^\s*n/i.test(answer)) { console.log(dim(`left on ${runBranch}; /merge ${runId} does it later`)); return; }
  mergeRun(repoRoot, runId);
}

/** Returns true when the prompt should end. */
async function command(text: string, repoRoot: string, session: Session, config: () => Config): Promise<boolean> {
  const [cmd = '', ...args] = text.slice(1).split(/\s+/);
  const rest = text.slice(1 + cmd.length).trim();
  switch (cmd) {
    case 'q': case 'quit': case 'exit': return true;
    case 'help': case '?': console.log(HELP); return false;
    case 'status': console.log(settingsLine(session, config())); return false;
    case 'board': showBoard(repoRoot, args[0]); return false;
    case 'report': showReport(repoRoot, args[0]); return false;
    case 'runs': showRuns(repoRoot); return false;
    case 'resume': {
      const r = await resumeRun(repoRoot, config(), args[0], { quiet: session.quiet, merge: false, interactive: true });
      if (!r.aborted && r.landed > 0) {
        const board = store.loadBoard(repoRoot, latestRun(repoRoot, args[0]));
        await offerMerge(repoRoot, board.runId, board.runBranch);
      }
      return false;
    }
    case 'merge': mergeRun(repoRoot, args[0]); return false;
    case 'clean': clean(repoRoot); return false;
    case 'memory': {
      const m = rest.match(/^(\w+)?\s*(?:"([^"]*)"|(.*))?$/);
      const sub = m?.[1] ?? 'list';
      const arg = m?.[2] ?? m?.[3]?.trim();
      memoryCommand(repoRoot, config(), sub, arg ? [arg] : []);
      return false;
    }
    case 'set': set(session, args[0], args.slice(1).join(' ')); console.log(dim(settingsLine(session, config()))); return false;
    default: throw new CliError(`unknown command /${cmd} (try /help)`);
  }
}

function set(session: Session, key = '', value = ''): void {
  const on = (v: string) => { if (!/^(on|off|true|false|yes|no)$/i.test(v)) throw new CliError(`${key} takes on or off`); return /^(on|true|yes)$/i.test(v); };
  const num = (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new CliError(`${key} takes a whole number`); return n; };
  switch (key) {
    case 'harness':
      if (!['claude', 'codex', 'fake'].includes(value)) throw new CliError('harness is claude, codex or fake');
      session.overrides.harness = value as HarnessName; return;
    case 'concurrency': session.overrides.concurrency = Math.max(1, num(value)); return;
    case 'attempts': session.overrides.maxAttempts = Math.max(1, num(value)); return;
    case 'replans': session.overrides.maxReplans = num(value); return;
    case 'model': session.model = value && value !== 'off' ? value : undefined; return;
    case 'docs': session.overrides.docs = on(value); return;
    case 'yes': session.yes = on(value); return;
    case 'quiet': session.quiet = on(value); return;
    case 'dirty': session.allowDirty = on(value); return;
    default: throw new CliError(`unknown setting "${key}" (see /help)`);
  }
}

function settingsLine(s: Session, c: Config): string {
  const flags = [s.yes && 'yes', s.quiet && 'quiet', s.allowDirty && 'dirty', !c.docs && 'no-docs'].filter(Boolean).join(' ');
  return `harness ${c.harness} · concurrency ${c.concurrency} · attempts ${c.maxAttempts} · replans ${c.maxReplans} · model ${s.model ?? 'default'}${flags ? yellow(` · ${flags}`) : ''}`;
}
