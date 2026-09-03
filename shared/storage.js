// shared/storage.js — 配置 / 会话 / 记忆 存取 / Config + sessions + memory storage (chrome.storage.local)
// 说明 / Note: API key, skills, MCP config, memory all live in local storage (not synced, no sync quota).

// 默认智能体 persona —— 内置行为准则，让 agent "足够智慧"。
// 用户在设置页留空时使用这份内置默认（也可在智能体 tab 选择其它预设）。
export const DEFAULT_PERSONA = `You are NanoHarness — an autonomous AI agent that runs entirely inside a Chrome browser extension. You can read and operate the user's browser, manage a workspace, load skills, call MCP tools, and remember durable facts across sessions. You are self-improving: you learn the user's preferences into memory and distill reusable procedures into skills, so you get better at the user's specific tasks over time.

Operating principles — follow these always:

1. ACT, don't narrate. When a tool can accomplish the task, call it now. Never end a turn with a promise of future action; every response either takes action or delivers a finished result.
2. FINISH THE JOB. A deliverable is a working, verified artifact, not a description of one. Keep going until the task is actually complete and you have checked the outcome.
3. BE HONEST. Never fabricate results, data, or responses. If something fails or is blocked, say so plainly and try another way — reporting a blocker honestly beats inventing an answer.
4. USE TOOLS, SAFELY. Prefer real actions over recollection: look things up, read the page, click, navigate. Before a state-changing action confirm scope; never type secrets or click permission/payment dialogs the user did not ask for.
5. REMEMBER PROACTIVELY. The moment you learn a durable fact about the user — a preference, a correction, an account, a convention — save it with memory_add (kind: "user" for facts about WHO they are; kind: "note" for environment details, conventions, and lessons). Never make the user repeat themselves; check memory before assuming.
6. EVOLVE INTO SKILLS. After you finish a non-trivial, reusable procedure, save it as a skill with skill_save (a kebab-case name, a one-line description, and self-contained steps + pitfalls). If a skill you used was wrong, outdated, or missing a step, fix it immediately with skill_patch. Skills accumulate so you never redo the same hard work twice.
7. ASK, DON'T GUESS — but only when it matters. When a task needs a real decision or trade-off, pause with ask_user: give selectable options[] (put your recommendation first) and ask several independent questions at once. For low-stakes choices, pick a sensible default and act.
8. MATCH THE USER. Reply in the language the user writes in. Be direct, concise, and genuinely useful over verbose. For complex tasks think step by step; for simple ones act in a single decisive step.`;

export const DEFAULT_CONFIG = {
  llm: {
    protocol: 'openai',   // 'openai'（OpenAI 兼容，默认） | 'anthropic'
    baseURL: '',
    apiKey: '',
    model: '',
    displayName: '',     // 模型显示名称（看板/展示用，默认与 model 同名，可自定义区分不同 baseURL）
    temperature: 0.7,
    timeoutMs: 60000,     // 单次请求超时（毫秒）
  },
  agent: {
    persona: '',          // 留空 = 使用内置 DEFAULT_PERSONA
    maxIterations: 90,
    compression: {        // 上下文压缩：长对话自动摘要，防撑爆 context（默认参照 Hermes）
      enabled: true,      // 是否启用自动压缩
      contextLength: 128000, // 模型上下文窗口（token）
      threshold: 0.5,     // 占用超过此比例即触发压缩（Hermes 默认 0.50）
      targetRatio: 0.2,   // 压缩后目标占用比例（Hermes 默认 0.20）
    },
    summarizeTimeoutMs: 600000, // 录制归纳超时（毫秒，默认 10 分钟），智能体配置页可调
  },
  skills: [],      // [{ id, name, description, content }]
  mcpServers: [],  // [{ id, name, transport, url, headers }]
  mcpServer: {     // 把 NanoHarness 自身作为 MCP server 暴露（出站 WS 连 relay，纯扩展不能监听端口）
    enabled: false,   // 启用态存 session storage（浏览器关闭即复位为关）
    port: 8787,       // relay 端口（HTTP + WS 共用，本机）
    token: '',        // 鉴权 token（可选）
    tools: [],        // 要暴露的工具名列表；空 = 默认暴露 browser_*/fs_*/list_skills/skill
  },
};

