import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { request } from 'node:http';
import { Config, endpoint } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { Models } from '../pet/model.mjs';
import { PetCore } from '../pet/core.mjs';
import { createPetServer } from '../pet/server.mjs';
import { LocalPet, wechatScope } from '../pet/http-client.mjs';
import { MediaFlow, makeWav, synthesize } from '../media.mjs';
import { saveJSONFile } from '../lib.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const image = { mediaType: 'image/png', data: PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) }).toString('base64') };
function fixture(t, fetcher = async () => json({ choices: [{ message: { content: '你好，我在这里。' } }] })) {
  const root = mkdtempSync(join(tmpdir(), 'little-pet-'));
  const config = new Config(root); config.update({ model: { baseUrl: 'https://model.example.test/v1', apiKey: 'TEST-PRIVATE-KEY' } });
  const store = new Store(root), models = new Models(config, fetcher), core = new PetCore(config, store, models);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, store, models, core };
}

test('independent config preserves legacy configuration and masks keys on readback', t => {
  const { root, config } = fixture(t);
  writeFileSync(join(root, 'config.json'), '{"dshUrl":"http://localhost:3080"}');
  config.update({ pet: { name: '阿蓝' }, model: { apiKey: '' } });
  assert.equal(config.provider('model').apiKey, 'TEST-PRIVATE-KEY');
  assert.equal(config.public().model.apiKey, undefined);
  assert.equal(config.public().model.hasKey, true);
  assert.ok(!JSON.stringify(config.public()).includes('TEST-PRIVATE-KEY'));
  assert.equal(new Config(root).value.pet.name, '阿蓝');
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), '{"dshUrl":"http://localhost:3080"}');
  config.update({ model: { baseUrl: 'http://127.0.0.1:11434/v1' } });
  assert.equal(config.provider('model').apiKey, '', 'switching origin does not leak the old provider key');
});

test('invalid configuration cannot corrupt the existing file', t => {
  const { root, config } = fixture(t), before = readFileSync(config.path, 'utf8');
  for (const patch of [{ port: 80 }, { model: { baseUrl: 'http://remote.test/v1' } }, { stt: { enabled: true } }, { pet: { name: '' } }, { model: { supportsImages: 'yes' } }]) assert.throws(() => config.update(patch));
  assert.equal(readFileSync(join(root, 'pet.config.json'), 'utf8'), before);
  assert.equal(String(endpoint('https://service.test/v1/', 'chat/completions')), 'https://service.test/v1/chat/completions');
  assert.throws(() => endpoint('https://service.test/?apiKey=secret', 'chat/completions'));
});

test('model receives persona and only the current conversation memory', async t => {
  let body;
  const f = fixture(t, async (_url, options) => { body = JSON.parse(options.body); return json({ choices: [{ message: { content: '收到' } }] }); });
  const other = wechatScope({ botId: 'bot', userId: 'other' });
  f.store.remember('web:owner', '主人喜欢蓝色'); f.store.remember(other, '其他人喜欢红色');
  f.config.update({ pet: { name: '独立小猫', persona: '自然地聊天' } });
  assert.equal(await f.core.chat({ text: '你好', requestId: 'r1' }), '收到');
  assert.match(body.messages[0].content, /独立小猫/); assert.match(body.messages[0].content, /主人喜欢蓝色/);
  assert.ok(!JSON.stringify(body).includes('其他人喜欢红色'));
  assert.equal(f.store.history('web:owner').length, 2);
  assert.equal(f.store.history(other).length, 0);
});

test('images reach the model and remain available for a follow-up question', async t => {
  const calls = [];
  const f = fixture(t, async (_url, options) => { calls.push(JSON.parse(options.body)); return json({ choices: [{ message: { content: '一张白色图片' } }] }); });
  await f.core.chat({ attachment: image });
  assert.equal(calls[0].messages.at(-1).content[1].image_url.url, `data:image/png;base64,${image.data}`);
  await f.core.chat({ text: '刚刚的图片是什么颜色？' });
  assert.ok(calls[1].messages.some(m => Array.isArray(m.content) && m.content[1]?.image_url));
  const reopened = new Store(f.root);
  assert.equal(reopened.history('web:owner')[0].image.data, image.data);
  reopened.close();
});

