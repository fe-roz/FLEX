// Test for the portable viewer's wall and focus module (viewer_build/libs/wall-fx.js), without a browser.
//
// Loads the real three.js r128 the viewer ships and the module into one context, then checks:
//  - the shader patches still find their anchors in r128's own Lambert / Basic / Sprite shaders (an
//    upgrade of three.min.js that moves one fails here, not silently on a phone);
//  - settings: defaults, restore() of odd saved values, the round trip, the radius defaults;
//  - the uniforms follow the camera and the target, and do nothing when nothing moved;
//  - the focus maths used for taps (the same as the shader's);
//  - the wall sets per mode: On (pre-pass + nearest layer), ghost (pre-pass, layers behind, nearest),
//    big ghost (one pass), off; opacities; rebuilt sets drop out.
// Synthetic numbers only.
//
//   node tools/test_wall_fx.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = { console, Math, EventTarget, Event, window: {}, document: undefined };
ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'three.min.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'wall-fx.js'), 'utf8'), ctx);
const THREE = ctx.THREE, FX = ctx.window.FlexFx;

let fail = 0, pass = 0;
function ok(label, cond, info) {
  if (cond) { pass++; return; }
  fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 400) : ''));
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const count = (s, t) => s.split(t).length - 1;

ok('the module defines FlexFx', !!FX && typeof FX.init === 'function' && typeof FX.makeWalls === 'function');

// ── The patches find their anchors in three's own shaders ────────────────────
FX.init({ THREE, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3() }, caveBox: () => null });
const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
const shaderOf = (id, uniforms) => ({ vertexShader: THREE.ShaderLib[id].vertexShader, fragmentShader: THREE.ShaderLib[id].fragmentShader, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib[id].uniforms) });
function patched(kind, id, material) {
  const m = material || (kind === 'wall' ? FX.makeWalls(new THREE.BufferGeometry(), 0.5)[0].material : FX.patch(id === 'sprite' ? new THREE.SpriteMaterial() : new THREE.MeshBasicMaterial()));
  const sh = shaderOf(id);
  m.onBeforeCompile(sh, null);
  return sh;
}
for (const [kind, id] of [['wall', 'lambert'], ['basic', 'basic'], ['sprite', 'sprite']]) {
  const sh = patched(kind, id);
  const v = sh.vertexShader, f = sh.fragmentShader;
  ok(`${kind}: the vertex shader gets the world position once, after the fog chunk`, count(v, 'vFxW =') === 1 && v.indexOf('#include <fog_vertex>') < v.indexOf('vFxW ='), v.slice(-300));
  ok(`${kind}: the fragment shader gets the focus function and the fade once`, count(f, 'float fxFocus(') === 1 && count(f, 'fxFocus(vFx') >= 1 && f.indexOf('#include <alphatest_fragment>') < f.indexOf('fxFocus(vFxW)'), f.slice(0, 200));
  ok(`${kind}: the original chunks are all still there once`, count(f, '#include <alphatest_fragment>') === 1 && count(v, '#include <fog_vertex>') === 1 && count(f, '#include <common>') === 1 && count(v, '#include <common>') === 1);
  ok(`${kind}: the shared uniforms are attached`, ['uFxCam', 'uFxTgt', 'uFxAxis', 'uFxFoc', 'uFxCut'].every(n => sh.uniforms[n] && sh.uniforms[n] === FX.uniforms[{ uFxCam: 'cam', uFxTgt: 'tgt', uFxAxis: 'axis', uFxFoc: 'foc', uFxCut: 'cut' }[n]]));
  if (kind === 'wall') {
    ok('wall: edge, pass and face uniforms, the normal and view position varyings', ['uFxEdge', 'uFxPass', 'uFxFace'].every(n => sh.uniforms[n]) && count(v, 'varying vec3 vFxN') === 1 && count(f, 'varying vec3 vFxP') === 1 && count(f, 'discard') === 2);
  }
  ok(`${kind}: braces and parentheses balance in what was added`, [v, f].every(s => count(s, '{') === count(s, '}') && count(s, '(') === count(s, ')')));
}
// each kind of material compiles to its own program (the function text is the cache key)
const keys = new Set([FX.makeWalls(new THREE.BufferGeometry(), 0.5)[0].material.customProgramCacheKey(), FX.patch(new THREE.MeshBasicMaterial()).customProgramCacheKey(), FX.patch(new THREE.SpriteMaterial()).customProgramCacheKey(), new THREE.MeshLambertMaterial().customProgramCacheKey()]);
ok('walls, lines/dots, sprites and a plain material have four different program keys', keys.size === 4, keys.size);
const a1 = FX.patch(new THREE.MeshBasicMaterial()), a2 = FX.patch(new THREE.MeshBasicMaterial());
ok('two patched dots share one program key', a1.customProgramCacheKey() === a2.customProgramCacheKey());
const dot = FX.patch(new THREE.MeshBasicMaterial(), { alwaysTransparent: true }); dot.transparent = false;
ok('a dot made always-transparent stays transparent when code switches it off', dot.transparent === true);
ok('patching twice changes nothing', FX.patch(a1) === a1);

