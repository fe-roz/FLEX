// veg-panel.js, the pure parts: number and size words, the count lines under a build, the Saved line, the /api/veg/build params.
// Run: node tools/test_veg_panel.js
'use strict';
const path = require('path');
const M = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'veg-panel.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + JSON.stringify(i) : '')); } };
ok('fmtN groups thousands with a space', M.fmtN(12340) === '12 340' && M.fmtN(210000) === '210 000' && M.fmtN(7) === '7' && M.fmtN(null) === '0');
ok('fmtBytes', M.fmtBytes(500000) === '0.5 MB' && M.fmtBytes(3100000) === '3.1 MB' && M.fmtBytes(12000) === '12 KB' && M.fmtBytes(96) === '96 B');
const veg = { shapes: { trees: 12340, brush: 5120 }, shell: { triangles: 210000 } }, sizes = { 'shapes.bin': 500000, 'shell.bin': 3100000 };
const l = M.countLines(veg, sizes);
ok('countLines: both looks', l.length === 2 && l[0] === 'Tree shapes: 12 340 trees, 5 120 brush patches, 0.5 MB' && l[1] === 'Canopy cloud: 210 000 triangles, 3.1 MB', l);
ok('countLines: one look, one tree', M.countLines({ shapes: { trees: 1, brush: 1 } }, {}).join() === 'Tree shapes: 1 tree, 1 brush patch, 0 B' && M.countLines({}, {}).length === 0);
ok('savedLine', M.savedLine({ veg: { shapes: { trees: 12340, brush: 5120, bytes: 500000 }, shell: { triangles: 210000, bytes: 3100000 } } }) === '12 340 trees, 5 120 brush, 0.5 MB; cloud 210 000 triangles, 3.1 MB');
const p = M.buildParams({ epts: ['http://a/ept.json', 'http://b/ept.json'], detail: 'weird', area: M.boxRing([-100.57, 45.12, -100.56, 45.13]) });
ok('buildParams: source, area, both looks, detail repaired, fixed numbers', p.source.ept === 'http://a/ept.json' && p.source.ept_also.join() === 'http://b/ept.json' && p.area.length === 4 && p.looks.join() === 'shapes,shell'
  && p.detail === 'medium' && p.min_height === 0.5 && p.brush_top === 2 && p.max_triangles === 300000, p);
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
