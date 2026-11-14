// The process sandbox around Claude Code agents and the commands dulger itself runs on code an agent
// wrote: verify commands, worktreeSetup, final verification, and the API tools' shell and git. Each
// runs in an `srt` process of its own (@anthropic-ai/sandbox-runtime: bubblewrap on Linux, Seatbelt on
// macOS) with a settings file of its own. The library is never loaded in-process: its network policy is
// process-wide and its built-in protections follow the host process's cwd, so only one srt per command
// keeps parallel cards apart.
//
// The policy belongs to whoever owns the machine: it comes from the user's own config file, --sandbox
// and the session, never from the repository being worked on or from a run's saved settings, since the
// code it confines comes from there.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import * as git from './git/worktree.ts';
import { keysFile } from './keys.ts';
import { projectDataDir, worktreesDir } from './paths.ts';

export type SandboxMode = 'off' | 'auto' | 'required';
export const SANDBOX_MODES: SandboxMode[] = ['off', 'auto', 'required'];

/** setup: worktreeSetup. verify: the verify gate and final verification. command: the API tools' shell and git. agent: a Claude Code process. */
export type SandboxKind = 'setup' | 'verify' | 'command' | 'agent';

export interface SandboxConfig {
  mode: SandboxMode;
  /** Writable on top of the command's worktree and its temp dir; entries that do not exist grant nothing and are left out. */
  allowWrite: string[];
  /** Readable although the built-in list hides them. */
  allowRead: string[];
  /** Hidden on top of the built-in list. */
  denyRead: string[];
  /** The hosts each kind of process may reach; nothing else is reachable. */
  domains: { setup: string[]; verify: string[]; agent: string[] };
}

export const SANDBOX_DEFAULTS: SandboxConfig = { mode: 'off', allowWrite: [], allowRead: [], denyRead: [], domains: { setup: [], verify: [], agent: [] } };

/** The runtime release dulger is built and tested against; package.json pins exactly this one. */
export const SANDBOX_RUNTIME_VERSION = '0.0.83';

const COMMANDS = "verify commands, worktree setup, final verification and the API tools' shell";
const COVERS = `Claude Code agents, ${COMMANDS}`;

// ---- the policy: the user's own config file -----------------------------------------------------

/** $XDG_CONFIG_HOME/dulger/config.json, next to the keys file. Only its `sandbox` key is read for now. */
export function userConfigFile(): string {
  return join(dirname(keysFile()), 'config.json');
}

/** The machine owner's policy: defaults <- the `sandbox` key of the user's config file <- `mode` (--sandbox or the session). */
export function machineSandbox(mode?: SandboxMode): SandboxConfig {
  const file = userConfigFile();
  let raw: unknown;
  if (existsSync(file)) {
    try { raw = (JSON.parse(readFileSync(file, 'utf8')) as { sandbox?: unknown } | null)?.sandbox; }
    catch (err) { throw new Error(`${file}: ${(err as Error).message}`); }
  }
  const config = raw === undefined ? structuredClone(SANDBOX_DEFAULTS) : parseSandbox(raw, file);
  if (mode !== undefined) config.mode = mode;
  return config;
}

// A host, a *.host wildcard or an IP, with an optional port. srt refuses the rest (and overly broad wildcards) itself.
const DOMAIN = /^(\*\.[\w-]+\.)?[\w-]+(\.[\w-]+)*(:\d{1,5})?$|^\[[\da-fA-F:.]+\](:\d{1,5})?$/;

