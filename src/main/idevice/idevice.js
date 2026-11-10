'use strict';

// Main-process runner for Apple (iOS/iPadOS) devices over USB.
//
// It shells out to the open-source libimobiledevice tools. Those tools are NOT
// bundled with the code-only update (and we deliberately do not auto-download
// unverified third-party binaries). Instead the runner looks for them in, in
// order:
//   1. <portable data dir>/idevice-bin   — installed by the technician from a
//      vetted copy; travels on the USB stick.
//   2. <this folder>/bin                 — present only in a full portable build.
// Everything degrades gracefully: if the tools or Apple's Mobile Device driver
// aren't present, status() reports it cleanly so the UI can guide setup.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const parse = require('./idevice-parse');

// Pure-JS HEIC decoder, lazily loaded so the app still runs if it's absent
// (e.g. an install that self-updated the code but not node_modules).
let _heic = null, _heicTried = false;
function heicConvert() {
  if (!_heicTried) { _heicTried = true; try { _heic = require('heic-convert'); } catch { _heic = null; } }
  return _heic;
}

const IS_WIN = process.platform === 'win32';

// Injected by main.js so we can place/read tools in the portable data dir.
let _dataDir = null;
function configure({ dataDir } = {}) {
  if (typeof dataDir === 'string') _dataDir = dataDir;
  else if (typeof dataDir === 'function') { try { _dataDir = dataDir(); } catch { /* ignore */ } }
}

// The portable install target (where "Install from file" puts the tools).
function installDir() {
  return _dataDir ? path.join(_dataDir, 'idevice-bin') : path.join(__dirname, 'bin');
}
const bundledDir = () => path.join(__dirname, 'bin');

function exe(name) { return IS_WIN ? name + '.exe' : name; }

// Essentials needed for the core read; the rest enable extra features.
const ESSENTIAL = ['idevice_id', 'ideviceinfo', 'idevicediagnostics'];
const OPTIONAL = ['idevicecrashreport', 'idevicebackup2', 'idevicesyslog'];

// First directory that actually contains the essential tools.
function resolveToolDir() {
  for (const dir of [installDir(), bundledDir()]) {
    try { if (fs.existsSync(path.join(dir, exe('ideviceinfo')))) return dir; } catch { /* ignore */ }
  }
  return null;
}

function toolPath(dir, name) { return path.join(dir, exe(name)); }

function toolsPresent() { return resolveToolDir() !== null; }

// What's present/missing in a given directory (for the installer's report).
function verifyDir(dir) {
  const missing = [];
  for (const t of ESSENTIAL) {
    try { if (!fs.existsSync(path.join(dir, exe(t)))) missing.push(t); } catch { missing.push(t); }
  }
  return { ok: missing.length === 0, missing, essential: ESSENTIAL, optional: OPTIONAL };
}

// Promise wrapper around execFile with a timeout and tidy result.
function run(dir, name, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let file = toolPath(dir, name);
    if (!IS_WIN && !fs.existsSync(file)) file = name; // dev fallback (PATH)
    execFile(file, args || [], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: stdout ? stdout.toString() : '',
        stderr: stderr ? stderr.toString() : '',
        timedOut: !!(err && err.killed),
        missing: !!(err && err.code === 'ENOENT'),
      });
    });
  });
}

