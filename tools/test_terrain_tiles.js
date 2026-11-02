// Hillshade tiles of a project's terrain (terrain_generate.js) without a browser or PDAL:
//   node tools/test_terrain_tiles.js
// 1. a tile is drawn from the terrain patches named in ?dem= when this computer has no tile folder
//    (the project arrived by sync files): opaque inside the patch, clear outside, sun from the north-west;
// 2. with the folder present its own tiles are served (and a missing one is blank, as before);
// 3. several patches (a big area): the later one is on top, together they cover the area;
// 4. a finished job with several patches is kept as blobs, tiles URL carries ?dem=, and bad ?dem= is a 404.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), zlib = require('zlib'), crypto = require('crypto');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL', l, i === undefined ? '' : JSON.stringify(i)); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttiles_'));
const projDirs = { p1: path.join(tmp, 'proj1') }; fs.mkdirSync(projDirs.p1, { recursive: true });
const blobs = {};
const library = {
  ROOT: path.join(tmp, 'library'), safeName: s => String(s).replace(/[^\w .()-]/g, '-'), projDir: id => projDirs[id] || null,
  putBlob: (buf, ext) => { const h = crypto.createHash('sha256').update(buf).digest('hex'); const f = path.join(tmp, h + '.' + ext); fs.writeFileSync(f, buf); blobs[h + '.' + ext] = f; return { h, ext }; },
  blobPath: n => blobs[n] || null,
};
const gen = require('../terrain_generate')({ python: 'python3', script: 'x.py', library });

// a patch file, written as terrain_patch.js pack() / export_terrain.py do
function patch(W, S, E, N, nx, ny, f, name) {
  const head = Buffer.from(JSON.stringify({ format: 'flex-terrain-patch', version: 2, west: W, south: S, east: E, north: N, nx, ny, cell_m: (E - W) * 111320 * Math.cos(S * Math.PI / 180) / (nx - 1), name }));
  const pad = (4 - ((4 + head.length) % 4)) % 4, g = Buffer.alloc(nx * ny * 4);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) g.writeFloatLE(f(W + (E - W) * i / (nx - 1), N - (N - S) * j / (ny - 1)), (j * nx + i) * 4);
  const h = Buffer.alloc(4); h.writeUInt32LE(head.length + pad);
  return Buffer.concat([h, head, Buffer.alloc(pad, 32), g]);
}
const tileOf = (lon, lat, z) => { const n = 2 ** z; return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)]; };
function decode(png) {          // grey + alpha 8-bit, filter 0 only (what this server writes)
  ok('PNG signature', png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20); let off = 8, idat = [];
  while (off < png.length) { const n = png.readUInt32BE(off), t = png.toString('latin1', off + 4, off + 8); if (t === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + n)); off += 12 + n; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), la = Buffer.alloc(w * h * 2);
  for (let y = 0; y < h; y++) raw.copy(la, y * w * 2, y * (w * 2 + 1) + 1, (y + 1) * (w * 2 + 1));
  return { w, h, la, at: (x, y) => [la[(y * w + x) * 2], la[(y * w + x) * 2 + 1]] };
}

