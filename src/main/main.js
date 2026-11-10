'use strict';

// TM Phone — standalone iOS/iPadOS diagnostics for the repair bench.
// A lean Electron app: read a connected iPhone/iPad over USB (via the
// open-source libimobiledevice tools) and show identity, battery health,
// storage, software and Activation-Lock status. No licence gate — internal tool.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const idevice = require('./idevice/idevice');

let mainWindow = null;

// ---- Portable data dir: prefer a folder next to the executable (travels on a
// USB stick), fall back to per-user appdata. Mirrors TM Toolset. ----
let _dataDir = null;
function getDataDir() {
  if (_dataDir) return _dataDir;
  const candidates = [];
  try { candidates.push(path.join(path.dirname(process.execPath), 'TM-Phone-Data')); } catch { /* ignore */ }
  try { candidates.push(app.getPath('userData')); } catch { /* ignore */ }
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.writetest');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      _dataDir = dir;
      return dir;
    } catch { /* not writable, try next */ }
  }
  _dataDir = app.getPath('userData');
  return _dataDir;
}

idevice.configure({ dataDir: getDataDir() });

// Extract a zip with no bundled tooling: Windows ships PowerShell Expand-Archive
// (and tar). On non-Windows dev, fall back to the system `unzip`.
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const ps = 'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) + ' -DestinationPath ' + JSON.stringify(destDir) + ' -Force';
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err) => err ? reject(err) : resolve());
    } else {
      execFile('unzip', ['-o', zipPath, '-d', destDir], (err) => err ? reject(err) : resolve());
    }
  });
}

function registerIpc() {
  ipcMain.handle('idevice:status', async () => {
    try { return await idevice.status(); }
    catch (err) { return { toolsPresent: false, message: (err && err.message) || String(err), devices: [] }; }
  });
  ipcMain.handle('idevice:read', async (_evt, args) => {
    try { return await idevice.readDevice((args && args.udid) || ''); }
    catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('idevice:crash', async (_evt, args) => {
    try {
      const out = path.join(app.getPath('temp'), 'tmphone-crash-' + Date.now());
      await fsp.mkdir(out, { recursive: true });
      return await idevice.crashReports((args && args.udid) || '', out);
    } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });
  ipcMain.handle('idevice:install', async () => {
    try {
      const pick = await dialog.showOpenDialog(mainWindow, {
        title: 'Select the libimobiledevice tools (.zip)',
        properties: ['openFile'],
        filters: [{ name: 'Zip archive', extensions: ['zip'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, canceled: true };
      const tmp = path.join(app.getPath('temp'), 'tmphone-idev-' + Date.now());
      await fsp.mkdir(tmp, { recursive: true });
      await extractZip(pick.filePaths[0], tmp);
      const found = [];
      const walk = async (d) => {
        for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) await walk(p);
          else if (/\.(exe|dll)$/i.test(ent.name)) found.push(p);
        }
      };
      await walk(tmp);
      if (!found.length) { try { await fsp.rm(tmp, { recursive: true, force: true }); } catch {} return { ok: false, reason: 'No .exe/.dll files were found in that archive.' }; }
      const dest = idevice.installDir();
      await fsp.mkdir(dest, { recursive: true });
      for (const f of found) await fsp.copyFile(f, path.join(dest, path.basename(f)));
      try { await fsp.rm(tmp, { recursive: true, force: true }); } catch {}
      const verify = idevice.verifyDir(dest);
      return { ok: verify.ok, installed: found.length, dest, missing: verify.missing };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('idevice:openToolsDir', async () => {
    try { const d = idevice.installDir(); await fsp.mkdir(d, { recursive: true }); await shell.openPath(d); return { ok: true, dir: d }; }
    catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  });

  let _timer = null; let _last = '';
  ipcMain.handle('idevice:watch', async (_evt, args) => {
    const on = !!(args && args.on);
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (!on) return { ok: true, watching: false };
    const tick = async () => {
      try {
        const list = await idevice.listDevices();
        const sig = list.join(',');
        if (sig !== _last) { _last = sig; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('idevice:devices', list); }
      } catch { /* ignore */ }
    };
    _timer = setInterval(tick, 2500); tick();
    return { ok: true, watching: true };
  });

  ipcMain.handle('app:version', async () => app.getVersion());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040, height: 760, minWidth: 820, minHeight: 600,
    backgroundColor: '#12151c',
    title: 'TM Phone',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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
