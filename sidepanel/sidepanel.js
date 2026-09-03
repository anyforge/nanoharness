// sidepanel/sidepanel.js — 会话 UI / Session UI: list + chat + streaming + tool collapse + interrupt
let port = null;
let activeSessionId = null;
let sessions = [];
let running = false;
let recording = false;

let currentAssistantBody = null;   // 当前 assistant 消息的 msg-body
let currentBubble = null;          // 当前 assistant 卡片（普通 bubble 或 task bubble）
let currentTaskProcess = null;     // 当前「思考与工具」折叠容器（在 task 卡片里）
let currentAnswer = null;          // 最终回复文本区（在 task 卡片里）
let currentToolItem = null;        // 当前工具小折叠项
let reasoningBuffer = '';          // 思考缓冲（渲染在工具下方）
let toolCount = 0;                 // 当前容器内的工具数
let assistantText = '';

const $ = (id) => document.getElementById(id);

const SEND_ARROW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
const STOP_ICON = '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor"/></svg>';

// ---- 初始化 ----

(async () => {
  await loadLang();
  await loadTheme();
  if (window.mermaid) {
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
        securityLevel: 'loose',
        flowchart: { useMaxWidth: true },
      });
    } catch (e) {}
  }
  applyI18n();
  bindLangToggles();
  connectPort();
  await refreshSessions();
  bindEvents();
  renderEmpty();
  bindStorageSync();
})();

function connectPort() {
  port = chrome.runtime.connect({ name: 'nanoharness-panel' });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    // SW 挂起/重启导致 port 断开时自动重连，保证后续 agent-event 能送达
    setTimeout(() => connectPort(), 200);
  });
}

function onPortMessage(msg) {
  if (msg.type === 'agent-event' && msg.sessionId === activeSessionId) handleEvent(msg.event);
  else if (msg.type === 'record-result') handleRecordResult(msg);
  else if (msg.type === 'record-saved') handleRecordSaved(msg);
  else if (msg.type === 'record-progress') handleRecordProgress(msg);
}

function handleRecordResult(msg) {
  recording = false;
  updateRecordBtn();
  if (msg.count > 0) openRecordDialog();
  else showRecordAlert(msg.error || t('panel.recordNoSteps'));
}

function handleRecordSaved(msg) {
  closeRecordDialog();
  if (msg.skill) showToast(t('panel.skillSaved').replace('{name}', msg.skill.name));
  else showToast(t('panel.recordSaveFailed'));
}

function handleRecordProgress(msg) {
  const dlg = $('record-dialog');
  if (!dlg || dlg.classList.contains('hidden')) return; // 弹窗已关则忽略
  const status = $('record-dialog-status');
  if (msg && msg.chars != null) {
    status.textContent = t('panel.recordProgress').replace('{n}', msg.chars);
    status.className = 'record-dialog-status';
  }
}

function updateRecordBtn() {
  const btn = $('btn-record');
  btn.classList.toggle('recording', recording);
  btn.textContent = recording ? '■' : '●';
  btn.title = recording ? t('panel.stopRecord') : t('panel.record');
}

// ---- 录制弹窗 ----
function openRecordIntro() {
  $('record-intro-dialog').classList.remove('hidden');
}

function closeRecordIntro() {
  $('record-intro-dialog').classList.add('hidden');
}

function showRecordAlert(text) {
  $('record-alert-title').textContent = t('panel.recordAlertTitle');
  $('record-alert-body').textContent = text;
  $('record-alert-dialog').classList.remove('hidden');
}

function closeRecordAlert() {
  $('record-alert-dialog').classList.add('hidden');
}

function openRecordDialog() {
  $('record-name-input').value = '';
  const st = $('record-dialog-status');
  st.textContent = '';
  st.className = 'record-dialog-status';
  $('record-dialog').classList.remove('hidden');
  setTimeout(() => $('record-name-input').focus(), 50);
}

function closeRecordDialog() {
  $('record-dialog').classList.add('hidden');
}

