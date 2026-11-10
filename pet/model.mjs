import { BridgeError, requestJSON } from '../lib.mjs';
import { fetchBytes } from '../media.mjs';
import { endpoint } from './config.mjs';

function headers(provider, json = true) {
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) };
}
function explain(error, kind) {
  if (error.code === 'http-401' || error.code === 'http-403') return new BridgeError(`${kind}服务拒绝访问，请检查 API Key 和账号权限。`, error.code);
  if (error.code === 'http-404') return new BridgeError(`${kind}接口不存在，请检查 Base URL 和模型名。`, error.code);
  if (error.code === 'http-429') return new BridgeError(`${kind}服务限流或余额不足，请稍后重试并检查服务商后台。`, error.code);
  if (error.code === 'http-400') return new BridgeError(`${kind}服务不接受当前参数，请检查模型名、图片能力或服务协议。`, error.code);
  return error instanceof BridgeError ? error : new BridgeError(`${kind}调用失败。`);
}

export class Models {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async complete(messages, withImages, signal) {
    const c = this.config.value;
    const kind = withImages && c.vision.enabled ? 'vision' : 'model';
    const provider = this.config.provider(kind);
    if (withImages && kind === 'model' && !c.model.supportsImages) throw new BridgeError('当前聊天模型未启用图片能力，请在设置中选择视觉模型或启用独立图片模型。');
    if (!provider.apiKey && new URL(provider.baseUrl).hostname === 'api.deepseek.com') throw new BridgeError('请先在设置中填写 DeepSeek API Key。');
    try {
      const response = await requestJSON(endpoint(provider.baseUrl, 'chat/completions'), {
        method: 'POST', headers: headers(provider),
        body: JSON.stringify({ model: provider.model, messages, stream: false, max_tokens: 2048 }),
        timeoutMs: 180000, signal,
      }, this.fetcher);
      const text = response?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new BridgeError('模型没有返回文字，请检查模型设置后重试。');
      return text.trim().slice(0, 16000);
    } catch (e) { throw explain(e, '聊天'); }
  }
  async transcribe(bytes, mediaType, signal) {
    const c = this.config.provider('stt');
    if (!c.enabled) throw new BridgeError('尚未配置语音识别服务，请在设置中启用 STT，或先转成文字发送。');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new BridgeError('录音为空或超过 8 MiB。');
    const ext = { 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' }[mediaType];
    if (!ext) throw new BridgeError('不支持这种录音格式。');
    const body = new FormData();
    body.append('model', c.model);
    body.append('file', new Blob([bytes], { type: mediaType }), `recording.${ext}`);
    body.append('response_format', 'json');
    try {
      const result = await requestJSON(endpoint(c.baseUrl, 'audio/transcriptions'), { method: 'POST', headers: headers(c, false), body, timeoutMs: 90000, signal }, this.fetcher);
      if (typeof result?.text !== 'string' || !result.text.trim()) throw new BridgeError('这段语音没有识别出文字。');
      return result.text.trim();
    } catch (e) { throw explain(e, '语音识别'); }
  }
  async speak(text, signal) {
    const c = this.config.provider('tts');
    if (!c.enabled) throw new BridgeError('尚未配置语音合成服务，请在设置中启用 TTS。');
    try {
      const { bytes, headers: responseHeaders } = await fetchBytes(endpoint(c.baseUrl, 'audio/speech'), {
        method: 'POST', headers: headers(c), body: JSON.stringify({ model: c.model, voice: c.voice, input: text.slice(0, 500), response_format: 'mp3' }),
        maxBytes: 8 * 1024 * 1024, timeoutMs: 90000, signal,
      }, this.fetcher);
      if (!bytes.length || !(responseHeaders.get('content-type') || '').includes('audio/mpeg')) throw new BridgeError('语音合成服务未返回 MP3 音频。');
      return bytes;
    } catch (e) { throw explain(e, '语音合成'); }
  }
}
