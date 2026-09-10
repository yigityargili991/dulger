// Adapter for Claude Code: `claude -p ... --output-format stream-json`.
import type { AgentEvent, RateLimits, Usage } from '../types.ts';
import type { Adapter, AdapterResult, AdapterRunOptions } from './types.ts';
import { spawnLines, tryParseJson, extractJson } from './process.ts';

const READONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const READONLY_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git status *)', 'Bash(git status)', 'Bash(ls *)', 'Bash(cat *)'];

export function buildClaudeArgs(opts: AdapterRunOptions): string[] {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose'];
  // Read-only agents get a restricted tool set without ToolSearch, so every MCP tool schema would be inlined
  // (~70k tokens per agent) for tools their permission mode would deny anyway. Write agents defer MCP tools
  // behind ToolSearch, which costs about a thousand tokens, so they get the user's servers unless configured off.
  if (!opts.mcp || opts.access === 'readonly') args.push('--strict-mcp-config');
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  else args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.access === 'write') {
    args.push('--permission-mode', 'bypassPermissions');
  } else {
    const allowed = [...READONLY_ALLOWED];
    for (const cmd of opts.allowedCommands ?? []) allowed.push(`Bash(${cmd})`, `Bash(${cmd} *)`);
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

export const claudeAdapter: Adapter = {
  name: 'claude',
  async run(opts): Promise<AdapterResult> {
    let sessionId: string | undefined = opts.resumeSessionId;
    let final: Extract<AgentEvent, { type: 'result' }> | undefined;
    let rateLimits: RateLimits | undefined;
    const warnings: string[] = [];
    const denied: string[] = [];
    const parse = createClaudeParser();

    const { exitCode, stderr } = await spawnLines({
      bin: process.env.DULGER_CLAUDE_BIN ?? 'claude',
      args: buildClaudeArgs(opts),
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

    const text = final?.text ?? '';
    const output = final?.output ?? (opts.schema ? extractJson(text) : undefined);
    const ok = exitCode === 0 && !final?.isError && (!opts.schema || output !== undefined);
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
      error: ok ? undefined : final?.error || stderr.trim().split('\n').slice(-5).join('\n') || `claude exited with ${exitCode}`,
    };
  },
};
