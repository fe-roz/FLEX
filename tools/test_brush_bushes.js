// Test for the bushes look of the brush grid (viewer_build/libs/brush-bushes.js), without a browser.
//
// Loads the real three.js r128 the viewer ships and the module into one context, with made-up grids, then checks:
// it registers as FlexBrushLooks.bushes; which cells get a bush (the lightest class and up, 2 x 2 blocks of one
// kind as one bush, every brushy cell stood for once); the variation is the same every time and inside its
// limits; opacity from the share (nothing under the lightest class, solid from the densest, never going down);
// the distance fade; a tile's instances (on the ground, as tall as the cell, base on the slope, steep ground);
// the clumps that stand for the brush farther away (the pyramid of sums, a clump's size / height / opacity from
// its patch, the ground covered at every level, the rings and their hand-overs, no gaps, the classes);
// the choice of tiles per view and the triangle budget on a grid the size of a real map; the look's own
// interface (update returns at once with the camera still, lazy building asks for frames, the cache, the level,
// dispose). Synthetic numbers only.
//
//   node tools/test_brush_bushes.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let fail = 0, pass = 0;
function ok(label, cond, info) {
  if (cond) { pass++; return; }
  fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 500) : ''));
}
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

const ctx = { console: { warn() {}, log: console.log, error: console.error, info() {} }, Math, Promise, Date, window: {} };
ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'three.min.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'brush-bushes.js'), 'utf8'), ctx);
const THREE = ctx.THREE, B = ctx.window.FlexBrushLooks && ctx.window.FlexBrushLooks.bushes;
ok('registers as FlexBrushLooks.bushes with create()', !!B && typeof B.create === 'function');

const CLS = [{ name: 'light', min: 0.1, colour: 'b7e4a0' }, { name: 'medium', min: 0.3, colour: '5fae4f' }, { name: 'dense', min: 0.6, colour: '1f5f1f' }];
const byteOf = s => Math.ceil(s * 255);
function grid(nx, ny, fill) {
  const F = { nx, ny, cell: 0.9, x0: -nx * 0.45, y0: -ny * 0.45, top: 2.5, share: new Uint8Array(nx * ny), height: new Uint8Array(nx * ny) };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const v = fill(i, j); if (v) { F.share[j * nx + i] = byteOf(v[0]); F.height[j * nx + i] = Math.round(v[1] * 100); } }
  return F;
}

// ── the hash and the variation ──
{
  const a = [], b = [];
  for (let i = 0; i < 2000; i++) { a.push(JSON.stringify(B.vary(i, false))); b.push(JSON.stringify(B.vary(i, false))); }
  ok('variation: the same cell gives the same bush every time', a.join() === b.join());
  ok('variation: neighbours differ', new Set(a).size === 2000);
  ok('hash: whole numbers of 32 bits', [0, 1, 7, 123456, 7480000].every(i => { const h = B.hash(i, 3); return Number.isInteger(h) && h >= 0 && h < 4294967296; }));
  ok('hash: known values (the same on every device)', B.hash(0, 0) === B.hash(0, 0) && B.hash(1, 1) !== B.hash(1, 2) && B.hash(1, 1) !== B.hash(2, 1));
  let lo = { size: 9, tint: 9, dx: 9, oval: 9 }, hi = { size: -9, tint: -9, dx: -9, oval: -9 }, sum = 0, turnHi = 0;
  for (let i = 0; i < 20000; i++) { const v = B.vary(i * 7 + 1, false); for (const k in lo) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); } sum += v.size; turnHi = Math.max(turnHi, v.turn); if (Math.abs(v.dy) > B.JITTER) lo.bad = 1; }
  ok('variation: width within +-15 %, and using the range', lo.size >= 1 - B.SIZE_VAR && hi.size <= 1 + B.SIZE_VAR && lo.size < 0.87 && hi.size > 1.13, [lo.size, hi.size]);
  ok('variation: mean width is 1', near(sum / 20000, 1, 0.01), sum / 20000);
  ok('variation: place inside the jitter', lo.dx >= -B.JITTER && hi.dx <= B.JITTER && !lo.bad && lo.dx < -0.8 * B.JITTER && hi.dx > 0.8 * B.JITTER, [lo.dx, hi.dx]);
  ok('variation: tint inside its limits, slight', lo.tint >= B.TINT_LO && hi.tint <= B.TINT_HI && B.TINT_HI - B.TINT_LO <= 0.35, [lo.tint, hi.tint]);
  ok('variation: any turn', turnHi > 6 && turnHi < 2 * Math.PI);
  const m = B.vary(5, true);
  ok('variation: a 2 x 2 bush has its own jitter limit', Math.abs(m.dx) <= B.JITTER2 && Math.abs(m.dy) <= B.JITTER2);
}

// ── opacity from the share ──
{
  const K = B.knots(CLS), L = B.lut(K);
  ok('knots: lightest first, the densest solid', K.length === 3 && K[0].min === 0.1 && K[2].min === 0.6 && K[2].op === 1 && K[0].op < K[1].op && K[1].op < 1);
  ok('opacity: light is faint, medium about half, dense solid', K[0].op > 0.1 && K[0].op < 0.3 && K[1].op > 0.4 && K[1].op < 0.65, K);
  ok('opacity: nothing under the lightest class', B.opacityOf(0.05, K) === 0 && B.opacityOf(0.0999, K) === 0 && B.opacityOf(0, K) === 0);
  ok('opacity: at the class starts', near(B.opacityOf(0.1, K), K[0].op) && near(B.opacityOf(0.3, K), K[1].op) && B.opacityOf(0.6, K) === 1 && B.opacityOf(1, K) === 1);
  ok('opacity: straight between the starts', near(B.opacityOf(0.2, K), (K[0].op + K[1].op) / 2) && near(B.opacityOf(0.45, K), (K[1].op + 1) / 2));
  let mono = true; for (let s = 0.1; s < 1; s += 0.005) if (B.opacityOf(s + 0.005, K) < B.opacityOf(s, K) - 1e-12) mono = false;
  ok('opacity: never goes down with the share', mono);
  ok('lut: share byte 0 and bytes under the lightest class give no bush', L[0] === 0 && L[25] === 0 && L[26] > 0, [L[25], L[26]]);
  ok('lut: the top byte is solid, every brushy byte is drawn', L[255] === 255 && L[153] === 255 && Array.from(L.slice(26)).every(v => v > 0));
  const K1 = B.knots([{ min: 0.5, colour: '00ff00' }]);
  ok('one class: solid from its start', K1.length === 1 && B.opacityOf(0.5, K1) === 1 && B.opacityOf(0.49, K1) === 0);
  const K0 = B.knots(null);
  ok('no classes given: the usual three', K0.length === 3 && K0[0].min === 0.1 && K0[1].min === 0.3 && K0[2].min === 0.6);
  const Kc = B.knots([{ name: 'a', min: 0.2, colour: 'ff0000', cut: 51, rgb: [255, 0, 0] }, { name: 'b', min: 0.7, colour: '00ff00', cut: 179, rgb: [0, 255, 0] }]);
  ok('the hub\'s parsed classes are read (min)', Kc.length === 2 && Kc[0].min === 0.2 && B.opacityOf(0.15, Kc) === 0 && B.opacityOf(0.7, Kc) === 1);
}

// ── the distance fade ──
{
  const far = 200, a = far * (1 - B.FADE);
  ok('fade: whole in the middle distance', B.fade(B.NEAR[1], far) === 1 && B.fade(a, far) === 1 && B.fade(50, far) === 1);
  ok('fade: gone at far and beyond', B.fade(far, far) === 0 && B.fade(far + 50, far) === 0);
  ok('fade: half way through the band', near(B.fade((a + far) / 2, far), 0.5));
  let mono = true; for (let d = a; d < far; d += 0.5) if (B.fade(d + 0.5, far) > B.fade(d, far) + 1e-12) mono = false;
  ok('fade: only goes down with distance, no step', mono && B.fade(a + 0.5, far) > 0.99 && B.fade(far - 0.5, far) < 0.01);
  ok('fade: bushes at the eye are gone, whole from NEAR[1]', B.fade(0, far) === 0 && B.fade(B.NEAR[0], far) === 0 && B.fade((B.NEAR[0] + B.NEAR[1]) / 2, far) > 0.4 && B.fade((B.NEAR[0] + B.NEAR[1]) / 2, far) < 0.6);
  ok('limits: the budget is 900 k triangles, bushes whole to about 125 m and handed over by 180 m', B.BUDGET === 900000 && B.FAR_MAX * (1 - B.FADE) >= 120 && B.FAR_MAX <= 260);
}

