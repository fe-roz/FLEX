// The rules behind inventories on the phone (viewer_build/libs/viewer-inventory.js, no DOM): which inventories to show from the
// library and the export together (one per id; the library's wins; entries a newer export has and the library lacks are
// folded in; a removed one stays removed), what to record before the first change to an exported inventory (and that two
// phones that both do it merge without a conflict), the Find matches, a form's starting point and what it needs before it can
// be saved. Made-up names (Cave Ridge, stations A5…).   node tools/test_viewer_inventory.js
'use strict';
const FL = require('../viewer_build/libs/flexlib.js');
const VI = require('../viewer_build/libs/viewer-inventory.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 500) : '')); } };
const C = 'cavetest01', NOW = Date.UTC(2026, 10, 8, 12);          // 2026-11-08
const iso = n => new Date(NOW + n).toISOString();

// ── an exported inventory, as caves.json carries it ────────────────────────────────────────────────────────────────────
const rope = () => ({ id: 'x-rope', name: 'Rope cache', desc: 'Blue barrel', mode: 'log', station: 'A5', cave: 'Cave Ridge', target: 'station:other:A5', xyz: [40, 10, 512],
  log: [
    { id: 'e1', date: '2026-01-10', by: 'Ana', action: 'left', items: [{ name: 'Rope 50 m', qty: 2 }, { name: 'Stove', qty: 1 }], text: 'In the barrel' },
    { id: 'e2', date: '2026-02-01', by: 'Bo', action: 'took', items: [{ name: 'Rope 50 m', qty: 1 }], text: '' },
    { id: 'e3', date: '2026-02-01', by: 'Cy', action: 'left', items: [{ name: 'Tarp', qty: 1 }], text: '' },        // the same day as e2: its place after e2 is kept
  ] });
const stash = () => ({ id: 'x-list', name: 'Old stash', desc: '', mode: 'list', list: '2 x carbide\nspare lamp', station: 'B2', cave: 'Cave Ridge', target: 'station:f.x:B2', xyz: [32, 46, 509], stale: true,
  log: [{ id: 'e1', date: '2024-05-01', by: 'Cy', action: 'left', items: [{ name: 'Carbide', qty: 2 }], text: '' }] });
const fresh = () => Object.assign(stash(), { id: 'x-fresh', name: 'Fresh list', stale: false });
const dig = () => ({ id: 'x-dig', name: 'Dig tools', desc: '', mode: 'log', target: 'feature:fsurf1', xyz: [60, -45, 530], log: [{ id: 'e1', date: '2026-05-01', by: 'Bo', action: 'left', items: [{ name: 'Shovel', qty: 2 }], text: '' }] });
const targetOf = exp => VI.libTarget(exp, exp.station ? C : null) || exp.target;
const eff = (entries, exported, o) => VI.effective(Object.assign({ entries, exported, targetOf, exportedAt: iso(-86400e3) }, o || {}));
// what a device's library holds after it records some bodies ([op, data, extra]), as entries
let seqs = {};
const record = (dev, plan) => plan.map(([op, data, extra]) => { const n = seqs[dev] = (seqs[dev] || 0) + 1; return Object.assign({ id: dev + '.' + n, dev, seq: n, t: iso(n), who: dev, op }, data, extra || {}, { id: dev + '.' + n, dev, seq: n, op }); });

// ── 1. only the export ────────────────────────────────────────────────────────────────────────────────────────────────
let l = eff([], [rope(), stash(), dig()]);
ok('three inventories from the export, by name', l.map(i => i.rec.name).join() === 'Dig tools,Old stash,Rope cache', l.map(i => i.rec.name));
const R = l.find(i => i.id === 'x-rope');
ok('the contents are worked out from the log (rope 2 − 1, stove, tarp), same-day entries in the export’s order', R.rec.contents.map(c => c.name + ':' + c.qty).join() === 'Rope 50 m:1,Stove:1,Tarp:1' && R.rec.log.map(e => e.id).join() === 'e1,e2,e3', R.rec.log.map(e => e.id));
ok('not in the library: a change needs it taken in; nothing is missing, nothing placed', R.adopt && !R.placed && R.missing.join() === 'e1,e2,e3' && R.exp && R.exp.id === 'x-rope');
ok('the target is the project’s cave, from the export’s own names', R.rec.target === 'station:' + C + ':A5' && l.find(i => i.id === 'x-dig').rec.target === 'feature:fsurf1', R.rec.target);
ok('“possibly out of date” is worked out on this clock: a log item first seen long ago is, a recent one is not', l.find(i => i.id === 'x-list').rec.stale === true && !R.rec.stale);
ok('a list that was out of date at the export still is; one that was not is not', eff([], [stash()])[0].rec.stale && !eff([], [fresh()])[0].rec.stale, [eff([], [stash()])[0].rec.stale, eff([], [fresh()])[0].rec.stale]);
ok('…and the same list a year later is out of date (the export’s time, a year on)', (() => { const x = VI.effective({ entries: [], exported: [fresh()], targetOf, exportedAt: new Date(Date.now() - 400 * 864e5).toISOString() })[0]; return x.rec.stale; })());
ok('an inventory twice in the export is one', eff([], [rope(), rope()]).length === 1);
ok('an entry that is not an inventory one, or has no id, is ignored', eff([{ id: 'a', op: 'note.set', inv: 'x-rope' }, { id: 'b', op: 'inv.log' }, null], [rope()]).length === 1);
ok('nothing at all: nothing', eff([], []).length === 0 && VI.effective({}).length === 0);

// ── 2. taking the export in, once ─────────────────────────────────────────────────────────────────────────────────────
const target = FL.T.station(C, 'A5');
const plan = VI.adoptionPlan(R, target, NOW);
ok('the plan: the set, then the exported entries in order, each a millisecond after the one before', plan.map(p => p[0]).join() === 'inv.set,inv.log,inv.log,inv.log' && plan.map(p => p[1].log || '-').join() === '-,e1,e2,e3' &&
  plan.every((p, k) => p[2].t === iso(k)), plan.map(p => [p[0], p[1].log, p[2].t]));
ok('…the set carries the project’s target and says it came from the export; the entries say so too and keep who and when', plan[0][1].target === target && plan[0][1].source === 'export' && plan[0][1].fields.name === 'Rope cache' && plan.slice(1).every(p => p[1].source === 'export') && plan[1][1].by === 'Ana' && plan[1][1].date === '2026-01-10');
ok('no plan without a target, for an inventory the library has whole, or for one the export does not know', VI.adoptionPlan(R, '', NOW).length === 0 && VI.adoptionPlan({ exp: null, adopt: false }, target, NOW).length === 0 && VI.adoptionPlan(null, target, NOW).length === 0);
const phoneA = record('pa', plan.concat([['inv.log', FL.invLogBody('x-rope', { date: '2026-11-08', by: 'Ana', action: 'took', items: [{ name: 'Rope 50 m', qty: 1 }] }), { t: iso(10) }]].map(([op, b, x]) => [op, (({ op: _o, ...d }) => d)(Object.assign({ op }, b)), x])));
l = eff(phoneA, [rope(), stash(), dig()]);
const R2 = l.find(i => i.id === 'x-rope');
ok('after the library has it: the same inventory once (not twice), its own entries and the new one, nothing left to take in', l.length === 3 && R2.placed && !R2.adopt && R2.missing.length === 0 && R2.rec.log.length === 4 && R2.rec.contents.map(c => c.name + ':' + c.qty).join() === 'Stove:1,Tarp:1', R2.rec.log.map(e => e.id));
ok('…and no plan for it any more', VI.adoptionPlan(R2, target, NOW).length === 0);
ok('the other two are still only in the export', l.find(i => i.id === 'x-list').adopt && !l.find(i => i.id === 'x-list').placed && l.find(i => i.id === 'x-dig').adopt);
// the next load (the same library, the same export): the same result
l = eff(phoneA.slice(), [rope(), stash(), dig()]);
ok('a second load changes nothing', l.length === 3 && l.find(i => i.id === 'x-rope').rec.log.length === 4);

// ── 3. a newer export has more than the library ───────────────────────────────────────────────────────────────────────
const newer = rope(); newer.log.push({ id: 'e4', date: '2026-10-01', by: 'Di', action: 'left', items: [{ name: 'Lantern', qty: 1 }], text: 'New' });
l = eff(phoneA, [newer, stash(), dig()]);
const R3 = l.find(i => i.id === 'x-rope');
ok('the entry the library lacks is shown with the rest, and the contents count it', R3.rec.log.map(e => e.id).join() === 'e1,e2,e3,e4,' + R2.rec.log[3].id && R3.rec.contents.some(c => c.name === 'Lantern') && R3.missing.join() === 'e4' && R3.adopt && R3.placed, R3.rec.log.map(e => e.id));
const plan3 = VI.adoptionPlan(R3, target, NOW);
ok('…and only that entry is to be taken in (the set is there already)', plan3.length === 1 && plan3[0][0] === 'inv.log' && plan3[0][1].log === 'e4' && plan3[0][1].source === 'export', plan3.map(p => p[1].log));
const phoneA2 = phoneA.concat(record('pa', plan3));
l = eff(phoneA2, [newer, stash(), dig()]);
ok('once taken in it is not shown twice (still five entries)', l.find(i => i.id === 'x-rope').rec.log.length === 5 && l.find(i => i.id === 'x-rope').missing.length === 0 && !l.find(i => i.id === 'x-rope').adopt);
ok('an entry the library removed does not come back from the export', (() => {
  const gone = phoneA.concat(record('pa', [['inv.log', { inv: 'x-rope', log: 'e2', removed: true, prev: {}, base: [] }]]));
  const x = eff(gone, [rope()]).find(i => i.id === 'x-rope');
  return !x.rec.log.some(e => e.id === 'e2') && x.missing.length === 0;
})());
ok('an entry the library changed keeps its change (the export’s old text does not win)', (() => {
  const edited = phoneA.concat(record('pa', [['inv.log', { inv: 'x-rope', log: 'e1', text: 'Changed', prev: { text: 'In the barrel' }, base: [] }]]));
  const x = eff(edited, [rope()]).find(i => i.id === 'x-rope');
  return x.rec.log.find(e => e.id === 'e1').text === 'Changed';
})());

// ── 4. two phones that both took it in merge without a conflict ──────────────────────────────────────────────────────
const phoneB = record('pb', VI.adoptionPlan(R, target, NOW + 5000).concat([['inv.log', (({ op, ...d }) => d)(FL.invLogBody('x-rope', { date: '2026-11-08', by: 'Bo', action: 'left', items: [{ name: 'Stove', qty: 1 }] })), { t: iso(20000) }]]));
l = eff(phoneA.concat(phoneB), [rope()]);
const M = l.find(i => i.id === 'x-rope');
ok('merged: one inventory, the three exported entries once and one from each phone', l.length === 1 && M.rec.log.length === 5 && !M.rec.conflicts && !M.rec.log.some(e => e.conflicts), [M.rec.log.length, M.rec.conflicts, M.rec.log.map(e => e.conflicts)]);
ok('…the contents add up (rope 2 − 1 − 1, stove 1 + 1, tarp)', M.rec.contents.map(c => c.name + ':' + c.qty).join() === 'Stove:2,Tarp:1', M.rec.contents.map(c => c.name + ':' + c.qty));
const L2 = FL.replayProject(phoneA.concat(phoneB), 'p1');
ok('…and FlexLib’s own replay (what FLEX does with the sync file) agrees', L2.inventories['x-rope'].log.length === 5 && !L2.inventories['x-rope'].conflicts && L2.inventories['x-rope'].contents.map(c => c.name + ':' + c.qty).join() === 'Stove:2,Tarp:1');

// ── 5. removed, restored ─────────────────────────────────────────────────────────────────────────────────────────────
const del = phoneA.concat(record('pa', [['inv.del', { inv: 'x-rope', base: [] }]]));
l = eff(del, [rope()]);
ok('removed in the library (even without ever being taken in): it is gone, the export does not bring it back', !l.some(i => i.id === 'x-rope') && eff(record('pa', [['inv.del', { inv: 'x-rope', base: [] }]]), [rope()]).length === 0);
ok('…until it is restored', eff(del.concat(record('pa', [['inv.restore', { inv: 'x-rope', base: [] }]])), [rope()]).some(i => i.id === 'x-rope'));
ok('an inventory made on the phone (not in the export) is shown, and one with no place yet is not', (() => {
  const mine = record('pa', [['inv.set', { inv: 'mine1', target: FL.T.station(C, 'B3'), fields: { name: 'Gear box', desc: '', mode: 'log', list: '' }, prev: null }], ['inv.log', { inv: 'orphan', log: 'z', date: '2026-01-01', action: 'note', text: 'x', prev: null }]]);
  const x = eff(mine, []);
  return x.length === 1 && x[0].rec.name === 'Gear box' && x[0].placed && !x[0].exp && !x[0].adopt;
})());

// ── 6. Find ───────────────────────────────────────────────────────────────────────────────────────────────────────────
l = eff([], [rope(), stash(), dig()]);
const f = q => VI.search(l, q).map(h => h.kind + ':' + h.text);
ok('by name, then by item', f('rope').join() === 'inventory:Rope cache,invitem:Rope 50 m' && f('shovel').join() === 'invitem:Shovel' && f('dig').join() === 'inventory:Dig tools');
ok('a list’s lines are its items', f('carbide').join() === 'invitem:2 x carbide' && f('lamp').join() === 'invitem:spare lamp');
ok('the description counts, after the name', f('barrel').join() === 'inventory:Rope cache');
ok('an exact name first, a start next, a middle last', (() => { const x = VI.search([{ id: 'a', rec: { name: 'Big rope', desc: '', mode: 'log', contents: [] } }, { id: 'b', rec: { name: 'Rope', desc: '', mode: 'log', contents: [] } }, { id: 'c', rec: { name: 'Ropes and more', desc: '', mode: 'log', contents: [] } }, { id: 'd', rec: { name: 'Xrope', desc: '', mode: 'log', contents: [] } }], 'rope'); return x.map(h => h.inv).join() === 'b,c,a,d'; })());
ok('nothing for nothing, or for a stranger', VI.search(l, '').length === 0 && VI.search(l, '   ').length === 0 && f('zzzz').length === 0 && VI.search(null, 'x').length === 0);
ok('an item shows once per inventory however often it is named', VI.search([{ id: 'a', rec: { name: 'Box', desc: '', mode: 'list', list: 'rope\nRope\nrope ladder', contents: [] } }], 'rope').filter(h => h.kind === 'invitem').length === 2);

// ── 7. the form ──────────────────────────────────────────────────────────────────────────────────────────────────────
const rec = R2.rec;
let d = VI.draftOf(rec, null, { by: 'Ana' });
ok('a new entry starts as Left, today, by whoever, with nothing in it', d.action === 'left' && d.date === VI.localDay() && d.by === 'Ana' && d.items.length === 0 && !d.all && d.photos.length === 0 && d.text === '');
d = VI.draftOf(rec, null, { action: 'checked', by: 'Ana' });
ok('a check starts from the contents, “that was everything” on', d.action === 'checked' && d.items.map(i => i.name + ':' + i.qty).join() === 'Stove:1,Tarp:1' && d.all === true, d);
d = VI.draftOf(eff(record('pa', [['inv.set', { inv: 'empty1', target: FL.T.station(C, 'B4'), fields: { name: 'Empty', desc: '', mode: 'log', list: '' }, prev: null }]]), [])[0].rec, null, { action: 'checked' });
ok('a check of nothing recorded starts empty, “everything” off', d.items.length === 0 && d.all === false);
d = VI.draftOf(rec, rec.log[0], {});
ok('editing an entry starts from it (quantities as text, photos kept)', d.action === 'left' && d.date === '2026-01-10' && d.by === 'Ana' && d.items.map(i => i.name + ':' + i.qty).join() === 'Rope 50 m:2,Stove:1' && d.text === 'In the barrel' && d.photos.length === 0 && typeof d.items[0].qty === 'string');
ok('a fixed action can be asked for; a strange one is Left', VI.draftOf(rec, null, { action: 'took' }).action === 'took' && VI.draftOf(rec, null, { action: 'zap' }).action === 'left');
const ck = o => VI.checkDraft(Object.assign({ action: 'left', date: '2026-03-02', by: '', all: false, text: '', items: [{ name: 'Rope', qty: '1' }], photos: [] }, o));
ok('what a form needs: a date, an item (not for a note), a note needs text or a photo', ck({}) === '' && /Date/.test(ck({ date: 'soon' })) && ck({ date: '2026-03' }) === '' && ck({ date: '2019' }) === '' && /item/.test(ck({ items: [{ name: ' ', qty: '' }] })) &&
  /note or add a photo/.test(ck({ action: 'note', items: [] })) && ck({ action: 'note', items: [], text: 'x' }) === '' && ck({ action: 'note', items: [], photos: [{ h: 'a' }] }) === '');
ok('a quantity typed with a comma, or none, or text, means what it should', FL.invItems([{ name: 'A', qty: '2,5' }, { name: 'B', qty: '' }, { name: 'C', qty: 'many' }, { name: 'D', qty: '0' }]).map(i => i.qty).join() === '2.5,1,1,0');

// ── 8. small things ──────────────────────────────────────────────────────────────────────────────────────────────────
ok('a station’s or a surface point’s library target; none without the cave’s id', VI.libTarget({ station: 'A5', cave: 'Cave Ridge' }, C) === 'station:cavetest01:A5' && VI.libTarget({ station: 'A5', cave: 'Cave Ridge' }, null) === '' && VI.libTarget({ target: 'feature:f1' }, null) === 'feature:f1' && VI.libTarget({ target: 'station:x:y' }, null) === '' && VI.libTarget(null, null) === '');
ok('items as text, a name cut short, the day', VI.itemsText([{ name: 'Rope', qty: 2 }, { name: 'Stove', qty: 1 }]) === '2 × Rope, Stove' && VI.shortName('A rather long inventory name', 14) === 'A rather long…' && VI.shortName('Short', 14) === 'Short' && /^\d{4}-\d{2}-\d{2}$/.test(VI.localDay()) && VI.localDay(new Date(2026, 2, 2)) === '2026-03-02');
ok('what an inventory holds, as names: the log’s contents, a list’s lines', VI.itemNames(R.rec).join() === 'Rope 50 m,Stove,Tarp' && VI.itemNames(eff([], [stash()])[0].rec).join() === '2 x carbide,spare lamp');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
