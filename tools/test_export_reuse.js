// An export that reuses a processed area's results instead of reading the LiDAR again (areas_api.js reuse(), and the
// arguments server.js hands the export job). No PDAL, no network: made-up area folders, and the real server started
// on a spare port with a stand-in for python that records its arguments.
//   * reuse(): only for the same outline (whatever corner it starts at, either way round, open or closed) and the same
//     point cloud; a result from before FLEX kept what it was made from; missing files; old shapes format;
//   * the job: --area-dir / --ridgewalk-dir / --trees-dir in place of a new read, and a line in the log for each
//     product saying whether it was reused or is made now, and why.
//   node tools/test_export_reuse.js
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), { spawn } = require('child_process');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + (typeof i === 'string' ? i : JSON.stringify(i)).slice(0, 900) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-'));
const ROOT = path.join(tmp, 'areas'); fs.mkdirSync(ROOT, { recursive: true });
const LON = -100.5678, LAT = 45.1234, EPT = 'http://localhost:1/made-up/Cave_Ridge/ept.json', EPT2 = 'http://localhost:1/made-up/Other/ept.json';
const RING = [[LON - 0.002, LAT - 0.001], [LON + 0.002, LAT - 0.001], [LON + 0.002, LAT + 0.001], [LON - 0.001, LAT + 0.0015], [LON - 0.002, LAT - 0.001]];   // closed, five corners... four and the first again
const rk = r => r.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';');
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
// an area with everything made, the way a run leaves it
function area(id, over) {
  const D = path.join(ROOT, id), date = '2026-11-20T10:00:00.000Z';
  const a = Object.assign({ id, name: 'Cave Ridge north', ring: RING, km2: 0.07, project: 'p1', created: date, updated: date, lidar: [EPT],
    results: { ground: { cell: 0.5, cellReq: 'auto', ringKey: rk(RING), date }, ridge: { cell: 0.3, ringKey: rk(RING), lidar: [EPT], date, counts: {} }, veg: { ringKey: rk(RING), lidar: [EPT], date, summary: {} } } }, over || {});
  put(path.join(D, 'area.json'), JSON.stringify(a));
  put(path.join(D, 'ground', 'grid.json'), '{}'); put(path.join(D, 'ground', 'ground.npy'), 'x');
  const lons = RING.map(p => p[0]), lats = RING.map(p => p[1]);
  put(path.join(D, 'ridge', 'ridge.json'), JSON.stringify({ version: 1, bbox_lonlat: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)], cell: 0.3 }));
  for (const f of ['lid.npy', 'holes.npy', 'points.bin', 'shapes.bin', 'brush.npy', 'brush.json']) put(path.join(D, 'ridge', f), 'x');
  put(path.join(D, 'veg', 'veg.json'), JSON.stringify({ shapes: { record: 48, trees: 3 }, area: RING })); put(path.join(D, 'veg', 'shapes.bin'), 'x');
  return D;
}
const api = require('../areas_api')({ python: 'python3', root: ROOT, terrainGen: null });
const OPEN = RING.slice(0, -1);

