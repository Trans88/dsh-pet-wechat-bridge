import { createDecipheriv, createCipheriv, createHash, randomBytes } from 'node:crypto';
import { BridgeError, requestJSON, safeReason, weixinOrigin } from './lib.mjs';

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const IMAGE_MAX = 8 * 1024 * 1024;
const VOICE_MAX = 2 * 1024 * 1024;

function mediaError(message, code = 'media-error') {
  const error = new BridgeError(message, code);
  error.userMessage = message;
  return error;
}

export function trustedCdnUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw mediaError('微信媒体地址无效，请重新发送。'); }
  // Reuse the credential-domain allowlist, without accepting credentials,
  // non-HTTPS transport, unusual ports, or automatic redirects.
  if (url.username || url.password || url.hash) throw mediaError('微信媒体地址未通过校验。');
  weixinOrigin(url.origin);
  return url;
}

export function parseMediaKey(value, hexOverride) {
  if (hexOverride !== undefined) {
    if (typeof hexOverride !== 'string' || !/^[a-f\d]{32}$/i.test(hexOverride)) throw mediaError('微信图片解密信息无效，请重新发送。');
    return Buffer.from(hexOverride, 'hex');
  }
  if (typeof value !== 'string') throw mediaError('微信媒体缺少解密信息，请重新发送。');
  const raw = Buffer.from(value, 'base64');
  if (raw.length === 16) return raw;
  if (raw.length === 32 && /^[a-f\d]{32}$/i.test(raw.toString('ascii'))) return Buffer.from(raw.toString('ascii'), 'hex');
  throw mediaError('微信媒体解密信息无效，请重新发送。');
}

export async function fetchBytes(url, options = {}, fetcher = fetch) {
  const { maxBytes = IMAGE_MAX + 32, timeoutMs = 45000, signal, ...rest } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetcher(url, { ...rest, redirect: 'error', signal: combined });
    if (!response.ok) throw mediaError(`媒体接口返回 HTTP ${response.status}。`, `http-${response.status}`);
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw mediaError('媒体文件太大，请压缩图片或缩短语音后再发送。');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw mediaError('媒体文件太大，请压缩图片或缩短语音后再发送。');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { bytes: Buffer.concat(chunks), headers: response.headers };
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    if (combined.aborted) throw mediaError('媒体处理超时或已停止，请稍后重新发送。', 'aborted');
    throw mediaError('媒体网络请求失败，请稍后重新发送。', 'network');
  }
}

export async function downloadMedia(item, type, signal, fetcher = fetch) {
  const media = item?.media;
  if (!media || (!media.full_url && !media.encrypt_query_param)) throw mediaError('微信消息缺少媒体下载地址，请重新发送。');
  const value = media.full_url || `${CDN}/download?${new URLSearchParams({ encrypted_query_param: media.encrypt_query_param })}`;
  const url = trustedCdnUrl(value);
  const key = item.aeskey || media.aes_key ? parseMediaKey(media.aes_key, item.aeskey || undefined) : null;
  if (!key && type === 'voice') throw mediaError('微信语音缺少解密信息，请重新发送。');
  const max = type === 'voice' ? VOICE_MAX : IMAGE_MAX;
  const { bytes } = await fetchBytes(url, { maxBytes: max + 32, signal }, fetcher);
  let plain = bytes;
  if (key) {
    try {
      const cipher = createDecipheriv('aes-128-ecb', key, null);
      plain = Buffer.concat([cipher.update(bytes), cipher.final()]);
    } catch { throw mediaError('微信媒体解密失败，请重新发送。'); }
  }
  if (!plain.length || plain.length > max) throw mediaError('媒体为空或超过大小限制，请重新发送。');
  return plain;
}

export function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw mediaError('暂不支持这种图片格式，请发送 JPG、PNG、GIF 或 WebP 图片。');
}

