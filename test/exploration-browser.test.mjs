import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { captureNoteMedia } from '../pet/explorer-media.mjs';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { Autonomy } from '../pet/autonomy.mjs';
import { createPetServer } from '../pet/server.mjs';

const skip = process.env.PET_BROWSER_TEST !== '1';
async function serve(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('real Chromium decodes three video frames and player audio without microphone access', { skip, timeout: 45000 }, async t => {
  const video = Buffer.from(readFileSync(new URL('./fixtures/note-video.webm.base64', import.meta.url), 'utf8').trim(), 'base64');
  const server = createServer((req, res) => {
    if (req.url === '/video') {
      const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) }); res.end(video.subarray(start, end + 1));
    } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<div id="noteContainer"><video src="/video" muted controls preload="auto" width="320" height="240"></video></div>'); }
  });
  const origin = await serve(server); let browser;
  t.after(async () => { await browser?.close(); await close(server); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.deviceRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.deviceRequests++; throw new Error('Microphone access forbidden'); };
    navigator.mediaDevices.getDisplayMedia = async () => { window.deviceRequests++; throw new Error('Screen capture forbidden'); };
  });
  await page.goto(origin); let checks = 0;
  const media = await captureNoteMedia(page, { video: true, audio: true, checkAccess: async () => { checks++; } });
  assert.equal(media.frames.length, 3, JSON.stringify(media.warnings));
  assert.ok(media.frames.every(f => f.data.length > 1000 && f.mediaType === 'image/jpeg'));
  assert.ok(new Set(media.frames.map(f => f.data)).size > 1, 'different timestamps produce decoded frames');
  assert.ok(media.audio?.data.length > 1000, JSON.stringify(media.warnings));
  assert.ok(media.audio.end - media.audio.start > 1 && media.audio.end - media.audio.start <= 3);
  const audible = await page.evaluate(async data => {
    const context = new AudioContext();
    try { const buffer = await context.decodeAudioData(Uint8Array.from(atob(data), c => c.charCodeAt(0)).buffer); return buffer.getChannelData(0).some(v => Math.abs(v) > 0.001); }
    finally { await context.close(); }
  }, media.audio.data);
  assert.equal(audible, true, 'muting playback must not turn the captured player audio into silence');
  assert.equal(await page.evaluate(() => window.deviceRequests), 0); assert.ok(checks >= 5);
  assert.equal(await page.locator('video').evaluate(v => v.paused), true);
});

test('real browser UI saves media options, switches and logs out at desktop and narrow widths', { skip, timeout: 45000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-browser-ui-')); cpSync(new URL('../web', import.meta.url), join(root, 'web'), { recursive: true });
  const config = new Config(root), store = new Store(root), models = { complete: async () => '测试回复' };
  let state = 'ready', switches = 0, logouts = 0;
  const explorer = { busy: false, status: () => ({ state }), close: async () => {}, resetLogin: async ({ reopen }) => {
    state = reopen ? 'awaiting-login' : 'not-connected'; reopen ? switches++ : logouts++; return { state };
  } };
  const core = new PetCore(config, store, models), autonomy = new Autonomy({ config, store, core, models, explorer });
  const app = createPetServer({ root, config, store, models, core, autonomy }), origin = await serve(app.server);
  let browser;
  t.after(async () => { await browser?.close(); await autonomy.stop(); app.abort(); await close(app.server); store.close(); rmSync(root, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.locator('[data-page="exploration"]').click();
  await page.locator('[name="readImages"]').check(); await page.locator('[name="readVideos"]').check();
  await page.locator('#exploration-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#exploration-result').textContent === '已保存');
  assert.equal(config.value.exploration.readImages, true); assert.equal(config.value.exploration.readVideos, true);
  await page.locator('#xhs-switch').click(); await page.waitForFunction(() => !document.querySelector('#xhs-switch').disabled && document.querySelector('#xhs-status').textContent.includes('等待扫码'));
  assert.equal(switches, 1); assert.equal(config.value.exploration.enabled, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#xhs-logout').click(); await page.waitForFunction(() => !document.querySelector('#xhs-logout').disabled && document.querySelector('#xhs-status').textContent === '尚未登录');
  assert.equal(logouts, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal clipping at 390px');
  assert.deepEqual(errors, []);
});
