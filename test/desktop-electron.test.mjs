// Opt-in native acceptance; CI runs this on Windows against the packaged exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, connect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Config } from '../pet/config.mjs';
import { PNG } from 'pngjs';

test('packaged native pet: transparent window, isolated preload, interaction, appearance and shutdown', { skip: process.env.PET_DESKTOP_TEST !== '1', timeout: 120000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dataRoot = mkdtempSync(join(tmpdir(), 'pet-electron-'));
  const portServer = createServer(); await new Promise(r => portServer.listen(0, '127.0.0.1', r)); const port = portServer.address().port; await new Promise(r => portServer.close(r));
  let textCalls = 0, sttCalls = 0, ttsCalls = 0, searchCalls = 0, searchStatus = 200, proxyCalls = 0;
  const longReply = Array.from({ length: 38 }, (_, index) => `第 ${index + 1} 行：长回复可以从头看到最后，读完再继续聊。`).join('\n') + '\n完整回复结尾 FULL_END';
  const audio = Buffer.from(readFileSync(join(root, 'test/fixtures/desktop-tone.mp3.base64'), 'utf8').trim(), 'base64');
  const provider = createHttpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/v1/chat/completions') {
      textCalls++; const body = JSON.parse(Buffer.concat(chunks));
      const content = body.messages[0].content.includes('私密日记') ? JSON.stringify({ title: '桌面上的新朋友', text: '今天，我们一起试了桌面聊天，还说了几句话。\n\n主人让我找点有趣的，我带着一份搜索摘要回来了。这些小小的尝试，都收进这一页。' }) : body.messages.at(-1).content.includes('长回复') ? longReply : /搜索|网上/.test(body.messages.at(-1).content) ? '找到一个有趣的开源小项目，可以先看看这个介绍。[1]' : '听到了，这是桌面语音测试回复。';
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    if (req.url === '/v1/search') { searchCalls++; res.statusCode = searchStatus; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ results: [{ title: '创意小项目 · 示例来源', url: 'https://example.org/projects', content: '这里介绍了一种有趣的桌面小项目。' }] })); }
    if (req.url === '/v1/audio/transcriptions') { sttCalls++; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ text: '在桌面说一句话' })); }
    if (req.url === '/v1/audio/speech') { ttsCalls++; res.setHeader('Content-Type', 'audio/mpeg'); return res.end(audio); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const proxy = createHttpServer();
  proxy.on('connect', (req, socket, head) => {
    proxyCalls++; assert.equal(req.url, `127.0.0.1:${provider.address().port}`);
    const upstream = connect(provider.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket); });
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  new Config(dataRoot).update({ port, model: { baseUrl, model: 'fake-chat', apiKey: 'test-only' },
    stt: { enabled: true, baseUrl, model: 'fake-stt', apiKey: 'test-only' }, tts: { enabled: true, baseUrl, model: 'fake-tts', apiKey: 'test-only' },
    voice: { input: 'server', output: 'server' }, search: { enabled: true, baseUrl, apiKey: 'test-search', proxyUrl: `http://127.0.0.1:${proxy.address().port}` } });
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  let app;
  t.after(async () => { await app?.close(); provider.closeAllConnections(); proxy.closeAllConnections(); await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => proxy.close(resolve))]); rmSync(dataRoot, { recursive: true, force: true }); });
  const mediaFlags = ['--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'];
  app = await electron.launch({ ...(env.PET_DESKTOP_EXECUTABLE ? { executablePath: env.PET_DESKTOP_EXECUTABLE, args: mediaFlags } : { args: [root, ...mediaFlags] }), env: { ...env, PET_DATA_ROOT: dataRoot }, timeout: 30000 });
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
  await pet.locator('#chat').click();
  const expanded = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.ok(expanded.width > native.bounds.width && expanded.height > native.bounds.height);
  assert.equal(expanded.x + expanded.width, native.bounds.x + native.bounds.width, 'expanding keeps the right edge anchored');
  assert.equal(expanded.y + expanded.height, native.bounds.y + native.bounds.height, 'expanding keeps the bottom edge anchored');
  await pet.locator('#desktop-input').fill('请给我一段长回复');
  await pet.locator('#desktop-send').click();
  await pet.waitForFunction(() => document.querySelector('#desktop-messages').textContent.includes('FULL_END'));
  assert.equal(app.windows().length, 1, 'desktop chat does not open the room');
  assert.equal(textCalls, 1);
  assert.equal(await pet.locator('#desktop-chat-error').isVisible(), false);
  assert.equal(await pet.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await pet.screenshot({ path: join(artifacts, 'desktop-chat.png'), omitBackground: true });
  const historyTop = await pet.locator('#desktop-messages').evaluate(element => element.scrollTop);
  assert.ok(historyTop > 0, 'long reply automatically scrolls to its end');
  await pet.locator('#desktop-messages').hover(); await pet.mouse.wheel(0, -1500);
  await pet.waitForFunction(top => document.querySelector('#desktop-messages').scrollTop < top, historyTop);
  await pet.locator('#conversation-close').click();
  await pet.locator('#bubble-text').hover(); await pet.mouse.wheel(0, 1500);
  await pet.waitForFunction(() => document.querySelector('#bubble-text').scrollTop > 0);
  assert.equal(await pet.locator('#bubble-text').textContent(), longReply, 'bubble keeps the entire reply');
  await pet.screenshot({ path: join(artifacts, 'desktop-long-bubble.png'), omitBackground: true });
  await pet.evaluate(() => {
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.testAudioTracks = [];
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await getMedia(constraints); window.testAudioTracks.push(...stream.getTracks()); return stream; };
  });
  const video = await pet.evaluate(async () => { try { const stream = await navigator.mediaDevices.getUserMedia({ video: true }); stream.getTracks().forEach(track => track.stop()); return 'allowed'; } catch (error) { return error.name; } });
  assert.equal(video, 'NotAllowedError', 'camera remains denied');
  assert.equal(await pet.evaluate(() => window.testAudioTracks.length), 0, 'no microphone is opened just by chatting');
  await pet.locator('#voice').click();
  await pet.waitForFunction(() => document.querySelector('#desktop-voice-status').dataset.phase === 'listening');
  await pet.screenshot({ path: join(artifacts, 'desktop-voice.png'), omitBackground: true });
  await pet.locator('#voice-finish').click();
  await pet.waitForFunction(() => document.querySelector('#desktop-messages').textContent.includes('在桌面说一句话'));
  await pet.waitForFunction(() => document.querySelector('#desktop-voice-status').dataset.phase === 'listening');
  assert.equal(sttCalls, 1); assert.equal(ttsCalls, 1);
  await pet.locator('#conversation-close').click();
  await pet.waitForFunction(() => window.testAudioTracks.length >= 2 && window.testAudioTracks.every(track => track.readyState === 'ended'));
  assert.equal(app.windows().length, 1, 'voice chat also stays in the pet window');
  await pet.locator('#chat').click();
  await pet.locator('#desktop-input').fill('再帮我看下网上有什么趣事'); await pet.locator('#desktop-send').click();
  await pet.waitForFunction(() => document.querySelector('.desktop-source')?.textContent.includes('示例来源'));
  assert.equal(searchCalls, 1);
  assert.equal(proxyCalls, 1, 'packaged backend actually uses the configured proxy');
  assert.match(await pet.locator('.message-search').last().textContent(), /已联网搜索.*1 条摘要/);
  assert.equal(await pet.locator('.desktop-source').getAttribute('href'), 'https://example.org/projects');
  await app.evaluate(({ shell }) => { globalThis.testOpenedSource = ''; shell.openExternal = async url => { globalThis.testOpenedSource = url; }; });
  await pet.locator('.desktop-source').click();
  assert.equal(await app.evaluate(() => globalThis.testOpenedSource), 'https://example.org/projects');
  await pet.screenshot({ path: join(artifacts, 'desktop-search.png'), omitBackground: true });
  const roomReady = app.waitForEvent('window');
  await pet.locator('#open-home').click();
  const room = await roomReady;
  assert.ok(room); await room.waitForLoadState();
  await room.waitForFunction(() => document.querySelector('[name="pet.name"]').value === '小蓝');
  assert.equal(await room.locator('#chat-error').isVisible(), false, 'desktop #home initializes without a config race');
  await room.locator('[data-page="settings"]').click();
  await room.waitForFunction(() => document.querySelector('[name="pet.name"]').value === '小蓝');
  await room.locator('[name="pet.appearance"]').selectOption('taolinghu-classic'); await room.locator('#settings-form button[type="submit"]').click();
  await pet.waitForFunction(() => document.querySelector('#pet-character').dataset.appearance === 'taolinghu-classic');
  await room.locator('[name="pet.appearance"]').selectOption('haru-live2d'); await room.locator('#settings-form button[type="submit"]').click();
  await pet.waitForSelector('.pet-live2d[data-state="ready"]', { timeout: 20000 });
  await pet.waitForFunction(() => Number(document.querySelector('.pet-live2d')?.dataset.frames) > 5);
  const liveFrame = await pet.locator('.pet-live2d').getAttribute('data-frames');
  await pet.waitForFunction(before => Number(document.querySelector('.pet-live2d')?.dataset.frames) > Number(before) + 5, liveFrame);
  const cursor = await pet.evaluate(() => window.petDesktop.cursor());
  assert.ok(Number.isFinite(cursor.x) && Number.isFinite(cursor.y), 'sandboxed desktop can follow the native cursor');
  const liveImage = PNG.sync.read(await pet.screenshot({ path: join(artifacts, 'desktop-live2d.png'), omitBackground: true }));
  assert.equal(liveImage.data[3], 0, 'Live2D preserves the transparent desktop');
  const mesh = PNG.sync.read(await pet.locator('.pet-live2d').screenshot({ path: join(artifacts, 'live2d-model.png'), omitBackground: true }));
  assert.ok(mesh.data.filter((v, i) => i % 4 === 3 && v > 100).length > 500, 'packaged Cubism draws visible model pixels');
  const isVisible = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/desktop')); win.hide(); return win.isVisible();
  });
  assert.equal(isVisible, false);
  // A hidden Chromium window does not service rAF polling; use timer polling here.
  // The native host signal also works when automation forces document.hidden=false.
  await pet.waitForFunction(() => document.querySelector('.pet-live2d')?.dataset.paused === 'true', undefined, { polling: 100 }).catch(async error => {
    console.log('Native visibility:', await pet.evaluate(() => ({ hidden: document.hidden, paused: document.querySelector('.pet-live2d')?.dataset.paused, frames: document.querySelector('.pet-live2d')?.dataset.frames })));
    throw error;
  });
  const pausedFrame = await pet.locator('.pet-live2d').getAttribute('data-frames'); await pet.waitForTimeout(350);
  assert.equal(await pet.locator('.pet-live2d').getAttribute('data-frames'), pausedFrame, 'hidden native window stops the animation loop');
  assert.equal(await pet.evaluate(() => window.petDesktop.cursor()), null, 'hidden pet does not receive native cursor positions');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/desktop')).show());
  await pet.waitForFunction(() => document.querySelector('.pet-live2d')?.dataset.paused === 'false');
  await pet.waitForFunction(before => Number(document.querySelector('.pet-live2d')?.dataset.frames) > Number(before) + 4, pausedFrame);
  await room.locator('[name="pet.appearance"]').selectOption('taolinghu'); await room.locator('#settings-form button[type="submit"]').click();
  await pet.waitForFunction(() => !document.querySelector('.pet-live2d') && document.querySelector('#pet-character').dataset.appearance === 'taolinghu');
  await room.setViewportSize({ width: 460, height: 800 });
  assert.equal(await room.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await room.screenshot({ path: join(artifacts, 'settings-narrow.png') });
  searchStatus = 432; await room.locator('#search-test').click();
  await room.waitForFunction(() => document.querySelector('#search-result').textContent.includes('HTTP 432'));
  assert.equal(proxyCalls, 2); assert.equal(searchCalls, 2);
  assert.equal(await room.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await room.screenshot({ path: join(artifacts, 'search-error-narrow.png') });
  searchStatus = 200;
  await room.locator('[data-page="memory"]').click();
  await room.locator('#memory-input').fill('我喜欢桌面上的小伙伴'); await room.locator('#memory-form button').click();
  await room.waitForFunction(() => document.querySelector('#memory-list').textContent.includes('我喜欢桌面上的小伙伴'));
  await room.locator('.memory-item button').filter({ hasText: '编辑' }).click();
  await room.getByLabel('编辑记忆内容').fill('我喜欢自然的聊天'); await room.locator('.memory-item button').filter({ hasText: '保存' }).click();
  await room.waitForFunction(() => document.querySelector('#memory-list').textContent.includes('我喜欢自然的聊天'));
  assert.equal(await room.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await room.screenshot({ path: join(artifacts, 'memory-narrow.png') });
  await room.locator('[data-page="diary"]').click();
  await room.locator('#diary-write').click();
  await room.waitForFunction(() => document.querySelector('#diary-list').textContent.includes('桌面上的新朋友'));
  assert.equal(await room.locator('#diary-list article').count(), 1);
  assert.equal(await room.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await room.screenshot({ path: join(artifacts, 'diary-narrow.png') });
  await room.setViewportSize({ width: 1180, height: 820 });
  await room.screenshot({ path: join(artifacts, 'diary-desktop.png') });
  await room.locator('#diary-write').click(); await room.waitForFunction(() => document.querySelector('#diary-result').textContent.includes('已经有日记'));
  await room.locator('#diary-list button').filter({ hasText: '删除' }).click(); await room.locator('#diary-delete-confirm').click();
  await room.waitForFunction(() => !document.querySelector('#diary-list article'));
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  await app.close().catch(() => {}); app = null;
  const settings = JSON.parse(readFileSync(join(dataRoot, 'desktop.settings.json'), 'utf8')); assert.equal(settings.size, 'medium');
  assert.equal(existsSync(join(dataRoot, 'data/pet-runtime.json')), false, 'owned service shuts down gracefully');
});
