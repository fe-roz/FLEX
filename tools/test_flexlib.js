// Tests of viewer_build/libs/flexlib.js — the project library shared by the
// viewer / FLEX Field and desktop FLEX: replay, conflicts, documents, sync
// selection and merging, the field-survey reduction, suggested caves.
// Synthetic data only.
//
//   node tools/test_flexlib.js
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'viewer_build', 'libs', 'flexlib.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// A tiny log writer per device, as the hosts do it.
function device(dev, who) {
  let seq = 0, clock = Date.parse('2026-10-25T10:00:00Z');
  return (op, data, at) => {
    seq++;
    const t = new Date(at != null ? at : (clock += 1000)).toISOString();
    return Object.assign({ id: dev + '.' + seq, dev, seq, t, who, op }, data);
  };
}
const A = device('phoneA', 'Ana'), B = device('phoneB', 'Bo'), PC = device('pc', 'Cy');
const pid = 'proj1', cid = 'cave1', cid2 = 'cave2';

// 1) Project, caves, aliases
{
  const log = [
    PC('project.set', { name: 'Cave Ridge area' }),
    PC('cave.set', { cave: cid, name: 'Cave Ridge', sources: [{ file: 'CaveRidge-V1.plt' }] }),
    PC('cave.alias', { cave: cid, alias: 'CaveRidge-V1.plt' }),
    PC('cave.set', { cave: cid2, name: 'Little Pit' }),
    PC('cave.alias', { cave: cid, alias: 'CaveRidge-V2.plt' }),
    PC('project.lists', { add: { types: ['Needs SCUBA'] } }),
  ];
  const S = L.replayProject(log, pid);
  ok('project name', S.name === 'Cave Ridge area');
  ok('two caves', L.liveCaves(S).length === 2);
  ok('alias → cave', L.caveForName(S, 'CaveRidge-V2.plt') === cid);
  ok('name → cave (case-insensitive)', L.caveForName(S, 'little pit') === cid2);
  ok('unknown → null', L.caveForName(S, 'Other') === null);
  const lists = L.leadLists(S);
  ok('lead types extended per project', lists.types.some(x => x[0] === 'Needs SCUBA') && lists.types.some(x => x[0] === 'Bedrock dig'));
  ok('same entry merged twice counts once', L.replayProject(log.concat(log), pid).log.length === log.length);
}

// 2) Notes: edits, a conflict, its resolution
{
  const st = L.T.station(cid, 'A3');
  const n1 = A('note.set', { note: 'n1', target: st, text: 'Drips here' });
  const n2 = A('note.set', { note: 'n1', text: 'Drips here, cold air', base: [n1.id] });
  let S = L.replayProject([n1, n2], pid);
  ok('note edited', S.notes.n1.text === 'Drips here, cold air' && S.notes.n1.target === st && !S.notes.n1.conflict);
  ok('notesOn station', L.notesOn(S, st).length === 1);
  // Two phones edit the same note without seeing each other.
  const b1 = B('note.set', { note: 'n1', text: 'Drips; mud floor', base: [n2.id] });
  const a3 = A('note.set', { note: 'n1', text: 'Drips; strong air out', base: [n2.id] });
  S = L.replayProject([n1, n2, b1, a3], pid);
  ok('conflict flagged, both kept', S.notes.n1.conflict && S.notes.n1.conflict.length === 2, S.notes.n1);
  ok('…shows the later one meanwhile', S.notes.n1.text === 'Drips; strong air out');
  const fix = PC('note.set', { note: 'n1', text: 'Drips; mud floor; strong air out', base: [b1.id, a3.id] });
  S = L.replayProject([n1, n2, b1, a3, fix], pid);
  ok('saving over both resolves it', !S.notes.n1.conflict && S.notes.n1.text.includes('mud floor'));
  ok('history keeps every version', S.notes.n1.history.length === 5);
  const del = A('note.set', { note: 'n1', text: '', base: [fix.id] });
  S = L.replayProject([n1, n2, b1, a3, fix, del], pid);
  ok('removed note', S.notes.n1.deleted && L.notesOn(S, st).length === 0);
}

// 3) Leads: per-field last writer, conflicts only on the same field
{
  const st = L.T.station(cid, 'B3');
  const l1 = PC('lead.set', { lead: 'L1', target: st, fields: { status: 'open', types: ['Sediment dig'], desc: 'Mud fill, air' }, source: 'breakout' });
  const a = A('lead.set', { lead: 'L1', fields: { status: 'confirmed', air: 'Blowing out' }, base: [l1.id] });
  const b = B('lead.set', { lead: 'L1', fields: { w: 0.4, h: 0.3 }, base: [l1.id] });
  let S = L.replayProject([l1, a, b], pid);
  const ld = S.leads.L1;
  ok('lead fields merged', ld.fields.status === 'confirmed' && ld.fields.w === 0.4 && ld.fields.types[0] === 'Sediment dig', ld);
  ok('different fields: no conflict', !ld.conflicts, ld.conflicts);
  ok('who changed status', ld.fieldBy.status.who === 'Ana');
  ok('created = the first entry, even with a slower clock', ld.created.who === 'Cy');
  const b2 = B('lead.set', { lead: 'L1', fields: { status: 'deadend' }, base: [b.id] });
  S = L.replayProject([l1, a, b, b2], pid);
  ok('confirmed is active', L.leadActive(ld));
  ok('same field both ways: conflict', S.leads.L1.conflicts && S.leads.L1.conflicts.status.length === 2, S.leads.L1);
  const del = A('lead.del', { lead: 'L1', base: [a.id, b2.id] });
  S = L.replayProject([l1, a, b, b2, del], pid);
  ok('lead deleted', S.leads.L1.deleted && L.leadsOn(S, st).length === 0);
  ok('status label', L.statusLabel('deadend') === 'Dead end');
  ok('closed statuses leave the active list', ['surveyed', 'deadend', 'mopped', 'notalead'].every(v => !L.leadActive({ fields: { status: v } }))
     && ['open', 'confirmed', 'unknown', undefined].every(v => L.leadActive({ fields: { status: v } })));
}

