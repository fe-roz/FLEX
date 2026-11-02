// FLEX's service worker: keeps map tiles and point-cloud data as they load, so a
// place you have looked at opens faster and still opens with no network.
//
// Registered by client/src/modules/offline-cache.js with scope "/" (the server sends
// Service-Worker-Allowed for this file). A classic worker, not a module: no imports.
//
// WHAT IS KEPT, and how
//   tiles        map tiles (imagery, hillshade, WMS maps, custom-layer tiles, also
//                through the server's /proxy and /ot-wms): cache first, a copy older
//                than a day is refreshed in the background.
//   pc           point-cloud data (ept.json, ept-hierarchy, ept-data, .laz / .las, COPC
//                range requests): cache first, refreshed in the background after a week.
//   lib          versioned scripts / styles from the CDNs the app loads: network first,
//                the kept copy is used only when the network fails.
//   shell        the app's own files (index.html, flex.js, modules, help, ...): NETWORK
//                FIRST, so a git pull shows up on the next load; the kept copy is used
//                only when the network fails. One copy per path.
//   tiles / pc / lib share one size-capped cache (default 2 GB, least recently used
//   goes first). The shell copy is small and not counted.
// NEVER KEPT (the worker does not even answer them): anything but GET, the FLEX API
//   (/api/*), the CalTopo API and login, anything with a key / token / signature / login
//   in the address or an Authorization header, cross-origin requests that send cookies,
//   Cesium ion and Bing (their terms do not allow keeping them), responses marked
//   no-store or private.
// Opaque cross-origin answers cannot be read (no status, no size): kept only for tiles
//   and libs, counted at a fixed generous size, and a tile is refreshed on its next
//   visit so a bad one does not stay.
//
// The pure functions (classify, planEviction, ...) are exported for Node tests
// (tools/test_offline_sw.js).
'use strict';

const CACHE_DATA = 'flex-data-v1';
const CACHE_SHELL = 'flex-shell-v1';
const DB_NAME = 'flex-offline';
const DEFAULT_CAP = 2 * 1024 * 1024 * 1024;
const OPAQUE_BYTES = { tile: 128 * 1024, lib: 1024 * 1024 };
const DEFAULT_TTL = { tile: 24 * 3600 * 1000, pc: 7 * 24 * 3600 * 1000, lib: 0 };
const MAX_ENTRY = 256 * 1024 * 1024;

// ── Pure: what is this request? ──────────────────────────────────────────────

const SECRET_PARAM = /key|token|secret|sig|auth|pass|session|cred|jwt|bearer|x-amz|x-goog|ticket/i;
const NEVER_HOST = [
  /(^|\.)virtualearth\.net$/i,                       // Bing: via Cesium ion, terms forbid keeping
  /(^|\.)ion\.cesium\.com$/i, /^api\.cesium\.com$/i, // Cesium ion: world terrain, imagery
  /^assets\.cesium\.com$/i,
  /^tile\.googleapis\.com$/i, /^mt\d?\.google\.com$/i,
];
const LIB_HOST = [
  /^cdn\.jsdelivr\.net$/i, /^cdnjs\.cloudflare\.com$/i, /^unpkg\.com$/i, /^code\.jquery\.com$/i,
  /^esm\.sh$/i, /^cesium\.com$/i, /^cdn\.cesium\.com$/i,
  /^fonts\.googleapis\.com$/i, /^fonts\.gstatic\.com$/i,
];
const TILE_PATH = /\/\d{1,2}\/\d+\/\d+(\.[a-z0-9]+)?$/i;
const PC_PATH = /\/ept(-data|-hierarchy|-sources)\/|\/ept\.json$|\.(laz|las|copc\.laz)$/i;

function hasSecret(u) {
  if (u.username || u.password) return true;
  for (const k of u.searchParams.keys()) if (SECRET_PARAM.test(k)) return true;
  return false;
}
const isCaltopo = h => /(^|\.)caltopo\.com$/i.test(h);
const tileLike = u => TILE_PATH.test(u.pathname) || /\/tiles?\//i.test(u.pathname) ||
  /request=getmap|tilematrix=|bbox=/i.test(u.search);