/** A typo in a security policy must not pass for a policy, so anything unexpected is an error. */
function parseSandbox(raw: unknown, file: string): SandboxConfig {
  const fail = (what: string): never => { throw new Error(`${file}: ${what}`); };
  if (!isObject(raw)) return fail('"sandbox" must be an object');
  const keys = Object.keys(SANDBOX_DEFAULTS);
  for (const key of Object.keys(raw)) if (!keys.includes(key)) fail(`sandbox.${key} is not a sandbox setting (${keys.join(', ')})`);
  if (raw.mode !== undefined && !SANDBOX_MODES.includes(raw.mode as SandboxMode)) fail('sandbox.mode is off, auto or required');
  const strings = (value: unknown, what: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v)) return fail(`sandbox.${what} must be a list of strings`);
    return value as string[];
  };
  const paths = (key: 'allowWrite' | 'allowRead' | 'denyRead') => strings(raw[key], key).map((p) => {
    const path = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
    if (!isAbsolute(path)) fail(`sandbox.${key}: "${p}" must be an absolute path or start with ~/`);
    // srt skips write patterns on Linux without a word, which would leave the grant silently missing.
    if (key === 'allowWrite' && /[*?[\]{}]/.test(path)) fail(`sandbox.allowWrite: "${p}" is a pattern; writes take literal paths`);
    return path;
  });
  const domains = raw.domains ?? {};
  if (!isObject(domains)) return fail('sandbox.domains must be an object with setup, verify and agent lists');
  for (const key of Object.keys(domains)) if (!['setup', 'verify', 'agent'].includes(key)) fail(`sandbox.domains.${key} is not a kind (setup, verify, agent)`);
  const hosts = (key: 'setup' | 'verify' | 'agent') => strings(domains[key], `domains.${key}`).map((d) => DOMAIN.test(d) ? d : fail(`sandbox.domains.${key}: "${d}" is not a host (example.com, *.example.com, host:port)`));
  return {
    mode: (raw.mode as SandboxMode | undefined) ?? SANDBOX_DEFAULTS.mode,
    allowWrite: paths('allowWrite'), allowRead: paths('allowRead'), denyRead: paths('denyRead'),
    domains: { setup: hosts('setup'), verify: hosts('verify'), agent: hosts('agent') },
  };
}

// ---- the runtime: where it is and whether it works here ------------------------------------------

export interface SandboxProbe { ok: boolean; reason?: string; fix?: string }

const requireHere = createRequire(import.meta.url);

/** srt's CLI from dulger's own dependencies, never from PATH, and only the release dulger pins. */
function runtimeCli(): string | { reason: string; fix: string } {
  let manifest: string;
  try { manifest = requireHere.resolve('@anthropic-ai/sandbox-runtime/package.json'); }
  catch { return { reason: '@anthropic-ai/sandbox-runtime is not installed', fix: 'reinstall dulger, which depends on it' }; }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string; bin?: string | Record<string, string> };
  if (pkg.version !== SANDBOX_RUNTIME_VERSION) return { reason: `found @anthropic-ai/sandbox-runtime ${pkg.version} in ${dirname(manifest)}, but this dulger is built for ${SANDBOX_RUNTIME_VERSION}`, fix: 'reinstall dulger so that its pinned runtime is used' };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.srt;
  if (!bin) return { reason: `${manifest} names no srt executable`, fix: 'reinstall dulger' };
  return join(dirname(manifest), bin);
}

const LINUX_TOOLS = [['bwrap', 'bubblewrap'], ['socat', 'socat'], ['rg', 'ripgrep']] as const;

function missingTools(): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const found = (bin: string) => dirs.some((dir) => { try { accessSync(join(dir, bin), constants.X_OK); return true; } catch { return false; } });
  return LINUX_TOOLS.filter(([bin]) => !found(bin)).map(([, pkg]) => pkg);
}

function installFix(pkgs: string[]): string {
  const list = pkgs.join(' ');
  return `install ${pkgs.join(', ')}: sudo pacman -S ${list} (Arch), sudo apt install ${list} (Debian, Ubuntu) or sudo dnf install ${list} (Fedora)`;
}

let probed: SandboxProbe | undefined;

/**
 * Whether srt works here, from one real wrapped command per dulger process. srt's own dependency check
 * is not enough: it needs `which` and cannot see that user namespaces are blocked.
 */
export function probeSandbox(): SandboxProbe {
  return probed ??= runProbe();
}

