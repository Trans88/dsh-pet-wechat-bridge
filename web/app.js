const $ = selector => document.querySelector(selector);
const token = $('meta[name="pet-token"]').content;
const titles = { home: '欢迎回到小窝', memory: '我们的小小记忆', channels: '连接你的日常', settings: '让它更像你的小伙伴' };
let state, scope = 'web:owner', page = 'home', attachment, pendingRequestId, sending = false, sleeping = false, recorder, recordTimer, toastTimer, lastUpdate = 0;
let historyRevision = 0, memoryRevision = 0;
let avatarTimer, patTimer, petting = false, avatarKey, spriteFailed = false;
let interactionBusy = false, interactionTimer, careState, effectAction;
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
// Original ChatGPT atlas: 8 columns, 11 rows, 192 x 208 pixels per cell.
// Use only the occupied frames in each row. Rest holds the final closed-eye pose.
const avatarAnimations = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  petting: { row: 3, durations: [140, 140, 140, 280] },
  thinking: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
  sleeping: { row: 5, column: 7, durations: [0] },
};
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

function renderAvatar(force = false) {
  const selected = state?.config.pet.appearance || 'taolinghu';
  const appearance = selected === 'taolinghu' && !spriteFailed ? 'taolinghu' : 'blue-cat';
  const animation = sending ? 'thinking' : sleeping ? 'sleeping' : petting ? 'petting' : 'idle';
  const playing = appearance === 'taolinghu' && page === 'home' && !document.hidden && !reducedMotion?.matches;
  const key = `${appearance}/${animation}/${playing}`;
  if (!force && avatarKey === key) return;
  avatarKey = key; clearTimeout(avatarTimer);
  const character = $('#pet-character');
  character.dataset.appearance = appearance;
  character.dataset.animation = animation;
  $('#pet-sprite').hidden = appearance !== 'taolinghu';
  $('#pet-cat').toggleAttribute('hidden', appearance !== 'blue-cat');
  if (appearance !== 'taolinghu') return;
  const sequence = avatarAnimations[animation], sheet = $('#pet-sprite-sheet');
  let frame = 0;
  function draw() {
    sheet.style.left = `${-100 * (sequence.column ?? frame)}%`;
    sheet.style.top = `${-100 * sequence.row}%`;
    if (playing && sequence.durations[frame] > 0) {
      avatarTimer = setTimeout(() => { frame = (frame + 1) % sequence.durations.length; draw(); }, sequence.durations[frame]);
    }
  }
  draw();
}
function spriteLoadFailed() {
  spriteFailed = true; renderAvatar();
  if ((state?.config.pet.appearance || 'taolinghu') === 'taolinghu') toast('桃铃狐图片未能加载，暂时显示蓝猫。请刷新页面重试。');
}
$('#pet-sprite-sheet').addEventListener('error', spriteLoadFailed);
if ($('#pet-sprite-sheet').complete && !$('#pet-sprite-sheet').naturalWidth) spriteLoadFailed();
document.addEventListener('visibilitychange', () => renderAvatar());
reducedMotion?.addEventListener('change', () => renderAvatar());
window.addEventListener('pagehide', () => { clearTimeout(avatarTimer); clearTimeout(patTimer); clearTimeout(interactionTimer); interactionBusy = false; petting = false; clearPetEffect(); interactionControls(); avatarKey = undefined; });
window.addEventListener('pageshow', () => renderAvatar(true));
renderAvatar();

async function api(path, data, binary = false) {
  const response = await fetch(path, { mode: 'same-origin', credentials: 'omit', method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `请求失败（${response.status}）`);
  }
  return binary ? response.blob() : response.json();
}
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function chatError(text) { $('#chat-error').textContent = text || ''; $('#chat-error').hidden = !text; }
function showPage(next) {
  page = next;
  renderAvatar();
  document.querySelectorAll('.page').forEach(node => { node.hidden = node.id !== `page-${next}`; });
  document.querySelectorAll('.nav').forEach(node => node.classList.toggle('active', node.dataset.page === next));
  $('#page-title').textContent = titles[next];
  if (next === 'memory') renderMemories().catch(e => toast(e.message));
  if (next === 'home') refreshHistory().catch(e => chatError(e.message));
}
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.go)));
$('#date-label').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) + ' · LITTLE PET';

