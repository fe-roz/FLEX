// The touch choice of the viewer (viewer_build/libs/ground-drag.js): the pure maths of "Drag the ground" (map-style
// touch), the choice of three with the old switch carried over, and the snap of "Orbit on the ground".
// The view ray against three.js itself, the ground march over a made-up hill, the drag that keeps the grabbed spot
// under the finger, zoom / turn / tilt about a spot with their limits, and the two-finger rule (tilt or zoom).
//   node tools/test_ground_drag.js
'use strict';
const M = require('../viewer_build/libs/ground-drag.js').math;
const THREE = require('../viewer_build/libs/three.min.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + (typeof i === 'string' ? i : JSON.stringify(i)).slice(0, 700) : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);
const nearV = (a, b, e) => a.every((v, i) => near(v, b[i], e));
const add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k), sub = (a, b) => a.map((v, i) => v - b[i]);
const len = a => Math.hypot(...a);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const FOV = 55, ASPECT = 800 / 600;
// Where a point of the scene lands on the screen (-1..1), by three.js: the independent check of every move.
function project(pose, q) {
  const cam = new THREE.PerspectiveCamera(FOV, ASPECT, 1, 60000);
  cam.up.set(0, 0, 1); cam.position.set(...pose.p); cam.lookAt(new THREE.Vector3(...pose.t)); cam.updateMatrixWorld(true);
  const v = new THREE.Vector3(...q).project(cam);
  return [v.x, v.y];
}
const hitZ = (pose, nx, ny, z) => { const d = M.rayDir(pose, FOV, ASPECT, nx, ny), t = M.planeHit(pose.p, d, [0, 0, z], [0, 0, 1]); return t === null ? null : add(pose.p, mul(d, t)); };

// ── The view ray ─────────────────────────────────────────────────────────────
const poses = [
  { p: [100, -400, 300], t: [120, 40, 10] },
  { p: [0, 0, 500], t: [0, 0.0005, 0] },                    // straight down, as OrbitControls leaves it
  { p: [-50, 80, -40], t: [0, 0, 20] },                     // from under the ground, looking up
  { p: [10, -300, 12], t: [10, 0, 10] },                    // almost level
];
let worst = 0;
poses.forEach(pose => [[0, 0], [0.7, -0.4], [-1, 1], [0.2, 0.9]].forEach(([nx, ny]) => {
  const d = M.rayDir(pose, FOV, ASPECT, nx, ny), s = project(pose, add(pose.p, mul(d, 250)));
  worst = Math.max(worst, Math.abs(s[0] - nx), Math.abs(s[1] - ny));
}));
ok('a view ray goes through its screen point (three.js projects it back), in every kind of view', worst < 1e-6, worst);

