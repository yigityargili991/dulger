import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { jevEndpoint, routeTasks } from '../src/router.ts';
import { preflight } from '../src/preflight.ts';
import { createOrchestrator } from '../src/runner/orchestrator.ts';
import { createBoard } from '../src/board/create.ts';
import { createFakeAdapter, DEFAULT_FAKE_SCRIPT } from '../src/adapters/fake.ts';
import { registerAdapter } from '../src/adapters/index.ts';
import * as store from '../src/board/store.ts';
import * as git from '../src/git/worktree.ts';
import type { PlannerResult } from '../src/types.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-router-data-'));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'dulger-router-home-'));

/** A /v1/systemone that scores each task by the number in its title ("score 1.6" scores 1.6), or sends `reply` instead. */
async function jev(t: TestContext, reply?: { status: number; body: object }) {
  const requests: Array<{ url?: string; auth?: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const task = body.state.card.tasks[Number(q.instructions.match(/`card\.tasks\[(\d+)\]`/)[1])];
      return [id, { type: 'score', score: Number(task.title.match(/-?[\d.]+/)[0]), confidence: 0.9, probabilities: {} }];
    }));
    res.writeHead(reply?.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply?.body ?? { model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const card = (id: string, scores: number[]): PlannerResult['cards'][number] => ({
  id, title: `Card ${id}`, description: `Do ${id}`, acceptanceCriteria: ['works'], dependsOn: [], verify: [],
  tasks: scores.map((s, i) => ({ id: `t${i + 1}`, title: `score ${s}`, instructions: `Work worth ${s}`, complexity: 'medium' })),
});
const tiers = (cards: Array<{ tasks: Array<{ complexity?: string }> }>) => cards.map((c) => c.tasks.map((t) => t.complexity));

test('the router is Jev only when routing is on, at its preset with routing.jev on top', () => {
  const routing = DEFAULT_CONFIG.routing;
  assert.equal(jevEndpoint(routing), undefined);
  assert.equal(jevEndpoint({ ...routing, enabled: false, router: 'jev-local' }), undefined);
  assert.deepEqual(jevEndpoint({ ...routing, router: 'jev-local', jev: { baseUrl: 'http://127.0.0.1:1235' } }), { baseUrl: 'http://127.0.0.1:1235' });
  assert.deepEqual(jevEndpoint({ ...routing, router: 'jev-openrouter' }), { baseUrl: 'https://openrouter.ai/api', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'typesafe/jev-1.14' });
});

test('one request per card, one score question per task, and each score rounds to a tier', async (t) => {
  const { baseUrl, requests } = await jev(t);
  process.env.DULGER_TEST_JEV_KEY = 'secret';
  t.after(() => { delete process.env.DULGER_TEST_JEV_KEY; });
  const cards = store.cardsFromPlan({ cards: [card('c1', [0.4, 0.5, 1.49]), card('c2', [-0.3, 1.6, 2.7])] });
  await routeTasks({ baseUrl: baseUrl + '/', apiKeyEnv: 'DULGER_TEST_JEV_KEY', model: 'jev-test' }, 'the goal', cards, new AbortController().signal);
  assert.deepEqual(tiers(cards), [['low', 'medium', 'medium'], ['low', 'high', 'high']]);
  assert.equal(requests.length, 2);
  const first = requests.find((r) => r.body.state.card.title === 'Card c1')!;
  assert.equal(first.url, '/v1/systemone');
  assert.equal(first.auth, 'Bearer secret');
  assert.equal(first.body.model, 'jev-test');
  assert.deepEqual(first.body.state, { goal: 'the goal', card: { title: 'Card c1', description: 'Do c1', acceptanceCriteria: ['works'], tasks: [0.4, 0.5, 1.49].map((s) => ({ title: `score ${s}`, instructions: `Work worth ${s}` })) } });
  assert.deepEqual(Object.keys(first.body.questions), ['t1', 't2', 't3']);
  assert.equal(first.body.questions.t2.type, 'score');
  assert.match(first.body.questions.t2.instructions, /`card\.tasks\[1\]`/);
  assert.equal(first.body.questions.t2.criteria.length, 3);
});

test('a server error or a missing answer is a readable error and changes no tag', async (t) => {
  const signal = new AbortController().signal;
  const cards = store.cardsFromPlan({ cards: [card('c1', [0.1, 2])] });
  const invalid = await jev(t, { status: 422, body: { detail: [{ loc: ['body', 'questions', 't1', 'criteria'], msg: 'Field required', type: 'missing' }] } });
  await assert.rejects(routeTasks(invalid, 'g', cards, signal), /^Error: HTTP 422 from 127\.0\.0\.1:\d+: body\.questions\.t1\.criteria: Field required$/);
  const refused = await jev(t, { status: 400, body: { detail: 'unknown model' } });
  await assert.rejects(routeTasks(refused, 'g', cards, signal), /HTTP 400 from 127\.0\.0\.1:\d+: unknown model$/);
  const silent = await jev(t, { status: 200, body: { model: 'jev-test', answers: {} } });
  await assert.rejects(routeTasks(silent, 'g', cards, signal), /sent no score for c1\/t1/);
  assert.equal(invalid.requests[0]!.auth, undefined, 'no key, no header');
  assert.equal('model' in invalid.requests[0]!.body, false, 'no model, no field');
  assert.deepEqual(tiers(cards), [['medium', 'medium']]);
});

test('a run with Jev as the router tags the plan and the cards a replan adds; when Jev fails, the planner\'s tags stay', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dulger-router-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  registerAdapter('fake', createFakeAdapter({
    ...DEFAULT_FAKE_SCRIPT, delayMs: 1,
    // c1 never passes, so the run replans: c2 replaces c9, which waits for c1.
    planner: (_o, i) => ({ cards: i < 2 ? [card('c1', [0.2, 1.8]), { ...card('c9', [0]), dependsOn: ['c1'] }] : [card('c2', [2])] }),
    checker: (o) => (/Card under review: c1 /.test(o.prompt) ? { pass: false, feedback: ['no'], summary: '' } : { pass: true, feedback: [], summary: 'ok' }),
  }));
  const server = await jev(t);
  const log: string[] = [];
  const config: Config = { ...structuredClone(DEFAULT_CONFIG), harness: 'fake', docs: false, progressIntervalSec: 0, maxReplans: 1, routing: { ...DEFAULT_CONFIG.routing, router: 'jev-local', jev: { baseUrl: server.baseUrl } } };
  const board = createBoard(root, 'route it', 'route');
  const orch = createOrchestrator(root, board, config, { log: (m) => log.push(m) });
  await orch.plan();
  assert.deepEqual(tiers(board.cards), [['low', 'high'], ['low']]);
  assert.deepEqual(tiers(store.loadBoard(root, board.runId).cards), [['low', 'high'], ['low']], 'saved with the plan');
  config.routing.jev = { baseUrl: (await jev(t, { status: 503, body: { detail: 'loading model' } })).baseUrl };
  await orch.plan('again');
  assert.deepEqual(tiers(board.cards), [['medium', 'medium'], ['medium']]);
  assert.ok(log.some((m) => /jev: HTTP 503 from 127\.0\.0\.1:\d+: loading model; keeping the planner's difficulty tags/.test(m)), log.join('\n'));
  config.routing.jev = { baseUrl: server.baseUrl };
  await orch.execute();
  assert.deepEqual(store.loadBoard(root, board.runId).cards.map((c) => [c.id, c.status, c.tasks[0]!.complexity]), [['c1', 'failed', 'medium'], ['c9', 'replaced', 'medium'], ['c2', 'done', 'high']]);
  assert.equal(server.requests.length, 3, 'the replan asks about the card it adds, and only that one');
});

test('doctor names the Jev router and warns when its key is missing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dulger-router-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  const base: Config = { ...structuredClone(DEFAULT_CONFIG), harness: 'fake' };
  const router = (routing: Partial<Config['routing']>) => preflight(root, { ...base, routing: { ...base.routing, ...routing } }).find((c) => c.label === 'Router');
  assert.equal(router({}), undefined);
  assert.deepEqual(router({ router: 'jev-local', jev: { baseUrl: 'http://127.0.0.1:1235' } }), { label: 'Router', status: 'pass', detail: 'jev-local at http://127.0.0.1:1235' });
  const missing = router({ router: 'jev-typesafe', jev: { apiKeyEnv: 'DULGER_TEST_MISSING_JEV_KEY' } })!;
  assert.equal(missing.status, 'warning');
  assert.match(missing.detail, /^Set DULGER_TEST_MISSING_JEV_KEY; without it runs keep the planner's difficulty tags\. jev-typesafe at https:\/\/api\.typesafe\.ai, model jev-latest$/);
});
