// Test for the underside of the ground in the portable viewer (viewer_build/libs/terrain-under.js), without a browser.
//
// Loads the real three.js r128 the viewer ships, wall-fx.js and the module into one context, then checks:
//  - the numbers: the slider's range, what is drawn for a given terrain opacity;
//  - the shader patches still find their anchors in r128's own shaders (Basic, Lambert, Points, LineDashed, Sprite),
//    alone and after wall-fx.js / trees.js / ridgewalk.js patched the same material (an upgrade of three.min.js that
//    moves an anchor fails here, not silently on a phone); the depth samplers are highp;
//  - patch(): which materials it takes, that it never replaces someone else's onBeforeCompile;
//  - the wiring with a stub renderer: nothing at 0 %, one back-face mesh per terrain mesh SHARING its geometry, the
//    extra render into the target before the scene's own, the terrain's opacity, the eye under the ground, the
//    fall-back without WebGL 2, a render into someone's target;
//  - viewer.html and the other libs call it where they should.
// Synthetic numbers only.
//
//   node tools/test_terrain_under.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const lib = n => fs.readFileSync(path.join(root, 'viewer_build', 'libs', n), 'utf8');
const ctx = { console: { log() {}, warn(m) { warns.push(String(m)); }, error: console.error }, Math, EventTarget, Event, window: {}, document: undefined };
const warns = [];
ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(lib('three.min.js'), ctx);
vm.runInContext(lib('wall-fx.js'), ctx);
vm.runInContext(lib('terrain-under.js'), ctx);
ctx.window.THREE = ctx.THREE;
vm.runInContext('window.console = console;', ctx);
const THREE = ctx.THREE, FX = ctx.window.FlexFx, UN = ctx.window.FlexUnder;

let fail = 0, pass = 0;
function ok(label, cond, info) {
  if (cond) { pass++; return; }
  fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 500) : ''));
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const count = (s, t) => s.split(t).length - 1;

ok('the module defines FlexUnder', !!UN && typeof UN.init === 'function' && typeof UN.patch === 'function' && typeof UN.shader === 'function');

// ── Numbers ──────────────────────────────────────────────────────────────────
ok('a new map: 90 %', UN.DEFAULT === 90 && UN.get() === 90);
ok('clampPct: whole per cent, 0..100, junk = the default', UN.clampPct(37.4) === 37 && UN.clampPct(-5) === 0 && UN.clampPct(250) === 100 && UN.clampPct('x') === 90 && UN.clampPct(undefined) === 90 && UN.clampPct('35') === 35 && UN.clampPct(0) === 0);
ok('strength: the slider\'s share at the usual terrain opacity', near(UN.strength(90, 0.7), 0.9) && near(UN.strength(90, 1), 0.9) && near(UN.strength(50, 0.3), 0.5));
ok('strength: nothing at 0 %, nothing when the terrain is not drawn', UN.strength(0, 0.7) === 0 && UN.strength(90, 0) === 0);
ok('strength: fades with a nearly invisible terrain (below 30 %)', near(UN.strength(90, 0.15), 0.45) && near(UN.strength(100, 0.03), 0.1) && UN.strength(90, 0.29) < 0.9);
ok('the inside colour is dark and nearly grey (reads on the aerial and on the hillshade)', (() => { const c = [(UN.COLOUR >> 16) & 255, (UN.COLOUR >> 8) & 255, UN.COLOUR & 255]; return Math.max(...c) < 110 && Math.min(...c) > 40 && Math.max(...c) - Math.min(...c) < 30 && c[0] >= c[2]; })(), UN.COLOUR.toString(16));

