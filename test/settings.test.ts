// The session settings table: every key reads back what it was given, bad values are refused without
// touching the session, the prompt's words map onto the same table, and a session's changes against
// the repository are detected.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_SETTINGS, SETTING_GROUPS, applySetting, findSetting, formatSetting, parseSetting, readSetting, rolesAffected, routerOptions, routerUnset, sessionChanges,
  settingOptions, type SettingKey, type SettingValue,
} from '../src/settings.ts';
import { plannedSave, saveSessionConfig, saveUserConfig, sessionConfig, setRoleAuto, setRoleModel } from '../src/replModels.ts';
import { loadConfig, roleConfig } from '../src/config.ts';
import { defineProvider } from '../src/replProviders.ts';
import { command, type Session } from '../src/repl.ts';
import { SETTING_KEYS } from '../src/replCommands.ts';
import { CliError } from '../src/errors.ts';
import { userConfigFile } from '../src/sandbox.ts';

// The sandbox mode, roles and providers come from the user's own config file: keep the real one out of these tests.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-settings-home-'));

function repo(t: TestContext, stored: object = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dulger-settings-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(userConfigFile(), { force: true }); });
  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify(stored));
  return root;
}
const fresh = (): Session => ({ overrides: {}, yes: false, quiet: false, allowDirty: false });

const SAMPLES: { [K in SettingKey]: Array<SettingValue<K>> } = {
  harness: ['codex', 'fake', 'claude'], concurrency: [1, 7], attempts: [1, 4], replans: [0, 3], docs: [false, true],
  progress: [undefined, 45, 120], yes: [true, false], quiet: [true, false], dirty: [true, false], tui: [false, true],
  icons: ['ascii', 'nerd', 'auto'], mouse: [false, true], routing: [false, true], budget: [12.5, undefined],
  'card-budget': [3, undefined], sandbox: ['auto', 'required', 'off'], router: ['jev-local', 'jev-openrouter', 'planner'],
};

test('every setting reads back each value it is given, through the effective config', (t) => {
  const root = repo(t);
  assert.deepEqual(Object.keys(SAMPLES).sort(), SESSION_SETTINGS.map((s) => s.key).sort(), 'the samples cover the whole table');
  for (const s of SESSION_SETTINGS) {
    const session = fresh();
    for (const value of SAMPLES[s.key] as SettingValue[]) {
      applySetting(session, sessionConfig(root, session), s.key, value);
      assert.deepEqual(readSetting(session, sessionConfig(root, session), s.key), value, `${s.key} = ${String(value)}`);
    }
  }
});

test('the table describes every setting the prompt has, mouse included, in groups', () => {
  assert.deepEqual(SETTING_KEYS.filter((k) => k !== 'model'), SESSION_SETTINGS.map((s) => s.key));
  for (const s of SESSION_SETTINGS) {
    assert.ok(s.label && s.description, s.key);
    assert.ok(SETTING_GROUPS.includes(s.group), s.key);
  }
  assert.deepEqual(SESSION_SETTINGS.filter((s) => s.scope === 'session').map((s) => s.key), ['yes', 'quiet', 'dirty', 'sandbox']);
  const mouse = findSetting('mouse')!;
  assert.equal(mouse.kind, 'toggle');
  assert.equal(readSetting(fresh(), sessionConfig(mkdtempSync(join(tmpdir(), 'dulger-plain-')), fresh()), 'mouse'), true, 'on by default');
  const concurrency = findSetting('concurrency')!;
  assert.ok(concurrency.kind === 'count' && concurrency.min === 1);
  const icons = findSetting('icons')!;
  assert.deepEqual(settingOptions(icons, sessionConfig(mkdtempSync(join(tmpdir(), 'dulger-plain-')), fresh())).map((o) => o.value), ['nerd', 'unicode', 'ascii', 'auto']);
  assert.equal(findSetting('model'), undefined, 'models have their own API');
});

