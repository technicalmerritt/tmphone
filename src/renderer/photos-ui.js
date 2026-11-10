'use strict';

// Photos tab: browse DCIM folders, lazy-load thumbnails (HEIC decoded to JPEG
// in the main process), select and export originals to the PC.
(function () {
  const $ = (s) => document.querySelector(s);
  let els = {};
  let udid = '';
  let folder = null;
  const selected = new Set();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function toast(msg) { try { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); } catch { /* ignore */ } }
  function show(el, on) { if (el) el.hidden = !on; }

  async function getUdid() {
    try { const s = await window.idevice.status(); return (s && s.devices && s.devices[0]) || ''; } catch { return ''; }
  }

  async function loadFolders() {
    folder = null; selected.clear();
    show(els.back, false); show(els.exportBtn, false); show(els.photos, false);
    els.photos.innerHTML = ''; els.folders.innerHTML = '';
    els.status.textContent = 'Checking…';
    udid = await getUdid();
    if (!udid) { els.status.textContent = 'No device connected. Connect an iPhone/iPad, unlock it and tap Trust.'; return; }
    const st = await window.photos.status(udid);
    if (!st || !st.afc) { els.status.textContent = 'Photo access needs the “afcclient” tool, which isn’t in your installed tools suite. (Reinstall the tools from the Downloads tab; if it’s still missing, that build doesn’t include it.)'; return; }
    els.status.textContent = 'Loading folders…';
    const r = await window.photos.folders(udid);
    if (!r || !r.ok) { els.status.textContent = 'Could not read photos: ' + ((r && r.reason) || 'unknown') + '. Make sure the device is unlocked and trusted.'; return; }
    if (!r.folders.length) { els.status.textContent = 'No camera-roll folders found (DCIM is empty).'; return; }
    els.status.textContent = r.folders.length + ' folder(s). Click one to view its photos.';
    els.folders.innerHTML = r.folders.map((f) => `<button class="ph-folder" data-folder="${esc(f)}" type="button"><span class="ph-folder__ico">📁</span><span>${esc(f)}</span></button>`).join('');
    els.folders.querySelectorAll('.ph-folder').forEach((b) => b.addEventListener('click', () => openFolder(b.dataset.folder)));
  }

  let io = null;
  async function openFolder(name) {
    folder = name; selected.clear();
    show(els.folders, false); show(els.photos, true); show(els.back, true); show(els.exportBtn, true);
    updateExportBtn();
    els.status.textContent = 'Loading “' + name + '”…';
    const r = await window.photos.list(udid, name);
    if (!r || !r.ok) { els.status.textContent = 'Could not list photos: ' + ((r && r.reason) || 'unknown'); return; }
    if (!r.files.length) { els.status.textContent = 'No photos/videos in this folder.'; els.photos.innerHTML = ''; return; }
    els.status.textContent = r.files.length + ' item(s) in ' + name + '. Tap to select; thumbnails load as you scroll.';
    els.photos.innerHTML = r.files.map((f) => `
      <div class="ph-tile" data-name="${esc(f.name)}" data-type="${f.type}">
        <div class="ph-tile__img" data-name="${esc(f.name)}">${f.type === 'video' ? '<span class="ph-vid">▶</span>' : '<span class="ph-load">…</span>'}</div>
        <div class="ph-tile__name">${esc(f.name)}</div>
        <input type="checkbox" class="ph-tile__chk" />
      </div>`).join('');

    // selection
    els.photos.querySelectorAll('.ph-tile').forEach((tile) => {
      const chk = tile.querySelector('.ph-tile__chk');
      tile.addEventListener('click', (e) => {
        if (e.target !== chk) chk.checked = !chk.checked;
        if (chk.checked) selected.add(tile.dataset.name); else selected.delete(tile.dataset.name);
        tile.classList.toggle('ph-tile--sel', chk.checked);
        updateExportBtn();
      });
    });

    // lazy thumbnails
    if (io) io.disconnect();
    io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const box = en.target; io.unobserve(box);
        const nm = box.dataset.name;
        window.photos.thumb(udid, folder, nm).then((t) => {
          if (t && t.ok && t.dataUrl) box.innerHTML = '<img src="' + t.dataUrl + '" alt="" />';
          else if (t && t.video) box.innerHTML = '<span class="ph-vid">▶</span>';
          else if (t && t.noDecoder) box.innerHTML = '<span class="ph-load">HEIC</span>';
          else box.innerHTML = '<span class="ph-load">⚠</span>';
        }).catch(() => { box.innerHTML = '<span class="ph-load">⚠</span>'; });
      }
    }, { root: null, rootMargin: '200px' });
    els.photos.querySelectorAll('.ph-tile__img').forEach((b) => { if (b.querySelector('.ph-load')) io.observe(b); });
  }

  function updateExportBtn() { if (els.exportBtn) { els.exportBtn.disabled = selected.size === 0; els.exportBtn.textContent = selected.size ? ('Export selected (' + selected.size + ')') : 'Export selected'; } }

  async function exportSelected() {
    if (!selected.size) return;
    els.exportBtn.disabled = true;
    const names = Array.from(selected);
    els.status.textContent = 'Exporting ' + names.length + ' item(s)…';
    try {
      const r = await window.photos.export(udid, folder, names);
      if (r && r.canceled) { updateExportBtn(); return; }
      if (r && r.ok) { els.status.textContent = 'Exported ' + r.exported + ' item(s).'; toast('Exported ' + r.exported + ' photo(s)'); if (r.dir) window.idevice.revealPath(r.dir); }
      else els.status.textContent = 'Exported ' + ((r && r.exported) || 0) + '; failed ' + ((r && r.failed && r.failed.length) || '?') + '.';
    } catch (err) { els.status.textContent = 'Export failed: ' + ((err && err.message) || String(err)); }
    updateExportBtn();
  }

  function init() {
    els = { status: $('#phStatus'), folders: $('#phFolders'), photos: $('#phPhotos'), back: $('#phBack'), exportBtn: $('#phExport'), refresh: $('#phRefresh') };
    if (!els.folders) return;
    els.refresh.addEventListener('click', loadFolders);
    els.back.addEventListener('click', () => { show(els.photos, false); show(els.folders, true); show(els.back, false); show(els.exportBtn, false); selected.clear(); els.status.textContent = 'Click a folder to view its photos.'; });
    els.exportBtn.addEventListener('click', exportSelected);
    // Load when the Photos tab is first opened.
    const tab = document.querySelector('.nav__tab[data-view="photos"]');
    let loadedOnce = false;
    if (tab) tab.addEventListener('click', () => { if (!loadedOnce) { loadedOnce = true; loadFolders(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
