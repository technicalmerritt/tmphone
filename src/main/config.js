'use strict';

// Portable config for TM Phone (config.json in the data dir next to the app,
// so it travels on the USB stick). Holds Syncro credentials. The API token is
// base64-obfuscated (not strong encryption) so it can travel across machines —
// keep the stick physically secure.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

let _dataDir = null;
function configure({ dataDir } = {}) {
  if (typeof dataDir === 'string') _dataDir = dataDir;
  else if (typeof dataDir === 'function') { try { _dataDir = dataDir(); } catch { /* ignore */ } }
}
function file() { return path.join(_dataDir || '.', 'config.json'); }

async function readConfig() {
  try { return JSON.parse(await fsp.readFile(file(), 'utf8')); }
  catch { return {}; }
}
let _chain = Promise.resolve();
async function writeConfig(cfg) {
  const run = async () => {
    const f = file();
    const tmp = f + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    await fsp.rename(tmp, f);
  };
  _chain = _chain.then(run, run);
  return _chain;
}

const enc = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const dec = (s) => { try { return Buffer.from(String(s), 'base64').toString('utf8'); } catch { return ''; } };

async function getSyncro() {
  const c = await readConfig();
  const s = (c && c.syncro) || {};
  return { subdomain: s.subdomain || '', token: s.token ? dec(s.token) : '', assetTypeId: s.assetTypeId || null, assetTypeName: s.assetTypeName || '' };
}
async function getSyncroPublic() {
  const s = await getSyncro();
  return { subdomain: s.subdomain, hasToken: !!s.token, assetTypeId: s.assetTypeId, assetTypeName: s.assetTypeName };
}
async function saveSyncro({ subdomain, token, assetTypeId, assetTypeName } = {}) {
  const c = await readConfig();
  const cur = (c && c.syncro) || {};
  const next = { ...cur };
  if (subdomain !== undefined) next.subdomain = String(subdomain || '').trim();
  if (token === null) delete next.token;
  else if (typeof token === 'string' && token.length) next.token = enc(token);
  if (assetTypeId !== undefined) next.assetTypeId = assetTypeId;
  if (assetTypeName !== undefined) next.assetTypeName = assetTypeName;
  c.syncro = next;
  await writeConfig(c);
  return getSyncroPublic();
}

module.exports = { configure, readConfig, writeConfig, getSyncro, getSyncroPublic, saveSyncro };