test('session-only settings never reach overrides, and repository settings never touch the session flags', (t) => {
  const root = repo(t);
  for (const s of SESSION_SETTINGS) {
    const session = fresh();
    applySetting(session, sessionConfig(root, session), s.key, SAMPLES[s.key][0] as SettingValue);
    const { overrides, ...flags } = session;
    if (s.scope === 'session') assert.deepEqual(overrides, {}, s.key);
    else assert.deepEqual(flags, { yes: false, quiet: false, allowDirty: false }, s.key);
  }
});

test('bad values are refused with a message a form can show, and leave the session as it was', (t) => {
  const root = repo(t);
  const bad: Array<[SettingKey, unknown, RegExp]> = [
    ['docs', 'on', /^docs takes on or off$/], ['mouse', 1, /^mouse takes on or off$/],
    ['concurrency', 0, /^concurrency is at least 1$/], ['attempts', -1, /^attempts takes a whole number$/], ['replans', 1.5, /^replans takes a whole number$/],
    ['budget', 0, /^budget takes dollars or off$/], ['card-budget', -2, /^card-budget takes dollars or off$/], ['budget', Number.NaN, /dollars or off/],
    ['progress', -5, /^progress takes a whole number$/], ['progress', 2.5, /whole number/],
    ['harness', 'nope', /^harness is one of claude, codex, fake, ollama, deepseek, openai$/],
    ['icons', 'emoji', /^icons is nerd, unicode, ascii or auto$/], ['sandbox', 'maybe', /^sandbox is off, auto or required$/],
  ];
  for (const [key, value, message] of bad) {
    const session = fresh();
    const before = structuredClone(session);
    assert.throws(() => applySetting(session, sessionConfig(root, session), key, value as SettingValue), (e: unknown) => e instanceof CliError && message.test(e.message), `${key} ${String(value)}`);
    assert.deepEqual(session, before, key);
  }
  assert.throws(() => readSetting(fresh(), sessionConfig(root, fresh()), 'nope' as SettingKey), /unknown setting "nope"/);
});

test('the prompt words parse into the same typed values, with the prompt\'s own rules', () => {
  assert.equal(parseSetting('docs', 'YES'), true);
  assert.equal(parseSetting('mouse', 'off'), false);
  assert.throws(() => parseSetting('mouse', 'maybe'), { message: 'mouse takes on or off' });
  assert.equal(parseSetting('concurrency', '0'), 1, '/concurrency 0 is raised to the minimum, as before');
  assert.equal(parseSetting('replans', '0'), 0);
  assert.throws(() => parseSetting('attempts', '-1'), /attempts takes a whole number/);
  assert.equal(parseSetting('progress', 'on'), 120, 'on restores the default interval');
  assert.equal(parseSetting('progress', 'no'), undefined);
  assert.equal(parseSetting('progress', '30'), 30);
  assert.equal(parseSetting('budget', 'off'), undefined);
  assert.equal(parseSetting('budget', '2.5'), 2.5);
  assert.throws(() => parseSetting('card-budget', 'free'), /card-budget takes dollars or off/);
  assert.equal(parseSetting('icons', 'emoji'), 'emoji', 'a choice is checked when it is applied');
  assert.equal(formatSetting('progress', 45), '45s');
  assert.equal(formatSetting('progress', undefined), 'off');
  assert.equal(formatSetting('budget', 12.5), '$12.5');
  assert.equal(formatSetting('mouse', false), 'off');
  assert.equal(formatSetting('replans', 0), '0');
});

