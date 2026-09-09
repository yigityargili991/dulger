#!/usr/bin/env node
// Launcher for the TypeScript entry point.
//
// Node runs .ts files directly, but refuses to strip types for anything under node_modules,
// which is where an installed package lives. This hook strips the types of usta's own files
// (and only those) before Node sees them, so there is still no build step.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const srcRoot = new URL('../src/', import.meta.url).href;

// Node flags stripTypeScriptTypes as experimental on every call; that is noise for users of the CLI.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (rest[0] === 'ExperimentalWarning' && String(warning).includes('stripTypeScriptTypes')) return;
  return emitWarning.call(process, warning, ...rest);
};

registerHooks({
  load(url, context, next) {
    if (!url.startsWith(srcRoot) || !url.endsWith('.ts')) return next(url, context);
    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'strip' });
    return { format: 'module', source, shortCircuit: true };
  },
});

await import('../src/cli.ts');
