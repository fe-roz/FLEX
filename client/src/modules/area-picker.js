// area-picker.js — pick an AREA on the map: a polygon (or the export box) with its outline drawn, its size
// shown, ready to hand to a job (⛰ Generate in the Terrain panel today; the Export dialog could use the same
// picker later: it only returns { bbox, polygon, label, crossing, km2 }).
//
// Where the area comes from (a <select> in the picker):
//   ✏ drawn on the map   click corners, Enter or Done closes it, Backspace undoes, Esc cancels
//   📁 the project's footprint + a margin (default 200 m; the footprint's convex hull grown by the margin)
//   📁 / 👤 / CalTopo / data-file polygons: any area shown on the map (project areas, My data areas, a CalTopo
//      map's shapes, areas in a loaded KML / GeoJSON / GPX data file), listed by name
//   ▭ the Export panel's box or polygon (window._exportArea, as before)
//
// Browser: window._areaPicker = { create(opts), ...pure functions }.  Node (tests): module.exports, the pure part.
//   ringAreaM2(ring) / ringKm2(ring)   area of a [[lon, lat]…] ring (local flat metres)
//   bboxOf(ring), convexHull(pts), grow(ring, metres)   (grow = hull of circles round the corners = the margin)
//   selfCrossing(ring)                 do two edges cross?
//   areaOf(ring | bbox, label)         { bbox, polygon, label, crossing, km2 } (the shape window._exportArea has)
//
// create({ host, units?, footprint?, onChange? }) → { el, area(), refresh(), draw(), cancel(), choose(key), clear(), sources(), destroy() }
//   host        element the picker fills
//   footprint   async () → [[lon, lat]…] the project's footprint (none → no footprint choice)
//   hasFootprint  () → bool, whether the footprint choice is offered now (a project is open)
//   onChange    called with the area (or null) when it changes
(function (root) {
  'use strict';
  const M_LAT = 110540;
  const mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

  // ── Pure ─────────────────────────────────────────────────────────────────
  /** Area of a ring in square metres (flat, local scale: fine up to tens of km). */
  function ringAreaM2(ring) {
    if (!ring || ring.length < 3) return 0;
    const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length, mx = mLon(lat0);
    let s = 0;
    ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; s += p[0] * mx * q[1] * M_LAT - q[0] * mx * p[1] * M_LAT; });
    return Math.abs(s) / 2;
  }
  const ringKm2 = ring => ringAreaM2(ring) / 1e6;
  function bboxOf(ring) {
    const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }
  /** Convex hull (monotone chain) of [[x, y]…]. */
  function convexHull(pts) {
    const p = pts.map(q => [+q[0], +q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }
  /** A footprint ring grown by m metres: the hull of 16-point circles round its corners. m = 0: its hull. */
  function grow(fp, m) {
    if (!fp || !fp.length) return [];
    const lat0 = fp.reduce((a, p) => a + p[1], 0) / fp.length, mx = mLon(lat0), pts = [];
    if (!(m > 0)) return convexHull(fp).map(p => [+p[0].toFixed(8), +p[1].toFixed(8)]);
    fp.forEach(([lo, la]) => { for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; pts.push([lo + m * Math.cos(a) / mx, la + m * Math.sin(a) / M_LAT]); } });
    return convexHull(pts).map(p => [+p[0].toFixed(8), +p[1].toFixed(8)]);
  }
  function selfCrossing(ring) {
    const n = ring ? ring.length : 0;
    if (n < 4) return false;
    const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
    const hit = (a, b, c, d) => ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;                       // neighbours share a corner
      if (hit(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
    return false;
  }
  /** { bbox, polygon, label, crossing, km2 } from a ring (3+ points). */
  function areaOf(ring, label) {
    const r = ring.map(p => [+p[0], +p[1]]);
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    return { bbox: bboxOf(r), polygon: r, label: label || '', crossing: selfCrossing(r), km2: ringKm2(r) };
  }
  /** The same from a box [w, s, e, n]. */
  function areaOfBox(b, label) {
    const ring = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    return { bbox: b.slice(), polygon: null, label: label || 'box', crossing: false, km2: ringKm2(ring) };
  }
  const pure = { ringAreaM2, ringKm2, bboxOf, convexHull, grow, selfCrossing, areaOf, areaOfBox };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root) return;

  // ── Browser ──────────────────────────────────────────────────────────────
  const V = () => root.cesiumViewer;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** km² (metric) or mi² (imperial), by window._units. */
  const fmtArea = km2 => {
    const imp = root._units && root._units.system && root._units.system() === 'imperial', v = imp ? km2 * 0.386102 : km2;
    return v.toFixed(v < 0.1 ? 3 : 2) + (imp ? ' mi²' : ' km²');
  };
  let seq = 0;

  /** Areas on the map: [{ key, group, name, ring }] — project areas, My data areas, CalTopo shapes, data-file areas. */
  async function mapPolygons() {
    const out = [], pj = root._pj || {}, FL = root.FlexLib, ws = root._ws, ring = c => (c || []).map(p => [+p[0], +p[1]]);
    try { if (pj.pid && pj.P && FL) FL.liveFeatures(pj.P).filter(f => f.kind === 'area' && f.coords && f.coords.length >= 3).forEach(f => out.push({ key: 'p:' + f.id, group: '📁 Project areas', name: f.name || 'Area', ring: ring(f.coords) })); } catch (_) {}
    try {
      const MD = root._myData;
      if (MD && MD.state) { const S = await MD.state(); Object.values(S.features || {}).filter(f => !f.removed && f.kind === 'area' && f.coords && f.coords.length >= 3).forEach(f => out.push({ key: 'm:' + f.id, group: '👤 My data areas', name: f.name || 'Area', ring: ring(f.coords) })); }
    } catch (_) {}
    try {
      const walk = root._pjf && root._pjf.walk;
      if (ws && ws.vectorSources && walk) {
        ws.vectorSources().forEach((s, i) => {
          if (!s.ds || (s.ds.show === false)) return;                      // shown on the map only
          const ct = s.kind === 'caltopo', group = ct ? 'CalTopo shapes' : '📄 ' + (s.name || s.url || 'Data file');
          walk(s.ds).filter(f => f.kind === 'area' && f.coords.length >= 3).forEach((f, k) => out.push({ key: (ct ? 'c:' : 'f' + i + ':') + k, group, name: f.name || 'Area', ring: ring(f.coords) }));
        });
      }
    } catch (e) { console.warn('[area-picker] map polygons', e); }
    return out;
  }

  function create(opts) {
    opts = opts || {};
    const id = 'ap' + (++seq), host = opts.host;
    const st = { sel: '', drawn: null, polys: [], fpRing: null, margin: 200, draft: null, hover: null, handler: null, onKey: null, ds: null, ents: [], fpKey: '' };
    host.classList.add('ap-box');
    host.innerHTML = `<div class="ap-r"><label>Area</label><select class="ap-src" title="Where the area comes from"></select> <button type="button" class="ap-draw" title="Click the corners on the map">✏ Draw…</button></div>
      <div class="ap-r ap-mrow" hidden>Footprint + <input type="number" class="ap-margin" value="200" min="0" max="5000" step="50"> m</div>
      <div class="ap-draftbar" hidden><span class="ap-hint"></span> <button type="button" class="ap-done">Done</button> <button type="button" class="ap-cancel">Cancel</button></div>
      <div class="ap-note"></div><div id="${id}-pick-banner" class="pjf-banner ap-banner" hidden></div>`;
    const $ = c => host.querySelector(c);
    const src = $('.ap-src'), note = $('.ap-note'), mrow = $('.ap-mrow'), bar = $('.ap-draftbar');
    if (opts.margin != null) { st.margin = opts.margin; $('.ap-margin').value = opts.margin; }

    // ── The outline on the map ──
    const ensureDs = () => {
      const v = V(); if (!v || !root.Cesium) return null;
      if (!st.ds || !v.dataSources.contains(st.ds)) { st.ds = new Cesium.CustomDataSource('area-picker'); v.dataSources.add(st.ds); }
      return st.ds;
    };
    function outline(ring, draft) {
      const ds = ensureDs(); if (!ds) return;
      ds.entities.removeAll();
      if (!ring || ring.length < 2) { const v = V(); if (v && v.scene.requestRender) v.scene.requestRender(); return; }
      const pos = ring.map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1]));
      const col = Cesium.Color.fromCssColorString('#00e5ff');
      ds.entities.add({ polyline: { positions: draft ? pos : pos.concat([pos[0]]), width: 3, material: col, clampToGround: true } });
      if (!draft && ring.length >= 3) ds.entities.add({ polygon: { hierarchy: pos, material: col.withAlpha(0.12), classificationType: Cesium.ClassificationType.TERRAIN } });
      if (draft) ring.forEach(p => ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(p[0], p[1]), point: { pixelSize: 8, color: Cesium.Color.WHITE, outlineColor: col, outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
      const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
    }

    // ── The sources ──
    function sources() {
      const out = [{ key: '', group: '', name: '— choose an area —' }];
      if (opts.footprint && (!opts.hasFootprint || opts.hasFootprint())) out.push({ key: 'fp', group: '', name: '📁 Project footprint + margin' });
      if (st.drawn) out.push({ key: 'draw', group: '', name: '✏ Drawn on the map' });
      if (root._exportArea && root._exportArea()) out.push({ key: 'export', group: '', name: '▭ Export panel box' });
      st.polys.forEach(p => out.push(p));
      return out;
    }
    function fillSelect() {
      const was = st.sel, list = sources();
      let html = '', grp = null;
      list.forEach(s => {
        if (s.group !== grp) { if (grp) html += '</optgroup>'; grp = s.group; if (grp) html += `<optgroup label="${esc(grp)}">`; }
        html += `<option value="${esc(s.key)}">${esc(s.name)}</option>`;
      });
      if (grp) html += '</optgroup>';
      if (src.innerHTML !== html) src.innerHTML = html;
      src.value = list.some(s => s.key === was) ? was : '';
      if (src.value !== was) st.sel = src.value;
    }

    let cur = null;
    /** The area for the current choice (or null). */
    async function compute() {
      const k = st.sel;
      mrow.hidden = k !== 'fp';
      if (k === 'fp' && opts.footprint && (!opts.hasFootprint || opts.hasFootprint())) {
        let fp = []; try { fp = await opts.footprint(); } catch (e) { console.warn('[area-picker] footprint', e); }
        st.fpRing = fp;
        const ring = grow(fp, st.margin);
        return ring.length >= 3 ? areaOf(ring, `project area + ${st.margin} m`) : null;
      }
      if (k === 'draw' && st.drawn) return areaOf(st.drawn, 'drawn');
      if (k === 'export') { const a = root._exportArea && root._exportArea(); if (!a) return null; return a.polygon ? Object.assign(areaOf(a.polygon, a.label || 'polygon'), { crossing: !!a.crossing }) : areaOfBox(a.bbox, 'box'); }
      const p = st.polys.find(x => x.key === k);
      if (p) return areaOf(p.ring, p.name);
      return null;
    }
    function show() {
      if (st.draft) return;
      if (!cur) { note.innerHTML = 'No area chosen. Draw one, or pick a footprint, a polygon on the map, or the Export box.'; outline(null); return; }
      note.innerHTML = `${cur.polygon ? '⬠ ' + esc(cur.label || 'polygon') : '▭ box'}, <b class="ap-km2">${esc(fmtArea(cur.km2))}</b>${cur.crossing ? ' <b class="ap-bad">Its edges cross.</b>' : ''}`;
      if (st.sel === 'export') outline(null);                               // the Export panel draws its own
      else outline(cur.polygon);
    }
    let token = 0;
    async function update(fly) {
      const t = ++token; fillSelect();
      const a = await compute();
      if (t !== token) return cur;
      const changed = JSON.stringify(a && a.polygon || a && a.bbox) !== JSON.stringify(cur && cur.polygon || cur && cur.bbox);
      cur = a; show();
      if (fly && a) flyTo(a);
      if (changed && opts.onChange) opts.onChange(a);
      return a;
    }
    function flyTo(a) {
      const v = V(); if (!v || !root.Cesium) return;
      const [w, s, e, n] = a.bbox, pad = 0.15 * Math.max(e - w, n - s);
      try { v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w - pad, s - pad, e + pad, n + pad), duration: 1.2 }); } catch (_) {}
    }
    async function refresh() { if (st.draft) return cur; st.polys = await mapPolygons(); return update(false); }
    function choose(key, fly) { st.sel = key || ''; src.value = st.sel; return update(fly !== false); }

    src.addEventListener('change', () => { st.sel = src.value; update(true); });
    $('.ap-margin').addEventListener('change', e => { st.margin = Math.max(0, Math.min(5000, +e.target.value || 0)); update(true); });

    // ── Drawing ──
    const pick = pos => { try { const v = V(); return v.scene.globe.pick(v.camera.getPickRay(pos), v.scene) || null; } catch (_) { return null; } };
    const lonlat = pos => { const c = pick(pos); if (!c) return null; const k = Cesium.Cartographic.fromCartesian(c); return [+Cesium.Math.toDegrees(k.longitude).toFixed(8), +Cesium.Math.toDegrees(k.latitude).toFixed(8)]; };
    const hint = () => {
      const n = st.draft ? st.draft.length : 0, banner = $('.ap-banner');
      $('.ap-hint').textContent = n < 3 ? `Click the corners on the map (${n}) · Backspace undoes · Esc cancels` : `${n} corners · Enter or Done closes it · Backspace undoes · Esc cancels`;
      $('.ap-done').disabled = n < 3;
      banner.hidden = false; banner.textContent = $('.ap-hint').textContent;
    };
    function stopDraw() {
      if (st.handler) { st.handler.destroy(); st.handler = null; }
      if (st.onKey) { document.removeEventListener('keydown', st.onKey, true); st.onKey = null; }
      root._apDrawing = false; st.draft = null; st.hover = null; bar.hidden = true; $('.ap-banner').hidden = true; $('.ap-draw').disabled = false;
    }
    function finish() {
      const pts = st.draft || [];
      if (pts.length < 3) return;
      stopDraw();
      st.drawn = pts; st.sel = 'draw'; update(false);
    }
    function cancel() { if (!st.draft) return; stopDraw(); update(false); }
    function draw() {
      const v = V(); if (!v || !root.Cesium || st.draft) return;
      root._apDrawing = true;                                           // flex-rail.js: a map click is not “close the panel” now
      st.draft = []; $('.ap-draw').disabled = true; bar.hidden = false;
      const redraw = () => outline(st.draft.concat(st.hover && st.draft.length ? [st.hover] : []), true);
      hint(); outline(null);
      st.onKey = e => {
        if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
        else if (e.key === 'Enter' && st.draft && st.draft.length >= 3) { e.preventDefault(); finish(); }
        else if (e.key === 'Backspace' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) { e.preventDefault(); st.draft.pop(); hint(); redraw(); }
      };
      document.addEventListener('keydown', st.onKey, true);
      st.handler = new Cesium.ScreenSpaceEventHandler(v.canvas);
      st.handler.setInputAction(mv => {
        const p = lonlat(mv.position); if (!p || !st.draft) return;
        st.draft.push(p); hint(); redraw();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      st.handler.setInputAction(() => {                                    // a double-click ON ONE SPOT closes it (Cesium also calls two quick clicks elsewhere a double-click)
        if (!st.draft || st.draft.length < 2) return;
        const scr = p => { const f = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates; return f(v.scene, Cesium.Cartesian3.fromDegrees(p[0], p[1])); };
        const a = scr(st.draft[st.draft.length - 1]), b = scr(st.draft[st.draft.length - 2]);
        if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > 6) return;
        st.draft.pop();                                                    // the double-click's two clicks added a point twice: keep one
        if (st.draft.length >= 3) finish(); else { hint(); redraw(); }
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      st.handler.setInputAction(mv => { if (st.draft && st.draft.length) { st.hover = lonlat(mv.endPosition); redraw(); } }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      st.handler.setInputAction(() => { if (st.draft) { st.draft.pop(); hint(); redraw(); } }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    }
    $('.ap-draw').addEventListener('click', draw);
    $('.ap-done').addEventListener('click', finish);
    $('.ap-cancel').addEventListener('click', cancel);

    function clear() { stopDraw(); st.drawn = null; st.sel = ''; cur = null; fillSelect(); show(); if (opts.onChange) opts.onChange(null); }
    function destroy() { stopDraw(); outline(null); const v = V(); if (v && st.ds) { try { v.dataSources.remove(st.ds, true); } catch (_) {} } st.ds = null; host.innerHTML = ''; }
    refresh();
    return { el: host, area: () => cur, refresh, draw, cancel, finish, choose, clear, sources, destroy, outline: on => outline(on === false ? null : cur && cur.polygon), isDrawing: () => !!st.draft,
      setMargin: m => { st.margin = m; $('.ap-margin').value = m; return update(false); }, margin: () => st.margin };
  }

  root._areaPicker = Object.assign({ create, mapPolygons, fmtArea }, pure);

  const css = document.createElement('style');
  css.textContent = `
  .ap-box { display: flex; flex-direction: column; gap: 4px; }
  .ap-box .ap-r { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; color: rgba(255,255,255,.8); font-size: 11px; }
  .ap-box select, .ap-box input { background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; padding: 1px 4px; font-size: 11px; min-width: 0; }
  .ap-box .ap-src { flex: 1; } .ap-box .ap-margin { width: 60px; }
  .ap-box button { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #e8ece9; border-radius: 5px; padding: 2px 8px; font-size: 10.5px; cursor: pointer; }
  .ap-box button:disabled { opacity: .45; cursor: default; }
  .ap-box .ap-draftbar { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 10.5px; color: #9fe3bd; }
  .ap-box .ap-draftbar[hidden], .ap-box .ap-mrow[hidden], .ap-box .ap-banner[hidden] { display: none; }
  .ap-box .ap-note { color: rgba(255,255,255,.6); font-size: 10.5px; line-height: 1.35; } .ap-box .ap-bad { color: #ff7a7a; }
  .ap-box .ap-banner { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); z-index: 9000; background: rgba(0,0,0,.78); color: #fff; padding: 5px 12px; border-radius: 6px; font-size: 12px; pointer-events: none; }`;
  document.head.appendChild(css);
})(typeof window !== 'undefined' ? window : null);
