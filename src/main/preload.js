'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('idevice', {
  status: () => ipcRenderer.invoke('idevice:status'),
  read: (udid) => ipcRenderer.invoke('idevice:read', { udid }),
  crash: (udid) => ipcRenderer.invoke('idevice:crash', { udid }),
  watch: (on) => ipcRenderer.invoke('idevice:watch', { on }),
  install: () => ipcRenderer.invoke('idevice:install'),
  openToolsDir: () => ipcRenderer.invoke('idevice:openToolsDir'),
  backup: (udid) => ipcRenderer.invoke('idevice:backup', { udid }),
  restore: (udid) => ipcRenderer.invoke('idevice:restore', { udid }),
  wipeStatus: (udid) => ipcRenderer.invoke('idevice:wipeStatus', { udid }),
  pickIpsw: () => ipcRenderer.invoke('idevice:pickIpsw'),
  wipe: (args) => ipcRenderer.invoke('idevice:wipe', args),
  revealPath: (p) => ipcRenderer.invoke('idevice:revealPath', { path: p }),
  onBackupProgress: (cb) => ipcRenderer.on('idevice:backupProgress', (_e, m) => cb(m)),
  onWipeProgress: (cb) => ipcRenderer.on('idevice:wipeProgress', (_e, m) => cb(m)),
  onDevices: (cb) => ipcRenderer.on('idevice:devices', (_e, list) => cb(list)),
});

contextBridge.exposeInMainWorld('photos', {
  status: (udid) => ipcRenderer.invoke('photos:status', { udid }),
  folders: (udid) => ipcRenderer.invoke('photos:folders', { udid }),
  list: (udid, folder) => ipcRenderer.invoke('photos:list', { udid, folder }),
  thumb: (udid, folder, name) => ipcRenderer.invoke('photos:thumb', { udid, folder, name }),
  export: (udid, folder, names) => ipcRenderer.invoke('photos:export', { udid, folder, names }),
  openExplorer: () => ipcRenderer.invoke('photos:openExplorer'),
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

contextBridge.exposeInMainWorld('syncro', {
  get: () => ipcRenderer.invoke('syncro:get'),
  save: (payload) => ipcRenderer.invoke('syncro:save', payload),
  test: (payload) => ipcRenderer.invoke('syncro:test', payload),
  assetTypes: () => ipcRenderer.invoke('syncro:assetTypes'),
  searchCustomers: (query) => ipcRenderer.invoke('syncro:searchCustomers', { query }),
  register: (args) => ipcRenderer.invoke('syncro:register', args),
  openTickets: (customerId) => ipcRenderer.invoke('syncro:openTickets', { customerId }),
  attachTicket: (args) => ipcRenderer.invoke('syncro:attachTicket', args),
});

contextBridge.exposeInMainWorld('appInfo', {
  version: () => ipcRenderer.invoke('app:version'),
});
