// The result review against temporary repositories: the report without command syntax, changed files
// and their diffs (binary included), verification stated even when nothing was configured, the merge
// as From, Into and State with its blockers, its confirmation, success, a conflict and its abort, and
// the awkward runs: a deleted branch, an unreadable board, no changes. Every section fits every size.
// What each section means is in `?`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as git from '../src/git/worktree.ts';
import * as store from '../src/board/store.ts';
import { createBoard } from '../src/board/create.ts';
import { createReviewPage, tailFit, type ReviewDeps, type ReviewOptions } from '../src/app/pages/review.ts';
import { SIZES, assertFrame, ch, key, press, withColour } from './kit.helpers.ts';
import { app, attentionRun, homePage, land, missingBranchRun, readyRun, repo, unreadableRun } from './app.runs.fixtures.ts';

/** The help overlay's text alone, as one line of words. */
function help(text: string): string {
  const lines = text.split('\n');
  const top = lines.findIndex((l) => l.includes('─ Help '));
  if (top < 0) return '';
  const from = [...lines[top]!].indexOf('╭');
  const to = [...lines[top]!].indexOf('╮', from);
  const out: string[] = [];
  for (const l of lines.slice(top + 1)) { if ([...l][from] === '╰') break; out.push([...l].slice(from + 1, to).join('')); }
  return out.join(' ').replace(/[┃│]/g, ' ').replace(/\s+/g, ' ').trim();
}

function review(root: string, runId: string, o: ReviewOptions = {}, size?: { rows: number; cols: number }) {
  const calls: string[] = [];
  const deps: Partial<ReviewDeps> = {
    launchResume: async (_ctx, id, opts = {}) => { calls.push(`resume ${id}${opts.currentSettings ? ' current' : ''}`); },
    launchRetry: async (_ctx, id, card) => { calls.push(`retry ${id} ${card}`); },
  };
  const a = app(root, [homePage], size);
  a.ctx.push(createReviewPage(a.ctx, runId, o, deps));
  return { ...a, calls };
}

test('every section fits every size, from 1×1 up', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3');
  const a = review(root, 'r3');
  for (const section of ['s', 'f', 'v', 'm']) {
    a.s.key(ch(section));
    for (const [rows, cols] of SIZES) { a.s.resize(rows, cols); assertFrame(a.s.lines, rows, cols, `section ${section}`); }
    a.s.resize(40, 120);
  }
  a.s.key(ch('f'));
  a.s.key(key('tab'));
  for (const [rows, cols] of SIZES) { a.s.resize(rows, cols); assertFrame(a.s.lines, rows, cols, 'diff focused'); }
  withColour(() => { a.s.resize(24, 80); assertFrame(a.s.lines, 24, 80, 'colour'); });
  await a.quit();
});

test('summary: the full report with the diff stat; what comes next is keys, not sentences', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5');
  const a = review(root, 'r5');
  const text = a.s.text;
  assert.match(text, /\[?Summary\]?\s+Files 1\s+Verification passed\s+Merge ready/);
  assert.match(text, /Run r5 {2}main @ [0-9a-f]{7} → dulger\/r5/);
  assert.match(text, /Landed 3 of 3 cards, docs updated/);
  assert.match(text, /Final verification/);
  assert.match(text, /✓ node --test test\/config\.test\.js \(exit 0\)/);
  a.s.key(key('end'));
  assert.match(a.s.text, /Changes/);
  assert.match(a.s.text, /feature\.txt \| 1 \+/);
  assert.doesNotMatch(a.s.text, /Next|Merge it into main/, 'no next-steps prose');
  assert.match(a.s.text, / m merge /, 'the merge is a key in the footer');
  assert.doesNotMatch(a.s.text, /git merge|dulger (resume|retry)/, 'no command syntax');
  assert.match(a.s.text, /Runs?.*Review r5|Home › Review r5/);
  await a.quit();
});

