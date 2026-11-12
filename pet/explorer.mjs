import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BridgeError } from '../lib.mjs';
import { captureNoteMedia } from './explorer-media.mjs';

const ORIGIN = 'https://www.xiaohongshu.com';
export function noteURL(value) {
  try {
    const url = new URL(value, ORIGIN);
    const match = url.pathname.match(/^\/(?:explore|search_result|discovery\/item)\/([a-f0-9]{24})\/?$/i);
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
  const links = 'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]';
  return [...document.querySelectorAll(links)]
    .filter(visible).slice(0,60).map(a => {
      const card = a.closest('.note-item, section, article') || a;
      const title = [...card.querySelectorAll('.title, ' + links)].find(e => visible(e) && e.innerText?.trim());
      return { url: a.href, title: (title?.innerText || a.innerText || '').trim().slice(0,200),
        video: Boolean(card.querySelector('.play-icon, .video-play-icon, video')) };
    });
}
export function normalizeCards(raw) {
  const cards = new Map();
  for (const card of raw) {
    const note = noteURL(card.url); if (!note) continue;
    const previous = cards.get(note.id);
    // Search cards can contain an empty cover link and a token-bearing title link.
    const url = previous && new URL(previous.url).searchParams.has('xsec_token') ? previous.url : note.url;
    cards.set(note.id, { ...note, url, title: previous?.title || card.title, video: Boolean(previous?.video || card.video) });
  }
  return [...cards.values()];
}
export function pageStateDOM() {
  const visible = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none');
  const any = selector => [...document.querySelectorAll(selector)].some(visible);
  const body = (document.body?.innerText || '').slice(0,2000);
  const challenge = any('[id*="captcha"], [class*="captcha"], .verify-container, .verify-dialog, [class*="risk-control"]') ||
    /^(?:\s*小红书\s*)?(?:安全验证|访问过于频繁|访问频繁|请完成验证|网络环境存在风险)/.test(body.trim());
  const signedIn = [...document.querySelectorAll('a[href*="/user/profile/"]')].some(e => visible(e) &&
    /^(我|个人主页)$/.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
  const login = any('.login-container, .login-modal, .login-mask, [class*="login-dialog"]') ||
    (!signedIn && /扫码登录|手机号登录/.test(body.slice(0,700)));
  const empty = [...document.querySelectorAll('.empty-container, .no-result, .no-results, .search-empty')]
    .some(e => visible(e) && /暂无|没有|无相关|无结果/.test(e.innerText || ''));
  return { challenge, login, signedIn, empty };
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
  constructor(root, config, { launcher = chromium, captureMedia = captureNoteMedia } = {}) {
    this.config = config; this.launcher = launcher; this.captureMedia = captureMedia;
    this.profile = join(root, 'data', 'xiaohongshu-profile');
    this.context = null; this.page = null; this.busy = false; this.headless = null; this.recoveryURL = '';
    this.operation = null; this.closeRevision = 0;
    this.browsing = false; this.pendingDialog = null;
    this.state = existsSync(this.profile) ? 'unverified' : 'not-connected'; this.message = '';
  }
  hasPage() { return Boolean(this.context && this.page && !this.page.isClosed()); }
  status() { return { state: this.state, message: this.message, busy: this.busy, windowOpen: this.hasPage() && !this.headless,
    dialog: this.pendingDialog ? { type: this.pendingDialog.type(), message: this.pendingDialog.message().slice(0, 240) } : null }; }
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
    const context = this.context; this.context = null; this.page = null; this.headless = null; this.pendingDialog = null;
    if (context) await context.close().catch(() => {});
  }
  async launch(headless) {
    // A visible login/verification window belongs to the user until they close it
    // or explicitly stop. Never replace it just to switch to background browsing.
    if (this.hasPage() && (!this.headless || headless)) return this.page;
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
          headless, viewport: headless ? { width: 1280, height: 900 } : null, locale: 'zh-CN',
          ...(process.platform === 'win32' ? { chromiumSandbox: true } : {}),
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
    this.context = context; this.headless = headless;
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
      p.on('dialog', dialog => {
        if (this.headless || this.browsing || !['alert', 'confirm'].includes(dialog.type())) void dialog.dismiss().catch(() => {});
        else this.pendingDialog = dialog;
      });
      p.on('download', download => download.cancel().catch(() => {}));
    };
    this.page = context.pages()[0] || await context.newPage(); preparePage(this.page);
    for (const p of context.pages()) if (p !== this.page) await p.close();
    context.on('page', p => { preparePage(p); if (p !== this.page) p.close().catch(() => {}); });
    context.on('close', () => { if (this.context === context) { this.context = null; this.page = null; this.headless = null; this.pendingDialog = null; } });
    return this.page;
  }
  async visit(url) {
    if (!allowedRequest(url, true)) throw new BridgeError('只允许浏览小红书站内页面。', 'browse-error');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  async assertAccess() {
    if (this.pendingDialog) throw new BridgeError('小红书网页正在请求确认，请在探索页确认或取消后继续。', 'dialog-required');
    const state = await this.page.evaluate(pageStateDOM);
    if (state.challenge) throw new BridgeError('小红书需要安全验证。已暂停探索，请打开登录窗口手动完成验证。', 'verification-required');
    // Cookies are examined locally only and are never returned to the API/model.
    const hasSession = (await this.context.cookies(ORIGIN)).some(c => c.name === 'web_session' && c.value);
    if (state.login || !hasSession) throw new BridgeError('请先扫码登录小红书；登录失效时需要重新登录。', 'login-required');
    return state;
  }
  ready(message = '登录已确认，窗口会保留；可以直接点击「现在去逛逛」。') {
    this.state = 'ready'; this.message = message; this.recoveryURL = '';
    return this.status();
  }
  async refreshLogin() {
    // Passive check only: never launch, reload or navigate a verification page.
    if (this.busy || !this.hasPage() || this.headless || this.pendingDialog) return false;
    return this.exclusive(async () => {
      try {
        const state = await this.assertAccess();
        if (!state.signedIn) return false;
        this.ready(); return true;
      } catch (e) { this.failure(e); return false; }
    });
  }
  async waitForContent(selector, timeout) {
    try {
      // .first() can pick a hidden template and wait while other cards are visible.
      await this.page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(e =>
        e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'), selector, { timeout });
    } catch (e) { if (e.name !== 'TimeoutError') throw e; }
  }
  failure(error) {
    const e = error instanceof BridgeError ? error : new BridgeError('小红书页面没有成功加载，请检查网络或稍后重试。', 'browse-error');
    this.state = e.code; this.message = e.message;
    return e;
  }
  async openLogin() {
    return this.exclusive(() => this.showLogin());
  }
  async showLogin() {
      try {
        const reuse = this.hasPage() && !this.headless;
        await this.launch(false);
        if (!reuse || !allowedRequest(this.page.url(), true)) await this.visit(this.recoveryURL || `${ORIGIN}/explore`);
        await this.page.bringToFront();
        this.state = 'awaiting-login'; this.message = '请在浏览器中完成扫码或验证。会自动识别登录，也可直接点「现在去逛逛」；检查登录不会关闭窗口。';
        return this.status();
      } catch (e) { throw this.failure(e); }
  }
  async resolveDialog(accept) {
    if (typeof accept !== 'boolean') throw new BridgeError('请选择确认或取消。');
    const dialog = this.pendingDialog;
    if (!dialog) throw new BridgeError('网页确认框已关闭，请重新检查页面。');
    this.pendingDialog = null;
    try { await (accept ? dialog.accept() : dialog.dismiss()); }
    catch { throw new BridgeError('网页确认框已关闭，请重新检查页面。'); }
    return this.status();
  }
  async resetLogin({ reopen = false } = {}) {
    return this.exclusive(async () => {
      const revision = this.closeRevision;
      await this.close(false);
      try { await rm(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch { throw this.failure(new BridgeError('登录信息仍被浏览器占用，请关闭宠物打开的小红书窗口后重试。', 'browser-unavailable')); }
      if (revision !== this.closeRevision) throw new BridgeError('账号切换已停止。', 'aborted');
      this.recoveryURL = ''; this.state = 'not-connected'; this.message = '已清除宠物浏览器的小红书登录状态。需要时可重新扫码。';
      return reopen ? this.showLogin() : this.status();
    });
  }
  async verifyLogin() {
    return this.exclusive(async () => {
      try {
        if (!this.hasPage()) { await this.launch(false); await this.visit(this.recoveryURL || `${ORIGIN}/explore`); }
        await this.page.locator('body').waitFor({ state: 'visible' });
        await this.assertAccess();
        return this.ready();
      } catch (e) { throw this.failure(e); }
    });
  }
  async explore(topic, { signal, seen = () => false, limit = 3 } = {}) {
    return this.exclusive(async () => {
      const settings = structuredClone(this.config.value.exploration);
      const canSee = this.config.value.vision.enabled || this.config.value.model.supportsImages;
      const canHear = settings.transcribeVideo && this.config.value.stt.enabled;
      const abort = () => { void this.close(); };
      signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
      try {
        // Check the existing page before navigation so an unfinished CAPTCHA stays
        // intact; a stale awaiting-login flag alone must not block a signed-in user.
        if (this.hasPage()) await this.assertAccess();
        this.browsing = true;
        await this.launch(this.config.value.exploration.headless); signal?.throwIfAborted();
        const search = new URL('/search_result', ORIGIN); search.searchParams.set('keyword', topic); search.searchParams.set('source', 'web_explore_feed');
        await this.visit(search.href);
        await this.waitForContent('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"], .login-container, .login-modal, [id*="captcha"], [class*="captcha"], .empty-container, .no-result, .no-results, .search-empty', 15000);
        const state = await this.assertAccess();
        const raw = await this.page.evaluate(collectCardsDOM);
        const allCards = normalizeCards(raw), cards = allCards.filter(c => !c.video || settings.readVideos);
        if (!cards.length) {
          if (state.empty || allCards.length) { this.ready(state.empty ? '这个话题暂无搜索结果，可更换兴趣后再试。' : '本轮只有视频笔记，暂不读取视频内容。'); return []; }
          throw new BridgeError('搜索页没有显示可读取的笔记，可能尚未加载完成或页面结构已变化。请打开小红书窗口检查后重试；本轮不会生成浏览分享。', 'layout-changed');
        }
        const notes = []; let unreadable = false, videosRead = 0;
        for (const card of cards.filter(c => !seen(c.id)).slice(0, limit)) {
          if (card.video && videosRead >= 1) continue;
          signal?.throwIfAborted(); await this.visit(card.url);
          await this.waitForContent('#detail-desc, .note-content .desc, .note-text .desc, .note-detail-mask img, #noteContainer img, video, .login-container, .login-modal, [id*="captcha"], [class*="captcha"]', 12000);
          await this.assertAccess();
          const note = await this.page.evaluate(readNoteDOM);
          const video = note.video || card.video;
          if (video && (!settings.readVideos || videosRead >= 1)) continue;
          const current = noteURL(this.page.url());
          if (!current || current.id !== card.id) { unreadable = true; continue; }
          let media = null;
          if (video) videosRead++;
          const checkNoteAccess = async () => {
            await this.assertAccess();
            if (noteURL(this.page.url())?.id !== card.id) throw new BridgeError('笔记页面已切换，本轮停止读取该页面，请稍后重试。', 'page-changed');
          };
          if ((video && settings.readVideos && (canSee || canHear)) || (!video && settings.readImages && canSee)) {
            media = await this.captureMedia(this.page, { images: !video && settings.readImages, video, frames: canSee, audio: video && canHear, signal, checkAccess: checkNoteAccess });
          }
          await checkNoteAccess();
          if (!note.excerpt && !media?.images?.length && !media?.frames?.length && !media?.audio) { unreadable = true; continue; }
          notes.push({ id: card.id, url: card.url, title: note.title || card.title || '小红书笔记', author: note.author, excerpt: note.excerpt, media });
        }
        if (!notes.length && unreadable) throw new BridgeError('笔记正文未能读取，本轮不会把标题当成已读内容。可打开登录窗口检查页面。', 'layout-changed');
        this.ready('');
        return notes;
      } catch (e) {
        if (signal?.aborted) throw new BridgeError('本轮探索已停止。', 'aborted');
        const currentURL = this.page?.url();
        if (allowedRequest(currentURL, true)) this.recoveryURL = currentURL;
        throw this.failure(e);
      } finally { this.browsing = false; signal?.removeEventListener('abort', abort); if (this.headless) await this.close(); }
    });
  }
}
