import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadEnvironment, installedElectron, ensureElectron } from '../desktop/setup.mjs';

const executableName = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-electron-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  // A check must never load the Electron entry point (which now auto-downloads).
  writeFileSync(join(dir, 'index.js'), 'throw new Error("entry point must not run")');
  return dir;
}
function installFixture(dir) {
  const binary = join(dir, 'dist', executableName);
  mkdirSync(join(binary, '..'), { recursive: true });
  writeFileSync(binary, 'fake test executable');
  writeFileSync(join(dir, 'dist/version'), '1.2.3');
  writeFileSync(join(dir, 'path.txt'), executableName);
  return binary;
}

test('setup arguments beat shell/npm mirror settings and keep proxy credentials out of display', () => {
  const base = { ELECTRON_MIRROR: 'https://old.test/', npm_config_electron_mirror: 'https://npm.test/', NPM_CONFIG_ELECTRON_MIRROR: 'https://upper.test/', https_proxy: 'http://old-proxy.test/', NO_PROXY: 'localhost' };
  const { env } = downloadEnvironment(['--mirror=cn', '--proxy', 'http://user:secret@127.0.0.1:7890'], base);
  assert.equal(env.ELECTRON_MIRROR, 'https://npmmirror.com/mirrors/electron/');
  assert.equal(env.npm_config_electron_mirror, undefined);
  assert.equal(env.NPM_CONFIG_ELECTRON_MIRROR, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.HTTPS_PROXY, 'http://user:secret@127.0.0.1:7890/');
  assert.equal(env.ELECTRON_GET_USE_PROXY, '1');
  assert.equal(env.NO_PROXY, 'localhost');
  assert.equal(base.ELECTRON_MIRROR, 'https://old.test/');
  assert.equal(downloadEnvironment([], { HTTPS_PROXY: 'http://127.0.0.1:7890' }).env.ELECTRON_GET_USE_PROXY, '1');
  for (const args of [['--mirror'], ['--proxy='], ['--mirror=file:///bad'], ['--mirror=https://secret@host.test/'], ['--other']]) assert.throws(() => downloadEnvironment(args, {}));
});

test('an installed runtime is checked without running an installer; partial/version-mismatched installs are rejected', t => {
  const directory = fixture(t), binary = installFixture(directory);
  assert.equal(ensureElectron({ directory, args: [], env: {}, log() {}, run() { assert.fail('must not download'); } }), binary);
  writeFileSync(join(directory, 'dist/version'), '0.0.0');
  assert.equal(installedElectron(directory, {}), null);
  writeFileSync(join(directory, 'dist/version'), '1.2.3');
  writeFileSync(join(directory, 'path.txt'), '../outside');
  assert.equal(installedElectron(directory, {}), null);
  writeFileSync(join(directory, 'path.txt'), executableName);
  rmSync(binary);
  assert.equal(installedElectron(directory, {}), null);
});

test('a failed download runs exactly once and reports the selected source with a shell-independent retry', t => {
  const directory = fixture(t), logs = []; let attempts = 0;
  assert.throws(() => ensureElectron({ directory, args: ['--mirror=cn'], env: {}, log: line => logs.push(line), run(command, args, options) {
    attempts++;
    assert.equal(command, process.execPath);
    assert.equal(args.at(-1), join(directory, 'install.js'));
    assert.equal(options.env.ELECTRON_MIRROR, 'https://npmmirror.com/mirrors/electron/');
    return { status: 1 };
  } }), /--mirror=cn/);
  assert.equal(attempts, 1);
  assert.match(logs.join('\n'), /npmmirror\.com/);
});

test('the actual child installer receives the selected mirror and successful installation is verified', t => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'install.js'), `
    const fs = require('node:fs'), path = require('node:path');
    if (process.env.ELECTRON_MIRROR !== 'https://npmmirror.com/mirrors/electron/') process.exit(7);
    const binary = path.join(__dirname, 'dist', ${JSON.stringify(executableName)});
    fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'fixture');
    fs.writeFileSync(path.join(__dirname, 'dist/version'), '1.2.3');
    fs.writeFileSync(path.join(__dirname, 'path.txt'), ${JSON.stringify(executableName)});
  `);
  const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
  const result = ensureElectron({ directory, args: ['--mirror=cn'], env, log() {}, run(command, args, options) { return spawnSync(command, args, { ...options, stdio: 'pipe' }); } });
  assert.equal(result, join(directory, 'dist', executableName));
  assert.equal(readFileSync(result, 'utf8'), 'fixture');
  rmSync(result);
  assert.throws(() => ensureElectron({ directory, args: [], env: {}, log() {}, run: () => ({ status: 0 }) }), /文件不完整/);
});

test('network diagnostics expose nested error codes but not credentials or signed URLs', () => {
  const preload = fileURLToPath(new URL('../desktop/download-diagnostics.cjs', import.meta.url));
  const script = `
    const error = new Error('credential-password https://example.test/?token=private', { cause: new AggregateError([Object.assign(new Error('secret'), { code: 'ECONNREFUSED' })]) });
    globalThis.fetch = async () => { throw error; };
    require(${JSON.stringify(preload)});
    fetch('https://unused.test').catch(() => {});
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /ECONNREFUSED/);
  assert.doesNotMatch(result.stderr, /credential|password|secret|token|example\.test/);
});
