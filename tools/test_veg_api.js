// veg_api.js (the server side of 🔬 Analyze → Vegetation shapes): params rebuilt from what is allowed, a job runs a script with
// --params/--out, `! ` lines become the error, files are served from an allow-list (.bin as octet-stream), Keep / Saved / Delete
// under a separate folder, and the Jobs list (jobs_api.js) knows the "veg" kind. The script is a tiny stand-in in a temp folder.
// Run: node tools/test_veg_api.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 400) : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-veg-'));
const script = path.join(tmp, 'stub.py');
fs.writeFileSync(script, `
import json, os, sys, struct, argparse
ap = argparse.ArgumentParser(); ap.add_argument('--params'); ap.add_argument('--out'); a = ap.parse_args()
P = json.load(open(a.params)); os.makedirs(a.out, exist_ok=True)
print('[1/3] reading')
if 'fail' in P['source']['ept']:
    print('! cannot read the point cloud'); sys.exit(1)
if 'crash' in P['source']['ept']:
    raise RuntimeError('boom')
print('[2/3] shapes')
open(a.out + '/shapes.bin', 'wb').write(struct.pack('<8f', 1, 2, 100, 12, 3, 4, 0, 0.8) * 3)
open(a.out + '/shell.bin', 'wb').write(struct.pack('<12f', 0,0,100,0, 1,0,100,1, 0,1,100,1) + struct.pack('<3I', 0, 1, 2))
open(a.out + '/ground.bin', 'wb').write(struct.pack('<4f', 100, 100, 100, 100))
open(a.out + '/preview.png', 'wb').write(b'\\x89PNG')
print('[3/3] done')
json.dump({'version': 1, 'origin': {'lon': -100.5678, 'lat': 45.1234, 'h': 100}, 'frame': 'enu', 'bbox': [0, 0, 10, 10], 'area_m2': 100,
  'shapes': {'file': 'shapes.bin', 'count': 3, 'trees': 2, 'cones': 1, 'domes': 1, 'brush': 1, 'record': 32},
  'shell': {'file': 'shell.bin', 'vertices': 3, 'triangles': 1, 'voxel_m': 2}, 'ground': {'file': 'ground.bin', 'nx': 2, 'ny': 2, 'cell': 5, 'x0': 0, 'y0': 0},
  'stats': {'points': 10}, 'params': P}, open(a.out + '/veg.json', 'w'))
`);
const vegApi = require('../veg_api')({ python: 'python3', script, outRoot: path.join(tmp, 'jobs', 'veg'), savedRoot: path.join(tmp, 'veg') });
const jobsApi = require('../jobs_api')({ sources: { veg: { jobs: vegApi.jobs, pct: vegApi.pctOf } } });

const sq = (e, n, s) => [[e, n], [e + s, n], [e + s, n + s], [e, n + s], [e, n]];   // ~ s degrees square
const good = { source: { ept: 'http://localhost:1/x/ept.json', ept_also: ['http://localhost:1/y/ept.json', 'file:///etc/passwd', 5] },
  area: sq(-100.5678, 45.1234, 0.005).concat([[500, 0], 'x']), looks: ['shell', 'bogus', 'shell'], detail: 'weird', min_height: 99, brush_top: 1, max_triangles: 5, evil: 'x' };
