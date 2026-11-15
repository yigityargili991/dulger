import { browseRuns, reviewRun } from './runViews.ts';
import { preflight, preflightText } from './preflight.ts';
import { editPlan } from './planEditor.ts';
import { acquireRunLock } from './board/lock.ts';
import { originalSettings } from './runSettings.ts';
import { pager } from './tui/pager.ts';
// The interactive prompt: type a goal to run it, slash-commands for everything else. The run itself
// looks exactly like `dulger run`; between runs you decide whether the result merges into your branch.
import { harnessNames, type Config, type RoleConfig } from './config.ts';
import * as store from './board/store.ts';
import * as git from './git/worktree.ts';
import { ask } from './ui/prompt.ts';
import { bold, cyan, dim, green, red, yellow } from './ui/ansi.ts';
import { CliError, clean, latestRun, memoryCommand, mergeRun, showBoard, showReport, showRuns } from './commands.ts';
import { MODEL_ALIASES, MODEL_ROLES, configureModel, modelOverview, saveSessionConfig, sessionConfig } from './replModels.ts';
import { KNOWN_PROVIDERS, ensureKeys, providerCommand } from './replProviders.ts';
import { SETTING_KEYS, suggestCommand, type PredictContext } from './replCommands.ts';
import { SESSION_SETTINGS, applySetting, findSetting, formatSetting, parseSetting } from './settings.ts';
import { failedCards, runsByStart } from './runs.ts';
import { runGoal, runOrder, runResume, runRetry } from './sessionRuns.ts';
import { openMemory } from './context/memory.ts';
import { setupSession } from './sessionSetup.ts';
import type { SandboxMode } from './sandbox.ts';
import type { AgentRole } from './types.ts';

export interface Session {
  overrides: Partial<Config>;
  model?: string;
  /** Explicit role choices override a global pin; reset restores the saved role. */
  modelRoles?: Partial<Record<AgentRole, RoleConfig | 'reset'>>;
  yes: boolean;
  quiet: boolean;
  allowDirty: boolean;
  /** --sandbox or /sandbox, over the user's own config file; session-only, never saved to the repository. */
  sandbox?: SandboxMode;
}

const HELP = `This is dulger's line prompt: dulger opens it instead of the full-screen app with --quiet or
when the full-screen view is off in the settings (/tui off, then /config save, keeps it off for the next
start), and the app opens it from its command palette.
Type a goal to plan and run it. Commands:
  /setup              choose the backend, a model set and per-role overrides in a menu
  /order [goal]       plan with the planner in a conversation, then dispatch
  /board [runId]      print a run's board (latest when omitted)
  /report [runId] [full]  print what a run landed (full: every summary, review and note)
  /runs               list runs (with the full-screen view on, a browser with recovery actions and diffs)
  /review [runId]     review changes and verification before merging
  /edit [runId]       edit an unstarted plan
  /doctor             check readiness without a model call
  /resume [runId] [current]  resume with saved settings (current explicitly uses this session)
  /retry <card> [runId]  give a failed card one more review round, then continue the run
  /merge [runId]      merge a run's result branch into the current branch
  /memory [list|add "<text>"|rm <id>|compact|path]
  /clean              remove leftover worktrees and wip branches
  /status             show settings and effective models
  /model              show every role's backend, model and routing
  /model <role>       show one role: planner | worker | checker | docs | reporter
  /model <role> <choice>             e.g. planner fable, worker deepseek, checker sonnet
  /model <role> <harness> [model]    e.g. worker ollama qwen3:8b
  /model <role> auto|reset           unpin on its backend | restore saved settings
  /provider           list the API providers and where their keys come from
  /provider <name>    define or edit one: base URL, the key (not echoed), then pick a model from the endpoint's list
  /provider <name> key   enter or replace just the key      /provider <name> model   re-pick the model
  /config save        persist settings (endpoints, never keys)
Model shorthand: fable, opus, sonnet, haiku, astra, sol, luna.
Role choices override global /model pins. Changes are session-only until /config save.
Settings (each shows its current value when given no argument):
  /harness <name>  (claude, codex, fake, or a configured provider)   /model <name>|off
  /concurrency <n>                  /attempts <n>                 /replans <n>
  /docs on|off                      /yes on|off                   /quiet on|off
  /progress on|off|<sec>            /dirty on|off                 /routing on|off
  /router planner|jev-openrouter|jev-typesafe|jev-local
  /tui on|off                       /icons nerd|unicode|ascii|auto /mouse on|off
  /budget <usd>|off                 /card-budget <usd>|off
  /sandbox off|auto|required (this session; never saved to the repository)
  /set <key> <value>  the same settings in one command
  /help               this text
  /quit               leave (Ctrl-D too), back to the app when it opened this prompt;
                      Ctrl-C during a run stops the agents and comes back here
What the next word can be is shown dim after the cursor; Tab takes it, and when several fit they are listed.`;

export interface ReplOptions {
  /** Opened from the full-screen app with its session: no startup menus, and quitting goes back to the app. */
  nested?: boolean;
}

