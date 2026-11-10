'use strict';

// Remote self-update for TM Phone. Reads a manifest committed to the GitHub
// repo (update/latest.json), and if a newer version is published, downloads the
// code-only payload zip, applies it over the app's own source, and relaunches.
// Mirrors TM Toolset's updater (Releases API is blocked for this account type,
// so the manifest + payload live in the repo).

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('./httpget');
const { extract } = require('./extract');

const REPO = 'technicalmerritt/tmphone';
const BRANCH = 'main';

function cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Fetch the manifest fresh (contents API avoids CDN staleness; raw as fallback).
async function fetchManifest() {
  const apiUrl = 'https://api.github.com/repos/' + REPO + '/contents/update/latest.json?ref=' + BRANCH;
  try {
    return await http.getJson(apiUrl, { Accept: 'application/vnd.github.raw', 'User-Agent': 'TM-Phone' });
  } catch {
    const rawUrl = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/update/latest.json?t=' + Date.now();
    return await http.getJson(rawUrl);
  }
}

async function checkForUpdate() {
  const current = app.getVersion();
  let man;
  try { man = await fetchManifest(); }
  catch (err) { return { ok: false, reason: 'Could not reach the update server. ' + ((err && err.message) || '') }; }
  const latest = String(man.version || '').trim();
  if (!latest) return { ok: false, reason: 'The update manifest is missing a version.' };
  const zip = man.zip
    ? 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/update/' + man.zip
    : '';
  return {
    ok: true,
    current,
    latest,
    newer: cmpVer(latest, current) > 0,
    notes: String(man.notes || '').slice(0, 4000),
    zipUrl: zip,
  };
}

// The app's own source root (resources/app). __dirname = resources/app/src/main.
function appDir() { return path.join(__dirname, '..', '..'); }

async function copyTree(srcDir, dstDir) {
  await fsp.mkdir(dstDir, { recursive: true });
  for (const ent of await fsp.readdir(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) await copyTree(s, d);
    else await fsp.copyFile(s, d);
  }
}

async function applyUpdate(onProgress) {
  const info = await checkForUpdate();
  if (!info.ok) return { ok: false, reason: info.reason };
  if (!info.newer) return { ok: false, reason: 'already-latest', info };
  if (!info.zipUrl) return { ok: false, reason: 'The latest release has no payload attached.' };
  const tmp = path.join(app.getPath('temp'), 'tmphone-update-' + Date.now());
  await fsp.mkdir(tmp, { recursive: true });
  const zipPath = path.join(tmp, 'update.zip');
  if (onProgress) onProgress({ phase: 'download', pct: 0 });
  await http.download(info.zipUrl, zipPath, (pct) => onProgress && onProgress({ phase: 'download', pct }));
  if (onProgress) onProgress({ phase: 'extract', pct: -1 });
  const exDir = path.join(tmp, 'x');
  await fsp.mkdir(exDir, { recursive: true });
  await extract(zipPath, exDir);
  // Locate the payload root (the folder holding package.json).
  let root = exDir;
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    if (fs.existsSync(path.join(exDir, 'app', 'package.json'))) root = path.join(exDir, 'app');
    else {
      for (const ent of await fsp.readdir(exDir, { withFileTypes: true })) {
        if (ent.isDirectory() && fs.existsSync(path.join(exDir, ent.name, 'package.json'))) { root = path.join(exDir, ent.name); break; }
      }
    }
  }
  if (onProgress) onProgress({ phase: 'install', pct: -1 });
  await copyTree(root, appDir());
  try { await fsp.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  if (onProgress) onProgress({ phase: 'done', pct: 100 });
  setTimeout(() => { try { app.relaunch(); } catch { /* ignore */ } app.exit(0); }, 700);
  return { ok: true, info };
}

module.exports = { checkForUpdate, applyUpdate, REPO, BRANCH };
