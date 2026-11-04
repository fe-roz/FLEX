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
  ok('defaults: off, fill 1.6, max 64 px / 6 m, band 0.3, edge 0.3, above dots, below red', S.SPLAT_DEFAULTS.on === false && S.SPLAT_DEFAULTS.fill === 1.6 && S.SPLAT_DEFAULTS.maxPx === 64 && S.SPLAT_DEFAULTS.maxWorld === 6 && S.SPLAT_DEFAULTS.band === 0.3 && S.SPLAT_DEFAULTS.edge === 0.3 && S.SPLAT_DEFAULTS.above === 'dots' && S.SPLAT_DEFAULTS.below === 'red');
  const c = S.sanitize({ on: true, fill: 99, maxPx: -3, maxWorld: 500, edge: 2, opacity: 0.5, band: 'x', above: 'lots', below: 'height', layer: 'Aerial', shade: false, junk: 1 });
  ok('sanitize clamps numbers and drops what is not valid', c.on === true && c.fill === 4 && c.maxPx === 3 && c.maxWorld === 30 && c.edge === 1 && c.opacity === 0.5 && !('band' in c) && !('above' in c) && c.below === 'height' && c.layer === 'Aerial' && c.shade === false && !('junk' in c), c);
  ok('the first version\'s single "other" setting becomes "above"', S.sanitize({ other: 'hidden' }).above === 'hidden' && S.sanitize({ other: 'normal', above: 'red' }).above === 'red');
  ok('every mode has its shader number', S.OTHER_MODES.hidden === 0 && S.OTHER_MODES.dots === 1 && S.OTHER_MODES.normal === 2 && S.OTHER_MODES.height === 3 && S.OTHER_MODES.red === 4);
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

// ── the atlas: the fit of a map into window pixels, the ring of slots ───────────────────────────────────────────────
{
  // A bilinear map exactly recovered
  const xs = [], ys = [], px = [], py = [];
  for (let j = 0; j <= 6; j++) for (let i = 0; i <= 6; i++) { const x = (i - 3) * 100, y = (j - 3) * 100; xs.push(x); ys.push(y); px.push(1000 + 2 * x + 0.1 * y + 1e-4 * x * y); py.push(500 - 0.1 * x - 2 * y + 2e-4 * x * y); }
  const a = S.fitBilinear(xs, ys, px), b = S.fitBilinear(xs, ys, py);
  ok('fitBilinear recovers an exact bilinear map', Math.abs(a[0] - 1000) < 1e-6 && Math.abs(a[1] - 2) < 1e-9 && Math.abs(a[2] - 0.1) < 1e-9 && Math.abs(a[3] - 1e-4) < 1e-12 && Math.abs(b[2] + 2) < 1e-9 && Math.abs(b[3] - 2e-4) < 1e-12, [a, b]);
  // A real one: UTM-like metres to Web Mercator pixels at level 19, fitted over 1.5 km, off by well under a pixel
  const lat0 = 45.1234 * D, lon0 = -100.5678 * D, lvl = 19, slot = 256;
  const mPerDegLat = 111132, mPerDegLon = 111320 * Math.cos(lat0);
  const toPix = (x, y) => { const f = S.tileFraction(MERC, lon0 + x / mPerDegLon * D, lat0 + y / mPerDegLat * D, lvl); return [f.fx * slot, f.fy * slot]; };
  const o = toPix(0, 0), X = [], Y = [], PX = [], PY = [];
  for (let j = 0; j <= 6; j++) for (let i = 0; i <= 6; i++) { const x = (i - 3) * 250, y = (j - 3) * 250, p = toPix(x, y); X.push(x); Y.push(y); PX.push(p[0] - o[0]); PY.push(p[1] - o[1]); }
  const ca = S.fitBilinear(X, Y, PX), cb = S.fitBilinear(X, Y, PY);
  let worst = 0; for (const [x, y] of [[620, -480], [-700, 300], [10, 10], [-300, -700]]) { const t = toPix(x, y), m = [1, x, y, x * y]; worst = Math.max(worst, Math.abs(t[0] - o[0] - (ca[0] + ca[1] * x + ca[2] * y + ca[3] * x * y)), Math.abs(t[1] - o[1] - (cb[0] + cb[1] * x + cb[2] * y + cb[3] * x * y))); }
  ok('the fit of a Web Mercator level-19 map over 1.5 km is off by under a pixel', worst < 1, worst);
  ok('east is +x pixels and north is -y pixels', ca[1] > 0 && cb[2] < 0);
  const tileM = L => (MERC.east - MERC.west) * 6378137 * Math.cos(lat0) / Math.pow(2, L);
  ok('atlas level: the finest one whose 7 tiles still cover the view', S.atlasLevel({ side: 480, N: 8, tileMetres: tileM }) === 18 && S.atlasLevel({ side: 200, N: 8, tileMetres: tileM }) === 19 && S.atlasLevel({ side: 3000, N: 8, tileMetres: tileM }) === 16 && S.atlasLevel({ side: 3000, N: 8, tileMetres: tileM, maxLevel: 12 }) === 12);
  const w = S.windowTiles(1000.4, 2000.6, 8);
  ok('the window is N tiles around the middle', w.x0 === 996 && w.y0 === 1997 && w.N === 8, w);
  ok('slots are a ring: tile x lives in x mod N, so neighbours stay neighbours and a pan only changes the edge', S.slotOf(996, 1997, 8).sx === 4 && S.slotOf(1003, 2004, 8).sy === 4 && S.slotOf(-1, -9, 8).sx === 7 && S.slotOf(-1, -9, 8).sy === 7 && S.slotOf(1004, 1997, 8).sx === S.slotOf(996, 1997, 8).sx);
  // after moving the window one tile east exactly one column of slots changes tile
  let changed = 0; for (let ty = 1997; ty < 2005; ty++) for (let tx = 997; tx < 1005; tx++) { const s1 = S.slotOf(tx, ty, 8); const was = { x: 996 + (((s1.sx - 996) % 8) + 8) % 8, y: 1997 + (((s1.sy - 1997) % 8) + 8) % 8 }; if (was.x !== tx || was.y !== ty) changed++; }
  ok('moving the window one tile re-assigns one row or column of slots (8), not all 64', changed === 8, changed);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
