// background/background.js — MV3 service worker 入口 / Entry
// 职责 / Duties: register tools, talk to side panel (port keep-alive), manage sessions, dispatch run/cancel.
import { getConfig, setConfig, getSessions, saveSession, deleteSession, getSession, newSessionId, recordUsage, getTokenUsage, clearTokenUsage, getExposeEnabled, setExposeEnabled } from '../shared/storage.js';
import { runAgent } from './agent.js';
import './tools/browser.js';   // 注册浏览器工具
import './tools/skill.js';     // 注册技能工具
import './tools/filesystem.js'; // 注册工作区文件系统工具
import { testMcpServer } from './tools/mcp.js'; // 注册 MCP 工具 + 测试连接函数
import './tools/memory.js';    // 注册记忆工具
import './tools/ask.js';       // 注册 ask_user 工具
import { startRecording, stopRecording, isRecording, saveRecording, cancelRecording } from './recorder.js'; // 操作录制
import { refreshExpose, getExposeStatus } from './expose.js'; // 把 NanoHarness 自身暴露为 MCP server
import { listToolNames } from './tools/registry.js'; // 供设置页列出可暴露的工具

refreshExpose(); // 启动时按配置连接 relay

let panelPort = null;
let activeAbort = null;
let askResolver = null; // 等待中的 ask_user 回复
let pendingAsk = null;  // { sessionId, question, args } 当前挂起的提问（供回到会话时恢复）

// 点击工具栏图标 → 打开侧栏（MV3 sidePanel 默认点击图标不会自动打开）
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

// sidePanel 连接保活（有活跃 port 的 SW 不会被挂起）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'nanoharness-panel') return;
  panelPort = port;
  port.onDisconnect.addListener(() => { if (panelPort === port) panelPort = null; });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e && e.message ? e.message : e) }));
  return true; // 异步
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'get-config': {
      const config = await getConfig();
      if (config.mcpServer) config.mcpServer.enabled = await getExposeEnabled();
      return { config };
    }
    case 'set-config': {
      const patch = msg.patch || {};
      // MCP 暴露开关（enabled）存 session storage，浏览器关闭即复位；其余配置持久化
      if (patch.mcpServer && 'enabled' in patch.mcpServer) {
        await setExposeEnabled(patch.mcpServer.enabled);
        const rest = { ...patch.mcpServer };
        delete rest.enabled;
        if (Object.keys(rest).length) await setConfig({ mcpServer: rest });
      } else {
        await setConfig(patch);
      }
      if (patch.mcpServer) refreshExpose();
      return { config: await getConfig() };
    }
    case 'get-sessions': return { sessions: await getSessions() };
    case 'get-session': return { session: await getSession(msg.id) };
    case 'delete-session': abortIfPendingAsk(msg.id); return { sessions: await deleteSession(msg.id) };
    case 'run': return run(msg);
    case 'regenerate': return regenerate(msg);
    case 'clear-session': return clearSession(msg.id);
    case 'cancel': return cancel();
    case 'record-toggle': return toggleRecord();
    case 'record-save': return saveRecordByName(msg.name);
    case 'record-cancel': return cancelRecord();
    case 'ask-user-reply': return answerAskUser(msg.answer);
    case 'get-pending-ask': return { pending: pendingAsk };
    case 'get-token-usage': return { usage: await getTokenUsage() };
    case 'clear-token-usage': return { usage: await clearTokenUsage() };
    case 'mcp-test': return testMcpServer(msg.server);
    case 'list-tools': return { tools: listToolNames() };
    case 'get-expose-status': return getExposeStatus();
    default: return { error: 'unknown message: ' + msg.type };
  }
}

async function run(msg) {
  const config = await getConfig();
  if (!config.llm.baseURL || !config.llm.apiKey || !config.llm.model) {
    return { ok: false, error: '请先在设置页配置大模型（baseURL / apiKey / model）' };
  }

  const sessionId = msg.sessionId || newSessionId();
  let session = (await getSession(sessionId)) || {
    id: sessionId, title: '', messages: [], createdAt: Date.now(), updatedAt: Date.now(),
  };

  // 追加用户消息
  const userText = String(msg.text || '');
  session.messages.push({ role: 'user', content: userText });
  if (!session.title && userText) session.title = userText.slice(0, 40);

  const controller = new AbortController();
  activeAbort = controller;
  dispatchAgent({ session, config, controller, sessionId });
  return { ok: true, sessionId };
}

