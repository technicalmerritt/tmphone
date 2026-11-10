'use strict';

// Self-update UI: a "Check for updates" button, an offer banner, and progress.
(function () {
  const $ = (s) => document.querySelector(s);
  let banner, bannerText, progress;

  function show(el, on) { if (el) el.hidden = !on; }

  async function check(manual) {
    const btn = $('#updBtn');
    if (btn && manual) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const r = await window.updater.check();
      if (r && r.ok && r.newer) {
        bannerText.textContent = 'TM Phone ' + r.latest + ' is available.' + (r.notes ? ' ' + r.notes.slice(0, 160) : '');
        show(banner, true);
      } else if (manual) {
        bannerText.textContent = (r && r.ok) ? 'You’re on the latest version.' : ('Update check failed: ' + ((r && r.reason) || 'unknown'));
        show(banner, true);
        const apply = $('#updApply'); if (apply) apply.hidden = !(r && r.newer);
      }
    } catch (err) {
      if (manual) { bannerText.textContent = 'Update check failed: ' + ((err && err.message) || ''); show(banner, true); }
    }
    if (btn && manual) { btn.disabled = false; btn.textContent = 'Check for updates'; }
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
    // Quiet check on launch.
    setTimeout(() => check(false), 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
