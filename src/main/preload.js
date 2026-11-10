'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('idevice', {
  status: () => ipcRenderer.invoke('idevice:status'),
  read: (udid) => ipcRenderer.invoke('idevice:read', { udid }),
  crash: (udid) => ipcRenderer.invoke('idevice:crash', { udid }),
  watch: (on) => ipcRenderer.invoke('idevice:watch', { on }),
  install: () => ipcRenderer.invoke('idevice:install'),
  openToolsDir: () => ipcRenderer.invoke('idevice:openToolsDir'),
  onDevices: (cb) => ipcRenderer.on('idevice:devices', (_e, list) => cb(list)),
});

contextBridge.exposeInMainWorld('downloads', {
  list: () => ipcRenderer.invoke('downloads:list'),
  install: (id) => ipcRenderer.invoke('downloads:install', { id }),
  openLink: (url) => ipcRenderer.invoke('downloads:openLink', { url }),
  onProgress: (cb) => ipcRenderer.on('downloads:progress', (_e, m) => cb(m)),
});

contextBridge.exposeInMainWorld('updater', {
  check: () => ipcRenderer.invoke('update:check'),
  apply: () => ipcRenderer.invoke('update:apply'),
  onProgress: (cb) => ipcRenderer.on('update:progress', (_e, m) => cb(m)),
});

contextBridge.exposeInMainWorld('appInfo', {
  version: () => ipcRenderer.invoke('app:version'),
});