// Inventories (inv.set / inv.log / inv.del / inv.restore): contents worked out from a dated log, conflicts, undo,
// list mode, photos, "possibly out of date".
{
  const D1 = device('invA', 'Ana'), D2 = device('invB', 'Bo');
  const st = L.T.station(cid, 'T6'), H = n => String(n).repeat(64).slice(0, 64);
  const mk = (dev, op, data, at) => dev(op, data, at);
  const day = d => Date.parse(d + 'T12:00:00Z');
  const set = mk(D1, 'inv.set', { inv: 'iv1', target: st, fields: { name: 'Rope cache', desc: 'Blue barrel behind the boulder', mode: 'log' }, prev: null });
  const left = mk(D1, 'inv.log', { inv: 'iv1', log: 'e1', date: '2026-01-10', action: 'left', items: [{ name: 'Rope 50 m', qty: 2 }, { name: 'Stove', qty: 1 }], text: 'In the blue barrel', prev: null });
  const took = mk(D2, 'inv.log', { inv: 'iv1', log: 'e2', date: '2026-02-01', by: 'Bo and Cy', action: 'took', items: [{ name: 'rope 50 m', qty: 1 }], prev: null });
  let S = L.replayProject([set, left, took], pid);
  let I = S.inventories.iv1;
  ok('inventory: one, at its target, with name, description, mode', I && I.target === st && I.name === 'Rope cache' && I.desc.startsWith('Blue barrel') && I.mode === 'log' && !I.deleted && !I.orphan, I);
  ok('inventory: listed live, found by target, none elsewhere', L.liveInventories(S).length === 1 && L.invsOn(S, st).length === 1 && L.invsOn(S, L.T.station(cid, 'T7')).length === 0 && L.invsOn(S, L.T.feature('f1')).length === 0);
  ok('inventory: log sorted by date, with who (by, else the author)', I.log.map(e => e.id).join() === 'e1,e2' && I.log[0].created.who === 'Ana' && I.log[1].by === 'Bo and Cy');
  ok('contents: left adds, took subtracts (names match without case), by name', I.contents.map(c => c.name + ' ' + c.qty).join('|') === 'Rope 50 m 1|Stove 1', I.contents);
  ok('contents: last change per item; never checked yet', I.contents[0].changed === '2026-02-01' && I.contents[1].changed === '2026-01-10' && !I.contents[0].checked && I.checked === '', I.contents);
  ok('contents: an empty replay has no inventories', Object.keys(L.replayProject([PC('project.set', { name: 'x' })], pid).inventories).length === 0);

  // checked sets the counts seen; items it does not list are untouched, unless it was a complete count
  const chk = mk(D1, 'inv.log', { inv: 'iv1', log: 'e3', date: '2026-03-02', action: 'checked', items: [{ name: 'Rope 50 m', qty: 3 }, { name: 'Tarp', qty: 1 }], prev: null });
  I = L.replayProject([set, left, took, chk], pid).inventories.iv1;
  ok('checked: sets the counts it lists, adds new items, leaves the others', I.contents.map(c => c.name + ' ' + c.qty).join('|') === 'Rope 50 m 3|Stove 1|Tarp 1', I.contents);
  ok('checked: last-checked date for the item and the inventory; changed only where the number changed', I.contents[0].checked === '2026-03-02' && I.contents[0].changed === '2026-03-02' && !I.contents[1].checked && I.contents[2].checked === '2026-03-02' && I.checked === '2026-03-02', I.contents);
  const chkSame = mk(D1, 'inv.log', { inv: 'iv1', log: 'e3', date: '2026-03-02', action: 'checked', items: [{ name: 'Rope 50 m', qty: 1 }], prev: null });
  I = L.replayProject([set, left, took, chkSame], pid).inventories.iv1;
  ok('checked: the same number is a check, not a change', I.contents[0].qty === 1 && I.contents[0].changed === '2026-02-01' && I.contents[0].checked === '2026-03-02', I.contents[0]);
  const chkAll = mk(D1, 'inv.log', { inv: 'iv1', log: 'e3', date: '2026-03-02', action: 'checked', all: true, items: [{ name: 'Rope 50 m', qty: 1 }], prev: null });
  I = L.replayProject([set, left, took, chkAll], pid).inventories.iv1;
  ok('checked, complete count: what it does not list is gone (kept as gone, with the date)', I.contents.map(c => c.name).join() === 'Rope 50 m' && I.gone.length === 1 && I.gone[0].name === 'Stove' && I.gone[0].checked === '2026-03-02', I);
  const chk0 = mk(D1, 'inv.log', { inv: 'iv1', log: 'e3', date: '2026-03-02', action: 'checked', items: [{ name: 'Stove', qty: 0 }], prev: null });
  I = L.replayProject([set, left, took, chk0], pid).inventories.iv1;
  ok('checked with 0: that item is gone, the rest stays', I.contents.map(c => c.name).join() === 'Rope 50 m' && I.gone[0].name === 'Stove');
  // took more than was recorded: never below zero, the record is flagged short
  const over = mk(D1, 'inv.log', { inv: 'iv1', log: 'e4', date: '2026-04-01', action: 'took', items: [{ name: 'Stove', qty: 3 }, { name: 'Carbide', qty: 1 }], prev: null });
  I = L.replayProject([set, left, took, over], pid).inventories.iv1;
  ok('took more than there was: 0 left and the shortfall noted (not negative)', I.contents.map(c => c.name).join() === 'Rope 50 m' && I.gone.some(g => g.name === 'Stove') && I.gone.some(g => g.name === 'Carbide'), I);
  const short = L.replayProject([set, left, over], pid).inventories.iv1;
  ok('...and its short count is kept for the table', short.gone.length === 2, short.gone);
  // quantities: none means 1, comma decimals, the same item twice in one entry
  ok('quantities: none counts as 1, "2,5" is 2.5, text is 1, 0 stays 0', L.invQty(undefined) === 1 && L.invQty('') === 1 && L.invQty('2,5') === 2.5 && L.invQty('abc') === 1 && L.invQty(0) === 0 && L.invQty('0') === 0 && L.invQty(-3) === 1);
  ok('items: tidied, the same item twice is added up, empty names dropped', JSON.stringify(L.invItems([{ name: '  Rope  50 m ', qty: 2 }, { name: 'rope 50 M', qty: '1' }, { name: '', qty: 4 }, null])) === '[{"name":"Rope 50 m","qty":3}]');

  // a backdated entry slots into its day; the order of reading changes nothing
  const back = mk(D2, 'inv.log', { inv: 'iv1', log: 'e5', date: '2026-01-20', action: 'took', items: [{ name: 'Stove', qty: 1 }], prev: null });
  I = L.replayProject([set, left, took, chk, back], pid).inventories.iv1;
  ok('dates: a late entry for an earlier day is counted at that day (the later check wins)', I.log.map(e => e.id).join() === 'e1,e5,e2,e3' && I.contents.map(c => c.name + ' ' + c.qty).join('|') === 'Rope 50 m 3|Tarp 1', { log: I.log.map(e => e.id), c: I.contents });
  const all = [set, left, took, chk, back, over];
  const shuffled = [over, back, chk, took, left, set];
  ok('replay does not depend on the order entries are read', JSON.stringify(L.replayProject(all, pid).inventories.iv1.contents) === JSON.stringify(L.replayProject(shuffled, pid).inventories.iv1.contents));
  ok('the same entry merged twice counts once', L.replayProject(all.concat(all), pid).inventories.iv1.log.length === 5);

  // dates as typed are tidied; approximate ones stay as written
  ok('dates: 2026-3-2, 2026/03/02 and 2026.3 are tidied; a year or "c. 1975" stay', L.invDate('2026-3-2') === '2026-03-02' && L.invDate(' 2026/03/02 ') === '2026-03-02' && L.invDate('2026.3') === '2026-03' && L.invDate('2019') === '2019' && L.invDate('c. 1975') === 'c. 1975' && L.invDate(null) === ''
    && L.invLogBody('iv1', { date: '2026-3-2', action: 'note', text: 'x' }).date === '2026-03-02' && L.replayProject([set, mk(D1, 'inv.log', { inv: 'iv1', log: 'e5', date: '2026-3-2', action: 'note', text: 'x' })], pid).inventories.iv1.log[0].dk === '2026-03-02');
  // approximate dates sort and show as typed
  const yr = mk(D1, 'inv.log', { inv: 'iv1', log: 'e6', date: '2019', action: 'left', items: [{ name: 'Old ladder', qty: 1 }], prev: null });
  I = L.replayProject([set, yr, left], pid).inventories.iv1;
  ok('dates: a year-only entry sorts first and shows as typed; an entry with no date counts from the day it was recorded', I.log[0].date === '2019' && I.log[1].date === '2026-01-10'
    && L.replayProject([set, mk(D1, 'inv.log', { inv: 'iv1', log: 'e7', action: 'note', text: 'hi' }, day('2026-05-05'))], pid).inventories.iv1.log[0].date === '2026-05-05');

  // possibly out of date: counted long ago, or never counted and left long ago
  const base = L.replayProject([set, left, took, chk], pid).inventories.iv1;
  const m1 = L.invMark(base, { now: day('2026-09-01') }), m2 = L.invMark(base, { now: day('2027-04-01') }), m3 = L.invMark(base, { now: day('2027-04-01'), staleDays: 800 });
  ok('stale: nothing is, within a year of the last count (Stove: left 2026-01-10, never counted)', m1.contents.every(c => !c.stale) && !m1.stale, m1.contents);
  ok('stale: counted items turn stale after the limit, and uncounted ones from the day they were first left', m2.contents.map(c => c.name + ':' + c.stale).join('|') === 'Rope 50 m:true|Stove:true|Tarp:true' && m2.stale, m2.contents);
  ok('stale: the limit can be set; the copy leaves the replayed inventory alone', m3.contents.every(c => !c.stale) && base.contents.every(c => c.stale === (c.age > 365)));
  const mixed = L.invMark(L.replayProject([set, left, chk], pid).inventories.iv1, { now: day('2026-12-01') });
  ok('stale: an item counted recently is fresh next to one never counted and left a year ago', mixed.contents.find(c => c.name === 'Tarp').stale === false && mixed.contents.find(c => c.name === 'Stove').stale === (Math.floor((day('2026-12-01') - Date.UTC(2026, 0, 10)) / 864e5) > 365) && L.invAge('2026-01-10', day('2026-01-20')) === 10 && L.invAge('x', 0) === null);

  // conflicts: inv.set fields per field; a log entry edited twice without seeing the other
  const e2a = mk(D1, 'inv.set', { inv: 'iv1', fields: { name: 'Rope store' }, prev: { name: 'Rope cache' }, base: [set.id] });
  const e2b = mk(D2, 'inv.set', { inv: 'iv1', fields: { desc: 'Under the ledge' }, prev: { desc: 'Blue barrel behind the boulder' }, base: [set.id] });
  I = L.replayProject([set, e2a, e2b], pid).inventories.iv1;
  ok('inv.set: edits of different fields both count, no conflict', I.name === 'Rope store' && I.desc === 'Under the ledge' && !I.conflicts, I.conflicts);
  const e3b = mk(D2, 'inv.set', { inv: 'iv1', fields: { name: 'Rope depot' }, base: [set.id] });
  I = L.replayProject([set, e2a, e3b], pid).inventories.iv1;
  ok('inv.set: the same field changed on two devices is a conflict, both kept', I.conflicts && I.conflicts.name && I.conflicts.name.length === 2 && ['Rope store', 'Rope depot'].includes(I.name), I.conflicts);
  const fix = mk(D1, 'inv.set', { inv: 'iv1', fields: { name: 'Rope depot' }, base: [e2a.id, e3b.id] });
  ok('inv.set: saving over both resolves it', !L.replayProject([set, e2a, e3b, fix], pid).inventories.iv1.conflicts);
  const l2a = mk(D1, 'inv.log', { inv: 'iv1', log: 'e1', items: [{ name: 'Rope 50 m', qty: 5 }], base: [left.id] });
  const l2b = mk(D2, 'inv.log', { inv: 'iv1', log: 'e1', items: [{ name: 'Rope 50 m', qty: 4 }], base: [left.id] });
  const l2c = mk(D2, 'inv.log', { inv: 'iv1', log: 'e1', text: 'Both barrels', base: [left.id] });
  I = L.replayProject([set, left, l2a, l2b], pid).inventories.iv1;
  ok('inv.log: one entry edited on two devices: conflict on that field, both kept', I.log[0].conflicts && I.log[0].conflicts.items.length === 2, I.log[0].conflicts);
  I = L.replayProject([set, left, l2a, l2c], pid).inventories.iv1;
  ok('inv.log: edits of different fields of one entry both count', !I.log[0].conflicts && I.log[0].text === 'Both barrels' && I.log[0].items[0].qty === 5, I.log[0]);
  I = L.replayProject([set, left, l2a, l2b, mk(D1, 'inv.log', { inv: 'iv1', log: 'e1', items: [{ name: 'Rope 50 m', qty: 4 }], base: [l2a.id, l2b.id] })], pid).inventories.iv1;
  ok('inv.log: saving over both resolves it', !I.log[0].conflicts && I.log[0].items[0].qty === 4);

  // remove and undo
  const rm = mk(D1, 'inv.log', { inv: 'iv1', log: 'e2', removed: true, prev: { date: '2026-02-01', by: 'Bo and Cy', action: 'took', items: [{ name: 'rope 50 m', qty: 1 }], all: false, photos: [], text: '' }, base: [took.id] });
  I = L.replayProject([set, left, took, rm], pid).inventories.iv1;
  ok('inv.log: a removed entry is out of the log and the counts', I.log.length === 1 && I.contents.find(c => c.name === 'Rope 50 m').qty === 2, I.log);
  const unrm = Object.assign(D1('x', {}), L.invUndo(Object.assign({ id: 'invA.99' }, rm)));
  I = L.replayProject([set, left, took, rm, unrm], pid).inventories.iv1;
  ok('undo of a removed entry brings it back as it was', I.log.map(e => e.id).join() === 'e1,e2' && I.log[1].by === 'Bo and Cy' && I.contents.find(c => c.name === 'Rope 50 m').qty === 1, I.log);
  const undoNew = Object.assign(D1('x', {}), L.invUndo(left));
  I = L.replayProject([set, left, took, undoNew], pid).inventories.iv1;
  ok('undo of a new entry takes it out', I.log.map(e => e.id).join() === 'e2' && undoNew.removed === true && undoNew.log === 'e1');
  const edit = Object.assign(mk(D1, 'inv.log', { inv: 'iv1', log: 'e1', items: [{ name: 'Rope 50 m', qty: 9 }], prev: { items: left.items }, base: [left.id] }));
  const undoEdit = Object.assign(D1('x', {}), L.invUndo(edit));
  I = L.replayProject([set, left, edit, undoEdit], pid).inventories.iv1;
  ok('undo of an edit puts the earlier items back', I.log[0].items.length === 2 && I.log[0].items[0].qty === 2, I.log[0].items);
  const del = mk(D1, 'inv.del', { inv: 'iv1', base: set.heads });
  S = L.replayProject([set, left, del], pid);
  ok('inv.del: gone from the live list, the record and its log kept', S.inventories.iv1.deleted && L.liveInventories(S).length === 0 && S.inventories.iv1.log.length === 1);
  const res = Object.assign(D1('x', {}), L.invUndo(del));
  ok('undo of a removal: inv.restore brings it back; undo of that removes it again', res.op === 'inv.restore' && L.liveInventories(L.replayProject([set, left, del, res], pid)).length === 1 && L.invUndo(Object.assign({ id: 'q.1' }, res)).op === 'inv.del');
  const un1 = L.invUndo(set);
  ok('undo of a new inventory removes it', un1.op === 'inv.del' && un1.inv === 'iv1');
  const un2 = Object.assign(D1('x', {}), L.invUndo(e2a));
  ok('undo of a rename puts the name back', L.replayProject([set, e2a, un2], pid).inventories.iv1.name === 'Rope cache' && un2.fields.name === 'Rope cache');
  ok('undo: proposals and unknown things have none', L.invUndo(Object.assign({}, left, { proposed: { by: 'x' } })) === null && L.invUndo({ id: 'a.1', op: 'note.set', inv: 'iv1' }) === null && L.invUndo(null) === null);

  // list mode: a simple list; the log stays for when it is switched back
  const toList = mk(D1, 'inv.set', { inv: 'iv1', fields: { mode: 'list', list: '2 ropes\nstove\nblue tarp' }, prev: { mode: 'log', list: '' }, base: [set.id] });
  I = L.replayProject([set, left, took, toList], pid).inventories.iv1;
  ok('list mode: mode and text kept; the log still replays', I.mode === 'list' && I.list.startsWith('2 ropes') && I.log.length === 2 && I.contents.length === 2, I);
  ok('list mode: one line for lists and markers', L.invLine(I) === '2 ropes, stove, blue tarp' && L.invLine(base) === 'Rope 50 m ×3, Stove, Tarp' && L.invLine(L.replayProject([set, left], pid).inventories.iv1) === 'Rope 50 m ×2, Stove' && L.invLine(base, 2) === 'Rope 50 m ×3, Stove +1');
  const listLate = L.invMark(I, { now: Date.parse(toList.t) + 400 * 864e5 }), listSoon = L.invMark(I, { now: Date.parse(toList.t) + 10 * 864e5 });
  ok('list mode: a list nobody edited for a year is possibly out of date', listLate.stale && !listSoon.stale && listLate.listAge === 400, [listLate.stale, listSoon.stale, listLate.listAge]);
  const back2 = mk(D1, 'inv.set', { inv: 'iv1', fields: { mode: 'log' }, prev: { mode: 'list' }, base: [toList.id] });
  ok('switching back to the log shows the counts again', L.replayProject([set, left, took, toList, back2], pid).inventories.iv1.mode === 'log');

  // photos: page references with the date of their entry, newest first; page types kept; bad hashes dropped
  const ph = mk(D1, 'inv.log', { inv: 'iv1', log: 'e8', date: '2026-05-01', action: 'note', text: 'Barrel lid', photos: [{ h: H(1), ext: 'jpg', w: 800, ht: 600, name: 'lid.jpg' }, { h: 'zz', ext: 'jpg' }, { h: H(2), ext: 'PNG' }], prev: null });
  I = L.replayProject([set, left, ph], pid).inventories.iv1;
  ok('photos: kept as pages with the entry date, newest first, bad hashes dropped', I.photos.length === 2 && I.photos[0].date === '2026-05-01' && I.photos[0].log === 'e8' && I.photos[1].ext === 'png' && I.photos[0].w === 800, I.photos);
  const sel = L.selectForSync([set, left, ph].map((e, i) => Object.assign({ scope: 'x' }, e)), [], L.replayProject([set, left, ph], pid), L.replayDocs([]), null, 'all');
  ok('sync file: the photos of inventory entries travel as pages', sel.blobs.includes(H(1) + '.jpg') && sel.blobs.includes(H(2) + '.png') && sel.count === 3, sel.blobs);

  // an archive's suggestion changes nothing until accepted
  const prop = mk(D2, 'inv.log', { inv: 'iv1', log: 'e9', date: '1998-07-01', action: 'left', items: [{ name: 'Ladder', qty: 1 }], proposed: { by: 'archive', confidence: 0.7, evidence: [] } });
  I = L.replayProject([set, left, prop], pid).inventories.iv1;
  ok('proposal: not counted before it is accepted', !I.contents.some(c => c.name === 'Ladder'));
  const acc = mk(D1, 'accept', { ref: prop.id });
  I = L.replayProject([set, left, prop, acc], pid).inventories.iv1;
  ok('proposal: accepted, it is an entry of the log at its date', I.contents.some(c => c.name === 'Ladder') && I.log[0].id === 'e9' && I.log[0].date === '1998-07-01', I.log.map(e => e.id));

  // a log with no inv.set yet (the other half arrives in a later sync file): kept, not listed
  S = L.replayProject([left], pid);
  ok('orphan log: the inventory is there but not placed, so not listed', S.inventories.iv1.orphan && S.inventories.iv1.log.length === 1 && L.liveInventories(S).length === 0);
  ok('orphan log: it joins its inventory once the inv.set comes', !L.replayProject([left, set], pid).inventories.iv1.orphan && L.liveInventories(L.replayProject([left, set], pid)).length === 1);

  // surface point target, move to another target
  const fset = mk(D1, 'inv.set', { inv: 'iv2', target: L.T.feature('f1'), fields: { name: 'Dig kit', mode: 'log' }, prev: null });
  S = L.replayProject([set, fset], pid);
  ok('surface point: found by its feature target', L.invsOn(S, 'feature:f1').map(i => i.name).join() === 'Dig kit' && L.liveInventories(S).map(i => i.name).join() === 'Dig kit,Rope cache');
  const mv = mk(D1, 'inv.set', { inv: 'iv2', target: L.T.station(cid, 'T7'), fields: {}, prev: { target: 'feature:f1' }, base: [fset.id] });
  ok('moved to another place: the target follows the latest edit', L.replayProject([set, fset, mv], pid).inventories.iv2.target === L.T.station(cid, 'T7'));

  // an inventory that came in an export is adopted with the same ids on every device: they merge into one, no conflict
  const exp = L.invPayload(L.replayProject([set, left, took, chk, ph], pid).inventories.iv1);
  const adopt = L.invAdoptBodies(exp, L.T.station(cid2, 'T6'));
  ok('adopt: an inv.set with the export\'s id and one inv.log per exported entry (same log ids, oldest first)', adopt[0].op === 'inv.set' && adopt[0].inv === 'iv1' && adopt[0].target === L.T.station(cid2, 'T6') && adopt[0].fields.name === 'Rope cache' && adopt[0].source === 'export'
    && adopt.slice(1).map(b => b.log).join() === 'e1,e2,e3,e8' && adopt.slice(1).every(b => b.op === 'inv.log' && b.inv === 'iv1'), adopt.map(b => b.log || b.op));
  const onA = adopt.map(b => { const { op, ...d } = b; return D1(op, d); }), onB = adopt.map(b => { const { op, ...d } = b; return D2(op, d); });
  const merged = L.replayProject(onA.concat(onB), pid).inventories.iv1, solo = L.replayProject(onA, pid).inventories.iv1;
  ok('adopt: two devices adopting the same export make one inventory with the same log and counts, and no conflicts', merged.log.length === 4 && JSON.stringify(merged.contents) === JSON.stringify(solo.contents) && !merged.conflicts && merged.log.every(e => !e.conflicts)
    && merged.contents.map(c => c.name + c.qty).join() === 'Rope 50 m3,Stove1,Tarp1' && merged.photos.length === 2 && merged.photos[0].h === H(1), merged.log.map(e => e.id));
  ok('adopt: a bad export entry is skipped, a list-mode export keeps its list', L.invAdoptBodies({ id: 'x', name: 'N', mode: 'list', list: 'a', log: [null, { date: '2026-01-01' }] }, 'feature:f1').length === 1 && L.invAdoptBodies({ id: 'x', mode: 'list', list: 'a' }, 'feature:f1')[0].fields.list === 'a');

  // building the records
  const nb = L.invSetBody(null, { target: st, name: '  Rope   cache ', desc: 'x', mode: 'list', list: 'a' });
  ok('invSetBody: a new inventory', nb.op === 'inv.set' && nb.target === st && nb.fields.name === 'Rope cache' && nb.fields.mode === 'list' && nb.prev === null && !('base' in nb), nb);
  const cur = L.replayProject([set, left], pid).inventories.iv1;
  ok('invSetBody: nothing changed is null; a change carries prev and base', L.invSetBody(cur, { name: 'Rope cache', mode: 'log' }) === null
    && JSON.stringify(L.invSetBody(cur, { name: 'Depot' }).prev) === '{"name":"Rope cache"}' && L.invSetBody(cur, { name: 'Depot' }).base[0] === set.id);
  const lb = L.invLogBody('iv1', { date: '2026-06-01', action: 'left', items: [{ name: 'Tarp', qty: '2' }], photos: [{ h: H(3), ext: 'jpg' }] });
  ok('invLogBody: a new entry (id, normalised items, prev null)', lb.op === 'inv.log' && lb.inv === 'iv1' && /^[a-z0-9]{12}$/.test(lb.log) && lb.items[0].qty === 2 && lb.prev === null && lb.photos.length === 1 && lb.all === false, lb);
  ok('invLogBody: today when no date; a note carries no items; "all" only on a check', /^\d{4}-\d{2}-\d{2}$/.test(L.invLogBody('iv1', { action: 'note', items: [{ name: 'x' }], all: true, text: 't' }).date) && L.invLogBody('iv1', { action: 'note', items: [{ name: 'x' }] }).items.length === 0 && L.invLogBody('iv1', { action: 'left', all: true, items: [] }).all === false && L.invLogBody('iv1', { action: 'checked', all: true, items: [] }).all === true);
  const ent = L.replayProject([set, left], pid).inventories.iv1.log[0];
  ok('invLogBody: an edit with no change is null; with a change it keeps the log id, prev and base', L.invLogBody('iv1', { date: ent.date, by: ent.by, action: ent.action, items: ent.items, photos: ent.photos, text: ent.text }, ent) === null
    && (e => e.log === 'e1' && e.prev.text === 'In the blue barrel' && e.base[0] === left.id && e.text === 'Changed')(L.invLogBody('iv1', { date: ent.date, action: ent.action, items: ent.items, text: 'Changed' }, ent)));
  const lrm = L.invLogRemoveBody('iv1', ent);
  ok('invLogRemoveBody: removed, with the entry as it was for the undo', lrm.removed === true && lrm.log === 'e1' && lrm.prev.items.length === 2 && lrm.base[0] === left.id);
  const pay = L.invPayload(L.replayProject([set, left, took, chk, ph], pid).inventories.iv1);
  ok('invPayload: what the export carries (contents with dates, the log with photo references)', pay.id === 'iv1' && pay.target === st && pay.contents.length === 3 && pay.checked === '2026-03-02' && pay.log.length === 4
    && pay.log[3].photos[0].h === H(1) && pay.log[0].by === 'Ana' && pay.log[1].by === 'Bo and Cy' && pay.contents[0].checked === '2026-03-02' && pay.contents[0].since === '2026-03-02' && pay.contents[1].since === '2026-01-10' && !('created' in pay.log[0]), pay);
  ok('invPayload: it survives JSON (it goes into caves.json)', JSON.stringify(JSON.parse(JSON.stringify(pay))) === JSON.stringify(pay));

  // entries made by something else (a sync file, an older build, a bug) must never stop the log from replaying
  {
    const J = (op, d) => Object.assign({ id: 'j.' + Math.random().toString(36).slice(2), dev: 'j', seq: 1, t: '2026-06-01T00:00:00Z', who: 'x', op }, d);
    const junk = [J('inv.set', { inv: 'ij', target: 5, fields: 'nope' }), J('inv.set', { inv: 'ij', target: 'station:c:A', fields: { name: null, mode: 7, list: { a: 1 } } }),
      J('inv.log', { inv: 'ij', log: 'x1', items: 'rope', photos: 'p', date: {}, action: 3, text: 9, by: [] }), J('inv.log', { inv: 'ij', log: 'x2', items: [null, 4, { name: {}, qty: 'q' }, { name: 'ok', qty: -2 }], photos: [null, 3, { h: 5 }], date: '2026-02-30' }),
      J('inv.log', { inv: 'ij', items: [{ name: 'a', qty: 1 }], action: 'left' }), J('inv.log', { inv: '', log: 'x3' }), J('inv.log', { log: 'x4' }), J('inv.del', { inv: 'ij' }), J('inv.restore', { inv: 'nowhere' }),
      J('inv.log', { inv: 'ij', log: 'x5', removed: 'yes' })];
    let S = null, threw = null;
    try { S = L.replayProject(junk, pid); L.liveInventories(S).forEach(i => { L.invPayload(i); L.invLine(i); L.invMark(i, { now: 0 }); }); } catch (e) { threw = e; }
    ok('junk inv.* entries replay without an error (bad ones are tamed or skipped)', !threw && S && S.inventories.ij && S.inventories.ij.log.every(e => ['left', 'took', 'checked', 'note'].includes(e.action) && Array.isArray(e.items)), threw && String(threw.stack).slice(0, 300));
  }

  // any order of reading the same entries gives the same inventory (what devices merge into must not depend on file order)
  {
    const mixed = [set, left, took, chk, back, over, edit, rm, unrm, e2a, e2b, toList, back2, ph, prop, acc, del, res];
    const fixedNow = day('2027-01-01'), view = es => JSON.stringify(Object.values(L.replayProject(es, pid).inventories).map(i => L.invMark(i, { now: fixedNow })).map(i => [i.id, i.target, i.name, i.desc, i.mode, i.list, i.deleted, i.heads, i.conflicts || null,
      i.log.map(e => [e.id, e.date, e.items, e.text, e.removed, e.conflicts || null]), i.contents.map(c => [c.name, c.qty, c.changed, c.checked, c.stale]), i.gone, i.checked, i.stale]));
    const base0 = view(mixed);
    let same0 = true, seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let k = 0; k < 60 && same0; k++) { const p = mixed.slice().sort(() => rnd() - 0.5); same0 = view(p) === base0; }
    ok('inventories: 60 random orders of the same mixed log (edits, removals, undo, a suggestion, two devices) replay identically', same0);
  }
}

