import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError, readJSONFile, saveJSONFile } from '../lib.mjs';

export const defaults = {
  version: 1,
  port: 3210,
  pet: { name: '小蓝', appearance: 'taolinghu', persona: '你是一只名叫小蓝的 AI 宠物，温柔、有好奇心，偶尔俏皮。用自然简洁的中文陪伴主人。保持自己的判断，不编造经历或能力。', greeting: '我在这里。今天想和我聊点什么？' },
  model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '', supportsImages: true },
  vision: { enabled: false, baseUrl: '', model: '', apiKey: '' },
  stt: { enabled: false, baseUrl: '', model: '', apiKey: '' },
  tts: { enabled: false, baseUrl: '', model: '', apiKey: '', voice: 'alloy' },
  replyAudio: 'voice',
  qq: { appId: '', appSecret: '', autoConnect: false, sandbox: false, directMode: 'allowlist', allowedUsers: [], groupMode: 'disabled', allowedGroups: [] },
};

export function endpoint(base, path) {
  let url;
  try { url = new URL(base); } catch { throw new BridgeError('模型服务地址无效，请填写完整的 API Base URL。'); }
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new BridgeError('API 地址须使用 HTTPS；本机模型允许 HTTP。地址中不能包含密码或查询参数。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/' + path;
  return url;
}

function string(value, max, label, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new BridgeError(`${label}格式不正确。`);
  return value.trim();
}

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('宠物配置必须是对象。');
  const c = structuredClone(defaults);
  c.port = value.port ?? defaults.port;
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw new BridgeError('端口应为 1024–65535 的整数。');
  for (const key of ['name', 'persona', 'greeting']) c.pet[key] = string(value.pet?.[key] ?? c.pet[key], key === 'persona' ? 8000 : 200, `宠物${key}`);
  c.pet.appearance = value.pet?.appearance ?? c.pet.appearance;
  if (!['taolinghu', 'blue-cat'].includes(c.pet.appearance)) throw new BridgeError('请选择内置的宠物形象。');
  for (const kind of ['model', 'vision', 'stt', 'tts']) {
    const incoming = value[kind] || {};
    if (typeof incoming !== 'object' || Array.isArray(incoming)) throw new BridgeError(`${kind}配置格式错误。`);
    for (const key of ['baseUrl', 'model', 'apiKey']) c[kind][key] = string(incoming[key] ?? c[kind][key], key === 'apiKey' ? 4096 : 500, `${kind}.${key}`, kind !== 'model' || key === 'apiKey');
    if (kind !== 'model') {
      c[kind].enabled = incoming.enabled ?? c[kind].enabled;
      if (typeof c[kind].enabled !== 'boolean') throw new BridgeError(`${kind}.enabled 应为布尔值。`);
    }
    if (c[kind].baseUrl) endpoint(c[kind].baseUrl, '');
    if (c[kind].enabled && (!c[kind].baseUrl || !c[kind].model)) throw new BridgeError(`启用 ${kind} 前需要填写服务地址和模型名。`);
  }
  c.model.supportsImages = value.model?.supportsImages ?? c.model.supportsImages;
  if (typeof c.model.supportsImages !== 'boolean') throw new BridgeError('图片能力应为布尔值。');
  c.tts.voice = string(value.tts?.voice ?? c.tts.voice, 200, '音色');
  c.replyAudio = value.replyAudio ?? c.replyAudio;
  if (!['voice', 'always', 'off'].includes(c.replyAudio)) throw new BridgeError('语音回复模式错误。');
  if (value.qq !== undefined && (!value.qq || typeof value.qq !== 'object' || Array.isArray(value.qq))) throw new BridgeError('QQ 配置格式错误。');
  const qq = value.qq || {};
  for (const key of Object.keys(c.qq)) if (qq[key] !== undefined) c.qq[key] = qq[key];
  c.qq.appId = string(c.qq.appId, 100, 'QQ AppID', true);
  if (c.qq.appId && !/^\d{1,30}$/.test(c.qq.appId)) throw new BridgeError('QQ AppID 应为开放平台提供的数字标识。');
  c.qq.appSecret = string(c.qq.appSecret, 4096, 'QQ AppSecret', true);
  for (const key of ['autoConnect', 'sandbox']) if (typeof c.qq[key] !== 'boolean') throw new BridgeError('QQ 开关应为布尔值。');
  for (const key of ['directMode', 'groupMode']) if (!['disabled', 'allowlist', 'open'].includes(c.qq[key])) throw new BridgeError('QQ 访问范围错误。');
  for (const key of ['allowedUsers', 'allowedGroups']) {
    if (!Array.isArray(c.qq[key]) || c.qq[key].length > 100 || c.qq[key].some(v => typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v))) throw new BridgeError('QQ 名单需填写 OpenID，每行一个，最多 100 个。');
    c.qq[key] = [...new Set(c.qq[key])];
  }
  return c;
}

