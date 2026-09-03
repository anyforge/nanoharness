// background/tools/mcp.js — MCP 客户端（streamable HTTP / SSE transport）
// 说明：纯扩展无法 spawn 本地进程，故只支持远程 HTTP MCP server（不能用 stdio transport）。
// 用两个「元工具」让 agent 发现并调用任意 MCP 工具：mcp_list_tools / mcp_call_tool。
import { defineTool } from './registry.js';
import { getConfig } from '../../shared/storage.js';

async function mcpRequest(server, method, params) {
  const resp = await fetch(server.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(server.headers || {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!resp.ok) throw new Error('MCP HTTP ' + resp.status);
  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  if (ct.includes('text/event-stream') || text.trim().startsWith('event:') || text.includes('data:')) {
    // SSE：拼所有 data 行，取最后的 JSON
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    const payload = datas.length ? datas[datas.length - 1] : '';
    try {
      const parsed = JSON.parse(payload);
      if (parsed.error) throw new Error(parsed.error.message || 'MCP error');
      return parsed.result ?? parsed;
    } catch (e) {
      if (e instanceof SyntaxError) return { raw: payload };
      throw e;
    }
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error.message || 'MCP error');
  return data.result;
}

async function listServerTools(server) {
  await mcpRequest(server, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'NanoHarness', version: '0.1.0' },
  });
  const result = await mcpRequest(server, 'tools/list', {});
  return (result && result.tools) || [];
}

defineTool({
  name: 'mcp_list_tools',
  description: 'List all tools from all configured MCP servers (name + description + input schema).',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const config = await getConfig();
    const servers = config.mcpServers || [];
    const out = [];
    for (const server of servers) {
      try {
        const tools = await listServerTools(server);
        out.push({
          server: server.name,
          tools: tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} })),
        });
      } catch (e) {
        out.push({ server: server.name, error: String(e && e.message ? e.message : e) });
      }
    }
    return out;
  },
});

defineTool({
  name: 'mcp_call_tool',
  description: 'Call a tool on a configured MCP server by server name and tool name.',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name (as configured)' },
      tool: { type: 'string', description: 'tool name' },
      arguments: { type: 'object', description: 'tool arguments (JSON object)' },
    },
    required: ['server', 'tool'],
  },
  execute: async ({ server, tool, arguments: args }) => {
    const config = await getConfig();
    const s = (config.mcpServers || []).find((x) => x.name === server || x.id === server);
    if (!s) return JSON.stringify({ error: '未找到 MCP server：' + server });
    try {
      const result = await mcpRequest(s, 'tools/call', { name: tool, arguments: args || {} });
      return JSON.stringify(result);
    } catch (e) {
      return JSON.stringify({ error: String(e && e.message ? e.message : e) });
    }
  },
});

// 测试一个 MCP server 的连通性（initialize + tools/list），供设置页「测试连接」按钮调用
export async function testMcpServer(server) {
  try {
    const tools = await listServerTools(server);
    return { ok: true, count: Array.isArray(tools) ? tools.length : 0 };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