async function loadState(initial = false) {
  state = await api('/api/state');
  renderCare(state.care);
  renderAvatar();
  $('#pet-name').textContent = state.config.pet.name;
  $('#pet-greeting').textContent = state.config.pet.greeting;
  document.title = `${state.config.pet.name} · 你的 AI 宠物`;
  const needsKey = !state.config.model.hasKey && new URL(state.config.model.baseUrl).hostname === 'api.deepseek.com';
  $('#model-status').textContent = needsKey ? '等待配置模型' : state.config.model.model;
  $('#setup-note').hidden = !needsKey;
  const channelLabels = { stopped: '未连接', starting: '正在连接 / 等待扫码', connected: '已连接', error: '连接失败，请查看终端' };
  $('#wechat-status').textContent = channelLabels[state.wechat.state] || '未连接';
  $('#wechat-start').disabled = $('#wechat-login').disabled = ['starting', 'connected'].includes(state.wechat.state);
  $('#wechat-stop').disabled = !['starting', 'connected'].includes(state.wechat.state);
  renderQQ();
  const memoryScope = $('#memory-scope').value;
  $('#memory-scope').replaceChildren();
  const sessions = [{ scope: 'web:owner', label: '网页 · 主人' }, ...state.sessions.filter(s => s.scope !== 'web:owner')];
  for (const session of sessions) { const option = el('option', '', session.label); option.value = session.scope; $('#memory-scope').append(option); }
  if (sessions.some(s => s.scope === memoryScope)) $('#memory-scope').value = memoryScope;
  const updated = state.sessions.find(s => s.scope === scope)?.updated || 0;
  if (initial || (!sending && updated !== lastUpdate && page === 'home')) { lastUpdate = updated; await refreshHistory(); }
  if (initial) { fillSettings(); fillQQ(); }
}

async function refreshHistory() {
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
    item.append(el('div', 'message-label', msg.role === 'user' ? '你' : state.config.pet.name));
    if (msg.image) { const img = el('img'); img.src = `data:${msg.image.mediaType};base64,${msg.image.data}`; img.alt = '发送的图片'; bubble.append(img); }
    bubble.append(document.createTextNode(msg.text)); item.append(bubble);
    if (msg.role === 'assistant') {
      const speak = el('button', 'read-aloud', '♩ 朗读'); speak.addEventListener('click', async () => {
        speak.disabled = true;
        try { const blob = await api('/api/tts', { text: msg.text }, true), url = URL.createObjectURL(blob), audio = new Audio(url); audio.onended = audio.onerror = () => URL.revokeObjectURL(url); await audio.play(); }
        catch (e) { toast(e.message); } finally { speak.disabled = false; }
      }); item.append(speak);
    }
    box.append(item);
  }
  if (atEnd || sending) box.scrollTop = box.scrollHeight;
  const readOnly = scope !== 'web:owner';
  $('#session-caption').textContent = readOnly ? `${state.sessions.find(s => s.scope === scope)?.label || '通道会话'}（只读）` : '网页 · 主人';
  $('#chat-form').hidden = readOnly;
  if (readOnly) {
    const back = el('button', 'text-button', '返回网页聊天 →'); back.addEventListener('click', () => { scope = 'web:owner'; refreshHistory().catch(e => toast(e.message)); }); box.prepend(back);
  }
}

function setBusy(busy) {
  sending = busy;
  interactionControls();
  renderAvatar();
  for (const id of ['send-button', 'image-button', 'voice-button', 'message-input', 'clear-chat', 'remove-image']) $(`#${id}`).disabled = busy;
  $('.room').classList.toggle('busy', busy);
  $('#pet-mood').textContent = busy ? '正在认真听你说' : careState?.moodLabel || '在这里陪你';
  $('#pet-bubble').textContent = busy ? '让我想一想…' : '今天也很高兴见到你。';
  $('#send-button').textContent = busy ? '…' : '↑';
}
$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault(); if (sending) return;
  const text = $('#message-input').value.trim(); if (!text && !attachment) return;
  chatError(''); setBusy(true);
  try {
    pendingRequestId ||= crypto.randomUUID();
    await api('/api/chat', { scope: 'web:owner', text, attachment, requestId: pendingRequestId });
    $('#message-input').value = ''; clearImage(); await refreshHistory();
  } catch (e) { chatError(e.message); }
  finally { setBusy(false); $('#message-input').focus(); }
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

