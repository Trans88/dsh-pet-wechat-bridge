import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from './setup.mjs';
try {
  const executable = ensureElectron();
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  if (executable) {
    const child = spawn(executable, [fileURLToPath(new URL('..', import.meta.url))], { env, stdio: 'inherit', windowsHide: true });
    child.on('error', () => { console.error('桌宠无法启动，请重新运行 npm run desktop:setup。'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
