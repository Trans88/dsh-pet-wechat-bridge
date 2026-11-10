import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localOrigin, weixinOrigin, parseJSON, checkBusiness, requestJSON, Weixin, Pet,
  saveJSONFile, readJSONFile, newState, acceptMessage, enqueue,
  recoverUncertain, processQueue, splitReply, BridgeError,
} from '../lib.mjs';

const account = { botId: 'bot-id', userId: 'owner-id', token: 'TEST-TOKEN', baseUrl: 'https://ilinkai.weixin.qq.com/', linkedAt: 1_800_000_000_000 };
const message = (extra = {}) => ({
  message_id: '18446744073709551601', from_user_id: account.userId,
  to_user_id: account.botId, message_type: 1, message_state: 2,
  create_time_ms: account.linkedAt + 1000, context_token: 'TEST-CONTEXT',
  item_list: [{ type: 1, text_item: { text: '你好，记住我叫小明' } }], ...extra,
});
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('local address restriction and Weixin credential destination allowlist', () => {
  assert.equal(localOrigin('http://127.0.0.1:3080'), 'http://127.0.0.1:3080');
  assert.equal(localOrigin('http://[::1]:3080'), 'http://[::1]:3080');
  for (const value of ['https://example.com', 'http://127.0.0.1@evil.test', 'http://127.0.0.1:3080/path']) assert.throws(() => localOrigin(value));
  assert.equal(weixinOrigin('https://ilinkai.weixin.qq.com'), account.baseUrl);
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.test', 'https://evilwechat.com', 'https://ilinkai.weixin.qq.com:8443', 'https://user:pass@ilinkai.weixin.qq.com']) assert.throws(() => weixinOrigin(value));
});

test('uint64 IDs remain exact; quoted message text is untouched', () => {
  const parsed = parseJSON('{"message_id":18446744073709551601,"text":"message_id:18446744073709551601","count":1}');
  assert.equal(parsed.message_id, '18446744073709551601');
  assert.equal(parsed.text, 'message_id:18446744073709551601');
  assert.equal(parsed.count, 1);
});

test('HTTP status and business error codes both checked', async () => {
  await assert.rejects(requestJSON('https://unused.test', {}, async () => new Response('', { status: 403 })), { code: 'http-403' });
  assert.throws(() => checkBusiness({ ret: 0, errcode: -14 }), { code: 'auth-expired' });
  assert.throws(() => checkBusiness({ ret: '7' }), { code: 'business' });
  assert.equal(checkBusiness({ ret: '0' }).ret, '0');
});

test('request disables redirects and does not leak raw server error or token', async () => {
  let options;
  const api = new Weixin(account, async (_u, opts) => { options = opts; return new Response('TEST-TOKEN secret body', { status: 500 }); });
  await assert.rejects(api.send(account.userId, 'context', 'hello', 'id'), e => !e.message.includes('TEST-TOKEN') && e.code === 'http-500');
  assert.equal(options.redirect, 'error');
  await assert.rejects(api.call('https://other.weixin.qq.com/leak', {}));
});

test('QR requests carry no bot token or base_info; authenticated sends include protocol metadata', async () => {
  const calls = [];
  const api = new Weixin(account, async (url, opts) => { calls.push({ url: String(url), ...opts }); return json({ ret: 0 }); });
  await api.call('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { auth: false });
  await api.call('ilink/bot/get_qrcode_status?qrcode=test', undefined, { auth: false });
  await api.send(account.userId, 'ctx', '你好 🐱', 'id-1');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].body), { local_token_list: [] });
  assert.equal(calls[1].headers.AuthorizationType, undefined);
  assert.equal(calls[2].headers.Authorization, 'Bearer TEST-TOKEN');
  const sent = JSON.parse(calls[2].body);
  assert.equal(sent.msg.context_token, 'ctx');
  assert.equal(sent.msg.item_list[0].text_item.text, '你好 🐱');
  assert.match(sent.base_info.channel_version, /^3\.0\.0/);
});

test('only owner private finished text messages accepted', () => {
  assert.ok(acceptMessage(message(), account, account.linkedAt));
  for (const fields of [
    { from_user_id: 'stranger' }, { message_type: 2 }, { message_state: 1 },
    { group_id: 'group' }, { context_token: '' }, { to_user_id: 'other-bot' },
    { delete_time_ms: 123 }, { create_time_ms: account.linkedAt - 60000 },
    { item_list: [{ type: 4, file_item: {} }] },
  ]) assert.equal(acceptMessage(message(fields), account, account.linkedAt), null);
});

test('deduplication and inbox committed together with cursor', () => {
  const state = newState(account);
  enqueue(state, { msgs: [message(), message()], get_updates_buf: 'cursor-2' }, account);
  assert.equal(state.queue.length, 1);
  assert.equal(state.cursor, 'cursor-2');
  const restored = JSON.parse(JSON.stringify(state));
  enqueue(restored, { msgs: [message()], get_updates_buf: '' }, account);
  assert.equal(restored.queue.length, 1);
  assert.equal(restored.cursor, 'cursor-2');
});

