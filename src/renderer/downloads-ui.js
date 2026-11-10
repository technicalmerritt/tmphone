'use strict';

// Downloads tab: renders the dependency manifest and drives one-click installs.
(function () {
  const $ = (s) => document.querySelector(s);
  let listEl, busy = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function card(dep) {
    const isLink = dep.kind === 'link';
    const btnLabel = isLink ? 'Open' : 'Download &amp; install';
    return `<div class="dl-card" data-id="${esc(dep.id)}">
      <div class="dl-card__body">
        <h3>${esc(dep.name)}</h3>
        <p class="muted">${esc(dep.desc || '')}</p>
        ${dep.source ? `<p class="dl-src muted">Source: ${esc(dep.source)}</p>` : ''}
        <div class="dl-status muted" data-role="status"></div>
      </div>
      <div class="dl-card__action">
        <button class="btn btn--primary" data-role="btn" type="button">${btnLabel}</button>
      </div>
    </div>`;
  }

  function setStatus(id, text, cls) {
    const el = listEl.querySelector('.dl-card[data-id="' + CSS.escape(id) + '"] [data-role="status"]');
    if (el) { el.textContent = text || ''; el.className = 'dl-status ' + (cls || 'muted'); }
  }
  function setBtn(id, label, disabled) {
    const b = listEl.querySelector('.dl-card[data-id="' + CSS.escape(id) + '"] [data-role="btn"]');
    if (b) { b.innerHTML = label; b.disabled = !!disabled; }
  }

  async function doInstall(dep) {
    if (busy[dep.id]) return;
    busy[dep.id] = true;
    if (dep.kind === 'link') {
      try { await window.downloads.install(dep.id); setStatus(dep.id, 'Opened in your browser — run the installer, then come back.', 'muted'); }
      catch { setStatus(dep.id, 'Could not open the link.', 'bad'); }
      busy[dep.id] = false;
      return;
    }
    setBtn(dep.id, 'Installing…', true);
    setStatus(dep.id, 'Starting…', 'muted');
    try {
      const r = await window.downloads.install(dep.id);
      if (r && r.ok) { setStatus(dep.id, 'Installed ' + (r.installed || '') + ' files. Ready to use.', 'ok'); setBtn(dep.id, 'Reinstall', false); }
      else {
        const miss = r && r.missing && r.missing.length ? ' Missing: ' + r.missing.join(', ') + '.' : '';
        setStatus(dep.id, (r && r.reason ? r.reason : 'Install failed.') + miss, 'bad');
        setBtn(dep.id, 'Download &amp; install', false);
      }
    } catch (err) {
      setStatus(dep.id, (err && err.message) || 'Install failed.', 'bad');
      setBtn(dep.id, 'Download &amp; install', false);
    }
    busy[dep.id] = false;
  }

  async function render() {
    if (!listEl) return;
    listEl.innerHTML = '<p class="muted">Loading…</p>';
    let man = { dependencies: [] };
    try { man = await window.downloads.list(); } catch { /* ignore */ }
    const deps = (man && man.dependencies) || [];
    if (!deps.length) { listEl.innerHTML = '<p class="muted">Could not load the downloads list. Check your internet connection and press Refresh.</p>'; return; }
    listEl.innerHTML = deps.map(card).join('');
    deps.forEach((dep) => {
      const b = listEl.querySelector('.dl-card[data-id="' + CSS.escape(dep.id) + '"] [data-role="btn"]');
      if (b) b.addEventListener('click', () => doInstall(dep));
    });
  }

  function init() {
    listEl = $('#dlList');
    if (!listEl) return;
    const refresh = $('#dlRefresh');
    if (refresh) refresh.addEventListener('click', render);
    if (window.downloads && window.downloads.onProgress) {
      window.downloads.onProgress((m) => {
        if (!m || !m.id) return;
        if (m.phase === 'download') setStatus(m.id, 'Downloading… ' + (m.pct >= 0 ? m.pct + '%' : ''), 'muted');
        else if (m.phase === 'install') setStatus(m.id, 'Verifying & installing…', 'muted');
      });
    }
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