function runProbe(): SandboxProbe {
  if (process.platform === 'win32') return { ok: false, reason: 'native Windows is not supported', fix: 'run dulger inside WSL2' };
  if (process.platform !== 'linux' && process.platform !== 'darwin') return { ok: false, reason: `${process.platform} is not supported`, fix: 'run dulger on Linux or macOS' };
  const cli = runtimeCli();
  if (typeof cli !== 'string') return { ok: false, ...cli };
  const dir = mkdtempSync(join(tmpdir(), 'dulger-sandbox-probe-'));
  try {
    const settings = join(dir, 'probe.json');
    writeFileSync(settings, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } }), { mode: 0o600 });
    // spawnSync's timeout sends SIGTERM, which srt cleans up after (and then exits 0: hence the marker).
    const r = spawnSync(process.execPath, [cli, '--settings', settings, '--', '/bin/sh', '-c', 'echo dulger-sandbox-ok'], {
      cwd: dir, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_TMPDIR: dir },
    });
    if (!r.error && r.status === 0 && r.stdout.includes('dulger-sandbox-ok')) return { ok: true };
    const said = (r.stderr ?? '').split('\n').map((l) => l.replace(/^Error:\s*/, '').trim()).filter(Boolean).at(-1);
    const reason = r.error ? `srt did not answer (${r.error.message})` : said ?? `srt exited with ${r.status ?? r.signal}`;
    const missing = process.platform === 'linux' ? missingTools() : [];
    const fix = missing.length ? installFix(missing)
      : process.platform === 'linux' ? 'bubblewrap cannot create its namespaces here: an unprivileged container, or a kernel that restricts unprivileged user namespaces such as Ubuntu 24.04 and later; the Sandbox section of dulger\'s README has the details'
      : 'the Sandbox section of dulger\'s README has the details';
    return { ok: false, reason, fix };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export interface SandboxStatus {
  mode: SandboxMode;
  /** Commands are wrapped. */
  active: boolean;
  /** Whether the runtime works here; unknown when nobody asked (mode off, during a run). */
  available?: boolean;
  reason?: string;
  fix?: string;
}

/** What the mode means on this machine. `off` asks the runtime nothing unless `probeOff` (the doctor says whether it would work). */
export function sandboxStatus(mode: SandboxMode, o: { probe?: () => SandboxProbe; probeOff?: boolean } = {}): SandboxStatus {
  if (mode === 'off' && !o.probeOff) return { mode, active: false };
  const p = (o.probe ?? probeSandbox)();
  return { mode, active: mode !== 'off' && p.ok, available: p.ok, reason: p.reason, fix: p.fix };
}

/** What a run starts with: one line, and the fix on a second when the runtime does not work. Short, since log panes cut lines. */
export function sandboxNotice(s: SandboxStatus): string[] {
  if (s.active) return [`sandbox ${s.mode}: Claude Code agents and verify, setup and API tool commands are confined to their worktree and granted hosts`];
  if (s.mode === 'off') return ['sandbox off: agents and verify commands run with your privileges (dulger doctor explains the sandbox)'];
  return [`sandbox unavailable (${s.reason}): agents and verify, setup and API tool commands run with your privileges`, `sandbox fix: ${s.fix}`];
}

/** The doctor's Sandbox line. `required` without a working runtime is an error: no run starts then. */
export function sandboxCheck(s: SandboxStatus): { status: 'pass' | 'warning' | 'error'; detail: string } {
  if (s.active) return { status: 'pass', detail: `${s.mode}: ${COVERS} run in the sandbox (srt ${SANDBOX_RUNTIME_VERSION}): writes go to their worktree and a temp dir, network to the hosts in ${userConfigFile()} only, and Claude Code also to Anthropic's API. Codex agents are not wrapped: they keep Codex's own sandbox.` };
  const broken = `the runtime does not work here: ${s.reason}. Fix: ${s.fix}.`;
  if (s.mode === 'off') {
    const here = s.available === undefined ? '' : s.available ? ' The runtime works here.' : ` When enabled, ${broken}`;
    return { status: 'warning', detail: `off: agents, ${COMMANDS} run with your privileges.${here} Set "sandbox": { "mode": "auto" } in ${userConfigFile()}, or pass --sandbox auto, to confine Claude Code agents and those commands; the README's Sandbox section says what it does and does not confine.` };
  }
  if (s.mode === 'auto') return { status: 'warning', detail: `auto, but ${broken} Until then ${COVERS} run with your privileges.` };
  return { status: 'error', detail: `required, but ${broken} No run starts until it works or the mode changes.` };
}

// ---- one command's policy -------------------------------------------------------------------------

/** Read by nothing a worker's code needs, and worth stealing. */
const HIDDEN = ['.ssh', '.gnupg', '.aws', '.azure', '.config/gcloud', '.config/gh', '.config/dulger', '.netrc', '.npmrc', '.docker', '.kube', '.git-credentials'];
/** What pays for the agents: hidden from the commands that run their code, not from the agent itself. */
const AGENT_CREDENTIALS = ['.claude', '.claude.json', '.codex'];
const AGENT_DOMAINS = ['api.anthropic.com', 'claude.ai', 'platform.claude.com'];
/** Hook locations inside a worktree that srt does not protect on its own. */
const HOOK_DIRS = ['.claude', '.husky', '.githooks'];

