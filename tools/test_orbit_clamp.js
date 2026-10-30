// Test for the portable viewer's orbit clamp (A2 in claude/10-roadmap.md).
//
// Pulls the "Orbit clamp" block straight out of viewer_build/viewer.html and
// drives it with the real three.js r128 and OrbitControls the viewer ships,
// panning hard at steep and shallow pitch, the way the render loop does:
// controls.update() then clampOrbitTarget(true) once per frame.
// Synthetic numbers only -- no export, no survey data.
//
//   node tools/test_orbit_clamp.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'viewer_build', 'viewer.html'), 'utf8');

// three + OrbitControls into one context (OrbitControls reads the global THREE)
const ctx = { console, Math, EventTarget, Event, window: {}, document: {} };
ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'three.min.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'OrbitControls.js'), 'utf8'), ctx);
const THREE = ctx.THREE;

const blk = html.match(/const ORBIT_Z_PAD[\s\S]*?(?=\n\/\/ ── Render loop)/);
if (!blk) { console.error('FAIL orbit clamp block not found in viewer.html'); process.exit(1); }

let fail = 0, pass = 0;
function ok(label, cond, info) {
  if (cond) { pass++; return; }
  fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + info : ''));
}
const EPS = 1e-6;

// Fake DOM element: enough for OrbitControls' constructor and keyboard pan.
function makeEl() {
  const el = new EventTarget();
  el.clientWidth = 400; el.clientHeight = 800; el.style = {};
  el.ownerDocument = new EventTarget();
  return el;
}
function key(el, code) {
  const e = new Event('keydown', { cancelable: true });
  Object.defineProperty(e, 'code', { value: code });
  el.dispatchEvent(e);
}

// Build a fresh viewer-like world: camera, controls, stations, terrain extent.
function world(opts) {
  const camera = new THREE.PerspectiveCamera(55, 0.5, 1, 60000);
  camera.up.set(0, 0, 1);
  const el = makeEl();
  const controls = new THREE.OrbitControls(camera, el);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 5; controls.maxDistance = 25000;
  controls.maxPolarAngle = Math.PI * 0.88;
  controls.keyPanSpeed = 40;
  controls.listenToKeyEvents(el);

  const stationMap = new Map();
  (opts.stations || []).forEach((z, i) => stationMap.set('s' + i, { pos: new THREE.Vector3(i, 0, z) }));
  const env = { THREE, controls, camera, stationMap, terrainScale: opts.terrainScale || 3000 };
  const api = new Function(...Object.keys(env),
    blk[0] + '\n_orbitTerrainZ = ' + JSON.stringify(opts.terrainZ || null) + ';' +
    '\n_orbitXY = ' + JSON.stringify(opts.terrainXY === undefined ? [-500, -500, 500, 500] : opts.terrainXY) + ';' +
    '\nupdateOrbitZRange();' +
    '\nreturn { updateOrbitZRange, clampOrbitTarget, orbitAimInRange,' +
    ' range: () => [_orbitZMin, _orbitZMax] };')(...Object.values(env));
  return Object.assign({ camera, controls, el }, api);
}

// Place the camera `dist` from the target, looking down at `pitchDeg`, facing +Y.
function aim(w, target, pitchDeg, dist) {
  const p = pitchDeg * Math.PI / 180;
  w.controls.target.copy(target);
  w.camera.position.set(target.x, target.y - dist * Math.cos(p), target.z + dist * Math.sin(p));
  w.controls.update();
}
// One render-loop frame, as in viewer.html's animate().
function frame(w) { w.controls.update(); w.clampOrbitTarget(true); }

// ── Range ──────────────────────────────────────────────────────────────────
{
  const w = world({ terrainZ: [100, 300], stations: [180, 40, 250] });
  const [lo, hi] = w.range();
  ok('range = min(terrain, stations) - 10', Math.abs(lo - 30) < EPS, lo);
  ok('range = max(terrain, stations) + 10', Math.abs(hi - 310) < EPS, hi);
  const w2 = world({ terrainZ: null, stations: [] });
  const r2 = w2.range();
  ok('no terrain, no caves -> no clamp', r2[0] === -Infinity && r2[1] === Infinity, r2);
  const w3 = world({ terrainZ: null, stations: [-50, -20] });
  const r3 = w3.range();
  ok('caves only (terrain failed to load)', Math.abs(r3[0] + 60) < EPS && Math.abs(r3[1] + 10) < EPS, r3);
  const w4 = world({ terrainZ: [100, 300], stations: [400] });
  ok('station above terrain widens the top', Math.abs(w4.range()[1] - 410) < EPS, w4.range());
}

