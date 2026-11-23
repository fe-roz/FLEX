// The pure parts of client/src/modules/ridge-draw.js (a processed area's ridgewalking result on the globe): settings,
// the patches file, where the area's metres are in the local frame (the lattice), the terrain shift, the vertex
// buffers of shapes / returns / openings with the phone's colours, greying and hiding a "nothing" feature. With the
// phone's own modules for what both share (depth colours, boxes, the tap rule). Made-up numbers.
//
//   node tools/test_ridge_draw.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const RD = require('./load_classic')(path.join(root, 'client', 'src', 'modules', 'ridge-draw.js'));
const RM = require(path.join(root, 'viewer_build', 'libs', 'ridge-marks.js'));
const ctx = { window: {}, console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'ridgewalk.js'), 'utf8'), ctx);
const FR = ctx.window.FlexRidge;
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + JSON.stringify(i).slice(0, 500) : '')); } };
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;

// ── settings ──
ok('defaults: shapes, openings and marks on; every kind of dot off; 3 px, 45 %, on terrain', JSON.stringify(RD.DEFAULTS) === JSON.stringify({ shapes: true, ret: false, lone: false, noise: false, pattern: false, openings: true, marks: true, hideNothing: false, size: 3, opacity: 0.45, onTerrain: true }));
const s = RD.clampSettings({ shapes: 0, ret: 'yes', size: 99, opacity: -3, junk: 1, hideNothing: true, marks: null });
ok('settings are made safe: switches are booleans, numbers clamped, unknown fields dropped, null keeps the old', s.shapes === false && s.ret === true && s.size === 12 && s.opacity === 0.05 && !('junk' in s) && s.hideNothing === true && s.marks === true);
ok('a setting on top of saved ones keeps the rest', RD.clampSettings({ size: '5' }, { shapes: false, opacity: 0.8 }).shapes === false && RD.clampSettings({ size: '5' }, { opacity: 0.8 }).size === 5 && RD.clampSettings({ size: 'x' }, { size: 7 }).size === 7);

// ── patches.bin ──
const pb = Buffer.alloc(16 + 3 * 12); pb.write('RWQ1', 0, 'latin1'); pb.writeUInt32LE(2, 4); pb.writeUInt32LE(1, 8); pb.writeFloatLE(0.3, 12);
[[10.15, 20.15, 500], [10.45, 20.15, 500.5], [50.15, 5.15, 498]].forEach((p, i) => p.forEach((v, k) => pb.writeFloatLE(v, 16 + (i * 3 + k) * 4)));
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const Q = RD.parsePatchCells(ab(pb));
ok('RWQ1: counts of true and guessed cells, the cell, the centres', Q.nTrue === 2 && Q.nGuess === 1 && near(Q.cell, 0.3) && near(Q.xyz[3], 10.45) && Q.xyz[8] === 498);
const throws = f => { try { f(); return false; } catch (_) { return true; } };
ok('a wrong, empty or short file is refused', throws(() => RD.parsePatchCells(ab(Buffer.from('RWP1' + '\0'.repeat(12))))) && throws(() => RD.parsePatchCells(new ArrayBuffer(0))) && throws(() => RD.parsePatchCells(ab(pb).slice(0, 30))));

// ── the lattice: metres of the area → the local frame ──
// a made-up frame: the area 1000 x 800 m, turned 2 degrees against the local frame, on a curved earth, lattice 5 x 5
const N = 5, Wd = 1000, Hg = 800, rot = 2 * Math.PI / 180, Rr = 6371000;
const truth = (x, y, z) => { const dx = x - Wd / 2, dy = y - Hg / 2, e = dx * Math.cos(rot) - dy * Math.sin(rot), n = dx * Math.sin(rot) + dy * Math.cos(rot), k = 1 + z / Rr; return [e * k, n * k, z - (e * e + n * n) / (2 * Rr)]; };
const nodes = h => { const a = new Float64Array(N * N * 3); for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const t = truth(i / (N - 1) * Wd, j / (N - 1) * Hg, h); a.set(t, (j * N + i) * 3); } return a; };
const place = RD.placer(nodes(0), nodes(RD.H_STEP), N, Wd, Hg), out = new Float32Array(3);
place(0, 0, 0, out, 0); const c0 = truth(0, 0, 0);
ok('a lattice node is its own place', near(out[0], c0[0], 1e-3) && near(out[1], c0[1], 1e-3) && near(out[2], c0[2], 1e-3), [Array.from(out), c0]);
let worst = 0; for (const [x, y, z] of [[137, 455, 520], [999, 1, 1480], [500, 400, 0], [61, 799, 2300], [733, 222, 35]]) { place(x, y, z, out, 0); const t = truth(x, y, z); worst = Math.max(worst, Math.hypot(out[0] - t[0], out[1] - t[1], out[2] - t[2])); }
ok('between nodes and at any height the place is right to a centimetre (the turn against grid north and the earth\'s curve included)', worst < 0.01, worst);
place(-50, 900, 100, out, 0); const tx = truth(-50, 900, 100);
ok('a little outside the rectangle it carries on (no jump)', Math.hypot(out[0] - tx[0], out[1] - tx[1]) < 0.05);
const o2 = new Float32Array(9); place(500, 400, 10, o2, 6); ok('it writes where it is told', o2[0] === 0 && o2[5] === 0 && near(o2[6], truth(500, 400, 10)[0], 1e-3) && near(o2[8], 10, 0.02));