export async function repl(repoRoot: string, session: Session, version: string, o: ReplOptions = {}): Promise<void> {
  const config = () => sessionConfig(repoRoot, session);
  // No startup menus: on an interactive terminal with the full-screen view on, dulger opens the app,
  // which shows the session and the unfinished runs; the prompt is reached without it (piped, quiet,
  // the view off) or nested in the app, and in none of those would a menu help.
  console.log(`${bold(cyan('dulger'))} ${dim(version)}  ${dim(repoRoot)} ${dim('on')} ${git.currentBranch(repoRoot)}`);
  console.log(dim(`${settingsLine(session, config())}\ntype a goal, or /help${o.nested ? '; /quit or Ctrl-D goes back to the app' : ''}`));

  while (true) {
    const ctx = predictContext(repoRoot, config());
    const line = await ask(`\n${bold(cyan('dulger'))} ${dim('›')} `, { suggest: (text) => suggestCommand(text, ctx) });
    if (line === undefined) break;
    const text = line.trim();
    if (!text) continue;
    try {
      if (text.startsWith('/') || /^(exit|quit|q|help|\?)$/i.test(text)) {
        if (await command(text.startsWith('/') ? text : `/${text}`, repoRoot, session, config)) break;
      } else {
        if (text.split(/\s+/).length < 3) {
          const a = await ask(`Run ${JSON.stringify(text)} as a goal? ${dim('[y/N]')} `);
          if (!a || !/^\s*y/i.test(a)) continue;
        }
        await goal(text, repoRoot, session);
      }
    } catch (err) {
      console.error(red('error: ') + (err instanceof CliError ? err.message : ((err as Error).stack ?? String(err))));
    }
  }
  console.log(dim(o.nested ? 'back to the app' : 'bye'));
}

async function goal(text: string, repoRoot: string, session: Session): Promise<void> {
  const r = await runGoal(repoRoot, session, text);
  if (r.aborted) { console.log(dim(`run ${r.runId} stopped; /resume continues it`)); return; }
  if (r.landed > 0) await offerMerge(repoRoot, r.runId, r.runBranch);
}

async function offerMerge(repoRoot: string, runId: string, runBranch: string): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) { await reviewRun(repoRoot, runId, (id) => mergeRun(repoRoot, id)); return; }
  const branch = git.currentBranch(repoRoot);
  const answer = await ask(`\nMerge ${green(runBranch)} into ${bold(branch)}? ${dim('[Y/n]')} `);
  if (answer === undefined || /^\s*n/i.test(answer)) { console.log(dim(`left on ${runBranch}; /merge ${runId} does it later`)); return; }
  mergeRun(repoRoot, runId);
}