// 4) Documents: pages, tags, rotation, membership, inbox
{
  const S = L.replayProject([PC('cave.set', { cave: cid, name: 'Cave Ridge' }), PC('lead.set', { lead: 'L9', target: L.T.station(cid, 'A1'), fields: { status: 'open' } })], pid);
  const pg = h => ({ h, ext: 'jpg', w: 1000, ht: 1400, name: h + '.jpg' });
  const docs = [
    PC('doc.add', { doc: 'd1', title: 'Survey book p1–3', kind: 'survey notes', pages: [pg('aaa'), pg('bbb')], tags: [L.T.project(pid)] }),
    PC('doc.add', { doc: 'd2', title: 'Trip report', pages: [pg('ccc')], tags: [L.T.project('otherProject')] }),
    A('doc.add', { doc: 'd3', title: 'Lead photo', pages: [pg('ddd')], tags: [L.T.lead('L9')] }),
    A('doc.tag', { doc: 'd1', target: L.T.survey(cid, 'A') }),
    A('doc.tag', { doc: 'd1', target: L.T.station(cid, 'A3') }),
    B('doc.rotate', { doc: 'd1', h: 'bbb', rot: 90 }),
    B('doc.pages', { doc: 'd1', add: [pg('eee'), pg('aaa')] }),
    B('doc.add', { doc: 'd4', title: 'Unsorted scan', pages: [pg('fff')], tags: [L.T.project(pid)] }),
    PC('doc.tag', { doc: 'd2', target: L.T.cave(cid) }),
    PC('doc.untag', { doc: 'd1', target: L.T.station(cid, 'A3') }),
    A('doc.set', { doc: 'd4', fields: { title: 'Scan 12' } }),
  ];
  const D = L.replayDocs(docs);
  ok('pages kept once (re-add ignored), in order', D.docs.d1.pages.map(p => p.h).join() === 'aaa,bbb,eee', D.docs.d1.pages);
  ok('rotation', D.docs.d1.pages[1].rot === 90);
  ok('tag then untag', !D.docs.d1.tags[L.T.station(cid, 'A3')] && D.docs.d1.tags[L.T.survey(cid, 'A')]);
  const mine = L.docsOf(D, S).map(d => d.id).sort().join();
  ok('docs of the project (by project, cave, lead tags)', mine === 'd1,d2,d3,d4', mine);
  ok('d2 also in its other project', L.docInProject(D.docs.d2, { id: 'otherProject', caves: {}, leads: {} }));
  ok('inbox = only the project tag', L.docInbox(D.docs.d4, S) && !L.docInbox(D.docs.d1, S));
  const fs = L.docsForStation(D, S, cid, 'A3', ['A']);
  ok('station docs: survey level after untag', fs.station.length === 0 && fs.survey.map(d => d.id).join() === 'd1' && fs.cave.map(d => d.id).join() === 'd2', fs);
  ok('lead docs', L.docsForTarget(D, L.T.lead('L9')).map(d => d.id).join() === 'd3');
  ok('doc title edited', D.docs.d4.title === 'Scan 12');

  // 5) Sync selection: everything, then only what is new since
  const pLog = [PC('note.set', { note: 'nn', target: L.T.station(cid, 'A1'), text: 'x' })];
  const S2 = L.replayProject([PC('cave.set', { cave: cid, name: 'Cave Ridge' }), PC('lead.set', { lead: 'L9', target: L.T.station(cid, 'A1'), fields: {} })].concat(pLog), pid);
  const projEntries = S2.log;
  let sel = L.selectForSync(projEntries, docs, S2, D, null, 'since');
  ok('first sync file: all of the project', sel.entries[L.projScope(pid)].length === projEntries.length);
  ok('…and every entry of its documents (d1–d4)', sel.entries.docs.length === docs.length, sel.entries.docs.map(e => e.doc));
  ok('…with their pages', sel.blobs.sort().join() === 'aaa.jpg,bbb.jpg,ccc.jpg,ddd.jpg,eee.jpg,fff.jpg', sel.blobs);
  const sent = sel.sent;
  const later = A('doc.tag', { doc: 'd4', target: L.T.station(cid, 'A1') });
  const notMine = A('doc.add', { doc: 'd5', title: 'Elsewhere', pages: [pg('zzz')], tags: [L.T.project('otherProject')] });
  const D2 = L.replayDocs(docs.concat([later, notMine]));
  sel = L.selectForSync(projEntries, docs.concat([later, notMine]), S2, D2, sent, 'since');
  ok('next sync file: only the new entry', sel.count === 1 && sel.entries.docs[0].id === later.id, sel.entries);
  ok('…no pages already sent, none of other projects', sel.blobs.length === 0, sel.blobs);
  ok('"everything" ignores what was sent', L.selectForSync(projEntries, docs, S2, D, sent, 'all').count === projEntries.length + docs.length);
  const man = L.syncManifest(S2, 'pc', 'Cy', L.selectForSync(projEntries, docs, S2, D, null, 'all'));
  ok('manifest ranges', man.scopes.docs.pc.n === 4 && man.scopes.docs.phoneA.n === 4 && man.project.id === pid, man);

  // 6) Merging: union by id, malformed skipped
  const known = new Set(docs.slice(0, 5).map(e => e.id));
  const inc = docs.concat([{ id: 'x.1', dev: 'y', seq: 1, t: 'z', op: 'doc.add' }, docs[7]]);
  const nw = L.newEntries(known, inc);
  ok('only unknown entries, once each', nw.length === docs.length - 5 && new Set(nw.map(e => e.id)).size === nw.length, nw.map(e => e.id));
}

