// Test for the blanket look of the brush grid (viewer_build/libs/brush-blanket.js), without a browser.
//
// Loads the real three.js r128 the viewer ships, libs/trees.js, libs/brush-blocks.js (the hub) and the module into
// one context, with made-up grids, then checks: the opacity curve (nothing under the lightest class, faint, about
// half, solid, never stepping); the coarser levels (heights smoothed 1 2 1, bare cells as 0; the most opacity a
// block); the surface (the ground plus the height at a cell's centre, down to the ground at bare neighbours,
// stretched on a slope, raised over a knob between coarse vertices); a tile's mesh (only quads with brush in or
// beside them, smooth normals, off the terrain left out); that a vertex has one height whichever tile asks; that
// where a fine tile meets a coarse one the morphed surfaces are the same (no crack at any level change); the
// density texture (one byte a cell, the neighbours' edge round it); the choice of tiles and the triangle budget on
// a grid the size of a real map; through the hub: the switch, the level, idle updates, dispose. Synthetic numbers only.
//
//   node tools/test_brush_blanket.js
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

function makeViewer() {
  const ctx = { console: { warn() {}, log: console.log, error: console.error, info() {} }, Math, Promise, Date, window: {} };
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ['three.min.js', 'trees.js', 'brush-blocks.js', 'brush-blanket.js']) vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', f), 'utf8'), ctx);
  const THREE = ctx.THREE, FB = ctx.window.FlexBrush, FT = ctx.window.FlexTrees, BK = ctx.window.FlexBrushLooks.blanket;
  const v = { ctx, THREE, FB, FT, BK, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(55, 4 / 3, 1, 60000), redraws: 0 };
  v.camera.up.set(0, 0, 1);
  v.opts = (br, groundZ) => ({ THREE, scene: v.scene, camera: v.camera, brush: br, groundZ: groundZ || (() => 100), dither: FT.dither,
    isAssetRef: () => false, b64ToArrayBuffer: s => { const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    redraw: () => { v.redraws++; } });
  v.look = (from, to) => { v.camera.position.set(from[0], from[1], from[2]); v.camera.lookAt(to[0], to[1], to[2]); v.camera.updateMatrixWorld(); v.camera.updateProjectionMatrix(); };
  return v;
}
const grid = (nx, ny, fill, more) => { const share = new Uint8Array(nx * ny), height = new Uint8Array(nx * ny); if (fill) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const r = fill(i, j); if (r) { share[j * nx + i] = r[0]; height[j * nx + i] = r[1]; } } return Object.assign({ nx, ny, cell: 1, x0: 0, y0: 0, top: 2.5, share, height }, more); };
const b64 = buf => Buffer.from(buf).toString('base64');

