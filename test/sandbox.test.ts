import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { createOrchestrator } from '../src/runner/orchestrator.ts';
import { createFakeAdapter, DEFAULT_FAKE_SCRIPT } from '../src/adapters/fake.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import { executeApiTool } from '../src/adapters/apiTools.ts';
import { buildClaudeArgs, claudeAdapter, claudeProjectDir } from '../src/adapters/claude.ts';
import { STOP_GRACE_MS } from '../src/adapters/process.ts';
import type { AdapterRunOptions } from '../src/adapters/types.ts';
import { childEnv } from '../src/childEnv.ts';
import { DEFAULT_CONFIG, loadConfig, type Config } from '../src/config.ts';
import { preflight, requirePreflight } from '../src/preflight.ts';
import { originalSettings, settingsChanges, snapshotSettings } from '../src/runSettings.ts';
import { runVerification } from '../src/runner/verify.ts';
import { worktreesDir } from '../src/paths.ts';
import { sessionConfig } from '../src/replModels.ts';
import { resumeRun, runBoard } from '../src/commands.ts';
import type { Session } from '../src/repl.ts';
import type { Board } from '../src/types.ts';
import {
  createSandbox, probeSandbox, sandboxCheck, sandboxDir, sandboxNotice, sandboxSettings, sandboxStatus, scrubPlaceholders,
  SANDBOX_DEFAULTS, SANDBOX_RUNTIME_VERSION, userConfigFile, type SandboxConfig, type SandboxMode, type SandboxPaths,
} from '../src/sandbox.ts';

// Nothing here may touch the real user directories: data and the user config file live in temp dirs.
const dataDir = mkdtempSync(join(tmpdir(), 'dulger-sandbox-data-'));
const configHome = mkdtempSync(join(tmpdir(), 'dulger-sandbox-xdg-'));
process.env.DULGER_DATA_DIR = dataDir;
process.env.XDG_CONFIG_HOME = configHome;
after(() => { rmSync(dataDir, { recursive: true, force: true }); rmSync(configHome, { recursive: true, force: true }); });

const policy = (extra: Partial<SandboxConfig> = {}): SandboxConfig => ({ ...structuredClone(SANDBOX_DEFAULTS), ...extra });
const base: Config = { ...structuredClone(DEFAULT_CONFIG), harness: 'fake', docs: false, progressIntervalSec: 0, concurrency: 1, maxReplans: 0 };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function repo(t: TestContext, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-sandbox-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  git.git(root, ['add', '-A']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

function userConfig(t: TestContext, content: unknown): void {
  mkdirSync(join(configHome, 'dulger'), { recursive: true });
  writeFileSync(userConfigFile(), typeof content === 'string' ? content : JSON.stringify(content));
  t.after(() => rmSync(userConfigFile(), { force: true }));
}

// ---- pure: no sandbox is ever started -------------------------------------------------------------

test('the settings for each kind of command, exactly', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dulger-sandbox-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths: SandboxPaths = { home: join(root, 'home'), configDir: join(root, 'xdg', 'dulger'), worktrees: join(root, 'data', 'worktrees'), area: join(root, 'data', 'sandbox'), temp: join(root, 'data', 'sandbox', 'run1', 'tmp', 'c1') };
  const cwd = join(paths.worktrees, 'run1', 'c1');
  mkdirSync(join(cwd, '.husky'), { recursive: true });
  mkdirSync(join(cwd, '.githooks'));
  mkdirSync(paths.temp, { recursive: true });
  mkdirSync(join(root, 'cache'));
  const config = policy({
    mode: 'auto', allowWrite: [join(root, 'cache'), join(root, 'missing')], allowRead: [join(paths.home, '.npmrc')], denyRead: [join(root, 'secret')],
    domains: { setup: ['registry.npmjs.org'], verify: ['example.com'], agent: ['extra.example.com'] },
  });
  const home = (p: string) => join(paths.home, p);
  const hidden = ['.ssh', '.gnupg', '.aws', '.azure', '.config/gcloud', '.config/gh', '.config/dulger', '.netrc', '.npmrc', '.docker', '.kube', '.git-credentials'].map(home);
  const credentials = ['.claude', '.claude.json', '.codex'].map(home);
  const filesystem = (dir: string, agentCredentials: string[]) => ({
    denyRead: [...hidden, ...agentCredentials, paths.configDir, paths.worktrees, paths.area, join(root, 'secret')],
    allowRead: [dir, paths.temp, home('.npmrc')],
    allowWrite: [...(dir === cwd ? [cwd] : []), paths.temp, join(root, 'cache')],
    denyWrite: dir === cwd ? [join(cwd, '.husky'), join(cwd, '.githooks')] : [],
  });
  const env = { CLAUDE_CODE_TMPDIR: paths.temp };
  assert.deepEqual(sandboxSettings('setup', cwd, paths, config, {}), { settings: { network: { allowedDomains: ['registry.npmjs.org'], deniedDomains: [] }, filesystem: filesystem(cwd, []) }, env });
  for (const kind of ['verify', 'command'] as const) {
    assert.deepEqual(sandboxSettings(kind, cwd, paths, config, {}), { settings: { network: { allowedDomains: ['example.com'], deniedDomains: [] }, filesystem: filesystem(cwd, credentials) }, env }, kind);
  }
  assert.deepEqual(sandboxSettings('agent', cwd, paths, config, { ANTHROPIC_BASE_URL: 'https://gateway.example.net:8443/v1' }), {
    settings: { network: { allowedDomains: ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'gateway.example.net', 'extra.example.com'], deniedDomains: [] }, filesystem: filesystem(cwd, []) }, env,
  }, 'the agent keeps its own credentials and reaches its API');
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  assert.deepEqual(sandboxSettings('command', checkout, paths, config, {}).settings.filesystem, filesystem(checkout, credentials), 'the user\'s own checkout is never writable');
  assert.deepEqual(sandboxSettings('verify', cwd, paths, policy(), {}).settings.network.allowedDomains, [], 'no network unless granted');

  // A Claude Code call adds its transcript directory; in the checkout (the planner) that directory's memory/ stays read-only.
  const transcripts = home('.claude/projects/-run1-c1');
  const worker = sandboxSettings('agent', cwd, paths, config, {}, { allowWrite: [transcripts] }).settings.filesystem;
  assert.deepEqual(worker, { ...filesystem(cwd, []), allowWrite: [cwd, paths.temp, transcripts, join(root, 'cache')] });
  const own = home('.claude/projects/-checkout');
  const planner = sandboxSettings('agent', checkout, paths, config, {}, { allowWrite: [own], denyWrite: [join(own, 'memory')] }).settings.filesystem;
  assert.deepEqual(planner, { ...filesystem(checkout, []), allowWrite: [paths.temp, own, join(root, 'cache')], denyWrite: [join(own, 'memory')] });
});