// ── The ground march ─────────────────────────────────────────────────────────
const box = { minX: -500, minY: -500, maxX: 500, maxY: 500, cell: 2 };
const hill = (x, y) => (x < -500 || x > 500 || y < -500 || y > 500 ? null : 60 * Math.exp(-(x * x + y * y) / (2 * 120 * 120)));
let calls = 0; const counted = (x, y) => { calls++; return hill(x, y); };
{
  const pose = { p: [0, -600, 250], t: [0, 0, 0] };
  const d = M.rayDir(pose, FOV, ASPECT, 0.1, -0.2), t = M.marchRay(pose.p, d, counted, box, 60000);
  const q = add(pose.p, mul(d, t));
  ok('the march finds the ground under a screen point', t !== null && near(q[2], hill(q[0], q[1]), 1e-3), [t, q]);
  ok('…with a bounded number of reads of the height grid (no walk in tiny steps)', calls > 0 && calls < 1700, calls);
  const flat = M.planeHit(pose.p, d, [0, 0, 0], [0, 0, 1]);
  ok('…and it is the hill, nearer than the flat plane behind it', t < flat - 1, [t, flat]);
  // the near side of the hill, not the far side: the ray toward the top from the south, low
  const low = { p: [0, -450, 30], t: [0, 0, 30] }, dl = M.rayDir(low, FOV, ASPECT, 0, 0), tl = M.marchRay(low.p, dl, hill, box, 60000), ql = add(low.p, mul(dl, tl));
  ok('a level ray stops at the near slope', tl !== null && ql[1] < 0 && near(ql[2], hill(ql[0], ql[1]), 1e-3), ql);
  ok('a ray into the sky finds nothing', M.marchRay(pose.p, M.rayDir({ p: pose.p, t: [0, 0, 900] }, FOV, ASPECT, 0, 0), hill, box, 60000) === null);
  ok('a ray that never crosses the map finds nothing', M.marchRay([2000, 2000, 100], [0.6, 0.8, 0], hill, box, 60000) === null);
  const under = { p: [0, 0, -80], t: [0, 0.001, 0] }, du = M.rayDir(under, FOV, ASPECT, 0, 0), tu = M.marchRay(under.p, du, hill, box, 60000);
  ok('from under the ground the march finds the surface above', tu !== null && near(tu, 140, 0.01), tu);
  ok('holes in the grid (null, NaN) are stepped over', M.marchRay(pose.p, d, (x, y) => (y < -300 ? null : y < -250 ? NaN : hill(x, y)), box, 60000) !== null);
  ok('a vertical ray outside the map finds nothing, inside it finds the ground', M.marchRay([900, 0, 100], [0, 0, -1], hill, box, 1000) === null && near(M.marchRay([0, 0, 100], [0, 0, -1], hill, box, 1000), 40, 1e-3));
}

// ── One finger: the grabbed spot stays under the finger ──────────────────────
{
  const pose = { p: [100, -400, 300], t: [120, 40, 10] };
  const d0 = M.rayDir(pose, FOV, ASPECT, -0.3, -0.2), G = add(pose.p, mul(d0, M.planeHit(pose.p, d0, [0, 0, 25], [0, 0, 1])));
  const shift = M.panTo(pose, M.rayDir(pose, FOV, ASPECT, 0.45, 0.35), G, [0, 0, 1]);
  const after = M.translate(pose, shift), s = project(after, G);
  ok('after a drag the grabbed spot is under the finger', near(s[0], 0.45, 1e-9) && near(s[1], 0.35, 1e-9), s);
  ok('…the view only slid level: no change of height, distance or direction', near(shift[2], 0, 1e-9) && nearV(sub(after.p, after.t), sub(pose.p, pose.t), 1e-9));
  ok('a finger above the horizon moves nothing', M.panTo(pose, M.rayDir(pose, FOV, ASPECT, 0, 5), G, [0, 0, 1]) === null);
  ok('a finger so near the horizon that the spot would be very far moves nothing', M.panTo(pose, M.rayDir(pose, FOV, ASPECT, 0, 1.52), G, [0, 0, 1], 3000) === null && M.panTo(pose, M.rayDir(pose, FOV, ASPECT, 0, 0.5), G, [0, 0, 1], 3000) !== null);
  // a plane that faces the camera (a level view of nothing): the same rule, any plane
  const lvl = { p: [0, -300, 12], t: [0, 0, 12] }, f = M.basis(lvl).f, Q = [20, 0, 30];
  const sh = M.panTo(lvl, M.rayDir(lvl, FOV, ASPECT, -0.5, 0.1), Q, f), s2 = project(M.translate(lvl, sh), Q);
  ok('the same on a plane facing the camera', near(s2[0], -0.5, 1e-9) && near(s2[1], 0.1, 1e-9) && Math.abs(sh[1]) < 1e-9, [s2, sh]);
}

