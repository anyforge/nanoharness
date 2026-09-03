// background/tools/browser.js — 浏览器操控工具（chrome.scripting 注入 + chrome.debugger CDP）
import { defineTool } from './registry.js';

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// 是否可注入脚本（chrome:// / about: / 扩展页 / devtools 等受保护页面不可注入）
function injectable(tab) {
  if (!tab || tab.id == null) return false;
  const u = String(tab.url || '');
  return !(u.startsWith('chrome://') || u.startsWith('chrome-extension://') || u.startsWith('chrome-untrusted://')
    || u.startsWith('edge://') || u.startsWith('about:') || u.startsWith('devtools://') || u.startsWith('view-source:'));
}

// 统一注入封装：容错 + 友好错误
async function inject(tab, func, args) {
  if (!injectable(tab)) return { error: '此页面不可注入脚本（' + (tab.url || '') + '），请先切换到普通网页' };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
    return (res && res.result !== undefined) ? res.result : { error: '注入返回空结果' };
  } catch (e) {
    return { error: '注入失败：' + String(e && e.message ? e.message : e) };
  }
}

// CDP 调用串行化（同一 tab 不能并发 attach；先清理可能残留的 attach 再重新 attach）
let cdpChain = Promise.resolve();
async function cdp(tabId, method, params) {
  const run = async () => {
    await chrome.debugger.detach({ tabId }).catch(() => {}); // 清理残留 attach（SW 重启等场景）
    await chrome.debugger.attach({ tabId }, '1.3');
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } finally {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  };
  const p = cdpChain.then(run, run);
  cdpChain = p.then(() => {}, () => {});
  return p;
}

// 注入脚本：读页面（正文 + 链接）
function scrapeScript() {
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, 40000),
    links: [...document.querySelectorAll('a[href]')].slice(0, 200).map((a) => ({
      text: (a.innerText || '').trim().slice(0, 100),
      href: a.href,
    })),
  };
}

// ---- 读取类 ----

defineTool({
  name: 'browser_get_page',
  description: 'Read the current active tab: URL, title, visible text and links. Call this first to see what the user is looking at.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, scrapeScript, []);
  },
});

defineTool({
  name: 'browser_get_html',
  description: 'Get the full outerHTML of the active tab (raw markup). Useful when you need exact structure/attributes.',
  parameters: { type: 'object', properties: { selector: { type: 'string', description: 'optional CSS selector; omit for whole document' } } },
  execute: async ({ selector }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (sel) => {
      const el = sel ? document.querySelector(sel) : document.documentElement;
      if (!el) return { error: '没有元素匹配 ' + sel };
      return { html: el.outerHTML.slice(0, 50000) };
    }, [selector || '']);
  },
});

defineTool({
  name: 'browser_get_element',
  description: 'Get details of an element matching a CSS selector: tag, text, attributes, and bounding rect.',
  parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
  execute: async ({ selector }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { error: '没有元素匹配 ' + sel };
      const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, 500),
        attrs,
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        visible: !!(r.width || r.height),
      };
    }, [selector]);
  },
});

// ---- 导航类 ----

defineTool({
  name: 'browser_navigate',
  description: 'Navigate the active tab to a URL. Optionally wait a number of milliseconds for the page to load.',
  parameters: { type: 'object', properties: { url: { type: 'string', description: 'full URL' }, waitMs: { type: 'number', description: 'optional ms to wait after navigating' } }, required: ['url'] },
  execute: async ({ url, waitMs }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    await chrome.tabs.update(tab.id, { url: String(url) });
    if (waitMs && waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    return { ok: true, url: String(url) };
  },
});

defineTool({
  name: 'browser_back',
  description: 'Go back in the active tab history.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, () => { history.back(); return { ok: true }; }, []);
  },
});

defineTool({
  name: 'browser_forward',
  description: 'Go forward in the active tab history.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, () => { history.forward(); return { ok: true }; }, []);
  },
});

defineTool({
  name: 'browser_reload',
  description: 'Reload the active tab.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    await chrome.tabs.reload(tab.id);
    return { ok: true };
  },
});

defineTool({
  name: 'browser_open_tab',
  description: 'Open a URL in a new tab and make it active.',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  execute: async ({ url }) => {
    const tab = await chrome.tabs.create({ url: String(url) });
    return { ok: true, tabId: tab.id, url: String(url) };
  },
});

