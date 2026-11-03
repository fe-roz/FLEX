// Tests of the pure half of perf-probe.js (the Performance panel): percentiles, frame summaries, trimmed mean,
// fps gain, ranking of suggestions, the "Running slowly" pill's state machine, the split into categories.
//
//   node tools/test_perf_pure.js
'use strict';
const path = require('path');
const M = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'perf-probe.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// percentile / summarize
const a = [1, 2, 3, 4, 5];
ok('median of 5', M.percentile(a, 0.5) === 3);
ok('p0 and p100 are the ends', M.percentile(a, 0) === 1 && M.percentile(a, 1) === 5);
ok('between neighbours', near(M.percentile([10, 20], 0.25), 12.5));
ok('empty → NaN, one → itself', isNaN(M.percentile([], 0.5)) && M.percentile([7], 0.9) === 7);
const frames = Array.from({ length: 100 }, (_, i) => (i === 99 ? 90 : 16.7));
const s = M.summarize(frames);
ok('summary: n, p50, max', s.n === 100 && near(s.p50, 16.7) && s.max === 90, s);
ok('summary: p99 sees the hiccup, p95 does not', s.p99 > 16.7 && near(s.p95, 16.7), s);
ok('summary: fps = 1000 / mean', near(s.fps, 1000 / s.mean));
const sh = M.summarize([16, 16, 5000, 0, -3, 16]);
ok('a hidden tab (5 s gap), zeros and negatives are not frames', sh.n === 3 && sh.max === 16, sh);
ok('no frames → n 0', M.summarize([]).n === 0);

// trimmed mean
ok('trimmed mean drops the slowest tenth', near(M.trimmedMean([10, 10, 10, 10, 10, 10, 10, 10, 10, 500], 0.1), 10));
ok('trimmed mean of one value', M.trimmedMean([12], 0.1) === 12);
ok('trimmed mean ignores junk', near(M.trimmedMean([0, -1, 20, 20], 0), 20));
ok('trimmed mean of nothing is NaN', isNaN(M.trimmedMean([])));

// fps gain
ok('50 ms → 25 ms is +20 fps', near(M.fpsGain(50, 25), 20));
ok('no change is 0', M.fpsGain(30, 30) === 0);
ok('estimate: saving 10 of 40 ms', near(M.estGainFps(40, 10), 1000 / 30 - 25));
ok('estimate: nothing saved / nonsense → 0', M.estGainFps(40, 0) === 0 && M.estGainFps(0, 5) === 0);
ok('estimate: cannot save more than the frame', isFinite(M.estGainFps(10, 50)));

// ranking
const r = M.rank([
  { id: 'b', gainFps: 5, measured: false }, { id: 'a', gainFps: 5, measured: true }, { id: 'c', gainFps: 12, measured: false },
  { id: 'd', gainFps: 0.2, measured: true }, null, { id: 'e', gainFps: 0.5, measured: true },
]);
ok('ranked by gain, measured before estimated at a tie', r.map(x => x.id).join('') === 'cabe', r.map(x => x.id));
ok('under the minimum is left out; the minimum can change', !r.some(x => x.id === 'd') && M.rank([{ id: 'd', gainFps: 0.2 }], 0.1).length === 1);
ok('ties of everything fall back to the id (stable)', M.rank([{ id: 'z', gainFps: 3, measured: true }, { id: 'y', gainFps: 3, measured: true }]).map(x => x.id).join('') === 'yz');

