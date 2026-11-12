import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const officialMirror = 'https://github.com/electron/electron/releases/download/';
const chinaMirror = 'https://npmmirror.com/mirrors/electron/';
const usage = '用法：npm run desktop:setup -- --mirror=cn\n可选：--mirror=official 或 --mirror=https://你的镜像/，--proxy=http://127.0.0.1:7890\n同样支持 npm run desktop -- --mirror=cn';

function clearSetting(env, name) {
  for (const key of Object.keys(env)) {
    if ([`electron_${name}`, `npm_config_electron_${name}`, `npm_package_config_electron_${name}`].includes(key.toLowerCase())) delete env[key];
  }
}

function setting(env, name, fallback = '') {
  return env[`npm_config_electron_${name}`] || env[`NPM_CONFIG_ELECTRON_${name.toUpperCase()}`] || env[`npm_package_config_electron_${name}`] || env[`ELECTRON_${name.toUpperCase()}`] || fallback;
}

export function downloadEnvironment(args = [], baseEnv = process.env) {
  const env = { ...baseEnv };
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    const match = /^(--mirror|--proxy)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(usage);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(usage);
    let url;
    try { url = new URL(match[1] === '--mirror' ? ({ cn: chinaMirror, official: officialMirror }[value] || value) : value); } catch { throw new Error('镜像或代理地址无效，请填写完整的 http:// 或 https:// 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.search || (match[1] === '--mirror' && (url.username || url.password))) throw new Error('镜像或代理地址格式不支持，请使用不带查询参数的 HTTP(S) 地址。');
    if (match[1] === '--mirror') {
      // CLI arguments must beat npm-injected settings as well as shell variables.
      clearSetting(env, 'mirror');
      env.ELECTRON_MIRROR = `${url.href.replace(/\/+$/, '')}/`;
    } else {
      for (const key of Object.keys(env)) if (['http_proxy', 'https_proxy'].includes(key.toLowerCase())) delete env[key];
      env.HTTP_PROXY = env.HTTPS_PROXY = url.href;
      env.ELECTRON_GET_USE_PROXY = '1';
    }
  }
  if (env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy) env.ELECTRON_GET_USE_PROXY = '1';
  return { env, help };
}

export function installedElectron(directory, env = process.env, platform = process.platform) {
  // require('electron') downloads on recent Electron versions. Inspect files only.
  const expected = platform === 'win32' ? 'electron.exe' : platform === 'darwin' || platform === 'mas' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  try {
    const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
    if (readFileSync(join(directory, 'dist/version'), 'utf8').trim().replace(/^v/, '') !== version) return null;
    if (readFileSync(join(directory, 'path.txt'), 'utf8').trim() !== expected) return null;
    const executable = join(env.ELECTRON_OVERRIDE_DIST_PATH || join(directory, 'dist'), expected);
    return existsSync(executable) ? executable : null;
  } catch { return null; }
}

function safeHost(value) { try { return new URL(value).host; } catch { return '自定义地址'; } }

export function ensureElectron({ args = process.argv.slice(2), env: baseEnv = process.env, directory, run = spawnSync, log = console.log } = {}) {
  const { env, help } = downloadEnvironment(args, baseEnv);
  if (help) { log(usage); return null; }
  try { directory ??= dirname(require.resolve('electron/package.json')); } catch { throw new Error('请先运行 npm ci --include=dev --ignore-scripts，再运行 npm run desktop:setup。'); }
  let executable = installedElectron(directory, env);
  if (executable) { log('Electron 运行环境已就绪。'); return executable; }
  log(`首次准备桌面运行环境。下载源：${safeHost(setting(env, 'mirror', officialMirror))}`);
  if (env.ELECTRON_GET_USE_PROXY) {
    const proxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
    log(proxy ? `下载代理：${safeHost(proxy)}` : '已启用 Electron 下载代理。');
    try { createRequire(join(directory, 'package.json'))('undici'); } catch { throw new Error('代理依赖 undici 缺失，请运行 npm ci --include=dev --include=optional --ignore-scripts 后重试。'); }
  }
  const result = run(process.execPath, ['--require', fileURLToPath(new URL('./download-diagnostics.cjs', import.meta.url)), join(directory, 'install.js')], {
    env, stdio: 'inherit', windowsHide: true, timeout: 10 * 60_000,
  });
  if (result.status !== 0) {
    const reason = result.error?.code === 'ETIMEDOUT' ? '下载超过 10 分钟。' : 'Electron 下载失败。';
    throw new Error(`${reason}可执行 npm run desktop:setup -- --mirror=cn；如需代理，追加 --proxy=http://127.0.0.1:你的端口。下载成功后运行 npm run desktop。`);
  }
  executable = installedElectron(directory, env);
  if (!executable) throw new Error('下载程序已退出，但 Electron 文件不完整，请重新运行 npm run desktop:setup。');
  log('Electron 下载完成。现在可以运行 npm run desktop。');
  return executable;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { ensureElectron(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
