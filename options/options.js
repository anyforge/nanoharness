// options/options.js — 配置页 / Settings: model (protocol/temperature/timeout + presets), agent (+presets), skills CRUD, MCP — multi-tab
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }

// ---- 大模型常用配置预设（protocol: openai | anthropic） ----
const LLM_PRESETS = [
  { name: 'DeepSeek', protocol: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'DeepSeek Reasoner', protocol: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' },
  { name: 'OpenAI', protocol: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'Anthropic Claude', protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { name: 'Moonshot (Kimi)', protocol: 'openai', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: 'GLM (智谱)', protocol: 'openai', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { name: 'Qwen (通义)', protocol: 'openai', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'MiniMax', protocol: 'openai', baseURL: 'https://api.minimaxi.com/v1', model: 'abab6.5s-chat' },
  { name: 'SiliconFlow', protocol: 'openai', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { name: 'OpenRouter', protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: '' },
];

// ---- 智能体常用配置预设（persona 留空 = 内置默认） ----
const AGENT_PRESETS = [
  { nameKey: 'opts.presetGeneral', descKey: 'opts.presetGeneralDesc', persona: '', maxIterations: 90 },
  {
    nameKey: 'opts.presetBrowser', descKey: 'opts.presetBrowserDesc', maxIterations: 90,
    persona: 'You are a browser automation specialist. Operate the user\'s web browser: navigate, read page content, click, fill forms, take screenshots, and extract information. Prefer the browser tools for everything; act decisively and report what you actually did with concrete results (URLs, text you read, screenshots). Never guess page content — always read it first.',
  },
  {
    nameKey: 'opts.presetCoding', descKey: 'opts.presetCodingDesc', maxIterations: 90,
    persona: 'You are a coding assistant. Help write, debug, and review code. Think about correctness, edge cases, and clarity before answering. Prefer real, runnable code over pseudocode, explain your reasoning concisely, and verify what you can by actually running or reading it.',
  },
  {
    nameKey: 'opts.presetResearch', descKey: 'opts.presetResearchDesc', maxIterations: 60,
    persona: 'You are a research assistant. Gather information from multiple pages, cross-check facts, and produce well-organized, cited summaries. Distinguish verified facts from inference, and be explicit about sources and uncertainty.',
  },
  {
    nameKey: 'opts.presetMinimal', descKey: 'opts.presetMinimalDesc', maxIterations: 30,
    persona: 'You are a concise assistant. Answer directly and briefly, using tools only when necessary. Skip preamble and elaboration unless asked.',
  },
];

let skillsDraft = [];
let mcpDraft = [];
let currentProtocol = 'openai';
let lastModel = ''; // 跟踪模型输入框的「上一个值」，用于判断显示名称是否还在默认跟随状态
let exposeEnabled = false; // MCP 暴露开关

(async () => {
  await loadLang();
  await loadTheme();
  applyI18n();
  bindLangToggles();
  syncUI();
  const r = await chrome.runtime.sendMessage({ type: 'get-config' });
  const c = (r && r.config) || {};
  const llm = c.llm || {};
  const agent = c.agent || {};
  currentProtocol = llm.protocol || 'openai';
  $('llm-baseurl').value = llm.baseURL || '';
  $('llm-apikey').value = llm.apiKey || '';
  $('llm-model').value = llm.model || '';
  $('llm-displayname').value = llm.displayName || llm.model || '';
  lastModel = llm.model || '';
  $('llm-temperature').value = (llm.temperature !== undefined && llm.temperature !== null) ? llm.temperature : 0.7;
  $('llm-timeout').value = Math.round((llm.timeoutMs || 60000) / 1000);
  $('persona').value = agent.persona || c.persona || '';
  $('max-iter').value = (agent.maxIterations ?? c.maxIterations) || 90;
  applyCompressionUI(agent.compression || {});
  $('summarize-timeout').value = Math.round((agent.summarizeTimeoutMs || 600000) / 1000);
  skillsDraft = (c.skills || []).map((s) => ({ ...s }));
  mcpDraft = (c.mcpServers || []).map((m) => ({ ...m, headers: (m.headers && typeof m.headers === 'object') ? JSON.stringify(m.headers) : (m.headers || '') }));
  renderProtocol();
  renderLlmPresets();
  renderAgentPresets();
  renderSkills();
  renderMcp();
  loadExposeConfig(c);
  bindEvents();
  renderTokenDashboard();
})();

// ---- tab 切换 ----
function syncUI() {
  document.querySelectorAll('[data-lang-toggle]').forEach((el) => {
    el.classList.toggle('active', el.dataset.langToggle === LANG);
  });
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  document.querySelectorAll('#theme-seg [data-theme-btn]').forEach((el) => {
    el.classList.toggle('active', el.dataset.themeBtn === cur);
  });
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $('panel-' + tab.dataset.tab).classList.add('active');
    };
  });
}

// ---- 协议选择 ----
function renderProtocol() {
  $('protocol-seg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.protocol === currentProtocol);
  });
}

function setProtocol(p) {
  currentProtocol = p;
  renderProtocol();
}

