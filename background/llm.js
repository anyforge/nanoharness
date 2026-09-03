// background/llm.js — LLM 调用 / Client: OpenAI-compatible + Anthropic protocols, streaming + temperature + timeout
// 说明 / Note: host_permissions <all_urls> lets fetch bypass CORS and call any LLM directly.

function trimEndSlash(s) { return String(s || '').replace(/\/+$/, ''); }

// 估算 token 数（服务商不返回 usage 字段时使用）：中文≈1 token/字，其余≈4 字符/token
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = s.length - cjk;
  return Math.max(1, Math.round(cjk + rest / 4));
}

// 拼接输入文本（估算 prompt tokens 用，CJK 感知）
export function promptText(messages) {
  return (messages || []).map((m) => {
    let s = String((m && m.content) || '');
    if (m && m.tool_calls) s += JSON.stringify(m.tool_calls);
    return s;
  }).join('');
}

// 组合用户 signal 与超时 signal
function combinedSignal(signal, timeoutMs) {
  const t = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
  if (!t) return signal;
  if (!signal) return t;
  return AbortSignal.any([signal, t]);
}

/** 统一入口：按 protocol 分派 */
export async function streamChat(p) {
  const protocol = String(p.protocol || 'openai').toLowerCase();
  if (protocol === 'anthropic') return streamAnthropic(p);
  return streamOpenAI(p);
}

/** 非流式（录制归纳等一次性调用），返回纯文本。 */
export async function chat(p) {
  const protocol = String(p.protocol || 'openai').toLowerCase();
  if (protocol === 'anthropic') return chatAnthropic(p);
  return chatOpenAI(p);
}

// ---- OpenAI 兼容 ----

async function streamOpenAI({ baseURL, apiKey, model, messages, tools, temperature, timeoutMs, signal, onText, onToolCall, onReasoning }) {
  const url = trimEndSlash(baseURL) + '/chat/completions';
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  if (tools && tools.length) body.tools = tools;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: combinedSignal(signal, timeoutMs),
    });
  } catch (e) {
    if (signal && signal.aborted) throw new Error('aborted');
    throw e;
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('LLM HTTP ' + resp.status + (txt ? ': ' + txt.slice(0, 300) : ''));
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const toolAcc = new Map(); // index -> { id, name, args }
  let content = '';
  let reasoning = '';
  const usage = { promptTokens: 0, completionTokens: 0 };

  const handleLine = (line) => {
    const l = line.trim();
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.usage) {
      usage.promptTokens = chunk.usage.prompt_tokens ?? usage.promptTokens;
      usage.completionTokens = chunk.usage.completion_tokens ?? usage.completionTokens;
    }
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (!delta) return;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      if (onReasoning) onReasoning(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      if (onText) onText(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        if (!toolAcc.has(idx)) toolAcc.set(idx, { id: '', name: '', args: '' });
        const acc = toolAcc.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function && tc.function.name) acc.name += tc.function.name;
        if (tc.function && tc.function.arguments) acc.args += tc.function.arguments;
        if (onToolCall) onToolCall([...toolAcc.values()]);
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) handleLine(line);
    }
    if (buf.trim()) handleLine(buf);
  } catch (e) {
    if (signal && signal.aborted) throw new Error('aborted');
    throw e;
  }

  const toolCalls = [...toolAcc.values()]
    .filter((t) => t.name)
    .map((t) => ({
      id: t.id || ('call_' + Math.random().toString(36).slice(2, 10)),
      type: 'function',
      function: { name: t.name, arguments: t.args || '{}' },
    }));

  const usageResult = (usage.promptTokens || usage.completionTokens)
    ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, estimated: false }
    : { promptTokens: estimateTokens(promptText(messages)), completionTokens: estimateTokens(content), estimated: true };
  return { content, toolCalls, reasoning, usage: usageResult };
}

async function chatOpenAI({ baseURL, apiKey, model, messages, temperature, timeoutMs, signal }) {
  const url = trimEndSlash(baseURL) + '/chat/completions';
  const body = { model, messages, stream: false };
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: combinedSignal(signal, timeoutMs),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('LLM HTTP ' + resp.status + (txt ? ': ' + txt.slice(0, 300) : ''));
  }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// ---- Anthropic ----

