import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const expected = JSON.parse(readFileSync(new URL('dist/public/version.json', import.meta.url), 'utf8'));
const base = 'https://dulger-site-production.up.railway.app';
let last = 'not available';
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${base}/version.json?check=${Date.now()}`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const actual = await response.json();
      if (actual.sourceHash === expected.sourceHash && actual.revision === expected.revision) {
        console.log(`Verified live docs for ${actual.version} (${actual.sourceHash.slice(0, 12)})`);
        process.exit(0);
      }
      last = 'previous documentation build is still live';
    } else last = `HTTP ${response.status}`;
  } catch (error) { last = error.message; }
  await setTimeout(5000);
}
throw new Error(`Docs deployment did not become healthy: ${last}`);