// ── Shader text ──────────────────────────────────────────────────────────────
const shaderOf = id => ({ vertexShader: THREE.ShaderLib[id].vertexShader, fragmentShader: THREE.ShaderLib[id].fragmentShader, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib[id].uniforms) });
const endsWithTest = f => /gl_FragColor\.a \*= 1\.0 - uUnder\.x; \}\s*\}\s*$/.test(f);
for (const id of ['basic', 'lambert', 'points', 'dashed']) {
  const sh = UN.shader(shaderOf(id));
  ok(`${id}: the thinning is the last statement of main(), declared once, uniforms shared`, endsWithTest(sh.fragmentShader) && count(sh.fragmentShader, 'uniform highp sampler2D uUnderDepth') === 1 && count(sh.fragmentShader, 'uniform vec4 uUnder;') === 1
    && sh.uniforms.uUnderDepth === UN.uniforms.depth && sh.uniforms.uUnder === UN.uniforms.p, sh.fragmentShader.slice(-300));
  const again = UN.shader(sh).fragmentShader;
  ok(`${id}: patching twice changes nothing`, again === sh.fragmentShader && count(again, 'uUnder.x > 0.0') === 1);
}
{
  const sh = UN.shader(shaderOf('sprite'));
  ok('sprite: thinned as a whole, by its own point, in the vertex shader', /vUnderK = 1\.0 - uUnder\.x; \} \}\s*\}\s*$/.test(sh.vertexShader) && sh.vertexShader.includes('projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)')
    && count(sh.vertexShader, 'uniform highp sampler2D uUnderDepth') === 1 && /gl_FragColor\.a \*= vUnderK;\s*\}\s*$/.test(sh.fragmentShader) && !sh.fragmentShader.includes('uUnderDepth'), [sh.vertexShader.slice(-260), sh.fragmentShader.slice(-80)]);
  ok('sprite: the varying is declared on both sides', count(sh.vertexShader, 'varying float vUnderK;') === 1 && count(sh.fragmentShader, 'varying float vUnderK;') === 1);
  const v = sh.vertexShader, f = sh.fragmentShader; UN.shader(sh);
  ok('sprite: patching twice changes nothing', sh.vertexShader === v && sh.fragmentShader === f);
}
ok('the depth is never read through a low-precision sampler', !/uniform\s+sampler2D\s+(uUnderDepth|tDepth)/.test(lib('terrain-under.js')) && count(lib('terrain-under.js'), 'highp sampler2D') >= 3);

// with wall-fx.js: its materials get the thinning from the same compile; the terrain gets "front faces only" instead
FX.init({ THREE, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3() }, caveBox: () => null });
{
  const line = FX.patch(new THREE.LineBasicMaterial({ depthTest: false, transparent: true })), sp = FX.patch(new THREE.SpriteMaterial({ depthTest: false }));
  const a = shaderOf('basic'), b = shaderOf('sprite');
  line.onBeforeCompile.call(line, a); sp.onBeforeCompile.call(sp, b);
  ok('wall-fx lines and dots: focus and the thinning in one shader', a.fragmentShader.includes('fxFocus(vFxW)') && endsWithTest(a.fragmentShader) && a.uniforms.uUnder === UN.uniforms.p);
  ok('wall-fx names and leads: focus and the sprite thinning', b.fragmentShader.includes('fxFocus(vFxW)') && b.fragmentShader.includes('gl_FragColor.a *= vUnderK;') && b.vertexShader.includes('vUnderK = 1.0 - uUnder.x'));
  const [col, pre] = FX.makeWalls(new THREE.BufferGeometry(), 0.5), w = shaderOf('lambert');
  col.material.onBeforeCompile.call(col.material, w);
  ok('wall-fx walls: thinned too (after the pre-pass has returned)', endsWithTest(w.fragmentShader) && w.fragmentShader.indexOf('return;') < w.fragmentShader.indexOf('uUnder.x > 0.0'));
  const tm = FX.patchTerrain(new THREE.MeshLambertMaterial()), t = shaderOf('lambert');
  tm.onBeforeCompile.call(tm, t);
  ok('the terrain: never thinned; with Underside on its own back faces are dropped', !t.fragmentShader.includes('uUnderDepth') && t.fragmentShader.includes('if (uUnderOn > 0.5 && !gl_FrontFacing) discard;') && t.uniforms.uUnderOn === UN.uniforms.on && t.fragmentShader.includes('fxCutOnly(vFxW)'));
  const raw = shaderOf('basic'); FX.terrainShader(raw);
  ok('wall-fx hands out the cut alone (for the inside\'s own material)', raw.fragmentShader.includes('fxCutOnly(vFxW)') && !raw.fragmentShader.includes('uUnderOn'));
}
{
  const s = UN.sunk(shaderOf('lambert'));
  ok('trees and bushes: the sunk parts, only with the eye under the ground, never where there is no inside face', s.fragmentShader.includes('uUnderCam > 0.5 && uUnder.x > 0.0') && s.fragmentShader.includes('uD < 1.0 && gl_FragCoord.z <= uD + uUnder.w') && s.uniforms.uUnderCam === UN.uniforms.cam
    && count(s.fragmentShader, 'uniform highp sampler2D uUnderDepth') === 1 && s.fragmentShader.indexOf('uUnderCam > 0.5') > s.fragmentShader.indexOf('void main()'));
  const f = s.fragmentShader; UN.sunk(s); ok('sunk: twice changes nothing', s.fragmentShader === f);
}

