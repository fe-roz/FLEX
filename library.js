// The project library on the PC: what people add to a project (caves,
// documents, notes, leads, field survey), shared with FLEX Field by sync
// files. Same files as the phone (android/.../LibStore.kt); the rules
// (replay, merge, conflicts, proposals) are in viewer_build/libs/flexlib.js,
// which the page runs. This module only keeps the files.
//
//   user_files/library/device.json               this PC's device id
//   user_files/library/blobs/<sha256>.<ext>      document pages and survey files, stored once
//   user_files/library/<scope>/log-<dev>.jsonl   one append-only log per device and scope
//   user_files/library/projects.json             project ids and names
//   user_files/library/kv.json                   small page settings (last sync file)
//
// Scopes: "p-<project id>" and "docs". The PC writes only its own log files;
// the server numbers its entries (several tabs can't take the same number).
// Entries from sync files go to the sending devices' files, once each.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.FLEX_LIBRARY_DIR || path.join(__dirname, 'user_files', 'library');   // env: tests
const SCOPE_RE = /^(docs|p-[A-Za-z0-9_-]{1,40})$/;
const DEV_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const EXTS = new Set(['jpg', 'png', 'webp', 'pdf', 'plt']);              // plt: a project's survey files (text)
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', plt: 'text/plain; charset=utf-8' };
const MAX_BLOB = 40 << 20;
const MAX_BODY = 64 << 20;

function root() { fs.mkdirSync(ROOT, { recursive: true }); return ROOT; }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

let _device = null;
function device() {
  if (_device) return _device;
  const f = path.join(root(), 'device.json');
  try { const id = JSON.parse(fs.readFileSync(f, 'utf8')).id; if (DEV_RE.test(id || '')) return (_device = id); } catch (_) {}
  _device = 'pc' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(f, JSON.stringify({ id: _device, created: Date.now() }));
  return _device;
}
function scopeDir(scope) {
  if (!SCOPE_RE.test(scope || '')) return null;
  const d = path.join(root(), scope);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const logFiles = d => fs.readdirSync(d).filter(n => /^log-[A-Za-z0-9_-]+\.jsonl$/.test(n)).sort();
function lines(text) {
  return String(text || '').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function read(scope) {
  const d = scopeDir(scope);
  if (!d) return '';
  return logFiles(d).map(n => { const t = fs.readFileSync(path.join(d, n), 'utf8'); return t && !t.endsWith('\n') ? t + '\n' : t; }).join('');
}

const _seq = new Map();                 // scope → last seq this PC used
function nextSeq(scope, d) {
  if (!_seq.has(scope)) {
    const f = path.join(d, `log-${device()}.jsonl`);
    let max = 0;
    if (fs.existsSync(f)) lines(fs.readFileSync(f, 'utf8')).forEach(e => { if (e.seq > max) max = e.seq; });
    _seq.set(scope, max);
  }
  const s = _seq.get(scope) + 1;
  _seq.set(scope, s);
  return s;
}
/** An entry this PC made: numbered here, appended to the PC's own file. */
function append(scope, entry) {
  const d = scopeDir(scope);
  if (!d) throw new Error('bad scope');
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.op !== 'string' || !entry.op) throw new Error('bad entry');
  const dev = device(), seq = nextSeq(scope, d);
  const e = Object.assign({}, entry, { id: dev + '.' + seq, dev, seq });
  if (!e.t) e.t = new Date().toISOString();
  fs.appendFileSync(path.join(d, `log-${dev}.jsonl`), JSON.stringify(e) + '\n');
  return e;
}
/** Entries from a sync file: those not known yet, into their devices' files. */
function merge(scope, entries) {
  const d = scopeDir(scope);
  if (!d) throw new Error('bad scope');
  const known = new Set();
  logFiles(d).forEach(n => lines(fs.readFileSync(path.join(d, n), 'utf8')).forEach(e => known.add(e.id)));
  const fresh = (Array.isArray(entries) ? entries : []).filter(e => e && DEV_RE.test(e.dev || '') && Number.isInteger(e.seq) && e.seq > 0
    && e.id === e.dev + '.' + e.seq && !known.has(e.id) && (known.add(e.id), true));
  fresh.sort((a, b) => (a.dev === b.dev ? a.seq - b.seq : (a.dev < b.dev ? -1 : 1)));
  const byDev = new Map();
  fresh.forEach(e => { if (!byDev.has(e.dev)) byDev.set(e.dev, []); byDev.get(e.dev).push(JSON.stringify(e)); });
  byDev.forEach((ls, dev) => fs.appendFileSync(path.join(d, `log-${dev}.jsonl`), ls.join('\n') + '\n'));
  if (byDev.has(device())) _seq.delete(scope);       // our own entries came back (a restore): renumber from the file
  return fresh.length;
}

function blobPath(name) {
  const m = /^([0-9a-f]{64})\.([a-z]{2,4})$/.exec(name || '');
  if (!m || !EXTS.has(m[2])) return null;
  return path.join(root(), 'blobs', m[1] + '.' + m[2]);
}
function putBlob(buf, ext, want) {
  if (!EXTS.has(ext)) throw new Error('bad type');
  if (buf.length > MAX_BLOB) throw new Error('page too large');
  const h = sha256(buf);
  if (want && want !== h) throw new Error('hash mismatch');
  const dir = path.join(root(), 'blobs');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, h + '.' + ext);
  if (!fs.existsSync(f)) { fs.writeFileSync(f + '.part', buf); fs.renameSync(f + '.part', f); }
  return { h, ext };
}