test('/mouse is a setting like its siblings, and changing one view field keeps what the repository set for the others', async (t) => {
  const root = repo(t, { tui: { enabled: false, icons: 'nerd' }, routing: { models: { codex: { low: 'my-luna' } } } });
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args.join(' ')));
  const session = fresh();
  await command('/mouse off', root, session);
  assert.equal(sessionConfig(root, session).tui.mouse, false);
  await command('/mouse', root, session);
  assert.match(output.at(-1)!, /^mouse .*off/);
  await command('/set mouse on', root, session);
  assert.equal(sessionConfig(root, session).tui.mouse, true);
  await assert.rejects(command('/mouse maybe', root, session), /mouse takes on or off/);
  await command('/icons ascii', root, session);
  await command('/routing off', root, session);
  const config = sessionConfig(root, session);
  assert.deepEqual(config.tui, { enabled: false, icons: 'ascii', mouse: true }, 'the view stays off');
  assert.equal(config.routing.models.codex?.low, 'my-luna', 'the repository\'s tier survives /routing off');
  await command('/config save', root, session);
  assert.match(output.at(-1)!, /\(yes, quiet, dirty and sandbox remain session-only\)/);
  const saved = JSON.parse(readFileSync(join(root, '.dulger/config.json'), 'utf8'));
  assert.equal(saved.routing.models.codex.low, 'my-luna');
  assert.equal(saved.tui.enabled, false);
});

test('the router: the first start\'s choices, next to the Routing switch, changing only who tags the tasks, saved to the user\'s file', (t) => {
  const root = repo(t, { routing: { enabled: false, models: { codex: { low: 'my-luna' } } } });
  const session = fresh();
  const router = findSetting('router')!;
  assert.ok(router.kind === 'choice' && router.group === 'Execution' && router.scope === 'repository');
  assert.equal(SESSION_SETTINGS[SESSION_SETTINGS.indexOf(findSetting('routing')!) + 1], router);
  assert.equal(readSetting(session, sessionConfig(root, session), 'router'), 'planner', 'the planner until someone chooses');
  assert.deepEqual(routerOptions('codex').map((o) => [o.value, o.label, o.description]), [
    ['planner', 'Planner (codex)', "the planner's own tags"],
    ['jev-openrouter', 'Jev · OpenRouter', 'OPENROUTER_API_KEY'],
    ['jev-typesafe', 'Jev · TypeSafe', 'TYPESAFE_API_KEY'],
    ['jev-local', 'Jev · local', 'http://127.0.0.1:8080'],
  ]);
  assert.deepEqual(settingOptions(router, sessionConfig(root, session)), routerOptions('claude'), 'Settings offers the same choices');
  setRoleModel(session, sessionConfig(root, session), 'planner', 'codex');
  assert.equal(settingOptions(router, sessionConfig(root, session))[0]!.label, 'Planner (codex)', 'named after the backend the planner runs on');

  applySetting(session, sessionConfig(root, session), 'router', 'jev-local');
  const config = sessionConfig(root, session);
  assert.deepEqual([config.routing.router, config.routing.enabled, config.routing.models.codex?.low], ['jev-local', false, 'my-luna'], 'the rest of routing stays');
  assert.equal(formatSetting('router', 'jev-local'), 'jev-local');
  assert.throws(() => applySetting(session, config, 'router', 'jev'), { message: 'router is planner, jev-openrouter, jev-typesafe or jev-local' });
  assert.ok(sessionChanges(root, session).settings.includes('router'));
  saveSessionConfig(root, session);
  assert.equal(JSON.parse(readFileSync(userConfigFile(), 'utf8')).routing.router, 'jev-local', 'into the user\'s own file');
  assert.equal(JSON.parse(readFileSync(join(root, '.dulger/config.json'), 'utf8')).routing.router, undefined);
});

test('the first start asks for the router until the user\'s file names one, and the answer is merged into its routing', (t) => {
  const root = repo(t);
  assert.equal(routerUnset(), true, 'no file yet');
  assert.equal(saveUserConfig({ routing: { router: 'planner' } }), userConfigFile());
  assert.deepEqual(JSON.parse(readFileSync(userConfigFile(), 'utf8')), { routing: { router: 'planner' } });
  assert.equal(routerUnset(), false, 'answered: not asked again');

  const jev = { baseUrl: 'http://127.0.0.1:1235' };
  writeFileSync(userConfigFile(), JSON.stringify({ sandbox: { mode: 'auto' }, harness: 'codex', routing: { jev, models: { claude: { low: 'haiku' } } } }));
  assert.equal(routerUnset(), true, 'a routing object without a router');
  saveUserConfig({ routing: { router: 'jev-local' } });
  assert.deepEqual(JSON.parse(readFileSync(userConfigFile(), 'utf8')), { sandbox: { mode: 'auto' }, harness: 'codex', routing: { jev, models: { claude: { low: 'haiku' } }, router: 'jev-local' } });
  assert.deepEqual([loadConfig(root).routing.router, loadConfig(root).routing.jev], ['jev-local', jev], 'every repository runs with it');
  assert.equal(saveUserConfig({ routing: { router: 'jev-local' } }), undefined, 'the same answer writes nothing');
});

