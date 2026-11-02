// Tests the pure parts of client/src/modules/navigation-aids/ (compass.js, minimap.js).
// Plain Node, synthetic data only.
const path = require('path');
const dir = path.join(__dirname, '..', 'client', 'src', 'modules', 'navigation-aids');
const compass = require(path.join(dir, 'compass.js'));
const minimap = require(path.join(dir, 'minimap.js'));
let pass = 0, fail = 0;
function ok(label, cond, info) {
  if (cond) pass++; else { fail++; console.log('FAIL', label, info === undefined ? '' : JSON.stringify(info)); }
}

// compass
ok('normalize 370', compass.normalizeDegrees(370) === 10);
ok('normalize -90', compass.normalizeDegrees(-90) === 270);
ok('normalize 0', compass.normalizeDegrees(0) === 0);
ok('cardinal 0', compass.getCardinalLabel(0) === 'N');
ok('cardinal 44', compass.getCardinalLabel(44) === 'NE');
ok('cardinal 90', compass.getCardinalLabel(90) === 'E');
ok('cardinal 359', compass.getCardinalLabel(359) === 'N');
ok('cardinal -45', compass.getCardinalLabel(-45) === 'NW');
ok('styles', compass.compassStyles.length === 4 && compass.compassStyles.every((s) => compass.compassSizeByStyle[s]));

// minimap attention keys
const k = minimap.getAttentionKey(-100.5678, 45.1234);
const u = minimap.unpackAttentionKey(k);
const cellDeg = minimap.ATTENTION_CELL_METERS / 111320;
ok('key round trip lon', Math.abs(u.lon - (-100.5678)) <= cellDeg / 2 + 1e-9, u);
ok('key round trip lat', Math.abs(u.lat - 45.1234) <= cellDeg / 2 + 1e-9, u);
ok('same cell same key', minimap.getAttentionKey(-100.5678, 45.1234) === minimap.getAttentionKey(-100.5678 + cellDeg / 10, 45.1234));

// layer definitions with a fake ol and proxy
global.ProxyUrlGenerator = { generateProxyUrl: (u) => 'proxied:' + u };
function Src(opts) { this.opts = opts; this.load = (t, s) => { this.last = s; }; }
Src.prototype.getTileLoadFunction = function () { return this.load; };
Src.prototype.setTileLoadFunction = function (f) { this.load = f; };
const ol = { source: { XYZ: Src, OSM: Src, TileArcGISRest: Src } };
const defs = minimap.createMiniMapLayerDefs(ol);
const names = defs.map((d) => d.name);
ok('layer names', JSON.stringify(names) === JSON.stringify(['Bing Maps Aerial', 'OpenStreetMaps', 'Slope Angle', 'US Karst Map', 'NGMDB Mosaic']), names);
const s = defs[0].createSource();
ok('xyz source', s.opts.maxZoom === 19);
s.load({}, 'http://x/1');
ok('proxified', s.last === 'proxied:http://x/1', s.last);
ok('proxify passthrough', minimap.proxifyOlSource(null) === null);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
