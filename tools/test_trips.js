// Tests of trips in viewer_build/libs/flexlib.js (trip.set): replay, edits,
// two devices, removal, undo, suggested links, and old readers. Synthetic data only.
//
//   node tools/test_trips.js
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'viewer_build', 'libs', 'flexlib.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };
function device(dev, who) {
  let seq = 0, clock = Date.parse('2026-10-25T10:00:00Z');
  return (op, data, at) => {
    seq++;
    const t = new Date(at != null ? at : (clock += 1000)).toISOString();
    return Object.assign({ id: dev + '.' + seq, dev, seq, t, who, op }, data);
  };
}
const pid = 'proj1', cid = 'cave1', cid2 = 'cave2';
const base = (D) => [
  D('cave.set', { cave: cid, name: 'Cave Ridge' }),
  D('cave.set', { cave: cid2, name: 'Little Pit' }),
];
const names = S => L.tripsOf(S).map(t => t.name).join('|');
// Build the entry a host would record for a new / edited trip.
const make = (D, id, cur, next, extra) => D('trip.set', Object.assign({ trip: id }, L.tripEdit(cur, next), extra || {}));

// 1) Create, read, list order
{
  const A = device('pcA', 'Ana');
  const e1 = make(A, 't1', null, { name: 'Ridge weekend', start: '2026-10-10', end: '2026-10-12', people: ['A. Tester', 'B. Tester'], caves: [cid], links: ['segment:g1'] });
  const e2 = make(A, 't2', null, { name: 'Pit day', start: '2026-10-20', caves: [cid2] });
  let S = L.replayProject(base(A).concat([e1, e2]), pid);
  const t = S.trips.t1;
  ok('trip: fields', t.name === 'Ridge weekend' && t.start === '2026-10-10' && t.end === '2026-10-12' && t.people.join() === 'A. Tester,B. Tester' && t.caves.join() === cid && t.links.join() === 'segment:g1', t);
  ok('trip: one-day trip has no end', S.trips.t2.end === '' && JSON.stringify(L.tripDays(S.trips.t2)) === '["2026-10-20","2026-10-20"]');
  ok('trip: newest first', names(S) === 'Pit day|Ridge weekend');
  ok('trip: created entry has prev null', e1.prev === null);
  ok('trip: history per trip', t.history.length === 1 && t.history[0] === e1.id);
  // an edit changes only what changed
  const e3 = make(A, 't1', t, { name: 'Ridge weekend', start: '2026-10-10', end: '2026-10-13', people: ['A. Tester'], caves: [cid, cid2], links: ['segment:g1', 'note:n1'] });
  ok('edit: only changed fields, deltas for lists', e3.end === '2026-10-13' && e3.name === undefined && e3.add.caves.join() === cid2 && e3.add.links.join() === 'note:n1' && e3.drop.people.join() === 'B. Tester' && e3.prev.end === '2026-10-12', e3);
  S = L.replayProject(base(A).concat([e1, e2, e3]), pid);
  ok('edit: replayed', S.trips.t1.end === '2026-10-13' && S.trips.t1.people.join() === 'A. Tester' && S.trips.t1.caves.length === 2 && S.trips.t1.links.length === 2);
  ok('edit: no change, no entry', L.tripEdit(S.trips.t1, { name: 'Ridge weekend', people: ['A. Tester'] }) === null);
  // clearing the end makes it a one-day trip again
  const e4 = make(A, 't1', S.trips.t1, { end: '' });
  S = L.replayProject(base(A).concat([e1, e2, e3, e4]), pid);
  ok('edit: end cleared', S.trips.t1.end === '' && e4.prev.end === '2026-10-13');
}

