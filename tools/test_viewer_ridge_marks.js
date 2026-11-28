// Test for the viewer's marks on ridgewalking features (viewer_build/libs/ridge-marks.js) and the dimming hook of
// libs/ridgewalk.js, without a browser. The rules (which marks show, which feature a mark speaks for, the record a
// button makes, a tap's target, the card's wording) are plain functions; the page half runs in a context with the
// real three.js r128 and flexlib.js and a stand-in document: badges per kind, a lone mark at its own place, the
// switches, "nothing" dimmed and hidden, the record written through the viewer's own ffRecord stand-in, the project
// asked for when the map has none. The card itself is checked in the kit (test_viewer_marks). Synthetic numbers only.
//
//   node tools/test_viewer_ridge_marks.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const FL = require(path.join(root, 'viewer_build', 'libs', 'flexlib.js'));
const RM = require(path.join(root, 'viewer_build', 'libs', 'ridge-marks.js'));
let fail = 0, pass = 0;
function ok(label, cond, info) {
  if (cond) { pass++; return; }
  fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 500) : ''));
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const LAT = 45.1234, LON = -100.5678, MX = 111195 * Math.cos(LAT * Math.PI / 180), MY = 111195;
const ll = (x, y) => ({ lon: +(LON + x / MX).toFixed(7), lat: +(LAT + y / MY).toFixed(7) });
// the export's list, in the scene (metres from the terrain's centre): a pit, a long crack, a guessed opening, a small one deep in a cliff
const LIST = [
  Object.assign({ id: 'r10-20', x: 10, y: 20, z: 500, n: 120, deepest: 9.9, box: [8, 18, 490, 12, 22, 500], entrance: 'true' }, ll(10, 20)),
  Object.assign({ id: 'r30-5', x: 60, y: 10, z: 505, n: 300, deepest: 6.2, box: [59, -20, 498, 61, 11, 505], entrance: 'true' }, ll(60, 10)),
  Object.assign({ id: 'r50-9', x: 100, y: 18, z: 498, n: 9, deepest: 2.1, box: [99.5, 17.5, 496, 100.5, 18.5, 498], entrance: 'guessed' }, ll(100, 18)),
  Object.assign({ id: 'r70-1', x: 140, y: 2, z: 470, n: 4, deepest: 1.2, box: [139.8, 1.8, 469, 140.2, 2.2, 470], entrance: 'weird' }, ll(140, 2)),
];
const dev = (d, who) => { let seq = 0; return (body, t) => Object.assign({ id: d + '.' + (++seq), dev: d, seq, t: t || new Date(Date.UTC(2026, 10, 20, 10, 0, seq)).toISOString(), who }, body); };

// ── 1. The rules ──────────────────────────────────────────────────────────────
ok('depths read in feet and metres, both', RM.both(9.9) === '32 ft (9.9 m)' && RM.both(2.1) === '6.9 ft (2.1 m)' && RM.both(30.48) === '100 ft (30 m)' && RM.both(null) === '—');
const F = RM.cleanFeatures(LIST.concat([null, { id: 'bad', x: 'a' }, { x: 1, y: 2, z: 3 }, Object.assign({}, LIST[0])]));
ok('the list is read: bad entries dropped, a missing id made, a repeated id told apart, an unknown entrance = none', F.length === 6 && F[3].entrance === 'none' && F[4].id === 'i6' && F[4].lon === null && F[5].id === 'r10-20\'' && F[4].box.join() === '1,2,3,1,2,3', F.map(f => f.id));
ok('not a list: no features', RM.cleanFeatures(null).length === 0 && RM.cleanFeatures('x').length === 0);
const feats = RM.cleanFeatures(LIST);
ok('what a mark keeps of a feature: id, depth, returns, entrance, size', JSON.stringify(RM.featHint(feats[0])) === JSON.stringify({ id: 'r10-20', depth: 9.9, returns: 120, entrance: 'true', size: [4, 4, 10] }));
ok('the card’s lines: depth, returns, size (long by narrow)', JSON.stringify(RM.featureRows(feats[1])) === JSON.stringify([['Depth', '20 ft (6.2 m)'], ['Returns', '300'], ['Size', '102 ft (31 m) × 6.6 ft (2.0 m)']]), RM.featureRows(feats[1]));
// a new mark
let b = RM.markBody(feats[0], null, { kind: 'pit', note: 'needs 12 m of rope' });
ok('a button on an unmarked feature: a new rmark.set at the feature’s anchor, with what is known of it', b.op === 'rmark.set' && b.kind === 'pit' && b.note === 'needs 12 m of rope' && near(b.lon, feats[0].lon, 1e-7) && near(b.lat, feats[0].lat, 1e-7) && b.h === 500 && b.feat.id === 'r10-20' && b.feat.depth === 9.9 && b.prev === null && b.mark);
ok('no kind, or a feature with no place on the map: no record', RM.markBody(feats[0], null, { note: 'x' }) === null && RM.markBody(Object.assign({}, feats[0], { lon: null }), null, { kind: 'pit' }) === null);
const A = dev('phoneA', 'Ana'), B = dev('phoneB', 'Bo');
const e1 = A((({ op, ...r }) => Object.assign({ op }, r))(b));
let P = FL.replayProject([e1], 'p1');
let marks = RM.effective(P, []);
let M = RM.match(marks, feats);
ok('the mark speaks for its feature', marks.length === 1 && M.byFeature['r10-20'].mark.kind === 'pit' && M.alone.length === 0);
b = RM.markBody(feats[0], marks[0], { kind: 'cave', note: 'needs 12 m of rope' });
ok('another button: a change of that mark (same id), only the kind', b.mark === e1.mark && b.kind === 'cave' && !('note' in b) && !('lon' in b) && b.prev.kind === 'pit');
ok('the same button again: nothing to record', RM.markBody(feats[0], marks[0], { kind: 'pit', note: 'needs 12 m of rope' }) === null);
ok('Save note: only the note; Remove: removed', RM.markBody(feats[0], marks[0], { note: 'bolted' }).note === 'bolted' && RM.markBody(feats[0], marks[0], { removed: true }).removed === true);
// marks the export brought
const exp = [{ id: 'x1', kind: 'nothing', note: 'a dip', lon: feats[2].lon, lat: feats[2].lat, h: 498, who: 'Cy', t: '2026-11-01T08:00:00.000Z', feat: { id: 'old', depth: 2 } },
             { id: e1.mark, kind: 'unreached', lon: feats[0].lon, lat: feats[0].lat, who: 'Cy', t: '2026-10-01T08:00:00.000Z' },
             { id: 'x2', kind: 'cave', lon: LON + 0.01, lat: LAT, who: 'Cy', t: '2026-11-02T08:00:00.000Z' }, { id: 'junk' }];
