// terrain_generate.js — a project's own terrain and hillshade, made once from
// the LiDAR and kept in the project (/api/terrain/*).
//
// The job runs the FLEX Field export's pipeline (export_terrain.py
// --project-terrain): the same ground points, DEM (cloth, spike filter, the
// point clouds' vertical shift) and "From LiDAR" hillshade, written as a
// terrain patch (.bin, terrain_patch.js) and XYZ map tiles. When it is done the
// .bin goes into the project's library (a blob, like a browser-baked patch)
// and the tiles into the project folder, FLEX maps/<name>/{z}/{x}/{y}.png. The
// page then records the two layers (custom_layers.js), as for any other layer.
//
//   POST /api/terrain/generate   { project, bbox, polygon?, ept: [url…], resolution?, z_offset?, name? } → { jobId }
//   GET  /api/terrain/status/<jobId>   { status, progress, message, error, result? }
//   GET  /api/terrain/tiles/<project>/<folder>/<z>/<x>/<y>.png   a tile (a blank one where the area has none)
//
// Tiles live in the project folder, not the library: they don't travel in
// sync files (the .bin does, as a blob).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAPS = 'FLEX maps';
// 1 x 1 transparent PNG: the answer for a tile the area doesn't reach (inside a known folder).
const BLANK = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

