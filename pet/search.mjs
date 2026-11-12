import { createHash } from 'node:crypto';
import { BridgeError, requestJSON } from '../lib.mjs';
import { endpoint } from './config.mjs';

export function searchQuery(text, forced = false, interests = []) {
  const command = text.match(/^\/(?:search|搜索)\s+([\s\S]+)$/i);
  const natural = /^(?:(?:请|麻烦|能不能|可以|能|可不可以)[，, ]*)?(?:(?:帮我|给我|帮忙)[，, ]*)?(?:搜(?:索|一下|一搜|点|点儿)?|查(?:一下|一查|查)|找(?:一下|一找|点|一些|点儿|找))/.test(text);
  if (!forced && !command && !natural) return null;
  let query = (command?.[1] || text).trim();
  if (query.length > 500) throw new BridgeError('搜索问题请缩短到 500 字以内，或用 /搜索 加上关键词。');
  if (/找(?:点|一些|点儿).{0,5}(?:有趣|好玩|新鲜)/.test(query) && interests.length) query += ' ' + interests.slice(0, 3).join(' ');
  return query.slice(0, 500);
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
  async search(query, scope, signal) {
    const c = this.config.searchCredentials();
    if (!c.enabled) throw new BridgeError('联网搜索还没开启，请到「设置 → 联网搜索」配置并启用。');
    if (scope !== 'web:owner' && !c.channels) throw new BridgeError('目前只允许主人在小窝或桌宠搜索；其他通道需要在搜索设置中开启。');
    if (c.provider === 'tavily' && !c.apiKey) throw new BridgeError('请在「设置 → 联网搜索」填写 Tavily 搜索密钥，聊天模型密钥不能代替它。');
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new BridgeError('搜索关键词应为 1–500 字。');
    signal?.throwIfAborted();
    const signature = JSON.stringify(c), key = createHash('sha256').update(signature + scope + query).digest('hex'), cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 300000) return cached.sources;
    const status = this.status();
    if (status.used >= c.dailyLimit) throw new BridgeError('今天搜索次数已达到上限，可在搜索设置中调整。');
    this.store.setRuntime('searchBudget', { day: new Date(this.now()).toISOString().slice(0, 10), count: status.used + 1 });
    const url = endpoint(c.baseUrl, 'search');
    try {
      const options = { method: 'POST', timeoutMs: 25000, signal,
        headers: c.provider === 'tavily' ? { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` } : { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: c.provider === 'tavily' ? JSON.stringify({ query, search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false, auto_parameters: false }) : new URLSearchParams({ q: query, format: 'json', language: 'zh-CN', safesearch: '1' }).toString() };
      const result = await requestJSON(url, options, this.fetcher);
      signal?.throwIfAborted();
      if (signature !== JSON.stringify(this.config.searchCredentials())) throw new BridgeError('搜索设置已变更，请重新搜索。', 'search-changed');
      if (!Array.isArray(result?.results)) throw new BridgeError('搜索服务没有返回结果列表，请检查服务设置。');
      const seen = new Set(), sources = [];
      for (const entry of result.results.slice(0, 30)) {
        const url = publicSearchURL(entry?.url), snippet = plain(entry?.content, 1400);
        if (!url || !snippet || seen.has(url)) continue;
        seen.add(url); sources.push({ type: 'web', id: createHash('sha256').update(url).digest('hex').slice(0, 20), url, title: plain(entry.title, 180) || new URL(url).hostname, snippet, retrievedAt: this.now() });
        if (sources.length === 5) break;
      }
      if (this.cache.size >= 50) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { at: this.now(), sources }); return sources;
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      if (error.code === 'http-401' || error.code === 'http-403') throw new BridgeError(c.provider === 'searxng' ? '搜索被拒绝：请检查 SearXNG 是否开放 JSON 格式和访问权限。' : '搜索服务拒绝访问，请检查搜索 API Key。');
      if (error.code === 'http-429') throw new BridgeError('搜索服务限流或额度不足，请稍后再试。');
      if (error.code === 'search-changed') throw error;
      throw new BridgeError('这次联网搜索没有完成，请检查搜索服务地址或网络后重试；没有用旧知识冒充搜索结果。');
    }
  }
}
