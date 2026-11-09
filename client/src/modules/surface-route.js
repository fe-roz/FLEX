// surface-route.js — 🔬 Analyze → "Surface route": the best way to walk over the ground from one or more starts to one end,
// weighing distance, steepness, brush (low vegetation from the LiDAR), cliffs, sun and any trails or roads you have drawn.
// The search itself is route_cost.py on the server (route_api.js, /api/route/*); this file is the panel:
//
//   Picks      End (one) and Starts (one or more): click on the ground, or choose a point from the project, My data, CalTopo or
//              a file (a cave entrance is a point with the flex: tag). A chip per pick with ×. Drawn on the map as S1, S2 … and E.
//              Or the chip "Any ticked road or trail": every cell under the ticked trails is a start (params.start_lines; the
//              ticked trails are still sent as params.trails), the route is the cheapest to any of them ("from road: <name>").
//   Source     the LiDAR: point clouds loaded now (their ORIGINAL url, captured when they were added) and the open project's
//              own point cloud layers; tick one or several. Cell, DEM (below / above / both), brush band.
//   Weights    sliders (Distance, Steepness, Brush, Cliffs, Sun, Trails, Roads), presets (Easiest, Shortest, Least brush,
//              Shadiest, Least climb) and "Save as my preset" (this computer, localStorage flex.surfroute.presets).
//   Trails     lines whose name or folder says trail / path / road (project, My data, CalTopo, files) go to params.trails with
//              kind trail|road; any other line can be ticked in. Roads: kind road.
//   Find routes   POST /api/route/plan → a job in the Jobs panel; when it is done, one card per option. After a first run,
//              moving a slider (or a preset) re-runs after a short pause with `reuse` = the last job, so the area's grids are
//              not built again.
//   Results    cards (recommended first); tap = highlight on the map + the height graph and points within ~10 m
//              (route-stats.js routeNode); "Save as project line…" (project or My data); overlays (brush, slope, shade,
//              hillshade) over the grid's bounds with opacity.
//
// window._surfRoute = { setAnyRoad, state, run, results, select, selected, addPick, removePick, setPick, clearPicks, candidates, datasets,
//   setWeights, weights, preset, presets, savePreset, trails, setTrail, params, saveLine, overlay, overlays, setOpacity,
//   pickOnMap, stopPick, zoomTo, clear, refresh, cancelRerun, pure }
// Node (tools/test_surface_route.js): module.exports = pure helpers.
(function (root) {
  'use strict';

  // ── Pure helpers ──────────────────────────────────────────────────────────
  const WDEF = { distance: 1, steep: 1, brush: 1, cliff: 0.5, sun: 0, trail: 1, road: 1 };
  const PRESETS = {
    easiest:     { label: 'Easiest',     w: { distance: 1,   steep: 1,   brush: 1,   cliff: 0.5, sun: 0,  trail: 1,   road: 1 } },
    shortest:    { label: 'Shortest',    w: { distance: 3,   steep: 0.3, brush: 0.3, cliff: 0.7, sun: 0,  trail: 0.5, road: 0.5 } },
    least_brush: { label: 'Least brush', w: { distance: 0.5, steep: 0.5, brush: 3,   cliff: 0.5, sun: 0,  trail: 1,   road: 1 } },
    shadiest:    { label: 'Shadiest',    w: { distance: 0.7, steep: 0.7, brush: 0.7, cliff: 0.5, sun: -1, trail: 1,   road: 1 } },
    least_climb: { label: 'Least climb', w: { distance: 0.5, steep: 3,   brush: 0.5, cliff: 0.3, sun: 0,  trail: 1,   road: 1 } },
  };
  const SLIDERS = [
    { k: 'distance', label: 'Distance',  min: 0,  max: 3, step: 0.1,  lo: 'ignore', hi: 'keep it short', tip: 'How much a longer way matters' },
    { k: 'steep',    label: 'Steepness', min: 0,  max: 3, step: 0.1,  lo: 'ignore', hi: 'avoid steep',   tip: 'How much steep ground costs, going up or down' },
    { k: 'brush',    label: 'Brush',     min: 0,  max: 3, step: 0.1,  lo: 'ignore', hi: 'avoid brush',   tip: 'How much low vegetation (from the LiDAR) costs' },
    { k: 'cliff',    label: 'Cliffs',    min: 0,  max: 1, step: 0.05, lo: 'Blocked', hi: 'Very costly',  tip: 'Blocked: never cross a cliff. Very costly: only when there is no way round' },
    { k: 'sun',      label: 'Sun',       min: -1, max: 1, step: 0.1,  lo: 'Prefer shade', hi: 'Prefer sun', tip: 'Sun at noon at the equinox, trees over 3 m and the terrain shadow' },
    { k: 'trail',    label: 'Trails',    min: 0,  max: 1, step: 0.05, lo: 'no help', hi: 'much easier',  tip: 'How good a trail is to walk on, next to bushwhacking' },
    { k: 'road',     label: 'Roads',     min: 0,  max: 1, step: 0.05, lo: 'no help', hi: 'much easier',  tip: 'How good a road is to walk on' },
  ];
  const ROAD_RE = /\b(roads?|rd|jeep|4wd|4x4|fire ?roads?|forest ?roads?|dirt ?roads?)\b/i;
  const TRAIL_RE = /\b(trails?|paths?|footpaths?|singletrack|single track)\b/i;
  /** 'road' | 'trail' | null from a line's name and folder (the name first). */
  function detectKind(name, folder) {
    for (const t of [name, folder]) {
      const s = String(t || '');
      if (ROAD_RE.test(s)) return 'road';
      if (TRAIL_RE.test(s)) return 'trail';
    }
    return null;
  }
  /** An EPT url FLEX could keep only in part (Potree strips the scheme and ept.json) → a whole https url, or '' when it is not one. */
  function eptUrl(u, origin) {
    u = String(u || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) { /* whole */ }
    else if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('/')) { if (!origin) return ''; u = origin.replace(/\/$/, '') + u; }
    else if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:\d+)?\//.test(u) || /^localhost(:\d+)?\//.test(u)) u = (/^localhost/.test(u) ? 'http://' : 'https://') + u;
    else return '';
    const q = u.search(/[?#]/), tail = q >= 0 ? u.slice(q) : '';
    u = q >= 0 ? u.slice(0, q) : u;
    if (!/ept\.json$/i.test(u)) u = u.replace(/\/+$/, '') + '/ept.json';
    return u + tail;
  }
  const lead = (m, d) => (Number.isFinite(m) ? m : d);
  /** The /api/route/plan params from the panel's state. */
  function buildParams(st) {
    const eps = (st.epts || []).filter(Boolean);
    const feats = (st.trails || []).filter(t => t && t.coords && t.coords.length >= 2).map(t => ({ type: 'Feature',
      geometry: { type: 'LineString', coordinates: t.coords.map(c => [c[0], c[1]]) }, properties: { kind: t.kind === 'road' ? 'road' : 'trail', name: t.name || '' } }));
    const p = {
      source: Object.assign({ ept: eps[0] || '' }, eps.length > 1 ? { ept_also: eps.slice(1) } : {}),
      end: st.end ? [st.end.at[0], st.end.at[1]] : null,
      starts: (st.starts || []).map(s => [s.at[0], s.at[1]]),
      cell: st.cell === 'auto' || st.cell == null ? 'auto' : +st.cell,
      dem: st.dem || 'below',
      brush_band: [lead(+st.band[0], 0.5), lead(+st.band[1], 2)],
      weights: Object.assign({}, WDEF, st.weights || {}),
      trails: { type: 'FeatureCollection', features: feats },
      corridor_m: 300,
      presets: ['shortest', 'least_brush', 'shadiest', 'least_climb'],
      units: st.units === 'imperial' ? 'ft' : 'm',
    };
    if (st.anyRoad && feats.length) p.start_lines = { type: 'FeatureCollection', features: feats };      // every cell under these lines is a start
    return p;
  }
  const OPT_LABEL = { recommended: 'Recommended', shortest: 'Shortest', least_brush: 'Least brush', shadiest: 'Shadiest', least_climb: 'Least climb' };
  /** Routes.geojson features → cards in order: recommended first, then the others as the script gave them. */
  function orderRoutes(fc) {
    const fs = ((fc && fc.features) || []).filter(f => f && f.geometry && f.geometry.coordinates && f.geometry.coordinates.length >= 2);
    return fs.map((f, i) => ({ f, i })).sort((a, b) => ((b.f.properties.option === 'recommended') - (a.f.properties.option === 'recommended')) || (a.i - b.i)).map(x => x.f);
  }
  const COLOURS = ['#ff9a62', '#4fc3f7', '#7bd88f', '#c39bff', '#f2c24e', '#ff7b9c', '#5ee0d0', '#d6d6d6'];
  /** The words of one stat, with the unit formatter U ({ len, climb, duration }). */
  function statLines(props, U) {
    const s = (props && props.stats) || {}, tb = s.time_breakdown || {};
    const mins = x => U.duration((x || 0) * 60);
    const top = [U.len(s.length_m), '≈ ' + mins(s.time_min), '↑ ' + U.climb(s.climb_m) + ' ↓ ' + U.climb(s.descent_m)];
    const mid = ['steepest ' + Math.round(s.max_grade_pct || 0) + '%', 'brush ' + Math.round(s.brush_pct || 0) + '%', 'sun ' + Math.round(s.sun_pct || 0) + '%', 'on trail ' + Math.round(s.on_trail_pct || 0) + '%'];
    const parts = [['walking', tb.walk_min], ['climbing', tb.climb_min], ['descending', tb.descent_min], ['brush', tb.brush_min], ['trail', tb.trail_min]].filter(p => Number.isFinite(p[1]) && Math.abs(p[1]) >= 0.05);
    const breakdown = parts.map(p => p[0] + ' ' + (p[1] < 0 ? '−' : '') + mins(Math.abs(p[1]))).join(' · ');
    return { top: top.join(' · '), mid: mid.join(' · '), breakdown, cliffs: s.cliff_cells || 0 };
  }
  /** The server's profile [[dist, elev, brush 0..1, slope deg]…] → n columns [{ brush, slope }] along the distance axis (cheap: one pass). */
  function profileBins(profile, n) {
    const pr = (profile || []).filter(r => r && Number.isFinite(r[0])), out = [];
    if (pr.length < 2) return out;
    const last = pr[pr.length - 1][0] || 1; let j = 0;
    for (let k = 0; k < n; k++) {
      const d = (k + 0.5) / n * last;
      while (j < pr.length - 2 && pr[j + 1][0] < d) j++;
      const a = pr[j], b = pr[j + 1], t = b[0] > a[0] ? Math.min(1, Math.max(0, (d - a[0]) / (b[0] - a[0]))) : 0, mix = i => (Number.isFinite(a[i]) ? a[i] : 0) * (1 - t) + (Number.isFinite(b[i]) ? b[i] : 0) * t;
      out.push({ brush: Math.min(1, Math.max(0, mix(2))), slope: Math.max(0, mix(3)) });
    }
    return out;
  }
  const pure = { profileBins, WDEF, PRESETS, SLIDERS, detectKind, eptUrl, buildParams, orderRoutes, statLines, OPT_LABEL, COLOURS };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document) return;

  // ── The panel ─────────────────────────────────────────────────────────────
  const w = root, doc = root.document;
  const A = () => w._pjApi, MD = () => w._myData, FL = () => w.FlexLib, V = () => w.cesiumViewer, INFO = () => w._info;
  const U = () => w._units || { len: m => Math.round(m) + ' m', climb: m => Math.round(m) + ' m', duration: s => Math.round(s / 60) + ' min', system: () => 'metric' };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const lget = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const SKEY = 'flex.surfroute', PKEY = 'flex.surfroute.presets';

  const S = { end: null, starts: [], anyRoad: false, epts: [], cell: 'auto', dem: 'below', band: [0.5, 2], weights: Object.assign({}, WDEF),
    trailOff: new Set(), trailOn: new Set(), trailKind: {},
    running: false, dirty: false, jobId: null, lastId: null, result: null, routes: [], sel: 0, msg: '', msgBad: false,
    overlays: {}, opacity: 0.6, ovLayers: {}, units: null, rerunTimer: null };
  try { const sv = JSON.parse(lget(SKEY) || 'null'); if (sv) { Object.assign(S.weights, sv.weights || {}); if (sv.cell != null) S.cell = sv.cell; if (sv.dem) S.dem = sv.dem; if (Array.isArray(sv.band)) S.band = sv.band; } } catch (_) {}
  const save = () => lset(SKEY, JSON.stringify({ weights: S.weights, cell: S.cell, dem: S.dem, band: S.band }));
  const myPresets = () => { try { return JSON.parse(lget(PKEY) || '[]').filter(p => p && p.name && p.w); } catch (_) { return []; } };

  // ── What can be picked / used ─────────────────────────────────────────────
  const SRC = { project: 'project', mydata: 'My data', caltopo: 'CalTopo', file: 'file' };
  function candidates() {
    const I = INFO(); if (!I || !I.allPoints) return [];
    const FLx = FL();
    let pts = []; try { pts = I.allPoints(); } catch (_) {}
    return pts.filter(p => p.at && Number.isFinite(p.at[0]) && Number.isFinite(p.at[1])).slice(0, 600).map(p => {
      let tag = null; try { tag = FLx && FLx.flexTag ? FLx.flexTag(p.desc ? p.desc() : '') : null; } catch (_) {}
      return { key: p.source + '|' + p.id, name: p.name, at: [p.at[0], p.at[1]], source: p.source, label: p.name + (tag ? ' (entrance of ' + tag.cave + ')' : '') + ' · ' + (SRC[p.source] || p.source), entrance: !!tag };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  /** The LiDAR there is: point clouds loaded now (their original urls) and the open project's point cloud layers → [{ url, name }]. */
  function datasets() {
    const out = [], seen = new Set(), origin = w.location ? w.location.origin : '';
    const add = (u, name) => { const url = eptUrl(u, origin); if (!url || seen.has(url)) return; seen.add(url); out.push({ url, name: name || url }); };
    try { if (w._refreshEptDatasets) w._refreshEptDatasets(); } catch (_) {}
    const sel = doc.getElementById('export_ept_select');          // export-ui.js: the original url captured when the cloud was added
    if (sel) [...sel.options].forEach(o => o.value && add(o.value, o.textContent));
    const pj = (A() && A().pj) || {};
    try { if (pj.pid && pj.P && FL()) FL().liveLayers(pj.P).filter(l => l.kind === 'pointcloud' && l.url).forEach(l => add(l.url, '📁 ' + (l.name || l.url))); } catch (_) {}
    return out;
  }
  const folderOf = l => {
    try {
      if (l.source === 'project') { const pj = A().pj, f = pj.P.features[l.id]; return f && f.group ? FL().groupPath(pj.P, f.group).map(g => g.name).join('/') : ''; }
      if (l.source === 'mydata') { const St = MD().cached(), f = St && St.features[l.id]; return f && f.group && St.groups[f.group] ? St.groups[f.group].name : ''; }
      if (l.ent) { const o = []; let p = l.ent.parent; while (p) { if (p.name) o.unshift(p.name); p = p.parent; } return o.join('/'); }
    } catch (_) {}
    return '';
  };
  /** Every line there is, with what says trail or road: [{ key, name, folder, coords, kind (detected|null), on }]. */
  function trails() {
    const I = INFO(); if (!I || !I.allLines) return [];
    let ls = []; try { ls = I.allLines(); } catch (_) {}
    return ls.map(l => {
      const key = l.source + '|' + l.id, folder = folderOf(l), det = detectKind(l.name, folder);
      const on = det ? !S.trailOff.has(key) : S.trailOn.has(key);
      return { key, name: l.name, folder, coords: l.coords, detected: det, kind: S.trailKind[key] || det || 'trail', on, source: l.source };
    });
  }
  function setTrail(key, on, kind) {
    const t = trails().find(x => x.key === key); if (!t) return false;
    if (kind) S.trailKind[key] = kind === 'road' ? 'road' : 'trail';
    if (on != null) { if (t.detected) (on ? S.trailOff.delete(key) : S.trailOff.add(key)); else (on ? S.trailOn.add(key) : S.trailOn.delete(key)); }
    paintTrails(); if (S.anyRoad) paintPicks(); return true;
  }
  const trailsOn = () => trails().filter(t => t.on);
  function params() {
    return buildParams({ epts: S.epts, end: S.end, starts: S.starts, anyRoad: S.anyRoad, cell: S.cell, dem: S.dem, band: S.band, weights: S.weights, units: U().system(),
      trails: trailsOn().map(t => ({ coords: t.coords, kind: t.kind, name: t.name })) });
  }

  // ── The map: picks, routes ────────────────────────────────────────────────
  let ds = null;
  function source() {
    const v = V(); if (!v || !w.Cesium) return null;
    if (!ds || !v.dataSources.contains(ds)) { ds = new Cesium.CustomDataSource('surf-route'); v.dataSources.add(ds); }
    return ds;
  }
  function drawPicks() {
    const d = source(); if (!d) return;
    d.entities.values.filter(e => e.properties && e.properties.srPick).forEach(e => d.entities.remove(e));
    const mk = (id, p, text, col) => d.entities.add({ id, name: text + ' · ' + p.name, position: Cesium.Cartesian3.fromDegrees(p.at[0], p.at[1], 0), properties: { srPick: true },
      point: { pixelSize: 11, color: Cesium.Color.fromCssColorString(col), outlineColor: Cesium.Color.BLACK, outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text, font: 'bold 13px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -18), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    if (S.end) mk('sr-end', S.end, 'E', '#ff4d4d');
    S.starts.forEach((s, i) => mk('sr-start-' + i, s, 'S' + (i + 1), '#46d17a'));
    const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
  }
  function drawRoutes() {
    const d = source(); if (!d) return;
    d.entities.values.filter(e => e.properties && e.properties.srRoute).forEach(e => d.entities.remove(e));
    S.routes.forEach((f, i) => {
      const c = f.geometry.coordinates, on = i === S.sel, col = Cesium.Color.fromCssColorString(COLOURS[i % COLOURS.length]);
      d.entities.add({ id: 'sr-route-' + i, name: 'Route: ' + (f.properties.label || f.properties.option || i), properties: { srRoute: true, srIndex: i },
        polyline: { positions: Cesium.Cartesian3.fromDegreesArray(c.flatMap(p => [p[0], p[1]])), width: on ? 7 : 3, clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN,
          material: on ? col : col.withAlpha(0.65) } });
    });
    const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
  }
  function zoomTo() {
    const v = V(), f = S.routes[S.sel]; if (!v || !f) return;
    const cs = f.geometry.coordinates, lons = cs.map(c => c[0]), lats = cs.map(c => c[1]);
    const pad = 0.15, dx = (Math.max(...lons) - Math.min(...lons)) || 0.002, dy = (Math.max(...lats) - Math.min(...lats)) || 0.002;
    v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(Math.min(...lons) - dx * pad, Math.min(...lats) - dy * pad, Math.max(...lons) + dx * pad, Math.max(...lats) + dy * pad), duration: 1.2 });
  }
  // Click on the ground: one (End) or several (Starts) until Esc, right-click or the button again.
  let picking = null;
  function lonLatAt(screen) {
    const v = V(), ray = v.camera.getPickRay(screen);
    let c = null; try { c = ray && v.scene.globe.pick(ray, v.scene); } catch (_) {}
    if (c && Cesium.Cartographic.fromCartesian(c).height < -1000) c = null;
    if (!c) { try { c = v.camera.pickEllipsoid(screen, v.scene.globe.ellipsoid); } catch (_) {} }
    if (!c) return null;
    const k = Cesium.Cartographic.fromCartesian(c);
    return [+Cesium.Math.toDegrees(k.longitude).toFixed(7), +Cesium.Math.toDegrees(k.latitude).toFixed(7)];
  }
  function stopPick() { if (picking) { const p = picking; picking = null; p.stop(); paintPicks(); } }
  function pickOnMap(kind) {
    const v = V(); if (!v) return false;
    const was = picking && picking.kind; stopPick();
    if (was === kind) return false;
    const banner = el('div', 'pjf-banner'), many = kind === 'start';
    banner.textContent = many ? 'Click on the ground to add starts · Esc or right-click to finish' : 'Click on the ground for the end of the route · Esc to cancel';
    doc.body.appendChild(banner);
    const h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas), def = v.screenSpaceEventHandler;
    const saved = [Cesium.ScreenSpaceEventType.LEFT_CLICK, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK].map(t => [t, def.getInputAction(t)]);
    saved.forEach(([t]) => def.removeInputAction(t));
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); stopPick(); } };
    doc.addEventListener('keydown', key, true);
    h.setInputAction(ev => { const p = lonLatAt(ev.position); if (!p) return; addPick(kind, { at: p, name: kind === 'end' ? 'End' : 'Start ' + (S.starts.length + 1), source: 'map' }); if (!many) stopPick(); }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction(() => stopPick(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    picking = { kind, stop() { h.destroy(); banner.remove(); doc.removeEventListener('keydown', key, true); saved.forEach(([t, fn]) => { if (fn) def.setInputAction(fn, t); }); } };
    paintPicks();
    return true;
  }
  function addPick(kind, p) {
    const pick = { at: [+p.at[0], +p.at[1]], name: p.name || (kind === 'end' ? 'End' : 'Start'), source: p.source || 'map' };
    if (kind === 'end') S.end = pick; else S.starts.push(pick);
    paintPicks(); drawPicks(); return pick;
  }
  function removePick(kind, i) { if (kind === 'end') S.end = null; else S.starts.splice(i, 1); paintPicks(); drawPicks(); }
  function setAnyRoad(on) { S.anyRoad = !!on; paintPicks(); }
  function clearPicks() { S.end = null; S.starts = []; S.anyRoad = false; paintPicks(); drawPicks(); }

  // ── Overlays from grids/ ──────────────────────────────────────────────────
  const OV = [['brush', 'Brush', 'brush.png'], ['slope', 'Slope', 'slope.png'], ['shade', 'Shade', 'shade.png'], ['ground_hs', 'Ground hillshade', 'ground_hs.png']];
  function boundsRect() {
    const g = S.result && S.result.grid, b = g && g.bounds_lonlat; if (!b || !b.length) return null;
    const lons = b.map(p => p[0]), lats = b.map(p => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }
  async function overlay(name, on) {
    const v = V(), rect = boundsRect(), r = S.result;
    S.overlays[name] = !!on;
    const cur = S.ovLayers[name];
    if (cur && (!on || cur.jobId !== (r && r.id))) { try { v.imageryLayers.remove(cur.layer, true); } catch (_) {} delete S.ovLayers[name]; }
    if (on && r && rect && r.images.includes(name) && !S.ovLayers[name]) {
      const url = r.base + 'grids/' + name + '.png', R = Cesium.Rectangle.fromDegrees(...rect);
      const prov = Cesium.SingleTileImageryProvider.fromUrl ? await Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle: R }) : new Cesium.SingleTileImageryProvider({ url, rectangle: R });
      if (!S.overlays[name]) return;
      const layer = v.imageryLayers.addImageryProvider(prov); layer.alpha = S.opacity;
      S.ovLayers[name] = { layer, jobId: r.id };
    }
    if (v && v.scene.requestRender) v.scene.requestRender();
    paintOverlays();
  }
  function setOpacity(a) { S.opacity = Math.min(1, Math.max(0, a)); Object.values(S.ovLayers).forEach(o => { o.layer.alpha = S.opacity; }); const v = V(); if (v && v.scene.requestRender) v.scene.requestRender(); }

  // ── Running ───────────────────────────────────────────────────────────────
  function say(msg, bad) { S.msg = msg || ''; S.msgBad = !!bad; const m = doc.getElementById('sr-msg'); if (m) { m.textContent = S.msg; m.classList.toggle('bad', S.msgBad); } }
  function cancelRerun() { clearTimeout(S.rerunTimer); S.rerunTimer = null; }
  function soon() { if (!S.result) return; cancelRerun(); S.rerunTimer = setTimeout(() => { S.rerunTimer = null; if (S.running) S.dirty = true; else run({ rerun: true }); }, 800); }
  async function run(o) {
    o = o || {};
    cancelRerun();
    if (S.running) { S.dirty = true; return { ok: false, error: 'busy' }; }
    if (!S.epts.length) { say('Tick the LiDAR to use (a point cloud loaded or in the project).', true); return { ok: false, error: 'no lidar' }; }
    if (!S.end) { say('Choose the end of the route.', true); return { ok: false, error: 'no end' }; }
    if (!S.starts.length && !S.anyRoad) { say('Choose at least one start, or “Any ticked road or trail”.', true); return { ok: false, error: 'no start' }; }
    if (S.anyRoad && !S.starts.length && !trailsOn().length) { say('Tick at least one road or trail to start from (under Trails and roads).', true); return { ok: false, error: 'no start lines' }; }
    const pj = (A() && A().pj) || {};
    S.running = true; S.dirty = false; paintRun();
    say(o.rerun ? 'Searching again with the new weights…' : 'Starting…');
    let j;
    try {
      const r = await fetch('/api/route/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: pj.pid || '', params: params(), reuse: S.lastId || undefined }) });
      j = await r.json();
      if (!j.ok) throw new Error(j.error || 'could not start');
    } catch (e) { S.running = false; paintRun(); say(String(e.message || e), true); return { ok: false, error: String(e.message || e) }; }
    S.jobId = j.jobId;
    if (w._jobs) w._jobs.add({ id: 'route.' + j.jobId, kind: 'route', name: 'Surface route', server: true, retry: () => run() });
    return new Promise(resolve => {
      const tick = async () => {
        let st;
        try { st = await (await fetch('/api/route/status/' + j.jobId)).json(); } catch (_) { return setTimeout(tick, 1500); }
        if (st.status === 'running') { say((j.reused ? 'Reusing the area. ' : '') + (st.message || 'Working…')); return setTimeout(tick, 600); }
        S.running = false;
        if (st.status === 'done') {
          try { await load(j.jobId); say(''); } catch (e) { say('The result could not be read: ' + (e.message || e), true); }
          paintRun();
        } else { say(st.error || 'The route search failed.', true); paintRun(); }
        if (S.dirty) { S.dirty = false; run({ rerun: true }); }
        resolve({ ok: st.status === 'done', jobId: j.jobId, error: st.error || null });
      };
      tick();
    });
  }
  async function load(jobId) {
    const r = await (await fetch('/api/route/result?id=' + encodeURIComponent(jobId))).json();
    if (!r.ok) throw new Error(r.error || 'no result');
    const keep = S.routes[S.sel] && S.routes[S.sel].properties, first = !S.result;
    S.result = r; S.lastId = jobId; S.routes = orderRoutes(r.routes);
    const at = keep ? S.routes.findIndex(f => f.properties.option === keep.option && f.properties.start_index === keep.start_index) : -1;
    S.sel = at >= 0 ? at : 0;
    drawRoutes(); paintResults();
    for (const [name] of OV) if (S.overlays[name]) { try { await overlay(name, true); } catch (_) {} }
    if (first && S.routes.length) zoomTo();
    select(S.sel, true);
  }
  function select(i, quiet) {
    if (i < 0 || i >= S.routes.length) return;
    S.sel = i; drawRoutes(); paintCards(); paintGraph();
  }

  // ── Save as a line ────────────────────────────────────────────────────────
  function describe(f) {
    const L = statLines(f.properties, U()), p = f.properties;
    const wt = S.weights;
    return `Surface route (${p.label || p.option})\n${L.top}\n${L.mid}${L.breakdown ? '\nTime: ' + L.breakdown : ''}${(p.warnings || []).length ? '\nWarnings: ' + p.warnings.join('; ') : ''}\n` +
      `Weights: distance ${wt.distance}, steepness ${wt.steep}, brush ${wt.brush}, cliffs ${wt.cliff}, sun ${wt.sun}, trails ${wt.trail}, roads ${wt.road}`;
  }
  /** Keep route i as a line: { name, desc, dest: 'project' | 'mydata' } → { id, dest, name }. */
  async function saveLine(o) {
    o = o || {};
    const f = S.routes[o.index != null ? o.index : S.sel]; if (!f) throw new Error('No route to save');
    const pj = (A() && A().pj) || {}, FLx = FL();
    const dest = o.dest || (pj.pid ? 'project' : 'mydata');
    const name = String(o.name || ('Route: ' + (f.properties.label || f.properties.option))).slice(0, 120);
    const desc = String(o.desc != null ? o.desc : describe(f)).slice(0, 4000);
    const coords = f.geometry.coordinates.map(c => [+c[0].toFixed(7), +c[1].toFixed(7), Number.isFinite(c[2]) ? +c[2].toFixed(1) : 0]);
    const colour = COLOURS[S.routes.indexOf(f) % COLOURS.length];
    const id = FLx.uid(12);
    if (dest === 'project') {
      if (!pj.pid) throw new Error('Open a project first, or keep it in My data');
      await A().record('feature.set', { feature: id, kind: 'line', coords, name, desc, group: '', style: { color: colour } });
      return { id, dest, name };
    }
    const ids = await MD().adopt([{ id, kind: 'line', coords, name, desc, group: 'Routes', color: colour }]);
    return { id: ids[0], dest, name };
  }
  async function saveDialog() {
    const f = S.routes[S.sel]; if (!f || !A()) return;
    const pj = A().pj, body = el('div', 'pj-form'), lab = (t, x) => { const r = el('div', 'pj-f'); r.appendChild(el('div', 'pj-f-l', t)); r.appendChild(x); return r; };
    const name = el('input', 'pj-input'); name.id = 'sr-save-name'; name.value = 'Route: ' + (f.properties.label || f.properties.option) + ' (' + ((S.starts[f.properties.start_index] || {}).name || String(f.properties.label || 'a road')) + ' to ' + (S.end ? S.end.name : 'end') + ')';
    const desc = el('textarea', 'pj-input'); desc.id = 'sr-save-desc'; desc.rows = 6; desc.value = describe(f);
    const dest = el('select', 'pj-input'); dest.id = 'sr-save-dest';
    if (pj.pid) dest.appendChild(new Option('The open project', 'project'));
    dest.appendChild(new Option('My data', 'mydata'));
    body.append(lab('Name', name), lab('Description', desc), lab('Keep it in', dest));
    const r = await A().dialog({ title: 'Save the route as a line', body, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r || r.button !== 'ok') return;
    try { const s = await saveLine({ name: name.value.trim() || undefined, desc: desc.value, dest: dest.value }); A().toast('Saved “' + s.name + '” as a line'); say('Saved “' + s.name + '” as a line (' + (s.dest === 'project' ? 'project' : 'My data') + ').'); return s; }
    catch (e) { say('Could not save the line: ' + (e.message || e), true); }
  }

  // ── Weights and presets ───────────────────────────────────────────────────
  function setWeights(o, quiet) {
    Object.keys(o || {}).forEach(k => { if (k in WDEF && Number.isFinite(+o[k])) S.weights[k] = +o[k]; });
    save(); paintSliders(); if (!quiet) soon();
  }
  function preset(name) {
    const mine = myPresets().find(x => x.name === name), w2 = PRESETS[name] ? PRESETS[name].w : mine ? mine.w : null;
    if (!w2) return false;
    S.presetOn = name; setWeights(w2); paintPresets(); return true;
  }
  function savePreset(name) {
    name = String(name || '').trim().slice(0, 40); if (!name) return false;
    const all = myPresets().filter(p => p.name !== name); all.push({ name, w: Object.assign({}, S.weights) });
    lset(PKEY, JSON.stringify(all)); S.presetOn = name; paintPresets(); return true;
  }
  function deletePreset(name) { lset(PKEY, JSON.stringify(myPresets().filter(p => p.name !== name))); paintPresets(); }

  // ── DOM ───────────────────────────────────────────────────────────────────
  let host = null;
  const $ = id => doc.getElementById(id);
  function sel(id, opts, val, cls) {
    const s = el('select', cls || 'sr-in'); s.id = id;
    opts.forEach(([v, t]) => s.appendChild(new Option(t, v))); s.value = String(val); return s;
  }
  function chip(text, title, onX) {
    const c = el('span', 'sr-chip'); c.appendChild(el('span', 'sr-chip-t', text)); if (title) c.title = title;
    const x = el('button', 'sr-chip-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + text); x.addEventListener('click', onX); c.appendChild(x); return c;
  }
  function paintPicks() {
    if (!host) return;
    const e = $('sr-end-chips'), s = $('sr-start-chips'); if (!e) return;
    e.textContent = ''; s.textContent = '';
    if (S.end) e.appendChild(chip(S.end.name, S.end.at[1].toFixed(5) + ', ' + S.end.at[0].toFixed(5), () => removePick('end')));
    else e.appendChild(el('span', 'sr-none', 'not chosen'));
    S.starts.forEach((p, i) => s.appendChild(chip('S' + (i + 1) + ' ' + p.name, p.at[1].toFixed(5) + ', ' + p.at[0].toFixed(5), () => removePick('start', i))));
    if (S.anyRoad) s.appendChild(chip('Any ticked road or trail (' + trailsOn().length + ')', 'Every cell under the ticked trails is a start: the cheapest way from any of them', () => setAnyRoad(false)));
    if (!S.starts.length && !S.anyRoad) s.appendChild(el('span', 'sr-none', 'none chosen'));
    const rb = $('sr-start-roads'); if (rb) rb.classList.toggle('on', S.anyRoad);
    [['sr-end-map', 'end'], ['sr-start-map', 'start']].forEach(([id, k]) => { const b = $(id); if (b) b.classList.toggle('on', !!(picking && picking.kind === k)); });
  }
  function fillCandidates() {
    const cs = candidates();
    ['sr-end-list', 'sr-start-list'].forEach((id, n) => {
      const s = $(id); if (!s) return;
      s.textContent = ''; s.appendChild(new Option(cs.length ? (n ? '＋ a point…' : 'a point…') : 'no points loaded', ''));
      cs.forEach(c => s.appendChild(new Option(c.label, c.key)));
      s._cs = cs;
    });
  }
  function paintDatasets() {
    const box = $('sr-lidar'); if (!box) return;
    const ds2 = datasets(); box.textContent = '';
    S.epts = S.epts.filter(u => ds2.some(d => d.url === u));
    if (!S.epts.length && ds2.length) S.epts = [ds2[0].url];
    if (!ds2.length) box.appendChild(el('div', 'sr-none', 'Load a point cloud (LiDAR panel) or open a project that has one.'));
    ds2.forEach(d => {
      const row = el('label', 'sr-ck'); const c = el('input'); c.type = 'checkbox'; c.className = 'keep-box'; c.checked = S.epts.includes(d.url); c.dataset.url = d.url;
      c.addEventListener('change', () => { S.epts = [...box.querySelectorAll('input:checked')].map(x => x.dataset.url); });
      const t = el('span', 'sr-ck-t', d.name); t.title = d.url; row.append(c, t); box.appendChild(row);
    });
  }
  function paintTrails() {
    const box = $('sr-trails'); if (!box) return;
    const all = trails(), det = all.filter(t => t.detected), other = all.filter(t => !t.detected);
    box.textContent = '';
    if (!det.length) box.appendChild(el('div', 'sr-none', 'No line is named or filed as a trail, path or road.'));
    const row = t => {
      const r = el('div', 'sr-tr'); const c = el('input'); c.type = 'checkbox'; c.className = 'keep-box'; c.checked = t.on; c.dataset.key = t.key;
      c.addEventListener('change', () => { setTrail(t.key, c.checked); });
      const n = el('span', 'sr-tr-n', t.name); n.title = (t.folder ? t.folder + ' · ' : '') + (SRC[t.source] || t.source);
      const k = sel('', [['trail', 'trail'], ['road', 'road']], t.kind, 'sr-in sr-kind'); k.removeAttribute('id'); k.dataset.key = t.key;
      k.addEventListener('change', () => setTrail(t.key, null, k.value));
      r.append(c, n, k); return r;
    };
    det.slice(0, 40).forEach(t => box.appendChild(row(t)));
    if (det.length > 40) box.appendChild(el('div', 'sr-none', '… and ' + (det.length - 40) + ' more'));
    other.filter(t => t.on).forEach(t => box.appendChild(row(t)));
    const rest = other.filter(t => !t.on).slice(0, 300);
    if (rest.length) {
      const s = el('select', 'sr-in'); s.id = 'sr-trail-add'; s.appendChild(new Option('＋ also use another line…', ''));
      rest.forEach(t => s.appendChild(new Option(t.name + ' · ' + (SRC[t.source] || t.source), t.key)));
      s.addEventListener('change', () => { if (s.value) setTrail(s.value, true); });
      box.appendChild(s);
    }
  }
  function fmtW(s, v) { return s.k === 'cliff' ? (v <= 0.001 ? 'Blocked' : v >= 0.999 ? 'Very costly' : v.toFixed(2)) : s.k === 'sun' ? (v < -0.05 ? 'shade ' + (-v).toFixed(1) : v > 0.05 ? 'sun ' + v.toFixed(1) : 'neutral') : v.toFixed(s.step < 0.1 ? 2 : 1); }
  function paintSliders() {
    SLIDERS.forEach(s => { const i = $('sr-w-' + s.k), v = $('sr-wv-' + s.k); if (i) { i.value = S.weights[s.k]; if (v) v.textContent = fmtW(s, +S.weights[s.k]); } });
  }
  function paintPresets() {
    const box = $('sr-presets'); if (!box) return; box.textContent = '';
    Object.entries(PRESETS).forEach(([k, p]) => { const b = el('button', 'sr-pre' + (S.presetOn === k ? ' on' : ''), p.label); b.type = 'button'; b.dataset.preset = k; b.addEventListener('click', () => preset(k)); box.appendChild(b); });
    myPresets().forEach(p => {
      const b = el('button', 'sr-pre mine' + (S.presetOn === p.name ? ' on' : ''), p.name); b.type = 'button'; b.dataset.preset = p.name; b.addEventListener('click', () => preset(p.name));
      const x = el('span', 'sr-pre-x', '×'); x.title = 'Delete this preset'; x.addEventListener('click', ev => { ev.stopPropagation(); deletePreset(p.name); }); b.appendChild(x); box.appendChild(b);
    });
    const sv = el('button', 'sr-pre save', 'Save as my preset…'); sv.type = 'button'; sv.id = 'sr-preset-save';
    sv.addEventListener('click', async () => { const a = A(); if (!a) return; const r = await a.dialog({ title: 'Save these weights as a preset', input: { value: '', placeholder: 'Name' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] }); if (r && r.button === 'ok') savePreset(r.value); });
    box.appendChild(sv);
  }
  function paintRun() {
    const b = $('sr-run'); if (!b) return;
    b.disabled = S.running; b.textContent = S.running ? 'Searching…' : S.result ? 'Find routes again' : 'Find routes';
  }
  function paintCards() {
    const box = $('sr-cards'); if (!box) return; box.textContent = '';
    S.routes.forEach((f, i) => {
      const p = f.properties, L = statLines(p, U()), col = COLOURS[i % COLOURS.length];
      const c = el('div', 'sr-card' + (i === S.sel ? ' on' : '')); c.dataset.i = i; c.dataset.option = p.option; c.tabIndex = 0; c.style.setProperty('--c', col);
      const h = el('div', 'sr-ch'); h.appendChild(el('span', 'sr-sw')); h.appendChild(el('b', null, p.label || OPT_LABEL[p.option] || p.option));
      if (p.option === 'recommended') h.appendChild(el('span', 'sr-rec', 'recommended'));
      if (S.starts.length > 1 && Number.isInteger(p.start_index) && p.start_index >= 0 && p.start_index < S.starts.length) h.appendChild(el('span', 'sr-from', 'from S' + (p.start_index + 1)));
      c.appendChild(h);
      const t = el('div', 'sr-cs', L.top); t.title = L.breakdown ? 'Time: ' + L.breakdown : ''; c.appendChild(t);
      c.appendChild(el('div', 'sr-cs2', L.mid));
      (p.warnings || []).forEach(wn => c.appendChild(el('div', 'sr-warn', '⚠ ' + wn)));
      if (i === S.sel && L.breakdown) { const d = el('div', 'sr-det', 'Time: ' + L.breakdown); c.appendChild(d); }
      const go = () => select(i); c.addEventListener('click', go); c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      box.appendChild(c);
    });
  }
  function paintGraph() {
    const box = $('sr-graph'); if (!box) return; box.textContent = '';
    const f = S.routes[S.sel], RS = w._routeStats; if (!f || !RS || !RS.routeNode) return;
    const I = INFO(), wrap = el('div', 'rs-host');
    let pts = []; try { pts = I && I.allPoints ? I.allPoints().filter(p => p.source !== 'map') : []; } catch (_) {}
    try { wrap.appendChild(RS.routeNode({ coords: f.geometry.coordinates, times: null, points: pts, lines: [], open: it => I && I.openItem && I.openItem(it),
      entrance: pt => { const FLx = FL(); const t = FLx && FLx.flexTag && FLx.flexTag(pt.desc ? pt.desc() : ''); return t ? 'entrance of ' + t.cave : null; } })); } catch (e) { wrap.textContent = 'The height graph could not be drawn.'; }
    box.appendChild(wrap);
    const strips = profileStrips(f.properties.profile), at = wrap.querySelector('.rs-tip');
    if (strips && at) at.parentNode.insertBefore(strips, at);
  }
  /** Brush (green) and slope (grey) along the route from the server's profile, on the graph's distance axis (viewBox 420, x 40..412 as route-stats draws it). */
  function profileStrips(profile) {
    const bins = profileBins(profile, 160); if (!bins.length) return null;
    const NS = 'http://www.w3.org/2000/svg', X0 = 40, X1 = 412, W = 420, H = 24, bw = (X1 - X0) / bins.length;
    const box = el('div', 'sr-strips'), svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('class', 'sr-strip-svg'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Brush and slope along the route');
    const mk = (tag, at) => { const e = doc.createElementNS(NS, tag); for (const k in at) e.setAttribute(k, at[k]); svg.appendChild(e); return e; };
    [['Brush', 1, 'sr-sb'], ['Slope', 14, 'sr-ss']].forEach(([label, y, cls], r) => {
      const t = mk('text', { x: X0 - 4, y: y + 7, 'text-anchor': 'end', class: 'sr-strip-l' }); t.textContent = label;
      mk('rect', { x: X0, y, width: X1 - X0, height: 8, class: 'sr-strip-bg' });
      bins.forEach((b, i) => { const v = r === 0 ? b.brush : Math.min(1, b.slope / 40); if (v < 0.02) return; mk('rect', { x: (X0 + i * bw).toFixed(2), y, width: (bw + 0.4).toFixed(2), height: 8, class: cls, 'fill-opacity': v.toFixed(2) }); });
    });
    box.appendChild(svg);
    const lg = el('div', 'sr-strip-lg', 'Brush 0 to 1 (green) · slope 0 to 40° or more (grey), along the route'); box.appendChild(lg);
    return box;
  }
  function paintOverlays() {
    const box = $('sr-ov'); if (!box) return; box.textContent = '';
    const have = S.result ? S.result.images : [], rect = boundsRect();
    OV.forEach(([name, label]) => {
      const row = w.uiSwitch(!!S.overlays[name], on => { overlay(name, on).catch(e => say('The overlay could not be drawn: ' + (e.message || e), true)); }, label, { small: true, id: 'sr-ov-' + name });
      if (!have.includes(name) || !rect) { row.classList.add('off'); row.title = 'Not made for this area'; if (row.sw) row.sw.disabled = true; }
      box.appendChild(row);
    });
    const o = doc.createElement('label'); o.className = 'sr-op'; o.append('Opacity ');
    const r = el('input'); r.type = 'range'; r.min = 0; r.max = 100; r.value = Math.round(S.opacity * 100); r.id = 'sr-opacity'; r.addEventListener('input', () => setOpacity(r.value / 100)); o.appendChild(r); box.appendChild(o);
  }
  function paintResults() {
    const r = $('sr-results'); if (!r) return;
    r.hidden = !S.routes.length; paintCards(); paintOverlays(); paintRun();
    const note = $('sr-note');
    if (note && S.result) {
      const sm = S.result.summary || {}, bits = [];
      if (sm.cell) bits.push('cell ' + sm.cell + ' m');
      if (sm.corridor_grew) bits.push('the search area grew ' + sm.corridor_grew + '×');
      if (sm.elapsed_s != null) bits.push(Math.round(sm.elapsed_s) + ' s');
      note.textContent = bits.join(' · ');
    }
  }
  function refresh() { fillCandidates(); paintDatasets(); paintTrails(); paintPicks(); }

  function build() {
    host = $('surfroute-host'); if (!host) return;
    host.textContent = '';
    const sec = el('div', 'lp-section'), head = el('div', 'lp-section-header'); head.id = 'sr-head';
    head.innerHTML = '<span class="lp-section-arrow" style="transform: rotate(-90deg)">▾</span> Surface route';
    head.addEventListener('click', () => { if (w._lpToggle) w._lpToggle(head); if (head.nextElementSibling.classList.contains('open')) refresh(); });
    const b = el('div', 'lp-section-body'); b.id = 'sr-body';
    sec.append(head, b); host.appendChild(sec);
    const h = (t, tip) => { const e = el('div', 'sr-h', t); if (tip) e.title = tip; return e; };
    b.appendChild(el('div', 'sr-note', 'The easiest way over the ground from one or more starts to one end, from the LiDAR: steepness, cliffs, brush, shade, and your trails and roads.'));

    // Picks
    b.appendChild(h('End'));
    const er = el('div', 'sr-row'); const eb = el('button', 'sr-btn', 'Click on the ground'); eb.type = 'button'; eb.id = 'sr-end-map'; eb.addEventListener('click', () => pickOnMap('end'));
    const el1 = sel('sr-end-list', [['', 'a point…']], ''); el1.addEventListener('change', () => { const c = (el1._cs || []).find(x => x.key === el1.value); if (c) addPick('end', c); el1.value = ''; });
    er.append(eb, el1); b.appendChild(er);
    const ec = el('div', 'sr-chips'); ec.id = 'sr-end-chips'; b.appendChild(ec);
    b.appendChild(h('Starts'));
    const sr = el('div', 'sr-row'); const sb = el('button', 'sr-btn', 'Click on the ground'); sb.type = 'button'; sb.id = 'sr-start-map'; sb.addEventListener('click', () => pickOnMap('start'));
    const sl = sel('sr-start-list', [['', '＋ a point…']], ''); sl.addEventListener('change', () => { const c = (sl._cs || []).find(x => x.key === sl.value); if (c) addPick('start', c); sl.value = ''; });
    sr.append(sb, sl); b.appendChild(sr);
    const rr = el('div', 'sr-row'); const roads = el('button', 'sr-btn', 'Any ticked road or trail'); roads.type = 'button'; roads.id = 'sr-start-roads';
    roads.title = 'Start from the nearest road or trail: the cheapest way from any of the ticked ones (under Trails and roads)'; roads.addEventListener('click', () => setAnyRoad(!S.anyRoad)); rr.appendChild(roads); b.appendChild(rr);
    const sc = el('div', 'sr-chips'); sc.id = 'sr-start-chips'; b.appendChild(sc);

    // Source
    b.appendChild(h('LiDAR', 'The point clouds the ground, brush and shade are read from'));
    const lb = el('div', 'sr-lidar'); lb.id = 'sr-lidar'; b.appendChild(lb);
    const ro = el('div', 'sr-row wrap');
    const cell = sel('sr-cell', [['auto', 'auto'], ['0.5', '0.5 m'], ['1', '1 m'], ['2', '2 m']], S.cell); cell.title = 'Cell size: auto picks it from the ground density';
    cell.addEventListener('change', () => { S.cell = cell.value === 'auto' ? 'auto' : +cell.value; save(); });
    const dem = sel('sr-dem', [['below', 'DEM from below'], ['above', 'DEM from above'], ['both', 'both, compared']], S.dem); dem.title = 'How the ground is found under the trees';
    dem.addEventListener('change', () => { S.dem = dem.value; save(); });
    const lo = el('input', 'sr-in sr-num'); lo.type = 'number'; lo.step = 0.1; lo.min = 0; lo.id = 'sr-band-lo'; lo.value = S.band[0];
    const hi = el('input', 'sr-in sr-num'); hi.type = 'number'; hi.step = 0.1; hi.min = 0; hi.id = 'sr-band-hi'; hi.value = S.band[1];
    const bandCh = () => { const a = parseFloat(lo.value), z = parseFloat(hi.value); if (Number.isFinite(a) && Number.isFinite(z) && z > a) { S.band = [a, z]; save(); } };
    lo.addEventListener('change', bandCh); hi.addEventListener('change', bandCh);
    const bl = el('label', 'sr-inl'); bl.title = 'Returns this far above the ground count as brush (metres)'; bl.append('Brush ', lo, ' to ', hi, ' m');
    ro.append(el('span', 'sr-l', 'Cell'), cell, dem, bl); b.appendChild(ro);

    // Weights
    b.appendChild(h('What matters'));
    const pr = el('div', 'sr-presets'); pr.id = 'sr-presets'; b.appendChild(pr);
    SLIDERS.forEach(s => {
      const r = el('div', 'sr-sl'); r.title = s.tip;
      r.appendChild(el('span', 'sr-sl-n', s.label));
      const i = el('input'); i.type = 'range'; i.id = 'sr-w-' + s.k; i.min = s.min; i.max = s.max; i.step = s.step; i.value = S.weights[s.k];
      i.addEventListener('input', () => { S.weights[s.k] = +i.value; S.presetOn = null; $('sr-wv-' + s.k).textContent = fmtW(s, +i.value); save(); paintPresets(); soon(); });
      r.appendChild(i); const v = el('span', 'sr-sl-v', fmtW(s, +S.weights[s.k])); v.id = 'sr-wv-' + s.k; r.appendChild(v);
      const cap = el('div', 'sr-sl-cap'); cap.append(el('span', null, s.lo), el('span', null, s.hi));
      b.append(r, cap);
    });

    // Trails
    b.appendChild(h('Trails and roads', 'Lines whose name or folder says trail, path or road are used; tick any other line to use it too'));
    const tr = el('div', 'sr-trails'); tr.id = 'sr-trails'; b.appendChild(tr);

    // Go
    const go = el('button', 'btn btn-primary sr-run', 'Find routes'); go.type = 'button'; go.id = 'sr-run'; go.addEventListener('click', () => run());
    b.appendChild(go);
    const msg = el('div', 'sr-msg'); msg.id = 'sr-msg'; b.appendChild(msg);
    const res = el('div', 'sr-results'); res.id = 'sr-results'; res.hidden = true;
    res.appendChild(h('Routes'));
    const cards = el('div', 'sr-cards'); cards.id = 'sr-cards'; res.appendChild(cards);
    const note = el('div', 'sr-note'); note.id = 'sr-note'; res.appendChild(note);
    const act = el('div', 'sr-row'); const sv = el('button', 'sr-btn', 'Save as project line…'); sv.type = 'button'; sv.id = 'sr-save'; sv.addEventListener('click', saveDialog);
    const zm = el('button', 'sr-btn', 'Zoom to it'); zm.type = 'button'; zm.id = 'sr-zoom'; zm.addEventListener('click', zoomTo); act.append(sv, zm); res.appendChild(act);
    const gr = el('div', 'sr-graph'); gr.id = 'sr-graph'; res.appendChild(gr);
    res.appendChild(h('Show on the map'));
    const ov = el('div', 'sr-ov'); ov.id = 'sr-ov'; res.appendChild(ov);
    b.appendChild(res);

    paintPresets(); refresh(); paintOverlays(); paintRun();
  }
  function clear() { S.result = null; S.routes = []; S.lastId = null; S.sel = 0; Object.keys(S.ovLayers).forEach(k => { overlay(k, false); }); drawRoutes(); paintResults(); }

  const css = doc.createElement('style');
  css.textContent = `
  #surfroute-host .sr-note { font-size: 10.5px; color: rgba(255,255,255,.55); margin: 2px 0 4px; }
  #surfroute-host .sr-h { font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: rgba(255,255,255,.5); margin: 9px 0 3px; }
  #surfroute-host .sr-row { display: flex; gap: 5px; align-items: center; margin: 2px 0; } #surfroute-host .sr-row.wrap { flex-wrap: wrap; }
  #surfroute-host .sr-in { background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; padding: 3px 5px; font-size: 11px; min-width: 0; }
  #surfroute-host .sr-row .sr-in { flex: 1; } #surfroute-host .sr-num { width: 46px; flex: none; padding: 2px 3px; } #surfroute-host .sr-kind { flex: none; width: auto; }
  #surfroute-host .sr-l, #surfroute-host .sr-inl { font-size: 11px; color: rgba(255,255,255,.7); white-space: nowrap; }
  #surfroute-host .sr-btn { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; padding: 3px 8px; font-size: 11px; cursor: pointer; white-space: nowrap; }
  #surfroute-host .sr-btn:hover { border-color: #999; } #surfroute-host .sr-btn.on { border-color: #ff9a62; color: #ff9a62; }
  #surfroute-host .sr-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0; min-height: 4px; }
  #surfroute-host .sr-chip { display: inline-flex; align-items: center; gap: 3px; background: rgba(255,255,255,.1); border-radius: 10px; padding: 1px 3px 1px 8px; font-size: 11px; max-width: 100%; }
  #surfroute-host .sr-chip-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #surfroute-host .sr-chip-x { background: none; border: none; color: rgba(255,255,255,.6); cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1; }
  #surfroute-host .sr-chip-x:hover { color: #ff7b7b; } #surfroute-host .sr-none { font-size: 10.5px; color: rgba(255,255,255,.35); }
  #surfroute-host .sr-ck, #surfroute-host .sr-tr { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 1px 0; }
  #surfroute-host .sr-ck-t, #surfroute-host .sr-tr-n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #surfroute-host .sr-presets { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; }
  #surfroute-host .sr-pre { background: none; color: #ddd; border: 1px solid #555; border-radius: 10px; padding: 1px 9px; font-size: 11px; cursor: pointer; }
  #surfroute-host .sr-pre.on { border-color: #ff9a62; color: #ff9a62; } #surfroute-host .sr-pre.save { border-style: dashed; color: rgba(255,255,255,.6); }
  #surfroute-host .sr-pre-x { margin-left: 5px; opacity: .6; } #surfroute-host .sr-pre-x:hover { opacity: 1; color: #ff7b7b; }
  #surfroute-host .sr-sl { display: grid; grid-template-columns: 70px 1fr 78px; gap: 6px; align-items: center; font-size: 11px; margin-top: 3px; }
  #surfroute-host .sr-sl input { width: 100%; margin: 0; } #surfroute-host .sr-sl-v { text-align: right; color: rgba(255,255,255,.7); font-size: 10.5px; }
  #surfroute-host .sr-sl-cap { display: flex; justify-content: space-between; margin: 0 80px 0 76px; font-size: 9px; color: rgba(255,255,255,.35); }
  #surfroute-host .sr-run { width: 100%; margin-top: 10px; } #surfroute-host .sr-msg { font-size: 11px; color: rgba(255,255,255,.65); margin: 5px 0; min-height: 4px; } #surfroute-host .sr-msg.bad { color: #ff9a8a; }
  #surfroute-host .sr-card { border: 1px solid rgba(255,255,255,.18); border-left: 4px solid var(--c); border-radius: 4px; padding: 5px 7px; margin: 5px 0; cursor: pointer; font-size: 11px; }
  #surfroute-host .sr-card.on { background: rgba(255,255,255,.09); border-color: var(--c); } #surfroute-host .sr-card:focus-visible { outline: 2px solid var(--c); }
  #surfroute-host .sr-ch { display: flex; align-items: center; gap: 6px; } #surfroute-host .sr-sw { width: 14px; height: 4px; border-radius: 2px; background: var(--c); }
  #surfroute-host .sr-rec { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; background: var(--c); color: #111; border-radius: 3px; padding: 0 4px; } #surfroute-host .sr-from { color: rgba(255,255,255,.5); }
  #surfroute-host .sr-cs { margin-top: 2px; color: #eee; } #surfroute-host .sr-cs2 { color: rgba(255,255,255,.6); font-size: 10.5px; }
  #surfroute-host .sr-warn { color: #f2c24e; font-size: 10.5px; margin-top: 2px; } #surfroute-host .sr-det { color: rgba(255,255,255,.55); font-size: 10.5px; margin-top: 3px; border-top: 1px dashed rgba(255,255,255,.15); padding-top: 3px; }
  #surfroute-host .sr-ov { display: flex; flex-direction: column; gap: 3px; } #surfroute-host .sw-row.off { opacity: .4; } #surfroute-host .sr-op { font-size: 11px; display: flex; gap: 6px; align-items: center; }
  #surfroute-host .sr-strips { margin-top: -2px; } #surfroute-host .sr-strip-svg { width: 100%; height: auto; display: block; }
  #surfroute-host .sr-strip-l { fill: rgba(255,255,255,.55); font-size: 8px; } #surfroute-host .sr-strip-bg { fill: rgba(255,255,255,.07); }
  #surfroute-host .sr-sb { fill: #46c86e; } #surfroute-host .sr-ss { fill: #c4c9cf; } #surfroute-host .sr-strip-lg { font-size: 10px; color: rgba(255,255,255,.45); }
  #surfroute-host .rs-host { margin-top: 8px; color: #e8e8ee; font-size: 11.5px; }
  .rs-host .inf-h { font-weight: 700; margin: 4px 0 5px; color: #f2f4f3; } .rs-host .inf-facts { border-collapse: collapse; margin: 6px 0 2px; width: 100%; }
  .rs-host .inf-facts th { text-align: left; font-weight: 500; color: rgba(255,255,255,.5); padding: 2px 10px 2px 0; white-space: nowrap; vertical-align: top; width: 1%; }
  .rs-host .inf-facts td { padding: 2px 0; word-break: break-word; }`;
  doc.head.appendChild(css);

  w._surfRoute = { state: () => S, run, results: () => S.routes, select, selected: () => S.routes[S.sel] || null, addPick, removePick, setPick: addPick, clearPicks, candidates, datasets, setWeights,
    weights: () => Object.assign({}, S.weights), preset, presets: () => Object.keys(PRESETS).concat(myPresets().map(p => p.name)), savePreset, trails, setTrail, params, saveLine, overlay,
    overlays: () => Object.assign({}, S.overlays), setOpacity, pickOnMap, stopPick, zoomTo, clear, refresh, cancelRerun, setAnyRoad, pure };
  w.addEventListener('flex-units-changed', () => { paintCards(); paintGraph(); });
  const start = () => {
    build();
    const pane = $('lidarDeriveCollapsible');
    if (pane) new MutationObserver(() => { if (pane.classList.contains('show')) refresh(); }).observe(pane, { attributes: true, attributeFilter: ['class'] });
    w.addEventListener('flex-project-changed', refresh);
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : this);
