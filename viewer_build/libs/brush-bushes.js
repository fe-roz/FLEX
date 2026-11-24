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
//            this view wants at once: pictures, tests) }
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
// Distance: bushes are drawn to `far` only, fading out with the same dither over the last FADE of it (no
// coarser level: past that the baked brush map picture carries the brush). `far` is FAR_MAX, less when the
// view holds more than BUDGET triangles (the tiles in view, nearest first, are counted until the budget is
// full): the budget always holds.
// A bush stands on the ground at its own centre and its base is sheared to the ground's slope there (the top
// stays straight above the centre), sunk SINK; on ground steeper than SLOPE_MAX it is sunk more instead (half its
// height at most). Bushes within NEAR of the eye fade out as well: standing in brush, the screen is not one bush.
// The grid is cut into tiles of TILE x TILE cells, each one instanced mesh (THREE.InstancedMesh, r128), made
// the first time a view wants it (BUILD_MS a frame, nearest first), kept until CACHE bushes are held, then the
// ones drawn longest ago go. Nothing animates. Bushes are not part of the terrain: taps go through them.
// Test: tools/test_brush_bushes.js
(function (root) {
  'use strict';

  var TILE = 32;                                               // cells a tile side
  var SIDES = 5, RINGS = [[0.72, 0], [1, 0.36], [0.7, 0.78]], TOP = 1;        // the dome: [radius, height] rings, closed by a point at TOP
  var TRIS = SIDES * (2 * (RINGS.length - 1) + 1);             // triangles a bush
  var BUDGET = 600000;                                         // triangles drawn at once
  var FAR_MAX = 220, FADE = 0.3;                               // bushes are drawn to `far` (m) at most; the last FADE of it fades out
  var CACHE = 100000;                                          // bushes kept built (80 bytes each), when the hub gives no cache
  var BUILD_MS = 4;                                            // building time a frame
  // A bush's radius in cells: one cell [low brush, tall brush]; a 2 x 2 block. Between LOW_H and TALL_H (m) of
  // height it grows from the first to the second, so tall brush is a shrub and not a post.
  var WIDTH = [0.72, 0.98], WIDTH2 = [1.3, 1.45], LOW_H = 0.8, TALL_H = 2.2;
  var SIZE_VAR = 0.15, OVAL = 0.1, JITTER = 0.28, JITTER2 = 0.3;      // +- width; oval; place inside the cell (cells)
  var TINT_LO = 0.86, TINT_HI = 1.14;
  var MERGE_DH = 60, MERGE_DO = 0.5;                           // a 2 x 2 block is one bush when heights are within this (cm) and opacities within this
  var SINK = 0.12, SLOPE_MAX = 1.0, SINK_MAX = 0.5;            // base under the ground (m); the base follows slopes up to this rise / run; steeper: sunk more, to this share of the height at most
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
  // The tiles of a grid that have brush: [{ cx, cy, cells, n (bushes once built, else the cells: never fewer),
  // box [x0, y0, z0, x1, y1, z1] (z once asked), state (0 not built, 1 built, 2 built and empty), d, last }], and
  // { tx, ty, at[] (tile by its place, null = no brush) }.
  function tiles(F, L) {
    var tx = Math.ceil(F.nx / TILE), ty = Math.ceil(F.ny / TILE), cnt = new Uint32Array(tx * ty), i, j, cells = 0;
    for (j = 0; j < F.ny; j++) { var r = j * F.nx, o = ((j / TILE) | 0) * tx; for (i = 0; i < F.nx; i++) if (L[F.share[r + i]]) { cnt[o + ((i / TILE) | 0)]++; cells++; } }
    var list = [], at = new Array(tx * ty), pad = F.cell * (WIDTH2[1] * (1 + SIZE_VAR) + JITTER2);
    for (j = 0; j < ty; j++) for (i = 0; i < tx; i++) {
      var c = cnt[j * tx + i], t = null;
      if (c) {
        t = { cx: i * TILE, cy: j * TILE, cells: c, n: c, state: 0, d: 0, last: 0, mesh: null, z: false,
              box: [F.x0 + i * TILE * F.cell - pad, F.y0 + j * TILE * F.cell - pad, 0, F.x0 + Math.min(F.nx, (i + 1) * TILE) * F.cell + pad, F.y0 + Math.min(F.ny, (j + 1) * TILE) * F.cell + pad, 0] };
        list.push(t);
      }
      at[j * tx + i] = t;
    }
    return { list: list, at: at, tx: tx, ty: ty, cells: cells };
  }
  // A tile's heights before it is built: the ground over a 5 x 5 lattice, with room for what lies between.
  function tileZ(D, t) {
    if (t.z) return;
    var b = t.box, lo = Infinity, hi = -Infinity, i, j;
    for (j = 0; j <= 4; j++) for (i = 0; i <= 4; i++) { var g = D.groundZ(b[0] + (b[3] - b[0]) * i / 4, b[1] + (b[4] - b[1]) * j / 4); if (g != null && isFinite(g)) { if (g < lo) lo = g; if (g > hi) hi = g; } }
    if (lo > hi) { lo = hi = 0; }
    var pad = 3 + (hi - lo) * 0.3;
    b[2] = lo - pad; b[5] = hi + pad; t.z = true;
  }
  function distTo(b, c) {
    var dx = c[0] < b[0] ? b[0] - c[0] : c[0] > b[3] ? c[0] - b[3] : 0, dy = c[1] < b[1] ? b[1] - c[1] : c[1] > b[4] ? c[1] - b[4] : 0, dz = c[2] < b[2] ? b[2] - c[2] : c[2] > b[5] ? c[2] - b[5] : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  // What a view draws. T = tiles(); cam = [x, y, z]; inView(box). Returns { draw (nearest first), far, tris }:
  // the tiles in view nearer than `far`, where far is farMax or the distance at which the budget is full.
  function select(D, T, cam, inView, budget, farMax) {
    var F = D.F, size = TILE * F.cell, cand = [], i, j;
    farMax = farMax > 0 ? farMax : FAR_MAX; budget = budget > 0 ? budget : BUDGET;
    var i0 = Math.max(0, Math.floor((cam[0] - farMax - F.x0) / size) - 1), i1 = Math.min(T.tx - 1, Math.floor((cam[0] + farMax - F.x0) / size) + 1);
    var j0 = Math.max(0, Math.floor((cam[1] - farMax - F.y0) / size) - 1), j1 = Math.min(T.ty - 1, Math.floor((cam[1] + farMax - F.y0) / size) + 1);
    for (j = j0; j <= j1; j++) for (i = i0; i <= i1; i++) {
      var t = T.at[j * T.tx + i];
      if (!t || t.state === 2) continue;
      tileZ(D, t);
      t.d = distTo(t.box, cam);
      if (t.d < farMax && inView(t.box)) cand.push(t);
    }
    cand.sort(function (a, b) { return a.d - b.d; });
    var far = farMax, tris = 0, k;
    for (k = 0; k < cand.length; k++) {
      var add = cand[k].n * TRIS;
      if (tris + add > budget && cand[k].d > 0) { far = cand[k].d; break; }
      tris += add;
    }
    // (the tile the eye is in is drawn whatever the budget: one tile, TILE x TILE bushes at most)
    cand.length = k;
    return { draw: cand, far: far, tris: tris };
  }

  // The dome: { pos, nor (smooth: one vertex a ring place, its normal the mean of its faces'), idx }.
  function dome() {
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

  var HEAD_V = 'attribute float aBushOp;\nuniform float uBushLevel;\nuniform vec4 uBushFade;\nvarying float vBushOp;\n';
  var BODY_V = '\n\t#ifdef USE_INSTANCING\n\t{ vec3 bushAt = (modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;       // (a Lambert material is not given cameraPosition)\n' +
    '\t  float bushD = length(bushAt);\n' +
    '\t  vBushOp = aBushOp * uBushLevel * (1.0 - smoothstep(uBushFade.x, uBushFade.y, bushD)) * smoothstep(uBushFade.z, uBushFade.w, bushD);\n' +
    '\t  if (vBushOp < 0.03125) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }\n\t#else\n\tvBushOp = uBushLevel;\n\t#endif\n';
  var HEAD_F = 'varying float vBushOp;\n' +
    'float flexBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }\n' +
    'float flexBayer4(vec2 a) { return flexBayer2(0.5 * a) * 0.25 + flexBayer2(a); }\n';
  var BODY_F = '\n\tif (flexBayer4(gl_FragCoord.xy) + 0.03125 > vBushOp) discard;';

  function create(ctx) {
    var THREE = ctx.THREE, F = ctx.grid, K = knots(ctx.classes), L = lut(K);
    var D = { F: F, L: L, K: K, groundZ: ctx.groundZ, low: ctx.bandLow };
    var T = tiles(F, L), stock = dome();
    var uLevel = { value: 1 }, uFade = { value: new THREE.Vector4(FAR_MAX * (1 - FADE), FAR_MAX, NEAR[0], NEAR[1]) };
    var mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0a1206 });
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uBushLevel = uLevel; sh.uniforms.uBushFade = uFade;
      sh.vertexShader = HEAD_V + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>' + BODY_V);
      sh.fragmentShader = HEAD_F + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + BODY_F);
    };
    var group = new THREE.Group(); group.name = 'brush-bushes'; group.matrixAutoUpdate = false;
    var lim = ctx.budget || {};                                  // the hub's: { triangles, cache (triangles kept), buildMs }
    var S = { budget: lim.triangles > 0 ? lim.triangles : BUDGET, farMax: FAR_MAX, cache: lim.cache > 0 ? Math.round(lim.cache / TRIS) : CACHE, buildMs: lim.buildMs > 0 ? Math.min(lim.buildMs, BUILD_MS) : BUILD_MS, built: [], held: 0, drawn: [], tris: 0, inst: 0, far: FAR_MAX, frame: 0, dirty: true, waiting: 0, gone: false,
              seen: new Float64Array(16), m4: new THREE.Matrix4(), pv: new THREE.Matrix4(), frustum: new THREE.Frustum(), box: new THREE.Box3() };
    var wake = function () { if (ctx.wake) ctx.wake(); };

    function make(t) {
      var B = buildTile(D, t.cx, t.cy);
      if (!B) { t.state = 2; t.n = 0; return; }
      // (each tile has its own copy of the dome's few vertices, so dropping a tile frees only what is its own)
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(stock.pos.slice(), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(stock.nor.slice(), 3));
      g.setIndex(new THREE.BufferAttribute(stock.idx.slice(), 1));
      g.setAttribute('aBushOp', new THREE.InstancedBufferAttribute(B.op, 1));
      var mesh = new THREE.InstancedMesh(g, mat, B.n);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(B.mat, 16);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(B.col, 3);
      mesh.name = 'brush-bushes-tile'; mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.visible = false;
      mesh.raycast = function () {};                             // taps go through the brush
      t.mesh = mesh; t.state = 1; t.n = B.n; t.box[2] = B.zmin; t.box[5] = B.zmax;
      group.add(mesh); S.built.push(t); S.held += B.n;
    }
    function drop(t) {
      if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); if (t.mesh.dispose) t.mesh.dispose(); t.mesh = null; S.held -= t.n; }
      t.state = 0; t.n = t.cells;
    }
    function trim() {
      if (S.held <= S.cache) return;
      S.built.sort(function (a, b) { return a.last - b.last; });
      var keep = [], i;
      for (i = 0; i < S.built.length; i++) { var t = S.built[i]; if (S.held > S.cache && t.last < S.frame) drop(t); else keep.push(t); }
      S.built = keep;
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
      for (;;) {
        sel = select(D, T, p, inView, S.budget, S.farMax);
        var t0 = Date.now(), did = 0;
        left = 0;
        for (i = 0; i < sel.draw.length; i++) {
          if (sel.draw[i].state) continue;
          if (!all && did && Date.now() - t0 >= S.buildMs) { left++; continue; }
          make(sel.draw[i]); did++; built++;
        }
        if (!all || !did) break;                                 // (all: once more, the counts are the real ones now)
      }
      S.frame++;
      for (i = 0; i < S.drawn.length; i++) if (S.drawn[i].mesh) S.drawn[i].mesh.visible = false;
      var drawn = [], tris = 0, inst = 0;
      for (i = 0; i < sel.draw.length; i++) { var t = sel.draw[i]; if (t.state !== 1) continue; t.mesh.visible = true; t.last = S.frame; drawn.push(t); tris += t.n * TRIS; inst += t.n; }
      S.drawn = drawn; S.tris = tris; S.inst = inst; S.far = sel.far; S.waiting = left;
      uFade.value.set(sel.far * (1 - FADE), sel.far, NEAR[0], NEAR[1]);
      // a tile just built has its real count, which may move `far`: one more look
      S.dirty = left > 0 || (built > 0 && !all);
      if (built) trim();
      if (S.dirty) wake();
    }

    return {
      group: group, material: mat,
      update: function (cam) { update(cam, false); },
      settle: function (cam) { S.dirty = true; update(cam, true); },
      setLevel: function (v) { v = Number(v); if (!isFinite(v)) return; uLevel.value = v < 0 ? 0 : v > 1 ? 1 : v; wake(); },
      // budget (triangles), the farthest bushes (m), the cache (bushes): for tests and for trying numbers
      limits: function (o) { if (o) { if (o.budget > 0) S.budget = o.budget; if (o.far > 0) S.farMax = o.far; if (o.cache > 0) S.cache = o.cache; S.dirty = true; wake(); } return { budget: S.budget, far: S.farMax, cache: S.cache }; },
      dispose: function () {
        S.gone = true;
        S.built.forEach(function (t) { if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); if (t.mesh.dispose) t.mesh.dispose(); t.mesh = null; } t.state = 0; });
        S.built = []; S.drawn = []; S.held = 0; S.tris = 0; S.inst = 0;
        mat.dispose();
        if (group.parent) group.parent.remove(group);
      },
      // { triangles, instances (drawn now), tiles drawn, far (m), level, waiting (tiles to build), built tiles, held bushes, cells, all tiles }
      stats: function () {
        return { triangles: S.tris, instances: S.inst, tiles: S.drawn.length, far: S.far, level: uLevel.value, waiting: S.dirty ? Math.max(1, S.waiting) : 0, built: S.built.length, held: S.held,
                 cells: T.cells, allTiles: T.list.length, budget: S.budget, trisPerBush: TRIS };
      },
    };
  }

  var R = { TILE: TILE, TRIS: TRIS, SIDES: SIDES, BUDGET: BUDGET, FAR_MAX: FAR_MAX, FADE: FADE, CACHE: CACHE, WIDTH: WIDTH, WIDTH2: WIDTH2, SIZE_VAR: SIZE_VAR, JITTER: JITTER, JITTER2: JITTER2,
            TINT_LO: TINT_LO, TINT_HI: TINT_HI, SINK: SINK, SLOPE_MAX: SLOPE_MAX, SINK_MAX: SINK_MAX, NEAR: NEAR, LOW: LOW, LOW_H: LOW_H, TALL_H: TALL_H, widthOf: widthOf, MERGE_DH: MERGE_DH, MERGE_DO: MERGE_DO,
            hash: hash, vary: vary, knots: knots, opacityOf: opacityOf, lut: lut, fade: fade, plan: plan, merges: merges, buildTile: buildTile, tiles: tiles, select: select, dome: dome, create: create };

  root.FlexBrushLooks = root.FlexBrushLooks || {};
  root.FlexBrushLooks.bushes = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
