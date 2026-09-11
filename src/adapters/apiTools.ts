// Small coding toolset for Chat Completions providers. File access stays inside the worktree;
// shell commands have the user's privileges, like the existing CLI workers and verify gate.
import { lstat, realpath, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { AdapterRunOptions } from './types.ts';

const LIMIT = 24_000;
const str = { type: 'string' };
const tool = (name: string, description: string, properties: object, required: string[]) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export function apiTools(opts: AdapterRunOptions) {
  const tools = [
    tool('list_files', 'List one directory, relative to the worktree. Skips git, dulger and dependencies.', { path: str }, ['path']),
    tool('read_file', 'Read a UTF-8 file, optionally from a 1-based line offset (at most 24000 characters).', { path: str, line: { type: 'integer', minimum: 1 } }, ['path']),
    tool('git_diff', 'Inspect changes. With base: diff base...HEAD (use the result branch from the review prompt); otherwise diff the worktree against HEAD. Optional path and 1-based line offset for large diffs.', { base: str, path: str, line: { type: 'integer', minimum: 1 } }, []),
  ];
  if (opts.access === 'write') tools.push(tool('write_file', 'Create or replace a UTF-8 file in the worktree. Read existing files first.', { path: str, content: str }, ['path', 'content']));
  if (opts.access === 'write' || opts.allowedCommands?.length) tools.push(tool('run_command', opts.access === 'write'
    ? 'Run a finite shell command in the worktree (tests, build, search). Do not modify git or .dulger.'
    : `Run exactly one of these approved commands: ${JSON.stringify(opts.allowedCommands)}`, { command: str }, ['command']));
  return tools;
}

export class ToolDenied extends Error {}

/** Walk every existing path component, rejecting symlinks, traversal and internal metadata. */
async function safePath(cwd: string, input: string): Promise<string> {
  const root = await realpath(cwd);
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..' + sep) || rel.split(sep).some((p) => p === '.git' || p === '.dulger')) throw new ToolDenied('path is outside the worktree or inside protected metadata');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new ToolDenied('symlink paths are not allowed'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  return path;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`${key} must be a string`);
  return args[key];
}

export async function executeApiTool(name: string, args: Record<string, unknown>, opts: AdapterRunOptions): Promise<string> {
  opts.signal.throwIfAborted();
  if (!apiTools(opts).some((t) => t.function.name === name)) throw new ToolDenied(`tool ${name} is not allowed for ${opts.access} access`);
  switch (name) {
    case 'list_files': {
      const path = await safePath(opts.cwd, requiredString(args, 'path'));
      return (await readdir(path, { withFileTypes: true }))
        .filter((e) => !['.git', '.dulger', 'node_modules', '.venv'].includes(e.name) && !e.isSymbolicLink())
        .map((e) => e.name + (e.isDirectory() ? '/' : '')).join('\n').slice(0, LIMIT);
    }
    case 'read_file': {
      const path = await safePath(opts.cwd, requiredString(args, 'path'));
      if ((await lstat(path)).size > 2_000_000) throw new Error('file exceeds 2 MB; use a focused command to inspect it');
      const start = args.line === undefined ? 0 : Number(args.line) - 1;
      if (!Number.isInteger(start) || start < 0) throw new Error('line must be a positive integer');
      return (await readFile(path, 'utf8')).split('\n').slice(start).map((s, i) => `${start + i + 1}: ${s}`).join('\n').slice(0, LIMIT);
    }
    case 'write_file': {
      const path = await safePath(opts.cwd, requiredString(args, 'path'));
      const content = requiredString(args, 'content');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return `Wrote ${args.path}`;
    }
    case 'git_diff': {
      const base = args.base === undefined ? undefined : requiredString(args, 'base');
      if (base && !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(base)) throw new Error('base must be a branch name or commit hash');
      const path = args.path === undefined ? '.' : await safePath(opts.cwd, requiredString(args, 'path'));
      const start = args.line === undefined ? 0 : Number(args.line) - 1;
      if (!Number.isInteger(start) || start < 0) throw new Error('line must be a positive integer');
      const output = await command('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', base ? `${base}...HEAD` : 'HEAD', '--', path], opts, 2_000_000);
      return output.split('\n').slice(start).join('\n').slice(0, LIMIT);
    }
    case 'run_command': {
      const cmd = requiredString(args, 'command').trim();
      if (opts.access === 'readonly' && !opts.allowedCommands?.includes(cmd)) throw new ToolDenied(`command not approved: ${cmd}`);
      return command('/bin/sh', ['-c', cmd], opts);
    }
    default: throw new ToolDenied(`unknown tool: ${name}`);
  }
}

function command(bin: string, args: string[], opts: AdapterRunOptions, limit = LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    opts.signal.throwIfAborted();
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '';
    let stopped = false;
    const stop = () => {
      stopped = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(stop, 120_000);
    opts.signal.addEventListener('abort', stop, { once: true });
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-limit); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const cleanup = () => { clearTimeout(timer); opts.signal.removeEventListener('abort', stop); };
    child.on('error', (err) => { cleanup(); reject(err); });
    child.on('close', (code) => { cleanup(); resolve(`exit ${code ?? -1}${stopped ? ' (cancelled or timed out)' : ''}\n${output}`); });
  });
}
