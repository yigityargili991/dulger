// The Memory tab driven through the real shell against a temporary repository. The page shows the
// notes as data (glyph, text, age), the counts in the list's border and the selected note's facts;
// what memory is, where it lives and what a prompt takes of it are in help.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../src/git/worktree.ts';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { listMemory, memoryPath, type Learning } from '../src/context/memory.ts';
import { createApp } from '../src/app/shell.ts';
import { createMemoryPage } from '../src/app/pages/memory.ts';
import type { IconSet } from '../src/tui/theme.ts';
import type { Page } from '../src/app/types.ts';
import { SIZES, assertFrame, ch, fakeScreens, key, press, wheel } from './kit.helpers.ts';

process.env.DULGER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dulger-app-memory-data-'));
const NOW = Date.parse('2026-11-15T12:00:00Z');
const tick = () => new Promise<void>((r) => setImmediate(r));
/** Everything the page's help says, as one text. */
const helpText = (page: Page) => (page.help?.() ?? []).flatMap((h) => [h.title, ...[h.text ?? []].flat(), ...h.keys.map((k) => `${k.key} ${k.label}`)]).join('\n');

function repo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'dulger-app-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git.git(root, ['init', '-q', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Test']); git.git(root, ['config', 'user.email', 'test@test']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'export {}\n');
  writeFileSync(join(root, 'README.md'), 'hello\n'); git.git(root, ['add', '.']); git.git(root, ['commit', '-qm', 'initial']);
  return root;
}

const makeConfig = (o: Partial<Config['memory']> = {}): Config => ({ ...structuredClone(DEFAULT_CONFIG), harness: 'fake', memory: { location: 'repo', maxItems: 40, maxChars: 6000, ...o } });

function learning(id: string, text: string, o: Partial<Learning> = {}): Learning {
  return { id, text, files: [], runId: 'r1', cardId: 'c1', harness: 'claude', createdAt: '2026-11-10T10:00:00Z', lastSeenAt: '2026-11-10T10:00:00Z', seen: 1, ...o };
}

function seed(root: string, config: Config, lines: Learning[]): string {
  const path = memoryPath(root, config.memory);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function setup(root: string, o: { config?: Config; rows?: number; cols?: number; icons?: IconSet } = {}) {
  const config = o.config ?? makeConfig();
  const screens = fakeScreens(o.rows ?? 30, o.cols ?? 120);
  let page!: Page;
  const app = createApp({
    repoRoot: root, session: { overrides: {}, yes: false, quiet: false, allowDirty: false }, version: '1.0.0', config: () => config,
    pages: [(c) => (page = createMemoryPage(c))], openScreen: screens.factory, icons: o.icons ?? 'unicode', now: () => NOW, branch: () => 'main',
  });
  const done = app.run();
  return { app, done, config, get page() { return page; }, get s() { return screens.current; }, async close() { app.quit(); await done; } };
}

test('empty memory is a title and a key; help says what memory is; adding refuses empty text, adds a note and treats a repeat as known', async (t) => {
  const root = repo(t);
  const env = setup(root);
  const { s, config, close } = env;
  assert.match(s.text, /No notes yet/);
  assert.doesNotMatch(s.text, /Agents add|memory\.jsonl|each prompt|characters/, 'no explainer, no path, no limits on the page');
  assert.match(s.text.split('\n').at(-1)!, /^ a add {2}\? help\s*$/, 'the footer is the key that matters');
  const help = helpText(env.page);
  assert.match(help, /What agents learn about this repository/, 'what memory is, in help');
  assert.match(help, /Each prompt gets the most relevant 40 notes, up to 6,000 characters/, 'the limits, in help');
  assert.match(help, /Kept in this repository \(\.dulger\)[\s\S]*p shows the path/, 'where it lives, in help');

  s.key(ch('a'));
  assert.match(s.text, /Add a note/);
  assert.match(s.text, /What should agents know\?/, 'a few words of placeholder');
  assert.doesNotMatch(s.text, /a convention, a pitfall/, 'no explainer in the dialog');
  s.key(key('enter'));
  assert.match(s.text, /Empty note/, 'an empty note is refused with a message');
  s.type('src/app.ts exports nothing yet; keep it that way');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Note added · 1 file linked/);
  assert.match(s.text, /src\/app\.ts exports nothing yet/);
  const [added] = listMemory(root, config).items;
  assert.deepEqual(added!.files, ['src/app.ts']);

  s.key(ch('a'));
  s.type('src/app.ts exports nothing yet; keep it that way.');
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Already known · seen ×2/);
  assert.doesNotMatch(s.text, /error/i);
  assert.equal(listMemory(root, config).items.length, 1);
  assert.equal(listMemory(root, config).items[0]!.seen, 2);
  assert.match(s.text, /Seen\s+×2/);

  s.key(ch('a'));
  s.key(key('escape'));
  await tick();
  assert.equal(listMemory(root, config).items.length, 1, 'a cancelled prompt adds nothing');
  await close();
});

