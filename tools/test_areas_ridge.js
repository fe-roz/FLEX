// areas_api.js: the Ridgewalking tool of Analyze by area. Stand-in scripts (python3 files in a temp folder) for
// ridgewalk.py and ridge_area.py; made-up numbers around 45.1234, -100.5678.
// check (fits, its cost line, the limit and its "too big" wording, needs LiDAR), run alone (no ground step) and with
// other tools (after ground), the arguments the step gets, its "[ridge] NN% text" progress as the run's percent,
// cancel, a failing run keeping earlier results, the result record, delete-result, the files allow-list, the package.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 500) : '')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'areas-ridge-'));
const W = (n, s) => { const f = path.join(tmp, n); fs.writeFileSync(f, s); return f; };
const groundPy = W('ground.py', `
import argparse, json, os, sys
ap = argparse.ArgumentParser(); ap.add_argument('--params'); ap.add_argument('--area-dir'); a = ap.parse_args()
open(os.path.join(os.path.dirname(a.area_dir), 'ground-count.txt'), 'a').write('x')
g = os.path.join(a.area_dir, 'ground'); os.makedirs(g)
open(g + '/ground.npy', 'wb').write(b'0123'); json.dump({'cell': 1.0}, open(g + '/grid.json', 'w')); json.dump({'coverage': 0.9, 'cell': 1.0}, open(g + '/summary.json', 'w'))
print('[1/1] ground')
`);
const vegPy = W('veg.py', `
import argparse, json
ap = argparse.ArgumentParser(); ap.add_argument('--params'); ap.add_argument('--out'); ap.add_argument('--area-dir'); a = ap.parse_args()
open(a.out + '/shapes.bin', 'wb').write(b'12345678'); json.dump({'shapes': {'trees': 5, 'brush': 2}}, open(a.out + '/veg.json', 'w'))
`);
// the stand-in ridgewalk.py: writes what the real one writes (tiny), prints its progress lines, can be slow or fail
const ridgePy = W('ridge.py', `
import argparse, json, os, sys, time
ap = argparse.ArgumentParser(); ap.add_argument('--ept'); ap.add_argument('--also-ept', action='append', default=[]); ap.add_argument('--bbox', nargs=4, type=float)
ap.add_argument('--polygon'); ap.add_argument('--out'); a = ap.parse_args()
ring = json.load(open(a.polygon))
json.dump({'argv': sys.argv[1:], 'ring': ring}, open(os.path.join(os.path.dirname(a.out), 'ridge-args.json'), 'w'))
print('[ridge] 1% area 800 x 1100 m, 99 tiles, 4 workers', flush=True)
if 'slow' in a.ept:
    print('[ridge] 40% reading (40 of 99 tiles)', flush=True); time.sleep(30)
if 'failridge' in a.ept:
    print('[ridge] 12% reading', flush=True); print('! the cloud has no returns here'); sys.exit(1)
print('[ridge] 73% features (12 clusters)', flush=True)
for n, b in (('lid.npy', b'L' * 64), ('holes.npy', b'H' * 64), ('brush.npy', b'B' * 8), ('points.bin', b'RWP1' + bytes(4)), ('shapes.bin', b'RWS1' + bytes(8))):
    open(os.path.join(a.out, n), 'wb').write(b)
json.dump({'version': 1, 'features': [{'id': 'r1-1', 'x': 10, 'y': 20, 'z': 500, 'n': 12, 'deepest': 4.2, 'box': [9, 19, 495, 11, 21, 500], 'entrance': 'true'}]}, open(os.path.join(a.out, 'features.json'), 'w'))
if 'noquality' not in a.ept:
    json.dump({'version': 1, 'cloud': {'returns': 1000}, 'passes': [{'id': 3, 'flagged': False}, {'id': 4, 'flagged': True, 'set_aside': 3}], 'coverage': {'passes_1': 0.125, 'no_ground_within_3m': 0.04},
               'reading': {'tiles': 9, 'read_in_this_run': True, 'left_blank': 2}, 'verdicts': [{'key': 'passes', 'value': 2, 'text': '2 flight passes cover the area.'}]}, open(os.path.join(a.out, 'quality.json'), 'w'))
    json.dump({'version': 2, 'grid': {'x0': 376000, 'y0': 4997000, 'cell': 7.2, 'nx': 4, 'ny': 4, 'zone': 14, 'south': False, 'row0': 'south'},
               'maps': [{'id': m, 'file': f, 'units': '', 'levels': 16, 'values': list(range(16)), 'min': 0, 'max': 15, 'suggest': [0, 4]} for m, f in (('passes', 'passes.u8'), ('groundseen', 'ground_seen.u8'), ('density', 'density.u8'))]}, open(os.path.join(a.out, 'maps.json'), 'w'))
    for f in ('passes.u8', 'ground_seen.u8', 'density.u8'): open(os.path.join(a.out, f), 'wb').write(bytes([3] * 16))
json.dump({'version': 1, 'zone': 14, 'south': False, 'origin': [376000, 4997000], 'cell': 0.3, 'nx': 100, 'ny': 100,
           'counts': {'features': 1, 'below': 12, 'true_cells': 40, 'guessed_cells': 7, 'pattern_noise': 3, 'returns': 1000},
           'notes': ['the file has no flight pass ids: no patterned-noise check', 'Tile-independent: ' + 'x' * 300]}, open(os.path.join(a.out, 'ridge.json'), 'w'))
print('[ridge] 100% done in 3 s: 1000 returns', flush=True)
`);
const ridgeAreaPy = W('ridge_area.py', `
import json, os, sys
d = sys.argv[1]
if os.environ.get('FAIL_RIDGE_AREA'): print('! no place on the map'); sys.exit(1)
json.dump({'version': 1, 'features': json.load(open(d + '/features.json'))['features']}, open(d + '/draw.json', 'w'))
open(d + '/patches.bin', 'wb').write(b'RWQ1' + bytes(12))
print('[ridge] 100% for the map: 1 features')
`);
const fakeTerrain = { jobs: {}, handle(req, res) { res.end(JSON.stringify({ ok: false, error: 'no terrain in this test' })); } };
const root = path.join(tmp, 'areas');
const api = require('../areas_api')({ python: 'python3', groundScript: groundPy, vegScript: vegPy, prospectScript: groundPy, lidarScript: groundPy, mapsScript: groundPy, ridgeScript: ridgePy, ridgeAreaScript: ridgeAreaPy,
  root, terrainGen: fakeTerrain, pollMs: 20, fetchTimeoutMs: 2000 });