// ── Zoom, turn, tilt about a spot ────────────────────────────────────────────
{
  const pose = { p: [100, -400, 300], t: [120, 40, 10] }, G = [60, -80, 25], s0 = project(pose, G);
  const z = M.zoom(pose, G, 0.5, 5, 25000), s1 = project(z, G);
  ok('zoom keeps its spot where it was on the screen and halves the distances', nearV(s0, s1, 1e-9) && near(len(sub(z.p, z.t)), len(sub(pose.p, pose.t)) / 2, 1e-9) && near(len(sub(z.p, G)), len(sub(pose.p, G)) / 2, 1e-9));
  const d = len(sub(pose.p, pose.t));
  ok('zoom stops at the nearest and the farthest distance', near(len(sub(M.zoom(pose, G, 0.001, 5, 25000).p, M.zoom(pose, G, 0.001, 5, 25000).t)), 5, 1e-6) &&
    near(len(sub(M.zoom(pose, G, 1e4, 5, 25000).p, M.zoom(pose, G, 1e4, 5, 25000).t)), 25000, 1e-3) && d > 5);
  const far = { p: [0, 0, 30000], t: [0, 0.01, 0] };
  ok('a view already past the limit may come back in but not go further', len(sub(M.zoom(far, [0, 0, 0], 1.5, 5, 25000).p, far.p)) < 1e-6 && M.zoom(far, [0, 0, 0], 0.5, 5, 25000).p[2] < 16000);
  const t = M.turn(pose, G, 0.6);
  ok('a turn keeps the spot, the heights and the distance, and swings the view by its angle', near(len(sub(t.p, G)), len(sub(pose.p, G)), 1e-9) && near(t.p[2], pose.p[2]) && near(t.t[2], pose.t[2]) &&
    near(M.polar(t), M.polar(pose), 1e-9) && near(Math.atan2(t.t[1] - t.p[1], t.t[0] - t.p[0]) - Math.atan2(pose.t[1] - pose.p[1], pose.t[0] - pose.p[0]), 0.6, 1e-9));
  const ph = M.polar(pose), up = M.tilt(pose, G, 0.3, 1e-4, Math.PI * 0.88);
  ok('a tilt changes the angle from straight down by what was asked, about the spot', near(M.polar(up), ph + 0.3, 1e-9) && near(len(sub(up.p, G)), len(sub(pose.p, G)), 1e-9) && up.p[2] < pose.p[2]);
  ok('…the bearing does not change', near(Math.atan2(up.t[1] - up.p[1], up.t[0] - up.p[0]), Math.atan2(pose.t[1] - pose.p[1], pose.t[0] - pose.p[0]), 1e-9));
  ok('…and it stops at the limits', near(M.polar(M.tilt(pose, G, 5, 1e-4, 1.4)), 1.4, 1e-9) && near(M.polar(M.tilt(pose, G, -5, 0.2, 1.4)), 0.2, 1e-9));
  ok('a tilt of nothing is the same view', M.tilt(pose, G, 0, 1e-4, 3) === pose);
}