async function doSaveRecording() {
  const name = $('record-name-input').value.trim();
  const status = $('record-dialog-status');
  if (!name) { status.textContent = t('panel.recordNameRequired'); status.className = 'record-dialog-status err'; return; }
  status.textContent = t('panel.recordSummarizing');
  status.className = 'record-dialog-status';
  $('record-progress').classList.remove('hidden');
  const btn = $('record-ok');
  btn.disabled = true;
  btn.textContent = '…';
  const r = await chrome.runtime.sendMessage({ type: 'record-save', name });
  btn.disabled = false;
  btn.textContent = t('panel.recordSaveBtn');
  $('record-progress').classList.add('hidden');
  if (!r || !r.ok) {
    status.textContent = (r && r.error) || t('panel.recordSaveFailed');
    status.className = 'record-dialog-status err';
  }
  // 成功时由 record-saved 消息统一关闭弹窗 + toast
}

function showToast(text) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---- ask_user：智能体向用户提问（支持多问题 + 左右切换分页）----
let askState = null; // { questions: [{question,options,multi_select}], index, answers: [{selected,text}] }

function showAskUser(question, args) {
  const bar = $('ask-bar');
  if (!bar) return;
  const questions = [];
  if (args && Array.isArray(args.questions) && args.questions.length) {
    for (const q of args.questions) questions.push({ question: q.question || '', options: Array.isArray(q.options) ? q.options : [], multi_select: !!q.multi_select });
  } else {
    questions.push({ question: question || '', options: (args && Array.isArray(args.options)) ? args.options : [], multi_select: !!(args && args.multi_select) });
  }
  askState = { questions, index: 0, answers: questions.map(() => ({ selected: [], text: '' })) };
  renderAskQuestion();
  bar.classList.remove('hidden');
  setTimeout(() => $('ask-input').focus(), 50);
}

function renderAskQuestion() {
  const st = askState;
  if (!st) return;
  const multi = st.questions.length > 1;
  const q = st.questions[st.index];
  const ans = st.answers[st.index];
  $('ask-pager').classList.toggle('hidden', !multi);
  if (multi) $('ask-page').textContent = (st.index + 1) + ' / ' + st.questions.length;
  $('ask-question').textContent = (multi ? (st.index + 1) + '. ' : '') + q.question;
  const opts = $('ask-options');
  opts.innerHTML = '';
  opts.classList.toggle('hidden', !q.options.length);
  // 长选项竖排、短选项横排
  const maxLen = q.options.reduce((m, o) => Math.max(m, o.length), 0);
  opts.classList.toggle('vertical', maxLen > 10);
  q.options.forEach((o, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ask-option';
    b.dataset.value = o;
    b.textContent = q.options.length > 1 ? String.fromCharCode(65 + i) + '. ' + o : o;
    if (ans.selected.includes(o)) b.classList.add('selected');
    b.onclick = () => {
      if (q.multi_select) {
        b.classList.toggle('selected');
      } else {
        opts.querySelectorAll('.ask-option').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      }
    };
    opts.appendChild(b);
  });
  $('ask-input').value = ans.text;
  $('ask-send').textContent = multi ? (st.index === st.questions.length - 1 ? t('panel.askSubmit') : t('panel.askNext')) : t('panel.askSend');
}

function saveAskCurrent() {
  const st = askState;
  if (!st) return;
  const ans = st.answers[st.index];
  ans.selected = [...$('ask-options').querySelectorAll('.ask-option.selected')].map((x) => x.dataset.value || x.textContent);
  ans.text = $('ask-input').value.trim();
}

function askPrev() {
  if (!askState || askState.index === 0) return;
  saveAskCurrent();
  askState.index--;
  renderAskQuestion();
}

function askNext() {
  if (!askState || askState.index >= askState.questions.length - 1) return;
  saveAskCurrent();
  askState.index++;
  renderAskQuestion();
}

function hideAskUser() {
  const bar = $('ask-bar');
  if (bar) bar.classList.add('hidden');
  askState = null;
}

