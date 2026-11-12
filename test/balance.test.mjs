import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { Config } from '../pet/config.mjs';
import { Models } from '../pet/model.mjs';
import { Store } from '../pet/store.mjs';
import { PetCore } from '../pet/core.mjs';
import { createPetServer } from '../pet/server.mjs';
import { balanceCommand, queryBalance } from '../pet/balance.mjs';

const provider = { baseUrl: 'https://api.deepseek.com', apiKey: 'FAKE-BALANCE-KEY' };
const response = (total = '12.3456', isAvailable = true) => ({ is_available: isAvailable, balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '2.0000', topped_up_balance: '10.3456' }] });
const json = data => new Response(JSON.stringify(data));
function fixture(t, fetcher = async () => json(response())) {
  const root = mkdtempSync(join(tmpdir(), 'pet-balance-'));
  const config = new Config(root); config.update({ model: provider });
  const store = new Store(root), models = new Models(config, fetcher), core = new PetCore(config, store, models);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, store, models, core };
}

test('official balance uses a GET with the active key, preserves decimals and rejects redirects', async () => {
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/']) {
    const data = response(); data.balance_infos.push({ currency: 'USD', total_balance: '0.0001', granted_balance: '0', topped_up_balance: '0.0001' });
    data.secret = 'DO-NOT-RETURN';
    const result = await queryBalance({ ...provider, baseUrl }, async (url, options) => {
      assert.equal(String(url), 'https://api.deepseek.com/user/balance');
      assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, 'Bearer FAKE-BALANCE-KEY');
      assert.equal(options.redirect, 'error'); assert.ok(options.signal);
      return json(data);
    });
    assert.equal(result.balances[0].total, '12.3456');
    assert.equal(result.balances[1].total, '0.0001');
    assert.equal(result.notice, ''); assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.doesNotMatch(JSON.stringify(result), /FAKE-BALANCE-KEY|DO-NOT-RETURN/);
  }
});

test('unsupported hosts, paths and missing keys never send a request', async () => {
  const fetcher = async () => assert.fail('must not send credentials');
  for (const baseUrl of ['https://api.deepseek.com.evil.test', 'https://api.deepseek.com:8443', 'http://api.deepseek.com', 'https://proxy.test/v1', 'https://api.deepseek.com/other', 'https://user@api.deepseek.com', 'https://api.deepseek.com/?key=test']) {
    await assert.rejects(queryBalance({ ...provider, baseUrl }, fetcher), /仅支持/);
  }
  await assert.rejects(queryBalance({ ...provider, apiKey: '' }, fetcher), /先保存/);
});

test('zero balance remains a valid result, low CNY has a notice and currencies are not combined', async () => {
  const empty = await queryBalance(provider, async () => json(response('0.0000', false)));
  assert.equal(empty.isAvailable, false); assert.equal(empty.balances[0].total, '0.0000'); assert.match(empty.notice, /余额不足/);
  assert.match((await queryBalance(provider, async () => json(response('4.9999')))).notice, /低于 5 元/);
  assert.equal((await queryBalance(provider, async () => json(response('5.0000')))).notice, '');
});

test('provider failures and malformed payloads produce safe errors rather than zero or stale balances', async () => {
  for (const [status, message] of [[401, /认证失败/], [403, /账号权限/], [402, /余额不足/], [429, /频繁/], [500, /暂时无法/]]) {
    await assert.rejects(queryBalance(provider, async () => new Response('PRIVATE-UPSTREAM-KEY', { status })), e => message.test(e.message) && !e.message.includes('PRIVATE-UPSTREAM-KEY'));
  }
  for (const invalid of [null, {}, { ...response(), is_available: 'true' }, { is_available: true, balance_infos: [] }, { ...response(), balance_infos: [{ ...response().balance_infos[0], total_balance: 'NaN' }] }, { ...response(), balance_infos: [{ ...response().balance_infos[0], currency: 'EUR' }] }, { ...response(), balance_infos: [response().balance_infos[0], response().balance_infos[0]] }]) {
    await assert.rejects(queryBalance(provider, async () => json(invalid)), /有效的余额信息/);
  }
  await assert.rejects(queryBalance(provider, async () => { throw new Error('PRIVATE-UPSTREAM-KEY'); }), /网络/);
});

