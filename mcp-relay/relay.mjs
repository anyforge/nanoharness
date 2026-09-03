#!/usr/bin/env node
// mcp-relay/relay.mjs — NanoHarness MCP relay
// 桥接「外部 MCP client」与「NanoHarness 扩展（WebSocket client）」。
//
// 支持两种 client 入口（共用同一端口）：
//   - stdio：MCP client 通过 stdin/stdout 跑本脚本（本机，Claude Desktop 的 command 方式）。
//   - HTTP（Streamable HTTP）：MCP client 用 POST http://host:PORT/mcp 远程连接。
//
// 拓扑：
//   外部 MCP client --(stdio 或 HTTP POST /mcp)--> relay --(WebSocket)--> NanoHarness 扩展 --> 执行工具
//
// 用法：
//   npm install
//   node relay.mjs [--port 8787] [--token xxx]
//   （HTTP 与 WS 共用同一端口；可选 RELAY_TOKEN 环境变量或 --token）
//
// 鉴权：
//   - 设置 token 后，HTTP 需带 `Authorization: Bearer <token>` 头（或 URL ?token=<token>）；
//   - 扩展连 WS 需带 ?token=<token>。
import { WebSocketServer } from 'ws';
import http from 'http';
import readline from 'readline';

// ---- 参数解析：--port N / --port=N / env RELAY_WS_PORT（默认 8787）；--token X / env RELAY_TOKEN ----
function parseArgs() {
  const argv = process.argv;
  const pick = (name) => {
    const eqIdx = argv.findIndex((x) => x.startsWith(name + '='));
    if (eqIdx >= 0) return argv[eqIdx].split('=')[1];
    const idx = argv.indexOf(name);
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
    return null;
  };
  const port = parseInt(pick('--port'), 10);
  const WS_PORT = Number.isNaN(port) ? parseInt(process.env.RELAY_WS_PORT || '8787', 10) : port;
  const token = pick('--token') || process.env.RELAY_TOKEN || '';
  return { WS_PORT, TOKEN: token };
}
const { WS_PORT, TOKEN } = parseArgs();

let nanoSocket = null;
const pending = new Map(); // id -> resolve（等待 NanoHarness 响应）

// ---- 处理一条 MCP 消息，返回 JSON-RPC 响应对象（通知返回 null）----
function processMcp(msg) {
  const { id, method } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'NanoHarness', version: '0.1.0' } } };
  }
  if (method && method.startsWith('notifications/')) return null; // 通知无需响应
  if (!nanoSocket) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'NanoHarness 未连接：请先开启扩展「MCP 暴露」并把 Relay 地址设为 ws://localhost:' + WS_PORT } };
  }
  return new Promise((resolve) => {
    pending.set(id, (resp) => resolve(resp));
    nanoSocket.send(JSON.stringify(msg));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ jsonrpc: '2.0', id, error: { code: -32603, message: '等待 NanoHarness 响应超时' } }); }
    }, 120000);
  });
}

// ---- stdio 入口 ----
function respondStdio(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  (async () => {
    if (Array.isArray(msg)) {
      for (const m of msg) { const r = await processMcp(m); if (r) respondStdio(r); }
    } else {
      const r = await processMcp(msg); if (r) respondStdio(r);
    }
  })();
});

// ---- HTTP 入口（Streamable HTTP）----
function authOk(req) {
  if (!TOKEN) return true;
  const auth = (req.headers['authorization'] || '');
  if (auth === 'Bearer ' + TOKEN) return true;
  try { if (new URL(req.url || '/', 'http://x').searchParams.get('token') === TOKEN) return true; } catch {}
  return false;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function handleHttp(req, res) {
  const url = (req.url || '').split('?')[0];
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
    });
    res.end();
    return;
  }
  // 健康检查
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    sendJson(res, 200, { ok: true, service: 'NanoHarness MCP relay', nanoConnected: !!nanoSocket });
    return;
  }
  // MCP Streamable HTTP：POST /mcp（或 /）
  if (req.method === 'POST' && (url === '/mcp' || url === '/')) {
    if (!authOk(req)) { sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized: invalid or missing Bearer token' } }); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 10 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: invalid JSON' } }); return; }
      try {
        let result;
        if (Array.isArray(msg)) {
          const out = [];
          for (const m of msg) { const r = await processMcp(m); if (r) out.push(r); }
          result = out;
        } else {
          result = await processMcp(msg);
        }
        if (result === null || (Array.isArray(result) && result.length === 0)) { res.writeHead(202); res.end(); return; }
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e && e.message ? e.message : e) } });
      }
    });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

// ---- WS server（扩展连进来）attach 到同一 http server ----
const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server });
wss.on('connection', (socket, req) => {
  let token = '';
  try { token = new URL(req.url || '/', 'http://x').searchParams.get('token') || ''; } catch {}
  if (TOKEN && token !== TOKEN) {
    socket.close(); console.error('[relay] 拒绝连接：token 不匹配'); return;
  }
  nanoSocket = socket;
  console.error('[relay] NanoHarness 已连接');
  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    } catch {}
  });
  socket.on('close', () => { if (nanoSocket === socket) nanoSocket = null; console.error('[relay] NanoHarness 断开'); });
});

server.listen(WS_PORT, () => {
  console.error('[relay] MCP relay 已启动：WS ws://localhost:' + WS_PORT + ' · HTTP http://localhost:' + WS_PORT + '/mcp · 等待 NanoHarness 连接…');
});
