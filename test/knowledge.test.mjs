import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../pet/config.mjs';
import { Store } from '../pet/store.mjs';
import { Models } from '../pet/model.mjs';
import { PetCore } from '../pet/core.mjs';
import { WebSearch, searchQuery, publicSearchURL } from '../pet/search.mjs';
import { Diary, diaryDay } from '../pet/diary.mjs';
import { memorySnapshot } from '../pet/memory.mjs';
import { createPetServer } from '../pet/server.mjs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { BridgeError } from '../lib.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const result = { results: [{ title: '真实来源', url: 'https://example.org/news', content: '实际取得的搜索摘要。' }] };
function fixture(t, fetcher = async () => json(result)) {
  const root = mkdtempSync(join(tmpdir(), 'pet-knowledge-')), config = new Config(root), store = new Store(root), models = new Models(config, fetcher);
  config.update({ model: { baseUrl: 'https://model.example.test', apiKey: 'MODEL-PRIVATE' }, search: { enabled: true, apiKey: 'SEARCH-PRIVATE' } });
  const core = new PetCore(config, store, models);
  let time = Date.parse('2026-11-12T14:00:00Z');
  const diary = new Diary({ config, store, core, models, now: () => time });
  t.after(async () => { await diary.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, store, models, core, diary, now: () => time, at: value => { time = Date.parse(value); },
    chatAt(day, text = '今天一起调通桌宠了') { store.ensure('web:owner'); store.append('web:owner', text, null, '这下可以在桌面聊天了。'); store.db.prepare("UPDATE messages SET created=? WHERE scope='web:owner'").run(Date.parse(day)); } };
}

test('search/diary configuration defaults off, masks secrets and changes providers without forwarding old keys', t => {
  const f = fixture(t);
  assert.equal(new Config(mkdtempFor(t)).value.search.enabled, false);
  assert.equal(f.config.value.diary.enabled, false);
  assert.doesNotMatch(JSON.stringify(f.config.public()), /SEARCH-PRIVATE|MODEL-PRIVATE/);
  f.config.update({ search: { apiKey: '' } }); assert.equal(f.config.searchCredentials().apiKey, 'SEARCH-PRIVATE');
  const before = readFileSync(f.config.path, 'utf8');
  for (const patch of [{ diary: { time: '25:00' } }, { diary: { timeZone: 'Bad/Zone' } }, { search: { provider: 'unknown' } }, { search: { dailyLimit: 0 } }, { search: { channels: 'yes' } }]) assert.throws(() => f.config.update(patch));
  assert.equal(readFileSync(f.config.path, 'utf8'), before);
  f.config.update({ search: { provider: 'searxng', baseUrl: 'http://127.0.0.1:8080' } });
  assert.equal(f.config.searchCredentials().apiKey, '');
  assert.equal(new Config(f.root).value.search.provider, 'searxng');
});
function mkdtempFor(t) { const root = mkdtempSync(join(tmpdir(), 'pet-default-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('search uses only this query and its own key, preserves real sources and deduplicates retries', async t => {
  const calls = [];
  const f = fixture(t, async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return String(url).endsWith('/search') ? json(result) : json({ choices: [{ message: { content: '找到一个新内容 [1]' } }] });
  });
  f.store.remember('web:owner', 'PRIVATE_MEMORY');
  f.store.ensure('qq:direct:other'); f.store.append('qq:direct:other', 'OTHER_PRIVATE', null, 'OTHER_REPLY');
  const input = { text: '/搜索 有趣的科技项目', requestId: 'one-search' };
  await f.core.chat(input); await f.core.chat(input);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer SEARCH-PRIVATE');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer MODEL-PRIVATE');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['auto_parameters', 'include_answer', 'include_raw_content', 'max_results', 'query', 'search_depth'].sort());
  assert.doesNotMatch(JSON.stringify(calls[0]), /PRIVATE_MEMORY|OTHER_PRIVATE|MODEL-PRIVATE/);
  assert.match(calls[1].body.messages[0].content, /实际取得的搜索摘要/);
  assert.equal(f.store.history('web:owner').at(-1).sources[0].url, result.results[0].url);
  await f.core.chat({ text: '刚才的来源是什么' });
  assert.match(calls.at(-1).body.messages[0].content, /历史搜索摘要/);
  assert.match(calls.at(-1).body.messages[0].content, /example.org\/news/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1)), /OTHER_PRIVATE/);
  await f.core.chat({ text: input.text });
  assert.equal(calls.filter(c => c.url.endsWith('/search')).length, 1, 'same scope and query reuse five-minute evidence');
});

