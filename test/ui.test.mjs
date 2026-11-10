// DOM integration tests exercise our UI against the actual local HTTP server.
// They do not replace visual/browser or real account acceptance testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { PNG } from 'pngjs';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { Models } from '../pet/model.mjs';
import { PetCore } from '../pet/core.mjs';
import { createPetServer } from '../pet/server.mjs';

async function until(predicate, label) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(10); }
  assert.fail(`UI did not reach expected state: ${label}`);
}

test('web setup, text/image chat, memory management and error states work against real local APIs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-ui-'));
  cpSync(new URL('../web', import.meta.url), join(root, 'web'), { recursive: true });
  const config = new Config(root), store = new Store(root), calls = [];
  const models = new Models(config, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '测试回复 <img src=x onerror=alert(1)>' } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const core = new PetCore(config, store, models), app = createPetServer({ root, config, store, core, models });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const html = await (await fetch(url)).text();
  const errors = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const w = dom.window, $ = selector => w.document.querySelector(selector);
  w.fetch = (path, options) => fetch(new URL(path, url), options);
  w.crypto.randomUUID = randomUUID;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  t.after(async () => { w.close(); app.abort(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  w.eval(readFileSync(join(root, 'web', 'app.js'), 'utf8'));
  await until(() => $('#model-status').textContent === '等待配置模型', 'initial setup');
  await until(() => $('[name="pet.name"]').value === '小蓝', 'settings populated');
  assert.equal($('#setup-note').hidden, false);

  $('[data-page="settings"]').click();
  assert.equal($('#page-home').hidden, true);
  $('[name="pet.name"]').value = '团子';
  $('[name="model.apiKey"]').value = 'UI-TEST-KEY';
  $('#settings-form button[type="submit"]').click();
  await until(() => $('#settings-result').textContent.includes('已保存'), 'settings saved');
  assert.equal(config.value.pet.name, '团子'); assert.equal(config.provider('model').apiKey, 'UI-TEST-KEY');
  assert.equal($('[name="model.apiKey"]').value, '', 'saved key is never echoed into the password field');

  $('[data-page="home"]').click();
  $('#message-input').value = '你好'; $('#send-button').click();
  await until(() => store.history('web:owner').length === 2 && !$('#send-button').disabled, 'first reply');
  assert.match($('#messages').textContent, /测试回复/);
  assert.equal($('#messages img'), null, 'model HTML must remain plain text');
  assert.match(calls[0].messages[0].content, /团子/);

  const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
  const file = new w.File([png], 'photo.png', { type: 'image/png' });
  Object.defineProperty($('#image-input'), 'files', { value: [file], configurable: true });
  $('#image-input').dispatchEvent(new w.Event('change'));
  await until(() => !$('#attachment-preview').hidden, 'image preview');
  $('#send-button').click();
  await until(() => store.history('web:owner').length === 4 && !$('#send-button').disabled, 'image reply');
  assert.ok(calls[1].messages.at(-1).content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal($('#attachment-preview').hidden, true);

  $('#voice-button').click();
  assert.match($('#toast').textContent, /语音识别/);
  $('#sleep-button').click(); assert.ok($('#pet-character').classList.contains('sleeping'));
  $('#pat-button').click(); assert.ok(!$('#pet-character').classList.contains('sleeping'));

  $('[data-page="memory"]').click();
  await until(() => $('#memory-list').textContent.includes('空的'), 'memory page');
  $('#memory-input').value = '我喜欢简单的回答'; $('#memory-form button').click();
  await until(() => $('#memory-list').textContent.includes('我喜欢简单的回答'), 'remembered fact');
  assert.equal(store.memories('web:owner').length, 1);

  $('[data-page="home"]').click(); $('#clear-chat').click();
  assert.ok($('#confirm-dialog').hasAttribute('open'));
  $('#confirm-clear').click();
  await until(() => !$('#confirm-dialog').hasAttribute('open') && store.history('web:owner').length === 0, 'clear history');
  assert.equal(store.memories('web:owner').length, 1, 'clearing conversation keeps explicitly saved memory');
  $('[data-page="memory"]').click();
  await until(() => Boolean($('#memory-list button')), 'memory delete control');
  $('#memory-list button').click();
  await until(() => store.memories('web:owner').length === 0, 'forget fact');
  assert.deepEqual(errors, []);
});
