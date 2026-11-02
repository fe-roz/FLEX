// Tests of the pure parts of CalTopo writing in caltopo_api.js: signing a POST
// (form body) and a DELETE, the pull-to-pull diff, a patch applied to a feature.
// Made-up key and features only.
//
//   node tools/test_caltopo_write.js
'use strict';
const path = require('path'), crypto = require('crypto'), os = require('os'), fs = require('fs');
process.env.FLEX_CALTOPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-'));           // nothing written to user_files
process.env.FLEX_CALTOPO_KEY_FILE = path.join(process.env.FLEX_CALTOPO_DIR, 'none.json');
const A = require(path.join(__dirname, '..', 'caltopo_api.js'));
const { diff, compose, classOf } = A._t;

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };

const key = { id: 'TESTCRED0001', key: Buffer.from('not a real key, only for tests!!').toString('base64') };
const hmac = data => crypto.createHmac('sha256', Buffer.from(key.key, 'base64')).update(data).digest('base64');
const NOW = 1700000000000;

// POST: json + id + expires + signature in the form body; the signature covers the payload.
const p = '/api/v1/map/ABC12/Marker/m1', payload = JSON.stringify({ type: 'Feature', id: 'm1', properties: { title: 'Test pit' } });
const f = new URLSearchParams(A.formBody(p, key, payload, NOW));
ok('POST body carries the payload as json=', f.get('json') === payload);
ok('POST body: id and expires (now + 2 min)', f.get('id') === key.id && f.get('expires') === String(NOW + 120000));
ok('POST signature = HMAC("POST <path>\\n<expires>\\n<payload>")', f.get('signature') === hmac('POST ' + p + '\n' + (NOW + 120000) + '\n' + payload));
ok('POST signature changes with the payload', new URLSearchParams(A.formBody(p, key, payload + ' ', NOW)).get('signature') !== f.get('signature'));
// DELETE: in the query, json empty, no payload signed.
const d = new URLSearchParams(A.signedQuery('DELETE', p, key, '', NOW));
ok('DELETE query has json= (empty), id, expires', d.has('json') && d.get('json') === '' && d.get('id') === key.id && d.get('expires') === String(NOW + 120000));
ok('DELETE signature = HMAC("DELETE <path>\\n<expires>\\n")', d.get('signature') === hmac('DELETE ' + p + '\n' + (NOW + 120000) + '\n'));

// Diff between two pulls.
const F = (id, title, extra) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [-123.2, 41.5] }, properties: Object.assign({ class: 'Marker', title }, extra) });
const r1 = { state: { features: [F('a', 'Test pit'), F('b', 'Other'), F('c', 'Gone soon')] } };
const r2 = { state: { features: [F('a', 'Test pit'), F('b', 'Other renamed'), F('d', 'New one')] } };
const dd = diff(r1, r2), by = w => dd.filter(x => x.what === w).map(x => x.fid).join();
ok('diff: added / changed / removed', by('added') === 'd' && by('changed') === 'b' && by('removed') === 'c' && dd.length === 3, dd);
ok('diff: titles (removed: the old title)', dd.find(x => x.fid === 'c').title === 'Gone soon' && dd.find(x => x.fid === 'b').title === 'Other renamed');
ok('diff: same map → nothing', diff(r1, JSON.parse(JSON.stringify(r1))).length === 0);
ok('diff: first pull vs nothing → all added', diff(null, r1).length === 3);

// A patch applied to a feature: properties set, null removes, geometry replaced, class/updated kept.
const base = F('a', 'Test pit', { 'marker-color': 'FF0000', description: 'x', updated: 5, folderId: 'f1' });
const m = compose(base, { title: 'Test pit 2', 'marker-color': '00FF00', description: null, folderId: 'f2', geometry: { type: 'Point', coordinates: [-123.21, 41.51] }, class: 'Shape', updated: 9 });
ok('compose: title, colour, folder set', m.properties.title === 'Test pit 2' && m.properties['marker-color'] === '00FF00' && m.properties.folderId === 'f2');
ok('compose: null removes a property', !('description' in m.properties));
ok('compose: geometry replaced', m.geometry.coordinates[0] === -123.21);
ok('compose: class and updated not changed by a patch', m.properties.class === 'Marker' && m.properties.updated === 5);
ok('compose: the base is not modified', base.properties.title === 'Test pit' && base.geometry.coordinates[0] === -123.2);
ok('compose: a patch without geometry keeps it', compose(base, { title: 'y' }).geometry.coordinates[1] === 41.5);

ok('class: from the feature, else Marker for points, Shape for lines', classOf(base) === 'Marker' && classOf({ geometry: { type: 'LineString' } }) === 'Shape'
  && classOf({ geometry: { type: 'Point' } }) === 'Marker' && classOf(base, 'Folder') === 'Folder');

console.log(pass + ' passed, ' + fail + ' failed');
fs.rmSync(process.env.FLEX_CALTOPO_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