// ── the terrain shift ──
const g = [100, 110, 120, 130], shown = Float32Array.from([103, 113, 126, 136]);            // 2 x 2: the shown terrain is 3 m higher in the south, 6 m in the north
let sh = RD.makeShift(g, shown, 2, 2, Wd, Hg);
ok('shift = shown terrain - the area\'s own ground, interpolated', near(sh.at(0, 0), 3) && near(sh.at(Wd, Hg), 6) && near(sh.at(Wd / 2, Hg / 2), 4.5) && sh.known === 4 && near(sh.mean, 4.5));
sh = RD.makeShift([100, null, 120, 130], Float32Array.from([103, 113, NaN, 136]), 2, 2, Wd, Hg);
ok('where the ground or the terrain is unknown the mean of the rest is used', sh.known === 2 && near(sh.mean, 4.5) && near(sh.at(Wd, 0), 4.5) && near(sh.at(0, 0), 3));
ok('nothing known: no shift; a constant shift is constant', RD.makeShift([null, null], Float32Array.from([NaN, NaN]), 2, 1, Wd, Hg).at(5, 5) === 0 && RD.constShift(-24.5).at(1, 2) === -24.5);
ok('the lattice read skips unknown nodes', near(RD.lattice([1, NaN, 3, 5], 2, 2, 10, 10, 5, 5), 3) && isNaN(RD.lattice([NaN, NaN, NaN, NaN], 2, 2, 10, 10, 5, 5)));

// ── buffers ──
const ident = (x, y, z, o, k) => { o[k] = x; o[k + 1] = y; o[k + 2] = z; }, up2 = RD.constShift(2), ramp = d => FR.rampColour(d);
const FT = 0.3048;
const H = { nv: 4, nt: 2, xyz: Float32Array.from([10, 20, 500, 11, 20, 497, 12, 21, 494, 12, 22, 480]), depth: Float32Array.from([0, 10 * FT, 20 * FT, 40 * FT]), tri: Uint32Array.from([0, 1, 2, 1, 2, 3]) };
const B = RD.buildShapes(H, ident, up2, ramp);
const rgb = (a, i) => [a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]].join();
ok('shapes: one vertex each, moved by the shift, 3 floats + 4 colour bytes', B.n === 4 && B.pos.length === 12 && B.col.length === 16 && B.pos[2] === 502 && B.pos[11] === 482 && B.pos[0] === 10);
ok('…in the phone\'s depth colours: yellow at the surface, orange at 10 ft, red at 20 ft, blue at 30 ft and deeper', rgb(B.col, 0) === '255,232,92,255' && rgb(B.col, 1) === '255,154,46,255' && rgb(B.col, 2) === '232,50,42,255' && rgb(B.col, 3) === '74,44,255,255', [rgb(B.col, 0), rgb(B.col, 1), rgb(B.col, 2), rgb(B.col, 3)]);
const P = { n: 7, xyz: Float32Array.from([1, 1, 100, 2, 2, 100, 3, 3, 100, 4, 4, 100, 5, 5, 100, 6, 6, 100, 7, 7, 100]), depth: Float32Array.from([0, 3, 20 * FT, 1, 1, 9, 5]), kind: Uint8Array.from([3, 1, 0, 2, 0, 9, 1]) };
const Dd = RD.buildDots(P, ident, up2, ramp);
ok('returns: sorted by kind, each kind one range (2 grouped, 2 lone, 1 likely noise, 1 patterned; an unknown kind is left out)', JSON.stringify(Dd.ranges) === '[[0,2],[2,2],[4,1],[5,1]]' && Dd.n === 6 && Array.from(Dd.order).join() === '2,4,1,6,3,0', [Dd.ranges, Array.from(Dd.order)]);
ok('…grouped by depth (20 ft: red), lone white, likely noise pink, patterned noise light blue; places moved by the shift', rgb(Dd.col, 0) === '232,50,42,255' && rgb(Dd.col, 2) === '255,255,255,255' && rgb(Dd.col, 4) === '255,77,210,255' && rgb(Dd.col, 5) === '127,212,255,255' && Dd.pos[0] === 3 && Dd.pos[2] === 102);
const Pt = RD.buildPatches(Q, ident, RD.constShift(0));
ok('openings: a square a cell (two triangles), true entrances first', Pt.n === 18 && Pt.pos.length === 54 && JSON.stringify(Pt.ranges) === '{"true":[0,12],"guessed":[12,6]}' && near(Pt.pos[0], 10.0) && near(Pt.pos[1], 20.0) && near(Pt.pos[3], 10.3) && near(Pt.pos[2], 500 + RD.PATCH_LIFT, 1e-3));
const rgba = (a, v) => [a[v * 4], a[v * 4 + 1], a[v * 4 + 2], a[v * 4 + 3]].join();
ok('…a true entrance is black, a guessed opening the dark grey #141312 at 0.72', rgba(Pt.col, 0) === '0,0,0,235' && rgba(Pt.col, 11) === '0,0,0,235' && rgba(Pt.col, 12) === '20,19,18,184' && rgba(Pt.col, 17) === '20,19,18,184');

