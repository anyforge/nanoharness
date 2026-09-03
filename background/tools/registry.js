// background/tools/registry.js — 工具注册与调度
// 每个工具：{ name, description, parameters(JSON Schema), execute(args)->string|object }

const tools = new Map();

export function defineTool({ name, description, parameters, execute }) {
  tools.set(name, { name, description, parameters, execute });
}

/** 所有工具的 OpenAI 格式 schema。 */
export function listToolSchemas() {
  return [...tools.values()].map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

export function hasTool(name) {
  return tools.has(name);
}

/** 执行工具，返回字符串结果（给 LLM 的 tool 消息）。 */
export async function executeTool(name, args) {
  const t = tools.get(name);
  if (!t) return JSON.stringify({ error: 'unknown tool: ' + name });
  try {
    const result = await t.execute(args || {});
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
}

export function listToolNames() {
  return [...tools.keys()];
}