export interface SandboxPaths {
  home: string;
  /** dulger's user config directory (this policy, the keys file), wherever $XDG_CONFIG_HOME puts it. */
  configDir: string;
  /** The project's worktrees root: every card's worktree is below it. */
  worktrees: string;
  /** <projectDataDir>/sandbox: every run's settings files and temp dirs. */
  area: string;
  /** This command's temp dir; it must exist. */
  temp: string;
}

export interface SrtSettings {
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

/** What one command gets on top of its kind's policy: a Claude Code agent's transcript directory. */
export interface SandboxExtra {
  /** Writable; must exist, since srt on Linux grants nothing on a missing path. */
  allowWrite?: string[];
  /** Read-only although below a writable path; must exist, or srt creates it on the host. */
  denyWrite?: string[];
}

const within = (root: string, path: string) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const unique = (list: string[]) => [...new Set(list)];

/**
 * The srt settings for one command of `kind` run in `cwd`, and what its environment needs on top. Reads
 * are open except what is hidden; the worktrees root and the sandbox area are hidden as a whole, so a
 * card sees neither its siblings' worktrees nor their temp dirs. Only a worktree below the worktrees
 * root is writable, never the user's own checkout. srt resolves relative paths against its cwd, so every
 * path here is absolute.
 */
export function sandboxSettings(kind: SandboxKind, cwd: string, paths: SandboxPaths, config: SandboxConfig, env: NodeJS.ProcessEnv = process.env, extra: SandboxExtra = {}): { settings: SrtSettings; env: Record<string, string> } {
  const home = (p: string) => join(paths.home, p);
  const writable = within(paths.worktrees, cwd);
  const baseUrl = (() => { try { return env.ANTHROPIC_BASE_URL ? [new URL(env.ANTHROPIC_BASE_URL).hostname] : []; } catch { return []; } })();
  const domains = kind === 'agent' ? [...AGENT_DOMAINS, ...baseUrl, ...config.domains.agent] : config.domains[kind === 'setup' ? 'setup' : 'verify'];
  return {
    settings: {
      network: { allowedDomains: unique(domains), deniedDomains: [] },
      filesystem: {
        denyRead: unique([...HIDDEN.map(home), ...(kind === 'verify' || kind === 'command' ? AGENT_CREDENTIALS.map(home) : []), paths.configDir, paths.worktrees, paths.area, ...config.denyRead]),
        allowRead: unique([cwd, paths.temp, ...config.allowRead]),
        allowWrite: unique([...(writable ? [cwd] : []), paths.temp, ...(extra.allowWrite ?? []), ...config.allowWrite.filter((p) => existsSync(p))]),
        // A write deny on a missing path makes srt create it on the host, so only the ones that exist (and
        // only where they could be written at all).
        denyWrite: unique([...(writable ? HOOK_DIRS.map((d) => join(cwd, d)).filter((p) => existsSync(p)) : []), ...(extra.denyWrite ?? [])]),
      },
    },
    // srt points TMPDIR inside at this; without it there is no writable temp dir at all.
    env: { CLAUDE_CODE_TMPDIR: paths.temp },
  };
}

// ---- a run's handle ---------------------------------------------------------------------------------

export interface WrappedCommand { bin: string; args: string[]; env: NodeJS.ProcessEnv }

export interface Sandbox {
  status: SandboxStatus;
  /**
   * How to spawn `command` (a shell string, or argv) as `kind` in `cwd`, with `env`: through srt when the
   * sandbox is active, undefined when commands run as they always did. A wrapped command must be stopped
   * with SIGTERM first: srt killed outright leaves its proxy bridge, socket and placeholder files behind.
   */
  wrap(kind: SandboxKind, cwd: string, command: string | string[], env: NodeJS.ProcessEnv, extra?: SandboxExtra): WrappedCommand | undefined;
  /** Whether a command wrapped in `cwd` may write there: a card's worktree, never your checkout. */
  writable(cwd: string): boolean;
  /**
   * Remove placeholders an interrupted srt left in `cwd`, before dulger commits it; returns what went. Only
   * where this run wraps or has wrapped commands: the sandbox is active, or the run's directory (kept until
   * the run finishes) is there, as on a resume without the sandbox after dulger was killed while srt ran.
   */
  scrub(cwd: string): string[];
  /** Remove this run's settings files and temp dirs. */
  dispose(): void;
}

export function sandboxDir(repoRoot: string): string {
  return join(projectDataDir(repoRoot), 'sandbox');
}

/** The sandbox for one run. `required` without a working runtime never gets this far unwrapped: it throws. */
export function createSandbox(repoRoot: string, runId: string, config: SandboxConfig, status: SandboxStatus = sandboxStatus(config.mode)): Sandbox {
  if (status.mode === 'required' && !status.active) throw new Error(`the sandbox is required, but ${status.reason ?? 'it is not available'}${status.fix ? `; ${status.fix}` : ''}`);
  const area = sandboxDir(repoRoot);
  const runDir = join(area, runId);
  let cli: string | undefined;
  return {
    status,
    wrap(kind, cwd, command, env, extra) {
      if (!status.active) return undefined;
      if (cli === undefined) {
        const found = runtimeCli();
        if (typeof found !== 'string') throw new Error(`sandbox runtime: ${found.reason}`);
        cli = found;
      }
      const worktrees = worktreesDir(repoRoot);
      // One temp dir per card (<runId>/<cardId> below the worktrees root); anything else shares one.
      const key = within(worktrees, cwd) ? relative(worktrees, cwd).split(sep)[1] ?? '.run' : '.checkout';
      const temp = join(runDir, 'tmp', key);
      mkdirSync(temp, { recursive: true, mode: 0o700 });
      // srt 0.0.83 mounts a placeholder over a missing .claude/commands and .claude/agents, and fails (every
      // command does) when it has to create one inside a .claude that is itself write-denied. Empty
      // directories exist for git as little as the placeholders do, and scrub removes them before a commit.
      const claude = join(cwd, '.claude');
      if (within(worktrees, cwd) && lstatSync(claude, { throwIfNoEntry: false })?.isDirectory()) {
        for (const d of ['commands', 'agents']) mkdirSync(join(claude, d), { recursive: true });
      }
      const policy = sandboxSettings(kind, cwd, { home: homedir(), configDir: dirname(userConfigFile()), worktrees, area, temp }, config, env, extra);
      // Named after its content: commands with the same policy share a file, a different policy never overwrites it.
      const json = JSON.stringify(policy.settings, null, 2) + '\n';
      const file = join(runDir, `settings-${createHash('sha256').update(json).digest('hex').slice(0, 16)}.json`);
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, json, { mode: 0o600 });
      renameSync(tmp, file);
      const argv = typeof command === 'string' ? ['/bin/sh', '-c', command] : command;
      // `--` always: srt reads its own options anywhere in the line otherwise (a `-c` meant for the command included).
      return { bin: process.execPath, args: [cli, '--settings', file, '--', ...argv], env: { ...env, ...policy.env } };
    },
    writable: (cwd) => within(worktreesDir(repoRoot), cwd),
    scrub: (cwd) => (status.active || existsSync(runDir) ? scrubPlaceholders(cwd) : []),
    dispose() {
      try { rmSync(runDir, { recursive: true, force: true }); } catch { /* left for dulger clean */ }
    },
  };
}