(async () => {
  // A patch of about 470 x 440 m, 1 m posts: a flat 100 m plain with a round hill (100 m radius, 30 m high) in its middle.
  const W = -100.5660, S = 45.1260, E = -100.5600, N = 45.1300, z = 17;
  // the hill sits in the middle of one tile
  const [tx, ty] = tileOf(-100.5630, 45.1280, z);
  const LC = (tx + 0.5) / 2 ** z * 360 - 180, AC = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 0.5) / 2 ** z))) * 180 / Math.PI;
  const hill = (lon, lat) => { const dx = (lon - LC) * 111320 * Math.cos(AC * Math.PI / 180), dy = (lat - AC) * 110540; return 100 + 30 * Math.max(0, 1 - Math.hypot(dx, dy) / 100); };
  const bin1 = patch(W, S, E, N, 470, 442, hill, 'one');
  const b1 = library.putBlob(bin1, 'bin'), name1 = b1.h + '.bin';
  
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); gen.handle(req, res, decodeURIComponent(u.pathname).slice('/api/terrain/'.length), Object.fromEntries(u.searchParams)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/terrain/tiles/p1/Hill%20maps';
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };

  // 1. no folder here: drawn from the patch
  let r = await get(`/${z}/${tx}/${ty}.png?dem=${name1}`);
  ok('no folder, ?dem=: a PNG', r.status === 200 && r.type === 'image/png', [r.status, r.type]);
  const t = decode(r.buf);
  ok('256 x 256 grey + alpha', t.w === 256 && t.h === 256 && t.la.length === 256 * 256 * 2);
  // where the tile lies in the patch (pixel -> lon/lat)
  const lonAt = px => ((tx + (px + 0.5) / 256) / 2 ** z) * 360 - 180, latAt = py => Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + (py + 0.5) / 256) / 2 ** z))) * 180 / Math.PI;
  let inside = 0, insideOpaque = 0, outside = 0, outsideClear = 0;
  for (let py = 0; py < 256; py += 4) for (let px = 0; px < 256; px += 4) {
    const lon = lonAt(px), lat = latAt(py), a = t.at(px, py)[1], within = lon > W + 1e-5 && lon < E - 1e-5 && lat > S + 1e-5 && lat < N - 1e-5;
    if (within) { inside++; insideOpaque += a === 255; } else if (lon < W - 1e-5 || lon > E + 1e-5 || lat < S - 1e-5 || lat > N + 1e-5) { outside++; outsideClear += a === 0; }
  }
  ok('opaque where the patch is', inside > 100 && insideOpaque === inside, [insideOpaque, inside]);
  ok('transparent where it is not', outside === 0 || outsideClear === outside, [outsideClear, outside]);
  // sun from the north-west: the hill's NW face is brighter than its SE face, the plain in between
  const px0 = Math.round((((LC + 0) + 180) / 360 * 2 ** z - tx) * 256), py0 = Math.round(((1 - Math.asinh(Math.tan(AC * Math.PI / 180)) / Math.PI) / 2 * 2 ** z - ty) * 256);
  const mpp = 156543.03392 * Math.cos(AC * Math.PI / 180) / 2 ** z, off = Math.round(40 / mpp);       // 40 m from the summit
  if (process.env.DBG) console.log('tile', tx, ty, 'summit px', px0, py0, 'off', off);
  const nw = t.at(px0 - off, py0 - off)[0], se = t.at(px0 + off, py0 + off)[0], plain = t.at(Math.min(255, px0 + Math.round(150 / mpp)), py0)[0];
  ok('NW face brighter than SE face', nw > se + 40, [nw, se, plain]);
  ok('flat ground is mid grey', plain > 120 && plain < 200, plain);

  // 3. two patches (a big area): the later one wins where they overlap
  const E2 = -100.5560, bin2 = patch(-100.5620, S, E2, N, 470, 442, () => 140, 'two');
  const b2 = library.putBlob(bin2, 'bin');
  const lon2 = -100.5585, [tx2, ty2] = tileOf(lon2, AC, z);
  const both = decode((await get(`/${z}/${tx2}/${ty2}.png?dem=${name1},${b2.h}.bin`)).buf), only = decode((await get(`/${z}/${tx2}/${ty2}.png?dem=${name1}`)).buf);
  const cnt = d => { let n = 0; for (let i = 0; i < d.w * d.h; i++) n += d.la[i * 2 + 1] === 255; return n; };
  ok('a second patch adds ground', cnt(both) > cnt(only), [cnt(both), cnt(only)]);

  // bad or missing ?dem= is a 404, not a crash
  ok('no ?dem= and no folder: 404', (await get(`/${z}/${tx}/${ty}.png`)).status === 404);
  ok('?dem= with a name that is not a blob: 404', (await get(`/${z}/${tx}/${ty}.png?dem=${'0'.repeat(64)}.bin`)).status === 404);
  ok('?dem= with a path in it: 404', (await get(`/${z}/${tx}/${ty}.png?dem=../../etc/passwd`)).status === 404);
  ok('a tile outside the patch: blank, not an error', (await get(`/${z}/${tx + 40}/${ty}.png?dem=${name1}`)).status === 200);

  // 2. with the folder: its tiles; missing one blank
  const dir = path.join(projDirs.p1, 'FLEX maps', 'Hill maps', String(z), String(tx)); fs.mkdirSync(dir, { recursive: true });
  const marker = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AARAAAAAAAAP//AwAC6gHxS8VCvQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(dir, ty + '.png'), marker);
  r = await get(`/${z}/${tx}/${ty}.png?dem=${name1}`);
  ok('folder present: its own tile', r.buf.equals(marker));
  r = await get(`/${z}/${tx}/${ty + 1}.png?dem=${name1}`);
  ok('folder present, no such tile: blank 1x1', r.status === 200 && decode(r.buf).w === 1);

  // 4. a finished job with two patches
  const out = path.join(tmp, 'job'); fs.mkdirSync(path.join(out, 'tiles', '5', '1'), { recursive: true });
  fs.writeFileSync(path.join(out, 'tiles', '5', '1', '1.png'), marker);
  fs.writeFileSync(path.join(out, 'terrain.bin'), bin1); fs.writeFileSync(path.join(out, 'terrain_2.bin'), bin2);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({
    name: 'Big', z_offset: -24.5, ground: 'classified',
    terrain: { file: 'terrain.bin', bounds: [W, S, E, N], nx: 470, ny: 442, cell_m: 1 },
    terrain_tiles: [{ file: 'terrain.bin', bounds: [W, S, E, N], nx: 470, ny: 442, cell_m: 1, name: 'Big (part 1)' }, { file: 'terrain_2.bin', bounds: [-100.562, S, E2, N], nx: 470, ny: 442, cell_m: 1, name: 'Big (part 2)' }],
    tiles: { dir: 'tiles', bounds: [W, S, E2, N], minzoom: 5, maxzoom: 5, count: 1, cell_m: 1 },
  }));
  const k = gen.finish({ outDir: out, pid: 'p1', name: 'Big' });
  ok('job kept: two terrain blobs', k.terrains.length === 2 && k.terrains.every(p => /^[0-9a-f]{64}\.bin$/.test(p.blob)), k.terrains);
  ok('job kept: the first patch is `terrain` (as before)', k.terrain.blob === k.terrains[0].blob);
  ok('job kept: tiles url carries both patches', k.tiles.url.endsWith('?dem=' + k.terrains.map(p => p.blob).join(',')), k.tiles.url);
  ok('job kept: tiles are in the project folder', fs.existsSync(path.join(projDirs.p1, k.folder, '5', '1', '1.png')));
  ok('job kept: a visible copy of each patch', fs.existsSync(path.join(projDirs.p1, k.folder, 'terrain patch.bin')) && fs.existsSync(path.join(projDirs.p1, k.folder, 'terrain patch (part 2).bin')));
  // 5. what the viewer export takes from the project: patch files and layer arguments
  ok('export: patch names → files; junk dropped', JSON.stringify(gen.exportPatchFiles([name1, '../x.bin', 'zz', 12])) === JSON.stringify([blobs[name1]]));
  const png = library.putBlob(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), 'png');
  const a1 = gen.exportLayerArgs('satellite', { kind: 'imagery', blob: png.h + '.png', bounds: [-100.57, 45.12, -100.55, 45.14] }, 8081);
  ok('export: a picture layer → image args', a1 && a1[1] === 'image' && a1.includes('--satellite-bounds') && a1.slice(-4).join(',') === '-100.57,45.12,-100.55,45.14', a1);
  ok('export: a picture layer as hillshade', gen.exportLayerArgs('hillshade', { kind: 'imagery', blob: png.h + '.png', bounds: [1, 2, 3, 4] }, 8081)[1] === 'image');
  ok('export: a picture that is not a blob here → null', gen.exportLayerArgs('satellite', { kind: 'imagery', blob: '0'.repeat(64) + '.png', bounds: [1, 2, 3, 4] }, 8081) === null);
  const a2 = gen.exportLayerArgs('satellite', { kind: 'tiles', url: 'https://tiles.example.invalid/{z}/{x}/{y}.png' }, 8081);
  ok('export: an online tile link → xyz args', a2 && a2[1] === 'xyz' && a2[3] === 'https://tiles.example.invalid/{z}/{x}/{y}.png', a2);
  const a3 = gen.exportLayerArgs('hillshade', { kind: 'tiles', url: '/api/terrain/tiles/p1/F/{z}/{x}/{y}.png?dem=a.bin' }, 8081);
  ok('export: a link on this server is fetched from here', a3 && a3[3].startsWith('http://127.0.0.1:8081/api/terrain/tiles/') && a3[0] === '--hillshade' && a3[1] === 'url', a3);
  ok('export: a link without {z}{x}{y} (WMS) → null', gen.exportLayerArgs('satellite', { kind: 'tiles', url: 'https://x.invalid/wms?bbox={westProjected}' }, 8081) === null);
  ok('export: file: and other schemes → null', gen.exportLayerArgs('satellite', { kind: 'tiles', url: 'file:///etc/{z}/{x}/{y}' }, 8081) === null);
  server.close();
  console.log(`terrain tiles: ${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e); process.exit(1); });