test('session changes: what differs from the repository, and whether saving would persist anything', (t) => {
  const root = repo(t, { concurrency: 5 });
  const session = fresh();
  assert.deepEqual(sessionChanges(root, session), { settings: [], roles: [], providers: [], unsaved: false });

  applySetting(session, sessionConfig(root, session), 'concurrency', 5);
  assert.deepEqual(sessionChanges(root, session).settings, [], 'the value the repository already has is no change');
  applySetting(session, sessionConfig(root, session), 'yes', true);
  applySetting(session, sessionConfig(root, session), 'sandbox', 'auto');
  assert.deepEqual(sessionChanges(root, session), { settings: ['yes', 'sandbox'], roles: [], providers: [], unsaved: false }, 'session-only changes have nothing to save');

  applySetting(session, sessionConfig(root, session), 'concurrency', 2);
  applySetting(session, sessionConfig(root, session), 'docs', false);
  setRoleModel(session, sessionConfig(root, session), 'planner', 'codex', 'gpt-6-astra');
  defineProvider(session, sessionConfig(root, session), 'local', { baseUrl: 'http://localhost:8080/v1', model: 'qwen' });
  const changed = sessionChanges(root, session);
  assert.deepEqual(changed.settings, ['concurrency', 'docs', 'yes', 'sandbox']);
  assert.deepEqual(changed.roles, ['planner']);
  assert.deepEqual(changed.providers, ['local']);
  assert.equal(changed.unsaved, true);

  saveSessionConfig(root, session);
  assert.deepEqual(sessionChanges(root, session), { settings: ['yes', 'sandbox'], roles: [], providers: [], unsaved: false }, 'saved: only the session-only ones still differ');
});

test('session changes: a role that only follows a changed backend is not a change of its own', (t) => {
  const root = repo(t);
  const session = fresh();
  applySetting(session, sessionConfig(root, session), 'harness', 'fake');
  const changed = sessionChanges(root, session);
  assert.deepEqual(changed.settings, ['harness']);
  assert.deepEqual(changed.roles, [], 'nothing of their own changed: the Backend setting is the change');
  assert.equal(changed.unsaved, true);
  assert.deepEqual(rolesAffected(changed, sessionConfig(root, session)), ['planner', 'worker', 'checker', 'docs', 'reporter'], 'but all five now run differently');
  setRoleModel(session, sessionConfig(root, session), 'worker', 'codex', 'gpt-6-astra');
  assert.deepEqual(sessionChanges(root, session).roles, ['worker'], 'a choice of its own is');
  assert.deepEqual(rolesAffected(sessionChanges(root, session), sessionConfig(root, session)), ['planner', 'worker', 'checker', 'docs', 'reporter']);
});

