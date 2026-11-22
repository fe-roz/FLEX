// sync_build.js — results made on a FLEX server (processed areas: terrain, prospects) as project-library entries, and a
// sync file (FLEX-sync-….zip, the same format as 📁 Project → Sync files → Make) carrying only this server's own entries,
// for a computer that already has the project.
//
// Everything goes through a running FLEX's HTTP API (/api/lib/*, /api/areas/*), so the server keeps numbering its own
// entries (its device id: GET /api/lib/device) and nothing touches its files behind its back.
//
//   node tools/sync_build.js record    --base URL --project PID --area AREA [--prospects] [--who NAME]
//        terrain/ref.json → the Terrain panel's two kinds of layer.set (terrain patches + the hillshade tiles link), and
//        with --prospects the area's filtered candidates as feature.set points in one group.set folder. Idempotent:
//        what the project already has the same is not written again.
//   node tools/sync_build.js footprint --base URL --project PID --ring ring.json
//        project.footprint, for this server only (pack leaves it out by default: the other computer keeps its own).
//   node tools/sync_build.js pack      --base URL --project PID --out FILE.zip [--skip project.footprint,project.set]
//        → the sync file: manifest.json, logs/p-<pid>/log-<this server's dev>.jsonl, blobs/<sha>.<ext> (the terrain .bin).
//
// The manifest names the project with an empty name on purpose: importing a sync file sets the project's name from the
// manifest when it is not empty (project-history.js importSync → POST /api/lib/projects), and the receiving computer's
// name must stay as it is. Hillshade tiles are folder files (FLEX maps/<name>/), not entries: they do not travel here;
// the tiles link carries ?dem=<patch blobs>, so the receiving FLEX draws the hillshade from the terrain patches.
'use strict';
const http = require('http');
const https = require('https');
const FL = require('../viewer_build/libs/flexlib.js');
const JSZip = require('../viewer_build/libs/jszip.min.js');

// Only for this server: never in a sync file unless asked (they would replace the receiving project's own fields).
const LOCAL_OPS = ['project.footprint', 'project.set', 'project.archive', 'project.lists'];

// ── Pure parts (tested in tools/test_sync_build.js) ─────────────────────────
const fix8 = b => b.map(n => +(+n).toFixed(8));
/** terrain/ref.json of an area → the layer.set bodies keep() in terrain-panel.js writes (ids ter-/hs- + 12 hex). */
function terrainEntries(ref) {
  const R = ref && (ref.ref || ref);
  if (!R || !R.terrain || !R.tiles || !R.terrain.blob) return [];
  const T = R.terrain, H = R.tiles, nm = R.name || 'LiDAR terrain';
  const parts = Array.isArray(R.terrains) && R.terrains.length ? R.terrains : [T];
  const out = parts.map((P, k) => ({ op: 'layer.set', layer: 'ter-' + P.blob.slice(0, 12), kind: 'terrain', blob: P.blob, bounds: fix8(P.bounds),
    name: parts.length > 1 ? `${nm} (part ${k + 1})` : nm, removed: false }));
  out.push({ op: 'layer.set', layer: 'hs-' + T.blob.slice(0, 12), kind: 'tiles', url: H.url, bounds: fix8(H.bounds), minZoom: H.minzoom, maxZoom: H.maxzoom,
    name: nm + ' hillshade', removed: false });
  return out;
}

// The default filter of 🔬 Analyze → Prospects (area-prospects.js DEFAULTS / passes).
const PROSPECT_FILTER = { A: true, B: true, C: true, minPoints: 8, minDepth: 1.5, measured: true, hideWide: true, isolated: false };
function passes(p, f) {
  if (!p || !f[p.kind]) return false;
  if (p.isolated === true) return !!f.isolated && !(f.hideWide && p.wide === true);
  if (p.kind === 'A') return !f.measured || (+p.measured || 0) >= 0.5;
  if ((+p.points || 0) < f.minPoints) return false;
  if ((+p.depth_median_m || 0) < f.minDepth) return false;
  return !(f.hideWide && p.wide === true);
}
const COLOUR = { A: '#4ea1ff', B: '#ff5fc8', C: '#ffd23f' };
const KIND = { A: 'sink', B: 'below the ground', C: 'cliff opening' };
/**
 * candidates.geojson → [group.set, feature.set…]: one folder "Prospects <area> <day>", one point per candidate that passes
 * the filter, ids prospect-<area>-<candidate id> (as Analyze → Add shown to My data names them), the candidate kept in style.prospect.
 */
