// Keeping the height filter's ground grids: across reloads (IndexedDB) and while
// panning (an in-memory LRU of the margins that scrolled out of the window).
// Used by pointcloud-hag.js (read that file and PotreeCopied/FLEX_PATCHES.md first:
// the grid format, the packed texture and the "never uploaded" rule are exact and
// are NOT changed here; this file only stores and restores the accumulators).
//
// What is kept is the ACCUMULATORS (lowest / highest class-2 return and the lowest
// other return per cell), never the packed RGBA texture. After a restore the
// texture is rebuilt by hagRepackGrid, so a texel is never 0 for "ground at the
// bottom of the window" and a cell with nothing stays alpha 0 (= no data).
//
// Pure exports (no browser), node-testable (tools/test_hag_persist.js):
//   HAG_FORMAT, TILE, fnv1a, hash64, cloudFingerprint, datasetKey, gridPrefix,
//   recordId, parseRecordId, pickSnapshot, supersededIds, planEviction,
//   encodeGrid, decodeGridInto, filterProcessed, BinLedger, MarginCache, marginCapture,
//   marginRestore, nodeCovered.
// Browser (IndexedDB 'flex-hag'; every call resolves quietly when IndexedDB is
// not there): listIds, getRecord, putRecord, deleteRecords, clearAll, storeStats.
//
// Nothing here reads a URL or a path: a dataset is a hash of its identity.

export const HAG_FORMAT = 1;     // bump when the stored layout or the binning rules change
export const TILE = 128;         // margin tiles are 128 x 128 cells, on the absolute cell lattice
const NONE = 1e30;               // same sentinel as pointcloud-hag.js (HAG_NONE)
export const GRID_CAP_BYTES = 768 * 1024 * 1024;   // all saved grids together
export const MARGIN_CAP_BYTES = 192 * 1024 * 1024; // margins kept in memory

// ── Keys ─────────────────────────────────────────────────────────────────────

export function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** 64 bits as 16 hex digits (two differently seeded passes). */
export function hash64(str) {
  const a = fnv1a(str), b = fnv1a(str, 0x9747b28c);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const _r = (v, d) => Number.isFinite(v) ? String(Math.round(v * d) / d) : 'x';

/**
 * What identifies one point cloud AS PLACED in the scene: where it comes from, its
 * own bounds and spacing, and its world matrix (the georeferencing). A changed
 * matrix moves every world coordinate, so it changes the fingerprint and the saved
 * grid is simply not found. { id, bbox:[6], tight:[6], spacing, matrix:[16] }
 */
export function cloudFingerprint(c) {
  return [
    String(c.id || ''),
    (c.bbox || []).map(v => _r(v, 100)).join(','),
    (c.tight || []).map(v => _r(v, 100)).join(','),
    _r(c.spacing, 1000),
    (c.matrix || []).map(v => _r(v, 1000)).join(','),
  ].join('|');
}

/** The dataset = the set of clouds that fed the grid (order does not matter). */
export function datasetKey(fingerprints) {
  return hash64([...new Set(fingerprints)].sort().join('\n'));
}

/** Everything but the origin: format, dataset, grid sizes, cell size, envelope radius. */
export function gridPrefix({ ds, cell, env, dimD, dimF }) {
  return `h${HAG_FORMAT}|${ds}|d${dimD}f${dimF}|c${cell}|e${env}|`;
}
export const recordId = (prefix, ox, oy) => `${prefix}${ox}|${oy}`;
export function parseRecordId(id) {
  const p = String(id).split('|');
  if (p.length < 6) return null;
  const ox = Number(p[p.length - 2]), oy = Number(p[p.length - 1]);
  return Number.isFinite(ox) && Number.isFinite(oy) ? { ox, oy } : null;
}

/** Of the saved ids with this prefix, the one whose window holds (cx, cy) best (furthest from its edges). */
export function pickSnapshot(ids, prefix, cx, cy, cov) {
  let best = null, bestMargin = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const o = parseRecordId(id); if (!o) continue;
    const m = Math.min(cx - o.ox, o.ox + cov - cx, cy - o.oy, o.oy + cov - cy);
    if (m > bestMargin) { bestMargin = m; best = id; }
  }
  return best;
}

/** Saved ids with this prefix whose window centre is within a quarter window of the new one: the new snapshot replaces them. */
export function supersededIds(ids, prefix, ox, oy, cov) {
  const out = [];
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const o = parseRecordId(id); if (!o) continue;
    if (Math.abs(o.ox - ox) <= cov / 4 && Math.abs(o.oy - oy) <= cov / 4) out.push(id);
  }
  return out;
}

/**
 * Least-recently-used first, until the total is at or below cap * low.
 * entries: [{ id|key, used, bytes }]. Returns the ids/keys to drop ([] when under cap).
 */
