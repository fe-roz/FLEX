// area_tiles.js — a processed area's maps as coloured XYZ tiles (mounted by areas_api.js under /api/areas/).
//
//   GET /api/areas/maps/<areaId>                                   { ok, maps: [{ id, folder, units, min, max, suggest, cell, levels, values, cuts }],
//                                                                    bounds: [w, s, e, n], minZoom, maxZoom, legacy: [...] }
//   GET /api/areas/tiles/<areaId>/<map>/<z>/<x>/<y>.png?ramp=<stops>&lo=<v>&hi=<v>[&v=<ver>]   (v: the file's time, so a
//                                                                  refreshed map is a new URL; not read here)
//
// The maps are the area's saved value rasters (area_maps.py): bush/brush.u8, bush/voids.u8, ground/slope.u8,
// ground/hillshade.u8, each listed in its folder's maps.json (each folder its own grid). One byte per cell: 0 = no data,
// 1..16 = the level whose value maps.json lists (`values`); files without `values` (version 1): 1..255 over min..max.
// Only the colours are made here, per request: `ramp` is up to MAX_STOPS stops "<pos>:<RRGGBBAA>" joined by "_"
// (pos 0..1, increasing), linear between stops; lo / hi = the values put at 0 and 1 (default: the map's suggest).
// Each tile pixel's centre is taken to UTM (WGS84 transverse Mercator, zone from maps.json) and the nearest cell is
// read (zoomed out: the mean of up to 4 x 4 cells per pixel; zoomed in past the cell, slope and hillshade bilinear
// between cell centres, unless &smooth=0); the colour is taken for the VALUE (a 1024-step palette over lo..hi), so a
// step ramp (brush classes) stays sharp. The file is read by offset, only the rows the tile touches. Outside the grid or
// no data = transparent.
// A new ramp is a new URL, so the browser may keep each tile for a day.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAPS = { brush: 'bush', voids: 'bush', slope: 'ground', hillshade: 'ground' };
const MAX_STOPS = 16, T = 256;
const MIN_ZOOM = 11;
const SMOOTH = new Set(['slope', 'hillshade']);     // drawn bilinear when zoomed in past the cell

// ── PNG ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); o.write(type, 4, 'latin1'); data.copy(o, 8);
  o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length); return o;
}
/** RGBA 8-bit PNG from `px` (w * h * 4 bytes). */
function pngRGBA(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 4 })), chunk('IEND', Buffer.alloc(0))]);
}
const BLANK = pngRGBA(1, 1, Buffer.alloc(4));

