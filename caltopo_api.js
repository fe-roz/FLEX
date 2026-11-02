// CalTopo API for private maps: signed requests, made by this server.
//
// The key (credential id + secret, and an account id to list maps) is kept in
// user_files/caltopo_key.json — gitignored, never sent to the browser, never
// in a project or a sync file. Each person enters their own.
//
// Two kinds of key work the same way:
//   - a CalTopo Team service account (supported API; READ is enough to view,
//     WRITE to edit), or
//   - a personal account credential (unofficial; see the FLEX help text).
//
// Signing (as CalTopo's Team API docs and caltopo-python do it):
//   data      = "<METHOD> <path>\n<expires>\n"     (POST: + the JSON payload)
//   signature = base64(HMAC-SHA256(base64decode(secret), data))
//   GET, DELETE: ?json=&id=<credential id>&expires=<ms, now + 2 min>&signature=…
//   POST:        the same fields form-encoded in the body, json=<payload> instead of empty
//
// Writes (as caltopo-python does them): create POST /api/v1/map/<map>/<Class>,
// update POST /api/v1/map/<map>/<Class>/<id> with the whole feature (properties
// are replaced, not merged), delete DELETE /api/v1/map/<map>/<Class>/<id>.
// Class: Marker (points), Shape (lines, polygons), Folder. A move between
// folders is properties.folderId.
//
// Kept beside the key (FLEX_CALTOPO_DIR, default user_files/):
//   caltopo_cache/<map>.json          the map as last pulled: offline display, base of edits
//   caltopo_cache/<map>.changes.json  {seen, changes:[{fid,title,what,at}]} pull-to-pull diffs, newest first
//   caltopo_queue.json                edits waiting for CalTopo (offline) or for a pick (conflict)
//   caltopo_log.jsonl                 one line per pull diff and per push
//
// An edit is checked against CalTopo before it is sent: the map is pulled and
// the feature's properties.updated compared with the one the edit was made on
// (base). Changed there meanwhile → a conflict, both versions kept, the person
// picks. CalTopo not reachable → the edit waits in the queue, sent on later
// pulls, requests and a timer.
//
//   GET  /api/caltopo/key            → { set, id (masked), accountId, label }
//   POST /api/caltopo/key            {id, key, accountId?, label?}  (empty id clears it)
//   GET  /api/caltopo/maps           → maps the key can see (needs accountId)
//   GET  /api/caltopo/map?id=…&since=…  → the map's features (CalTopo JSON as is); a full
//        pull (no since) is cached, diffed and logged, and sends waiting edits. CalTopo not
//        reachable → the cached copy with flexOffline: true, flexPulled: <ms>.
//   POST /api/caltopo/feature        {map, fid, cls?, base?, patch}  update (patch: property names
//        and/or geometry) — or {map, fid, cls?, base?, feature} whole feature — or {map, cls?, feature}
//        (no fid) create. → { ok:true, feature, fid } | { queued:true } | { conflict:true, mine, theirs }
//        | { ok:false, error, readOnly? }
//   DELETE /api/caltopo/feature?map=&fid=&cls=&base=   → the same answers
//   GET  /api/caltopo/queue?map=     → { pending:[{fid, title, what, at, state, error?, readOnly?, mine?, theirs?}] }
//        state: waiting | conflict | failed (a waiting edit CalTopo later refused)
//   POST /api/caltopo/resolve        {map, fid, pick:'mine'|'theirs'} → as /feature ('theirs' → {ok:true, dropped:true})
//   POST /api/caltopo/retry          {map?} send waiting edits now → { pending }
//   GET  /api/caltopo/changes?map=&since=  → { changes, seen }
//   POST /api/caltopo/seen           {map, at?} the person has looked (at: default now) → { seen }
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const KEY_FILE = process.env.FLEX_CALTOPO_KEY_FILE || path.join(__dirname, 'user_files', 'caltopo_key.json');
const DIR = process.env.FLEX_CALTOPO_DIR || path.join(__dirname, 'user_files');
const CACHE_DIR = path.join(DIR, 'caltopo_cache');
const QUEUE_FILE = path.join(DIR, 'caltopo_queue.json');
const LOG_FILE = path.join(DIR, 'caltopo_log.jsonl');
const HOST = process.env.FLEX_CALTOPO_HOST || 'caltopo.com';            // tests: http://localhost:<port>
const TEST = /^http:\/\//.test(HOST) ? new URL(HOST) : null;
const RETRY_MS = +process.env.FLEX_CALTOPO_RETRY_MS || 30000;
const ID_RE = /^[A-Za-z0-9]{1,40}$/;
const FID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const KEEP_CHANGES = 300;