// ---- 大模型预设 ----
function renderLlmPresets() {
  const box = $('llm-presets');
  box.innerHTML = LLM_PRESETS.map((p, i) =>
    `<button class="preset" data-index="${i}">${esc(p.name)}<span class="preset-desc">${esc(p.model || '任意')}</span></button>`
  ).join('') + `<button class="preset" data-custom="1">${t('opts.presetCustom')}<span class="preset-desc">${t('opts.presetCustomDesc')}</span></button>`;
  box.onclick = (e) => {
    const btn = e.target.closest('.preset');
    if (!btn) return;
    box.querySelectorAll('.preset').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.custom) {
      // 自定义：清空 baseURL / 模型 / 显示名称，让用户自己填
      $('llm-baseurl').value = '';
      $('llm-model').value = '';
      $('llm-displayname').value = '';
      lastModel = '';
      return;
    }
    const p = LLM_PRESETS[parseInt(btn.dataset.index, 10)];
    setProtocol(p.protocol);
    $('llm-baseurl').value = p.baseURL;
    $('llm-model').value = p.model;
    $('llm-displayname').value = p.model;
    lastModel = p.model;
  };
}

// ---- 智能体预设 ----
function renderAgentPresets() {
  const box = $('agent-presets');
  box.innerHTML = AGENT_PRESETS.map((p, i) =>
    `<button class="preset" data-index="${i}">${t(p.nameKey)}<span class="preset-desc">${t(p.descKey)}</span></button>`
  ).join('');
  box.onclick = (e) => {
    const btn = e.target.closest('.preset');
    if (!btn) return;
    const p = AGENT_PRESETS[parseInt(btn.dataset.index, 10)];
    $('persona').value = p.persona;
    $('max-iter').value = p.maxIterations;
    box.querySelectorAll('.preset').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
  };
}

// ---- 技能 / MCP ----
function renderSkills() {
  const list = $('skills-list');
  if (!skillsDraft.length) { list.innerHTML = '<p class="desc">' + t('opts.empty') + '</p>'; return; }
  list.innerHTML = skillsDraft.map((s, i) => `
    <div class="mini-card" data-index="${i}">
      <div class="mini-title">${esc(s.name || t('opts.unnamed'))}</div>
      <div class="mini-desc" title="${esc(s.description || '')}">${esc(s.description || t('opts.noDesc'))}</div>
      <div class="mini-actions">
        <button data-action="view" title="${t('opts.skillView')}">👁</button>
        <button data-action="edit" title="${t('opts.edit')}">✎</button>
        <button data-action="del" title="${t('opts.del')}">✕</button>
      </div>
    </div>
  `).join('');
}

function renderMcp() {
  const list = $('mcp-list');
  if (!mcpDraft.length) { list.innerHTML = '<p class="desc">' + t('opts.empty') + '</p>'; return; }
  list.innerHTML = mcpDraft.map((m, i) => `
    <div class="mini-card" data-index="${i}">
      <div class="mini-title">${esc(m.name || t('opts.unnamed'))}</div>
      <div class="mini-desc" title="${esc(m.url || '')}">${esc(m.url || t('opts.noUrl'))}</div>
      <div class="mini-actions">
        <button data-action="test" title="${t('opts.mcpTest')}">🔌</button>
        <button data-action="edit" title="${t('opts.edit')}">✎</button>
        <button data-action="del" title="${t('opts.del')}">✕</button>
      </div>
    </div>
  `).join('');
}

// ---- 通用弹窗 / 技能 MCP 编辑 / 查看 / 测试 / 导入 / 上传 ----

let modalOnOk = null;

function showModal({ title, body, onOk, hideOk }) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = body;
  modalOnOk = onOk || null;
  $('modal-ok').style.display = hideOk ? 'none' : '';
  $('modal-cancel').textContent = hideOk ? t('opts.close') : t('opts.cancel');
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  modalOnOk = null;
}

function editSkill(i) {
  const isNew = i < 0;
  const s = isNew ? { id: uid('sk'), name: '', description: '', content: '' } : skillsDraft[i];
  showModal({
    title: isNew ? t('opts.newSkill') : t('opts.editSkill'),
    body: `
      <label class="field field-col"><span>${t('opts.skillName')}</span><input id="m-name" value="${esc(s.name)}" spellcheck="false"></label>
      <label class="field field-col"><span>${t('opts.skillDesc')}</span><input id="m-desc" value="${esc(s.description)}" spellcheck="false"></label>
      <label class="field field-col"><span>${t('opts.skillContent')}</span><textarea id="m-content" rows="8" spellcheck="false">${esc(s.content)}</textarea></label>
    `,
    onOk: () => {
      s.name = $('m-name').value.trim();
      s.description = $('m-desc').value.trim();
      s.content = $('m-content').value;
      if (isNew && s.name) skillsDraft.push(s); // 新建：仅保存非空才加入，取消不留空卡片
      renderSkills();
    },
  });
}

function viewSkill(i) {
  const s = skillsDraft[i];
  showModal({
    title: s.name || t('opts.unnamed'),
    body: `<div class="skill-view"><pre>${esc(s.content || t('opts.empty'))}</pre></div>`,
    hideOk: true,
  });
}

