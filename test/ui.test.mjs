// DOM integration tests exercise our UI against the actual local HTTP server.
// They do not replace visual/browser or real account acceptance testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom';
import { PNG } from 'pngjs';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { Models } from '../pet/model.mjs';
import { PetCore } from '../pet/core.mjs';
import { createPetServer } from '../pet/server.mjs';

async function until(predicate, label) {
  for (let n = 0; n < 300; n++) { if (predicate()) return; await delay(10); }
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
  // Match the controller realm to Node fetch, just as browser fetch does.
  w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  // This test drives refreshes through UI actions; don't leave background polls at teardown.
  w.setInterval = () => 0;
  w.crypto.randomUUID = randomUUID;
  let motionListener;
  const motionPreference = { matches: false, addEventListener: (_event, listener) => { motionListener = listener; } };
  w.matchMedia = () => motionPreference;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  t.after(async () => { w.close(); app.abort(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  w.eval(readFileSync(join(root, 'web', 'voice.js'), 'utf8'));
  w.eval(readFileSync(join(root, 'web', 'avatar.js'), 'utf8'));
  w.eval(readFileSync(join(root, 'web', 'app.js'), 'utf8'));
  await until(() => $('#model-status').textContent === '等待配置模型', 'initial setup');
  await until(() => $('[name="pet.name"]').value === '小蓝', 'settings populated');
  assert.equal($('#setup-note').hidden, false);
  assert.equal($('#pet-character').dataset.appearance, 'taolinghu');
  assert.equal($('#pet-sprite').hidden, false);
  assert.equal($('#pet-cat').hasAttribute('hidden'), true);
  await until(() => $('#pet-sprite-sheet').style.left !== '0%', 'idle animation advances');
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  const pausedFrame = $('#pet-sprite-sheet').style.left;
  await delay(350);
  assert.equal($('#pet-sprite-sheet').style.left, pausedFrame, 'background tabs pause animation');
  motionPreference.matches = true; motionListener();
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: false });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await delay(350);
  assert.equal($('#pet-sprite-sheet').style.left, '0%', 'reduced motion holds a still frame');
  motionPreference.matches = false; motionListener();
  await until(() => $('#pet-sprite-sheet').style.left !== '0%', 'animation resumes');

  $('[data-page="settings"]').click();
  assert.equal($('#page-home').hidden, true);
  $('[name="pet.name"]').value = '团子';
  $('[name="pet.appearance"]').value = 'blue-cat';
  $('[name="model.apiKey"]').value = 'UI-TEST-KEY';
  $('#settings-form button[type="submit"]').click();
  await until(() => $('#settings-result').textContent.includes('已保存'), 'settings saved');
  assert.equal(config.value.pet.name, '团子'); assert.equal(config.provider('model').apiKey, 'UI-TEST-KEY');
  assert.equal($('[name="model.apiKey"]').value, '', 'saved key is never echoed into the password field');
  assert.equal(config.value.pet.appearance, 'blue-cat');
  assert.equal($('#pet-sprite').hidden, true);
  assert.equal($('#pet-cat').hasAttribute('hidden'), false, 'SVG must be visible after switching back');
  $('[name="pet.appearance"]').value = 'taolinghu';
  $('#settings-form button[type="submit"]').click();
  await until(() => $('#settings-result').textContent.includes('已保存'), 'fox appearance saved');
  assert.equal(config.value.pet.appearance, 'taolinghu');
  assert.equal($('#pet-character').dataset.appearance, 'taolinghu');

  $('[data-page="home"]').click();
  $('#message-input').value = '你好'; $('#send-button').click();
  assert.equal($('#pet-character').dataset.animation, 'thinking');
  assert.equal($('#pet-sprite-sheet').style.top, '0%');
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
  await until(() => $('#toast').textContent.includes('语音识别'), 'unsupported speech recognition is explained');
  assert.match($('#toast').textContent, /语音识别/);
  $('#sleep-button').click(); await until(() => $('#pet-character').classList.contains('sleeping'), 'sleep state persisted');
  assert.equal($('#pet-character').dataset.animation, 'sleeping');
  assert.equal($('#pet-sprite-sheet').style.top, '-100%');
  assert.equal($('#pet-sprite-sheet').style.left, '-100%');
  await until(() => !$('#pat-button').disabled, 'interaction cooldown finished');
  $('#pat-button').click(); await until(() => !$('#pet-character').classList.contains('sleeping'), 'pat wakes pet');
  assert.equal($('#pet-character').dataset.animation, 'petting');
  assert.equal($('#pet-sprite-sheet').style.top, '-100%');
  assert.equal($('#bond-value').textContent, '1');
  assert.match($('#care-journal').textContent, /摸摸头/);
  await until(() => !$('#pat-button').disabled, 'pat finished');
  $('[data-interaction="feed"]').click();
  await until(() => Number($('#fullness-value').textContent) > 80, 'feeding updates fullness');
  assert.equal($('#pet-character').dataset.interaction, 'feed');
  assert.equal(calls.length, 2, 'pet interactions never call the model');
  $('[data-page="channels"]').click();
  $('#qq-form [name="appId"]').value = '123456';
  $('#qq-form [name="appSecret"]').value = 'UI-QQ-SECRET';
  $('#qq-form [name="allowedUsers"]').value = 'person1\nperson2';
  $('#qq-form button[type="submit"]').click();
  await until(() => $('#qq-result').textContent.includes('已保存'), 'QQ settings saved');
  assert.equal(config.value.qq.appSecret, 'UI-QQ-SECRET');
  assert.deepEqual(config.value.qq.allowedUsers, ['person1', 'person2']);
  assert.equal($('#qq-form [name="appSecret"]').value, '', 'QQ secret never echoed');

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
  $('#memory-list').replaceChildren();
  $('[data-page="memory"]').click();
  await until(() => Boolean($('#memory-list button')), 'memory delete control');
  $('#memory-list button').click();
  await until(() => store.memories('web:owner').length === 0 && $('#memory-list').textContent.includes('空的'), 'forget fact rendered');
  $('#pet-sprite-sheet').dispatchEvent(new w.Event('error'));
  assert.equal($('#pet-character').dataset.appearance, 'blue-cat');
  assert.equal($('#pet-cat').hasAttribute('hidden'), false);
  assert.match($('#toast').textContent, /图片未能加载/);
  assert.equal(config.value.pet.appearance, 'taolinghu', 'temporary image failure must not overwrite the saved selection');
  assert.deepEqual(errors, []);
});