// ── Ramps ──
/** "<pos>:<RRGGBBAA>_..." → [{ p, r, g, b, a }] (a 0..255) or null when anything is off. */
function parseRamp(s) {
  if (typeof s !== 'string' || s.length > 400) return null;
  const parts = s.split('_');
  if (parts.length < 2 || parts.length > MAX_STOPS) return null;
  const out = [];
  for (const q of parts) {
    const m = /^(0|1|0?\.\d{1,4}|1\.0{1,4})[:,]([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(q);
    if (!m) return null;
    const p = +m[1], h = m[2];
    if (out.length && p < out[out.length - 1].p) return null;
    out.push({ p, r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: m[3] ? parseInt(m[3], 16) : 255 });
  }
  return out;
}
/** Stops → the compact query form (positions to 3 decimals). */
function rampString(stops) {
  const hx = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return stops.map(s => String(+(+s.p).toFixed(3)) + ':' + hx(s.r) + hx(s.g) + hx(s.b) + hx(s.a == null ? 255 : s.a)).join('_');
}
/** Colour at t (0..1): [r, g, b, a]. */
function rampAt(stops, t) {
  if (!(t >= stops[0].p)) { const s = stops[0]; return [s.r, s.g, s.b, s.a]; }
  for (let i = 1; i < stops.length; i++) {
    const A = stops[i - 1], B = stops[i];
    if (t <= B.p) { const k = B.p > A.p ? (t - A.p) / (B.p - A.p) : 1; return [A.r + (B.r - A.r) * k, A.g + (B.g - A.g) * k, A.b + (B.b - A.b) * k, A.a + (B.a - A.a) * k].map(Math.round); }
  }
  const s = stops[stops.length - 1]; return [s.r, s.g, s.b, s.a];
}
/** The value each byte stands for (index 0 = no data): version 2 files list `values` (16 levels), version 1 files are
 *  1..255 over min..max. */
function valuesOf(m) {
  const V = new Float64Array(256).fill(NaN);
  if (Array.isArray(m.values) && m.values.length >= 2 && m.values.length <= 255 && m.values.every(Number.isFinite)) m.values.forEach((v, i) => { V[i + 1] = v; });
  else for (let b = 1; b < 256; b++) V[b] = m.min + (b - 1) / 254 * (m.max - m.min);
  return V;
}
const PAL = 1024;
/** PAL × RGBA colours over lo..hi (value → colour: palIndex()). */
function palette(stops, lo, hi) {
  const L = Buffer.alloc(PAL * 4);
  for (let i = 0; i < PAL; i++) { const c = rampAt(stops, i / (PAL - 1)); L[i * 4] = c[0]; L[i * 4 + 1] = c[1]; L[i * 4 + 2] = c[2]; L[i * 4 + 3] = c[3]; }
  return { L, lo, span: hi - lo || 1e-9 };
}
const palIndex = (P, v) => Math.max(0, Math.min(PAL - 1, Math.round((v - P.lo) / P.span * (PAL - 1)))) * 4;
/** 256 × RGBA lookup for bytes (0 transparent), for the tests and old callers. */
function lut(stops, min, max, lo, hi, m) {
  const V = valuesOf(m || { min, max }), P = palette(stops, lo, hi), L = Buffer.alloc(256 * 4);
  for (let b = 1; b < 256; b++) { if (V[b] !== V[b]) continue; const q = palIndex(P, V[b]); P.L.copy(L, b * 4, q, q + 4); }
  return L;
}

// ── Lon/lat → UTM (WGS84; Krüger series, sub-millimetre inside a zone) ──
const A_ = 6378137, F_ = 1 / 298.257223563, K0 = 0.9996;
const N_ = F_ / (2 - F_), AA = A_ / (1 + N_) * (1 + N_ * N_ / 4 + N_ ** 4 / 64);
const AL = [N_ / 2 - 2 * N_ ** 2 / 3 + 5 * N_ ** 3 / 16, 13 * N_ ** 2 / 48 - 3 * N_ ** 3 / 5, 61 * N_ ** 3 / 240];
const E2 = 2 * Math.sqrt(N_) / (1 + N_);
/** → [x, y] in metres of UTM `zone` (south: northing + 10 000 km). */
function utm(lon, lat, zone, south) {
  const lon0 = (zone * 6 - 183) * Math.PI / 180, phi = lat * Math.PI / 180, lam = lon * Math.PI / 180 - lon0;
  const s = Math.sin(phi), t = Math.sinh(Math.atanh(s) - E2 * Math.atanh(E2 * s));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 3; j++) { x += AL[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); y += AL[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); }
  return [500000 + K0 * AA * x, K0 * AA * y + (south ? 10000000 : 0)];
}
/** UTM → lon/lat by Newton steps on utm() (for the bounds only). */
function lonlatOf(x, y, zone, south) {
  let lon = zone * 6 - 183, lat = (y - (south ? 10000000 : 0)) / 110950;
  for (let i = 0; i < 6; i++) {
    const p = utm(lon, lat, zone, south), d = 1e-4, px = utm(lon + d, lat, zone, south), py = utm(lon, lat + d, zone, south);
    const a = (px[0] - p[0]) / d, b = (py[0] - p[0]) / d, c = (px[1] - p[1]) / d, e = (py[1] - p[1]) / d, det = a * e - b * c;
    const dx = x - p[0], dy = y - p[1]; lon += (e * dx - b * dy) / det; lat += (-c * dx + a * dy) / det;
  }
  return [lon, lat];
}
/** Lon/lat → [col, row] (fractional cell coordinates, row as stored per row0) or null outside. */
function cellOf(G, lon, lat) {
  const p = utm(lon, lat, G.zone, G.south);
  const c = (p[0] - G.x0) / G.cell, rs = (p[1] - G.y0) / G.cell;           // rs: rows from the south edge
  if (c < 0 || rs < 0 || c >= G.nx || rs >= G.ny) return null;
  return [c, G.row0 === 'south' ? rs : G.ny - rs];
}
const tileLon = (x, z) => x / Math.pow(2, z) * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / Math.pow(2, z)))) * 180 / Math.PI;