const jobsApi = require('../jobs_api');

function call(method, url, data) {
  return new Promise(resolve => {
    const [p, q] = url.split('?'); const query = {}; (q || '').split('&').filter(Boolean).forEach(kv => { const [k, v] = kv.split('='); query[k] = decodeURIComponent(v); });
    const { Readable, Writable } = require('stream'); const req = Readable.from(data === undefined ? [] : [Buffer.isBuffer(data) ? data : JSON.stringify(data)]); req.method = method;
    const chunks = []; const w = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
    const rs = Object.assign(w, { code: 200, writeHead(c, h) { this.code = c; this.h = h; }, setHeader() {} });
    const _end = w.end.bind(w); w.end = function (t) { if (t) chunks.push(Buffer.from(t)); _end(); };
    w.on('finish', () => resolve({ code: rs.code, h: rs.h, buf: Buffer.concat(chunks), get j() { try { return JSON.parse(this.buf.toString()); } catch (_) { return null; } } }));
    api.handle(req, rs, p.replace(/^\/api\/areas\/?/, ''), query);
  });
}
const post = (r, d) => call('POST', '/api/areas/' + r, d), get = u => call('GET', '/api/areas' + u);
const RING = [[-100.58, 45.12], [-100.57, 45.12], [-100.57, 45.13], [-100.58, 45.13]];   // about 0.8 x 1.1 km
const bigRing = k => { const side = Math.sqrt(k), dy = side / 110.54, dx = side / (111.32 * Math.cos(45.1 * Math.PI / 180)); return [[-100.6, 45.1], [-100.6 + dx, 45.1], [-100.6 + dx, 45.1 + dy], [-100.6, 45.1 + dy]]; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitRun(id, n = 600) { for (let i = 0; i < n; i++) { const s = (await get('/status/' + id)).j; if (s.status !== 'running') return s; await sleep(25); } throw new Error('timeout'); }
const lonX = lon => lon * 20037508.342789244 / 180, latY = lat => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 6378137;
const srv = http.createServer((q, s) => {
  const mk = b => JSON.stringify({ bounds: b, srs: { horizontal: '3857' } });
  if (/^\/(all|slow|failridge|second)\/ept\.json$/.test(q.url)) return s.end(mk([lonX(-101.5), latY(44.5), 0, lonX(-99.5), latY(45.5), 100]));
  if (q.url === '/far/ept.json') return s.end(mk([lonX(10), latY(10), 0, lonX(11), latY(11), 100]));
  s.statusCode = 404; s.end('no');
});

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const U = n => `http://127.0.0.1:${srv.address().port}/${n}/ept.json`;
  const dir = id => path.join(root, id);

  // ── check ────────────────────────────────────────────────────────────────
  let r = await post('check', { ring: RING, lidar: [U('all')] });
  ok('check with no tools named: Ridgewalking is one of the tools', r.j.ok && r.j.tools.ridge && ['terrain', 'veg', 'bush', 'prospect', 'ridge'].every(t => r.j.tools[t]), Object.keys(r.j.tools || {}));
  ok('…it fits a 0.9 km² area, about 2 minutes, and its line says it reads the LiDAR itself and why', r.j.tools.ridge.status === 'fits' && r.j.tools.ridge.minutes === 2 && r.j.tools.ridge.offers.length === 0 &&
    r.j.tools.ridge.why === 'Reads the LiDAR itself (it needs the flight-pass ids, which the area\'s stored points do not keep).', r.j.tools.ridge);
  r = await post('check', { ring: RING, lidar: [], tools: ['ridge'] });
  ok('no LiDAR chosen: needs LiDAR', r.j.tools.ridge.status === 'needslidar' && /Choose the LiDAR/.test(r.j.tools.ridge.why), r.j.tools.ridge);
  r = await post('check', { ring: RING, lidar: [U('far')], tools: ['ridge'] });
  ok('a cloud that does not reach the area: needs LiDAR', r.j.tools.ridge.status === 'needslidar' && /does not reach/.test(r.j.tools.ridge.why));
  ok('the limit is 15 km²', api.LIMITS.ridge.max === 15);
  r = await post('check', { ring: bigRing(14), lidar: [U('all')], tools: ['ridge'] });
  ok('14 km² fits (about 23 minutes)', r.j.tools.ridge.status === 'fits' && r.j.tools.ridge.minutes >= 21 && r.j.tools.ridge.minutes <= 25, r.j.tools.ridge);
  r = await post('check', { ring: bigRing(20), lidar: [U('all')], tools: ['ridge', 'veg'] });
  ok('20 km² is too big, in the other tools\' words, with nothing coarser to offer; another tool still fits', r.j.tools.ridge.status === 'toobig' && /^20\.\d km² is more than this can do at once \(15 km²\): choose a smaller area\.$/.test(r.j.tools.ridge.why) &&
    r.j.tools.ridge.offers.length === 0 && r.j.tools.veg.status === 'fits', r.j.tools.ridge);
  r = await post('run', { name: 'Too big', ring: bigRing(20), lidar: [U('all')], tools: ['ridge'] });
  ok('…and a run of it is refused with that reason', r.code === 400 && /Ridgewalking: 20\.\d km² is more than/.test(r.j.error), r.j);
  r = await post('run', { name: 'No cloud', ring: RING, lidar: [], tools: ['ridge'] });
  ok('a run with no LiDAR is refused', r.code === 400 && /Choose the LiDAR/.test(r.j.error), r.j);

  // ── run alone: no ground step ────────────────────────────────────────────
  r = await post('run', { name: 'Cave Ridge', ring: RING, project: 'p1', lidar: [U('all'), U('second')], tools: ['ridge'] });
  ok('run accepted', r.j.ok && r.j.runId && r.j.areaId, r.j);
  const A = r.j.areaId;
  let s = await waitRun(r.j.runId);
  ok('Ridgewalking alone: one step, no ground made, done', s.status === 'done' && s.steps.map(x => x.key + ':' + x.status).join() === 'ridge:done' && !fs.existsSync(path.join(root, 'ground-count.txt')) && !fs.existsSync(path.join(dir(A), 'ground')), s);
  const args = JSON.parse(fs.readFileSync(path.join(dir(A), 'ridge-args.json'), 'utf8'));
  const at = k => args.argv[args.argv.indexOf(k) + 1];
  ok('the step gets the LiDAR (and the second cloud), the area\'s box, its ring as --polygon and the area\'s ridge folder', at('--ept') === U('all') && at('--also-ept') === U('second') && at('--out') === path.join(dir(A), 'ridge') &&
    args.argv.slice(args.argv.indexOf('--bbox') + 1, args.argv.indexOf('--bbox') + 5).map(Number).join() === '-100.58,45.12,-100.57,45.13' && args.ring.length === 4 && args.ring[0].join() === '-100.58,45.12', args.argv);
  ok('the ring file is tidied away after the run', !fs.existsSync(path.join(dir(A), 'ridge-ring.json')));
  let a = (await get('?project=p1')).j.areas.find(x => x.id === A);
  ok('the LiDAR quality report\'s headline is kept with the result: passes, flagged, one pass only, ground not seen, tiles blank', a && a.results.ridge && JSON.stringify(a.results.ridge.quality) === JSON.stringify({ passes: 2, flagged: 1, single_pass: 0.125, ground_not_seen: 0.04, tiles_blank: 2 }), a && a.results.ridge);
  for (const n of ['quality.json', 'maps.json', 'passes.u8', 'ground_seen.u8', 'density.u8']) { const rq = await get(`/file/${A}/ridge/${n}`); ok('served: ridge/' + n, rq.code === 200, rq.code); }
  { const rq = await get(`/maps/${A}`); ok('the three quality maps are listed for 🗺 Layers', rq.j && rq.j.ok && rq.j.maps.map(m => m.id).join() === 'passes,groundseen,density' && rq.j.maps.every(m => m.folder === 'ridge'), rq.j);
    const rt = await get(`/tiles/${A}/passes/15/7230/11698.png`); ok('…and a tile of one comes as a PNG', rt.code === 200 && rt.h['Content-Type'] === 'image/png', [rt.code, rt.h]); }
  ok('the result is in area.json: counts, cell, date, seconds, bytes; the LiDAR used', a && a.results.ridge && a.results.ridge.counts.features === 1 && a.results.ridge.counts.true_cells === 40 && a.results.ridge.counts.guessed_cells === 7 && a.results.ridge.cell === 0.3 &&
    a.results.ridge.bytes > 100 && a.results.ridge.seconds >= 0 && !isNaN(Date.parse(a.results.ridge.date)) && !a.results.ground && a.lidar.length === 2, a && a.results);
  ok('a short note of the step is kept with the result (the long technical one is not)', a.results.ridge.notes.length === 1 && /no flight pass ids/.test(a.results.ridge.notes[0]), a.results.ridge.notes);
  ok('the folder holds the step\'s files and the two made for the map', ['ridge.json', 'features.json', 'points.bin', 'shapes.bin', 'lid.npy', 'holes.npy', 'draw.json', 'patches.bin'].every(n => fs.existsSync(path.join(dir(A), 'ridge', n))));
  ok('the run\'s log is kept', /\[ridge\] 73% features/.test(fs.readFileSync(path.join(dir(A), 'log.txt'), 'utf8')) && /== Ridgewalking ==/.test(fs.readFileSync(path.join(dir(A), 'log.txt'), 'utf8')));

  // ── files: the allow-list ────────────────────────────────────────────────
  for (const n of ['ridge.json', 'features.json', 'draw.json', 'points.bin', 'shapes.bin', 'patches.bin']) { r = await get(`/file/${A}/ridge/${n}`); ok('served: ridge/' + n, r.code === 200 && r.buf.length > 0, r.code); }
  r = await get(`/file/${A}/ridge/points.bin`); ok('…a binary comes as it is', r.buf.slice(0, 4).toString() === 'RWP1' && r.h['Content-Type'] === 'application/octet-stream');
  for (const n of ['lid.npy', 'holes.npy', 'brush.npy', '../area.json', 'ridge.json.bak', 'x.bin', '']) { r = await get(`/file/${A}/ridge/${n}`); ok('not served: ridge/' + (n || '(nothing)'), r.code === 404, r.code); }

  // ── with other tools: after the ground, and progress ─────────────────────
  r = await post('run', { id: A, lidar: [U('slow')], tools: ['veg', 'ridge'] });
  const run2 = r.j.runId;
  let seen = null;
  for (let i = 0; i < 400 && !seen; i++) { const q = (await get('/status/' + run2)).j; if (q.step === 'ridge' && /40% reading/.test(q.message)) seen = q; else await sleep(25); }
  ok('with another tool: ground first, then the tool, then Ridgewalking', seen && seen.steps.map(x => x.key).join() === 'ground,veg,ridge' && seen.steps[0].status === 'done' && seen.steps[1].status === 'done' && seen.steps[2].status === 'running', seen && seen.steps);
  ok('its "[ridge] 40% …" line is the run\'s message and moves the percent (two steps done + 40 % of the third = 80)', seen && seen.message === '[ridge] 40% reading (40 of 99 tiles)' && seen.progress === 80, seen && [seen.message, seen.progress]);
  r = await post('delete-result', { id: A, result: 'ridge' });
  ok('a result cannot be deleted while the area is being processed', r.code === 409, r.j);
  // cancel (the Jobs panel's button): the process is killed, the run ends as cancelled
  const J = jobsApi({ sources: { area: { jobs: api.jobs, pct: api.pctOf } } });
  const listed = J.list().find(x => x.jobId === run2 || x.id === 'area.' + run2);
  ok('the run is in the Jobs list, cancellable, with the ridge line', listed && listed.cancellable === true && /\[ridge\] 40%/.test(listed.message), listed);
  const t0 = Date.now(); const c = J.cancel(listed.id);
  s = await waitRun(run2);
  ok('Cancel stops it at once (the 30 s read does not run on): the run ends "Cancelled"', c.code === 200 && s.status === 'error' && s.error === 'Cancelled' && Date.now() - t0 < 5000 && s.steps[2].status === 'error', [c, s.error, Date.now() - t0]);
  a = (await get('?project=p1')).j.areas.find(x => x.id === A);
  ok('…the steps before it keep their results; the old ridge result is gone (its folder was being rewritten)', a.results.ground && a.results.veg && fs.existsSync(path.join(dir(A), 'veg', 'veg.json')) && !fs.existsSync(path.join(dir(A), 'ridge', 'ridge.json')), Object.keys(a.results));

  // ── a failing run ────────────────────────────────────────────────────────
  r = await post('run', { id: A, lidar: [U('failridge')], tools: ['ridge'] });
  s = await waitRun(r.j.runId);
  ok('a step that fails: the run says why, in the step\'s own words', s.status === 'error' && /the cloud has no returns here/.test(s.error) && /exit 1/.test(s.error), s.error);
  process.env.FAIL_RIDGE_AREA = '1';
  r = await post('run', { id: A, lidar: [U('all')], tools: ['ridge'] }); s = await waitRun(r.j.runId);
  delete process.env.FAIL_RIDGE_AREA;
  ok('the map step failing fails the run too (no half result is recorded)', s.status === 'error' && /no place on the map/.test(s.error) && !((await get('?project=p1')).j.areas.find(x => x.id === A).results.ridge && fs.existsSync(path.join(dir(A), 'ridge', 'draw.json'))), s.error);
  r = await post('run', { id: A, lidar: [U('all')], tools: ['ridge'] }); s = await waitRun(r.j.runId);
  a = (await get('?project=p1')).j.areas.find(x => x.id === A);
  ok('run again: made; the ground made before is still there and was not made again', s.status === 'done' && a.results.ridge && a.results.ground && fs.readFileSync(path.join(root, 'ground-count.txt'), 'utf8') === 'x');

  // ── the package: what the map needs, not the area-wide grids ─────────────
  const pack = require('./area_pack.js');
  const P = await pack.pack(dir(A));
  const inside = P.report.files.map(f => f.path).filter(p => p.startsWith('ridge/')).sort();
  ok('an area package carries the ridge folder (with the quality report and its rasters) without lid.npy, holes.npy and brush.npy', inside.join() === 'ridge/density.u8,ridge/draw.json,ridge/features.json,ridge/ground_seen.u8,ridge/maps.json,ridge/passes.u8,ridge/patches.bin,ridge/points.bin,ridge/quality.json,ridge/ridge.json,ridge/shapes.bin' && P.report.left.includes('ridge/lid.npy') && P.report.left.includes('ridge/holes.npy'), [inside, P.report.left]);
  const root2 = path.join(tmp, 'areas2');
  const un = await pack.unpack(P.buffer, root2);
  ok('…and unpacks on another computer with the result and its files', un.ok && fs.existsSync(path.join(root2, A, 'ridge', 'draw.json')) && fs.existsSync(path.join(root2, A, 'ridge', 'shapes.bin')) && JSON.parse(fs.readFileSync(path.join(root2, A, 'area.json'), 'utf8')).results.ridge.counts.features === 1, un);

  // ── delete-result ────────────────────────────────────────────────────────
  r = await post('delete-result', { id: A, result: 'ridge' });
  ok('delete-result ridge: the folder and the record go, the other results stay', r.j.ok && !r.j.area.results.ridge && r.j.area.results.veg && !fs.existsSync(path.join(dir(A), 'ridge')) && fs.existsSync(path.join(dir(A), 'veg')), r.j);
  r = await get(`/file/${A}/ridge/draw.json`); ok('…and its files are no longer served', r.code === 404);

  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
