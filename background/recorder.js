// background/recorder.js — 操作录制 / Action recorder: capture page actions → LLM summarize → save as skill
import { getConfig, setConfig } from '../shared/storage.js';
import { streamChat } from './llm.js';

// 捕获脚本（注入页面，幂等；事件监听器在函数返回后仍存活，累积到 window.__nhRecorder）
export function captureScript() {
  if (window.__nhRecorder) return true;
  window.__nhRecorder = { steps: [] };
  const rec = window.__nhRecorder.steps;
  const esc = (s) => { try { return CSS.escape(s); } catch (e) { return String(s).replace(/"/g, '\\"'); } };

  // cssPath：结构定位（最多 5 级，id 命中即停）
  function cssPath(el) {
    if (!el || el === document.body) return 'body';
    const parts = [];
    let n = el;
    while (n && n !== document.body && parts.length < 5) {
      let seg = n.tagName.toLowerCase();
      if (n.id) { seg += '#' + esc(n.id); parts.unshift(seg); break; }
      if (n.parentElement) {
        const same = Array.prototype.slice.call(n.parentElement.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(seg);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  // 多级定位器：优先稳定 id（唯一性校验）/name/data-testid/placeholder/aria-label，回退可见文字/cssPath
  function locator(el) {
    const out = { selector: '', text: '' };
    if (!el) return { selector: 'body', text: '' };
    if (el.id && !/^\d/.test(el.id)) {
      let uniq = true;
      try { uniq = document.querySelectorAll('#' + esc(el.id)).length === 1; } catch (e) { uniq = false; }
      if (uniq) out.selector = '#' + esc(el.id);
    }
    if (!out.selector && el.name) out.selector = '[name="' + String(el.name).replace(/"/g, '\\"') + '"]';
    const dt = el.getAttribute ? (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-test-id')) : '';
    if (!out.selector && dt) out.selector = '[data-testid="' + String(dt).replace(/"/g, '\\"') + '"]';
    const ph = el.getAttribute ? String(el.getAttribute('placeholder') || '').trim() : '';
    if (!out.selector && ph) out.selector = '[placeholder="' + ph.replace(/"/g, '\\"') + '"]';
    const al = el.getAttribute ? String(el.getAttribute('aria-label') || '').trim() : '';
    if (!out.selector && al) out.selector = '[aria-label="' + al.replace(/"/g, '\\"') + '"]';
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (t) out.text = t;
    if (!out.selector) out.selector = cssPath(el);
    return out;
  }

  const isForm = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!(el.isContentEditable));
  const push = (type, data) => rec.push(Object.assign({ action: type, url: location.href, ts: Date.now() }, data));

  // 录制状态与去重缓存
  let activeInput = null; // { el, loc, last, dirty }
  let lastClick = { selector: '', ts: 0 };
  let lastScrollY = -1;
  let hoverTimer = null;
  let hoverEl = null;
  let lastHover = { selector: '', ts: 0 };

  function flushInput(el) {
    if (!activeInput || activeInput.el !== el) return;
    const cur = activeInput;
    activeInput = null;
    const v = (el.value !== undefined) ? el.value : (el.textContent || '');
    // 没发生过输入且值没变 → 不记（避免失焦/提交时的空记）
    if (!cur.dirty && v === cur.last) return;
    const sensitive = el.type === 'password';
    push('type', { tag: el.tagName.toLowerCase(), loc: cur.loc, value: sensitive ? '【密码】' : String(v).slice(0, 500) });
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;
    // 勾选 / 单选
    const chk = t.closest && t.closest('input');
    if (chk && (chk.type === 'checkbox' || chk.type === 'radio')) {
      push('click', { tag: 'input', inputType: chk.type, loc: locator(chk), value: chk.checked ? 'checked' : 'unchecked' });
      return;
    }
    if (t.closest && t.closest('input,textarea,select')) return; // 文本输入交给 focusin/blur
    const clickable = t.closest ? t.closest('a,button,[role=button],[role=link],label,summary,[onclick]') : null;
    if (!clickable) return;
    const loc = locator(clickable);
    const now = Date.now();
    // 去重：同一元素 400ms 内重复点击（双击/连点）只记一次
    if (lastClick.selector === loc.selector && now - lastClick.ts < 400) return;
    lastClick = { selector: loc.selector, ts: now };
    push('click', { tag: clickable.tagName.toLowerCase(), loc });
  }, true);

  document.addEventListener('focusin', (e) => {
    if (isForm(e.target)) {
      activeInput = {
        el: e.target,
        loc: locator(e.target),
        last: (e.target.value !== undefined ? e.target.value : (e.target.textContent || '')),
        dirty: false,
      };
    }
  }, true);
  document.addEventListener('input', (e) => { if (activeInput && activeInput.el === e.target) activeInput.dirty = true; }, true);
  document.addEventListener('blur', (e) => { if (isForm(e.target)) flushInput(e.target); }, true);

  document.addEventListener('change', (e) => {
    if (e.target && e.target.tagName === 'SELECT') push('select', { loc: locator(e.target), value: e.target.value });
  }, true);

  document.addEventListener('submit', (e) => {
    if (activeInput) flushInput(activeInput.el); // 提交前补记未失焦的输入
    push('submit', { loc: locator(e.target) });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && isForm(e.target) && !e.isComposing) {
      if (activeInput) flushInput(activeInput.el);
      push('submit', { via: 'enter', loc: locator(e.target) });
    }
  }, true);

  // hover：停留 ≥300ms 到可点击/菜单元素才记（打开菜单/下拉的常见前置动作），1.5s 内同元素去重
  document.addEventListener('mouseover', (e) => {
    const hoverable = e.target && e.target.closest ? e.target.closest('a,button,[role=button],[role=link],[role=menuitem],summary,[onclick]') : null;
    if (!hoverable) return;
    hoverEl = hoverable;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const loc = locator(hoverEl);
      const now = Date.now();
      if (lastHover.selector === loc.selector && now - lastHover.ts < 1500) return;
      lastHover = { selector: loc.selector, ts: now };
      push('hover', { tag: hoverEl.tagName.toLowerCase(), loc });
    }, 300);
  }, true);
  document.addEventListener('mouseout', (e) => {
    if (hoverTimer && e.target === hoverEl) { clearTimeout(hoverTimer); hoverTimer = null; }
  }, true);

  let scrollTimer = null;
  document.addEventListener('scroll', () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      const y = Math.round(window.scrollY);
      if (Math.abs(y - lastScrollY) < 50) return; // 同位置微滚不计
      lastScrollY = y;
      push('scroll', { scrollY: y });
    }, 800);
  }, true);

  return true;
}

let recording = false;
let injectedTabs = new Set();
let recordTimer = null;
let recordedSteps = [];

export function isRecording() { return recording; }

function injectable(tab) {
  if (!tab || tab.id == null) return false;
  return isNavigableUrl(tab.url);
}

function isNavigableUrl(u) {
  const s = String(u || '');
  return !(s.startsWith('chrome://') || s.startsWith('chrome-extension://') || s.startsWith('edge://') || s.startsWith('about:') || s.startsWith('devtools://'));
}

// 导航捕获：地址栏输入 / 点链接 / 前进后退等主 frame 跳转，记为 navigate 步骤
function onCommitted(details) {
  if (!details || details.frameId !== 0) return; // 只要主 frame，忽略 iframe
  const url = String(details.url || '');
  if (!isNavigableUrl(url)) return;
  const last = recordedSteps[recordedSteps.length - 1];
  if (last && last.action === 'navigate' && last.url === url) return; // 连续同 URL commit 去重
  recordedSteps.push({ action: 'navigate', url, ts: Date.now(), transition: details.transitionType || '' });
}

async function injectTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: captureScript });
    injectedTabs.add(tabId);
  } catch (e) { /* 不可注入页面忽略 */ }
}