// 7) Field survey reduction
{
  const known = new Map([['c|A0', [0, 0, 0]], ['c|A1', [10, 0, 0]]]);
  const sv = { tie: 'A1', lenUnit: 'm', shots: [
    { from: 'A1', to: 'F1', len: '10', az: '0', inc: '0' },
    { from: 'F1', to: 'F2', len: '10', az: '90', baz: '270', inc: '10', binc: '-10' },
    { from: 'F2', to: 'A0', len: '30', az: '250', inc: '0' },
    { from: 'X1', to: 'X2', len: '5', az: '0', inc: '0' },
  ] };
  const r = L.computeSurvey(sv, known, { prefix: 'c|', decl: () => ({ v: 0, src: 'test' }), conv: () => 0 });
  const F1 = r.pos.get('c|F1'), F2 = r.pos.get('c|F2');
  ok('F1 north of A1', near(F1[0], 10) && near(F1[1], 10) && near(F1[2], 0), F1);
  ok('F2: fore/back averaged, 10° up', near(F2[0], 10 + 10 * Math.cos(10 * Math.PI / 180)) && near(F2[2], 10 * Math.sin(10 * Math.PI / 180)), F2);
  ok('closure onto A0 reported', r.closures.length === 1 && r.closures[0].at === 'A0' && r.closures[0].err > 1, r.closures);
  ok('untied shot reported', r.loose.join() === '3');
  const r2 = L.computeSurvey(sv, known, { prefix: 'c|', decl: () => ({ v: 10, src: 'x' }), conv: () => 2 });
  const g = (0 + 10 - 2) * Math.PI / 180;
  ok('declination − convergence applied', near(r2.pos.get('c|F1')[0], 10 + 10 * Math.sin(g)) && near(r2.pos.get('c|F1')[1], 10 * Math.cos(g)));
  ok('ledge n/n → larger', L.parseNum('3/5', 'lrud').v === 5 && L.parseNum('3-5', 'lrud').flag);
  ok('flags', L.shotFlags({ from: 'a', to: 'b', len: '10', az: '10', baz: '200', inc: '0' }, { lenUnit: 'ft' }).some(f => /differ/.test(f)));
  const lr = L.stationLruds({ lenUnit: 'ft', shots: [{ from: 'A', to: 'B', l: '2/4', r: '1', u: '', d: '3' }] });
  ok('LRUD per station in metres', near(lr.get('A')[0], 4 * 0.3048) && lr.get('A')[2] === '–');
}

