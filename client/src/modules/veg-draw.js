// veg-draw.js — draws a vegetation-shapes result (veg_shapes.py: veg.json + shapes.bin / shell.bin / ground.bin, see the
// vegetation contract) on the Cesium globe, green and mostly see-through, and exposes window._vegDraw.
//
// Two looks to compare:
//   shapes  one crown per tree, a surface of revolution through the outline the job measured from the tree's own returns
//           (shapes.bin version 2: radius at 10/35/60/85 % of the crown; version 1: an outline by kind), closed by a
//           small round cap; a lobed clump per brush patch. All in ONE batched mesh built here with typed arrays, with a
//           little per-shape variation (turn, slight oval, lumps) from a hash of the position, kept small enough that
//           the measured outline shows. Two levels of detail in that mesh (see "Level of detail" below): near shapes
//           20-80 triangles by size, far shapes 12, switched per shape by distance with a dissolve.
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
//   The behind pass is drawn for near shapes only. Per frame the CPU picks index ranges by tile and size class (frustum
//   and distance), so a frame is a handful of draw calls per pass.
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
//   tint height|plain, colourLow, colourHigh, brushColour, onTerrain, behind (0..1, rims behind the nearest layer),
//   lod (0.25..4, where shapes turn into their far form, x the default distances).
//   Settings in localStorage flex.veg.settings. Event 'flex-veg-changed' { loaded } after load / clear.
// Node (tools/test_veg_draw.js): module.exports = the pure helpers.
(function () {
  'use strict';

  // ── Pure helpers ──────────────────────────────────────────────────────────
  const EARTH_R = 6371000;
  const DEFAULTS = {
    look: 'shapes', opacity: 0.35, edge: 0.6, fill: 0.5, minHeight: 0, trees: true, brush: true,
    tint: 'height', colourLow: '#1a5e28', colourHigh: '#a9d65e', brushColour: '#6f8530', onTerrain: true, behind: 0.3, lod: 1,
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
    if ('lod' in o) s.lod = clamp(num(o.lod, b.lod), 0.25, 4);
    for (const k of ['trees', 'brush', 'onTerrain']) if (k in o && o[k] != null) s[k] = !!o[k];
    for (const k of ['colourLow', 'colourHigh', 'brushColour']) if (typeof o[k] === 'string' && HEX.test(o[k].trim())) s[k] = o[k].trim().toLowerCase();
    return s;
  }
  function hexRgb(h) { const n = parseInt(String(h).slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }

  const asAB = b => (b == null ? null : b instanceof ArrayBuffer ? b : ArrayBuffer.isView(b) ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null);

  /** shapes.bin -> { rec: Float32Array (n x stride), n, stride }. stride 8 (version 1, record 32) or 12 (version 2,
   *  record 48: + r1..r4); record from veg.json shapes.record, else 32. count from veg.json (fewer in the file: what is there). */
  function parseShapes(buf, count, record) {
    buf = asAB(buf);
    const bytes = record === 48 ? 48 : 32, stride = bytes / 4;
    if (!buf) return { rec: new Float32Array(0), n: 0, stride };
    const have = Math.floor(buf.byteLength / bytes);
    const n = Math.max(0, Math.min(have, count == null ? have : count | 0));
    return { rec: new Float32Array(buf, 0, n * stride), n, stride };
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

  // ── Crown outlines ────────────────────────────────────────────────────────
  // A crown is a surface of revolution through its outline R(t): t = 0 at the crown's base, 1 at its top, R a share of
  // the crown's widest radius. shapes.bin version 2 measures R at PROFILE_T (r1..r4); version 1 has none, so the outline
  // comes from `kind`. The outline runs (0, r0) -> r1..r4 -> a rounded top: from t = 0.85 an elliptic arc closes it, so
  // even a spruce ends in a small round cap, not a needle (its r4 is held at >= CAP_MIN).
  const PROFILE_T = [0.1, 0.35, 0.6, 0.85];
  const KIND_OUTLINE = { 0: [0.7, 1.0, 0.9, 0.5], 1: [1.0, 0.8, 0.52, 0.24], 2: [1.0, 0.9, 0.7, 0.4] };   // dome, cone, brush (v1)
  const CAP_MIN = 0.14;

  /** The measured outline of record i (r1..r4), or the kind's; each value made safe (0..1.25; all tiny / bad -> kind). */
  function outlineOf(rec, o, stride, kind) {
    const fb = KIND_OUTLINE[kind] || KIND_OUTLINE[0];
    if (stride < 12) return fb.slice();
    const r = [rec[o + 8], rec[o + 9], rec[o + 10], rec[o + 11]];
    let good = 0, mx = 0;
    for (let k = 0; k < 4; k++) { if (Number.isFinite(r[k]) && r[k] >= 0) { good++; mx = Math.max(mx, r[k]); } }
    if (good < 4 || mx < 0.2) return fb.slice();
    // one missing slice is never a hole in the crown: values are scaled so the widest is 1 (radius is the widest)
    return r.map(v => clamp(v / Math.max(mx, 1), 0, 1.25));
  }

  /** The outline as a function: [(0, r0), (0.1, r1) .. (0.85, r4')] by a monotone cubic (no overshoot), then the cap. */
  function outlineFn(r, groundReach) {
    const r4 = Math.max(r[3], CAP_MIN);
    const T = [0, 0.1, 0.35, 0.6, 0.85], R = [groundReach ? r[0] : r[0] * 0.6, r[0], r[1], r[2], r4];
    const n = T.length, d = new Array(n - 1), m = new Array(n);
    for (let k = 0; k < n - 1; k++) d[k] = (R[k + 1] - R[k]) / (T[k + 1] - T[k]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
    for (let k = 0; k < n - 1; k++) {                              // Fritsch-Carlson
      if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
      const a = m[k] / d[k], b = m[k + 1] / d[k], h = a * a + b * b;
      if (h > 9) { const tau = 3 / Math.sqrt(h); m[k] = tau * a * d[k]; m[k + 1] = tau * b * d[k]; }
    }
    return t => {
      if (t >= 1) return 0;
      if (t > 0.85) { const u = (t - 0.85) / 0.15; return r4 * Math.sqrt(Math.max(0, 1 - u * u)); }
      if (t <= 0) return R[0];
      let k = 0; while (k < n - 2 && t > T[k + 1]) k++;
      const h = T[k + 1] - T[k], s = (t - T[k]) / h, s2 = s * s, s3 = s2 * s;
      return Math.max(0, (2 * s3 - 3 * s2 + 1) * R[k] + (s3 - 2 * s2 + s) * h * m[k] + (-2 * s3 + 3 * s2) * R[k + 1] + (s3 - s2) * h * m[k + 1]);
    };
  }

  // ── Level of detail ───────────────────────────────────────────────────────
  // Triangles go where they show. Near: segments by the crown's radius, rings by the crown's depth (3 to 5 rings, the top
  // ring the round cap); a 3 m sapling gets 30 triangles, a 40 m tree 80-100. Far: every shape again as 12 triangles (two
  // staggered 3-gons, so it is a 6-sided crown from above; brush two 4-gons). Each shape switches between the two by its own
  // distance in the vertex shader, with a short screen-door cross-fade, so nothing pops; the CPU only picks which blocks
  // of the index buffer to draw (tiles x size classes, merged into a few ranges), and the shader collapses the rest.
  const SIZE_R = [1.8, 3.5, 6];                         // radius class limits (m): classes 0..3
  const SEG = [5, 6, 7, 8];
  const SWITCH_M = [130, 240, 420, 700];                // where a class goes far at lod 1 (about 10 px of radius at 800 px high)
  const FADE = 0.2;                                     // cross-fade band, a share of the switch distance
  // ring heights (t) by crown depth; the five-ring one ends in the round cap ring, the others close on the top pole
  const RINGS = [[0.2, 0.7], [0.12, 0.45, 0.8], [0.1, 0.35, 0.6, 0.85], [0.1, 0.35, 0.6, 0.85, 0.956]];
  const MIN_RINGS = [0, 0, 1, 2], MAX_RINGS = [1, 2, 3, 3];   // by size class (indices into RINGS)
  const BRUSH_SEG = 7;
  const sizeClass = r => (r < SIZE_R[0] ? 0 : r < SIZE_R[1] ? 1 : r < SIZE_R[2] ? 2 : 3);
  const ringsFor = (depth, c) => { c = c == null ? 3 : c; return RINGS[clamp(depth < 4 ? 0 : depth < 10 ? 1 : depth < 20 ? 2 : 3, MIN_RINGS[c], MAX_RINGS[c])]; };
  /** Vertices and triangles of one shape: lod 0 near, 1 far. */
  function shapeCounts(kind, r, depth, lod) {
    if (kind === 2) return lod ? { verts: 9, tris: 12 } : { verts: 2 * BRUSH_SEG + 1, tris: 3 * BRUSH_SEG };
    if (lod) return { verts: 8, tris: 12 };
    const c = sizeClass(r), seg = SEG[c], nr = ringsFor(depth, c).length;
    return { verts: seg * nr + 2, tris: 2 * seg * nr };
  }
  // a polygon with its corners on the circle looks smaller than the circle: corners pushed out a little
  const polyK = seg => (1 + 1 / Math.cos(Math.PI / seg)) / 2;

  // vertex: position 3 x f32, normal 4 x i8, aux 2 x u16, meta 4 x u8, ctr 4 x i16 = 32 bytes
  const VERTEX_BYTES = 32;
  const cm = h => Math.round(clamp(h, 0, 655) * 100);
  const off = d => clamp(Math.round(d * 100), -32767, 32767);
  function newMesh(V, T) {
    return { pos: new Float32Array(V * 3), nrm: new Int8Array(V * 4), aux: new Uint16Array(V * 2), meta: new Uint8Array(V * 4), ctr: new Int16Array(V * 4),
      idx: new Uint32Array(T * 3), vertices: V, triangles: T, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  }
  function boxAdd(m, x, y, z) { if (x < m.min[0]) m.min[0] = x; if (y < m.min[1]) m.min[1] = y; if (z < m.min[2]) m.min[2] = z; if (x > m.max[0]) m.max[0] = x; if (y > m.max[1]) m.max[1] = y; if (z > m.max[2]) m.max[2] = z; }
  // Smooth normals of a vertex range from its triangles (area-weighted), written as int8 into m.nrm. tris: a list of
  // triangle numbers (or [t0, t1) when t1 is a number).
  function normalsFor(m, v0, v1, tris, t1, tmp) {
    const n = tmp && tmp.length >= (v1 - v0) * 3 ? tmp.fill(0, 0, (v1 - v0) * 3) : new Float32Array((v1 - v0) * 3);
    const P = m.pos, I = m.idx;
    const one = t => {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      let k = (a - v0) * 3; n[k] += nx; n[k + 1] += ny; n[k + 2] += nz;
      k = (b - v0) * 3; n[k] += nx; n[k + 1] += ny; n[k + 2] += nz;
      k = (c - v0) * 3; n[k] += nx; n[k + 1] += ny; n[k + 2] += nz;
    };
    if (typeof t1 === 'number') for (let t = tris; t < t1; t++) one(t); else for (const t of tris) one(t);
    for (let v = v0; v < v1; v++) {
      const k = (v - v0) * 3, l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      m.nrm[v * 4] = Math.round(127 * n[k] / l); m.nrm[v * 4 + 1] = Math.round(127 * n[k + 1] / l); m.nrm[v * 4 + 2] = Math.round(127 * n[k + 2] / l);
    }
    return n;
  }

  /** The tiles the shapes are sorted into: a square grid over the shapes' extent, <= 12 a side, >= 120 m. */
  function tileGrid(rec, n, stride) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { const x = rec[i * stride], y = rec[i * stride + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!(x1 >= x0)) { x0 = y0 = 0; x1 = y1 = 1; }
    const size = Math.max(120, Math.max(x1 - x0, y1 - y0) / 12);
    const nx = Math.max(1, Math.ceil((x1 - x0 + 1e-3) / size)), ny = Math.max(1, Math.ceil((y1 - y0 + 1e-3) / size));
    return { x0, y0, size, nx, ny, of: (x, y) => Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / size))) * nx + Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / size))) };
  }

  /** Brush heights held under the crowns above them (a clump does not poke up into a crown that starts higher; the
   *  builder never takes more than a third off, so understory stays a clump, not a slab). */
  function brushCaps(rec, n, stride) {
    const caps = new Float32Array(n).fill(Infinity), cell = 8, grid = new Map();
    const key = (i, j) => i * 73856093 ^ j * 19349663;
    for (let i = 0; i < n; i++) {
      const o = i * stride; if (Math.round(rec[o + 6]) === 2) continue;
      const base = rec[o + 5], r = rec[o + 4];
      if (!(base > 0.3) || !(r > 0)) continue;
      const ci = Math.floor(rec[o] / cell), cj = Math.floor(rec[o + 1] / cell), k = key(ci, cj);
      let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
    }
    if (!grid.size) return caps;
    for (let i = 0; i < n; i++) {
      const o = i * stride; if (Math.round(rec[o + 6]) !== 2) continue;
      const x = rec[o], y = rec[o + 1], ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const a = grid.get(key(ci + di, cj + dj)); if (!a) continue;
        for (const t of a) {
          const q = t * stride, d = Math.hypot(rec[q] - x, rec[q + 1] - y);
          if (d < rec[q + 4] * 0.8) caps[i] = Math.min(caps[i], Math.max(0.6, rec[q + 5] * 0.95));
        }
      }
    }
    return caps;
  }

  /**
   * The "shapes" look as one mesh, near and far shapes in it. rec: shapes.bin records (stride 8 or 12); opts.shift(x, y) =
   * metres to add to the file's heights there (terrain follow / datum), opts.h0 = the drawn height of the local frame's
   * origin (local z = z + shift - h0 - drop); opts.groundAt(x, y) = the job's ground there (ground.bin), so a brush
   * clump's foot ring reaches down a slope instead of floating on its downhill side (seen from below, an open clump
   * floating there showed only its far rim, a thin crescent). Returns { pos (local m, float32 x3), nrm (int8 x4), aux (u16 x2, cm: hag of
   * the vertex, the shape's top height), meta (u8 x4: kind*127, density, random, size class + 128 when far), ctr (int16
   * x4, cm: from the vertex to the shape's middle), idx, vertices, triangles, trianglesNear, trianglesFar, min, max, counts, blocks }.
   * idx is laid out by [lod][class][tile]; blocks = { tiles: [{ min, max }], start: [lod][class][tile] (first index),
   * count: same (indices) } so the drawer picks ranges per frame.
   */
  function buildShapes(rec, n, opts) {
    opts = opts || {};
    const stride = opts.stride || 8;
    const shift = opts.shift || (() => 0), h0 = opts.h0 || 0, curv = opts.curvature !== false, gAt = opts.groundAt || null;
    const tg = tileGrid(rec, n, stride), NT = tg.nx * tg.ny;
    const caps = brushCaps(rec, n, stride);
    const kinds = new Uint8Array(n), cls = new Uint8Array(n), tile = new Uint32Array(n), Hs = new Float32Array(n), Rs = new Float32Array(n), Bs = new Float32Array(n);
    const counts = { dome: 0, cone: 0, brush: 0 };
    const cnt = [0, 1].map(() => SEG.map(() => new Uint32Array(NT)));
    let V = 0, T = 0, Tn = 0, Tf = 0;
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      let k = Math.round(rec[o + 6]); if (k !== 0 && k !== 1 && k !== 2) k = 0;
      kinds[i] = k; counts[k === 0 ? 'dome' : k === 1 ? 'cone' : 'brush']++;
      let H = Math.max(0.2, num(rec[o + 3], 1)), r = Math.max(0.3, num(rec[o + 4], 1)), base = Math.max(0, num(rec[o + 5], 0));
      if (k === 2) { base = 0; H = Math.min(H, Math.max(caps[i], H * 0.65)); }      // held under a crown, never squashed flat else if (base > H * 0.8) base = H * 0.8;      // a crown is never a sliver
      Hs[i] = H; Rs[i] = r; Bs[i] = base;
      cls[i] = sizeClass(r); tile[i] = tg.of(rec[o], rec[o + 1]);
      for (let lod = 0; lod < 2; lod++) {
        const c = shapeCounts(k, r, H - base, lod);
        V += c.verts; T += c.tris; if (lod) Tf += c.tris; else Tn += c.tris;
        cnt[lod][cls[i]][tile[i]] += c.tris * 3;
      }
    }
    const m = newMesh(V, T);
    m.counts = counts; m.trianglesNear = Tn; m.trianglesFar = Tf;
    // where each block's indices start
    const start = [0, 1].map(() => SEG.map(() => new Uint32Array(NT))), cur = [0, 1].map(() => SEG.map(() => new Uint32Array(NT)));
    let at = 0;
    for (let lod = 0; lod < 2; lod++) for (let c = 0; c < SEG.length; c++) for (let t = 0; t < NT; t++) { start[lod][c][t] = at; cur[lod][c][t] = at; at += cnt[lod][c][t]; }
    const tmin = Array.from({ length: NT }, () => [Infinity, Infinity, Infinity]), tmax = Array.from({ length: NT }, () => [-Infinity, -Infinity, -Infinity]);
    const tmp = new Float32Array(160 * 3), tlist = [];
    let v = 0;
    for (let i = 0; i < n; i++) {
      const o = i * stride, x = rec[o], y = rec[o + 1], zg = rec[o + 2];
      const H = Hs[i], r = Rs[i], base = Bs[i], k = kinds[i], depth = H - base;
      const dens = clamp(isFinite(rec[o + 7]) ? rec[o + 7] : 1, 0, 1);
      const out = outlineOf(rec, o, stride, k);
      const R = outlineFn(out, k === 2 || base <= Math.max(0.3, 0.04 * H));
      const h1 = hash01(x, y, 1), h2 = hash01(x, y, 2), h3 = hash01(x, y, 3), h4 = hash01(x, y, 4);
      const rot = h1 * Math.PI * 2, sx = 0.93 + 0.14 * h2, sy = 2 - sx;      // turned, a little oval
      const lean = (k === 2 ? 0.04 : 0.06) * r, lx = lean * Math.cos(h3 * 6.283), ly = lean * Math.sin(h3 * 6.283);
      const dz = shift(x, y) - h0 - (curv ? (x * x + y * y) / (2 * EARTH_R) : 0);
      const zb = zg + base + dz;
      const cz = zb + depth * 0.5;
      const g0 = k === 2 && gAt ? gAt(x, y) : NaN;          // brush feet follow the slope (the job's ground under each)
      const tb = tile[i], bmin = tmin[tb], bmax = tmax[tb];
      for (let lod = 0; lod < 2; lod++) {
        const v0 = v, c = cls[i];
        let ti = cur[lod][c][tb] / 3;
        tlist.length = 0;
        const put = (px, py, hz, hag) => {
          m.pos[v * 3] = px; m.pos[v * 3 + 1] = py; m.pos[v * 3 + 2] = hz;
          m.aux[v * 2] = cm(hag); m.aux[v * 2 + 1] = cm(H);
          m.meta[v * 4] = k * 127; m.meta[v * 4 + 1] = Math.round(dens * 255); m.meta[v * 4 + 2] = Math.round(h4 * 255); m.meta[v * 4 + 3] = (lod ? 128 : 0) + c;
          m.ctr[v * 4] = off(x - px); m.ctr[v * 4 + 1] = off(y - py); m.ctr[v * 4 + 2] = off(cz - hz);
          boxAdd(m, px, py, hz);
          if (px < bmin[0]) bmin[0] = px; if (py < bmin[1]) bmin[1] = py; if (hz < bmin[2]) bmin[2] = hz;
          if (px > bmax[0]) bmax[0] = px; if (py > bmax[1]) bmax[1] = py; if (hz > bmax[2]) bmax[2] = hz;
          return v++;
        };
        const tri = (a, b, d) => { m.idx[ti * 3] = a; m.idx[ti * 3 + 1] = b; m.idx[ti * 3 + 2] = d; tlist.push(ti); ti++; };
        // rings: [t, radius share, segments, lobes]; a pole on top; one below when closed
        let seg, ts, closed = true, lobe = null, jit = 0.07, kR = 1;
        if (k === 2) {
          // a clump, not a disc: tucked in at the foot, widest a third of the way up, 2-3 lobes round it
          seg = lod ? 4 : BRUSH_SEG; ts = [0.02, 0.42]; closed = false; jit = lod ? 0 : 0.08;
          const nl = 2 + Math.floor(h3 * 1.99), ph = h2 * 6.283;
          lobe = lod ? () => 1 : (a, q) => (q ? 1.08 : 0.8) * (1 + 0.3 * Math.cos(nl * a + ph));
          kR = lod ? 1.1 : 1;
        } else if (lod) { seg = 3; ts = [0.3, 0.72]; kR = 1.12; jit = 0; } else { seg = SEG[c]; ts = ringsFor(depth, c); }
        kR *= polyK(lod ? 2 * seg : seg);
        // brush: the top pole leans toward one lobe and sits a little lower, so the clump's top is uneven
        const bx = k === 2 && !lod ? 0.22 * r * Math.cos(h2 * 6.283) : 0, by = k === 2 && !lod ? 0.22 * r * Math.sin(h2 * 6.283) : 0;
        const top = put(x + lx + bx, y + ly + by, zb + depth * (k === 2 ? 0.88 + 0.12 * h4 : 1), k === 2 ? H * (0.88 + 0.12 * h4) : H);
        const ring0 = v;
        for (let q = 0; q < ts.length; q++) {
          const tt = ts[q], rr = R(tt) * r * kR, off = rot + q * Math.PI / seg;    // staggered rings: rounder for the same count
          for (let s = 0; s < seg; s++) {
            const a = off + (s / seg) * Math.PI * 2, j = 1 + jit * (hash01(x, y, 10 + q * 16 + s) - 0.5) * 2, L = lobe ? lobe(a - rot, q) : 1;
            const zz = tt * depth * (k === 2 && q && !lod ? 0.75 + 0.5 * hash01(x, y, 90 + s) : 1);
            const px = x + Math.cos(a) * rr * j * L * sx + lx * tt, py = y + Math.sin(a) * rr * j * L * sy + ly * tt;
            let foot = 0;
            if (q === 0 && g0 === g0) { const d = gAt(px, py) - g0; if (Number.isFinite(d)) foot = Math.max(Math.min(d, 0), -depth * 3) - 0.1; }   // down only: uphill it is buried anyway
            put(px, py, zb + zz + foot, base + zz);
          }
        }
        const bot = closed ? put(x, y, zb, base) : -1;
        const ring = q => ring0 + q * seg, nr = ts.length;
        for (let s = 0; s < seg; s++) {
          const s1 = (s + 1) % seg;
          tri(top, ring(nr - 1) + s, ring(nr - 1) + s1);
          for (let q = nr - 1; q > 0; q--) {
            // ring q sits half a segment turned from ring q-1: its corner s lies between q-1's s and s+1
            const a = ring(q), b = ring(q - 1);
            tri(a + s, b + s, b + s1); tri(a + s, b + s1, a + s1);
          }
          if (closed) tri(bot, ring(0) + s1, ring(0) + s);
        }
        cur[lod][c][tb] = ti * 3;
        normalsFor(m, v0, v, tlist, null, tmp);
      }
    }
    m.blocks = { tiles: tmin.map((a, t) => ({ min: a, max: tmax[t] })), start, count: cnt, grid: { x0: tg.x0, y0: tg.y0, size: tg.size, nx: tg.nx, ny: tg.ny }, switchM: SWITCH_M.slice(), fade: FADE };
    return m;
  }

  /**
   * Which index ranges to draw this frame. blocks from buildShapes; cam = the camera in the local frame [x, y, z];
   * visible(t) = the tile is in view; lod = the switch distance multiplier. Near blocks are drawn where a tile's nearest
   * point is inside the class's fade band end, far blocks where its farthest point is past the switch; runs closer than
   * `gap` tiles are merged (the shader collapses what is not needed, so a merged range is never wrong, only a little
   * more vertex work). Returns { near: [[first, count]...], far: [...] } in indices.
   */
  function pickRanges(blocks, cam, visible, lod, gap) {
    gap = gap == null ? 2 : gap; lod = lod || 1;
    const NT = blocks.tiles.length, dmin = new Float64Array(NT), dmax = new Float64Array(NT), vis = new Uint8Array(NT);
    for (let t = 0; t < NT; t++) {
      const b = blocks.tiles[t];
      if (!(b.max[0] >= b.min[0])) { vis[t] = 0; continue; }
      vis[t] = visible ? (visible(t) ? 1 : 0) : 1;
      let s = 0, S = 0;
      for (let a = 0; a < 3; a++) {
        const c = cam[a], lo = b.min[a], hi = b.max[a];
        const d = c < lo ? lo - c : c > hi ? c - hi : 0; s += d * d;
        const D = Math.max(Math.abs(c - lo), Math.abs(c - hi)); S += D * D;
      }
      dmin[t] = Math.sqrt(s); dmax[t] = Math.sqrt(S);
    }
    const out = { near: [], far: [] };
    for (let lod2 = 0; lod2 < 2; lod2++) {
      const list = lod2 ? out.far : out.near;
      for (let c = 0; c < blocks.start[lod2].length; c++) {
        const sw = blocks.switchM[c] * lod, st = blocks.start[lod2][c], cn = blocks.count[lod2][c];
        let run = null, miss = 0;
        for (let t = 0; t < NT; t++) {
          const need = vis[t] && cn[t] > 0 && (lod2 ? dmax[t] > sw : dmin[t] < sw * (1 + blocks.fade));
          if (need) {
            if (run && miss <= gap) run[1] = st[t] + cn[t] - run[0];
            else { run = [st[t], cn[t]]; list.push(run); }
            miss = 0;
          } else if (run && cn[t] > 0) miss++;
        }
      }
    }
    return out;
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
      m.aux[i * 2] = cm(hag); m.aux[i * 2 + 1] = cm(hag);
      m.meta[i * 4] = 0; m.meta[i * 4 + 1] = 255; m.meta[i * 4 + 2] = 128; m.meta[i * 4 + 3] = 255;
      boxAdd(m, x, y, hz);
    }
    m.idx.set(sh.t);
    normalsFor(m, 0, sh.V, 0, sh.T);
    return m;
  }

  /** The height the tint reaches its top colour at: the 95th percentile of the tree heights (one 60 m giant does not
   *  leave the rest of the forest dark), else stats.max_height, else 20 m. */
  function tintTop(rec, n, veg, stride) {
    stride = stride || 8;
    const hs = [];
    for (let i = 0; i < n; i++) if (Math.round(rec[i * stride + 6]) !== 2 && isFinite(rec[i * stride + 3])) hs.push(rec[i * stride + 3]);
    if (hs.length >= 5) { hs.sort((a, b) => a - b); return Math.max(3, hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.95))]); }
    return Number(veg && veg.stats && veg.stats.max_height) || 20;
  }

  const pure = { tintTop, DEFAULTS, LOOKS, PROFILE_T, KIND_OUTLINE, CAP_MIN, SIZE_R, SEG, SWITCH_M, RINGS, EARTH_R, clampSettings, hexRgb, parseShapes, parseShell, parseGround, bilinear,
    terrainGridSpec, makeShift, hash01, outlineOf, outlineFn, sizeClass, ringsFor, shapeCounts, tileGrid, brushCaps, buildShapes, pickRanges, buildShell, VERTEX_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window === 'undefined') return;

  // ── Shaders ───────────────────────────────────────────────────────────────
  // One vertex shader for every pass. u_overlay = 1 in the colour passes (drawn in Cesium's OVERLAY pass, after the
  // scene is composited, with no depth test): z is clamped into the clip volume there so nothing is cut by the far plane.
  const VS = `
in vec3 position;
in vec4 normal;
in vec2 aux;       // cm / 65535 (normalised u16): hag of the vertex, the shape's top height
in vec4 meta;
in vec4 ctr;       // cm (int16): from the vertex to the shape's middle
uniform float u_minH;
uniform float u_trees;
uniform float u_brush;
uniform float u_overlay;
uniform float u_lod;
out vec3 v_nEC;
out vec3 v_pEC;
out float v_hag;
out vec4 v_meta;
out float v_fade;
out float v_lodm;
void main() {
  bool shell = meta.w > 0.9;
  bool brushy = meta.x > 0.75;
  float hTop = aux.y * 655.35;
  bool hide = !shell && (hTop < u_minH || (brushy && u_brush < 0.5) || (!brushy && u_trees < 0.5));
  // level of detail, per shape: its middle's distance against its switch distance; near shapes go at the band's far
  // end, far ones before its near end, and inside the band both are drawn and dissolve into each other (fragment shader)
  float lodm = shell ? 0.0 : (meta.w > 0.3 ? 2.0 : 1.0);
  float f = 0.0;
  if (!shell) {
    float c = mod(floor(meta.w * 255.0 + 0.5), 128.0);
    float sw = (c < 0.5 ? ${SWITCH_M[0].toFixed(1)} : c < 1.5 ? ${SWITCH_M[1].toFixed(1)} : c < 2.5 ? ${SWITCH_M[2].toFixed(1)} : ${SWITCH_M[3].toFixed(1)}) * u_lod;
    float d = length((czm_modelView * vec4(position + ctr.xyz * 0.01, 1.0)).xyz);
    f = clamp((d - sw) / (${FADE.toFixed(2)} * sw), 0.0, 1.0);
    if (lodm > 1.5 ? f <= 0.0 : f >= 1.0) hide = true;
  }
  v_fade = f;
  v_lodm = lodm;
  vec4 pEC = czm_modelView * vec4(position, 1.0);
  v_pEC = pEC.xyz;
  v_nEC = czm_normal * normal.xyz;
  v_hag = aux.x * 655.35;
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
in float v_fade;
in float v_lodm;
uniform float u_minH;
uniform float u_trees;
uniform float u_brush;
uniform float u_brushTop;
// true when this fragment is hidden: behind the terrain (the globe's depth), a shell part filtered out by height, or
// the share of a shape that has dissolved into its other level of detail (a fixed screen pattern, the same in every pass)
bool vegHidden() {
  if (v_meta.w > 0.9) {
    if (v_hag < u_minH) return true;
    bool brushy = v_hag < u_brushTop;
    if (brushy && u_brush < 0.5) return true;
    if (!brushy && u_trees < 0.5) return true;
  } else if (v_fade > 0.0 && v_fade < 1.0) {
    float dn = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
    if (v_lodm > 1.5 ? dn >= v_fade : dn < v_fade) return true;
  }
  float d = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
  if (d > 0.0 && d < 1.0) {
    vec4 e = czm_windowToEyeCoordinates(gl_FragCoord.xy, d);
    float gz = e.z / e.w;
    // brush is low: the terrain shown is often a metre or two off the LiDAR ground on rough slopes, so it gets more slack
    float slack = (v_meta.w < 0.9 && v_meta.x > 0.75) ? 1.5 : 0.3;
    if (v_pEC.z < gz - (slack + 0.002 * abs(gz))) return true;
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
  // Colour. Crowns: height tint, soft light, a lighter, yellower top (so a crown reads over forest imagery from straight
  // above, where green on green would vanish), a light fresnel rim. Brush: its own colour, a little more solid, lit as
  // lumps, with a dark rim instead of a light one (scrub reads as dark clumps, crowns as light shells).
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
  bool shell = v_meta.w > 0.9;
  bool brushy = shell ? v_hag < u_brushTop : v_meta.x > 0.75;
  float t = clamp(v_hag / max(u_hMax, 1.0), 0.0, 1.0);
  vec3 base = brushy ? u_cBrush : (u_tint > 0.5 ? mix(u_cLow, u_cHigh, smoothstep(0.0, 1.0, t)) : mix(u_cLow, u_cHigh, 0.45));
  base *= 0.88 + 0.24 * v_meta.z;
  float nup = dot(N, up);
  float lit = 0.55 + 0.3 * max(dot(N, L), 0.0) + 0.25 * (0.5 + 0.5 * nup);
  vec3 col = base * lit;
  float topF = smoothstep(0.35, 0.95, nup);
  float dens = 0.55 + 0.45 * v_meta.y;
  float a;
  if (brushy && !shell) {
    // brush: more solid than crowns, lumps lit harder with a lighter top, darker at the foot (it sits on the ground)
    // and a darker rim: scrub reads as low solid clumps, crowns as light shells
    float foot = 1.0 - smoothstep(0.0, 0.8, v_hag);
    col = base * (0.5 + 0.55 * max(dot(N, L), 0.0) + 0.3 * (0.5 + 0.5 * nup));
    col = mix(col, mix(base, vec3(0.82, 0.88, 0.5), 0.3) * 1.08, 0.5 * topF);
    col *= 1.0 - 0.4 * foot;
    vec3 rimCol = base * 0.5;
    float er = clamp(u_edge * rim * 1.2, 0.0, 1.0);
    if (u_mode > 0.5) { a = u_behind * u_edge * rim * (0.45 + u_opacity) * 0.4 * (1.0 - far); col = rimCol; }
    else { a = u_opacity * u_fill * dens * mix(3.4, 3.0, far) + u_edge * rim * (0.35 + u_opacity) * 0.7; col = mix(col, rimCol, er); }
  } else {
    vec3 rimCol = mix(base, vec3(0.75, 1.0, 0.5), 0.4) * 1.12;
    vec3 topCol = mix(base, vec3(0.96, 1.0, 0.62), 0.38) * 1.08;
    col = mix(col, topCol, topF * 0.7);
    float er = clamp(u_edge * rim * 1.6, 0.0, 1.0);
    if (u_mode > 0.5) {
      a = u_behind * u_edge * rim * (0.45 + u_opacity) * 0.6 * (1.0 - far);
      col = rimCol;
    } else {
      a = u_opacity * u_fill * dens * mix(1.4, 1.9, far) * (1.0 + 0.35 * topF) + u_edge * rim * (0.45 + u_opacity);
      col = mix(col, rimCol, er);
    }
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
    const gpu = { shapes: null, shell: null };           // { va, sphere, triangles, blocks?, tileSpheres?, inv? }
    let progPre = null, progCol = null, progColLog = null, rsPre = null, rsCol = null, destroyed = false;
    let fbo = null, nearTex = null, fboW = 0, fboH = 0, clearCmd = null;
    const ATTR = { position: 0, normal: 1, aux: 2, meta: 3, ctr: 4 };
    const rgb = { low: new C.Cartesian3(), high: new C.Cartesian3(), brush: new C.Cartesian3() };
    const setRgb = (c, h) => { const a = hexRgb(h); c.x = a[0]; c.y = a[1]; c.z = a[2]; return c; };
    const common = {
      u_minH: () => S.minHeight, u_trees: () => (S.trees ? 1 : 0), u_brush: () => (S.brush ? 1 : 0),
      u_brushTop: () => (D && D.brushTop) || 2, u_overlay: () => 0, u_lod: () => S.lod,
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
      for (const k of ['shapes', 'shell']) if (gpu[k]) for (const c of gpu[k].pool.pre) c.framebuffer = fbo;
    }
    function upload(context, mesh, modelMatrix) {
      const vb = (a, n, type, norm) => ({ vertexBuffer: C.Buffer.createVertexBuffer({ context, typedArray: a, usage: C.BufferUsage.STATIC_DRAW }), componentsPerAttribute: n, componentDatatype: type, normalize: !!norm });
      const attributes = [
        Object.assign({ index: ATTR.position }, vb(mesh.pos, 3, C.ComponentDatatype.FLOAT)),
        Object.assign({ index: ATTR.normal }, vb(mesh.nrm, 4, C.ComponentDatatype.BYTE, true)),
        Object.assign({ index: ATTR.aux }, vb(mesh.aux, 2, C.ComponentDatatype.UNSIGNED_SHORT, true)),
        Object.assign({ index: ATTR.meta }, vb(mesh.meta, 4, C.ComponentDatatype.UNSIGNED_BYTE, true)),
        Object.assign({ index: ATTR.ctr }, vb(mesh.ctr, 4, C.ComponentDatatype.SHORT)),
      ];
      const indexBuffer = C.Buffer.createIndexBuffer({ context, typedArray: mesh.idx, usage: C.BufferUsage.STATIC_DRAW, indexDatatype: C.IndexDatatype.UNSIGNED_INT });
      const va = new C.VertexArray({ context, attributes, indexBuffer });
      const toSphere = (lo, hi) => {
        const centre = new C.Cartesian3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
        return new C.BoundingSphere(C.Matrix4.multiplyByPoint(modelMatrix, centre, new C.Cartesian3()), 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 1);
      };
      const sphere = toSphere(mesh.min, mesh.max);
      const g = { va, sphere, triangles: mesh.triangles, blocks: mesh.blocks || null, modelMatrix, inv: C.Matrix4.inverseTransformation(modelMatrix, new C.Matrix4()),
        pool: { pre: [], col: [], behind: [] }, drawn: 0 };
      if (g.blocks) g.tileSpheres = g.blocks.tiles.map(t => (t.max[0] >= t.min[0] ? toSphere(t.min, t.max) : null));
      return g;
    }
    // the n-th command of a kind for a mesh (made once, then only its range changes)
    function cmdOf(g, kind, n) {
      const pool = g.pool[kind];
      if (!pool[n]) {
        const pre = kind === 'pre';
        pool[n] = new C.DrawCommand({ vertexArray: g.va, primitiveType: C.PrimitiveType.TRIANGLES, shaderProgram: pre ? progPre : progCol, renderState: pre ? rsPre : rsCol,
          uniformMap: maps[kind], modelMatrix: g.modelMatrix, boundingVolume: g.sphere, pass: pre ? C.Pass.OPAQUE : C.Pass.OVERLAY, owner: api, cull: false, framebuffer: pre ? fbo : undefined });
      }
      return pool[n];
    }
    const free = k => { if (gpu[k]) { try { gpu[k].va.destroy(); } catch (_) {} gpu[k] = null; } };
    const camLocal = new C.Cartesian3();
    const api = {
      show: true,
      pending: null,              // { modelMatrix, shapes: mesh|null, shell: mesh|null } waiting for a context
      frames: 0,
      drawn: 0,                   // triangles handed to the GPU in the last frame (colour pass; collapsed shapes included)
      passTris: 0,                // the same over all three passes
      ranges: 0,                  // index ranges drawn in the last frame (per pass)
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
        this.drawn = 0; this.ranges = 0; this.passTris = 0;
        if (!vis.length) return;
        ensureTarget(context);
        clearCmd.execute(context);
        const prog = frameState.useLogDepth ? progColLog : progCol;
        const list = frameState.commandList, pre = [], behind = [], col = [];
        for (const g of vis) {
          let near, far;
          if (g.blocks) {
            C.Matrix4.multiplyByPoint(g.inv, frameState.camera.positionWC, camLocal);
            const r = pickRanges(g.blocks, [camLocal.x, camLocal.y, camLocal.z], t => !!g.tileSpheres[t] && (!cv || cv.computeVisibility(g.tileSpheres[t]) !== C.Intersect.OUTSIDE), S.lod);
            near = r.near; far = r.far;
          } else { near = [[0, g.triangles * 3]]; far = []; }
          let n = 0, nb = 0;
          const add = (rg, withBehind) => {
            for (const [first, count] of rg) {
              const cp = cmdOf(g, 'pre', n), cc = cmdOf(g, 'col', n); n++;
              cp.offset = first; cp.count = count; cc.offset = first; cc.count = count; cc.shaderProgram = prog;
              pre.push(cp); col.push(cc); this.drawn += count / 3; this.ranges++;
              // rims behind the nearest layer: only near shapes (far, a crown is a few pixels and its rims are sparkle)
              if (withBehind && S.behind > 0 && S.edge > 0) { const cb = cmdOf(g, 'behind', nb++); cb.offset = first; cb.count = count; cb.shaderProgram = prog; behind.push(cb); }
            }
          };
          add(near, true); add(far, false);
        }
        for (const c of pre) list.push(c);
        for (const c of behind) { list.push(c); this.passTris += c.count / 3; }
        for (const c of col) list.push(c);
        this.passTris += 2 * this.drawn;
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
      shapes: D.sh.n ? buildShapes(D.sh.rec, D.sh.n, { shift: shift.at, h0, stride: D.sh.stride, groundAt: D.ground ? (x, y) => bilinear(D.ground, D.gspec.nx, D.gspec.ny, D.gspec.x0, D.gspec.y0, D.gspec.cell, D.gspec.cell, x, y) : null }) : null,
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
      const rec = veg.shapes ? Number(veg.shapes.record) || (Number(veg.version) >= 2 ? 48 : 32) : 32;
      if (rec !== 32 && rec !== 48) throw new Error('shapes.bin record ' + rec + ' is not one this FLEX reads (32 or 48)');
      const sh = veg.shapes ? parseShapes(o.shapes, veg.shapes.count, rec) : parseShapes(null);
      const shell = veg.shell ? parseShell(o.shell, veg.shell.vertices, veg.shell.triangles) : parseShell(null);
      const g = veg.ground || null;
      const ground = g ? parseGround(o.ground, g.nx, g.ny) : null;
      const hMax = tintTop(sh.rec, sh.n, veg, sh.stride);
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
    const vert = m => (m ? m.vertices : 0), gpuBytes = ['shapes', 'shell'].reduce((a, k) => { const m = D.meshes && D.meshes[k]; return a + (m ? m.vertices * VERTEX_BYTES + m.triangles * 12 : 0); }, 0);
    const ms = D.meshes && D.meshes.shapes;
    return {
      loaded: true, shapes: D.sh.n, triangles: tri, trianglesShapes: tS, trianglesShell: tH, vertices: vert(D.meshes && D.meshes.shapes) + vert(D.meshes && D.meshes.shell),
      counts: D.meshes && D.meshes.shapes ? Object.assign({}, D.meshes.shapes.counts) : { dome: 0, cone: 0, brush: 0 },
      bytes: D.bytes, gpuBytes, buildMs: D.buildMs != null ? Math.round(D.buildMs) : null, drawMs: lastDrawMs, heights: D.mode, h0: D.h0,
      uploaded: !!(prim && (prim.uploaded('shapes') || prim.uploaded('shell'))),
      // shapes: near and far meshes both live on the GPU; each frame draws the near ones close by and the far ones beyond
      trianglesNear: ms ? ms.trianglesNear : 0, trianglesFar: ms ? ms.trianglesFar : 0, record: D.sh.stride * 4,
      drawnTriangles: prim ? Math.round(prim.drawn) : 0, ranges: prim ? prim.ranges : 0,
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
    return { onMs: on, offMs: off, drawMs: lastDrawMs, triangles: stats().triangles, drawn: prim ? Math.round(prim.drawn) : 0, allPasses: prim ? Math.round(prim.passTris) : 0, ranges: prim ? prim.ranges : 0 };
  }

  // The terrain shown changed: follow it (onTerrain only).
  function terrainMaybeChanged() { if (D && S.onTerrain && D.ground) rebuild(); }
  window.addEventListener('flex-terrain-changed', terrainMaybeChanged);
  setInterval(() => { const v = V(); if (D && S.onTerrain && D.ground && D.terrainProv && v && v.terrainProvider !== D.terrainProv) terrainMaybeChanged(); }, 2000);

  window._vegDraw = { load, loadData, set, get, stats, clear: () => clear(false), flyTo, loaded: () => !!D, bench, pure };
})();
