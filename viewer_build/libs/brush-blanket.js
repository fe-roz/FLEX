// The brush grid drawn as a blanket in the portable viewer / FLEX Field: one look of libs/brush-blocks.js
// (window.FlexBrushLooks.blanket; the interface is at the top of that file). FlexBrush.look('blanket') puts it on.
//
// One soft green surface lies on the ground at the brush's measured height, and how dense the brush is shows as
// how solid the surface is. Two separate things make it:
//
//   The SHAPE is a height field. A vertex sits at a cell's centre, at the ground there plus the cell's brush
//   height (0 where the cell is bare, so the surface comes down to the ground where brush ends; no walls). On a
//   slope the offset is stretched by 1 / cos(slope) (twice at most), so the surface stays the brush's height
//   away from the ground, measured square to it. Normals are the field's own, smooth, so it is lit like a second
//   terrain. The field is drawn in tiles of NODE x NODE quads at LEVELS levels: a quad is 1, 2, 4, 8 or 16 cells
//   wide, the coarser heights being the finer ones smoothed (1 2 1 each way, bare cells count as 0).
//   Levels go by distance alone: level l is drawn out to RANGE tiles of its own size. So that a change of level
//   never shows, every vertex also carries its height and normal in the next coarser level's surface, and the
//   vertex shader moves it there over the last part of its level's range (from M0 to M1 of the range): where a
//   fine tile meets a coarse one the two surfaces are the same, without skirts or cracks, and nothing pops.
//
//   The DENSITY is not in the geometry at all. The cells' shares are a texture (one byte a cell, in pieces of
//   REGION cells a side with their neighbours' edge cells around them, mip-mapped), turned to opacity by one
//   curve through the class limits (alphaLut: faint from the lightest class's limit, about half in the medium
//   class, solid in the dense one; under the lightest limit nothing). The fragment shader reads it per pixel, so
//   the density keeps the grid's full 0.9 m at every distance and level, as the baked brush map does. Opacity
//   times the Brush chip's level is drawn by ordered dither (discard, no blending, no sorting): PATTERN picks the
//   threshold pattern.
//
// Quads with no brush in or next to them are left out of a tile's triangles, tiles without any are never made.
// Tiles are meshed when a view first needs them, a few milliseconds a frame (the coarser tile is drawn
// meanwhile), and the least recently drawn are dropped past the cache. Over the triangle budget the finest level
// in use goes up one (the density does not change, only the shape gets coarser). update() returns at once when
// the camera has not moved and nothing is waiting; nothing animates.
// The blanket is not part of the terrain: the height grid and taps do not see it.   Test: tools/test_brush_blanket.js
(function (root) {
  'use strict';

  var NODE = 32, LEVELS = 5;                                   // quads a tile side; a quad is 1, 2, 4, 8, 16 cells
  var RANGE = 7;                                               // level l is drawn out to this many of its tiles' side
  var M0 = 0.8, M1 = 0.96;                                     // the morph to the coarser level: over this part of the range
  var LIFT = 0.12;                                             // the surface is this far over the ground where there is no height (m)
  var BIAS = 0.05;                                             // …and this much higher per cell a quad is wider than one (the ground between coarse vertices) (m)
  var KMAX = 2;                                                // the slope's stretch of the offset, at most
  var LOW_CM = 30;                                             // a brushy cell with no height has the band's low edge
  var REGION = 1024;                                           // cells a side of one piece of the density texture
  var COLOUR = 0x3f7d2c, EMISSIVE = 0x15290f;                  // one brush green; a little of its own light so shade is not black
  var CACHE_TILES = 700;                                       // tiles kept meshed
  // Opacity at each class's lower limit (lightest first) and where it reaches solid inside the densest class.
  var KNOTS = [0.14, 0.36, 0.80], SOLID_AT = 0.5;
  var PATTERNS = { bayer4: 0, bayer8: 1, noise: 2 };
  var PATTERN = 'noise';

  // Share byte -> opacity byte. Under the lightest class's limit 0; at the class limits KNOTS (spread over the
  // classes when there are not three); solid from SOLID_AT of the way through the densest class; straight between.
  function alphaLut(classes) {
    var n = classes.length, xs = [], ys = [], k, i, lut = new Uint8Array(256);
    for (k = 0; k < n; k++) {
      var t = n === 1 ? 0.5 : k / (n - 1) * 2, a = t <= 1 ? KNOTS[0] + (KNOTS[1] - KNOTS[0]) * t : KNOTS[1] + (KNOTS[2] - KNOTS[1]) * (t - 1);
      xs.push(classes[k].min); ys.push(a);
    }
    var last = classes[n - 1].min; xs.push(last + (1 - last) * SOLID_AT); ys.push(1);
    var cut = classes[0].cut != null ? classes[0].cut : Math.max(1, Math.ceil(classes[0].min * 255 - 1e-9));
    for (i = cut; i < 256; i++) {
      var s = i / 255, v = 1;
      if (s <= xs[0]) v = ys[0];
      else for (k = 1; k < xs.length; k++) if (s <= xs[k]) { v = ys[k - 1] + (ys[k] - ys[k - 1]) * (s - xs[k - 1]) / Math.max(1e-9, xs[k] - xs[k - 1]); break; }
      lut[i] = Math.max(1, Math.round(v * 255));
    }
    return lut;
  }

  // Everything pure of a grid: P = { F (the grid), lut, W[l], Hh[l] (vertices a side per level), H[l] (heights in
  // cm, l >= 1), A[l] (the most opacity in each block of 2^l cells, l >= 1), cells (brushy cells) }.
  function prep(grid, classes) {
    var F = grid, nx = F.nx, ny = F.ny, lut = alphaLut(classes), l, i, j, cells = 0;
    var W = [nx], Hh = [ny], H = [null], A = [null];
    for (l = 1; l < LEVELS; l++) {
      var w = W[l - 1], h = Hh[l - 1], w2 = (w + 1) >> 1, h2 = (h + 1) >> 1, hh = new Uint8Array(w2 * h2), aa = new Uint8Array(w2 * h2);
      if (l === 1) {
        // one pass over the cells: each brushy cell adds its height to the coarse vertices it weighs on
        var acc = new Uint16Array(w2 * h2);                                         // sixteenths of cm
        for (j = 0; j < ny; j++) {
          var r = j * nx, J = j >> 1, oj = j & 1;
          for (i = 0; i < nx; i++) {
            var a = lut[F.share[r + i]];
            if (!a) continue;
            cells++;
            var hc = F.height[r + i] || LOW_CM, I = i >> 1, oi = i & 1, q = J * w2 + I;
            if (a > aa[q]) aa[q] = a;
            // weights 1 2 1 each way round an even cell: an even cell is a vertex (2), an odd one lies between two (1 each)
            if (!oi && !oj) acc[q] += 4 * hc;
            else if (oi && !oj) { acc[q] += 2 * hc; if (I + 1 < w2) acc[q + 1] += 2 * hc; }
            else if (!oi && oj) { acc[q] += 2 * hc; if (J + 1 < h2) acc[q + w2] += 2 * hc; }
            else { acc[q] += hc; if (I + 1 < w2) acc[q + 1] += hc; if (J + 1 < h2) { acc[q + w2] += hc; if (I + 1 < w2) acc[q + w2 + 1] += hc; } }
          }
        }
        for (i = 0; i < acc.length; i++) hh[i] = (acc[i] + 8) >> 4;
      } else {
        var hp = H[l - 1], ap = A[l - 1], acc2 = new Uint16Array(w2 * h2);
        for (j = 0; j < h; j++) {
          var r1 = j * w, J1 = j >> 1, oj1 = j & 1;
          for (i = 0; i < w; i++) {
            var q1 = J1 * w2 + (i >> 1), a1 = ap[r1 + i], h1 = hp[r1 + i];
            if (a1 > aa[q1]) aa[q1] = a1;
            if (!h1) continue;
            var oi1 = i & 1, I1 = i >> 1;
            if (!oi1 && !oj1) acc2[q1] += 4 * h1;
            else if (oi1 && !oj1) { acc2[q1] += 2 * h1; if (I1 + 1 < w2) acc2[q1 + 1] += 2 * h1; }
            else if (!oi1 && oj1) { acc2[q1] += 2 * h1; if (J1 + 1 < h2) acc2[q1 + w2] += 2 * h1; }
            else { acc2[q1] += h1; if (I1 + 1 < w2) acc2[q1 + 1] += h1; if (J1 + 1 < h2) { acc2[q1 + w2] += h1; if (I1 + 1 < w2) acc2[q1 + w2 + 1] += h1; } }
          }
        }
        for (i = 0; i < acc2.length; i++) hh[i] = (acc2[i] + 8) >> 4;
      }
      W[l] = w2; Hh[l] = h2; H[l] = hh; A[l] = aa;
    }
    return { F: F, lut: lut, W: W, Hh: Hh, H: H, A: A, cells: cells };
  }
  // The brush height (m) at vertex (I, J) of level l; 0 where bare or off the grid.
  function heightAt(P, l, I, J) {
    if (I < 0 || J < 0 || I >= P.W[l] || J >= P.Hh[l]) return 0;
    if (l) return P.H[l][J * P.W[l] + I] / 100;
    var k = J * P.F.nx + I;
    return P.lut[P.F.share[k]] ? (P.F.height[k] || LOW_CM) / 100 : 0;
  }
  // The most opacity (byte) in block (I, J) of level l (a cell at level 0); 0 off the grid.
  function anyAt(P, l, I, J) {
    if (I < 0 || J < 0 || I >= P.W[l] || J >= P.Hh[l]) return 0;
    return l ? P.A[l][J * P.W[l] + I] : P.lut[P.F.share[J * P.F.nx + I]];
  }

  // The surface's heights round a tile: Z for the (n + 3) x (n + 3) vertices from (I0 - 1, J0 - 1) of level l
  // (NaN off the terrain or off the grid). A vertex's height depends on its level and place only, never on the
  // tile that asks, so two tiles agree on a vertex they share.
  var sG = null, sZ = null, sZc = null, sNc = null;
  function lattice(P, groundZ, l, I0, J0, n, out) {
    var F = P.F, s = 1 << l, d = F.cell * s, m = n + 5, i, j, a, b;
    // the ground at half the level's spacing (level 0: at its own), from two vertices before the first
    var f = l ? 2 : 1, m2 = (m - 1) * f + 1, hs = s / f;
    if (!sG || sG.length < m2 * m2) sG = new Float32Array(m2 * m2);
    for (j = 0; j < m2; j++) for (i = 0; i < m2; i++) {
      var g = groundZ(F.x0 + ((I0 - 2) * s + i * hs + 0.5) * F.cell, F.y0 + ((J0 - 2) * s + j * hs + 0.5) * F.cell);
      sG[j * m2 + i] = g == null || !isFinite(g) ? NaN : g;
    }
    var w = n + 3, extra = LIFT + BIAS * (s - 1), st = f * m2;
    for (j = 0; j < w; j++) for (i = 0; i < w; i++) {
      var I = I0 - 1 + i, J = J0 - 1 + j, o = (j + 1) * st + (i + 1) * f, c = sG[o];
      if (c !== c || I < 0 || J < 0 || I >= P.W[l] || J >= P.Hh[l]) { out[j * w + i] = NaN; continue; }
      var e = sG[o + f], ww = sG[o - f], nn = sG[o + st], ss = sG[o - st];
      var gx = e === e && ww === ww ? (e - ww) / (2 * d) : e === e ? (e - c) / d : ww === ww ? (c - ww) / d : 0;
      var gy = nn === nn && ss === ss ? (nn - ss) / (2 * d) : nn === nn ? (nn - c) / d : ss === ss ? (c - ss) / d : 0;
      var k = Math.sqrt(1 + gx * gx + gy * gy), up = 0;
      if (l) {
        // a coarse quad is flat between its corners: the surface is raised by as much as the ground within a
        // quad's reach stands above the slope through this vertex (a ridge or a knob between vertices)
        var hx = gx * d / 2, hy = gy * d / 2;
        for (b = -2; b <= 2; b++) for (a = -2; a <= 2; a++) { var q = sG[o + b * m2 + a] - c - a * hx - b * hy; if (q > up) up = q; }
      }
      out[j * w + i] = c + up + (heightAt(P, l, I, J) + extra) * (k > KMAX ? KMAX : k);
    }
    return out;
  }
  // The unit normal of lattice Z (side w, spacing d) at (i, j), into `o` at `at`; false when there is no surface.
  function normalAt(Z, w, d, i, j, o, at) {
    var c = Z[j * w + i];
    if (c !== c) { o[at] = 0; o[at + 1] = 0; o[at + 2] = 1; return false; }
    var e = i + 1 < w ? Z[j * w + i + 1] : NaN, ww = i > 0 ? Z[j * w + i - 1] : NaN, nn = j + 1 < w ? Z[(j + 1) * w + i] : NaN, ss = j > 0 ? Z[(j - 1) * w + i] : NaN;
    var gx = e === e && ww === ww ? (e - ww) / (2 * d) : e === e ? (e - c) / d : ww === ww ? (c - ww) / d : 0;
    var gy = nn === nn && ss === ss ? (nn - ss) / (2 * d) : nn === nn ? (nn - c) / d : ss === ss ? (c - ss) / d : 0;
    var q = 1 / Math.sqrt(1 + gx * gx + gy * gy);
    o[at] = -gx * q; o[at + 1] = -gy * q; o[at + 2] = q;
    return true;
  }

  // One tile's mesh: tile (tx, ty) of level l is NODE x NODE quads from vertex (tx * NODE, ty * NODE).
  // { pos (x, y, z), zc (the height in the coarser level's surface), nor, nc (Int8 normals: own, coarser),
  //   idx, tris, zmin, zmax } or null when it has nothing to draw. Quads are split from the south-west corner to
  // the north-east one, and the coarser surface under a vertex is read along that same diagonal.
  function meshTile(P, groundZ, l, tx, ty) {
    var F = P.F, s = 1 << l, d = F.cell * s, n = NODE, V = n + 1, w = n + 3, I0 = tx * n, J0 = ty * n, i, j;
    if (I0 >= P.W[l] || J0 >= P.Hh[l]) return null;
    // which quads have brush in or beside them
    var idx = new Uint16Array(n * n * 6), ni = 0, any = new Uint8Array((n + 1) * (n + 1));
    for (j = 0; j <= n; j++) for (i = 0; i <= n; i++) any[j * V + i] = anyAt(P, l, I0 + i, J0 + j) ? 1 : 0;
    var some = false;
    for (j = 0; j < n && !some; j++) for (i = 0; i < n; i++) if (any[j * V + i] || any[j * V + i + 1] || any[(j + 1) * V + i] || any[(j + 1) * V + i + 1]) { some = true; break; }
    if (!some) return null;
    if (!sZ) { sZ = new Float32Array(w * w); sZc = new Float32Array((n / 2 + 3) * (n / 2 + 3)); sNc = new Float32Array((n / 2 + 1) * (n / 2 + 1) * 3); }
    lattice(P, groundZ, l, I0, J0, n, sZ);
    var top = l === LEVELS - 1, hw = n / 2 + 3, hv = n / 2 + 1;
    if (!top) {
      lattice(P, groundZ, l + 1, I0 / 2, J0 / 2, n / 2, sZc);
      for (j = 0; j < hv; j++) for (i = 0; i < hv; i++) normalAt(sZc, hw, d * 2, i + 1, j + 1, sNc, (j * hv + i) * 3);
    }
    var pos = new Float32Array(V * V * 3), zc = new Float32Array(V * V), nor = new Int8Array(V * V * 3), nc = new Int8Array(V * V * 3), tmp = [0, 0, 0];
    var zmin = Infinity, zmax = -Infinity, okv = new Uint8Array(V * V);
    var Zc = function (a, b) { return sZc[(b + 1) * hw + a + 1]; };
    for (j = 0; j <= n; j++) for (i = 0; i <= n; i++) {
      var v = j * V + i, z = sZ[(j + 1) * w + i + 1];
      pos[v * 3] = F.x0 + ((I0 + i) * s + 0.5) * F.cell; pos[v * 3 + 1] = F.y0 + ((J0 + j) * s + 0.5) * F.cell;
      if (z !== z) { pos[v * 3 + 2] = 0; zc[v] = 0; nor[v * 3 + 2] = 127; nc[v * 3 + 2] = 127; continue; }
      okv[v] = 1;
      normalAt(sZ, w, d, i + 1, j + 1, tmp, 0);
      nor[v * 3] = Math.round(tmp[0] * 127); nor[v * 3 + 1] = Math.round(tmp[1] * 127); nor[v * 3 + 2] = Math.round(tmp[2] * 127);
      var c = z, cx = tmp[0], cy = tmp[1], cz = tmp[2];
      if (!top) {
        // the coarser surface here: at one of its vertices, half-way along one of its edges, or on its quad's diagonal
        var a0 = i >> 1, b0 = j >> 1, a1 = a0 + (i & 1), b1 = b0 + (j & 1), z0 = Zc(a0, b0), z1 = Zc(a1, b1);
        if (z0 === z0 && z1 === z1) {
          c = (z0 + z1) / 2;
          var p0 = (b0 * hv + a0) * 3, p1 = (b1 * hv + a1) * 3;
          cx = sNc[p0] + sNc[p1]; cy = sNc[p0 + 1] + sNc[p1 + 1]; cz = sNc[p0 + 2] + sNc[p1 + 2];
          var q = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz); cx *= q; cy *= q; cz *= q;
        }
      }
      pos[v * 3 + 2] = z; zc[v] = c;
      nc[v * 3] = Math.round(cx * 127); nc[v * 3 + 1] = Math.round(cy * 127); nc[v * 3 + 2] = Math.round(cz * 127);
      if (z < zmin) zmin = z; if (z > zmax) zmax = z; if (c < zmin) zmin = c; if (c > zmax) zmax = c;
    }
    for (j = 0; j < n; j++) for (i = 0; i < n; i++) {
      var a = j * V + i, b = a + 1, e = a + V, f = e + 1;
      if (!(any[a] || any[b] || any[e] || any[f]) || !(okv[a] && okv[b] && okv[e] && okv[f])) continue;
      idx[ni++] = a; idx[ni++] = b; idx[ni++] = f; idx[ni++] = a; idx[ni++] = f; idx[ni++] = e;
    }
    if (!ni) return null;
    return { pos: pos, zc: zc, nor: nor, nc: nc, idx: idx.slice(0, ni), tris: ni / 3, zmin: zmin, zmax: zmax };
  }

  // ── The tiles ───────────────────────────────────────────────────────────────
  function range(P, l) { return RANGE * NODE * P.F.cell * (1 << l); }
  // How far a vertex of level l at distance d from the camera has moved to the coarser level's surface (0..1). The shader's rule.
  function morph(P, l, d) { var r = range(P, l), k = (d - M0 * r) / ((M1 - M0) * r); return k < 0 ? 0 : k > 1 ? 1 : k; }
  // Is there brush in or beside tile (tx, ty) of level l?
  function hasBrush(P, l, tx, ty) {
    var I0 = tx * NODE, J0 = ty * NODE, i, j, w = P.W[l], h = P.Hh[l], i1 = Math.min(w - 1, I0 + NODE), j1 = Math.min(h - 1, J0 + NODE);
    if (l) { var A = P.A[l]; for (j = J0; j <= j1; j++) for (i = I0; i <= i1; i++) if (A[j * w + i]) return true; return false; }
    for (j = J0; j <= j1; j++) for (i = I0; i <= i1; i++) if (P.lut[P.F.share[j * w + i]]) return true;
    return false;
  }
  // A tile: { l, tx, ty, box [x0, y0, z0, x1, y1, z1], state (0 not meshed, 1 meshed), tris, mesh, kids, up, last, d }.
  function tile(P, groundZ, l, tx, ty, up) {
    var F = P.F, s = 1 << l, x0 = F.x0 + (tx * NODE * s + 0.5) * F.cell, y0 = F.y0 + (ty * NODE * s + 0.5) * F.cell, side = NODE * s * F.cell, lo = Infinity, hi = -Infinity, i, j;
    for (j = 0; j <= 8; j++) for (i = 0; i <= 8; i++) { var g = groundZ(x0 + side * i / 8, y0 + side * j / 8); if (g != null && isFinite(g)) { if (g < lo) lo = g; if (g > hi) hi = g; } }
    if (lo > hi) { lo = hi = 0; }
    var pad = 3 + (hi - lo) * 0.15;
    return { l: l, tx: tx, ty: ty, up: up || null, state: 0, tris: 0, mesh: null, kids: null, last: 0, d: 0, box: [x0, y0, lo - pad, x0 + side, y0 + side, hi + pad + 6] };
  }
  function kidsOf(P, groundZ, t) {
    if (t.kids) return t.kids;
    var out = [], a, b;
    for (b = 0; b < 2; b++) for (a = 0; a < 2; a++) { var tx = t.tx * 2 + a, ty = t.ty * 2 + b; if (hasBrush(P, t.l - 1, tx, ty)) out.push(tile(P, groundZ, t.l - 1, tx, ty, t)); }
    return (t.kids = out);
  }
  function roots(P, groundZ) {
    var l = LEVELS - 1, out = [], tx, ty;
    for (ty = 0; ty * NODE < P.Hh[l]; ty++) for (tx = 0; tx * NODE < P.W[l]; tx++) if (hasBrush(P, l, tx, ty)) out.push(tile(P, groundZ, l, tx, ty, null));
    return out;
  }
  function boxDist(cam, b) {
    var dx = cam[0] < b[0] ? b[0] - cam[0] : cam[0] > b[3] ? cam[0] - b[3] : 0, dy = cam[1] < b[1] ? b[1] - cam[1] : cam[1] > b[4] ? cam[1] - b[4] : 0, dz = cam[2] < b[2] ? b[2] - cam[2] : cam[2] > b[5] ? cam[2] - b[5] : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  // Which tiles to draw from `cam` ([x, y, z]) with `inView(box)`: a tile of level l is replaced by its four
  // finer ones when it is nearer than the finer level's range (and finer than `minLevel` is never drawn). Draws
  // only meshed tiles; the finer ones it would rather draw are listed in `want`. Pure.
  function select(P, groundZ, rootList, cam, inView, minLevel, want) {
    var draw = [];
    var visit = function (t) {
      if (!inView(t.box)) return;
      t.d = boxDist(cam, t.box);
      if (!t.state) { if (want) want.push(t); return; }
      if (t.l > minLevel && t.d < range(P, t.l - 1)) {
        var kids = kidsOf(P, groundZ, t), ready = true, k;
        for (k = 0; k < kids.length; k++) if (!kids[k].state && inView(kids[k].box)) { ready = false; kids[k].d = boxDist(cam, kids[k].box); if (want) want.push(kids[k]); }
        if (ready) { for (k = 0; k < kids.length; k++) visit(kids[k]); return; }
      }
      if (t.tris) draw.push(t);
    };
    for (var i = 0; i < rootList.length; i++) visit(rootList[i]);
    return draw;
  }
  // The selection that fits the budget: the finest level in use goes up until the triangles fit. { draw, want, minLevel, tris }.
  function fit(P, groundZ, rootList, cam, inView, budget) {
    var ml = 0, want = [], draw, tris, i;
    for (;;) {
      want.length = 0;
      draw = select(P, groundZ, rootList, cam, inView, ml, want);
      for (tris = 0, i = 0; i < draw.length; i++) tris += draw[i].tris;
      if (tris <= budget || ml >= LEVELS - 1) break;
      ml++;
    }
    return { draw: draw, want: want, minLevel: ml, tris: tris };
  }

  // One piece of the density texture: the opacity bytes of the cells from (cx, cy), w x h of them, with one cell
  // of the neighbours all round (0 off the grid). { data, w, h } with w, h the texture's size (cells + 2).
  function regionTexels(P, cx, cy) {
    var F = P.F, cw = Math.min(REGION, F.nx - cx), ch = Math.min(REGION, F.ny - cy), w = cw + 2, h = ch + 2, data = new Uint8Array(w * h), i, j;
    for (j = 0; j < h; j++) {
      var gj = cy + j - 1; if (gj < 0 || gj >= F.ny) continue;
      var r = gj * F.nx + cx - 1, o = j * w, i0 = cx === 0 ? 1 : 0, i1 = Math.min(w, F.nx - cx + 1);
      for (i = i0; i < i1; i++) data[o + i] = P.lut[F.share[r + i]];
    }
    return { data: data, w: w, h: h };
  }

  // ── The shader ──────────────────────────────────────────────────────────────
  var VERT_HEAD = 'attribute float zc;\nattribute vec3 nc;\nuniform vec2 uBkMorph;\nuniform vec4 uBkRegion;\nvarying vec2 vBkUv;\n';
  var VERT_NORMAL = 'float bkMorph = clamp((distance(cameraPosition, position) - uBkMorph.x) * uBkMorph.y, 0.0, 1.0);\n\tvec3 objectNormal = normalize(mix(normal, nc, bkMorph));';
  var VERT_BEGIN = 'vec3 transformed = vec3(position.xy, mix(position.z, zc, bkMorph));\n\tvBkUv = (position.xy - uBkRegion.xy) * uBkRegion.zw;';
  var FRAG_HEAD = 'uniform sampler2D uBkShare;\nuniform float uOpacityDither;\nvarying vec2 vBkUv;\n' +
    'float bkBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }\n' +
    'float bkBayer4(vec2 a) { return bkBayer2(0.5 * a) * 0.25 + bkBayer2(a); }\n' +
    'float bkBayer8(vec2 a) { return bkBayer4(0.5 * a) * 0.25 + bkBayer2(a); }\n' +
    'float bkNoise(vec2 a) { return fract(52.9829189 * fract(dot(floor(a), vec2(0.06711056, 0.00583715)))); }\n';
  var FRAG_THRESHOLD = ['bkBayer4(gl_FragCoord.xy) + 0.03125', 'bkBayer8(gl_FragCoord.xy) + 0.0078125', 'bkNoise(gl_FragCoord.xy) * 0.996 + 0.002'];
  function fragBody(pattern) { return '\n\tif (' + FRAG_THRESHOLD[pattern] + ' > texture2D(uBkShare, vBkUv).r * uOpacityDither) discard;'; }

  function create(ctx) {
    var THREE = ctx.THREE, F = ctx.grid, groundZ = ctx.groundZ;
    var P = prep(F, ctx.classes);
    var pattern = PATTERNS[R.pattern] != null ? PATTERNS[R.pattern] : PATTERNS[PATTERN];
    var S = { P: P, roots: roots(P, groundZ), drawn: [], meshed: [], meshedTris: 0, frame: 0, dirty: true, tris: 0, minLevel: 0, seen: new Float64Array(16),
              budget: ctx.budget && ctx.budget.triangles > 0 ? ctx.budget.triangles : 600000, buildMs: ctx.budget && ctx.budget.buildMs > 0 ? ctx.budget.buildMs : 6,
              uLevel: { value: 1 }, regions: {}, mats: {}, built: 0, gone: false };
    var group = new THREE.Group(); group.name = 'brush-blanket'; group.matrixAutoUpdate = false;
    var m4 = new THREE.Matrix4(), pv = new THREE.Matrix4(), frustum = new THREE.Frustum(), box = new THREE.Box3();

    function regionOf(cx, cy) {
      var key = cx + ',' + cy, r = S.regions[key];
      if (r) return r;
      var T = regionTexels(P, cx, cy), tex = new THREE.DataTexture(T.data, T.w, T.h, THREE.LuminanceFormat, THREE.UnsignedByteType);
      tex.unpackAlignment = 1; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.anisotropy = 4; tex.needsUpdate = true;
      r = S.regions[key] = { tex: tex, v: new THREE.Vector4(F.x0 + (cx - 1) * F.cell, F.y0 + (cy - 1) * F.cell, 1 / (T.w * F.cell), 1 / (T.h * F.cell)) };
      return r;
    }
    // One material a region and level (they share one program): the region's texture, the level's morph range.
    function materialFor(t) {
      var s = 1 << t.l, cx = Math.floor(t.tx * NODE * s / REGION) * REGION, cy = Math.floor(t.ty * NODE * s / REGION) * REGION, key = t.l + ':' + cx + ',' + cy, m = S.mats[key];
      if (m) return m;
      var reg = regionOf(cx, cy), r = range(P, t.l), top = t.l === LEVELS - 1;
      var u = { uBkShare: { value: reg.tex }, uBkRegion: { value: reg.v }, uBkMorph: { value: new THREE.Vector2(top ? 1e9 : M0 * r, top ? 0 : 1 / ((M1 - M0) * r)) }, uOpacityDither: S.uLevel };
      m = new THREE.MeshLambertMaterial({ color: COLOUR, emissive: EMISSIVE });      // seen from above only: from underneath it would be a ceiling
      m.onBeforeCompile = function (sh) {
        sh.uniforms.uBkShare = u.uBkShare; sh.uniforms.uBkRegion = u.uBkRegion; sh.uniforms.uBkMorph = u.uBkMorph; sh.uniforms.uOpacityDither = u.uOpacityDither;
        sh.vertexShader = VERT_HEAD + sh.vertexShader.replace('#include <beginnormal_vertex>', VERT_NORMAL).replace('#include <begin_vertex>', VERT_BEGIN);
        sh.fragmentShader = FRAG_HEAD + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + fragBody(pattern));
      };
      m.customProgramCacheKey = function () { return 'brush-blanket-' + pattern; };
      m.userData.blanket = u;
      return (S.mats[key] = m);
    }
    function meshOf(t) {
      var M = meshTile(P, groundZ, t.l, t.tx, t.ty);
      t.state = 1; t.tris = 0; S.built++;
      if (!M) return;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(M.pos, 3));
      g.setAttribute('zc', new THREE.BufferAttribute(M.zc, 1));
      g.setAttribute('normal', new THREE.BufferAttribute(M.nor, 3, true));
      g.setAttribute('nc', new THREE.BufferAttribute(M.nc, 3, true));
      g.setIndex(new THREE.BufferAttribute(M.idx, 1));
      var mesh = new THREE.Mesh(g, materialFor(t));
      mesh.name = 'brush-blanket'; mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.visible = false;
      mesh.raycast = function () {};                             // taps go through the brush
      t.mesh = mesh; t.tris = M.tris; t.box[2] = M.zmin - 0.5; t.box[5] = M.zmax + 0.5;
      group.add(mesh);
      S.meshed.push(t); S.meshedTris += M.tris;
    }
    function drop(t) {
      if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; S.meshedTris -= t.tris; }
      t.state = 0; t.tris = 0;
    }
    // Past the cache: the tiles drawn longest ago go (a tile's parents are stamped with it); never a root, never
    // one whose finer tiles are still meshed, never one drawn this frame.
    function trim() {
      if (S.meshed.length <= CACHE_TILES) return;
      S.meshed.sort(function (a, b) { return a.last - b.last; });
      var keep = [], n = S.meshed.length, i;
      for (i = 0; i < S.meshed.length; i++) {
        var t = S.meshed[i], busy = t.kids && t.kids.some(function (k) { return k.state; });
        if (n > CACHE_TILES && t.up && t.last < S.frame && !busy) { drop(t); n--; } else keep.push(t);
      }
      S.meshed = keep;
    }
    function update(camera, all) {
      if (S.gone) return;
      var cam = camera, e, i, k;
      cam.updateMatrixWorld();
      m4.copy(cam.matrixWorld).invert(); pv.multiplyMatrices(cam.projectionMatrix, m4);
      e = pv.elements;
      var same = !S.dirty;
      for (i = 0; i < 16 && same; i++) if (e[i] !== S.seen[i]) same = false;
      if (same) return;
      for (i = 0; i < 16; i++) S.seen[i] = e[i];
      frustum.setFromProjectionMatrix(pv);
      var inView = function (b) { box.min.set(b[0], b[1], b[2]); box.max.set(b[3], b[4], b[5]); return frustum.intersectsBox(box); };
      var p = [cam.matrixWorld.elements[12], cam.matrixWorld.elements[13], cam.matrixWorld.elements[14]], sel, built = 0;
      for (;;) {
        sel = fit(P, groundZ, S.roots, p, inView, S.budget);
        if (!sel.want.length) break;
        sel.want.sort(function (a, b) { return b.l - a.l || a.d - b.d; });      // coarse first (something to draw), then the nearest
        var t0 = Date.now(), did = 0;
        for (i = 0; i < sel.want.length; i++) { if (!sel.want[i].state) { meshOf(sel.want[i]); did++; built++; } if (!all && Date.now() - t0 >= S.buildMs) break; }
        if (!all || !did) break;
      }
      S.frame++;
      for (i = 0; i < S.drawn.length; i++) if (S.drawn[i].mesh) S.drawn[i].mesh.visible = false;
      for (i = 0; i < sel.draw.length; i++) { var t = sel.draw[i]; t.mesh.visible = true; for (k = t; k; k = k.up) k.last = S.frame; }
      S.drawn = sel.draw; S.minLevel = sel.minLevel; S.tris = sel.tris;
      S.dirty = sel.want.length > 0 && !all;
      if (built) trim();
      if (S.dirty) ctx.wake();                                   // more to mesh: one more frame, until the view is whole
    }

    return {
      group: group,
      update: function (camera) { update(camera, false); },
      settle: function () { S.dirty = true; update(ctx.camera, true); },
      setLevel: function (v) { S.uLevel.value = Math.max(0, Math.min(1, Number(v) || 0)); if (!S.gone) ctx.wake(); },
      dispose: function () {
        S.gone = true;
        S.meshed.forEach(function (t) { if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; } });
        Object.keys(S.mats).forEach(function (k) { S.mats[k].dispose(); });
        Object.keys(S.regions).forEach(function (k) { S.regions[k].tex.dispose(); });
        S.meshed = []; S.drawn = []; S.mats = {}; S.regions = {}; S.roots = [];
      },
      // { triangles drawn, tiles drawn, by level, the finest level in use, meshed tiles and triangles, textures, waiting }
      stats: function () {
        var by = []; for (var l = 0; l < LEVELS; l++) by.push(0);
        S.drawn.forEach(function (t) { by[t.l]++; });
        return { triangles: S.tris, tiles: S.drawn.length, levels: by, minLevel: S.minLevel, meshed: S.meshed.length, meshedTris: S.meshedTris, built: S.built, textures: Object.keys(S.regions).length,
                 materials: Object.keys(S.mats).length, cells: P.cells, roots: S.roots.length, waiting: S.dirty, level: S.uLevel.value, budget: S.budget, pattern: Object.keys(PATTERNS)[pattern] };
      },
      objects: function () { return { drawn: S.drawn, roots: S.roots, materials: S.mats, regions: S.regions, P: P }; },
    };
  }

  var R = {
    NODE: NODE, LEVELS: LEVELS, RANGE: RANGE, M0: M0, M1: M1, LIFT: LIFT, BIAS: BIAS, KMAX: KMAX, LOW_CM: LOW_CM, REGION: REGION, COLOUR: COLOUR, KNOTS: KNOTS, PATTERNS: PATTERNS,
    pattern: PATTERN,                                            // 'bayer4' | 'bayer8' | 'noise': read when the look is put on
    alphaLut: alphaLut, prep: prep, heightAt: heightAt, anyAt: anyAt, lattice: lattice, meshTile: meshTile, range: range, morph: morph, hasBrush: hasBrush,
    tile: tile, kidsOf: kidsOf, roots: roots, select: select, fit: fit, regionTexels: regionTexels, create: create,
  };
  root.FlexBrushLooks = root.FlexBrushLooks || {};
  root.FlexBrushLooks.blanket = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
