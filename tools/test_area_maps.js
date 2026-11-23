// test_area_maps.js — area_tiles.js (ramps, tile maths, coloured tiles from a made-up area) and area_maps.py's layout.
// Made-up area near 45.1234, -100.5678.  node tools/test_area_maps.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');
const T = require('../area_tiles.js');
const AM = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'area-maps.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i) : '')); } };

// ramps
const r = T.parseRamp('0:0b3d0b00_1:0b3d0bff');
ok('ramp parses', r && r.length === 2 && r[0].a === 0 && r[1].a === 255 && r[1].g === 0x3d);
ok('ramp: 6-digit colour = opaque', T.parseRamp('0:ff0000_1:00ff00')[0].a === 255);
['', '0:ff0000', '0:ff0000_x:00ff00', '0.5:ff0000_0.2:00ff00', '0:ff0000_1.5:00ff00', '0:ff00_1:00ff00', Array(17).fill('0:ff0000').join('_'), '0:ff0000_1:00ff00;rm'].forEach(s => ok('ramp refused: ' + s.slice(0, 20), T.parseRamp(s) === null));
ok('ramp round trip', T.rampString(r) === '0:0b3d0b00_1:0b3d0bff');
const mid = T.rampAt(T.parseRamp('0:000000ff_1:ffffffff'), 0.5);
ok('interpolation midway', mid[0] === 128 && mid[3] === 255, mid);
ok('clamped below / above', T.rampAt(r, -1)[3] === 0 && T.rampAt(r, 2)[3] === 255);
const L = T.lut(T.parseRamp('0:000000ff_1:ffffffff'), 0, 1, 0, 1);
ok('lut: byte 0 transparent, 1 = low end, 255 = high end', L[3] === 0 && L[4] === 0 && L[7] === 255 && L[255 * 4] === 255);
// presets in area-maps.js are valid server ramps
Object.entries(AM.PRESETS).forEach(([m, ps]) => ps.forEach(p => { const r = AM.rampOf(AM.stopsOf(m, Object.assign(AM.defaults(m, {}), { preset: p.id }))); ok('ramp ' + m + '/' + p.id + ' parses', !!T.parseRamp(r), r); }));
ok('every ramp is offered on every map (classes on brush only)', ['slope', 'hillshade', 'voids'].every(m => AM.PRESETS[m].length === AM.RAMPS.length - 1) && AM.PRESETS.brush.length === AM.RAMPS.length);
ok('defaults: brush classes, slope CalTopo-style, hillshade black to white', AM.defaults('brush').preset === 'classes' && AM.defaults('slope').preset === 'caltopo' && AM.defaults('hillshade').preset === 'bw');
const cls = AM.stopsOf('brush', AM.defaults('brush'));
ok('brush classes: none clear below 10 %, then light, medium, dense (dense opaque)', cls[0][2] === 0 && cls[1][0] === 0.1 && cls[1][2] === 0 && cls[2][2] > 0 && cls[cls.length - 1][2] === 1, cls);
const cl2 = AM.stopsOf('brush', Object.assign(AM.defaults('brush'), { cuts: [0.2, 0.4, 0.8] }));
ok('cut-offs move the class edges', cl2[1][0] === 0.2 && cl2[3][0] === 0.4 && cl2[5][0] === 0.8, cl2);
const ct = T.parseRamp(AM.rampOf(AM.stopsOf('slope', AM.defaults('slope'))));
ok('CalTopo-style slope: clear below 27 deg, yellow from 27, black from 60 (over 0-70)', T.rampAt(ct, 20 / 70)[3] === 0 && T.rampAt(ct, 28 / 70)[0] === 255 && T.rampAt(ct, 28 / 70)[3] > 200 && T.rampAt(ct, 65 / 70)[0] === 0);
const cu = AM.stopsOf('slope', { preset: 'custom', start: '#ff0000', sa: 0.2, end: '#0000ff', ea: 1, lo: 0, hi: 70 });
ok('your two colours: start and end with their transparency', cu.length === 2 && cu[0][1] === 'ff0000' && cu[0][2] === 0.2 && cu[1][1] === '0000ff', cu);
ok('the pickers start from the chosen ramp', AM.endsOf('hillshade', AM.defaults('hillshade')).start === '#000000' && AM.endsOf('hillshade', AM.defaults('hillshade')).end === '#ffffff');
ok('url carries ramp, range and version', /\/api\/areas\/tiles\/a1\/slope\/\{z\}\/\{x\}\/\{y\}\.png\?ramp=.+&lo=0&hi=70&v=5$/.test(AM.urlOf('a1', 'slope', AM.defaults('slope', {}), 5)));