const READ_ONLY_MSG = 'CalTopo refused the change: this key can only read the map. Enter a key that can write in 📍 Surface → CalTopo map: link and key → Change key… (Team: a service account with WRITE; personal: your account credential).';

function readKey() { try { const k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); return k && k.id && k.key ? k : null; } catch (_) { return null; } }
function writeKey(k) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  if (!k) { try { fs.unlinkSync(KEY_FILE); } catch (_) {} return; }
  fs.writeFileSync(KEY_FILE, JSON.stringify(k), { mode: 0o600 });
}

/** Query string for a signed request (exported for tests). POST: the form body without json (see formBody). */
function signedQuery(method, urlPath, key, payload = '', now = Date.now()) {
  const expires = now + 120000;
  let data = method.toUpperCase() + ' ' + urlPath + '\n' + expires + '\n';
  if (method.toUpperCase() === 'POST') data += payload;
  const signature = crypto.createHmac('sha256', Buffer.from(key.key, 'base64')).update(data).digest('base64');
  const q = new URLSearchParams();
  if (method.toUpperCase() !== 'POST') q.set('json', '');
  q.set('id', key.id); q.set('expires', String(expires)); q.set('signature', signature);
  return q.toString();
}
/** The form body of a signed POST: json=<payload>&id=…&expires=…&signature=… (exported for tests). */
function formBody(urlPath, key, payload, now = Date.now()) {
  return 'json=' + encodeURIComponent(payload) + '&' + signedQuery('POST', urlPath, key, payload, now);
}

/** A signed request to CalTopo. Rejects with .status (CalTopo answered) and .offline (it could not be reached). */
function request(method, urlPath, key, obj) {
  method = method.toUpperCase();
  const payload = method === 'POST' ? JSON.stringify(obj || {}) : '';
  const bodyText = method === 'POST' ? formBody(urlPath, key, payload) : '';
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json', 'User-Agent': 'FLEX' };
    if (method === 'POST') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(bodyText); }
    const req = (TEST ? require('http') : https).request({ host: TEST ? TEST.hostname : HOST, port: TEST ? TEST.port : 443,
      path: method === 'POST' ? urlPath : urlPath + '?' + signedQuery(method, urlPath, key), method, headers, timeout: method === 'GET' ? 30000 : 20000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(text); } catch (_) {}
        if (res.statusCode >= 400 || !j || (j.status && j.status !== 'ok')) {
          const why = (j && (j.message || j.error)) || text.slice(0, 200) || res.statusMessage;
          return reject(Object.assign(new Error(`CalTopo said ${res.statusCode}: ${why}`),
            { status: res.statusCode >= 400 ? res.statusCode : 502, offline: [502, 503, 504].includes(res.statusCode) }));
        }
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('CalTopo did not answer'), { offline: true })));
    req.on('error', e => { if (!e.status) e.offline = true; reject(e); });
    if (bodyText) req.write(bodyText);
    req.end();
  });
}
const get = (urlPath, key) => request('GET', urlPath, key);

