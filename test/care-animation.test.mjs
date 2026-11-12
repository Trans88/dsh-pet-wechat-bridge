import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { PNG } from 'pngjs';
import { STICKERS, stickerPath } from '../pet/stickers.mjs';

function fixture(t) {
  const dom = new JSDOM('<button id="character"><span id="sprite"><img id="sheet"></span><span id="cat"></span></button>', { runScripts: 'outside-only' });
  const w = dom.window, timers = new Map(); let id = 0;
  w.setTimeout = fn => { timers.set(++id, fn); return id; }; w.clearTimeout = id => timers.delete(id);
  w.eval(readFileSync(new URL('../web/avatar.js', import.meta.url), 'utf8'));
  const $ = id => w.document.getElementById(id);
  const avatar = new w.PetAvatar({ character: $('character'), sprite: $('sprite'), sheet: $('sheet'), cat: $('cat') });
  const options = { appearance: 'taolinghu', animation: 'idle', playing: true };
  avatar.render(options); t.after(() => { avatar.stop(); w.close(); });
  return { avatar, options, $, timers, w, step() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } };
}
test('all care activities have multiple distinct poses and return to persistent state', t => {
  const f = fixture(t);
  for (const action of ['pat','feed','hug','play','dance','sleep','wake']) {
    f.avatar.render({ ...f.options, animation: action === 'sleep' ? 'sleeping' : 'idle' });
    assert.equal(f.avatar.play(action), true);
    const poses = new Set(); let count = 0;
    while (f.avatar.sequence && count++ < 10) {
      assert.equal(f.$('sheet').getAttribute('src'), '/assets/taolinghu-care.png');
      assert.equal(f.$('sheet').dataset.columns, '4'); assert.equal(f.$('sheet').dataset.rows, '3');
      poses.add(`${f.$('sheet').style.left}/${f.$('sheet').style.top}`);
      assert.ok(f.$('character').querySelector('.care-caption').textContent);
      f.step();
    }
    assert.equal(f.avatar.sequence, null); assert.ok(poses.size >= 2, action);
    assert.equal(f.$('sheet').getAttribute('src'), '/assets/taolinghu-hd.png');
    assert.equal(f.$('character').dataset.animation, action === 'sleep' ? 'sleeping' : 'idle');
  }
});
test('new action replaces old timers, visibility/thinking/appearance cancel, and stop clears work', t => {
  const f = fixture(t); f.avatar.play('feed'); const old = [...f.timers.values()][0];
  f.avatar.play('hug'); old(); assert.equal(f.avatar.sequence.action, 'hug');
  f.avatar.render({ ...f.options, playing: false }); assert.equal(f.avatar.sequence, null); assert.equal(f.timers.size, 0);
  f.avatar.play('dance'); assert.equal(f.timers.size, 0, 'reduced motion never starts a sequence');
  f.avatar.render(f.options); f.avatar.play('feed'); f.avatar.render({...f.options, animation:'thinking'}); assert.equal(f.avatar.sequence, null);
  f.avatar.render(f.options); f.avatar.play('hug'); f.avatar.render({...f.options, appearance:'blue-cat'}); assert.equal(f.avatar.sequence, null);
  assert.equal(f.avatar.play('not-an-action'), false);
  f.avatar.stop(); assert.equal(f.timers.size, 0); assert.equal(f.$('character').querySelector('.care-caption').hidden, true);
});
test('failed care sheet falls back to existing art; failed primary art keeps blue cat available', t => {
  const f=fixture(t); f.avatar.play('feed'); f.$('sheet').dispatchEvent(new f.w.Event('error'));
  assert.equal(f.$('sheet').getAttribute('src'), '/assets/taolinghu-hd.png');
  f.avatar.play('hug'); assert.equal(f.$('sheet').getAttribute('src'), '/assets/taolinghu-hd.png');
  f.$('sheet').dispatchEvent(new f.w.Event('error')); assert.equal(f.$('character').dataset.appearance, 'blue-cat');
});
test('expanded sticker catalog has unique fixed IDs and readable nonempty transparent PNG assets', () => {
  assert.equal(STICKERS.length, 13); assert.equal(new Set(STICKERS.map(s=>s.id)).size,13);
  for(const s of STICKERS) {
    const bytes=readFileSync(stickerPath(s.id)), image=PNG.sync.read(bytes);
    assert.ok(bytes.length < 8*1024*1024);
    if (!['cheer','hug','awkward','laugh'].includes(s.id)) assert.ok(bytes.length < 700*1024); assert.ok(image.width >= 300 && image.height >= 300);
    let transparent=0,visible=0;
    for(let i=3;i<image.data.length;i+=4) { if(image.data[i]===0) transparent++; if(image.data[i]>200) visible++; }
    assert.ok(transparent>100 && visible>100, s.id);
  }
  assert.throws(()=>stickerPath('../config'));
});
