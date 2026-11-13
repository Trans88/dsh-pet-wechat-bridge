import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { Models } from '../pet/model.mjs';
import { PetCore } from '../pet/core.mjs';
import { createPetServer } from '../pet/server.mjs';

async function until(predicate) { for (let i = 0; i < 350; i++) { if (predicate()) return; await delay(10); } assert.fail('desktop state did not settle'); }
function devices(w) {
  const recognizers = [], spoken = [];
  class Recognition {
    constructor() { recognizers.push(this); }
    start() { this.running = true; queueMicrotask(() => { if (this.running) this.onstart?.(); }); }
    abort() { this.running = false; this.aborted = true; }
    stop() { this.running = false; queueMicrotask(() => this.onend?.()); }
    final(text) { const result = [{ transcript: text }]; result.isFinal = true; this.onresult?.({ results: [result] }); this.stop(); }
  }
  w.SpeechRecognition = Recognition;
  w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  w.speechSynthesis = { getVoices: () => [{ lang: 'zh-CN', name: '测试音色' }], speak: value => spoken.push(value), cancel() {}, addEventListener() {}, removeEventListener() {} };
  return { recognizers, spoken };
}
async function fixture(t, { reply = '桌面回复', slow = false, dropReply = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pet-desktop-chat-'));
  cpSync(new URL('../web', import.meta.url), join(root, 'web'), { recursive: true });
  const config = new Config(root), store = new Store(root), calls = [], sent = [], modes = [], homes = [];
  config.update({ model: { apiKey: 'PRIVATE-MODEL-KEY', baseUrl: 'https://model.example.test/v1' },
    stt: { apiKey: 'PRIVATE-STT-KEY' }, tts: { apiKey: 'PRIVATE-TTS-KEY' }, voice: { input: 'browser', output: 'browser' } });
  store.ensure('qq:direct:someone', '其他人'); store.append('qq:direct:someone', 'QQ-PRIVATE-QUESTION', null, 'QQ-PRIVATE-REPLY');
  let aborted = false, release;
  const response = () => new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { headers: { 'Content-Type': 'application/json' } });
  const models = new Models(config, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (!slow) return response();
    return new Promise((resolve, reject) => {
      release = () => resolve(response());
      options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('取消', 'AbortError')); }, { once: true });
    });
  });
  const core = new PetCore(config, store, models), server = createPetServer({ root, config, store, core, models });
  await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.server.address().port}`, errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await (await fetch(`${url}/desktop`)).text(), { url: `${url}/desktop`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, $ = selector => w.document.querySelector(selector), speech = devices(w);
  w.AbortController = AbortController; w.AbortSignal = AbortSignal; w.crypto.randomUUID = randomUUID;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.petDesktop = { preferences: async () => ({ size: 'medium' }), chat: async open => { modes.push(open); return open; }, openHome: page => homes.push(page), drag() {}, hit() {}, menu() {}, onAction: () => () => {}, onPreferences: () => () => {} };
  w.fetch = async (path, options) => {
    if (path === '/api/chat') sent.push(JSON.parse(options.body));
    const result = await fetch(new URL(path, url), options);
    if (path === '/api/chat' && dropReply) { dropReply = false; await result.arrayBuffer(); throw new Error('模拟回复途中断网'); }
    return result;
  };
  t.after(async () => { w.dispatchEvent(new w.Event('pagehide')); release?.(); server.abort(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); await delay(20); w.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const script of ['avatar.js', 'voice.js', 'desktop-chat.js', 'desktop.js']) w.eval(readFileSync(join(root, 'web', script), 'utf8'));
  await until(() => !$('#voice').disabled);
  return { $, w, calls, sent, modes, homes, speech, errors, config, store, url, token: server.token, release: () => release?.(), isAborted: () => aborted };
}

test('desktop sends text locally, keeps the full long reply, shares owner history and never opens the room', async t => {
  const reply = '长回复正文\n'.repeat(150) + '<img src=x onerror=alert(1)> END';
  const { $, w, calls, sent, modes, homes, speech, errors, store, url, token } = await fixture(t, { reply });
  const safe = await (await fetch(`${url}/api/desktop/state`, { headers: { Authorization: `Bearer ${token}` } })).text();
  assert.doesNotMatch(safe, /PRIVATE-|QQ-PRIVATE/);
  assert.ok(JSON.parse(safe).config.voice);
  assert.deepEqual(JSON.parse(safe).config.stt, { enabled: false });
  $('#chat').click(); await until(() => modes.includes(true));
  $('#desktop-input').value = '直接和桌宠聊'; $('#desktop-send').click();
  await until(() => store.history('web:owner').length === 2 && !$('#desktop-send').disabled);
  assert.equal(sent[0].scope, 'web:owner'); assert.equal(calls.length, 1);
  assert.equal($('#bubble-text').textContent, reply);
  assert.ok($('#desktop-messages').textContent.includes(reply));
  assert.equal($('#desktop-messages img'), null); assert.equal($('#bubble-text img'), null);
  assert.doesNotMatch($('#desktop-messages').textContent, /QQ-PRIVATE/);
  assert.equal(speech.recognizers.length, 0); assert.equal(speech.spoken.length, 0);
  assert.deepEqual(homes, []);
  $('#conversation-close').click(); assert.equal($('#conversation').hidden, true); assert.equal(modes.at(-1), false);
  $('#bubble-chat').click(); await until(() => !$('#conversation').hidden);
  assert.ok($('#desktop-messages').textContent.includes(reply));
  assert.deepEqual(errors, []);
});

test('double-click opens the room once without desktop chat or a pending pat; single click and drag remain distinct', async t => {
  const { $, w, homes, modes } = await fixture(t);
  const actions = [], fetch = w.fetch;
  w.fetch = (path, options) => {
    if (path === '/api/pet/interact') actions.push(JSON.parse(options.body).action);
    return fetch(path, options);
  };
  const pointer = (type, x = 10) => $('#pet-character').dispatchEvent(new w.MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: 10 }));
  pointer('pointerdown'); pointer('pointerup');
  pointer('pointerdown'); pointer('pointerup');
  $('#pet-character').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, button: 0 }));
  assert.deepEqual(homes, ['home']); assert.equal($('#conversation').hidden, true);
  assert.equal(modes.includes(true), false);
  await delay(300); assert.deepEqual(actions, [], 'double-click cancels the queued single-click pat');
  pointer('pointerdown'); pointer('pointerup');
  await until(() => actions.length === 1); assert.deepEqual(actions, ['pat']);
  pointer('pointerdown'); pointer('pointermove', 40); pointer('pointerup', 40);
  await delay(300); assert.deepEqual(actions, ['pat']); assert.deepEqual(homes, ['home']);
  $('#chat').click(); await until(() => modes.includes(true));
  assert.equal($('#conversation').hidden, false, 'the chat button still opens desktop chat');
});

test('double-click opening the room suspends an active desktop microphone', async t => {
  const { $, w, homes, speech } = await fixture(t);
  $('#voice').click(); await until(() => $('#desktop-voice-status').dataset.phase === 'listening');
  $('#pet-character').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, button: 0 }));
  assert.deepEqual(homes, ['home']); assert.equal(speech.recognizers[0].aborted, true);
  await delay(380); assert.equal(speech.recognizers.length, 1);
});

test('retry after losing a completed HTTP response preserves draft/request ID and avoids duplicate model calls', async t => {
  const { $, w, calls, sent, store } = await fixture(t, { dropReply: true });
  $('#chat').click();
  $('#desktop-input').value = '网络重试'; $('#desktop-send').click();
  await until(() => $('#desktop-chat-error').textContent.includes('断网') && !$('#desktop-send').disabled);
  assert.equal($('#desktop-input').value, '网络重试');
  $('#desktop-send').click(); await until(() => $('#desktop-input').value === '' && !$('#desktop-send').disabled);
  assert.equal(sent.length, 2); assert.equal(sent[0].requestId, sent[1].requestId);
  assert.equal(calls.length, 1); assert.equal(store.history('web:owner').length, 2);
  $('#desktop-input').value = '输入法候选';
  $('#desktop-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  await delay(20); assert.equal(sent.length, 2, 'IME confirmation is not a send');
});

test('desktop voice listens, sends, speaks and listens again; closing releases capture and cannot restart it', async t => {
  const { $, speech, calls, store, homes, errors } = await fixture(t);
  $('#voice').click(); await until(() => $('#desktop-voice-status').dataset.phase === 'listening');
  assert.equal($('#desktop-send').disabled, true); assert.equal(speech.recognizers.length, 1);
  speech.recognizers[0].final('陪我说说话');
  await until(() => speech.spoken.length === 1);
  assert.equal(speech.recognizers[0].running, false);
  assert.equal(store.history('web:owner')[0].text, '陪我说说话');
  speech.spoken[0].onend(); await until(() => speech.recognizers.length === 2);
  const second = speech.recognizers[1];
  $('#conversation-close').click(); assert.equal(second.aborted, true);
  await delay(380); assert.equal(speech.recognizers.length, 2); assert.equal(calls.length, 1);
  assert.deepEqual(homes, []); assert.deepEqual(errors, []);
});

test('closing during a voice model request aborts it and prevents late recording or speech', async t => {
  const { $, speech, calls, release, isAborted, store } = await fixture(t, { slow: true });
  $('#voice').click(); await until(() => speech.recognizers.length === 1);
  speech.recognizers[0].final('等待中的问题'); await until(() => calls.length === 1);
  $('#conversation-close').click(); await until(isAborted); release(); await delay(380);
  assert.equal(speech.spoken.length, 0); assert.equal(speech.recognizers.length, 1);
  assert.equal(store.history('web:owner').length, 0);
  assert.equal($('#desktop-input').value, '等待中的问题');
});

test('dictation preserves a draft and hidden windows stop voice without automatically resuming', async t => {
  const { $, w, speech, calls } = await fixture(t);
  $('#chat').click(); $('#desktop-input').value = '原来的草稿'; $('#desktop-voice').click();
  await until(() => $('#desktop-chat-error').textContent.includes('输入框'));
  assert.equal(speech.recognizers.length, 0);
  $('#desktop-dictate').click(); await until(() => speech.recognizers.length === 1);
  speech.recognizers[0].final('补充一句'); await until(() => $('#desktop-input').value.includes('补充一句'));
  assert.equal($('#desktop-input').value, '原来的草稿 补充一句'); assert.equal(calls.length, 0);
  $('#desktop-input').value = ''; $('#voice').click(); await until(() => speech.recognizers.length === 2);
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: true }); w.document.dispatchEvent(new w.Event('visibilitychange'));
  assert.equal(speech.recognizers[1].aborted, true);
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: false }); w.document.dispatchEvent(new w.Event('visibilitychange'));
  await delay(380); assert.equal(speech.recognizers.length, 2); assert.equal(calls.length, 0);
});
