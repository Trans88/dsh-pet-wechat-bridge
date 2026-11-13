// Shared by the web room and the sandboxed desktop renderer. No Node access.
(() => {
  const art = {
    taolinghu: { src: '/assets/taolinghu-hd.png', columns: 2, rows: 2, ratio: '1 / 1', frames: {
      idle: [[0, 0, 2400], [1, 0, 140], [0, 0, 4100], [1, 0, 130]],
      thinking: [[0, 0, 1800], [1, 0, 180]],
      petting: [[0, 1, 0]], sleeping: [[1, 1, 0]],
    } },
    'taolinghu-classic': { src: '/assets/taolinghu.png', columns: 8, rows: 11, ratio: '192 / 208', frames: {
      idle: [280, 110, 110, 140, 140, 320].map((ms, i) => [i, 0, ms]),
      petting: [140, 140, 140, 280].map((ms, i) => [i, 3, ms]),
      thinking: [150, 150, 150, 150, 150, 280].map((ms, i) => [i, 8, ms]),
      sleeping: [[7, 5, 0]],
    } },
  };
  // Finite care stories: server applies rewards once, animation only presents them.
  const careArt = { src: '/assets/taolinghu-care.png', columns: 4, rows: 3, ratio: '1 / 1' };
  const sequences = {
    pat: [[0,0,650,'期待'],[2,0,700,'蹭蹭'],[3,2,1100,'好开心']],
    feed: [[0,0,750,'接住零食'],[1,0,700,'啊呜'],[1,0,700,'嚼嚼'],[3,2,1000,'吃饱啦']],
    hug: [[2,0,800,'张开双手'],[3,0,1400,'抱紧一点'],[3,2,1000,'暖乎乎']],
    play: [[0,1,850,'准备扑球'],[1,1,850,'抓到啦'],[0,1,650,'再来一次'],[1,1,1000,'带回来给你']],
    dance: [[2,1,550,'左摇摇'],[3,1,550,'右摇摇'],[2,1,550,'跟上节拍'],[3,1,550,'转个圈'],[3,2,900,'谢幕']],
    sleep: [[0,2,1000,'打个哈欠'],[1,2,1800,'蜷好尾巴']],
    wake: [[0,2,700,'揉揉眼睛'],[2,2,1100,'伸个懒腰'],[3,2,1000,'醒来啦']],
  };
  class PetAvatar {
    constructor({ character, sprite, sheet, cat, onError = () => {} }) {
      Object.assign(this, { character, sprite, sheet, cat, onError });
      this.failed = new Set(); this.sequence = null;
      this.caption = document.createElement('span');
      this.caption.className = 'care-caption'; this.caption.setAttribute('aria-hidden', 'true');
      this.caption.hidden = true; character.append(this.caption);
      sheet.addEventListener('error', () => {
        this.failed.add(this.sheet.getAttribute('src')); this.sequence = null;
        this.render(this.options, true); onError();
      });
    }
    play(action) {
      if (this.live2d) return this.live2d.play(action);
      if (!sequences[action]) return false;
      this.sequence = { action, index: 0 };
      this.render(this.options, true); return true;
    }
    cancel() { this.live2d?.cancel(); this.sequence = null; this.render(this.options, true); }
    render(options = {}, force = false) {
      if (options.appearance === 'haru-live2d' && !this.failed.has('live2d')) return this.renderLive2d(options);
      if (options.appearance !== 'haru-live2d') this.failed.delete('live2d');
      this.releaseLive2d();
      if (options.appearance === 'haru-live2d') options = { ...options, appearance: 'taolinghu' };
      if (this.options?.appearance !== options.appearance || options.animation === 'thinking' || options.playing === false) this.sequence = null;
      this.options = options;
      const { appearance = 'taolinghu', animation = 'idle', playing = true } = options;
      const selected = art[appearance] && !this.failed.has(art[appearance].src) ? appearance : 'blue-cat';
      const activity = this.sequence;
      const sequence = activity && sequences[activity.action];
      const step = sequence?.[activity.index];
      const key = `${selected}/${animation}/${playing}/${activity?.action}/${activity?.index}`;
      if (this.key === key && !force) return;
      this.key = key; clearTimeout(this.timer);
      this.character.dataset.appearance = selected;
      this.character.dataset.animation = animation;
      this.character.dataset.careAction = activity?.action || '';
      this.character.dataset.careStep = activity ? String(activity.index) : '';
      this.caption.textContent = step?.[3] || ''; this.caption.hidden = !step;
      this.character.classList.toggle('care-active', Boolean(step));
      this.character.classList.toggle('motion-paused', !playing);
      this.sprite.hidden = selected === 'blue-cat';
      this.cat?.toggleAttribute('hidden', selected !== 'blue-cat');
      const usesCare = selected === 'taolinghu' && step && !this.failed.has(careArt.src);
      const asset = usesCare ? careArt : art[selected];
      if (activity && playing) {
        this.timer = setTimeout(() => {
          if (this.sequence !== activity) return;
          activity.index++;
          if (activity.index >= sequence.length) this.sequence = null;
          this.render(this.options, true);
        }, step[2]);
      }
      if (selected === 'blue-cat') return;
      this.sheet.dataset.columns = String(asset.columns); this.sheet.dataset.rows = String(asset.rows);
      if (this.sheet.getAttribute('src') !== asset.src) this.sheet.src = asset.src;
      this.sprite.style.aspectRatio = asset.ratio;
      this.sheet.style.width = `${asset.columns * 100}%`;
      this.sheet.style.height = `${asset.rows * 100}%`;
      const frames = usesCare ? [step] : asset.frames[animation] || asset.frames.idle;
      let index = 0;
      const draw = () => {
        const [x, y, ms] = frames[index];
        this.sheet.style.left = `${-100 * x}%`;
        this.sheet.style.top = `${-100 * y}%`;
        if (!activity && playing && ms) this.timer = setTimeout(() => { index = (index + 1) % frames.length; draw(); }, ms);
      };
      draw();
    }
    renderLive2d(options) {
      if (this.live2d || this.live2dLoading) {
        this.options = options; this.live2d?.update(options); return;
      }
      // A familiar poster remains visible until the actual mesh has loaded.
      this.render({ ...options, appearance: 'taolinghu', playing: false });
      this.options = options; this.sequence = null; this.caption.hidden = true;
      this.character.dataset.appearance = 'haru-live2d';
      const generation = this.live2dGeneration = (this.live2dGeneration || 0) + 1;
      this.live2dLoading = true;
      import('/live2d.js').then(async ({ Live2DAvatar }) => {
        if (generation !== this.live2dGeneration) return;
        const fail = error => {
          if (generation !== this.live2dGeneration) return;
          this.failed.add('live2d'); this.releaseLive2d(); this.render(options, true);
          this.onError(`${error?.message || 'Live2D 加载失败。'}已暂时显示桃铃狐，可重新选择 Live2D 或刷新重试。`);
        };
        this.live2d = new Live2DAvatar({ character: this.character, onError: fail });
        this.live2d.update(this.options);
        await this.live2d.load();
        if (generation !== this.live2dGeneration) return;
        this.live2dLoading = false; this.sprite.hidden = true; this.cat?.toggleAttribute('hidden', true);
        this.character.classList.remove('motion-paused'); this.live2d.setSpeech(this.speech);
      }).catch(error => {
        if (generation !== this.live2dGeneration) return;
        this.failed.add('live2d'); this.releaseLive2d(); this.render(options, true);
        this.onError(`${error?.message || 'Live2D 加载失败。'}已暂时显示桃铃狐。`);
      });
    }
    releaseLive2d() {
      if (!this.live2d && !this.live2dLoading) return;
      this.live2dGeneration++; this.live2dLoading = false;
      this.live2d?.dispose(); this.live2d = null;
    }
    setSpeech(value) { this.speech = value; this.live2d?.setSpeech(value); }
    trackPointer(x, y) { this.live2d?.trackPointer(x, y); }
    hit(x, y) { return this.live2d ? this.live2d.hit(x, y) : null; }
    stop() { clearTimeout(this.timer); this.sequence = null; this.key = null;
      this.releaseLive2d();
      this.caption.hidden = true; this.character.classList.remove('care-active');
      delete this.character.dataset.careAction; delete this.character.dataset.careStep;
    }
  }
  window.PetAvatar = PetAvatar;
})();
