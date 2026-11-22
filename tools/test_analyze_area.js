// analyze-area.js, the pure parts: the tool rows from a /api/areas/check answer (chips, reasons, offers, ticks), offers turned
// into options, the Ground row, the run bar's plan text, the one switch state (reducer, eyes, one vegetation set at a time).
// Run: node tools/test_analyze_area.js
'use strict';
const path = require('path');
const M = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'analyze-area.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + JSON.stringify(i) : '')); } };

const check = { ok: true, km2: 30.9, ground: { coverage: 0.78, minutes: 3 },
  tools: { terrain: { status: 'partly', why: 'LiDAR covers 78 % of this area.', offers: [], minutes: 2 },
    veg: { status: 'toobig', why: '25 km² at most: this is 30.9.', offers: [{ key: 'detail=low', label: 'Rough detail' }], minutes: 3 },
    bush: { status: 'needslidar', why: 'No point cloud ticked.', offers: [], minutes: 2 } } };

// rows
let rows = M.toolRows(check, { ticks: { terrain: true, veg: true, bush: true } });
const by = k => rows.find(r => r.id === k);
ok('three tool rows in order', rows.map(r => r.id).join() === 'terrain,veg,bush,prospect');
ok('partly → warn chip "Partly covered" with the reason', by('terrain').st === 'warn' && by('terrain').chip === 'Partly covered' && /78 %/.test(by('terrain').why));
ok('toobig → bad chip "Too big", offers listed, not ticked, still clickable', by('veg').chip === 'Too big' && by('veg').offers.length === 1 && !by('veg').ticked && !by('veg').disabled);
ok('needslidar → "Needs LiDAR", no offers, disabled', by('bush').chip === 'Needs LiDAR' && !by('bush').offers && by('bush').disabled && !by('bush').ticked);
ok('fits → "Fits"', M.toolRows({ tools: { terrain: { status: 'fits', why: '' } } }, {})[0].chip === 'Fits');
ok('no answer yet → "Checking…", disabled', M.toolRows(null, {}).every(r => r.chip === 'Checking…' && r.disabled));
const area = { id: 'a1', results: { ground: { date: '2026-11-14T10:00:00Z' }, terrain: { date: '2026-11-14T10:00:00Z' } } };
ok('a made result says when and that it is replaced', /^Already made 14 Nov; running again replaces it/.test(M.toolRows(check, { area })[0].why), M.toolRows(check, { area })[0].why);

// offers
ok('offerOptions: name=value with a number', JSON.stringify(M.offerOptions({ key: 'cell=2' })) === '{"cell":2}');
ok('offerOptions: name:value', JSON.stringify(M.offerOptions({ key: 'detail:low' })) === '{"detail":"low"}');
ok('offerOptions: explicit options win', JSON.stringify(M.offerOptions({ key: 'x', options: { tiles: true } })) === '{"tiles":true}');
ok('offerOptions: a plain key is a flag', JSON.stringify(M.offerOptions({ key: 'tiles' })) === '{"tiles":true}');
ok('optionsOf: per tool', JSON.stringify(M.optionsOf({ veg: { key: 'detail=low' }, terrain: { key: 'cell=2' } })) === '{"veg":{"detail":"low"},"terrain":{"cell":2}}');
// the answer after the offer is applied: fits, with the note and the way back
const after = { ok: true, ground: { minutes: 3 }, tools: { veg: { status: 'fits', why: '30.9 km².', minutes: 1.5 } } };
const vr = M.toolRows(after, { ticks: { veg: true }, fix: { veg: { key: 'detail=low', label: 'Rough detail' } } }).find(r => r.id === 'veg');
ok('applied offer: Fits, ticked, the note says what is used', vr.chip === 'Fits' && vr.ticked && vr.used && /Using: Rough detail\./.test(vr.why), vr);

