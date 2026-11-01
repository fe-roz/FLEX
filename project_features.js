// Surface features (📍 Features panel) — project doc 13, section 2–3.
//
//   Project features   the open project's own points, lines and areas, in
//                      folders that nest ("FLEX only — not in CalTopo"): draw
//                      on the map, import GPX / KML / GeoJSON, edit, download a
//                      folder (GeoJSON / KML / GPX) to upload to CalTopo by hand.
//                      Kept in the project library (feature.set / group.set),
//                      so they travel in sync files. Needs a project — a local
//                      one is fine (no CalTopo needed).
//   Overlay folders    the folders of the loaded CalTopo map and KML / GeoJSON
//                      files, each with show / hide. Works without a project.
//   Cave entrances     a point whose description has a line
//                        flex: cave=<cave name>; station=<entrance station>
//                      (a CalTopo marker, or a project point) places that cave
//                      at it, when you say so.
//
// Uses project.js (window._pjApi) and flex.js (window._ws). Without a project
// only the overlay folders show; FLEX is otherwise unchanged.
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) { console.warn('[features] project.js missing'); return; }
  const { pj, FL, el, btn, esc, toast, dialog, record } = A;
  const ws = () => window._ws;
  const V = () => window.cesiumViewer;
  const ROOT_COLOR = '#ffb020';
  const F = { src: null, draw: null, open: {}, srcOpen: {}, tags: [] };
  window._pjfState = F;                           // tests

  // ── Per-project (or no-project) view settings: hidden folders ────────────
  const hk = () => 'flex.pjf.hidden.' + (pj.pid || 'none');
  const hidden = () => { try { return JSON.parse(localStorage.getItem(hk()) || '{}'); } catch (_) { return {}; } };
  const setHidden = (k, v) => { const h = hidden(); if (v) h[k] = true; else delete h[k]; try { localStorage.setItem(hk(), JSON.stringify(h)); } catch (_) {} };

  // ── Drawing the project's features ───────────────────────────────────────
  const colorOf = f => (f.style && f.style.color) || (f.group && pj.P.groups[f.group] && groupColor(f.group)) || ROOT_COLOR;
  function groupColor(id) { for (const g of FL.groupPath(pj.P, id).reverse()) if (g.color) return g.color; return ROOT_COLOR; }
  function groupHidden(id) { const h = hidden(); if (h['root']) return true; return FL.groupPath(pj.P, id).some(g => h['g:' + g.id]); }
  function draw() {
    const v = V();
    if (!v || !window.Cesium) return;
    if (!F.src) { F.src = new Cesium.CustomDataSource('pj-features'); v.dataSources.add(F.src); }
    F.src.entities.removeAll();
    HL.divs.forEach(d => d.remove()); HL.divs.clear(); HL.mode = null;
    if (!pj.pid) return;
    FL.liveFeatures(pj.P).forEach(f => {
      if (groupHidden(f.group)) return;
      const c = Cesium.Color.fromCssColorString(colorOf(f));
      const props = { isProjectFeature: true, featureId: f.id };
      const pos = f.coords.map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2] || 0));
      const base = { name: f.name || ({ point: 'Point', line: 'Line', area: 'Area' }[f.kind]), description: esc(f.desc || '').replace(/\n/g, '<br>'), properties: props };
      if (f.kind === 'point') {
        F.src.entities.add(Object.assign(base, { position: pos[0],
          point: { pixelSize: 9, color: c, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: 5000 },
          label: window._pjfLabel(f.name || '') }));
      } else if (f.kind === 'line') {
        F.src.entities.add(Object.assign(base, { polyline: { positions: pos, width: 3, material: c, clampToGround: true } }));
      } else {
        F.src.entities.add(Object.assign(base, { polygon: { hierarchy: pos, material: c.withAlpha(0.25), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND } }));
        F.src.entities.add({ polyline: { positions: pos.concat([pos[0]]), width: 2, material: c, clampToGround: true }, properties: props });
      }
    });
    v.scene.requestRender && v.scene.requestRender();
  }

  // ── Picking a spot on the map ────────────────────────────────────────────
  function lonLatAt(screen) {
    const v = V(), ray = v.camera.getPickRay(screen);
    let c = null;
    try { c = ray && v.scene.globe.pick(ray, v.scene); } catch (_) { c = null; }
    // Terrain not loaded there yet (a tile skirt reads kilometres underground): the ellipsoid instead.
    if (c && Cesium.Cartographic.fromCartesian(c).height < -1000) c = null;
    if (!c) { try { c = v.camera.pickEllipsoid(screen, v.scene.globe.ellipsoid); } catch (_) { c = null; } }
    if (!c) return null;
    const k = Cesium.Cartographic.fromCartesian(c);
    return [+Cesium.Math.toDegrees(k.longitude).toFixed(7), +Cesium.Math.toDegrees(k.latitude).toFixed(7), +k.height.toFixed(1)];
  }
  // kind: point | line | area. Click to add; double-click or Enter to finish;
  // Backspace undoes a point; Esc or right-click cancels.
  function startDraw(kind, group) {
    const v = V();
    if (!v) return;
    stopDraw();
    const pts = [];
    const banner = el('div', 'pjf-banner');
    const say = () => { banner.textContent = kind === 'point' ? 'Click on the map to place the point · Esc to cancel'
      : `Click to add points (${pts.length}) · double-click or Enter to finish · Backspace undo · Esc cancel`; };
    say(); document.body.appendChild(banner);
    const h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    const def = v.screenSpaceEventHandler;
    const saved = [Cesium.ScreenSpaceEventType.LEFT_CLICK, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK].map(t => [t, def.getInputAction(t)]);
    saved.forEach(([t]) => def.removeInputAction(t));           // no picking / zooming while drawing
    const temp = kind === 'point' ? null : v.entities.add({ polyline: { positions: new Cesium.CallbackProperty(() => pts.concat(kind === 'area' && pts.length > 2 ? [pts[0]] : []).map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2])), false),
      width: 3, material: Cesium.Color.fromCssColorString(ROOT_COLOR), clampToGround: true } });
    const finish = async () => {
      const need = kind === 'line' ? 2 : kind === 'area' ? 3 : 1;
      if (pts.length < need) { toast(`A ${kind} needs at least ${need} points`); return; }
      const coords = pts.slice();
      stopDraw();
      await editFeature(null, { kind, coords, group: group || '' });
    };
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); stopDraw(); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(); }
      else if (e.key === 'Backspace' && pts.length) { e.preventDefault(); pts.pop(); say(); }
    };
    document.addEventListener('keydown', key, true);
    h.setInputAction(ev => {
      const p = lonLatAt(ev.position);
      if (!p) return;
      if (kind === 'point') { pts.push(p); finish(); return; }
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);          // a double-click's second click
      say();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction(() => finish(), Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    h.setInputAction(() => stopDraw(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    F.draw = { kind, pts, stop() { h.destroy(); if (temp) v.entities.remove(temp); banner.remove(); document.removeEventListener('keydown', key, true); saved.forEach(([t, fn]) => { if (fn) def.setInputAction(fn, t); }); } };
  }
  function stopDraw() { if (F.draw) { const d = F.draw; F.draw = null; d.stop(); } }

  // ── Editing ──────────────────────────────────────────────────────────────
  function groupSelect(cur) {
    const s = el('select', 'pj-input');
    s.appendChild(new Option('(top level)', ''));
    const add = (pid, depth) => FL.liveGroups(pj.P).filter(g => (g.parent || '') === pid).forEach(g => {
      s.appendChild(new Option('  '.repeat(depth) + g.name, g.id, false, g.id === cur)); add(g.id, depth + 1);
    });
    add('', 0);
    s.value = cur || '';
    return s;
  }
  async function editFeature(id, fresh) {
    if (!pj.pid) return;
    const f = id ? pj.P.features[id] : fresh;
    if (!f) return;
    const body = el('div', 'pj-form');
    const name = el('input', 'pj-input'); name.value = f.name || ''; name.placeholder = 'Name';
    const desc = el('textarea', 'pj-input'); desc.rows = 4; desc.value = f.desc || ''; desc.placeholder = 'Description (a line “flex: cave=…; station=…” marks a cave entrance)';
    const grp = groupSelect(f.group || '');
    const col = el('input'); col.type = 'color'; col.value = (f.style && f.style.color) || (f.group ? groupColor(f.group) : ROOT_COLOR);
    const lab = (t, x) => { const r = el('div', 'pj-f'); r.appendChild(el('div', 'pj-f-l', t)); r.appendChild(x); return r; };
    body.append(lab('Name', name), lab('Description', desc), lab('Folder', grp), lab('Colour', col));
    if (f.coords && f.kind === 'point') body.appendChild(el('div', 'pj-sub', `${f.coords[0][1].toFixed(6)}, ${f.coords[0][0].toFixed(6)}`));
    if (f.coords && f.kind !== 'point') body.appendChild(el('div', 'pj-sub', `${f.coords.length} points`));
    setTimeout(() => name.focus(), 50);
    // A point can carry a lead (a dig, a blowing hole): the "?" sits on it.
    const leadOn = id && f.kind === 'point' ? Object.values(pj.P.leads).find(L => !L.deleted && L.target === FL.T.feature(id)) : null;
    const r = await dialog({ title: (id ? '' : 'New ') + ({ point: 'point', line: 'line', area: 'area' }[f.kind]) + (id ? ` “${f.name || ''}”` : ''), body, wide: true,
      buttons: [{ label: 'Cancel', value: null }, ...(id ? [{ label: 'Delete', value: 'rm', danger: true }] : []),
        ...(id && f.kind === 'point' ? [{ label: leadOn ? '❓ Its lead…' : '❓ Make it a lead…', value: 'lead' }] : []), { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    if (r.button === 'lead') {
      const nm = '“' + (f.name || 'surface point') + '” (surface)';
      if (leadOn) A.editLead(null, nm, { id: leadOn.id, rec: leadOn, fields: leadOn.fields, active: FL.leadActive(leadOn) });
      else A.editLead(null, nm, { target: FL.T.feature(id), fields: { status: 'open', desc: f.desc || '' } });
      return;
    }
    if (r.button === 'rm') { await record('feature.set', { feature: id, removed: true }); return; }
    const data = { feature: id || FL.uid(12), kind: f.kind, name: name.value.trim().slice(0, 120), desc: desc.value.trim().slice(0, 4000), group: grp.value };
    const colour = col.value.toLowerCase();
    if (colour !== (grp.value ? groupColor(grp.value) : ROOT_COLOR).toLowerCase() || (f.style && f.style.color)) data.style = { color: colour };
    if (!id) data.coords = f.coords;
    await record('feature.set', data);
  }
  async function editGroup(id, parent) {
    const g = id ? pj.P.groups[id] : { name: '', parent: parent || '' };
    const body = el('div', 'pj-form');
    const name = el('input', 'pj-input'); name.value = g.name || ''; name.placeholder = 'Folder name';
    const par = groupSelect(g.parent || '');
    if (id) [...par.options].forEach(o => { if (o.value === id || FL.groupPath(pj.P, o.value).some(x => x.id === id)) o.disabled = true; });
    const col = el('input'); col.type = 'color'; col.value = g.color || (g.parent ? groupColor(g.parent) : ROOT_COLOR);
    const lab = (t, x) => { const r = el('div', 'pj-f'); r.appendChild(el('div', 'pj-f-l', t)); r.appendChild(x); return r; };
    body.append(lab('Name', name), lab('Inside', par), lab('Colour (for its features)', col));
    setTimeout(() => name.focus(), 50);
    const r = await dialog({ title: id ? `Folder “${g.name}”` : 'New folder', body,
      buttons: [{ label: 'Cancel', value: null }, ...(id ? [{ label: 'Delete folder', value: 'rm', danger: true }] : []), { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    if (r.button === 'rm') {
      const n = FL.liveFeatures(pj.P).filter(f => FL.groupPath(pj.P, f.group).some(x => x.id === id)).length;
      const ok = !n || await dialog({ title: `Delete “${g.name}”?`, text: `Its ${n} feature(s) move to the top level (nothing is lost; undo in 📁 History).`, buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'rm', danger: true }] });
      if (ok) await record('group.set', { group: id, removed: true });
      return;
    }
    if (!name.value.trim()) return;
    await record('group.set', { group: id || FL.uid(10), name: name.value.trim().slice(0, 80), parent: par.value, color: col.value });
  }

  // ── Import and download ──────────────────────────────────────────────────
  function pick(accept) {
    return new Promise(res => { const i = el('input'); i.type = 'file'; i.accept = accept; i.style.display = 'none'; i.addEventListener('change', () => { res(i.files[0] || null); i.remove(); }); document.body.appendChild(i); i.click(); });
  }
  const lonlat = c => { const k = Cesium.Cartographic.fromCartesian(c); return [+Cesium.Math.toDegrees(k.longitude).toFixed(7), +Cesium.Math.toDegrees(k.latitude).toFixed(7), +k.height.toFixed(1)]; };
  // Features of a loaded data source (KML / GPX / GeoJSON), with their folder path.
  function walk(ds) {
    const now = Cesium.JulianDate.now(), out = [];
    const val = p => (p && p.getValue ? p.getValue(now) : p);
    ds.entities.values.forEach(e => {
      const path = []; let p = e.parent; while (p) { if (p.name) path.unshift(p.name); p = p.parent; }
      let kind = null, coords = null;
      if (e.polygon) { const h = val(e.polygon.hierarchy); if (h && h.positions && h.positions.length > 2) { kind = 'area'; coords = h.positions.map(lonlat); } }
      else if (e.polyline) { const ps = val(e.polyline.positions); if (ps && ps.length > 1) { kind = 'line'; coords = ps.map(lonlat); } }
      else if (e.position && (e.billboard || e.point || e.label || !e.entityCollection || true)) { const ps = val(e.position); if (ps) { kind = 'point'; coords = [lonlat(ps)]; } }
      if (!kind) return;
      if (kind === 'area' && coords.length > 3) { const a = coords[0], b = coords[coords.length - 1]; if (a[0] === b[0] && a[1] === b[1]) coords.pop(); }
      out.push({ kind, coords, name: e.name || '', desc: String(val(e.description) || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(), path });
    });
    return out;
  }
  async function loadFile(file) {
    const n = file.name.toLowerCase();
    if (/\.gpx$/.test(n)) return Cesium.GpxDataSource.load(file, { clampToGround: true });
    if (/\.(geo)?json$/.test(n)) return Cesium.GeoJsonDataSource.load(JSON.parse(await file.text()));
    return Cesium.KmlDataSource.load(file, { camera: V().scene.camera, canvas: V().scene.canvas, clampToGround: true });
  }
  async function importFile(parent) {
    if (!pj.pid) return;
    const file = await pick('.gpx,.kml,.kmz,.geojson,.json');
    if (!file) return;
    let items;
    try { items = walk(await loadFile(file)); } catch (e) { dialog({ title: 'Could not read the file', text: e.message || String(e) }); return; }
    if (!items.length) { toast('No points, lines or areas in that file'); return; }
    toast(`Importing ${items.length} feature(s)…`);
    const top = FL.uid(10), q = { quiet: true };
    await record('group.set', { group: top, name: file.name.replace(/\.[^.]+$/, '').slice(0, 80), parent: parent || '' }, null, q);
    const groups = new Map([['', top]]);
    const groupFor = async path => {
      let id = top, key = '';
      for (const nm of path) {
        key += '/' + nm;
        if (!groups.has(key)) { const g = FL.uid(10); await record('group.set', { group: g, name: nm.slice(0, 80), parent: id }, null, q); groups.set(key, g); }
        id = groups.get(key);
      }
      return id;
    };
    for (const it of items) await record('feature.set', { feature: FL.uid(12), kind: it.kind, coords: it.coords, name: it.name.slice(0, 120), desc: it.desc.slice(0, 4000), group: await groupFor(it.path) }, null, q);
    F.open['g:' + top] = true;
    A.refresh('feature.set');
    toast(`Imported ${items.length} feature(s) into “${file.name}”`);
  }
  function download(gid, fmt) {
    const g = gid ? pj.P.groups[gid] : null;
    const base = ((g && g.name) || (pj.P.name || 'project') + ' features').replace(/[^\w.-]+/g, '-');
    const [text, type, ext] = fmt === 'kml' ? [FL.featuresKML(pj.P, gid, g ? g.name : (pj.P.name || 'FLEX') + ' — FLEX only'), 'application/vnd.google-earth.kml+xml', 'kml']
      : fmt === 'gpx' ? [FL.featuresGPX(pj.P, gid), 'application/gpx+xml', 'gpx']
      : [JSON.stringify(FL.featuresGeoJSON(pj.P, gid), null, 1), 'application/geo+json', 'geojson'];
    const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = `${base}.${ext}`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  async function downloadMenu(gid) {
    const r = await A.choose('Download for CalTopo', 'CalTopo imports any of these (Import… in its map menu). KML keeps the folders; GPX is the most widely read.', [
      { label: 'KML (keeps folders)', value: 'kml', primary: true }, { label: 'GeoJSON', value: 'geojson' }, { label: 'GPX', value: 'gpx' }]);
    if (r) download(gid, r);
  }
  // The map's unsaved points (right-click → add) into the project.
  async function adoptPoints() {
    const v = V(), now = Cesium.JulianDate.now();
    const es = v.entities.values.filter(e => e.properties && e.properties.isUserLabel && e.position);
    for (const e of es) {
      const nm = e.label && e.label.text ? (e.label.text.getValue ? e.label.text.getValue(now) : e.label.text) : (e.name || 'Point');
      await record('feature.set', { feature: FL.uid(12), kind: 'point', coords: [lonlat(e.position.getValue(now))], name: String(nm).slice(0, 120), group: '' }, null, { quiet: true });
      if (window._myData) await window._myData.forgetPoint(e, 'moved');      // moved out of My data
      v.entities.remove(e);
    }
    A.refresh('feature.set');
    toast(`${es.length} point(s) are now in the project`);
  }

  // ── Overlay folders (CalTopo map, data files) ────────────────────────────
  function overlayTree(src) {
    // Folder entities are those other entities hang under; Cesium hides a
    // folder's children with it.
    const kids = new Map();
    src.ds.entities.values.forEach(e => { const p = e.parent || null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(e); });
    return kids;
  }
  const srcKey = (src, path) => 's:' + (src.url || src.name) + '|' + path;
  function applyOverlayHidden() {
    const w = ws(); if (!w) return;
    const h = hidden();
    w.vectorSources().forEach(src => {
      const kids = overlayTree(src);
      const visit = (parent, path) => (kids.get(parent) || []).forEach(e => {
        const p = path + '/' + (e.name || e.id);
        e.show = !h[srcKey(src, p)];
        visit(e, p);
      });
      visit(null, '');
    });
  }

  // ── Cave entrances from point descriptions ───────────────────────────────
  function scanTags() {
    const out = [], w = ws(), now = window.Cesium ? Cesium.JulianDate.now() : null;
    if (!pj.pid || !w) return out;
    w.vectorSources().forEach(src => src.ds.entities.values.forEach(e => {
      if (!e.position) return;
      const d = e.description && (e.description.getValue ? e.description.getValue(now) : e.description);
      const t = FL.flexTag(d);
      if (!t) return;
      const p = e.position.getValue(now); if (!p) return;
      out.push(Object.assign({ from: src.kind === 'caltopo' ? 'CalTopo' : src.name, point: e.name || '', at: lonlat(p) }, t));
    }));
    FL.liveFeatures(pj.P).forEach(f => { const t = FL.flexTag(f.desc); if (t && f.kind === 'point') out.push(Object.assign({ from: 'this project', point: f.name, at: f.coords[0] }, t)); });
    out.forEach(t => {
      const cid = FL.caveForName(pj.P, t.cave);
      const cv = cid && pj.P.caves[cid];
      t.cid = cid || null;
      t.file = cv ? ((cv.sources || []).map(s => s.file).find(fl => pj.P.cavefiles[fl] && !pj.P.cavefiles[fl].removed) || null) : (pj.P.cavefiles[t.cave] ? t.cave : null);
      const place = t.file && pj.P.cavefiles[t.file].place;
      t.placedHere = !!(place && place.mode === 'anchor' && place.station === t.station &&
        Math.abs(place.lat - t.at[1]) < 1e-5 && Math.abs(place.lon - t.at[0]) < 1e-5);
    });
    F.tags = out;
    return out;
  }
  async function placeAtTag(t) {
    const w = ws(), cf = pj.P.cavefiles[t.file];
    if (!cf) return;
    let elev = t.at[2] || 0;
    try {
      const k = [Cesium.Cartographic.fromDegrees(t.at[0], t.at[1])];
      const s = await Cesium.sampleTerrainMostDetailed(V().terrainProvider, k);
      if (s && s[0] && isFinite(s[0].height)) elev = s[0].height;
    } catch (_) {}
    const old = cf.place || {};
    const place = { mode: 'anchor', station: t.station, lat: t.at[1], lon: t.at[0], elev: +elev.toFixed(1), survey: '', declination: old.declination ?? null };
    if (old.heights) place.heights = old.heights;
    if (old.mode === 'anchor' && old.station === t.station && old.controlPoints) place.controlPoints = old.controlPoints;
    await record('cavefile.set', { file: t.file, place });
    const r = await fetch('/api/lib/blob/' + cf.h + '.' + (cf.ext || 'plt'));
    if (!r.ok) { toast('The survey file isn’t on this computer'); return; }
    const style = (w.caveState().find(c => c.name === t.file) || {}).displayOptions || null;
    w.switching = true;
    try { w.removeCave(t.file); w.loadCave(t.file, await r.text(), place, style); } finally { w.switching = false; }
    toast(`${t.cave} placed at ${t.point || 'the marker'} (station ${t.station})`);
  }
  // For the workspace list: the tag to paste into a CalTopo marker.
  function copyTag(file) {
    const cv = FL.liveCaves(pj.P).find(c => (c.sources || []).some(s => s.file === file));
    const place = (pj.P.cavefiles[file] || {}).place;
    const imp = (window._caveImports || []).find(i => i.name === file);
    const st = (place && place.station && place.station !== '__first__' && place.station) || (imp && imp.parsed.stations[0] && imp.parsed.stations[0].name) || '?';
    const tag = FL.makeFlexTag(cv ? cv.name : file.replace(/\.plt$/i, ''), st);
    (navigator.clipboard ? navigator.clipboard.writeText(tag) : Promise.reject()).then(() => toast('Copied: ' + tag), () => dialog({ title: 'CalTopo tag', text: 'Put this line in the description of the entrance marker in CalTopo:', input: { value: tag } }));
    return tag;
  }

  // ── The panel ────────────────────────────────────────────────────────────
  function sec(root, title, open, build, keyName) {
    const k = keyName || title;
    const s = el('div', 'lp-section');
    const h = el('div', 'lp-section-header');
    const isOpen = F.open[k] != null ? F.open[k] : open;
    h.innerHTML = `<span class="lp-section-arrow">${isOpen ? '▾' : '▸'}</span> ${esc(title)}`;
    const b = el('div', 'lp-section-body' + (isOpen ? ' open' : ''));
    h.addEventListener('click', () => { F.open[k] = !b.classList.contains('open'); b.classList.toggle('open', F.open[k]); h.querySelector('.lp-section-arrow').textContent = F.open[k] ? '▾' : '▸'; });
    s.append(h, b); root.appendChild(s); build(b);
  }
  function render() {
    const root = document.getElementById('pjf-panel');
    if (!root) return;
    root.textContent = '';
    // Project features.
    sec(root, pj.pid ? 'Project features — FLEX only, not in CalTopo' : 'Project features', true, b => {
      if (!pj.pid) {
        b.appendChild(el('div', 'pj-note', 'Points, lines and areas you draw or import are kept in a project, in folders, and can be downloaded for CalTopo. A local project is enough — it needs no CalTopo map.'));
        const r = el('div', 'pj-row');
        r.appendChild(btn('📁 New local project…', () => A.newProject(), 'small primary'));
        r.appendChild(btn('Open a project', () => document.getElementById('pj-top-btn') && document.getElementById('pj-top-btn').click(), 'small'));
        b.appendChild(r);
        return;
      }
      const bar = el('div', 'pj-row');
      bar.append(btn('＋ Point', () => startDraw('point', ''), 'small'), btn('＋ Line', () => startDraw('line', ''), 'small'), btn('＋ Area', () => startDraw('area', ''), 'small'),
        btn('＋ Folder', () => editGroup(null, ''), 'small'), btn('⇪ Import…', () => importFile(''), 'small'), btn('⇩ Download', () => downloadMenu(''), 'small'));
      b.appendChild(bar);
      const un = V() ? V().entities.values.filter(e => e.properties && e.properties.isUserLabel).length : 0;
      if (un) b.appendChild(el('div', 'pj-sub', `${un} point(s) of yours are in 👤 My data (above): ← moves a sitting’s points into the project.`));
      const all = FL.liveFeatures(pj.P), groups = FL.liveGroups(pj.P);
      if (!all.length && !groups.length) b.appendChild(el('div', 'pj-note', 'Nothing yet. Draw on the map, or import a GPX / KML / GeoJSON file. Download a folder to upload it to CalTopo.'));
      const h = hidden();
      const rootRow = el('label', 'pj-row pjf-row');
      const rcb = el('input'); rcb.type = 'checkbox'; rcb.checked = !h['root'];
      rcb.addEventListener('change', () => { setHidden('root', !rcb.checked); draw(); });
      rootRow.append(rcb, el('span', 'pj-sub', `Show all (${all.length})`));
      b.appendChild(rootRow);
      const icon = { point: '•', line: '〰', area: '▱' };
      const featRow = (f, depth) => {
        const r = el('div', 'pjf-item');
        r.style.paddingLeft = (8 + depth * 14) + 'px';
        r.innerHTML = `<span style="color:${esc(colorOf(f))}">${icon[f.kind]}</span> <span class="pjf-name">${esc(f.name || '(no name)')}${FL.flexTag(f.desc) ? ' <span class="pj-sub">🕳</span>' : ''}</span>`;
        rowActs(r, () => ({ kind: f.kind, coords: f.coords, key: 'f:' + f.id }));
        r.appendChild(btn('✏️', () => editFeature(f.id), 'small pjf-edit'));
        return r;
      };
      const folder = (pid, depth) => {
        groups.filter(g => (g.parent || '') === pid).forEach(g => {
          const n = FL.liveFeatures(pj.P).filter(f => FL.groupPath(pj.P, f.group).some(x => x.id === g.id)).length;
          const r = el('div', 'pjf-folder');
          r.style.paddingLeft = (4 + depth * 14) + 'px';
          const open = !!F.open['g:' + g.id];
          const arrow = el('span', 'pjf-arrow', open ? '▾' : '▸');
          arrow.addEventListener('click', () => { F.open['g:' + g.id] = !open; render(); });
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = !h['g:' + g.id];
          cb.addEventListener('change', () => { setHidden('g:' + g.id, !cb.checked); draw(); });
          const nm = el('span', 'pjf-name'); nm.innerHTML = `<span class="pjs-sw" style="background:${esc(groupColor(g.id))}"></span>📁 ${esc(g.name)} <span class="pj-sub">(${n})</span>`;
          nm.addEventListener('click', () => { F.open['g:' + g.id] = !open; render(); });
          const tools = el('span', 'pjf-tools');
          tools.append(btn('＋', async () => {
            const k = await A.choose(`Add to “${g.name}”`, '', [{ label: '• Point', value: 'point' }, { label: '〰 Line', value: 'line' }, { label: '▱ Area', value: 'area' }, { label: '📁 Folder', value: 'folder' }, { label: '⇪ Import a file', value: 'import' }]);
            if (k === 'folder') editGroup(null, g.id); else if (k === 'import') importFile(g.id); else if (k) startDraw(k, g.id);
          }, 'small'), btn('⇩', () => downloadMenu(g.id), 'small'), btn('✏️', () => editGroup(g.id), 'small'));
          r.append(arrow, cb, nm, tools);
          b.appendChild(r);
          if (open) { folder(g.id, depth + 1); all.filter(f => f.group === g.id).forEach(f => b.appendChild(featRow(f, depth + 1))); }
        });
      };
      folder('', 0);
      all.filter(f => !f.group).forEach(f => b.appendChild(featRow(f, 0)));
    }, 'features');
    // Cave entrances found in point descriptions.
    if (pj.pid) {
      const tags = scanTags();
      sec(root, `Cave entrances (${tags.length})`, tags.some(t => !t.placedHere), b => {
        b.appendChild(el('div', 'pj-note', 'A point whose description has a line “flex: cave=<cave name>; station=<entrance station>” — in CalTopo or here — marks where a cave’s entrance is. FLEX places the cave there when you say so. 📁 → What this project loads → “Copy CalTopo tag” gives you the line.'));
        if (!tags.length) b.appendChild(el('div', 'pj-sub', 'None found.'));
        tags.forEach(t => {
          const r = el('div', 'pj-item');
          r.appendChild(el('div', 'pj-item-t', `🕳 ${t.cave} · station ${t.station || '?'}`));
          r.appendChild(el('div', 'pj-sub', `${t.point || 'point'} (${t.from}) · ${t.at[1].toFixed(5)}, ${t.at[0].toFixed(5)}`));
          const row = el('div', 'pj-row');
          if (!t.cid && !t.file) row.appendChild(el('span', 'pj-sub', 'No cave of that name in this project (check the name, or add the cave).'));
          else if (!t.file) row.appendChild(el('span', 'pj-sub', 'The cave’s survey file isn’t stored in the project yet: load it and save.'));
          else if (t.placedHere) row.appendChild(el('span', 'pj-sub', '✓ placed here'));
          else row.appendChild(btn('Place the cave here', () => placeAtTag(t), 'small primary'));
          r.appendChild(row);
          b.appendChild(r);
        });
      }, 'tags');
    }
    // Overlay folders.
    const w = ws(), srcs = w ? w.vectorSources() : [];
    sec(root, `Map overlay folders (${srcs.length})`, false, b => {
      if (!srcs.length) { b.appendChild(el('div', 'pj-note', 'The project’s CalTopo map (📁 Project → CalTopo map) and KML / GeoJSON files (Data Files below) show their folders here, each with show / hide.')); return; }
      const h = hidden();
      srcs.forEach(src => {
        const kids = overlayTree(src);
        b.appendChild(el('div', 'pj-h', (src.kind === 'caltopo' ? '🗺 ' : '📄 ') + src.name));
        const visit = (parent, path, depth) => (kids.get(parent) || []).forEach(e => {
          const p = path + '/' + (e.name || e.id), isFolder = kids.has(e);
          if (!isFolder && depth > 0 && !F.srcOpen[srcKey(src, path)]) return;
          if (!isFolder && depth === 0 && (kids.get(null) || []).length > 40) return;      // long flat lists: folders only
          const r = el('div', isFolder ? 'pjf-folder' : 'pjf-item');
          r.style.paddingLeft = (4 + depth * 14) + 'px';
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = !h[srcKey(src, p)];
          cb.addEventListener('change', () => { setHidden(srcKey(src, p), !cb.checked); applyOverlayHidden(); });
          const nm = el('span', 'pjf-name', (isFolder ? (F.srcOpen[srcKey(src, p)] ? '▾ 📁 ' : '▸ 📁 ') : '') + (e.name || '(no name)') + (isFolder ? ` (${(kids.get(e) || []).length})` : ''));
          if (isFolder) nm.addEventListener('click', () => { F.srcOpen[srcKey(src, p)] = !F.srcOpen[srcKey(src, p)]; render(); });
          else rowActs(r, () => Object.assign(entCoords(e) || {}, { key: 'e:' + e.id }));
          r.append(cb, nm);
          b.appendChild(r);
          if (isFolder && F.srcOpen[srcKey(src, p)]) visit(e, p, depth + 1);
        });
        visit(null, '', 0);
      });
    }, 'overlays');
  }
  // ── Fly to and highlight (double-click a row; a click only highlights) ───
  // Heights: imported / CalTopo points are clamped to the ground and stored at
  // 0, so the ground under them is looked up before flying there.
  async function grounded(coords) {
    const v = V(), out = [], need = [];
    coords.forEach((p, i) => {
      if (p[2]) { out[i] = p[2]; return; }
      const h = v.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(p[0], p[1]));
      if (h != null && isFinite(h)) out[i] = h; else need.push(i);
    });
    if (need.length) {
      try {
        const k = await Cesium.sampleTerrainMostDetailed(v.terrainProvider, need.map(i => Cesium.Cartographic.fromDegrees(coords[i][0], coords[i][1])));
        need.forEach((i, j) => { out[i] = isFinite(k[j].height) ? k[j].height : 0; });
      } catch (_) { need.forEach(i => { out[i] = 0; }); }
    }
    return coords.map((p, i) => [p[0], p[1], out[i] || 0]);
  }
  function entCoords(e) {
    const now = Cesium.JulianDate.now(), val = p => (p && p.getValue ? p.getValue(now) : p);
    if (e.polygon) { const h = val(e.polygon.hierarchy); if (h && h.positions) return { kind: 'area', coords: h.positions.map(lonlat) }; }
    if (e.polyline) { const ps = val(e.polyline.positions); if (ps && ps.length) return { kind: 'line', coords: ps.map(lonlat) }; }
    if (e.position) { const p = val(e.position); if (p) return { kind: 'point', coords: [lonlat(p)] }; }
    return null;
  }
  async function highlight(g, fly) {
    const v = V(); if (!v || !g || !g.coords || !g.coords.length) return;
    if (!F.hl) { F.hl = new Cesium.CustomDataSource('pjf-highlight'); v.dataSources.add(F.hl); }
    F.hl.entities.removeAll();
    F.hlKey = g.key || null;
    const coords = await grounded(g.coords);
    const pos = coords.map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2]));
    const Y = Cesium.Color.fromCssColorString('#ffe600');
    if (g.kind === 'point') {
      F.hl.entities.add({ position: pos[0], point: { pixelSize: 22, color: Y.withAlpha(0.25), outlineColor: Y, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    } else {
      F.hl.entities.add({ polyline: { positions: g.kind === 'area' ? pos.concat([pos[0]]) : pos, width: 7, material: new Cesium.PolylineGlowMaterialProperty({ color: Y, glowPower: 0.25 }), clampToGround: true } });
    }
    if (fly) {
      const bs = Cesium.BoundingSphere.fromPoints(pos); bs.radius = Math.max(bs.radius * 1.5, 120);
      v.camera.flyToBoundingSphere(bs, { duration: 1.0, offset: new Cesium.HeadingPitchRange(v.camera.heading, Cesium.Math.toRadians(-40), Math.max(bs.radius * 2.5, 250)) });
    }
    v.scene.requestRender && v.scene.requestRender();
  }
  function clearHighlight() { if (F.hl) F.hl.entities.removeAll(); F.hlKey = null; }
  const flyTo = f => highlight({ kind: f.kind, coords: f.coords, key: 'f:' + f.id }, true);
  // A row: click highlights, double-click flies there too.
  function rowActs(r, get) {
    let t = null;
    r.addEventListener('click', ev => { if (ev.target.closest('button,input')) return; clearTimeout(t); t = setTimeout(() => highlight(get(), false), 220); });
    r.addEventListener('dblclick', ev => { if (ev.target.closest('button,input')) return; clearTimeout(t); highlight(get(), true); });
    r.title = 'Click: highlight · double-click: fly there';
  }

  // ── Labels: Cesium's own look on the globe; with LiDAR loaded, drawn over
  // the point cloud (as the points of interest are) so they show through it.
  window._pjfLabel = text => ({
    text, font: '15px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -10),
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000),
    disableDepthTestDistance: 5000,
  });
  const lidarShown = () => (HL.force != null ? HL.force : false) || ((window.potreeViewer && window.potreeViewer.scene && window.potreeViewer.scene.pointclouds) || []).some(pc => pc.visible !== false);
  const HL = { divs: new Map(), heights: new Map(), mode: null, box: null };
  window._pjfHtml = HL;                          // tests
  function labelled() {
    const out = [];
    if (F.src) F.src.entities.values.forEach(e => { if (e.label && e.position) out.push(e); });
    const w = ws();
    if (w) w.vectorSources().forEach(src => src.ds.entities.values.forEach(e => { if (e.label && e.position) out.push(e); }));
    return out;
  }
  function updateHtml() {
    const v = V(); if (!v) return;
    const on = lidarShown();
    const ents = labelled();
    if (!on) {
      if (HL.mode !== false) {
        HL.divs.forEach(d => d.remove()); HL.divs.clear();
        ents.forEach(e => { if (e._pjfHid) { e.label.show = true; if (e.point) e.point.show = true; if (e.billboard) e.billboard.show = true; e._pjfHid = false; } });
        HL.mode = false;
      }
      return;
    }
    HL.mode = true;
    if (!HL.box) HL.box = document.getElementById('html_label_container') || document.body;
    const now = Cesium.JulianDate.now(), live = new Set();
    for (const e of ents) {
      if (!e._pjfHid) { e.label.show = false; if (e.point) e.point.show = false; if (e.billboard) e.billboard.show = false; e._pjfHid = true; }
      if (!e.isShowing) continue;
      const p = e.position.getValue(now); if (!p) continue;
      let h = HL.heights.get(e.id);
      const k = Cesium.Cartographic.fromCartesian(p);
      if (h == null) { const g = v.scene.globe.getHeight(k); if (g != null && isFinite(g)) { h = g; HL.heights.set(e.id, g); } }
      const world = h == null ? p : Cesium.Cartesian3.fromRadians(k.longitude, k.latitude, Math.max(h, k.height));
      const sp = v.scene.cartesianToCanvasCoordinates(world);
      live.add(e.id);
      let d = HL.divs.get(e.id);
      if (!sp || sp.x < -60 || sp.y < -60 || sp.x > window.innerWidth + 60 || sp.y > window.innerHeight + 60 ||
          Cesium.Cartesian3.distance(v.camera.positionWC, world) > 8000) { if (d) d.style.display = 'none'; continue; }
      if (!d) {
        d = document.createElement('div'); d.className = 'html-label pjf-html';
        d.textContent = (e.label.text && e.label.text.getValue ? e.label.text.getValue(now) : e.name) || e.name || '';
        HL.box.appendChild(d); HL.divs.set(e.id, d);
      }
      d.style.display = 'block'; d.style.left = Math.round(sp.x) + 'px'; d.style.top = Math.round(sp.y) + 'px';
    }
    for (const [id, d] of HL.divs) if (!live.has(id)) { d.remove(); HL.divs.delete(id); }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  let t = null;
  function changed(e) {
    if (e && !/^(feature\.|group\.|cave|accept|reject)/.test(e.op)) return;
    clearTimeout(t);
    t = setTimeout(() => { draw(); render(); }, 120);
  }
  window._onVectorSourcesChanged = () => { applyOverlayHidden(); clearTimeout(t); t = setTimeout(() => render(), 150); };
  // A click on a project feature opens it.
  const hook = setInterval(() => {
    const v = V();
    if (!v || !v.selectedEntityChanged) return;
    clearInterval(hook);
    v.scene.postRender.addEventListener(updateHtml);
    v.selectedEntityChanged.addEventListener(ent => {
      const p = ent && ent.properties;
      if (p && p.isProjectFeature && !F.draw) { const id = p.featureId.getValue(); setTimeout(() => editFeature(id), 0); }
    });
    changed(null);
  }, 300);
  document.querySelector('[data-target="#featuresCollapsible"]')?.addEventListener('click', () => setTimeout(render, 0));

  const st = document.createElement('style');
  st.textContent = `
  .pjf-banner { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 99999; background: rgba(20,20,30,.92); color: #fff; font: 13px system-ui, sans-serif;
    padding: 8px 14px; border-radius: 6px; border: 1px solid #ffb020; }
  .pjf-folder, .pjf-item { display: flex; align-items: center; gap: 4px; font-size: 12px; padding: 2px 4px; border-radius: 4px; }
  .pjf-item { cursor: pointer; } .pjf-item:hover, .pjf-folder:hover { background: rgba(255,255,255,.07); }
  .pjf-name { flex: 1; cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pjf-arrow { cursor: pointer; width: 12px; display: inline-block; }
  .pjf-tools { display: flex; gap: 2px; } .pjf-tools .pj-btn { margin: 0; padding: 0 5px; }
  .pjf-row { margin: 2px 0 4px; }
  .pjf-item .pjf-edit { margin: 0 0 0 auto; padding: 0 5px; opacity: .6; } .pjf-item:hover .pjf-edit { opacity: 1; }
  .pjf-item { user-select: none; }`;
  document.head.appendChild(st);

  window._pjf = { hidden, setHidden, highlight, clearHighlight, updateHtml, changed, render, draw, startDraw, stopDraw, editFeature, editGroup, importFile, download, scanTags, placeAtTag, copyTag, applyOverlayHidden, walk };
})();
