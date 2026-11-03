// The CalTopo map link: a public map as a KML network link, a private map read
// through the FLEX server's CalTopo API (key kept on this computer), and the
// bookmarklet login. CalTopo JSON -> entities updates the same data source in
// place; pulls are handed to window._ctWrite._pulled / window._ctLayers
// (caltopo-write.js, caltopo-layers.js). Moved out of flex.js unchanged (the
// flex.js split, wave 2; see client/src/README.md).
//
// Pure exports (no browser, no Cesium), node-testable:
//   normalizeCaltopoUrl(raw)   CalTopo URL / bare map id -> canonical ?format=kml URL, or null
//   caltopoMapId(url)          the map id of a /m/ID URL, or null
//   caltopoFeatureSig(g, p)    the change signature of a feature (geometry + the properties drawn)
// Setup:
//   setupCaltopoMap({ Cesium, cesiumViewer, ProxyUrlGenerator, ic, notifyCaltopoChanged,
//                     miniMapState, syncMinimapCaltopoFeatures })
//     -> { caltopoState, loadCaltopoKml, clearCaltopo, renderCaltopoStatus,
//          _fetchCaltopoKml, _showCaltopoLoggedIn }
//
// Hooks defined here (unchanged): window._ctApplyJson, window._ctRefresh,
// window._loadCaltopo, window._clearCaltopo, window._caltopoKeyDialog,
// window._caltopoKeyClear, window._caltopoPickMap, window._caltopoLogout.
// The key-section render (500 ms) and the bookmarklet link are set up when this runs.

/** Normalize various CalTopo URL forms → the canonical ?format=kml data URL, or null.
 *  Accepted forms:
 *    https://caltopo.com/m/UUQ119H
 *    https://caltopo.com/m/UUQ119H?format=kml   (already correct)
 *    UUQ119H                                     (bare map ID)
 */
export function normalizeCaltopoUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  // Bare map ID — alphanumeric, 3-10 chars
  if (/^[A-Za-z0-9]{3,10}$/.test(trimmed)) {
    return `https://caltopo.com/m/${trimmed}?format=kml`;
  }
  // Any caltopo.com/m/ID form (with or without ?format=kml)
  const match = trimmed.match(/caltopo\.com\/m\/([A-Za-z0-9]+)/i);
  if (match) {
    return `https://caltopo.com/m/${match[1]}?format=kml`;
  }
  return null;
}

export const caltopoMapId = u => (String(u || '').match(/\/m\/([A-Za-z0-9]+)/) || [])[1] || null;

export function caltopoFeatureSig(g, p) {
  return JSON.stringify([g, p.title, p.description, p.stroke, p['stroke-width'], p['marker-color'], p.fill, p['fill-opacity'], p.folderId]);
}