export class Config {
  constructor(root) {
    this.path = join(root, 'pet.config.json');
    this.value = validateConfig(existsSync(this.path) ? readJSONFile(this.path) : defaults);
    if (!existsSync(this.path)) saveJSONFile(this.path, this.value);
  }
  provider(kind) {
    const c = { ...this.value[kind] };
    const env = kind === 'model' ? 'PET_API_KEY' : `PET_${kind.toUpperCase()}_API_KEY`;
    c.apiKey = process.env[env] || c.apiKey;
    return c;
  }
  public() {
    const c = structuredClone(this.value);
    for (const kind of ['model', 'vision', 'stt', 'tts']) {
      c[kind].hasKey = Boolean(this.provider(kind).apiKey);
      c[kind].keyFromEnvironment = Boolean(process.env[kind === 'model' ? 'PET_API_KEY' : `PET_${kind.toUpperCase()}_API_KEY`]);
      delete c[kind].apiKey;
    }
    c.qq.appId = this.qqCredentials().appId;
    c.qq.hasSecret = Boolean(this.qqCredentials().appSecret);
    c.qq.secretFromEnvironment = Boolean(process.env.QQBOT_SECRET);
    c.qq.appIdFromEnvironment = Boolean(process.env.QQBOT_APPID);
    delete c.qq.appSecret;
    return c;
  }
  qqCredentials() { return { appId: process.env.QQBOT_APPID || this.value.qq.appId, appSecret: process.env.QQBOT_SECRET || this.value.qq.appSecret }; }
  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new BridgeError('配置更新格式错误。');
    const next = structuredClone(this.value);
    for (const kind of ['pet', 'model', 'vision', 'stt', 'tts']) if (patch[kind]) {
      next[kind] = { ...next[kind], ...patch[kind] };
      // A blank password field means keep the current secret; explicit clearKey removes it.
      if (kind !== 'pet' && !patch[kind].apiKey) next[kind].apiKey = this.value[kind].apiKey;
      if (kind !== 'pet' && patch[kind].baseUrl && !patch[kind].apiKey && this.value[kind].baseUrl &&
          endpoint(patch[kind].baseUrl, '').origin !== endpoint(this.value[kind].baseUrl, '').origin) next[kind].apiKey = '';
      if (patch[kind].clearKey === true) next[kind].apiKey = '';
    }
    for (const key of ['port', 'replyAudio']) if (patch[key] !== undefined) next[key] = patch[key];
    if (patch.qq !== undefined) {
      if (!patch.qq || typeof patch.qq !== 'object' || Array.isArray(patch.qq)) throw new BridgeError('QQ 配置格式错误。');
      next.qq = { ...next.qq, ...patch.qq };
      if (!patch.qq.appSecret) next.qq.appSecret = this.value.qq.appSecret;
      if (patch.qq.appId !== undefined && patch.qq.appId !== this.value.qq.appId && !patch.qq.appSecret) next.qq.appSecret = '';
      if (patch.qq.clearSecret === true) next.qq.appSecret = '';
    }
    const validated = validateConfig(next);
    saveJSONFile(this.path, validated);
    this.value = validated;
    return this.public();
  }
}