function body(req, max = 1 << 22) {
  return new Promise((resolve, reject) => {
    const c = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else c.push(d); });
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const mask = id => (id ? id.slice(0, 3) + '…' + id.slice(-2) : '');

// ── Files: cache, changes, queue, log ───────────────────────────────────────
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); }
const cacheFile = map => path.join(CACHE_DIR, map + '.json');
const changesFile = map => path.join(CACHE_DIR, map + '.changes.json');
const readCache = map => readJson(cacheFile(map), null);                 // { map, pulled, result }
const writeCache = (map, result, pulled) => writeJson(cacheFile(map), { map, pulled: pulled || Date.now(), result });
const readChanges = map => readJson(changesFile(map), { seen: 0, changes: [] });
let queue = readJson(QUEUE_FILE, []);
if (!Array.isArray(queue)) queue = [];
const saveQueue = () => writeJson(QUEUE_FILE, queue);
function log(o) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, JSON.stringify(Object.assign({ t: new Date().toISOString() }, o)) + '\n'); } catch (e) { console.warn('[caltopo] log:', e.message); }
}

const feats = result => (result && result.state && Array.isArray(result.state.features) ? result.state.features : []);
function index(result) { const m = new Map(); feats(result).forEach(f => { if (f && f.id != null) m.set(String(f.id), f); }); return m; }
const titleOf = f => (f && f.properties && (f.properties.title || f.properties.class)) || '';
const sig = f => JSON.stringify([f.geometry || null, f.properties || {}]);
const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
const updOf = f => (f && f.properties ? f.properties.updated : undefined);

/** Pull-to-pull diff: [{fid, title, what}] (exported for tests). */
function diff(oldResult, newResult) {
  const a = index(oldResult), b = index(newResult), out = [];
  b.forEach((f, id) => { const o = a.get(id); if (!o) out.push({ fid: id, title: titleOf(f), what: 'added' }); else if (sig(o) !== sig(f)) out.push({ fid: id, title: titleOf(f), what: 'changed' }); });
  a.forEach((f, id) => { if (!b.has(id)) out.push({ fid: id, title: titleOf(f), what: 'removed' }); });
  return out;
}
/** A feature with a patch applied: property names set (null removes one), geometry replaced (exported for tests). */
function compose(f, patch) {
  const o = clone(f) || { type: 'Feature', properties: {} };
  o.type = o.type || 'Feature';
  o.properties = o.properties || {};
  Object.keys(patch || {}).forEach(k => {
    if (k === 'geometry') { if (patch.geometry) o.geometry = clone(patch.geometry); return; }
    if (k === 'class' || k === 'id' || k === 'updated') return;
    if (patch[k] === null) delete o.properties[k]; else o.properties[k] = patch[k];
  });
  return o;
}
const classOf = (f, cls) => {
  if (cls && /^[A-Za-z]{2,30}$/.test(cls)) return cls;
  const c = f && f.properties && f.properties.class;
  if (c) return c;
  const t = f && f.geometry && f.geometry.type;
  return t === 'Point' ? 'Marker' : 'Shape';
};

// What this server pushed: the `updated` each push left (undefined for a delete).
// pushedSincePull: the next pull doesn't count those as changed elsewhere.
// lastPushed: an edit made on the copy from before our own push isn't a conflict.
const pushedSincePull = {}, lastPushed = {};
const bag = (o, map) => (o[map] = o[map] || new Map());