marks = RM.effective(P, exp); M = RM.match(marks, feats);
ok('the export’s marks show too; the library’s wins for the same mark; a mark with no feature near is alone', marks.length === 3 && M.byFeature['r10-20'].mark.kind === 'pit' && M.byFeature['r50-9'].mark.kind === 'nothing' && M.byFeature['r50-9'].mark.exported === true && M.alone.length === 1 && M.alone[0].id === 'x2');
ok('with no project on the phone the export’s marks are all there is', RM.effective(null, exp).length === 3 && RM.effective(null, null).length === 0);
b = RM.markBody(feats[2], M.byFeature['r50-9'].mark, { kind: 'cave' });
ok('changing a mark that came in the export takes it into the library whole, under its own id (every phone makes the same mark)', b.mark === 'x1' && b.kind === 'cave' && b.note === 'a dip' && near(b.lon, feats[2].lon, 1e-7) && b.prev === null && b.feat.id === 'r50-9');
ok('…the same kind and note again: nothing; removing it: taken in as removed', RM.markBody(feats[2], M.byFeature['r50-9'].mark, { kind: 'nothing' }) === null && (() => { const r = RM.markBody(feats[2], M.byFeature['r50-9'].mark, { removed: true }); return r.mark === 'x1' && r.removed === true && r.kind === 'nothing'; })());
const P2 = FL.replayProject([e1, B((({ op, ...r }) => Object.assign({ op }, r))(RM.markBody(feats[2], M.byFeature['r50-9'].mark, { removed: true })))], 'p1');
ok('…and once removed in the library it does not come back from the export', RM.effective(P2, exp).every(m => m.id !== 'x1'));
ok('the boxes to dim: the features a "nothing" mark speaks for, a little wider', JSON.stringify(RM.nothingBoxes(feats, M)) === JSON.stringify([[99.1, 17.1, 495.6, 100.9, 18.9, 498.4]]), RM.nothingBoxes(feats, M));
// a tap
const shown = [{ pts: [[100, 100], [100, 140], [100, 180]], rect: [80, 90, 120, 190] }, { pts: [[300, 100], [300, 110], null], rect: null }, null, { pts: [[108, 96], null, null], rect: null }];
ok('a tap goes to the nearest of a feature’s anchor, middle and deepest point within 28 px', RM.TAP_PX === 28 && RM.nearestTap(102, 138, shown).i === 0 && RM.nearestTap(306, 104, shown).i === 1 && RM.nearestTap(107, 97, shown).i === 3 && near(RM.nearestTap(100, 100, shown).d, 0));
ok('anywhere over a large feature counts (inside its box on the screen), a near point of another feature first', RM.nearestTap(84, 160, shown).i === 0 && RM.nearestTap(118, 92, shown).i === 3 && RM.nearestTap(84, 160, shown).d < RM.TAP_PX);
ok('away from everything: no feature', RM.nearestTap(500, 400, shown) === null && RM.nearestTap(300, 150, shown) === null && RM.nearestTap(10, 10, []) === null);
// wording
ok('the change log’s wording', RM.describe({ op: 'rmark.set', kind: 'pit', note: 'rope', prev: null }) === 'Ridgewalking feature marked: Pit — “rope”' && RM.describe({ kind: 'unreached', prev: { kind: 'pit' } }) === 'Ridgewalking mark changed to Not reached' &&
  RM.describe({ note: 'x', prev: { note: '' } }).startsWith('Ridgewalking mark note changed') && RM.describe({ removed: true }) === 'Mark on a ridgewalking feature removed');
ok('undo is flexlib’s', JSON.stringify(RM.inverse(e1)) === JSON.stringify(FL.rmarkUndo(e1)) && RM.inverse(e1).removed === true);
ok('saved choices: this version only', RM.restore({ v: 1, marks: false, hideNothing: true }).marks === false && RM.restore({ marks: false }).marks === true && RM.restore(null).hideNothing === false);

// ── 1b. The two depth sliders: which features get a ring, which go grey ───────
{
  const ids = l => l.map(f => f.id).join();
  ok('a feature’s depth in feet is the number its card shows (one decimal under 10 ft, whole feet from there)', RM.depthFt(feats[0]) === 32 && RM.depthFt(feats[1]) === 20 && RM.depthFt(feats[2]) === 6.9 && RM.depthFt(feats[3]) === 3.9 && RM.DEPTH_MAX_FT === 60);
  const none = { byFeature: {} };
  let d = RM.depthSplit(feats, none, 0, 0);
  ok('both sliders at 0: off, no ring, nothing grey', d.ring.length === 0 && d.grey.length === 0);
  d = RM.depthSplit(feats, none, 20, 0);
  ok('"Highlight deeper than" 20 ft: a ring for the features 20 ft deep and more (the one at exactly 20 too)', ids(d.ring) === 'r10-20,r30-5' && d.grey.length === 0, ids(d.ring));
  d = RM.depthSplit(feats, none, 21, 0);
  ok('…21 ft: only the deeper one', ids(d.ring) === 'r10-20');
  d = RM.depthSplit(feats, none, 0, 10);
  ok('"Grey out shallower than" 10 ft: the features less deep than that, no ring', ids(d.grey) === 'r50-9,r70-1' && d.ring.length === 0, ids(d.grey));
  d = RM.depthSplit(feats, none, 0, 20);
  ok('…a feature exactly as deep as the limit is not shallower: it keeps its colours', ids(d.grey) === 'r50-9,r70-1');
  d = RM.depthSplit(feats, none, 20, 10);
  ok('between the two limits: neither', ids(d.ring) === 'r10-20,r30-5' && ids(d.grey) === 'r50-9,r70-1' && RM.depthSplit(feats, none, 30, 5).ring.length === 1 && ids(RM.depthSplit(feats, none, 30, 5).grey) === 'r70-1');
  d = RM.depthSplit(feats, none, 5, 25);
  ok('grey above highlight (the ranges overlap): the ring wins, a feature with a ring is not greyed', ids(d.ring) === 'r10-20,r30-5,r50-9' && ids(d.grey) === 'r70-1', [ids(d.ring), ids(d.grey)]);
  d = RM.depthSplit(feats, M, 5, 25);            // M: r50-9 is marked "nothing", r10-20 a pit
  ok('a feature marked "nothing" never gets a ring, however deep; it is greyed', ids(d.ring) === 'r10-20,r30-5' && ids(d.grey) === 'r50-9,r70-1' && ids(RM.depthSplit(feats, M, 1, 0).ring) === 'r10-20,r30-5,r70-1', [ids(d.ring), ids(d.grey)]);
  ok('the ring stands over the middle of the feature’s box, at its top', RM.ringAt(feats[1]).join() === '60,-4.5,505' && RM.ringAt(feats[0]).join() === '10,20,500');
  ok('the slider’s label in the map’s unit; 0 is "off"', RM.depthLabel(30, 'ft') === '30 ft' && RM.depthLabel(30, 'm') === '9.1 m' && RM.depthLabel(0, 'ft') === 'off' && RM.depthLabel(0, 'm') === 'off');
  ok('saved sliders: whole feet 0..60, anything else is off; an older saved state has none: off', RM.restore({ v: 1, hi: 25, grey: 8 }).hi === 25 && RM.restore({ v: 1, hi: 25, grey: 8 }).grey === 8 && RM.restore({ v: 1, hi: 200, grey: -3 }).hi === 60 && RM.restore({ v: 1, hi: 200, grey: -3 }).grey === 0 &&
    RM.restore({ v: 1, hi: '30', grey: NaN }).hi === 0 && RM.restore({ v: 1, hi: '30', grey: NaN }).grey === 0 && RM.restore({ v: 1, marks: false }).hi === 0 && RM.restore(null).grey === 0 && RM.restore({ v: 1, hi: 12.4 }).hi === 12 && RM.DEFAULTS.hi === 0 && RM.DEFAULTS.grey === 0);
}

