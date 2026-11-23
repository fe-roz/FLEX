// The arithmetic of the LiDAR Section tool (client/src/modules/section-math.js): which returns are in the slice,
// where they fall along the line, the view (1:1, exaggeration, zoom at the cursor), the ground line and height above
// it, the ruler in metres and feet, the scale bar and ticks, the ends as text. Made-up numbers only.
//   node tools/test_section_math.js
'use strict';
const M = require('./load_classic')(require('path').join(__dirname, '..', 'client', 'src', 'modules', 'section-math.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + JSON.stringify(i).slice(0, 500) : '')); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ── the line ────────────────────────────────────────────────────────────────
let fr = M.frame([100, 200], [103, 204]);                       // 3-4-5: 5 units long
ok('frame: length, unit direction, metres per unit 1', near(fr.len, 5) && near(fr.ux, 0.6) && near(fr.uy, 0.8) && fr.k === 1 && fr.L === 5, fr);
ok('a place on the line: its distance along, nothing across', (([d, o]) => near(d, 2.5) && near(o, 0))(M.project(fr, 101.5, 202)));
ok('left of the line is +, right is −', M.project(fr, 100 - 0.8, 200 + 0.6)[1] > 0.99 && M.project(fr, 100 + 0.8, 200 - 0.6)[1] < -0.99);
ok('there and back', (([x, y]) => near(x, 101.5 - 0.8 * 2) && near(y, 202 + 0.6 * 2))(M.unproject(fr, 2.5, 2)), M.unproject(fr, 2.5, 2));
ok('no line between the same two places', M.frame([1, 1], [1, 1]) === null);
// a web-mercator cloud at 45.1234 N: its units are 1 / cos(lat) too long
const a = { lon: -100.5678, lat: 45.1234 }, b = { lon: -100.5665, lat: 45.1234 };
const L = M.groundDistance(a, b);
ok('distance on the globe: 0.0013 degrees of longitude at 45.1234 N is about 102 m', near(L, 0.0013 * Math.PI / 180 * 6371008.8 * Math.cos(45.1234 * Math.PI / 180), 0.01), L);
const merc = p => [p.lon * Math.PI / 180 * 6378137, Math.log(Math.tan(Math.PI / 4 + p.lat * Math.PI / 360)) * 6378137];
fr = M.frame(merc(a), merc(b), L);
ok('a mercator cloud: its units are scaled to true metres (k = cos latitude, to 0.5 %)', near(fr.k, Math.cos(45.1234 * Math.PI / 180), 0.004) && near(fr.L, L), fr.k);
ok('half way along that line is half the true length', near(M.project(fr, (merc(a)[0] + merc(b)[0]) / 2, merc(a)[1])[0], L / 2, 1e-6));
ok('a 2 m slice asks the cloud for 2 / k of its own units', near(M.widthInUnits(fr, 2), 2 / fr.k));

// ── which returns are in the slice ──────────────────────────────────────────
fr = M.frame([0, 0], [100, 0]);
const pts = [[10, 0, 500], [20, 0.9, 501], [30, -1.1, 502], [40, 4.9, 503], [50, 5.1, 504], [-1, 0, 505], [100.5, 0, 506], [100, 0, 507], [0, 0, 508]];
const xyz = new Float32Array(pts.flat());
const out = { d: new Float32Array(20), z: new Float32Array(20), off: new Float32Array(20), n: 0 }, src = [];
let took = M.collect(fr, xyz, pts.length, null, 10, out, 20, (i, j) => { src[j] = i; });
ok('collect: within 5 m of the line and between the ends (both ends count); not past them', took === 6 && src.join() === '0,1,2,3,7,8', [took, src]);
ok('…their distance along, their side, their height', near(out.d[1], 20) && near(out.off[1], 0.9, 1e-6) && near(out.off[2], -1.1, 1e-6) && out.z[3] === 503);
ok('counts by thickness', M.countWithin(out.off, out.n, 2) === 4 && M.countWithin(out.off, out.n, 0.5) === 3 && M.countWithin(out.off, out.n, 2.4) === 5 && M.countWithin(out.off, out.n, 10) === 6);
ok('height range of a slice', M.heightRange(out.z, out.off, out.n, 0.5).join() === '500,508' && M.heightRange(out.z, out.off, 0, 2) === null);
const o2 = { d: new Float32Array(3), z: new Float32Array(3), off: new Float32Array(3), n: 0 };
ok('collect stops when there is no room left', M.collect(fr, xyz, pts.length, null, 10, o2, 3) === 3 && o2.n === 3);
const o3 = { d: new Float32Array(9), z: new Float32Array(9), off: new Float32Array(9), n: 0 };
M.collect(fr, new Float32Array([10, 0, 1.5]), 1, [0, 0, 498.5], 10, o3, 9);
ok('positions relative to the cloud get the cloud\'s own place added (so the height is the one the map draws)', near(o3.z[0], 500) && near(o3.d[0], 10));

// ── the view ────────────────────────────────────────────────────────────────
let v = M.fit(100, 500, 520, 800, 400, 1, 20);
ok('fit at 1:1: one scale both ways, the whole section inside the margins, centred', near(v.sx, 7.6) && near(M.toX(v, 0), 20) && near(M.toX(v, 100), 780) && M.toY(v, 500) > M.toY(v, 520) && near((M.toY(v, 500) + M.toY(v, 520)) / 2, 200), v);
ok('a metre up is as many pixels as a metre along', near(M.toY(v, 500) - M.toY(v, 501), M.toX(v, 1) - M.toX(v, 0)));
ok('pixels back to metres', near(M.fromX(v, M.toX(v, 37.5)), 37.5) && near(M.fromY(v, M.toY(v, 512.25)), 512.25));
const v4 = M.fit(100, 500, 520, 800, 400, 4, 20);
ok('4x: a metre up is four times a metre along, and it still fits', near((M.toY(v4, 500) - M.toY(v4, 501)) / (M.toX(v4, 1) - M.toX(v4, 0)), 4) && M.toY(v4, 520) >= 19.9 && M.toY(v4, 500) <= 380.1, v4);
const z2 = M.zoomAt(v, 300, 150, 2);
ok('zoom at the cursor: what is under it stays under it', near(z2.sx, v.sx * 2) && near(M.fromX(z2, 300), M.fromX(v, 300)) && near(M.fromY(z2, 150), M.fromY(v, 150)));
ok('pan moves by pixels', near(M.toX(M.pan(v, 10, -5), 0), M.toX(v, 0) + 10) && near(M.toY(M.pan(v, 10, -5), 500), M.toY(v, 500) - 5));
const e2 = M.setExag(v, 2, 800, 400);
ok('another exaggeration keeps the middle of the picture where it is', near(M.fromY(e2, 200), M.fromY(v, 200)) && e2.exag === 2 && e2.sx === v.sx);
const D = new Float32Array([10, 10.2, 50]), Z = new Float32Array([505, 505.1, 510]), O = new Float32Array([0, 3, 0]);
ok('nearest return to a pixel, among those in the slice', M.nearest(v, D, Z, O, 3, 2, M.toX(v, 10.15), M.toY(v, 505.08), 8) === 0 && M.nearest(v, D, Z, O, 3, 10, M.toX(v, 10.15), M.toY(v, 505.08), 8) === 1);
ok('nothing near: -1', M.nearest(v, D, Z, O, 3, 10, M.toX(v, 80), M.toY(v, 505), 8) === -1);

// ── the ground along the section ────────────────────────────────────────────
{
  const n = 12, d = new Float32Array(n), z = new Float32Array(n), off = new Float32Array(n), cls = new Uint8Array(n);
  [[0.5, 500, 2], [0.6, 500.2, 2], [0.7, 500.4, 2], [0.5, 512, 5], [3.5, 503, 2], [3.4, 520, 5], [9.5, 509, 2], [9.5, 300, 7], [1.5, 400, 2], [5.5, 506, 3], [6.5, 506.5, 1], [7.5, 507, 2]].forEach((p, i) => { d[i] = p[0]; z[i] = p[1]; cls[i] = p[2]; });
  off[8] = 4;                                                         // a ground return outside a 2 m slice
  const gl = M.groundLine(d, z, off, cls, n, 2, 10, 1);
  ok('ground line: the median of the ground returns per metre', near(gl.g[0], 500.2, 1e-4) && near(gl.g[3], 503, 1e-4) && near(gl.g[9], 509, 1e-4) && near(gl.g[7], 507, 1e-4), Array.from(gl.g));
  ok('…gaps filled straight between the metres that have ground; vegetation and noise do not count', near(gl.g[1], 500.2 + (503 - 500.2) / 3, 1e-3) && near(gl.g[5], 505, 1e-3) && near(gl.g[8], 508, 1e-3), Array.from(gl.g));
  ok('height above it', near(512 - M.groundAt(gl, 0.5), 11.8, 1e-3) && near(M.groundAt(gl, 2), 500.2 + (503 - 500.2) / 2, 1e-3) && near(M.groundAt(gl, 99), 509, 1e-4) && near(M.groundAt(gl, -5), 500.2, 1e-4));
  ok('no ground return in the slice: no ground line', M.groundLine(d, z, off, new Uint8Array(n).fill(5), n, 2, 10, 1) === null && isNaN(M.groundAt(null, 3)));
}
// ── colours ─────────────────────────────────────────────────────────────────
ok('by class: ground brown, vegetation and the unclassified green, noise pink', M.classColour(2).join() === M.GROUND_RGB.join() && M.classColour(5).join() === M.OTHER_RGB.join() && M.classColour(1).join() === M.OTHER_RGB.join() && M.classColour(7).join() !== M.OTHER_RGB.join());
ok('class names', M.className(2) === 'ground' && M.className(5) === 'high vegetation' && M.className(64) === 'class 64');
ok('by height above ground: on the ground brown, higher greener then blue, below the ground pink', M.hagColour(0).join() === M.GROUND_RGB.join() && M.hagColour(10)[1] > M.hagColour(10)[0] && M.hagColour(40)[2] > 200 && M.hagColour(-5)[0] === 255 && M.hagColour(NaN).join() === M.OTHER_RGB.join(), [M.hagColour(1), M.hagColour(10), M.hagColour(40)]);

// ── the ruler, the scale, words ─────────────────────────────────────────────
const r = M.ruler({ d: 10, z: 500 }, { d: 13, z: 504 });
ok('ruler: across 3, up 4, straight 5, 53 degrees', near(r.horizontal, 3) && near(r.vertical, 4) && near(r.straight, 5) && near(r.slope, 53.13, 0.01), r);
ok('…in metres with feet in brackets', M.rulerText(r, false) === 'across 3.0 m (9.8 ft) · up 4.0 m (13.1 ft) · straight 5.0 m (16.4 ft) · 53°', M.rulerText(r, false));
ok('…and feet first when FLEX is set to imperial; down when the second is lower', M.rulerText(M.ruler({ d: 13, z: 504 }, { d: 10, z: 500 }), true) === 'across 9.8 ft (3.0 m) · down 13.1 ft (4.0 m) · straight 16.4 ft (5.0 m) · 53°', M.rulerText(M.ruler({ d: 13, z: 504 }, { d: 10, z: 500 }), true));
ok('a vertical pair is 90 degrees', M.ruler({ d: 5, z: 1 }, { d: 5, z: 9 }).slope === 90);
ok('scale bar: a round length near the target', M.scaleBar(23, false).label === '20 m' && near(M.scaleBar(23, false).metres, 20) && M.scaleBar(7, false).label === '5 m' && M.scaleBar(0.3, false).label === '0.2 m', [M.scaleBar(23, false), M.scaleBar(0.3, false)]);
ok('…in feet: a round number of feet, its length in metres', M.scaleBar(23, true).label === '50 ft' && near(M.scaleBar(23, true).metres, 50 / M.FT), M.scaleBar(23, true));
const t = M.ticks(503.2, 548.7, 6);
ok('ticks: round steps inside the range', t.step === 10 && t.values.join() === '510,520,530,540', t);
ok('the ends as FLEX copies a place: "lat, lon", five decimals, one a line', M.endsText(a, b) === '45.12340, -100.56780\n45.12340, -100.56650', M.endsText(a, b));
const al = M.alongOf(a, b, { lon: -100.56715, lat: 45.1234 + 0.00001 });
ok('a place on the map: how far along the section it is, and to which side', near(al.d, L / 2, 0.05) && al.off > 1 && al.off < 1.3, al);
ok('…and the place d metres along', (p => near(p.lon, -100.56715, 1e-6) && near(p.lat, 45.1234))(M.placeAt(a, b, L / 2)));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
