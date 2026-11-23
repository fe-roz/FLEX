// Saved areas belong to the project (Process, stage 2): the rules in flexlib.js (the "Process areas" folder, an area's
// outline, new / made / out of date) and the link on the server (areas_api.js: `feature`, /api/areas/link, save and run
// taking it, the list). Made-up places only.
//   node tools/test_process_areas.js
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const FL = require('../viewer_build/libs/flexlib.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + JSON.stringify(i).slice(0, 700) : '')); } };
const LON = -100.5678, LAT = 45.1234;
const sq = (dx, dy, s) => [[LON + dx, LAT + dy], [LON + dx + s, LAT + dy], [LON + dx + s, LAT + dy + s], [LON + dx, LAT + dy + s]];

// ── flexlib: the project's process areas ─────────────────────────────────────
let t = 0, clock = Date.UTC(2026, 10, 1);
const E = (op, d) => { t++; return Object.assign({ id: 'd1.' + t, dev: 'd1', seq: t, t: new Date(clock += 1000).toISOString(), who: 'T', op }, d); };
const replay = entries => FL.replayProject(entries, 'p1');
let log = [E('project.set', { name: 'Cave Ridge' }), E('group.set', { group: 'gP', name: 'Process areas', kind: 'process' }), E('group.set', { group: 'gIn', name: 'North side', parent: 'gP' }), E('group.set', { group: 'gO', name: 'Other things' }),
  E('feature.set', { feature: 'a1', kind: 'area', name: 'Ridge north', coords: sq(0, 0, 0.002).map(p => [p[0], p[1], 0]), group: 'gP' }),
  E('feature.set', { feature: 'a2', kind: 'area', name: 'Sinks', coords: sq(0.01, 0, 0.001).map(p => [p[0], p[1], 0]), group: 'gIn' }),
  E('feature.set', { feature: 'x1', kind: 'area', name: 'A field (not for processing)', coords: sq(0.02, 0, 0.001).map(p => [p[0], p[1], 0]), group: 'gO' }),
  E('feature.set', { feature: 'x2', kind: 'line', name: 'A trail in the folder', coords: [[LON, LAT, 0], [LON + 0.001, LAT, 0]], group: 'gP' }),
  E('feature.set', { feature: 'a3', kind: 'area', name: 'Gone', coords: sq(0.03, 0, 0.001).map(p => [p[0], p[1], 0]), group: 'gP' }), E('feature.set', { feature: 'a3', removed: true })];
let S = replay(log);
ok('the folder is found by its kind, whatever it is called', FL.processGroup(S) && FL.processGroup(S).id === 'gP' && FL.PROCESS_GROUP_KIND === 'process' && FL.PROCESS_GROUP_NAME === 'Process areas');
ok('process areas: the areas in that folder and in folders inside it; not lines, not removed ones, not areas elsewhere', FL.processAreas(S).map(f => f.id).sort().join() === 'a1,a2', FL.processAreas(S).map(f => f.id));
S = replay(log.concat([E('group.set', { group: 'gP', name: 'Areas to process' })]));
ok('renaming the folder keeps it the process folder', FL.processGroup(S).name === 'Areas to process' && FL.processAreas(S).length === 2);
ok('a project with no such folder has none', FL.processGroup(replay([E('project.set', { name: 'x' })])) === null && FL.processAreas(replay([E('project.set', { name: 'x' })])).length === 0);
S = replay(log);
const f1 = FL.processAreas(S).find(f => f.id === 'a1'), ring = FL.areaRing(f1);
ok('an area\'s outline: closed, lon / lat to six decimals, heights dropped', ring.length === 5 && ring[0][0] === ring[4][0] && ring[0][1] === ring[4][1] && ring[0].length === 2 && ring[1][0] === +(LON + 0.002).toFixed(6), ring);
ok('an outline that was stored closed is not closed twice', FL.areaRing({ coords: ring.map(p => [p[0], p[1], 5]) }).length === 5 && FL.areaRing({ coords: [[1, 2], [3, 4]] }).length === 0);
const key = FL.areaRingKey(ring);
ok('the outline\'s key is the one the server stamps results with', key === ring.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';'));
ok('nothing made on this computer: new', FL.processAreaState(f1, null) === 'new' && FL.processAreaState(f1, { ring, results: {} }) === 'new');
ok('results made for this outline: made', FL.processAreaState(f1, { ring, results: { ground: { ringKey: key }, ridge: { ringKey: key }, veg: {} } }) === 'made');
const moved = FL.areaRing({ coords: sq(0.0001, 0, 0.002) });
ok('the outline was changed in the project since: out of date', FL.processAreaState(f1, { ring: moved, results: { ground: { ringKey: FL.areaRingKey(moved) } } }) === 'outofdate');
ok('one result still from an older outline: out of date', FL.processAreaState(f1, { ring, results: { ground: { ringKey: key }, ridge: { ringKey: 'older' } } }) === 'outofdate');
// the change travels: another device moves a corner, the merged project has the new outline
const log2 = log.concat([Object.assign(E('feature.set', { feature: 'a1', coords: sq(0.0002, 0, 0.002).map(p => [p[0], p[1], 0]) }), { dev: 'phone', id: 'phone.1', seq: 1 })]);
ok('a change of the outline made elsewhere arrives with the sync and makes the results here out of date', FL.processAreaState(FL.processAreas(replay(log2)).find(f => f.id === 'a1'), { ring, results: { ground: { ringKey: key } } }) === 'outofdate');
ok('a process area exports like any area (it can go to CalTopo with the project\'s other features)', FL.featuresGeoJSON(S).features.some(f => f.properties && /Ridge north/.test(JSON.stringify(f.properties)) && /Polygon/.test(f.geometry.type)), FL.featuresGeoJSON(S).features.map(f => f.geometry.type));

