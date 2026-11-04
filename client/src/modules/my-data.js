// my-data.js — the page side of My data (mine.js on the server): points of
// interest and data files you add outside a project are kept there, so they
// come back after a reload. (Caves go through the Recent list, which the
// server now keeps in My data.)
//
// Points made in one sitting go into one group, "Points <date time>", so a
// day's points stay together until you move them into a project.
(function () {
  'use strict';
  const API = '/api/mine/';
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const who = () => { try { return localStorage.getItem('flex.author') || ''; } catch (_) { return ''; } };
  async function rec(op, data) {
    const r = await fetch(API + 'append', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ t: new Date().toISOString(), who: who() || 'me', op }, data)) });
    if (!r.ok) throw new Error('My data: ' + r.status);
    return r.json();
  }
  let _state = null;
  async function state(force) {
    if (_state && !force) return _state;
    const txt = await (await fetch(API + 'read')).text();
    const es = txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const FL = window.FlexLib;
    _state = FL ? FL.replayProject(es, 'mine') : { features: {}, groups: {}, layers: {} };
    return _state;
  }

  // ── Points of interest ────────────────────────────────────────────────────
  let session = null;                                   // this sitting's group
  function stamp(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  async function sessionGroup() {
    if (session) return session;
    session = { id: 'pts-' + uid(), name: 'Points ' + stamp(new Date()) };
    await rec('group.set', { group: session.id, name: session.name, kind: 'points' });
    return session;
  }
  const SIZE = { S: 0.75, M: 1, L: 1.5 };
  function lonlat(entity) {
    const c = Cesium.Cartographic.fromCartesian(entity.position.getValue(Cesium.JulianDate.now()));
    return [+Cesium.Math.toDegrees(c.longitude).toFixed(7), +Cesium.Math.toDegrees(c.latitude).toFixed(7), +c.height.toFixed(2)];
  }
  const labelOf = e => { const t = e.label && e.label.text; return String((t && t.getValue ? t.getValue(Cesium.JulianDate.now()) : t) || e.name || 'Point'); };
  /** A point just made on the map: keep it. */
  async function keepPoint(entity, size) {
    try {
      const g = await sessionGroup();
      const id = uid();
      entity.properties.addProperty('myFeature', id);
      // Its own height: the ground under it, measured now from the finest terrain (it was made where the camera is) and kept
      // with where it came from (height-model.js); the point moves down onto it.
      let at = lonlat(entity), hsrc = null;
      if (window._heightModel) {
        const m = await window._heightModel.stamp(at[0], at[1]);
        at = m.coords[0]; hsrc = m.hsrc;
        entity.position = Cesium.Cartesian3.fromDegrees(at[0], at[1], at[2]);
        const V = window.cesiumViewer; if (V && V.scene.requestRender) V.scene.requestRender();
      }
      await rec('feature.set', Object.assign({ feature: id, kind: 'point', coords: [at], name: labelOf(entity).slice(0, 120), group: g.id, style: { size: size || 'M' } }, hsrc ? { hsrc } : {}));
    } catch (e) { console.warn('[my data] point not kept:', e); }
  }
  /** Deleted from the list, or moved into a project. */
  async function forgetPoint(entity, why) {
    const id = entity && entity.properties && entity.properties.myFeature && entity.properties.myFeature.getValue();
    if (!id) return;
    try { await rec('feature.set', why === 'moved' ? { feature: id, removed: true, moved: true } : { feature: id, removed: true }); } catch (e) { console.warn('[my data]', e); }
  }
  /** The kept points, to draw at start. */
  async function points() {
    const S = await state(true);
    return Object.values(S.features || {}).filter(f => !f.removed && f.kind === 'point' && f.coords && f.coords[0])
      .map(f => ({ id: f.id, name: f.name || 'Point', lon: f.coords[0][0], lat: f.coords[0][1], h: f.coords[0][2] || 0, hsrc: f.hsrc || null,
                   scale: SIZE[(f.style && f.style.size) || 'M'] || 1, group: (S.groups[f.group] || {}).name || '',
                   color: (f.style && f.style.color) || null, label: !(f.style && f.style.label === false) }));
  }
  /** The map entity of a kept point. */
  function pointEntity(id) {
    const V = window.cesiumViewer;
    return V ? V.entities.values.find(e => e.properties && e.properties.myFeature && e.properties.myFeature.getValue() === id) || null : null;
  }
  function setPointAt(entity, c) {
    if (window._groundH) window._groundH.untrack(entity);
    entity.position = Cesium.Cartesian3.fromDegrees(c[0], c[1], c[2] || 0);
    const V = window.cesiumViewer; if (V && V.scene.requestRender) V.scene.requestRender();
  }
  /**
   * Put a kept point on the map at its own height. One with a height source (hsrc) is drawn at its stored height; an older
   * one without is drawn on the ground at once, then measured once and stored (height-model.js).
   */
  function placePoint(entity, p) {
    if (p.hsrc) { entity.position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h || 0); return; }
    if (window._groundH) window._groundH.track(entity, p.lon, p.lat);
    const HM = window._heightModel;
    if (!HM) return;
    HM.stamp(p.lon, p.lat).then(async m => {
      if (!m.exact) return;
      const r = await update(p.id, { coords: m.coords, hsrc: m.hsrc });
      if (r.ok) setPointAt(entity, m.coords[0]);
    }).catch(e => console.warn('[my data] height:', e));
  }
  /**
   * Change a kept point (feature-editor.js): patch { name, desc, coords, group,
   * color, label }; its style (size) is kept. → { ok } | { ok: false, error }.
   */
  async function update(id, patch) {
    try {
      const S = await state(true), f = S.features && S.features[id];
      if (!f || f.removed) return { ok: false, error: 'it isn’t in My data any more' };
      const e = { feature: id };
      ['name', 'desc', 'group'].forEach(k => { if (patch[k] != null) e[k] = String(patch[k]); });
      if (Array.isArray(patch.coords)) e.coords = patch.coords;
      if (patch.hsrc) e.hsrc = patch.hsrc;
      if (patch.color !== undefined || patch.label !== undefined) {
        const st = Object.assign({}, f.style || {});
        if (patch.color) st.color = patch.color;
        if (patch.label !== undefined) { if (patch.label === false) st.label = false; else delete st.label; }
        e.style = st;
      }
      await rec('feature.set', e);
      const S2 = await state(true), g = S2.features[id];
      if (g && g.kind !== 'point') drawShape(g, S2);               // a line or area: drawn again as it is now
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message || String(err) }; }
  }

  // ── Data files ────────────────────────────────────────────────────────────
  async function keepFile(fileOrUrl, label) {
    try {
      if (typeof fileOrUrl === 'string') {
        if (/^\/api\/(lib|mine)\//.test(fileOrUrl)) return null;          // already kept (being restored)
        const id = 'file-' + uid();
        await rec('layer.set', { layer: id, kind: 'file', url: fileOrUrl, name: label || fileOrUrl, removed: false });
        return id;
      }
      let ext = (fileOrUrl.name.split('.').pop() || '').toLowerCase();
      if (ext === 'geojson') ext = 'json';
      if (!['kml', 'kmz', 'json'].includes(ext)) return null;
      const r = await fetch(API + 'blob?ext=' + ext, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await fileOrUrl.arrayBuffer() });
      if (!r.ok) throw new Error('could not store the file');
      const b = await r.json();
      const id = 'file-' + b.h.slice(0, 12);
      await rec('layer.set', { layer: id, kind: 'file', blob: b.h + '.' + ext, name: label || fileOrUrl.name, removed: false });
      return id;
    } catch (e) { console.warn('[my data] file not kept:', e); return null; }
  }
  async function forgetFile(id) { if (id) try { await rec('layer.set', { layer: id, removed: true }); } catch (e) { console.warn('[my data]', e); } }
  /**
   * The data files to load at start: My data's, after taking in any the old
   * saved view still lists (URL files from before My data).
   */
  async function filesToRestore(sessionList) {
    let S = await state(true);
    const have = new Set(Object.values(S.layers || {}).filter(l => l.kind === 'file' && l.url).map(l => l.url));
    let added = 0;
    for (const f of sessionList || []) if (f && f.url && !have.has(f.url)) { await keepFile(f.url, f.label); added++; }
    if (added) S = await state(true);
    return Object.values(S.layers || {}).filter(l => l.kind === 'file' && !l.removed && (l.url || l.blob))
      .map(l => ({ id: l.id, url: l.blob ? '/api/lib/blob/' + l.blob : l.url, label: l.name || '' }));
  }


  // ── Features that came back from a project ─────────────────────────────────
  // Points, lines and areas moved out of a project (project-workspace.js, "back to My data"). Ids come from the
  // project feature's, so moving the same one again finds it already here. Points are listed in 📍 Surface like any
  // other; lines and areas are drawn here (own layer) and kept; folders become My data groups named by their path.
  const hash = t => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
  let shapeDs = null;
  function shapes() {
    return Object.values((_state && _state.features) || {}).filter(f => !f.removed && (f.kind === 'line' || f.kind === 'area') && f.coords && f.coords.length >= 2);
  }
  function drawShape(f, S) {
    const V = window.cesiumViewer; if (!V || typeof Cesium === 'undefined') return;
    if (!shapeDs) { shapeDs = new Cesium.CustomDataSource('my-shapes'); V.dataSources.add(shapeDs); }
    const old = shapeDs.entities.getById('my-' + f.id); if (old) shapeDs.entities.remove(old);
    if (f.removed || !f.coords || f.coords.length < 2) return;
    const col = Cesium.Color.fromCssColorString((f.style && f.style.color) || (S.groups[f.group] || {}).color || '#ffb020');
    const flat = f.coords.map(c => [c[0], c[1]]).flat();
    const grp = (S.groups[f.group] || {}).name || '';
    shapeDs.entities.add({ id: 'my-' + f.id, name: f.name || (f.kind === 'area' ? 'Area' : 'Line'), description: (f.desc || '') + (grp ? '<p>My data · ' + grp.replace(/[<>&]/g, '') + '</p>' : ''),
      properties: { myShape: f.id },
      polyline: { positions: Cesium.Cartesian3.fromDegreesArray(f.kind === 'area' ? flat.concat(flat.slice(0, 2)) : flat), width: 3, clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN, material: col },
      polygon: f.kind === 'area' && f.coords.length >= 3 ? { hierarchy: Cesium.Cartesian3.fromDegreesArray(flat), material: col.withAlpha(0.2), classificationType: Cesium.ClassificationType.TERRAIN } : undefined });
    V.scene.requestRender && V.scene.requestRender();
  }
  /** A kept line or area's entity on the map (null when not drawn). */
  const shapeEntity = id => (shapeDs && shapeDs.entities.getById('my-' + id)) || null;
  /** Delete a kept line or area (or why 'moved'): the record and the drawing. */
  async function forgetShape(id, why) {
    if (!id) return;
    try { await rec('feature.set', why === 'moved' ? { feature: id, removed: true, moved: true } : { feature: id, removed: true }); } catch (e) { console.warn('[my data]', e); }
    const e = shapeEntity(id); if (e) shapeDs.entities.remove(e);
    const V = window.cesiumViewer; if (V && V.scene.requestRender) V.scene.requestRender();
  }
  function drawPoint(f) {
    const V = window.cesiumViewer; if (!V) return;
    if (V.entities.values.some(e => e.properties && e.properties.myFeature && e.properties.myFeature.getValue() === f.id)) return;
    const ent = V.entities.add({ name: f.name || 'Point', label: { scale: SIZE[(f.style && f.style.size) || 'M'] || 1, text: f.name || 'Point', show: !(f.style && f.style.label === false) },
      position: Cesium.Cartesian3.fromDegrees(f.coords[0][0], f.coords[0][1], f.coords[0][2] || 0), properties: { isUserLabel: true, myFeature: f.id },
      point: f.style && f.style.color ? { color: Cesium.Color.fromCssColorString(f.style.color) } : {} });
    placePoint(ent, { id: f.id, lon: f.coords[0][0], lat: f.coords[0][1], h: f.coords[0][2] || 0, hsrc: f.hsrc || null });
  }
  /**
   * Take features in. items: [{ id (the project's), kind, coords, name, desc, group (a name), color }].
   * → the My data ids ('pf-<id>'). Ones already here are left as they are.
   */
  async function adopt(items) {
    let S = await state(true);
    const out = [], gid = {};
    for (const it of items) {
      const g = it.group || 'Points';
      if (!gid[g]) {
        gid[g] = 'pg-' + hash(g);
        const cur = S.groups[gid[g]];
        if (!cur || cur.removed) await rec('group.set', Object.assign({ group: gid[g], name: g, kind: 'points', removed: false }, it.color ? { color: it.color } : {}));
      }
      const id = 'pf-' + it.id, cur = S.features[id];
      out.push(id);
      if (cur && !cur.removed) continue;
      const style = Object.assign({}, it.style || {}, it.color ? { color: it.color } : {});
      await rec('feature.set', { hsrc: it.hsrc || undefined, feature: id, kind: it.kind, coords: it.coords, name: String(it.name || '').slice(0, 120) || (it.kind === 'point' ? 'Point' : it.kind === 'area' ? 'Area' : 'Line'), desc: String(it.desc || '').slice(0, 4000), group: gid[g], style, removed: false });
    }
    S = await state(true);
    out.forEach(id => { const f = S.features[id]; if (!f || f.removed) return; if (f.kind === 'point') drawPoint(f); else drawShape(f, S); });
    return out;
  }
  // At start: the lines and areas kept here are drawn once the map is up (points are drawn by flex.js).
  const upTimer = setInterval(() => {
    if (!window.cesiumViewer || typeof Cesium === 'undefined') return;
    clearInterval(upTimer);
    state(true).then(S => shapes().forEach(f => drawShape(f, S))).catch(e => console.warn('[my data] shapes:', e));
  }, 500);

  // The offer for finer terrain (height-model.js): kept points whose height was measured from coarser terrain.
  const regTimer = setInterval(() => {
    if (!window._heightModel) return;
    clearInterval(regTimer);
    window._heightModel.register('mydata', {
      list: () => Object.values((_state && _state.features) || {}).filter(f => !f.removed && f.kind === 'point' && f.hsrc && f.coords && f.coords[0])
        .map(f => ({ id: f.id, lon: f.coords[0][0], lat: f.coords[0][1], hsrc: f.hsrc })),
      store: async ups => { for (const u of ups) { const r = await update(u.id, { coords: u.coords, hsrc: u.hsrc }); const e = pointEntity(u.id); if (r.ok && e) setPointAt(e, u.coords[0]); } },
    });
  }, 400);

  window._myData = { placePoint, pointEntity, adopt, shapes, shapeEntity, forgetShape, shapeDs: () => shapeDs, keepPoint, forgetPoint, update, cached: () => _state, points, keepFile, forgetFile, filesToRestore, state, record: rec };
})();
