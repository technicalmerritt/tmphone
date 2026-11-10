'use strict';

// Settings tab: Syncro credentials + default asset type.
(function () {
  const $ = (s) => document.querySelector(s);
  let els = {};

  function status(msg, cls) { if (els.status) { els.status.textContent = msg || ''; els.status.className = 'muted set-status ' + (cls || ''); } }

  async function load() {
    if (!window.syncro) return;
    const s = await window.syncro.get();
    if (els.sub) els.sub.value = s.subdomain || '';
    if (els.token && s.hasToken) els.token.placeholder = '•••••• (saved — leave blank to keep)';
    if (s.hasToken && s.subdomain) loadAssetTypes(s.assetTypeId);
  }

  async function save(silent) {
    const payload = { subdomain: els.sub.value };
    const tok = els.token.value.trim();
    if (tok) payload.token = tok;
    const sel = els.assetType;
    if (sel && sel.value) { payload.assetTypeId = isNaN(+sel.value) ? sel.value : +sel.value; payload.assetTypeName = sel.options[sel.selectedIndex].text; }
    if (!silent) status('Saving…');
    try {
      await window.syncro.save(payload);
      els.token.value = '';
      if (!silent) status('Saved.', 'ok');
    } catch (e) { status('Save failed: ' + (e.message || e), 'bad'); }
  }

  async function test() {
    status('Testing connection…');
    const payload = {};
    if (els.sub.value) payload.subdomain = els.sub.value;
    if (els.token.value.trim()) payload.token = els.token.value.trim();
    try {
      const r = await window.syncro.test(payload);
      if (r && r.ok) {
        // Save quietly, then report the TEST result (not "Saved").
        await save(true);
        loadAssetTypes();
        status('✓ ' + ((r && r.message) || 'Connected successfully.'), 'ok');
      } else {
        status('✗ ' + ((r && r.message) || 'Connection failed.'), 'bad');
      }
    } catch (e) { status('✗ Test failed: ' + (e.message || e), 'bad'); }
  }

  async function loadAssetTypes(selectId) {
    if (!els.assetType) return;
    try {
      const r = await window.syncro.assetTypes();
      if (r && r.ok && r.types) {
        els.assetType.innerHTML = '<option value="">— none —</option>' + r.types.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
        if (selectId != null) els.assetType.value = String(selectId);
      }
    } catch { /* ignore */ }
  }

  function init() {
    els = { sub: $('#setSub'), token: $('#setToken'), save: $('#setSave'), test: $('#setTest'), status: $('#setStatus'), assetType: $('#setAssetType') };
    if (!els.sub) return;
    els.save.addEventListener('click', save);
    els.test.addEventListener('click', test);
    els.assetType.addEventListener('change', save);
    const tab = document.querySelector('.nav__tab[data-view="settings"]');
    let loaded = false;
    if (tab) tab.addEventListener('click', () => { if (!loaded) { loaded = true; load(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