/** A full pull of the map: cached, diffed against the last copy, logged. */
async function pull(map, k) {
  const r = await get('/api/v1/map/' + map + '/since/0', k);
  const result = r.result || {};
  absorb(map, result);
  return result;
}
function absorb(map, result) {
  const old = readCache(map), now = Date.now(), mine = bag(pushedSincePull, map), cur = index(result);
  if (old) {
    const d = diff(old.result, result).filter(c => !(mine.has(c.fid) && (mine.get(c.fid) === undefined || mine.get(c.fid) === updOf(cur.get(c.fid)))));
    if (d.length) {
      const ch = readChanges(map);
      ch.changes = d.map(c => Object.assign({ at: now }, c)).concat(ch.changes).slice(0, KEEP_CHANGES);
      writeJson(changesFile(map), ch);
      const pick = w => d.filter(c => c.what === w).map(c => ({ fid: c.fid, title: c.title }));
      log({ kind: 'pull', map, added: pick('added'), changed: pick('changed'), removed: pick('removed') });
    }
  } else {
    log({ kind: 'pull', map, first: true, features: feats(result).length });
    const ch = readChanges(map); if (!ch.seen) { ch.seen = now; writeJson(changesFile(map), ch); }
  }
  mine.clear();
  writeCache(map, result, now);
}
function cachePut(map, fid, f) {           // after a push: the cache follows what CalTopo now has
  const c = readCache(map); if (!c) return;
  if (!c.result.state) c.result.state = { type: 'FeatureCollection', features: [] };
  if (!Array.isArray(c.result.state.features)) c.result.state.features = [];
  const L = c.result.state.features, i = L.findIndex(x => String(x.id) === String(fid));
  if (f) { if (i >= 0) L[i] = f; else L.push(f); } else if (i >= 0) L.splice(i, 1);
  writeCache(map, c.result, c.pulled);
}

// ── Queue ───────────────────────────────────────────────────────────────────
let chain = Promise.resolve();
const locked = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
const pendingOf = map => queue.filter(q => !map || q.map === map).map(q => {
  const o = { fid: q.fid, title: q.title, what: q.op, at: q.at, state: q.state };
  if (q.error) o.error = q.error;
  if (q.readOnly) o.readOnly = true;
  if (q.state === 'conflict') { o.mine = q.mine; o.theirs = q.theirs; }
  return o;
});
const answerOf = q => q.state === 'conflict' ? { conflict: true, mine: q.mine, theirs: q.theirs }
  : q.state === 'failed' ? Object.assign({ ok: false, error: q.error }, q.readOnly ? { readOnly: true } : {}) : { queued: true };

/** Send the map's waiting edits (pulls first, unless given the result of one). → Map(qid → answer) */
async function flush(map, k, result) {
  const out = new Map();
  const todo = queue.filter(q => q.map === map && q.state === 'waiting');
  if (!todo.length) return out;
  const offline = q => {
    q.tries = (q.tries || 0) + 1; q.lastTry = Date.now(); q.error = 'CalTopo could not be reached';
    if (q.tries === 1) log({ kind: 'push', map, op: q.op, fid: q.fid, title: q.title, result: 'queued' });
    out.set(q.qid, { queued: true });
  };
  if (!result) {
    try { result = await pull(map, k); }
    catch (e) { if (!e.offline) throw e; todo.forEach(offline); saveQueue(); return out; }
  }
  const cur = index(result), since = bag(pushedSincePull, map), last = bag(lastPushed, map);
  for (const q of todo) {
    const now = cur.get(q.fid) || null, upd = updOf(now);
    if (q.op !== 'create' && !(q.op === 'delete' && !now)) {
      const ours = last.has(q.fid) && last.get(q.fid) === upd;
      if (!now || (q.base != null && upd !== q.base && !ours)) {           // changed (or deleted) in CalTopo meanwhile
        q.state = 'conflict'; q.theirs = now; q.theirsUpdated = upd;
        q.mine = q.op === 'delete' ? null : q.force ? q.mine : compose(q.baseFeature, q.patch);
        delete q.error; saveQueue();
        log({ kind: 'push', map, op: q.op, fid: q.fid, title: q.title, result: 'conflict' });
        out.set(q.qid, answerOf(q)); continue;
      }
    }
    try {
      let r = null, feat = null;
      if (q.op === 'delete') {
        if (now) r = await request('DELETE', `/api/v1/map/${map}/${q.cls}/${q.fid}`, k);
      } else if (q.op === 'create') {
        feat = clone(q.feature); delete feat.id; feat.type = 'Feature';
        r = await request('POST', `/api/v1/map/${map}/${q.cls}`, k, feat);
      } else {
        feat = q.force ? clone(q.mine) : compose(now, q.patch);
        feat.id = q.fid; feat.type = 'Feature';
        r = await request('POST', `/api/v1/map/${map}/${q.cls}/${q.fid}`, k, feat);
      }
      const got = r && r.result && r.result.properties ? r.result : feat;
      const fid = q.op === 'create' ? String((r && r.result && r.result.id) || q.fid) : q.fid;
      if (q.op === 'delete') { cachePut(map, fid, null); since.set(fid, undefined); last.delete(fid); }
      else { if (got.id == null) got.id = fid; cachePut(map, fid, got); since.set(fid, updOf(got)); last.set(fid, updOf(got)); }
      queue = queue.filter(x => x !== q); saveQueue();
      const o = { kind: 'push', map, op: q.op, fid, title: q.title, result: q.force ? 'resolved' : 'ok' };
      if (q.force) o.pick = 'mine';
      if (q.tries) o.tries = q.tries;
      log(o);
      out.set(q.qid, { ok: true, feature: got, fid });
    } catch (e) {
      if (e.offline) { offline(q); saveQueue(); continue; }
      const readOnly = e.status === 401 || e.status === 403;
      const error = readOnly ? READ_ONLY_MSG : (e.message || String(e));
      log({ kind: 'push', map, op: q.op, fid: q.fid, title: q.title, result: 'failed', error: readOnly ? 'read-only key' : error });
      if (!q.tries && !q.force) queue = queue.filter(x => x !== q);      // the edit just made: answered, not kept
      else { q.state = 'failed'; q.error = error; if (readOnly) q.readOnly = true; }
      saveQueue();
      out.set(q.qid, Object.assign({ ok: false, error }, readOnly ? { readOnly: true } : {}));
    }
  }
  return out;
}