// ── 1c. Position, and the marked features as KML pins ─────────────────────────
{
  ok('a position reads latitude first, 5 decimals; nothing without a place', RM.posText(45.1234, -100.5678) === '45.12340, -100.56780' && RM.posText(45.123456789, -100.567891) === '45.12346, -100.56789' && RM.posText(-0.000004, 7) === '-0.00000, 7.00000' && RM.posText(null, 3) === '' && RM.posText(1, undefined) === '');
  ok('a depth in the map’s one unit', RM.depthIn(6.7, 'ft') === '22 ft' && RM.depthIn(6.7, 'm') === '6.7 m' && RM.depthIn(2.1, 'ft') === '6.9 ft' && RM.depthIn(30.48, 'm') === '30 m' && RM.depthIn(null, 'ft') === '' && RM.depthIn(0, 'ft') === '0.0 ft');
  ok('KML colours are aabbggrr', RM.kmlColour('#43c463') === 'ff63c443' && RM.kmlColour('#3D8BFF') === 'ffff8b3d' && RM.kmlColour('nope') === 'ffffffff');
  ok('text for XML: & < > and quotes escaped, forbidden control characters dropped, a CDATA end harmless', RM.xmlText('a & b <c> "d" \'e\' ]]> \u0001\u000bok\n') === 'a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; ]]&gt; ok\n' && RM.xmlText(null) === '' && RM.xmlText(12) === '12');
  // three marked features (one with a note full of markup, one "not reached" that somebody else also marked), one unmarked, and two lone marks
  const mk = (id, kind, note, who, f, extra) => Object.assign({ id, kind, note: note || '', lon: f ? f.lon : LON + 0.02, lat: f ? f.lat : LAT + 0.01, h: f ? f.z : null, updated: { who, t: '2026-11-20T10:00:00.000Z' }, history: [] }, extra || {});
  const nasty = 'Tight <squeeze> & "wet"; it\'s 3 m ]]> in\nsecond line';
  const KM = { byFeature: {
      'r10-20': { mark: mk('m1', 'cave', nasty, 'Ana', feats[0]), also: [] },
      'r30-5': { mark: mk('m2', 'unreached', '', 'Bo', feats[1]), also: [mk('m2b', 'nothing', 'looked from above', 'Cy', feats[1])] },
      'r50-9': { mark: mk('m3', 'nothing', 'a dip', 'Cy', feats[2]), also: [] } },
    alone: [mk('m4', 'cave', 'was here last year', 'Ana', null, { feat: { depth: 9.4, returns: 40 } }), mk('m5', 'pit', '', 'Bo', null, { lon: LON + 0.03 })] };
  const toLonLat = (x, y) => ({ lon: LON + x / MX, lat: LAT + y / MY });
  const toScene = (lat, lon) => ({ x: (lon - LON) * MX, y: (lat - LAT) * MY });
  const alts = [];
  const K = RM.kmlPlacemarks(feats, KM, { toLonLat, toScene, unit: 'ft', alt: (x, y, z) => { alts.push([x, y, z]); return z === null ? null : z - 100; } });
  const all = K.folders.map(f => f.xml).join('\n');
  const names = x => Array.from(x.matchAll(/<Placemark><name>([^<]*)<\/name>/g)).map(m => m[1]);
  ok('one pin per marked feature and per lone mark; the unmarked feature is not in the file', K.count === 5 && names(all).length === 5 && !/r70-1/.test(all) && !names(all).some(n => /3\.9 ft/.test(n)), names(all));
  ok('a folder per mark, in the order cave, pit, nothing, not checked', K.folders.map(f => f.name + ':' + f.n).join('|') === 'Ridgewalking: Cave:2|Ridgewalking: Pit:1|Ridgewalking: Nothing:1|Ridgewalking: Not checked:1' &&
    K.folders.every(f => f.xml.startsWith('<Folder><name>' + f.name + '</name>') && f.xml.endsWith('</Folder>')), K.folders.map(f => f.name + ':' + f.n));
  ok('a pin is named by its mark and the depth in the map’s unit; a lone mark by the depth it had, or the mark alone', names(K.folders[0].xml).join('|') === 'Cave · 32 ft|Cave · 31 ft' && names(K.folders[1].xml).join('|') === 'Pit' &&
    names(K.folders[2].xml).join('|') === 'Nothing · 6.9 ft' && names(K.folders[3].xml).join('|') === 'Not checked · 20 ft', K.folders.map(f => names(f.xml)));
  const Km = RM.kmlPlacemarks(feats, KM, { toLonLat, unit: 'm' });
  ok('…in metres when the map is set to metres', names(Km.folders.map(f => f.xml).join('')).join('|') === 'Cave · 9.9 m|Cave · 9.4 m|Pit|Nothing · 2.1 m|Not checked · 6.2 m', names(Km.folders.map(f => f.xml).join('')));
  ok('a colour style per folder, the marks’ own colours', K.styles.length === 4 && K.styles[0].startsWith('<Style id="rw-cave"><IconStyle><color>ff63c443</color>') && K.styles[1].includes('id="rw-pit"') && K.styles[1].includes('ffff8b3d') &&
    K.styles[2].includes('ffa6a09a') && K.styles[3].includes('ff20b0ff') && (all.match(/<styleUrl>#rw-cave<\/styleUrl>/g) || []).length === 2 && all.includes('<styleUrl>#rw-unreached</styleUrl>'));
  const desc = x => Array.from(x.matchAll(/<description>([^<]*)<\/description>/g)).map(m => m[1]);
  const d0 = desc(K.folders[0].xml)[0];
  ok('the note is escaped (markup, quotes, a CDATA end) and nothing of it is left raw', d0.startsWith('Tight &lt;squeeze&gt; &amp; &quot;wet&quot;; it&apos;s 3 m ]]&gt; in\nsecond line\n') && !/<squeeze>|]]>/.test(all));
  ok('the description: who marked it and when, what it is, depth, returns, size, position', /\nMarked Cave · Ana · .*2026\nTrue entrance\nDepth: 32 ft \(9\.9 m\)\nReturns: 120\nSize: 13 ft \(4\.0 m\) × 13 ft \(4\.0 m\)\nPosition: 45\.12358, -100\.56767$/.test(d0), d0);
  ok('…what others said of the same feature', /^Marked Not checked · Bo · .*\nAlso marked: Nothing \(Cy · .*2026\): looked from above$/s.test(desc(K.folders[3].xml)[0]), desc(K.folders[3].xml)[0]);
  ok('…a lone mark: its note, that its feature is gone, what it had then', /^was here last year\nMarked Cave · Ana · .*\nIts feature is not on this map: the mark is at its own place\.\nDepth then: 31 ft \(9\.4 m\)\nReturns then: 40\nPosition: 45\.13340, -100\.54780$/s.test(desc(K.folders[0].xml)[1]), desc(K.folders[0].xml)[1]);
  const co = x => Array.from(x.matchAll(/<coordinates>([^<]*)<\/coordinates>/g)).map(m => m[1].split(',').map(Number));
  const c = co(all), mid = toLonLat(60, -4.5);
  ok('a pin stands at the middle of its feature’s box (not at the anchor), lon,lat,height', c.length === 5 && near(c[4][0], mid.lon, 1e-6) && near(c[4][1], mid.lat, 1e-6) && Math.abs(c[4][1] - feats[1].lat) > 1e-5 && near(c[0][0], toLonLat(10, 20).lon, 1e-6) && c[0][2] === 400 && c[4][2] === 405, c);
  ok('…a lone mark at its own place; its height asked at its place in the scene, 0 when not known', near(c[1][0], LON + 0.02, 1e-6) && near(c[1][1], LAT + 0.01, 1e-6) && c[1][2] === 0 && near(c[2][0], LON + 0.03, 1e-6) && alts.length === 5 && near(alts[3][0], 0.02 * MX, 1e-3) && alts[3][2] === null, [c[1], alts[3]]);
  ok('the height is asked at the box’s middle and top; without a height function 0 is written', alts[0].join() === '10,20,500' && co(Km.folders.map(f => f.xml).join('')).every(q => q[2] === 0));
  ok('the time of the mark is in the pin', (all.match(/<TimeStamp><when>2026-11-20T10:00:00\.000Z<\/when><\/TimeStamp>/g) || []).length === 5);
  // every tag closed, in order (a small check; the kit parses the whole file in a browser)
  const balanced = x => { const st = []; for (const m of x.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) { if (m[3]) continue; if (!m[1]) st.push(m[2]); else if (st.pop() !== m[2]) return false; } return st.length === 0; };
  ok('the folders are well formed', K.folders.every(f => balanced(f.xml)) && K.styles.every(balanced) && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(all));
  const none = RM.kmlPlacemarks(feats, { byFeature: {}, alone: [] }, { toLonLat });
  ok('no marks: no folders, no styles (the export is as before)', none.count === 0 && none.folders.length === 0 && none.styles.length === 0 && RM.kmlPlacemarks([], null, null).count === 0);
  const one = RM.kmlPlacemarks(feats, { byFeature: { 'r50-9': KM.byFeature['r50-9'] }, alone: [] }, { toLonLat });
  ok('only the folders that have pins are written', one.folders.length === 1 && one.folders[0].name === 'Ridgewalking: Nothing' && one.styles.length === 1 && one.count === 1);
  const far = RM.kmlPlacemarks(feats, KM, { unit: 'ft' });
  ok('without a converter a feature falls back to its anchor; a mark with no place or an unknown kind is left out', near(co(far.folders[3].xml)[0][0], feats[1].lon, 1e-6) &&
    RM.kmlPlacemarks([], { byFeature: {}, alone: [mk('q', 'cave', '', 'Ana', null, { lat: null }), mk('q2', 'odd', '', 'Ana', null)] }, {}).count === 0);
  ok('the page’s own calls answer on a map without marks', RM.marked() === 0 && RM.kml({ unit: 'ft' }).count === 0);
}

// ── 2. The page: three.js, the real modules, a stand-in document ──────────────
function makeViewer() {
  const mk = tag => { const e = { tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], _on: {}, className: '', appendChild(c) { e.children.push(c); c.parent = e; return c; }, addEventListener(ev, f) { e._on[ev] = f; },
    getContext: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }), querySelector: () => ({ value: '' }), set textContent(v) { e._text = v; if (v === '') e.children = []; }, get textContent() { return e._text; } }; return e; };
  const body = mk('body'), head = mk('head');
  const ctx = { console: { warn() {}, log: console.log, error: console.error, info() {} }, Math, Promise, Date, JSON, Object, Array, Number, String, Set, Map, window: {},
    document: { createElement: mk, body, head, getElementById: () => null, activeElement: null, createTextNode: t => ({ text: t }) } };
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ['three.min.js', 'flexlib.js', 'ridgewalk.js', 'ridge-marks.js']) vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', f), 'utf8'), ctx);
  const THREE = ctx.THREE, cam = new THREE.PerspectiveCamera(50, 1, 1, 5000);
  cam.position.set(70, 0, 800); cam.lookAt(70, 0, 500); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const v = { ctx, THREE, RM: ctx.RidgeMarks || ctx.window.RidgeMarks, FR: ctx.window.FlexRidge, FLc: ctx.FlexLib || ctx.window.FlexLib, scene: new THREE.Scene(), cam, body, log: [], pid: 'p1', redraws: 0, asked: 0, toasts: [], dims: [] };
  const D = dev('phone', 'Ana');
  v.opts = (features, marks, saved, extra) => Object.assign({ THREE, scene: v.scene, camera: cam, features, marks, saved,
    ridge: { setDim: (boxes, hide, grey) => v.dims.push({ n: boxes.length, hide, boxes, grey: grey || [] }) },
    project: () => (v.pid ? v.FLc.replayProject(v.log, v.pid) : null), hasProject: () => !!v.pid, ensureProject: async () => { v.asked++; if (v.grant) v.pid = 'p1'; },
    record: (op, data) => { const e = D(Object.assign({ op }, data)); v.log.push(e); return e; },
    toScene: (lat, lon) => ({ x: (lon - LON) * MX, y: (lat - LAT) * MY }), toLonLat: (x, y) => ({ lon: LON + x / MX, lat: LAT + y / MY }), groundZ: () => 480,
    toast: m => v.toasts.push(m), redraw: () => { v.redraws++; } }, extra || {});
  return v;
}

