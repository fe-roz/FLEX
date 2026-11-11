// veg_api.js — vegetation shapes (/api/veg/*): the server half of the 🔬 Analyze → Vegetation shapes section
// (client/src/modules/veg-panel.js). It runs veg_shapes.py, which reads the LiDAR of an area and makes LIGHT shapes of the
// vegetation: one crown per tree plus brush mounds ("shapes"), and a blobby skin round the vegetation points ("shell").
//
//   POST /api/veg/build      { project?, params } → { ok, jobId }
//                            params: source.ept (+ ept_also), area (ring of [lon, lat]), looks, detail, min_height, brush_top, max_triangles
//   GET  /api/veg/status/<jobId>      { ok, status, progress, message, error }
//   GET  /api/veg/result?id=<id>      { ok, id, veg (= veg.json), base: "/api/veg/file/<id>/", sizes, params }   (a job or a saved set)
//   GET  /api/veg/file/<id>/<name>    veg.json | shapes.bin | shell.bin | ground.bin | preview.png   (a job or a saved set)
//   POST /api/veg/keep       { id, name, project? } → { ok, id, name }   copies a finished job to user_files/veg/<newId>/ (survives pruning)
//   GET  /api/veg/saved?project=<id>  → { ok, saved: [{ id, name, project, date, veg: summary }] }   (given a project: its sets and the
//                                       ones kept without a project; no project: all of them)
//   POST /api/veg/delete     { id }   a saved set
//
// The job runs `python veg_shapes.py --params p.json --out <dir>` in user_files/jobs/veg/<jobId>/. Progress lines go to the job
// (the Jobs panel, jobs_api.js); a line starting "! " is an error and the reason shown if it fails. FLEX_VEG_SCRIPT /
// FLEX_VEG_PYTHON (server.js) point at another script / interpreter (the tests' stand-in). Only an EPT url is accepted as the
// source (never a path on this computer); everything else is rebuilt here from allowed numbers and words.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const FILE_RE = /^(veg\.json|shapes\.bin|shell\.bin|ground\.bin|preview\.png)$/;
const FILES = ['veg.json', 'shapes.bin', 'shell.bin', 'ground.bin', 'preview.png'];
const LOOKS = ['shapes', 'shell'], DETAILS = ['low', 'medium', 'high'];
const KEEP_DIRS = 12, MAX_RING = 3000, MAX_KM2 = 25;