// 8) Suggested caves inside one file
{
  const P = names => names.map(n => (typeof n === 'string' ? { name: n } : n));
  const segs = [
    { survey: 'A', points: P(['A1', 'A2', 'A3']) },
    { survey: 'B', points: P(['A3', 'B1', 'B2']) },              // joins A underground
    { survey: 'SURF', surface: true, points: P(['A1', 'S1', 'C1']) },  // surface: joins nothing
    { survey: 'C', points: P(['C1', 'C2']) },
    { survey: 'D', points: P(['C2', { name: 'D1', surface: true }, 'D2', 'D3']) },  // P-flagged point breaks the link
  ];
  const s = L.suggestCaves(segs);
  const groups = s.caves.map(c => c.surveys.join('+')).sort();
  ok('caves: A+B, C, D apart; surface survey listed', groups.join(' | ') === 'A+B | C | D' && s.surface.join() === 'SURF', s);
}

// 9) SHA-256 against Node's
{
  const crypto = require('crypto');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100000]) {
    const b = crypto.randomBytes(n);
    const want = crypto.createHash('sha256').update(b).digest('hex');
    if (L.sha256(new Uint8Array(b)) !== want) { ok('sha256 ' + n, false); break; }
    if (n === 100000) ok('sha256 matches Node for 0…100000 bytes', true);
  }
}

