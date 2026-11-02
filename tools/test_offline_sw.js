// Tests of the pure parts of client/src/sw.js (the offline-cache worker): which
// requests are kept and how (tiles, point-cloud data, versioned libraries, the app's own
// files), which are never touched (the FLEX API, CalTopo's API, anything with a key,
// login or token in the address, Cesium ion), the byte-range key, and the size-cap
// eviction order. Example addresses only.
//
//   node tools/test_offline_sw.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
// client/ is "type": "module" for Node, but the worker is a classic script: run it as one.
const ctx = { module: { exports: {} }, URL, Headers, console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'sw.js'), 'utf8'), ctx);
const SW = ctx.module.exports;

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 400) : '')); } };
const O = 'http://localhost:8081';
const kind = (u, o) => SW.classify(u, Object.assign({ origin: O, method: 'GET' }, o || {})).kind;
const enc = encodeURIComponent;

// the app's own files: network first
for (const f of ['/', '/index.html', '/flex.js', '/help.html', '/client/src/modules/api.js', '/ui_kit.css', '/PotreeCopied/build/potree/potree.js', '/flex.js?v=3'])
  ok('app file is "shell" (network first): ' + f, kind(O + f) === 'shell', kind(O + f));
// the FLEX API and friends: never
for (const f of ['/api/lib/state', '/api/entwine/status', '/api/caltopo/map', '/api/updates/check', '/caltopo/status', '/user_files/library/x.json'])
  ok('never: ' + f, kind(O + f) === 'never', kind(O + f));
ok('never: not a GET', kind('https://tiles.example.com/3/1/2.png', { method: 'POST' }) === 'never');
ok('never: other schemes', kind('blob:http://localhost:8081/abc') === 'never' && kind('data:image/png;base64,AA') === 'never');
// tiles
ok('tile: plain z/x/y', kind('https://tiles.example.com/12/655/1583.png') === 'tile');
ok('tile: an image request from anywhere', kind('https://img.example.com/some/render?x=1', { destination: 'image' }) === 'tile');
ok('tile: WMS GetMap', kind('https://maps.example.com/wms?SERVICE=WMS&REQUEST=GetMap&BBOX=1,2,3,4') === 'tile');
ok('tile: ArcGIS tile path', kind('https://tiles.example.com/arcgis/rest/services/X/MapServer/tile/9/100/200') === 'tile');
ok('tile: the server\'s OpenTopography proxy, GetMap only', kind(O + '/ot-wms?REQUEST=GetMap&LAYERS=a') === 'tile' && kind(O + '/ot-wms?REQUEST=GetFeatureInfo') === 'never');
ok('tile: through /proxy', kind(O + '/proxy?url=' + enc('https://tiles.example.com/5/10/12.png')) === 'tile');
ok('tile: same-origin tiles', kind(O + '/tiles/7/20/40.png') === 'tile');
// CalTopo
ok('CalTopo tiles are kept (custom-layer tiles, also via /proxy)', kind('https://caltopo.com/tile/sg/12/655/1583.png') === 'tile' && kind(O + '/proxy?url=' + enc('https://caltopo.com/tile/sg/12/655/1583.png')) === 'tile');
ok('CalTopo API is never kept, also via /proxy', kind('https://caltopo.com/api/v1/map/AB12') === 'never' && kind(O + '/proxy?url=' + enc('https://caltopo.com/api/v1/map/AB12')) === 'never' && kind('https://caltopo.com/m/AB12') === 'never');
ok('/proxy to anything else is never kept', kind(O + '/proxy?url=' + enc('https://www.example.com/data.json')) === 'never' && kind(O + '/proxy') === 'never');
// keys and credentials
for (const q of ['key=abc', 'api_key=abc', 'access_token=abc', 'token=1', 'X-Amz-Signature=abc', 'sig=1', 'Authorization=x', 'session=1', 'password=1'])
  ok('never: a "' + q.split('=')[0] + '" in the address', kind('https://tiles.example.com/12/655/1583.png?' + q) === 'never');
ok('never: key inside a proxied address', kind(O + '/proxy?url=' + enc('https://tiles.example.com/5/10/12.png?key=abc')) === 'never');
ok('never: a login in the address (user:pass@)', kind('https://user:pw@tiles.example.com/5/10/12.png') === 'never');
ok('never: an Authorization header', kind('https://tiles.example.com/5/10/12.png', { hasAuth: true }) === 'never');
ok('never: a cross-origin request that sends cookies', kind('https://tiles.example.com/5/10/12.png', { credentials: 'include' }) === 'never');
ok('plain query is fine (style, format, layer)', kind('https://tiles.example.com/5/10/12.png?style=default&format=image%2Fpng&layer=base') === 'tile');
// Cesium ion / Bing
for (const u of ['https://assets.ion.cesium.com/1/layer.json', 'https://api.cesium.com/v1/assets/1/endpoint', 'https://ecn.t0.tiles.virtualearth.net/tiles/a1.jpeg?g=1', 'https://assets.cesium.com/1/2/3'])
  ok('never (terms): ' + u.split('/')[2], kind(u, { destination: 'image' }) === 'never', kind(u, { destination: 'image' }));
// point clouds
ok('pc: EPT pieces', ['ept.json', 'ept-hierarchy/0-0-0-0.json', 'ept-data/2-1-1-0.laz'].every(f => kind('http://localhost:8083/area/' + f) === 'pc'));
ok('pc: COPC / laz by range', SW.classify('https://data.example.com/a/area.copc.laz', { origin: O, range: true }).range === true);
ok('pc: a key in the address still means never', kind('https://data.example.com/ept-data/0-0-0-0.laz?token=1') === 'never');
// libraries
ok('lib: versioned CDN scripts and styles', kind('https://cdn.jsdelivr.net/npm/pkg@1.2.3/dist/a.min.js') === 'lib' && kind('https://cdnjs.cloudflare.com/ajax/libs/x/1.0/a.css') === 'lib');
ok('other cross-origin requests are left alone', kind('https://www.example.com/page.html') === 'pass' && kind('https://api.example.com/v1/things') === 'pass');
// keys of the range cache
ok('cache key: plain = the address; a range adds a name that is never fetched', SW.cacheKey('https://x.example.com/a.laz') === 'https://x.example.com/a.laz' &&
  SW.cacheKey('https://x.example.com/a.laz', 'bytes=0-99') !== SW.cacheKey('https://x.example.com/a.laz', 'bytes=100-199') && SW.cacheKey('https://x.example.com/a.laz', 'bytes=0-99').startsWith('https://x.example.com/a.laz?'));
ok('responses marked no-store / private are not kept', !SW.storable('private, max-age=0') && !SW.storable('no-store') && SW.storable('public, max-age=3600') && SW.storable(null));
// eviction
{
  const es = [{ key: 'a', used: 50, bytes: 400 }, { key: 'b', used: 10, bytes: 400 }, { key: 'c', used: 30, bytes: 400 }, { key: 'd', used: 90, bytes: 400 }, { key: 'e', used: 5, bytes: 400 }];
  ok('eviction: under the cap drops nothing', SW.planEviction(es, 2000).length === 0);
  const v = SW.planEviction(es, 1000, 0.8);
  ok('eviction: least recently used first, down to the low-water mark', JSON.stringify(v) === JSON.stringify(['e', 'b', 'c']), v);
  ok('eviction: the most recently used survive', !v.includes('d') && !v.includes('a'));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
