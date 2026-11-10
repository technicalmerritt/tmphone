'use strict';

// Apple Devices (iOS/iPadOS) tab. Reads a connected device over USB via the
// main-process libimobiledevice runner and renders a technician dashboard:
// identity, battery health, storage, software and ownership/Activation-Lock.

(function () {
  const $ = (s) => document.querySelector(s);
  let els = {};
  let devices = [];
  let current = null; // last read record

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function toast(msg) {
    try { if (window.activity && window.activity.toast) return window.activity.toast(msg); } catch { /* ignore */ }
    try {
      const t = document.createElement('div');
      t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
      setTimeout(() => t.remove(), 2600);
    } catch { /* ignore */ }
  }

  function setConn(state, text) {
    if (!els.dot) return;
    els.dot.className = 'idev-dot idev-dot--' + state; // off | wait | on
    els.connText.textContent = text;
  }

  function show(el, on) { if (el) el.hidden = !on; }

  async function refreshStatus() {
    if (!window.idevice) { setConn('off', 'Apple device support is unavailable in this build.'); show(els.setup, true); return; }
    const s = await window.idevice.status();
    if (!s || !s.toolsPresent) {
      setConn('off', 'Apple device tools not installed');
      els.setupMsg.textContent = (s && s.message) || '';
      show(els.setup, true);
      enableButtons(false);
      return;
    }
    show(els.setup, false);
    devices = Array.isArray(s.devices) ? s.devices : [];
    reflectDevices();
    startWatch(); // only poll for connects once we know the tools exist
  }

  let watching = false;
  function startWatch() {
    if (watching || !window.idevice || !window.idevice.onDevices) return;
    watching = true;
    window.idevice.onDevices((list) => {
      devices = Array.isArray(list) ? list : [];
      if (!els.setup || els.setup.hidden) reflectDevices();
    });
    try { window.idevice.watch(true); } catch { /* ignore */ }
  }

  function reflectDevices() {
    if (devices.length) {
      setConn('on', devices.length === 1 ? 'Device connected — ready to read' : devices.length + ' devices connected');
      enableButtons(true);
    } else {
      setConn('wait', 'No device detected — connect, unlock and tap “Trust”');
      enableButtons(false);
    }
  }

  function enableButtons(on) {
    if (els.readBtn) els.readBtn.disabled = !on;
    // report/syncro only make sense once we have a reading
    const haveRecord = !!current;
    if (els.reportBtn) els.reportBtn.disabled = !haveRecord;
    if (els.syncroBtn) els.syncroBtn.disabled = !haveRecord;
  }

  // ---- rendering helpers ----
  function healthClass(v) { return v === 'good' ? 'ok' : v === 'fair' ? 'warn' : v === 'service' ? 'bad' : 'muted'; }
  function sevClass(s) { return s === 'critical' ? 'bad' : s === 'warning' ? 'warn' : s === 'ok' ? 'ok' : 'muted'; }

  function field(label, value, copyable) {
    if (!value) return '';
    const v = esc(value);
    return `<div class="idev-field">
      <span class="idev-field__k">${esc(label)}</span>
      <span class="idev-field__v${copyable ? ' idev-copy' : ''}"${copyable ? ' title="Click to copy" data-copy="' + v + '"' : ''}>${v}</span>
    </div>`;
  }

  function batteryCard(b, productType) {
    if (!b) return '';
    const pct = b.healthPct;
    const cls = healthClass(b.verdict);
    const bar = pct != null ? `<div class="idev-bar"><div class="idev-bar__fill idev-bar__fill--${cls}" style="width:${Math.max(3, pct)}%"></div></div>` : '';
    const rows = [];
    if (b.cycleCount != null) rows.push(field('Cycle count', String(b.cycleCount)));
    if (b.designCapacity) rows.push(field('Design capacity', b.designCapacity + ' mAh'));
    if (b.fullChargeCapacity) rows.push(field('Full-charge capacity', b.fullChargeCapacity + ' mAh'));
    if (b.currentPct != null) rows.push(field('Charge now', b.currentPct + '%' + (b.charging ? ' (charging)' : '')));
    return `<section class="idev-card">
      <h2>Battery health</h2>
      ${pct != null ? `<div class="idev-big idev-big--${cls}">${pct}<span class="idev-big__u">%</span>
        <span class="idev-verdict idev-verdict--${cls}">${esc(b.verdictLabel)}</span></div>` : '<p class="muted">Battery details were not available from this device.</p>'}
      ${bar}
      ${b.reason ? `<p class="muted">${esc(b.reason)}</p>` : ''}
      <div class="idev-fields">${rows.join('')}</div>
    </section>`;
  }

  function storageCard(s) {
    if (!s || !s.totalGB) return '';
    const freePct = Math.round((s.freeGB / s.totalGB) * 100);
    const usedPct = 100 - freePct;
    const cls = freePct <= 5 ? 'bad' : freePct <= 12 ? 'warn' : 'ok';
    return `<section class="idev-card">
      <h2>Storage</h2>
      <div class="idev-bar"><div class="idev-bar__fill idev-bar__fill--${cls}" style="width:${Math.max(3, usedPct)}%"></div></div>
      <p class="muted">${s.usedGB != null ? s.usedGB + ' GB used · ' : ''}${s.freeGB} GB free of ${s.totalGB} GB (${freePct}% free)</p>
    </section>`;
  }

  function ownershipCard(a) {
    if (!a) return '';
    let line, cls;
    if (a.findMyKnown && a.findMyEnabled) { line = 'Find My / Activation Lock is ON — cannot be wiped or resold without the owner signing out.'; cls = 'bad'; }
    else if (a.findMyKnown && !a.findMyEnabled) { line = 'Find My is OFF — device can be erased/resold.'; cls = 'ok'; }
    else { line = 'Could not read Find My / Activation Lock over USB — verify in Settings → [name] → Find My.'; cls = 'warn'; }
    return `<section class="idev-card">
      <h2>Ownership &amp; Activation Lock</h2>
      <p class="idev-flag idev-flag--${cls}">${esc(line)}</p>
      ${field('Activation state', a.activationState)}
    </section>`;
  }

  function findingsCard(an) {
    if (!an || !an.findings || !an.findings.length) return '';
    const items = an.findings.map((f) => `<li class="idev-finding idev-finding--${sevClass(f.severity)}">
      <div class="idev-finding__h"><span class="idev-finding__sev">${esc(f.severity)}</span><strong>${esc(f.title)}</strong></div>
      <p>${esc(f.summary)}</p>
      ${f.recommendation ? `<p class="muted">→ ${esc(f.recommendation)}</p>` : ''}
    </li>`).join('');
    return `<section class="idev-card">
      <h2>Findings <span class="muted">(health score ${an.score}/100)</span></h2>
      <ul class="idev-findings">${items}</ul>
    </section>`;
  }

  function render(rec, an) {
    const r = rec;
    const identity = [
      field('Name', r.name),
      field('Model', r.model),
      field('Model number', r.modelNumber),
      field('Serial', r.serial, true),
      field('IMEI', r.imei, true),
      field('IMEI 2', r.imei2, true),
      field('MEID', r.meid, true),
      field('UDID', r.udid, true),
      field('Phone number', r.phoneNumber, true),
      field('ICCID', r.iccid, true),
      field('Wi-Fi MAC', r.wifiMac, true),
      field('Bluetooth MAC', r.bluetoothMac, true),
      field('Region', r.regionInfo),
      r.ageEstimate ? field('Approx. made', r.ageEstimate.year + (r.ageEstimate.confidence ? ' (approx)' : '')) : '',
    ].join('');
    const software = [
      field('iOS / iPadOS', r.iosVersion),
      field('Build', r.buildVersion),
      field('Device class', r.deviceClass),
      field('Product type', r.productType),
    ].join('');

    els.content.innerHTML = `
      <div class="idev-hero">
        <div class="idev-hero__title"><span class="idev-hero__ico">📱</span><div>
          <h2>${esc(r.model || 'Apple device')}</h2>
          <p class="muted">${esc(r.name || '')}${r.iosVersion ? ' · iOS ' + esc(r.iosVersion) : ''}</p>
        </div></div>
      </div>
      <div class="idev-grid">
        ${batteryCard(r.battery, r.productType)}
        ${storageCard(r.storage)}
        ${ownershipCard(r.activation)}
        <section class="idev-card">
          <h2>Identity</h2>
          <div class="idev-fields">${identity}</div>
        </section>
        <section class="idev-card">
          <h2>Software</h2>
          <div class="idev-fields">${software}</div>
        </section>
        ${findingsCard(an)}
      </div>`;
    show(els.content, true);

    // click-to-copy
    els.content.querySelectorAll('.idev-copy').forEach((el) => {
      el.addEventListener('click', () => {
        const v = el.getAttribute('data-copy') || el.textContent;
        try { navigator.clipboard.writeText(v); toast('Copied'); } catch { /* ignore */ }
      });
    });
  }

  async function readDevice() {
    if (!window.idevice || !devices.length) return;
    show(els.error, false); show(els.content, false); show(els.busy, true);
    try {
      const res = await window.idevice.read(devices[0]);
      show(els.busy, false);
      if (!res || !res.ok) {
        els.errDetail.textContent = (res && res.reason) || 'Unknown error.';
        show(els.error, true);
        return;
      }
      current = res.record;
      render(res.record, res.analysis);
      enableButtons(true);
    } catch (err) {
      show(els.busy, false);
      els.errDetail.textContent = (err && err.message) || String(err);
      show(els.error, true);
    }
  }

  function buildReportText(r) {
    const L = [];
    L.push('APPLE DEVICE REPORT — ' + new Date().toLocaleString());
    L.push('='.repeat(48));
    L.push('Model:            ' + (r.model || ''));
    L.push('Name:             ' + (r.name || ''));
    L.push('Serial:           ' + (r.serial || ''));
    L.push('IMEI:             ' + (r.imei || ''));
    if (r.imei2) L.push('IMEI 2:           ' + r.imei2);
    L.push('UDID:             ' + (r.udid || ''));
    L.push('iOS:              ' + (r.iosVersion || '') + (r.buildVersion ? ' (' + r.buildVersion + ')' : ''));
    if (r.battery && r.battery.healthPct != null) {
      L.push('Battery health:   ' + r.battery.healthPct + '% (' + r.battery.verdictLabel + ')'
        + (r.battery.cycleCount != null ? ', ' + r.battery.cycleCount + ' cycles' : ''));
    }
    if (r.storage && r.storage.totalGB) L.push('Storage:          ' + r.storage.freeGB + ' GB free of ' + r.storage.totalGB + ' GB');
    if (r.activation) {
      const al = r.activation.findMyKnown ? (r.activation.findMyEnabled ? 'ON' : 'OFF') : 'unknown (verify manually)';
      L.push('Activation Lock:  ' + al);
    }
    return L.join('\n');
  }

  function exportReport() {
    if (!current) return;
    try { navigator.clipboard.writeText(buildReportText(current)); toast('Report copied to clipboard'); }
    catch { toast('Could not copy report'); }
  }

  async function installTools() {
    if (!window.idevice || !window.idevice.install) return;
    if (els.installMsg) { els.installMsg.hidden = false; els.installMsg.textContent = 'Installing…'; }
    try {
      const r = await window.idevice.install();
      if (!r || r.canceled) { if (els.installMsg) els.installMsg.hidden = true; return; }
      if (r.ok) {
        if (els.installMsg) els.installMsg.textContent = 'Installed ' + r.installed + ' files. Apple device support is now active.';
        toast('Apple device support installed');
        refreshStatus();
      } else {
        const miss = r.missing && r.missing.length ? ' Missing: ' + r.missing.join(', ') + '.' : '';
        if (els.installMsg) els.installMsg.textContent = (r.reason || 'That archive did not contain the required tools.') + miss;
      }
    } catch (err) {
      if (els.installMsg) els.installMsg.textContent = (err && err.message) || 'Install failed.';
    }
  }

  function init() {
    els = {
      dot: $('#idevConnDot'), connText: $('#idevConnText'),
      setup: $('#idevSetup'), setupMsg: $('#idevSetupMsg'),
      busy: $('#idevBusy'), error: $('#idevError'), errDetail: $('#idevErrorDetail'),
      content: $('#idevContent'),
      readBtn: $('#idevReadBtn'), reportBtn: $('#idevReportBtn'), syncroBtn: $('#idevSyncroBtn'),
      installBtn: $('#idevInstallBtn'), openDirBtn: $('#idevOpenDirBtn'), installMsg: $('#idevInstallMsg'),
    };
    if (!els.readBtn) return; // panel not present

    if (els.installBtn) els.installBtn.addEventListener('click', installTools);
    if (els.openDirBtn) els.openDirBtn.addEventListener('click', () => { try { window.idevice.openToolsDir(); } catch { /* ignore */ } });

    els.readBtn.addEventListener('click', readDevice);
    els.reportBtn.addEventListener('click', exportReport);
    if (els.syncroBtn) {
      els.syncroBtn.title = 'Coming next: one-click asset registration in Syncro';
      els.syncroBtn.addEventListener('click', () => toast('Syncro registration is the next phase — coming soon.'));
    }

    refreshStatus(); // starts the connect-watcher itself once tools are confirmed
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
