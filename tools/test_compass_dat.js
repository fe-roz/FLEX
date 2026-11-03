// Tests of client/src/modules/compass-dat.js: the DAT parser, reduction and PLT
// output (FORMAT variants, backsights, declination, corrections, flags, surveys),
// and the round trip into parsePLT. Made-up cave "Cave Ridge", made-up readings.
//
//   node tools/test_compass_dat.js
'use strict';
const path = require('path');
const mod = path.join(__dirname, '..', 'client', 'src', 'modules');
const { isCompassDat, parseDat, reduceDat, datToPlt } = require(path.join(mod, 'compass-dat.js'));
const { parsePLT } = require(path.join(mod, 'compass-plt.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;
const FT = 0.3048;

const hdr = (name, fmt, { decl = 0, corr = '0.00 0.00 0.00', extra = '', date = '7 10 1994', comment = 'main line', cols = 'FROM TO LENGTH BEARING INC LEFT UP DOWN RIGHT' } = {}) => [
  'Cave Ridge', 'SURVEY NAME: ' + name, `SURVEY DATE: ${date}  COMMENT:${comment}`, 'SURVEY TEAM:', 'A. Caver; B. Caver', ' ',
  `DECLINATION: ${decl.toFixed(2)}  FORMAT: ${fmt}  CORRECTIONS: ${corr} ${extra}`, '', cols, ''].join('\r\n');
const dat = (...blocks) => blocks.join('\r\n\f') + '\r\n\f\x1a';
// Position of a station from the PLT, in metres (e, n, v).
const at = (plt, name) => { const s = parsePLT(plt).stations.find(x => x.name === name); return s ? [s.e, s.n, s.v] : null; };
const close = (p, e, n, v, t = 0.01) => p && near(p[0], e, t) && near(p[1], n, t) && near(p[2], v, t);

// 1. feet, degrees, LRUD order LUDR, no backsights, flags present
(function basic() {
  const d = dat(hdr('A', 'DDDDLUDRLADNF') + [
    'A1 A2 30.00 90.00 0.00 1.0 2.0 3.0 4.0  #|L# first comment',
    'A2 A3 20.00 0.00 90.00 -999 -999 -999 -999  #|# up',
    'A3 A4 10.00 180.00 -30.00 2 2 2 2',
  ].join('\r\n'));
  ok('isCompassDat', isCompassDat(d) && !isCompassDat('Z 0 0 0\nNA D 1 1 1990 Cx'));
  const r = datToPlt(d);
  ok('cave name from the file', r.name === 'Cave Ridge');
  ok('A2: 30 ft east', close(at(r.plt, 'A2'), 30 * FT, 0, 0), at(r.plt, 'A2'));
  ok('A3: 20 ft straight up', close(at(r.plt, 'A3'), 30 * FT, 0, 20 * FT), at(r.plt, 'A3'));
  const hz = 10 * Math.cos(30 * Math.PI / 180) * FT, vz = 20 * FT - 10 * Math.sin(30 * Math.PI / 180) * FT;
  ok('A4: south, down 30 deg', close(at(r.plt, 'A4'), 30 * FT, -hz, vz), at(r.plt, 'A4'));
  const P = parsePLT(r.plt);
  ok('survey name, date and comment', P.surveys[0].code === 'A' && P.surveys[0].desc === 'main line' && P.surveys[0].date === '1994-07-10', P.surveys);
  ok('LRUD at the from station, order L U D R', (() => { const l = P.stations.find(s => s.name === 'A1').lrud; return l && near(l.l, 1 * FT) && near(l.u, 2 * FT) && near(l.d, 3 * FT) && near(l.r, 4 * FT); })());
  ok('comment kept', P.segments[0].points[1].comment === 'first comment', P.segments[0].points[1]);
  ok('stats', r.stats.shots === 3 && r.stats.stations === 4 && r.stats.surveys === 1, r.stats);
})();

// 2. metres, other LRUD and item order (bearing, inclination, length)
(function metric() {
  const d = dat(hdr('M', 'DMMMRDULAdlNN', {}).replace('FORMAT: DMMMRDULAdlNN', 'FORMAT: DMMMRDULADLNN') + 'B1 B2 90 0 10.0 1 2 3 4\r\nB2 B3 90 90 5.0 1 2 3 4');
  const r = datToPlt(d);
  ok('item order A D L, metres', close(at(r.plt, 'B2'), 10, 0, 0, 0.01), at(r.plt, 'B2'));
  ok('B3 straight up 5 m', close(at(r.plt, 'B3'), 10, 0, 5, 0.01), at(r.plt, 'B3'));
  const l = parsePLT(r.plt).stations.find(s => s.name === 'B1').lrud;
  ok('LRUD order R D U L in metres', l && near(l.r, 1) && near(l.d, 2) && near(l.u, 3) && near(l.l, 4), l);
})();

// 3. quads, feet-inches, percent grade
(function units() {
  const d = dat(hdr('Q', 'QIIGLUDRLADNN') + [
    'Q1 Q2 10-6 N45E 100 1-6 2 3 4',
    'Q2 Q3 10.0 S 45 W 0 0 0 0 0',
    'Q3 Q4 10.0 N30W -100 0 0 0 0',
    'Q4 Q5 10.0 S60E 0 0 0 0 0',
  ].join('\r\n'));
  const r = datToPlt(d), p2 = at(r.plt, 'Q2');
  const L = 10.5 * FT, hz = L * Math.cos(Math.PI / 4); // 100% grade is 45 degrees
  ok('quad N45E + feet-inches + percent grade', close(p2, hz * Math.SQRT1_2, hz * Math.SQRT1_2, L * Math.sin(Math.PI / 4)), p2);
  const p3 = at(r.plt, 'Q3'), s = 10 * FT * Math.SQRT1_2;
  ok('quad S 45 W as three tokens', close(p3, p2[0] - s, p2[1] - s, p2[2]), p3);
  const p4 = at(r.plt, 'Q4'), a = 10 * FT * Math.SQRT1_2;
  ok('quad N30W with -100% grade', close(p4, p3[0] - 10 * FT * Math.cos(Math.PI / 4) * 0.5, p3[1] + 10 * FT * Math.cos(Math.PI / 4) * Math.cos(Math.PI / 6), p3[2] - a), p4);
  const p5 = at(r.plt, 'Q5');
  ok('quad S60E', close(p5, p4[0] + 10 * FT * Math.sin(Math.PI / 3), p4[1] - 10 * FT * 0.5, p4[2]), p5);
  const l = parsePLT(r.plt).stations.find(s => s.name === 'Q1').lrud;
  ok('passage feet-inches', l && near(l.l, 1.5 * FT) && near(l.u, 2 * FT), l);
})();

// 4. backsights (azimuth and inclination averaged), declination, corrections
(function backsight() {
  const fmt = 'DDDDLUDRLADadBF';
  const d = dat(hdr('B', fmt, { decl: 5, corr: '1.00 0.50 2.00', extra: 'CORRECTIONS2: 0.00 0.00' }) + [
    'K1 K2 20.00 88.00 10.00 1 1 1 1 270.00 -10.00',   // fore 88+1, back 270-180=90 -> mean 89.5; +5 decl -> 94.5
    'K2 K3 10.00 -999 -999 1 1 1 1 0.00 -20.00',      // back only: az 180, inc 20
  ].join('\r\n'));
  const r = datToPlt(d), p2 = at(r.plt, 'K2');
  const L = 22 * FT, inc = 10.25 * Math.PI / 180, az = (89.5 + 5) * Math.PI / 180;
  ok('backsight mean, corrections, declination', close(p2, L * Math.cos(inc) * Math.sin(az), L * Math.cos(inc) * Math.cos(az), L * Math.sin(inc)), p2);
  const p3 = at(r.plt, 'K3'), L3 = (10 + 2) * FT, i3 = (20 + 0.5) * 0 + 20 * Math.PI / 180;  // back-only: fore corrections do not apply to the back reading
  const az3 = (180 + 5) * Math.PI / 180;
  ok('back reading alone stands in', close(p3, p2[0] + L3 * Math.cos(i3) * Math.sin(az3), p2[1] + L3 * Math.cos(i3) * Math.cos(az3), p2[2] + L3 * Math.sin(i3)), p3);
  // wrap-around mean: 359 and 1 degrees
  const w = datToPlt(dat(hdr('W', fmt) + 'W1 W2 10.00 359.00 0.00 0 0 0 0 181.00 0.00'));
  ok('fore/back mean across north', close(at(w.plt, 'W2'), 0, 10 * FT, 0, 0.005), at(w.plt, 'W2'));
})();

// 5. flags, several surveys, shared stations, loops, unplaced
(function flags() {
  const d = dat(
    hdr('S1', 'DDDDLUDRLADNF') + [
      'A1 A2 10.0 0 0 1 1 1 1 #|P# not plotted',
      'A2 A3 10.0 0 0 1 1 1 1 #|X# dropped',
      'A2 A4 10.0 90 0 1 1 1 1 #|LC# length only',
    ].join('\r\n'),
    hdr('S2', 'DDDDLUDRLADNF', { comment: 'side', date: '8 1 94' }) + [
      'A4 C1 10.0 0 0 1 1 1 1',
      'Z8 Z9 5.0 0 0 1 1 1 1',
    ].join('\r\n'));
  const r = datToPlt(d), P = parsePLT(r.plt);
  ok('two surveys, names kept', P.surveys.map(s => s.code).join() === 'S1,S2', P.surveys);
  ok('2-digit year', P.surveys[1].date === '1994-08-01', P.surveys[1]);
  ok('P flag: shot not drawn', P.segments[0].points.find(p => p.name === 'A2').excluded === true && P.segments[0].points.find(p => p.name === 'A4').excluded === false, P.segments[0].points.map(p => [p.name, p.excluded]));
  ok('X flag: shot left out, station not placed from it', !at(r.plt, 'A3'), at(r.plt, 'A3'));
  ok('L flag: shot still drawn', close(at(r.plt, 'A4'), 10 * FT, 10 * FT, 0), at(r.plt, 'A4'));
  ok('survey 2 continues from a survey 1 station', close(at(r.plt, 'C1'), 10 * FT, 20 * FT, 0), at(r.plt, 'C1'));
  ok('unconnected stations left out and counted', !at(r.plt, 'Z9') && r.stats.unplaced === 2 && r.warnings.length === 1, [r.stats, r.warnings]);
  // a loop: both paths read, the first found places the station
  const L = datToPlt(dat(hdr('L', 'DDDDLUDRLADNF') + 'A1 A2 10 90 0 0 0 0 0\r\nA2 A3 10 0 0 0 0 0 0\r\nA3 A1 10 270 0 0 0 0 0'));
  ok('loop: no throw, all three placed', ['A1', 'A2', 'A3'].every(n => at(L.plt, n)));
  // placement from the far end: a shot written to-first
  const R = datToPlt(dat(hdr('R', 'DDDDLUDRLADNF') + 'A1 A2 10 90 0 0 0 0 0\r\nA3 A2 10 0 0 0 0 0 0'));
  ok('station placed backwards from a shot read to-first', close(at(R.plt, 'A3'), 10 * FT, -10 * FT, 0), at(R.plt, 'A3'));
})();

// 6. no flags column, 11 character format, missing length, depth gauge, odd names
(function misc() {
  const r = datToPlt(dat(hdr('N', 'DDDDLUDRLAD') + 'A1 A2 10 90 0 1 1 1 1 #|X# looks like a comment here\r\nA2 A3 -999 0 0 1 1 1 1'));
  ok('11-character format: no flags column', close(at(r.plt, 'A2'), 10 * FT, 0, 0) && r.plt.includes('#|X#'), r.plt);
  ok('shot without length skipped and counted', !at(r.plt, 'A3') && r.warnings.some(w => /without a length/.test(w)), r.warnings);
  const w = datToPlt(dat(hdr('D', 'DDDWLUDRLADNN') + 'G1 G2 10 0 5 1 1 1 1\r\nG2 G3 10 0 12 1 1 1 1'));
  ok('depth gauge: depth from the readings', close(at(w.plt, 'G3'), 0, Math.sqrt(100 - 25) * FT + Math.sqrt(100 - 49) * FT, -12 * FT, 0.01), at(w.plt, 'G3'));
  const n = datToPlt(dat(hdr('Name With Space', 'DDDDLUDRLADNN') + 'E1 E2 10 0 0 0 0 0 0'));
  ok('survey name with spaces stays one token', parsePLT(n.plt).surveys[0].code === 'Name_With_Space');
  let threw = false; try { datToPlt('nothing here'); } catch (e) { threw = true; }
  ok('not a DAT: an error', threw);
})();

// 7. LF endings, trailing blank lines, a fixed starting station
(function misc2() {
  const d = dat(hdr('F', 'DDDDLUDRLADNF') + 'A1 A2 10 90 0 1 1 1 1\nA2 A3 10 90 0 1 1 1 1\n\n').replace(/\r\n/g, '\n');
  const P = parseDat(d);
  ok('parseDat: one survey, two shots', P.surveys.length === 1 && P.surveys[0].shots.length === 2, P.surveys.length);
  const red = reduceDat(P, { from: 'A3' });
  const a1 = red.pos.get('A1'), a3 = red.pos.get('A3');
  ok('origin on a chosen station', a3.every(x => x === 0) && near(a1[0], -20 * FT, 1e-9), [a1, a3]);
})();

console.log(`compass-dat: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
