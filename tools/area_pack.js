// area_pack.js — a processed area (user_files/areas/<id>/, areas_api.js) as one zip, to carry it to another computer.
//
// The package holds area.json and the result folders (ground/, veg/, bush/, prospect/, terrain/), each file checked
// against the store's allow-list (areas_api.js FILES). points/ (the area's point cache, often gigabytes) and logs stay
// behind. The terrain itself travels in the project's sync file (its .bin is a project blob); terrain/ref.json only
// says where it went.
//
//   node tools/area_pack.js pack   <area dir> <out.zip>             → size report (per folder)
//   node tools/area_pack.js list   <zip>                            → what is inside, and what an import would refuse
//   node tools/area_pack.js unpack <zip> <areas root> [--overwrite] → user_files/areas/<id>/ (refuses an existing id)
//
// Library use (areas_api.js POST /api/areas/import): pack(dir, files) / unpack(buf, root, files, { overwrite }).
// unpack never writes outside <root>/<id>; an existing area is kept, renamed <id>.replaced-<time>, when overwrite is asked.
'use strict';
const fs = require('fs');
const path = require('path');
const JSZip = require('../viewer_build/libs/jszip.min.js');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_FILE = 1536 << 20;          // one file, uncompressed
const MAX_TOTAL = 3 * 1024 ** 3;     // the whole package, uncompressed
const FORMAT = 'flex-area';

const kb = n => (n >= 1 << 20 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB');

/** The store's allow-list (areas_api.js), unless the caller passes one. */
function defaultFiles() { return require('../areas_api.js').FILES; }

/** A path inside a package → { kind: 'area' } | { kind: 'file', result, name } | { kind: 'bad', why } | { kind: 'skip', why }. */
function classify(name, files) {
  const n = String(name || '');
  if (!n || n.includes('\\') || n.includes('\0') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return { kind: 'bad', why: 'not a plain relative path' };
  const parts = n.split('/');
  if (parts.some(p => p === '..' || p === '.')) return { kind: 'bad', why: 'path leaves the folder' };
  if (n.endsWith('/')) return { kind: 'skip', why: 'folder' };
  if (n === 'area.json') return { kind: 'area' };
  if (parts.length !== 2) return { kind: 'skip', why: 'not an area file' };
  const [result, file] = parts;
  if (!Object.prototype.hasOwnProperty.call(files, result)) return { kind: 'skip', why: 'unknown result folder' };
  if (!files[result].test(file)) return { kind: 'skip', why: 'not on the ' + result + ' allow-list' };
  return { kind: 'file', result, name: file };
}

/** The area folder → { buffer, area, report: { files: [{ path, bytes }], folders: { name: bytes }, left: [..], bytes, zipBytes } }. */
async function pack(dir, files, opts) {
  files = files || defaultFiles();
  opts = opts || {};
  const area = JSON.parse(fs.readFileSync(path.join(dir, 'area.json'), 'utf8'));
  if (!area || !ID_RE.test(String(area.id || ''))) throw new Error('area.json has no valid id');
  const z = new JSZip(), list = [], folders = {}, left = [];
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'area.json') continue;
    if (!e.isDirectory()) { left.push(e.name); continue; }
    if (!Object.prototype.hasOwnProperty.call(files, e.name)) { left.push(e.name + '/'); continue; }      // points/ and anything else
    for (const f of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) {
      const rel = e.name + '/' + f.name, c = classify(rel, files);
      if (!f.isFile() || c.kind !== 'file') { left.push(rel); continue; }
      const buf = fs.readFileSync(path.join(dir, rel));
      z.file(rel, buf, { compression: /\.(png|jpg|zip)$/i.test(f.name) ? 'STORE' : 'DEFLATE' });
      list.push({ path: rel, bytes: buf.length }); folders[e.name] = (folders[e.name] || 0) + buf.length; total += buf.length;
    }
  }
  // area.json as it travels: the same id, ring, project and results; results whose folder did not come are dropped.
  const out = Object.assign({}, area, { packed: { format: FORMAT, created: new Date().toISOString(), from: opts.from || '' } });
  out.results = {};
  Object.entries(area.results || {}).forEach(([k, v]) => { if (folders[k] != null) out.results[k] = v; });
  const aj = Buffer.from(JSON.stringify(out, null, 1));
  z.file('area.json', aj);
  list.unshift({ path: 'area.json', bytes: aj.length }); total += aj.length;
  const buffer = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, area: out, report: { files: list, folders, left, bytes: total, zipBytes: buffer.length } };
}

/** What is in a package and what an import would do with each entry (nothing written). */
async function inspect(buf, files) {
  files = files || defaultFiles();
  const z = await JSZip.loadAsync(buf);
  const entries = [], bad = [];
  let area = null, total = 0;
  for (const [name, f] of Object.entries(z.files)) {
    const c = classify(name, files);
    const size = f._data && Number.isFinite(f._data.uncompressedSize) ? f._data.uncompressedSize : 0;
    if (c.kind === 'bad') bad.push({ path: name, why: c.why });
    if (c.kind === 'skip' && c.why !== 'folder') entries.push({ path: name, skip: c.why });
    if (c.kind === 'file' || c.kind === 'area') { entries.push({ path: name, bytes: size }); total += size; }
    if (size > MAX_FILE) bad.push({ path: name, why: 'too large' });
  }
  if (total > MAX_TOTAL) bad.push({ path: '*', why: 'too large in all' });
  if (z.files['area.json']) { try { area = JSON.parse(await z.file('area.json').async('string')); } catch (_) { bad.push({ path: 'area.json', why: 'not JSON' }); } }
  return { z, area, entries, bad, bytes: total };
}

