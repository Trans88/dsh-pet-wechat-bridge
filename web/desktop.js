(() => {
  const $ = selector => document.querySelector(selector), bridge = window.petDesktop;
  const token = $('meta[name="pet-token"]').content, character = $('#pet-character'), sheet = $('#pet-sprite-sheet');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state, prefs = {}, petting = false, busy = false, polling = false, disposed = false, nativeVisible = true;
  const hidden = () => !nativeVisible || document.hidden;
  let bubbleTimer, effectTimer, patTimer, clickTimer, pollTimer, point, lastHit, lastJournal = 0, lastReply = 0, initial = true;
  let pixels, pixelSource, sourceWidth, sourceHeight, bubbleDuration = 0, chat;
  const lifetime = new AbortController();
  // Reuse the existing vector blue-cat artwork when that appearance is selected.
  const avatar = new window.PetAvatar({ character, sprite: $('#pet-sprite'), sheet, cat: $('#pet-cat'), onError: message => say(message || '形象加载失败，请从右键菜单打开设置并重新选择形象。') });
  let cursorTimer;
  async function followCursor() {
    if (disposed) return;
    try {
      if (!hidden() && !reduced.matches && ['haru-live2d', 'taolinghu-live2d'].includes(state?.config.pet.appearance) && bridge?.cursor) {
        const cursor = await bridge.cursor(); if (cursor && !disposed) avatar.trackPointer(cursor.x, cursor.y);
      }
    } catch { /* Browser preview and closing windows have no native cursor. */ }
    if (!disposed) cursorTimer = setTimeout(followCursor, !hidden() && !reduced.matches && ['haru-live2d', 'taolinghu-live2d'].includes(state?.config.pet.appearance) ? 80 : 1000);
  }
  void followCursor();
  window.addEventListener('pagehide', () => clearTimeout(cursorTimer));
  async function api(path, data, binary = false, signal) {
    const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'omit', mode: 'same-origin',
      headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(['/api/chat', '/api/stt', '/api/tts'].includes(path) ? 120000 : 12000), ...(signal ? [signal] : [])]) });
    if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || '暂时连接不上小窝。'); }
    return binary ? response.blob() : response.json();
  }
  function say(text, ms = 8000) {
    if (disposed) return;
    $('#bubble-text').textContent = String(text); $('#bubble-text').scrollTop = 0; $('#bubble').hidden = false;
    bubbleDuration = String(text).length > 180 ? 0 : ms; scheduleBubble();
  }
  function scheduleBubble() {
    clearTimeout(bubbleTimer);
    if (bubbleDuration && !$('#bubble').matches(':hover, :focus-within')) bubbleTimer = setTimeout(() => { $('#bubble').hidden = true; }, bubbleDuration);
  }
  function render() {
    avatar.render({ appearance: state?.config.pet.appearance || 'taolinghu',
      animation: chat?.busy || chat?.voiceState.phase === 'thinking' ? 'thinking' : state?.care.sleeping ? 'sleeping' : petting ? 'petting' : 'idle',
      playing: !hidden() && !reduced.matches });
    $('#mood').textContent = chat?.voiceState.phase === 'listening' ? '正在听你说' : chat?.voiceState.phase === 'speaking' ? '正在说话' : state?.care.moodLabel || '在这里陪你';
    character.classList.toggle('speaking', chat?.voiceState.phase === 'speaking');
  }
  function settings(value) {
    prefs = value || {};
    document.documentElement.style.setProperty('--pet-side', `${({ small: 220, medium: 280, large: 340 })[prefs.size] || 280}px`);
  }
  async function interact(action) {
    if (busy || chat.busy || chat.voiceState.active || disposed) return;
    busy = true;
    try {
      const result = await api('/api/pet/interact', { action, requestId: crypto.randomUUID() });
      if (state) state.care = result.care;
      lastJournal = result.care.journal[0]?.at || lastJournal;
      say(result.text);
      if (result.applied && !result.care.sleeping) {
        petting = true; clearTimeout(patTimer); patTimer = setTimeout(() => { petting = false; render(); }, 1600);
        $('#effect').textContent = ({ feed: '🍪', dance: '♫', play: '✦', wake: '☀' })[action] || '♡';
        $('#effect').classList.remove('active'); void $('#effect').offsetWidth; $('#effect').classList.add('active');
        clearTimeout(effectTimer); effectTimer = setTimeout(() => $('#effect').classList.remove('active'), 1600);
      }
      render();
      if (result.applied) avatar.play(action); else avatar.cancel();
    } catch (error) { say(error.message); }
    finally { busy = false; }
  }
  async function poll() {
    if (polling || disposed) return;
    polling = true;
    try {
      state = await api('/api/desktop/state');
      if (disposed) return;
      $('#bubble-name').textContent = state.config.pet.name; chat.update(state);
      if (!initial && state.reply?.id > lastReply && (!prefs.quiet || state.reply.origin === 'chat')) say(state.reply.text, 0);
      if (state.reply) lastReply = state.reply.id;
      const latest = state.care.journal[0];
      if (!initial && !prefs.quiet && latest?.at > lastJournal) { say(latest.text); if (!chat.busy && !chat.voiceState.active) avatar.play(latest.action); }
      if (latest) lastJournal = latest.at;
      if (initial) { initial = false; say(`${state.config.pet.name}来陪你啦。双击我打开小窝，拖动换位置，右键可以投喂、抱抱。`, 9000); }
      render();
    } catch (error) { if (error.name !== 'AbortError') say(error.message); }
    finally { polling = false; if (!disposed) pollTimer = setTimeout(poll, hidden() ? 15000 : 5000); }
  }
  // Alpha hit testing leaves the empty area around the fox usable on Windows.
  sheet.addEventListener('load', () => {
    try {
      const canvas = document.createElement('canvas'); canvas.width = sourceWidth = sheet.naturalWidth; canvas.height = sourceHeight = sheet.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(sheet, 0, 0);
      pixels = context.getImageData(0, 0, sourceWidth, sourceHeight).data; pixelSource = sheet.src;
    } catch { pixels = null; }
  });
  function hit(event) {
    if (event.target.closest('#toolbar, #bubble, #conversation')) return true;
    if (!event.target.closest('#pet-character')) return false;
    const liveHit = avatar.hit(event.clientX, event.clientY); if (liveHit !== null) return liveHit;
    if (character.dataset.appearance === 'blue-cat' || !pixels || pixelSource !== sheet.src) return true;
    const box = $('#pet-sprite').getBoundingClientRect();
    const columns = Number(sheet.dataset.columns) || 2;
    const rows = Number(sheet.dataset.rows) || 2;
    const frameX = -parseFloat(sheet.style.left || 0) / 100, frameY = -parseFloat(sheet.style.top || 0) / 100;
    const x = Math.floor((frameX + (event.clientX - box.left) / box.width) * sourceWidth / columns);
    const y = Math.floor((frameY + (event.clientY - box.top) / box.height) * sourceHeight / rows);
    return x >= 0 && y >= 0 && x < sourceWidth && y < sourceHeight && pixels[(y * sourceWidth + x) * 4 + 3] > 24;
  }
  document.addEventListener('pointermove', event => {
    if (point) {
      if (!point.moved && Math.hypot(event.screenX - point.x, event.screenY - point.y) > 5) {
        point.moved = true; clearTimeout(clickTimer); bridge?.drag('start');
      }
      return;
    }
    const active = hit(event); if (lastHit !== active) { lastHit = active; bridge?.hit(active); }
  });
  character.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !hit(event)) return;
    point = { x: event.screenX, y: event.screenY, moved: false };
    character.setPointerCapture?.(event.pointerId);
  });
  character.addEventListener('pointerup', event => {
    if (!point) return;
    const moved = point.moved; point = null; bridge?.drag('end');
    character.releasePointerCapture?.(event.pointerId);
    if (!moved) { clearTimeout(clickTimer); clickTimer = setTimeout(() => void interact('pat'), 240); }
  });
  const cancelDrag = () => { point = null; clearTimeout(clickTimer); bridge?.drag('end'); };
  character.addEventListener('pointercancel', cancelDrag); window.addEventListener('blur', cancelDrag);
  character.addEventListener('dblclick', event => {
    if (!hit(event)) return;
    event.preventDefault(); cancelDrag(); chat.suspend();
    void bridge?.openHome('home');
  });
  character.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void interact('pat'); } });
  document.addEventListener('contextmenu', event => { if (event.target.closest('#conversation, #bubble-text')) return; event.preventDefault(); cancelDrag(); bridge?.menu(); });
  $('#menu').addEventListener('click', () => bridge?.menu());
  chat = new window.DesktopChat({ api, bridge, onReply: text => say(text, 0), onChange: render, onAudio: value => avatar.setSpeech(value), isInteracting: () => busy });
  $('#bubble-close').addEventListener('click', () => { clearTimeout(bubbleTimer); $('#bubble').hidden = true; });
  $('#bubble').addEventListener('pointerenter', () => clearTimeout(bubbleTimer));
  $('#bubble').addEventListener('focusin', () => clearTimeout(bubbleTimer));
  $('#bubble').addEventListener('pointerleave', scheduleBubble);
  $('#bubble').addEventListener('focusout', scheduleBubble);
  const offAction = bridge?.onAction(action => {
    if (action === 'chat') void chat.open();
    else if (action === 'hidden' || action === 'shown') { nativeVisible = action === 'shown'; visibilityChanged(); }
    else if (action === 'pause') chat.suspend();
    else if (action === 'voice') void chat.startVoice();
    else if (['pat', 'feed', 'hug', 'play', 'dance', 'sleep', 'wake'].includes(action)) void interact(action);
  });
  const offPrefs = bridge?.onPreferences(settings);
  reduced.addEventListener('change', render);
  function visibilityChanged() { if (hidden()) { chat.suspend(); cancelDrag(); } render(); if (!hidden()) { clearTimeout(pollTimer); void poll(); } }
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', () => {
    disposed = true; lifetime.abort(); chat.dispose(); cancelDrag(); avatar.stop(); offAction?.(); offPrefs?.();
    [bubbleTimer, effectTimer, patTimer, clickTimer, pollTimer].forEach(clearTimeout);
  });
  if (!bridge) $('#browser-note').hidden = false;
  bridge?.preferences().then(settings).catch(() => {});
  render(); void poll();
})();