// ── which cells get a bush ──
{
  const L = B.lut(B.knots(CLS));
  // a 6 x 6 grid: a solid 2 x 2 block of one kind at (0,0); a 2 x 2 block with one bare cell at (2,0); a 2 x 2 of
  // uneven heights at (4,0); a 2 x 2 of light and dense at (0,2); a share under the lightest class at (2,2);
  // a solid 2 x 2 on odd cells at (3,3) (not a block of the lattice)
  const cells = {};
  const put = (i, j, s, h) => { cells[i + ',' + j] = [s, h]; };
  [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([i, j]) => put(i, j, 0.8, 1.5));
  [[2, 0], [3, 0], [2, 1]].forEach(([i, j]) => put(i, j, 0.8, 1.5));
  put(4, 0, 0.8, 0.4); put(5, 0, 0.8, 2.4); put(4, 1, 0.8, 0.4); put(5, 1, 0.8, 2.4);
  put(0, 2, 0.12, 1); put(1, 2, 0.9, 1); put(0, 3, 0.12, 1); put(1, 3, 0.9, 1);
  put(2, 2, 0.05, 1);
  [[3, 3], [4, 3], [3, 4], [4, 4]].forEach(([i, j]) => put(i, j, 0.5, 1));
  const F = grid(6, 6, (i, j) => cells[i + ',' + j]);
  const got = [];
  const n = B.plan(F, L, 0, 0, (a, merged) => got.push([a % 6, Math.floor(a / 6), merged]));
  const has = (i, j, m) => got.some(g => g[0] === i && g[1] === j && g[2] === m);
  ok('plan: a solid 2 x 2 block of one kind is ONE bush', has(0, 0, true) && !has(1, 0, false) && !has(0, 1, false) && !has(1, 1, false), got);
  ok('plan: a block with a bare cell is three bushes', has(2, 0, false) && has(3, 0, false) && has(2, 1, false) && !has(3, 1, false) && !has(2, 0, true));
  ok('plan: uneven heights are not merged', has(4, 0, false) && has(5, 0, false) && has(4, 1, false) && has(5, 1, false));
  ok('plan: light and dense are not merged', has(0, 2, false) && has(1, 2, false) && has(0, 3, false) && has(1, 3, false));
  ok('plan: a share under the lightest class gets nothing', !got.some(g => g[0] === 2 && g[1] === 2));
  ok('plan: blocks are on even cells only', has(3, 3, false) && has(4, 3, false) && has(3, 4, false) && has(4, 4, false));
  ok('plan: the count is what it lists', n === got.length && n === 1 + 3 + 4 + 4 + 4, n);
  ok('plan: light cells get a bush too (all three classes)', has(0, 2, false));
  // every brushy cell is stood for exactly once, on a random grid
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const G = grid(70, 50, () => rnd() < 0.7 ? [0.05 + rnd() * 0.95, 0.3 + (rnd() < 0.6 ? 1.9 : rnd() * 2)] : null);
  const cover = new Uint8Array(70 * 50); let total = 0;
  for (let cy = 0; cy < 50; cy += B.TILE) for (let cx = 0; cx < 70; cx += B.TILE) total += B.plan(G, L, cx, cy, (a, m) => { cover[a]++; if (m) { cover[a + 1]++; cover[a + 70]++; cover[a + 71]++; } });
  let wrong = 0, brushy = 0; for (let a = 0; a < cover.length; a++) { const b = L[G.share[a]] ? 1 : 0; brushy += b; if (cover[a] !== b) wrong++; }
  ok('plan: every brushy cell is stood for once, bare cells never (across tile edges too)', wrong === 0 && brushy > 2000, { wrong, brushy });
  ok('plan: merging saves bushes', total < brushy && total > brushy / 4, { total, brushy });
  const T = B.tiles(G, L);
  ok('tiles: only tiles with brush, with their cells', T.tx === 3 && T.ty === 2 && T.cells === brushy && T.list.reduce((s, t) => s + t.cells, 0) === brushy);
  const E = B.tiles(grid(64, 64, (i, j) => i < 32 && j < 32 ? [0.5, 1] : null), L);
  ok('tiles: a bare tile is not there', E.list.length === 1 && E.at[0] && !E.at[1] && !E.at[2] && !E.at[3]);
}

