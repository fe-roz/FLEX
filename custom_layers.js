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
  const KINDS = new Set(['imagery', 'tiles']);
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
  const srcUrl = l => (l.kind === 'imagery' ? '/api/lib/blob/' + l.blob : l.url);
  const sigOf = l => [l.kind, srcUrl(l), (l.bounds || []).join(',')].join('|');

  // ── On the globe ─────────────────────────────────────────────────────────
  const drawn = new Map();                       // id → { layer, sig }
  let chain = Promise.resolve();
  /** Make the globe match the list; calls run one after another, each waits for its turn. */
  function sync(force) { chain = chain.then(() => doSync(force)).catch(e => console.warn('[layers] sync', e)); return chain; }
  async function doSync(force) {
    const v = V(); if (!v || !window.Cesium) return;
    {
      const want = await entries(force), ids = new Set(want.map(l => l.id));
      for (const [id, d] of drawn) if (!ids.has(id) || d.sig !== sigOf(want.find(l => l.id === id))) { v.imageryLayers.remove(d.layer, true); drawn.delete(id); }
      for (const l of want) {
        if (!drawn.has(l.id)) {
          let prov = null;
          try {
            if (l.kind === 'imagery' && l.blob && l.bounds) prov = await Cesium.SingleTileImageryProvider.fromUrl(srcUrl(l), { rectangle: Cesium.Rectangle.fromDegrees(...l.bounds) });
            else if (l.kind === 'tiles' && l.url) prov = new Cesium.UrlTemplateImageryProvider({ url: l.url, maximumLevel: 20 });
          } catch (e) { console.warn('[layers] could not show', l.name, e); }
          if (!prov) continue;
          const layer = v.imageryLayers.addImageryProvider(prov);
          drawn.set(l.id, { layer, sig: sigOf(l) });
        }
        const d = drawn.get(l.id), vw = viewOf(l.id);
        d.layer.show = !!vw.show; d.layer.alpha = Math.max(0, Math.min(1, +vw.alpha));
      }
      // Above the built-in layers, in list order (the first listed on top).
      [...want].reverse().forEach(l => { const d = drawn.get(l.id); if (d) v.imageryLayers.raiseToTop(d.layer); });
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
  function readTiff(buf) {
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
    let rgba, dem = false;
    if (spp === 1 && (fmt === 3 || bps > 8)) {
      // One band of numbers (a DEM): a hillshade from it.
      const raw = new Uint8Array(ifd.data).buffer;                  // a copy, aligned
      const vals = fmt === 3 && bps === 32 ? new Float32Array(raw, 0, w * h) : fmt === 3 && bps === 64 ? new Float64Array(raw, 0, w * h)
        : bps === 16 ? (fmt === 2 ? new Int16Array(raw, 0, w * h) : new Uint16Array(raw, 0, w * h))
        : bps === 32 ? (fmt === 2 ? new Int32Array(raw, 0, w * h) : new Uint32Array(raw, 0, w * h)) : null;
      if (!vals) throw new Error('this DEM’s number type isn’t read yet');
      const p0 = toXY(0, 0), p1 = toXY(1, 1);
      let cx = Math.abs(p1[0] - p0[0]), cy = Math.abs(p1[1] - p0[1]);
      if (proj === null) { const lat = (toXY(0, h / 2)[1]) * Math.PI / 180; cx *= 111320 * Math.cos(lat); cy *= 110540; }
      rgba = hillshade(vals, w, h, cx, cy, nd);
      dem = true;
    } else {
      rgba = U.toRGBA8(ifd);
      if (nd != null && !isNaN(nd) && spp <= 3) for (let i = 0; i < w * h; i++) { const r = rgba[i * 4]; if (r === nd && rgba[i * 4 + 1] === nd && rgba[i * 4 + 2] === nd) rgba[i * 4 + 3] = 0; }
    }
    return { w, h, rgba, toXY, proj, epsg, dem };
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

  // ── Adding ───────────────────────────────────────────────────────────────
  async function store(bytes, ext) {
    const pid = PJ().pid;
    const r = await fetch(pid ? '/api/lib/blob?ext=' + ext + '&project=' + encodeURIComponent(pid) : '/api/mine/blob?ext=' + ext, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.h) throw new Error(j.error || 'could not store it');
    return j.h + '.' + ext;
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
    const b = await store(await blob.arrayBuffer(), 'webp');
    const id = 'img-' + b.slice(0, 12);
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
  function pickFile() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.tif,.tiff,image/tiff'; inp.hidden = true;
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => { const f = inp.files && inp.files[0]; inp.remove(); if (!f) return; try { await addTiff(f); } catch (e) { toast('Could not add “' + f.name + '”: ' + e.message); console.warn('[layers]', e); } });
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

  // ── The list in 🗺 Layers ────────────────────────────────────────────────
  let host = null, last = '';
  function ensureHost() {
    if (host && host.isConnected) return host;
    const body = document.getElementById('lp-layers-body'); if (!body) return null;
    const sec = body.closest('.lp-section');
    host = document.createElement('div'); host.id = 'cl-panel';
    sec.parentNode.insertBefore(host, sec);
    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    return host;
  }
  let cache = [];
  async function render(force) {
    const h = ensureHost(); if (!h) return;
    cache = await entries(force);
    const pj = PJ(), pjName = (window._pjWs && window._pjWs.projName && window._pjWs.projName()) || (pj.P && pj.P.name) || 'the project', rows = cache.map(l => {
      const vw = viewOf(l.id);
      return `<div class="cl-row" data-id="${esc(l.id)}">
        <button type="button" class="cl-eye${vw.show ? ' on' : ''}" data-act="eye" title="${vw.show ? 'Hide' : 'Show'}"></button>
        <span class="cl-nm" title="${esc(l.name)}">${l.owner === 'p' ? '📁' : '👤'} ${l.kind === 'imagery' ? '🖼' : '🧩'} ${esc(l.name || 'Layer')}</span>
        <input type="range" min="0" max="100" value="${Math.round(viewOf(l.id).alpha * 100)}" data-act="alpha" title="How see-through">
        <span class="cl-tools">${l.bounds ? '<button type="button" data-act="fly" title="Fly there">⌖</button>' : ''}<button type="button" data-act="rm" title="${l.owner === 'p' ? 'Remove from the project' : 'Forget (out of My data)'}">✕</button></span></div>`;
    }).join('');
    const html = `<div class="cl-head">Your map layers <small>${pj.pid ? 'new ones go into 📁 ' + esc(pjName) : 'new ones go into 👤 My data'}</small></div>
      ${rows || '<div class="cl-empty">A GeoTIFF (hillshade, photo, georeferenced map, or a DEM, made into a hillshade) or a tile link, drawn over the map.</div>'}
      <div class="cl-bar"><button type="button" data-act="tif">＋ GeoTIFF…</button><button type="button" data-act="tiles">＋ Tile link…</button></div>`;
    if (html === last) return;
    last = html; h.innerHTML = html;
  }
  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'tif') return pickFile();
    if (act === 'tiles') return askTiles();
    const row = b.closest('.cl-row'), l = row && cache.find(x => x.id === row.dataset.id); if (!l) return;
    if (act === 'eye') { setView(l.id, { show: !viewOf(l.id).show }); await sync(); render(); }
    else if (act === 'fly') flyTo(l);
    else if (act === 'rm') { const yes = window.confirm(l.owner === 'p' ? `Remove “${l.name}” from the project? (It stays in the project's history.)` : `Forget “${l.name}”?`); if (yes) remove(l); }
  }
  function onInput(e) {
    const r = e.target.closest('[data-act="alpha"]'); if (!r) return;
    const row = r.closest('.cl-row'); const id = row.dataset.id;
    setView(id, { alpha: r.value / 100 });
    const d = drawn.get(id); if (d) d.layer.alpha = r.value / 100;
    const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
    last = '';
  }

  // ── Wiring: project switches, project and My data changes ────────────────
  let lastKey = '';
  setInterval(async () => {
    const pj = PJ(), key = (pj.pid || '') + '|' + ((pj.P && FL()) ? FL().liveLayers(pj.P).filter(l => KINDS.has(l.kind)).map(sigOf).join(';') : '');
    if (key !== lastKey) { lastKey = key; await sync(true); render(true); }
  }, 1500);
  document.querySelector('[data-target="#mapLayersCollapsible"]')?.addEventListener('click', () => setTimeout(() => render(true), 0));
  const st = document.createElement('style');
  st.textContent = `
  #cl-panel { margin: 0 0 8px; font-size: 11px; }
  #cl-panel .cl-head { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: rgba(255,255,255,.55); margin: 2px 0 4px; }
  #cl-panel .cl-head small { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 6px; color: rgba(255,255,255,.4); }
  #cl-panel .cl-row { display: grid; grid-template-columns: 14px 1fr 70px auto; gap: 5px; align-items: center; padding: 2px 3px; border-radius: 5px; }
  #cl-panel .cl-row:hover { background: rgba(255,255,255,.07); }
  #cl-panel .cl-eye { width: 13px; height: 13px; border: 1.5px solid rgba(255,255,255,.45); border-radius: 3px; background: none; padding: 0; cursor: pointer; }
  #cl-panel .cl-eye.on { background: #e8ece9; border-color: #e8ece9; box-shadow: inset 0 0 0 2px #1d232e; }
  #cl-panel .cl-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,.88); }
  #cl-panel input[type=range] { width: 70px; margin: 0; }
  #cl-panel .cl-tools { display: inline-flex; gap: 1px; opacity: .45; } #cl-panel .cl-row:hover .cl-tools { opacity: 1; }
  #cl-panel .cl-tools button { background: none; border: none; color: rgba(255,255,255,.75); padding: 0 3px; cursor: pointer; font-size: 12px; }
  #cl-panel .cl-empty { color: rgba(255,255,255,.45); font-style: italic; font-size: 10.5px; padding: 2px 4px; }
  #cl-panel .cl-bar { display: flex; gap: 4px; margin-top: 4px; }
  #cl-panel .cl-bar button { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #e8ece9; border-radius: 5px; padding: 2px 8px; font-size: 10.5px; cursor: pointer; }
  #cl-panel .cl-bar button:hover { background: rgba(255,255,255,.12); }`;
  document.head.appendChild(st);

  window._customLayers = { sync, render, addTiff, addTiles, remove, entries, readTiff, toLonLat, hillshade, drawn };
})();