test('explicit search fails visibly when disabled or disallowed, while ordinary chat does not search', async t => {
  const f = fixture(t, async () => assert.fail('no network request expected'));
  assert.equal(searchQuery('你好'), null);
  assert.match(searchQuery('帮我找点有趣的', false, ['数码科技']), /数码科技/);
  assert.equal(searchQuery('/搜索 机器猫'), '机器猫');
  await assert.rejects(f.core.chat({ scope: 'qq:direct:other', text: '/搜索 科技' }), /只允许主人/);
  f.config.update({ search: { enabled: false } });
  await assert.rejects(f.core.chat({ text: '/搜索 科技' }), /还没开启/);
  assert.equal(f.store.history('web:owner').length, 0);
});

test('SearXNG posts JSON-format queries, filters duplicate/unsafe links and sends no provider key', async t => {
  let options;
  const f = fixture(t, async (_url, value) => { options = value; return json({ results: [...result.results, ...result.results, { url: 'javascript:alert(1)', content: 'x' }, { url: 'http://127.0.0.1/admin', content: 'secret' }, { url: 'https://empty.example.org' }] }); });
  f.config.update({ search: { provider: 'searxng', baseUrl: 'http://localhost:8080' } });
  const sources = await f.core.search.search('中文关键词', 'web:owner');
  assert.equal(sources.length, 1); assert.equal(options.headers.Authorization, undefined);
  assert.equal(new URLSearchParams(options.body).get('format'), 'json');
  assert.equal(new URLSearchParams(options.body).get('q'), '中文关键词');
  for (const url of ['file:///etc/passwd', 'data:text/html,x', 'https://u:p@example.org', 'http://10.1.2.3/a', 'http://[::1]/', 'http://localhost/']) assert.equal(publicSearchURL(url), null);
});