/** Returns true when the prompt should end. */
export async function command(text: string, repoRoot: string, session: Session, config: () => Config = () => sessionConfig(repoRoot, session)): Promise<boolean> {
  const [cmd = '', ...args] = text.slice(1).split(/\s+/);
  const rest = text.slice(1 + cmd.length).trim();
  switch (cmd) {
    case 'q': case 'quit': case 'exit': return true;
    case 'help': case '?': console.log(HELP); return false;
    case 'status': console.log(settingsLine(session, config()) + '\n' + modelOverview(repoRoot, session)); return false;
    case 'setup':
      if (await setupSession(repoRoot, session)) console.log(modelOverview(repoRoot, session));
      else console.log(dim('setup cancelled; settings unchanged'));
      return false;
    case 'provider':
      for (const line of await providerCommand(repoRoot, session, args)) console.log(line);
      return false;
    case 'config':
      if (rest !== 'save') throw new CliError('use /config save to persist the current session settings');
      console.log(green(`saved ${saveSessionConfig(repoRoot, session).join(', ') || 'nothing new'} (${SESSION_ONLY} remain session-only)`));
      return false;
    case 'board': showBoard(repoRoot, args[0]); return false;
    case 'report': {
      const full = args.some((a) => a === 'full' || a === '--full');
      showReport(repoRoot, args.find((a) => a !== 'full' && a !== '--full'), { full });
      return false;
    }
    case 'doctor': await pager('Readiness checks', preflightText(preflight(repoRoot, config(), { allowDirty: session.allowDirty }))); return false;
    case 'review':
      if (!(process.stdin.isTTY && process.stdout.isTTY)) { showReport(repoRoot, args[0], { full: true }); return false; }
      await reviewRun(repoRoot, latestRun(repoRoot, args[0]), (id) => mergeRun(repoRoot, id)); return false;
    case 'edit': {
      const id = latestRun(repoRoot, args[0]);
      const release = acquireRunLock(repoRoot, id);
      try { const board = store.loadBoard(repoRoot, id); await editPlan(repoRoot, board, originalSettings(board, config())); }
      finally { release(); }
      return false;
    }
    case 'runs':
      if (!(process.stdin.isTTY && process.stdout.isTTY) || session.quiet || !config().tui.enabled) showRuns(repoRoot);
      else await browseRuns(repoRoot, {
        resume: async (id) => { await command(`/resume ${id}`, repoRoot, session, config); },
        retry: async (id, card) => { await command(`/retry ${card} ${id}`, repoRoot, session, config); },
        edit: async (id) => { await command(`/edit ${id}`, repoRoot, session, config); },
        merge: (id) => mergeRun(repoRoot, id),
      });
      return false;
    case 'resume': {
      const r = await runResume(repoRoot, session, args[0] === 'current' ? undefined : args[0], { currentSettings: args.includes('current') });
      if (!r.aborted && r.landed > 0) await offerMerge(repoRoot, r.runId, r.runBranch);
      return false;
    }
    case 'retry': {
      const r = await runRetry(repoRoot, session, args[0] ?? '', args[1]);
      if (!r.aborted && r.landed > 0) await offerMerge(repoRoot, r.runId, r.runBranch);
      return false;
    }
    case 'order': {
      let text = rest;
      if (!text) {
        const a = await ask(`What should be built? ${dim('(Ctrl-C to go back)')} `);
        if (!a?.trim()) return false;
        text = a.trim();
      }
      const r = await runOrder(repoRoot, session, text);
      if (!r.aborted && r.landed > 0) await offerMerge(repoRoot, r.runId, r.runBranch);
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
    case 'set':
      if (!args[0]) console.log(settingsLine(session, config()));
      else await setting(repoRoot, session, config, args[0], args.slice(1).join(' '));
      return false;
    default:
      if (SETTING_KEYS.includes(cmd)) { await setting(repoRoot, session, config, cmd, rest); return false; }
      throw new CliError(`unknown command /${cmd} (try /help)`);
  }
}

/** What a line at the prompt can be predicted to want next, as the repository stands right now. */
function predictContext(repoRoot: string, config: Config): PredictContext {
  const providers = [...Object.keys(config.providers), ...KNOWN_PROVIDERS.filter((p) => !(p in config.providers))]
    .filter((p) => !['claude', 'codex', 'fake'].includes(p));
  // By start time, so "the latest run" the prompt predicts is the one a command without an id acts on.
  const runIds = runsByStart(repoRoot);
  return {
    harnesses: harnessNames(config), providers, aliases: MODEL_ALIASES, roles: MODEL_ROLES,
    runIds, cards: failedCardIds(repoRoot, runIds.at(-1)), memory: memoryIds(repoRoot, config),
  };
}

/** Predicted ids come from files that can be missing or half-written; the prompt must work all the same. */
function failedCardIds(repoRoot: string, runId: string | undefined): string[] {
  try {
    return runId ? failedCards(store.loadBoard(repoRoot, runId)).map((c) => c.id) : [];
  } catch {
    return [];
  }
}

function memoryIds(repoRoot: string, config: Config): string[] {
  try {
    return openMemory(repoRoot, config.memory).load().map((l) => l.id);
  } catch {
    return [];
  }
}

/** The settings /config save leaves out, as the confirmation names them: "yes, quiet, dirty and sandbox". */
const SESSION_ONLY = ((keys: string[]) => `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`)(SESSION_SETTINGS.filter((s) => s.scope === 'session').map((s) => s.key));

/** Change a setting, or show its current value when no value is given. */
async function setting(repoRoot: string, session: Session, config: () => Config, key: string, value: string): Promise<void> {
  if (key === 'model') { console.log(configureModel(repoRoot, session, value)); if (process.stdin.isTTY) await ensureKeys(config()); return; }
  if (!value) {
    if (!SETTING_KEYS.includes(key)) throw new CliError(`unknown setting "${key}" (see /help)`);
    console.log(`${key} ${bold(currentValue(session, config(), key))}`);
    return;
  }
  set(session, config(), key, value);
  console.log(dim(settingsLine(session, config())));
  if (key === 'harness' && process.stdin.isTTY) await ensureKeys(config());
}

function currentValue(s: Session, c: Config, key: string): string {
  if (key === 'model') return s.model ?? (c.routing.enabled ? 'auto tiers' : 'default');
  const spec = findSetting(key);
  return spec ? formatSetting(spec.key, spec.read(s, c)) : '?';
}

/** A setting from the words typed after it, through the settings table every other surface uses too. */
function set(session: Session, config: Config, key: string, value: string): void {
  const spec = findSetting(key);
  if (!spec) throw new CliError(`unknown setting "${key}" (see /help)`);
  applySetting(session, config, spec.key, parseSetting(spec.key, value));
}

function settingsLine(s: Session, c: Config): string {
  const flags = [s.yes && 'yes', s.quiet && 'quiet', s.allowDirty && 'dirty', !c.docs && 'no-docs', !c.tui.enabled && 'no-tui', !(c.progressIntervalSec > 0) && 'no-progress'].filter(Boolean).join(' ');
  return `harness ${c.harness} · concurrency ${c.concurrency} · attempts ${c.maxAttempts} · replans ${c.maxReplans} · global model ${s.model ?? (c.routing.enabled ? 'auto tiers' : 'default')} · sandbox ${c.sandbox.mode}${flags ? yellow(` · ${flags}`) : ''}`;
}