test('a wrapped command always passes -- before itself, and its settings file is private and outside the worktree', (t) => {
  const root = repo(t);
  const cwd = join(worktreesDir(root), 'run1', 'c1');
  mkdirSync(cwd, { recursive: true });
  const config = policy({ mode: 'auto', domains: { setup: [], verify: ['example.com'], agent: [] } });
  const sandbox = createSandbox(root, 'run1', config, { mode: 'auto', active: true, available: true });
  const shell = sandbox.wrap('verify', cwd, 'python3 -c "print(1)" --settings x', { PATH: '/usr/bin', NPM_TOKEN: 'npm' })!;
  assert.equal(shell.bin, process.execPath);
  assert.match(shell.args[0]!, /@anthropic-ai[/\\]sandbox-runtime[/\\]dist[/\\]cli\.js$/, 'the CLI from dulger\'s own dependencies');
  assert.equal(shell.args[1], '--settings');
  assert.deepEqual(shell.args.slice(3), ['--', '/bin/sh', '-c', 'python3 -c "print(1)" --settings x']);
  const temp = join(sandboxDir(root), 'run1', 'tmp', 'c1');
  assert.deepEqual(shell.env, { PATH: '/usr/bin', NPM_TOKEN: 'npm', CLAUDE_CODE_TMPDIR: temp });
  assert.ok(lstatSync(temp).isDirectory(), 'the temp dir exists before srt starts');
  const file = shell.args[2]!;
  assert.ok(file.startsWith(join(sandboxDir(root), 'run1') + '/'), file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const paths = { home: homedir(), configDir: join(configHome, 'dulger'), worktrees: worktreesDir(root), area: sandboxDir(root), temp };
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), sandboxSettings('verify', cwd, paths, config, {}).settings);
  const argv = sandbox.wrap('command', cwd, ['git', '--no-pager', 'diff', '-c', '--', '.'], {})!;
  assert.deepEqual(argv.args.slice(3), ['--', 'git', '--no-pager', 'diff', '-c', '--', '.']);
  assert.equal(argv.args[2], file, 'verify and command share a policy, so they share its file');
  assert.notEqual(sandbox.wrap('setup', cwd, 'true', {})!.args[2], file, 'another policy, another file');
  assert.deepEqual([sandbox.writable(cwd), sandbox.writable(root), sandbox.writable(worktreesDir(root))], [true, false, false]);

  // Claude Code: its argv after `--`, untouched, and its transcript directory in the policy file.
  const opts = { prompt: 'p', systemPrompt: '[role:worker] s', cwd, logFile: '/dev/null', onEvent() {}, signal: new AbortController().signal, access: 'write' } as const;
  const claudeArgs = ['claude', ...buildClaudeArgs(opts, { writable: true })];
  const agent = sandbox.wrap('agent', cwd, claudeArgs, { PATH: '/usr/bin' }, { allowWrite: [join(root, 'transcripts')] })!;
  assert.deepEqual(agent.args.slice(3), ['--', ...claudeArgs]);
  assert.ok(claudeArgs.includes('{"sandbox":{"enabled":false}}'));
  assert.deepEqual(JSON.parse(readFileSync(agent.args[2]!, 'utf8')).filesystem.allowWrite, [cwd, temp, join(root, 'transcripts')]);
  sandbox.dispose();
  assert.ok(!existsSync(join(sandboxDir(root), 'run1')));

  const off = createSandbox(root, 'run2', config, { mode: 'off', active: false });
  assert.equal(off.wrap('verify', cwd, 'true', {}), undefined, 'inactive: commands run as they always did');
  assert.ok(!existsSync(join(sandboxDir(root), 'run2')), 'and nothing is written');
});