// ── Pan up hard at a steep pitch: stops at the top, keeps sliding ──────────
function panRun(pitch, code, frames) {
  const w = world({ terrainZ: [100, 300], stations: [40] });
  aim(w, new THREE.Vector3(0, 0, 200), pitch, 400);
  const off0 = w.camera.position.clone().sub(w.controls.target);
  let maxOver = 0, hit = -1, xyAtHit = null, offErr = 0;
  const xy0 = new THREE.Vector2(w.controls.target.x, w.controls.target.y);
  for (let i = 0; i < frames; i++) {
    key(w.el, code);
    frame(w);
    const z = w.controls.target.z;
    maxOver = Math.max(maxOver, z - 310, 30 - z);
    if (hit < 0 && (Math.abs(z - 310) < 1e-3 || Math.abs(z - 30) < 1e-3)) {
      hit = i; xyAtHit = new THREE.Vector2(w.controls.target.x, w.controls.target.y);
    }
    const off = w.camera.position.clone().sub(w.controls.target);
    offErr = Math.max(offErr, off.distanceTo(off0));
  }
  const xyEnd = new THREE.Vector2(w.controls.target.x, w.controls.target.y);
  return { w, maxOver, hit, xy0, xyAtHit, xyEnd, offErr };
}

{
  const r = panRun(70, 'ArrowUp', 400);
  ok('steep up: target never above the band', r.maxOver <= 1e-6, r.maxOver);
  ok('steep up: reached the boundary', r.hit >= 0);
  const before = r.xyAtHit.distanceTo(r.xy0) / Math.max(1, r.hit);
  const after  = r.xyEnd.distanceTo(r.xyAtHit) / (400 - r.hit);
  ok('steep up: keeps sliding sideways after the limit (>= 90% of its speed)',
     after >= 0.9 * before, 'before ' + before.toFixed(2) + ' m/frame, after ' + after.toFixed(2));
  ok('steep up: view stays rigid (camera - target unchanged)', r.offErr < 1e-6, r.offErr);
  console.log('  steep 70 deg: hit top at frame ' + r.hit + ', slide ' +
              (r.xyEnd.distanceTo(r.xyAtHit) / (400 - r.hit)).toFixed(2) + ' m/frame horizontal');
}
{
  const r = panRun(70, 'ArrowDown', 400);
  ok('steep down: target never below the band', r.maxOver <= 1e-6, r.maxOver);
  ok('steep down: reached the boundary', r.hit >= 0);
  ok('steep down: horizontal motion survives',
     r.xyEnd.distanceTo(r.xyAtHit) > 0.5 * (400 - r.hit));
}
{
  const r = panRun(8, 'ArrowUp', 400);
  ok('shallow up: target never above the band', r.maxOver <= 1e-6, r.maxOver);
  ok('shallow up: reached the boundary', r.hit >= 0);
  ok('shallow up: view stays rigid', r.offErr < 1e-6, r.offErr);
  console.log('  shallow 8 deg: hit top at frame ' + r.hit + ', slide ' +
              (r.xyEnd.distanceTo(r.xyAtHit) / (400 - r.hit)).toFixed(2) + ' m/frame horizontal (expected small)');
}
{
  // sideways pans never touch Z, so the clamp must leave them exactly alone
  const w = world({ terrainZ: [100, 300], stations: [40] });
  aim(w, new THREE.Vector3(0, 0, 200), 45, 400);
  const z0 = w.controls.target.z;
  for (let i = 0; i < 100; i++) { key(w.el, 'ArrowLeft'); frame(w); }
  ok('sideways pan inside the band is untouched', Math.abs(w.controls.target.z - z0) < 1e-6);
}

// ── Camera unrestricted ──────────────────────────────────────────────────────
{
  const w = world({ terrainZ: [100, 300], stations: [40] });
  aim(w, new THREE.Vector3(0, 0, 200), 60, 20000);   // camera ~17 km up
  const cam = w.camera.position.clone();
  frame(w);
  ok('camera far outside the band, target inside: nothing moves',
     w.camera.position.distanceTo(cam) < 1e-6);
}

// ── clampOrbitTarget(false): re-aim only ─────────────────────────────────────
{
  const w = world({ terrainZ: [100, 300], stations: [40] });
  w.camera.position.set(0, -100, 900);
  w.controls.target.set(0, 0, 800);
  const moved = w.clampOrbitTarget(false);
  ok('re-aim clamp reports a change', moved === true);
  ok('re-aim clamp leaves the camera', w.camera.position.z === 900);
  ok('re-aim clamp puts target on the top', Math.abs(w.controls.target.z - 310) < EPS);
}

