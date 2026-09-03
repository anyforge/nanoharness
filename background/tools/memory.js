// background/tools/memory.js — 记忆工具 / Memory tools + session search
import { defineTool } from './registry.js';
import { addMemory, removeMemory, getMemory, searchSessions } from '../../shared/storage.js';

defineTool({
  name: 'memory_add',
  description: 'Save a durable fact to long-term memory so you never ask the user twice. Save PROACTIVELY the moment you learn a preference, correction, account, or convention — do not wait to be told. kind: "user" for facts about WHO the user is (name, preferences, style, accounts); "note" for environment details, conventions, and lessons.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'the fact to remember (concise, declarative)' },
      kind: { type: 'string', enum: ['user', 'note'], description: 'user = about who the user is; note = environment/convention/lesson. Default note.' },
    },
    required: ['content'],
  },
  execute: async ({ content, kind }) => {
    return await addMemory(content, kind);
  },
});

defineTool({
  name: 'memory_list',
  description: 'List all saved memories.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    return { memory: await getMemory() };
  },
});

defineTool({
  name: 'memory_remove',
  description: 'Remove a memory by its id.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  execute: async ({ id }) => {
    return await removeMemory(id);
  },
});

defineTool({
  name: 'search_sessions',
  description: 'Search past conversation history (all sessions) for a keyword, returns matching sessions with snippets.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => {
    const hits = await searchSessions(query);
    return { query, count: hits.length, hits };
  },
});