test('mode semantics: off, auto and required, where the runtime works and where it does not', (t) => {
  const root = repo(t);
  let calls = 0;
  const works = () => { calls++; return { ok: true }; };
  const broken = () => { calls++; return { ok: false, reason: 'Sandbox dependencies not available: socat not installed', fix: 'install socat: sudo pacman -S socat' }; };
  const off = sandboxStatus('off', { probe: works });
  assert.deepEqual([off.active, calls], [false, 0], 'a run with the sandbox off asks the runtime nothing');
  assert.deepEqual(sandboxNotice(off), ['sandbox off: agents and verify commands run with your privileges (dulger doctor explains the sandbox)']);
  assert.equal(sandboxCheck(off).status, 'warning');
  assert.match(sandboxCheck(sandboxStatus('off', { probe: works, probeOff: true })).detail, /^off: .*The runtime works here\./);
  assert.match(sandboxCheck(sandboxStatus('off', { probe: broken, probeOff: true })).detail, /When enabled, the runtime does not work here: Sandbox dependencies not available: socat not installed\. Fix: install socat/);
  assert.equal(createSandbox(root, 'r', policy(), off).wrap('verify', root, 'true', {}), undefined);

  for (const mode of ['auto', 'required'] as SandboxMode[]) {
    const on = sandboxStatus(mode, { probe: works });
    assert.equal(on.active, true, mode);
    assert.equal(sandboxCheck(on).status, 'pass');
    assert.deepEqual(sandboxNotice(on), [`sandbox ${mode}: Claude Code agents and verify, setup and API tool commands are confined to their worktree and granted hosts`]);
    assert.match(sandboxCheck(on).detail, /^\w+: Claude Code agents, verify commands, .* Codex agents are not wrapped: they keep Codex's own sandbox\.$/);
    assert.ok(createSandbox(root, 'r', policy({ mode }), on).wrap('verify', root, 'true', {}));
    const down = sandboxStatus(mode, { probe: broken });
    assert.equal(down.active, false, mode);
    for (const text of [sandboxCheck(down).detail, sandboxNotice(down).join('\n')]) assert.match(text, /socat not installed[\s\S]*install socat: sudo pacman -S socat/, mode);
  }
  const auto = sandboxStatus('auto', { probe: broken });
  assert.equal(sandboxCheck(auto).status, 'warning', 'auto: announced, and the run goes on unwrapped');
  assert.deepEqual(sandboxNotice(auto), ['sandbox unavailable (Sandbox dependencies not available: socat not installed): agents and verify, setup and API tool commands run with your privileges', 'sandbox fix: install socat: sudo pacman -S socat']);
  assert.equal(createSandbox(root, 'r', policy({ mode: 'auto' }), auto).wrap('verify', root, 'true', {}), undefined);
  const required = sandboxStatus('required', { probe: broken });
  assert.equal(sandboxCheck(required).status, 'error', 'required: no run starts');
  assert.throws(() => createSandbox(root, 'r', policy({ mode: 'required' }), required), /the sandbox is required, but Sandbox dependencies not available: socat not installed; install socat/, 'never unwrapped, even past preflight');
});

test('the policy comes from defaults, then the user\'s own file, then the flag or the session; never from the repository', (t) => {
  const root = repo(t);
  assert.deepEqual(loadConfig(root).sandbox, SANDBOX_DEFAULTS);
  userConfig(t, { sandbox: { mode: 'auto', allowWrite: ['~/.cargo/registry'], denyRead: ['/srv/secrets'], domains: { verify: ['index.crates.io', '*.npmjs.org', 'localhost:8080'] } }, harness: 'ignored for now' });
  const fromFile = loadConfig(root).sandbox;
  assert.deepEqual(fromFile, { mode: 'auto', allowWrite: [join(homedir(), '.cargo/registry')], allowRead: [], denyRead: ['/srv/secrets'], domains: { setup: [], verify: ['index.crates.io', '*.npmjs.org', 'localhost:8080'], agent: [] } });
  assert.equal(loadConfig(root).harness, 'claude', 'only the sandbox key is read from the user file');
  assert.deepEqual(loadConfig(root, {}, 'required').sandbox, { ...fromFile, mode: 'required' }, 'the flag sets the mode, the file the rest');
  const session: Session = { overrides: {}, yes: false, quiet: false, allowDirty: false, sandbox: 'off' };
  assert.equal(sessionConfig(root, session).sandbox.mode, 'off');

  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger', 'config.json'), JSON.stringify({ concurrency: 5, sandbox: { mode: 'off', allowWrite: ['/'] } }));
  const withRepoKey = loadConfig(root);
  assert.equal(withRepoKey.concurrency, 5);
  assert.deepEqual(withRepoKey.sandbox, fromFile, 'the repository\'s sandbox key is ignored');
  assert.deepEqual(loadConfig(root, { sandbox: policy({ allowWrite: ['/'] }) }).sandbox, fromFile, 'so is one in overrides (a profile is one)');

  for (const [sandbox, error] of [
    [{ mode: 'yes' }, /sandbox\.mode is off, auto or required/],
    [{ allowwrite: [] }, /sandbox\.allowwrite is not a sandbox setting/],
    [{ allowWrite: ['relative/dir'] }, /"relative\/dir" must be an absolute path or start with ~\//],
    [{ allowWrite: ['/tmp/*'] }, /is a pattern; writes take literal paths/],
    [{ denyRead: '/x' }, /sandbox\.denyRead must be a list of strings/],
    [{ domains: { verify: ['https://example.com'] } }, /"https:\/\/example\.com" is not a host/],
    [{ domains: { build: [] } }, /sandbox\.domains\.build is not a kind/],
  ] as const) {
    userConfig(t, { sandbox });
    assert.throws(() => loadConfig(root), error, JSON.stringify(sandbox));
  }
  userConfig(t, '{ broken');
  assert.throws(() => loadConfig(root), /config\.json: /);
});

test('a sandbox key in the repository is reported by doctor and at run start, and /config save never writes one', async (t) => {
  const root = repo(t);
  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger', 'config.json'), JSON.stringify({ sandbox: { mode: 'off' } }));
  const checks = preflight(root, base, { forRun: true });
  assert.match(checks.find((c) => c.label === 'Repository sandbox key')?.detail ?? '', /\.dulger\/config\.json sets "sandbox"; it is ignored/);
  assert.equal(checks.find((c) => c.label === 'Repository sandbox key')?.status, 'warning');
  assert.match(checks.find((c) => c.label === 'Sandbox')!.detail, /^off: agents, verify commands/);
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, delayMs: 1 }));
  const logs: string[] = [];
  createOrchestrator(root, createBoard(root, 'goal', 'keyed'), base, { log: (m) => logs.push(strip(m)) });
  assert.equal(logs.filter((l) => l.startsWith('sandbox off: ')).length, 1, 'the state, once');
  assert.equal(logs.filter((l) => /\.dulger\/config\.json sets "sandbox", which dulger ignores: the sandbox policy is yours/.test(l)).length, 1);

  const plain = repo(t);
  const { command } = await import('../src/repl.ts');
  const out: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => out.push(strip(args.join(' '))));
  const session: Session = { overrides: { concurrency: 2, sandbox: policy({ mode: 'required' }) }, yes: false, quiet: false, allowDirty: false };
  await command('/sandbox auto', plain, session);
  assert.equal(session.sandbox, 'auto');
  assert.match(out.at(-1)!, /· sandbox auto/);
  await command('/set sandbox required', plain, session);
  await command('/sandbox', plain, session);
  assert.equal(out.at(-1), 'sandbox required');
  await assert.rejects(command('/sandbox maybe', plain, session), /sandbox is off, auto or required/);
  await command('/config save', plain, session);
  const saved = JSON.parse(readFileSync(join(plain, '.dulger', 'config.json'), 'utf8'));
  assert.equal(saved.concurrency, 2);
  assert.ok(!('sandbox' in saved), 'neither the session mode nor an override reaches the repository');
});

