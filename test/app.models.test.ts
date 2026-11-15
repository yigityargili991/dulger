// The Models tab driven through the real shell against a temporary repository: the roster, editing a
// role, the whole-team actions, problems and their fixes, navigation params, and every size. The page
// draws values; what it used to explain is asserted on its help.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app/shell.ts';
import { createModelsPage } from '../src/app/pages/models.ts';
import type { NavParams, Page, PageFactory } from '../src/app/types.ts';
import type { ApiConfig } from '../src/config.ts';
import { roleConfig } from '../src/config.ts';
import { sessionConfig } from '../src/replModels.ts';
import type { Session } from '../src/repl.ts';
import type { IconSet } from '../src/tui/theme.ts';
import { SIZES, assertFrame, ch, fakeScreens, key, press } from './kit.helpers.ts';

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-app-models-home-'));
for (const v of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']) delete process.env[v];

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function repo(t: TestContext, stored: object = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-models-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.dulger'));
  writeFileSync(join(root, '.dulger/config.json'), JSON.stringify(stored));
  return root;
}

/** A tab that records how it was activated, standing in for the pages Models navigates to. */
function recorder(id: string, log: Array<{ id: string; params?: NavParams }>): PageFactory {
  return () => ({ id, title: id, activate: (params) => { log.push({ id, params }); }, render: () => ({ lines: [`${id} page`] }), onKey: () => false, hints: () => [] });
}

function setup(t: TestContext, o: { stored?: object; rows?: number; cols?: number; icons?: IconSet; lister?: (p: ApiConfig) => Promise<string[]> } = {}) {
  const root = repo(t, o.stored);
  const session: Session = { overrides: {}, yes: false, quiet: false, allowDirty: false };
  const screens = fakeScreens(o.rows ?? 40, o.cols ?? 120);
  const visits: Array<{ id: string; params?: NavParams }> = [];
  const asked: ApiConfig[] = [];
  const lister = o.lister ?? (async () => ['remote-a', 'remote-b']);
  let page!: Page;
  const pages: PageFactory[] = [
    (ctx) => (page = createModelsPage(ctx, { listModels: (p) => { asked.push(p); return lister(p); } })),
    recorder('settings', visits), recorder('providers', visits),
  ];
  const app = createApp({ repoRoot: root, session, version: '1.0.0', config: () => sessionConfig(root, session), pages, openScreen: screens.factory, icons: o.icons ?? 'unicode', branch: () => 'main' });
  const done = app.run();
  t.after(async () => { app.quit(); await done; });
  return {
    root, session, screens, visits, asked, app, get s() { return screens.current; }, config: () => sessionConfig(root, session),
    /** Everything the page's help says, as one text. */
    help: () => (page.help?.() ?? []).flatMap((h) => [h.title, ...[h.text ?? []].flat(), ...h.keys.map((k) => `${k.key} ${k.label}`)]).join('\n'),
  };
}

test('the roster shows every role with its backend, the model only when pinned and a state only when wrong; help explains', (t) => {
  const { s, help } = setup(t);
  const text = s.text;
  for (const role of ['Planner', 'Worker', 'Reviewer', 'Docs', 'Reporter']) assert.match(text, new RegExp(role));
  assert.match(text, /│ ❯ ✦ Planner\s+claude\s+│/, 'the default model and a ready state need no saying');
  assert.match(text, /⚒ Worker\s+claude\s+│/);
  assert.doesNotMatch(text, /Role\s+Backend|default model|✓/, 'no header, no default model, no ok glyph');
  assert.match(text, /Tiers\s+low haiku · medium sonnet · high fable/, 'the selected role\'s facts: what is not on the roster');
  assert.doesNotMatch(text, /Chosen|From\s+repository|Backend\s+claude/, 'and nothing that is the default');
  assert.match(text, /Tiers\s+low haiku · medium sonnet · high fable/, 'the selected role\'s tiers');
  assert.match(text, /Whole team[\s\S]*Model set…/);
  assert.doesNotMatch(text, /A pin\s+would|How a model is chosen|Matches the repository|A preset for every role|Splits the goal/, 'no sentences on the page');
  assert.match(help(), /^Planner\nSplits the goal into cards[\s\S]*A pin would replace the tier model/, 'help leads with the selected role');
  assert.match(help(), /About\n[\s\S]*wins over the global pin/, 'how a model is chosen is in help');
  assert.ok(text.split('\n')[2]!.indexOf('╮') < 30, 'the roster is as wide as its columns, not the terminal');
  assert.doesNotMatch(text, /\/model|\/config|config\.json/, 'no command syntax or file editing in the UI');
});

test('every size fits, in every glyph set, down to 1×1', (t) => {
  for (const icons of ['unicode', 'ascii', 'nerd'] as const) {
    const { s } = setup(t, { icons, stored: { harness: 'openai', docs: false } });
    for (const [rows, cols] of SIZES) {
      s.resize(rows, cols);
      assertFrame(s.lines, rows, cols, `models ${icons}`);
    }
    s.resize(24, 80);
    assert.match(s.text, /Roles/);
    assert.match(s.text, /Planner on openai needs a model/, 'the banner survives at 80×24');
  }
});

test('editing a role: backend, then model; Esc on the model goes back to the backend', async (t) => {
  const { s, session, config, help } = setup(t);
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Worker: backend/);
  assert.match(s.text, /❯ claude\s+current/, 'names, and a short tag');
  assert.doesNotMatch(s.text, /Claude Code CLI/, 'no descriptions');
  s.key(key('down'));
  await tick();
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Worker: model on codex/);
  assert.match(s.text, /Automatic tiers\s+by task: gpt-6-luna \/ gpt-6\.1-sol \/ gpt-6-astra/);
  s.key(key('escape'));
  await tick();
  assert.match(s.text, /Worker: backend/, 'back to the backend picker');
  s.key(key('enter'));
  await tick();
  s.key(key('down'));
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.deepEqual(session.modelRoles?.worker, { harness: 'codex', model: 'gpt-6.1-sol' });
  assert.equal(roleConfig(config(), 'worker').model, 'gpt-6.1-sol');
  assert.match(s.text, /Worker → codex · gpt-6\.1-sol/);
  assert.match(s.text, /⚒ Worker\s+codex\s+gpt-6\.1-sol ✎\s+│/, 'pinned, so the model shows; changed this session, so ✎');
  assert.match(s.text, /Model\s+gpt-6\.1-sol · pinned/);
  assert.match(s.text, /From\s+this session ✎/);
  assert.match(s.text, /Roles ─+ ✎1 ─╮/, 'the roster counts changed roles');
  assert.match(help(), /Pinned: task difficulty and retry escalation do not change it/);
});

