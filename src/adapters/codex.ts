import { CODEX_CAPABILITIES } from './capabilities.ts';
// Adapter for OpenAI Codex CLI: `codex exec --json ...`.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, Usage } from '../types.ts';
import type { Adapter, AdapterResult, AdapterRunOptions } from './types.ts';
import { spawnLines, tryParseJson, extractJson } from './process.ts';
import { addUsage } from '../usage.ts';

export interface CodexAdapterOptions {
  bypassSandbox?: boolean;
}

export function buildCodexArgs(opts: AdapterRunOptions, files: { schema?: string; lastMessage: string }, extra: CodexAdapterOptions): string[] {
  // Codex exec has no all-tools-off option; even disabling shell tools leaves apply_patch.
  if (opts.access === 'none') throw new Error('Codex CLI does not support tool-free reporting; set roles.reporter.harness to claude or an API provider, or disable progress reporting');
  const args = ['exec'];
  if (opts.resumeSessionId) args.push('resume', opts.resumeSessionId);
  args.push('--json', '--skip-git-repo-check', '-o', files.lastMessage);
  if (files.schema) args.push('--output-schema', files.schema);
  if (opts.model) args.push('-m', opts.model);
  if (opts.access === 'write' && extra.bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
  // `codex exec resume` accepts neither -C nor --sandbox: the resumed session keeps its cwd and policy.
  if (!opts.resumeSessionId) {
    args.push('-C', opts.cwd);
    if (!(opts.access === 'write' && extra.bypassSandbox)) args.push('--sandbox', opts.access === 'write' ? 'workspace-write' : 'read-only');
  }
  args.push('-'); // prompt on stdin
  return args;
}

export interface CodexParser {
  parse(line: string): AgentEvent[];
  /** Usage across all turns so far (Codex reports tokens, never dollars); undefined until a turn completed. */
  readonly usage: Usage | undefined;
  /** Set when the turn failed or Codex reported a top-level error. */
  readonly error: string | undefined;
}

/**
 * A parser for one `codex exec --json` session. Codex has no per-call "turn": the whole exec is one
 * turn made of items, so a turn is counted per completed item (a message or a tool call), which
 * lines up with what Claude Code calls a turn. Advisory `error` items (e.g. skill descriptions
 * truncated) become warnings; only `turn.failed` and top-level errors fail the run.
 */
export function createCodexParser(): CodexParser {
  let usage: Usage | undefined;
  let error: string | undefined;
  const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

  function parse(line: string): AgentEvent[] {
    const o = tryParseJson(line);
    if (!o) return [];
    const item = o.item && typeof o.item === 'object' ? (o.item as Record<string, unknown>) : undefined;
    switch (o.type) {
      case 'thread.started':
        if (typeof o.thread_id !== 'string') return [{ type: 'warning', text: 'thread.started has no thread_id; this session cannot be resumed (codex JSONL format changed?)' }];
        return [{ type: 'init', sessionId: o.thread_id }];
      case 'item.started':
        return toolStarted(item);
      case 'item.completed':
        if (!item) return [];
        if (item.type === 'agent_message' && typeof item.text === 'string') return [{ type: 'text', text: item.text }, { type: 'turn' }];
        if (item.type === 'error') return [{ type: 'warning', text: `codex reported: ${String(item.message ?? 'error')}` }];
        if (typeof item.type === 'string' && TOOL_ITEMS.has(item.type)) return [{ type: 'tool_result' }, { type: 'turn' }];
        return [];
      case 'turn.completed': {
        const u = o.usage && typeof o.usage === 'object' ? (o.usage as Record<string, unknown>) : undefined;
        if (!u) return [{ type: 'warning', text: 'turn.completed has no usage; spend will read as unknown (codex JSONL format changed?)' }];
        usage = addUsage(usage, codexUsage(u));
        return [];
      }
      case 'turn.failed':
      case 'error': {
        const err = o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>).message : (o.message ?? o.error);
        error = typeof err === 'string' ? err : JSON.stringify(err ?? o);
        return [];
      }
      default:
        return [];
    }
  }

  return { parse, get usage() { return usage; }, get error() { return error; } };
}

/** OpenAI semantics: input_tokens is the whole prompt and cached_input_tokens the part of it served from cache. */
function codexUsage(u: Record<string, unknown>): Usage {
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const cacheRead = n('cached_input_tokens');
  return { input: Math.max(0, n('input_tokens') - cacheRead), cacheRead, cacheWrite: n('cache_write_input_tokens'), output: n('output_tokens') };
}

function toolStarted(item: Record<string, unknown> | undefined): AgentEvent[] {
  switch (item?.type) {
    case 'command_execution': return [{ type: 'tool', name: 'shell', input: item.command }];
    case 'file_change': return [{ type: 'tool', name: 'edit', input: item.changes }];
    case 'mcp_tool_call': return [{ type: 'tool', name: String(item.tool ?? 'mcp') }];
    case 'web_search': return [{ type: 'tool', name: 'web_search' }];
    default: return [];
  }
}

export function createCodexAdapter(extra: CodexAdapterOptions = {}): Adapter {
  return {
    name: 'codex',
    capabilities: CODEX_CAPABILITIES,
    async run(opts): Promise<AdapterResult> {
      const dir = mkdtempSync(join(tmpdir(), 'dulger-codex-'));
      const files = { schema: opts.schema ? join(dir, 'schema.json') : undefined, lastMessage: join(dir, 'last.txt') };
      if (files.schema) writeFileSync(files.schema, JSON.stringify(opts.schema));

      let sessionId: string | undefined = opts.resumeSessionId;
      let lastText = '';
      const warnings: string[] = [];
      const parser = createCodexParser();
      try {
        const { exitCode, stderr } = await spawnLines({
          bin: process.env.DULGER_CODEX_BIN ?? 'codex',
          args: buildCodexArgs(opts, files, extra),
          cwd: opts.cwd,
          // Codex has no system-prompt flag: prepend it to the prompt on first run.
          stdin: opts.resumeSessionId ? opts.prompt : `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`,
          logFile: opts.logFile,
          signal: opts.signal,
          onLine(line) {
            for (const ev of parser.parse(line)) {
              if (ev.type === 'init') sessionId = ev.sessionId;
              if (ev.type === 'text') lastText = ev.text;
              if (ev.type === 'warning') warnings.push(ev.text);
              opts.onEvent(ev);
            }
          },
        });

        const text = existsSync(files.lastMessage) ? readFileSync(files.lastMessage, 'utf8') : lastText;
        const output = opts.schema ? extractJson(text) : undefined;
        opts.onEvent({ type: 'result', output, text, usage: parser.usage, isError: Boolean(parser.error), error: parser.error });
        const ok = exitCode === 0 && !parser.error && (!opts.schema || output !== undefined);
        return {
          ok,
          output,
          text,
          sessionId,
          usage: parser.usage,
          warnings: warnings.length ? warnings : undefined,
          exitCode,
          error: ok ? undefined : parser.error || stderr.trim().split('\n').slice(-5).join('\n') || `codex exited with ${exitCode}`,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