test('run snapshots, setting changes and resume never carry the sandbox', async (t) => {
  const strict: Config = { ...base, sandbox: policy({ mode: 'required', allowWrite: ['/x'] }) };
  const snapshot = snapshotSettings(strict);
  assert.ok(!('sandbox' in snapshot.config));
  const relaxed: Config = { ...strict, sandbox: policy() };
  assert.deepEqual(settingsChanges(strict, relaxed), []);
  const edited = { settings: { version: 1, config: { ...snapshot.config, sandbox: policy({ mode: 'off', allowWrite: ['/'] }) } } } as unknown as Board;
  assert.deepEqual(originalSettings(edited, strict).sandbox, strict.sandbox, 'a hand-edited board does not set it either');
  assert.equal(originalSettings({ settings: snapshot } as Board, strict).sandbox, strict.sandbox, 'an old board without the key gets the current one');

  const root = repo(t);
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, checker: () => ({ pass: true, feedback: [], summary: 'ok' }), delayMs: 1 }));
  const out: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => out.push(strip(args.join(' '))));
  const b = createBoard(root, 'resume me', 'resumed');
  await runBoard(root, b, base, { yes: true, quiet: true, merge: false, fresh: true });
  assert.ok(!('sandbox' in store.loadBoard(root, b.runId).settings!.config));
  // A board edited to demand a policy of its own resumes under the machine's.
  const file = store.boardPath(root, b.runId);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.settings.config.sandbox = policy({ mode: 'required', allowWrite: ['/'] });
  writeFileSync(file, JSON.stringify(saved));
  out.length = 0;
  await resumeRun(root, base, b.runId, { quiet: true, merge: false });
  assert.ok(out.some((l) => l.includes('sandbox off: ')), out.join('\n'));
  assert.ok(!('sandbox' in store.loadBoard(root, b.runId).settings!.config), 'and the resume saves none');
});

test('the pinned runtime version is the one package.json pins and node_modules holds', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@anthropic-ai/sandbox-runtime'], SANDBOX_RUNTIME_VERSION);
  const installed = JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/sandbox-runtime/package.json', import.meta.url), 'utf8'));
  assert.equal(installed.version, SANDBOX_RUNTIME_VERSION);
});

test('scrubbing removes only untracked, empty placeholders', (t) => {
  const root = repo(t, { 'README.md': 'hi\n', '.gitmodules': '', '.claude/settings.json': '{}\n' });
  const touch = (p: string, content = '') => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), content); };
  for (const p of ['.bashrc', '.idea', '.mcp.json', 'notes.txt']) touch(p);
  touch('.zshrc', 'alias ll="ls -l"\n');
  for (const d of ['.vscode', '.claude/commands', '.claude/agents', 'empty-dir']) mkdirSync(join(root, d), { recursive: true });
  symlinkSync('/dev/null', join(root, '.profile'));
  assert.deepEqual(scrubPlaceholders(root).sort(), ['.bashrc', '.claude/agents', '.claude/commands', '.idea', '.mcp.json', '.vscode']);
  const left = readdirSync(root).sort();
  assert.deepEqual(left, ['.claude', '.git', '.gitmodules', '.profile', '.zshrc', 'README.md', 'empty-dir', 'notes.txt'], 'tracked, non-empty, links and unrelated files survive');
  assert.deepEqual(readdirSync(join(root, '.claude')), ['settings.json']);

  const fresh = repo(t);
  mkdirSync(join(fresh, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(fresh, '.claude', 'agents'));
  assert.deepEqual(scrubPlaceholders(fresh), ['.claude/commands', '.claude/agents', '.claude'], 'a .claude holding only the two empty directories goes');
  const kept = repo(t);
  mkdirSync(join(kept, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(kept, '.claude', 'notes.md'), 'mine');
  assert.deepEqual(scrubPlaceholders(kept), ['.claude/commands']);
  assert.ok(existsSync(join(kept, '.claude', 'notes.md')));
});

