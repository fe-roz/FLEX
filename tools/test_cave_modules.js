// Tests of the pure parts of client/src/modules/cave-{passages,utm,depth,display}.js:
// LRUD blending, section frames, the passage tube / box builders, WGS84 → UTM, the
// LiDAR ground average, display options and the colour range. Made-up data only.
//
//   node tools/test_cave_modules.js
'use strict';
const path = require('path');
const M = f => require(path.join(__dirname, '..', 'client', 'src', 'modules', f));
const P = M('cave-passages.js'), U = M('cave-utm.js'), D = M('cave-depth.js'), X = M('cave-display.js');
const { utmToLatLon } = M('compass-plt.js');

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t;
const pt = (n, e, v, lrud, name) => ({ n, e, v, lrud, name });
const L4 = (l, r, u, d) => ({ l, r, u, d });

// ── LRUD blending ────────────────────────────────────────────────────────────
{
  ok('lrudValid', P.lrudValid(0) && P.lrudValid(2.5) && !P.lrudValid(-9.9) && !P.lrudValid(999) && !P.lrudValid(NaN));
  ok('placeholder 0/0/0/0', P.isLrudPlaceholder({ lrud: L4(0, 0, 0, 0) }) && !P.isLrudPlaceholder({ lrud: L4(0, 0, 0, 1) }) && !P.isLrudPlaceholder({}));
  ok('stationLrud null for placeholder/none', P.stationLrud({ lrud: L4(0, 0, 0, 0) }) === null && P.stationLrud({}) === null && P.stationLrud({ lrud: L4(1, 1, 1, 1) }) !== null);
  const pts = [pt(0, 0, 0, L4(1, 1, 1, 1)), pt(10, 0, 0, undefined), pt(20, 0, 0, L4(3, 3, 3, 3)), pt(30, 0, 0, L4(0, 0, 0, 0))];
  const out = P.segmentLruds(pts);
  ok('measured station as is', out[0].l === 1 && out[2].u === 3);
  ok('gap blended by station count', near(out[1].l, 2) && near(out[1].d, 2), out[1]);
  ok('placeholder is a plain 2 ft tube', out[3].l === P.PASSAGE_DEFAULT_LRUD && out[3].d === P.PASSAGE_DEFAULT_LRUD, out[3]);
  const none = P.segmentLruds([pt(0, 0, 0), pt(5, 0, 0)]);
  ok('never measured: 1 ft each side', none[0].r === P.PASSAGE_DEFAULT_LRUD && none[1].u === P.PASSAGE_DEFAULT_LRUD);
  const thin = P.segmentLruds([pt(0, 0, 0, L4(0, 0, 0, 0.001)), pt(5, 0, 0, L4(1, 1, 1, 1))]);
  ok('a zero wall is floored at 5 cm', near(thin[0].d, 0.05) && near(thin[1].d, 1), thin);
  ok('countLrudStations', P.countLrudStations({ segments: [{ points: pts }] }) === 2);

  // LRUD at To: each reading moves one shot along
  const parsed = { segments: [{ points: [pt(0, 0, 0, L4(1, 1, 1, 1), 'A1'), pt(5, 0, 0, L4(2, 2, 2, 2), 'A2'), pt(10, 0, 0, L4(3, 3, 3, 3), 'A3')] }] };
  const impTo = { parsed, displayOptions: { passageLrudAt: 'to' } }, impFrom = { parsed, displayOptions: {} };
  ok('lrudAtTo', P.lrudAtTo(impTo) && !P.lrudAtTo(impFrom) && !P.lrudAtTo(null));
  const P2 = parsed.segments[0].points;
  ok('effectiveLrud from = own', P.effectiveLrud(impFrom, P2[1], P2[0]) === P2[1].lrud);
  ok('effectiveLrud to = previous station reading', P.effectiveLrud(impTo, P2[1], P2[0]) === P2[0].lrud && P.effectiveLrud(impTo, P2[2], P2[1]) === P2[1].lrud);
  ok('first station of a survey has no reading at To', P.effectiveLrud(impTo, P2[0], undefined) === undefined);
  ok('stationEffectiveLrud', P.stationEffectiveLrud(impTo, { name: 'A3' }) === P2[1].lrud && P.stationEffectiveLrud(impFrom, P2[0]) === P2[0].lrud);
}

