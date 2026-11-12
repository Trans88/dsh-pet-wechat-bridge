// Real local HTTP and DOM, with an intentionally unresponsive QQ transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { QQBridge } from '../pet/qq.mjs';
import { createPetServer } from '../pet/server.mjs';

async function until(fn, label) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await delay(10); }
  assert.fail(`QQ UI did not reach: ${label}`);
}
async function fixture(t, connectionTimeoutMs = 60000) {
  const root = mkdtempSync(join(tmpdir(), 'pet-qq-ui-'));
  cpSync(new URL('../web', import.meta.url), join(root, 'web'), { recursive: true });
  const config = new Config(root), store = new Store(root), bots = [];
  config.update({ qq: { appId: '123456', appSecret: 'PRIVATE-QQ-TEST' } });
  const models = { complete: async () => assert.fail('UI checks must not call a model') };
  const core = new PetCore(config, store, models);
  const qq = new QQBridge({ config, store, core, connectionTimeoutMs, factory: async () => {
    const bot = { handlers: {}, on(event, fn) { this.handlers[event] = fn; },
      start() { return new Promise(() => {}); }, stop() {} };
    bots.push(bot); return bot;
  } });
  const app = createPetServer({ root, config, store, core, models, qq });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`, errors = [];
  const console = new VirtualConsole(); console.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(await (await fetch(url)).text(), { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const w = dom.window, $ = selector => w.document.querySelector(selector);
  w.fetch = (path, options) => fetch(new URL(path, url), options); w.setInterval = () => 0;
  w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  const style = w.document.createElement('style'); style.textContent = readFileSync(join(root, 'web', 'style.css'), 'utf8'); w.document.head.append(style);
  t.after(async () => { w.close(); await qq.stop(); app.abort(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  w.eval(readFileSync(join(root, 'web', 'voice.js'), 'utf8'));
  w.eval(readFileSync(join(root, 'web', 'app.js'), 'utf8'));
  await until(() => $('#qq-form [name="appId"]').value === '123456', 'initial state')
    .catch(error => { throw new Error(`${error.message}; ${$('#chat-error').textContent}; ${errors.join('; ')}`, { cause: error }); });
  $('[data-page="channels"]').click();
  const refresh = async () => { $('#qq-refresh').click(); await until(() => !$('#qq-refresh').disabled, 'status refresh'); };
  return { qq, bots, w, $, refresh, errors };
}

test('QQ UI shows waiting, cancel, connected without busy cursor, and an empty allowlist next step', async t => {
  const { qq, bots, w, $, refresh, errors } = await fixture(t);
  $('#qq-start').click();
  await until(() => qq.state === 'starting' && !$('#qq-stop').disabled, 'connecting controls');
  assert.equal($('#qq-start').textContent, '正在连接…');
  assert.equal($('#qq-start').getAttribute('aria-busy'), 'true');
  assert.equal($('#qq-stop').textContent, '取消连接');
  assert.match($('#qq-connection-detail').textContent, /最长 60 秒/);
  $('#qq-stop').click();
  await until(() => !$('#qq-start').disabled, 'cancelled even though SDK start is pending');
  assert.equal($('#qq-start').textContent, '连接 QQ');
  bots[0].handlers.ready(); await refresh();
  assert.equal($('#qq-status').textContent, '未连接');

  $('#qq-start').click(); await until(() => bots.length === 2 && !$('#qq-stop').disabled, 'retry');
  bots[1].handlers.ready(); await refresh();
  assert.equal($('#qq-start').textContent, '已连接 QQ'); assert.equal($('#qq-start').disabled, true);
  assert.equal($('#qq-start').getAttribute('aria-busy'), 'false');
  assert.equal(w.getComputedStyle($('#qq-start')).cursor, 'default', 'disabled connected button is not a wait cursor');
  assert.match($('#qq-connection-detail').textContent, /名单还是空的.*OpenID/);
  assert.equal($('#qq-error').hidden, true);
  bots[1].handlers.disconnected({ willReconnect: true }); await refresh();
  assert.equal($('#qq-start').textContent, '正在重连…');
  bots[1].handlers.resumed(); await refresh();
  assert.equal($('#qq-start').textContent, '已连接 QQ');
  assert.deepEqual(errors, []);
});

test('QQ deadline displays a persistent nearby error and enables retry after a stuck handshake', async t => {
  const { qq, bots, $, refresh, errors } = await fixture(t, 1000);
  $('#qq-start').click();
  await until(() => bots.length > 0, 'SDK created');
  bots[0].handlers.error(new Error('Token fetch failed: HTTP 403 — PRIVATE-QQ-TEST'));
  await until(() => qq.state === 'error', 'deadline'); await refresh();
  assert.equal($('#qq-start').disabled, false); assert.equal($('#qq-start').textContent, '重试连接');
  assert.equal($('#qq-start').getAttribute('aria-busy'), 'false');
  assert.equal($('#qq-error').hidden, false); assert.match($('#qq-error').textContent, /等待超过.*HTTP 403/);
  assert.ok(!$('#qq-error').textContent.includes('PRIVATE-QQ-TEST'));
  assert.equal($('#qq-connection-detail').nextElementSibling.id, 'qq-error', 'error is beside controls, not above the long form');
  assert.deepEqual(errors, []);
});

test('a stalled local control response times out, leaves no busy controls and can recover by refreshing', async t => {
  const { w, $, errors } = await fixture(t);
  const realFetch = w.fetch, realTimeout = w.setTimeout.bind(w);
  // Accelerate only the local control deadline, preserving UI/animation timers.
  w.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 12000 ? 40 : ms, ...args);
  let aborted = false;
  w.fetch = (path, options) => path === '/api/qq/start' ? new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
  }) : realFetch(path, options);
  $('#qq-start').click();
  await until(() => aborted && !$('#qq-refresh').disabled, 'local request timeout');
  assert.equal($('#qq-status').textContent, '状态暂不可用');
  assert.equal($('#qq-start').getAttribute('aria-busy'), 'false');
  assert.match($('#qq-error').textContent, /本地宠物服务超过 12 秒未响应/);
  w.fetch = realFetch; w.setTimeout = realTimeout;
  $('#qq-refresh').click(); await until(() => !$('#qq-start').disabled, 'status recovered');
  assert.equal($('#qq-start').textContent, '连接 QQ'); assert.equal($('#qq-error').hidden, true);
  assert.deepEqual(errors, []);
});