/** A checked area.json for the store, or throws. */
function cleanArea(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('the package has no area.json');
  if (!ID_RE.test(String(a.id || ''))) throw new Error('area.json has no valid id');
  const ring = Array.isArray(a.ring) ? a.ring : [];
  if (ring.length < 4 || !ring.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90))
    throw new Error('area.json has no valid ring');
  if (a.project != null && a.project !== '' && !ID_RE.test(String(a.project))) throw new Error('area.json has a bad project id');
  const out = Object.assign({}, a);
  out.name = String(a.name == null ? '' : a.name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || 'Area';
  out.project = a.project ? String(a.project) : '';
  out.ring = ring.map(p => [+p[0], +p[1]]);
  out.results = a.results && typeof a.results === 'object' && !Array.isArray(a.results) ? a.results : {};
  out.lidar = Array.isArray(a.lidar) ? a.lidar.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 6) : [];
  return out;
}

/**
 * A package into the store: <root>/<id>/. Throws on a bad path anywhere in the zip (nothing written), on an existing id
 * unless opts.overwrite (then the old folder is kept as <id>.replaced-<time>). → { ok, area, written: [..], refused: [..], bytes }
 */
async function unpack(buf, root, files, opts) {
  files = files || defaultFiles();
  opts = opts || {};
  const I = await inspect(buf, files);
  if (I.bad.length) throw new Error('refused: ' + I.bad.map(b => b.path + ' (' + b.why + ')').join(', '));
  const area = cleanArea(I.area);
  area.imported = { t: new Date().toISOString(), from: (I.area.packed && I.area.packed.from) || '' };
  delete area.packed;
  const dest = path.join(root, area.id);
  const exists = fs.existsSync(dest);
  if (exists && !opts.overwrite) { const e = new Error('an area with this id is already here (' + area.id + '): import again with overwrite to replace it'); e.code = 'EXISTS'; throw e; }
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, '.import-' + area.id + '-' + Date.now().toString(36));
  const written = [], refused = I.entries.filter(e => e.skip).map(e => e.path + ' (' + e.skip + ')');
  try {
    fs.mkdirSync(tmp);
    for (const e of I.entries) {
      if (e.skip || e.path === 'area.json') continue;
      const c = classify(e.path, files);
      const f = path.join(tmp, c.result, c.name);
      if (path.relative(tmp, f).split(path.sep)[0] === '..') throw new Error('bad path ' + e.path);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, await I.z.file(e.path).async('nodebuffer'));
      written.push(e.path);
    }
    // results only for folders that arrived
    Object.keys(area.results).forEach(k => { if (!written.some(p => p.startsWith(k + '/'))) delete area.results[k]; });
    area.updated = new Date().toISOString();
    fs.writeFileSync(path.join(tmp, 'area.json'), JSON.stringify(area, null, 1));
    if (exists) fs.renameSync(dest, dest + '.replaced-' + Date.now().toString(36));
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}         // only our own temporary folder
    throw err;
  }
  return { ok: true, area, written, refused, bytes: I.bytes, replaced: exists };
}

module.exports = { pack, unpack, inspect, classify, cleanArea, FORMAT };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2), over = process.argv.includes('--overwrite');
  (async () => {
    if (cmd === 'pack' && a && b) {
      const r = await pack(a, null, { from: process.env.FLEX_PACK_FROM || 'FLEX' });
      fs.writeFileSync(b, r.buffer);
      console.log(`area ${r.area.id} "${r.area.name}" project ${r.area.project || '(My data)'}: ${r.report.files.length} files, ${kb(r.report.bytes)} -> zip ${kb(r.report.zipBytes)}`);
      Object.entries(r.report.folders).forEach(([k, v]) => console.log(`  ${k}/  ${kb(v)}`));
      if (r.report.left.length) console.log('  left out: ' + r.report.left.join(', '));
    } else if (cmd === 'list' && a) {
      const I = await inspect(fs.readFileSync(a));
      console.log(`area ${I.area && I.area.id} "${I.area && I.area.name}", ${kb(I.bytes)} uncompressed`);
      I.entries.forEach(e => console.log('  ' + e.path + (e.skip ? '  (refused: ' + e.skip + ')' : '  ' + kb(e.bytes))));
      I.bad.forEach(e => console.log('  BAD ' + e.path + ': ' + e.why));
    } else if (cmd === 'unpack' && a && b) {
      const r = await unpack(fs.readFileSync(a), b, null, { overwrite: over });
      console.log(`imported area ${r.area.id} "${r.area.name}": ${r.written.length} files` + (r.refused.length ? `; refused ${r.refused.join(', ')}` : ''));
    } else {
      console.log('usage: area_pack.js pack <area dir> <out.zip> | list <zip> | unpack <zip> <areas root> [--overwrite]');
      process.exit(2);
    }
  })().catch(e => { console.error('! ' + (e.message || e)); process.exit(1); });
}