// 2) Two devices
{
  const A = device('pcA', 'Ana'), B = device('pcB', 'Bo');
  const e1 = make(A, 't1', null, { name: 'Ridge trip', start: '2026-10-10', people: ['A. Tester'], caves: [cid] });
  const S0 = L.replayProject([e1], pid);
  // Both start from e1: A adds a person, B adds another person and a cave, and renames.
  const a2 = make(A, 't1', S0.trips.t1, { people: ['A. Tester', 'C. Tester'] }, { base: [e1.id] });
  const b2 = make(B, 't1', S0.trips.t1, { name: 'Ridge trip (long)', people: ['A. Tester', 'D. Tester'], caves: [cid, cid2] }, { base: [e1.id] });
  const m = L.replayProject([e1, a2, b2], pid).trips.t1;
  ok('merge: people from both devices kept', m.people.slice().sort().join() === 'A. Tester,C. Tester,D. Tester', m.people);
  ok('merge: other device’s rename and cave kept', m.name === 'Ridge trip (long)' && m.caves.length === 2, m);
  const m2 = L.replayProject([b2, a2, e1], pid).trips.t1;
  ok('merge: same whichever log is read first', JSON.stringify(m) === JSON.stringify(m2));
  // same entry twice counts once
  ok('merge: duplicate entry counts once', L.replayProject([e1, e1, a2, a2], pid).trips.t1.people.length === 2);
  // two renames: the later wins
  const r1 = A('trip.set', { trip: 't1', name: 'Name A' }, Date.parse('2026-10-26T12:00:00Z'));
  const r2 = B('trip.set', { trip: 't1', name: 'Name B' }, Date.parse('2026-10-26T12:00:05Z'));
  ok('merge: two renames, the later wins', L.replayProject([e1, r2, r1], pid).trips.t1.name === 'Name B' && L.replayProject([e1, r1, r2], pid).trips.t1.name === 'Name B');
  // one drops a person while the other renames: both count
  const d1 = make(A, 't1', S0.trips.t1, { people: [] }, { base: [e1.id] });
  const mm = L.replayProject([e1, d1, r2], pid).trips.t1;
  ok('merge: a removed person and a rename on the other device', mm.people.length === 0 && mm.name === 'Name B', mm);
}

// 3) Removal and undo
{
  const A = device('pcA', 'Ana');
  const e1 = make(A, 't1', null, { name: 'Ridge trip', start: '2026-10-10', end: '2026-10-11', people: ['A. Tester'], caves: [cid], links: ['doc:d1'] });
  let S = L.replayProject([e1], pid);
  const rm = make(A, 't1', S.trips.t1, { removed: true });
  S = L.replayProject([e1, rm], pid);
  ok('remove: not listed, still there with removed', L.tripsOf(S).length === 0 && S.trips.t1.removed && L.tripsOf(S, { removed: true }).length === 1);
  const un = Object.assign(A('x', {}), L.tripUndo(rm));
  S = L.replayProject([e1, rm, un], pid);
  ok('undo of a removal brings it back with everything', L.tripsOf(S).length === 1 && S.trips.t1.people.join() === 'A. Tester' && S.trips.t1.links.join() === 'doc:d1', S.trips.t1);
  // undo an edit: fields back, added dropped, dropped added
  const ed = make(A, 't1', L.replayProject([e1], pid).trips.t1, { name: 'New name', end: '', people: ['B. Tester'], links: ['doc:d1', 'note:n1'] });
  S = L.replayProject([e1, ed], pid);
  ok('edit applied', S.trips.t1.name === 'New name' && S.trips.t1.people.join() === 'B. Tester' && S.trips.t1.end === '');
  const un2 = Object.assign(A('x', {}), L.tripUndo(ed));
  S = L.replayProject([e1, ed, un2], pid);
  const t = S.trips.t1;
  ok('undo of an edit puts it back', t.name === 'Ridge trip' && t.end === '2026-10-11' && t.people.join() === 'A. Tester' && t.links.join() === 'doc:d1', t);
  // undo of creating removes the trip from the list
  const un3 = Object.assign(A('x', {}), L.tripUndo(e1));
  S = L.replayProject([e1, un3], pid);
  ok('undo of adding a trip removes it', L.tripsOf(S).length === 0);
  ok('undo: an entry without prev has none', L.tripUndo(A('trip.set', { trip: 't1', name: 'x' })) === null && L.tripUndo(A('note.set', {})) === null);
  // undoing the undo (redo) works from the undo's own prev
  const re = Object.assign(A('x', {}), L.tripUndo(un3));
  ok('undo of the undo (redo) brings it back', L.tripsOf(L.replayProject([e1, un3, re], pid)).length === 1);
  // a removed trip edited again is live again
  const back = make(A, 't1', L.replayProject([e1, rm], pid).trips.t1, { name: 'Revived' });
  ok('editing a removed trip brings it back', L.tripsOf(L.replayProject([e1, rm, back], pid)).map(x => x.name).join() === 'Revived');
}

