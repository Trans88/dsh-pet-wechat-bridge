import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const QR_BASE = 'https://ilinkai.weixin.qq.com/';
// Protocol snapshot: Tencent/openclaw-weixin 3.0.0-beta-0, 2026-11-10.
export const BASE_INFO = {
  channel_version: '3.0.0-beta-0/dsh-pet-bridge-0.2.0',
  bot_agent: 'DshPetBridge/0.2.0',
};

export class BridgeError extends Error {
  constructor(message, code = 'bridge-error', options) { super(message, options); this.code = code; }
}

export function localOrigin(value) {
  let u;
  try { u = new URL(value); } catch { throw new BridgeError('config.json 的 dshUrl 不是有效地址。'); }
  if (!['http:', 'https:'].includes(u.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
      u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    throw new BridgeError('dshUrl 只允许本机地址，例如 http://127.0.0.1:3080。');
  }
  return u.origin;
}

export function weixinOrigin(value) {
  let u;
  try { u = new URL(value); } catch { throw new BridgeError('微信返回了无效的 API 地址。'); }
  const host = u.hostname.toLowerCase();
  const trusted = ['weixin.qq.com', 'wechat.com'].some(d => host === d || host.endsWith(`.${d}`));
  if (u.protocol !== 'https:' || !trusted || u.port || u.username || u.password ||
      u.search || u.hash || u.pathname !== '/') {
    throw new BridgeError('微信 API 地址未通过校验，已停止。');
  }
  return `${u.origin}/`;
}

// JSON reviver source preserves uint64 message IDs on Node 22.13+.
export function parseJSON(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source) throw new BridgeError('Node.js 版本过旧，无法安全读取微信消息 ID。');
      return context.source;
    }
    return value;
  });
}