// ── Two fingers ──────────────────────────────────────────────────────────────
{
  let st = M.twoStart([300, 300], [500, 300]);
  ok('nothing is decided inside the first few pixels', M.twoStep(st, [302, 304], [500, 303]).mode === null);
  let s = M.twoStep(st, [301, 280], [502, 281]);
  ok('both fingers up together = tilt, counted from the start', s.mode === 'tilt' && near(s.dy, -19.5) && s.k === 1 && s.twist === 0, s);
  s = M.twoStep(st, [250, 270], [560, 271]);
  ok('…and it stays a tilt for the whole gesture, whatever the fingers do next', s.mode === 'tilt' && near(s.dy, -10));
  st = M.twoStart([300, 300], [500, 300]);
  s = M.twoStep(st, [280, 300], [520, 300]);
  ok('fingers apart = zoom in by the ratio of the gaps', s.mode === 'zoom' && near(s.k, 200 / 240) && s.twist === 0, s);
  s = M.twoStep(st, [260, 300], [540, 300]);
  ok('…step by step', near(s.k, 240 / 280));
  st = M.twoStart([300, 300], [500, 300]);
  ok('one finger still and one moving up is not a tilt', M.twoStep(st, [300, 300], [500, 270]).mode === 'zoom');
  st = M.twoStart([300, 300], [500, 300]);
  ok('both fingers sideways = moving the map (zoom mode, no zoom, no turn)', (s = M.twoStep(st, [340, 302], [540, 301])).mode === 'zoom' && near(s.k, 1, 0.01) && s.twist === 0 && near(s.mid[0], 440));
  st = M.twoStart([300, 300], [500, 300]);
  ok('fingers up together but spreading = zoom, not tilt', M.twoStep(st, [280, 270], [530, 268]).mode === 'zoom');
  // a twist: nothing until the dead zone is passed, then every further bit
  st = M.twoStart([300, 300], [500, 300]);
  const at = a => [[400 - 100 * Math.cos(a), 300 - 100 * Math.sin(a)], [400 + 100 * Math.cos(a), 300 + 100 * Math.sin(a)]];
  let turned = 0, steps = [];
  for (let a = 0.02; a <= 0.4001; a += 0.02) { s = M.twoStep(st, ...at(a)); turned += s.twist; steps.push(s.twist); }
  ok('a small twist turns nothing (a pinch is not a turn)', steps.slice(0, 6).every(v => v === 0), steps);
  ok('past the dead zone the twist turns the map by what the fingers turn from there on', turned > 0.2 && turned < 0.4 - M.TWIST_DEAD + 0.021 && near(steps[steps.length - 1], 0.02, 1e-9), turned);
  st = M.twoStart([390, 300], [410, 300]);
  let tw = 0; for (let a = 0.1; a <= 1.5; a += 0.1) tw += M.twoStep(st, [400 - 10 * Math.cos(a), 300 - 10 * Math.sin(a)], [400 + 10 * Math.cos(a), 300 + 10 * Math.sin(a)]).twist;
  ok('fingers too close together to give a direction do not turn the map', tw === 0);
}

// ── The whole two-finger move, looking straight down: both spots stay under their fingers ──────────────────────
{
  // As the viewer applies a step: zoom about the spot, turn about it, then put the spot back under the middle.
  const W = 800, H = 600, ndc = p => [p[0] / W * 2 - 1, 1 - p[1] / H * 2];
  let pose = { p: [30, -20, 400], t: [30, -19.999, 0] };
  const a0 = [300, 300], b0 = [500, 300], m0 = [400, 300];
  const gA = hitZ(pose, ...ndc(a0), 0), gB = hitZ(pose, ...ndc(b0), 0), G = hitZ(pose, ...ndc(m0), 0);
  const st = M.twoStart(a0, b0);
  let a, b;
  for (let i = 1; i <= 40; i++) {
    const ang = i * 0.02, r = 100 + i * 2, c = [400 + i * 1.5, 300 - i];
    a = [c[0] - r * Math.cos(ang), c[1] - r * Math.sin(ang)]; b = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
    const s = M.twoStep(st, a, b);
    if (s.mode !== 'zoom') continue;
    pose = M.zoom(pose, G, s.k, 5, 25000);
    if (s.twist) pose = M.turn(pose, G, s.twist);
    const sh = M.panTo(pose, M.rayDir(pose, FOV, ASPECT, ...ndc(s.mid)), G, [0, 0, 1]);
    if (sh) pose = M.translate(pose, sh);
  }
  const px = q => { const s = project(pose, q); return [(s[0] + 1) / 2 * W, (1 - s[1]) / 2 * H]; };
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], pm = px(G);
  ok('pinch + twist + move: the spot between the fingers is still between them', Math.hypot(pm[0] - mid[0], pm[1] - mid[1]) < 0.01, [pm, mid]);
  // the turn lags the fingers by the dead zone, so each finger's own spot is off by that angle at most, and on the right side
  const pa = px(gA), pb = px(gB), rr = Math.hypot(a[0] - mid[0], a[1] - mid[1]);
  const lag = Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
  ok('…each finger still has its own spot under it, but for the dead zone of the twist (and the turn goes the fingers’ way)',
    near(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), 2 * rr, 0.5) && lag > 0 && lag < M.TWIST_DEAD + 0.03, [pa, pb, a, b, lag]);
  ok('…the view is still straight down and its height went down with the zoom', M.polar(pose) < 1e-4 && near(pose.p[2], 400 * 100 / 180, 0.5), pose);
}

