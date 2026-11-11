import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BridgeError } from '../lib.mjs';

const ORIGIN = 'https://www.xiaohongshu.com';
export function noteURL(value) {
  try {
    const url = new URL(value, ORIGIN);
    const match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i);
    if (url.origin !== ORIGIN || url.username || url.password || !match) return null;
    const clean = new URL(`/explore/${match[1]}`, ORIGIN);
    for (const key of ['xsec_token', 'xsec_source']) {
      const v = url.searchParams.get(key);
      if (v && v.length <= 600) clean.searchParams.set(key, v);
    }
    return { id: match[1].toLowerCase(), url: clean.href };
  } catch { return null; }
}
export function allowedRequest(value, mainDocument = false) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    if (mainDocument) return u.hostname === 'www.xiaohongshu.com';
    return ['xiaohongshu.com', 'xhscdn.com'].some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch { return false; }
}

// These functions run in the page. Read only rendered DOM, never internal state,
// authentication storage, network signatures, or page-provided instructions.
export function collectCardsDOM() {
  const visible = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  return [...document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]')]
    .filter(visible).slice(0,60).map(a => {
      const card = a.closest('.note-item, section, article') || a;
      return { url: a.href, title: (card.querySelector('.title')?.innerText || a.innerText || '').trim().slice(0,200),
        video: Boolean(card.querySelector('.play-icon, .video-play-icon, video')) };
    });
}
export function pageStateDOM() {
  const visible = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none');
  const any = selector => [...document.querySelectorAll(selector)].some(visible);
  const body = (document.body?.innerText || '').slice(0,2000);
  const challenge = any('[id*="captcha"], [class*="captcha"], .verify-container, .verify-dialog, [class*="risk-control"]') ||
    /^(?:\s*小红书\s*)?(?:安全验证|访问过于频繁|访问频繁|请完成验证|网络环境存在风险)/.test(body.trim());
  const login = any('.login-container, .login-modal, .login-mask, [class*="login-dialog"]') || /扫码登录|手机号登录/.test(body.slice(0,700));
  return { challenge, login };
}
export function readNoteDOM() {
  const visible = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const pick = selector => [...document.querySelectorAll(selector)].find(visible);
  const root = pick('.note-detail-mask, .note-detail, #noteContainer') || document;
  const title = pick('#detail-title, .note-content .title');
  const desc = pick('#detail-desc, .note-content .desc, .note-text .desc');
  const author = root.querySelector('.author-container .username, .author .username, .author-container .name');
  return { title: (title?.innerText || '').trim().slice(0,200), author: (author?.innerText || '').trim().slice(0,100),
    excerpt: (desc?.innerText || '').trim().slice(0,4500), video: Boolean(root.querySelector('video')) };
}

