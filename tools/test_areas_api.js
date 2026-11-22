// areas_api.js: the processed-areas store, check (limits, offers, LiDAR coverage), run with stub scripts, status, files.
// Stub scripts are python3 files written to a temp folder; terrain is a fake generator. Made-up numbers around 45.1234, -100.5678.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 400) : '')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'areas-'));
const W = (n, s) => { const f = path.join(tmp, n); fs.writeFileSync(f, s); return f; };
const groundPy = W('ground.py', `
import argparse, json, os, sys
ap = argparse.ArgumentParser(); ap.add_argument('--params'); ap.add_argument('--area-dir'); a = ap.parse_args(); P = json.load(open(a.params))
open(os.path.join(os.path.dirname(a.area_dir), 'ground-count.txt'), 'a').write('x')
if 'failground' in P['source']['ept']: print('! no points'); sys.exit(1)
g = os.path.join(a.area_dir, 'ground'); os.makedirs(g)
open(g + '/ground.npy', 'wb').write(b'0123'); json.dump({'cell': 1.0}, open(g + '/grid.json', 'w')); json.dump({'coverage': 0.9, 'pits': 3, 'cell': 1.0}, open(g + '/summary.json', 'w'))
print('[1/1] ground'); print('NOTE: 3 possible pits')
`);
const vegPy = W('veg.py', `
import argparse, json, os, sys
ap = argparse.ArgumentParser(); ap.add_argument('--params'); ap.add_argument('--out'); ap.add_argument('--area-dir'); a = ap.parse_args(); P = json.load(open(a.params))
if 'failveg' in P['source']['ept']: print('! veg broke'); sys.exit(1)
open(a.out + '/shapes.bin', 'wb').write(b'12345678'); json.dump({'shapes': {'trees': 5, 'brush': 2}, 'shell': {'triangles': 10}, 'detail': P['detail'], 'ad': a.area_dir}, open(a.out + '/veg.json', 'w'))
print('NOTE: veg note')
`);
const prospectPy = W('prospect.py', `
import argparse, json, os, sys
ap = argparse.ArgumentParser(); ap.add_argument('--area-dir'); ap.add_argument('--out'); ap.add_argument('--params'); a = ap.parse_args(); P = json.load(open(a.params))
if not os.path.exists(a.area_dir + '/ground/grid.json'): print('! no ground'); sys.exit(1)
kn = len(json.load(open(P['known']))['features']) if P.get('known') else 0
json.dump({'type': 'FeatureCollection', 'features': []}, open(a.out + '/candidates.geojson', 'w'))
open(a.out + '/candidates.kml', 'w').write('<kml/>'); open(a.out + '/candidates.csv', 'w').write('id\\n'); open(a.out + '/depth.png', 'wb').write(b'png')
json.dump({'counts': {'A': 2, 'B': 3, 'C': 1}, 'isolated': {'B': 4, 'C': 1}, 'known': kn}, open(a.out + '/summary.json', 'w'))
print('NOTE: 6 candidates (2 sinks)')
`);
const lidarPy = W('lidar.py', `
import argparse, json, os
ap = argparse.ArgumentParser(); ap.add_argument('--ept'); ap.add_argument('--bbox', nargs=4); ap.add_argument('--out-dir'); ap.add_argument('--area-dir'); ap.add_argument('--cell'); a = ap.parse_args()
os.makedirs(a.out_dir, exist_ok=True); open(a.out_dir + '/x.png', 'wb').write(b'png'); json.dump({'cell': a.cell, 'ad': a.area_dir}, open(a.out_dir + '/derived.json', 'w'))
`);
const terrainCalls = [];
const fakeTerrain = { jobs: {}, handle(req, res, rest) {
  let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { const o = JSON.parse(b); terrainCalls.push(o);
    if (/failterrain/.test(o.ept[0])) { fakeTerrain.jobs.t1 = { status: 'error', error: 'terrain broke', progress: [] }; } else fakeTerrain.jobs.t1 = { status: 'done', progress: ['[1/4] x'], result: { layers: ['a'] } };
    res.end(JSON.stringify({ ok: true, jobId: 't1' })); }); } };