test('cancelling balance requests aborts the fetch, and changing accounts rejects a late response', async t => {
  const controller = new AbortController();
  const pending = queryBalance(provider, async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), controller.signal);
  controller.abort(); await assert.rejects(pending, /已取消/);
  let release;
  const f = fixture(t, async () => { await new Promise(resolve => { release = resolve; }); return json(response()); });
  const old = f.models.balance();
  f.config.update({ model: { apiKey: 'NEW-FAKE-KEY' } }); release();
  await assert.rejects(old, /配置已变更/);
});

test('balance follows the model environment key and does not use vision credentials', async t => {
  const previous = process.env.PET_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.PET_API_KEY; else process.env.PET_API_KEY = previous; });
  process.env.PET_API_KEY = 'FAKE-ENV-KEY';
  const f = fixture(t, async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer FAKE-ENV-KEY'); return json(response()); });
  f.config.update({ vision: { apiKey: 'FAKE-VISION-KEY' } });
  await f.models.balance();
});

test('a stalled balance service is bounded by a ten second deadline', async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 10000); return deadline.signal; });
  const pending = queryBalance(provider, async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  deadline.abort();
  await assert.rejects(pending, /超时/);
});

test('owner balance commands query without completion tokens and respect message deduplication', async t => {
  let calls = 0;
  const f = fixture(t, async (url) => { assert.match(String(url), /\/user\/balance$/); calls++; return json(response(String(20 - calls))); });
  const first = await f.core.chat({ text: '查询余额', requestId: 'balance-1' });
  assert.match(first, /19 元/); assert.match(first, /查询时间/);
  assert.equal(await f.core.chat({ text: '查询余额', requestId: 'balance-1' }), first);
  assert.equal(calls, 1);
  assert.match(await f.core.chat({ text: '还剩多少钱？', requestId: 'balance-2' }), /18 元/);
  assert.equal(calls, 2); assert.equal(f.store.history('web:owner').length, 4);
  for (const text of ['/balance', '/余额', '查询余额', '当前的模型余额', '帮我查询一下余额', '帮我查一下DeepSeek余额', '还有多少钱？']) assert.ok(balanceCommand(text), text);
  for (const text of ['解释一下余额是什么意思', '银行余额', '我的支付宝余额是多少', '写一篇关于余额的文章']) assert.equal(balanceCommand(text), false, text);
});

test('QQ and Weixin cannot query the owner balance, including after an owner query', async t => {
  const f = fixture(t);
  await f.core.chat({ text: '/余额' });
  f.models.fetcher = async () => assert.fail('no remote balance or model call');
  for (const scope of ['wechat:' + 'a'.repeat(64), 'qq:direct:' + 'b'.repeat(64), 'qq:group:' + 'c'.repeat(64)]) {
    const result = await f.core.chat({ scope, text: '查询余额' });
    assert.match(result, /仅支持在本机/); assert.doesNotMatch(result, /12.3456/);
  }
});

async function startServer(f) {
  cpSync(new URL('../web', import.meta.url), join(f.root, 'web'), { recursive: true });
  const app = createPetServer(f);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { app, url: `http://127.0.0.1:${app.server.address().port}` };
}

test('HTTP balance endpoint requires the local token and returns no credentials', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return json(response()); });
  const { app, url } = await startServer(f);
  try {
    const denied = await fetch(`${url}/api/model/balance`);
    assert.equal(denied.status, 401); assert.equal(calls, 0);
    const result = await fetch(`${url}/api/model/balance`, { headers: { Authorization: `Bearer ${app.token}` } });
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    const text = await result.text(); assert.match(text, /12.3456/); assert.doesNotMatch(text, /FAKE-BALANCE-KEY/);
  } finally { app.abort(); await new Promise(resolve => app.server.close(resolve)); }
});

