// route_api.js (the server side of 🔬 Analyze → Surface route): the params the script gets are rebuilt from what is allowed,
// a job runs a script with --params/--out, `! ` lines become the error, a re-run links the earlier grids/, files are served
// from a whitelist, and the Jobs panel's list (jobs_api.js) knows the "route" kind. The script here is a tiny stand-in written
// to a temp folder. Run: node tools/test_route_api.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 400) : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-route-'));
const script = path.join(tmp, 'stub.py');
fs.writeFileSync(script, `
import json, os, sys, argparse
ap = argparse.ArgumentParser(); ap.add_argument('--params'); ap.add_argument('--out'); a = ap.parse_args()
P = json.load(open(a.params)); os.makedirs(a.out + '/grids', exist_ok=True)
print('[1/2] reading')
if 'fail' in P['source']['ept']:
    print('! cannot read the point cloud'); sys.exit(1)
if 'crash' in P['source']['ept']:
    raise RuntimeError('boom')
reused = os.path.exists(a.out + '/grids/grid.json')
if not reused: open(a.out + '/grids/grid.json', 'w').write('{"nx": 2}'); open(a.out + '/grids/brush.png', 'wb').write(b'\\x89PNG')
open(a.out + '/routes.geojson', 'w').write(json.dumps({'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [[-100.5678, 45.1234, 1]] * 2}, 'properties': {'id': 'a', 'option': 'recommended', 'reused': reused}}]}))
open(a.out + '/summary.json', 'w').write(json.dumps({'cell': 1, 'grid_reused': reused}))
print('[2/2] done')
`);
const routeApi = require('../route_api')({ python: 'python3', script, outRoot: path.join(tmp, 'jobs', 'route') });
const jobsApi = require('../jobs_api')({ sources: { route: { jobs: routeApi.jobs, pct: routeApi.pctOf } } });

const good = { source: { ept: 'http://localhost:1/x/ept.json', ept_also: ['http://localhost:1/y/ept.json', 'file:///etc/passwd', 5] }, end: [-100.5678, 45.1234], starts: [[-100.57, 45.12], [200, 0], 'x'],
  cell: 1, dem: 'weird', brush_band: [2, 1], weights: { distance: 99, steep: -3, brush: 'a', cliff: 5, sun: -7, trail: 0.4 },
  trails: { type: 'FeatureCollection', features: [
    { geometry: { type: 'LineString', coordinates: [[-100.57, 45.12], [-100.569, 45.121]] }, properties: { kind: 'road', name: 'Cave Ridge Rd' } },
    { geometry: { type: 'LineString', coordinates: [[1, 2]] }, properties: {} }, { geometry: { type: 'Point', coordinates: [1, 2] } }, null ] },
  corridor_m: 99999, presets: ['shortest', 'bogus'], units: 'ft', evil: 'x' };
const c = routeApi.clean(good).params;
ok('clean: source is an EPT url, others kept only when http(s)', c.source.ept === good.source.ept.toString() && c.source.ept_also.length === 1 && !('las' in c.source), c.source);
ok('clean: starts with bad coordinates dropped', c.starts.length === 1, c.starts);
ok('clean: weights clamped, strings back to defaults', c.weights.distance === 10 && c.weights.steep === 0 && c.weights.brush === 1 && c.weights.cliff === 1 && c.weights.sun === -1 && c.weights.trail === 0.4 && c.weights.road === 1, c.weights);
ok('clean: dem and band repaired', c.dem === 'below' && c.brush_band[0] === 0.5 && c.brush_band[1] === 2, [c.dem, c.brush_band]);
ok('clean: only real lines kept as trail/road, name cut', c.trails.features.length === 1 && c.trails.features[0].properties.kind === 'road', c.trails);
ok('clean: corridor capped, presets filtered, units, nothing extra', c.corridor_m === 5000 && c.presets.join() === 'shortest' && c.units === 'ft' && !('evil' in c), c);
ok('clean: no source / end / starts are errors', !!routeApi.clean({ end: [1, 1], starts: [[1, 1]] }).error && !!routeApi.clean({ source: good.source, starts: [[1, 1]] }).error && !!routeApi.clean(Object.assign({}, good, { starts: [] })).error);
ok('clean: a local path is not a source', !!routeApi.clean(Object.assign({}, good, { source: { las: ['/tmp/a.laz'] } })).error);

