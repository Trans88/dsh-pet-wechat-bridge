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
  class PetAvatar {
    constructor({ character, sprite, sheet, cat, onError = () => {} }) {
      Object.assign(this, { character, sprite, sheet, cat, onError });
      this.failed = new Set();
      sheet.addEventListener('error', () => {
        this.failed.add(this.options?.appearance || 'taolinghu');
        this.render(this.options, true); onError();
      });
    }
    render(options = {}, force = false) {
      this.options = options;
      const { appearance = 'taolinghu', animation = 'idle', playing = true } = options;
      const selected = art[appearance] && !this.failed.has(appearance) ? appearance : 'blue-cat';
      const key = `${selected}/${animation}/${playing}`;
      if (this.key === key && !force) return;
      this.key = key; clearTimeout(this.timer);
      this.character.dataset.appearance = selected;
      this.character.dataset.animation = animation;
      this.character.classList.toggle('motion-paused', !playing);
      this.sprite.hidden = selected === 'blue-cat';
      this.cat?.toggleAttribute('hidden', selected !== 'blue-cat');
      if (selected === 'blue-cat') return;
      const asset = art[selected];
      if (this.sheet.getAttribute('src') !== asset.src) this.sheet.src = asset.src;
      this.sprite.style.aspectRatio = asset.ratio;
      this.sheet.style.width = `${asset.columns * 100}%`;
      this.sheet.style.height = `${asset.rows * 100}%`;
      const frames = asset.frames[animation] || asset.frames.idle;
      let index = 0;
      const draw = () => {
        const [x, y, ms] = frames[index];
        this.sheet.style.left = `${-100 * x}%`;
        this.sheet.style.top = `${-100 * y}%`;
        if (playing && ms) this.timer = setTimeout(() => { index = (index + 1) % frames.length; draw(); }, ms);
      };
      draw();
    }
    stop() { clearTimeout(this.timer); this.key = null; }
  }
  window.PetAvatar = PetAvatar;
})();