function prospectEntries(geo, areaId, areaName, day, filter) {
  const f = Object.assign({}, PROSPECT_FILTER, filter || {});
  const feats = ((geo && geo.features) || []).filter(x => x && x.geometry && x.geometry.type === 'Point' && x.properties && passes(x.properties, f));
  if (!feats.length) return [];
  const group = 'prospects-' + areaId;
  const out = [{ op: 'group.set', group, name: `Prospects ${areaName || 'area'} ${day}`.slice(0, 80), parent: '', removed: false }];
  feats.forEach(x => {
    const p = x.properties, c = x.geometry.coordinates;
    const facts = [KIND[p.kind] || p.kind, p.points != null ? p.points + ' returns' : '', p.depth_median_m != null ? 'median depth ' + p.depth_median_m + ' m' : '',
      p.depth_m != null ? 'deepest ' + p.depth_m + ' m' : '', p.area_m2 != null ? p.area_m2 + ' m2' : '', p.span_m != null ? 'span ' + p.span_m + ' m' : '',
      p.measured != null ? 'ground measured ' + Math.round(p.measured * 100) + ' %' : ''].filter(Boolean).join(', ');
    out.push({ op: 'feature.set', feature: 'prospect-' + areaId + '-' + p.id, kind: 'point', coords: [[+(+c[0]).toFixed(8), +(+c[1]).toFixed(8)]],
      name: String(p.title || `${p.kind} ${p.id}`).slice(0, 120), desc: [p.description || '', `Candidate ${p.id} (${facts})`].filter(Boolean).join('\n').slice(0, 4000),
      group, style: { color: COLOUR[p.kind] || '#ffffff', prospect: { id: p.id, kind: p.kind, area: areaId } }, removed: false });
  });
  return out;
}

/** Of `bodies`, those the project (replayed) does not already have the same. */
function missing(S, bodies) {
  const same = (cur, b) => cur && Object.keys(b).every(k => k === 'op' || k === 'layer' || k === 'feature' || k === 'group' ||
    (k === 'removed' ? !!cur.removed === !!b.removed : JSON.stringify(k === 'coords' ? cur.coords : cur[k]) === JSON.stringify(k === 'coords' ? b.coords.map(c => c.slice(0, 3).map(Number)) : b[k])));
  return bodies.filter(b => !(b.op === 'layer.set' ? same(S.layers[b.layer], b) : b.op === 'feature.set' ? same(S.features[b.feature], b) : b.op === 'group.set' ? same(S.groups[b.group], b) : false));
}

/** This device's entries of the scope, without the local-only ops. */
function outgoing(entries, dev, skip) {
  const sk = new Set(skip == null ? LOCAL_OPS : skip);
  return entries.filter(e => e && e.dev === dev && e.id === e.dev + '.' + e.seq && !sk.has(e.op)).sort((a, b) => a.seq - b.seq);
}
/** Blobs the entries name (layer.set blob; cavefile.set h.ext). */
function blobsOf(entries) {
  const s = new Set();
  entries.forEach(e => { if (e.op === 'layer.set' && e.blob) s.add(e.blob); if (e.op === 'cavefile.set' && e.h) s.add(e.h + '.' + (e.ext || 'plt')); });
  return [...s];
}
/** The sync file: { pid, dev, who, entries, blobs: { name: Buffer } } → Buffer (zip). */
async function makeZip({ pid, dev, who, entries, blobs }) {
  const scope = 'p-' + pid, m = {};
  entries.forEach(e => { const r = m[e.dev] || (m[e.dev] = { from: e.seq, to: e.seq, n: 0 }); r.from = Math.min(r.from, e.seq); r.to = Math.max(r.to, e.seq); r.n++; });
  const man = { format: 'flex-sync', version: 1, created: new Date().toISOString(), from: { dev, who: who || '' },
    project: { id: pid, name: '' }, scopes: { [scope]: m }, blobs: Object.keys(blobs || {}).length };
  const z = new JSZip();
  z.file('manifest.json', JSON.stringify(man, null, 1));
  const byDev = {};
  entries.forEach(e => (byDev[e.dev] || (byDev[e.dev] = [])).push(JSON.stringify(e)));
  Object.entries(byDev).forEach(([d, ls]) => z.file(`logs/${scope}/log-${d}.jsonl`, ls.join('\n') + '\n'));
  Object.entries(blobs || {}).forEach(([n, b]) => z.file('blobs/' + n, b, { compression: 'STORE' }));
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ── HTTP (against a running FLEX) ───────────────────────────────────────────
function request(base, method, p, body, type) {
  return new Promise((ok, no) => {
    const u = new URL(p, base), lib = u.protocol === 'https:' ? https : http;
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = lib.request(u, { method, headers: data ? { 'Content-Type': type || 'application/json', 'Content-Length': data.length } : {} }, res => {
      const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const b = Buffer.concat(ch); res.statusCode >= 400 ? no(new Error(`${method} ${p}: HTTP ${res.statusCode} ${b.toString('utf8').slice(0, 300)}`)) : ok(b); });
    });
    r.on('error', no); if (data) r.write(data); r.end();
  });
}
const getJson = async (base, p) => JSON.parse((await request(base, 'GET', p)).toString('utf8'));
const lines = t => String(t).split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
async function projectEntries(base, pid) { return lines((await request(base, 'GET', '/api/lib/read?scope=p-' + encodeURIComponent(pid))).toString('utf8')); }
async function append(base, pid, body, who) {
  const e = Object.assign({ who: who || 'FLEX server' }, body);
  return JSON.parse((await request(base, 'POST', `/api/lib/append?scope=p-${encodeURIComponent(pid)}&project=${encodeURIComponent(pid)}`, e)).toString('utf8'));
}
async function areaOf(base, id) {
  const j = await getJson(base, '/api/areas');
  const a = (j.areas || []).find(x => x.id === id);
  if (!a) throw new Error('no area ' + id + ' on ' + base);
  return a;
}