// ground
ok('ground: first step with minutes', M.groundRow(check, null).chip === 'First step' && /about 3 min/.test(M.groundRow(check, null).why));
ok('ground: made', M.groundRow(check, area).chip === 'Made' && /Made 14 Nov/.test(M.groundRow(check, area).why));
ok('ground: needs LiDAR', M.groundRow({ ground: { status: 'needslidar' } }, null).chip === 'Needs LiDAR');

// plan
let p = M.plan(rows, check, null);
ok('plan: only runnable ticks count (terrain), ground added', p.tools.join() === 'terrain' && p.minutes === 5 && p.text === '1 ticked · about 5 min', p);
p = M.plan(M.toolRows(check, { ticks: { terrain: true } , area }), check, area);
ok('plan: ground already made is not counted', p.minutes === 2 && p.text === '1 ticked · about 2 min', p);
ok('plan: nothing ticked', M.plan(M.toolRows(check, {}), check, null).text === 'Tick at least one tool.');
ok('minTxt rounds, under 1.5 says about 1 min', M.minTxt(1) === 'about 1 min' && M.minTxt(4.6) === 'about 5 min');

// switch state
let s = { areas: {} };
s = M.reduce(s, { type: 'show', id: 'a', on: true });
ok('show: area on, results on by default', M.eyeOf(s, 'a') === 'on' && M.eyeOf(s, 'a', 'veg') === 'on');
s = M.reduce(s, { type: 'showResult', id: 'a', result: 'terrain', on: false });
ok('a result off while the area is on = half', M.eyeOf(s, 'a', 'terrain') === 'half');
s = M.reduce(s, { type: 'show', id: 'b', on: true, has: ['ground', 'veg'] });
ok('showing another area with vegetation hides the first one\'s (one set drawn)', M.eyeOf(s, 'a', 'veg') === 'half' && M.eyeOf(s, 'b', 'veg') === 'on');
s = M.reduce(s, { type: 'showResult', id: 'a', result: 'veg', on: true });
ok('switching a vegetation result on hides the other one', M.eyeOf(s, 'a', 'veg') === 'on' && M.eyeOf(s, 'b', 'veg') === 'half');
s = M.reduce(s, { type: 'show', id: 'a', on: false });
ok('area off: its switch and its results are off (not loaded)', M.eyeOf(s, 'a') === '' && M.eyeOf(s, 'a', 'veg') === '');
ok('…its per-result choice is remembered', s.areas.a.res.terrain === false);
const s2 = M.reduce(s, { type: 'showResult', id: 'a', result: 'bush', on: true });
ok('switching a result on loads its area', M.eyeOf(s2, 'a') === 'on' && M.eyeOf(s2, 'a', 'bush') === 'on');
ok('the reducer does not change the old state', M.eyeOf(s, 'a') === '');
ok('forget removes an area', !M.reduce(s, { type: 'forget', id: 'b' }).areas.b);
const areas = [{ id: 'a', results: { ground: {}, terrain: {}, bush: {} } }, { id: 'b', results: { ground: {}, veg: {} } }];
ok('drawnOf: what is drawn, only existing results', JSON.stringify(M.drawnOf(s2, areas)) === JSON.stringify([{ id: 'a', result: 'bush' }]) && JSON.stringify(M.drawnOf(M.reduce(s2, { type: 'showResult', id: 'b', result: 'veg', on: true }), areas)) === JSON.stringify([{ id: 'a', result: 'bush' }, { id: 'b', result: 'veg' }]), M.drawnOf(s2, areas));
ok('missing: tools an area has not got', M.missing(areas[1]).join() === 'terrain,bush,prospect');

// words
ok('sizeKm', (() => { const [w, h] = M.sizeKm([[-100.5678, 45.1234], [-100.5378, 45.1234], [-100.5378, 45.1434]]); return Math.abs(w - 2.36) < 0.05 && Math.abs(h - 2.21) < 0.05; })());
ok('shortDate', M.shortDate('2026-11-22T08:00:00Z') === '22 Nov');
ok('fmtMB', M.fmtMB(189e6) === '189 MB' && M.fmtMB(5.2e6) === '5.2 MB' && M.fmtMB(12000) === '12 KB');

console.log(`test_analyze_area: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
