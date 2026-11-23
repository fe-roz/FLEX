// Test for the viewer's V2 - Ridgewalking module (viewer_build/libs/ridgewalk.js), without a browser.
//
// Loads the real three.js r128 the viewer ships and the module into one context, with a made-up RIDGE
// whose parts are inline base64 built here (a few returns of each kind, two patch triangles, a tiny
// shape), then checks: nothing at all when RIDGE is null; the binary layouts; the objects made and how
// they are drawn (through the ground, after the terrain); defaults on / off; every switch and the dot
// size; the colours of a 0 m, 10 m and 30 m deep return; the saved choices; shapes loaded on first
// use; the hillshade with brush is a picture of the export (a third Imagery choice), not made here. Synthetic numbers only.
//
//   node tools/test_viewer_ridge.js
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

// ── A made-up scene, in the viewer's frame ────────────────────────────────────
// [x, y, z, depth, kind]: kind 0 in a group, 1 lone, 2 likely noise, 3 patterned noise
const PTS = [
  [10, 20, 500, 0, 0], [11, 20, 490, 10, 0], [12, 21, 470, 30, 0], [12, 22, 495, 5, 0],
  [40, 5, 498, 2, 1], [41, 6, 497, 3, 1],
  [70, 70, 480, 20, 2],
  [90, 10, 499, 4, 3], [91, 10, 499, 4, 3], [92, 10, 499, 4, 3],
];
function pointsBin(pts) {
  const n = pts.length, b = Buffer.alloc(8 + n * 17);
  b.write('RWP1', 0, 'latin1'); b.writeUInt32LE(n, 4);
  pts.forEach((p, i) => { for (let k = 0; k < 3; k++) b.writeFloatLE(p[k], 8 + (i * 3 + k) * 4); b.writeFloatLE(p[3], 8 + n * 12 + i * 4); b.writeUInt8(p[4], 8 + n * 16 + i); });
  return b;
}
function patchesBin(xyz) {
  const nv = xyz.length / 3, b = Buffer.alloc(8 + nv * 12);
  b.write('RWT1', 0, 'latin1'); b.writeUInt32LE(nv, 4);
  xyz.forEach((v, i) => b.writeFloatLE(v, 8 + i * 4));
  return b;
}
function shapesBin(xyz, depth, tri) {
  const nv = depth.length, nt = tri.length / 3, b = Buffer.alloc(12 + nv * 16 + nt * 12);
  b.write('RWS1', 0, 'latin1'); b.writeUInt32LE(nv, 4); b.writeUInt32LE(nt, 8);
  xyz.forEach((v, i) => b.writeFloatLE(v, 12 + i * 4));
  depth.forEach((v, i) => b.writeFloatLE(v, 12 + nv * 12 + i * 4));
  tri.forEach((v, i) => b.writeUInt32LE(v, 12 + nv * 16 + i * 4));
  return b;
}
const PATCH = [30, 30, 500.08, 31, 30, 500.08, 30, 31, 500.08, 31, 30, 500.08, 31, 31, 500.08, 30, 31, 500.08];
const SHAPE = { xyz: [10, 20, 500, 11, 20, 490, 12, 21, 470, 12, 22, 495], depth: [0, 10, 30, 5], tri: [0, 1, 2, 0, 2, 3, 0, 1, 3, 1, 2, 3] };
const b64 = b => b.toString('base64');
const ridge = () => ({ version: 1, counts: { below: PTS.length }, points: b64(pointsBin(PTS)), patches: b64(patchesBin(PATCH)),
  shapes: b64(shapesBin(SHAPE.xyz, SHAPE.depth, SHAPE.tri)), depthCap: 20 });

