// Test for the viewer's trees and brush module (viewer_build/libs/trees.js), without a browser.
//
// Loads the real three.js r128 the viewer ships and the module into one context, with a made-up TREES
// whose trees.bin is inline base64 built here, then checks: nothing at all when TREES is null; the
// binary layout; one instanced mesh per kind and ground tile, with each tree's matrix (its radius and
// height on the stock solid, its foot's place) and tint; the three detail levels (fewer triangles);
// the switches (Trees, Brush) and their opacity levels (an ordered dither: 4 x 4 Bayer, 16 steps), the saved
// choices and the older ones migrated (See-through on -> 50 %, off -> 100 %); the dither patch finds its anchor
// in three's own Lambert shader; the brush handed to the brush blocks when the map has them; bounds per tile;
// a 100,000-tree set is filed in a fraction of a second.
// Synthetic numbers only.
//
//   node tools/test_viewer_trees.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let fail = 0, pass = 0;
function ok(label, cond, info) {
  if (cond) { pass++; return; }
  fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 400) : ''));
}
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

// [x, y, z, height, radius m, kind, tint]: kind 0 cone, 1 round crown, 2 low mound
const TREES = [
  [10, 20, 500, 18, 3.2, 0, 0], [40, 22, 503, 25, 4.1, 0, 255], [70, 90, 498, 9, 2.5, 1, 128],
  [15, 80, 501, 1.2, 1.8, 2, 10], [16, 82, 501, 0.9, 2.4, 2, 200], [90, 10, 505, 14, 5.0, 1, 60],
];
function treesBin(list) {
  const n = list.length, b = Buffer.alloc(8 + n * 20);
  b.write('FTR1', 0, 'latin1'); b.writeUInt32LE(n, 4);
  list.forEach((t, i) => { const o = 8 + i * 20; b.writeFloatLE(t[0], o); b.writeFloatLE(t[1], o + 4); b.writeFloatLE(t[2], o + 8); b.writeFloatLE(t[3], o + 12);
    b.writeUInt16LE(Math.round(t[4] * 100), o + 16); b.writeUInt8(t[5], o + 18); b.writeUInt8(t[6], o + 19); });
  return b;
}
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const treesObj = (list, detail) => ({ version: 1, count: list.length, detail: detail || 0, file: treesBin(list).toString('base64') });

function makeViewer() {
  const ctx = { console: { warn() {}, log: console.log, error: console.error, info() {} }, Math, Promise, window: {} };
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'three.min.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'trees.js'), 'utf8'), ctx);
  const THREE = ctx.THREE, FT = ctx.window.FlexTrees;
  const v = { ctx, THREE, FT, scene: new THREE.Scene(), redraws: 0, decoded: 0 };
  v.opts = (tr, saved) => ({ THREE, scene: v.scene, trees: tr, saved,
    isAssetRef: s => typeof s === 'string' && s.length < 512 && /\.(glb|jpe?g|png|webp|bin)$/i.test(s),
    b64ToArrayBuffer: s => { v.decoded++; return ab(Buffer.from(s, 'base64')); },
    redraw: () => { v.redraws++; } });
  return v;
}