function askCancel() {
  hideAskUser();
  chrome.runtime.sendMessage({ type: 'ask-user-reply', answer: '（用户已取消）' });
}

function sendAskReply() {
  const st = askState;
  if (!st) return;
  saveAskCurrent();
  const multi = st.questions.length > 1;
  if (multi && st.index < st.questions.length - 1) {
    askState.index++;
    renderAskQuestion();
    return;
  }
  let answer = '';
  if (multi) {
    answer = st.answers.map((a, i) => {
      const val = a.selected.length ? a.selected.join('、') : a.text;
      return (i + 1) + '. ' + st.questions[i].question + '：' + (val || '（未答）');
    }).join('\n');
  } else {
    const a = st.answers[0];
    answer = a.selected.length ? a.selected.join('、') : a.text;
  }
  if (!answer) return;
  hideAskUser();
  chrome.runtime.sendMessage({ type: 'ask-user-reply', answer });
}

// ---- 会话列表 ----

async function refreshSessions() {
  const r = await chrome.runtime.sendMessage({ type: 'get-sessions' });
  sessions = (r && r.sessions) || [];
  renderSessionList();
}

function renderSessionList(filter) {
  const list = $('session-list');
  list.innerHTML = '';
  const items = filter ? sessions.filter((s) => (s.title || '').toLowerCase().includes(filter)) : sessions;
  if (!items.length) { list.innerHTML = '<div class="empty" style="margin-top:20px">无会话</div>'; return; }
  for (const s of items) {
    const el = document.createElement('div');
    el.className = 'session-item' + (s.id === activeSessionId ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = s.title || t('opts.unnamed');
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = t('opts.del');
    del.onclick = async (e) => { e.stopPropagation(); await deleteSession(s.id); };
    el.appendChild(title);
    el.appendChild(del);
    el.onclick = () => openSession(s.id);
    list.appendChild(el);
  }
}

async function deleteSession(id) {
  const r = await chrome.runtime.sendMessage({ type: 'delete-session', id });
  sessions = (r && r.sessions) || [];
  if (activeSessionId === id) { activeSessionId = null; clearChat(); }
  renderSessionList();
}

async function openSession(id) {
  activeSessionId = id;
  hideAskUser();
  renderSessionList();
  const r = await chrome.runtime.sendMessage({ type: 'get-session', id });
  renderMessages((r && r.session && r.session.messages) || []);
  // 该会话若还有未完成的 ask_user 提问（agent 仍在等待），恢复选项卡片让用户继续回答
  const pr = await chrome.runtime.sendMessage({ type: 'get-pending-ask' });
  if (pr && pr.pending && pr.pending.sessionId === id) {
    showAskUser(pr.pending.question, pr.pending.args);
  }
}

// ---- 消息渲染 ----

function renderEmpty() {
  const box = $('messages');
  box.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  const logo = document.createElement('div');
  logo.className = 'empty-logo';
  logo.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>';
  wrap.appendChild(logo);

  const title = document.createElement('div');
  title.className = 'empty-title';
  title.textContent = t('panel.emptyTitle');
  wrap.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'empty-desc';
  desc.textContent = t('panel.empty');
  wrap.appendChild(desc);

  const sug = document.createElement('div');
  sug.className = 'suggestions';
  const icons = ['🔍', '🌐', '💻', '📊'];
  for (let n = 1; n <= 4; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'suggestion';
    const ic = document.createElement('span');
    ic.className = 'sug-icon';
    ic.textContent = icons[n - 1];
    const tx = document.createElement('span');
    tx.className = 'sug-text';
    tx.textContent = t('panel.sugg' + n);
    b.appendChild(ic);
    b.appendChild(tx);
    b.onclick = () => {
      const input = $('input');
      input.value = tx.textContent;
      input.focus();
      updateSendBtnState();
    };
    sug.appendChild(b);
  }
  wrap.appendChild(sug);
  box.appendChild(wrap);
}

function clearChat() {
  hideAskUser();
  renderEmpty();
  currentAssistantBody = null;
  currentBubble = null;
  currentTaskProcess = null;
  currentAnswer = null;
  currentToolItem = null;
  reasoningBuffer = '';
  toolCount = 0;
}

function renderMessages(messages) {
  const box = $('messages');
  box.innerHTML = '';
  if (messages.length === 0) { renderEmpty(); return; }
  for (const m of messages) {
    if (m.role === 'user') appendUserMessage(m.content);
    else if (m.role === 'assistant') appendAssistantMessage(m.content, false);
  }
  applyI18n();
  scrollBottom();
}

function appendUserMessage(text) {
  const box = $('messages');
  removeEmpty();
  const msg = document.createElement('div');
  msg.className = 'msg user';
  const body = document.createElement('div');
  body.className = 'msg-body';
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = t('panel.me');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(text);
  postProcess(bubble);
  body.appendChild(meta);
  body.appendChild(bubble);
  addMsgActions(body, text, false);
  msg.appendChild(body);
  box.appendChild(msg);
  scrollBottom();
}

function appendAssistantMessage(text, streaming) {
  const box = $('messages');
  removeEmpty();
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  const body = document.createElement('div');
  body.className = 'msg-body';
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = 'NanoHarness';
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (streaming ? ' streaming' : '');
  bubble.innerHTML = renderMarkdown(text);
  postProcess(bubble);
  body.appendChild(meta);
  body.appendChild(bubble);
  addMsgActions(body, text, true);
  msg.appendChild(body);
  box.appendChild(msg);
  currentBubble = bubble;
  assistantText = text;
  scrollBottom();
}

function removeEmpty() {
  const e = $('messages').querySelector('.empty, .empty-state');
  if (e) e.remove();
}

function scrollBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

// ---- 事件处理 ----

function handleEvent(ev) {
  switch (ev.type) {
    case 'reasoning-delta': {
      if (!currentTaskProcess) { currentTaskProcess = createTaskProcess(); toolCount = 0; }
      reasoningBuffer += ev.text;
      setTaskMeta(currentTaskProcess, t('panel.thinking'), true);
      scrollBottom();
      break;
    }
    case 'delta': {
      const target = ensureTextTarget();
      assistantText += ev.text;
      target.textContent = assistantText;
      target.appendChild(cursor());
      scrollBottom();
      break;
    }
    case 'interim-text-end': {
      // 中间轮文本（关键回复）：快照进时间线，清空准备下一轮
      if (assistantText.trim()) {
        if (currentAnswer) { currentAnswer.remove(); currentAnswer = null; }
        else if (currentBubble && !currentBubble.classList.contains('task')) { currentBubble.textContent = ''; }
        if (!currentTaskProcess) { currentTaskProcess = createTaskProcess(); toolCount = 0; }
        const node = document.createElement('div');
        node.className = 'interim-text';
        node.textContent = assistantText;
        currentTaskProcess.body.appendChild(node);
      }
      assistantText = '';
      break;
    }
    case 'tool-start': {
      if (!currentTaskProcess) { currentTaskProcess = createTaskProcess(); toolCount = 0; }
      toolCount++;
      currentToolItem = createToolItem(currentTaskProcess, ev.name, ev.args);
      flushReasoning(currentTaskProcess); // 思考渲染在工具下方
      setTaskMeta(currentTaskProcess, toolCount + ' ' + t('panel.toolsCount'), false);
      scrollBottom();
      break;
    }
    case 'tool-end': {
      if (currentToolItem) {
        currentToolItem.resEl.textContent = truncate(ev.result, 2000);
        currentToolItem.head.querySelector('.tool-status').textContent = '✓';
      }
      currentToolItem = null;
      break;
    }
    case 'ask-user': {
      showAskUser(ev.question, ev.args);
      break;
    }
    case 'ask-user-answered': {
      hideAskUser();
      break;
    }
    case 'done':
      if (currentTaskProcess && reasoningBuffer.trim()) flushReasoning(currentTaskProcess);
      finishTaskProcess();
      finishAssistant();
      break;
    case 'error':
      showErrorInCard(ev.error);
      break;
    case 'aborted':
      finishTaskProcess();
      finishAssistant('（已打断）');
      break;
    case 'max-iterations':
      finishTaskProcess();
      finishAssistant('（达到最大迭代次数，已停止）');
      break;
    case 'compacting':
      // 长对话自动压缩：在任务流程里显示轻提示
      if (!currentTaskProcess) { currentTaskProcess = createTaskProcess(); toolCount = 0; }
      setTaskMeta(currentTaskProcess, t('panel.compacting'), true);
      break;
    case 'turn-end':
      running = false;
      setSendState();
      refreshSessions();
      break;
  }
}

function ensureAssistantBody() {
  if (currentAssistantBody) return currentAssistantBody;
  const box = $('messages');
  removeEmpty();
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  const body = document.createElement('div');
  body.className = 'msg-body';
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = 'NanoHarness';
  body.appendChild(meta);
  msg.appendChild(body);
  box.appendChild(msg);
  currentAssistantBody = body;
  return body;
}

function createBubble(isTask) {
  const body = ensureAssistantBody();
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (isTask ? ' task' : '');
  body.appendChild(bubble);
  return bubble;
}

function createAnswer() {
  const answer = document.createElement('div');
  answer.className = 'task-answer';
  currentBubble.appendChild(answer);
  assistantText = '';
  return answer;
}

function ensureTextTarget() {
  if (currentAnswer) return currentAnswer;
  if (currentBubble && currentBubble.classList.contains('task')) {
    currentAnswer = createAnswer();
    return currentAnswer;
  }
  if (currentBubble) return currentBubble;
  currentBubble = createBubble(false);
  return currentBubble;
}

function cursor() {
  const c = document.createElement('span');
  c.className = 'cursor';
  return c;
}

function finishAssistant(note) {
  const target = currentAnswer || currentBubble;
  const final = assistantText;
  if (target) {
    target.querySelector('.cursor')?.remove();
    target.classList.remove('streaming');
    if (note) { target.textContent = final + note; }
    else if (final.trim()) { target.innerHTML = renderMarkdown(final); postProcess(target); }
    else { target.textContent = '(无回复)'; }
  }
  if (currentAssistantBody && final.trim()) {
    addMsgActions(currentAssistantBody, final, true);
  }
  currentAssistantBody = null;
  currentBubble = null;
  currentAnswer = null;
  assistantText = '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMarkdown(text) {
  try {
    if (window.marked) {
      const html = marked.parse(String(text ?? ''));
      return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
    }
  } catch (e) {}
  return esc(text).replace(/\n/g, '<br>');
}

// ---- 消息渲染后处理：mermaid 图表 + 文件路径链接化 ----
function postProcess(container) {
  if (!container) return;
  linkifyPaths(container);
  highlightCode(container);
  renderMermaid(container);
}

function highlightCode(container) {
  if (!window.hljs) return;
  container.querySelectorAll('pre code').forEach((code) => {
    if (code.classList.contains('language-mermaid')) return; // mermaid 交给 renderMermaid
    try { hljs.highlightElement(code); } catch (e) {}
  });
}

let mermaidSeq = 0;
async function renderMermaid(container) {
  if (!window.mermaid) return;
  const blocks = container.querySelectorAll('pre code.language-mermaid');
  for (const code of blocks) {
    const text = (code.textContent || '').trim();
    const pre = code.closest('pre');
    if (!pre || !text) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid';
    const id = 'mm-' + Date.now().toString(36) + '-' + (mermaidSeq++);
    try {
      const { svg } = await mermaid.render(id, text);
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch (e) { /* 渲染失败保留原代码块 */ }
  }
}

function linkifyPaths(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  const re = /(\/(?:[\w./~()@+-]+\/)+[\w./~()@+-]+|~\/[\w./~+-]+|[A-Za-z]:\\[\w.\\ +-]+)/g;
  for (const node of textNodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest('a, code, pre')) continue;
    const text = node.textContent || '';
    const matches = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) matches.push({ index: m.index, len: m[0].length, path: m[0] });
    if (!matches.length) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const mm of matches) {
      if (mm.index > last) frag.appendChild(document.createTextNode(text.slice(last, mm.index)));
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'path-link';
      a.dataset.path = mm.path;
      a.textContent = mm.path;
      a.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openPath(mm.path); });
      frag.appendChild(a);
      last = mm.index + mm.len;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
  }
}

