// Tests of caltopo-layers.js — reading a CalTopo map's custom layers (class
// CustomLayer) into map layers FLEX can draw. Example links only.
//
//   node tools/test_caltopo_layers.js
'use strict';
const path = require('path');
const C = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'caltopo-layers.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };

const F = (id, p) => ({ id, type: 'Feature', geometry: null, properties: Object.assign({ class: 'CustomLayer' }, p) });
const tile = F('L1', { title: 'Cave Ridge shading', type: 'TILE', template: 'https://tiles.example.com/{Z}/{X}/{Y}.png', maxzoom: '16', alphaOverlay: true });
const base = F('L2', { title: 'Base', type: 'TMS', template: '//tiles.example.com/tms/{Z}/{X}/{Y}{2x}.png', maxzoom: '15', alphaOverlay: false });
const wms = F('L3', { title: 'WMS', type: 'WMS', template: 'https://wms.example.com/WMS?SERVICE=WMS&BBOX={left},{bottom},{right},{top}&WIDTH={tilesize}&HEIGHT={tilesize}&SRS=EPSG:3857', maxzoom: null, alphaOverlay: true });
const wms4326 = F('L4', { title: 'WMS deg', type: 'WMS', template: 'https://wms.example.com/WMS?BBOX={left},{bottom},{right},{top}&CRS=EPSG:4326&WIDTH={tilesize}&HEIGHT={tilesize}', alphaOverlay: true });
const wfs = F('L5', { title: 'WFS', type: 'WFS', template: 'https://wfs.example.com/wfs?BBOX={bottom},{left},{top},{right}' });
const utm = F('L6', { title: 'UTM', type: 'WMS', template: 'https://wms.example.com/WMS?BBOX={left},{bottom},{right},{top}&SRS=EPSG:26914' });
const marker = { id: 'M1', type: 'Feature', geometry: { type: 'Point', coordinates: [-100.5678, 45.1234] }, properties: { class: 'Marker', title: 'Cave Ridge' } };
const map = (feats, extra) => ({ result: Object.assign({ state: { features: feats } }, extra || {}) });

{
  const R = C.parse(map([marker, tile, base, wms, wms4326, wfs, utm]));
  const by = id => R.layers.find(l => l.id === id);
  ok('only CustomLayer features, the drawable ones', R.layers.map(l => l.id).join() === 'ct-L1,ct-L2,ct-L3,ct-L4', R.layers);
  ok('TILE: {Z}{X}{Y} → Cesium tags, max zoom a number', by('ct-L1').url === 'https://tiles.example.com/{z}/{x}/{y}.png' && by('ct-L1').maxZoom === 16 && by('ct-L1').name === 'Cave Ridge shading', by('ct-L1'));
  ok('TMS: rows from the bottom, protocol-relative link, {2x} dropped', by('ct-L2').url === 'https://tiles.example.com/tms/{z}/{x}/{reverseY}.png', by('ct-L2'));
  ok('WMS in EPSG:3857: projected bbox, 256 px', /BBOX=\{westProjected\},\{southProjected\},\{eastProjected\},\{northProjected\}&WIDTH=256&HEIGHT=256/.test(by('ct-L3').url), by('ct-L3'));
  ok('WMS in lon/lat: degrees bbox', /BBOX=\{west\},\{south\},\{east\},\{north\}/.test(by('ct-L4').url), by('ct-L4'));
  ok('WFS and other projections skipped, with a reason', R.skipped.length === 2 && /WFS/.test(R.skipped[0].why) && /26914/.test(R.skipped[1].why), R.skipped);
  ok('first look: overlay shown, base layer hidden', by('ct-L1').defShow === true && by('ct-L2').defShow === false);
}
{
  // The map's saved view (mapConfig.activeLayers) decides the first look when it is there.
  const alias = C.aliasOf(base.properties);
  ok('alias as CalTopo builds it', alias.startsWith('cl_') && JSON.parse(decodeURIComponent(alias.slice(3))).template === base.properties.template, alias);
  const R = C.parse(map([tile, base], { mapConfig: JSON.stringify({ activeLayers: [['mbt', 1], [alias, 0.6]] }) }));
  const by = id => R.layers.find(l => l.id === id);
  ok('saved view: the base layer on at 0.6, the overlay not listed → off', by('ct-L2').defShow === true && by('ct-L2').defAlpha === 0.6 && by('ct-L1').defShow === false, R.layers);
}
{
  ok('tolerant: no result, no state, odd features', C.parse(null).layers.length === 0 && C.parse({}).layers.length === 0 && C.parse(map([null, {}, F('x', {})])).layers.length === 0);
  ok('a link that is not a tile link is skipped', C.parse(map([F('y', { type: 'TILE', template: 'https://tiles.example.com/map.png' })])).skipped.length === 1);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