function projects() { try { const a = JSON.parse(fs.readFileSync(path.join(root(), 'projects.json'), 'utf8')); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
function setProject(id, name) {
  if (!ID_RE.test(id || '')) throw new Error('bad project id');
  const list = projects();
  const p = list.find(x => x.id === id);
  const nm = String(name || '').trim().slice(0, 60);
  if (p) { if (nm) p.name = nm; } else list.push({ id, name: nm });
  fs.writeFileSync(path.join(root(), 'projects.json'), JSON.stringify(list));
  return list;
}
function kv() { try { return JSON.parse(fs.readFileSync(path.join(root(), 'kv.json'), 'utf8')) || {}; } catch (_) { return {}; } }
function kvSet(k, v) {
  if (typeof k !== 'string' || k.length > 200 || typeof v !== 'string' || v.length > 200000) throw new Error('bad setting');
  const o = kv(); o[k] = v;
  fs.writeFileSync(path.join(root(), 'kv.json'), JSON.stringify(o));
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function body(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

/** /api/lib/<rest> */
async function handle(req, res, rest, query) {
  try {
    const q = query || {};
    if (req.method === 'GET' && rest === 'device') return json(res, { id: device() });
    if (req.method === 'GET' && rest === 'read') {
      if (!SCOPE_RE.test(q.scope || '')) return json(res, { error: 'bad scope' }, 400);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(read(q.scope));
    }
    if (req.method === 'POST' && rest === 'append') return json(res, append(q.scope, JSON.parse((await body(req, 1 << 20)).toString('utf8'))));
    if (req.method === 'POST' && rest === 'merge') return json(res, { added: merge(q.scope, JSON.parse((await body(req)).toString('utf8'))) });
    if (req.method === 'GET' && rest === 'projects') return json(res, projects());
    if (req.method === 'POST' && rest === 'projects') { const o = JSON.parse((await body(req, 1 << 16)).toString('utf8')); return json(res, setProject(o.id, o.name)); }
    if (req.method === 'GET' && rest === 'kv') return json(res, { v: kv()[q.k] ?? null });
    if (req.method === 'POST' && rest === 'kv') { const o = JSON.parse((await body(req, 1 << 20)).toString('utf8')); kvSet(o.k, o.v); return json(res, { ok: true }); }
    if (req.method === 'POST' && rest === 'blob') return json(res, putBlob(await body(req, MAX_BLOB + 1), String(q.ext || ''), q.h ? String(q.h) : null));
    if (req.method === 'POST' && rest === 'blobs-missing') {
      const o = JSON.parse((await body(req, 4 << 20)).toString('utf8'));
      return json(res, { missing: (o.names || []).filter(n => { const f = blobPath(n); return f && !fs.existsSync(f); }) });
    }
    if (req.method === 'GET' && rest.startsWith('blob/')) {
      const f = blobPath(rest.slice(5));
      if (!f || !fs.existsSync(f)) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).slice(1)], 'Cache-Control': 'max-age=31536000, immutable' });
      return fs.createReadStream(f).pipe(res);
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    return json(res, { error: e.message || String(e) }, 400);
  }
}

module.exports = { handle, device, read, append, merge, putBlob, projects, setProject, kv, kvSet, ROOT };
