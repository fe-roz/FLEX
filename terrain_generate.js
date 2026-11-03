// terrain_generate.js — a project's own terrain and hillshade, made once from
// the LiDAR and kept in the project (/api/terrain/*).
//
// The job runs the FLEX Field export's pipeline (export_terrain.py
// --project-terrain): the same ground points, DEM (cloth, spike filter, the
// point clouds' vertical shift) and "From LiDAR" hillshade, written as a
// terrain patch (.bin, terrain-patch.js) and XYZ map tiles. When it is done the
// .bin goes into the project's library (a blob, like a browser-baked patch)
// and the tiles into the project folder, FLEX maps/<name>/{z}/{x}/{y}.png. The
// page then records the two layers (custom-layers.js), as for any other layer.
//
//   POST /api/terrain/generate   { project | dest: 'mine', bbox, polygon?, ept: [url…], resolution?, z_offset?, name? } → { jobId }
//                                 (no project: dest 'mine', the files go into 👤 My data = the private project "mine", user_files/mine/)
//   POST /api/terrain/move        { from, to, layers: [{id, kind, blob|url, bounds, name…}], who? } → { ok, layers }  (from / to: a project id or 'mine')
//   GET  /api/terrain/status/<jobId>   { status, progress, message, error, result? }
//   GET  /api/terrain/tiles/<project>/<folder>/<z>/<x>/<y>.png   a tile (a blank one where the area has none)
//
// Tiles live in the project folder, not the library: they don't travel in
// sync files (the .bin does, as a blob). So the tiles URL carries ?dem=<blob>[,<blob>…]
// (the terrain patches of the same area): on a computer whose project folder has no
// such tile folder (the project arrived by sync files), a tile is drawn from those
// patches, a plain DEM hillshade (north-west light), grey + alpha, transparent where
// the patches have no data. Where the folder exists its own (LiDAR) tiles are served.
// A big area is several patches (an overlap, later ones over earlier ones); the first
// is `terrain`, all of them `terrains`.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAPS = 'FLEX maps';
// 1 x 1 transparent PNG: the answer for a tile the area doesn't reach (inside a known folder).
const BLANK = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// ── Hillshade tiles drawn from terrain patches (for a project that arrived without its tile folder) ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); o.write(type, 4, 'latin1'); data.copy(o, 8);
  o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length); return o;
}
/** A grey + alpha 8-bit PNG from `la` (w * h * 2 bytes). */
function pngLA(w, h, la) {
  const raw = Buffer.alloc((w * 2 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 2 + 1)] = 0; la.copy(raw, y * (w * 2 + 1) + 1, y * w * 2, (y + 1) * w * 2); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 4;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', require('zlib').deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
/** A terrain patch file (terrain-patch.js format) → { west, south, east, north, nx, ny, g: Float32Array }. */
function readPatch(buf) {
  const n = buf.readUInt32LE(0), m = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
  if (m.format !== 'flex-terrain-patch') throw new Error('not a terrain patch');
  const g = new Float32Array(m.nx * m.ny), src = buf.subarray(4 + n, 4 + n + m.nx * m.ny * 4);
  Buffer.from(g.buffer).set(src);
  return { west: m.west, south: m.south, east: m.east, north: m.north, nx: m.nx, ny: m.ny, g, cell: m.cell_m || 1 };
}
/** Height at lon/lat from the patches (the last one with data wins), NaN where none has. */
function heightAt(P, lon, lat) {
  for (let q = P.length - 1; q >= 0; q--) {
    const p = P[q];
    if (lon < p.west || lon > p.east || lat < p.south || lat > p.north) continue;
    let fx = (lon - p.west) / (p.east - p.west) * (p.nx - 1), fy = (p.north - lat) / (p.north - p.south) * (p.ny - 1);
    fx = Math.min(fx, p.nx - 1.001); fy = Math.min(fy, p.ny - 1.001); if (fx < 0) fx = 0; if (fy < 0) fy = 0;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, i = y0 * p.nx + x0, g = p.g;
    const a = g[i], b = g[i + 1], c = g[i + p.nx], d = g[i + p.nx + 1];
    if (a !== a || b !== b || c !== c || d !== d) continue;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  return NaN;
}
/** The XYZ tile z/x/y as a PNG (grey hillshade + alpha) from patches P, or null when no patch is in it. */
function hillshadeTile(P, z, x, y) {
  const N = Math.pow(2, z), T = 256, lonOf = u => u / N * 360 - 180, latOf = v => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / N))) * 180 / Math.PI;
  const w = lonOf(x), e = lonOf(x + 1), n = latOf(y), s = latOf(y + 1);
  if (!P.some(p => p.east > w && p.west < e && p.north > s && p.south < n)) return null;
  const latMid = (n + s) / 2, mLon = 111320 * Math.cos(latMid * Math.PI / 180), mLat = 110540;
  const mpp = (e - w) * mLon / T;
  const cell = Math.min(...P.map(p => p.cell || 1)), step = Math.max(mpp, cell);          // metres between the samples the slope is taken from
  const dLon = step / mLon, dLat = step / mLat, az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  const Lx = Math.cos(alt) * Math.sin(az), Ly = Math.cos(alt) * Math.cos(az), Lz = Math.sin(alt), flat = Lz;
  const out = Buffer.alloc(T * T * 2); let any = false;
  for (let py = 0; py < T; py++) {
    const lat = latOf(y + (py + 0.5) / T);
    for (let px = 0; px < T; px++) {
      const lon = lonOf(x + (px + 0.5) / T), h = heightAt(P, lon, lat), k = (py * T + px) * 2;
      if (h !== h) continue;
      const rd = (a, b) => { const v = heightAt(P, a, b); return v === v ? v : h; };
      const dzdx = (rd(lon + dLon, lat) - rd(lon - dLon, lat)) / (2 * step), dzdy = (rd(lon, lat + dLat) - rd(lon, lat - dLat)) / (2 * step);
      const inv = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1), sh = (-dzdx * Lx - dzdy * Ly + Lz) * inv;
      out[k] = Math.max(0, Math.min(255, Math.round(255 * (0.62 + 1.1 * (sh - flat))))); out[k + 1] = 255; any = true;
    }
  }
  return any ? pngLA(T, T, out) : null;
}

