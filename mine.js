// My data: the user's own saved collection (caves, points, data files,
// point cloud links) — kept across sessions and projects, never synced
// (doc 14). It is a private project ("mine") with a folder like any other,
// user_files/mine/, so it gets the same logs, history and stored files.
//
// The Caves panel's Recent list (/api/recents, /api/plt-cache) reads and
// writes My data once it exists; until then it uses recents.json and
// plt_cache/ as before. Migrate with tools/migrate_my_data.js.
//
//   cavefile.set { file, h, ext:'plt', place, display, lastUsed, removed }   a cave (removed = forgotten)
//   group.set    { group, name, kind:'caveset', caves, savedAt, removed }    a saved cave set
//   layer.set    { layer, kind:'pointcloud', url, name, lastUsed, removed } a point cloud link
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./library');
const FL = require('./viewer_build/libs/flexlib.js');

const MINE = 'mine';
const USER_FILES = path.dirname(lib.ROOT);
const MINE_DIR = process.env.FLEX_MINE_DIR || path.join(USER_FILES, 'mine');
const RECENTS_FILE = path.join(USER_FILES, 'recents.json');
const PLT_CACHE_DIR = path.join(USER_FILES, 'plt_cache');
const WHO = 'FLEX';

const sha = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
const lines = t => String(t || '').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);

const exists = () => !!lib.projDir(MINE);
/** Make My data's folder and register it (private: not in the project list, never synced). */
function ensure() {
  if (exists()) return lib.projDir(MINE);
  lib.makeFolder(MINE_DIR, MINE, 'My data');
  lib.registerPrivate(MINE, 'My data', MINE_DIR);
  return MINE_DIR;
}
const state = () => FL.replayProject(lines(lib.read('p-' + MINE)), MINE);
const rec = (op, data) => lib.append('p-' + MINE, Object.assign({ t: new Date().toISOString(), who: WHO, op }, data));
const setId = name => 'set-' + sha(String(name), 10);
const eptId = url => 'ept-' + sha(String(url), 12);

// ── Recent list, read from My data ──────────────────────────────────────────
function recents() {
  const S = state();
  const by = k => (a, b) => String(b[k] || '').localeCompare(String(a[k] || ''));
  const plt = Object.values(S.cavefiles).filter(c => !c.removed && c.h)
    .map(c => ({ name: c.file, georef: c.place == null ? null : c.place, displayOptions: c.display == null ? null : c.display, lastUsed: c.lastUsed || (c.updated && c.updated.t) || '' }))
    .sort(by('lastUsed'));
  const ept = Object.values(S.layers).filter(l => !l.removed && l.kind === 'pointcloud')
    .map(l => ({ url: l.url, name: l.name, lastUsed: l.lastUsed || (l.updated && l.updated.t) || '' })).sort(by('lastUsed'));
  const pltSets = Object.values(S.groups).filter(g => !g.removed && g.kind === 'caveset')
    .map(g => ({ name: g.name, savedAt: g.savedAt || '', caves: g.caves || [] })).sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  return { ept, plt, pltSets };
}
/** The Recent list as the page has it now: record only what changed. Missing caves are forgotten (kept in history). */
function saveRecents(data) {
  const S = state();
  const plt = Array.isArray(data && data.plt) ? data.plt : [], ept = Array.isArray(data && data.ept) ? data.ept : [], sets = Array.isArray(data && data.pltSets) ? data.pltSets : [];
  let n = 0;
  const seen = new Set();
  for (const p of plt) {
    if (!p || typeof p.name !== 'string' || !p.name) continue;
    seen.add(p.name);
    const cur = S.cavefiles[p.name], ch = {};
    if (!cur || cur.removed) ch.removed = false;
    if (!cur || !same(cur.place, p.georef)) ch.place = p.georef == null ? null : p.georef;
    if (!cur || !same(cur.display, p.displayOptions)) ch.display = p.displayOptions == null ? null : p.displayOptions;
    if (p.lastUsed && (!cur || cur.lastUsed !== p.lastUsed)) ch.lastUsed = String(p.lastUsed);
    if (Object.keys(ch).length) { rec('cavefile.set', Object.assign({ file: p.name }, ch)); n++; }
  }
  for (const c of Object.values(S.cavefiles)) if (!c.removed && !seen.has(c.file)) { rec('cavefile.set', { file: c.file, removed: true }); n++; }
  const seenL = new Set();
  for (const e of ept) {
    if (!e || typeof e.url !== 'string' || !e.url) continue;
    const id = eptId(e.url); seenL.add(id);
    const cur = S.layers[id];
    if (!cur || cur.removed || cur.name !== (e.name || '') || cur.lastUsed !== (e.lastUsed || '')) { rec('layer.set', { layer: id, kind: 'pointcloud', url: e.url, name: e.name || '', lastUsed: String(e.lastUsed || ''), removed: false }); n++; }
  }
  for (const l of Object.values(S.layers)) if (l.kind === 'pointcloud' && !l.removed && !seenL.has(l.id)) { rec('layer.set', { layer: l.id, removed: true }); n++; }
  const seenS = new Set();
  for (const s of sets) {
    if (!s || typeof s.name !== 'string' || !s.name) continue;
    const id = setId(s.name); seenS.add(id);
    const cur = S.groups[id];
    if (!cur || cur.removed || !same(cur.caves, s.caves) || cur.savedAt !== (s.savedAt || '')) { rec('group.set', { group: id, name: s.name, kind: 'caveset', caves: s.caves || [], savedAt: String(s.savedAt || ''), removed: false }); n++; }
  }
  for (const g of Object.values(S.groups)) if (g.kind === 'caveset' && !g.removed && !seenS.has(g.id)) { rec('group.set', { group: g.id, removed: true }); n++; }
  return n;
}