function editMcp(i) {
  const isNew = i < 0;
  const m = isNew ? { id: uid('mcp'), name: '', transport: 'http', url: '', headers: '' } : mcpDraft[i];
  showModal({
    title: isNew ? t('opts.newMcp') : t('opts.editMcp'),
    body: `
      <label class="field field-col"><span>${t('opts.mcpName')}</span><input id="m-name" value="${esc(m.name)}" spellcheck="false"></label>
      <label class="field field-col"><span>${t('opts.mcpUrl')}</span><input id="m-url" value="${esc(m.url)}" spellcheck="false"></label>
      <label class="field field-col"><span>${t('opts.mcpHeaders')}</span><textarea id="m-headers" rows="3" spellcheck="false">${esc(m.headers)}</textarea></label>
    `,
    onOk: () => {
      m.name = $('m-name').value.trim();
      m.url = $('m-url').value.trim();
      m.headers = $('m-headers').value;
      if (isNew && m.name) mcpDraft.push(m); // 新建：仅保存非空才加入
      renderMcp();
    },
  });
}

async function testMcp(i) {
  const m = mcpDraft[i];
  if (!(m.url || '').trim()) { showToast(t('opts.mcpNeedUrl'), 'err'); return; }
  showToast(t('opts.mcpTesting') + '…');
  const r = await chrome.runtime.sendMessage({ type: 'mcp-test', server: { name: m.name, url: m.url, headers: parseMcpHeaders(m.headers) } });
  if (r && r.ok) showToast(t('opts.mcpTestOk').replace('{n}', r.count), 'ok');
  else showToast(t('opts.mcpTestFail') + ': ' + ((r && r.error) || ''), 'err');
}

function parseMcpHeaders(headers) {
  const hs = (headers || '').trim();
  if (!hs) return {};
  try { return JSON.parse(hs); } catch { return {}; }
}

function importMcpJson() {
  showModal({
    title: t('opts.importMcpJson'),
    body: `<label class="field field-col"><span>${t('opts.mcpJsonPh')}</span><textarea id="m-json" rows="10" spellcheck="false" placeholder='{"mcpServers": {"name": {"url": "https://..."}}}'></textarea></label>`,
    onOk: () => {
      let obj;
      try { obj = JSON.parse($('m-json').value); } catch (e) { showToast(t('opts.mcpJsonInvalid'), 'err'); return; }
      const servers = (obj && obj.mcpServers) ? obj.mcpServers : obj;
      let imported = 0, skipped = 0;
      for (const [name, cfg] of Object.entries(servers || {})) {
        if (cfg && typeof cfg === 'object' && cfg.url) {
          mcpDraft.push({ id: uid('mcp'), name, transport: 'http', url: cfg.url, headers: cfg.headers ? JSON.stringify(cfg.headers) : '' });
          imported++;
        } else if (cfg && typeof cfg === 'object' && (cfg.command || cfg.args)) {
          skipped++; // stdio 纯扩展不支持
        }
      }
      renderMcp();
      showToast(t('opts.mcpImportDone').replace('{n}', imported) + (skipped ? ' · ' + t('opts.mcpImportSkipped').replace('{n}', skipped) : ''), 'ok');
    },
  });
}

async function uploadSkillFolder(fileList) {
  const files = [...fileList];
  let mdFile = files.find((f) => f.name.toLowerCase() === 'skill.md');
  if (!mdFile) mdFile = files.find((f) => f.name.toLowerCase().endsWith('.md'));
  if (!mdFile) { showToast(t('opts.uploadNoMd'), 'err'); return; }
  const content = await mdFile.text();
  const folderName = (mdFile.webkitRelativePath || '').split('/')[0] || '';
  const parsed = parseSkillMd(content);
  skillsDraft.push({
    id: uid('sk'),
    name: parsed.name || folderName || mdFile.name.replace(/\.md$/i, ''),
    description: parsed.description || '',
    content: parsed.content || content,
  });
  renderSkills();
  showToast(t('opts.uploadSkillOk'), 'ok');
}