module.exports = function terrainGenerate({ python, script, library }) {
  const jobs = {};
  const outRoot = path.join(path.dirname(library.ROOT), 'terrain_jobs');
  const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const body = req => new Promise((resolve, reject) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 8 << 20) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(s)); req.on('error', reject);
  });
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const clean = s => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

  /** A folder name under FLEX maps/ not taken yet. */
  function freeFolder(pd, name) {
    const base = library.safeName(name || 'LiDAR terrain');
    let f = base, n = 2;
    while (fs.existsSync(path.join(pd, MAPS, f))) f = `${base} (${n++})`;
    return f;
  }
  function moveDir(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(src, dest); }
    catch (e) { if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e; fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }   // another drive
  }

  /** The finished job's files into the project: the .bin as a blob, the tiles into its folder. */
  function finish(job) {
    const R = JSON.parse(fs.readFileSync(path.join(job.outDir, 'result.json'), 'utf8'));
    const pd = library.projDir(job.pid);
    if (!pd) throw new Error('the project has no folder');
    const bin = fs.readFileSync(path.join(job.outDir, R.terrain.file || 'terrain.bin'));
    const b = library.putBlob(bin, 'bin', null, job.pid);
    const folder = freeFolder(pd, job.name || R.name);
    moveDir(path.join(job.outDir, R.tiles.dir || 'tiles'), path.join(pd, MAPS, folder));
    // A visible copy of the patch beside its tiles, as the browser bake keeps one (best effort).
    try { fs.writeFileSync(path.join(pd, MAPS, folder, 'terrain patch.bin'), bin); } catch (_) {}
    const name = job.name || R.name || 'LiDAR terrain';
    return {
      name, folder: MAPS + '/' + folder, z_offset: R.z_offset, ground: R.ground,
      terrain: { blob: b.h + '.bin', bounds: R.terrain.bounds, nx: R.terrain.nx, ny: R.terrain.ny, cell_m: R.terrain.cell_m },
      tiles: { url: `/api/terrain/tiles/${job.pid}/${encodeURIComponent(folder)}/{z}/{x}/{y}.png`, bounds: R.tiles.bounds,
               minzoom: R.tiles.minzoom, maxzoom: R.tiles.maxzoom, count: R.tiles.count, cell_m: R.tiles.cell_m },
    };
  }

  async function generate(req, res) {
    let o;
    try { o = JSON.parse(await body(req)); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const pid = String(o.project || '');
    if (!ID_RE.test(pid)) return json(res, { ok: false, error: 'open a project first' }, 400);
    if (!library.projDir(pid)) return json(res, { ok: false, error: 'this project has no folder yet (it is still in the old library)' }, 400);
    const bbox = o.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(num) || !(bbox[2] > bbox[0] && bbox[3] > bbox[1]))
      return json(res, { ok: false, error: 'bbox required: [minLon, minLat, maxLon, maxLat]' }, 400);
    let poly = null;
    if (o.polygon != null) {
      const okPt = p => Array.isArray(p) && p.length >= 2 && num(p[0]) && num(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
      if (!Array.isArray(o.polygon) || o.polygon.length < 3 || o.polygon.length > 20000 || !o.polygon.every(okPt))
        return json(res, { ok: false, error: 'polygon must be 3 to 20000 [lon, lat] points' }, 400);
      poly = o.polygon.map(p => [+p[0], +p[1]]);
    }
    const ept = (Array.isArray(o.ept) ? o.ept : [o.ept || o.eptPath]).map(clean).filter(Boolean);
    if (!ept.length || ept.length > 6 || ept.some(u => u.length > 2000)) return json(res, { ok: false, error: 'choose the LiDAR (a point cloud) to use' }, 400);
    const resolution = num(o.resolution) && o.resolution >= 0.25 && o.resolution <= 10 ? o.resolution : 0.5;
    const name = clean(o.name).slice(0, 60);

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const outDir = path.join(outRoot, jobId);
    fs.mkdirSync(outDir, { recursive: true });
    const job = jobs[jobId] = { status: 'running', progress: [], outDir, pid, name, error: null, result: null };
    const args = [script, '--ept', ept[0], ...ept.slice(1).flatMap(u => ['--also-ept', u]),
      '--bbox', ...bbox.map(String), '--resolution', String(resolution), '--project-terrain', outDir];
    if (name) args.push('--name', name);
    if (num(o.z_offset) && Math.abs(o.z_offset) < 200) args.push('--z-offset', String(o.z_offset));
    if (poly) { const f = path.join(outDir, 'area.json'); fs.writeFileSync(f, JSON.stringify(poly)); args.push('--polygon', f); }
    json(res, { ok: true, jobId });

    let proc;
    try { proc = spawn(python, args, { cwd: path.dirname(script) }); }
    catch (e) { job.status = 'error'; job.error = 'could not start Python: ' + e.message; return; }
    const take = pre => d => d.toString().split('\n').forEach(l => { l = l.trim(); if (l) { job.progress.push(pre + l); console.log('[terrain]', l); } });
    proc.stdout.on('data', take(''));
    proc.stderr.on('data', take('⚠ '));
    proc.on('error', e => {
      job.status = 'error'; job.error = `could not run ${python} (${e.code || e.message}): set FLEX_PYTHON to the Python that has PDAL`;
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    });
    proc.on('close', code => {
      if (job.status === 'error') return;
      try {
        if (code !== 0 || !fs.existsSync(path.join(outDir, 'result.json'))) {
          const last = job.progress.filter(l => /ERROR|Error/.test(l)).pop();
          throw new Error(last ? last.replace(/^⚠ /, '') : `the terrain job stopped (code ${code})`);
        }
        job.result = finish(job);
        job.status = 'done';
      } catch (e) { job.status = 'error'; job.error = e.message || String(e); }
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    });
  }

  function status(res, jobId) {
    const job = jobs[jobId];
    if (!job) return json(res, { ok: false, error: 'Unknown job' }, 404);
    const last = job.progress[job.progress.length - 1] || '';
    const PCT = { 1: 10, 2: 40, 3: 65, 4: 85 };
    const step = /\[(\d)\/4\]/.exec(last);
    const pct = job.status === 'done' ? 100 : step ? PCT[step[1]] : 5;
    json(res, { status: job.status, progress: pct, message: last, error: job.error, result: job.result });
  }

  /** A tile from the project folder: fast, cached; blank inside a known folder where there is none. */
  function tile(res, rest) {
    const m = /^([A-Za-z0-9_-]{1,40})\/([^/]{1,100})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.png$/.exec(rest);
    if (!m || m[2] === '.' || m[2] === '..' || m[2].includes('\\')) return json(res, { error: 'bad tile' }, 400);
    const pd = library.projDir(m[1]);
    if (!pd) return json(res, { error: 'not found' }, 404);
    const dir = path.join(pd, MAPS, m[2]);
    const f = path.join(dir, m[3], m[4], m[5] + '.png');
    fs.stat(f, (err, st) => {
      if (!err && st.isFile()) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': st.size, 'Cache-Control': 'max-age=86400' });
        return fs.createReadStream(f).pipe(res);
      }
      fs.stat(dir, (e2, sd) => {
        if (e2 || !sd.isDirectory()) return json(res, { error: 'not found' }, 404);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': BLANK.length, 'Cache-Control': 'max-age=86400' });
        res.end(BLANK);
      });
    });
  }

  /** /api/terrain/<rest> */
  function handle(req, res, rest) {
    try {
      if (req.method === 'POST' && rest === 'generate') return void generate(req, res).catch(e => json(res, { ok: false, error: e.message }, 500));
      if (req.method === 'GET' && rest.startsWith('status/')) return status(res, rest.slice(7));
      if (req.method === 'GET' && rest.startsWith('tiles/')) return tile(res, rest.slice(6));
      return json(res, { error: 'not found' }, 404);
    } catch (e) { return json(res, { error: e.message || String(e) }, 500); }
  }
  return { handle, jobs, finish };
};
