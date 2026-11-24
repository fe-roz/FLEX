// Test for the viewer's brush blocks (viewer_build/libs/brush-blocks.js), without a browser.
//
// Loads the real three.js r128 the viewer ships and the module into one context, with made-up grids (FBR1 built
// here), then checks: nothing at all when BRUSH is null; the binary layout; the classes (BRUSH.classes, the usual
// three without); height steps; the coarser levels keep the covered share of the ground; a tile's mesh (tops on
// the ground plus the height, walls into the ground only where a neighbour is bare or lower, equal neighbours
// merged, steep ground); the choice of tiles per view and the triangle budget on a grid the size of a real map;
// cells under tree crowns left out; the switch and the level; the looks (registry, switch, fallback, state).
// Synthetic numbers only.
//
//   node tools/test_brush_blocks.js
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
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'three.min.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'trees.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'brush-blocks.js'), 'utf8'), ctx);
  const THREE = ctx.THREE, FB = ctx.window.FlexBrush, FT = ctx.window.FlexTrees;
  const v = { ctx, THREE, FB, FT, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(55, 4 / 3, 1, 60000), redraws: 0, decoded: 0 };
  v.camera.up.set(0, 0, 1);
  v.opts = (br, groundZ) => ({ THREE, scene: v.scene, camera: v.camera, brush: br, groundZ: groundZ || (() => 100), dither: FT.dither,
    isAssetRef: s => typeof s === 'string' && s.length < 512 && /\.(glb|jpe?g|png|webp|bin)$/i.test(s),
    b64ToArrayBuffer: s => { v.decoded++; const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    redraw: () => { v.redraws++; } });
  v.look = (from, to) => { v.camera.position.set(from[0], from[1], from[2]); v.camera.lookAt(to[0], to[1], to[2]); v.camera.updateMatrixWorld(); v.camera.updateProjectionMatrix(); };
  return v;
}
const grid = (nx, ny, fill) => { const share = new Uint8Array(nx * ny), height = new Uint8Array(nx * ny); if (fill) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const r = fill(i, j); if (r) { share[j * nx + i] = r[0]; height[j * nx + i] = r[1]; } } return { nx, ny, share, height }; };
const b64 = buf => Buffer.from(buf).toString('base64');

