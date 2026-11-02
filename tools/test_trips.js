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

// 5) Suggested links
{
  const A = device('pcA', 'Ana');
  const noon = d => Date.parse(d + 'T12:00:00');          // local noon: the device’s own day
  const log = base(A).concat([
    A('segment.set', { seg: 'g1', cave: cid, name: 'Seg in', date: '2026-10-11', shots: [['A1', 'A2']] }),
    A('segment.set', { seg: 'g2', cave: cid, name: 'Seg out', date: '2026-10-20', shots: [['A2', 'A3']] }),
    A('segment.set', { seg: 'g3', cave: cid2, name: 'Seg other cave', date: '2026-10-11', shots: [['B1', 'B2']] }),
    A('segment.set', { seg: 'g4', cave: cid, name: 'Seg year only', date: '2026', shots: [['A3', 'A4']] }),
    A('segment.set', { seg: 'g5', cave: cid, name: 'Seg first day', date: '2026-10-10', shots: [['A4', 'A5']] }),
    A('note.set', { note: 'n1', target: L.T.cave(cid), text: 'In range', prev: null }, noon('2026-10-12')),
    A('note.set', { note: 'n2', target: L.T.cave(cid), text: 'Out of range', prev: null }, noon('2026-10-25')),
    A('note.set', { note: 'n3', target: L.T.station(cid2, 'B1'), text: 'Other cave', prev: null }, noon('2026-10-11')),
    A('note.set', { note: 'n4', target: L.T.project(pid), text: 'Project-level, in range', prev: null }, noon('2026-10-11')),
  ]);
  const docs = [
    A('doc.add', { doc: 'd1', title: 'Photo in', kind: 'photo', date: '2026-10-11', tags: [L.T.cave(cid)], pages: [{ h: 'a'.repeat(64), ext: 'jpg' }] }),
    A('doc.add', { doc: 'd2', title: 'Photo other cave', kind: 'photo', date: '2026-10-11', tags: [L.T.cave(cid2)], pages: [{ h: 'b'.repeat(64), ext: 'jpg' }] }),
    A('doc.add', { doc: 'd3', title: 'Photo out', kind: 'photo', date: '2026-11-01', tags: [L.T.cave(cid)], pages: [{ h: 'c'.repeat(64), ext: 'jpg' }] }),
    A('doc.add', { doc: 'd4', title: 'Photo in, project only', kind: 'photo', date: '2026-10-12', tags: [L.T.project(pid)], pages: [{ h: 'd'.repeat(64), ext: 'jpg' }] }),
    A('doc.add', { doc: 'd5', title: 'No date', kind: 'photo', tags: [L.T.cave(cid)], pages: [{ h: 'e'.repeat(64), ext: 'jpg' }] }),
  ];
  const trip = make(A, 't1', null, { name: 'Ridge weekend', start: '2026-10-10', end: '2026-10-12', caves: [cid] });
  const S = L.replayProject(log.concat([trip]), pid), D = L.replayDocs(docs);
  const sg = L.tripSuggest(S, D, S.trips.t1);
  ok('suggest: segments in the days and the visited cave', sg.segments.map(g => g.id).sort().join() === 'g1,g5', sg.segments.map(g => g.id));
  ok('suggest: notes in the days, visited cave (or none)', sg.notes.map(n => n.id).sort().join() === 'n1,n4', sg.notes.map(n => n.id));
  ok('suggest: documents by date and cave (or none)', sg.docs.map(d => d.id).sort().join() === 'd1,d4', sg.docs.map(d => d.id));
  const linked = L.replayProject(log.concat([trip, make(A, 't1', S.trips.t1, { links: ['segment:g1', 'doc:d1'] })]), pid);
  const sg2 = L.tripSuggest(linked, D, linked.trips.t1);
  ok('suggest: what is linked is not suggested again', sg2.segments.map(g => g.id).join() === 'g5' && sg2.docs.map(d => d.id).join() === 'd4');
  ok('suggest: a trip without a date suggests nothing', L.tripSuggest(S, D, { start: '', end: '', caves: [cid], links: [] }).segments.length === 0);
  ok('suggest: a one-day trip', L.tripSuggest(S, D, { start: '2026-10-11', end: '', caves: [cid], links: [] }).segments.map(g => g.id).join() === 'g1');
  ok('tripsFor: by cave and by link', L.tripsFor(linked, { cave: cid }).length === 1 && L.tripsFor(linked, { cave: cid2 }).length === 0 && L.tripsFor(linked, { link: 'segment:g1' }).length === 1);
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
