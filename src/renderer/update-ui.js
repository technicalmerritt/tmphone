'use strict';

// Self-update UI. The offer banner appears ONLY when a newer version exists.
// A manual check that finds nothing (or fails) shows a brief toast instead of a
// persistent banner — so there is never a dangling "install update" prompt when
// the app is already current.
(function () {
  const $ = (s) => document.querySelector(s);
  let banner, bannerText, progress;

  function show(el, on) { if (el) el.hidden = !on; }

  function toast(msg) {
    try {
      const t = document.createElement('div');
      t.className = 'toast'; t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; }, 2600);
      setTimeout(() => t.remove(), 3200);
    } catch { /* ignore */ }
  }

  async function check(manual) {
    const btn = $('#updBtn');
    if (btn && manual) { btn.disabled = true; btn.textContent = 'Checking…'; }
    let r = null;
    try { r = await window.updater.check(); }
    catch (err) { r = { ok: false, reason: (err && err.message) || '' }; }
    if (btn && manual) { btn.disabled = false; btn.textContent = 'Check for updates'; }

    if (r && r.ok && r.newer) {
      // A real update: show the banner with the action.
      bannerText.textContent = 'TM Phone ' + r.latest + ' is available.' + (r.notes ? ' ' + r.notes.slice(0, 160) : '');
      const apply = $('#updApply'); if (apply) apply.hidden = false;
      show(banner, true);
      return;
    }

    // No update (or the check failed): never leave a banner up.
    show(banner, false);
    if (manual) {
      if (r && r.ok) toast('You’re on the latest version' + (r.current ? ' (v' + r.current + ')' : '') + '.');
      else toast('Update check failed: ' + ((r && r.reason) || 'could not reach the update server') + '.');
    }
  }

  async function apply() {
    show(banner, false); show(progress, true);
    progress.textContent = 'Starting update…';
    try {
      const r = await window.updater.apply();
      if (!r || !r.ok) { progress.textContent = 'Update failed: ' + ((r && r.reason) || 'unknown'); }
      // On success the app relaunches itself.
    } catch (err) { progress.textContent = 'Update failed: ' + ((err && err.message) || ''); }
  }

  function init() {
    banner = $('#updBanner'); bannerText = $('#updBannerText'); progress = $('#updProgress');
    const btn = $('#updBtn'); if (btn) btn.addEventListener('click', () => check(true));
    const applyBtn = $('#updApply'); if (applyBtn) applyBtn.addEventListener('click', apply);
    const dismiss = $('#updDismiss'); if (dismiss) dismiss.addEventListener('click', () => show(banner, false));
    if (window.updater && window.updater.onProgress) {
      window.updater.onProgress((m) => {
        if (!progress) return; show(progress, true);
        const label = { download: 'Downloading update', extract: 'Extracting', install: 'Installing', done: 'Done — restarting' }[m.phase] || 'Updating';
        progress.textContent = label + (m.pct >= 0 ? ' ' + m.pct + '%' : '…');
      });
    }
    // Quiet check on launch — only surfaces something if an update exists.
    setTimeout(() => check(false), 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
