// Opt-in native acceptance; CI runs this on Windows against the packaged exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Config } from '../pet/config.mjs';
import { PNG } from 'pngjs';

test('packaged native pet: transparent window, isolated preload, interaction, appearance and shutdown', { skip: process.env.PET_DESKTOP_TEST !== '1', timeout: 90000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dataRoot = mkdtempSync(join(tmpdir(), 'pet-electron-'));
  const portServer = createServer(); await new Promise(r => portServer.listen(0, '127.0.0.1', r)); const port = portServer.address().port; await new Promise(r => portServer.close(r));
  new Config(dataRoot).update({ port });
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  let app;
  t.after(async () => { await app?.close(); rmSync(dataRoot, { recursive: true, force: true }); });
  app = await electron.launch({ ...(env.PET_DESKTOP_EXECUTABLE ? { executablePath: env.PET_DESKTOP_EXECUTABLE, args: [] } : { args: [root] }), env: { ...env, PET_DATA_ROOT: dataRoot }, timeout: 30000 });
  const pet = await app.firstWindow(); await pet.waitForURL(`http://127.0.0.1:${port}/desktop`);
  await pet.waitForFunction(() => document.querySelector('#bubble').textContent.includes('来陪你'));
  await pet.waitForFunction(() => document.querySelector('#pet-sprite-sheet').naturalWidth === 1254);
  const artifacts = join(root, 'dist', 'desktop-qa'); mkdirSync(artifacts, { recursive: true });
  const screenshot = await pet.screenshot({ path: join(artifacts, 'desktop-hd.png'), omitBackground: true });
  const image = PNG.sync.read(screenshot);
  assert.equal(image.data[3], 0, 'the empty corner remains transparent');
  assert.ok(image.data.some((value, index) => index % 4 === 3 && value > 240), 'pet pixels are visible');
  const native = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0], prefs = win.webContents.getLastWebPreferences();
    return { node: prefs.nodeIntegration, isolated: prefs.contextIsolation, sandbox: prefs.sandbox, top: win.isAlwaysOnTop(), background: win.getBackgroundColor(), resizable: win.isResizable(), bounds: win.getBounds() };
  });
  assert.equal(native.node, false); assert.equal(native.isolated, true); assert.equal(native.sandbox, true); assert.equal(native.top, true);
  // getBackgroundColor returns RGB on Windows even for a transparent window.
  assert.match(native.background, /^#000000(?:00)?$/); assert.equal(native.resizable, false);
  assert.equal(await pet.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await pet.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
  await pet.locator('#pet-character').press('Enter'); await pet.waitForFunction(() => document.querySelector('#bubble').textContent.includes('手心') || document.querySelector('#bubble').textContent.includes('耳朵'));
  const original = await pet.evaluate(() => window.petDesktop.preferences()); assert.equal(original.size, 'medium');
  await pet.screenshot({ path: join(artifacts, 'desktop-hd.png'), omitBackground: true });
  const roomReady = app.waitForEvent('window');
  await pet.locator('#chat').click();
  const room = await roomReady;
  assert.ok(room); await room.waitForLoadState(); await room.locator('[data-page="settings"]').click();
  await room.waitForFunction(() => document.querySelector('[name="pet.name"]').value === '小蓝');
  await room.locator('[name="pet.appearance"]').selectOption('taolinghu-classic'); await room.locator('#settings-form button[type="submit"]').click();
  await pet.waitForFunction(() => document.querySelector('#pet-character').dataset.appearance === 'taolinghu-classic');
  await room.locator('[name="pet.appearance"]').selectOption('taolinghu'); await room.locator('#settings-form button[type="submit"]').click();
  await room.setViewportSize({ width: 460, height: 800 });
  assert.equal(await room.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await room.screenshot({ path: join(artifacts, 'settings-narrow.png') });
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  await app.close().catch(() => {}); app = null;
  const settings = JSON.parse(readFileSync(join(dataRoot, 'desktop.settings.json'), 'utf8')); assert.equal(settings.size, 'medium');
  assert.equal(existsSync(join(dataRoot, 'data/pet-runtime.json')), false, 'owned service shuts down gracefully');
});