test('files: changed files with counts, the diff beside them, paging, wrap, full screen and the filter', async (t) => {
  const root = repo(t);
  const many = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`src-${i}.txt`, Array.from({ length: 80 }, (_, j) => `line ${j} of file ${i} `.repeat(i === 1 ? 12 : 1)).join('\n') + '\n']));
  readyRun(root, 'r5', many);
  const a = review(root, 'r5');
  a.s.key(ch('f'));
  let text = a.s.text;
  assert.match(text, /─ ❯ Files ─/);
  assert.match(text, /❯ src-0\.txt\s+\+80 -0/);
  assert.match(text, /─ src-0\.txt ─+╮/, 'no wrap: nothing in the border');
  assert.match(text, /\+line 0 of file 0/);
  a.s.key(key('pagedown'));
  assert.match(a.s.text, /\+line 3\d of file 0/, 'PgDn pages the diff while the list keeps the arrows');
  a.s.key(key('down'));
  assert.match(a.s.text, /─ src-1\.txt ─/);
  a.s.key(ch('w'));
  assert.match(a.s.text, /─ src-1\.txt ─+ wrap ─/);
  a.s.key(key('tab'));
  assert.match(a.s.text, /tab files/);
  a.s.key(key('escape'));
  assert.match(a.s.text, /tab diff/, 'Esc in the diff goes back to the files, not off the page');
  a.s.key(key('enter'));
  assert.doesNotMatch(a.s.text, /─ (❯ )?Files ─/, 'Enter opens the diff full screen, over the files');
  assert.match(a.s.text, /src-1\.txt/);
  a.s.key(key('escape'));
  a.s.type('/src-2');
  text = a.s.text;
  assert.match(text, /src-2\.txt/);
  assert.doesNotMatch(text, /❯ src-0\.txt/);
  a.s.key(ch('m'));
  assert.match(a.s.text, /─ (❯ )?Files ─/, 'letters go to the filter while it is typed');
  a.s.key(key('escape'));
  a.s.key(key('escape'));
  await a.quit();
});

test('files: a binary file says so; a run without changes and a deleted branch say why there is nothing', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5', { 'logo.bin': Buffer.from([0, 1, 2, 3, 0, 255, 0]) });
  const a = review(root, 'r5');
  a.s.key(ch('f'));
  assert.match(a.s.text, /logo\.bin\s+bin/);
  assert.match(a.s.text, /─ logo\.bin ─+ binary ─/);
  assert.match(a.s.text, /Binary files/);
  await a.quit();

  const none = createBoard(root, 'Nothing to do', 'r6');
  none.cards = []; store.saveBoard(root, none);
  const b = review(root, 'r6');
  b.s.key(ch('f'));
  assert.match(b.s.text, /No changes/);
  b.s.key(ch('m'));
  assert.match(b.s.text, /State\s+✗ no changes/);
  await b.quit();

  missingBranchRun(root, 'r1');
  const c = review(root, 'r1');
  assert.match(c.s.text, /Run r1/, 'the report still shows');
  c.s.key(ch('f'));
  assert.match(c.s.text, /Branch gone/);
  c.s.key(ch('m'));
  assert.match(c.s.text, /From\s+dulger\/r1 · gone/);
  assert.match(c.s.text, /State\s+✗ branch gone/);
  c.s.key(key('enter'));
  assert.match(c.s.text, /Merge: branch gone/);
  await c.quit();
});

test('verification: final and per-card results with exit code and duration, failures whole, nothing configured stated', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3');
  const a = review(root, 'r3');
  a.s.key(ch('v'));
  const text = a.s.text;
  assert.match(text, /Final verification/);
  assert.match(text, /✗ npm run lint {3}exit 2 · 0\.8s/);
  assert.match(text, /lint: 3 problems/);
  assert.match(text, /src\/a\.ts: unused import/);
  assert.match(text, /✓ c1 {2}Parse the config/);
  assert.match(text, /· node --test test\/config\.test\.js {3}not run/);
  assert.match(text, /✗ npm test {3}exit 1 · 4\.3s/);
  assert.match(text, /not ok 1 - GET \/health/);
  assert.match(text, /⊘ c3 {2}Document it/);
  assert.match(text, /no verify commands/);
  await a.quit();

  const b = createBoard(root, 'Unchecked', 'r7');
  b.cards = []; b.settings = { version: 1, config: {} as never };
  b.finalVerification = { ref: git.git(root, ['rev-parse', b.runBranch]), results: [] };
  store.saveBoard(root, b);
  const v = review(root, 'r7');
  v.s.key(ch('v'));
  assert.match(v.s.text, /Final verification\s+│\s*│?\s*! none/);
  assert.match(v.s.text, /Verification none/);
  v.s.key(key('f1'));
  assert.match(help(v.s.text), /None: no verify commands were configured, so nothing checked the result/, '? says what it means');
  await v.quit();
});