test('atomic state read/write roundtrip includes Unicode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-test-'));
  try {
    const path = join(dir, 'state.json');
    saveJSONFile(path, { text: '小猫 🐱' });
    saveJSONFile(path, { text: '第二条' });
    assert.deepEqual(readJSONFile(path), { text: '第二条' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pet config picks only pet and chat uses surface=any; never calls ordinary DSH agent API', async () => {
  const calls = [];
  const pet = new Pet({ dshUrl: 'http://127.0.0.1:3080' }, async (url, opts) => {
    calls.push({ url: String(url), opts });
    return json(calls.length === 1 ? { main: { pets: [{ id: 'main' }] } } : { ok: true, text: '你好，小明！' });
  });
  await pet.check();
  assert.equal(await pet.chat('你好'), '你好，小明！');
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, '/dsh-pet-7340/chat');
  assert.equal(url.searchParams.get('pet'), 'main');
  assert.equal(url.searchParams.get('surface'), 'any');
  assert.deepEqual(JSON.parse(calls[1].opts.body), { text: '你好' });
});

test('multiple pets require explicit choice; HTTP 200 ok=false is a pet failure', async () => {
  const pet = new Pet({ dshUrl: 'http://localhost:3080' }, async () => json({ main: { pets: [{ id: 'a' }, { id: 'b' }] } }));
  await assert.rejects(pet.check(), /petId/);
  const failing = new Pet({ dshUrl: 'http://localhost:3080', petId: 'a' }, async () => json({ ok: false, reason: 'generate-error' }));
  await assert.rejects(failing.chat('hello'), { code: 'pet-generate-error' });
});

test('successful queue is serial, uses correct reply context, and suppresses redelivery', async () => {
  const state = newState(account), calls = [], writes = [];
  enqueue(state, { msgs: [message(), message({ message_id: 'second' })] }, account);
  await processQueue(state, {
    pet: { chat: async text => { calls.push(['pet', text]); return '你好 🐱'; } },
    weixin: { send: async (to, context, text) => calls.push(['wx', to, context, text]) },
    save: () => writes.push(JSON.parse(JSON.stringify(state))), log: () => {},
  });
  assert.deepEqual(calls.map(c => c[0]), ['pet', 'wx', 'pet', 'wx']);
  assert.deepEqual(calls[1].slice(1), [account.userId, 'TEST-CONTEXT', '你好 🐱']);
  assert.equal(writes[0].queue[0].status, 'generating');
  assert.ok(writes.some(s => s.queue[0]?.status === 'sending'));
  assert.equal(state.queue.length, 0);
  enqueue(state, { msgs: [message()] }, account);
  assert.equal(state.queue.length, 0);
});

test('ambiguous send is not retried or reported as delivered', async () => {
  const state = newState(account), logs = [];
  let sends = 0;
  enqueue(state, { msgs: [message()] }, account);
  const opts = { pet: { chat: async () => 'reply' }, weixin: { send: async () => { sends++; throw new BridgeError('timeout', 'aborted'); } }, save: () => {}, log: x => logs.push(x) };
  await processQueue(state, opts);
  enqueue(state, { msgs: [message()] }, account);
  await processQueue(state, opts);
  assert.equal(sends, 1);
  assert.ok(!logs.some(l => l.includes('宠物回复已发送')));
});

test('restart skips uncertain calls; prepared replies can resume without regenerating', async () => {
  const state = newState(account);
  enqueue(state, { msgs: [message()] }, account);
  state.queue[0].status = 'generating';
  assert.equal(recoverUncertain(state), 1);
  assert.equal(state.queue[0].status, 'failed');
  state.queue[0].status = 'ready';
  state.queue[0].chunks = [{ text: 'stored reply', clientId: 'same-id' }];
  let sent;
  await processQueue(state, { pet: { chat: () => { throw new Error('must not regenerate'); } },
    weixin: { send: async (...args) => { sent = args; } }, save: () => {}, log: () => {} });
  assert.equal(sent[2], 'stored reply');
  assert.equal(sent[3], 'same-id');
});

test('reply splitting preserves emoji and bounds output', () => {
  const text = '🐱你好'.repeat(1000);
  assert.equal(splitReply(text).join(''), text);
  assert.ok(splitReply('x'.repeat(10000)).length <= 4);
});

test('full flow against a real local mock HTTP pet server and mocked Weixin transport', async () => {
  let received;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/config')) return res.end(JSON.stringify({ main: { pets: [{ id: 'main' }] } }));
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { received = { url: req.url, body: JSON.parse(Buffer.concat(chunks)) }; res.end(JSON.stringify({ ok: true, text: '喵，小明！' })); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const pet = new Pet({ dshUrl: `http://127.0.0.1:${server.address().port}` });
    await pet.check();
    const output = [];
    const weixin = new Weixin(account, async (url, options) => {
      if (String(url).endsWith('/getupdates')) return json({ ret: 0, msgs: [message()], get_updates_buf: 'next' });
      output.push(JSON.parse(options.body)); return json({ ret: 0 });
    });
    const state = newState(account);
    enqueue(state, await weixin.updates(''), account);
    await processQueue(state, { pet, weixin, save: () => {}, log: () => {} });
    assert.equal(received.body.text, '你好，记住我叫小明');
    assert.match(received.url, /surface=any/);
    assert.equal(output[0].msg.item_list[0].text_item.text, '喵，小明！');
    assert.equal(state.seen.length, 1);
  } finally { await new Promise(r => server.close(r)); }
});