// 10) Archive additions (doc 11): proposals, kinds/dates, area tags, sightings, survey versions
{
  const AI = device('archive-ai', 'archive-ai');
  const st = L.T.station(cid, 'A14');
  const base = [
    PC('project.set', { name: 'Cave Ridge area' }),
    PC('cave.set', { cave: cid, name: 'Cave Ridge' }),
  ];
  // A lead read off a 1978 sketch: a fact (the mark is there) with a tie note…
  const s1 = AI('lead.set', { lead: 'L78', target: st, source: 'archive', fields: { status: 'open', desc: '? at the end of the crawl',
    confidence: 0.7, tie: 'nearest label A14 ~3 cm away, two stations past it' }, base: [],
    sighting: { doc: 'd78', h: 'a'.repeat(64), box: [100, 200, 40, 40], date: '1978' } });
  // …and a status suggestion as a proposal.
  const p1 = AI('lead.set', { lead: 'L78', fields: { status: 'surveyed', into: 'B' }, base: [s1.id],
    proposed: { by: 'model-x', confidence: 0.9, evidence: [{ text: 'survey B dated 1994 continues from A14' }] } });
  const p2 = AI('lead.set', { lead: 'L78', fields: { priority: '1' }, base: [s1.id],
    proposed: { by: 'model-x', confidence: 0.3, evidence: [] } });
  const s2 = AI('lead.set', { lead: 'L78', fields: {}, base: [s1.id], sighting: { doc: 'd94', h: 'b'.repeat(64), date: '1994' } });
  let S = L.replayProject(base.concat([s1, p1, p2, s2]), pid);
  let Ld = S.leads.L78;
  ok('archive lead: on a station, active, tie note kept', Ld && Ld.target === st && L.leadActive(Ld) && /A14/.test(Ld.fields.tie), Ld);
  ok('two sightings', Ld.sightings.length === 2 && Ld.sightings[1].date === '1994', Ld.sightings);
  ok('proposals change nothing', Ld.fields.status === 'open' && !Ld.fields.priority);
  ok('review queue: both, most confident first', L.reviewQueue(S, null).map(p => p.id).join() === [p1.id, p2.id].join());
  // The reviewer accepts the status suggestion with a correction, rejects the other.
  const acc = PC('accept', { ref: p1.id, fields: { into: 'B (1994)' }, base: [p1.id, s2.id] });
  const rej = PC('reject', { ref: p2.id, why: 'no evidence' });
  S = L.replayProject(base.concat([s1, p1, p2, s2, acc, rej]), pid);
  Ld = S.leads.L78;
  ok('accepted: status applied with the correction', Ld.fields.status === 'surveyed' && Ld.fields.into === 'B (1994)' && !L.leadActive(Ld), Ld.fields);
  ok('rejected one not applied', !Ld.fields.priority);
  ok('queue empty', L.reviewQueue(S, null).length === 0);
  ok('accepted lead has one head (no false conflict)', Ld.heads.length === 1 && !Ld.conflicts, Ld.heads);
  ok('history keeps the proposal', Ld.history.includes(p1.id) && S.byId.get(p1.id).proposed);
  // Accept arriving before the proposal in time (clock skew): still applies.
  const skewAcc = Object.assign({}, acc, { t: '2000-01-01T00:00:00.000Z' });
  S = L.replayProject(base.concat([s1, p1, p2, s2, skewAcc]), pid);
  ok('accept with an early clock still applies after its proposal', S.leads.L78.fields.status === 'surveyed');
  // Bulk accept with refs
  const bulk = PC('accept', { refs: [p1.id, p2.id], base: [p1.id, p2.id, s2.id] });
  S = L.replayProject(base.concat([s1, p1, p2, s2, bulk]), pid);
  ok('bulk accept', S.leads.L78.fields.status === 'surveyed' && S.leads.L78.fields.priority === '1');

  // Documents: kind, approximate date, coordinates flag, per-page kind, proposed tag, area tag
  const dAdd = AI('doc.add', { doc: 'd78', title: 'Sketch sheet 3', kind: 'sketch-plan', date: '1970s', has_coordinates: false,
    pages: [{ h: 'a'.repeat(64), ext: 'jpg', w: 2000, ht: 1500, kind: 'sketch-plan' }, { h: 'c'.repeat(64), ext: 'jpg', w: 2000, ht: 1500, kind: 'shot-table' }],
    tags: [L.T.project(pid)] });
  const tagP = AI('doc.tag', { doc: 'd78', target: L.T.area(cid, 'A10~A22,B3'), proposed: { by: 'model-x', confidence: 0.8, evidence: [{ text: 'labels A12, A15, A20', page: { h: 'a'.repeat(64), box: [0, 0, 10, 10] } }] } });
  let D = L.replayDocs([dAdd, tagP]);
  ok('doc kind, approximate date, flag, page kinds', D.docs.d78.kind === 'sketch-plan' && D.docs.d78.date === '1970s' && D.docs.d78.has_coordinates === false
     && D.docs.d78.pages[1].kind === 'shot-table', D.docs.d78);
  ok('dateKey sorts approximate dates', L.dateKey('1970s') === '1970' && L.dateKey('c. 1975') === '1975' && L.dateKey('1994-07-16') === '1994-07-16');
  ok('proposed tag not applied; doc in the inbox', !D.docs.d78.tags[L.T.area(cid, 'A10~A22,B3')] && L.reviewQueue(null, D).length === 1);
  const accT = PC('accept', { ref: tagP.id, base: [tagP.id] });
  D = L.replayDocs([dAdd, tagP, accT]);
  const S0 = L.replayProject(base, pid);
  const at = n => L.docsForStation(D, S0, cid, n, ['A']);
  ok('area tag accepted → shows on A15 and B3, not A23 or A1', at('A15').area.length === 1 && at('B3').area.length === 1 && !at('A23').area.length && !at('A1').area.length);
  ok('areaHas: suffixes and exact names', L.areaHas('A10~A22', 'A10a') && L.areaHas('A22~A10', 'A12') && !L.areaHas('A10~A22', 'B12') && L.areaHas('X1,Y2', 'Y2') && !L.areaHas('X1', 'X10'));
  ok('area target parses', L.parseTarget(L.T.area(cid, 'A10~A22')).spec === 'A10~A22' && L.parseTarget(L.T.area(cid, 'A10~A22')).cave === cid);
  const SP = L.replayProject(base, pid);
  const sel = L.selectForSync(base, [dAdd, tagP, accT], SP, D, null, 'all');
  ok('sync file carries the accept of a document proposal', sel.entries.docs.some(e => e.id === accT.id), sel.entries.docs.map(e => e.op));
  ok('docInProject via area tag only', L.docInProject({ tagList: [L.T.area(cid, 'A1')] }, SP));

  // Survey versions: beside the original, never replacing it
  const v1 = AI('survey.version', { cave: cid, code: 'A', version: 'A-1978-transcribed', raw: { shots: [{ from: 'A1', to: 'A2', len: '12.5', az: '40', inc: '-5' }] },
    provenance: [{ doc: 'd78', h: 'c'.repeat(64), box: [10, 10, 500, 300] }], note: 'transcribed from the shot table' });
  S = L.replayProject(base.concat([v1]), pid);
  ok('survey version kept with provenance', S.surveyVersions[cid + '|A'].length === 1 && S.surveyVersions[cid + '|A'][0].provenance[0].doc === 'd78');
}