(async () => {
  const v = makeViewer(), BK = v.BK, FB = v.FB, C0 = FB.classes(null);
  ok('the module registers the look', !!BK && typeof BK.create === 'function' && v.ctx.window.FlexBrushLooks.blanket === BK);
  const h = fs.readFileSync(path.join(root, 'viewer_build', 'viewer.html'), 'utf8');
  ok('the viewer template loads it after the hub', h.includes('<script src="libs/brush-blanket.js"></script>') && h.indexOf('libs/brush-blocks.js') < h.indexOf('libs/brush-blanket.js'));

  // ── 1. Density -> opacity ───────────────────────────────────────────────────
  const lut = BK.alphaLut(C0), a = s => lut[Math.ceil(s * 255 - 1e-9)] / 255;
  ok('under the lightest class (share 0.1) nothing; from it, something', lut[0] === 0 && lut[25] === 0 && lut[26] > 0, [lut[25], lut[26]]);
  ok('light is faint, medium about half, dense solid', a(0.1) > 0.08 && a(0.2) < 0.32 && a(0.45) > 0.45 && a(0.45) < 0.68 && a(0.6) >= 0.75 && a(0.8) === 1 && lut[255] === 255, [a(0.1), a(0.2), a(0.45), a(0.6), a(0.8)]);
  let mono = true, step = 0; for (let i = 27; i < 256; i++) { if (lut[i] < lut[i - 1]) mono = false; step = Math.max(step, lut[i] - lut[i - 1]); }
  ok('…as one curve of the share: never down, no step at a class limit', mono && step <= 3, step);
  const l1 = BK.alphaLut(FB.classes([{ name: 'brush', min: 0.5, colour: '336633' }])), l5 = BK.alphaLut(FB.classes([0.1, 0.2, 0.4, 0.6, 0.8].map((m, k) => ({ name: 'c' + k, min: m, colour: '336633' }))));
  ok('other class lists: one class, five classes', l1[127] === 0 && l1[128] > 0 && l1[255] === 255 && l5[25] === 0 && l5[26] > 0 && l5[255] === 255 && l5[110] > l5[60]);

  // ── 2. The levels ───────────────────────────────────────────────────────────
  {
    const g = grid(16, 12, (i, j) => (i === 4 && j === 4) ? [255, 200] : (i >= 8 && j < 4) ? [255, 100] : (i === 1 && j === 9) ? [20, 250] : (i === 3 && j === 9) ? [255, 0] : null);
    const P = BK.prep(g, C0);
    ok('brushy cells counted (a share under the lightest class is not one)', P.cells === 1 + 32 + 1, P.cells);
    ok('heights at level 0: the cell’s own, the band’s low edge when it has none, 0 where bare or off the grid', BK.heightAt(P, 0, 4, 4) === 2 && BK.heightAt(P, 0, 3, 9) === 0.3 && BK.heightAt(P, 0, 1, 9) === 0 && BK.heightAt(P, 0, 5, 4) === 0 && BK.heightAt(P, 0, -1, 0) === 0 && BK.heightAt(P, 0, 16, 0) === 0);
    ok('level 1 is level 0 smoothed 1 2 1 each way at every other cell: a lone cell of 2 m is 0.5 m at its vertex', near(BK.heightAt(P, 1, 2, 2), 0.5, 0.011) && BK.heightAt(P, 1, 3, 2) === 0 && BK.heightAt(P, 1, 1, 2) === 0, BK.heightAt(P, 1, 2, 2));
    ok('…inside a field of 1 m it stays 1 m, at its edge it is lower', near(BK.heightAt(P, 1, 6, 1), 1, 0.011) && BK.heightAt(P, 1, 4, 1) < 0.8 && BK.heightAt(P, 1, 4, 1) > 0.2, [BK.heightAt(P, 1, 6, 1), BK.heightAt(P, 1, 4, 1)]);
    ok('sizes halve (rounded up) per level', P.W.join() === '16,8,4,2,1' && P.Hh.join() === '12,6,3,2,1');
    ok('the most opacity a block, per level', BK.anyAt(P, 0, 4, 4) === 255 && BK.anyAt(P, 0, 5, 4) === 0 && BK.anyAt(P, 1, 2, 2) === 255 && BK.anyAt(P, 1, 3, 2) === 0 && BK.anyAt(P, 2, 1, 1) === 255 && BK.anyAt(P, 2, 0, 0) === 0 && BK.anyAt(P, 4, 0, 0) === 255 && BK.anyAt(P, 1, 9, 0) === 0);
  }

  // ── 3. The surface ──────────────────────────────────────────────────────────
  {
    const g = grid(40, 40, (i, j) => (i >= 10 && i < 20 && j >= 10 && j < 20) ? [255, 150] : null), P = BK.prep(g, C0);
    const flat = () => 100, Z = new Float32Array(35 * 35);
    BK.lattice(P, flat, 0, 0, 0, 32, Z);
    const z = (I, J) => Z[(J + 1) * 35 + I + 1];
    ok('flat ground: a brushy cell’s vertex is the ground plus its height (plus the small lift)', near(z(15, 15), 100 + 1.5 + BK.LIFT, 1e-4), z(15, 15));
    ok('…a bare neighbour’s vertex is on the ground: the surface comes down over one cell, no wall', near(z(9, 15), 100 + BK.LIFT, 1e-4) && near(z(20, 15), 100 + BK.LIFT, 1e-4) && near(z(10, 15), 101.5 + BK.LIFT, 1e-4));
    ok('off the grid there is no surface', isNaN(z(-1, 5)) && !isNaN(z(0, 5)));
    // a slope of 33 degrees: the offset is stretched so the surface is the brush height away, square to the ground
    const t33 = Math.tan(33 * Math.PI / 180), slope = (x) => 100 + x * t33;
    BK.lattice(P, slope, 0, 0, 0, 32, Z);
    const off = z(15, 15) - slope(15.5);
    ok('on a 33 degree slope the offset is (height + lift) / cos 33: the brush height square to the ground', near(off, (1.5 + BK.LIFT) / Math.cos(33 * Math.PI / 180), 1e-3), off);
    const cliff = (x) => 100 + x * 5;
    BK.lattice(P, cliff, 0, 0, 0, 32, Z);
    ok('on a near-cliff the stretch stops at twice', near(z(15, 15) - cliff(15.5), (1.5 + BK.LIFT) * BK.KMAX, 1e-3), z(15, 15) - cliff(15.5));
    // a knob between coarse vertices: level 2 vertices are 4 cells apart; a 2 m knob sits 2 cells from vertex (3, 3)
    const kx = 3 * 4 + 0.5 + 2, ky = 3 * 4 + 0.5, knob = (x, y) => 100 + (Math.abs(x - kx) < 0.6 && Math.abs(y - ky) < 0.6 ? 2 : 0);
    BK.lattice(P, knob, 2, 0, 0, 8, Z); const z2 = (I, J) => Z[(J + 1) * 11 + I + 1];
    ok('a coarse vertex is raised by the ground that stands above its slope within a quad’s reach', z2(3, 3) - 100 >= 2 && z2(4, 3) - 100 >= 2 && z2(1, 1) - 100 < 0.5 + BK.heightAt(P, 2, 1, 1) + BK.LIFT + 3 * BK.BIAS, [z2(3, 3), z2(4, 3), z2(1, 1)]);
    BK.lattice(P, slope, 2, 0, 0, 8, Z);
    ok('…a plain slope raises nothing', near(Z[(1 + 1) * 11 + 1 + 1] - slope(4.5), (BK.heightAt(P, 2, 1, 1) + BK.LIFT + 3 * BK.BIAS) / Math.cos(33 * Math.PI / 180), 2e-3));
    ok('off the terrain there is no surface', (() => { BK.lattice(P, (x) => x < 12 ? null : 100, 0, 0, 0, 32, Z); return isNaN(z(5, 5)) && !isNaN(z(15, 5)); })());

    // ── 4. A tile's mesh ──────────────────────────────────────────────────────
    const M = BK.meshTile(P, flat, 0, 0, 0);
    // quads with brush in or beside them: the 10 x 10 cells and a ring round them = 11 x 11 quads between centres
    ok('a tile has only the quads with brush in or beside them', M && M.tris === 11 * 11 * 2 && M.idx.length === M.tris * 3 && M.pos.length === 33 * 33 * 3, M && M.tris);
    const vi = (i, j) => j * 33 + i;
    ok('vertices at cell centres, heights as the surface', near(M.pos[vi(15, 15) * 3], 15.5) && near(M.pos[vi(15, 15) * 3 + 1], 15.5) && near(M.pos[vi(15, 15) * 3 + 2], 101.5 + BK.LIFT, 1e-4));
    ok('normals: up on the flat top, leaning outwards on the edge, unit length', M.nor[vi(15, 15) * 3 + 2] === 127 && M.nor[vi(10, 15) * 3] < -40 && M.nor[vi(19, 15) * 3] > 40 && Math.abs(Math.hypot(M.nor[vi(10, 15) * 3], M.nor[vi(10, 15) * 3 + 1], M.nor[vi(10, 15) * 3 + 2]) - 127) < 2);
    let wall = 0; for (let k = 0; k < M.idx.length; k += 3) { const [p, q, r] = [M.idx[k], M.idx[k + 1], M.idx[k + 2]]; const ax = M.pos[q * 3] - M.pos[p * 3], ay = M.pos[q * 3 + 1] - M.pos[p * 3 + 1], bx = M.pos[r * 3] - M.pos[p * 3], by = M.pos[r * 3 + 1] - M.pos[p * 3 + 1]; if (!(ax * by - ay * bx > 0.49)) wall++; }
    ok('no walls: every triangle faces up over half a cell of ground', wall === 0, wall);
    ok('the coarser surface under each vertex is carried (lower than the top: smoothed)', M.zc[vi(10, 10)] < M.pos[vi(10, 10) * 3 + 2] && near(M.zc[vi(14, 14)], 101.5 + BK.LIFT + BK.BIAS, 0.02), [M.zc[vi(10, 10)], M.zc[vi(14, 14)]]);
    ok('a tile with no brush has no mesh; one off the grid neither', BK.meshTile(P, flat, 0, 1, 1) === null && BK.meshTile(P, flat, 0, 5, 0) === null && BK.meshTile(BK.prep(grid(40, 40), C0), flat, 0, 0, 0) === null);
    const Mh = BK.meshTile(P, (x) => x < 14 ? null : 100, 0, 0, 0);
    ok('off the terrain: those quads are left out', Mh && Mh.tris < M.tris && Mh.tris > 0);
  }

  // ── 5. One height a vertex; no crack where levels meet ──────────────────────
  {
    const N = 1024, rnd = (i, j) => { let x = (i * 73856093) ^ (j * 19349663); x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
    const g = grid(N, N, (i, j) => rnd(i >> 2, j >> 2) < 0.75 ? [60 + Math.floor(rnd(i, j) * 195), 30 + Math.floor(rnd(j, i) * 220)] : null), P = BK.prep(g, C0);
    const hill = (x, y) => 100 + 30 * Math.sin(x / 40) * Math.cos(y / 55) + 0.2 * x;
    // the same vertex from two neighbouring tiles of one level
    let same = true;
    for (const l of [0, 1, 2]) { const A = BK.meshTile(P, hill, l, 0, 0), B = BK.meshTile(P, hill, l, 1, 0); for (let j = 0; j <= 32; j++) { const a = j * 33 + 32, b = j * 33; if (A.pos[a * 3 + 2] !== B.pos[b * 3 + 2] || A.zc[a] !== B.zc[b] || A.nor[a * 3] !== B.nor[b * 3] || A.nc[a * 3 + 2] !== B.nc[b * 3 + 2] || A.pos[a * 3] !== B.pos[b * 3]) same = false; } }
    ok('two tiles agree on the vertices they share (height, coarser height, normals)', same);
    // fully morphed, a fine tile is the coarser tile's surface: at the coarse vertices its heights, between them its edges and diagonal
    let worst = 0, worstN = 0;
    for (const l of [0, 1, 2, 3]) {
      const A = BK.meshTile(P, hill, l, 2, 0), B = BK.meshTile(P, hill, l + 1, 1, 0);       // A is B's west half (south part)
      for (let j = 0; j <= 32; j++) for (let i = 0; i <= 32; i++) {
        const a = j * 33 + i, bi = i / 2, bj = j / 2, i0 = Math.floor(bi), j0 = Math.floor(bj), i1 = Math.ceil(bi), j1 = Math.ceil(bj);
        const want = (B.pos[(j0 * 33 + i0) * 3 + 2] + B.pos[(j1 * 33 + i1) * 3 + 2]) / 2;
        worst = Math.max(worst, Math.abs(A.zc[a] - want));
        if (!(i & 1) && !(j & 1)) worstN = Math.max(worstN, Math.abs(A.nc[a * 3] - B.nor[(j0 * 33 + i0) * 3]), Math.abs(A.nc[a * 3 + 2] - B.nor[(j0 * 33 + i0) * 3 + 2]));
      }
    }
    ok('fully morphed, a fine tile lies in the coarser tile’s surface (its vertices, edges and the quads’ diagonal), with its normals', worst < 1e-4 && worstN <= 1, [worst, worstN]);
    // the selection: wherever tiles of two levels touch, the finer one's vertices there are fully morphed and the
    // coarser one's not at all (and levels two apart never touch)
    const R = BK.roots(P, hill), all = () => true;
    const settle = (cam) => { for (let n = 0; n < 50; n++) { const want = []; BK.select(P, hill, R, cam, all, 0, want); if (!want.length) break; want.forEach(t => { const M = BK.meshTile(P, hill, t.l, t.tx, t.ty); t.state = 1; t.tris = M ? M.tris : 0; t.M = M; if (M) { t.box[2] = M.zmin - 0.5; t.box[5] = M.zmax + 0.5; } }); } return BK.select(P, hill, R, cam, all, 0, []); };
    let bad = 0, touching = 0, jump = 0, levels = new Set();
    for (const cam of [[20, 20, 140], [128, -30, 200], [300, 300, 260], [128, 128, 108], [-400, 128, 300]]) {
      const draw = settle(cam), at = new Map();
      draw.forEach(t => { levels.add(t.l); const s = 1 << t.l; for (let j = 0; j <= 32; j++) for (let i = 0; i <= 32; i++) { if (i && j && i < 32 && j < 32) continue; const key = ((t.tx * 32 + i) * s) + ',' + ((t.ty * 32 + j) * s), v = j * 33 + i; const d = Math.hypot(t.M.pos[v * 3] - cam[0], t.M.pos[v * 3 + 1] - cam[1], t.M.pos[v * 3 + 2] - cam[2]); const k = BK.morph(P, t.l, d), z = t.M.pos[v * 3 + 2] * (1 - k) + t.M.zc[v] * k; (at.get(key) || at.set(key, []).get(key)).push({ l: t.l, k, z, top: t.l === BK.LEVELS - 1 }); } });
      at.forEach(list => { for (const p of list) for (const q of list) { if (q.l <= p.l) continue; touching++; if (q.l - p.l > 1) jump++; if (p.k !== 1 || (q.k !== 0 && !q.top) || Math.abs(p.z - q.z) > 1e-3) bad++; } });
    }
    ok('across every level change of a selection the two surfaces are the same: the finer side fully morphed, the coarser not yet', touching > 200 && bad === 0 && jump === 0 && levels.size >= 3, { touching, bad, jump, levels: [...levels] });
    ok('the morph runs over the last part of a level’s range', BK.morph(P, 0, BK.range(P, 0) * BK.M0) === 0 && near(BK.morph(P, 0, BK.range(P, 0) * BK.M1), 1, 1e-9) && BK.morph(P, 0, BK.range(P, 0)) === 1 && near(BK.morph(P, 1, BK.range(P, 1) * (BK.M0 + BK.M1) / 2), 0.5) && BK.range(P, 1) === 2 * BK.range(P, 0) && BK.M1 < 1);
  }

  // ── 6. The density texture ──────────────────────────────────────────────────
  {
    const g = grid(1500, 1100, (i, j) => [((i * 7 + j * 13) % 230) + 26, 100]), P = BK.prep(g, C0), lut = P.lut;
    const T = BK.regionTexels(P, 0, 0), T2 = BK.regionTexels(P, 1024, 1024);
    ok('a piece is its cells and one cell of the neighbours all round', T.w === 1026 && T.h === 1026 && T2.w === 476 + 2 && T2.h === 76 + 2 && T.data.length === 1026 * 1026);
    ok('…a byte a cell: the opacity of its share, rows from the south', T.data[1 * 1026 + 1] === lut[g.share[0]] && T.data[6 * 1026 + 4] === lut[g.share[5 * 1500 + 3]] && T.data[1025 * 1026 + 1025] === lut[g.share[1024 * 1500 + 1024]]);
    ok('…the border is the neighbours’ cells, 0 off the grid', T.data[0] === 0 && T.data[5 * 1026] === 0 && T2.data[0] === lut[g.share[1023 * 1500 + 1023]] && T2.data[1 * 478 + 477] === 0 && T2.data[77 * 478 + 5] === 0 && T2.data[3 * 478 + 476] === lut[g.share[(1024 + 2) * 1500 + 1499]]);
  }

  // ── 7. A grid the size of a real map, through the hub ───────────────────────
  {
    const nx = 2391, ny = 3129, share = new Uint8Array(nx * ny), height = new Uint8Array(nx * ny);
    let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const blob = new Float32Array(Math.ceil(nx / 24) * Math.ceil(ny / 24)); for (let k = 0; k < blob.length; k++) blob[k] = rnd();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const b = blob[Math.floor(j / 24) * Math.ceil(nx / 24) + Math.floor(i / 24)]; if (b < 0.45 && rnd() < 0.8) { share[j * nx + i] = 26 + Math.floor(rnd() * 229); height[j * nx + i] = 30 + Math.floor(rnd() * 200); } }
    const file = b64(FB.encode({ nx, ny, cell: 0.9, x0: -1076, y0: -1408, share, height }));
    const w = makeViewer(), ground = (x, y) => (x < -1076 || y < -1408 || x > 1076 || y > 1408) ? null : 500 + 0.3 * x + 60 * Math.sin(y / 300);
    await w.FB.init(w.opts({ version: 1, file }, ground));
    await w.FT.init({ blocks: w.FB, THREE: w.THREE, scene: w.scene, trees: null, saved: undefined, redraw() {} });
    const t0 = Date.now(); const got = w.FB.look('blanket'); const ms = Date.now() - t0;
    const lk = w.FB.objects().look;
    ok('the look is put on by the hub: its group in the scene, the blocks hidden', got === 'blanket' && lk && lk.group.parent === w.scene && !w.FB.objects().group.visible && w.FT.serialize().look === 'blanket');
    ok('nothing is meshed until a view asks', lk.stats().meshed === 0 && lk.stats().textures === 0 && lk.stats().triangles === 0);
    const views = { whole: [[0, -200, 3200], [0, 0, 500]], oblique: [[400, -900, 1000], [0, 0, 500]], near: [[100, -260, 650], [100, 0, 530]], ground: [[-200, 60, 445], [-240, 100, 430]], down: [[0, 0, 560], [0, 0.1, 500]] };
    const line = [];
    for (const name of Object.keys(views)) {
      w.look(views[name][0], views[name][1]);
      const t1 = Date.now(); w.FB.settle(); const st = w.FB.stats();
      line.push(name + ': ' + st.tris + ' triangles, ' + st.shown.tiles + ' tiles ' + st.shown.levels.join('/') + ', from level ' + st.shown.minLevel + ', meshed in ' + (Date.now() - t1) + ' ms');
      ok('view "' + name + '": something drawn, inside the budget of 600 000 triangles, nothing waiting', st.tris > 0 && st.tris <= 600000 && !st.waiting && st.look === 'blanket', st.shown);
      const vis = lk.group.children.filter(m => m.visible), sum = vis.reduce((n, m) => n + m.geometry.index.count / 3, 0);
      ok('…the visible meshes are exactly the tiles counted', sum === st.tris && vis.length === st.shown.tiles, [sum, st.tris]);
    }
    console.log('BLANKET_NODE create ' + ms + ' ms | ' + line.join(' | '));
    const st = w.FB.stats().shown;
    ok('near the camera the finest level is in use, far away the coarsest; tiles are kept inside the cache', st.cells > 1e6 && st.meshed <= 700 + 200 && st.textures >= 1 && st.textures <= 12 && st.materials <= 60, st);
    w.look(views.near[0], views.near[1]); w.FB.settle();
    ok('…full detail (level 0) near', w.FB.stats().shown.levels[0] > 0, w.FB.stats().shown.levels);
    // idle: the same camera, nothing happens
    const built = w.FB.stats().shown.built, r0 = w.redraws;
    for (let k = 0; k < 20; k++) w.FB.update();
    ok('left alone: update returns at once, no frame asked for, nothing meshed', w.redraws === r0 && w.FB.stats().shown.built === built);
    // lazy: a new view is meshed over several updates, each asking for the next frame
    w.look([600, 700, 700], [500, 1000, 600]);
    let n = 0, asked = 0; for (; n < 500; n++) { const r = w.redraws; w.FB.update(); if (w.redraws > r) asked++; if (!w.FB.stats().waiting) break; }
    ok('a new view is meshed over some frames (a few ms each), asking for the next one while more waits, then stops', n >= 1 && asked === n && !w.FB.stats().waiting && w.FB.stats().tris > 0, [n, asked]);
    // a tighter budget: the finest level goes up, the triangles fit
    w.look(views.near[0], views.near[1]); w.FB.settle(); const full = w.FB.stats().tris;
    const w2 = makeViewer(); await w2.FB.init(w2.opts({ version: 1, file }, ground)); w2.FB.budget(Math.round(full / 3)); w2.FB.look('blanket'); w2.look(views.near[0], views.near[1]); w2.FB.settle();
    ok('over the budget the finest level in use goes up until the triangles fit', w2.FB.stats().tris <= Math.round(full / 3) && w2.FB.stats().tris > 0 && w2.FB.stats().shown.minLevel >= 1 && w2.FB.stats().shown.levels[0] === 0, [full, w2.FB.stats().shown]);
    // the chip: level and switch
    const builtBefore = w.FB.stats().shown.built; w.FB.set({ opacity: 0.25 });
    const mats = lk.objects().materials, m0 = mats[Object.keys(mats)[0]];
    ok('the chip’s level is one uniform of every material, no rebuild', lk.stats().level === 0.25 && Object.keys(mats).every(k => mats[k].userData.blanket.uOpacityDither.value === 0.25) && w.FB.stats().shown.built === builtBefore);
    w.FB.set({ on: false }); const r1 = w.redraws; w.look([0, 0, 900], [0, 1, 500]); w.FB.update();
    ok('switched off: hidden, and a moved camera meshes nothing and asks for no frame', !lk.group.visible && w.FB.stats().shown.built === builtBefore && w.redraws === r1, [w.FB.stats().shown.built, builtBefore]);
    w.FB.set({ on: true });
    // the material: one program for all, a texture a region, taps go through
    const sh = { uniforms: {}, vertexShader: 'void main() {\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}', fragmentShader: 'void main() {\n#include <clipping_planes_fragment>\n}' };
    m0.onBeforeCompile(sh);
    ok('the shader: morph in the vertex stage, density from the texture and the dither discard in the fragment stage', /bkMorph/.test(sh.vertexShader) && !/#include <begin_vertex>/.test(sh.vertexShader) && /texture2D\(uBkShare, vBkUv\)\.r \* uOpacityDither\) discard/.test(sh.fragmentShader) && sh.uniforms.uBkShare.value.isDataTexture && sh.uniforms.uOpacityDither.value === 0.25);
    const tex = sh.uniforms.uBkShare.value;
    ok('the texture: a byte a cell, rows not padded, smoothed and mip-mapped', tex.format === w.THREE.LuminanceFormat && tex.unpackAlignment === 1 && tex.magFilter === w.THREE.LinearFilter && tex.generateMipmaps === true && tex.image.width <= 1026);
    ok('one program for every tile; not see-through for the renderer (no sorting, depth is written); taps go through', new Set(Object.keys(mats).map(k => mats[k].customProgramCacheKey())).size === 1 && !m0.transparent && m0.depthWrite && (() => { const hits = []; lk.group.children[0].raycast(new w.THREE.Raycaster(), hits); return hits.length === 0; })());
    // back to the blocks: everything freed
    const geos = lk.group.children.map(m => m.geometry); let freed = 0; geos.forEach(gm => gm.addEventListener('dispose', () => freed++)); let texFreed = 0; tex.addEventListener('dispose', () => texFreed++);
    ok('back to the blocks: geometries, materials and textures are disposed, the group is out of the scene', w.FB.look('blocks') === 'blocks' && freed === geos.length && texFreed === 1 && lk.group.parent === null && lk.group.children.length === 0 && w.FB.objects().group.visible);
    lk.update(w.camera); lk.setLevel(1);
    ok('…and a late call to the old look does nothing', lk.stats().triangles >= 0 && lk.group.children.length === 0);
  }

  // ── 8. Small things ─────────────────────────────────────────────────────────
  {
    const w = makeViewer(); await w.FB.init(w.opts({ version: 1, file: b64(FB.encode(grid(30, 30))) })); w.FB.look('blanket'); w.look([0, -50, 150], [10, 10, 100]); w.FB.settle();
    ok('a grid with no brush: the look is on, nothing drawn, nothing waiting', w.FB.look() === 'blanket' && w.FB.stats().tris === 0 && !w.FB.stats().waiting && w.FB.objects().look.group.children.length === 0);
    const w3 = makeViewer(); await w3.FB.init(w3.opts({ version: 1, file: b64(FB.encode(grid(70, 50, () => [255, 100]))) })); w3.BK.pattern = 'bayer4'; w3.FB.look('blanket'); w3.look([35, -60, 180], [35, 25, 100]); w3.FB.settle();
    ok('a small grid, and another dither pattern by name', w3.FB.stats().tris === 69 * 49 * 2 && w3.FB.stats().shown.pattern === 'bayer4', w3.FB.stats().tris);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
