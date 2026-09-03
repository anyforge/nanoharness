// background/tools/skill.js — 技能工具（加载 chrome.storage 里存的技能正文）
import { defineTool } from './registry.js';
import { getConfig, saveSkill, patchSkill } from '../../shared/storage.js';

defineTool({
  name: 'skill',
  description: 'Load a skill by name and return its full content (steps, selectors, instructions). Use this when you need the detailed procedure of a skill.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'skill name' } },
    required: ['name'],
  },
  execute: async ({ name }) => {
    const config = await getConfig();
    const skill = (config.skills || []).find((s) => s.name === name || s.id === name);
    if (!skill) return JSON.stringify({ error: '未找到技能：' + name });
    return skill.content || '(该技能内容为空)';
  },
});

defineTool({
  name: 'list_skills',
  description: 'List all available skills (id + name + description).',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const config = await getConfig();
    return (config.skills || []).map((s) => ({ id: s.id, name: s.name, description: s.description || '' }));
  },
});

defineTool({
  name: 'skill_save',
  description: 'Save a reusable procedure as a skill (create or overwrite by name). Use this after finishing a non-trivial, reusable task so you never redo the same hard work. Content should be self-contained: when to use it, numbered steps, and pitfalls.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'kebab-case skill name, e.g. check-express' },
      description: { type: 'string', description: 'one-line description of what the skill does' },
      content: { type: 'string', description: 'self-contained skill body: when to use it, numbered steps, and pitfalls' },
    },
    required: ['name', 'description', 'content'],
  },
  execute: async ({ name, description, content }) => {
    return await saveSkill({ name, description, content });
  },
});

defineTool({
  name: 'skill_patch',
  description: 'Fix or extend an existing skill. If a skill you used was wrong, outdated, or missing a step, patch it immediately. Provide old_string to replace specific text; otherwise new_string is appended to the skill body.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'skill name (or id) to patch' },
      old_string: { type: 'string', description: 'optional: exact text to find and replace in the skill body' },
      new_string: { type: 'string', description: 'replacement text (with old_string) or text to append (without old_string)' },
    },
    required: ['name', 'new_string'],
  },
  execute: async ({ name, old_string, new_string }) => {
    return await patchSkill(name, { old_string, new_string });
  },
});