// 解析 SKILL.md 的 YAML frontmatter（name / description）
function parseSkillMd(content) {
  const s = String(content || '');
  const m = s.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { name: '', description: '', content: s };
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || '';
  const description = (fm.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || '';
  return { name, description, content: s.slice(m[0].length) };
}

function showToast(text, kind) {
  const st = $('status');
  if (!st) return;
  st.textContent = text;
  st.className = 'status ' + (kind || 'ok');
  clearTimeout(st._t);
  st._t = setTimeout(() => { st.textContent = ''; st.className = 'status'; }, 2800);
}

// ---- 分 tab 保存：采集 / 落库 / 取消重载 ----
function collectLlm() {
  const temp = parseFloat($('llm-temperature').value);
  const timeoutSec = parseInt($('llm-timeout').value, 10);
  return {
    protocol: currentProtocol,
    baseURL: $('llm-baseurl').value.trim(),
    apiKey: $('llm-apikey').value.trim(),
    model: $('llm-model').value.trim(),
    displayName: $('llm-displayname').value.trim() || $('llm-model').value.trim(),
    temperature: Number.isNaN(temp) ? 0.7 : Math.max(0, Math.min(2, temp)),
    timeoutMs: (Number.isNaN(timeoutSec) ? 60 : Math.max(5, Math.min(600, timeoutSec))) * 1000,
  };
}

function collectAgent() {
  const activeBtn = document.querySelector('#comp-enabled-seg .active');
  const compEnabled = activeBtn ? activeBtn.dataset.compEnabled === '1' : true;
  return {
    persona: $('persona').value.trim(),
    maxIterations: Math.max(1, Math.min(100, parseInt($('max-iter').value, 10) || 90)),
    compression: {
      enabled: compEnabled,
      contextLength: Math.max(4000, Math.min(2000000, parseInt($('comp-context').value, 10) || 128000)),
      threshold: Math.max(0.1, Math.min(0.9, parseFloat($('comp-threshold').value) || 0.5)),
      targetRatio: Math.max(0.05, Math.min(0.8, parseFloat($('comp-target').value) || 0.2)),
    },
    summarizeTimeoutMs: Math.max(60, Math.min(3600, parseInt($('summarize-timeout').value, 10) || 600)) * 1000,
  };
}

// 把压缩配置渲染到 UI（loadConfig / reloadConfig 共用）
function applyCompressionUI(comp) {
  $('comp-enabled-seg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b.dataset.compEnabled === '1') === (comp.enabled !== false));
  });
  $('comp-context').value = comp.contextLength ?? 128000;
  $('comp-threshold').value = comp.threshold ?? 0.5;
  $('comp-target').value = comp.targetRatio ?? 0.2;
}

function collectSkills() {
  return skillsDraft
    .filter((s) => (s.name || '').trim())
    .map((s) => ({ id: s.id || uid('sk'), name: s.name.trim(), description: (s.description || '').trim(), content: (s.content || '').trim() }));
}

function collectMcp() {
  return mcpDraft
    .filter((m) => (m.name || '').trim() && (m.url || '').trim())
    .map((m) => {
      let headers = {};
      const hs = (m.headers || '').trim();
      if (hs) { try { headers = JSON.parse(hs); } catch { headers = { _raw: hs }; } }
      return { id: m.id || uid('mcp'), name: m.name.trim(), transport: 'http', url: m.url.trim(), headers };
    });
}

async function savePatch(patch) {
  await chrome.runtime.sendMessage({ type: 'set-config', patch });
  const st = $('status');
  st.textContent = t('opts.saved');
  st.className = 'status ok';
  setTimeout(() => { st.textContent = ''; st.className = 'status'; }, 1800);
}

// 取消：从存储重载已保存配置到 UI
async function reloadConfig() {
  const r = await chrome.runtime.sendMessage({ type: 'get-config' });
  const c = (r && r.config) || {};
  const llm = c.llm || {};
  const agent = c.agent || {};
  currentProtocol = llm.protocol || 'openai';
  $('llm-baseurl').value = llm.baseURL || '';
  $('llm-apikey').value = llm.apiKey || '';
  $('llm-model').value = llm.model || '';
  $('llm-displayname').value = llm.displayName || llm.model || '';
  lastModel = llm.model || '';
  $('llm-temperature').value = (llm.temperature !== undefined && llm.temperature !== null) ? llm.temperature : 0.7;
  $('llm-timeout').value = Math.round((llm.timeoutMs || 60000) / 1000);
  $('persona').value = agent.persona || c.persona || '';
  $('max-iter').value = (agent.maxIterations ?? c.maxIterations) || 90;
  applyCompressionUI(agent.compression || {});
  $('summarize-timeout').value = Math.round((agent.summarizeTimeoutMs || 600000) / 1000);
  skillsDraft = (c.skills || []).map((s) => ({ ...s }));
  mcpDraft = (c.mcpServers || []).map((m) => ({ ...m, headers: (m.headers && typeof m.headers === 'object') ? JSON.stringify(m.headers) : (m.headers || '') }));
  renderProtocol();
  renderSkills();
  renderMcp();
}

// ---- MCP 暴露（把 NanoHarness 自身暴露为 MCP server）----
function loadExposeConfig(c) {
  const m = (c && c.mcpServer) || {};
  exposeEnabled = !!m.enabled;
  $('expose-port').value = m.port || 8787;
  $('expose-token').value = m.token || '';
  renderExposeSeg();
  renderExposeConfig();
  if (exposeEnabled) startExposeStatusPolling();
  else renderExposeStatus('disabled');
}

function renderExposeSeg() {
  const seg = $('expose-enabled');
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b.dataset.expose === '1') === exposeEnabled);
  });
}

function exposePort() {
  const p = parseInt($('expose-port').value, 10);
  return (Number.isNaN(p) || p < 1 || p > 65535) ? 8787 : p;
}

function exposeConfig() {
  const port = exposePort();
  const token = $('expose-token').value.trim();
  const cfg = { type: 'streamable_http', url: 'http://localhost:' + port + '/mcp' };
  if (token) cfg.headers = { Authorization: 'Bearer ' + token };
  return { mcpServers: { nanoharness: cfg } };
}