function anthropicUrl(baseURL) {
  const b = trimEndSlash(baseURL);
  if (/\/v1$/.test(b)) return b + '/messages';
  return b + '/v1/messages';
}

// OpenAI 格式消息 → Anthropic Messages 格式（system 提到顶层参数，tool 结果合并）
function convertToAnthropicMessages(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') continue; // system 单独提取到顶层
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseToolArgs(tc.function.arguments) });
        }
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      // 合并连续的 tool 结果到一个 user 消息
      const blocks = [];
      while (i < messages.length && messages[i].role === 'tool') {
        blocks.push({ type: 'tool_result', tool_use_id: messages[i].tool_call_id, content: messages[i].content });
        i++;
      }
      i--;
      out.push({ role: 'user', content: blocks });
    }
  }
  return out;
}

function anthropicClampTemp(t) {
  if (t === undefined || t === null) return t;
  return Math.max(0, Math.min(1, Number(t) || 0.7));
}

async function streamAnthropic({ baseURL, apiKey, model, messages, tools, temperature, timeoutMs, signal, onText, onToolCall, onReasoning }) {
  const url = anthropicUrl(baseURL);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const body = {
    model,
    messages: convertToAnthropicMessages(messages),
    max_tokens: 8192,
    stream: true,
  };
  if (system) body.system = system;
  if (temperature !== undefined && temperature !== null) body.temperature = anthropicClampTemp(temperature);
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: combinedSignal(signal, timeoutMs),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('LLM HTTP ' + resp.status + (txt ? ': ' + txt.slice(0, 300) : ''));
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolUses = []; // { index, id, name, input }
  const usage = { promptTokens: 0, completionTokens: 0 };

  const handleData = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'message_start') {
      const u = obj.message && obj.message.usage;
      if (u) usage.promptTokens = u.input_tokens || 0;
    } else if (obj.type === 'message_delta') {
      if (obj.usage && obj.usage.output_tokens) usage.completionTokens = obj.usage.output_tokens;
    }
    if (obj.type === 'content_block_start') {
      const block = obj.content_block;
      if (block && block.type === 'tool_use') {
        toolUses.push({ index: obj.index, id: block.id, name: block.name, input: '' });
      }
    } else if (obj.type === 'content_block_delta') {
      const d = obj.delta;
      if (!d) return;
      if (d.type === 'text_delta') {
        content += d.text;
        if (onText) onText(d.text);
      } else if (d.type === 'thinking_delta') {
        if (onReasoning) onReasoning(d.thinking || '');
      } else if (d.type === 'input_json_delta') {
        const tu = toolUses.find((t) => t.index === obj.index);
        if (tu) tu.input += d.partial_json;
      }
    }
  };

  const handleBuf = () => {
    const l = buf.trim();
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (!data) return;
    try { handleData(JSON.parse(data)); } catch {}
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const data = l.slice(5).trim();
      if (!data) continue;
      try { handleData(JSON.parse(data)); } catch {}
    }
  }
  if (buf.trim()) handleBuf();

  const toolCalls = toolUses.map((tu) => ({
    id: tu.id,
    type: 'function',
    function: { name: tu.name, arguments: tu.input || '{}' },
  }));

  const usageResult = (usage.promptTokens || usage.completionTokens)
    ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, estimated: false }
    : { promptTokens: estimateTokens(promptText(messages)), completionTokens: estimateTokens(content), estimated: true };
  return { content, toolCalls, usage: usageResult };
}

async function chatAnthropic({ baseURL, apiKey, model, messages, temperature, timeoutMs, signal }) {
  const url = anthropicUrl(baseURL);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const body = {
    model,
    messages: convertToAnthropicMessages(messages),
    max_tokens: 8192,
  };
  if (system) body.system = system;
  if (temperature !== undefined && temperature !== null) body.temperature = anthropicClampTemp(temperature);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: combinedSignal(signal, timeoutMs),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('LLM HTTP ' + resp.status + (txt ? ': ' + txt.slice(0, 300) : ''));
  }
  const data = await resp.json();
  const blocks = (data && data.content) || [];
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** 解析工具调用参数（容错：空串/非法 JSON 回退空对象）。 */
export function parseToolArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** 构造一个 tool 结果消息（OpenAI 格式）。 */
export function toolResultMessage(toolCallId, name, content) {
  return { role: 'tool', tool_call_id: toolCallId, name, content: String(content) };
}