/** A new edit: into the queue (merged with one already waiting for that feature), then sent if it can be. */
async function edit(map, k, o) {
  const fid = o.fid ? String(o.fid) : '';
  if (fid && !FID_RE.test(fid)) return { ok: false, error: 'bad feature id' };
  const cache = readCache(map);
  const known = fid && cache ? index(cache.result).get(fid) || null : null;
  const op = o.op;
  let q = op === 'create' ? null : queue.find(x => x.map === map && x.fid === fid && x.state !== 'failed');
  if (op !== 'create' && !known && !q) return { ok: false, error: 'That feature is not in FLEX’s copy of the CalTopo map; refresh the map first.' };
  let patch = o.patch || {};
  if (o.feature && op !== 'create') { patch = Object.assign({}, o.feature.properties || {}); if (o.feature.geometry) patch.geometry = o.feature.geometry; }
  if (q) {                                     // one already waiting for this feature: merged into it
    if (op === 'delete') q.op = 'delete';
    else if (q.op !== 'delete') {
      q.patch = Object.assign({}, q.patch, patch);
      if (q.state === 'conflict') q.mine = compose(q.mine || q.baseFeature, patch);
    }
    q.at = Date.now();
    if (patch.title) q.title = patch.title;
    saveQueue();
    if (q.state === 'conflict') return answerOf(q);
  } else {
    let base = o.base != null && o.base !== '' ? +o.base : updOf(known);
    if (base == null || isNaN(base)) base = null;
    q = { qid: crypto.randomBytes(6).toString('hex'), map, fid: fid || 'new-' + crypto.randomBytes(4).toString('hex'), op, at: Date.now(), state: 'waiting',
      cls: classOf(known || o.feature, o.cls), base, baseFeature: clone(known), tries: 0,
      title: patch.title || (o.feature && o.feature.properties && o.feature.properties.title) || titleOf(known) || fid };
    if (op === 'update') q.patch = patch;
    if (op === 'create') q.feature = clone(o.feature);
    queue.push(q); saveQueue();
  }
  const out = await flush(map, k);
  return out.get(q.qid) || answerOf(q);
}