export async function requestJSON(url, options = {}, fetcher = fetch) {
  const { timeoutMs = 15000, signal, ...rest } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetcher(url, { ...rest, redirect: 'error', signal: combined });
    if (!response.ok) throw new BridgeError(`接口返回 HTTP ${response.status}。`, `http-${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) throw new BridgeError('接口响应过大，已停止读取。');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return parseJSON(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (combined.aborted) throw new BridgeError('请求超时或已停止。', 'aborted', { cause: error });
    throw new BridgeError('网络连接失败，或接口未返回有效 JSON。', 'network', { cause: error });
  }
}

export function checkBusiness(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BridgeError('接口响应格式错误。');
  for (const field of ['ret', 'errcode']) {
    if (data[field] !== undefined && Number(data[field]) !== 0) {
      const code = Number(data[field]);
      throw new BridgeError(code === -14 ? '微信凭证失效（-14），请重新登录。' : `微信接口业务错误（${Number.isFinite(code) ? code : 'unknown'}）。`, code === -14 ? 'auth-expired' : 'business');
    }
  }
  return data;
}

export function safeReason(reason) {
  return typeof reason === 'string' && /^[a-z0-9-]{1,64}$/.test(reason) ? reason : 'unknown';
}

export class Weixin {
  constructor(account = {}, fetcher = fetch) { this.account = account; this.fetcher = fetcher; }
  async call(path, body, { base = this.account.baseUrl || QR_BASE, auth = true, timeoutMs = 15000, signal } = {}) {
    const url = new URL(path, weixinOrigin(base));
    // Also reject absolute/off-domain paths before attaching a token.
    if (url.origin !== new URL(base).origin) throw new BridgeError('不允许跨主机发送请求。');
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(3 << 16) };
    const options = { method: body === undefined ? 'GET' : 'POST', headers, timeoutMs, signal };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
      options.body = JSON.stringify(auth ? { ...body, base_info: BASE_INFO } : body);
    }
    if (auth) {
      if (!this.account.token) throw new BridgeError('缺少微信登录凭证。');
      headers.Authorization = `Bearer ${this.account.token}`;
    }
    return checkBusiness(await requestJSON(url, options, this.fetcher));
  }
  async updates(cursor, signal) {
    try { return await this.call('ilink/bot/getupdates', { get_updates_buf: cursor }, { timeoutMs: 35000, signal }); }
    catch (e) { if (e.code === 'aborted') return { msgs: [], get_updates_buf: cursor }; throw e; }
  }
  send(to, context, text, clientId, signal) {
    return this.sendItem(to, context, { type: 1, text_item: { text } }, clientId, signal);
  }
  sendItem(to, context, item, clientId, signal) {
    return this.call('ilink/bot/sendmessage', { msg: {
      from_user_id: '', to_user_id: to, client_id: clientId,
      message_type: 2, message_state: 2, context_token: context,
      item_list: [item],
    } }, { signal });
  }
}

export class Pet {
  constructor(config, fetcher = fetch) {
    this.base = `${localOrigin(config.dshUrl)}/dsh-pet-7340/`;
    this.id = config.petId || '';
    this.timeout = Number(config.petTimeoutMs ?? 180000);
    if (!Number.isInteger(this.timeout) || this.timeout < 1000 || this.timeout > 600000) throw new BridgeError('petTimeoutMs 应在 1000 至 600000 之间。');
    this.fetcher = fetcher;
  }
  async check() {
    const config = await requestJSON(new URL('config', this.base), {}, this.fetcher);
    if (config?.ok === false) throw new BridgeError(`宠物配置读取失败：${safeReason(config.reason)}。`);
    const pets = Object.values(config || {}).flatMap(entry => Array.isArray(entry?.pets) ? entry.pets : []);
    const unique = [...new Map(pets.filter(p => typeof p.id === 'string' && p.id).map(p => [p.id, p])).values()];
    if (!unique.length) throw new BridgeError('未找到宠物，请确认 dsh-pet 已启用。');
    if (!this.id && unique.length === 1) this.id = unique[0].id;
    if (!unique.some(p => p.id === this.id)) {
      // IDs originate from user's own local config, not remote chat content.
      throw new BridgeError(`请在 config.json 的 petId 填入其中一个 ID：${unique.map(p => JSON.stringify(p.id)).join('、')}`);
    }
    return unique.find(p => p.id === this.id);
  }
  async chat(text, signal, attachment) {
    if (!text.trim() || text.length > 2000) throw new BridgeError('宠物单条输入需为 1–2000 个字符。');
    const url = new URL('chat', this.base);
    url.search = new URLSearchParams({ pet: this.id, surface: 'any' });
    const data = await requestJSON(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(attachment ? { attachment } : {}) }), timeoutMs: this.timeout, signal,
    }, this.fetcher);
    if (data?.ok !== true) throw new BridgeError(`宠物聊天失败：${safeReason(data?.reason)}。`, `pet-${safeReason(data?.reason)}`);
    return typeof data.text === 'string' && data.text.trim() ? data.text.trim() : '（宠物这次没有返回文字，可能只播放了动作。）';
  }
}

export function readJSONFile(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw new BridgeError(`文件无法读取或 JSON 损坏：${path}`); }
}

export function saveJSONFile(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

export function newState(account) {
  return { botId: account.botId, owner: account.userId, cursor: '', since: account.linkedAt, seen: [], queue: [] };
}

export function splitReply(text, limit = 1800) {
  let chars = [...text];
  if (chars.length > 6000) chars = [...chars.slice(0, 5900), ...'\n（回复较长，完整内容可在宠物聊天记录中查看。）'];
  const result = [];
  for (let i = 0; i < chars.length; i += limit) result.push(chars.slice(i, i + limit).join(''));
  return result;
}

export function acceptMessage(msg, account, since) {
  if (!msg || Number(msg.message_type) !== 1 || msg.from_user_id !== account.userId || msg.group_id || msg.delete_time_ms ||
      (msg.message_state != null && Number(msg.message_state) !== 2) ||
      (msg.to_user_id && msg.to_user_id !== account.botId)) return null;
  if (Number(msg.create_time_ms) > 0 && Number(msg.create_time_ms) < since - 30000) return null;
  if (typeof msg.context_token !== 'string' || !msg.context_token) return null;
  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  const text = items
    .filter(i => Number(i.type) === 1 && typeof i.text_item?.text === 'string')
    .map(i => i.text_item.text).join('\n').trim();
  const media = items.filter(i => (Number(i.type) === 2 && i.image_item) || (Number(i.type) === 3 && i.voice_item))
    .map(i => Number(i.type) === 2 ? { type: 2, image_item: i.image_item } : { type: 3, voice_item: i.voice_item });
  if (!text && !media.length) return null;
  const id = createHash('sha256').update(JSON.stringify([
    account.botId, msg.from_user_id, msg.message_id ?? msg.client_id ?? '',
    // Prefer protocol ID; fallback covers servers omitting both ID fields.
    msg.message_id != null || msg.client_id ? '' : [msg.create_time_ms, msg.seq, msg.context_token, text, media],
  ])).digest('hex');
  return { id, to: msg.from_user_id, context: msg.context_token, text, ...(media.length ? { media } : {}), status: 'queued', next: 0 };
}

export function enqueue(state, batch, account) {
  if (batch.msgs !== undefined && !Array.isArray(batch.msgs)) throw new BridgeError('微信消息列表格式错误。');
  const known = new Set([...state.seen, ...state.queue.map(q => q.id)]);
  const additions = [];
  for (const msg of batch.msgs || []) {
    const job = acceptMessage(msg, account, state.since);
    if (job && !known.has(job.id)) { additions.push(job); known.add(job.id); }
  }
  if (state.queue.length + additions.length > 100) throw new BridgeError('待处理消息超过 100 条，已停止；请检查是否绑定了正确账号。');
  state.queue.push(...additions);
  if (typeof batch.get_updates_buf === 'string' && batch.get_updates_buf) state.cursor = batch.get_updates_buf;
}

export function recoverUncertain(state) {
  let count = 0;
  for (const job of state.queue) {
    if (['generating', 'sending'].includes(job.status)) { job.status = 'failed'; count++; }
    // Preparing audio/uploads has not sent a chat message yet; resume safely.
    if (job.status === 'preparing') job.status = 'ready';
  }
  return count;
}

export async function processQueue(state, { pet, weixin, save, log = console.log, signal, respond, prepare }) {
  for (const job of state.queue) {
    if (signal?.aborted) break;
    if (job.status === 'queued') {
      job.status = 'generating'; save();
      let reply, extra = [];
      if (job.text.length > 2000) reply = '[桥接提示] 单条文字请控制在 2000 字符内，拆成几条后重新发送。';
      else {
        log(`收到一条微信${job.media?.length ? '图片/语音' : '文字'}消息，正在等待宠物回复……`);
        try {
          const result = respond ? await respond(job, signal) : await pet.chat(job.text, signal);
          if (typeof result === 'string') reply = result;
          else { reply = result.text; extra = result.extra || []; }
        }
        catch (e) {
          if (signal?.aborted) break;
          log(e.message);
          reply = e.userMessage ? `[桥接提示] ${e.userMessage}` : '[桥接提示] 这次未能取得宠物回复。请查看电脑上的桥接窗口，并确认宠物本地聊天能正常使用。';
        }
      }
      job.chunks = splitReply(reply).map(text => ({ text, clientId: `petbridge-${randomUUID()}` }));
      job.chunks.push(...extra.map(action => ({ action, clientId: `petbridge-${randomUUID()}` })));
      job.status = 'ready'; save();
    }
    if (job.status === 'ready') {
      while (job.next < job.chunks.length && !signal?.aborted) {
        const chunk = job.chunks[job.next];
        if (chunk.action && !chunk.item && chunk.text === undefined) {
          job.status = 'preparing'; save();
          try { chunk.item = await prepare(chunk.action, job, signal); }
          catch (e) {
            if (signal?.aborted) break;
            log(`附加媒体未生成：${e.message}`);
            if (e.code === 'auth-expired') throw e;
            chunk.text = `[桥接提示] 文字回复已发送，语音文件未能生成或上传。${e.userMessage || '请查看电脑桥接窗口的错误提示。'}`;
          }
          job.status = 'ready'; save();
        }
        if (signal?.aborted) break;
        job.status = 'sending'; save();
        try {
          if (chunk.item) await weixin.sendItem(job.to, job.context, chunk.item, chunk.clientId, signal);
          else await weixin.send(job.to, job.context, chunk.text, chunk.clientId, signal);
        }
        catch (e) {
          // A timed-out send may already have arrived. Do not blindly resend.
          job.status = 'failed'; save();
          log(`回复未确认送达，未自动重发：${e.message}`);
          if (e.code === 'auth-expired') throw e;
          break;
        }
        job.next++;
        job.status = job.next === job.chunks.length ? 'done' : 'ready';
        save();
      }
      if (job.status === 'done') log('宠物回复已发送。');
    }
  }
  const complete = state.queue.filter(j => ['done', 'failed'].includes(j.status));
  state.seen = [...new Set([...state.seen, ...complete.map(j => j.id)])].slice(-5000);
  state.queue = state.queue.filter(j => !['done', 'failed'].includes(j.status));
  save();
}
