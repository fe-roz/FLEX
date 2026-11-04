// ground-height.js — where the ground is under a point, asked ONCE and kept, instead of Cesium clamping the
// point to the terrain every frame (window._groundH).
//
// Why: an entity (point, billboard, label) with heightReference CLAMP_TO_TERRAIN registers a height callback
// with Cesium. Cesium also registers one for the camera every frame it moves, and every such add/remove makes
// the terrain's quadtree re-filter ALL callbacks into every visited tile (QuadtreeTile._updateCustomData). With
// a few thousand clamped labels that was most of the frame (measured: tools/perf_labels.js). Here a point is
// drawn at an absolute height instead, and the height is sampled when it is first needed:
//
//   - Cesium.sampleTerrainMostDetailed on the viewer's terrain (the finest level the provider has, no need to
//     wait for tiles to be drawn), in batches; terrain only, never Google 3D tiles.
//   - Kept in memory and in IndexedDB ('flex-ground', per computer; derived data: never written into project
//     records or CalTopo), keyed by the terrain that answered: the world terrain plus the fingerprint of every
//     terrain patch covering that spot, and the point's lon/lat rounded to 1e-5 deg (about 1 m). A reload, or an
//     offline session, finds them without sampling.
//   - A new terrain patch (flex-terrain-changed, or the viewer's terrainProvider replaced) changes the key only
//     for points inside the patch; only those are sampled again. A moved or new feature is a new lon/lat.
//
// API:  pos(lon, lat)            -> { pos: Cartesian3, exact: bool } the best height known now
//       track(entity, lon, lat)  make the entity's .position follow the ground there (now, and when the answer or
//                                the terrain changes); the entity is forgotten when it leaves its collection
//       untrack(entity), keyAt(lon, lat), get(lon, lat), stats(), clear(), whenIdle()
//       measure(lon, lat)        -> Promise<{ h, t, exact }> the ground height asked once and kept, and the terrain
//                                (t = keyAt) that answered: what an item stores as its own height with hsrc {k:'ground', t}
//       measureMany([[lon, lat]…]) the same for a list, asked together
//       finer(t, lon, lat)       true when the terrain there now has a patch the stored terrain t did not
// Event 'flex-ground-heights' (detail {n}) after positions were updated.
(function () {
  'use strict';
  const DB = 'flex-ground', STORE = 'h', SAVE_MS = 1500, BATCH = 400, R5 = 1e5;
  const V = () => window.cesiumViewer;
  const r5 = x => Math.round(x * R5) / R5;
  const pk = (lon, lat) => r5(lon) + ',' + r5(lat);

  // ── Which terrain answers at a spot ──────────────────────────────────────
  const fpCache = new WeakMap();
  function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }
  function patchFp(tp) {
    let f = fpCache.get(tp);
    if (f) return f;
    const p = tp._p || {}, g = p.grid;
    let s = [p.name, p.west, p.south, p.east, p.north, p.nx, p.ny, p.cell_m, p.maxLevel, g ? g.length : 0].join(',');
    if (g && g.length) { const st = Math.max(1, Math.floor(g.length / 257)); let a = 0; for (let i = 0; i < g.length; i += st) a = (a * 31 + Math.round((g[i] || 0) * 100)) | 0; s += ',' + a; }
    f = { fp: hashStr(s), w: p.west, e: p.east, s: p.south, n: p.north };
    fpCache.set(tp, f);
    return f;
  }
  let lastProv = null, layers = { base: 'world', patches: [] };
  function terrainLayers() {
    const v = V(); if (!v) return layers;
    let tp = v.terrainProvider;
    if (tp === lastProv) return layers;
    lastProv = tp;
    const patches = [];
    while (tp && tp._p && tp._base) { patches.push(patchFp(tp)); tp = tp._base; }
    const C = window.Cesium;
    // the base terrain: flat (no terrain), or the world terrain by its source (a provider may name itself with _flexId)
    let base = 'world';
    try { if (C && tp instanceof C.EllipsoidTerrainProvider) base = 'flat'; else if (tp && tp._flexId) base = String(tp._flexId); else if (tp && tp._resource && tp._resource.url) base = 'w' + hashStr(String(tp._resource.url)); } catch (_) {}
    layers = { base, patches };
    return layers;
  }
  const DEG = Math.PI / 180;
  function keyAt(lon, lat) {
    const L = terrainLayers();
    let k = L.base;
    for (const p of L.patches) if (lon >= p.w && lon <= p.e && lat >= p.s && lat <= p.n) k += '+' + p.fp;
    return k;
  }

  // ── Stored heights (memory + IndexedDB) ──────────────────────────────────
  // A chunk = the heights under one layer-set key in one 0.1 deg cell: { id, h: { 'lon,lat': metres } }
  const chunks = new Map();
  let db = null, dbTried = false, saveTimer = null;
  function openDb() {
    if (dbTried) return db;
    dbTried = true;
    db = new Promise(res => {
      try {
        if (typeof indexedDB === 'undefined') return res(null);
        const rq = indexedDB.open(DB, 1);
        rq.onupgradeneeded = () => { rq.result.createObjectStore(STORE, { keyPath: 'id' }); };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = rq.onblocked = () => res(null);
      } catch (_) { res(null); }
    });
    return db;
  }
  // from the rounded spot, so that float noise in a coordinate (-100.50000000000001) cannot pick another chunk than the stored one
  const chunkId = (k, lon, lat) => k + '|' + Math.floor(r5(lon) * 10) + '|' + Math.floor(r5(lat) * 10);
  function chunkFor(k, lon, lat) {
    const id = chunkId(k, lon, lat);
    let c = chunks.get(id);
    if (!c) {
      c = { id, h: {}, ready: false, dirty: false };
      chunks.set(id, c);
      c.loading = (async () => {
        try {
          const d = await openDb();
          if (d) await new Promise(res => {
            try { const rq = d.transaction(STORE).objectStore(STORE).get(id); rq.onsuccess = () => { if (rq.result && rq.result.h) c.h = Object.assign(rq.result.h, c.h); res(); }; rq.onerror = () => res(); } catch (_) { res(); }
          });
        } catch (_) {}
        c.ready = true;
      })();
    }
    return c;
  }
  function flush() {
    saveTimer = null;
    const dirty = [...chunks.values()].filter(c => c.dirty);
    if (!dirty.length) return;
    openDb().then(d => {
      if (!d) return;
      try { const tx = d.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE); dirty.forEach(c => { st.put({ id: c.id, h: c.h }); c.dirty = false; }); } catch (_) {}
    });
  }
  const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(flush, SAVE_MS); };

  /** The kept height at a spot for the terrain there now, or undefined (and the chunk is being read). */
  function get(lon, lat) {
    const c = chunkFor(keyAt(lon, lat), lon, lat);
    return c.ready ? c.h[pk(lon, lat)] : undefined;
  }
  function put(k, lon, lat, h) {
    const c = chunkFor(k, lon, lat);
    c.h[pk(lon, lat)] = Math.round(h * 100) / 100; c.dirty = true; saveSoon();
  }

  // ── Sampling ─────────────────────────────────────────────────────────────
  const queue = new Map();            // pk|key → { lon, lat, k, tries }
  let running = false, idleWaiters = [], sampled = 0, calls = 0;
  function whenIdle() { return !running && !queue.size && !pendingChunks() ? Promise.resolve() : new Promise(r => idleWaiters.push(r)); }
  const pendingChunks = () => { for (const c of chunks.values()) if (!c.ready) return true; return false; };
  function want(lon, lat, k) { const id = k + '#' + pk(lon, lat); if (!queue.has(id)) queue.set(id, { lon: r5(lon), lat: r5(lat), k, tries: 0 }); kick(); }
  function kick() { if (!running) { running = true; setTimeout(run, 0); } }
  async function run() {
    try {
      for (;;) {
        // chunks still being read from IndexedDB first, so a saved height is not sampled again
        const waits = [...chunks.values()].filter(c => !c.ready).map(c => c.loading);
        if (waits.length) await Promise.all(waits);
        const v = V(), C = window.Cesium;
        if (!v || !C) break;
        const todo = [];
        for (const [id, q] of queue) {
          if (q.k !== keyAt(q.lon, q.lat)) { queue.delete(id); continue; }     // the terrain changed again meanwhile
          const c = chunkFor(q.k, q.lon, q.lat);
          if (c.h[pk(q.lon, q.lat)] !== undefined) { queue.delete(id); continue; }
          todo.push([id, q]); if (todo.length >= BATCH) break;
        }
        if (!todo.length) { apply(); if (!queue.size) break; await new Promise(r => setTimeout(r, 0)); continue; }       // yield: never a hot loop
        const prov = v.terrainProvider;
        let res = null;
        try {
          const cartos = todo.map(([, q]) => new C.Cartographic(q.lon * DEG, q.lat * DEG));
          calls++;
          if (prov instanceof C.EllipsoidTerrainProvider) res = cartos.map(c => { c.height = 0; return c; });
          else if (prov.availability) res = await C.sampleTerrainMostDetailed(prov, cartos);
          else res = await C.sampleTerrain(prov, 11, cartos);
        } catch (_) { res = null; }
        if (v.terrainProvider !== prov) continue;                            // replaced while waiting: ask again for the new one
        todo.forEach(([id, q], i) => {
          const h = res && res[i] && res[i].height;
          if (Number.isFinite(h)) { put(q.k, q.lon, q.lat, h); queue.delete(id); sampled++; }
          else if (++q.tries >= 3) { const g = globeHeight(q.lon, q.lat); if (g != null) put(q.k, q.lon, q.lat, g); queue.delete(id); }
        });
        apply();
        if (queue.size && todo.every(([id]) => queue.has(id))) await new Promise(r => setTimeout(r, 1500));   // nothing answered: tiles not there yet
        else await new Promise(r => setTimeout(r, 0));
      }
    } finally {
      running = false;
      if (queue.size || pendingChunks()) setTimeout(kick, 1000);
      else { const w = idleWaiters; idleWaiters = []; w.forEach(r => r()); }
    }
  }
  function globeHeight(lon, lat) {
    try { const v = V(), h = v.scene.globe.getHeight(new Cesium.Cartographic(lon * DEG, lat * DEG)); return Number.isFinite(h) ? h : null; } catch (_) { return null; }
  }

  // ── Following entities ───────────────────────────────────────────────────
  const tracked = new Map();          // entity → { lon, lat, k, h, exact }
  function cart3(lon, lat, h) { return Cesium.Cartesian3.fromDegrees(lon, lat, h); }
  /** The best height known now: kept, else what the globe has loaded, else 0. */
  function pos(lon, lat) {
    const h = get(lon, lat);
    if (h !== undefined) return { pos: cart3(lon, lat, h), exact: true, h };
    want(lon, lat, keyAt(lon, lat));
    const g = globeHeight(lon, lat);
    return { pos: cart3(lon, lat, g == null ? 0 : g), exact: false, h: g == null ? 0 : g };
  }
  function track(e, lon, lat) {
    if (!e) return;
    const r = tracked.get(e), k = keyAt(lon, lat), p = pos(lon, lat);
    tracked.set(e, { lon, lat, k, h: p.h, exact: p.exact });
    if (!r || !p.exact || r.h !== p.h) e.position = p.pos;
  }
  function untrack(e) { tracked.delete(e); }
  let pendingN = 0;
  function apply() {
    let n = 0;
    for (const [e, r] of tracked) {
      if (e.entityCollection === undefined || (e.isDestroyed && e.isDestroyed())) { tracked.delete(e); continue; }
      const k = keyAt(r.lon, r.lat);
      if (r.exact && r.k === k) continue;
      const h = get(r.lon, r.lat);
      if (h !== undefined) {
        if (h !== r.h || r.k !== k) e.position = cart3(r.lon, r.lat, h);
        r.h = h; r.k = k; r.exact = true; n++;
      } else if (r.k !== k) { r.k = k; r.exact = false; want(r.lon, r.lat, k); }      // terrain changed under it: ask again; it stays where it was
      else if (!r.exact) want(r.lon, r.lat, k);
    }
    pendingN = n;
    if (n) { const v = V(); if (v && v.scene.requestRender) v.scene.requestRender(); window.dispatchEvent(new CustomEvent('flex-ground-heights', { detail: { n } })); }
  }
  // ── Asking once for items that store their own height (height-model.js) ──
  const MEASURE_MS = 12000;
  async function measureMany(list) {
    const ks = list.map(c => keyAt(c[0], c[1]));
    list.forEach((c, i) => { if (get(c[0], c[1]) === undefined) want(c[0], c[1], ks[i]); });
    await Promise.race([whenIdle(), new Promise(r => setTimeout(r, MEASURE_MS))]);
    return list.map((c, i) => {
      const t = keyAt(c[0], c[1]), h = get(c[0], c[1]);
      if (h !== undefined) return { h, t, exact: true };
      const g = globeHeight(c[0], c[1]);
      return { h: g == null ? 0 : g, t, exact: false };
    });
  }
  const measure = async (lon, lat) => (await measureMany([[lon, lat]]))[0];
  /** Has the terrain at this spot a patch that the stored terrain key t did not have? */
  function finer(t, lon, lat) {
    const have = new Set(String(t || '').split('+').slice(1));
    return keyAt(lon, lat).split('+').slice(1).some(f => !have.has(f));
  }
  function terrainChanged() { lastProv = null; chunks.forEach((c, id) => { if (!c.dirty && !c.ready) chunks.delete(id); }); apply(); }
  window.addEventListener('flex-terrain-changed', terrainChanged);
  setInterval(() => { const v = V(); if (v && v.terrainProvider !== lastProv && tracked.size) terrainChanged(); }, 2000);

  window._groundH = {
    pos, track, untrack, get, keyAt, whenIdle, measure, measureMany, finer,
    stats: () => ({ tracked: tracked.size, queued: queue.size, sampled, calls, chunks: chunks.size }),
    clear: async () => { chunks.clear(); tracked.forEach(r => { r.exact = false; }); const d = await openDb(); if (d) try { d.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch (_) {} },
    flush,
  };
})();