// 4) Old readers and bad entries
{
  const A = device('pcA', 'Ana');
  const e1 = make(A, 't1', null, { name: 'Ridge trip', start: '2026-10-10' });
  const S = L.replayProject(base(A).concat([e1, A('trip.frobnicate', { trip: 't1' }), A('trip.set', { name: 'no id' })]), pid);
  ok('unknown trip op and a trip.set without id change nothing', Object.keys(S.trips).join() === 't1' && S.trips.t1.name === 'Ridge trip');
  // A reader that has no trip.set at all: simulate by renaming the op; nothing else in the project changes.
  const plain = L.replayProject(base(A).concat([Object.assign({}, e1, { op: 'trip.set2' })]), pid);
  ok('a reader that does not know the op: caves and the rest are as before', L.liveCaves(plain).length === 2 && Object.keys(plain.trips).length === 0);
  ok('projects without trips have none', Object.keys(L.replayProject(base(A), pid).trips).length === 0);
  // sync: trip entries are project entries and travel
  const sel = L.selectForSync([e1], [], L.replayProject([e1], pid), L.replayDocs([]), {}, 'all');
  ok('sync file carries trip entries', sel.entries[L.projScope(pid)].some(e => e.op === 'trip.set') && sel.count === 1);
}

// 5) Trips suggested from survey dates (tripGroups) and moves (tripMoves)
{
  const A = device('pcA', 'Ana');
  const seg = (id, date, c) => A('segment.set', { seg: id, cave: c || cid, name: 'Seg ' + id, date, shots: [[id + '1', id + '2']] });
  const doc = (id, date) => A('doc.add', { doc: id, title: 'Doc ' + id, kind: 'photo', date, tags: [L.T.project(pid)], pages: [{ h: id.charCodeAt(1).toString(16).padStart(2, '0').repeat(32), ext: 'jpg' }] });
  const log = base(A).concat([
    seg('g1', '2026-10-12'), seg('g2', '2026-10-12', cid2), seg('g3', '2026-10-13'),      // same day, next day: one trip
    seg('g4', '2026-10-15'),                                                              // a gap of one day: its own
    seg('g5', '2026-10-20'), seg('g6', '2026'),                                           // g6: no full date
  ]);
  const docs = [doc('d1', '2026-10-13'), doc('d2', '2026-10-14'), doc('d3', '2026-11-01'), doc('d4', '')];
  const S = L.replayProject(log, pid), D = L.replayDocs(docs);
  let G = L.tripGroups(S, D);
  const ids = g => g.segments.map(x => x.id).sort().join();
  const sug = G.groups.filter(g => g.suggested);
  ok('groups: same and consecutive days form one trip, a gap starts another', sug.map(ids).join('|') === 'g1,g2,g3|g4|g5', sug.map(ids));
  ok('groups: dates of a suggested trip', sug[0].start === '2026-10-12' && sug[0].end === '2026-10-13' && sug[1].end === '' && sug[0].id === 'sug:2026-10-12', sug[0]);
  ok('groups: documents dated inside the days join', sug[0].docs.map(d => d.id).join() === 'd1' && sug.every(g => !g.docs.some(d => d.id === 'd3' || d.id === 'd4')), sug.map(g => g.docs.map(d => d.id)));
  ok('groups: a survey without a full date is in no trip', !G.by.has('segment:g6') && G.by.get('segment:g3') === sug[0]);
  ok('groups: nothing without surveys', L.tripGroups(L.replayProject(base(A), pid), D).groups.length === 0);
  // trip records win over suggestions
  const t1 = make(A, 't1', null, { name: 'Ridge weekend', start: '2026-10-12', end: '2026-10-13', links: ['segment:g1', 'doc:d2'] });
  const S1 = L.replayProject(log.concat([t1]), pid);
  G = L.tripGroups(S1, D);
  ok('records: linked items belong to the record', G.by.get('segment:g1').id === 't1' && !G.by.get('segment:g1').suggested && G.by.get('doc:d2').id === 't1');
  ok('records: the rest still suggested (g2, g3 together)', G.by.get('segment:g2') === G.by.get('segment:g3') && G.by.get('segment:g2').suggested && ids(G.by.get('segment:g2')) === 'g2,g3');
  // move g2 into the record; g3 stays suggested alone
  let mv = L.tripMoves(S1, D, 'segment:g2', { trip: 't1' });
  ok('move: into a record adds the link only', mv.length === 1 && mv[0].trip === 't1' && mv[0].body.add.links.join() === 'segment:g2' && mv[0].body.prev, mv);
  const S2 = L.replayProject(log.concat([t1, A('trip.set', Object.assign({ trip: 't1' }, mv[0].body))]), pid);
  ok('move: replayed', S2.trips.t1.links.includes('segment:g2') && L.tripGroups(S2, D).by.get('segment:g2').id === 't1');
  // not part of a trip
  mv = L.tripMoves(S2, D, 'segment:g1', { none: true });
  ok('move: none drops the link and marks it', mv.length === 2 && mv.some(m => m.trip === 't1' && m.body.drop.links.join() === 'segment:g1') && mv.some(m => m.trip === L.TRIP_NONE && m.body.add.links.join() === 'segment:g1'), mv);
  const S3 = L.replayProject(log.concat([t1, A('trip.set', { trip: 't1', add: { links: ['segment:g2'] } })], mv.map(m => A('trip.set', Object.assign({ trip: m.trip }, m.body)))), pid);
  const G3 = L.tripGroups(S3, D);
  ok('none: the survey is in no trip and the marker is not listed', !G3.by.has('segment:g1') && L.tripsOf(S3).map(t => t.id).join() === 't1', L.tripsOf(S3).map(t => t.id));
  // a new trip
  mv = L.tripMoves(S3, D, 'segment:g5', { create: { name: '', start: '2026-10-20', end: '2026-10-20', people: ['A. Tester'] } });
  ok('move: a new trip (name optional, one day has no end)', mv.length === 1 && mv[0].body.start === '2026-10-20' && !mv[0].body.end && mv[0].body.add.links.join() === 'segment:g5' && mv[0].body.add.people.join() === 'A. Tester', mv);
  // picking a suggested trip makes it real, with everything in it
  mv = L.tripMoves(S, D, 'segment:g4', { trip: 'sug:2026-10-12' });
  ok('move: into a suggested trip makes it a record with all its items', mv.length === 1 && mv[0].body.add.links.slice().sort().join() === 'doc:d1,segment:g1,segment:g2,segment:g3,segment:g4', mv);
  // undo of a move puts it back
  const mvE = A('trip.set', Object.assign({ trip: 't1' }, L.tripMoves(S1, D, 'segment:g2', { trip: 't1' })[0].body));
  const un = Object.assign(A('x', {}), L.tripUndo(mvE));
  ok('move: undo', !L.replayProject(log.concat([t1, mvE, un]), pid).trips.t1.links.includes('segment:g2'));
  ok('tripsFor: by link', L.tripsFor(S1, { link: 'segment:g1' }).length === 1 && L.tripsFor(S1, { cave: cid }).length === 0);
}