async function listDevices() {
  const dir = resolveToolDir();
  if (!dir) return [];
  const r = await run(dir, 'idevice_id', ['-l'], 8000);
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function infoRaw(dir, udid, domain) {
  const args = [];
  if (udid) args.push('-u', udid);
  if (domain) args.push('-q', domain);
  const r = await run(dir, 'ideviceinfo', args, 15000);
  return r.ok ? r.stdout : '';
}

async function batteryIoreg(dir, udid) {
  for (const cls of ['AppleSmartBattery', 'AppleARMPMUCharger']) {
    const args = [];
    if (udid) args.push('-u', udid);
    args.push('ioregistry', cls);
    const r = await run(dir, 'idevicediagnostics', args, 12000);
    if (r.ok && /DesignCapacity|AppleRawMaxCapacity|CycleCount/.test(r.stdout)) return r.stdout;
  }
  return '';
}

async function readDevice(udid) {
  const dir = resolveToolDir();
  if (!dir) return { ok: false, reason: 'Apple device tools are not installed. Use “Install from file…” in this tab.' };
  const info = await infoRaw(dir, udid, '');
  if (!info) {
    return { ok: false, reason: 'The device did not respond. Make sure it is unlocked and you have tapped “Trust This Computer”.' };
  }
  const [disk, batteryDomain, fmip, ioreg] = await Promise.all([
    infoRaw(dir, udid, 'com.apple.disk_usage'),
    infoRaw(dir, udid, 'com.apple.mobile.battery'),
    infoRaw(dir, udid, 'com.apple.fmip'),
    batteryIoreg(dir, udid),
  ]);
  const built = parse.buildRecord({ info, disk, batteryDomain, fmip, batteryIoreg: ioreg });
  built.ok = true;
  built.udid = udid;
  return built;
}

async function crashReports(udid, outDir) {
  const dir = resolveToolDir();
  if (!dir) return { ok: false, reason: 'Tools not installed.' };
  const r = await run(dir, 'idevicecrashreport', ['-u', udid || '', outDir].filter(Boolean), 30000);
  const hits = [];
  try {
    if (fs.existsSync(outDir)) {
      for (const f of fs.readdirSync(outDir)) {
        if (/\.(panic|ips)$/i.test(f)) {
          const txt = fs.readFileSync(path.join(outDir, f), 'utf8');
          const t = parse.triagePanic(txt);
          if (t.length) hits.push({ file: f, hints: t });
        }
      }
    }
  } catch { /* ignore */ }
  return { ok: r.ok, hints: hits };
}

// Full device backup via idevicebackup2 (same format iTunes/Finder makes).
// Long-running, so we stream progress lines to onProgress instead of buffering.
function backupDevice(udid, destDir, onProgress) {
  return new Promise((resolve) => {
    const dir = resolveToolDir();
    if (!dir) return resolve({ ok: false, reason: 'Apple device tools are not installed.' });
    const file = toolPath(dir, 'idevicebackup2');
    if (IS_WIN && !fs.existsSync(file)) {
      return resolve({ ok: false, reason: 'idevicebackup2 is not in your installed tools. Reinstall the tools from the Downloads tab.' });
    }
    const args = [];
    if (udid) args.push('-u', udid);
    args.push('backup', '--full', destDir);
    let p;
    try { p = spawn(IS_WIN ? file : 'idevicebackup2', args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, reason: (e && e.message) || String(e) }); }
    let lastLine = '';
    const onData = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        lastLine = t;
        const m = /(\d+)(?:\.\d+)?%/.exec(t);
        if (onProgress) { try { onProgress({ pct: m ? parseInt(m[1], 10) : -1, line: t }); } catch { /* ignore */ } }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => resolve({ ok: false, reason: (e && e.message) || String(e) }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true, dir: destDir });
      else resolve({ ok: false, reason: 'Backup did not finish (exit ' + code + '). ' + lastLine });
    });
  });
}

// Restore a backup back onto the device (companion to backupDevice). Streams
// progress like backup. srcDir is the folder that was chosen for the backup
// (the one containing the UDID subfolder).
function restoreDevice(udid, srcDir, onProgress) {
  return new Promise((resolve) => {
    const dir = resolveToolDir();
    if (!dir) return resolve({ ok: false, reason: 'Apple device tools are not installed.' });
    const file = toolPath(dir, 'idevicebackup2');
    if (IS_WIN && !fs.existsSync(file)) {
      return resolve({ ok: false, reason: 'idevicebackup2 is not in your installed tools. Reinstall the tools from the Downloads tab.' });
    }
    const args = [];
    if (udid) args.push('-u', udid);
    // --system restores system files too; --settings keeps settings; --reboot
    // reboots when done. Keep it to the safe default set.
    args.push('restore', '--settings', '--reboot', srcDir);
    let p;
    try { p = spawn(IS_WIN ? file : 'idevicebackup2', args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, reason: (e && e.message) || String(e) }); }
    let lastLine = '';
    const onData = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        lastLine = t;
        const m = /(\d+)(?:\.\d+)?%/.exec(t);
        if (onProgress) { try { onProgress({ pct: m ? parseInt(m[1], 10) : -1, line: t }); } catch { /* ignore */ } }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => resolve({ ok: false, reason: (e && e.message) || String(e) }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, reason: 'Restore did not finish (exit ' + code + '). ' + lastLine });
    });
  });
}

