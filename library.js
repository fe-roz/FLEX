// The project library on the PC: what people add to a project (caves,
// documents, notes, leads, field survey), shared with FLEX Field by sync
// files. Same entries as the phone (android/.../LibStore.kt); the rules
// (replay, merge, conflicts, proposals) are in viewer_build/libs/flexlib.js,
// which the page runs. This module only keeps the files.
//
// Every project lives in a folder of its own (its home; doc 14):
//
//   <project folder>/                         readable files: Survey data/, Caves/…, To sort/
//   <project folder>/.flex/project.json        { id, name, created }
//   <project folder>/.flex/logs/project/log-<dev>.jsonl   the project's entries (scope p-<id>)
//   <project folder>/.flex/logs/docs/log-<dev>.jsonl      its documents' entries (scope docs)
//   <project folder>/.flex/renders/<sha256>.jpg           page images: renderings of the
//                                                          originals, made for viewing in FLEX
//   <project folder>/.flex/blobs/<sha256>.<ext>           other stored files (survey files…)
//   <project folder>/.flex/files.json         readable files known by fingerprint:
//                                              { "<sha256>.<ext>": "Caves/…/file.pdf" }
//
// FLEX's own data stays in user_files/library/:
//
//   device.json        this PC's device id
//   projects.json      the projects: [{ id, name, dir }] (dir relative to user_files/ or absolute)
//   kv.json            small page settings (last sync file)
//   docs-unassigned/   document entries made with no project open
//   p-<id>/, docs/, blobs/   the library before project folders (read only for projects
//                            that have no folder yet; kept as the backup after migrating)
//
// Scopes stay "p-<project id>" and "docs", so FLEX Field and sync files don't
// change. "docs" is read across all project folders; writes go to the folder
// of the project named in ?project=. The PC writes only its own log files; the
// server numbers its entries. Entries from sync files go to the sending
// devices' files, once each.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FL = require('./viewer_build/libs/flexlib.js');            // the rules (replay, moves) — the same file the page runs

const ROOT = process.env.FLEX_LIBRARY_DIR || path.join(__dirname, 'user_files', 'library');   // env: tests
const USER_FILES = path.dirname(ROOT);
const PROJECTS_DIR = process.env.FLEX_PROJECTS_DIR || path.join(USER_FILES, 'projects');
const SCOPE_RE = /^(docs|p-[A-Za-z0-9_-]{1,40})$/;
const DEV_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const EXTS = new Set(['jpg', 'png', 'webp', 'pdf', 'plt', 'tif', 'kml', 'kmz', 'json', 'bin']);   // plt: survey files (text); tif: original scans; kml/kmz/json: data files; bin: terrain patches
const IMAGE = new Set(['jpg', 'png', 'webp']);                          // page images → .flex/renders
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', plt: 'text/plain; charset=utf-8', tif: 'image/tiff', bin: 'application/octet-stream',
  kml: 'application/vnd.google-earth.kml+xml', kmz: 'application/vnd.google-earth.kmz', json: 'application/json' };
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

