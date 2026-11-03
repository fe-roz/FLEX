// The area picker's pure parts (client/src/modules/area-picker.js): polygon area, the margin, hull, crossing edges.
//   node tools/test_area_picker.js
'use strict';
const P = require('./load_classic')(require('path').join(__dirname, '..', 'client', 'src', 'modules', 'area-picker.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL', l, i === undefined ? '' : JSON.stringify(i)); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const mLat = 110540, mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);
const lat0 = 45.1234, lon0 = -100.5678;
// a 1 km x 2 km rectangle
const rect = (w, h) => [[lon0, lat0], [lon0 + w / mLon(lat0), lat0], [lon0 + w / mLon(lat0), lat0 + h / mLat], [lon0, lat0 + h / mLat]];

ok('1 km x 2 km = 2 km²', near(P.ringKm2(rect(1000, 2000)), 2, 0.01), P.ringKm2(rect(1000, 2000)));
ok('area is the same going the other way round', near(P.ringAreaM2(rect(500, 500)), P.ringAreaM2(rect(500, 500).reverse()), 1e-6));
ok('fewer than 3 points = 0', P.ringAreaM2([[0, 0], [1, 1]]) === 0 && P.ringAreaM2(null) === 0);
ok('bbox', JSON.stringify(P.bboxOf([[1, 5], [3, 2], [2, 9]])) === '[1,2,3,9]');

const hull = P.convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1], [1, 0.5]]);
ok('convex hull drops inside points', hull.length === 4, hull);

// the margin: footprint 2 points 300 m apart, grown by 200 m: 190 m out is in, 210 m out is not
const inside = (ring, lon, lat) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c; } return c; };
const fp = [[lon0, lat0], [lon0 + 300 / mLon(lat0), lat0]];
const g = P.grow(fp, 200);
ok('grow: a ring of many points', g.length >= 8, g.length);
ok('grow: 190 m north of the footprint is in', inside(g, lon0, lat0 + 190 / mLat));
ok('grow: 210 m north of the footprint is out', !inside(g, lon0, lat0 + 210 / mLat));
ok('grow: 190 m east of the far end is in, 210 m out', inside(g, lon0 + (300 + 190) / mLon(lat0), lat0) && !inside(g, lon0 + (300 + 210) / mLon(lat0), lat0));
ok('grow 0 = the hull of the footprint', P.grow(fp.concat([[lon0 + 100 / mLon(lat0), lat0 + 100 / mLat]]), 0).length === 3);
ok('grow of nothing = nothing', P.grow([], 200).length === 0);
const area200 = P.ringKm2(g), area0 = P.ringKm2(P.grow([[lon0, lat0], [lon0 + 300 / mLon(lat0), lat0], [lon0 + 300 / mLon(lat0), lat0 + 300 / mLat], [lon0, lat0 + 300 / mLat]], 200));
ok('a 300 m square + 200 m margin ≈ (700 m)² minus the corners', area0 > 0.40 && area0 < 0.49, area0);

ok('a square does not cross itself', !P.selfCrossing(rect(100, 100)));
ok('a bow-tie crosses', P.selfCrossing([[0, 0], [1, 1], [1, 0], [0, 1]]));
ok('a triangle does not', !P.selfCrossing([[0, 0], [1, 0], [0, 1]]));
const a = P.areaOf(rect(1000, 1000).concat([rect(1000, 1000)[0]]), 'drawn');
ok('areaOf: closed ring is opened, label, bbox, km²', a.polygon.length === 4 && a.label === 'drawn' && near(a.km2, 1, 0.01) && !a.crossing && a.bbox.length === 4, a);
const b = P.areaOfBox([lon0, lat0, lon0 + 1000 / mLon(lat0), lat0 + 1000 / mLat]);
ok('areaOfBox: no polygon, 1 km²', b.polygon === null && near(b.km2, 1, 0.01) && b.label === 'box', b);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
