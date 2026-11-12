import { packager } from '@electron/packager';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const platform = process.argv[2] || 'win32', arch = process.argv[3] || 'x64';
if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('用法：node desktop/build.mjs [win32|linux|darwin] [x64|arm64]');
const stage = mkdtempSync(join(tmpdir(), 'little-pet-build-'));
try {
  // Deliberate allowlist: never package local credentials, SQLite, logs or profiles.
  const allowed = new Set(['desktop', 'pet', 'web', 'app.mjs', 'bridge.mjs', 'config.mjs', 'lib.mjs', 'media.mjs', 'dependency-check.mjs', 'README.md', 'package.json', 'package-lock.json']);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const name of tracked.filter(name => allowed.has(name.split('/')[0]))) {
    mkdirSync(dirname(join(stage, name)), { recursive: true });
    cpSync(join(root, name), join(stage, name));
  }
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('请使用 npm run desktop:build 启动打包。');
  const install = spawnSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
  if (install.status !== 0) throw new Error('打包依赖安装失败。');
  const manifest = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
  delete manifest.devDependencies;
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
  const paths = await packager({ dir: stage, name: 'LittlePet', executableName: 'LittlePet', platform, arch,
    electronVersion: JSON.parse(readFileSync(join(root, 'package.json'))).devDependencies.electron,
    out: join(root, 'dist'), overwrite: true, asar: false, prune: false,
    appVersion: manifest.version, appBundleId: 'com.littlepet.companion',
    win32metadata: { CompanyName: 'Trans88', ProductName: 'Little Pet', FileDescription: 'Little Pet desktop companion' } });
  console.log(`桌面程序已生成：${paths.join(', ')}\n请分发整个目录。Windows 双击 LittlePet.exe，不需要另装 Node.js。`);
} finally { rmSync(stage, { recursive: true, force: true }); }
