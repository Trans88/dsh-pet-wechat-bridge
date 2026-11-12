const $ = selector => document.querySelector(selector);
const token = $('meta[name="pet-token"]').content;
const titles = { home: '欢迎回到小窝', exploration: '今天，会发现什么呢', memory: '我们的小小记忆', channels: '连接你的日常', settings: '让它更像你的小伙伴' };
let state, scope = 'web:owner', page = 'home', attachment, pendingRequestId, sending = false, sleeping = false, toastTimer, lastUpdate = 0;
let historyRevision = 0, memoryRevision = 0;
let explorationRevision = 0, lastReadPosted = 0, stateLoading = false;
let qqAction = '', qqActionError = '', qqStateError = '';
let balanceRevision = 0, balanceController;
let voiceUI = { phase: 'idle', active: false, mode: null };
let previewVoice;
let patTimer, petting = false;
let interactionBusy = false, interactionTimer, careState, effectAction;
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const avatar = new window.PetAvatar({ character: $('#pet-character'), sprite: $('#pet-sprite'), sheet: $('#pet-sprite-sheet'), cat: $('#pet-cat'),
  onError: () => toast('桃铃狐图片未能加载，暂时显示蓝猫。请刷新页面重试。') });
function renderAvatar(force = false) {
  $('#pet-character').classList.toggle('speaking', voiceUI.phase === 'speaking');
  avatar.render({ appearance: state?.config.pet.appearance || 'taolinghu',
    animation: sending ? 'thinking' : sleeping ? 'sleeping' : petting ? 'petting' : 'idle',
    playing: page === 'home' && !document.hidden && !reducedMotion?.matches }, force);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { voice.stop(); previewVoice?.stop(); } renderAvatar(); if (!document.hidden && state) loadState().catch(() => {}); });
reducedMotion?.addEventListener('change', () => renderAvatar());
window.addEventListener('pagehide', () => { voice.stop(); previewVoice?.stop(); avatar.stop(); clearTimeout(patTimer); clearTimeout(interactionTimer); interactionBusy = false; petting = false; clearPetEffect(); interactionControls(); });
window.addEventListener('pageshow', () => renderAvatar(true));
renderAvatar();

async function api(path, data, binary = false, signal) {
  const response = await fetch(path, { signal, mode: 'same-origin', credentials: 'omit', method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `请求失败（${response.status}）`);
  }
  return binary ? response.blob() : response.json();
}
async function localApi(path, data) {
  // These local control/status requests should finish quickly. Keep model and
  // voice requests on their existing cancellation/timeout paths.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try { return await api(path, data, false, controller.signal); }
  catch (error) {
    if (controller.signal.aborted) throw new Error('本地宠物服务超过 12 秒未响应。请检查启动终端是否仍在运行，再点击「刷新状态」。');
    throw error;
  } finally { clearTimeout(timer); }
}
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function chatError(text) { $('#chat-error').textContent = text || ''; $('#chat-error').hidden = !text; }
function showPage(next) {
  voice.stop(); previewVoice?.stop();
  page = next;
  renderAvatar();
  document.querySelectorAll('.page').forEach(node => { node.hidden = node.id !== `page-${next}`; });
  document.querySelectorAll('.nav').forEach(node => node.classList.toggle('active', node.dataset.page === next));
  $('#page-title').textContent = titles[next];
  // Desktop deep links can arrive before /api/state. Select the page now,
  // but defer reads that need pet/config/session data until initialization.
  if (!state) return;
  if (next === 'memory') renderMemories().catch(e => toast(e.message));
  if (next === 'home') refreshHistory().catch(e => chatError(e.message));
  if (next === 'exploration') refreshExploration().catch(e => toast(e.message));
  if (next === 'settings') refreshBalance();
}
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.go)));
$('#date-label').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) + ' · LITTLE PET';

async function loadState(initial = false) {
  const previousModel = JSON.stringify(state?.config.model);
  try { state = await localApi('/api/state'); qqStateError = ''; }
  catch (error) { qqStateError = `暂时无法读取 QQ 状态：${error.message}`; renderQQ(); throw error; }
  if (previousModel !== JSON.stringify(state.config.model)) resetBalance();
  renderCare(state.care);
  renderAvatar();
  $('#pet-name').textContent = state.config.pet.name;
  $('#pet-greeting').textContent = state.config.pet.greeting;
  const unread = state.exploration?.unread || 0;
  document.title = `${unread ? `(${unread}) ` : ''}${state.config.pet.name} · 你的 AI 宠物`;
  $('#home-unread').textContent = String(unread); $('#home-unread').hidden = !unread;
  renderExplorationStatus(state.exploration);
  const needsKey = !state.config.model.hasKey && new URL(state.config.model.baseUrl).hostname === 'api.deepseek.com';
  $('#model-status').textContent = needsKey ? '等待配置模型' : state.config.model.model;
  $('#setup-note').hidden = !needsKey;
  const channelLabels = { stopped: '未连接', starting: '正在连接 / 等待扫码', connected: '已连接', error: '连接失败，请查看终端' };
  $('#wechat-status').textContent = channelLabels[state.wechat.state] || '未连接';
  $('#wechat-start').disabled = $('#wechat-login').disabled = ['starting', 'connected'].includes(state.wechat.state);
  $('#wechat-stop').disabled = !['starting', 'connected'].includes(state.wechat.state);
  renderQQ();
  renderVoice();
  const memoryScope = $('#memory-scope').value;
  $('#memory-scope').replaceChildren();
  const sessions = [{ scope: 'web:owner', label: '网页 · 主人' }, ...state.sessions.filter(s => s.scope !== 'web:owner')];
  for (const session of sessions) { const option = el('option', '', session.label); option.value = session.scope; $('#memory-scope').append(option); }
  if (sessions.some(s => s.scope === memoryScope)) $('#memory-scope').value = memoryScope;
  const updated = state.sessions.find(s => s.scope === scope)?.updated || 0;
  if (initial || (!sending && updated !== lastUpdate && page === 'home')) { lastUpdate = updated; await refreshHistory(); }
  if (initial) { fillSettings(); fillExploration(); fillQQ(); }
  if (page === 'exploration') await refreshExploration();
}

