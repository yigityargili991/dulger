import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wt from '../src/git/worktree.ts';
import { extractPaths, learningId, memoryPath, openMemory, renderLearnings } from '../src/context/memory.ts';
import { repoKey } from '../src/paths.ts';
import { buildCommonContext, cardFiles } from '../src/context/common.ts';
import { createBoard } from '../src/runner/orchestrator.ts';
import type { Card } from '../src/types.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'usta-data-'));
process.env.USTA_DATA_DIR = dataDir;

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usta-mem-'));
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
  assert.equal(memoryPath(repo, { ...cfg, location: 'repo' }), join(repo, '.usta', 'memory.jsonl'));
  openMemory(repo, cfg).add([{ text: 'only here', files: [], runId: 'r', cardId: 'c', harness: 'fake' }]);

  // Same tree, same message, same second: identical root commit. Still a different project.
  const other = tempRepo();
  assert.notEqual(memoryPath(other, cfg), path);
  assert.equal(openMemory(other, cfg).load().length, 0);

  wt.git(repo, ['remote', 'add', 'origin', 'git@github.com:me/Proj.git']);
  assert.equal(repoKey(repo), 'github.com-me-proj');
  const clone = join(mkdtempSync(join(tmpdir(), 'usta-clone-')), 'renamed');
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
    id: 'c1', title: 't', description: 'Touch src/app.ts.', acceptanceCriteria: [], dependsOn: [], status: 'backlog', attempts: 0, feedback: [], costUsd: 0,
    tasks: [{ id: 't1', cardId: 'c1', title: 'x', instructions: 'see README.md', status: 'done', attempts: 1, result: { summary: '', filesChanged: ['src/new.ts'], done: true, remaining: [], learnings: [] } }],
  };
  assert.deepEqual(cardFiles(card, repo).sort(), ['README.md', 'src/app.ts', 'src/new.ts']);
});

test('buildCommonContext renders learnings and user context; .usta/context stays committable', () => {
  const repo = tempRepo();
  const board = createBoard(repo, 'goal', 'run1');
  mkdirSync(join(repo, '.usta', 'context'), { recursive: true });
  writeFileSync(join(repo, '.usta', 'context', 'conventions.md'), 'Use tabs.\n');
  const m = openMemory(repo, cfg);
  m.add([{ text: 'Run make first', files: ['src/app.ts'], runId: 'run0', cardId: 'c1', harness: 'fake' }]);
  const ctx = buildCommonContext(repo, board, m);
  assert.match(ctx, /## Learnings from earlier work[\s\S]*- Run make first \(src\/app\.ts\)/);
  assert.match(ctx, /## Project context[\s\S]*### conventions\.md\n\nUse tabs\./);
  assert.ok(ctx.indexOf('## Learnings') < ctx.indexOf('## Project context'));
  assert.equal(renderLearnings(m.select()), '- Run make first (src/app.ts)');

  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.usta\/\*$/m);
  assert.match(exclude, /^!\.usta\/context$/m);
  const status = wt.git(repo, ['status', '--porcelain', '--untracked-files=all']);
  assert.match(status, /\.usta\/context\/conventions\.md/, 'context is visible to git');
  assert.doesNotMatch(status, /runs\//, 'run state is not');
  assert.ok(!existsSync(join(repo, '.usta', 'memory.jsonl')));
});

test('excludeFromGit migrates the legacy blanket pattern', () => {
  const repo = tempRepo();
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'foo\n.usta/\n');
  wt.excludeFromGit(repo, ['.usta/*', '!.usta/context'], ['.usta/']);
  assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), 'foo\n.usta/*\n!.usta/context\n');
  wt.excludeFromGit(repo, ['.usta/*', '!.usta/context'], ['.usta/']);
  assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), 'foo\n.usta/*\n!.usta/context\n', 'idempotent');
});
