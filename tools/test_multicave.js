// Systems and multi-cave survey files (doc 14, rule 3) in viewer_build/libs/flexlib.js: ops, replay, merge,
// undo, moves, old-reader tolerance. Synthetic data only.
//
//   node tools/test_multicave.js
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'viewer_build', 'libs', 'flexlib.js'));
let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };
function device(dev, who, start) {
  let seq = 0, clock = Date.parse(start || '2026-10-25T10:00:00Z');
  return (op, data) => { seq++; return Object.assign({ id: dev + '.' + seq, dev, seq, t: new Date(clock += 1000).toISOString(), who, op }, data); };
}
const PC = device('pc', 'Cy'), PH = device('phone', 'Ana', '2026-10-25T11:00:00Z');
const rec = o => { const d = Object.assign({}, o); delete d.op; return PC(o.op, d); };
const pid = 'p1';
const FILE = 'Ridge Valley.plt', CODES = ['A', 'B', 'C', 'D', 'S'];
const replay = log => L.replayProject(log, pid);
let n = 0; const uid = () => 'new' + (++n);

// 1) A system: create, rename, add / remove caves, delete; two devices merge
{
  const log = [
    PC('cave.set', { cave: 'c1', name: 'Cave Ridge', sources: [{ file: 'a.plt' }] }),
    PC('cave.set', { cave: 'c2', name: 'Lower Ridge Cave', sources: [{ file: 'b.plt' }] }),
    PC('cave.set', { cave: 'c3', name: 'Little Pit', sources: [{ file: 'c.plt' }] }),
    PC('system.set', { system: 's1', name: 'Ridge System', add: ['c1', 'c2'], created: true }),
  ];
  let S = replay(log);
  let sys = L.liveSystems(S);
  ok('system: made with two caves', sys.length === 1 && sys[0].name === 'Ridge System' && sys[0].caves.join() === 'c1,c2', sys);
  ok('system: systemsOf', L.systemsOf(S, 'c2').length === 1 && L.systemsOf(S, 'c3').length === 0);
  const a = PC('system.set', { system: 's1', add: ['c3'] }), b = PH('system.set', { system: 's1', remove: ['c1'] });
  S = replay(log.concat([a, b]));
  ok('system: two devices\' changes both count', L.liveSystems(S)[0].caves.join() === 'c2,c3', L.liveSystems(S));
  ok('system: replay order independent of arrival', replay([b, a].concat(log)).systems.s1.caves.length === 2);
  S = replay(log.concat([PC('system.set', { system: 's1', name: 'Ridge group', prevName: 'Ridge System' })]));
  ok('system: renamed', L.liveSystems(S)[0].name === 'Ridge group');
  S = replay(log.concat([PC('cave.set', { cave: 'c2', removed: true })]));
  ok('system: a removed cave drops out of it', L.liveSystems(S)[0].caves.join() === 'c1');
  S = replay(log.concat([PC('system.set', { system: 's1', removed: true })]));
  ok('system: deleted, hidden', L.liveSystems(S).length === 0 && S.systems.s1.removed === true);
  // undo entries
  const mk = (op, d) => Object.assign({ id: 'x' + Math.random(), op }, d);
  const e1 = mk('system.set', { system: 's1', created: true, name: 'X', add: ['c1'] });
  ok('system undo: creation removes it', L.systemUndo(e1).removed === true);
  const e2 = mk('system.set', { system: 's1', removed: true });
  ok('system undo: delete brings it back', L.systemUndo(e2).removed === false);
  const e3 = mk('system.set', { system: 's1', add: ['c3'] }), e4 = mk('system.set', { system: 's1', remove: ['c1'] });
  ok('system undo: add <-> remove', L.systemUndo(e3).remove[0] === 'c3' && L.systemUndo(e4).add[0] === 'c1');
  const ren = PC('system.set', { system: 's1', name: 'New', prevName: 'Ridge System' });
  const un = PC('system.set', L.systemUndo(ren) ? Object.assign({}, L.systemUndo(ren), { op: undefined }) : {});
  un.op = 'system.set';
  const undone = replay(log.concat([ren, un]));
  ok('system undo: rename goes back', L.liveSystems(undone)[0].name === 'Ridge System', L.liveSystems(undone));
  ok('system undo: nothing to undo → null', L.systemUndo(mk('cave.set', {})) === null && L.systemUndo(mk('system.set', { system: 's1', desc: 'x' })) === null);
  // totals
  const stats = { c1: { len: 1200.5, depth: 80, lo: 1400, hi: 1480 }, c2: { len: 800, depth: 120, lo: 1350, hi: 1470 }, c3: null };
  const T = L.systemTotals({ caves: ['c1', 'c2', 'c3'] }, id => stats[id]);
  ok('system totals: length adds up, depth spans the extremes', Math.abs(T.len - 2000.5) < 1e-9 && T.depth === 130 && T.caves === 3 && T.loaded === 2, T);
  ok('system totals: no heights → deepest cave', L.systemTotals({ caves: ['a', 'b'] }, id => ({ a: { len: 5, depth: 3 }, b: { len: 5, depth: 9 } })[id]).depth === 9);
}

