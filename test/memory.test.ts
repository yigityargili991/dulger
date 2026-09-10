import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wt from '../src/git/worktree.ts';
import { extractPaths, learningId, memoryPath, openMemory, renderLearnings, similar } from '../src/context/memory.ts';
import { repoKey } from '../src/paths.ts';
import { buildCommonContext, cardFiles } from '../src/context/common.ts';
import { createBoard } from '../src/board/create.ts';
import type { Card } from '../src/types.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'dulger-data-'));
process.env.DULGER_DATA_DIR = dataDir;

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dulger-mem-'));
  wt.git(dir, ['init', '-q', '-b', 'main']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.ts'), 'export {}\n');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  wt.git(dir, ['add', '.']);
  wt.git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return dir;
}

const cfg = { location: 'user' as const, maxItems: 40, maxChars: 6000 };

test('memory lives outside the repo; clones of one origin share it, other projects never see it', () => {
  const repo = tempRepo();
  const path = memoryPath(repo, cfg);
  assert.ok(path.startsWith(dataDir), path);
  assert.ok(!path.startsWith(repo));
  assert.equal(memoryPath(repo, { ...cfg, location: 'repo' }), join(repo, '.dulger', 'memory.jsonl'));
  openMemory(repo, cfg).add([{ text: 'only here', files: [], runId: 'r', cardId: 'c', harness: 'fake' }]);

  // Same tree, same message, same second: identical root commit. Still a different project.
  const other = tempRepo();
  assert.notEqual(memoryPath(other, cfg), path);
  assert.equal(openMemory(other, cfg).load().length, 0);

  wt.git(repo, ['remote', 'add', 'origin', 'git@github.com:me/Proj.git']);
  assert.equal(repoKey(repo), 'github.com-me-proj');
  const clone = join(mkdtempSync(join(tmpdir(), 'dulger-clone-')), 'renamed');
  wt.git(tmpdir(), ['clone', '-q', repo, clone]);
  wt.git(clone, ['remote', 'set-url', 'origin', 'https://github.com/me/proj.git']);
  assert.equal(memoryPath(clone, cfg), memoryPath(repo, cfg), 'normalised origin URL is the key');
  wt.git(clone, ['remote', 'set-url', 'origin', 'https://github.com/fork/proj.git']);
  assert.equal(repoKey(clone), 'github.com-fork-proj', 'a fork gets its own memory');
});

test('add de-duplicates by normalised text, merges files and counts sightings', () => {
  const repo = tempRepo();
  const m = openMemory(repo, cfg);
  const base = { runId: 'r1', cardId: 'c1', harness: 'fake' as const };
  const added = m.add([
    { ...base, text: 'Tests need FOO=1.', files: ['src/app.ts'] },
    { ...base, text: '  tests   need foo=1 ', files: ['src/other.ts'] },
    { ...base, text: '', files: [] },
  ]);
  assert.equal(added.length, 1);
  const all = m.load();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.seen, 2);
  assert.deepEqual(all[0]!.files, ['src/app.ts', 'src/other.ts']);
  assert.equal(all[0]!.id, learningId('Tests need FOO=1.'));
  assert.ok(m.remove(all[0]!.id.slice(0, 6)), 'remove by id prefix');
  assert.equal(m.load().length, 0);
  assert.equal(m.remove('nope'), false);
});