const sl = routeApi.clean(Object.assign({}, good, { starts: [], start_lines: { features: [{ geometry: { type: 'LineString', coordinates: [[-100.57, 45.12], [-100.569, 45.121]] }, properties: { kind: 'road', name: 'Cave Ridge Rd' } }, { geometry: { type: 'LineString', coordinates: [[1, 99]] } }] } }));
ok('clean: start_lines alone are enough (no point start), kept as road/trail lines', sl.params && sl.params.starts.length === 0 && sl.params.start_lines.features.length === 1 && sl.params.start_lines.features[0].properties.kind === 'road', sl);
ok('clean: no start_lines key when there are none', !('start_lines' in c));

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  if (p.startsWith('/api/route/')) return routeApi.handle(req, res, p.slice('/api/route/'.length), Object.fromEntries(u.searchParams));
  if (p === '/api/jobs' || p.startsWith('/api/jobs/')) { if (!jobsApi.handle(req, res, p.slice('/api/jobs'.length).replace(/^\//, ''))) { res.writeHead(404); res.end(); } return; }
  res.writeHead(404); res.end();
});
const call = (method, p, body) => new Promise(r => { const q = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method, headers: { 'Content-Type': 'application/json' } }, x => { const b = []; x.on('data', d => b.push(d)); x.on('end', () => { const s = Buffer.concat(b).toString(); let j = null; try { j = JSON.parse(s); } catch (_) {} r({ status: x.statusCode, json: j, text: s, type: x.headers['content-type'] }); }); }); q.end(body ? JSON.stringify(body) : undefined); });
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  let r = await call('POST', '/api/route/plan', { params: { end: [1, 1] } });
  ok('plan without a source: 400 with a plain message', r.status === 400 && /LiDAR/.test(r.json.error), r.json);
  r = await call('POST', '/api/route/plan', { project: '../x', params: good });
  ok('plan with a bad project id: 400', r.status === 400, r.json);
  r = await call('POST', '/api/route/plan', { project: 'p1', params: good });
  ok('plan: a job id', r.status === 200 && r.json.ok && /^[a-z0-9]+$/.test(r.json.jobId), r.json);
  const id = r.json.jobId;
  ok('the Jobs list has it as route.<id>', jobsApi.list().some(j => j.id === 'route.' + id && j.kind === 'route'));
  const st = await until(async () => { const s = await call('GET', '/api/route/status/' + id); return s.json.status !== 'running' ? s.json : null; });
  ok('the job finishes', st && st.status === 'done', st);
  ok('params.json in the job folder is the cleaned one', JSON.parse(fs.readFileSync(path.join(tmp, 'jobs', 'route', id, 'params.json'), 'utf8')).weights.distance === 10);
  r = await call('GET', '/api/route/result?id=' + id);
  ok('result: routes, summary, grid, images, base', r.json.ok && r.json.routes.features.length === 1 && r.json.summary.cell === 1 && r.json.grid.nx === 2 && r.json.images.join() === 'brush' && r.json.base === '/api/route/file/' + id + '/', r.json);
  ok('result: first run did not reuse', r.json.routes.features[0].properties.reused === false);
  r = await call('GET', '/api/route/file/' + id + '/grids/brush.png');
  ok('file: a PNG is served as image/png', r.status === 200 && r.type === 'image/png', [r.status, r.type]);
  r = await call('GET', '/api/route/file/' + id + '/routes.geojson');
  ok('file: routes.geojson', r.status === 200 && r.json.type === 'FeatureCollection');
  ok('file: params.json and traversal are refused', (await call('GET', '/api/route/file/' + id + '/params.json')).status === 404 && (await call('GET', '/api/route/file/' + id + '/..%2F..%2Fx')).status === 404 && (await call('GET', '/api/route/file/..%2F/routes.geojson')).status === 404);
  r = await call('GET', '/api/route/result?id=nope');
  ok('result of an unknown job: 404', r.status === 404);
  // Re-run: grids linked from the earlier job
  r = await call('POST', '/api/route/plan', { project: 'p1', params: good, reuse: id });
  ok('reuse: the server linked the grids', r.json.ok && r.json.reused === true, r.json);
  const id2 = r.json.jobId;
  await until(async () => (await call('GET', '/api/route/status/' + id2)).json.status !== 'running');
  r = await call('GET', '/api/route/result?id=' + id2);
  ok('reuse: the script saw grids/ (reused = true)', r.json.ok && r.json.routes.features[0].properties.reused === true && r.json.summary.grid_reused === true, r.json);
  r = await call('POST', '/api/route/plan', { params: good, reuse: '../../etc' });
  ok('reuse of a bad id is ignored, not fatal', r.json.ok && r.json.reused === false, r.json);
  // Errors
  r = await call('POST', '/api/route/plan', { params: Object.assign({}, good, { source: { ept: 'http://localhost:1/fail/ept.json' } }) });
  let s = await until(async () => { const x = await call('GET', '/api/route/status/' + r.json.jobId); return x.json.status !== 'running' ? x.json : null; });
  ok('a "! " line is the error', s && s.status === 'error' && /cannot read the point cloud/.test(s.error), s);
  ok('the failed job is listed as an error in the Jobs panel list', jobsApi.list().find(j => j.id === 'route.' + r.json.jobId).status === 'error');
  r = await call('POST', '/api/route/plan', { params: Object.assign({}, good, { source: { ept: 'http://localhost:1/crash/ept.json' } }) });
  s = await until(async () => { const x = await call('GET', '/api/route/status/' + r.json.jobId); return x.json.status !== 'running' ? x.json : null; });
  ok('a Python crash gives the last line of the traceback', s && s.status === 'error' && /boom/.test(s.error), s);
  r = await call('GET', '/api/jobs/route.' + id + '/log');
  ok('the Jobs log has the output', r.status === 200 && /\[1\/2\] reading/.test(r.text), r.text);
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