export function setupCaltopoMap({
  Cesium, cesiumViewer, ProxyUrlGenerator, ic: _ic, notifyCaltopoChanged,
  miniMapState, syncMinimapCaltopoFeatures,
} = {}) {
  if (!Cesium) throw new Error('caltopo-map: Cesium missing');

// ── CalTopo KML Network Link ──────────────────────────────────────────────────

const caltopoState = {
  url:        null,
  interval:   30,
  dataSource: null,
  pollTimer:  null,
};

const _normalizeCaltopoUrl = normalizeCaltopoUrl;

function _setCaltopoStatus(msg, color) {
  const el = document.getElementById('caltopo_status');
  if (el) { el.textContent = msg; el.style.color = color || '#ccc'; }
}

// A private map: with a CalTopo key on this computer (🔑), the map is read
// through CalTopo's API by the FLEX server (signed; caltopo_api.js) — its
// folders become folders here. Without a key, the KML link (public maps).
let _caltopoKeySet = null;
async function _caltopoHasKey(force) {
  if (_caltopoKeySet === null || force) { try { _caltopoKeySet = !!(await (await fetch('/api/caltopo/key')).json()).set; } catch (_) { _caltopoKeySet = false; } }
  return _caltopoKeySet;
}
const _caltopoMapId = caltopoMapId;
const _ctColor = (c, d) => { c = String(c || '').replace(/^#/, ''); return /^[0-9a-f]{6}$/i.test(c) ? Cesium.Color.fromCssColorString('#' + c) : Cesium.Color.fromCssColorString(d); };
// CalTopo map JSON (result.state.features) → a data source; folders are parent
// entities, so hiding one hides what is in it. Refreshes update the same data
// source in place: a feature that didn't change keeps its entity, so its line
// isn't draped on the ground again (that is the expensive part); a map that
// didn't change at all costs nothing. Long tracks are drawn simplified (as
// project features are, project-features.js): within ~2 m, at most 2000 points.
function _ctSimplify(coords) {
  const S = window._pjfState && window._pjfState.simplify;
  return S && coords.length > 50 ? S(coords) : coords;
}
function _caltopoJsonToDataSource(result, ds) {
  ds = ds || new Cesium.CustomDataSource('CalTopo');
  const feats = (result && result.state && result.state.features) || [];
  const E = ds.entities, keep = new Set();
  ds.entities.suspendEvents();
  try {
    feats.filter(f => f.properties && f.properties.class === 'Folder').forEach(f => {
      const id = 'ctf-' + f.id; keep.add(id);
      const e = E.getById(id) || E.add(new Cesium.Entity({ id }));
      e.name = f.properties.title || 'Folder';
    });
    feats.filter(f => f.properties && f.properties.class === 'Folder').forEach(f => {
      const e = E.getById('ctf-' + f.id), par = f.properties.folderId && E.getById('ctf-' + f.properties.folderId);
      if (e && e.parent !== (par || undefined)) e.parent = par || undefined;
    });
    // Features in no folder hang under Markers / Lines / Polygons, as CalTopo
    // lists them (FLEX's display only: ids 'ctf-_markers' …, nothing in CalTopo).
    const LOOSE = { Point: ['_markers', 'Markers'], LineString: ['_lines', 'Lines'], Polygon: ['_polygons', 'Polygons'] };
    const looseOf = f => { const p = f.properties || {}, g = f.geometry; if (!g || p.class === 'Folder' || (p.folderId && E.getById('ctf-' + p.folderId))) return null; return LOOSE[g.type] || null; };
    feats.forEach(f => { const L = looseOf(f); if (!L) return; const id = 'ctf-' + L[0]; if (!keep.has(id)) { keep.add(id); const e = E.getById(id) || E.add(new Cesium.Entity({ id })); e.name = L[1]; e._ctLoose = true; } });
    const parentOf = f => { const L = looseOf(f); return L ? E.getById('ctf-' + L[0]) : (E.getById('ctf-' + (f.properties || {}).folderId) || undefined); };
    let n = 0;
    feats.forEach(f => {
      const p = f.properties || {}, g = f.geometry;
      if (!g || p.class === 'Folder' || !g.coordinates) return;
      const id = 'ct-' + f.id;
      const sig = caltopoFeatureSig(g, p);
      const had = E.getById(id);
      if (had && had._ctSig === sig) { keep.add(id); n++; const par = parentOf(f); if (had.parent !== par) had.parent = par; return; }
      if (had) E.remove(had);
      const base = { id, name: p.title || '', description: p.description || '', parent: parentOf(f) };
      const P = c => Cesium.Cartesian3.fromDegrees(c[0], c[1], 0);
      let ent = null;
      try {
        if (g.type === 'Point') {
          const col = _ctColor(p['marker-color'], '#ff8800');
          ent = E.add(Object.assign(base, { position: P(g.coordinates),
            point: { pixelSize: 9, color: col, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN, disableDepthTestDistance: 5000 },
            label: window._pjfLabel ? window._pjfLabel(p.title || '') : { text: p.title || '', font: '15px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
                     style: Cesium.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -10),
                     heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000), disableDepthTestDistance: 5000 } }));
        } else if (g.type === 'LineString') {
          ent = E.add(Object.assign(base, { polyline: { positions: _ctSimplify(g.coordinates).map(P), width: Math.max(1, +p['stroke-width'] || 2), material: _ctColor(p.stroke, '#ff0000'), clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN } }));
        } else if (g.type === 'Polygon') {
          const ring = _ctSimplify(g.coordinates[0] || []).map(P);
          const col = _ctColor(p.stroke || p.fill, '#ff0000');
          ent = E.add(Object.assign(base, { polygon: { classificationType: Cesium.ClassificationType.TERRAIN, hierarchy: ring, material: _ctColor(p.fill || p.stroke, '#ff0000').withAlpha(+p['fill-opacity'] || 0.15), heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN },
            polyline: { positions: ring, width: Math.max(1, +p['stroke-width'] || 2), material: col, clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN } }));
        }
      } catch (e) { console.warn('[caltopo] feature skipped', f.id, e); }
      if (ent) { ent._ctSig = sig; keep.add(id); n++; }
    });
    E.values.slice().forEach(e => { if (!keep.has(e.id)) E.remove(e); });      // gone from the map
    ds._ctCount = n;
  } finally { ds.entities.resumeEvents(); }
  return ds;
}
window._ctApplyJson = _caltopoJsonToDataSource;                // tests
window._ctRefresh = () => _fetchCaltopoKml();                   // re-read the map now (caltopo-write.js, after an edit)
// Long KML lines (public maps, no key): simplified once after loading.
function _ctSimplifyKml(ds) {
  const now = Cesium.JulianDate.now();
  ds.entities.values.forEach(e => {
    if (!e.polyline || !e.polyline.positions || !e.polyline.positions.isConstant) return;
    const ps = e.polyline.positions.getValue(now);
    if (!ps || ps.length <= 50) return;
    const ll = ps.map(c => { const k = Cesium.Cartographic.fromCartesian(c); return [Cesium.Math.toDegrees(k.longitude), Cesium.Math.toDegrees(k.latitude), k.height]; });
    const s = _ctSimplify(ll);
    if (s.length < ps.length) e.polyline.positions = s.map(c => Cesium.Cartesian3.fromDegrees(c[0], c[1], c[2]));
  });
}

async function _fetchCaltopoKml() {
  if (!caltopoState.url) return;
  const mapId = _caltopoMapId(caltopoState.url);
  if (mapId && await _caltopoHasKey()) {
    try {
      _setCaltopoStatus('updating (private map)…', '#aaa');
      const r = await fetch('/api/caltopo/map?id=' + encodeURIComponent(mapId));
      const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch (_) { j = {}; }
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (window._ctWrite) window._ctWrite._pulled(mapId, j);           // edits, queue, changes (caltopo-write.js)
      if (window._ctLayers) window._ctLayers.apply(mapId, j);           // the map's custom layers → 🗺 Layers (caltopo-layers.js)
      const offl = j.flexOffline ? `⚠ CalTopo not reachable: FLEX’s copy from ${new Date(j.flexPulled).toLocaleString()}, ` : '';
      const ds0 = caltopoState.dataSource;
      if (ds0 && ds0._ctJson && caltopoState._ctText === txt && caltopoState._ctMapId === mapId) {       // nothing changed: nothing to do
        _setCaltopoStatus(offl ? offl + `${ds0._ctCount} feature(s)` : `✓ private map, ${ds0._ctCount} feature(s), checked ${new Date().toLocaleTimeString()}`, offl ? '#fc6' : '#8f8');
        renderCaltopoStatus();
        return;
      }
      const same = ds0 && ds0._ctJson && caltopoState._ctMapId === mapId;
      const ds = _caltopoJsonToDataSource(j, same ? ds0 : null);
      ds._ctJson = true;
      caltopoState._ctText = txt; caltopoState._ctMapId = mapId;
      if (!same) {
        if (ds0) cesiumViewer.dataSources.remove(ds0, true);
        cesiumViewer.dataSources.add(ds);
        caltopoState.dataSource = ds;
      }
      try { syncMinimapCaltopoFeatures(ds); } catch (_) {}
      if (window._onVectorSourcesChanged) window._onVectorSourcesChanged();
      _setCaltopoStatus(offl ? offl + `${ds._ctCount} feature(s)` : `✓ private map, ${ds._ctCount} feature(s), ${new Date().toLocaleTimeString()}`, offl ? '#fc6' : '#8f8');
    } catch (e) {
      console.warn('[caltopo] private map failed:', e);
      _setCaltopoStatus('⚠ ' + (e.message || e), '#f88');
    }
    renderCaltopoStatus();
    return;
  }
  if (window._ctWrite) window._ctWrite._pulled(null);              // a public map (KML): no edits
  if (window._ctLayers) window._ctLayers.apply(null);               // … and no custom layers (the KML has none)
  const proxiedUrl = ProxyUrlGenerator.generateProxyUrl(caltopoState.url);
  try {
    _setCaltopoStatus('updating…', '#aaa');
    // The KML as text first: unchanged since last time → keep what is drawn.
    let kml = null;
    try { const rr = await fetch(proxiedUrl); if (rr.ok) kml = await rr.text(); } catch (_) {}
    if (kml && caltopoState.dataSource && caltopoState._ctText === kml) {
      _setCaltopoStatus(`✓ checked ${new Date().toLocaleTimeString()}`, '#8f8');
      renderCaltopoStatus();
      return;
    }
    const ds = await Cesium.KmlDataSource.load(kml ? new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }) : proxiedUrl, {
      camera:        cesiumViewer.scene.camera,
      canvas:        cesiumViewer.scene.canvas,
      clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN,
    });
    caltopoState._ctText = kml; caltopoState._ctMapId = null;
    _ctSimplifyKml(ds);
    if (caltopoState.dataSource) {
      cesiumViewer.dataSources.remove(caltopoState.dataSource, true);
    }
    ds.name = 'CalTopo';
    cesiumViewer.dataSources.add(ds);
    caltopoState.dataSource = ds;
    syncMinimapCaltopoFeatures(ds);
    if (window._onVectorSourcesChanged) window._onVectorSourcesChanged();   // folders, cave tags (project-features.js)
    const t = new Date().toLocaleTimeString();
    _setCaltopoStatus(`✓ loaded ${t}`, '#8f8');
    renderCaltopoStatus();
  } catch (e) {
    console.warn('[caltopo] load failed:', e);
    _setCaltopoStatus('⚠ load failed — check URL/proxy', '#f88');
    renderCaltopoStatus();
  }
}