export async function normalizeImage(bytes) {
  const type = imageType(bytes);
  // pet v0.4.7 caps the full JSON request at 1 MiB, including base64.
  const limit = 700 * 1024;
  if (bytes.length <= limit) return { mediaType: type, data: bytes.toString('base64') };
  if (!['image/png', 'image/jpeg'].includes(type)) throw mediaError('这张 GIF/WebP 超过 700 KiB，请转成普通 JPG 后发送。');
  const { default: jpeg } = await import('jpeg-js');
  let decoded;
  try {
    if (type === 'image/png') {
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width * height > 24000000) throw new Error('image dimensions');
      const { PNG } = await import('pngjs');
      decoded = PNG.sync.read(bytes);
    } else decoded = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 24, maxMemoryUsageInMB: 256 });
  } catch { throw mediaError('图片无法解码或分辨率太大，请用微信普通画质重新发送。'); }
  for (const side of [1600, 1200, 900, 640]) {
    const ratio = Math.min(1, side / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * ratio));
    const height = Math.max(1, Math.round(decoded.height * ratio));
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = Math.min(decoded.width - 1, (x + 0.5) * decoded.width / width - 0.5);
      const sy = Math.min(decoded.height - 1, (y + 0.5) * decoded.height / height - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(decoded.width - 1, x0 + 1), y1 = Math.min(decoded.height - 1, y0 + 1);
      const fx = Math.max(0, sx - x0), fy = Math.max(0, sy - y0);
      const index = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        data[index + c] = Math.round(
          decoded.data[(y0 * decoded.width + x0) * 4 + c] * (1 - fx) * (1 - fy) +
          decoded.data[(y0 * decoded.width + x1) * 4 + c] * fx * (1 - fy) +
          decoded.data[(y1 * decoded.width + x0) * 4 + c] * (1 - fx) * fy +
          decoded.data[(y1 * decoded.width + x1) * 4 + c] * fx * fy);
      }
      // JPEG has no alpha. Composite on white to preserve transparent screenshots.
      const alpha = data[index + 3] / 255;
      for (let c = 0; c < 3; c++) data[index + c] = Math.round(data[index + c] * alpha + 255 * (1 - alpha));
      data[index + 3] = 255;
    }
    const compressed = jpeg.encode({ data, width, height }, 80).data;
    if (compressed.length <= limit) return { mediaType: 'image/jpeg', data: compressed.toString('base64') };
  }
  throw mediaError('图片压缩后仍然太大，请裁剪重点区域后重新发送。');
}

export function makeWav(pcm, rate = 16000) {
  if (pcm.length % 2) throw mediaError('语音 PCM 数据长度无效。');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

export async function voiceToPcm(bytes, voice) {
  const silk = await import('silk-wasm');
  if (silk.isSilk(bytes)) {
    const duration = silk.getDuration(bytes);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 65000) throw mediaError('请发送不超过 60 秒的微信语音。');
    try {
      // SILK decoder can produce 16 kHz directly for the pet STT endpoint.
      const result = await silk.decode(bytes, 16000);
      const pcm = Buffer.from(result.data);
      if (!pcm.length || pcm.length > 65 * 32000) throw new Error('invalid duration');
      return pcm;
    } catch { throw mediaError('微信语音解码失败，请重新录制后发送。'); }
  }
  if (Number(voice.encode_type) === 1 && Number(voice.sample_rate) === 16000 && Number(voice.bits_per_sample) === 16 && bytes.length % 2 === 0) return bytes;
  throw mediaError('暂不支持这段语音的编码。请使用微信“按住说话”发送语音，或先转成文字。');
}

export async function recognizeVoice(pet, voice, signal, fetcher = fetch) {
  if (typeof voice.text === 'string' && voice.text.trim()) return voice.text.trim();
  const bytes = await downloadMedia(voice, 'voice', signal, fetcher);
  const pcm = await voiceToPcm(bytes, voice);
  if (pcm.length > 65 * 32000) throw mediaError('请发送不超过 60 秒的微信语音。');
  const texts = [];
  // Each 20-second slice is below pet's 768 KiB WAV body limit.
  for (let at = 0; at < pcm.length; at += 20 * 32000) {
    const result = await requestJSON(new URL('voice/hear', pet.base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: makeWav(pcm.subarray(at, at + 20 * 32000)).toString('base64'), language: 'zh' }),
      timeoutMs: 45000, signal,
    }, pet.fetcher);
    if (result?.ok !== true) {
      const reason = safeReason(result?.reason);
      throw mediaError(reason === 'unsupported'
        ? '这段语音没有微信转写文字，dsh 也未启用语音识别服务。请先启用 dsh 的语音输入插件，或在微信转成文字后发送。'
        : `宠物语音识别失败（${reason}），请尝试更短的语音。`);
    }
    if (typeof result.text === 'string' && result.text.trim()) texts.push(result.text.trim());
  }
  if (!texts.length) throw mediaError('这段语音没有识别出文字，请靠近麦克风重新发送。');
  return texts.join(' ');
}