test('unsupported vision fails explicitly without pretending to see an image', async t => {
  const f = fixture(t, async () => assert.fail('must not call the model'));
  f.config.update({ model: { supportsImages: false } });
  await assert.rejects(f.core.chat({ attachment: image }), /图片/);
  assert.equal(f.store.history('web:owner').length, 0);
});

test('separate image provider receives only its own API key', async t => {
  let call;
  const f = fixture(t, async (url, options) => { call = { url: String(url), options }; return json({ choices: [{ message: { content: '白色' } }] }); });
  f.config.update({ vision: { enabled: true, baseUrl: 'https://vision.example.test/v1', model: 'vision-test', apiKey: 'VISION-TEST-KEY' } });
  await f.core.chat({ attachment: image });
  assert.equal(call.url, 'https://vision.example.test/v1/chat/completions');
  assert.equal(call.options.headers.Authorization, 'Bearer VISION-TEST-KEY');
  assert.ok(!JSON.stringify(call).includes('TEST-PRIVATE-KEY'));
});

test('model errors and cancelled requests leave no incomplete history', async t => {
  const f = fixture(t, async () => new Response('sensitive provider details', { status: 401 }));
  await assert.rejects(f.core.chat({ text: '你好' }), e => /API Key/.test(e.message) && !e.message.includes('sensitive'));
  assert.equal(f.store.history('web:owner').length, 0);
  f.models.fetcher = async () => json({ choices: [{ message: { content: '可以了' } }] });
  assert.equal(await f.core.chat({ text: '重试' }), '可以了');
});

test('concurrent turns in a session are rejected, and request IDs survive restart', async t => {
  let release, count = 0;
  const f = fixture(t, async () => { count++; await new Promise(resolve => { release = resolve; }); return json({ choices: [{ message: { content: '已回复' } }] }); });
  const pending = f.core.chat({ text: '第一条', requestId: 'stable-id' });
  await assert.rejects(f.core.chat({ text: '第二条' }), /稍等/);
  release(); await pending;
  const reopened = new Store(f.root), again = new PetCore(f.config, reopened, f.models);
  assert.equal(await again.chat({ text: '第一条', requestId: 'stable-id' }), '已回复');
  assert.equal(count, 1); reopened.close();
});

test('explicit remember persists, can be forgotten, and clearing history removes cached reply text', async t => {
  const f = fixture(t, async () => assert.fail('remember does not require an API call'));
  await f.core.chat({ text: '/remember 我的生日是测试数据', requestId: 'remember-1' });
  await f.core.chat({ text: '/remember 我的生日是测试数据', requestId: 'remember-1' });
  assert.equal(f.store.memories('web:owner').length, 1);
  f.store.clear('web:owner'); assert.equal(f.store.history('web:owner').length, 0);
  assert.equal(f.store.memories('web:owner').length, 1);
  assert.match(f.store.cached('web:owner', 'remember-1'), /清除/);
  const id = f.store.memories('web:owner')[0].id;
  f.store.forget('web:owner', id); assert.equal(f.store.memories('web:owner').length, 0);
  await assert.rejects(f.core.chat({ scope: '../data', text: 'test' }), /标识/);
});

test('Weixin accounts and bot identities are isolated', () => {
  const a = wechatScope({ botId: 'b', userId: 'u' });
  assert.equal(a, wechatScope({ userId: 'u', botId: 'b' }));
  assert.notEqual(a, wechatScope({ botId: 'b', userId: 'u2' }));
  assert.notEqual(a, wechatScope({ botId: 'b2', userId: 'u' }));
});

