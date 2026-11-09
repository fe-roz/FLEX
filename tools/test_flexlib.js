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

// 12) Documents: groups, the strict order for a selection, tags on one page (decided 2026-11-08)
{
  const DV = device('docs-pc', 'Cy'), c1 = 'cave1', c2 = 'cave2', c3 = 'cave3';
  const H = n => String(n).repeat(64).slice(0, 64);
  const pg = (n, extra) => Object.assign({ h: H(n), ext: 'jpg', w: 1000, ht: 1400, name: 'p' + n + '.jpg' }, extra || {});
  const proj = [
    DV('cave.set', { cave: c1, name: 'Cave Ridge' }), DV('cave.set', { cave: c2, name: 'Little Pit' }), DV('cave.set', { cave: c3, name: 'Third Hole' }),
    DV('segment.set', { seg: 's1', cave: c1, name: 'Trip 1994', shots: [['T1', 'T2'], ['T2', 'T3']] }),
  ];
  const S = L.replayProject(proj, pid);
  const P = L.T.project(pid);
  const add = (doc, title, kind, tags, pages, extra) => DV('doc.add', Object.assign({ doc, title, kind, pages: pages || [pg(doc.length)], tags }, extra || {}));
  const log = [
    add('book', 'Sketchbook 3', 'sketch-plan', [P, L.T.survey(c1, 'T')], [pg(1), pg(2), pg(3), pg(4), pg(5)]),
    DV('doc.pagetag', { doc: 'book', h: H(3), target: L.T.area(c1, 'T6~T8') }),
    DV('doc.pagetag', { doc: 'book', h: H(5), target: L.T.area(c1, 'T5~T12') }),
    add('photo', 'Passage photo', 'photo', [P, L.T.station(c1, 'T6')]),
    add('shots', 'Shot table T', 'shot-table', [P, L.T.survey(c1, 'T')]),
    add('seg', 'Trip report 1994', 'trip-report', [L.T.segment(c1, 's1')]),
    add('u-sk', 'Survey U sketch', 'sketch-plan', [P, L.T.survey(c1, 'U')]),
    add('other-cave', 'Other cave sketch', 'sketch-plan', [L.T.survey(c2, 'T')]),
    add('other-cave2', 'Other cave map', 'map', [L.T.cave(c2)]),
    add('cave-map', 'Cave map', 'map', [P, L.T.cave(c1)]),
    add('cave-sk', 'Cave overview', 'sketch-plan', [L.T.cave(c1)]),
    add('inbox', 'Unsorted scan', '', [P]),
    add('gone', 'Deleted', 'sketch-plan', [L.T.survey(c1, 'T')]),
    DV('doc.del', { doc: 'gone' }),
    // a document tagged to the project only, with one page tagged to a station: found there, not in the inbox
    add('paged', 'Loose book', 'notes', [P], [pg(6), pg(7)]),
    DV('doc.pagetag', { doc: 'paged', h: H(7), target: L.T.station(c1, 'T9') }),
    add('c3-sk', 'Third hole sketch', 'sketch-plan', [L.T.survey(c3, 'A')]),
  ];
  const D = L.replayDocs(log);
  const ids = r => r.items.map(x => x.id).join();
  const T7 = L.docsFor(D, S, L.T.station(c1, 'T7'), { codes: ['T'] });

  // Page tags: on the page, by its content hash
  ok('page tag lands on the page', D.docs.book.pages[2].targets.join() === L.T.area(c1, 'T6~T8') && !D.docs.book.pages[0].targets, D.docs.book.pages.map(q => q.targets));
  ok('doc tags are unchanged by page tags', D.docs.book.tagList.join() === [P, L.T.survey(c1, 'T')].join());
  ok('docTargets = doc tags + page tags', L.docTargets(D.docs.book).includes(L.T.area(c1, 'T6~T8')) && L.docTargets(D.docs.book).includes(P));

  // Strict order
  ok('T7: the sketchbook first, at the page that covers it (a range)', T7.level === 'area' && T7.items[0].id === 'book' && T7.items[0].page === 2 && T7.items[0].via === 'page' && T7.items[0].tag === L.T.area(c1, 'T6~T8'), T7.items[0]);
  ok('T7: own level is station/area, not a fallback', T7.own && !T7.items[0].fallback && T7.items[0].from === 'stations T6–T8', T7.items[0]);
  ok('T7: the survey’s shot table follows (survey notes it has none of), labelled', T7.items.length === 2 && T7.items[1].id === 'shots' && T7.items[1].fallback && T7.items[1].level === 'survey' && T7.items[1].from === 'survey T', T7.items);
  ok('T7: never other surveys, other caves, the cave’s own, the inbox', !['u-sk', 'other-cave', 'other-cave2', 'cave-map', 'cave-sk', 'inbox', 'gone', 'seg', 'photo'].some(i => ids(T7).includes(i)), ids(T7));
  const T6 = L.docsFor(D, S, L.T.station(c1, 'T6'), { codes: ['T'] });
  ok('T6: the station’s photo before the range page; both are its own level', T6.items[0].id === 'photo' && T6.items[0].level === 'station' && T6.items[1].id === 'book' && T6.items[1].level === 'area' && T6.items[1].page === 2, T6.items.map(x => [x.id, x.level, x.page]));
  ok('T6: narrower range wins the page (T6~T8 before T5~T12)', T6.items[1].pages.join() === '2,4' && T6.items[1].page === 2, T6.items[1]);
  ok('T6: grouped Survey notes (from the survey), Sketches, Media', T6.groups.map(g => g.id).join() === 'notes,sketches,media' && T6.groups[0].fallback && T6.groups[0].from === 'survey T' && !T6.groups[1].fallback && T6.groups[2].items[0].id === 'photo', T6.groups.map(g => [g.id, g.from]));
  ok('T6 without the top-up: only its own level', ids(L.docsFor(D, S, L.T.station(c1, 'T6'), { codes: ['T'], topUp: false })) === 'photo,book');
  const T1 = L.docsFor(D, S, L.T.station(c1, 'T1'), { codes: ['T'] });
  ok('T1: the segment’s documents first, then survey notes/sketches it lacks', T1.level === 'segment' && T1.items[0].id === 'seg' && T1.items.slice(1).map(x => x.id).sort().join() === 'book,shots' && T1.items[1].from === 'survey T', T1.items.map(x => [x.id, x.level]));
  const T11 = L.docsFor(D, S, L.T.station(c1, 'T11'), { codes: ['T'] });
  ok('T11: only the wide range covers it (page 5); the survey’s other docs follow', T11.items[0].id === 'book' && T11.items[0].page === 4 && T11.items[0].via === 'page', T11.items[0]);
  const T20 = L.docsFor(D, S, L.T.station(c1, 'T20'), { codes: ['T'] });
  ok('T20: nothing at its own level → the survey’s, labelled', T20.level === 'survey' && !T20.own && ids(T20).split(',').sort().join() === 'book,shots' && T20.items.every(x => x.fallback && x.from === 'survey T'), ids(T20));
  ok('T20: the survey’s sketchbook is opened at its first page', T20.items.find(x => x.id === 'book').page === 0 && T20.items.find(x => x.id === 'book').via === 'doc');
  const U2 = L.docsFor(D, S, L.T.station(c1, 'U2'), { codes: ['U'] });
  ok('U2: the other survey’s own sketch only', ids(U2) === 'u-sk' && U2.level === 'survey', ids(U2));
  const V1 = L.docsFor(D, S, L.T.station(c1, 'V1'), { codes: ['V'] });
  ok('V1: no survey docs → the cave’s, labelled', V1.level === 'cave' && ids(V1).split(',').sort().join() === 'cave-map,cave-sk' && V1.items[0].from === 'the cave Cave Ridge', V1.items.map(x => [x.id, x.from]));
  const W1 = L.docsFor(D, S, L.T.station(c3, 'A1'), { codes: ['A'] });
  ok('another cave’s station: that cave’s survey only', ids(W1) === 'c3-sk', ids(W1));
  const Z1 = L.docsFor(D, S, L.T.station('nocave', 'Z1'), { codes: ['Z'] });
  ok('a cave with nothing → the project’s untagged documents, and no document tagged to a cave', Z1.level === 'project' && ids(Z1) === 'inbox' && !Z1.own, ids(Z1));
  ok('the loose book (project + a tagged page) is not in the inbox, not general', !L.docInbox(D.docs.paged, S) && L.docInbox(D.docs.inbox, S) && !ids(Z1).includes('paged'));
  const T9 = L.docsFor(D, S, L.T.station(c1, 'T9'), { codes: ['T'] });
  ok('T9: a page tagged to the station shows its document (and the wide range page)', T9.items.map(x => x.id).slice(0, 2).join() === 'paged,book' && T9.items[0].page === 1, T9.items.map(x => [x.id, x.page]));
  ok('docInProject through a page tag only', L.docInProject({ tagList: ['project:elsewhere'], pages: [{ targets: [L.T.station(c1, 'T9')] }] }, S) && !L.docInProject({ tagList: ['project:elsewhere'], pages: [{ targets: [L.T.station('zz', 'T9')] }] }, S));

  // A survey, a cave, the project
  const sv = L.docsFor(D, S, L.T.survey(c1, 'T'), { stations: ['T1', 'T6', 'T7', 'T8', 'T9'] });
  ok('survey T: its own documents only (tagged to it)', sv.level === 'survey' && sv.own && ids(sv).split(',').sort().join() === 'book,shots', ids(sv));
  ok('survey with nothing → the cave’s, never another survey’s', ids(L.docsFor(D, S, L.T.survey(c1, 'Q'), {})).split(',').sort().join() === 'cave-map,cave-sk' && L.docsFor(D, S, L.T.survey(c1, 'Q'), {}).level === 'cave');
  const c2doc = L.docsFor(D, S, L.T.survey(c2, 'Q'), {});
  ok('survey of a cave whose map is tagged to it: that map', c2doc.level === 'cave' && ids(c2doc) === 'other-cave2', ids(c2doc));
  const sw = L.docsFor(D, S, L.T.survey(c3, 'B'), { stations: [] });
  ok('survey B of a cave whose only sketch is survey A’s: never survey A’s → the project’s untagged documents', sw.level === 'project' && ids(sw) === 'inbox', ids(sw));
  const inside = L.docsFor(D, S, L.T.survey(c1, 'U2x'), { stations: [] });
  ok('a survey with no docs and no stations → the cave’s', inside.level === 'cave');
  const t2 = [add('only-station', 'T3 only', 'sketch-plan', [L.T.station(c1, 'W3')]), add('only-range', 'Range', 'sketch-plan', [P], [pg(8)]), DV('doc.pagetag', { doc: 'only-range', h: H(8), target: L.T.area(c1, 'W1~W5') })];
  const D2 = L.replayDocs(log.concat(t2));
  ok('survey W, no docs of its own: the pages/docs of its stations (within), range or station', L.docsFor(D2, S, L.T.survey(c1, 'W'), { stations: ['W1', 'W2', 'W3'] }).level === 'within'
     && ids(L.docsFor(D2, S, L.T.survey(c1, 'W'), { stations: ['W1', 'W2', 'W3'] })).split(',').sort().join() === 'only-range,only-station', ids(L.docsFor(D2, S, L.T.survey(c1, 'W'), { stations: ['W1', 'W2', 'W3'] })));
  ok('…without the survey’s station list it falls back to the cave', L.docsFor(D2, S, L.T.survey(c1, 'W'), {}).level === 'cave');
  const cv = L.docsFor(D, S, L.T.cave(c1), {});
  ok('cave: its own documents only', cv.level === 'cave' && cv.own && ids(cv).split(',').sort().join() === 'cave-map,cave-sk', ids(cv));
  const cv3 = L.docsFor(D, S, L.T.cave(c3), {});
  ok('cave with none of its own: what is tagged inside it (its surveys, stations, pages), labelled', cv3.level === 'within' && ids(cv3) === 'c3-sk' && cv3.items[0].from === 'its surveys and stations', cv3.items);
  const pr = L.docsFor(D, S, L.T.project(pid), {});
  ok('project: the untagged documents', pr.level === 'project' && ids(pr) === 'inbox', ids(pr));
  ok('nothing anywhere → empty', L.docsFor(L.replayDocs([]), S, L.T.station(c1, 'T7'), { codes: ['T'] }).empty === true && L.docsFor(null, S, L.T.station(c1, 'T7'), {}).items.length === 0);
  ok('lead / feature: exactly what is tagged to it', ids(L.docsFor(L.replayDocs([add('ld', 'Lead photo', 'photo', [L.T.lead('L1')])]), S, L.T.lead('L1'), {})) === 'ld');

  // docsForStation keeps its shape and sees page tags
  const old = L.docsForStation(D, S, c1, 'T6', ['T']);
  ok('docsForStation: station / area / survey lists, page tags included', old.station.map(d => d.id).join() === 'photo' && old.area.map(d => d.id).join() === 'book' && old.survey.map(d => d.id).join() === 'shots' && old.cave.map(d => d.id).sort().join() === 'cave-map,cave-sk' && old.segment.length === 0, old);
  ok('docsForStation: the page-tagged station', L.docsForStation(D, S, c1, 'T9', ['T']).station.map(d => d.id).join() === 'paged');

  // pageFor sees ranges
  ok('pageFor: exact page tag, a range covering a station, else the first', L.pageFor(D.docs.book, L.T.area(c1, 'T6~T8')) === 2 && L.pageFor(D.docs.book, L.T.station(c1, 'T7')) === 2 && L.pageFor(D.docs.book, L.T.station(c1, 'T11')) === 4 && L.pageFor(D.docs.book, L.T.station(c1, 'T1')) === 0);
  ok('pagesCovering: every page that has the station', L.pagesCovering(D.docs.book, L.T.station(c1, 'T7')).join() === '2,4');

  // Page tags through the log: untag, reorder, remove and put back, a tag before its page, old entries
  const more = [DV('doc.pageuntag', { doc: 'book', h: H(5), target: L.T.area(c1, 'T5~T12') }), DV('doc.pagetag', { doc: 'book', h: H(2), target: L.T.station(c1, 'T2') })];
  let D3 = L.replayDocs(log.concat(more));
  ok('untagging a page removes only that tag', D3.docs.book.pages[4].targets.length === 0 && D3.docs.book.pages[2].targets.length === 1 && D3.docs.book.pages[1].targets.join() === L.T.station(c1, 'T2'));
  const re = DV('doc.order', { doc: 'book', order: [H(5), H(4), H(3), H(2), H(1)] });
  D3 = L.replayDocs(log.concat(more, [re]));
  ok('reordering pages: the tags stay with their pages (by hash, not by position)', D3.docs.book.pages.map(q => q.h[0]).join('') === '54321' && D3.docs.book.pages[2].targets.join() === L.T.area(c1, 'T6~T8') && D3.docs.book.pages[3].targets.join() === L.T.station(c1, 'T2') && L.pageFor(D3.docs.book, L.T.station(c1, 'T7')) === 2);
  const drop = DV('doc.droppage', { doc: 'book', h: H(3), page: D.docs.book.pages[2], at: 2 });
  const undo = DV('doc.pages', { doc: 'book', add: [D.docs.book.pages[2]], at: 2 });
  D3 = L.replayDocs(log.concat([drop]));
  ok('removing a page takes its tag with it', D3.docs.book.pages.length === 4 && L.docsFor(D3, S, L.T.station(c1, 'T7'), { codes: ['T'] }).items[0].page === 3 && L.docsFor(D3, S, L.T.station(c1, 'T7'), { codes: ['T'] }).items[0].tag === L.T.area(c1, 'T5~T12'));
  D3 = L.replayDocs(log.concat([drop, undo]));
  ok('putting the page back (undo) brings its tag back', D3.docs.book.pages.length === 5 && D3.docs.book.pages[2].h === H(3) && D3.docs.book.pages[2].targets.join() === L.T.area(c1, 'T6~T8'));
  const early = DV('doc.pagetag', { doc: 'late', h: H(9), target: L.T.station(c1, 'T4') }), lateAdd = DV('doc.pages', { doc: 'late', add: [pg(9)] });
  D3 = L.replayDocs([add('late', 'Late page', 'sketch-plan', [P], [pg(8)]), Object.assign({}, early, { t: '2026-10-25T09:00:00.000Z' }), lateAdd]);
  ok('a page tag that arrives before its page waits for it', D3.docs.late.pages.length === 2 && D3.docs.late.pages[1].targets && D3.docs.late.pages[1].targets.join() === L.T.station(c1, 'T4'), D3.docs.late.pages);
  ok('tagging twice is one tag; a tag without a target is ignored', (() => { const d = L.replayDocs([add('x', 'x', '', [P], [pg(1)]), DV('doc.pagetag', { doc: 'x', h: H(1), target: 'station:c:Q' }), DV('doc.pagetag', { doc: 'x', h: H(1), target: 'station:c:Q' }), DV('doc.pagetag', { doc: 'x', h: H(1) })]); return d.docs.x.pages[0].targets.length === 1; })());
  // An old reader's view: a log without any of the new ops replays as before; old entries with page targets (segments) still work
  const oldLog = [DV('doc.add', { doc: 'o1', title: 'Book', pages: [{ h: 'aa', ext: 'jpg' }, { h: 'bb', ext: 'jpg', targets: [L.T.segment(c1, 's1')] }], tags: [L.T.segment(c1, 's1')] })];
  const Do = L.replayDocs(oldLog);
  ok('old entries replay unchanged (page targets from doc.add, no new fields)', Do.docs.o1.pages[1].targets.join() === L.T.segment(c1, 's1') && Do.docs.o1.pages[0].targets === undefined && L.pageFor(Do.docs.o1, L.T.segment(c1, 's1')) === 1);
  ok('…and a segment’s page still opens first for a station in it', L.docsFor(Do, S, L.T.station(c1, 'T2'), { codes: ['T'] }).items[0].page === 1);
  ok('an op the reader does not know about a page changes nothing', L.replayDocs(oldLog.concat([DV('doc.pagefrob', { doc: 'o1', h: 'bb' })])).docs.o1.pages.length === 2);
  // proposals: a suggested page tag changes nothing until accepted
  const prop = DV('doc.pagetag', { doc: 'book', h: H(1), target: L.T.station(c1, 'T4'), proposed: { by: 'archive', confidence: 0.7 } });
  D3 = L.replayDocs(log.concat([prop]));
  ok('a suggested page tag is not applied; accepted it is', !D3.docs.book.pages[0].targets && L.reviewQueue(null, D3).length === 1
     && L.replayDocs(log.concat([prop, DV('accept', { ref: prop.id, base: [prop.id] })])).docs.book.pages[0].targets.join() === L.T.station(c1, 'T4'));
  // sync and moving a cave carry page tags
  const selA = L.selectForSync(S.log, log, S, D, null, 'all');
  ok('a sync file carries the page-tag entries of the project’s documents', selA.entries.docs.filter(e => e.op === 'doc.pagetag').length === 3, selA.entries.docs.map(e => e.op));
  const oneDoc = L.replayDocs([add('pg-only', 'Pages only', 'sketch-plan', ['project:zzz'], [pg(3)]), DV('doc.pagetag', { doc: 'pg-only', h: H(3), target: L.T.station(c1, 'T3') })]);
  ok('moving a cave takes along documents that only have a page tagged to it', L.caveBundle(S, oneDoc, c1).docs.join() === 'pg-only');
  ok('segment counts include documents with a tagged page', L.segmentStates(S, L.replayDocs([add('sgd', 's', '', [P], [pg(1)]), DV('doc.pagetag', { doc: 'sgd', h: H(1), target: L.T.segment(c1, 's1') })]), c1).s1.docs === 1);

  // The tag a person types: one name is a station, a range or a list is an area
  const sp = x => L.specTarget(c1, x);
  ok('typed station → station tag', sp('T6') === L.T.station(c1, 'T6') && sp('  T6 ') === L.T.station(c1, 'T6'));
  ok('typed ranges → area tag, the same spec however it is written', ['T6~T8', 'T6 to T8', 'T6–T8', 'T6 - T8', 'T6~8', 'T6-8'].every(x => sp(x) === L.T.area(c1, 'T6~T8')), ['T6~T8', 'T6 to T8', 'T6–T8', 'T6 - T8', 'T6~8', 'T6-8'].map(sp));
  ok('typed list → area tag', sp('T6~T8, T12') === L.T.area(c1, 'T6~T8,T12') && sp('T6,T9') === L.T.area(c1, 'T6,T9'));
  ok('a known station with a hyphen stays a station', L.specTarget(c1, 'A1-2', ['A1-2']) === L.T.station(c1, 'A1-2') && L.specTarget(c1, 'A1-2', []) === L.T.area(c1, 'A1~A2'));
  ok('nothing typed → no tag', sp('') === null && sp('  ,  ') === null);
  ok('areaHas still reads what normalizeSpec wrote', L.areaHas(L.normalizeSpec('T6-8'), 'T7') && !L.areaHas(L.normalizeSpec('T6-8'), 'T9'));
  ok('area span: a range counts its numbers', L.areaSpan('T6~T8') === 3 && L.areaSpan('T5~T12') === 8 && L.areaSpan('A1,B2') === 2 && L.areaSpan('A10~A22,B3') === 14);
  ok('stations an area covers, from a list', L.areaStations('T6~T8', ['T5', 'T6', 'T7', 'T8', 'T9', 'U7']).join() === 'T6,T7,T8');

  // Groups
  ok('four groups, in order', L.DOC_GROUPS.map(g => g.id).join() === 'notes,sketches,media,other' && L.DOC_GROUPS.map(g => g.label).join() === 'Survey notes,Sketches,Media,Other');
  const gr = { 'shot-table': 'notes', notes: 'notes', topodroid: 'notes', 'sketch-plan': 'sketches', 'sketch-profile': 'sketches', 'cross-sections': 'sketches', photo: 'media', video: 'media',
    'trip-report': 'other', map: 'other', letter: 'other', other: 'other', '': 'other', 'something new': 'other', 'Survey Notes': 'notes', 'field notes': 'notes', Sketch: 'sketches', Photos: 'media' };
  ok('every kind has its group; old and free-typed kinds are mapped, unknown is Other', Object.keys(gr).every(k => L.docGroup(k) === gr[k]), Object.keys(gr).filter(k => L.docGroup(k) !== gr[k]));
  ok('every kind the list offers is in a group', L.DOC_KINDS.every(k => L.DOC_GROUPS.some(g => g.kinds.includes(k))));
  const gd = k => ({ kind: k, pages: [], tags: {}, tagList: [] });
  ok('a document with no kind: photo images are Media, a PDF is Other', L.docGroupOf({ kind: '', pages: [{ name: 'a.jpg' }, { name: 'b.png' }] }) === 'media' && L.docGroupOf({ kind: '', pages: [{ name: 'a.pdf' }] }) === 'other' && L.docGroupOf(gd('')) === 'other');
  ok('a video file is Media whatever the kind', L.docGroupOf({ kind: 'trip-report', file: { ext: 'mp4' }, pages: [] }) === 'media');
  ok('a page’s own kind wins for the page', L.pageGroup({ kind: 'notes', pages: [] }, { kind: 'sketch-plan' }) === 'sketches' && L.pageGroup({ kind: 'notes', pages: [] }, {}) === 'notes');
  ok('a kind on the pages only decides the document', L.docGroupOf({ kind: '', pages: [{ name: 'a.jpg', kind: 'shot-table' }] }) === 'notes');
  ok('groupDocs: groups in order, empty ones left out (or all)', L.groupDocs([D.docs.photo, D.docs.book, D.docs.shots, D.docs['cave-map']]).map(g => g.id + ':' + g.docs.map(d => d.id).join('+')).join() === 'notes:shots,sketches:book,media:photo,other:cave-map' && L.groupDocs([], { all: true }).length === 4 && L.groupDocs([]).length === 0);
  ok('an item takes the group of the page it was found by', (() => { const dd = L.replayDocs([add('mix', 'Mixed', 'sketch-plan', [P], [pg(1), pg(2, { kind: 'shot-table' })]), DV('doc.pagetag', { doc: 'mix', h: H(2), target: L.T.station(c1, 'M1') })]); const r = L.docsFor(dd, S, L.T.station(c1, 'M1'), {}); return r.items[0].group === 'notes' && r.items[0].page === 1; })());
  // New documents: a sensible kind
  const sk = (name, type, camera) => L.suggestKind({ name, type, camera });
  ok('suggested kinds: camera photo → Media, scan → Survey notes, video, TopoDroid export', sk('IMG_0412.jpg') === 'photo' && sk('PXL_2026.jpg') === 'photo' && sk('whatever.jpg', 'image/jpeg', true) === 'photo' && sk('scan 12.tif') === 'notes'
     && sk('Survey book p3.jpg') === 'notes' && sk('T6 sketch.png') === 'sketch-plan' && sk('clip.mp4', 'video/mp4') === 'video' && sk('plot.dxf') === 'topodroid' && sk('report.pdf') === 'other' && sk('field notes.pdf') === 'notes' && sk('cave.jpg', 'image/jpeg') === 'photo', ['IMG_0412.jpg', 'scan 12.tif', 'Survey book p3.jpg', 'T6 sketch.png', 'clip.mp4', 'plot.dxf', 'report.pdf', 'cave.jpg'].map(n => sk(n)));
  ok('suggested kinds always belong to a group', ['photo', 'notes', 'sketch-plan', 'video', 'topodroid', 'other'].every(k => L.DOC_KINDS.includes(k)));
  // exifCamera: a JPEG with an Exif block that has a Make tag
  const jpeg = (withMake) => { const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, withMake ? 0x0f : 0x12, withMake ? 0x01 : 0x01, 2, 0, 2, 0, 0, 0, 0x41, 0, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0].concat(tiff), len = body.length + 2;
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255].concat(body, [0xff, 0xd9])); };
  ok('exifCamera: Make present → camera; no Make or not a JPEG → not', L.exifCamera(jpeg(true)) === true && L.exifCamera(jpeg(false)) === false && L.exifCamera(Uint8Array.from([1, 2, 3])) === false && L.exifCamera(null) === false);
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
