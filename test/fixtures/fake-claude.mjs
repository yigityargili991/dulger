// A stand-in for `claude -p --output-format stream-json` (DULGER_CLAUDE_BIN runs it through a shell
// wrapper): reads the prompt on stdin, answers in stream-json, and reports what it could do from where it
// runs. The prompt is JSON: { write?: string[], read?: string[], connect?: number, sleepMs?: number,
// transcript?: false }. Claude Code's transcript goes where the real one puts it.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const stdin = readFileSync(0, 'utf8');
const req = JSON.parse(stdin);
const argv = process.argv.slice(2);
const resumed = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : undefined;
const session = resumed ?? randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const attempt = (fn) => { try { const v = fn(); return typeof v === 'string' ? v : 'ok'; } catch (e) { return e.code ?? e.message; } };
const slug = (cwd) => {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
};

out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session });
const project = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', slug(process.cwd()));
const report = {
  stdin, cwd: process.cwd(), argv, tmpdir: process.env.TMPDIR,
  transcript: req.transcript === false ? 'skipped' : attempt(() => writeFileSync(join(project, `${session}.jsonl`), '{}\n', { flag: 'a' })),
  memory: attempt(() => { mkdirSync(join(project, 'memory'), { recursive: true }); writeFileSync(join(project, 'memory', 'MEMORY.md'), 'remember me\n'); }),
  temp: attempt(() => writeFileSync(join(process.env.TMPDIR ?? '/tmp', 'fake-claude.txt'), 'x')),
  writes: Object.fromEntries((req.write ?? []).map((p) => [p, attempt(() => writeFileSync(p, 'written by fake claude\n'))])),
  reads: Object.fromEntries((req.read ?? []).map((p) => [p, attempt(() => readFileSync(p, 'utf8'))])),
};
if (req.connect) {
  report.network = await new Promise((resolve) => {
    const s = connect(req.connect, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve('connected'); }).on('error', (e) => resolve(e.code ?? e.message));
  });
}
out({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'probing' }] }, session_id: session });
if (req.sleepMs) await new Promise((resolve) => setTimeout(resolve, req.sleepMs));
out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: JSON.stringify(report), structured_output: report, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 } });