// ── Section frames ───────────────────────────────────────────────────────────
{
  const dot = (a, b) => a.e * b.e + a.n * b.n + a.v * b.v;
  const len = a => Math.sqrt(dot(a, a));
  const fv = P.frameVertical({ x: 1, y: 0 });
  ok('frameVertical: U up, L left of heading', fv.U.v === 1 && fv.L.n === 1 && fv.L.e === -0 && fv.F.e === 1, fv);
  const t = P.unit3(pt(0, 0, 0), pt(10, 10, 10));
  ok('unit3 unit length', near(len(t), 1) && P.unit3(pt(1, 1, 1), pt(1, 1, 1)) === null);
  const fs = P.frameShot(t, { x: 0, y: 1 });
  ok('frameShot orthonormal', near(len(fs.L), 1) && near(len(fs.U), 1) && near(dot(fs.L, fs.U), 0, 1e-9) && near(dot(fs.U, t), 0, 1e-9), fs);
  const fvert = P.frameShot({ e: 0, n: 0, v: 1 }, { x: 1, y: 0 });   // vertical shot falls back to the heading
  ok('frameShot on a vertical shot', near(len(fvert.L), 1) && near(len(fvert.U), 1) && near(dot(fvert.L, fvert.U), 0));
  const cf = (n, e, v) => ({ n, e, v });
  const w = P.framePoint(cf, { e: 0, n: 0, v: 0 }, fv, 2, 3, 4);   // 2 to the right of heading +e, 3 up, 4 ahead
  ok('framePoint', near(w.e, 4) && near(w.n, -2) && near(w.v, 3), w);
  ok('hdir', P.hdir({ e: 0, n: 0 }, { e: 3, n: 4 }).x === 0.6 && P.hdir({ e: 0, n: 0 }, { e: 0, n: 0 }) === null);
}

// ── Spline and tube / box builders ───────────────────────────────────────────
{
  const a = { e: 0, n: 0, v: 0 }, b = { e: 10, n: 0, v: 0 }, c = { e: 20, n: 5, v: 0 }, d = { e: 30, n: 5, v: 0 };
  const p0 = P.crPoint(a, b, c, d, 0), p1 = P.crPoint(a, b, c, d, 1), pm = P.crPoint(a, b, c, d, 0.5);
  ok('crPoint passes through its stations', near(p0.e, 10) && near(p1.e, 20) && near(p1.n, 5), [p0, p1]);
  ok('crPoint between', pm.e > 10 && pm.e < 20 && pm.n > 0 && pm.n < 5, pm);
  const l = P.lerpLrud(L4(0, 0, 0, 0), L4(2, 4, 6, 8), 0.5);
  ok('lerpLrud smoothstep mid = half', near(l.l, 1) && near(l.r, 2) && near(l.u, 3) && near(l.d, 4), l);
  const flat = (n, e, v) => ({ x: e, y: n, z: v });
  const mk = () => ({ pos: [], idx: [] });
  const sane = (g, label) => {
    const nv = g.pos.length / 3;
    ok(label + ': finite vertices', g.pos.every(Number.isFinite));
    ok(label + ': indices in range, whole triangles', g.idx.length % 3 === 0 && g.idx.every(i => Number.isInteger(i) && i >= 0 && i < nv));
  };
  // survey space: e east, n north, v up; builders read .e / .n / .v
  const P3 = [{ n: 0, e: 0, v: 0 }, { n: 10, e: 0, v: 0 }, { n: 20, e: 10, v: 2 }];
  const lr = P.segmentLruds(P3);
  const gb = mk(); P.buildBlocky(gb, P3, lr, flat, false);
  ok('blocky: 2 shots = 2 boxes of 24 vertices / 36 indices', gb.pos.length / 3 === 48 && gb.idx.length === 72, [gb.pos.length / 3, gb.idx.length]);
  sane(gb, 'blocky');
  const gp = mk(); P.buildBlocky(gp, P3, lr, flat, true);
  ok('blocky, perpendicular frames', gp.pos.length / 3 === 48); sane(gp, 'blocky perp');
  const gs = mk(); P.buildSmooth(gs, P3, lr, flat, false);
  ok('smooth tube has geometry', gs.pos.length > 0 && gs.idx.length > 0); sane(gs, 'smooth');
  const gs2 = mk(); P.buildSmooth(gs2, P3, lr, flat, true); sane(gs2, 'smooth perp');
  const again = mk(); P.buildSmooth(again, P3, lr, flat, false);
  ok('smooth is deterministic', JSON.stringify(again) === JSON.stringify(gs));
  // a vertical shot becomes a shaft in vertical-U mode
  const Pv = [{ n: 0, e: 0, v: 0 }, { n: 10, e: 0, v: 0 }, { n: 10, e: 0, v: -20 }];
  const lrv = P.segmentLruds(Pv);
  const gv = mk(); P.buildBlocky(gv, Pv, lrv, flat, false); sane(gv, 'blocky + shaft');
  ok('shaft spans the lower floor to the upper ceiling', Math.min(...gv.pos.filter((_, i) => i % 3 === 2)) <= -20 - 0.3 + 1e-9);
  const gvs = mk(); P.buildSmooth(gvs, Pv, lrv, flat, false); sane(gvs, 'smooth + shaft');
  // a convertFn that fails (no placement) leaves nothing half-built
  const gn = mk(); P.buildBlocky(gn, P3, lr, () => null, false);
  ok('convertFn null: nothing drawn', gn.pos.length === 0 && gn.idx.length === 0);
  // group by colour
  const groups = new Map(); P.passageGroup(groups, '#fff').pos.push(1); P.passageGroup(groups, '#fff');
  ok('passageGroup reuses a colour group', groups.size === 1 && groups.get('#fff').pos.length === 1);
}