test('merge blocked: From, Into, and State says by what; the resume that fixes it is the key offered', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3');
  const a = review(root, 'r3');
  a.s.key(ch('m'));
  const text = a.s.text;
  assert.match(text, /From\s+dulger\/r3 · 1 file changed, 1 insertion\(\+\)/);
  assert.match(text, /Into\s+main/);
  assert.match(text, /State\s+✗ verify failed/);
  assert.match(text, /Not landed\s+c2 failed, c3 blocked/, 'only what landed is merged');
  assert.match(text, /│ {3}Merge {2}/, 'the button is there, dimmed');
  assert.doesNotMatch(text, /not now|Resume the run \(r\)|To leave the result/, 'no sentences');
  assert.match(text, / r resume /, 'the key that fixes it');
  a.s.key(key('enter'));
  assert.match(a.s.text, /Merge: verify failed/);
  a.s.key(ch('r'));
  a.s.key(ch('R'));
  a.s.key(ch('t'));
  await a.settle();
  assert.match(a.s.text, /Settings: the run's · differ: Parallel cards/, 'a retry says which settings it keeps, by their names');
  a.s.key(key('enter'));
  await a.settle();
  assert.deepEqual(a.calls, ['resume r3', 'retry r3 c2'], 'one resume (its dialog has the settings choice); R is no key any more');
  writeFileSync(join(root, 'README.md'), 'dirty\n');
  a.ctx.navigate('home');
  a.ctx.push(createReviewPage(a.ctx, 'r3', { section: 'merge' }));
  assert.match(a.s.text, /State\s+✗ verify failed, dirty tree/);
  await a.quit();
});

test('merge: names source and destination, asks first, merges under busy, then shows the merged state only', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5');
  const a = review(root, 'r5');
  a.s.key(ch('m'));
  assert.match(a.s.text, /State\s+✓ ready/);
  assert.match(a.s.text, /\[ Merge \]/);
  a.s.key(key('f1'));
  assert.match(help(a.s.text), /To leave the result on its branch, go back \(esc\): it stays on dulger\/r5/, 'moved to ?');
  a.s.key(key('escape'));
  a.s.key(ch('m'));
  assert.match(a.s.text, /╭─ Merge ─/);
  assert.match(a.s.text, /dulger\/r5 → main/, 'source and destination');
  assert.match(a.s.text, /Changes\s+1 file changed, 1 insertion\(\+\)/);
  a.s.key(key('enter'));
  await a.settle();
  assert.match(a.s.text, /Not merged/, 'the safe choice is focused first');
  assert.throws(() => readFileSync(join(root, 'feature.txt')));
  a.s.key(key('enter'));
  a.s.key(key('right'));
  a.s.key(key('enter'));
  await a.settle();
  assert.equal(readFileSync(join(root, 'feature.txt'), 'utf8'), 'new\n');
  assert.match(a.s.text, /Merged → main/);
  assert.match(a.s.text, /State\s+✓ merged → main/);
  assert.match(a.s.text, /\bMerged\b(?! →)/, 'the section bar says Merged');
  assert.doesNotMatch(a.s.text, /Merge merged/);
  assert.doesNotMatch(a.s.text, /✓ ready|\[ Merge \]|│ {3}Merge {2}/, 'no second merge is offered');
  a.s.key(key('enter'));
  assert.match(a.s.text, /Merged → main/);
  a.s.key(ch('s'));
  assert.match(a.s.text, /\(merged into main\)/);
  await a.quit();
});

