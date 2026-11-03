// surface-merge.js, the pure part: the merged tree of 📍 Surface (CalTopo is the master, the project's folders and
// items merged in by name), the held moves, send counts. Run: node tools/test_surface_merge.js
'use strict';
const assert = require('assert');
const M = require('./load_classic')(require('path').join(__dirname, '..', 'client', 'src', 'modules', 'surface-merge.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok   ' + name); };
const c = (id, name, kids) => ({ id, name, folder: /^ctf-/.test(id), loose: false, kids: kids || [] });
const CT = [
  c('ctf-F1', 'Pits', [c('ct-M0', 'Existing pit'), c('ct-M2', 'Sink')]),
  c('ctf-F2', 'Checked', [c('ctf-F3', 'Deep', [])]),
  c('ct-M1', 'Spring'),
];
const names = list => list.map(x => x.name);

t('CalTopo only: folders, then items, as given', () => {
  const r = M.build({ ct: CT, groups: [], feats: [], moved: {} });
  assert.deepStrictEqual(names(r.kids), ['Pits', 'Checked']);
  assert.deepStrictEqual(names(r.items), ['Spring']);
  assert.deepStrictEqual(names(r.kids[1].kids), ['Deep']);       // an empty CalTopo folder is a folder, not an item
  assert.ok(r.kids.every(k => !k.toSend));
});
t('a project folder is the CalTopo folder of the same name (case, spaces ignored); once', () => {
  const r = M.build({ ct: CT, groups: [{ id: 'gA', name: ' pits ', parent: '' }, { id: 'gB', name: 'Survey', parent: '' }, { id: 'gC', name: 'Inner', parent: 'gB' }],
    feats: [{ id: 'p1', name: 'Cave Ridge pit', group: 'gA', kind: 'point' }, { id: 'p2', name: 'Lone', group: '', kind: 'point' }, { id: 'l1', name: 'Track', group: 'gC', kind: 'line' }], moved: {} });
  assert.deepStrictEqual(names(r.kids), ['Pits', 'Checked', 'Survey']);
  const pits = M.find(r, ['pits']);
  assert.strictEqual(pits.ct.id, 'ctf-F1'); assert.deepStrictEqual(pits.gids, ['gA']); assert.ok(!pits.toSend);
  assert.deepStrictEqual(names(pits.items), ['Existing pit', 'Sink', 'Cave Ridge pit']);
  const sv = M.find(r, ['Survey', 'Inner']);
  assert.ok(sv.toSend && !sv.ct && sv.items[0].feat.id === 'l1');
  assert.ok(r.items.some(i => i.feat && i.feat.id === 'p2'));
  assert.deepStrictEqual(M.sendCount(r), { items: 3, folders: 2 });
  assert.deepStrictEqual(M.sendCount(pits), { items: 1, folders: 0 });
});
t('two project folders with one name join one node', () => {
  const r = M.build({ ct: [], groups: [{ id: 'a', name: 'X', parent: '' }, { id: 'b', name: 'x', parent: '' }], feats: [{ id: 'f', name: 'F', group: 'b', kind: 'point' }], moved: {} });
  assert.strictEqual(r.kids.length, 1); assert.deepStrictEqual(r.kids[0].gids, ['a', 'b']); assert.strictEqual(r.kids[0].items.length, 1);
});
t('a held move to a folder CalTopo does not have yet puts the item (or folder) there, marked moved', () => {
  const r = M.build({ ct: CT, groups: [{ id: 'gB', name: 'Survey', parent: '' }], feats: [], moved: { 'ct-M1': ['Survey'], 'ctf-F2': ['Survey'] } });
  assert.deepStrictEqual(names(r.items), []);
  const sv = M.find(r, ['Survey']);
  assert.ok(sv.items.some(i => i.ct && i.ct.id === 'ct-M1' && i.moved));
  const ch = M.find(r, ['Survey', 'Checked']);
  assert.ok(ch && ch.ct.id === 'ctf-F2' && ch.moved && M.find(r, ['Survey', 'Checked', 'Deep']));
  assert.strictEqual(M.find(r, ['Checked']), null);
});
t('a held move whose target folder is gone stays where CalTopo has it', () => {
  const r = M.build({ ct: CT, groups: [], feats: [], moved: { 'ct-M1': ['Gone'] } });
  assert.deepStrictEqual(names(r.items), ['Spring']);
});
t('within(): a folder and what is inside it', () => {
  const r = M.build({ ct: CT, groups: [], feats: [], moved: {} });
  const a = M.find(r, ['Checked']), b = M.find(r, ['Checked', 'Deep']), p = M.find(r, ['Pits']);
  assert.ok(M.within(a, a) && M.within(a, b) && !M.within(b, a) && !M.within(a, p));
});
t('a project folder whose parent is gone is top level; project-only things sort by name after CalTopo’s', () => {
  const r = M.build({ ct: CT, groups: [{ id: 'z', name: 'Zed', parent: 'nope' }, { id: 'y', name: 'Ay', parent: '' }], feats: [], moved: {} });
  assert.deepStrictEqual(names(r.kids), ['Pits', 'Checked', 'Ay', 'Zed']);
});
console.log(`${n} passed, 0 failed`);
