// Splat mode [beta] (📊 LiDAR → Splat mode): the ground of a streamed point cloud drawn as soft discs lying on the
// ground, coloured from a map layer; the other points as dots, normal, coloured by height, or hidden. Visual only:
// nothing is written, nothing in the cloud is changed, and off is exactly the usual drawing (the shader code is not
// even compiled in: the `splat_enabled` define is added to the Potree material only while it is on).
//
// How it works (the shaders are PotreeCopied/src/materials/shaders/pointcloud.vs doSplat(), pointcloud.fs and edl.fs,
// edit 7 in PotreeCopied/FLEX_PATCHES.md):
//   ground     class 2, plus any point within `band` metres of the height-above-ground grid (pointcloud-hag.js keeps
//              filling that grid while Splat mode holds it, even with the height filter off).
//   normal     from the slope of that grid at the point.
//   disc       one point sprite per ground point, `fill` x node spacing wide (capped at `maxWorld` metres and `maxPx`
//              pixels); the fragment shader intersects the pixel's ray with the disc's plane, so the disc is an ellipse
//              that follows the slope, and writes the true depth there. The soft edge is stochastic discard.
//   opacity    the ground is drawn opaque (so overlapping discs never darken each other) and flagged in the EDL pass's
//              log-depth channel; the EDL pass then writes it with the layer's alpha and the canvas is composited over
//              the globe: real translucency, smooth at any opacity. `edge` scales the EDL darkening between two ground
//              pixels (the halo around discs).
//   colour     an ATLAS of the imagery layer, filled tile by tile on camera stops: a 2048 x 2048 texture of 8 x 8 tile
//              slots (4 x 4 for 512 px tiles) used as a ring (tile x, y lives in slot x mod 8, y mod 8), so panning
//              only uploads the tiles that scroll in, one texSubImage2D each, a few a frame, and nothing is resampled
//              on the CPU. The shader maps a ground position to an atlas pixel with a bilinear fit of the layer's
//              projection (fitted here, from a few proj4 calls, in cloud coordinates). Tiles come from the layer's
//              ImageryProvider.requestImage(x, y, level) and are kept in an LRU cache. Outside the window, or while a
//              tile loads: the point's own colour.
//   orientation requestImage() returns an ImageBitmap decoded with flipY for most providers (Cesium's
//              ImageryProvider.loadImage); drawing one as it is gives upside-down imagery, so bitmaps are drawn flipped.
//
// Pure exports (no browser), node-testable by tools/test_splat_mode.js:
//   SPLAT_DEFAULTS, OTHER_MODES, sanitize(raw), pickLayerIndex(names), mercY, tileFraction, metresPerTilePixel,
//   chooseLevel, viewRect, fitBilinear, atlasLevel, windowTiles, slotOf
// Setup:
//   setupSplatMode({ Cesium, proj4, potreeViewer, cesiumViewer, hag }) -> { get, set, enable, apply, mosaic, ... }
//   window._splat is that object.

export const SPLAT_DEFAULTS = {
  on: false, fill: 1.6, maxPx: 64, maxWorld: 6, opacity: 1, band: 0.3,
  edge: 0.3,               // 0 = no EDL darkening between ground discs, 1 = as the rest of the cloud
  above: 'dots',           // other points above the ground band
  below: 'red',            // other points below it
  layer: '',               // an imagery layer's name; '' = the satellite / current base map; 'none' = the point's own colour
  shade: true,             // soft hillshade from the slope
};
// what the shader's mode numbers mean (uSplatQ.y / .z)
export const OTHER_MODES = { hidden: 0, dots: 1, normal: 2, height: 3, red: 4 };

const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : undefined;
export function sanitize(raw) {
  const o = {};
  if (!raw || typeof raw !== 'object') return o;
  const put = (k, v) => { if (v !== undefined) o[k] = v; };
  put('on', typeof raw.on === 'boolean' ? raw.on : undefined);
  put('fill', num(raw.fill, 0.3, 4));
  put('maxPx', num(raw.maxPx, 3, 128));
  put('maxWorld', num(raw.maxWorld, 0.2, 30));
  put('opacity', num(raw.opacity, 0.05, 1));
  put('band', num(raw.band, 0, 3));
  put('edge', num(raw.edge, 0, 1));
  const mode = v => (typeof v === 'string' && v in OTHER_MODES) ? v : undefined;
  put('above', mode(raw.above !== undefined ? raw.above : raw.other));     // "other" was the one dropdown of the first version
  put('below', mode(raw.below));
  put('layer', typeof raw.layer === 'string' && raw.layer.length < 200 ? raw.layer : undefined);
  put('shade', typeof raw.shade === 'boolean' ? raw.shade : undefined);
  return o;
}