// ── Settings ─────────────────────────────────────────────────────────────────
const S = FX.state, D0 = FX.defaults;
ok('defaults: ghost 20%, edges and depth fade set, focus off, both parts on, radii from the cave', S.ghost === 0.2 && S.edge > 0 && S.fade > 0 && S.focus === false && S.around && S.cut && S.r === null && S.cutR === null);
FX.restore({ ghost: 9, edge: -3, fade: 'x', focus: 'yes', around: false, cut: false, r: 1e9, cutR: 0.0001 });
ok('restore: numbers are clamped, wrong types ignored', S.ghost === FX.range.ghost[1] && S.edge === 0 && S.fade === D0.fade && S.focus === false && S.around === false && S.cut === false && S.r === FX.range.r[1] && S.cutR === FX.range.cutR[0], FX.serialize());
FX.restore({ ghost: 0.31, edge: 0.4, fade: 0.9, focus: true, around: true, cut: true, r: 55, cutR: null });
const ser = FX.serialize();
ok('serialize gives back what was restored (and null for a radius left to the default)', ser.ghost === 0.31 && ser.edge === 0.4 && ser.fade === 0.9 && ser.focus === true && ser.r === 55 && ser.cutR === null && JSON.stringify(JSON.parse(JSON.stringify(ser))) === JSON.stringify(ser), ser);
FX.restore(null); FX.restore('junk'); FX.restore(7);
ok('restore ignores nothing-like input', FX.serialize().ghost === 0.31);
Object.assign(S, D0);
ok('default radius: 18% of the cave, 12 m at least, 150 m at most (200 m cave with no box)', near(FX.defaultRadius(), 36), FX.defaultRadius());

// ── Uniforms ─────────────────────────────────────────────────────────────────
const cam = new THREE.PerspectiveCamera(), tgt = new THREE.Vector3(), scene = new THREE.Scene();
let fly = false;
FX.init({ THREE, scene, camera: cam, controls: { target: tgt }, isFly: () => fly,
  caveBox: () => new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(300, 400, 0)) });          // 500 m diagonal
