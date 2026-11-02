// The Height-Above-Ground live filter: two ground grids (a fine detail grid and a
// coarse fallback), their packing into RGBA8 textures, the scan that bins the
// streaming octree nodes into them, and the uniforms / define that make
// Potree's shader read them. Moved out of flex.js unchanged (the flex.js
// split, wave 2; see client/src/README.md for the pattern).
//
// Pure exports (no browser, no Potree), node-testable: the HAG_* constants,
// hagMakeGrid, hagFallbackCell, hagExtent, hagTranslate, hagRecount,
// hagAnchor, hagShift, hagOverlaps, hagExposed, hagPct, hagCover, hagWindow,
// hagRepackGrid, hagReadCell.
// Setup:
//   setupPointcloudHag({ potreeViewer }) -> { _hag }
// window._hag, window._hagEnable, _hagSetRange, _hagSetCellSize,
// _hagSetFallback, _hagSetEnvRadius, _hagSetBush, _hagSetBushRange,
// _hagSetDebugColor, _hagDebug and _hagScan are defined here (index.html's
// Point Cloud panel). Read PotreeCopied/FLEX_PATCHES.md and
// ~/flex-docs/04-constraints.md ("two three.js instances") before touching
// how the textures are handed to Potree: they are plain descriptors, never
// THREE.DataTexture.

import {
  HAG_FORMAT, BinLedger, MarginCache, marginCapture, marginRestore, nodeCovered, cloudFingerprint, datasetKey, hash64,
  gridPrefix, recordId, pickSnapshot, supersededIds, encodeGrid, decodeGridInto, filterProcessed,
  listIds, getRecord, putRecord, clearAll as clearGridStore, storeStats as gridStoreStats,
} from "./hag-persist.js";

// ── Height-Above-Ground live filter ──────────────────────────────────────────
//
// Restores the filter removed in bdecc3f0 ("the Z-coordinate mapping between the
// JS ground-grid scan and the GLSL shader could not be reconciled reliably").
// The cause was a coordinate-space mismatch, not anything dataset-specific:
// Potree sets sceneNode.position to each node's boundingBox.min
// (PointCloudOctree.js ~213), so the raw `position` attribute is relative to
// that node's own corner. The old code binned by raw `position` while anchoring
// the grid at pc.pcoGeometry.boundingBox, so points from different nodes landed
// in the same cells and the stored "ground" was physically meaningless. Both
// this scan and the shader now work in WORLD space.
//
// THE RULE: this never drops a point for being classified noise. Class 2 is used
// only to decide where the ground is. Sub-ground returns are the signal here.
// Cells with no ground data pass everything through unfiltered.


// Two grids, two jobs. Keeping them separate is the whole point:
//
//   DETAIL grid   — the terrain reference. Its cell size IS the resolution the
//                   filter measures against, so it is small (0.25-10 m) and set
//                   by the user, exactly like a DEM's cell size. It is fixed at
//                   2048^2 cells, so the area it covers is a CONSEQUENCE of the
//                   cell size, never the other way round.
//   FALLBACK grid — a deliberately coarse, wide-area net so that points far
//                   from the camera still have some ground reference instead of
//                   none. 1024^2 cells at 16x the detail cell, clamped to
//                   4-32 m. It is only ever read where the detail grid has no
//                   data, and it can be switched off.
//
// The earlier version had one grid and derived its cell size from the area it
// had to cover, which is backwards: at a county-wide extent that produced 172 m
// cells, where a single cell spans a hillside and its minimum Z (the valley
// floor) becomes the "ground" for everything above it.
//
// THE RULE: neither grid ever drops a point for being classified noise. Class 2
// decides where the ground is; everything else is only ever measured against
// it. A cell with no ground data filters nothing.


const _HAG_NONE = 1e30;
const _HAG_DETAIL_DIM   = 2048;   // 2048^2: ~50 MB of typed arrays, 16 MB on the GPU
const _HAG_FALLBACK_DIM = 1024;
const _HAG_SHIFT_MS = 1000;        // don't chase the camera faster than this
const _HAG_CELL_MIN = 0.25, _HAG_CELL_MAX = 10;
const _HAG_SPREAD_MAX = 128.0;     // metres the 8-bit spread byte spans
const _HAG_TIME_BUDGET = 14;       // ms of binning per pass
const _HAG_CATCHUP_MS  = 25;       // gap between passes while there is a backlog

function _hagMakeGrid(dim, label) {
  const n = dim * dim;
  return {
    label, dim,
    cell: 1, originX: 0, originY: 0,
    // The ground in a cell is a BAND, not a number. One height per cell is
    // what broke cliffs: a cell straddling a 30 m drop stored the base, so
    // anyone standing on the top read +30 m and was culled. Keeping the class-2
    // minimum and maximum lets the low cutoff measure from the bottom of the
    // local ground and the high cutoff from the top of it.
    ground:    new Float32Array(n).fill(_HAG_NONE),    // lowest class-2 return
    groundMax: new Float32Array(n).fill(-_HAG_NONE),   // highest class-2 return
    fallback:  new Float32Array(n).fill(_HAG_NONE),    // lowest of everything else, only where no class 2
    // RGBA8: RGB are the height as 24 bits, A is provenance —
    // 255 = an actual class-2 return, 128 = the lowest non-ground return in
    // that cell (a guess), 0 = nothing. The shader prefers 255 anywhere over
    // 128 anywhere, which is what stops a canopy-only cell in dense forest
    // from reporting its lowest leaf as the ground.
    upload:   new Uint8Array(n * 4),
    texture:  null,
    filled:   0,        // cells with any height at all
    groundCells: 0,     // subset of those backed by an actual class-2 return
    dirty:    false,
  };
}

/** Coarse cell size for the wide-area net, never fine, never absurd. */
function _hagFallbackCell(detailCell) {
  return Math.max(4, Math.min(32, detailCell * 16));
}

/** World rectangle a grid currently covers. */
function _hagExtent(g) {
  const cov = g.dim * g.cell;
  return { minX: g.originX, minY: g.originY,
           maxX: g.originX + cov, maxY: g.originY + cov,
           cx: g.originX + cov / 2, cy: g.originY + cov / 2 };
}

/**
 * Translate a grid in place by whole cells, clearing only what scrolls in.
 *
 * Because every origin is snapped to the cell lattice, moving the window is a
 * pure array translation: the cells that stay in view keep their accumulated
 * minima and only the newly exposed margin starts empty. Rebuilding from
 * scratch instead meant re-binning every visible point after a few seconds of
 * panning — several seconds during which nothing was filtered and the whole
 * cloud reappeared.
 *
 * Data at cell (x, y) moves to (x - dx, y - dy).
 */
