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

contextBridge.exposeInMainWorld('appInfo', {
  version: () => ipcRenderer.invoke('app:version'),
});
