// custom-layers.js — your own map layers, in 🗺 Layers → "Your map layers":
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
// Also listed (owner 'c', read-only): the loaded CalTopo map's own custom layers
// (caltopo-layers.js, window._ctLayers), drawn like tile links, marked with a map
// icon; they come and go with the CalTopo map. A tile layer whose tiles don't load
// gets a plain warning (toast, "no tiles" on its row).
//
// Library entries: layer.set { layer, kind: 'imagery', blob: '<sha>.webp',
// bounds: [west, south, east, north], name } or { kind: 'tiles', url, name }
// (+ bounds, minZoom, maxZoom for the tiles a project made), or { kind: 'terrain',
// blob: '<sha>.bin', bounds, name } (a terrain patch, terrain-patch.js).
//
// Terrain patches (kind 'terrain') are listed, generated and moved in the ⛰ Terrain panel
// (terrain-panel.js); this file reads them, puts them over the globe's terrain (syncTerrain)
// and bakes a DEM GeoTIFF into one (addTerrain). `window._customLayers.api` is what the
// panel uses of it.
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
  const defs = new Map();                        // a first look other than shown / opaque (CalTopo map layers: caltopo-layers.js)
  const viewOf = id => Object.assign({ show: true, alpha: 1 }, defs.get(id) || {}, views()[id] || {});
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
    // The loaded CalTopo map's own custom layers (read-only; they come and go with the map).
    if (window._ctLayers) window._ctLayers.list().forEach(l => { defs.set(l.id, { show: !!l.defShow, alpha: l.defAlpha }); out.push(Object.assign({ owner: 'c' }, l)); });
    return out;
  }
  const srcUrl = l => (l.kind === 'imagery' || l.kind === 'terrain' ? '/api/lib/blob/' + l.blob : l.url);
  const sigOf = l => [l.kind, srcUrl(l), (l.bounds || []).join(','), l.maxZoom, l.minZoom].join('|');

  // ── On the globe ─────────────────────────────────────────────────────────
  const drawn = new Map();                       // 'p:<id>' / 'm:<id>' → { layer, sig, id } (the same file can be in the project and in My data)
  const keyOf = l => l.owner + ':' + l.id;
  let chain = Promise.resolve();
  // What the globe was last synced to: the open project and its layers. Every
  // sync sets it, not only the 1.5 s check below. Before, a project opened, given
  // a layer (drawn by that add's own sync) and closed within one check looked
  // unchanged to the check, so the project's layer stayed on the globe.
  let lastKey = '';
  const projKey = () => { const pj = PJ(); return (pj.pid || '') + '|' + ((pj.P && FL()) ? FL().liveLayers(pj.P).filter(l => KINDS.has(l.kind)).map(sigOf).join(';') : ''); };
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
      lastKey = projKey();
      const want = await entries(force), ids = new Set(want.map(keyOf));
      await syncTerrain(want);
      let listChanged = false;
      for (const [k, d] of drawn) if (!ids.has(k) || d.sig !== sigOf(want.find(l => keyOf(l) === k))) { v.imageryLayers.remove(d.layer, true); drawn.delete(k); listChanged = true; }
      for (const l of want) {
        if (l.kind === 'terrain') continue;
        if (!drawn.has(keyOf(l))) {
          let prov = null;
          try {
            if (l.kind === 'imagery' && l.blob && l.bounds) prov = await Cesium.SingleTileImageryProvider.fromUrl(srcUrl(l), { rectangle: Cesium.Rectangle.fromDegrees(...l.bounds) });
            else if (l.kind === 'tiles' && l.url) prov = new Cesium.UrlTemplateImageryProvider({ url: l.url, maximumLevel: l.maxZoom != null ? l.maxZoom : 20, minimumLevel: l.minZoom || 0,
              rectangle: l.bounds ? Cesium.Rectangle.fromDegrees(...l.bounds) : undefined });     // a project's own tiles: only where and at the levels they exist
          } catch (e) { console.warn('[layers] could not show', l.name, e); }
          if (!prov) continue;
          watchTiles(prov, l);
          const z0 = views()[l.id] && views()[l.id].z, vw0 = viewOf(l.id);
          const layer = v.imageryLayers.addImageryProvider(prov, z0 != null ? Math.min(Math.max(0, z0), v.imageryLayers.length) : undefined);
          layer.show = !!vw0.show; layer.alpha = Math.max(0, Math.min(1, +vw0.alpha));
          layer.name = l.name || 'Layer'; layer._custom = { id: l.id, owner: l.owner, warn: '' };       // shows in the one list (flex.js renderLayerList)
          Cesium.knockout.track(layer, ['alpha', 'show', 'name']);
          const kid = l.id;
          Cesium.knockout.getObservable(layer, 'show').subscribe(s => setView(kid, { show: !!s }));
          Cesium.knockout.getObservable(layer, 'alpha').subscribe(a => setView(kid, { alpha: +a }));
          drawn.set(keyOf(l), { layer, sig: sigOf(l), id: l.id });
          prov._flexLayer = layer;
          listChanged = true;
        }
        const d = drawn.get(keyOf(l)), vw = viewOf(l.id);
        d.layer.show = !!vw.show; d.layer.alpha = Math.max(0, Math.min(1, +vw.alpha));
      }
      if (listChanged && window._updateLayerList) { window._updateLayerList(); if (window._renderLayerList) window._renderLayerList(); }
      if (v.scene.requestRender) v.scene.requestRender();
    }
  }

  // A tile layer whose tiles don't come: a plain warning (once, and on its row), not an error.
  // Cesium reports each failed tile on errorEvent (a listener also keeps it out of the console);
  // a few failures and not one tile → the warning. Missing tiles here and there are normal.
  function watchTiles(prov, l) {
    let bad = 0, good = 0, warned = false;
    const req = prov.requestImage;
    if (typeof req === 'function') prov.requestImage = function () {
      const pr = req.apply(this, arguments);
      if (pr && pr.then) pr.then(img => { if (img) good++; }, () => {});
      return pr;
    };
    if (prov.errorEvent) prov.errorEvent.addEventListener(err => {
      if (err) err.retry = false;
      bad++;
      if (warned || good > 0 || bad < 3) return;
      warned = true;
      const where = l.owner === 'c' ? 'CalTopo map layer' : 'Map layer';
      const why = l.owner === 'c' ? 'the link may need a CalTopo sign-in or a key, its server may not allow other sites, or you are offline' : 'check the link, or you may be offline';
      const msg = `${where} “${l.name}”: its tiles don’t load (${why}).`;
      console.warn('[layers] ' + msg);
      toast(msg);
      const layer = prov._flexLayer;
      if (layer && layer._custom) { layer._custom.warn = 'Its tiles don’t load: ' + why; if (window._renderLayerList) window._renderLayerList(); }
    });
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
      const bytes = new Uint8Array(ifd.data).buffer;                // a copy, aligned (not "raw": that is the argument)
      vals = fmt === 3 && bps === 32 ? new Float32Array(bytes, 0, w * h) : fmt === 3 && bps === 64 ? new Float64Array(bytes, 0, w * h)
        : bps === 16 ? (fmt === 2 ? new Int16Array(bytes, 0, w * h) : new Uint16Array(bytes, 0, w * h))
        : bps === 32 ? (fmt === 2 ? new Int32Array(bytes, 0, w * h) : new Uint32Array(bytes, 0, w * h)) : null;
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
  /** A DEM → terrain patches (terrain-patch.js bake): one, or a few overlapping ones for a big area. [{ meta, grid }] */
  async function bakeTerrain(T, dz) { return (await window._terrainPatch.bake(T, dz)).tiles; }
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
    const base = name || file.name.replace(/\.(tiff?|gtiff)$/i, ''), ids = [];
    let first = null, cell = 0, n = 0;
    // each patch is stored and let go as it is made (a big area is up to MAX_TILES of 36 MB)
    const res = await window._terrainPatch.bake(T, dz, async (r, k, plan) => {
      const meta = r.meta; cell = meta.cell_m; n++;
      const parts = plan.tiles.length;
      meta.name = parts > 1 ? `${base} (part ${k + 1})` : base; meta.source = file.name; meta.datum_shift_m = +dz.toFixed(3);
      if (parts > 1) meta.part = k + 1;
      const packed = window._terrainPatch.pack(meta, r.grid), b = await store(packed, 'bin');
      await keepCopy(meta.name + ' (terrain patch).bin', packed);
      const id = 'ter-' + b.slice(0, 12);
      await record({ layer: id, kind: 'terrain', blob: b, bounds: [meta.west, meta.south, meta.east, meta.north].map(n => +n.toFixed(8)), name: meta.name });
      ids.push(id); if (!first) first = meta;
    });
    const cut = res.plan.cell_m > (first.dem_cell_m || 0) * 1.02 ? `; the DEM is ${first.dem_cell_m} m, so its posts were widened to fit ${res.plan.tiles.length} patches` : '';
    toast(`Terrain “${base}” added: ${n > 1 ? n + ' patches of up to ' + first.nx + '×' + first.ny : first.nx + '×' + first.ny} posts of ${cell} m, heights moved ${dz.toFixed(1)} m to the ellipsoid${cut}`);
    return ids[0];
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
  /** Keep a layer entry in the open project, or in My data (no project open, or dest 'mine'). */
  async function record(entry, view, dest) {
    const pid = dest === 'mine' ? null : PJ().pid;
    const id = entry.layer;
    if (pid && A()) { await A().record('layer.set', Object.assign({ order: FL().liveLayers(PJ().P).length, removed: false }, entry)); }
    else if (MD() && MD().record) await MD().record('layer.set', Object.assign({ removed: false }, entry));
    else throw new Error('nowhere to keep it');
    setView(id, Object.assign({ show: true, alpha: entry.kind === 'imagery' ? 0.75 : 1 }, view || {}));
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

  // ── Terrain: its own panel now (⛰ in the icon strip, terrain-panel.js) ──────
  // This file keeps the data and the drawing of terrain patches (entries, sync, addTerrain, record); the panel lists
  // them, generates them and moves them. Map layers (GeoTIFF, tile links) live in the one Layers list above
  // (flex.js renderLayerList), a 📁 in front of the ones that belong to the project.
  async function render(force) {
    const all = await entries(force);
    fillExport(all);
    window.dispatchEvent(new CustomEvent('flex-custom-layers'));      // the Terrain panel redraws
  }

  // ── In the offline exports (index.html export dialog; server.js → export_terrain.py) ─────────
  // The project's terrain patches that cover the export box go over the map terrain (Terrain: Map terrain), at their own
  // resolution. A map layer can be the viewer's satellite or hillshade picture: a GeoTIFF layer is the picture FLEX
  // made from it (no internet); a tile link (project tiles, CalTopo layer, any XYZ / TMS link) is downloaded while the
  // export runs (it needs the internet, unless the tiles are on this computer), cut to the area and baked in; if that fails
  // the export takes Bing imagery (hillshade: shades the terrain) and says so in its log. WMS links are not exported.
  const exportable = l => (l.kind === 'imagery' && l.blob && l.bounds) || (l.kind === 'tiles' && l.url && /\{z\}/.test(l.url) && /\{x\}/.test(l.url) && /\{(y|-y|reverseY)\}/.test(l.url));
  function fillExport(all) {
    const sat = document.getElementById('export_satellite_source'), hs = document.getElementById('export_hillshade_mode');
    if (!sat || !hs) return;
    const ls = all.filter(exportable), sig = ls.map(l => keyOf(l) + '|' + l.name).join(';');
    if (fillExport.sig === sig) return;
    fillExport.sig = sig;
    for (const sel of [sat, hs]) {
      const cur = sel.value;
      [...sel.options].filter(o => o.value.startsWith('layer:')).forEach(o => o.remove());
      for (const l of ls) { const o = document.createElement('option'); o.value = 'layer:' + keyOf(l); o.textContent = '🗺 ' + (l.owner === 'p' ? '📁 ' : l.owner === 'c' ? '' : '👤 ') + (l.name || 'Layer') + (l.kind === 'tiles' ? ' (tile link, needs internet)' : ''); sel.appendChild(o); }
      if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    }
    const note = document.getElementById('export_layers_note');
    if (note) note.textContent = ls.length ? 'Your map layers can be used as the satellite or hillshade picture: a GeoTIFF layer is baked in as it is; a tile link is downloaded during the export (needs the internet) and falls back to the usual source if it fails. With Terrain: Map terrain, the project’s terrain patches that cover the area are used too.' : '';
  }
  /** Fill an export request: the project's terrain patches over the box, and the chosen layers. `o`: { w, s, e, n, mapTerrain, satelliteSource, hillshadeMode }. */
  async function exportExtras(body, o) {
    const all = await entries(false), byKey = new Map(all.map(l => [keyOf(l), l]));
    if (o.mapTerrain) {
      const hit = all.filter(l => l.kind === 'terrain' && l.blob && l.bounds && viewOf(l.id).show && l.bounds[2] > o.w && l.bounds[0] < o.e && l.bounds[3] > o.s && l.bounds[1] < o.n);
      if (hit.length) body.terrain_patches = hit.map(l => l.blob);
    }
    const desc = l => l.kind === 'imagery' ? { kind: 'imagery', blob: l.blob, bounds: l.bounds, name: l.name } : { kind: 'tiles', url: l.url, name: l.name };
    const sat = byKey.get(String(o.satelliteSource || '').replace(/^layer:/, ''));
    if (/^layer:/.test(o.satelliteSource || '') && sat && exportable(sat)) { body.satellite_source = 'layer'; body.satellite_layer = desc(sat); }
    else if (/^layer:/.test(o.satelliteSource || '')) body.satellite_source = 'bing';
    const hs = byKey.get(String(o.hillshadeMode || '').replace(/^layer:/, ''));
    if (/^layer:/.test(o.hillshadeMode || '') && hs && exportable(hs)) { body.hillshade_mode = 'layer'; body.hillshade_layer = desc(hs); }
    else if (/^layer:/.test(o.hillshadeMode || '')) body.hillshade_mode = o.mapTerrain ? 'dem' : 'lidar';
    return body;
  }
  async function removeById(id) {
    const l = (await entries()).find(x => x.id === id); if (!l) return;
    if (l.owner === 'c') {                       // CalTopo's: FLEX doesn't change the map; hidden here instead
      setView(l.id, { show: false }); await sync(); if (window._renderLayerList) window._renderLayerList();
      toast(`“${l.name}” is part of the CalTopo map: hidden here. Remove it in CalTopo to drop it.`);
      return;
    }
    if (window.confirm(l.owner === 'p' ? `Remove “${l.name}” from the project? (It stays in the project's history.)` : `Forget “${l.name}”?`)) remove(l);
  }
  // ── Wiring: project switches, project and My data changes ────────────────
  setInterval(async () => {
    const key = projKey();
    if (key !== lastKey) { lastKey = key; await sync(true); render(true); }
    // the order the person gave them in the list is kept (this computer)
    const v = V(); if (v) drawn.forEach(d => { const id = d.id, z = v.imageryLayers.indexOf(d.layer); if (z >= 0 && views()[id] && views()[id].z !== z) setView(id, { z }); });
  }, 1500);
  document.querySelector('[data-target="#mapLayersCollapsible"]')?.addEventListener('click', () => setTimeout(() => render(true), 0));
  const st = document.createElement('style');
  st.textContent = `
  #lp-layers-body .lp-ct-ico { vertical-align: -2px; opacity: .85; }`;
  document.head.appendChild(st);

  // (Generate lives in terrain-panel.js; `gen` stays here for the callers that used it: it opens the panel's form.)
  const gen = { toggle: on => window._terrainPanel && window._terrainPanel.generate(on), isOpen: () => !!(window._terrainPanel && window._terrainPanel.generateOpen()), busy: () => !!(window._terrainPanel && window._terrainPanel.busy()) };
  // What the Terrain panel needs of the data side (an object, not a function: the hooks list is unchanged).
  const api = { viewOf, setView, flyTo, record, store, keepCopy, projectName: () => (window._pjWs && window._pjWs.projName && window._pjWs.projName()) || (PJ().P && PJ().P.name) || 'the project' };
  window._customLayers = { exportExtras, fillExport, keyOf, gen, api, sync, render, pickFile, askTiles, removeById, addTerrain, bakeTerrain, addTiff, addTiles, remove, entries, readTiff, toLonLat, hillshade, drawn };
})();