export function shortSpeech(text) {
  let clipped = '';
  for (const char of text.trim()) { if (clipped.length + char.length > 500) break; clipped += char; }
  return clipped;
}

export async function synthesize(pet, text, signal) {
  const { bytes, headers } = await fetchBytes(new URL('voice/speak', pet.base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: shortSpeech(text) }), timeoutMs: 90000, maxBytes: 8 * 1024 * 1024, signal,
  }, pet.fetcher);
  if ((headers.get('content-type') || '').includes('json')) {
    let data; try { data = JSON.parse(bytes); } catch {}
    throw mediaError(`宠物语音合成失败（${safeReason(data?.reason)}），请先确认 pet 本地朗读可用。`);
  }
  if (!(headers.get('content-type') || '').includes('audio/mpeg') || !bytes.length) throw mediaError('宠物语音接口未返回 MP3。');
  return bytes;
}

export async function uploadAudioFile(api, bytes, to, signal, fetcher = fetch) {
  const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const response = await api.call('ilink/bot/getuploadurl', {
    filekey, media_type: 3, to_user_id: to, rawsize: bytes.length,
    rawfilemd5: createHash('md5').update(bytes).digest('hex'), filesize: encrypted.length,
    no_need_thumb: true, aeskey: key.toString('hex'),
  }, { signal });
  if (!response.upload_full_url && !response.upload_param) throw mediaError('微信没有返回音频上传地址。');
  const url = trustedCdnUrl(response.upload_full_url || `${CDN}/upload?${new URLSearchParams({ encrypted_query_param: response.upload_param, filekey })}`);
  const { headers } = await fetchBytes(url, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    body: encrypted, maxBytes: 65536, signal,
  }, fetcher);
  const param = headers.get('x-encrypted-param');
  if (!param) throw mediaError('微信媒体上传响应缺少下载参数。');
  return { type: 4, file_item: {
    media: { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 },
    file_name: 'pet-reply.mp3', len: String(bytes.length),
  } };
}

export class MediaFlow {
  constructor(pet, api, config = {}, fetcher = fetch) {
    this.pet = pet; this.api = api; this.fetcher = fetcher;
    this.replyAudio = config.replyAudio ?? 'voice';
    if (!['voice', 'always', 'off'].includes(this.replyAudio)) throw new BridgeError('replyAudio 只能为 voice、always 或 off。');
  }
  async respond(job, signal) {
    const images = (job.media || []).filter(i => i.type === 2);
    const voices = (job.media || []).filter(i => i.type === 3);
    if (images.length > 1 || voices.length > 1) throw mediaError('一次消息请只发一张图片或一段语音，多张图片请分开发送。');
    const parts = [job.text];
    for (const item of voices) parts.push(await recognizeVoice(this.pet, item.voice_item, signal, this.fetcher));
    let attachment;
    if (images.length) {
      const bytes = await downloadMedia(images[0].image_item, 'image', signal, this.fetcher);
      attachment = await normalizeImage(bytes);
    }
    const text = parts.filter(Boolean).join('\n').trim() || (attachment ? '请看看这张图片，告诉我你看到了什么。' : '');
    if (!text || text.length > 2000) throw mediaError('识别后的消息为空或超过 2000 字符，请缩短后重新发送。');
    let reply;
    try { reply = await this.pet.chat(text, signal, attachment); }
    catch (e) {
      if (attachment && e.code?.startsWith('pet-')) {
        throw mediaError(`宠物看图失败（${e.code.slice(4)}）。请确认宠物聊天模型支持图片，且 dsh 模型设置已启用 Image；也可先试一张较小的 JPG。`);
      }
      throw e;
    }
    const wantsAudio = this.replyAudio === 'always' || (this.replyAudio === 'voice' && voices.length > 0);
    return {
      text: reply + (wantsAudio && reply.length > 500 ? '\n\n（语音仅朗读前 500 字符，完整回复见以上文字。）' : ''),
      extra: wantsAudio ? [{ kind: 'audio', text: shortSpeech(reply) }] : [],
    };
  }
  async prepare(action, job, signal) {
    if (action.kind !== 'audio') throw new BridgeError('未知媒体动作。');
    return uploadAudioFile(this.api, await synthesize(this.pet, action.text, signal), job.to, signal, this.fetcher);
  }
}