const root = path.join(tmp, 'areas');
const api = require('../areas_api')({ python: 'python3', groundScript: groundPy, vegScript: vegPy, prospectScript: prospectPy, lidarScript: lidarPy, root, terrainGen: fakeTerrain, pollMs: 20, fetchTimeoutMs: 2000 });

function call(method, url, data) {
  return new Promise(resolve => {
    const [p, q] = url.split('?'); const query = {}; (q || '').split('&').filter(Boolean).forEach(kv => { const [k, v] = kv.split('='); query[k] = decodeURIComponent(v); });
    const { Readable } = require('stream'); const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]); req.method = method;
    const chunks = []; const res = { code: 200, writeHead(c) { this.code = c; }, end(t) { if (t) chunks.push(Buffer.from(t)); resolve({ code: this.code, buf: Buffer.concat(chunks), get j() { try { return JSON.parse(this.buf.toString()); } catch (_) { return null; } } }); }, write(c) { chunks.push(Buffer.from(c)); },
      on() {}, once() {}, emit() {}, removeListener() {} };
    // file serving pipes: give the res a writable
    const { Writable } = require('stream'); const w = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
    const rs = Object.assign(w, { code: 200, writeHead(c, h) { this.code = c; this.h = h; }, setHeader() {} });
    const _end = w.end.bind(w); w.end = function (t) { if (t) chunks.push(Buffer.from(t)); _end(); };
    w.on('finish', () => resolve({ code: rs.code, h: rs.h, buf: Buffer.concat(chunks), get j() { try { return JSON.parse(this.buf.toString()); } catch (_) { return null; } } }));
    const rest = p.replace(/^\/api\/areas\/?/, '');
    api.handle(req, rs, rest, query);
  });
}
const post = (r, d) => call('POST', '/api/areas/' + r, d), get = u => call('GET', '/api/areas' + u);
const RING = [[-100.58, 45.12], [-100.57, 45.12], [-100.57, 45.13], [-100.58, 45.13]];   // about 0.8 x 1.1 km
const bigRing = k => { const side = Math.sqrt(k), dy = side / 110.54, dx = side / (111.32 * Math.cos(45.1 * Math.PI / 180)); return [[-100.6, 45.1], [-100.6 + dx, 45.1], [-100.6 + dx, 45.1 + dy], [-100.6, 45.1 + dy]]; };
async function waitRun(id) { for (let i = 0; i < 400; i++) { const s = (await get('/status/' + id)).j; if (s.status !== 'running') return s; await new Promise(r => setTimeout(r, 25)); } throw new Error('timeout'); }

