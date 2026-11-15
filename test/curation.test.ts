// The headless curation API: memory as data, plan drafts validated and saved, profile summaries.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { addMemory, compactMemory, listMemory, memoryPath, removeMemory } from '../src/context/memory.ts';
import { memoryCommand } from '../src/commands.ts';
import { planEditBlocker, savePlanDraft, validatePlanDraft } from '../src/planEditor.ts';
import { profileSummaries, saveProfile } from '../src/profiles.ts';
import { CliError } from '../src/errors.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-curation-data-'));
const config: Config = { ...structuredClone(DEFAULT_CONFIG), harness: 'fake', memory: { location: 'repo', maxItems: 40, maxChars: 6000 } };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dulger-curation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'export {}\n');
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

test('memory: list, add with the paths it mentions, remove and compact return data', (t) => {
  const root = fixture(t);
  assert.deepEqual(listMemory(root, config), { path: memoryPath(root, config.memory), items: [] });
  const added = addMemory(root, config, 'src/app.ts exports nothing yet; keep it that way');
  assert.ok(added);
  assert.deepEqual(added.files, ['src/app.ts']);
  assert.deepEqual([added.runId, added.cardId, added.harness], ['manual', 'manual', 'fake']);
  assert.equal(addMemory(root, config, 'src/app.ts exports nothing yet; keep it that way.'), undefined, 'already known');
  assert.throws(() => addMemory(root, config, '   '), (e: unknown) => e instanceof CliError && e.message === 'memory add needs a text');
  assert.deepEqual(listMemory(root, config).items.map((l) => l.id), [added.id]);

  const other = addMemory(root, config, 'the README is the only documentation')!;
  assert.equal(removeMemory(root, config, other.id), true);
  assert.equal(removeMemory(root, config, other.id), false);
  assert.throws(() => removeMemory(root, config, ''), { message: 'memory rm needs an id' });

  rmSync(join(root, 'src', 'app.ts'));
  const compacted = compactMemory(root, config);
  assert.equal(compacted.kept, 0);
  assert.deepEqual(compacted.dropped.map((l) => l.id), [added.id]);
  assert.equal(compacted.merged, 0, 'remove already rewrote the log folded');

  const out: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => out.push(args.join(' ')));
  memoryCommand(root, config, 'add', ['a learning about README.md and nothing else']);
  assert.match(out.at(-1)!, /added [0-9a-f]{12}/);
  memoryCommand(root, config, 'add', ['a learning about README.md and nothing else']);
  assert.match(out.at(-1)!, /already known/);
  memoryCommand(root, config, 'path', []);
  assert.equal(out.at(-1), memoryPath(root, config.memory));
  assert.throws(() => memoryCommand(root, config, 'add', []), { message: 'memory add needs a text' });
});

const plan = () => store.cardsFromPlan({ cards: [
  { id: 'c1', title: 'One', description: 'Implement one thing', acceptanceCriteria: ['done'], dependsOn: [], verify: [], tasks: [{ id: 't1', title: 'Implement', instructions: 'Write something' }] },
  { id: 'c2', title: 'Two', description: 'Then another', acceptanceCriteria: [], dependsOn: ['c1'], verify: [], tasks: [{ id: 't1', title: 'Follow up', instructions: 'Use it' }] },
] });

test('a plan draft is validated as a whole and saved with its event; a started plan cannot be saved over', (t) => {
  const root = fixture(t);
  const board = createBoard(root, 'edit me', 'edit');
  board.cards = plan();
  store.saveBoard(root, board);
  assert.equal(planEditBlocker(board), undefined);

  const bad = structuredClone(board);
  bad.cards[1]!.dependsOn = ['missing'];
  assert.throws(() => validatePlanDraft(bad, config), (e: unknown) => e instanceof CliError && /depends on unknown card missing/.test(e.message));
  bad.cards[1]!.dependsOn = ['c1'];
  bad.cards[1]!.title = '  ';
  assert.throws(() => savePlanDraft(root, board, bad, config), /c2: title, description and task instructions cannot be empty/);
  bad.cards[1]!.title = 'Two';
  bad.cards[1]!.worker = { harness: 'nowhere' };
  assert.throws(() => savePlanDraft(root, board, bad, config), /c2: choose a configured worker harness/);
  assert.equal(store.loadBoard(root, 'edit').cards[1]!.title, 'Two', 'nothing was saved');

  const draft = structuredClone(board);
  draft.cards[0]!.title = 'One, renamed';
  draft.cards[0]!.verify = ['npm test | tee out.txt'];
  draft.cards[1]!.worker = { harness: 'fake', model: 'pinned-model' };
  savePlanDraft(root, board, draft, config);
  assert.equal(board.cards[0]!.title, 'One, renamed');
  const saved = store.loadBoard(root, 'edit');
  assert.equal(saved.cards[0]!.title, 'One, renamed');
  assert.deepEqual(saved.cards[0]!.verify, ['npm test | tee out.txt']);
  assert.deepEqual(saved.cards[1]!.worker, { harness: 'fake', model: 'pinned-model' });
  const events = readFileSync(join(store.runDir(root, 'edit'), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string });
  assert.equal(events.at(-1)!.type, 'plan_edited');

  board.cards[0]!.status = 'in_progress';
  assert.match(planEditBlocker(board)!, /^Only an unstarted plan can be edited/);
  assert.throws(() => savePlanDraft(root, board, draft, config), /Only an unstarted plan can be edited/);
});

test('profile summaries: name, harness, concurrency and budgets per saved profile', (t) => {
  const root = fixture(t);
  assert.deepEqual(profileSummaries(root), []);
  saveProfile(root, 'Fast', { ...config, harness: 'codex', concurrency: 6, budgetUsd: 20 });
  saveProfile(root, 'Cheap', { ...config, concurrency: 1, cardBudgetUsd: 2 });
  assert.deepEqual(profileSummaries(root), [
    { name: 'Fast', harness: 'codex', concurrency: 6, budgetUsd: 20, cardBudgetUsd: undefined },
    { name: 'Cheap', harness: 'fake', concurrency: 1, budgetUsd: undefined, cardBudgetUsd: 2 },
  ]);
});
