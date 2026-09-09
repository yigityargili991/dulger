import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wt from '../src/git/worktree.ts';

const worktrees = mkdtempSync(join(tmpdir(), 'dulger-wt-'));

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dulger-git-'));
  wt.git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  wt.git(dir, ['add', '.']);
  wt.git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return dir;
}

test('worktree lifecycle: create, commit, merge-back, remove', () => {
  const repo = tempRepo();
  const base = wt.headRef(repo);
  wt.createBranch(repo, 'dulger/run1', base);

  const w1 = join(worktrees, 'c1');
  const w2 = join(worktrees, 'c2');
  wt.createWorktree(repo, w1, 'dulger-wip/run1/c1', 'dulger/run1');
  wt.createWorktree(repo, w2, 'dulger-wip/run1/c2', 'dulger/run1');
  assert.ok(existsSync(join(w1, 'README.md')));
  assert.deepEqual(wt.listWorktrees(repo).map((w) => w.branch), ['main', 'dulger-wip/run1/c1', 'dulger-wip/run1/c2']);

  writeFileSync(join(w1, 'a.txt'), 'a\n');
  assert.equal(wt.commitAll(w1, 'dulger: c1'), true);
  assert.equal(wt.commitAll(w1, 'nothing'), false);
  assert.match(wt.diff(w1, 'dulger/run1'), /\+a/);
  assert.deepEqual(wt.mergeFrom(w1, 'dulger/run1'), { ok: true });
  assert.equal(wt.land(w1, 'dulger/run1'), true);
  wt.removeWorktree(repo, w1, 'dulger-wip/run1/c1');
  assert.ok(!existsSync(w1));
  assert.equal(wt.branchExists(repo, 'dulger-wip/run1/c1'), false);

  // c2 started before c1 landed: it cannot land until c1's commit is merged in.
  writeFileSync(join(w2, 'b.txt'), 'b\n');
  wt.commitAll(w2, 'dulger: c2');
  assert.equal(wt.land(w2, 'dulger/run1'), false, 'run branch moved');
  assert.deepEqual(wt.mergeFrom(w2, 'dulger/run1'), { ok: true });
  assert.equal(wt.land(w2, 'dulger/run1'), true);
  wt.removeWorktree(repo, w2, 'dulger-wip/run1/c2');

  const files = wt.git(repo, ['ls-tree', '--name-only', 'dulger/run1']).split('\n');
  assert.deepEqual(files.sort(), ['README.md', 'a.txt', 'b.txt']);
  assert.equal(wt.currentBranch(repo), 'main');
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'hello\n');
});

test('mergeFrom reports conflicts and aborts cleanly', () => {
  const repo = tempRepo();
  wt.createBranch(repo, 'dulger/run2', wt.headRef(repo));
  const w1 = join(worktrees, 'c1');
  const w2 = join(worktrees, 'c2');
  wt.createWorktree(repo, w1, 'dulger-wip/run2/c1', 'dulger/run2');
  wt.createWorktree(repo, w2, 'dulger-wip/run2/c2', 'dulger/run2');
  writeFileSync(join(w1, 'README.md'), 'from c1\n');
  writeFileSync(join(w2, 'README.md'), 'from c2\n');
  wt.commitAll(w1, 'c1');
  wt.commitAll(w2, 'c2');
  assert.equal(wt.mergeFrom(w1, 'dulger/run2').ok && wt.land(w1, 'dulger/run2'), true);
  const r = wt.mergeFrom(w2, 'dulger/run2');
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, ['README.md']);
  assert.equal(wt.git(w2, ['status', '--porcelain']), '');
});

test('mergeFrom with keepConflicts leaves markers that commitAll can resolve', () => {
  const repo = tempRepo();
  wt.createBranch(repo, 'dulger/run3', wt.headRef(repo));
  const w1 = join(worktrees, 'c1');
  const w2 = join(worktrees, 'c2');
  wt.createWorktree(repo, w1, 'dulger-wip/run3/c1', 'dulger/run3');
  wt.createWorktree(repo, w2, 'dulger-wip/run3/c2', 'dulger/run3');
  writeFileSync(join(w1, 'README.md'), 'from c1\n');
  writeFileSync(join(w2, 'README.md'), 'from c2\n');
  wt.commitAll(w1, 'c1');
  wt.commitAll(w2, 'c2');
  wt.mergeFrom(w1, 'dulger/run3'); wt.land(w1, 'dulger/run3');
  const r = wt.mergeFrom(w2, 'dulger/run3', { keepConflicts: true });
  assert.equal(r.ok, false);
  assert.match(readFileSync(join(w2, 'README.md'), 'utf8'), /<<<<<<<[\s\S]*>>>>>>>/);
  // An agent resolves the conflict; the next commit completes the merge and merge-back succeeds.
  writeFileSync(join(w2, 'README.md'), 'from c1 and c2\n');
  assert.equal(wt.commitAll(w2, 'resolved'), true);
  assert.equal(wt.land(w2, 'dulger/run3'), true);
  assert.equal(wt.git(repo, ['show', 'dulger/run3:README.md']), 'from c1 and c2');
});