// 2) A multi-cave survey file: groups, plan, replay, re-plan
{
  const base = [
    PC('cavefile.set', { file: FILE, h: 'a'.repeat(64), ext: 'plt', place: { mode: 'anchor', station: 'A1', lat: 45.1234, lon: -100.5678, elev: 1000 } }),
    PC('cave.set', { cave: 'k1', name: 'Whole', sources: [{ file: FILE }] }),
    PC('cave.alias', { cave: 'k1', alias: FILE }),
  ];
  let S = replay(base);
  let g = L.fileGroups(S, FILE, CODES);
  ok('groups: a one-cave file holds every survey', !g.multi && g.caves.length === 1 && g.caves[0].surveys.length === 5 && !g.unsorted.length, g);
  const plan = L.planMulti(S, FILE, CODES, { A: { cave: 'k1' }, B: { cave: 'k1' }, C: { name: 'Lower Ridge Cave' }, D: { name: 'Lower Ridge Cave' }, S: 'surface' }, uid);
  const ops = plan.ops;
  ok('plan: marks the file multi-cave and surface', ops[0].op === 'cavefile.set' && ops[0].multi === true && ops[0].surfaceAdd.join() === 'S', ops[0]);
  const created = ops.find(o => o.op === 'cave.set' && o.created);
  ok('plan: a new cave is created with its surveys', created && created.name === 'Lower Ridge Cave' && created.sources[0].surveys.join() === 'C,D', created);
  const old = ops.find(o => o.cave === 'k1');
  ok('plan: the old cave narrows to its surveys and remembers what it was', old.sources[0].surveys.join() === 'A,B' && old.prevSources[0].surveys === undefined, old);
  ok('plan: the file-name alias is dropped', ops.some(o => o.op === 'cave.unalias' && o.alias === FILE));
  S = replay(base.concat(ops.map(rec)));
  g = L.fileGroups(S, FILE, CODES);
  ok('groups after: multi, two caves, surface', g.multi && g.caves.length === 2 && g.surface.join() === 'S' && g.unsorted.length === 0, g);
  ok('groups after: surveys by cave', g.caves.find(c => c.id === 'k1').surveys.join() === 'A,B' && g.caves.find(c => c.id !== 'k1').surveys.join() === 'C,D');
  ok('alias gone, name no longer picks a cave', L.caveForName(S, FILE) === null);
  // unassigned → Surface / not yet sorted
  const p2 = L.planMulti(S, FILE, CODES, { A: { cave: 'k1' }, B: 'unsorted', C: { cave: 'new1' }, D: { cave: 'new1' }, S: 'surface' }, uid);
  S = replay(base.concat(ops.map(rec)).concat(p2.ops.map(rec)));
  g = L.fileGroups(S, FILE, CODES);
  ok('unsorted: a survey with no cave shows as not yet sorted', g.unsorted.join() === 'B', g);
  ok('re-plan with no change adds nothing', L.planMulti(S, FILE, CODES, { A: { cave: 'k1' }, B: 'unsorted', C: { cave: 'new1' }, D: { cave: 'new1' }, S: 'surface' }, uid).ops.length === 0);
  // surface traverse un-marked
  const p3 = L.planMulti(S, FILE, CODES, { A: { cave: 'k1' }, B: 'unsorted', C: { cave: 'new1' }, D: { cave: 'new1' }, S: 'unsorted' }, uid);
  ok('plan: un-marking a surface survey', p3.ops.length === 1 && p3.ops[0].surfaceDel.join() === 'S', p3.ops);
  const S3 = replay(base.concat(ops.concat(p2.ops, p3.ops).map(rec)));
  ok('surface: back to unsorted after un-mark', L.fileGroups(S3, FILE, CODES).unsorted.join() === 'B,S' && !S3.cavefiles[FILE].surface.length);
  // undo
  const undoCave = L.multiUndo({ op: 'cave.set', cave: 'k1', sources: [], prevSources: [{ file: FILE }] });
  ok('undo: cave sources go back', undoCave.sources[0].file === FILE);
  ok('undo: a made cave is removed', L.multiUndo({ op: 'cave.set', cave: 'new1', created: true }).removed === true);
  const uf = L.multiUndo({ op: 'cavefile.set', file: FILE, multi: true, surfaceAdd: ['S'] });
  ok('undo: multi flag and surface marks swap', uf.multi === false && uf.surfaceDel[0] === 'S');
  ok('undo: placing a file is not undone here', L.multiUndo({ op: 'cavefile.set', file: FILE, place: {} }) === null);
  // moving: refused by the bundle for a multi-cave file, even when one cave is left
  const B1 = L.caveBundle(S, null, 'k1');
  ok('move: a cave of a multi-cave file reports the file as shared', B1.shared.includes(FILE), B1.shared);
  const Sone = replay(base.concat(ops.map(rec), [PC('cave.set', { cave: 'new1', removed: true })]));
  ok('move: still shared when only one cave is left', L.caveBundle(Sone, null, 'k1').shared.includes(FILE));
  ok('move: a plain file is not shared', L.caveBundle(replay(base), null, 'k1').shared.length === 0);
  // clearing a moved cave leaves its systems
  const withSys = replay(base.concat([PC('system.set', { system: 's9', name: 'Sys', add: ['k1'] })]));
  const clear = L.caveMoveClear(L.caveBundle(withSys, null, 'k1'), withSys);
  ok('move: the cave leaves its system', clear.some(o => o.op === 'system.set' && o.remove[0] === 'k1'));
}