test('a and r: automatic on the role\'s backend, and back to the repository\'s setting', async (t) => {
  const { s, session, config } = setup(t, { stored: { roles: { worker: { harness: 'codex' } } } });
  session.modelRoles = { worker: { harness: 'claude', model: 'opus' } };
  s.key(key('down'));
  s.key(ch('a'));
  await tick();
  assert.deepEqual(session.modelRoles.worker, { harness: 'claude', model: undefined });
  assert.match(s.text, /Worker → auto · claude/);
  s.key(ch('r'));
  await tick();
  assert.equal(session.modelRoles.worker, 'reset');
  assert.equal(roleConfig(config(), 'worker').harness, 'codex');
  assert.match(s.text, /Worker reset · codex/);
});

test('"Enter a model ID…" validates like the setter and pins what was typed', async (t) => {
  const { s, session } = setup(t);
  s.key(key('enter'));
  await tick();
  s.key(key('enter'));
  await tick();
  s.key(key('end'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Model ID/);
  s.type('bad id');
  s.key(key('enter'));
  assert.match(s.text, /No spaces or control characters/);
  for (let i = 0; i < 6; i++) s.key(key('backspace'));
  s.type('my-model');
  s.key(key('enter'));
  await tick();
  assert.deepEqual(session.modelRoles?.planner, { harness: 'claude', model: 'my-model' });
});

test('a provider backend loads its remote list when it has a key; failures and missing keys are notes', async (t) => {
  {
    const { s, asked } = setup(t);
    s.key(key('down'));
    s.key(key('enter'));
    await tick();
    for (let i = 0; i < 3; i++) s.key(key('down'));
    s.key(key('enter'));
    await tick();
    assert.match(s.text, /Worker: model on ollama/);
    assert.equal(asked.length, 1, 'ollama needs no key, so it is asked');
    assert.match(s.text, /ollama: 2 listed/);
    assert.match(s.text, /remote-a/);
    s.key(key('escape'));
    await tick();
    s.key(key('down'));
    s.key(key('enter'));
    await tick();
    assert.match(s.text, /! deepseek: no key \(DEEPSEEK_API_KEY\)/);
    assert.equal(asked.length, 1, 'without a key the endpoint is not asked');
    assert.match(s.text, /deepseek-flash/, 'configured models are still offered');
    assert.match(s.text, /Enter a model ID/);
  }
  {
    const { s } = setup(t, { lister: async () => { throw new Error('HTTP 401 from api.example.com'); } });
    s.key(key('down'));
    s.key(key('enter'));
    await tick();
    for (let i = 0; i < 3; i++) s.key(key('down'));
    s.key(key('enter'));
    await tick();
    assert.match(s.text, /! ollama: localhost:11434: needs a key \(HTTP 401\)/, 'the cause in a few words');
    assert.doesNotMatch(s.text, /Give the provider|Meanwhile/, 'no advice');
    assert.match(s.text, /Enter a model ID/, 'not a dead end');
  }
});

test('whole team: a model set, one model for every role, the global pin, one backend for all', async (t) => {
  const { s, session, config } = setup(t);
  s.key(ch('s'));
  await tick();
  assert.match(s.text, /Model set on claude/);
  assert.doesNotMatch(s.text, /replaces each role's own choice|Pin workers to medium/, 'names only');
  s.key(key('down'));
  await tick();
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Balanced set turns routing off/, 'turning routing off is said before it is applied');
  assert.match(s.text, /Routing\s+on → off/);
  s.key(key('right'));
  s.key(key('enter'));
  await tick();
  assert.equal(roleConfig(config(), 'worker').model, 'sonnet');
  assert.equal(roleConfig(config(), 'planner').model, 'fable');
  assert.match(s.text, /Balanced set on claude · routing off/);

  s.key(ch('o'));
  await tick();
  assert.match(s.text, /One model for every role on claude/);
  s.key(key('enter'));
  await tick();
  for (const r of ['planner', 'worker', 'checker', 'docs', 'reporter'] as const) assert.equal(roleConfig(config(), r).model, 'haiku', r);

  s.key(ch('p'));
  await tick();
  assert.match(s.text, /Global pin/);
  s.key(key('down'));
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.equal(session.model, 'sonnet');
  assert.match(s.text, /Global pin…\s+sonnet/);
  s.key(ch('p'));
  await tick();
  assert.match(s.text, /No global pin\s+clears it/);
  s.key(key('home'));
  s.key(key('enter'));
  await tick();
  assert.equal(session.model, undefined);

  s.key(ch('b'));
  await tick();
  assert.match(s.text, /Backend for every role/);
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Run every role on codex/);
  assert.match(s.text, /Models\s+automatic tiers/, 'it says what happens before doing it');
  assert.match(s.text, /Replaces\s+each role's choice/);
  s.key(key('enter'));
  await tick();
  assert.equal(config().harness, 'claude', 'the safe choice is focused first: nothing changed');
  s.key(ch('b'));
  await tick();
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  s.key(ch('y'));
  await tick();
  for (const r of ['planner', 'worker', 'checker', 'docs', 'reporter'] as const) {
    assert.deepEqual([roleConfig(config(), r).harness, config().roles[r]?.model], ['codex', undefined], r);
  }
  assert.match(s.text, /Every role → codex · automatic tiers/);
});

test('setup issues are a banner and a badge; problems are short state lines, help names their fix, which navigates', async (t) => {
  const { s, visits, root, help } = setup(t, { stored: { harness: 'openai', docs: false, progressIntervalSec: 0 } });
  const disk = readFileSync(join(root, '.dulger/config.json'), 'utf8');
  assert.match(s.text, /! Planner on openai needs a model\s/);
  assert.doesNotMatch(s.text, /choose one for all roles/, 'the state, not the advice');
  assert.match(s.text, /\+\d more/);
  assert.match(s.text, /4 Models\s*!3|Models !3/, 'the tab badge counts what blocks a run');
  assert.match(s.text, /✦ Planner\s+openai\s+! model/);
  assert.match(s.text, /! no model on openai/);
  assert.match(s.text, /! no key: OPENAI_API_KEY/);
  assert.match(help(), /openai has no model for the planner, and a run cannot start without one\. f: Choose a model\./);
  assert.ok(s.lines.at(-1)!.includes('f fix'), 'f is in the key bar');
  s.key(ch('f'));
  await tick();
  assert.match(s.text, /Planner: model on openai/, 'the first fix chooses a model');
  s.key(key('escape'));
  await tick();
  s.key(key('down'));
  s.key(key('down'));
  s.key(key('down'));
  assert.match(s.text, /≡ Docs\s+openai\s+off/);
  assert.match(s.text, /! Docs agent off/);
  assert.match(help(), /The documentation agent is off/);
  s.key(ch('f'));
  assert.deepEqual(visits.at(-1), { id: 'settings', params: { key: 'docs' } });
  s.key(ch('1'));
  s.key(key('end'));
  s.key(ch('f'));
  assert.deepEqual(visits.at(-1), { id: 'settings', params: { key: 'progress' } });
  s.key(ch('1'));
  s.key(key('home'));
  // The second problem's fix is in the palette.
  s.key(key('ctrl', 'p'));
  s.type("openai's key");
  s.key(key('enter'));
  await tick();
  assert.deepEqual(visits.at(-1), { id: 'providers', params: { provider: 'openai', action: 'key' } });
  assert.equal(readFileSync(join(root, '.dulger/config.json'), 'utf8'), disk, 'nothing was written to the repository');
});

test('codex cannot write progress notes: the reporter on it is skipped, and says so', (t) => {
  const { s, help } = setup(t, { stored: { harness: 'codex' } });
  s.key(key('end'));
  assert.match(s.text, /◔ Reporter\s+codex\s+skipped/);
  assert.match(s.text, /! no tool-free mode/);
  assert.match(help(), /codex cannot run without its tools, so progress notes are skipped/);
});

test('activate({ role }) selects that role; unknown roles are ignored; ^s and routing go to Settings', async (t) => {
  const { s, app, visits, help } = setup(t);
  app.ctx.navigate('models', { role: 'checker' });
  assert.match(s.text, /❯ ◎ Reviewer/);
  assert.match(help(), /^Reviewer\nReviews each card before it lands/);
  app.ctx.navigate('models', { role: 'nobody' });
  assert.match(s.text, /❯ ◎ Reviewer/, 'an unknown role changes nothing');
  app.ctx.navigate('models', { role: 'worker' });
  assert.match(s.text, /❯ ⚒ Worker/);
  s.key(key('ctrl', 's'));
  await tick();
  assert.match(s.text, /Save settings|Nothing to save/, '^s saves here, showing what first');
  s.key(key('escape'));
  s.key(ch('1'));
  s.key(key('tab'));
  assert.match(help(), /^Model set\nA preset for every role on claude/, 'help explains the highlighted action');
  for (let i = 0; i < 4; i++) s.key(key('down'));
  s.key(key('enter'));
  assert.deepEqual(visits.at(-1), { id: 'settings', params: { key: 'routing' } });
});

test('mouse: a click selects a role, a second click edits it; the team pane takes clicks too', async (t) => {
  const { s } = setup(t);
  const lines = s.text.split('\n');
  const row = lines.findIndex((l) => /Docs\s+claude/.test(l));
  s.mouse(press(row, 10));
  assert.match(s.text, /❯ ≡ Docs/);
  s.mouse(press(row, 10));
  await tick();
  assert.match(s.text, /Docs: backend/);
  s.key(key('escape'));
  await tick();
  const team = s.text.split('\n').findIndex((l) => l.includes('Global pin…'));
  const col = s.text.split('\n')[team]!.indexOf('Global pin');
  s.mouse(press(team, col));
  s.mouse(press(team, col));
  await tick();
  assert.match(s.text, /No global pin/);
});

test('palette and help list every action with a clear title', (t) => {
  const { s } = setup(t);
  s.key(key('ctrl', 'p'));
  const text = s.text;
  for (const title of ["Edit the planner's backend and model", 'Make the planner automatic', 'Apply a model set to every role', 'One model for every role', 'Set the global pin', 'Run every role on one backend', 'Save the model choices']) {
    assert.match(text, new RegExp(title), title);
  }
  s.key(key('escape'));
  s.key(ch('?'));
  assert.match(s.text, /Whole team/);
  assert.match(s.text, /automatic on its backend/);
  assert.match(s.text, /save settings/);
});

test('a broken configuration is an error state, not a crash; r tries again', (t) => {
  const { s, root } = setup(t);
  writeFileSync(join(root, '.dulger/config.json'), '{ not json');
  s.key(ch('1'));
  s.key(ch('2'));
  s.key(ch('1'));
  assert.match(s.text, /! .*JSON/, 'the reader\'s own message');
  assertFrame(s.lines, 40, 120);
  writeFileSync(join(root, '.dulger/config.json'), '{}');
  s.key(ch('r'));
  assert.match(s.text, /✦ Planner/);
});

test('on a backend without tier models only Automatic is offered as a set, and the others say why in a tag', async (t) => {
  const { s, session } = setup(t, { stored: { harness: 'fake' } });
  s.key(ch('s'));
  await tick();
  assert.match(s.text, /Model set on fake/);
  assert.match(s.text, /Balanced set\s+no tier models/, 'each set that cannot apply says why');
  s.key(key('down'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Automatic tiers on fake/, 'the arrows skip the sets that cannot apply, so Enter took Automatic');
  assert.equal(session.overrides.routing?.enabled, true);
  assert.doesNotMatch(s.text, /turns routing off/);
});