// ── Projects and their folders ───────────────────────────────────────────────
function projects() { try { const a = JSON.parse(fs.readFileSync(path.join(root(), 'projects.json'), 'utf8')); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
function saveProjects(list) {
  const f = path.join(root(), 'projects.json');
  fs.writeFileSync(f + '.part', JSON.stringify(list, null, 1)); fs.renameSync(f + '.part', f);
}
const absDir = d => (d ? (path.isAbsolute(d) ? d : path.join(USER_FILES, d)) : null);
const relDir = d => { const r = path.relative(USER_FILES, d); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : d; };
/** The project's folder, or null for a project still in the old library. */
function projDir(pid) { const p = projects().find(x => x.id === pid); return p && p.dir ? absDir(p.dir) : null; }
const folderProjects = () => projects().filter(p => p.dir).map(p => ({ id: p.id, dir: absDir(p.dir) }));   // (incl. My data)
/** A folder name Windows, macOS and Linux all accept. */
function safeName(name) {
  const s = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').replace(/^[. ]+/, '').trim().slice(0, 80);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) || !s ? 'Project' : s;
}
/** Make a project folder's skeleton (nothing is overwritten). */
function makeFolder(dir, id, name) {
  for (const d of ['.flex/logs/project', '.flex/logs/docs', '.flex/renders', '.flex/blobs', '.flex/attic', 'To sort']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const pf = path.join(dir, '.flex', 'project.json');
  if (!fs.existsSync(pf)) fs.writeFileSync(pf, JSON.stringify({ id, name, created: new Date().toISOString() }, null, 1));
  const fi = path.join(dir, '.flex', 'files.json');
  if (!fs.existsSync(fi)) fs.writeFileSync(fi, '{}');
}
/**
 * Name a project, or add a new one. A new project gets its folder
 * (default user_files/projects/<name>/, or `dir`). A project already in the
 * old library keeps working from there until it's migrated.
 */
function setProject(id, name, dir) {
  if (!ID_RE.test(id || '')) throw new Error('bad project id');
  const list = projects();
  const p = list.find(x => x.id === id);
  const nm = String(name || '').trim().slice(0, 60);
  if (p) {
    if (nm) p.name = nm;
    if (p.dir) { const pf = path.join(absDir(p.dir), '.flex', 'project.json'); try { const o = JSON.parse(fs.readFileSync(pf, 'utf8')); if (nm) { o.name = nm; fs.writeFileSync(pf, JSON.stringify(o, null, 1)); } } catch (_) {} }
  } else {
    const legacy = fs.existsSync(path.join(root(), 'p-' + id));
    const entry = { id, name: nm };
    if (!legacy) {
      let d = dir ? path.resolve(String(dir)) : path.join(PROJECTS_DIR, safeName(nm || id));
      if (!dir) { let n = 2; const base = d; while (fs.existsSync(d) && !isProjectFolder(d, id)) d = `${base} (${n++})`; }
      makeFolder(d, id, nm);
      entry.dir = relDir(d);
    }
    list.push(entry);
  }
  saveProjects(list);
  return list;
}
function isProjectFolder(d, id) { try { return JSON.parse(fs.readFileSync(path.join(d, '.flex', 'project.json'), 'utf8')).id === id; } catch (_) { return false; } }
/** A private project (My data): has a folder, never listed as a project. */
function registerPrivate(id, name, dir) {
  if (!ID_RE.test(id || '') || !isProjectFolder(dir, id)) throw new Error('not this project’s folder');
  const list = projects();
  if (!list.find(x => x.id === id)) { list.push({ id, name, dir: relDir(path.resolve(dir)), private: true }); saveProjects(list); }
  _seq.clear(); _blobIndex = null;
}
/** Record a readable file by fingerprint in the project's files.json. */
function indexFile(pid, name, rel) {
  const pd = projDir(pid);
  if (!pd || !nameRe.test(name)) return;
  const fi = path.join(pd, '.flex', 'files.json');
  let o = {}; try { o = JSON.parse(fs.readFileSync(fi, 'utf8')) || {}; } catch (_) {}
  if (o[name] === rel) return;
  o[name] = rel;
  fs.writeFileSync(fi + '.part', JSON.stringify(o, null, 1)); fs.renameSync(fi + '.part', fi);
  if (_blobIndex) _blobIndex.set(name, path.join(pd, rel));
}
/** Point a project at its (migrated) folder. */
function adoptFolder(id, dir) {
  if (!ID_RE.test(id || '') || !isProjectFolder(dir, id)) throw new Error('not this project’s folder');
  const list = projects();
  const p = list.find(x => x.id === id);
  if (!p) throw new Error('unknown project');
  p.dir = relDir(path.resolve(dir));
  saveProjects(list);
  _seq.clear(); _blobIndex = null;
}

// ── Logs ─────────────────────────────────────────────────────────────────────
/** Every folder a scope's entries live in (for reading). */
function scopeDirs(scope) {
  if (!SCOPE_RE.test(scope || '')) return null;
  if (scope === 'docs') {
    const dirs = folderProjects().map(p => path.join(p.dir, '.flex', 'logs', 'docs'));
    // The old shared docs log counts while some project is still in the old library; once all
    // have folders it is only the backup. (Entries copied to a folder and still here are the
    // same entries, same ids: the replay counts them once.)
    if (!projects().some(p => p.dir && !p.private) || projects().some(p => !p.dir)) dirs.push(path.join(root(), 'docs'));
    dirs.push(path.join(root(), 'docs-unassigned'));
    return dirs;
  }
  const pd = projDir(scope.slice(2));
  return [pd ? path.join(pd, '.flex', 'logs', 'project') : path.join(root(), scope)];
}
/** The folder this PC writes a scope's entries to. */
function writeDir(scope, pid) {
  if (!SCOPE_RE.test(scope || '')) return null;
  let d;
  if (scope === 'docs') {
    const pd = pid && ID_RE.test(pid) ? projDir(pid) : null;
    d = pd ? path.join(pd, '.flex', 'logs', 'docs') : (folderProjects().length ? path.join(root(), 'docs-unassigned') : path.join(root(), 'docs'));
    // (No folders at all yet: the old library as before.)
  } else d = scopeDirs(scope)[0];
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const logFiles = d => { try { return fs.readdirSync(d).filter(n => /^log-[A-Za-z0-9_-]+\.jsonl$/.test(n)).sort(); } catch (_) { return []; } };
function lines(text) {
  return String(text || '').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
const fileText = f => { const t = fs.readFileSync(f, 'utf8'); return t && !t.endsWith('\n') ? t + '\n' : t; };

function read(scope, at) {
  const dirs = scopeDirs(scope);
  if (!dirs) return '';
  const text = dirs.map(d => logFiles(d).map(n => fileText(path.join(d, n))).join('')).join('');
  // A snapshot: only the entries up to a moment (an ISO time, or a day = the end of it).
  if (at) { const t = FL.snapshotTime(at); if (!t) return ''; return lines(text).filter(e => !e.t || e.t <= t).map(e => JSON.stringify(e)).join('\n') + '\n'; }
  return text;
}
const entriesOf = scope => lines(read(scope));

// Numbering: one series per device and scope. For "docs" the series spans
// every project's docs folder (one replay reads them all, so ids must not repeat).
const _seq = new Map();
function nextSeq(scope) {
  if (!_seq.has(scope)) {
    let max = 0;
    const dirs = scope === 'docs' ? [...scopeDirs('docs'), path.join(root(), 'docs')] : scopeDirs(scope);
    for (const d of dirs) {
      const f = path.join(d, `log-${device()}.jsonl`);
      if (fs.existsSync(f)) lines(fs.readFileSync(f, 'utf8')).forEach(e => { if (e.seq > max) max = e.seq; });
    }
    _seq.set(scope, max);
  }
  const s = _seq.get(scope) + 1;
  _seq.set(scope, s);
  return s;
}
/** An entry this PC made: numbered here, appended to the PC's own file. */
function append(scope, entry, pid) {
  const d = writeDir(scope, pid);
  if (!d) throw new Error('bad scope');
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.op !== 'string' || !entry.op) throw new Error('bad entry');
  const dev = device(), seq = nextSeq(scope);
  const e = Object.assign({}, entry, { id: dev + '.' + seq, dev, seq });
  if (!e.t) e.t = new Date().toISOString();
  fs.appendFileSync(path.join(d, `log-${dev}.jsonl`), JSON.stringify(e) + '\n');
  return e;
}
/** Entries from a sync file: those not known yet (anywhere in the scope), into their devices' files. */
function merge(scope, entries, pid) {
  const d = writeDir(scope, pid);
  if (!d) throw new Error('bad scope');
  const known = new Set();
  for (const sd of scopeDirs(scope)) logFiles(sd).forEach(n => lines(fs.readFileSync(path.join(sd, n), 'utf8')).forEach(e => known.add(e.id)));
  const fresh = (Array.isArray(entries) ? entries : []).filter(e => e && DEV_RE.test(e.dev || '') && Number.isInteger(e.seq) && e.seq > 0
    && e.id === e.dev + '.' + e.seq && !known.has(e.id) && (known.add(e.id), true));
  fresh.sort((a, b) => (a.dev === b.dev ? a.seq - b.seq : (a.dev < b.dev ? -1 : 1)));
  const byDev = new Map();
  fresh.forEach(e => { if (!byDev.has(e.dev)) byDev.set(e.dev, []); byDev.get(e.dev).push(JSON.stringify(e)); });
  byDev.forEach((ls, dev) => fs.appendFileSync(path.join(d, `log-${dev}.jsonl`), ls.join('\n') + '\n'));
  if (byDev.has(device())) _seq.delete(scope);       // our own entries came back (a restore): renumber from the files
  if (fresh.some(e => e.op === 'project.archive') && scopeProject(scope)) mirrorArchived(scopeProject(scope));   // archived on another device
  return fresh.length;
}
const scopeProject = scope => (String(scope).startsWith('p-') ? String(scope).slice(2) : null);

// ── Stored files, by fingerprint ─────────────────────────────────────────────
const nameRe = /^([0-9a-f]{64})\.([a-z]{2,4})$/;
let _blobIndex = null;                                 // "<sha>.<ext>" → absolute path
function blobIndex() {
  if (_blobIndex) return _blobIndex;
  const ix = new Map();
  const add = (dir) => { try { fs.readdirSync(dir).forEach(n => { const m = nameRe.exec(n); if (m && EXTS.has(m[2]) && !ix.has(n)) ix.set(n, path.join(dir, n)); }); } catch (_) {} };
  for (const p of folderProjects()) {
    add(path.join(p.dir, '.flex', 'renders'));
    add(path.join(p.dir, '.flex', 'blobs'));
    try {
      const files = JSON.parse(fs.readFileSync(path.join(p.dir, '.flex', 'files.json'), 'utf8')) || {};
      for (const [n, rel] of Object.entries(files)) {
        const m = nameRe.exec(n); if (!m || !EXTS.has(m[2]) || ix.has(n)) continue;
        const f = path.join(p.dir, rel);
        if (path.relative(p.dir, f).startsWith('..')) continue;          // stays inside its project
        ix.set(n, f);
      }
    } catch (_) {}
  }
  add(path.join(root(), 'blobs'));                     // the old library (backup) last
  return (_blobIndex = ix);
}
function blobPath(name) {
  const m = nameRe.exec(name || '');
  if (!m || !EXTS.has(m[2])) return null;
  const f = blobIndex().get(name);
  if (f && fs.existsSync(f)) return f;
  if (f) _blobIndex = null;                            // moved or gone: look again next time
  return null;
}
/** Store bytes by fingerprint: in the project's folder when it has one, else the old library. */
function putBlob(buf, ext, want, pid) {
  if (!EXTS.has(ext)) throw new Error('bad type');
  if (buf.length > MAX_BLOB) throw new Error('page too large');
  const h = sha256(buf);
  if (want && want !== h) throw new Error('hash mismatch');
  const name = h + '.' + ext;
  const have = blobPath(name);
  const pd = pid && ID_RE.test(pid) ? projDir(pid) : null;
  const dir = pd ? path.join(pd, '.flex', IMAGE.has(ext) ? 'renders' : 'blobs') : path.join(root(), 'blobs');
  // Already stored in this project (or, for a project without a folder, anywhere): nothing to do.
  if (have && (!pd || path.relative(pd, have).split(path.sep)[0] !== '..')) return { h, ext };
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  if (!fs.existsSync(f)) { fs.writeFileSync(f + '.part', buf); fs.renameSync(f + '.part', f); }
  if (_blobIndex) _blobIndex.set(name, f);
  return { h, ext };
}

function kv() { try { return JSON.parse(fs.readFileSync(path.join(root(), 'kv.json'), 'utf8')) || {}; } catch (_) { return {}; } }
function kvSet(k, v) {
  if (typeof k !== 'string' || k.length > 200 || typeof v !== 'string' || v.length > 200000) throw new Error('bad setting');
  const o = kv(); o[k] = v;
  fs.writeFileSync(path.join(root(), 'kv.json'), JSON.stringify(o));
}


// ── Lifecycle: archive, move a cave to another project (doc 14, rule 9) ──────
// Archived is recorded in the project's own log (`project.archive`, so every device sees it) and mirrored in
// projects.json so the list and the write guard needn't replay a log. An archived project takes no new entries
// from the page (read-only); sync files still merge into it. Nothing here deletes a file or a folder.
function mirrorArchived(pid) {
  const list = projects(), p = list.find(x => x.id === pid);
  if (!p) return;
  const last = FL.sortEntries(entriesOf('p-' + pid).filter(e => e.op === 'project.archive')).pop();
  const on = !!(last && last.archived !== false);
  if (!!p.archived === on) return;
  if (on) p.archived = true; else delete p.archived;
  saveProjects(list);
}
const isArchived = pid => { const p = projects().find(x => x.id === pid); return !!(p && p.archived); };
function setArchived(pid, on, who, note) {
  if (!projects().some(p => p.id === pid && !p.private)) throw new Error('unknown project');
  const e = append('p-' + pid, { op: 'project.archive', archived: !!on, who: String(who || '').slice(0, 40) || 'FLEX', note: note ? String(note).slice(0, 200) : undefined }, pid);
  mirrorArchived(pid);
  return { ok: true, archived: !!on, entry: e.id };
}
/** Copy a stored file (by fingerprint) into another project's folder; the original stays. */
function copyBlobTo(name, toPid) {
  const m = nameRe.exec(name || ''), src = blobPath(name), pd = projDir(toPid);
  if (!m || !src || !pd) return false;
  const dir = path.join(pd, '.flex', IMAGE.has(m[2]) ? 'renders' : 'blobs'), dest = path.join(dir, name);
  if (fs.existsSync(dest)) return true;
  if (src.startsWith(pd + path.sep)) return true;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dest + '.part'); fs.renameSync(dest + '.part', dest);
  if (_blobIndex) _blobIndex.set(name, dest);
  return true;
}
/** Copy a folder's files into another (never over an existing file, never a link); returns how many were copied. */
function copyTree(from, to) {
  let n = 0;
  const walk = (a, b) => {
    let ents; try { ents = fs.readdirSync(a, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const x = path.join(a, e.name), y = path.join(b, e.name);
      if (e.isDirectory()) walk(x, y);
      else if (e.isFile() && !fs.existsSync(y)) { fs.mkdirSync(b, { recursive: true }); fs.copyFileSync(x, y + '.part'); fs.renameSync(y + '.part', y); n++; }
    }
  };
  walk(from, to);
  return n;
}
/**
 * Move a project cave, with what hangs on it, from one project to another. The source keeps a record ("moved to …")
 * and the destination one ("moved in from …"). Ids stay the same, so the cave's notes, leads, segments, labels and
 * its documents (tagged by cave id) are the same things on the other side. Files are copied, never deleted.
 * Safe to repeat: `move` is one id per move; what the destination already has is not added again.
 */
function moveCave(from, to, cid, move, who) {
  if (!ID_RE.test(from || '') || !ID_RE.test(to || '') || from === to) throw new Error('two different projects, please');
  if (!ID_RE.test(move || '')) throw new Error('bad move id');
  const all = projects().filter(p => !p.private), pf = all.find(p => p.id === from), pt = all.find(p => p.id === to);
  if (!pf || !pt) throw new Error('unknown project');
  if (isArchived(from) || isArchived(to)) throw new Error('an archived project is read-only: unarchive it first');
  const S = FL.replayProject(entriesOf('p-' + from), from), T = FL.replayProject(entriesOf('p-' + to), to);
  if (S.moves[move] && S.moves[move].dir === 'out') return { ok: true, already: true };           // done before
  const D = FL.replayDocs(entriesOf('docs'));
  const B = FL.caveBundle(S, D, cid);
  if (!B) throw new Error('that cave is not in the project');
  if (B.shared.length) throw new Error('a survey file of this cave also holds another cave; split the file into its caves first');
  const rename = FL.moveRenames(B, T), by = String(who || '').slice(0, 40) || 'FLEX';
  // 1. The files: survey files, document pages and originals, the cave's folder.
  B.blobs.forEach(b => copyBlobTo(b.h + '.' + b.ext, to));
  const spd = projDir(from), tpd = projDir(to);
  let copied = 0;
  if (spd && tpd) {
    B.readable.forEach(r => {
      const rel = String(r.path || '').replace(/\\/g, '/').split('/').filter(x => x && x !== '.' && x !== '..').join('/');
      const f = rel && rel.split('/')[0] !== '.flex' ? path.join(spd, rel) : null;
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile() || fs.lstatSync(f).isSymbolicLink()) return;
      const dest = path.join(tpd, rel);
      if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(f, dest + '.part'); fs.renameSync(dest + '.part', dest); copied++; }
      indexFile(to, r.h + '.' + r.ext, rel);
    });
    const cdir = path.join('Caves', safeName(B.cave.name));
    if (fs.existsSync(path.join(spd, cdir))) copied += copyTree(path.join(spd, cdir), path.join(tpd, cdir));
  }
  // 2. The destination: the cave and what hangs on it, then its record.
  const put = (scope, pid, e) => append(scope, Object.assign({ who: by }, e), pid);
  FL.caveMoveEntries(B, T, rename).forEach(e => put('p-' + to, to, e));
  if (!(T.moves[move] && T.moves[move].dir === 'in')) put('p-' + to, to, FL.moveRecord(move, 'in', B, { id: from, name: pf.name }));
  // 3. The source lets it go, and keeps the record.
  FL.caveMoveClear(B, S).forEach(e => put('p-' + from, from, e));
  put('p-' + from, from, FL.moveRecord(move, 'out', B, { id: to, name: pt.name }));
  return { ok: true, already: false, cave: B.cave.name, counts: B.counts, renamed: rename, copiedFiles: copied };
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
const pidOf = q => (q && ID_RE.test(String(q.project || '')) ? String(q.project) : null);
/** What the page gets: id, name and where the folder is (for showing; no folder → still in the old library). */
const projectsOut = () => projects().filter(p => !p.private).map(p => ({ id: p.id, name: p.name, folder: p.dir ? absDir(p.dir) : null, archived: !!p.archived }));

// ── The project folder, read only (📄 Docs) ────────────────────────────────
const FILE_MIME = Object.assign({}, MIME, { jpeg: 'image/jpeg', tiff: 'image/tiff', gif: 'image/gif', txt: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', dat: 'text/plain; charset=utf-8', svx: 'text/plain; charset=utf-8', geojson: 'application/json', gpx: 'application/gpx+xml', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' });
const TREE_MAX = 20000;
/** Every file under a project folder but .flex: [{ p: 'Caves/x.pdf', s: bytes, m: ms }]. */
function listTree(pd) {
  const out = [];
  const walk = rel => {
    if (out.length >= TREE_MAX) return;
    let ents;
    try { ents = fs.readdirSync(path.join(pd, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (!rel && e.name === '.flex') continue;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) { try { const st = fs.statSync(path.join(pd, r)); out.push({ p: r, s: st.size, m: Math.round(st.mtimeMs) }); } catch (_) {} }
      if (out.length >= TREE_MAX) return;
    }
  };
  walk('');
  return out;
}
/** A file inside the project folder (never .flex, never outside it), or null. */
function projFile(pid, rel) {
  const pd = projDir(pid);
  if (!pd || !rel || rel.includes('\0')) return null;
  let f, base;
  try { base = fs.realpathSync(pd); f = fs.realpathSync(path.resolve(pd, rel)); } catch (_) { return null; }   // links followed, then checked
  const r = path.relative(base, f);
  if (!r || r.startsWith('..') || path.isAbsolute(r) || r.split(path.sep)[0] === '.flex') return null;
  try { return fs.statSync(f).isFile() ? f : null; } catch (_) { return null; }
}

// ── A cave's survey export (survey-export.js) ───────────────────────────────
// <project folder>/Caves/<cave>/Survey/<cave>.svx|.csv|.plt — generated files,
// rewritten each time, never read back (doc 14). Names are single plain path
// parts (no / \ .. ), the folder must resolve inside the project, never .flex.
const EXPORT_EXT = new Set(['svx', 'csv', 'plt']);
const plainPart = s => typeof s === 'string' && !!s.trim() && s.length <= 200 && !/[/\\\0]/.test(s) && !s.includes('..');
function inside(base, f) { const r = path.relative(base, f); return !!r && !r.startsWith('..') && !path.isAbsolute(r) && r.split(path.sep)[0] !== '.flex'; }
function surveyExport(pid, cave, files) {
  const pd = projDir(pid);
  if (!pd) throw new Error('this project has no folder');
  if (!plainPart(cave)) throw new Error('bad cave name');
  if (!Array.isArray(files) || !files.length || files.length > 6) throw new Error('no files');
  const rel = ['Caves', safeName(cave), 'Survey'];
  const base = fs.realpathSync(pd);
  let have = pd, k = 0;                                // the deepest part that exists already must be inside
  for (let i = 1; i <= rel.length && fs.existsSync(path.join(pd, ...rel.slice(0, i))); i++) { have = path.join(pd, ...rel.slice(0, i)); k = i; }
  if (k && !inside(base, fs.realpathSync(have))) throw new Error('bad path');
  const dir = path.join(pd, ...rel);
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  if (!inside(base, real)) throw new Error('bad path');
  const out = [];
  for (const f of files) {
    const nm = f && f.name, ext = plainPart(nm) ? path.extname(nm).slice(1).toLowerCase() : '';
    if (!EXPORT_EXT.has(ext) || typeof f.text !== 'string') throw new Error('bad file');
    const n = safeName(nm), dest = path.join(real, n);
    if (fs.existsSync(dest) && (fs.lstatSync(dest).isSymbolicLink() || !fs.statSync(dest).isFile())) throw new Error('bad path');
    fs.writeFileSync(dest + '.part', f.text); fs.renameSync(dest + '.part', dest);
    out.push(n);
  }
  return { ok: true, folder: rel.join('/'), path: real, files: out };
}

/** /api/lib/<rest> */
async function handle(req, res, rest, query) {
  try {
    const q = query || {};
    if (req.method === 'GET' && rest === 'device') return json(res, { id: device() });
    if (req.method === 'GET' && rest === 'read') {
      if (!SCOPE_RE.test(q.scope || '')) return json(res, { error: 'bad scope' }, 400);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(read(q.scope, q.at ? String(q.at) : null));            // at=<time or day>: a snapshot, the entries up to then
    }
    if (req.method === 'POST' && rest === 'append') {
      // An archived project is read-only: nothing is added to it from the page (only un-archiving).
      const sp = scopeProject(q.scope), o = JSON.parse((await body(req, 1 << 20)).toString('utf8'));
      if (((sp && isArchived(sp)) || (q.scope === 'docs' && pidOf(q) && isArchived(pidOf(q)))) && o.op !== 'project.archive') return json(res, { error: 'this project is archived (read-only)' }, 403);
      return json(res, append(q.scope, o, pidOf(q)));
    }
    if (req.method === 'POST' && rest === 'archive' && pidOf(q)) { const o = JSON.parse((await body(req, 1 << 14)).toString('utf8')); return json(res, setArchived(pidOf(q), o.archived !== false, o.who, o.note)); }
    if (req.method === 'POST' && rest === 'move-cave') {
      const o = JSON.parse((await body(req, 1 << 14)).toString('utf8'));
      return json(res, moveCave(String(q.from || ''), String(q.to || ''), String(o.cave || ''), String(o.move || ''), o.who));
    }
    if (req.method === 'GET' && rest === 'move-preview') {          // what would move (counts), for the question before it
      const f = String(q.from || ''), cid = String(q.cave || '');
      if (!ID_RE.test(f)) return json(res, { error: 'bad project' }, 400);
      const B = FL.caveBundle(FL.replayProject(entriesOf('p-' + f), f), FL.replayDocs(entriesOf('docs')), cid);
      return json(res, B ? { name: B.cave.name, counts: B.counts, shared: B.shared } : null);
    }
    if (req.method === 'POST' && rest === 'merge') return json(res, { added: merge(q.scope, JSON.parse((await body(req)).toString('utf8')), pidOf(q)) });
    if (req.method === 'GET' && rest === 'projects') return json(res, projectsOut());
    if (req.method === 'POST' && rest === 'projects') { const o = JSON.parse((await body(req, 1 << 16)).toString('utf8')); setProject(o.id, o.name); return json(res, projectsOut()); }
    // A project's card numbers and footprint (computed by the page from its
    // survey files, kept so the Projects list needn't read them every time).
    if (rest === 'stats' && pidOf(q)) {
      const pd = projDir(pidOf(q)), f = pd ? path.join(pd, '.flex', 'stats.json') : null;
      if (req.method === 'GET') {
        if (f) { try { return json(res, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (_) { return json(res, null); } }
        try { return json(res, JSON.parse(kv()['stats:' + pidOf(q)] || 'null')); } catch (_) { return json(res, null); }
      }
      if (req.method === 'POST') {
        const o = JSON.parse((await body(req, 4 << 20)).toString('utf8'));
        if (f) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); }
        else kvSet('stats:' + pidOf(q), JSON.stringify(o));
        return json(res, { ok: true });
      }
    }
    // 📄 Docs: the project folder as it is on disk (not .flex), and a file from it.
    if (req.method === 'GET' && rest === 'tree' && pidOf(q)) {
      const pd = projDir(pidOf(q));
      if (!pd) return json(res, { folder: null, files: [] });
      return json(res, { folder: pd, files: listTree(pd) });
    }
    if (req.method === 'GET' && rest === 'file' && pidOf(q)) {
      const f = projFile(pidOf(q), String(q.path || ''));
      if (!f) return json(res, { error: 'not found' }, 404);
      const ext = path.extname(f).slice(1).toLowerCase();
      const type = FILE_MIME[ext] || 'application/octet-stream';
      const size = fs.statSync(f).size, head = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes', 'Content-Disposition': (FILE_MIME[ext] ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(f)) };
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));        // video and audio seek by ranges
      if (m && (m[1] || m[2])) {
        let a = m[1] ? +m[1] : Math.max(0, size - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
        if (a > b || a >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
        res.writeHead(206, Object.assign(head, { 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 }));
        return fs.createReadStream(f, { start: a, end: b }).pipe(res);
      }
      res.writeHead(200, Object.assign(head, { 'Content-Length': size }));
      return fs.createReadStream(f).pipe(res);
    }
    // A file written into the project folder (e.g. FLEX maps/…): never .flex, never outside, never over a different file unless overwrite=1.
    if (req.method === 'POST' && rest === 'putfile' && pidOf(q)) {
      const pd = projDir(pidOf(q)); if (!pd) return json(res, { error: 'no folder' }, 404);
      const rel = String(q.path || '').replace(/\\/g, '/').split('/').filter(x => x && x !== '.' && x !== '..').map(safeName).join('/');
      if (!rel || rel.split('/')[0].toLowerCase() === '.flex') return json(res, { error: 'bad path' }, 400);
      let dest = path.join(pd, rel);
      // A scan filed for a document (sketches.js): h=<sha256>&ext=<ext>. The bytes are checked, a different file is never
      // replaced (a free "name (2).ext" is used), and the file is reachable as /api/lib/blob/<h>.<ext> (files.json), one copy.
      if (q.h) {
        const h = String(q.h), x = String(q.ext || '');
        if (!HASH_RE.test(h) || !EXTS.has(x)) return json(res, { error: 'bad file' }, 400);
        const buf = await body(req, MAX_BLOB + 1);
        if (sha256(buf) !== h) return json(res, { error: 'hash mismatch' }, 400);
        let up = path.dirname(dest);                         // the deepest folder that exists must resolve inside the project
        while (!fs.existsSync(up) && up !== pd) up = path.dirname(up);
        const rb = fs.realpathSync(pd), ru = fs.realpathSync(up), rr = path.relative(rb, ru);
        if (rr.startsWith('..') || path.isAbsolute(rr) || rr.split(path.sep)[0] === '.flex') return json(res, { error: 'bad path' }, 400);
        const ex = path.extname(rel), stem = rel.slice(0, rel.length - ex.length);
        let out = rel;
        for (let k = 2; fs.existsSync(dest) && (fs.lstatSync(dest).isSymbolicLink() || sha256(fs.readFileSync(dest)) !== h) && k < 200; k++) { out = `${stem} (${k})${ex}`; dest = path.join(pd, out); }
        if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) return json(res, { error: 'bad path' }, 400);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) { fs.writeFileSync(dest + '.part', buf); fs.renameSync(dest + '.part', dest); }
        indexFile(pidOf(q), h + '.' + x, out);
        return json(res, { ok: true, path: out });
      }
      if (fs.existsSync(dest) && String(q.overwrite || '') !== '1') return json(res, { ok: true, path: rel, existed: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await body(req, 256 << 20));
      return json(res, { ok: true, path: rel });
    }
    if (req.method === 'POST' && rest === 'survey-export' && pidOf(q)) { const o = JSON.parse((await body(req, 32 << 20)).toString('utf8')); return json(res, surveyExport(pidOf(q), o.cave, o.files)); }
    if (req.method === 'GET' && rest === 'kv') return json(res, { v: kv()[q.k] ?? null });
    if (req.method === 'POST' && rest === 'kv') { const o = JSON.parse((await body(req, 1 << 20)).toString('utf8')); kvSet(o.k, o.v); return json(res, { ok: true }); }
    if (req.method === 'POST' && rest === 'blob') return json(res, putBlob(await body(req, MAX_BLOB + 1), String(q.ext || ''), q.h ? String(q.h) : null, pidOf(q)));
    if (req.method === 'POST' && rest === 'blobs-missing') {
      const o = JSON.parse((await body(req, 4 << 20)).toString('utf8'));
      const pd = pidOf(q) ? projDir(pidOf(q)) : null;
      // For a project with a folder, "missing" means not in that folder yet (pages travel with their project).
      return json(res, { missing: (o.names || []).filter(n => { const m = nameRe.exec(n || ''); if (!m || !EXTS.has(m[2])) return false; const f = blobPath(n); return !f || (pd && path.relative(pd, f).split(path.sep)[0] === '..'); }) });
    }
    if (req.method === 'GET' && rest.startsWith('blob/')) {
      const f = blobPath(rest.slice(5));
      if (!f) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'Content-Type': MIME[nameRe.exec(rest.slice(5))[2]] || 'application/octet-stream', 'Cache-Control': 'max-age=31536000, immutable' });
      return fs.createReadStream(f).pipe(res);
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    return json(res, { error: e.message || String(e) }, 400);
  }
}

module.exports = { copyBlobTo, moveCave, setArchived, isArchived, mirrorArchived, copyTree, listTree, projFile, surveyExport, handle, device, read, append, merge, putBlob, blobPath, projects, setProject, adoptFolder, registerPrivate, indexFile, makeFolder, safeName, projDir, kv, kvSet, ROOT, PROJECTS_DIR };
