// Smoke-test the real app on a repository:
//   node test/fixtures/app-demo.ts <repo path>
// It uses the fake harness, so nothing calls a model. `dulger --harness fake` in the repository opens
// the same app through the CLI (with its flags seeding the session).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runApp } from '../../src/app/index.ts';
import * as git from '../../src/git/worktree.ts';

const target = resolve(process.argv[2] ?? process.cwd());
const repoRoot = git.repoRoot(target);
const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
await runApp(repoRoot, { overrides: { harness: 'fake' }, yes: false, quiet: false, allowDirty: false }, version);
