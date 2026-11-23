// Test for the viewer's trees and brush module (viewer_build/libs/trees.js), without a browser.
//
// Loads the real three.js r128 the viewer ships and the module into one context, with a made-up TREES
// whose trees.bin is inline base64 built here, then checks: nothing at all when TREES is null; the
// binary layout; one instanced mesh per kind and ground tile, with each tree's matrix (its radius and
// height on the stock solid, its foot's place) and tint; the three detail levels (fewer triangles);
// the switches (Trees, Brush, See-through) and the saved choices; the screen-door patch finds its anchor
// in three's own Lambert shader; bounds per tile; a 100,000-tree set is filed in a fraction of a second.
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
  ok('saved choices: this version only; odd values fall back to the defaults', (() => {
    const a = FT.restore({ v: FT.STATE_V, trees: false, brush: 'x', see: false, extra: 1 }), b = FT.restore({ trees: false, see: false }), c = FT.restore(null);
    return a.trees === false && a.brush === true && a.see === false && !('extra' in a) && b.trees && b.see && c.trees && c.brush && c.see;
  })());

  // ── 3. With TREES: what is made ─────────────────────────────────────────────
  v = makeViewer();
  const r = await v.FT.init(v.opts(treesObj(TREES)));
  let o = v.FT.objects();
  ok('active and loaded; one group in the scene; one redraw asked for', r === true && v.FT.active() && v.FT.loaded() && v.scene.children.length === 1 && o.group.parent === v.scene && v.redraws === 1);
  ok('one instanced mesh per kind (a small set is one ground tile): 2 cones, 2 round crowns, 2 mounds', o.tiles === 1 && o.meshes.map(m => m.length).join() === '1,1,1' && o.count.join() === '2,2,2' && o.meshes.every(m => m[0].isInstancedMesh && m[0].count === 2));
  ok('defaults: trees and brush shown, see-through on', o.meshes.every(m => m[0].visible) && o.see === 1 && JSON.stringify(v.FT.state()) === JSON.stringify({ trees: true, brush: true, see: true }));
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
  ok('the screen-door patch finds its anchor in three’s own Lambert shader and adds its uniform', (() => {
    const sh = { uniforms: {}, fragmentShader: v.THREE.ShaderLib.lambert.fragmentShader, vertexShader: v.THREE.ShaderLib.lambert.vertexShader };
    mtl.onBeforeCompile(sh);
    return sh.fragmentShader.includes('uniform float uSee;') && /uSee > 0\.5 && mod\(floor\(gl_FragCoord\.x\) \+ floor\(gl_FragCoord\.y\), 2\.0\) < 0\.5\) discard;/.test(sh.fragmentShader) && sh.uniforms.uSee && sh.uniforms.uSee.value === 1 &&
      (() => { const s2 = { uniforms: {}, fragmentShader: v.THREE.ShaderLib.lambert.fragmentShader }; o.meshes[2][0].material.onBeforeCompile(s2); return s2.uniforms.uSee === sh.uniforms.uSee; })();
  })());

  // ── 4. The switches ─────────────────────────────────────────────────────────
  let n0 = v.redraws;
  v.FT.set('trees', false);
  ok('Trees off: cones and round crowns hidden, brush stays; one redraw', !o.meshes[0][0].visible && !o.meshes[1][0].visible && o.meshes[2][0].visible && v.redraws === n0 + 1);
  v.FT.set('brush', false); v.FT.set('trees', true);
  ok('Brush off, Trees on: the mounds hidden, the trees back', o.meshes[0][0].visible && o.meshes[1][0].visible && !o.meshes[2][0].visible);
  n0 = v.redraws; v.FT.set('see', false);
  ok('See-through off: the shared uniform goes to 0 (no rebuild, no new material), one redraw', v.FT.objects().see === 0 && o.meshes[0][0].material === mtl && v.redraws === n0 + 1);
  v.FT.set('nonsense', true); ok('an unknown switch is ignored', !('nonsense' in v.FT.state()));
  const saved = JSON.parse(JSON.stringify(v.FT.serialize()));
  ok('what is saved: the version and the three switches', saved.v === 1 && saved.trees === true && saved.brush === false && saved.see === false && Object.keys(saved).length === 4, saved);
  const v2 = makeViewer(); await v2.FT.init(v2.opts(treesObj(TREES), saved));
  const o2 = v2.FT.objects();
  ok('a map opened again starts from them', o2.meshes[0][0].visible && !o2.meshes[2][0].visible && o2.see === 0);
  const ui = [];
  v2.FT.sheet({ head: t => ui.push('H:' + t), chips: c => { ui.chips = c; c.forEach(x => ui.push(x[1] + (x[2] ? ':on' : ':off'))); } });
  ok('Display: heading “Trees and brush”, then Trees, Brush, See-through as they are', ui.join('|') === 'H:Trees and brush|Trees:on|Brush:off|See-through:off', ui);
  ui.chips[1][3](true); ui.chips[2][3](true);
  ok('a chip switches its layer', v2.FT.objects().meshes[2][0].visible && v2.FT.objects().see === 1);

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

