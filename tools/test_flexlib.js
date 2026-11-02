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
const A = device('phoneA', 'Ana'), B = device('phoneB', 'Bo'), PC = device('pc', 'Felipe');
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
  ok('created = the first entry, even with a slower clock', ld.created.who === 'Felipe');
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
  const man = L.syncManifest(S2, 'pc', 'Felipe', L.selectForSync(projEntries, docs, S2, D, null, 'all'));
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

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
