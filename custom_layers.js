// custom_layers.js — your own map layers, in 🗺 Layers → "Your map layers":
//
//   - a GeoTIFF (a hillshade, an orthophoto, a scanned map that has been
//     georeferenced, or a DEM, which is turned into a hillshade), in
//     lon/lat, UTM (WGS84 / NAD83) or Web Mercator. It is read in the
//     browser (UTIF), warped to lon/lat, and kept as one image with its
//     bounds;
//   - a tile link ({z}/{x}/{y} template).
//
// With a project open a new layer goes into the project (📁, in its folder,
// shared by sync files); otherwise into 👤 My data. Which ones are shown and
// how see-through they are is personal (this computer), as for caves.
// Drawn above the built-in layers, in the order listed.
//
// Library entries: layer.set { layer, kind: 'imagery', blob: '<sha>.webp',
// bounds: [west, south, east, north], name } or { kind: 'tiles', url, name }.
(function () {
  'use strict';
  const PJ = () => window._pj || {}, A = () => window._pjApi, MD = () => window._myData, FL = () => window.FlexLib, V = () => window.cesiumViewer;
  const KINDS = new Set(['imagery', 'tiles', 'terrain']);
  const MAX_SIDE = 4096;                         // the image kept: at most this many pixels a side
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = m => (A() && A().toast ? A().toast(m) : console.log('[layers]', m));

  // ── Personal view: shown, see-through ────────────────────────────────────
  const VK = 'flex.cl.view';
  const views = () => { try { return JSON.parse(localStorage.getItem(VK) || '{}'); } catch (_) { return {}; } };
  const viewOf = id => Object.assign({ show: true, alpha: 1 }, views()[id] || {});
  function setView(id, v) { const all = views(); all[id] = Object.assign(viewOf(id), v); try { localStorage.setItem(VK, JSON.stringify(all)); } catch (_) {} }

  // ── What there is ────────────────────────────────────────────────────────
  let mine = null;
  async function myLayers(force) {
    if (!MD()) return [];
    if (!mine || force) { const S = await MD().state(true); mine = Object.values(S.layers || {}).filter(l => !l.removed && KINDS.has(l.kind)); }
    return mine;
  }
  async function entries(force) {
    const out = [], pj = PJ();
    if (pj.pid && pj.P && FL()) FL().liveLayers(pj.P).filter(l => KINDS.has(l.kind)).forEach(l => out.push(Object.assign({ owner: 'p' }, l)));
    (await myLayers(force)).forEach(l => out.push(Object.assign({ owner: 'm' }, l)));
    return out;
  }
  const srcUrl = l => (l.kind === 'imagery' || l.kind === 'terrain' ? '/api/lib/blob/' + l.blob : l.url);
  const sigOf = l => [l.kind, srcUrl(l), (l.bounds || []).join(',')].join('|');

  // ── On the globe ─────────────────────────────────────────────────────────
  const drawn = new Map();                       // id → { layer, sig }
  let chain = Promise.resolve();
  // Terrain patches (layer kind 'terrain'): put over the globe's terrain in list order, shown ones only.
  let terrainSig = '';
  async function syncTerrain(want) {
    const v = V(), TP = window._terrainPatch; if (!v || !TP) return;
    const list = want.filter(l => l.kind === 'terrain' && l.blob && viewOf(l.id).show), sig = list.map(sigOf).join(';');
    if (sig === terrainSig) return;
    terrainSig = sig;
    TP.uninstallAll(v);
    for (const l of list) { try { await TP.install(v, srcUrl(l)); } catch (e) { console.warn('[layers] terrain', l.name, e); toast('Could not use the terrain patch “' + l.name + '”: ' + e.message); } }
    window.dispatchEvent(new CustomEvent('flex-terrain-changed', { detail: { ids: list.map(l => l.id) } }));
    if (v.scene.requestRender) v.scene.requestRender();
  }
  /** Make the globe match the list; calls run one after another, each waits for its turn. */
  function sync(force) { chain = chain.then(() => doSync(force)).catch(e => console.warn('[layers] sync', e)); return chain; }
  async function doSync(force) {
    const v = V(); if (!v || !window.Cesium) return;
    {
      const want = await entries(force), ids = new Set(want.map(l => l.id));
      await syncTerrain(want);
      let listChanged = false;
      for (const [id, d] of drawn) if (!ids.has(id) || d.sig !== sigOf(want.find(l => l.id === id))) { v.imageryLayers.remove(d.layer, true); drawn.delete(id); listChanged = true; }
      for (const l of want) {
        if (l.kind === 'terrain') continue;
        if (!drawn.has(l.id)) {
          let prov = null;
          try {
            if (l.kind === 'imagery' && l.blob && l.bounds) prov = await Cesium.SingleTileImageryProvider.fromUrl(srcUrl(l), { rectangle: Cesium.Rectangle.fromDegrees(...l.bounds) });
            else if (l.kind === 'tiles' && l.url) prov = new Cesium.UrlTemplateImageryProvider({ url: l.url, maximumLevel: 20 });
          } catch (e) { console.warn('[layers] could not show', l.name, e); }
          if (!prov) continue;
          const z0 = views()[l.id] && views()[l.id].z, vw0 = viewOf(l.id);
          const layer = v.imageryLayers.addImageryProvider(prov, z0 != null ? Math.min(Math.max(0, z0), v.imageryLayers.length) : undefined);
          layer.show = !!vw0.show; layer.alpha = Math.max(0, Math.min(1, +vw0.alpha));
          layer.name = l.name || 'Layer'; layer._custom = { id: l.id, owner: l.owner };       // shows in the one list (flex.js renderLayerList)
          Cesium.knockout.track(layer, ['alpha', 'show', 'name']);
          const kid = l.id;
          Cesium.knockout.getObservable(layer, 'show').subscribe(s => setView(kid, { show: !!s }));
          Cesium.knockout.getObservable(layer, 'alpha').subscribe(a => setView(kid, { alpha: +a }));
          drawn.set(l.id, { layer, sig: sigOf(l) });
          listChanged = true;
        }
        const d = drawn.get(l.id), vw = viewOf(l.id);
        d.layer.show = !!vw.show; d.layer.alpha = Math.max(0, Math.min(1, +vw.alpha));
      }
      if (listChanged && window._updateLayerList) { window._updateLayerList(); if (window._renderLayerList) window._renderLayerList(); }
      if (v.scene.requestRender) v.scene.requestRender();
    }
  }

  // ── Reading a GeoTIFF ────────────────────────────────────────────────────
  const KEY = { model: 1024, raster: 1025, geog: 2048, proj: 3072 };
  function geoKeys(dir) {
    const k = {}; if (!dir) return k;
    for (let i = 4; i + 3 < dir.length; i += 4) if (dir[i + 1] === 0) k[dir[i]] = dir[i + 3];
    return k;
  }
  /** proj4 text for an EPSG code we know, null for lon/lat, undefined if unknown. */
  function projOf(epsg) {
    if (epsg === 4326 || epsg === 4269 || epsg === 4283 || epsg === 4258) return null;
    if (epsg === 3857 || epsg === 900913) return 'EPSG:3857';
    if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
    if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
    if (epsg >= 26901 && epsg <= 26923) return `+proj=utm +zone=${epsg - 26900} +datum=NAD83 +units=m +no_defs`;
    if (epsg >= 6330 && epsg <= 6348) return `+proj=utm +zone=${epsg - 6329} +ellps=GRS80 +units=m +no_defs`;   // NAD83(2011) UTM 1–19
    return undefined;
  }
  /** A GeoTIFF's pixels as RGBA with where they are: { w, h, rgba, toXY(col,row) → [x,y], proj, nodata }. */
  function readTiff(buf, raw) {
    const U = window.UTIF; if (!U) throw new Error('the TIFF reader is missing');
    const ifds = U.decode(buf);
    const ifd = ifds.find(d => d.t33550 || d.t33922 || d.t34264) || ifds[0];
    if (!ifd) throw new Error('not a TIFF');
    U.decodeImage(buf, ifd);
    const w = ifd.width, h = ifd.height;
    const keys = geoKeys(ifd.t34735);
    let toXY;
    if (ifd.t34264) { const m = ifd.t34264; toXY = (c, r) => [m[0] * c + m[1] * r + m[3], m[4] * c + m[5] * r + m[7]]; }
    else if (ifd.t33550 && ifd.t33922) {
      const [sx, sy] = ifd.t33550, t = ifd.t33922;
      const half = keys[KEY.raster] === 2 ? 0.5 : 0;            // PixelIsPoint: the tie point is a pixel's centre
      toXY = (c, r) => [t[3] + (c - t[0] - half) * sx, t[4] - (r - t[1] - half) * sy];
    } else throw new Error('this TIFF has no position (not a GeoTIFF)');
    const epsg = keys[KEY.model] === 2 ? (keys[KEY.geog] || 4326) : keys[KEY.proj];
    const proj = projOf(epsg);
    if (proj === undefined) throw new Error(`its map projection (EPSG:${epsg || '?'}) isn't one FLEX reads yet — save it as lon/lat (EPSG:4326) or UTM`);
    const nd = ifd.t42113 != null ? parseFloat(String(ifd.t42113).replace(/\0/g, '')) : null;
    const spp = (ifd.t277 && ifd.t277[0]) || 1, bps = (ifd.t258 && ifd.t258[0]) || 8, fmt = (ifd.t339 && ifd.t339[0]) || 1;
    let rgba, dem = false, vals = null;
    if (spp === 1 && (fmt === 3 || bps > 8)) {
      // One band of numbers (a DEM): a hillshade from it.
      const raw = new Uint8Array(ifd.data).buffer;                  // a copy, aligned
      vals = fmt === 3 && bps === 32 ? new Float32Array(raw, 0, w * h) : fmt === 3 && bps === 64 ? new Float64Array(raw, 0, w * h)
        : bps === 16 ? (fmt === 2 ? new Int16Array(raw, 0, w * h) : new Uint16Array(raw, 0, w * h))
        : bps === 32 ? (fmt === 2 ? new Int32Array(raw, 0, w * h) : new Uint32Array(raw, 0, w * h)) : null;
      if (!vals) throw new Error('this DEM’s number type isn’t read yet');
      const p0 = toXY(0, 0), p1 = toXY(1, 1);
      let cx = Math.abs(p1[0] - p0[0]), cy = Math.abs(p1[1] - p0[1]);
      if (proj === null) { const lat = (toXY(0, h / 2)[1]) * Math.PI / 180; cx *= 111320 * Math.cos(lat); cy *= 110540; }
      rgba = raw ? null : hillshade(vals, w, h, cx, cy, nd);
      dem = true;
    } else {
      rgba = U.toRGBA8(ifd);
      if (nd != null && !isNaN(nd) && spp <= 3) for (let i = 0; i < w * h; i++) { const r = rgba[i * 4]; if (r === nd && rgba[i * 4 + 1] === nd && rgba[i * 4 + 2] === nd) rgba[i * 4 + 3] = 0; }
    }
    return { w, h, rgba, toXY, proj, epsg, dem, vals, nd };
  }
  /** Grey hillshade (light from the north-west, 45° up), 0 where there's no data. */
  function hillshade(z, w, h, cx, cy, nd) {
    const out = new Uint8Array(w * h * 4), az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
    const zen = Math.PI / 2 - alt, cz = Math.cos(zen), sz = Math.sin(zen);
    const bad = v => v == null || isNaN(v) || (nd != null && v === nd) || v < -1e30;
    const at = (c, r) => { c = c < 0 ? 0 : c >= w ? w - 1 : c; r = r < 0 ? 0 : r >= h ? h - 1 : r; return z[r * w + c]; };
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c, o = i * 4;
      if (bad(z[i])) { out[o + 3] = 0; continue; }
      const g = (cc, rr) => { const v = at(cc, rr); return bad(v) ? z[i] : v; };
      const a = g(c - 1, r - 1), b = g(c, r - 1), d = g(c + 1, r - 1), e = g(c - 1, r), f = g(c + 1, r), gg = g(c - 1, r + 1), hh = g(c, r + 1), ii = g(c + 1, r + 1);
      const dzdx = ((d + 2 * f + ii) - (a + 2 * e + gg)) / (8 * cx);
      const dzdy = ((gg + 2 * hh + ii) - (a + 2 * b + d)) / (8 * cy);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      let aspect = Math.atan2(dzdy, -dzdx);
      if (aspect < 0) aspect += 2 * Math.PI;
      const s = 255 * (cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(az - aspect));
      const v = s < 0 ? 0 : s > 255 ? 255 : s;
      out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
    }
    return out;
  }
  /** The picture in lon/lat: a canvas and its bounds [w, s, e, n] (degrees). */
  function toLonLat(T) {
    const P = window.proj4;
    const fwd = T.proj === null ? (lon, lat) => [lon, lat] : (P ? (lon, lat) => P('WGS84', T.proj, [lon, lat]) : null);
    const inv = T.proj === null ? (x, y) => [x, y] : (P ? (x, y) => P(T.proj, 'WGS84', [x, y]) : null);
    if (!fwd) throw new Error('the projection library is missing');
    // Bounds: the edges of the picture, every few pixels.
    let W = 180, S = 90, E = -180, N = -90;
    const edge = (c, r) => { const ll = inv(...T.toXY(c, r)); W = Math.min(W, ll[0]); E = Math.max(E, ll[0]); S = Math.min(S, ll[1]); N = Math.max(N, ll[1]); };
    for (let i = 0; i <= 32; i++) { const c = T.w * i / 32, r = T.h * i / 32; edge(c, 0); edge(c, T.h); edge(0, r); edge(T.w, r); }
    if (!(E > W && N > S) || W < -180 || E > 180 || S < -90 || N > 90) throw new Error('its position makes no sense (check its map projection)');
    // Output size: about the input's, at most MAX_SIDE.
    const aspect = ((E - W) * Math.cos((S + N) / 2 * Math.PI / 180)) / (N - S);
    let ow = Math.round(Math.sqrt(T.w * T.h * aspect)), oh = Math.round(ow / aspect);
    const k = Math.min(1, MAX_SIDE / Math.max(ow, oh)); ow = Math.max(1, Math.round(ow * k)); oh = Math.max(1, Math.round(oh * k));
    // Source column/row for output pixels: exact on a coarse grid, in between by interpolation.
    const G = 48, gx = new Float64Array((G + 1) * (G + 1)), gy = new Float64Array((G + 1) * (G + 1));
    const t = T.toXY(0, 0), tx = T.toXY(1, 0), ty = T.toXY(0, 1);
    const a = tx[0] - t[0], b = ty[0] - t[0], c2 = tx[1] - t[1], d = ty[1] - t[1], det = a * d - b * c2;   // pixel → map is affine
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
      const lon = W + (E - W) * i / G, lat = N - (N - S) * j / G;
      const xy = fwd(lon, lat), dx = xy[0] - t[0], dy = xy[1] - t[1];
      gx[j * (G + 1) + i] = (d * dx - b * dy) / det; gy[j * (G + 1) + i] = (-c2 * dx + a * dy) / det;
    }
    const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh;
    const cx = cv.getContext('2d'), img = cx.createImageData(ow, oh), o = img.data, src = T.rgba;
    for (let y = 0; y < oh; y++) {
      const fy = (y + 0.5) / oh * G, j = Math.min(G - 1, Math.floor(fy)), v = fy - j;
      for (let x = 0; x < ow; x++) {
        const fx = (x + 0.5) / ow * G, i = Math.min(G - 1, Math.floor(fx)), u = fx - i;
        const q = j * (G + 1) + i, q2 = q + G + 1;
        const sc = (gx[q] * (1 - u) + gx[q + 1] * u) * (1 - v) + (gx[q2] * (1 - u) + gx[q2 + 1] * u) * v;
        const sr = (gy[q] * (1 - u) + gy[q + 1] * u) * (1 - v) + (gy[q2] * (1 - u) + gy[q2 + 1] * u) * v;
        const ci = Math.floor(sc), ri = Math.floor(sr);
        if (ci < 0 || ri < 0 || ci >= T.w || ri >= T.h) continue;
        const s = (ri * T.w + ci) * 4, t4 = (y * ow + x) * 4;
        o[t4] = src[s]; o[t4 + 1] = src[s + 1]; o[t4 + 2] = src[s + 2]; o[t4 + 3] = src[s + 3];
      }
    }
    cx.putImageData(img, 0, 0);
    return { canvas: cv, bounds: [W, S, E, N].map(n => +n.toFixed(8)) };
  }

  // ── A DEM → a terrain patch ──────────────────────────────────────────────
  const MAX_TERRAIN_SIDE = 3000;
  /** Heights (m above the ellipsoid; dz is added to the DEM's) on a lon/lat grid: { meta, grid }. */
  function bakeTerrain(T, dz) {
    if (!T.vals) throw new Error('this is not a DEM (one band of heights)');
    const P = window.proj4;
    const fwd = T.proj === null ? (lon, lat) => [lon, lat] : (P ? (lon, lat) => P('WGS84', T.proj, [lon, lat]) : null);
    const inv = T.proj === null ? (x, y) => [x, y] : (P ? (x, y) => P(T.proj, 'WGS84', [x, y]) : null);
    if (!fwd) throw new Error('the projection library is missing');
    let W = 180, S = 90, E = -180, N = -90;
    const edge = (c, r) => { const ll = inv(...T.toXY(c, r)); W = Math.min(W, ll[0]); E = Math.max(E, ll[0]); S = Math.min(S, ll[1]); N = Math.max(N, ll[1]); };
    for (let i = 0; i <= 32; i++) { const c = T.w * i / 32, r = T.h * i / 32; edge(c, 0); edge(c, T.h); edge(0, r); edge(T.w, r); }
    if (!(E > W && N > S)) throw new Error('its position makes no sense (check its map projection)');
    const mLon = 111320 * Math.cos((S + N) / 2 * Math.PI / 180), mLat = 110540;
    const p0 = T.toXY(0, 0), p1 = T.toXY(1, 1);
    let cm = Math.max(Math.abs(p1[0] - p0[0]) * (T.proj === null ? mLon : 1), Math.abs(p1[1] - p0[1]) * (T.proj === null ? mLat : 1));
    let nx = Math.round((E - W) * mLon / cm) + 1, ny = Math.round((N - S) * mLat / cm) + 1;
    const k = Math.min(1, MAX_TERRAIN_SIDE / Math.max(nx, ny)); nx = Math.max(2, Math.round(nx * k)); ny = Math.max(2, Math.round(ny * k));
    const G = 48, gx = new Float64Array((G + 1) * (G + 1)), gy = new Float64Array((G + 1) * (G + 1));
    const t = T.toXY(0, 0), tx = T.toXY(1, 0), ty = T.toXY(0, 1);
    const a = tx[0] - t[0], b = ty[0] - t[0], c2 = tx[1] - t[1], d = ty[1] - t[1], det = a * d - b * c2;
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
      const xy = fwd(W + (E - W) * i / G, N - (N - S) * j / G), dx = xy[0] - t[0], dy = xy[1] - t[1];
      gx[j * (G + 1) + i] = (d * dx - b * dy) / det; gy[j * (G + 1) + i] = (-c2 * dx + a * dy) / det;
    }
    const z = T.vals, nd = T.nd, bad = v => v !== v || (nd != null && v === nd) || v < -1e30 || v > 1e30;
    const grid = new Float32Array(nx * ny).fill(NaN);
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < ny; y++) {
      const fy = y / (ny - 1) * G, j = Math.min(G - 1, Math.floor(fy)), v = fy - j;
      for (let x = 0; x < nx; x++) {
        const fx = x / (nx - 1) * G, i = Math.min(G - 1, Math.floor(fx)), u = fx - i, q = j * (G + 1) + i, q2 = q + G + 1;
        const sc = (gx[q] * (1 - u) + gx[q + 1] * u) * (1 - v) + (gx[q2] * (1 - u) + gx[q2 + 1] * u) * v - 0.5;     // pixel centres sit at +0.5
        const sr = (gy[q] * (1 - u) + gy[q + 1] * u) * (1 - v) + (gy[q2] * (1 - u) + gy[q2 + 1] * u) * v - 0.5;
        if (sc < -0.5 || sr < -0.5 || sc > T.w - 0.5 || sr > T.h - 0.5) continue;
        const c0 = Math.min(T.w - 2, Math.max(0, Math.floor(sc))), r0 = Math.min(T.h - 2, Math.max(0, Math.floor(sr)));
        const fc = Math.min(1, Math.max(0, sc - c0)), fr = Math.min(1, Math.max(0, sr - r0));
        const v00 = z[r0 * T.w + c0], v10 = z[r0 * T.w + c0 + 1], v01 = z[(r0 + 1) * T.w + c0], v11 = z[(r0 + 1) * T.w + c0 + 1];
        if (bad(v00) || bad(v10) || bad(v01) || bad(v11)) continue;
        const h = (v00 * (1 - fc) + v10 * fc) * (1 - fr) + (v01 * (1 - fc) + v11 * fc) * fr + dz;
        grid[y * nx + x] = h; if (h < lo) lo = h; if (h > hi) hi = h;
      }
    }
    if (!(hi > lo) && lo === Infinity) throw new Error('no heights found in it');
    return { meta: { west: W, south: S, east: E, north: N, nx, ny, units: 'm', heightReference: 'WGS84 ellipsoid', min: lo, max: hi, cell_m: +((E - W) * mLon / (nx - 1)).toFixed(3) }, grid };
  }
  /** A DEM GeoTIFF → a terrain patch in the project (or My data). Returns the layer id. */
  async function addTerrain(file, name) {
    if (!window._terrainPatch) throw new Error('the terrain patch code is missing');
    toast(`Reading ${file.name}…`);
    await new Promise(r => setTimeout(r, 30));
    const T = readTiff(await file.arrayBuffer(), true);
    if (!T.vals) throw new Error('this TIFF is not a DEM (it needs one band of heights)');
    const ll0 = (() => { const ll = window.proj4 && T.proj !== null ? window.proj4(T.proj, 'WGS84', T.toXY(T.w / 2, T.h / 2)) : T.toXY(T.w / 2, T.h / 2); return ll; })();
    const dz = typeof window._pcDatumDz === 'function' ? window._pcDatumDz(ll0[1], ll0[0]) : -24.5;
    toast('Making terrain…');
    await new Promise(r => setTimeout(r, 30));
    const { meta, grid } = bakeTerrain(T, dz);
    meta.name = name || file.name.replace(/\.(tiff?|gtiff)$/i, ''); meta.source = file.name; meta.datum_shift_m = +dz.toFixed(3);
    const packed = window._terrainPatch.pack(meta, grid), b = await store(packed, 'bin');
    await keepCopy(meta.name + ' (terrain patch).bin', packed);
    const id = 'ter-' + b.slice(0, 12);
    await record({ layer: id, kind: 'terrain', blob: b, bounds: [meta.west, meta.south, meta.east, meta.north].map(n => +n.toFixed(8)), name: meta.name });
    toast(`Terrain “${meta.name}” added: ${meta.nx}×${meta.ny} cells of ${meta.cell_m} m, heights moved ${dz.toFixed(1)} m to the ellipsoid`);
    return id;
  }

  // ── Adding ───────────────────────────────────────────────────────────────
  async function store(bytes, ext) {
    const pid = PJ().pid;
    const r = await fetch(pid ? '/api/lib/blob?ext=' + ext + '&project=' + encodeURIComponent(pid) : '/api/mine/blob?ext=' + ext, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.h) throw new Error(j.error || 'could not store it');
    return j.h + '.' + ext;
  }
  /** A visible copy in the project folder (FLEX maps/…), so the project's file list shows what FLEX made. Best effort. */
  async function keepCopy(file, bytes) {
    const pid = PJ().pid; if (!pid) return;
    try { await fetch('/api/lib/putfile?project=' + encodeURIComponent(pid) + '&path=' + encodeURIComponent('FLEX maps/' + file), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }); }
    catch (e) { console.warn('[layers] keepCopy', file, e); }
  }
  async function record(entry) {
    const pid = PJ().pid;
    const id = entry.layer;
    if (pid && A()) { await A().record('layer.set', Object.assign({ order: FL().liveLayers(PJ().P).length, removed: false }, entry)); }
    else if (MD() && MD().record) await MD().record('layer.set', Object.assign({ removed: false }, entry));
    else throw new Error('nowhere to keep it');
    setView(id, { show: true, alpha: entry.kind === 'imagery' ? 0.75 : 1 });
    await sync(true); render(true);
    return id;
  }
  /** A GeoTIFF file → a layer. Returns the layer id. */
  async function addTiff(file, name) {
    const where = PJ().pid ? `the project “${(window._pjWs && window._pjWs.projName && window._pjWs.projName()) || 'project'}”` : '👤 My data';
    toast(`Reading ${file.name}…`);
    await new Promise(r => setTimeout(r, 30));
    const T = readTiff(await file.arrayBuffer());
    const { canvas, bounds } = toLonLat(T);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.9));
    if (!blob) throw new Error('could not make the picture');
    const bytes = await blob.arrayBuffer(), b = await store(bytes, 'webp');
    const id = 'img-' + b.slice(0, 12), nm = (name || file.name.replace(/\.(tiff?|gtiff)$/i, ''));
    await keepCopy(nm + (T.dem ? ' (hillshade from DEM)' : '') + '.webp', bytes);
    await keepCopy(nm + (T.dem ? ' (hillshade from DEM)' : '') + '.json', new TextEncoder().encode(JSON.stringify({ format: 'flex-map-image', bounds: bounds, note: 'west, south, east, north in degrees; the picture is in lon/lat', source: file.name }, null, 1)));
    await record({ layer: id, kind: 'imagery', blob: b, bounds, name: name || file.name.replace(/\.(tiff?|gtiff)$/i, '') });
    toast(`${T.dem ? 'Hillshade made from the DEM' : 'Map layer'} “${file.name}” added to ${where}`);
    return id;
  }
  async function addTiles(url, name) {
    if (!/^https?:\/\/.+\{z\}.*\{x\}.*\{y\}|^https?:\/\/.+\{z\}.*\{y\}.*\{x\}/.test(url)) throw new Error('a tile link has {z}, {x} and {y} in it, e.g. https://…/{z}/{x}/{y}.png');
    const id = 'tiles-' + Math.random().toString(36).slice(2, 10);
    await record({ layer: id, kind: 'tiles', url, name: name || new URL(url.replace(/[{}]/g, '')).hostname });
    return id;
  }
  async function remove(l) {
    if (l.owner === 'p' && A()) await A().record('layer.set', { layer: l.id, removed: true });
    else if (MD() && MD().record) await MD().record('layer.set', { layer: l.id, removed: true });
    await sync(true); render(true);
  }
  async function flyTo(l) {
    const v = V(); if (!v) return;
    if (l.bounds) v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(...l.bounds), duration: 1.5 });
  }
  function pickFile(terrain) {
    const inp = document.createElement('input'); if (terrain) inp.dataset.terrain = '1'; inp.type = 'file'; inp.accept = '.tif,.tiff,image/tiff'; inp.hidden = true;
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => { const f = inp.files && inp.files[0]; inp.remove(); if (!f) return; try { await (inp.dataset.terrain ? addTerrain(f) : addTiff(f)); } catch (e) { toast('Could not add “' + f.name + '”: ' + e.message); console.warn('[layers]', e); } });
    inp.click();
  }
  async function askTiles() {
    const D = A() && A().dialog;
    let url = null;
    if (D) { const r = await D({ title: 'Add a tile link', text: 'A map served as tiles, with {z}, {x} and {y} in the link (XYZ). The link is kept with the layer: if it has a key in it, the key goes wherever the project goes.', input: { value: 'https://' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'ok', primary: true }] }); url = r && r.value; }
    else url = window.prompt('Tile link with {z}, {x}, {y}');
    if (!url || typeof url !== 'string') return;
    try { await addTiles(url.trim()); } catch (e) { toast(e.message); }
  }

  // ── Terrain section in 🗺 Layers ─────────────────────────────────────────
  // Map layers (GeoTIFF, tile links) live in the one Layers list above (flex.js renderLayerList), a 📁 in
  // front of the ones that belong to the project. Terrain patches are not map layers: their own section.
  let host = null, last = '';
  function ensureHost() {
    if (host && host.isConnected) return host;
    const body = document.getElementById('lp-layers-body'); if (!body) return null;
    const sec = body.closest('.lp-section');
    host = document.createElement('div'); host.id = 'cl-panel'; host.className = 'lp-section';
    host.innerHTML = '<div class="lp-section-header" onclick="window._lpToggle(this)"><span class="lp-section-arrow">▸</span> Terrain</div><div class="lp-section-body open" id="cl-terrain-body"></div>';
    sec.parentNode.insertBefore(host, sec.nextSibling);
    host.addEventListener('click', onClick);
    return host;
  }
  let cache = [];
  async function render(force) {
    const h = ensureHost(); if (!h) return;
    cache = (await entries(force)).filter(l => l.kind === 'terrain');
    const pj = PJ(), pjName = (window._pjWs && window._pjWs.projName && window._pjWs.projName()) || (pj.P && pj.P.name) || 'the project';
    const rows = cache.map(l => `<div class="cl-row" data-id="${esc(l.id)}">
        <button type="button" class="cl-eye${viewOf(l.id).show ? ' on' : ''}" data-act="eye" title="${viewOf(l.id).show ? 'Hide' : 'Show'}"></button>
        <span class="cl-nm" title="${esc(l.name)}">${l.owner === 'p' ? '📁 ' : '👤 '}${esc(l.name || 'Terrain')}</span>
        <span class="cl-tools"><button type="button" data-act="fly" title="Fly there">⌖</button><button type="button" data-act="rm" title="${l.owner === 'p' ? 'Remove from the project' : 'Forget (out of My data)'}">✕</button></span></div>`).join('');
    const html = `<div class="cl-row cl-base"><span></span><span class="cl-nm">🌍 World terrain <small>everywhere</small></span><span></span></div>${rows}
      <div class="cl-bar"><button type="button" data-act="terrain" title="A DEM GeoTIFF baked into precise terrain for its area; kept ${pj.pid ? 'in 📁 ' + esc(pjName) : 'in 👤 My data'}">＋ Terrain patch…</button></div>`;
    if (html === last) return;
    last = html; document.getElementById('cl-terrain-body').innerHTML = html;
  }
  async function removeById(id) {
    const l = (await entries()).find(x => x.id === id); if (!l) return;
    if (window.confirm(l.owner === 'p' ? `Remove “${l.name}” from the project? (It stays in the project's history.)` : `Forget “${l.name}”?`)) remove(l);
  }
  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'terrain') return pickFile(true);
    const row = b.closest('.cl-row'), l = row && cache.find(x => x.id === row.dataset.id); if (!l) return;
    if (act === 'eye') { setView(l.id, { show: !viewOf(l.id).show }); await sync(); render(true); }
    else if (act === 'fly') flyTo(l);
    else if (act === 'rm') removeById(l.id);
  }

  // ── Wiring: project switches, project and My data changes ────────────────
  let lastKey = '';
  setInterval(async () => {
    const pj = PJ(), key = (pj.pid || '') + '|' + ((pj.P && FL()) ? FL().liveLayers(pj.P).filter(l => KINDS.has(l.kind)).map(sigOf).join(';') : '');
    if (key !== lastKey) { lastKey = key; await sync(true); render(true); }
    // the order the person gave them in the list is kept (this computer)
    const v = V(); if (v) drawn.forEach((d, id) => { const z = v.imageryLayers.indexOf(d.layer); if (z >= 0 && views()[id] && views()[id].z !== z) setView(id, { z }); });
  }, 1500);
  document.querySelector('[data-target="#mapLayersCollapsible"]')?.addEventListener('click', () => setTimeout(() => render(true), 0));
  const st = document.createElement('style');
  st.textContent = `
  #cl-panel { margin: 0 0 8px; font-size: 11px; }
  #cl-panel .cl-row { display: grid; grid-template-columns: 14px 1fr auto; gap: 5px; align-items: center; padding: 2px 3px; border-radius: 5px; font-size: 11px; }
  #cl-panel .cl-row:hover { background: rgba(255,255,255,.07); }
  #cl-panel .cl-base small { color: rgba(255,255,255,.4); margin-left: 4px; }
  #cl-panel .cl-eye { width: 13px; height: 13px; border: 1.5px solid rgba(255,255,255,.45); border-radius: 3px; background: none; padding: 0; cursor: pointer; }
  #cl-panel .cl-eye.on { background: #e8ece9; border-color: #e8ece9; box-shadow: inset 0 0 0 2px #1d232e; }
  #cl-panel .cl-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,.88); }
  #cl-panel .cl-tools { display: inline-flex; gap: 1px; opacity: .45; } #cl-panel .cl-row:hover .cl-tools { opacity: 1; }
  #cl-panel .cl-tools button { background: none; border: none; color: rgba(255,255,255,.75); padding: 0 3px; cursor: pointer; font-size: 12px; }
  #cl-panel .cl-empty { color: rgba(255,255,255,.45); font-style: italic; font-size: 10.5px; padding: 2px 4px; }
  #cl-panel .cl-bar { display: flex; gap: 4px; margin-top: 4px; }
  #cl-panel .cl-bar button { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #e8ece9; border-radius: 5px; padding: 2px 8px; font-size: 10.5px; cursor: pointer; }
  #cl-panel .cl-bar button:hover { background: rgba(255,255,255,.12); }`;
  document.head.appendChild(st);

  window._customLayers = { sync, render, pickFile, askTiles, removeById, addTerrain, bakeTerrain, addTiff, addTiles, remove, entries, readTiff, toLonLat, hillshade, drawn };
})();