// ── Survey file text (the old plt_cache) ────────────────────────────────────
function surveyText(name) {
  const c = state().cavefiles[name];
  if (c && c.h) { const f = lib.blobPath(c.h + '.' + (c.ext || 'plt')); if (f) return fs.readFileSync(f, 'utf8'); }
  return null;
}
/** Store a cave's survey text: by fingerprint, plus a readable copy in Survey data/ (an older version goes to .flex/attic). */
function storeSurvey(name, text) {
  const dir = ensure();
  const buf = Buffer.from(String(text), 'utf8');
  const { h } = lib.putBlob(buf, 'plt', null, MINE);
  const rel = 'Survey data/' + lib.safeName(name) + '.plt';
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (fs.existsSync(f)) {
    const old = fs.readFileSync(f);
    if (!old.equals(buf)) {
      const att = path.join(dir, '.flex', 'attic', lib.safeName(name) + '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.plt');
      fs.mkdirSync(path.dirname(att), { recursive: true }); fs.copyFileSync(f, att);
    }
  }
  if (!fs.existsSync(f) || !fs.readFileSync(f).equals(buf)) { fs.writeFileSync(f + '.part', buf); fs.renameSync(f + '.part', f); }
  lib.indexFile(MINE, h + '.plt', rel);
  const cur = state().cavefiles[name];
  if (!cur || cur.h !== h) rec('cavefile.set', { file: name, h, ext: 'plt' });
  return h;
}

// ── Moving the old Recent list in ───────────────────────────────────────────
const safePltName = name => String(name).replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200);
function legacy() {
  let r = { ept: [], plt: [], pltSets: [] };
  try { r = Object.assign(r, JSON.parse(fs.readFileSync(RECENTS_FILE, 'utf8'))); } catch (_) {}
  const cache = {};
  try { fs.readdirSync(PLT_CACHE_DIR).filter(n => /\.plt$/i.test(n)).forEach(n => { cache[n.slice(0, -4)] = path.join(PLT_CACHE_DIR, n); }); } catch (_) {}
  return { r, cache };
}
/**
 * Bring recents.json and plt_cache/ into My data. Copies only; the old files stay.
 * Survey files in the cache that aren't in the Recent list come in too, last used = the file's date.
 */
