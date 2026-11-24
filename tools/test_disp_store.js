// The rules for where the viewer keeps its display and settings state (viewer_build/libs/disp-store.js, no DOM): a map with a
// project reads and writes the project's state, a map without one its own; a project starts from the defaults; a choice a map
// cannot show (it falls back) is never written over the saved one; only changed fields of a part are written; linking and
// unlinking while open. Made-up names and settings.   node tools/test_disp_store.js
'use strict';
const D = require('../viewer_build/libs/disp-store.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 500) : '')); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// a phone's storage, and a map opened on it
const phone = () => { const m = {}; return { m, writes: 0, get: k => (k in m ? m[k] : null), set(k, v) { m[k] = v; this.writes++; }, at: k => JSON.parse(m[k] || 'null') }; };
const openMap = (ph, mapKey, project, mapOnly) => D.open({ mapKey, project, mapOnly, get: k => ph.get(k), set: (k, v) => ph.set(k, v) });
const PA = 'flex_display_v1|project:pcaveridge', MA = 'flex_display_v1|map:a', MB = 'flex_display_v1|map:b';

// ── which key ──────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('a map with no project: its own key, as before', D.keyFor('map:a', null) === MA && D.keyFor('Cave Ridge|-100.568|45.123', '') === 'flex_display_v1|Cave Ridge|-100.568|45.123');
ok('a map with a project: the project key', D.keyFor('map:a', 'pcaveridge') === PA && D.keyFor('map:b', 'pcaveridge') === PA);
ok('something that is not a project id is no project', D.keyFor('map:a', 'a b|c') === MA && D.keyFor('map:a', 42) === MA && D.keyFor('map:a', undefined) === MA);
ok('start: the linked project wins, else the one the export names, else none',
  D.startProject('p1', { id: 'p2' }) === 'p1' && D.startProject('', { id: 'p2' }) === 'p2' && D.startProject(null, null) === null && D.startProject(null, { name: 'x' }) === null);
ok('same(): deep, undefined fields ignored, arrays by order', D.same({ a: 1, b: [1, { c: 2 }], u: undefined }, { b: [1, { c: 2 }], a: 1 }) && !D.same({ a: [1, 2] }, { a: [2, 1] }) && !D.same({ a: 1 }, { a: 1, b: 2 }) && !D.same(1, '1'));
ok('stored text that is not an object reads as empty', eq(D.parse('nonsense'), {}) && eq(D.parse('[1]'), {}) && eq(D.parse(null), {}) && eq(D.parse('{"a":1}'), { a: 1 }));

// ── two maps of one project share; a map without project does not ──────────────────────────────────────────────────────
{
  const ph = phone();
  ph.m[MA] = JSON.stringify({ wallMode: 0, tex: 'hs' });                 // map a's state from before it had a project
  const a = openMap(ph, 'map:a', 'pcaveridge');
  ok('a project starts from the defaults: the map\'s old state is not carried over', eq(a.state, {}) && a.key() === PA, a.state);
  a.seen({ wallMode: 1, tex: 'sat', trees: { v: 1, on: true, brush: true } });
  ok('nothing is written until something changes', a.save({ wallMode: 1, tex: 'sat', trees: { v: 1, on: true, brush: true } }) === false && ph.writes === 0);
  ok('a change is saved', a.save({ wallMode: 2, tex: 'sat', trees: { v: 1, on: true, brush: true } }) === true && eq(ph.at(PA), { wallMode: 2 }), ph.at(PA));
  ok('the map\'s own old state is left as it was', eq(ph.at(MA), { wallMode: 0, tex: 'hs' }));
  const b = openMap(ph, 'map:b', 'pcaveridge');
  ok('another map of the project opens with it', b.state.wallMode === 2 && b.key() === PA);
  const c = openMap(ph, 'map:c', null);
  ok('a map with no project does not', eq(c.state, {}) && c.key() === 'flex_display_v1|map:c');
  c.seen({ wallMode: 1 }); c.save({ wallMode: 0 });
  ok('and its change stays its own', ph.at('flex_display_v1|map:c').wallMode === 0 && ph.at(PA).wallMode === 2);
  // a key the viewer never listed in seen() (a switch saved on its own) is covered too
  ok('a key saved on its own, never named here', b.save({ groundDrag: true }) && ph.at(PA).groundDrag === true && b.state.groundDrag === true);
  ok('the same value again writes nothing', b.save({ groundDrag: true }) === false);
  ok('and back', b.save({ groundDrag: false }) && ph.at(PA).groundDrag === false);
  // map a is still open and wrote before b: a's next save must keep b's key
  a.save({ tex: 'hs' });
  ok('two open maps do not wipe each other\'s keys', eq(ph.at(PA), { wallMode: 2, groundDrag: false, tex: 'hs' }), ph.at(PA));
}

// ── a setting this map cannot honour falls back for this map only ─────────────────────────────────────────────────────
{
  const ph = phone();
  ph.m[PA] = JSON.stringify({ tex: 'slope', colourMode: 2, trees: { v: 1, on: true, brush: false }, ridge: { v: 2, shapes: true, size: 3 }, fog: 40 });
  const a = openMap(ph, 'map:a', 'pcaveridge');                           // no slope picture, no trees, no ridgewalking, no height grid
  ok('the state read is the project\'s', a.state.tex === 'slope' && a.state.trees.on === true);
  const shown = () => ({ tex: 'sat', colourMode: 1, trees: undefined, ridge: undefined, fog: 40, wallMode: 1 });
  a.seen(shown());
  ok('saving what is shown writes nothing', a.save(shown()) === false && ph.writes === 0);
  ok('the state still holds what the project wants (a picture that arrives late can be put back)', a.state.tex === 'slope');
  a.save(Object.assign(shown(), { fog: 55 }));
  ok('another change is saved without the fall-backs', eq(ph.at(PA), { tex: 'slope', colourMode: 2, trees: { v: 1, on: true, brush: false }, ridge: { v: 2, shapes: true, size: 3 }, fog: 55 }), ph.at(PA));
  a.save(Object.assign(shown(), { fog: 55, tex: 'hs' }));
  ok('a choice made on this map is saved', ph.at(PA).tex === 'hs' && ph.at(PA).colourMode === 2);
  // the late picture: the fall-back ends, which is the saved value again
  const ph2 = phone(); ph2.m[PA] = JSON.stringify({ tex: 'hs' });
  const b = openMap(ph2, 'map:b', 'pcaveridge');
  b.seen({ tex: 'sat' }); b.save({ tex: 'hs' });
  ok('a picture that arrives after the start changes nothing saved', eq(ph2.at(PA), { tex: 'hs' }));
}

// ── parts: only the changed fields, unless the saved part is of another version ───────────────────────────────────────
{
  const ph = phone();
  ph.m[PA] = JSON.stringify({ trees: { v: 1, on: true, brush: true, level: 0.5 }, ridge: { v: 1, dots: true }, features: { all: true, off: ['f1'] } });
  const a = openMap(ph, 'map:a', 'pcaveridge');
  // this map: brush cannot be shown (falls back to off); ridgewalking state is of a newer build (the old one was dropped)
  a.seen({ trees: { v: 1, on: true, brush: false, level: 0.5 }, ridge: { v: 2, shapes: true, dots: false }, features: { all: true, off: ['f1'] } });
  a.save({ trees: { v: 1, on: false, brush: false, level: 0.5 }, ridge: { v: 2, shapes: true, dots: false }, features: { all: true, off: ['f1'] } });
  ok('one field of a part changed: the others keep the saved values', eq(ph.at(PA).trees, { v: 1, on: false, brush: true, level: 0.5 }), ph.at(PA).trees);
  ok('an untouched part of an older version is left alone', eq(ph.at(PA).ridge, { v: 1, dots: true }));
  a.save({ ridge: { v: 2, shapes: false, dots: false } });
  ok('a changed part of another version is written whole (a half of each would be dropped at the next start)', eq(ph.at(PA).ridge, { v: 2, shapes: false, dots: false }), ph.at(PA).ridge);
  a.save({ features: { all: true, off: ['f1', 'f2'] } });
  ok('a list is one value', eq(ph.at(PA).features, { all: true, off: ['f1', 'f2'] }));
  a.save({ fx: { ghost: 0.2, focus: true } });
  ok('a part saved for the first time is written whole', eq(ph.at(PA).fx, { ghost: 0.2, focus: true }));
  const b = openMap(ph, 'map:b', null);
  b.seen({ trees: { v: 2, on: true, level: 8 } });
  b.save({ trees: { v: 2, on: true, level: 4 } });
  ok('the same for a map on its own', eq(ph.at(MB), { trees: { v: 2, on: true, level: 4 } }), ph.at(MB));
}

// ── linked to a project while open, and unlinked ──────────────────────────────────────────────────────────────────────
{
  const ph = phone();
  ph.m[PA] = JSON.stringify({ wallMode: 0, tex: 'hs' });
  const a = openMap(ph, 'map:a', null);
  a.seen({ wallMode: 1, tex: 'sat', fog: 10 });
  a.save({ wallMode: 1, tex: 'sat', fog: 20 });
  ok('before: its own state', eq(ph.at(MA), { fog: 20 }));
  const st = a.state;
  ok('linked: the key is the project\'s', a.setProject('pcaveridge') === true && a.key() === PA && a.project() === 'pcaveridge');
  ok('the state object is the same one, now holding the project\'s', a.state === st && eq(st, { wallMode: 0, tex: 'hs' }), st);
  ok('linking writes nothing: no state is carried into the project', a.save({ wallMode: 1, tex: 'sat', fog: 20 }) === false && eq(ph.at(PA), { wallMode: 0, tex: 'hs' }));
  a.save({ wallMode: 2, tex: 'sat', fog: 20 });
  ok('a change after linking goes to the project, alone', eq(ph.at(PA), { wallMode: 2, tex: 'hs' }) && eq(ph.at(MA), { fog: 20 }), ph.at(PA));
  ok('linking to the same project again is nothing', a.setProject('pcaveridge') === false);
  ok('unlinked: its own key and state again', a.setProject(null) === true && a.key() === MA && eq(a.state, { fog: 20 }), a.state);
  a.save({ wallMode: 0 });
  ok('a change after unlinking stays with the map', eq(ph.at(MA), { fog: 20, wallMode: 0 }) && eq(ph.at(PA), { wallMode: 2, tex: 'hs' }));
  ok('moved to another project: that one starts from the defaults', a.setProject('pother') && eq(a.state, {}) && a.key() === 'flex_display_v1|project:pother');
}

// ── keys that stay with the map ───────────────────────────────────────────────────────────────────────────────────────
{
  const ph = phone();
  ph.m[PA] = JSON.stringify({ wallMode: 0, view: [9, 9, 9] });
  ph.m[MA] = JSON.stringify({ wallMode: 2, view: [1, 2, 3], fog: 5 });
  const a = openMap(ph, 'map:a', 'pcaveridge', ['view']);
  ok('read: the project\'s state with the map\'s own map-only keys', eq(a.state, { wallMode: 0, view: [1, 2, 3] }), a.state);
  a.seen({ wallMode: 0, view: [1, 2, 3] });
  a.save({ wallMode: 1, view: [4, 5, 6] });
  ok('written: each to its place, the rest of both untouched', eq(ph.at(PA), { wallMode: 1, view: [9, 9, 9] }) && eq(ph.at(MA), { wallMode: 2, view: [4, 5, 6], fog: 5 }), [ph.at(PA), ph.at(MA)]);
  const b = openMap(ph, 'map:b', 'pcaveridge', ['view']);
  ok('another map of the project does not get it', eq(b.state, { wallMode: 1 }), b.state);
}

// ── storage that fails ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const a = D.open({ mapKey: 'map:a', project: 'pcaveridge', get() { throw new Error('off'); }, set() { throw new Error('off'); } });
  let threw = false;
  try { a.seen({ wallMode: 1 }); a.save({ wallMode: 2 }); a.setProject(null); a.save({ wallMode: 0 }); } catch (_) { threw = true; }
  ok('storage switched off: nothing throws, the state is kept for the session', !threw && a.state.wallMode === 0);
}

// ── the template uses it ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const fs = require('fs'), path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'viewer_build', 'viewer.html'), 'utf8');
  ok('viewer.html loads libs/disp-store.js once, before the script that opens the store', html.split('<script src="libs/disp-store.js"></script>').length === 2 && html.indexOf('<script src="libs/disp-store.js"></script>') < html.indexOf('FlexDisp.open('));
  ok('both hosts tell the store when the map\'s project is read or set', (html.match(/dispProject\(/g) || []).length === 5);
  ok('the display state is not written anywhere else', !/flex_display_v1/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