$('#voice-button').addEventListener('click', async () => {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  if (!state.config.stt.enabled) return toast('请先在设置中启用语音识别服务。');
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return toast('此浏览器不支持录音，请使用新版 Chrome 或 Edge。');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('浏览器没有可用的录音格式。');
    const chunks = []; recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      clearTimeout(recordTimer); stream.getTracks().forEach(track => track.stop());
      $('#voice-button').classList.remove('recording'); $('#input-hint').textContent = '正在识别录音…'; $('#voice-button').disabled = true;
      try {
        const blob = new Blob(chunks, { type: mimeType }); if (blob.size > 8 * 1024 * 1024) throw new Error('录音太大，请缩短后重试。');
        const result = await api('/api/stt', { audio: (await dataUrl(blob)).split(',')[1], mediaType: mimeType });
        pendingRequestId = undefined; $('#message-input').value = result.text; $('#message-input').focus();
      } catch (e) { toast(e.message); }
      finally { $('#voice-button').disabled = false; $('#input-hint').textContent = 'Enter 发送 · Shift + Enter 换行'; }
    };
    recorder.onerror = () => { stream.getTracks().forEach(track => track.stop()); clearTimeout(recordTimer); toast('录音失败，请检查麦克风。'); };
    recorder.start(); recordTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 60000);
    $('#voice-button').classList.add('recording'); $('#input-hint').textContent = '正在录音，再次点击结束（最长 60 秒）';
  } catch (e) { stream?.getTracks().forEach(track => track.stop()); toast(e.name === 'NotAllowedError' ? '没有获得麦克风权限，请在浏览器中允许录音。' : e.message); }
});

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
  interactionBusy = true; interactionControls();
  try {
    const result = await api('/api/pet/interact', { action, requestId: crypto.randomUUID() });
    renderCare(result.care); $('#pet-bubble').textContent = result.text;
    if (result.applied) showPetEffect(action);
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
$('#view-session').addEventListener('click', () => { scope = $('#memory-scope').value; showPage('home'); });

for (const [kind, label] of [['vision', '独立图片模型'], ['stt', '语音识别 STT'], ['tts', '语音合成 TTS']]) {
  const block = el('details', 'provider-block'); block.append(el('summary', '', label));
  const form = el('div', 'form-grid'), enabled = el('label', 'check full'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.name = `${kind}.enabled`; enabled.append(checkbox, document.createTextNode('启用' + label)); form.append(enabled);
  for (const [key, title] of [['baseUrl', 'Base URL'], ['model', '模型名称'], ['apiKey', 'API Key'], ...(kind === 'tts' ? [['voice', '音色名称']] : [])]) {
    const label = el('label', 'field', title), input = el('input'); input.name = `${kind}.${key}`; input.type = key === 'apiKey' ? 'password' : 'text'; if (key === 'apiKey') input.autocomplete = 'new-password'; label.append(input); form.append(label);
  }
  block.append(form); $('#optional-providers').append(block);
}
function fillSettings() {
  for (const input of $('#settings-form').elements) {
    if (!input.name) continue;
    const [kind, key] = input.name.split('.'); const value = key ? state.config[kind]?.[key] : state.config[kind];
    if (key === 'apiKey') { input.value = ''; input.placeholder = state.config[kind].keyFromEnvironment ? '正在使用环境变量；清空或替换需要修改环境变量' : state.config[kind].hasKey ? '已保存；留空保持不变' : '填写服务商 API Key'; }
    else if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  }
  $('#model-key-hint').textContent = state.config.model.keyFromEnvironment ? '环境变量 PET_API_KEY 优先于配置文件' : '密钥保存在本机 pet.config.json，不会返回到页面或提交到 Git';
}
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const patch = {}, button = event.submitter; button.disabled = true; $('#settings-result').textContent = '';
  for (const input of event.currentTarget.elements) {
    if (!input.name) continue; const [kind, key] = input.name.split('.'), value = input.type === 'checkbox' ? input.checked : input.value;
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
}
function renderQQ() {
  const q = state.qq || { state: 'stopped', contacts: [] }, config = state.config.qq;
  const labels = { stopped: '未连接', starting: '正在连接', connected: '已连接', reconnecting: '正在重连', error: '连接失败' };
  $('#qq-status').textContent = labels[q.state] || '未连接';
  $('#qq-error').hidden = !q.error; $('#qq-error').textContent = q.error || '';
  const running = ['starting', 'connected', 'reconnecting'].includes(q.state);
  $('#qq-start').disabled = running; $('#qq-stop').disabled = !running && q.state !== 'error';
  const contacts = $('#qq-contacts'); contacts.replaceChildren();
  for (const contact of q.contacts || []) {
    const row = el('div', 'qq-contact'), kind = contact.kind === 'group' ? '群' : '联系人';
    row.append(el('span', '', `${kind} OpenID`), el('code', '', contact.id));
    const listKey = contact.kind === 'group' ? 'allowedGroups' : 'allowedUsers';
    const add = el('button', '', config[listKey].includes(contact.id) ? '已在名单' : '填入名单');
    add.disabled = config[listKey].includes(contact.id);
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
for (const action of ['start', 'stop']) $(`#qq-${action}`).addEventListener('click', async () => {
  const button = $(`#qq-${action}`); button.disabled = true;
  try { await api(`/api/qq/${action}`, {}); await loadState(); }
  catch (e) { toast(e.message); } finally { renderQQ(); }
});
loadState(true).catch(e => { chatError(e.message); $('#model-status').textContent = '连接失败'; });
setInterval(() => { if (!document.hidden) loadState().catch(() => { $('#model-status').textContent = '连接已断开，请刷新页面'; }); }, 5000);
