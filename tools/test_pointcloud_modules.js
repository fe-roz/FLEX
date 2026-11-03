// Tests of the pure parts of client/src/modules/{potree-pointcloud,pointcloud-incidence,pointcloud-hag}.js:
// cloud names from URLs, the incidence flight-line fit and colours, and the HAG
// ground grids (translation, anchoring, window, packing / sampling round trip).
// Made-up data only.
//
//   node tools/test_pointcloud_modules.js
'use strict';
const path = require('path');
const M = f => require(path.join(__dirname, '..', 'client', 'src', 'modules', f));
const PC = M('potree-pointcloud.js'), I = M('pointcloud-incidence.js'), H = M('pointcloud-hag.js');

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t;

// ── cloud names ──────────────────────────────────────────────────────────────
{
  ok('name from ept url', PC.pcNameFromUrl('http://localhost:8083/Cave Ridge/ept.json') === 'Cave Ridge');
  ok('name: trailing slash falls back to the url', PC.pcNameFromUrl('http://h/a/') === 'http://h/a/');
  ok('key: last non-empty segment', PC.pcUrlKey('http://h/a/Cave Ridge/ept.json?x=1') === 'Cave Ridge' && PC.pcUrlKey('http://h/a/Cave Ridge/') === 'Cave Ridge');
  ok('key: ept.json?query stripped', PC.pcUrlKey('http://h/Cave Ridge/ept.json') === 'Cave Ridge');
}

// ── incidence ────────────────────────────────────────────────────────────────
{
  ok('flightLineHue golden angle', I.flightLineHue(0) === 0 && near(I.flightLineHue(1), 0.618034) && near(I.flightLineHue(2), 0.236068));
  ok('angleHue nadir green, 30 deg red, clamped', near(I.angleHue(0), 0.33) && near(I.angleHue(30), 0) && near(I.angleHue(-60), 0) && near(I.angleHue(15), 0.165));
  // a flight line along +Y: nadir points on x = 100, y spread, increasing gps time with y
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ x: 100, y: i * 10, z: 5, scanAngle: 0, gpsTime: 1000 + i });
  const samples = new Map([[7, { nadirPts: pts, allPts: pts }], [8, { nadirPts: [], allPts: pts.slice(0, 2) }]]);
  const h = I.headingsFromSamples(samples);
  const a = h.get(7);
  ok('line along +Y', a && near(Math.abs(a.alongY), 1, 1e-6) && Math.abs(a.alongX) < 1e-6 && a.alongY > 0, a);
  ok('across = 90 deg CCW of along', near(a.acrossX, -a.alongY) && near(a.acrossY, a.alongX));
  ok('path at flight altitude, extended 50 m', a.pathPts.length === 2 && a.pathPts[0].z === I.FLIGHT_ALT && near(a.pathPts[0].y, -50, 1e-6) && near(a.pathPts[1].y, 140, 1e-6), a.pathPts);
  ok('too few points: no heading', !h.has(8));
  // reversed gps time flips the direction
  const rev = pts.map((p, i) => ({ ...p, gpsTime: 2000 - i }));
  ok('gps time orients it', I.headingsFromSamples(new Map([[1, { nadirPts: rev, allPts: rev }]])).get(1).alongY < 0);
}

