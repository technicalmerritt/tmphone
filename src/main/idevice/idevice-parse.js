'use strict';

// Pure parsing + analysis for Apple (iOS/iPadOS) devices read over USB via the
// libimobiledevice tools. NO I/O here — everything takes raw tool output as a
// string and returns structured data, so it is fully unit-testable without a
// device present. The main-process runner (idevice.js) shells out to the tools
// and feeds their stdout into these functions.

// ---------------------------------------------------------------------------
// Low-level output parsers
// ---------------------------------------------------------------------------

// `ideviceinfo` prints "Key: Value" lines (one per property). Domain queries
// (-q <domain>) print the same shape. Values can contain colons, so split once.
function parseKeyValue(text) {
  const out = {};
  if (!text) return out;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

// `idevicediagnostics ioregistry <Class>` prints an XML plist. We only need
// flat <key>/<value> pairs, so a light regex walk is enough (and avoids pulling
// in an XML dependency). Handles integer, real, string, true/false.
function parsePlistFlat(xml) {
  const out = {};
  if (!xml) return out;
  const re = /<key>([^<]+)<\/key>\s*(?:<(integer|real|string)>([^<]*)<\/\2>|<(true|false)\s*\/>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1];
    if (m[2] === 'integer') out[key] = parseInt(m[3], 10);
    else if (m[2] === 'real') out[key] = parseFloat(m[3]);
    else if (m[2] === 'string') out[key] = m[3];
    else if (m[4]) out[key] = m[4] === 'true';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Marketing names: ProductType ("iPhone14,5") -> "iPhone 13"
// Covers the models a repair shop realistically sees. Unknown types fall back
// to the raw identifier so nothing ever shows blank.
// ---------------------------------------------------------------------------
const MODEL_NAMES = {
  // iPhone
  'iPhone8,1': 'iPhone 6s', 'iPhone8,2': 'iPhone 6s Plus', 'iPhone8,4': 'iPhone SE (1st gen)',
  'iPhone9,1': 'iPhone 7', 'iPhone9,3': 'iPhone 7', 'iPhone9,2': 'iPhone 7 Plus', 'iPhone9,4': 'iPhone 7 Plus',
  'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8', 'iPhone10,2': 'iPhone 8 Plus', 'iPhone10,5': 'iPhone 8 Plus',
  'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X',
  'iPhone11,8': 'iPhone XR', 'iPhone11,2': 'iPhone XS', 'iPhone11,6': 'iPhone XS Max', 'iPhone11,4': 'iPhone XS Max',
  'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone12,8': 'iPhone SE (2nd gen)',
  'iPhone13,1': 'iPhone 12 mini', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,6': 'iPhone SE (3rd gen)',
  'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus', 'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus', 'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus', 'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max',
  'iPhone17,5': 'iPhone 16e',
  // iPad (common)
  'iPad7,11': 'iPad (7th gen)', 'iPad11,6': 'iPad (8th gen)', 'iPad12,1': 'iPad (9th gen)', 'iPad13,18': 'iPad (10th gen)',
  'iPad11,1': 'iPad mini (5th gen)', 'iPad14,1': 'iPad mini (6th gen)',
  'iPad13,1': 'iPad Air (4th gen)', 'iPad13,16': 'iPad Air (5th gen)',
  'iPad8,1': 'iPad Pro 11" (1st gen)', 'iPad13,4': 'iPad Pro 11" (3rd gen)',
};

function friendlyModel(productType, fallbackName) {
  if (productType && MODEL_NAMES[productType]) return MODEL_NAMES[productType];
  if (fallbackName) return fallbackName;
  return productType || 'Apple device';
}

// Capacity colour/storage helpers
function bytesToGB(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round((v / 1e9) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Battery health — the headline repair/condition metric.
// AppleSmartBattery ioregistry gives DesignCapacity, AppleRawMaxCapacity
// (a.k.a. the real full-charge capacity) and CycleCount. Health is the ratio
// iMazing/CoconutBattery report: MaxCapacity / DesignCapacity.
// ---------------------------------------------------------------------------
function batteryHealth(raw) {
  raw = raw || {};
  const design = Number(raw.DesignCapacity) || 0;
  // Prefer the "nominal"/raw max capacity; fall back to MaxCapacity if present.
  const full = Number(raw.AppleRawMaxCapacity) || Number(raw.NominalChargeCapacity) || Number(raw.MaxCapacity) || 0;
  const cycles = Number(raw.CycleCount);
  const out = {
    designCapacity: design || null,
    fullChargeCapacity: full || null,
    cycleCount: Number.isFinite(cycles) ? cycles : null,
    healthPct: null,
    verdict: 'unknown',
    verdictLabel: 'Unknown',
    reason: '',
  };
  if (design > 0 && full > 0) {
    let pct = Math.round((full / design) * 100);
    if (pct > 100) pct = 100; // a fresh battery can read slightly over design
    out.healthPct = pct;
    if (pct >= 85) { out.verdict = 'good'; out.verdictLabel = 'Good'; out.reason = 'Battery is in healthy condition.'; }
    else if (pct >= 80) { out.verdict = 'fair'; out.verdictLabel = 'Fair'; out.reason = 'Battery is nearing the point where a replacement is worth offering.'; }
    else { out.verdict = 'service'; out.verdictLabel = 'Replace'; out.reason = 'Maximum capacity is below 80% — a replacement will noticeably improve runtime.'; }
  }
  return out;
}

// Rated cycle life: older iPhones ~500, iPhone 15 and later ~1000.
function ratedCycles(productType) {
  const m = /iPhone(\d+),/.exec(productType || '');
  if (m && parseInt(m[1], 10) >= 16) return 1000; // iPhone 15 (iPhone16,x) and newer
  return 500;
}

// ---------------------------------------------------------------------------
// Approximate manufacture age from an old-style 11/12-char serial.
// Apple's pre-2021 serials encode year-half + week in chars 4-5. Newer serials
// are fully randomised, so this is best-effort and clearly flagged as such.
// ---------------------------------------------------------------------------
function estimateAgeFromSerial(serial) {
  if (!serial || typeof serial !== 'string') return null;
  const s = serial.trim().toUpperCase();
  if (s.length !== 11 && s.length !== 12) return null; // new random serials: can't tell
  const yearChars = 'CDFGHJKLMNPQRSTVWXYZ'; // Apple's alphabet (no vowels/ambiguous)
  const y = s.charAt(3), w = s.charAt(4);
  const yi = yearChars.indexOf(y);
  if (yi < 0) return null;
  // Each letter = a half-year from 2010 H1.
  const year = 2010 + Math.floor(yi / 2);
  const half = yi % 2; // 0 = weeks 1-26, 1 = weeks 27-52
  const wk = '0123456789CDFGHJKLMNPQRSTVWXYZ'.indexOf(w);
  if (wk < 0) return null;
  const week = half * 26 + Math.min(wk, 26) + 1;
  if (year < 2010 || year > 2021) return null; // outside the encodable range
  return { year, approxWeek: week, confidence: 'approximate' };
}

// ---------------------------------------------------------------------------
// Activation Lock / Find My interpretation. Over USB this is only partially
// determinable, so we are deliberate about "unknown" rather than guessing.
// ---------------------------------------------------------------------------
function interpretActivation(info, fmip) {
  info = info || {};
  fmip = fmip || {};
  const activationState = info.ActivationState || '';
  // fmip domain sometimes exposes a flag; names vary by iOS, so check a few.
  let findMy = null;
  for (const k of ['HasFMIP', 'IsAssociated', 'FMIPEnabled']) {
    if (typeof fmip[k] === 'boolean') { findMy = fmip[k]; break; }
    if (fmip[k] === 'true' || fmip[k] === 'false') { findMy = fmip[k] === 'true'; break; }
  }
  return {
    activationState,
    activated: /^Activated$/i.test(activationState),
    findMyKnown: findMy !== null,
    findMyEnabled: findMy === true,
  };
}

// ---------------------------------------------------------------------------
// Crash/panic log triage. idevicecrashreport pulls .ips/.panic files; we just
// summarise filenames + any panic signature lines a caller passes in.
// ---------------------------------------------------------------------------
const PANIC_SIGNATURES = [
  { re: /watchdog|wdt timeout/i, hint: 'Watchdog timeout — often a SoC/power rail or a wedged driver.' },
  { re: /thermal/i, hint: 'Thermal event — overheating or a shorted component drawing excess current.' },
  { re: /\bPMU\b|power ?manager/i, hint: 'Power-management fault — inspect the PMIC/charging circuit.' },
  { re: /GPU|SGX|AGX/i, hint: 'Graphics subsystem fault.' },
  { re: /NAND|AppleNAND|storage controller/i, hint: 'Storage controller / NAND fault.' },
  { re: /baseband|CommCenter/i, hint: 'Baseband/cellular fault — check the modem and its rails.' },
];

function triagePanic(text) {
  const hits = [];
  if (text) {
    for (const sig of PANIC_SIGNATURES) {
      if (sig.re.test(text)) hits.push(sig.hint);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Overall analysis: turn the collected device data into scored findings,
// mirroring the PC issues-scan shape (severity/category/title/...), so the UI
// can render both consistently.
// ---------------------------------------------------------------------------
const LATEST_MAJOR_IOS = 18; // update occasionally; only used for a soft "behind" hint

function analyzeDevice(d) {
  d = d || {};
  const info = d.info || {};
  const bat = d.battery || {};
  const storage = d.storage || {};
  const act = d.activation || {};
  const findings = [];
  const add = (severity, category, title, summary, opts = {}) =>
    findings.push({ severity, category, title, summary, recommendation: opts.recommendation || '', detail: opts.detail || '' });

  // Battery
  if (bat.healthPct != null) {
    if (bat.verdict === 'service') {
      add('warning', 'Battery', `Battery at ${bat.healthPct}% capacity`, bat.reason, { recommendation: 'Offer a battery replacement; show the customer the capacity and cycle count.' });
    } else if (bat.verdict === 'fair') {
      add('info', 'Battery', `Battery at ${bat.healthPct}% capacity`, bat.reason, { recommendation: 'Mention it is on the way down so there are no surprises.' });
    } else {
      add('ok', 'Battery', `Battery healthy (${bat.healthPct}%)`, bat.reason);
    }
  }
  if (bat.cycleCount != null) {
    const rated = ratedCycles(info.ProductType);
    if (bat.cycleCount >= rated) {
      add('info', 'Battery', `High cycle count (${bat.cycleCount})`, `Past the ~${rated}-cycle design rating for this model.`, { recommendation: 'Expect reduced capacity; a replacement resets this.' });
    }
  }

  // Storage
  if (storage.totalGB && storage.freeGB != null) {
    const freePct = storage.totalGB > 0 ? Math.round((storage.freeGB / storage.totalGB) * 100) : 100;
    if (freePct <= 5 || storage.freeGB < 1) {
      add('warning', 'Storage', 'Storage almost full', `${storage.freeGB} GB free of ${storage.totalGB} GB (${freePct}%). iOS updates and photos will fail.`, { recommendation: 'Clear space (offload apps, clear photos/caches) before updating or backing up.' });
    } else if (freePct <= 12) {
      add('info', 'Storage', 'Storage getting low', `${storage.freeGB} GB free of ${storage.totalGB} GB (${freePct}%).`);
    }
  }

  // Software / OS currency
  const major = parseInt((info.ProductVersion || '').split('.')[0], 10);
  if (Number.isFinite(major) && major > 0) {
    if (LATEST_MAJOR_IOS - major >= 2) {
      add('warning', 'Software', `iOS ${info.ProductVersion} is well behind`, `This device is on iOS ${major}; current is iOS ${LATEST_MAJOR_IOS}. It is missing security fixes.`, { recommendation: 'Update iOS (Settings → General → Software Update), storage permitting.' });
    } else if (LATEST_MAJOR_IOS - major === 1) {
      add('info', 'Software', `iOS ${info.ProductVersion} is one major behind`, 'A newer iOS is available.', { recommendation: 'Offer to update while it is on the bench.' });
    }
  }

  // Jailbreak hint (Cydia/unc0ver residue shows via installed apps elsewhere;
  // here we flag the simple signal if the caller set it).
  if (d.jailbroken === true) {
    add('warning', 'Security', 'Jailbreak detected', 'Third-party/unsigned software is present.', { recommendation: 'Factor this in before updating or restoring; it affects warranty and stability.' });
  }

  // Activation Lock / Find My — the resale/repair gatekeeper.
  if (act.findMyKnown && act.findMyEnabled) {
    add('critical', 'Ownership', 'Find My / Activation Lock is ON', 'This device is tied to an Apple ID. It cannot be wiped or resold without the owner signing out.', { recommendation: 'Have the owner turn off Find My (Settings → [name] → Find My) before any erase/resale.' });
  } else if (!act.activated) {
    add('info', 'Ownership', 'Device not activated', `Activation state: ${act.activationState || 'unknown'}.`, { recommendation: 'Confirm the device is set up and signed in before relying on other readings.' });
  } else if (!act.findMyKnown) {
    add('info', 'Ownership', 'Find My status not readable over USB', 'Could not confirm Activation Lock from the cable.', { recommendation: 'Verify in Settings → [name] → Find My before any erase or resale.' });
  }

  // Trust / passcode
  if (info.PasswordProtected === 'true' || info.PasswordProtected === true) {
    add('ok', 'Security', 'Passcode set', 'Device has a passcode (data is encrypted at rest).');
  }

  // Score mirrors the PC scan (lightweight)
  const weight = { critical: 22, warning: 9, info: 0, ok: 0 };
  let penalty = 0;
  const counts = { critical: 0, warning: 0, info: 0, ok: 0 };
  for (const f of findings) { counts[f.severity]++; penalty += weight[f.severity] || 0; }
  const order = { critical: 0, warning: 1, info: 2, ok: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return { findings, counts, score: Math.max(0, Math.min(100, 100 - penalty)) };
}

// ---------------------------------------------------------------------------
// Build a single tidy "device record" from the raw tool outputs, ready for the
// UI and (later) for pushing to Syncro as an asset.
// ---------------------------------------------------------------------------
function buildRecord(raw) {
  raw = raw || {};
  const info = parseKeyValue(raw.info);
  const disk = parseKeyValue(raw.disk);
  const batDomain = parseKeyValue(raw.batteryDomain);
  const batRaw = parsePlistFlat(raw.batteryIoreg);
  const fmip = parseKeyValue(raw.fmip);

  const battery = batteryHealth(batRaw);
  if (batDomain.BatteryCurrentCapacity) battery.currentPct = parseInt(batDomain.BatteryCurrentCapacity, 10);
  if (batDomain.BatteryIsCharging) battery.charging = batDomain.BatteryIsCharging === 'true';

  const storage = {
    totalGB: bytesToGB(disk.TotalDiskCapacity || disk.TotalDataCapacity),
    freeGB: bytesToGB(disk.TotalDataAvailable),
  };
  if (storage.totalGB && storage.freeGB != null) storage.usedGB = Math.max(0, Math.round((storage.totalGB - storage.freeGB) * 10) / 10);

  const activation = interpretActivation(info, fmip);
  const age = estimateAgeFromSerial(info.SerialNumber);

  const record = {
    name: info.DeviceName || '',
    model: friendlyModel(info.ProductType, info.ProductName),
    productType: info.ProductType || '',
    deviceClass: info.DeviceClass || '',
    serial: info.SerialNumber || '',
    udid: info.UniqueDeviceID || '',
    imei: info.InternationalMobileEquipmentIdentity || '',
    imei2: info.InternationalMobileEquipmentIdentity2 || '',
    meid: info.MobileEquipmentIdentifier || '',
    iccid: info.IntegratedCircuitCardIdentity || '',
    phoneNumber: info.PhoneNumber || '',
    wifiMac: info.WiFiAddress || '',
    bluetoothMac: info.BluetoothAddress || '',
    modelNumber: info.ModelNumber || '',
    regionInfo: info.RegionInfo || '',
    color: info.DeviceColor || '',
    iosVersion: info.ProductVersion || '',
    buildVersion: info.BuildVersion || '',
    storage,
    battery,
    activation,
    ageEstimate: age,
  };

  const analysis = analyzeDevice({ info, battery, storage, activation, jailbroken: raw.jailbroken });
  return { record, analysis, rawInfo: info };
}

module.exports = {
  parseKeyValue,
  parsePlistFlat,
  friendlyModel,
  MODEL_NAMES,
  bytesToGB,
  batteryHealth,
  ratedCycles,
  estimateAgeFromSerial,
  interpretActivation,
  triagePanic,
  analyzeDevice,
  buildRecord,
};
