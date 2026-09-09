// A scripted adapter for tests and demos: no tokens, deterministic, fast.
// Responses are looked up by role marker in the system prompt (dulger puts `[role:<name>]` there).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AgentRole, CheckResult, DocsResult, PlannerResult, WorkerResult } from '../types.ts';
import type { Adapter, AdapterRunOptions, AdapterResult } from './types.ts';

export type FakeScript = {
  planner?: PlannerResult | ((opts: AdapterRunOptions, callIndex: number) => PlannerResult);
  /** Called per worker run; may write files into cwd to exercise the git path. */
  worker?: (opts: AdapterRunOptions, callIndex: number) => WorkerResult;
  checker?: (opts: AdapterRunOptions, callIndex: number) => CheckResult;
  docs?: (opts: AdapterRunOptions, callIndex: number) => DocsResult;
  delayMs?: number;
};

export function roleFromSystemPrompt(systemPrompt: string): AgentRole | undefined {
  const m = systemPrompt.match(/\[role:(planner|worker|checker|docs)\]/);
  return m?.[1] as AgentRole | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_FAKE_SCRIPT: FakeScript = {
  delayMs: 400,
  planner: {
    cards: [
      { id: 'c1', title: 'Create greeting module', description: 'Add greet.js exporting greet(name).', acceptanceCriteria: ['greet("x") returns "Hello, x!"'], dependsOn: [],
        tasks: [{ id: 't1', title: 'write module', instructions: 'Create greet.js' }] },
      { id: 'c2', title: 'Add farewell module', description: 'Add bye.js exporting bye(name).', acceptanceCriteria: ['bye("x") returns "Bye, x!"'], dependsOn: [],
        tasks: [{ id: 't1', title: 'write module', instructions: 'Create bye.js' }, { id: 't2', title: 'add test', instructions: 'Create bye.test.js' }] },
      { id: 'c3', title: 'Wire CLI', description: 'cli.js prints greet + bye.', acceptanceCriteria: ['node cli.js x prints both lines'], dependsOn: ['c1', 'c2'],
        tasks: [{ id: 't1', title: 'write cli', instructions: 'Create cli.js' }] },
    ],
  },
  worker(opts, i) {
    // Write a file named after the task so each card's worktree gets a distinct change.
    const m = opts.prompt.match(/Task id: (\S+)\s+Card id: (\S+)/);
    const name = m ? `${m[2]}-${m[1]}.txt` : `worker-${i}.txt`;
    const file = join(opts.cwd, 'out', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `written by fake worker call ${i}\n`);
    return { summary: `Wrote ${name}`, filesChanged: [`out/${name}`], done: true, remaining: [], learnings: i === 0 ? ['Fake learning: outputs live in out/'] : [] };
  },
  checker(_opts, i) {
    // Fail the very first check to exercise the retry path.
    return i === 0 ? { pass: false, feedback: ['Fake checker: please retry once'], notes: ['Fake note: consider a helper'], summary: 'first check fails' } : { pass: true, feedback: [], notes: [], summary: 'looks good' };
  },
  docs(opts) {
    writeFileSync(join(opts.cwd, 'DOCS.md'), '# Docs\n\nWritten by the fake docs agent.\n');
    return { summary: 'Wrote DOCS.md', filesChanged: ['DOCS.md'] };
  },
};

export function createFakeAdapter(script: FakeScript = DEFAULT_FAKE_SCRIPT): Adapter {
  const counters: Record<string, number> = {};
  return {
    name: 'fake',
    async run(opts): Promise<AdapterResult> {
      const role = roleFromSystemPrompt(opts.systemPrompt) ?? 'worker';
      const i = counters[role] ?? 0;
      counters[role] = i + 1;
      const delay = script.delayMs ?? 0;
      const sessionId = `fake-${role}-${i}`;
      opts.onEvent({ type: 'init', sessionId });
      opts.onEvent({ type: 'text', text: `fake ${role} thinking…` });
      opts.onEvent({ type: 'turn' });
      await sleep(delay);
      opts.onEvent({ type: 'tool', name: role === 'worker' ? 'Edit' : 'Read', input: {} });
      await sleep(delay);
      opts.onEvent({ type: 'tool_result' });
      opts.onEvent({ type: 'turn' });
      if (opts.signal.aborted) return { ok: false, text: '', exitCode: 130, error: 'aborted' };

      let output: unknown;
      if (role === 'planner') { const p = script.planner ?? DEFAULT_FAKE_SCRIPT.planner!; output = typeof p === 'function' ? p(opts, i) : p; }
      else if (role === 'worker') output = (script.worker ?? DEFAULT_FAKE_SCRIPT.worker!)(opts, i);
      else if (role === 'checker') output = (script.checker ?? DEFAULT_FAKE_SCRIPT.checker!)(opts, i);
      else output = (script.docs ?? DEFAULT_FAKE_SCRIPT.docs!)(opts, i);

      const text = JSON.stringify(output);
      const usage = { input: 200, cacheRead: 700, cacheWrite: 50, output: 50 };
      const rateLimits = { at: new Date().toISOString(), status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.35 }, { name: 'seven_day', utilization: 0.23 }] };
      opts.onEvent({ type: 'rate_limit', limits: rateLimits });
      opts.onEvent({ type: 'result', output, text, costUsd: 0.01, usage });
      return { ok: true, output, text, sessionId, costUsd: 0.01, usage, rateLimits, exitCode: 0 };
    },
  };
}