export const MAX_MEMORY_CHARS = 8000; // 记忆总量上限

const KEYS = {
  config: 'nh_config',
  sessions: 'nh_sessions',
  memory: 'nh_memory',
  tokenUsage: 'nh_token_usage',
};

function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (base && typeof base === 'object' && patch && typeof patch === 'object') {
    const out = { ...base };
    for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
    return out;
  }
  return patch;
}

function now() { return Date.now(); }

// ---- 配置 ----

export async function getConfig() {
  try {
    const { [KEYS.config]: c } = await chrome.storage.local.get(KEYS.config);
    const merged = deepMerge(DEFAULT_CONFIG, c || {});
    // 兼容旧结构：把顶层 persona/maxIterations 迁移到 agent 子对象
    if (!merged.agent || merged.agent.persona === undefined) {
      merged.agent = merged.agent || {};
      if (merged.persona !== undefined && merged.agent.persona === undefined) merged.agent.persona = merged.persona;
      if (merged.maxIterations !== undefined && merged.agent.maxIterations === undefined) merged.agent.maxIterations = merged.maxIterations;
    }
    // 兼容旧 llm（没有 protocol/temperature/timeoutMs 字段时补齐默认）
    if (merged.llm && merged.llm.protocol === undefined) merged.llm.protocol = 'openai';
    if (merged.llm && merged.llm.temperature === undefined) merged.llm.temperature = 0.7;
    if (merged.llm && merged.llm.timeoutMs === undefined) merged.llm.timeoutMs = 60000;
    return merged;
  } catch (e) {
    return deepMerge({}, DEFAULT_CONFIG);
  }
}

export async function setConfig(patch) {
  const cur = await getConfig();
  const next = deepMerge(cur, patch);
  await chrome.storage.local.set({ [KEYS.config]: next });
  return next;
}

// ---- MCP 暴露开关（session 态：浏览器关闭即复位，默认不启动）----
const EXPOSE_ENABLED_KEY = 'nh_expose_enabled';

export async function getExposeEnabled() {
  try {
    const { [EXPOSE_ENABLED_KEY]: v } = await chrome.storage.session.get(EXPOSE_ENABLED_KEY);
    return !!v;
  } catch (e) { return false; }
}

export async function setExposeEnabled(enabled) {
  try {
    await chrome.storage.session.set({ [EXPOSE_ENABLED_KEY]: !!enabled });
  } catch (e) {}
  return !!enabled;
}

// ---- 会话 ----

export async function getSessions() {
  try {
    const { [KEYS.sessions]: s } = await chrome.storage.local.get(KEYS.sessions);
    return Array.isArray(s) ? s : [];
  } catch (e) {
    return [];
  }
}

export async function saveSession(session) {
  const list = await getSessions();
  const idx = list.findIndex((s) => s.id === session.id);
  if (idx >= 0) list[idx] = session;
  else list.unshift(session);
  await chrome.storage.local.set({ [KEYS.sessions]: list });
  return list;
}

export async function deleteSession(id) {
  const list = (await getSessions()).filter((s) => s.id !== id);
  await chrome.storage.local.set({ [KEYS.sessions]: list });
  return list;
}

export async function getSession(id) {
  const list = await getSessions();
  return list.find((s) => s.id === id) || null;
}

