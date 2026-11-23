// test_map_update.js — what the "Make an update" card says (client/src/modules/map-update.js, pure half).
//   node tools/test_map_update.js
'use strict';
const path = require('path');
const M = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'map-update.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i) : '')); } };
const u = { same: false, mostly: false, add: ['ridge_marks.json'], replace: ['caves.json', 'ridge.json'], remove: [], package_bytes: 41000, full_bytes: 212 * 1048576, from: '2026-11-20T10:00:00Z', to: '2026-11-23T10:00:00Z', id: 'abcd1' };
let d = M.describe(u);
ok('an update: its size against the full map first', d.kind === 'update' && /^Update: 40 KB · the full map is 212 MB \(1 % of it\)$/.test(d.lines[0]), d.lines[0]);
ok('…what changed, by name, since which map', /^3 files changed since the map of 2026-11-20 \d\d:00: ridge_marks\.json, caves\.json, ridge\.json$/.test(d.lines[1]), d.lines[1]);
ok('…and that it is for FLEX Field, with no viewer.html', /For FLEX Field/.test(d.lines[2]) && /no viewer\.html/.test(d.lines[2]) && /keeps everything added on the phone/.test(d.lines[2]));
d = M.describe(Object.assign({}, u, { mostly: true, package_bytes: 190 * 1048576, replace: ['terrain.glb', 'tex_sat.jpg'], add: [], remove: ['features.json'] }));
ok('mostly changed: says a full map is as good, right under the sizes; removals named', d.kind === 'mostly' && /^Update: 190 MB · the full map is 212 MB \(90 % of it\)$/.test(d.lines[0]) && d.lines[1] === 'More than 80 % of the map changed: sending the full map is as good.' && /removed: features\.json$/.test(d.lines[2]), d.lines);
d = M.describe({ same: true, from: '2026-11-20T10:00:00Z' });
ok('nothing changed: says so and nothing else', d.kind === 'same' && d.lines.length === 1 && /^Nothing changed since the map of 2026-11-20 \d\d:00: no update is needed\.$/.test(d.lines[0]), d.lines);
d = M.describe({ error: 'no earlier map of this area to update from' });
ok('no update could be made: why, and that the full map is there', d.kind === 'error' && /^No update was made: no earlier map of this area to update from\. The full map is ready below\.$/.test(d.lines[0]));
ok('a plain map: no card', M.describe(null) === null);
d = M.describe(Object.assign({}, u, { replace: Array.from({ length: 12 }, (_, i) => 'docs_' + i + '.jpg') }));
ok('many files: the first eight and how many more', / and 5 more$/.test(d.lines[1]) && /^13 files/.test(d.lines[1]), d.lines[1]);
ok('the base in the list: its time, and whether it was sent to a phone', /^the map of 2026-11-20 \d\d:00 \(sent to a phone\)$/.test(M.baseLabel({ exported: '2026-11-20T10:00:00Z', sent: 5 })) && !/sent/.test(M.baseLabel({ exported: '2026-11-20T10:00:00Z', sent: 0 })));
ok('sizes: KB under a megabyte, one decimal under 10 MB', M.mb(41000) === '40 KB' && M.mb(3.24 * 1048576) === '3.2 MB' && M.mb(212 * 1048576) === '212 MB' && M.mb(10) === '1 KB');
console.log(`test_map_update: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