(async () => {
  // ── 1. A normal export: TREES is null, nothing happens ──────────────────────
  let v = makeViewer();
  ok('the module defines FlexTrees', !!v.FT && typeof v.FT.init === 'function' && typeof v.FT.sheet === 'function');
  for (const nothing of [null, undefined, {}, { version: 1, count: 5 }]) {
    const r = await v.FT.init(v.opts(nothing));
    ok('TREES ' + JSON.stringify(nothing) + ': not active, nothing in the scene, nothing decoded', r === false && !v.FT.active() && v.scene.children.length === 0 && v.decoded === 0 && v.FT.objects() === null && v.FT.serialize() === undefined);
  }
  let rows = 0;
  v.FT.sheet({ head: () => rows++, chips: () => rows++ }); v.FT.set('trees', false);
  ok('…no rows in Display, and a switch does nothing', rows === 0);
  const h = fs.readFileSync(path.join(root, 'viewer_build', 'viewer.html'), 'utf8');
  ok('the viewer template has the placeholder once, with the unfilled-template guard, the script line and the hooks', h.split('PLACEHOLDER_TREES_JSON').length === 2 && h.includes("<script>window['PLACEHOLDER_' + 'TREES_JSON'] = null;</script>\n<script>const TREES = PLACEHOLDER_TREES_JSON;</script>") &&
    h.includes('<script src="libs/trees.js"></script>') && h.includes('FlexTrees.init(') && h.includes('FlexTrees.sheet(') && h.includes('FlexTrees.serialize()'));

  // ── 2. The pure parts ───────────────────────────────────────────────────────
  const FT = v.FT;
  const T = FT.parse(ab(treesBin(TREES)));
  ok('FTR1: count, place, height, radius in cm, kind and tint read back', T.n === 6 && T.f32[5] === 40 && T.f32[7] === 503 && T.f32[8] === 25 && T.u16[1 * 10 + 8] === 410 && T.u8[2 * 20 + 18] === 1 && T.u8[1 * 20 + 19] === 255);
  const throws = f => { try { f(); return false; } catch (_) { return true; } };
  ok('a wrong file, an empty one and one cut short are refused; no trees is fine', throws(() => FT.parse(ab(Buffer.from('RWP1\0\0\0\0')))) && throws(() => FT.parse(new ArrayBuffer(0))) && throws(() => FT.parse(ab(treesBin(TREES)).slice(0, 50))) && FT.parse(ab(treesBin([]))).n === 0);
  const tri = [0, 1, 2].map(k => [0, 1, 2].map(d => FT.triangles(k, d)));
  ok('the stock solids are tiny (cone about 12 triangles, crown about 16, mound about 8 at full detail)', tri[0][0] === 12 && tri[1][0] >= 14 && tri[1][0] <= 20 && tri[2][0] >= 8 && tri[2][0] <= 12, tri);
  ok('…fewer sides at detail 1, fewest at detail 2', tri.every(t => t[0] > t[1] && t[1] >= t[2] && t[2] >= 4) && tri.some(t => t[1] > t[2]), tri);
  for (const k of [0, 1, 2]) for (const d of [0, 1, 2]) {
    const g = new v.THREE.BufferGeometry(); g.setAttribute('position', new v.THREE.BufferAttribute(FT.solidFor(k, d), 3)); g.computeBoundingBox();
    const b = g.boundingBox;
    ok(`solid ${FT.KINDS[k]} detail ${d}: within radius 1, from just under the foot to height 1`, b.max.z === 1 && b.min.z < 0 && b.min.z > -0.1 && b.max.x <= 1.0001 && b.min.x >= -1.0001 && b.max.x > 0.8, [b.min, b.max]);
  }
  ok('saved choices: this version; odd values fall back to the defaults; levels are whole sixteenths, never under one', (() => {
    const a = FT.restore({ v: FT.STATE_V, trees: false, brush: 'x', treesOp: 0.26, brushOp: 0, extra: 1 }), b = FT.restore({ trees: false, treesOp: 1 }), c = FT.restore(null), e = FT.restore({ v: FT.STATE_V, treesOp: 'x', brushOp: 7 });
    return FT.STATE_V === 2 && a.trees === false && a.brush === true && a.treesOp === 0.25 && a.brushOp === 1 / 16 && !('extra' in a) && !('see' in a) && b.trees && b.treesOp === 0.5 && c.trees && c.brush && c.treesOp === 0.5 && c.brushOp === 0.5 && e.treesOp === 0.5 && e.brushOp === 1;
  })());
  ok('choices saved before the levels (version 1): See-through on becomes 50 %, off 100 %, the switches are kept', (() => {
    const a = FT.restore({ v: 1, trees: false, brush: true, see: true, crown: true }), b = FT.restore({ v: 1, trees: true, brush: false, see: false, crown: false }), c = FT.restore({ v: 1, brush: false });
    return a.trees === false && a.brush === true && a.crown === true && a.treesOp === 0.5 && a.brushOp === 0.5 && b.trees && b.brush === false && b.treesOp === 1 && b.brushOp === 1 && !('see' in a) && !('see' in b) && c.brush === false && c.treesOp === 0.5;
  })());
  // the ordered dither: ranks 0..15 once each in every 4 x 4; level k/16 keeps exactly k of 16 pixels; each level keeps the one below it
  const ranks = []; for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ranks.push(FT.bayer4(x, y));
  ok('the Bayer pattern: 4 x 4, every rank 0..15 once, the same in every 4 x 4 of the screen', ranks.slice().sort((a, b) => a - b).join() === [...Array(16).keys()].join() && FT.bayer4(5, 6) === FT.bayer4(1, 2) && FT.bayer4(0, 0) === 0, ranks);
  ok('16 steps: level k / 16 keeps k pixels of 16 (100 % all, 50 % eight, 25 % four)', [...Array(17).keys()].every(k => FT.kept(k / 16) === k) && FT.kept(1) === 16 && FT.kept(0.5) === 8 && FT.kept(0.25) === 4);
  ok('50 % is the checkerboard the screen door was', (() => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((FT.bayer4(x, y) < 8) !== ((x + y) % 2 === 0)) return false; return true; })());
  ok('the shader’s arithmetic gives the same ranks as bayer4', (() => {
    const fr = v => v - Math.floor(v), b2 = (x, y) => { x = Math.floor(x); y = Math.floor(y); return fr(x / 2 + y * y * 0.75); }, b4 = (x, y) => b2(0.5 * x, 0.5 * y) * 0.25 + b2(x, y);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (Math.abs(b4(x + 0.5, y + 0.5) * 16 - FT.bayer4(x, y)) > 1e-9) return false; return true; })());
  ok('a level is drawn in whole sixteenths, at least one, at most all', FT.quant(0.5) === 0.5 && FT.quant(0.26) === 0.25 && FT.quant(0) === 1 / 16 && FT.quant(-3) === 1 / 16 && FT.quant(9) === 1 && FT.quant(0.97) === 1);

  // ── 3. With TREES: what is made ─────────────────────────────────────────────
  v = makeViewer();
  const r = await v.FT.init(v.opts(treesObj(TREES)));
  let o = v.FT.objects();
  ok('active and loaded; one group in the scene; one redraw asked for', r === true && v.FT.active() && v.FT.loaded() && v.scene.children.length === 1 && o.group.parent === v.scene && v.redraws === 1);
  ok('one instanced mesh per kind (a small set is one ground tile): 2 cones, 2 round crowns, 2 mounds', o.tiles === 1 && o.meshes.map(m => m.length).join() === '1,1,1' && o.count.join() === '2,2,2' && o.meshes.every(m => m[0].isInstancedMesh && m[0].count === 2));
  ok('defaults: trees and brush shown, both at 50 %', o.meshes.every(m => m[0].visible) && o.op.join() === '0.5,0.5' && o.blocks === false && JSON.stringify(v.FT.state()) === JSON.stringify({ trees: true, brush: true, treesOp: 0.5, brushOp: 0.5, crown: false }));
  const mat4 = (mesh, i) => Array.from(mesh.instanceMatrix.array.slice(i * 16, i * 16 + 16));
  const m0 = mat4(o.meshes[0][0], 1);
  ok('a tree’s matrix: the stock solid stretched to its radius (x, y) and height (z), stood at its foot', near(m0[0], 4.1) && near(m0[5], 4.1) && near(m0[10], 25) && m0[12] === 40 && m0[13] === 22 && m0[14] === 503 && m0[15] === 1 && m0[1] === 0 && m0[4] === 0, m0);
  const mm = mat4(o.meshes[2][0], 0);
  ok('a mound likewise (1.8 m wide, 1.2 m tall)', near(mm[0], 1.8) && near(mm[10], 1.2) && mm[12] === 15 && mm[14] === 501, mm);
  const col = (mesh, i) => Array.from(mesh.instanceColor.array.slice(i * 3, i * 3 + 3));
  const c0 = col(o.meshes[0][0], 0), c1 = col(o.meshes[0][0], 1), cr = col(o.meshes[1][0], 0), cb = col(o.meshes[2][0], 0);
  ok('greens: every kind greener than red or blue; the tint byte makes a tree a little darker or lighter', [c0, c1, cr, cb].every(c => c[1] > c[0] && c[1] > c[2]) && c1[1] > c0[1] * 1.3 && c1[1] < c0[1] * 1.7 && near(c1[0] / c0[0], c1[1] / c0[1], 1e-3), [c0, c1]);
  ok('conifers are the darkest green, brush the lightest and most olive', c0[1] / 0.78 < cr[1] / (0.78 + 0.38 * 128 / 255) && cb[0] / cb[1] > c0[0] / c0[1]);
  const mesh = o.meshes[0][0], mtl = mesh.material;
  ok('drawn as ordinary solid surfaces: depth test and depth write on, no blending, lit, one shared material per kind', mtl.isMeshLambertMaterial && mtl.depthTest && mtl.depthWrite && mtl.transparent === false && o.meshes[1][0].material !== mtl);
  ok('the geometry is the cone’s 12 triangles with normals', mesh.geometry.attributes.position.count === 36 && !!mesh.geometry.attributes.normal && !mesh.geometry.index);
  const sph = mesh.geometry.boundingSphere, box = mesh.geometry.boundingBox;
  ok('the tile carries its own bounds (both cones inside, top to under the foot), so trees out of view are skipped', sph && box && near(box.min.x, 10 - 3.2) && near(box.max.x, 40 + 4.1) && near(box.max.z, 503 + 25) && box.min.z < 500 && box.min.z > 498 && sph.radius > 15 && sph.radius < 40 && mesh.frustumCulled === true, box);
  ok('taps go through: the trees answer no ray', (() => { const hits = []; mesh.raycast(new v.THREE.Raycaster(new v.THREE.Vector3(10, 20, 600), new v.THREE.Vector3(0, 0, -1)), hits); return hits.length === 0; })());
  ok('the dither patch finds its anchor in three’s own Lambert shader and adds its uniform; cones and round crowns share the trees’ level, the mounds have the brush’s', (() => {
    const sh = { uniforms: {}, fragmentShader: v.THREE.ShaderLib.lambert.fragmentShader, vertexShader: v.THREE.ShaderLib.lambert.vertexShader };
    mtl.onBeforeCompile(sh);
    const s1 = { uniforms: {}, fragmentShader: v.THREE.ShaderLib.lambert.fragmentShader }, s2 = { uniforms: {}, fragmentShader: v.THREE.ShaderLib.lambert.fragmentShader };
    o.meshes[1][0].material.onBeforeCompile(s1); o.meshes[2][0].material.onBeforeCompile(s2);
    return sh.fragmentShader.includes('uniform float uOpacityDither;') && /#include <clipping_planes_fragment>\s+if \(flexBayer4\(gl_FragCoord\.xy\) \+ 0\.03125 > uOpacityDither\) discard;/.test(sh.fragmentShader) && sh.fragmentShader.includes('float flexBayer4(vec2 a)') &&
      !/uSee/.test(sh.fragmentShader) && sh.uniforms.uOpacityDither.value === 0.5 && s1.uniforms.uOpacityDither === sh.uniforms.uOpacityDither && s2.uniforms.uOpacityDither !== sh.uniforms.uOpacityDither && s2.uniforms.uOpacityDither.value === 0.5;
  })());

  // ── 4. The switches ─────────────────────────────────────────────────────────
  let n0 = v.redraws;
  v.FT.set('trees', false);
  ok('Trees off: cones and round crowns hidden, brush stays; one redraw', !o.meshes[0][0].visible && !o.meshes[1][0].visible && o.meshes[2][0].visible && v.redraws === n0 + 1);
  v.FT.set('brush', false); v.FT.set('trees', true);
  ok('Brush off, Trees on: the mounds hidden, the trees back', o.meshes[0][0].visible && o.meshes[1][0].visible && !o.meshes[2][0].visible);
  n0 = v.redraws; v.FT.level('trees', 1);
  ok('Trees at 100 %: the trees’ uniform goes to 1 (no rebuild, no new material), the brush’s stays; one redraw', v.FT.objects().op.join() === '1,0.5' && o.meshes[0][0].material === mtl && v.redraws === n0 + 1);
  v.FT.level('brush', 0.26); v.FT.level('trees', 0);
  ok('levels are drawn in sixteenths (0.26 -> 25 %), never under one sixteenth', v.FT.objects().op.join() === '0.0625,0.25' && v.FT.state().brushOp === 0.25 && v.FT.state().treesOp === 0.0625);
  n0 = v.redraws; v.FT.level('nonsense', 0.5); v.FT.level('trees', 'x'); v.FT.set('treesOp', true); v.FT.set('see', false);
  ok('an unknown level, a value that is no number, a level set as a switch and the old See-through switch are ignored', v.FT.objects().op.join() === '0.0625,0.25' && v.redraws === n0 && v.FT.state().treesOp === 0.0625 && !('see' in v.FT.state()));
  v.FT.level('trees', 1);
  v.FT.set('nonsense', true); ok('an unknown switch is ignored', !('nonsense' in v.FT.state()));
  const saved = JSON.parse(JSON.stringify(v.FT.serialize()));
  ok('what is saved: the version, the two switches, the two levels and the conifers\' look', saved.v === 2 && saved.trees === true && saved.brush === false && saved.treesOp === 1 && saved.brushOp === 0.25 && saved.crown === false && Object.keys(saved).length === 6, saved);
  const v2 = makeViewer(); await v2.FT.init(v2.opts(treesObj(TREES), saved));
  const o2 = v2.FT.objects();
  ok('a map opened again starts from them', o2.meshes[0][0].visible && !o2.meshes[2][0].visible && o2.op.join() === '1,0.25');
  { const w = makeViewer(); await w.FT.init(w.opts(treesObj(TREES), { v: 1, trees: true, brush: false, see: false, crown: false })); const q = w.FT.objects();
    ok('a map last opened with See-through off opens solid (100 %), its Brush still off; saved again as version 2', q.op.join() === '1,1' && !q.meshes[2][0].visible && w.FT.serialize().v === 2 && !('see' in w.FT.serialize())); }
  const ui = [];
  v2.FT.sheet({ head: t => ui.push('H:' + t), chips: c => { ui.chips = c; c.forEach(x => ui.push(x[1] + (x[2] ? ':on' : ':off') + ':' + x[4].level)); } });
  ok('Display: heading “Trees and brush”, then Trees and Brush as they are, each with its level; no See-through chip', ui.join('|') === 'H:Trees and brush|Trees:on:1|Brush:off:0.25', ui);
  ok('each chip hands the host its part (the level bar and the slider on a hold)', ui.chips.every(c => typeof c[4].attach === 'function'));
  ui.chips[1][3](true);
  ok('a chip switches its layer', v2.FT.objects().meshes[2][0].visible);

  // ── 4b. A map with brush blocks (libs/brush-blocks.js): the Brush chip and level drive them, the mounds stay hidden ──
  {
    const fake = (okLoad) => { const f = { calls: [], active: () => true, whenReady: () => Promise.resolve(okLoad), set: x => f.calls.push(JSON.stringify(x)) }; return f; };
    let w = makeViewer(), bl = fake(true);
    await w.FT.init(Object.assign(w.opts(treesObj(TREES), { v: 2, trees: true, brush: true, treesOp: 1, brushOp: 0.75, crown: false }), { blocks: bl }));
    let q = w.FT.objects();
    ok('with blocks: the mounds are hidden, the trees shown; the blocks get the saved switch and level', q.blocks === true && !q.meshes[2][0].visible && q.meshes[0][0].visible && bl.calls[0] === '{"on":true,"opacity":0.75}', bl.calls);
    w.FT.set('brush', false); w.FT.set('brush', true); w.FT.level('brush', 0.25);
    ok('…Brush off / on and its level go to the blocks; the mounds never show', bl.calls.slice(-3).join() === '{"on":false,"opacity":0.75},{"on":true,"opacity":0.75},{"on":true,"opacity":0.25}' && !q.meshes[2][0].visible, bl.calls);
    w.FT.level('trees', 0.5); ok('…the trees’ level is not theirs', bl.calls.length === 4);
    w = makeViewer(); bl = fake(false);
    await w.FT.init(Object.assign(w.opts(treesObj(TREES)), { blocks: bl })); await Promise.resolve(); await Promise.resolve();
    ok('blocks that did not load: the mounds are the brush again', w.FT.objects().blocks === false && w.FT.objects().meshes[2][0].visible);
    w = makeViewer(); bl = fake(true);
    const rr = await w.FT.init(Object.assign(w.opts(null), { blocks: bl })); const rows = [];
    w.FT.sheet({ head: t => rows.push('H:' + t), chips: c => c.forEach(x => rows.push(x[1])) });
    ok('a map with blocks and no trees: active, nothing of the trees in the scene, Display has “Brush” with the Brush chip alone, its state saved', rr === false && w.FT.active() && !w.FT.loaded() && w.scene.children.length === 0 && rows.join('|') === 'H:Brush|Brush' && w.FT.serialize().v === 2 && bl.calls.length === 1, rows);
    w.FT.set('trees', false); w.FT.set('crown', true); w.FT.level('brush', 1);
    ok('…its switches do no harm without trees', bl.calls.slice(-1)[0] === '{"on":true,"opacity":1}');
    w = makeViewer(); const idle = { active: () => false, set() { throw new Error('not to be called'); } };
    ok('blocks that are idle (BRUSH null) change nothing', (await w.FT.init(Object.assign(w.opts(null), { blocks: idle }))) === false && !w.FT.active());
  }

  // ── 5. Detail levels ────────────────────────────────────────────────────────
  const verts = [];
  for (const d of [0, 1, 2]) { const w = makeViewer(); await w.FT.init(w.opts(treesObj(TREES, d))); const q = w.FT.objects(); verts.push(q.meshes.map(m => m[0].geometry.attributes.position.count / 3)); ok('detail ' + d + ' is taken from the export', q.detail === d); }
  ok('detail 1 and 2 draw fewer triangles a shape', verts[0].every((n, k) => n > verts[1][k] && verts[1][k] >= verts[2][k]) && verts[2].every(n => n <= 9), verts);
  { const w = makeViewer(); await w.FT.init(w.opts(Object.assign(treesObj(TREES), { detail: 7 }))); ok('an unknown detail is full detail', w.FT.objects().detail === 0); }

  // ── 6. Odd files ────────────────────────────────────────────────────────────
  { const w = makeViewer(); const rr = await w.FT.init(w.opts({ version: 1, count: 3, detail: 0, file: Buffer.from('not a trees file at all').toString('base64') }));
    ok('a file that is not one: the viewer carries on, nothing in the scene', rr === false && w.scene.children.length === 0 && !w.FT.loaded()); w.FT.set('trees', false); }
  { const w = makeViewer(); await w.FT.init(w.opts(treesObj([[1, 2, 3, 5, 1, 9, 0]])));
    ok('a kind this build does not know is drawn as a mound', w.FT.objects().count.join() === '0,0,1'); }
  { const w = makeViewer(); await w.FT.init(w.opts(treesObj([])));
    ok('no trees in the file: active, nothing drawn', w.FT.active() && w.FT.objects().count.join() === '0,0,0' && w.FT.objects().group.children.length === 0); }

  // ── 6b. Version 2 (the crown's base) and the conifers' other look ───────────
  {
    // [x, y, z, height, radius, kind, tint, crown base]
    const L2 = [[10, 20, 500, 30, 4, 0, 100, 12], [40, 22, 503, 20, 3, 0, 100, 19.5], [70, 90, 498, 9, 2.5, 1, 128, 3], [15, 80, 501, 1.2, 1.8, 2, 10, 0], [50, 50, 500, 10, 2, 0, 9, 0]];
    const b2 = Buffer.alloc(8 + L2.length * 24); b2.write('FTR2', 0, 'latin1'); b2.writeUInt32LE(L2.length, 4);
    L2.forEach((t, i) => { const o = 8 + i * 24; b2.writeFloatLE(t[0], o); b2.writeFloatLE(t[1], o + 4); b2.writeFloatLE(t[2], o + 8); b2.writeFloatLE(t[3], o + 12);
      b2.writeUInt16LE(Math.round(t[4] * 100), o + 16); b2.writeUInt8(t[5], o + 18); b2.writeUInt8(t[6], o + 19); b2.writeUInt16LE(Math.round(t[7] * 100), o + 20); });
    const T2 = FT.parse(ab(b2));
    ok('FTR2: 24 bytes a tree, the same fields at the same places, and the crown base in cm', T2.n === 5 && T2.version === 2 && T2.B === 24 && T2.f32[1 * 6] === 40 && T2.f32[1 * 6 + 3] === 20 && T2.u16[1 * 12 + 8] === 300 && T2.u8[2 * 24 + 18] === 1 && T2.u16[0 * 12 + 10] === 1200 && T2.u16[1 * 12 + 10] === 1950);
    ok('FTR1 is still read (version 1, 20 bytes a tree)', FT.parse(ab(treesBin(TREES))).version === 1 && FT.parse(ab(treesBin(TREES))).B === 20 && throws(() => FT.parse(ab(b2).slice(0, 100))));
    const w = makeViewer(); await w.FT.init(w.opts({ version: 1, count: 5, detail: 0, file: b2.toString('base64') }));
    let q = w.FT.objects(); const cone = q.meshes[0][0], M = i => Array.from(cone.instanceMatrix.array.slice(i * 16, i * 16 + 16));
    ok('a version 2 file draws as ever by default: cones are spikes from the foot to the top, no trunks', q.count.join() === '3,1,1' && M(0)[10] === 30 && M(0)[14] === 500 && M(1)[10] === 20 && M(1)[14] === 503 && q.trunks.length === 0 && w.FT.state().crown === false && w.scene.children[0].children.length === 3, [M(0)[10], M(0)[14]]);
    const r0 = w.redraws; w.FT.set('crown', true); q = w.FT.objects();
    ok('crown on: the cone runs from the crown\'s base to the top (18 m of a 30 m tree, starting 12 m up); its width and place stay; one redraw', near(M(0)[10], 18) && near(M(0)[14], 512) && M(0)[0] === 4 && M(0)[12] === 10 && w.redraws === r0 + 1, M(0));
    ok('…a crown is never less than a quarter of the tree (base 19.5 m of 20 m: drawn from 15 m)', near(M(1)[10], 5) && near(M(1)[14], 518));
    ok('…a conifer with no base measured stays a spike', near(M(2)[10], 10) && near(M(2)[14], 500));
    const tk = q.trunks[0], K = i => Array.from(tk.instanceMatrix.array.slice(i * 16, i * 16 + 16));
    ok('…with a thin trunk a cone from the ground to the crown\'s base: one instanced mesh a tile, 6 triangles a trunk', q.trunks.length === 1 && tk.isInstancedMesh && tk.count === 3 && tk.geometry.attributes.position.count === 18 && tk.parent === q.group && tk.visible &&
      near(K(0)[10], 12) && K(0)[14] === 500 && K(0)[12] === 10 && near(K(0)[0], 0.24) && near(K(1)[0], 0.18) && near(K(1)[10], 15) && tk.frustumCulled === true, K(0));
    ok('…round crowns and mounds are untouched', near(q.meshes[1][0].instanceMatrix.array[10], 9) && q.meshes[1][0].instanceMatrix.array[14] === 498 && near(q.meshes[2][0].instanceMatrix.array[10], 1.2));
    ok('…the trunk shares the trees’ dither level and answers no ray', (() => { const sh = { uniforms: {}, fragmentShader: w.THREE.ShaderLib.lambert.fragmentShader }, sc = { uniforms: {}, fragmentShader: w.THREE.ShaderLib.lambert.fragmentShader }; tk.material.onBeforeCompile(sh); cone.material.onBeforeCompile(sc); const hits = []; tk.raycast(new w.THREE.Raycaster(new w.THREE.Vector3(10, 20, 600), new w.THREE.Vector3(0, 0, -1)), hits); return sh.uniforms.uOpacityDither && sh.uniforms.uOpacityDither === sc.uniforms.uOpacityDither && sh.fragmentShader.includes('discard') && hits.length === 0; })());
    w.FT.set('trees', false); ok('Trees off hides the trunks too', !tk.visible && !cone.visible);
    w.FT.set('trees', true); ok('…and on shows them again', tk.visible && cone.visible);
    const sv = JSON.parse(JSON.stringify(w.FT.serialize()));
    w.FT.set('crown', false);
    ok('crown off: the spikes are back exactly, the trunks hidden (kept for next time)', M(0)[10] === 30 && M(0)[14] === 500 && M(1)[10] === 20 && !tk.visible && w.FT.objects().trunks.length === 1);
    const w2 = makeViewer(); await w2.FT.init(w2.opts({ version: 1, count: 5, detail: 0, file: b2.toString('base64') }, sv));
    ok('the look is remembered with the other choices', sv.crown === true && w2.FT.state().crown === true && near(w2.FT.objects().meshes[0][0].instanceMatrix.array[10], 18) && w2.FT.objects().trunks.length === 1);
    const ui2 = []; w2.FT.sheet({ head: t => ui2.push(t), chips: c => c.forEach(x => ui2.push(x[1])) });
    ok('…but it is not in Display (yet)', ui2.join('|') === 'Trees and brush|Trees|Brush');
    const w3 = makeViewer(); await w3.FT.init(w3.opts({ version: 1, count: 5, detail: 2, file: b2.toString('base64') })); w3.FT.set('crown', true);
    ok('at the lowest detail: cones from the crown base, no trunks', near(w3.FT.objects().meshes[0][0].instanceMatrix.array[10], 18) && w3.FT.objects().trunks.length === 0);
    const w4 = makeViewer(); await w4.FT.init(w4.opts(treesObj(TREES))); w4.FT.set('crown', true);
    ok('a version 1 file with crown on: nothing to go by, the spikes stay (trunks of no length)', w4.FT.objects().meshes[0][0].instanceMatrix.array[10] === 18 && w4.FT.objects().meshes[0][0].instanceMatrix.array[14] === 500);
  }

  // ── 7. A big set: filed in ground tiles, quickly ────────────────────────────
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const big = []; for (let i = 0; i < 100000; i++) big.push([rnd() * 4000 - 2000, rnd() * 3000 - 1500, 500 + rnd() * 50, 2 + rnd() * 25, 1 + rnd() * 4, i % 3, i & 255]);
  const wb = makeViewer(), bobj = treesObj(big, 1);
  const t0 = Date.now(); await wb.FT.init(wb.opts(bobj)); const ms = Date.now() - t0;
  const ob = wb.FT.objects(), all = ob.meshes[0].concat(ob.meshes[1], ob.meshes[2]);
  ok('100,000 trees: every one is an instance', ob.count.reduce((a, b) => a + b, 0) === 100000 && all.reduce((a, m) => a + m.count, 0) === 100000, ob.count);
  ok('…in 5 x 5 ground tiles a kind (at most 8 x 8), each with bounds much smaller than the area', ob.tiles === 5 && all.length === 75 && all.every(m => m.geometry.boundingSphere.radius < 900 && m.geometry.boundingSphere.radius > 300), [ob.tiles, all.length]);
  ok('…each instance inside its tile’s bounds', all.every(m => { const b = m.geometry.boundingBox, a = m.instanceMatrix.array; for (let i = 0; i < m.count; i += 97) { if (a[i * 16 + 12] < b.min.x || a[i * 16 + 12] > b.max.x || a[i * 16 + 13] < b.min.y || a[i * 16 + 13] > b.max.y) return false; } return true; }));
  ok('…filed in well under two seconds here (' + ms + ' ms)', ms < 2000, ms);
  const tris = all.reduce((a, m) => a + m.count * m.geometry.attributes.position.count / 3, 0);
  ok('…under 850,000 triangles in all at detail 1 (' + tris + ')', tris < 850000, tris);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