test('paraphrases of one learning fold into it; different facts about the same files stay apart', () => {
  const repo = tempRepo();
  const m = openMemory(repo, cfg);
  const base = { runId: 'r1', cardId: 'c1', harness: 'fake' as const, files: ['package.json'] };
  // Four workers, four wordings, one fact (verbatim from a real run).
  const added = m.add([
    { ...base, text: 'Fresh worktrees have no node_modules; run `npm install` before `npm run typecheck` or tsc is not found (node_modules is gitignored). `npm test` works without it' },
    { ...base, text: 'node_modules is not committed; run `npm install` in a fresh worktree before `npm run typecheck` (tsc is a devDependency).' },
    { ...base, text: 'Fresh worktrees need `npm install` before `npm run typecheck`; `npm test` (node --test) runs .ts tests directly without it.' },
    { ...base, text: 'Fresh worktrees have no node_modules; run `npm install` before `npm run typecheck` (tsc not found otherwise). `npm test` works without install since node:test is built in.' },
  ]);
  assert.equal(added.length, 1);
  assert.equal(m.load().length, 1);
  assert.equal(m.load()[0]!.seen, 4);
  assert.match(m.load()[0]!.text, /^Fresh worktrees have no node_modules; run `npm install` before `npm run typecheck` or tsc/, 'the first wording is kept');

  // Related but different facts, same file: kept apart.
  const more = m.add([
    { ...base, files: ['greet.js', 'package.json'], text: 'package.json is minimal ESM ("type": "module") with test script `node --test`; no dependencies or node_modules.' },
    { ...base, files: ['greet.test.js', 'package.json'], text: '`node --test` auto-discovers *.test.js at the repo root; no config needed for ESM test files since package.json has "type": "module".' },
    { ...base, files: ['src/file.ts'], text: 'loadFile in src/file.ts only swallows ENOENT; other fs errors (e.g. EISDIR) propagate to the caller.' },
    { ...base, files: ['src/file.ts'], text: 'loadFile errors other than ENOENT (e.g. passing a directory) throw before enterRawMode; the uncaughtException handler still runs leaveRawMode harmlessly.' },
  ]);
  assert.equal(more.length, 4);
  assert.equal(m.load().length, 5);
  // The same fact seen on two unrelated cards is still one fact; files only tell where it was seen.
  assert.ok(similar({ text: 'Adw.init() prints an Adwaita-WARNING about gtk-application-prefer-dark-theme; harmless.' }, { text: 'Running the tests prints an Adwaita-WARNING about gtk-application-prefer-dark-theme; harmless noise.' }));
});

test('add appends, so lines another process wrote in between are folded in on load', () => {
  const repo = tempRepo();
  const m = openMemory(repo, cfg);
  const base = { runId: 'r1', cardId: 'c1', harness: 'fake' as const, files: [] as string[] };
  m.add([{ ...base, text: 'Alpha needs the beta service running' }]);
  const before = readFileSync(m.path, 'utf8');
  // Another dulger process on a clone appends the same learning and a new one.
  const [alpha] = m.load();
  writeFileSync(m.path, before + JSON.stringify({ ...alpha, seen: 1 }) + '\n' + JSON.stringify({ ...alpha, id: learningId('Gamma is slow'), text: 'Gamma is slow', runId: 'r2' }) + '\n');
  m.add([{ ...base, text: 'Delta must be built first' }]);
  const all = m.load();
  assert.deepEqual(all.map((l) => [l.text, l.seen]), [['Alpha needs the beta service running', 2], ['Gamma is slow', 1], ['Delta must be built first', 1]], 'nothing lost, sightings summed');
  assert.equal(readFileSync(m.path, 'utf8').split('\n').filter(Boolean).length, 4, 'add appended one line and rewrote nothing');
  const { kept, merged } = m.compact(repo);
  assert.equal([kept, merged].join(), '3,1');
  assert.equal(readFileSync(m.path, 'utf8').split('\n').filter(Boolean).length, 3, 'compact rewrote the log folded');
});