test('a run resumed without the sandbox still scrubs what a killed srt left; a run that never used the sandbox is not scrubbed', (t) => {
  const root = repo(t);
  const leave = () => { writeFileSync(join(root, '.bashrc'), ''); mkdirSync(join(root, '.vscode'), { recursive: true }); };
  const off = { mode: 'off', active: false } as const;
  leave();
  assert.deepEqual(createSandbox(root, 'never', policy(), off).scrub(root), [], 'never wrapped: left as it always was');
  assert.deepEqual(untracked(root), ['?? .bashrc'], 'and git sees what it saw before');

  // A command of this run was wrapped, and dulger was killed while srt ran it.
  createSandbox(root, 'killed', policy({ mode: 'auto' }), { mode: 'auto', active: true, available: true }).wrap('verify', root, 'true', {});
  const resumed = createSandbox(root, 'killed', policy(), off);
  assert.deepEqual(resumed.scrub(root).sort(), ['.bashrc', '.vscode'], 'resumed with the sandbox off');
  assert.deepEqual(untracked(root), []);
  resumed.dispose();
  leave();
  assert.deepEqual(resumed.scrub(root), [], 'a finished run has no directory left, and nothing to scrub');
});

test('required mode: preflight refuses a run where the runtime does not work, before any planning; it starts where it does', async (t) => {
  const root = repo(t);
  const required: Config = { ...base, sandbox: policy({ mode: 'required' }) };
  const probe = probeSandbox();
  if (probe.ok) { assert.doesNotThrow(() => requirePreflight(root, required)); return; }
  assert.throws(() => requirePreflight(root, required), (err: Error) => err.message.includes('FIX Sandbox: required, but the runtime does not work here: ') && err.message.includes(probe.reason!) && err.message.includes(probe.fix!));
  let planned = 0;
  registerAdapter('fake', createFakeAdapter({ ...DEFAULT_FAKE_SCRIPT, planner: () => { planned++; return DEFAULT_FAKE_SCRIPT.planner as never; }, delayMs: 1 }));
  t.mock.method(console, 'log', () => {});
  await assert.rejects(runBoard(root, createBoard(root, 'refused', 'refused'), required, { yes: true, quiet: true, merge: false, fresh: true }), /FIX Sandbox: required/);
  assert.equal(planned, 0, 'no agent was asked anything');
});

// ---- real: srt runs these, so they need bubblewrap, socat and ripgrep (Linux) ---------------------

const probe = probeSandbox();
const real = probe.ok ? {} : { skip: `the sandbox runtime does not work here (${probe.reason}); ${probe.fix}` };
const probeName = () => join(homedir(), `dulger-sandbox-test-probe-${randomBytes(6).toString('hex')}`);
const sockets = () => new Set(readdirSync(tmpdir()).filter((n) => /^(claude-(http|socks)|srt-mux)-.*\.sock$/.test(n)));
const running = (pattern: string) => spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.trim();
const bridges = () => new Set(running('socat UNIX-LISTEN:').split('\n').filter(Boolean));
const leftovers = (before: { sockets: Set<string>; bridges: Set<string> }) => ({
  sockets: [...sockets()].filter((s) => !before.sockets.has(s)),
  bridges: [...bridges()].filter((p) => !before.bridges.has(p)),
});
const untracked = (cwd: string) => git.git(cwd, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).sort();

function sandboxed(t: TestContext) {
  const root = repo(t, { 'README.md': 'hello\n', '.claude/settings.json': '{}\n', '.husky/pre-commit': 'npm test\n' });
  const runId = `real-${randomBytes(3).toString('hex')}`;
  const cwd = store.worktreeDir(root, runId, 'c1');
  const sibling = store.worktreeDir(root, runId, 'c2');
  git.createWorktree(root, cwd, `dulger-wip/${runId}/c1`, 'HEAD');
  git.createWorktree(root, sibling, `dulger-wip/${runId}/c2`, 'HEAD');
  writeFileSync(join(sibling, 'sibling.txt'), 'sibling secret');
  const secrets = mkdtempSync(join(tmpdir(), 'dulger-sandbox-secret-'));
  writeFileSync(join(secrets, 'secret.txt'), 'top secret');
  mkdirSync(join(configHome, 'dulger'), { recursive: true });
  writeFileSync(join(configHome, 'dulger', 'keys.json'), '{"SOME_KEY":"key secret"}');
  const sandbox = createSandbox(root, runId, policy({ mode: 'required', denyRead: [secrets] }));
  t.after(() => { sandbox.dispose(); rmSync(secrets, { recursive: true, force: true }); rmSync(join(worktreesDir(root), runId), { recursive: true, force: true }); });
  return { root, runId, cwd, sibling, secrets, sandbox };
}

