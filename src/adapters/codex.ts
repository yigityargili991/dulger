// Adapter for OpenAI Codex CLI: `codex exec --json ...`.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../types.ts';
import type { Adapter, AdapterResult, AdapterRunOptions } from './types.ts';
import { spawnLines, tryParseJson, extractJson } from './process.ts';

export interface CodexAdapterOptions {
  bypassSandbox?: boolean;
}

export function buildCodexArgs(opts: AdapterRunOptions, files: { schema?: string; lastMessage: string }, extra: CodexAdapterOptions): string[] {
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

/** Convert one JSONL event line into normalised events. Exported for tests. */
export function parseCodexLine(line: string): AgentEvent[] {
  const o = tryParseJson(line);
  if (!o) return [];
  const item = o.item as Record<string, unknown> | undefined;
  switch (o.type) {
    case 'thread.started':
      return typeof o.thread_id === 'string' ? [{ type: 'init', sessionId: o.thread_id }] : [];
    case 'item.started':
      if (item?.type === 'command_execution') return [{ type: 'tool', name: 'shell', input: item.command }];
      if (item?.type === 'file_change') return [{ type: 'tool', name: 'edit', input: item.changes }];
      if (item?.type === 'mcp_tool_call') return [{ type: 'tool', name: String(item.tool ?? 'mcp') }];
      if (item?.type === 'web_search') return [{ type: 'tool', name: 'web_search' }];
      return [];
    case 'item.completed':
      if (item?.type === 'agent_message' && typeof item.text === 'string') return [{ type: 'text', text: item.text }];
      if (item?.type === 'command_execution' || item?.type === 'file_change' || item?.type === 'mcp_tool_call') return [{ type: 'tool_result' }];
      return [];
    case 'turn.completed':
      return [{ type: 'turn' }];
    default:
      return [];
  }
}

/** Tokens used by one `turn.completed` line (Codex reports usage, never dollars). */
export function codexTurnTokens(line: string): number {
  const o = tryParseJson(line);
  if (o?.type !== 'turn.completed') return 0;
  const u = (o.usage ?? {}) as Record<string, unknown>;
  return (typeof u.input_tokens === 'number' ? u.input_tokens : 0) + (typeof u.output_tokens === 'number' ? u.output_tokens : 0);
}

export function createCodexAdapter(extra: CodexAdapterOptions = {}): Adapter {
  return {
    name: 'codex',
    async run(opts): Promise<AdapterResult> {
      const dir = mkdtempSync(join(tmpdir(), 'dulger-codex-'));
      const files = { schema: opts.schema ? join(dir, 'schema.json') : undefined, lastMessage: join(dir, 'last.txt') };
      if (files.schema) writeFileSync(files.schema, JSON.stringify(opts.schema));

      let sessionId: string | undefined = opts.resumeSessionId;
      let lastText = '';
      let errorText = '';
      let tokens = 0;
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
            const raw = tryParseJson(line);
            if (raw?.type === 'error' || raw?.type === 'turn.failed') errorText = JSON.stringify(raw.error ?? raw.message ?? raw);
            tokens += codexTurnTokens(line);
            for (const ev of parseCodexLine(line)) {
              if (ev.type === 'init') sessionId = ev.sessionId;
              if (ev.type === 'text') lastText = ev.text;
              opts.onEvent(ev);
            }
          },
        });

        const text = existsSync(files.lastMessage) ? readFileSync(files.lastMessage, 'utf8') : lastText;
        const output = opts.schema ? extractJson(text) : undefined;
        opts.onEvent({ type: 'result', output, text, tokens: tokens || undefined });
        const ok = exitCode === 0 && !errorText && (!opts.schema || output !== undefined);
        return {
          ok,
          output,
          text,
          sessionId,
          tokens: tokens || undefined,
          exitCode,
          error: ok ? undefined : errorText || stderr.trim().split('\n').slice(-5).join('\n') || `codex exited with ${exitCode}`,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