function migrate({ go = false } = {}) {
  if (exists() && Object.keys(state().cavefiles).length) return { done: false, reason: 'My data already has caves' };
  const { r, cache } = legacy();
  const plan = { caves: [], sets: (r.pltSets || []).map(s => s.name), ept: (r.ept || []).map(e => e.url), missingText: [] };
  const listed = new Set((r.plt || []).map(p => p.name));
  const extra = Object.keys(cache).filter(k => ![...listed].some(n => safePltName(n) === k));
  for (const p of r.plt || []) { const f = cache[safePltName(p.name)]; if (!f) plan.missingText.push(p.name); plan.caves.push({ name: p.name, from: 'recent', file: f || null, p }); }
  for (const k of extra) plan.caves.push({ name: k, from: 'cache only', file: cache[k], p: { name: k, georef: null, displayOptions: null, lastUsed: fs.statSync(cache[k]).mtime.toISOString() } });
  if (!go) return { done: false, plan };
  ensure();
  for (const c of plan.caves) if (c.file) storeSurvey(c.name, fs.readFileSync(c.file, 'utf8'));
  saveRecents({ plt: plan.caves.filter(c => c.file).map(c => c.p), ept: r.ept || [], pltSets: r.pltSets || [] });
  // Check: what My data gives back equals what the old files held.
  const back = recents(), problems = [];
  for (const c of plan.caves) {
    if (!c.file) continue;
    const b = back.plt.find(x => x.name === c.name);
    if (!b) { problems.push('missing: ' + c.name); continue; }
    if (!same(b.georef, c.p.georef)) problems.push('placement differs: ' + c.name);
    if (!same(b.displayOptions, c.p.displayOptions || null)) problems.push('style differs: ' + c.name);
    if (surveyText(c.name) !== fs.readFileSync(c.file, 'utf8')) problems.push('survey text differs: ' + c.name);
  }
  if (!same(back.pltSets.map(s => [s.name, s.caves]), (r.pltSets || []).map(s => [s.name, s.caves || []]))) problems.push('cave sets differ');
  if (back.ept.length !== (r.ept || []).length) problems.push('point cloud links differ');
  return { done: true, plan, problems, back };
}

// ── HTTP: the old routes, served from My data once it exists ────────────────
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
function body(req) { return new Promise((resolve, reject) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); req.on('error', reject); }); }
/** Returns true when it answered (My data exists); false → the caller uses the old files. */
async function handleRecents(req, res) {
  if (!exists()) return false;
  try {
    if (req.method === 'GET') { json(res, recents()); return true; }
    const n = saveRecents(JSON.parse(await body(req) || '{}'));
    json(res, { ok: true, recorded: n }); return true;
  } catch (e) { json(res, { ok: false, error: e.message }, 400); return true; }
}
async function handlePltCache(req, res, query) {
  if (!exists()) return false;
  try {
    if (req.method === 'GET') {
      const name = String((query && query.name) || '');
      const t = name ? surveyText(name) : null;
      if (t == null) {                                   // not in My data: the old cache still answers
        const f = path.join(PLT_CACHE_DIR, safePltName(name) + '.plt');
        if (name && fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); fs.createReadStream(f).pipe(res); return true; }
        res.writeHead(404); res.end('Not found'); return true;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(t); return true;
    }
    const { name, text } = JSON.parse(await body(req) || '{}');
    if (!name || !text) { json(res, { ok: false, error: 'Missing name or text' }, 400); return true; }
    storeSurvey(String(name).slice(0, 200), String(text));
    json(res, { ok: true }); return true;
  } catch (e) { json(res, { ok: false, error: e.message }, 400); return true; }
}

/** /api/mine/<rest>: the page's way into My data (made on first use). */
async function handle(req, res, rest, query) {
  try {
    if (req.method === 'GET' && rest === 'read') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(exists() ? lib.read('p-' + MINE) : ''); }
    if (req.method === 'POST' && rest === 'append') { ensure(); return json(res, lib.append('p-' + MINE, JSON.parse(await body(req) || '{}'))); }
    if (req.method === 'POST' && rest === 'blob') {
      ensure();
      const c = []; await new Promise((r, j) => { req.on('data', d => c.push(d)); req.on('end', r); req.on('error', j); });
      return json(res, lib.putBlob(Buffer.concat(c), String((query && query.ext) || ''), null, MINE));
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) { return json(res, { error: e.message || String(e) }, 400); }
}

module.exports = { handle, MINE, MINE_DIR, exists, ensure, recents, saveRecents, surveyText, storeSurvey, migrate, handleRecents, handlePltCache };
