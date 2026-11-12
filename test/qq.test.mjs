import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { QQBridge, qqScope, qqError } from '../pet/qq.mjs';

class FakeBot {
  handlers = {}; sent = []; starts = 0;
  on(type, fn) { this.handlers[type] = fn; return this; }
  async start(signal) { this.starts++; this.handlers.ready?.(); await new Promise(resolve => { this.done = resolve; signal.addEventListener('abort', resolve, { once: true }); }); }
  stop() { this.done?.(); }
  async sendText(target, text) { this.sent.push({ target, text }); if (this.sendError) throw this.sendError; }
  message(msg) { return this.handlers.message({}, msg); }
}
const message = (overrides = {}) => ({ kind: 'c2c', senderId: 'u1', messageId: 'm1', content: '你好', ...overrides });
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
  const first = f.bot.message(message()); await Promise.resolve();
  const second = f.bot.message(message({ messageId: 'm2' }));
  assert.equal(f.calls.length, 1);
  f.config.update({ qq: { allowedUsers: [] } }); release('生成完成'); await Promise.all([first, second]);
  assert.equal(f.bot.sent.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.qq.pending, 0);
});

test('QQ stop cancels generation and stale callbacks cannot deliver after disconnect', async t => {
  const f = await fixture(t, (_messages, _images, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const task = f.bot.message(message()); await Promise.resolve();
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