async function loadCaltopoKml(rawUrl, intervalSecs) {
  const kmlUrl = _normalizeCaltopoUrl(rawUrl);
  if (!kmlUrl) {
    _setCaltopoStatus('⚠ invalid CalTopo URL', '#f88');
    return;
  }
  if (window._ctInterval) intervalSecs = window._ctInterval(intervalSecs);   // 0 = off, nothing under 30 s (caltopo-write.js)
  { const s = document.getElementById('caltopo_interval_select'); if (s) s.value = String(intervalSecs); }
  _clearCaltopoTimers();
  caltopoState.url      = kmlUrl;
  caltopoState.interval = intervalSecs;

  await _fetchCaltopoKml();

  if (intervalSecs > 0) {
    caltopoState.pollTimer = setInterval(_fetchCaltopoKml, intervalSecs * 1000);
  }

  notifyCaltopoChanged(kmlUrl, intervalSecs);
  if (window._pjWs && !(window._pj && window._pj.pid)) window._pjWs.placeCaltopo(null);
}

function _clearCaltopoTimers() {
  if (caltopoState.pollTimer) {
    clearInterval(caltopoState.pollTimer);
    caltopoState.pollTimer = null;
  }
}

function clearCaltopo() {
  if (caltopoState.url && window._pjWs && !window._ws.switching) window._pjWs.removed('caltopo', caltopoState.url);
  _clearCaltopoTimers();
  if (caltopoState.dataSource) {
    cesiumViewer.dataSources.remove(caltopoState.dataSource, true);
    caltopoState.dataSource = null; caltopoState._ctText = null; caltopoState._ctMapId = null;
  }
  if (miniMapState.miniMapCaltopoSource) miniMapState.miniMapCaltopoSource.clear();
  caltopoState.url = null;
  if (window._ctWrite) window._ctWrite._pulled(null);
  if (window._ctLayers) window._ctLayers.apply(null);
  if (window._onVectorSourcesChanged) window._onVectorSourcesChanged();
  _setCaltopoStatus('', '');
  notifyCaltopoChanged(null, 60);
  renderCaltopoStatus();
}

