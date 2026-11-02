// caltopo-match.js — which of the project's surface features (📍 points,
// lines, areas) are already on the project's CalTopo map.
//
// window._ctMatch (and module.exports under Node, for tools/test_caltopo_match.js):
//   matchFeature(f, ctEntities) → the CalTopo entity that is this feature, or null
//   unmatched(P, src)           → the project's live features with no match
//   duplicates(P, src)          → [{ feature, entity }] for the ones that match
// src: the loaded CalTopo map ({ ds } from _ws.vectorSources(), a data
// source, or an array of entities); left out, the CalTopo map loaded now.
// With no map, nothing matches (every feature is unmatched).
//
// The rule — a project feature f and a CalTopo entity e are the same thing when
//   1. same kind: point / line / area (an entity with a polygon is an area,
//      with only a polyline a line, with only a position a point; folders,
//      which have no geometry, never match);
//   2. same name, ignoring case and runs of spaces ("Pit  2" = "pit 2"; two
//      unnamed ones are the same name);
//   3. close: a point within TOL_M (15 m) of the marker; a line or an area
//      when at least MIN_FRAC (80 %) of f's vertices lie within 15 m of e's
//      shape (its line, or its ring for an area). Only f's vertices are
//      checked (up to 200, evenly picked), so CalTopo simplifying a long
//      track, or adding points to it, doesn't matter; a line moved more than
//      15 m, or a short piece of a different track with the same name, does.
// Distances are flat (equirectangular around the shape), fine at this scale.
// Shapes read from Cesium entities are kept per entity (a refresh in place
// keeps unchanged entities, project features are plain [lon, lat] lists).
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root._ctMatch = M;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const TOL_M = 15, MIN_FRAC = 0.8, MAX_VERTS = 200;
  const R = 6371008.8, RAD = Math.PI / 180;
  const normName = n => String(n == null ? '' : n).toLowerCase().replace(/\s+/g, ' ').trim();

  // ── Shapes: { kind, name, coords: [[lon, lat]…] } ───────────────────────
  const cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function val(p) {
    if (!p) return p;
    if (typeof p.getValue === 'function') { const C = typeof Cesium !== 'undefined' ? Cesium : null; return p.getValue(C ? C.JulianDate.now() : undefined); }
    return p;
  }
  function lonlat(c) {
    if (Array.isArray(c)) return [c[0], c[1]];
    const C = typeof Cesium !== 'undefined' ? Cesium : null;
    if (!C || !c) return null;
    const k = C.Cartographic.fromCartesian(c);
    return k ? [k.longitude / RAD, k.latitude / RAD] : null;
  }
  /** A CalTopo entity (or a plain { kind, name, coords }) as a shape; null for folders. */
  function shapeOf(e) {
    if (!e) return null;
    if (Array.isArray(e.coords) && e.kind) return { kind: e.kind, name: e.name, coords: e.coords };
    const ref = e.polygon ? e.polygon.hierarchy : e.polyline ? e.polyline.positions : e.position;
    if (!ref) return null;
    if (cache) { const c = cache.get(e); if (c && c.ref === ref) return c.shape; }
    let shape = null;
    try {
      if (e.polygon) { const h = val(e.polygon.hierarchy); const ps = h && (h.positions || (Array.isArray(h) ? h : null)); if (ps && ps.length) shape = { kind: 'area', coords: ps.map(lonlat).filter(Boolean) }; }
      else if (e.polyline) { const ps = val(e.polyline.positions); if (ps && ps.length) shape = { kind: 'line', coords: ps.map(lonlat).filter(Boolean) }; }
      else if (e.position) { const p = val(e.position); const q = p && lonlat(p); if (q) shape = { kind: 'point', coords: [q] }; }
    } catch (_) { shape = null; }
    if (shape) shape.name = typeof e.name === 'string' ? e.name : (val(e.name) || '');
    if (cache) cache.set(e, { ref, shape });
    return shape;
  }

  // ── Distances (metres, flat around lat0) ────────────────────────────────
  const xy = (c, k) => [c[0] * RAD * R * k, c[1] * RAD * R];
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
    return Math.sqrt(x * x + y * y);
  }
  function bbox(cs) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of cs) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1]; if (p[0] > c) c = p[0]; if (p[1] > d) d = p[1]; }
    return [a, b, c, d];
  }
  function sample(cs) {
    if (cs.length <= MAX_VERTS) return cs;
    const out = [], step = (cs.length - 1) / (MAX_VERTS - 1);
    for (let i = 0; i < MAX_VERTS; i++) out.push(cs[Math.round(i * step)]);
    return out;
  }
  /** Is project shape f (kind, coords) close to CalTopo shape s of the same kind? */
  function close(f, s) {
    const fc = (f.coords || []).filter(c => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1]));
    const sc = s.coords || [];
    if (!fc.length || !sc.length) return false;
    const lat0 = (fc[0][1] + sc[0][1]) / 2, k = Math.cos(lat0 * RAD);
    if (f.kind === 'point') { const a = xy(fc[0], k), b = xy(sc[0], k); return Math.hypot(a[0] - b[0], a[1] - b[1]) <= TOL_M; }
    // Cheap first: the boxes, grown by the tolerance, must meet.
    const fb = bbox(fc), sb = bbox(sc), dLat = TOL_M / (RAD * R), dLon = dLat / Math.max(k, 1e-6);
    if (fb[0] > sb[2] + dLon || fb[2] < sb[0] - dLon || fb[1] > sb[3] + dLat || fb[3] < sb[1] - dLat) return false;
    const S = sc.map(c => xy(c, k));
    if (f.kind === 'area' && S.length > 2) S.push(S[0]);            // the ring, closed
    const V = sample(fc).map(c => xy(c, k));
    const need = Math.ceil(MIN_FRAC * V.length);
    let near = 0, left = V.length;
    for (const p of V) {
      let m = Infinity;
      if (S.length === 1) m = Math.hypot(p[0] - S[0][0], p[1] - S[0][1]);
      else for (let i = 1; i < S.length && m > TOL_M; i++) { const d = segDist(p, S[i - 1], S[i]); if (d < m) m = d; }
      if (m <= TOL_M) near++;
      left--;
      if (near >= need) return true;
      if (near + left < need) return false;
    }
    return near >= need;
  }

  // ── Matching ────────────────────────────────────────────────────────────
  function entitiesOf(src) {
    if (src === undefined && typeof window !== 'undefined' && window._ws && window._ws.vectorSources) src = window._ws.vectorSources().find(s => s.kind === 'caltopo') || null;
    if (!src) return [];
    if (Array.isArray(src)) return src;
    const ds = src.ds || src;
    return (ds.entities && ds.entities.values) || [];
  }
  /** The CalTopo entities indexed by kind + name (names only: shapes are read for candidates). */
  function index(ents) {
    const by = new Map();
    for (const e of ents) {
      const kind = e && (Array.isArray(e.coords) && e.kind ? e.kind : e.polygon ? 'area' : e.polyline ? 'line' : e.position ? 'point' : null);
      if (!kind) continue;
      const key = kind + '|' + normName(typeof e.name === 'string' ? e.name : val(e.name));
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(e);
    }
    return by;
  }
  function find(f, by) {
    if (!f || !f.kind || !f.coords) return null;
    for (const e of by.get(f.kind + '|' + normName(f.name)) || []) {
      const s = shapeOf(e);
      if (s && s.kind === f.kind && close(f, s)) return e;
    }
    return null;
  }
  function matchFeature(f, ctEntities) { return find(f, index(entitiesOf(ctEntities))); }
  function features(P) {
    const FL = (typeof window !== 'undefined' && window.FlexLib) || (typeof require === 'function' ? require('../../../viewer_build/libs/flexlib.js') : null);
    return FL ? FL.liveFeatures(P) : Object.values((P && P.features) || {}).filter(f => !f.removed && f.coords && f.coords.length);
  }
  function unmatched(P, src) { const by = index(entitiesOf(src)); return features(P).filter(f => !find(f, by)); }
  function duplicates(P, src) {
    const by = index(entitiesOf(src)), out = [];
    features(P).forEach(f => { const e = find(f, by); if (e) out.push({ feature: f, entity: e }); });
    return out;
  }
  /** CalTopo entities that have a shape (not folders). */
  const countShapes = src => entitiesOf(src).filter(e => e && (e.polygon || e.polyline || e.position || (Array.isArray(e.coords) && e.kind))).length;

  return { matchFeature, unmatched, duplicates, shapeOf, normName, countShapes, TOL_M, MIN_FRAC };
});