defineTool({
  name: 'browser_close_tab',
  description: 'Close a tab by id (omit id to close the active tab).',
  parameters: { type: 'object', properties: { tabId: { type: 'number' } } },
  execute: async ({ tabId }) => {
    let id = tabId;
    if (id == null) { const t = await activeTab(); id = t ? t.id : null; }
    if (id == null) return { error: '没有可关闭的标签页' };
    try { await chrome.tabs.remove(id); return { ok: true, tabId: id }; }
    catch (e) { return { error: '关闭失败：' + String(e && e.message ? e.message : e) }; }
  },
});

defineTool({
  name: 'browser_list_tabs',
  description: 'List all open tabs (id, url, title, active).',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
  },
});

defineTool({
  name: 'browser_activate_tab',
  description: 'Bring a tab to the foreground by id (so it becomes the active tab).',
  parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
  execute: async ({ tabId }) => {
    try { await chrome.tabs.update(tabId, { active: true }); return { ok: true, tabId }; }
    catch (e) { return { error: '激活失败：' + String(e && e.message ? e.message : e) }; }
  },
});

// ---- 交互类 ----

defineTool({
  name: 'browser_click',
  description: 'Click the element matching a CSS selector in the active tab (synthetic click). Returns whether it matched and clicked.',
  parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector, e.g. .login-btn' } }, required: ['selector'] },
  execute: async ({ selector }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { clicked: false, reason: '没有元素匹配 ' + sel };
      const r = el.getBoundingClientRect();
      el.click();
      return {
        clicked: true,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').trim().slice(0, 120),
        center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      };
    }, [selector]);
  },
});

defineTool({
  name: 'browser_click_text',
  description: 'Find a clickable element (a/button/label/[role=button]) by its visible text and click it. Use when you know the label but not the selector.',
  parameters: { type: 'object', properties: { text: { type: 'string', description: 'visible text to match (substring, case-insensitive)' } }, required: ['text'] },
  execute: async ({ text }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (txt) => {
      const t = String(txt).toLowerCase();
      const els = [...document.querySelectorAll('a,button,[role=button],[role=link],label,summary,li,input[type=submit],input[type=button]')];
      const el = els.find((e) => (e.innerText || e.value || '').toLowerCase().includes(t));
      if (!el) return { clicked: false, reason: '没有文字包含「' + txt + '」的可点击元素' };
      el.click();
      return { clicked: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 120) };
    }, [text]);
  },
});

defineTool({
  name: 'browser_type',
  description: 'Type text into an input/textarea matching a CSS selector (native value setter + input/change events, works on React pages).',
  parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] },
  execute: async ({ selector, text }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (sel, txt) => {
      const el = document.querySelector(sel);
      if (!el) return { typed: false, reason: '没有元素匹配 ' + sel };
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, txt);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: true, value: txt };
    }, [selector, text]);
  },
});

defineTool({
  name: 'browser_press_key',
  description: 'Dispatch a keyboard key on the active tab (e.g. Enter, Escape, Tab, ArrowDown).',
  parameters: { type: 'object', properties: { key: { type: 'string', description: 'key name, e.g. Enter / Escape / Tab / ArrowDown / Backspace' }, selector: { type: 'string', description: 'optional target element selector' } }, required: ['key'] },
  execute: async ({ key, selector }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (k, sel) => {
      const el = sel ? document.querySelector(sel) : (document.activeElement || document.body);
      if (!el) return { pressed: false, reason: '没有元素匹配 ' + sel };
      const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return { pressed: true, key: k };
    }, [key, selector || '']);
  },
});

defineTool({
  name: 'browser_hover',
  description: 'Hover the mouse over an element matching a CSS selector (fires mouseover/mouseenter).',
  parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
  execute: async ({ selector }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { hovered: false, reason: '没有元素匹配 ' + sel };
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
      return { hovered: true };
    }, [selector]);
  },
});