// ── the server: the link ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parea-'));
const api = require('../areas_api')({ python: 'python3', root: tmp, terrainGen: null });
const call = (method, p, body, query) => new Promise(res => { const req = { method, on(ev, f) { if (ev === 'data' && body) f(Buffer.from(JSON.stringify(body))); if (ev === 'end') setImmediate(f); return this; }, destroy() {} };
  api.handle(req, { writeHead(c) { this.code = c; }, end(s) { let j = null; try { j = JSON.parse(s); } catch (_) {} res(Object.assign({ code: this.code }, j)); } }, p, query || {}); });
(async () => {
  let r = await call('POST', 'save', { name: 'Ridge north', ring, project: 'p1', feature: 'a1' });
  ok('saving a project area keeps the project item\'s id with it', r.ok && r.area.feature === 'a1' && r.area.project === 'p1' && JSON.parse(fs.readFileSync(path.join(tmp, r.area.id, 'area.json'), 'utf8')).feature === 'a1', r);
  const idA = r.area.id;
  r = await call('POST', 'save', { name: 'x', ring, project: 'p1', feature: '../bad' });
  ok('a feature id with anything odd in it is refused', r.ok !== true && r.code === 400, r);
  r = await call('POST', 'save', { name: 'Old area', ring: FL.areaRing({ coords: sq(0.05, 0, 0.002) }) });
  const idOld = r.area.id;
  ok('an area saved without a project has no link (an "earlier area")', r.ok && !r.area.feature && r.area.project === '');
  r = await call('GET', '', null, { project: 'p1' });
  ok('the list for a project: its areas with their link, and the ones of no project', r.ok && r.areas.find(a => a.id === idA).feature === 'a1' && !!r.areas.find(a => a.id === idOld) && !r.areas.find(a => a.id === idOld).feature, r.areas && r.areas.map(a => [a.id, a.feature]));
  r = await call('POST', 'link', { id: idOld, project: 'p1', feature: 'a9', name: 'Old area, moved in' });
  ok('"Move into this project": the earlier area gets the project and the item\'s id, keeping its folder', r.ok && r.area.id === idOld && r.area.project === 'p1' && r.area.feature === 'a9' && r.area.name === 'Old area, moved in', r);
  r = await call('POST', 'link', { id: idOld, project: 'p1', feature: 'a1' });
  ok('an item that already has results on this computer cannot take a second area', r.code === 409 && /already has/.test(r.error), r);
  ok('link needs a project, a good feature id and an area that exists', (await call('POST', 'link', { id: idOld, project: '', feature: 'a9' })).code === 400 && (await call('POST', 'link', { id: idOld, project: 'p1', feature: 'a b' })).code === 400
     && (await call('POST', 'link', { id: 'nope99', project: 'p1', feature: 'a9' })).code === 404 && (await call('POST', 'link', { id: '../x', project: 'p1', feature: 'a9' })).code === 400);
  r = await call('POST', 'save', { id: idA, name: 'Ridge north', ring: moved, project: 'p1' });
  ok('saving again without naming the item keeps the link', r.ok && r.area.feature === 'a1');
  r = await call('POST', 'rename', { id: idA, name: 'Ridge north (renamed in the project)' });
  ok('a rename keeps the link', r.ok && r.area.feature === 'a1' && /renamed/.test(r.area.name));
  r = await call('GET', '', null, { project: 'p2' });
  ok('another project does not see this project\'s areas', r.ok && !r.areas.some(a => a.id === idA));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
