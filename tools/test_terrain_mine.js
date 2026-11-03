// Terrain kept in 👤 My data and moved between places (terrain_generate.js), no browser, no PDAL:
//   node tools/test_terrain_mine.js
// 1. a finished job for dest "mine" puts the patch blob in My data's folder (.flex/blobs) and the hillshade tiles in
//    My data's FLEX maps/<name>/, served by /api/terrain/tiles/mine/…;
// 2. /generate with neither a project nor dest "mine" is refused; dest "mine" makes My data's folder;
// 3. moveTerrain: My data → a project, a project → another project, a project → My data: files copied (patch blob,
//    tile folder under a free name), layers written at the destination with the tiles link rewritten, the source
//    left untouched; bad input is refused (same place, unknown project, bad blob, bad folder).
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL', l, i === undefined ? '' : JSON.stringify(i)); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmine_'));
process.env.FLEX_LIBRARY_DIR = path.join(tmp, 'user_files', 'library');
process.env.FLEX_MINE_DIR = path.join(tmp, 'user_files', 'mine');
const library = require('../library'), mine = require('../mine'), FL = require('../viewer_build/libs/flexlib.js');
const gen = require('../terrain_generate')({ python: 'python3', script: 'x.py', library });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// two projects with folders (registered as private ones: the move only needs their folders)
const projDirOf = id => library.projDir(id);