// utm: zone 14 central meridian -99; -100.5678, 45.1234 → known values (pyproj: 376426.6, 4997578.5 approx)
const u = T.utm(-100.5678, 45.1234, 14, false);
ok('utm easting/northing plausible', Math.abs(u[0] - 376400) < 600 && Math.abs(u[1] - 4997600) < 600, u);
const back = T.lonlatOf(u[0], u[1], 14, false);
ok('lonlatOf inverts utm', Math.abs(back[0] + 100.5678) < 1e-7 && Math.abs(back[1] - 45.1234) < 1e-7, back);
const x0 = Math.floor(u[0]) - 50, y0 = Math.floor(u[1]) - 30;
const G = { x0, y0, cell: 1, nx: 100, ny: 60, zone: 14, south: false, row0: 'south' };
const c = T.cellOf(G, -100.5678, 45.1234);
ok('lon/lat lands on its cell (row0 south)', Math.floor(c[0]) === Math.floor(u[0]) - x0 && Math.floor(c[1]) === Math.floor(u[1]) - y0, c);
const cN = T.cellOf(Object.assign({}, G, { row0: 'north' }), -100.5678, 45.1234);
ok('row0 north counts from the top', Math.floor(cN[1]) === G.ny - 1 - (Math.floor(u[1]) - y0), cN);
ok('outside the grid → null', T.cellOf(G, -100.6, 45.1234) === null);

// a made-up area: brush ramp across x, a plane tilted 45 deg (slope), and the converter for ground
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amaps-')), A = path.join(root, 'a1');
fs.mkdirSync(path.join(A, 'bush'), { recursive: true }); fs.mkdirSync(path.join(A, 'ground'), { recursive: true });
const nx = 200, ny = 160, cell = 1;
const gx0 = Math.floor(u[0]) - 100, gy0 = Math.floor(u[1]) - 80;
const grid = { x0: gx0, y0: gy0, cell, nx, ny, zone: 14, south: false, epsg: 32614 };
fs.writeFileSync(path.join(A, 'ground', 'grid.json'), JSON.stringify(Object.assign({ row0: 'south' }, grid)));
const py = `
import numpy as np, sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..'))})
import area_maps
A = ${JSON.stringify(A)}
g = json.load(open(A + '/ground/grid.json'))
ny, nx = g['ny'], g['nx']
yy, xx = np.mgrid[0:ny, 0:nx].astype(np.float32)
z = (xx * 1.0).astype(np.float32)          # rises 1 m per m eastward: 45 deg, facing west
z[:, :10] = np.nan
np.save(A + '/ground/ground.npy', z)
veg = np.tile(np.linspace(0, 1, nx, dtype=np.float32), (ny, 1))   # north-up: brush grows eastward
veg[:20] = np.nan
depth = np.full((ny, nx), np.nan, np.float32); depth[0:5, 0:5] = -3
area_maps.bush_maps(veg, depth, dict(g), A + '/bush')
area_maps.ground_maps(np.load(A + '/ground/ground.npy', mmap_mode='r'), g, A + '/ground')
`;
execFileSync('python3', ['-c', py]);
const bj = JSON.parse(fs.readFileSync(path.join(A, 'bush', 'maps.json'))), gj = JSON.parse(fs.readFileSync(path.join(A, 'ground', 'maps.json')));
ok('bush maps.json: brush + voids, row0 north', bj.grid.row0 === 'north' && bj.maps.map(m => m.id).join() === 'brush,voids' && bj.grid.nx === nx, bj);
ok('ground maps.json: slope + hillshade, row0 south', gj.grid.row0 === 'south' && gj.maps.map(m => m.id).join() === 'slope,hillshade');
ok('rasters one byte a cell', ['bush/brush.u8', 'bush/voids.u8', 'ground/slope.u8', 'ground/hillshade.u8'].every(f => fs.statSync(path.join(A, f)).size === nx * ny));
const br = fs.readFileSync(path.join(A, 'bush', 'brush.u8'));
ok('brush: top rows no data (north-up), west edge = level 1 (no brush), east = level 16', br[0] === 0 && br[30 * nx] === 1 && br[30 * nx + nx - 1] === 16);
const sl = fs.readFileSync(path.join(A, 'ground', 'slope.u8')), mid45 = sl[80 * nx + 100];
ok('slope of a 45 deg plane: the 45-50 deg level', gj.maps[0].values[mid45 - 1] === 45, mid45);
ok('16 levels with their values in maps.json', gj.maps.every(m => m.levels === 16 && m.values.length === 16) && bj.maps.every(m => m.levels === 16));
ok('slope: no data where the ground has none', sl[80 * nx + 3] === 0);