/** The default colour layer: a satellite / aerial one if there is one, else the first. names = layer names, in stack order. */
export function pickLayerIndex(names) {
  const i = names.findIndex(n => /aerial|satellite|imagery|sentinel|ortho/i.test(n || ''));
  return i >= 0 ? i : (names.length ? 0 : -1);
}

export const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat / 2));

/**
 * Fractional tile position of a longitude / latitude (radians) at a level, for a tiling scheme described by plain
 * numbers: { merc, west, east, south, north (radians), nx0, ny0 (root tiles) }.
 * Returns { fx, fy } in tile units (fy counted from the north edge).
 */
export function tileFraction(s, lon, lat, level) {
  const nx = s.nx0 * Math.pow(2, level), ny = s.ny0 * Math.pow(2, level);
  const u = (lon - s.west) / (s.east - s.west);
  const v = s.merc ? (mercY(s.north) - mercY(lat)) / (mercY(s.north) - mercY(s.south)) : (s.north - lat) / (s.north - s.south);
  return { fx: u * nx, fy: v * ny };
}

/** Ground metres across one tile pixel at `level` and latitude (radians). */
export function metresPerTilePixel(s, level, lat, tileWidth) {
  return (s.east - s.west) * 6378137 * Math.cos(lat) / (s.nx0 * Math.pow(2, level) * tileWidth);
}

/**
 * The imagery level for a texel size: the coarsest level that is at least as fine as the texel, within the provider's
 * limits and a tile budget (`tilesAt(level)` -> count).
 */
export function chooseLevel({ scheme, texel, lat, tileWidth, minLevel = 0, maxLevel = 19, tilesAt, maxTiles = 36 }) {
  let L = minLevel;
  while (L < maxLevel && metresPerTilePixel(scheme, L, lat, tileWidth) > texel) L++;
  if (tilesAt) while (L > minLevel && tilesAt(L) > maxTiles) L--;
  return L;
}

/**
 * The square (in cloud coordinates) the colour has to cover: around the finest visible nodes. boxes = [{x0,y0,x1,y1,level}].
 * Returns { cx, cy, side } or null.
 */
export function viewRect(boxes, { minSide = 60, maxSide = 3000, margin = 1.25, levelSpan = 1 } = {}) {
  if (!boxes || !boxes.length) return null;
  let deepest = -1;
  for (const b of boxes) if (b.level > deepest) deepest = b.level;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (b.level < deepest - levelSpan) continue;
    if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0; if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
  }
  if (!(x1 > x0)) return null;
  const side = Math.min(maxSide, Math.max(minSide, Math.max(x1 - x0, y1 - y0) * margin));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, side };
}

/**
 * Least-squares fit of v = a0 + a1*x + a2*y + a3*x*y to samples. xs, ys, vs: arrays. Returns [a0, a1, a2, a3].
 * (x, y are metres from the window centre, v is atlas pixels: a few km of any map projection is straight enough that
 * the cross term takes up the curvature to well under a pixel.)
 */
export function fitBilinear(xs, ys, vs) {
  const n = xs.length, A = Array.from({ length: 4 }, () => new Float64Array(5));
  for (let k = 0; k < n; k++) {
    const r = [1, xs[k], ys[k], xs[k] * ys[k]];
    for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) A[i][j] += r[i] * r[j]; A[i][4] += r[i] * vs[k]; }
  }
  for (let c = 0; c < 4; c++) {                       // Gaussian elimination with pivoting
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < 4; r++) { const f = A[r][c] / A[c][c]; for (let j = c; j < 5; j++) A[r][j] -= f * A[c][j]; }
  }
  const a = [0, 0, 0, 0];
  for (let i = 3; i >= 0; i--) { let t = A[i][4]; for (let j = i + 1; j < 4; j++) t -= A[i][j] * a[j]; a[i] = t / A[i][i]; }
  return a;
}

/**
 * The imagery level for an atlas window: the finest level (within the provider's limits) whose window of
 * (N - 1) tiles still covers `side` metres.  tileMetres(L) = ground metres across one tile at level L.
 */