// ── a tile's instances ──
{
  const L = B.lut(B.knots(CLS));
  const mk = (F, groundZ) => B.buildTile({ F, L, groundZ }, 0, 0);
  // single cells on flat ground at 100 m (a checkerboard, so nothing merges)
  const F = grid(8, 8, (i, j) => (i + j) & 1 ? null : [i < 4 ? 0.15 : 0.9, 0.5 + j * 0.25]);
  const T = mk(F, () => 100);
  ok('tile: one bush a brushy cell', T && T.n === 32, T && T.n);
  let okPlace = true, okTall = true, okWide = true, okFlat = true, okOp = true, okCol = true, k = 0;
  B.plan(F, L, 0, 0, a => {
    const i = a % 8, j = Math.floor(a / 8), m = T.mat.subarray(k * 16, k * 16 + 16), h = F.height[a] / 100;
    const cx = F.x0 + (i + 0.5) * F.cell, cy = F.y0 + (j + 0.5) * F.cell;
    if (Math.abs(m[12] - cx) > B.JITTER * F.cell + 1e-4 || Math.abs(m[13] - cy) > B.JITTER * F.cell + 1e-4) okPlace = false;
    if (!near(m[14], 100 - B.SINK, 1e-4) || !near(m[14] + m[10], 100 + h, 1e-4)) okTall = false;      // base sunk, top = ground + the cell's height
    const rx = Math.hypot(m[0], m[1]), ry = Math.hypot(m[4], m[5]), r = Math.sqrt(rx * ry);
    if (r < F.cell * 0.5 || r > F.cell * 1.15 || Math.abs(rx / ry - 1) > 0.25) okWide = false;          // about a cell wide, overlapping the neighbours
    if (m[2] !== 0 || m[6] !== 0 || m[15] !== 1 || m[3] !== 0 || m[7] !== 0 || m[11] !== 0) okFlat = false;
    if (!near(T.op[k], L[F.share[a]] / 255, 1e-6)) okOp = false;
    if (!(T.col[k * 3 + 1] > T.col[k * 3] && T.col[k * 3 + 1] > T.col[k * 3 + 2]) || T.col[k * 3 + 1] > 1) okCol = false;                // a green
    k++;
  });
  ok('tile: a bush is inside its cell\'s jitter', okPlace);
  ok('tile: base sunk SINK, top at the ground plus the cell\'s height', okTall);
  ok('tile: about a cell wide (overlapping), a slight oval', okWide);
  ok('tile: flat ground, no shear', okFlat);
  ok('tile: the opacity of each bush is its share\'s', okOp && T.op.some(o => o < 0.3) && T.op.some(o => o === 1));
  ok('tile: one family of greens, denser is darker', okCol && (() => { let l = 0, d = 0, nl = 0, nd = 0; for (let q = 0; q < T.n; q++) { if (T.op[q] < 0.3) { l += T.col[q * 3 + 1]; nl++; } else { d += T.col[q * 3 + 1]; nd++; } } return l / nl > d / nd; })());
  ok('tile: bounds hold the bushes', T.zmin <= 100 - B.SINK && T.zmax >= 100 + 2.25 && T.zmax < 104);
  const T2 = mk(F, () => 100);
  ok('tile: built the same every time', Buffer.from(T.mat.buffer).equals(Buffer.from(T2.mat.buffer)) && Buffer.from(T.col.buffer).equals(Buffer.from(T2.col.buffer)));
  // tall brush is wider than low brush
  ok('width: grows with the height, between its limits', B.widthOf(B.WIDTH, 0.3) === B.WIDTH[0] && B.widthOf(B.WIDTH, 2.5) === B.WIDTH[1] && B.widthOf(B.WIDTH, 1.5) > B.WIDTH[0] && B.widthOf(B.WIDTH, 1.5) < B.WIDTH[1] && B.WIDTH[0] > 0.5);
  // a merged block: one bush at the block's middle, wider, at the mean height and opacity
  const M = mk(grid(2, 2, (i, j) => [0.8, 1 + 0.2 * i]), () => 50);
  ok('merged: one bush for the block, at its middle, twice as wide, the mean height', M.n === 1 && Math.abs(M.mat[12]) <= B.JITTER2 * 0.9 + 1e-4 && Math.abs(M.mat[13]) <= B.JITTER2 * 0.9 + 1e-4 &&
    Math.hypot(M.mat[0], M.mat[1]) > 0.9 * 0.95 && near(M.mat[14] + M.mat[10], 50 + 1.1, 1e-4) && M.op[0] === 1, Array.from(M.mat));
  // height byte 0: the band's low edge
  const Z = B.buildTile({ F: Object.assign(grid(1, 1, () => [0.9, 0]), {}), L, groundZ: () => 0, low: 0.4 }, 0, 0);
  ok('a cell with no height is as tall as the band\'s low edge', near(Z.mat[14] + Z.mat[10], 0.4, 1e-4));
  // a 33 degree slope (rise / run 0.65) to the east: the base lies on it, the top is straight above the centre
  const s33 = 0.65, S = mk(F, (x) => 200 + s33 * x);
  let okShear = true, okFoot = true, okTop = true; k = 0;
  B.plan(F, L, 0, 0, a => {
    const m = S.mat.subarray(k * 16, k * 16 + 16), g = 200 + s33 * m[12], h = F.height[a] / 100;
    // the base ring's points: the dome's (u, v, 0) -> their height must be the ground's there, less the sink
    for (let q = 0; q < 8; q++) { const u = Math.cos(q), v = Math.sin(q), X = m[0] * u + m[4] * v, Zw = m[14] + m[2] * u + m[6] * v, gz = 200 + s33 * (m[12] + X); if (Math.abs(Zw - (gz - B.SINK)) > 2e-3) okShear = false; }
    if (!near(m[14], g - B.SINK, 2e-3)) okFoot = false;
    if (!near(m[14] + m[10], g + h, 2e-3) || m[8] !== 0 || m[9] !== 0) okTop = false;
    k++;
  });
  ok('33 degree slope: the whole base is on the ground (sunk SINK), nothing floats', okShear);
  ok('33 degree slope: the foot is at the ground of the bush\'s own centre', okFoot);
  ok('33 degree slope: the top is the ground plus the height, straight above the centre', okTop);
  // a near-cliff (rise / run 4): the base follows SLOPE_MAX only, and the bush is sunk more, never floating above the ground at its centre
  const C = mk(F, (x) => 300 + 4 * x);
  let okCliff = true, sunk = 0; k = 0;
  B.plan(F, L, 0, 0, a => {
    const m = C.mat.subarray(k * 16, k * 16 + 16), g = 300 + 4 * m[12], h = F.height[a] / 100, r = Math.hypot(m[0], m[1]);
    const shear = Math.hypot(m[2], m[6]) / r;                     // (close to the slope it follows; the oval makes it a little more or less)
    if (shear > B.SLOPE_MAX * 1.2 || shear < B.SLOPE_MAX * 0.8) okCliff = false;
    const sink = g - m[14];
    if (sink < B.SINK - 1e-3 || sink > B.SINK + h * B.SINK_MAX + 1e-3) okCliff = false;
    if (sink > B.SINK + 0.05) sunk++;
    if (!near(m[14] + m[10], g + h, 5e-3)) okCliff = false;       // the top still at the measured height
    k++;
  });
  ok('near-cliff: base follows SLOPE_MAX at most, sunk more (half the height at most), top at the height', okCliff && sunk === C.n, { sunk, n: C.n });
  // off the terrain: no bush
  const O = mk(F, (x) => x < 0 ? null : 10);
  ok('off the terrain (groundZ null): no bush there, the rest stand', O && O.n > 0 && O.n < 32 && O.mat.length === O.n * 16 && O.op.length === O.n, O && O.n);
  ok('all off the terrain: no tile', mk(F, () => null) === null && mk(F, () => NaN) === null);
  ok('a bare tile: nothing', mk(grid(8, 8, () => null), () => 0) === null);
  // the dome
  const d = B.dome();
  ok('dome: TRIS triangles, few vertices, unit size', d.idx.length / 3 === B.TRIS && d.pos.length / 3 <= 20 && B.TRIS <= 30 && Math.max(...d.pos) === 1);
  let zmin = 9, rmax = 0; for (let q = 0; q < d.pos.length; q += 3) { zmin = Math.min(zmin, d.pos[q + 2]); rmax = Math.max(rmax, Math.hypot(d.pos[q], d.pos[q + 1])); }
  ok('dome: from the base (0) to the top (1), radius 1', zmin === 0 && near(rmax, 1, 1e-6));
  let out = true; for (let q = 0; q < d.idx.length; q += 3) { const [a, b, c] = [d.idx[q] * 3, d.idx[q + 1] * 3, d.idx[q + 2] * 3]; const u = [0, 1, 2].map(z => d.pos[b + z] - d.pos[a + z]), v = [0, 1, 2].map(z => d.pos[c + z] - d.pos[a + z]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], m = [0, 1, 2].map(z => (d.pos[a + z] + d.pos[b + z] + d.pos[c + z]) / 3); if (n[0] * m[0] + n[1] * m[1] + n[2] * (m[2] - 0.4) <= 0) out = false; }
  ok('dome: every face looks outwards', out);
  let unitN = true; for (let q = 0; q < d.nor.length; q += 3) if (!near(Math.hypot(d.nor[q], d.nor[q + 1], d.nor[q + 2]), 1, 1e-5)) unitN = false;
  ok('dome: smooth unit normals', unitN && d.nor.length === d.pos.length);
}