/**
 * { kind, range } for a request, kind one of
 *   'never'  do not touch it            'tile' | 'pc' | 'lib'  capped data cache
 *   'shell'  the app's own file         'pass'  none of ours (leave it alone)
 * o: { origin, destination, hasAuth, credentials, range, method }
 */
function classify(urlStr, o) {
  o = o || {};
  let u;
  try { u = new URL(urlStr); } catch (_) { return { kind: 'never' }; }
  if ((o.method || 'GET') !== 'GET') return { kind: 'never' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'never' };
  if (o.hasAuth) return { kind: 'never' };
  const same = u.origin === o.origin;
  if (!same && o.credentials === 'include') return { kind: 'never' };
  if (hasSecret(u)) return { kind: 'never' };

  if (same) {
    const p = u.pathname;
    if (p.startsWith('/api/') || p === '/api' || p.startsWith('/caltopo/') || p.startsWith('/user_files/')) return { kind: 'never' };
    if (p === '/proxy') {                        // the server's proxy: judge the address it fetches
      let inner = u.searchParams.get('url');
      if (!inner) { const m = /[?&]url=(.*)$/.exec(u.search); inner = m ? decodeURIComponent(m[1]) : null; }
      if (!inner) return { kind: 'never' };
      const c = classify(inner, { origin: '\u0000', destination: o.destination, range: o.range });
      return c.kind === 'tile' || c.kind === 'pc' ? c : { kind: 'never' };
    }
    if (p === '/ot-wms') return /request=getmap/i.test(u.search) ? { kind: 'tile' } : { kind: 'never' };
    if (PC_PATH.test(p)) return { kind: 'pc', range: !!o.range };
    if (TILE_PATH.test(p)) return { kind: 'tile' };
    return { kind: 'shell' };
  }

  const h = u.hostname;
  if (NEVER_HOST.some(r => r.test(h))) return { kind: 'never' };
  if (isCaltopo(h)) {                            // CalTopo: tiles only, never its API
    if (/^\/(api|rest|sideload|d|m|account|login)\b/i.test(u.pathname)) return { kind: 'never' };
    return /^\/tile\//i.test(u.pathname) || TILE_PATH.test(u.pathname) ? { kind: 'tile' } : { kind: 'never' };
  }
  if (PC_PATH.test(u.pathname)) return { kind: 'pc', range: !!o.range };
  if (LIB_HOST.some(r => r.test(h)) && /\.(js|mjs|css|woff2?|ttf|json|wasm)$/i.test(u.pathname)) return { kind: 'lib' };
  if (o.destination === 'image' || tileLike(u)) return { kind: 'tile' };
  return { kind: 'pass' };
}

/** The cache key: the address, plus the byte range when there is one (never fetched, only a name). */
function cacheKey(urlStr, range) {
  if (!range) return urlStr;
  return urlStr + (urlStr.indexOf('?') < 0 ? '?' : '&') + '__flexrange=' + encodeURIComponent(range);
}

/** Least recently used first, until the total is at or below cap * low. Returns the keys to drop. */
function planEviction(entries, cap, low) {
  if (low === undefined) low = 0.9;
  let total = 0;
  for (const e of entries) total += e.bytes || 0;
  if (total <= cap) return [];
  const goal = cap * low, out = [];
  const order = entries.slice().sort((a, b) => (a.used || 0) - (b.used || 0));
  for (const e of order) {
    if (total <= goal) break;
    out.push(e.key);
    total -= e.bytes || 0;
  }
  return out;
}