/**
 * What srt mounts over protected paths that do not exist in a writable cwd while a command runs. It
 * removes them on a clean exit; killed outright, it leaves them as empty files and directories that
 * `git add -A` would commit. Children come before `.claude`, so a `.claude` that held nothing else goes too.
 */
const PLACEHOLDERS = ['.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.idea', '.mcp.json', '.profile', '.ripgreprc', '.vscode', '.zprofile', '.zshrc', '.claude/commands', '.claude/agents', '.claude'];

/** Remove leftover placeholders: only untracked empty files and empty directories from the list, never anything tracked or with content. */
export function scrubPlaceholders(cwd: string): string[] {
  const present = PLACEHOLDERS.filter((p) => { try { lstatSync(join(cwd, p)); return true; } catch { return false; } });
  if (!present.length) return [];
  const tracked = git.git(cwd, ['ls-files', '-z', '--', ...present]).split('\0').filter(Boolean);
  const removed: string[] = [];
  for (const p of present) {
    if (tracked.some((t) => t === p || t.startsWith(`${p}/`))) continue;
    const path = join(cwd, p);
    try {
      const st = lstatSync(path);
      if (st.isFile() && st.size === 0) rmSync(path);
      else if (st.isDirectory() && readdirSync(path).length === 0) rmdirSync(path);
      else continue;
      removed.push(p);
    } catch { /* gone already, or not ours to force */ }
  }
  return removed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
