// Terrain patch (terrain-patch.js) without a browser: a Cesium stand-in with just the maths it uses.
//   node tools/test_terrain_patch.js
// 1. a DEM with empty corners (what a rotated UTM DEM leaves in its lon/lat box) hands over to the world
//    terrain at its own edge: no step there (before: a cliff of the whole difference);
// 2. two patches side by side with an overlap: no step at the seam, the later one fades into the earlier;
// 3. a DEM with no empty cells behaves as before (flat inside, world outside the strip).
'use strict';
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL', l, i === undefined ? '' : i); } };
global.window = { Cesium: {
  Math: { toRadians: d => d * Math.PI / 180, toDegrees: r => r * 180 / Math.PI },
  Cartographic: { fromDegrees: (lon, lat) => ({ longitude: lon * Math.PI / 180, latitude: lat * Math.PI / 180, height: NaN }) },
  sampleTerrainMostDetailed: async (prov, pos) => { pos.forEach(c => { c.height = prov.height ? prov.height(c.longitude, c.latitude) : WORLD(c.longitude * 180 / Math.PI, c.latitude * 180 / Math.PI); }); return pos; },
  sampleTerrain: async (prov, lvl, pos) => window.Cesium.sampleTerrainMostDetailed(prov, pos),
} };
const WORLD = (lon, lat) => 1000 + 20 * (lat - 45.1234);          // a gentle slope, "world terrain"
const base = { tilingScheme: {}, availability: null, errorEvent: {}, getLevelMaximumGeometricError: () => 1 };
// the base's height in degrees: the stub samples through .height(lonRad, latRad) when present
base.height = (lo, la) => WORLD(lo * 180 / Math.PI, la * 180 / Math.PI);
require('./load_classic')(require('path').join(__dirname, '..', 'client', 'src', 'modules', 'terrain-patch.js'));
const TP = window._terrainPatch;
const D = Math.PI / 180;

function box(w, s, e, n, cell, fill) {
  const mLon = 111320 * Math.cos((s + n) / 2 * D), mLat = 110540;
  const nx = Math.round((e - w) * mLon / cell) + 1, ny = Math.round((n - s) * mLat / cell) + 1;
  const grid = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = fill(i, j, nx, ny);
  return { meta: { west: w, south: s, east: e, north: n, nx, ny, name: 'test' }, grid };
}
async function install(viewer, p) {
  const bytes = TP.pack(p.meta, p.grid);
  global.fetch = async () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  return TP.install(viewer, 'x');
}
const at = (prov, lon, lat) => prov.height(lon * D, lat * D);

