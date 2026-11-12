import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { QQBridge, qqScope, qqError } from '../pet/qq.mjs';
import { PNG } from 'pngjs';

class FakeBot {
  handlers = {}; sent = []; starts = 0; uploads = []; images = [];
  on(type, fn) { this.handlers[type] = fn; return this; }
  async start(signal) { this.starts++; this.handlers.ready?.(); await new Promise(resolve => { this.done = resolve; signal.addEventListener('abort', resolve, { once: true }); }); }
  stop() { this.done?.(); }
  async sendText(target, text) { this.sent.push({ target, text }); if (this.sendError) throw this.sendError; await this.afterText?.(); }
  async uploadMedia(options) { this.uploads.push(options); await this.beforeUpload?.(); if (this.uploadError) throw this.uploadError; return { file_info: 'TEST-FILE-INFO' }; }
  getCredentials() { return { appId: '123456', clientSecret: 'TEST-QQ-SECRET' }; }
  mediaApi = { sendMediaMessage: async (scope, targetId, fileInfo, _credentials, options) => {
    this.images.push({ scope, targetId, fileInfo, options }); if (this.imageError) throw this.imageError;
  } };
  message(msg) { return this.handlers.message({}, msg); }
}
const message = (overrides = {}) => ({ kind: 'c2c', senderId: 'u1', messageId: 'm1', content: '你好', ...overrides });
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const imageMessage = extra => message({ content: '', attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/test.png?secret=SIGNED-TEST-URL' }], ...extra });
async function fixture(t, complete = async () => '收到啦') {
  const root = mkdtempSync(join(tmpdir(), 'pet-qq-')), config = new Config(root), store = new Store(root);
  config.update({ qq: { appId: '123456', appSecret: 'TEST-QQ-SECRET', allowedUsers: ['u1'] } });
  const calls = [], core = new PetCore(config, store, { complete: (...args) => { calls.push(args); return complete(...args); } });
  const bots = [], options = [];
  const qq = new QQBridge({ config, store, core, factory: async opts => { options.push(opts); const bot = new FakeBot(); bots.push(bot); return bot; } });
  t.after(async () => { await qq.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await qq.start(); await Promise.resolve();
  return { root, config, store, core, qq, calls, bot: bots[0], bots, options };
}

test('QQ credentials are masked, persisted, validated and not reused with another AppID', t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-qq-config-')), c = new Config(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  c.update({ qq: { appId: '123', appSecret: 'PRIVATE-QQ-TEST', allowedUsers: ['u1', 'u1'] } });
  assert.ok(!JSON.stringify(c.public()).includes('PRIVATE-QQ-TEST'));
  assert.equal(c.public().qq.hasSecret, true);
  c.update({ qq: { appSecret: '' } }); assert.equal(c.value.qq.appSecret, 'PRIVATE-QQ-TEST');
  assert.deepEqual(new Config(root).value.qq.allowedUsers, ['u1']);
  assert.throws(() => c.update({ qq: { directMode: 'invalid' } }));
  assert.throws(() => c.update({ qq: { allowedGroups: ['../bad'] } }));
  c.update({ qq: { appId: '456' } }); assert.equal(c.value.qq.appSecret, '');
  c.update({ qq: { appSecret: 'NEW', clearSecret: true } }); assert.equal(c.value.qq.appSecret, '');
});

test('QQ private replies use official target, model core, masked status and minimal intents', async t => {
  const f = await fixture(t);
  assert.equal(f.qq.status().state, 'connected'); assert.equal(f.options[0].intents, 1 << 25);
  assert.equal(f.options[0].markdownSupport, false);
  await f.bot.message(message({ replyTarget: { scope: 'c2c', targetId: 'untrusted' } }));
  assert.deepEqual(f.bot.sent, [{ target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' }, text: '收到啦' }]);
  assert.equal(f.store.history(qqScope('123456', message())).length, 2);
  assert.equal(f.store.history('web:owner').length, 0);
  f.bot.handlers.error({ message: 'TEST-QQ-SECRET raw body' });
  assert.ok(!JSON.stringify(f.qq.status()).includes('TEST-QQ-SECRET'));
  f.bot.handlers.disconnected({ willReconnect: true }); assert.equal(f.qq.state, 'reconnecting');
  f.bot.handlers.resumed(); assert.equal(f.qq.state, 'connected'); assert.equal(f.qq.lastError, '');
});

test('QQ allowlist rejects strangers without model cost; group replies require @', async t => {
  const f = await fixture(t);
  await f.bot.message(message({ senderId: 'stranger' }));
  assert.equal(f.calls.length, 0); assert.equal(f.bot.sent.length, 0);
  assert.equal(f.qq.status().contacts[0].id, 'stranger');
  const group = message({ kind: 'group', groupOpenid: 'g1', rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
  await f.bot.message(group); assert.equal(f.calls.length, 0);
  f.config.update({ qq: { groupMode: 'allowlist', allowedGroups: ['g1'] } });
  await f.bot.message({ ...group, rawEventType: 'GROUP_MESSAGE_CREATE' }); assert.equal(f.calls.length, 0);
  await f.bot.message(group); assert.equal(f.calls.length, 1); assert.equal(f.bot.sent[0].target.scope, 'group');
  assert.notEqual(qqScope('123456', group), qqScope('123456', { ...group, senderId: 'u2' }));
  assert.notEqual(qqScope('123456', group), qqScope('999', group));
  assert.notEqual(qqScope('123456', message()), qqScope('123456', group));
});

test('redelivery and process restart never duplicate a sent or ambiguous QQ reply', async t => {
  const f = await fixture(t);
  await f.bot.message(message()); await f.bot.message(message());
  assert.equal(f.calls.length, 1); assert.equal(f.bot.sent.length, 1);
  await f.qq.stop(); await f.qq.start(); await Promise.resolve();
  await f.bots[1].message(message()); assert.equal(f.bots[1].sent.length, 0);
  f.bots[1].sendError = new Error('PRIVATE token');
  await f.bots[1].message(message({ messageId: 'm2' }));
  await f.bots[1].message(message({ messageId: 'm2' }));
  assert.equal(f.bots[1].sent.length, 1); assert.equal(f.calls.length, 2);
  assert.ok(!f.qq.lastError.includes('PRIVATE'));
});

test('QQ pet commands work without a model and are isolated per person', async t => {
  const f = await fixture(t, async () => assert.fail('no LLM for interactions'));
  await f.bot.message(message({ content: '/抱抱' }));
  assert.match(f.bot.sent[0].text, /温暖|身边/);
  assert.equal(f.core.interactions.status(qqScope('123456', message())).bond, 2);
  assert.equal(f.core.interactions.status('web:owner').bond, 0);
  await f.bot.message(message({ content: '/宠物', messageId: 'm2' }));
  assert.match(f.bot.sent[1].text, /亲密度 2/);
});

test('QQ serializes incoming turns and revoking access stops an in-flight reply', async t => {
  let release;
  const f = await fixture(t, () => new Promise(resolve => { release = resolve; }));
  const first = f.bot.message(message()); await new Promise(setImmediate);
  const second = f.bot.message(message({ messageId: 'm2' }));
  assert.equal(f.calls.length, 1);
  f.config.update({ qq: { allowedUsers: [] } }); release('生成完成'); await Promise.all([first, second]);
  assert.equal(f.bot.sent.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.qq.pending, 0);
});

test('QQ stop cancels generation and stale callbacks cannot deliver after disconnect', async t => {
  const f = await fixture(t, (_messages, _images, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const task = f.bot.message(message()); await new Promise(setImmediate);
  await f.qq.stop(); await task;
  f.bot.handlers.ready(); assert.equal(f.qq.state, 'stopped');
  await f.bot.message(message({ messageId: 'late' }));
  assert.equal(f.bot.sent.length, 0); assert.equal(f.calls.length, 1);
});

test('QQ startup failures are visible, and stop wins against a delayed SDK import', async t => {
  const f = await fixture(t); await f.qq.stop();
  let release; const delayed = new FakeBot();
  f.qq.factory = () => new Promise(resolve => { release = resolve; });
  const starting = f.qq.start(); await assert.rejects(f.qq.start(), /已在/);
  await f.qq.stop(); release(delayed); await starting;
  assert.equal(delayed.starts, 0); assert.equal(f.qq.state, 'stopped');
  f.qq.factory = async () => { const bot = new FakeBot(); bot.start = async () => { throw { httpStatus: 401, message: 'PRIVATE-KEY' }; }; return bot; };
  await f.qq.start(); await f.qq.run;
  assert.equal(f.qq.state, 'error'); assert.match(f.qq.lastError, /凭据/); assert.ok(!f.qq.lastError.includes('PRIVATE'));
});

test('QQ start and stop return even if SDK import never settles; late imports cannot start', async t => {
  const f = await fixture(t); await f.qq.stop();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let release;
  f.qq.factory = () => new Promise(resolve => { release = resolve; });
  await f.qq.start(); const oldRun = f.qq.run;
  assert.equal(f.qq.state, 'starting');
  t.mock.timers.tick(9000);
  assert.equal(f.qq.status().elapsedSeconds, 9);
  await f.qq.stop();
  assert.equal(f.qq.state, 'stopped');
  const delayed = new FakeBot(); release(delayed); await oldRun;
  assert.equal(delayed.starts, 0);
  t.mock.timers.tick(60000);
  assert.equal(f.qq.state, 'stopped');
});

test('QQ overall deadline covers import, permits retry, and ignores stale ready/message callbacks', async t => {
  const f = await fixture(t); await f.qq.stop();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const logs = []; f.qq.log = line => logs.push(line);
  let release;
  f.qq.factory = () => new Promise(resolve => { release = resolve; });
  await f.qq.start(); const importRun = f.qq.run;
  t.mock.timers.tick(60000);
  assert.equal(f.qq.state, 'error'); assert.match(f.qq.lastError, /60 秒/);
  assert.equal(f.qq.controller.signal.aborted, true);
  const delayed = new FakeBot(); release(delayed); await importRun;
  assert.equal(delayed.starts, 0);

  const stuck = new FakeBot(); stuck.start = () => new Promise(() => {});
  f.qq.factory = async () => stuck;
  await f.qq.start(); await Promise.resolve();
  stuck.handlers.error(new Error('Network error getting access_token: PRIVATE-QQ-SECRET', { cause: { code: 'ETIMEDOUT' } }));
  t.mock.timers.tick(60000);
  assert.equal(f.qq.state, 'error'); assert.match(f.qq.lastError, /ETIMEDOUT/);
  assert.ok(!logs.join('\n').includes('PRIVATE-QQ-SECRET'));
  stuck.handlers.ready(); await stuck.message(message());
  assert.equal(f.qq.state, 'error'); assert.equal(f.calls.length, 0);

  f.qq.factory = async () => new FakeBot();
  await f.qq.start(); await Promise.resolve();
  assert.equal(f.qq.state, 'connected');
  stuck.handlers.disconnected({ willReconnect: false, code: 4914 });
  stuck.handlers.error(new Error('late error')); stuck.handlers.ready();
  assert.equal(f.qq.state, 'connected'); assert.equal(f.qq.lastError, '');
  t.mock.timers.tick(120000);
  assert.equal(f.qq.state, 'connected', 'ready clears the connection deadline');
});

test('reconnection has one fixed deadline; fatal closes stop immediately and stop never waits for stuck SDK start', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  f.bot.handlers.disconnected({ willReconnect: true });
  t.mock.timers.tick(45000);
  f.bot.handlers.disconnected({ willReconnect: true });
  assert.equal(f.qq.status().elapsedSeconds, 45);
  t.mock.timers.tick(15000);
  assert.equal(f.qq.state, 'error'); assert.match(f.qq.lastError, /重连.*60 秒/);
  await f.qq.start(); await Promise.resolve();
  f.bots.at(-1).handlers.disconnected({ willReconnect: false, code: 4914 });
  assert.equal(f.qq.state, 'error'); assert.match(f.qq.lastError, /沙箱.*4914/);

  const stuck = new FakeBot(); stuck.start = () => new Promise(() => {});
  f.qq.factory = async () => stuck;
  await f.qq.start(); await Promise.resolve();
  await f.qq.stop();
  assert.equal(f.qq.state, 'stopped');
  t.mock.timers.tick(60000); stuck.handlers.ready();
  assert.equal(f.qq.state, 'stopped');
});

test('SDK token, network and gateway errors retain only safe codes and actionable diagnoses', () => {
  for (const [input, expected] of [
    [new Error('Token fetch failed: HTTP 403 — PRIVATE-SECRET'), /凭据.*HTTP 403/],
    [new Error('Failed to get access_token: {"code":40014,"message":"PRIVATE-SECRET"}'), /凭据.*QQ 40014/],
    [new Error('Token fetch failed: HTTP 503 — PRIVATE-SECRET'), /暂时不可用.*HTTP 503/],
    [new Error('Token fetch failed: HTTP 429 — PRIVATE-SECRET'), /限流.*HTTP 429/],
    [new Error('Network error getting access_token: PRIVATE-SECRET', { cause: { code: 'ENOTFOUND' } }), /域名.*ENOTFOUND/],
    [new Error('Network error getting access_token: PRIVATE-SECRET', { cause: new AggregateError([{ code: 'UND_ERR_CONNECT_TIMEOUT' }]) }), /网络.*UND_ERR_CONNECT_TIMEOUT/],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'PRIVATE-SECRET' }, /证书.*ERR_TLS_CERT_ALTNAME_INVALID/],
    [{ code: 'GATEWAY_FATAL_CLOSE', closeCode: 4914, message: 'PRIVATE-SECRET' }, /沙箱.*4914/],
    [{ code: 'GATEWAY_FATAL_CLOSE', closeCode: 4915, message: 'PRIVATE-SECRET' }, /禁止.*4915/],
    [{ message: 'ip not in whitelist PRIVATE-SECRET' }, /IP 白名单/],
    [{ bizCode: 'PRIVATE-SECRET', httpStatus: 'PRIVATE-SECRET', message: 'PRIVATE-SECRET' }, /连接或发送失败/],
  ]) { const safe = qqError(input); assert.match(safe, expected); assert.ok(!safe.includes('PRIVATE-SECRET')); }
});

test('QQ image-only and captioned group pictures reach the model, history and follow-ups with isolated scopes', async t => {
  const f = await fixture(t); let downloads = 0;
  f.qq.fetcher = async (_url, options) => { downloads++; assert.equal(options.headers, undefined); return new Response(png); };
  await f.bot.message(imageMessage());
  const [messages, withImages] = f.calls[0], content = messages.at(-1).content;
  assert.equal(withImages, true); assert.equal(content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.match(content[0].text, /表情包/);
  assert.equal(f.store.history(qqScope('123456', message()))[0].image.data, png.toString('base64'));
  assert.equal(f.store.history('web:owner').length, 0);
  assert.ok(!JSON.stringify([f.calls, f.qq.status()]).includes('SIGNED-TEST-URL'));
  await f.bot.message(imageMessage()); assert.equal(downloads, 1, 'redelivery cannot download or reply twice');
  await f.bot.message(message({ messageId: 'follow-up', content: '这张图什么意思' }));
  assert.ok(f.calls[1][0].some(m => Array.isArray(m.content)), 'same sender can ask about their picture');
  f.config.update({ qq: { groupMode: 'allowlist', allowedGroups: ['g1'] } });
  const group = imageMessage({ kind: 'group', groupOpenid: 'g1', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'group-picture', content: '<@123456> 这个表情是什么意思？' });
  await f.bot.message(group);
  assert.equal(f.calls[2][0].at(-1).content[0].text, '这个表情是什么意思？');
  assert.equal(f.bot.sent.at(-1).target.targetId, 'g1');
  assert.equal(f.store.history(qqScope('123456', { ...group, senderId: 'u2' })).length, 0);
});

test('QQ denied senders, unsupported attachments and opaque face tags never call the model or download', async t => {
  const f = await fixture(t, () => assert.fail('not an image or ordinary text'));
  f.qq.fetcher = () => assert.fail('no permitted media');
  await f.bot.message(imageMessage({ senderId: 'stranger' }));
  assert.equal(f.bot.sent.length, 0);
  await f.bot.message(message({ content: '<faceType=1,faceId="123",ext="bad">' }));
  assert.match(f.bot.sent[0].text, /没有提供可读取的图片/);
  await f.bot.message(message({ messageId: 'audio', content: '听听', attachments: [{ content_type: 'audio/wav', url: 'https://gchat.qpic.cn/a' }] }));
  assert.match(f.bot.sent[1].text, /附件暂不支持/); assert.equal(f.calls.length, 0);
});

test('QQ cancellation and allowlist changes during image download prevent model calls and replies', async t => {
  const f = await fixture(t, () => assert.fail('no model after permission changes'));
  let release, requested;
  f.qq.fetcher = (_url, options) => new Promise((resolve, reject) => {
    requested = true; release = () => resolve(new Response(png));
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const first = f.bot.message(imageMessage()); await new Promise(setImmediate);
  assert.equal(requested, true);
  f.config.update({ qq: { allowedUsers: [] } }); release(); await first;
  assert.equal(f.calls.length, 0); assert.equal(f.bot.sent.length, 0);
  f.config.update({ qq: { allowedUsers: ['u1'] } });
  const second = f.bot.message(imageMessage({ messageId: 'cancel-download' })); await new Promise(setImmediate);
  await f.qq.stop(); await second;
  assert.equal(f.calls.length, 0); assert.equal(f.bot.sent.length, 0); assert.equal(f.qq.pending, 0);
});

test('failed QQ image downloads give a useful response instead of sending placeholders to the model', async t => {
  const f = await fixture(t, () => assert.fail('image unavailable'));
  f.qq.fetcher = async () => new Response('SECRET RAW BODY', { status: 403 });
  await f.bot.message(imageMessage());
  assert.match(f.bot.sent[0].text, /HTTP 403/); assert.ok(!f.bot.sent[0].text.includes('SECRET'));
  assert.equal(f.calls.length, 0);
});

const reaction = (id = 'cheer', text = '这下可以庆祝了！') => JSON.stringify({ text, sticker: id });
test('QQ selects a bundled image in one model call and records only confirmed delivery', async t => {
  const f = await fixture(t, async () => reaction());
  await f.bot.message(message({ content: '今天终于把那个项目做完啦！' }));
  assert.equal(f.calls.length, 1); assert.equal(f.bot.sent[0].text, '这下可以庆祝了！');
  assert.equal(f.bot.uploads.length, 1); assert.equal(f.bot.uploads[0].srvSendMsg, false);
  assert.equal(f.bot.uploads[0].fileType, 1);
  assert.equal(f.bot.uploads[0].buffer.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual(f.bot.images, [{ scope: 'c2c', targetId: 'u1', fileInfo: 'TEST-FILE-INFO', options: { msgId: 'm1' } }]);
  const scope = qqScope('123456', message());
  assert.equal(f.store.history(scope).at(-1).sticker, 'cheer');
  assert.equal(f.store.history(scope).at(-1).text, '这下可以庆祝了！');
  await f.bot.message(message()); assert.equal(f.bot.images.length, 1, 'redelivery never repeats the image');
  await f.bot.message(message({ messageId: 'followup', content: '你刚发的是什么' }));
  assert.ok(f.calls[1][0].some(m => typeof m.content === 'string' && m.content.includes('实际附有表情包：好耶')));
  assert.equal(f.calls[1][1], false, 'a sent sticker does not require a vision call');
});

test('QQ never opens model-supplied image IDs or sends when disabled, serious or malformed', async t => {
  for (const item of [
    { id: '../../pet.config.json' }, { id: 'https://untrusted.test/a.png' },
    { id: 'cheer', mode: 'off' }, { id: 'laugh', content: '这个代码报错，帮我排查' },
    { id: 'laugh', content: '胸痛需要怎么治疗' }, { id: 'cheer', content: '不要发表情包' },
    { raw: '{"text":"控制字段不能外泄", "sticker":' },
  ]) await t.test(JSON.stringify(item), async t => {
    const f = await fixture(t, async () => item.raw ?? reaction(item.id));
    if (item.mode) f.config.update({ qq: { stickers: item.mode } });
    await f.bot.message(message({ content: item.content || '开心！' }));
    assert.equal(f.bot.uploads.length, 0); assert.equal(f.bot.images.length, 0);
    assert.ok(!f.bot.sent[0].text.includes('"sticker"'));
    if (item.raw) assert.equal(f.store.history(qqScope('123456', message())).length, 0);
  });
});

test('QQ sticker cooldown enforces time, turns, no repeats and survives restart', async t => {
  let time = 1000, selected = 'cheer';
  const f = await fixture(t, async () => reaction(selected)); f.qq.now = () => time;
  const send = id => f.bots.at(-1).message(message({ messageId: id, content: '今天开心' }));
  await send('1'); assert.equal(f.bot.images.length, 1);
  time += 120000; selected = 'laugh';
  await send('2'); await send('3'); assert.equal(f.bot.images.length, 1, 'time alone is insufficient');
  await send('4'); assert.equal(f.bot.images.length, 2);
  await f.qq.stop(); await f.qq.start(); await Promise.resolve(); selected = 'hug';
  await send('5'); await send('6'); await send('7'); assert.equal(f.bots[1].images.length, 0, 'turns alone are insufficient after restart');
  time += 120000; await send('8'); assert.equal(f.bots[1].images.length, 1);
  time += 120000; await send('9'); await send('10'); await send('11');
  assert.equal(f.bots[1].images.length, 1, 'do not send the same sticker twice in succession');
});

test('group members share the sticker rate limit without sharing chat history', async t => {
  const f = await fixture(t, async () => reaction());
  f.config.update({ qq: { groupMode: 'open' } });
  const msg = message({ kind: 'group', groupOpenid: 'g1', rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: '好消息！' });
  await f.bot.message(msg); await f.bot.message({ ...msg, senderId: 'u2', messageId: 'm2' });
  assert.equal(f.bot.images.length, 1); assert.equal(f.bot.images[0].scope, 'group');
  assert.equal(f.store.history(qqScope('123456', msg)).length, 2);
  assert.equal(f.store.history(qqScope('123456', { ...msg, senderId: 'u2' })).at(-1).sticker, null);
  assert.equal(f.calls[1][0].filter(m => m.role === 'assistant').length, 0);
});

test('QQ image failures preserve sent text and never retry an ambiguous image', async t => {
  for (const step of ['uploadError', 'imageError']) await t.test(step, async t => {
    const f = await fixture(t, async () => reaction());
    f.bot[step] = new Error('PRIVATE-QQ-SECRET response dump');
    const msg = message({ content: '今天好开心' });
    await f.bot.message(msg); await f.bot.message(msg);
    assert.equal(f.bot.sent.length, 1); assert.equal(f.bot.uploads.length, 1);
    assert.equal(f.store.history(qqScope('123456', msg)).at(-1).sticker, null);
    assert.equal(f.store.db.prepare('SELECT status FROM qq_deliveries').get().status, 'sent');
    assert.match(f.qq.lastError, /文字已发送.*未确认送达/); assert.ok(!f.qq.lastError.includes('PRIVATE'));
  });
});

test('revoking access or turning stickers off between text and image suppresses upload', async t => {
  for (const change of [{ allowedUsers: [] }, { stickers: 'off' }]) await t.test(JSON.stringify(change), async t => {
    const f = await fixture(t, async () => reaction()); f.bot.afterText = () => f.config.update({ qq: change });
    await f.bot.message(message());
    assert.equal(f.bot.sent.length, 1); assert.equal(f.bot.uploads.length, 0);
  });
});

test('QQ rechecks access and settings after uploading, before sending media', async t => {
  for (const change of [{ allowedUsers: [] }, { stickers: 'off' }]) await t.test(JSON.stringify(change), async t => {
    const f = await fixture(t, async () => reaction()); f.bot.beforeUpload = () => f.config.update({ qq: change });
    await f.bot.message(message());
    assert.equal(f.bot.uploads.length, 1); assert.equal(f.bot.images.length, 0);
    assert.equal(f.store.history(qqScope('123456', message())).at(-1).sticker, null);
  });
});

test('stopping QQ releases a hung upload and its late completion cannot send an image', async t => {
  const f = await fixture(t, async () => reaction()); let release;
  f.bot.beforeUpload = () => new Promise(resolve => { release = resolve; });
  const task = f.bot.message(message());
  for (let i = 0; !release && i < 10; i++) await new Promise(setImmediate);
  assert.ok(release); await f.qq.stop(); await task; release(); await new Promise(setImmediate);
  assert.equal(f.bot.images.length, 0); assert.equal(f.qq.pending, 0);
});

test('a hung QQ image upload times out without sending or duplicating text', async t => {
  const f = await fixture(t, async () => reaction()); let started = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.bot.beforeUpload = () => { started = true; return new Promise(() => {}); };
  const task = f.bot.message(message());
  for (let i = 0; !started && i < 10; i++) await new Promise(setImmediate);
  assert.ok(started); t.mock.timers.tick(20001); await task;
  assert.equal(f.bot.images.length, 0); assert.equal(f.bot.sent.length, 1); assert.equal(f.qq.pending, 0);
  assert.match(f.qq.lastError, /文字已发送/);
});

test('official QQ SDK produces passive text, upload and image requests', async t => {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  const f = await fixture(t, async () => reaction());
  const real = new QQBot({ appId: '123456', appSecret: 'TEST-SECRET', markdownSupport: false });
  const requests = [];
  real.tokenManager.getAccessToken = async () => 'TEST-TOKEN';
  real.apiClient.request = async (_token, method, path, body) => {
    requests.push({ method, path, body });
    return path.endsWith('/files') ? { file_info: 'TEST-UPLOADED-FILE', ttl: 0 } : { id: 'TEST-REPLY' };
  };
  f.bot.sendText = real.sendText.bind(real); f.bot.uploadMedia = real.uploadMedia.bind(real);
  f.bot.mediaApi = real.mediaApi; f.bot.getCredentials = real.getCredentials.bind(real);
  await f.bot.message(message({ messageId: 'sdk-sticker', content: '好开心' }));
  assert.equal(requests.length, 3, f.qq.lastError);
  assert.equal(requests[0].body.msg_type, 0);
  assert.equal(requests[1].path, '/v2/users/u1/files');
  assert.equal(requests[1].body.file_type, 1); assert.equal(requests[1].body.srv_send_msg, false);
  assert.ok(requests[1].body.file_data.startsWith('iVBOR')); assert.equal(requests[1].body.url, undefined);
  assert.equal(requests[2].path, '/v2/users/u1/messages'); assert.equal(requests[2].body.msg_type, 7);
  assert.equal(requests[2].body.msg_id, 'sdk-sticker');
  for (const request of [requests[0], requests[2]]) assert.ok(Number.isInteger(request.body.msg_seq) && request.body.msg_seq >= 0 && request.body.msg_seq <= 65535);
  assert.deepEqual(requests[2].body.media, { file_info: 'TEST-UPLOADED-FILE' });
});