// ── CalTopo status row ────────────────────────────────────────────────────────

function renderCaltopoStatus() {
  const dot  = document.getElementById('lp-ct-dot');
  const text = document.getElementById('lp-ct-text');
  if (!dot || !text) return;
  if (caltopoState.url) {
    const id = (caltopoState.url.match(/\/m\/([A-Za-z0-9]+)/) || [])[1] || caltopoState.url;
    dot.style.color  = '#4f4';
    text.textContent = `Active — ${id}`;
  } else {
    dot.style.color  = 'rgba(255,255,255,0.3)';
    text.textContent = 'Not loaded';
  }
}

// Expose to toolbar onclick handlers (can't use ES module imports from inline HTML)
window._loadCaltopo = () => {
  const url      = (document.getElementById('caltopo_url_input')?.value || '').trim();
  const interval = parseInt(document.getElementById('caltopo_interval_select')?.value || '60', 10);
  if (url) loadCaltopoKml(url, interval);
};
window._clearCaltopo = () => clearCaltopo();
// 🔑 The CalTopo key for private maps (stays on this computer's FLEX server).
async function _renderCaltopoKey() {
  const box = document.getElementById('caltopo_key_section');
  if (!box) return;
  let k = { set: false };
  try { k = await (await fetch('/api/caltopo/key')).json(); } catch (_) {}
  _caltopoKeySet = !!k.set;
  const b = (label, fn) => `<button onclick="${fn}" class="btn btn-sm btn-secondary" style="font-size:10px; padding:1px 6px;">${label}</button>`;
  box.innerHTML = k.set
    ? `<span style="color:#8f8;">${_ic('key')}Key ${k.id}${k.accountId ? ' · account ' + k.accountId : ''}: private maps are read through the CalTopo API</span>
       <div style="display:flex; gap:4px; margin-top:3px; flex-wrap:wrap;">${k.accountId ? b('Pick a map…', 'window._caltopoPickMap()') : ''}${b('Change key…', 'window._caltopoKeyDialog()')}${b('Remove key', 'window._caltopoKeyClear()')}</div>`
    : `<span style="opacity:0.7;">Private maps need a CalTopo key (Team service account, or your account's key).</span>
       <div style="margin-top:3px;">${b(_ic('key') + 'Add a CalTopo key…', 'window._caltopoKeyDialog()')}</div>`;
}
window._caltopoKeyDialog = function () {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100001;display:flex;align-items:center;justify-content:center;';
  const inp = (id, ph, type = 'text') => `<input id="${id}" type="${type}" placeholder="${ph}" autocomplete="off" style="width:100%;box-sizing:border-box;margin:3px 0 8px;padding:5px 7px;background:#111;color:#fff;border:1px solid #555;border-radius:4px;font-size:12px;">`;
  ov.innerHTML = `<div style="background:#1b1b28;color:#eee;padding:16px 18px;border-radius:8px;width:440px;max-width:92vw;font:12px system-ui,sans-serif;">
    <div style="font-size:14px;font-weight:600;margin-bottom:6px;">CalTopo key for private maps</div>
    <div style="opacity:.7;line-height:1.45;margin-bottom:10px;">Stored only on this computer's FLEX server (user_files, not in git, not in projects or sync files). FLEX reads maps with it; it never writes.<br>
      <b>Team:</b> Team Admin → Details → add a service account (READ): credential ID, secret, team ID.<br>
      <b>Personal:</b> the credential from caltopo.com/api/v1/activate (code = credential ID, key, account id) — unofficial.</div>
    Credential ID ${inp('ctk-id', 'e.g. 12 characters')}
    Key / secret ${inp('ctk-key', '~44 characters', 'password')}
    Account or team ID (optional — to pick maps from a list) ${inp('ctk-acct', '6 characters')}
    <div id="ctk-msg" style="color:#f88;min-height:14px;margin-bottom:6px;"></div>
    <div style="display:flex;justify-content:flex-end;gap:6px;"><button id="ctk-cancel" class="btn btn-sm btn-secondary">Cancel</button><button id="ctk-save" class="btn btn-sm btn-primary">Save</button></div></div>`;
  document.body.appendChild(ov);
  const $ = id => ov.querySelector('#' + id);
  $('ctk-cancel').onclick = () => ov.remove();
  $('ctk-save').onclick = async () => {
    const r = await fetch('/api/caltopo/key', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: $('ctk-id').value.trim(), key: $('ctk-key').value.trim(), accountId: $('ctk-acct').value.trim() }) });
    const j = await r.json();
    if (!r.ok) { $('ctk-msg').textContent = j.error || 'Could not save'; return; }
    ov.remove();
    await _renderCaltopoKey();
    if (j.accountId) window._caltopoPickMap(); else if (caltopoState.url) _fetchCaltopoKml();
  };
  setTimeout(() => $('ctk-id').focus(), 30);
};
window._caltopoKeyClear = async function () {
  if (!confirmDialogFree('Remove the CalTopo key from this computer? Private maps stop loading until a key is added again.')) return;
  await fetch('/api/caltopo/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  _renderCaltopoKey();
};
function confirmDialogFree(msg) { return window.confirm ? window.confirm(msg) : true; }
window._caltopoPickMap = async function () {
  const box = document.getElementById('caltopo_key_section');
  const st = document.createElement('div'); st.textContent = 'Reading your maps…'; st.style.cssText = 'opacity:.7;margin-top:3px;';
  box.appendChild(st);
  let j;
  try { const r = await fetch('/api/caltopo/maps'); j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); }
  catch (e) { st.textContent = '⚠ ' + (e.message || e); st.style.color = '#f88'; return; }
  st.remove();
  const sel = document.createElement('select');
  sel.style.cssText = 'width:100%;margin-top:4px;font-size:11px;background:#1a1a2e;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:4px;';
  sel.innerHTML = '<option value="">— choose a map (' + j.maps.length + ') —</option>' + j.maps.map(m =>
    `<option value="${m.id}">${(m.folder ? m.folder + ' / ' : '') + String(m.title).replace(/</g, '&lt;')}</option>`).join('');
  sel.onchange = () => {
    if (!sel.value) return;
    const input = document.getElementById('caltopo_url_input');
    if (input) input.value = 'https://caltopo.com/m/' + sel.value;
    window._loadCaltopo();
    sel.remove();
  };
  box.appendChild(sel);
};
setTimeout(_renderCaltopoKey, 500);

