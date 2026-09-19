// JSON schemas for each role's final answer. Both harnesses accept these directly.
const strArray = { type: 'array', items: { type: 'string' } };

export const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    assumptions: { ...strArray, description: 'decisions you made where the goal was open: language, framework, scope, conflicts you resolved' },
    omitted: { ...strArray, description: 'parts of the goal you did not plan, each with the reason (empty when the board covers the whole goal)' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'short slug, e.g. c1, api-layer' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: strArray,
          dependsOn: { ...strArray, description: 'ids of cards that must be done first' },
          verify: { ...strArray, description: 'shell commands dulger runs in the card worktree before review, exit 0 = pass (build, tests, lint); non-interactive and finite; empty when nothing applies' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' }, instructions: { type: 'string' }, complexity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low: mechanical edits; medium: ordinary coding; high: complex reasoning, architecture or security' } },
              required: ['id', 'title', 'instructions', 'complexity'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'title', 'description', 'acceptanceCriteria', 'dependsOn', 'verify', 'tasks'],
        additionalProperties: false,
      },
    },
  },
  required: ['assumptions', 'omitted', 'cards'],
  additionalProperties: false,
} as const;

export const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: strArray,
    done: { type: 'boolean', description: 'false if work remains' },
    remaining: { ...strArray, description: 'what is left when done=false' },
    learnings: { ...strArray, description: 'facts about this codebase future agents should know' },
  },
  required: ['summary', 'filesChanged', 'done', 'remaining', 'learnings'],
  additionalProperties: false,
} as const;

export const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    feedback: { ...strArray, description: 'blocking problems, concrete and actionable (empty when pass=true)' },
    notes: { ...strArray, description: 'non-blocking observations worth recording (style, alternatives, pre-existing issues)' },
    summary: { type: 'string', description: 'what the card does and why it passes or fails, for humans reading the board' },
  },
  required: ['pass', 'feedback', 'notes', 'summary'],
  additionalProperties: false,
} as const;

export const DOCS_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, filesChanged: strArray },
  required: ['summary', 'filesChanged'],
  additionalProperties: false,
} as const;

export const REPORTER_SCHEMA = {
  type: 'object',
  properties: {
    note: { type: 'string', description: 'one short sentence for a human watching the board: what the agent is doing on the card right now and how far along it is' },
    attention: { type: 'string', description: 'only when something looks wrong (the agent is stuck, repeating itself, drifting off the card\'s scope); an empty string otherwise' },
  },
  required: ['note', 'attention'],
  additionalProperties: false,
} as const;