// ---------------------------------------------------------------------------
// ERASE / FLASH (wipe) via idevicerestore — the open-source implementation of
// Apple's restore protocol (the same foundation 3uTools' flasher is built on).
// HIGH RISK: a failed flash can leave a device in recovery/DFU, and wiping a
// device with Find My ON creates an Activation-Locked brick. Callers MUST gate
// on Activation Lock and explicit confirmation before calling this.
// ---------------------------------------------------------------------------

// Best-effort live Find My / Activation Lock read, used as a safety pre-check.
async function findMyStatus(udid) {
  const dir = resolveToolDir();
  if (!dir) return { known: false, enabled: false };
  const fmip = parse.parseKeyValue(await infoRaw(dir, udid, 'com.apple.fmip'));
  const info = parse.parseKeyValue(await infoRaw(dir, udid, ''));
  const a = parse.interpretActivation(info, fmip);
  return { known: a.findMyKnown, enabled: a.findMyEnabled, activationState: a.activationState };
}

function hasRestoreTool() {
  const dir = resolveToolDir();
  if (!dir) return false;
  try { return fs.existsSync(toolPath(dir, 'idevicerestore')); } catch { return false; }
}

// Erase-restore the device. opts: { ipsw: <path>|null (null = download latest
// signed firmware), confirmedFindMyOff: bool }. Streams progress lines.
function wipeDevice(udid, opts, onProgress) {
  opts = opts || {};
  return new Promise((resolve) => {
    const dir = resolveToolDir();
    if (!dir) return resolve({ ok: false, reason: 'Apple device tools are not installed.' });
    const file = toolPath(dir, 'idevicerestore');
    if (IS_WIN && !fs.existsSync(file)) {
      return resolve({ ok: false, reason: 'idevicerestore is not in your installed tools suite, so flashing is unavailable. (Reinstall the tools from the Downloads tab — if it still isn\'t there, that build doesn\'t include it.)' });
    }
    // idevicerestore: -e erase, -l download latest signed firmware, -u <udid>.
    const args = [];
    if (udid) args.push('-u', udid);
    args.push('-e');
    if (opts.ipsw) args.push(opts.ipsw); else args.push('-l');
    let p;
    try { p = spawn(IS_WIN ? file : 'idevicerestore', args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, reason: (e && e.message) || String(e) }); }
    let lastLine = '';
    const onData = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        lastLine = t;
        const m = /(\d+)(?:\.\d+)?%/.exec(t);
        if (onProgress) { try { onProgress({ pct: m ? parseInt(m[1], 10) : -1, line: t }); } catch { /* ignore */ } }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => resolve({ ok: false, reason: (e && e.message) || String(e) }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, reason: 'Flash did not complete (exit ' + code + '). ' + lastLine });
    });
  });
}

// ---------------------------------------------------------------------------
// PHOTOS — browse the camera roll (DCIM) over AFC and pull/convert images.
// DCIM holds folders like 100APPLE/101APPLE (iOS storage buckets); that's the
// "folders" view 3uTools shows. Uses afcclient from the tools suite.
// ---------------------------------------------------------------------------
const IMG_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'tiff', 'webp'];
const VID_EXT = ['mov', 'mp4', 'm4v', 'avi'];

function afcPresent() {
  const dir = resolveToolDir();
  if (!dir) return false;
  try { return fs.existsSync(toolPath(dir, 'afcclient')); } catch { return false; }
}

async function afcLs(udid, remotePath) {
  const dir = resolveToolDir();
  if (!dir) return { ok: false, reason: 'tools missing', entries: [] };
  if (!afcPresent()) return { ok: false, reason: 'afcclient is not in your installed tools suite.', entries: [] };
  const args = [];
  if (udid) args.push('-u', udid);
  args.push('ls', remotePath);
  const r = await run(dir, 'afcclient', args, 20000);
  if (!r.ok) return { ok: false, reason: r.stderr || r.stdout || 'listing failed', entries: [] };
  const entries = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== '.' && s !== '..');
  return { ok: true, entries };
}

