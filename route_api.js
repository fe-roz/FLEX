// route_api.js — terrain-aware surface routes (/api/route/*): the server half of the 🔬 Analyze → Surface route section
// (client/src/modules/surface-route.js). It runs route_cost.py, which reads the LiDAR of the area, builds the cost grids
// (ground, slope, cliffs, brush, shade, trails) and searches the cheapest ways from each start to the end.
//
//   POST /api/route/plan     { project?, params, reuse? } → { ok, jobId }
//                            params: see route_cost.py (starts: points; start_lines: road/trail lines, every cell under them is a start). reuse: the id of an earlier job of the same
//                            area; its grids/ are linked into the new job, so a changed weight only re-runs the search.
//   GET  /api/route/status/<jobId>    { status, progress, message, error }
//   GET  /api/route/result?id=<jobId>  { ok, id, routes (GeoJSON), summary, grid, images: [names], base, params }
//   GET  /api/route/file/<jobId>/<name>  one output file (routes.geojson, summary.json, grids/<name>.png, grids/grid.json)
//
// The job runs `python route_cost.py --params p.json --out <dir>` in user_files/jobs/route/<jobId>/. Progress lines go to
// the job (the Jobs panel, jobs_api.js); a line starting "! " is an error and the reason shown if it fails. The script is
// FLEX_ROUTE_SCRIPT when set (the kit's tests point it at a stub); the interpreter is the one the other jobs use.
// Only an EPT url is accepted as the source (never a path on this computer). Everything else in params is rebuilt here
// from the numbers and words that are allowed, so a page can't hand the script anything odd.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const FILE_RE = /^(routes\.geojson|summary\.json|grids\/(grid\.json|brush\.png|slope\.png|shade\.png|ground_hs\.png|dem_diff\.png))$/;
const PRESETS = ['shortest', 'least_brush', 'shadiest', 'least_climb'];
const KEEP_DIRS = 12;

