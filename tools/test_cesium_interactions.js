// Tests of the pure parts of client/src/modules/cesium-interactions.js:
// key -> flag mapping, which flags key-up leaves alone, fly speed from height,
// wheel multiplier clamp, and the 1.15 wheel step.
//
//   node tools/test_cesium_interactions.js
'use strict';
const path = require('path');
const M = require(path.join(__dirname, '..', 'client', 'src', 'modules', 'cesium-interactions.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const kc = ch => ch.charCodeAt(0);

// key -> flag
const MAP = { W: 'moveForward', S: 'moveBackward', E: 'moveUp', Q: 'moveDown', D: 'moveRight', A: 'moveLeft',
  F: 'Fly', T: 'TouchFly', H: 'hideCesium', L: 'showlidar', '0': 'removePC', '1': 'toggleOther', '2': 'toggleGround',
  '3': 'toggleVeg', '4': 'toggleLowNoise', '5': 'toggleAll', Z: 'pointS', X: 'pointM', C: 'pointL', V: 'measureDepth',
  R: 'route', B: 'routePoint', K: 'downloadPoints', P: 'displayPC', I: 'displayCave', O: 'showOpenTopo',
  N: 'cycleCompassStyle', M: 'toggleMiniMap' };
for (const [k, f] of Object.entries(MAP)) ok('key ' + k, M.getFlagForKeyCode(kc(k)) === f, M.getFlagForKeyCode(kc(k)));
ok('unmapped key', M.getFlagForKeyCode(kc('G')) === undefined);
ok('arrow key unmapped', M.getFlagForKeyCode(37) === undefined);

// held vs latched
for (const f of ['moveForward', 'moveBackward', 'moveUp', 'moveDown', 'moveLeft', 'moveRight', 'pointS', 'pointM', 'pointL', 'route', 'routePoint', 'downloadPoints'])
  ok('held ' + f, !M.isLatchedFlag(f));
for (const f of ['Fly', 'TouchFly', 'hideCesium', 'showlidar', 'removePC', 'toggleOther', 'toggleGround', 'toggleVeg', 'toggleLowNoise',
  'toggleAll', 'displayPC', 'displayCave', 'showOpenTopo', 'cycleCompassStyle', 'measureDepth', 'toggleMiniMap'])
  ok('latched ' + f, M.isLatchedFlag(f));

// fly speed: ~20 m/s at 20 m height and x1; floor 2; cap 20000
ok('speed at 20 m', M.flySpeedMps(20) === 20, M.flySpeedMps(20));
ok('speed at 0 m', M.flySpeedMps(0) === 10);
ok('speed floor', M.flySpeedMps(-100) === 2);
ok('speed cap', M.flySpeedMps(1e9) === 20000);
ok('speed grows with height', M.flySpeedMps(1000) === 510);

// multiplier clamp
ok('clamp low', M.clampFlyMult(0.001) === M.FLY_MULT_MIN && M.FLY_MULT_MIN === 0.1);
ok('clamp high', M.clampFlyMult(1e6) === M.FLY_MULT_MAX && M.FLY_MULT_MAX === 64);
ok('clamp inside', M.clampFlyMult(3) === 3);
ok('clamp NaN -> 1', M.clampFlyMult(NaN) === 1 && M.clampFlyMult(undefined) === 1);
let m = 1; for (let i = 0; i < 100; i++) m = M.clampFlyMult(m * 1.15);
ok('wheel up saturates', m === 64);
for (let i = 0; i < 100; i++) m = M.clampFlyMult(m / 1.15);
ok('wheel down saturates', m === 0.1);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
