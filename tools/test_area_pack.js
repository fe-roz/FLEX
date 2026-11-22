// area_pack.js + POST /api/areas/import: pack leaves points/ behind, unpack keeps to the allow-list, refuses paths that
// leave the folder and an existing area id (unless overwrite; the old folder is kept). Made-up area around 45.1234, -100.5678.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const JSZip = require('../viewer_build/libs/jszip.min.js');
const AP = require('./area_pack.js');
const areasApi = require('../areas_api.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 300) : '')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'areapack-'));
const ring = [[-100.57, 45.12], [-100.56, 45.12], [-100.56, 45.13], [-100.57, 45.13], [-100.57, 45.12]];

function makeArea(root, id) {
  const d = path.join(root, id);
  const put = (rel, s) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), s); };
  put('area.json', JSON.stringify({ id, name: 'Cave Ridge', ring, km2: 0.9, project: 'cr1', lidar: ['https://example.org/ept.json'],
    results: { ground: { bytes: 4 }, veg: { bytes: 8 }, bush: { bytes: 3 }, prospect: { bytes: 2 }, terrain: { bytes: 1 } } }));
  put('ground/ground.npy', '0123'); put('ground/grid.json', '{"cell":1}');
  put('veg/shapes.bin', '12345678'); put('veg/veg.json', '{}');
  put('bush/x.png', 'png'); put('bush/derived.json', '{}');
  put('prospect/candidates.geojson', '{"type":"FeatureCollection","features":[]}');
  put('terrain/ref.json', '{"ref":null}');
  put('points/chunk_000.npz', 'x'.repeat(5000));
  put('log.txt', 'log'); put('ground/evil.sh', 'rm');
  return d;
}