function openPath(path) {
  if (path.startsWith('~/')) { showToast('无法展开 ~ 路径：' + path); return; }
  if (path.startsWith('./') || path.startsWith('../')) { showToast('相对路径无法直接打开：' + path); return; }
  const url = path.startsWith('/') ? 'file://' + path : path;
  chrome.tabs.create({ url }).catch(() => showToast('无法打开（需在扩展详情开启「允许访问文件网址」）：' + path));
}

const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const ICON_REGEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>';

function addMsgActions(body, text, isAssistant) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'msg-action';
  copy.title = t('panel.copyMd');
  copy.innerHTML = ICON_COPY;
  copy.onclick = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(text ?? ''));
      copy.classList.add('ok');
      copy.innerHTML = ICON_CHECK;
      setTimeout(() => { copy.classList.remove('ok'); copy.innerHTML = ICON_COPY; }, 1400);
    } catch {}
  };
  actions.appendChild(copy);
  if (isAssistant) {
    const regen = document.createElement('button');
    regen.type = 'button';
    regen.className = 'msg-action';
    regen.title = t('panel.regenerate');
    regen.innerHTML = ICON_REGEN;
    regen.onclick = (e) => { e.stopPropagation(); regenerate(); };
    actions.appendChild(regen);
  }
  body.appendChild(actions);
}

