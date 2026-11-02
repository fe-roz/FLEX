// feature_editor.js — one editor for a point, line or area on the surface,
// wherever it comes from, so an item edits the same way from the info panel
// (info_panel.js) and from a row's ⋯ menu in 📍 Surface (surface_columns.js).
//
// An item is known by a "ref" (refOf): where it comes from and what it is now.
//   { source: 'project' | 'mydata' | 'caltopo' | 'file' | 'other',
//     id,                 project feature id · My data feature id · CalTopo feature id · entity id
//     kind,               'point' | 'line' | 'area'
//     name, desc, color ('#rrggbb'), symbol (CalTopo marker), label (name shown on the map),
//     folder (id, '' top level), path ([{ id, name }] its folders, outermost first),
//     coords ([[lon, lat, h?]…]), entity (drawn on the map, if any),
//     srcName (CalTopo map / data file name), created / updated ({ t, who }),
//     editable, reason (why not, in plain words) }
// Edits go to the item's own source:
//   project   the project's records (feature.set, as project_features.js does)
//   mydata    My data's records (window._myData.update / forgetPoint)
//   caltopo   window._ctWrite.update / remove (caltopo write), whose answer
//             { ok } | { queued } | { conflict, mine, theirs } | { ok: false, error, readOnly }
//             is shown as it is; on a conflict _ctWrite shows its own side-by-side
//             dialog (without showConflict, this one asks). remove() deletes at once:
//             the confirm step is here
//   file      read-only (data files are shown as they are)
//
// window._featEdit — x is a ref, an info-panel subject (with .ref), a Cesium
// entity, or { source, id }:
//   refOf(x)                    → ref or null
//   canEdit(x)                  → { ok, reason }
//   open(x, { focus })          the editor dialog (name, description, folder, colour,
//                               symbol, label, position as lat/lon or UTM, Move on the
//                               map, Delete); resolves with the result, or null (Cancel)
//   apply(x, patch, what)       patch: { name, desc, color, symbol, label, folder, coords }
//   rename(x, name)  describe(x, desc)  colour(x, '#rrggbb')  symbol(x, s)  label(x, on)
//   moveTo(x, folderId)         into a folder of its own source ('' = top level)
//   move(x, [lon, lat, h?])     a point to a new place
//   drag(x)                     move a point on the map: drag it (or click where it goes); Esc cancels
//   del(x, { confirm })         delete, after a confirm step unless confirm: false
//   resolve(x)                  a CalTopo conflict: _ctWrite.showConflict, or both versions here and _ctWrite.resolve
//   folders(x)                  → [{ id, name, depth, path }] the folders it can move to
//   utm(lon, lat) → { zone, band, south, e, n }    fromUtm(zone, south, e, n) → [lon, lat]
//   last                        { what, ref, result, message } of the last edit (tests)
// Every action resolves with a result ({ ok: true } | { queued } | { conflict } |
// { ok: false, error }), says it in a toast (or a dialog when it failed) and fires
// a window event 'flex-feature-edited' { detail: { what, ref, result, message } }.
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) { console.warn('[edit] project.js missing'); return; }
  const { pj, FL, el, btn, toast, dialog, record } = A;
  const V = () => window.cesiumViewer;
  const CT = () => window._ctWrite || null;
  const MD = () => window._myData || null;
  const KIND = { point: 'point', line: 'line', area: 'area' };
  const prop = (e, k) => (e && e.properties && e.properties[k] ? e.properties[k].getValue() : null);
  const now = () => (window.Cesium ? Cesium.JulianDate.now() : null);
  const val = p => (p && p.getValue ? p.getValue(now()) : p);
  const lonlat = c => { const k = Cesium.Cartographic.fromCartesian(c); return [+Cesium.Math.toDegrees(k.longitude).toFixed(7), +Cesium.Math.toDegrees(k.latitude).toFixed(7), +k.height.toFixed(1)]; };
  const hex = c => { if (!c) return null; let s = String(c).trim(); if (/^[0-9a-f]{6}$/i.test(s)) s = '#' + s; return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : null; };
  const textOf = h => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();

  // ── UTM (WGS84, Krüger series; good to well under a millimetre) ──────────
  const UA = 6378137, UF = 1 / 298.257223563, K0 = 0.9996;
  const Un = UF / (2 - UF), UAA = UA / (1 + Un) * (1 + Un * Un / 4 + Un ** 4 / 64);
  const AL = [Un / 2 - 2 * Un ** 2 / 3 + 5 * Un ** 3 / 16, 13 * Un ** 2 / 48 - 3 * Un ** 3 / 5, 61 * Un ** 3 / 240];
  const BE = [Un / 2 - 2 * Un ** 2 / 3 + 37 * Un ** 3 / 96, Un ** 2 / 48 + Un ** 3 / 15, 17 * Un ** 3 / 480];
  const DE = [2 * Un - 2 * Un ** 2 / 3 - 2 * Un ** 3, 7 * Un ** 2 / 3 - 8 * Un ** 3 / 5, 56 * Un ** 3 / 15];
  const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
  function utm(lon, lat, zone) {
    zone = zone || Math.min(60, Math.floor((lon + 180) / 6) + 1);
    const l0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180, ph = lat * Math.PI / 180, dl = lon * Math.PI / 180 - l0;
    const c = 2 * Math.sqrt(Un) / (1 + Un);
    const t = Math.sinh(Math.atanh(Math.sin(ph)) - c * Math.atanh(c * Math.sin(ph)));
    const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    let E = eta, N = xi;
    for (let j = 1; j <= 3; j++) { E += AL[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); N += AL[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); }
    const south = lat < 0;
    return { zone, south, band: BANDS[Math.max(0, Math.min(19, Math.floor((lat + 80) / 8)))], e: 500000 + K0 * UAA * E, n: (south ? 10000000 : 0) + K0 * UAA * N };
  }
  function fromUtm(zone, south, e, n) {
    const xi = (n - (south ? 10000000 : 0)) / (K0 * UAA), eta = (e - 500000) / (K0 * UAA);
    let x = xi, y = eta;
    for (let j = 1; j <= 3; j++) { x -= BE[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); y -= BE[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
    const chi = Math.asin(Math.sin(x) / Math.cosh(y));
    let ph = chi;
    for (let j = 1; j <= 3; j++) ph += DE[j - 1] * Math.sin(2 * j * chi);
    const l0 = (zone - 1) * 6 - 180 + 3;
    return [l0 + Math.atan2(Math.sinh(y), Math.cos(x)) * 180 / Math.PI, ph * 180 / Math.PI];
  }

  // ── Refs ─────────────────────────────────────────────────────────────────
  const sources = () => (window._ws && window._ws.vectorSources ? window._ws.vectorSources() : []);
  const srcOfEntity = e => sources().find(s => s.ds && s.ds.entities && s.ds.entities.contains && s.ds.entities.contains(e)) || null;
  function entShape(e) {
    try {
      if (e.polygon) { const h = val(e.polygon.hierarchy); if (h && h.positions && h.positions.length) return { kind: 'area', coords: h.positions.map(lonlat) }; }
      if (e.polyline) { const ps = val(e.polyline.positions); if (ps && ps.length) return { kind: 'line', coords: ps.map(lonlat) }; }
      if (e.position) { const p = val(e.position); if (p) return { kind: 'point', coords: [lonlat(p)] }; }
    } catch (_) {}
    return null;
  }
  function entColor(e) {
    try {
      const c = e.point ? val(e.point.color) : e.polyline ? val(e.polyline.material && e.polyline.material.color) : e.polygon ? val(e.polygon.material && e.polygon.material.color) : null;
      return c && c.toCssHexString ? c.toCssHexString().slice(0, 7) : null;
    } catch (_) { return null; }
  }
  // Folders an overlay entity hangs under (CalTopo folders are 'ctf-<id>').
  function entPath(e) {
    const out = []; let p = e && e.parent, n = 0;
    while (p && n++ < 50) { out.unshift({ id: /^ctf-/.test(p.id) ? p.id.slice(4) : p.id, name: p.name || '(folder)' }); p = p.parent; }
    return out;
  }
  const myEntity = id => (V() ? V().entities.values.find(e => prop(e, 'myFeature') === id) : null);
  function projectRef(id) {
    const f = pj.P && pj.P.features && pj.P.features[id];
    if (!f || f.removed) return null;
    const st = f.style || {};
    return { source: 'project', id, kind: f.kind, name: f.name || '', desc: f.desc || '', color: hex(window._pjf ? window._pjf.colorOf(f) : st.color) || '#ffb020', ownColor: !!st.color,
      symbol: null, label: f.kind === 'point' ? st.label !== false : null, folder: f.group || '', path: f.group ? FL.groupPath(pj.P, f.group).map(g => ({ id: g.id, name: g.name || 'Folder' })) : [],
      coords: f.coords || [], srcName: pj.P.name || 'this project', created: f.created || null, updated: f.updated || null,
      editable: !!pj.pid, reason: pj.pid ? '' : 'Open the project to edit it.' };
  }
  function myRef(id, ent) {
    const S = MD() && MD().cached ? MD().cached() : null, f = S && S.features && S.features[id];
    if (f && f.removed) return null;
    ent = ent || myEntity(id);
    if (!f && !ent) return null;
    const st = (f && f.style) || {}, shape = ent ? entShape(ent) : null;
    const name = (f && f.name) || (ent && ent.label ? String(val(ent.label.text) || '') : '') || 'Point';
    const g = f && f.group && S.groups[f.group];
    return { source: 'mydata', id, kind: 'point', name, desc: (f && f.desc) || '', color: hex(st.color) || '#ffffff', symbol: null, label: st.label !== false,
      folder: (f && f.group) || '', path: g ? [{ id: g.id, name: g.name || 'Points' }] : [], coords: (f && f.coords) || (shape ? shape.coords : []), entity: ent || null,
      srcName: 'My data', created: (f && f.created) || null, updated: (f && f.updated) || null, editable: true, reason: '' };
  }
  function ctRef(ent, src) {
    const fid = /^ct-/.test(ent.id) ? ent.id.slice(3) : null, W = CT();
    const json = fid && W && W.feature ? W.feature(fid) : null, p = (json && json.properties) || {};
    const shape = entShape(ent) || {}, kind = shape.kind || 'point';
    let coords = shape.coords || [];
    if (json && json.geometry && json.geometry.coordinates) {
      const g = json.geometry;
      coords = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? (g.coordinates[0] || []) : coords;
    }
    let editable = !!(fid && W && (!W.available || W.available())), reason = '';
    if (!fid) reason = 'Read-only: this CalTopo map is read from its public link. To edit it from FLEX, add a CalTopo key on this computer.';
    else if (!W) reason = 'Read-only: this FLEX can’t write to CalTopo yet.';
    else if (!editable) reason = 'Read-only: FLEX can’t write to CalTopo right now (it needs the CalTopo key on this computer, and a key that can write).';
    const ms = t => (t ? { t: new Date(+t || t).toISOString(), who: null } : null);
    const created = ms(p.created), updated = ms(p.updated);
    if (created && (p.creator || p.createdBy)) created.who = String(p.creator || p.createdBy);
    if (updated && (p.updatedBy || p.updater || p.lastEditor)) updated.who = String(p.updatedBy || p.updater || p.lastEditor);
    const mapId = (W && W.mapId && W.mapId()) || ((String(src.url || '').match(/\/m\/([A-Za-z0-9]+)/) || [])[1]) || null;
    return { source: 'caltopo', id: fid || ent.id, fid, kind, name: p.title != null ? String(p.title) : (ent.name || ''), desc: p.description != null ? String(p.description) : textOf(val(ent.description)),
      color: hex(kind === 'point' ? p['marker-color'] : (p.stroke || p.fill)) || entColor(ent), symbol: kind === 'point' ? (p['marker-symbol'] || null) : null, label: null,
      folder: p.folderId != null ? String(p.folderId || '') : (ent.parent && /^ctf-/.test(ent.parent.id) ? ent.parent.id.slice(4) : ''), path: entPath(ent),
      coords, entity: ent, srcName: src.name || 'CalTopo map', mapId, json, created, updated, editable, reason };
  }
  function fileRef(ent, src) {
    const shape = entShape(ent) || {};
    return { source: 'file', id: ent.id, kind: shape.kind || 'point', name: ent.name || '', desc: textOf(val(ent.description)), color: entColor(ent), symbol: null, label: null,
      folder: ent.parent ? ent.parent.id : '', path: entPath(ent), coords: shape.coords || [], entity: ent, srcName: src.name || 'a data file', url: src.url,
      created: null, updated: null, editable: false, reason: `Read-only: it comes from the data file “${src.name || 'file'}”, which FLEX shows as it is. Change the file, or draw it in the project.` };
  }
  function entityRef(ent) {
    if (!ent) return null;
    if (prop(ent, 'isProjectFeature')) return projectRef(prop(ent, 'featureId'));
    if (prop(ent, 'myFeature')) return myRef(prop(ent, 'myFeature'), ent);
    const src = srcOfEntity(ent);
    if (src && src.kind === 'caltopo') return ctRef(ent, src);
    if (src) return fileRef(ent, src);
    const shape = entShape(ent);
    if (!shape) return null;
    return { source: 'other', id: ent.id, kind: shape.kind, name: ent.name || '', desc: textOf(val(ent.description)), color: entColor(ent), symbol: null, label: null, folder: '', path: [],
      coords: shape.coords, entity: ent, srcName: prop(ent, 'isUserLabel') ? 'this sitting (not kept)' : '', editable: false, reason: 'Read-only: FLEX doesn’t keep this one anywhere it can edit.' };
  }
  function resolve(source, id) {
    if (source === 'project') return projectRef(id);
    if (source === 'mydata') return myRef(id);
    if (source === 'caltopo' || source === 'file' || source === 'other') {
      for (const s of sources()) { const e = s.ds.entities.getById(source === 'caltopo' && !/^ct-/.test(id) ? 'ct-' + id : id); if (e) return entityRef(e); }
      const e = V() && V().entities.getById(id); return e ? entityRef(e) : null;
    }
    return null;
  }
  /** The item now: a ref, a subject (.ref), an entity, or { source, id }. */
  function refOf(x) {
    if (!x) return null;
    if (x.ref && x.ref.source) x = x.ref;
    if (window.Cesium && x instanceof Cesium.Entity) return entityRef(x);
    if (x.source && x.id != null) return resolve(x.source, x.id) || (x.kind ? x : null);
    return null;
  }
  function canEdit(x) { const r = refOf(x); return r ? { ok: !!r.editable, reason: r.reason || '' } : { ok: false, reason: 'It isn’t on the map any more.' }; }

  // ── Folders an item can move to ──────────────────────────────────────────
  function folders(x) {
    const r = refOf(x); if (!r) return [];
    const out = [];
    const tree = (list, idOf, parentOf, nameOf) => {
      const walk = (pid, depth, path) => list.filter(g => (parentOf(g) || '') === pid).sort((a, b) => String(nameOf(a)).localeCompare(String(nameOf(b)), undefined, { numeric: true })).forEach(g => {
        const p = path.concat([nameOf(g)]); out.push({ id: idOf(g), name: nameOf(g), depth, path: p.join(' / ') }); walk(idOf(g), depth + 1, p);
      });
      walk('', 0, []);
    };
    if (r.source === 'project' && pj.P) tree(FL.liveGroups(pj.P), g => g.id, g => g.parent, g => g.name || 'Folder');
    else if (r.source === 'mydata') { const S = MD() && MD().cached && MD().cached(); if (S) tree(Object.values(S.groups || {}).filter(g => !g.removed && (!g.kind || g.kind === 'points')), g => g.id, () => '', g => g.name || 'Points'); }
    else if (r.source === 'caltopo') { const W = CT(); const fs = (W && W.folders && W.folders()) || []; tree(fs, g => String(g.id), g => (g.folderId ? String(g.folderId) : ''), g => g.title || 'Folder'); }
    return out;
  }

  // ── Telling what happened ────────────────────────────────────────────────
  const WHERE = { project: 'the project', mydata: 'My data', caltopo: 'CalTopo' };
  const WHAT = { save: 'Saved', rename: 'Renamed', describe: 'Saved', colour: 'Colour changed', symbol: 'Symbol changed', label: 'Label changed', folder: 'Moved to the folder', move: 'Moved', del: 'Deleted' };
  const E = { last: null, drag: null };
  function tell(what, ref, res) {
    const nm = ref.name ? `“${ref.name}”` : 'it';
    let msg;
    if (res && res.queued) msg = `${WHAT[what] || 'Saved'} here: ${nm} is waiting for CalTopo and goes when FLEX is online again`;
    else if (res && res.conflict) msg = `${nm} was changed in CalTopo meanwhile: choose which version to keep`;
    else if (res && res.ok) msg = `${WHAT[what] || 'Saved'}: ${nm}${what === 'del' ? ' from ' : ' in '}${WHERE[ref.source] || 'its source'}`;
    else msg = `Not saved${ref.source === 'caltopo' ? ' to CalTopo' : ''}: ${(res && res.error) || 'it didn’t work'}`;
    E.last = { what, ref, result: res, message: msg };
    window.dispatchEvent(new CustomEvent('flex-feature-edited', { detail: E.last }));
    if (res && (res.ok || res.queued)) toast(msg);
    else if (res && res.conflict) { if (!res.shown && !(CT() && CT().showConflict)) conflict(ref, res); else toast(msg); }   // agent A's update shows its own dialog
    else {
      const ro = res && res.readOnly;
      dialog({ title: ref.source === 'caltopo' ? 'Not saved to CalTopo' : 'Not saved', text: msg + (ro ? '\n\nThe CalTopo key on this computer can only read the map. To edit from FLEX, enter a key that can write (🔑 Add a CalTopo key…, where the CalTopo map is loaded), on this computer.' : ''),
        buttons: ro && window._caltopoKeyDialog ? [{ label: 'Close', value: null }, { label: '🔑 Enter a key…', value: 'key', primary: true }] : undefined })
        .then(r => { if (r && r.button === 'key') window._caltopoKeyDialog(); });
    }
    return res;
  }
  async function conflict(ref, res) {
    const W = CT();
    const show = f => { const p = (f && f.properties) || {}; return [p.title != null ? 'Name: ' + p.title : '', p.description ? 'Description: ' + String(p.description).slice(0, 200) : '', p.folderId != null ? 'Folder: ' + (p.folderId || 'top level') : '',
      p['marker-color'] || p.stroke ? 'Colour: ' + (p['marker-color'] || p.stroke) : '', f && f.geometry && f.geometry.type === 'Point' ? 'Position: ' + f.geometry.coordinates.slice(0, 2).map(v => (+v).toFixed(6)).reverse().join(', ') : ''].filter(Boolean).join('\n'); };
    const body = el('div', 'fe-conflict');
    const col = (t, f) => { const c = el('div', 'fe-cv'); c.append(el('div', 'fe-cv-h', t), el('pre', 'fe-cv-b', show(f) || '(deleted)')); return c; };
    body.append(col('Yours (FLEX)', res.mine), col('CalTopo’s now', res.theirs));
    const r = await dialog({ title: `“${ref.name || 'Feature'}” changed in CalTopo`, text: 'It was changed in CalTopo after FLEX last read it. Which version should stay?', body, wide: true,
      buttons: [{ label: 'Decide later', value: null }, { label: 'Keep CalTopo’s', value: 'theirs' }, { label: 'Keep mine', value: 'mine', primary: true }] });
    if (!r || !W || !W.resolve) return null;
    const out = await W.resolve(ref.fid || ref.id, r.button);
    if (out) tell('save', ref, out.conflict ? { ok: false, error: 'it changed again; try once more' } : out);
    return out;
  }

  /** A CalTopo conflict (badge “changed in CalTopo: choose”): both versions, pick one. */
  function resolveConflict(x) {
    const r = refOf(x), W = CT();
    if (!r || !W || !r.fid) return Promise.resolve(null);
    if (W.showConflict) return Promise.resolve(W.showConflict(r.fid));          // CalTopo's side-by-side dialog (caltopo write)
    let pend = [];
    try { pend = (W.pending && W.pending()) || []; } catch (_) {}
    const p = pend.find(q => String(q.fid || q.id) === String(r.fid));
    const mine = p ? (p.feature || (p.patch ? { properties: p.patch, geometry: p.patch.geometry } : null)) : null;
    return conflict(r, { conflict: true, mine, theirs: W.feature ? W.feature(r.fid) : null });
  }

  // ── Writing ──────────────────────────────────────────────────────────────
  const ctColorKeys = r => (r.kind === 'point' ? ['marker-color'] : r.kind === 'area' ? ['stroke', 'fill'] : ['stroke']);
  // CalTopo writes colours as it reads them: keep the '#' (or not) the feature already has.
  const ctColor = (r, key, c) => { const had = r.json && r.json.properties && r.json.properties[key]; const bare = had ? !/^#/.test(String(had)) : key === 'marker-color'; const h = c.replace(/^#/, '').toUpperCase(); return bare ? h : '#' + h; };
  function ctPatch(r, patch) {
    const p = {};
    if (patch.name != null) p.title = patch.name;
    if (patch.desc != null) p.description = patch.desc;
    if (patch.folder !== undefined) p.folderId = patch.folder || null;
    if (patch.color) ctColorKeys(r).forEach(k => { p[k] = ctColor(r, k, patch.color); });
    if (patch.symbol !== undefined) p['marker-symbol'] = patch.symbol || '';
    if (patch.coords) {
      const c = patch.coords.map(x => [+(+x[0]).toFixed(7), +(+x[1]).toFixed(7)]);
      p.geometry = r.kind === 'point' ? { type: 'Point', coordinates: c[0] } : r.kind === 'line' ? { type: 'LineString', coordinates: c } : { type: 'Polygon', coordinates: [c.concat([c[0]])] };
    }
    return p;
  }
  async function apply(x, patch, what) {
    what = what || 'save';
    const r = refOf(x);
    if (!r) return tell(what, { name: '', source: '' }, { ok: false, error: 'it isn’t on the map any more' });
    if (!r.editable) return tell(what, r, { ok: false, error: r.reason || 'it is read-only' });
    patch = Object.assign({}, patch);
    if (patch.name != null) patch.name = String(patch.name).trim().slice(0, 120);
    if (patch.desc != null) patch.desc = String(patch.desc).trim().slice(0, 4000);
    if (patch.color) { patch.color = hex(patch.color); if (!patch.color) delete patch.color; }
    if (patch.coords && !Array.isArray(patch.coords[0])) patch.coords = [patch.coords];
    const after = Object.assign({}, r, patch.name != null ? { name: patch.name } : {});
    let res;
    try {
      if (r.source === 'project') {
        const f = pj.P.features[r.id], data = { feature: r.id };
        if (patch.name != null) data.name = patch.name;
        if (patch.desc != null) data.desc = patch.desc;
        if (patch.folder !== undefined) data.group = patch.folder || '';
        if (patch.coords) data.coords = patch.coords.map(c => [+c[0], +c[1], +(c[2] || 0)]);
        if (patch.color !== undefined || patch.label !== undefined || patch.symbol !== undefined) {
          const st = Object.assign({}, f.style || {});
          if (patch.color) st.color = patch.color;
          if (patch.label !== undefined) { if (patch.label === false) st.label = false; else delete st.label; }
          if (patch.symbol !== undefined) { if (patch.symbol) st.symbol = patch.symbol; else delete st.symbol; }
          data.style = st;
        }
        res = (await record('feature.set', data)) ? { ok: true } : { ok: false, error: 'the project could not be saved' };
      } else if (r.source === 'mydata') {
        const M = MD();
        if (!M || !M.update) res = { ok: false, error: 'My data isn’t available' };
        else {
          const p = {};
          ['name', 'desc', 'color', 'label'].forEach(k => { if (patch[k] !== undefined) p[k] = patch[k]; });
          if (patch.folder !== undefined) p.group = patch.folder;
          if (patch.coords) p.coords = patch.coords;
          res = await M.update(r.id, p);
          const e = r.entity || myEntity(r.id);
          if (res && res.ok && e) {                                    // the point on the map, as it is now
            if (patch.name != null && e.label) e.label.text = patch.name;
            if (patch.name != null) e.name = patch.name;
            if (patch.coords) e.position = Cesium.Cartesian3.fromDegrees(patch.coords[0][0], patch.coords[0][1], patch.coords[0][2] || 0);
            if (patch.color && e.point) e.point.color = Cesium.Color.fromCssColorString(patch.color);
            if (patch.label !== undefined && e.label) e.label.show = patch.label !== false;
            if (window.renderPoiList) try { window.renderPoiList(); } catch (_) {}
            if (window._surfCols) window._surfCols.refresh();
          }
        }
      } else if (r.source === 'caltopo') {
        const W = CT();
        res = await W.update(r.fid, ctPatch(r, patch));
      } else res = { ok: false, error: r.reason || 'it is read-only' };
    } catch (e) { res = { ok: false, error: e.message || String(e) }; }
    res = res || { ok: false, error: 'no answer' };
    const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
    return tell(what, after, res);
  }
  const rename = (x, name) => apply(x, { name }, 'rename');
  const describe = (x, desc) => apply(x, { desc }, 'describe');
  const colour = (x, c) => apply(x, { color: c }, 'colour');
  const symbol = (x, s) => apply(x, { symbol: s || '' }, 'symbol');
  const label = (x, on) => apply(x, { label: !!on }, 'label');
  const moveTo = (x, folder) => apply(x, { folder: folder || '' }, 'folder');
  const move = (x, c) => apply(x, { coords: [c] }, 'move');
  async function del(x, opts) {
    const r = refOf(x);
    if (!r) return null;
    if (!r.editable) return tell('del', r, { ok: false, error: r.reason });
    if (!opts || opts.confirm !== false) {
      const then = r.source === 'project' ? 'Undo in 📁 History.' : r.source === 'caltopo' ? 'It is deleted from the CalTopo map (for everyone who uses it).' : 'It is removed from My data.';
      const ok = await dialog({ title: `Delete “${r.name || KIND[r.kind] || 'it'}”?`, text: then, buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'rm', danger: true }] });
      if (!ok) return null;
    }
    let res;
    try {
      if (r.source === 'project') res = (await record('feature.set', { feature: r.id, removed: true })) ? { ok: true } : { ok: false, error: 'the project could not be saved' };
      else if (r.source === 'mydata') {
        const e = r.entity || myEntity(r.id);
        if (e) { await MD().forgetPoint(e); V().entities.remove(e); } else await MD().forgetPoint({ properties: { myFeature: { getValue: () => r.id } } });
        if (window.renderPoiList) try { window.renderPoiList(); } catch (_) {}
        res = { ok: true };
        if (V() && V().selectedEntity === e) V().selectedEntity = undefined;
      } else if (r.source === 'caltopo') res = await CT().remove(r.fid);
    } catch (e) { res = { ok: false, error: e.message || String(e) }; }
    return tell('del', r, res || { ok: false, error: 'no answer' });
  }

  // ── Moving a point on the map ────────────────────────────────────────────
  function pickAt(screen) {
    const v = V(); let c = null;
    try { const ray = v.camera.getPickRay(screen); c = ray && v.scene.globe.pick(ray, v.scene); } catch (_) { c = null; }
    if (c && Cesium.Cartographic.fromCartesian(c).height < -1000) c = null;
    if (!c) { try { c = v.camera.pickEllipsoid(screen, v.scene.globe.ellipsoid); } catch (_) { c = null; } }
    return c ? lonlat(c) : null;
  }
  function drag(x) {
    const r = refOf(x), v = V();
    if (!r || !v) return Promise.resolve(null);
    if (!r.editable) return Promise.resolve(tell('move', r, { ok: false, error: r.reason }));
    if (r.kind !== 'point') { toast('Only a point can be moved on the map'); return Promise.resolve(null); }
    if (E.drag) E.drag.cancel();
    return new Promise(resolve => {
      const banner = el('div', 'pjf-banner fe-banner', `Moving “${r.name || 'point'}”: drag it to where it goes, or click there · Esc cancels`);
      document.body.appendChild(banner);
      const start = r.coords[0] || [0, 0, 0];
      let at = start.slice();
      const Y = Cesium.Color.fromCssColorString('#ffe600');
      const temp = v.entities.add({ position: new Cesium.CallbackProperty(() => Cesium.Cartesian3.fromDegrees(at[0], at[1], at[2] || 0), false),
        point: { pixelSize: 16, color: Y.withAlpha(0.35), outlineColor: Y, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      const h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas), def = v.screenSpaceEventHandler, T = Cesium.ScreenSpaceEventType;
      const saved = [T.LEFT_CLICK, T.LEFT_DOUBLE_CLICK].map(t => [t, def.getInputAction(t)]);
      saved.forEach(([t]) => def.removeInputAction(t));
      const ctl = v.scene.screenSpaceCameraController, was = ctl.enableInputs;
      ctl.enableInputs = false;                                     // the map stays still while the point moves
      let down = false;
      const stop = () => { h.destroy(); v.entities.remove(temp); banner.remove(); ctl.enableInputs = was; document.removeEventListener('keydown', key, true); saved.forEach(([t, fn]) => { if (fn) def.setInputAction(fn, t); }); E.drag = null; v.scene.requestRender && v.scene.requestRender(); };
      const cancel = () => { stop(); resolve(null); };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
      document.addEventListener('keydown', key, true);
      h.setInputAction(ev => { down = true; const p = pickAt(ev.position); if (p) at = p; }, T.LEFT_DOWN);
      h.setInputAction(ev => { const p = pickAt(ev.endPosition); if (p && down) at = p; v.scene.requestRender && v.scene.requestRender(); }, T.MOUSE_MOVE);
      h.setInputAction(async ev => {
        if (!down) return;
        const p = pickAt(ev.position) || at; stop();
        resolve(await apply(r, { coords: [r.source === 'caltopo' ? [p[0], p[1]] : p] }, 'move'));
      }, T.LEFT_UP);
      h.setInputAction(() => cancel(), T.RIGHT_CLICK);
      E.drag = { ref: r, cancel, at: () => at };
    });
  }

  // ── The editor ───────────────────────────────────────────────────────────
  const f2 = (x, d) => (Number.isFinite(+x) ? (+x).toFixed(d) : '');
  async function open(x, opts) {
    opts = opts || {};
    if (MD() && MD().state) try { await MD().state(); } catch (_) {}
    const r = refOf(x);
    if (!r) return null;
    if (!r.editable) { await dialog({ title: `${r.name || 'Feature'} — read-only`, text: r.reason || 'It can’t be edited here.' }); return null; }
    const body = el('div', 'pj-form fe-form');
    const lab = (t, x2) => { const d = el('div', 'pj-f'); d.appendChild(el('div', 'pj-f-l', t)); d.appendChild(x2); return d; };
    const name = el('input', 'pj-input fe-name'); name.value = r.name || ''; name.placeholder = 'Name';
    const desc = el('textarea', 'pj-input fe-desc'); desc.rows = 4; desc.value = r.desc || ''; desc.placeholder = 'Description (a line “flex: cave=…; station=…” marks a cave entrance)';
    body.append(lab('Name', name), lab('Description', desc));
    const fl = folders(r);
    const grp = el('select', 'pj-input fe-folder');
    grp.appendChild(new Option(r.source === 'mydata' ? '(no group)' : '(top level)', ''));
    fl.forEach(g => grp.appendChild(new Option('  '.repeat(g.depth) + g.name, g.id)));
    if (r.folder && !fl.some(g => g.id === r.folder)) grp.appendChild(new Option(r.path.map(p => p.name).join(' / ') || r.folder, r.folder));
    grp.value = r.folder || '';
    body.appendChild(lab(r.source === 'mydata' ? 'Group' : 'Folder', grp));
    const col = el('input', 'fe-color'); col.type = 'color'; col.value = r.color || '#ffb020';
    const styleRow = el('div', 'fe-row'); styleRow.appendChild(col);
    let sym = null, lbl = null;
    if (r.source === 'caltopo' && r.kind === 'point') {
      sym = el('input', 'pj-input fe-symbol'); sym.value = r.symbol || ''; sym.placeholder = 'CalTopo symbol (e.g. point, cave)'; sym.setAttribute('list', 'fe-symbols');
      if (!document.getElementById('fe-symbols')) { const dl = el('datalist'); dl.id = 'fe-symbols'; ['point', 'cave', 'c:ring', 'cp', 'a:1', 'campsite', 'trailhead', 'water', 'danger', 'flag-1', 'x'].forEach(s => dl.appendChild(new Option(s, s))); document.body.appendChild(dl); }
      styleRow.appendChild(sym);
    }
    if (r.label != null) {
      // Applied with Save, like the rest of the form: a box to tick, not a switch.
      const l = el('label', 'fe-lbl'); lbl = el('input', 'keep-box'); lbl.type = 'checkbox'; lbl.checked = r.label !== false;
      l.append(lbl, ' Name shown on the map'); styleRow.appendChild(l);
    }
    body.appendChild(lab(sym ? 'Colour and symbol' : 'Colour', styleRow));
    // Position: lat/lon or UTM, whichever was typed last.
    let pos = null;
    if (r.kind === 'point' && r.coords[0]) {
      const c0 = r.coords[0], u0 = utm(c0[0], c0[1]);
      const box = el('div', 'fe-pos');
      const inp = (cls, v, ph) => { const i = el('input', 'pj-input ' + cls); i.value = v; i.placeholder = ph; i.inputMode = 'decimal'; return i; };
      const lat = inp('fe-lat', f2(c0[1], 6), 'Latitude'), lon = inp('fe-lon', f2(c0[0], 6), 'Longitude');
      const zone = inp('fe-zone', u0.zone + u0.band, 'Zone'), ue = inp('fe-e', f2(u0.e, 1), 'Easting'), un = inp('fe-n', f2(u0.n, 1), 'Northing');
      let mode = null;
      const fromLL = () => { const a = +lat.value, o = +lon.value; if (!Number.isFinite(a) || !Number.isFinite(o) || Math.abs(a) > 84 || Math.abs(o) > 180) return; const u = utm(o, a); zone.value = u.zone + u.band; ue.value = f2(u.e, 1); un.value = f2(u.n, 1); };
      const zoneOf = () => { const m = /^\s*(\d{1,2})\s*([C-HJ-NP-X])?\s*$/i.exec(zone.value); if (!m) return null; const z = +m[1]; const b = (m[2] || '').toUpperCase(); return z >= 1 && z <= 60 ? { z, south: b ? b < 'N' : +lat.value < 0 } : null; };
      const fromU = () => { const z = zoneOf(), e = +ue.value, n = +un.value; if (!z || !Number.isFinite(e) || !Number.isFinite(n)) return; const [o, a] = fromUtm(z.z, z.south, e, n); lat.value = f2(a, 6); lon.value = f2(o, 6); };
      [lat, lon].forEach(i => i.addEventListener('input', () => { mode = 'll'; fromLL(); }));
      [zone, ue, un].forEach(i => i.addEventListener('input', () => { mode = 'utm'; fromU(); }));
      const r1 = el('div', 'fe-row'); r1.append(el('span', 'fe-k', 'Lat, lon'), lat, lon);
      const r2 = el('div', 'fe-row'); r2.append(el('span', 'fe-k', 'UTM'), zone, ue, un);
      box.append(r1, r2);
      body.appendChild(lab('Position', box));
      pos = {
        changed: () => mode !== null,
        value: () => {
          if (mode === 'utm') fromU();
          const a = +lat.value, o = +lon.value;
          if (!Number.isFinite(a) || !Number.isFinite(o) || Math.abs(a) > 90 || Math.abs(o) > 180) return null;
          if (Math.abs(a - c0[1]) < 1e-8 && Math.abs(o - c0[0]) < 1e-8) return 'same';
          return r.source === 'caltopo' ? [o, a] : [o, a, 0];
        },
      };
    } else if (r.coords.length) body.appendChild(el('div', 'pj-sub', `${r.coords.length} points`));
    body.appendChild(el('div', 'pj-sub fe-src', 'Saved to ' + (r.source === 'caltopo' ? `the CalTopo map (${r.srcName})` : r.source === 'mydata' ? 'My data' : `the project (${r.srcName})`)));
    setTimeout(() => { const f = opts.focus === 'position' ? body.querySelector('.fe-lat') : opts.focus === 'folder' ? grp : opts.focus === 'colour' ? col : name; if (f) f.focus(); }, 50);
    const leadOn = r.source === 'project' && r.kind === 'point' ? Object.values(pj.P.leads).find(L => !L.deleted && L.target === FL.T.feature(r.id)) : null;
    const res = await dialog({ title: `Edit ${KIND[r.kind] || 'feature'} “${r.name || ''}”`, body, wide: true,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'rm', danger: true },
        ...(r.source === 'project' && r.kind === 'point' ? [{ label: leadOn ? '❓ Its lead…' : '❓ Make it a lead…', value: 'lead' }] : []),
        ...(r.kind === 'point' ? [{ label: 'Move on the map', value: 'drag' }] : []), { label: 'Save', value: 'ok', primary: true }] });
    if (!res) return null;
    if (res.button === 'rm') return del(r);
    if (res.button === 'lead') {
      const nm = '“' + (r.name || 'surface point') + '” (surface)';
      if (leadOn) A.editLead(null, nm, { id: leadOn.id, rec: leadOn, fields: leadOn.fields, active: FL.leadActive(leadOn) });
      else A.editLead(null, nm, { target: FL.T.feature(r.id), fields: { status: 'open', desc: r.desc || '' } });
      return null;
    }
    // Only what changed goes to the source.
    const patch = {};
    if (name.value.trim() !== (r.name || '').trim()) patch.name = name.value;
    if (desc.value.trim() !== (r.desc || '').trim()) patch.desc = desc.value;
    if (grp.value !== (r.folder || '')) patch.folder = grp.value;
    if (col.value.toLowerCase() !== String(r.color || '#ffb020').toLowerCase()) patch.color = col.value;
    if (sym && sym.value.trim() !== (r.symbol || '')) patch.symbol = sym.value.trim();
    if (lbl && lbl.checked !== (r.label !== false)) patch.label = lbl.checked;
    if (pos && pos.changed()) {
      const c = pos.value();
      if (!c) { toast('That position isn’t a place: nothing was moved'); }
      else if (c !== 'same') patch.coords = [c];
    }
    let out = null;
    if (Object.keys(patch).length) out = await apply(r, patch, 'save');
    if (res.button === 'drag') return drag(r);
    if (!out) toast('Nothing changed');
    return out;
  }

  const st = document.createElement('style');
  st.textContent = `
  .fe-form .fe-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .fe-form .fe-row .pj-input { flex: 1; min-width: 70px; margin: 0; }
  .fe-form .fe-zone { flex: 0 0 56px !important; min-width: 56px !important; }
  .fe-form .fe-k { width: 54px; flex: none; opacity: .65; font-size: 11.5px; }
  .fe-form .fe-pos { display: flex; flex-direction: column; gap: 4px; }
  .fe-form .fe-lbl { display: inline-flex; align-items: center; gap: 5px; margin: 0; font-size: 12px; cursor: pointer; }
  .fe-form .fe-color { width: 44px; height: 26px; padding: 0; border: none; background: none; }
  .fe-conflict { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 8px 0; }
  .fe-cv-h { font-weight: 700; margin-bottom: 4px; }
  .fe-cv-b { white-space: pre-wrap; font: 11.5px system-ui, sans-serif; background: rgba(255,255,255,.05); border-radius: 5px; padding: 6px 8px; margin: 0; max-height: 40vh; overflow: auto; color: inherit; }`;
  document.head.appendChild(st);

  window._featEdit = { refOf, canEdit, open, apply, resolve: resolveConflict, rename, describe, colour, symbol, label, moveTo, move, drag, del, folders, utm, fromUtm,
    get last() { return E.last; }, get dragging() { return E.drag; } };
})();
