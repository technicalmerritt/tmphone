'use strict';

// Archive extraction with no bundled tooling. Windows 10/11 ship PowerShell
// (Expand-Archive, for .zip) and bsdtar (tar.exe, which handles .tar / .tar.xz /
// .tar.gz). On non-Windows dev we shell out to unzip/tar.

const { execFile } = require('node:child_process');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message += '\n' + (stderr || ''); return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

// Extract `archivePath` into `destDir` (which should already exist).
async function extract(archivePath, destDir) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    if (IS_WIN) {
      const ps = 'Expand-Archive -LiteralPath ' + JSON.stringify(archivePath) + ' -DestinationPath ' + JSON.stringify(destDir) + ' -Force';
      return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    }
    return run('unzip', ['-o', archivePath, '-d', destDir]);
  }
  // .tar, .tar.xz, .tar.gz, .tgz — tar handles the compression transparently.
  if (/\.(tar(\.(xz|gz|bz2))?|tgz)$/.test(lower)) {
    return run('tar', ['-xf', archivePath, '-C', destDir]);
  }
  throw new Error('Unsupported archive type: ' + path.basename(archivePath));
}

module.exports = { extract };
