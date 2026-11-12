import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { Config } from '../pet/config.mjs';
import { connectBackend } from '../desktop/backend.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));

for (const route of ['home', 'memory']) {
  test(`desktop #${route} waits for configuration before rendering history, including early navigation`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pet-startup-ui-'));
    const config = new Config(root).public();
    const dom = new JSDOM(readFileSync(join(appRoot, 'web/index.html'), 'utf8'), { url: `http://127.0.0.1:3210/#${route}`, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, $ = selector => w.document.querySelector(selector);
    let release, historyRequests = 0;
    const ready = new Promise(resolve => { release = resolve; });
    w.setInterval = () => 0;
    w.AbortController = AbortController; w.AbortSignal = AbortSignal;
    w.fetch = async path => {
      if (path === '/api/state') {
        await ready;
        return new Response(JSON.stringify({ config, sessions: [], wechat: { state: 'stopped' }, qq: { state: 'stopped', contacts: [] } }));
      }
      if (path.startsWith('/api/history')) {
        historyRequests++;
        return new Response(JSON.stringify({ messages: [{ id: 1, role: 'assistant', text: '之前的分享还在这里', origin: 'exploration' }], memories: [] }));
      }
      throw new Error(`Unexpected test request: ${path}`);
    };
    t.after(async () => { release(); await delay(20); w.close(); rmSync(root, { recursive: true, force: true }); });
    for (const script of ['voice.js', 'avatar.js', 'app.js']) w.eval(readFileSync(join(appRoot, 'web', script), 'utf8'));
    // Clicking a tab during slow /api/state must also wait for configuration.
    $(`[data-page="${route}"]`).click();
    assert.equal(historyRequests, 0, 'history must not race ahead of initial configuration');
    release();
    for (let i = 0; i < 200 && $('[name="pet.name"]').value !== '小蓝'; i++) await delay(10);
    assert.equal($('[name="pet.name"]').value, '小蓝');
    for (let i = 0; i < 200 && $(`#page-${route}`).hidden; i++) await delay(10);
    assert.equal($(`#page-${route}`).hidden, false);
    assert.equal($('#chat-error').hidden, true);
    assert.match($('#messages').textContent, /之前的分享还在这里/);
  });
}

test('desktop-owned backend shuts down with a browser connection that has incomplete HTTP headers', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pet-stop-http-'));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  new Config(dataRoot).update({ port });
  let backend, socket;
  t.after(async () => { socket?.destroy(); await backend?.stop(); rmSync(dataRoot, { recursive: true, force: true }); });
  backend = await connectBackend({ appRoot, dataRoot });
  socket = createConnection({ host: '127.0.0.1', port }); socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  await backend.stop();
  assert.equal(existsSync(join(dataRoot, 'data/pet-runtime.json')), false, 'stop removes the runtime file instead of killing the service before cleanup');
  await assert.rejects(fetch(`${backend.url}/api/health`));
});
