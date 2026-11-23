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
    ridge: { setDim: (boxes, hide) => v.dims.push({ n: boxes.length, hide, boxes }) },
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
  ok('ten thousand boxes over a million vertices are filed in cells (fast)', (() => { const n = 1e6, pos = new Float32Array(n * 3); for (let i = 0; i < n; i++) { pos[i * 3] = (i * 7919) % 4000; pos[i * 3 + 1] = (i * 104729) % 4000; pos[i * 3 + 2] = 500; }
    const bx = []; for (let i = 0; i < 10000; i++) { const x = (i * 37) % 3990, y = (i * 91) % 3990; bx.push([x, y, 490, x + 3, y + 3, 510]); }
    const t0 = Date.now(), fl = FR.insideBoxes(pos, bx), ms = Date.now() - t0; let c = 0; for (let i = 0; i < n; i++) c += fl[i]; return ms < 1500 && c > 1000; })());

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