function patch(name) {
  const nx = 4, ny = 4, head = Buffer.from(JSON.stringify({ format: 'flex-terrain-patch', version: 2, west: -100.57, south: 45.12, east: -100.56, north: 45.13, nx, ny, cell_m: 300, name }));
  const pad = (4 - ((4 + head.length) % 4)) % 4, g = Buffer.alloc(nx * ny * 4); for (let i = 0; i < nx * ny; i++) g.writeFloatLE(100 + i, i * 4);
  const h = Buffer.alloc(4); h.writeUInt32LE(head.length + pad);
  return Buffer.concat([h, head, Buffer.alloc(pad, 32), g]);
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

(async () => {
  // projects "pa" and "pb" in the library
  for (const [id, nm] of [['pa', 'Project A'], ['pb', 'Project B']]) {
    const d = path.join(tmp, 'proj_' + id);
    library.makeFolder(d, id, nm);
    const list = library.projects(); if (!list.some(p => p.id === id)) { library.registerPrivate(id, nm, d); }
  }
  // (registerPrivate marks them private; the move checks "unknown project" against projDir only for the terrain move)
  ok('projects have folders', !!projDirOf('pa') && !!projDirOf('pb'));

  // 1. a finished job for My data
  const outDir = path.join(tmp, 'job1'); fs.mkdirSync(path.join(outDir, 'tiles', '17', '1'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'terrain.bin'), patch('Cave Ridge'));
  fs.writeFileSync(path.join(outDir, 'tiles', '17', '1', '2.png'), PNG);
  fs.writeFileSync(path.join(outDir, 'tiles', 'tiles.json'), '{"maxzoom":17}');
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ name: 'Cave Ridge', z_offset: -24.5, ground: 'x',
    terrain: { file: 'terrain.bin', bounds: [-100.57, 45.12, -100.56, 45.13], nx: 4, ny: 4, cell_m: 300, name: 'Cave Ridge' },
    tiles: { dir: 'tiles', bounds: [-100.57, 45.12, -100.56, 45.13], minzoom: 16, maxzoom: 17, count: 1, cell_m: 0.5 } }));
  mine.ensure();
  const R = gen.finish({ outDir, pid: 'mine', name: 'Cave Ridge' });
  const md = library.projDir('mine');
  ok('My data folder is user_files/mine', md === process.env.FLEX_MINE_DIR, md);
  ok('patch blob in My data (.flex/blobs)', fs.existsSync(path.join(md, '.flex', 'blobs', R.terrain.blob)), R.terrain);
  ok('tiles + a copy of the patch in My data/FLEX maps/Cave Ridge', fs.existsSync(path.join(md, 'FLEX maps', 'Cave Ridge', '17', '1', '2.png')) && fs.existsSync(path.join(md, 'FLEX maps', 'Cave Ridge', 'terrain patch.bin')));
  ok('tiles link names "mine"', R.tiles.url.startsWith('/api/terrain/tiles/mine/Cave%20Ridge/{z}/{x}/{y}.png?dem=' + R.terrain.blob), R.tiles.url);
  const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); gen.handle(req, res, decodeURIComponent(u.pathname).slice('/api/terrain/'.length), Object.fromEntries(u.searchParams)); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/terrain/';
  let r = await fetch(base + 'tiles/mine/Cave%20Ridge/17/1/2.png');
  ok('a tile is served from My data', r.status === 200 && r.headers.get('content-type') === 'image/png' && Buffer.from(await r.arrayBuffer()).equals(PNG), r.status);
  // 2. generate: no project, no dest
  const post = async (rest, body) => { const x = await fetch(base + rest, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { s: x.status, j: await x.json() }; };
  let g = await post('generate', { bbox: [-100.57, 45.12, -100.56, 45.13], ept: ['https://example.invalid/c/ept.json'] });
  ok('generate with no project and no dest is refused', g.s === 400 && /project/.test(g.j.error), g);
  g = await post('generate', { dest: 'mine', bbox: [-100.57, 45.12, -100.56, 45.13] });
  ok('generate dest mine passes the project check (then asks for LiDAR)', g.s === 400 && /LiDAR/.test(g.j.error), g);

  // 3. moves
  const bin = fs.readFileSync(path.join(md, '.flex', 'blobs', R.terrain.blob));
  const layers = [
    { id: 'ter-' + R.terrain.blob.slice(0, 12), kind: 'terrain', blob: R.terrain.blob, bounds: R.terrain.bounds, name: 'Cave Ridge' },
    { id: 'hs-' + R.terrain.blob.slice(0, 12), kind: 'tiles', url: R.tiles.url, bounds: R.tiles.bounds, minZoom: 16, maxZoom: 17, name: 'Cave Ridge hillshade' }];
  let m = await post('move', { from: 'mine', to: 'pa', layers, who: 'T' });
  ok('My data → project A: ok', m.s === 200 && m.j.ok, m);
  const pa = projDirOf('pa');
  ok('the patch blob is in the project, the tiles folder copied', fs.existsSync(path.join(pa, '.flex', 'blobs', R.terrain.blob)) && fs.existsSync(path.join(pa, 'FLEX maps', 'Cave Ridge', '17', '1', '2.png')));
  ok('the source still has everything (nothing removed)', fs.existsSync(path.join(md, '.flex', 'blobs', R.terrain.blob)) && fs.existsSync(path.join(md, 'FLEX maps', 'Cave Ridge', '17', '1', '2.png')));
  const S = FL.replayProject(library.read('p-pa').split('\n').filter(Boolean).map(l => JSON.parse(l)), 'pa');
  const ls = FL.liveLayers(S);
  ok('project A has the two layers, tiles link rewritten to it', ls.length === 2 && ls.find(l => l.kind === 'tiles').url.startsWith('/api/terrain/tiles/pa/Cave%20Ridge/{z}/{x}/{y}.png?dem=') && ls.find(l => l.kind === 'terrain').blob === R.terrain.blob, ls);
  m = await post('move', { from: 'pa', to: 'pb', layers });
  const pb = projDirOf('pb');
  ok('project A → project B', m.s === 200 && fs.existsSync(path.join(pb, '.flex', 'blobs', R.terrain.blob)) && fs.existsSync(path.join(pb, 'FLEX maps', 'Cave Ridge', 'terrain patch.bin')), m);
  // the same terrain again into B: the same tiles folder is reused (no "(2)" copy)
  const m2 = await post('move', { from: 'pa', to: 'pb', layers });
  ok('again: the identical tiles folder is reused, nothing copied twice', m2.j.layers.find(l => l.kind === 'tiles').url.includes('/pb/Cave%20Ridge/') && m2.j.tilesCopied === 0 && !fs.existsSync(path.join(pb, 'FLEX maps', 'Cave Ridge (2)')), m2);
  // a different set of tiles under the same folder name gets a free name
  fs.writeFileSync(path.join(pb, 'FLEX maps', 'Cave Ridge', 'tiles.json'), '{"maxzoom":16}');
  const m3 = await post('move', { from: 'pa', to: 'pb', layers });
  ok('a different folder of the same name: copied under a free name, the link follows', m3.j.layers.find(l => l.kind === 'tiles').url.includes('/pb/Cave%20Ridge%20(2)/') && fs.existsSync(path.join(pb, 'FLEX maps', 'Cave Ridge (2)', '17', '1', '2.png')), m3);
  m = await post('move', { from: 'pb', to: 'mine', layers });
  ok('project B → My data', m.s === 200 && m.j.layers.length === 2, m);
  // refusals
  const bad = async (o, re) => { const x = await post('move', o); ok('refused: ' + JSON.stringify(Object.keys(o)) + ' ' + re, x.s === 400 && re.test(x.j.error), x); };
  await bad({ from: 'pa', to: 'pa', layers }, /two different/);
  await bad({ from: 'pa', to: 'nope', layers }, /unknown/);
  await bad({ from: 'pa', to: 'pb', layers: [] }, /nothing/);
  await bad({ from: 'pa', to: 'pb', layers: [{ id: 'x', kind: 'terrain', blob: '../../etc/passwd' }] }, /bad patch/);
  await bad({ from: 'pa', to: 'pb', layers: [{ id: 'x', kind: 'tiles', url: '/api/terrain/tiles/pa/..%2F..%2Fx/{z}/{x}/{y}.png' }] }, /bad folder|not a terrain/);
  await bad({ from: 'pa', to: 'pb', layers: [{ id: 'x', kind: 'tiles', url: 'https://example.invalid/{z}/{x}/{y}.png' }] }, /not a terrain tiles link/);
  await bad({ from: 'pa', to: 'pb', layers: [{ id: 'x', kind: 'imagery', blob: R.terrain.blob }] }, /only terrain/);
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