function createTaskProcess() {
  if (!currentBubble) currentBubble = createBubble(true);
  else if (!currentBubble.classList.contains('task')) currentBubble.classList.add('task');
  const proc = document.createElement('div');
  proc.className = 'task-process';
  const head = document.createElement('button');
  head.className = 'task-process-head';
  head.type = 'button';
  head.innerHTML = '<span class="chev">▸</span><span class="task-process-meta"><span class="meta-text"></span><span class="meta-dots hidden"><span>·</span><span>·</span><span>·</span></span></span>';
  const body = document.createElement('div');
  body.className = 'task-process-body';
  body.style.display = 'none';
  proc.appendChild(head);
  proc.appendChild(body);
  currentBubble.appendChild(proc);
  head.onclick = () => {
    const open = body.style.display === 'none';
    body.style.display = open ? 'block' : 'none';
    head.querySelector('.chev').textContent = open ? '▾' : '▸';
  };
  return {
    proc, head, body,
    meta: head.querySelector('.task-process-meta'),
    metaText: head.querySelector('.meta-text'),
    metaDots: head.querySelector('.meta-dots'),
  };
}

function flushReasoning(proc) {
  if (!reasoningBuffer.trim()) return;
  const node = document.createElement('div');
  node.className = 'reasoning-node';
  node.innerHTML = '<div class="reasoning-label">' + t('panel.reasoning') + '</div><div class="reasoning-body"></div>';
  node.querySelector('.reasoning-body').textContent = reasoningBuffer;
  proc.body.appendChild(node);
  reasoningBuffer = '';
}