// tiles
const tiles = T({ root });
const call = (fn, ...a) => { const res = { h: {}, writeHead(s, h) { this.s = s; this.h = h; }, end(b) { this.b = b; } }; fn(res, ...a); return res; };
const M = JSON.parse(call(tiles.maps, 'a1').b);
ok('maps: four maps, bounds, zooms', M.ok && M.maps.length === 4 && M.bounds && M.minZoom === 11 && M.maxZoom >= 17 && M.maxZoom <= 19, M);
const tileOf = (lon, lat, z) => { const n = 2 ** z; return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n)]; };
const decode = png => { // RGBA, filter 0 only (ours)
  let o = 8, w, h, idat = [];
  while (o < png.length) { const n = png.readUInt32BE(o), t = png.toString('latin1', o + 4, o + 8), d = png.subarray(o + 8, o + 8 + n); if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); } if (t === 'IDAT') idat.push(d); o += 12 + n; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return { w, h, px };
};
const [tx, ty] = tileOf(-100.5678, 45.1234, 17);
const t1 = call(tiles.tile, `a1/brush/17/${tx}/${ty}.png`, { ramp: '0:000000ff_1:ffffffff', lo: '0', hi: '1' });
ok('tile 200 png, cacheable', t1.s === 200 && t1.h['Content-Type'] === 'image/png' && /max-age/.test(t1.h['Cache-Control']), t1.s);
const D = decode(t1.b);
ok('tile 256 px', D.w === 256 && D.h === 256);
// along a row inside the area brush gets lighter eastward; something is transparent (outside the 200 m grid at z17? the grid is 200 m: tile ~ 216 m)
let first = -1, last = -1, row = 128;
for (let x = 0; x < 256; x++) { const a = D.px[(row * 256 + x) * 4 + 3]; if (a) { if (first < 0) first = x; last = x; } }
ok('tile has data and it brightens eastward', first >= 0 && last > first && D.px[(row * 256 + last) * 4] > D.px[(row * 256 + first) * 4], [first, last]);
const far = tileOf(-100.70, 45.1234, 17);
const t2 = call(tiles.tile, `a1/brush/17/${far[0]}/${far[1]}.png`, {});
ok('outside the area: a blank tile', t2.s === 200 && t2.b.length < 100);
const hs = decode(call(tiles.tile, `a1/hillshade/17/${tx}/${ty}.png`, { ramp: '0:000000ff_1:ffffffff' }).b);
let anyHs = 0; for (let i = 3; i < hs.px.length; i += 4) if (hs.px[i]) anyHs++;
ok('hillshade tile not blank', anyHs > 1000, anyHs);
const s1 = decode(call(tiles.tile, `a1/slope/17/${tx}/${ty}.png`, { ramp: '0:000000ff_1:ffffffff', lo: '0', hi: '90' }).b);
const sv = s1.px[(128 * 256 + 128) * 4];
ok('slope tile: the 45 deg plane is mid grey', Math.abs(sv - 128) < 8, sv);
ok('bad ramp → 400', call(tiles.tile, `a1/brush/17/${tx}/${ty}.png`, { ramp: '0:zz' }).s === 400);
ok('bad range → 400', call(tiles.tile, `a1/brush/17/${tx}/${ty}.png`, { lo: '1', hi: '0' }).s === 400);
ok('unknown map → 404', call(tiles.tile, `a1/canopy/17/${tx}/${ty}.png`, {}).s === 400 || call(tiles.tile, `a1/canopy/17/${tx}/${ty}.png`, {}).s === 404);
ok('bad id → 400/404', [400, 404].includes(call(tiles.tile, `../x/brush/17/${tx}/${ty}.png`, {}).s));
const t0 = Date.now(); for (let z = 14; z <= 18; z++) { const [a, b] = tileOf(-100.5678, 45.1234, z); call(tiles.tile, `a1/slope/${z}/${a}/${b}.png`, { ramp: '0:000000ff_1:ff0000ff' }); }
ok('five fresh tiles under a second', Date.now() - t0 < 1000, Date.now() - t0);
// bilinear close up: at z21 slope is soft (many distinct colours), brush stays as cells (few)
const [bx21, by21] = tileOf(-100.5678, 45.1234, 21);
const distinct = png => { const D = decode(png), set = new Set(); for (let i = 0; i < D.px.length; i += 4) if (D.px[i + 3]) set.add(D.px[i] + ',' + D.px[i + 1]); return set.size; };
const hs21 = call(tiles.tile, `a1/hillshade/21/${bx21}/${by21}.png`, { ramp: '0:000000ff_1:ffffffff' }).b, hs21h = call(tiles.tile, `a1/hillshade/21/${bx21}/${by21}.png`, { ramp: '0:000000ff_1:ffffffff', smooth: '0' }).b;
ok('close up, hillshade is bilinear (softer than hard cells)', distinct(hs21) >= distinct(hs21h), [distinct(hs21), distinct(hs21h)]);
const sl21 = decode(call(tiles.tile, `a1/slope/21/${bx21}/${by21}.png`, { ramp: '0:000000ff_1:ffffffff', lo: '0', hi: '90' }).b);
ok('close up slope stays right (45 deg plane mid grey)', Math.abs(sl21.px[(128 * 256 + 128) * 4] - 128) < 8);
// version 1 files (1..255, no values) still draw
const V1 = path.join(root, 'v1', 'ground'); fs.mkdirSync(V1, { recursive: true });
fs.writeFileSync(path.join(V1, 'maps.json'), JSON.stringify({ version: 1, grid: Object.assign({}, grid, { row0: 'south' }), maps: [{ id: 'slope', file: 'slope.u8', units: 'degrees', min: 0, max: 90, suggest: [0, 60] }] }));
fs.writeFileSync(path.join(V1, 'slope.u8'), Buffer.alloc(nx * ny, 128));
const v1 = decode(call(tiles.tile, `v1/slope/17/${tx}/${ty}.png`, { ramp: '0:000000ff_1:ffffffff', lo: '0', hi: '90', smooth: '0' }).b);
ok('version 1 map: byte 128 = 45 deg (mid grey)', Math.abs(v1.px[(128 * 256 + 128) * 4] - 128) < 4, v1.px[(128 * 256 + 128) * 4]);
const V2 = T.valuesOf({ values: [0, 5, 10] });
ok('valuesOf: version 2 levels', V2[1] === 0 && V2[3] === 10 && isNaN(V2[0]) && isNaN(V2[4]));
// legacy: an area with only the old pngs
const B = path.join(root, 'old1', 'bush'); fs.mkdirSync(B, { recursive: true });
fs.writeFileSync(path.join(B, 'derived.json'), JSON.stringify({ raster_bounds_lonlat: [-100.57, 45.12, -100.56, 45.13] })); fs.writeFileSync(path.join(B, 'vegetation.png'), 'x');
const O = JSON.parse(call(tiles.maps, 'old1').b);
ok('old area: no maps, the vegetation png as legacy brush', O.ok && O.maps.length === 0 && O.legacy.length === 1 && O.legacy[0].id === 'brush');
// allow-list
const F = require('../areas_api.js').FILES;
ok('allow-list: the rasters and maps.json travel', F.bush.test('brush.u8') && F.bush.test('maps.json') && F.ground.test('slope.u8') && F.ground.test('hillshade.u8') && F.ground.test('maps.json') && !F.ground.test('direct.npy'));
fs.rmSync(root, { recursive: true, force: true });
console.log(`test_area_maps: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
