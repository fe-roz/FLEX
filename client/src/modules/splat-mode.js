// Splat mode [beta] (📊 LiDAR → Splat mode): the ground of a streamed point cloud drawn as soft discs lying on the
// ground, coloured from a map layer; the other points as small dark green dots, as before, or hidden. Visual only:
// nothing is written, nothing in the cloud is changed, and off is exactly the usual drawing (the shader code is not
// even compiled in: the `splat_enabled` define is added to the Potree material only while it is on).
//
// How it works (the shader is PotreeCopied/src/materials/shaders/pointcloud.vs doSplat() and pointcloud.fs, edit 8 in
// PotreeCopied/FLEX_PATCHES.md):
//   ground     class 2, plus any point within `band` metres of the height-above-ground grid (pointcloud-hag.js keeps
//              filling that grid while Splat mode holds it, even with the height filter off).
//   normal     from the slope of that grid at the point (central differences over `uSplatSlope` metres).
//   disc       one point sprite per ground point, `fill` x node spacing wide (capped at `maxPx` pixels on screen); the
//              fragment shader intersects the pixel's ray with the disc's plane, so the disc is an ellipse that follows
//              the slope, and writes the true depth there. Gaussian soft edge and the opacity are drawn as
//              screen-door discard: the pass stays opaque, so it works with EDL and without sorting. (FLEX renders
//              with useHQ off, so Potree's two-pass weighted splatting is not in play.)
//   colour     a mosaic of an imagery layer, built here on camera stops: tiles are fetched with the layer's
//              ImageryProvider.requestImage(x, y, level) at a level matched to the cell size, resampled into the
//              cloud's own coordinate system (a square around the view, 2048 x 2048), and handed to Potree as a plain
//              {width,height,data,version} (like the ground grids). Each fragment looks its colour up from where the
//              ray meets the disc. Outside the mosaic, or while tiles load: the point's own colour.
//
// Pure exports (no browser), node-testable by tools/test_splat_mode.js:
//   SPLAT_DEFAULTS, sanitize(raw), pickLayerIndex(names), mercY(latRad), tileFraction(scheme, lonRad, latRad, level),
//   chooseLevel(opts), viewRect(boxes, opts), fillMosaic(opts)
// Setup:
//   setupSplatMode({ Cesium, proj4, potreeViewer, cesiumViewer, hag }) -> { get, set, enable, apply, mosaic, ... }
//   window._splat is that object.

export const SPLAT_DEFAULTS = {
  on: false, fill: 1.6, maxPx: 64, opacity: 1, band: 0.3,
  other: 'dots',           // 'dots' | 'normal' | 'hidden'
  layer: '',               // an imagery layer's name; '' = the satellite / current base map; 'none' = the point's own colour
  shade: true,             // soft hillshade from the slope
};

