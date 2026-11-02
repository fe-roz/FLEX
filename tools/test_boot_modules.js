// Pure parts of the start-up modules: cesium-viewer, potree-viewer, render-loop, scene-controls.
const path = require('path');
const M = n => require(path.join(__dirname, '..', 'client', 'src', 'modules', n));
let pass = 0, fail = 0;
function ok(label, cond, info) { if (cond) pass++; else { fail++; console.log('FAIL', label, info !== undefined ? JSON.stringify(info) : ''); } }

{ // cesium-viewer
  const cv = M('cesium-viewer.js');
  const C = { ShadowMode: { DISABLED: 0 } };
  const o = cv.cesiumViewerOptions(C, 'T');
  ok('viewer opts', o.useDefaultRenderLoop === false && o.terrainProvider === 'T' && o.animation === false &&
     o.baseLayerPicker === false && o.timeline === false && o.navigationHelpButton === false && o.terrainShadows === 0, o);
  ok('default layers: OSM only visible', cv.DEFAULT_LAYERS.filter(l => l.show).map(l => l.name).join() === 'OpenStreetMaps' && cv.DEFAULT_LAYERS.length === 4);
  ok('translucency', cv.GLOBE_TRANSLUCENCY.nearValue === 0.7 && cv.GLOBE_TRANSLUCENCY.farValue === 1);
}
{ // potree-viewer
  const pv = M('potree-viewer.js');
  const flags = { toggleOther: true, toggleGround: false, toggleVegetation: true, toggleLowNoise: false };
  const cs = pv.createClassificationScheme(flags);
  ok('scheme keys', Object.keys(cs).join() === '0,1,2,3,4,5,6,7,8,9,12,DEFAULT', Object.keys(cs));
  ok('scheme flags', cs[2].visible === false && cs[3].visible === true && cs[7].visible === false && cs[9].name === 'water');
  const msl = (lat, lon) => 10 + lat + lon;
  const vm = { egm96: false, usgsRef: false };
  ok('matrix default', pv.pcMatrixElements({}, vm, msl)[11] === -32 * 0.766);
  vm.usgsRef = true;
  ok('matrix usgs', pv.pcMatrixElements({ _pcZscale: 2 }, vm, msl)[10] === 2 && pv.pcMatrixElements({ _pcZscale: 2 }, vm, msl)[11] === -64);
  vm.egm96 = true;
  const e = pv.pcMatrixElements({ _pcZscale: 2, _pcLat: 45.1234, _pcLon: -100.5678 }, vm, msl);
  ok('matrix egm96', e[11] === (10 + 45.1234 - 100.5678) * 2 && e.length === 16, e);
  let got = null;
  pv.createApplyPcMatrix({ viewModel: vm, meanSeaLevel: msl })({ _pcLat: 1, _pcLon: 2, matrix: { set: (...a) => { got = a; } } });
  ok('apply sets 16', got && got.length === 16 && got[11] === 13);
}
{ // render-loop
  const rl = M('render-loop.js');
  ok('height plain', rl.potreeCameraHeight(100, 0.5, { usgsRef: false, egm96: false }) === 100);
  ok('height corrected', Math.abs(rl.potreeCameraHeight(100, 0.5, { usgsRef: true }) - 100 / Math.cos(0.5)) < 1e-9);
  ok('fov portrait', Math.abs(rl.potreeFovDegrees(Math.PI / 2, Math.PI / 4, 0.5) - 90) < 1e-9);
  ok('fov landscape', Math.abs(rl.potreeFovDegrees(Math.PI / 2, Math.PI / 4, 1.5) - 45) < 1e-9);
  const st = { needsRefresh: false, refreshDistSq: 2500, minRefreshInterval: 2000 };
  ok('incidence not due', rl.incidenceRefreshDue(st, 3000, 1000) === false);
  ok('incidence due', rl.incidenceRefreshDue(st, 3000, 2500) === true);
  ok('incidence forced', rl.incidenceRefreshDue({ ...st, needsRefresh: true }, 0, 0) === true);
}
{ // scene-controls
  const sc = M('scene-controls.js');
  ok('budget M', sc.formatPointBudget(10_000_000) === '10 M' && sc.formatPointBudget(2_500_000) === '2.5 M');
  ok('budget K', sc.formatPointBudget(500_000) === '500 K');
  ok('far off', sc.formatFarDistance(0) === 'off');
  ok('far mi', sc.formatFarDistance(1609.344) === '1 mi' && sc.formatFarDistance(8046.72) === '5 mi', sc.formatFarDistance(1609.344));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