// ── HAG grids ────────────────────────────────────────────────────────────────
{
  const mk = (d, l) => { const x = H.hagMakeGrid(d, l); x.texture = { version: 1 }; return x; };
  const g = mk(8, 'test');
  ok('make: arrays sized and empty', g.ground.length === 64 && g.upload.length === 256 && g.ground[0] === Math.fround(H.HAG_NONE) && g.groundMax[0] === Math.fround(-H.HAG_NONE));
  ok('fallback cell clamps 4..32 m', H.hagFallbackCell(0.25) === 4 && H.hagFallbackCell(1) === 16 && H.hagFallbackCell(10) === 32);

  H.hagAnchor(g, 2, 1000.3, 2000.7);
  ok('anchor snaps to the lattice, centred', g.originX % 2 === 0 && g.originY % 2 === 0 && near(g.originX + 8, 1000, 2) && g.cell === 2);
  const e = H.hagExtent(g);
  ok('extent', e.maxX - e.minX === 16 && near(e.cx, g.originX + 8));

  // translate: data at (x,y) moves to (x-dx, y-dy); exposed margin is empty
  const arr = new Float32Array(16); for (let i = 0; i < 16; i++) arr[i] = i + 1;
  const t1 = arr.slice(); H.hagTranslate(t1, 4, 1, 1, 0, 0);
  ok('translate dx=1', t1[0] === 2 && t1[1] === 3 && t1[2] === 4 && t1[3] === 0 && t1[4] === 6, Array.from(t1));
  const t2 = arr.slice(); H.hagTranslate(t2, 4, 1, 0, -1, 0);
  ok('translate dy=-1', t2[0] === 0 && t2[4] === 1 && t2[15] === 12, Array.from(t2));
  const t3 = arr.slice(); H.hagTranslate(t3, 4, 1, 4, 0, -9);
  ok('translate past the window clears all', t3.every(v => v === -9));
  const t4 = new Uint8Array(32).fill(7); H.hagTranslate(t4, 4, 2, 1, 1, 0);
  ok('translate stride 2: surviving cells keep both bytes', t4[0] === 7 && t4[1] === 7 && t4[6] === 0 && t4[24] === 0);

  // shift keeps data in range
  const s = mk(8, 's'); H.hagAnchor(s, 1, 4, 4);
  const ix = 4 + 1 - s.originX; // a cell 1 m right of centre
  const k = 4 * 8 + ix; s.ground[k] = 10; s.groundMax[k] = 12; s.upload[k * 4 + 3] = 255;
  const ox = s.originX;
  ok('shift by whole cells', H.hagShift(s, 4 + 2, 4) === true && s.originX === ox + 2);
  ok('data travelled with the shift', s.ground[k - 2] === 10 && s.groundMax[k - 2] === 12 && s.ground[k] === Math.fround(H.HAG_NONE));
  ok('recount after shift', s.groundCells === 1 && s.filled === 1, [s.groundCells, s.filled]);
  ok('no shift when already there', H.hagShift(s, 4 + 2, 4) === false);

  // exposed
  const A = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
  ok('exposed: disjoint -> whole', H.hagExposed(A, { minX: 20, maxX: 30, minY: 0, maxY: 10 }).length === 1);
  const ex = H.hagExposed(A, { minX: 2, maxX: 12, minY: 3, maxY: 13 });
  ok('exposed: an L of two rectangles', ex.length === 2, ex);
  ok('overlaps', H.hagOverlaps({ minX: 0, maxX: 5, minY: 0, maxY: 5 }, A) && !H.hagOverlaps({ minX: 10, maxX: 12, minY: 0, maxY: 5 }, A));

  // window + pack / read round trip
  const w0 = H.hagWindow(100, 500);
  ok('window padded 25 %, zInv matches', near(w0.zMin, 0) && near(w0.zSpan, 600) && near(w0.zInv, 65535 / 600), w0);
  const w = H.hagWindow(100, 300);
  ok('window min span 100', H.hagWindow(10, 10).zSpan === 100 && H.hagWindow(10, 10).zMin === -40);

  const p = mk(4, 'p'); H.hagAnchor(p, 1, 0, 0);
  const c0 = 1 * 4 + 1;
  p.ground[c0] = 120.5; p.groundMax[c0] = 150.5;       // a ground band
  const c1 = 2 * 4 + 3; p.fallback[c1] = 130.25;       // an estimate only
  H.hagRepackGrid(p, w.zMin, w.zSpan);
  ok('repack counts', p.filled === 2 && p.groundCells === 1, [p.filled, p.groundCells]);
  ok('provenance bytes', p.upload[c0 * 4 + 3] === 255 && p.upload[c1 * 4 + 3] === 128 && p.upload[0 + 3] === 0);
  const wx = p.originX + 1.5, wy = p.originY + 1.5;
  const r0 = H.hagReadCell(p, w.zMin, w.zSpan, wx, wy);
  ok('read: ground low within a cm', r0 && r0.ground && near(r0.z, 120.5, 0.01), r0);
  ok('read: band top within a spread step', near(r0.hi, 150.5, H.HAG_SPREAD_MAX / 255 + 0.01), r0);
  const r1 = H.hagReadCell(p, w.zMin, w.zSpan, p.originX + 3.5, p.originY + 2.5);
  ok('read: estimate is not ground, no band', r1 && !r1.ground && near(r1.z, 130.25, 0.01) && near(r1.hi, r1.z), r1);
  ok('read: empty cell and outside are null', H.hagReadCell(p, w.zMin, w.zSpan, p.originX + 0.5, p.originY + 0.5) === null && H.hagReadCell(p, w.zMin, w.zSpan, p.originX - 1, 0) === null);
  // a height never packs to 0 (reserved for "never uploaded")
  const q = mk(2, 'q'); H.hagAnchor(q, 1, 0, 0); q.ground[0] = -1e6; q.groundMax[0] = -1e6;
  H.hagRepackGrid(q, w.zMin, w.zSpan);
  ok('height byte pair never 0', (q.upload[0] << 8 | q.upload[1]) === 1);

  ok('pct formatting', H.hagPct(50, 100) === '50' && H.hagPct(1, 1000) === '0.10' && H.hagPct(0, 10) === '0');
  ok('cover string', H.hagCover({ dim: 10, groundCells: 50, filled: 75 }) === '50% ground, 25% est');
}

