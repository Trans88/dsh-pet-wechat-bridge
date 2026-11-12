import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './setup.mjs';
if (!process.exitCode) {
  const require = createRequire(import.meta.url), { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  const child = spawn(require('electron'), [fileURLToPath(new URL('..', import.meta.url))], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', () => { console.error('桌宠无法启动，请重新运行 npm run desktop:setup。'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
}
