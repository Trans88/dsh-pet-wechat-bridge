import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { Config } from './pet/config.mjs';
import { Store } from './pet/store.mjs';
import { Models } from './pet/model.mjs';
import { PetCore } from './pet/core.mjs';
import { createPetServer } from './pet/server.mjs';
import { BridgeError, saveJSONFile } from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const config = new Config(root);
const command = process.argv[2] || 'start';

function openBrowser(url) {
  const args = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(...args, { stdio: 'ignore', detached: true });
  child.on('error', () => {}); child.unref();
}

class WechatProcess {
  constructor() { this.child = null; this.state = 'stopped'; }
  status() { return { state: this.state, linked: existsSync(join(root, 'data', 'account.json')), hasQr: existsSync(join(root, 'data', 'login-qr.png')) }; }
  async start(relogin) {
    if (this.child) throw new BridgeError('微信通道已在运行；换号前请先断开连接。');
    this.state = 'starting';
    const child = spawn(process.execPath, [join(root, 'bridge.mjs'), relogin ? 'login' : 'start'], { cwd: root, stdio: ['inherit', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', bytes => {
      process.stdout.write(bytes);
      if (bytes.toString().includes('桥接已运行')) this.state = 'connected';
    });
    child.stderr.on('data', bytes => process.stderr.write(bytes));
    child.once('error', () => { this.state = 'error'; this.child = null; });
    child.once('exit', code => { this.child = null; this.state = code === 0 || code === null ? 'stopped' : 'error'; });
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}

if (command === 'check') {
  console.log(`独立宠物：${config.value.pet.name}`);
  console.log(`聊天模型：${config.value.model.model}；API Key：${config.provider('model').apiKey ? '已配置' : '未配置（本机模型可以不需要）'}`);
  console.log(`图片：${config.value.model.supportsImages || config.value.vision.enabled ? '已配置能力，请用实际图片验证' : '未开启'}；STT：${config.value.stt.enabled ? '已启用' : '未启用'}；TTS：${config.value.tts.enabled ? '已启用' : '未启用'}`);
  console.log('不依赖 dsh 或 dsh-pet；此检查不调用模型、不发送消息。');
} else if (command === 'start') {
  const store = new Store(root), models = new Models(config), core = new PetCore(config, store, models), wechat = new WechatProcess();
  const app = createPetServer({ root, config, store, core, models, wechat });
  const runtimePath = join(root, 'data', 'pet-runtime.json');
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(config.value.port, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${config.value.port}`;
    saveJSONFile(runtimePath, { url, token: app.token, pid: process.pid });
    console.log(`\nLittle Pet · 独立 AI 宠物 v0.4.0\n打开 ${url}\n首次使用：进入设置，填写模型 API Key。微信通道可在网页中连接。\n按 Ctrl+C 停止。`);
    if (!process.argv.includes('--no-open')) openBrowser(url);
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      app.abort();
      await wechat.stop();
      await new Promise(resolve => app.server.close(resolve));
      store.close();
      try { unlinkSync(runtimePath); } catch {}
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (e) {
    store.close();
    console.error(e.code === 'EADDRINUSE' ? '端口已被占用：请关闭另一份宠物程序，或修改 pet.config.json 的 port。' : '宠物启动失败，请检查端口和目录权限。');
    process.exitCode = 1;
  }
} else { console.error('用法：node app.mjs start [--no-open] | check'); process.exitCode = 1; }
