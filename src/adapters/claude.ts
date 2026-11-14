import { CLAUDE_CAPABILITIES } from './capabilities.ts';
// Adapter for Claude Code: `claude -p ... --output-format stream-json`.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sandboxNote } from '../roles/prompts.ts';
import type { AgentEvent, RateLimits, Usage } from '../types.ts';
import type { Adapter, AdapterResult, AdapterRunOptions } from './types.ts';
import { spawnLines, tryParseJson, extractJson } from './process.ts';

const READONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const PROBES = ['cargo --version', 'rustc --version', 'node --version', 'npm --version', 'python --version', 'python3 --version', 'go version', 'git --version'];
const READONLY_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git status *)', 'Bash(git status)', 'Bash(ls *)', 'Bash(cat *)', ...PROBES.map((p) => `Bash(${p})`)];
/** Claude Code's own Bash sandbox is bubblewrap too, and bubblewrap cannot start inside dulger's. */
const INNER_SANDBOX_OFF = '{"sandbox":{"enabled":false}}';

/**
 * The prompt goes on stdin; argv strings are capped at 128 KiB. `sandboxed`: the call runs in dulger's
 * sandbox, `writable` when its cwd is a worktree it may write.
 */
export function buildClaudeArgs(opts: AdapterRunOptions, sandboxed?: { writable: boolean }): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  // Read-only agents get a restricted tool set without ToolSearch, so every MCP tool schema would be inlined
  // (~70k tokens per agent) for tools their permission mode would deny anyway. Write agents defer MCP tools
  // behind ToolSearch, which costs about a thousand tokens, so they get the user's servers unless configured off.
  if (!opts.mcp || opts.access !== 'write') args.push('--strict-mcp-config');
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  else args.push('--append-system-prompt', sandboxed ? `${opts.systemPrompt}\n\n${sandboxNote(sandboxed.writable)}` : opts.systemPrompt);
  if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (sandboxed) args.push('--settings', INNER_SANDBOX_OFF);
  if (opts.access === 'write') {
    args.push('--permission-mode', 'bypassPermissions');
  } else if (opts.access === 'none') {
    args.push('--permission-mode', 'dontAsk', '--tools', '', '--disable-slash-commands', '--settings', '{"disableAllHooks":true}');
  } else {
    const allowed = [...READONLY_ALLOWED];
    for (const cmd of opts.allowedCommands ?? []) allowed.push(`Bash(${cmd})`, `Bash(${cmd} *)`);
    // A `*` in a rule is a wildcard, so a command containing one cannot be allowed exactly; it is left out.
    for (const cmd of opts.exactCommands ?? []) if (!cmd.includes('*')) allowed.push(`Bash(${cmd})`);
    args.push('--permission-mode', 'dontAsk', '--tools', READONLY_TOOLS.join(','), '--allowedTools', allowed.join(','));
  }
  return args;
}

/**
 * A parser for one Claude Code stream-json session. It keeps state because Claude Code emits one
 * `assistant` line per content block: a turn is counted when the message id changes, not per line.
 */
export function createClaudeParser(): (line: string) => AgentEvent[] {
  let lastMessageId: string | undefined;
  const commands = new Map<string, string>(); // tool_use id -> Bash command, to name what a denial refused
  return (line) => {
    const o = tryParseJson(line);
    if (!o) return [];
    switch (o.type) {
      case 'system':
        return initEvents(o);
      case 'assistant': {
        const id = (o.message as { id?: unknown } | undefined)?.id;
        const newMessage = typeof id !== 'string' || id !== lastMessageId;
        if (typeof id === 'string') lastMessageId = id;
        return assistantEvents(o, newMessage, commands);
      }
      case 'user':
        return toolResultEvents(o, commands);
      case 'result':
        return resultEvents(o);
      case 'rate_limit_event':
        return rateLimitEvents(o);
      default:
        return [];
    }
  };
}