async function refreshHistory() {
  if (!state) return;
  const revision = ++historyRevision, requestedScope = scope;
  const result = await api(`/api/history?scope=${encodeURIComponent(requestedScope)}`);
  if (revision !== historyRevision || requestedScope !== scope) return;
  const box = $('#messages'); const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  box.replaceChildren();
  if (!result.messages.length) {
    const empty = el('div', 'empty-chat'); empty.append(el('div', 'empty-icon', '✧'), el('p', '', scope === 'web:owner' ? state.config.pet.greeting : '这个会话还没有聊天记录'), el('small', '', scope === 'web:owner' ? '一个想法、一张照片，或一句你好。' : '消息成功回复后，会出现在这里。'));
    if (scope === 'web:owner') {
      const prompts = el('div', 'quick-prompts');
      for (const text of ['介绍一下自己吧', '今天有点累', '聊点开心的']) { const b = el('button', '', text); b.addEventListener('click', () => { pendingRequestId = undefined; $('#message-input').value = text; $('#message-input').focus(); }); prompts.append(b); }
      empty.append(prompts);
    }
    box.append(empty);
  }
  for (const msg of result.messages) {
    const item = el('div', `message ${msg.role}`), bubble = el('div', 'message-body');
    item.dataset.id = msg.id;
    item.append(el('div', 'message-label', msg.role === 'user' ? '你' : state.config.pet.name + (msg.origin === 'exploration' ? ' · 主动分享' : '')));
    if (msg.image) { const img = el('img'); img.src = `data:${msg.image.mediaType};base64,${msg.image.data}`; img.alt = '发送的图片'; bubble.append(img); }
    bubble.append(document.createTextNode(msg.text)); item.append(bubble);
    const sticker = msg.role === 'assistant' && state.stickers?.find(s => s.id === msg.sticker);
    if (sticker) {
      const img = el('img', 'reply-sticker'); img.src = sticker.url; img.alt = `表情包：${sticker.label}`;
      img.loading = 'lazy'; item.append(img);
    }
    if (msg.sources?.length) {
      const sources = el('div', 'message-sources');
      for (const source of msg.sources) { const a = sourceLink(source); if (a) sources.append(a); }
      item.append(sources);
    }
    if (msg.role === 'assistant') {
      const speak = el('button', 'read-aloud', '♩ 朗读'); speak.addEventListener('click', async () => {
        if (sending || voiceUI.active || ['requesting', 'listening', 'transcribing'].includes(voiceUI.phase)) return toast('请先结束当前语音对话或录音。');
        try { await voice.speak(msg.text); } catch (e) { toast(e.message); }
      }); item.append(speak);
    }
    box.append(item);
  }
  if (atEnd || sending) box.scrollTop = box.scrollHeight;
  const readOnly = scope !== 'web:owner';
  $('#session-caption').textContent = readOnly ? `${state.sessions.find(s => s.scope === scope)?.label || '通道会话'}（只读）` : '网页 · 主人';
  $('#chat-form').hidden = readOnly;
  $('#voice-bar').hidden = readOnly && voiceUI.phase === 'idle';
  $('#voice-chat-button').hidden = readOnly;
  if (readOnly) {
    const back = el('button', 'text-button', '返回网页聊天 →'); back.addEventListener('click', () => { scope = 'web:owner'; refreshHistory().catch(e => toast(e.message)); }); box.prepend(back);
  }
  if (!readOnly && page === 'home' && !document.hidden) {
    const newest = result.messages.at(-1);
    if (newest?.origin === 'exploration' && !sending && !sleeping) {
      $('#pet-bubble').textContent = newest.text.slice(0,65) + (newest.text.length > 65 ? '…' : '');
      $('#pet-mood').textContent = '带着新发现回来啦';
    }
    if (state.exploration && newest?.id > lastReadPosted) {
      await api('/api/exploration/read', { lastId: newest.id }); lastReadPosted = newest.id;
      $('#home-unread').hidden = true; document.title = `${state.config.pet.name} · 你的 AI 宠物`;
    }
  }
}