async function record({ base, pid, area, prospects, who, filter }) {
  const projs = await getJson(base, '/api/lib/projects');
  if (!projs.some(p => p.id === pid)) throw new Error('project ' + pid + ' is not on this FLEX: create it first (POST /api/lib/projects { id, name })');
  const a = await areaOf(base, area);
  let bodies = [];
  if (a.results && a.results.terrain) bodies = bodies.concat(terrainEntries(await getJson(base, `/api/areas/file/${area}/terrain/ref.json`)));
  if (prospects && a.results && a.results.prospect) {
    const geo = await getJson(base, `/api/areas/file/${area}/prospect/candidates.geojson`);
    const day = String((a.results.prospect.date || new Date().toISOString())).slice(0, 10);
    bodies = bodies.concat(prospectEntries(geo, area, a.name, day, filter));
  }
  const S = FL.replayProject(await projectEntries(base, pid), pid);
  const todo = missing(S, bodies);
  const order = FL.liveLayers(S).length;
  for (const b of todo) await append(base, pid, b.op === 'layer.set' && b.order == null ? Object.assign({ order }, b) : b, who);
  const count = op => todo.filter(b => b.op === op).length;
  return { written: todo.length, layers: count('layer.set'), features: count('feature.set'), groups: count('group.set'), skipped: bodies.length - todo.length };
}

async function pack({ base, pid, skip, who }) {
  const dev = (await getJson(base, '/api/lib/device')).id;
  const entries = outgoing(await projectEntries(base, pid), dev, skip);
  const blobs = {};
  for (const n of blobsOf(entries)) blobs[n] = await request(base, 'GET', '/api/lib/blob/' + n);
  const buf = await makeZip({ pid, dev, who: who || 'FLEX server', entries, blobs });
  const ops = {}; entries.forEach(e => { ops[e.op] = (ops[e.op] || 0) + 1; });
  return { buffer: buf, dev, entries: entries.length, ops, blobs: Object.fromEntries(Object.entries(blobs).map(([n, b]) => [n, b.length])) };
}

module.exports = { terrainEntries, prospectEntries, passes, missing, outgoing, blobsOf, makeZip, record, pack, LOCAL_OPS, PROSPECT_FILTER };

if (require.main === module) {
  const argv = process.argv.slice(2), cmd = argv[0];
  const opt = k => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : undefined; };
  const base = opt('base') || 'http://localhost:8081', pid = opt('project');
  (async () => {
    if (!pid) throw new Error('--project is needed');
    if (cmd === 'record') console.log(JSON.stringify(await record({ base, pid, area: opt('area'), prospects: argv.includes('--prospects'), who: opt('who') })));
    else if (cmd === 'footprint') {
      const ring = JSON.parse(require('fs').readFileSync(opt('ring'), 'utf8'));
      const S = FL.replayProject(await projectEntries(base, pid), pid);
      const want = (Array.isArray(ring.ring) ? ring.ring : ring).map(c => [+c[0], +c[1]]);
      if (S.footprint && JSON.stringify(S.footprint.ring) === JSON.stringify(want)) console.log('footprint already set');
      else console.log(JSON.stringify(await append(base, pid, { op: 'project.footprint', ring: want }, opt('who'))));
    } else if (cmd === 'pack') {
      const r = await pack({ base, pid, skip: opt('skip') != null ? opt('skip').split(',').filter(Boolean) : undefined, who: opt('who') });
      require('fs').writeFileSync(opt('out'), r.buffer);
      console.log(JSON.stringify({ out: opt('out'), bytes: r.buffer.length, dev: r.dev, entries: r.entries, ops: r.ops, blobs: r.blobs }));
    } else throw new Error('usage: sync_build.js record|footprint|pack --base URL --project PID …');
  })().catch(e => { console.error('! ' + (e.message || e)); process.exit(1); });
}