Object.assign(S, D0); FX._reset && FX._reset();
cam.position.set(0, -80, 60); tgt.set(10, 20, 0);
FX.update(true);
const U = FX.uniforms, D = Math.hypot(10, 100, 60);
ok('uniforms: camera, target, axis and its length', near(U.cam.value.y, -80) && near(U.tgt.value.x, 10) && near(U.axis.value.w, D) && near(Math.hypot(U.axis.value.x, U.axis.value.y, U.axis.value.z), 1), U.axis.value);
ok('default radius follows the cave size (500 m diagonal: 90 m)', near(FX.radius(), 90) && near(U.foc.value.y, 90), FX.radius());
ok('focus off: both switches are 0, depth fade is in w', U.foc.value.x === 0 && U.cut.value.x === 0 && near(U.foc.value.w, S.fade));
FX.setFocus(true);
ok('focus on: both switches 1; the cut hole stays between ~5 and ~20 degrees round the axis', U.foc.value.x === 1 && U.cut.value.x === 1 && U.cut.value.y >= 0.09 * D - 1e-9 && U.cut.value.y <= 0.36 * D + 1e-9, U.cut.value);
S.cutR = 1; FX.update(true);
ok('a tiny cut radius is lifted to about 5 degrees of the distance', near(U.cut.value.y, 0.09 * D), U.cut.value.y);
S.cutR = 400; FX.update(true);
ok('a huge cut radius is held to about 20 degrees', near(U.cut.value.y, 0.36 * D), U.cut.value.y);
S.cutR = null; FX.update(true);
// no work when nothing moved: a marker written into a uniform survives update()
U.cam.value.set(-1, -1, -1); FX.update();
ok('update() does nothing when the camera, target and settings have not moved', U.cam.value.x === -1);
cam.position.x += 5; FX.update();
ok('…and brings the uniforms up to date when the camera moves', near(U.cam.value.x, cam.position.x));
fly = true; FX.update(true);
ok('while flying there is no orbit point: focus is off in the uniforms, the setting is kept', U.foc.value.x === 0 && U.cut.value.x === 0 && S.focus === true && FX.focusActive() === false);
fly = false; FX.update(true);
ok('…and back after', U.foc.value.x === 1 && U.cut.value.x === 1 && FX.focusActive() === true);
const before = U.cam.value.clone(); scene.onBeforeRender(null, scene, cam); cam.position.y -= 3; scene.onBeforeRender();
ok('the scene hook (run by every render call) updates the uniforms', near(U.cam.value.y, cam.position.y) && U.cam.value.y !== before.y);

// ── The focus maths (what taps use) ──────────────────────────────────────────
cam.position.set(0, -100, 0); tgt.set(0, 0, 0); S.r = 30; S.cutR = 10; S.around = true; S.cut = true; S.focus = true; FX.update(true);
const f = (x, y, z) => FX.focusAt(x, y, z);
ok('focus maths: the orbit point and a point 10 m from it are fully in focus', near(f(0, 0, 0), 1) && near(f(10, 0, 0), 1) && f(0, 10, 0) > 0.99, [f(0, 0, 0), f(10, 0, 0)]);
ok('focus maths: beyond radius + soft width (30 + 18 m) everything is gone', f(60, 0, 0) === 0 && f(0, 0, 60) === 0);
ok('focus maths: between the two it fades (monotone, 0..1)', f(35, 0, 0) > 0 && f(35, 0, 0) < 1 && f(35, 0, 0) > f(42, 0, 0));
ok('focus maths: the kept sphere: just in front of the orbit point stays, behind it stays', f(0, -1, 0) > 0.9 && f(0, 5, 0) > 0.99, [f(0, -1, 0), f(0, 5, 0)]);
S.around = false; FX.update(true);
ok('only the cut: a point on the view axis half way between the camera and the target is cut away', f(0, -50, 0) < 0.01, f(0, -50, 0));
ok('only the cut: the same depth, 8 m off the axis (the hole is 5 m wide there), is not', f(8, -50, 0) > 0.9, f(8, -50, 0));
ok('only the cut: far to the side is untouched', f(60, 0, 0) === 1);
S.around = true; S.cut = false; FX.update(true);
ok('only the fade: the axis point 20 m from the target is untouched, far is gone', f(0, -20, 0) > 0.99 && f(0, 80, 0) === 0);
S.focus = false; FX.update(true);
ok('focus off: every tap factor is 1', FX.tapFactor({ x: 999, y: 999, z: 999 }) === 1);
S.focus = true; S.around = true; S.cut = true; FX.update(true);
ok('focus on: a far station cannot be tapped, the near one can', FX.tapFactor({ x: 200, y: 0, z: 0 }) === 0 && FX.tapFactor({ x: 3, y: 2, z: 1 }) > 0.99);

// ── setFocus: with no part on, it turns both on ──────────────────────────────
S.focus = false; S.around = false; S.cut = false;
let toast = null; FX.init({ THREE, scene, camera: cam, controls: { target: tgt }, toast: m => { toast = m; }, nearestStation: () => 500, units: { len: m => Math.round(m) + ' m' }, caveBox: () => null });
S.focus = false; S.around = false; S.cut = false;
FX.setFocus(true);
ok('setFocus(true) with both parts off turns both on', S.focus && S.around && S.cut);
ok('and says when nothing is near the orbit point', /nothing is within/.test(toast || ''), toast);
FX.setFocus(false);
ok('setFocus(false) turns it off but keeps the parts', !S.focus && S.around && S.cut);

