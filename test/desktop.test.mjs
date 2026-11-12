import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { JSDOM } from 'jsdom';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { createPetServer } from '../pet/server.mjs';
import { initialBounds, cleanPreferences, clampBounds } from '../desktop/geometry.mjs';
import { validRuntime, connectBackend } from '../desktop/backend.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); } assert.fail('desktop state did not settle'); }

test('desktop position survives DPI-independent layouts and disconnected monitors without going offscreen', () => {
  const displays = [{ id: 1, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }, { id: 2, workArea: { x: 0, y: 0, width: 1280, height: 680 } }];
  const saved = { x: 1800, y: 1100, displayId: 2, size: 'large' };
  const b = initialBounds(saved, displays);
  assert.deepEqual(b, { x: 920, y: 210, width: 360, height: 470 });
  const fallback = initialBounds(saved, [displays[0]]);
  assert.ok(fallback.x + fallback.width <= 0); assert.ok(fallback.y + fallback.height <= 1040);
  assert.deepEqual(cleanPreferences({ size: '../bad', x: Infinity, alwaysOnTop: false, quiet: true }), { size: 'medium', alwaysOnTop: false, quiet: true });
  assert.deepEqual(clampBounds({ x: -500, y: -500, width: 500, height: 600 }, { x: 0, y: 0, width: 300, height: 400 }), { x: 0, y: 0, width: 300, height: 400 });
});

test('desktop runtime metadata rejects credentials, redirects and non-loopback URLs', () => {
  const token = 'a'.repeat(64);
  assert.equal(validRuntime({ url: 'http://127.0.0.1:3210', token }), true);
  for (const url of ['https://example.com', 'http://localhost:3210', 'http://127.0.0.1:3210/api', 'http://secret@127.0.0.1:3210', 'http://127.0.0.1:3210?token=x']) assert.equal(validRuntime({ url, token }), false);
  assert.equal(validRuntime({ url: 'http://127.0.0.1:3210', token: 'short' }), false);
});

test('desktop starts an isolated real backend, reuses it without ownership and stops only its own service', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pet-desktop-runtime-'));
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  new Config(dataRoot).update({ port });
  let owner, reuse;
  t.after(async () => { await owner?.stop(); rmSync(dataRoot, { recursive: true, force: true }); });
  owner = await connectBackend({ appRoot, dataRoot });
  assert.equal(owner.owned, true);
  const page = await fetch(`${owner.url}/desktop`); assert.equal(page.status, 200);
  assert.match(await page.text(), /pet-token/);
  reuse = await connectBackend({ appRoot, dataRoot }); assert.equal(reuse.owned, false);
  await reuse.stop(); assert.equal((await fetch(`${owner.url}/api/health`)).status, 200);
  await owner.stop();
  await assert.rejects(fetch(`${owner.url}/api/health`));
});

test('HD artwork has four nonempty transparent frames and all appearances persist', () => {
  const png = PNG.sync.read(readFileSync(join(appRoot, 'web/assets/taolinghu-hd.png')));
  assert.equal(png.width, 1254); assert.equal(png.height, 1254);
  for (let fy = 0; fy < 2; fy++) for (let fx = 0; fx < 2; fx++) {
    let opaque = 0, transparent = 0;
    for (let y = fy * 627; y < (fy + 1) * 627; y++) for (let x = fx * 627; x < (fx + 1) * 627; x++) {
      const a = png.data[(y * png.width + x) * 4 + 3]; if (a > 240) opaque++; if (a === 0) transparent++;
    }
    assert.ok(opaque > 40000); assert.ok(transparent > 100000);
  }
});

test('desktop bootstrap and API preserve source/token boundary and never expose other conversations', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-desktop-api-'));
  cpSync(join(appRoot, 'web'), join(root, 'web'), { recursive: true });
  const config = new Config(root), store = new Store(root), models = {};
  const core = new PetCore(config, store, models);
  const server = createPetServer({ root, config, store, core, models });
  await new Promise(r => server.server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.abort(); await new Promise(r => server.server.close(r)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.server.address().port}`;
  assert.equal((await fetch(`${url}/desktop`, { headers: { Origin: 'https://foreign.test', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${url}/api/desktop/state`)).status, 401);
  store.ensure('qq:direct:other', 'Other'); store.append('qq:direct:other', 'private', null, 'OTHER-SECRET', 'other');
  store.ensure('web:owner', 'Owner'); store.append('web:owner', 'hello', null, 'OWNER-REPLY', 'owner');
  const result = await (await fetch(`${url}/api/desktop/state`, { headers: { Authorization: `Bearer ${server.token}` } })).json();
  assert.equal(result.reply.text, 'OWNER-REPLY'); assert.ok(!JSON.stringify(result).includes('OTHER-SECRET')); assert.equal(result.config.model, undefined);
  for (const appearance of ['taolinghu', 'taolinghu-classic', 'blue-cat']) { config.update({ pet: { appearance } }); assert.equal(new Config(root).value.pet.appearance, appearance); }

  const html = await (await fetch(`${url}/desktop`)).text();
  const dom = new JSDOM(html, { url: `${url}/desktop`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, $ = s => w.document.querySelector(s); t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  w.fetch = (path, options) => fetch(new URL(path, url), options); w.AbortSignal = AbortSignal; w.crypto.randomUUID = randomUUID;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  let actionListener, opened;
  w.petDesktop = { preferences: async () => ({ size: 'small' }), onAction: cb => { actionListener = cb; return () => {}; }, onPreferences: () => () => {},
    openHome: page => { opened = page; }, drag() {}, hit() {}, menu() {} };
  w.eval(readFileSync(join(root, 'web/avatar.js'), 'utf8')); w.eval(readFileSync(join(root, 'web/desktop.js'), 'utf8'));
  await until(() => $('#bubble').textContent.includes('来陪你'));
  assert.equal($('#bubble').textContent.includes('OWNER-REPLY'), false, 'old replies are not replayed on startup');
  actionListener('feed'); await until(() => core.interactions.status().fullness > 80);
  await until(() => $('#bubble').textContent.includes('饼干'));
  assert.equal(core.interactions.status().bond, 2, 'desktop uses the existing owner care state');
  $('#chat').click(); assert.equal(opened, 'home');
  store.append('web:owner', 'again', null, '<img src=x onerror=alert(1)>', 'again');
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => $('#bubble').textContent.includes('<img'));
  assert.equal($('#bubble img'), null, 'reply markup is rendered as text');
});