async function pullSteps() {
  const ids = [...injectedTabs];
  for (const tabId of ids) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { const r = window.__nhRecorder; return r ? r.steps.splice(0) : null; },
      });
      if (res && res.result && res.result.length) recordedSteps.push(...res.result);
    } catch (e) {
      injectedTabs.delete(tabId); // tab 已关闭
    }
  }
}

function onActivated({ tabId }) {
  if (tabId == null) return;
  chrome.tabs.get(tabId).then((t) => { if (injectable(t)) injectTab(tabId); }).catch(() => {});
}

function onUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete' && injectable(tab)) {
    injectedTabs.delete(tabId); // 导航后脚本丢失，重新注入
    injectTab(tabId);
  }
}

export async function startRecording() {
  if (recording) return { ok: false, error: '已在录制中' };
  recording = true;
  recordedSteps = [];
  injectedTabs = new Set();
  // 注入所有现有可注入标签页（用户可能点录制后才去开新标签页/导航）
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (injectable(t)) await injectTab(t.id);
  // 跟随后续激活/加载的标签页
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  recordTimer = setInterval(pullSteps, 400);
  return { ok: true };
}

let pendingSteps = null;

export async function stopRecording() {
  if (!recording) return { ok: false, error: '未在录制' };
  if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
  chrome.tabs.onActivated.removeListener(onActivated);
  chrome.tabs.onUpdated.removeListener(onUpdated);
  chrome.webNavigation.onCommitted.removeListener(onCommitted);
  await pullSteps();
  recording = false;
  const steps = recordedSteps.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  recordedSteps = [];
  injectedTabs = new Set();
  pendingSteps = steps.length ? steps : null;
  return { ok: true, count: steps.length };
}

