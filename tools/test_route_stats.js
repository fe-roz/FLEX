// Tests of route-stats.js (the maths behind a line's and a point's stats) and units.js.
// Synthetic places only.
//
//   node tools/test_route_stats.js
'use strict';
const path = require('path');
const load = require('./load_classic');
const RS = load(path.join(__dirname, '..', 'client', 'src', 'modules', 'route-stats.js'));
const UN = load(path.join(__dirname, '..', 'client', 'src', 'modules', 'units.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Metres east / north of a made-up spot.
const LAT = 45.1234, LON = -100.5678, mLat = 1 / 111195, mLon = 1 / (111195 * Math.cos(LAT * Math.PI / 180));
const at = (e, n) => [LON + e * mLon, LAT + n * mLat];

// ── Length and resampling ──
const line = [at(0, 0), at(300, 0), at(300, 400)];                 // 700 m, one corner
ok('length of an L-shaped line', near(RS.lengthOf(line), 700, 1), RS.lengthOf(line));
ok('length of nothing / one point', RS.lengthOf([]) === 0 && RS.lengthOf([at(0, 0)]) === 0);
ok('spacing: 5 m at least, length / 400 on long lines', RS.sampleSpacing(700) === 5 && near(RS.sampleSpacing(8000), 20, 1e-9));
const rs = RS.resample(line, 50);
const nS = Math.ceil(RS.lengthOf(line) / 50);
ok('resample: ends kept, equal steps', rs.samples.length === nS + 1 && rs.samples[0].d === 0 && near(rs.samples[nS].d, rs.length, 1e-6) && near(rs.samples[1].d - rs.samples[0].d, rs.length / nS, 1e-6) && rs.length / nS <= 50, rs.samples.length);
ok('resample: every sample is on the line, the last is the last vertex', rs.samples.every(s => RS.distToPolyline([s.lon, s.lat], line).d < 0.5) && near(rs.samples[nS].lon, line[2][0], 1e-9) && near(rs.samples[nS].lat, line[2][1], 1e-9));
ok('resample: one point and a line of no length', RS.resample([at(0, 0)], 5).samples.length === 1 && RS.resample([at(0, 0), at(0, 0)], 5).samples.length === 1 && RS.resample([], 5).samples.length === 0);
ok('resample: a step longer than the line still gives both ends', RS.resample([at(0, 0), at(3, 0)], 50).samples.length === 2);

// ── Profiles ──
const ds = [], hs = [];
for (let d = 0; d <= 400; d += 10) { ds.push(d); hs.push(d <= 100 ? 1000 + d * 0.1 : d <= 200 ? 1010 : d <= 300 ? 1010 - (d - 200) * 0.3 : 980 + (d - 300) * 0.05); }
const cd = RS.climbDescent(hs);
ok('climb and descent', near(cd.climb, 15, 1e-6) && near(cd.descent, 30, 1e-6), cd);
ok('highest and lowest', cd.max === 1010 && near(cd.min, 980, 1e-9), cd);
ok('smoothing keeps a ramp’s climb', near(RS.climbDescent([0, 10, 20, 30], { smooth: 1 }).climb, 30 - 5 - 0, 6));
const st = RS.steepest(ds, hs, 30);
ok('steepest stretch: the 30 % downhill, found between 200 and 300 m', st && near(st.grade, -0.3, 1e-9) && st.d0 >= 200 && st.d1 <= 300 && near(st.pct, -30, 1e-6) && near(st.deg, -16.7, 0.1), st);
ok('steepest on a ramp that is one window long', near(RS.steepest([0, 10, 20, 30], [0, 1, 2, 3], 30).grade, 0.1, 1e-9));
ok('steepest on a line shorter than the window uses all of it', near(RS.steepest([0, 10], [0, 5], 30).grade, 0.5, 1e-9));
ok('steepest of nothing', RS.steepest([0], [0], 30) === null && RS.steepest([], [], 30) === null);
ok('fillGaps: holes joined, ends extended, none → null', JSON.stringify(RS.fillGaps([null, 1, null, null, 4, null])) === JSON.stringify([1, 1, 2, 3, 4, 4]) && RS.fillGaps([null, NaN]) === null);

// ── Walking times ──
const flat = [0, 1000], flatH = [500, 500];
ok('Tobler: 1 km flat = 5.04 km/h → 714 s', near(RS.tobler(flat, flatH), 1000 / (6 * Math.exp(-0.175) / 3.6), 1e-6) && near(RS.tobler(flat, flatH), 714.7, 0.2), RS.tobler(flat, flatH));
const t5 = RS.tobler([0, 1000], [500, 500 + 50]);                    // 5 % uphill: |0.05 + 0.05| = 0.1 → 4.23 km/h along 1001 m
ok('Tobler: uphill is slower than flat, a gentle downhill is the fastest', t5 > RS.tobler(flat, flatH) && RS.tobler([0, 1000], [500, 450]) < RS.tobler(flat, flatH), t5);
ok('Tobler: the fastest slope is −5 %', near(RS.tobler([0, 1000], [500, 450]), Math.hypot(1000, 50) / (6 / 3.6), 1e-6));
ok('Naismith: 5 km flat = 1 h', near(RS.naismith(5000, 0), 3600, 1e-9));
ok('Naismith: 10 minutes per 100 m climbed', near(RS.naismith(5000, 300), 3600 + 1800, 1e-9) && near(RS.naismith(0, 100), 600, 1e-9));

// ── Times ──
const tr = [[0, 0, 0, Date.UTC(2026, 9, 3, 9, 0)], [0, 0, 0, Date.UTC(2026, 9, 3, 11, 15)]];
ok('recorded time from the 4th value (ms)', RS.recorded(RS.timesOf(tr)).seconds === 8100);
ok('…seconds since 1970 and ISO text too', RS.recorded(RS.timesOf([[0, 0, 0, 1790000000], [0, 0, 0, 1790003600]])).seconds === 3600 && RS.recorded(RS.timesOf([[0, 0], [0, 0]], ['2026-10-03T09:00:00Z', '2026-10-03T09:30:00Z'])).seconds === 1800);
ok('…none when fewer than two times', RS.timesOf([[0, 0, 5], [1, 1, 6]]) === null && RS.recorded(null) === null);

// ── Point to line ──
const tl = [at(0, 0), at(1000, 0)];                                 // two vertices 1 km apart
const d1 = RS.distToPolyline(at(500, 30), tl);
ok('distance to the line, not to its vertices (30 m off the middle)', near(d1.d, 30, 0.2) && near(d1.along, 500, 1), d1);
ok('…the nearest spot is on the line', near((d1.at[0] - LON) / mLon, 500, 1) && near((d1.at[1] - LAT) / mLat, 0, 0.2));
const d2 = RS.distToPolyline(at(-40, 30), tl);
ok('beyond the end: distance to the end vertex, along 0', near(d2.d, 50, 0.3) && d2.along === 0, d2);
ok('a one-point “line”', near(RS.distToPolyline(at(30, 40), [at(0, 0)]).d, 50, 0.3));
const pts = [{ name: 'Gate', at: at(100, 8) }, { name: 'Spring', at: at(600, -20) }, { name: 'Far', at: at(500, 200) }, { name: 'E1', at: at(950, 45) }];
const on10 = RS.pointsAlong(pts, tl, 10), on25 = RS.pointsAlong(pts, tl, 25), on50 = RS.pointsAlong(pts, tl, 50);
ok('points within 10 / 25 / 50 m of the line, in order along it', on10.map(x => x.pt.name).join() === 'Gate' && on25.map(x => x.pt.name).join() === 'Gate,Spring' && on50.map(x => x.pt.name).join() === 'Gate,Spring,E1', [on10, on25, on50].map(a => a.map(x => x.pt.name)));
ok('…with the distance along', near(on50[1].along, 600, 1) && near(on50[2].along, 950, 1));

// ── Nearest things ──
const origin = at(0, 0);
const many = [100, 300, 50, 700, 20].map((e, i) => ({ name: 'P' + i, at: at(e, 0) }));
const np = RS.nearestPoints(origin, many, 3, p => p.name === 'P4');
ok('nearest points: 3, nearest first, one left out', np.map(x => x.pt.name).join() === 'P2,P0,P1' && near(np[0].d, 50, 0.3) && near(np[0].brg, 90, 0.5), np.map(x => [x.pt.name, x.d]));
const nl = RS.nearestLines(origin, [{ name: 'North', coords: [at(-100, 60), at(100, 60)] }, { name: 'Near', coords: [at(-100, -15), at(100, -15)] }], 3);
ok('nearest line: distance to the line itself, direction to its nearest spot', nl[0].line.name === 'Near' && near(nl[0].d, 15, 0.2) && near(nl[0].brg, 180, 1) && near(nl[1].d, 60, 0.3), nl.map(x => [x.line.name, x.d, x.brg]));
ok('bearings and the words for them', near(RS.distBrg(at(0, 0), at(100, -100)).brg, 135, 0.3) && RS.compassText(128) === 'SE (128°)' && RS.compassText(359.6) === 'N (0°)' && RS.compassText(0) === 'N (0°)' && RS.compassText(270) === 'W (270°)');
const cn = RS.connections(at(0, 0), [{ name: 'Gate', at: at(12, 0) }, { name: 'Far', at: at(100, 0) }], [{ name: 'Trail', coords: [at(-50, 8), at(50, 8)] }, { name: 'Self', coords: [at(-50, 1), at(50, 1)] }], 30, l => l.name === 'Self');
ok('connections within 30 m: points and lines, nearest first, the line itself skipped', cn.map(c => c.item.name).join() === 'Trail,Gate' && cn[0].kind === 'line', cn.map(c => [c.item.name, c.d]));

// ── Units ──
let sys = 'metric';
const U = UN.make(() => sys);
ok('metric: lengths', U.len(850) === '850 m' && U.len(1234) === '1.23 km' && U.dist(9.44) === '9.4 m' && U.dist(120.4) === '120 m' && U.dist(2500) === '2.50 km');
ok('metric: heights, climb, area, durations', U.height(812.46) === '812.5 m' && U.climb(119.6) === '120 m' && U.area(250) === '250 m²' && U.area(2e4) === '2.00 ha' && U.duration(8100) === '2 h 15 min' && U.duration(2700) === '45 min' && U.duration(40) === '40 s' && U.duration(7200) === '2 h');
sys = 'imperial';
ok('imperial: feet below half a mile, miles above', U.len(100) === '328 ft' && U.len(5000) === '3.11 mi' && U.len(805) === '0.50 mi' && U.dist(120) === '394 ft' && U.dist(5) === '16.4 ft' && U.system() === 'imperial', [U.len(100), U.len(5000), U.dist(120), U.dist(5)]);
ok('imperial: heights and climb in feet', U.height(812.5) === '2665.7 ft' && U.climb(120) === '394 ft', [U.height(812.5), U.climb(120)]);
ok('imperial: area in ft², acres, mi²', U.area(100) === '1076 ft²' && U.area(10000) === '2.47 ac' && U.area(5e6) === '1.93 mi²', [U.area(100), U.area(10000), U.area(5e6)]);
ok('the long names are the same functions', U.fmtLen === U.len && U.fmtHeight === U.height && U.fmtClimb === U.climb && U.fmtDist === U.dist);
ok('nothing in, nothing out', U.len(NaN) === '' && U.height(undefined) === '' && U.duration(-1) === '');

console.log(`route-stats: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
