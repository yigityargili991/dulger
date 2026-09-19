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

test('all generated pages have one title, unique anchors and working local links', () => {
  const pages = readdirSync(site, { recursive: true }).filter((p) => p.endsWith('.html'));
  assert.ok(pages.length >= 10);
  for (const path of pages) {
    const body = html(path);
    assert.equal([...body.matchAll(/<h1\b/g)].length, 1, path);
    const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(ids.length, new Set(ids).size, `${path}: duplicate anchors`);
    for (const [, href] of body.matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|data:|mailto:)/.test(href)) continue;
      const url = new URL(href, `https://docs.invalid/${path}`);
      const target = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
      assert.ok(existsSync(join(site, target)), `${path}: broken link ${href}`);
      if (url.hash) assert.ok(html(target).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${path}: broken anchor ${href}`);
    }
  }
});

test('published docs cover the released setup and recovery features', () => {
  const setup = html('session-setup/index.html');
  for (const term of ['/doctor', '/profile', '/review', 'Harness', '--current-settings']) assert.ok(setup.includes(term), term);
  assert.ok(html('how-a-run-works/index.html').includes('/commands/#command-prediction'));
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(html('changelog/index.html').includes(`${version} —`));
  assert.equal(JSON.parse(html('version.json')).version, version);
});

test('new sections cannot disappear silently; fenced headings stay in their example', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'dulger-docs-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const file of ['README.md', 'CHANGELOG.md', 'package.json']) cpSync(join(root, file), join(fixture, file));
  cpSync(docs, join(fixture, 'docs'), { recursive: true, filter: (path) => !/\/(node_modules|dist)(\/|$)/.test(path) });
  symlinkSync(join(docs, 'node_modules'), join(fixture, 'docs/node_modules'), 'dir');
  const readme = readFileSync(join(fixture, 'README.md'), 'utf8');
  const run = (tag = '') => spawnSync(process.execPath, ['docs/build.mjs'], { cwd: fixture, encoding: 'utf8', env: { ...process.env, CI_COMMIT_TAG: tag } });
  writeFileSync(join(fixture, 'README.md'), `${readme}\n\n\`\`\`md\n## Example heading\n\`\`\`\n`);
  assert.equal(run().status, 0);
  writeFileSync(join(fixture, 'README.md'), `${readme}\n\n## New feature\nMust not be lost.\n`);
  assert.match(run().stderr, /README section needs one docs route: New feature/);
  assert.match(run('v999.0.0').stderr, /Release tag must match/);
});