function sourceLink(source) {
  let url;
  try { url = new URL(source.url); } catch { return null; }
  if (url.origin !== 'https://www.xiaohongshu.com' || url.username || url.password || !/^\/explore\/[a-f0-9]{24}\/?$/i.test(url.pathname)) return null;
  const a = el('a', 'source-link', `${source.title || '查看小红书原文'}${evidenceLabel(source.evidence) ? ' · ' + evidenceLabel(source.evidence) : ''} ↗`);
  a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function evidenceLabel(value) {
  if (!value) return '';
  const parts = [];
  if (value.imageCount > 0) parts.push(`看图 ${value.imageCount} 张`);
  if (value.frameTimes?.length) parts.push(`视频抽帧 ${value.frameTimes.length} 张（${value.frameTimes.join(' / ')} 秒）`);
  if (value.audioRange) parts.push(`音频转写 ${value.audioRange.start}–${value.audioRange.end} 秒`);
  return parts.join(' · ');
}

const browserLabels = { 'not-connected': '尚未登录', unverified: '登录待检查', 'awaiting-login': '等待扫码 / 验证', ready: '已登录', 'login-required': '需要登录', 'verification-required': '需要安全验证', 'browser-unavailable': '浏览器未就绪', 'layout-changed': '页面需要检查', 'browse-error': '页面加载失败', 'dialog-required': '网页等待确认' };
function renderExplorationStatus(s) {
  if (!s) return;
  const e = state.config.exploration;
  $('#exploration-status').textContent = s.busy ? '正在探索' : s.blocked ? '已暂停，等待处理' : !s.enabled ? '自动探索已关闭' : s.quiet ? '免打扰中' : '自动探索已开启';
  $('#exploration-count').textContent = `${s.sentToday} / ${e.dailyLimit}`;
  const format = timestamp => new Date(timestamp).toLocaleString('zh-CN', { timeZone: e.timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('#exploration-next').textContent = s.blocked ? '请查看连接状态和最近动态；完成登录或验证后，可直接点「现在去逛逛」。' : s.enabled ? (s.nextRunAt ? `下次检查 ${format(s.nextRunAt)} · ${e.timeZone}` : '即将检查探索条件') : '你也可以点「现在去逛逛」尝试一轮。';
  $('#xhs-status').textContent = browserLabels[s.browser?.state] || '登录待检查';
  $('#xhs-message').textContent = s.browser?.message || '登录状态保存在独立浏览器中；扫码后会自动识别，也可直接开始探索。';
  $('#exploration-run').disabled = s.busy || Boolean(s.browser?.busy);
  $('#xhs-verify').disabled = s.busy || Boolean(s.browser?.busy);
  $('#xhs-dialog').hidden = !s.browser?.dialog;
  $('#xhs-dialog-message').textContent = s.browser?.dialog?.message || '';
  const canSee = state.config.vision.enabled || state.config.model.supportsImages;
  $('#exploration-media-status').textContent = !canSee ? '图片和视频画面需要在设置中启用支持图片的模型。' :
    state.config.stt.enabled ? '视觉分析与音频转写服务已配置；勾选下面的能力后保存。' : '图片和视频画面可使用当前视觉模型；视频音频转写还需配置 STT。';
}
function fillExploration() {
  const e = state.config.exploration; if (!e) return;
  for (const input of $('#exploration-form').elements) {
    if (!input.name) continue;
    if (input.type === 'checkbox') input.checked = Boolean(e[input.name]);
    else if (input.name === 'interests') input.value = e.interests.join('、');
    else {
      if (input.name === 'intervalMinutes' && ![...input.options].some(o => o.value === String(e.intervalMinutes))) { const option = el('option', '', `每 ${e.intervalMinutes} 分钟`); option.value = e.intervalMinutes; input.append(option); }
      input.value = e[input.name];
    }
  }
}
async function refreshExploration() {
  if (!state?.exploration) return;
  const revision = ++explorationRevision;
  const data = await api('/api/exploration');
  if (revision !== explorationRevision) return;
  renderExplorationStatus(data.status);
  const events = $('#exploration-events');
  const eventKey = data.events.map(e => e.id).join(',');
  if (events.dataset.key !== eventKey || !events.childNodes.length) {
    events.dataset.key = eventKey; events.replaceChildren();
    if (!data.events.length) events.append(el('p', 'muted', '还没有出发。完成登录后，让它去看看吧。'));
    for (const entry of data.events.slice(0,10)) {
      const row = el('div', `exploration-event ${entry.kind}`);
      row.append(el('time', '', new Date(entry.created).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })), el('p', '', entry.detail)); events.append(row);
    }
  }
  const list = $('#exploration-notes'), key = data.notes.map(n => `${n.id}:${n.shared}:${n.reviewed}`).join(',');
  if (list.dataset.key !== key || !list.childNodes.length) {
    list.dataset.key = key; list.replaceChildren();
    if (!data.notes.length) list.append(el('div', 'discovery-empty', '第一份小小发现，还在路上。'));
    for (const note of data.notes) {
      const card = el('article', 'discovery-card'), link = sourceLink(note); if (link) card.append(link);
      card.append(el('small', '', `${note.topic} · ${note.author || '小红书笔记'}${note.shared ? ' · 已分享' : ''}`));
      const evidence = evidenceLabel(note.observation);
      if (evidence) card.append(el('p', 'muted', evidence));
      const details = el('details'), summary = el('summary', '', '阅读与观察记录'); details.append(summary);
      if (note.excerpt) details.append(el('p', '', `正文：${note.excerpt}`));
      if (note.observation?.summary) details.append(el('p', '', `画面观察：${note.observation.summary}`));
      if (note.observation?.transcript) details.append(el('p', '', `音频片段转写：${note.observation.transcript}`));
      if (note.observation?.warnings?.length) details.append(el('p', 'muted', note.observation.warnings.join('；')));
      card.append(details); list.append(card);
    }
  }
}
$('#exploration-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter, exploration = {}; button.disabled = true; $('#exploration-result').textContent = '';
  for (const input of event.currentTarget.elements) {
    if (!input.name) continue;
    exploration[input.name] = input.type === 'checkbox' ? input.checked : ['dailyLimit', 'intervalMinutes'].includes(input.name) ? Number(input.value) : input.value;
  }
  exploration.interests = exploration.interests.split(/[,，、\n]+/).map(s => s.trim()).filter(Boolean);
  try { await api('/api/config', { exploration }); await loadState(); fillExploration(); $('#exploration-result').textContent = '已保存'; }
  catch (e) { toast(e.message); } finally { button.disabled = false; }
});
for (const [id, action] of [['xhs-login', 'login'], ['xhs-verify', 'verify'], ['xhs-logout', 'logout'], ['xhs-switch', 'switch-account'], ['exploration-run', 'run'], ['exploration-stop', 'stop']]) {
  $(`#${id}`).addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const result = await api(`/api/exploration/${action}`, {});
      if (result.message) toast(result.message);
      if (action === 'stop') toast('本轮已停止，自动探索已关闭。');
      await loadState(); if (['stop', 'logout', 'switch-account'].includes(action)) fillExploration();
    } catch (e) { toast(e.message); } finally { button.disabled = false; }
  });
}
for (const [id, accept] of [['xhs-dialog-accept', true], ['xhs-dialog-dismiss', false]]) {
  $(`#${id}`).addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await api('/api/exploration/dialog', { accept }); await loadState(); }
    catch (e) { toast(e.message); } finally { button.disabled = false; }
  });
}
$('#exploration-clear').addEventListener('click', () => $('#exploration-clear-dialog').showModal());
$('#exploration-clear-cancel').addEventListener('click', () => $('#exploration-clear-dialog').close());
$('#exploration-clear-confirm').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try { await api('/api/exploration/clear', {}); $('#exploration-clear-dialog').close(); await loadState(); }
  catch (e) { toast(e.message); } finally { button.disabled = false; }
});