module.exports = function routeApi({ python, script, outRoot }) {
  const jobs = {};
  const json = (res, d, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(d)); };
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const clampN = (v, lo, hi, d) => (num(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const lonlat = p => Array.isArray(p) && p.length >= 2 && num(p[0]) && num(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 20e6) { no(new Error('too big')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', no); });

  /** The params the script gets, rebuilt from what is allowed → { params } or { error }. */
  function clean(p) {
    if (!p || typeof p !== 'object') return { error: 'no parameters' };
    const src = p.source || {};
    const url = u => (typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 2000 ? u : null);
    const ept = url(src.ept);
    if (!ept) return { error: 'choose the LiDAR to use (a point cloud loaded or in the project)' };
    const also = (Array.isArray(src.ept_also) ? src.ept_also : []).map(url).filter(Boolean).slice(0, 5);
    if (!lonlat(p.end)) return { error: 'choose the end of the route (a spot on the map)' };
    const starts = (Array.isArray(p.starts) ? p.starts : []).filter(lonlat).slice(0, 12).map(s => [+s[0], +s[1]]);
    const w = p.weights || {};
    const weights = { distance: clampN(w.distance, 0, 10, 1), steep: clampN(w.steep, 0, 10, 1), brush: clampN(w.brush, 0, 10, 1), cliff: clampN(w.cliff, 0, 1, 0.5),
      sun: clampN(w.sun, -1, 1, 0), trail: clampN(w.trail, 0, 1, 1), road: clampN(w.road, 0, 1, 1) };
    let band = Array.isArray(p.brush_band) && p.brush_band.length === 2 && p.brush_band.every(num) ? p.brush_band.slice() : [0.5, 2.0];
    band = [clampN(band[0], 0, 20, 0.5), clampN(band[1], 0, 50, 2)]; if (!(band[1] > band[0])) band = [0.5, 2.0];
    let verts = 0;
    const lineFC = fc => {
      const features = [];
      for (const f of (fc && Array.isArray(fc.features) ? fc.features : []).slice(0, 4000)) {
        const g = f && f.geometry; if (!g) continue;
        const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const ln of lines) {
          if (!Array.isArray(ln) || ln.length < 2 || !ln.every(lonlat)) continue;
          verts += ln.length; if (verts > 400000) break;
          const pr = f.properties || {};
          features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ln.map(c => [+c[0], +c[1]]) },
            properties: { kind: pr.kind === 'road' ? 'road' : 'trail', name: String(pr.name || '').slice(0, 120) } });
        }
      }
      return { type: 'FeatureCollection', features };
    };
    const trails = lineFC(p.trails), startLines = lineFC(p.start_lines);
    if (!starts.length && !startLines.features.length) return { error: 'choose at least one start' };
    const params = {
      source: Object.assign({ ept }, also.length ? { ept_also: also } : {}),
      end: [+p.end[0], +p.end[1]], starts,
      cell: p.cell === 'auto' || p.cell == null ? 'auto' : clampN(+p.cell, 0.1, 20, 'auto'),
      dem: ['below', 'above', 'both'].includes(p.dem) ? p.dem : 'below',
      brush_band: band, weights,
      trails,
      corridor_m: clampN(p.corridor_m, 50, 5000, 300),
      presets: (Array.isArray(p.presets) ? p.presets : PRESETS).filter(x => PRESETS.includes(x)),
      units: p.units === 'ft' ? 'ft' : 'm',
    };
    if (startLines.features.length) params.start_lines = startLines;       // every cell under these lines is a start
    return { params };
  }

  /** The newest few job folders stay; older ones go (grids can be large). */
  function prune(keep) {
    let names = [];
    try { names = fs.readdirSync(outRoot).filter(n => ID_RE.test(n)); } catch (_) { return; }
    const info = names.map(n => { let t = 0; try { t = fs.statSync(path.join(outRoot, n)).mtimeMs; } catch (_) {} return { n, t }; }).sort((a, b) => b.t - a.t);
    info.slice(KEEP_DIRS).forEach(x => {
      if (x.n === keep || (jobs[x.n] && jobs[x.n].status === 'running')) return;
      try { fs.rmSync(path.join(outRoot, x.n), { recursive: true, force: true }); } catch (_) {}
    });
  }
  /** grids/ of an earlier job → the new job's folder (hard links where the disk allows, else copies). */
  function reuseGrids(from, to) {
    const src = path.join(outRoot, from, 'grids'), dst = path.join(to, 'grids');
    if (!ID_RE.test(from) || !fs.existsSync(src)) return false;
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) {
      const a = path.join(src, n), b = path.join(dst, n);
      try { if (!fs.statSync(a).isFile()) continue; try { fs.linkSync(a, b); } catch (_) { fs.copyFileSync(a, b); } } catch (_) {}
    }
    return true;
  }

  async function plan(req, res) {
    let o;
    try { o = JSON.parse(await body(req)); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const c = clean(o.params);
    if (c.error) return json(res, { ok: false, error: c.error }, 400);
    const project = o.project == null || o.project === '' ? '' : String(o.project);
    if (project && !ID_RE.test(project)) return json(res, { ok: false, error: 'bad project id' }, 400);
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const outDir = path.join(outRoot, jobId);
    fs.mkdirSync(outDir, { recursive: true });
    const reused = o.reuse ? reuseGrids(String(o.reuse), outDir) : false;
    const paramsFile = path.join(outDir, 'params.json');
    fs.writeFileSync(paramsFile, JSON.stringify(c.params));
    const job = jobs[jobId] = { status: 'running', progress: reused ? ['Reusing the cost grids of the last run'] : [], outDir, project, name: 'Surface route', label: 'Surface route', error: null, errLines: [], reused,
      started: Date.now(), ended: null, cancelled: false, proc: null };
    json(res, { ok: true, jobId, reused });
    setTimeout(() => prune(jobId), 50);

    let proc;
    try { proc = spawn(python, [script, '--params', paramsFile, '--out', outDir], { cwd: path.dirname(script) }); }
    catch (e) { job.status = 'error'; job.error = 'could not start Python: ' + e.message; job.ended = Date.now(); return; }
    job.proc = proc;
    const take = err => d => d.toString().split('\n').forEach(l => {
      l = l.replace(/\r$/, '').trimEnd(); if (!l.trim()) return;
      if (err) { job.progress.push('! ' + l.trim()); job.errLines.push(l); } else { job.progress.push(l.trim()); if (/^!\s/.test(l)) job.errLines.push(l.replace(/^!\s*/, '')); }
      console.log('[route]', l.trim());
    });
    proc.stdout.on('data', take(false));
    proc.stderr.on('data', take(true));
    proc.on('error', e => { job.errLines.push(`could not run ${python} (${e.code || e.message}): set FLEX_PYTHON to the Python that has PDAL`); });
    proc.on('close', code => {
      job.proc = null; job.ended = Date.now();
      const ok = code === 0 && fs.existsSync(path.join(outDir, 'routes.geojson')) && !job.cancelled;
      job.status = ok ? 'done' : 'error';
      try { fs.writeFileSync(path.join(outDir, 'log.txt'), job.progress.join('\n') + '\n'); } catch (_) {}
      if (ok) return;
      if (job.cancelled) { job.error = 'Cancelled'; return; }
      const lines = job.errLines.filter(l => !/^\s*File "|^\s+\S/.test(l));
      const why = (lines.length ? lines : job.errLines).slice(-3).map(l => l.replace(/^!\s*/, '')).join(' | ');
      job.error = (why || 'The route search wrote nothing') + ` (exit ${code})`;
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
    const job = jobs[id];
    if (!job) return json(res, { ok: false, error: 'Unknown job' }, 404);
    json(res, { ok: true, status: job.status, progress: pctOf(job), message: job.progress[job.progress.length - 1] || '', error: job.error, reused: job.reused, lines: job.progress.length });
  }
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
  function result(res, id) {
    if (!ID_RE.test(String(id || ''))) return json(res, { ok: false, error: 'Bad id' }, 400);
    const job = jobs[id], dir = path.join(outRoot, id);
    if (job && job.status === 'running') return json(res, { ok: false, error: 'Not ready' }, 409);
    const routes = readJson(path.join(dir, 'routes.geojson'));
    if (!routes) return json(res, { ok: false, error: job && job.error ? job.error : 'Not found' }, 404);
    const images = ['brush', 'slope', 'shade', 'ground_hs', 'dem_diff'].filter(n => fs.existsSync(path.join(dir, 'grids', n + '.png')));
    json(res, { ok: true, id, routes, summary: readJson(path.join(dir, 'summary.json')), grid: readJson(path.join(dir, 'grids', 'grid.json')), images,
      base: '/api/route/file/' + id + '/', params: readJson(path.join(dir, 'params.json')) });
  }
  function file(res, rest) {
    const i = rest.indexOf('/'), id = rest.slice(0, i), name = rest.slice(i + 1);
    if (i < 0 || !ID_RE.test(id) || !FILE_RE.test(name)) return json(res, { ok: false, error: 'Not found' }, 404);
    const f = path.join(outRoot, id, name);
    fs.stat(f, (err, st) => {
      if (err || !st.isFile()) return json(res, { ok: false, error: 'Not found' }, 404);
      const ext = path.extname(name);
      res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : ext === '.geojson' ? 'application/geo+json' : 'application/json', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
  }

  /** /api/route/<rest> */
  function handle(req, res, rest, query) {
    try {
      if (req.method === 'POST' && rest === 'plan') return void plan(req, res).catch(e => json(res, { ok: false, error: e.message || String(e) }, 500));
      if (req.method === 'GET' && rest === 'result') return result(res, query && query.id);
      if (req.method === 'GET' && rest.startsWith('status/')) return status(res, rest.slice(7));
      if (req.method === 'GET' && rest.startsWith('file/')) return file(res, rest.slice(5));
      return json(res, { ok: false, error: 'not found' }, 404);
    } catch (e) { return json(res, { ok: false, error: e.message || String(e) }, 500); }
  }
  return { jobs, pctOf, handle, clean };
};