(async () => {
  let v = makeViewer();
  ok('the module is there in the page', !!v.RM && typeof v.RM.init === 'function');
  ok('no list and no marks (a normal export, an older ridge export): idle, nothing in the scene', await v.RM.init(v.opts(undefined, undefined)) === false && !v.RM.active() && v.scene.children.length === 0 && v.RM.pick(1, 1, { width: 800, height: 800 }) === null && v.RM.serialize() === undefined);
  ok('an empty list and no marks: idle too', await v.RM.init(v.opts([], [])) === false && !v.RM.active());
  // features, one export mark with no feature, no marks in the library yet
  ok('with the export’s list: active', await v.RM.init(v.opts(LIST, [exp[2]])) === true && v.RM.active());
  let o = v.RM.objects();
  ok('four features; the export’s lone mark is drawn at its own place with a dashed-rim badge; nothing dimmed', o.features.length === 4 && o.marks.length === 1 && o.alone.join() === 'x2' && o.badges.length === 1 && o.badges[0].name === 'rmark-cave-alone' && o.badges[0].isSprite &&
    near(o.badges[0].position.x, 0.01 * MX, 0.5) && o.badges[0].position.z === 481.5 && v.dims[v.dims.length - 1].n === 0, [o.badges.map(b => b.name), v.dims]);
  const rect = { width: 800, height: 800 };
  const px = (x, y, z) => { const q = new v.THREE.Vector3(x, y, z).project(v.cam); return [(q.x + 1) / 2 * 800, (1 - q.y) / 2 * 800]; };
  let p = px(10, 20, 500), hit = v.RM.pick(p[0] + 3, p[1] - 2, rect);
  ok('a tap on a feature’s anchor finds it', hit && hit.feature === 'r10-20' && hit.d < 5, hit);
  p = px(60, -12, 501); hit = v.RM.pick(p[0], p[1], rect);
  ok('a tap anywhere over the long crack finds it (far from its anchor)', hit && hit.feature === 'r30-5', hit);
  ok('a tap on open ground finds nothing', v.RM.pick(...px(200, 150, 500), rect) === null);
  // mark the pit
  let e = await v.RM.setMark({ feature: 'r10-20' }, { kind: 'pit', note: 'needs rope' });
  o = v.RM.objects();
  ok('a button writes one record through the viewer and the badge is there at once: Pit, blue, over the anchor', e && e.op === 'rmark.set' && v.log.length === 1 && o.matched['r10-20'] === 'pit' && o.badges.some(b => b.name === 'rmark-pit' && b.position.x === 10 && b.position.y === 20 && b.position.z === 501.5 && b.material.depthTest === false && b.material.sizeAttenuation === false), o.badges.map(b => b.name));
  ok('the same button again writes nothing', await v.RM.setMark({ feature: 'r10-20' }, { kind: 'pit', note: 'needs rope' }) === null && v.log.length === 1);
  await v.RM.setMark({ feature: 'r10-20' }, { kind: 'cave', note: 'needs rope' });
  ok('another button changes that mark: a second record of the same mark, the badge is Cave', v.log.length === 2 && v.log[1].mark === v.log[0].mark && v.RM.objects().matched['r10-20'] === 'cave' && v.RM.objects().badges.filter(b => /^rmark-(cave|pit)$/.test(b.name)).length === 1);
  await v.RM.setMark({ feature: 'r50-9' }, { kind: 'nothing' });
  await v.RM.setMark({ feature: 'r30-5' }, { kind: 'unreached', note: 'across the gully' });
  o = v.RM.objects();
  ok('four kinds of badge on the map, each its own picture', o.badges.map(b => b.name).sort().join() === 'rmark-cave,rmark-cave-alone,rmark-nothing,rmark-unreached' && new Set(o.badges.map(b => b.material.map)).size === 4);
  ok('the feature marked "nothing" is handed to the drawing to be dimmed (its box), not hidden', v.dims[v.dims.length - 1].n === 1 && v.dims[v.dims.length - 1].hide === false && near(v.dims[v.dims.length - 1].boxes[0][0], 99.1));
  // the switches
  v.RM.set('hideNothing', true); o = v.RM.objects();
  ok('Hide "nothing": its badge hidden, its shape left out, a tap no longer finds it; the others stay', o.badges.find(b => b.name === 'rmark-nothing').visible === false && o.badges.find(b => b.name === 'rmark-cave').visible && v.dims[v.dims.length - 1].hide === true &&
    v.RM.pick(...px(100, 18, 498), rect) === null && v.RM.pick(...px(10, 20, 500), rect).feature === 'r10-20');
  v.RM.set('marks', false); o = v.RM.objects();
  ok('Marks off: no badges, nothing dimmed or hidden (the features are all there again)', o.badges.every(b => !b.visible) && v.dims[v.dims.length - 1].n === 0 && v.RM.pick(...px(100, 18, 498), rect).feature === 'r50-9');
  const saved = JSON.parse(JSON.stringify(v.RM.serialize()));
  ok('the two switches are saved', saved.v === 1 && saved.marks === false && saved.hideNothing === true);
  v.RM.set('marks', true); v.RM.set('hideNothing', false);
  const ui = [];
  v.RM.sheet({ head: t => ui.push('H:' + t), chips: c => c.forEach(x => ui.push(x[1] + (x[2] ? ':on' : ':off'))) });
  ok('Display: "Marks on features (4)", Marks, Hide “nothing”', ui.join('|') === 'H:Marks on features (4)|Marks:on|Hide “nothing”:off', ui);
  // the lone mark: tap, change, remove
  const lone = v.RM.objects().badges.find(b => b.name === 'rmark-cave-alone');
  p = px(lone.position.x, lone.position.y, lone.position.z);
  ok('a tap on a lone mark’s badge finds the mark', (v.RM.pick(p[0], p[1] - 10, rect) || {}).mark === 'x2');
  await v.RM.setMark({ mark: 'x2' }, { kind: 'nothing' });
  ok('changing it takes the export’s mark into the library under its own id', v.log[v.log.length - 1].mark === 'x2' && v.log[v.log.length - 1].kind === 'nothing' && v.RM.objects().badges.some(b => b.name === 'rmark-nothing-alone'));
  await v.RM.setMark({ mark: 'x2' }, { removed: true });
  ok('removing it: gone from the map (and it stays gone though the export still lists it)', !v.RM.objects().alone.length && !v.RM.objects().badges.some(b => /alone/.test(b.name)));
  // undo through the viewer's change log
  const un = v.RM.inverse(v.log[1]);
  v.log.push(Object.assign({ id: 'phone.99', dev: 'phone', seq: 99, t: '2026-11-21T00:00:00.000Z', who: 'Ana' }, un)); v.RM.refresh();
  ok('undoing the change in the log puts the earlier mark back (Pit)', v.RM.objects().matched['r10-20'] === 'pit');

  // a map with no project: the viewer is asked for one, as for any other change
  const w = makeViewer(); w.pid = null;
  await w.RM.init(w.opts(LIST, exp.slice(0, 1)));
  ok('no project chosen: the export’s marks still show', w.RM.objects().matched['r50-9'] === 'nothing' && w.RM.objects().badges.length === 1);
  let r = await w.RM.setMark({ feature: 'r10-20' }, { kind: 'cave' });
  ok('…a button asks for the project; none given: nothing recorded, a word says why', r === null && w.asked === 1 && w.log.length === 0 && w.toasts.join() === 'No project for this map yet');
  w.grant = true; r = await w.RM.setMark({ feature: 'r10-20' }, { kind: 'cave' });
  ok('…given: the mark is recorded', r && w.log.length === 1 && w.RM.objects().matched['r10-20'] === 'cave' && w.asked === 2);

  // saved switches at start; a list by file name is fetched
  const s2 = makeViewer(); s2.log = v.log.slice();
  s2.ctx.fetch = name => Promise.resolve({ ok: true, json: () => Promise.resolve(name === 'ridge_features.json' ? { version: 1, features: LIST } : { version: 1, marks: [exp[2]] }) });
  ok('by file name (the app): the two lists are fetched; the saved switches apply from the start', await s2.RM.init(s2.opts('ridge_features.json', 'ridge_marks.json', saved)) === true && s2.RM.objects().features.length === 4 && s2.RM.state().marks === false && s2.RM.objects().badges.every(b => !b.visible));
  const s3 = makeViewer(); s3.ctx.fetch = () => Promise.resolve({ ok: false });
  ok('a list that cannot be fetched: idle, no error', await s3.RM.init(s3.opts('ridge_features.json', null)) === false);

  // ── 2b. The depth sliders on the page: the rings, the grey list, the rows in Display ──
  {
    const w = makeViewer();
    await w.RM.init(w.opts(LIST, []));
    let q = w.RM.objects();
    ok('nothing saved: both sliders off, no ring object at all, nothing handed over to grey', w.RM.state().hi === 0 && w.RM.state().grey === 0 && q.rings === null && q.ringed.length === 0 && q.greyed.length === 0 && w.dims[w.dims.length - 1].grey.length === 0 && !w.scene.getObjectByName('ridge-rings'));
    let r0 = w.redraws; w.RM.set('hi', 20); q = w.RM.objects();
    const P3 = a => Array.from(a.geometry.attributes.position.array).join();
    ok('Highlight deeper than 20 ft: ONE object for all the rings (THREE.Points), a point over each deep feature’s box, a frame asked for', q.rings && q.rings.isPoints === true && q.rings.name === 'ridge-rings' && w.scene.getObjectByName('ridge-marks').children.filter(c => c.isPoints).length === 1 &&
      q.rings.geometry.attributes.position.count === 2 && P3(q.rings) === '10,20,500,60,-4.5,505' && q.ringed.join() === 'r10-20,r30-5' && w.redraws > r0, q.rings && P3(q.rings));
    const m = q.rings.material;
    ok('…the same size on the screen at any distance, on top of everything (no depth test), a ring picture, under the badges', m.sizeAttenuation === false && m.size === w.RM.RING_PX && m.depthTest === false && m.depthWrite === false && m.transparent === true && !!m.map && q.rings.renderOrder < 9 && q.rings.renderOrder > 8 && !m.onBeforeCompile.toString().includes('uUnder'));
    const rings1 = q.rings; r0 = w.redraws; const n0 = w.dims.length;
    w.RM.set('hi', 20);
    ok('the same value again: nothing is done', w.RM.objects().rings === rings1 && w.redraws === r0 && w.dims.length === n0);
    w.RM.refresh();
    ok('a refresh with the same rings keeps the object (not built again)', w.RM.objects().rings === rings1);
    await w.RM.setMark({ feature: 'r30-5' }, { kind: 'cave' });
    q = w.RM.objects();
    ok('a mark other than "nothing" keeps the ring, and its badge is there too (drawn after the ring)', q.ringed.join() === 'r10-20,r30-5' && q.badges.some(b => b.name === 'rmark-cave' && b.renderOrder > q.rings.renderOrder));
    await w.RM.setMark({ feature: 'r10-20' }, { kind: 'nothing' });
    q = w.RM.objects();
    ok('marked "nothing": its ring goes (the rings are built again: one point left)', q.ringed.join() === 'r30-5' && q.rings !== rings1 && q.rings.geometry.attributes.position.count === 1 && P3(q.rings) === '60,-4.5,505');
    const rect = { width: 800, height: 800 }, px = (x, y, z) => { const t = new w.THREE.Vector3(x, y, z).project(w.cam); return [(t.x + 1) / 2 * 800, (1 - t.y) / 2 * 800]; };
    const hit = w.RM.pick(...px(60, -4.5, 505), rect);
    ok('a tap on a ring opens its feature', hit && hit.feature === 'r30-5' && hit.d < 2, hit);
    w.RM.set('grey', 10);
    let dm = w.dims[w.dims.length - 1];
    ok('Grey out shallower than 10 ft: the shallow features’ boxes go to the drawing as the grey-only list; the "nothing" box stays in the first list; not hidden', dm.grey.length === 2 && near(dm.grey[0][0], 99.1) && near(dm.grey[1][0], 139.4) && dm.n === 1 && near(dm.boxes[0][0], 7.6) && dm.hide === false && w.RM.objects().greyed.join() === 'r50-9,r70-1', dm);
    w.RM.set('hideNothing', true); dm = w.dims[w.dims.length - 1];
    ok('Hide "nothing" hides the "nothing" boxes only: the depth-greyed ones stay in the grey-only list', dm.hide === true && dm.n === 1 && dm.grey.length === 2);
    w.RM.set('marks', false); dm = w.dims[w.dims.length - 1];
    ok('Marks off: the "nothing" dimming goes, the depth grey and the rings stay', dm.n === 0 && dm.hide === false && dm.grey.length === 2 && w.RM.objects().rings.visible !== false && w.RM.objects().ringed.join() === 'r30-5');
    w.RM.set('marks', true); w.RM.set('hideNothing', false);
    w.RM.set('grey', 30); w.RM.set('hi', 5);
    q = w.RM.objects();
    ok('grey 30 ft over highlight 5 ft: ringed features are not in the grey list', q.ringed.join() === 'r30-5,r50-9' && q.greyed.join() === 'r70-1', [q.ringed, q.greyed]);
    const ser = w.RM.serialize();
    ok('the two sliders are saved with the other choices, in feet', ser.v === 1 && ser.hi === 5 && ser.grey === 30 && ser.marks === true);
    w.RM.set('hi', 0); w.RM.set('grey', 0); q = w.RM.objects();
    ok('both back to 0: no ring object, nothing grey', q.rings === null && !w.scene.getObjectByName('ridge-rings') && w.dims[w.dims.length - 1].grey.length === 0);
    w.RM.set('hi', 999); w.RM.set('grey', 'x');
    ok('a value out of range is held to 60 ft; not a number is off', w.RM.state().hi === 60 && w.RM.state().grey === 0 && w.RM.objects().rings === null);
    // saved at the start
    const w2 = makeViewer(); await w2.RM.init(w2.opts(LIST, [], { v: 1, marks: true, hideNothing: false, hi: 30, grey: 5 }));
    ok('saved sliders apply from the start', w2.RM.state().hi === 30 && w2.RM.objects().ringed.join() === 'r10-20' && w2.RM.objects().greyed.join() === 'r70-1' && w2.dims[w2.dims.length - 1].grey.length === 1);
    // the rows in Display
    const mkEl = (tag, cls, text) => ({ tag, cls, text, style: {}, kids: [], on: {}, appendChild(c) { this.kids.push(c); }, addEventListener(ev, f) { this.on[ev] = f; }, set textContent(t) { this.text = t; }, get textContent() { return this.text; } });
    const draw = (W, unit) => { const sheet = mkEl('div'), heads = []; W.RM.sheet({ el: mkEl, sheet, head: t => heads.push(t), chips: () => {}, units: { u: unit } }); return { rows: sheet.kids, heads }; };
    let sh = draw(w2, 'ft');
    const inp = r => r.kids[1], val = r => r.kids[2];
    ok('Display: two sliders 0..60 ft with their value, under the head of Below ground', sh.rows.length === 2 && sh.rows.every(r => r.cls === 'sh-sl') && sh.rows[0].kids[0].text === 'Highlight deeper than' && sh.rows[1].kids[0].text === 'Grey out shallower than' &&
      inp(sh.rows[0]).id === 'ridge-hi-slider' && inp(sh.rows[1]).id === 'ridge-grey-slider' && inp(sh.rows[0]).type === 'range' && inp(sh.rows[0]).min === '0' && inp(sh.rows[0]).max === '60' && inp(sh.rows[0]).value === '30' && inp(sh.rows[1]).value === '5' &&
      val(sh.rows[0]).text === '30 ft' && val(sh.rows[1]).text === '5 ft' && sh.heads[0] === 'Below ground (V2)' && /^Marks on features/.test(sh.heads[1]), sh.heads);
    const dn = w2.dims.length, rr = w2.redraws;
    inp(sh.rows[0]).value = '12'; inp(sh.rows[0]).on.input();
    ok('while the slider moves only its number changes (nothing is recoloured, no frame asked for)', val(sh.rows[0]).text === '12 ft' && w2.RM.state().hi === 30 && w2.dims.length === dn && w2.redraws === rr);
    inp(sh.rows[0]).on.change();
    ok('let go: applied once', w2.RM.state().hi === 12 && w2.RM.objects().ringed.join() === 'r10-20,r30-5' && w2.dims.length === dn + 1 && w2.redraws > rr);
    inp(sh.rows[1]).value = '0'; inp(sh.rows[1]).on.input();
    ok('at 0 the label says off', val(sh.rows[1]).text === 'off');
    sh = draw(w2, 'm');
    ok('in metres the label shows metres; the slider and the saved value stay in feet', val(sh.rows[0]).text === '3.7 m' && inp(sh.rows[0]).value === '12' && w2.RM.serialize().hi === 12);
    // only marks, no feature list: no sliders
    const w3 = makeViewer(); await w3.RM.init(w3.opts([], [exp[2]]));
    sh = draw(w3, 'ft');
    ok('a map with marks but no list of features: no sliders', w3.RM.active() && sh.rows.length === 0 && sh.heads.length === 1);
    const w4 = makeViewer(); await w4.RM.init(w4.opts(undefined, undefined));
    ok('a map with no ridgewalking: no rows at all, no cost', (() => { let n = 0; w4.RM.sheet({ el: () => { n++; }, sheet: {}, head: () => { n++; }, chips: () => { n++; } }); w4.RM.set('hi', 20); return n === 0 && w4.RM.objects() === null; })());
  }

  // ── 3. The dimming in libs/ridgewalk.js ─────────────────────────────────────
  const FR = v.FR, T3 = v.THREE;
  const pts = [[100, 18, 497, 3.05, 0], [100.2, 18.1, 496.5, 6.1, 0], [10, 20, 495, 3.05, 0], [10, 21, 492, 12, 0], [60, 0, 500, 1, 1]];
  const pb = Buffer.alloc(8 + pts.length * 17); pb.write('RWP1', 0, 'latin1'); pb.writeUInt32LE(pts.length, 4);
  pts.forEach((q, i) => { for (let k = 0; k < 3; k++) pb.writeFloatLE(q[k], 8 + (i * 3 + k) * 4); pb.writeFloatLE(q[3], 8 + pts.length * 12 + i * 4); pb.writeUInt8(q[4], 8 + pts.length * 16 + i); });
  const sv = [[99.6, 17.6, 496.5], [100.4, 17.6, 496.5], [100, 18.4, 497.5], [100, 18, 496], [9, 19, 495], [11, 19, 495], [10, 21, 492], [100.4, 18.4, 497], [10, 20, 498]];
  const st = [0, 1, 2, 0, 1, 3, 4, 5, 6, 2, 7, 8];          // two triangles in the "nothing" box, one in the pit, one with a foot in each
  const sb = Buffer.alloc(12 + sv.length * 16 + st.length * 4); sb.write('RWS1', 0, 'latin1'); sb.writeUInt32LE(sv.length, 4); sb.writeUInt32LE(st.length / 3, 8);
  sv.forEach((q, i) => { for (let k = 0; k < 3; k++) sb.writeFloatLE(q[k], 12 + (i * 3 + k) * 4); sb.writeFloatLE(3.05, 12 + sv.length * 12 + i * 4); });
  st.forEach((q, i) => sb.writeUInt32LE(q, 12 + sv.length * 16 + i * 4));
  const scene2 = new T3.Scene();
  await FR.init({ THREE: T3, scene: scene2, ridge: { version: 1, points: pb.toString('base64'), patches: null, shapes: sb.toString('base64'), depthCap: 20 }, saved: null,
    isAssetRef: () => false, b64ToArrayBuffer: s => { const q = Buffer.from(s, 'base64'); return q.buffer.slice(q.byteOffset, q.byteOffset + q.byteLength); }, redraw() {} });
  const ro = FR.objects(), col = () => Array.from(ro.shapes.geometry.attributes.color.array), dots = () => Array.from(ro.points[0].geometry.attributes.color.array);
  const col0 = col(), dots0 = dots(), box = RM.nothingBoxes(feats, RM.match([Object.assign({ id: 'n', kind: 'nothing', updated: { t: '' } }, { lon: feats[2].lon, lat: feats[2].lat })], feats));
  ok('which vertices lie in a box', Array.from(FR.insideBoxes(new Float32Array(sv.flat()), box)).join('') === '111100010' && Array.from(FR.insideBoxes(new Float32Array(sv.flat()), [])).join('') === '000000000');
  FR.setDim(box, false);
  const grey = (a, i) => near(a[i * 3], 0.36, 1e-3) && near(a[i * 3 + 1], 0.37, 1e-3) && near(a[i * 3 + 2], 0.40, 1e-3);
  ok('dimmed: the "nothing" feature’s shape vertices and returns are grey, everything else keeps its depth colour, every triangle still drawn', [0, 1, 2, 3, 7].every(i => grey(col(), i)) && [4, 5, 6, 8].every(i => !grey(col(), i) && col()[i * 3] === col0[i * 3]) &&
    grey(dots(), 0) && grey(dots(), 1) && !grey(dots(), 2) && dots()[6] === dots0[6] && ro.shapes.geometry.index.count === 12);
  FR.setDim(box, true);
  ok('hidden: the triangles wholly inside are left out of the draw (2 of 4); the one with a foot outside stays; the returns stay, grey', ro.shapes.geometry.index.count === 6 && Array.from(ro.shapes.geometry.index.array).join() === '4,5,6,2,7,8' && grey(dots(), 0));
  FR.setDim([], false);
  ok('no boxes: every colour and triangle is back exactly (nothing was deleted)', col().join() === col0.join() && dots().join() === dots0.join() && ro.shapes.geometry.index.count === 12 && Array.from(ro.shapes.geometry.index.array).join() === st.join());
  // the grey-only list (the features shallower than the chosen depth): greyed the same way, never left out
  const pit = [[7.6, 17.6, 489.6, 12.4, 22.4, 500.4]];
  FR.setDim([], true, box);
  ok('a grey-only box: the same grey, and with "hide" on every triangle is still drawn', [0, 1, 2, 3, 7].every(i => grey(col(), i)) && [4, 5, 6, 8].every(i => !grey(col(), i)) && grey(dots(), 0) && !grey(dots(), 2) && ro.shapes.geometry.index.count === 12);
  FR.setDim(pit, true, box);
  ok('a "nothing" box with hide and a grey-only box together: both grey, only the "nothing" triangles left out', [0, 1, 2, 3, 4, 5, 6, 7, 8].every(i => grey(col(), i)) && grey(dots(), 2) && grey(dots(), 3) && !grey(dots(), 4) && Array.from(ro.shapes.geometry.index.array).join() === '0,1,2,0,1,3,2,7,8');
  const ver = ro.shapes.geometry.attributes.color.version;
  FR.setDim(pit.map(b => b.slice()), true, box.map(b => b.slice()));
  ok('asked for the same thing again: the colours are not written again', ro.shapes.geometry.attributes.color.version === ver);
  FR.setDim(pit, false, []);
  ok('the grey-only list emptied: its colours are back, the "nothing" box stays grey', [0, 1, 2, 3, 7].every(i => !grey(col(), i) && col()[i * 3] === col0[i * 3]) && [4, 5, 6, 8].every(i => grey(col(), i)) && ro.shapes.geometry.index.count === 12);
  FR.setDim([], false);
  ok('all off: exactly as made', col().join() === col0.join() && dots().join() === dots0.join() && Array.from(ro.shapes.geometry.index.array).join() === st.join());
  ok('ten thousand boxes over a million vertices are filed in cells (fast)', (() => { const n = 1e6, pos = new Float32Array(n * 3); for (let i = 0; i < n; i++) { pos[i * 3] = (i * 7919) % 4000; pos[i * 3 + 1] = (i * 104729) % 4000; pos[i * 3 + 2] = 500; }
    const bx = []; for (let i = 0; i < 10000; i++) { const x = (i * 37) % 3990, y = (i * 91) % 3990; bx.push([x, y, 490, x + 3, y + 3, 510]); }
    const t0 = Date.now(), fl = FR.insideBoxes(pos, bx), ms = Date.now() - t0; let c = 0; for (let i = 0; i < n; i++) c += fl[i]; return ms < 1500 && c > 1000; })());

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