test('select ranks current run and file overlap first, respects the budget, skips stale learnings', () => {
  const repo = tempRepo();
  const m = openMemory(repo, { ...cfg, maxItems: 3 });
  const h = 'fake' as const;
  m.add([
    { text: 'global old', files: [], runId: 'r0', cardId: 'c1', harness: h },
    { text: 'about app', files: ['src/app.ts'], runId: 'r0', cardId: 'c1', harness: h },
    { text: 'about gone file', files: ['src/gone.ts'], runId: 'r0', cardId: 'c1', harness: h },
    { text: 'this run', files: [], runId: 'r1', cardId: 'c2', harness: h },
    { text: 'this run about app', files: ['src/app.ts'], runId: 'r1', cardId: 'c2', harness: h },
  ]);
  const picked = m.select({ runId: 'r1', files: ['src/app.ts'], root: repo }).map((l) => l.text);
  assert.deepEqual(picked, ['this run about app', 'this run', 'about app']);
  assert.ok(!m.select({ root: repo, maxItems: 10 }).some((l) => l.text === 'about gone file'));
  assert.ok(m.select({ maxItems: 10 }).some((l) => l.text === 'about gone file'), 'without a root nothing is stale');
  assert.equal(m.select({ runId: 'r1', files: ['src/app.ts'], root: repo, maxItems: 10, maxChars: 27 }).length, 2);
  assert.equal(m.select({ runId: 'r1', files: ['src/app.ts'], root: repo, maxItems: 10, maxChars: 5 }).length, 1, 'the best learning is always included');
  const { kept, dropped } = m.compact(repo);
  assert.equal(dropped.map((l) => l.text).join(), 'about gone file');
  assert.equal(kept, 4);
});

test('extractPaths / cardFiles only return paths that exist', () => {
  const repo = tempRepo();
  assert.deepEqual(extractPaths('edit src/app.ts and README.md; ignore src/nope.ts, e.g. foo.bar and /etc/passwd.', repo), ['src/app.ts', 'README.md']);
  const card: Card = {
    id: 'c1', title: 't', description: 'Touch src/app.ts.', acceptanceCriteria: [], dependsOn: [], verify: [], status: 'backlog', attempts: 0, feedback: [], costUsd: 0,
    tasks: [{ id: 't1', cardId: 'c1', title: 'x', instructions: 'see README.md', status: 'done', attempts: 1, result: { summary: '', filesChanged: ['src/new.ts'], done: true, remaining: [], learnings: [] } }],
  };
  assert.deepEqual(cardFiles(card, repo).sort(), ['README.md', 'src/app.ts', 'src/new.ts']);
});

test('buildCommonContext renders learnings and user context; .dulger/context stays committable', () => {
  const repo = tempRepo();
  const board = createBoard(repo, 'goal', 'run1');
  mkdirSync(join(repo, '.dulger', 'context'), { recursive: true });
  writeFileSync(join(repo, '.dulger', 'context', 'conventions.md'), 'Use tabs.\n');
  const m = openMemory(repo, cfg);
  m.add([{ text: 'Run make first', files: ['src/app.ts'], runId: 'run0', cardId: 'c1', harness: 'fake' }]);
  const ctx = buildCommonContext(repo, board, m);
  assert.match(ctx, /## Learnings from earlier work[\s\S]*- Run make first \(src\/app\.ts\)/);
  assert.match(ctx, /## Project context[\s\S]*### conventions\.md\n\nUse tabs\./);
  assert.ok(ctx.indexOf('## Learnings') < ctx.indexOf('## Project context'));
  assert.equal(renderLearnings(m.select()), '- Run make first (src/app.ts)');

  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.dulger\/\*$/m);
  assert.match(exclude, /^!\.dulger\/context$/m);
  const status = wt.git(repo, ['status', '--porcelain', '--untracked-files=all']);
  assert.match(status, /\.dulger\/context\/conventions\.md/, 'context is visible to git');
  assert.doesNotMatch(status, /runs\//, 'run state is not');
  assert.ok(!existsSync(join(repo, '.dulger', 'memory.jsonl')));
});

test('excludeFromGit migrates the legacy blanket pattern', () => {
  const repo = tempRepo();
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'foo\n.dulger/\n');
  wt.excludeFromGit(repo, ['.dulger/*', '!.dulger/context'], ['.dulger/']);
  assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), 'foo\n.dulger/*\n!.dulger/context\n');
  wt.excludeFromGit(repo, ['.dulger/*', '!.dulger/context'], ['.dulger/']);
  assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), 'foo\n.dulger/*\n!.dulger/context\n', 'idempotent');
});
