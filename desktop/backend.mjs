import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function validRuntime(value) {
  if (!value || typeof value.url !== 'string' || !/^[a-f0-9]{64}$/.test(value.token || '')) return false;
  try { const u = new URL(value.url); return u.protocol === 'http:' && u.hostname === '127.0.0.1' &&
    /^\d+$/.test(u.port) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'; }
  catch { return false; }
}

export async function connectBackend({ appRoot, dataRoot, execPath = process.execPath, onExit = () => {} }) {
  // Reuse an existing service only when its exact per-start token authenticates.
  let previous;
  try { previous = JSON.parse(readFileSync(join(dataRoot, 'data', 'pet-runtime.json'), 'utf8')); } catch {}
  if (validRuntime(previous)) {
    try {
      const response = await fetch(`${previous.url}/api/state`, { headers: { Authorization: `Bearer ${previous.token}` }, signal: AbortSignal.timeout(1800), redirect: 'error' });
      const state = response.ok ? await response.json() : null;
      if (state?.config?.pet && state?.care) return { url: previous.url, owned: false, stop: async () => {} };
    } catch {}
  }
  const child = fork(join(appRoot, 'app.mjs'), ['start', '--no-open'], {
    execPath, cwd: appRoot, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PET_DATA_ROOT: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Drain child output without retaining credentials, model messages or QR URLs.
  child.stdout?.resume(); child.stderr?.resume();
  let stopped = false, ended = false;
  child.once('exit', () => { ended = true; if (!stopped) onExit(); });
  const stop = async () => {
    stopped = true;
    if (ended) return;
    await new Promise(resolve => {
      const deadline = setTimeout(() => { child.kill(); resolve(); }, 7000);
      child.once('exit', () => { clearTimeout(deadline); resolve(); });
      if (child.connected) child.send({ type: 'pet-stop' }, () => {}); else child.kill();
    });
  };
  try {
    const runtime = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('宠物服务启动超过 20 秒，请检查目录权限和运行依赖。')), 20000);
      const onMessage = value => { if (value?.type === 'pet-ready' && validRuntime(value)) finish(null, value); };
      const onError = () => finish(new Error('宠物服务无法启动，请重新安装桌面版。'));
      const onChildExit = () => finish(new Error('宠物服务启动失败。请关闭另一份宠物，检查端口占用和配置文件。'));
      const finish = (error, value) => {
        clearTimeout(timer); child.off('message', onMessage); child.off('error', onError); child.off('exit', onChildExit);
        error ? reject(error) : resolve(value);
      };
      child.on('message', onMessage); child.once('error', onError); child.once('exit', onChildExit);
    });
    return { url: runtime.url, owned: true, stop };
  } catch (error) { await stop(); throw error; }
}