function initEvents(o: Record<string, unknown>): AgentEvent[] {
  if (o.subtype === 'thinking_tokens') return [{ type: 'thinking' }];
  if (o.subtype !== 'init') return [];
  if (typeof o.session_id !== 'string') return [{ type: 'warning', text: 'init event has no session_id; this session cannot be resumed (stream-json format changed?)' }];
  return [{ type: 'init', sessionId: o.session_id }];
}

function assistantEvents(o: Record<string, unknown>, newMessage: boolean, commands: Map<string, string>): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of contentBlocks(o)) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) events.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({ type: 'tool', name: block.name, input: block.input });
      const command = (block.input as { command?: unknown } | undefined)?.command;
      if (block.name === 'Bash' && typeof block.id === 'string' && typeof command === 'string') commands.set(block.id, command);
    }
  }
  if (newMessage) events.push({ type: 'turn' });
  return events;
}

/** One event per tool result, preceded by a `denied` event when the harness refused the command; a `user` line that echoes a prompt has none. */
function toolResultEvents(o: Record<string, unknown>, commands: Map<string, string>): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const b of contentBlocks(o)) {
    if (b.type !== 'tool_result') continue;
    const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
    if (b.is_error === true && DENIED.test(resultText(b.content))) events.push({ type: 'denied', command: (id && commands.get(id)) || 'a command' });
    events.push({ type: 'tool_result' });
  }
  return events;
}

const DENIED = /permission to use \w+ has been denied|permission denied|not in the allowed/i;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : '')).join(' ');
  return '';
}

function resultEvents(o: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = [];
  const usage = o.usage && typeof o.usage === 'object' ? (o.usage as Record<string, unknown>) : undefined;
  const costUsd = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined;
  if (costUsd === undefined && !usage) events.push({ type: 'warning', text: 'result event has neither total_cost_usd nor usage; spend will read as unknown (stream-json format changed?)' });
  const text = typeof o.result === 'string' ? o.result : '';
  const isError = o.is_error === true;
  events.push({
    type: 'result',
    costUsd,
    usage: usage && claudeUsage(usage),
    output: o.structured_output,
    text,
    isError,
    error: isError ? text || JSON.stringify(o.errors ?? o.subtype ?? 'unknown error') : undefined,
  });
  return events;
}

/** `rate_limit_info.unifiedWindows` holds one entry per plan window (five_hour, seven_day) with utilization 0..1. */
function rateLimitEvents(o: Record<string, unknown>): AgentEvent[] {
  const info = o.rate_limit_info && typeof o.rate_limit_info === 'object' ? (o.rate_limit_info as Record<string, unknown>) : undefined;
  const unified = info?.unifiedWindows && typeof info.unifiedWindows === 'object' ? (info.unifiedWindows as Record<string, unknown>) : undefined;
  if (!unified) return [];
  const windows: RateLimits['windows'] = [];
  for (const [name, w] of Object.entries(unified)) {
    const win = w && typeof w === 'object' ? (w as Record<string, unknown>) : undefined;
    if (typeof win?.utilization !== 'number') continue;
    windows.push({ name, utilization: win.utilization, resetsAt: typeof win.resetsAt === 'number' ? new Date(win.resetsAt * 1000).toISOString() : undefined });
  }
  if (!windows.length) return [];
  return [{ type: 'rate_limit', limits: { at: new Date().toISOString(), status: typeof info?.status === 'string' ? info.status : undefined, windows } }];
}

/** Anthropic semantics: input_tokens is the uncached part; cache reads and writes are separate. */
function claudeUsage(u: Record<string, unknown>): Usage {
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return { input: n('input_tokens'), cacheRead: n('cache_read_input_tokens'), cacheWrite: n('cache_creation_input_tokens'), output: n('output_tokens') };
}

function contentBlocks(o: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = (o.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content.filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object') : [];
}

/**
 * The name Claude Code (2.1) gives a working directory under ~/.claude/projects, where it keeps the
 * session transcripts --resume reads: every character but an ASCII letter or digit becomes '-', and a
 * name longer than 200 characters is cut there and followed by a hash of the whole path.
 */
export function claudeProjectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Where a session started in `cwd` keeps its transcript; Claude Code names it after the path with symlinks resolved. */
export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* named as given */ }
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', claudeProjectSlug(real));
}