/** May a response with these headers be kept? */
function storable(cacheControl) {
  return !/no-store|private/i.test(cacheControl || '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classify, cacheKey, planEviction, storable, hasSecret, DEFAULT_CAP };
}
if (typeof self === 'undefined' || typeof self.addEventListener !== 'function' || typeof caches === 'undefined') {
  // Loaded by Node for the tests: no worker to set up.
} else {

// ── The index: one small row per kept item (size, last use), for the cap ─────

let _db = null, _idx = null, _loading = null, _total = 0;
let _cap = DEFAULT_CAP, _ttl = Object.assign({}, DEFAULT_TTL);
const _dirty = new Set(), _refreshing = new Set();
let _trimP = Promise.resolve();

function openDb() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('entries', { keyPath: 'key' }); r.result.createObjectStore('meta'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return _db;
}
const reqP = r => new Promise(res => { r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); });
const txDone = tx => new Promise(res => { tx.oncomplete = () => res(true); tx.onerror = tx.onabort = () => res(false); });

function load() {
  if (_loading) return _loading;
  _loading = (async () => {
    _idx = new Map(); _total = 0;
    try {
      const db = await openDb();
      const tx = db.transaction(['entries', 'meta'], 'readonly');
      const rows = (await reqP(tx.objectStore('entries').getAll())) || [];
      for (const r of rows) { _idx.set(r.key, r); _total += r.bytes || 0; }
      const cfg = await reqP(tx.objectStore('meta').get('config'));
      if (cfg) { if (cfg.cap > 0) _cap = cfg.cap; if (cfg.ttl) _ttl = Object.assign({}, DEFAULT_TTL, cfg.ttl); }
    } catch (_) { /* no IndexedDB: the cap still works for this run of the worker */ }
  })();
  return _loading;
}

async function writeRows(put, del) {
  try {
    const db = await openDb();
    const tx = db.transaction('entries', 'readwrite');
    const st = tx.objectStore('entries');
    for (const r of put) st.put(r);
    for (const k of del) st.delete(k);
    await txDone(tx);
  } catch (_) {}
}
async function flushDirty() {
  if (!_dirty.size) return;
  const rows = [];
  for (const k of _dirty) { const r = _idx.get(k); if (r) rows.push(r); }
  _dirty.clear();
  await writeRows(rows, []);
}

function trim() {
  _trimP = _trimP.then(async () => {
    await load();
    if (_total <= _cap) { await flushDirty(); return; }
    const victims = planEviction([..._idx.values()], _cap);
    const cache = await caches.open(CACHE_DATA);
    for (const k of victims) {
      await cache.delete(k);
      const r = _idx.get(k); if (r) { _total -= r.bytes || 0; _idx.delete(k); _dirty.delete(k); }
    }
    await writeRows([], victims);
    await flushDirty();
  }).catch(() => {});
  return _trimP;
}

async function saveConfig() {
  try {
    const db = await openDb();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ cap: _cap, ttl: _ttl }, 'config');
    await txDone(tx);
  } catch (_) {}
}

function touch(key) {
  const r = _idx.get(key);
  if (r) { r.used = Date.now(); _dirty.add(key); }
}

// ── Keeping a response ───────────────────────────────────────────────────────

async function store(res, c, key) {
  await load();
  const cache = await caches.open(CACHE_DATA);
  let bytes;
  if (res.type === 'opaque') {
    if (!OPAQUE_BYTES[c.kind]) return;                  // point-cloud data is always readable (CORS)
    if (c.kind === 'lib' && _idx.has(key)) return;      // a pinned version: first copy stays
    bytes = OPAQUE_BYTES[c.kind];
    await cache.put(key, res);
  } else {
    const ok = res.status === 200 || (c.range && res.status === 206);
    if (!ok || !storable(res.headers.get('cache-control'))) return;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_ENTRY || buf.byteLength > _cap / 4) return;
    const h = new Headers(res.headers);
    h.delete('content-encoding'); h.set('content-length', String(buf.byteLength));   // the body is stored decoded
    h.set('x-flex-status', String(res.status));
    await cache.put(key, new Response(buf, { status: 200, statusText: 'OK', headers: h }));
    bytes = buf.byteLength;
  }
  const old = _idx.get(key);
  if (old) _total -= old.bytes || 0;
  const now = Date.now();
  const row = { key, kind: c.kind, bytes, used: now, at: now };
  _idx.set(key, row); _total += bytes;
  await writeRows([row], []);
  if (_total > _cap) await trim();
}

function fromCache(hit, req, c) {
  if (hit.type === 'opaque') return req.mode === 'no-cors' ? hit : null;   // a CORS fetch cannot use an opaque copy
  const st = Number(hit.headers.get('x-flex-status')) || 200;
  if (st === 200) return hit;
  const h = new Headers(hit.headers); h.delete('x-flex-status');
  return new Response(hit.body, { status: st, statusText: 'Partial Content', headers: h });
}

