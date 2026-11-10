import { readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaFlow } from './media.mjs';
import { loadConfig } from './config.mjs';
import {
  BridgeError, QR_BASE, Weixin, Pet, weixinOrigin, readJSONFile, saveJSONFile,
  newState, enqueue, recoverUncertain, processQueue,
} from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, 'data');
const accountPath = join(dataDir, 'account.json');
const statePath = join(dataDir, 'state.json');
let config;
const stop = new AbortController();
process.on('SIGINT', () => { console.log('\n正在停止……'); stop.abort(); });
process.on('SIGTERM', () => stop.abort());

function validateAccount(account) {
  if (!account || !['token', 'botId', 'userId', 'baseUrl'].every(k => typeof account[k] === 'string' && account[k]) ||
      !Number.isFinite(account.linkedAt)) throw new BridgeError('微信凭证不完整，请运行 relogin.cmd。');
  weixinOrigin(account.baseUrl);
  return account;
}

async function showQR(text) {
  if (typeof text !== 'string' || !text || text.length > 6000) throw new BridgeError('微信未返回有效的二维码。');
  const { default: QRCode } = await import('qrcode');
  const path = join(dataDir, 'login-qr.png');
  await QRCode.toFile(path, text, { width: 440, margin: 3, errorCorrectionLevel: 'M' });
  chmodSync(path, 0o600);
  console.log('\n请用你自己的手机微信扫码，并按手机提示确认。二维码图片保存在：');
  console.log(path);
  const app = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(app, [path], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.log('图片未自动打开，请手动打开上方 login-qr.png。'));
  child.unref();
}

