const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petDesktop', Object.freeze({
  preferences: () => ipcRenderer.invoke('pet:preferences'),
  menu: () => ipcRenderer.invoke('pet:menu'),
  openHome: page => ipcRenderer.invoke('pet:home', page),
  chat: open => ipcRenderer.invoke('pet:chat', open === true),
  drag: phase => ipcRenderer.send('pet:drag', phase),
  hit: interactive => ipcRenderer.send('pet:hit', interactive === true),
  onAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('pet:action', listener);
    return () => ipcRenderer.removeListener('pet:action', listener);
  },
  onPreferences: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pet:preferences-changed', listener);
    return () => ipcRenderer.removeListener('pet:preferences-changed', listener);
  },
}));