function _hagTranslate(arr, dim, stride, dx, dy, fill) {
  if (Math.abs(dx) >= dim || Math.abs(dy) >= dim) { arr.fill(fill); return; }
  const row = dim * stride;

  // Source rows and columns that survive the move.
  const sy0 = Math.max(0, dy), sy1 = Math.min(dim, dim + dy);
  const sx0 = Math.max(0, dx), sx1 = Math.min(dim, dim + dx);

  if (sy1 > sy0 && sx1 > sx0) {
    // Walk rows away from the destination so an overlapping copy never eats
    // its own source; copyWithin already has memmove semantics within a row.
    const n = sy1 - sy0;
    for (let i = 0; i < n; i++) {
      const sy = dy >= 0 ? sy0 + i : sy1 - 1 - i;
      const ny = sy - dy;
      arr.copyWithin(ny * row + (sx0 - dx) * stride,
                     sy * row + sx0 * stride,
                     sy * row + sx1 * stride);
    }
  }

  // Everything not written above is newly exposed and must start empty.
  const ky0 = Math.max(0, sy0 - dy), ky1 = Math.min(dim, sy1 - dy);
  const kx0 = Math.max(0, sx0 - dx), kx1 = Math.min(dim, sx1 - dx);
  for (let y = 0; y < dim; y++) {
    const base = y * row;
    if (y < ky0 || y >= ky1) { arr.fill(fill, base, base + row); continue; }
    if (kx0 > 0)   arr.fill(fill, base, base + kx0 * stride);
    if (kx1 < dim) arr.fill(fill, base + kx1 * stride, base + row);
  }
}

/** Recount coverage after a translation, from the provenance byte. */
function _hagRecount(g) {
  const u = g.upload;
  let filled = 0, ground = 0;
  for (let t = 3; t < u.length; t += 4) {
    const a = u[t];
    if (a !== 0) { filled++; if (a === 255) ground++; }
  }
  g.filled = filled; g.groundCells = ground;
}

/** Throw a grid away and re-anchor it. Only for the first build and a resolution change. */
function _hagAnchor(g, cell, cx, cy) {
  const cov = g.dim * cell;
  g.cell = cell;
  g.originX = Math.floor((cx - cov / 2) / cell) * cell;
  g.originY = Math.floor((cy - cov / 2) / cell) * cell;
  g.ground.fill(_HAG_NONE);
  g.groundMax.fill(-_HAG_NONE);
  g.fallback.fill(_HAG_NONE);
  g.upload.fill(0);
  g.texture.version++;
  g.filled = 0; g.groundCells = 0;
}

/** Move a grid to sit on (cx, cy), keeping everything still in range. */
function _hagShift(g, cx, cy, hooks) {
  const cov = g.dim * g.cell;
  const nx = Math.floor((cx - cov / 2) / g.cell) * g.cell;
  const ny = Math.floor((cy - cov / 2) / g.cell) * g.cell;
  const dx = Math.round((nx - g.originX) / g.cell);
  const dy = Math.round((ny - g.originY) / g.cell);
  if (dx === 0 && dy === 0) return false;
  const oldOx = g.originX, oldOy = g.originY;
  if (hooks && hooks.before) hooks.before(nx, ny);      // hag-persist.js: keep the margin that is about to leave
  _hagTranslate(g.ground,    g.dim, 1, dx, dy, _HAG_NONE);
  _hagTranslate(g.groundMax, g.dim, 1, dx, dy, -_HAG_NONE);
  _hagTranslate(g.fallback,  g.dim, 1, dx, dy, _HAG_NONE);
  _hagTranslate(g.upload,   g.dim, 4, dx, dy, 0);
  g.originX = nx; g.originY = ny;
  g.texture.version++;
  _hagRecount(g);
  if (hooks && hooks.after) hooks.after(oldOx, oldOy);  // ... and put back what scrolled in again
  return true;
}

const _hagOverlaps = (b, e) =>
  b.maxX > e.minX && b.minX < e.maxX && b.maxY > e.minY && b.minY < e.maxY;

/**
 * The ground a grid covers now that it did not cover before: at most an L of
 * two rectangles. Only nodes touching this have anything new to contribute —
 * everything else travelled with the translation. Testing "not wholly inside
 * the old window" instead would needlessly re-bin every node hanging off the
 * opposite edge.
 */
function _hagExposed(before, after) {
  const ix0 = Math.max(before.minX, after.minX), ix1 = Math.min(before.maxX, after.maxX);
  const iy0 = Math.max(before.minY, after.minY), iy1 = Math.min(before.maxY, after.maxY);
  if (ix1 <= ix0 || iy1 <= iy0) return [after];          // no overlap at all
  const out = [];
  if (after.minX < ix0) out.push({ minX: after.minX, maxX: ix0, minY: after.minY, maxY: after.maxY });
  if (after.maxX > ix1) out.push({ minX: ix1, maxX: after.maxX, minY: after.minY, maxY: after.maxY });
  if (after.minY < iy0) out.push({ minX: ix0, maxX: ix1, minY: after.minY, maxY: iy0 });
  if (after.maxY > iy1) out.push({ minX: ix0, maxX: ix1, minY: iy1, maxY: after.maxY });
  return out;
}

function _hagPct(v, total) {
  const p = v / total * 100;
  return (p > 0 && p < 1) ? p.toFixed(2) : p.toFixed(0);
}
function _hagCover(g) {
  const n = g.dim * g.dim;
  return `${_hagPct(g.groundCells, n)}% ground, ${_hagPct(g.filled - g.groundCells, n)}% est`;
}

/** The 24-bit packing window for an observed height range (see _hagWindowFrom). */
function hagWindow(lo, hi) {
  const pad = Math.max(50, (hi - lo) * 0.25);
  const zMin  = lo - pad;
  const zSpan = Math.max(100, (hi - lo) + 2 * pad);
  return { zMin, zSpan, zInv: 65535 / zSpan };
}

/** Rewrite one grid's texture bytes from its accumulators. Returns nothing; sets filled / groundCells. */
function hagRepackGrid(g, zMin, zSpan) {
  const invLo = 65535 / zSpan, spreadQ = 255 / _HAG_SPREAD_MAX;
  const lo = g.ground, hi = g.groundMax, fb = g.fallback, u = g.upload;
  let filled = 0, ground = 0;
  for (let i = 0; i < lo.length; i++) {
    const t = i * 4;
    let vLo, vHi, prov;
    if (lo[i] < _HAG_NONE)      { vLo = lo[i]; vHi = hi[i] > -_HAG_NONE ? hi[i] : lo[i]; prov = 255; }
    else if (fb[i] < _HAG_NONE) { vLo = fb[i]; vHi = fb[i]; prov = 128; }
    else { u[t] = u[t+1] = u[t+2] = u[t+3] = 0; continue; }
    let q = ((vLo - zMin) * invLo) | 0;
    if (q < 1) q = 1; else if (q > 65535) q = 65535;
    u[t] = (q >>> 8) & 255; u[t+1] = q & 255;
    let sp = vHi - vLo;
    if (sp < 0) sp = 0; else if (sp > _HAG_SPREAD_MAX) sp = _HAG_SPREAD_MAX;
    u[t+2] = (sp * spreadQ) | 0;
    u[t+3] = prov;
    filled++; if (prov === 255) ground++;
  }
  g.filled = filled; g.groundCells = ground;
}

/** Decode the packed cell under a world XY, as the shader does: { z, hi, ground } or null. */
function hagReadCell(g, zMin, zSpan, wx, wy) {
  const cx = ((wx - g.originX) / g.cell) | 0, cy = ((wy - g.originY) / g.cell) | 0;
  if (cx < 0 || cx >= g.dim || cy < 0 || cy >= g.dim) return null;
  const t = (cy * g.dim + cx) * 4;
  const a = g.upload[t+3];
  if (a === 0) return null;
  const q = (g.upload[t] << 8) | g.upload[t+1];
  const lo = zMin + (q / 65535) * zSpan;
  return { z: lo, hi: lo + (g.upload[t+2] / 255) * _HAG_SPREAD_MAX, ground: a > 191 };
}