function setTaskMeta(proc, text, busy) {
  if (!proc) return;
  proc.metaText.textContent = text || '';
  proc.metaDots.classList.toggle('hidden', !busy);
}

function createToolItem(proc, name, args) {
  const item = document.createElement('div');
  item.className = 'tool-item';
  const head = document.createElement('div');
  head.className = 'tool-item-head';
  head.innerHTML = '<span class="chevron">▸</span> <span class="tool-name">' + esc(name) + '</span> <span class="tool-status">⏳</span>';
  const body = document.createElement('div');
  body.className = 'tool-item-body';
  body.style.display = 'none';
  const argsEl = document.createElement('div');
  argsEl.className = 'tool-args';
  argsEl.textContent = truncate(JSON.stringify(args || {}), 500);
  const resEl = document.createElement('div');
  resEl.className = 'tool-result';
  resEl.textContent = '…';
  body.appendChild(argsEl);
  body.appendChild(resEl);
  item.appendChild(head);
  item.appendChild(body);
  proc.body.appendChild(item);
  head.onclick = () => {
    const open = body.style.display === 'none';
    body.style.display = open ? 'block' : 'none';
    head.querySelector('.chevron').textContent = open ? '▾' : '▸';
  };
  return { item, head, resEl };
}

function finishTaskProcess() {
  if (currentTaskProcess) {
    if (toolCount > 0) {
      setTaskMeta(currentTaskProcess, toolCount + ' ' + t('panel.toolsCount'), false);
    } else {
      // 只有思考、没有工具调用：把「思考中···」的动态点停掉，显示完成态
      setTaskMeta(currentTaskProcess, t('panel.reasoning'), false);
    }
  }
  currentTaskProcess = null;
  currentToolItem = null;
  reasoningBuffer = '';
  toolCount = 0;
}

