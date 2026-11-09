// Tests of the project lifecycle: archive, hand-drawn footprint, snapshot at a date, moving a cave between
// projects (flexlib.js rules, and library.js on a throw-away library). Synthetic data only.
//
//   node tools/test_lifecycle.js
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-life-'));
process.env.FLEX_LIBRARY_DIR = path.join(TMP, 'library');
process.env.FLEX_PROJECTS_DIR = path.join(TMP, 'projects');
const L = require(path.join(__dirname, '..', 'viewer_build', 'libs', 'flexlib.js'));
const lib = require(path.join(__dirname, '..', 'library.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };
function device(dev, who) {
  let seq = 0;
  return (op, data, at) => { seq++; return Object.assign({ id: dev + '.' + seq, dev, seq, t: at, who, op }, data); };
}

// ── Archive, footprint ──────────────────────────────────────────────────────
{
  const D = device('pc', 'Cy');
  const log = [D('project.set', { name: 'Ridge test' }, '2026-03-01T10:00:00.000Z')];
  ok('not archived at first', L.replayProject(log, 'p1').archived === null);
  const a = D('project.archive', { archived: true, note: 'done' }, '2026-03-02T10:00:00.000Z');
  let S = L.replayProject(log.concat(a), 'p1');
  ok('archived', S.archived && S.archived.who === 'Cy' && S.archived.note === 'done');
  S = L.replayProject(log.concat(a, D('project.archive', { archived: false }, '2026-03-03T10:00:00.000Z')), 'p1');
  ok('unarchived by the last writer', S.archived === null);
  const ring = [[-100.5, 45.1], [-100.4, 45.1], [-100.4, 45.2]];
  S = L.replayProject(log.concat(D('project.footprint', { ring }, '2026-03-02T11:00:00.000Z')), 'p1');
  ok('hand-drawn footprint', S.footprint && S.footprint.ring.length === 3 && S.footprint.ring[2][1] === 45.2);
  S = L.replayProject(log.concat(D('project.footprint', { ring }, '2026-03-02T11:00:00.000Z'), D('project.footprint', { ring: null }, '2026-03-02T12:00:00.000Z')), 'p1');
  ok('cleared footprint', S.footprint === null);
  S = L.replayProject(log.concat(D('project.footprint', { ring: [[1, 2], [3, 4]] }, '2026-03-02T11:00:00.000Z')), 'p1');
  ok('a ring under three points is no footprint', S.footprint === null);
  ok('older readers: unknown ops change nothing', L.replayProject(log.concat(D('project.frob', {}, '2026-03-02T11:00:00.000Z')), 'p1').name === 'Ridge test');
}

// ── Snapshot at a date ──────────────────────────────────────────────────────
{
  const D = device('pc', 'Cy');
  const day = (n, h = 12) => new Date(2026, 2, n, h, 0, 0).toISOString();     // local noon of March n
  const log = [
    D('project.set', { name: 'Ridge test' }, day(1)),
    D('cave.set', { cave: 'c1', name: 'Cave Ridge', sources: [{ file: 'CR.plt' }] }, day(1)),
    D('cavefile.set', { file: 'CR.plt', h: 'a'.repeat(64), ext: 'plt', place: null }, day(1)),
    D('note.set', { note: 'n1', target: 'cave:c1', text: 'first' }, day(2)),
    D('cave.set', { cave: 'c2', name: 'Little Pit' }, day(5)),
    D('project.archive', { archived: true }, day(9)),
  ];
  ok('snapshot time of a day = its end (local)', L.snapshotTime('2026-03-02') === new Date(2026, 2, 2, 23, 59, 59, 999).toISOString());
  ok('snapshot time of a bad value is null', L.snapshotTime('soon') === null);
  const S2 = L.replayProjectAt(log, 'p1', '2026-03-02');
  ok('snapshot: what was there', L.liveCaves(S2).length === 1 && S2.notes.n1 && S2.archived === null, [L.liveCaves(S2).length, S2.archived]);
  ok('snapshot: a day before anything is empty', L.liveCaves(L.replayProjectAt(log, 'p1', '2026-02-20')).length === 0);
  ok('snapshot: today has it all, archived too', L.liveCaves(L.replayProjectAt(log, 'p1', '2026-03-30')).length === 2 && L.replayProjectAt(log, 'p1', '2026-03-30').archived);
  ok('snapshot: the day itself counts', L.liveCaves(L.replayProjectAt(log, 'p1', '2026-03-05')).length === 2);
  ok('change days, newest first', JSON.stringify(L.changeDays(log)) === '["2026-03-09","2026-03-05","2026-03-02","2026-03-01"]', L.changeDays(log));
  const docs = [{ id: 'pc.1', dev: 'pc', seq: 1, t: day(2), who: 'Cy', op: 'doc.add', doc: 'd1', title: 'Sketch', pages: [], tags: ['cave:c1'] }, { id: 'pc.2', dev: 'pc', seq: 2, t: day(6), who: 'Cy', op: 'doc.add', doc: 'd2', title: 'Later', pages: [], tags: ['cave:c1'] }];
  ok('snapshot of documents', Object.keys(L.replayDocsAt(docs, '2026-03-03').docs).join() === 'd1');
}

// ── Moving a cave: the rules ────────────────────────────────────────────────
const H1 = crypto.createHash('sha256').update('survey one').digest('hex');
const HP = crypto.createHash('sha256').update('page one').digest('hex');
const HX = crypto.createHash('sha256').update('photo one').digest('hex');      // a photo in an inventory's log
const t0 = '2026-03-01T10:00:00.000Z';
function sourceLog() {
  const D = device('pc', 'Cy');
  return [
    D('project.set', { name: 'Ridge test' }, t0),
    D('cave.set', { cave: 'c1', name: 'Cave Ridge', sources: [{ file: 'CR.plt' }], desc: 'a test cave' }, t0),
    D('cave.alias', { cave: 'c1', alias: 'CR.plt' }, t0),
    D('cavefile.set', { file: 'CR.plt', h: H1, ext: 'plt', place: { mode: 'anchor', station: 'A1', lat: 45.1234, lon: -100.5678 } }, t0),
    D('cave.set', { cave: 'c2', name: 'Little Pit', sources: [{ file: 'LP.plt' }] }, t0),
    D('cavefile.set', { file: 'LP.plt', h: H1.replace(/^./, 'b'), ext: 'plt', place: null }, t0),
    D('segment.set', { seg: 's1', cave: 'c1', name: 'First trip', shots: [['A1', 'A2']] }, t0),
    D('arealabel.set', { label: 'l1', file: 'CR.plt', text: 'Big Room', n: 3, e: 4, v: -2 }, t0),
    D('note.set', { note: 'n1', target: 'station:c1:A2', text: 'draughting' }, t0),
    D('note.set', { note: 'n2', target: 'cave:c2', text: 'other cave' }, t0),
    D('lead.set', { lead: 'ld1', target: 'station:c1:A2', fields: { status: 'open', desc: 'a crawl' } }, t0),
    D('lead.set', { lead: 'ld2', target: 'station:c2:B1', fields: { status: 'open' } }, t0),
    D('feature.set', { feature: 'f1', kind: 'point', coords: [[-100.5, 45.1, 0]], name: 'Sink' }, t0),
    D('inv.set', { inv: 'iv1', target: 'station:c1:A2', fields: { name: 'Rope cache', desc: 'Blue barrel', mode: 'log', list: '' }, prev: null }, t0),
    D('inv.log', { inv: 'iv1', log: 'e1', date: '2026-01-10', by: 'Ana', action: 'left', items: [{ name: 'Rope 50 m', qty: 2 }], photos: [{ h: HX, ext: 'jpg' }], text: 'In the barrel', prev: null }, t0),
    D('inv.set', { inv: 'iv2', target: 'station:c2:B1', fields: { name: 'Other cache', mode: 'log' }, prev: null }, t0),
  ];
}
const docLog = [{ id: 'pc.1', dev: 'pc', seq: 1, t: t0, who: 'Cy', op: 'doc.add', doc: 'd1', title: 'Plan sketch', kind: 'sketch-plan', pages: [{ h: HP, ext: 'jpg' }], tags: ['cave:c1', 'station:c1:A2'] },
                { id: 'pc.2', dev: 'pc', seq: 2, t: t0, who: 'Cy', op: 'doc.add', doc: 'd2', title: 'Other', pages: [], tags: ['cave:c2'] }];
{
  const S = L.replayProject(sourceLog(), 'src'), D = L.replayDocs(docLog);
  const B = L.caveBundle(S, D, 'c1');
  ok('bundle: counts', JSON.stringify(B.counts) === JSON.stringify({ files: 1, segments: 1, leads: 1, notes: 1, labels: 1, docs: 1, inventories: 1 }), B.counts);
  ok('bundle: nothing shared', B.shared.length === 0);
  ok('bundle: blobs are the survey file, the page and the inventory\'s photo', B.blobs.map(b => b.h).sort().join() === [H1, HP, HX].sort().join());
  ok('bundle: another cave is none', L.caveBundle(S, D, 'nope') === null);
  const T = L.replayProject([], 'dst');
  const ins = L.caveMoveEntries(B, T, {});
  ok('entries for the destination', ['cave.set', 'cave.alias', 'cavefile.set', 'segment.set', 'arealabel.set', 'lead.set', 'note.set', 'inv.set', 'inv.log'].every(op => ins.some(e => e.op === op)), ins.map(e => e.op));
  const dev = device('pc2', 'Cy'), stamp = (list, t) => list.map(e => dev(e.op, Object.assign({}, e), t));
  let T2 = L.replayProject(stamp(ins, '2026-03-02T10:00:00.000Z').concat(dev('cave.moved', L.moveRecord('m1', 'in', B, { id: 'src', name: 'Ridge test' }), '2026-03-02T10:00:01.000Z')), 'dst');
  ok('destination: the cave, its file and placement', L.liveCaves(T2).length === 1 && T2.cavefiles['CR.plt'].h === H1 && T2.cavefiles['CR.plt'].place.station === 'A1' && T2.aliases['CR.plt'] === 'c1');
  ok('destination: segment, label, note, lead', T2.segments.s1 && !T2.segments.s1.removed && L.areaLabelsOf(T2, 'CR.plt').length === 1 && T2.notes.n1.text === 'draughting' && T2.leads.ld1.fields.desc === 'a crawl');
  ok('destination: the other cave did not come', !T2.caves.c2 && !T2.notes.n2 && !T2.leads.ld2 && !T2.inventories.iv2);
  ok('destination: the inventory, with its place, its log and its photo', L.liveInventories(T2).map(i => i.id).join() === 'iv1' && T2.inventories.iv1.target === 'station:c1:A2' && T2.inventories.iv1.name === 'Rope cache' && T2.inventories.iv1.log.length === 1
    && T2.inventories.iv1.log[0].id === 'e1' && T2.inventories.iv1.log[0].by === 'Ana' && T2.inventories.iv1.photos[0].h === HX && T2.inventories.iv1.contents[0].qty === 2, T2.inventories.iv1);
  ok('destination: its documents are its own now (same cave id)', L.docsOf(L.replayDocs(docLog), T2).map(d => d.id).join() === 'd1');
  ok('destination: a record of the move', L.movesOf(T2).length === 1 && L.movesOf(T2)[0].dir === 'in' && L.movesOf(T2)[0].peer.name === 'Ridge test');
  ok('moving again adds nothing', L.caveMoveEntries(B, T2, {}).length === 0, L.caveMoveEntries(B, T2, {}).map(e => e.op));
  // The source lets go.
  const clr = L.caveMoveClear(B, S);
  let S2 = L.replayProject(sourceLog().concat(stamp(clr, '2026-03-02T10:00:02.000Z'), dev('cave.moved', L.moveRecord('m1', 'out', B, { id: 'dst', name: 'Other area' }), '2026-03-02T10:00:03.000Z')), 'src');
  ok('source: the cave is gone, the other stays', L.liveCaves(S2).map(c => c.id).join() === 'c2');
  ok('source: files, segment, label, note, lead gone', L.liveCavefiles(S2).map(f => f.file).join() === 'LP.plt' && S2.segments.s1.removed && L.areaLabelsOf(S2, 'CR.plt').length === 0 && S2.notes.n1.deleted && S2.leads.ld1.deleted && !S2.notes.n2.deleted && !S2.leads.ld2.deleted);
  ok('source: its inventory is gone (the log stays), the other cave\'s stays', S2.inventories.iv1.deleted && S2.inventories.iv1.log.length === 1 && L.liveInventories(S2).map(i => i.id).join() === 'iv2');
  ok('source: its documents left, the other cave\'s stay', L.docsOf(L.replayDocs(docLog), S2).map(d => d.id).join() === 'd2');
  ok('source: a record "moved to"', L.movesOf(S2)[0].dir === 'out' && L.movesOf(S2)[0].peer.name === 'Other area' && S2.caves.c1.movedTo.id === 'dst');
  ok('source: points stay', !!S2.features.f1);
  // Moving back clears the mark.
  const back = L.caveBundle(T2, L.replayDocs(docLog), 'c1');
  let S3 = L.replayProject(sourceLog().concat(stamp(clr, '2026-03-02T10:00:02.000Z'), dev('cave.moved', L.moveRecord('m1', 'out', B, { id: 'dst', name: 'Other area' }), '2026-03-02T10:00:03.000Z'),
    stamp(L.caveMoveEntries(back, S2, {}), '2026-03-03T10:00:00.000Z'), dev('cave.moved', L.moveRecord('m2', 'in', back, { id: 'dst', name: 'Other area' }), '2026-03-03T10:00:01.000Z')), 'src');
  ok('back again: the cave, its notes and documents are back in the first project', L.liveCaves(S3).length === 2 && S3.notes.n1.text === 'draughting' && !S3.leads.ld1.deleted && !S3.caves.c1.movedTo && L.docsOf(L.replayDocs(docLog), S3).length === 2 && L.movesOf(S3).length === 2);
  ok('back again: its inventory is back with its log (nothing doubled)', L.liveInventories(S3).map(i => i.id).sort().join() === 'iv1,iv2' && S3.inventories.iv1.log.length === 1 && S3.inventories.iv1.photos.length === 1, S3.inventories.iv1);
  // A different file with the same name in the destination: renamed, not overwritten.
  const T3 = L.replayProject([device('x', 'X')('cavefile.set', { file: 'CR.plt', h: 'c'.repeat(64), ext: 'plt' }, t0)], 'dst');
  const rn = L.moveRenames(B, T3);
  ok('a name clash is renamed', rn['CR.plt'] === 'CR (2).plt', rn);
  const ent = L.caveMoveEntries(B, T3, rn);
  ok('renamed in the cave, alias, file and label', ent.find(e => e.op === 'cave.set').sources[0].file === 'CR (2).plt' && ent.find(e => e.op === 'cave.alias').alias === 'CR (2).plt' && ent.find(e => e.op === 'cavefile.set').file === 'CR (2).plt' && ent.find(e => e.op === 'arealabel.set').file === 'CR (2).plt');
  // A file two caves share can't move.
  const sh = L.replayProject(sourceLog().concat(device('z', 'Z')('cave.set', { cave: 'c3', name: 'Third', sources: [{ file: 'CR.plt' }] }, t0)), 'src');
  ok('a file shared with another cave is flagged', L.caveBundle(sh, null, 'c1').shared.join() === 'CR.plt');
}

// ── Moving a cave: the server side, on a throw-away library ─────────────────
{
  lib.setProject('src', 'Ridge test'); lib.setProject('dst', 'Other area');
  const put = (pid, h, ext, text) => lib.putBlob(Buffer.from(text), ext, null, pid);
  const b1 = put('src', null, 'plt', 'survey one'), page = put('src', null, 'jpg', 'page one'), photo = put('src', null, 'jpg', 'photo one');
  ok('test blobs hash as expected', b1.h === H1 && page.h === HP && photo.h === HX);
  sourceLog().forEach(e => lib.append('p-src', Object.assign({}, e, { id: undefined, seq: undefined, dev: undefined })));
  docLog.forEach(e => lib.append('docs', { op: e.op, t: e.t, who: e.who, doc: e.doc, title: e.title, kind: e.kind, pages: e.pages, tags: e.tags }, 'src'));
  fs.mkdirSync(path.join(lib.projDir('src'), 'Caves', 'Cave Ridge'), { recursive: true });
  fs.writeFileSync(path.join(lib.projDir('src'), 'Caves', 'Cave Ridge', 'notes.txt'), 'a file in the cave folder');
  const r1 = lib.moveCave('src', 'dst', 'c1', 'mv1', 'Cy');
  ok('server move ok', r1.ok && !r1.already && r1.counts.notes === 1, r1);
  const rd = pid => L.replayProject(lib.read('p-' + pid).split('\n').filter(Boolean).map(l => JSON.parse(l)), pid);
  const S = rd('src'), T = rd('dst');
  ok('server: destination has the cave and its record', L.liveCaves(T).map(c => c.id).join() === 'c1' && L.movesOf(T)[0].dir === 'in');
  ok('server: source lost it and keeps the record', L.liveCaves(S).map(c => c.id).join() === 'c2' && L.movesOf(S)[0].dir === 'out' && L.movesOf(S)[0].peer.id === 'dst');
  ok('server: survey file and page copied into the destination folder', fs.existsSync(path.join(lib.projDir('dst'), '.flex', 'blobs', H1 + '.plt')) && fs.existsSync(path.join(lib.projDir('dst'), '.flex', 'renders', HP + '.jpg')));
  ok('server: originals stay in the source', fs.existsSync(path.join(lib.projDir('src'), '.flex', 'blobs', H1 + '.plt')));
  ok('server: the inventory moved (log and photo file); the source keeps its removed copy', L.liveInventories(T).map(i => i.id).join() === 'iv1' && T.inventories.iv1.log.length === 1 && r1.counts.inventories === 1
    && fs.existsSync(path.join(lib.projDir('dst'), '.flex', 'renders', HX + '.jpg')) && S.inventories.iv1.deleted && L.liveInventories(S).map(i => i.id).join() === 'iv2', [r1.counts, T.inventories.iv1, S.inventories.iv1]);
  ok('server: the cave folder was copied, not moved', fs.existsSync(path.join(lib.projDir('dst'), 'Caves', 'Cave Ridge', 'notes.txt')) && fs.existsSync(path.join(lib.projDir('src'), 'Caves', 'Cave Ridge', 'notes.txt')));
  const n = lib.read('p-dst').split('\n').filter(Boolean).length, ns = lib.read('p-src').split('\n').filter(Boolean).length;
  const r2 = lib.moveCave('src', 'dst', 'c1', 'mv1', 'Cy');
  ok('server: the same move again is a no-op', r2.already === true && lib.read('p-dst').split('\n').filter(Boolean).length === n && lib.read('p-src').split('\n').filter(Boolean).length === ns);
  let err = ''; try { lib.moveCave('src', 'dst', 'c1', 'mv2', 'Cy'); } catch (e) { err = e.message; }
  ok('server: a cave that is no longer there can\'t move again', /not in the project/.test(err), err);
  // Archive: mirror, read-only, snapshot read.
  const a = lib.setArchived('dst', true, 'Cy');
  ok('archive: recorded and mirrored', a.ok && lib.isArchived('dst') && L.replayProject(lib.read('p-dst').split('\n').filter(Boolean).map(l => JSON.parse(l)), 'dst').archived);
  err = ''; try { lib.moveCave('src', 'dst', 'c2', 'mv3', 'Cy'); } catch (e) { err = e.message; }
  ok('archive: a move into an archived project is refused', /archived/.test(err), err);
  lib.setArchived('dst', false, 'Cy');
  ok('archive: unarchived', !lib.isArchived('dst'));
  // Archived on another device (a sync file brings the entry): the mirror follows.
  lib.merge('p-dst', [{ id: 'other.1', dev: 'other', seq: 1, t: new Date(Date.now() + 5000).toISOString(), who: 'Bo', op: 'project.archive', archived: true }]);
  ok('archive: from another device (sync file) too', lib.isArchived('dst'));
  lib.merge('p-dst', [{ id: 'other.2', dev: 'other', seq: 2, t: new Date(Date.now() + 9000).toISOString(), who: 'Bo', op: 'project.archive', archived: false }]);
  ok('archive: and back', !lib.isArchived('dst'));
  // Snapshot read.
  const all = lib.read('p-src').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const cut = all[3].t;
  ok('snapshot read: only up to the moment', lib.read('p-src', cut).split('\n').filter(Boolean).every(l => JSON.parse(l).t <= cut) && lib.read('p-src', '2000-01-01').trim() === '');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