// 11) Segments (optional): shots surveyed together, page targets, review state
{
  const AI = device('archive-ai', 'archive');
  const segT = L.T.segment(cid, 's1');
  ok('segment target parses', (t => t.kind === 'segment' && t.cave === cid && t.seg === 's1')(L.parseTarget(segT)));
  const log = [
    PC('cave.set', { cave: cid, name: 'Cave Ridge' }),
    AI('segment.set', { seg: 's1', cave: cid, name: 'A 1994-07-16', date: '1994-07-16', team: 'Ana, Bo', shots: [['A1', 'A2'], ['A2', 'A3']], check: { done: 2, total: 2 } }),
    AI('segment.set', { seg: 's2', cave: cid, name: 'A 1995', shots: [['A3', 'A4'], ['A4', 'A5']], check: { done: 1, total: 2 } }),
    AI('segment.set', { seg: 's3', cave: cid, name: 'B', shots: [['B1', 'B2']] }),
    AI('segment.set', { seg: 's4', cave: cid, name: 'gone', shots: [['C1', 'C2']] }),
    AI('segment.del', { segs: ['s4'] }),
    AI('note.set', { note: 'n1', target: L.T.station(cid, 'A4'), text: 'Azimuth 123 on paper, 132 in the data', kind: 'issue',
                     proposed: { by: 'archive', confidence: 0.8, evidence: [{ text: 'p3' }] } }),
    AI('survey.version', { cave: cid, code: 'B', version: 'missing-1', target: L.T.station(cid, 'B2'), tie: 'B2',
                           raw: { lenUnit: 'ft', shots: [{ from: 'B2', to: 'B2a', len: 10, az: 90, inc: 0 }] }, proposed: { by: 'archive', confidence: 0.6 } }),
  ];
  let S = L.replayProject(log, pid);
  ok('three live segments', L.segmentsOf(S, cid).length === 3);
  ok('deleted segment kept but removed', S.segments.s4 && S.segments.s4.removed);
  const idx = L.segmentIndex(S, cid);
  ok('shot lookup both ways', idx.shot.get('A2|A1')[0] === 's1' && idx.shot.get('A3|A4')[0] === 's2');
  ok('tie station in two segments', idx.station.get('A3').length === 2);
  ok('segments at a station', L.segmentsAt(S, cid, 'A3').map(g => g.id).sort().join() === 's1,s2');
  const D0 = L.replayDocs([AI('doc.add', { doc: 'd1', title: 'Book', pages: [{ h: 'aa', ext: 'jpg' }, { h: 'bb', ext: 'jpg', targets: [L.T.segment(cid, 's2')] }],
                                         tags: [L.T.segment(cid, 's2')] })]);
  ok('page for a target', L.pageFor(D0.docs.d1, L.T.segment(cid, 's2')) === 1 && L.pageFor(D0.docs.d1, 'x') === 0);
  ok('segment docs reach its stations', L.docsForStation(D0, S, cid, 'A4', ['A']).segment.length === 1);
  ok('…not other stations', L.docsForStation(D0, S, cid, 'B1', ['B']).segment.length === 0);
  ok('doc tagged to a segment is in the project', L.docInProject(D0.docs.d1, S));
  let st = L.segmentStates(S, D0, cid);
  ok('checked segment', st.s1.state === 'checked', st.s1);
  ok('open issue on a station → review', st.s2.state === 'review' && st.s2.open === 1 && st.s2.docs === 1, st.s2);
  ok('missing-survey proposal on its tie', st.s3.state === 'review', st.s3);
  ok('proposal target of a survey version', L.proposalTarget(S.proposals[log[7].id]) === L.T.station(cid, 'B2'));
  // Accept the issue: a note of kind "issue" → problem; turn down the survey version → back to unchecked.
  log.push(PC('accept', { ref: log[6].id }), PC('reject', { ref: log[7].id }));
  S = L.replayProject(log, pid);
  st = L.segmentStates(S, D0, cid);
  ok('accepted issue is a note with its kind', S.notes.n1 && S.notes.n1.kind === 'issue');
  ok('accepted issue → problem', st.s2.state === 'problem', st.s2);
  ok('turned down → unchecked', st.s3.state === 'unchecked', st.s3);
  ok('no segments: nothing changes', L.segmentsOf(L.replayProject([PC('cave.set', { cave: cid, name: 'X' })], pid), cid).length === 0);
}

// 12) Workspace: survey files with placement, layers; sync carries the files
{
  const log = [
    PC('project.set', { name: 'Ridge' }),
    PC('cavefile.set', { file: 'Ridge.plt', h: 'a'.repeat(64), ext: 'plt', place: { mode: 'anchor', station: 'A1', lat: 1, lon: 2, elev: 3 } }),
    PC('layer.set', { layer: 'l1', kind: 'pointcloud', url: 'https://x/ept.json', name: 'cloud' }),
    PC('layer.set', { layer: 'l2', kind: 'caltopo', url: 'https://caltopo.com/m/ABC', interval: 30, name: 'CalTopo' }),
    A('cavefile.set', { file: 'Ridge.plt', place: { mode: 'anchor', station: 'A1', lat: 1.5, lon: 2, elev: 3 } }, Date.parse('2030-01-01')),
    PC('layer.set', { layer: 'l1', removed: true }, Date.parse('2030-01-02')),
  ];
  const S = L.replayProject(log, pid);
  const cf = L.liveCavefiles(S);
  ok('survey file with its hash', cf.length === 1 && cf[0].h === 'a'.repeat(64));
  ok('placement edited on another device', cf[0].place.lat === 1.5 && cf[0].placed.who === 'Ana');
  ok('layers: removed one gone', L.liveLayers(S).map(l => l.id).join() === 'l2' && L.liveLayers(S)[0].interval === 30);
  const sel = L.selectForSync(log, [], S, L.replayDocs([]), null, 'all');
  ok('sync file carries the survey file', sel.blobs.includes('a'.repeat(64) + '.plt'), sel.blobs);
  const S2 = L.replayProject(log.concat([PC('cavefile.set', { file: 'Ridge.plt', removed: true })]), pid);
  ok('survey file removed from the project', L.liveCavefiles(S2).length === 0);
}

// 13) Surface features and groups; downloads; cave tags
{
  const log = [
    PC('group.set', { group: 'g1', name: 'Entrances' }),
    PC('group.set', { group: 'g2', name: 'Upper', parent: 'g1', color: '#ff0000' }),
    PC('feature.set', { feature: 'f1', kind: 'point', coords: [[-100.5678, 45.1234, 1500]], name: 'Pit A', desc: 'flex: cave=Ridge Cave; station=A1', group: 'g2' }),
    PC('feature.set', { feature: 'f2', kind: 'line', coords: [[-100.5678, 45.1234], [-100.5778, 45.1334]], name: 'Approach', group: 'g1' }),
    PC('feature.set', { feature: 'f3', kind: 'area', coords: [[0, 0], [1, 0], [1, 1]], name: 'Zone' }),
    PC('feature.set', { feature: 'f4', kind: 'point', coords: [[1, 1]], name: 'Gone', removed: true }),
  ];
  const S = L.replayProject(log, pid);
  ok('live features', L.liveFeatures(S).map(f => f.id).sort().join() === 'f1,f2,f3');
  ok('features of a group', L.liveFeatures(S, 'g2').map(f => f.id).join() === 'f1');
  ok('group path', L.groupPath(S, 'g2').map(g => g.name).join('/') === 'Entrances/Upper');
  const gj = L.featuresGeoJSON(S, 'g1');
  ok('GeoJSON of a group includes its sub-groups', gj.features.length === 2 && gj.features.find(f => f.id === 'f1').properties.folder === 'Entrances/Upper');
  ok('area closes its ring', L.featuresGeoJSON(S).features.find(f => f.id === 'f3').geometry.coordinates[0].length === 4);
  const kml = L.featuresKML(S, '', 'T');
  ok('KML keeps folders', /<Folder><name>Entrances<\/name><Folder><name>Upper<\/name>/.test(kml) && /Pit A/.test(kml) && /Zone/.test(kml));
  const gpx = L.featuresGPX(S, '');
  ok('GPX: waypoint and tracks', /<wpt lat="45.1234" lon="-100.5678"><name>Pit A/.test(gpx) && (gpx.match(/<trk>/g) || []).length === 2);
  ok('cave tag read', JSON.stringify(L.flexTag('Big entrance\nflex: cave=Ridge Cave; station=A1')) === JSON.stringify({ cave: 'Ridge Cave', station: 'A1' }));
  ok('cave tag in HTML descriptions', L.flexTag('<div>note</div><div>FLEX: Cave = Ridge Cave ; Station = 0</div>').station === '0');
  ok('no tag', L.flexTag('just a pit') === null);
  ok('tag made', L.flexTag(L.makeFlexTag('Ridge Cave', 'A1')).cave === 'Ridge Cave');
  const S2 = L.replayProject(log.concat([PC('group.set', { group: 'g1', removed: true })]), pid);
  ok('removing a group moves its features to the top', L.liveFeatures(S2).find(f => f.id === 'f1').group === '' && L.liveGroups(S2).length === 0);
}

// Height source of a point: kept, replaced with the coordinates, dropped when the place changes without one.
{
  const PH = (d, t) => Object.assign({ id: 'h' + Math.random().toString(36).slice(2, 8), t, who: 'T', dev: 'pc', op: 'feature.set' }, d);
  const S = L.replayProject([
    PH({ feature: 'h1', kind: 'point', coords: [[-100.5678, 45.1234, 1500]], name: 'A', hsrc: { k: 'ground', t: 'world' } }, '2026-11-01T00:00:00Z'),
    PH({ feature: 'h2', kind: 'point', coords: [[-100.5678, 45.1234, 1500]], name: 'B', hsrc: { k: 'file', fileH: 1510 } }, '2026-11-01T00:00:00Z'),
    PH({ feature: 'h3', kind: 'point', coords: [[-100.5678, 45.1234]], name: 'Old' }, '2026-11-01T00:00:00Z'),
    PH({ feature: 'h1', name: 'A2' }, '2026-11-01T00:01:00Z'),
    PH({ feature: 'h2', coords: [[-100.57, 45.12, 1400]] }, '2026-11-01T00:02:00Z'),
    PH({ feature: 'h3', coords: [[-100.57, 45.12, 1400]], hsrc: { k: 'ground', t: 'world+ab' } }, '2026-11-01T00:03:00Z'),
  ], 'p-h');
  ok('hsrc kept through a rename', S.features.h1.hsrc.k === 'ground' && S.features.h1.hsrc.t === 'world');
  ok('hsrc dropped when the place moves without one', S.features.h2.hsrc === undefined && S.features.h2.coords[0][2] === 1400);
  ok('hsrc set by a later record', S.features.h3.hsrc.t === 'world+ab');
}

