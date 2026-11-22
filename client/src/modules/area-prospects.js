// area-prospects.js — the Prospects result of a processed area (analyze-area.js, server: areas_api.js + prospect.py).
// Possible cave entrances from the area's LiDAR: A closed depressions, B clusters of returns below the ground, C cliff-side
// openings. A list to look at, not a ranking: flags (isolated / wide / measured) are shown and the filters here act at once.
//
//   sync(want, areas)   analyze-area.js apply(): draws the candidates of areas whose Prospects switch is on (one
//                       PointPrimitiveCollection per area, ~2000 points are cheap), hides the rest
//   mount(box)          after analyze-area.js paints the processed-areas list: fills each .ar-prospect placeholder
//                       (counts, filters, "showing X of Y", the three image layers, KML / CSV, Add shown to My data)
//   known()             the points sent to prospect.py as options.prospect.known (My data points; known caves are not included)
//   forget(areaId)      the result was deleted
// Click on a candidate: a small popup (title, description, attributes). Nothing here goes to CalTopo.
// window._areaProspects = { known, sync, mount, forget, state, shownCount, setFilter, addToMyData, passes, pure }; Node: module.exports = pure.
(function (root) {
  'use strict';

  // ── Pure ─────────────────────────────────────────────────────────────────
  const DEFAULTS = { A: true, B: true, C: true, minPoints: 8, minDepth: 1.5, measured: true, hideWide: true, isolated: false };
  const COLOUR = { A: '#4ea1ff', B: '#ff5fc8', C: '#ffd23f' };
  /** Does one candidate (GeoJSON properties) pass the filters f? */
  function passes(p, f) {
    if (!p || !f[p.kind]) return false;
    if (p.isolated === true) return !!f.isolated && !(f.hideWide && p.wide === true);
    if (p.kind === 'A') return !f.measured || (+p.measured || 0) >= 0.5;
    if ((+p.points || 0) < f.minPoints) return false;
    if ((+p.depth_median_m || 0) < f.minDepth) return false;
    return !(f.hideWide && p.wide === true);
  }
  const SKIP = { id: 1, kind: 1, lon: 1, lat: 1, title: 1, description: 1, tag: 1, note: 1 };
  const LABELS = { depth_m: 'deepest (m)', depth_median_m: 'median depth (m)', depth_spread_m: 'depth spread (m)', shallowest_m: 'shallowest (m)', span_m: 'span (m)', area_m2: 'area (m2)',
    rim_to_floor_m: 'rim to floor (m)', rim_slope_deg: 'rim slope (deg)', measured: 'ground measured', floor_above: 'returns above', floor_above_h: 'lowest above (m)', nearest_known_m: 'nearest known (m)',
    nearest_known_name: 'nearest known', face_slope_deg: 'face slope (deg)', face_height_m: 'face height (m)', aspect_deg: 'facing (deg)', depth_into_face_m: 'into the face (m)', ground_z: 'ground height (m)', pit_id: 'area pit' };
  /** [[label, value]] of a candidate's attributes worth showing (empty values left out). */
  function attrs(p) {
    return Object.keys(p || {}).filter(k => !SKIP[k] && p[k] != null && p[k] !== '' && p[k] !== false).map(k => [LABELS[k] || k.replace(/_/g, ' '), p[k] === true ? 'yes' : p[k]]);
  }
  const attrText = p => attrs(p).map(a => a[0] + ': ' + a[1]).join('; ');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pure = { DEFAULTS, COLOUR, passes, attrs, attrText };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root) return;

  // ── Browser ──────────────────────────────────────────────────────────────
  const w = root, doc = root.document;
  const P = {};      // areaId -> { date, feats, iso, f (filters), coll, pts [{pt, ft}], shown, total, layers: { depth: {on, layer} }, on }
  let handler = null, popup = null, selected = null;
  const V = () => w.cesiumViewer;
  const base = id => '/api/areas/file/' + encodeURIComponent(id) + '/prospect/';
  const entry = id => (P[id] = P[id] || { f: Object.assign({}, DEFAULTS), feats: null, iso: null, coll: null, pts: [], shown: 0, total: 0, layers: { depth: {}, below: {}, steep: {} }, on: false, date: '' });
  const toast = m => { try { if (w.toast) w.toast(m); else if (w._pjApi && w._pjApi.toast) w._pjApi.toast(m); } catch (_) {} };
  const areaOf = id => { try { return w._areas.list().find(a => a.id === id); } catch (_) { return null; } };
  const redraw = () => { const v = V(); if (v && v.scene && v.scene.requestRender) v.scene.requestRender(); };

  /** My data points as "known" (cheap: already in memory). Known caves are not sent (no cheap list of entrances). */
  async function known() {
    try {
      const pts = w._myData && w._myData.points ? await w._myData.points() : [];
      return pts.filter(p => Number.isFinite(p.lon) && Number.isFinite(p.lat)).slice(0, 5000).map(p => ({ lon: +p.lon.toFixed(6), lat: +p.lat.toFixed(6), name: String(p.name || '').slice(0, 60) }));
    } catch (_) { return []; }
  }

  // Drawing
  function ensureHandler() {
    const v = V(); if (handler || !v || !w.Cesium) return;
    handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction(e => {
      let o = null; try { o = v.scene.pick(e.position); } catch (_) {}
      const id = o && o.id; if (id && id.prospectArea && P[id.prospectArea]) openPopup(id.prospectArea, id.feat);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  function build(id) {
    const e = entry(id), v = V(); if (!v || !w.Cesium) return;
    if (e.coll && !e.coll.isDestroyed()) v.scene.primitives.remove(e.coll);
    e.coll = v.scene.primitives.add(new Cesium.PointPrimitiveCollection()); e.pts = [];
    const all = (e.feats || []).concat(e.f.isolated && e.iso ? e.iso : []);
    for (const ft of all) {
      const p = ft.properties, c = ft.geometry.coordinates;
      const pt = e.coll.add({ position: Cesium.Cartesian3.fromDegrees(c[0], c[1], 0), pixelSize: 8, color: Cesium.Color.fromCssColorString(COLOUR[p.kind] || '#ffffff').withAlpha(p.isolated ? 0.55 : 1),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY, id: { prospectArea: id, feat: ft } });
      e.pts.push({ pt, ft });
    }
    e.total = all.length; selected = null;
    heights(id, e.coll);
    refilter(id);
  }
  // Put the points on the terrain once (when the globe has real terrain; with none the heights stay 0).
  async function heights(id, coll) {
    const v = V(), e = P[id];
    if (!v || !e || !Cesium.sampleTerrainMostDetailed || !v.terrainProvider || v.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) return;
    try {
      const pts = e.pts.slice(), carts = pts.map(x => Cesium.Cartographic.fromDegrees(x.ft.geometry.coordinates[0], x.ft.geometry.coordinates[1]));
      const got = await Promise.race([Cesium.sampleTerrainMostDetailed(v.terrainProvider, carts), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20000))]);
      if (e.coll !== coll || coll.isDestroyed()) return;
      pts.forEach((x, i) => { const h = got[i] && got[i].height; if (Number.isFinite(h)) x.pt.position = Cesium.Cartesian3.fromDegrees(x.ft.geometry.coordinates[0], x.ft.geometry.coordinates[1], h + 1); });
      redraw();
    } catch (_) {}
  }
  function refilter(id) {
    const e = P[id]; if (!e) return;
    let n = 0;
    e.pts.forEach(x => { const s = passes(x.ft.properties, e.f); x.pt.show = s; if (s) n++; });
    e.shown = n; e.total = e.pts.length || e.total;
    if (e.coll && !e.coll.isDestroyed()) e.coll.show = !!e.on;
    const t = doc.querySelector('.ar-prospect[data-area="' + id + '"] .pr-showing'); if (t) t.textContent = showingText(id);
    const b = doc.querySelector('.ar-prospect[data-area="' + id + '"] [data-pa="mydata"]'); if (b) b.textContent = 'Add shown to My data (' + n + ')';
    redraw();
  }
  const showingText = id => { const e = P[id]; return !e || !e.feats ? 'Switch Prospects on to show them on the map.' : 'showing ' + e.shown + ' of ' + e.total; };

  async function load(id, date) {
    const e = entry(id);
    if (e.loading) return; e.loading = true;
    try {
      const j = await (await fetch(base(id) + 'candidates.geojson')).json();
      e.feats = (j.features || []).filter(f => f && f.geometry && f.properties); e.date = date; e.iso = null;
    } catch (err) { e.feats = []; console.warn('[prospects] load', err); toast('The prospects could not be read.'); }
    e.loading = false;
    build(id); mountOne(id);
  }
  async function loadIso(id) {
    const e = entry(id); if (e.iso || e.isoLoading) return; e.isoLoading = true;
    try { const j = await (await fetch(base(id) + 'candidates_isolated.geojson')).json(); e.iso = (j.features || []).filter(f => f && f.geometry && f.properties); }
    catch (_) { e.iso = []; }
    e.isoLoading = false; build(id); mountOne(id);
  }

  // Image layers (depth / below / steep): the bushwhack path, a single tile on the raster's own footprint
  async function setImage(id, name, on) {
    const e = entry(id), L = e.layers[name], v = V(); L.on = !!on;
    if (on && !L.layer && !L.loading && v && w.Cesium) {
      L.loading = true;
      try {
        if (!e.meta) e.meta = await (await fetch(base(id) + 'layers.json')).json();
        const b = e.meta[name] && e.meta[name].bounds;
        if (b) {
          const rect = Cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north), url = base(id) + name + '.png';
          const prov = Cesium.SingleTileImageryProvider.fromUrl ? await Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle: rect }) : new Cesium.SingleTileImageryProvider({ url, rectangle: rect });
          L.layer = v.imageryLayers.addImageryProvider(prov); L.layer.alpha = 0.7;
        }
      } catch (err) { console.warn('[prospects] image', name, err); }
      L.loading = false;
    }
    if (L.layer) L.layer.show = !!(L.on && e.on);
    redraw();
  }

  function sync(want, areas) {
    ensureHandler();
    const ids = new Set();
    (areas || []).forEach(a => {
      const r = a.results && a.results.prospect; if (!r) return;
      ids.add(a.id);
      const e = entry(a.id), on = want.some(x => x.id === a.id && x.result === 'prospect');
      e.on = on;
      if (e.date && e.date !== r.date) dispose(a.id);        // run again: read the new files
      if (on && !e.feats && !e.loading) load(a.id, r.date);
      if (e.coll && !e.coll.isDestroyed()) e.coll.show = on;
      Object.keys(e.layers).forEach(n => { if (e.layers[n].on) setImage(a.id, n, true); });
      if (!on && popup && popup.dataset.area === a.id) closePopup();
    });
    Object.keys(P).forEach(id => { if (!ids.has(id)) forget(id); });
  }
  function dispose(id) {
    const e = P[id], v = V(); if (!e) return;
    if (e.coll && !e.coll.isDestroyed() && v) v.scene.primitives.remove(e.coll);
    Object.keys(e.layers).forEach(n => { const L = e.layers[n]; if (L.layer && v) { try { v.imageryLayers.remove(L.layer, true); } catch (_) {} } e.layers[n] = { on: L.on }; });
    e.coll = null; e.pts = []; e.feats = null; e.iso = null; e.meta = null; e.shown = 0; e.total = 0; e.date = '';
  }
  function forget(id) { dispose(id); delete P[id]; if (popup && popup.dataset.area === id) closePopup(); }

  // Click → popup
  function openPopup(id, ft) {
    if (!popup) { popup = doc.createElement('div'); popup.className = 'pr-pop'; doc.body.appendChild(popup); popup.addEventListener('click', ev => { if (ev.target.dataset.pa === 'close') closePopup(); }); }
    const p = ft.properties;
    popup.dataset.area = id; popup.dataset.cand = p.id; popup.hidden = false;
    popup.innerHTML = `<button type="button" class="pr-x" data-pa="close" aria-label="Close">✕</button><div class="pr-pt"><span class="pr-dot" style="background:${COLOUR[p.kind] || '#fff'}"></span><b>${esc(p.title || p.id)}</b></div>
      <div class="pr-pd">${esc(p.description || '')}</div><table class="pr-tab">${attrs(p).map(a => `<tr><td>${esc(a[0])}</td><td>${esc(a[1])}</td></tr>`).join('')}</table>
      <div class="pr-dim">A candidate to check in the field, not a finding. Position ${(+ft.geometry.coordinates[1]).toFixed(5)}, ${(+ft.geometry.coordinates[0]).toFixed(5)}.</div>`;
    const e = P[id]; if (e) { if (selected) selected.pixelSize = 8; const x = e.pts.find(q => q.ft === ft); if (x) { x.pt.pixelSize = 13; selected = x.pt; } redraw(); }
  }
  function closePopup() { if (popup) popup.hidden = true; if (selected) { try { selected.pixelSize = 8; } catch (_) {} selected = null; } redraw(); }

  // The panel inside the processed-areas row
  function panelHtml(id, r) {
    const e = entry(id), f = e.f, c = r.counts || {}, ck = (k, label) => `<label class="pr-ck"><input type="checkbox" data-pf="${k}"${f[k] ? ' checked' : ''}> ${label}</label>`;
    const im = (k, label) => `<label class="pr-ck"><input type="checkbox" data-pi="${k}"${e.layers[k].on ? ' checked' : ''}> ${label}</label>`;
    return `<div class="pr-box">
      <div class="pr-counts"><span style="color:${COLOUR.A}">A</span> ${c.A || 0} sinks · <span style="color:${COLOUR.B}">B</span> ${c.B || 0} below the ground · <span style="color:${COLOUR.C}">C</span> ${c.C || 0} cliff openings · ${c.isolated || 0} isolated</div>
      <div class="pr-row">${ck('A', 'A sinks')}${ck('B', 'B below ground')}${ck('C', 'C cliff')}</div>
      <div class="pr-row"><label class="pr-n">at least <input type="number" min="1" max="500" step="1" data-pf="minPoints" value="${f.minPoints}"> points</label>
        <label class="pr-n">median depth at least <input type="number" min="0" max="50" step="0.5" data-pf="minDepth" value="${f.minDepth}"> m (B, C)</label></div>
      <div class="pr-row">${ck('measured', 'ground measured (A)')}${ck('hideWide', 'hide wide')}${ck('isolated', 'show isolated')}</div>
      <div class="pr-showing" aria-live="polite">${esc(showingText(id))}</div>
      <div class="pr-row pr-dim">Images:</div><div class="pr-row">${im('depth', 'depth')}${im('below', 'below')}${im('steep', 'steep')}</div>
      <div class="pr-row"><a class="ar-btn" href="${base(id)}candidates.kml" download="prospects.kml" data-pa="kml">Download KML</a><a class="ar-btn" href="${base(id)}candidates.csv" download="prospects.csv" data-pa="csv">Download CSV</a>
        <button type="button" class="ar-btn" data-pa="mydata" data-area="${esc(id)}">Add shown to My data (${e.shown})</button></div>
      <div class="pr-dim">The KML and CSV hold every candidate. Nothing here is sent to CalTopo.${r.known ? ' Known points used: ' + r.known + '.' : ''}</div></div>`;
  }
  function mountOne(id) {
    const a = areaOf(id), r = a && a.results && a.results.prospect;
    doc.querySelectorAll('.ar-prospect[data-area="' + id + '"]').forEach(h => { if (r) h.innerHTML = panelHtml(id, r); });
  }
  function mount(box) { (box || doc).querySelectorAll('.ar-prospect[data-area]').forEach(h => mountOne(h.dataset.area)); }
  function setFilter(id, k, v) {
    const e = entry(id);
    if (k === 'minPoints' || k === 'minDepth') { v = +v; if (!Number.isFinite(v) || v < 0) return; }
    e.f[k] = v;
    if (k === 'isolated') { if (v && !e.iso) loadIso(id); else if (e.feats) build(id); return; }
    refilter(id);
  }
  const shownCount = id => (P[id] ? P[id].shown : 0);

  async function addToMyData(id) {
    const e = P[id], a = areaOf(id); if (!e || !e.pts.length || !w._myData || !w._myData.adopt) { toast('Switch Prospects on first.'); return { ok: false }; }
    const list = e.pts.filter(x => x.pt.show).map(x => x.ft);
    if (!list.length) { toast('No candidates are shown.'); return { ok: false }; }
    const day = new Date().toISOString().slice(0, 10), group = 'Prospects ' + (a ? a.name : 'area') + ' ' + day;
    const items = list.map(ft => { const p = ft.properties, c = ft.geometry.coordinates;
      return { id: 'prospect-' + id + '-' + p.id + (p.isolated ? '-i' : ''), kind: 'point', coords: [[c[0], c[1]]], name: String(p.title || p.id).slice(0, 120), desc: ((p.description || '') + '\n' + attrText(p)).slice(0, 4000),
        group, color: COLOUR[p.kind], style: { prospect: { id: p.id, kind: p.kind, area: id } }, orig: { prospect: { id: p.id, kind: p.kind, area: id, isolated: !!p.isolated, tag: p.tag || '', note: p.note || '' } } }; });
    try {
      await w._myData.adopt(items);
      if (w._surfCols && w._surfCols.refresh) try { w._surfCols.refresh(); } catch (_) {}
      toast(items.length + ' candidates added to My data in "' + group + '".');
      return { ok: true, count: items.length, group };
    } catch (err) { console.warn('[prospects] my data', err); toast('Could not add them: ' + (err.message || err)); return { ok: false }; }
  }

  doc.addEventListener('change', ev => {
    const t = ev.target, h = t.closest && t.closest('.ar-prospect'); if (!h) return;
    if (t.dataset.pf) setFilter(h.dataset.area, t.dataset.pf, t.type === 'checkbox' ? t.checked : t.value);
    else if (t.dataset.pi) setImage(h.dataset.area, t.dataset.pi, t.checked);
  });
  doc.addEventListener('input', ev => { const t = ev.target, h = t.closest && t.closest('.ar-prospect'); if (h && t.dataset.pf && t.type === 'number') setFilter(h.dataset.area, t.dataset.pf, t.value); });
  doc.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('[data-pa="mydata"]'); if (b) { b.disabled = true; addToMyData(b.dataset.area).then(() => { b.disabled = false; }); }
  });

  const css = doc.createElement('style');
  css.textContent = `
  .pr-box { margin-top: 5px; font-size: 11px; display: flex; flex-direction: column; gap: 4px; }
  .pr-row { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
  .pr-ck, .pr-n { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
  .pr-n input[type=number] { width: 52px; background: #1a1a2e; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 2px 4px; font-size: 11px; }
  .pr-showing { font-weight: 600; color: #6fd49b; }
  .pr-dim { color: rgba(255,255,255,.55); font-size: 10.5px; }
  .pr-pop { position: fixed; right: 14px; top: 64px; width: 330px; max-width: calc(100vw - 28px); max-height: calc(100vh - 100px); overflow: auto; z-index: 9600; background: rgba(20,24,22,.97); color: #e8ece9; border: 1px solid #3a4440; border-radius: 8px; padding: 10px 12px; font-size: 12px; }
  .pr-pop[hidden] { display: none; }
  .pr-x { position: absolute; right: 6px; top: 4px; background: none; border: 0; color: rgba(255,255,255,.6); cursor: pointer; font-size: 13px; }
  .pr-pt { display: flex; align-items: center; gap: 7px; margin-right: 18px; } .pr-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .pr-pd { margin: 6px 0; color: rgba(255,255,255,.82); } .pr-tab { border-collapse: collapse; width: 100%; margin-bottom: 6px; }
  .pr-tab td { padding: 1px 4px 1px 0; border-top: 1px solid rgba(255,255,255,.08); font-size: 11px; vertical-align: top; } .pr-tab td:first-child { color: rgba(255,255,255,.55); white-space: nowrap; }`;
  doc.head.appendChild(css);

  w._areaProspects = { known, sync, mount, forget, shownCount, setFilter, addToMyData, passes, pure, closePopup,
    state: () => Object.keys(P).reduce((o, id) => { const e = P[id]; o[id] = { on: e.on, loaded: !!e.feats, total: e.total, shown: e.shown, drawn: e.coll && !e.coll.isDestroyed() ? e.coll.length : 0, filters: Object.assign({}, e.f),
      images: Object.keys(e.layers).filter(k => e.layers[k].on), popup: popup && !popup.hidden ? popup.dataset.cand : null }; return o; }, {}) };
})(typeof window !== 'undefined' ? window : null);