module.exports = function terrainGenerate({ python, script, library, ensureMine }) {
  // My data's folder, made on first use (mine.js): where a terrain made with no project open is kept.
  const mineEnsure = ensureMine || (() => require('./mine').ensure());
  const MINE = 'mine';
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
    if (job.pid === MINE) mineEnsure();
    const pd = library.projDir(job.pid);
    if (!pd) throw new Error('the project has no folder');
    const list = Array.isArray(R.terrain_tiles) && R.terrain_tiles.length ? R.terrain_tiles : [R.terrain];
    const folder = freeFolder(pd, job.name || R.name);
    const patches = list.map((t, k) => {
      const bin = fs.readFileSync(path.join(job.outDir, t.file || 'terrain.bin'));
      const b = library.putBlob(bin, 'bin', null, job.pid);
      return { bin, blob: b.h + '.bin', bounds: t.bounds, nx: t.nx, ny: t.ny, cell_m: t.cell_m, name: t.name, k };
    });
    moveDir(path.join(job.outDir, R.tiles.dir || 'tiles'), path.join(pd, MAPS, folder));
    // A visible copy of each patch beside the tiles, as the browser bake keeps one (best effort).
    for (const p of patches) { try { fs.writeFileSync(path.join(pd, MAPS, folder, p.k ? `terrain patch (part ${p.k + 1}).bin` : 'terrain patch.bin'), p.bin); } catch (_) {} }
    const name = job.name || R.name || 'LiDAR terrain';
    const first = patches[0], dem = patches.map(p => p.blob).join(',');
    return {
      name, folder: MAPS + '/' + folder, z_offset: R.z_offset, ground: R.ground,
      terrain: { blob: first.blob, bounds: first.bounds, nx: first.nx, ny: first.ny, cell_m: first.cell_m },
      terrains: patches.map(p => ({ blob: p.blob, bounds: p.bounds, nx: p.nx, ny: p.ny, cell_m: p.cell_m, name: p.name })),
      // ?dem= : the patches the tiles can be drawn from when the folder is not on this computer (see the header)
      tiles: { url: `/api/terrain/tiles/${job.pid}/${encodeURIComponent(folder)}/{z}/{x}/{y}.png?dem=${dem}`, bounds: R.tiles.bounds,
               minzoom: R.tiles.minzoom, maxzoom: R.tiles.maxzoom, count: R.tiles.count, cell_m: R.tiles.cell_m },
    };
  }


  // ── Moving a terrain between project folders / My data (copy; the source is let go by the page on 💾 Save) ──
  const TILES_URL = /^\/api\/terrain\/tiles\/([A-Za-z0-9_-]{1,40})\/([^/?]{1,100})\/(\{z\}\/\{x\}\/\{y\}\.png)(\?dem=[0-9a-f,.bin]{1,700})?$/;
  const BIN = /^[0-9a-f]{64}\.bin$/;
  /**
   * Copy a terrain's files into another project (or My data) and write its layers there. `layers` are the page's
   * layer entries: { id, kind: 'terrain', blob, bounds, name } and { id, kind: 'tiles', url, bounds, minZoom, maxZoom, name }.
   * The patch files are copied by fingerprint; the tiles folder (FLEX maps/<name>) is copied into a free folder name at
   * the destination, and the tiles link rewritten to it. Nothing is removed here.
   */
  function moveTerrain(o) {
    const from = String(o.from || ''), to = String(o.to || '');
    if (!ID_RE.test(from) || !ID_RE.test(to) || from === to) throw new Error('two different places, please');
    if (from === MINE || to === MINE) mineEnsure();
    const sd = library.projDir(from), td = library.projDir(to);
    if (!sd || !td) throw new Error('unknown project');
    if ([from, to].some(x => x !== MINE && library.isArchived(x))) throw new Error('an archived project is read-only: unarchive it first');
    const ls = Array.isArray(o.layers) ? o.layers.slice(0, 40) : [];
    if (!ls.length) throw new Error('nothing to move');
    const by = clean(o.who).slice(0, 40) || 'FLEX', out = [], entries = [];
    let tiles = 0;
    for (const l of ls) {
      if (!l || typeof l !== 'object' || !/^[A-Za-z0-9_-]{1,60}$/.test(String(l.id || ''))) throw new Error('bad layer');
      const e = { op: 'layer.set', who: by, layer: l.id, kind: l.kind, name: clean(l.name).slice(0, 80), removed: false, order: Number.isFinite(l.order) ? l.order : 0 };
      if (Array.isArray(l.bounds) && l.bounds.length === 4 && l.bounds.every(num)) e.bounds = l.bounds;
      if (l.kind === 'terrain') {
        if (!BIN.test(String(l.blob || ''))) throw new Error('bad patch');
        if (!library.copyBlobTo(l.blob, to)) throw new Error('the patch file is not on this computer');
        e.blob = l.blob;
      } else if (l.kind === 'tiles') {
        const m = TILES_URL.exec(String(l.url || ''));
        if (!m) throw new Error('not a terrain tiles link');
        const folder = decodeURIComponent(m[2]);
        if (folder === '.' || folder === '..' || folder.includes('/') || folder.includes('\\')) throw new Error('bad folder');
        let nf = folder;
        const src = path.join(sd, MAPS, folder);
        if (fs.existsSync(src)) {
          // The same tiles already there (an earlier move of this terrain): reuse that folder, else a free name.
          const same = (() => { try { return fs.readFileSync(path.join(src, 'tiles.json')).equals(fs.readFileSync(path.join(td, MAPS, folder, 'tiles.json'))); } catch (_) { return false; } })();
          nf = same ? folder : freeFolder(td, folder);
          tiles += library.copyTree(src, path.join(td, MAPS, nf));
        }
        e.url = `/api/terrain/tiles/${to}/${encodeURIComponent(nf)}/${m[3]}${m[4] || ''}`;
        if (Number.isFinite(l.minZoom)) e.minZoom = l.minZoom;
        if (Number.isFinite(l.maxZoom)) e.maxZoom = l.maxZoom;
      } else throw new Error('only terrain patches and their hillshade move this way');
      entries.push(e); out.push({ id: l.id, kind: l.kind, url: e.url });
    }
    entries.forEach(e => library.append('p-' + to, e, to));          // after every file is in place: all or nothing
    return { ok: true, layers: out, tilesCopied: tiles };
  }

  async function generate(req, res) {
    let o;
    try { o = JSON.parse(await body(req)); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    // A project's id, or (no project open) dest 'mine': 👤 My data.
    const pid = o.dest === MINE && !o.project ? MINE : String(o.project || '');
    if (!ID_RE.test(pid)) return json(res, { ok: false, error: 'open a project first, or keep the result in My data' }, 400);
    if (pid === MINE) mineEnsure();
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
    const job = jobs[jobId] = { status: 'running', progress: [], outDir, pid, name, label: name || 'LiDAR terrain', error: null, result: null, started: Date.now(), ended: null, cancelled: false, proc: null };   // the Jobs panel (jobs_api.js) lists these, cancels via .proc
    const args = [script, '--ept', ept[0], ...ept.slice(1).flatMap(u => ['--also-ept', u]),
      '--bbox', ...bbox.map(String), '--resolution', String(resolution), '--project-terrain', outDir];
    if (name) args.push('--name', name);
    if (num(o.z_offset) && Math.abs(o.z_offset) < 200) args.push('--z-offset', String(o.z_offset));
    if (poly) { const f = path.join(outDir, 'area.json'); fs.writeFileSync(f, JSON.stringify(poly)); args.push('--polygon', f); }
    json(res, { ok: true, jobId });

    let proc;
    try { proc = spawn(python, args, { cwd: path.dirname(script) }); }
    catch (e) { job.status = 'error'; job.error = 'could not start Python: ' + e.message; job.ended = Date.now(); return; }
    job.proc = proc;
    const take = pre => d => d.toString().split('\n').forEach(l => { l = l.trim(); if (l) { job.progress.push(pre + l); console.log('[terrain]', l); } });
    proc.stdout.on('data', take(''));
    proc.stderr.on('data', take('⚠ '));
    proc.on('error', e => {
      job.status = 'error'; job.ended = Date.now(); job.error = `could not run ${python} (${e.code || e.message}): set FLEX_PYTHON to the Python that has PDAL`;
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    });
    proc.on('close', code => {
      job.proc = null;
      if (job.status === 'error') return;
      try {
        if (job.cancelled) throw new Error('Cancelled');
        if (code !== 0 || !fs.existsSync(path.join(outDir, 'result.json'))) {
          const last = job.progress.filter(l => /ERROR|Error/.test(l)).pop();
          throw new Error(last ? last.replace(/^⚠ /, '') : `the terrain job stopped (code ${code})`);
        }
        job.result = finish(job);
        job.status = 'done';
      } catch (e) { job.status = 'error'; job.error = e.message || String(e); }
      job.ended = Date.now();
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    });
  }

  function pctOf(job) {
    const last = job.progress[job.progress.length - 1] || '';
    const PCT = { 1: 10, 2: 40, 3: 65, 4: 85 };
    const step = /\[(\d)\/4\]/.exec(last);
    return job.status === 'done' ? 100 : step ? PCT[step[1]] : 5;
  }
  function status(res, jobId) {
    const job = jobs[jobId];
    if (!job) return json(res, { ok: false, error: 'Unknown job' }, 404);
    const last = job.progress[job.progress.length - 1] || '';
    const pct = pctOf(job);
    json(res, { status: job.status, progress: pct, message: last, error: job.error, result: job.result });
  }

  // The patches named in ?dem=, read once and kept (the last two sets).
  const cache = [];
  function patchesOf(dem) {
    const names = String(dem || '').split(',');
    if (!names.length || names.length > 9 || !names.every(n => /^[0-9a-f]{64}\.bin$/.test(n))) return null;
    const key = names.join(','), hit = cache.find(c => c.key === key);
    if (hit) return hit.P;
    const P = [];
    for (const n of names) {
      const f = library.blobPath(n); if (!f) return null;
      try { P.push(readPatch(fs.readFileSync(f))); } catch (_) { return null; }
    }
    cache.unshift({ key, P }); cache.length = Math.min(cache.length, 2);
    return P;
  }

  /** A tile from the project folder: fast, cached; blank inside a known folder where there is none. Without the folder, drawn from ?dem=. */
  function tile(res, rest, query) {
    const m = /^([A-Za-z0-9_-]{1,40})\/([^/]{1,100})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.png$/.exec(rest);
    if (!m || m[2] === '.' || m[2] === '..' || m[2].includes('\\')) return json(res, { error: 'bad tile' }, 400);
    const pd = library.projDir(m[1]);
    if (!pd) return json(res, { error: 'not found' }, 404);
    const dir = path.join(pd, MAPS, m[2]);
    const f = path.join(dir, m[3], m[4], m[5] + '.png');
    const send = (buf, age) => { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'max-age=' + age }); res.end(buf); };
    fs.stat(f, (err, st) => {
      if (!err && st.isFile()) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': st.size, 'Cache-Control': 'max-age=86400' });
        return fs.createReadStream(f).pipe(res);
      }
      fs.stat(dir, (e2, sd) => {
        if (e2 || !sd.isDirectory()) {
          const P = patchesOf(query && query.dem);              // no tile folder here: draw it from the terrain patches
          if (!P) return json(res, { error: 'not found' }, 404);
          let png; try { png = hillshadeTile(P, +m[3], +m[4], +m[5]); } catch (e) { return json(res, { error: e.message }, 500); }
          return send(png || BLANK, 3600);
        }
        send(BLANK, 86400);
      });
    });
  }

  /** /api/terrain/<rest> */
  function handle(req, res, rest, query) {
    try {
      if (req.method === 'POST' && rest === 'generate') return void generate(req, res).catch(e => json(res, { ok: false, error: e.message }, 500));
      if (req.method === 'POST' && rest === 'move') return void body(req).then(b => json(res, moveTerrain(JSON.parse(b || '{}')))).catch(e => json(res, { ok: false, error: e.message || String(e) }, 400));
      if (req.method === 'GET' && rest.startsWith('status/')) return status(res, rest.slice(7));
      if (req.method === 'GET' && rest.startsWith('tiles/')) return tile(res, rest.slice(6), query);
      return json(res, { error: 'not found' }, 404);
    } catch (e) { return json(res, { error: e.message || String(e) }, 500); }
  }
  // ── For the viewer export (server.js handleExportTerrain) ───────────────────
  // The project's terrain patches, as files: names of blobs the library holds, nothing else is read.
  function exportPatchFiles(names) {
    if (!Array.isArray(names)) return [];
    return names.slice(0, 9).map(n => (typeof n === 'string' && /^[0-9a-f]{64}\.bin$/.test(n)) ? library.blobPath(n) : null).filter(Boolean);
  }
  // A map layer {kind:'imagery', blob, bounds} (a picture on a lon/lat box) or {kind:'tiles', url} (an XYZ / TMS tile link;
  // a link on this server, starting with /, is fetched from here) → the exporter's arguments for `what`
  // ('satellite' | 'hillshade'), or null if it can't be used (the exporter's own source is taken then).
  function exportLayerArgs(what, L, port) {
    if (!L || typeof L !== 'object') return null;
    if (L.kind === 'imagery') {
      const f = typeof L.blob === 'string' && /^[0-9a-f]{64}\.(png|jpg|webp)$/.test(L.blob) ? library.blobPath(L.blob) : null;
      const b = Array.isArray(L.bounds) && L.bounds.length === 4 && L.bounds.every(Number.isFinite) ? L.bounds : null;
      if (!f || !b) return null;
      return what === 'satellite' ? ['--satellite-source', 'image', '--satellite-image', f, '--satellite-bounds', ...b.map(String)]
                                  : ['--hillshade', 'image', '--hillshade-image', f, '--hillshade-bounds', ...b.map(String)];
    }
    if (L.kind === 'tiles' && typeof L.url === 'string' && L.url.length < 2000 && /\{z\}/.test(L.url) && /\{x\}/.test(L.url) && /\{(y|-y|reverseY)\}/.test(L.url)) {
      const url = L.url.startsWith('/') ? `http://127.0.0.1:${port}${L.url}` : (/^https?:\/\//i.test(L.url) ? L.url : null);
      if (!url) return null;
      return what === 'satellite' ? ['--satellite-source', 'xyz', '--satellite-url', url, '--satellite-tile-px', '256']
                                  : ['--hillshade', 'url', '--hillshade-url', url, '--hillshade-tile-px', '256'];
    }
    return null;
  }
  return { handle, jobs, pctOf, finish, moveTerrain, hillshadeTile, readPatch, exportPatchFiles, exportLayerArgs };
};