module.exports = function areaTiles({ root, cacheTiles = 400, openFiles = 12 }) {
  const metaCache = new Map();     // dir → { mtime, j }
  const fds = new Map();           // file → { fd, size }   (least recently used closed past `openFiles`)
  const tiles = new Map();         // key → png             (bounded, least recently used out)

  function mapsOf(id, folder) {
    const f = path.join(root, id, folder, 'maps.json');
    let st; try { st = fs.statSync(f); } catch (_) { return null; }
    const c = metaCache.get(f); if (c && c.mtime === st.mtimeMs) return c.j;
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
    const G = j && j.grid;
    if (!G || ![G.x0, G.y0, G.cell, G.nx, G.ny, G.zone].every(Number.isFinite) || G.cell <= 0 || !Array.isArray(j.maps)) return null;
    metaCache.set(f, { mtime: st.mtimeMs, j }); return j;
  }
  /** → { G, m, file } for an area's map, or null. */
  function mapInfo(id, map) {
    if (!ID_RE.test(String(id)) || !MAPS[map]) return null;
    const j = mapsOf(id, MAPS[map]); if (!j) return null;
    const m = j.maps.find(x => x && x.id === map && /^[a-z]+\.u8$/.test(String(x.file)));
    if (!m || !Number.isFinite(m.min) || !Number.isFinite(m.max) || m.max <= m.min) return null;
    return { G: j.grid, m, V: valuesOf(m), file: path.join(root, id, MAPS[map], m.file) };
  }
  function openFd(file) {
    let e = fds.get(file);
    if (e) { fds.delete(file); fds.set(file, e); return e; }
    const fd = fs.openSync(file, 'r'); e = { fd, size: fs.fstatSync(fd).size };
    fds.set(file, e);
    while (fds.size > openFiles) { const [k, v] = fds.entries().next().value; fds.delete(k); try { fs.closeSync(v.fd); } catch (_) {} }
    return e;
  }

  /** The tile as RGBA pixels (Buffer T*T*4) or null when nothing in it has data.
   *  Zoomed out (a pixel wider than a cell): the mean of k x k cells spread over the pixel (k up to 4).
   *  Zoomed in past the cell, for `smooth` maps (slope, hillshade): bilinear between the four nearest cell centres,
   *  so close up the map is soft instead of hard squares. Otherwise the nearest cell. */
  function render(info, P, z, x, y, smooth) {
    const { G } = info, nx = G.nx, ny = G.ny, V = info.V;
    const e = openFd(info.file);
    if (e.size < nx * ny) throw new Error('the map file is shorter than its grid');
    // UTM at the pixel corners (T+1)^2, exact; inside a pixel the samples are interpolated between them
    const N1 = T + 1, cu = new Float64Array(N1 * N1), cv = new Float64Array(N1 * N1);
    for (let py = 0; py <= T; py++) {
      const lat = tileLat(y + py / T, z);
      for (let px = 0; px <= T; px++) { const p = utm(tileLon(x + px / T, z), lat, G.zone, G.south); cu[py * N1 + px] = (p[0] - G.x0) / G.cell; cv[py * N1 + px] = (p[1] - G.y0) / G.cell; }
    }
    const span = Math.hypot(cu[1] - cu[0], cv[1] - cv[0]), bil = smooth && span < 0.9;
    const k = bil ? 1 : Math.max(1, Math.min(4, Math.round(span))), per = bil ? 4 : k * k;
    const S = T * T * per, col = new Int32Array(S).fill(-1), row = new Int32Array(S), wt = new Float32Array(S);
    const rowOf = rs => (G.row0 === 'south' ? rs : ny - 1 - rs);
    let rmin = Infinity, rmax = -1, n = 0;
    const put = (c, rs, w) => { if (c < 0 || rs < 0 || c >= nx || rs >= ny || w <= 0) { n++; return; } const r = rowOf(rs); col[n] = c; row[n] = r; wt[n] = w; n++; if (r < rmin) rmin = r; if (r > rmax) rmax = r; };
    for (let py = 0; py < T; py++) for (let px = 0; px < T; px++) {
      const a = py * N1 + px, b = a + 1, c = a + N1, d = c + 1;
      if (bil) {
        const u = (cu[a] + cu[b] + cu[c] + cu[d]) / 4 - 0.5, v = (cv[a] + cv[b] + cv[c] + cv[d]) / 4 - 0.5;
        if (u < -0.5 || v < -0.5 || u > nx - 0.5 || v > ny - 0.5) { n += 4; continue; }
        const c0 = Math.floor(u), r0 = Math.floor(v), fx = u - c0, fy = v - r0;
        put(c0, r0, (1 - fx) * (1 - fy)); put(c0 + 1, r0, fx * (1 - fy)); put(c0, r0 + 1, (1 - fx) * fy); put(c0 + 1, r0 + 1, fx * fy);
        continue;
      }
      for (let sy = 0; sy < k; sy++) { const ty = (sy + 0.5) / k; for (let sx = 0; sx < k; sx++) {
        const tx = (sx + 0.5) / k;
        const u = (cu[a] * (1 - tx) + cu[b] * tx) * (1 - ty) + (cu[c] * (1 - tx) + cu[d] * tx) * ty;
        const v = (cv[a] * (1 - tx) + cv[b] * tx) * (1 - ty) + (cv[c] * (1 - tx) + cv[d] * tx) * ty;
        put(Math.floor(u), Math.floor(v), 1);
      } }
    }
    if (rmax < 0) return null;
    // the rows hit, each read once over the columns it needs
    const nr = rmax - rmin + 1, lo = new Int32Array(nr).fill(nx), hi = new Int32Array(nr).fill(-1);
    for (let q = 0; q < S; q++) if (col[q] >= 0) { const i = row[q] - rmin; if (col[q] < lo[i]) lo[i] = col[q]; if (col[q] > hi[i]) hi[i] = col[q]; }
    const bufs = new Array(nr);
    for (let i = 0; i < nr; i++) if (hi[i] >= 0) { const len = hi[i] - lo[i] + 1, bb = Buffer.alloc(len); fs.readSync(e.fd, bb, 0, len, (rmin + i) * nx + lo[i]); bufs[i] = bb; }
    const out = Buffer.alloc(T * T * 4); let any = false;
    for (let p = 0; p < T * T; p++) {
      let sum = 0, ws = 0;
      for (let q = p * per, qe = q + per; q < qe; q++) { if (col[q] < 0) continue; const i = row[q] - rmin, b = bufs[i][col[q] - lo[i]]; if (b) { const val = V[b]; if (val === val) { sum += val * wt[q]; ws += wt[q]; } } }
      if (!(ws > 0)) continue;
      const o = p * 4, idx = palIndex(P, sum / ws);
      out[o] = P.L[idx]; out[o + 1] = P.L[idx + 1]; out[o + 2] = P.L[idx + 2]; out[o + 3] = P.L[idx + 3];
      if (P.L[idx + 3]) any = true;
    }
    return any ? out : null;
  }

  const send = (res, status, type, buf, cache) => { res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': cache }); res.end(buf); };
  const json = (res, d, status = 200) => send(res, status, 'application/json', Buffer.from(JSON.stringify(d)), 'no-store');

  /** GET tiles/<id>/<map>/<z>/<x>/<y>.png */
  function tile(res, rest, query) {
    const m = /^([A-Za-z0-9_-]{1,40})\/([a-z]{1,20})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.png$/.exec(rest);
    if (!m) return json(res, { ok: false, error: 'bad tile' }, 400);
    const z = +m[3], x = +m[4], y = +m[5];
    if (z > 22 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) return json(res, { ok: false, error: 'bad tile' }, 400);
    const info = mapInfo(m[1], m[2]); if (!info) return json(res, { ok: false, error: 'not found' }, 404);
    const q = query || {}, sug = Array.isArray(info.m.suggest) ? info.m.suggest : [info.m.min, info.m.max];
    const stops = q.ramp == null || q.ramp === '' ? DEFAULT_RAMP : parseRamp(String(q.ramp));
    if (!stops) return json(res, { ok: false, error: 'bad ramp' }, 400);
    const num = (v, d) => (v == null || v === '' ? d : (/^-?\d{1,6}(\.\d{1,6})?$/.test(String(v)) ? +v : NaN));
    const lo = num(q.lo, +sug[0]), hi = num(q.hi, +sug[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return json(res, { ok: false, error: 'bad range' }, 400);
    let mt = 0; try { mt = fs.statSync(info.file).mtimeMs; } catch (_) { return json(res, { ok: false, error: 'not found' }, 404); }
    const key = [m[1], m[2], z, x, y, rampString(stops), lo, hi, mt, q.smooth === '0' ? 0 : 1].join('|');
    let png = tiles.get(key);
    if (png) { tiles.delete(key); tiles.set(key, png); }
    else {
      try { const px = render(info, palette(stops, lo, hi), z, x, y, SMOOTH.has(m[2]) && q.smooth !== '0'); png = px ? pngRGBA(T, T, px) : BLANK; }
      catch (e) { return json(res, { ok: false, error: e.message }, 500); }
      tiles.set(key, png); while (tiles.size > cacheTiles) tiles.delete(tiles.keys().next().value);
    }
    send(res, 200, 'image/png', png, 'max-age=86400');
  }

  /** GET maps/<id>: what the browser needs to list the area's map layers. */
  function maps(res, id) {
    if (!ID_RE.test(String(id))) return json(res, { ok: false, error: 'not found' }, 404);
    const out = [];
    let G = null, cellMin = Infinity;
    for (const map of Object.keys(MAPS)) {
      const info = mapInfo(id, map); if (!info) continue;
      try { if (fs.statSync(info.file).size < info.G.nx * info.G.ny) continue; } catch (_) { continue; }
      G = G || info.G;
      let ver = 0; try { ver = Math.round(fs.statSync(info.file).mtimeMs / 1000); } catch (_) {}
      const M = info.m;
      out.push({ id: map, ver, folder: MAPS[map], units: String(M.units || ''), min: M.min, max: M.max, suggest: Array.isArray(M.suggest) ? M.suggest : [M.min, M.max],
        cell: info.G.cell, levels: Array.isArray(M.values) ? M.values.length : 255, values: Array.isArray(M.values) ? M.values : null, cuts: Array.isArray(M.cuts) ? M.cuts : null });
      cellMin = Math.min(cellMin, info.G.cell);
    }
    const r = { ok: true, maps: out, legacy: [] };
    if (G) {
      const cs = [[G.x0, G.y0], [G.x0 + G.nx * G.cell, G.y0], [G.x0, G.y0 + G.ny * G.cell], [G.x0 + G.nx * G.cell, G.y0 + G.ny * G.cell]].map(p => lonlatOf(p[0], p[1], G.zone, G.south));
      r.bounds = [Math.min(...cs.map(p => p[0])), Math.min(...cs.map(p => p[1])), Math.max(...cs.map(p => p[0])), Math.max(...cs.map(p => p[1]))];
      const lat = (r.bounds[1] + r.bounds[3]) / 2;
      r.minZoom = MIN_ZOOM;
      r.maxZoom = Math.max(MIN_ZOOM + 1, Math.min(22, 1 + Math.ceil(Math.log2(156543.03 * Math.cos(lat * Math.PI / 180) / cellMin))));   // one past a pixel per cell: soft close up
    }
    // an area made before the value rasters: the bushwhack pngs as plain images
    if (!out.some(x => x.folder === 'bush')) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(root, id, 'bush', 'derived.json'), 'utf8')), b = d.raster_bounds_lonlat;
        if (Array.isArray(b) && b.length === 4) for (const [mid, f] of [['brush', 'vegetation.png'], ['voids', 'voids.png']]) if (fs.existsSync(path.join(root, id, 'bush', f))) r.legacy.push({ id: mid, file: f, bounds: b });
      } catch (_) {}
    }
    json(res, r);
  }

  return { tile, maps, render, mapInfo };
};
const DEFAULT_RAMP = parseRamp('0:0b3d0b00_1:0b3d0bff');
Object.assign(module.exports, { parseRamp, rampString, rampAt, lut, valuesOf, palette, utm, lonlatOf, cellOf, pngRGBA, MAPS, MAX_STOPS });
