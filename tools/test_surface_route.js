// surface-route.js, the pure parts: trail/road detection from a name and folder, EPT urls kept in part by Potree made whole,
// the /api/route/plan params from the panel's state, order and words of the result cards. Run: node tools/test_surface_route.js
'use strict';
const path = require('path');
const M = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'surface-route.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + JSON.stringify(i) : '')); } };

ok('detect: trail, path, road in the name', M.detectKind('Cave Ridge Trail', '') === 'trail' && M.detectKind('old path', '') === 'trail' && M.detectKind('Ridge Rd', '') === 'road' && M.detectKind('Fire road 4', '') === 'road');
ok('detect: the folder says it when the name does not', M.detectKind('Line 3', 'Access/Trails') === 'trail' && M.detectKind('Line 3', 'Roads') === 'road');
ok('detect: a road in the name beats a trail folder', M.detectKind('Jeep road', 'Trails') === 'road');
ok('detect: plain names are nothing', M.detectKind('Survey line', 'Caves') === null && M.detectKind('Trailhead', '') === null && M.detectKind('', '') === null);

const O = 'http://localhost:8081';
ok('ept: a whole url stays', M.eptUrl('https://data.example.org/pc/ept.json') === 'https://data.example.org/pc/ept.json');
ok('ept: ept.json added when missing', M.eptUrl('https://data.example.org/pc/') === 'https://data.example.org/pc/ept.json' && M.eptUrl('https://data.example.org/pc') === 'https://data.example.org/pc/ept.json');
ok('ept: what Potree kept (no scheme) becomes https', M.eptUrl('data.example.org/pc/ept.json') === 'https://data.example.org/pc/ept.json' && M.eptUrl('bucket-us-west-2.example.com/some/area/ept.json') === 'https://bucket-us-west-2.example.com/some/area/ept.json');
ok('ept: localhost without a scheme is http', M.eptUrl('localhost:9000/x/ept.json') === 'http://localhost:9000/x/ept.json');
ok('ept: a path on this server gets the origin', M.eptUrl('/api/entwine/cave/ept.json', O) === O + '/api/entwine/cave/ept.json' && M.eptUrl('/api/entwine/cave', O) === O + '/api/entwine/cave/ept.json');
ok('ept: a protocol-relative url', M.eptUrl('//data.example.org/pc/ept.json') === 'https://data.example.org/pc/ept.json');
ok('ept: a query stays after ept.json', M.eptUrl('https://data.example.org/pc?token=a') === 'https://data.example.org/pc/ept.json?token=a');
ok('ept: nothing usable is empty', M.eptUrl('') === '' && M.eptUrl('relative/dir/ept.json') === '' && M.eptUrl('/x', '') === '' && M.eptUrl(null) === '');

const st = { epts: ['https://a.example.org/x/ept.json', 'https://b.example.org/y/ept.json'], end: { at: [-100.5678, 45.1234] }, starts: [{ at: [-100.57, 45.12, 9] }, { at: [-100.56, 45.125] }],
  cell: '0.5', dem: 'both', band: [0.4, 1.8], weights: { sun: -1, steep: 2 }, units: 'imperial', trails: [{ coords: [[-100.57, 45.12, 5], [-100.569, 45.121]], kind: 'road', name: 'Cave Ridge Rd' }, { coords: [[1, 2]], kind: 'trail' }] };
const p = M.buildParams(st);
ok('params: source is the first EPT, the others follow', p.source.ept === st.epts[0] && p.source.ept_also.length === 1);
ok('params: one source has no ept_also', !('ept_also' in M.buildParams(Object.assign({}, st, { epts: [st.epts[0]] })).source));
ok('params: end and starts are [lon, lat]', p.end.join() === '-100.5678,45.1234' && p.starts.length === 2 && p.starts[0].length === 2);
ok('params: cell, dem, band, units', p.cell === 0.5 && p.dem === 'both' && p.brush_band.join() === '0.4,1.8' && p.units === 'ft' && M.buildParams(Object.assign({}, st, { cell: 'auto' })).cell === 'auto');
ok('params: weights default where not given', p.weights.sun === -1 && p.weights.steep === 2 && p.weights.distance === 1 && p.weights.cliff === 0.5 && p.weights.trail === 1);
ok('params: trails as lon/lat lines with kind, short ones dropped', p.trails.features.length === 1 && p.trails.features[0].properties.kind === 'road' && p.trails.features[0].geometry.coordinates[0].length === 2);

const fc = { features: [{ geometry: { coordinates: [[1, 2], [3, 4]] }, properties: { option: 'shortest', id: 'a' } }, { geometry: { coordinates: [[1, 2], [3, 4]] }, properties: { option: 'recommended', id: 'b' } },
  { geometry: { coordinates: [[1, 2]] }, properties: { option: 'shadiest', id: 'c' } }, { geometry: { coordinates: [[1, 2], [3, 4]] }, properties: { option: 'least_brush', id: 'd' } }] };
ok('order: recommended first, the rest as given, one-point lines dropped', M.orderRoutes(fc).map(f => f.properties.id).join('') === 'bad');
const U = { len: m => Math.round(m) + ' m', climb: m => Math.round(m) + ' m', duration: s => Math.round(s / 60) + ' min' };
const L = M.statLines({ stats: { length_m: 1200, climb_m: 70, descent_m: 40, time_min: 25, max_grade_pct: 28.4, brush_pct: 20, sun_pct: 50, on_trail_pct: 10, cliff_cells: 2,
  time_breakdown: { walk_min: 14, climb_min: 6, descent_min: 1.5, brush_min: 3, trail_min: -0.5 } } }, U);
ok('stat lines: length, time, climb', L.top === '1200 m · ≈ 25 min · ↑ 70 m ↓ 40 m', L.top);
ok('stat lines: grade, brush, sun, trail', L.mid === 'steepest 28% · brush 20% · sun 50% · on trail 10%', L.mid);
ok('stat lines: the breakdown names each part', /walking 14 min · climbing 6 min/.test(L.breakdown) && /trail −/.test(L.breakdown) && L.cliffs === 2, L.breakdown);
ok('presets: the five, sliders for all seven weights', Object.keys(M.PRESETS).length === 5 && M.SLIDERS.length === 7 && Object.keys(M.WDEF).every(k => M.SLIDERS.some(s => s.k === k)));
ok('presets: Shadiest prefers shade, Shortest weighs distance most', M.PRESETS.shadiest.w.sun === -1 && M.PRESETS.shortest.w.distance > M.PRESETS.easiest.w.distance);
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
