import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { BridgeError } from '../lib.mjs';

// These two public files contain no configuration, credentials or per-user data.
const assets = { '/app.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8' };
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

export function createPetServer({ root, config, store, core, models, wechat, token = randomBytes(32).toString('hex') }) {
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
    if (!allowedHosts.includes(req.headers.host)) return send(403, { error: '请从本机地址打开宠物页面。' });
    try {
      const url = new URL(req.url, origin);
      // Loading the public UI must not depend on browser Origin/Fetch-Metadata
      // quirks. Keep the host restriction and the exact file allowlist, and apply
      // the stricter origin checks below to the token-bearing page and all APIs.
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        return send(200, readFileSync(join(root, 'web', url.pathname.slice(1)), 'utf8'), assets[url.pathname]);
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(204, '', 'image/x-icon');
      const site = req.headers['sec-fetch-site'];
      const sameOriginNull = req.headers.origin === 'null' && site === 'same-origin';
      if ((req.headers.origin && req.headers.origin !== origin && !sameOriginNull) ||
          (site && !['same-origin', 'none'].includes(site))) return send(403, { error: '请从本机地址打开宠物页面。' });
      if (req.method === 'GET' && url.pathname === '/') {
        const html = readFileSync(join(root, 'web', 'index.html'), 'utf8').replace('__PET_TOKEN__', token);
        return send(200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, project: 'little-pet', version: '0.3.1' });
      if (!equal(req.headers.authorization, `Bearer ${token}`)) return send(401, { error: '页面授权已过期，请刷新页面。' });
      const scope = url.searchParams.get('scope') || 'web:owner';
      if (req.method === 'GET') {
        if (url.pathname === '/api/state') return send(200, { config: config.public(), sessions: store.sessions(), wechat: wechat?.status() || { state: 'stopped' } });
        if (url.pathname === '/api/history') return send(200, { messages: store.history(scope), memories: store.memories(scope) });
        if (url.pathname === '/api/wechat/qr') {
          try { return send(200, readFileSync(join(root, 'data', 'login-qr.png')), 'image/png'); }
          catch { return send(404, { error: '暂无二维码；如需登录，请点击连接微信。' }); }
        }
      }
      if (req.method !== 'POST') return send(404, { error: '接口不存在。' });
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('请求内容须为对象。');
      if (url.pathname === '/api/config') return send(200, { config: config.update(input) });
      if (url.pathname === '/api/chat') {
        const text = await core.chat(input, controller.signal);
        return send(200, { text });
      }
      if (url.pathname === '/api/history/clear') {
        await core.exclusive(input.scope || 'web:owner', () => store.clear(input.scope || 'web:owner'));
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/memory/add') return send(200, { id: store.remember(input.scope || 'web:owner', input.text) });
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