// ── the choice of tiles and the budget, on a grid the size of a real map ──
const NX = 2391, NY = 3129;
let seedB = 99; const rndB = () => (seedB = (seedB * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const BIG = grid(NX, NY, (i, j) => {
  const patch = Math.sin(i * 0.011) * Math.cos(j * 0.013) + 0.4 * Math.sin(i * 0.07 + j * 0.05);
  if (patch < -0.25) return null;
  const r = rndB(); if (r < 0.25) return null;
  return [0.1 + 0.9 * rndB() * Math.min(1, patch + 0.6), r < 0.7 ? 2 + rndB() * 0.5 : 0.3 + rndB() * 1.7];
});
const hill = (x, y) => 800 + 0.2 * x + 60 * Math.sin(y / 300);
// brute force: the sums of the cells i0..i1, j0..j1 of a grid
function sums(F, L, i0, j0, s) {
  const o = { n: 0, w: 0, h: 0, h2: 0, x: 0, y: 0 };
  for (let j = j0; j < Math.min(F.ny, j0 + s); j++) for (let i = i0; i < Math.min(F.nx, i0 + s); i++) { const a = j * F.nx + i, c = L[F.share[a]]; if (!c) continue; const h = F.height[a] || 30; o.n++; o.w += c; o.h += h; o.h2 += h * h; o.x += c * (i - i0); o.y += c * (j - j0); }
  return o;
}
const same = (a, b) => a.n === b.n && a.w === b.w && a.h === b.h && a.h2 === b.h2 && a.x === b.x && a.y === b.y;
const LALL = B.lut(B.knots(CLS));

// ── clumps: the pyramid of sums ──
{
  let sd = 3; const rnd = () => (sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const G = grid(203, 151, (i, j) => rnd() < 0.45 ? [0.05 + 0.95 * rnd(), rnd() < 0.1 ? 0 : 0.3 + 2.2 * rnd()] : null);
  const P = B.pyramid(G, LALL), D = { F: G, L: LALL, P, groundZ: () => 0 };
  ok('pyramid: levels PYR .. LEVELS, a patch of level k is 2^k cells wide', B.PYR >= 2 && B.LEVELS >= 4 && P.lv[B.PYR].s === (1 << B.PYR) && P.lv[B.LEVELS].px === Math.ceil(203 / (1 << B.LEVELS)) && !P.ready);
  let steps = 0; while (!B.pyramidStep(P, 0) && steps < 1000) steps++;
  ok('pyramid: filled a slice of rows at a time', P.ready && steps >= 1, steps);
  const P2 = B.pyramid(G, LALL); B.pyramidStep(P2);
  let eq = true; for (let k = B.PYR; k <= B.LEVELS; k++) for (const f of ['n', 'w', 'h', 'h2', 'x', 'y']) if (Buffer.compare(Buffer.from(P.lv[k][f].buffer), Buffer.from(P2.lv[k][f].buffer))) eq = false;
  ok('pyramid: in slices or at once, the same numbers', eq);
  let bad = 0, seen = 0; const o = {};
  for (let k = 1; k <= B.LEVELS; k++) { const s = 1 << k; for (let pj = 0; pj < Math.ceil(151 / s); pj++) for (let pi = 0; pi < Math.ceil(203 / s); pi++) { seen++; if (!same(B.patchSums(D, k, pi, pj, o), sums(G, LALL, pi * s, pj * s, s))) bad++; } }
  ok('pyramid: every patch of every level has its cells\' sums (count, opacity, height, height squared, centre)', bad === 0 && seen > 9000, [bad, seen]);
  const tot = P.lv[B.LEVELS], cells = G.share.reduce((n, v) => n + (LALL[v] ? 1 : 0), 0);
  ok('pyramid: the coarsest level counts every brushy cell once', tot.n.reduce((a, b) => a + b, 0) === cells && cells > 5000);
  // the classes: a pyramid made with a class off has none of its cells
  const K = B.knots(CLS), Ld = B.mask(LALL, K, [false, false, true]), Pd = B.pyramid(G, Ld); B.pyramidStep(Pd);
  const dense = G.share.reduce((n, v) => n + (v >= byteOf(0.6) ? 1 : 0), 0);
  ok('classes: with light and medium off every level holds the dense cells only', dense > 0 && dense < cells && [B.PYR, B.LEVELS].every(k => Pd.lv[k].n.reduce((a, b) => a + b, 0) === dense));
  ok('pyramid: small (22 bytes a patch from level PYR up)', [B.PYR].every(k => P.lv[k].n.BYTES_PER_ELEMENT === 2 && P.lv[k].w.BYTES_PER_ELEMENT === 4));
}

// ── clumps: one clump from one patch ──
{
  const cell = 0.9, R1 = k => cell * (1 << k) * Math.sqrt(B.AREA / Math.PI);
  for (const k of [1, 2, 4]) {
    const s = 1 << k, G = grid(4 * s, 4 * s, () => [0.9, 2]), C = B.clumpOf(G, k, 1, 2, sums(G, LALL, s, 2 * s, s));
    const cx = G.x0 + (s + s / 2) * cell, cy = G.y0 + (2 * s + s / 2) * cell;
    ok('clump (level ' + k + '): a full dense patch is one solid clump at its centre, as tall as the brush, sized by the patch\'s area', C && near(C.op, 1) && near(C.h, 2) && near(C.r, R1(k), 1e-9) && C.cover === 1 &&
      Math.abs(C.x - cx) <= B.C_JITTER * s * cell + 1e-9 && Math.abs(C.y - cy) <= B.C_JITTER * s * cell + 1e-9, C);
  }
  { const k = 3, s = 8, G = grid(32, 32, (i, j) => i < 12 ? [0.3, 1] : null), o = sums(G, LALL, 8, 8, s), C = B.clumpOf(G, k, 1, 1, o), v = C.v;
    ok('clump: half a patch of brush: half the area, at the brushy half, the cells\' own opacity', o.n === 32 && near(C.r, R1(3) * Math.sqrt(0.5), 1e-9) && near(C.op, LALL[byteOf(0.3)] / 255, 1e-9) && near(C.h, 1) &&
      near(C.x - v.dx * s * cell, G.x0 + (8 + 2) * cell, 1e-9) && near(C.y - v.dy * s * cell, G.y0 + (8 + 4) * cell, 1e-9), C); }
  { const G = grid(16, 16, (i, j) => i < 8 ? [0.9, 0.5] : [0.11, 2.5]), o = sums(G, LALL, 0, 0, 16), C = B.clumpOf(G, 4, 0, 0, o), v = C.v;
    const x = C.x - v.dx * 16 * cell - G.x0;
    ok('clump: the centre leans to the denser cells, the opacity is the cells\' mean, the height above the mean (so far brush does not shrink)', x < 8 * cell - 1 && x > 4 * cell && C.op > 0.5 && C.op < 0.7 && C.h > 1.5 && C.h <= 2.5, [x, C.op, C.h]); }
  ok('clump: an empty patch has none', B.clumpOf(grid(8, 8, () => null), 2, 0, 0, { n: 0, w: 0, h: 0, h2: 0, x: 0, y: 0 }) === null);
  const a = JSON.stringify(B.clumpOf(grid(8, 8, () => [0.5, 1]), 2, 1, 1, sums(grid(8, 8, () => [0.5, 1]), LALL, 4, 4, 4)));
  ok('clump: the same patch gives the same clump every time', a === JSON.stringify(B.clumpOf(grid(8, 8, () => [0.5, 1]), 2, 1, 1, sums(grid(8, 8, () => [0.5, 1]), LALL, 4, 4, 4))));
  // opacity is the bushes' curve, continuous: more share, never less opaque
  let mono = true, last = 0; for (let sh = 0.1; sh <= 1; sh += 0.01) { const G = grid(4, 4, () => [sh, 1]), C = B.clumpOf(G, 2, 0, 0, sums(G, LALL, 0, 0, 4)); if (C.op < last - 1e-9 || Math.abs(C.op - last) > 0.05 && last) mono = false; last = C.op; }
  ok('clump: opacity follows the share without a step (the bushes\' curve)', mono && near(last, 1));
  const S = B.clumpSolid();
  ok('clump: a lighter solid than the bush (12 to 16 triangles), wide at the ground, unit height', B.C_TRIS === S.idx.length / 3 && B.C_TRIS >= 12 && B.C_TRIS <= 16 && B.C_TRIS < B.TRIS && Math.max(...S.pos.filter((v, i) => i % 3 === 2)) === 1 && Math.hypot(S.pos[0], S.pos[1]) === 1);
}

// ── clumps: the ground covered stays true at every level ──
{
  for (const cover of [0.1, 0.3, 0.5, 0.8]) {
    let sd = 17; const rnd = () => (sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    // brush in blobs, as on a real slope: the cover is the blobs' share of the ground
    const G = grid(512, 512, (i, j) => (Math.sin(i * 0.05) * Math.cos(j * 0.04) + (rnd() - 0.5) * 1.2) > 0.86 - 1.72 * cover * 1.02 + 0.5 - 0.5 ? [0.3 + 0.7 * rnd(), 1 + rnd()] : null);
    const P = B.pyramid(G, LALL); B.pyramidStep(P);
    const D = { F: G, L: LALL, P, groundZ: () => 0 }, cells = P.lv[B.LEVELS].n.reduce((a, b) => a + b, 0), o = {}, out = [];
    for (let k = 1; k <= B.LEVELS; k++) {
      const s = 1 << k; let area = 0, n = 0;
      for (let pj = 0; pj < 512 / s; pj++) for (let pi = 0; pi < 512 / s; pi++) { const C = B.clumpOf(G, k, pi, pj, B.patchSums(D, k, pi, pj, o)); if (C) { n++; area += Math.PI * C.r * C.r / B.AREA; } }
      out.push(+(area / (cells * 0.81)).toFixed(3));
    }
    ok('cover ' + Math.round(100 * cells / 262144) + ' %: the clumps of every level stand for the brushy ground (within 6 %)', out.every(v => v > 0.94 && v < 1.06), out);
  }
  // a patch with little brush: a clump now and then, by an ordered threshold over the patches
  let drawn = 0; for (let pj = 0; pj < 16; pj++) for (let pi = 0; pi < 16; pi++) if (B.clumpDrawn(13, 4, pi, pj)) drawn++;          // 13 of 256 cells: a quarter of CMIN
  ok('a patch under CMIN of brush has a clump in its share of the patches, evenly', B.CMIN === 0.2 && drawn === Math.round(256 * (13 / 256) / B.CMIN / 16) * 16 && B.clumpDrawn(52, 4, 3, 3) && !B.clumpDrawn(0, 4, 0, 0), drawn);
}

// ── the choice of tiles and the budget, on a grid the size of a real map ──
{
  const L = LALL, t0 = Date.now(), P = B.pyramid(BIG, L); B.pyramidStep(P); const tPyr = Date.now() - t0;
  const D = { F: BIG, L, groundZ: hill, P };
  const T = B.tiles(BIG, L), C = [null]; for (let k = 1; k <= B.LEVELS; k++) C.push(B.clumpTiles(D, k));
  const V = { T, C }, per = t => t.k ? B.C_TRIS : B.trisAt(t.d);                 // (bushes past LIGHT_FROM are the lighter dome, past FAR_FROM the simplest)
  ok('real size: over a million brushy cells in thousands of tiles', T.cells > 1e6 && T.list.length > 2000, { cells: T.cells, tiles: T.list.length });
  let bytes = 0; for (let k = B.PYR; k <= B.LEVELS; k++) bytes += P.lv[k].n.length * 22;
  ok('real size: the pyramid is made in well under a second and holds a few megabytes', tPyr < 1000 && bytes < 6e6, { tPyr, bytes });
  console.log('pyramid of a real-size grid: ' + tPyr + ' ms, ' + (bytes / 1048576).toFixed(1) + ' MB');
  // a tile's count before it is built: exact from PYR up, never fewer under it
  let exact = true, bound = true;
  for (const k of [1, 2, B.PYR, B.LEVELS]) for (const t of C[k].list.slice(0, 6).concat(C[k].list.slice(-3))) { const b = B.buildClumps(D, k, t.cx, t.cy), n = b ? b.n : 0; if (k >= B.PYR ? n !== t.n : n > t.n) (k >= B.PYR ? (exact = false) : (bound = false)); }
  ok('clump tiles: the count before building is exact from level PYR up, never fewer under it', exact && bound);
  ok('clump tiles: every level has all the map\'s brush (tiles of at most TILE_C patches, smaller at the coarse levels)', C.slice(1).every(c => c.list.length > 0 && c.size <= 257 * 0.9) && B.tileC(1) === B.TILE_C && B.tileC(B.LEVELS) < B.TILE_C);
  const all = () => true;
  const s0 = B.select(D, V, [0, 0, hill(0, 0) + 30], all, B.BUDGET);
  ok('select: looking all round, the budget holds', s0.tris <= B.BUDGET && s0.draw.length > 0, { tris: s0.tris, n: s0.draw.length });
  ok('select: the bushes near and every clump level beyond', [0, 1, 2, 3, 4, 5, 6].every(k => s0.draw.some(t => t.k === k)), s0.draw.map(t => t.k).join(''));
  ok('select: a heavy view takes a later step: the bushes reach less far than FAR_MAX, but not near nothing', s0.step > 0 && s0.far < B.FAR_MAX && s0.far > 50, [s0.step, s0.far]);
  ok('select: nearest first', s0.draw.every((t, i) => i === 0 || t.d >= s0.draw[i - 1].d));
  ok('select: the count is the tiles\' own', s0.tris === s0.draw.reduce((s, t) => s + t.n * per(t), 0));
  const sHigh = B.select(D, V, [0, 0, hill(0, 0) + 3200], all, B.BUDGET);
  ok('select: from high up the whole map is clumps of the coarse levels (no bushes), far inside the budget', sHigh.step === 0 && sHigh.draw.length > 0 && sHigh.draw.every(t => t.k >= 4) && sHigh.tris > 20000 && sHigh.tris < B.BUDGET / 2, [sHigh.draw.length, sHigh.tris]);
  { const lv = sHigh.draw.reduce((m, t) => m.add(t.k), new Set()), want = new Set(); for (const k of lv) for (const t of C[k].list) if (B.weight(sHigh.rings, k, Math.hypot(t.box[0] + t.box[3], t.box[1] + t.box[4]) / 2 + 3200) > 0.99) want.add(t);
    ok('…every tile of a level that is whole there is drawn (the whole map, at any distance)', want.size > 0 && [...want].every(t => sHigh.draw.includes(t)), want.size); }
  const sSky = B.select(D, V, [0, 0, hill(0, 0) + 30000], all, B.BUDGET);
  ok('select: from 30 km still the whole map, the coarsest level', sSky.draw.length === C[B.LEVELS].list.length && sSky.draw.every(t => t.k === B.LEVELS));
  const sOld = B.select(D, { T, C: null }, [0, 0, hill(0, 0) + 30], all, B.BUDGET), sOldHigh = B.select(D, { T, C: null }, [0, 0, hill(0, 0) + 3200], all, B.BUDGET);
  ok('select: before the pyramid is whole only the bushes are drawn (fading out at their reach)', sOld.draw.length > 0 && sOld.draw.every(t => t.k === 0) && sOldHigh.draw.length === 0 && B.fadeOf(sOld.rings, 0)[1] === sOld.far);
  const sOut = B.select(D, V, [0, 0, hill(0, 0) + 30], () => false, B.BUDGET);
  ok('select: tiles out of view are skipped', sOut.draw.length === 0);
  const half = b => b[0] >= 0;                                  // a view to the east
  const sE = B.select(D, V, [0, 0, hill(0, 0) + 30], half, B.BUDGET);
  ok('select: a narrower view is finer', sE.step < s0.step && sE.far > s0.far && sE.tris <= B.BUDGET && sE.draw.every(t => t.box[3] >= 0), { far: sE.far, all: s0.far });
  const sSmall = B.select(D, V, [0, 0, hill(0, 0) + 30], all, 300000);
  ok('select: a third of the budget: coarser, a shorter reach, still inside and still the whole map', sSmall.tris <= 300000 && sSmall.far < s0.far && sSmall.step > s0.step && [0, B.LEVELS].every(k => sSmall.draw.some(t => t.k === k)), { tris: sSmall.tris, far: sSmall.far });
  const sTiny = B.select(D, V, [0, 0, hill(0, 0) + 2], all, 1000);
  ok('select: a budget too small for anything: the last step, the bushes round the eye stay', sTiny.step === B.STEPS.length - 1 && sTiny.draw.some(t => t.k === 0 && t.d === 0) && sTiny.far < 30 && sTiny.far > 10, [sTiny.step, sTiny.far]);
  // the rings of every step: each level whole somewhere, hand-overs never overlapping, weights adding up to 1
  let ringsOk = true, sumOk = true;
  for (let st = 0; st < B.STEPS.length; st++) {
    const G = B.rings(st, B.FAR_MAX, B.LEVELS);
    for (let k = 0; k <= B.LEVELS; k++) { const f = B.fadeOf(G, k); if (!(f[0] < f[1] && f[2] < f[3] && f[3] <= f[0])) ringsOk = false; }
    for (let d = B.NEAR[1]; d < 12000; d *= 1.013) { let sum = 0, n = 0; for (let k = 0; k <= B.LEVELS; k++) { const w = B.weight(G, k, d); sum += w; if (w > 0) n++; } if (Math.abs(sum - 1) > 1e-9 || n > 2) sumOk = false; }
  }
  ok('rings: at every step each level is whole over some distance and the hand-overs never overlap', ringsOk && B.STEPS.length > 10 && B.STEPS[0][0] === 1 && B.STEPS[0][1] === 1);
  ok('rings: at every distance one level is drawn, or two that add up to 1 (no gap, no double cover)', sumOk);
  { const G = B.rings(0, B.FAR_MAX, B.LEVELS), d1k = [3, 4].map(k => B.weight(G, k, 1000)), size = k => 0.9 * (1 << k);
    ok('rings: from 1 km the brush is clumps of 7 to 14 m patches', near(d1k[0] + d1k[1], 1, 1e-9) && size(3) > 7 && size(4) < 15 && G.R[1] === B.FAR_MAX, d1k); }
  // no gaps on the ground: wherever a level has weight, the tile with that ground in it is drawn
  let gaps = 0, asked = 0;
  for (const cam of [[0, 0, hill(0, 0) + 30], [300, -500, hill(300, -500) + 400], [-600, 800, hill(-600, 800) + 1500]]) {
    const sel = B.select(D, V, cam, all, B.BUDGET), drawn = new Set(sel.draw);
    for (let q = 0; q < 4000; q++) {
      const x = BIG.x0 + rndB() * NX * 0.9, y = BIG.y0 + rndB() * NY * 0.9, d = Math.hypot(x - cam[0], y - cam[1], hill(x, y) - cam[2]);
      for (let k = 0; k <= B.LEVELS; k++) { if (B.weight(sel.rings, k, d) <= 0) continue; const TT = k ? C[k] : T, t = TT.at[Math.floor((y - BIG.y0) / TT.size) * TT.tx + Math.floor((x - BIG.x0) / TT.size)]; asked++; if (t && !drawn.has(t)) gaps++; }
    }
  }
  ok('select: no gaps: wherever a level is drawn at all, its tile there is in the view (12 000 places, three eyes)', gaps === 0 && asked > 12000, [gaps, asked]);
  // the step does not go to and fro: from the step before, a finer one is taken only with room to spare
  const sAgain = B.select(D, V, [0, 0, hill(0, 0) + 30], all, B.BUDGET, { prev: s0.step }), sFrom = B.select(D, V, [0, 0, hill(0, 0) + 30], all, B.BUDGET, { prev: B.STEPS.length - 1 });
  ok('select: the same view from the step before stays on it; from a coarse step it comes back to within a step or two', sAgain.step === s0.step && sFrom.step >= s0.step && sFrom.step <= s0.step + 3 && sFrom.tris <= B.BUDGET, [s0.step, sAgain.step, sFrom.step]);
  // moving a metre moves the reach by little (no pop of the rings)
  let jump = 0, prev = s0.step; for (let x = 0; x < 40; x += 1) { const a = B.select(D, V, [x, 0, hill(x, 0) + 30], all, B.BUDGET, { prev }), b = B.select(D, V, [x + 1, 0, hill(x + 1, 0) + 30], all, B.BUDGET, { prev: a.step }); prev = b.step; jump = Math.max(jump, Math.abs(a.far - b.far)); }
  ok('select: a metre\'s move changes the reach by a few metres at most', jump < 12, jump);
  // every camera place of a walk across the map stays inside the budget
  let worst = 0, least = 1e9; prev = 0; for (let q = 0; q < 60; q++) { const x = BIG.x0 + rndB() * NX * 0.9, y = BIG.y0 + rndB() * NY * 0.9, s = B.select(D, V, [x, y, hill(x, y) + 2 + rndB() * 150], all, B.BUDGET, { prev }); prev = s.step; worst = Math.max(worst, s.tris); least = Math.min(least, s.far); }
  ok('select: 60 places over the map, all inside the budget, the bushes always there', worst <= B.BUDGET && worst > 0 && least > 50, [worst, least]);
  // a clump tile: on the ground, the same every time
  const tk = C[3].list[Math.floor(C[3].list.length / 2)], b1 = B.buildClumps(D, 3, tk.cx, tk.cy), b2 = B.buildClumps(D, 3, tk.cx, tk.cy);
  ok('clump tile: deterministic', b1 && Buffer.compare(Buffer.from(b1.mat.buffer), Buffer.from(b2.mat.buffer)) === 0 && Buffer.compare(Buffer.from(b1.col.buffer), Buffer.from(b2.col.buffer)) === 0 && Buffer.compare(Buffer.from(b1.op.buffer), Buffer.from(b2.op.buffer)) === 0);
  let off = 0, low = 0, wide = 0;
  for (let i = 0; i < b1.n; i++) { const m = b1.mat.subarray(i * 16, i * 16 + 16), g = hill(m[12], m[13]), top = m[14] + m[10], r = Math.hypot(m[0], m[1]); if (m[14] > g - B.SINK + 1e-3) off++; if (top < g + 0.25 || top > g + 2.6 + 1e-3) low++; if (r < 0.9 * 8 * 0.24 || r > 0.9 * 8 * 1.4) wide++; }
  ok('clump tile: every clump\'s base is in the ground, its top the brush\'s height above it, its width its patch\'s', off === 0 && low === 0 && wide === 0 && b1.n > 50, [off, low, wide, b1.n]);
  const slope = (() => { const m = b1.mat; return [m[2] / Math.hypot(m[0], m[1]), m[6] / Math.hypot(m[4], m[5])]; })();
  ok('clump tile: the base follows the slope (the hill rises 0.2 to the east)', Math.abs(Math.hypot(slope[0], slope[1]) - Math.hypot(0.2, 60 / 300 * Math.cos(b1.mat[13] / 300))) < 0.03, slope);
}

// ── the look itself (three.js objects, no GPU) ──
{
  const camera = new THREE.PerspectiveCamera(55, 16 / 10, 1, 60000); camera.up.set(0, 0, 1);
  const lookAt = (from, to) => { camera.position.set(from[0], from[1], from[2]); camera.lookAt(to[0], to[1], to[2]); camera.updateMatrixWorld(); camera.updateProjectionMatrix(); };
  let wakes = 0, calls = 0;
  const groundZ = (x, y) => { calls++; return hill(x, y); };
  const mkCtx = (extra) => Object.assign({ THREE, grid: BIG, classes: CLS.map(c => Object.assign({ cut: byteOf(c.min), rgb: [0, 0, 0] }, c)), groundZ, toScene: (x, y, z) => new THREE.Vector3(x, y, z), camera, wake: () => { wakes++; },
    bayer4: () => 0, dither: null, budget: { triangles: 900000, cache: 3000000, buildMs: 6 } }, extra || {});
  const t0 = Date.now(), look = B.create(mkCtx()), tCreate = Date.now() - t0;
  ok('look: has the hub\'s interface', look && look.group && look.group.isObject3D && ['update', 'setLevel', 'dispose', 'stats', 'settle'].every(k => typeof look[k] === 'function'));
  ok('look: create is quick and builds nothing (lazy)', tCreate < 1500 && look.group.children.length === 0 && look.stats().instances === 0, tCreate);
  const scene = new THREE.Scene(); look.setLevel(0.5); scene.add(look.group);
  ok('look: the level right after create', look.stats().level === 0.5);
  lookAt([0, -60, hill(0, -60) + 25], [0, 0, hill(0, 0)]);
  wakes = 0; look.update(camera);
  let s = look.stats();
  ok('look: the first frame builds some tiles and asks for another', s.instances > 0 && s.waiting > 0 && wakes > 0 && s.built > 0, s);
  let frames = 1; while (look.stats().waiting && frames < 400) { look.update(camera); frames++; }
  s = look.stats();
  ok('look: building ends, over frames', !s.waiting && frames > 2 && frames < 400, { frames, s });
  ok('look: triangles inside the budget, counted from the instances of every level (bushes and clumps)', s.triangles <= 900000 && s.triangles === s.levels.reduce((n, l) => n + l.triangles, 0) && s.levels.every((l, k) => k ? l.triangles === l.instances * B.C_TRIS : l.triangles > l.instances * B.C_TRIS && l.triangles < l.instances * B.TRIS) && s.triangles > 300000 && s.levels.length === B.LEVELS + 1 && s.levels.every(l => l.instances > 0) && s.pyramid.ready, s);
  ok('look: every drawn tile is an instanced mesh in the group, others hidden', look.group.children.filter(m => m.visible).length === s.tiles && look.group.children.every(m => m.isInstancedMesh && !m.frustumCulled));
  const vis = look.group.children.filter(m => m.visible);
  ok('look: instances carry matrix, colour and opacity', vis.every(m => m.instanceMatrix.count === m.count && m.instanceColor.count === m.count && m.geometry.attributes.aBushOp.count === m.count && m.geometry.attributes.aBushOp.isInstancedBufferAttribute));
  { const l0 = look.group.children.filter(m => m.visible && m.userData.level === 0), tri = m => m.geometry.index.count / 3, L = B.lightDome(), Dm = B.dome();
    ok('look: bushes in the tiles round the eye are the full dome, farther ones the same dome with fewer faces', l0.some(m => tri(m) === B.TRIS) && l0.some(m => tri(m) === B.C_TRIS) && l0.every(m => tri(m) === B.TRIS || tri(m) === B.C_TRIS || tri(m) === B.FAR_TRIS) && B.LIGHT_FROM >= 40);
    const rmax = S => { let r = 0, z = 0; for (let i = 0; i < S.pos.length; i += 3) { r = Math.max(r, Math.hypot(S.pos[i], S.pos[i + 1])); z = Math.max(z, S.pos[i + 2]); } return [r, z]; };
    ok('look: …of the same width and height', rmax(L).join() === rmax(Dm).join() && L.idx.length / 3 === B.C_TRIS); }
  ok('look: taps go through', (() => { const hits = []; vis[0].raycast(new THREE.Raycaster(), hits); return hits.length === 0; })());
  // idle: nothing happens
  wakes = 0; calls = 0; const before = look.group.children.length;
  for (let i = 0; i < 50; i++) look.update(camera);
  ok('look: camera still: update returns at once (no ground asked, no frame asked, nothing built)', wakes === 0 && calls === 0 && look.group.children.length === before);
  // the level is a uniform: nothing rebuilt
  wakes = 0; look.setLevel(1);
  ok('look: the level changes at once, asks one frame, rebuilds nothing', look.stats().level === 1 && wakes === 1 && look.group.children.length === before && calls === 0);
  look.setLevel(7); ok('look: the level is kept inside 0..1', look.stats().level === 1); look.setLevel(-1); ok('look: level 0', look.stats().level === 0); look.setLevel(NaN); ok('look: a bad level is ignored', look.stats().level === 0); look.setLevel(1);
  // the shader: the level, the fade and the per-bush opacity go into the dither
  const sh = { uniforms: {}, vertexShader: 'void main() {\n#include <defaultnormal_vertex>\n#include <project_vertex>\n}', fragmentShader: 'void main() {\n#include <clipping_planes_fragment>\n}' };
  look.material.onBeforeCompile(sh);
  ok('shader: level and fade are uniforms, the opacity an attribute', sh.uniforms.uBushLevel.value === 1 && sh.uniforms.uBushFade.value.y === look.stats().far && near(sh.uniforms.uBushFade.value.x, look.stats().far * (1 - B.FADE), 1e-6) &&
    /attribute float aBushOp/.test(sh.vertexShader) && /aBushOp \* uBushLevel/.test(sh.vertexShader) && /smoothstep\(uBushFade\.x, uBushFade\.y/.test(sh.vertexShader));
  ok('shader: ordered dither discard, no blending', /bushB = flexBayer4\(gl_FragCoord\.xy\)/.test(sh.fragmentShader) && /bushB \+ 0\.03125 > vBushOp\) discard/.test(sh.fragmentShader) && look.material.transparent === false && look.material.depthWrite === true);
  // the hand-over between levels: each level its own fade, every other level the dither turned over
  { const st = look.stats(), M = look.materials, U = M.map(m => { const q = { uniforms: {}, vertexShader: sh.vertexShader, fragmentShader: sh.fragmentShader }; m.onBeforeCompile(q); return q.uniforms; });
    ok('shader: a material a level, the same program (one onBeforeCompile text), the level shared', M.length === B.LEVELS + 1 && M.every(m => String(m.onBeforeCompile) === String(M[0].onBeforeCompile)) && U.every(u => u.uBushLevel === U[0].uBushLevel));
    ok('shader: every other level draws the pixels the level before leaves (the dither turned over)', U.every((u, k) => u.uBushInv.value === (k & 1)) && /if \(uBushInv > 0\.5\) bushB = 0\.9375 - bushB/.test(sh.fragmentShader));
    ok('shader: each level fades in exactly where the one before fades out', U.every((u, k) => k === 0 || (u.uBushFade.value.z === U[k - 1].uBushFade.value.x && u.uBushFade.value.w === U[k - 1].uBushFade.value.y)) && U[B.LEVELS].uBushFade.value.x >= 1e9 && st.rings[0] === Math.round(st.far), U.map(u => u.uBushFade.value.toArray().map(Math.round).join('/')));
    ok('shader: clumps are lit as round bushes, not as the flat solids they are', U[0].uBushRound.value === 0 && U[1].uBushRound.value === 1 && /uBushRound > 0\.5/.test(sh.vertexShader)); }
  ok('shader: does not use cameraPosition (a Lambert material is not given it)', !/cameraPosition\b(?!\))/.test(sh.vertexShader.replace(/\/\/[^\n]*/g, '')));
  // the same dither as the trees
  const FT = (() => { const c2 = { console, Math, Promise, Date, window: {} }; c2.globalThis = c2; vm.createContext(c2); vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'trees.js'), 'utf8'), c2); return c2.window.FlexTrees; })();
  const shT = { uniforms: {}, fragmentShader: 'void main() {\n#include <clipping_planes_fragment>\n}' }; FT.dither({}, { value: 1 }).onBeforeCompile(shT);
  const fn = s => (s.match(/float flexBayer2[^\n]*\n\s*float flexBayer4[^\n]*/) || [''])[0].replace(/\s+/g, ' ');
  ok('shader: the same pattern as the trees\' dither', fn(sh.fragmentShader).length > 50 && fn(sh.fragmentShader) === fn(shT.fragmentShader));
  // a move: a new choice, old tiles hidden, still inside the budget
  lookAt([400, 300, hill(400, 300) + 25], [400, 360, hill(400, 360)]);
  look.settle(camera); s = look.stats();
  ok('look: settle builds all a view wants at once', !s.waiting && s.triangles <= 900000 && s.instances > 0 && look.group.children.filter(m => m.visible).length === s.tiles, s);
  // from high up: nothing drawn, nothing waiting
  lookAt([0, 0, hill(0, 0) + 3000], [0, 1, hill(0, 0)]);
  look.update(camera); s = look.stats();
  look.settle(camera); s = look.stats();
  ok('look: far above the ground the whole map is drawn as clumps (no bushes), nothing waiting', s.levels[0].instances === 0 && s.instances > 2000 && s.triangles === s.instances * B.C_TRIS && s.triangles < 450000 && !s.waiting && s.step === 0 && look.group.children.filter(m => m.visible).every(m => m.userData.level >= 4), s);
  wakes = 0; calls = 0; for (let i = 0; i < 20; i++) look.update(camera);
  ok('look: …and then nothing happens (idle)', wakes === 0 && calls === 0);
  // the cache: a walk across the map never holds more than the cap (plus what is drawn now)
  let held = 0, worst = 0;
  for (let q = 0; q < 30; q++) { const x = BIG.x0 + 100 + q * 60, y = BIG.y0 + 200 + q * 80; lookAt([x, y, hill(x, y) + 20], [x + 30, y + 40, hill(x + 30, y + 40)]); look.settle(camera); const st = look.stats(); held = Math.max(held, st.held); worst = Math.max(worst, st.triangles); }
  const cap = Math.round(3000000 / B.TRIS);
  ok('look: the cache is capped (bushes and clumps held)', held <= cap + 900000 / B.C_TRIS && held > 0 && look.stats().built === look.group.children.length, { held, cap });
  ok('look: the walk stays inside the budget', worst <= 900000, worst);
  // limits can be set (a smaller budget, a shorter reach)
  look.limits({ budget: 150000 }); look.settle(camera);
  ok('look: a smaller budget is kept', look.stats().triangles <= 150000 && look.stats().budget === 150000, look.stats());
  // ── the detail steps (the hub's: a longer reach, a larger budget) and the simpler bush far away (always on) ──
  { const Dm = B.dome(), Fd = B.farDome(), Ld = B.lightDome();
    const dims = S => { let r = 0, z = 0, base = 0; for (let i = 0; i < S.pos.length; i += 3) { const q = Math.hypot(S.pos[i], S.pos[i + 1]); r = Math.max(r, q); z = Math.max(z, S.pos[i + 2]); if (S.pos[i + 2] === 0) base = Math.max(base, q); } return [r, z, base]; };
    const unitN = S => { for (let i = 0; i < S.nor.length; i += 3) if (Math.abs(Math.hypot(S.nor[i], S.nor[i + 1], S.nor[i + 2]) - 1) > 1e-5) return false; return true; };
    ok('far bush: 9 triangles, 7 vertices', B.FAR_TRIS === 9 && Fd.idx.length / 3 === 9 && Fd.pos.length / 3 === 7 && B.FAR_TRIS < B.C_TRIS && B.C_TRIS === 15 && B.TRIS === 25);
    ok('far bush: the outline of the same low dome (as tall, as wide within 6 %, widest above the ground, a point on top)', dims(Fd)[1] === dims(Dm)[1] && Math.abs(dims(Fd)[0] - dims(Dm)[0]) <= 0.06 && dims(Fd)[2] < dims(Fd)[0] && dims(Fd)[2] > 0.8, [dims(Fd), dims(Dm), dims(Ld)]);
    ok('far bush: smooth unit normals; its foot leans under no more than the full dome\'s', unitN(Fd) && unitN(Ld) && Fd.nor[2] >= Dm.nor[2] - 0.05 && Fd.nor[Fd.nor.length - 1] === 1, [Fd.nor[2], Dm.nor[2]]);
    // lit from above and from the side, the mean shade of the solids stays close: no pop of brightness at the change
    const shade = (S, l) => { let a = 0, n = 0; for (let i = 0; i < S.idx.length; i += 3) for (let j = 0; j < 3; j++) { const o = S.idx[i + j] * 3; a += Math.max(0, S.nor[o] * l[0] + S.nor[o + 1] * l[1] + S.nor[o + 2] * l[2]); n++; } return a / n; };
    const lights = [[0, 0, 1], [0.6, 0, 0.8], [0, 0.6, 0.8], [-0.5, -0.5, 0.707]], dS = lights.map(l => Math.abs(shade(Fd, l) - shade(Ld, l)));
    ok('far bush: lit like the lighter dome (mean shade within 0.08 from four lights)', dS.every(d => d < 0.08), dS);
    ok('which solid: the dome to LIGHT_FROM, the lighter one to FAR_FROM (150 m), the simplest beyond; an old "simple off" argument changes nothing',
      B.FAR_FROM === 150 && B.solidAt(10) === 0 && B.solidAt(B.LIGHT_FROM + 1) === 1 && B.solidAt(150) === 1 && B.solidAt(151) === 2 && B.solidAt(151, false) === 2 && B.solidAt(5000, false) === 2 &&
      B.trisAt(10) === B.TRIS && B.trisAt(100) === B.C_TRIS && B.trisAt(400) === B.FAR_TRIS && B.trisAt(400, false) === B.FAR_TRIS);
    // the whole chain follows the reach: every ring and every hand-over is the reach times a number
    for (const st of [0, 7, 20, B.STEPS.length - 1]) {
      const G1 = B.rings(st, 180, B.LEVELS), G2 = B.rings(st, 360, B.LEVELS), G3 = B.rings(st, 600, B.LEVELS);
      const lin = (Ga, Gb, x) => Ga.R.slice(0, -1).every((r, k) => near(Gb.R[k], r * x, 1e-6)) && Ga.B.every((b, k) => near(Gb.B[k], b, 1e-12));
      const fades = [1, 2, 3, 4, 5].every(k => B.fadeOf(G1, k).every((f, i) => near(B.fadeOf(G2, k)[i], f * 2, 1e-6)));
      const f0 = B.fadeOf(G1, 0), f0b = B.fadeOf(G2, 0);
      ok('rings, step ' + st + ': twice the reach is twice every ring, the same hand-over shares; the fade near the eye stays', lin(G1, G2, 2) && lin(G1, G3, 600 / 180) && fades && near(f0b[0], f0[0] * 2, 1e-6) && near(f0b[1], f0[1] * 2, 1e-6) && f0b[2] === B.NEAR[0] && f0b[3] === B.NEAR[1], [G1.R, G2.R]);
      let worstSum = 0; for (let d = 12; d < 30000; d *= 1.05) { let sum = 0; for (let k = 0; k <= B.LEVELS; k++) sum += B.weight(G3, k, d); worstSum = Math.max(worstSum, Math.abs(sum - 1)); }
      ok('rings, step ' + st + ', reach 600 m: at every distance the levels add up to one (no gap, no double)', worstSum < 1e-9, worstSum);
    }
  }
  { // a look with the hub's "far" numbers: the bushes reach farther in the same view, inside the larger budget
    const from = [0, -60, hill(0, -60) + 25], to = [0, 0, hill(0, 0)];
    const nrm = B.create(mkCtx()); lookAt(from, to); nrm.settle(camera); const sN = nrm.stats();
    const farL = B.create(mkCtx({ budget: { triangles: 1800000, cache: 6000000, buildMs: 6, far: 360 } })); farL.settle(camera); const sF = farL.stats();
    ok('look: the reach and the budget are the hub\'s (far: 360 m, 1.8 M)', sF.farMax === 360 && sF.budget === 1800000 && sN.farMax === B.FAR_MAX && sN.budget === 900000 && farL.limits().cache === Math.round(6000000 / B.TRIS), [sF.farMax, sF.budget]);
    ok('look: …the single bushes reach farther in the same view, and more of them are drawn', sF.far > sN.far * 1.3 && sF.far <= 360 && sF.levels[0].instances > sN.levels[0].instances * 1.5 && sF.triangles <= 1800000 && sF.triangles > sN.triangles, { far: [sN.far, sF.far], n: [sN.levels[0].instances, sF.levels[0].instances], tris: [sN.triangles, sF.triangles] });
    const tri = m => m.geometry.index.count / 3, l0 = L => L.group.children.filter(m => m.visible && m.userData.level === 0);
    ok('look: …tiles past 150 m are the 9-triangle bush, nearer ones are not', !('simple' in sF) && sF.trisPerFar === 9 && l0(farL).some(m => tri(m) === B.FAR_TRIS) && l0(farL).some(m => tri(m) === B.C_TRIS) && l0(farL).some(m => tri(m) === B.TRIS));
    // the switch is gone: an older caller's limits({ simple: false }) or budget.simple: false changes nothing
    const built = sF.built, held = sF.held;
    const r = farL.limits({ simple: false }); farL.settle(camera);
    ok('limits({ simple: false }) is ignored: the 9-triangle bush stays, nothing built again, the same triangles', !('simple' in r) && farL.stats().built === built && farL.stats().held === held && farL.stats().triangles === sF.triangles && l0(farL).some(m => tri(m) === B.FAR_TRIS));
    const off = B.create(mkCtx({ budget: { triangles: 1800000, cache: 6000000, buildMs: 6, far: 360, simple: false } })); off.settle(camera);
    ok('look: created with an old "simple: false": the 9-triangle bush all the same, as the look beside it', off.stats().triangles === sF.triangles && l0(off).some(m => tri(m) === B.FAR_TRIS), [off.stats().triangles, sF.triangles]);
    off.dispose();
    // a step taken while the look is on: at once, from the next frame
    wakes = 0; const r2 = nrm.limits({ budget: 3000000, far: 600, cacheTris: 9900000 });
    ok('limits({ budget, far, cacheTris }): kept, a frame asked for', r2.budget === 3000000 && r2.far === 600 && r2.cache === Math.round(9900000 / B.TRIS) && wakes > 0);
    nrm.settle(camera); const sV = nrm.stats();
    ok('…"very far": farther again, inside 3 M', sV.far > sF.far && sV.far <= 600 && sV.triangles <= 3000000 && sV.levels[0].instances > sF.levels[0].instances, { far: sV.far, tris: sV.triangles });
    nrm.limits({ budget: 900000, far: 180, cacheTris: 3000000 }); nrm.settle(camera); const sB = nrm.stats();
    ok('…and back to normal: the first picture again, the cache let go down to its cap', sB.triangles === sN.triangles && sB.far === sN.far && sB.held <= Math.round(3000000 / B.TRIS) + sB.instances, { tris: [sN.triangles, sB.triangles], held: sB.held });
    nrm.dispose(); farL.dispose();
  }
  // the hub's budget is taken
  const small = B.create(mkCtx({ budget: { triangles: 200000, cache: 600000, buildMs: 6 } }));
  lookAt([0, -60, hill(0, -60) + 25], [0, 0, hill(0, 0)]); small.settle(camera);
  ok('look: the hub\'s budget is the budget', small.stats().budget === 200000 && small.stats().triangles <= 200000 && small.stats().triangles > 0, small.stats());
  small.dispose();
  // a hidden group does no work
  look.group.visible = false; calls = 0; lookAt([10, 10, hill(10, 10) + 20], [40, 40, hill(40, 40)]); look.update(camera);
  ok('look: hidden (the chip off): update does nothing', calls === 0);
  look.group.visible = true;
  // dispose
  let disposed = 0; look.group.children.forEach(m => m.geometry.addEventListener('dispose', () => { disposed++; }));
  const n = look.group.children.length; scene.remove(look.group); look.dispose();
  ok('look: dispose frees every tile', n > 0 && disposed === n && look.group.children.length === 0 && look.stats().instances === 0);
  wakes = 0; look.update(camera); ok('look: after dispose update does nothing', wakes === 0 && look.group.children.length === 0);
  // a grid with no brush at all
  const none = B.create(mkCtx({ grid: grid(40, 40, () => null) }));
  lookAt([0, -20, hill(0, -20) + 10], [0, 0, hill(0, 0)]); none.update(camera);
  ok('look: a grid with no brush draws nothing and waits for nothing', none.stats().instances === 0 && !none.stats().waiting && none.group.children.length === 0);
  // a tile's own geometry: dropping one tile must not free another's (no shared buffers)
  const two = B.create(mkCtx()); lookAt([0, -60, hill(0, -60) + 25], [0, 0, hill(0, 0)]); two.settle(camera);
  const g = two.group.children;
  ok('look: tiles share no buffers', g.length > 1 && g[0].geometry.attributes.position !== g[1].geometry.attributes.position && g[0].geometry.index !== g[1].geometry.index && g.filter(m => m.userData.level === 0).every(m => m.material === two.materials[0]) && g.filter(m => m.userData.level === 2).every(m => m.material === two.materials[2] && m.geometry.index.count === B.C_TRIS * 3) && two.materials[0] !== two.materials[2]);
  two.dispose();
  // the classes shown (the Light / Medium / Dense chips)
  const K3 = B.knots([{ min: 0.1 }, { min: 0.3 }, { min: 0.6 }]), L3 = B.lut(K3), Lm = B.mask(L3, K3, [true, false, true]);
  ok('mask: the bytes of a class that is off have no opacity, the others keep theirs', Lm[26] === L3[26] && Lm[76] === L3[76] && Lm[77] === 0 && Lm[152] === 0 && Lm[153] === L3[153] && Lm[255] === L3[255] && Lm[25] === 0 && B.mask(L3, K3, undefined) === L3);
  const cl = B.create(mkCtx()); lookAt([0, -60, hill(0, -60) + 25], [0, 0, hill(0, 0)]); cl.settle(camera);
  const nAll = cl.stats().instances, cAll = cl.stats().cells; cl.lvAll = cl.stats().levels.map(l => l.instances);
  cl.setClasses([false, false, true]); cl.settle(camera);
  const nDense = cl.stats().instances, cDense = cl.stats().cells;
  const lvAll = cl.lvAll, lvDense = cl.stats().levels.map(l => l.instances);
  ok('look: setClasses takes the bushes of the classes that are off away (dense only: fewer, not none)', nAll > 0 && nDense > 0 && nDense < nAll && cDense < cAll && cl.stats().classesOn.join() === 'false,false,true', [nAll, nDense, cAll, cDense]);
  ok('look: …at every level (the clumps are made of the classes that are on)', lvDense.slice(0, 6).every(n => n > 0) && lvDense[0] < lvAll[0], [lvAll, lvDense]);
  { let maxOp = 0, minOp = 9; cl.group.children.forEach(m => { if (m.visible && m.userData.level >= 1) { const a = m.geometry.attributes.aBushOp.array; for (let i = 0; i < a.length; i++) { maxOp = Math.max(maxOp, a[i]); minOp = Math.min(minOp, a[i]); } } });
    ok('look: …a clump of dense cells only is solid', minOp === 1 && maxOp === 1, [minOp, maxOp]); }
  const cd = B.create(mkCtx({ classesOn: [false, false, true] })); cd.settle(camera);
  ok('look: created with ctx.classesOn it draws the same', cd.stats().instances === nDense && cd.stats().cells === cDense, [cd.stats().instances, nDense]);
  cd.dispose();
  cl.setClasses([false, false, false]); cl.settle(camera);
  ok('look: all off draws nothing', cl.stats().instances === 0 && cl.group.children.length === 0 && !cl.stats().waiting);
  cl.setClasses([true, true, true]); cl.settle(camera);
  ok('look: all on again is as before', cl.stats().instances === nAll && cl.stats().cells === cAll);
  cl.dispose();
}

console.log((fail ? 'FAILED' : 'ok') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