defineTool({
  name: 'browser_select',
  description: 'Select an option in a <select> element by its value or visible label, then fire change.',
  parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string', description: 'option value or label to select' } }, required: ['selector', 'value'] },
  execute: async ({ selector, value }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { selected: false, reason: '没有元素匹配 ' + sel };
      if (el.tagName !== 'SELECT') return { selected: false, reason: '元素不是 <select>' };
      const opt = [...el.options].find((o) => o.value === val || o.textContent.trim() === val);
      if (!opt) return { selected: false, reason: '没有匹配的选项', options: [...el.options].map((o) => o.value) };
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: true, value: opt.value };
    }, [selector, value]);
  },
});

defineTool({
  name: 'browser_fill_form',
  description: 'Fill multiple form fields at once. fields is a map of CSS selector -> value.',
  parameters: { type: 'object', properties: { fields: { type: 'object', description: 'map: { "css selector": "value", ... }' } }, required: ['fields'] },
  execute: async ({ fields }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (flds) => {
      const out = [];
      for (const [sel, val] of Object.entries(flds || {})) {
        const el = document.querySelector(sel);
        if (!el) { out.push({ selector: sel, filled: false, reason: '没有元素匹配' }); continue; }
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, String(val));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        out.push({ selector: sel, filled: true });
      }
      return { filled: out.length, results: out };
    }, [fields]);
  },
});

defineTool({
  name: 'browser_scroll',
  description: 'Scroll the active tab. direction: down/up/top/bottom, or use amount for pixel delta.',
  parameters: { type: 'object', properties: { direction: { type: 'string', description: 'down / up / top / bottom' }, amount: { type: 'number', description: 'pixel amount (used when direction is down/up)' } }, required: ['direction'] },
  execute: async ({ direction, amount }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (dir, amt) => {
      const y = (dir === 'up') ? -(amt || 500) : (dir === 'down') ? (amt || 500) : (dir === 'top') ? -document.body.scrollHeight : (dir === 'bottom') ? document.body.scrollHeight : 0;
      window.scrollBy(0, y);
      return { scrolled: true, scrollY: Math.round(window.scrollY) };
    }, [direction, amount]);
  },
});

defineTool({
  name: 'browser_wait',
  description: 'Wait a number of milliseconds, or wait until an element matching a selector appears (timeoutMs).',
  parameters: { type: 'object', properties: { selector: { type: 'string', description: 'wait for this element to appear' }, ms: { type: 'number', description: 'plain delay in ms' }, timeoutMs: { type: 'number', description: 'max wait when polling for selector (default 5000)' } } },
  execute: async ({ selector, ms, timeoutMs }) => {
    if (!selector) { const d = ms || 500; await new Promise((r) => setTimeout(r, d)); return { waited: true, ms: d }; }
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    const timeout = timeoutMs || 5000;
    return await inject(tab, async (sel, to) => {
      const start = Date.now();
      while (Date.now() - start < to) {
        if (document.querySelector(sel)) return { appeared: true, selector: sel, elapsedMs: Date.now() - start };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { appeared: false, selector: sel, timeoutMs: to };
    }, [selector, timeout]);
  },
});

// ---- 截图 / 执行 ----

defineTool({
  name: 'browser_screenshot',
  description: 'Take a screenshot of the active tab via CDP. Returns size + a JPEG data URL (large; only meaningful to vision models).',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    try {
      const shot = await cdp(tab.id, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      return {
        ok: true,
        width: shot.metadata ? shot.metadata.width : null,
        height: shot.metadata ? shot.metadata.height : null,
        dataUrl: 'data:image/jpeg;base64,' + shot.data,
      };
    } catch (e) {
      return { error: '截图失败：' + String(e && e.message ? e.message : e) };
    }
  },
});

defineTool({
  name: 'browser_eval',
  description: 'Evaluate arbitrary JavaScript in the active tab and return the JSON-stringified result. Powerful but risky — use only when other tools cannot express the action.',
  parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript expression to evaluate (e.g. document.querySelector(...).innerText)' } }, required: ['code'] },
  execute: async ({ code }) => {
    const tab = await activeTab();
    if (!tab) return { error: '没有活动标签页' };
    return await inject(tab, (c) => {
      try {
        const v = (0, eval)(c);
        if (v && typeof v.then === 'function') return { error: '不支持异步返回' };
        return { result: (typeof v === 'string' ? v : JSON.stringify(v ?? null)) };
      } catch (e) {
        return { error: '执行出错：' + String(e && e.message ? e.message : e) };
      }
    }, [code]);
  },
});
