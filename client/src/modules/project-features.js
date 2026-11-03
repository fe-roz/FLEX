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
//                        flex: cave=<cave name>; station=<entrance station>; z=<metres>; id=<cave id>
//                      (z and id are optional; caltopo-send.js reads and writes the line)
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
  // Lines and areas are drawn simplified: a GPS track of 10 000 points draped
  // on the terrain slows everything down, and points closer than SIMPLIFY_M to
  // the drawn line change nothing you can see. The project keeps every point.
  const SIMPLIFY_M = 2, MAX_DRAWN = 2000;
  function simplify(coords) {
    if (coords.length <= 3) return coords;
    const lat0 = coords[0][1] * Math.PI / 180, mx = 111320 * Math.cos(lat0), my = 110540;
    const xy = coords.map(c => [c[0] * mx, c[1] * my]);
    const run = tol => {
      const keep = new Uint8Array(xy.length); keep[0] = keep[xy.length - 1] = 1;
      const stack = [[0, xy.length - 1]], t2 = tol * tol;
      while (stack.length) {
        const [a, b] = stack.pop();
        const [ax, ay] = xy[a], dx = xy[b][0] - ax, dy = xy[b][1] - ay, L2 = dx * dx + dy * dy;
        let best = -1, bd = t2;
        for (let i = a + 1; i < b; i++) {
          const px = xy[i][0] - ax, py = xy[i][1] - ay;
          let d2;
          if (!L2) d2 = px * px + py * py;
          else { const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2)); const qx = px - t * dx, qy = py - t * dy; d2 = qx * qx + qy * qy; }
          if (d2 > bd) { bd = d2; best = i; }
        }
        if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
      }
      return coords.filter((_, i) => keep[i]);
    };
    let tol = SIMPLIFY_M, out = run(tol);
    while (out.length > MAX_DRAWN && tol < 200) { tol *= 2; out = run(tol); }
    return out;
  }
  F.simplify = simplify;                               // tests
  // Drawn entities per feature, rebuilt only when the feature (or its colour) changed.
  const drawn = new Map();                             // feature id → { sig, ents }
  const sigOf = (f, color) => { const c = f.coords || [], m = c[c.length >> 1]; return [f.kind, f.name, f.desc, color, c.length, c[0], m, c[c.length - 1], window._pjfLabelSig || '', !!(f.style && f.style.label === false)].map(x => JSON.stringify(x)).join('|'); };
  function draw() {
    const v = V();
    if (!v || !window.Cesium) return;
    if (!F.src) { F.src = new Cesium.CustomDataSource('pj-features'); v.dataSources.add(F.src); }
    HL.divs.forEach(d => d.remove()); HL.divs.clear(); HL.mode = null;
    const want = new Set();
    if (pj.pid) FL.liveFeatures(pj.P).forEach(f => {
      if (groupHidden(f.group) || !f.coords || !f.coords.length) return;
      want.add(f.id);
      const col = colorOf(f), sig = sigOf(f, col), had = drawn.get(f.id);
      if (had && had.sig === sig) return;
      if (had) had.ents.forEach(e => F.src.entities.remove(e));
      const c = Cesium.Color.fromCssColorString(col);
      const props = { isProjectFeature: true, featureId: f.id };
      const pts = f.kind === 'point' ? f.coords : simplify(f.coords);
      const pos = pts.map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2] || 0));
      const base = { name: f.name || ({ point: 'Point', line: 'Line', area: 'Area' }[f.kind]), description: esc(f.desc || '').replace(/\n/g, '<br>'), properties: props };
      const ents = [];
      if (f.kind === 'point') {
        ents.push(F.src.entities.add(Object.assign(base, { position: pos[0],
          point: { pixelSize: 9, color: c, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN, disableDepthTestDistance: 5000 },
          label: f.style && f.style.label === false ? undefined : window._pjfLabel(f.name || '') })));          // name off: feature-editor.js
      } else if (f.kind === 'line') {
        ents.push(F.src.entities.add(Object.assign(base, { polyline: { positions: pos, width: 3, material: c, clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN } })));
      } else {
        ents.push(F.src.entities.add(Object.assign(base, { polygon: { classificationType: Cesium.ClassificationType.TERRAIN, hierarchy: pos, material: c.withAlpha(0.25), heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN } })));
        ents.push(F.src.entities.add({ polyline: { positions: pos.concat([pos[0]]), width: 2, material: c, clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN }, properties: props }));
      }
      drawn.set(f.id, { sig, ents });
    });
    for (const [id, d] of drawn) if (!want.has(id)) { d.ents.forEach(e => F.src.entities.remove(e)); drawn.delete(id); }
    if (window._folderStyle) window._folderStyle.apply();           // folders' display settings (folder-style.js)
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
      width: 3, material: Cesium.Color.fromCssColorString(ROOT_COLOR), clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN } });
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
    // Lines, points or subfolders inside with a colour of their own keep it
    // over the folder's; changing the colour offers to give them this one.
    const inside = id ? FL.liveFeatures(pj.P).filter(f => f.style && f.style.color && FL.groupPath(pj.P, f.group).some(x => x.id === id)) : [];
    const subs = id ? FL.liveGroups(pj.P).filter(x => x.id !== id && x.color && FL.groupPath(pj.P, x.id).some(y => y.id === id)) : [];
    let all = null;
    if (inside.length || subs.length) {
      const row = el('label', 'pj-row pj-sub'); row.style.display = 'none';
      all = el('input'); all.type = 'checkbox'; all.checked = true;
      const what = [inside.length ? `${inside.length} ${inside.length === 1 ? 'item' : 'items'} with a colour of their own` : '', subs.length ? `${subs.length} subfolder${subs.length === 1 ? '' : 's'} with its own colour` : ''].filter(Boolean).join(' and ');
      row.append(all, ' Also recolour the ' + what);
      body.appendChild(row);
      const was = col.value;
      col.addEventListener('input', () => { row.style.display = col.value !== was ? '' : 'none'; });
    }
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
    const recolour = id && all && all.checked && col.value.toLowerCase() !== String(g.color || (g.parent ? groupColor(g.parent) : ROOT_COLOR)).toLowerCase();
    await record('group.set', { group: id || FL.uid(10), name: name.value.trim().slice(0, 80), parent: par.value, color: col.value }, null, recolour ? { quiet: true } : undefined);
    if (recolour) {
      // All at once: one by one, a folder of many tracks took seconds to answer Save.
      await Promise.all(inside.map(f => record('feature.set', { feature: f.id, style: {} }, null, { quiet: true }))
        .concat(subs.map(x => record('group.set', { group: x.id, color: '' }, null, { quiet: true }))));
      A.refresh('feature.set');
      toast(`“${name.value.trim()}” and everything in it now ${col.value}`);
    }
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
    if (/\.gpx$/.test(n)) return Cesium.GpxDataSource.load(file, { clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN });
    if (/\.(geo)?json$/.test(n)) return Cesium.GeoJsonDataSource.load(JSON.parse(await file.text()));
    return Cesium.KmlDataSource.load(file, { camera: V().scene.camera, canvas: V().scene.canvas, clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN });
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
  // The tag with its optional z and id (caltopo-send.js); the plain reader when that module is missing.
  const tagOf = d => (window._ctSend ? window._ctSend.parseTag(d) : FL.flexTag(d));
  function scanTags() {
    const out = [], w = ws(), now = window.Cesium ? Cesium.JulianDate.now() : null;
    if (!pj.pid || !w) return out;
    w.vectorSources().forEach(src => src.ds.entities.values.forEach(e => {
      if (!e.position) return;
      const d = e.description && (e.description.getValue ? e.description.getValue(now) : e.description);
      const t = tagOf(d);
      if (!t) return;
      const p = e.position.getValue(now); if (!p) return;
      out.push(Object.assign({ from: src.kind === 'caltopo' ? 'CalTopo' : src.name, point: e.name || '', at: lonlat(p) }, t));
    }));
    FL.liveFeatures(pj.P).forEach(f => { const t = tagOf(f.desc); if (t && f.kind === 'point') out.push(Object.assign({ from: 'this project', point: f.name, at: f.coords[0] }, t)); });
    out.forEach(t => {
      const byId = t.id && pj.P.caves[t.id] && !pj.P.caves[t.id].removed ? t.id : null;      // the id wins: the cave may have been renamed
      const cid = byId || FL.caveForName(pj.P, t.cave);
      const cv = cid && pj.P.caves[cid];
      t.cid = cid || null;
      t.file = cv ? ((cv.sources || []).map(s => s.file).find(fl => pj.P.cavefiles[fl] && !pj.P.cavefiles[fl].removed) || null) : (pj.P.cavefiles[t.cave] ? t.cave : null);
      const place = t.file && pj.P.cavefiles[t.file].place;
      t.placedHere = !!(place && place.mode === 'anchor' && place.station === t.station &&
        Math.abs(place.lat - t.at[1]) < 1e-5 && Math.abs(place.lon - t.at[0]) < 1e-5);
    });
    // Several entrances per cave (doc 14, rule 3): markers with the same cave id; the first is the main entrance.
    const byCave = {};
    out.forEach(t => { if (t.cid) (byCave[t.cid] || (byCave[t.cid] = [])).push(t); });
    Object.keys(byCave).forEach(cid => {
      const e = FL.entrancesOf(byCave[cid], cid), same = (t, x) => x.at === t.at && x.station === t.station;
      byCave[cid].forEach(t => { const k = e.findIndex(x => same(t, x)); t.main = k === 0; t.entrance = k + 1; t.entrances = e.length; });
    });
    // One marker places a file; the others (extra entrances, other caves of a multi-cave file) pin it.
    const byFile = {};
    out.forEach(t => { if (t.cid && t.file) (byFile[t.file] || (byFile[t.file] = [])).push(t); });
    Object.values(byFile).forEach(l => { const m = l.find(t => t.placedHere) || l.find(t => t.main) || l[0]; l.forEach(t => { t.fileMain = t === m; }); });
    out.forEach(t => {
      const pl = t.file && pj.P.cavefiles[t.file].place;
      t.pinned = !!(pl && (pl.controlPoints || []).some(cp => cp.station === t.station && Math.abs(cp.lat - t.at[1]) < 1e-5 && Math.abs(cp.lon - t.at[0]) < 1e-5));
    });
    F.tags = out;
    return out;
  }
  // The height of an entrance: the tag's z when it has one (else the marker's own); the terrain's reading wins only when it has one
  // worth using (no terrain loaded reads 0, which must not override a z).
  async function entranceElev(t) {
    const zTag = isFinite(t.z) ? t.z : (t.at[2] || 0);
    let elev = zTag;
    try {
      const k = [Cesium.Cartographic.fromDegrees(t.at[0], t.at[1])];
      const s = await Cesium.sampleTerrainMostDetailed(V().terrainProvider, k);
      if (s && s[0] && isFinite(s[0].height) && !(Math.abs(s[0].height) < 0.01 && zTag)) elev = s[0].height;
    } catch (_) {}
    return +elev.toFixed(1);
  }
  // Save a file's placement and redraw it there.
  async function placeFile(file, place) {
    const w = ws(), cf = pj.P.cavefiles[file];
    await record('cavefile.set', { file, place });
    const r = await fetch('/api/lib/blob/' + cf.h + '.' + (cf.ext || 'plt'));
    if (!r.ok) { toast('The survey file isn’t on this computer'); return false; }
    const style = (w.caveState().find(c => c.name === file) || {}).displayOptions || null;
    w.switching = true;
    try { w.removeCave(file); w.loadCave(file, await r.text(), place, style); } finally { w.switching = false; }
    return true;
  }
  async function placeAtTag(t) {
    const cf = pj.P.cavefiles[t.file];
    if (!cf) return;
    const elev = await entranceElev(t);
    const old = cf.place || {};
    const place = { mode: 'anchor', station: t.station, lat: t.at[1], lon: t.at[0], elev, survey: '', declination: old.declination ?? null };
    if (old.heights) place.heights = old.heights;
    if (old.mode === 'anchor' && old.station === t.station && old.controlPoints) place.controlPoints = old.controlPoints;
    if (await placeFile(t.file, place)) toast(`${t.cave} placed at ${t.point || 'the marker'} (station ${t.station})`);
  }
  // Another entrance (of this cave, or of another cave in the same file) held where its marker is: a 🎯 pin, so the file follows.
  async function pinAtTag(t) {
    const cf = pj.P.cavefiles[t.file];
    if (!cf) return;
    if (!cf.place || cf.place.mode !== 'anchor') { toast('Place the cave at its main entrance first'); return; }
    const cp = { station: t.station, lat: t.at[1], lon: t.at[0], elev: await entranceElev(t) };
    const place = Object.assign({}, cf.place, { controlPoints: (cf.place.controlPoints || []).filter(x => x.station !== t.station).concat([cp]) });
    if (await placeFile(t.file, place)) toast(`Pinned station ${t.station} at ${t.point || 'the marker'}`);
  }
  // Place a file at its first entrance and pin every other entrance of its caves, so the whole file fits the markers.
  async function fitFileToEntrances(file) {
    const cf = pj.P.cavefiles[file];
    const tags = F.tags.filter(t => t.file === file && t.cid && t.station);
    const order = tags.filter(t => t.placedHere).concat(tags.filter(t => t.main && !t.placedHere), tags.filter(t => !t.main && !t.placedHere));
    const imp = (window._caveImports || []).find(i => i && i.parsed && i.name === file);
    const fit = FL.entranceFit(order, imp ? new Set(imp.parsed.stations.map(s => s.name)) : null);
    if (!cf || !fit) { toast('None of the entrance markers is on a station of this file'); return; }
    const old = cf.place || {};
    const place = { mode: 'anchor', station: fit.main.station, lat: fit.main.at[1], lon: fit.main.at[0], elev: await entranceElev(fit.main), survey: '', declination: old.declination ?? null };
    if (old.heights) place.heights = old.heights;
    if (fit.pins.length) place.controlPoints = fit.pins;
    if (await placeFile(file, place)) toast(`${file} fitted to ${fit.pins.length + 1} entrance${fit.pins.length ? 's' : ''}`);
  }
  // For the workspace list: the tag to paste into a CalTopo marker.
  function copyTag(file) {
    const cv = FL.liveCaves(pj.P).find(c => (c.sources || []).some(s => s.file === file));
    const place = (pj.P.cavefiles[file] || {}).place;
    const imp = (window._caveImports || []).find(i => i.name === file);
    const st = (place && place.station && place.station !== '__first__' && place.station) || (imp && imp.parsed.stations[0] && imp.parsed.stations[0].name) || '?';
    const z = place && isFinite(place.elev) && place.mode === 'anchor' ? place.elev : undefined;
    const mk = window._ctSend ? window._ctSend.makeTag : (c, s) => FL.makeFlexTag(c, s);
    const tag = mk(cv ? cv.name : file.replace(/\.plt$/i, ''), st, { z, id: cv ? cv.id : undefined });
    (navigator.clipboard ? navigator.clipboard.writeText(tag) : Promise.reject()).then(() => toast('Copied: ' + tag), () => dialog({ title: 'CalTopo tag', text: 'Put this line in the description of the entrance marker in CalTopo (z is the entrance height, id the cave’s id in the project; the marker still works with only cave and station):', input: { value: tag } }));
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
  // The project's features, CalTopo and data-file folders are listed in
  // 📍 Surface's columns (surface-columns.js). Here: cave entrances marked on
  // points, in 🕳 Caves.
  function render() {
    const root = document.getElementById('pjf-tags');
    if (window._surfCols) window._surfCols.render();
    if (!root) return;
    root.textContent = '';
    if (!pj.pid) return;
    const tags = scanTags();
    sec(root, `Cave entrances on the map (${tags.length})`, tags.some(t => !t.placedHere), b => {
      b.appendChild(el('div', 'pj-note', 'A point whose description has a line “flex: cave=<cave name>; station=<entrance station>; z=<metres>; id=<cave id>” (z and id are optional) — in CalTopo or in this project — marks where a cave’s entrance is. FLEX places the cave there when you say so. 🕳 Caves → ⋯ on the cave → “Copy CalTopo tag” gives you the line.'));
      if (!tags.length) b.appendChild(el('div', 'pj-sub', 'None found.'));
      const fitted = new Set();
      tags.forEach(t => {
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', `🕳 ${t.cave} · station ${t.station || '?'}${t.entrances > 1 ? ` · entrance ${t.entrance} of ${t.entrances}${t.main ? ' (main)' : ''}` : ''}`));
        r.appendChild(el('div', 'pj-sub', `${t.point || 'point'} (${t.from}) · ${t.at[1].toFixed(5)}, ${t.at[0].toFixed(5)}`));
        const row = el('div', 'pj-row');
        const multi = t.file && (pj.P.cavefiles[t.file] || {}).multi;
        if (!t.cid && !t.file) row.appendChild(el('span', 'pj-sub', 'No cave of that name in this project: until it is surveyed this is a surface point (check the name, or add the cave).'));
        else if (!t.file) row.appendChild(el('span', 'pj-sub', 'The cave’s survey file isn’t stored in the project yet: load it and save.'));
        else if (!t.fileMain && t.cid) {
          if (t.pinned) row.appendChild(el('span', 'pj-sub', '🎯 pinned here'));
          else row.appendChild(btn('Pin the cave here', () => pinAtTag(t), 'small'));
        } else if (t.placedHere) row.appendChild(el('span', 'pj-sub', '✓ placed here'));
        else row.appendChild(btn('Place the cave here', () => placeAtTag(t), 'small primary'));
        const same = tags.filter(x => x.file === t.file && x.cid && x.station);
        if (t.file && !fitted.has(t.file) && new Set(same.map(x => x.station)).size > 1) {
          fitted.add(t.file);
          row.appendChild(btn(multi ? 'Fit the whole file to its entrances' : 'Fit the cave to its entrances', () => fitFileToEntrances(t.file), 'small'));
        }
        r.appendChild(row);
        b.appendChild(r);
      });
    }, 'tags');
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
      F.hl.entities.add({ polyline: { positions: g.kind === 'area' ? pos.concat([pos[0]]) : pos, width: 7, material: new Cesium.PolylineGlowMaterialProperty({ color: Y, glowPower: 0.25 }), clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN } });
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
    heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000),
    disableDepthTestDistance: 5000,
  });
  // Point cloud drawn over the map: a visible cloud with at least one class of
  // points shown ("5" hides every class but leaves the cloud "visible").
  const lidarShown = () => {
    if (HL.force != null) return HL.force;
    const pv = window.potreeViewer, pcs = (pv && pv.scene && pv.scene.pointclouds) || [];
    if (!pcs.some(pc => pc.visible !== false)) return false;
    const cls = pv.classifications || (pv.scene && pv.scene.classifications);
    return !cls || !Object.keys(cls).length || Object.values(cls).some(c => !c || c.visible !== false);
  };
  const HL = { divs: new Map(), heights: new Map(), mode: null, box: null };
  window._pjfHtml = HL; HL.lidarShown = () => lidarShown();   // tests
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
    // 📍 Surface → Labels off: no names at all (surface-columns.js).
    if (window._surfLabelsOff) {
      if (HL.divs.size) { HL.divs.forEach(d => d.remove()); HL.divs.clear(); }
      ents.forEach(e => { if (e.label && !e._pjfLab) { e.label.show = false; e._pjfLab = true; } });
      HL.mode = 'off';
      return;
    }
    if (HL.mode === 'off') { ents.forEach(e => { if (e._pjfLab) { e._pjfLab = false; if (!e._pjfHid) e.label.show = !e._fsNoLabel; } }); HL.mode = null; }
    if (!on) {
      if (HL.mode !== false) {
        HL.divs.forEach(d => d.remove()); HL.divs.clear();
        ents.forEach(e => { if (e._pjfHid) { e.label.show = !e._fsNoLabel; if (e.point) e.point.show = !e._fsNoPoint; if (e.billboard) e.billboard.show = true; e._pjfHid = false; } });
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
        // The name, and the point's own icon in its colour: the cloud covers
        // Cesium's, and a hidden Cesium point can't be clicked, so the icon
        // here takes the click (selects it, as a map click would).
        d = document.createElement('div'); d.className = 'pjf-html-wrap';
        const lab = document.createElement('div'); lab.className = 'html-label pjf-html';
        lab.textContent = (e.label.text && e.label.text.getValue ? e.label.text.getValue(now) : e.name) || e.name || '';
        const dot = document.createElement('div'); dot.className = 'pjf-dot';
        const col = e.point && e.point.color && e.point.color.getValue ? e.point.color.getValue(now) : null;
        if (col) dot.style.background = col.toCssColorString();
        dot.title = e.name || '';
        dot.addEventListener('click', ev => { ev.stopPropagation(); const vv = V(); if (vv) vv.selectedEntity = e; });
        d.append(lab, dot);
        HL.box.appendChild(d); HL.divs.set(e.id, d);
      }
      d.firstChild.style.display = e._fsNoLabel ? 'none' : '';       // names off for its folder (folder-style.js)
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
  let tv = null;                                       // its own timer: sharing t cancelled a pending draw()
  window._onVectorSourcesChanged = () => { applyOverlayHidden(); clearTimeout(tv); tv = setTimeout(() => render(), 150); };
  // A click on a project feature shows it in the details panel (info-panel.js);
  // editing is a second step there (✏️ Edit), not the click itself.
  const hook = setInterval(() => {
    const v = V();
    if (!v || !v.selectedEntityChanged) return;
    clearInterval(hook);
    v.scene.postRender.addEventListener(updateHtml);
    // New terrain under the points: forget the ground heights the labels sat
    // on (again once its tiles have arrived).
    window.addEventListener('flex-terrain-changed', () => {
      HL.heights.clear(); v.scene.requestRender && v.scene.requestRender();
      setTimeout(() => { HL.heights.clear(); v.scene.requestRender && v.scene.requestRender(); }, 3000);
    });
    changed(null);
  }, 300);
  ['#featuresCollapsible', '#caveCollapsible'].forEach(t => document.querySelector(`[data-target="${t}"]`)?.addEventListener('click', () => setTimeout(render, 0)));

  const st = document.createElement('style');
  st.textContent = `
  .pjf-html-wrap { position: absolute; width: 0; height: 0; pointer-events: none; }
  .pjf-html-wrap .pjf-html { left: 0; top: 0; }
  .pjf-html-wrap .pjf-html::after { display: none; }
  .pjf-dot { position: absolute; left: -6px; top: -6px; width: 12px; height: 12px; border-radius: 50%; background: #ffb020; border: 2px solid #000; box-shadow: 0 0 5px rgba(0,0,0,.6);
    pointer-events: auto; cursor: pointer; box-sizing: border-box; }
  .pjf-dot:hover { transform: scale(1.3); }
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

  window._pjf = { hidden, setHidden, groupColor, colorOf, downloadMenu, overlayTree, srcKey, entCoords, adoptPoints, highlight, clearHighlight, updateHtml, changed, render, draw, startDraw, stopDraw, editFeature, editGroup, importFile, download, scanTags, placeAtTag, copyTag, applyOverlayHidden, walk };
})();
