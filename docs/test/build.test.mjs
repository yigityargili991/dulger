import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, cpSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const docs = fileURLToPath(new URL('../', import.meta.url));
const root = dirname(docs.replace(/\/$/, ''));
const site = join(docs, 'dist/public');
const html = (path) => readFileSync(join(site, path), 'utf8');
const pages = readdirSync(site, { recursive: true }).filter((p) => p.endsWith('.html'));

test('all generated pages have one title and unique anchors', () => {
  assert.ok(pages.length >= 10);
  for (const path of pages) {
    const body = html(path);
    assert.equal([...body.matchAll(/<h1\b/g)].length, 1, path);
    const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(ids.length, new Set(ids).size, `${path}: duplicate anchors`);
  }
});

test('local links and the stylesheet work with the site at a domain root or under a path', () => {
  for (const mount of ['/', '/dulger/']) {
    for (const path of pages) {
      // A page is served at its directory URL; 404.html as a miss directly under the site root.
      const page = new URL(mount + path.replace(/index\.html$/, ''), 'https://docs.invalid');
      for (const [, href] of html(path).matchAll(/href="([^"]+)"/g)) {
        if (/^(https?:|data:|mailto:)/.test(href)) continue;
        const url = new URL(href, page);
        const where = `${mount} ${path}: ${href}`;
        assert.ok(url.origin === page.origin && url.pathname.startsWith(mount), `${where} leaves the site`);
        const target = url.pathname.slice(mount.length).replace(/(^|\/)$/, '$1index.html');
        assert.ok(existsSync(join(site, target)), `${where} is broken`);
        if (url.hash) assert.ok(html(target).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${where} has no anchor`);
      }
    }
  }
  assert.ok(html('install/index.html').includes('<link rel="stylesheet" href="../style.css">'));
  assert.ok(html('index.html').includes('<link rel="stylesheet" href="./style.css">'));
});

test('published docs cover the released setup and recovery features', () => {
  const setup = html('session-setup/index.html');
  for (const term of ['/doctor', '/profile', '/review', 'Harness', '--current-settings']) assert.ok(setup.includes(term), term);
  assert.ok(html('how-a-run-works/index.html').includes('href="../commands/#command-prediction"'));
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(html('changelog/index.html').includes(`${version} —`));
  assert.equal(JSON.parse(html('version.json')).version, version);
  assert.deepEqual(readdirSync(join(docs, 'dist')), ['public']);
});

test('new sections cannot disappear silently; fenced headings stay in their example', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'dulger-docs-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const file of ['CHANGELOG.md', 'package.json']) cpSync(join(root, file), join(fixture, file));
  cpSync(docs, join(fixture, 'docs'), { recursive: true, filter: (path) => !/\/(node_modules|dist)(\/|$)/.test(path) });
  symlinkSync(join(docs, 'node_modules'), join(fixture, 'docs/node_modules'), 'dir');
  const manual = readFileSync(join(fixture, 'docs/manual.md'), 'utf8');
  const { version } = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
  const run = (tag = '') => spawnSync(process.execPath, ['docs/build.mjs'], { cwd: fixture, encoding: 'utf8', env: { ...process.env, GITHUB_REF_TYPE: tag && 'tag', GITHUB_REF_NAME: tag } });
  writeFileSync(join(fixture, 'docs/manual.md'), `${manual}\n\n\`\`\`md\n## Example heading\n\`\`\`\n`);
  assert.equal(run().status, 0);
  assert.equal(run(`v${version}`).status, 0);
  writeFileSync(join(fixture, 'docs/manual.md'), `${manual}\n\n## New feature\nMust not be lost.\n`);
  assert.match(run().stderr, /Manual section needs one docs route: New feature/);
  assert.match(run('v999.0.0').stderr, /Release tag must match/);
});