const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : undefined;
export function sanitize(raw) {
  const o = {};
  if (!raw || typeof raw !== 'object') return o;
  const put = (k, v) => { if (v !== undefined) o[k] = v; };
  put('on', typeof raw.on === 'boolean' ? raw.on : undefined);
  put('fill', num(raw.fill, 0.3, 4));
  put('maxPx', num(raw.maxPx, 3, 128));
  put('opacity', num(raw.opacity, 0.05, 1));
  put('band', num(raw.band, 0, 3));
  put('other', ['dots', 'normal', 'hidden'].includes(raw.other) ? raw.other : undefined);
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
 * The square (in cloud coordinates) the mosaic covers: around the finest visible nodes. boxes = [{x0,y0,x1,y1,level}].
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
 * Resample tile pixels into the cloud's coordinate system.
 *   out     Uint8Array(T*T*4), row 0 = the south edge of the rect (so v = (y - y0) / side, no flip)
 *   lonlat  (x, y) -> [lonRad, latRad]   (the cloud's CRS -> WGS84)
 *   mosaic  { data: Uint8ClampedArray RGBA, width, height, tx0, ty0 (first tile), tw, th (tile size px) }
 * The lon / lat is computed on a coarse lattice and interpolated (a few km of UTM is straight enough).
 */
export function fillMosaic({ out, T, x0, y0, side, lonlat, scheme, level, mosaic, have }) {
  const K = 32, lat = new Float64Array((K + 1) * (K + 1) * 2);
  for (let j = 0; j <= K; j++) for (let i = 0; i <= K; i++) {
    const p = lonlat(x0 + side * i / K, y0 + side * j / K), o = (j * (K + 1) + i) * 2;
    lat[o] = p[0]; lat[o + 1] = p[1];
  }
  const { data, width: W, height: H, tx0, ty0, tw, th } = mosaic;
  let covered = 0;
  for (let r = 0; r < T; r++) {
    const fj = (r + 0.5) / T * K, j = Math.min(K - 1, fj | 0), tj = fj - j;
    for (let c = 0; c < T; c++) {
      const fi = (c + 0.5) / T * K, i = Math.min(K - 1, fi | 0), ti = fi - i;
      const o00 = (j * (K + 1) + i) * 2, o10 = o00 + 2, o01 = o00 + (K + 1) * 2, o11 = o01 + 2;
      const lon = (1 - tj) * ((1 - ti) * lat[o00] + ti * lat[o10]) + tj * ((1 - ti) * lat[o01] + ti * lat[o11]);
      const la = (1 - tj) * ((1 - ti) * lat[o00 + 1] + ti * lat[o10 + 1]) + tj * ((1 - ti) * lat[o01 + 1] + ti * lat[o11 + 1]);
      const f = tileFraction(scheme, lon, la, level);
      const px = (f.fx - tx0) * tw - 0.5, py = (f.fy - ty0) * th - 0.5;
      const q = (r * T + c) * 4;
      const ix = Math.floor(px), iy = Math.floor(py);
      if (ix < 0 || iy < 0 || ix >= W - 1 || iy >= H - 1) { out[q + 3] = 0; continue; }
      // a tile that did not load leaves its pixels at alpha 0: do not mix those in
      const a = (iy * W + ix) * 4, b = a + 4, cc = a + W * 4, d = cc + 4;
      if (data[a + 3] < 128 || data[b + 3] < 128 || data[cc + 3] < 128 || data[d + 3] < 128) { out[q + 3] = 0; continue; }
      const fx = px - ix, fy = py - iy;
      for (let k = 0; k < 3; k++) {
        out[q + k] = (data[a + k] * (1 - fx) + data[b + k] * fx) * (1 - fy) + (data[cc + k] * (1 - fx) + data[d + k] * fx) * fy;
      }
      out[q + 3] = 255; covered++;
    }
  }
  return covered / (T * T);
}

const KEY = 'flex.splat';
const MOSAIC_T = 2048;

export function setupSplatMode({ Cesium, proj4, potreeViewer, cesiumViewer, hag, storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const load = () => { try { return sanitize(JSON.parse(store.getItem(KEY))); } catch (_) { return {}; } };
  const save = () => { try { store.setItem(KEY, JSON.stringify(opts)); } catch (_) {} };
  let opts = { ...SPLAT_DEFAULTS, ...load() };

  const mos = { desc: null, rect: null, seq: 0, busy: false, layerName: null, level: null, tiles: 0, tilesOk: 0, covered: 0, ms: 0, err: '', texel: 0, key: '', crs: null };
  let lastMove = 0, timer = null, ui = null;

  const pcs = () => (potreeViewer && potreeViewer.scene && potreeViewer.scene.pointclouds) || [];

  // ---- material ------------------------------------------------------------------------------------------------
  function uniformsFor(pc) {
    const u = pc.material && pc.material.uniforms;
    return u && u.uSplatP ? u : null;
  }
  function pushUniforms() {
    const other = { hidden: 0, dots: 1, normal: 2 }[opts.other];
    for (const pc of pcs()) {
      const u = uniformsFor(pc); if (!u) continue;
      u.uSplatP.value = [opts.fill, opts.maxPx, opts.band, opts.opacity];
      u.uSplatO.value = other;
      u.uSplatShade.value = opts.shade ? 1 : 0;
      u.uSplatColTex.value = opts.on ? mos.desc : null;
      u.uSplatColOn.value = opts.on && mos.desc && mos.rect ? 1 : 0;
      if (mos.rect) u.uSplatRect.value = [mos.rect.x0, mos.rect.y0, mos.rect.side, mos.rect.side];
    }
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

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  /** Build the colour mosaic for the current view (or the given rect). Resolves to the status. */
  async function mosaic(force) {
    if (!opts.on) return status();
    const my = ++mos.seq;
    const found = chosenLayer();
    if (!found) { mos.desc = null; mos.rect = null; mos.layerName = null; mos.err = opts.layer === 'none' ? '' : 'no map layer'; pushUniforms(); return status(); }
    const boxes = viewBoxes();
    const r = viewRect(boxes);
    if (!r) return status();
    const pc = boxes[0].pc;
    const prov = found.layer.imageryProvider;
    if (!prov || !prov.tilingScheme || typeof prov.requestImage !== 'function') { mos.err = 'this layer cannot give tiles'; return status(); }
    const T = MOSAIC_T, side = r.side, x0 = r.cx - side / 2, y0 = r.cy - side / 2, texel = side / T;
    // Skip when the view has not really changed
    const key = found.name + '|' + (pc.projection || '');
    if (!force && mos.rect && mos.key === key && Math.abs(r.cx - (mos.rect.x0 + mos.rect.side / 2)) < mos.rect.side * 0.2 &&
        Math.abs(r.cy - (mos.rect.y0 + mos.rect.side / 2)) < mos.rect.side * 0.2 && side / mos.rect.side < 1.6 && side / mos.rect.side > 0.5) return status();
    mos.busy = true; mos.err = '';
    const t0 = performance.now();
    try {
      const lonlat = toLonLat(pc), scheme = schemeOf(prov);
      const corners = [lonlat(x0, y0), lonlat(x1(x0, side), y0), lonlat(x0, x1(y0, side)), lonlat(x1(x0, side), x1(y0, side))];
      const lonMin = Math.min(...corners.map(c => c[0])), lonMax = Math.max(...corners.map(c => c[0]));
      const latMin = Math.min(...corners.map(c => c[1])), latMax = Math.max(...corners.map(c => c[1]));
      const tw = prov.tileWidth || 256, th = prov.tileHeight || 256;
      const rangeAt = L => {
        const a = tileFraction(scheme, lonMin, latMax, L), b = tileFraction(scheme, lonMax, latMin, L);
        const nx = scheme.nx0 * Math.pow(2, L), ny = scheme.ny0 * Math.pow(2, L);
        const t0x = Math.max(0, Math.floor(a.fx)), t1x = Math.min(nx - 1, Math.floor(b.fx));
        const t0y = Math.max(0, Math.floor(a.fy)), t1y = Math.min(ny - 1, Math.floor(b.fy));
        return { t0x, t1x, t0y, t1y, n: Math.max(0, t1x - t0x + 1) * Math.max(0, t1y - t0y + 1) };
      };
      const midLat = (latMin + latMax) / 2;
      const level = chooseLevel({ scheme, texel, lat: midLat, tileWidth: tw, minLevel: prov.minimumLevel || 0,
        maxLevel: Math.min(prov.maximumLevel != null ? prov.maximumLevel : 19, 21), tilesAt: L => rangeAt(L).n });
      const rg = rangeAt(level);
      if (!rg.n) { mos.err = 'the view is outside this layer'; mos.busy = false; return status(); }
      const W = (rg.t1x - rg.t0x + 1) * tw, H = (rg.t1y - rg.t0y + 1) * th;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d', { willReadFrequently: true });
      let ok = 0, total = 0;
      const jobs = [];
      for (let ty = rg.t0y; ty <= rg.t1y; ty++) for (let tx = rg.t0x; tx <= rg.t1x; tx++) {
        total++;
        jobs.push((async () => {
          try {
            const img = await withTimeout(Promise.resolve(prov.requestImage(tx, ty, level)), 15000);
            if (!img) return;
            g.drawImage(img, (tx - rg.t0x) * tw, (ty - rg.t0y) * th, tw, th);
            ok++;
          } catch (_) { /* this tile stays transparent: the point's own colour shows there */ }
        })());
      }
      await Promise.all(jobs);
      if (my !== mos.seq) return status();            // a newer mosaic was asked for
      let id;
      try { id = g.getImageData(0, 0, W, H); } catch (e) { mos.err = 'the browser would not let FLEX read this layer\'s tiles'; mos.busy = false; return status(); }
      const out = (mos.desc && mos.desc.data && mos.desc.data.length === T * T * 4) ? mos.desc.data : new Uint8Array(T * T * 4);
      out.fill(0);
      const covered = fillMosaic({ out, T, x0, y0, side, lonlat, scheme, level,
        mosaic: { data: id.data, width: W, height: H, tx0: rg.t0x, ty0: rg.t0y, tw, th }, have: null });
      if (my !== mos.seq) return status();
      mos.desc = { width: T, height: T, data: out, version: (mos.desc ? mos.desc.version : 0) + 1 };
      mos.rect = { x0, y0, side }; mos.key = key; mos.layerName = found.name; mos.level = level;
      mos.tiles = total; mos.tilesOk = ok; mos.covered = covered; mos.texel = texel; mos.ms = Math.round(performance.now() - t0);
      if (!ok) mos.err = 'no tiles came back';
      pushUniforms();
    } catch (e) {
      mos.err = String(e && e.message || e).slice(0, 120);
    }
    mos.busy = false;
    render();
    return status();
  }
  const x1 = (a, s) => a + s;

  function status() {
    return { on: opts.on, layer: mos.layerName, level: mos.level, tiles: mos.tiles, tilesOk: mos.tilesOk, covered: +mos.covered.toFixed(3),
      ms: mos.ms, texel: +mos.texel.toFixed(3), rect: mos.rect, err: mos.err, busy: mos.busy, hasTexture: !!mos.desc };
  }

  // ---- state ---------------------------------------------------------------------------------------------------
  function get() { return { ...opts }; }
  function set(patch) {
    const p = sanitize(patch), layerChanged = p.layer !== undefined && p.layer !== opts.layer;
    Object.assign(opts, p);
    save();
    apply();
    if (opts.on && (layerChanged || p.on)) { mos.rect = null; setTimeout(() => mosaic(true), 50); }
    render();
    return get();
  }
  function enable(on) { return set({ on: !!on }); }

  // ---- when to rebuild the mosaic -------------------------------------------------------------------------------
  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (opts.on && !mos.busy) mosaic(false); }, delay);
  }
  function onMove() { lastMove = performance.now(); schedule(700); }
  try { if (cesiumViewer && cesiumViewer.camera && cesiumViewer.camera.moveEnd) cesiumViewer.camera.moveEnd.addEventListener(onMove); } catch (_) {}
  // new clouds, and nodes that finish loading after the camera stopped
  setInterval(() => {
    if (!opts.on) return;
    for (const pc of pcs()) applyDefine(pc);
    pushUniforms();
    if (!mos.busy && performance.now() - lastMove > 900) mosaic(false);
  }, 1500);

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
        slider('lp-splat-opacity', 'Opacity', 0.05, 1, 0.05, 'opacity', v => Math.round(v * 100) + '%', 'Below 100% the ground is drawn see-through in a fine dither.'),
        slider('lp-splat-band', 'Ground band', 0, 3, 0.05, 'band', v => v.toFixed(2) + ' m', 'Ground is class 2 plus every point within this height of the ground grid (the one the height filter uses).'),
      ];
      rows.forEach(r => box.appendChild(r));
      const sel = (id, label, title) => {
        const l = document.createElement('label'); l.style.cssText = 'display:block; font-size:11px; margin-top:6px;'; l.title = title || '';
        l.innerHTML = label + '<select id="' + id + '" style="width:100%; margin-top:2px; box-sizing:border-box;"></select>';
        return l;
      };
      const lay = sel('lp-splat-layer', 'Ground colour from', 'Any map layer from 🗺 Layers. Its tiles are fetched at the detail the cloud needs, each time the camera stops.');
      const oth = sel('lp-splat-other', 'Other points', 'Everything that is not ground.');
      oth.querySelector('select').innerHTML = '<option value="dots">Small dark green dots</option><option value="normal">Normal (current colouring)</option><option value="hidden">Hidden</option>';
      box.appendChild(lay); box.appendChild(oth);
      const shade = window.uiSwitch(opts.shade, on => set({ shade: on }), 'Soft hillshade on the slope', { id: 'lp-splat-shade', small: true });
      shade.style.marginTop = '6px'; box.appendChild(shade);
      const st = document.createElement('div'); st.id = 'lp-splat-status'; st.style.cssText = 'font-size:10px; color:rgba(255,255,255,0.45); margin-top:6px;';
      box.appendChild(st);
      host.appendChild(box);
      oth.querySelector('select').addEventListener('change', e => set({ other: e.target.value }));
      lay.querySelector('select').addEventListener('change', e => set({ layer: e.target.value }));
      lay.querySelector('select').addEventListener('focus', () => fillLayers());
      ui = { sw, box, rows, lay: lay.querySelector('select'), oth: oth.querySelector('select'), st, shade };
    }
    const sw = ui.sw.querySelector('input') || ui.sw; if (sw.checked !== opts.on) sw.checked = opts.on;
    ui.box.style.display = opts.on ? '' : 'none';
    ui.rows.forEach(r => r._sync());
    ui.oth.value = opts.other;
    const sh = ui.shade.querySelector('input') || ui.shade; sh.checked = opts.shade;
    fillLayers();
    const s = status();
    ui.st.textContent = !opts.on ? '' : s.err ? 'Colour: ' + s.err + ' (the points\' own colour is used)'
      : s.busy ? 'Fetching map tiles…' : s.layer ? 'Colour: ' + s.layer + ', zoom ' + s.level + ', ' + s.tilesOk + '/' + s.tiles + ' tiles, ' + (s.texel * 100 | 0) / 100 + ' m per texel'
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
    render, defaults: SPLAT_DEFAULTS, _mos: mos };
  if (typeof window !== 'undefined') window._splat = api;
  render();
  apply();
  return api;
}
