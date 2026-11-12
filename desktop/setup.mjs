import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
try {
  const directory = dirname(require.resolve('electron/package.json'));
  let executable; try { executable = require('electron'); } catch {}
  if (!executable || !existsSync(executable)) {
    console.log('首次准备桌面运行环境，正在下载 Electron……');
    const result = spawnSync(process.execPath, [join(directory, 'install.js')], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error('桌面运行环境下载失败，请检查网络后重新运行 npm run desktop:setup。');
  }
} catch (error) {
  console.error(error.code === 'MODULE_NOT_FOUND' ? '请先运行 npm ci --include=dev --ignore-scripts，再运行 npm run desktop:setup。' : error.message);
  process.exitCode = 1;
}