module.exports = function vegApi({ python, script, outRoot, savedRoot }) {
  const jobs = {};
  const json = (res, d, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(d)); };
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const clampN = (v, lo, hi, d) => (num(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const lonlat = p => Array.isArray(p) && p.length >= 2 && num(p[0]) && num(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) { no(new Error('too big')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', no); });
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
  /** Area of a [lon, lat] ring in km² (flat, local scale). */
  function ringKm2(ring) {
    const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    let s = 0;
    ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; s += p[0] * kx * q[1] * ky - q[0] * kx * p[1] * ky; });
    return Math.abs(s) / 2 / 1e6;
  }

  /** The params the script gets, rebuilt from what is allowed → { params } or { error }. */
  function clean(p) {
    if (!p || typeof p !== 'object') return { error: 'no parameters' };
    const src = p.source || {};
    const url = u => (typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 2000 ? u : null);
    const ept = url(src.ept);
    if (!ept) return { error: 'choose the LiDAR to use (a point cloud loaded or in the project)' };
    const also = (Array.isArray(src.ept_also) ? src.ept_also : []).map(url).filter(Boolean).slice(0, 5);
    let ring = Array.isArray(p.area) ? p.area.filter(lonlat).map(c => [+c[0], +c[1]]) : [];
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();   // closed or open: open here
    if (ring.length < 3) return { error: 'choose the area to build (draw it or pick a footprint)' };
    if (ring.length > MAX_RING) return { error: 'the area has too many corners' };
    const km2 = ringKm2(ring);
    if (!(km2 > 0)) return { error: 'the area has no size' };
    if (km2 > MAX_KM2) return { error: `the area is ${km2.toFixed(1)} km², more than the ${MAX_KM2} km² this can build at once: choose a smaller one` };
    const looks = (Array.isArray(p.looks) ? p.looks : LOOKS).filter((x, i, a) => LOOKS.includes(x) && a.indexOf(x) === i);
    const minH = clampN(p.min_height, 0, 20, 0.5);
    let top = clampN(p.brush_top, 0.2, 50, 2);
    if (!(top > minH)) top = Math.min(50, minH + 1.5);
    const params = {
      source: Object.assign({ ept }, also.length ? { ept_also: also } : {}),
      area: ring.concat([ring[0]]),
      looks: looks.length ? looks : LOOKS.slice(),
      detail: DETAILS.includes(p.detail) ? p.detail : 'medium',
      min_height: minH, brush_top: top,
      max_triangles: Math.round(clampN(p.max_triangles, 20000, 1000000, 300000)),
    };
    return { params };
  }

  /** The newest few job folders stay; older ones go. */
  function prune(keep) {
    let names = [];
    try { names = fs.readdirSync(outRoot).filter(n => ID_RE.test(n)); } catch (_) { return; }
    const info = names.map(n => { let t = 0; try { t = fs.statSync(path.join(outRoot, n)).mtimeMs; } catch (_) {} return { n, t }; }).sort((a, b) => b.t - a.t);
    info.slice(KEEP_DIRS).forEach(x => {
      if (x.n === keep || (jobs[x.n] && jobs[x.n].status === 'running')) return;
      try { fs.rmSync(path.join(outRoot, x.n), { recursive: true, force: true }); } catch (_) {}
    });
  }

  async function build(req, res) {
    let o;
    try { o = JSON.parse(await body(req)); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const c = clean(o.params);
    if (c.error) return json(res, { ok: false, error: c.error }, 400);
    const project = o.project == null || o.project === '' ? '' : String(o.project);
    if (project && !ID_RE.test(project)) return json(res, { ok: false, error: 'bad project id' }, 400);
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const outDir = path.join(outRoot, jobId);
    fs.mkdirSync(outDir, { recursive: true });
    const paramsFile = path.join(outDir, 'params.json');
    fs.writeFileSync(paramsFile, JSON.stringify(c.params));
    const job = jobs[jobId] = { status: 'running', progress: [], outDir, project, name: 'Vegetation shapes', label: 'Vegetation shapes', error: null, errLines: [],
      started: Date.now(), ended: null, cancelled: false, proc: null };
    json(res, { ok: true, jobId });
    setTimeout(() => prune(jobId), 50);

    let proc;
    try { proc = spawn(python, [script, '--params', paramsFile, '--out', outDir], { cwd: path.dirname(script), env: Object.assign({}, process.env, { FLEX_APP_DIR: __dirname }) }); }
    catch (e) { job.status = 'error'; job.error = 'could not start Python: ' + e.message; job.ended = Date.now(); return; }
    job.proc = proc;
    const take = err => d => d.toString().split('\n').forEach(l => {
      l = l.replace(/\r$/, '').trimEnd(); if (!l.trim()) return;
      if (err) { job.progress.push('! ' + l.trim()); job.errLines.push(l); } else { job.progress.push(l.trim()); if (/^!\s/.test(l)) job.errLines.push(l.replace(/^!\s*/, '')); }
      console.log('[veg]', l.trim());
    });
    proc.stdout.on('data', take(false));
    proc.stderr.on('data', take(true));
    proc.on('error', e => { job.errLines.push(`could not run ${python} (${e.code || e.message}): set FLEX_PYTHON to the Python that has PDAL`); });
    proc.on('close', code => {
      job.proc = null; job.ended = Date.now();
      const ok = code === 0 && fs.existsSync(path.join(outDir, 'veg.json')) && !job.cancelled;
      job.status = ok ? 'done' : 'error';
      try { fs.writeFileSync(path.join(outDir, 'log.txt'), job.progress.join('\n') + '\n'); } catch (_) {}
      if (ok) return;
      if (job.cancelled) { job.error = 'Cancelled'; return; }
      const lines = job.errLines.filter(l => !/^\s*File "|^\s+\S/.test(l));
      const why = (lines.length ? lines : job.errLines).slice(-3).map(l => l.replace(/^!\s*/, '')).join(' | ');
      job.error = (why || 'The vegetation job wrote nothing') + ` (exit ${code})`;
    });
  }

  function pctOf(job) {
    if (job.status === 'done' || job.status === 'error') return 100;
    const last = job.progress.slice().reverse().find(l => /\[\d+\/\d+\]/.test(l));
    const m = last && /\[(\d+)\/(\d+)\]/.exec(last);
    if (m && +m[2] > 0) return Math.min(95, Math.max(5, Math.round(+m[1] / +m[2] * 90)));
    return Math.min(90, 5 + job.progress.length * 4);
  }
  function status(res, id) {
    const job = ID_RE.test(String(id || '')) && Object.prototype.hasOwnProperty.call(jobs, id) ? jobs[id] : null;
    if (!job) return json(res, { ok: false, error: 'Unknown job' }, 404);
    json(res, { ok: true, status: job.status, progress: pctOf(job), message: job.progress[job.progress.length - 1] || '', error: job.error, lines: job.progress.length });
  }

  /** Where the files of an id are: a finished/running job folder, else a saved set. */
  function dirOf(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    for (const d of [path.join(outRoot, id), path.join(savedRoot, id)]) { try { if (fs.statSync(d).isDirectory()) return d; } catch (_) {} }
    return null;
  }
  const sizesOf = dir => { const o = {}; for (const n of FILES) { try { o[n] = fs.statSync(path.join(dir, n)).size; } catch (_) {} } return o; };
  /** A short description of a result for the Saved list. */
  function summary(veg, sizes) {
    veg = veg || {};
    const sh = veg.shapes || null, sl = veg.shell || null;
    return { area_m2: veg.area_m2 || null,
      shapes: sh ? { count: sh.count, trees: sh.trees, brush: sh.brush, bytes: sizes['shapes.bin'] || 0 } : null,
      shell: sl ? { vertices: sl.vertices, triangles: sl.triangles, bytes: sizes['shell.bin'] || 0 } : null };
  }
  function result(res, id) {
    if (!ID_RE.test(String(id || ''))) return json(res, { ok: false, error: 'Bad id' }, 400);
    const job = Object.prototype.hasOwnProperty.call(jobs, id) ? jobs[id] : null;
    if (job && job.status === 'running') return json(res, { ok: false, error: 'Not ready' }, 409);
    const dir = dirOf(id), veg = dir && readJson(path.join(dir, 'veg.json'));
    if (!veg) return json(res, { ok: false, error: job && job.error ? job.error : 'Not found' }, 404);
    json(res, { ok: true, id, veg, base: '/api/veg/file/' + id + '/', sizes: sizesOf(dir), params: readJson(path.join(dir, 'params.json')) || veg.params || null });
  }
  function file(res, rest) {
    const i = rest.indexOf('/'), id = rest.slice(0, i), name = rest.slice(i + 1);
    const dir = i < 0 || !FILE_RE.test(name) ? null : dirOf(id);
    if (!dir) return json(res, { ok: false, error: 'Not found' }, 404);
    const f = path.join(dir, name);
    fs.stat(f, (err, st) => {
      if (err || !st.isFile()) return json(res, { ok: false, error: 'Not found' }, 404);
      const ext = path.extname(name);
      res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : ext === '.json' ? 'application/json' : 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
  }

  async function keep(req, res) {
    let o;
    try { o = JSON.parse(await body(req)); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const id = String(o.id || '');
    if (!ID_RE.test(id)) return json(res, { ok: false, error: 'bad id' }, 400);
    const job = Object.prototype.hasOwnProperty.call(jobs, id) ? jobs[id] : null;
    if (job && job.status === 'running') return json(res, { ok: false, error: 'Not ready' }, 409);
    const from = dirOf(id);
    if (!from || !fs.existsSync(path.join(from, 'veg.json'))) return json(res, { ok: false, error: 'Not found' }, 404);
    const project = o.project == null || o.project === '' ? '' : String(o.project);
    if (project && !ID_RE.test(project)) return json(res, { ok: false, error: 'bad project id' }, 400);
    const name = String(o.name == null ? '' : o.name).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) || 'Vegetation shapes';
    const newId = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const to = path.join(savedRoot, newId);
    fs.mkdirSync(to, { recursive: true });
    for (const n of FILES.concat(['params.json'])) { try { fs.copyFileSync(path.join(from, n), path.join(to, n)); } catch (_) {} }
    const veg = readJson(path.join(to, 'veg.json'));
    fs.writeFileSync(path.join(to, 'meta.json'), JSON.stringify({ id: newId, name, project, date: new Date().toISOString(), veg: summary(veg, sizesOf(to)) }));
    json(res, { ok: true, id: newId, name });
  }
  function saved(res, query) {
    const pr = query && query.project != null ? String(query.project) : '';
    let names = [];
    try { names = fs.readdirSync(savedRoot).filter(n => ID_RE.test(n)); } catch (_) {}
    const list = names.map(n => readJson(path.join(savedRoot, n, 'meta.json'))).filter(m => m && m.id && (!pr || !m.project || m.project === pr));
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    json(res, { ok: true, saved: list });
  }
  async function del(req, res) {
    let o;
    try { o = JSON.parse(await body(req)); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const id = String(o.id || '');
    if (!ID_RE.test(id)) return json(res, { ok: false, error: 'bad id' }, 400);
    const d = path.join(savedRoot, id);                      // saved sets only, never a job folder
    if (!fs.existsSync(path.join(d, 'meta.json'))) return json(res, { ok: false, error: 'Not found' }, 404);
    fs.rmSync(d, { recursive: true, force: true });
    json(res, { ok: true });
  }

  /** /api/veg/<rest> */
  function handle(req, res, rest, query) {
    const fail = e => json(res, { ok: false, error: e.message || String(e) }, 500);
    try {
      if (req.method === 'POST' && rest === 'build') return void build(req, res).catch(fail);
      if (req.method === 'POST' && rest === 'keep') return void keep(req, res).catch(fail);
      if (req.method === 'POST' && rest === 'delete') return void del(req, res).catch(fail);
      if (req.method === 'GET' && rest === 'result') return result(res, query && query.id);
      if (req.method === 'GET' && rest === 'saved') return saved(res, query);
      if (req.method === 'GET' && rest.startsWith('status/')) return status(res, rest.slice(7));
      if (req.method === 'GET' && rest.startsWith('file/')) return file(res, rest.slice(5));
      return json(res, { ok: false, error: 'not found' }, 404);
    } catch (e) { return fail(e); }
  }
  return { jobs, pctOf, handle, clean };
};