// ── Leaving fly/crane: orbitAimInRange ───────────────────────────────────────
{
  const w = world({ terrainZ: [100, 300], stations: [40], terrainXY: [-2000, -2000, 2000, 2000] });
  const cam = new THREE.Vector3(0, 0, 1000);
  const down45 = new THREE.Vector3(0, 1, -1).normalize();
  const p = w.orbitAimInRange(cam, down45, 300);          // 300 m ahead is still z~788
  ok('high camera looking down: centre on the top plane', Math.abs(p.z - 310) < 1e-6, p.z);
  const dirTo = p.clone().sub(cam).normalize();
  ok('high camera looking down: aim unchanged', dirTo.distanceTo(down45) < 1e-9);

  const level = new THREE.Vector3(0, 1, 0);
  const q = w.orbitAimInRange(cam, level, 300);
  ok('high camera looking level: centre dropped onto the top', Math.abs(q.z - 310) < 1e-6 && Math.abs(q.y - 300) < 1e-6, q.toArray());

  const inBand = new THREE.Vector3(0, 0, 150);
  const r = w.orbitAimInRange(inBand, level, 300);
  ok('camera in the band: centre exactly as before', r.distanceTo(new THREE.Vector3(0, 300, 150)) < 1e-9);

  const deep = new THREE.Vector3(0, 0, -400);
  const up = new THREE.Vector3(0, 1, 1).normalize();
  const s = w.orbitAimInRange(deep, up, 300);              // 300 m ahead is z~-188
  ok('deep camera looking up: centre on the bottom plane', Math.abs(s.z - 30) < 1e-6, s.z);
}

// ── Leaving fly/crane far off the map: centre pulled back over it ────────────
{
  const w = world({ terrainZ: [100, 300], stations: [40], terrainXY: [-500, -400, 500, 400] });
  const cam = new THREE.Vector3(3000, -2000, 2000);                 // km off the edge, high
  const away = new THREE.Vector3(1, -1, -0.2).normalize();          // looking further away
  const p = w.orbitAimInRange(cam, away, 300);
  ok('far off the map: centre back over the terrain', p.x <= 500 && p.x >= -500 && p.y <= 400 && p.y >= -400, p.toArray());
  ok('far off the map: centre in the band', p.z >= 30 - 1e-9 && p.z <= 310 + 1e-9, p.z);
  const inside = w.orbitAimInRange(new THREE.Vector3(0, 0, 150), new THREE.Vector3(0, 1, 0), 300);
  ok('over the map: centre unchanged', inside.distanceTo(new THREE.Vector3(0, 300, 150)) < 1e-9, inside.toArray());
}

// ── Wiring in viewer.html ────────────────────────────────────────────────────
{
  const loop = html.slice(html.indexOf('(function animate()'));
  const flyBranch = loop.slice(loop.indexOf('if (flyMode) {'), loop.indexOf('} else {\n    // Follow mode keeps'));
  ok('loop clamps once, in the orbit branch', (loop.match(/clampOrbitTarget\(true\)/g) || []).length === 1);
  ok('fly/crane branch is not clamped', !/clampOrbitTarget/.test(flyBranch));
  ok('clamp runs right after controls.update() in the loop',
     /controls\.update\(\);\n\s*clampOrbitTarget\(true\);\n\s*\}\n\n\s*renderer\.render/.test(loop));
  ok('range computed when caves load', /updateOrbitZRange\(\);\n\}/.test(html));
  ok('terrain extent captured at load', /_orbitTerrainZ = \[box\.min\.z, box\.max\.z\]/.test(html) && /_orbitXY = \[box\.min\.x/.test(html));
  ok('exitFlyMode aims into the band', /controls\.target\.copy\(orbitAimInRange\(camera\.position, dir/.test(html));
}

// ── Cost ─────────────────────────────────────────────────────────────────────
{
  const w = world({ terrainZ: [100, 300], stations: [40] });
  aim(w, new THREE.Vector3(0, 0, 200), 45, 400);
  const N = 2e6, t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) w.clampOrbitTarget(true);
  const ns = Number(process.hrtime.bigint() - t0) / N;
  console.log('  clampOrbitTarget: ' + ns.toFixed(1) + ' ns per call (once per drawn frame)');
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