// ── The choice of three, and the switch of before ────────────────────────────
{
  ok('nothing saved = Orbit, the default', M.modeFrom(undefined, undefined) === 'orbit' && M.modeFrom(null, false) === 'orbit');
  ok('the old switch on = Drag the ground; off = Orbit', M.modeFrom(undefined, true) === 'drag' && M.modeFrom(undefined, false) === 'orbit');
  ok('a saved choice wins over the old switch', M.modeFrom('ground', true) === 'ground' && M.modeFrom('orbit', true) === 'orbit' && M.modeFrom('drag', false) === 'drag');
  ok('a value that is not one of the three falls back to the old switch', M.modeFrom('map', true) === 'drag' && M.modeFrom(7, undefined) === 'orbit' && M.modeFrom(true, undefined) === 'orbit');
  // the viewer side, with a made-up camera and controls
  const fresh = () => { delete require.cache[require.resolve('../viewer_build/libs/ground-drag.js')]; return require('../viewer_build/libs/ground-drag.js'); };
  const world = (saved, savedOld) => {
    const G = fresh(), saves = [], lis = { addEventListener() {} };
    const cam = { position: new THREE.Vector3(0, -300, 200), fov: FOV, far: 60000, lookAt(v) { this.looked = v.clone(); } };
    const controls = { target: new THREE.Vector3(0, 0, 0), enableRotate: true, enablePan: true, enableZoom: true, screenSpacePanning: true, enabled: true, minDistance: 5, maxDistance: 25000, maxPolarAngle: Math.PI * 0.88, update() {} };
    G.init({ camera: cam, controls, dom: Object.assign({ ownerDocument: lis, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) }, lis), groundZ: hill, bounds: () => box, saved, savedOld, save: m => saves.push(m) });
    return { G, cam, controls, saves };
  };
  const flags = c => [c.enableRotate, c.enablePan, c.enableZoom, c.screenSpacePanning];
  let w = world(undefined, undefined);
  ok('a new map starts in Orbit with OrbitControls untouched', w.G.mode() === 'orbit' && w.G.on() === false && flags(w.controls).every(v => v === true) && w.saves.length === 0);
  ok('…and in Orbit the per-frame snap and the aim after flying do nothing', w.G.snap() === false && w.G.aim() === false && w.cam.position.z === 200 && w.controls.target.z === 0);
  w.G.setMode('ground');
  ok('Orbit on the ground: OrbitControls keeps rotate, pan and zoom; its pan goes along the ground; saved as "ground"', w.G.mode() === 'ground' && w.G.on() === false && eq(flags(w.controls), [true, true, true, false]) && eq(w.saves, ['ground']), [flags(w.controls), w.saves]);
  ok('…the snap puts the centre on the ground and the camera up by the same', w.G.snap() === true && near(w.controls.target.z, 60) && near(w.cam.position.z, 260) && w.G.snap() === false, [w.controls.target.z, w.cam.position.z]);
  w.G.setMode('drag');
  ok('Drag the ground: rotate, pan, zoom off, the pan rule back; on() is true', w.G.on() === true && eq(flags(w.controls), [false, false, false, true]) && eq(w.saves, ['ground', 'drag']) && w.G.snap() === false);
  w.G.setOn(false);
  ok('setOn(false) from Drag = Orbit, everything back', w.G.mode() === 'orbit' && flags(w.controls).every(v => v === true) && eq(w.saves, ['ground', 'drag', 'orbit']));
  w.G.setMode('ground'); w.G.setOn(false);
  ok('setOn(false) while on the ground changes nothing (it was not on); setOn(true) = Drag', w.G.mode() === 'ground' && (w.G.setOn(true), w.G.mode() === 'drag') && eq(flags(w.controls), [false, false, false, true]));
  w.G.setMode('nonsense');
  ok('an unknown choice is ignored', w.G.mode() === 'drag');
  ok('the old switch saved on starts in Drag; a saved "ground" starts on the ground', world(undefined, true).G.mode() === 'drag' && world('ground', true).G.mode() === 'ground' && world('ground', true).controls.screenSpacePanning === false);
  // leaving fly mode on the ground: the centre goes where the view meets the ground, the camera stays
  w = world('ground');
  w.cam.position.set(0, -400, 300); w.controls.target.set(0, -350, 250);          // 71 m ahead, in the air
  const c0 = w.cam.position.toArray();
  ok('aim(): the centre lands on the ground along the view, the camera is not moved', w.G.aim() === true && eq(w.cam.position.toArray(), c0) && near(w.controls.target.z, hill(w.controls.target.x, w.controls.target.y), 1e-3) &&
    near(w.controls.target.x, 0, 1e-9) && near((w.controls.target.y + 400) / (300 - w.controls.target.z), 1, 1e-9), w.controls.target.toArray());
  ok('…and the snap that follows has nothing to do', w.G.snap() === false);
  w.cam.position.set(0, -400, 300); w.controls.target.set(0, -400.001, 900);
  ok('aim() at the sky leaves the centre to the snap', w.G.aim() === false);
}

