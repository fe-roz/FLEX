// Tests of caltopo_match.js — which project surface features are already on
// the CalTopo map (same kind, same name, close). Synthetic places only.
//
//   node tools/test_caltopo_match.js
'use strict';
const path = require('path');
const M = require(path.join(__dirname, '..', 'caltopo_match.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };

// Metres → degrees around a made-up spot.
const LAT = 41.5, LON = -123.2, mLat = 1 / 111195, mLon = 1 / (111195 * Math.cos(LAT * Math.PI / 180));
const at = (e, n) => [LON + e * mLon, LAT + n * mLat];
const line = (e0, n0, len, step = 10) => { const o = []; for (let d = 0; d <= len; d += step) o.push(at(e0 + d, n0)); return o; };

// CalTopo side: plain shapes (the module reads Cesium entities the same way).
const ct = [
  { kind: 'point', name: 'Sink 1', coords: [at(0, 0)] },
  { kind: 'point', name: 'Far pit', coords: [at(500, 0)] },
  { kind: 'line', name: 'Trail', coords: line(0, 100, 400, 2) },              // dense, as CalTopo draws it
  { kind: 'area', name: 'Karst zone', coords: [at(0, 300), at(200, 300), at(200, 500), at(0, 500)] },
  { name: 'Folder' },                                                       // no geometry: never matches
];

// Points
ok('point: same name, 10 m away → match', M.matchFeature({ kind: 'point', name: 'Sink 1', coords: [at(6, 8)] }, ct) === ct[0]);
ok('point: name ignores case and spaces', M.matchFeature({ kind: 'point', name: '  sink   1 ', coords: [at(1, 1)] }, ct) === ct[0]);
ok('point: 20 m away → no match', M.matchFeature({ kind: 'point', name: 'Sink 1', coords: [at(20, 0)] }, ct) === null);
ok('point: other name at the same place → no match', M.matchFeature({ kind: 'point', name: 'Sink 2', coords: [at(0, 0)] }, ct) === null);
ok('kind must agree: a line named like a point', M.matchFeature({ kind: 'line', name: 'Sink 1', coords: [at(0, 0), at(5, 0)] }, ct) === null);
ok('a folder (no geometry) never matches', M.matchFeature({ kind: 'point', name: 'Folder', coords: [at(0, 0)] }, ct) === null);

// Lines: vertices near the CalTopo track
ok('line: sparser copy of the track, 5 m off → match', M.matchFeature({ kind: 'line', name: 'Trail', coords: line(0, 105, 400, 50) }, ct) === ct[2]);
ok('line: a piece of the track → match', M.matchFeature({ kind: 'line', name: 'trail', coords: line(100, 98, 100, 25) }, ct) === ct[2]);
ok('line: 30 m off → no match', M.matchFeature({ kind: 'line', name: 'Trail', coords: line(0, 130, 400, 50) }, ct) === null);
{
  // 3 of 10 vertices wander off (70 % near) → no; 1 of 10 (90 %) → yes.
  const v = line(0, 100, 360, 40); const bad = v.map((c, i) => (i < 3 ? at(i * 40, 160) : c)); const one = v.map((c, i) => (i === 0 ? at(0, 160) : c));
  ok('line: 70 % of vertices near → no match', M.matchFeature({ kind: 'line', name: 'Trail', coords: bad }, ct) === null);
  ok('line: 90 % of vertices near → match', M.matchFeature({ kind: 'line', name: 'Trail', coords: one }, ct) === ct[2]);
}
// Areas: against the ring (its closing side too)
ok('area: same ring, shifted 8 m → match', M.matchFeature({ kind: 'area', name: 'Karst zone', coords: [at(8, 300), at(208, 300), at(208, 500), at(8, 500)] }, ct) === ct[3]);
ok('area: vertex on the closing side counts', M.matchFeature({ kind: 'area', name: 'Karst zone', coords: [at(0, 300), at(0, 400), at(0, 500), at(200, 500), at(200, 300)] }, ct) === ct[3]);
ok('area: far away → no match', M.matchFeature({ kind: 'area', name: 'Karst zone', coords: [at(1000, 300), at(1200, 300), at(1200, 500)] }, ct) === null);

// Over a project state (FlexLib.liveFeatures: removed ones are left out)
const P = { features: {
  a: { id: 'a', kind: 'point', name: 'Sink 1', coords: [[...at(3, 3), 0]], group: '' },
  b: { id: 'b', kind: 'point', name: 'New pit', coords: [[...at(50, 50), 0]], group: '' },
  c: { id: 'c', kind: 'line', name: 'Trail', coords: line(0, 102, 400, 80), group: '' },
  d: { id: 'd', kind: 'area', name: 'Survey area', coords: [at(0, 0), at(10, 0), at(10, 10)], group: '' },
  e: { id: 'e', kind: 'point', name: 'Far pit', coords: [at(500, 0)], removed: true },
}, groups: {} };
const un = M.unmatched(P, ct).map(f => f.id).sort(), du = M.duplicates(P, ct);
ok('unmatched: the features CalTopo lacks (removed ones left out)', un.join() === 'b,d', un);
ok('duplicates: feature with its CalTopo entity', du.length === 2 && du.find(x => x.feature.id === 'a').entity === ct[0] && du.find(x => x.feature.id === 'c').entity === ct[2], du.map(x => x.feature.id));
ok('no CalTopo map: every feature unmatched, no duplicates', M.unmatched(P, null).length === 4 && M.duplicates(P, null).length === 0);
ok('a data source shape ({ ds: { entities: { values } } }) is read too', M.unmatched(P, { ds: { entities: { values: ct } } }).length === 2);
ok('countShapes: folders not counted', M.countShapes(ct) === 4);
// Long features stay cheap (vertices are sampled).
{
  const long = line(0, 100, 400, 0.05), t0 = Date.now();
  const hit = M.matchFeature({ kind: 'line', name: 'Trail', coords: long }, ct);
  ok('a long project line (8000 vertices) matches quickly', hit === ct[2] && Date.now() - t0 < 500, Date.now() - t0);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