function renderExposeConfig() {
  const box = $('expose-addr-text');
  if (!box) return;
  box.textContent = JSON.stringify(exposeConfig(), null, 2);
}

// 连接状态指示（连接中 / 已连接 / 连接失败）
function renderExposeStatus(s) {
  const el = $('expose-status');
  if (!el) return;
  const map = {
    connected: { cls: 'connected', text: t('opts.exposeConnected') },
    connecting: { cls: 'connecting', text: t('opts.exposeConnecting') },
    failed: { cls: 'failed', text: t('opts.exposeFailed') },
    disabled: { cls: '', text: '' },
  };
  const m = map[s] || map.disabled;
  el.className = 'expose-status' + (m.cls ? ' ' + m.cls : '');
  el.innerHTML = m.text ? '<span class="dot"></span>' + esc(m.text) : '';
}

let exposeStatusTimer = null;
async function pollExposeStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'get-expose-status' });
    const s = (r && r.status) || 'disabled';
    renderExposeStatus(exposeEnabled ? s : 'disabled');
  } catch (e) {}
}
function startExposeStatusPolling() {
  stopExposeStatusPolling();
  pollExposeStatus();
  exposeStatusTimer = setInterval(pollExposeStatus, 1500);
}
function stopExposeStatusPolling() {
  if (exposeStatusTimer) { clearInterval(exposeStatusTimer); exposeStatusTimer = null; }
}

// 采集配置并保存（开关/端口/token 即时生效）
function collectExpose() {
  return { enabled: exposeEnabled, port: exposePort(), token: $('expose-token').value.trim() };
}

async function applyExpose() {
  await chrome.runtime.sendMessage({ type: 'set-config', patch: { mcpServer: collectExpose() } });
}

// 复制连接地址到剪贴板
async function copyExpose() {
  const text = JSON.stringify(exposeConfig(), null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  showToast(t('opts.exposeCopied'), 'ok');
}

// 检测端口是否被占用（fetch relay 的 /health）
async function checkPort() {
  const port = parseInt($('expose-port').value, 10);
  const st = $('port-status');
  if (!st) return;
  if (Number.isNaN(port) || port < 1 || port > 65535) { st.textContent = t('opts.portInvalid'); st.className = 'port-status err'; return; }
  st.textContent = t('opts.portChecking'); st.className = 'port-status';
  try {
    const resp = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(3000) });
    const data = await resp.json().catch(() => ({}));
    if (data && data.service && String(data.service).indexOf('NanoHarness') >= 0) { st.textContent = t('opts.portUsedRelay'); st.className = 'port-status ok'; }
    else { st.textContent = t('opts.portUsedOther'); st.className = 'port-status err'; }
  } catch (e) {
    st.textContent = t('opts.portFree'); st.className = 'port-status ok';
  }
}

