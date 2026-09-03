// background/expose.js — 把 NanoHarness 自身暴露为 MCP server（出站 WebSocket 连 relay）
// 纯扩展无法监听端口（stdio/HTTP server 都做不了），所以用「出站 WS 连 relay」：
// 外部 MCP client 连 relay，relay 把 JSON-RPC 请求通过 WS 转发给本模块处理，结果回传。
import { listToolSchemas, executeTool, listToolNames } from './tools/registry.js';
import { getConfig, getExposeEnabled } from '../shared/storage.js';

let ws = null;
let reconnectTimer = null;
let status = 'disabled'; // 'disabled' | 'connecting' | 'connected' | 'failed'

// 默认暴露的前缀（不含 mcp_*/ask_user/memory 等元工具，避免递归与安全风险）
const DEFAULT_PREFIX = ['browser_', 'fs_', 'list_skills', 'skill'];

function exposedNames(config) {
  const picked = (config.mcpServer && config.mcpServer.tools) || [];
  const all = listToolNames();
  if (picked.length) return all.filter((n) => picked.includes(n));
  return all.filter((n) => DEFAULT_PREFIX.some((p) => n.startsWith(p)));
}

function toolSchemas(config) {
  const names = new Set(exposedNames(config));
  return listToolSchemas()
    .filter((t) => names.has(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters || { type: 'object', properties: {} },
    }));
}

async function respond(socket, msg) {
  const { id, method, params } = msg || {};
  try {
    if (method === 'initialize') {
      socket.send(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'NanoHarness', version: '0.1.0' } },
      }));
      return;
    }
    if (method === 'tools/list') {
      const config = await getConfig();
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: toolSchemas(config) } }));
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const raw = await executeTool(name, args || {});
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }));
      return;
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } }));
  } catch (e) {
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message ? e.message : e) } }));
  }
}

function buildUrl(port, token) {
  let url = 'ws://localhost:' + port;
  if (token) url += '?token=' + encodeURIComponent(token);
  return url;
}

function connectExpose(port, token) {
  let socket;
  try { socket = new WebSocket(buildUrl(port, token)); }
  catch (e) { status = 'failed'; scheduleReconnect(); return; }
  status = 'connecting';
  socket.onopen = () => { ws = socket; status = 'connected'; };
  socket.onmessage = (ev) => { try { respond(socket, JSON.parse(ev.data)); } catch {} };
  socket.onerror = () => { status = 'failed'; };
  socket.onclose = () => { if (ws === socket) ws = null; status = 'failed'; scheduleReconnect(); };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; refreshExpose(); }, 5000);
}

// 启动 / 重启暴露连接（配置变化时调用）
export async function refreshExpose() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const enabled = await getExposeEnabled();
  const config = await getConfig();
  const mcp = config.mcpServer || {};
  if (!enabled || !mcp.port) { status = 'disabled'; return { ok: false, reason: '未启用' }; }
  connectExpose(mcp.port, mcp.token);
  return { ok: true, url: 'ws://localhost:' + mcp.port };
}

export function getExposeStatus() { return { status }; }

export function isExposed() { return !!ws; }