test('in the sandbox a verify command writes its worktree and its temp dir, and nothing it must not', real, async (t) => {
  const { root, runId, cwd, sibling, secrets, sandbox } = sandboxed(t);
  const home = probeName();
  t.after(() => rmSync(home, { force: true }));
  const r = await runVerification(cwd, [
    'echo in-tree > written.txt && cat written.txt',
    't=$(mktemp) && echo temp > "$t" && cat "$t" && echo "$t"',
    `echo escaped > ${home}`,
    `cat ${join(secrets, 'secret.txt')}`,
    `cat ${join(sibling, 'sibling.txt')}`,
    `cat ${join(configHome, 'dulger', 'keys.json')}`,
    'echo changed >> .claude/settings.json',
    'echo changed > .husky/pre-commit',
    'echo changed > ../c2/sibling.txt',
    'exit 3',
  ], { timeoutSec: 60, sandbox, env: childEnv() });
  assert.deepEqual(r.map((x) => x.ok), [true, true, false, false, false, false, false, false, false, false], r.map((x) => `${x.command}: ${x.output}`).join('\n'));
  assert.equal(readFileSync(join(cwd, 'written.txt'), 'utf8'), 'in-tree\n');
  const temp = r[1]!.output.split('\n').at(-1)!;
  assert.ok(temp.startsWith(join(sandboxDir(root), runId, 'tmp', 'c1') + '/'), `mktemp gave ${temp}`);
  assert.ok(!existsSync(home), 'nothing was written to $HOME');
  for (const i of [3, 4, 5]) assert.doesNotMatch(r[i]!.output, /top secret|sibling secret|key secret/, r[i]!.command);
  assert.equal(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'), '{}\n', 'in-tree hook locations stay read-only');
  assert.equal(readFileSync(join(cwd, '.husky', 'pre-commit'), 'utf8'), 'npm test\n');
  assert.equal(readFileSync(join(sibling, 'sibling.txt'), 'utf8'), 'sibling secret');
  assert.equal(r[9]!.exitCode, 3, 'exit codes pass through');
  assert.deepEqual(untracked(cwd), ['?? written.txt'], 'no placeholder is left after a clean exit');
});

test('in the sandbox a verify command gets no network unless granted', real, async (t) => {
  const { cwd, sandbox } = sandboxed(t);
  let connections = 0;
  const server = createServer((s) => { connections++; s.on('error', () => {}); s.end('hello'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const reach = `node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (e) => { console.log('refused', e.code); process.exit(1); })"`;
  assert.equal((await runVerification(cwd, [reach], { timeoutSec: 30, env: childEnv() }))[0]!.ok, true, 'outside the sandbox the host is reachable');
  connections = 0;
  const [inside] = await runVerification(cwd, [reach], { timeoutSec: 30, sandbox, env: childEnv() });
  assert.equal(inside!.ok, false, inside!.output);
  assert.doesNotMatch(inside!.output, /connected/);
  assert.equal(connections, 0);
});

test('a sandboxed verify command that runs too long is stopped, and nothing is left behind', real, async (t) => {
  const { root, runId, cwd, sandbox } = sandboxed(t);
  const before = { sockets: sockets(), bridges: bridges() };
  const started = Date.now();
  const r = await runVerification(cwd, ['sleep 37', "trap '' TERM; sleep 37"], { timeoutSec: 1, sandbox, env: childEnv() });
  for (const x of r) {
    assert.deepEqual([x.ok, x.exitCode], [false, -1], x.command);
    assert.match(x.output, /killed after 1s/);
    assert.ok(x.durationMs < 5000, `${x.command} took ${x.durationMs}ms`);
  }
  assert.ok(Date.now() - started < 10_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(untracked(cwd), [], 'no placeholder files');
  assert.equal(running('sleep 37'), '', 'no command survived');
  assert.equal(running(join(sandboxDir(root), runId)), '', 'no srt survived');
  assert.deepEqual(leftovers(before), { sockets: [], bridges: [] }, 'no proxy socket or socat bridge left');
});

test('the API tools\' shell and git run in the sandbox, are stopped with SIGTERM first, and leave nothing', real, async (t) => {
  const { cwd, sandbox } = sandboxed(t);
  const home = probeName();
  t.after(() => rmSync(home, { force: true }));
  const opts: AdapterRunOptions = { cwd, prompt: '', systemPrompt: '', access: 'write', logFile: join(cwd, '..', 'api.log'), signal: new AbortController().signal, onEvent: () => {}, commandEnv: childEnv(), sandbox };
  const out = await executeApiTool('run_command', { command: `echo api > api.txt && t=$(mktemp) && echo "temp $t" && (echo x > ${home}) 2>/dev/null || echo home-denied` }, opts);
  assert.match(out, /^exit 0\ntemp .*\/tmp\/c1\/tmp\.\w+\nhome-denied\n$/);
  assert.ok(existsSync(join(cwd, 'api.txt')) && !existsSync(home));
  assert.equal(await executeApiTool('run_command', { command: 'exit 4' }, opts), 'exit 4\n');
  writeFileSync(join(cwd, 'README.md'), 'changed\n');
  assert.match(await executeApiTool('git_diff', {}, opts), /-hello\n\+changed/, 'git works read-only inside');

  const before = { sockets: sockets(), bridges: bridges() };
  const started = Date.now();
  const late = await executeApiTool('run_command', { command: 'sleep 38; echo late' }, opts, 1);
  assert.match(late, /^exit -1 \(cancelled or timed out\)\n/);
  assert.ok(!late.includes('late') && Date.now() - started < 5000);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 700);
  assert.match(await executeApiTool('run_command', { command: 'sleep 38' }, { ...opts, signal: ctrl.signal }), /cancelled or timed out/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(untracked(cwd), [' M README.md', '?? api.txt'], 'no placeholder files');
  assert.equal(running('sleep 38'), '');
  assert.deepEqual(leftovers(before), { sockets: [], bridges: [] });
});

test('a run with the sandbox required sets up, verifies and lands in it, commits no placeholder, and cleans up', real, async (t) => {
  const root = repo(t);
  const home = probeName();
  t.after(() => rmSync(home, { force: true }));
  const verify = `test -f setup.out && t=$(mktemp) && ! (echo x > ${home}) 2>/dev/null`;
  registerAdapter('fake', createFakeAdapter({
    ...DEFAULT_FAKE_SCRIPT, delayMs: 1, checker: () => ({ pass: true, feedback: [], summary: 'ok' }),
    planner: { cards: [{ id: 'c1', title: 'One', description: '', acceptanceCriteria: [], dependsOn: [], verify: [verify], tasks: [{ id: 't1', title: 'Write', instructions: 'Write' }] }] },
  }));
  const config: Config = { ...base, worktreeSetup: 'echo set > setup.out', sandbox: policy({ mode: 'required' }) };
  const board = createBoard(root, 'sandboxed', 'sandboxed');
  const logs: string[] = [];
  const orch = createOrchestrator(root, board, config, { log: (m) => logs.push(strip(m)) });
  await orch.plan();
  await orch.execute();
  const c1 = board.cards[0]!;
  assert.equal(c1.status, 'done', `${c1.reason} ${JSON.stringify(c1.verification)}`);
  assert.equal(c1.verification![0]!.ok, true);
  assert.equal(board.finalVerification!.results[0]!.ok, true, board.finalVerification!.results[0]!.output);
  assert.ok(!existsSync(home));
  assert.equal(logs.filter((l) => l.startsWith('sandbox required: ')).length, 1);
  const files = git.git(root, ['ls-tree', '-r', '--name-only', 'dulger/sandboxed']).split('\n');
  assert.deepEqual(files.filter((f) => f.startsWith('.')), [], `no placeholder was committed: ${files.join(', ')}`);
  assert.ok(!existsSync(join(sandboxDir(root), 'sandboxed')), 'the finished run removed its settings and temp dirs');
});

// ---- real: Claude Code in the sandbox, played by test/fixtures/fake-claude.mjs ------------------

/** A copy of the stand-in under a path of its own (so pgrep finds only this test's), and a Claude config dir. */
function fakeClaude(t: TestContext): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dulger-sandbox-claude-'));
  writeFileSync(join(dir, 'fake-claude.mjs'), readFileSync(new URL('./fixtures/fake-claude.mjs', import.meta.url)));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });
  const saved = { bin: process.env.DULGER_CLAUDE_BIN, config: process.env.CLAUDE_CONFIG_DIR };
  process.env.DULGER_CLAUDE_BIN = join(dir, 'claude');
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config');
  t.after(() => {
    for (const [key, value] of [['DULGER_CLAUDE_BIN', saved.bin], ['CLAUDE_CONFIG_DIR', saved.config]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config: join(dir, 'config') };
}

type FakeReport = { stdin: string; cwd: string; argv: string[]; tmpdir: string; transcript: string; memory: string; temp: string; writes: Record<string, string>; reads: Record<string, string>; network?: string };
const claudeCall = (cwd: string, sandbox: AdapterRunOptions['sandbox'], extra: Partial<AdapterRunOptions> = {}) => claudeAdapter.run({
  prompt: '{}', systemPrompt: '[role:worker] w', cwd, access: 'write', schema: { type: 'object' }, logFile: join(cwd, '..', 'claude.jsonl'), onEvent: () => {}, signal: new AbortController().signal, sandbox, ...extra,
});

test('in the sandbox a Claude Code agent gets its prompt and worktree, writes there, to its temp dir and its transcript, and nothing it must not', real, async (t) => {
  const { root, runId, cwd, sibling, secrets, sandbox } = sandboxed(t);
  fakeClaude(t);
  const home = probeName();
  t.after(() => rmSync(home, { force: true }));
  let connections = 0;
  const server = createServer((s) => { connections++; s.on('error', () => {}); s.end('hello'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const prompt = JSON.stringify({
    write: ['in-tree.txt', home, join(sibling, 'sibling.txt'), join(root, 'checkout.txt'), '.bashrc'],
    read: [join(secrets, 'secret.txt'), join(sibling, 'sibling.txt'), join(configHome, 'dulger', 'keys.json')],
    connect: (server.address() as AddressInfo).port,
  });
  const r = await claudeCall(cwd, sandbox, { prompt });
  assert.equal(r.ok, true, r.error);
  const report = r.output as FakeReport;
  assert.deepEqual([report.stdin, report.cwd], [prompt, cwd], 'the prompt on stdin, the worktree as cwd');
  assert.ok(report.argv.includes('{"sandbox":{"enabled":false}}'), 'Claude Code\'s own sandbox is off inside');
  assert.ok(report.tmpdir.startsWith(join(sandboxDir(root), runId, 'tmp', 'c1')) && report.temp === 'ok', report.tmpdir);
  assert.equal(report.writes['in-tree.txt'], 'ok');
  for (const p of [home, join(sibling, 'sibling.txt'), join(root, 'checkout.txt'), '.bashrc']) assert.notEqual(report.writes[p], 'ok', p);
  assert.ok(!existsSync(home) && !existsSync(join(root, 'checkout.txt')));
  assert.equal(readFileSync(join(sibling, 'sibling.txt'), 'utf8'), 'sibling secret');
  for (const [p, got] of Object.entries(report.reads)) assert.doesNotMatch(got, /top secret|sibling secret|key secret/, p);
  assert.notEqual(report.network, 'connected');
  assert.equal(connections, 0, 'no unlisted host, localhost included');
  assert.equal(report.transcript, 'ok');
  assert.ok(existsSync(join(claudeProjectDir(cwd), `${r.sessionId}.jsonl`)), 'the transcript is where dulger made room for it');
  assert.deepEqual(untracked(cwd), ['?? in-tree.txt'], 'no placeholder is left after a clean exit');

  const resumed = await claudeCall(cwd, sandbox, { resumeSessionId: r.sessionId });
  assert.deepEqual([resumed.ok, resumed.sessionId], [true, r.sessionId], 'the saved session can be resumed');
  assert.ok((resumed.output as FakeReport).argv.includes('--resume'));
});

test('in the sandbox the planner reads your checkout, writes nothing there nor in its auto-memory, and leaves no placeholder in it', real, async (t) => {
  const { root, sandbox } = sandboxed(t);
  fakeClaude(t);
  const call = claudeCall(root, sandbox, { prompt: JSON.stringify({ write: ['planner.txt'], read: ['README.md'], sleepMs: 1500 }), systemPrompt: '[role:planner] p', access: 'readonly' });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(untracked(root), [], 'nothing appears in the checkout while it runs');
  const r = await call;
  assert.equal(r.ok, true, r.error);
  const report = r.output as FakeReport;
  assert.deepEqual([report.reads['README.md'], report.writes['planner.txt'], report.transcript], ['hello\n', 'EROFS', 'ok']);
  assert.notEqual(report.memory, 'ok', 'the auto-memory your own sessions here read stays read-only');
  assert.deepEqual(readdirSync(join(claudeProjectDir(root), 'memory')), []);
  assert.deepEqual(untracked(root), []);
});

test('in the sandbox the planner cannot change the sessions already in its transcript directory, but adds its own and continues the one it resumes', real, async (t) => {
  const { root, sandbox } = sandboxed(t);
  fakeClaude(t);
  const own = claudeProjectDir(root);
  mkdirSync(join(own, 'yours'), { recursive: true });
  writeFileSync(join(own, 'yours.jsonl'), 'your session\n');
  writeFileSync(join(own, 'yours', 'tool-result.txt'), 'yours\n');
  const resume = randomUUID();
  writeFileSync(join(own, `${resume}.jsonl`), '{"earlier":true}\n');
  const tries = [join(own, 'yours.jsonl'), join(own, 'yours', 'tool-result.txt'), join(own, 'yours', 'added.txt'), join(own, 'added.jsonl')];
  const r = await claudeCall(root, sandbox, { prompt: JSON.stringify({ write: tries }), systemPrompt: '[role:planner] p', access: 'readonly', resumeSessionId: resume });
  assert.equal(r.ok, true, r.error);
  const report = r.output as FakeReport;
  assert.deepEqual(tries.map((p) => report.writes[p] === 'ok'), [false, false, false, true], JSON.stringify(report.writes));
  assert.deepEqual([readFileSync(join(own, 'yours.jsonl'), 'utf8'), readFileSync(join(own, 'yours', 'tool-result.txt'), 'utf8')], ['your session\n', 'yours\n']);
  assert.ok(!existsSync(join(own, 'yours', 'added.txt')));
  assert.equal(readFileSync(join(own, 'added.jsonl'), 'utf8'), 'written by fake claude\n', 'a new file can be created, as a new session must');
  assert.deepEqual([r.sessionId, report.transcript, readFileSync(join(own, `${resume}.jsonl`), 'utf8')], [resume, 'ok', '{"earlier":true}\n{}\n'], 'the resumed session is appended to');
});

test('a sandboxed Claude Code agent that is stopped gets SIGTERM, fails, and leaves no process, socket or placeholder', real, async (t) => {
  const { cwd, sandbox } = sandboxed(t);
  const { dir } = fakeClaude(t);
  const before = { sockets: sockets(), bridges: bridges() };
  const ctrl = new AbortController();
  let placeholders: string[] = [];
  let groups: string[] = [];
  let abortedAt = 0;
  const pgid = (pid: string | number) => spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  setTimeout(() => {
    placeholders = untracked(cwd);
    groups = running(`sandbox-runtime/dist/cli\\.js --settings .* -- ${join(dir, 'claude')}`).split('\n').filter(Boolean).map(pgid);
    abortedAt = Date.now();
    ctrl.abort();
  }, 1500);
  const r = await claudeCall(cwd, sandbox, { prompt: JSON.stringify({ sleepMs: 60_000 }), signal: ctrl.signal });
  assert.deepEqual([r.ok, r.error], [false, 'aborted']);
  assert.ok(placeholders.includes('?? .bashrc'), `it was running in the sandbox: ${placeholders.join(', ')}`);
  assert.deepEqual(groups, [pgid(process.pid)], 'srt is in dulger\'s process group, so a closed terminal\'s hangup reaches it');
  assert.ok(Date.now() - abortedAt < STOP_GRACE_MS, `srt passed the SIGTERM on and ended before the SIGKILL (${Date.now() - abortedAt}ms)`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(running(dir), '', 'no process survived');
  assert.deepEqual(leftovers(before), { sockets: [], bridges: [] });
  assert.deepEqual(untracked(cwd), [], 'srt removed its placeholders');
});
