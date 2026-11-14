import { readFileSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Marked, Renderer } from 'marked';

const root = fileURLToPath(new URL('../', import.meta.url));
const docs = join(root, 'docs');
const out = join(docs, 'dist');
const read = (path) => readFileSync(join(root, path), 'utf8');
const readme = read('README.md');
const changelog = read('CHANGELOG.md');
const { version } = JSON.parse(read('package.json'));
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('Release tag must match package.json version');
}
if (!changelog.includes(`## ${version} —`)) throw new Error(`Missing changelog for ${version}`);

const slug = (text) => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Links are relative, so the site works at a domain root or under a path. Routes are one level deep.
const rel = (from, to) => (from === '/' ? '.' : '..') + to;
let current = '/';
const markdown = new Marked();
// Split tokens, not lines: a heading inside a fenced example is still code.
const sections = new Map();
let section = 'Introduction';
for (const token of markdown.lexer(readme)) {
  if (token.type === 'heading' && token.depth === 2) section = token.text;
  sections.set(section, (sections.get(section) ?? '') + token.raw);
}
const routes = [
  { path: '/', title: 'dulger', sections: ['Introduction'] },
  { path: '/install/', title: 'Install', sections: ['Install'] },
  { path: '/session-setup/', title: 'Session setup', sections: ['Session setup', 'Profiles, recovery and run controls'] },
  { path: '/how-a-run-works/', title: 'How a run works', sections: ['How a run works', 'The screen', 'Context and memory', 'Where things live', 'Safety', 'Sandbox', 'Running dulger in a container or VM', 'Known limitations'] },
  { path: '/commands/', title: 'Commands', sections: ['Commands', 'Command prediction'] },
  { path: '/configuration/', title: 'Configuration', sections: ['Configuration'] },
  { path: '/models/', title: 'Models', sections: ['Model routing', 'Choose models in the REPL', 'Direct API backends'] },
  { path: '/development/', title: 'Development', sections: ['Development'] },
  { path: '/changelog/', title: 'Changelog', sections: [] },
];
const covered = routes.flatMap((route) => route.sections);
for (const name of sections.keys()) {
  if (covered.filter((item) => item === name).length !== 1) throw new Error(`README section needs one docs route: ${name}`);
}
for (const name of covered) {
  if (!sections.has(name)) throw new Error(`Docs route refers to missing README section: ${name}`);
}
const anchors = new Map();
for (const route of routes) {
  for (const name of route.sections) {
    for (const token of markdown.lexer(sections.get(name))) {
      if (token.type === 'heading') anchors.set(slug(token.text), `${route.path}#${slug(token.text)}`);
    }
  }
}
markdown.use({ renderer: {
  heading({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    return `<h${depth} id="${slug(text)}">${text}</h${depth}>\n`;
  },
  link(token) {
    if (token.href.startsWith('#')) {
      const target = anchors.get(token.href.slice(1));
      if (!target) throw new Error(`Missing README anchor: ${token.href}`);
      token = { ...token, href: target };
    }
    if (token.href.startsWith('/')) token = { ...token, href: rel(current, token.href) };
    return `<a href="${escape(token.href)}">${this.parser.parseInline(token.tokens)}</a>`;
  },
  table(token) {
    return `<div class="table-scroll" tabindex="0" role="region" aria-label="Reference table">${Renderer.prototype.table.call(this, token)}</div>`;
  },
  code(token) {
    return Renderer.prototype.code.call(this, token).replace('<pre>', '<pre tabindex="0" role="region" aria-label="Code example">');
  },
} });

function page(route, content) {
  const from = route.path ?? '/';
  const nav = routes.map((r) => `<li><a href="${rel(from, r.path)}"${route.path === r.path ? ' aria-current="page"' : ''}>${r.title}</a></li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(route.title)} — dulger docs</title><meta name="description" content="Dulger ${escape(version)} documentation: ${escape(route.title)}.">
<link rel="stylesheet" href="${rel(from, '/style.css')}"><link rel="icon" href="data:,"></head>
<body><a class="skip-link" href="#main">Skip to content</a><header><nav aria-label="Main"><ul>${nav}</ul></nav></header>
<main id="main" tabindex="-1"><p class="version">Documentation for <a href="${rel(from, '/changelog/')}">v${escape(version)}</a></p>${content}</main>
<footer><a href="https://github.com/yigityargili991/dulger">Source on GitHub</a> · <a href="https://www.npmjs.com/package/@zamazingobjk/dulger">Install from npm</a></footer></body></html>\n`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'public'), { recursive: true });
for (const route of routes) {
  let body = route.path === '/changelog/' ? changelog : route.sections.map((name) => sections.get(name)).join('\n');
  if (route.path === '/') {
    body = body.replace(/Website: [\s\S]*?\n\n/, '');
    body += '\n## Get started\n\n' + routes.slice(1).map((r) => `- [${r.title}](${r.path})`).join('\n');
  } else if (route.path !== '/changelog/') {
    const first = markdown.lexer(body).find((t) => t.type === 'heading');
    if (first?.text === route.title) body = body.replace(/^## /, '# ');
    else body = `# ${route.title}\n\n${body}`;
  }
  const dir = join(out, 'public', route.path);
  mkdirSync(dir, { recursive: true });
  current = route.path;
  writeFileSync(join(dir, 'index.html'), page(route, markdown.parse(body)));
}
// Served for a miss at any depth; its links are right for a miss directly under the site root.
writeFileSync(join(out, 'public/404.html'), page({ title: 'Page not found' }, '<h1>Page not found</h1><p>Use the navigation above or <a href="./">return to the docs home page</a>.</p>'));
cpSync(join(docs, 'style.css'), join(out, 'public/style.css'));
const sourceHash = createHash('sha256');
for (const file of ['README.md', 'CHANGELOG.md', 'package.json', 'docs/build.mjs', 'docs/style.css', 'docs/package-lock.json']) sourceHash.update(file).update('\0').update(read(file)).update('\0');
writeFileSync(join(out, 'public/version.json'), JSON.stringify({ version, sourceHash: sourceHash.digest('hex'), revision: process.env.GITHUB_SHA ?? null }) + '\n');
console.log(`Built ${routes.length} documentation pages for ${version}`);