async function until(predicate, label) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  assert.fail(`UI did not reach: ${label}`);
}

test('balance UI loads, refreshes, shows errors and drops results for unsaved or switched accounts', async t => {
  let calls = 0, mode = 'ok', release;
  const f = fixture(t, async () => {
    calls++;
    if (mode === 'defer') await new Promise(resolve => { release = resolve; });
    if (mode === 'error') return new Response('DO-NOT-DISPLAY', { status: 401 });
    return json(response(mode === 'zero' ? '0' : '4.1234', mode !== 'zero'));
  });
  const { app, url } = await startServer(f);
  const dom = new JSDOM(await (await fetch(url)).text(), { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, $ = selector => w.document.querySelector(selector);
  w.fetch = (path, options) => fetch(new URL(path, url), options);
  w.AbortController = AbortController;
  w.setInterval = () => 0;
  try {
    w.eval(readFileSync(join(f.root, 'web', 'voice.js'), 'utf8'));
    w.eval(readFileSync(join(f.root, 'web', 'avatar.js'), 'utf8'));
    w.eval(readFileSync(join(f.root, 'web', 'app.js'), 'utf8'));
    await until(() => $('[name="model.baseUrl"]').value === provider.baseUrl, 'configuration');
    assert.equal(calls, 0, 'no polling while on the home page');
    $('[data-page="settings"]').click();
    await until(() => $('#balance-details').textContent.includes('4.1234'), 'automatic balance on settings').catch(error => { throw new Error(`${error.message}: ${$('#balance-result').textContent}; requests=${calls}`); });
    assert.match($('#balance-notice').textContent, /低于 5 元/);
    assert.equal($('#balance-refresh').disabled, false);
    assert.match($('#balance-result').textContent, /查询于/);
    mode = 'error'; $('#balance-refresh').click();
    await until(() => $('#balance-result').textContent.includes('认证失败'), 'error message');
    assert.equal($('#balance-details').textContent, ''); assert.equal($('#balance-refresh').disabled, false);
    assert.doesNotMatch(w.document.body.textContent, /DO-NOT-DISPLAY|FAKE-BALANCE-KEY/);
    mode = 'zero'; $('#balance-refresh').click();
    await until(() => $('#balance-details').textContent.includes('¥ 0'), 'zero balance');
    assert.match($('#balance-notice').textContent, /余额不足/);
    mode = 'defer'; $('#balance-refresh').click();
    await until(() => Boolean(release), 'pending balance');
    $('[name="model.apiKey"]').value = 'NEW-FAKE-KEY';
    $('[name="model.apiKey"]').dispatchEvent(new w.Event('input'));
    release(); await delay(30);
    assert.equal($('#balance-details').textContent, ''); assert.match($('#balance-result').textContent, /先保存/);
    assert.equal($('#balance-refresh').disabled, true);
    mode = 'ok'; $('#settings-form button[type="submit"]').click();
    await until(() => $('#balance-details').textContent.includes('4.1234'), 'refresh after save');
    assert.equal(f.config.provider('model').apiKey, 'NEW-FAKE-KEY');
    $('[name="model.baseUrl"]').value = 'https://proxy.example.test/v1';
    $('[name="model.baseUrl"]').dispatchEvent(new w.Event('input'));
    const before = calls;
    $('#settings-form button[type="submit"]').click();
    await until(() => $('#balance-result').textContent.includes('当前服务暂不支持'), 'unsupported provider');
    assert.equal(calls, before); assert.equal($('#balance-details').textContent, '');
  } finally { w.close(); app.abort(); await new Promise(resolve => app.server.close(resolve)); }
});
