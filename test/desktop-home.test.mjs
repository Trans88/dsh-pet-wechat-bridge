import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';

// Run the real main-process entry with controlled native windows and load timing.
// Do not start a backend or require a desktop session for these lifecycle regressions.
function fixture() {
  const windows = [], errors = [], require = createRequire(import.meta.url);
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); windows.push(this); this.visible = options.show; this.destroyed = false;
      this.minimized = false; this.loads = []; this.shows = 0; this.restores = 0;
      this.location = new URL('about:blank');
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        getURL: () => this.location.href,
        executeJavaScript: async script => vm.runInNewContext(script, { window: { location: this.location } }),
      });
    }
    loadURL(url) {
      this.loads.push(url);
      return new Promise((resolve, reject) => {
        this.finishLoad = () => { this.location = new URL(url); resolve(); };
        this.failLoad = reject;
      });
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.visible = false; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.restores++; }
    show() { this.visible = true; this.shows++; }
    focus() { this.focused = true; }
    hide() { this.visible = false; }
    close() { this.emit('close', { preventDefault() {} }); }
  }
  const electron = { BrowserWindow, app: { setName() {}, requestSingleInstanceLock: () => false, quit() {} },
    dialog: { showErrorBox: (...args) => errors.push(args) } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : require(name),
    __dirname: fileURLToPath(new URL('../desktop', import.meta.url)), process, URL,
    setImmediate, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8'), context);
  vm.runInContext("origin = 'http://127.0.0.1:3210'; prefs = { size: 'medium' };", context);
  return { windows, errors, open: context.openHome, menu: context.menuTemplate };
}

test('one menu selection reveals the first room before a slow load completes', async () => {
  const { menu, windows } = fixture();
  menu().find(item => item.label === '打开小窝').click();
  assert.equal(windows.length, 0, 'let the native menu finish closing before taking focus');
  await nextTurn();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].visible, true, 'one selection shows the room without waiting for page loading');
  assert.equal(windows[0].focused, true);
  windows[0].finishLoad(); await nextTurn();
  assert.equal(windows[0].loads.length, 1);
});

test('rapid opening shares one initial load and uses the last requested page', async () => {
  const { open, windows } = fixture();
  const first = open('home'), second = open('settings'), third = open('memory');
  assert.equal(windows.length, 1); assert.equal(windows[0].loads.length, 1);
  windows[0].finishLoad(); await Promise.all([first, second, third]);
  assert.equal(windows[0].location.hash, '#memory');
});

test('reopening hidden or minimized room restores it without reloading; navigation is local', async () => {
  const { open, windows } = fixture();
  const first = open(); windows[0].finishLoad(); await first;
  const win = windows[0]; win.close(); assert.equal(win.visible, false);
  await open(); assert.equal(win.visible, true); assert.equal(win.loads.length, 1);
  win.minimized = true; await open('diary');
  assert.equal(win.restores, 1); assert.equal(win.minimized, false);
  assert.equal(win.location.hash, '#diary'); assert.equal(win.loads.length, 1);
  await open('https://untrusted.example/');
  assert.equal(win.location.href, 'http://127.0.0.1:3210/#home');
});

test('finishing a slow initial load does not reopen a room the user has closed', async () => {
  const { open, windows } = fixture();
  const first = open(); windows[0].close(); windows[0].finishLoad(); await first;
  assert.equal(windows[0].visible, false); assert.equal(windows[0].shows, 1);
});

test('failed initial load is reported once and a later request can retry', async () => {
  const { open, windows, errors } = fixture();
  const first = open(), duplicate = open();
  windows[0].failLoad(new Error('ERR_CONNECTION_REFUSED')); await Promise.all([first, duplicate]);
  assert.equal(errors.length, 1); assert.match(errors[0][1], /ERR_CONNECTION_REFUSED/);
  assert.equal(windows[0].destroyed, true);
  const retry = open(); assert.equal(windows.length, 2); assert.equal(windows[1].visible, true);
  windows[1].finishLoad(); await retry;
});