// Map layers: a picture with its bounds; bad bounds ignored.
{
  const PL = (op, d, t) => Object.assign({ id: 'ml' + Math.random().toString(36).slice(2, 8), t: t || '2026-11-01T00:00:00Z', who: 'T', dev: 'pc', op }, d);
  const S = L.replayProject([PL('layer.set', { layer: 'img1', kind: 'imagery', blob: 'ab.webp', bounds: [-100.6, 45.1, -100.5, 45.2], name: 'Hillshade' }),
    PL('layer.set', { layer: 'img2', kind: 'imagery', blob: 'cd.webp', bounds: [1, 2, 'x', 4], name: 'Bad' }),
    PL('layer.set', { layer: 't1', kind: 'tiles', url: 'https://t/{z}/{x}/{y}.png', name: 'Tiles' })], 'p-ml');
  ok('map image keeps its bounds', JSON.stringify(S.layers.img1.bounds) === '[-100.6,45.1,-100.5,45.2]' && S.layers.img1.kind === 'imagery', S.layers.img1);
  ok('bad bounds are not kept', S.layers.img2.bounds === undefined);
  ok('tile link kept as a layer', S.layers.t1.url === 'https://t/{z}/{x}/{y}.png' && L.liveLayers(S).length === 3);
}

// Tiles a project made (its hillshade): bounds and the zoom levels there are; bad levels ignored.
{
  const PL = (op, d) => Object.assign({ id: 'mz' + Math.random().toString(36).slice(2, 8), t: '2026-11-01T00:00:00Z', who: 'T', dev: 'pc', op }, d);
  const S = L.replayProject([PL('layer.set', { layer: 'hs1', kind: 'tiles', url: '/api/terrain/tiles/p1/Ridge/{z}/{x}/{y}.png', bounds: [-120.1, 38, -120, 38.1], minZoom: 14, maxZoom: 19, name: 'Hillshade' }),
    PL('layer.set', { layer: 'hs2', kind: 'tiles', url: 'https://t/{z}/{x}/{y}.png', minZoom: -1, maxZoom: 2.5, name: 'Bad zooms' }),
    PL('layer.set', { layer: 'hs3', kind: 'tiles', url: 'https://t/{z}/{x}/{y}.png', maxZoom: '18', name: 'Text zoom' })], 'p-mz');
  ok('tiles keep bounds and zoom levels', S.layers.hs1.minZoom === 14 && S.layers.hs1.maxZoom === 19 && JSON.stringify(S.layers.hs1.bounds) === '[-120.1,38,-120,38.1]', S.layers.hs1);
  ok('bad zoom levels are not kept', !('minZoom' in S.layers.hs2) && !('maxZoom' in S.layers.hs2) && !('maxZoom' in S.layers.hs3));
  const S2 = L.replayProject([PL('layer.set', { layer: 'hs1', kind: 'tiles', url: 'u', minZoom: 14, maxZoom: 19 }), PL('layer.set', { layer: 'hs1', name: 'Renamed' })], 'p-mz');
  ok('renaming keeps the zoom levels', S2.layers.hs1.maxZoom === 19 && S2.layers.hs1.name === 'Renamed');
}

// Area labels on a project survey file (arealabel.set): add, rename, move,
// remove; two devices; undo; stable ids for labels moved in from a cave's look.
{
  const D1 = device('pcA', 'Ana'), D2 = device('pcB', 'Bo');
  const a1 = D1('arealabel.set', { label: 'l1', file: 'Ridge.plt', text: 'Big Room', n: 9, e: 0, v: -2, prev: null });
  const a2 = D1('arealabel.set', { label: 'l2', file: 'Ridge.plt', text: 'Test hall', n: 20, e: 5, v: 0, prev: null });
  const a3 = D1('arealabel.set', { label: 'l3', file: 'Other.plt', text: 'Elsewhere', n: 1, e: 1, v: 1, prev: null });
  let S = L.replayProject([a1, a2, a3], pid);
  ok('area labels: two on the file, in the order made', L.areaLabelsOf(S, 'Ridge.plt').map(a => a.text).join() === 'Big Room,Test hall');
  ok('area labels: every file', L.areaLabelsOf(S).length === 3);
  ok('area labels: position kept', S.arealabels.l1.n === 9 && S.arealabels.l1.v === -2);
  // Device 2 renames l1 while device 1 moves it: both edits count (different fields).
  const b1 = D2('arealabel.set', { label: 'l1', text: 'Big Room (upper)', prev: L.areaLabelState(S.arealabels.l1), base: [a1.id] });
  const a4 = D1('arealabel.set', { label: 'l1', n: 12, e: 1, v: -1, prev: L.areaLabelState(S.arealabels.l1), base: [a1.id] });
  const merged = L.replayProject([a1, a2, a3, a4], pid), both = L.replayProject([b1, a1, a2, a3, a4], pid);
  ok('area labels: one device’s move', merged.arealabels.l1.n === 12 && merged.arealabels.l1.text === 'Big Room');
  ok('area labels: rename on one device, move on the other: both kept', both.arealabels.l1.text === 'Big Room (upper)' && both.arealabels.l1.n === 12, both.arealabels.l1);
  ok('area labels: same result whichever log is read first', JSON.stringify(L.areaLabelsOf(L.replayProject([a4, a3, b1, a2, a1], pid))) === JSON.stringify(L.areaLabelsOf(both)));
  // Both rename it: the later one wins on every device.
  const a5 = D1('arealabel.set', { label: 'l2', text: 'Hall A' }, Date.parse('2026-10-25T12:00:00Z'));
  const b2 = D2('arealabel.set', { label: 'l2', text: 'Hall B' }, Date.parse('2026-10-25T12:00:05Z'));
  ok('area labels: two renames, the later wins', L.replayProject([b2, a5, a2], pid).arealabels.l2.text === 'Hall B' && L.replayProject([a2, a5, b2], pid).arealabels.l2.text === 'Hall B');
  // Removal, and undo of it.
  S = L.replayProject([a1, a2, a3, a4], pid);
  const rm = D1('arealabel.set', { label: 'l2', removed: true, prev: L.areaLabelState(S.arealabels.l2), base: [a2.id] });
  S = L.replayProject([a1, a2, a3, a4, rm], pid);
  ok('area labels: removed is not listed', L.areaLabelsOf(S, 'Ridge.plt').map(a => a.id).join() === 'l1' && S.arealabels.l2.removed);
  const un = Object.assign(D1('x', {}), L.areaLabelUndo(rm));
  S = L.replayProject([a1, a2, a3, a4, rm, un], pid);
  ok('area labels: undo of a removal brings it back as it was', S.arealabels.l2 && !S.arealabels.l2.removed && S.arealabels.l2.text === 'Test hall' && S.arealabels.l2.n === 20, S.arealabels.l2);
  const un2 = Object.assign(D1('x', {}), L.areaLabelUndo(a4));
  S = L.replayProject([a1, a2, a3, a4, rm, un, un2], pid);
  ok('area labels: undo of a move puts it back', S.arealabels.l1.n === 9 && S.arealabels.l1.e === 0 && S.arealabels.l1.v === -2, S.arealabels.l1);
  const un3 = Object.assign(D1('x', {}), L.areaLabelUndo(a3));
  ok('area labels: undo of adding one removes it', L.areaLabelsOf(L.replayProject([a1, a2, a3, un3], pid), 'Other.plt').length === 0);
  ok('area labels: an entry without prev has no undo', L.areaLabelUndo(a5) === null);
  ok('area labels: history per label', S.arealabels.l1.history.length === 3 && S.arealabels.l1.history[0] === a1.id);
  // Labels kept in a cave's look before: the same id on every device.
  const lb = { text: 'Big Room', n: 9, e: 0, v: 0 };
  const id1 = L.areaLabelId('Ridge.plt', lb), id2 = L.areaLabelId('Ridge.plt', { text: 'Big Room', n: 9.0001, e: 0, v: 0 });
  ok('area labels: moved-in label ids are stable', id1 === id2 && /^al[0-9a-f]{16}$/.test(id1) && id1 !== L.areaLabelId('Other.plt', lb) && id1 !== L.areaLabelId('Ridge.plt', { text: 'Big room', n: 9, e: 0, v: 0 }));
  const m1 = D1('arealabel.set', Object.assign({ label: id1, file: 'Ridge.plt', prev: null }, lb)), m2 = D2('arealabel.set', Object.assign({ label: id1, file: 'Ridge.plt', prev: null }, lb));
  ok('area labels: two devices moving the same label in: one label', L.areaLabelsOf(L.replayProject([m1, m2], pid), 'Ridge.plt').length === 1);
  // Older readers: no arealabels, and logs without the op replay as before.
  ok('area labels: bad ones ignored', Object.keys(L.replayProject([D1('arealabel.set', { file: 'Ridge.plt', text: 'No id' })], pid).arealabels).length === 0);
  ok('area labels: an op a reader does not know changes nothing else', JSON.stringify(Object.keys(L.replayProject([a1, D1('arealabel.frobnicate', { label: 'l1' })], pid).arealabels)) === '["l1"]');
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