export async function saveRecording(name, onProgress) {
  if (!pendingSteps || !pendingSteps.length) return { ok: false, error: '没有待保存的操作' };
  const steps = pendingSteps;
  pendingSteps = null;
  try {
    const skill = await summarizeSteps(steps, name, onProgress);
    return { ok: true, skill };
  } catch (e) {
    return { ok: false, error: '归纳失败：' + String(e && e.message ? e.message : e) };
  }
}

export function cancelRecording() { pendingSteps = null; }

async function summarizeSteps(steps, name, onProgress) {
  const config = await getConfig();
  if (!config.llm.baseURL || !config.llm.apiKey || !config.llm.model) throw new Error('未配置大模型');

  const prompt = `把以下网页操作步骤归纳成一个可复用的「技能」，技能名固定为「${name}」。

要求：
1. 忠实保留完整操作路径（不跨页合并、不把「搜索→进官网」提取成目标 URL 捷径）
2. 只去真噪音（重复聚焦/滚动/同元素重复点击）
3. 识别动态变量，用中文方括号占位，如【姓名】【金额】【日期】
4. 每个操作含 action（click/type/select/submit/scroll/hover/navigate）与 loc（{selector,text}，selector 优先、text 兜底）；navigate 表示页面跳转、含目标 url（即「打开该网址」），务必保留在技能里；hover 是辅助动作，仅当它真正打开了菜单/下拉才保留，否则删掉
5. 只输出一个 JSON 对象（不要任何解释、不要 markdown 代码块）：
{"name":"${name}","description":"一句话中文描述","content":"技能正文，每一步写清：用 browser_navigate 打开网址 xxx；用 browser_click 点击选择器 xxx 或文字「xxx」；用 browser_type 在选择器 xxx 输入 xxx"}

操作步骤：
${JSON.stringify(steps, null, 2)}`;

  // 流式归纳：边生成边回报进度（已生成字符数），给足 5 分钟
  let accLen = 0;
  const { content: raw } = await streamChat({
    protocol: config.llm.protocol,
    baseURL: config.llm.baseURL,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    temperature: config.llm.temperature,
    timeoutMs: Math.max((config.agent && config.agent.summarizeTimeoutMs) || 600000, 60000),
    messages: [{ role: 'user', content: prompt }],
    onText: (delta) => {
      accLen += String(delta || '').length;
      if (onProgress) onProgress(accLen);
    },
  });

  const json = parseSkillJson(raw);
  const skill = {
    id: 'sk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: name || json.name || 'unnamed-skill',
    description: json.description || '',
    content: json.content || raw,
  };
  const next = [...(config.skills || []), skill];
  await setConfig({ skills: next });
  return skill;
}

function parseSkillJson(raw) {
  const text = String(raw || '').trim();
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const s = stripped.indexOf('{');
  const e = stripped.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(stripped.slice(s, e + 1)); } catch {}
  }
  return {};
}
