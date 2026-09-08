// JSON schemas for each role's final answer. Both harnesses accept these directly.
const strArray = { type: 'array', items: { type: 'string' } };

export const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
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
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' }, instructions: { type: 'string' } },
              required: ['id', 'title', 'instructions'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'title', 'description', 'acceptanceCriteria', 'dependsOn', 'tasks'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
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
    feedback: { ...strArray, description: 'concrete, actionable problems (empty when pass=true)' },
    summary: { type: 'string' },
  },
  required: ['pass', 'feedback', 'summary'],
  additionalProperties: false,
} as const;

export const DOCS_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, filesChanged: strArray },
  required: ['summary', 'filesChanged'],
  additionalProperties: false,
} as const;
