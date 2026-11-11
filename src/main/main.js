'use strict';

// TM Phone — standalone iOS/iPadOS diagnostics for the repair bench.
// Reads a connected iPhone/iPad over USB (via the open-source libimobiledevice
// tools), remote-updates itself, and offers a built-in Downloads page so all
// dependencies are one click away. No licence gate — internal tool.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const idevice = require('./idevice/idevice');
const updater = require('./update');
const http = require('./httpget');
const { extract } = require('./extract');
const config = require('./config');
const syncro = require('./syncro');

let mainWindow = null;

// ---- Portable data dir: prefer a folder next to the executable (travels on a
// USB stick), fall back to per-user appdata. ----
let _dataDir = null;
function getDataDir() {
  if (_dataDir) return _dataDir;
  const candidates = [];
  // A single-file portable build extracts to temp, so prefer the real exe dir
  // electron-builder exposes; otherwise the folder next to the executable.
  try { if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'TM-Phone-Data')); } catch { /* ignore */ }
  try { candidates.push(path.join(path.dirname(process.execPath), 'TM-Phone-Data')); } catch { /* ignore */ }
  try { candidates.push(app.getPath('userData')); } catch { /* ignore */ }
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.writetest');
      fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe);
      _dataDir = dir; return dir;
    } catch { /* try next */ }
  }
  _dataDir = app.getPath('userData');
  return _dataDir;
}

idevice.configure({ dataDir: getDataDir() });
config.configure({ dataDir: getDataDir() });

function sendUpdateProgress(m) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:progress', m); }

// Collect every .exe/.dll under a dir (handles nested folders) and copy into the
// portable tools folder.
async function installToolsFrom(srcDir) {
  const found = [];
  const walk = async (d) => {
    for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (/\.(exe|dll)$/i.test(ent.name)) found.push(p);
    }
  };
  await walk(srcDir);
  if (!found.length) return { ok: false, reason: 'No .exe/.dll files were found in that archive.' };
  const dest = idevice.installDir();
  await fsp.mkdir(dest, { recursive: true });
  for (const f of found) await fsp.copyFile(f, path.join(dest, path.basename(f)));
  const verify = idevice.verifyDir(dest);
  return { ok: verify.ok, installed: found.length, dest, missing: verify.missing };
}

async function loadManifest() {
  // Live manifest from the repo first, so URLs can be fixed without a rebuild.
  const rawUrl = 'https://raw.githubusercontent.com/' + updater.REPO + '/' + updater.BRANCH + '/downloads.json?t=' + Date.now();
  try { return await http.getJson(rawUrl); }
  catch {
    try { return JSON.parse(await fsp.readFile(path.join(__dirname, '..', '..', 'downloads.json'), 'utf8')); }
    catch { return { dependencies: [] }; }
  }
}

