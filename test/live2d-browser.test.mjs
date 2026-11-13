import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { createPetServer } from '../pet/server.mjs';

for (const appearance of ['haru-live2d', 'taolinghu-live2d']) test(`real Cubism ${appearance}: visible mesh, continuous tracking, audio mouth, pause, disposal and fallback`, { skip: process.env.PET_BROWSER_TEST !== '1', timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'live2d-browser-')); cpSync(new URL('../web', import.meta.url), join(root, 'web'), { recursive: true });
  const config = new Config(root); config.update({ pet: { appearance } });
  const store = new Store(root), models = { complete: async () => '模拟回复' }, core = new PetCore(config, store, models);
  const app = createPetServer({ root, config, store, models, core });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`; let browser;
  t.after(async () => { await browser?.close(); app.abort(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PET_BROWSER_EXECUTABLE || undefined, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], external = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('browser:', m.text()); });
  await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin);
  await page.waitForSelector('.pet-live2d[data-state="ready"]', { timeout: 20000 });
  await page.waitForFunction(() => Number(document.querySelector('.pet-live2d')?.dataset.frames) >= 5);
  assert.equal(await page.evaluate(() => avatar.live2d.hitPixels.filter((v, i) => i % 4 === 3 && v > 100).length > 100), true, 'real model pixels were drawn');
  const box = await page.locator('.pet-live2d').boundingBox();
  await page.mouse.move(box.x + box.width, box.y + box.height / 3);
  await page.waitForFunction(() => avatar.live2d.user._dragManager.getX() > 0.65);
  const before = await page.evaluate(() => avatar.live2d.frames);
  await page.mouse.move(box.x, box.y + box.height / 3);
  await page.waitForFunction(() => avatar.live2d.user._dragManager.getX() < -0.65);
  assert.ok(await page.evaluate(() => avatar.live2d.frames) > before + 2);
  const shot = name => `dist/live2d-qa/${appearance}-${name}.png`;
  mkdirSync('dist/live2d-qa', { recursive: true }); await page.screenshot({ path: shot('room') });
  if (appearance === 'taolinghu-live2d') {
    // Use the actual button, motion manager and draw loop. Observe a held pose
    // rather than sleeping for a guessed frame or setting model parameters.
    await page.locator('[data-interaction="pat"]').click();
    const closedHandle = await page.waitForFunction(() => {
      const a = avatar.live2d;
      if (a.action?.name !== 'pat' || a.time - a.action.start < 0.75) return false;
      const eyes = ['L', 'R'].map(side => a.model.getParameterValueById(a.id(`ParamEye${side}Open`)));
      if (!eyes.every(open => Math.abs(open) <= 1e-5)) return false;
      const drawables = ['L', 'R'].flatMap(side => ['Eyewhite', 'Irides', 'Eyelash'].map(part => {
        const name = `ArtMesh${part}${side}`, index = a.model.getDrawableIndex(a.id(name));
        return { name, part, index, opacity: a.model.getDrawableOpacity(index) };
      }));
      return { eyes, drawables };
    });
    const closed = await closedHandle.jsonValue(); await closedHandle.dispose();
    assert.ok(closed.eyes.every(open => Math.abs(open) <= 1e-5), 'pat holds both eyes fully closed in the application');
    for (const drawable of closed.drawables) {
      assert.ok(drawable.index >= 0, `${drawable.name}: compiled drawable exists`);
      assert.equal(drawable.opacity, drawable.part === 'Eyelash' ? 1 : 0, `${drawable.name}: closed eyes retain lashes without visible iris or eye-white`);
    }
    await page.screenshot({ path: shot('pat-closed') });
    await page.waitForFunction(() => {
      const a = avatar.live2d;
      const idlePlaying = a.user._motionManager._motions.get().some(entry => entry.getCubismMotion() === a.motions.Idle[0] && !entry.isFinished());
      return !a.action && idlePlaying && ['L', 'R'].every(side =>
        a.model.getParameterValueById(a.id(`ParamEye${side}Open`)) >= 0.99
        && ['Eyewhite', 'Irides'].every(part => a.model.getDrawableOpacity(a.model.getDrawableIndex(a.id(`ArtMesh${part}${side}`))) === 1));
    });
    await page.screenshot({ path: shot('pat-return-idle') });
  }
  await page.locator('[data-interaction="hug"]').click();
  await page.waitForFunction(() => avatar.live2d.action?.name === 'hug');
  assert.equal(await page.locator('#pet-character').evaluate(node => getComputedStyle(node).opacity), '1', 'interaction cooldown does not fade the animated character');
  if (appearance === 'taolinghu-live2d') {
    await page.waitForFunction(() => avatar.live2d.model.getParameterValueById(avatar.live2d.id('ParamArmL')) > 0.85);
    await page.screenshot({ path: shot('hug') });
    await page.locator('[data-interaction="feed"]').click();
    await page.waitForFunction(() => avatar.live2d.action?.name === 'feed' && avatar.live2d.model.getParameterValueById(avatar.live2d.id('ParamMouthOpenY')) > 0.2);
    await page.screenshot({ path: shot('feed') });
  }
  await page.locator('[data-page="settings"]').click();
  await page.waitForFunction(() => avatar.live2d.canvas.dataset.paused === 'true');
  const frozen = await page.evaluate(() => avatar.live2d.frames); await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => avatar.live2d.frames), frozen, 'no frame loop while away from room');
  await page.evaluate(() => { for (let i = 0; i < 3; i++) avatar.render({ ...avatar.options }); });
  assert.equal(await page.evaluate(() => avatar.live2d.frames), frozen, 'late care/status updates cannot redraw a hidden room');
  await page.locator('[data-page="home"]').click();
  const audio = readFileSync(new URL('./fixtures/desktop-tone.mp3.base64', import.meta.url), 'utf8').trim();
  await page.evaluate(base64 => {
    window.audioAbort = new AbortController();
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    window.audioDone = voice.playAudio(new Blob([bytes], { type: 'audio/mpeg' }), audioAbort.signal, { rate: 1 }).catch(e => e.name);
  }, audio);
  await page.waitForFunction(() => avatar.live2d.speech.active && !avatar.live2d.speech.approximate && avatar.live2d.mouth > 0.05);
  await page.screenshot({ path: shot('speaking') });
  await page.evaluate(() => audioAbort.abort()); await page.waitForFunction(() => !avatar.live2d.speech.active && avatar.live2d.mouth < 0.01);
  await page.locator('[data-page="settings"]').click();
  await page.locator('[name="pet.appearance"]').selectOption('taolinghu'); await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('.pet-live2d'));
  await page.locator('[name="pet.appearance"]').selectOption(appearance); await page.locator('#settings-form button[type="submit"]').click();
  await page.locator('[data-page="home"]').click(); await page.waitForSelector('.pet-live2d[data-state="ready"]');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForFunction(() => document.querySelector('.pet-live2d')?.dataset.paused === 'true');
  await page.locator('[data-page="settings"]').click();
  await page.locator('[name="pet.appearance"]').selectOption('taolinghu'); await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('.pet-live2d'));
  await page.locator('[data-page="home"]').click();
  assert.equal(await page.locator('#pet-sprite').isVisible(), true, 'reduced-motion switch restores the original sprite');
  await page.locator('[data-page="settings"]').click();
  await page.locator('[name="pet.appearance"]').selectOption(appearance); await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForSelector('.pet-live2d[data-state="ready"]', { state: 'attached' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const alternate = appearance === 'haru-live2d' ? 'taolinghu-live2d' : 'haru-live2d';
  await page.evaluate(() => { window.previousAvatar = avatar.live2d; });
  await page.locator('[name="pet.appearance"]').selectOption(alternate); await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForFunction(value => avatar.live2d?.appearance === value && avatar.live2d.ready, alternate);
  assert.equal(await page.evaluate(() => previousAvatar.disposed), true, 'switching between live models releases the previous renderer');
  assert.equal(await page.locator('.pet-live2d').count(), 1);
  await page.locator('[name="pet.appearance"]').selectOption(appearance); await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForFunction(value => avatar.live2d?.appearance === value && avatar.live2d.ready, appearance);
  await page.goto(origin + '/desktop'); await page.setViewportSize({ width: 320, height: 470 });
  await page.waitForSelector('.pet-live2d[data-state="ready"]');
  await page.screenshot({ path: shot('desktop'), omitBackground: true });
  await page.evaluate(() => document.querySelector('.pet-live2d').dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  await page.waitForFunction(() => document.querySelector('#pet-character').dataset.appearance === 'taolinghu');
  assert.match(await page.locator('#bubble-text').textContent(), /显卡|Live2D/);
  assert.deepEqual(external, [], 'model and runtime work without CDN requests'); assert.deepEqual(errors, []);
});
