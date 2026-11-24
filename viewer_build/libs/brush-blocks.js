// The brush grid drawn as low blocks in the portable viewer / FLEX Field (window.FlexBrush).
//
// An export with ridgewalking carries BRUSH = { version, file, nx, ny, cell, x0, y0, band, classes }; `file` is
// brush.bin by name or as inline base64 (the viewer's own dual mode). Any other export has BRUSH = null and
// this file does nothing at all.
//
//   brush.bin  "FBR1", little-endian: uint32 nx, ny; float32 cell (m), x0, y0 (the west / south edge of the cell
//              [row 0, col 0], in the frame of trees.bin; row 0 is the south row), float32 top (the band's top, m),
//              uint32 spare; then uint8[ny * nx] share (0 = no brush, 1..255 = ceil(share * 255)) and
//              uint8[ny * nx] the brush's height in cm above the ground (0..250).
//
// Every brushy cell is a low block: its top is the ground plus the cell's height (in steps of HSTEP), in the
// colour of its class (light / medium / dense, BRUSH.classes: the bushwhack map's), with side walls down into
// the ground wherever the neighbour is lower or bare. The top follows the ground at the block's four corners
// (the viewer's height grid, never a ray), so on a slope a block is a slab lying on it, never a floating one.
//
// A real map has about a million brushy cells, far too many to draw as they are, so the grid is a quadtree of
// tiles, NODE x NODE blocks each, at four levels: a block is 1, 2, 4 or 8 cells wide. A coarse block stands for
// its cells (drawn when enough of them are brushy: an ordered threshold, so the covered share of the ground
// stays true at every level; its class and height are their means). Equal neighbours are merged into one
// rectangle (greedy, up to MAXSPAN blocks). Per view: tiles out of the frustum are skipped, a tile is replaced
// by its four finer ones when the camera is nearer than its block size x Q, and Q comes down until what is
// drawn fits BUDGET triangles. The coarsest level has tops only. Tiles are meshed the first time they are
// needed, a few milliseconds a frame (the coarser tile is drawn meanwhile), and the least recently drawn are
// dropped past CACHE triangles. update() is called by the viewer before a frame it draws anyway: with the
// camera still and nothing waiting it returns at once; nothing animates.
// Cells under a tree crown are left out while the trees are shown (UNDER_CROWNS; libs/trees.js hands the crowns over).
// Opacity is the ordered dither of libs/trees.js (its Brush chip and level drive this).
// Blocks are not part of the terrain: the height grid and taps do not see them.   Test: tools/test_brush_blocks.js
(function (root) {
  'use strict';

  var NODE = 64, LEVELS = 4;                                   // blocks a tile side; block = 1, 2, 4, 8 cells
  var HSTEP = 0.25;                                            // a block's height is a whole number of these (m)
  var SINK = 0.3;                                              // walls go this far under the ground (m)
  var MAXSPAN = [8, 4, 2, 2];                                  // equal neighbours merged up to this many blocks, by level
  var SIDES_TO = 2;                                            // levels 0..2 have walls; the coarsest has tops only
  var WALL_SHADE = 0.8;                                        // walls a little darker than tops
  var BUDGET = 600000, CACHE = 1500000;                        // triangles drawn at once; triangles kept meshed
  var QMAX = 200, QMIN = 6, QSTEP = 0.82;                      // a tile is refined nearer than block size x Q
  var BUILD_MS = 6;                                            // meshing time a frame
  // Brush cells under a tree's crown (trees.bin, cones and round crowns, while the Trees chip is on): the band
  // there is mostly the tree's own low branches, measured tall. false = such cells are not drawn; true = all are.
  var UNDER_CROWNS = false;
  var DEF_CLASSES = [{ name: 'light', min: 0.1, colour: 'b7e4a0' }, { name: 'medium', min: 0.3, colour: '5fae4f' }, { name: 'dense', min: 0.6, colour: '1f5f1f' }];

  function bayer2(x, y) { x &= 1; y &= 1; return (x * 2 + y * y * 3) & 3; }
  function bayer4(x, y) { return bayer2(x >> 1, y >> 1) + 4 * bayer2(x, y); }

  // { nx, ny, cell, x0, y0, top, share, height }: views over the bytes, nothing copied.
  function parse(buf) {
    if (!buf || buf.byteLength < 32) throw new Error('brush: file too short');
    var m = new Uint8Array(buf, 0, 4), dv = new DataView(buf);
    if (String.fromCharCode(m[0], m[1], m[2], m[3]) !== 'FBR1') throw new Error('brush: not an FBR1 file');
    var nx = dv.getUint32(4, true), ny = dv.getUint32(8, true), n = nx * ny;
    if (!nx || !ny || n > 4e8) throw new Error('brush: bad grid size');
    if (buf.byteLength < 32 + 2 * n) throw new Error('brush: file cut short');
    var cell = dv.getFloat32(12, true);
    if (!(cell > 0)) throw new Error('brush: bad cell size');
    return { nx: nx, ny: ny, cell: cell, x0: dv.getFloat32(16, true), y0: dv.getFloat32(20, true), top: dv.getFloat32(24, true),
             share: new Uint8Array(buf, 32, n), height: new Uint8Array(buf, 32 + n, n) };
  }
  // The file for a grid (tests, made-up maps): o = { nx, ny, cell, x0, y0, top, share: bytes, height: bytes }.
  function encode(o) {
    var n = o.nx * o.ny, buf = new ArrayBuffer(32 + 2 * n), dv = new DataView(buf), u = new Uint8Array(buf);
    u[0] = 70; u[1] = 66; u[2] = 82; u[3] = 49;
    dv.setUint32(4, o.nx, true); dv.setUint32(8, o.ny, true); dv.setFloat32(12, o.cell, true); dv.setFloat32(16, o.x0 || 0, true); dv.setFloat32(20, o.y0 || 0, true);
    dv.setFloat32(24, o.top == null ? 2.5 : o.top, true);
    u.set(o.share, 32); u.set(o.height, 32 + n);
    return buf;
  }
  // BRUSH.classes -> lightest first: [{ name, min, cut (the share byte it starts at), rgb }]. None given: the usual three.
  function classes(list) {
    var out = [];
    (Array.isArray(list) && list.length ? list : DEF_CLASSES).forEach(function (c) {
      var min = Number(c && c.min), hex = String(c && c.colour || '').replace(/^#/, '');
      if (!(min > 0 && min <= 1) || !/^[0-9a-fA-F]{6}$/.test(hex)) return;
      out.push({ name: String(c.name || ''), min: min, cut: Math.max(1, Math.ceil(min * 255 - 1e-9)), rgb: [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] });
    });
    if (!out.length) return classes(DEF_CLASSES);
    out.sort(function (a, b) { return a.min - b.min; });
    return out.slice(0, 250);
  }
  // Share byte -> class number (0 = not drawn, 1 = lightest …); height in cm -> steps of HSTEP (at least one).
  function luts(cls, bandLow) {
    var c = new Uint8Array(256), h = new Uint8Array(256), i, k, low = Math.round((bandLow > 0 ? bandLow : 0.3) * 100);
    for (i = 1; i < 256; i++) { for (k = cls.length; k > 0; k--) if (i >= cls[k - 1].cut) break; c[i] = k; }
    for (i = 0; i < 256; i++) h[i] = Math.max(1, Math.round((i || low) / (HSTEP * 100)));
    return { c: c, h: h };
  }
  // The coarser levels: lv[l] = { w, h, c, q } for l = 1..LEVELS-1 (class and height step a block; class 0 = not
  // drawn), plus `cells`, the number of brushy cells. A block of level l is drawn when its brushy cells, as a
  // share of the block, pass the ordered threshold of its place: (rank + 0.5) / 16.
  function pyramid(F, L, mask) {
    var nx = F.nx, ny = F.ny, lv = [null], l, i, j, cells = 0;
    var w = nx, h = ny, cnt = null, ss = null, hs = null;
    for (l = 1; l < LEVELS; l++) {
      var W = (w + 1) >> 1, H = (h + 1) >> 1, n = W * H, c2 = new Uint8Array(n), s2 = new Uint16Array(n), h2 = new Uint16Array(n);
      if (l === 1) {
        for (j = 0; j < ny; j++) { var r = j * nx, o = (j >> 1) * W; for (i = 0; i < nx; i++) { var sv = F.share[r + i]; if (L.c[sv] && !(mask && mask[(r + i) >> 3] & (1 << ((r + i) & 7)))) { var k = o + (i >> 1); c2[k]++; s2[k] += sv; h2[k] += F.height[r + i]; cells++; } } }
      } else {
        for (j = 0; j < h; j++) { var r1 = j * w, o1 = (j >> 1) * W; for (i = 0; i < w; i++) { var k1 = o1 + (i >> 1), a = r1 + i; c2[k1] += cnt[a]; s2[k1] += ss[a]; h2[k1] += hs[a]; } }
      }
      var full = 1 << (2 * l), C = new Uint8Array(n), Q = new Uint8Array(n);
      for (j = 0; j < H; j++) for (i = 0; i < W; i++) {
        var q = j * W + i, m = c2[q];
        if (!m || m * 16 <= (bayer4(i & 3, j & 3) + 0.5) * full) continue;
        C[q] = L.c[Math.max(1, Math.round(s2[q] / m))] || 1; Q[q] = L.h[Math.min(255, Math.round(h2[q] / m))];
      }
      lv[l] = { w: W, h: H, c: C, q: Q };
      cnt = c2; ss = s2; hs = h2; w = W; h = H;
    }
    lv.cells = cells; lv.top = cnt;                               // top: brushy cells per coarsest block
    return lv;
  }

  // Scratch for one tile (worst case: every block alone with four walls).
  var MAXV = NODE * NODE * 20, sPos = null, sCol = null, sNor = null, sIdx = null, sWc = null, sWq = null, sG = null, sSeen = null;
  function scratch() {
    if (sPos) return;
    sPos = new Float32Array(MAXV * 3); sCol = new Uint8Array(MAXV * 3); sNor = new Int8Array(MAXV * 3); sIdx = new Uint32Array(NODE * NODE * 30);
    sWc = new Uint8Array((NODE + 2) * (NODE + 2)); sWq = new Uint8Array((NODE + 2) * (NODE + 2)); sG = new Float32Array((NODE + 1) * (NODE + 1)); sSeen = new Uint8Array(NODE * NODE);
  }
  // One tile's mesh. D = { F, L (luts), lv (pyramid), cls, groundZ }; the tile is `n x m` blocks of level l from
  // block (bx, by) of that level's grid. Returns { pos, col, nor, idx, tris, rects, blocks, zmin, zmax } (typed
  // arrays cut to size) or null when it has nothing to draw.
  function meshTile(D, l, bx, by) {
    scratch();
    var F = D.F, W2 = NODE + 2, i, j, k;
    var gw = l ? D.lv[l].w : F.nx, gh = l ? D.lv[l].h : F.ny, n = Math.min(NODE, gw - bx), m = Math.min(NODE, gh - by);
    if (n <= 0 || m <= 0) return null;
    var any = 0;
    // the tile's blocks and a ring of neighbours round them
    for (j = -1; j <= m; j++) {
      var gj = by + j, row = (j + 1) * W2 + 1;
      for (i = -1; i <= n; i++) {
        var gi = bx + i, c = 0, q = 0;
        if (gi >= 0 && gj >= 0 && gi < gw && gj < gh) {
          if (l) { c = D.lv[l].c[gj * gw + gi]; q = D.lv[l].q[gj * gw + gi]; }
          else { var a = gj * gw + gi; c = D.mask && D.mask[a >> 3] & (1 << (a & 7)) ? 0 : D.L.c[F.share[a]]; q = c ? D.L.h[F.height[a]] : 0; }
        }
        sWc[row + i] = c; sWq[row + i] = c ? q : 0;
        if (c && i >= 0 && j >= 0 && i < n && j < m) any++;
      }
    }
    if (!any) return null;
    var size = F.cell * (1 << l), ox = F.x0 + bx * size, oy = F.y0 + by * size, G1 = NODE + 1, span = MAXSPAN[l], walls = l <= SIDES_TO;
    for (k = 0; k < G1 * G1; k++) sG[k] = Infinity;               // Infinity = not asked yet, NaN = no ground there
    var ground = function (ci, cj) {
      var g = sG[cj * G1 + ci];
      if (g === Infinity) { g = D.groundZ(ox + ci * size, oy + cj * size); g = g == null || !isFinite(g) ? NaN : g; sG[cj * G1 + ci] = g; }
      return g;
    };
    for (k = 0; k < n * m; k++) sSeen[k] = 0;
    var nv = 0, ni = 0, rects = 0, zmin = Infinity, zmax = -Infinity, cls = D.cls;
    var vert = function (x, y, z, r, g, b, nx, ny, nz) {
      var o = nv * 3;
      sPos[o] = x; sPos[o + 1] = y; sPos[o + 2] = z; sCol[o] = r; sCol[o + 1] = g; sCol[o + 2] = b; sNor[o] = nx; sNor[o + 1] = ny; sNor[o + 2] = nz;
      return nv++;
    };
    var quad = function (a) { sIdx[ni++] = a; sIdx[ni++] = a + 1; sIdx[ni++] = a + 2; sIdx[ni++] = a; sIdx[ni++] = a + 2; sIdx[ni++] = a + 3; };
    for (j = 0; j < m; j++) for (i = 0; i < n; i++) {
      if (sSeen[j * n + i]) continue;
      var w0 = (j + 1) * W2 + i + 1, c0 = sWc[w0];
      if (!c0) continue;
      var q0 = sWq[w0], rw = 1, rh = 1, e;
      while (rw < span && i + rw < n && !sSeen[j * n + i + rw] && sWc[w0 + rw] === c0 && sWq[w0 + rw] === q0) rw++;
      grow: while (rh < span && j + rh < m) {
        for (e = 0; e < rw; e++) { var w1 = w0 + rh * W2 + e; if (sSeen[(j + rh) * n + i + e] || sWc[w1] !== c0 || sWq[w1] !== q0) break grow; }
        rh++;
      }
      for (k = 0; k < rh; k++) for (e = 0; e < rw; e++) sSeen[(j + k) * n + i + e] = 1;
      var g00 = ground(i, j), g10 = ground(i + rw, j), g11 = ground(i + rw, j + rh), g01 = ground(i, j + rh);
      if (g00 !== g00 || g10 !== g10 || g11 !== g11 || g01 !== g01) continue;      // off the terrain
      var hgt = q0 * HSTEP, xa = ox + i * size, xb = ox + (i + rw) * size, ya = oy + j * size, yb = oy + (j + rh) * size;
      var rgb = cls[c0 - 1].rgb, R = rgb[0], Gc = rgb[1], B = rgb[2];
      var lo = Math.min(g00, g10, g11, g01) - SINK, hi = Math.max(g00, g10, g11, g01) + hgt;
      if (lo < zmin) zmin = lo; if (hi > zmax) zmax = hi;
      rects++;
      var t = vert(xa, ya, g00 + hgt, R, Gc, B, 0, 0, 127); vert(xb, ya, g10 + hgt, R, Gc, B, 0, 0, 127); vert(xb, yb, g11 + hgt, R, Gc, B, 0, 0, 127); vert(xa, yb, g01 + hgt, R, Gc, B, 0, 0, 127);
      quad(t);
      if (!walls) continue;
      // a wall on each side where some neighbour along it is bare or lower
      var show, r2 = Math.round(R * WALL_SHADE), g2 = Math.round(Gc * WALL_SHADE), b2 = Math.round(B * WALL_SHADE), s;
      for (show = false, e = 0; e < rw && !show; e++) { s = w0 - W2 + e; show = !sWc[s] || sWq[s] < q0; }                  // south
      if (show) { t = vert(xa, ya, g00 - SINK, r2, g2, b2, 0, -127, 0); vert(xb, ya, g10 - SINK, r2, g2, b2, 0, -127, 0); vert(xb, ya, g10 + hgt, r2, g2, b2, 0, -127, 0); vert(xa, ya, g00 + hgt, r2, g2, b2, 0, -127, 0); quad(t); }
      for (show = false, e = 0; e < rh && !show; e++) { s = w0 + e * W2 + rw; show = !sWc[s] || sWq[s] < q0; }             // east
      if (show) { t = vert(xb, ya, g10 - SINK, r2, g2, b2, 127, 0, 0); vert(xb, yb, g11 - SINK, r2, g2, b2, 127, 0, 0); vert(xb, yb, g11 + hgt, r2, g2, b2, 127, 0, 0); vert(xb, ya, g10 + hgt, r2, g2, b2, 127, 0, 0); quad(t); }
      for (show = false, e = 0; e < rw && !show; e++) { s = w0 + rh * W2 + e; show = !sWc[s] || sWq[s] < q0; }             // north
      if (show) { t = vert(xb, yb, g11 - SINK, r2, g2, b2, 0, 127, 0); vert(xa, yb, g01 - SINK, r2, g2, b2, 0, 127, 0); vert(xa, yb, g01 + hgt, r2, g2, b2, 0, 127, 0); vert(xb, yb, g11 + hgt, r2, g2, b2, 0, 127, 0); quad(t); }
      for (show = false, e = 0; e < rh && !show; e++) { s = w0 + e * W2 - 1; show = !sWc[s] || sWq[s] < q0; }              // west
      if (show) { t = vert(xa, yb, g01 - SINK, r2, g2, b2, -127, 0, 0); vert(xa, ya, g00 - SINK, r2, g2, b2, -127, 0, 0); vert(xa, ya, g00 + hgt, r2, g2, b2, -127, 0, 0); vert(xa, yb, g01 + hgt, r2, g2, b2, -127, 0, 0); quad(t); }
    }
    if (!ni) return null;
    return { pos: sPos.slice(0, nv * 3), col: sCol.slice(0, nv * 3), nor: sNor.slice(0, nv * 3), idx: nv > 65535 ? sIdx.slice(0, ni) : new Uint16Array(sIdx.subarray(0, ni)),
             tris: ni / 3, rects: rects, blocks: any, zmin: zmin, zmax: zmax };
  }

  // ── The tiles ───────────────────────────────────────────────────────────────
  // A tile: { l, bx, by, box [x0, y0, z0, x1, y1, z1], state (0 not meshed, 1 meshed), tris, mesh, kids, up, last }.
  function tile(D, l, bx, by, up) {
    var F = D.F, size = F.cell * (1 << l), gw = l ? D.lv[l].w : F.nx, gh = l ? D.lv[l].h : F.ny;
    var n = Math.min(NODE, gw - bx), m = Math.min(NODE, gh - by);
    var x0 = F.x0 + bx * size, y0 = F.y0 + by * size, x1 = F.x0 + (bx + n) * size, y1 = F.y0 + (by + m) * size, lo = Infinity, hi = -Infinity, i, j;
    // until it is meshed its heights are the ground's over a 9 x 9 lattice, with room for what lies between
    for (j = 0; j <= 8; j++) for (i = 0; i <= 8; i++) { var g = D.groundZ(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * j / 8); if (g != null && isFinite(g)) { if (g < lo) lo = g; if (g > hi) hi = g; } }
    if (lo > hi) { lo = hi = 0; }
    var pad = 3 + (hi - lo) * 0.15;
    return { l: l, bx: bx, by: by, up: up || null, state: 0, tris: 0, mesh: null, kids: null, last: 0, d: 0, box: [x0, y0, lo - pad, x1, y1, hi + pad] };
  }
  function kidsOf(D, t) {
    if (t.kids) return t.kids;
    var l = t.l - 1, gw = l ? D.lv[l].w : D.F.nx, gh = l ? D.lv[l].h : D.F.ny, out = [], a, b;
    for (b = 0; b < 2; b++) for (a = 0; a < 2; a++) {
      var bx = t.bx * 2 + a * NODE, by = t.by * 2 + b * NODE;
      if (bx < gw && by < gh) out.push(tile(D, l, bx, by, t));
    }
    return (t.kids = out);
  }
  // Which tiles to draw from camera place `cam` ([x, y, z]) with `inView(box)`; needs every tile it draws to be
  // meshed, and lists in `want` the finer ones it would rather draw. Pure: used by the test without a GPU.
  function select(D, roots, cam, inView, Q, want) {
    var draw = [];
    var dist = function (b) {
      var dx = cam[0] < b[0] ? b[0] - cam[0] : cam[0] > b[3] ? cam[0] - b[3] : 0, dy = cam[1] < b[1] ? b[1] - cam[1] : cam[1] > b[4] ? cam[1] - b[4] : 0, dz = cam[2] < b[2] ? b[2] - cam[2] : cam[2] > b[5] ? cam[2] - b[5] : 0;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    var visit = function (t) {
      if (!inView(t.box)) return;
      t.d = dist(t.box);
      if (t.l > 0 && t.d < D.F.cell * (1 << t.l) * Q) {
        var kids = kidsOf(D, t), ready = true, k;
        for (k = 0; k < kids.length; k++) if (!kids[k].state && inView(kids[k].box)) { ready = false; kids[k].d = dist(kids[k].box); if (want) want.push(kids[k]); }
        if (ready) { for (k = 0; k < kids.length; k++) visit(kids[k]); return; }
      }
      if (t.state && t.tris) draw.push(t);
    };
    for (var i = 0; i < roots.length; i++) visit(roots[i]);
    return draw;
  }
  // The selection that fits the budget: Q comes down from QMAX until the triangles fit. { draw, want, q, tris }.
  function fit(D, roots, cam, inView, budget) {
    var q = QMAX, want = [], draw, tris, i;
    for (;;) {
      want.length = 0;
      draw = select(D, roots, cam, inView, q, want);
      for (tris = 0, i = 0; i < draw.length; i++) tris += draw[i].tris;
      if (tris <= budget || q <= QMIN) break;
      q = Math.max(QMIN, q * QSTEP);
    }
    return { draw: draw, want: want, q: q, tris: tris };
  }

  // The cells whose centre lies under a crown: a bit a cell. crowns: [x, y, radius, …] in the grid's frame.
  function crownMask(F, crowns) {
    var mask = new Uint8Array((F.nx * F.ny + 7) >> 3), k, i, j, n = 0;
    for (k = 0; k + 2 < crowns.length; k += 3) {
      var cx = (crowns[k] - F.x0) / F.cell - 0.5, cy = (crowns[k + 1] - F.y0) / F.cell - 0.5, r = crowns[k + 2] / F.cell;
      if (!(r > 0)) continue;
      var j0 = Math.max(0, Math.ceil(cy - r)), j1 = Math.min(F.ny - 1, Math.floor(cy + r));
      for (j = j0; j <= j1; j++) {
        var w = Math.sqrt(r * r - (j - cy) * (j - cy)), i0 = Math.max(0, Math.ceil(cx - w)), i1 = Math.min(F.nx - 1, Math.floor(cx + w));
        for (i = i0; i <= i1; i++) { var a = j * F.nx + i; if (!(mask[a >> 3] & (1 << (a & 7)))) { mask[a >> 3] |= 1 << (a & 7); n++; } }
      }
    }
    mask.cells = n;
    return mask;
  }

  var S = null;      // everything of the running viewer; null = no brush blocks (every other export)

  // (Again) from the grid: the levels, the coarsest tiles meshed and kept (any view can be drawn from them).
  function start() {
    var D = S.D, i;
    for (i = 0; i < S.meshed.length; i++) if (S.meshed[i].mesh) { S.group.remove(S.meshed[i].mesh); S.meshed[i].mesh.geometry.dispose(); }
    S.meshed = []; S.meshedTris = 0; S.rects = 0; S.drawn = [];
    D.mask = S.crowns && !S.underCrowns ? crownMask(D.F, S.crowns) : null;
    D.lv = pyramid(D.F, D.L, D.mask);
    S.roots = R.roots(D).filter(function (t) { meshOf(t); return t.tris > 0 || R.cellsIn(D, t) > 0; });
    S.dirty = true;
  }

  function meshOf(t) {
    var THREE = S.THREE, M = meshTile(S.D, t.l, t.bx, t.by);
    t.state = 1; t.tris = 0;
    if (!M) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(M.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(M.col, 3, true));
    g.setAttribute('normal', new THREE.BufferAttribute(M.nor, 3, true));
    g.setIndex(new THREE.BufferAttribute(M.idx, 1));
    var mesh = new THREE.Mesh(g, S.mat);
    mesh.name = 'brush-blocks'; mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.visible = false;
    mesh.raycast = function () {};                               // taps go through the brush
    t.mesh = mesh; t.tris = M.tris; t.box[2] = M.zmin; t.box[5] = M.zmax;
    S.group.add(mesh);
    S.meshed.push(t); S.meshedTris += M.tris; S.rects += M.rects;
  }
  function drop(t) {
    if (t.mesh) { S.group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; S.meshedTris -= t.tris; }
    t.state = 0; t.tris = 0;
  }
  // Past CACHE: the tiles drawn longest ago go, finest first by their stamps (a tile's parents are stamped with
  // it); never a root, never one whose finer tiles are still meshed.
  function trim() {
    if (S.meshedTris <= S.cache) return;
    S.meshed.sort(function (a, b) { return a.last - b.last; });
    var keep = [], i;
    for (i = 0; i < S.meshed.length; i++) {
      var t = S.meshed[i], busy = t.kids && t.kids.some(function (k) { return k.state; });
      if (S.meshedTris > S.cache && t.up && t.last < S.frame && !busy) drop(t); else keep.push(t);
    }
    S.meshed = keep;
  }
  function redraw() { if (S && S.redraw) S.redraw(); }

  // The work before a frame. all = true meshes everything this view wants at once (tests, pictures).
  function update(all) {
    if (!S || !S.loaded || !S.on) return;
    var cam = S.camera, THREE = S.THREE, e, i, k;
    cam.updateMatrixWorld();
    S.m4.copy(cam.matrixWorld).invert(); S.pv.multiplyMatrices(cam.projectionMatrix, S.m4);
    e = S.pv.elements;
    var same = !S.dirty;
    for (i = 0; i < 16 && same; i++) if (e[i] !== S.seen[i]) same = false;
    if (same) return;
    for (i = 0; i < 16; i++) S.seen[i] = e[i];
    S.frustum.setFromProjectionMatrix(S.pv);
    var inView = function (b) { S.box.min.set(b[0], b[1], b[2]); S.box.max.set(b[3], b[4], b[5]); return S.frustum.intersectsBox(S.box); };
    var p = [cam.matrixWorld.elements[12], cam.matrixWorld.elements[13], cam.matrixWorld.elements[14]], sel, built = 0;
    for (;;) {
      sel = fit(S.D, S.roots, p, inView, S.budget);
      if (!sel.want.length) break;
      sel.want.sort(function (a, b) { return a.d - b.d; });
      var t0 = Date.now(), did = 0;
      for (i = 0; i < sel.want.length; i++) { if (!sel.want[i].state) { meshOf(sel.want[i]); did++; built++; } if (!all && Date.now() - t0 >= BUILD_MS) break; }
      if (!all || !did) break;
    }
    S.frame++;
    for (i = 0; i < S.drawn.length; i++) S.drawn[i].mesh && (S.drawn[i].mesh.visible = false);
    for (i = 0; i < sel.draw.length; i++) { var t = sel.draw[i]; t.mesh.visible = true; for (k = t; k; k = k.up) k.last = S.frame; }
    S.drawn = sel.draw; S.q = sel.q; S.tris = sel.tris;
    S.dirty = sel.want.length > 0 && !all;
    if (built) trim();
    if (S.dirty) redraw();                                       // more to mesh: one more frame, until the view is whole
  }

  var R = {
    NODE: NODE, LEVELS: LEVELS, HSTEP: HSTEP, SINK: SINK, MAXSPAN: MAXSPAN, SIDES_TO: SIDES_TO, BUDGET: BUDGET, QMAX: QMAX, QMIN: QMIN, DEF_CLASSES: DEF_CLASSES,
    UNDER_CROWNS: UNDER_CROWNS, parse: parse, encode: encode, classes: classes, luts: luts, pyramid: pyramid, crownMask: crownMask, meshTile: meshTile, tile: tile, kidsOf: kidsOf, select: select, fit: fit, bayer4: bayer4,
    // The roots (coarsest tiles) of a grid: D = { F, L, lv, cls, groundZ }.
    roots: function (D) {
      var l = LEVELS - 1, out = [], bx, by;
      for (by = 0; by < D.lv[l].h; by += NODE) for (bx = 0; bx < D.lv[l].w; bx += NODE) out.push(tile(D, l, bx, by, null));
      return out;
    },
    // Everything pure of a file: { F, L, lv, cls, groundZ }.
    data: function (buf, brush, groundZ) {
      var F = parse(buf), cls = classes(brush && brush.classes), L = luts(cls, brush && brush.band && brush.band[0]);
      return { F: F, cls: cls, L: L, lv: pyramid(F, L), groundZ: groundZ };
    },

    // o: { THREE, scene, camera, brush, isAssetRef, b64ToArrayBuffer, groundZ(x, y), dither(material, uniform), redraw }.
    // Returns a promise that settles when the blocks are in the scene (null brush: at once, false).
    init: function (o) {
      S = null;
      var br = o && o.brush;
      if (!br || typeof br !== 'object' || !br.file) return Promise.resolve(false);
      var THREE = o.THREE;
      S = { THREE: THREE, scene: o.scene, camera: o.camera, brush: br, redraw: o.redraw, on: true, uOp: { value: 1 }, loaded: false, D: null, roots: [], group: null, mat: null,
            crowns: null, underCrowns: UNDER_CROWNS, drawn: [], meshed: [], meshedTris: 0, rects: 0, budget: BUDGET, cache: CACHE, frame: 0, dirty: true, q: QMAX, tris: 0, seen: new Float64Array(16),
            m4: new THREE.Matrix4(), pv: new THREE.Matrix4(), frustum: new THREE.Frustum(), box: new THREE.Box3(), ready: null };
      var mine = S, load;
      try {
        load = o.isAssetRef(br.file)
          ? fetch(br.file).then(function (r) { if (!r.ok) throw new Error('brush fetch: HTTP ' + r.status); return r.arrayBuffer(); })
          : Promise.resolve(o.b64ToArrayBuffer(br.file));
      } catch (e) { load = Promise.reject(e); }
      S.ready = load.then(function (buf) {
        if (S !== mine) return false;
        S.D = R.data(buf, br, o.groundZ);
        S.mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
        if (o.dither) o.dither(S.mat, S.uOp);
        S.group = new THREE.Group(); S.group.name = 'brush'; S.group.matrixAutoUpdate = false; S.group.visible = S.on;
        start();
        S.scene.add(S.group);
        S.loaded = true; redraw();
        return true;
      }).catch(function (e) { console.warn('Brush blocks not loaded:', e); if (S === mine) S = null; return false; });
      return S.ready;
    },
    // Brushy cells under a coarsest tile (a tile whose blocks all fell under the threshold still has finer ones to draw).
    cellsIn: function (D, t) {
      var top = D.lv.top, w = D.lv[LEVELS - 1].w, h = D.lv[LEVELS - 1].h, n = 0, i, j;
      for (j = t.by; j < Math.min(h, t.by + NODE); j++) for (i = t.bx; i < Math.min(w, t.bx + NODE); i++) n += top[j * w + i];
      return n;
    },
    active: function () { return !!S; },
    loaded: function () { return !!(S && S.loaded); },
    whenReady: function () { return S && S.ready ? S.ready : Promise.resolve(false); },
    // The Brush chip and its level (libs/trees.js): { on, opacity 0..1 }.
    set: function (v) {
      if (!S || !v) return;
      if (typeof v.on === 'boolean') { S.on = v.on; if (S.group) S.group.visible = v.on; if (v.on) S.dirty = true; }
      if (typeof v.opacity === 'number' && isFinite(v.opacity)) S.uOp.value = Math.max(0, Math.min(1, v.opacity));
      redraw();
    },
    // The tree crowns over the grid ([x, y, radius, …]; null = none, the trees are off): their cells are left out
    // (see UNDER_CROWNS). The levels and tiles are made again: a tenth of a second or so, on a switch only.
    crowns: function (list) {
      if (!S) return;
      S.crowns = list && list.length ? list : null;
      if (S.loaded && !S.underCrowns) { start(); redraw(); }
    },
    // For comparing the two looks: true draws the cells under crowns too.
    underCrowns: function (v) { if (S && S.underCrowns !== !!v) { S.underCrowns = !!v; if (S.loaded) { start(); redraw(); } } },
    budget: function (n, cache) { if (S) { if (n > 0) S.budget = n; if (cache > 0) S.cache = cache; S.dirty = true; } return S ? S.budget : BUDGET; },
    update: function () { update(false); },
    settle: function () { if (S) S.dirty = true; update(true); },
    // { on, opacity, cells, tiles drawn, triangles drawn, by level, q, meshed tiles and triangles }
    stats: function () {
      if (!S || !S.loaded) return null;
      var by = [0, 0, 0, 0]; S.drawn.forEach(function (t) { by[t.l]++; });
      return { on: S.on, opacity: S.uOp.value, cells: S.D.lv.cells, underCrowns: S.D.mask ? S.D.mask.cells : 0, nx: S.D.F.nx, ny: S.D.F.ny, drawn: S.drawn.length, tris: S.tris, levels: by, q: S.q, meshed: S.meshed.length, meshedTris: S.meshedTris,
               roots: S.roots.length, waiting: S.dirty, budget: S.budget };
    },
    objects: function () { return S && S.loaded ? { group: S.group, material: S.mat, drawn: S.drawn, roots: S.roots, classes: S.D.cls } : null; },
  };

  root.FlexBrush = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