export function planEviction(entries, cap, low = 0.9) {
  let total = 0;
  for (const e of entries) total += e.bytes || 0;
  if (total <= cap) return [];
  const goal = cap * low, out = [];
  const order = entries.slice().sort((a, b) => (a.used || 0) - (b.used || 0));
  for (const e of order) {
    if (total <= goal) break;
    out.push(e.id !== undefined ? e.id : e.key);
    total -= e.bytes || 0;
  }
  return out;
}

// ── Whole-grid snapshot (sparse: only cells that hold anything) ──────────────

/** { dim, cell, ox, oy, n, idx:Uint32Array, g, gx, fb:Float32Array } of g's accumulators. */
export function encodeGrid(g) {
  const n = g.dim * g.dim, G = g.ground, X = g.groundMax, F = g.fallback;
  let c = 0;
  for (let i = 0; i < n; i++) if (G[i] < NONE || X[i] > -NONE || F[i] < NONE) c++;
  const idx = new Uint32Array(c), eg = new Float32Array(c), ex = new Float32Array(c), ef = new Float32Array(c);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (G[i] < NONE || X[i] > -NONE || F[i] < NONE) { idx[k] = i; eg[k] = G[i]; ex[k] = X[i]; ef[k] = F[i]; k++; }
  }
  return { dim: g.dim, cell: g.cell, ox: g.originX, oy: g.originY, n: c, idx, g: eg, gx: ex, fb: ef };
}

/**
 * Put an encoded grid into g (same dim and cell): empties g, sets its origin, scatters
 * the cells. Returns false (g untouched) when the sizes do not match. The caller then
 * repacks (hagRepackGrid) and bumps the texture version.
 */
export function decodeGridInto(g, enc) {
  if (!enc || enc.dim !== g.dim || enc.cell !== g.cell) return false;
  const n = g.dim * g.dim;
  for (let i = 0; i < enc.n; i++) if (enc.idx[i] >= n) return false;
  g.ground.fill(NONE); g.groundMax.fill(-NONE); g.fallback.fill(NONE);
  g.originX = enc.ox; g.originY = enc.oy;
  for (let i = 0; i < enc.n; i++) {
    const k = enc.idx[i];
    g.ground[k] = enc.g[i]; g.groundMax[k] = enc.gx[i]; g.fallback[k] = enc.fb[i];
  }
  return true;
}

/**
 * Which saved nodes can be trusted as already binned: only those whose box lies inside
 * the window of EVERY grid it was saved with (a node reaching past a window had part of
 * its points dropped, so it has to be binned again). processed: [[key,minX,minY,maxX,maxY]].
 */
export function filterProcessed(processed, windows) {
  const out = [];
  for (const p of processed) {
    let inside = true;
    for (const w of windows) if (!(p[1] >= w.minX && p[3] <= w.maxX && p[2] >= w.minY && p[4] <= w.maxY)) { inside = false; break; }
    if (inside) out.push(p);
  }
  return out;
}

// ── Which binning is newer than a copy of a margin ───────────────────────────

/**
 * A counter of binnings. A node's seq says "binned at this point"; a margin copy's seq
 * says "taken at this point". The copy has the node's points when node.seq <= copy.seq.
 * A node that was thrown out of `processed` to be binned again keeps its OLD seq (the
 * points it adds are the same ones), except for a node that was waiting to be binned
 * again when a copy was taken: that copy lacks it, so its seq moves just past the copy.
 */
export class BinLedger {
  constructor() { this.seq = 0; this.pending = new Map(); }
  /** The seq for a node being binned now. */
  next(key) {
    if (this.pending.has(key)) { const s = this.pending.get(key); this.pending.delete(key); return s; }
    return ++this.seq;
  }
  /** A node was thrown out to be binned again. */
  requeued(key, seq) { this.pending.set(key, seq); }
  /** A margin copy is being taken: returns its seq. */
  captured() {
    for (const [k, v] of this.pending) this.pending.set(k, Math.max(v, this.seq + 0.5));
    return this.seq;
  }
  reset() { this.seq = 0; this.pending.clear(); }
}

// ── Margins that scrolled out (in memory) ────────────────────────────────────

const _tk = (label, tx, ty) => `${label}:${tx},${ty}`;
const _abs = g => ({ ax: Math.round(g.originX / g.cell), ay: Math.round(g.originY / g.cell) });
const _tileIn = (tx, ty, ax, ay, dim) =>
  tx * TILE >= ax && (tx + 1) * TILE <= ax + dim && ty * TILE >= ay && (ty + 1) * TILE <= ay + dim;

