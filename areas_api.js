// areas_api.js — processed areas (/api/areas/*): the server half of the Analyze-by-area pane (client/src/modules/analyze-area.js).
// An area is a ring on the map plus the results of tools run in it, kept together in user_files/areas/<id>/ :
//   area.json   { id, name, ring (closed), km2, project, created, updated, lidar: [urls], results: { ground, terrain, veg, bush } }
//   ground/ veg/ bush/ terrain/   what each step wrote (ground = area_ground.py, veg = veg_shapes.py, bush = lidar_derive.py,
//                                 terrain/ref.json = where the Terrain generation put its result)
//
//   GET  /api/areas?project=<pid>             { ok, areas }   (that project's and My data's, newest first; no project param: all)
//   POST /api/areas/save    { id?, name, ring, project? }   → { ok, area }
//   POST /api/areas/rename  { id, name }    POST /api/areas/delete { id }    POST /api/areas/delete-result { id, result }
//   POST /api/areas/check   { ring, lidar, tools, options } → { ok, km2, tools: { <tool>: { status, why, offers, minutes } }, ground }
//   POST /api/areas/run     { id? | name+ring, project?, lidar, tools, options } → { ok, runId, areaId }
//   GET  /api/areas/status/<runId>            { ok, status, step, steps, progress, message, notes, error, areaId }
//   GET  /api/areas/file/<areaId>/<result>/<name>   (allow-list per result folder)
//   GET  /api/areas/maps/<areaId>   GET /api/areas/tiles/<areaId>/<map>/<z>/<x>/<y>.png?ramp=&lo=&hi=   (area_tiles.js)
//   POST /api/areas/import[?overwrite=1]   body: an area package zip (tools/area_pack.js) → { ok, area, written, refused }
//
// One run = ordered steps, each a child process (terrain: the Terrain panel's generation, called in-process): ground (skipped when
// DIR/ground exists for the same lidar, ring and cell), then veg, bush, terrain. Each success is written into area.json (replacing
// the old result); a failed step stops the run and keeps the earlier results. A line "NOTE: text" from any script goes to the run's
// notes and to that result's notes. Prospects (prospect.py, FLEX_PROSPECT_SCRIPT) runs right after ground and needs only the area's ground and points: a run of only prospect on an area that has ground needs no LiDAR; options.prospect.known = known points for "nearest known". LIMITS below is the one table of limits and offers (check and run both read it).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RESULTS = ['ground', 'terrain', 'veg', 'bush', 'prospect', 'ridge'];
const TOOLS = ['terrain', 'veg', 'bush', 'prospect', 'ridge'];
const LABEL = { maps: 'Detailed maps (slope, hillshade, brush)', ground: 'Ground', terrain: 'Terrain', veg: 'Vegetation shapes', bush: 'Bushwhack layers', prospect: 'Prospects', ridge: 'Ridgewalking' };
const MIN_RING = 3, MAX_RING = 3000;
// The one table. km2 = area; a tool "fits" up to `max` at its default, and offers a coarser setting that reaches `coarseMax`.
const LIMITS = {
  ground:  { max: 100 },
  veg:     { max: 25, coarseMax: 60, offer: { key: 'detail-low', label: 'Lower detail (coarser shapes)', options: { detail: 'low' } }, option: { detail: 'low' } },
  terrain: { postsMax: 32e6, defaultCell: 1, coarseCell: 2, offer: { key: 'cell-2', label: '2 m cells (about a quarter of the size)', options: { cell: 2 } } },
  prospect: { max: 100 },   // follows ground: it only reads the area's ground and points
  // Ridgewalking (ridgewalk.py): about 95 s and under 2 GB a km² on the test server, worked in tiles; 15 km² is about 25 minutes.
  ridge:   { max: 15 },
  bush:    { max: 32, coarseMax: 80, defaultCell: 1, coarseCell: 2, offer: { key: 'cell-2', label: 'Coarser cells (2 m)', options: { cell: 2 } } },
};
const FILES = {
  ground: /^(grid\.json|summary\.json|coverage\.png|pits\.geojson|ground\.npy|maps\.json|slope\.u8|hillshade\.u8)$/,
  veg: /^(veg\.json|shapes\.bin|shell\.bin|ground\.bin|preview\.png)$/,
  bush: /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}\.(png|json|tif|u8)$/,
  terrain: /^ref\.json$/,
  // what the map draws (ridge-draw.js) and what the phone export also carries; lid.npy / holes.npy / brush.npy (the whole area's
  // grids, tens to hundreds of MB) stay on this computer: not served, not in an area package
  ridge: /^(ridge\.json|features\.json|draw\.json|points\.bin|shapes\.bin|patches\.bin)$/,
  prospect: /^(candidates|candidates_areas|candidates_isolated)\.geojson$|^candidates\.(kml|csv)$|^(depth|below|steep)\.png$|^(layers|summary)\.json$/,
};
const IMPORT_MAX = 2048 * 1048576;    // an area package (zip) for POST /api/areas/import
const MIME = { '.png': 'image/png', '.json': 'application/json', '.geojson': 'application/json', '.tif': 'image/tiff', '.kml': 'application/vnd.google-earth.kml+xml', '.csv': 'text/csv; charset=utf-8' };

