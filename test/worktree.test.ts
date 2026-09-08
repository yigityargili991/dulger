import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wt from '../src/git/worktree.ts';

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usta-git-'));
  wt.git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  wt.git(dir, ['add', '.']);
  wt.git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return dir;
}

test('worktree lifecycle: create, commit, merge-back, remove', () => {
  const repo = tempRepo();
  const base = wt.headRef(repo);
  wt.createBranch(repo, 'usta/run1', base);

  const w1 = join(repo, '.usta', 'worktrees', 'c1');
  const w2 = join(repo, '.usta', 'worktrees', 'c2');
  wt.createWorktree(repo, w1, 'usta-wip/run1/c1', 'usta/run1');
  wt.createWorktree(repo, w2, 'usta-wip/run1/c2', 'usta/run1');
  assert.ok(existsSync(join(w1, 'README.md')));

  writeFileSync(join(w1, 'a.txt'), 'a\n');
  assert.equal(wt.commitAll(w1, 'usta: c1'), true);
  assert.equal(wt.commitAll(w1, 'nothing'), false);
  assert.match(wt.diff(w1, 'usta/run1'), /\+a/);
  assert.deepEqual(wt.mergeBack(w1, 'usta/run1', 'usta-wip/run1/c1'), { ok: true });
  wt.removeWorktree(repo, w1, 'usta-wip/run1/c1');
  assert.ok(!existsSync(w1));
  assert.equal(wt.branchExists(repo, 'usta-wip/run1/c1'), false);

  // c2 started before c1 merged; merge-back must pick up c1's commit.
  writeFileSync(join(w2, 'b.txt'), 'b\n');
  wt.commitAll(w2, 'usta: c2');
  assert.deepEqual(wt.mergeBack(w2, 'usta/run1', 'usta-wip/run1/c2'), { ok: true });
  wt.removeWorktree(repo, w2, 'usta-wip/run1/c2');

  const files = wt.git(repo, ['ls-tree', '--name-only', 'usta/run1']).split('\n');
  assert.deepEqual(files.sort(), ['README.md', 'a.txt', 'b.txt']);
  assert.equal(wt.currentBranch(repo), 'main');
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'hello\n');
});

test('mergeBack reports conflicts and aborts cleanly', () => {
  const repo = tempRepo();
  wt.createBranch(repo, 'usta/run2', wt.headRef(repo));
  const w1 = join(repo, '.usta', 'worktrees', 'c1');
  const w2 = join(repo, '.usta', 'worktrees', 'c2');
  wt.createWorktree(repo, w1, 'usta-wip/run2/c1', 'usta/run2');
  wt.createWorktree(repo, w2, 'usta-wip/run2/c2', 'usta/run2');
  writeFileSync(join(w1, 'README.md'), 'from c1\n');
  writeFileSync(join(w2, 'README.md'), 'from c2\n');
  wt.commitAll(w1, 'c1');
  wt.commitAll(w2, 'c2');
  assert.equal(wt.mergeBack(w1, 'usta/run2', 'usta-wip/run2/c1').ok, true);
  const r = wt.mergeBack(w2, 'usta/run2', 'usta-wip/run2/c2');
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, ['README.md']);
  assert.equal(wt.git(w2, ['status', '--porcelain']), '');
});

test('mergeBack with keepConflicts leaves markers that commitAll can resolve', () => {
  const repo = tempRepo();
  wt.createBranch(repo, 'usta/run3', wt.headRef(repo));
  const w1 = join(repo, '.usta', 'worktrees', 'c1');
  const w2 = join(repo, '.usta', 'worktrees', 'c2');
  wt.createWorktree(repo, w1, 'usta-wip/run3/c1', 'usta/run3');
  wt.createWorktree(repo, w2, 'usta-wip/run3/c2', 'usta/run3');
  writeFileSync(join(w1, 'README.md'), 'from c1\n');
  writeFileSync(join(w2, 'README.md'), 'from c2\n');
  wt.commitAll(w1, 'c1');
  wt.commitAll(w2, 'c2');
  wt.mergeBack(w1, 'usta/run3', 'usta-wip/run3/c1');
  const r = wt.mergeBack(w2, 'usta/run3', 'usta-wip/run3/c2', { keepConflicts: true });
  assert.equal(r.ok, false);
  assert.match(readFileSync(join(w2, 'README.md'), 'utf8'), /<<<<<<<[\s\S]*>>>>>>>/);
  // An agent resolves the conflict; the next commit completes the merge and merge-back succeeds.
  writeFileSync(join(w2, 'README.md'), 'from c1 and c2\n');
  assert.equal(wt.commitAll(w2, 'resolved'), true);
  assert.deepEqual(wt.mergeBack(w2, 'usta/run3', 'usta-wip/run3/c2'), { ok: true });
  assert.equal(wt.git(repo, ['show', 'usta/run3:README.md']), 'from c1 and c2');
});