// ── CalTopo authentication (bookmarklet-based) ────────────────────────────────

async function caltopoLogin(cookie) {
  if (!cookie) return;
  _setCaltopoStatus('applying session…', '#aaa');
  try {
    const r    = await fetch('/caltopo/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cookie }),
    });
    const data = await r.json();
    if (data.ok) {
      _showCaltopoLoggedIn();
      _setCaltopoStatus('', '');
      if (caltopoState.url) _fetchCaltopoKml();
    } else {
      _setCaltopoStatus(`⚠ ${data.error}`, '#f88');
    }
  } catch (e) {
    _setCaltopoStatus('⚠ request failed', '#f88');
  }
}

async function caltopoLogout() {
  await fetch('/caltopo/logout', { method: 'POST' }).catch(() => {});
  _showCaltopoLoginForm();
  _setCaltopoStatus('', '');
}

function _showCaltopoLoggedIn() {
  const loginEl = document.getElementById('caltopo_login_section');
  const inEl    = document.getElementById('caltopo_loggedin_section');
  if (loginEl) loginEl.style.display = 'none';
  if (inEl)    inEl.style.display    = 'flex';
}

function _showCaltopoLoginForm() {
  const loginEl = document.getElementById('caltopo_login_section');
  const inEl    = document.getElementById('caltopo_loggedin_section');
  if (loginEl) loginEl.style.display = 'flex';
  if (inEl)    inEl.style.display    = 'none';
}

window._caltopoLogout = () => caltopoLogout();

// Build bookmarklet href dynamically — runs on caltopo.com, sends document.cookie to FLEX
(function _initCaltopoBookmarklet() {
  const origin = window.location.origin;
  const code = `(function(){` +
    `fetch('${origin}/caltopo/login',{` +
      `method:'POST',` +
      `headers:{'Content-Type':'application/json'},` +
      `body:JSON.stringify({cookie:document.cookie})` +
    `}).then(function(r){return r.json()})` +
    `.then(function(d){alert(d.ok?'\u2713 FLEX connected to CalTopo!':'\u26a0 '+d.error)})` +
    `.catch(function(){alert('\u26a0 Could not reach FLEX \u2014 is the server running?')})` +
  `})()`;
  const link = document.getElementById('caltopo_bookmarklet_link');
  if (link) link.href = 'javascript:' + code;
}());

  return { caltopoState, loadCaltopoKml, clearCaltopo, renderCaltopoStatus, _fetchCaltopoKml, _showCaltopoLoggedIn };
}