// DCIM subfolders (100APPLE, 101APPLE, …).
async function photoFolders(udid) {
  const r = await afcLs(udid, '/DCIM');
  if (!r.ok) return r;
  // Entries that look like storage buckets or any folder (afcclient ls lists names only).
  return { ok: true, folders: r.entries.filter((e) => !/\.[a-z0-9]+$/i.test(e)) };
}

function extOf(name) { const m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toLowerCase() : ''; }

async function photoList(udid, folder) {
  const r = await afcLs(udid, '/DCIM/' + folder);
  if (!r.ok) return r;
  const files = r.entries
    .map((name) => ({ name, ext: extOf(name) }))
    .filter((f) => IMG_EXT.includes(f.ext) || VID_EXT.includes(f.ext))
    .map((f) => ({ name: f.name, type: VID_EXT.includes(f.ext) ? 'video' : 'image', ext: f.ext }));
  return { ok: true, files };
}

async function afcGet(udid, remotePath, localPath) {
  const dir = resolveToolDir();
  const args = [];
  if (udid) args.push('-u', udid);
  args.push('get', remotePath, localPath);
  return run(dir, 'afcclient', args, 120000);
}

// Pull one image and return a data URL thumbnail (HEIC is decoded to JPEG).
async function photoThumb(udid, folder, name) {
  const ext = extOf(name);
  if (VID_EXT.includes(ext)) return { ok: true, video: true };
  const tmp = path.join(os.tmpdir(), 'tmphone-th-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext);
  try {
    const r = await afcGet(udid, '/DCIM/' + folder + '/' + name, tmp);
    if ((!r.ok) || !fs.existsSync(tmp)) return { ok: false, reason: (r && (r.stderr || r.stdout)) || 'pull failed' };
    let buf = await fsp.readFile(tmp);
    let mime = 'image/jpeg';
    if (ext === 'heic' || ext === 'heif') {
      const conv = heicConvert();
      if (!conv) return { ok: false, noDecoder: true };
      buf = await conv({ buffer: buf, format: 'JPEG', quality: 0.4 });
    } else if (ext === 'png') mime = 'image/png';
    else if (ext === 'gif') mime = 'image/gif';
    else if (ext === 'webp') mime = 'image/webp';
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// Export selected files (originals, unconverted) to a local folder.
async function photoExport(udid, folder, names, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  let done = 0; const failed = [];
  for (const name of names) {
    const r = await afcGet(udid, '/DCIM/' + folder + '/' + name, path.join(destDir, name));
    if (r.ok) done++; else failed.push(name);
  }
  return { ok: failed.length === 0, exported: done, failed };
}

async function status() {
  const dir = resolveToolDir();
  if (!dir) {
    return {
      toolsPresent: false,
      installDir: installDir(),
      message: 'Apple device tools are not installed yet. Install them from a vetted copy to start reading devices.',
      devices: [],
    };
  }
  const idList = await run(dir, 'idevice_id', ['-l'], 8000);
  if (idList.missing) {
    return { toolsPresent: false, installDir: installDir(), message: 'Apple device tools are missing.', devices: [] };
  }
  // idevice_id works but errors often mean Apple's Mobile Device driver is absent.
  const driverLikelyMissing = !idList.ok && /muxd|connect|usbmux|service/i.test(idList.stderr || '');
  const udids = idList.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return {
    toolsPresent: true,
    toolDir: dir,
    driverOk: !driverLikelyMissing,
    devices: udids,
    message: driverLikelyMissing
      ? 'Tools are installed, but Apple’s Mobile Device driver seems to be missing. Install iTunes or the “Apple Devices” app.'
      : (udids.length ? '' : 'No device detected. Connect an iPhone/iPad, unlock it, and tap “Trust”.'),
  };
}

module.exports = {
  configure, status, listDevices, readDevice, crashReports, backupDevice, restoreDevice,
  wipeDevice, findMyStatus, hasRestoreTool,
  afcPresent, photoFolders, photoList, photoThumb, photoExport,
  toolsPresent, resolveToolDir, verifyDir, installDir, bundledDir,
  ESSENTIAL, OPTIONAL,
};
