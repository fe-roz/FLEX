// Tests of client/src/modules/compass-plt.js: the PLT parser, the UTM inverse and
// placing a parsed survey (with a stand-in Cesium). Made-up survey (stations A1…,
// made-up numbers); UTM reference values from pyproj.
//
//   node tools/test_compass_plt.js
'use strict';
const path = require('path');
const { parsePLT, utmToLatLon, setupCompassPlt } = require(path.join(__dirname, '..', 'client', 'src', 'modules', 'compass-plt.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const near = (a, b, t) => Math.abs(a - b) <= t;
const FT = 0.3048;

const PLT = [
  'Z 0 0 0 0 0 0', 'SCAVE RIDGE', 'O WGS 1984', 'G14',
  'NA D 7 15 94 C main line',
  'M 0 0 0 SA1 P 1 2 3 4 I 0',
  'D 30 0 0 SA2 P 1 1 1 1 I 30 "a comment, with comma"',
  'd 60 0 -5 SA3 P 1 1 1 1 I 60.2',
  'D 90 10 -8 SA4 FL',
  'NB D 8 1 1995 C side',
  'M 60 0 -5 SA3',            // ties back in at A3: listed once
  'D 60 30 -6',
  'SB1',                      // standalone station name, LRUD and distance lines
  'P 2 2 2 2',
  'I 31',
  'NS D 8 2 1995 C surface',
  'M 100 100 10 SS1 FS',
  'D 110 100 12 SS2 FS',
  'NBM D 8 3 1995 C benchmark',
  'D 5 5 5 SBM1',             // a survey with no shots: a surface benchmark
  'PBM1 100.0 200.0 30.0',    // fixed station
  ';LEAD\tSB1\t{"d":"tight crawl","done":false}',
  ';LEAD\tSB1\tnot json',
  'X 0 0 0 0 0 0',
].join('\r\n');

// ── parsePLT ─────────────────────────────────────────────────────────────────
(function parser() {
  const P = parsePLT(PLT);
  ok('zone and hemisphere', P.utmZone === 14 && P.utmSouth === false, [P.utmZone, P.utmSouth]);
  ok('datum', P.datum === 'WGS 1984', P.datum);
  ok('surveys in order, with descriptions and dates', JSON.stringify(P.surveys) === JSON.stringify([
    { code: 'A', desc: 'main line', date: '1994-07-15' }, { code: 'B', desc: 'side', date: '1995-08-01' },
    { code: 'S', desc: 'surface', date: '1995-08-02' }, { code: 'BM', desc: 'benchmark', date: '1995-08-03' }]), P.surveys);
  ok('three segments (a D with no M starts none)', P.segments.length === 3, P.segments.length);
  const [a, b, s] = P.segments;
  ok('segment A: four points, survey A', a.points.length === 4 && a.survey === 'A' && a.surveyDesc === 'main line', a);
  ok('feet to metres', near(a.points[1].n, 30 * FT, 1e-9) && a.points[1].e === 0 && near(a.points[2].v, -5 * FT, 1e-9), a.points[2]);
  ok('lowercase d is excluded', a.points[2].excluded === true && a.points[1].excluded === false, a.points.map(p => p.excluded));
  ok('quoted comment', a.points[1].comment === 'a comment, with comma' && a.points[0].comment === null, a.points[1].comment);
  ok('inline LRUD (l u d r)', near(a.points[0].lrud.l, 1 * FT, 1e-9) && near(a.points[0].lrud.u, 2 * FT, 1e-9) && near(a.points[0].lrud.d, 3 * FT, 1e-9) && near(a.points[0].lrud.r, 4 * FT, 1e-9), a.points[0].lrud);
  ok('inline distance', near(a.points[2].dist, 60.2 * FT, 1e-9), a.points[2].dist);
  ok('flags kept', a.points[3].flags === 'L' && !a.isSurface && !a.points[3].isSurface, a.points[3]);
  ok('standalone S / P / I lines', b.points[1].name === 'B1' && near(b.points[1].lrud.r, 2 * FT, 1e-9) && near(b.points[1].dist, 31 * FT, 1e-9), b.points[1]);
  ok('FS marks the segment and its points as surface', s.isSurface === true && s.points.every(p => p.isSurface), s);

  const names = P.stations.map(x => x.name);
  ok('stations, one per name and place', JSON.stringify(names) === JSON.stringify(['A1', 'A2', 'A3', 'A4', 'B1', 'S1', 'S2', 'BM1']), names);
  const st = n => P.stations.find(x => x.name === n);
  ok('a station keeps its survey and LRUD', st('A1').survey === 'A' && st('A1').surveyDesc === 'main line' && st('A1').lrud, st('A1'));
  ok('the repeated A3 stays in survey A', st('A3').survey === 'A', st('A3'));
  ok('surface stations', st('S1').isSurface && st('S2').isSurface && !st('A1').isSurface && !st('B1').isSurface, P.stations.map(x => [x.name, !!x.isSurface]));
  ok('a station in a survey with no shots is surface', st('BM1').isSurface === true, st('BM1'));
  ok('fixed station in metres', P.fixedStations.length === 1 && P.fixedStations[0].name === 'BM1' && near(P.fixedStations[0].n, 100 * FT, 1e-9) && near(P.fixedStations[0].e, 200 * FT, 1e-9) && near(P.fixedStations[0].v, 30 * FT, 1e-9), P.fixedStations);
  ok('FLEX lead lines (a bad one skipped)', P.leads.length === 1 && P.leads[0].station === 'SB1' && P.leads[0].d === 'tight crawl' && P.leads[0].done === false, P.leads);

  const south = parsePLT('G-56\nNA C x\nM 0 0 0 SA1\nD 10 0 0 SA2\n');
  ok('negative G is a southern zone', south.utmZone === 56 && south.utmSouth === true, [south.utmZone, south.utmSouth]);
  const none = parsePLT('');
  ok('empty file', none.segments.length === 0 && none.stations.length === 0 && none.utmZone === null && none.datum === null, none);
})();

// ── utmToLatLon ──────────────────────────────────────────────────────────────
(function utm() {
  const cases = [   // [easting, northing, zone, north, lat, lon] — pyproj, WGS84
    [376698.9451, 4997854.3019, 14, true, 45.1234, -100.5678],
    [332795.4917, 6291830.8610, 56, false, -33.5, 151.2],
    [605167.2185, 6680767.7702, 32, true, 60.25, 10.9],
  ];
  for (const [e, n, z, north, lat, lon] of cases) {
    const r = utmToLatLon(e, n, z, north);
    ok(`UTM ${z}${north ? 'N' : 'S'} -> ${lat}, ${lon}`, near(r.lat, lat, 1e-6) && near(r.lon, lon, 1e-6), r);
  }
  const eq = utmToLatLon(500000, 0, 14, true);
  ok('central meridian at the equator', near(eq.lat, 0, 1e-12) && near(eq.lon, -99, 1e-12), eq);
  const eqS = utmToLatLon(500000, 10000000, 56, false);
  ok('southern false northing', near(eqS.lat, 0, 1e-9) && near(eqS.lon, 153, 1e-12), eqS);
})();

// ── Survey codes that contain the letter C ──────────────────────────────────
(function codes() {
  const P = parsePLT(['NCR D 7 15 94 CMain passage', 'M 0 0 0 SA1', 'D 10 0 0 SA2',
    'NAC1 D 3 4 2001 Cwith C in it', 'M 0 0 0 SA2', 'D 10 0 0 SA3',
    'NC D 1 2 99 CEntrance', 'M 0 0 0 SA3', 'D 10 0 0 SA4',
    'NCR2 D 7 15 94', 'M 0 0 0 SA4', 'D 10 0 0 SA5',
    'NC D 1 2 99 C', 'M 0 0 0 SA5', 'D 10 0 0 SA6', 'X 0 0 0 0 0 0'].join('\r\n'));
  const s = P.surveys.map(x => x.code + '|' + x.desc + '|' + (x.date || ''));
  ok('code CR: description starts at the C marker', s[0] === 'CR|Main passage|1994-07-15', s);
  ok('code AC1: the description keeps a C of its own', s[1] === 'AC1|with C in it|2001-03-04', s);
  ok('code C alone', s[2] === 'C|Entrance|1999-01-02', s);
  ok('code with a C and no description: empty, not swallowed', s[3] === 'CR2||1994-07-15', s);
  ok('code C with an empty description', s[4] === 'C||1999-01-02', s);
})();

// ── setupCompassPlt (stand-in Cesium) ────────────────────────────────────────
(function placing() {
  const Cesium = { Cartesian3: { fromDegrees: (lon, lat, h) => ({ lon, lat, h }) } };
  let threw = false; try { setupCompassPlt({}); } catch (_) { threw = true; }
  ok('setup without Cesium throws', threw);
  const { pltToCartesian } = setupCompassPlt({ Cesium });
  const P = parsePLT(PLT);
  const r = pltToCartesian(P);
  ok('segments without excluded shots', r.segPositions.length === 3 && r.segPositions[0].length === 3, r.segPositions.map(a => a.length));
  ok('station positions', r.stationPositions.length === 8 && r.stationPositions[0].name === 'A1' && r.stationPositions[2].dist !== undefined, r.stationPositions.length);
  const a1 = r.stationPositions[0].pos, ll = utmToLatLon(0, 0, 14, true);
  ok('placed by the file\'s zone', near(a1.lat, ll.lat, 1e-12) && near(a1.lon, ll.lon, 1e-12) && a1.h === 0, a1);
  const o = pltToCartesian(P, 15, true).stationPositions[0].pos, llo = utmToLatLon(0, 0, 15, false);
  ok('zone and hemisphere overrides', near(o.lat, llo.lat, 1e-12) && near(o.lon, llo.lon, 1e-12), o);
  ok('no zone: null', pltToCartesian(parsePLT('NA C x\nM 0 0 0 SA1\nD 10 0 0 SA2\n')) === null);
})();

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
