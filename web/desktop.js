(() => {
  const $ = selector => document.querySelector(selector), bridge = window.petDesktop;
  const token = $('meta[name="pet-token"]').content, character = $('#pet-character'), sheet = $('#pet-sprite-sheet');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state, prefs = {}, petting = false, busy = false, polling = false, disposed = false;
  let bubbleTimer, effectTimer, patTimer, clickTimer, pollTimer, point, lastHit, lastJournal = 0, lastReply = 0, initial = true;
  let pixels, sourceWidth, sourceHeight;
  // Reuse the existing vector blue-cat artwork when that appearance is selected.
  const avatar = new window.PetAvatar({ character, sprite: $('#pet-sprite'), sheet, cat: $('#pet-cat'), onError: () => say('形象加载失败，请从右键菜单打开设置并重新选择形象。') });
  async function api(path, data) {
    const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'omit', mode: 'same-origin',
      headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '暂时连接不上小窝。');
    return result;
  }
  function say(text, ms = 8000) {
    if (disposed) return;
    $('#bubble').textContent = String(text).slice(0, 500); $('#bubble').hidden = false;
    clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => { $('#bubble').hidden = true; }, ms);
  }
  function render() {
    avatar.render({ appearance: state?.config.pet.appearance || 'taolinghu',
      animation: state?.care.sleeping ? 'sleeping' : petting ? 'petting' : 'idle',
      playing: !document.hidden && !reduced.matches });
    $('#mood').textContent = state?.care.moodLabel || '在这里陪你';
  }
  function settings(value) {
    prefs = value || {};
    document.documentElement.style.setProperty('--pet-side', `${({ small: 220, medium: 280, large: 340 })[prefs.size] || 280}px`);
  }
  async function interact(action) {
    if (busy || disposed) return;
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
    } catch (error) { say(error.message); }
    finally { busy = false; }
  }
  async function poll() {
    if (polling || disposed) return;
    polling = true;
    try {
      state = await api('/api/desktop/state');
      if (!initial && state.reply?.id > lastReply && (!prefs.quiet || state.reply.origin === 'chat')) say(state.reply.text, 15000);
      if (state.reply) lastReply = state.reply.id;
      const latest = state.care.journal[0];
      if (!initial && !prefs.quiet && latest?.at > lastJournal) say(latest.text);
      if (latest) lastJournal = latest.at;
      if (initial) { initial = false; say(`${state.config.pet.name}来陪你啦。拖动我换个位置，右键可以投喂、抱抱。`, 9000); }
      render();
    } catch (error) { say(error.message); }
    finally { polling = false; if (!disposed) pollTimer = setTimeout(poll, document.hidden ? 15000 : 5000); }
  }
  // Alpha hit testing leaves the empty area around the fox usable on Windows.
  sheet.addEventListener('load', () => {
    try {
      const canvas = document.createElement('canvas'); canvas.width = sourceWidth = sheet.naturalWidth; canvas.height = sourceHeight = sheet.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(sheet, 0, 0);
      pixels = context.getImageData(0, 0, sourceWidth, sourceHeight).data;
    } catch { pixels = null; }
  });
  function hit(event) {
    if (event.target.closest('#toolbar, #bubble')) return true;
    if (!event.target.closest('#pet-character')) return false;
    if (character.dataset.appearance === 'blue-cat' || !pixels) return true;
    const box = $('#pet-sprite').getBoundingClientRect();
    const columns = character.dataset.appearance === 'taolinghu-classic' ? 8 : 2;
    const rows = character.dataset.appearance === 'taolinghu-classic' ? 11 : 2;
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
  const cancelDrag = () => { point = null; bridge?.drag('end'); };
  character.addEventListener('pointercancel', cancelDrag); window.addEventListener('blur', cancelDrag);
  character.addEventListener('dblclick', () => { clearTimeout(clickTimer); bridge?.openHome('home'); });
  character.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void interact('pat'); } });
  document.addEventListener('contextmenu', event => { event.preventDefault(); cancelDrag(); bridge?.menu(); });
  $('#menu').addEventListener('click', () => bridge?.menu());
  $('#chat').addEventListener('click', () => bridge?.openHome('home'));
  $('#bubble').addEventListener('click', () => bridge?.openHome('home'));
  const offAction = bridge?.onAction(action => { if (['pat', 'feed', 'hug', 'play', 'dance', 'sleep', 'wake'].includes(action)) void interact(action); });
  const offPrefs = bridge?.onPreferences(settings);
  reduced.addEventListener('change', render);
  document.addEventListener('visibilitychange', () => { render(); if (!document.hidden) { clearTimeout(pollTimer); void poll(); } });
  window.addEventListener('pagehide', () => {
    disposed = true; cancelDrag(); avatar.stop(); offAction?.(); offPrefs?.();
    [bubbleTimer, effectTimer, patTimer, clickTimer, pollTimer].forEach(clearTimeout);
  });
  if (!bridge) $('#browser-note').hidden = false;
  bridge?.preferences().then(settings).catch(() => {});
  render(); void poll();
})();