test('search reserves daily budget on failure, respects cancellation and rejects results after config changes', async t => {
  const f = fixture(t, async () => new Response('PRIVATE ERROR', { status: 429 }));
  f.config.update({ search: { dailyLimit: 1 } });
  await assert.rejects(f.core.search.search('one', 'web:owner'), /限流或额度/);
  await assert.rejects(f.core.search.search('two', 'web:owner'), /达到上限/);
  f.config.update({ search: { dailyLimit: 3 } });
  let finish; f.core.search.fetcher = async () => new Promise(resolve => { finish = resolve; });
  const work = f.core.search.search('three', 'web:owner');
  f.config.update({ search: { enabled: false } }); finish(json(result));
  await assert.rejects(work, /设置已变更/);
  f.config.update({ search: { enabled: true } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.core.search.search('four', 'web:owner', controller.signal), /abort/i);
});

test('memory inspection is deterministic, scoped, editable, and separate from recent context', async t => {
  const f = fixture(t, async () => assert.fail('memory command must not call a model'));
  const own = f.store.remember('web:owner', '我喜欢安静'), other = f.store.remember('qq:direct:other', 'OTHER_PRIVATE');
  assert.match(await f.core.chat({ text: '你记得我什么？' }), /我喜欢安静/);
  assert.doesNotMatch(await f.core.chat({ text: '/记忆' }), /OTHER_PRIVATE/);
  f.store.editMemory('web:owner', own, '我喜欢热闹');
  assert.throws(() => f.store.editMemory('web:owner', other, 'wrong'), /不存在/);
  const snapshot = memorySnapshot(f.store, 'web:owner');
  assert.equal(snapshot.memories[0].text, '我喜欢热闹'); assert.ok(snapshot.context.length > 0);
  f.store.forget('web:owner', own); assert.equal(memorySnapshot(f.store, 'web:owner').memories.length, 0);
  assert.ok(memorySnapshot(f.store, 'web:owner').context.length > 0, 'forgetting a fact does not secretly delete conversation');
});

test('daily writing uses only the requested owner day, persists once and does not turn diary prose into memory', async t => {
  let prompt, calls = 0;
  const f = fixture(t, async (_url, options) => { calls++; prompt = JSON.parse(options.body); return json({ choices: [{ message: { content: JSON.stringify({ title: '小小的进展', text: '今天，我们把桌宠调通了。' }) } }] }); });
  f.chatAt('2026-11-12T05:00:00Z');
  f.store.ensure('qq:direct:other'); f.store.append('qq:direct:other', 'OTHER_PRIVATE', null, 'OTHER_REPLY');
  const result = await f.diary.write('2026-11-12');
  assert.equal(result.outcome, 'written'); assert.match(JSON.stringify(prompt), /今天一起调通桌宠了/);
  assert.doesNotMatch(JSON.stringify(prompt), /OTHER_PRIVATE/);
  assert.equal((await f.diary.write('2026-11-12')).outcome, 'exists'); assert.equal(calls, 1);
  assert.equal(f.store.memories('web:owner').length, 0);
  const reopened = new Store(f.root); assert.equal(reopened.diaryEntries()[0].title, '小小的进展'); reopened.close();
});

test('schedule honors local time, catches up yesterday once, and deletion prevents resurrection', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return json({ choices: [{ message: { content: '{"title":"昨天的小事","text":"昨天一起聊了桌宠。"}' } }] }); });
  f.chatAt('2026-11-11T04:00:00Z'); f.at('2026-11-12T02:00:00Z');
  await f.diary.tick(); assert.equal(calls, 0, 'off means no background model work');
  f.config.update({ diary: { enabled: true } });
  await f.diary.tick(); assert.equal(f.store.diaryEntries()[0].day, '2026-11-11');
  await f.diary.tick(); assert.equal(f.store.diaryEntries().length, 1, 'before scheduled time');
  f.at('2026-11-12T13:30:00Z'); await f.diary.tick();
  assert.equal(f.store.diaryEntries().length, 2); assert.equal(calls, 1, 'quiet day uses honest local text without a model call');
  await f.diary.remove('2026-11-12'); await f.diary.tick();
  assert.equal(f.store.diaryEntries().length, 1); assert.equal((await f.diary.write('2026-11-12')).outcome, 'deleted');
  assert.equal(f.store.diaryEntry('2026-11-12').text, '');
});

test('day selection handles timezone boundaries and DST without inventing extra dates', t => {
  const f = fixture(t);
  f.chatAt('2026-03-08T06:30:00Z');
  assert.equal(f.store.dayMessages('2026-03-08', 'America/New_York').length, 2);
  assert.equal(f.store.dayMessages('2026-03-07', 'America/New_York').length, 0);
  f.chatAt('2026-11-11T16:00:00Z');
  assert.equal(f.store.dayMessages('2026-11-12', 'Asia/Shanghai').length, 4);
  assert.equal(f.store.dayMessages('2026-11-11', 'Asia/Shanghai').length, 0);
  for (const day of ['2026-02-30', 'bad', '2026-1-1']) assert.throws(() => diaryDay(day));
  assert.throws(() => f.diary.write('2999-01-01'), /未来/);
});

test('late diary generation cannot save after context is cleared, settings changed, or cancellation', async t => {
  let finish;
  const f = fixture(t, async () => new Promise(resolve => { finish = resolve; }));
  f.chatAt('2026-11-12T05:00:00Z');
  const work = f.diary.write('2026-11-12');
  f.store.clear('web:owner');
  finish(json({ choices: [{ message: { content: '{"title":"迟到","text":"不应保存"}' } }] }));
  await assert.rejects(work, /资料或设置已变更/); assert.equal(f.store.diaryEntries().length, 0);
  f.chatAt('2026-11-12T06:00:00Z');
  const controller = new AbortController(), second = f.diary.write('2026-11-12', controller.signal);
  controller.abort(); finish(json({ choices: [{ message: { content: '{"title":"取消","text":"不应保存"}' } }] }));
  await assert.rejects(second, /停止/); assert.equal(f.store.diaryEntries().length, 0);
});