// 6) Old planned-trip records: read, ignored, never an error
{
  const A = device('pcA', 'Ana');
  const old = A('trip.set', { trip: 'p1', name: 'Next ridge trip', start: '2026-12-05', end: '2026-12-06', planned: true,
    add: { people: ['A. Tester'], caves: [cid], leads: ['lead1'], links: ['segment:g1'] }, drop: { leads: ['lead0'] },
    obj: { a: { text: 'Push the north lead', done: true }, b: null, c: { text: 'x', weird: 1 } }, prev: null });
  let S, threw = null;
  try { S = L.replayProject(base(A).concat([old]), pid); } catch (e) { threw = e; }
  ok('old planned record replays without error', !threw && !!S, String(threw));
  const t = S && S.trips.p1;
  ok('old planned record: plain fields exact, planned / objectives / leads ignored', t && t.name === 'Next ridge trip' && t.start === '2026-12-05' && t.end === '2026-12-06' && t.people.join() === 'A. Tester' && t.caves.join() === cid && t.links.join() === 'segment:g1' && !t.planned && !t.objectives && !t.leads, t);
  ok('old planned record: listed as an ordinary trip', L.tripsOf(S).map(x => x.name).join() === 'Next ridge trip');
  ok('the removed planned helpers are gone', L.tripsPlanned === undefined && L.tripsPast === undefined && L.tripSuggest === undefined);
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