test('merge conflict: the error is shown in full on the page, and the stopped merge can be aborted', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5');
  writeFileSync(join(root, 'feature.txt'), 'different\n');
  git.git(root, ['add', '.']);
  git.git(root, ['commit', '-qm', 'a conflicting change']);
  const a = review(root, 'r5', { section: 'merge' });
  a.s.key(key('enter'));
  a.s.key(key('right'));
  a.s.key(key('enter'));
  await a.settle();
  const text = a.s.text;
  assert.match(text, /Conflicts: 1 file/);
  assert.match(text, /✗ merge failed/);
  assert.match(text, /git merge --no-edit dulger\/r5 failed/, 'git\'s own words, whole');
  assert.match(text, /CONFLICT \(add\/add\): Merge conflict in feature\.txt/);
  assert.match(text, /! conflicts: 1\s+│?\s*│?\s*feature\.txt/);
  assert.match(text, / a abort /, 'the abort is a key');
  assert.match(text, /Review r5/, 'still on the review page');
  a.s.key(ch('a'));
  assert.match(a.s.text, /Abort merge/);
  assert.match(a.s.text, /main back to before the merge/);
  assert.match(a.s.text.replace(/[│\s]+/g, ' '), /Discards staged resolutions and the 1 conflicted file/, 'what it discards');
  a.s.key(key('right'));
  a.s.key(key('enter'));
  await a.settle();
  assert.match(a.s.text, /Merge aborted/);
  assert.equal(git.isClean(root), true);
  assert.equal(readFileSync(join(root, 'feature.txt'), 'utf8'), 'different\n');
  assert.doesNotMatch(a.s.text, /! conflicts/);
  await a.quit();
});

test('opened to merge (from Runs), the confirmation comes up at once', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5');
  const a = review(root, 'r5', { section: 'merge', merge: true });
  assert.match(a.s.text, /dulger\/r5 → main/);
  a.s.key(key('escape'));
  await a.settle();
  assert.match(a.s.text, /From\s+dulger\/r5/, 'cancelled: the review stays, on the merge section');
  await a.quit();
});

test('an unreadable board or an unknown run is a page that says so, never a crash', async (t) => {
  const root = repo(t);
  unreadableRun(root, 'r4');
  const a = review(root, 'r4');
  assert.match(a.s.text, /Cannot review/);
  assert.match(a.s.text, /JSON/, 'the error itself');
  for (const [rows, cols] of SIZES) { a.s.resize(rows, cols); assertFrame(a.s.lines, rows, cols, 'unreadable'); }
  a.s.resize(24, 80);
  a.s.key(ch('m'));
  a.s.key(key('escape'));
  assert.match(a.s.text, /home page/);
  a.ctx.push(createReviewPage(a.ctx, 'nope'));
  assert.match(a.s.text, /No run nope/);
  await a.quit();
});

test('mouse: a click on a section switches to it; the merge button merges', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5');
  const a = review(root, 'r5');
  const bar = a.s.text.split('\n')[2]!;
  a.s.mouse(press(2, bar.indexOf('Files') + 1));
  assert.match(a.s.text, /─ ❯ Files ─/);
  a.s.mouse(press(2, bar.indexOf('Merge') + 1));
  const lines = a.s.text.split('\n');
  const row = lines.findIndex((l) => /\[ Merge \]/.test(l));
  assert.ok(row > 0);
  a.s.mouse(press(row, lines[row]!.indexOf('Merge') + 1));
  await a.settle();
  assert.match(a.s.text, /dulger\/r5 → main/, 'the confirmation');
  a.s.key(key('escape'));
  await a.quit();
});

