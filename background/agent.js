// background/agent.js — agent 循环 / Agent loop: LLM call → tool dispatch → observe → next round
import { streamChat, chat, parseToolArgs, toolResultMessage, estimateTokens, promptText } from './llm.js';
import { listToolSchemas, executeTool } from './tools/registry.js';
import { getMemory, DEFAULT_PERSONA } from '../shared/storage.js';

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function clampFloat(v, def, min, max) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function buildSystem(config, memory) {
  const agent = config.agent || {};
  // 兼容旧结构（顶层 persona/maxIterations），persona 留空用内置默认
  const persona = String(agent.persona || config.persona || '').trim() || DEFAULT_PERSONA;

  const parts = [persona];

  // 能力概览：帮助模型理解可用工具与工作流（具体 schema 由 tools 参数提供）
  parts.push(
    'Your toolset:\n' +
    '- Browser: get_page (read page text/state), navigate, click, type, screenshot, open_tab, list_tabs, capture — operate the user\'s browser.\n' +
    '- Workspace: filesystem tools (list/mkdir/read/write/remove/search) over a private in-extension workspace.\n' +
    '- Skills: list_skills / skill (load a skill\'s full instructions by name before doing the task it covers).\n' +
    '- MCP: mcp_list_tools / mcp_call_tool (call remote MCP servers).\n' +
    '- Memory: memory_list / memory_add / memory_remove (durable cross-session facts) and search_sessions (find past conversations).\n' +
    '- Ask user: ask_user (pause to ask the user; provide options[] for selectable choices and multi_select for multi-choice when suitable).'
  );

  const skills = config.skills || [];
  if (skills.length) {
    const list = skills.map((s) => '- ' + s.name + ': ' + (s.description || '(无描述)')).join('\n');
    parts.push('Available skills (load full content with the `skill` tool by name):\n' + list);
  }

  const mem = memory || [];
  const userFacts = mem.filter((m) => m.kind === 'user');
  const notes = mem.filter((m) => m.kind !== 'user');
  if (userFacts.length) {
    parts.push('About the user (who they are — name, preferences, style, accounts; trust these across sessions):\n' +
      userFacts.map((m, i) => (i + 1) + '. ' + m.content).join('\n'));
  }
  if (notes.length) {
    parts.push('Environment notes (conventions, tool quirks, lessons — trust these across sessions):\n' +
      notes.map((m, i) => (i + 1) + '. ' + m.content).join('\n'));
  }

  return { role: 'system', content: parts.join('\n\n') };
}

/**
 * 跑一轮 agent 循环。
 * @param {object} p
 * @param {object} p.config   配置（含 llm / agent{persona,maxIterations} / skills）
 * @param {Array}  p.messages 干净对话（user/assistant 纯文本，不含中间 tool 消息）
 * @param {(ev:object)=>void} p.onEvent
 * @param {(args:object)=>Promise<string>} p.onAskUser 询问用户（返回用户回复）
 * @param {AbortSignal} p.signal
 */
export async function runAgent({ config, messages, onEvent, onAskUser, signal }) {
  const agent = config.agent || {};
  const maxIter = clampInt(agent.maxIterations ?? config.maxIterations, 90, 1, 100);
  const comp = agent.compression || {};
  const compEnabled = comp.enabled !== false; // 默认启用
  const contextLength = clampInt(comp.contextLength, 128000, 4000, 2000000);
  const compThreshold = clampFloat(comp.threshold, 0.5, 0.1, 0.9);
  const compTarget = clampFloat(comp.targetRatio, 0.2, 0.05, 0.8);
  const tools = listToolSchemas();
  const memory = await getMemory();
  let convo = [buildSystem(config, memory), ...messages];

  for (let iter = 0; iter < maxIter; iter++) {
    if (signal && signal.aborted) throw new Error('aborted');

    // 上下文预算检查：超过阈值自动压缩，防长对话撑爆 context
    if (compEnabled && estimateTokens(promptText(convo)) >= contextLength * compThreshold) {
      onEvent({ type: 'compacting' });
      convo = await compactConversation(convo, config, contextLength, compTarget);
    }

    let finalContent = '';
    const { content, toolCalls, usage } = await streamChat({
      protocol: config.llm.protocol,
      baseURL: config.llm.baseURL,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
      messages: convo,
      tools: tools.length ? tools : undefined,
      signal,
      onText: (delta) => { finalContent += delta; onEvent({ type: 'delta', text: delta }); },
      onReasoning: (delta) => onEvent({ type: 'reasoning-delta', text: delta }),
    });

    // 记录本轮 token 用量（含模型显示名称，用于看板按模型区分）
    if (usage && (usage.promptTokens || usage.completionTokens)) {
      onEvent({
        type: 'usage',
        model: config.llm.model,
        displayName: config.llm.displayName || config.llm.model,
        baseURL: config.llm.baseURL,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        estimated: !!usage.estimated,
      });
    }

    // 无工具调用 → 本轮结束
    if (!toolCalls.length) {
      onEvent({ type: 'done', content: finalContent || content });
      return { content: finalContent || content };
    }

    // 中间轮：本轮流式文本（若有）是「关键回复」，标记结束，交由 UI 收进时间线
    onEvent({ type: 'interim-text-end' });

    // 追加 assistant（含 tool_calls）
    convo.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

    // 逐个执行工具
    for (const tc of toolCalls) {
      const name = tc.function.name;
      const args = parseToolArgs(tc.function.arguments);
      // ask_user：暂停循环询问用户，等用户回复后作为工具结果继续
      if (name === 'ask_user') {
        const question = (args && (args.question || args.prompt)) || '';
        onEvent({ type: 'tool-start', name: 'ask_user', args }); // 在时间线里也显示
        onEvent({ type: 'ask-user', question, args });
        let answer = '';
        try { answer = onAskUser ? (await onAskUser(args)) || '' : ''; } catch (e) { answer = ''; }
        onEvent({ type: 'tool-end', name: 'ask_user', result: answer || '（未回复）' });
        onEvent({ type: 'ask-user-answered', answer });
        convo.push(toolResultMessage(tc.id, name, answer || '（用户未回复）'));
        continue;
      }
      onEvent({ type: 'tool-start', name, args });
      let result;
      try {
        result = await executeTool(name, args);
      } catch (e) {
        result = JSON.stringify({ error: String(e && e.message ? e.message : e) });
      }
      onEvent({ type: 'tool-end', name, result });
      convo.push(toolResultMessage(tc.id, name, result));
    }
    // 循环回到下一轮 LLM 调用
  }

  onEvent({ type: 'max-iterations', maxIter });
  return { content: '', stopped: 'max-iterations' };
}

