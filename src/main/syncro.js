'use strict';

// Syncro REST API client for TM Phone. Ported from TM Toolset's proven
// integration, plus customer search and create-or-update of a phone asset.
// Auth: Authorization: Bearer <token>. Base: https://<subdomain>.syncromsp.com/api/v1

function normalizeBase(subdomain) {
  let s = String(subdomain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!s) return '';
  const host = s.includes('.') ? s.split('/')[0] : s + '.syncromsp.com';
  return `https://${host}/api/v1`;
}

async function api(base, token, pathname, options = {}) {
  return fetch(base + pathname, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function testConnection({ subdomain, token }) {
  const base = normalizeBase(subdomain);
  if (!base) return { ok: false, message: 'Enter your Syncro subdomain.' };
  if (!token) return { ok: false, message: 'Enter your Syncro API token.' };
  try {
    const res = await api(base, token, '/customers?per_page=1');
    if (res.status === 200) return { ok: true, message: 'Connected to ' + base.replace('/api/v1', '') + '.' };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Token rejected — check the API token and its permissions (Customers + Assets).' };
    if (res.status === 404) return { ok: false, message: 'Not found — check the subdomain is correct.' };
    return { ok: false, message: `Syncro returned HTTP ${res.status}.` };
  } catch (e) {
    return { ok: false, message: 'Could not reach Syncro: ' + e.message };
  }
}

async function listAssetTypes({ subdomain, token }) {
  const base = normalizeBase(subdomain);
  if (!base || !token) return { ok: false, message: 'Syncro is not configured.' };
  try {
    let res = await api(base, token, '/customer_asset_types');
    if (res.status === 404) res = await api(base, token, '/asset_types');
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Token rejected — needs Assets permission.' };
    if (res.status !== 200) return { ok: false, message: `Syncro returned HTTP ${res.status}.` };
    let j = {};
    try { j = await res.json(); } catch { /* ignore */ }
    const raw = (j && (j.asset_types || j.customer_asset_types || j.data || j.types)) || [];
    const types = raw.map((t) => ({ id: t.id, name: t.name })).filter((t) => t.id && t.name);
    return { ok: true, types };
  } catch (e) {
    return { ok: false, message: 'Could not reach Syncro: ' + e.message };
  }
}

// Search customers by name/business/email.
async function searchCustomers({ subdomain, token, query }) {
  const base = normalizeBase(subdomain);
  if (!base || !token) return { ok: false, message: 'Syncro is not configured.' };
  const q = String(query || '').trim();
  if (!q) return { ok: true, customers: [] };
  try {
    const res = await api(base, token, `/customers?query=${encodeURIComponent(q)}&per_page=25`);
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Token rejected — needs Customers permission.' };
    if (res.status !== 200) return { ok: false, message: `Syncro returned HTTP ${res.status}.` };
    let j = {};
    try { j = await res.json(); } catch { /* ignore */ }
    const raw = (j && (j.customers || j.data)) || [];
    const customers = raw.map((c) => ({
      id: c.id,
      name: c.business_then_name || c.business_name || [c.firstname, c.lastname].filter(Boolean).join(' ').trim() || ('Customer ' + c.id),
      email: c.email || '',
    })).filter((c) => c.id);
    return { ok: true, customers };
  } catch (e) {
    return { ok: false, message: 'Could not reach Syncro: ' + e.message };
  }
}

// Find an existing asset by serial (to update instead of duplicating).
async function findAssetBySerial({ base, token, serial }) {
  if (!serial) return null;
  try {
    const res = await api(base, token, `/customer_assets?query=${encodeURIComponent(serial)}&per_page=25`);
    if (res.status !== 200) return null;
    let j = {};
    try { j = await res.json(); } catch { /* ignore */ }
    const raw = (j && (j.assets || j.customer_assets || j.data)) || [];
    const hit = raw.find((a) => (a.asset_serial && String(a.asset_serial) === String(serial)) ||
      (a.properties && (a.properties.Serial === serial || a.properties.serial === serial || a.properties.IMEI === serial)));
    return hit ? hit.id : (raw[0] ? raw[0].id : null);
  } catch { return null; }
}

// Create or update a phone asset from a device record.
async function registerAsset({ subdomain, token, customerId, assetTypeId, name, serial, properties }) {
  const base = normalizeBase(subdomain);
  if (!base || !token) return { ok: false, message: 'Syncro is not configured.' };
  if (!customerId) return { ok: false, message: 'Pick a customer first.' };
  if (!assetTypeId) return { ok: false, message: 'Choose an asset type in Settings first.' };
  const body = { name: name || 'iPhone', customer_id: customerId, asset_type_id: assetTypeId, properties: properties || {} };
  if (serial) body.asset_serial = serial;
  try {
    const existingId = await findAssetBySerial({ base, token, serial });
    let res, action;
    if (existingId) {
      action = 'updated';
      res = await api(base, token, `/customer_assets/${existingId}`, { method: 'PUT', body });
    } else {
      action = 'created';
      res = await api(base, token, '/customer_assets', { method: 'POST', body });
    }
    if (res.status >= 200 && res.status < 300) {
      let id = existingId;
      try { const j = await res.json(); id = (j && j.asset && j.asset.id) || (j && j.customer_asset && j.customer_asset.id) || (j && j.id) || existingId; } catch { /* ignore */ }
      return { ok: true, action, assetId: id, message: `Asset ${action}${id ? ` (#${id})` : ''}.` };
    }
    let detail = '';
    try { const j = await res.json(); detail = (j && (j.message || (j.errors && JSON.stringify(j.errors)))) || ''; } catch { /* ignore */ }
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Syncro rejected it (HTTP ${res.status}). The token needs permission to manage assets.` };
    return { ok: false, message: `Syncro returned HTTP ${res.status}.${detail ? ' ' + detail : ''}` };
  } catch (e) {
    return { ok: false, message: 'Could not reach Syncro: ' + e.message };
  }
}

module.exports = { normalizeBase, testConnection, listAssetTypes, searchCustomers, registerAsset };