// ── Wall sets ────────────────────────────────────────────────────────────────
function wallSet(tris, order) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tris * 3), 1));
  const layers = FX.makeWalls(geo, order || 0.5), grp = new THREE.Group(); grp.add(...layers);
  return { layers, grp, col: layers[0], pre: layers[1], rest: layers[0].children[0] };
}
Object.assign(S, D0);
const w = wallSet(100);
ok('a wall set is [colour, pre-pass] with the layers-behind pass as a child of the first', w.layers.length === 2 && w.rest && w.rest.isMesh && w.col.geometry === w.pre.geometry && w.rest.geometry === w.col.geometry);
ok('render orders: pre-pass first, layers behind, nearest layer last', w.pre.renderOrder < w.rest.renderOrder && w.rest.renderOrder < w.col.renderOrder);
ok('passes: pre-pass writes depth not colour; the others write colour, not depth; behind = GREATER', w.pre.material.depthWrite && !w.pre.material.colorWrite && w.col.material.colorWrite && !w.col.material.depthWrite && w.rest.material.colorWrite && !w.rest.material.depthWrite && w.rest.material.depthFunc === THREE.GreaterDepth);
ok('all passes are double sided and transparent (so renderOrder, not the opaque list, orders them)', [w.col, w.pre, w.rest].every(m => m.material.side === THREE.DoubleSide && m.material.transparent));
FX.applyWalls(0, 0.6);
ok('On: pre-pass visible, no layers-behind pass, opacity as given, depth test on, edges only lift the rims', w.pre.visible && !w.rest.visible && w.col.material.opacity === 0.6 && w.col.material.depthTest && w.col.material.userData.fxFace.value === 0);
FX.applyWalls(1, 0.6);
ok('Ghost: pre-pass, layers behind at a share of the ghost strength, nearest at the full strength', w.pre.visible && w.rest.visible && w.col.material.opacity === S.ghost && near(w.rest.material.opacity, S.ghost * FX.limits.restShare) && w.col.material.depthTest && w.col.material.userData.fxFace.value === 1);
FX.limits.layeredMaxTris = 50; FX.applyWalls(1, 0.6);
ok('Ghost over the triangle budget: one pass over every layer (no pre-pass, no depth test)', !w.pre.visible && !w.rest.visible && !w.col.material.depthTest);
FX.limits.layeredMaxTris = 700000;
FX.applyWalls(2, 0.6);
ok('Off: nothing of the set is visible by itself (the group is hidden by the viewer)', !w.pre.visible && !w.rest.visible);
S.ghost = 0.33; FX.applyWalls(1, 0.6);
ok('the ghost strength is used as soon as it changes', w.col.material.opacity === 0.33);
const w2 = wallSet(100, 0.51);
FX.applyWalls(0, 0.5);
ok('two sets (exported walls, field-survey walls) are both updated', w.col.material.opacity === 0.5 && w2.col.material.opacity === 0.5 && FX.wallSets.length === 2);
w2.grp.remove(w2.col, w2.pre);
FX.applyWalls(0, 0.5);
ok('a set that was removed from the scene drops out of the registry', FX.wallSets.length === 1);
let disposed = 0; w.rest.material.dispose = () => { disposed++; }; w.grp.remove(w.col);
ok('removing a set releases its child pass material', disposed === 1, disposed);

// ── Cost ─────────────────────────────────────────────────────────────────────
{
  cam.position.set(0, -100, 0); tgt.set(0, 0, 0); S.focus = true; FX.update(true);
  const N = 2e6; let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) FX.update();
  const ns1 = Number(process.hrtime.bigint() - t0) / N;
  t0 = process.hrtime.bigint(); let x = 0;
  for (let i = 0; i < 2e5; i++) x += FX.tapFactor({ x: i % 50, y: 0, z: 0 });
  const ns2 = Number(process.hrtime.bigint() - t0) / 2e5;
  console.log('  update() when nothing moved: ' + ns1.toFixed(0) + ' ns; one tap factor: ' + ns2.toFixed(0) + ' ns');
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