// ── "nothing": greyed, and left out when hidden ──
const feats = RM.cleanFeatures([{ id: 'a', x: 11, y: 20, z: 500, n: 9, deepest: 6, box: [9.5, 19.5, 493, 12.5, 21.5, 500.5], entrance: 'true', lon: -100.5678, lat: 45.1234 }, { id: 'b', x: 12, y: 22, z: 481, n: 4, deepest: 12, box: [11.5, 21.6, 479, 12.5, 22.5, 481], entrance: 'none', lon: -100.5677, lat: 45.1235 }]);
const M = RM.match([{ id: 'm1', kind: 'nothing', lon: -100.5678, lat: 45.1234, updated: { t: '' } }], feats);
const boxes = RM.nothingBoxes(feats, M), flag = FR.insideBoxes(H.xyz, boxes);
ok('the feature marked "nothing" gives one box; three of the four shape vertices lie in it', boxes.length === 1 && Array.from(flag).join('') === '1110', [boxes, Array.from(flag)]);
const dm = RD.dimColours(B.col, flag);
ok('greyed: those vertices are grey, the other keeps its depth colour; the colours as made are untouched', dm.dimmed === 3 && rgb(dm.col, 0) === RD.DIM_RGB.join() + ',255' && rgb(dm.col, 3) === '74,44,255,255' && rgb(B.col, 0) === '255,232,92,255');
ok('hidden: only triangles wholly inside are left out (1 of 2)', Array.from(RD.keptIndex(H.tri, flag)).join() === '1,2,3' && RD.keptIndex(H.tri, new Uint8Array(4)).length === 6);
ok('no "nothing": nothing greyed', RD.dimColours(B.col, FR.insideBoxes(H.xyz, [])).dimmed === 0);

// ── a tap: the phone's rule serves the desktop too ──
ok('a click within 28 px of a feature\'s anchor, middle or deepest point is on it; away from all, on none', RM.nearestTap(105, 98, [{ pts: [[100, 100], null, null], rect: null }, { pts: [[400, 300], [400, 330], [400, 360]], rect: null }]).i === 0 &&
  RM.nearestTap(410, 352, [{ pts: [[100, 100], null, null], rect: null }, { pts: [[400, 300], [400, 330], [400, 360]], rect: null }]).i === 1 && RM.nearestTap(250, 200, [{ pts: [[100, 100], null, null], rect: null }]) === null);

// ── size: a million triangles are built quickly ──
{
  const nv = 600000, big = { nv, nt: 0, xyz: new Float32Array(nv * 3), depth: new Float32Array(nv), tri: new Uint32Array(0) };
  for (let i = 0; i < nv; i++) { big.xyz[i * 3] = (i * 7919) % 1000; big.xyz[i * 3 + 1] = (i * 104729) % 800; big.xyz[i * 3 + 2] = 500 - (i % 30); big.depth[i] = i % 30; }
  const t0 = Date.now(); const Bb = RD.buildShapes(big, place, RD.makeShift(g, shown, 2, 2, Wd, Hg), ramp); const ms = Date.now() - t0;
  ok('600,000 shape vertices (about a million triangles) are placed and coloured in well under two seconds (' + ms + ' ms)', ms < 2000 && Bb.pos.length === nv * 3, ms);
}
ok('the page loads the phone\'s two modules before the draw module, and the info panel knows a ridgewalking feature', (() => { const h = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), a = h.indexOf('viewer_build/libs/ridgewalk.js'), b = h.indexOf('viewer_build/libs/ridge-marks.js'), c = h.indexOf('client/src/modules/ridge-draw.js');
  return a > 0 && b > a && c > b && /isRidgeFeature/.test(fs.readFileSync(path.join(root, 'client/src/modules/info-panel.js'), 'utf8')); })());

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
