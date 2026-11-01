// my_data.js — the page side of My data (mine.js on the server): points of
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
      await rec('feature.set', { feature: id, kind: 'point', coords: [lonlat(entity)], name: labelOf(entity).slice(0, 120), group: g.id, style: { size: size || 'M' } });
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
      .map(f => ({ id: f.id, name: f.name || 'Point', lon: f.coords[0][0], lat: f.coords[0][1], h: f.coords[0][2] || 0,
                   scale: SIZE[(f.style && f.style.size) || 'M'] || 1, group: (S.groups[f.group] || {}).name || '' }));
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

  window._myData = { keepPoint, forgetPoint, points, keepFile, forgetFile, filesToRestore, state, record: rec };
})();