function bindEvents() {
  bindTabs();

  // 主题切换
  $('theme-seg').querySelectorAll('[data-theme-btn]').forEach((b) => {
    b.onclick = () => { setTheme(b.dataset.themeBtn); syncUI(); };
  });

  // 协议切换
  $('protocol-seg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => setProtocol(b.dataset.protocol);
  });

  // API Key 显示/隐藏切换（默认隐藏，点击眼睛查看明文）
  $('toggle-apikey').onclick = () => {
    const inp = $('llm-apikey');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('toggle-apikey').classList.toggle('revealed', show);
    $('toggle-apikey').title = show ? t('opts.hideKey') : t('opts.showKey');
  };

  // 模型改变时，若显示名称仍在「默认跟随」状态（空或等于旧模型名），自动同步为新模型名
  $('llm-model').addEventListener('input', () => {
    const dn = $('llm-displayname');
    if (!dn.value.trim() || dn.value.trim() === lastModel) dn.value = $('llm-model').value.trim();
    lastModel = $('llm-model').value.trim();
  });

  $('add-skill').onclick = () => editSkill(-1);
  $('add-mcp').onclick = () => editMcp(-1);

  $('skills-list').onclick = (e) => {
    const card = e.target.closest('.mini-card');
    if (!card) return;
    const idx = parseInt(card.dataset.index, 10);
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'del') { skillsDraft.splice(idx, 1); renderSkills(); }
    else if (action === 'view') viewSkill(idx);
    else editSkill(idx);
  };

  $('mcp-list').onclick = (e) => {
    const card = e.target.closest('.mini-card');
    if (!card) return;
    const idx = parseInt(card.dataset.index, 10);
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'del') { mcpDraft.splice(idx, 1); renderMcp(); }
    else if (action === 'test') testMcp(idx);
    else editMcp(idx);
  };

  // 上传技能文件夹
  $('upload-skill-folder').onclick = () => $('skill-folder-input').click();
  $('skill-folder-input').addEventListener('change', (e) => { uploadSkillFolder(e.target.files); e.target.value = ''; });

  // MCP JSON 导入
  $('import-mcp-json').onclick = importMcpJson;

  // 弹窗关闭
  $('modal-close').onclick = closeModal;
  $('modal-cancel').onclick = closeModal;
  $('modal-ok').onclick = () => { const fn = modalOnOk; closeModal(); if (fn) fn(); };
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

  // ---- 分 tab 保存 / 取消（各设置独立保存）----
  $('save-llm').onclick = () => savePatch({ llm: collectLlm() });
  $('save-agent').onclick = () => savePatch({ agent: collectAgent() });
  // 压缩开关：纯 UI 切换，随「保存」一起提交
  $('comp-enabled-seg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('comp-enabled-seg').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
  });
  $('save-skills').onclick = () => savePatch({ skills: collectSkills() });
  $('save-mcp').onclick = () => savePatch({ mcpServers: collectMcp() });
  $('cancel-llm').onclick = reloadConfig;
  $('cancel-agent').onclick = reloadConfig;
  $('cancel-skills').onclick = reloadConfig;
  $('cancel-mcp').onclick = reloadConfig;
  // MCP 暴露：开关即时启停，端口/token 改动即时应用
  $('expose-enabled').querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      exposeEnabled = b.dataset.expose === '1';
      renderExposeSeg();
      await applyExpose();
      if (exposeEnabled) startExposeStatusPolling();
      else { stopExposeStatusPolling(); renderExposeStatus('disabled'); }
    };
  });
  // token 眼睛（显示/隐藏明文）
  $('toggle-expose-token').onclick = () => {
    const inp = $('expose-token');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('toggle-expose-token').classList.toggle('revealed', show);
    $('toggle-expose-token').title = show ? t('opts.hideKey') : t('opts.showKey');
  };
  $('copy-expose').onclick = copyExpose;
  $('check-port').onclick = checkPort;
  let exposeSaveTimer = null;
  const scheduleExposeApply = () => {
    renderExposeConfig();
    clearTimeout(exposeSaveTimer);
    exposeSaveTimer = setTimeout(applyExpose, 400);
  };
  $('expose-port').addEventListener('input', scheduleExposeApply);
  $('expose-token').addEventListener('input', scheduleExposeApply);

  // 自动检测模型（GET /models）
  $('detect-models').onclick = async () => {
    const baseURL = $('llm-baseurl').value.trim();
    const apiKey = $('llm-apikey').value.trim();
    if (!baseURL) { showTestResult('err', t('opts.needBaseURL')); return; }
    if (!apiKey) { showTestResult('err', t('opts.needApiKey')); return; }
    const btn = $('detect-models');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('opts.detecting');
    try {
      const resp = await fetch(trimEndSlash(baseURL) + '/models', {
        headers: authHeaders(currentProtocol, apiKey),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { const txt = await resp.text().catch(() => ''); throw new Error('HTTP ' + resp.status + (txt ? ' ' + txt.slice(0, 120) : '')); }
      const data = await resp.json();
      const ids = (data && Array.isArray(data.data) ? data.data : []).map((m) => m && m.id).filter(Boolean);
      if (!ids.length) throw new Error(t('opts.noModels'));
      renderModelList(ids);
      showTestResult('ok', t('opts.detectOk').replace('{n}', ids.length));
    } catch (e) {
      $('model-list').classList.add('hidden');
      showTestResult('err', t('opts.detectFail') + ': ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  };

  // 点击别处收起模型下拉
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.model-picker') && !e.target.closest('#detect-models')) {
      $('model-list').classList.add('hidden');
    }
  });

  // 测试连接（发一条最小请求验证连通性）
  $('test-conn').onclick = async () => {
    const baseURL = $('llm-baseurl').value.trim();
    const apiKey = $('llm-apikey').value.trim();
    const model = $('llm-model').value.trim();
    if (!baseURL || !apiKey || !model) { showTestResult('err', t('opts.testMissing')); return; }
    const btn = $('test-conn');
    btn.disabled = true;
    showTestResult('loading', t('opts.testing') + '…');
    try {
      if (currentProtocol === 'anthropic') await testAnthropic(baseURL, apiKey, model);
      else await testOpenAI(baseURL, apiKey, model);
      showTestResult('ok', t('opts.testOk'));
    } catch (e) {
      showTestResult('err', t('opts.testFail') + ': ' + e.message);
    } finally {
      btn.disabled = false;
    }
  };

  // 语言切换后重渲染动态卡片与预设
  document.querySelectorAll('[data-lang-toggle]').forEach((el) => {
    const orig = el.onclick;
    el.onclick = async () => { await orig?.(); renderSkills(); renderMcp(); renderAgentPresets(); renderLlmPresets(); renderTokenDashboard(); };
  });
}

// ---- 大模型检测 / 连接测试辅助 ---- //

function trimEndSlash(s) { return String(s || '').replace(/\/+$/, ''); }

function anthropicUrl(baseURL) {
  const b = trimEndSlash(baseURL);
  return /\/v1$/.test(b) ? b + '/messages' : b + '/v1/messages';
}

function authHeaders(protocol, apiKey) {
  if (String(protocol).toLowerCase() === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { 'Authorization': 'Bearer ' + apiKey };
}

function renderModelList(ids) {
  const box = $('model-list');
  box.innerHTML = ids.map((id) => `<button class="model-option" type="button" data-model="${esc(id)}">${esc(id)}</button>`).join('');
  box.classList.remove('hidden');
  box.onclick = (e) => {
    const b = e.target.closest('.model-option');
    if (!b) return;
    $('llm-model').value = b.dataset.model;
    box.classList.add('hidden');
  };
}

function showTestResult(kind, text) {
  const el = $('test-result');
  el.textContent = text;
  el.className = 'test-result ' + kind;
}

async function testOpenAI(baseURL, apiKey, model) {
  const resp = await fetch(trimEndSlash(baseURL) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('HTTP ' + resp.status + (txt ? ': ' + txt.slice(0, 200) : ''));
  }
}

async function testAnthropic(baseURL, apiKey, model) {
  const resp = await fetch(anthropicUrl(baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('HTTP ' + resp.status + (txt ? ': ' + txt.slice(0, 200) : ''));
  }
}

// ---- token 用量看板（SVG 自绘，无外部图表库）----

const C_IN = '#0a84ff';   // 输入 token 颜色（蓝）
const C_OUT = '#30d158';  // 输出 token 颜色（绿）

function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return fmt1(n / 1e9) + 'B';
  if (n >= 1e6) return fmt1(n / 1e6) + 'M';
  if (n >= 1e3) return fmt1(n / 1e3) + 'K';
  return String(Math.round(n));
}
// 保留最多 1 位小数、去尾 0；用 floor 避免边界进位（999999 → 999.9K 而非 1000K）
function fmt1(v) {
  return String(Math.floor(v * 10) / 10).replace(/\.0$/, '');
}

async function renderTokenDashboard() {
  const box = $('token-charts');
  if (!box) return;
  const r = await chrome.runtime.sendMessage({ type: 'get-token-usage' });
  const usage = (r && r.usage) || [];
  if (!usage.length) {
    box.innerHTML = '<p class="desc">' + t('opts.tokenEmpty') + '</p>';
    return;
  }
  box.innerHTML = renderTrendChart(usage) + renderModelChart(usage);
}

// 图 1：历史用量趋势（按天堆叠面积图，输入蓝 / 输出绿，平滑曲线 + 渐变）
function renderTrendChart(usage) {
  const byDay = new Map();
  for (const u of usage) {
    const d = new Date(u.ts).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, { prompt: 0, completion: 0 });
    const b = byDay.get(d);
    b.prompt += u.promptTokens || 0;
    b.completion += u.completionTokens || 0;
  }
  const keys = [...byDay.keys()].sort().slice(-14);
  const data = keys.map(d => ({ label: d.slice(5), prompt: byDay.get(d).prompt, completion: byDay.get(d).completion }));

  const W = 800, H = 250, PL = 48, PR = 14, PT = 18, PB = 30;
  const iw = W - PL - PR, ih = H - PT - PB;
  const maxV = Math.max(1, ...data.map(d => d.prompt + d.completion));

  const x = (i) => data.length <= 1 ? PL + iw / 2 : PL + (iw * i) / (data.length - 1);
  const y = (v) => PT + ih - (ih * v) / maxV;
  const baseY = y(0);

  const smooth = (arr) => {
    if (arr.length < 2) return `M${arr[0].x},${arr[0].y}`;
    let d = `M${arr[0].x},${arr[0].y}`;
    for (let i = 0; i < arr.length - 1; i++) {
      const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(arr.length - 1, i + 2)];
      const c1x = (p1.x + (p2.x - p0.x) / 6).toFixed(1), c1y = (p1.y + (p2.y - p0.y) / 6).toFixed(1);
      const c2x = (p2.x - (p3.x - p1.x) / 6).toFixed(1), c2y = (p2.y - (p3.y - p1.y) / 6).toFixed(1);
      d += `C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
    }
    return d;
  };

  const inputPts = data.map((d, i) => ({ x: x(i), y: y(d.prompt) }));
  const totalPts = data.map((d, i) => ({ x: x(i), y: y(d.prompt + d.completion) }));
  const close = data.length > 1 ? `L${x(data.length - 1)},${baseY} L${x(0)},${baseY} Z` : `L${x(0)},${baseY} Z`;
  const inputArea = smooth(inputPts) + close;
  const totalArea = smooth(totalPts) + close;

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = (PT + (ih * g) / 4).toFixed(1);
    grid += `<line x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}" stroke="var(--border-soft)" stroke-width="1"/><text x="${PL - 6}" y="${+gy + 3.5}" text-anchor="end" class="chart-axis">${fmtTok(maxV * (1 - g / 4))}</text>`;
  }
  let xlabels = '';
  const step = Math.max(1, Math.ceil(data.length / 8));
  data.forEach((d, i) => {
    if (i % step === 0 || i === data.length - 1) xlabels += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="chart-axis">${d.label}</text>`;
  });

  // 数据点圆点 + hover 热区（透明 rect，悬停整列显示当天输入/输出/总）
  const halfStep = data.length > 1 ? (iw / (data.length - 1)) / 2 : iw / 2;
  let dots = '', hovers = '';
  data.forEach((d, i) => {
    const cx = x(i), iy = y(d.prompt), ty = y(d.prompt + d.completion);
    const tip = `${d.label}  ${t('opts.tokenIn')} ${fmtTok(d.prompt)} · ${t('opts.tokenOut')} ${fmtTok(d.completion)} · ${t('opts.tokenTotal')} ${fmtTok(d.prompt + d.completion)}`;
    dots += `<circle cx="${cx}" cy="${iy}" r="3.5" fill="${C_IN}" stroke="#fff" stroke-width="1.5"/><circle cx="${cx}" cy="${ty}" r="3.5" fill="${C_OUT}" stroke="#fff" stroke-width="1.5"/>`;
    hovers += `<rect x="${(cx - halfStep).toFixed(1)}" y="${PT}" width="${(halfStep * 2).toFixed(1)}" height="${ih}" fill="transparent"><title>${tip}</title></rect>`;
  });

  const svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${C_IN}" stop-opacity="0.30"/><stop offset="100%" stop-color="${C_IN}" stop-opacity="0.02"/></linearGradient>
      <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${C_OUT}" stop-opacity="0.30"/><stop offset="100%" stop-color="${C_OUT}" stop-opacity="0.02"/></linearGradient>
    </defs>
    ${grid}
    <path d="${totalArea}" fill="url(#gOut)"/>
    <path d="${inputArea}" fill="url(#gIn)"/>
    <path d="${smooth(totalPts)}" fill="none" stroke="${C_OUT}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${smooth(inputPts)}" fill="none" stroke="${C_IN}" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    ${hovers}
    ${xlabels}
  </svg>`;

  return `<div class="chart-card">
    <div class="chart-head"><div class="chart-title">${t('opts.tokenTrendTitle')}</div>
      <div class="chart-legend"><span class="lg lg-in"></span>${t('opts.tokenIn')}<span class="lg lg-out"></span>${t('opts.tokenOut')}</div></div>
    ${svg}
  </div>`;
}

// 图 2：按模型用量（水平堆叠条形图，displayName 区分，附 baseURL host）
function renderModelChart(usage) {
  const map = new Map();
  for (const u of usage) {
    const name = u.displayName || u.model || '未知';
    const key = name + '|' + (u.baseURL || '');
    if (!map.has(key)) map.set(key, { name, host: (() => { try { return new URL(u.baseURL).host; } catch { return ''; } })(), prompt: 0, completion: 0 });
    const b = map.get(key);
    b.prompt += u.promptTokens || 0;
    b.completion += u.completionTokens || 0;
  }
  const rows = [...map.values()].sort((a, b) => (b.prompt + b.completion) - (a.prompt + a.completion)).slice(0, 10);
  const maxTotal = Math.max(1, ...rows.map(r => r.prompt + r.completion));

  const rowH = 40, labelW = 168, barMax = 360, barX = labelW + 10;
  const valX = barX + barMax + 16;
  const H = rows.length * rowH + 8;
  const totalW = 800;

  let clips = '', bars = '';
  rows.forEach((r, i) => {
    const ty = i * rowH;
    const pw = (barMax * r.prompt) / maxTotal;
    const cw = (barMax * r.completion) / maxTotal;
    const cid = 'bc' + i;
    const tip = `${esc(r.name)}  ${t('opts.tokenIn')} ${fmtTok(r.prompt)} · ${t('opts.tokenOut')} ${fmtTok(r.completion)} · ${t('opts.tokenTotal')} ${fmtTok(r.prompt + r.completion)}`;
    clips += `<clipPath id="${cid}"><rect x="${barX}" y="10" width="${barMax}" height="16" rx="8"/></clipPath>`;
    bars += `<g transform="translate(0,${ty})">
      <title>${tip}</title>
      <text x="${labelW - 4}" y="15" text-anchor="end" class="chart-label">${esc(r.name)}</text>
      ${r.host ? `<text x="${labelW - 4}" y="30" text-anchor="end" class="chart-axis">${esc(r.host)}</text>` : ''}
      <g clip-path="url(#${cid})">
        <rect x="${barX}" y="10" width="${barMax}" height="16" fill="var(--hover)"/>
        <rect x="${barX}" y="10" width="${pw}" height="16" fill="${C_IN}"/>
        <rect x="${barX + pw}" y="10" width="${cw}" height="16" fill="${C_OUT}"/>
      </g>
      <text x="${valX}" y="22" class="chart-val chart-in">${fmtTok(r.prompt)}</text>
      <text x="${valX + 68}" y="22" class="chart-val chart-out">${fmtTok(r.completion)}</text>
      <text x="${valX + 136}" y="22" class="chart-val chart-total">${fmtTok(r.prompt + r.completion)}</text>
    </g>`;
  });

  const svg = `<svg class="chart-svg" viewBox="0 0 ${totalW} ${H}" preserveAspectRatio="xMidYMid meet"><defs>${clips}</defs>${bars}</svg>`;

  return `<div class="chart-card">
    <div class="chart-head"><div class="chart-title">${t('opts.tokenModelTitle')}</div>
      <div class="chart-legend"><span class="lg lg-in"></span>${t('opts.tokenIn')}<span class="lg lg-out"></span>${t('opts.tokenOut')}</div></div>
    <div class="chart-scroll">${svg}</div>
  </div>`;
}