function renderVoice() {
  const { phase, active, mode } = voiceUI;
  $('#voice-bar').hidden = scope !== 'web:owner' && phase === 'idle';
  $('#voice-chat-button').hidden = scope !== 'web:owner';
  const listening = phase === 'listening';
  const captureBusy = ['requesting', 'listening', 'transcribing'].includes(phase);
  const locked = sending || active || captureBusy;
  for (const id of ['send-button', 'image-button', 'message-input', 'clear-chat', 'remove-image']) $(`#${id}`).disabled = locked;
  $('#voice-button').disabled = sending || active || ['requesting', 'transcribing'].includes(phase);
  $('#voice-button').classList.toggle('recording', listening);
  $('#voice-button').setAttribute('aria-pressed', String(listening));
  $('#voice-chat-button').disabled = !active && (sending || captureBusy || !state);
  $('#voice-chat-button').textContent = active ? '■ 结束语音对话' : '♩ 开始语音对话';
  $('#voice-chat-button').setAttribute('aria-pressed', String(active));
  $('#voice-finish-button').hidden = !listening;
  $('#voice-interrupt-button').hidden = !(active && phase === 'speaking');
  $('#voice-stop-button').hidden = !(!active && phase !== 'idle');
  $('#voice-stop-button').textContent = phase === 'speaking' ? '停止朗读' : '取消录音';
  const labels = { idle: '说说今天的小事，让它用声音陪你。', requesting: '正在打开麦克风…', listening: '正在听你说，停顿后自动结束，也可点击「说完了」。', transcribing: '正在把声音变成文字…', thinking: '听到了，让我想一想…', speaking: '宠物正在说话…' };
  $('#voice-status').textContent = labels[phase] || labels.idle;
  if (listening && mode === 'dictation') $('#voice-status').textContent = '正在录音，再点一次话筒结束；识别后可编辑发送。';
  $('#voice-bar').dataset.phase = phase;
  $('#voice-transcript').textContent = voiceUI.text || '';
  $('#voice-transcript').hidden = !voiceUI.text;
  $('#input-hint').textContent = active ? '语音对话中 · 可随时结束' : captureBusy ? '正在使用麦克风' : 'Enter 发送 · Shift + Enter 换行';
  $('.room').classList.toggle('busy', sending);
  $('#pet-mood').textContent = phase === 'listening' ? '竖起耳朵听你说' : phase === 'speaking' ? '有话想对你说' : sending ? '正在认真想' : sleeping ? '打个小盹' : careState?.moodLabel || '在这里陪你';
  $('#pet-bubble').textContent = phase === 'listening' ? '我在听呢，你说。' : phase === 'speaking' ? '轮到我啦～' : sending ? '让我想一想…' : '今天也很高兴见到你。';
  $('#send-button').textContent = sending ? '…' : '↑';
  renderAvatar();
}
function setBusy(busy) { sending = busy; interactionControls(); renderVoice(); }
async function sendMessage(text, { signal, fromVoice = false } = {}) {
  if (sending) throw new Error('正在回复上一条消息，请稍等。');
  chatError(''); setBusy(true);
  try {
    pendingRequestId ||= crypto.randomUUID();
    const result = await api('/api/chat', { scope: 'web:owner', text, attachment: fromVoice ? undefined : attachment, requestId: pendingRequestId }, false, signal);
    $('#message-input').value = ''; clearImage();
    await refreshHistory();
    return result.text;
  } catch (e) {
    if (e.name !== 'AbortError') chatError(e.message);
    throw e;
  } finally { setBusy(false); }
}
const voice = new window.PetVoice({
  api, getConfig: () => state?.config || {},
  onState: next => { voiceUI = next; renderVoice(); },
  onError: error => { toast(error.message || String(error)); },
  onTranscript: async (text, { mode, signal }) => {
    pendingRequestId = undefined;
    if (mode === 'dictation') {
      const input = $('#message-input');
      input.value = [input.value.trim(), text].filter(Boolean).join(' ').slice(0, 8000);
      input.focus(); return;
    }
    $('#message-input').value = text;
    return sendMessage(text, { signal, fromVoice: true });
  },
});
$('#voice-chat-button').addEventListener('click', () => {
  if (voiceUI.active) { voice.stop(); return; }
  if (sending || !state || page !== 'home' || scope !== 'web:owner') return;
  if ($('#message-input').value.trim() || attachment) return toast('请先发送或清空输入框和图片，再开始语音对话。');
  chatError(''); voice.startConversation();
});
$('#voice-button').addEventListener('click', () => { if (state && !sending && !voiceUI.active) voice.toggleDictation(); });
$('#voice-finish-button').addEventListener('click', () => voice.finishListening());
$('#voice-interrupt-button').addEventListener('click', () => voice.interrupt());
$('#voice-stop-button').addEventListener('click', () => voice.stop());
$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault(); if (sending || voiceUI.active || ['requesting', 'listening', 'transcribing'].includes(voiceUI.phase)) return;
  const text = $('#message-input').value.trim(); if (!text && !attachment) return;
  voice.stop();
  try {
    const reply = await sendMessage(text);
    if (state.config.voice?.autoSpeak && page === 'home' && !document.hidden) await voice.speak(reply);
  } catch (e) { if (e.name !== 'AbortError') chatError(e.message); }
  finally { if (!voiceUI.active) $('#message-input').focus(); }
});
$('#message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); } });
$('#message-input').addEventListener('input', () => { pendingRequestId = undefined; });
$('#image-button').addEventListener('click', () => $('#image-input').click());
function dataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }); }
$('#image-input').addEventListener('change', async () => {
  const file = $('#image-input').files[0]; if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MiB，请压缩后重试。');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('请选择 JPG、PNG、GIF 或 WebP 图片。');
    const url = await dataUrl(file); pendingRequestId = undefined; attachment = { mediaType: file.type, data: url.split(',')[1] };
    $('#attachment-image').src = url; $('#attachment-preview').hidden = false;
  } catch (e) { toast(e.message); } finally { $('#image-input').value = ''; }
});
function clearImage() { pendingRequestId = undefined; attachment = undefined; $('#attachment-preview').hidden = true; $('#attachment-image').removeAttribute('src'); }
$('#remove-image').addEventListener('click', clearImage);