test('list: glyph, text and age per note, the counts in the border, the detail pane, sorting and filtering', async (t) => {
  const root = repo(t);
  const config = makeConfig({ maxItems: 2, maxChars: 80 });
  seed(root, config, [
    learning('aaaaaaaaaaa1', 'The oldest note about the README.md file', { files: ['README.md'], lastSeenAt: '2026-11-10T10:00:00Z', seen: 3 }),
    learning('bbbbbbbbbbb2', 'A note recorded by hand about config loading', { runId: 'manual', cardId: 'manual', createdAt: '2026-11-12T10:00:00Z', lastSeenAt: '2026-11-15T11:00:00Z' }),
    learning('ccccccccccc3', 'Old note about a removed module in gone/module.ts', { files: ['gone/module.ts'], createdAt: '2026-11-13T10:00:00Z', lastSeenAt: '2026-11-13T10:00:00Z' }),
  ]);
  const env = setup(root, { config, rows: 40, cols: 120 });
  const { s, close } = env;
  const lines = () => s.text.split('\n');
  assert.doesNotMatch(s.text, /Last seen|Files {2}From|each prompt|compacting would|recently seen first/, 'no header row, no summary sentences, no captions');
  assert.match(s.text, /─ ❯ Notes ─+ \(! 3 notes · \d+ chars\) ─╮/, 'the counts in the border, marked when a prompt cannot take them all');
  assert.match(helpText(env.page), /most relevant 2 notes, up to 80 characters/, 'the limits are in help');
  // Recently seen first: the hand-written note was seen an hour ago.
  const rowOf = (w: string) => lines().findIndex((l) => l.includes(w));
  assert.ok(rowOf('A note recorded by hand') < rowOf('Old note about a removed') && rowOf('Old note about a removed') < rowOf('The oldest note about'));
  assert.match(lines()[rowOf('A note recorded by hand')]!, /❯ · A note recorded by hand about config loading\s+1h │/, 'glyph, text, age');
  assert.match(lines()[rowOf('Old note about a removed')]!, /│ {3}! Old note about a removed module/, 'a note whose files are all deleted is marked');
  // The detail pane shows the selected note's facts.
  assert.match(s.text, /Seen\s+×1/);
  assert.match(s.text, /Last\s+1h · 2026-11-15 \d\d:00/, 'the age as the list shows it, and when');
  assert.match(s.text, /First\s+2026-11-12/);
  assert.match(s.text, /From\s+by hand · claude/);

  s.key(ch('s'));
  assert.match(s.text, /Oldest first/, 'the toast');
  assert.match(s.text, /╰─ oldest first ─/, 'the order is named while it is not the usual one');
  assert.ok(rowOf('The oldest note about') < rowOf('A note recorded by hand'));
  assert.match(s.text, /From\s+by hand/, 'the selection stays on the same note when the order changes');
  s.key(key('down'));
  s.key(key('down'));
  assert.match(s.text, /gone\/module\.ts {2}missing/);
  assert.match(s.text, /From\s+run r1 · card c1 · claude/);
  assert.doesNotMatch(s.text, /compacting drops this note/, 'what that means is in help');
  assert.match(helpText(env.page), /^Old note about a removed module in gone\/module\.ts\nNone of its files are in this checkout, so compacting drops it\./m, 'help leads with the selected note');

  s.key(ch('/'));
  s.type('config');
  assert.match(s.text, /⌕ config.*1\/3/);
  assert.doesNotMatch(s.text, /The oldest note about/);
  s.key(ch('q'));
  assert.match(s.text, /configq/, 'while filtering, letters go to the filter, not to quit');
  s.key(key('backspace'));
  s.key(key('enter'));
  assert.match(s.text, /A note recorded by hand/);
  s.key(key('escape'));
  assert.match(s.text, /The oldest note about/, 'Esc clears the filter');

  s.key(key('enter'));
  assert.match(s.text, /─ Note bbbbbbbbbbb2 ─[\s\S]*Seen   ×1[\s\S]*Id     bbbbbbbbbbb2/, 'Enter opens the whole note in a viewer');
  s.key(key('escape'));
  await close();
});