(async () => {
  // ── 1. reuse(): the decisions ───────────────────────────────────────────────
  const D = area('a1');
  let r = api.reuse('a1', { ring: OPEN, lidar: EPT });
  ok('everything made for this outline and point cloud: all three are offered, each with its folder and date', r.ok && r.area.name === 'Cave Ridge north' && r.ground.dir === D && r.ridge.dir === path.join(D, 'ridge') && r.trees.dir === path.join(D, 'veg')
     && r.ridge.shapes === true && r.ridge.brush === true && r.ground.date === '2026-11-20T10:00:00.000Z', r);
  ok('the same outline closed, started at another corner, or the other way round, is the same outline', ['ground', 'ridge', 'trees'].every(k => api.reuse('a1', { ring: RING, lidar: [EPT] })[k].dir
     && api.reuse('a1', { ring: OPEN.slice(2).concat(OPEN.slice(0, 2)), lidar: EPT })[k].dir && api.reuse('a1', { ring: OPEN.slice().reverse(), lidar: EPT })[k].dir));
  r = api.reuse('a1', { ring: OPEN.map((p, i) => i === 2 ? [p[0] + 0.0001, p[1]] : p), lidar: EPT });
  ok('another outline: nothing is reused, and it says why', r.ok && !r.ground.dir && !r.ridge.dir && !r.trees.dir && /not the saved area/.test(r.ground.why), r);
  ok('a box that is not this area', !api.reuse('a1', { ring: [[LON - 0.002, LAT - 0.001], [LON + 0.002, LAT - 0.001], [LON + 0.002, LAT + 0.001], [LON - 0.002, LAT + 0.001]], lidar: EPT }).ridge.dir);
  r = api.reuse('a1', { ring: OPEN, lidar: EPT2 });
  ok('another point cloud: nothing is reused', !r.ground.dir && !r.ridge.dir && !r.trees.dir && /another point cloud/.test(r.ridge.why) && /another point cloud/.test(r.ground.why), r);
  ok('an area that is not on this computer, or a bad id', api.reuse('nope', { ring: OPEN, lidar: EPT }).ok === false && api.reuse('../a1', { ring: OPEN, lidar: EPT }).ok === false);
  // the outline was changed after the results were made
  area('a2', { results: { ground: { cellReq: 'auto', ringKey: 'old', date: 'x' }, ridge: { ringKey: 'old', lidar: [EPT] }, veg: { ringKey: 'old', lidar: [EPT] } } });
  r = api.reuse('a2', { ring: OPEN, lidar: EPT });
  ok('results made for an earlier outline of the area are out of date: not reused', !r.ground.dir && !r.ridge.dir && !r.trees.dir && /out of date/.test(r.ridge.why), r);
  // only some things made
  area('a3', { results: { ground: { cellReq: 'auto', ringKey: rk(RING), date: 'd' } } });
  r = api.reuse('a3', { ring: OPEN, lidar: EPT });
  ok('only the ground made: the ground is offered, the others say "not made yet"', r.ground.dir && /not made yet/.test(r.ridge.why) && /not made yet/.test(r.trees.why), r);
  // results from before the stamp
  area('a4', { results: { ground: { cellReq: 'auto', ringKey: rk(RING) }, ridge: { cell: 0.3, date: 'd' }, veg: { date: 'd' } } });
  r = api.reuse('a4', { ring: OPEN, lidar: EPT });
  ok('results from before FLEX kept what they were made from: taken when their own files say they cover this area', r.ridge.dir && r.trees.dir, r);
  put(path.join(ROOT, 'a4', 'ridge', 'ridge.json'), JSON.stringify({ bbox_lonlat: [0, 0, 1, 1] })); put(path.join(ROOT, 'a4', 'veg', 'veg.json'), JSON.stringify({ shapes: { record: 48 } }));
  r = api.reuse('a4', { ring: OPEN, lidar: EPT });
  ok('…and not when they do not say', !r.ridge.dir && !r.trees.dir && /run it once more/.test(r.ridge.why), r);
  // files
  const D5 = area('a5'); fs.rmSync(path.join(D5, 'ridge', 'lid.npy')); put(path.join(D5, 'veg', 'veg.json'), JSON.stringify({ shapes: { record: 32 }, area: RING })); fs.rmSync(path.join(D5, 'ground', 'ground.npy'));
  r = api.reuse('a5', { ring: OPEN, lidar: EPT });
  ok('an imported area (no ground grids of the ridgewalking), old shapes, a missing ground file: each says so', /not on this computer/.test(r.ridge.why) && /old format/.test(r.trees.why) && /files are gone/.test(r.ground.why), r);
  const D6 = area('a6'); fs.rmSync(path.join(D6, 'ridge', 'shapes.bin'));
  ok('a ridgewalking result made without shapes says so', api.reuse('a6', { ring: OPEN, lidar: EPT }).ridge.shapes === false);

  // ── 2. the export job's arguments and its log ───────────────────────────────
  const root = path.join(__dirname, '..'), argsFile = path.join(tmp, 'args.txt'), stub = path.join(tmp, 'fake_python.sh'), port = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "' + argsFile + '"\necho "=====" >> "' + argsFile + '"\necho "[1/7] started"\nsleep 1\nexit 1\n'); fs.chmodSync(stub, 0o755);
  if (process.platform === 'win32' || !fs.existsSync(path.join(root, 'node_modules'))) { console.log('(the server part needs node_modules and a shell: skipped)'); }
  else {
    const srv = spawn(process.execPath, ['-e', `require('./settings.js').server.port = ${port}; require('./server.js');`], { cwd: root, env: Object.assign({}, process.env, { FLEX_PYTHON: stub, FLEX_AREAS_DIR: ROOT, FLEX_ADB: 'off' }), stdio: 'ignore' });
    const req = (method, p, body) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: body ? { 'Content-Type': 'application/json' } : {} }, m => { let d = ''; m.on('data', c => d += c); m.on('end', () => res(d)); }); q.on('error', rej); if (body) q.write(JSON.stringify(body)); q.end(); });
    try {
      let up = false; for (let k = 0; k < 80 && !up; k++) { await sleep(250); up = await req('GET', '/api/jobs').then(() => true, () => false); }
      ok('the server is up', up);
      const lons = OPEN.map(p => p[0]), lats = OPEN.map(p => p[1]), bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
      const post = async x => JSON.parse(await req('POST', '/api/export/terrain', Object.assign({ bbox, polygon: OPEN, eptPath: EPT, name: 'Cave Ridge', caves: { surveys: [] } }, x)));
      const log = async id => req('GET', '/api/jobs/export.' + id + '/log');
      const jobs = [];
      jobs.push(await post({ area: 'a1', ridgewalk: true, trees: true }));                                   // 0 everything reused
      jobs.push(await post({ area: 'a1', trees: true }));                                                    // 1 no ridgewalking: the area's ground
      jobs.push(await post({ area: 'a1', ridgewalk: true, trees: true, eptPath: EPT2 }));                    // 2 another cloud
      jobs.push(await post({ area: 'a3', ridgewalk: true, trees: true }));                                   // 3 only ground made
      jobs.push(await post({ ridgewalk: true, trees: true }));                                               // 4 no area named
      jobs.push(await post({ area: 'a1', ridgewalk: true, trees: true, polygon: null, bbox }));               // 5 the box, not the outline
      jobs.push(await post({ area: 'a6', ridgewalk: true }));                                                // 6 the area's ridgewalking has no shapes, shapes wanted
      jobs.push(await post({ area: 'a6', ridgewalk: true, ridge_shapes: 'none' }));                          // 7 … shapes not wanted
      jobs.push(await post({ area: '../a1', ridgewalk: true }));                                             // 8 not an id
      jobs.push(await post({ area: 'gone99', trees: true }));                                                // 9 an area that is not there
      await sleep(2500);
      const runs = fs.readFileSync(argsFile, 'utf8').split('=====\n').filter(Boolean).map(s => s.trim().split('\n'));
      const after = (r, k) => r.includes(k) ? r[r.indexOf(k) + 1] : undefined, logs = [];
      for (const j of jobs) logs.push(await log(j.jobId));
      ok('ten jobs', runs.length === 10 && jobs.every(j => j.ok), [runs.length, jobs.filter(j => !j.ok)]);
      ok('everything reused: --ridgewalk-dir and --trees-dir in place of --ridgewalk and --trees; the LiDAR is still named', after(runs[0], '--ridgewalk-dir') === path.join(ROOT, 'a1', 'ridge') && after(runs[0], '--trees-dir') === path.join(ROOT, 'a1', 'veg')
         && !runs[0].includes('--ridgewalk') && !runs[0].includes('--trees') && !runs[0].includes('--area-dir') && after(runs[0], '--ept') === EPT, runs[0]);
      ok('…and the log says so for each', /Ridgewalking: reused from the area “Cave Ridge north” \(made 2026-11-20 10:00\)/.test(logs[0]) && /Trees and brush: reused from the area “Cave Ridge north”/.test(logs[0]) && !/Ground:/.test(logs[0]), logs[0]);
      ok('without ridgewalking: the area\'s ground (--area-dir) and its trees', after(runs[1], '--area-dir') === path.join(ROOT, 'a1') && after(runs[1], '--trees-dir') === path.join(ROOT, 'a1', 'veg') && !runs[1].includes('--ridgewalk-dir') && /Ground: reused from the area/.test(logs[1]), [runs[1], logs[1]]);
      ok('another point cloud: all made now, and the log says why', runs[2].includes('--ridgewalk') && runs[2].includes('--trees') && !runs[2].some(a => /-dir$/.test(a)) && /Ridgewalking: made now \(made from another point cloud\)/.test(logs[2]) && /Trees and brush: made now \(made from another point cloud\)/.test(logs[2]), [runs[2], logs[2]]);
      ok('an area with only its ground: ridgewalking and trees are made now ("not made yet")', runs[3].includes('--ridgewalk') && runs[3].includes('--trees') && !runs[3].includes('--area-dir') && /Ridgewalking: made now \(not made yet for this area\)/.test(logs[3]), [runs[3], logs[3]]);
      ok('no area named: as always, and the log does not speak of reuse', runs[4].includes('--ridgewalk') && runs[4].includes('--trees') && !/reused|made now|Area:/.test(logs[4]), logs[4]);
      ok('the area\'s box instead of its outline: made now', runs[5].includes('--ridgewalk') && !runs[5].includes('--ridgewalk-dir') && /not the saved area/.test(logs[5]), logs[5]);
      ok('shapes wanted but the area\'s ridgewalking has none: made now; shapes not wanted: reused', runs[6].includes('--ridgewalk') && /made now/.test(logs[6]) && after(runs[7], '--ridgewalk-dir') === path.join(ROOT, 'a6', 'ridge') && after(runs[7], '--ridge-shapes') === 'none', [runs[6], runs[7]]);
      ok('something that is not an id is ignored; an area that is not there: nothing reused, said once', runs[8].includes('--ridgewalk') && !/Area:/.test(logs[8]) && runs[9].includes('--trees') && /Area: nothing reused \(the area is not on this computer\)/.test(logs[9]), [logs[8], logs[9]]);
      ok('no path is taken from the request: the folders are the server\'s own', runs.every(r => r.filter((a, i) => /-dir$/.test(r[i - 1] || '')).every(a => a.startsWith(ROOT))));
    } finally { srv.kill(); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