/**
 * How to spawn one call: through the sandbox when it is active, for every role but the tool-free reporter.
 * Inside, ~/.claude is read-only (Claude Code logs the writes it cannot make and carries on) except the
 * call's own transcript directory, without which there is no --resume and no structured output.
 */
function claudeCommand(opts: AdapterRunOptions): { bin: string; args: string[]; env?: NodeJS.ProcessEnv; transcripts?: string } {
  const bin = process.env.DULGER_CLAUDE_BIN ?? 'claude';
  const sandbox = opts.access !== 'none' && opts.sandbox?.status.active ? opts.sandbox : undefined;
  if (!sandbox) return { bin, args: buildClaudeArgs(opts) };
  const writable = sandbox.writable(opts.cwd);
  const transcripts = claudeProjectDir(opts.cwd);
  // Outside a worktree (the planner, in your checkout) the directory is the one your own sessions there use,
  // and their auto-memory in memory/ is read by every later session: never writable. srt creates a missing
  // write-denied path on the host, and a write grant on a missing path grants nothing, so both exist first.
  const memory = join(transcripts, 'memory');
  mkdirSync(writable ? transcripts : memory, { recursive: true });
  const wrapped = sandbox.wrap('agent', opts.cwd, [bin, ...buildClaudeArgs(opts, { writable })], process.env, { allowWrite: [transcripts], denyWrite: writable ? [] : [memory] });
  if (!wrapped) throw new Error('the sandbox is active but did not wrap the agent');
  return { ...wrapped, transcripts };
}

export const claudeAdapter: Adapter = {
  name: 'claude',
  capabilities: CLAUDE_CAPABILITIES,
  async run(opts): Promise<AdapterResult> {
    let sessionId: string | undefined = opts.resumeSessionId;
    let final: Extract<AgentEvent, { type: 'result' }> | undefined;
    let rateLimits: RateLimits | undefined;
    const warnings: string[] = [];
    const denied: string[] = [];
    const parse = createClaudeParser();
    const command = claudeCommand(opts);

    const { exitCode, stderr } = await spawnLines({
      bin: command.bin,
      args: command.args,
      env: command.env,
      sandboxed: command.transcripts !== undefined,
      stdin: opts.prompt,
      cwd: opts.cwd,
      logFile: opts.logFile,
      signal: opts.signal,
      onLine(line) {
        for (const ev of parse(line)) {
          if (ev.type === 'init') sessionId = ev.sessionId;
          if (ev.type === 'result') final = ev;
          if (ev.type === 'warning') warnings.push(ev.text);
          if (ev.type === 'denied') denied.push(ev.command);
          if (ev.type === 'rate_limit') rateLimits = ev.limits;
          opts.onEvent(ev);
        }
      },
    });

    // A session the sandbox kept from being saved cannot be resumed: a follow-up then starts a new one.
    if (command.transcripts && sessionId && !existsSync(join(command.transcripts, `${sessionId}.jsonl`))) {
      warnings.push(`session ${sessionId} was not saved in ${command.transcripts}, so it cannot be resumed`);
      sessionId = undefined;
    }
    const text = final?.text ?? '';
    const output = final?.output ?? (opts.schema ? extractJson(text) : undefined);
    // Stopped, srt exits 0 after passing the SIGTERM on: the exit code says nothing then.
    const stopped = opts.signal.aborted;
    const ok = !stopped && exitCode === 0 && !final?.isError && (!opts.schema || output !== undefined);
    return {
      ok,
      output,
      text,
      sessionId,
      costUsd: final?.costUsd,
      usage: final?.usage,
      rateLimits,
      warnings: warnings.length ? warnings : undefined,
      denied: denied.length ? denied : undefined,
      exitCode,
      error: ok ? undefined : stopped ? 'aborted' : final?.error || stderr.trim().split('\n').slice(-5).join('\n') || `claude exited with ${exitCode}`,
    };
  },
};
