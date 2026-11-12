import { createHash } from 'node:crypto';
import { BridgeError, requestJSON } from '../lib.mjs';
import { endpoint } from './config.mjs';
import { ProxyAgent } from 'undici';

export function searchQuery(text, forced = false, interests = []) {
  text = text.trim();
  const command = text.match(/^\/(?:search|搜索)(?:\s+([\s\S]+))?$/i);
  if (command && !command[1]?.trim()) throw new BridgeError('请在 /搜索 后面加上关键词，例如 /搜索 最近有趣的科技新闻。');
  // Normalize a request's conversational opening, not arbitrary mentions in a sentence.
  const request = text.replace(/^(?:(?:那就|那么|那|再|重新|继续|现在|请|麻烦你|麻烦|能不能|可不可以|可以|能|帮我|帮忙|给我|替我|你)[，,\s]*)+/, '');
  const negated = /^(?:不用|不要|别|无需|不必)/.test(request);
  const aboutSearch = /^(?:搜索|联网搜索)(?:功能|设置|能力|服务|接口|结果|密钥|失败|引擎|是什么|怎么|为什么|过?吗|了?吗)/.test(request) || /^(?:搜(?:索)?|查(?:询)?|找)(?:不到|不了|不出|过吗|了吗)/.test(request);
  const direct = /^(?:搜索|搜(?:一下|下|一搜|点|点儿)?|查询|查(?:一下|下|一查|查)|找(?:一下|下|一找|点|一些|点儿|找))/.test(request);
  const online = /(?:网上|网络上|互联网|网页上|上网|联网|百度|谷歌|必应)/.test(request);
  const look = /^(?:(?:到|去|在|上)?(?:网上|网络上|互联网|网页上|上网|联网|百度|谷歌|必应)[，,\s]*)?(?:看(?:一下|下|一看|看)?|搜(?:索|一下|下|一搜)?|查(?:询|一下|下|一查|查)?|找(?:一下|下|一找|找|点)?)/.test(request);
  const natural = !negated && !aboutSearch && (direct || online && look);
  if (!command && negated) return null;
  if (!forced && !command && !natural) return null;
  let query = (command?.[1] || text).trim();
  if (query.length > 500) throw new BridgeError('搜索问题请缩短到 500 字以内，或用 /搜索 加上关键词。');
  if (/(?:找(?:点|一些|点儿).{0,5}(?:有趣|好玩|新鲜)|网上.{0,10}(?:趣事|新鲜事))/.test(query) && interests.length) query += ' ' + interests.slice(0, 3).join(' ');
  return query.slice(0, 500);
}

function searchResult(query, provider, sources, receivedCount, fetchedAt, cached = false) {
  const name = provider === 'tavily' ? 'Tavily' : 'SearXNG';
  return { sources, search: { status: sources.length ? 'results' : 'empty', provider, query, resultCount: sources.length, receivedCount, fetchedAt, cached,
    label: `${cached ? '复用搜索结果' : '已联网搜索'} · ${name} · ${sources.length ? `${sources.length} 条摘要` : '无可用结果'}` } };
}
export function emptySearchReply(info) {
  return `这次已通过 ${info.provider === 'tavily' ? 'Tavily' : 'SearXNG'} 搜索「${info.query}」，${info.receivedCount ? `服务返回了 ${info.receivedCount} 条记录，但没有同时包含有效公开链接和摘要的结果` : '服务返回了 0 条结果'}。换个更具体的关键词再试试吧。`;
}

export function searchFailure(error, provider) {
  const name = provider === 'tavily' ? 'Tavily' : 'SearXNG', http = /^http-(\d{3})$/.exec(error?.code || '')?.[1];
  if (http) {
    let hint = '请稍后重试或检查服务地址。';
    if (http === '401') hint = '搜索密钥缺失或无效，请检查搜索 API Key。';
    else if (http === '403') hint = provider === 'searxng' ? '请检查 SearXNG 是否开放 JSON 格式和访问权限。' : '服务拒绝访问，请检查密钥和账户权限。';
    else if (http === '429') hint = '服务限流或额度不足，请稍后重试并检查控制台。';
    else if (provider === 'tavily' && ['432', '433'].includes(http)) hint = '已达到 Tavily 账户或套餐额度上限，请检查 Tavily 控制台。';
    else if (['400', '404', '422'].includes(http)) hint = '请检查搜索服务地址和请求配置；Tavily 地址应为 https://api.tavily.com，不加 /search。';
    else if (Number(http) >= 500 || http === '434') hint = '搜索服务暂时不可用，请稍后重试。';
    return new BridgeError(`${name} 搜索请求失败（HTTP ${http}）。${hint}`, `search-http-${http}`);
  }
  if (error?.code === 'search-format' || error?.code === 'search-changed') return error;
  if (error?.code === 'aborted') return new BridgeError(`${name} 搜索等待超过 25 秒（SEARCH_TIMEOUT）。请检查网络或搜索代理设置后重试。`, 'search-timeout');
  const queue = [error], seen = new Set(), codes = new Set(); let invalidJSON = false, redirected = false;
  while (queue.length && seen.size < 20) {
    const item = queue.shift(); if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item); codes.add(item.code); invalidJSON ||= item.name === 'SyntaxError'; redirected ||= item.message === 'unexpected redirect';
    queue.push(item.cause, ...(Array.isArray(item.errors) ? item.errors.slice(0, 20) : []));
  }
  if (invalidJSON) return new BridgeError(`${name} 返回的内容不是有效 JSON（SEARCH_INVALID_JSON）。可能收到网页或网络拦截页，请检查服务地址和代理。`, 'search-json');
  if (redirected) return new BridgeError(`${name} 请求发生了重定向（SEARCH_REDIRECT）。请填写服务的直接 API 地址。`, 'search-redirect');
  const categories = [
    [['ENOTFOUND', 'EAI_AGAIN'], '域名解析失败，请检查网络或 DNS。'],
    [['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'], '连接超时，请检查网络；需要代理时，在联网搜索中填写本机 HTTP 代理地址。'],
    [['ECONNREFUSED'], '连接被拒绝；若配置了搜索代理，请确认代理已启动且端口正确。'],
    [['ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'], '网络连接中断或无法到达服务，请检查网络和代理。'],
    [['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'], 'TLS 证书校验失败，请检查系统时间、可信证书和网络代理。'],
  ];
  for (const [allowed, hint] of categories) { const code = allowed.find(c => codes.has(c)); if (code) return new BridgeError(`${name} 搜索失败（${code}）：${hint}`, 'search-network'); }
  return new BridgeError(`无法连接 ${name} 搜索服务（SEARCH_NETWORK）。请检查运行宠物电脑的网络和搜索代理设置；浏览器能打开网页不代表后台请求也能连通。`, 'search-network');
}
export function publicSearchURL(value) {
  try {
    const u = new URL(value), host = u.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port && !['80', '443'].includes(u.port) ||
        !host.includes('.') || /^(?:localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local') || host.endsWith('.localhost')) return null;
    if (u.href.length > 1800) return null;
    u.hash = ''; return u.href;
  } catch { return null; }
}
const plain = (value, limit) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, token => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[token]).slice(0, limit).trim() : '';

