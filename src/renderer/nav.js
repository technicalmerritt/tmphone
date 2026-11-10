'use strict';

// View switching + app version. Exposes window.tmNav.show(view).
(function () {
  function show(view) {
    document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== 'view-' + view; });
    document.querySelectorAll('.nav__tab').forEach((t) => t.classList.toggle('nav__tab--active', t.dataset.view === view));
  }
  window.tmNav = { show };

  function init() {
    document.querySelectorAll('.nav__tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
    const goDl = document.getElementById('idevGoDownloads');
    if (goDl) goDl.addEventListener('click', () => show('downloads'));
    const ver = document.getElementById('appVersion');
    if (ver && window.appInfo && window.appInfo.version) {
      window.appInfo.version().then((v) => { if (v) ver.textContent = 'v' + v; }).catch(() => {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
