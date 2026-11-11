// veg-draw.js — draws a vegetation-shapes result (veg_shapes.py: veg.json + shapes.bin / shell.bin / ground.bin, see the
// vegetation contract) on the Cesium globe, green and mostly see-through, and exposes window._vegDraw.
//
// Two looks to compare:
//   shapes  one low-poly crown per tree (dome = broadleaf, cone = conifer; 48 triangles) and a flat mound per brush
//           patch (30 triangles), all in ONE batched mesh built here with typed arrays; a little per-shape variation
//           (turn, lean, lumps) from a hash of the position so it does not look stamped.
//   shell   the job's blobby skin around the vegetation points (shell.bin), as it is.
//
// How it is drawn (custom DrawCommands through one primitive in scene.primitives):
//   1. pre-pass   (Cesium OPAQUE pass, into FLEX's own target, not the scene) every visible mesh writes the distance
//                 of the nearest vegetation surface per pixel; the target's depth buffer keeps the nearest.
//   2. behind     (OVERLAY pass) the rims only of the layers BEHIND that nearest surface, faint (`behind`, a share of
//                 the edge): crowns behind crowns read as outlines instead of piling up into mud.
//   3. colour     (OVERLAY pass) the nearest surface only, blended once over the finished picture: height tint, soft
//                 light, a fresnel rim (`edge`), face amount (`fill`), overall `opacity`.
//   Why the overlay pass: FLEX's globe is translucent (alpha by distance), so Cesium draws the ground's colour late, in
//   the TRANSLUCENT pass with order-independent transparency: depth written earlier hides the ground under the trees,
//   and a faint layer inside OIT next to the opaque ground all but vanishes. Cesium clears the globe's depth before the
//   opaque pass (depthTestAgainstTerrain is off in FLEX), so every pass reads czm_globeDepthTexture and drops fragments
//   behind the terrain: trees behind a hill stay hidden.
//   All sliders are uniforms (no rebuild); minHeight / trees / brush are tested per shape in the vertex shader
//   (the shape collapses) and per fragment for the shell (its hag). Not pickable (clicks go to the ground).
//   Positions are local east-north-up metres (float32) around veg.json's origin, placed with the ENU frame as the
//   command's modelMatrix: czm_modelView is built in doubles on the CPU, so there is no jitter far from (0,0,0).
//
// Heights. onTerrain (default): the terrain shown is sampled once on a coarse grid over the bbox (<= 64 x 64, through
//   window._groundH.measureMany when present, else sampleTerrainMostDetailed), ground.bin is subtracted (bilinear),
//   and every shape (at its centre) / shell vertex is moved by the interpolated difference; rebuilt on
//   'flex-terrain-changed' or a new terrain provider. Off: the file's heights plus FLEX's point-cloud datum shift
//   (window._pcDatumDz at the origin, else 0). The tangent plane's drop with distance (x^2+y^2)/2R is taken off too.
//
// window._vegDraw = { load(baseUrl), loadData({veg, shapes, shell, ground}), set(opts), get(), stats(), clear(), flyTo(),
//   loaded(), bench(frames) }   — set(): look shapes|shell|both|off, opacity, edge, fill, minHeight, trees, brush,
//   tint height|plain, colourLow, colourHigh, brushColour, onTerrain, behind (0..1, rims behind the nearest layer).
//   Settings in localStorage flex.veg.settings. Event 'flex-veg-changed' { loaded } after load / clear.
// Node (tools/test_veg_draw.js): module.exports = the pure helpers.
(function () {
  'use strict';

  // ── Pure helpers ──────────────────────────────────────────────────────────
  const EARTH_R = 6371000;
  const DEFAULTS = {
    look: 'shapes', opacity: 0.35, edge: 0.6, fill: 0.5, minHeight: 0, trees: true, brush: true,
    tint: 'height', colourLow: '#1a5e28', colourHigh: '#a9d65e', brushColour: '#7f8c3c', onTerrain: true, behind: 0.3,
  };
  const LOOKS = ['shapes', 'shell', 'both', 'off'], TINTS = ['height', 'plain'];
  const HEX = /^#[0-9a-f]{6}$/i;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && isFinite(n) ? n : d; };

  /** Settings made safe: o's fields over base (or DEFAULTS); unknown fields dropped, numbers clamped, bad values keep base. */
  function clampSettings(o, base) {
    const b = Object.assign({}, DEFAULTS, base || {}), s = Object.assign({}, b);
    o = o || {};
    if (LOOKS.includes(o.look)) s.look = o.look;
    if (TINTS.includes(o.tint)) s.tint = o.tint;
    for (const k of ['opacity', 'edge', 'fill', 'behind']) if (k in o) s[k] = clamp(num(o[k], b[k]), 0, 1);
    if ('minHeight' in o) s.minHeight = clamp(num(o.minHeight, b.minHeight), 0, 200);
    for (const k of ['trees', 'brush', 'onTerrain']) if (k in o && o[k] != null) s[k] = !!o[k];
    for (const k of ['colourLow', 'colourHigh', 'brushColour']) if (typeof o[k] === 'string' && HEX.test(o[k].trim())) s[k] = o[k].trim().toLowerCase();
    return s;
  }
  function hexRgb(h) { const n = parseInt(String(h).slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }

  const asAB = b => (b == null ? null : b instanceof ArrayBuffer ? b : ArrayBuffer.isView(b) ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null);

  /** shapes.bin -> { rec: Float32Array (n x 8), n }. count from veg.json (fewer records in the file: what is there). */
  function parseShapes(buf, count) {
    buf = asAB(buf);
    if (!buf) return { rec: new Float32Array(0), n: 0 };
    const have = Math.floor(buf.byteLength / 32);
    const n = Math.max(0, Math.min(have, count == null ? have : count | 0));
    return { rec: new Float32Array(buf, 0, n * 8), n };
  }
  /** shell.bin -> { v: Float32Array (V x 4: x, y, z, hag), t: Uint32Array (T x 3) }; throws on a short file or a bad index. */
  function parseShell(buf, V, T) {
    buf = asAB(buf);
    if (!buf || !V || !T) return { v: new Float32Array(0), t: new Uint32Array(0), V: 0, T: 0 };
    if (buf.byteLength < V * 16 + T * 12) throw new Error('shell.bin is shorter than ' + V + ' vertices + ' + T + ' triangles');
    const v = new Float32Array(buf, 0, V * 4), t = new Uint32Array(buf, V * 16, T * 3);
    for (let i = 0; i < t.length; i++) if (t[i] >= V) throw new Error('shell.bin: triangle corner ' + t[i] + ' >= ' + V);
    return { v, t, V, T };
  }
  /** ground.bin -> Float32Array ny x nx (row 0 = south); null when missing or short. */
  function parseGround(buf, nx, ny) {
    buf = asAB(buf);
    if (!buf || !(nx > 0) || !(ny > 0) || buf.byteLength < nx * ny * 4) return null;
    return new Float32Array(buf, 0, nx * ny);
  }
  /** Bilinear on a grid of nodes (x0 + i*dx, y0 + j*dy), row 0 = south; clamped to the edges. */
  function bilinear(g, nx, ny, x0, y0, dx, dy, x, y) {
    let fx = (x - x0) / dx, fy = (y - y0) / dy;
    fx = clamp(fx, 0, nx - 1); fy = clamp(fy, 0, ny - 1);
    const i = Math.min(Math.floor(fx), nx - 2 < 0 ? 0 : nx - 2), j = Math.min(Math.floor(fy), ny - 2 < 0 ? 0 : ny - 2);
    const tx = nx > 1 ? fx - i : 0, ty = ny > 1 ? fy - j : 0;
    const i1 = Math.min(i + 1, nx - 1), j1 = Math.min(j + 1, ny - 1);
    const a = g[j * nx + i], b = g[j * nx + i1], c = g[j1 * nx + i], d = g[j1 * nx + i1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  /** The coarse grid the shown terrain is sampled on: nodes over bbox, <= maxN per side, about `cell` m apart. */
  function terrainGridSpec(bbox, maxN, cell) {
    maxN = maxN || 64; cell = cell || 10;
    const [x0, y0, x1, y1] = bbox, w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const nx = clamp(Math.ceil(w / cell) + 1, 2, maxN), ny = clamp(Math.ceil(h / cell) + 1, 2, maxN);
    return { nx, ny, x0, y0, dx: w / (nx - 1), dy: h / (ny - 1) };
  }
  /** shown terrain heights at the spec's nodes minus ground.bin there -> { grid, at(x, y) } the shift to add to file z. */
  function makeShift(spec, terrainH, gspec, ground) {
    const grid = new Float32Array(spec.nx * spec.ny);
    for (let j = 0; j < spec.ny; j++) for (let i = 0; i < spec.nx; i++) {
      const x = spec.x0 + i * spec.dx, y = spec.y0 + j * spec.dy, k = j * spec.nx + i;
      const g = ground ? bilinear(ground, gspec.nx, gspec.ny, gspec.x0, gspec.y0, gspec.cell, gspec.cell, x, y) : NaN;
      const d = terrainH[k] - g;
      grid[k] = isFinite(d) ? d : NaN;
    }
    // holes (a terrain sample or the ground missing): the mean of the rest
    let s = 0, n = 0; for (const d of grid) if (!isNaN(d)) { s += d; n++; }
    const mean = n ? s / n : 0; for (let k = 0; k < grid.length; k++) if (isNaN(grid[k])) grid[k] = mean;
    return { grid, at: (x, y) => bilinear(grid, spec.nx, spec.ny, spec.x0, spec.y0, spec.dx, spec.dy, x, y) };
  }
  const constShift = dz => ({ grid: null, at: () => dz });

  /** A hash of a position (and a salt) in [0, 1). */
  function hash01(x, y, k) {
    let h = Math.imul((Math.round(x * 100) | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((Math.round(y * 100) | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((k | 0) + 0x27d4eb2f, 0x165667b1);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  // Crown profiles: rings [t, r] from top to bottom (t = 0 at the crown's base, 1 at its top; r a share of the radius),
  // a pole on top, and one at the bottom when closed. Triangles = seg (top fan) + 2*seg*(rings-1) + seg (bottom fan).
  const PROFILES = {
    0: { seg: 8, rings: [[0.84, 0.66], [0.52, 1.0], [0.18, 0.82]], bottom: true },          // dome (broadleaf): fuller high up
    1: { seg: 8, rings: [[0.68, 0.38], [0.34, 0.78], [0.08, 0.98]], bottom: true },         // cone (conifer): pointed, a little convex
    2: { seg: 6, rings: [[0.7, 0.6], [0.34, 0.92], [0.0, 1.0]], bottom: false },            // brush mound: a flat dome, open below
  };
  function profileCounts(p) { return { verts: 1 + p.rings.length * p.seg + (p.bottom ? 1 : 0), tris: p.seg * (1 + 2 * (p.rings.length - 1) + (p.bottom ? 1 : 0)) }; }

  function newMesh(V, T) {
    return { pos: new Float32Array(V * 3), nrm: new Int8Array(V * 4), aux: new Float32Array(V * 2), meta: new Uint8Array(V * 4), idx: new Uint32Array(T * 3),
      vertices: V, triangles: T, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  }
  function boxAdd(m, x, y, z) { if (x < m.min[0]) m.min[0] = x; if (y < m.min[1]) m.min[1] = y; if (z < m.min[2]) m.min[2] = z; if (x > m.max[0]) m.max[0] = x; if (y > m.max[1]) m.max[1] = y; if (z > m.max[2]) m.max[2] = z; }
  // Smooth normals of a vertex range from its triangles (area-weighted), written as int8 into m.nrm.
  function normalsFor(m, v0, v1, t0, t1, tmp) {
    const n = tmp && tmp.length >= (v1 - v0) * 3 ? tmp.fill(0, 0, (v1 - v0) * 3) : new Float32Array((v1 - v0) * 3);
    const P = m.pos, I = m.idx;
    for (let t = t0; t < t1; t++) {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const q of [a, b, c]) { const k = (q - v0) * 3; n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
    }
    for (let v = v0; v < v1; v++) {
      const k = (v - v0) * 3, l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      m.nrm[v * 4] = Math.round(127 * n[k] / l); m.nrm[v * 4 + 1] = Math.round(127 * n[k + 1] / l); m.nrm[v * 4 + 2] = Math.round(127 * n[k + 2] / l);
    }
    return n;
  }

  /**
   * The "shapes" look as one mesh. rec: shapes.bin records; opts.shift(x, y) = metres to add to the file's heights there
   * (terrain follow / datum), opts.h0 = the drawn height of the local frame's origin (local z = z + shift - h0 - drop).
   * Returns { pos (local m), nrm (int8 x4), aux (hag of the vertex, the shape's top height), meta (u8 x4: kind*127,
   * density, random, 0 = shape), idx, vertices, triangles, min, max, counts }.
   */
  function buildShapes(rec, n, opts) {
    opts = opts || {};
    const shift = opts.shift || (() => 0), h0 = opts.h0 || 0, curv = opts.curvature !== false;
    let V = 0, T = 0;
    const kinds = new Uint8Array(n), counts = { dome: 0, cone: 0, brush: 0 };
    for (let i = 0; i < n; i++) {
      let k = Math.round(rec[i * 8 + 6]); if (!(k in PROFILES)) k = 0;
      kinds[i] = k; counts[k === 0 ? 'dome' : k === 1 ? 'cone' : 'brush']++;
      const c = profileCounts(PROFILES[k]); V += c.verts; T += c.tris;
    }
    const m = newMesh(V, T);
    m.counts = counts;
    const tmp = new Float32Array(64 * 3);
    let v = 0, t = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 8, x = rec[o], y = rec[o + 1], zg = rec[o + 2];
      let H = Math.max(0.2, rec[o + 3]), r = Math.max(0.3, rec[o + 4]), base = Math.max(0, rec[o + 5]);
      const k = kinds[i], P = PROFILES[k], dens = clamp(isFinite(rec[o + 7]) ? rec[o + 7] : 1, 0, 1);
      if (k === 2) base = 0; else if (base > H * 0.8) base = H * 0.8;          // a crown is never a sliver
      const h1 = hash01(x, y, 1), h2 = hash01(x, y, 2), h3 = hash01(x, y, 3), h4 = hash01(x, y, 4);
      const rot = h1 * Math.PI * 2, sx = 0.88 + 0.24 * h2, sy = 2 - sx;      // turned, a little oval
      const lean = (k === 2 ? 0.05 : 0.1) * r, lx = lean * Math.cos(h3 * 6.283), ly = lean * Math.sin(h3 * 6.283);
      const dz = shift(x, y) - h0 - (curv ? (x * x + y * y) / (2 * EARTH_R) : 0);
      const zb = zg + base + dz, depth = H - base;
      const v0 = v, t0 = t;
      const put = (px, py, hz, hag) => {
        m.pos[v * 3] = px; m.pos[v * 3 + 1] = py; m.pos[v * 3 + 2] = hz;
        m.aux[v * 2] = hag; m.aux[v * 2 + 1] = H;
        m.meta[v * 4] = k * 127; m.meta[v * 4 + 1] = Math.round(dens * 255); m.meta[v * 4 + 2] = Math.round(h4 * 255); m.meta[v * 4 + 3] = 0;
        boxAdd(m, px, py, hz); v++;
      };
      put(x + lx, y + ly, zb + depth, H);                                        // top
      const seg = P.seg, nr = P.rings.length;
      for (let ri = 0; ri < nr; ri++) {
        const [tt, rr] = P.rings[ri];
        for (let s = 0; s < seg; s++) {
          const a = rot + (s / seg) * Math.PI * 2, j = 1 + 0.14 * (hash01(x, y, 10 + ri * 16 + s) - 0.5) * 2;
          const cx = Math.cos(a) * rr * r * j * sx, cy = Math.sin(a) * rr * r * j * sy;
          put(x + cx + lx * tt, y + cy + ly * tt, zb + tt * depth, base + tt * depth);
        }
      }
      if (P.bottom) put(x, y, zb, base);
      const top = v0, ring = q => v0 + 1 + q * seg, bot = v0 + 1 + nr * seg;
      const tri = (a, b, c) => { m.idx[t * 3] = a; m.idx[t * 3 + 1] = b; m.idx[t * 3 + 2] = c; t++; };
      for (let s = 0; s < seg; s++) {
        const s1 = (s + 1) % seg;
        tri(top, ring(0) + s, ring(0) + s1);
        for (let q = 0; q < nr - 1; q++) { const a = ring(q), b = ring(q + 1); tri(a + s, b + s, b + s1); tri(a + s, b + s1, a + s1); }
        if (P.bottom) tri(bot, ring(nr - 1) + s1, ring(nr - 1) + s);
      }
      normalsFor(m, v0, v, t0, t, tmp);
    }
    return m;
  }

  /** The "shell" look as one mesh (same layout as buildShapes; aux = hag, hag; meta.w = 255 marks the shell). */
  function buildShell(sh, opts) {
    opts = opts || {};
    const shift = opts.shift || (() => 0), h0 = opts.h0 || 0, curv = opts.curvature !== false;
    const m = newMesh(sh.V, sh.T);
    for (let i = 0; i < sh.V; i++) {
      const x = sh.v[i * 4], y = sh.v[i * 4 + 1], z = sh.v[i * 4 + 2], hag = sh.v[i * 4 + 3];
      const hz = z + shift(x, y) - h0 - (curv ? (x * x + y * y) / (2 * EARTH_R) : 0);
      m.pos[i * 3] = x; m.pos[i * 3 + 1] = y; m.pos[i * 3 + 2] = hz;
      m.aux[i * 2] = hag; m.aux[i * 2 + 1] = hag;
      m.meta[i * 4] = 0; m.meta[i * 4 + 1] = 255; m.meta[i * 4 + 2] = 128; m.meta[i * 4 + 3] = 255;
      boxAdd(m, x, y, hz);
    }
    m.idx.set(sh.t);
    normalsFor(m, 0, sh.V, 0, sh.T);
    return m;
  }

  /** The height the tint reaches its top colour at: the 95th percentile of the tree heights (one 60 m giant does not
   *  leave the rest of the forest dark), else stats.max_height, else 20 m. */
  function tintTop(rec, n, veg) {
    const hs = [];
    for (let i = 0; i < n; i++) if (Math.round(rec[i * 8 + 6]) !== 2 && isFinite(rec[i * 8 + 3])) hs.push(rec[i * 8 + 3]);
    if (hs.length >= 5) { hs.sort((a, b) => a - b); return Math.max(3, hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.95))]); }
    return Number(veg && veg.stats && veg.stats.max_height) || 20;
  }

  const pure = { tintTop, DEFAULTS, LOOKS, PROFILES, EARTH_R, clampSettings, hexRgb, parseShapes, parseShell, parseGround, bilinear, terrainGridSpec, makeShift, hash01, profileCounts, buildShapes, buildShell };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window === 'undefined') return;

  // ── Shaders ───────────────────────────────────────────────────────────────
  // One vertex shader for every pass. u_overlay = 1 in the colour passes (drawn in Cesium's OVERLAY pass, after the
  // scene is composited, with no depth test): z is clamped into the clip volume there so nothing is cut by the far plane.
  const VS = `
in vec3 position;
in vec4 normal;
in vec2 aux;
in vec4 meta;
uniform float u_minH;
uniform float u_trees;
uniform float u_brush;
uniform float u_overlay;
out vec3 v_nEC;
out vec3 v_pEC;
out float v_hag;
out vec4 v_meta;
void main() {
  bool shell = meta.w > 0.5;
  bool brushy = meta.x > 0.75;
  bool hide = !shell && (aux.y < u_minH || (brushy && u_brush < 0.5) || (!brushy && u_trees < 0.5));
  vec4 pEC = czm_modelView * vec4(position, 1.0);
  v_pEC = pEC.xyz;
  v_nEC = czm_normal * normal.xyz;
  v_hag = aux.x;
  v_meta = meta;
  vec4 p = czm_projection * pEC;
  if (u_overlay > 0.5 && p.w > 0.0) p.z = clamp(p.z, -p.w, p.w) * 0.999;
  gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : p;
}`;
  const FS_COMMON = `
in vec3 v_nEC;
in vec3 v_pEC;
in float v_hag;
in vec4 v_meta;
uniform float u_minH;
uniform float u_trees;
uniform float u_brush;
uniform float u_brushTop;
// true when this fragment is hidden: behind the terrain (the globe's depth), or a shell part filtered out by height
bool vegHidden() {
  if (v_meta.w > 0.5) {
    if (v_hag < u_minH) return true;
    bool brushy = v_hag < u_brushTop;
    if (brushy && u_brush < 0.5) return true;
    if (!brushy && u_trees < 0.5) return true;
  }
  float d = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
  if (d > 0.0 && d < 1.0) {
    vec4 e = czm_windowToEyeCoordinates(gl_FragCoord.xy, d);
    float gz = e.z / e.w;
    if (v_pEC.z < gz - (0.3 + 0.002 * abs(gz))) return true;
  }
  return false;
}`;
  const PACK_FAR = 50000.0;
  // Pre-pass, into FLEX's own target: the distance of the nearest visible vegetation surface per pixel (packed RGBA8,
  // the target's own depth buffer keeps the nearest).
  const FS_PRE = FS_COMMON + `
void main() {
  if (vegHidden()) discard;
  out_FragColor = czm_packDepth(clamp(-v_pEC.z / ${PACK_FAR.toFixed(1)}, 0.0, 0.999999));
}`;
  const FS_COL = FS_COMMON + `
uniform sampler2D u_near;
uniform vec3 u_cLow;
uniform vec3 u_cHigh;
uniform vec3 u_cBrush;
uniform float u_hMax;
uniform float u_tint;
uniform float u_opacity;
uniform float u_edge;
uniform float u_fill;
uniform float u_behind;
uniform float u_mode;      // 0 = the nearest layer, 1 = the rims of the layers behind it
void main() {
  if (vegHidden()) discard;
  float dist = -v_pEC.z;
  float nearest = czm_unpackDepth(texture(u_near, gl_FragCoord.xy / czm_viewport.zw)) * ${PACK_FAR.toFixed(1)};
  float tol = 0.05 + 0.002 * dist;
  bool isNearest = dist <= nearest + tol;
  if (u_mode < 0.5 ? !isNearest : isNearest) discard;
  vec3 N = normalize(v_nEC);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(-v_pEC);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 2.2);
  // far away a crown is a few pixels: rims there are only sparkle, so they fade and the faces fill in instead
  float mpp = czm_metersPerPixel(vec4(v_pEC, 1.0));
  float far = smoothstep(0.08, 0.8, mpp);
  rim *= mix(1.0, 0.35, far);
  vec3 up = normalize(czm_normal * vec3(0.0, 0.0, 1.0));
  vec3 L = normalize(czm_normal * vec3(-0.45, 0.55, 0.7));
  bool brushy = v_meta.w > 0.5 ? v_hag < u_brushTop : v_meta.x > 0.75;
  float t = clamp(v_hag / max(u_hMax, 1.0), 0.0, 1.0);
  vec3 base = brushy ? u_cBrush : (u_tint > 0.5 ? mix(u_cLow, u_cHigh, smoothstep(0.0, 1.0, t)) : mix(u_cLow, u_cHigh, 0.45));
  base *= 0.88 + 0.24 * v_meta.z;
  float lit = 0.55 + 0.3 * max(dot(N, L), 0.0) + 0.25 * (0.5 + 0.5 * dot(N, up));
  vec3 col = base * lit;
  vec3 rimCol = mix(base, vec3(0.75, 1.0, 0.5), 0.4) * 1.12;
  float er = clamp(u_edge * rim * 1.6, 0.0, 1.0);
  float dens = 0.55 + 0.45 * v_meta.y;
  float a;
  if (u_mode > 0.5) {
    a = u_behind * u_edge * rim * (0.45 + u_opacity) * 0.6 * (1.0 - far);
    col = rimCol;
  } else {
    a = u_opacity * u_fill * dens * mix(1.4, 1.9, far) + u_edge * rim * (0.45 + u_opacity);
    col = mix(col, rimCol, er);
  }
  a = clamp(a, 0.0, 0.97);
  if (a < 0.004) discard;
  out_FragColor = vec4(col, a);
}`;

  // ── State ─────────────────────────────────────────────────────────────────
  const KEY = 'flex.veg.settings';
  const lget = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  let S = clampSettings((() => { try { return JSON.parse(lget(KEY) || '{}'); } catch (_) { return {}; } })());
  let D = null;            // the loaded result: { veg, sh, shell, ground, gspec, bytes, shift, h0, meshes: { shapes, shell }, gen }
  let prim = null, gen = 0, lastDrawMs = null;
  const V = () => window.cesiumViewer;
  const Ces = () => window.Cesium;
  const redraw = () => { const v = V(); if (v && v.scene && v.scene.requestRender) v.scene.requestRender(); };
  const fire = () => { try { window.dispatchEvent(new CustomEvent('flex-veg-changed', { detail: { loaded: !!D } })); } catch (_) {} };

  // ── The primitive ─────────────────────────────────────────────────────────
  // One object in scene.primitives. Per frame (render passes only, so it is never picked):
  //   update()  clears FLEX's own target (the drawing buffer's size: RGBA8 + a 16-bit depth buffer);
  //   OPAQUE    pre-pass of the visible meshes into that target (Cesium adds its log-depth version);
  //   OVERLAY   the rims behind the nearest layer, then the nearest layer, blended over the finished picture.
  // Why not blend in the scene itself: FLEX's globe is translucent (globe.translucency with an alpha by distance), so
  // Cesium draws the ground's colour in the TRANSLUCENT pass with order-independent transparency; anything that writes
  // depth before it hides the ground under the trees, and a faint layer blended in OIT next to the opaque ground all
  // but vanishes. The overlay pass sees the finished ground and still has the globe's depth, so the hill test works.
  function makePrimitive() {
    const C = Ces();
    const gpu = { shapes: null, shell: null };           // { va, sphere, triangles, pre, behind, col }
    let progPre = null, progCol = null, progColLog = null, rsPre = null, rsCol = null, ctx = null, destroyed = false;
    let fbo = null, nearTex = null, fboW = 0, fboH = 0, clearCmd = null;
    const ATTR = { position: 0, normal: 1, aux: 2, meta: 3 };
    const rgb = { low: new C.Cartesian3(), high: new C.Cartesian3(), brush: new C.Cartesian3() };
    const setRgb = (c, h) => { const a = hexRgb(h); c.x = a[0]; c.y = a[1]; c.z = a[2]; return c; };
    const common = {
      u_minH: () => S.minHeight, u_trees: () => (S.trees ? 1 : 0), u_brush: () => (S.brush ? 1 : 0),
      u_brushTop: () => (D && D.brushTop) || 2, u_overlay: () => 0,
    };
    const colMap = mode => Object.assign({}, common, {
      u_overlay: () => 1, u_near: () => nearTex,
      u_cLow: () => setRgb(rgb.low, S.colourLow), u_cHigh: () => setRgb(rgb.high, S.colourHigh), u_cBrush: () => setRgb(rgb.brush, S.brushColour),
      u_hMax: () => (D && D.hMax) || 20, u_tint: () => (S.tint === 'height' ? 1 : 0),
      u_opacity: () => S.opacity, u_edge: () => S.edge, u_fill: () => S.fill, u_behind: () => S.behind, u_mode: () => mode,
    });
    const maps = { pre: common, col: colMap(0), behind: colMap(1) };
    function ensure(context) {
      if (progPre) return;
      ctx = context;
      progPre = C.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: FS_PRE, attributeLocations: ATTR });
      progCol = C.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: FS_COL, attributeLocations: ATTR });
      // overlay commands get no derived log-depth program from Cesium; the globe depth is then a log depth, so say so
      progColLog = C.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: new C.ShaderSource({ sources: [FS_COL], defines: ['LOG_DEPTH'] }), attributeLocations: ATTR });
      const cull = { enabled: true, face: C.CullFace.BACK };
      rsPre = C.RenderState.fromCache({ cull, depthTest: { enabled: true, func: C.DepthFunction.LESS }, depthMask: true });
      rsCol = C.RenderState.fromCache({ cull, depthTest: { enabled: false }, depthMask: false, blending: C.BlendingState.ALPHA_BLEND });
    }
    function ensureTarget(context) {
      const w = context.drawingBufferWidth, h = context.drawingBufferHeight;
      if (fbo && w === fboW && h === fboH) return;
      if (fbo) fbo.destroy();
      nearTex = new C.Texture({ context, width: w, height: h, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE, sampler: C.Sampler.NEAREST });
      const depthRenderbuffer = new C.Renderbuffer({ context, width: w, height: h, format: C.RenderbufferFormat.DEPTH_COMPONENT16 });
      fbo = new C.Framebuffer({ context, colorTextures: [nearTex], depthRenderbuffer, destroyAttachments: true });
      fboW = w; fboH = h;
      clearCmd = new C.ClearCommand({ color: new C.Color(1, 1, 1, 1), depth: 1, framebuffer: fbo, renderState: C.RenderState.fromCache() });
      for (const k of ['shapes', 'shell']) if (gpu[k]) gpu[k].pre.framebuffer = fbo;
    }
    function upload(context, mesh, modelMatrix) {
      const vb = (a, n, type, norm) => ({ vertexBuffer: C.Buffer.createVertexBuffer({ context, typedArray: a, usage: C.BufferUsage.STATIC_DRAW }), componentsPerAttribute: n, componentDatatype: type, normalize: !!norm });
      const attributes = [
        Object.assign({ index: ATTR.position }, vb(mesh.pos, 3, C.ComponentDatatype.FLOAT)),
        Object.assign({ index: ATTR.normal }, vb(mesh.nrm, 4, C.ComponentDatatype.BYTE, true)),
        Object.assign({ index: ATTR.aux }, vb(mesh.aux, 2, C.ComponentDatatype.FLOAT)),
        Object.assign({ index: ATTR.meta }, vb(mesh.meta, 4, C.ComponentDatatype.UNSIGNED_BYTE, true)),
      ];
      const indexBuffer = C.Buffer.createIndexBuffer({ context, typedArray: mesh.idx, usage: C.BufferUsage.STATIC_DRAW, indexDatatype: C.IndexDatatype.UNSIGNED_INT });
      const va = new C.VertexArray({ context, attributes, indexBuffer });
      const lo = mesh.min, hi = mesh.max;
      const centre = new C.Cartesian3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      const radius = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 1;
      const sphere = new C.BoundingSphere(C.Matrix4.multiplyByPoint(modelMatrix, centre, new C.Cartesian3()), radius);
      const cmd = (pass, prog, rs, map, framebuffer) => new C.DrawCommand({ vertexArray: va, primitiveType: C.PrimitiveType.TRIANGLES, shaderProgram: prog, renderState: rs,
        uniformMap: map, modelMatrix, boundingVolume: sphere, pass, owner: api, cull: true, framebuffer });
      return { va, sphere, triangles: mesh.triangles,
        pre: cmd(C.Pass.OPAQUE, progPre, rsPre, maps.pre, fbo),
        behind: cmd(C.Pass.OVERLAY, progCol, rsCol, maps.behind), col: cmd(C.Pass.OVERLAY, progCol, rsCol, maps.col) };
    }
    const free = k => { if (gpu[k]) { try { gpu[k].va.destroy(); } catch (_) {} gpu[k] = null; } };
    const api = {
      show: true,
      pending: null,              // { modelMatrix, shapes: mesh|null, shell: mesh|null } waiting for a context
      frames: 0,
      update(frameState) {
        if (destroyed || !this.show) return;
        if (!frameState.passes.render) return;                 // never in a pick or depth-only pass: not pickable
        const context = frameState.context;
        ensure(context);
        if (this.pending) {
          const p = this.pending; this.pending = null;
          free('shapes'); free('shell');
          ensureTarget(context);
          if (p.shapes) gpu.shapes = upload(context, p.shapes, p.modelMatrix);
          if (p.shell) gpu.shell = upload(context, p.shell, p.modelMatrix);
        }
        const on = [];
        if ((S.look === 'shapes' || S.look === 'both') && gpu.shapes) on.push(gpu.shapes);
        if ((S.look === 'shell' || S.look === 'both') && gpu.shell) on.push(gpu.shell);
        const cv = frameState.cullingVolume;
        const vis = on.filter(g => !cv || cv.computeVisibility(g.sphere) !== C.Intersect.OUTSIDE);
        if (!vis.length) return;
        ensureTarget(context);
        clearCmd.execute(context);
        const prog = frameState.useLogDepth ? progColLog : progCol;
        const list = frameState.commandList;
        for (const g of vis) list.push(g.pre);
        if (S.behind > 0 && S.edge > 0) for (const g of vis) { g.behind.shaderProgram = prog; list.push(g.behind); }
        for (const g of vis) { g.col.shaderProgram = prog; list.push(g.col); }
        this.frames++;
      },
      uploaded: k => !!gpu[k],
      triangles: k => (gpu[k] ? gpu[k].triangles : 0),
      sphere: () => (gpu.shapes || gpu.shell || {}).sphere,
      release() { free('shapes'); free('shell'); this.pending = null; },
      isDestroyed: () => destroyed,
      destroy() {
        free('shapes'); free('shell');
        if (progPre) { progPre.destroy(); progCol.destroy(); progColLog.destroy(); }
        if (fbo) fbo.destroy();
        destroyed = true; return undefined;
      },
    };
    return api;
  }

  // ── Heights: the terrain shown, sampled once ──────────────────────────────
  function lonLatOf(frame, x, y) {
    const C = Ces(), p = C.Matrix4.multiplyByPoint(frame, new C.Cartesian3(x, y, 0), new C.Cartesian3());
    const c = C.Cartographic.fromCartesian(p);
    return [C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)];
  }
  async function sampleShown(veg) {
    const C = Ces(), v = V();
    const o = veg.origin, frame0 = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(o.lon, o.lat, 0));
    const spec = terrainGridSpec(veg.bbox || [-100, -100, 100, 100]);
    const pts = [];
    for (let j = 0; j < spec.ny; j++) for (let i = 0; i < spec.nx; i++) pts.push(lonLatOf(frame0, spec.x0 + i * spec.dx, spec.y0 + j * spec.dy));
    let hs = null;
    const G = window._groundH;
    if (G && typeof G.measureMany === 'function') {
      try { hs = (await G.measureMany(pts)).map(r => r.h); } catch (_) { hs = null; }
    }
    if (!hs) {
      const prov = v && v.terrainProvider, cartos = pts.map(p => C.Cartographic.fromDegrees(p[0], p[1]));
      try {
        if (!prov || prov instanceof C.EllipsoidTerrainProvider) hs = pts.map(() => 0);
        else hs = (await C.sampleTerrainMostDetailed(prov, cartos)).map(c => c.height);
      } catch (_) { hs = pts.map(() => NaN); }
    }
    return { spec, h: Float32Array.from(hs, h => (Number.isFinite(h) ? h : NaN)), prov: v && v.terrainProvider };
  }
  function datumDz(veg) {
    try { const f = window._pcDatumDz; if (typeof f === 'function') { const d = f(veg.origin.lat, veg.origin.lon); if (Number.isFinite(d)) return d; } } catch (_) {}
    return 0;
  }

  // Build the meshes for D with the current height mode and hand them to the primitive.
  async function rebuild() {
    if (!D) return;
    const my = ++gen, C = Ces(), v = V();
    let shift;
    if (S.onTerrain && D.ground) {
      const s = await sampleShown(D.veg);
      if (my !== gen || !D) return;
      shift = makeShift(s.spec, s.h, D.gspec, D.ground);
      D.terrainProv = s.prov; D.terrainGrid = s;
    } else {
      shift = constShift(S.onTerrain ? 0 : datumDz(D.veg));
      D.terrainProv = null;
      if (S.onTerrain && !D.ground) shift = constShift(datumDz(D.veg));
    }
    D.shift = shift; D.mode = S.onTerrain && D.ground ? 'terrain' : 'datum';
    const o = D.veg.origin, h0 = (o.h || 0) + shift.at(0, 0);
    D.h0 = h0;
    const t0 = performance.now();
    const meshes = {
      shapes: D.sh.n ? buildShapes(D.sh.rec, D.sh.n, { shift: shift.at, h0 }) : null,
      shell: D.shell.T ? buildShell(D.shell, { shift: shift.at, h0 }) : null,
    };
    D.buildMs = performance.now() - t0;
    D.meshes = meshes;
    D.modelMatrix = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(o.lon, o.lat, h0));
    if (!prim || prim.isDestroyed()) { prim = makePrimitive(); v.scene.primitives.add(prim); }
    prim.pending = { modelMatrix: D.modelMatrix, shapes: meshes.shapes, shell: meshes.shell };
    redraw();
  }

  // ── API ───────────────────────────────────────────────────────────────────
  async function loadData(o) {
    try {
      const veg = o && o.veg;
      if (!veg || !veg.origin || !isFinite(veg.origin.lon) || !isFinite(veg.origin.lat)) throw new Error('veg.json has no origin');
      if (!V() || !Ces()) throw new Error('the globe is not ready');
      const sh = veg.shapes ? parseShapes(o.shapes, veg.shapes.count) : parseShapes(null);
      const shell = veg.shell ? parseShell(o.shell, veg.shell.vertices, veg.shell.triangles) : parseShell(null);
      const g = veg.ground || null;
      const ground = g ? parseGround(o.ground, g.nx, g.ny) : null;
      const hMax = tintTop(sh.rec, sh.n, veg);
      const bytes = ['shapes', 'shell', 'ground'].reduce((a, k) => a + ((asAB(o[k]) || {}).byteLength || 0), 0);
      clear(true);
      D = { veg, sh, shell, ground, gspec: g ? { nx: g.nx, ny: g.ny, x0: Number(g.x0) || 0, y0: Number(g.y0) || 0, cell: Number(g.cell) || 10 } : null,
        bytes, hMax: hMax || 20, brushTop: Number(veg.params && veg.params.brush_top) || 2 };
      await rebuild();
      fire();
      return { ok: true, veg, stats: stats() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  async function load(baseUrl) {
    try {
      let b = String(baseUrl || ''); if (b && !b.endsWith('/')) b += '/';
      const get = async (name, json) => { const r = await fetch(b + name); if (!r.ok) throw new Error(name + ': ' + r.status); return json ? r.json() : r.arrayBuffer(); };
      const veg = await get('veg.json', true);
      const want = k => (veg[k] && veg[k].file ? get(veg[k].file).catch(() => null) : Promise.resolve(null));
      const [shapes, shell, ground] = await Promise.all([want('shapes'), want('shell'), want('ground')]);
      const r = await loadData({ veg, shapes, shell, ground });
      if (r.ok) D.base = b;
      return r;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  function set(o) {
    const before = S;
    S = clampSettings(o, S);
    lset(KEY, JSON.stringify(S));
    if (D && before.onTerrain !== S.onTerrain) rebuild();
    redraw();
    return get();
  }
  const get = () => Object.assign({}, S);
  function stats() {
    if (!D) return { loaded: false, shapes: 0, triangles: 0, bytes: 0 };
    const tS = D.meshes && D.meshes.shapes ? D.meshes.shapes.triangles : 0, tH = D.meshes && D.meshes.shell ? D.meshes.shell.triangles : 0;
    const tri = S.look === 'shapes' ? tS : S.look === 'shell' ? tH : S.look === 'both' ? tS + tH : 0;
    const vert = m => (m ? m.vertices : 0), gpuBytes = ['shapes', 'shell'].reduce((a, k) => { const m = D.meshes && D.meshes[k]; return a + (m ? m.vertices * 28 + m.triangles * 12 : 0); }, 0);
    return {
      loaded: true, shapes: D.sh.n, triangles: tri, trianglesShapes: tS, trianglesShell: tH, vertices: vert(D.meshes && D.meshes.shapes) + vert(D.meshes && D.meshes.shell),
      counts: D.meshes && D.meshes.shapes ? Object.assign({}, D.meshes.shapes.counts) : { dome: 0, cone: 0, brush: 0 },
      bytes: D.bytes, gpuBytes, buildMs: D.buildMs != null ? Math.round(D.buildMs) : null, drawMs: lastDrawMs, heights: D.mode, h0: D.h0,
      uploaded: !!(prim && (prim.uploaded('shapes') || prim.uploaded('shell'))),
    };
  }
  function clear(quiet) {
    gen++;
    if (prim) { prim.release(); }
    const had = !!D;
    D = null; lastDrawMs = null;
    redraw();
    if (had && !quiet) fire();
  }
  function flyTo(opts) {
    const v = V(), C = Ces();
    if (!D || !v) return false;
    const o = D.veg.origin, bb = D.veg.bbox || [-100, -100, 100, 100];
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, rad = Math.max(30, 0.5 * Math.hypot(bb[2] - bb[0], bb[3] - bb[1]));
    const frame = D.modelMatrix || C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(o.lon, o.lat, o.h || 0));
    const c = C.Matrix4.multiplyByPoint(frame, new C.Cartesian3(cx, cy, 0), new C.Cartesian3());
    v.camera.flyToBoundingSphere(new C.BoundingSphere(c, rad), Object.assign({ offset: new C.HeadingPitchRange(0, C.Math.toRadians(-35), rad * 2.2), duration: 1.2 }, opts || {}));
    return true;
  }
  /** Frame cost: the scene drawn `frames` times with the vegetation on and off (each finished with a 1-pixel read). */
  function bench(frames) {
    const v = V(); if (!v || !D) return null;
    frames = frames || 10;
    const gl = v.scene.context._gl, px = new Uint8Array(4);
    const time = () => { v.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); const t0 = performance.now(); for (let i = 0; i < frames; i++) { v.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } return (performance.now() - t0) / frames; };
    const show = prim ? prim.show : true;
    if (prim) prim.show = false; const off = time();
    if (prim) prim.show = true; const on = time();
    if (prim) prim.show = show;
    lastDrawMs = Math.max(0, on - off);
    return { onMs: on, offMs: off, drawMs: lastDrawMs, triangles: stats().triangles };
  }

  // The terrain shown changed: follow it (onTerrain only).
  function terrainMaybeChanged() { if (D && S.onTerrain && D.ground) rebuild(); }
  window.addEventListener('flex-terrain-changed', terrainMaybeChanged);
  setInterval(() => { const v = V(); if (D && S.onTerrain && D.ground && D.terrainProv && v && v.terrainProvider !== D.terrainProv) terrainMaybeChanged(); }, 2000);

  window._vegDraw = { load, loadData, set, get, stats, clear: () => clear(false), flyTo, loaded: () => !!D, bench, pure };
})();