export class WebSearch {
  constructor(config, store, fetcher = fetch, now = Date.now) { Object.assign(this, { config, store, fetcher, now }); this.cache = new Map(); }
  status() {
    const day = new Date(this.now()).toISOString().slice(0, 10), budget = this.store.runtime('searchBudget', {});
    return { enabled: this.config.value.search.enabled, used: budget.day === day ? budget.count : 0, limit: this.config.value.search.dailyLimit };
  }
  async search(query, scope, signal) { return (await this.run(query, scope, signal)).sources; }
  async run(query, scope, signal) {
    const c = this.config.searchCredentials();
    if (!c.enabled) throw new BridgeError('联网搜索还没开启，请到「设置 → 联网搜索」配置并启用。');
    if (scope !== 'web:owner' && !c.channels) throw new BridgeError('目前只允许主人在小窝或桌宠搜索；其他通道需要在搜索设置中开启。');
    if (c.provider === 'tavily' && !c.apiKey) throw new BridgeError('请在「设置 → 联网搜索」填写 Tavily 搜索密钥，聊天模型密钥不能代替它。');
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new BridgeError('搜索关键词应为 1–500 字。');
    signal?.throwIfAborted();
    const signature = JSON.stringify(c), key = createHash('sha256').update(signature + scope + query).digest('hex'), cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 300000) return searchResult(query, c.provider, cached.sources, cached.receivedCount, cached.at, true);
    const status = this.status();
    if (status.used >= c.dailyLimit) throw new BridgeError('今天搜索次数已达到上限，可在搜索设置中调整。');
    this.store.setRuntime('searchBudget', { day: new Date(this.now()).toISOString().slice(0, 10), count: status.used + 1 });
    const url = endpoint(c.baseUrl, 'search');
    let proxy;
    try {
      if (c.proxyUrl) proxy = new ProxyAgent(c.proxyUrl);
      const options = { method: 'POST', timeoutMs: 25000, signal,
        ...(proxy ? { dispatcher: proxy } : {}),
        headers: c.provider === 'tavily' ? { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` } : { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: c.provider === 'tavily' ? JSON.stringify({ query, search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false, auto_parameters: false }) : new URLSearchParams({ q: query, format: 'json', language: 'zh-CN', safesearch: '1' }).toString() };
      const result = await requestJSON(url, options, this.fetcher);
      signal?.throwIfAborted();
      if (signature !== JSON.stringify(this.config.searchCredentials())) throw new BridgeError('搜索设置已变更，请重新搜索。', 'search-changed');
      if (!Array.isArray(result?.results)) throw new BridgeError('搜索服务没有返回 results 列表（SEARCH_FORMAT），请检查服务地址和配置。', 'search-format');
      const seen = new Set(), sources = [];
      for (const entry of result.results.slice(0, 30)) {
        const url = publicSearchURL(entry?.url), snippet = plain(entry?.content, 1400);
        if (!url || !snippet || seen.has(url)) continue;
        seen.add(url); sources.push({ type: 'web', id: createHash('sha256').update(url).digest('hex').slice(0, 20), url, title: plain(entry.title, 180) || new URL(url).hostname, snippet, retrievedAt: this.now() });
        if (sources.length === 5) break;
      }
      const at = this.now(), receivedCount = result.results.length;
      if (sources.length) {
        if (this.cache.size >= 50) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { at, sources, receivedCount });
      }
      return searchResult(query, c.provider, sources, receivedCount, at);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      throw searchFailure(error, c.provider);
    } finally { await proxy?.destroy().catch(() => {}); }
  }
}