const c = vegApi.clean(good).params;
ok('clean: ept kept, other sources only when http(s)', c.source.ept === good.source.ept && c.source.ept_also.length === 1, c.source);
ok('clean: ring closed, bad corners dropped', c.area.length === 5 && c.area[0].join() === c.area[4].join(), c.area);
ok('clean: looks filtered and de-duplicated', c.looks.join() === 'shell', c.looks);
ok('clean: detail repaired, numbers clamped, brush_top above min_height, nothing extra', c.detail === 'medium' && c.min_height === 20 && c.brush_top > c.min_height && c.max_triangles === 20000 && !('evil' in c), c);
const d = vegApi.clean({ source: good.source, area: sq(-100.5678, 45.1234, 0.005) }).params;
ok('clean: defaults', d.looks.join() === 'shapes,shell' && d.detail === 'medium' && d.min_height === 0.5 && d.brush_top === 2 && d.max_triangles === 300000, d);
ok('clean: no source / local path are errors', !!vegApi.clean({ area: good.area }).error && !!vegApi.clean({ source: { las: ['/tmp/a.laz'] }, area: good.area }).error);
ok('clean: no area / two corners are errors', !!vegApi.clean({ source: good.source }).error && !!vegApi.clean({ source: good.source, area: [[1, 1], [2, 2]] }).error);
ok('clean: an area over 25 km2 is refused with a plain message', /km²/.test(vegApi.clean({ source: good.source, area: sq(-100.5678, 45.1234, 0.1) }).error || ''));
ok('clean: a thousand corners fine, 3001 refused', !vegApi.clean({ source: good.source, area: Array.from({ length: 1000 }, (_, i) => [-100.5678 + 0.002 * Math.cos(i / 159), 45.1234 + 0.002 * Math.sin(i / 159)]) }).error
  && !!vegApi.clean({ source: good.source, area: Array.from({ length: 3001 }, (_, i) => [-100.5678 + 0.002 * Math.cos(i), 45.1234 + 0.002 * Math.sin(i)]) }).error);

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  if (p.startsWith('/api/veg/')) return vegApi.handle(req, res, p.slice('/api/veg/'.length), Object.fromEntries(u.searchParams));
  if (p === '/api/jobs' || p.startsWith('/api/jobs/')) { if (!jobsApi.handle(req, res, p.slice('/api/jobs'.length).replace(/^\//, ''))) { res.writeHead(404); res.end(); } return; }
  res.writeHead(404); res.end();
});
const call = (method, p, body) => new Promise(r => { const q = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method, headers: { 'Content-Type': 'application/json' } }, x => { const b = []; x.on('data', d => b.push(d)); x.on('end', () => { const buf = Buffer.concat(b), s = buf.toString(); let j = null; try { j = JSON.parse(s); } catch (_) {} r({ status: x.statusCode, json: j, text: s, len: buf.length, type: x.headers['content-type'] }); }); }); q.end(body ? JSON.stringify(body) : undefined); });
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };
const finish = async id => until(async () => { const s = await call('GET', '/api/veg/status/' + id); return s.json.status !== 'running' ? s.json : null; });

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  let r = await call('POST', '/api/veg/build', { params: { area: good.area } });
  ok('build without a source: 400, plain message', r.status === 400 && /LiDAR/.test(r.json.error), r.json);
  r = await call('POST', '/api/veg/build', { project: '../x', params: good });
  ok('build with a bad project id: 400', r.status === 400, r.json);
  r = await call('POST', '/api/veg/build', { project: 'p1', params: good });
  ok('build: a job id', r.status === 200 && r.json.ok && /^[a-z0-9]+$/.test(r.json.jobId), r.json);
  const id = r.json.jobId;
  const lj = jobsApi.list().find(j => j.id === 'veg.' + id);
  ok('the Jobs list has it as veg.<id> named Vegetation shapes', lj && lj.kind === 'veg' && lj.name === 'Vegetation shapes', lj);
  const st = await finish(id);
  ok('the job finishes', st && st.status === 'done' && st.progress === 100, st);
  ok('params.json in the job folder is the cleaned one', JSON.parse(fs.readFileSync(path.join(tmp, 'jobs', 'veg', id, 'params.json'), 'utf8')).max_triangles === 20000);
  r = await call('GET', '/api/veg/result?id=' + id);
  ok('result: veg, base, sizes, params', r.json.ok && r.json.veg.shapes.count === 3 && r.json.base === '/api/veg/file/' + id + '/' && r.json.sizes['shapes.bin'] === 96 && r.json.params.detail === 'medium', r.json);
  r = await call('GET', '/api/veg/file/' + id + '/shapes.bin');
  ok('file: .bin as application/octet-stream, whole', r.status === 200 && r.type === 'application/octet-stream' && r.len === 96, [r.status, r.type, r.len]);
  r = await call('GET', '/api/veg/file/' + id + '/veg.json');
  ok('file: veg.json as json', r.status === 200 && /json/.test(r.type) && r.json.version === 1);
  r = await call('GET', '/api/veg/file/' + id + '/preview.png');
  ok('file: preview.png as image/png', r.status === 200 && r.type === 'image/png');
  ok('file: shell.bin and ground.bin', (await call('GET', '/api/veg/file/' + id + '/shell.bin')).status === 200 && (await call('GET', '/api/veg/file/' + id + '/ground.bin')).status === 200);
  ok('file: params.json, log.txt, traversal and bad ids are refused', (await Promise.all(['params.json', 'log.txt', '..%2F..%2Fx', 'sub%2Fshapes.bin', 'shapes.bin%00'].map(n => call('GET', '/api/veg/file/' + id + '/' + n)))).every(x => x.status === 404)
    && (await call('GET', '/api/veg/file/..%2F/shapes.bin')).status === 404 && (await call('GET', '/api/veg/file/nope/shapes.bin')).status === 404);
  ok('result of an unknown job: 404; bad id: 400', (await call('GET', '/api/veg/result?id=nope')).status === 404 && (await call('GET', '/api/veg/result?id=../x')).status === 400);
  ok('status of an unknown job: 404', (await call('GET', '/api/veg/status/nope')).status === 404);

  // Keep / saved / delete
  r = await call('POST', '/api/veg/keep', { id: 'nope', name: 'x' });
  ok('keep an unknown id: 404; a bad id: 400', r.status === 404 && (await call('POST', '/api/veg/keep', { id: '../x', name: 'x' })).status === 400);
  r = await call('POST', '/api/veg/keep', { id, name: '  Cave Ridge, first try  ', project: 'p1' });
  ok('keep: a new id and the name', r.json.ok && /^v[a-z0-9]+$/.test(r.json.id) && r.json.name === 'Cave Ridge, first try', r.json);
  const sid = r.json.id;
  await new Promise(r => setTimeout(r, 10));
  r = await call('POST', '/api/veg/keep', { id, name: '', project: '' });
  const sid2 = r.json.id;
  ok('keep with no name: a default name', r.json.ok && r.json.name === 'Vegetation shapes', r.json);
  ok('keep: bad project id is refused', (await call('POST', '/api/veg/keep', { id, name: 'a', project: '../p' })).status === 400);
  r = await call('GET', '/api/veg/saved?project=p1');
  ok('saved (project p1): both (the second has no project), newest first, with a summary', r.json.ok && r.json.saved.length === 2 && r.json.saved[0].id === sid2 && r.json.saved[1].project === 'p1'
    && r.json.saved[1].veg.shapes.trees === 2 && r.json.saved[1].veg.shell.triangles === 1 && r.json.saved[1].veg.shapes.bytes === 96, r.json);
  ok('saved (another project): only the one kept with no project', (await call('GET', '/api/veg/saved?project=p2')).json.saved.map(x => x.id).join() === sid2);
  ok('saved (no project given): all', (await call('GET', '/api/veg/saved')).json.saved.length === 2);
  ok('a saved id serves its files and result', (await call('GET', '/api/veg/file/' + sid + '/shapes.bin')).len === 96 && (await call('GET', '/api/veg/result?id=' + sid)).json.base === '/api/veg/file/' + sid + '/');
  // pruning must not touch saved sets
  fs.rmSync(path.join(tmp, 'jobs', 'veg', id), { recursive: true, force: true });
  ok('a saved set outlives its job folder', (await call('GET', '/api/veg/file/' + sid + '/veg.json')).status === 200);
  ok('delete: a bad id is 400, a job id (not saved) is 404', (await call('POST', '/api/veg/delete', { id: '../x' })).status === 400 && (await call('POST', '/api/veg/delete', { id })).status === 404);
  r = await call('POST', '/api/veg/delete', { id: sid });
  ok('delete: a saved set goes', r.json.ok && (await call('GET', '/api/veg/file/' + sid + '/veg.json')).status === 404 && (await call('GET', '/api/veg/saved')).json.saved.length === 1);
  // Errors
  r = await call('POST', '/api/veg/build', { params: Object.assign({}, good, { source: { ept: 'http://localhost:1/fail/ept.json' } }) });
  let s = await finish(r.json.jobId);
  ok('a "! " line is the error', s && s.status === 'error' && /cannot read the point cloud/.test(s.error), s);
  ok('result of the failed job: 404 with the reason', (await call('GET', '/api/veg/result?id=' + r.json.jobId)).json.error.includes('cannot read'));
  ok('the failed job is listed as an error in the Jobs list', jobsApi.list().find(j => j.id === 'veg.' + r.json.jobId).status === 'error');
  r = await call('POST', '/api/veg/build', { params: Object.assign({}, good, { source: { ept: 'http://localhost:1/crash/ept.json' } }) });
  s = await finish(r.json.jobId);
  ok('a Python crash gives the last line of the traceback', s && s.status === 'error' && /boom/.test(s.error), s);
  ok('the Jobs log has the output', /\[1\/3\] reading/.test((await call('GET', '/api/jobs/veg.' + id + '/log')).text));
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