// ── patch() ──────────────────────────────────────────────────────────────────
{
  const m = new THREE.LineBasicMaterial({ depthTest: false, transparent: true });
  ok('patch: a plain material gets the one shared compile function', UN.patch(m) === m && m.userData.underPatched === true && typeof m.onBeforeCompile === 'function' && m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile);
  const m2 = UN.patch(new THREE.SpriteMaterial({ depthTest: false }));
  ok('patch: every such material shares the function (one program per kind)', m2.onBeforeCompile === m.onBeforeCompile && m.customProgramCacheKey() === m2.customProgramCacheKey());
  const sh = shaderOf('basic'); m.onBeforeCompile.call(m, sh);
  ok('patch: and it does the thinning', endsWithTest(sh.fragmentShader));
  const fx = FX.patch(new THREE.SpriteMaterial({ depthTest: false })), keep = fx.onBeforeCompile;
  ok('patch: a wall-fx material is left alone (it has the thinning already)', UN.patch(fx) === fx && fx.onBeforeCompile === keep && !fx.userData.underPatched);
  const own = new THREE.PointsMaterial(); const mine = function (s) { s.mine = 1; }; own.onBeforeCompile = mine;
  warns.length = 0;
  ok('patch: someone else\'s onBeforeCompile is never replaced (a warning says what to do)', UN.patch(own) === own && own.onBeforeCompile === mine && warns.length === 1 && /FlexUnder\.shader/.test(warns[0]), warns);
  const sm = new THREE.ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' });
  UN.patch(sm);
  ok('patch: a ShaderMaterial is edited in place', endsWithTest(sm.fragmentShader) && sm.uniforms.uUnder === UN.uniforms.p && sm.userData.underPatched === true);
  ok('patch: null is fine', UN.patch(null) === null);
}