// ── point cloud look (pointcloud-options.js) ─────────────────────────────────
{
  const O = M('pointcloud-options.js');
  const D = O.PC_OPTION_DEFAULTS;
  ok('options: defaults match addPC', D.colour === 'composite' && D.size === 0.29 && D.sizeType === 2 && D.shape === 1 && D.gamma === 3.02 && D.iMin === 0 && D.iMax === 65536);
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'client', 'src', 'modules', 'potree-pointcloud.js'), 'utf8');
  ok('options: addPC still sets those defaults', /material\.size = 0\.29;/.test(src) && /intensityGamma = 3\.02;/.test(src) && /ADAPTIVE;/.test(src) && /PointShape\.CIRCLE;/.test(src));
  ok('options: sanitize drops junk', JSON.stringify(O.sanitizeOptions({ colour: 'x', size: 'a', shape: 7, hidden: [2, 2, 'q', 300, 7] })) === '{"hidden":[2,7]}');
  ok('options: sanitize clamps', O.sanitizeOptions({ size: 99, gamma: -1 }).size === 10 && O.sanitizeOptions({ gamma: -1 }).gamma === 0.2);
  ok('options: bad intensity range dropped', O.sanitizeOptions({ iMin: 500, iMax: 100 }).iMin === undefined);
  const m = { activeAttributeName: 'composite', size: 0.29, pointSizeType: 2, shape: 1, intensityRange: [0, 65536], intensityGamma: 3.02,
    classification: { 2: { visible: true, color: [1, 1, 1, 1] }, 7: { visible: true, color: [1, 0, 1, 1] }, DEFAULT: { visible: true, color: [0, 0, 0, 1] } }, recomputed: 0, recomputeClassification() { this.recomputed++; } };
  const shared = m.classification;
  O.applyMaterialOptions(m, {});
  ok('options: nothing set = nothing touched', m.size === 0.29 && m.activeAttributeName === 'composite' && m.classification === shared && !m.recomputed);
  O.applyMaterialOptions(m, { colour: 'returns', size: 1.5, sizeType: 0, shape: 2, iMin: 100, gamma: 1.2, hidden: [18, 2] });
  ok('options: values applied', m.activeAttributeName === 'return number' && m.size === 1.5 && m.pointSizeType === 0 && m.shape === 2 && m.intensityRange[0] === 100 && m.intensityRange[1] === 65536 && m.intensityGamma === 1.2);
  ok('options: classes hidden on a copy, 18 gets its own entry', m.classification[2].visible === false && m.classification[18].visible === false && m.classification[7].visible === true && shared[2].visible === true && !shared[18] && m.recomputed === 1);
  O.applyMaterialOptions(m, { hidden: [] });
  ok('options: all classes back', m.classification[2].visible && m.classification[18].visible);
  const v = { e: null, setEDLEnabled(x) { this.e = x; }, setEDLStrength(x) { this.s = x; }, setEDLRadius(x) { this.r = x; } };
  O.applyViewerOptions(v, { edlOn: false, edlStrength: 1 });
  ok('options: EDL applied only for keys given', v.e === false && v.s === 1 && v.r === undefined);
}