export {
  _HAG_NONE as HAG_NONE, _HAG_DETAIL_DIM as HAG_DETAIL_DIM, _HAG_FALLBACK_DIM as HAG_FALLBACK_DIM,
  _HAG_SHIFT_MS as HAG_SHIFT_MS, _HAG_CELL_MIN as HAG_CELL_MIN, _HAG_CELL_MAX as HAG_CELL_MAX,
  _HAG_SPREAD_MAX as HAG_SPREAD_MAX, _HAG_TIME_BUDGET as HAG_TIME_BUDGET, _HAG_CATCHUP_MS as HAG_CATCHUP_MS,
  _hagMakeGrid as hagMakeGrid, _hagFallbackCell as hagFallbackCell, _hagExtent as hagExtent,
  _hagTranslate as hagTranslate, _hagRecount as hagRecount, _hagAnchor as hagAnchor, _hagShift as hagShift,
  _hagOverlaps as hagOverlaps, _hagExposed as hagExposed, _hagPct as hagPct, _hagCover as hagCover,
  hagWindow, hagRepackGrid, hagReadCell,
};

export function setupPointcloudHag({ potreeViewer } = {}) {
  const _hag = {
    detail:   null,
    fallbackGrid: null,
    cellSize: 0.5,        // metres — the DETAIL cell size. The user's DEM resolution.
    useFallback: true,
    debugColor: false,
    // The bushwhack highlight: a second band that recolours instead of
    // culling, so it runs with the filter on, off, or on its own.
    bushOn: false,
    bushLo: 1.0, bushHi: 3.0,     // metres, about 3 to 10 ft
    // How far a class-2 return reaches when it defines the local ground, in
    // cells. 0 keeps each cell to its own returns, which fixes clifftops but not
    // undercuts. 2 is the default because it is what holds up in the field: it
    // reaches far enough behind a lip to rescue points under an overhang, and on
    // flat ground the neighbours agree so the band stays closed and nothing
    // changes.
    envRadius: 2,
    zMin: 0, zSpan: 1, zInv: 0,   // shared 24-bit decode window, widened from the data
    obsLo: Infinity, obsHi: -Infinity,
    processed: new Map(),   // node key -> its world bbox, so a shift can re-queue selectively
    enabled: false,
    // A generous default: wide enough to leave real terrain, vegetation and
    // sub-ground features alone, tight enough to drop obvious garbage. Narrow it
    // deliberately rather than starting narrow.
    minHag: -20.0,
    maxHag: 20.0,
    _uploadTimer: null,
    _scan: null,
    _lastShift: 0,
    _catchup: null,
    _pointsSeen: 0,
    // Keeping the grid (hag-persist.js). margins: tiles that scrolled out of the
    // window, kept in memory so panning back does not re-bin. the ledger counts binnings so a
    // restored tile can be compared with the node that was binned (BinLedger). _rev / _savedRev:
    // changed since the last save. _cloudFps: the clouds that fed the grid, as hashes
    // (a cloud whose placement changes mid-session taints the grid: it is not saved).
    margins: new MarginCache(),
    ledger: new BinLedger(),
    _rev: 0, _savedRev: 0, _lastChange: 0, _saving: false,
    _cloudFps: new Map(), _tainted: false,
    _restore: { state: 'idle', rec: null, prefix: '' },
    _srcId: null,
  };

  function _hagCoverage() {
    return {
      detail:   _HAG_DETAIL_DIM   * _hag.cellSize,
      fallback: _HAG_FALLBACK_DIM * _hagFallbackCell(_hag.cellSize),
    };
  }

  // ── Keeping the grid across reloads (hag-persist.js) ────────────────────────
  // Off when Settings has the offline cache off (and in automated browsers unless a
  // test turns it on): offline-cache.js answers.
  const _persistOn = () => !!(typeof window !== 'undefined' && window._offline &&
                              window._offline.gridsOn && window._offline.gridsOn());

  /** A hash of one cloud as placed: where it is from, its bounds and spacing, its world matrix. */
  function _hagFp(pc) {
    const geo = pc.pcoGeometry || {};
    const box = b => b && b.min && b.max ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z] : [];
    return hash64(cloudFingerprint({
      id: geo.url || pc.url || pc.name || '',
      bbox: box(geo.boundingBox || pc.boundingBox), tight: box(geo.tightBoundingBox),
      spacing: geo.spacing, matrix: pc.matrixWorld ? Array.from(pc.matrixWorld.elements) : [],
    }));
  }
  const _hagPrefix = ds => gridPrefix({ ds, cell: _hag.cellSize, env: _hag.envRadius,
                                        dimD: _HAG_DETAIL_DIM, dimF: _HAG_FALLBACK_DIM });
  const _hagVisibleDs = () => {
    const pcs = ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || []).filter(pc => pc.visible);
    return pcs.length ? datasetKey(pcs.map(_hagFp)) : null;
  };

  /** Look for a saved grid of this dataset around the view; resolves into _hag._restore. */
  function _hagStartRestore(view) {
    const ds = _hagVisibleDs();
    const prefix = ds ? _hagPrefix(ds) : '';
    _hag._restore = { state: 'pending', rec: null, prefix };
    const lookup = (async () => {
      if (!prefix) return null;
      const ids = await listIds(prefix);
      const id = pickSnapshot(ids, prefix, view.x, view.y, _HAG_DETAIL_DIM * _hag.cellSize);
      const rec = id ? await getRecord(id) : null;
      return rec && rec.fmt === HAG_FORMAT && rec.det && rec.fb ? rec : null;
    })().catch(() => null);
    const timeout = new Promise(r => setTimeout(() => r(null), 2500));   // never hold the filter up for long
    Promise.race([lookup, timeout]).then(rec => { _hag._restore = { state: 'done', rec, prefix }; });
  }

  /** Build the grids from a saved record instead of empty. False = not usable, build empty. */
  function _hagApplySnapshot(rec) {
    if (!rec || !(rec.obsLo <= rec.obsHi)) return false;
    _hagAlloc();
    const D = _hag.detail, F = _hag.fallbackGrid;
    if (!decodeGridInto(D, rec.det) || !decodeGridInto(F, rec.fb)) return false;
    _hag.margins.clear(); _hag.ledger.reset();
    _hag.processed.clear();
    // A node is trusted as binned only when it lay wholly inside both saved windows.
    for (const p of filterProcessed(rec.processed || [], [_hagExtent(D), _hagExtent(F)]))
      _hag.processed.set(p[0], { minX: p[1], minY: p[2], maxX: p[3], maxY: p[4], seq: 0 });
    _hag._pointsSeen = rec.pts || 0;
    _hag.obsLo = rec.obsLo; _hag.obsHi = rec.obsHi;
    _hagWindowFrom(rec.obsLo, rec.obsHi);
    _hagRepackAll();                       // texture bytes from the accumulators; empty cells stay alpha 0
    _hag._lastShift = performance.now();
    _hag._srcId = rec.id;
    _hag._cloudFps.clear();                // the clouds on screen are the ones the record was found for
    for (const pc of ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || []))
      if (pc.visible) _hag._cloudFps.set(pc.name || '', _hagFp(pc));
    _hag._savedRev = _hag._rev;            // what we just loaded is what is saved
    console.log(`[hag] restored a saved grid: detail ${D.filled.toLocaleString()} cells, ` +
                `${_hag.processed.size} nodes already binned`);
    return true;
  }

  /** Save the grids as they are now (sparse). Quiet on any failure. */
  async function _hagSaveNow() {
    if (!_hag.detail || _hag._saving || _hag._tainted || !_persistOn()) return;
    if (_hag._rev === _hag._savedRev) return;
    const D = _hag.detail, F = _hag.fallbackGrid;
    if (D.filled + F.filled < 1000 || !_hag._cloudFps.size) return;
    _hag._saving = true;
    const rev = _hag._rev;
    try {
      const prefix = _hagPrefix(datasetKey([..._hag._cloudFps.values()]));
      const det = encodeGrid(D), fb = encodeGrid(F);
      const processed = [];
      for (const [k, b] of _hag.processed) processed.push([k, b.minX, b.minY, b.maxX, b.maxY]);
      const rec = {
        id: recordId(prefix, D.originX, D.originY), fmt: HAG_FORMAT, det, fb, processed,
        obsLo: _hag.obsLo, obsHi: _hag.obsHi, pts: _hag._pointsSeen,
        bytes: (det.n + fb.n) * 16 + processed.length * 64, saved: Date.now(),
      };
      const ids = await listIds(prefix);
      const ok = await putRecord(rec, supersededIds(ids, prefix, D.originX, D.originY, _HAG_DETAIL_DIM * D.cell));
      if (ok) { _hag._savedRev = rev; _hag._srcId = rec.id; }
    } catch (_) { /* a failed save only means the next visit starts empty */ }
    _hag._saving = false;
  }

  /**
   * Where the user is actually looking, in world XY.
   *
   * NOT the union of visibleNodes' bounding boxes. The octree root is always
   * visible and its bounding box is the whole EPT dataset — a county for a USGS
   * 3DEP tile. The deepest LOD levels currently streaming are, by construction,
   * the nodes near the camera; their centroid is the region of interest.
   */
  function _hagViewCenter() {
    const pcs = (typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [];
    let deepest = -1;
    const entries = [];
    for (const pc of pcs) {
      if (!pc.visible) continue;
      for (const node of (pc.visibleNodes || [])) {
        if (!node.sceneNode) continue;
        const bb = node.boundingBox || node.geometryNode?.boundingBox;
        if (!bb) continue;
        let lvl = 0;
        if (typeof node.getLevel === 'function') lvl = node.getLevel();
        else if (typeof node.level === 'number') lvl = node.level;
        else if (typeof node.geometryNode?.level === 'number') lvl = node.geometryNode.level;
        entries.push({ bb, lvl, pc });
        if (lvl > deepest) deepest = lvl;
      }
    }
    if (deepest < 0) return null;

    const minLevel = Math.max(0, deepest - 1);
    let sx = 0, sy = 0, n = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of entries) {
      if (e.lvl < minLevel) continue;
      const b = e.bb.clone().applyMatrix4(e.pc.matrixWorld);
      sx += (b.min.x + b.max.x) * 0.5;
      sy += (b.min.y + b.max.y) * 0.5;
      if (b.min.x < x0) x0 = b.min.x;
      if (b.min.y < y0) y0 = b.min.y;
      if (b.max.x > x1) x1 = b.max.x;
      if (b.max.y > y1) y1 = b.max.y;
      n++;
    }
    if (!n) return null;

    // "The deepest nodes are the ones near the camera" holds while something is
    // refining locally. Zoom out past the LOD far cutoff and nothing refines
    // anywhere, so the deepest level is uniform across the whole dataset and its
    // centroid is just the dataset centre - which would anchor the grid miles
    // from what is on screen. When the deepest level is spread wider than the
    // grid could ever cover, trust the camera instead.
    const cov = _HAG_DETAIL_DIM * _hag.cellSize;
    if (Math.max(x1 - x0, y1 - y0) > cov * 2) {
      const cam = (typeof potreeViewer !== 'undefined') &&
                  potreeViewer?.scene?.getActiveCamera?.();
      if (cam && Number.isFinite(cam.position?.x)) {
        return { x: cam.position.x, y: cam.position.y,
                 level: deepest, nodes: n, fromCamera: true };
      }
    }
    return { x: sx / n, y: sy / n, level: deepest, nodes: n };
  }

  /**
   * Allocate once, for the life of the page. Dimensions never change — only the
   * cell size and the origin do — so the typed arrays and the GL textures can be
   * reused. That also avoids leaking a GL texture on every recenter: Potree's
   * renderer caches WebGLTextures in a Map that three.js's dispose() never
   * touches.
   */
  function _hagAlloc() {
    if (_hag.detail) return;
    _hag.detail       = _hagMakeGrid(_HAG_DETAIL_DIM,   'detail');
    _hag.fallbackGrid = _hagMakeGrid(_HAG_FALLBACK_DIM, 'fallback');
    for (const g of [_hag.detail, _hag.fallbackGrid]) {
      // NOT a THREE.DataTexture. Potree's renderer uploads textures through a
      // helper that branches on "instanceof THREE.DataTexture" against the
      // three.js bundled inside potree.js, which is a different module instance
      // from the global three.js this file uses. Every branch missed, texImage2D
      // was never called, and the shader sampled an incomplete texture as
      // (0,0,0,1) -- opaque black, which decodes to the bottom of the height
      // window and reads as perfectly valid ground. The filter measured every
      // point against nothing for four rounds of debugging.
      //
      // A plain descriptor, uploaded by raw GL calls in PotreeRenderer, cannot
      // fail that way. RGBA8 also sidesteps paramThreeToGL, which has no branch
      // for single-channel float formats and throws on them.
      g.texture = { width: g.dim, height: g.dim, data: g.upload, version: 1 };
    }
  }

  /** Build both grids for the first time, or after a resolution change. */
  function _hagReset(cx, cy) {
    _hagAlloc();
    _hagAnchor(_hag.detail,       _hag.cellSize,                    cx, cy);
    _hagAnchor(_hag.fallbackGrid, _hagFallbackCell(_hag.cellSize),  cx, cy);
    _hag.processed.clear();
    _hag.margins.clear(); _hag.ledger.reset();
    _hag._cloudFps.clear(); _hag._tainted = false; _hag._srcId = null;
    _hag._pointsSeen = 0;
    _hag.obsLo = Infinity; _hag.obsHi = -Infinity;   // the pack window itself survives
    _hag._lastShift = performance.now();
    const cov = _hagCoverage();
    console.log(`[hag] detail ${_hag.detail.cell} m x ${_HAG_DETAIL_DIM} = ` +
                `${(cov.detail/1000).toFixed(2)} km · fallback ${_hag.fallbackGrid.cell} m x ` +
                `${_HAG_FALLBACK_DIM} = ${(cov.fallback/1000).toFixed(1)} km`);
  }

  function _hagSetCellSize(v) {
    v = Math.max(_HAG_CELL_MIN, Math.min(_HAG_CELL_MAX, +v || 1));
    if (v === _hag.cellSize) return;
    _hag.cellSize = v;
    if (!_hag.detail) return;         // nothing built yet; the first scan will use it
    // A resolution change cannot be translated, only rebuilt.
    const e = _hagExtent(_hag.detail);
    _hagReset(e.cx, e.cy);
    _hagPushUniforms();
  }

  /**
   * How far a class-2 return reaches when it defines the local ground.
   *
   * 0 keeps every cell to its own returns. That already fixes clifftops, because
   * a cell straddling the lip holds returns from both the top and the base, so
   * its band spans the drop. It does nothing for a cell wholly on the clifftop
   * next to a cell wholly at the base — the undercut case — because neither cell
   * has ever seen the other's ground. Radius 1 lets them borrow from each other.
   *
   * Changing it cannot be applied to what is already accumulated, so this rebuilds.
   */
  function _hagSetEnvRadius(r) {
    r = Math.max(0, Math.min(3, r | 0));
    if (r === _hag.envRadius) return;
    _hag.envRadius = r;
    if (!_hag.detail) return;
    const e = _hagExtent(_hag.detail);
    _hagReset(e.cx, e.cy);
    _hagPushUniforms();
  }

  function _hagSetFallback(on) {
    _hag.useFallback = !!on;
    _hagPushUniforms();
  }

  /**
   * Paint every point by what the filter decided, instead of hiding anything.
   *
   * The filter lives in a vertex shader and a vertex shader cannot be read back,
   * so when it misbehaves there is nothing to inspect — the cloud is simply gone
   * and every uniform looks fine from JS. This turns the shader's own decision
   * into something visible:
   *
   *   white     the uniforms never reached the GPU (upload bug, not a grid bug)
   *   magenta   no ground reference in either grid; the point is passed through
   *   green     inside the band
   *   orange    below the band
   *   blue      above the band
   *   darker    the reference came from the coarse fallback grid
   */
  function _hagSetDebugColor(on) {
    _hag.debugColor = !!on;
    _hagApplyDefine();
  }

  /**
   * The 24-bit packing window, widened from what has actually been binned.
   *
   * An earlier version took this from the octree bounding box so it would be a
   * constant. That is one indirection too many: the window then depends on what
   * Potree means by pcoGeometry.boundingBox for a given loader, and if it does
   * not contain the real heights every packed value clamps to an end of the
   * window and the decoded ground is metres to kilometres wrong — which culls the
   * entire cloud rather than failing quietly. Deriving it from the data cannot be
   * wrong by construction. The padding is generous so widening is rare; each
   * widen costs one full repack.
   */
  function _hagWindowFrom(lo, hi) {
    const w = hagWindow(lo, hi);
    _hag.zMin  = w.zMin;
    _hag.zSpan = w.zSpan;
    _hag.zInv  = w.zInv;
  }

  /** Rewrite both grids' textures from the accumulators. Only on a range change. */
  function _hagRepackAll() {
    if (!_hag.detail) return;
    for (const g of [_hag.detail, _hag.fallbackGrid]) {
      hagRepackGrid(g, _hag.zMin, _hag.zSpan);
      g.texture.version++;
    }
  }

  function _hagScan() {
    const pcs = (typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [];
    if (!pcs.length) return;

    // Nothing reads the grid unless the filter, the highlight or the diagnose
    // colours are on. It used to be maintained regardless, from page load, which
    // cost up to a third of the main thread while a cloud was streaming - and it
    // competed for exactly the frames the point cloud was trying to load in. The
    // trade is that switching a feature on now starts from an empty grid and
    // takes a few seconds of catch-up to fill.
    if (!_hag.enabled && !_hag.bushOn && !_hag.debugColor) return;

    const view = _hagViewCenter();
    if (!view) return;

    if (!_hag.detail) {
      // A saved grid of this dataset around the view is looked up first (async, at
      // most 2.5 s); the first binning waits for the answer.
      if (_persistOn() && _hag._restore.state !== 'done') {
        if (_hag._restore.state === 'idle') _hagStartRestore(view);
        return;
      }
      const rs = _hag._restore;
      _hag._restore = { state: 'idle', rec: null, prefix: '' };
      // The record is used only if what is on screen still has the dataset / cell size
      // / radius it was looked up for.
      const ds = rs.rec && _hagVisibleDs();
      if (!(ds && _hagPrefix(ds) === rs.prefix && _hagApplySnapshot(rs.rec))) _hagReset(view.x, view.y);
      _hagPushUniforms();
    } else if (performance.now() - _hag._lastShift > _HAG_SHIFT_MS) {
      // Each grid follows the view on its own schedule, against its own coverage.
      // The fallback grid is 8-32 km wide, so in practice it almost never moves
      // and keeps answering while the detail grid is refilling its margin.
      const before = [_hagExtent(_hag.detail), _hagExtent(_hag.fallbackGrid)];
      const movedIdx = [];
      const shifts = {};      // grid index -> { oax, oay, restored } for the margin cache
      [_hag.detail, _hag.fallbackGrid].forEach((g, i) => {
        const cov = g.dim * g.cell;
        const e = before[i];
        if (Math.max(Math.abs(view.x - e.cx), Math.abs(view.y - e.cy)) > cov * 0.25 &&
            _hagShift(g, view.x, view.y, {
              before: (nx, ny) => marginCapture(_hag.margins, g.label, g, Math.round(nx / g.cell), Math.round(ny / g.cell), _hag.ledger.captured()),
              after: (ox, oy) => {
                const oax = Math.round(ox / g.cell), oay = Math.round(oy / g.cell);
                shifts[i] = { oax, oay, r: marginRestore(_hag.margins, g.label, g, oax, oay) };
              },
            })) movedIdx.push(i);
      });
      if (movedIdx.length) {
        _hag._rev++; _hag._lastChange = performance.now();
        // Margins that came back from the cache: rebuild the texture bytes of those grids
        // (and the packing window first, if the restored heights fall outside it).
        let widened = false;
        for (const i of movedIdx) {
          const r = shifts[i] && shifts[i].r;
          if (!r || !r.n) continue;
          if (r.lo < _hag.obsLo) _hag.obsLo = r.lo;
          if (r.hi > _hag.obsHi) _hag.obsHi = r.hi;
          if (r.lo < _hag.zMin || r.hi > _hag.zMin + _hag.zSpan) widened = true;
        }
        if (widened) { _hagWindowFrom(_hag.obsLo, _hag.obsHi); _hagRepackAll(); }
        else for (const i of movedIdx) if (shifts[i] && shifts[i].r.n) {
          const g = i ? _hag.fallbackGrid : _hag.detail;
          hagRepackGrid(g, _hag.zMin, _hag.zSpan); g.texture.version++;
        }
        // A node only has to be re-binned if a grid moved over ground it never
        // covered before; everything already accumulated travelled with the
        // translation.
        const after = [_hagExtent(_hag.detail), _hagExtent(_hag.fallbackGrid)];
        const exposed = movedIdx.map(i => _hagExposed(before[i], after[i]));
        let requeued = 0;
        for (const [key, bb] of _hag.processed) {
          for (let m = 0; m < movedIdx.length; m++) {
            if (!exposed[m].some(rect => _hagOverlaps(bb, rect))) continue;
            // Only if its points that fall in the newly covered ground are not already
            // back from the margin cache (copied after the node was binned).
            const i = movedIdx[m], sh = shifts[i];
            if (sh && nodeCovered(i ? 'fallback' : 'detail', i ? _hag.fallbackGrid : _hag.detail,
                                            sh.oax, sh.oay, bb, sh.r.restored, bb.seq || 0)) continue;
            _hag.ledger.requeued(key, bb.seq); _hag.processed.delete(key); requeued++; break;
          }
        }
        _hag._lastShift = performance.now();
        _hagPushUniforms();
        console.log(`[hag] shifted ${movedIdx.map(i => i ? 'fallback' : 'detail').join('+')}` +
                    `, ${requeued} of ${requeued + _hag.processed.size} nodes to re-bin`);
      }
    }

    const D = _hag.detail, F = _hag.fallbackGrid;
    const dDim = D.dim, dCell = D.cell, dox = D.originX, doy = D.originY;
    const fDim = F.dim, fCell = F.cell, fox = F.originX, foy = F.originY;
    const dG = D.ground, dMx = D.groundMax, dF = D.fallback;
    const fG = F.ground, fMx = F.groundMax, fF = F.fallback;
    const winLo = _hag.zMin, winHi = _hag.zMin + _hag.zSpan;
    const invLo = 65535 / _hag.zSpan, spreadQ = 255 / _HAG_SPREAD_MAX;
    const R = _hag.envRadius;

    // Pack one cell: RG = 16-bit low ground, B = how far the ground rises above
    // it inside the envelope, A = provenance. 16 bits over a few hundred metres
    // is ~1 cm, far finer than a threshold needs, and it buys the byte that
    // carries the band. Returns false when the value did not fit the current
    // packing window, which schedules a repack.
    function packCell(g, k) {
      const u = g.upload, t = k * 4;
      const lo = g.ground[k], hiRaw = g.groundMax[k];
      let vLo, vHi, prov;
      if (lo < _HAG_NONE)             { vLo = lo; vHi = hiRaw > -_HAG_NONE ? hiRaw : lo; prov = 255; }
      else if (g.fallback[k] < _HAG_NONE) { vLo = g.fallback[k]; vHi = vLo; prov = 128; }
      else {
        if (u[t+3] !== 0) { g.filled--; if (u[t+3] === 255) g.groundCells--; }
        u[t] = u[t+1] = u[t+2] = u[t+3] = 0; g.dirty = true; return true;
      }
      if (u[t+3] === 0) g.filled++;
      if (prov === 255 && u[t+3] !== 255) g.groundCells++;
      // Never emit 0 for the height. An incomplete WebGL texture samples as
      // (0,0,0,1) -- opaque black that would decode to a plausible ground height.
      // Reserving zero lets the shader tell "never uploaded" from "ground is low".
      let q = ((vLo - winLo) * invLo) | 0;
      if (q < 1) q = 1; else if (q > 65535) q = 65535;
      u[t] = (q >>> 8) & 255; u[t+1] = q & 255;
      let sp = vHi - vLo;
      if (sp < 0) sp = 0; else if (sp > _HAG_SPREAD_MAX) sp = _HAG_SPREAD_MAX;
      u[t+2] = (sp * spreadQ) | 0;
      u[t+3] = prov;
      g.dirty = true;
      return vLo >= winLo && vHi <= winHi;
    }
    let obsLo = _hag.obsLo, obsHi = _hag.obsHi;
    let needRepack = !_hag.zInv;            // no window yet: pack after this pass
    let updated = false;

    // Binning costs roughly 100 ns a point, so a whole visible set arriving at
    // once would be a half-second freeze. Spend a bounded slice of wall clock per
    // pass and come back sooner while there is a backlog: a node is atomic, so
    // the real ceiling is one node past the budget. This is also what makes the
    // grid fill in progressively as a cloud streams rather than all at the end.
    const tStart = performance.now();
    let backlog = false;

    outer:
    for (const pc of pcs) {
      if (!pc.visible) continue;
      for (const node of (pc.visibleNodes || [])) {
        if (performance.now() - tStart > _HAG_TIME_BUDGET) { backlog = true; break outer; }
        if (!node.sceneNode) continue;
        const key = (pc.name || '') + '/' + (node.name || node.id || '?');
        if (_hag.processed.has(key)) continue;
        // The cloud as placed: if it moved since it first fed the grid (georeferencing
        // changed), the grid is a mix and must not be saved.
        {
          const fp = _hagFp(pc), had = _hag._cloudFps.get(pc.name || '');
          if (had === undefined) _hag._cloudFps.set(pc.name || '', fp);
          else if (had !== fp) _hag._tainted = true;
        }

        const geom = node.geometryNode?.geometry || node.geometry;
        const pos = geom?.attributes?.position?.array;
        if (!pos || pos.length < 3) continue;
        const nbb = (node.boundingBox || node.geometryNode?.boundingBox)
          ?.clone().applyMatrix4(pc.matrixWorld);
        const seq = _hag.ledger.next(key);
        _hag.processed.set(key, nbb
          ? { minX: nbb.min.x, minY: nbb.min.y, maxX: nbb.max.x, maxY: nbb.max.y, seq }
          : { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity, seq });
        const cls = geom.attributes?.classification?.array;

        // Node-local -> world. Inlined from matrixWorld.elements: nine multiplies
        // per point and no allocation, which matters at a few million points.
        const e = node.sceneNode.matrixWorld.elements;
        const e0=e[0],e4=e[4],e8=e[8],e12=e[12];
        const e1=e[1],e5=e[5],e9=e[9],e13=e[13];
        const e2=e[2],e6=e[6],e10=e[10],e14=e[14];

        const nPts = pos.length / 3;
        for (let i = 0, o = 0; i < nPts; i++, o += 3) {
          const x = pos[o], y = pos[o+1], z = pos[o+2];
          const wx = e0*x + e4*y + e8*z  + e12;
          const wy = e1*x + e5*y + e9*z  + e13;

          const dx = ((wx - dox) / dCell) | 0;
          const dy = ((wy - doy) / dCell) | 0;
          const fx = ((wx - fox) / fCell) | 0;
          const fy = ((wy - foy) / fCell) | 0;
          const inD = dx >= 0 && dx < dDim && dy >= 0 && dy < dDim;
          const inF = fx >= 0 && fx < fDim && fy >= 0 && fy < fDim;
          if (!inD && !inF) continue;

          const wz = e2*x + e6*y + e10*z + e14;
          _hag._pointsSeen++;

          // Class 2 is authoritative. Everything else only ever writes the
          // per-cell fallback, so a pit's own sub-ground returns can never become
          // the ground reference and hide the pit from the filter.
          const isGround = !!cls && Math.round(cls[i]) === 2;

          // Class 2 widens the ground band of every cell inside the envelope
          // radius. Both ends are monotone -- the low only falls, the high only
          // rises -- so this needs no rescan and never has to shrink.
          if (inD) {
            if (isGround) {
              for (let oy = -R; oy <= R; oy++) {
                const ny = dy + oy; if (ny < 0 || ny >= dDim) continue;
                const rowBase = ny * dDim;
                for (let ox = -R; ox <= R; ox++) {
                  const nx = dx + ox; if (nx < 0 || nx >= dDim) continue;
                  const kk = rowBase + nx;
                  let ch = false;
                  if (wz < dG[kk])  { dG[kk]  = wz; ch = true; }
                  if (wz > dMx[kk]) { dMx[kk] = wz; ch = true; }
                  if (ch) { if (!packCell(D, kk)) needRepack = true; updated = true; }
                }
              }
              if (wz < obsLo) obsLo = wz;
              if (wz > obsHi) obsHi = wz;
            } else {
              const k = dy * dDim + dx;
              if (wz < dF[k]) {
                dF[k] = wz;
                if (dG[k] >= _HAG_NONE) {      // ground, once known, always wins
                  if (!packCell(D, k)) needRepack = true;
                  updated = true;
                  if (wz < obsLo) obsLo = wz;
                  if (wz > obsHi) obsHi = wz;
                }
              }
            }
          }

          if (inF) {
            const k = fy * fDim + fx;
            if (isGround) {
              let ch = false;
              if (wz < fG[k])  { fG[k]  = wz; ch = true; }
              if (wz > fMx[k]) { fMx[k] = wz; ch = true; }
              if (ch) {
                if (!packCell(F, k)) needRepack = true;
                updated = true;
                if (wz < obsLo) obsLo = wz;
                if (wz > obsHi) obsHi = wz;
              }
            } else if (wz < fF[k]) {
              fF[k] = wz;
              if (fG[k] >= _HAG_NONE) {
                if (!packCell(F, k)) needRepack = true;
                updated = true;
                if (wz < obsLo) obsLo = wz;
                if (wz > obsHi) obsHi = wz;
              }
            }
          }
        }
      }
    }

    // Still work queued: come back in 25 ms rather than waiting out the idle
    // interval, so catching up takes a second rather than several.
    if (backlog && !_hag._catchup) {
      _hag._catchup = setTimeout(() => {
        _hag._catchup = null;
        try { _hagScan(); } catch (err) { console.warn('[hag]', err); }
      }, _HAG_CATCHUP_MS);
    }

    _hag.obsLo = obsLo; _hag.obsHi = obsHi;
    if (updated) { _hag._rev++; _hag._lastChange = performance.now(); }
    // Quiet for 8 s and nothing waiting to be binned: keep the grid for the next visit.
    if (!backlog && _hag._rev !== _hag._savedRev && performance.now() - _hag._lastChange > 8000) _hagSaveNow();
    if (needRepack && obsLo <= obsHi) {
      _hagWindowFrom(obsLo, obsHi);
      _hagRepackAll();
      _hagPushUniforms();                   // the decode uniform must move with it
      console.log(`[hag] pack window ${_hag.zMin.toFixed(1)} .. ` +
                  `${(_hag.zMin + _hag.zSpan).toFixed(1)} m (observed ` +
                  `${obsLo.toFixed(1)} .. ${obsHi.toFixed(1)})`);
    }

    // Uploading a 16 MB texture is the expensive part now, so coalesce: one
    // upload per idle window no matter how many nodes landed.
    if (updated && !_hag._uploadTimer) {
      _hag._uploadTimer = setTimeout(() => {
        _hag._uploadTimer = null;
        // Re-uploading a 16 MB texture that did not change is pure bus traffic;
        // the coarse grid in particular settles after the first few nodes.
        for (const g of [_hag.detail, _hag.fallbackGrid]) {
          if (g.dirty) { g.texture.version++; g.dirty = false; }
        }
        _hagPushUniforms();
        _hagUpdateStats();
      }, 250);
    }
  }

  /**
   * The bundle and flex.js are separate downloads and the browser caches the
   * 2.4 MB bundle hard, so it is entirely possible to be running new JS against
   * an old shader — which looks exactly like a logic bug and has wasted a lot of
   * time. uHagDebug is the newest uniform; if a loaded cloud's material has no
   * idea what that is, the bundle on the page predates the shader this JS talks
   * to. Say so instead of letting it look like a filter problem.
   */
  function _hagBundleStale() {
    for (const pc of ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [])) {
      const u = pc.material?.uniforms;
      if (u && u.uGroundTex && !u.uHagDebug) return true;
    }
    return false;
  }

  function _hagUpdateStats() {
    const el = document.getElementById('lp-hag-stats');
    if (!el) return;
    if (_hagBundleStale()) {
      el.innerHTML = '<span style="color:#ff6b6b;">Potree bundle is out of date &mdash; ' +
                     'hard-reload with Ctrl+Shift+R. The filter will not work until you do.</span>';
      return;
    }
    if (!_hag.detail) return;
    const cov = _hagCoverage();
    const D = _hag.detail, F = _hag.fallbackGrid;
    let txt = `detail ${D.cell} m · ${(cov.detail/1000).toFixed(2)} km · ${_hagCover(D)}`;
    txt += _hag.useFallback
      ? ` | fallback ${F.cell} m · ${(cov.fallback/1000).toFixed(1)} km · ${_hagCover(F)}`
      : ' | fallback off';
    txt += ` | ${_hag._pointsSeen.toLocaleString()} pts binned`;
    el.textContent = txt;

    const win = document.getElementById('lp-hag-window');
    if (win) win.textContent =
      `${_HAG_DETAIL_DIM}×${_HAG_DETAIL_DIM} cells = ${(cov.detail/1000).toFixed(2)} km across`;
    const fb = document.getElementById('lp-hag-fallback-note');
    if (fb) fb.textContent =
      `${_hagFallbackCell(_hag.cellSize)} m cells over ${(cov.fallback/1000).toFixed(1)} km`;
  }

  function _hagPushUniforms() {
    if (!_hag.detail) return;
    const D = _hag.detail, F = _hag.fallbackGrid;
    for (const pc of ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [])) {
      const u = pc.material?.uniforms;
      if (!u || !u.uGroundTex) continue;
      u.uGroundTex.value       = D.texture;
      u.uGroundOrigin.value    = [D.originX, D.originY];
      u.uGroundCellSize.value  = D.cell;
      u.uGroundTexSize.value   = [D.dim, D.dim];
      u.uGroundZRange.value    = [_hag.zMin, _hag.zSpan];
      u.uHagRange.value        = [_hag.minHag, _hag.maxHag];
      // Fallback grid. Its XY is reached from the detail grid's by a small shift
      // rather than a second model matrix: both origins are known here in float64
      // and their difference is at most half the fallback coverage, so it casts to
      // float32 losslessly enough (sub-millimetre at 16 km).
      // The texture stays bound either way; a null sampler would read whatever is
      // on texture unit 0. The flag is what turns the second lookup off.
      u.uGroundTexC.value        = F.texture;
      u.uGroundFallbackOn.value  = _hag.useFallback ? 1.0 : 0.0;
      u.uGroundCellSizeC.value = F.cell;
      u.uGroundTexSizeC.value  = [F.dim, F.dim];
      u.uGroundShiftC.value    = [D.originX - F.originX, D.originY - F.originY];
      if (u.uHagDebug) u.uHagDebug.value = _hag.debugColor ? 1.0 : 0.0;
      if (u.uGroundSpreadMax) u.uGroundSpreadMax.value = _HAG_SPREAD_MAX;
      if (u.uHagCull)   u.uHagCull.value   = _hag.enabled ? 1.0 : 0.0;
      if (u.uBushOn)    u.uBushOn.value    = _hag.bushOn  ? 1.0 : 0.0;
      if (u.uBushRange) u.uBushRange.value = [_hag.bushLo, _hag.bushHi];
      // Point clouds can finish loading long after the checkbox was ticked, and
      // the grid may not have existed when it was. Re-assert the define here so
      // enabling the filter never depends on the order those two happen in.
      if ((_hag.enabled || _hag.bushOn || _hag.debugColor) && pc.material.defines &&
          !pc.material.defines.get('clip_hag_enabled')) {
        pc.material.setDefine('clip_hag_enabled', '#define clip_hag_enabled');
      }
    }
  }

  /**
   * Compile the ground-grid machinery in or out.
   *
   * The define no longer means "filter". Three separate things need it — the
   * keep-band, the bushwhack highlight and the diagnose colours — and any of
   * them can run without the others, so whether points are actually culled is
   * uHagCull, not the define. Recompiling costs a shader link, so this only
   * touches a material whose state is wrong.
   */
  function _hagApplyDefine() {
    const want = !!_hag.detail && (_hag.enabled || _hag.bushOn || _hag.debugColor);
    for (const pc of ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [])) {
      if (!pc.material) continue;
      const has = !!pc.material.defines?.get('clip_hag_enabled');
      if (want && !has) {
        // Only switch it on once a texture exists: an unbound sampler reads
        // whatever is on texture unit 0, which would behave unpredictably.
        pc.material.setDefine('clip_hag_enabled', '#define clip_hag_enabled');
      } else if (!want && has) {
        pc.material.removeDefine('clip_hag_enabled');
        pc.material.updateShaderSource();
      }
    }
    if (want) _hagPushUniforms();
  }

  function _hagEnable(on) {
    _hag.enabled = !!on;
    _hagApplyDefine();
  }

  /** Paint points sitting 0.3-1.5 m over the ground. A display mode, not a filter. */
  function _hagSetBush(on) {
    _hag.bushOn = !!on;
    _hagApplyDefine();
  }

  function _hagSetBushRange(lo, hi) {
    _hag.bushLo = lo; _hag.bushHi = hi;
    _hagPushUniforms();
  }

  function _hagSetRange(min, max) {
    _hag.minHag = min; _hag.maxHag = max;
    if (_hag.enabled) _hagPushUniforms();
  }

  /**
   * One-call diagnosis from the console. The GPU side cannot be read back, so
   * this prints the JS state and recomputes HAG for real points exactly the way
   * the shader does. If these numbers look right and the view still does not
   * change, the problem is the define or the uniform upload, not the grids.
   */
  function _hagDebug() {
    const pcs = (typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || [];
    const cov = _hagCoverage();
    const D = _hag.detail, F = _hag.fallbackGrid;
    const out = {
      enabled: _hag.enabled,
      detailCell: D?.cell, detailCoverageM: cov.detail, detailCover: D ? _hagCover(D) : null,
      cullOn: _hag.enabled,
      bushOn: _hag.bushOn,
      bushRange: [_hag.bushLo, _hag.bushHi],
      fallbackOn: _hag.useFallback,
      envRadius: _hag.envRadius,
      fallbackCell: F?.cell, fallbackCoverageM: cov.fallback, fallbackCover: F ? _hagCover(F) : null,
      detailExtent: D ? _hagExtent(D) : null,
      packWindow: [_hag.zMin, _hag.zMin + _hag.zSpan],
      observedZ: [_hag.obsLo, _hag.obsHi],
      windowContainsData: _hag.obsLo >= _hag.zMin && _hag.obsHi <= _hag.zMin + _hag.zSpan,
      range: [_hag.minHag, _hag.maxHag],
      pointsBinned: _hag._pointsSeen,
      defineOn: pcs.map(pc => !!pc.material?.defines?.get('clip_hag_enabled')),
      uniformsPresent: pcs.map(pc => !!pc.material?.uniforms?.uGroundTex),
      texBound: pcs.map(pc => pc.material?.uniforms?.uGroundTex?.value === D?.texture),
    };
    console.log(out);
    if (!D) return out;

    // Same preference order as the shader: a real class-2 return anywhere beats
    // an estimate anywhere, and only then is the finer grid preferred.
    const read = (g, wx, wy) => hagReadCell(g, _hag.zMin, _hag.zSpan, wx, wy);
    const lookup = (wx, wy) => {
      const d = read(D, wx, wy);
      const c = _hag.useFallback ? read(F, wx, wy) : null;
      if (d && d.ground) return { ...d, src: 'detail/ground' };
      if (c && c.ground) return { ...c, src: 'fallback/ground' };
      if (d)             return { ...d, src: 'detail/est' };
      if (c)             return { ...c, src: 'fallback/est' };
      return null;
    };

    const samples = [];
    outer:
    for (const pc of pcs) {
      for (const node of (pc.visibleNodes || [])) {
        const geom = node.geometryNode?.geometry || node.geometry;
        const pos = geom?.attributes?.position?.array;
        if (!pos) continue;
        const cls = geom.attributes?.classification?.array;
        const e = node.sceneNode.matrixWorld.elements;
        const n = pos.length / 3;
        for (let i = 0; i < n && samples.length < 12; i += Math.max(1, (n / 40) | 0)) {
          const o = i * 3, x = pos[o], y = pos[o+1], z = pos[o+2];
          const wx = e[0]*x + e[4]*y + e[8]*z  + e[12];
          const wy = e[1]*x + e[5]*y + e[9]*z  + e[13];
          const wz = e[2]*x + e[6]*y + e[10]*z + e[14];
          const hit = lookup(wx, wy);
          samples.push({
            cls: cls ? Math.round(cls[i]) : '?',
            z: +wz.toFixed(2),
            source: hit ? hit.src : 'none',
            groundLo: hit ? +hit.z.toFixed(2) : null,
            band: hit ? +(hit.hi - hit.z).toFixed(2) : null,
            hag: hit ? +(wz - hit.z).toFixed(2) : null,
            kept: !hit || (wz - hit.z >= _hag.minHag && wz - hit.hi <= _hag.maxHag),
          });
          if (samples.length >= 12) break outer;
        }
      }
    }
    console.log('sample points, as the shader sees them:');
    (console.table || console.log)(samples);
    return out;
  }

  // Self-initialising: no hook into addPC, so nothing in the existing load path
  // changes. The first tick that sees visible nodes builds the grids.
  if (typeof window !== 'undefined') {
    window._hag = _hag;
    window._hagEnable = _hagEnable;
    window._hagSetRange = _hagSetRange;
    window._hagSetCellSize = _hagSetCellSize;
    window._hagSetFallback = _hagSetFallback;
    window._hagSetEnvRadius = _hagSetEnvRadius;
    window._hagSetBush = _hagSetBush;
    window._hagSetBushRange = _hagSetBushRange;
    window._hagSetDebugColor = _hagSetDebugColor;
    window._hagDebug = _hagDebug;
    window._hagScan = _hagScan;
    // The saved grids (hag-persist.js): Settings' "Clear cached map data" empties them.
    window._hagStore = { clearAll: clearGridStore, stats: gridStoreStats, saveNow: _hagSaveNow };
    const _saveOnHide = () => { if (document.visibilityState === 'hidden') _hagSaveNow(); };
    document.addEventListener('visibilitychange', _saveOnHide);
    window.addEventListener('pagehide', () => _hagSaveNow());
    if (!_hag._scan) _hag._scan = setInterval(() => { try { _hagScan(); } catch (err) { console.warn('[hag]', err); } }, 250);
  }

  return { _hag };
}