function appendSystemNote(text) {
  const box = $('messages');
  const note = document.createElement('div');
  note.className = 'tool-card';
  note.style.color = 'var(--danger)';
  note.textContent = text;
  box.appendChild(note);
  scrollBottom();
}

// 模型断联 / 流中断等运行时错误 → 展示在机器人消息卡片内
function showErrorInCard(text) {
  finishTaskProcess();
  const target = currentAnswer || currentBubble;
  const final = assistantText;
  if (target) {
    target.querySelector('.cursor')?.remove();
    target.classList.remove('streaming');
    target.classList.add('error-text');
    target.textContent = (final ? final + '\n\n' : '') + '⚠️ ' + text;
  } else {
    const box = $('messages');
    removeEmpty();
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = 'NanoHarness';
    const bubble = document.createElement('div');
    bubble.className = 'bubble error-text';
    bubble.textContent = '⚠️ ' + text;
    body.appendChild(meta);
    body.appendChild(bubble);
    msg.appendChild(body);
    box.appendChild(msg);
    scrollBottom();
  }
  currentAssistantBody = null;
  currentBubble = null;
  currentAnswer = null;
  assistantText = '';
}

// 系统级报错 → 弹窗
function showAlert(title, body) {
  $('app-alert-title').textContent = title;
  $('app-alert-body').textContent = body;
  $('app-alert-dialog').classList.remove('hidden');
}

function closeAppAlert() {
  $('app-alert-dialog').classList.add('hidden');
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---- 发送 / 打断 ----

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || running) return;
  input.value = '';
  updateSendBtnState();
  appendUserMessage(text);

  running = true;
  setSendState();

  const r = await chrome.runtime.sendMessage({ type: 'run', sessionId: activeSessionId, text });
  if (r && r.ok) {
    if (!activeSessionId) { activeSessionId = r.sessionId; }
  } else if (r && r.error) {
    finishAssistant();
    showAlert(t('panel.errorTitle'), r.error);
    running = false;
    setSendState();
  }
}

function cancel() {
  chrome.runtime.sendMessage({ type: 'cancel' });
}

async function regenerate() {
  if (running || !activeSessionId) return;
  // 删除最后一条 assistant 消息 DOM，重置流式状态
  const msgs = $('messages').querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1];
  if (last) last.remove();
  currentAssistantBody = null;
  currentBubble = null;
  currentTaskProcess = null;
  currentAnswer = null;
  currentToolItem = null;
  reasoningBuffer = '';
  toolCount = 0;
  assistantText = '';
  running = true;
  setSendState();
  const r = await chrome.runtime.sendMessage({ type: 'regenerate', sessionId: activeSessionId });
  if (r && r.error) {
    running = false;
    setSendState();
    showAlert(t('panel.errorTitle'), r.error);
  }
}