test('Save writes a role only when it really differs, and refuses a credential in a provider URL', (t) => {
  const root = repo(t);
  const path = join(root, '.dulger/config.json');
  const session = fresh();
  // "auto" on a role that already runs that way changes nothing, so it must not be pinned in the file.
  setRoleModel(session, sessionConfig(root, session), 'worker', 'claude');
  applySetting(session, sessionConfig(root, session), 'concurrency', 4);
  assert.deepEqual(saveSessionConfig(root, session), [path], 'an auto that changes nothing is not pinned, so a later Backend change still moves it; the unchanged user file is not written');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).concurrency, 4);
  // A real role choice is written, to the user file only.
  setRoleModel(session, sessionConfig(root, session), 'worker', 'codex', 'gpt-6-astra');
  assert.deepEqual(saveSessionConfig(root, session), [userConfigFile()]);
  assert.deepEqual(JSON.parse(readFileSync(userConfigFile(), 'utf8')).roles.worker, { harness: 'codex', model: 'gpt-6-astra' });
  // A base URL with a credential is refused, and nothing is written.
  const before = readFileSync(userConfigFile(), 'utf8');
  defineProvider(session, sessionConfig(root, session), 'corp', { baseUrl: 'https://llm.corp/v1' });
  (session.overrides.providers!.corp as { baseUrl: string }).baseUrl = 'https://u:p@llm.corp/v1';
  assert.throws(() => saveSessionConfig(root, session), /must not contain credentials/);
  assert.equal(readFileSync(userConfigFile(), 'utf8'), before, 'the refused save writes nothing');
});

test('Save sends backend, roles and providers to the user file only, keeping its other keys, so they hold in every repository', (t) => {
  const corp = { baseUrl: 'https://llm.corp/v1', model: 'corp-1' };
  const root = repo(t, { concurrency: 3, providers: { corp, side: { baseUrl: 'http://side/v1' } } });
  mkdirSync(join(userConfigFile(), '..'), { recursive: true });
  writeFileSync(userConfigFile(), JSON.stringify({ sandbox: { mode: 'auto' }, custom: 1, roles: { planner: { harness: 'claude', model: 'opus' } } }));
  const session = fresh();
  applySetting(session, sessionConfig(root, session), 'harness', 'corp');
  setRoleModel(session, sessionConfig(root, session), 'worker', 'side', 's1');
  setRoleModel(session, sessionConfig(root, session), 'docs', 'deepseek');
  setRoleAuto(session, sessionConfig(root, session), 'planner');
  const repoBefore = readFileSync(join(root, '.dulger/config.json'), 'utf8');
  assert.deepEqual(plannedSave(root, session).keys, [], 'nothing for the repository file');
  assert.deepEqual(saveSessionConfig(root, session), [userConfigFile()]);
  assert.equal(readFileSync(join(root, '.dulger/config.json'), 'utf8'), repoBefore);
  const user = JSON.parse(readFileSync(userConfigFile(), 'utf8'));
  assert.deepEqual(user.sandbox, { mode: 'auto' });
  assert.equal(user.custom, 1);
  assert.equal(user.harness, 'corp');
  assert.deepEqual(user.roles, { planner: { harness: 'claude' }, worker: { harness: 'side', model: 's1' }, docs: { harness: 'deepseek' } }, 'auto drops the saved pin');
  assert.deepEqual(Object.keys(user.providers), ['corp', 'side'], 'the providers only this repository defines go with them; a built-in one does not');
  assert.equal(user.providers.corp.model, 'corp-1');
  const other = repo(t);
  assert.equal(loadConfig(other).harness, 'corp', 'another repository runs the same backend');
  assert.equal(roleConfig(loadConfig(other), 'worker').model, 's1');
  assert.deepEqual(saveSessionConfig(root, session), [], 'saving again changes nothing');
});

test('plannedSave lists exactly the keys a save writes, naming fields the form cannot (worktree, checker)', (t) => {
  const root = repo(t, { concurrency: 3 });
  const session = fresh();
  session.overrides.worktreeSetup = 'npm ci';
  session.overrides.checker = { allowedCommands: ['make test'] };
  applySetting(session, sessionConfig(root, session), 'concurrency', 5);
  const plan = plannedSave(root, session);
  assert.ok(plan.keys.includes('worktreeSetup'));
  assert.ok(plan.keys.includes('checker'));
  assert.ok(plan.keys.includes('concurrency'));
  assert.equal(plan.after.worktreeSetup, 'npm ci');
  assert.deepEqual(plan.after.checker, { allowedCommands: ['make test'] });
});