for (const [label, sourceHeaders] of [
  ['opaque origin with same-origin metadata', { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }],
  ['opaque origin without metadata', { Origin: 'null' }],
  ['opaque origin with cross-site metadata', { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }],
  ['rewritten origin with same-site metadata', { Origin: 'https://rewritten.test', 'Sec-Fetch-Site': 'same-site' }],
]) {
test(`HTTP-loaded homepage can initialize, save settings and chat: ${label}`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-ui-load-'));
  cpSync(new URL('../web', import.meta.url), join(root, 'web'), { recursive: true });
  const config = new Config(root), store = new Store(root);
  const models = new Models(config, async () => new Response(JSON.stringify({ choices: [{ message: { content: '本地接口测试回复' } }] }), { headers: { 'Content-Type': 'application/json' } }));
  const core = new PetCore(config, store, models);
  const app = createPetServer({ root, config, store, models, core });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const loaded = [], errors = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  class Assets extends ResourceLoader {
    fetch(resource, options) {
      const path = new URL(resource).pathname;
      if (!['/app.js', '/avatar.js', '/voice.js', '/style.css'].includes(path)) return super.fetch(resource, options);
      const controller = new AbortController();
      const result = (async () => {
        // Exercise headers that previously made a public asset return 403 JSON.
        const response = await fetch(resource, { headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, signal: controller.signal });
        assert.equal(response.status, 200);
        assert.ok(response.headers.get('content-type').startsWith(path.endsWith('.js') ? 'text/javascript' : 'text/css'));
        loaded.push(path);
        return Buffer.from(await response.arrayBuffer());
      })();
      result.abort = () => controller.abort();
      return result;
    }
  }
  let dom;
  t.after(async () => { dom?.window.close(); app.abort(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  dom = await JSDOM.fromURL(url, {
    runScripts: 'dangerously', resources: new Assets(), pretendToBeVisual: true, virtualConsole: console,
    beforeParse(w) {
      w.fetch = (path, options = {}) => fetch(new URL(path, url), { ...options, headers: { ...options.headers, ...sourceHeaders } });
      w.AbortController = AbortController; w.AbortSignal = AbortSignal;
      w.setInterval = () => 0;
      w.crypto.randomUUID = randomUUID;
    },
  });
  const $ = selector => dom.window.document.querySelector(selector);
  await until(() => $('[name="pet.name"]').value === '小蓝', 'HTTP-loaded application initialized');
  assert.deepEqual(loaded.sort(), ['/app.js', '/avatar.js', '/style.css', '/voice.js']);
  assert.ok(dom.window.document.styleSheets.length > 0);
  $('[data-page="settings"]').click();
  assert.equal($('#page-settings').hidden, false); assert.equal($('#page-home').hidden, true);
  $('[name="pet.name"]').value = '正常加载的小蓝';
  $('[name="model.apiKey"]').value = 'HTTP-UI-TEST-KEY';
  $('#settings-form button[type="submit"]').click();
  await until(() => $('#settings-result').textContent.includes('已保存'), 'settings saved after resource load');
  assert.equal(config.value.pet.name, '正常加载的小蓝');
  $('[data-page="home"]').click();
  $('#message-input').value = '你好'; $('#send-button').click();
  await until(() => store.history('web:owner').length === 2 && !$('#send-button').disabled, 'chat completed after resource load');
  assert.match($('#messages').textContent, /本地接口测试回复/);
  assert.equal($('#chat-error').hidden, true);
  assert.deepEqual(errors, []);
});
}

// Mock only the browser's speech devices; chat/config/history still use the real
// HTTP handlers, model adapter and SQLite store. No real microphone or API key.
function speechDevices(w) {
  const recognizers = [], spoken = [];
  let cancelCount = 0;
  class Recognition {
    constructor() { this.running = false; this.aborted = false; recognizers.push(this); }
    start() { this.running = true; queueMicrotask(() => { if (this.running) this.onstart?.(); }); }
    stop() { this.running = false; queueMicrotask(() => this.onend?.()); }
    abort() { this.aborted = true; this.stop(); }
    final(text) {
      this.onspeechstart?.();
      const result = [{ transcript: text }]; result.isFinal = true;
      this.onresult?.({ resultIndex: 0, results: [result] });
      this.stop();
    }
  }
  w.SpeechRecognition = Recognition;
  w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  w.speechSynthesis = {
    getVoices: () => [{ name: '测试中文声音', voiceURI: 'test-zh-CN', lang: 'zh-CN' }],
    addEventListener() {}, removeEventListener() {},
    speak(utterance) { spoken.push(utterance); queueMicrotask(() => utterance.onstart?.()); },
    cancel() { cancelCount++; },
  };
  return { recognizers, spoken, get cancelCount() { return cancelCount; } };
}

async function speechFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pet-ui-voice-'));
  cpSync(new URL('../web', import.meta.url), join(root, 'web'), { recursive: true });
  const config = new Config(root), store = new Store(root), calls = [];
  config.update({ model: { baseUrl: 'https://model.example.test/v1' }, voice: { input: 'browser', output: 'browser' } });
  const otherScope = `wechat:${'a'.repeat(64)}`;
  store.ensure(otherScope, '微信测试会话');
  store.append(otherScope, '微信里的问题', undefined, '微信里的回答');
  const models = new Models(config, async (_url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    return new Response(JSON.stringify({ choices: [{ message: { content: `我听到了：${request.messages.at(-1).content}` } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const core = new PetCore(config, store, models), app = createPetServer({ root, config, store, core, models });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`, html = await (await fetch(url)).text();
  const errors = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const w = dom.window, $ = selector => w.document.querySelector(selector), devices = speechDevices(w);
  w.fetch = (path, options) => fetch(new URL(path, url), options);
  w.setInterval = () => 0; w.crypto.randomUUID = randomUUID;
  w.structuredClone = structuredClone;
  // Native fetch requires its own realm's AbortSignal. Production browser fetch
  // and the controller naturally share a realm; jsdom and Node's fetch do not.
  w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  t.after(async () => {
    w.dispatchEvent(new w.Event('pagehide')); app.abort();
    await new Promise(resolve => app.server.close(resolve));
    await delay(0); w.close(); store.close(); rmSync(root, { recursive: true, force: true });
  });
  w.eval(readFileSync(join(root, 'web', 'voice.js'), 'utf8'));
  w.eval(readFileSync(join(root, 'web', 'avatar.js'), 'utf8'));
  w.eval(readFileSync(join(root, 'web', 'app.js'), 'utf8'));
  await until(() => $('[name="pet.name"]').value === '小蓝', 'voice UI initialized');
  return { root, config, store, models, core, calls, w, $, devices, errors, otherScope };
}

test('voice conversation sends one transcript, speaks its reply and listens again; interruption and ending cleanly stop it', async t => {
  const { $, store, calls, devices, errors } = await speechFixture(t);
  assert.equal(devices.recognizers.length, 0, 'opening the page must never start the microphone');
  assert.equal(devices.spoken.length, 0);
  $('#voice-chat-button').click();
  await until(() => $('#voice-bar').dataset.phase === 'listening', 'first microphone turn');
  assert.equal($('#voice-chat-button').getAttribute('aria-pressed'), 'true');
  assert.equal($('#send-button').disabled, true, 'text sending is locked during a voice conversation');
  assert.equal($('#voice-finish-button').hidden, false);
  const first = devices.recognizers[0]; first.final('今天有点累');
  await until(() => devices.spoken.length === 1, 'reply begins speaking').catch(error => {
    t.diagnostic(`phase=${$('#voice-bar').dataset.phase}; toast=${$('#toast').textContent}; chat=${$('#chat-error').textContent}`); throw error;
  });
  assert.equal(first.running, false, 'microphone ends before reply playback');
  assert.equal(calls.length, 1);
  assert.equal(store.history('web:owner')[0].text, '今天有点累');
  assert.equal(devices.spoken[0].text, '我听到了：今天有点累');
  assert.equal($('#voice-interrupt-button').hidden, false);
  assert.equal($('#pet-character').classList.contains('speaking'), true);
  devices.spoken[0].onend();
  await until(() => devices.recognizers.length === 2 && $('#voice-bar').dataset.phase === 'listening', 'next microphone turn');
  devices.recognizers[1].final('陪我说说话');
  await until(() => devices.spoken.length === 2, 'second reply begins speaking');
  $('#voice-interrupt-button').click();
  await until(() => devices.recognizers.length === 3 && $('#voice-bar').dataset.phase === 'listening', 'interruption starts a new microphone turn');
  assert.ok(devices.cancelCount > 0, 'interrupt cancels current speech');
  const last = devices.recognizers.at(-1), lateResult = last.onresult, lateEnd = last.onend;
  $('#voice-chat-button').click();
  assert.equal(last.aborted, true);
  assert.equal($('#voice-chat-button').getAttribute('aria-pressed'), 'false');
  assert.equal($('#voice-bar').dataset.phase, 'idle');
  assert.equal($('#send-button').disabled, false);
  const late = [{ transcript: '停止后不应发送' }]; late.isFinal = true;
  lateResult({ results: [late] }); lateEnd();
  await delay(400);
  assert.equal(calls.length, 2);
  assert.equal(devices.recognizers.length, 3, 'stopped conversation must never automatically resume');
  assert.equal(store.history('web:owner').length, 4);
  assert.deepEqual(errors, []);
});

test('voice input preserves a text draft, page changes stop capture, and non-web history has no voice controls', async t => {
  const { $, w, devices, calls, otherScope, errors } = await speechFixture(t);
  $('#message-input').value = '原来的草稿';
  $('#voice-chat-button').click();
  assert.equal(devices.recognizers.length, 0, 'conversation start must not discard an existing draft');
  assert.match($('#toast').textContent, /输入框/);
  $('#voice-button').click();
  await until(() => $('#voice-bar').dataset.phase === 'listening', 'dictation starts');
  devices.recognizers[0].final('补充一句');
  await until(() => $('#voice-bar').dataset.phase === 'idle', 'dictation fills draft');
  assert.equal($('#message-input').value, '原来的草稿 补充一句');
  assert.equal(calls.length, 0, 'dictation must wait for explicit sending');
  $('#message-input').value = '';
  $('#voice-chat-button').click();
  await until(() => $('#voice-bar').dataset.phase === 'listening', 'conversation restarted');
  $('[data-page="settings"]').click();
  assert.equal(devices.recognizers.at(-1).aborted, true);
  assert.equal($('#voice-bar').dataset.phase, 'idle');
  $('[data-page="home"]').click();
  $('#voice-chat-button').click();
  await until(() => $('#voice-bar').dataset.phase === 'listening', 'conversation before hiding tab');
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  assert.equal(devices.recognizers.at(-1).aborted, true);
  assert.equal($('#voice-bar').dataset.phase, 'idle');
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: false });
  $('[data-page="memory"]').click();
  $('#memory-scope').value = otherScope; $('#view-session').click();
  await until(() => $('#chat-form').hidden && $('#messages').textContent.includes('微信里的回答'), 'read-only channel history loaded');
  assert.equal($('#voice-bar').hidden, true);
  assert.equal($('#voice-chat-button').hidden, true);
  assert.equal($('#chat-form').hidden, true);
  assert.match($('#messages').textContent, /微信里的回答/);
  assert.deepEqual(errors, []);
});

test('text auto-speech is opt-in, saved voice settings reach playback, and stopping speech leaves the reply visible', async t => {
  const { $, config, devices, store, errors } = await speechFixture(t);
  $('#message-input').value = '先用文字聊'; $('#send-button').click();
  await until(() => store.history('web:owner').length === 2 && !$('#send-button').disabled, 'text-only reply');
  assert.equal(devices.spoken.length, 0, 'text replies are silent by default');
  $('[data-page="settings"]').click();
  $('[name="voice.autoSpeak"]').checked = true;
  $('[name="voice.rate"]').value = '1.2';
  $('[name="voice.pitch"]').value = '1.1';
  $('[name="voice.browserVoice"]').value = 'test-zh-CN';
  $('#settings-form button[type="submit"]').click();
  await until(() => $('#settings-result').textContent.includes('已保存'), 'voice settings saved');
  assert.equal(config.value.voice.autoSpeak, true);
  assert.equal(config.value.voice.rate, 1.2);
  $('[data-page="home"]').click();
  $('#message-input').value = '现在请说出来'; $('#send-button').click();
  await until(() => devices.spoken.length === 1, 'text reply auto-speech');
  const utterance = devices.spoken[0];
  assert.equal(utterance.text, '我听到了：现在请说出来');
  assert.equal(utterance.rate, 1.2); assert.equal(utterance.pitch, 1.1);
  assert.equal(utterance.voice.voiceURI, 'test-zh-CN');
  assert.equal($('#voice-stop-button').hidden, false);
  $('#voice-stop-button').click();
  await until(() => $('#voice-bar').dataset.phase === 'idle', 'speech cancelled');
  assert.ok(devices.cancelCount > 0);
  assert.match($('#messages').textContent, /我听到了：现在请说出来/);
  assert.equal(store.history('web:owner').length, 4);
  assert.equal(devices.recognizers.length, 0, 'automatic reading never activates the microphone');
  assert.deepEqual(errors, []);
});

test('navigating away while a voice reply is pending cancels it and ignores a late provider response', async t => {
  let releaseReply, modelSignal;
  t.after(() => releaseReply?.());
  const { $, devices, models, core, errors } = await speechFixture(t);
  models.fetcher = async (_url, options) => {
    modelSignal = options.signal;
    await new Promise(resolve => { releaseReply = resolve; });
    // Deliberately simulate a provider that finishes despite cancellation.
    return new Response(JSON.stringify({ choices: [{ message: { content: '已经结束的对话不应朗读这一句' } }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  $('#voice-chat-button').click();
  await until(() => $('#voice-bar').dataset.phase === 'listening', 'voice capture begins');
  devices.recognizers[0].final('等一下再回答');
  await until(() => Boolean(releaseReply) && $('#voice-bar').dataset.phase === 'thinking', 'provider request starts');
  $('[data-page="settings"]').click();
  assert.equal($('#voice-bar').dataset.phase, 'idle');
  await until(() => modelSignal.aborted, 'navigation abort reaches the model request');
  releaseReply();
  await until(() => core.pending.size === 0, 'late provider response settles');
  await delay(400);
  assert.equal(devices.spoken.length, 0, 'a stopped conversation must not speak a late reply');
  assert.equal(devices.recognizers.length, 1, 'a stopped conversation must not start another listening turn');
  assert.equal($('#page-settings').hidden, false);
  assert.equal($('#voice-chat-button').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(errors, []);
});