function updateSendBtnState() {
  const hasText = $('input').value.trim().length > 0;
  $('btn-send').classList.toggle('has-input', hasText);
}

function setSendState() {
  const btn = $('btn-send');
  if (running) { btn.innerHTML = STOP_ICON; btn.title = t('panel.stop'); btn.classList.add('stop'); btn.onclick = cancel; }
  else { btn.innerHTML = SEND_ARROW; btn.title = t('panel.send'); btn.classList.remove('stop'); btn.onclick = send; }
  updateSendBtnState();
}

// ---- 事件绑定 ----

function bindEvents() {
  $('btn-send').onclick = send;
  $('btn-settings').onclick = () => chrome.runtime.openOptionsPage();
  let sidebarOpen = false;
  $('btn-sidebar').onclick = () => {
    sidebarOpen = !sidebarOpen;
    $('session-sidebar').classList.toggle('collapsed', !sidebarOpen);
    $('btn-sidebar').classList.toggle('active', sidebarOpen);
  };
  $('btn-new').onclick = () => {
    activeSessionId = null;
    renderSessionList();
    clearChat();
  };
  $('btn-clear').onclick = async () => {
    if (!activeSessionId) { clearChat(); return; }
    const r = await chrome.runtime.sendMessage({ type: 'clear-session', id: activeSessionId });
    if (r && r.ok) {
      sessions = r.sessions || [];
      clearChat();
      renderSessionList();
    }
  };
  $('session-search').oninput = (e) => renderSessionList(e.target.value.trim().toLowerCase());
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); send(); }
  });
  $('input').addEventListener('input', updateSendBtnState);

  // 拖拽调整输入框高度
  const resizeHandle = $('resize-handle');
  const inputEl = $('input');
  if (resizeHandle && inputEl) {
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = inputEl.offsetHeight;
      resizeHandle.classList.add('dragging');
      const onMove = (ev) => {
        const h = Math.min(320, Math.max(64, startH - (ev.clientY - startY)));
        inputEl.style.height = h + 'px';
      };
      const onUp = () => {
        resizeHandle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  $('btn-record').onclick = () => {
    if (recording) {
      chrome.runtime.sendMessage({ type: 'record-toggle' }); // 停止：由 record-result 打开弹窗
    } else {
      openRecordIntro(); // 先弹说明弹窗，用户点「开始」才真正开始录制
    }
  };
  $('record-intro-cancel').onclick = closeRecordIntro;
  $('record-intro-start').onclick = async () => {
    closeRecordIntro();
    const r = await chrome.runtime.sendMessage({ type: 'record-toggle' });
    if (r && r.ok) { recording = true; updateRecordBtn(); }
    else showRecordAlert(r && r.error ? r.error : t('panel.recordSaveFailed'));
  };
  $('record-alert-ok').onclick = closeRecordAlert;
  $('app-alert-ok').onclick = closeAppAlert;
  $('record-cancel').onclick = () => {
    closeRecordDialog();
    chrome.runtime.sendMessage({ type: 'record-cancel' });
  };
  $('record-ok').onclick = doSaveRecording;
  $('record-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doSaveRecording(); }
  });
  $('ask-send').onclick = sendAskReply;
  $('ask-cancel').onclick = askCancel;
  $('ask-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendAskReply(); }
  });
  $('ask-prev').onclick = askPrev;
  $('ask-next').onclick = askNext;

  // 配置检查提示
  chrome.runtime.sendMessage({ type: 'get-config' }).then((r) => {
    const c = r && r.config;
    if (c && (!c.llm.baseURL || !c.llm.apiKey || !c.llm.model)) appendSystemNote('⚠️ ' + t('panel.notConfigured'));
  });
}

function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.nh_theme) applyTheme(changes.nh_theme.newValue);
    if (changes.nh_lang) { LANG = changes.nh_lang.newValue === 'zh' ? 'zh' : 'en'; applyI18n(); if (!document.querySelector('.msg')) renderEmpty(); }
  });
}