// ── Wiring, with a stub renderer ─────────────────────────────────────────────
function stubRenderer(webgl2) {
  const r = { capabilities: { isWebGL2: webgl2 }, info: { render: { triangles: 0, calls: 0, frame: 0 } }, autoClear: true, log: [], target: null, clear: [0x0a0a0f, 1] };
  r.getDrawingBufferSize = v => v.set(640, 480);
  r.getRenderTarget = () => r.target;
  r.setRenderTarget = t => { r.target = t; r.log.push(t ? 'target' : 'screen'); };
  r.getClearColor = c => c.setHex(r.clear[0]); r.getClearAlpha = () => r.clear[1];
  r.setClearColor = (c, a) => { r.clear = [c.isColor ? c.getHex() : c, a]; };
  r.render = (scene, camera) => {
    let tris = 0, calls = 0; const seen = [];
    scene.traverse(o => { if (o.isMesh && o.visible) { calls++; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; seen.push(o); } });
    r.info.render.triangles = tris; r.info.render.calls = calls; r.log.push('render:' + (scene === r.main ? 'main' : 'under') + ':' + calls + ':' + (r.target ? 'target' : 'screen') + ':clear=' + r.clear.join());
    r.lastSeen = seen;
  };
  return r;
}
function world(webgl2, o) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 4 / 3, 1, 60000), terrain = new THREE.Group(), r = stubRenderer(webgl2);
  r.main = scene; scene.add(terrain);
  const before = []; scene.onBeforeRender = () => before.push('fx');
  const tile = (x) => { const g = new THREE.PlaneGeometry(100, 100, 4, 4); const m = new THREE.Mesh(g, FX.patchTerrain(new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.7, side: THREE.DoubleSide }))); m.position.x = x; m.updateMatrixWorld(true); terrain.add(m); return m; };
  const tiles = [tile(0), tile(100)];
  scene.updateMatrixWorld(true);
  let redraws = 0, ground = 50;
  UN.init(Object.assign({ THREE, renderer: r, scene, camera, terrain: () => terrain, groundZ: () => ground, redraw: () => redraws++ }, o || {}));
  const frame = target => { scene.onBeforeRender(r, scene, camera, target || null); };
  return { scene, camera, terrain, tiles, r, before, frame, redraws: () => redraws, setGround: g => { ground = g; } };
}
{
  const W = world(true);
  ok('init: WebGL 2 = the composite way, a screen triangle in the scene at renderOrder -2, hidden', UN.stats().mode === 'composite' && UN.objects().quad.parent === W.scene && UN.objects().quad.renderOrder === -2 && UN.objects().quad.visible === false && UN.objects().quad.frustumCulled === false);
  ok('init: the value given is the value (none: 90)', UN.get() === 90);
  W.camera.position.set(0, 0, 100); W.frame();
  let s = UN.stats(), o = UN.objects();
  ok('a frame at 90 %: what the scene did before a render still runs, first', W.before.length === 1);
  ok('a frame at 90 %: one back-face mesh per terrain mesh, sharing its geometry, in a scene of their own', s.on && s.meshes === 2 && o.meshes.every((m, i) => m.geometry === W.tiles[i].geometry && m.parent !== W.terrain && m.parent !== W.scene && m.material.side === THREE.BackSide) && o.meshes[0].material === o.meshes[1].material);
  ok('...placed as the terrain meshes are', o.meshes[1].matrixWorld.elements[12] === 100 && o.meshes[0].matrixWorld.elements[12] === 0 && o.meshes[0].matrixAutoUpdate === false);
  ok('...drawn once into the target (cleared to nothing), then the renderer is as it was', W.r.log.join(' ') === 'target render:under:2:target:clear=0,0 screen' && W.r.clear[0] === 0x0a0a0f && W.r.clear[1] === 1 && W.r.autoClear === true && W.r.target === null, W.r.log);
  ok('...the pass is the terrain once: its triangles, its draw calls', s.triangles === 64 && s.calls === 2 && s.target[0] === 640 && s.target[1] === 480);
  ok('...the target carries a 24-bit depth texture read by the patched materials and the screen triangle', o.target.depthTexture && o.target.depthTexture.type === THREE.UnsignedIntType && UN.uniforms.depth.value === o.target.depthTexture && o.quad.material.uniforms.tDepth.value === o.target.depthTexture && o.quad.material.uniforms.tColour.value === o.target.texture);
  ok('...the screen triangle: shown, blended at the share, tested against and writing the depth', o.quad.visible && near(o.quad.material.uniforms.uShare.value, 0.9) && o.quad.material.transparent && o.quad.material.depthTest && o.quad.material.depthWrite && o.quad.material.fragmentShader.includes('gl_FragDepth = d;') && o.quad.material.fragmentShader.includes('if (d >= 1.0) discard;'));
  ok('...the shared uniforms: share, 1 / size, terrain front faces only, the eye above the ground', near(UN.uniforms.p.value.x, 0.9) && near(UN.uniforms.p.value.y, 1 / 640) && near(UN.uniforms.p.value.z, 1 / 480) && UN.uniforms.on.value === 1 && UN.uniforms.cam.value === 0);
  ok('...the terrain itself is untouched: still double-sided (taps, height queries), nothing added to its group', W.tiles.every(t => t.material.side === THREE.DoubleSide) && W.terrain.children.length === 2);
  const sh = shaderOf('basic'); o.material.onBeforeCompile.call(o.material, sh);
  ok('the inside\'s material: plain colour, the focus cut, headlight shading, no map picture', o.material.isMeshBasicMaterial && o.material.color.getHex() === UN.COLOUR && !o.material.map && sh.fragmentShader.includes('fxCutOnly(vFxW)') && sh.fragmentShader.includes('dFdx(vUnderV)') && sh.vertexShader.includes('vUnderV = mvPosition.xyz;') && !sh.fragmentShader.includes('uUnderOn'));
  W.camera.position.set(0, 0, 20); W.frame();
  ok('the eye under the ground is told to the trees and bushes', UN.uniforms.cam.value === 1);
  W.setGround(null); W.frame(); ok('...off the map (no ground height): not under the ground', UN.uniforms.cam.value === 0);
  // the second frame makes nothing new
  const m0 = UN.objects().meshes[0], t0 = UN.objects().target; W.frame();
  ok('the next frame reuses the meshes and the target', UN.objects().meshes[0] === m0 && UN.objects().target === t0);
  // the terrain's opacity
  W.tiles.forEach(t => { t.material.opacity = 0.15; }); W.frame();
  ok('terrain at 15 %: the inside fades with it', near(UN.stats().share, 0.45) && near(UN.objects().quad.material.uniforms.uShare.value, 0.45) && near(UN.uniforms.p.value.x, 0.45));
  W.tiles.forEach(t => { t.material.opacity = 0; }); W.r.log.length = 0; W.frame();
  ok('terrain at 0 %: nothing is drawn', !UN.stats().on && UN.stats().meshes === 0 && !UN.objects().quad.visible && W.r.log.length === 0 && UN.uniforms.on.value === 0 && UN.uniforms.p.value.x === 0);
  W.tiles.forEach(t => { t.material.opacity = 0.7; }); W.frame();
  ok('...and it is back with the terrain', UN.stats().on && UN.stats().meshes === 2);
  // the slider
  ok('set(): clamps, asks for a frame', UN.set(40) === 40 && UN.get() === 40 && W.redraws() === 1 && UN.set(400) === 100 && UN.set(-3) === 0);
  W.r.log.length = 0; W.frame();
  s = UN.stats(); o = UN.objects();
  ok('0 %: no mesh, no target, no extra render, the triangle hidden, every switch off', !s.on && s.meshes === 0 && s.target === null && s.triangles === 0 && !o.quad.visible && W.r.log.length === 0 && UN.uniforms.p.value.x === 0 && UN.uniforms.on.value === 0 && UN.uniforms.cam.value === 0 && UN.uniforms.depth.value === null);
  W.frame(); ok('0 %: and the next frame does nothing at all', W.r.log.length === 0);
  UN.set(90); W.frame();
  // the terrain changes (tiles replaced)
  const g2 = new THREE.PlaneGeometry(50, 50, 2, 2); W.terrain.remove(W.tiles[1]); W.tiles[0].geometry = g2; W.frame();
  ok('the terrain\'s meshes changed: the back-face meshes follow', UN.stats().meshes === 1 && UN.objects().meshes[0].geometry === g2 && UN.stats().triangles === 8);
  W.terrain.visible = false; W.frame();
  ok('a hidden terrain has no inside', !UN.stats().on && !UN.objects().quad.visible);
  W.terrain.visible = true; W.frame();
  // a render into someone's target
  W.r.log.length = 0; W.frame({ isWebGLRenderTarget: true });
  ok('a render into someone else\'s target: no inside, no thinning (the depth picture is the screen\'s)', W.r.log.length === 0 && !UN.objects().quad.visible && UN.uniforms.p.value.x === 0 && UN.uniforms.on.value === 0);
  W.frame(); ok('...and the next frame for the screen is whole again', UN.objects().quad.visible && near(UN.uniforms.p.value.x, 0.9));
  // another scene's render is not ours
  W.r.log.length = 0; const other = new THREE.Scene(); W.scene.onBeforeRender(W.r, other, W.camera, null);
  ok('a render of another scene is left alone', W.r.log.length === 0);
}
{
  const W = world(true, { value: 35 });
  ok('init with a saved value', UN.get() === 35);
  W.frame(); ok('...drawn at it', near(UN.stats().share, 0.35));
  const W0 = world(true, { value: 0 });
  W0.frame(); ok('init with a saved 0: nothing', UN.get() === 0 && !UN.stats().on && W0.r.log.length === 0);
}
{
  const W = world(false);
  ok('no WebGL 2: the fall-back', UN.stats().mode === 'simple' && !UN.objects().quad && UN.objects().holder.parent === W.scene && UN.objects().holder.renderOrder === -2);
  W.frame();
  const o = UN.objects();
  ok('fall-back: see-through back-face meshes in the scene, sharing the geometry, no target, no extra render', UN.stats().on && o.meshes.length === 2 && o.meshes.every((m, i) => m.geometry === W.tiles[i].geometry && m.material.side === THREE.BackSide && m.material.transparent && m.material.depthWrite && near(m.material.opacity, 0.9)) && !o.target && W.r.log.length === 0);
  ok('fall-back: the terrain drops its back faces; the layers without a depth test are not thinned', UN.uniforms.on.value === 1 && UN.uniforms.p.value.x === 0 && UN.uniforms.cam.value === 0);
  UN.set(0); W.frame();
  ok('fall-back at 0 %: gone', UN.objects().meshes.length === 0 && UN.uniforms.on.value === 0);
  const W2 = world(true, { simple: true });
  ok('the fall-back can be asked for (viewer.html?under=simple)', UN.stats().mode === 'simple');
}