function interactionControls() {
  document.querySelectorAll('[data-interaction], #pet-character').forEach(button => { button.disabled = interactionBusy || sending; });
}
function renderCare(care) {
  if (!care || (careState && care.lastActionAt < careState.lastActionAt)) return;
  careState = care; sleeping = care.sleeping;
  $('#pet-character').classList.toggle('sleeping', sleeping);
  $('#sleep-button').textContent = sleeping ? '☀ 醒来啦' : '☾ 打个盹';
  for (const key of ['mood', 'fullness', 'energy']) { $(`#${key}-value`).textContent = care[key]; $(`#${key}-meter`).value = care[key]; }
  $('#bond-label').textContent = care.bondLabel; $('#bond-value').textContent = care.bond;
  if (!sending) $('#pet-mood').textContent = care.moodLabel;
  const journal = $('#care-journal'); journal.replaceChildren();
  for (const item of care.journal.slice(0, 5)) journal.append(el('li', '', `${new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${item.label} · ${item.text}`));
  if (!care.journal.length) journal.append(el('li', '', '摸摸头，留下今天的第一件小事。'));
  renderAvatar();
}
function clearPetEffect() {
  delete $('#pet-character').dataset.interaction;
  $('#pet-character').classList.remove('patted');
  $('#pet-effects').replaceChildren(); effectAction = undefined;
}
function showPetEffect(action) {
  clearTimeout(patTimer); clearPetEffect(); effectAction = action;
  const symbols = { pat: '♡', feed: '🍪', hug: '💗', play: '🧶', dance: '♫', sleep: 'z', wake: '☀' };
  $('#pet-character').dataset.interaction = action;
  petting = !['sleep', 'wake'].includes(action);
  for (let i = 0; i < 5; i++) {
    const symbol = el('span', 'pet-particle', symbols[action]);
    symbol.style.setProperty('--i', i); $('#pet-effects').append(symbol);
  }
  renderAvatar(true);
  patTimer = setTimeout(() => { petting = false; clearPetEffect(); renderAvatar(); }, 2200);
}
async function interact(action) {
  if (interactionBusy || sending) return;
  if (action === 'sleep') voice.stop();
  interactionBusy = true; interactionControls();
  try {
    const result = await api('/api/pet/interact', { action, requestId: crypto.randomUUID() });
    renderCare(result.care); $('#pet-bubble').textContent = result.text;
    if (result.applied) { showPetEffect(action); avatar.play(action); }
    else avatar.cancel();
  } catch (e) { toast(e.message); }
  finally { interactionTimer = setTimeout(() => { interactionBusy = false; interactionControls(); }, 1250); }
}
$('#pet-character').addEventListener('click', () => interact('pat'));
document.querySelectorAll('[data-interaction]').forEach(button => button.addEventListener('click', () => interact(button.dataset.interaction === 'sleep' && sleeping ? 'wake' : button.dataset.interaction)));

$('#clear-chat').addEventListener('click', () => $('#confirm-dialog').showModal());
$('#cancel-clear').addEventListener('click', () => $('#confirm-dialog').close());
$('#confirm-clear').addEventListener('click', async () => {
  try { await api('/api/history/clear', { scope }); $('#confirm-dialog').close(); await refreshHistory(); }
  catch (e) { toast(e.message); }
});