(async () => {
  let v = makeViewer();
  const FB = v.FB;
  // ── 1. Every other export: BRUSH is null, nothing happens ───────────────────
  ok('the module defines FlexBrush', !!FB && typeof FB.init === 'function' && typeof FB.update === 'function');
  for (const nothing of [null, undefined, {}, { version: 1, nx: 5 }]) {
    const r = await FB.init(v.opts(nothing));
    ok('BRUSH ' + JSON.stringify(nothing) + ': not active, nothing in the scene, nothing decoded', r === false && !FB.active() && !FB.loaded() && v.scene.children.length === 0 && v.decoded === 0 && FB.stats() === null && FB.objects() === null && (await FB.whenReady()) === false);
  }
  FB.update(); FB.settle(); FB.set({ on: false });
  ok('…and its calls do nothing', v.redraws === 0);
  const h = fs.readFileSync(path.join(root, 'viewer_build', 'viewer.html'), 'utf8');
  ok('the viewer template has the placeholder once, with the unfilled-template guard, the script line and the hooks', h.split('PLACEHOLDER_BRUSH_JSON').length === 2 && h.includes("<script>window['PLACEHOLDER_' + 'BRUSH_JSON'] = null;</script>\n<script>const BRUSH = PLACEHOLDER_BRUSH_JSON;</script>") &&
    h.includes('<script src="libs/brush-blocks.js"></script>') && h.includes('FlexBrush.init(') && h.includes('FlexBrush.update()') && h.includes('blocks: window.FlexBrush') && h.indexOf('libs/trees.js') < h.indexOf('libs/brush-blocks.js'));

  // ── 2. The file ─────────────────────────────────────────────────────────────
  const g1 = grid(7, 5, (i, j) => [i * 30 + j, 10 * (i + j)]);
  const buf = FB.encode(Object.assign({ cell: 0.9, x0: -12.5, y0: 60.25, top: 2.5 }, g1));
  const dv = new DataView(buf);
  ok('FBR1 as the contract has it: tag, nx, ny, cell, x0, y0, top, a spare, then the shares and the heights, rows from the south', buf.byteLength === 32 + 70 && Buffer.from(buf, 0, 4).toString('latin1') === 'FBR1' && dv.getUint32(4, true) === 7 && dv.getUint32(8, true) === 5 && near(dv.getFloat32(12, true), 0.9, 1e-6) && dv.getFloat32(16, true) === -12.5 && dv.getFloat32(20, true) === 60.25 && dv.getFloat32(24, true) === 2.5 && dv.getUint32(28, true) === 0 &&
    dv.getUint8(32 + 1 * 7 + 2) === 61 && dv.getUint8(32 + 35 + 1 * 7 + 2) === 30);
  const F = FB.parse(buf);
  ok('…read back, as views over the bytes', F.nx === 7 && F.ny === 5 && near(F.cell, 0.9, 1e-6) && F.x0 === -12.5 && F.y0 === 60.25 && F.top === 2.5 && F.share[9] === 61 && F.height[9] === 30 && F.share.buffer === buf);
  const throws = f => { try { f(); return false; } catch (_) { return true; } };
  ok('a wrong file, an empty one, one cut short and one with no cells are refused', throws(() => FB.parse(Buffer.from('FTR2\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0').buffer.slice(0, 36))) && throws(() => FB.parse(new ArrayBuffer(0))) && throws(() => FB.parse(buf.slice(0, 60))) && throws(() => FB.parse(FB.encode({ nx: 0, ny: 0, cell: 0.9, share: [], height: [] }))));

  // ── 3. Classes and heights ──────────────────────────────────────────────────
  const C0 = FB.classes(null);
  ok('with no classes given: the bushwhack map’s three (light from 0.1, medium from 0.3, dense from 0.6) in its colours', C0.map(c => c.name + ':' + c.min + ':' + c.rgb.join('.')).join('|') === 'light:0.1:183.228.160|medium:0.3:95.174.79|dense:0.6:31.95.31');
  const py = fs.readFileSync(path.join(root, 'export_ridge.py'), 'utf8');
  ok('…the same cut-offs and colours as export_ridge.py BRUSH_CLASSES', /\(0\.6, \(0x1f, 0x5f, 0x1f\)\)/.test(py) && /\(0\.3, \(0x5f, 0xae, 0x4f\)\)/.test(py) && /\(0\.1, \(0xb7, 0xe4, 0xa0\)\)/.test(py));
  const C1 = FB.classes([{ name: 'dense', min: 0.5, colour: '#102030' }, { name: 'light', min: 0.2, colour: 'AABBCC' }, { name: 'bad', min: 0.3, colour: 'xyz' }, { name: 'zero', min: 0, colour: '000000' }]);
  ok('BRUSH.classes are taken at run time: sorted lightest first, colours parsed, bad ones left out', C1.length === 2 && C1[0].name === 'light' && C1[0].rgb.join() === '170,187,204' && C1[1].rgb.join() === '16,32,48' && C1[0].cut === 51 && C1[1].cut === 128);
  const L = FB.luts(C0, 0.3);
  ok('a share byte gives its class: under the lightest (bytes 1..25) nothing, then light, medium, dense', L.c[0] === 0 && L.c[1] === 0 && L.c[25] === 0 && L.c[26] === 1 && L.c[76] === 1 && L.c[77] === 2 && L.c[152] === 2 && L.c[153] === 3 && L.c[255] === 3, [L.c[25], L.c[26], L.c[76], L.c[77], L.c[152], L.c[153]]);
  ok('a height in cm gives whole steps of 0.25 m, at least one; none measured stands at the band’s foot', FB.HSTEP === 0.25 && L.h[250] === 10 && L.h[125] === 5 && L.h[100] === 4 && L.h[30] === 1 && L.h[5] === 1 && L.h[0] === 1 && L.h[212] === 8);

  // ── 4. The coarser levels ───────────────────────────────────────────────────
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const dens of [0.1, 0.3, 0.5, 0.8]) {
    seed = 7;
    const g = grid(512, 512, () => rnd() < dens ? [200, 100] : null), D = FB.data(FB.encode(Object.assign({ cell: 1 }, g)), null, () => 0);
    const cov = [1, 2, 3].map(l => { let n = 0; const c = D.lv[l].c; for (let k = 0; k < c.length; k++) if (c[k]) n++; return n / c.length; });
    ok(`scattered brush on ${dens * 100} % of the ground stays about ${dens * 100} % of it at every coarser level (the far view is not emptier or fuller)`, D.lv.cells / (512 * 512) > dens - 0.01 && cov.every(c => Math.abs(c - dens) < 0.07), cov);
  }
  {
    const g = grid(64, 64, (i, j) => i < 32 ? [i < 16 ? 100 : 255, j < 32 ? 50 : 250] : null), D = FB.data(FB.encode(Object.assign({ cell: 1 }, g)), null, () => 0);
    const l2 = D.lv[2];
    ok('a coarse block has its cells’ class and height (means), and solid brush stays solid, bare stays bare', l2.w === 16 && l2.c[0] === 2 && l2.c[5] === 3 && l2.c[9] === 0 && l2.q[0] === 2 && l2.q[15 * 16 + 5] === 10 && D.lv[3].c[0] === 2 && D.lv[3].c[3] === 3 && D.lv[3].c[4] === 0 && D.lv.cells === 32 * 64, [l2.c[0], l2.c[5], l2.q[0]]);
  }

  // ── 5. One tile's mesh ──────────────────────────────────────────────────────
  const faces = M => { const out = []; for (let q = 0; q < M.pos.length / 3; q += 4) { const p = k => [M.pos[(q + k) * 3], M.pos[(q + k) * 3 + 1], M.pos[(q + k) * 3 + 2]]; out.push({ n: [M.nor[q * 3], M.nor[q * 3 + 1], M.nor[q * 3 + 2]], c: [M.col[q * 3], M.col[q * 3 + 1], M.col[q * 3 + 2]], p: [p(0), p(1), p(2), p(3)] }); } return out; };
  {
    // one cell alone, 1.25 m of medium brush, on flat ground at 100 m; cell 2 m, grid from (10, 20)
    const g = grid(8, 8, (i, j) => i === 3 && j === 2 ? [100, 125] : null), D = FB.data(FB.encode(Object.assign({ cell: 2, x0: 10, y0: 20 }, g)), null, () => 100);
    const M = FB.meshTile(D, 0, 0, 0), f = faces(M);
    ok('one brushy cell alone is a block: a top and four walls, 10 triangles, 20 vertices', M.tris === 10 && M.rects === 1 && M.blocks === 1 && M.pos.length === 60 && M.idx.length === 30 && f.length === 5 && M.idx.BYTES_PER_ELEMENT === 2);
    const top = f[0];
    ok('…its top is the cell’s square at the ground plus its height (101.25 m), facing up, in the class colour', top.n.join() === '0,0,127' && top.c.join() === '95,174,79' && top.p.every(p => near(p[2], 101.25)) && top.p.map(p => p[0] + ',' + p[1]).join(' ') === '16,24 18,24 18,26 16,26');
    ok('…its walls face south, east, north and west, a little darker, from the top down to 0.3 m under the ground', f.slice(1).map(w => w.n.join()).join(' ') === '0,-127,0 127,0,0 0,127,0 -127,0,0' && f.slice(1).every(w => w.c.join() === '76,139,63' && near(w.p[0][2], 99.7) && near(w.p[1][2], 99.7) && near(w.p[2][2], 101.25) && near(w.p[3][2], 101.25)));
    // counter-clockwise seen from outside: the triangle's own normal agrees with the stored one
    const tn = (a, b, c) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; };
    ok('…every face is wound to be seen from outside', f.every(q => { const n = tn(q.p[0], q.p[1], q.p[2]); return n[0] * q.n[0] + n[1] * q.n[1] + n[2] * q.n[2] > 0; }));
    ok('the mesh knows its heights (for the view test)', near(M.zmin, 99.7) && near(M.zmax, 101.25));
  }
  {
    // steep ground: z = 100 + x (45 degrees). A block's top is the ground at each corner plus its height: a slab on the slope.
    const g = grid(8, 8, (i, j) => i >= 2 && i < 4 && j === 2 ? [255, 100 + (i - 2) * 100] : null), D = FB.data(FB.encode(Object.assign({ cell: 1 }, g)), null, (x, y) => 100 + x);
    const f = faces(FB.meshTile(D, 0, 0, 0)), tops = f.filter(q => q.n[2] > 0), walls = f.filter(q => q.n[2] === 0);
    ok('on a 45 degree slope every top corner is the ground there plus the height (1 m and 2 m): no slab floats, none is buried', tops.length === 2 && tops.every((t, k) => t.p.every(p => near(p[2] - (100 + p[0]), 1 + k))), tops.map(t => t.p.map(p => p[2])));
    ok('…and every wall foot is 0.3 m under the ground at its own corner', walls.length === 7 && walls.every(w => near(w.p[0][2] - (100 + w.p[0][0]), -0.3) && near(w.p[1][2] - (100 + w.p[1][0]), -0.3)), walls.length);
    ok('…the lower block has no wall against the taller one; the taller one has all four', walls.filter(w => w.p[0][0] === 3 && w.p[1][0] === 3).length === 1 && walls.filter(w => w.n[0] === 127).length === 1);
  }
  {
    // merging: a 20 x 12 patch of one class and height
    const g = grid(40, 40, (i, j) => i >= 4 && i < 24 && j >= 6 && j < 18 ? [255, 150] : null), D = FB.data(FB.encode(Object.assign({ cell: 0.9 }, g)), null, () => 0);
    const M = FB.meshTile(D, 0, 0, 0), f = faces(M), tops = f.filter(q => q.n[2] > 0);
    const area = tops.reduce((a, t) => a + (t.p[1][0] - t.p[0][0]) * (t.p[3][1] - t.p[0][1]), 0);
    ok('240 equal cells are merged into rectangles of at most 8 x 8 cells: 6 tops covering the same ground, walls on the outside only', M.blocks === 240 && M.rects === 6 && near(area, 240 * 0.81, 0.01) && tops.every(t => t.p[1][0] - t.p[0][0] <= 7.21 && t.p[3][1] - t.p[0][1] <= 7.21) && f.length - tops.length === 10 && M.tris === 32, [M.rects, f.length, M.tris]);
    // a different class or height is never merged
    const g2 = grid(8, 8, (i, j) => j === 1 && i < 6 ? [i < 2 ? 255 : i < 4 ? 100 : 255, i < 5 ? 100 : 200] : null), D2 = FB.data(FB.encode(Object.assign({ cell: 1 }, g2)), null, () => 0);
    const t2 = faces(FB.meshTile(D2, 0, 0, 0)).filter(q => q.n[2] > 0);
    ok('cells of another class or another height are not merged with their neighbours', t2.length === 4 && t2.map(t => t.p[1][0] - t.p[0][0]).join() === '2,2,1,1' && t2.map(t => t.c[1]).join() === '95,174,95,95' && t2.map(t => t.p[0][2]).join() === '1,1,1,2', t2.map(t => [t.p[1][0] - t.p[0][0], t.c[1], t.p[0][2]]));
    ok('ground that is not known (off the terrain) leaves the block out', FB.meshTile(FB.data(FB.encode(Object.assign({ cell: 1 }, g2)), null, (x) => x > 3 ? null : 0), 0, 0, 0).rects === 1 && FB.meshTile(FB.data(FB.encode(Object.assign({ cell: 1 }, g2)), null, () => null), 0, 0, 0) === null);
    ok('a tile with no brush has no mesh', FB.meshTile(D, 0, 0, 0) !== null && FB.meshTile(FB.data(FB.encode(Object.assign({ cell: 1 }, grid(70, 70, (i) => i > 66 ? [255, 100] : null))), null, () => 0), 0, 0, 0) === null);
    // the coarsest level: tops only
    const g3 = grid(64, 64, () => [255, 100]), D3 = FB.data(FB.encode(Object.assign({ cell: 1 }, g3)), null, () => 0);
    const M3 = FB.meshTile(D3, 3, 0, 0), M2 = FB.meshTile(D3, 2, 0, 0);
    ok('the coarsest level (blocks of 8 x 8 cells) has tops only; the next has walls', FB.SIDES_TO === 2 && faces(M3).every(q => q.n[2] > 0) && M3.blocks === 64 && M3.rects === 16 && faces(M2).some(q => q.n[2] === 0) && near(faces(M3)[0].p[2][0], 16));
  }

  // ── 6. In the viewer: tiles per view, the budget ────────────────────────────
  // A grid the size of a real map: 2391 x 3129 cells of 0.9 m, patches of brush with noisy heights, on sloping ground.
  const nx = 2391, ny = 3129, n = nx * ny, share = new Uint8Array(n), height = new Uint8Array(n);
  const fn = (x, y) => Math.sin(x * 0.013) * Math.cos(y * 0.017) + 0.6 * Math.sin(x * 0.051 + y * 0.043) + 0.3 * Math.sin(x * 0.21) * Math.sin(y * 0.19);
  seed = 3; let cells = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const q = fn(i, j) - 0.5 + rnd() * 0.25; if (q > 0) { const s = Math.min(1, 0.1 + q * 1.2); share[j * nx + i] = Math.ceil(s * 255); height[j * nx + i] = Math.min(250, Math.round(30 + s * 170 + rnd() * 50)); if (share[j * nx + i] >= 26) cells++; } }
  const big = FB.encode({ nx, ny, cell: 0.9, x0: -1076, y0: -1408, share, height });
  const ground = (x, y) => 500 + 0.15 * x + 30 * Math.sin(y * 0.01);
  v = makeViewer();
  let t0 = Date.now();
  const r = await v.FB.init(v.opts({ version: 1, file: b64(big) }, ground));
  const initMs = Date.now() - t0;
  let s = v.FB.stats(), o = v.FB.objects();
  ok(`a ${nx} x ${ny} grid with ${cells.toLocaleString('en')} cells of brush: loaded in ${initMs} ms, 35 coarsest tiles meshed and kept, one group in the scene, one redraw asked`, r === true && v.FB.loaded() && s.cells === cells && cells > 1500000 && s.roots === 35 && s.meshed === 35 && v.scene.children.length === 1 && o.group.parent === v.scene && v.redraws === 1 && initMs < 5000, [s, initMs]);
  ok('drawn as ordinary solid surfaces (depth test and write on, no blending, lit, vertex colours), with the dither of the trees', o.material.isMeshLambertMaterial && o.material.depthWrite && !o.material.transparent && o.material.vertexColors === true && (() => { const sh = { uniforms: {}, fragmentShader: v.THREE.ShaderLib.lambert.fragmentShader }; o.material.onBeforeCompile(sh); return sh.fragmentShader.includes('flexBayer4') && sh.uniforms.uOpacityDither.value === 1; })());
  const views = { whole: [[0, -2500, 3200], [0, 0, 500]], oblique: [[300, -900, 900], [0, 0, 500]], near: [[200, -300, 640], [150, 0, 520]], ground: [[-340, 100, ground(-340, 100) + 4], [-300, 100, ground(-300, 100)]], down: [[400, -300, ground(400, -300) + 60], [400, -299, ground(400, -300)]] };
  const res = {};
  for (const k in views) { v.look(views[k][0], views[k][1]); t0 = Date.now(); v.FB.settle(); res[k] = Object.assign({ ms: Date.now() - t0 }, v.FB.stats()); }
  ok('every view is drawn inside the budget of 600,000 triangles', FB.BUDGET === 600000 && Object.values(res).every(q => q.tris > 0 && q.tris <= 600000 && !q.waiting), Object.entries(res).map(([k, q]) => [k, q.tris]));
  ok('the whole area from far away is the coarsest tiles; close to the ground the cells themselves are drawn', res.whole.levels[0] === 0 && res.whole.levels[1] === 0 && res.whole.levels[3] > 0 && res.ground.levels[0] > 0 && res.down.levels[0] > 0 && res.down.levels[3] === 0, Object.entries(res).map(([k, q]) => [k, q.levels.join('/')]));
  {
    // a third of the budget: the same view comes inside it by drawing coarser tiles, not by leaving ground out
    v.FB.budget(200000); v.look(views.near[0], views.near[1]); v.FB.settle(); const q = v.FB.stats();
    ok('with a smaller budget (200,000) the busy view is drawn coarser (Q below its most) and fits', q.budget === 200000 && q.q < FB.QMAX && q.q >= FB.QMIN && q.tris <= 200000 && q.tris > 80000 && q.levels[0] < res.near.levels[0] && !q.waiting, q);
    v.FB.budget(600000); v.FB.settle();
    ok('…and back at the usual budget it is as before', v.FB.stats().tris === res.near.tris && v.FB.stats().q === FB.QMAX);
  }
  ok('only tiles in view are drawn: looking down from 60 m, a handful', res.down.drawn > 0 && res.down.drawn < 30 && res.whole.drawn === 35, [res.down.drawn, res.whole.drawn]);
  ok('what is drawn is what is visible: every drawn tile’s mesh shows, every other is hidden', (() => { const d = new Set(v.FB.objects().drawn.map(t => t.mesh)); return o.group.children.every(m => m.visible === d.has(m)) && d.size === v.FB.stats().drawn && d.size > 0; })());
  console.log('BRUSH_NODE ' + Object.entries(res).map(([k, q]) => `${k}: ${q.tris} triangles, ${q.drawn} tiles ${q.levels.join('/')}, q ${q.q.toFixed(0)}, meshed in ${q.ms} ms`).join(' | '));
  // nothing moved: update returns at once
  let n0 = v.redraws; const before = v.FB.stats();
  t0 = Date.now(); for (let k = 0; k < 20000; k++) v.FB.update(); const idleMs = Date.now() - t0;
  ok('with the camera still update() does nothing (20,000 calls in ' + idleMs + ' ms, no redraw asked, the same tiles)', idleMs < 400 && v.redraws === n0 && JSON.stringify(v.FB.stats()) === JSON.stringify(before));
  // a new view is meshed a little a frame, the coarser tiles drawn meanwhile, a redraw asked until it is whole
  const v3 = makeViewer(); await v3.FB.init(v3.opts({ version: 1, file: b64(big) }, ground));
  v3.look(views.near[0], views.near[1]); n0 = v3.redraws; v3.FB.update();
  const first = v3.FB.stats(); let frames = 1;
  while (v3.FB.stats().waiting && frames < 2000) { v3.FB.update(); frames++; }
  const last = v3.FB.stats();
  ok(`a new view: the first frame draws what is meshed (coarser) and asks for another; whole after ${frames} frames, then no more redraws`, first.waiting && first.tris > 0 && first.tris <= 600000 && v3.redraws > n0 && frames > 1 && frames < 2000 && !last.waiting && last.tris === res.near.tris && (() => { const q = v3.redraws; v3.FB.update(); v3.FB.update(); return v3.redraws === q; })(), [first, frames, last]);
  // the cache: fly across the area; the kept meshes stay bounded
  for (let k = 0; k < 60; k++) { const x = -900 + k * 30, y = -1200 + k * 40; v.look([x, y - 200, ground(x, y) + 80], [x, y, ground(x, y)]); v.FB.settle(); }
  s = v.FB.stats();
  ok('after a flight across the area the meshes kept stay near the cache size, and the scene holds no more meshes than are kept', s.meshedTris < 1500000 + 600000 && o.group.children.length <= s.meshed && s.tris <= 600000, s);
  ok('taps go through the blocks', (() => { const hits = []; o.group.children[0].raycast(new v.THREE.Raycaster(new v.THREE.Vector3(0, 0, 9000), new v.THREE.Vector3(0, 0, -1)), hits); return hits.length === 0; })());

  // ── 7. The switch and the level (driven by FlexTrees) ───────────────────────
  n0 = v.redraws; v.FB.set({ on: false });
  ok('off: the group is hidden, update does nothing; one redraw', o.group.visible === false && v.FB.stats().on === false && v.redraws === n0 + 1 && (() => { v.look(views.whole[0], views.whole[1]); const q = v.FB.stats().drawn; v.FB.update(); return v.FB.stats().drawn === q; })());
  v.FB.set({ on: true, opacity: 0.25 }); v.FB.update();
  ok('on again at 25 %: shown, the view chosen afresh, the level in the shared uniform (no rebuild)', o.group.visible && v.FB.stats().opacity === 0.25 && v.FB.stats().levels[3] === 35 && v.FB.objects().material === o.material);
  {
    // with FlexTrees: its Brush chip and level reach the blocks; a map with blocks and no trees
    const w = makeViewer(); await w.FB.init(w.opts({ version: 1, file: b64(FB.encode(Object.assign({ cell: 0.9 }, grid(100, 100, () => [200, 120])))) }));
    await w.FT.init({ THREE: w.THREE, scene: w.scene, trees: null, saved: { v: 1, see: true, brush: true }, blocks: w.FB, redraw() {} });
    ok('FlexTrees drives them: a map last used with See-through on opens the blocks at 50 %', w.FT.active() && w.FB.stats().opacity === 0.5 && w.FB.stats().on);
    w.FT.level('brush', 1); w.FT.set('brush', false);
    ok('…its level and its switch reach the blocks', w.FB.stats().opacity === 1 && w.FB.stats().on === false);
  }

  // ── 8. Which classes get a block ────────────────────────────────────────────
  {
    const g = grid(90, 30, (i) => [i < 30 ? 40 : i < 60 ? 100 : 255, 150]), file = b64(FB.encode(Object.assign({ cell: 1 }, g)));
    const w = makeViewer(); await w.FB.init(w.opts({ version: 1, file })); w.look([45, -40, 160], [45, 15, 100]); w.FB.settle();
    const cols = new Set(); w.FB.objects().drawn.forEach(t => { const c = t.mesh.geometry.attributes.color.array, nn = t.mesh.geometry.attributes.normal.array; for (let k = 0; k < c.length; k += 3) if (nn[k + 2] > 0) cols.add(c[k] + '.' + c[k + 1] + '.' + c[k + 2]); });
    ok('every class gets a block to start with (MIN_CLASS = 0), a tree and a block may share a spot (nothing is left out under crowns)', FB.MIN_CLASS === 0 && w.FB.stats().cells === 2700 && w.FB.stats().minClass === 0 && w.FB.classes().join() === 'true,true,true' && [...cols].sort().join('|') === '183.228.160|31.95.31|95.174.79' && typeof w.FB.crowns === 'undefined', [w.FB.stats().cells, [...cols]]);
    const L1 = FB.luts(C0, 0.3, 1), L2 = FB.luts(C0, 0.3, 2);
    ok('…the cut is the medium class’s own threshold (share 0.3: bytes from 77)', L1.c[76] === 0 && L1.c[77] === 2 && L1.c[153] === 3 && L2.c[152] === 0 && L2.c[153] === 3);
    const w0 = makeViewer(); await w0.FB.init(w0.opts({ version: 1, file, minClass: 1 }));
    ok('BRUSH.minClass: the classes under it start off', w0.FB.stats().cells === 1800 && w0.FB.stats().minClass === 1 && w0.FB.classes().join() === 'false,true,true');
    const w1 = makeViewer(); await w1.FB.init(w1.opts({ version: 1, file, classes: [{ name: 'brush', min: 0.5, colour: '336633' }] }));
    ok('a map with one class draws that class', w1.FB.stats().cells === 900 && w1.FB.stats().minClass === 0);
  }

  // ── 9. Odd files ────────────────────────────────────────────────────────────
  { const w = makeViewer(); const rr = await w.FB.init(w.opts({ version: 1, file: Buffer.from('not a brush file at all, but long enough to read a header from').toString('base64') }));
    ok('a file that is not one: the viewer carries on, nothing in the scene, idle again', rr === false && w.scene.children.length === 0 && !w.FB.active() && (await w.FB.whenReady()) === false); w.FB.update(); }
  { const w = makeViewer(); await w.FB.init(w.opts({ version: 1, file: b64(FB.encode(Object.assign({ cell: 0.9 }, grid(30, 30)))) })); w.look([0, -50, 150], [10, 10, 100]); w.FB.settle();
    ok('a grid with no brush: active, nothing drawn', w.FB.loaded() && w.FB.stats().cells === 0 && w.FB.stats().tris === 0 && w.FB.objects().group.children.length === 0); }

  // ── 10. The looks (the hub) ─────────────────────────────────────────────────
  {
    const g = grid(40, 40, (i, j) => [200, 120]), file = b64(FB.encode(Object.assign({ cell: 1, x0: 5, y0: 7 }, g)));
    const w = makeViewer(), L = w.ctx.window.FlexBrushLooks, log = [];
    ok('the registry is there, empty of any look this file makes', L && typeof L === 'object' && !('blocks' in L));
    ok('no brush: look() is the blocks and switching does nothing', w.FB.look() === 'blocks' && w.FB.look('toy') === 'blocks');
    let got = null;
    L.toy = { create(ctx) { got = ctx; const grp = new ctx.THREE.Group(); let lv = -1, n = 0, waiting = 3;
      return { group: grp, update(cam) { log.push('update'); n++; if (waiting) { waiting--; ctx.wake(); } w.sawCam = cam; }, setLevel(v) { lv = v; log.push('level ' + v); }, dispose() { log.push('dispose'); }, stats() { return { triangles: 1234, waiting: waiting > 0, level: lv, updates: n }; } }; } };
    L.broken = { create() { throw new Error('made to fail'); } };
    L.half = { create(ctx) { return { group: new ctx.THREE.Group() }; } };
    let saved = [];
    await w.FB.init(Object.assign(w.opts({ version: 1, file }, (x, y) => 100 + x), { onLook: n => saved.push(n) }));
    w.look([20, -40, 160], [20, 20, 100]); w.FB.settle();
    const blocksTris = w.FB.stats().tris;
    ok('with no bushes file loaded (DEF_LOOK is not registered) a map starts with the blocks, nothing created', FB.DEF_LOOK === 'bushes' && w.FB.look() === 'blocks' && w.FB.stats().look === 'blocks' && w.FB.stats().shown === null && got === null && blocksTris > 0);
    for (const bad of ['nobody', 'broken', 'half', '', null, 42, 'constructor', '__proto__']) {
      const r = w.FB.look(bad);
      ok('look ' + JSON.stringify(bad) + ': the blocks stay, no error', r === 'blocks' && w.FB.look() === 'blocks' && w.FB.objects().group.visible && w.FB.objects().look === null && w.scene.children.length === 1, r);
    }
    ok('…and nothing was saved for a switch that did not happen', saved.length === 0);
    w.FB.set({ opacity: 0.25 });
    const r1 = w.FB.look('toy');
    const o = w.FB.objects();
    ok('a registered look is put on: its group in the scene, the blocks hidden, the level handed over, saved', r1 === 'toy' && w.FB.look() === 'toy' && o.look && o.look.group.parent === w.scene && o.look.group.visible && !o.group.visible && log.join() === 'level 0.25' && saved.join() === 'toy', [r1, log, saved]);
    const F = got && got.grid;
    ok('the ctx: THREE, the grid as parsed (rows from the south), classes, the ground, the camera, wake, bayer4, dither, budget', got.THREE === w.THREE && F.nx === 40 && F.ny === 40 && F.cell === 1 && F.x0 === 5 && F.y0 === 7 && F.top === 2.5 && F.share.length === 1600 && F.share[41] === 200 && F.height[41] === 120 &&
      got.classes.map(c => c.name + ':' + c.min + ':' + c.colour + ':' + c.cut + ':' + c.rgb.join('.')).join('|') === 'light:0.1:b7e4a0:26:183.228.160|medium:0.3:5fae4f:77:95.174.79|dense:0.6:1f5f1f:153:31.95.31' &&
      got.groundZ(3, 9) === 103 && got.camera === w.camera && typeof got.wake === 'function' && got.bayer4(1, 1) === FB.bayer4(1, 1) && got.bayer4(2, 3) === w.FT.bayer4(2, 3) && got.dither === w.FT.dither &&
      got.budget.triangles === FB.DETAILS.far.triangles && got.budget.far === 360 && got.budget.simple === true && FB.LOOK_BUDGET === 900000 && got.budget.cache === Math.round(got.budget.triangles * FB.CACHE_X) && got.budget.buildMs > 0, got && got.classes);
    const q = got.toScene(1, 2, 3);
    ok('toScene is the identity (x east, y north, z up), a THREE.Vector3', q.isVector3 && q.x === 1 && q.y === 2 && q.z === 3);
    const r0 = w.redraws; got.wake();
    ok('wake asks for a frame', w.redraws === r0 + 1);
    log.length = 0; w.FB.update();
    ok('update goes to the look with the camera, the blocks draw nothing', log.join() === 'update' && w.sawCam === w.camera && w.FB.objects().drawn.length === 0 && w.FB.stats().tris === 1234 && w.FB.stats().shown.triangles === 1234 && w.FB.stats().waiting === true);
    log.length = 0; w.FB.settle();
    ok('settle without a settle() of the look: update until nothing is waiting', log.length === 2 && w.FB.stats().waiting === false, log);
    log.length = 0; w.FB.set({ opacity: 0.75 }); w.FB.set({ on: false }); w.FB.update();
    ok('the chip drives the look: the level, and off hides it and stops its updates', log.join() === 'level 0.75' && !o.look.group.visible && !w.FB.objects().group.visible, log);
    w.FB.set({ on: true });
    ok('…on again: the look, not the blocks', o.look.group.visible && !w.FB.objects().group.visible);
    log.length = 0;
    ok('the same look again: nothing happens', w.FB.look('toy') === 'toy' && log.length === 0 && saved.length === 1);
    const r2 = w.FB.look('nobody');
    ok('an unknown name while a look is on: back to the blocks, the look disposed and out of the scene', r2 === 'blocks' && log.join() === 'dispose' && o.look.group.parent === null && w.FB.objects().group.visible && w.FB.objects().look === null && saved.join() === 'toy,blocks', [r2, log, saved]);
    w.FB.settle();
    ok('…and the blocks draw as before', w.FB.stats().tris === blocksTris && w.FB.stats().look === 'blocks');
    // the state: kept with the trees' and the brush's, put on again at the next start
    const tr = { blocks: w.FB, THREE: w.THREE, scene: w.scene, trees: null, saved: undefined, redraw() {} };
    await w.FT.init(tr);
    ok('the state has the look in use', w.FT.serialize().look === 'blocks');
    w.FB.look('toy');
    const ser = JSON.parse(JSON.stringify(w.FT.serialize()));
    ok('…switched: saved as that', ser.look === 'toy' && ser.v === w.FT.STATE_V && ser.brush === true);
    const w2 = makeViewer(); w2.ctx.window.FlexBrushLooks.toy = L.toy; log.length = 0;
    const pr = w2.FB.init(w2.opts({ version: 1, file }));
    w2.FT.init({ blocks: w2.FB, THREE: w2.THREE, scene: w2.scene, trees: null, saved: ser, redraw() {} });
    ok('a new start with that state: asked before the grid is loaded, the name is kept', w2.FB.look() === 'toy' && !w2.FB.loaded());
    await pr;
    ok('…and put on at load, at the saved level', w2.FB.look() === 'toy' && w2.FB.stats().look === 'toy' && log.join() === 'level 0.5' && !w2.FB.objects().group.visible && w2.FT.serialize().look === 'toy' && w2.FT.objects().blocks === true, log);
    const w3 = makeViewer();
    const pr3 = w3.FB.init(w3.opts({ version: 1, file }));
    await w3.FT.init({ blocks: w3.FB, THREE: w3.THREE, scene: w3.scene, trees: null, saved: Object.assign({}, ser, { look: 'bushes' }), redraw() {} });
    await pr3;
    ok('a saved look that is not registered (its file is not in this build): the blocks, no error', w3.FB.look() === 'blocks' && w3.FB.objects().group.visible && w3.FT.serialize().look === 'blocks');
    ok('restore keeps a look name, drops a wrong one', w.FT.restore({ v: w.FT.STATE_V, look: 'bushes' }).look === 'bushes' && w.FT.restore({ v: w.FT.STATE_V, look: 'blanket' }).look === undefined && w.FT.restore({ v: w.FT.STATE_V, look: 'blocks' }).look === undefined && w.FT.restore({ v: w.FT.STATE_V, look: 7 }).look === undefined && w.FT.restore({ v: 1, see: true, look: 'bushes' }).look === 'bushes' && w.FT.restore(null).look === undefined);
    log.length = 0; const lg = w2.FB.objects().look.group;
    await w2.FB.init(w2.opts(null));
    ok('the viewer started again without brush: the look is disposed and out of the scene', log.join() === 'dispose' && lg.parent === null && w2.FB.look() === 'blocks', log);
  }

  // ── 11. The classes shown (Light / Medium / Dense) ──────────────────────────
  {
    const g = grid(90, 30, (i) => [i < 30 ? 40 : i < 60 ? 100 : 255, 150]), file = b64(FB.encode(Object.assign({ cell: 1 }, g)));
    const w = makeViewer(), L = w.ctx.window.FlexBrushLooks, log = []; let saved = 0;
    ok('no brush: classes() is null, setting does nothing', w.FB.classes() === null && w.FB.classes([true, false, true]) === null);
    ok('FlexBrush.classes(list) and (null) still parse a class list', w.FB.classes(null).length === 3 && w.FB.classes([{ name: 'a', min: 0.5, colour: '112233' }])[0].cut === 128);
    await w.FB.init(Object.assign(w.opts({ version: 1, file }), { onLook: () => saved++ }));
    w.look([45, -40, 160], [45, 15, 100]); w.FB.settle();
    const colours = () => { const c = new Set(); w.FB.objects().drawn.forEach(t => { const a = t.mesh.geometry.attributes.color.array, nn = t.mesh.geometry.attributes.normal.array; for (let k = 0; k < a.length; k += 3) if (nn[k + 2] > 0) c.add(a[k] + '.' + a[k + 1] + '.' + a[k + 2]); }); return [...c].sort().join('|'); };
    ok('all on to start with', w.FB.classes().join() === 'true,true,true' && w.FB.stats().classesOn.join() === 'true,true,true' && w.FB.stats().cells === 2700);
    let r = w.FB.classes([false, true, true]); w.FB.settle();
    ok('light off: the blocks of the light cells are gone at once, saved', r.join() === 'false,true,true' && w.FB.stats().cells === 1800 && colours() === '31.95.31|95.174.79' && saved === 1, [r, w.FB.stats().cells, colours(), saved]);
    r = w.FB.classes([false, false, true]); w.FB.settle();
    ok('dense only', w.FB.stats().cells === 900 && colours() === '31.95.31' && saved === 2);
    r = w.FB.classes([true, false, false]); w.FB.settle();
    ok('light only (any mix, not a threshold)', w.FB.stats().cells === 900 && colours() === '183.228.160');
    r = w.FB.classes([false, false, false]); w.FB.settle();
    ok('all off: nothing drawn', w.FB.stats().cells === 0 && w.FB.stats().tris === 0);
    const s0 = saved; w.FB.classes([false, false, false]);
    ok('the same again: nothing happens, nothing saved', saved === s0);
    r = w.FB.classes([true]); w.FB.settle();
    ok('a short or odd list changes only what it names', r.join() === 'true,false,false' && w.FB.classesOn([undefined, 'x', true]).join() === 'true,false,true');
    w.FB.classes([true, true, true]); w.FB.settle();
    ok('all on again: as at the start', w.FB.stats().cells === 2700 && colours() === '183.228.160|31.95.31|95.174.79');
    ok('classInfo for the chips: names, on, a colour a class', (() => { const ci = w.FB.classInfo(); return ci.length === 3 && ci.map(c => c.name).join() === 'light,medium,dense' && ci.every(c => c.on && /^rgb/.test(c.colour)) && ci[0].colour === 'rgb(183,228,160)'; })());
    // a look with setClasses is told; one without is made again with ctx.classesOn
    let made = 0;
    L.can = { create(ctx) { made++; log.push('create ' + ctx.classesOn.join('')); return { group: new ctx.THREE.Group(), update() {}, setLevel() {}, setClasses(v) { log.push('set ' + v.join('')); }, dispose() { log.push('dispose'); }, stats() { return { triangles: 0 }; } }; } };
    L.cannot = { create(ctx) { made++; log.push('create ' + ctx.classesOn.join('')); return { group: new ctx.THREE.Group(), update() {}, setLevel() {}, dispose() { log.push('dispose'); }, stats() { return { triangles: 0 }; } }; } };
    w.FB.look('can');
    ok('a look is told the classes once after create (after setLevel)', log.join() === 'create truetruetrue,set truetruetrue', log);
    log.length = 0; w.FB.classes([true, false, true]);
    ok('…and on every change, without being made again', log.join() === 'set truefalsetrue' && made === 1 && w.FB.look() === 'can', log);
    w.FB.look('cannot'); log.length = 0; const grp = w.FB.objects().look.group;
    w.FB.classes([false, false, true]);
    ok('a look without setClasses is disposed and created again with the new ctx.classesOn', log.join() === 'dispose,create falsefalsetrue' && w.FB.look() === 'cannot' && grp.parent === null && w.FB.objects().look.group.parent === w.scene && !w.FB.objects().group.visible, log);
    ok('classInfo with a look on: one green, more solid a class', (() => { const ci = w.FB.classInfo(); return /^rgba/.test(ci[0].colour) && ci[0].colour !== ci[2].colour && !ci[0].on && ci[2].on; })());
    // the state
    await w.FT.init({ blocks: w.FB, THREE: w.THREE, scene: w.scene, trees: null, saved: undefined, redraw() {} });
    const ser = JSON.parse(JSON.stringify(w.FT.serialize()));
    ok('the classes shown are in the saved state', ser.classesOn.join() === 'false,false,true');
    const w2 = makeViewer(); const pr = w2.FB.init(w2.opts({ version: 1, file }));
    w2.FT.init({ blocks: w2.FB, THREE: w2.THREE, scene: w2.scene, trees: null, saved: ser, redraw() {} });
    ok('a new start: asked before the grid is loaded, kept', !w2.FB.loaded() && w2.FB.classes().join() === 'false,false,true');
    await pr;
    ok('…and put on at load', w2.FB.classes().join() === 'false,false,true' && w2.FB.stats().cells === 900 && w2.FT.serialize().classesOn.join() === 'false,false,true');
    ok('restore keeps a list of booleans only', w.FT.restore({ v: w.FT.STATE_V, classesOn: [true, false] }).classesOn.join() === 'true,false' && w.FT.restore({ v: w.FT.STATE_V, classesOn: [1, 0] }).classesOn === undefined && w.FT.restore({ v: w.FT.STATE_V, classesOn: 'x' }).classesOn === undefined);
    // the chips row
    const rows = []; w2.FT.sheet({ head: t => rows.push('H:' + t), chips: c => rows.push(c) });
    const row = rows[2];
    ok('Display: under the Brush chip a row of one chip a class, with its state', rows[0] === 'H:Brush' && rows[1].length === 1 && row && row.length === 3 && row.map(x => x[1] + ':' + x[2]).join() === 'Light:false,Medium:false,Dense:true' && typeof row[0][4].attach === 'function', rows);
    row[1][3](true);
    ok('…a tap switches that class at once', w2.FB.classes().join() === 'false,true,true' && w2.FB.stats().cells === 1800);
    const fake = k => ({ style: {}, className: 'sh-chip', firstChild: { style: {} }, parentNode: { style: {} } });
    const els = row.map((x, k) => { const c = fake(k); x[4].attach(c); return c; });
    await Promise.resolve(); await Promise.resolve();
    ok('…the chips are small, each with a swatch; the row is as many columns as classes', els.every(c => /sh-chip-class/.test(c.className) && c.firstChild.style.background) && els[0].parentNode.style.gridTemplateColumns === 'repeat(3, 1fr)' && els[0].parentNode.style.display === '');
    w2.FT.set('brush', false);
    ok('…and the row is hidden while Brush is off, back when it is on', els[0].parentNode.style.display === 'none' && (w2.FT.set('brush', true), els[0].parentNode.style.display === ''));
    const w4 = makeViewer(); await w4.FB.init(w4.opts({ version: 1, file, classes: [{ name: 'brush', min: 0.5, colour: '336633' }] })); await w4.FT.init({ blocks: w4.FB, THREE: w4.THREE, scene: w4.scene, trees: null, redraw() {} });
    const rows4 = []; w4.FT.sheet({ head: t => rows4.push(t), chips: c => rows4.push(c) });
    ok('a map with one class has no such row', rows4.length === 2);
  }

  // ── Brush detail (⋯ More): three steps of reach and triangle limit, and the simpler bush far away ──
  {
    const D = FB.DETAILS;
    ok('the three steps: Normal 180 m / 0.9 M, Far 360 m / 1.8 M, Very far 600 m / 3 M; a map starts at Far', FB.DETAIL_NAMES.join() === 'normal,far,very' && FB.DEF_DETAIL === 'far' &&
      D.normal.far === 180 && D.normal.triangles === 900000 && D.far.far === 360 && D.far.triangles === 1800000 && D.very.far === 600 && D.very.triangles === 3000000 &&
      [D.normal.label, D.far.label, D.very.label].join() === 'Normal,Far,Very far' && near(FB.CACHE_X, 10 / 3, 1e-9));
    const file = b64(FB.encode(Object.assign({ cell: 1 }, grid(40, 40, () => [200, 120]))));
    const mk = async (extra) => {
      const w = makeViewer(), log = [], saved = [], made = [];
      w.ctx.window.FlexBrushLooks.bushes = { create(ctx) { made.push(ctx.budget); return { group: new ctx.THREE.Group(), update() {}, setLevel() {}, setClasses() {}, dispose() {}, stats() { return { triangles: 0 }; }, limits(o) { log.push(o); return o; } }; } };
      const r = await w.FB.init(Object.assign(w.opts({ version: 1, file }), { save: p => saved.push(p) }, extra || {}));
      return { w, log, saved, made, r };
    };
    const none = makeViewer();
    ok('no brush: detail() is the default, setting does nothing, no rows in More', none.FB.detail() === 'far' && none.FB.detail('very') === 'far' && none.FB.simpleFar() === true && none.FB.simpleFar(false) === true && none.FB.sheet({ head() { throw new Error('no'); } }) === null && none.FB.sheetLow({ row() { throw new Error('no'); } }) === null);
    let a = await mk();
    ok('nothing saved: Far, the simpler bush on; the look is created with those numbers; nothing written', a.w.FB.look() === 'bushes' && a.w.FB.detail() === 'far' && a.w.FB.simpleFar() === true && a.made.length === 1 && a.made[0].triangles === 1800000 && a.made[0].far === 360 && a.made[0].cache === 6000000 && a.made[0].simple === true && a.saved.length === 0 && a.w.FB.stats().detail === 'far' && a.w.FB.stats().simpleFar === true, a.made);
    let r0 = a.w.redraws, v = a.w.FB.detail('very');
    ok('detail("very"): at once to the look (3 M, 600 m, the cache 3.33 times), one frame asked for, saved', v === 'very' && a.w.FB.detail() === 'very' && a.log.length === 1 && a.log[0].budget === 3000000 && a.log[0].far === 600 && a.log[0].cacheTris === 10000000 && a.log[0].simple === true && a.w.redraws > r0 && JSON.stringify(a.saved) === '[{"brushDetail":"very"}]' && a.made.length === 1, [a.log, a.saved]);
    v = a.w.FB.detail('normal');
    ok('detail("normal"): today\'s numbers', v === 'normal' && a.log[1].budget === 900000 && a.log[1].far === 180 && a.log[1].cacheTris === 3000000 && a.saved[1].brushDetail === 'normal');
    const n0 = a.log.length, s0 = a.saved.length;
    for (const bad of ['', 'huge', null, 42, 'constructor', '__proto__', 'normal']) a.w.FB.detail(bad);
    ok('the same step again, or a name that is no step: nothing happens, nothing saved', a.w.FB.detail() === 'normal' && a.log.length === n0 && a.saved.length === s0);
    r0 = a.w.redraws; v = a.w.FB.simpleFar(false);
    ok('simpleFar(false): at once to the look, a frame, saved; the step stays', v === false && a.w.FB.simpleFar() === false && a.log[n0].simple === false && a.log[n0].budget === 900000 && a.w.redraws > r0 && JSON.stringify(a.saved[s0]) === '{"brushSimple":false}' && a.w.FB.detail() === 'normal');
    a.w.FB.simpleFar(false); a.w.FB.simpleFar('yes'); a.w.FB.simpleFar();
    ok('…the same again or not a boolean: nothing', a.log.length === n0 + 1 && a.saved.length === s0 + 1);
    // the look put on again (another look and back) keeps the choice
    a.w.FB.look('blocks'); a.w.FB.look('bushes');
    ok('the look made again gets the chosen numbers', a.made.length === 2 && a.made[1].triangles === 900000 && a.made[1].far === 180 && a.made[1].simple === false);
    // FlexBrush.budget() (tests, trying numbers) still wins over the step
    a.w.FB.budget(123456, 400000); a.w.FB.look('blocks'); a.w.FB.look('bushes');
    ok('FlexBrush.budget() still sets other numbers for a look', a.made[2].triangles === 123456 && a.made[2].cache === 400000 && a.made[2].far === 180);
    // the saved choice at the next start
    let b = await mk({ detail: 'very', simpleFar: false });
    ok('a saved choice is put on at the start (very far, simple off), not written again', b.w.FB.detail() === 'very' && b.w.FB.simpleFar() === false && b.made[0].triangles === 3000000 && b.made[0].far === 600 && b.made[0].cache === 10000000 && b.made[0].simple === false && b.saved.length === 0);
    b = await mk({ detail: 'nonsense', simpleFar: 'x' });
    ok('a saved value that is no step: Far; anything but false: on', b.w.FB.detail() === 'far' && b.w.FB.simpleFar() === true);
    // the rows in More
    const mkSeg = () => { const kids = [], seg = { children: kids, ownerDocument: { createElement: () => ({ style: {} }) }, parentNode: { insertBefore(n, ref) { seg.after = n; seg.ref = ref; } }, nextSibling: 'next' }; return seg; };
    let heads = [], segArgs = null, seg = mkSeg(), re = 0;
    const got = b.w.FB.sheet({ head: t => heads.push(t), seg: (opts, act, pick) => { segArgs = { opts, act, pick }; return seg; }, rerender: () => re++ });
    ok('More: a "Brush detail" choice of three, the step in use lit, a line of what it does under it', got === seg && heads.join() === 'Brush detail' && segArgs.opts.join() === 'Normal,Far,Very far' && segArgs.act === 1 && seg.id === 'brush-detail' && seg.after.id === 'brush-detail-hint' && /bush/.test(seg.after.textContent) && seg.ref === 'next');
    segArgs.pick(2);
    ok('…a tap takes the step and draws the sheet again', b.w.FB.detail() === 'very' && re === 1 && b.saved[0].brushDetail === 'very');
    let rowArgs = null; const rowEl = {};
    const gotRow = b.w.FB.sheetLow({ row: (icon, title, sub, fn, active) => { rowArgs = { icon, title, sub, fn, active }; return rowEl; }, rerender: () => re++ });
    ok('More: a row "Simpler bushes far away", lit when on', gotRow === rowEl && rowEl.id === 'brush-simple' && rowArgs.title === 'Simpler bushes far away' && rowArgs.active === true && /^on/.test(rowArgs.sub));
    rowArgs.fn();
    ok('…a tap switches it and draws the sheet again', b.w.FB.simpleFar() === false && re === 2 && b.saved[1].brushSimple === false);
    b.w.FB.sheetLow({ row: (icon, title, sub, fn, active) => { rowArgs = { sub, active }; return {}; } });
    ok('…and then it says off', rowArgs.active === false && /^off/.test(rowArgs.sub));
    // the real look takes the numbers
    const c = makeViewer(); vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'brush-bushes.js'), 'utf8'), c.ctx);
    await c.FB.init(c.opts({ version: 1, file })); c.look([20, -40, 160], [20, 20, 100]); c.FB.settle();
    const lk = c.FB.objects().look, l1 = lk.limits();
    c.FB.detail('very'); const l2 = lk.limits(); c.FB.simpleFar(false); const l3 = lk.limits(); c.FB.detail('normal'); const l4 = lk.limits();
    ok('the bushes look: the step\'s reach, limit and cache (in bushes held), the simpler bush', c.FB.look() === 'bushes' && l1.budget === 1800000 && l1.far === 360 && l1.simple === true && l2.budget === 3000000 && l2.far === 600 && l2.cache === 400000 && l3.simple === false && l4.budget === 900000 && l4.far === 180 && l4.cache === 120000 && l4.simple === false, [l1, l2, l3, l4]);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
