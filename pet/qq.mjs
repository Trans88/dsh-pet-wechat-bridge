import { createHash } from 'node:crypto';
import { BridgeError } from '../lib.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const numericCode = value => /^\d{1,10}$/.test(String(value ?? '')) ? String(value) : '';
export function qqScope(appId, message) {
  return `qq:${message.kind === 'group' ? 'group' : 'direct'}:${digest([appId, message.kind, message.groupOpenid || '', message.senderId])}`;
}
export function qqError(error) {
  // The SDK sometimes wraps token errors in plain Error(message), including a
  // raw response body. Extract only known codes; never echo messages or bodies.
  const chain = [], pending = [error], seen = new Set();
  while (pending.length && chain.length < 8) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item); chain.push(item); pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 3));
  }
  const messages = chain.map(e => typeof e.message === 'string' ? e.message.slice(0, 2000) : '').join('\n');
  const tokenFailure = /access_token|^Token fetch failed:/m.test(messages);
  const http = chain.map(e => e.httpStatus).find(n => Number.isInteger(n) && n >= 100 && n <= 599) || Number(messages.match(/^Token fetch failed: HTTP (\d{3})\b/m)?.[1]) || 0;
  let apiCode = chain.map(e => numericCode(e.bizCode)).find(Boolean) || '';
  const tokenBody = messages.match(/^Failed to get access_token: (\{[^\n]*\})/m)?.[1];
  if (!apiCode && tokenBody) { try { const data = JSON.parse(tokenBody); apiCode = numericCode(data.code ?? data.errcode); } catch {} }
  const network = chain.map(e => e.code).find(code => networkCodes.has(code));
  const close = chain.map(e => e.closeCode).find(n => Number.isInteger(n) && n >= 1000 && n <= 4999);
  const suffix = [http && `HTTP ${http}`, apiCode && `QQ ${apiCode}`, close && `网关 ${close}`, network].filter(Boolean).join(' · ');
  let text;
  if (/白名单|\b(?:ip\s+(?:white|allow)list|ip\s+not\s+(?:in|allowed))\b/i.test(messages)) text = 'QQ 平台提示 IP 白名单限制，请在开发设置核对运行宠物电脑的公网出口 IP。';
  else if (close === 4914) text = 'QQ 机器人未上线或仅允许沙箱连接，请核对 QQ 后台状态与宠物页面的沙箱开关。';
  else if (close === 4915) text = 'QQ 平台禁止该机器人连接，请在机器人管理后台检查账号状态。';
  else if (network === 'ENOTFOUND' || network === 'EAI_AGAIN') text = '无法解析 QQ 服务域名，请检查这台电脑的 DNS、网络与代理设置。';
  else if (network && /CERT|TLS|SELF_SIGNED|SIGNATURE/.test(network)) text = '连接 QQ 时证书校验失败，请检查系统时间、证书与代理；不要关闭证书校验。';
  else if (network || (!http && /^(?:Network error\b|fetch failed\b)|\b(?:timeout|timed out)\b/im.test(messages))) text = '无法连通 QQ 服务或连接超时，请检查运行宠物电脑的网络、代理与防火墙。浏览器能打开网页不代表 Node.js 的连接也能成功。';
  else if (http === 429 || close === 4008) text = 'QQ 平台暂时限流，请稍后再连接，避免连续反复重试。';
  else if (http >= 500) text = 'QQ 服务暂时不可用，请稍后再连接。';
  else if (http === 401 || http === 403 || close === 4004 || tokenFailure) text = 'QQ 凭据校验或授权失败，请检查 AppID、AppSecret、机器人权限和 IP 白名单。';
  else if (chain.some(e => e.code === 'GATEWAY_FATAL_CLOSE')) text = 'QQ 平台拒绝连接，请检查机器人状态、沙箱范围与 WebSocket 接入方式。';
  else if (chain.some(e => e.code === 'GATEWAY_RETRY_EXHAUSTED')) text = 'QQ 多次重连失败，请检查网络和平台配置后重新连接。';
  else text = 'QQ 连接或发送失败，请检查网络、机器人凭据、平台权限与消息额度。';
  return suffix ? `${text}（${suffix}）` : text;
}
async function makeBot(options) {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  return new QQBot(options);
}