(async () => {
  const src = path.join(tmp, 'src'), dst = path.join(tmp, 'dst');
  const d = makeArea(src, 'acr1');
  const P = await AP.pack(d, null, { from: 'test' });
  const names = P.report.files.map(f => f.path);
  ok('pack: area.json and the result files', ['area.json', 'ground/ground.npy', 'veg/shapes.bin', 'bush/x.png', 'prospect/candidates.geojson', 'terrain/ref.json'].every(n => names.includes(n)), names);
  ok('pack: points/, log.txt and off-list files left behind', !names.some(n => /^points\/|log\.txt|evil/.test(n)) && P.report.left.includes('points/') && P.report.left.includes('ground/evil.sh'), P.report.left);
  ok('pack: project id kept', P.area.project === 'cr1' && P.area.id === 'acr1');
  ok('pack: size report', P.report.bytes > 0 && P.report.zipBytes === P.buffer.length && P.report.folders.veg === 10);

  fs.writeFileSync(path.join(d, 'bush', 'v.tif'), 'tif');
  const Pn = await AP.pack(d, null, { skip: /\.tif$/i });
  ok('pack skip: the GeoTIFF left behind', !Pn.report.files.some(f => /\.tif$/.test(f.path)) && Pn.report.left.includes('bush/v.tif'));
  fs.unlinkSync(path.join(d, 'bush', 'v.tif'));
  // the value rasters for the coloured map layers travel, with --no-tif too
  fs.writeFileSync(path.join(d, 'bush', 'brush.u8'), Buffer.alloc(4)); fs.writeFileSync(path.join(d, 'bush', 'maps.json'), '{}');
  fs.writeFileSync(path.join(d, 'ground', 'slope.u8'), Buffer.alloc(4)); fs.writeFileSync(path.join(d, 'ground', 'maps.json'), '{}');
  const Pr = await AP.pack(d, null, { skip: /\.tif$/i });
  ok('pack: brush.u8, slope.u8 and both maps.json go', ['bush/brush.u8', 'bush/maps.json', 'ground/slope.u8', 'ground/maps.json'].every(f => Pr.report.files.some(x => x.path === f)), Pr.report.files.map(f => f.path));
  ['bush/brush.u8', 'bush/maps.json', 'ground/slope.u8', 'ground/maps.json'].forEach(f => fs.unlinkSync(path.join(d, f)));
  const U = await AP.unpack(P.buffer, dst);
  ok('unpack: written into <root>/<id>', U.ok && fs.existsSync(path.join(dst, 'acr1', 'veg', 'shapes.bin')) && fs.readFileSync(path.join(dst, 'acr1', 'veg', 'shapes.bin'), 'utf8') === '12345678');
  const A = JSON.parse(fs.readFileSync(path.join(dst, 'acr1', 'area.json'), 'utf8'));
  ok('unpack: area.json with project, results, imported mark', A.project === 'cr1' && A.results.veg && A.imported && !A.packed && !fs.existsSync(path.join(dst, 'acr1', 'points')));
  let e = null; try { await AP.unpack(P.buffer, dst); } catch (x) { e = x; }
  ok('unpack: an existing id is refused', e && e.code === 'EXISTS');
  const U2 = await AP.unpack(P.buffer, dst, null, { overwrite: true });
  ok('unpack overwrite: replaced, old folder kept beside', U2.replaced && fs.readdirSync(dst).some(n => /^acr1\.replaced-/.test(n)) && fs.existsSync(path.join(dst, 'acr1', 'area.json')));

  // hostile packages
  const zipOf = async files => { const z = new JSZip(); Object.entries(files).forEach(([n, s]) => z.file(n, s)); return z.generateAsync({ type: 'nodebuffer' }); };
  const aj = JSON.stringify({ id: 'abad', name: 'x', ring, project: '' });
  for (const [label, n] of [['..', '../escape.txt'], ['nested ..', 'veg/../../escape.txt'], ['absolute', '/etc/x'], ['backslash', 'veg\\shapes.bin']]) {
    let er = null;
    const z = await zipOf({ 'area.json': aj, [n]: 'x' });
    // JSZip normalises some names on write; check what really is inside
    try { await AP.unpack(z, dst); } catch (x) { er = x; }
    const inside = Object.keys((await JSZip.loadAsync(z)).files);
    const leaked = fs.existsSync(path.join(tmp, 'escape.txt')) || fs.existsSync(path.join(dst, 'escape.txt'));
    ok('traversal refused (' + label + ')', !leaked && (er || !inside.some(x => x.includes('..'))), { inside, err: er && er.message });
  }
  ok('nothing written for refused packages', !fs.existsSync(path.join(dst, 'abad')) || !fs.readdirSync(path.join(dst, 'abad')).some(n => n === 'escape.txt'));
  const zx = await zipOf({ 'area.json': aj, 'veg/shapes.bin': '1', 'veg/run.sh': 'x', 'points/a.npz': 'x', 'other/x.png': 'p' });
  const Ux = await AP.unpack(zx, dst);
  ok('off-list entries refused, listed, not written', Ux.written.length === 1 && Ux.refused.length === 3 && !fs.existsSync(path.join(dst, 'abad', 'veg', 'run.sh')) && !fs.existsSync(path.join(dst, 'abad', 'points')), Ux);
  let e2 = null; try { await AP.unpack(await zipOf({ 'area.json': JSON.stringify({ id: '../x', ring }) }), dst); } catch (x) { e2 = x; }
  ok('bad area id refused', e2 && /id/.test(e2.message));
  let e3 = null; try { await AP.unpack(await zipOf({ 'veg/shapes.bin': '1' }), dst); } catch (x) { e3 = x; }
  ok('no area.json refused', !!e3);
  ok('classify', AP.classify('ground/grid.json', areasApi.FILES).kind === 'file' && AP.classify('a/../b', areasApi.FILES).kind === 'bad' && AP.classify('C:/x', areasApi.FILES).kind === 'bad');

  // HTTP: POST /api/areas/import
  const root = path.join(tmp, 'store');
  const api = areasApi({ python: 'python3', root, terrainGen: { handle() {}, jobs: {} } });
  const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api.handle(req, res, u.pathname.replace(/^\/api\/areas\/?/, ''), Object.fromEntries(u.searchParams)); });
  await new Promise(r => srv.listen(0, r));
  const post = (p, buf) => new Promise((resolve, reject) => {
    const r = http.request({ port: srv.address().port, path: p, method: 'POST', headers: { 'Content-Type': 'application/zip', 'Content-Length': buf.length } }, res => {
      let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, j: JSON.parse(s) }));
    }); r.on('error', reject); r.end(buf);
  });
  const r1 = await post('/api/areas/import', P.buffer);
  ok('HTTP import: ok', r1.status === 200 && r1.j.ok && r1.j.area.id === 'acr1', r1);
  const r2 = await post('/api/areas/import', P.buffer);
  ok('HTTP import again: 409, exists', r2.status === 409 && r2.j.exists, r2);
  const r3 = await post('/api/areas/import?overwrite=1', P.buffer);
  ok('HTTP import overwrite=1: ok', r3.status === 200 && r3.j.replaced, r3);
  const list = await new Promise(r => http.get({ port: srv.address().port, path: '/api/areas' }, res => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => r(JSON.parse(s))); }));
  ok('imported area is listed by the store', (list.areas || []).some(a => a.id === 'acr1' && a.project === 'cr1'), list);
  const r4 = await post('/api/areas/import', Buffer.from('not a zip'));
  ok('HTTP import: not a zip → 400', r4.status === 400 && !r4.j.ok);
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