// ── Orbit on the ground: the snap ────────────────────────────────────────────
{
  const MARGIN = 2;
  const slope = (x, y) => (Math.abs(x) > 500 || Math.abs(y) > 500 ? null : 100 + 0.5 * x + 20 * Math.sin(y / 40));
  const offs = q => sub(q.p, q.t);
  let st = {}, pose = { p: [100, -300, 400], t: [120, 40, 77] };
  let q = M.groundSnap(pose, slope, st, MARGIN);
  ok('the centre goes to the ground at its x, y', near(q.t[2], slope(120, 40), 1e-12) && q.t[0] === 120 && q.t[1] === 40);
  ok('…and the camera by the same amount: the offset between them is the same, to the bit, so distance, tilt and bearing are', eq(offs(q).slice(0, 2), offs(pose).slice(0, 2)) && near(offs(q)[2], offs(pose)[2], 1e-12) && near(q.p[2] - pose.p[2], q.dz, 1e-12));
  // the view: every scene point lands on the screen where it would if the scene had moved down by dz instead
  const pts = [[60, -80, 25], [300, 200, 240], [120, 40, 77]];
  ok('…the picture is the same picture, moved straight up or down by that amount (three.js)', pts.every(P => nearV(project(q, add(P, [0, 0, q.dz])), project(pose, P), 1e-9)));
  ok('again with nothing moved: the same object back, nothing written', M.groundSnap(q, slope, st, MARGIN) === q);
  // orbiting and zooming: the camera moves, the centre does not
  let same = true;
  for (let i = 1; i <= 40; i++) { const o = M.zoom(M.turn(q, q.t, i * 0.1), q.t, 1 - i * 0.01, 5, 25000); if (M.groundSnap(o, slope, st, MARGIN) !== o) same = false; }
  ok('orbiting and zooming about the centre change nothing, at any angle (no jitter on a slope)', same);
  // a pan across the slope, in steps: always on the ground, and each step's change of height is the ground's
  let worstG = 0, worstO = 0, cur = q;
  for (let i = 0; i < 200; i++) {
    const m = M.translate(cur, [1.3, 0.9, 0.4]);          // OrbitControls moved both (a little off the level too)
    const n = M.groundSnap(m, slope, st, MARGIN);
    worstG = Math.max(worstG, Math.abs(n.t[2] - slope(n.t[0], n.t[1])));
    worstO = Math.max(worstO, len(sub(offs(n), offs(q))));
    cur = n;
  }
  ok('a pan across a slope: the centre is on the ground after every step and the offset never changes', worstG < 1e-9 && worstO < 1e-9, [worstG, worstO]);
  // off the map: the height is kept
  st = {};
  const edge = M.groundSnap({ p: [480, -200, 500], t: [499, 0, 300] }, slope, st, MARGIN);
  const out = { p: add(edge.p, [10, 0, 0]), t: add(edge.t, [10, 0, 0]) };
  ok('off the map (no ground): nothing moves, the last height stays', M.groundSnap(out, slope, st, MARGIN) === out && near(out.t[2], slope(499, 0)));
  ok('a hole in the grid (NaN, undefined) is the same', M.groundSnap(out, () => NaN, {}, MARGIN) === out && M.groundSnap(out, () => undefined, {}, MARGIN) === out);
  // the camera stays above the ground when the centre moves down under a ridge
  const ridge = (x, y) => (x < 0 ? 100 : 0);              // a 100 m step: high ground at x < 0
  st = {};
  let a = M.groundSnap({ p: [-50, 0, 130], t: [-10, 0, 100] }, ridge, st, MARGIN);
  ok('(the camera starts 30 m over the high ground)', st.above === true && a.p[2] === 130);
  let b = M.groundSnap(M.translate(a, [20, 0, 0]), ridge, st, MARGIN);      // the centre steps off the edge: 100 m down
  ok('the centre drops 100 m; the camera, still over the high ground, stays above it by the margin', b.t[2] === 0 && near(b.p[2], 100 + MARGIN) && b.lifted === true && b.p[0] === -30, b);
  b = M.groundSnap(M.translate(b, [40, 0, 0]), ridge, st, MARGIN);
  ok('…and once the camera is over the low ground too nothing lifts it', b.t[2] === 0 && near(b.p[2], 100 + MARGIN) && !b.lifted);
  // …but a camera the user took under the ground is left there
  st = {};
  a = M.groundSnap({ p: [-50, 0, 60], t: [-10, 0, 100] }, ridge, st, MARGIN);
  b = M.groundSnap(M.translate(a, [0, 5, 0]), ridge, st, MARGIN);
  ok('a camera under the ground (orbited there to look up at a cave) is not lifted by a pan', st.above === false && b.p[2] === 60 && !b.lifted);
  st = {};
  a = M.groundSnap({ p: [-50, 0, 130], t: [-10, 0, 100] }, ridge, st, MARGIN);
  const under = { p: [-50, 0, 80], t: a.t };              // orbited under: the centre did not move
  ok('orbiting under the ground is not stopped', M.groundSnap(under, ridge, st, MARGIN) === under && st.above === false);
  // the crumbs of a damped pan under a zoom: the centre creeps by fractions of a millimetre while the camera comes down
  st = {};
  a = M.groundSnap({ p: [-50, 0, 130], t: [-10, 0, 100] }, ridge, st, MARGIN);
  const zoomed = { p: [-50, 1e-5, 101], t: [-10, 1e-5, 100] };
  ok('a zoom that brings the camera to the ground is not a move of the centre: no lift', M.groundSnap(zoomed, ridge, st, MARGIN) === zoomed);
  ok('…and a camera within the margin still counts as above, so the next pan keeps it out of the ground', st.above === true && M.groundSnap(M.translate(zoomed, [0, 5, 0]), ridge, st, MARGIN).p[2] === 100 + MARGIN);
  // cost: reads of the height grid per frame
  let reads = 0; const cnt = (x, y) => { reads++; return slope(x, y); };
  M.groundSnap(q, cnt, {}, MARGIN);
  ok('two reads of the height grid per frame, no ray', reads === 2, reads);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