test('remove asks first, quoting the note, and removes exactly the selected id', async (t) => {
  const root = repo(t);
  const config = makeConfig();
  seed(root, config, [
    learning('aaaa11112222', 'Tests run with node --test and need no build', { lastSeenAt: '2026-11-14T10:00:00Z' }),
    learning('aaaa11113333', 'The scheduler retries a card twice before failing it', { lastSeenAt: '2026-11-13T10:00:00Z' }),
  ]);
  const { s, close } = setup(root, { config });
  s.key(ch('d'));
  assert.match(s.text, /Remove note/);
  assert.match(s.text, /“Tests run with node --test and need no build”/);
  assert.doesNotMatch(s.text, /no longer be given|rewritten/, 'the note, and the buttons');
  s.key(key('enter'));
  await tick();
  assert.equal(listMemory(root, config).items.length, 2, 'Enter on the safe default keeps the note');
  s.key(key('delete'));
  s.key(key('right'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Note removed/);
  assert.deepEqual(listMemory(root, config).items.map((l) => l.id), ['aaaa11113333'], 'the note with the longer shared prefix stayed');
  assert.doesNotMatch(s.text, /Tests run with node/);
  await close();
});

test('a hand-edited id that prefixes another is called out before removing', async (t) => {
  const root = repo(t);
  const config = makeConfig();
  seed(root, config, [learning('abc', 'Short id note', { lastSeenAt: '2026-11-14T10:00:00Z' }), learning('abcdef', 'Long id note with more words', { lastSeenAt: '2026-11-13T10:00:00Z' })]);
  const { s, close } = setup(root, { config });
  s.key(ch('d'));
  assert.match(s.text.replace(/[\s│]+/g, ' '), /! also removes 1 other note with id abc…/);
  s.key(key('escape'));
  await close();
});

test('compact confirms with what it merges and each note it drops, reports kept/dropped/merged and shows what was dropped', async (t) => {
  const root = repo(t);
  const config = makeConfig();
  const path = seed(root, config, [
    learning('aaaaaaaaaaa1', 'Keep this note about README.md', { files: ['README.md'] }),
    learning('aaaaaaaaaaa1', 'Keep this note about README.md', { files: ['README.md'], lastSeenAt: '2026-11-11T10:00:00Z' }),
    learning('ccccccccccc3', 'Drop this note about gone/module.ts', { files: ['gone/module.ts'] }),
  ]);
  const env = setup(root, { config });
  const { s, close } = env;
  s.key(ch('c'));
  assert.match(s.text, /Compact memory/);
  assert.match(s.text, /Merge\s+1 repeated sighting/);
  assert.match(s.text, /Drop\s+1 note/);
  assert.match(s.text, /· Drop this note about gone\/module\.ts/, 'each note that goes is listed');
  assert.match(s.text, /! files only on unmerged dulger\/…[\s\S]*branches count as missing/, 'the one consequence nobody could see');
  assert.doesNotMatch(s.text, /Compacting rewrites|prompt budget/, 'the facts, not what compaction is');
  assert.match(helpText(env.page), /even when the files exist on a result branch that is not merged yet/, 'which is in help');
  assert.match(s.text, /\[1 Memory !1\]/, 'the tab counts notes compaction would drop, not all notes');
  s.key(key('enter'));
  await tick();
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 3, 'cancelled: the file is untouched');
  s.key(ch('c'));
  s.key(key('right'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Dropped by compaction \(1\)/);
  assert.match(s.text, /Drop this note about gone\/module\.ts/);
  s.key(key('escape'));
  await tick();
  assert.match(s.text, /Compacted · 1 kept, 1 dropped, 1 merged/);
  assert.doesNotMatch(s.text, /\[1 Memory !/, 'nothing left to drop');
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
  s.key(ch('v'));
  assert.match(s.text, /Dropped by compaction \(1\)/, 'what was dropped can be read again');
  s.key(key('escape'));
  s.key(ch('c'));
  assert.match(s.text, /Merge\s+nothing/);
  assert.match(s.text, /Drop\s+nothing/);
  s.key(key('right'));
  s.key(key('enter'));
  await tick();
  assert.match(s.text, /Nothing to compact/);
  await close();
});

test('palette and help list every action; Tab moves to the detail pane; mouse selects and scrolls', async (t) => {
  const root = repo(t);
  const config = makeConfig();
  seed(root, config, Array.from({ length: 30 }, (_, i) => learning(`id${String(i).padStart(10, '0')}`, `Note number ${i}: alpha${i} bravo${i} charlie${i} delta${i}`, { lastSeenAt: `2026-11-${String(10 + (i % 5)).padStart(2, '0')}T10:00:00Z` })));
  const env = setup(root, { config, rows: 40, cols: 120 });
  const { s, close } = env;
  s.key(key('ctrl', 'p'));
  for (const title of ['Add a note', 'Remove note', 'Compact memory', 'Read note', 'Filter notes', 'Sort oldest first', 'Reload memory', 'Memory file path']) assert.match(s.text, new RegExp(title));
  assert.equal(env.page.commands!().length, 8, 'no entry per note');
  assert.ok(env.page.commands!().every((c) => c.group === undefined));
  s.key(key('escape'));
  s.key(ch('?'));
  assert.match(s.text, /Change memory/);
  assert.match(s.text, /compact: merge repeats/);
  s.key(key('escape'));
  assert.deepEqual(env.page.hints().map((h) => `${h.key} ${h.label}`), ['a add', 'd remove', 'c compact', '/ filter'], 'at most four keys');
  assert.match(helpText(env.page), /tab notes \/ detail pane/, 'the rest are in help');
  s.key(key('tab'));
  assert.match(s.text, /↑↓ scroll/);
  s.key(key('tab'));
  const before = s.text;
  const lines = s.text.split('\n');
  const row = lines.findIndex((l) => l.includes('Note number') && !l.includes('❯'));
  s.mouse(press(row, 10));
  assert.notEqual(s.text, before, 'a click selects another row');
  assert.ok(s.text.split('\n')[row]!.includes('❯'));
  s.mouse(wheel('down', row, 10));
  s.mouse(wheel('down', row, 10));
  assert.match(s.text, /Notes/);
  await close();
});

test('every size and glyph set fits, with notes and without', async (t) => {
  const root = repo(t);
  const config = makeConfig();
  for (const icons of ['unicode', 'ascii', 'nerd'] as const) {
    const { s, close } = setup(root, { config, icons });
    for (const [rows, cols] of SIZES) { s.resize(rows, cols); assertFrame(s.lines, rows, cols, `empty ${icons}`); }
    await close();
  }
  seed(root, config, [learning('aaaaaaaaaaa1', '日本語のノート 👩‍💻 with \x1b[31mescapes\x1b[0m and a very long text that needs wrapping '.repeat(3), { files: ['README.md', 'gone.ts'] })]);
  for (const icons of ['unicode', 'ascii', 'nerd'] as const) {
    const { s, close } = setup(root, { config, icons });
    for (const [rows, cols] of [...SIZES, [16, 60], [20, 160]] as Array<[number, number]>) {
      s.resize(rows, cols);
      assertFrame(s.lines, rows, cols, `notes ${icons}`);
    }
    s.resize(40, 160);
    assert.doesNotMatch(s.text, /\x1b/);
    await close();
  }
});

test('an unreadable memory file is an error state with the reader\'s own message, and r retries', async (t) => {
  const root = repo(t);
  const config = makeConfig();
  const path = memoryPath(root, config.memory);
  mkdirSync(path, { recursive: true });
  const env = setup(root, { config });
  const { s, close } = env;
  assert.match(s.text, /╭─ (❯ )?Memory ─/);
  assert.match(s.text, /! EISDIR/, 'the message itself');
  assert.match(s.text, /memory\.jsonl/, 'and the file');
  assert.deepEqual(env.page.hints().map((h) => h.key), ['r'], 'r is the key, not a');
  rmSync(path, { recursive: true });
  s.key(ch('r'));
  assert.match(s.text, /No notes yet/);
  await close();
});
