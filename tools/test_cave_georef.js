// Tests the pure warp maths of client/src/modules/cave-georef.js (control points
// pulling a cave onto the map) and the pure helpers of cave-import.js. Synthetic data.
//
//   node tools/test_cave_georef.js
'use strict';
const path = require('path');
const mods = path.join(__dirname, '..', 'client', 'src', 'modules');
const { computeWarpedOffset: warp } = require(path.join(mods, 'cave-georef.js'));
const { georefLabel, escH, jsonCopy } = require(path.join(mods, 'cave-import.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const P = (e, n, v = 0) => ({ e, n, v });

{ // no control points: unchanged
  const r = warp(10, 20, 3, []);
  ok('0 points: identity', r.e === 10 && r.n === 20 && r.v === 3, r);
}
{ // one point: pure translation
  const r = warp(10, 20, 3, [{ src: P(0, 0, 0), dst: P(5, -2, 1) }]);
  ok('1 point: translate', r.e === 15 && r.n === 18 && r.v === 4, r);
}
{ // two points: a rotation by 90 degrees about the origin, scale 1
  const pairs = [{ src: P(0, 0), dst: P(0, 0) }, { src: P(10, 0), dst: P(0, 10) }];
  const r = warp(5, 0, 0, pairs);
  ok('2 points: rotate 90', near(r.e, 0) && near(r.n, 5), r);
  const r2 = warp(0, 5, 0, pairs);
  ok('2 points: rotate 90 (north axis)', near(r2.e, -5) && near(r2.n, 0), r2);
}
{ // two points: scale 2
  const pairs = [{ src: P(0, 0), dst: P(0, 0) }, { src: P(10, 0), dst: P(20, 0) }];
  const r = warp(5, 3, 0, pairs);
  ok('2 points: scale 2', near(r.e, 10) && near(r.n, 6), r);
}
{ // vertical: inverse-distance mix of the offsets; at a control point exactly its offset
  const pairs = [{ src: P(0, 0, 0), dst: P(0, 0, 4) }, { src: P(10, 0, 0), dst: P(10, 0, 8) }];
  const r = warp(0, 0, 1, pairs);
  ok('v at a control point = its offset', near(r.v, 5), r);
}
{ // three points, one off the rigid fit: the warp lands on each control point
  const pairs = [{ src: P(0, 0), dst: P(0, 0) }, { src: P(10, 0), dst: P(10, 0) }, { src: P(0, 10), dst: P(1, 12) }];
  pairs.forEach((p, i) => { const r = warp(p.src.e, p.src.n, 0, pairs); ok('3 points: control ' + i + ' lands on dst', near(r.e, p.dst.e, 1e-4) && near(r.n, p.dst.n, 1e-4), r); });
}
ok('georefLabel anchor', georefLabel({ mode: 'anchor', lat: 45.1234, lon: -100.5678 }) === '45.1234°, -100.5678°');
ok('georefLabel utm south', georefLabel({ mode: 'utm', zone: 14, south: true }) === 'UTM 14S');
ok('georefLabel none', georefLabel(null) === 'no georef stored');
ok('escH', escH('<a href="x">&\'') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
ok('jsonCopy is deep', (() => { const a = { x: { y: 1 } }; const b = jsonCopy(a); b.x.y = 2; return a.x.y === 1 && jsonCopy(null) === null; })());

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
