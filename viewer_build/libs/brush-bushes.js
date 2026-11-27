// The brush grid drawn as small rounded bushes in the portable viewer / FLEX Field: one of the looks of the
// brush (window.FlexBrushLooks.bushes; the hub in libs/brush-blocks.js picks the look and hands it a context).
//
//   FlexBrushLooks.bushes.create(ctx) -> look
//   ctx  = { THREE, grid: { nx, ny, cell, x0, y0, top, share, height } (brush.bin FBR1 as FlexBrush.parse gives
//            it: row 0 is the south row), classes (BRUSH.classes or FlexBrush.classes' list: only `min` is read),
//            groundZ(x, y) (the viewer's height grid, never a ray; null off the terrain), camera, wake() (asks for
//            one more frame), budget { triangles, cache, buildMs } }: the hub's context (the scene's own frame:
//            x east, y north, z up)
//   look = { group, update(camera) (before each drawn frame: returns at once when the camera has not moved and
//            nothing waits), setLevel(0..1) (the Brush chip's level), dispose(), stats(), settle() (builds all
//            this view wants at once: pictures, tests), setClasses([bool a class]) (the Light / Medium / Dense
//            chips: the cells of a class that is off have no bush and are in no clump; ctx.classesOn is the same
//            at create) }
//
// Every brushy cell (share at or over the lightest class's `min`) is a bush: a stock low-poly dome (SIDES
// sides, RINGS, a blunt top; smooth normals, vertex-lit as the trees' mounds are), as tall as the cell's
// measured height and a little wider than the cell, so thick brush closes into cover. Where the four cells of a
// 2 x 2 block (even rows and columns) are all brush of about one height and one density, they are ONE wider
// bush. A hash of the cell's number gives each bush its place inside the cell, its width (+-15 %), its turn, a
// slight oval and its tint, so the 0.9 m grid does not show and every build of a tile is the same.
// Density is OPACITY in one family of greens: the share runs through the classes' starts (the lightest class
// starts faint, the densest is solid, straight lines between), times the chip's level, times the distance fade.
// No blending: the ordered 4 x 4 dither of libs/trees.js, here with the opacity of each bush.
// Distance: the whole map has brush at any distance. Bushes are drawn to `far` (FAR_MAX); farther, the brush is
// CLUMPS: level k (1 .. LEVELS) lumps each patch of 2^k x 2^k cells into one low wide solid (C_TRIS triangles) at
// the density-weighted centre of the patch's brushy cells, as wide as their AREA asks (so the ground covered stays
// true), as tall as they are, as opaque as they are dense, in the bushes' greens. A patch with little brush has a
// clump only now and then (an ordered threshold). Level k starts at far x START[k - 1] from the eye; where two levels
// meet BOTH are drawn over a band of distance, one fading out as the other fades in, per instance in the shader
// and with the dither turned over on every other level, so the pixels drawn stay the same in number: no ring, no
// pop. The sums the clumps are made from are a small pyramid of typed arrays (level PYR up; finer patches are
// summed from the cells), filled over the first frames.
// Budget: BUDGET triangles are drawn at most. A view that holds more first brings the clump levels in sooner
// and shortens the bushes' reach, a step at a time (STEPS); the bushes nearest the eye are never left out.
// A bush in a tile farther than LIGHT_FROM is drawn as the same dome with fewer faces (C_TRIS triangles); in a tile
// farther than FAR_FROM as a simpler one still (FAR_TRIS triangles: three sides, the rings half a side apart, so its
// outline from above is six-sided and from the side the same low dome). That simpler far bush is always on: it
// was a switch in More once, and a choice saved by that build is ignored.
// The reach and the budget are the hub's to set (ctx.budget.far / .triangles, limits()): FlexBrush.detail(name).
// Every ring and every hand-over is a multiple of the reach, so a longer reach moves the whole chain out.
// A bush stands on the ground at its own centre and its base is sheared to the ground's slope there (the top
// stays straight above the centre), sunk SINK; on ground steeper than SLOPE_MAX it is sunk more instead (half its
// height at most). Bushes within NEAR of the eye fade out as well: standing in brush, the screen is not one bush.
// The grid is cut into tiles of TILE x TILE cells, each one instanced mesh (THREE.InstancedMesh, r128), made
// the first time a view wants it (BUILD_MS a frame, nearest first), kept until CACHE bushes are held, then the
// ones drawn longest ago go; the clumps the same way, TILE_C x TILE_C patches a tile. Nothing animates. Bushes are not part of the terrain: taps go through them.
// Test: tools/test_brush_bushes.js
(function (root) {
  'use strict';

  var TILE = 32;                                               // cells a tile side
  var SIDES = 5, RINGS = [[0.72, 0], [1, 0.36], [0.7, 0.78]], TOP = 1;        // the dome: [radius, height] rings, closed by a point at TOP
  var TRIS = SIDES * (2 * (RINGS.length - 1) + 1);             // triangles a bush
  var BUDGET = 900000;                                         // triangles drawn at once (bushes and clumps)
  var FAR_MAX = 180, FADE = 0.3;                               // bushes are drawn to `far` (m) at most; over the last FADE of it they hand over to the clumps
  var CACHE = 120000;                                          // bushes and clumps kept built (80 bytes each), when the hub gives no cache
  var BUILD_MS = 6;                                            // building time a frame
  // Clumps (see "Clumps" below): levels 1 .. LEVELS, a patch of level k is 2^k x 2^k cells
  var LEVELS = 6, PYR = 3;                                     // the coarsest level; the patches' sums are kept from level PYR up
  var TILE_C = 32, TILE_CELLS = 256;                           // patches a clump tile side, and cells at most (the coarse levels have smaller tiles: tileC)
  var C_SIDES = 5, C_RINGS = [[1, 0], [0.74, 0.58]], C_TRIS = C_SIDES * (2 * (C_RINGS.length - 1) + 1);        // the clump's solid
  var CMIN = 0.2;                                              // a patch less brushy than this has a clump only now and then (an ordered threshold), as large as this share's
  var AREA = 2.4;                                              // a clump covers this many times its brushy cells' ground (as bushes are wider than their cells)
  var C_SHADE = 0.9;                                           // a clump's colour beside a bush's (bushes shade each other; clumps have no sides to speak of)
  var C_JITTER = 0.4, C_SIZE_VAR = 0.2, C_OVAL = 0.2;        // a clump's place (of its patch), +- size, oval
  var START = [1, 1.5, 2.5, 5, 12, 40];                        // level k is whole from `far` x START[k - 1] on (m from the eye): a patch is 6 to 15 pixels there
  // The steps of the budget, finest first: [grow, near]: level k is whole from FAR_MAX x near x START[k - 1]^grow on.
  // Step by step the clump levels come in sooner (grow falls from 1 to 0.3) and, after the first few steps, the
  // bushes' own reach shrinks too (near, down to 0.22); the last steps are for budgets far under the usual one
  // (near down to 0.08: a dozen metres of bushes round the eye).
  var STEPS = (function () { var out = [], i, N = 32; for (i = 0; i <= N; i++) { var q = i / N, m = Math.max(0, (q - 0.1) / 0.9); out.push([1 - 0.7 * Math.min(1, q * 1.5), 1 - 0.78 * Math.pow(m, 1.2)]); }
    for (i = 1; i <= 6; i++) out.push([0.3, 0.22 - 0.023 * i]); return out; })();
  // A bush's radius in cells: one cell [low brush, tall brush]; a 2 x 2 block. Between LOW_H and TALL_H (m) of
  // height it grows from the first to the second, so tall brush is a shrub and not a post.
  var WIDTH = [0.72, 0.98], WIDTH2 = [1.3, 1.45], LOW_H = 0.8, TALL_H = 2.2;
  var SIZE_VAR = 0.15, OVAL = 0.1, JITTER = 0.28, JITTER2 = 0.3;      // +- width; oval; place inside the cell (cells)
  var TINT_LO = 0.86, TINT_HI = 1.14;
  var MERGE_DH = 60, MERGE_DO = 0.5;                           // a 2 x 2 block is one bush when heights are within this (cm) and opacities within this
  var SINK = 0.12, SLOPE_MAX = 1.0, SINK_MAX = 0.5;            // base under the ground (m); the base follows slopes up to this rise / run; steeper: sunk more, to this share of the height at most
  var LIGHT_FROM = 60, LIGHT_RINGS = [[0.86, 0], [1, 0.42]];      // a bush in a tile farther than this (m) is the dome with fewer faces (C_TRIS triangles, the same outline)
  var FAR_FROM = 150, FAR_SIDES = 3, FAR_RINGS = [[0.9, 0], [1.06, 0.5]], FAR_TRIS = FAR_SIDES * (2 * (FAR_RINGS.length - 1) + 1);      // ... and farther than this (m) a simpler one still (FAR_TRIS triangles)
  var NEAR = [3, 9];                                           // bushes this near the eye fade out too (m: gone .. whole), so standing in brush does not fill the screen
  var LOW = 0.3;                                               // height of a cell whose height byte is 0 (m)
  var COLOUR_LIGHT = [0x86, 0x94, 0x58], COLOUR_DENSE = [0x3e, 0x62, 0x30];     // faint brush .. solid brush

  // A whole-number hash (32 bits) of a cell's number and a salt: the same on every device.
  function hash(i, salt) {
    var h = (i ^ Math.imul((salt | 0) + 1, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }
  function unit(i, salt) { return hash(i, salt) / 4294967296; }                  // 0 .. 1 (never 1)
  // What makes bush `i` its own: { dx, dy (of a cell, -1 .. 1 times the jitter), size, oval, turn, tint }.
  function vary(i, merged) {
    var j = merged ? JITTER2 : JITTER;
    return { dx: (unit(i, 1) * 2 - 1) * j, dy: (unit(i, 2) * 2 - 1) * j, size: 1 + (unit(i, 3) * 2 - 1) * SIZE_VAR, oval: (unit(i, 4) * 2 - 1) * OVAL,
             turn: unit(i, 5) * 2 * Math.PI, tint: TINT_LO + (TINT_HI - TINT_LO) * unit(i, 6) };
  }
  // The classes' starts, lightest first, each with the opacity a cell has there: [{ min, op }].
  function knots(classes) {
    var out = [];
    (Array.isArray(classes) ? classes : []).forEach(function (c) { var m = Number(c && c.min); if (m > 0 && m <= 1) out.push(m); });
    if (!out.length) out = [0.1, 0.3, 0.6];
    out.sort(function (a, b) { return a - b; });
    return out.map(function (m, k) { return { min: m, op: Math.pow((k + 1) / out.length, 1.5) }; });       // three classes: 0.19, 0.54, 1
  }
  // Opacity (0..1) of a share (0..1): nothing under the lightest class, solid from the densest on.
  function opacityOf(share, K) {
    if (!(share >= K[0].min)) return 0;
    for (var k = K.length - 1; k > 0; k--) if (share >= K[k].min) break;
    if (k === K.length - 1) return 1;
    return K[k].op + (K[k + 1].op - K[k].op) * (share - K[k].min) / (K[k + 1].min - K[k].min);
  }
  // By share byte (1..255 = ceil(share * 255)): opacity in 0..255, 0 = no bush.
  function lut(K) {
    var L = new Uint8Array(256), cut = Math.max(1, Math.ceil(K[0].min * 255 - 1e-9)), i;
    for (i = cut; i < 256; i++) L[i] = Math.max(1, Math.round(opacityOf(Math.max(i / 255, K[0].min), K) * 255));
    return L;
  }
  // The opacity bytes with the classes that are off taken out (K[k] is class k, lightest first; on: [bool a class]).
  function mask(L, K, on) {
    if (!Array.isArray(on)) return L;
    var out = new Uint8Array(256), i, k;
    for (i = 1; i < 256; i++) { for (k = K.length; k > 0; k--) if (i >= Math.max(1, Math.ceil(K[k - 1].min * 255 - 1e-9))) break; out[i] = k && on[k - 1] !== false ? L[i] : 0; }
    return out;
  }
  // The distance fade: 1 up to (1 - FADE) * far, 0 from far on; and 0 at NEAR[0] from the eye, whole from NEAR[1]
  // (the shader computes the same).
  function fade(d, far) {
    var a = far * (1 - FADE), t = (d - a) / (far - a), u = (d - NEAR[0]) / (NEAR[1] - NEAR[0]);
    t = t < 0 ? 0 : t > 1 ? 1 : t; u = u < 0 ? 0 : u > 1 ? 1 : u;
    return (1 - t * t * (3 - 2 * t)) * u * u * (3 - 2 * u);
  }
  function widthOf(W, h) { var t = (h - LOW_H) / (TALL_H - LOW_H); return W[0] + (W[1] - W[0]) * (t < 0 ? 0 : t > 1 ? 1 : t); }
  // The bushes of the tile from cell (cx, cy): calls put(cell number, merged) for each, a 2 x 2 block by its
  // south-west cell. Returns their count.
  function plan(F, L, cx, cy, put) {
    var nx = F.nx, ny = F.ny, x1 = Math.min(nx, cx + TILE), y1 = Math.min(ny, cy + TILE), n = 0, i, j;
    for (j = cy; j < y1; j++) for (i = cx; i < x1; i++) {
      var a = j * nx + i, o = L[F.share[a]];
      if (!(i & 1) && !(j & 1)) { if (merges(F, L, i, j)) { if (put) put(a, true); n++; continue; } }
      else if (merges(F, L, i & ~1, j & ~1)) continue;           // inside a block that is one bush
      if (o) { if (put) put(a, false); n++; }
    }
    return n;
  }
  // Is the 2 x 2 block from the even cell (i, j) one bush?
  function merges(F, L, i, j) {
    if (i + 1 >= F.nx || j + 1 >= F.ny) return false;
    var a = j * F.nx + i, b = a + F.nx, S = F.share, H = F.height;
    var o0 = L[S[a]], o1 = L[S[a + 1]], o2 = L[S[b]], o3 = L[S[b + 1]];
    if (!o0 || !o1 || !o2 || !o3) return false;
    if (Math.max(o0, o1, o2, o3) - Math.min(o0, o1, o2, o3) > MERGE_DO * 255) return false;
    var h0 = H[a], h1 = H[a + 1], h2 = H[b], h3 = H[b + 1];
    return Math.max(h0, h1, h2, h3) - Math.min(h0, h1, h2, h3) <= MERGE_DH;
  }
  // One tile's bushes as instance buffers: { n, mat (16 floats each, column-major), col (3), op (1), zmin, zmax },
  // or null when the tile has none. D = { F, L, groundZ, low }.
  function buildTile(D, cx, cy) {
    var F = D.F, L = D.L, cell = F.cell, nx = F.nx, S = F.share, H = F.height, low = D.low > 0 ? D.low : LOW;
    var cap = plan(F, L, cx, cy, null);
    if (!cap) return null;
    var mat = new Float32Array(cap * 16), col = new Float32Array(cap * 3), op = new Float32Array(cap), n = 0, zmin = Infinity, zmax = -Infinity;
    var gz = function (x, y) { var g = D.groundZ(x, y); return g == null || !isFinite(g) ? NaN : g; };
    plan(F, L, cx, cy, function (a, merged) {
      var i = a % nx, j = (a - i) / nx, v = vary(a, merged), o, h, r, x, y;
      if (merged) {
        var b = a + nx;
        o = (L[S[a]] + L[S[a + 1]] + L[S[b]] + L[S[b + 1]]) / 1020;
        h = ((H[a] || low * 100) + (H[a + 1] || low * 100) + (H[b] || low * 100) + (H[b + 1] || low * 100)) / 400;
        r = cell * widthOf(WIDTH2, h) * v.size; x = F.x0 + (i + 1 + v.dx) * cell; y = F.y0 + (j + 1 + v.dy) * cell;
      } else {
        o = L[S[a]] / 255; h = (H[a] || low * 100) / 100;
        r = cell * widthOf(WIDTH, h) * v.size; x = F.x0 + (i + 0.5 + v.dx) * cell; y = F.y0 + (j + 0.5 + v.dy) * cell;
      }
      var g = gz(x, y);
      if (g !== g) return;                                       // off the terrain
      // the ground's slope under the bush, from the height grid round its centre
      var e = Math.max(r, cell * 0.5), gE = gz(x + e, y), gW = gz(x - e, y), gN = gz(x, y + e), gS = gz(x, y - e);
      var sx = ((gE === gE ? gE : g) - (gW === gW ? gW : g)) / (2 * e), sy = ((gN === gN ? gN : g) - (gS === gS ? gS : g)) / (2 * e);
      var sl = Math.sqrt(sx * sx + sy * sy), sink = SINK;
      if (sl > SLOPE_MAX) { sink += Math.min(r * (sl - SLOPE_MAX), h * SINK_MAX); sx *= SLOPE_MAX / sl; sy *= SLOPE_MAX / sl; }
      var rx = r * (1 + v.oval), ry = r * (1 - v.oval), ca = Math.cos(v.turn), sa = Math.sin(v.turn), m = n * 16;
      // column-major: the dome's (u, v, w) -> x + X, y + Y, (ground - sink) + slope . (X, Y) + (h + sink) w
      mat[m] = rx * ca; mat[m + 1] = rx * sa; mat[m + 2] = rx * (sx * ca + sy * sa);
      mat[m + 4] = -ry * sa; mat[m + 5] = ry * ca; mat[m + 6] = ry * (-sx * sa + sy * ca);
      mat[m + 10] = h + sink;
      mat[m + 12] = x; mat[m + 13] = y; mat[m + 14] = g - sink; mat[m + 15] = 1;
      var t = v.tint / 255, k = o * o * (3 - 2 * o);
      col[n * 3] = (COLOUR_LIGHT[0] + (COLOUR_DENSE[0] - COLOUR_LIGHT[0]) * k) * t;
      col[n * 3 + 1] = (COLOUR_LIGHT[1] + (COLOUR_DENSE[1] - COLOUR_LIGHT[1]) * k) * t;
      col[n * 3 + 2] = (COLOUR_LIGHT[2] + (COLOUR_DENSE[2] - COLOUR_LIGHT[2]) * k) * t;
      op[n] = o;
      var reach = r * 1.15 * Math.min(sl, SLOPE_MAX);
      if (g - sink - reach < zmin) zmin = g - sink - reach; if (g + h + reach > zmax) zmax = g + h + reach;
      n++;
    });
    if (!n) return null;
    return { n: n, mat: n === cap ? mat : mat.slice(0, n * 16), col: n === cap ? col : col.slice(0, n * 3), op: n === cap ? op : op.slice(0, n), zmin: zmin, zmax: zmax };
  }
  // The tiles of a grid that have brush: [{ k (0), cx, cy, cells, n (bushes once built, else the cells: never fewer),
  // box [x0, y0, z0, x1, y1, z1] (z once asked), state (0 not built, 1 built, 2 built and empty), d, last }], and
  // { tx, ty, at[] (tile by its place, null = no brush) }.
  function tiles(F, L) {
    var tx = Math.ceil(F.nx / TILE), ty = Math.ceil(F.ny / TILE), cnt = new Uint32Array(tx * ty), i, j, cells = 0;
    for (j = 0; j < F.ny; j++) { var r = j * F.nx, o = ((j / TILE) | 0) * tx; for (i = 0; i < F.nx; i++) if (L[F.share[r + i]]) { cnt[o + ((i / TILE) | 0)]++; cells++; } }
    var list = [], at = new Array(tx * ty), pad = F.cell * (WIDTH2[1] * (1 + SIZE_VAR) + JITTER2);
    for (j = 0; j < ty; j++) for (i = 0; i < tx; i++) {
      var c = cnt[j * tx + i], t = null;
      if (c) {
        t = { k: 0, cx: i * TILE, cy: j * TILE, cells: c, n: c, state: 0, d: 0, f: 0, last: 0, mesh: null, z: false,
              box: [F.x0 + i * TILE * F.cell - pad, F.y0 + j * TILE * F.cell - pad, 0, F.x0 + Math.min(F.nx, (i + 1) * TILE) * F.cell + pad, F.y0 + Math.min(F.ny, (j + 1) * TILE) * F.cell + pad, 0] };
        list.push(t);
      }
      at[j * tx + i] = t;
    }
    return { list: list, at: at, tx: tx, ty: ty, cells: cells, size: TILE * F.cell };
  }
  // A tile's heights before it is built: the ground over a lattice, with room for what lies between.
  function tileZ(D, t) {
    if (t.z) return;
    var b = t.box, lo = Infinity, hi = -Infinity, i, j, m = t.k ? 8 : 4;
    for (j = 0; j <= m; j++) for (i = 0; i <= m; i++) { var g = D.groundZ(b[0] + (b[3] - b[0]) * i / m, b[1] + (b[4] - b[1]) * j / m); if (g != null && isFinite(g)) { if (g < lo) lo = g; if (g > hi) hi = g; } }
    if (lo > hi) { lo = hi = 0; }
    var pad = 3 + (hi - lo) * (t.k ? 0.5 : 0.3);
    b[2] = lo - pad; b[5] = hi + pad; t.z = true;
  }
  function distTo(b, c) {
    var dx = c[0] < b[0] ? b[0] - c[0] : c[0] > b[3] ? c[0] - b[3] : 0, dy = c[1] < b[1] ? b[1] - c[1] : c[1] > b[4] ? c[1] - b[4] : 0, dz = c[2] < b[2] ? b[2] - c[2] : c[2] > b[5] ? c[2] - b[5] : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  function distFar(b, c) {
    var dx = Math.max(Math.abs(c[0] - b[0]), Math.abs(c[0] - b[3])), dy = Math.max(Math.abs(c[1] - b[1]), Math.abs(c[1] - b[4])), dz = Math.max(Math.abs(c[2] - b[2]), Math.abs(c[2] - b[5]));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // ── Clumps: the brush farther than the bushes reach ────────────────────────────────────────────────────────────
  // Level k (1 .. LEVELS) cuts the grid into patches of 2^k x 2^k cells; a patch's brushy cells are ONE clump.
  function tileC(k) { return Math.max(1, Math.min(TILE_C, TILE_CELLS >> k)); }                  // patches a tile side at level k
  function bayer2(x, y) { x &= 1; y &= 1; return (x * 2 + y * y * 3) & 3; }
  function bayer4(x, y) { return bayer2(x >> 1, y >> 1) + 4 * bayer2(x, y); }                  // (the rank of libs/trees.js)
  // The sums of the patches from level PYR up, whole numbers in typed arrays: per patch n (brushy cells), w (their
  // opacity bytes), h and h2 (their heights in cm, and squared), x and y (opacity x the cell's column / row inside
  // the patch). Filled from the cells by pyramidStep, a slice of rows at a time; the coarser levels are their four
  // children added up. The patches under level PYR are summed from their few cells when a tile is made.
  function pyramid(F, L, low) {
    var lv = [], k;
    for (k = PYR; k <= LEVELS; k++) {
      var s = 1 << k, px = Math.ceil(F.nx / s), py = Math.ceil(F.ny / s), n = px * py;
      lv[k] = { k: k, s: s, px: px, py: py, n: new Uint16Array(n), w: new Uint32Array(n), h: new Uint32Array(n), h2: new Uint32Array(n), x: new Uint32Array(n), y: new Uint32Array(n) };
    }
    return { F: F, L: L, low: Math.round((low > 0 ? low : LOW) * 100), lv: lv, row: 0, ready: false };
  }
  // Goes on for `ms` milliseconds (all of it when ms is not a number); true once the pyramid is whole.
  function pyramidStep(P, ms) {
    if (P.ready) return true;
    var F = P.F, L = P.L, S = F.share, H = F.height, nx = F.nx, ny = F.ny, b = P.lv[PYR], s = b.s, m = s - 1, low = P.low, t0 = Date.now(), timed = typeof ms === 'number';
    var N = b.n, W = b.w, HH = b.h, H2 = b.h2, X = b.x, Y = b.y, i, j, k;
    while (P.row < b.py) {
      var pj1 = Math.min(b.py, P.row + 8);
      for (var pj = P.row; pj < pj1; pj++) {
        var j0 = pj * s, j1 = Math.min(ny, j0 + s), q0 = pj * b.px;
        for (j = j0; j < j1; j++) {
          var r = j * nx, dy = j - j0;
          for (i = 0; i < nx; i++) {
            var o = L[S[r + i]];
            if (!o) continue;
            var q = q0 + (i >> PYR), hc = H[r + i] || low;
            N[q]++; W[q] += o; HH[q] += hc; H2[q] += hc * hc; X[q] += o * (i & m); Y[q] += o * dy;
          }
        }
      }
      P.row = pj1;
      if (timed && Date.now() - t0 >= ms) break;
    }
    if (P.row < b.py) return false;
    for (k = PYR + 1; k <= LEVELS; k++) {
      var a = P.lv[k - 1], p = P.lv[k];
      for (j = 0; j < a.py; j++) for (i = 0; i < a.px; i++) {
        var c = j * a.px + i;
        if (!a.n[c]) continue;
        var d = (j >> 1) * p.px + (i >> 1);
        p.n[d] += a.n[c]; p.w[d] += a.w[c]; p.h[d] += a.h[c]; p.h2[d] += a.h2[c];
        p.x[d] += a.x[c] + (i & 1) * a.s * a.w[c]; p.y[d] += a.y[c] + (j & 1) * a.s * a.w[c];
      }
    }
    P.ready = true;
    return true;
  }
  // The sums of patch (pi, pj) of level k into o = { n, w, h, h2, x, y }: from the pyramid, or from the cells.
  function patchSums(D, k, pi, pj, o) {
    if (k >= PYR) {
      var lv = D.P.lv[k], q = pj * lv.px + pi;
      o.n = lv.n[q]; o.w = lv.w[q]; o.h = lv.h[q]; o.h2 = lv.h2[q]; o.x = lv.x[q]; o.y = lv.y[q];
      return o;
    }
    var F = D.F, L = D.L, S = F.share, H = F.height, s = 1 << k, i0 = pi * s, j0 = pj * s, i1 = Math.min(F.nx, i0 + s), j1 = Math.min(F.ny, j0 + s), low = D.P ? D.P.low : Math.round((D.low > 0 ? D.low : LOW) * 100), i, j;
    var n = 0, w = 0, h = 0, h2 = 0, x = 0, y = 0;
    for (j = j0; j < j1; j++) for (i = i0; i < i1; i++) {
      var a = j * F.nx + i, c = L[S[a]];
      if (!c) continue;
      var hc = H[a] || low;
      n++; w += c; h += hc; h2 += hc * hc; x += c * (i - i0); y += c * (j - j0);
    }
    o.n = n; o.w = w; o.h = h; o.h2 = h2; o.x = x; o.y = y;
    return o;
  }
  // Does a patch with n brushy cells get a clump? With CMIN of it brushy or more, always; with less, by an ordered
  // threshold over the patches (and then the clump is as large as CMIN's): the ground covered stays true.
  function clumpDrawn(n, k, pi, pj) {
    if (!n) return false;
    var c = n / (1 << (2 * k));
    return c >= CMIN || c / CMIN >= (bayer4(pi, pj) + 0.5) / 16;
  }
  function varyClump(k, a) {
    var s = 16 * k;
    return { dx: (unit(a, s + 1) * 2 - 1) * C_JITTER, dy: (unit(a, s + 2) * 2 - 1) * C_JITTER, size: 1 + (unit(a, s + 3) * 2 - 1) * C_SIZE_VAR, oval: (unit(a, s + 4) * 2 - 1) * C_OVAL,
             turn: unit(a, s + 5) * 2 * Math.PI, tint: TINT_LO + (TINT_HI - TINT_LO) * unit(a, s + 6) };
  }
  // The clump of patch (pi, pj) of level k from its sums: null (no clump), or { x, y (its centre: the brushy cells'
  // centre weighted by their density, moved a little by the hash), r (m: from the brushy AREA, pi r^2 = AREA x the
  // cells' ground), h (m: the cells' mean height and half their spread, so far brush does not shrink), op (0..1:
  // the cells' mean opacity, the bushes' own curve), cover (the share of the patch it stands for), v (its hash) }.
  function clumpOf(F, k, pi, pj, o) {
    if (!clumpDrawn(o.n, k, pi, pj)) return null;
    var s = 1 << k, c = Math.max(o.n / (s * s), CMIN), px = Math.ceil(F.nx / s), v = varyClump(k, pj * px + pi);
    var mh = o.h / o.n, sd = Math.sqrt(Math.max(0, o.h2 / o.n - mh * mh));
    return { x: F.x0 + (pi * s + o.x / o.w + 0.5 + v.dx * s) * F.cell, y: F.y0 + (pj * s + o.y / o.w + 0.5 + v.dy * s) * F.cell,
             r: F.cell * s * Math.sqrt(c * AREA / Math.PI), h: Math.min(mh + 0.5 * sd, 250) / 100, op: o.w / o.n / 255, cover: c, v: v };
  }
  // The clump tiles of level k (tileC(k) patches a side) once the pyramid is whole: as tiles() gives them.
  // n is the clumps before a tile is built: exact from level PYR up, never fewer under it.
  function clumpTiles(D, k) {
    var F = D.F, P = D.P, s = 1 << k, px = Math.ceil(F.nx / s), py = Math.ceil(F.ny / s), TC = tileC(k), tx = Math.ceil(px / TC), ty = Math.ceil(py / TC), cnt = new Uint32Array(tx * ty), i, j;
    if (k >= PYR) {
      var lv = P.lv[k];
      for (j = 0; j < py; j++) for (i = 0; i < px; i++) if (clumpDrawn(lv.n[j * px + i], k, i, j)) cnt[((j / TC) | 0) * tx + ((i / TC) | 0)]++;
    } else {
      var b = P.lv[PYR], per = (b.s / s) * (b.s / s), side = TC * s / b.s;                 // patches of this level in one of PYR; PYR patches a tile side
      for (j = 0; j < b.py; j++) for (i = 0; i < b.px; i++) { var n = b.n[j * b.px + i]; if (n) cnt[((j / side) | 0) * tx + ((i / side) | 0)] += n < per ? n : per; }
    }
    var list = [], at = new Array(tx * ty), size = TC * s * F.cell, pad = F.cell * s * (Math.sqrt(AREA / Math.PI) * (1 + C_SIZE_VAR) * (1 + C_OVAL) + C_JITTER), total = 0;
    for (j = 0; j < ty; j++) for (i = 0; i < tx; i++) {
      var c = cnt[j * tx + i], t = null;
      if (c) {
        t = { k: k, cx: i, cy: j, cells: c, n: c, state: 0, d: 0, f: 0, last: 0, mesh: null, z: false,
              box: [F.x0 + i * size - pad, F.y0 + j * size - pad, 0, F.x0 + Math.min(F.nx * F.cell, (i + 1) * size) + pad, F.y0 + Math.min(F.ny * F.cell, (j + 1) * size) + pad, 0] };
        list.push(t); total += c;
      }
      at[j * tx + i] = t;
    }
    return { k: k, list: list, at: at, tx: tx, ty: ty, cells: total, size: size };
  }
  // One clump tile's instance buffers, as buildTile gives them. D = { F, L, P, groundZ, low }; (ti, tj) the tile.
  function buildClumps(D, k, ti, tj) {
    var F = D.F, s = 1 << k, px = Math.ceil(F.nx / s), py = Math.ceil(F.ny / s), TC = tileC(k), i0 = ti * TC, j0 = tj * TC, i1 = Math.min(px, i0 + TC), j1 = Math.min(py, j0 + TC);
    var cap = (i1 - i0) * (j1 - j0), mat = new Float32Array(cap * 16), col = new Float32Array(cap * 3), op = new Float32Array(cap), n = 0, zmin = Infinity, zmax = -Infinity, o = {}, pi, pj;
    var gz = function (x, y) { var g = D.groundZ(x, y); return g == null || !isFinite(g) ? NaN : g; };
    for (pj = j0; pj < j1; pj++) for (pi = i0; pi < i1; pi++) {
      var C = clumpOf(F, k, pi, pj, patchSums(D, k, pi, pj, o));
      if (!C) continue;
      var x = C.x, y = C.y, v = C.v, r = C.r * v.size, g = gz(x, y);
      if (g !== g) continue;                                     // off the terrain
      // the ground under the clump: at its centre and at its rim, east, west, north, south
      var gE = gz(x + r, y), gW = gz(x - r, y), gN = gz(x, y + r), gS = gz(x, y - r);
      if (gE !== gE) gE = g; if (gW !== gW) gW = g; if (gN !== gN) gN = g; if (gS !== gS) gS = g;
      var sx = (gE - gW) / (2 * r), sy = (gN - gS) / (2 * r), sl = Math.sqrt(sx * sx + sy * sy);
      // the base is the plane through the rim's mean; where the ground bulges over it the clump is lifted, where it
      // falls under it the base goes down (never buried, never floating)
      var mEW = (gE + gW) / 2, mNS = (gN + gS) / 2, mid = (mEW + mNS) / 2, up = Math.max(0, g - mid), down = SINK + Math.max(0, mid - Math.min(mEW, mNS), mid - g);
      if (sl > SLOPE_MAX) { down += r * (sl - SLOPE_MAX); sx *= SLOPE_MAX / sl; sy *= SLOPE_MAX / sl; }
      var h = C.h + up, rx = r * (1 + v.oval), ry = r * (1 - v.oval), ca = Math.cos(v.turn), sa = Math.sin(v.turn), m = n * 16;
      mat[m] = rx * ca; mat[m + 1] = rx * sa; mat[m + 2] = rx * (sx * ca + sy * sa);
      mat[m + 4] = -ry * sa; mat[m + 5] = ry * ca; mat[m + 6] = ry * (-sx * sa + sy * ca);
      mat[m + 10] = h + down;
      mat[m + 12] = x; mat[m + 13] = y; mat[m + 14] = mid - down; mat[m + 15] = 1;
      var t = v.tint * C_SHADE / 255, e = C.op * C.op * (3 - 2 * C.op);
      col[n * 3] = (COLOUR_LIGHT[0] + (COLOUR_DENSE[0] - COLOUR_LIGHT[0]) * e) * t;
      col[n * 3 + 1] = (COLOUR_LIGHT[1] + (COLOUR_DENSE[1] - COLOUR_LIGHT[1]) * e) * t;
      col[n * 3 + 2] = (COLOUR_LIGHT[2] + (COLOUR_DENSE[2] - COLOUR_LIGHT[2]) * e) * t;
      op[n] = C.op;
      var reach = r * 1.2 * Math.min(sl, SLOPE_MAX);
      if (mid - down - reach < zmin) zmin = mid - down - reach; if (mid + h + reach > zmax) zmax = mid + h + reach;
      n++;
    }
    if (!n) return null;
    return { n: n, mat: n === cap ? mat : mat.slice(0, n * 16), col: n === cap ? col : col.slice(0, n * 3), op: n === cap ? op : op.slice(0, n), zmin: zmin, zmax: zmax };
  }

  // ── What a view draws ─────────────────────────────────────────────────────────────────────────────────────────
  // A view too heavy for the budget takes the next of STEPS: the clump levels come in sooner (grow falls from 1)
  // and the bushes' own reach shrinks (near), in turns.
  // The rings of a step: { R (R[k] = where level k is whole; R[0] = 0; past the last level: Infinity), B (B[k] = the
  // share of R[k] before it over which level k - 1 hands over to level k: FADE, less where the rings are close),
  // top (the coarsest level) }. No two hand-overs overlap.
  function rings(step, far, top) {
    step = step < 0 ? 0 : step >= STEPS.length ? STEPS.length - 1 : step;
    var st = STEPS[step], r = (far > 0 ? far : FAR_MAX) * st[1], R = [0], B = [0], k;
    for (k = 1; k <= Math.max(top, 1); k++) { R.push(r * Math.pow(START[k - 1], st[0])); B.push(Math.min(FADE, 0.9 * (1 - R[k - 1] / R[k]))); }
    R.push(Infinity); B.push(0);
    return { R: R, B: B, top: top, step: step };
  }
  // Level k's fade distances: [out0, out1, in0, in1] (whole between in1 and out0; the shader's uBushFade). The
  // coarsest level has no end; with no clumps (top 0) the bushes fade to nothing at R[1].
  function fadeOf(G, k) {
    var last = k >= G.top && G.top > 0, o = G.R[k + 1];
    return [last ? 1e9 : o * (1 - G.B[k + 1]), last ? 2e9 : o, k ? G.R[k] * (1 - G.B[k]) : NEAR[0], k ? G.R[k] : NEAR[1]];
  }
  function smooth(a, b, x) { var t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
  // How much of level k is drawn at distance d (0..1): next to each other, two levels add up to 1.
  function weight(G, k, d) { var f = fadeOf(G, k); return (1 - smooth(f[0], f[1], d)) * (k ? smooth(f[2], f[3], d) : 1); }
  // V = { T: tiles(), C: [, clumpTiles(1), …] or null (the pyramid is not whole yet) }; cam = [x, y, z];
  // inView(box); o = { far (the bushes' reach, FAR_MAX), prev (the step of the view before, where the search starts:
  // a finer step is taken only with a twentieth of the budget to spare, so the rings do not go to and fro) }.
  // Returns { draw (nearest first), tris, far (R[1]), step, rings, levels: [{ tiles, n }] }: the first step whose
  // tiles in view fit the budget (the last one whatever it holds).
  function select(D, V, cam, inView, budget, o) {
    o = typeof o === 'number' ? { far: o } : o || {};
    budget = budget > 0 ? budget : BUDGET;
    var top = V.C ? V.C.length - 1 : 0, prev = o.prev >= 0 && o.prev < STEPS.length ? o.prev : 0, G, cand, tris, k, i, j;
    function look(step) {
      G = rings(step, o.far, top); cand = []; tris = 0;
      for (k = 0; k <= top; k++) {
        var T = k ? V.C[k] : V.T, f = fadeOf(G, k), out = f[1], inn = k ? f[2] : 0, size = T.size, i0 = 0, i1 = T.tx - 1, j0 = 0, j1 = T.ty - 1, per = k ? C_TRIS : TRIS;
        if (out < 1e9) {
          i0 = Math.max(0, Math.floor((cam[0] - out - D.F.x0) / size) - 1); i1 = Math.min(T.tx - 1, Math.floor((cam[0] + out - D.F.x0) / size) + 1);
          j0 = Math.max(0, Math.floor((cam[1] - out - D.F.y0) / size) - 1); j1 = Math.min(T.ty - 1, Math.floor((cam[1] + out - D.F.y0) / size) + 1);
        }
        for (j = j0; j <= j1; j++) for (i = i0; i <= i1; i++) {
          var t = T.at[j * T.tx + i];
          if (!t || t.state === 2) continue;
          tileZ(D, t);
          t.d = distTo(t.box, cam);
          if (t.d >= out) continue;
          if (inn > 0 && distFar(t.box, cam) <= inn) continue;   // wholly nearer than this level starts
          if (!inView(t.box)) continue;
          cand.push(t); tris += t.n * (k ? C_TRIS : trisAt(t.d));
        }
      }
      return tris;
    }
    // from the step before: finer while that fits with a tenth to spare, coarser while it does not fit
    var step = prev, last = STEPS.length - 1;
    if (look(step) <= budget) { while (step > 0 && look(step - 1) <= budget * 0.95) step--; }
    else while (step < last && look(++step) > budget) {}
    look(step);
    cand.sort(function (a, b) { return a.d - b.d; });
    return { draw: cand, tris: tris, far: G.R[1], step: step, rings: G };
  }

  // Which solid a bush tile at distance d (m, its nearest point) is drawn with: 0 the dome, 1 the lighter dome,
  // 2 the simplest; and its triangles a bush.
  function solidAt(d) { return d > FAR_FROM ? 2 : d > LIGHT_FROM ? 1 : 0; }
  function trisAt(d) { var s = solidAt(d); return s === 2 ? FAR_TRIS : s ? C_TRIS : TRIS; }

  // The dome: { pos, nor (smooth: one vertex a ring place, its normal the mean of its faces'), idx }.
  function dome() { return solid(SIDES, RINGS, TOP); }
  function solid(SIDES, RINGS, TOP) {
    var pos = [], idx = [], k, s, R = RINGS.length;
    for (k = 0; k < R; k++) for (s = 0; s < SIDES; s++) {
      var a = 2 * Math.PI * (s + (k & 1) * 0.5) / SIDES;         // every other ring half a side on: no straight edges up the dome
      pos.push(RINGS[k][0] * Math.cos(a), RINGS[k][0] * Math.sin(a), RINGS[k][1]);
    }
    pos.push(0, 0, TOP);
    for (k = 0; k + 1 < R; k++) for (s = 0; s < SIDES; s++) {
      var p = k * SIDES + s, q = k * SIDES + (s + 1) % SIDES, u = (k + 1) * SIDES + s, w = (k + 1) * SIDES + (s + 1) % SIDES;
      if (k & 1) idx.push(p, q, u, q, w, u); else idx.push(p, q, u, p, u, (k + 1) * SIDES + (s + SIDES - 1) % SIDES);
    }
    var top = (R - 1) * SIDES, apex = R * SIDES;
    for (s = 0; s < SIDES; s++) idx.push(top + s, top + (s + 1) % SIDES, apex);
    var nor = new Float32Array(pos.length), i, j;
    for (i = 0; i < idx.length; i += 3) {
      var A = idx[i] * 3, B = idx[i + 1] * 3, C = idx[i + 2] * 3;
      var ux = pos[B] - pos[A], uy = pos[B + 1] - pos[A + 1], uz = pos[B + 2] - pos[A + 2], vx = pos[C] - pos[A], vy = pos[C + 1] - pos[A + 1], vz = pos[C + 2] - pos[A + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (j = 0; j < 3; j++) { var o = idx[i + j] * 3; nor[o] += nx; nor[o + 1] += ny; nor[o + 2] += nz; }
    }
    for (i = 0; i < nor.length; i += 3) { var l = Math.sqrt(nor[i] * nor[i] + nor[i + 1] * nor[i + 1] + nor[i + 2] * nor[i + 2]) || 1; nor[i] /= l; nor[i + 1] /= l; nor[i + 2] /= l; }
    return { pos: new Float32Array(pos), nor: nor, idx: new Uint16Array(idx) };
  }

  // The clump: the dome's lighter cousin, wide at the ground (C_TRIS triangles).
  function clumpSolid() { return solid(C_SIDES, C_RINGS, TOP); }
  // The bush from LIGHT_FROM on: the dome's outline with one ring less.
  function lightDome() { return solid(C_SIDES, LIGHT_RINGS, TOP); }
  // The bush from FAR_FROM on: three sides, two rings half a side apart, a point on top.
  function farDome() { return solid(FAR_SIDES, FAR_RINGS, TOP); }

  // uBushFade = (out0, out1, in0, in1): whole between in1 and out0 from the eye. uBushInv 1 = the dither's ranks
  // turned over (every other level): where two levels hand over, one draws the pixels the other leaves.
  var HEAD_V = 'attribute float aBushOp;\nuniform float uBushLevel;\nuniform vec4 uBushFade;\nvarying float vBushOp;\n';
  var BODY_V = '\n\t#ifdef USE_INSTANCING\n\t{ vec3 bushAt = (modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;       // (a Lambert material is not given cameraPosition)\n' +
    '\t  float bushD = length(bushAt);\n' +
    '\t  vBushOp = aBushOp * uBushLevel * (1.0 - smoothstep(uBushFade.x, uBushFade.y, bushD)) * smoothstep(uBushFade.z, uBushFade.w, bushD);\n' +
    '\t  if (vBushOp < 0.03125) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }\n\t#else\n\tvBushOp = uBushLevel;\n\t#endif\n';
  // A clump is lit as the bush it stands for: its normals are not flattened with it (the columns' lengths are taken out).
  var NORMAL_V = '\n\t#ifdef USE_INSTANCING\n\tif (uBushRound > 0.5) { mat3 bm = mat3(instanceMatrix); \n' +
    '\t  transformedNormal = normalize(normalMatrix * (normalize(bm[0]) * objectNormal.x + normalize(bm[1]) * objectNormal.y + vec3(0.0, 0.0, 1.0) * objectNormal.z)); }\n\t#endif\n';
  var HEAD_F = 'varying float vBushOp;\nuniform float uBushInv;\n' +
    'float flexBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }\n' +
    'float flexBayer4(vec2 a) { return flexBayer2(0.5 * a) * 0.25 + flexBayer2(a); }\n';
  var BODY_F = '\n\t{ float bushB = flexBayer4(gl_FragCoord.xy); if (uBushInv > 0.5) bushB = 0.9375 - bushB;\n\t  if (bushB + 0.03125 > vBushOp) discard; }';

  function create(ctx) {
    var THREE = ctx.THREE, F = ctx.grid, K = knots(ctx.classes), L0 = lut(K), L = new Uint8Array(mask(L0, K, ctx.classesOn)), on = Array.isArray(ctx.classesOn) ? ctx.classesOn.slice() : null;
    var D = { F: F, L: L, K: K, groundZ: ctx.groundZ, low: ctx.bandLow, P: null };
    var V = { T: tiles(F, L), C: null }, stock = [dome(), clumpSolid(), lightDome(), farDome()];
    var uLevel = { value: 1 }, mats = [];
    // one material a level: the same program, each with its own fade
    function material(k) {
      if (mats[k]) return mats[k];
      var m = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0a1206 });
      m.userData.uFade = { value: new THREE.Vector4(FAR_MAX * (1 - FADE), FAR_MAX, NEAR[0], NEAR[1]) };
      m.userData.uInv = { value: k & 1 }; m.userData.uRound = { value: k ? 1 : 0 };
      m.onBeforeCompile = function (sh) {
        sh.uniforms.uBushLevel = uLevel; sh.uniforms.uBushFade = m.userData.uFade; sh.uniforms.uBushInv = m.userData.uInv; sh.uniforms.uBushRound = m.userData.uRound;
        sh.vertexShader = HEAD_V + 'uniform float uBushRound;\n' + sh.vertexShader.replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>' + NORMAL_V).replace('#include <project_vertex>', '#include <project_vertex>' + BODY_V);
        sh.fragmentShader = HEAD_F + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + BODY_F);
        if (root.FlexUnder) root.FlexUnder.sunk(sh);         // seen from underground: no sunk bushes hanging from the ceiling (libs/terrain-under.js)
      };
      mats[k] = m;
      return m;
    }
    var mat = material(0);
    var group = new THREE.Group(); group.name = 'brush-bushes'; group.matrixAutoUpdate = false;
    var lim = ctx.budget || {};                                  // the hub's: { triangles, cache (triangles kept), buildMs, far (m) }
    var S = { budget: lim.triangles > 0 ? lim.triangles : BUDGET, farMax: lim.far > 0 ? lim.far : FAR_MAX, cache: lim.cache > 0 ? Math.round(lim.cache / TRIS) : CACHE, buildMs: lim.buildMs > 0 ? Math.min(lim.buildMs, BUILD_MS) : BUILD_MS, built: [], held: 0, drawn: [], tris: 0, inst: 0, far: FAR_MAX, frame: 0, dirty: true, waiting: 0, gone: false,
              step: 0, rings: rings(0, FAR_MAX, 0), levels: [], pyrMs: 0,
              seen: new Float64Array(16), m4: new THREE.Matrix4(), pv: new THREE.Matrix4(), frustum: new THREE.Frustum(), box: new THREE.Box3() };
    var wake = function () { if (ctx.wake) ctx.wake(); };

    // The pyramid and the clump tiles: a few milliseconds a frame until whole (all at once when `all`).
    function far(all) {
      if (V.C) return true;
      if (!V.T.cells) { V.C = [null]; return true; }             // no brush: no clumps
      if (!D.P) D.P = pyramid(F, L, D.low);
      var t0 = Date.now(), done = pyramidStep(D.P, all ? undefined : S.buildMs);
      S.pyrMs += Date.now() - t0;
      if (!done) return false;
      var C = [null], k;
      for (k = 1; k <= LEVELS; k++) C.push(clumpTiles(D, k));
      V.C = C;
      return true;
    }
    function geometry(st, op) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(st.pos.slice(), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(st.nor.slice(), 3));
      g.setIndex(new THREE.BufferAttribute(st.idx.slice(), 1));
      g.setAttribute('aBushOp', op);
      return g;
    }
    // A tile of bushes past LIGHT_FROM is drawn with the lighter dome, past FAR_FROM with the simplest (its second
    // and third geometry, the same instances).
    function solidOf(t) {
      if (t.k) return;
      var light = solidAt(t.d);
      if (light === t.light) return;
      if (light && !t.geo[light]) t.geo[light] = geometry(stock[light + 1], t.op);
      t.mesh.geometry = t.geo[light]; t.light = light;
    }
    function free(t) {
      if (!t.mesh) return;
      group.remove(t.mesh); t.geo.forEach(function (g) { if (g) g.dispose(); }); if (t.mesh.dispose) t.mesh.dispose();
      t.mesh = null; t.geo = null; t.op = null;
    }
    function make(t) {
      var B = t.k ? buildClumps(D, t.k, t.cx, t.cy) : buildTile(D, t.cx, t.cy), st = stock[t.k ? 1 : 0];
      if (!B) { t.state = 2; t.n = 0; return; }
      // (each tile has its own copy of the solid's few vertices, so dropping a tile frees only what is its own)
      var op = new THREE.InstancedBufferAttribute(B.op, 1), g = geometry(st, op);
      var mesh = new THREE.InstancedMesh(g, material(t.k), B.n);
      t.geo = [g, null, null]; t.light = 0; t.op = op;
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(B.mat, 16);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(B.col, 3);
      mesh.name = t.k ? 'brush-bushes-clumps' : 'brush-bushes-tile'; mesh.userData.level = t.k; mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.visible = false;
      mesh.raycast = function () {};                             // taps go through the brush
      t.mesh = mesh; t.state = 1; t.n = B.n; t.box[2] = B.zmin; t.box[5] = B.zmax;
      group.add(mesh); S.built.push(t); S.held += B.n;
    }
    function drop(t) {
      if (t.mesh) { free(t); S.held -= t.n; }
      t.state = 0; t.n = t.cells;
    }
    function trim() {
      if (S.held <= S.cache) return;
      S.built.sort(function (a, b) { return a.last - b.last; });
      var keep = [], i;
      for (i = 0; i < S.built.length; i++) { var t = S.built[i]; if (S.held > S.cache && t.last < S.frame) drop(t); else keep.push(t); }
      S.built = keep;
    }
    function clear() {
      S.built.forEach(function (t) { free(t); t.state = 0; });
      S.built = []; S.drawn = []; S.held = 0; S.tris = 0; S.inst = 0; S.levels = [];
    }
    function update(cam, all) {
      if (S.gone || !group.visible) return;
      cam = cam || ctx.camera;
      cam.updateMatrixWorld();
      S.m4.copy(cam.matrixWorld).invert(); S.pv.multiplyMatrices(cam.projectionMatrix, S.m4);
      var e = S.pv.elements, same = !S.dirty, i;
      for (i = 0; i < 16 && same; i++) if (e[i] !== S.seen[i]) same = false;
      if (same) return;
      for (i = 0; i < 16; i++) S.seen[i] = e[i];
      S.frustum.setFromProjectionMatrix(S.pv);
      var inView = function (b) { S.box.min.set(b[0], b[1], b[2]); S.box.max.set(b[3], b[4], b[5]); return S.frustum.intersectsBox(S.box); };
      var p = [cam.matrixWorld.elements[12], cam.matrixWorld.elements[13], cam.matrixWorld.elements[14]], sel, built = 0, left = 0;
      var whole = far(all), t0 = Date.now();
      for (;;) {
        sel = select(D, V, p, inView, S.budget, { far: S.farMax, prev: S.step });
        var did = 0;
        left = 0;
        for (i = 0; i < sel.draw.length; i++) {
          if (sel.draw[i].state) continue;
          if (!all && did && Date.now() - t0 >= S.buildMs) { left++; continue; }
          make(sel.draw[i]); did++; built++;
        }
        S.step = sel.step;
        if (!all || !did) break;                                 // (all: once more, the counts are the real ones now)
      }
      S.frame++;
      for (i = 0; i < S.drawn.length; i++) if (S.drawn[i].mesh) S.drawn[i].mesh.visible = false;
      var drawn = [], tris = 0, inst = 0, lv = [];
      for (i = 0; i <= LEVELS; i++) lv.push({ tiles: 0, instances: 0, triangles: 0 });
      for (i = 0; i < sel.draw.length; i++) {
        var t = sel.draw[i]; if (t.state !== 1) continue;
        solidOf(t);
        var per = t.k || t.light === 1 ? C_TRIS : t.light ? FAR_TRIS : TRIS;
        t.mesh.visible = true; t.last = S.frame; drawn.push(t); tris += t.n * per; inst += t.n;
        lv[t.k].tiles++; lv[t.k].instances += t.n; lv[t.k].triangles += t.n * per;
      }
      S.drawn = drawn; S.tris = tris; S.inst = inst; S.far = sel.far; S.waiting = left + (whole ? 0 : 1); S.rings = sel.rings; S.levels = lv;
      for (i = 0; i <= sel.rings.top; i++) { var f = fadeOf(sel.rings, i); material(i).userData.uFade.value.set(f[0], f[1], f[2], f[3]); }
      // a tile just built has its real count, which may move the rings: one more look
      S.dirty = left > 0 || !whole || (built > 0 && !all);
      if (built) trim();
      if (S.dirty) wake();
    }

    return {
      group: group, material: mat, materials: mats,
      update: function (cam) { update(cam, false); },
      settle: function (cam) { S.dirty = true; update(cam, true); },
      setLevel: function (v) { v = Number(v); if (!isFinite(v)) return; uLevel.value = v < 0 ? 0 : v > 1 ? 1 : v; wake(); },
      // The classes shown ([bool a class], lightest first): the cells of a class that is off have no bush and are
      // in no clump. The tiles, the pyramid and the clumps are made again as views want them (the same lazy way).
      setClasses: function (v) {
        if (S.gone || !Array.isArray(v) || (on && v.join() === on.join())) return;
        on = v.slice(); L.set(mask(L0, K, on));
        clear();
        V.T = tiles(F, L); V.C = null; D.P = null; S.dirty = true; wake();
      },
      // budget (triangles), the bushes' reach (m), the cache (bushes and clumps held; cacheTris: the same in the
      // hub's measure, triangles): the hub's detail steps, tests. Takes
      // effect on the next frame, which it asks for; nothing is built again (a tile keeps its instances).
      limits: function (o) {
        if (o) {
          if (o.budget > 0) S.budget = o.budget; if (o.far > 0) S.farMax = o.far; if (o.cacheTris > 0) S.cache = Math.round(o.cacheTris / TRIS); if (o.cache > 0) S.cache = o.cache;
          S.dirty = true; if (!S.gone) { trim(); wake(); }
        }
        return { budget: S.budget, far: S.farMax, cache: S.cache };
      },
      dispose: function () {
        S.gone = true;
        clear();
        mats.forEach(function (m) { if (m) m.dispose(); });
        V.C = null; D.P = null;
        if (group.parent) group.parent.remove(group);
      },
      // { triangles, instances (drawn now, all levels), tiles drawn, far (m: the bushes' reach), level, waiting,
      //   built tiles, held bushes and clumps, cells, all tiles, levels: [{ tiles, instances, triangles } a level,
      //   0 = the bushes], rings (where each level is whole, m), step (of the budget), pyramid (ready, ms, bytes) }
      stats: function () {
        var bytes = 0;
        if (D.P) D.P.lv.forEach(function (l) { if (l) bytes += l.n.length * 22; });
        return { triangles: S.tris, instances: S.inst, tiles: S.drawn.length, far: S.far, level: uLevel.value, waiting: S.dirty ? Math.max(1, S.waiting) : 0, built: S.built.length, held: S.held,
                 cells: V.T.cells, allTiles: V.T.list.length, budget: S.budget, farMax: S.farMax, cache: S.cache, trisPerBush: TRIS, trisPerClump: C_TRIS, trisPerFar: FAR_TRIS, classesOn: on ? on.slice() : null,
                 levels: S.levels.map(function (l) { return { tiles: l.tiles, instances: l.instances, triangles: l.triangles }; }),
                 rings: S.rings.R.slice(1).map(function (r) { return r === Infinity ? null : Math.round(r); }), step: S.step,
                 pyramid: { ready: !!V.C, ms: S.pyrMs, bytes: bytes } };
      },
    };
  }

  var R = { TILE: TILE, TRIS: TRIS, SIDES: SIDES, BUDGET: BUDGET, FAR_MAX: FAR_MAX, FADE: FADE, CACHE: CACHE, WIDTH: WIDTH, WIDTH2: WIDTH2, SIZE_VAR: SIZE_VAR, JITTER: JITTER, JITTER2: JITTER2,
            TINT_LO: TINT_LO, TINT_HI: TINT_HI, SINK: SINK, SLOPE_MAX: SLOPE_MAX, SINK_MAX: SINK_MAX, NEAR: NEAR, LOW: LOW, LOW_H: LOW_H, TALL_H: TALL_H, widthOf: widthOf, MERGE_DH: MERGE_DH, MERGE_DO: MERGE_DO,
            LEVELS: LEVELS, PYR: PYR, TILE_C: TILE_C, tileC: tileC, C_TRIS: C_TRIS, CMIN: CMIN, AREA: AREA, C_SHADE: C_SHADE, START: START, STEPS: STEPS, C_JITTER: C_JITTER, C_SIZE_VAR: C_SIZE_VAR, C_OVAL: C_OVAL,
            hash: hash, vary: vary, knots: knots, opacityOf: opacityOf, lut: lut, mask: mask, fade: fade, plan: plan, merges: merges, buildTile: buildTile, tiles: tiles, select: select, dome: dome,
            bayer4: bayer4, pyramid: pyramid, pyramidStep: pyramidStep, patchSums: patchSums, clumpDrawn: clumpDrawn, clumpOf: clumpOf, clumpTiles: clumpTiles, buildClumps: buildClumps, clumpSolid: clumpSolid, lightDome: lightDome, LIGHT_FROM: LIGHT_FROM, farDome: farDome, FAR_FROM: FAR_FROM, FAR_TRIS: FAR_TRIS, solidAt: solidAt, trisAt: trisAt,
            rings: rings, fadeOf: fadeOf, weight: weight, create: create };

  root.FlexBrushLooks = root.FlexBrushLooks || {};
  root.FlexBrushLooks.bushes = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
