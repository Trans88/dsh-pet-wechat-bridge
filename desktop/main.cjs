const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, dialog, shell } = require('electron');
const { join, resolve } = require('node:path');
const { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');

app.setName('Little Pet');
const appRoot = resolve(__dirname, '..');
let pet, room, tray, backend, prefs, prefsPath, geometry, origin, dragging, dragTimer;
let quitting = false, exited = false, lockedThrough = false, ignoring = false, saveTimer, chatOpen = false;
function chooseExistingData() {
  const selected = dialog.showOpenDialogSync({ title: '选择原来运行宠物的文件夹（包含 pet.config.json 和 data）', properties: ['openDirectory'] });
  if (!selected?.length) return null;
  const directory = selected[0];
  if (!existsSync(join(directory, 'pet.config.json')) || !existsSync(join(directory, 'data', 'pet.sqlite'))) {
    dialog.showErrorBox('没有找到原来的小窝', '请选择包含 pet.config.json 和 data/pet.sqlite 的宠物文件夹。'); return null;
  }
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(join(app.getPath('userData'), 'data-location.json'), JSON.stringify({ root: directory }), { mode: 0o600 });
  return directory;
}
const trusted = event => pet && !pet.isDestroyed() && event.sender === pet.webContents &&
  event.senderFrame === pet.webContents.mainFrame && event.senderFrame.url === `${origin}/desktop`;
const send = (channel, value) => { if (pet && !pet.isDestroyed()) pet.webContents.send(channel, value); };

function save() {
  clearTimeout(saveTimer);
  const temp = `${prefsPath}.tmp`;
  try { writeFileSync(temp, JSON.stringify(prefs, null, 2), { mode: 0o600 }); renameSync(temp, prefsPath); }
  catch { /* A read-only data folder must not break dragging or the exit menu. */ }
}
function rememberPosition() {
  if (!pet || pet.isDestroyed()) return;
  const b = pet.getBounds(), display = screen.getDisplayMatching(b);
  Object.assign(prefs, geometry.compactPosition(b, prefs.size), { displayId: display.id });
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 300);
}
function ignoreMouse(ignore) {
  if (!pet || pet.isDestroyed() || ignoring === ignore) return;
  ignoring = ignore;
  pet.setIgnoreMouseEvents(ignore, { forward: true });
}
function showPet() {
  lockedThrough = false; ignoreMouse(false);
  pet.showInactive();
  fitPet();
  updateMenu();
}
function fitPet() {
  const bounds = pet.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  pet.setBounds(geometry.anchoredBounds(bounds, geometry.windowSize(prefs.size, chatOpen), area));
}
function setChatOpen(open) {
  if (!pet || pet.isDestroyed()) return false;
  chatOpen = open; endDrag(); fitPet(); rememberPosition();
  if (open) { lockedThrough = false; ignoreMouse(false); pet.show(); pet.focus(); }
  return chatOpen;
}
function endDrag() { clearInterval(dragTimer); dragTimer = undefined; dragging = undefined; rememberPosition(); }
function changeSettings(patch) {
  Object.assign(prefs, patch);
  pet.setAlwaysOnTop(prefs.alwaysOnTop, 'floating');
  fitPet();
  save(); send('pet:preferences-changed', prefs); updateMenu();
}
function secureWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const localWindow = (room && !room.isDestroyed() && contents === room.webContents) ||
      (pet && !pet.isDestroyed() && contents === pet.webContents && contents.getURL() === `${origin}/desktop`);
    callback(Boolean(localWindow && details.isMainFrame && details.requestingUrl?.startsWith(`${origin}/`) &&
      permission === 'media' && details.mediaTypes?.length && details.mediaTypes.every(type => type === 'audio')));
  });
  win.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    Boolean(((room && !room.isDestroyed() && contents === room.webContents) ||
      (pet && !pet.isDestroyed() && contents === pet.webContents && contents.getURL() === `${origin}/desktop`)) &&
      requestingOrigin === origin && details.isMainFrame !== false && permission === 'media' && details.mediaType === 'audio'));
}
async function openHome(page = 'home') {
  send('pet:action', 'pause');
  if (!['home', 'settings', 'exploration', 'memory', 'channels'].includes(page)) page = 'home';
  if (!room || room.isDestroyed()) {
    room = new BrowserWindow({ title: 'Little Pet · 小窝', width: 1180, height: 820, minWidth: 420, minHeight: 580,
      backgroundColor: '#f3f6fb', show: false, autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    secureWindow(room);
    room.on('close', event => { if (!quitting) { event.preventDefault(); room.hide(); } });
    await room.loadURL(`${origin}/#${page}`);
  } else {
    // Hash navigation keeps drafts, current voice state and chat intact.
    await room.loadURL(`${origin}/#${page}`);
  }
  room.show(); room.focus();
}
function menuTemplate() {
  return [
    { label: '显示 / 找回桌宠', click: showPet },
    { label: '刷新桌宠', click: () => { pet.reload(); showPet(); } },
    { label: '桌面聊天', click: () => { showPet(); send('pet:action', 'chat'); } },
    { label: '桌面语音对话', click: () => { showPet(); send('pet:action', 'voice'); } },
    { label: '打开小窝', click: () => void openHome() },
    { type: 'separator' },
    ...[['pat', '摸摸头'], ['feed', '投喂'], ['hug', '抱抱'], ['play', '逗逗它'], ['dance', '跳个舞'], ['sleep', '睡觉'], ['wake', '叫醒']].map(([action, label]) =>
      ({ label, click: () => { showPet(); send('pet:action', action); } })),
    { type: 'separator' },
    { label: '大小', submenu: Object.entries({ small: '小', medium: '中（推荐）', large: '大' }).map(([size, label]) =>
      ({ label, type: 'radio', checked: prefs.size === size, click: () => changeSettings({ size }) })) },
    { label: '始终置顶', type: 'checkbox', checked: prefs.alwaysOnTop, click: item => changeSettings({ alwaysOnTop: item.checked }) },
    { label: '免打扰（暂停主动气泡）', type: 'checkbox', checked: prefs.quiet, click: item => changeSettings({ quiet: item.checked }) },
    { label: '鼠标穿透（从托盘恢复）', type: 'checkbox', checked: lockedThrough, click: item => { lockedThrough = item.checked; ignoreMouse(lockedThrough); updateMenu(); } },
    ...(process.platform === 'win32' && app.isPackaged ? [{ label: '开机启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: item => { app.setLoginItemSettings({ openAtLogin: item.checked }); updateMenu(); } }] : []),
    { label: '设置 / 切换形象', click: () => void openHome('settings') },
    { label: '打开数据文件夹', click: () => { void shell.openPath(resolve(prefsPath, '..')); } },
    ...(app.isPackaged && !process.env.PET_DATA_ROOT ? [{ label: '使用已有宠物数据…', click: () => { if (chooseExistingData()) { app.relaunch(); app.quit(); } } }] : []),
    { label: '暂时隐藏', click: () => pet.hide() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ];
}
function updateMenu() { tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate())); }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (pet) showPet(); });
  app.on('window-all-closed', () => {});
  app.on('activate', () => { if (pet) showPet(); });
  app.on('before-quit', event => {
    if (exited) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true; endDrag(); if (prefsPath) save();
    Promise.resolve(backend?.stop()).finally(() => { exited = true; tray?.destroy(); app.quit(); });
  });
  app.whenReady().then(async () => {
    geometry = await import('./geometry.mjs');
    let savedRoot;
    if (app.isPackaged && !process.env.PET_DATA_ROOT) {
      try { savedRoot = JSON.parse(readFileSync(join(app.getPath('userData'), 'data-location.json'), 'utf8')).root; } catch {}
      if (typeof savedRoot !== 'string' || !existsSync(join(savedRoot, 'pet.config.json'))) savedRoot = undefined;
      if (!savedRoot && !existsSync(join(app.getPath('userData'), 'pet.config.json'))) {
        const choice = dialog.showMessageBoxSync({ type: 'question', title: '欢迎来到桌面小窝',
          message: '你之前已经在使用 Little Pet 吗？', detail: '选择原来的宠物文件夹，可以继续使用已有聊天记录、模型配置和登录状态。',
          buttons: ['选择已有宠物文件夹', '创建新的小窝'], defaultId: 0, cancelId: 1 });
        if (choice === 0) savedRoot = chooseExistingData();
      }
    }
    const dataRoot = resolve(process.env.PET_DATA_ROOT || savedRoot || (app.isPackaged ? app.getPath('userData') : appRoot));
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    prefsPath = join(dataRoot, 'desktop.settings.json');
    let stored; try { stored = JSON.parse(readFileSync(prefsPath, 'utf8')); } catch {}
    prefs = geometry.cleanPreferences(stored);
    const { connectBackend } = await import('./backend.mjs');
    backend = await connectBackend({ appRoot, dataRoot, onExit: () => {
      if (pet && !quitting) { dialog.showErrorBox('宠物服务已停止', '请退出后重新启动桌宠。聊天记录与配置仍保存在数据文件夹。'); app.quit(); }
    } });
    origin = backend.url;
    pet = new BrowserWindow({ ...geometry.initialBounds(prefs, screen.getAllDisplays()), title: 'Little Pet · 桌宠',
      frame: false, transparent: true, backgroundColor: '#00000000', resizable: false,
      maximizable: false, fullscreenable: false, hasShadow: false, skipTaskbar: true, show: false,
      webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    secureWindow(pet); pet.setAlwaysOnTop(prefs.alwaysOnTop, 'floating');
    pet.on('close', event => { if (!quitting) { event.preventDefault(); pet.hide(); } });
    pet.on('move', rememberPosition); pet.on('blur', endDrag);
    const fixDisplay = () => { endDrag(); fitPet(); };
    screen.on('display-removed', fixDisplay); screen.on('display-metrics-changed', fixDisplay);
    const icon = nativeImage.createFromPath(join(appRoot, 'web', 'assets', 'taolinghu-hd.png'));
    const half = Math.floor(icon.getSize().width / 2);
    tray = new Tray(icon.crop({ x: 0, y: 0, width: half, height: half }).resize({ width: 32, height: 32 }));
    tray.setToolTip('Little Pet · 双击桌面聊天，右键管理桌宠');
    tray.on('click', showPet); tray.on('double-click', () => { showPet(); send('pet:action', 'chat'); }); updateMenu();

    ipcMain.handle('pet:preferences', event => trusted(event) ? prefs : null);
    ipcMain.handle('pet:menu', event => { if (trusted(event)) Menu.buildFromTemplate(menuTemplate()).popup({ window: pet }); });
    ipcMain.handle('pet:home', (event, page) => { if (trusted(event)) return openHome(page); });
    ipcMain.handle('pet:chat', (event, open) => trusted(event) && typeof open === 'boolean' ? setChatOpen(open) : false);
    ipcMain.on('pet:hit', (event, interactive) => {
      // Forwarded mousemove makes the transparent pixels click-through on Windows.
      if (trusted(event) && !dragging && ['win32', 'darwin'].includes(process.platform)) ignoreMouse(lockedThrough || interactive !== true);
    });
    ipcMain.on('pet:drag', (event, phase) => {
      if (!trusted(event)) return;
      if (phase === 'end') { endDrag(); return; }
      if (phase !== 'start' || dragging || lockedThrough) return;
      dragging = { cursor: screen.getCursorScreenPoint(), bounds: pet.getBounds(), at: Date.now() };
      ignoreMouse(false);
      dragTimer = setInterval(() => {
        if (!dragging || Date.now() - dragging.at > 15000) { endDrag(); return; }
        const p = screen.getCursorScreenPoint(), d = screen.getDisplayNearestPoint(p);
        const b = geometry.clampBounds({ ...dragging.bounds, x: dragging.bounds.x + p.x - dragging.cursor.x, y: dragging.bounds.y + p.y - dragging.cursor.y }, d.workArea);
        pet.setBounds(b);
      }, 16);
    });
    await pet.loadURL(`${origin}/desktop`);
    pet.showInactive();
  }).catch(error => { dialog.showErrorBox('桌宠未能启动', error.message); app.quit(); });
}