/** A byte-capped LRU map (Map order = use order). */
export class MarginCache {
  constructor(maxBytes = MARGIN_CAP_BYTES) { this.max = maxBytes; this.map = new Map(); this.bytes = 0; }
  get size() { return this.map.size; }
  has(k) { return this.map.has(k); }
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) {
    const old = this.map.get(k); if (old) { this.bytes -= old.bytes; this.map.delete(k); }
    this.map.set(k, v); this.bytes += v.bytes;
    while (this.bytes > this.max && this.map.size > 1) {
      const first = this.map.keys().next().value; this.bytes -= this.map.get(first).bytes; this.map.delete(first);
    }
  }
  delete(k) { const v = this.map.get(k); if (v) { this.bytes -= v.bytes; this.map.delete(k); } }
  clear(label) {
    if (!label) { this.map.clear(); this.bytes = 0; return; }
    for (const k of [...this.map.keys()]) if (k.startsWith(label + ':')) this.delete(k);
  }
}

/**
 * Call BEFORE a grid is translated to the window at absolute cell origin (newAx, newAy):
 * every tile that lies wholly in the current window and will not be wholly in the new
 * one is copied into the cache. seq = BinLedger.captured(), so a restore can tell
 * which nodes were binned before the copy. Only whole tiles are kept: a half-covered
 * tile would be missing data.
 */
export function marginCapture(cache, label, g, newAx, newAy, seq) {
  const { ax, ay } = _abs(g), dim = g.dim, G = g.ground, X = g.groundMax, F = g.fallback;
  for (let ty = Math.floor(ay / TILE); ty <= Math.floor((ay + dim - 1) / TILE); ty++) {
    for (let tx = Math.floor(ax / TILE); tx <= Math.floor((ax + dim - 1) / TILE); tx++) {
      if (!_tileIn(tx, ty, ax, ay, dim) || _tileIn(tx, ty, newAx, newAy, dim)) continue;
      const lx = tx * TILE - ax, ly = ty * TILE - ay;
      const g1 = new Float32Array(TILE * TILE), g2 = new Float32Array(TILE * TILE), g3 = new Float32Array(TILE * TILE);
      let any = false;
      for (let r = 0; r < TILE; r++) {
        const src = (ly + r) * dim + lx, dst = r * TILE;
        g1.set(G.subarray(src, src + TILE), dst);
        g2.set(X.subarray(src, src + TILE), dst);
        g3.set(F.subarray(src, src + TILE), dst);
      }
      for (let i = 0; i < g1.length; i++) if (g1[i] < NONE || g2[i] > -NONE || g3[i] < NONE) { any = true; break; }
      cache.set(_tk(label, tx, ty), any
        ? { seq, empty: false, g: g1, gx: g2, fb: g3, bytes: g1.byteLength * 3 }
        : { seq, empty: true, bytes: 64 });
    }
  }
}

/**
 * Call AFTER the grid moved (it sits at the new window; oldAx/oldAy is where it was).
 * Tiles now wholly in the window that were not wholly in the old one are merged back
 * from the cache (lowest / highest / lowest, the same as binning would give) and
 * dropped from the cache. Returns { restored: Map(tileKey -> seq), lo, hi, n } where
 * lo / hi bound the heights merged in (for the packing window).
 */
export function marginRestore(cache, label, g, oldAx, oldAy) {
  const { ax, ay } = _abs(g), dim = g.dim;
  const restored = new Map();
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let ty = Math.floor(ay / TILE); ty <= Math.floor((ay + dim - 1) / TILE); ty++) {
    for (let tx = Math.floor(ax / TILE); tx <= Math.floor((ax + dim - 1) / TILE); tx++) {
      if (!_tileIn(tx, ty, ax, ay, dim) || _tileIn(tx, ty, oldAx, oldAy, dim)) continue;
      const key = _tk(label, tx, ty), rec = cache.get(key);
      if (!rec) continue;
      cache.delete(key);
      restored.set(key, rec.seq);
      if (rec.empty) continue;
      const lx = tx * TILE - ax, ly = ty * TILE - ay;
      for (let r = 0; r < TILE; r++) {
        let k = (ly + r) * dim + lx, s = r * TILE;
        for (let c = 0; c < TILE; c++, k++, s++) {
          const a = rec.g[s], b = rec.gx[s], f = rec.fb[s];
          if (a < g.ground[k]) g.ground[k] = a;
          if (b > g.groundMax[k]) g.groundMax[k] = b;
          if (f < g.fallback[k]) g.fallback[k] = f;
          if (a < NONE) { if (a < lo) lo = a; if (a > hi) hi = a; }
          if (b > -NONE) { if (b < lo) lo = b; if (b > hi) hi = b; }
          if (f < NONE) { if (f < lo) lo = f; if (f > hi) hi = f; }
        }
      }
      n++;
    }
  }
  return { restored, lo, hi, n };
}