module.exports = function areasApi({ python, groundScript, vegScript, lidarScript, prospectScript, mapsScript, ridgeScript, ridgeAreaScript, root, terrainGen, pollMs, fetchTimeoutMs }) {
  const jobs = {};
  const tiles = require('./area_tiles.js')({ root });     // the area's maps as coloured tiles (GET tiles/…, maps/…)
  const eptCache = new Map();
  const json = (res, d, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(d)); };
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const lonlat = p => Array.isArray(p) && p.length >= 2 && num(p[0]) && num(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) { no(new Error('too big')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', no); });
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
  const cleanName = (s, d) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || d;
  const areaDir = id => path.join(root, id);
  const readArea = id => ID_RE.test(String(id || '')) ? readJson(path.join(areaDir(id), 'area.json')) : null;
  function writeArea(a) {
    a.updated = new Date().toISOString();
    fs.mkdirSync(areaDir(a.id), { recursive: true });
    const f = path.join(areaDir(a.id), 'area.json'), t = f + '.tmp';
    fs.writeFileSync(t, JSON.stringify(a, null, 1)); fs.renameSync(t, f);
  }
  const newId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function ringKm2(ring) {
    const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    let s = 0;
    ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; s += p[0] * kx * q[1] * ky - q[0] * kx * p[1] * ky; });
    return Math.abs(s) / 2 / 1e6;
  }
  /** → { ring (closed) , km2 } or { error } */
  function cleanRing(r) {
    if (!Array.isArray(r)) return { error: 'choose the area (draw it or pick a footprint)' };
    let ring = r.filter(lonlat).map(c => [+c[0], +c[1]]);
    if (ring.length !== r.length) return { error: 'the area has a corner that is not a longitude and latitude' };
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < MIN_RING) return { error: 'the area needs at least three corners' };
    if (ring.length > MAX_RING) return { error: 'the area has too many corners' };
    const km2 = ringKm2(ring);
    if (!(km2 > 0)) return { error: 'the area has no size' };
    return { ring: ring.concat([ring[0]]), km2: Math.round(km2 * 1000) / 1000 };
  }
  const cleanProject = p => (p == null || p === '' ? '' : (ID_RE.test(String(p)) ? String(p) : null));
  const cleanUrls = l => (Array.isArray(l) ? l : []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 2000).slice(0, 6);
  const ringKey = ring => ring.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';');
  const bboxOf = ring => [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))];
  function dirBytes(d) {
    let n = 0;
    try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); n += e.isDirectory() ? dirBytes(f) : fs.statSync(f).size; } } catch (_) {}
    return n;
  }

  // ── LiDAR coverage from the EPT bounds ─────────────────────────────────────
  function getText(url) {
    return new Promise((ok, no) => {
      const lib = /^https:/i.test(url) ? https : http;
      const r = lib.get(url, { timeout: fetchTimeoutMs || 8000 }, res => {
        if (res.statusCode !== 200) { res.resume(); return no(new Error('HTTP ' + res.statusCode)); }
        let s = ''; res.setEncoding('utf8'); res.on('data', c => { s += c; if (s.length > 5e6) { r.destroy(); no(new Error('too big')); } }); res.on('end', () => ok(s));
      });
      r.on('timeout', () => { r.destroy(new Error('timeout')); });
      r.on('error', no);
    });
  }
  /** → { epsg, b: [minx, miny, maxx, maxy] } or null (unknown: assume covered) */
  async function eptInfo(url) {
    if (eptCache.has(url)) return eptCache.get(url);
    let info = null;
    try {
      const u = /ept\.json(\?|$)/i.test(url) ? url : url.replace(/\/+$/, '') + '/ept.json';
      const j = JSON.parse(await getText(u));
      const bb = Array.isArray(j.boundsConforming) && j.boundsConforming.length >= 6 ? j.boundsConforming : j.bounds;
      if (Array.isArray(bb) && bb.length >= 6 && bb.every(num)) {
        let epsg = j.srs && j.srs.horizontal ? parseInt(j.srs.horizontal, 10) : NaN;
        if (!epsg && j.srs && j.srs.wkt) { const m = /"EPSG","(\d+)"\]\]\s*$/.exec(j.srs.wkt); if (m) epsg = +m[1]; }
        info = { epsg: epsg || null, b: [bb[0], bb[1], bb[3], bb[4]] };
      }
    } catch (_) { info = null; }
    if (info) eptCache.set(url, info);
    return info;
  }
  /** lon/lat → [x, y] in `epsg` (3857, 4326, WGS84 / NAD83 / ETRS89 UTM), or null when not known */
  function project(epsg, lon, lat) {
    if (epsg === 4326 || epsg === 4269) return [lon, lat];
    if (epsg === 3857) return [lon * 20037508.342789244 / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 6378137];
    let zone = 0, south = false;
    if (epsg >= 32601 && epsg <= 32660) zone = epsg - 32600;
    else if (epsg >= 32701 && epsg <= 32760) { zone = epsg - 32700; south = true; }
    else if (epsg >= 26903 && epsg <= 26923) zone = epsg - 26900;
    else if (epsg >= 25828 && epsg <= 25838) zone = epsg - 25800;
    if (!zone) return null;
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), ep2 = e2 / (1 - e2), k0 = 0.9996;
    const phi = lat * Math.PI / 180, lam = (lon - ((zone - 1) * 6 - 180 + 3)) * Math.PI / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = lam * Math.cos(phi);
    const M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi) +
      (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    let y = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    if (south) y += 10000000;
    return [x, y];
  }
  const inRing = (ring, x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if ((ring[i][1] > y) !== (ring[j][1] > y) && x < (ring[j][0] - ring[i][0]) * (y - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c;
    }
    return c;
  };
  /** 0..1 of the ring the clouds' bounds reach; null = unknown (treated as covered) */
  async function coverage(ring, urls) {
    if (!urls.length) return 0;
    const infos = await Promise.all(urls.map(eptInfo));
    if (infos.some(i => !i)) return null;
    const bb = bboxOf(ring), N = 40, pts = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = bb[0] + (i + 0.5) / N * (bb[2] - bb[0]), y = bb[1] + (j + 0.5) / N * (bb[3] - bb[1]);
      if (inRing(ring, x, y)) pts.push([x, y]);
    }
    if (!pts.length) ring.slice(0, -1).forEach(p => pts.push(p));
    let hit = 0;
    for (const [x, y] of pts) {
      let cov = false;
      for (const inf of infos) {
        const q = project(inf.epsg, x, y) || (inf.b.every(v => Math.abs(v) <= 360) ? [x, y] : null);
        if (!q) return null;
        if (q[0] >= inf.b[0] && q[0] <= inf.b[2] && q[1] >= inf.b[1] && q[1] <= inf.b[3]) { cov = true; break; }
      }
      if (cov) hit++;
    }
    return hit / pts.length;
  }

  // ── check: limits, offers, plain words ──────────────────────────────────────
  const round1 = v => Math.max(1, Math.round(v));
  const minutesOf = (tool, km2) => round1({ ground: 0.6 * km2 + 1, veg: 1.0 * km2 + 1, bush: 0.5 * km2 + 1, prospect: 0.2 * km2 + 1, terrain: 1.2 * km2 + 2, ridge: 1.6 * km2 + 0.5 }[tool]);
  // Ridgewalking does not use the area's ground or its stored points: it reads the LiDAR itself, with the flight-pass ids.
  const RIDGE_WHY = 'Reads the LiDAR itself (it needs the flight-pass ids, which the area\'s stored points do not keep).';
  const needsGround = tools => tools.some(t => t !== 'ridge');
  /** Settings the tool would run with: { coarse, cell, detail } from the options and its defaults. */
  function settingsOf(tool, options) {
    const o = (options && options[tool]) || {};
    if (tool === 'veg') { const detail = ['low', 'medium', 'high'].includes(o.detail) ? o.detail : 'medium'; return { detail, coarse: detail === 'low' }; }
    const L = LIMITS[tool], cell = num(o.cell) && o.cell >= 0.25 && o.cell <= 20 ? o.cell : L.defaultCell;
    return { cell, coarse: cell > L.defaultCell };
  }
  function judge(tool, km2, options) {
    const L = LIMITS[tool], s = settingsOf(tool, options), minutes = minutesOf(tool, km2);
    const sq = km2.toFixed(1);
    if (tool === 'terrain') {
      const posts = km2 * 1e6 / (s.cell * s.cell);
      if (posts <= L.postsMax) return { status: 'fits', why: s.coarse ? `Made with ${s.cell} m cells.` : '', offers: [], minutes, coarse: s.coarse };
      const coarse2 = km2 * 1e6 / (L.coarseCell * L.coarseCell) <= L.postsMax;
      return { status: 'toobig', why: `At ${s.cell} m cells ${sq} km² is too many heights to make at once` + (coarse2 ? ': 2 m cells will do it.' : ': choose a smaller area.'),
        offers: coarse2 && s.cell < L.coarseCell ? [L.offer] : [], minutes, coarse: s.coarse };
    }
    const cellMult = tool === 'bush' && s.coarse ? 4 : 1, max = L.max * (tool === 'veg' ? (s.coarse ? L.coarseMax / L.max : 1) : cellMult);
    if (km2 <= max) return { status: 'fits', why: s.coarse ? 'Made with a coarser setting.' : '', offers: [], minutes, coarse: s.coarse };
    const reach = tool === 'veg' ? L.coarseMax : L.coarseMax;
    const canOffer = !s.coarse && km2 <= reach;
    return { status: 'toobig', why: `${sq} km² is more than this can do at once (${s.coarse ? max : L.max} km²)` + (canOffer ? ': a coarser setting will do it.' : ': choose a smaller area.'),
      offers: canOffer ? [L.offer] : [], minutes, coarse: s.coarse };
  }
  const hasGround = id => ID_RE.test(String(id || '')) && fs.existsSync(path.join(areaDir(id), 'ground', 'grid.json'));
  // ── The detailed maps (area_maps.py --maps-cell): slope + hillshade from a fine ground, brush + voids in blocks ──
  // options.ground.maps_cell: 'auto' (the maps come at the ground's cell, made by the Ground and bushwhack steps) or
  // metres 0.2..2 (a maps step after them, from the area's stored points; the saved ground is not changed).
  function mapsCellOf(options) {
    const v = options && options.ground && options.ground.maps_cell;
    if (v == null || v === '' || v === 'auto') return null;
    const c = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
    if (!num(c) || c < 0.2 || c > 2) return { error: 'Map detail: choose Auto or a cell between 0.2 and 2 m.' };
    return { cell: Math.round(c * 1000) / 1000 };
  }
  /** What the screen needs to say what a map detail costs: ground returns per m² and whether the points are stored. */
  function mapsInfo(id, km2, options) {
    const out = { groundCell: null, density: null, pointsStored: false, cell: null };
    const mc = mapsCellOf(options); if (mc && mc.cell) out.cell = mc.cell;
    if (!ID_RE.test(String(id || ''))) return out;
    const sm = readJson(path.join(areaDir(id), 'ground', 'summary.json')) || {}, gr = readJson(path.join(areaDir(id), 'ground', 'grid.json')) || {};
    out.groundCell = num(gr.cell) ? gr.cell : null;
    if (num(sm.ground_points) && num(sm.km2) && sm.km2 > 0) out.density = Math.round(sm.ground_points / (sm.km2 * 1e6) * 10) / 10;
    out.pointsStored = fs.existsSync(path.join(areaDir(id), 'points', 'points.json'));
    const a = readArea(id); const m = a && a.results && a.results.ground && a.results.ground.maps; if (m) out.made = m.cell;
    return out;
  }
  /** The maps step: never fatal for the rest of the run (the maps at the ground's cell stay). Returns the record or null. */
  async function mapsStep(job, step, id, cell, options, notes) {
    const DIR = areaDir(id), a = readArea(id) || {};
    const bo = options.bush || {}, rb = a.results && a.results.bush;
    const band = Array.isArray(bo.veg_band) && bo.veg_band.length === 2 && bo.veg_band.every(num) && bo.veg_band[1] > bo.veg_band[0] ? bo.veg_band : (rb && Array.isArray(rb.band) ? rb.band : [0.3, 1.5]);
    const args = [mapsScript, DIR, '--maps-cell', String(cell), '--band', String(band[0]), String(band[1])];
    if (num(bo.void_depth) && bo.void_depth < 0 && bo.void_depth >= -100) args.push('--void-depth', String(bo.void_depth));
    if (num(bo.void_min_points) && bo.void_min_points >= 1 && bo.void_min_points <= 1000) args.push('--void-min', String(Math.round(bo.void_min_points)));
    if (!rb && !fs.existsSync(path.join(DIR, 'bush'))) args.push('--no-brush');
    const t0 = Date.now(), r = await runScript(job, step, args, notes);
    const gm = readJson(path.join(DIR, 'ground', 'maps.json'));
    if (r.code !== 0 || !gm || gm.maps_cell !== cell) return { error: whyFailed(r.errLines, r.code) };
    return { cell, band: args.includes('--no-brush') ? null : band, cellsWithGround: num(gm.cells_with_ground) ? gm.cells_with_ground : null, date: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10 };
  }
  /** A run of only the maps: from the stored points, no LiDAR read; the ground and the other results stay. */
  function runMaps(o) {
    if (!ID_RE.test(String(o.id || ''))) return { code: 400, error: 'Choose a processed area for the maps.' };
    const area = readArea(o.id); if (!area) return { code: 404, error: 'Unknown area' };
    if (!hasGround(area.id)) return { code: 400, error: 'This area has no ground yet: run a tool on it first.' };
    if (!fs.existsSync(path.join(areaDir(area.id), 'points', 'points.json'))) return { code: 400, error: 'The points of this area are not stored on this computer, so its maps cannot be remade without reading the LiDAR: run Ground again.' };
    const options = o.options && typeof o.options === 'object' ? o.options : {};
    const mc = mapsCellOf(options);
    if (!mc) return { code: 400, error: 'Choose a map detail in metres (Auto is the ground\'s own cell, made with the ground).' };
    if (mc.error) return { code: 400, error: mc.error };
    if (running(area.id)) return { code: 409, error: 'This area is already being processed' };
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const steps = [{ key: 'maps', label: LABEL.maps, status: 'pending', frac: 0 }];
    const job = jobs[runId] = { status: 'running', progress: [], notes: [], steps, areaId: area.id, name: 'Analyze: ' + area.name, label: 'Analyze: ' + area.name,
      error: null, started: Date.now(), ended: null, cancelled: false, proc: null };
    (async () => {
      const step = steps[0];
      try {
        step.status = 'running'; job.progress.push(`== ${LABEL.maps} ==`);
        const notes = [];
        const m = await mapsStep(job, step, area.id, mc.cell, options, notes);
        if (m.error) throw new Error(m.error);
        const a = readArea(area.id); if (a && a.results && a.results.ground) { a.results.ground.maps = m; writeArea(a); }
        step.status = 'done'; step.frac = 1; job.status = 'done';
      } catch (e) {
        job.status = 'error'; job.error = job.cancelled ? 'Cancelled' : (e.message || String(e)); step.status = 'error'; job.progress.push('! ' + job.error);
      } finally { job.ended = Date.now(); job.proc = null; }
    })();
    return { ok: true, runId, areaId: area.id };
  }

  async function check(o) {
    const r = cleanRing(o.ring);
    if (r.error) return { error: r.error };
    const km2 = r.km2, lidar = cleanUrls(o.lidar), options = o.options && typeof o.options === 'object' ? o.options : {};
    const tools = (Array.isArray(o.tools) && o.tools.length ? o.tools : TOOLS).filter((t, i, a) => TOOLS.includes(t) && a.indexOf(t) === i);
    const cov = await coverage(r.ring, lidar);
    const covWords = cov == null ? '' : `LiDAR covers ${Math.round(cov * 100)} % of this area: the rest stays empty.`;
    const needs = !lidar.length || cov === 0;
    const needsWhy = !lidar.length ? 'Choose the LiDAR to use (a point cloud loaded or in the project).' : 'The chosen LiDAR does not reach this area.';
    const out = {};
    const ground = needs ? { status: 'needslidar', why: needsWhy, offers: [], minutes: 0 }
      : km2 > LIMITS.ground.max ? { status: 'toobig', why: `${km2.toFixed(1)} km² is more than ${LIMITS.ground.max} km²: choose a smaller area.`, offers: [], minutes: 0 }
      : { status: cov != null && cov < 0.98 ? 'partly' : 'fits', why: cov != null && cov < 0.98 ? covWords : '', offers: [], minutes: minutesOf('ground', km2) };
    if (cov != null) ground.coverage = Math.round(cov * 1000) / 1000;
    const groundMade = hasGround(o.id);
    const maps = mapsInfo(o.id, km2, options);
    for (const t of tools) {
      if (t === 'prospect' && groundMade) { out[t] = { status: 'fits', why: 'Uses the ground already made for this area: no LiDAR is read.', offers: [], minutes: minutesOf('prospect', km2) }; continue; }
      if (needs) { out[t] = { status: 'needslidar', why: needsWhy, offers: [], minutes: 0 }; continue; }
      const j = t === 'prospect' ? { status: 'fits', why: '', offers: [], minutes: minutesOf('prospect', km2), coarse: false } : judge(t, km2, options);
      if (j.status === 'fits' && cov != null && cov < 0.98) { j.status = 'partly'; j.why = (covWords + ' ' + j.why).trim(); }
      if (t === 'ridge') { if (j.status !== 'toobig') j.why = (j.why + ' ' + RIDGE_WHY).trim(); out[t] = j; continue; }      // (its own read: the ground's limit is not its limit)
      if (ground.status === 'toobig' && j.status !== 'toobig') { j.status = 'toobig'; j.why = ground.why; j.offers = []; }
      out[t] = j;
    }
    return { ok: true, km2, tools: out, ground, maps };
  }

  // ── the store ──────────────────────────────────────────────────────────────
  function listAll() {
    let names = [];
    try { names = fs.readdirSync(root).filter(n => ID_RE.test(n)); } catch (_) {}
    return names.map(readArea).filter(a => a && a.id);
  }
  function list(query) {
    const hasP = query && query.project != null;
    const pr = hasP ? String(query.project) : null;
    const a = listAll().filter(x => pr == null || !x.project || x.project === pr);
    a.sort((x, y) => String(y.updated || y.created).localeCompare(String(x.updated || x.created)));
    return { ok: true, areas: a };
  }
  function save(o) {
    const r = cleanRing(o.ring);
    if (r.error) return { code: 400, error: r.error };
    const project = cleanProject(o.project);
    if (project === null) return { code: 400, error: 'bad project id' };
    let a = null;
    if (o.id != null && o.id !== '') {
      if (!ID_RE.test(String(o.id))) return { code: 400, error: 'bad id' };
      a = readArea(o.id);
      if (!a) return { code: 404, error: 'Unknown area' };
    }
    const now = new Date().toISOString();
    if (!a) a = { id: newId(), created: now, lidar: [], results: {} };
    a.name = cleanName(o.name, a.name || 'Area');
    a.ring = r.ring; a.km2 = r.km2;
    if (o.project !== undefined || !('project' in a)) a.project = project;
    writeArea(a);
    return { ok: true, area: a };
  }
  function rename(o) {
    const a = readArea(o.id);
    if (!a) return { code: ID_RE.test(String(o.id || '')) ? 404 : 400, error: ID_RE.test(String(o.id || '')) ? 'Unknown area' : 'bad id' };
    a.name = cleanName(o.name, a.name); writeArea(a);
    return { ok: true, area: a };
  }
  const running = id => Object.values(jobs).some(j => j.status === 'running' && j.areaId === id);
  function del(o) {
    if (!ID_RE.test(String(o.id || ''))) return { code: 400, error: 'bad id' };
    if (!readArea(o.id)) return { code: 404, error: 'Unknown area' };
    if (running(o.id)) return { code: 409, error: 'This area is being processed: wait for it to finish' };
    fs.rmSync(areaDir(o.id), { recursive: true, force: true });
    return { ok: true };
  }
  function delResult(o) {
    if (!ID_RE.test(String(o.id || ''))) return { code: 400, error: 'bad id' };
    if (!RESULTS.includes(o.result)) return { code: 400, error: 'bad result' };
    const a = readArea(o.id);
    if (!a) return { code: 404, error: 'Unknown area' };
    if (running(o.id)) return { code: 409, error: 'This area is being processed: wait for it to finish' };
    fs.rmSync(path.join(areaDir(o.id), o.result), { recursive: true, force: true });
    if (o.result === 'ground') fs.rmSync(path.join(areaDir(o.id), 'points'), { recursive: true, force: true });
    if (a.results) delete a.results[o.result];
    writeArea(a);
    return { ok: true, area: a };
  }

  // ── run ────────────────────────────────────────────────────────────────────
  const PY = () => python;
  /** Run one script: lines to the job, NOTE: lines to `notes` → Promise<{ code, errLines }> */
  function runScript(job, step, args, notes) {
    return new Promise(resolve => {
      const errLines = [];
      let proc;
      try { proc = spawn(PY(), args, { cwd: path.dirname(args[0]), env: Object.assign({}, process.env, { FLEX_APP_DIR: __dirname }) }); }
      catch (e) { return resolve({ code: -1, errLines: ['could not start Python: ' + e.message] }); }
      job.proc = proc;
      const take = err => d => d.toString().split('\n').forEach(l => {
        l = l.replace(/\r$/, '').trimEnd(); if (!l.trim()) return;
        const m = /^NOTE:\s*(.*)$/.exec(l.trim());
        if (m) { notes.push(m[1]); job.notes.push(m[1]); }
        if (err) { job.progress.push('! ' + l.trim()); errLines.push(l); } else { job.progress.push(l.trim()); if (/^!\s/.test(l)) errLines.push(l.replace(/^!\s*/, '')); }
        const p = /\[(\d+)\/(\d+)\]/.exec(l); if (p && +p[2] > 0) step.frac = Math.min(0.95, +p[1] / +p[2]);
        const rp = /^\[ridge\]\s+(\d+)%/.exec(l.trim()); if (rp) step.frac = Math.min(0.97, +rp[1] / 100);        // ridgewalk.py's own percent
      });
      proc.stdout.on('data', take(false));
      proc.stderr.on('data', take(true));
      proc.on('error', e => { errLines.push(`could not run ${python} (${e.code || e.message}): set FLEX_PYTHON to the Python that has PDAL`); });
      proc.on('close', code => { job.proc = null; resolve({ code, errLines }); });
    });
  }
  const whyFailed = (errLines, code) => {
    const lines = errLines.filter(l => !/^\s*File "|^\s+\S/.test(l));
    return ((lines.length ? lines : errLines).slice(-3).map(l => l.replace(/^!\s*/, '')).join(' | ') || 'it wrote nothing') + ` (exit ${code})`;
  };
  /** options.prospect.known → { points: [{ lon, lat, name }] } (up to MAX_KNOWN) or { error }. Accepts [{lon,lat,name}], [[lon,lat,name?]] or a GeoJSON FeatureCollection of points. */
  const MAX_KNOWN = 5000;
  function cleanKnown(k) {
    if (k == null) return { points: [] };
    let list = k && k.type === 'FeatureCollection' ? k.features : k;
    if (!Array.isArray(list)) return { error: 'Prospects: the known points must be a list.' };
    if (list.length > MAX_KNOWN) return { error: `Prospects: at most ${MAX_KNOWN} known points (got ${list.length}).` };
    const pts = [];
    for (const f of list) {
      let lon, lat, name;
      if (Array.isArray(f)) { lon = f[0]; lat = f[1]; name = f[2]; }
      else if (f && f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates)) { lon = f.geometry.coordinates[0]; lat = f.geometry.coordinates[1]; name = f.properties && (f.properties.name || f.properties.title); }
      else if (f && typeof f === 'object') { lon = f.lon; lat = f.lat; name = f.name; }
      if (!lonlat([lon, lat])) return { error: 'Prospects: a known point has no valid longitude and latitude.' };
      pts.push({ lon: +lon, lat: +lat, name: cleanName(name, '').slice(0, 60) });
    }
    return { points: pts };
  }
  const sources = lidar => ({ ept: lidar[0], ept_also: lidar.slice(1) });

  /** The terrain step: the Terrain panel's generation, called in-process; waits for its job. */
  async function terrainStep(job, step, area, lidar, options, notes) {
    const s = settingsOf('terrain', options);
    const payload = { project: area.project || undefined, dest: area.project ? undefined : 'mine', bbox: bboxOf(area.ring), polygon: area.ring.slice(0, -1),
      ept: lidar, resolution: s.cell, name: area.name, area: area.id };
    const req = Readable.from([JSON.stringify(payload)]); req.method = 'POST';
    const answer = await new Promise(resolve => {
      let txt = '';
      const res = { writeHead() {}, end(t) { txt += t || ''; resolve(txt); } };
      terrainGen.handle(req, res, 'generate', {});
    });
    let a; try { a = JSON.parse(answer); } catch (_) { a = {}; }
    if (!a.ok || !a.jobId) throw new Error(a.error || 'the terrain could not be started');
    const tj = terrainGen.jobs[a.jobId];
    let seen = 0;
    while (tj && tj.status === 'running') {
      job.proc = tj.proc || null;
      for (; seen < tj.progress.length; seen++) {
        const l = tj.progress[seen].replace(/^⚠ /, ''); job.progress.push(l);
        const m = /^NOTE:\s*(.*)$/.exec(l); if (m) { notes.push(m[1]); job.notes.push(m[1]); }
        const p = /\[(\d)\/4\]/.exec(l); if (p) step.frac = +p[1] / 5;
      }
      if (job.cancelled && tj.proc) { try { tj.proc.kill(); } catch (_) {} }
      await new Promise(r => setTimeout(r, pollMs || 400));
    }
    job.proc = null;
    if (!tj || tj.status !== 'done') throw new Error((tj && tj.error) || 'the terrain was not made');
    const dir = path.join(areaDir(area.id), 'terrain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ref.json'), JSON.stringify({ ref: tj.result || null, project: area.project || 'mine', cell: s.cell }));
    const R = tj.result || {}, T = R.terrain || {};
    // what the browser needs to register the layers exactly as the Terrain panel does (ter-/hs- records)
    return { coarse: s.coarse, cell: s.cell, blob: T.blob || '', bounds: T.bounds || null, dest: area.project || 'mine', job: { name: R.name, folder: R.folder, terrain: R.terrain, terrains: R.terrains, tiles: R.tiles } };
  }

  function sameGround(a, lidar, cellReq) {
    const g = a.results && a.results.ground;
    return !!(g && g.cellReq === cellReq && g.ringKey === ringKey(a.ring) && JSON.stringify(a.lidar || []) === JSON.stringify(lidar) &&
      fs.existsSync(path.join(areaDir(a.id), 'ground', 'grid.json')));
  }
  function setResult(id, key, res) {
    const a = readArea(id); if (!a) return;
    a.results = a.results || {}; a.results[key] = res; writeArea(a);
  }

  async function execute(job, id, tools, options, lidar) {
    const DIR = areaDir(id);
    const cellO = options.ground && options.ground.cell;
    const cellReq = num(cellO) && cellO > 0 ? cellO : 'auto';
    for (const step of job.steps) {
      if (job.cancelled) throw new Error('Cancelled');
      const t0 = Date.now(), notes = [], key = step.key;
      step.status = 'running'; job.progress.push(`== ${LABEL[key]} ==`);
      const area = readArea(id);
      let res = null;
      if (key === 'ground') {
        if (sameGround(area, lidar, cellReq)) { step.status = 'skipped'; job.progress.push('Ground already made for this area: reused'); continue; }
        fs.rmSync(path.join(DIR, 'ground'), { recursive: true, force: true });
        const pf = path.join(DIR, 'ground-params.json');
        fs.writeFileSync(pf, JSON.stringify({ source: sources(lidar), area: area.ring, cell: cellReq, keep_points: true }));
        const r = await runScript(job, step, [groundScript, '--params', pf, '--area-dir', DIR], notes);
        if (r.code !== 0 || !fs.existsSync(path.join(DIR, 'ground', 'grid.json'))) throw new Error(whyFailed(r.errLines, r.code));
        const sm = readJson(path.join(DIR, 'ground', 'summary.json')) || {}, gr = readJson(path.join(DIR, 'ground', 'grid.json')) || {};
        let pits = num(sm.pits) ? sm.pits : (sm.pits && num(sm.pits.count) ? sm.pits.count : null);
        if (pits == null) { const pg = readJson(path.join(DIR, 'ground', 'pits.geojson')); pits = pg && Array.isArray(pg.features) ? pg.features.length : 0; }
        res = { cell: num(sm.cell) ? sm.cell : (num(gr.cell) ? gr.cell : null), cellReq, ringKey: ringKey(area.ring), coverage: num(sm.coverage) ? sm.coverage : null, pits, coarse: false };
        fs.rmSync(pf, { force: true });
      } else if (key === 'prospect') {
        if (!fs.existsSync(path.join(DIR, 'ground', 'grid.json'))) throw new Error('the ground of this area is not made');
        const kn = cleanKnown(options.prospect && options.prospect.known).points;
        fs.rmSync(path.join(DIR, 'prospect'), { recursive: true, force: true });
        fs.mkdirSync(path.join(DIR, 'prospect'), { recursive: true });
        const pf = path.join(DIR, 'prospect-params.json'), kf = path.join(DIR, 'prospect-known.json');
        const params = {};
        if (kn.length) {
          fs.writeFileSync(kf, JSON.stringify({ type: 'FeatureCollection', features: kn.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { name: p.name } })) }));
          params.known = kf;
        }
        fs.writeFileSync(pf, JSON.stringify(params));
        const r = await runScript(job, step, [prospectScript, '--area-dir', DIR, '--out', path.join(DIR, 'prospect'), '--params', pf], notes);
        const sm = readJson(path.join(DIR, 'prospect', 'summary.json'));
        fs.rmSync(pf, { force: true }); fs.rmSync(kf, { force: true });
        if (r.code !== 0 || !sm) throw new Error(whyFailed(r.errLines, r.code));
        const c = sm.counts || {}, iso = sm.isolated || {};
        res = { coarse: false, known: kn.length, counts: { A: c.A || 0, B: c.B || 0, C: c.C || 0, isolated: (iso.B || 0) + (iso.C || 0) } };
      } else if (key === 'veg') {
        const o = (options.veg || {}), s = settingsOf('veg', options);
        const looks = (Array.isArray(o.looks) ? o.looks : ['shapes', 'shell']).filter((x, i, a) => ['shapes', 'shell'].includes(x) && a.indexOf(x) === i);
        const params = { source: sources(lidar), area: area.ring, looks: looks.length ? looks : ['shapes', 'shell'], detail: s.detail,
          min_height: num(o.min_height) ? Math.min(20, Math.max(0, o.min_height)) : 0.5, brush_top: num(o.brush_top) ? Math.min(50, Math.max(0.2, o.brush_top)) : 2,
          max_triangles: Math.round(num(o.max_triangles) ? Math.min(1e6, Math.max(2e4, o.max_triangles)) : 3e5) };
        if (!(params.brush_top > params.min_height)) params.brush_top = Math.min(50, params.min_height + 1.5);
        if (!params.source.ept_also.length) delete params.source.ept_also;
        fs.rmSync(path.join(DIR, 'veg'), { recursive: true, force: true });
        fs.mkdirSync(path.join(DIR, 'veg'), { recursive: true });
        const pf = path.join(DIR, 'veg-params.json'); fs.writeFileSync(pf, JSON.stringify(params));
        const r = await runScript(job, step, [vegScript, '--params', pf, '--out', path.join(DIR, 'veg'), '--area-dir', DIR], notes);
        const v = readJson(path.join(DIR, 'veg', 'veg.json'));
        if (r.code !== 0 || !v) throw new Error(whyFailed(r.errLines, r.code));
        const sh = v.shapes || {};
        res = { coarse: s.coarse, detail: s.detail, summary: { trees: sh.trees || 0, brush: sh.brush || 0, triangles: v.shell && v.shell.triangles ? v.shell.triangles : 0 } };
        fs.rmSync(pf, { force: true });
      } else if (key === 'bush') {
        const s = settingsOf('bush', options);
        fs.rmSync(path.join(DIR, 'bush'), { recursive: true, force: true });
        fs.mkdirSync(path.join(DIR, 'bush'), { recursive: true });
        const args = [lidarScript, '--ept', lidar[0], '--bbox', ...bboxOf(area.ring).map(String), '--out-dir', path.join(DIR, 'bush'), '--area-dir', DIR];
        const bo = options.bush || {};
        if (num(bo.cell) && bo.cell > 0) args.push('--cell', String(s.cell));
        // The height band counted as brush (metres above ground) and the voids settings, when the screen sends them.
        const vb = Array.isArray(bo.veg_band) && bo.veg_band.length === 2 && bo.veg_band.every(num) && bo.veg_band[0] >= 0 && bo.veg_band[1] > bo.veg_band[0] && bo.veg_band[1] <= 50 ? bo.veg_band : null;
        if (vb) args.push('--veg-band', String(vb[0]), String(vb[1]));
        if (num(bo.void_depth) && bo.void_depth < 0 && bo.void_depth >= -100) args.push('--void-depth', String(bo.void_depth));
        if (num(bo.void_min_points) && bo.void_min_points >= 1 && bo.void_min_points <= 1000) args.push('--void-min-points', String(Math.round(bo.void_min_points)));
        if (num(bo.low_cut) && bo.low_cut < 0 && bo.low_cut >= -500) args.push('--low-cut', String(bo.low_cut));
        const r = await runScript(job, step, args, notes);
        if (r.code !== 0 || !fs.existsSync(path.join(DIR, 'bush', 'derived.json'))) throw new Error(whyFailed(r.errLines, r.code));
        res = { coarse: s.coarse, cell: s.cell, band: vb || [0.3, 1.5] };
      } else if (key === 'ridge') {
        // ridgewalk.py for the area's ring (its own read of the LiDAR, in tiles), then ridge_area.py: the small files the map draws.
        const out = path.join(DIR, 'ridge');
        fs.rmSync(out, { recursive: true, force: true });
        fs.mkdirSync(out, { recursive: true });
        const rf = path.join(DIR, 'ridge-ring.json');
        fs.writeFileSync(rf, JSON.stringify(area.ring.slice(0, -1)));
        const args = [ridgeScript, '--ept', lidar[0]];
        lidar.slice(1).forEach(u => args.push('--also-ept', u));
        args.push('--bbox', ...bboxOf(area.ring).map(String), '--polygon', rf, '--out', out);
        const r = await runScript(job, step, args, notes);
        fs.rmSync(rf, { force: true });
        const rj = readJson(path.join(out, 'ridge.json'));
        if (r.code !== 0 || !rj) throw new Error(whyFailed(r.errLines, r.code));
        if (job.cancelled) throw new Error('Cancelled');
        const r2 = await runScript(job, step, [ridgeAreaScript, out], notes);
        if (r2.code !== 0 || !fs.existsSync(path.join(out, 'draw.json'))) throw new Error(whyFailed(r2.errLines, r2.code));
        const c = rj.counts || {};
        res = { coarse: false, cell: rj.cell, counts: { features: c.features || 0, below: c.below || 0, true_cells: c.true_cells || 0, guessed_cells: c.guessed_cells || 0, pattern_noise: c.pattern_noise || 0 } };
        (Array.isArray(rj.notes) ? rj.notes : []).filter(n => /flight pass|pattern|no /i.test(String(n)) && String(n).length < 200).slice(0, 3).forEach(n => notes.push(String(n)));
      } else if (key === 'maps') {
        const mc = mapsCellOf(options), g = area.results && area.results.ground;
        const fresh = job.steps.some(x => (x.key === 'ground' || x.key === 'bush') && x.status === 'done');
        if (!mc || !g || (!fresh && g.maps && g.maps.cell === mc.cell)) { step.status = 'skipped'; job.progress.push('Maps already at this detail: kept'); continue; }
        const m = await mapsStep(job, step, id, mc.cell, options, notes);
        if (m.error) { const w = 'The detailed maps could not be made (' + m.error + '): the maps at the ground\'s cell are shown.'; notes.push(w); job.notes.push(w); step.status = 'skipped'; continue; }
        const a2 = readArea(id); if (a2 && a2.results && a2.results.ground) { a2.results.ground.maps = m; writeArea(a2); }
        step.status = 'done'; step.frac = 1; continue;
      } else if (key === 'terrain') {
        const r = await terrainStep(job, step, area, lidar, options, notes);
        res = r;
      }
      res.date = new Date().toISOString();
      res.seconds = Math.round((Date.now() - t0) / 100) / 10;
      res.bytes = dirBytes(path.join(DIR, key));
      res.notes = notes;
      setResult(id, key, res);
      step.status = 'done'; step.frac = 1;
    }
  }

  async function run(o) {
    const lidar = cleanUrls(o.lidar);
    const onlyMaps = Array.isArray(o.tools) && o.tools.length > 0 && o.tools.every(t => t === 'maps');
    if (onlyMaps) return runMaps(o);
    const onlyProspect = Array.isArray(o.tools) && o.tools.length > 0 && o.tools.every(t => t === 'prospect');
    if (!lidar.length && !(onlyProspect && hasGround(o.id))) return { code: 400, error: 'Choose the LiDAR to use (a point cloud loaded or in the project).' };
    const tools = (Array.isArray(o.tools) ? o.tools : []).filter((t, i, a) => TOOLS.includes(t) && a.indexOf(t) === i);
    if (!tools.length) return { code: 400, error: 'Tick at least one tool to run.' };
    const options = o.options && typeof o.options === 'object' ? o.options : {};
    let area;
    if (o.id != null && o.id !== '') {
      if (!ID_RE.test(String(o.id))) return { code: 400, error: 'bad id' };
      area = readArea(o.id);
      if (!area) return { code: 404, error: 'Unknown area' };
      if (o.ring != null) { const s = save({ id: o.id, name: o.name || area.name, ring: o.ring, project: o.project }); if (!s.ok) return s; area = s.area; }
    } else {
      const s = save({ name: o.name, ring: o.ring, project: o.project });
      if (!s.ok) return s;
      area = s.area;
    }
    if (running(area.id)) return { code: 409, error: 'This area is already being processed' };
    if (tools.includes('prospect')) { const kc = cleanKnown(options.prospect && options.prospect.known); if (kc.error) return { code: 400, error: kc.error }; }
    const c = await check({ ring: area.ring, lidar, tools, options, id: area.id });
    if (!c.ok) return { code: 400, error: c.error };
    const bad = tools.filter(t => c.tools[t].status === 'toobig' || c.tools[t].status === 'needslidar');
    if (bad.length) return { code: 400, error: bad.map(t => `${LABEL[t]}: ${c.tools[t].why}`).join(' ') };
    const skipGround = (onlyProspect && hasGround(area.id)) || !needsGround(tools);      // Ridgewalking alone needs no ground
    if (c.ground.status === 'toobig' && !skipGround) return { code: 400, error: c.ground.why };
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const mc = mapsCellOf(options); if (mc && mc.error) return { code: 400, error: mc.error };
    const steps = (skipGround ? [] : ['ground']).concat(['prospect', 'veg', 'bush'].filter(t => tools.includes(t)), mc && mc.cell && !onlyProspect && needsGround(tools) ? ['maps'] : [], tools.includes('ridge') ? ['ridge'] : [], tools.includes('terrain') ? ['terrain'] : []).map(k => ({ key: k, label: LABEL[k], status: 'pending', frac: 0 }));
    const job = jobs[runId] = { status: 'running', progress: [], notes: [], steps, areaId: area.id, name: 'Analyze: ' + area.name, label: 'Analyze: ' + area.name,
      error: null, started: Date.now(), ended: null, cancelled: false, proc: null };
    if (c.ground.status === 'partly' && c.ground.why) job.notes.push(c.ground.why);
    (async () => {
      try {
        await execute(job, area.id, tools, options, lidar);
        job.status = 'done';
      } catch (e) {
        job.status = 'error'; job.error = job.cancelled ? 'Cancelled' : (e.message || String(e));
        const st = steps.find(s => s.status === 'running'); if (st) st.status = 'error';
        job.progress.push('! ' + job.error);
      } finally {
        job.ended = Date.now(); job.proc = null;
        const a = readArea(area.id); if (a && lidar.length) { a.lidar = lidar; writeArea(a); }
        try { fs.writeFileSync(path.join(areaDir(area.id), 'log.txt'), job.progress.join('\n') + '\n'); } catch (_) {}
      }
    })();
    return { ok: true, runId, areaId: area.id };
  }

  function pctOf(job) {
    if (job.status === 'done' || job.status === 'error') return 100;
    const n = job.steps.length || 1;
    let s = 0; job.steps.forEach(st => { s += st.status === 'done' || st.status === 'skipped' ? 1 : st.status === 'running' ? (st.frac || 0.05) : 0; });
    return Math.min(97, Math.max(2, Math.round(s / n * 100)));
  }
  function status(res, id) {
    const job = ID_RE.test(String(id || '')) && Object.prototype.hasOwnProperty.call(jobs, id) ? jobs[id] : null;
    if (!job) return json(res, { ok: false, error: 'Unknown run' }, 404);
    const cur = job.steps.find(s => s.status === 'running') || job.steps.slice().reverse().find(s => s.status === 'error');
    json(res, { ok: true, status: job.status, step: cur ? cur.key : '', steps: job.steps.map(s => ({ key: s.key, label: s.label, status: s.status })), progress: pctOf(job),
      message: job.progress[job.progress.length - 1] || '', notes: job.notes.slice(), error: job.error, areaId: job.areaId });
  }

  function file(res, rest) {
    const p = rest.split('/');
    const [id, result, name] = p;
    if (p.length !== 3 || !ID_RE.test(String(id)) || !FILES[result] || !FILES[result].test(name || '')) return json(res, { ok: false, error: 'Not found' }, 404);
    const f = path.join(areaDir(id), result, name);
    fs.stat(f, (err, st) => {
      if (err || !st.isFile()) return json(res, { ok: false, error: 'Not found' }, 404);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
  }

  /** An area package (tools/area_pack.js) into the store; the same allow-list as file(). */
  function importPack(req, res, query) {
    const chunks = []; let n = 0, dead = false;
    req.on('data', c => { n += c.length; if (n > IMPORT_MAX) { dead = true; json(res, { ok: false, error: 'the package is too large' }, 413); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (dead) return;
      require('./tools/area_pack.js').unpack(Buffer.concat(chunks), root, FILES, { overwrite: String((query || {}).overwrite || '') === '1' })
        .then(r => json(res, r))
        .catch(e => json(res, { ok: false, error: e.message || String(e), exists: e.code === 'EXISTS' }, e.code === 'EXISTS' ? 409 : 400));
    });
  }

  /** /api/areas[/<rest>] */
  function handle(req, res, rest, query) {
    const fail = e => json(res, { ok: false, error: e.message || String(e) }, 500);
    const post = fn => body(req).then(b => { let o; try { o = JSON.parse(b || '{}'); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
      return Promise.resolve(fn(o || {})).then(r => (r && r.error ? json(res, { ok: false, error: r.error }, r.code || 400) : json(res, r))); }).catch(fail);
    try {
      if (req.method === 'GET' && rest === '') return json(res, list(query));
      if (req.method === 'POST' && rest === 'save') return void post(save);
      if (req.method === 'POST' && rest === 'rename') return void post(rename);
      if (req.method === 'POST' && rest === 'delete') return void post(del);
      if (req.method === 'POST' && rest === 'delete-result') return void post(delResult);
      if (req.method === 'POST' && rest === 'check') return void post(check);
      if (req.method === 'POST' && rest === 'run') return void post(run);
      if (req.method === 'GET' && rest.startsWith('status/')) return status(res, rest.slice(7));
      if (req.method === 'GET' && rest.startsWith('file/')) return file(res, rest.slice(5));
      if (req.method === 'GET' && rest.startsWith('tiles/')) return tiles.tile(res, rest.slice(6), query);
      if (req.method === 'GET' && rest.startsWith('maps/')) return tiles.maps(res, rest.slice(5));
      if (req.method === 'POST' && rest === 'import') return importPack(req, res, query);
      return json(res, { ok: false, error: 'not found' }, 404);
    } catch (e) { return fail(e); }
  }
  return { jobs, pctOf, handle, check, LIMITS };
};
module.exports.FILES = FILES;
