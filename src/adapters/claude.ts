// Adapter for Claude Code: `claude -p ... --output-format stream-json`.
import type { AgentEvent } from '../types.ts';
import type { Adapter, AdapterResult, AdapterRunOptions } from './types.ts';
import { spawnLines, tryParseJson, extractJson } from './process.ts';

const READONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const READONLY_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git status *)', 'Bash(git status)', 'Bash(ls *)', 'Bash(cat *)'];

export function buildClaudeArgs(opts: AdapterRunOptions): string[] {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose'];
  // The user's MCP servers would be inlined as tool schemas (tens of thousands of tokens per agent when
  // ToolSearch is not available) and attach mid-session, invalidating the prompt cache. Skip them unless asked.
  if (!opts.mcp) args.push('--strict-mcp-config');
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
        return assistantEvents(o, newMessage);
      }
      case 'user':
        return toolResultEvents(o);
      case 'result':
        return resultEvents(o);
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

function assistantEvents(o: Record<string, unknown>, newMessage: boolean): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of contentBlocks(o)) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) events.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use' && typeof block.name === 'string') events.push({ type: 'tool', name: block.name, input: block.input });
  }
  if (newMessage) events.push({ type: 'turn' });
  return events;
}

/** One event per tool result; a `user` line that echoes a prompt has none. */
function toolResultEvents(o: Record<string, unknown>): AgentEvent[] {
  return contentBlocks(o).filter((b) => b.type === 'tool_result').map(() => ({ type: 'tool_result' }));
}

function resultEvents(o: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = [];
  const usage = o.usage && typeof o.usage === 'object' ? (o.usage as Record<string, unknown>) : undefined;
  const costUsd = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined;
  if (costUsd === undefined && !usage) events.push({ type: 'warning', text: 'result event has neither total_cost_usd nor usage; spend will read as unknown (stream-json format changed?)' });
  const tokens = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
    .reduce((n, k) => n + (typeof usage?.[k] === 'number' ? (usage[k] as number) : 0), 0);
  const text = typeof o.result === 'string' ? o.result : '';
  const isError = o.is_error === true;
  events.push({
    type: 'result',
    costUsd,
    tokens: tokens || undefined,
    output: o.structured_output,
    text,
    isError,
    error: isError ? text || JSON.stringify(o.errors ?? o.subtype ?? 'unknown error') : undefined,
  });
  return events;
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
    const warnings: string[] = [];
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
      tokens: final?.tokens,
      warnings: warnings.length ? warnings : undefined,
      exitCode,
      error: ok ? undefined : final?.error || stderr.trim().split('\n').slice(-5).join('\n') || `claude exited with ${exitCode}`,
    };
  },
};