test('palette and help offer the sections and every result action', async (t) => {
  const root = repo(t);
  attentionRun(root, 'r3');
  const a = review(root, 'r3');
  a.s.key(key('ctrl', 'p'));
  const palette = a.s.text;
  assert.match(palette, /│ . Merge dulger\/r3 → main/, 'no prefix: the page\'s own');
  assert.match(palette, /│ . Resume /);
  assert.doesNotMatch(palette, /Review[^│]*: /, 'neither the page title nor its run id');
  assert.doesNotMatch(palette, /m m/, 'the merge key is m, not "m m"');
  // The merge is off: listed first but not selected; choosing it says why.
  a.s.key(key('up'));
  a.s.key(key('enter'));
  await a.settle();
  assert.match(a.s.text, /Merge: verify failed/);
  a.s.key(ch('?'));
  const said = help(a.s.text);
  assert.match(said, /^Summary The run's report/, 'the section on screen first');
  for (const group of ['Sections', 'Reading', 'Files', 'The result']) assert.match(said, new RegExp(group));
  assert.match(said, /abort a stopped merge/);
  await a.quit();
});

test('a merge the person started is left alone: no abort offered, and merging is blocked with that reason', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5');
  // The person's own in-progress merge, with a conflict, nothing to do with dulger.
  git.git(root, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(root, 'README.md'), 'feature\n');
  git.git(root, ['commit', '-qam', 'feature']);
  git.git(root, ['checkout', '-q', 'main']);
  writeFileSync(join(root, 'README.md'), 'mainline\n');
  git.git(root, ['commit', '-qam', 'mainline']);
  assert.throws(() => git.git(root, ['merge', 'feature']), 'the person\'s merge conflicts and leaves MERGE_HEAD');
  const headBefore = git.git(root, ['rev-parse', 'MERGE_HEAD']);

  const a = review(root, 'r5', { section: 'merge' });
  const text = a.s.text;
  assert.match(text, /State\s+✗ merge in progress/);
  assert.doesNotMatch(text, / a abort /, 'no abort of a merge dulger did not start');
  // Pressing m (merge) does not merge over it.
  a.s.key(ch('m'));
  await a.settle();
  assert.match(a.s.text, /Merge: merge in progress/);
  assert.equal(git.git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }), headBefore, 'the person\'s merge is untouched');
  await a.quit();
});

test('file names that do not fit keep their end, so files in long paths stay apart', async (t) => {
  const root = repo(t);
  readyRun(root, 'r5', { 'out/cards/c1/test1.txt': 'a\n', 'out/cards/c2/test1.txt': 'b\n', 'out/cards/c1/test2.txt': 'c\n' });
  const a = review(root, 'r5', { section: 'files' }, { rows: 24, cols: 80 });
  const text = a.s.text;
  for (const tail of ['c1/test1.txt', 'c2/test1.txt', 'c1/test2.txt']) assert.match(text, new RegExp(`…?/?${tail.replace('.', '\\.')}\\s`), `${tail} is readable`);
  assert.doesNotMatch(text, /out\/c…t1\.txt/, 'never cut in the middle of the file name');
  assert.equal(tailFit('out/cards/c1/test1.txt', 15), '…/c1/test1.txt', 'from a folder boundary');
  assert.equal(tailFit('short.txt', 15), 'short.txt');
  await a.quit();
});

test('verification never says "none" when cards had verify commands', async (t) => {
  const root = repo(t);
  const b = readyRun(root, 'r6');
  // The card with the verify command failed and did not land, so the final result had nothing to run.
  b.finalVerification = { ref: b.finalVerification!.ref, results: [] };
  b.cards[1]!.status = 'failed';
  b.cards[1]!.verification = [{ command: 'node -e "process.exit(3)"', ok: false, exitCode: 3, durationMs: 10, output: 'boom' }];
  store.saveBoard(root, b);
  const a = review(root, 'r6');
  assert.match(a.s.text, /Verification card failed/, 'the section bar says what the cards found');
  assert.doesNotMatch(a.s.text, /Verification none/);
  a.s.key(ch('v'));
  const text = a.s.text.replace(/[│\s]+/g, ' ');
  assert.match(text, /Final verification ! cards only/);
  assert.doesNotMatch(text, /Final verification ! none/, 'not above a failed one');
  await a.quit();
});