// 3) Entrances: several per cave, fitting the file
{
  const t = (cid, station, lon, lat, extra) => Object.assign({ cid, station, at: [lon, lat], cave: cid }, extra);
  const tags = [t('k1', 'A9', -100.5, 45.2), t('k1', 'A1', -100.6, 45.1, { placedHere: true }), t('k2', 'C3', -100.7, 45.3, { z: 1234 })];
  const e = L.entrancesOf(tags, 'k1');
  ok('entrances: the placed one is the main one, the rest follow', e.length === 2 && e[0].station === 'A1' && e[0].main && !e[1].main, e);
  ok('entrances: none for a cave without markers', L.entrancesOf(tags, 'zz').length === 0);
  const fit = L.entranceFit(e.concat(L.entrancesOf(tags, 'k2')), new Set(['A1', 'A9', 'C3']));
  ok('fit: main places, the others become pins', fit.main.station === 'A1' && fit.pins.length === 2 && fit.pins[1].elev === 1234 && fit.pins[0].station === 'A9', fit);
  ok('fit: a marker on no station of the file is left out', L.entranceFit(e, new Set(['A1'])).pins.length === 0);
  ok('fit: same station twice is one pin', L.entranceFit([t('k1', 'A1', 1, 2), t('k1', 'A9', 3, 4), t('k2', 'A9', 5, 6)], null).pins.length === 1);
  ok('fit: no markers, no fit', L.entranceFit([], null) === null);
}