// ── WGS84 → UTM ──────────────────────────────────────────────────────────────
{
  const lat = 45.1234, lon = -100.5678;
  const zone = Math.floor((lon + 180) / 6) + 1;
  const u = U.latLonToUtm(lat, lon, zone, true);
  const back = utmToLatLon(u.e, u.n, zone, true);
  ok('latLonToUtm round trip (north)', near(back.lat, lat, 1e-7) && near(back.lon, lon, 1e-7), [u, back]);
  const us = U.latLonToUtm(-33.4567, 151.2345, 56, false);
  const bs = utmToLatLon(us.e, us.n, 56, false);
  ok('latLonToUtm round trip (south)', near(bs.lat, -33.4567, 1e-7) && near(bs.lon, 151.2345, 1e-7), [us, bs]);
  const c = U.latLonToUtm(0, -99, 14, true);   // zone 14's central meridian
  ok('central meridian at 500000 E, equator at 0 N', near(c.e, 500000, 1e-6) && near(c.n, 0, 1e-6), c);
}

// ── Depth: elevation and LiDAR ground ────────────────────────────────────────
{
  const F = { at: (x, y, z) => ({ h: z }) };
  ok('caveElevAt undoes the datum shift', D.caveElevAt({ _heightDz: -24 }, F, 0, 0, 100) === 124 && D.caveElevAt({}, F, 0, 0, 100) === 100);
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];   // identity matrixWorld (column-major)
  const cloud = { zScale: 1, toScene: (lon, lat) => [lon, lat], nodes: [{
    pos: new Float32Array([0, 0, 10,  1, 0, 12,  0, 1, 50,  100, 100, 99]),
    cls: new Uint8Array([2, 2, 5, 2]), m: I }] };
  const g = D.lidarGroundAt([cloud], 0, 0, 3);
  ok('lidarGroundAt: mean of class-2 returns within r', g && g.n === 2 && near(g.h, 11), g);
  ok('lidarGroundAt: nothing near', D.lidarGroundAt([cloud], 500, 500, 3) === null && D.lidarGroundAt([], 0, 0) === null);
  const scaled = { ...cloud, zScale: 2 };
  ok('lidarGroundAt: undoes the z scale', near(D.lidarGroundAt([scaled], 0, 0, 3).h, 5.5));
}

// ── Display options and colour range ─────────────────────────────────────────
{
  const o = X.defaultDisplayOptions({ surveys: [{ code: 'A' }, { code: 'B' }] });
  ok('defaultDisplayOptions: a colour per survey, stations off', o.surveyColors.A === X.SURVEY_PALETTE[0] && o.surveyColors.B === X.SURVEY_PALETTE[1] && o.showStations === false && o.stationSize === 5, o);
  const o2 = X.defaultDisplayOptions({ surveys: [] });
  ok('defaultDisplayOptions: no surveys -> one default colour', o2.surveyColors[''] === '#00e5ff');
  const many = X.defaultDisplayOptions({ surveys: Array.from({ length: 20 }, (_, i) => ({ code: 'S' + i })) });
  ok('palette wraps', many.surveyColors.S15 === X.SURVEY_PALETTE[0]);
  ok('colour modes', X.CAVE_COLOUR_MODES.join() === 'survey,elev,depth,hard,review,segment');
  const pr = vals => vals.length ? { lo: Math.min(...vals), hi: Math.max(...vals) } : null;
  ok('fitColourRange: elevation as is', JSON.stringify(X.fitColourRange([5, 9], 'elev', pr)) === '{"lo":5,"hi":9}');
  ok('fitColourRange: depth starts at the surface', X.fitColourRange([-3, 40], 'depth', pr).lo === Math.min(0, 40 - 1) && X.fitColourRange([-3, 40], 'depth', pr).hi === 40);
  ok('fitColourRange: positive depth untouched, none -> null', X.fitColourRange([2, 40], 'depth', pr).lo === 2 && X.fitColourRange([], 'depth', pr) === null);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