async function resolve(map, k, fid, pick) {
  const q = queue.find(x => x.map === map && x.fid === fid && (x.state === 'conflict' || x.state === 'failed'));
  if (!q) return { ok: false, error: 'Nothing is waiting for a choice on that feature.' };
  if (pick === 'theirs') {
    queue = queue.filter(x => x !== q); saveQueue();
    log({ kind: 'push', map, op: q.op, fid, title: q.title, result: 'resolved', pick: 'theirs' });
    return { ok: true, dropped: true };
  }
  if (q.state === 'conflict') {
    q.force = true; q.base = q.theirsUpdated != null ? q.theirsUpdated : null;
    if (q.op === 'update' && !q.mine) q.mine = compose(q.baseFeature, q.patch);
    if (q.op === 'delete' && !q.theirs) { queue = queue.filter(x => x !== q); saveQueue(); return { ok: true }; }
  }
  q.state = 'waiting'; delete q.error; delete q.readOnly; saveQueue();
  const out = await flush(map, k);
  return out.get(q.qid) || answerOf(q);
}

// Waiting edits are tried again on a timer (and on pulls and other requests).
let lastAuto = 0;
function autoRetry() {
  const maps = [...new Set(queue.filter(q => q.state === 'waiting').map(q => q.map))];
  const k = readKey();
  if (!maps.length || !k) return;
  lastAuto = Date.now();
  maps.forEach(m => locked(() => flush(m, k)).catch(e => console.warn('[caltopo] retry:', e.message)));
}
const timer = setInterval(autoRetry, RETRY_MS); if (timer.unref) timer.unref();

