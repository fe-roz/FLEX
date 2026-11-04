// Tests of the pure parts of client/src/modules/splat-mode.js: option clean-up, the default colour layer,
// tile positions of a lon/lat for Web Mercator and Geographic schemes, the imagery level for a texel size,
// the square the mosaic covers, and the resampling of tile pixels into a cloud's own coordinates. Made-up data
// (45.1234, -100.5678).
//
//   node tools/test_splat_mode.js
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'client', 'src', 'modules', 'splat-mode.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const D = Math.PI / 180;
const MERC = { merc: true, west: -Math.PI, east: Math.PI, south: -85.0511287798 * D, north: 85.0511287798 * D, nx0: 1, ny0: 1 };
const GEO = { merc: false, west: -Math.PI, east: Math.PI, south: -Math.PI / 2, north: Math.PI / 2, nx0: 2, ny0: 1 };

// ── options ────────────────────────────────────────────────────────────────
{
  ok('defaults: off, fill 1.6, max 64 px, band 0.3, dots', S.SPLAT_DEFAULTS.on === false && S.SPLAT_DEFAULTS.fill === 1.6 && S.SPLAT_DEFAULTS.maxPx === 64 && S.SPLAT_DEFAULTS.band === 0.3 && S.SPLAT_DEFAULTS.other === 'dots');
  const c = S.sanitize({ on: true, fill: 99, maxPx: -3, opacity: 0.5, band: 'x', other: 'lots', layer: 'Aerial', shade: false, junk: 1 });
  ok('sanitize clamps numbers and drops what is not valid', c.on === true && c.fill === 4 && c.maxPx === 3 && c.opacity === 0.5 && !('band' in c) && !('other' in c) && c.layer === 'Aerial' && c.shade === false && !('junk' in c), c);
  ok('sanitize of nothing', JSON.stringify(S.sanitize(null)) === '{}' && JSON.stringify(S.sanitize('x')) === '{}');
  ok('default layer: the satellite one, else the first', S.pickLayerIndex(['OpenStreetMaps', 'Bing Maps Aerial', 'Roads']) === 1 && S.pickLayerIndex(['A', 'B']) === 0 && S.pickLayerIndex([]) === -1 && S.pickLayerIndex(['Sentinel-2 Cloudless 2023']) === 0);
}

// ── tiles ──────────────────────────────────────────────────────────────────
{
  const lon = -100.5678 * D, lat = 45.1234 * D, L = 18, n = Math.pow(2, L);
  const f = S.tileFraction(MERC, lon, lat, L);
  const fx = (-100.5678 + 180) / 360 * n, fy = (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * n;
  ok('Web Mercator tile position matches the slippy-map formula', Math.abs(f.fx - fx) < 1e-6 && Math.abs(f.fy - fy) < 1e-6, [f, fx, fy]);
  ok('north is the smaller y', S.tileFraction(MERC, lon, lat + 0.001, L).fy < f.fy && S.tileFraction(MERC, lon + 0.001, lat, L).fx > f.fx);
  const g = S.tileFraction(GEO, lon, lat, 3);
  ok('Geographic scheme: 2 x 1 root tiles, linear in lat', Math.abs(g.fx - (lon + Math.PI) / (2 * Math.PI) * 16) < 1e-9 && Math.abs(g.fy - (Math.PI / 2 - lat) / Math.PI * 8) < 1e-9, g);
  const mpp19 = S.metresPerTilePixel(MERC, 19, lat, 256);
  ok('about 0.21 m a pixel at level 19 near 45 degrees', mpp19 > 0.2 && mpp19 < 0.22, mpp19);
  ok('level: the coarsest one that is fine enough', S.chooseLevel({ scheme: MERC, texel: 0.25, lat, tileWidth: 256 }) === 19 && S.chooseLevel({ scheme: MERC, texel: 1, lat, tileWidth: 256 }) === 17 && S.chooseLevel({ scheme: MERC, texel: 0.01, lat, tileWidth: 256, maxLevel: 19 }) === 19);
  ok('level: backs off to stay within the tile budget', S.chooseLevel({ scheme: MERC, texel: 0.05, lat, tileWidth: 256, maxLevel: 21, tilesAt: l => l > 17 ? 100 : 4 }) === 17);
}

// ── the square under the view ───────────────────────────────────────────────
{
  ok('no nodes, no square', S.viewRect([]) === null);
  const boxes = [{ x0: 0, y0: 0, x1: 512, y1: 512, level: 0 }, { x0: 100, y0: 100, x1: 164, y1: 164, level: 5 }, { x0: 164, y0: 100, x1: 228, y1: 164, level: 5 }, { x0: 0, y0: 0, x1: 256, y1: 256, level: 2 }];
  const r = S.viewRect(boxes);
  ok('the square follows the deepest nodes and is margined', Math.abs(r.cx - 164) < 1e-9 && Math.abs(r.cy - 132) < 1e-9 && Math.abs(r.side - 128 * 1.25) < 1e-9, r);
  ok('the square is kept between the limits', S.viewRect([{ x0: 0, y0: 0, x1: 5, y1: 5, level: 3 }]).side === 60 && S.viewRect([{ x0: 0, y0: 0, x1: 90000, y1: 5, level: 3 }]).side === 3000);
}

// ── resampling ────────────────────────────────────────────────────────────────
{
  // A "map" of 2 x 2 tiles at level 1 (Web Mercator, 4 x 4 px tiles): the colour encodes the pixel, so we can see where each output pixel came from.
  const tw = 4, W = 8, H = 8, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; data[i] = x * 30; data[i + 1] = y * 30; data[i + 2] = 0; data[i + 3] = 255; }
  // cloud coordinates = lon / lat in radians, scaled to "metres" 1:1000 (a pure test: x east, y north); the square is the NE quadrant of the world's map
  const lonlat = (x, y) => [x / 1000, y / 1000];
  const T = 16, out = new Uint8Array(T * T * 4);
  // the square lon 0..pi/2 (east half, x tiles 1), lat 0..~ (north half, y tile 0): uses the top-right tile, bottom-left corner at the equator
  const side = 1.0 * 1000;     // 1 radian
  const cov = S.fillMosaic({ out, T, x0: 0, y0: 0, side, lonlat, scheme: MERC, level: 1, mosaic: { data, width: W, height: H, tx0: 0, ty0: 0, tw, th: tw } });
  ok('every output pixel found its tile pixel', cov > 0.99, cov);
  // output row 0 is the south edge (lat 0 = the map's middle, y = 4 px), going up (north) the y pixel decreases
  const px = (r, c) => { const q = (r * T + c) * 4; return [out[q], out[q + 1]]; };
  const a = px(0, 0), b = px(T - 1, 0), c = px(0, T - 1);
  ok('the south edge is row 0 and the map\'s y falls northwards (no flip)', a[1] > b[1] + 20, [a, b]);
  ok('east is to the right', c[0] > a[0] + 20, [a, c]);
  // a tile that did not load (alpha 0) leaves the output transparent
  const holes = data.slice(); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) holes[(y * W + x) * 4 + 3] = 0;
  const out2 = new Uint8Array(T * T * 4).fill(7);
  const cov2 = S.fillMosaic({ out: out2, T, x0: 0, y0: 0, side, lonlat, scheme: MERC, level: 1, mosaic: { data: holes, width: W, height: H, tx0: 0, ty0: 0, tw, th: tw } });
  ok('missing tiles: nothing covered, alpha 0', cov2 === 0 && out2[3] === 0 && out2[(T * T - 1) * 4 + 3] === 0, cov2);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