/**
 * Is everything a node contributed to the (moved) grid already in it? bbox is the node's
 * world rectangle, binSeq the counter value when it was last binned. Every tile the box
 * touches inside the new window must be either wholly in the old window (the cells just
 * travelled with the translation) or restored from a copy taken after the node was binned.
 * Otherwise the node has to be binned again. Conservative: a tile cut by the window edge
 * is never counted as covered.
 */
export function nodeCovered(label, g, oldAx, oldAy, bbox, restored, binSeq) {
  const { ax, ay } = _abs(g), dim = g.dim, c = g.cell;
  const x0 = Math.max(bbox.minX, g.originX), x1 = Math.min(bbox.maxX, g.originX + dim * c);
  const y0 = Math.max(bbox.minY, g.originY), y1 = Math.min(bbox.maxY, g.originY + dim * c);
  if (!(x1 > x0 && y1 > y0)) return true;
  const cx0 = Math.floor(x0 / c), cx1 = Math.ceil(x1 / c) - 1, cy0 = Math.floor(y0 / c), cy1 = Math.ceil(y1 / c) - 1;
  for (let ty = Math.floor(cy0 / TILE); ty <= Math.floor(cy1 / TILE); ty++) {
    for (let tx = Math.floor(cx0 / TILE); tx <= Math.floor(cx1 / TILE); tx++) {
      if (_tileIn(tx, ty, oldAx, oldAy, dim)) continue;
      const seq = restored.get(_tk(label, tx, ty));
      if (seq === undefined || seq < binSeq) return false;
    }
  }
  return true;
}

// ── IndexedDB ('flex-hag'): idx = small rows for listing / LRU, data = the records ──

let _dbP = null;
function _open() {
  if (_dbP) return _dbP;
  _dbP = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const rq = indexedDB.open('flex-hag', 1);
      rq.onupgradeneeded = () => { const d = rq.result; d.createObjectStore('idx', { keyPath: 'id' }); d.createObjectStore('data', { keyPath: 'id' }); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
      rq.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return _dbP;
}
const _req = r => new Promise(res => { r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); });
const _done = tx => new Promise(res => { tx.oncomplete = () => res(true); tx.onerror = tx.onabort = () => res(false); });

export async function listIds(prefix) {
  const db = await _open(); if (!db) return [];
  try {
    const tx = db.transaction('idx', 'readonly');
    return (await _req(tx.objectStore('idx').getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')))) || [];
  } catch (_) { return []; }
}
export async function getRecord(id) {
  const db = await _open(); if (!db) return null;
  try {
    const tx = db.transaction(['idx', 'data'], 'readwrite');
    const rec = await _req(tx.objectStore('data').get(id));
    if (rec) {
      const row = await _req(tx.objectStore('idx').get(id));
      if (row) { row.used = Date.now(); tx.objectStore('idx').put(row); }
    }
    return rec || null;
  } catch (_) { return null; }
}
export async function deleteRecords(ids) {
  const db = await _open(); if (!db || !ids.length) return;
  try {
    const tx = db.transaction(['idx', 'data'], 'readwrite');
    for (const id of ids) { tx.objectStore('idx').delete(id); tx.objectStore('data').delete(id); }
    await _done(tx);
  } catch (_) {}
}
/** Save rec (rec.id, rec.bytes), drop the records it replaces, then trim to the cap, oldest use first. */
export async function putRecord(rec, replaces = [], cap = GRID_CAP_BYTES) {
  const db = await _open(); if (!db) return false;
  try {
    const tx = db.transaction(['idx', 'data'], 'readwrite');
    for (const id of replaces) if (id !== rec.id) { tx.objectStore('idx').delete(id); tx.objectStore('data').delete(id); }
    tx.objectStore('data').put(rec);
    tx.objectStore('idx').put({ id: rec.id, used: Date.now(), bytes: rec.bytes || 0 });
    if (!(await _done(tx))) return false;
    const t2 = db.transaction(['idx', 'data'], 'readwrite');
    const rows = (await _req(t2.objectStore('idx').getAll())) || [];
    for (const id of planEviction(rows, cap)) if (id !== rec.id) { t2.objectStore('idx').delete(id); t2.objectStore('data').delete(id); }
    await _done(t2);
    return true;
  } catch (_) { return false; }
}
export async function clearAll() {
  const db = await _open(); if (!db) return;
  try { const tx = db.transaction(['idx', 'data'], 'readwrite'); tx.objectStore('idx').clear(); tx.objectStore('data').clear(); await _done(tx); } catch (_) {}
}
export async function storeStats() {
  const db = await _open(); if (!db) return { n: 0, bytes: 0 };
  try {
    const rows = (await _req(db.transaction('idx', 'readonly').objectStore('idx').getAll())) || [];
    return { n: rows.length, bytes: rows.reduce((s, r) => s + (r.bytes || 0), 0) };
  } catch (_) { return { n: 0, bytes: 0 }; }
}