test('new APIs retain authentication, redact secrets, and apply edits and deletes through the real store', async t => {
  const f = fixture(t), app = createPetServer({ ...f, root: f.root });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.abort(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of ['/api/memory', '/api/diary']) assert.equal((await fetch(url + path)).status, 401);
  const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  const id = f.store.remember('web:owner', '旧内容');
  assert.equal((await fetch(url + '/api/memory/edit', { method: 'POST', headers, body: JSON.stringify({ id, text: '新内容' }) })).status, 200);
  assert.match(await (await fetch(url + '/api/memory', { headers })).text(), /新内容/);
  assert.doesNotMatch(await (await fetch(url + '/api/state', { headers })).text(), /SEARCH-PRIVATE|MODEL-PRIVATE/);
  const response = await fetch(url + '/api/diary/write', { method: 'POST', headers, body: JSON.stringify({ day: '2026-11-12' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).outcome, 'written');
  await fetch(url + '/api/diary/delete', { method: 'POST', headers, body: JSON.stringify({ day: '2026-11-12' }) });
  assert.equal((await (await fetch(url + '/api/diary', { headers })).json()).entries.length, 0);
});

test('conversational search requests recognize the reported phrase without sending ordinary or negated chat', () => {
  for (const text of ['再帮我看下网上有什么趣事', '帮我看看网上有什么新鲜事', '你能不能帮我再搜索最近的科技新闻', '请帮忙上网查一下机器猫', '那就再帮我找点有趣的', '去网上看看最近的趣事', '搜索今天的科技新闻']) assert.ok(searchQuery(text), text);
  for (const text of ['你好', '帮我看看这段代码', '你觉得网上的趣事好笑吗', '我刚刚搜索到一个笑话', '请不要搜索我的聊天', '不用帮我上网查', '别搜索', '搜索功能怎么用', '搜索失败了怎么办', '你搜索过吗', '你搜过吗', '搜不到东西为什么', '你记得我什么']) assert.equal(searchQuery(text), null, text);
  assert.throws(() => searchQuery('/搜索'), /关键词/);
  assert.throws(() => searchQuery('/search  '), /关键词/);
  assert.equal(searchQuery('/搜索 猫咪 趣事'), '猫咪 趣事');
  assert.equal(searchQuery('今天的科技新闻', true), '今天的科技新闻');
});

test('reported natural request performs a search and persists truthful receipts across retries, cache and ordinary replies', async t => {
  const calls = [], f = fixture(t, async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return String(url).endsWith('/search') ? json(result) : json({ choices: [{ message: { content: '看看这个新项目 [1]' } }] });
  });
  const input = { text: '再帮我看下网上有什么趣事', requestId: 'reported-request' };
  await f.core.chat(input); await f.core.chat(input);
  assert.equal(calls.filter(c => c.url.endsWith('/search')).length, 1);
  const first = f.store.history('web:owner').at(-1).search;
  assert.equal(first.status, 'results'); assert.equal(first.resultCount, 1); assert.equal(first.cached, false);
  assert.match(first.query, /网上有什么趣事/); assert.doesNotMatch(JSON.stringify(first), /PRIVATE/);
  await f.core.chat({ text: input.text });
  const cached = f.store.history('web:owner').at(-1).search;
  assert.equal(cached.cached, true); assert.equal(cached.fetchedAt, first.fetchedAt); assert.match(cached.label, /复用/);
  assert.equal(calls.filter(c => c.url.endsWith('/search')).length, 1);
  await f.core.chat({ text: '谢谢' });
  assert.equal(f.store.history('web:owner').at(-1).search.status, 'not_requested');
  assert.match(calls.at(-1).body.messages[0].content, /本轮未执行联网搜索，不能声称/);
  const reopened = new Store(f.root); assert.deepEqual(reopened.history('web:owner')[1].search, first); reopened.close();
  assert.deepEqual(memorySnapshot(f.store, 'web:owner').context[1].search, first);
});

test('empty or unusable results are reported without model invention and are not cached as a failed search', async t => {
  let searches = 0, response = { results: [] };
  const f = fixture(t, async url => { assert.ok(String(url).endsWith('/search'), 'empty results must not call the model'); searches++; return json(response); });
  const input = { text: '/搜索 罕见关键词' };
  assert.match(await f.core.chat(input), /服务返回了 0 条结果/);
  assert.equal(f.store.history('web:owner').at(-1).search.status, 'empty');
  response = { results: [{ url: 'http://localhost/private', content: 'private' }] };
  assert.match(await f.core.chat(input), /返回了 1 条记录，但没有/);
  assert.equal(searches, 2, 'empty responses must allow an immediate retry');
  assert.equal(f.store.history('web:owner').at(-1).search.receivedCount, 1);
});

test('search errors preserve actionable codes without leaking raw messages, keys or provider bodies', async t => {
  let response;
  const f = fixture(t, async () => { if (response instanceof Error) throw response; return response; });
  f.config.update({ search: { dailyLimit: 100 } });
  let index = 0;
  const check = async (value, pattern) => {
    response = value;
    await assert.rejects(f.core.chat({ text: '/搜索 test-' + index++ }), error => { assert.match(error.message, pattern); assert.doesNotMatch(error.message, /PRIVATE|secret\.example/); return true; });
  };
  for (const status of [400, 401, 403, 404, 422, 429, 432, 433, 434, 500]) await check(new Response('SEARCH-PRIVATE', { status }), new RegExp('HTTP ' + status));
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'CERT_HAS_EXPIRED']) {
    await check(new Error('SEARCH-PRIVATE https://secret.example', { cause: new AggregateError([Object.assign(new Error('SEARCH-PRIVATE'), { code })]) }), new RegExp(code));
  }
  await check(new BridgeError('PRIVATE', 'aborted'), /SEARCH_TIMEOUT/);
  await check(new Response('<html>SEARCH-PRIVATE</html>'), /SEARCH_INVALID_JSON/);
  await check(json({ error: 'SEARCH-PRIVATE' }), /SEARCH_FORMAT/);
  await check(new Error('SEARCH-PRIVATE', { cause: { message: 'unexpected redirect' } }), /SEARCH_REDIRECT/);
  await check(new Error('SEARCH-PRIVATE'), /SEARCH_NETWORK/);
  assert.equal(f.store.history('web:owner').length, 0, 'failed search does not invent an assistant answer');
});