// ── USGS Ref Fix, automatic (made-up projections) ────────────────────────────
{
  const U = M('usgs-auto.js');
  const utm = '+proj=utm +zone=12 +datum=NAD83 +units=m +no_defs';
  const utmNavd = 'COMPD_CS["NAD83 / UTM zone 12N + NAVD88 height",PROJCS["NAD83 / UTM zone 12N",PROJECTION["Transverse_Mercator"]],VERT_CS["NAVD88 height"]]';
  const merc = 'PROJCS["WGS 84 / Pseudo-Mercator",AUTHORITY["EPSG","3857"]]';
  ok('class: none and 3857 are on', U.classifyProjection(null) === 'on' && U.classifyProjection('EPSG:3857') === 'on' && U.classifyProjection(merc) === 'on');
  ok('class: UTM (no vertical datum) is off', U.classifyProjection(utm) === 'off' && U.classifyProjection('EPSG:32612') === 'off');
  ok('class: UTM + orthometric vertical datum is on', U.classifyProjection(utmNavd) === 'on');
  ok('class: geographic is on (unknown)', U.classifyProjection('+proj=longlat +datum=WGS84') === 'on');
  ok('choose: mixed is on, all off is off, none is no change', U.chooseUsgsRef(['on', 'off']) === true && U.chooseUsgsRef(['off', 'off']) === false && U.chooseUsgsRef([]) === null);
  const vm = { usgsRef: true, usgsRefAuto: true };
  const pc = k => ({ _usgsKind: k });
  U.applyAutoUsgsRef(vm, [pc('off')]);
  ok('auto: UTM cloud turns it off', vm.usgsRef === false);
  U.applyAutoUsgsRef(vm, [pc('off'), pc('on')]);
  ok('auto: mixed turns it on', vm.usgsRef === true);
  vm.usgsRefAuto = false; vm.usgsRef = false;
  U.applyAutoUsgsRef(vm, [pc('on')]);
  ok('manual choice is kept', vm.usgsRef === false);
  const saved = U.usgsRefToSave(vm);
  ok('save: manual flag stored', saved.usgsRef === false && saved.usgsRefManual === true);
  const vm2 = { usgsRef: true, usgsRefAuto: true };
  U.restoreUsgsRef(vm2, saved);
  ok('restore: manual kept', vm2.usgsRef === false && vm2.usgsRefAuto === false);
  const vm3 = { usgsRef: true, usgsRefAuto: true };
  U.restoreUsgsRef(vm3, { usgsRef: false });
  ok('restore: old session (false, no flag) is automatic and keeps the new default', vm3.usgsRefAuto === true && vm3.usgsRef === true);
  const seen = []; U.applyAutoUsgsRef({ usgsRef: true, usgsRefAuto: true }, [pc('off'), pc('on')], m => seen.push(m));
  ok('mixed logs a note', seen.length === 1);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
