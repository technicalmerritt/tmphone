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
const { execFile, spawn } = require('node:child_process');
const parse = require('./idevice-parse');

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
  configure, status, listDevices, readDevice, crashReports, backupDevice,
  toolsPresent, resolveToolDir, verifyDir, installDir, bundledDir,
  ESSENTIAL, OPTIONAL,
};