// an EPT server: lon/lat-free 3857 bounds covering the west half of the ring, a UTM one covering all
const lonX = lon => lon * 20037508.342789244 / 180, latY = lat => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 6378137;
const srv = http.createServer((q, s) => {
  const mk = (srs, b) => JSON.stringify({ bounds: b, srs: { horizontal: srs } });
  if (q.url === '/west/ept.json') return s.end(mk('3857', [lonX(-100.59), latY(45.11), 0, lonX(-100.575), latY(45.14), 100]));
  if (q.url === '/all/ept.json') return s.end(mk('3857', [lonX(-101.5), latY(44.5), 0, lonX(-99.5), latY(45.5), 100]));
  if (q.url === '/utm/ept.json') return s.end(mk('26914', [300000, 4900000, 0, 500000, 5100000, 100]));   // zone 14 covers lon -102..-96
  if (q.url === '/far/ept.json') return s.end(mk('3857', [lonX(10), latY(10), 0, lonX(11), latY(11), 100]));
  s.statusCode = 404; s.end('no');
});

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const U = n => `http://127.0.0.1:${srv.address().port}/${n}/ept.json`;
  // ── store
  let r = await post('save', { name: 'Cave Ridge', ring: RING, project: 'p1' });
  ok('save → area with closed ring and km2', r.j.ok && r.j.area.ring.length === 5 && r.j.area.km2 > 0.5 && r.j.area.km2 < 1.5 && r.j.area.project === 'p1' && /^[A-Za-z0-9_-]+$/.test(r.j.area.id), r.j);
  const A1 = r.j.area.id;
  r = await post('save', { name: 'Mine one', ring: RING }); const A2 = r.j.area.id; ok('save My data', r.j.ok && r.j.area.project === '');
  r = await post('save', { name: 'Other', ring: RING, project: 'p2' }); const A3 = r.j.area.id;
  r = await get('?project=p1'); ok('list by project: its own and My data, not another project', r.j.areas.map(a => a.id).sort().join() === [A1, A2].sort().join(), r.j.areas.map(a => a.name));
  r = await get('?project='); ok('list with empty project: My data only', r.j.areas.length === 1 && r.j.areas[0].id === A2);
  r = await get(''); ok('list without project: all', r.j.areas.length === 3);
  r = await post('rename', { id: A1, name: '  New  name ' }); ok('rename', r.j.ok && r.j.area.name === 'New  name' && (await get('?project=p1')).j.areas.some(a => a.name === 'New  name'));
  r = await post('save', { id: A1, name: 'Cave Ridge', ring: RING.concat([RING[0]]) }); ok('save with id updates, closed ring stays 5', r.j.ok && r.j.area.id === A1 && r.j.area.ring.length === 5);
  for (const [l, d] of [['two corners', { name: 'x', ring: RING.slice(0, 2) }], ['not a ring', { name: 'x', ring: 'abc' }], ['bad lon', { name: 'x', ring: [[200, 1], [1, 1], [1, 2]] }],
    ['too many', { name: 'x', ring: Array.from({ length: 3001 }, (_, i) => [-100 + i * 1e-4, 45 + (i % 2) * 1e-3]) }], ['zero size', { name: 'x', ring: [[1, 1], [2, 2], [3, 3]] }], ['bad project', { name: 'x', ring: RING, project: '../x' }]]) {
    r = await post('save', d); ok('save rejects ' + l, r.code === 400 && r.j.ok === false, r.j);
  }
  r = await post('save', { name: 'x', ring: Array.from({ length: 3000 }, (_, i) => [-100.5 + Math.cos(i / 3000 * 6.283) * 0.01, 45 + Math.sin(i / 3000 * 6.283) * 0.01]) }); ok('3000 corners accepted', r.j.ok);
  for (const id of ['../etc', 'a/b', '', 'x'.repeat(41)]) { r = await post('delete', { id }); ok('delete bad id "' + id.slice(0, 8) + '"', r.code === 400 || r.code === 404, r.j); }
  r = await post('rename', { id: 'nope', name: 'x' }); ok('rename unknown → 404', r.code === 404);

  // ── check
  r = await post('check', { ring: RING, lidar: [], tools: ['terrain', 'veg', 'bush'] });
  ok('check: no lidar → needslidar everywhere', r.j.ok && ['terrain', 'veg', 'bush'].every(t => r.j.tools[t].status === 'needslidar' && r.j.tools[t].why) && r.j.ground.status === 'needslidar', r.j);
  r = await post('check', { ring: RING, lidar: [U('all')], tools: ['terrain', 'veg', 'bush'] });
  ok('check: covered → fits, minutes, no offers', r.j.tools.veg.status === 'fits' && r.j.tools.veg.minutes >= 1 && r.j.tools.terrain.status === 'fits' && r.j.tools.bush.offers.length === 0 && r.j.ground.coverage === 1, r.j);
  const exampleCheck = r.j;
  r = await post('check', { ring: RING, lidar: [U('west')], tools: ['veg'] });
  ok('check: partly covered (3857 bounds) → partly with percentage', r.j.tools.veg.status === 'partly' && /LiDAR covers \d+ %/.test(r.j.tools.veg.why) && r.j.ground.status === 'partly' && r.j.ground.coverage > 0.2 && r.j.ground.coverage < 0.95, r.j);
  r = await post('check', { ring: RING, lidar: [U('utm')], tools: ['veg'] }); ok('check: UTM bounds covering → fits', r.j.tools.veg.status === 'fits' && r.j.ground.coverage === 1, r.j);
  r = await post('check', { ring: RING, lidar: [U('far')], tools: ['veg'] }); ok('check: not reaching → needslidar', r.j.tools.veg.status === 'needslidar' && /does not reach/.test(r.j.tools.veg.why), r.j);
  r = await post('check', { ring: RING, lidar: [U('missing')], tools: ['veg'] }); ok('check: unreadable bounds → assumed covered', r.j.tools.veg.status === 'fits', r.j);
  r = await post('check', { ring: RING, lidar: [U('west'), U('all')], tools: ['veg'] }); ok('check: two clouds union', r.j.tools.veg.status === 'fits');
  r = await post('check', { ring: bigRing(40), lidar: [U('all')], tools: ['terrain', 'veg', 'bush'] });
  ok('check 40 km²: veg, bush and terrain too big, each with its offer', r.j.tools.veg.status === 'toobig' && r.j.tools.veg.offers[0].key === 'detail-low' && r.j.tools.bush.status === 'toobig' && r.j.tools.bush.offers[0].key === 'cell-2' && r.j.tools.terrain.status === 'toobig' && r.j.tools.terrain.offers[0].key === 'cell-2', r.j);
  r = await post('check', { ring: bigRing(40), lidar: [U('all')], tools: ['veg', 'bush'], options: { veg: { detail: 'low' }, bush: { cell: 2 } } });
  ok('check 40 km² with the coarse options → fits and coarse', r.j.tools.veg.status === 'fits' && r.j.tools.veg.coarse && r.j.tools.bush.status === 'fits' && r.j.tools.bush.coarse, r.j);
  r = await post('check', { ring: bigRing(90), lidar: [U('all')], tools: ['veg', 'bush', 'terrain'] });
  ok('check 90 km²: veg and bush too big without offers, terrain offers 2 m', r.j.tools.veg.status === 'toobig' && !r.j.tools.veg.offers.length && r.j.tools.bush.offers.length === 0 && r.j.tools.terrain.status === 'toobig' && r.j.tools.terrain.offers[0].key === 'cell-2', r.j);
  r = await post('check', { ring: bigRing(150), lidar: [U('all')], tools: ['veg'] }); ok('check 150 km²: ground too big too', r.j.ground.status === 'toobig' && r.j.tools.veg.status === 'toobig');
  r = await post('check', { ring: [[1, 1]], lidar: [], tools: [] }); ok('check bad ring → 400', r.code === 400);

  // ── run: ground, veg, bush, terrain; notes; second run reuses ground
  const L = [U('all')];
  r = await post('run', { name: 'Run area', ring: RING, project: 'p1', lidar: L, tools: ['veg', 'bush', 'terrain'], options: { veg: { detail: 'low' }, bush: { cell: 2 } } });
  ok('run → runId + areaId', r.j.ok && r.j.runId && r.j.areaId, r.j);
  const AR = r.j.areaId; let s = await waitRun(r.j.runId);
  ok('run done, steps in order', s.status === 'done' && s.steps.map(x => x.key).join() === 'ground,veg,bush,terrain' && s.steps.every(x => x.status === 'done') && s.progress === 100 && s.areaId === AR, s);
  ok('notes collected from scripts', s.notes.includes('3 possible pits') && s.notes.includes('veg note'), s.notes);
  let a = (await get('?project=p1')).j.areas.find(x => x.id === AR);
  ok('results recorded', a.results.ground.pits === 3 && a.results.ground.coverage === 0.9 && a.results.ground.notes[0] === '3 possible pits' && a.results.veg.summary.trees === 5 && a.results.veg.coarse === true && a.results.bush.coarse === true && a.results.terrain && a.results.veg.notes.includes('veg note') && a.results.veg.bytes > 0, a.results);
  ok('lidar list kept on the area', a.lidar.join() === L.join());
  ok('bush got area-dir, out dir and cell 2', JSON.parse(fs.readFileSync(path.join(root, AR, 'bush/derived.json'))).cell === '2.0' || JSON.parse(fs.readFileSync(path.join(root, AR, 'bush/derived.json'))).ad === path.join(root, AR));
  ok('veg got area-dir', JSON.parse(fs.readFileSync(path.join(root, AR, 'veg/veg.json'))).ad === path.join(root, AR) && JSON.parse(fs.readFileSync(path.join(root, AR, 'veg/veg.json'))).detail === 'low');
  ok('terrain called with ring bbox, polygon, project, ept', terrainCalls[0].project === 'p1' && terrainCalls[0].bbox.length === 4 && terrainCalls[0].polygon.length === 4 && terrainCalls[0].ept[0] === L[0], terrainCalls[0]);
  ok('terrain pointer written', fs.existsSync(path.join(root, AR, 'terrain/ref.json')));
  ok('terrain request carries the area id, and ground ran first', terrainCalls[0].area === AR && s.steps.map(x => x.key).indexOf('ground') < s.steps.map(x => x.key).indexOf('terrain') && fs.existsSync(path.join(root, AR, 'ground/grid.json')), terrainCalls[0]);
  const gOnce = fs.readFileSync(path.join(root, 'ground-count.txt'), 'utf8').length;
  const before = a.results.veg.date;
  await new Promise(r => setTimeout(r, 15));
  r = await post('run', { id: AR, lidar: L, tools: ['veg'] }); s = await waitRun(r.j.runId);
  ok('second run reuses ground (skipped, script not run again)', s.status === 'done' && s.steps[0].status === 'skipped' && fs.readFileSync(path.join(root, 'ground-count.txt'), 'utf8').length === gOnce, s);
  a = (await get('?project=p1')).j.areas.find(x => x.id === AR);
  ok('veg result replaced, not coarse this time; others kept', a.results.veg.date !== before && a.results.veg.coarse === false && a.results.bush && a.results.terrain);
  r = await post('run', { id: AR, lidar: [U('west')], tools: ['veg'] }); s = await waitRun(r.j.runId);
  ok('another lidar list → ground made again', s.steps[0].status === 'done' && fs.readFileSync(path.join(root, 'ground-count.txt'), 'utf8').length === gOnce + 1);
  ok('partly covered run still runs and says so', s.status === 'done' && s.notes.some(n => /LiDAR covers/.test(n)), s.notes);

  // ── failing steps keep earlier results
  r = await post('run', { name: 'Fail area', ring: RING, lidar: [U('all') + '?failveg'], tools: ['veg', 'bush'] });
  const AF = r.j.areaId; s = await waitRun(r.j.runId);
  a = (await get('?project=')).j.areas.find(x => x.id === AF);
  ok('failing veg: error with its reason, ground kept, bush not run', s.status === 'error' && /veg broke/.test(s.error) && a.results.ground && !a.results.veg && !a.results.bush && s.steps.map(x => x.status).join() === 'done,error,pending', s);
  r = await post('run', { id: AF, lidar: [U('all') + '?failground'], tools: ['veg'] }); s = await waitRun(r.j.runId);
  ok('failing ground: plain error', s.status === 'error' && /no points/.test(s.error), s);
  r = await post('run', { id: AF, lidar: [U('all') + '?failterrain'], tools: ['terrain'] }); s = await waitRun(r.j.runId);
  ok('failing terrain: its error', s.status === 'error' && /terrain broke/.test(s.error), s);

  // ── run refusals
  r = await post('run', { id: AF, lidar: [], tools: ['veg'] }); ok('run without lidar → 400', r.code === 400);
  r = await post('run', { id: AF, lidar: L, tools: [] }); ok('run without tools → 400', r.code === 400);
  r = await post('run', { name: 'Big', ring: bigRing(40), lidar: L, tools: ['veg'] }); ok('run too big → 400 with the reason', r.code === 400 && /km²/.test(r.j.error), r.j);
  r = await post('run', { id: 'nope', lidar: L, tools: ['veg'] }); ok('run unknown area → 404', r.code === 404);
  r = await get('/status/zzzz'); ok('status unknown → 404', r.code === 404);

  // ── prospect: after ground, no lidar needed once ground exists
  r = await post('check', { id: AR, ring: RING, lidar: [], tools: ['prospect', 'veg'] });
  ok('check: prospect fits on an area with ground, even with no LiDAR; veg still needs it', r.j.tools.prospect.status === 'fits' && r.j.tools.prospect.minutes >= 1 && r.j.tools.veg.status === 'needslidar', r.j);
  r = await post('check', { ring: RING, lidar: [], tools: ['prospect'] }); ok('check: prospect with no ground and no LiDAR → needslidar', r.j.tools.prospect.status === 'needslidar');
  r = await post('check', { ring: bigRing(150), lidar: [U('all')], tools: ['prospect'] }); ok('check 150 km²: prospect too big', r.j.tools.prospect.status === 'toobig');
  const known = [{ lon: -100.57, lat: 45.12, name: 'Cave Ridge T6' }, [-100.5, 45.1], { lon: -100.5, lat: 45.1, name: 'x'.repeat(200) }];
  r = await post('run', { id: AR, lidar: [], tools: ['prospect'], options: { prospect: { known } } }); ok('run prospect only, no LiDAR, area has ground → started', r.j.ok, r.j);
  s = await waitRun(r.j.runId);
  ok('prospect-only run: one step, done, ground not re-run', s.status === 'done' && s.steps.map(x => x.key).join() === 'prospect', s);
  a = (await get('?project=p1')).j.areas.find(x => x.id === AR);
  ok('prospect result: counts, notes, bytes, known', a.results.prospect.counts.A === 2 && a.results.prospect.counts.B === 3 && a.results.prospect.counts.C === 1 && a.results.prospect.counts.isolated === 5 && a.results.prospect.notes[0] === '6 candidates (2 sinks)' && a.results.prospect.bytes > 0 && a.results.prospect.known === 3, a.results.prospect);
  ok('area lidar list not emptied by the prospect-only run', a.lidar.length > 0);
  ok('known file and params are cleaned up', !fs.existsSync(path.join(root, AR, 'prospect-known.json')) && !fs.existsSync(path.join(root, AR, 'prospect-params.json')));
  r = await post('run', { id: AR, lidar: L, tools: ['veg', 'prospect'] }); s = await waitRun(r.j.runId);
  ok('order: ground, prospect, veg', s.status === 'done' && s.steps.map(x => x.key).join() === 'ground,prospect,veg', s.steps);
  for (const bad of [{ prospect: { known: 'nope' } }, { prospect: { known: [{ lon: 500, lat: 1 }] } }, { prospect: { known: [{ lon: 1 }] } }, { prospect: { known: new Array(5001).fill([1, 1]) } }]) {
    r = await post('run', { id: AR, lidar: L, tools: ['prospect'], options: bad }); ok('run refuses bad known points', r.code === 400 && /known/.test(r.j.error), r.j);
  }
  r = await post('save', { name: 'Empty', ring: RING }); r = await post('run', { id: r.j.area.id, lidar: [], tools: ['prospect'] }); ok('prospect only, no LiDAR and no ground → 400', r.code === 400);
  r = await post('run', { id: AR, lidar: L, tools: ['prospect'], options: { prospect: { known: Array.from({ length: 5000 }, (_, i) => [-100 + i * 1e-4, 45]) } } }); s = await waitRun(r.j.runId); ok('5000 known points accepted', s.status === 'done');

  // ── files
  r = await get(`/file/${AR}/veg/shapes.bin`); ok('file: .bin as octet-stream', r.code === 200 && r.h['Content-Type'] === 'application/octet-stream' && r.buf.length === 8, r.h);
  r = await get(`/file/${AR}/veg/veg.json`); ok('file: json', r.code === 200 && r.h['Content-Type'] === 'application/json');
  r = await get(`/file/${AR}/ground/ground.npy`); ok('file: ground.npy', r.code === 200 && r.buf.length === 4);
  r = await get(`/file/${AR}/bush/x.png`); ok('file: bush png', r.code === 200 && r.h['Content-Type'] === 'image/png');
  r = await get(`/file/${AR}/prospect/candidates.kml`); ok('file: prospect kml', r.code === 200 && /kml/.test(r.h['Content-Type']) && r.buf.length === 6, r.h);
  r = await get(`/file/${AR}/prospect/candidates.csv`); ok('file: prospect csv', r.code === 200 && /csv/.test(r.h['Content-Type']));
  r = await get(`/file/${AR}/prospect/depth.png`); ok('file: prospect png', r.code === 200 && r.h['Content-Type'] === 'image/png');
  r = await get(`/file/${AR}/prospect/summary.json`); ok('file: prospect summary', r.code === 200);
  for (const u of [`/file/${AR}/prospect/candidates.txt`, `/file/${AR}/prospect/log.txt`, `/file/${AR}/prospect/depth.pgw`, `/file/${AR}/prospect/candidates.geojson.bak`, `/file/${AR}/prospect/..%2Farea.json`, `/file/${AR}/prospect-known.json`])
    { r = await get(u); ok('prospect file refused: ' + u.replace(AR, '<id>'), r.code === 404 || r.code === 400, r.code); }
  for (const u of [`/file/${AR}/veg/params.json`, `/file/${AR}/veg/..%2Farea.json`, `/file/${AR}/veg/../area.json`, `/file/${AR}/../veg.json`, `/file/${AR}/nothing/veg.json`, `/file/${AR}/ground/ground-params.json`, `/file/${AR}/veg/`, '/file/../../etc/passwd', `/file/${AR}/bush/.hidden.png`, `/file/${AR}/area.json`, `/file/${AR}/veg/shell.bin`])
    { r = await get(u); ok('file refused: ' + u.replace(AR, '<id>'), r.code === 404 || r.code === 400, r.code); }

  // ── jobs list shape
  ok('jobs: every run has name Analyze: …, progress lines, ended', Object.values(api.jobs).every(j => /^Analyze: /.test(j.name) && j.progress.length && j.ended));

  // ── delete-result / delete
  r = await post('delete-result', { id: AR, result: 'prospect' }); ok('delete-result prospect', r.j.ok && !r.j.area.results.prospect && !fs.existsSync(path.join(root, AR, 'prospect')) && !!r.j.area.results.ground);
  r = await post('delete-result', { id: AR, result: 'veg' }); ok('delete-result removes folder and record', r.j.ok && !r.j.area.results.veg && !fs.existsSync(path.join(root, AR, 'veg')) && !!r.j.area.results.bush);
  r = await post('delete-result', { id: AR, result: 'ground' }); ok('delete-result ground', r.j.ok && !fs.existsSync(path.join(root, AR, 'ground')));
  r = await post('delete-result', { id: AR, result: '../x' }); ok('delete-result bad name → 400', r.code === 400);
  r = await post('delete-result', { id: 'nope', result: 'veg' }); ok('delete-result unknown → 404', r.code === 404);
  r = await post('delete', { id: AR }); ok('delete area', r.j.ok && !fs.existsSync(path.join(root, AR)) && !(await get('')).j.areas.some(x => x.id === AR));
  r = await post('delete', { id: AR }); ok('delete again → 404', r.code === 404);
  fs.writeFileSync(path.join(tmp, 'example-check.json'), JSON.stringify(exampleCheck));
  console.log('EXAMPLE CHECK', JSON.stringify(exampleCheck));
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e); process.exit(2); });