// ── A viewer to load it into ─────────────────────────────────────────────────
function makeViewer() {
  const canvases = [];
  const ctx = { console: { warn() {}, log: console.log, error: console.error, info() {} }, Math, Promise, window: {} };
  ctx.document = { createElement: () => { const c = { width: 0, height: 0, drawn: [], getContext: () => ({ drawImage: (img, x, y, w, h) => c.drawn.push([img.tag, x, y, w, h]) }) }; canvases.push(c); return c; } };
  ctx.Image = function () { ctx._images.push(this); };
  ctx._images = [];
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'three.min.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'ridgewalk.js'), 'utf8'), ctx);
  const THREE = ctx.THREE, FR = ctx.window.FlexRidge;
  const v = { ctx, THREE, FR, canvases, scene: new THREE.Scene(), redraws: 0, retex: 0, decoded: [] };
  v.opts = (rg, saved) => ({ THREE, scene: v.scene, ridge: rg, saved,
    isAssetRef: s => typeof s === 'string' && s.length < 512 && /\.(glb|jpe?g|png|webp|bin)$/i.test(s),
    b64ToArrayBuffer: s => { v.decoded.push(s.slice(0, 8)); const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    textureSrc: s => 'data:image/png;base64,' + s,
    redraw: () => { v.redraws++; }, retexture: () => { v.retex++; } });
  return v;
}
const rgb = (attr, i) => [attr.array[i * 3], attr.array[i * 3 + 1], attr.array[i * 3 + 2]];
const isHex = (c, hex, e = 0.004) => near(c[0], (hex >> 16 & 255) / 255, e) && near(c[1], (hex >> 8 & 255) / 255, e) && near(c[2], (hex & 255) / 255, e);

(async () => {
  // ── 1. A normal export: RIDGE is null, nothing happens ──────────────────────
  let v = makeViewer();
  ok('the module defines FlexRidge', !!v.FR && typeof v.FR.init === 'function' && typeof v.FR.sheet === 'function');
  for (const nothing of [null, undefined, {}, { version: 1 }]) {
    const r = await v.FR.init(v.opts(nothing));
    ok('RIDGE ' + JSON.stringify(nothing) + ': not active, nothing in the scene, nothing decoded, no image asked for',
      r === false && !v.FR.active() && v.scene.children.length === 0 && v.decoded.length === 0 && v.ctx._images.length === 0 && v.FR.objects() === null && v.FR.serialize() === undefined);
  }
  let heads = 0;
  v.FR.sheet({ head: () => heads++, chips: () => heads++, el: () => ({}), sheet: { appendChild() { heads++; } } });
  ok('…and no rows in Display', heads === 0);
  v.FR.set('ret', false);                              // must not throw
  ok('the viewer template has the placeholder, the script line and the hooks', (() => {
    const h = fs.readFileSync(path.join(root, 'viewer_build', 'viewer.html'), 'utf8');
    return h.split('PLACEHOLDER_RIDGE_JSON').length === 2 && h.includes('<script>const RIDGE = PLACEHOLDER_RIDGE_JSON;</script>') && h.includes('<script src="libs/ridgewalk.js"></script>') &&
      h.includes('FlexRidge.init(') && h.includes('FlexRidge.sheet(') && h.includes('FlexRidge.serialize()');
  })());

  // ── 2. The pure parts ───────────────────────────────────────────────────────
  const FR = v.FR, ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const P = FR.parsePoints(ab(pointsBin(PTS)));
  ok('RWP1: count, positions, depths and kinds read back', P.n === 10 && P.xyz[3] === 11 && P.xyz[5] === 490 && P.depth[2] === 30 && Array.from(P.kind).join('') === '0000112333', Array.from(P.kind));
  const H = FR.parseShapes(ab(shapesBin(SHAPE.xyz, SHAPE.depth, SHAPE.tri)));
  ok('RWS1: vertices, depths and triangles read back', H.nv === 4 && H.nt === 4 && H.xyz[8] === 470 && H.depth[1] === 10 && Array.from(H.tri).join() === SHAPE.tri.join());
  const Q = FR.parsePatches(ab(patchesBin(PATCH)));
  ok('RWT1: the triangle soup reads back', Q.nv === 6 && near(Q.xyz[2], 500.08) && Q.xyz[3] === 31);
  const throws = f => { try { f(); return false; } catch (_) { return true; } };
  ok('a file of the wrong kind, an empty one and one cut short are refused', throws(() => FR.parsePoints(ab(patchesBin(PATCH)))) && throws(() => FR.parsePoints(new ArrayBuffer(0))) &&
    throws(() => FR.parsePoints(ab(pointsBin(PTS)).slice(0, 60))) && throws(() => FR.parseShapes(ab(pointsBin(PTS)))) && throws(() => FR.parsePatches(ab(patchesBin(PATCH)).slice(0, 20))));
  ok('an empty points file is fine', FR.parsePoints(ab(pointsBin([]))).n === 0);
  ok('the ramp: yellow at 0 m, orange at 5, red at 10, purple at 15, blue at 20', isHex(FR.rampColour(0, 20), 0xffe85c) && isHex(FR.rampColour(5, 20), 0xff9a2e) && isHex(FR.rampColour(10, 20), 0xe8322a) && isHex(FR.rampColour(15, 20), 0xb01fd0) && isHex(FR.rampColour(20, 20), 0x4a2cff));
  ok('deeper than the cap is the last colour; above the lid, or no number, the first', isHex(FR.rampColour(30, 20), 0x4a2cff) && isHex(FR.rampColour(-3, 20), 0xffe85c) && isHex(FR.rampColour(NaN, 20), 0xffe85c));
  ok('half way between two stops is half way between their colours', near(FR.rampColour(2.5, 20)[1], (0xe8 + 0x9a) / 2 / 255) && near(FR.rampColour(5, 40)[1], (0xe8 + 0x9a) / 2 / 255));
  ok('saved choices: odd values fall back to the defaults', (() => {
    const s = FR.restore({ ret: false, lone: 'no', pattern: true, size: 99, shapes: 1, brush: false, extra: 1 });      // brush: a choice saved by the first build, ignored now
    return s.ret === false && s.lone === true && s.pattern === true && s.size === 4 && s.shapes === false && !('brush' in s) && !('extra' in s) && FR.restore(null).size === 4 && FR.restore({ size: 7 }).size === 7;
  })());

  // ── 3. With RIDGE: what is made, and the defaults ───────────────────────────
  v = makeViewer();
  const r = await v.FR.init(v.opts(ridge()));
  let o = v.FR.objects();
  ok('active; four sets of dots and the patches are in the scene; one redraw asked for', r === true && v.FR.active() && o.points.every(p => p && p.isPoints && p.parent === v.scene) && o.patches && o.patches.isMesh && o.patches.parent === v.scene && v.redraws === 1, v.redraws);
  ok('the kinds are separate objects with their own returns: 4 in groups, 2 lone, 1 likely noise, 3 patterned', o.points.map(p => p.geometry.attributes.position.count).join() === '4,2,1,3');
  ok('defaults: returns, lone, likely noise and openings on; patterned noise and shapes off; dots 4 px', o.points.map(p => p.visible).join() === 'true,true,true,false' && o.patches.visible === true && o.shapes === null &&
    JSON.stringify(v.FR.state()) === JSON.stringify({ ret: true, lone: true, noise: true, pattern: false, patches: true, shapes: false, size: 4 }), v.FR.state());
  ok('the shapes were not even decoded (loaded on first use)', v.decoded.length === 2 && v.scene.children.length === 5, v.decoded.length);
  const col = o.points[0].geometry.attributes.color;
  ok('a 0 m deep return is yellow, a 10 m one red, a 30 m one blue (cap 20), a 5 m one orange', isHex(rgb(col, 0), 0xffe85c) && isHex(rgb(col, 1), 0xe8322a) && isHex(rgb(col, 2), 0x4a2cff) && isHex(rgb(col, 3), 0xff9a2e), Array.from(col.array));
  ok('…at their own places', Array.from(o.points[0].geometry.attributes.position.array.slice(3, 6)).join() === '11,20,490' && Array.from(o.points[2].geometry.attributes.position.array).join() === '70,70,480');
  ok('lone returns white, likely noise pink, patterned noise light blue', o.points[1].material.color.getHex() === 0xffffff && o.points[2].material.color.getHex() === 0xff4dd2 && o.points[3].material.color.getHex() === 0x7fd4ff &&
    !o.points[1].material.vertexColors && o.points[0].material.vertexColors && o.points[0].material.color.getHex() === 0xffffff);
  ok('dots are drawn through the ground, after the terrain, at a size in screen pixels', o.points.every(p => p.material.depthTest === false && p.material.depthWrite === false && p.material.sizeAttenuation === false && p.material.size === 4 && p.renderOrder > 0.5 && p.material.fog === false));
  ok('the round-dot patch finds its anchor in three’s own points shader', (() => {
    const sh = { fragmentShader: v.THREE.ShaderLib.points.fragmentShader, vertexShader: v.THREE.ShaderLib.points.vertexShader };
    o.points[0].material.onBeforeCompile(sh);
    return sh.fragmentShader.includes('gl_PointCoord - vec2(0.5)') && sh.fragmentShader.length > v.THREE.ShaderLib.points.fragmentShader.length;
  })());
  ok('the guessed openings: two triangles, colour #141312 at 0.72, no depth write, drawn after the terrain and before the dots', o.patches.geometry.attributes.position.count === 6 && o.patches.material.color.getHex() === 0x141312 &&
    near(o.patches.material.opacity, 0.72) && o.patches.material.transparent && o.patches.material.depthWrite === false && o.patches.material.depthTest === true && o.patches.renderOrder > 0.5 && o.patches.renderOrder < o.points[0].renderOrder);
  ok('every object has a bounding sphere already (none worked out while drawing)', o.points.concat([o.patches]).every(p => p.geometry.boundingSphere && p.geometry.boundingSphere.radius >= 0));

  // ── 4. The switches ─────────────────────────────────────────────────────────
  let n0 = v.redraws;
  v.FR.set('ret', false); v.FR.set('pattern', true); v.FR.set('lone', false); v.FR.set('noise', false); v.FR.set('patches', false);
  ok('each switch shows or hides its own object and asks for one redraw', o.points.map(p => p.visible).join() === 'false,false,false,true' && o.patches.visible === false && v.redraws === n0 + 5, v.redraws - n0);
  v.FR.set('ret', true); v.FR.set('lone', true); v.FR.set('noise', true); v.FR.set('pattern', false); v.FR.set('patches', true);
  ok('…and back', o.points.map(p => p.visible).join() === 'true,true,true,false' && o.patches.visible === true);
  n0 = v.redraws; v.FR.set('size', 7);
  ok('dot size: every kind follows, one redraw', o.points.every(p => p.material.size === 7) && v.FR.state().size === 7 && v.redraws === n0 + 1);
  v.FR.set('size', 500); ok('dot size is kept within 1 to 12 px', v.FR.state().size === 12 && o.points[0].material.size === 12);
  v.FR.set('size', 0); ok('…and a wrong one is the default', v.FR.state().size === 4);
  v.FR.set('nonsense', true); ok('an unknown switch is ignored', !('nonsense' in v.FR.state()));

  // shapes: loaded on the first switch-on
  v.FR.set('shapes', true);
  await new Promise(res => setTimeout(res, 5));
  o = v.FR.objects();
  ok('Shapes on: decoded now, a mesh of 4 triangles coloured by depth, seen through the ground', v.decoded.length === 3 && o.shapes && o.shapes.isMesh && o.shapes.visible && o.shapes.geometry.index.count === 12 &&
    isHex(rgb(o.shapes.geometry.attributes.color, 0), 0xffe85c) && isHex(rgb(o.shapes.geometry.attributes.color, 1), 0xe8322a) && isHex(rgb(o.shapes.geometry.attributes.color, 2), 0x4a2cff) &&
    o.shapes.material.vertexColors && o.shapes.material.depthTest === false && o.shapes.material.depthWrite === false && o.shapes.material.transparent, v.decoded.length);
  v.FR.set('shapes', false); v.FR.set('shapes', true);
  await new Promise(res => setTimeout(res, 5));
  ok('off and on again: hidden and shown, not loaded twice', v.decoded.length === 3 && v.FR.objects().shapes === o.shapes && o.shapes.visible && v.scene.children.length === 6);

  // ── 5. Saved choices ────────────────────────────────────────────────────────
  v.FR.set('lone', false); v.FR.set('size', 6);
  const saved = JSON.parse(JSON.stringify(v.FR.serialize()));
  ok('what is saved: every switch and the size', saved.lone === false && saved.shapes === true && saved.size === 6 && Object.keys(saved).length === 7, saved);
  const v2 = makeViewer();
  await v2.FR.init(v2.opts(ridge(), saved));
  const o2 = v2.FR.objects();
  ok('a map opened again starts from them (shapes left on are loaded at once)', o2.points[1].visible === false && o2.points[0].visible && o2.points[0].material.size === 6 && o2.shapes && o2.shapes.visible && v2.decoded.length === 3);

  // ── 6. Parts that are missing ───────────────────────────────────────────────
  const v3 = makeViewer(), bare = ridge(); bare.patches = null; bare.shapes = null; bare.points = b64(pointsBin(PTS.filter(p => p[4] === 0)));
  await v3.FR.init(v3.opts(bare));
  const o3 = v3.FR.objects(), rows = [];
  ok('only grouped returns, no patches or shapes: one set of dots, nothing else, no image asked for', o3.points[0] && !o3.points[1] && !o3.points[2] && !o3.points[3] && !o3.patches && v3.scene.children.length === 1 && v3.ctx._images.length === 0);
  v3.FR.set('shapes', true); v3.FR.set('lone', false); v3.FR.set('patches', false);                       // nothing to act on: must not throw
  v3.FR.sheet({ head: t => rows.push('H:' + t), chips: c => c.forEach(x => rows.push(x[1] + (x[2] ? ':on' : ':off'))), el: (tag, cls, text) => ({ tag, cls, text, style: {}, addEventListener() {}, appendChild() {} }), sheet: { appendChild: e => rows.push('row:' + e.cls) } });
  ok('…and Display offers only what the export has', rows.join('|') === 'H:Below ground (V2)|Returns:on|Lone:off|Likely noise:on|Patterned noise:off|row:sh-sl', rows);
  const v4 = makeViewer(), broken = ridge(); broken.points = b64(Buffer.from('not a ridge file at all'));
  ok('a points file that is not one: the viewer carries on (patches still drawn)', await v4.FR.init(v4.opts(broken)) === true && v4.FR.objects().points.every(p => !p) && !!v4.FR.objects().patches);

  // ── 7. The rows in Display ──────────────────────────────────────────────────
  const ui = { rows: [], slider: null };
  const mkEl = (tag, cls, text) => { const e = { tag, cls, text, style: {}, kids: [], on: {}, addEventListener: (ev, f) => { e.on[ev] = f; }, appendChild: k => e.kids.push(k), set textContent(t) { e.text = t; }, get textContent() { return e.text; } }; return e; };
  v.FR.set('lone', true);
  v.FR.sheet({ head: t => ui.rows.push('H:' + t), chips: c => { ui.chips = c; c.forEach(x => ui.rows.push(x[1] + (x[2] ? ':on' : ':off'))); }, el: mkEl, sheet: { appendChild: e => { ui.rows.push('row:' + e.cls); ui.slider = e; } } });
  ok('heading “Below ground (V2)”, then Returns, Lone, Likely noise, Patterned noise (off), Guessed openings, Shapes, and the dot size',
    ui.rows.join('|') === 'H:Below ground (V2)|Returns:on|Lone:on|Likely noise:on|Patterned noise:off|Guessed openings:on|Shapes:on|row:sh-sl', ui.rows);
  ui.chips[3][3](true); ui.chips[0][3](false);
  ok('a chip switches its layer', v.FR.objects().points[3].visible === true && v.FR.objects().points[0].visible === false);
  const [lab, inp, val] = ui.slider.kids;
  inp.value = '9'; inp.on.input();
  ok('the Dot size slider (1 to 12) sets the size and shows it', lab.text === 'Dot size' && inp.type === 'range' && inp.min === '1' && inp.max === '12' && v.FR.state().size === 9 && val.text === '9 px' && v.FR.objects().points[1].material.size === 9, [lab.text, val.text]);

  // ── 8. The brush is not this module's any more: it is a third picture of the export ─────
  const h = fs.readFileSync(path.join(root, 'viewer_build', 'viewer.html'), 'utf8');
  ok('the template has the third picture’s placeholder next to the hillshade’s, once', h.includes('<script>const TERRAIN_HS_B64  = "PLACEHOLDER_HS_B64";</script>\n<script>const TERRAIN_HSB_B64 = "PLACEHOLDER_HSB_B64";</script>') && h.split('"PLACEHOLDER_HSB_B64"').length === 2);
  ok('…a button for it, tiles of it loaded like the hillshade’s, and the choice saved', h.includes('id="btn-layer-hsb"') && h.includes("tt.hsb ? ['hsb'] : []") && h.includes("'Hillshade + brush'") && h.includes('tex: texMode'));
  ok('no compositing left in the module or the viewer', typeof v.FR.mapTexture === 'undefined' && !h.includes('FlexRidge.mapTexture') && v.ctx._images.length === 0 && v.canvases.length === 0);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