export class XiaohongshuExplorer {
  constructor(root, config, { launcher = chromium } = {}) {
    this.config = config; this.launcher = launcher;
    this.profile = join(root, 'data', 'xiaohongshu-profile');
    this.context = null; this.page = null; this.busy = false;
    this.operation = null; this.closeRevision = 0;
    this.state = existsSync(this.profile) ? 'unverified' : 'not-connected'; this.message = '';
  }
  status() { return { state: this.state, message: this.message, busy: this.busy }; }
  async exclusive(fn) {
    if (this.busy) throw new BridgeError('小红书浏览器正在使用，请稍后再试。', 'busy');
    this.busy = true;
    try {
      this.operation = fn();
      return await this.operation;
    } finally { this.busy = false; this.operation = null; }
  }
  async cancel() {
    const operation = this.operation;
    await this.close();
    if (operation) await operation.catch(() => {});
  }
  async close(invalidate = true) {
    if (invalidate) this.closeRevision++;
    const context = this.context; this.context = null; this.page = null;
    if (context) await context.close().catch(() => {});
  }
  async launch(headless) {
    const revision = this.closeRevision;
    const checkCancelled = () => {
      if (revision !== this.closeRevision) throw new BridgeError('浏览器操作已停止。', 'aborted');
    };
    await this.close(false);
    checkCancelled();
    mkdirSync(this.profile, { recursive: true, mode: 0o700 });
    const choice = this.config.value.exploration.browser;
    const choices = choice === 'auto' ? (process.platform === 'win32' ? ['msedge', 'chrome', 'chromium'] : ['chromium', 'chrome', 'msedge']) : [choice];
    let context;
    for (const channel of choices) {
      checkCancelled();
      try {
        const localChromium = channel === 'chromium' && process.platform === 'linux' && existsSync('/usr/bin/chromium');
        context = await this.launcher.launchPersistentContext(this.profile, {
          ...(channel === 'chromium' ? (localChromium ? { executablePath: '/usr/bin/chromium' } : {}) : { channel }),
          headless, viewport: { width: 1280, height: 900 }, locale: 'zh-CN',
          acceptDownloads: false, serviceWorkers: 'block', permissions: [], timeout: 20000,
        });
        break;
      } catch { /* Try the next installed browser; never expose profile paths/cookies in errors. */ }
    }
    if (revision !== this.closeRevision) {
      if (context) await context.close().catch(() => {});
      checkCancelled();
    }
    if (!context) throw new BridgeError('无法打开浏览器。请安装 Chrome/Edge，或在项目目录运行 npm run browser:install。Linux 扫码登录还需要图形桌面。', 'browser-unavailable');
    this.context = context;
    context.setDefaultTimeout(10000);
    await context.route('**/*', async route => {
      const request = route.request();
      let main = false;
      try { main = request.isNavigationRequest() && !request.frame().parentFrame(); } catch { main = true; }
      if (!allowedRequest(request.url(), main)) return route.abort('blockedbyclient');
      return route.continue();
    });
    checkCancelled();
    const preparePage = p => {
      p.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      p.on('download', download => download.cancel().catch(() => {}));
    };
    this.page = context.pages()[0] || await context.newPage(); preparePage(this.page);
    for (const p of context.pages()) if (p !== this.page) await p.close();
    context.on('page', p => { preparePage(p); if (p !== this.page) p.close().catch(() => {}); });
    context.on('close', () => { if (this.context === context) { this.context = null; this.page = null; } });
    return this.page;
  }
  async visit(url) {
    if (!allowedRequest(url, true)) throw new BridgeError('只允许浏览小红书站内页面。', 'browse-error');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  async assertAccess() {
    const state = await this.page.evaluate(pageStateDOM);
    if (state.challenge) throw new BridgeError('小红书需要安全验证。已暂停探索，请打开登录窗口手动完成验证。', 'verification-required');
    // Cookies are examined locally only and are never returned to the API/model.
    const hasSession = (await this.context.cookies(ORIGIN)).some(c => c.name === 'web_session' && c.value);
    if (state.login || !hasSession) throw new BridgeError('请先扫码登录小红书；登录失效时需要重新登录。', 'login-required');
  }
  failure(error) {
    const e = error instanceof BridgeError ? error : new BridgeError('小红书页面没有成功加载，请检查网络或稍后重试。', 'browse-error');
    this.state = e.code; this.message = e.message;
    return e;
  }
  async openLogin() {
    return this.exclusive(async () => {
      try {
        await this.launch(false); await this.visit(`${ORIGIN}/explore`);
        this.state = 'awaiting-login'; this.message = '在新窗口完成扫码或验证，然后回到这里点击「检查登录」。';
        return this.status();
      } catch (e) { await this.close(); throw this.failure(e); }
    });
  }
  async verifyLogin() {
    return this.exclusive(async () => {
      try {
        if (!this.context || !this.page || this.page.isClosed()) { await this.launch(false); await this.visit(`${ORIGIN}/explore`); }
        await this.page.locator('body').waitFor({ state: 'visible' });
        await this.assertAccess();
        this.state = 'ready'; this.message = '登录已检查，浏览时仍会检测会话是否有效。';
        await this.close();
        return this.status();
      } catch (e) { throw this.failure(e); }
    });
  }
  async explore(topic, { signal, seen = () => false, limit = 3 } = {}) {
    if (this.state === 'awaiting-login') throw new BridgeError('请先在登录窗口完成扫码并点击「检查登录」。', 'login-required');
    return this.exclusive(async () => {
      const abort = () => { void this.close(); };
      signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
      try {
        await this.launch(this.config.value.exploration.headless); signal?.throwIfAborted();
        const search = new URL('/search_result', ORIGIN); search.searchParams.set('keyword', topic); search.searchParams.set('source', 'web_explore_feed');
        await this.visit(search.href);
        await this.page.locator('a[href*="/explore/"], a[href*="/discovery/item/"], .login-container, [id*="captcha"], .empty-container').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        await this.assertAccess();
        const raw = await this.page.evaluate(collectCardsDOM);
        const cards = [...new Map(raw.filter(c => !c.video).flatMap(c => { const n = noteURL(c.url); return n ? [[n.id, { ...c, ...n }]] : []; })).values()];
        if (!cards.length) throw new BridgeError('没有读取到图文笔记。可能没有搜索结果，或小红书页面已变化；本轮不会生成浏览分享。', 'layout-changed');
        const notes = []; let unreadable = false;
        for (const card of cards.filter(c => !seen(c.id)).slice(0, limit)) {
          signal?.throwIfAborted(); await this.visit(card.url);
          await this.page.locator('#detail-desc, .note-content .desc, .note-text .desc, .login-container, [id*="captcha"]').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
          await this.assertAccess();
          const note = await this.page.evaluate(readNoteDOM);
          if (note.video) continue;
          if (!note.excerpt) { unreadable = true; continue; }
          const current = noteURL(this.page.url());
          if (!current || current.id !== card.id) { unreadable = true; continue; }
          notes.push({ id: card.id, url: card.url, title: note.title || card.title || '小红书笔记', author: note.author, excerpt: note.excerpt });
        }
        if (!notes.length && unreadable) throw new BridgeError('笔记正文未能读取，本轮不会把标题当成已读内容。可打开登录窗口检查页面。', 'layout-changed');
        this.state = 'ready'; this.message = '';
        return notes;
      } catch (e) {
        if (signal?.aborted) throw new BridgeError('本轮探索已停止。', 'aborted');
        throw this.failure(e);
      } finally { signal?.removeEventListener('abort', abort); await this.close(); }
    });
  }
}