// ── The viewer and the other libs call it ────────────────────────────────────
{
  const html = fs.readFileSync(path.join(root, 'viewer_build', 'viewer.html'), 'utf8');
  const hooks = [['<script src="libs/terrain-under.js"></script>', 1, 1], ['FlexUnder.init(', 1, 1], ['id="terrain-under-slider"', 1, 1], ['id="terrain-under-label"', 1, 1], ["['Underside', 'terrain-under-slider', 'terrain-under-label']", 1, 1],
    ["under: sl('terrain-under-slider')", 1, 1], ["['terrain-under-slider', 'under']", 1, 1], ['FlexUnder.set(', 1, 1], ['FlexUnder.patch(', 5, 8]];
  for (const [t, lo, hi] of hooks) { const n = count(html, t); ok(`viewer.html has ${t} ${lo === hi ? lo : lo + '-' + hi} time(s)`, n >= lo && n <= hi, n); }
  ok('viewer.html: the slider starts at 90, 0..100', /id="terrain-under-slider" min="0" max="100" value="90"/.test(html));
  ok('viewer.html: loaded after wall-fx.js, started after FlexFx.init (it chains the scene\'s onBeforeRender)', html.indexOf('libs/terrain-under.js') > html.indexOf('libs/wall-fx.js') && html.indexOf('FlexUnder.init(') > html.indexOf('FlexFx.init('));
  ok('viewer.html: the slider is parked with the others when a sheet closes', /uiStash[\s\S]{0,300}'terrain-under-slider', 'terrain-under-label'/.test(html));
  ok('viewer.html: a tool\'s readout and the surface features\' names are made onTop', html.includes('makeTextSprite(text, color, true)') && html.includes('textSprite: (t, c) => makeTextSprite(t, c, true)'));
  ok('viewer.html: text sprites are thinned unless onTop', html.includes('if (!onTop) FlexUnder.patch(mat);'));
  ok('ridgewalk.js: returns, shapes and guessed openings', count(lib('ridgewalk.js'), 'root.FlexUnder.shader(sh)') === 1 && count(lib('ridgewalk.js'), 'root.FlexUnder.patch(m)') === 2);
  ok('ridge-marks.js: the marks', count(lib('ridge-marks.js'), 'root.FlexUnder.patch(sp.material)') === 1);
  ok('trees.js and brush-bushes.js: the sunk parts', count(lib('trees.js'), 'root.FlexUnder.sunk(sh)') === 1 && count(lib('brush-bushes.js'), 'root.FlexUnder.sunk(sh)') === 1);
  ok('viewer-features.js is not thinned: "Show through hills" is its own switch', !lib('viewer-features.js').includes('FlexUnder'));
  // every lib the template names is inlined by viewer_inline.py: the file must exist
  ok('the lib file is where the template says', fs.existsSync(path.join(root, 'viewer_build', 'libs', 'terrain-under.js')));
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
