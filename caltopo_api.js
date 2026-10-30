// CalTopo API for private maps: signed requests, made by this server.
//
// The key (credential id + secret, and an account id to list maps) is kept in
// user_files/caltopo_key.json — gitignored, never sent to the browser, never
// in a project or a sync file. Each person enters their own.
//
// Two kinds of key work the same way:
//   - a CalTopo Team service account (supported API; READ is enough), or
//   - a personal account credential (unofficial; see the FLEX help text).
//
// Signing (as CalTopo's Team API docs and caltopo-python do it):
//   data      = "GET <path>\n<expires>\n"           (POST: + the JSON payload)
//   signature = base64(HMAC-SHA256(base64decode(secret), data))
//   query     = ?json=&id=<credential id>&expires=<ms, now + 2 min>&signature=…
//
//   GET  /api/caltopo/key            → { set, id (masked), accountId, label }
//   POST /api/caltopo/key            {id, key, accountId?, label?}  (empty id clears it)
//   GET  /api/caltopo/maps           → maps the key can see (needs accountId)
//   GET  /api/caltopo/map?id=…&since=…  → the map's features (CalTopo JSON as is)
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const KEY_FILE = process.env.FLEX_CALTOPO_KEY_FILE || path.join(__dirname, 'user_files', 'caltopo_key.json');
const HOST = process.env.FLEX_CALTOPO_HOST || 'caltopo.com';            // tests: http://localhost:<port>
const TEST = /^http:\/\//.test(HOST) ? new URL(HOST) : null;
const ID_RE = /^[A-Za-z0-9]{1,40}$/;

function readKey() { try { const k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); return k && k.id && k.key ? k : null; } catch (_) { return null; } }
function writeKey(k) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  if (!k) { try { fs.unlinkSync(KEY_FILE); } catch (_) {} return; }
  fs.writeFileSync(KEY_FILE, JSON.stringify(k), { mode: 0o600 });
}

/** Query string for a signed request (exported for tests). */
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

function get(urlPath, key) {
  return new Promise((resolve, reject) => {
    const req = (TEST ? require('http') : https).request({ host: TEST ? TEST.hostname : HOST, port: TEST ? TEST.port : 443, path: urlPath + '?' + signedQuery('GET', urlPath, key), method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'FLEX' }, timeout: 30000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(text); } catch (_) {}
        if (res.statusCode >= 400 || !j || (j.status && j.status !== 'ok')) {
          const why = (j && (j.message || j.error)) || text.slice(0, 200) || res.statusMessage;
          return reject(Object.assign(new Error(`CalTopo said ${res.statusCode}: ${why}`), { status: res.statusCode }));
        }
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('CalTopo did not answer')));
    req.on('error', reject);
    req.end();
  });
}

function body(req, max = 1 << 16) {
  return new Promise((resolve, reject) => {
    const c = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else c.push(d); });
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const mask = id => (id ? id.slice(0, 3) + '…' + id.slice(-2) : '');

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
    const k = readKey();
    if (!k) return json(res, { error: 'No CalTopo key on this computer yet (📁 Project → CalTopo map → 🔑).' }, 400);
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
      const r = await get('/api/v1/map/' + id + '/since/' + since, k);
      return json(res, r.result || {});
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    return json(res, { error: e.message || String(e) }, e.status && e.status < 500 ? 502 : 500);
  }
}

module.exports = { handle, signedQuery, readKey, KEY_FILE };