export function atlasLevel({ side, N, tileMetres, minLevel = 0, maxLevel = 19 }) {
  let L = maxLevel;
  while (L > minLevel && (N - 1) * tileMetres(L) < side) L--;
  return L;
}

/** The N x N tiles of a window whose middle is the tile position (fx, fy): { x0, y0, N }. */
export function windowTiles(fx, fy, N) { return { x0: Math.floor(fx - N / 2 + 0.5), y0: Math.floor(fy - N / 2 + 0.5), N }; }
/** The ring slot of a tile. */
export function slotOf(tx, ty, N) { return { sx: ((tx % N) + N) % N, sy: ((ty % N) + N) % N }; }

const KEY = 'flex.splat';
const ATLAS = 2048;

export function setupSplatMode({ Cesium, proj4, potreeViewer, cesiumViewer, hag, storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const load = () => { try { return sanitize(JSON.parse(store.getItem(KEY))); } catch (_) { return {}; } };
  const save = () => { try { store.setItem(KEY, JSON.stringify(opts)); } catch (_) {} };
  let opts = { ...SPLAT_DEFAULTS, ...load() };

  // the atlas and what the shader is told about it
  const at = {
    desc: { size: ATLAS, sub: [] },        // the plain descriptor PotreeRenderer uploads (sub = tiles waiting for texSubImage2D)
    cur: null,                             // the mapping in use: { Cx, Cy, ctr: [x, y], win: [..4], rect: {cx, cy, side} }
    pending: null,                         // a new mapping, applied once the tile uploads it needs are through
    slotKey: {},                           // slot "sx,sy" -> the tile key last queued into it
    layerName: null, level: null, texel: 0, err: '', ms: 0, slot: 256, N: 8, win: null, _count: null,
  };
  const cache = new Map();                 // tile key -> canvas (LRU)
  const CACHE_MAX = 400;
  const inflight = new Map();              // tile key -> true
  const layerIds = new WeakMap(); let layerSeq = 0;
  let lastMove = 0, timer = null, ui = null, fetching = 0;
  const fetchQ = [];

  const pcs = () => (potreeViewer && potreeViewer.scene && potreeViewer.scene.pointclouds) || [];

  // ---- material ------------------------------------------------------------------------------------------------
  const uniformsFor = pc => { const u = pc.material && pc.material.uniforms; return u && u.uSplatP ? u : null; };
  function pushUniforms() {
    const q = [opts.maxWorld, OTHER_MODES[opts.above], OTHER_MODES[opts.below], 0];
    for (const pc of pcs()) {
      const u = uniformsFor(pc); if (!u) continue;
      u.uSplatP.value = [opts.fill, opts.maxPx, opts.band, opts.opacity];
      u.uSplatQ.value = q;
      u.uSplatShade.value = opts.shade ? 1 : 0;
      u.uSplatColTex.value = opts.on ? at.desc : null;
      u.uSplatColOn.value = opts.on && at.cur ? 1 : 0;
      if (at.cur) { u.uSplatCx.value = at.cur.Cx; u.uSplatCy.value = at.cur.Cy; u.uSplatCtr.value = at.cur.ctr; u.uSplatWin.value = at.cur.win; }
    }
    // the layer opacity and the edge shading are applied by the EDL pass
    if (potreeViewer) potreeViewer.flexSplat = opts.on ? { edge: opts.edge, opacity: opts.opacity } : null;
  }
  function applyDefine(pc) {
    const m = pc.material; if (!m || !m.defines) return;
    const has = !!m.defines.get('splat_enabled');
    if (opts.on && !has) m.setDefine('splat_enabled', '#define splat_enabled');
    else if (!opts.on && has) { m.removeDefine('splat_enabled'); m.updateShaderSource(); }
  }
  function apply() {
    if (hag && hag.hold) hag.hold('splat', opts.on);
    for (const pc of pcs()) applyDefine(pc);
    pushUniforms();
  }

  // ---- imagery -------------------------------------------------------------------------------------------------
  function layerList() {
    const L = cesiumViewer && cesiumViewer.imageryLayers, out = [];
    if (!L) return out;
    for (let i = 0; i < L.length; i++) { const l = L.get(i); out.push({ i, name: l.name || ('Layer ' + (i + 1)), show: l.show, layer: l }); }
    return out;
  }
  function chosenLayer() {
    if (opts.layer === 'none') return null;
    const list = layerList();
    if (opts.layer) { const f = list.find(l => l.name === opts.layer); if (f) return f; }
    const k = pickLayerIndex(list.map(l => l.name));
    return k >= 0 ? list[k] : null;
  }
  const idOf = layer => { if (!layerIds.has(layer)) layerIds.set(layer, ++layerSeq); return layerIds.get(layer); };
  const schemeOf = prov => {
    const ts = prov.tilingScheme, r = ts.rectangle;
    return { merc: ts instanceof Cesium.WebMercatorTilingScheme, west: r.west, east: r.east, south: r.south, north: r.north,
      nx0: ts.getNumberOfXTilesAtLevel(0), ny0: ts.getNumberOfYTilesAtLevel(0) };
  };

  /** The nodes in view, in the first visible cloud's coordinates (its world matrix is only a z shift). */
  function viewBoxes() {
    const out = [];
    for (const pc of pcs()) {
      if (!pc.visible) continue;
      for (const node of (pc.visibleNodes || [])) {
        const bb = node.boundingBox || (node.geometryNode && node.geometryNode.boundingBox);
        if (!bb || !node.sceneNode) continue;
        let level = 0;
        if (typeof node.getLevel === 'function') level = node.getLevel();
        else if (typeof node.level === 'number') level = node.level;
        const b = bb.clone().applyMatrix4(pc.matrixWorld);
        out.push({ x0: b.min.x, y0: b.min.y, x1: b.max.x, y1: b.max.y, level, pc });
      }
    }
    return out;
  }

  function toLonLat(pc) {
    let src = pc && pc.projection;
    if (!src) src = proj4.defs('EPSG:3857');
    const f = proj4(src, proj4.defs('WGS84'));
    const D = Math.PI / 180;
    return (x, y) => { const p = f.forward([x, y]); return [p[0] * D, p[1] * D]; };
  }

  // ---- tiles: fetch, draw (right way up), cache, queue for upload ------------------------------------------------
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const isBitmap = img => typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap;
  function cachePut(k, cv) { cache.delete(k); cache.set(k, cv); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
  function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
  let blankCv = null;
  const blank = slot => { if (!blankCv || blankCv.width !== slot) { blankCv = document.createElement('canvas'); blankCv.width = blankCv.height = slot; } return blankCv; };

  /** Draw a provider image into a slot-sized canvas, upright. A bitmap from requestImage comes decoded with flipY. */
  function drawUpright(img, slot) {
    const cv = document.createElement('canvas'); cv.width = cv.height = slot;
    const g = cv.getContext('2d');
    if (isBitmap(img)) { g.translate(0, slot); g.scale(1, -1); }
    g.drawImage(img, 0, 0, slot, slot);
    return cv;
  }
  const singleImages = new Map();      // layer id -> promise of the whole image, upright
  function singleImage(prov, lid) {
    if (!singleImages.has(lid)) singleImages.set(lid, (async () => {
      const img = await withTimeout(Promise.resolve(prov.requestImage(0, 0, 0)), 20000);
      if (!img) throw new Error('no image');
      const w = img.width, h = img.height, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d'); if (isBitmap(img)) { g.translate(0, h); g.scale(1, -1); } g.drawImage(img, 0, 0);
      return cv;
    })());
    return singleImages.get(lid);
  }
  const enqueueUpload = (sx, sy, src, slot) => { at.desc.sub.push({ x: sx * slot, y: sy * slot, src }); };

  function pumpFetch() {
    while (fetching < 6 && fetchQ.length) {
      const job = fetchQ.shift();
      if (job.win !== at.win) { inflight.delete(job.tk); continue; }          // the window moved on
      fetching++;
      job.run().catch(() => {}).then(() => { fetching--; pumpFetch(); });
    }
  }

  // ---- the window: which tiles the atlas holds, and the fit of the map into it -----------------------------------
  /** Work out the window, queue what the atlas needs, and (when its uploads are through) switch the mapping. */
  async function mosaic(force) {
    if (!opts.on) return status();
    const found = chosenLayer();
    if (!found) { at.cur = null; at.layerName = null; at.err = opts.layer === 'none' ? '' : 'no map layer'; pushUniforms(); return status(); }
    const boxes = viewBoxes();
    const r = viewRect(boxes);
    if (!r) return status();
    const pc = boxes[0].pc, layer = found.layer, prov = layer.imageryProvider;
    if (!prov || !prov.tilingScheme || typeof prov.requestImage !== 'function') { at.err = 'this layer cannot give tiles'; return status(); }
    const t0 = performance.now();
    const lid = idOf(layer), crsKey = pc.projection || '';
    const scheme = schemeOf(prov);
    const tw = prov.tileWidth || 256;
    const single = tw > 512 || (prov.maximumLevel === 0 && scheme.nx0 === 1 && scheme.ny0 === 1 && tw > 256);
    const slot = single ? 256 : (tw > 256 ? 512 : 256), N = ATLAS / slot;
    const lonlat = toLonLat(pc);
    const midLL = lonlat(r.cx, r.cy), midLat = midLL[1];
    let level = 0;
    const tileM = L => (scheme.east - scheme.west) * 6378137 * Math.cos(midLat) / (scheme.nx0 * Math.pow(2, L));
    if (!single) {
      const ideal = atlasLevel({ side: r.side, N, tileMetres: tileM, minLevel: prov.minimumLevel || 0, maxLevel: Math.min(prov.maximumLevel != null ? prov.maximumLevel : 19, 21) });
      level = ideal;
      // keep the level we have while it still holds the view (a level change refills the whole atlas)
      if (at.win && at.win.layerId === lid && at.win.crs === crsKey && at.win.level <= ideal && at.win.level >= ideal - 1 &&
          (N - 1) * tileM(at.win.level) >= r.side) level = at.win.level;
    }
    const pixelOf = (lon, lat) => {
      if (single) { const u = (lon - scheme.west) / (scheme.east - scheme.west), v = (scheme.north - lat) / (scheme.north - scheme.south); return [u * tw, v * (prov.tileHeight || tw)]; }
      const f = tileFraction(scheme, lon, lat, level); return [f.fx * slot, f.fy * slot];
    };
    const mid = pixelOf(midLL[0], midLL[1]);
    let w = at.win;
    const inside = w && w.layerId === lid && w.crs === crsKey && w.level === level && w.slot === slot &&
      (() => { const rx = (mid[0] - w.x0 * slot) / slot, ry = (mid[1] - w.y0 * slot) / slot; return rx > 1.5 && rx < N - 1.5 && ry > 1.5 && ry < N - 1.5; })();
    if (!inside || force) {
      const wt = windowTiles(mid[0] / slot, mid[1] / slot, N);
      w = { layerId: lid, crs: crsKey, level, slot, x0: wt.x0, y0: wt.y0, N, single, id: ++layerSeq };
      at.win = w; at.layerName = found.name; at.level = single ? 0 : level; at.slot = slot; at.N = N;
      // slots that now hold a different tile: queue the tile (from the cache) or a blank
      for (let ty = w.y0; ty < w.y0 + N; ty++) for (let tx = w.x0; tx < w.x0 + N; tx++) {
        const { sx, sy } = slotOf(tx, ty, N), sk = sx + ',' + sy, tk = lid + '|' + level + '|' + tx + '|' + ty;
        if (at.slotKey[sk] === tk) continue;
        at.slotKey[sk] = tk;
        enqueueUpload(sx, sy, cacheGet(tk) || blank(slot), slot);
      }
    }
    // tiles the view needs (the square's tiles plus a margin): fetch the ones not in the cache, nearest the middle first
    {
      const mg = single ? 0.5 : 0.6, half = r.side / 2;
      const c = [lonlat(r.cx - half, r.cy - half), lonlat(r.cx + half, r.cy - half), lonlat(r.cx - half, r.cy + half), lonlat(r.cx + half, r.cy + half)].map(p => pixelOf(p[0], p[1]));
      const tx0 = Math.floor(Math.min(...c.map(p => p[0])) / slot - mg), tx1 = Math.floor(Math.max(...c.map(p => p[0])) / slot + mg);
      const ty0 = Math.floor(Math.min(...c.map(p => p[1])) / slot - mg), ty1 = Math.floor(Math.max(...c.map(p => p[1])) / slot + mg);
      const jobs = [];
      for (let ty = Math.max(ty0, w.y0); ty <= Math.min(ty1, w.y0 + N - 1); ty++) for (let tx = Math.max(tx0, w.x0); tx <= Math.min(tx1, w.x0 + N - 1); tx++) {
        const tk = lid + '|' + level + '|' + tx + '|' + ty;
        if (cache.has(tk) || inflight.has(tk)) continue;
        jobs.push({ tx, ty, tk, d: Math.abs(tx - mid[0] / slot) + Math.abs(ty - mid[1] / slot) });
      }
      jobs.sort((a, b) => a.d - b.d);
      for (const j of jobs) {
        inflight.set(j.tk, true);
        fetchQ.push({ win: w, tk: j.tk, run: async () => {
          try {
            let cv = null;
            if (single) {
              const big = await singleImage(prov, lid);
              cv = document.createElement('canvas'); cv.width = cv.height = slot;
              cv.getContext('2d').drawImage(big, j.tx * slot, j.ty * slot, slot, slot, 0, 0, slot, slot);
            } else {
              const img = await withTimeout(Promise.resolve(prov.requestImage(j.tx, j.ty, level)), 15000);
              if (img) cv = drawUpright(img, slot);
            }
            if (cv) {
              cachePut(j.tk, cv);
              const { sx, sy } = slotOf(j.tx, j.ty, N);
              if (at.slotKey[sx + ',' + sy] === j.tk) enqueueUpload(sx, sy, cv, slot);
            }
          } catch (_) { /* this tile stays blank: the point's own colour shows */ }
          finally { inflight.delete(j.tk); render(); }
        } });
      }
      pumpFetch();
      at._count = { tx0, tx1, ty0, ty1 };
    }
    // the fit of the map into window pixels, valid around the view
    const fitSide = single ? Math.max(r.side * 1.5, 100) : Math.min(N * tileM(level), Math.max(r.side * 1.6, 120));
    const old = at.pending || at.cur;
    const needFit = !old || old.winId !== w.id || Math.abs(old.rect.cx - r.cx) > old.rect.side * 0.2 || Math.abs(old.rect.cy - r.cy) > old.rect.side * 0.2 ||
      fitSide > old.rect.side * 1.5 || fitSide < old.rect.side * 0.5;
    if (needFit) {
      const K = 6, xs = [], ys = [], px = [], py = [], ox = w.x0 * slot, oy = w.y0 * slot;
      for (let j = 0; j <= K; j++) for (let i = 0; i <= K; i++) {
        const dx = (i / K - 0.5) * fitSide, dy = (j / K - 0.5) * fitSide;
        const ll = lonlat(r.cx + dx, r.cy + dy), p = pixelOf(ll[0], ll[1]);
        xs.push(dx); ys.push(dy); px.push(p[0] - ox); py.push(p[1] - oy);
      }
      const Cx = fitBilinear(xs, ys, px), Cy = fitBilinear(xs, ys, py);
      const wmx = (((w.x0 % N) + N) % N) * slot, wmy = (((w.y0 % N) + N) % N) * slot;
      at.pending = { Cx, Cy, ctr: [r.cx, r.cy], win: [wmx, wmy, N * slot, ATLAS], rect: { cx: r.cx, cy: r.cy, side: fitSide }, winId: w.id };
      const g = Math.abs(Cx[1] * Cy[2] - Cx[2] * Cy[1]);
      at.texel = g > 0 ? 1 / Math.sqrt(g) : 0;     // metres per atlas pixel
    }
    at.err = ''; at.ms = Math.round(performance.now() - t0);
    flushPending();
    render();
    return status();
  }
  /** Switch to a new mapping only once the tile uploads it depends on are through (no half-filled atlas on screen). */
  function flushPending() {
    if (at.pending && !at.desc.sub.length) { at.cur = at.pending; at.pending = null; pushUniforms(); }
  }

  function status() {
    let ok = 0, needed = 0;
    if (at.win && at._count) {
      const w = at.win, c = at._count;
      for (let ty = Math.max(c.ty0, w.y0); ty <= Math.min(c.ty1, w.y0 + w.N - 1); ty++) for (let tx = Math.max(c.tx0, w.x0); tx <= Math.min(c.tx1, w.x0 + w.N - 1); tx++) {
        needed++; if (cache.has(w.layerId + '|' + w.level + '|' + tx + '|' + ty)) ok++;
      }
    }
    return { on: opts.on, layer: at.layerName, level: at.level, tiles: needed, tilesOk: ok, covered: needed ? +(ok / needed).toFixed(3) : 0,
      ms: at.ms, texel: +at.texel.toFixed(3), rect: at.cur && at.cur.rect, err: at.err, busy: fetching > 0 || fetchQ.length > 0 || at.desc.sub.length > 0, hasTexture: !!at.cur,
      queued: at.desc.sub.length, cached: cache.size };
  }

  // ---- state ---------------------------------------------------------------------------------------------------
  function get() { return { ...opts }; }
  function set(patch) {
    const p = sanitize(patch), layerChanged = p.layer !== undefined && p.layer !== opts.layer;
    Object.assign(opts, p);
    save();
    apply();
    if (opts.on && (layerChanged || p.on)) { at.win = null; at.cur = null; at.pending = null; at.slotKey = {}; at.desc.sub.length = 0; pushUniforms(); setTimeout(() => mosaic(true), 50); }
    render();
    return get();
  }
  function enable(on) { return set({ on: !!on }); }

  // ---- when to refresh -------------------------------------------------------------------------------------------
  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (opts.on) mosaic(false); }, delay);
  }
  function onMove() { lastMove = performance.now(); schedule(500); }
  try { if (cesiumViewer && cesiumViewer.camera && cesiumViewer.camera.moveEnd) cesiumViewer.camera.moveEnd.addEventListener(onMove); } catch (_) {}
  // new clouds, nodes that finish loading after the camera stopped
  setInterval(() => {
    if (!opts.on) return;
    for (const pc of pcs()) applyDefine(pc);
    pushUniforms();
    if (performance.now() - lastMove > 700) mosaic(false);
  }, 1500);
  // a new mapping waits for its tile uploads (a few a frame) before it is switched on
  (function tick() { try { if (opts.on && at.pending) flushPending(); } catch (_) {} if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(tick); })();

  // ---- the panel -----------------------------------------------------------------------------------------------
  function render() {
    const host = typeof document !== 'undefined' && document.getElementById('lp-splat-body');
    if (!host) return;
    if (!ui) {
      host.innerHTML = '';
      const sw = window.uiSwitch(opts.on, on => set({ on }), 'Splat mode [beta]', { id: 'lp-splat-on', title: 'Draw the ground as soft discs lying on the slope, coloured from a map layer. Visual only: nothing is changed in the cloud.' });
      host.appendChild(sw);
      const box = document.createElement('div'); box.id = 'lp-splat-controls'; box.style.cssText = 'display:none; margin-top:6px;';
      const slider = (id, label, min, max, step, key, fmt, title) => {
        const l = document.createElement('label'); l.style.cssText = 'display:block; font-size:11px; margin-top:4px;'; if (title) l.title = title;
        l.innerHTML = label + ' <span id="' + id + '-label" style="color:#00e5ff;"></span>' +
          '<input id="' + id + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '" style="width:100%; box-sizing:border-box;">';
        const inp = l.querySelector('input');
        inp.addEventListener('input', () => set({ [key]: +inp.value }));
        l._sync = () => { inp.value = opts[key]; l.querySelector('span').textContent = fmt(opts[key]); };
        return l;
      };
      const rows = [
        slider('lp-splat-fill', 'Fill', 0.3, 4, 0.05, 'fill', v => v.toFixed(2) + ' × spacing', 'Disc size as a multiple of the point spacing of the node. Raise it to close gaps between the discs.'),
        slider('lp-splat-max', 'Max screen size', 3, 128, 1, 'maxPx', v => Math.round(v) + ' px', 'No disc is drawn wider than this on screen. Matters close up, where a point spacing is many pixels wide.'),
        slider('lp-splat-maxworld', 'Max real size', 0.2, 30, 0.1, 'maxWorld', v => v.toFixed(1) + ' m', 'No disc is wider than this on the ground, however sparse the points are (far away the points are far apart and the discs would be huge). Gaps open where the points are further apart than this.'),
        slider('lp-splat-opacity', 'Opacity', 0.05, 1, 0.05, 'opacity', v => Math.round(v * 100) + '%', 'The ground layer\'s opacity: the globe and anything under it shows through.'),
        slider('lp-splat-band', 'Ground band', 0, 3, 0.05, 'band', v => v.toFixed(2) + ' m', 'Ground is class 2 plus every point within this height of the ground grid (the one the height filter uses).'),
        slider('lp-splat-edge', 'Edge shading', 0, 1, 0.05, 'edge', v => v <= 0 ? 'none' : Math.round(v * 100) + '%', 'The dark rims eye-dome lighting draws where two discs meet at slightly different depths. 0 removes them from the ground, 100% leaves them as the rest of the cloud has them. Eye-dome lighting must be on for this to matter.'),
      ];
      rows.forEach(r => box.appendChild(r));
      const sel = (id, label, title) => {
        const l = document.createElement('label'); l.style.cssText = 'display:block; font-size:11px; margin-top:6px;'; l.title = title || '';
        l.innerHTML = label + '<select id="' + id + '" style="width:100%; margin-top:2px; box-sizing:border-box;"></select>';
        return l;
      };
      const lay = sel('lp-splat-layer', 'Ground colour from', 'Any map layer from 🗺 Layers. Its tiles are fetched at the detail the cloud needs, each time the camera stops.');
      const modeOpts = '<option value="dots">Small dark green dots</option><option value="normal">Normal (current colouring)</option><option value="height">Coloured by height above ground</option><option value="red">Small red dots</option><option value="hidden">Hidden</option>';
      const above = sel('lp-splat-above', 'Points above the ground', 'Everything higher than the ground band: trees, shrubs, buildings.');
      const below = sel('lp-splat-below', 'Points below the ground', 'Everything lower than the ground band: noise, and returns under the ground (often entrances and voids).');
      above.querySelector('select').innerHTML = modeOpts; below.querySelector('select').innerHTML = modeOpts;
      box.appendChild(lay); box.appendChild(above); box.appendChild(below);
      const shade = window.uiSwitch(opts.shade, on => set({ shade: on }), 'Soft hillshade on the slope', { id: 'lp-splat-shade', small: true });
      shade.style.marginTop = '6px'; box.appendChild(shade);
      const st = document.createElement('div'); st.id = 'lp-splat-status'; st.style.cssText = 'font-size:10px; color:rgba(255,255,255,0.45); margin-top:6px;';
      box.appendChild(st);
      host.appendChild(box);
      above.querySelector('select').addEventListener('change', e => set({ above: e.target.value }));
      below.querySelector('select').addEventListener('change', e => set({ below: e.target.value }));
      lay.querySelector('select').addEventListener('change', e => set({ layer: e.target.value }));
      lay.querySelector('select').addEventListener('focus', () => fillLayers());
      ui = { sw, box, rows, lay: lay.querySelector('select'), above: above.querySelector('select'), below: below.querySelector('select'), st, shade };
    }
    const sw = ui.sw.querySelector('input') || ui.sw; if (sw.checked !== opts.on) sw.checked = opts.on;
    ui.box.style.display = opts.on ? '' : 'none';
    ui.rows.forEach(r => r._sync());
    ui.above.value = opts.above; ui.below.value = opts.below;
    const sh = ui.shade.querySelector('input') || ui.shade; sh.checked = opts.shade;
    fillLayers();
    const s = status();
    ui.st.textContent = !opts.on ? '' : s.err ? 'Colour: ' + s.err + ' (the points\' own colour is used)'
      : s.layer ? 'Colour: ' + s.layer + ', zoom ' + s.level + ', ' + s.tilesOk + '/' + s.tiles + ' tiles' + (s.busy ? ', loading…' : '') + ', ' + (s.texel * 100 | 0) / 100 + ' m per pixel'
      : opts.layer === 'none' ? 'Colour: the points\' own' : 'Waiting for point cloud nodes…';
  }
  function fillLayers() {
    if (!ui) return;
    const list = layerList(), cur = opts.layer;
    const sig = list.map(l => l.name).join('|') + '#' + cur;
    if (ui.lay._sig === sig) return;
    ui.lay._sig = sig;
    const def = chosenLayer();
    ui.lay.innerHTML = '<option value="">Satellite / current map' + (!cur && def ? ' (' + def.name + ')' : '') + '</option>' +
      list.map(l => '<option value="' + l.name.replace(/"/g, '&quot;') + '">' + l.name.replace(/</g, '&lt;') + (l.show ? '' : ' (hidden)') + '</option>').join('') +
      '<option value="none">The points\' own colour</option>';
    ui.lay.value = cur;
  }

  const api = { get, set, enable, apply, mosaic, status, layers: () => layerList().map(l => ({ i: l.i, name: l.name, show: l.show })), chosenLayer: () => { const c = chosenLayer(); return c && c.name; },
    render, defaults: SPLAT_DEFAULTS, _atlas: at, _cache: cache };
  if (typeof window !== 'undefined') window._splat = api;
  render();
  apply();
  return api;
}