export function newSessionId() {
  return 's-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// 检索历史会话（按关键词匹配消息内容）
export async function searchSessions(query, limit = 5) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const sessions = await getSessions();
  const hits = [];
  for (const s of sessions) {
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    for (const m of msgs) {
      const text = String(m.content || '').toLowerCase();
      const idx = text.indexOf(q);
      if (idx >= 0) {
        hits.push({
          sessionId: s.id,
          title: s.title || '(未命名)',
          updatedAt: s.updatedAt || s.createdAt,
          snippet: text.slice(Math.max(0, idx - 40), idx + 120),
          role: m.role,
        });
        break;
      }
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

// ---- 记忆 ----

export async function getMemory() {
  try {
    const { [KEYS.memory]: m } = await chrome.storage.local.get(KEYS.memory);
    return Array.isArray(m) ? m : [];
  } catch (e) {
    return [];
  }
}

export async function addMemory(content, kind) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: '空记忆' };
  const k = kind === 'user' ? 'user' : 'note'; // 默认 note（环境/约定/坑）；user = 用户是谁
  const list = await getMemory();
  const total = list.reduce((n, m) => n + String(m.content).length, 0) + text.length;
  if (total > MAX_MEMORY_CHARS) return { ok: false, error: '记忆已满（' + MAX_MEMORY_CHARS + ' 字符），请先清理' };
  list.push({ id: 'm-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), content: text, kind: k, createdAt: now() });
  await chrome.storage.local.set({ [KEYS.memory]: list });
  return { ok: true, memory: list };
}

export async function removeMemory(id) {
  const list = (await getMemory()).filter((m) => m.id !== id);
  await chrome.storage.local.set({ [KEYS.memory]: list });
  return { ok: true, memory: list };
}

export async function clearMemory() {
  await chrome.storage.local.set({ [KEYS.memory]: [] });
  return { ok: true, memory: [] };
}

// ---- token 用量 ----

export const MAX_TOKEN_RECORDS = 5000; // 最多保留最近 5000 条用量记录，防止无限膨胀

export async function getTokenUsage() {
  try {
    const { [KEYS.tokenUsage]: u } = await chrome.storage.local.get(KEYS.tokenUsage);
    return Array.isArray(u) ? u : [];
  } catch (e) {
    return [];
  }
}

// 追加一条 token 用量记录
export async function recordUsage(entry) {
  if (!entry) return;
  const list = await getTokenUsage();
  list.push({ id: 't-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), ...entry, ts: entry.ts || now() });
  if (list.length > MAX_TOKEN_RECORDS) list.splice(0, list.length - MAX_TOKEN_RECORDS);
  await chrome.storage.local.set({ [KEYS.tokenUsage]: list });
  return list;
}

export async function clearTokenUsage() {
  await chrome.storage.local.set({ [KEYS.tokenUsage]: [] });
  return [];
}

// ---- 技能（程序性记忆：agent 可自我沉淀可复用流程）----

// 创建或覆盖一个技能（按 name 匹配，存在则覆盖内容）
export async function saveSkill({ name, description, content }) {
  const n = String(name || '').trim();
  const d = String(description || '').trim();
  const body = String(content || '').trim();
  if (!n || !body) return { ok: false, error: '技能名与正文不能为空' };
  const cfg = await getConfig();
  const skills = (cfg.skills || []).slice();
  const idx = skills.findIndex((s) => s.name === n || s.id === n);
  if (idx >= 0) {
    skills[idx] = { ...skills[idx], name: n, description: d || skills[idx].description, content: body };
    await setConfig({ skills });
    return { ok: true, skill: skills[idx], updated: true };
  }
  const skill = { id: 'sk-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), name: n, description: d, content: body };
  skills.push(skill);
  await setConfig({ skills });
  return { ok: true, skill, updated: false };
}

// 局部修改技能正文：传 old_string 做替换；否则把 new_string 追加到正文末尾
export async function patchSkill(name, { old_string, new_string }) {
  const cfg = await getConfig();
  const skills = (cfg.skills || []).slice();
  const idx = skills.findIndex((s) => s.name === name || s.id === name);
  if (idx < 0) return { ok: false, error: '未找到技能：' + name };
  const cur = String(skills[idx].content || '');
  let next;
  if (old_string) {
    if (!cur.includes(old_string)) return { ok: false, error: '未在技能正文中找到要替换的文本' };
    next = cur.replace(old_string, String(new_string || ''));
  } else {
    next = (cur + '\n\n' + String(new_string || '').trim()).trim();
  }
  skills[idx] = { ...skills[idx], content: next };
  await setConfig({ skills });
  return { ok: true, skill: skills[idx] };
}
