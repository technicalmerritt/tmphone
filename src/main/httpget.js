'use strict';

// Tiny HTTPS helper with redirect-following, used by the updater and the
// dependency downloader. Node's https does not follow redirects on its own, and
// GitHub release/raw URLs redirect to codeload/objects, so we handle 3xx here.

const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');

function get(url, opts, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = 6;
  return new Promise((resolve, reject) => {
    const req = https.get(url, Object.assign({ headers: { 'User-Agent': 'TM-Phone' } }, opts || {}), (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const next = new URL(headers.location, url).toString();
        return resolve(get(next, opts, redirectsLeft - 1));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
  });
}

async function getText(url, headers) {
  const res = await get(url, { headers: Object.assign({ 'User-Agent': 'TM-Phone' }, headers || {}) });
  if (res.statusCode !== 200) { res.resume(); throw new Error('HTTP ' + res.statusCode + ' for ' + url); }
  return await new Promise((resolve, reject) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (data += c));
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
}

async function getJson(url, headers) {
  return JSON.parse(await getText(url, headers));
}

// Download to a file, optionally reporting progress and verifying a sha256.
async function download(url, destPath, onProgress, expectSha256) {
  const res = await get(url, { headers: { 'User-Agent': 'TM-Phone' } });
  if (res.statusCode !== 200) { res.resume(); throw new Error('HTTP ' + res.statusCode + ' downloading ' + url); }
  const total = parseInt(res.headers['content-length'] || '0', 10);
  const hash = crypto.createHash('sha256');
  let got = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.on('data', (chunk) => {
      got += chunk.length;
      hash.update(chunk);
      if (onProgress && total) { try { onProgress(Math.round((got / total) * 100), got, total); } catch { /* ignore */ } }
    });
    res.pipe(out);
    out.on('finish', () => out.close(resolve));
    out.on('error', reject);
    res.on('error', reject);
  });
  const digest = hash.digest('hex');
  if (expectSha256 && digest.toLowerCase() !== String(expectSha256).toLowerCase()) {
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    throw new Error('Checksum mismatch — download rejected (expected ' + expectSha256 + ', got ' + digest + ').');
  }
  return { bytes: got, sha256: digest };
}

module.exports = { get, getText, getJson, download };
