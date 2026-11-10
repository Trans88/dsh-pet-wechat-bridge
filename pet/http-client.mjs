import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BridgeError, readJSONFile, requestJSON, localOrigin } from '../lib.mjs';
import { fetchBytes } from '../media.mjs';

export function wechatScope(account) {
  return 'wechat:' + createHash('sha256').update(JSON.stringify([account.botId, account.userId])).digest('hex');
}

export class LocalPet {
  constructor(root) { this.root = root; this.scope = 'web:owner'; }
  runtime() {
    const value = readJSONFile(join(this.root, 'data', 'pet-runtime.json'), null);
    if (!value || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new BridgeError('独立宠物尚未启动，请先运行 npm start 或 start.cmd。');
    return { origin: localOrigin(value.url), token: value.token };
  }
  async call(path, body, signal, binary = false) {
    const { origin, token } = this.runtime();
    const options = { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 240000, signal };
    const localFetch = async (url, options) => {
      const response = await fetch(url, options);
      if (!response.ok) {
        const data = await requestJSON(url, {}, async () => new Response(response.body, { headers: response.headers }));
        const error = new BridgeError(typeof data.error === 'string' ? data.error.slice(0, 500) : '独立宠物请求失败。', `http-${response.status}`);
        error.userMessage = error.message;
        throw error;
      }
      return response;
    };
    if (binary) return (await fetchBytes(`${origin}${path}`, { ...options, maxBytes: 8 * 1024 * 1024 }, localFetch)).bytes;
    const result = await requestJSON(`${origin}${path}`, options, localFetch);
    return result;
  }
  async check() {
    const result = await this.call('/api/state');
    return { id: 'standalone', name: result.config.pet.name, replyAudio: result.config.replyAudio };
  }
  async chat(text, signal, attachment, requestId) { return (await this.call('/api/chat', { text, attachment, scope: this.scope, requestId, label: '微信 · 私聊' }, signal)).text; }
  async hear(bytes, signal) { return (await this.call('/api/stt', { audio: bytes.toString('base64'), mediaType: 'audio/wav' }, signal)).text; }
  async speak(text, signal) { return this.call('/api/tts', { text }, signal, true); }
}