// 4) Old readers: unknown ops and fields change nothing else
{
  const log = [PC('cave.set', { cave: 'c1', name: 'Cave Ridge', sources: [{ file: FILE, surveys: ['A'] }] }), PC('cavefile.set', { file: FILE, h: 'b'.repeat(64), multi: true, surfaceAdd: ['S'] }), PC('system.set', { system: 's', name: 'Sys', add: ['c1'] })];
  const S = replay(log);
  const strip = JSON.parse(JSON.stringify(log.filter(e => e.op !== 'system.set')));
  strip.forEach(e => { delete e.multi; delete e.surfaceAdd; });
  const Sold = replay(strip);
  ok('old reader: same caves and files without the new fields', JSON.stringify(Object.keys(S.caves)) === JSON.stringify(Object.keys(Sold.caves)) && S.cavefiles[FILE].h === Sold.cavefiles[FILE].h);
  ok('old reader: a system op alone adds no caves, notes or files', Object.keys(replay([PC('system.set', { system: 's', name: 'Sys' })]).caves).length === 0);
  ok('system.set without an id is ignored', Object.keys(replay([PC('system.set', { name: 'x' })]).systems).length === 0);
  ok('a replayed project without systems has an empty systems map', Object.keys(replay([]).systems).length === 0);
  ok('exports present', ['liveSystems', 'systemTotals', 'fileGroups', 'planMulti', 'entranceFit'].every(k => typeof L[k] === 'function'));
}

// Split a cave into its own file (project-workspace splitCave): the records it writes, replayed and undone
{
  const base = [PC('cavefile.set', { file: FILE, h: 'h1', ext: 'plt', place: { mode: 'anchor', station: 'A1' }, removed: false }),
    PC('cave.set', { cave: 'c1', name: 'Cave Ridge', sources: [{ file: FILE, surveys: ['A', 'B'] }] }),
    PC('cave.set', { cave: 'c2', name: 'Lower Ridge Cave', sources: [{ file: FILE, surveys: ['C', 'D'] }] }), PC('cavefile.set', { file: FILE, multi: true })];
  const prev = JSON.parse(JSON.stringify(replay(base).caves.c2.sources));
  const NEW = 'Lower Ridge Cave.plt';
  const log = base.concat([PC('cavefile.set', { file: NEW, h: 'h2', ext: 'plt', place: { mode: 'anchor', station: 'A1' }, removed: false, split: FILE }),
    PC('cave.set', { cave: 'c2', sources: [{ file: NEW }], prevSources: prev })]);
  const S = replay(log), g = L.fileGroups(S, FILE, CODES);
  ok('split: the cave points at the new file, same placement, parent untouched', JSON.stringify(S.caves.c2.sources) === JSON.stringify([{ file: NEW }]) && S.cavefiles[NEW].h === 'h2' && S.cavefiles[FILE].h === 'h1' && JSON.stringify(S.cavefiles[NEW].place) === JSON.stringify(S.cavefiles[FILE].place));
  ok('split: the parent keeps one cave, the split surveys read as not yet sorted', g.caves.length === 1 && g.caves[0].name === 'Cave Ridge' && g.unsorted.join() === 'C,D,S', g);
  const eu = L.multiUndo(log[log.length - 1]);
  ok('split: undo of the cave record puts its surveys back', eu && JSON.stringify(eu.sources) === JSON.stringify(prev), eu);
  ok('split: the new file alone holds the cave', L.fileGroups(S, NEW, ['C', 'D']).caves.map(c => c.name).join() === 'Lower Ridge Cave');
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