test('speech services use multipart STT and MP3 TTS, without dsh', async t => {
  const seen = [];
  const f = fixture(t, async (url, options) => {
    seen.push({ url: String(url), options });
    if (String(url).endsWith('/audio/transcriptions')) {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('model'), 'stt-model');
      assert.equal(options.body.get('file').type, 'audio/wav');
      return json({ text: '听到了' });
    }
    return new Response('ID3-test', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  await assert.rejects(f.models.transcribe(Buffer.from('test'), 'audio/wav'), /尚未配置/);
  f.config.update({ stt: { enabled: true, baseUrl: 'https://voice.test/v1', model: 'stt-model' }, tts: { enabled: true, baseUrl: 'https://voice.test/v1', model: 'tts-model' } });
  assert.equal(await f.models.transcribe(makeWav(Buffer.alloc(320)), 'audio/wav'), '听到了');
  assert.equal((await f.models.speak('你好')).toString(), 'ID3-test');
  assert.equal(seen.length, 2);
  f.models.fetcher = async () => json({ error: 'not an mp3' });
  await assert.rejects(f.models.speak('你好'), /MP3/);
});

async function httpFixture(t) {
  const f = fixture(t);
  cpSync(new URL('../web', import.meta.url), join(f.root, 'web'), { recursive: true });
  const app = createPetServer(f);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  saveJSONFile(join(f.root, 'data', 'pet-runtime.json'), { url, token: app.token });
  t.after(async () => { app.abort(); await new Promise(resolve => app.server.close(resolve)); });
  return { ...f, app, url, headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' } };
}

test('HTTP protects the bootstrap page, API credentials and Host boundary', async t => {
  const f = await httpFixture(t);
  assert.equal((await fetch(f.url + '/api/state')).status, 401);
  assert.equal((await fetch(f.url + '/', { headers: { Origin: 'https://evil.test' } })).status, 403);
  const spoofedHostStatus = await new Promise((resolve, reject) => {
    const req = request(f.url + '/', { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(spoofedHostStatus, 403);
  assert.equal((await fetch(f.url + '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const html = await (await fetch(f.url)).text(); assert.ok(html.includes(f.app.token));
  const state = await (await fetch(f.url + '/api/state', { headers: f.headers })).text(); assert.ok(!state.includes('TEST-PRIVATE-KEY'));
  assert.equal((await fetch(f.url + '/pet.config.json', { headers: f.headers })).status, 404);
  const response = await fetch(f.url + '/api/chat', { method: 'POST', headers: f.headers, body: JSON.stringify({ text: '你好', requestId: 'http1' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).text, '你好，我在这里。');
});

test('real local HTTP Weixin adapter reaches independent core and preserves actionable errors', async t => {
  const f = await httpFixture(t), client = new LocalPet(f.root);
  const account = { botId: 'bot', userId: 'owner' }; client.scope = wechatScope(account);
  assert.equal((await client.check()).id, 'standalone');
  const flow = new MediaFlow(client, {}, { replyAudio: 'off' });
  const result = await flow.respond({ id: 'wechat1', text: '', media: [{ type: 3, voice_item: { text: '微信语音转写' } }] });
  assert.equal(result.text, '你好，我在这里。');
  assert.equal(f.store.history(client.scope).length, 2);
  assert.equal(f.store.history('web:owner').length, 0);
  assert.equal(await client.chat('同一条重投', undefined, undefined, 'wechat1'), result.text);
  await assert.rejects(synthesize(client, '测试'), e => e.userMessage?.includes('尚未配置'));
  f.config.update({ model: { supportsImages: false } });
  await assert.rejects(client.chat('看图', undefined, image), e => e.userMessage?.includes('图片'));
});

test('public UI assets load without credentials while bootstrap routes retain source protection', async t => {
  const f = await httpFixture(t);
  for (const headers of [{}, { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://foreign.test', 'Sec-Fetch-Site': 'cross-site' }]) {
    for (const [path, mime] of [['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
      const response = await fetch(f.url + path, { headers });
      assert.equal(response.status, 200, `${path} must not receive a JSON error instead of the resource`);
      assert.ok(response.headers.get('content-type').startsWith(mime));
      const content = await response.text();
      assert.ok(!content.includes(f.app.token)); assert.ok(!content.includes('TEST-PRIVATE-KEY'));
    }
  }
  assert.equal((await fetch(f.url + '/favicon.ico')).status, 204);
  for (const path of ['/', '/api/health']) {
    for (const headers of [{ Origin: 'null' }, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://foreign.test', 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      const response = await fetch(f.url + path, { headers: { ...f.headers, ...headers } });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'page_source_rejected');
    }
  }
  assert.equal((await fetch(f.url + '/api/state', { headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' } })).status, 401);
  assert.equal((await fetch(f.url + '/api/state', { headers: { ...f.headers, Origin: 'null', 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  const spoofedHostStatus = await new Promise((resolve, reject) => {
    const req = request(f.url + '/app.js', { headers: { Host: 'foreign.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(spoofedHostStatus, 403);
});

test('authenticated APIs tolerate missing, opaque and inconsistent browser source headers', async t => {
  const f = await httpFixture(t);
  const sources = [
    {},
    { Origin: 'null' },
    { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
    { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'null', 'Sec-Fetch-Site': 'same-site' },
    { Origin: f.url, 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'https://rewritten.test', 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ];
  for (const [index, source] of sources.entries()) {
    const headers = { ...f.headers, ...source };
    const state = await fetch(f.url + '/api/state', { headers });
    assert.equal(state.status, 200, `valid page token, source headers: ${JSON.stringify(source)}`);
    assert.equal((await state.json()).config.pet.name, '小蓝');
    assert.equal(state.headers.get('access-control-allow-origin'), null);
    const saved = await fetch(f.url + '/api/memory/add', { method: 'POST', headers, body: JSON.stringify({ text: `测试记忆 ${index}` }) });
    assert.equal(saved.status, 200);
    await saved.json();
  }
  assert.equal(f.store.memories('web:owner').length, sources.length);
});

test('private routes reject unknown tokens, ambient credentials, preflights and invalid Hosts', async t => {
  const f = await httpFixture(t), other = await httpFixture(t);
  f.store.remember('web:owner', 'PRIVATE-TEST-MEMORY');
  const routes = [
    ['GET', '/api/state'], ['GET', '/api/history'], ['GET', '/api/wechat/qr'],
    ...['config', 'chat', 'history/clear', 'memory/add', 'memory/delete', 'stt', 'tts', 'wechat/start', 'wechat/login', 'wechat/stop'].map(path => ['POST', `/api/${path}`]),
  ];
  for (const credentials of [{}, { Authorization: 'Bearer incorrect' }, { Authorization: `Bearer ${other.app.token}` }, { Cookie: `pet-token=${f.app.token}` }]) {
    for (const [method, path] of routes) {
      const response = await fetch(f.url + path, {
        method, headers: { ...credentials, Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ pet: { name: '未经授权修改' }, text: '不得执行' }) : undefined,
      });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal((await response.json()).code, 'invalid_token');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
  assert.equal((await fetch(`${f.url}/api/state?token=${f.app.token}`)).status, 401);
  const preflight = await fetch(f.url + '/api/config', { method: 'OPTIONS', headers: { Origin: 'https://foreign.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(preflight.status, 401);
  for (const header of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-credentials']) assert.equal(preflight.headers.get(header), null);
  await preflight.json();
  const plain = await fetch(f.url + '/api/config', { method: 'POST', headers: { ...f.headers, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 400); await plain.json();
  for (const path of ['/', '/app.js', '/api/state']) {
    const response = await new Promise((resolve, reject) => {
      const req = request(f.url + path, { headers: { ...f.headers, Host: 'foreign.test' } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(response.status, 403); assert.equal(response.body.code, 'invalid_host');
  }
  assert.equal(f.config.value.pet.name, '小蓝');
  assert.equal(f.store.memories('web:owner').length, 1);
  assert.equal(f.store.history('web:owner').length, 0);
});