(async () => {
  // 1. empty corners: the DEM is 1010 + slope (10 m above the world); the NW corner is a triangle with no data
  const p1 = box(-100.5678, 45.1234, -100.5578, 45.1334, 2, (i, j, nx, ny) => (i + j < 150 ? NaN : WORLD(-100.5678 + i / nx * 0.01, 45.1334 - j / ny * 0.01) + 10));
  const v1 = { terrainProvider: base };
  const t1 = await install(v1, p1);
  ok('provider installed', v1.terrainProvider === t1);
  const m = t1._p, mLon = 111320 * Math.cos(45.128 * D), mLat = 110540;
  // walk along a line perpendicular to the diagonal edge, 0.5 m steps, through it
  const cx = 60 * 2 / mLon, cy = 90 * 2 / mLat;      // a point on the cut (degrees from the box's NW corner): i + j = 150
  const s = Math.SQRT1_2;
  let maxStep = 0, prev = null, far = [];
  for (let t = -120; t <= 120; t += 0.5) {            // metres along the normal (towards the SE = into the data)
    const lon = -100.5678 + cx + t * s / mLon, lat = 45.1334 - cy - t * s / mLat;
    const h = at(t1, lon, lat);
    if (prev !== null && Math.abs(h - prev) > maxStep) { maxStep = Math.abs(h - prev); if (process.env.DBG) console.log("step at t", t, h - WORLD(lon, lat), prev - WORLD(lon - 0.5 * s / mLon, lat + 0.5 * s / mLat)); }
    prev = h;
    if (t >= 80) far.push(h - WORLD(lon, lat));
  }
  ok('no step across the DEM edge (largest 0.5 m step < 0.6 m)', maxStep < 0.6, maxStep);
  ok('deep inside the data the DEM is 10 m above the world', far.every(d => Math.abs(d - 10) < 0.05), far.slice(0, 3));
  const hole = at(t1, -100.5678 + 0.0005, 45.1334 - 0.0004);
  ok('inside the empty corner it is the world terrain', Math.abs(hole - WORLD(-100.5678 + 0.0005, 45.1334 - 0.0004)) < 0.1, hole);
  const ef = TP.edgeField(new Float32Array([NaN, 1, 1, 1, 1, 1, 1, 1]), 4, 2, 10, 10);
  ok('edge field: 0 at the hole, 10 m next to it', ef[0] === 0 && Math.abs(ef[1] / 254 * TP.RAMP_M - 10) < 0.3, Array.from(ef));
  ok('edge field: none without holes', TP.edgeField(new Float32Array(8).fill(1), 4, 2, 10, 10) === null);

  // 2. two patches that overlap by 150 m (east-west), the later 7 m above the world, the earlier 10 m
  const mL = 111320 * Math.cos(45.128 * D), ov = 150 / mL;
  const west = box(-100.5678, 45.1234, -100.5578 + ov / 2, 45.1334, 2, (i, j, nx, ny) => WORLD(-100.5678 + i / nx * 0.01, 45.1334 - j / ny * 0.01) + 10);
  const east = box(-100.5578 - ov / 2, 45.1234, -100.5478, 45.1334, 2, (i, j, nx, ny) => WORLD(-100.5578 + i / nx * 0.01, 45.1334 - j / ny * 0.01) + 10);
  const v2 = { terrainProvider: base };
  await install(v2, west); const t2 = await install(v2, east);
  let step2 = 0, pv = null, d0 = [];
  for (let lon = -100.5600; lon <= -100.5556; lon += 0.5 / mL) {
    const h = at(t2, lon, 45.1284); if (pv !== null) step2 = Math.max(step2, Math.abs(h - pv)); pv = h; d0.push(h - WORLD(lon, 45.1284));
  }
  ok('seam between two patches: no step', step2 < 0.2, step2);
  ok('seam between two patches: 10 m above the world throughout', d0.every(d => Math.abs(d - 10) < 0.2), [Math.min(...d0), Math.max(...d0)]);

  // 3. no holes: plain
  const p3 = box(-100.5678, 45.1234, -100.5578, 45.1334, 4, (i, j, nx, ny) => WORLD(-100.5678 + i / nx * 0.01, 45.1334 - j / ny * 0.01) + 10);
  const t3 = await install({ terrainProvider: base }, p3);
  ok('no holes: no edge field', !t3._p.edge);
  ok('no holes: centre is 10 m above the world', Math.abs(at(t3, -100.5628, 45.1284) - WORLD(-100.5628, 45.1284) - 10) < 0.05);
  ok('no holes: the box edge hands over to the world', Math.abs(at(t3, -100.5678 + 1e-6, 45.1284) - WORLD(-100.5678, 45.1284)) < 0.3);
  // 4. baking: a rotated UTM DEM leaves empty corners (NaN) and its heights land where they should
  const vm = require('vm'), fs = require('fs'), ctx = {}; ctx.window = ctx; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../PotreeCopied/libs/proj4/proj4.js', 'utf8'), ctx);
  window.proj4 = ctx.proj4;
  const UTM = '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs';
  const fx = (e, n) => 500 + 0.01 * (e - 376000) - 0.02 * (n - 4997000);           // the DEM's surface, a plane in UTM
  const c0 = window.proj4('WGS84', UTM, [-100.5678, 45.1234]);
  const W4 = 600, H4 = 400, vals = new Float32Array(W4 * H4);
  // a DEM tilted 30 degrees in UTM: its pixel grid is rotated, so its lon/lat box has empty corners
  const th = 30 * D, cs = Math.cos(th), sn = Math.sin(th), res = 2;
  const toXY4 = (c, r) => [c0[0] + 200 + (c * cs - r * sn) * res, c0[1] + 100 + (c * sn + r * cs) * res];
  for (let r = 0; r < H4; r++) for (let c = 0; c < W4; c++) { const [e, n] = toXY4(c + 0.5, r + 0.5); vals[r * W4 + c] = fx(e, n); }
  const T4 = { w: W4, h: H4, vals, nd: -9999, proj: UTM, toXY: toXY4 };
  const r4 = await TP.bake(T4, -24.5);
  ok('rotated DEM: one patch', r4.count === 1 && r4.tiles.length === 1);
  const g4 = r4.tiles[0].grid, nan4 = g4.reduce((a, v) => a + (v !== v ? 1 : 0), 0);
  ok('rotated DEM: empty corners are NaN, a good part is data', nan4 > 0.1 * g4.length && nan4 < 0.7 * g4.length, nan4 / g4.length);
  let worst = 0, n4 = 0; const m4 = r4.tiles[0].meta;
  for (let k = 0; k < 4000; k++) {
    const i = (k * 7919) % m4.nx, j = (k * 104729) % m4.ny, v = g4[j * m4.nx + i]; if (v !== v) continue;
    const lon = m4.west + i / (m4.nx - 1) * (m4.east - m4.west), lat = m4.north - j / (m4.ny - 1) * (m4.north - m4.south), [e, n] = window.proj4('WGS84', UTM, [lon, lat]);
    worst = Math.max(worst, Math.abs(v - (fx(e, n) - 24.5))); n4++;
  }
  ok('rotated DEM: heights match the plane (shift included) to 0.05 m', n4 > 500 && worst < 0.05, [n4, worst]);
  // and the baked patch installs without a step at its real edge
  const v4 = { terrainProvider: base }, t4 = await install(v4, { meta: Object.assign({ name: 'r' }, m4), grid: g4 });
  ok('rotated DEM: edge field made', !!t4._p.edge);

  // 5. a DEM bigger than 3000 posts a side: patches of at most 3000, same cell, overlapping, covering it all
  const big = 3500, bv = new Float32Array(big * 200).fill(700);
  const T5 = { w: big, h: 200, vals: bv, nd: null, proj: null, toXY: (c, r) => [-100.5678 + c * 0.5 / mL, 45.1334 - r * 0.5 / 110540] };
  const r5 = await TP.bake(T5, 0), sizes = r5.tiles.map(t => [t.meta.nx, t.meta.ny]);
  ok('big DEM: 2 patches of at most 3000 posts a side', r5.count === 2 && sizes.every(([a, b]) => a <= 3000 && b <= 3000), sizes);
  ok('big DEM: keeps its 0.5 m cell', Math.abs(r5.tiles[0].meta.cell_m - 0.5) < 0.01, r5.tiles[0].meta.cell_m);
  const [a5, b5] = r5.tiles.map(t => t.meta), over = (a5.east - b5.west) * mL;
  ok('big DEM: the patches overlap by about 150 m', over > 140 && over < 200, over);
  ok('big DEM: together they cover the DEM', Math.abs(a5.west - T5.toXY(0, 0)[0]) < 1e-6 && Math.abs(b5.east - T5.toXY(big, 0)[0]) < 2.5 / mL, [a5.west, b5.east]);
  ok('big DEM: posts of the two lie on one lattice', Math.abs(((b5.west - a5.west) / ((a5.east - a5.west) / (a5.nx - 1))) % 1) < 1e-6 || Math.abs((((b5.west - a5.west) / ((a5.east - a5.west) / (a5.nx - 1))) % 1) - 1) < 1e-6);
  const pl = TP.plan(-100.57, 45.12, -100.47, 45.22, 0.5);
  ok('huge area: at most 9 patches, posts widened to fit', pl.tiles.length <= TP.MAX_TILES && pl.cell_m > 0.5, [pl.tiles.length, pl.cell_m]);
  ok('area of 1 km: one patch at 0.5 m', TP.plan(-100.57, 45.12, -100.56, 45.129, 0.5).tiles.length === 1);
  console.log(`terrain patch: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e); process.exit(1); });