function registerIpc() {
  // ---- device reading ----
  ipcMain.handle('idevice:status', async () => {
    try { return await idevice.status(); } catch (err) { return { toolsPresent: false, message: (err && err.message) || String(err), devices: [] }; }
  });
  ipcMain.handle('idevice:read', async (_e, a) => {
    try { return await idevice.readDevice((a && a.udid) || ''); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('idevice:crash', async (_e, a) => {
    try { const out = path.join(app.getPath('temp'), 'tmphone-crash-' + Date.now()); await fsp.mkdir(out, { recursive: true }); return await idevice.crashReports((a && a.udid) || '', out); }
    catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('idevice:backup', async (_e, a) => {
    try {
      const udid = (a && a.udid) || '';
      const base = path.join(getDataDir(), 'Backups');
      await fsp.mkdir(base, { recursive: true });
      const pick = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose where to save the backup',
        defaultPath: base,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, canceled: true };
      const dest = pick.filePaths[0];
      await fsp.mkdir(dest, { recursive: true });
      return await idevice.backupDevice(udid, dest, (m) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('idevice:backupProgress', m);
      });
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('idevice:restore', async (_e, a) => {
    try {
      const udid = (a && a.udid) || '';
      const base = path.join(getDataDir(), 'Backups');
      const pick = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose the backup folder to restore from',
        defaultPath: base,
        properties: ['openDirectory'],
      });
      if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, canceled: true };
      return await idevice.restoreDevice(udid, pick.filePaths[0], (m) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('idevice:backupProgress', m);
      });
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  // Erase / flash (wipe). Guarded: reads Find My live and refuses if it can
  // detect Activation Lock is ON, regardless of what the UI sent.
  ipcMain.handle('idevice:wipeStatus', async (_e, a) => {
    try {
      const fm = await idevice.findMyStatus((a && a.udid) || '');
      return { ok: true, findMy: fm, hasTool: idevice.hasRestoreTool() };
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('idevice:pickIpsw', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Choose an IPSW firmware file', properties: ['openFile'], filters: [{ name: 'iOS firmware', extensions: ['ipsw'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });
  ipcMain.handle('idevice:wipe', async (_e, a) => {
    try {
      const udid = (a && a.udid) || '';
      if (!a || a.confirm !== 'ERASE') return { ok: false, reason: 'Confirmation text did not match.' };
      // Hard safety gate: if we can positively detect Find My is ON, refuse.
      const fm = await idevice.findMyStatus(udid);
      if (fm.known && fm.enabled) {
        return { ok: false, reason: 'BLOCKED: Find My / Activation Lock is ON. The owner must sign out of Find My (Settings → [name] → Find My) first, or the device will be locked and unusable after the wipe.' };
      }
      return await idevice.wipeDevice(udid, { ipsw: (a && a.ipsw) || null }, (m) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('idevice:wipeProgress', m);
      });
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  // ---- photos (camera roll browser) ----
  ipcMain.handle('photos:status', async (_e, a) => {
    try { return { ok: true, afc: idevice.afcPresent(), udid: (a && a.udid) || '' }; }
    catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('photos:openExplorer', async () => {
    try {
      // Opens "This PC", where a trusted iPhone/iPad appears as a device with
      // Internal Storage > DCIM — reliable, no extra tools needed.
      require('node:child_process').exec('explorer.exe shell:MyComputerFolder');
      return { ok: true };
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('photos:folders', async (_e, a) => { try { return await idevice.photoFolders((a && a.udid) || ''); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; } });
  ipcMain.handle('photos:list', async (_e, a) => { try { return await idevice.photoList((a && a.udid) || '', (a && a.folder) || ''); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; } });
  ipcMain.handle('photos:thumb', async (_e, a) => { try { return await idevice.photoThumb((a && a.udid) || '', (a && a.folder) || '', (a && a.name) || ''); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; } });
  ipcMain.handle('photos:export', async (_e, a) => {
    try {
      const base = path.join(getDataDir(), 'Exports');
      await fsp.mkdir(base, { recursive: true });
      const pick = await dialog.showOpenDialog(mainWindow, { title: 'Export photos to…', defaultPath: base, properties: ['openDirectory', 'createDirectory'] });
      if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
      const r = await idevice.photoExport((a && a.udid) || '', (a && a.folder) || '', (a && a.names) || [], pick.filePaths[0]);
      r.dir = pick.filePaths[0];
      return r;
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('idevice:revealPath', async (_e, a) => {
    try { await shell.openPath(String((a && a.path) || '')); return { ok: true }; }
    catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('idevice:openToolsDir', async () => {
    try { const d = idevice.installDir(); await fsp.mkdir(d, { recursive: true }); await shell.openPath(d); return { ok: true, dir: d }; }
    catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  // Install tools from a .zip the tech picked manually (fallback to the Downloads page).
  ipcMain.handle('idevice:install', async () => {
    try {
      const pick = await dialog.showOpenDialog(mainWindow, {
        title: 'Select the libimobiledevice tools archive',
        properties: ['openFile'],
        filters: [{ name: 'Archives', extensions: ['zip', 'xz', 'gz', 'tar'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, canceled: true };
      const tmp = path.join(app.getPath('temp'), 'tmphone-idev-' + Date.now());
      await fsp.mkdir(tmp, { recursive: true });
      await extract(pick.filePaths[0], tmp);
      const r = await installToolsFrom(tmp);
      try { await fsp.rm(tmp, { recursive: true, force: true }); } catch {}
      return r;
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });

  let _timer = null; let _last = '';
  ipcMain.handle('idevice:watch', async (_e, a) => {
    const on = !!(a && a.on);
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (!on) return { ok: true, watching: false };
    const tick = async () => {
      try { const list = await idevice.listDevices(); const sig = list.join(','); if (sig !== _last) { _last = sig; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('idevice:devices', list); } } catch { /* ignore */ }
    };
    _timer = setInterval(tick, 2500); tick();
    return { ok: true, watching: true };
  });

  // ---- downloads page ----
  ipcMain.handle('downloads:list', async () => { try { return await loadManifest(); } catch (err) { return { dependencies: [], error: (err && err.message) || String(err) }; } });
  ipcMain.handle('downloads:openLink', async (_e, a) => { try { await shell.openExternal(String((a && a.url) || '')); return { ok: true }; } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; } });
  ipcMain.handle('downloads:install', async (_e, a) => {
    try {
      const man = await loadManifest();
      const dep = (man.dependencies || []).find((d) => d.id === (a && a.id));
      if (!dep) return { ok: false, reason: 'Unknown download.' };
      if (dep.kind === 'link') { await shell.openExternal(dep.url); return { ok: true, opened: true }; }
      // kind === 'tools': download -> verify -> extract -> install
      const tmp = path.join(app.getPath('temp'), 'tmphone-dl-' + Date.now());
      await fsp.mkdir(tmp, { recursive: true });
      const name = dep.url.split('/').pop().split('?')[0] || 'tools.archive';
      const archive = path.join(tmp, name);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:progress', { id: dep.id, phase: 'download', pct: 0 });
      await http.download(dep.url, archive, (pct) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:progress', { id: dep.id, phase: 'download', pct }); }, dep.sha256);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:progress', { id: dep.id, phase: 'install', pct: -1 });
      const exDir = path.join(tmp, 'x'); await fsp.mkdir(exDir, { recursive: true });
      await extract(archive, exDir);
      const r = await installToolsFrom(exDir);
      try { await fsp.rm(tmp, { recursive: true, force: true }); } catch {}
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:progress', { id: dep.id, phase: 'done', pct: 100 });
      return r;
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });

  // ---- self-update ----
  ipcMain.handle('update:check', async () => { try { return await updater.checkForUpdate(); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; } });
  ipcMain.handle('update:apply', async () => { try { return await updater.applyUpdate(sendUpdateProgress); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; } });

  // ---- Syncro ----
  ipcMain.handle('syncro:get', async () => config.getSyncroPublic());
  ipcMain.handle('syncro:save', async (_e, a) => config.saveSyncro(a || {}));
  ipcMain.handle('syncro:test', async (_e, a) => {
    const cur = await config.getSyncro();
    return syncro.testConnection({ subdomain: (a && a.subdomain) || cur.subdomain, token: (a && a.token) || cur.token });
  });
  ipcMain.handle('syncro:assetTypes', async () => {
    const c = await config.getSyncro();
    return syncro.listAssetTypes({ subdomain: c.subdomain, token: c.token });
  });
  ipcMain.handle('syncro:searchCustomers', async (_e, a) => {
    const c = await config.getSyncro();
    return syncro.searchCustomers({ subdomain: c.subdomain, token: c.token, query: (a && a.query) || '' });
  });
  ipcMain.handle('syncro:register', async (_e, a) => {
    const c = await config.getSyncro();
    const rec = (a && a.record) || {};
    const b = rec.battery || {}; const st = rec.storage || {}; const act = rec.activation || {};
    const props = {
      Model: rec.model, 'Model ID': rec.productType, Serial: rec.serial, IMEI: rec.imei,
      UDID: rec.udid, 'iOS Version': rec.iosVersion,
      'Battery Health %': b.healthPct != null ? String(b.healthPct) : '',
      'Battery Cycles': b.cycleCount != null ? String(b.cycleCount) : '',
      Storage: st.totalGB ? (st.freeGB + ' GB free of ' + st.totalGB + ' GB') : '',
      'Activation Lock': act.findMyKnown ? (act.findMyEnabled ? 'ON' : 'OFF') : 'unknown',
      'Phone Number': rec.phoneNumber, 'Last Checked': new Date().toISOString().slice(0, 10),
    };
    for (const k of Object.keys(props)) if (!props[k]) delete props[k];
    return syncro.registerAsset({
      subdomain: c.subdomain, token: c.token, customerId: (a && a.customerId),
      assetTypeId: c.assetTypeId, name: rec.model || 'iPhone', serial: rec.serial || rec.imei, properties: props,
    });
  });

  ipcMain.handle('syncro:openTickets', async (_e, a) => {
    const c = await config.getSyncro();
    return syncro.listOpenTickets({ subdomain: c.subdomain, token: c.token, customerId: (a && a.customerId) });
  });
  ipcMain.handle('syncro:activeTickets', async () => {
    const c = await config.getSyncro();
    return syncro.listActiveTickets({ subdomain: c.subdomain, token: c.token });
  });
  ipcMain.handle('syncro:attachTicket', async (_e, a) => {
    const c = await config.getSyncro();
    const rec = (a && a.record) || {};
    const b = rec.battery || {}; const st = rec.storage || {}; const act = rec.activation || {};
    const L = [];
    L.push('<b>TM Phone — device check</b> (' + new Date().toLocaleString() + ')');
    L.push('Model: ' + (rec.model || '') + (rec.iosVersion ? ' · iOS ' + rec.iosVersion : ''));
    if (rec.serial) L.push('Serial: ' + rec.serial);
    if (rec.imei) L.push('IMEI: ' + rec.imei);
    if (b.healthPct != null) L.push('Battery health: ' + b.healthPct + '% (' + b.verdictLabel + ')' + (b.cycleCount != null ? ', ' + b.cycleCount + ' cycles' : ''));
    if (st.totalGB) L.push('Storage: ' + st.freeGB + ' GB free of ' + st.totalGB + ' GB');
    L.push('Activation Lock: ' + (act.findMyKnown ? (act.findMyEnabled ? 'ON' : 'OFF') : 'unknown'));
    return syncro.attachToTicket({ subdomain: c.subdomain, token: c.token, ticketId: (a && a.ticketId), subject: 'TM Phone — ' + (rec.model || 'device') + ' check', body: L.join('<br>') });
  });

  ipcMain.handle('app:version', async () => app.getVersion());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040, height: 780, minWidth: 820, minHeight: 600,
    backgroundColor: '#12151c', title: 'TM Phone',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  try { app.setAppUserModelId('com.technicalmerit.tmphone'); } catch { /* ignore */ }
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