async function renderMemories() {
  const revision = ++memoryRevision, requestedScope = $('#memory-scope').value;
  const result = await api(`/api/history?scope=${encodeURIComponent(requestedScope)}`);
  if (revision !== memoryRevision || requestedScope !== $('#memory-scope').value) return;
  const list = $('#memory-list'); list.replaceChildren();
  if (!result.memories.length) list.append(el('p', 'muted', '这里还是空的。把重要的小事留下来吧。'));
  for (const memory of result.memories) {
    const row = el('div', 'memory-item'), content = el('div'), remove = el('button', '', '忘记');
    content.append(el('p', '', memory.text), el('small', '', new Date(memory.created).toLocaleDateString()));
    remove.addEventListener('click', async () => { try { await api('/api/memory/delete', { scope: $('#memory-scope').value, id: memory.id }); await renderMemories(); } catch (e) { toast(e.message); } });
    row.append(content, remove); list.append(row);
  }
}
$('#memory-scope').addEventListener('change', () => renderMemories().catch(e => toast(e.message)));
$('#memory-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { await api('/api/memory/add', { scope: $('#memory-scope').value, text: $('#memory-input').value }); $('#memory-input').value = ''; await renderMemories(); }
  catch (e) { toast(e.message); } finally { button.disabled = false; }
});
$('#view-session').addEventListener('click', () => { voice.stop(); scope = $('#memory-scope').value; showPage('home'); });

for (const [kind, label] of [['vision', '独立图片模型'], ['stt', '语音识别 STT'], ['tts', '语音合成 TTS']]) {
  const block = el('details', 'provider-block'); block.append(el('summary', '', label));
  const form = el('div', 'form-grid'), enabled = el('label', 'check full'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.name = `${kind}.enabled`; enabled.append(checkbox, document.createTextNode('启用' + label)); form.append(enabled);
  for (const [key, title] of [['baseUrl', 'Base URL'], ['model', '模型名称'], ['apiKey', 'API Key'], ...(kind === 'tts' ? [['voice', '音色名称']] : [])]) {
    const label = el('label', 'field', title), input = el('input'); input.name = `${kind}.${key}`; input.type = key === 'apiKey' ? 'password' : 'text'; if (key === 'apiKey') input.autocomplete = 'new-password'; label.append(input); form.append(label);
  }
  block.append(form); $('#optional-providers').append(block);
}
function fillBrowserVoices(selected = $('#browser-voice').value) {
  const select = $('#browser-voice');
  select.replaceChildren();
  const automatic = el('option', '', '跟随对话语言'); automatic.value = ''; select.append(automatic);
  for (const item of window.speechSynthesis?.getVoices() || []) {
    const option = el('option', '', `${item.name} · ${item.lang}`); option.value = item.voiceURI || item.name; select.append(option);
  }
  if (selected && !Array.from(select.options).some(option => option.value === selected)) {
    const unavailable = el('option', '', `${selected}（此设备暂不可用，将使用默认音色）`); unavailable.value = selected; select.append(unavailable);
  }
  select.value = selected;
}
window.speechSynthesis?.addEventListener('voiceschanged', () => fillBrowserVoices());
$('#voice-preview-button').addEventListener('click', async () => {
  if (!state) return;
  const button = $('#voice-preview-button');
  if (previewVoice?.phase === 'speaking') { previewVoice.stop(); return; }
  const config = structuredClone(state.config);
  for (const input of $('#settings-form').elements) {
    const [kind, key] = (input.name || '').split('.');
    if (kind !== 'voice') continue;
    config.voice[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' || input.hasAttribute('data-number') ? Number(input.value) : input.value;
  }
  previewVoice?.stop();
  previewVoice = new window.PetVoice({ api, getConfig: () => config, onState: next => { button.textContent = next.phase === 'speaking' ? '停止试听' : '试听当前声音'; }, onError: e => toast(e.message || String(e)) });
  try { await previewVoice.speak(`你好，我是${state.config.pet.name}。很高兴用声音陪你聊天。`); }
  catch (e) { toast(e.message); }
});
function balanceUnavailable() {
  if (!state) return '正在读取模型配置…';
  const model = state.config.model;
  if ($('[name="model.baseUrl"]').value.trim() !== model.baseUrl || $('[name="model.apiKey"]').value.trim()) return '模型配置尚未保存，请先保存设置，再查询余额。';
  const url = new URL(model.baseUrl);
  if (url.origin !== 'https://api.deepseek.com' || !/^\/(?:v1\/?|)?$/.test(url.pathname)) return '当前服务暂不支持余额查询，仅支持 DeepSeek 官方 API。';
  return model.hasKey ? '' : '请先填写并保存 DeepSeek API Key。';
}
function resetBalance() {
  balanceRevision++;
  balanceController?.abort(); balanceController = undefined;
  $('#balance-card').setAttribute('aria-busy', 'false');
  $('#balance-details').replaceChildren();
  $('#balance-notice').hidden = true;
  const reason = balanceUnavailable();
  $('#balance-result').textContent = reason || '尚未查询，点击「查询余额」查看当前账户余额。';
  $('#balance-refresh').disabled = Boolean(reason);
  $('#balance-refresh').textContent = '查询余额';
}
async function refreshBalance() {
  if (balanceController) return;
  const reason = balanceUnavailable();
  if (reason) { resetBalance(); return; }
  const revision = ++balanceRevision, controller = new AbortController();
  balanceController = controller;
  const timer = setTimeout(() => controller.abort(), 15000);
  $('#balance-refresh').disabled = true;
  $('#balance-refresh').textContent = '查询中…';
  $('#balance-card').setAttribute('aria-busy', 'true');
  $('#balance-details').replaceChildren(); $('#balance-notice').hidden = true;
  $('#balance-result').textContent = '正在查询 DeepSeek 账户余额…';
  try {
    const result = await api('/api/model/balance', undefined, false, controller.signal);
    if (revision !== balanceRevision) return;
    for (const info of result.balances) {
      const row = el('div', 'balance-currency');
      row.append(el('span', 'balance-label', info.currency === 'CNY' ? '人民币可用余额 · CNY' : '美元可用余额 · USD'));
      row.append(el('strong', 'balance-total', `${info.currency === 'CNY' ? '¥' : '$'} ${info.total}`));
      row.append(el('p', 'balance-breakdown', `充值余额 ${info.toppedUp} · 赠送余额 ${info.granted}`));
      $('#balance-details').append(row);
    }
    $('#balance-result').textContent = `查询于 ${new Date(result.checkedAt).toLocaleString('zh-CN', { hour12: false })} · ${result.isAvailable ? '账户可用' : '账户余额不足'}`;
    $('#balance-notice').textContent = result.notice;
    $('#balance-notice').hidden = !result.notice;
  } catch (error) {
    if (revision === balanceRevision) $('#balance-result').textContent = controller.signal.aborted ? '余额查询超时，请重试。' : error.message;
  } finally {
    clearTimeout(timer);
    if (revision === balanceRevision) {
      balanceController = undefined;
      $('#balance-card').setAttribute('aria-busy', 'false');
      $('#balance-refresh').disabled = false;
      $('#balance-refresh').textContent = '刷新余额';
    }
  }
}
$('#balance-refresh').addEventListener('click', refreshBalance);
for (const name of ['model.baseUrl', 'model.apiKey']) $('[name="' + name + '"]').addEventListener('input', resetBalance);
window.addEventListener('pagehide', resetBalance);

function fillSettings() {
  fillBrowserVoices(state.config.voice?.browserVoice || '');
  for (const input of $('#settings-form').elements) {
    if (!input.name) continue;
    const [kind, key] = input.name.split('.'); const value = key ? state.config[kind]?.[key] : state.config[kind];
    if (key === 'apiKey') { input.value = ''; input.placeholder = state.config[kind].keyFromEnvironment ? '正在使用环境变量；清空或替换需要修改环境变量' : state.config[kind].hasKey ? '已保存；留空保持不变' : '填写服务商 API Key'; }
    else if (input.type === 'checkbox') input.checked = Boolean(value);
    else {
      if (input.tagName === 'SELECT' && value !== undefined && !Array.from(input.options).some(option => option.value === String(value))) {
        const option = el('option', '', String(value)); option.value = String(value); input.append(option);
      }
      input.value = value ?? '';
    }
  }
  $('#model-key-hint').textContent = state.config.model.keyFromEnvironment ? '环境变量 PET_API_KEY 优先于配置文件' : '密钥保存在本机 pet.config.json，不会返回到页面或提交到 Git';
  resetBalance();
  if (page === 'settings') refreshBalance();
}
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const patch = {}, button = event.submitter; button.disabled = true; $('#settings-result').textContent = '';
  for (const input of event.currentTarget.elements) {
    if (!input.name) continue; const [kind, key] = input.name.split('.'), value = input.type === 'checkbox' ? input.checked : input.type === 'number' || input.hasAttribute('data-number') ? Number(input.value) : input.value;
    if (key) { patch[kind] ||= {}; patch[kind][key] = value; } else patch[kind] = value;
  }
  try { await api('/api/config', patch); await loadState(); fillSettings(); $('#settings-result').textContent = '已保存，形象已更新；人设和模型将在下次聊天生效'; }
  catch (e) { toast(e.message); } finally { button.disabled = false; }
});

