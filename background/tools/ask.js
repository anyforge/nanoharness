// background/tools/ask.js — ask_user 工具（agent 循环特殊处理：暂停并询问用户，不在此执行）
import { defineTool } from './registry.js';

defineTool({
  name: 'ask_user',
  description: '当任务需要用户澄清、确认、提供信息或授权时才调用。问题要具体、一次问清，避免无关打扰。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '单问题时的提问内容（中文，具体明确）' },
      options: { type: 'array', items: { type: 'string' }, description: '单问题：提供给用户的选项列表（用户可直接点击）' },
      multi_select: { type: 'boolean', description: '单问题：是否允许多选，默认 false' },
      questions: {
        type: 'array',
        description: '多问题时使用：一次问多个问题，每个含 question/options/multi_select',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '该问题的提问内容' },
            options: { type: 'array', items: { type: 'string' }, description: '该问题的选项列表' },
            multi_select: { type: 'boolean', description: '该问题是否多选' },
          },
          required: ['question'],
        },
      },
    },
    required: [],
  },
  // 占位：真正的询问由 agent 循环（runAgent 内 name === "ask_user" 分支）特殊处理，不会走到这里
  execute: async () => JSON.stringify({ error: 'ask_user 由 agent 循环特殊处理，不应直接执行' }),
});
