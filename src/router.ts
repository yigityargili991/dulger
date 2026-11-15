// Jev, TypeSafe's calibrated scoring model, can tag each task's difficulty in place of the planner (routing.router).
// OpenRouter, TypeSafe's API and a local llama-server speak the same protocol: POST {baseUrl}/v1/systemone.
import { JEV_ENDPOINTS, type JevEndpoint, type RoutingConfig } from './config.ts';
import { readKey } from './keys.ts';
import type { Card, ModelTier } from './types.ts';

const TIERS: ModelTier[] = ['low', 'medium', 'high'];
// The planner prompt's definitions of low, medium and high (src/roles/prompts.ts), one level each.
const LEVELS = [
  'Mechanical edits, simple documentation or renames',
  'Routine features, fixes and tests',
  'Architecture, security, concurrency or difficult debugging',
];

/** Where Jev's questions go, or undefined when routing is off or the planner tags difficulty itself. */
export function jevEndpoint(routing: RoutingConfig): JevEndpoint | undefined {
  if (!routing.enabled || routing.router === 'planner') return undefined;
  return { ...JEV_ENDPOINTS[routing.router], ...routing.jev };
}

/** Set every task's complexity from Jev's scores, one request per card. Throws, changing no task, when any card gets no answer. */
export async function routeTasks(endpoint: JevEndpoint, goal: string, cards: Card[], signal: AbortSignal): Promise<void> {
  const scores = await Promise.all(cards.map((card) => scoreTasks(endpoint, goal, card, signal)));
  cards.forEach((card, i) => card.tasks.forEach((task, j) => { task.complexity = TIERS[Math.min(2, Math.max(0, Math.round(scores[i]![j]!)))]; }));
}

async function scoreTasks(endpoint: JevEndpoint, goal: string, card: Card, signal: AbortSignal): Promise<number[]> {
  const url = new URL(endpoint.baseUrl.replace(/\/+$/, '') + '/v1/systemone');
  const key = endpoint.apiKeyEnv ? readKey(endpoint.apiKeyEnv) : undefined;
  const state = { goal, card: { title: card.title, description: card.description, acceptanceCriteria: card.acceptanceCriteria, tasks: card.tasks.map((t) => ({ title: t.title, instructions: t.instructions })) } };
  // Question ids never reach the model, so each question names its task by its path in the state.
  const questions = Object.fromEntries(card.tasks.map((t, i) => [t.id, { type: 'score', instructions: `How difficult is the work \`card.tasks[${i}]\` asks for?`, criteria: LEVELS }]));
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: endpoint.model, state, questions }),
    // A minute, so a socket-activated local server can load its model on the first question.
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  }).catch((err: Error) => { throw new Error(`no answer from ${url.host} (${(err.cause as Error | undefined)?.message ?? err.message})`); });
  const body = await response.json().catch(() => ({})) as Reply;
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.host}${detail(body) ? `: ${detail(body)}` : ''}`);
  return card.tasks.map((t) => {
    const score = body.answers?.[t.id]?.score;
    if (typeof score !== 'number') throw new Error(`${url.host} sent no score for ${card.id}/${t.id}`);
    return score;
  });
}

interface Reply { answers?: Record<string, { score?: unknown }>; detail?: unknown; error?: { message?: unknown } }

/** The server's explanation: a string or object (400), validation errors (422), or OpenRouter's own error. */
function detail(body: Reply): string {
  const d = body.detail ?? body.error?.message;
  if (Array.isArray(d)) return d.map((e: { loc?: unknown[]; msg?: unknown }) => `${e.loc?.join('.')}: ${e.msg}`).join('; ');
  return typeof d === 'string' ? d : d ? JSON.stringify(d) : '';
}