async function login() {
  console.log('开始本人绑定：微信会创建/绑定一个 Bot 会话，用来与你的宠物聊天。');
  const api = new Weixin();
  const deadline = Date.now() + 8 * 60 * 1000;
  let base = QR_BASE, qrcode, pin, shownScanned = false;
  let refreshes = 0;
  async function refresh() {
    if (++refreshes > 3) throw new BridgeError('二维码多次过期或锁定，请稍后重新运行。');
    const result = await api.call('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { base: QR_BASE, auth: false, signal: stop.signal });
    if (typeof result.qrcode !== 'string' || !result.qrcode) throw new BridgeError('微信未返回登录标识。');
    qrcode = result.qrcode; pin = undefined; base = QR_BASE; shownScanned = false;
    await showQR(result.qrcode_img_content);
  }
  try {
    await refresh();
    while (Date.now() < deadline && !stop.signal.aborted) {
      const params = new URLSearchParams({ qrcode });
      if (pin) params.set('verify_code', pin);
      let status;
      try {
        status = await api.call(`ilink/bot/get_qrcode_status?${params}`, undefined,
          { base, auth: false, timeoutMs: 35000, signal: stop.signal });
      } catch (e) {
        if (stop.signal.aborted) break;
        if (!['aborted', 'network'].includes(e.code)) throw e;
        console.log('正在等待微信扫码状态……');
        await delay(1500, undefined, { signal: stop.signal }).catch(() => {});
        continue;
      }
      const value = String(status.status || '');
      if (value.includes('need_verifycode')) {
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { pin = (await input.question('请输入手机页面显示的数字验证码：', { signal: stop.signal })).trim(); }
        finally { input.close(); }
        if (!/^\d{1,16}$/.test(pin)) throw new BridgeError('验证码应为数字，请重新登录。');
      } else if (value === 'confirmed') {
        const account = validateAccount({ token: status.bot_token, botId: status.ilink_bot_id,
          userId: status.ilink_user_id, baseUrl: weixinOrigin(status.baseurl || base), linkedAt: Date.now() });
        saveJSONFile(accountPath, account);
        saveJSONFile(statePath, newState(account));
        console.log('微信绑定成功，凭证已保存在本机。');
        return account;
      } else if (value === 'scaned') {
        pin = undefined;
        if (!shownScanned) console.log('已扫码，请在手机微信完成确认。');
        shownScanned = true;
      } else if (value === 'expired' || value === 'verify_code_blocked') {
        console.log('二维码已过期或验证码被锁定，正在换一张……');
        await refresh();
      } else if (value === 'scaned_but_redirect') {
        if (typeof status.redirect_host !== 'string') throw new BridgeError('微信缺少地区重定向地址。');
        base = weixinOrigin(`https://${status.redirect_host}`);
      } else if (value === 'binded_redirect') {
        throw new BridgeError('此 Bot 已绑定其他客户端。请在微信里检查绑定状态，再重新运行 relogin.cmd。');
      } else if (value !== 'wait') {
        throw new BridgeError('微信返回了未支持的登录状态，请更新桥接程序或反馈此问题。');
      }
      await delay(1000, undefined, { signal: stop.signal }).catch(() => {});
    }
    throw new BridgeError(stop.signal.aborted ? '登录已停止。' : '登录超时，请重新运行。');
  } finally {
    try { unlinkSync(join(dataDir, 'login-qr.png')); } catch {}
  }
}

function lockInstance() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'running.lock');
  let old;
  try { old = Number(readFileSync(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old !== undefined) {
    let alive = true;
    if (!Number.isInteger(old) || old < 1) throw new BridgeError('data/running.lock 损坏；确认没有桥接进程后删除该文件。');
    try { process.kill(old, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new BridgeError('桥接程序已在运行，请先关闭原窗口。');
    unlinkSync(path);
  }
  try { writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { throw new BridgeError('无法取得运行锁；请检查是否已经启动桥接程序。'); }
  return () => { try { if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); } catch {} };
}

async function run(pet, account) {
  const api = new Weixin(account);
  const media = new MediaFlow(pet, api, config);
  const state = readJSONFile(statePath, newState(account));
  if (state.botId !== account.botId || state.owner !== account.userId || !Array.isArray(state.queue) ||
      !Array.isArray(state.seen) || typeof state.cursor !== 'string' || !Number.isFinite(state.since)) {
    throw new BridgeError('消息状态与当前账号不匹配，请运行 relogin.cmd。');
  }
  const save = () => saveJSONFile(statePath, state);
  const uncertain = recoverUncertain(state);
  if (uncertain) console.log(`上次中断了 ${uncertain} 条消息，为避免重复生成/发送，未自动重试。需要时请在微信重新提问。`);
  save();
  try { await api.call('ilink/bot/msg/notifystart', {}, { signal: stop.signal }); }
  catch (e) { if (e.code === 'auth-expired') throw e; console.log(`启动通知未成功：${e.message}`); }
  console.log('桥接已运行。请在微信刚绑定的 Bot 会话里发一条文字；关闭此窗口后不再回复。');
  console.log('支持扫码账号私聊文字、图片、微信语音；语音回复以 MP3 文件发送。群聊暂不处理。按 Ctrl+C 停止。');
  console.log(`语音回复模式：${media.replyAudio}（voice=只回复语音消息，always=所有回复，off=关闭）。`);
  let failures = 0;
  try {
    while (!stop.signal.aborted) {
      // Complete durable inbox before polling another batch. All pet calls are serial.
      await processQueue(state, { pet, weixin: api, save, signal: stop.signal,
        respond: (job, signal) => media.respond(job, signal),
        prepare: (action, job, signal) => media.prepare(action, job, signal),
      });
      if (stop.signal.aborted) break;
      let batch;
      try { batch = await api.updates(state.cursor, stop.signal); failures = 0; }
      catch (e) {
        if (e.code === 'auth-expired' || e.code?.startsWith('http-4')) throw e;
        failures++;
        console.log(`收取微信消息失败（第 ${failures} 次）：${e.message}`);
        await delay(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), undefined, { signal: stop.signal }).catch(() => {});
        continue;
      }
      enqueue(state, batch, account);
      save(); // Cursor and inbox are committed together before any side effect.
      if (!state.queue.length) await delay(400, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    await api.call('ilink/bot/msg/notifystop', {}, { timeoutMs: 3000 }).catch(() => {});
  }
}

let unlock;
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new BridgeError('请安装 Node.js 22.13 或更新版本（推荐 24 LTS）。');
  const command = process.argv[2] || 'start';
  if (!['start', 'check', 'login'].includes(command)) throw new BridgeError('用法：node bridge.mjs start | check | login');
  config = loadConfig(root);
  const pet = new Pet(config);
  const info = await pet.check();
  console.log(`本地宠物接口正常，选中 petId=${info.id}。`);
  if (command !== 'check') {
    unlock = lockInstance();
    const existing = readJSONFile(accountPath, null);
    const account = command === 'login' || !existing ? await login() : validateAccount(existing);
    if (command === 'start' && !stop.signal.aborted) await run(pet, account);
    else console.log('现在可以运行 start.cmd。');
  }
} catch (e) {
  if (!stop.signal.aborted) {
    console.error(`\n未能继续：${e instanceof BridgeError ? e.message : '本地运行失败，请检查 Node.js、依赖和目录写权限。'}`);
    console.error('排查说明请看 README.md；请勿分享 data/account.json 中的登录凭证。');
    process.exitCode = 1;
  }
} finally { unlock?.(); }
