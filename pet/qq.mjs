import { createHash } from 'node:crypto';
import { BridgeError } from '../lib.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function qqScope(appId, message) {
  return `qq:${message.kind === 'group' ? 'group' : 'direct'}:${digest([appId, message.kind, message.groupOpenid || '', message.senderId])}`;
}
export function qqError(error) {
  if (error?.code === 'GATEWAY_FATAL_CLOSE') return 'QQ 平台拒绝连接，请检查机器人是否启用、沙箱范围、IP 白名单与接入方式。';
  if (error?.httpStatus === 401 || error?.httpStatus === 403) return 'QQ 凭据或权限校验失败，请检查 AppID、AppSecret 和开放平台权限。';
  if (error?.code === 'GATEWAY_RETRY_EXHAUSTED') return 'QQ 多次重连失败，请检查网络和平台配置后重新连接。';
  return 'QQ 连接或发送失败，请检查网络、机器人凭据、平台权限与消息额度。';
}
async function makeBot(options) {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  return new QQBot(options);
}

// The official SDK owns token refresh, heartbeat and reconnect. No public HTTP
// listener, account password, or dsh process is needed by this channel.
export class QQBridge {
  constructor({ config, store, core, factory = makeBot }) {
    Object.assign(this, { config, store, core, factory });
    this.state = 'stopped'; this.lastError = ''; this.generation = 0;
    this.contacts = new Map(); this.queue = Promise.resolve(); this.pending = 0;
    store.db.exec('CREATE TABLE IF NOT EXISTS qq_deliveries (id TEXT PRIMARY KEY, status TEXT NOT NULL, created INTEGER NOT NULL)');
  }
  status() { return { state: this.state, error: this.lastError, pending: this.pending, contacts: [...this.contacts.values()] }; }
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
    try {
      const bot = await this.factory({ ...credentials, transport: 'websocket', intents: 1 << 25, markdownSupport: false,
        baseUrl: this.config.value.qq.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com',
        reconnect: { maxAttempts: 10 }, userAgent: 'little-pet/0.6.0' });
      if (generation !== this.generation) { bot.stop(); return; }
      this.bot = bot;
      const live = () => generation === this.generation && !controller.signal.aborted;
      for (const event of ['ready', 'resumed']) bot.on(event, () => { if (live()) { this.state = 'connected'; this.lastError = ''; } });
      bot.on('disconnected', info => { if (live()) this.state = info.willReconnect ? 'reconnecting' : 'error'; });
      bot.on('error', error => { if (live()) this.lastError = qqError(error); });
      bot.on('message', (_ctx, msg) => this.receive(msg, { bot, live, signal: controller.signal, appId: credentials.appId }));
      // start() runs until stopped. Do not block the local settings request on it.
      this.run = Promise.resolve().then(() => live() && bot.start(controller.signal)).catch(error => {
        if (live()) { this.state = 'error'; this.lastError = qqError(error); controller.abort(); }
      }).finally(() => { if (generation === this.generation && this.state !== 'error') this.state = 'stopped'; });
    } catch (error) {
      if (generation === this.generation) { this.state = 'error'; this.lastError = qqError(error); controller.abort(); }
      throw new BridgeError('QQ 初始化失败，请重新运行 npm install 后重试。');
    }
  }
  async stop() {
    ++this.generation;
    this.state = 'stopped'; this.controller?.abort(); this.bot?.stop();
    await Promise.allSettled([this.run, this.queue]);
    this.bot = null; this.lastError = ''; this.contacts.clear();
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
