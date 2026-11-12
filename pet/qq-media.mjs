import { BridgeError } from '../lib.mjs';
import { fetchBytes, imageType } from '../media.mjs';

const maxBytes = 8 * 1024 * 1024;
const noImage = '我收到了表情标记，但 QQ 没有提供可读取的图片。请把表情保存到相册，再通过 QQ 的「图片」按钮发送，我就能尝试看图了。';

export function qqImageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\\\u0000-\u001f]/.test(value)) throw new BridgeError('QQ 图片下载地址无效，请重新发送图片。');
  let url;
  try { url = new URL(value.startsWith('//') ? `https:${value}` : /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`); }
  catch { throw new BridgeError('QQ 图片下载地址无效，请重新发送图片。'); }
  const trusted = /^(?:[a-z\d-]+\.)*qpic\.cn$/.test(url.hostname) ||
    ['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'qqbot.ugcimg.cn'].includes(url.hostname);
  if (!trusted || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new BridgeError('QQ 图片来源暂不支持，请保存到相册后作为普通图片重新发送。');
  }
  // QQ may omit the scheme or supply HTTP CDN URLs. Never download in cleartext.
  url.protocol = 'https:';
  return url;
}

export function qqText(value) {
  const raw = typeof value === 'string' ? value : '';
  if (raw.length > 32768) throw new BridgeError('QQ 消息内容过长，请缩短文字或单独发送图片。');
  const faces = [];
  const withoutMentions = raw.replace(/<@!?\d+>/g, '');
  // Known official formats: [<face,id=14/>] and <faceType=...,faceId="...",ext="base64">.
  // Only a bounded text label is decoded; never fetch URLs embedded in ext/text.
  const tags = /\[<face,id=\d+\/?>\]|\[?<faceType=[^>\r\n]*>\]?/gi;
  const plain = withoutMentions.replace(tags, '').trim();
  const text = withoutMentions.replace(tags, tag => {
    let name = '';
    const ext = tag.match(/\bext="([A-Za-z\d+/_=-]{1,8192})"/i)?.[1];
    if (ext) {
      try {
        const parsed = JSON.parse(Buffer.from(ext, 'base64').toString('utf8'));
        if (typeof parsed?.text === 'string') name = Array.from(parsed.text.replace(/[\u0000-\u001f\u007f<>【】「」]/g, '').trim()).slice(0, 80).join('');
      } catch {}
    }
    faces.push(name);
    return name ? `【QQ 表情名称：${name}】` : '【QQ 表情，未提供名称】';
  }).trim();
  if (text.length > 8000) throw new BridgeError('这条消息有点长，请缩短到 8000 字符以内再发给我。');
  return { text, plain, faces };
}

export function isQQImage(attachment) {
  if (!attachment || typeof attachment !== 'object') return false;
  const type = typeof attachment.content_type === 'string' ? attachment.content_type.split(';')[0].trim().toLowerCase() : '';
  if (type === 'image' || type.startsWith('image/')) return true;
  // Some official events label picture files as generic files. The actual bytes
  // are still checked after downloading; a filename is only a candidate hint.
  return ['', 'file', 'application/octet-stream'].includes(type) && typeof attachment.filename === 'string' && /\.(?:jpe?g|png|gif|webp)$/i.test(attachment.filename);
}

export async function prepareQQMessage(message, { config, signal, fetcher = fetch }) {
  signal?.throwIfAborted();
  const parsed = qqText(message.content);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length > 10) return { reply: '这条消息包含太多附件，请每次发一张图片。' };
  const pictures = attachments.filter(isQQImage);
  if (pictures.length > 1) return { reply: '这条消息有多张图片，QQ 通道目前每次看一张。请分开发送，我会分别看。' };
  if (pictures.length) {
    if (!config.model.supportsImages && !config.vision.enabled) return { reply: '收到图片了，但当前模型未启用图片能力。请在宠物设置中使用支持图片的聊天模型并勾选图片能力，或启用独立图片模型。' };
    if (Number(pictures[0].size) > maxBytes) return { reply: 'QQ 图片超过 8 MiB，请压缩后重新发送。' };
    const url = qqImageUrl(pictures[0].url);
    // No QQ/model credentials, cookies, or redirects on media requests. Signed
    // URLs stay here; only image bytes reach the model and per-person history.
    let bytes;
    try { ({ bytes } = await fetchBytes(url, { maxBytes, timeoutMs: 20000, signal }, fetcher)); }
    catch (error) {
      if (['http-401', 'http-403', 'http-404'].includes(error.code)) throw new BridgeError(`QQ 图片下载失败或链接已过期，请保存到相册后重新发送（HTTP ${error.code.slice(5)}）。`);
      throw error;
    }
    signal?.throwIfAborted();
    if (!bytes.length) throw new BridgeError('QQ 图片为空，请保存到相册后重新发送。');
    const mediaType = imageType(bytes);
    const text = parsed.text || '看看这张图片或表情包，结合画面和文字自然地回应我；看不清的地方请直说。';
    return { text, attachment: { data: bytes.toString('base64'), mediaType },
      note: attachments.length > 1 ? '（本条只读取了图片，附带的语音、视频或其他文件未读取。）' : '' };
  }
  if (attachments.length) return { reply: 'QQ 通道目前可读取文字和图片，这条附件暂不支持。表情包请保存到相册后通过「图片」发送；语音可先转成文字。' };
  if (parsed.faces.length && !parsed.plain) {
    const names = [...new Set(parsed.faces.filter(Boolean))].slice(0, 3);
    return { reply: names.length ? `收到表情「${names.join('、')}」啦。QQ 只提供了表情名称，没有原图；想让我看懂画面，请保存到相册后通过「图片」发送。` : noImage };
  }
  if (!parsed.text) return { reply: '我在呢。可以和我聊天，或发 /宠物 看看互动菜单。' };
  return { text: parsed.faces.length ? `${parsed.text}\n（本条 QQ 表情仅提供了上面的文字标记，没有可读取的表情图片。）` : parsed.text };
}
