// Shared helper: spawn a CLI, stream its stdout line by line, tee raw lines to a log file.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface SpawnLinesOptions {
  bin: string;
  args: string[];
  cwd: string;
  stdin?: string;
  logFile: string;
  signal: AbortSignal;
  onLine: (line: string) => void;
  /** The child's environment; process.env when not given. */
  env?: NodeJS.ProcessEnv;
  /**
   * The child is srt running the harness. It is stopped with SIGTERM, which srt passes on and cleans up
   * after, then SIGKILL after a grace period: srt killed outright leaves its proxy bridge, socket and
   * placeholder files behind. Stopped, srt exits 0. It stays in dulger's process group, so the hangup a
   * closed terminal sends ends it as it ends an unsandboxed harness.
   */
  sandboxed?: boolean;
}

export interface SpawnLinesResult {
  exitCode: number;
  stderr: string;
}

/** How long a sandboxed harness gets to stop after SIGTERM, as a sandboxed command does; Claude Code 2.1 took milliseconds. */
export const STOP_GRACE_MS = 1000;

export function spawnLines(opts: SpawnLinesOptions): Promise<SpawnLinesResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });
    const log = createWriteStream(opts.logFile, { flags: 'a' });
    let stderr = '';

    let escalation: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill('SIGTERM');
      if (opts.sandboxed) escalation = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(escalation);
      log.end();
      reject(err);
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      log.write(line + '\n');
      if (line.trim()) opts.onLine(line);
    });

    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort);
      clearTimeout(escalation);
      log.end();
      resolve({ exitCode: code ?? -1, stderr });
    });

    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    else child.stdin!.end();
  });
}

/** Parse a JSON line; returns undefined for non-JSON output (harnesses sometimes print warnings). */
export function tryParseJson(line: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Extract the first JSON object from free text (fallback when a harness ignores the schema). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c.trim());
    } catch {
      /* try next */
    }
  }
  return undefined;
}