test('optional local HTTP proxy routes real requests through CONNECT and preserves search credentials', async t => {
  const f = fixture(t); let connections = 0, received;
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port, proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    connections++;
    assert.equal(req.url, `127.0.0.1:${port}`); assert.equal(req.headers.authorization, undefined);
    const upstream = connect(port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket); });
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { provider.closeAllConnections(); proxy.closeAllConnections(); await Promise.all([new Promise(r => provider.close(r)), new Promise(r => proxy.close(r))]); });
  f.config.update({ search: { baseUrl: `http://127.0.0.1:${port}`, proxyUrl: `http://127.0.0.1:${proxy.address().port}` } });
  // Changing provider origin clears the old key; explicitly save the key for this local fixture.
  f.config.update({ search: { apiKey: 'SEARCH-PRIVATE' } }); f.core.search.fetcher = fetch;
  const value = await f.core.search.run('本机代理验证', 'web:owner');
  assert.equal(connections, 1); assert.equal(value.sources.length, 1); assert.equal(received.path, '/search');
  assert.equal(received.auth, 'Bearer SEARCH-PRIVATE'); assert.equal(received.body.query, '本机代理验证');
  for (const proxyUrl of ['socks5://127.0.0.1:7890', 'http://u:PRIVATE@127.0.0.1:7890', 'http://remote.example:8080', 'http://127.0.0.1:7890/path']) assert.throws(() => f.config.update({ search: { proxyUrl } }));
  assert.equal(new Config(f.root).value.search.proxyUrl, f.config.value.search.proxyUrl);
});

test('upgrading from v4 keeps historical receipts unknown while retaining chat, memory and request dedup', t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-search-migration-')); let store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.ensure('web:owner'); store.remember('web:owner', '旧记忆'); store.append('web:owner', '旧聊天', null, '旧回复', 'old-request');
  store.db.exec('ALTER TABLE messages DROP COLUMN search; PRAGMA user_version=4'); store.close(); store = new Store(root);
  assert.equal(store.history('web:owner')[1].search, undefined); assert.equal(store.history('web:owner')[0].text, '旧聊天');
  assert.equal(store.memories('web:owner')[0].text, '旧记忆'); assert.equal(store.cached('web:owner', 'old-request'), '旧回复');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 5);
});