async function regenerate(msg) {
  const config = await getConfig();
  if (!config.llm.baseURL || !config.llm.apiKey || !config.llm.model) {
    return { ok: false, error: '请先在设置页配置大模型（baseURL / apiKey / model）' };
  }
  const session = await getSession(msg.sessionId);
  if (!session || !session.messages.length) return { ok: false, error: '没有可重新生成的消息' };
  // 删除末尾的 assistant 消息，用最后一条 user 消息重新生成
  while (session.messages.length && session.messages[session.messages.length - 1].role === 'assistant') {
    session.messages.pop();
  }
  if (!session.messages.length || session.messages[session.messages.length - 1].role !== 'user') {
    return { ok: false, error: '没有可重新生成的消息' };
  }
  await saveSession(session);
  const controller = new AbortController();
  activeAbort = controller;
  dispatchAgent({ session, config, controller, sessionId: msg.sessionId });
  return { ok: true, sessionId: msg.sessionId };
}

function dispatchAgent({ session, config, controller, sessionId }) {
  const emit = (event) => {
    if (panelPort) {
      try { panelPort.postMessage({ type: 'agent-event', sessionId, event }); } catch {}
    }
  };

  // 异步跑 agent（不阻塞 onMessage 返回）
  (async () => {
    let finalContent = '';
    try {
      await runAgent({
        config,
        messages: session.messages, // 干净对话（agent 内部自己加 system + 临时 tool 消息）
        signal: controller.signal,
        onAskUser: (args) => new Promise((resolve) => {
          // 打断时唤醒等待中的提问，避免 agent 卡死在 await onAskUser
          const onAbort = () => { askResolver = null; pendingAsk = null; resolve(''); };
          controller.signal.addEventListener('abort', onAbort, { once: true });
          pendingAsk = { sessionId, question: (args && (args.question || args.prompt)) || '', args };
          askResolver = (ans) => { controller.signal.removeEventListener('abort', onAbort); askResolver = null; pendingAsk = null; resolve(ans); };
        }),
        onEvent: (ev) => {
          if (ev.type === 'delta') finalContent += ev.text;
          if (ev.type === 'done') finalContent = ev.content || finalContent;
          if (ev.type === 'usage') recordUsage(ev).catch(() => {}); // 落库 token 用量
          emit(ev);
        },
      });
      if (finalContent) session.messages.push({ role: 'assistant', content: finalContent });
      session.updatedAt = Date.now();
      await saveSession(session);
      emit({ type: 'turn-end', sessionId });
    } catch (e) {
      session.updatedAt = Date.now();
      await saveSession(session);
      if (String(e && e.message) === 'aborted') emit({ type: 'aborted', sessionId });
      else emit({ type: 'error', sessionId, error: String(e && e.message ? e.message : e) });
      emit({ type: 'turn-end', sessionId }); // 异常路径也复位前端 running / 发送按钮状态
    } finally {
      if (activeAbort === controller) activeAbort = null;
    }
  })();
}

async function clearSession(id) {
  abortIfPendingAsk(id); // 清空会话 = 放弃该会话未完成的提问
  const session = await getSession(id);
  if (!session) return { ok: false, error: '会话不存在' };
  session.messages = [];
  session.updatedAt = Date.now();
  await saveSession(session);
  return { ok: true, sessions: await getSessions() };
}

function cancel() {
  if (activeAbort) { activeAbort.abort(); return { ok: true }; }
  return { ok: false, error: '没有正在运行的任务' };
}

// 若挂起的 ask_user 提问属于指定会话，则取消对应的 agent（避免清空/删除后 agent 卡死在等回复）
function abortIfPendingAsk(id) {
  if (activeAbort && pendingAsk && pendingAsk.sessionId === id) {
    activeAbort.abort();
    activeAbort = null;
  }
}

async function toggleRecord() {
  if (isRecording()) {
    const r = await stopRecording();
    if (panelPort) { try { panelPort.postMessage({ type: 'record-result', ...r }); } catch {} }
    return { ok: r.ok, recording: false, count: r.count };
  }
  return await startRecording();
}

async function saveRecordByName(name) {
  const r = await saveRecording(name, (chars) => {
    if (panelPort) { try { panelPort.postMessage({ type: 'record-progress', chars }); } catch {} }
  });
  if (r.ok && panelPort) { try { panelPort.postMessage({ type: 'record-saved', skill: r.skill }); } catch {} }
  return r;
}

function cancelRecord() {
  cancelRecording();
  return { ok: true };
}

function answerAskUser(answer) {
  if (askResolver) {
    const resolve = askResolver;
    askResolver = null;
    resolve(String(answer ?? ''));
    return { ok: true };
  }
  return { ok: false, error: '没有等待中的提问' };
}
