// info_panel.js — what a click on the map shows, in two steps.
//
//   Brief      in the details panel on the right (inspector.js): the name,
//              what it is, where it comes from (with its CalTopo status), a
//              few lines and how many photos, videos, documents, notes and
//              leads go with it; Edit, Show in list, More. Clicking never edits.
//   Expanded   hovering the details panel a moment opens a larger panel
//              beside it with everything:
//                source (CalTopo map with Open in CalTopo ↗, project, My data or
//                  data file) and its badges: waiting for CalTopo, changed in
//                  CalTopo, not in CalTopo, read-only;
//                folder path (each part opens that folder in its pane);
//                position: lat/lon, UTM, terrain height, LiDAR ground where a
//                  loaded cloud covers it, its own height and height above ground;
//                style and metadata: colour, symbol, name on the map, created
//                  and updated (when, by whom);
//                related: a station's cave, survey, segments, shots and LRUDs;
//                  a survey's stations, length, segments, dates, team; a cave's
//                  surveys, entrances, length, depth, open leads; the cave a
//                  point is tagged to, its project;
//                nearby: the nearest station and cave entrance, the nearest
//                  leads, with distance and bearing;
//                the whole description, notes, leads, photos and videos
//                  (played here), documents.
//              It goes away when the pointer leaves, unless it was dragged by
//              its header, pinned (📌) or used (a click inside, e.g. on a
//              video). × or Esc closes it.
//   Edit       a second step: Edit in either panel opens the shared editor
//              (feature_editor.js, window._featEdit), which writes to the
//              item's own source (project, My data, CalTopo); data files are
//              read-only and say so.
//   Show in    opens the pane that lists it (📍 Surface, 🕳 Caves) and reveals
//   list       the row; while that pane is open, a click on the map reveals the
//              row by itself (its folders open, it scrolls into view, flashes).
//              The panes' own reveal(key, { open: true }) does it when they have
//              one (window._surfCols.reveal / window._caveCols.reveal, see revealKey);
//              until then project features are revealed here.
//
// What it can show (a "subject"): a project's own point, line or area
// (project_features.js), a lead on a surface point, a cave, survey or station
// (their card in the details panel is the brief; selection.js, project.js),
// a CalTopo feature, a data-file feature, a My data point, any other entity.
//
// A video plays only here or in the document viewer (project.js), and stops
// for good — paused, source dropped, element removed — when this panel
// closes, collapses, changes subject or the document viewer opens.
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) { console.warn('[info] project.js missing'); return; }
  const { pj, FL, el, btn } = A;
  const V = () => window.cesiumViewer;
  const FE = () => window._featEdit || null;
  const CT = () => window._ctWrite || null;
  const API = '/api/lib/';
  const HOVER_MS = 600, LEAVE_MS = 450;
  const I = { subject: null, x: null, pinned: false, moved: false, tOpen: 0, tClose: 0, overIns: false, overX: false, result: null, revealed: null };
  window._infoState = I;                                  // tests

  // ── Measures ─────────────────────────────────────────────────────────────
  const prop = (e, k) => (e && e.properties && e.properties[k] ? e.properties[k].getValue() : null);
  const KIND = { point: 'Point', line: 'Line', area: 'Area' }, KICON = { point: '📍', line: '〰️', area: '⬠' };
  const deg = r => r * 180 / Math.PI;
  const fmtLen = m => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
  const fmtDist = m => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m >= 10 ? Math.round(m) + ' m' : m.toFixed(1) + ' m');
  function lenOf(cs) {
    let L = 0;
    for (let i = 1; i < cs.length; i++) {
      const [a, b] = [cs[i - 1], cs[i]], k = Math.PI / 180;
      const dl = (b[1] - a[1]) * k, dn = (b[0] - a[0]) * k, m = (a[1] + b[1]) / 2 * k;
      L += 6371008 * Math.hypot(dl, dn * Math.cos(m));
    }
    return L;
  }
  function areaOf(cs) {
    const lat0 = cs[0][1] * Math.PI / 180, mx = 111320 * Math.cos(lat0), my = 110540;
    let s = 0;
    for (let i = 0; i < cs.length; i++) { const a = cs[i], b = cs[(i + 1) % cs.length]; s += a[0] * mx * b[1] * my - b[0] * mx * a[1] * my; }
    return Math.abs(s / 2);
  }
  const fmtArea = a => (a >= 1e6 ? (a / 1e6).toFixed(2) + ' km²' : a >= 1e4 ? (a / 1e4).toFixed(2) + ' ha' : Math.round(a) + ' m²');
  const latlon = c => `${c[1].toFixed(6)}, ${c[0].toFixed(6)}`;
  /** Distance (m) and initial bearing (° from north) from a to b, [lon, lat]. */
  function distBrg(a, b) {
    const k = Math.PI / 180, p1 = a[1] * k, p2 = b[1] * k, dl = (b[0] - a[0]) * k;
    const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return { d: 2 * 6371008 * Math.asin(Math.min(1, Math.sqrt(h))), brg: (Math.atan2(y, x) / k + 360) % 360 };
  }
  const PTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const fmtBrg = b => `${Math.round(b) % 360}° ${PTS[Math.round(b / 45) % 8]}`;
  const when = t => { if (!t) return ''; const d = new Date(t); if (isNaN(d)) return String(t); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const utmText = c => { const U = FE() && FE().utm(c[0], c[1]); return U ? `${U.zone}${U.band} ${Math.round(U.e)} E ${Math.round(U.n)} N` : ''; };
  const cartoOf = p => { const k = Cesium.Cartographic.fromCartesian(p); return [deg(k.longitude), deg(k.latitude), k.height]; };

  // ── Heights ──────────────────────────────────────────────────────────────
  // Terrain: sampled from the globe's terrain provider (most detailed where it
  // says what it has, level 14 otherwise, as cave_ground.js does); kept until
  // the terrain changes.
  const tCache = new Map();
  window.addEventListener('flex-terrain-changed', () => tCache.clear());
  function terrainAt(lon, lat) {
    const k = lon.toFixed(6) + ',' + lat.toFixed(6);
    if (tCache.has(k)) return tCache.get(k);
    const v = V();
    if (!v || !window.Cesium) return Promise.resolve(null);
    let p;
    try {
      const tp = v.terrainProvider, ks = [Cesium.Cartographic.fromDegrees(lon, lat)];
      p = Promise.resolve(tp.availability ? Cesium.sampleTerrainMostDetailed(tp, ks) : Cesium.sampleTerrain(tp, 14, ks))
        .then(r => { const h = r && r[0] && r[0].height; return Number.isFinite(h) ? h : null; }, () => null);
    } catch (_) { p = Promise.resolve(null); }
    p = Promise.race([p, new Promise(r => setTimeout(() => r(null), 10000))]);
    tCache.set(k, p);
    p.then(h => { if (h == null) tCache.delete(k); });
    return p;
  }
  // LiDAR: the ground returns of the loaded point clouds there (flex.js).
  function lidarAt(lon, lat) { try { const g = window._lidarGroundAt && window._lidarGroundAt(lon, lat); return g && Number.isFinite(g.h) ? g.h : null; } catch (_) { return null; } }
  /** Position rows. A value is text, { async: Promise<text|null> } or a function → node. */
  function posFacts(c, kind, own) {
    const out = [[kind === 'line' ? 'Starts at' : kind === 'area' ? 'Centre' : 'Position', latlon(c)]];
    const u = utmText(c); if (u) out.push(['UTM', u]);
    if (kind === 'line' || kind === 'area') return out;
    const h = own !== false && Number.isFinite(c[2]) && c[2] !== 0 ? c[2] : null;
    if (h != null) out.push(['Height', h.toFixed(1) + ' m']);
    const ter = terrainAt(c[0], c[1]), lid = lidarAt(c[0], c[1]);
    out.push(['Terrain height', { async: ter.then(t => (t == null ? null : t.toFixed(1) + ' m')) }]);
    if (lid != null) out.push(['LiDAR ground', lid.toFixed(1) + ' m']);
    if (h != null) out.push(['Above ground', { async: ter.then(t => { const g = lid != null ? lid : t; return g == null ? null : `${(h - g).toFixed(1)} m${lid != null ? ' (LiDAR)' : ''}`; }) }]);
    return out;
  }
  const centre = cs => [cs.reduce((s, c) => s + c[0], 0) / cs.length, cs.reduce((s, c) => s + c[1], 0) / cs.length, 0];

  // ── Caves: stations, shots, lengths ──────────────────────────────────────
  const imps = () => (window._caveImports || []).filter(i => i && i.parsed);
  const stCache = new WeakMap();
  function stationsOfImp(imp) {
    const f = imp._convertFn;
    if (typeof f !== 'function') return [];
    const c = stCache.get(imp);
    if (c && c.f === f) return c.list;
    const list = [], seen = new Set();
    (imp.parsed.stations || []).forEach(s => {
      if (!s.name || seen.has(s.name)) return;
      seen.add(s.name);
      try { const p = f(s.n, s.e, s.v); if (p) { const g = cartoOf(p); list.push({ name: s.name, survey: s.survey || '', lon: g[0], lat: g[1], h: g[2] }); } } catch (_) {}
    });
    stCache.set(imp, { f, list });
    return list;
  }
  const caveLabel = (imp, code) => { if (pj.pid && pj.P) { const cid = A.caveFor(imp, code); if (cid) return A.caveName(cid); } return imp.name; };
  const segLen = sg => { let L = 0; for (let i = 1; i < sg.points.length; i++) { const p = sg.points[i - 1], q = sg.points[i]; if (!q.excluded) L += Math.hypot(q.n - p.n, q.e - p.e, q.v - p.v); } return L; };
  function shotsAt(imp, name) {
    const out = [], seen = new Set();
    let lrud = null;
    (imp.parsed.segments || []).forEach(sg => sg.points.forEach((p, i) => {
      if (p.name !== name) return;
      if (p.lrud && !lrud) lrud = p.lrud;
      [i - 1, i + 1].forEach(j => {
        const q = sg.points[j];
        if (!q) return;
        const key = q.name || sg.survey + ':' + j;
        if (seen.has(key)) return;
        seen.add(key);
        const dn = q.n - p.n, de = q.e - p.e, dv = q.v - p.v, hz = Math.hypot(dn, de);
        out.push({ to: q.name || '(unnamed)', len: Math.hypot(hz, dv), az: (deg(Math.atan2(de, dn)) + 360) % 360, inc: deg(Math.atan2(dv, hz)), excluded: !!(j > i ? q.excluded : p.excluded), survey: sg.survey || '' });
      });
    }));
    return { shots: out, lrud };
  }
  function cavePartsOf(c) { return c.cid && pj.pid ? A.partsOf(c.cid) : c.imp ? [{ imp: c.imp, codes: null }] : []; }
  function caveStats(parts, code) {
    let len = 0, lo = Infinity, hi = -Infinity, n = 0;
    const st = new Set(), dates = new Set();
    parts.forEach(({ imp, codes }) => {
      (imp.parsed.segments || []).forEach(sg => {
        const sc = sg.survey || '';
        if (codes && !codes.has(sc)) return;
        if (code != null && sc !== code) return;
        len += segLen(sg);
        sg.points.forEach(p => { if (p.isSurface) return; if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; if (p.name) st.add(p.name); n++; });
      });
      (imp.parsed.surveys || []).forEach(s => { if ((code == null ? !codes || codes.has(s.code) : s.code === code) && s.date) dates.add(s.date); });
    });
    return { len, depth: n ? hi - lo : 0, stations: st, dates: [...dates].sort() };
  }
  const segRec = id => pj.P && pj.P.segments && pj.P.segments[id];
  const segText = g => `Segment ${g.name || g.id}${g.date ? ' · ' + g.date : ''}${g.team ? ' · ' + g.team : ''}`;

  // ── Nearby ───────────────────────────────────────────────────────────────
  function leadSpots() {
    const out = [];
    if (!pj.pid || !pj.P) return out;
    const st = new Set();
    Object.values(pj.P.leads).forEach(L => {
      if (L.deleted || !FL.leadActive(L)) return;
      const p = FL.parseTarget(L.target);
      if (p.kind === 'feature') { const f = pj.P.features[p.feature]; if (f && !f.removed && f.coords && f.coords[0]) out.push({ id: L.id, target: L.target, at: f.coords[0], label: 'Lead at ' + A.targetLabel(L.target) }); }
      else if (p.kind === 'station') st.add(p.cave + '|' + p.name);
    });
    FL.liveCaves(pj.P).forEach(cv => A.partsOf(cv.id).forEach(({ imp }) => (imp.parsed.leads || []).forEach(ld => { if (!ld.done) st.add(cv.id + '|' + ld.station); })));
    st.forEach(k => {
      const i = k.indexOf('|'), cid = k.slice(0, i), name = k.slice(i + 1);
      const n = A.leadsAt(cid, name).filter(x => x.active).length;
      const pos = n && A.stationPos(cid, name);
      if (pos) out.push({ id: 'st:' + k, target: FL.T.station(cid, name), at: cartoOf(pos), label: `${n > 1 ? n + ' leads' : 'Lead'} at ${name} (${A.caveName(cid)})` });
    });
    return out;
  }
  // self: { station: '<file>|<name>', target, lead } — not its own neighbour.
  function nearby(c, self) {
    const out = [];
    self = self || {};
    let best = null;
    imps().forEach(imp => stationsOfImp(imp).forEach(s => {
      if (self.station === imp.name + '|' + s.name) return;
      const db = distBrg(c, [s.lon, s.lat]);
      if (!best || db.d < best.d) best = Object.assign(db, { s, imp });
    }));
    if (best) out.push(['Nearest station', `${best.s.name} (${caveLabel(best.imp, best.s.survey)}) · ${fmtDist(best.d)} · ${fmtBrg(best.brg)}`]);
    let ent = null, tags = [];
    if (pj.pid && window._pjf) try { tags = window._pjf.scanTags(); } catch (_) {}
    tags.forEach(t => { const db = distBrg(c, t.at); if (db.d < 0.5) return; if (!ent || db.d < ent.d) ent = Object.assign(db, { t }); });
    if (ent) out.push(['Nearest entrance', `${ent.t.cave}${ent.t.point ? ' (' + ent.t.point + ')' : ''} · ${fmtDist(ent.d)} · ${fmtBrg(ent.brg)}`]);
    leadSpots().filter(x => x.target !== self.target && x.id !== self.lead).map(x => Object.assign(distBrg(c, x.at), x)).sort((a, b) => a.d - b.d).slice(0, 3)
      .forEach((x, i) => out.push([i ? '' : 'Nearest leads', `${x.label} · ${fmtDist(x.d)} · ${fmtBrg(x.brg)}`]));
    return out;
  }

  // ── Related ──────────────────────────────────────────────────────────────
  // A point (or line, area) tagged “flex: cave=…; station=…”, and its project.
  function tagRelated(desc, source) {
    const out = [], t = FL.flexTag(desc);
    if (t) {
      const cid = pj.pid && pj.P ? FL.caveForName(pj.P, t.cave) : null;
      out.push(['Cave entrance of', `${t.cave}${t.station ? ' · station ' + t.station : ''}${pj.pid && !cid ? ' (no cave of that name in the project)' : ''}`]);
    }
    if (pj.pid && pj.P) out.push(['Project', (pj.P.name || pj.pid) + (source === 'project' ? '' : source === 'mydata' ? ' (open; this point is in My data)' : ' (open)')]);
    return out;
  }
  // Trips that visited a cave or hold one of its segments.
  function tripsRelated(cid, segIds) {
    if (!cid || !pj.P || !FL.tripsOf) return [];
    const ts = FL.tripsOf(pj.P).filter(t => (!segIds && t.caves.includes(cid)) || (segIds || []).some(id => t.links.includes('segment:' + id)));
    const tx = ts.map(t => (window._pjTrips ? window._pjTrips.range(t) : t.start) + ' · ' + (t.name || 'Trip'));
    return tx.length ? [['Trips', tx.join('\n')]] : [];
  }
  function stationRelated(c) {
    const out = [], imp = c.imp;
    if (!imp) return out;
    const sv = (imp.parsed.surveys || []).find(s => s.code === (c.code || ''));
    if (c.code) out.push(['Survey', c.code + (sv && sv.desc ? ' · ' + sv.desc : '') + (sv && sv.date ? ' · ' + sv.date : '')]);
    if (c.cid && pj.P && window._pjSeg) {
      let ids = [];
      try { ids = (window._pjSeg.info(c.cid).idx.station.get(c.name) || []); } catch (_) {}
      const gs = ids.map(segRec).filter(g => g && !g.removed);
      if (gs.length) out.push(['Segment', gs.map(segText).join('\n')]);
      out.push(...tripsRelated(c.cid, gs.map(g => g.id)));
    }
    const { shots, lrud } = shotsAt(imp, c.name);
    if (shots.length) {
      out.push(['Connected to', shots.map(s => s.to).join(', ')]);
      out.push(['Shots', shots.map(s => `→ ${s.to}: ${s.len.toFixed(2)} m · az ${s.az.toFixed(1)}° · inc ${s.inc >= 0 ? '+' : ''}${s.inc.toFixed(1)}°${s.excluded ? ' (excluded)' : ''}`).join('\n')]);
    }
    if (lrud) out.push(['LRUD', `L ${lrud.l.toFixed(2)} · R ${lrud.r.toFixed(2)} · U ${lrud.u.toFixed(2)} · D ${lrud.d.toFixed(2)} m`]);
    return out;
  }
  function surveyRelated(c) {
    const out = [], parts = cavePartsOf(c), code = c.code || '';
    const S = caveStats(parts, code);
    const sv = parts.map(p => (p.imp.parsed.surveys || []).find(s => s.code === code)).find(Boolean);
    if (sv && sv.desc) out.push(['Description', sv.desc]);
    out.push(['Stations', String(S.stations.size)], ['Length', fmtLen(S.len)]);
    let segs = [];
    if (c.cid && pj.P) segs = FL.segmentsOf(pj.P, c.cid).filter(g => g.shots.some(([a, b]) => S.stations.has(a) || S.stations.has(b)));
    if (segs.length) out.push(['Segments', segs.map(segText).join('\n')]);
    const dates = [...new Set(S.dates.concat(segs.map(g => g.date).filter(Boolean)))].sort();
    if (dates.length) out.push(['Dates', dates.join(', ')]);
    const team = [...new Set(segs.map(g => g.team).filter(Boolean))];
    if (team.length) out.push(['Team', team.join('; ')]);
    out.push(...tripsRelated(c.cid, segs.map(g => g.id)));
    return out;
  }
  function caveRelated(c) {
    const out = [], parts = cavePartsOf(c);
    const codes = [...new Set([].concat(...parts.map(p => (p.codes ? [...p.codes] : (p.imp.parsed.surveys || []).map(s => s.code)))))].filter(x => x !== '');
    const S = caveStats(parts, null);
    if (codes.length) out.push(['Surveys', codes.join(', ')]);
    out.push(['Length', fmtLen(S.len)], ['Depth', S.depth.toFixed(1) + ' m'], ['Stations', String(S.stations.size)]);
    if (c.cid && pj.pid && pj.P && FL.systemsOf) {
      FL.systemsOf(pj.P, c.cid).forEach(g => {
        out.push(['System', g.name + (g.caves.length > 1 ? ' · with ' + g.caves.filter(x => x !== c.cid).map(A.caveName).join(', ') : '')]);
        if (window._pjMulti) out.push(['System totals', window._pjMulti.systemLine(g)]);
      });
      const mf = ((pj.P.caves[c.cid] || {}).sources || []).map(s => s.file).find(f => pj.P.cavefiles[f] && pj.P.cavefiles[f].multi);
      if (mf) out.push(['Multi-cave file', mf + ' · shared with ' + (FL.liveCaves(pj.P).filter(x => x.id !== c.cid && (x.sources || []).some(s => s.file === mf)).map(x => x.name).join(', ') || 'no other cave yet')]);
    }
    if (S.dates.length) out.push(['Surveyed', S.dates.length > 1 ? S.dates[0] + ' – ' + S.dates[S.dates.length - 1] : S.dates[0]]);
    let tags = [];
    if (pj.pid && window._pjf) try { tags = window._pjf.scanTags().filter(t => t.cid && t.cid === c.cid); } catch (_) {}
    if (tags.length) out.push(['Entrances', tags.map((t, k) => `${t.point || 'point'} (station ${t.station || '?'}, ${t.from})${tags.length > 1 && t.main ? ' · main' : ''}`).join('\n')]);
    const anchor = parts.map(p => p.imp.georef).find(g => g && g.mode === 'anchor' && g.station && g.station !== '__first__');
    if (!tags.length && anchor) out.push(['Placed at', 'station ' + anchor.station]);
    if (parts.length) out.push(['Survey files', parts.map(p => p.imp.name).join(', ')]);
    out.push(...tripsRelated(c.cid));
    return out;
  }

  // ── Subjects ─────────────────────────────────────────────────────────────
  const uniq = ds => { const seen = new Set(); return ds.filter(d => d && !seen.has(d.id) && seen.add(d.id)); };
  const docsOn = t => (pj.D ? FL.docsForTarget(pj.D, t) : []);
  const leadItem = L => ({ id: L.id, rec: L, fields: L.fields, active: FL.leadActive(L) });
  const refEdit = ref => (ref && ref.editable && FE() ? () => FE().open(ref) : null);
  function shapeFacts(kind, cs) {
    const out = [];
    if (kind === 'line' && cs.length) out.push(['Length', fmtLen(lenOf(cs))], ['Points', String(cs.length)]);
    if (kind === 'area' && cs.length > 2) out.push(['Area', fmtArea(areaOf(cs))], ['Perimeter', fmtLen(lenOf(cs.concat([cs[0]])))], ['Points', String(cs.length)]);
    return out;
  }
  const posOfShape = (kind, cs) => (!cs || !cs.length ? null : kind === 'area' ? centre(cs) : cs[0]);

  function featureSubject(id) {
    const f = pj.P && pj.P.features[id];
    if (!f || f.removed) return null;
    const t = FL.T.feature(id), cs = f.coords || [];
    const ref = FE() ? FE().refOf({ source: 'project', id }) : null;
    const leads = Object.values(pj.P.leads).filter(L => !L.deleted && L.target === t);
    const folder = f.group ? FL.groupPath(pj.P, f.group).map(g => g.name).join(' / ') : '';
    const pos = posOfShape(f.kind, cs);
    const facts = [['Kind', KIND[f.kind] || f.kind]].concat(shapeFacts(f.kind, cs), pos ? posFacts(pos, f.kind) : []);
    return {
      key: 'feature:' + id, kind: 'feature', icon: KICON[f.kind] || '•', title: f.name || KIND[f.kind] || 'Feature',
      line: [KIND[f.kind], folder].filter(Boolean).join(' · '), color: window._pjf ? window._pjf.colorOf(f) : null,
      facts, desc: f.desc || '', target: t, ref, pos, self: { target: t },
      related: () => tagRelated(f.desc, 'project'),
      notes: FL.notesOn(pj.P, t), leads: leads.map(L => ({ item: leadItem(L), label: A.targetLabel(t) })),
      docs: uniq(docsOn(t).concat(...leads.map(L => docsOn(FL.T.lead(L.id))))),
      edit: refEdit(ref) || (() => window._pjf && window._pjf.editFeature(id)), hideInfo: true, canAdd: true,
    };
  }
  function leadSubject(id) {
    const L = pj.P && pj.P.leads[id];
    if (!L || L.deleted) return null;
    const at = A.targetLabel(L.target), p = FL.parseTarget(L.target), f = p.kind === 'feature' ? pj.P.features[p.feature] : null;
    const facts = [['Status', FL.statusLabel(L.fields.status || 'open')], ['At', at]];
    if (L.fields.priority) facts.push(['Priority', String(L.fields.priority)]);
    if (L.fields.types && L.fields.types.length) facts.push(['Needs', L.fields.types.join(', ')]);
    const pos = f && f.coords && f.coords[0] ? f.coords[0] : null;
    if (pos) facts.push(...posFacts(pos, 'point'));
    const t = FL.T.lead(id);
    return {
      key: 'lead:' + id, kind: 'lead', icon: '❓', title: 'Lead at ' + at, line: A.leadSummary(L.fields), facts, desc: L.fields.desc || '', target: t,
      pos, self: { lead: id, target: L.target }, ref: f && FE() ? FE().refOf({ source: 'project', id: f.id }) : null, refIsHost: true,
      notes: FL.notesOn(pj.P, t), leads: [], docs: uniq(docsOn(t).concat(f ? docsOn(L.target) : [])),
      edit: () => A.editLead(null, at, leadItem(L)), hideInfo: true, canAdd: true,
    };
  }
  // A cave, survey or station: from the card in the details panel.
  function cardSubject() {
    const c = pj.card;
    if (!c || !pj.pid || !c.cid || !pj.P) return null;
    const cave = A.caveName(c.cid);
    const cv = { cid: c.cid, file: c.imp ? c.imp.name : null, survey: c.code || '', station: c.name || null };
    if (c.level === 'cave') {
      const t = FL.T.cave(c.cid);
      const leads = Object.values(pj.P.leads).filter(L => !L.deleted && FL.parseTarget(L.target).cave === c.cid && FL.leadActive(L));
      return { key: t, kind: 'cave', icon: '🕳', title: cave, line: 'Cave', facts: [['Open leads', String(leads.length)]], desc: (pj.P.caves[c.cid] || {}).desc || '', target: t,
        cave: cv, related: () => caveRelated(c),
        notes: FL.notesOn(pj.P, t), leads: leads.slice(0, 30).map(L => ({ item: leadItem(L), label: A.targetLabel(L.target) })), docs: docsOn(t), canAdd: true };
    }
    if (c.survey) {
      const t = FL.T.survey(c.cid, c.code);
      return { key: t, kind: 'survey', icon: '〰️', title: 'Survey ' + (c.code || '(none)'), line: cave, facts: [['Cave', cave]], desc: '', target: t,
        cave: cv, related: () => surveyRelated(c),
        notes: FL.notesOn(pj.P, t), leads: [], docs: uniq(docsOn(t).concat(docsOn(FL.T.cave(c.cid)))), canAdd: true };
    }
    const t = FL.T.station(c.cid, c.name);
    const facts = [['Cave', cave]];
    if (c.code) facts.push(['Survey', c.code]);
    const sp = A.stationPos(c.cid, c.name);
    const pos = sp && window.Cesium ? cartoOf(sp) : null;
    if (pos) facts.push(...posFacts(pos, 'point'));
    const fs = FL.docsForStation(pj.D, pj.P, c.cid, c.name, c.code ? [c.code] : []);
    const leads = A.leadsAt(c.cid, c.name).filter(x => x.active);
    return { key: t, kind: 'station', icon: '📍', title: c.name, line: 'Station · ' + cave, facts, desc: '', target: t,
      cave: cv, pos, self: { station: (c.imp ? c.imp.name : '') + '|' + c.name, target: t }, related: () => stationRelated(c),
      notes: FL.notesOn(pj.P, t), leads: leads.map(x => ({ item: x, label: c.name, cid: c.cid, name: c.name })),
      docs: uniq([].concat(fs.station, fs.area || [], fs.segment || [], fs.survey, fs.cave, ...leads.filter(x => x.rec).map(x => docsOn(FL.T.lead(x.id))))), canAdd: true };
  }
  // Anything else on the map: a CalTopo or data-file feature, a My data point.
  function entitySubject(ent) {
    const now = window.Cesium ? Cesium.JulianDate.now() : null;
    const val = p => (p && p.getValue ? p.getValue(now) : p);
    const ref = FE() ? FE().refOf(ent) : null;
    let kind = ref ? ref.kind : 'point', cs = ref ? ref.coords : [];
    if (!ref) {
      try {
        if (ent.polygon) { const h = val(ent.polygon.hierarchy); kind = 'area'; cs = h && h.positions ? h.positions.map(cartoOf) : []; }
        else if (ent.polyline) { kind = 'line'; cs = (val(ent.polyline.positions) || []).map(cartoOf); }
        else if (ent.position) cs = [cartoOf(val(ent.position))];
      } catch (_) {}
    }
    const pos = posOfShape(kind, cs);
    const facts = [['Kind', KIND[kind]]].concat(shapeFacts(kind, cs), pos ? posFacts(pos, kind, !ref || (ref.source !== 'caltopo' && ref.source !== 'file')) : []);
    const from = ref ? (ref.source === 'caltopo' ? 'CalTopo' : ref.srcName) : '';
    const raw = String(val(ent.description) || '');
    const desc = ref ? ref.desc : raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
    const title = (ref && ref.name) || ent.name || KIND[kind];
    return { key: 'ent:' + ent.id, kind: 'entity', ent, entId: ent.id, icon: KICON[kind] || '•', title, line: [KIND[kind], from].filter(Boolean).join(' · '), facts, desc,
      color: ref ? ref.color : null, ref, pos, self: {}, related: () => tagRelated(desc, ref && ref.source),
      target: null, notes: [], leads: [], docs: [], hideInfo: false, brief: 'strip', edit: refEdit(ref) };
  }
  function subjectOf(ent) {
    if (!ent) return null;
    if (prop(ent, 'isCaveSurvey') || prop(ent, 'isFieldStation') || prop(ent, 'isProjectFootprint') || ent._caveLazy) return null;
    if (prop(ent, 'isProjectFeature')) { if (window._pjfState && window._pjfState.draw) return null; return featureSubject(prop(ent, 'featureId')); }
    if (prop(ent, 'isFeatureLead')) return leadSubject(prop(ent, 'leadId'));
    if (!ent.name && !ent.description && !prop(ent, 'myFeature') && !prop(ent, 'isUserLabel')) return null;
    return entitySubject(ent);
  }
  // The entity a subject was made from, now (a CalTopo refresh can replace it).
  function entityNow(s) {
    const e = s.ent, id = s.entId;
    if (e && e.entityCollection && e.entityCollection.getById(id) === e) return e;
    const w = window._ws;
    for (const src of (w && w.vectorSources ? w.vectorSources() : [])) { const x = src.ds.entities.getById(id); if (x) return x; }
    return (V() && V().entities.getById(id)) || null;
  }

  // ── Source, badges, folders ──────────────────────────────────────────────
  function sourceOf(s) {
    const r = s.refIsHost ? null : s.ref;
    if (r) {
      if (r.source === 'project') return { text: `Project “${r.srcName}”`, cls: 'pj' };
      if (r.source === 'mydata') return { text: 'My data', cls: 'my' };
      if (r.source === 'caltopo') return { text: `CalTopo map${r.mapId ? ' ' + r.mapId : ''}`, href: r.mapId ? 'https://caltopo.com/m/' + r.mapId : null, cls: 'ct' };
      if (r.source === 'file') return { text: `Data file “${r.srcName}”`, cls: 'file' };
      return r.srcName ? { text: r.srcName, cls: 'other' } : null;
    }
    if (pj.pid && pj.P && (s.cave || s.kind === 'lead')) return { text: `Project “${pj.P.name || pj.pid}”` + (s.cave && s.cave.file ? ` · survey file “${s.cave.file}”` : ''), cls: 'pj' };
    return null;
  }
  const ctSrc = () => { const w = window._ws; return (w && w.vectorSources && w.vectorSources().find(x => x.kind === 'caltopo')) || null; };
  function badgesOf(s) {
    const r = s.refIsHost ? null : s.ref, out = [];
    if (!r) return out;
    if (r.source === 'caltopo' && r.fid) {
      const W = CT(); let st = null;
      try { st = W && W.status ? W.status(r.fid) : null; } catch (_) {}
      if (st === 'waiting') out.push({ text: 'waiting for CalTopo', cls: 'wait', title: 'Saved here; it goes to CalTopo when FLEX is online again' });
      else if (st === 'conflict') out.push({ text: 'changed in CalTopo: choose', cls: 'conf', title: 'Changed in CalTopo and here: choose which version stays', click: () => FE() && FE().resolve(r) });
      else if (st === 'failed') out.push({ text: 'not saved to CalTopo', cls: 'conf', title: 'CalTopo refused the last change' });
      else if (st === 'changed') out.push({ text: 'changed in CalTopo', cls: 'chg', title: 'Changed in CalTopo since FLEX last showed it' });
    }
    if (r.source === 'project') {
      const src = ctSrc(), f = pj.P && pj.P.features[r.id];
      if (src && f && window._ctMatch) {
        let nin = false; try { nin = window._ctSend ? window._ctSend.isNotIn(f) : !window._ctMatch.matchFeature(f, src); } catch (_) { nin = false; }
        if (nin) {
          out.push({ text: 'not in CalTopo', cls: 'not', title: 'The project’s CalTopo map has no feature of this kind and name here' });
          if (window._ctSend) out.push({ text: 'Send to CalTopo', cls: 'not', title: 'Add it to the CalTopo map (you see what goes first)', click: () => window._ctSend.send({ feature: r.id }) });
        }
      }
    }
    if (!r.editable) out.push({ text: 'read-only', cls: 'ro', title: r.reason || '' });
    return out;
  }
  function sourceNode(s) {
    const src = sourceOf(s), bs = badgesOf(s);
    if (!src && !bs.length) return null;
    const d = el('div', 'inf-src');
    if (src) {
      d.appendChild(el('span', 'inf-src-t ' + (src.cls || ''), src.text));
      if (src.href) { const a = el('a', 'inf-ext', 'Open in CalTopo ↗'); a.href = src.href; a.target = '_blank'; a.rel = 'noopener'; d.appendChild(a); }
    }
    bs.forEach(b => {
      const x = el(b.click ? 'button' : 'span', 'inf-badge ' + b.cls, b.text);
      if (b.title) x.title = b.title;
      if (b.click) { x.type = 'button'; x.addEventListener('click', e => { e.stopPropagation(); b.click(); }); }
      d.appendChild(x);
    });
    return d;
  }
  function folderNode(s) {
    const r = s.refIsHost ? null : s.ref;
    if (!r || r.source === 'other') return null;
    const d = el('span', 'inf-path');
    const parts = r.path || [];
    if (!parts.length) { d.appendChild(el('span', 'inf-path-top', r.source === 'mydata' ? '(no group)' : '(top level)')); return d; }
    parts.forEach((p, i) => {
      if (i) d.appendChild(el('span', 'inf-path-sep', ' / '));
      const b = el('button', 'inf-path-part', p.name); b.type = 'button'; b.title = 'Open this folder in its list';
      b.addEventListener('click', e => { e.stopPropagation(); reveal(s, { open: true, folder: p.id }); });
      d.appendChild(b);
    });
    return d;
  }
  function styleFacts(s) {
    const r = s.refIsHost ? null : s.ref, out = [];
    if (!r) return out;
    if (r.color) out.push(['Colour', () => { const x = el('span', 'inf-colour'); const sw = el('span', 'inf-sw'); sw.style.background = r.color; x.append(sw, document.createTextNode(' ' + r.color)); return x; }]);
    if (r.source === 'caltopo' && r.kind === 'point') out.push(['Symbol', r.symbol || '(CalTopo’s default)']);
    if (r.label != null) out.push(['Name on the map', r.label ? 'shown' : 'hidden']);
    const who = x => (x && x.who ? ' · ' + x.who : '');
    if (r.created && r.created.t) out.push(['Created', when(r.created.t) + who(r.created)]);
    if (r.updated && r.updated.t) out.push(['Updated', when(r.updated.t) + who(r.updated)]);
    return out;
  }

  // ── The pane that lists it: reveal, Show in list ─────────────────────────
  const PANE = { surface: ['#featuresCollapsible', () => window._surfCols], caves: ['#caveCollapsible', () => window._caveCols] };
  function paneOf(s) {
    const r = s.refIsHost ? null : s.ref;
    if (r && r.source !== 'other') return 'surface';
    if (s.cave) return 'caves';
    return null;
  }
  /**
   * Where the row is (revealKey turns it into the pane's key):
   *   📍 Surface: { source: 'project' | 'mydata' | 'caltopo' | 'file', id, kind,
   *                 folder (the folder to open: its own, or one clicked in the path),
   *                 path: [folder ids, outermost first], entityId, url (data file) }
   *               (id null: the folder itself)
   *   🕳 Caves:   { source: 'cave', cave (project cave id), file (survey file), survey, station }
   */
  function revealArg(s, folder) {
    const r = s.ref;
    if (r && !s.refIsHost) {
      const onlyFolder = folder != null && folder !== r.folder;
      const path = (r.path || []).map(p => p.id);
      return { source: r.source, id: onlyFolder ? null : r.id, kind: r.kind, folder: folder != null ? folder : r.folder,
        path: onlyFolder ? path.slice(0, path.indexOf(folder) + 1) : path, entityId: r.entity ? r.entity.id : null, url: r.url || null };
    }
    if (s.cave) return { source: 'cave', cave: s.cave.cid, file: s.cave.file, survey: s.cave.survey, station: s.cave.station };
    return null;
  }
  /**
   * The key the pane's reveal(key, { open: true }) gets:
   *   CalTopo feature 'ct-<fid>' (a CalTopo folder 'ctf-<id>'), project feature id
   *   (a project folder: its group id), My data point id (a group: its id),
   *   data file { url, entityId } (a folder: its entity id), cave: the survey file name.
   */
  function revealKey(arg) {
    if (!arg) return null;
    if (arg.source === 'cave') return arg.file || arg.cave;
    // 📍 Surface's reveal() takes this object as it is ({source, id, folder, entityId, url};
    // id null with a folder = that folder), so nothing is lost turning it into a string key.
    return (arg.id || arg.folder) ? arg : null;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function flash(row) {
    if (!row) return false;
    try { row.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    row.classList.remove('inf-flash'); void row.offsetWidth; row.classList.add('inf-flash');
    setTimeout(() => row.classList.remove('inf-flash'), 1800);
    return true;
  }
  // Until 📍 Surface has reveal(): a project feature's folders open, its row flashes.
  async function revealProject(arg) {
    const o = window._pjfState && window._pjfState.open, sc = window._surfCols;
    if (!o || !sc || !pj.P) return false;
    const gid = arg.folder || '';
    if (gid) FL.groupPath(pj.P, gid).forEach(g => { o['g:' + g.id] = true; });
    else if (arg.id) o.loose = true;
    await sc.render();
    const q = sel => document.querySelector('#surf-cols ' + sel);
    const cs = window.CSS && CSS.escape ? CSS.escape : x => x;
    let row = arg.id ? q(`[data-feat="${cs(arg.id)}"]`) : null;
    if (!row && gid) { row = q(`.cc-it[data-kind="folder"][data-id="${cs(gid)}"]`); if (!row) { const b = q(`.sc-fold [data-gedit="${cs(gid)}"]`); row = b ? b.closest('.sc-sub') : null; } }
    return flash(row);
  }
  /** Reveal the subject's row in its pane; open: open the pane first (Show in list). */
  async function reveal(s, opts) {
    opts = opts || {};
    s = s || I.subject;
    if (!s) return false;
    const pane = paneOf(s);
    if (!pane) return false;
    const [sel, mod] = PANE[pane], box = document.querySelector(sel);
    const shown = !!(box && box.classList.contains('show'));
    if (!shown && !opts.open) return false;
    if (!shown) { const b = document.querySelector(`#flex-rail [data-target="${sel}"]`); if (b) b.click(); await sleep(400); }
    const M = mod(), arg = revealArg(s, opts.folder);
    let ok = false;
    const key = revealKey(arg);
    if (M && typeof M.reveal === 'function') { try { ok = !!(await M.reveal(key, { open: true })); } catch (e) { console.warn('[info] reveal', e); } }
    else if (pane === 'surface' && arg && arg.source === 'project') ok = await revealProject(arg);
    I.revealed = { pane, arg, key, ok, at: Date.now() };
    return ok;
  }

  // ── Media lists ──────────────────────────────────────────────────────────
  const isSk = d => !!(window._sketches && window._sketches.isSketch(d));
  const groups = docs => ({ photos: docs.filter(d => FL.docMedia(d) === 'photo'), videos: docs.filter(d => FL.docMedia(d) === 'video'), sketches: docs.filter(isSk), docs: docs.filter(d => !FL.docMedia(d) && !isSk(d)) });
  function counts(s) {
    const g = groups(s.docs || []), out = [];
    if (g.photos.length) out.push(`🖼 ${g.photos.length} photo${g.photos.length === 1 ? '' : 's'}`);
    if (g.videos.length) out.push(`🎞 ${g.videos.length} video${g.videos.length === 1 ? '' : 's'}`);
    if (g.sketches.length) out.push(`${g.sketches.length} sketch${g.sketches.length === 1 ? '' : 'es'}`);
    if (g.docs.length) out.push(`📄 ${g.docs.length} document${g.docs.length === 1 ? '' : 's'}`);
    if (s.notes && s.notes.length) out.push(`📝 ${s.notes.length}`);
    if (s.leads && s.leads.length) out.push(`❓ ${s.leads.length}`);
    return out;
  }
  const videoUrl = d => (d.file && d.file.path && pj.pid ? API + 'file?project=' + encodeURIComponent(pj.pid) + '&path=' + encodeURIComponent(d.file.path) : null);
  function tile(d, isVid) {
    const t = el('button', 'inf-tile' + (isVid ? ' vid' : '')); t.type = 'button'; t.title = (d.title || 'Untitled') + (d.date ? ' · ' + d.date : '');
    const p = d.pages[0];
    if (p && p.ext !== 'pdf') { const im = el('img'); im.loading = 'lazy'; im.src = A.blobUrl(p); if (p.rot) im.style.transform = `rotate(${p.rot}deg)`; t.appendChild(im); }
    else t.appendChild(el('span', 'inf-tile-x', isVid ? '🎞' : '🖼'));
    if (isVid) t.appendChild(el('span', 'inf-play', '▶'));
    t.appendChild(el('span', 'inf-tile-t', d.title || 'Untitled'));
    return t;
  }
  // The last edit of this subject (feature_editor.js), said where it is seen.
  function resultNode(s) {
    const R = I.result;
    if (!R || !s || R.key !== s.key || Date.now() - R.at > 120000) return null;
    return el('div', 'inf-result ' + R.cls, R.message);
  }

  // ── Brief (in the details panel) ─────────────────────────────────────────
  function briefNode(s) {
    const b = el('div', 'inf-brief' + (s.brief === 'strip' ? ' strip' : ''));
    if (s.brief !== 'strip') {
      const l = el('div', 'inf-line');
      if (s.color) { const sw = el('span', 'inf-sw'); sw.style.background = s.color; l.appendChild(sw); }
      l.appendChild(document.createTextNode(s.line || ''));
      b.appendChild(l);
    }
    const src = sourceNode(s); if (src) b.appendChild(src);
    const res = resultNode(s); if (res) b.appendChild(res);
    if (s.brief !== 'strip') {
      if (s.desc) b.appendChild(el('div', 'inf-desc clamp', s.desc));
      const c = counts(s);
      if (c.length) b.appendChild(el('div', 'inf-counts', c.join(' · ')));
    } else {
      const pos = (s.facts.find(f => f[0] === 'Position' || f[0] === 'Length' || f[0] === 'Area') || [])[1];
      if (pos) b.appendChild(el('div', 'inf-counts', pos));
    }
    const row = el('div', 'inf-acts');
    if (s.edit) row.appendChild(btn('Edit', () => { collapse(true); s.edit(); }, 'small inf-edit'));
    if (paneOf(s)) row.appendChild(btn('Show in list', () => reveal(s, { open: true }), 'small inf-list'));
    row.appendChild(btn('⤢ More', () => { expand(); I.pinned = true; paintPin(); }, 'small'));
    row.appendChild(el('span', 'inf-hint', 'hover for more'));
    b.appendChild(row);
    return b;
  }

  // ── Expanded (movable) ───────────────────────────────────────────────────
  function sec(box, title, n) { box.appendChild(el('div', 'inf-h', title + (n != null ? ` (${n})` : ''))); }
  function table(rows, cls) {
    const t = el('table', 'inf-facts' + (cls ? ' ' + cls : ''));
    rows.forEach(([k, v]) => {
      const r = el('tr'), td = el('td');
      if (v && typeof v === 'object' && v.async) {
        td.textContent = '…';
        v.async.then(x => { if (x == null) r.remove(); else td.textContent = x; });
      } else if (typeof v === 'function') { const n = v(); if (n) td.appendChild(n); }
      else td.textContent = v == null ? '' : String(v);
      r.append(el('th', null, k), td);
      t.appendChild(r);
    });
    return t;
  }
  function render() {
    const s = I.subject, x = I.x;
    if (!s || !x) return;
    stopMedia();
    x.querySelector('.inf-x-title').textContent = `${s.icon || ''} ${s.title}`.trim();
    const ed = x.querySelector('.inf-x-edit'); ed.style.display = s.edit ? '' : 'none';
    const body = x.querySelector('.inf-x-body'); body.textContent = '';
    if (s.line) body.appendChild(el('div', 'inf-line', s.line));
    const src = sourceNode(s); if (src) body.appendChild(src);
    const res = resultNode(s); if (res) body.appendChild(res);
    const fn = folderNode(s);
    const facts = s.facts.slice();
    if (fn) facts.splice(1, 0, [s.ref && s.ref.source === 'mydata' ? 'Group' : 'Folder', () => fn]);
    if (facts.length) body.appendChild(table(facts));
    const sty = styleFacts(s);
    if (sty.length) body.appendChild(table(sty, 'inf-style'));
    const ro = s.ref && !s.refIsHost && !s.ref.editable && s.ref.reason;
    if (ro) body.appendChild(el('div', 'inf-ro', s.ref.reason));
    if (s.desc) { sec(body, 'Description'); body.appendChild(el('div', 'inf-desc', s.desc)); }
    let rel = [];
    try { rel = s.related ? s.related() : []; } catch (e) { console.warn('[info] related', e); }
    if (rel.length) { sec(body, 'Related'); body.appendChild(table(rel, 'inf-rel')); }
    let nb = [];
    try { nb = s.pos ? nearby(s.pos, s.self) : []; } catch (e) { console.warn('[info] nearby', e); }
    if (nb.length) { sec(body, 'Nearby'); body.appendChild(table(nb, 'inf-near')); }
    if (s.notes.length) { sec(body, 'Notes', s.notes.length); s.notes.forEach(n => body.appendChild(A.noteEl(n))); }
    if (s.leads.length) { sec(body, 'Leads', s.leads.length); s.leads.forEach(L => body.appendChild(A.leadEl(L.cid || null, L.label, L.item))); }
    const g = groups(s.docs);
    if (g.photos.length) {
      sec(body, '🖼 Photos', g.photos.length);
      const grid = el('div', 'inf-grid');
      g.photos.forEach(d => { const t = tile(d, false); t.addEventListener('click', () => A.docOpen(d.id, 0)); grid.appendChild(t); });
      body.appendChild(grid);
    }
    if (g.videos.length) {
      sec(body, '🎞 Videos', g.videos.length);
      const player = el('div', 'inf-player');
      const grid = el('div', 'inf-grid');
      g.videos.forEach(d => {
        const t = tile(d, true);
        t.addEventListener('click', () => {
          const u = videoUrl(d);
          if (!u) { A.docOpen(d.id, 0); return; }               // no file to play: its document
          stopMedia();
          const head = el('div', 'inf-player-h');
          head.append(el('span', null, d.title || 'Video'), btn('■ Stop', stopMedia, 'small'), btn('⤢ Viewer', () => A.docOpen(d.id, 0), 'small'));
          const v = A.videoEl(u, d.pages[0] ? A.blobUrl(d.pages[0]) : null, 'inf-video');
          player.append(head, v);
          const vd = v.querySelector('video'); vd.autoplay = true;
          const pr = vd.play && vd.play(); if (pr && pr.catch) pr.catch(() => {});
          I.pinned = true; paintPin();                           // watching: it stays until closed
        });
        grid.appendChild(t);
      });
      body.append(player, grid);
    }
    if (g.sketches.length) { sec(body, 'Sketches', g.sketches.length); g.sketches.forEach(d => body.appendChild(A.docEl(d, s.target))); }
    if (g.docs.length) { sec(body, '📄 Documents', g.docs.length); g.docs.forEach(d => body.appendChild(A.docEl(d, s.target))); }
    if (!s.docs.length && s.target && pj.pid) body.appendChild(el('div', 'inf-none', 'No photos, videos, sketches or documents tagged to it yet.'));
    const r = el('div', 'inf-acts');
    if (s.ref && !s.refIsHost && s.ref.editable && s.ref.kind === 'point' && FE()) r.appendChild(btn('Move on the map', () => { collapse(true); FE().drag(s.ref); }, 'small inf-drag'));
    if (paneOf(s)) r.appendChild(btn('Show in list', () => reveal(s, { open: true }), 'small inf-list'));
    if (s.target && pj.pid && s.canAdd) r.append(btn('📄 Add files', () => A.addPages({ tags: [s.target] }), 'small'), btn('📝 Note', () => A.editNote(s.target, null), 'small'));
    if (r.childNodes.length) body.appendChild(r);
  }
  function paintPin() { if (I.x) I.x.querySelector('.inf-x-pin').classList.toggle('on', I.pinned); }
  function make() {
    const x = el('div'); x.id = 'info-x'; x.setAttribute('role', 'dialog'); x.setAttribute('aria-label', 'Details');
    x.innerHTML = '<div class="inf-x-head" title="Drag to move"><div class="inf-x-title"></div></div><div class="inf-x-body"></div>';
    const head = x.querySelector('.inf-x-head');
    const edit = btn('Edit', () => { const s = I.subject; collapse(true); if (s && s.edit) s.edit(); }, 'small inf-x-edit');
    const pin = btn('📌', () => { I.pinned = !I.pinned; paintPin(); }, 'small inf-x-pin'); pin.title = 'Keep it open';
    const close = el('button', 'inf-x-close', '×'); close.type = 'button'; close.title = 'Close (Esc)'; close.addEventListener('click', () => collapse(true));
    head.append(edit, pin, close);
    // Drag by the header: a moved panel stays (pinned).
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const r = x.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = ev => {
        x.style.left = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx)) + 'px';
        x.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px';
        if (!I.moved) { I.moved = true; I.pinned = true; paintPin(); }
      };
      const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    });
    x.addEventListener('pointerdown', e => { if (!e.target.closest('.inf-x-head') && !e.target.closest('.inf-x-close')) { I.pinned = true; paintPin(); } });
    x.addEventListener('mouseenter', () => { I.overX = true; clearTimeout(I.tClose); });
    x.addEventListener('mouseleave', () => { I.overX = false; leaveSoon(); });
    // The wheel scrolls the panel, never the map behind it.
    x.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    return x;
  }
  function place(x) {
    const ins = window._inspector && window._inspector.el, r = ins && ins.getBoundingClientRect();
    const w = Math.min(460, window.innerWidth - 24);
    x.style.width = w + 'px';
    const left = r && r.width ? r.left - w - 10 : window.innerWidth - w - 12;
    x.style.left = Math.max(8, left) + 'px';
    x.style.top = (r && r.width ? r.top : 52) + 'px';
  }
  function expand() {
    clearTimeout(I.tOpen);
    if (!I.subject) I.subject = cardSubject();
    if (!I.subject) return;
    if (!I.x) { I.x = make(); I.pinned = false; I.moved = false; document.body.appendChild(I.x); place(I.x); }
    paintPin();
    render();
  }
  /** Close the expanded panel (its video stopped and gone). */
  function collapse() {
    clearTimeout(I.tOpen); clearTimeout(I.tClose);
    if (!I.x) return;
    stopMedia();
    I.x.remove(); I.x = null; I.pinned = false; I.moved = false; I.overX = false;
  }
  function leaveSoon() {
    clearTimeout(I.tClose);
    if (!I.x || I.pinned) return;
    I.tClose = setTimeout(() => { if (!I.pinned && !I.overX && !I.overIns) collapse(); }, LEAVE_MS);
  }
  function stopMedia() {
    if (!I.x) return;
    const pl = I.x.querySelector('.inf-player');
    A.stopVideos(I.x);
    if (pl) pl.textContent = '';
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  /** Show a subject's brief in the details panel (null: none). */
  function show(s) {
    const same = s && I.subject && s.key === I.subject.key;
    I.subject = s;
    if (window._inspector) window._inspector.setBrief(s ? { node: briefNode(s), title: `${s.icon && s.brief !== 'strip' ? s.icon + ' ' : ''}${s.title}`, hideInfo: s.hideInfo } : null);
    if (I.x) { if (s && (same || I.pinned)) { if (!same || !I.x.querySelector('.inf-player video')) render(); } else collapse(); }
    if (s && !same) setTimeout(() => { if (I.subject === s) reveal(s, { open: false }); }, 60);     // its pane open: its row
  }
  function clear() { I.subject = null; collapse(); if (window._inspector && window._inspector.brief()) window._inspector.setBrief(null); }
  /** Saved changes (project.js, feature_editor.js, CalTopo): the same thing again, fresh. */
  let tChg = 0;
  function changed() {
    clearTimeout(tChg);
    tChg = setTimeout(() => {
      const s = I.subject; if (!s) return;
      let fresh;
      if (s.kind === 'feature') fresh = featureSubject(s.key.slice(8));
      else if (s.kind === 'lead') fresh = leadSubject(s.key.slice(5));
      else if (s.kind === 'entity') { const e = entityNow(s); fresh = e && (!s.ref || (FE() && FE().refOf(e))) ? entitySubject(e) : null; }
      else fresh = cardSubject();
      if (!fresh) { clear(); return; }
      if (s.kind === 'feature' || s.kind === 'lead' || s.kind === 'entity') show(fresh);
      else { I.subject = fresh; if (I.x && !I.x.querySelector('.inf-player video')) render(); }
    }, 150);
  }
  // The details panel closed (its ×, Esc, a click on empty map).
  function panelClosed() { if (I.subject || I.x) { I.subject = null; collapse(); } }
  // An edit (feature_editor.js): say how it went here too, then show it fresh.
  window.addEventListener('flex-feature-edited', e => {
    const d = e.detail || {}, s = I.subject, r = d.ref;
    if (s && r && s.ref && !s.refIsHost && s.ref.source === r.source && String(s.ref.id) === String(r.id)) {
      const res = d.result || {};
      I.result = { key: s.key, message: d.message, cls: res.queued ? 'wait' : res.conflict ? 'conf' : res.ok ? 'ok' : 'bad', at: Date.now() };
    }
    changed();
  });
  ['flex-caltopo-changed', 'flex-caltopo-queue'].forEach(n => window.addEventListener(n, () => changed()));

  const hook = setInterval(() => {
    const v = V(), ins = window._inspector;
    if (!v || !v.selectedEntityChanged || !ins) return;
    clearInterval(hook);
    v.selectedEntityChanged.addEventListener(ent => {
      // A project feature redrawn after an edit loses its map selection: select it again.
      const prev = I.selEnt; I.selEnt = ent || null;
      if (!ent && prev && I.subject && I.subject.kind === 'feature' && prev.entityCollection && !prev.entityCollection.contains(prev)) {   // gone from the map, not clicked away
        const id = I.subject.key.slice(8), at = Date.now();
        setTimeout(() => {
          if (v.selectedEntity || Date.now() - at > 2000 || !(pj.P && pj.P.features[id] && !pj.P.features[id].removed)) return;
          const src = window._pjfState && window._pjfState.src;
          const e = src && src.entities.values.find(x => x.name != null && prop(x, 'featureId') === id);
          if (e) v.selectedEntity = e;
        }, 300);
      }
      const s = subjectOf(ent);
      if (s) show(s);
      else if (I.subject && I.subject.kind !== 'cave' && I.subject.kind !== 'survey' && I.subject.kind !== 'station') clear();
      else { I.subject = null; if (I.x) collapse(); }
    });
    // Hovering the details panel a moment: the larger panel (not over the segment panel).
    const box = ins.el;
    box.addEventListener('mouseenter', () => {
      I.overIns = true; clearTimeout(I.tClose);
      if (I.x || box.classList.contains('with-dock')) return;
      clearTimeout(I.tOpen);
      I.tOpen = setTimeout(() => {
        if (!I.overIns || document.querySelector('.pj-modal') || pj.gallery) return;
        if (!(I.subject && window._inspector.brief()) && !(pj.card && box.querySelector('#pj-card.open'))) return;
        if (!window._inspector.brief()) I.subject = cardSubject();
        expand();
      }, HOVER_MS);
    });
    box.addEventListener('mouseleave', () => { I.overIns = false; clearTimeout(I.tOpen); leaveSoon(); });
  }, 300);
  // Esc closes the larger panel first (a dialog or the document viewer take it before).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !I.x || document.querySelector('.pj-modal') || pj.gallery) return;
    e.stopPropagation(); e.preventDefault();
    collapse();
  }, true);

  const st = document.createElement('style');
  st.textContent = `
  .inf-brief { padding: 8px 12px 10px; font-size: 12px; color: #e8e8ee; }
  .inf-brief.strip { padding: 4px 12px 8px; border-top: 1px solid rgba(255,255,255,.06); }
  .inf-line { color: rgba(255,255,255,.6); font-size: 11.5px; display: flex; align-items: center; gap: 6px; }
  .inf-sw { width: 10px; height: 10px; border-radius: 2px; flex: none; box-shadow: 0 0 0 1px rgba(0,0,0,.6); display: inline-block; vertical-align: -1px; }
  .inf-desc { white-space: pre-wrap; word-break: break-word; margin: 6px 0 2px; line-height: 1.4; }
  .inf-desc.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .inf-counts { color: rgba(255,255,255,.75); font-size: 11.5px; margin-top: 6px; }
  .inf-acts { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .inf-acts .pj-btn { margin: 0; }
  .inf-hint { color: rgba(255,255,255,.35); font-size: 10.5px; margin-left: auto; }
  .inf-src { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 8px; margin-top: 5px; font-size: 11.5px; }
  .inf-src-t { color: rgba(255,255,255,.8); }
  .inf-src-t.ct { color: #ff9a62; } .inf-src-t.pj { color: #6fd39a; } .inf-src-t.my { color: #8ab4ec; }
  .inf-ext { color: #8ab4ec; text-decoration: none; } .inf-ext:hover { text-decoration: underline; }
  .inf-badge { font-size: 10.5px; padding: 0 6px; line-height: 16px; border-radius: 8px; border: 1px solid currentColor; background: none; font-family: inherit; }
  .inf-badge.wait { color: #f2c24e; } .inf-badge.conf { color: #ff7b7b; cursor: pointer; } .inf-badge.chg { color: #8ab4ec; } .inf-badge.not { color: #f2c24e; } .inf-badge.ro { color: rgba(255,255,255,.5); }
  .inf-result { margin-top: 6px; font-size: 11.5px; padding: 3px 7px; border-radius: 5px; background: rgba(255,255,255,.06); }
  .inf-result.ok { color: #6fd39a; } .inf-result.wait { color: #f2c24e; } .inf-result.conf, .inf-result.bad { color: #ff7b7b; }
  .inf-ro { margin: 6px 0 2px; font-size: 11.5px; color: rgba(255,255,255,.55); font-style: italic; }
  .inf-path-part { background: none; border: none; padding: 0; color: #8ab4ec; cursor: pointer; font: inherit; }
  .inf-path-part:hover { text-decoration: underline; }
  .inf-path-sep, .inf-path-top { color: rgba(255,255,255,.45); }
  .inf-flash { animation: inf-flash 1.6s ease-out; }
  @keyframes inf-flash { 0%, 30% { background: rgba(255,230,0,.35); box-shadow: inset 0 0 0 1px #ffe600; } 100% { background: transparent; box-shadow: none; } }
  #info-x { position: fixed; z-index: 9600; max-height: calc(100vh - 70px); display: flex; flex-direction: column; background: rgba(16,18,26,.97); color: #e8e8ee;
    font: 12px system-ui, sans-serif; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; box-shadow: 0 14px 40px rgba(0,0,0,.55); }
  #info-x .inf-x-head { display: flex; align-items: center; gap: 6px; padding: 8px 6px 7px 12px; border-bottom: 1px solid rgba(255,255,255,.08); cursor: move; user-select: none; flex: none; touch-action: none; }
  #info-x .inf-x-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #info-x .inf-x-head .pj-btn { margin: 0; cursor: pointer; }
  #info-x .inf-x-pin { opacity: .45; } #info-x .inf-x-pin.on { opacity: 1; border-color: #f2c24e; }
  #info-x .inf-x-close { background: none; border: none; color: #98a3a0; font-size: 20px; line-height: 1; padding: 0 6px 2px; border-radius: 4px; cursor: pointer; }
  #info-x .inf-x-close:hover { color: #fff; background: rgba(255,255,255,.08); }
  #info-x .inf-x-body { overflow-y: auto; overscroll-behavior: contain; padding: 8px 12px 12px; min-height: 0; }
  #info-x .inf-facts { border-collapse: collapse; margin: 6px 0 2px; width: 100%; }
  #info-x .inf-facts th { text-align: left; font-weight: 500; color: rgba(255,255,255,.5); padding: 2px 10px 2px 0; white-space: nowrap; vertical-align: top; width: 1%; }
  #info-x .inf-facts td { padding: 2px 0; word-break: break-word; white-space: pre-line; }
  #info-x .inf-style { border-top: 1px solid rgba(255,255,255,.06); }
  #info-x .inf-h { font-weight: 700; margin: 12px 0 5px; color: #f2f4f3; }
  #info-x .inf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
  #info-x .inf-tile { position: relative; padding: 0; height: 84px; border: 1px solid rgba(255,255,255,.15); border-radius: 6px; overflow: hidden; background: #222; cursor: pointer; color: #fff; }
  #info-x .inf-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  #info-x .inf-tile-x { display: flex; height: 100%; align-items: center; justify-content: center; font-size: 26px; }
  #info-x .inf-tile-t { position: absolute; left: 0; right: 0; bottom: 0; font-size: 10px; padding: 2px 4px; background: rgba(0,0,0,.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  #info-x .inf-play { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -60%); font-size: 20px; width: 34px; height: 34px; line-height: 34px; border-radius: 50%; background: rgba(0,0,0,.55); }
  #info-x .inf-tile:hover { border-color: #8ab4ec; }
  #info-x .inf-player:not(:empty) { margin-bottom: 8px; }
  #info-x .inf-player-h { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; } #info-x .inf-player-h span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #info-x .inf-player-h .pj-btn { margin: 0; }
  #info-x .inf-video video { width: 100%; max-height: 50vh; background: #000; }
  #info-x .inf-none { color: rgba(255,255,255,.45); font-style: italic; margin-top: 10px; }`;
  document.head.appendChild(st);

  window._info = { show, clear, expand, collapse, stopMedia, changed, panelClosed, subjectOf, cardSubject, featureSubject, reveal, revealArg, nearby, utmText };
})();
