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

/** Convert one stream-json line into zero or more normalised events. Exported for tests. */
export function parseClaudeLine(line: string): AgentEvent[] {
  const o = tryParseJson(line);
  if (!o) return [];
  const events: AgentEvent[] = [];
  switch (o.type) {
    case 'system':
      if (o.subtype === 'init' && typeof o.session_id === 'string') events.push({ type: 'init', sessionId: o.session_id });
      break;
    case 'assistant': {
      const msg = o.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of msg?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) events.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use' && typeof block.name === 'string') events.push({ type: 'tool', name: block.name, input: block.input });
      }
      events.push({ type: 'turn' });
      break;
    }
    case 'user':
      events.push({ type: 'tool_result' });
      break;
    case 'result': {
      const u = (o.usage ?? {}) as Record<string, unknown>;
      const tokens = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
        .reduce((n, k) => n + (typeof u[k] === 'number' ? (u[k] as number) : 0), 0);
      events.push({
        type: 'result',
        costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined,
        tokens: tokens || undefined,
        output: o.structured_output,
        text: typeof o.result === 'string' ? o.result : '',
      });
      break;
    }
  }
  return events;
}

export const claudeAdapter: Adapter = {
  name: 'claude',
  async run(opts): Promise<AdapterResult> {
    let sessionId: string | undefined = opts.resumeSessionId;
    let final: Extract<AgentEvent, { type: 'result' }> | undefined;
    let isError = false;
    let errorText = '';

    const { exitCode, stderr } = await spawnLines({
      bin: process.env.DULGER_CLAUDE_BIN ?? 'claude',
      args: buildClaudeArgs(opts),
      cwd: opts.cwd,
      logFile: opts.logFile,
      signal: opts.signal,
      onLine(line) {
        const raw = tryParseJson(line);
        if (raw?.type === 'result' && raw.is_error === true) {
          isError = true;
          errorText = typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.errors ?? raw);
        }
        for (const ev of parseClaudeLine(line)) {
          if (ev.type === 'init') sessionId = ev.sessionId;
          if (ev.type === 'result') final = ev;
          opts.onEvent(ev);
        }
      },
    });

    const text = final?.text ?? '';
    const output = final?.output ?? (opts.schema ? extractJson(text) : undefined);
    const ok = exitCode === 0 && !isError && (!opts.schema || output !== undefined);
    return {
      ok,
      output,
      text,
      sessionId,
      costUsd: final?.costUsd,
      tokens: final?.tokens,
      exitCode,
      error: ok ? undefined : errorText || stderr.trim().split('\n').slice(-5).join('\n') || `claude exited with ${exitCode}`,
    };
  },
};