for (const action of ['start', 'stop', 'login']) $(`#wechat-${action}`).addEventListener('click', async () => {
  try { await api(`/api/wechat/${action}`, {}); await loadState(); if (action !== 'stop') toast('请留意终端；首次登录需要扫码。'); }
  catch (e) { toast(e.message); }
});
$('#qr-refresh').addEventListener('click', async () => {
  try { const blob = await api('/api/wechat/qr', undefined, true), image = $('#wechat-qr'); if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src); image.src = URL.createObjectURL(blob); image.hidden = false; }
  catch (e) { $('#wechat-qr').hidden = true; toast(e.message); }
});
function fillQQ() {
  const q = state.config.qq;
  for (const input of $('#qq-form').elements) {
    if (!input.name) continue;
    if (input.name === 'appSecret') { input.value = ''; input.placeholder = q.secretFromEnvironment ? '正在使用 QQBOT_SECRET 环境变量' : q.hasSecret ? '已保存；留空保持不变' : '填写机器人密钥'; }
    else if (input.type === 'checkbox') input.checked = Boolean(q[input.name]);
    else input.value = Array.isArray(q[input.name]) ? q[input.name].join('\n') : q[input.name] ?? '';
  }
  $('#qq-form [name="appId"]').disabled = q.appIdFromEnvironment;
  $('#qq-secret-hint').textContent = q.secretFromEnvironment ? '环境变量 QQBOT_SECRET 优先；更换时请修改环境变量并重启' : '留空保留已保存的密钥；更换 AppID 时请重新填写对应的 AppSecret';
  const pack = $('#sticker-pack'); pack.replaceChildren();
  for (const sticker of state.stickers || []) {
    const card = el('figure'), img = el('img'); img.src = sticker.url; img.alt = sticker.label; img.loading = 'lazy';
    card.append(img, el('figcaption', '', sticker.label)); pack.append(card);
  }
}
function renderQQ() {
  const q = state?.qq || { state: 'stopped', contacts: [] }, config = state?.config.qq;
  const phase = qqStateError ? 'unknown' : qqAction === 'start' ? 'starting' : qqAction === 'stop' ? 'stopping' : q.state;
  const labels = { stopped: '未连接', starting: '正在连接', connected: '已连接', reconnecting: '正在重连', stopping: '正在断开', error: '连接失败', unknown: '状态暂不可用' };
  const waiting = ['starting', 'reconnecting'].includes(phase), stopping = phase === 'stopping';
  const running = waiting || phase === 'connected' || stopping;
  $('#qq-status').textContent = labels[phase] || '未连接';
  const error = [qqStateError, qqActionError, q.error].filter(Boolean).join(' ');
  $('#qq-error').hidden = !error; $('#qq-error').textContent = error;
  const start = $('#qq-start'), stop = $('#qq-stop'), refresh = $('#qq-refresh');
  start.textContent = { starting: '正在连接…', connected: '已连接 QQ', reconnecting: '正在重连…', error: '重试连接', stopping: '正在断开…', unknown: '连接 QQ' }[phase] || '连接 QQ';
  start.disabled = !!qqAction || running || !!qqStateError || !state;
  start.setAttribute('aria-busy', String(waiting));
  stop.textContent = stopping ? '正在断开…' : waiting ? '取消连接' : '断开';
  stop.disabled = !!qqAction || stopping || (!running && !['error', 'unknown'].includes(phase));
  stop.setAttribute('aria-busy', String(stopping));
  refresh.disabled = !!qqAction; refresh.textContent = qqAction === 'refresh' ? '正在刷新…' : '刷新状态';
  refresh.setAttribute('aria-busy', String(qqAction === 'refresh'));
  let detail = '保存 AppID 和 AppSecret 后，点击「连接 QQ」。';
  if (waiting) detail = `${labels[phase]}，已等待 ${qqAction === 'start' ? 0 : q.elapsedSeconds || 0} 秒，最长 ${q.timeoutSeconds || 60} 秒。超时后可重试，也可以取消。`;
  else if (phase === 'connected') detail = config?.directMode === 'allowlist' && !config.allowedUsers.length
    ? '已连接 QQ。私聊名单还是空的：先在 QQ 给机器人发一句话，再把下方出现的联系人 OpenID 填入名单并保存。'
    : '已连接 QQ，可以接收消息。请用已允许的联系人私聊，或在已允许的群里 @ 机器人。';
  else if (phase === 'error') detail = '本次连接已停止。按下面的提示检查后，点击「重试连接」。';
  else if (stopping) detail = '正在取消连接并收尾，请稍候。';
  else if (phase === 'unknown') detail = '当前状态尚未确认，请检查本地启动终端并刷新状态。';
  $('#qq-connection-detail').textContent = detail;
  const contacts = $('#qq-contacts'); contacts.replaceChildren();
  for (const contact of q.contacts || []) {
    const row = el('div', 'qq-contact'), kind = contact.kind === 'group' ? '群' : '联系人';
    row.append(el('span', '', `${kind} OpenID`), el('code', '', contact.id));
    const listKey = contact.kind === 'group' ? 'allowedGroups' : 'allowedUsers';
    const add = el('button', '', config?.[listKey].includes(contact.id) ? '已在名单' : '填入名单');
    add.disabled = !!config?.[listKey].includes(contact.id);
    add.addEventListener('click', () => {
      const input = $(`#qq-form [name="${listKey}"]`);
      input.value = [...new Set([...input.value.split(/[\s,，]+/).filter(Boolean), contact.id])].join('\n');
      $(`#qq-form [name="${contact.kind === 'group' ? 'groupMode' : 'directMode'}"]`).value = 'allowlist';
      $('#qq-result').textContent = '已填入，请点击「保存 QQ 配置」生效。';
    });
    row.append(add); contacts.append(row);
  }
}
$('#qq-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter, qq = {}; button.disabled = true; $('#qq-result').textContent = '';
  for (const input of event.currentTarget.elements) {
    if (!input.name || input.disabled) continue;
    qq[input.name] = input.type === 'checkbox' ? input.checked : ['allowedUsers', 'allowedGroups'].includes(input.name) ? input.value.split(/[\s,，]+/).filter(Boolean) : input.value.trim();
  }
  try { await api('/api/config', { qq }); await loadState(); fillQQ(); $('#qq-result').textContent = '已保存。修改凭据或环境后，请重新点击「连接 QQ」。'; }
  catch (e) { toast(e.message); } finally { button.disabled = false; }
});
for (const action of ['start', 'stop', 'refresh']) $(`#qq-${action}`).addEventListener('click', async () => {
  if (qqAction) return;
  qqAction = action; qqActionError = ''; renderQQ();
  try { if (action !== 'refresh') await localApi(`/api/qq/${action}`, {}); await loadState(); }
  catch (e) { qqActionError = e.message; if (action !== 'refresh') qqStateError = '连接操作未完成，请刷新以确认当前状态。'; toast(e.message); }
  finally { qqAction = ''; renderQQ(); }
});
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (Object.hasOwn(titles, next)) showPage(next); });
if (Object.hasOwn(titles, location.hash.slice(1))) showPage(location.hash.slice(1));
loadState(true).then(() => { if (page !== 'home') showPage(page); })
  .catch(e => { chatError(e.message); $('#model-status').textContent = '连接失败'; });
setInterval(() => {
  if (!document.hidden && !stateLoading) {
    stateLoading = true;
    loadState().catch(() => { $('#model-status').textContent = '连接已断开，请刷新页面'; }).finally(() => { stateLoading = false; });
  }
}, 5000);