// the pill
const cfg = { lowFps: 20, lowMs: 10000, warmupMs: 15000 };
const ctx = (o) => Object.assign({ hidden: false, loading: false, sinceLoadMs: 60000 }, o);
let st = { lowSince: null, fired: false }, fired = [];
for (let t = 0; t <= 12000; t += 1000) if (M.pillStep(st, t, 8, ctx(), cfg)) fired.push(t);
ok('fires once, after 10 s under 20 fps', fired.join() === '10000', fired);
ok('and never again', !M.pillStep(st, 20000, 5, ctx(), cfg) && !M.pillStep(st, 40000, 5, ctx(), cfg));
st = { lowSince: null, fired: false };
for (let t = 0; t < 9000; t += 1000) M.pillStep(st, t, 8, ctx(), cfg);
ok('one good second starts the count again', !M.pillStep(st, 9000, 40, ctx(), cfg) && st.lowSince === null);
ok('…so 10 s from then', !M.pillStep(st, 10000, 8, ctx(), cfg) && !M.pillStep(st, 19000, 8, ctx(), cfg) && M.pillStep(st, 20000, 8, ctx(), cfg));
st = { lowSince: null, fired: false };
ok('a hidden tab resets and does not fire', !M.pillStep(st, 0, 5, ctx(), cfg) && !M.pillStep(st, 20000, 5, ctx({ hidden: true }), cfg) && st.lowSince === null);
st = { lowSince: null, fired: false };
let any = false; for (let t = 0; t <= 30000; t += 1000) any = M.pillStep(st, t, 5, ctx({ loading: true }), cfg) || any;
ok('a project loading holds it back', !any && st.lowSince === null);
st = { lowSince: null, fired: false }; any = false;
for (let t = 0; t <= 14000; t += 1000) any = M.pillStep(st, t, 5, ctx({ sinceLoadMs: t }), cfg) || any;
ok('not in the first 15 s after load', !any);
st = { lowSince: null, fired: false };
ok('an unknown fps (NaN) counts as nothing', !M.pillStep(st, 0, NaN, ctx(), cfg) && st.lowSince === null);

// categories
const avg = { own: 1, cesium: 10, minimap: 0.5, potreeUpdate: 2, potreeRender: 3, incidence: 0.2, compass: 0.3, labels: 1.5, measure: 0, entities: 3, globe: 4, imagery: 1 };
const c = M.categories(avg, 60, {});
const row = id => c.rows.find(x => x.id === id).ms;
ok('categories in stacking order', c.rows.map(x => x.id).join() === 'cloud,terrain,layers,features,own,gpu');
ok('point clouds = update + render', near(row('cloud'), 5));
ok('map layers = the imagery part of the globe', near(row('layers'), 1));
ok('terrain = globe minus imagery, plus the rest of the scene', near(row('terrain'), 3 + (10 - 3 - 3 - 1)), row('terrain'));
ok('features = entities + labels', near(row('features'), 4.5));
ok("FLEX's own = own + minimap + incidence + compass + measure", near(row('own'), 1 + 0.5 + 0.2 + 0.3));
ok('slow frame: GPU estimate = frame − CPU, nothing idle', near(row('gpu'), 60 - c.cpu) && c.idle === 0 && !c.gpuMeasured, c);
const f = M.categories({ cesium: 4, potreeRender: 2, own: 1 }, 16.7, {});
ok('fast frame (held to the refresh): the gap is waiting, not GPU', f.rows.find(x => x.id === 'gpu').ms === 0 && near(f.idle, 16.7 - f.cpu), f);
const g = M.categories(avg, 30, { gpuMs: 12 });
ok('a measured GPU time replaces the estimate and is labelled', g.gpuMeasured && g.rows.find(x => x.id === 'gpu').ms === 12 && /measured/.test(g.rows.find(x => x.id === 'gpu').label));
const z = M.categories({}, 20, {});
ok('empty averages do not break', z.rows.every(x => x.ms >= 0 || x.id === 'gpu') && isFinite(z.cpu));
const big = M.categories({ cesium: 2, entities: 9, globe: 9, imagery: 9 }, 30, {});
ok('sub-timers larger than the stage never make a negative bar', big.rows.every(x => x.ms >= 0), big.rows);

// formatting
ok('fmtMs', M.fmtMs(3.14159) === '3.1 ms' && M.fmtMs(42.4) === '42 ms' && M.fmtMs(NaN) === '–');
ok('fmtCount', M.fmtCount(950) === '950' && M.fmtCount(1500) === '1.5 k' && M.fmtCount(25000) === '25 k' && M.fmtCount(3200000) === '3.2 M' && M.fmtCount(10000000) === '10 M');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