async function cacheFirst(event, req, c) {
  await load();
  const range = c.range ? req.headers.get('range') : null;
  const key = cacheKey(req.url, range);
  const cache = await caches.open(CACHE_DATA);
  const hit = await cache.match(key, { ignoreVary: true });
  const out = hit && fromCache(hit, req, c);
  if (out) {
    touch(key);
    const row = _idx.get(key);
    const ttl = _ttl[c.kind];
    const online = self.navigator ? self.navigator.onLine !== false : true;
    if (row && online && Date.now() - row.at > ttl && !_refreshing.has(key)) {
      _refreshing.add(key);
      event.waitUntil(fetch(new Request(req, { cache: 'no-cache' })).then(r => store(r, c, key)).catch(() => {}).then(() => _refreshing.delete(key)));
    }
    return out;
  }
  if (hit) { await cache.delete(key); const r = _idx.get(key); if (r) { _total -= r.bytes || 0; _idx.delete(key); } }
  const res = await fetch(req);
  event.waitUntil(store(res.clone(), c, key).catch(() => {}));
  return res;
}

async function networkFirstData(event, req, c) {
  await load();
  const key = req.url;
  try {
    const res = await fetch(req);
    event.waitUntil(store(res.clone(), c, key).catch(() => {}));
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE_DATA);
    const hit = await cache.match(key, { ignoreVary: true });
    const out = hit && fromCache(hit, req, c);
    if (out) { touch(key); return out; }
    throw err;
  }
}

async function networkFirstShell(event, req) {
  try {
    const res = await fetch(req);
    if (res.status === 200 && res.type === 'basic' && !res.redirected) {
      const copy = res.clone();
      event.waitUntil((async () => {
        const cache = await caches.open(CACHE_SHELL);
        await cache.put(req, copy);
        // One copy per path: a changed query (?v=...) replaces, it does not pile up.
        for (const k of await cache.keys(req, { ignoreSearch: true })) if (k.url !== req.url) await cache.delete(k);
      })().catch(() => {}));
    }
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE_SHELL);
    const hit = await cache.match(req) || await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE_DATA && k !== CACHE_SHELL && k.indexOf('flex-') === 0) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const c = classify(req.url, {
    origin: self.location.origin, destination: req.destination, method: req.method,
    hasAuth: req.headers.has('authorization'), credentials: req.credentials, range: !!req.headers.get('range'),
  });
  if (c.kind === 'never' || c.kind === 'pass') return;               // untouched: the browser does what it always did
  if (c.kind === 'shell') event.respondWith(networkFirstShell(event, req));
  else if (c.kind === 'lib') event.respondWith(networkFirstData(event, req, c));
  else event.respondWith(cacheFirst(event, req, c));
});

async function stats() {
  await load();
  const kinds = {};
  for (const r of _idx.values()) { const k = kinds[r.kind] || (kinds[r.kind] = { n: 0, bytes: 0 }); k.n++; k.bytes += r.bytes || 0; }
  let shell = 0;
  try { shell = (await (await caches.open(CACHE_SHELL)).keys()).length; } catch (_) {}
  return { entries: _idx.size, bytes: _total, cap: _cap, kinds, shell, ttl: _ttl };
}

self.addEventListener('message', event => {
  const m = event.data || {}, port = event.ports && event.ports[0];
  const reply = v => { if (port) port.postMessage(v); };
  event.waitUntil((async () => {
    await load();
    if (m.type === 'config') {
      if (m.cap > 0) _cap = m.cap;
      if (m.ttl) _ttl = Object.assign({}, _ttl, m.ttl);
      await saveConfig();
      await trim();
      reply(await stats());
    } else if (m.type === 'stats') {
      await _trimP; await flushDirty(); reply(await stats());
    } else if (m.type === 'flush') {
      await _trimP; await flushDirty(); await trim(); reply(await stats());
    } else if (m.type === 'clear') {
      await _trimP;
      await caches.delete(CACHE_DATA);
      _idx.clear(); _total = 0; _dirty.clear();
      try { const db = await openDb(); const tx = db.transaction('entries', 'readwrite'); tx.objectStore('entries').clear(); await txDone(tx); } catch (_) {}
      reply(await stats());
    } else if (m.type === 'has') {
      const cache = await caches.open(CACHE_DATA);
      reply({ has: !!(await cache.match(cacheKey(m.url, m.range || null), { ignoreVary: true })) });
    } else reply({ error: 'unknown' });
  })().catch(() => reply({ error: 'failed' })));
});

}
