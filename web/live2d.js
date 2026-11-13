// Real Cubism mesh rendering, shared by the room and the sandboxed desktop.
// Models and their interaction mappings are fixed, bundled assets.
import { LIVE2D_MODELS } from './live2d-models.js';
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
let coreReady, frameworkUsers = 0;
function loadCore() {
  if (!coreReady) coreReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('Live2D 运行库加载超时。')), 12000);
    script.src = '/vendor/live2d/live2dcubismcore.min.js';
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('Live2D 运行库未能加载。')); };
    document.head.append(script);
  }).catch(error => { coreReady = null; throw error; });
  return coreReady;
}

export class Live2DAvatar {
  constructor({ character, onError, appearance = 'haru-live2d' }) {
    this.appearance = appearance; this.profile = LIVE2D_MODELS[appearance];
    if (!this.profile) throw new Error('请选择内置的 Live2D 形象。');
    this.character = character; this.onError = onError;
    this.canvas = document.createElement('canvas'); this.canvas.className = 'pet-live2d';
    this.canvas.setAttribute('role', 'img'); this.canvas.setAttribute('aria-label', this.profile.label);
    this.canvas.dataset.state = 'loading'; character.prepend(this.canvas);
    this.controller = new AbortController(); this.textures = []; this.motions = {}; this.expressions = []; this.motionDurations = {};
    this.time = 0; this.frames = 0; this.mouth = 0; this.sleep = 0; this.speech = { active: false, level: 0 };
    this.options = {}; this.pointer = { x: 0, y: 0 }; this.action = null;
    this.hitCanvas = document.createElement('canvas'); this.hitCanvas.width = this.hitCanvas.height = 96;
    this.hitContext = this.hitCanvas.getContext('2d', { willReadFrequently: true });
    this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.fail(new Error('显卡绘图环境已中断。')); }, { signal: this.controller.signal });
    document.addEventListener('pointermove', e => this.trackPointer(e.clientX, e.clientY), { passive: true, signal: this.controller.signal });
    document.addEventListener('mouseleave', () => { this.pointer = { x: 0, y: 0 }; }, { signal: this.controller.signal });
    this.observer = new ResizeObserver(() => { if (this.ready) this.draw(0); }); this.observer.observe(character);
  }
  async read(file) {
    const base = new URL(this.profile.root, location.origin), url = new URL(file, base);
    if (!url.href.startsWith(base.href) || url.search || url.hash || url.username || url.password) throw new Error('模型资源路径无效。');
    const response = await fetch(url, { signal: this.controller.signal, credentials: 'omit', mode: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error('Live2D 模型资源不完整。');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Live2D 模型资源过大。');
    this.controller.signal.throwIfAborted(); return bytes;
  }
  async load() {
    try {
      await loadCore(); this.controller.signal.throwIfAborted();
      this.sdk = await import('/vendor/live2d/framework.js'); this.controller.signal.throwIfAborted();
      const s = this.sdk;
      if (!s.CubismFramework.isInitialized()) {
        const option = new s.Option(); option.loggingLevel = s.LogLevel.LogLevel_Error;
        s.CubismFramework.startUp(option); s.CubismFramework.initialize();
      }
      frameworkUsers++; this.ownsFramework = true;
      this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, powerPreference: 'low-power' });
      if (!this.gl) throw new Error('当前环境无法启用 WebGL。');
      const bytes = await this.read(this.profile.file);
      const json = JSON.parse(new TextDecoder().decode(bytes)), refs = json.FileReferences;
      this.setting = new s.CubismModelSettingJson(bytes, bytes.byteLength);
      this.user = new s.CubismUserModel(); this.user.loadModel(await this.read(refs.Moc), true);
      this.model = this.user.getModel(); if (!this.model) throw new Error('Live2D 模型校验失败。');
      this.id = name => s.CubismFramework.getIdManager().getId(name);
      this.eyeIds = new s.csmVector(); this.lipIds = new s.csmVector();
      for (const group of json.Groups || []) for (const name of group.Ids || []) {
        if (group.Name === 'EyeBlink') this.eyeIds.pushBack(this.id(name));
        if (group.Name === 'LipSync') this.lipIds.pushBack(this.id(name));
      }
      this.blink = s.CubismEyeBlink.create(this.setting);
      this.breath = s.CubismBreath.create(); const breathing = new s.csmVector();
      breathing.pushBack(new s.BreathParameterData(this.id('ParamBreath'), 0.5, 0.5, 3.7, 1)); this.breath.setParameters(breathing);
      if (refs.Physics) { const b = await this.read(refs.Physics); this.user.loadPhysics(b, b.byteLength); }
      if (refs.Pose) { const b = await this.read(refs.Pose); this.user.loadPose(b, b.byteLength); }
      for (const [group, entries] of Object.entries(refs.Motions || {})) {
        this.motions[group] = []; this.motionDurations[group] = [];
        for (const entry of entries) {
          const b = await this.read(entry.File), motion = this.user.loadMotion(b, b.byteLength, entry.File);
          motion.setFadeInTime(entry.FadeInTime ?? 0.5); motion.setFadeOutTime(entry.FadeOutTime ?? 0.5);
          motion.setEffectIds(this.eyeIds, this.lipIds); this.motions[group].push(motion);
          this.motionDurations[group].push(JSON.parse(new TextDecoder().decode(b)).Meta.Duration);
        }
      }
      for (const entry of refs.Expressions || []) {
        const b = await this.read(entry.File); this.expressions.push(this.user.loadExpression(b, b.byteLength, entry.Name));
      }
      this.user.createRenderer(); this.renderer = this.user.getRenderer(); this.renderer.startUp(this.gl); this.renderer.setIsPremultipliedAlpha(true);
      for (const [index, file] of refs.Textures.entries()) {
        const b = await this.read(file), bitmap = await createImageBitmap(new Blob([b], { type: 'image/png' }), { premultiplyAlpha: 'premultiply' });
        try {
          this.controller.signal.throwIfAborted();
          const gl = this.gl, texture = gl.createTexture(); this.textures.push(texture);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap); this.renderer.bindTexture(index, texture);
        } finally { bitmap.close(); }
      }
      this.model.saveParameters(); this.ready = true; this.canvas.dataset.state = 'ready';
      this.draw(0); this.update(this.options); return this;
    } catch (error) { if (!this.disposed) this.fail(error); throw error; }
  }
  update(options) {
    if (options.animation === 'thinking' && this.options.animation !== 'thinking') this.cancel();
    this.options = options;
    if (!this.ready || this.disposed) return;
    this.canvas.dataset.paused = String(!options.playing);
    if (!options.playing) {
      cancelAnimationFrame(this.raf); this.raf = null; this.last = 0; this.nextFrame = 0; this.action = null; this.speech = { active: false, level: 0 }; this.mouth = 0;
      this.draw(0); return;
    }
    if (!this.raf) { this.last = 0; this.nextFrame = 0; this.raf = requestAnimationFrame(t => this.tick(t)); }
  }
  tick(now) {
    this.raf = null;
    if (this.disposed || !this.ready || !this.options.playing) return;
    try {
      // One continuous time-based update, capped at 60 Hz even on 144/240 Hz monitors.
      if (!this.last || now >= this.nextFrame - 0.5) {
        const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0;
        this.last = now;
        // Carry the deadline forward; resetting it to now would turn 75 Hz into
        // 37.5 FPS and 144 Hz into 48 FPS. Resync only after a missed interval.
        this.nextFrame = (this.nextFrame || now) + 1000 / 60;
        if (this.nextFrame < now) this.nextFrame = now + 1000 / 60;
        this.draw(dt);
      }
      this.raf = requestAnimationFrame(t => this.tick(t));
    } catch (error) { this.fail(error); }
  }
  setSpeech(value) { this.speech = { active: Boolean(value?.active), level: clamp(Number(value?.level) || 0, 0, 1), approximate: Boolean(value?.approximate) }; }
  cancel() { this.action = null; this.user?._motionManager?.stopAllMotions(); }
  trackPointer(x, y) {
    const rect = this.canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    this.pointer = { x: clamp((x - rect.left - rect.width / 2) / (rect.width / 2), -1, 1), y: clamp((rect.top + rect.height * 0.35 - y) / (rect.height / 2), -1, 1) };
  }
  play(action) {
    if (!this.ready || !this.options.playing || !['pat', 'feed', 'hug', 'play', 'dance', 'sleep', 'wake'].includes(action)) return false;
    const [group, index] = this.profile.actions[action] || [];
    this.action = { name: action, start: this.time, duration: this.motionDurations[group]?.[index] || (action === 'dance' ? 4 : 2.5) };
    if (action === 'sleep') this.user._motionManager.stopAllMotions();
    else {
      const motion = this.motions[group]?.[index];
      if (motion) this.user._motionManager.startMotionPriority(motion, false, 3);
    }
    return true;
  }
  draw(dt) {
    if (!this.ready || this.disposed) return;
    const gl = this.gl, m = this.model, u = this.user, s = this.sdk;
    const side = Math.max(1, Math.round(this.canvas.getBoundingClientRect().width * Math.min(devicePixelRatio || 1, 2)));
    if (this.canvas.width !== side || this.canvas.height !== side) { this.canvas.width = this.canvas.height = side; }
    this.time += dt; const sleeping = this.options.animation === 'sleeping';
    this.sleep += ((sleeping ? 1 : 0) - this.sleep) * (1 - Math.exp(-dt * 5));
    m.loadParameters();
    if (!sleeping && u._motionManager.isFinished() && this.motions.Idle?.length) u._motionManager.startMotionPriority(this.motions.Idle[0], false, 1);
    if (sleeping && this.wasSleeping !== true) u._motionManager.stopAllMotions(); this.wasSleeping = sleeping;
    const moved = u._motionManager.updateMotion(m, dt); m.saveParameters();
    if (!moved) this.blink.updateParameters(m, dt);
    this.breath.updateParameters(m, dt);
    u.setDragging(this.pointer.x * (1 - this.sleep), this.pointer.y * (1 - this.sleep)); u._dragManager.update(dt);
    const x = u._dragManager.getX(), y = u._dragManager.getY();
    const trackingWeight = this.action ? 0.25 : 1;
    m.addParameterValueById(this.id('ParamAngleX'), x * this.profile.pointer.x * trackingWeight); m.addParameterValueById(this.id('ParamAngleY'), y * this.profile.pointer.y * trackingWeight - this.sleep * 10);
    m.addParameterValueById(this.id('ParamAngleZ'), x * y * -8 * trackingWeight); m.addParameterValueById(this.id('ParamBodyAngleX'), x * this.profile.pointer.body * trackingWeight);
    m.setParameterValueById(this.id('ParamEyeBallX'), x); m.setParameterValueById(this.id('ParamEyeBallY'), y);
    if (this.options.animation === 'thinking') m.addParameterValueById(this.id('ParamAngleZ'), 6 * Math.sin(this.time * 0.7));
    if (this.action && this.time - this.action.start > this.action.duration) this.action = null;
    if (this.action && ['pat', 'hug', 'feed', 'play', 'dance'].includes(this.action.name)) {
      const age = this.time - this.action.start, blend = Math.min(1, age * 4, (this.action.duration - age) * 4);
      m.setParameterValueById(this.id('ParamMouthForm'), 1, blend);
      for (const name of this.profile.smileEyes) m.setParameterValueById(this.id(name), 1, blend);
    }
    for (let i = 0; i < this.eyeIds.getSize(); i++) m.multiplyParameterValueById(this.eyeIds.at(i), 1 - this.sleep);
    const speech = this.speech;
    const level = speech.active && this.options.playing ? (speech.approximate ? 0.2 + 0.55 * Math.abs(Math.sin(this.time * 11)) : speech.level) : 0;
    this.mouth += (level - this.mouth) * (1 - Math.exp(-dt * (level > this.mouth ? 25 : 18)));
    // Care motions can author mouth movement too. Only live/decaying speech
    // overrides it, including silence while an utterance is playing.
    if (speech.active || this.mouth > 0.001) for (let i = 0; i < this.lipIds.getSize(); i++) m.setParameterValueById(this.lipIds.at(i), this.mouth);
    u._physics?.evaluate(m, dt); u._pose?.updateParameters(m, dt); m.update();
    const matrix = new s.CubismMatrix44(); matrix.scale(0.94, 0.94); matrix.multiplyByMatrix(u.getModelMatrix());
    gl.viewport(0, 0, side, side); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    this.renderer.setMvpMatrix(matrix); this.renderer.setRenderState(null, [0, 0, side, side]); this.renderer.drawModel();
    this.frames++;
    // Small alpha mask for mouse-through; avoid a GPU readback on every pointer event.
    if (!this.hitPixels || this.time - this.lastMask >= 0.12 || dt === 0) {
      this.hitContext.clearRect(0, 0, 96, 96); this.hitContext.drawImage(this.canvas, 0, 0, 96, 96);
      this.hitPixels = this.hitContext.getImageData(0, 0, 96, 96).data; this.lastMask = this.time;
      this.canvas.dataset.frames = String(this.frames);
    }
  }
  hit(x, y) {
    if (!this.ready || !this.hitPixels) return true;
    const rect = this.canvas.getBoundingClientRect(), px = Math.floor((x - rect.left) * 96 / rect.width), py = Math.floor((y - rect.top) * 96 / rect.height);
    return px >= 0 && py >= 0 && px < 96 && py < 96 && this.hitPixels[(py * 96 + px) * 4 + 3] > 24;
  }
  fail(error) { if (this.disposed) return; this.dispose(); this.onError(error); }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.controller.abort(); cancelAnimationFrame(this.raf); this.raf = null;
    this.observer.disconnect(); this.canvas.remove();
    try {
      this.user?.release();
      for (const entries of Object.values(this.motions)) for (const motion of entries) this.sdk.ACubismMotion.delete(motion);
      for (const expression of this.expressions) this.sdk.ACubismMotion.delete(expression);
      this.setting?.release();
      for (const texture of this.textures) this.gl?.deleteTexture(texture);
      this.sdk?.CubismEyeBlink.delete(this.blink); this.sdk?.CubismBreath.delete(this.breath);
      if (this.ownsFramework && --frameworkUsers === 0) { this.sdk.CubismRenderer.staticRelease(); this.sdk.CubismFramework.dispose(); }
    } finally { this.gl?.getExtension('WEBGL_lose_context')?.loseContext(); this.hitPixels = null; }
  }
}