// ---- 上下文压缩 ----

// 找保留段起点：保留最近 keep 条消息；若起点恰好是 tool 消息，往前补到它的 assistant（tool 必须跟在 assistant 的 tool_calls 之后）
function findKeepStart(rest, keep) {
  let start = Math.max(0, rest.length - keep);
  while (start > 0 && rest[start].role === 'tool') start--;
  return start;
}

// 把历史消息压成结构化快照，只保留 system + 快照 + 最近几条消息
async function compactConversation(convo, config, contextLength, targetRatio) {
  const KEEP = 4; // 保留最近约 4 条消息，保证连贯
  const system = convo[0];
  const rest = convo.slice(1);
  if (rest.length <= KEEP + 2) return convo; // 太少不值得压（<=6 条）

  const keepStart = findKeepStart(rest, KEEP);
  const toCompress = rest.slice(0, keepStart);
  if (toCompress.length < 4) return convo; // 可压内容太少（<4 条）

  const recent = rest.slice(keepStart);

  const summary = await summarizeForCompression(toCompress, config, contextLength, targetRatio);
  if (!summary) return convo; // 压缩失败则原样返回，宁可不压也不丢信息

  return [system, { role: 'user', content: summary }, ...recent];
}

// 调 LLM 把历史对话压成结构化快照（非流式一次性调用，不带工具）
async function summarizeForCompression(history, config, contextLength, targetRatio) {
  const text = history.map((m) => {
    if (m.role === 'user') return '用户：' + String(m.content || '');
    if (m.role === 'assistant') {
      let s = '助手：' + String(m.content || '');
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        s += ' [调用了工具：' + m.tool_calls.map((tc) => tc.function.name).join('、') + ']';
      }
      return s;
    }
    if (m.role === 'tool') return '[工具结果 ' + (m.name || '') + ']：' + String(m.content || '').slice(0, 400);
    return String(m.content || '');
  }).join('\n');

  const maxChars = Math.max(2000, Math.round(contextLength * (targetRatio || 0.2) * 1.5));

  const sys = '你是对话压缩器。把下面的历史对话压成一份结构化快照，作为后续对话的背景记忆。要求：\n' +
    '1. 忠实保留：目标、已完成的关键动作与结果、关键决策、错误与修复、当前状态（文件/变量/进行到哪一步）、待办。\n' +
    '2. 宁多勿漏，但不复述无关闲聊。\n' +
    '3. 用中文，纯文本，按「目标 / 已完成 / 关键决策 / 错误与修复 / 当前状态 / 待办」分行。\n' +
    '4. 控制在 ' + maxChars + ' 字符以内。';

  try {
    const out = await chat({
      protocol: config.llm.protocol,
      baseURL: config.llm.baseURL,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      temperature: 0,
      timeoutMs: Math.max(config.llm.timeoutMs || 60000, 180000),
      messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
    });
    return '[以下是之前对话的压缩摘要，供你继续任务时参考]\n' + String(out || '').trim();
  } catch (e) {
    return '';
  }
}
