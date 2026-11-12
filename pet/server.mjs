import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { BridgeError } from '../lib.mjs';
import { STICKERS } from './stickers.mjs';
import { memorySnapshot } from './memory.mjs';

// Public code and bundled artwork contain no configuration or credentials.
const assets = { '/app.js': 'text/javascript; charset=utf-8', '/avatar.js': 'text/javascript; charset=utf-8', '/voice.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8', '/desktop.js': 'text/javascript; charset=utf-8', '/desktop.css': 'text/css; charset=utf-8', '/assets/taolinghu.png': 'image/png', '/assets/taolinghu-hd.png': 'image/png' };
assets['/care.css'] = 'text/css; charset=utf-8';
assets['/assets/taolinghu-care.png'] = 'image/png';
assets['/desktop-chat.js'] = 'text/javascript; charset=utf-8';
for (const sticker of STICKERS) assets[sticker.url] = 'image/png';
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new BridgeError('请求需要 JSON 格式。');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new BridgeError('请求过大，请压缩图片或缩短录音。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new BridgeError('JSON 格式错误。'); }
}

export function createPetServer({ root, dataRoot = root, config, store, core, models, wechat, autonomy, qq, diary, token = randomBytes(32).toString('hex') }) {
  const active = new Set();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => { active.delete(controller); if (!res.writableEnded) controller.abort(); });
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = `http://${req.headers.host}`;
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': type });
      res.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!allowedHosts.includes(req.headers.host)) return send(403, { code: 'invalid_host', error: `访问地址不受支持，请在运行宠物程序的电脑上打开 http://127.0.0.1:${port}/。` });
    try {
      const url = new URL(req.url, origin);
      // Loading the public UI must not depend on browser Origin/Fetch-Metadata
      // quirks. Keep the host restriction and the exact file allowlist, and apply
      // the stricter source checks below to the token-bearing bootstrap page.
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        return send(200, readFileSync(join(root, 'web', url.pathname.slice(1))), assets[url.pathname]);
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(204, '', 'image/x-icon');
      if (url.pathname === '/' || url.pathname === '/desktop' || url.pathname === '/api/health') {
        const site = req.headers['sec-fetch-site'];
        const sameOriginNull = req.headers.origin === 'null' && site === 'same-origin';
        if ((req.headers.origin && req.headers.origin !== origin && !sameOriginNull) ||
            (site && !['same-origin', 'none'].includes(site))) return send(403, { code: 'page_source_rejected', error: `页面来源校验失败，请新建标签页并直接输入 http://127.0.0.1:${port}/。` });
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/desktop')) {
          const html = readFileSync(join(root, 'web', url.pathname === '/desktop' ? 'desktop.html' : 'index.html'), 'utf8').replace('__PET_TOKEN__', token);
          return send(200, html, 'text/html; charset=utf-8');
        }
        if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, project: 'little-pet', version: '0.13.1' });
      }
      // APIs use an explicit, unguessable per-start bearer token, never cookies.
      // A valid token is authoritative even when Origin/Fetch Metadata is absent
      // or rewritten. Do not enable CORS: foreign pages cannot read the bootstrap
      // token or pass a preflight for Authorization. Host checks still apply.
      if (!equal(req.headers.authorization, `Bearer ${token}`)) return send(401, { code: 'invalid_token', error: '页面授权已过期，请刷新页面。' });
      const scope = url.searchParams.get('scope') || 'web:owner';
      if (req.method === 'GET') {
        if (url.pathname === '/api/desktop/state') {
          const last = store.history('web:owner', 1).at(-1);
          const publicConfig = config.public();
          return send(200, { config: { pet: publicConfig.pet, voice: publicConfig.voice,
            stt: { enabled: publicConfig.stt.enabled }, tts: { enabled: publicConfig.tts.enabled } }, care: core.interactions.status(),
            reply: last?.role === 'assistant' ? { id: last.id, text: last.text, origin: last.origin } : null });
        }
        if (url.pathname === '/api/model/balance') return send(200, await models.balance(controller.signal));
        if (url.pathname === '/api/state') return send(200, { config: config.public(), stickers: STICKERS, sessions: store.sessions(), exploration: autonomy?.status() || null, diary: diary?.status() || null, search: core.search.status(), care: core.interactions.status(), qq: qq?.status() || { state: 'stopped', contacts: [] }, wechat: wechat?.status() || { state: 'stopped' } });
        if (url.pathname === '/api/memory') return send(200, memorySnapshot(store, scope));
        if (url.pathname === '/api/diary' && diary) return send(200, { status: diary.status(), entries: store.diaryEntries() });
        if (url.pathname === '/api/exploration' && autonomy) return send(200, autonomy.details());
        if (url.pathname === '/api/history') return send(200, { messages: store.history(scope), memories: store.memories(scope) });
        if (url.pathname === '/api/wechat/qr') {
          try { return send(200, readFileSync(join(dataRoot, 'data', 'login-qr.png')), 'image/png'); }
          catch { return send(404, { error: '暂无二维码；如需登录，请点击连接微信。' }); }
        }
      }
      if (req.method !== 'POST') return send(404, { error: '接口不存在。' });
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('请求内容须为对象。');
      if (url.pathname === '/api/config') {
        const before = JSON.stringify([config.qqCredentials(), config.value.qq.sandbox]);
        const wasExploring = config.value.exploration.enabled;
        const result = config.update(input);
        if (['diary', 'model', 'pet'].some(key => input[key] !== undefined)) await diary?.settingsChanged();
        if (input.qq && before !== JSON.stringify([config.qqCredentials(), config.value.qq.sandbox])) await qq?.stop();

        if (['exploration', 'model', 'vision', 'stt', 'pet'].some(key => input[key] !== undefined)) await autonomy?.settingsChanged({ closeBrowser: wasExploring && !config.value.exploration.enabled });
        return send(200, { config: result });
      }
      if (url.pathname.startsWith('/api/exploration/')) {
        if (!autonomy) throw new BridgeError('探索服务未启动。');
        if (url.pathname === '/api/exploration/login') return send(200, await autonomy.openLogin());
        if (url.pathname === '/api/exploration/verify') return send(200, await autonomy.verifyLogin());
        if (url.pathname === '/api/exploration/logout') return send(200, await autonomy.changeAccount(false));
        if (url.pathname === '/api/exploration/switch-account') return send(200, await autonomy.changeAccount(true));
        if (url.pathname === '/api/exploration/dialog') return send(200, await autonomy.explorer.resolveDialog(input.accept));
        if (url.pathname === '/api/exploration/run') {
          if (autonomy.job || autonomy.accountJob || autonomy.explorer.busy) throw new BridgeError('本轮操作尚未结束。', 'busy');
          // The background job survives a tab closing. All errors are recorded in its diary.
          void autonomy.run(true).catch(e => store.event('error', e instanceof BridgeError ? e.message : '探索未能启动。'));
          return send(202, { ok: true, message: '已检查探索条件，请在动态中查看结果。' });
        }
        if (url.pathname === '/api/exploration/stop') { config.update({ exploration: { enabled: false } }); await autonomy.settingsChanged({ closeBrowser: true }); return send(200, { ok: true }); }
        if (url.pathname === '/api/exploration/read') { store.markExplorationRead(input.lastId); return send(200, { ok: true }); }
        if (url.pathname === '/api/exploration/clear') return send(200, await autonomy.clear());
      }
      if (url.pathname === '/api/pet/interact') return send(200, await core.exclusive('web:owner', () => {
        const result = core.interactions.perform('web:owner', input.action, input.requestId);
        store.ownerActivity();
        return result;
      }));
      if (url.pathname === '/api/qq/start') {
        if (!qq) throw new BridgeError('QQ 通道不可用，请重启宠物程序。');
        await qq.start(); return send(200, { ok: true });
      }
      if (url.pathname === '/api/qq/stop') { await qq?.stop(); return send(200, { ok: true }); }
      if (url.pathname === '/api/chat') {
        const text = await core.chat(input, controller.signal);
        return send(200, { text });
      }
      if (url.pathname === '/api/search/test') return send(200, { ...await core.search.run('人工智能 科技', 'web:owner', controller.signal), status: core.search.status() });
      if (url.pathname === '/api/diary/write') {
        if (!diary) throw new BridgeError('请重启宠物程序以启用日记服务。');
        return send(200, await diary.write(input.day || diary.today(), controller.signal));
      }
      if (url.pathname === '/api/diary/delete') {
        if (!diary) throw new BridgeError('日记服务未启动。');
        await diary.remove(input.day); return send(200, { ok: true });
      }
      if (url.pathname === '/api/history/clear') {
        await core.exclusive(input.scope || 'web:owner', () => store.clear(input.scope || 'web:owner'));
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/memory/add') return send(200, { id: store.remember(input.scope || 'web:owner', input.text) });
      if (url.pathname === '/api/memory/edit') { store.editMemory(input.scope || 'web:owner', input.id, input.text); return send(200, { ok: true }); }
      if (url.pathname === '/api/memory/delete') {
        if (typeof input.id !== 'string') throw new BridgeError('记忆标识无效。');
        store.forget(input.scope || 'web:owner', input.id); return send(200, { ok: true });
      }
      if (url.pathname === '/api/stt') {
        if (typeof input.audio !== 'string' || input.audio.length > 12 * 1024 * 1024) throw new BridgeError('录音格式错误。');
        return send(200, { text: await models.transcribe(Buffer.from(input.audio, 'base64'), input.mediaType, controller.signal) });
      }
      if (url.pathname === '/api/tts') {
        if (typeof input.text !== 'string' || !input.text.trim()) throw new BridgeError('缺少朗读文字。');
        return send(200, await models.speak(input.text, controller.signal), 'audio/mpeg');
      }
      if (url.pathname === '/api/wechat/start') { await wechat?.start(false); return send(200, { ok: true }); }
      if (url.pathname === '/api/wechat/login') { await wechat?.start(true); return send(200, { ok: true }); }
      if (url.pathname === '/api/wechat/stop') { await wechat?.stop(); return send(200, { ok: true }); }
      return send(404, { error: '接口不存在。' });
    } catch (e) { send(e.code === 'busy' ? 409 : e instanceof BridgeError ? 400 : 500, { error: e instanceof BridgeError ? e.message : '本地处理失败，请检查数据目录权限和磁盘空间。' }); }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 10000;
  return { server, token, abort: () => { for (const controller of active) controller.abort(); } };
}
