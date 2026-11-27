// "From you" on the viewer's cards (viewer_build/libs/from-you.js): the distance and the bearing from the GPS position.
// The sums, and the rows on a stand-in page.   node tools/test_from_you.js
'use strict';
const path = require('path');
const FY = require(path.join(__dirname, '..', 'viewer_build', 'libs', 'from-you.js'));
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); if (extra !== undefined) console.log('  ' + JSON.stringify(extra)); } }
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const FT = 0.3048;
// the viewer's own length formatter, in feet and in metres
const ft = m => { const f = m / FT; return f < 10 ? f.toFixed(1) + ' ft' : f < 10000 ? Math.round(f).toLocaleString('en-US') + ' ft' : (m / 1609.344).toFixed(2) + ' mi'; };
const mt = m => (m < 10 ? m.toFixed(1) + ' m' : m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km');

// ── the sums ──
ok('bearings on the grid: north 0, east 90, south 180, west 270', near(FY.bearing(0, 5), 0) && near(FY.bearing(5, 0), 90) && near(FY.bearing(0, -5), 180) && near(FY.bearing(-5, 0), 270) && near(FY.bearing(1, 1), 45));
ok('true north: the grid bearing turned by the convergence, kept in 0..360', near(FY.bearing(0, 5, 1.5), 1.5) && near(FY.bearing(0, 5, -2), 358) && near(FY.bearing(-5, 0, 100), 10) && near(FY.bearing(5, 0, NaN), 90));
ok('eight points of the compass', [0, 22, 23, 52, 90, 135, 180, 225, 270, 315, 337, 338, 359.9, 360, -45].map(FY.point).join() === 'N,N,NE,NE,E,SE,S,SW,W,NW,NW,N,N,N,NW');
let m = FY.measure({ x: 0, y: 0 }, { x: 98.5, y: 77 });
ok('distance is horizontal, in map metres; the bearing a whole number', near(m.d, Math.hypot(98.5, 77)) && m.deg === 52 && m.point === 'NE', m);
m = FY.measure({ x: 10, y: 10, z: 900 }, { x: 10, y: -90, z: 100 });
ok('heights play no part', near(m.d, 100) && m.deg === 180 && m.point === 'S');
ok('359.6 degrees is written 0, never 360', FY.measure({ x: 0, y: 0 }, { x: -0.7, y: 100 }).deg === 0 && FY.measure({ x: 0, y: 0 }, { x: -0.7, y: 100 }).point === 'N');
ok('no fix, or no place: nothing', FY.measure(null, { x: 1, y: 2 }) === null && FY.measure({ x: 1, y: 2 }, null) === null && FY.measure({ x: NaN, y: 2 }, { x: 1, y: 2 }) === null && FY.measure({ x: 1, y: 2 }, { x: 1 }) === null && FY.text(null, { x: 1, y: 2 }, ft) === null);
ok('the text: "410 ft · NE 52°"', FY.text({ x: 0, y: 0 }, { x: 98.5, y: 77 }, ft) === '410 ft · NE 52°', FY.text({ x: 0, y: 0 }, { x: 98.5, y: 77 }, ft));
ok('…in metres, and far away in miles / kilometres (the formatter’s own)', FY.text({ x: 0, y: 0 }, { x: 98.5, y: 77 }, mt) === '125 m · NE 52°' && FY.text({ x: 0, y: 0 }, { x: -5000, y: 0 }, ft) === '3.11 mi · W 270°' && FY.text({ x: 0, y: 0 }, { x: -5000, y: 0 }, mt) === '5.00 km · W 270°');
ok('…with the map’s convergence the bearing is from true north', FY.text({ x: 0, y: 0 }, { x: 98.5, y: 77 }, ft, 1.6) === '410 ft · NE 54°' && FY.text({ x: 0, y: 0 }, { x: 0, y: 50 }, mt, -1.2) === '50 m · N 359°');
ok('…no formatter: plain metres', FY.text({ x: 0, y: 0 }, { x: 0, y: -42 }) === '42 m · S 180°');
ok('standing on it (under half a metre): the distance alone, no direction', FY.text({ x: 0, y: 0 }, { x: 0.2, y: 0.1 }, ft) === '0.7 ft' && FY.HERE_M === 0.5);

// ── the rows on a page ──
const mkEl = () => { const e = { attrs: {}, style: {}, textContent: '', val: null, getAttribute: k => (k in e.attrs ? e.attrs[k] : null), setAttribute: (k, v) => { e.attrs[k] = String(v); }, querySelector: q => (q === '.fy-val' ? e.val : null) }; return e; };
const doc = { els: [], querySelectorAll(q) { return q === '[data-fy]' ? this.els.filter(e => 'data-fy' in e.attrs) : []; } };
let fix = null, unit = ft, conv = 0;
ok('not set up: no text, a row stays hidden', FY.active() === false && FY.now(1, 2) === null && FY.rowHtml(1, 2).includes('display:none'));
FY.init({ fix: () => fix, fmtLen: m2 => unit(m2), conv: () => conv });
const row = mkEl(); row.val = mkEl(); doc.els.push(row);
ok('no fix: the row is made but hidden, with no text', FY.active() && FY.mark(row, 98.5, 77, 'contents') === null && row.style.display === 'none' && row.val.textContent === '' && row.attrs['data-fy'] === '98.5,77');
ok('…and the HTML row for the info card is hidden too', /^<div class="fx-row fy-row" data-fy="98.5,77" style="display:none"><span class="lbl">From you:<\/span> <span class="val fy-val"><\/span><\/div>$/.test(FY.rowHtml(98.5, 77)), FY.rowHtml(98.5, 77));
fix = { x: 0, y: 0, z: 300 };
ok('a fix arrives: update() writes every row on the page and shows it', FY.update(doc) === 1 && row.val.textContent === '410 ft · NE 52°' && row.style.display === 'contents');
ok('…a row made now has its text at once', FY.rowHtml(98.5, 77) === '<div class="fx-row fy-row" data-fy="98.5,77"><span class="lbl">From you:</span> <span class="val fy-val">410 ft · NE 52°</span></div>', FY.rowHtml(98.5, 77));
fix = { x: 98.5, y: 0, z: 300 };
ok('the next fix: the row follows', FY.update(doc) === 1 && row.val.textContent === '253 ft · N 0°', row.val.textContent);
unit = mt; conv = 2;
ok('other units, and the convergence of the map: written again by update()', FY.update(doc) === 1 && row.val.textContent === '77 m · N 2°', row.val.textContent);
const bare = mkEl(); doc.els.push(bare); FY.mark(bare, 98.5, -100);
ok('a row with no value child takes the text itself; shown with its default display', bare.textContent === '100 m · S 182°' && bare.style.display === '' && FY.update(doc) === 2);
fix = null;
ok('GPS off (no position): every row is emptied and hidden', FY.update(doc) === 0 && row.val.textContent === '' && row.style.display === 'none' && bare.style.display === 'none');
ok('a place that is no number: no row', FY.rowHtml(NaN, 2) === '' && FY.mark(mkEl(), 'a', 2) === null);
FY.init({ fix: () => { throw new Error('no'); }, fmtLen: ft });
ok('a page that cannot say where the GPS is: no text, no error', FY.now(1, 2) === null);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