// The official SDK owns token refresh, heartbeat and reconnect. No public HTTP
// listener, account password, or dsh process is needed by this channel.
export class QQBridge {
  constructor({ config, store, core, factory = makeBot, connectionTimeoutMs = 60000, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { config, store, core, factory, connectionTimeoutMs, now, log });
    this.state = 'stopped'; this.lastError = ''; this.generation = 0;
    this.waitStartedAt = null; this.waitTimer = null;
    this.contacts = new Map(); this.queue = Promise.resolve(); this.pending = 0;
    store.db.exec('CREATE TABLE IF NOT EXISTS qq_deliveries (id TEXT PRIMARY KEY, status TEXT NOT NULL, created INTEGER NOT NULL)');
  }
  status() {
    const elapsedSeconds = this.waitStartedAt === null ? 0 : Math.max(0, Math.floor((this.now() - this.waitStartedAt) / 1000));
    return { state: this.state, error: this.lastError, elapsedSeconds, timeoutSeconds: Math.ceil(this.connectionTimeoutMs / 1000), pending: this.pending, contacts: [...this.contacts.values()] };
  }
  report(text) { this.log(`[QQ] ${text}`); }
  clearWait() { clearTimeout(this.waitTimer); this.waitTimer = null; this.waitStartedAt = null; }
  beginWait(live, controller, reconnecting = false) {
    // Repeat reconnect/error events must not extend the overall deadline.
    if (this.waitTimer) return;
    this.waitStartedAt = this.now();
    this.waitTimer = setTimeout(() => {
      if (!live()) return;
      const prior = this.lastError;
      this.fail(`${reconnecting ? 'QQ 重连' : 'QQ 连接'}等待超过 ${Math.ceil(this.connectionTimeoutMs / 1000)} 秒，已停止本次尝试。请检查网络、凭据和 QQ 平台配置后点击「重试连接」。${prior ? ` 最近错误：${prior}` : ''}`, controller);
    }, this.connectionTimeoutMs);
    this.waitTimer.unref?.();
  }
  fail(text, controller) {
    this.clearWait(); this.state = 'error'; this.lastError = text;
    controller.abort(); this.bot?.stop(); this.report(text);
  }
  allowed(msg) {
    const q = this.config.value.qq, group = msg.kind === 'group';
    const mode = group ? q.groupMode : q.directMode, ids = group ? q.allowedGroups : q.allowedUsers;
    return mode === 'open' || (mode === 'allowlist' && ids.includes(group ? msg.groupOpenid : msg.senderId));
  }
  async start() {
    if (this.state !== 'stopped' && this.state !== 'error') throw new BridgeError('QQ 已在连接或运行。');
    const credentials = this.config.qqCredentials();
    if (!credentials.appId || !credentials.appSecret) throw new BridgeError('先保存 QQ 机器人的 AppID 和 AppSecret。');
    const generation = ++this.generation;
    this.state = 'starting'; this.lastError = ''; this.contacts.clear();
    const controller = new AbortController(); this.controller = controller;
    const live = () => generation === this.generation && !controller.signal.aborted;
    this.clearWait(); this.beginWait(live, controller);
    this.report(`正在连接 QQ（最长等待 ${Math.ceil(this.connectionTimeoutMs / 1000)} 秒）。`);
    // A slow SDK import or handshake must not keep POST /api/qq/start open.
    this.run = (async () => {
      let bot;
      try {
        bot = await this.factory({ ...credentials, transport: 'websocket', intents: 1 << 25, markdownSupport: false,
          baseUrl: this.config.value.qq.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com',
          reconnect: { maxAttempts: 10 }, userAgent: 'little-pet/0.7.2' });
        if (!live()) { bot.stop(); return; }
        this.bot = bot;
        for (const event of ['ready', 'resumed']) bot.on(event, () => {
          if (live()) { this.clearWait(); this.state = 'connected'; this.lastError = ''; this.report('已连接 QQ，可以接收消息。'); }
        });
        bot.on('disconnected', info => {
          if (!live()) return;
          if (!info.willReconnect) { this.fail(qqError({ code: 'GATEWAY_FATAL_CLOSE', closeCode: info.code }), controller); return; }
          this.state = 'reconnecting';
          if (!this.waitTimer) this.report('QQ 已断开，正在重连。');
          this.beginWait(live, controller, true);
        });
        bot.on('error', error => {
          if (live()) { const text = qqError(error); if (text !== this.lastError) this.report(text); this.lastError = text; }
        });
        bot.on('message', (_ctx, msg) => this.receive(msg, { bot, live, signal: controller.signal, appId: credentials.appId }));
        await bot.start(controller.signal);
        if (live()) this.fail('QQ 连接已经结束，请点击「重试连接」。', controller);
      } catch (error) {
        if (live()) this.fail(error?.code === 'ERR_MODULE_NOT_FOUND' ? 'QQ 依赖缺失，请在项目目录运行 npm ci --ignore-scripts 后重启。' : qqError(error), controller);
      } finally { if (!live()) bot?.stop(); }
    })();
  }
  async stop() {
    const generation = ++this.generation;
    this.clearWait(); this.state = 'stopping'; this.controller?.abort(); this.bot?.stop(); this.bot = null;
    // An SDK token-response body may remain pending despite abort. It has no
    // live callbacks after stop; only our message queue needs draining for SQLite.
    await Promise.allSettled([this.queue]);
    if (generation === this.generation) { this.state = 'stopped'; this.lastError = ''; this.contacts.clear(); this.report('QQ 已断开。'); }
  }
  receive(msg, context) {
    if (!context.live() || !['c2c', 'group'].includes(msg?.kind) || !idOK(msg.senderId) ||
        typeof msg.messageId !== 'string' || !msg.messageId || msg.messageId.length > 512) return;
    if (msg.kind === 'group' && (!idOK(msg.groupOpenid) || msg.rawEventType !== 'GROUP_AT_MESSAGE_CREATE')) return;
    const targetId = msg.kind === 'group' ? msg.groupOpenid : msg.senderId;
    // Derive targets from validated identity; never accept an arbitrary replyTarget.
    const target = { scope: msg.kind === 'group' ? 'group' : 'c2c', targetId, msgId: msg.messageId };
    const contactKey = `${msg.kind}:${targetId}`;
    this.contacts.delete(contactKey);
    this.contacts.set(contactKey, { kind: msg.kind, id: targetId, allowed: this.allowed(msg), at: Date.now() });
    if (this.contacts.size > 20) this.contacts.delete(this.contacts.keys().next().value);
    if (!this.allowed(msg)) return;
    if (this.pending >= 20) { this.lastError = 'QQ 等待回复的消息较多，请稍后再发。'; return; }
    const id = digest([context.appId, msg.kind, targetId, msg.messageId]);
    // Persist before work begins: redelivery/restart cannot send the same reply
    // twice. An ambiguous send is never retried automatically.
    const claim = this.store.db.prepare("INSERT OR IGNORE INTO qq_deliveries VALUES (?, 'pending', ?)").run(id, Date.now());
    if (!claim.changes) return;
    this.store.db.exec('DELETE FROM qq_deliveries WHERE rowid NOT IN (SELECT rowid FROM qq_deliveries ORDER BY rowid DESC LIMIT 10000)');
    this.pending++;
    const task = this.queue.then(async () => {
      if (!context.live() || !this.allowed(msg)) return;
      let text = typeof msg.content === 'string' ? msg.content.replace(/<@!?\d+>/g, '').trim() : '';
      let reply;
      if (!text && msg.attachments?.length) reply = 'QQ 通道目前支持文字。图片和语音可以在网页或微信里发给我。';
      else if (!text) reply = '我在呢。可以和我聊天，或发 /宠物 看看互动菜单。';
      else if (text.length > 8000) reply = '这条消息有点长，请缩短到 8000 字符以内再发给我。';
      else {
        try {
          const scope = qqScope(context.appId, msg);
          reply = await this.core.chat({ scope, text, requestId: id,
            label: `QQ · ${msg.kind === 'group' ? '群聊成员' : '私聊'} · ${scope.slice(-6)}` }, context.signal);
        } catch (error) {
          if (!context.live()) return;
          reply = error instanceof BridgeError ? error.message : '刚刚没能接住这条消息，请稍后再试。';
        }
      }
      if (!context.live() || !this.allowed(msg)) return;
      const chars = Array.from(reply);
      if (chars.length > 4000) reply = chars.slice(0, 3950).join('') + '\n（回复较长，已截短；可继续问我具体部分。）';
      this.store.db.prepare("UPDATE qq_deliveries SET status='sending' WHERE id=?").run(id);
      await context.bot.sendText(target, reply);
      this.store.db.prepare("UPDATE qq_deliveries SET status='sent' WHERE id=?").run(id);
      if (context.live()) this.lastError = '';
    }).catch(error => {
      if (context.live()) this.lastError = qqError(error);
      this.store.db.prepare("UPDATE qq_deliveries SET status='failed' WHERE id=?").run(id);
    }).finally(() => { this.pending--; });
    this.queue = task;
    return task;
  }
}