/** /api/caltopo/<rest> */
async function handle(req, res, rest, query) {
  try {
    const q = query || {};
    if (rest === 'key' && req.method === 'GET') {
      const k = readKey();
      return json(res, k ? { set: true, id: mask(k.id), accountId: k.accountId || '', label: k.label || '' } : { set: false });
    }
    if (rest === 'key' && req.method === 'POST') {
      const o = JSON.parse((await body(req)) || '{}');
      if (!o.id) { writeKey(null); return json(res, { set: false }); }
      const id = String(o.id).trim(), key = String(o.key || '').trim(), accountId = String(o.accountId || '').trim();
      if (!ID_RE.test(id)) return json(res, { error: 'The credential ID should be letters and digits (12 for a personal key).' }, 400);
      if (!/^[A-Za-z0-9+/=_-]{20,200}$/.test(key) || Buffer.from(key, 'base64').length < 16) return json(res, { error: 'That doesn’t look like a CalTopo key/secret (base64, ~44 characters).' }, 400);
      if (accountId && !ID_RE.test(accountId)) return json(res, { error: 'The account / team ID should be letters and digits (6).' }, 400);
      writeKey({ id, key, accountId, label: String(o.label || '').slice(0, 60), saved: Date.now() });
      return json(res, { set: true, id: mask(id), accountId });
    }
    // Local state: answered without a key or CalTopo.
    const mapQ = ID_RE.test(String(q.map || '')) ? String(q.map) : '';
    if (rest === 'queue' && req.method === 'GET') return json(res, { pending: pendingOf(mapQ) });
    if (rest === 'changes' && req.method === 'GET') {
      if (!mapQ) return json(res, { error: 'bad map id' }, 400);
      const ch = readChanges(mapQ), since = +q.since || 0;
      return json(res, { changes: ch.changes.filter(c => c.at > since), seen: ch.seen || 0 });
    }
    if (rest === 'seen' && req.method === 'POST') {
      const o = JSON.parse((await body(req)) || '{}');
      const map = String(o.map || '');
      if (!ID_RE.test(map)) return json(res, { error: 'bad map id' }, 400);
      const ch = readChanges(map); ch.seen = +o.at || Date.now(); writeJson(changesFile(map), ch);
      return json(res, { seen: ch.seen });
    }
    const k = readKey();
    if (!k) return json(res, { ok: false, error: 'No CalTopo key on this computer yet (📍 Surface → CalTopo map: link and key → 🔑).' }, 400);
    if (Date.now() - lastAuto > 10000 && rest !== 'map') autoRetry();
    if (rest === 'maps' && req.method === 'GET') {
      if (!k.accountId) return json(res, { error: 'Add your account / team ID to list maps (or paste a map’s ID).' }, 400);
      const r = await get('/api/v1/acct/' + k.accountId + '/since/0', k);
      const feats = (r.result && r.result.features) || [];
      const folders = {};
      feats.forEach(f => { if (f.properties && f.properties.class === 'UserFolder') folders[f.id] = f.properties.title; });
      const maps = feats.filter(f => f.properties && f.properties.class === 'CollaborativeMap')
        .map(f => ({ id: f.id, title: f.properties.title || f.id, folder: folders[f.properties.folderId] || '', updated: f.properties.updated || 0 }))
        .sort((a, b) => (b.updated || 0) - (a.updated || 0));
      return json(res, { maps });
    }
    if (rest === 'map' && req.method === 'GET') {
      const id = String(q.id || '');
      if (!ID_RE.test(id)) return json(res, { error: 'bad map id' }, 400);
      const since = /^\d+$/.test(String(q.since || '')) ? String(q.since) : '0';
      if (since !== '0') { const r = await get('/api/v1/map/' + id + '/since/' + since, k); return json(res, r.result || {}); }
      try {
        const result = await locked(async () => {
          const r = await pull(id, k);
          if (!queue.some(x => x.map === id && x.state === 'waiting')) return r;
          await flush(id, k, r);
          return (readCache(id) || {}).result || r;          // with what was just sent
        });
        lastAuto = Date.now();
        return json(res, result);
      } catch (e) {
        const c = e.offline && readCache(id);
        if (!c) throw e;
        return json(res, Object.assign({}, c.result, { flexOffline: true, flexPulled: c.pulled }));
      }
    }
    if (rest === 'feature' && (req.method === 'POST' || req.method === 'DELETE')) {
      const o = req.method === 'POST' ? JSON.parse((await body(req)) || '{}') : { map: q.map, fid: q.fid, cls: q.cls, base: q.base };
      const map = String(o.map || '');
      if (!ID_RE.test(map)) return json(res, { ok: false, error: 'bad map id' }, 400);
      if (req.method === 'POST' && !o.patch && !o.feature) return json(res, { ok: false, error: 'nothing to change' }, 400);
      o.op = req.method === 'DELETE' ? 'delete' : o.fid ? 'update' : 'create';
      if (o.op === 'create' && !(o.feature && o.feature.geometry)) return json(res, { ok: false, error: 'a new feature needs a geometry' }, 400);
      return json(res, await locked(() => edit(map, k, o)));
    }
    if (rest === 'resolve' && req.method === 'POST') {
      const o = JSON.parse((await body(req)) || '{}');
      if (!ID_RE.test(String(o.map || '')) || !['mine', 'theirs'].includes(o.pick)) return json(res, { ok: false, error: 'map and pick (mine or theirs) needed' }, 400);
      return json(res, await locked(() => resolve(String(o.map), k, String(o.fid || ''), o.pick)));
    }
    if (rest === 'retry' && req.method === 'POST') {
      const o = JSON.parse((await body(req)) || '{}');
      const one = ID_RE.test(String(o.map || '')) ? String(o.map) : '';
      const maps = one ? [one] : [...new Set(queue.filter(x => x.state === 'waiting').map(x => x.map))];
      for (const m of maps) await locked(() => flush(m, k));
      return json(res, { pending: pendingOf(one) });
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    return json(res, { ok: false, error: e.message || String(e) }, e.status && e.status < 500 ? 502 : 500);
  }
}

module.exports = { handle, signedQuery, formBody, readKey, KEY_FILE, _t: { diff, compose, classOf, READ_ONLY_MSG } };
