import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

// Manual check after building the deployed commit: npm run --prefix docs verify-deployment -- <site URL>
if (!process.argv[2]) throw new Error('Pass the site URL: npm run --prefix docs verify-deployment -- <site URL> (Settings > Pages shows it)');
const url = new URL('version.json', process.argv[2].replace(/\/?$/, '/'));
const expected = JSON.parse(readFileSync(new URL('dist/public/version.json', import.meta.url), 'utf8'));
let last = 'not available';
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${url}?check=${Date.now()}`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const actual = await response.json();
      // A local build has no revision; its source hash still identifies the inputs.
      if (actual.sourceHash === expected.sourceHash && (expected.revision === null || actual.revision === expected.revision)) {
        console.log(`Verified live docs for ${actual.version} (${actual.sourceHash.slice(0, 12)}, revision ${actual.revision})`);
        process.exit(0);
      }
      last = 'a different documentation build is live';
    } else last = `HTTP ${response.status}`;
  } catch (error) { last = error.message; }
  await setTimeout(5000);
}
throw new Error(`Docs deployment did not become healthy at ${url}: ${last}`);
