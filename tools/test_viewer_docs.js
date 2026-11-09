// The rules behind the phone's documents (viewer_build/libs/viewer-docs.js, no DOM): labels, the survey index and the stations
// a cave offers, tag suggestions (a typed range is what FlexLib.specTarget makes of it), what to record to change tags (a
// document's and one page's), recent tags, the shots read from a scanned page, the kind a new document gets.
// Made-up names (Cave Ridge, stations A1…). node tools/test_viewer_docs.js
'use strict';
const FL = require('../viewer_build/libs/flexlib.js');
const VD = require('../viewer_build/libs/viewer-docs.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 400) : '')); } };
const C = 'c1', O = 'c2', PJ = 'p1';

// ── labels ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('a range as the cave’s own card says it', VD.shortLabel(FL.T.area(C, 'A6~A8')) === 'stations A6–A8' && VD.shortLabel(FL.T.area(C, 'A6~A8,B2')) === 'stations A6–A8, B2');
ok('a station, a survey, the cave', VD.shortLabel(FL.T.station(C, 'A3')) === 'station A3' && VD.shortLabel(FL.T.survey(C, 'Main line')) === 'survey Main line' && VD.shortLabel(FL.T.cave(C)) === 'the cave');
ok('anything else is left to the viewer’s own label', VD.shortLabel(FL.T.lead('x'), t => 'LABEL ' + t) === 'LABEL lead:x');
const book = { id: 'book', pages: [{ h: 'a' }, { h: 'b', targets: [FL.T.area(C, 'A2~A3'), FL.T.station(C, 'A2')] }, { h: 'c' }] };
ok('a page hit says which page and why', VD.pageNote(book, 1, { via: 'page', tag: FL.T.area(C, 'A2~A3') }) === ' · page 2: stations A2–A3, station A2');
ok('…the tag that was found comes first', VD.pageNote(book, 1, { via: 'page', tag: FL.T.station(C, 'A2') }) === ' · page 2: station A2, stations A2–A3');
ok('…nothing for a document found as a whole, or a page without tags', VD.pageNote(book, 0, { via: 'doc' }) === '' && VD.pageNote(book, 2, { via: 'page', tag: 'x' }) === '' && VD.pageNote(book, 1, null) === '');
ok('a row’s sub-line: pages, kind, date, then the page note', VD.subOf({ kind: 'sketch-plan', date: '1994', pages: [{}, {}, {}] }, ' · page 2: x') === '3 pages · Sketch (plan) · 1994 · page 2: x');
ok('…a photo and a video are said so', VD.subOf({ kind: 'photo', pages: [{}] }) === 'Photo' && VD.subOf({ kind: 'photo', pages: [{}, {}] }) === '2 photos' && VD.subOf({ kind: 'video', pages: [{}] }) === 'Video');
ok('a group’s heading: its count, and where it comes from when it is not the selection’s own', JSON.stringify(VD.groupHeading({ label: 'Survey notes', items: [1, 2], from: 'survey T' })) === JSON.stringify({ text: 'Survey notes (2)', from: ' · from survey T' }) && VD.groupHeading({ label: 'Media', items: [1], from: '' }).from === '');
ok('the count leaves out the project’s untagged documents (they wait behind a link)', VD.count({ empty: false, items: [{ level: 'survey' }, { level: 'project' }] }) === 1 && VD.count({ empty: true, items: [] }) === 0 && VD.count(null) === 0);

// ── surveys and stations of a cave ───────────────────────────────────────────────────────────────────────────────────────
const sv = (name, cave, st, shots) => ({ name, cave, color: '#fff', stations: st.map(n => ({ name: n })), shots: (shots || []).map(([a, b]) => ({ from_name: a, to_name: b })) });
const surveys = [
  sv('A — Main line', 'Cave Ridge', ['A10', 'A2', 'A1'], [['A1', 'A2'], ['A2', 'A10']]),
  sv('A', 'Cave Ridge', ['A3'], [['A2', 'A3']]),                                   // the same code, a bare name: one survey
  sv('B — North branch', 'Cave Ridge', ['B1'], [['A10', 'B1'], ['B1', 'B2']]),
  sv('A — Another', 'Other Cave', ['A1', 'X9']),
];
const idx = VD.surveyIndex(surveys);
ok('surveys by cave and code: two names of one code are one survey, with the descriptive name', idx.size === 3 && idx.get('Cave Ridge|A').name === 'A — Main line' && idx.get('Cave Ridge|A').shots === 3, [...idx.keys()]);
ok('…its stations are the listed ones and the shots’ ends', [...idx.get('Cave Ridge|A').stations].sort().join() === 'A1,A10,A2,A3' && [...idx.get('Cave Ridge|B').stations].sort().join() === 'A10,B1,B2');
const info = VD.stationInfo(idx, 'Cave Ridge');
ok('what a cave offers the tag box: its surveys (by code) with a description, its stations in natural order', info.surveys.map(s => s.code + '/' + s.desc).join() === 'A/Main line,B/North branch' && info.all.join() === 'A1,A2,A3,A10,B1,B2', info);
ok('…another cave’s surveys and stations stay out', !info.all.includes('X9') && VD.stationInfo(idx, 'Other Cave').all.join() === 'A1,X9');
ok('a survey named by its code alone has no description', VD.descOf('Main line', 'Main line') === '' && VD.descOf('T — Entrance series', 'T') === 'Entrance series');

// ── suggestions ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const cave = { id: C, name: 'Cave Ridge' }, others = [{ label: 'Project · P', target: FL.T.project(PJ) }, { label: 'Cave · Cave Ridge', target: FL.T.cave(C) }, { label: 'Survey A — Main line · Cave Ridge', target: FL.T.survey(C, 'A') },
  { label: 'Cave · Other Cave', target: FL.T.cave(O) }];
const sg = (text, o) => VD.suggest(Object.assign({ text, cave, info, survey: '', has: () => false, others }, o || {}));
['A2~A3', 'A2–A3', 'A2 to A3', 'A2 - A3', 'A2~3', 'A2-3'].forEach(t => {
  const first = sg(t)[0];
  ok(`typed “${t}”: the first suggestion is what FlexLib.specTarget makes of it, with the stations it covers`, first && first.target === FL.specTarget(C, t, info.all) && first.target === FL.T.area(C, 'A2~A3') && first.sub === '2 stations: A2, A3', first);
});
ok('typed in the wrong case, a range and a station are still the cave’s own names', ['a2~a3', 'A2~a3', 'a2 TO a3'].every(x => sg(x)[0].target === FL.T.area(C, 'A2~A3')) && sg('a1')[0].target === FL.T.station(C, 'A1') && sg('a1~')[0].target === FL.T.area(C, 'A1~A2'), [sg('a2~a3')[0], sg('a1')[0]]);
ok('…names the cave does not have are left as typed', VD.matchCase('z9~z10, a1', info.all) === 'z9~z10, A1' && VD.matchCase('t6', []) === 't6');
ok('a station typed that exists is a station', sg('A10')[0].target === FL.T.station(C, 'A10') && sg('a1')[0].label === 'Station A1 · Cave Ridge');
ok('a list is an area too', sg('A1, A3')[0].target === FL.specTarget(C, 'A1, A3', info.all) && sg('A1, A3')[0].target === FL.T.area(C, 'A1,A3'));
ok('the end of a range being typed: the stations that can finish it', sg('A1~').map(s => s.target).slice(0, 3).join() === [FL.T.area(C, 'A1~A2'), FL.T.area(C, 'A1~A3'), FL.T.area(C, 'A1~A10')].join(), sg('A1~').map(s => s.label));
ok('…the range as typed comes first when its end is a station, then what can finish it', (() => { const l = sg('A1~A1').map(s => s.target); return l[0] === FL.T.area(C, 'A1~A1') && l[1] === FL.T.area(C, 'A1~A10') && l.length >= 2; })());
ok('a name that is in no loaded survey is taken as typed, and says so', sg('Z5')[0].target === FL.T.station(C, 'Z5') && /not in the loaded survey/.test(sg('Z5')[0].sub));
ok('a cave whose survey is not loaded takes a range as typed', (() => { const s = sg('T6~T8', { info: { surveys: [], all: [] } })[0]; return s.target === FL.T.area(C, 'T6~T8') && /not loaded/.test(s.sub); })());
ok('with nothing typed: the chosen cave’s own targets first (cave, survey), then the project and other caves, then stations', (() => { const l = sg('').map(s => s.target); return l.slice(0, 4).join() === [FL.T.cave(C), FL.T.survey(C, 'A'), FL.T.project(PJ), FL.T.cave(O)].join() && l.indexOf(FL.T.station(C, 'A1')) === 4; })());
ok('a survey chosen narrows the stations to its own', sg('', { survey: 'B' }).filter(s => /^station:/.test(s.target)).map(s => s.target).join() === [FL.T.station(C, 'A10'), FL.T.station(C, 'B1'), FL.T.station(C, 'B2')].join());
ok('what is already tagged is not offered again', !sg('A1', { has: t => t === FL.T.station(C, 'A1') }).some(s => s.target === FL.T.station(C, 'A1')) && !sg('', { has: t => t === FL.T.project(PJ) }).some(s => s.target === FL.T.project(PJ)));
ok('typed text also finds the project, caves and surveys by their labels', sg('main').map(s => s.target).includes(FL.T.survey(C, 'A')) && sg('ridge').map(s => s.target).includes(FL.T.cave(C)));
ok('at most 40 suggestions, and at most 30 stations of them', (() => { const r = VD.suggest({ text: '', cave, info: { surveys: [], all: Array.from({ length: 200 }, (_, i) => 'S' + i) }, survey: '', has: () => false, others: Array.from({ length: 15 }, (_, i) => ({ label: 'Lead ' + i, target: 'lead:' + i })) }); return r.length === 40 && r.filter(x => /^station:/.test(x.target)).length === 25; })());

// ── what to record to change tags ────────────────────────────────────────────────────────────────────────────────────────
const D = FL.replayDocs([
  { id: 'd.1', dev: 'd', seq: 1, t: '2026-01-01T00:00:01Z', op: 'doc.add', doc: 'bk', title: 'Book', pages: [{ h: 'h0', ext: 'jpg' }, { h: 'h1', ext: 'jpg' }, { h: 'h2', ext: 'jpg' }], tags: ['project:' + PJ, FL.T.survey(C, 'A')] },
  { id: 'd.2', dev: 'd', seq: 2, t: '2026-01-01T00:00:02Z', op: 'doc.pagetag', doc: 'bk', h: 'h1', target: FL.T.area(C, 'A2~A3') },
]);
const bk = D.docs.bk;
const docWant = new Set(bk.tagList), pageWant = new Map([[1, new Set(bk.pages[1].targets)]]);
ok('nothing changed, nothing to record', VD.tagOps(bk, docWant, pageWant).length === 0);
pageWant.set(2, new Set([FL.T.area(C, 'A6~A8')]));
let ops = VD.tagOps(bk, docWant, pageWant);
ok('a tag on page 3 is one doc.pagetag, named by the page’s hash', ops.length === 1 && ops[0][0] === 'doc.pagetag' && JSON.stringify(ops[0][1]) === JSON.stringify({ doc: 'bk', h: 'h2', target: FL.T.area(C, 'A6~A8') }), ops);
pageWant.get(1).delete(FL.T.area(C, 'A2~A3')); docWant.delete(FL.T.survey(C, 'A')); docWant.add(FL.T.cave(C));
ops = VD.tagOps(bk, docWant, pageWant);
ok('removals and additions, of the document and of its pages, in one list', ops.map(o => o[0] + ' ' + (o[1].h || '') + o[1].target).sort().join('|') === ['doc.untag ' + FL.T.survey(C, 'A'), 'doc.tag ' + FL.T.cave(C), 'doc.pageuntag h1' + FL.T.area(C, 'A2~A3'), 'doc.pagetag h2' + FL.T.area(C, 'A6~A8')].sort().join('|'), ops);
// replaying the entries those make gives the wanted tags (the host records them in this order)
const en = ops.map(([op, d], i) => Object.assign({ id: 'd.' + (10 + i), dev: 'd', seq: 10 + i, t: '2026-01-02T00:00:0' + i + 'Z', op }, d));
const D2 = FL.replayDocs([].concat(D.log, en));
ok('…and replaying them gives exactly the wanted tags', JSON.stringify(D2.docs.bk.tagList.slice().sort()) === JSON.stringify([FL.T.cave(C), 'project:' + PJ].sort()) && D2.docs.bk.pages.map(p => (p.targets || []).join()).join('|') === '||' + FL.T.area(C, 'A6~A8'), D2.docs.bk.pages.map(p => p.targets));

// ── recent tags ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const S = FL.replayProject([{ id: 'p.1', dev: 'p', seq: 1, t: '2026-01-01T00:00:01Z', op: 'cave.set', cave: C, name: 'Cave Ridge' }], PJ);
ok('recent tags that still mean something here: this project, its caves and what is in them', VD.recentKeep([FL.T.station(C, 'A1'), FL.T.station(O, 'A1'), 'project:' + PJ, 'project:other', FL.T.lead('x'), 7, FL.T.area(C, 'A1~A2')], S, PJ).join() === [FL.T.station(C, 'A1'), 'project:' + PJ, FL.T.area(C, 'A1~A2')].join());
ok('…nothing from a list that is not a list', VD.recentKeep(null, S, PJ).length === 0 && VD.recentKeep('x', S, PJ).length === 0);

// ── shots read from a scanned page ────────────────────────────────────────────────────────────────────────────────────────
const Dscan = FL.replayDocs([{ id: 's.1', dev: 's', seq: 1, t: '2026-01-01T00:00:01Z', op: 'doc.add', doc: 'sc', title: 'Shot table (scan)', kind: 'shot-table', pages: [{ h: 'x0', ext: 'jpg' }, { h: 'x1', ext: 'jpg' }], tags: ['project:' + PJ] },
  { id: 's.2', dev: 's', seq: 2, t: '2026-01-01T00:00:02Z', op: 'doc.add', doc: 'gone', title: 'Deleted', kind: 'shot-table', pages: [{ h: 'y0', ext: 'jpg' }], tags: ['project:' + PJ] },
  { id: 's.3', dev: 's', seq: 3, t: '2026-01-01T00:00:03Z', op: 'doc.del', doc: 'gone' }]);
const shot = (from, to, src) => Object.assign({ id: from + to, from, to }, src ? { src } : {});
const fs1 = [{ name: 'Scan test', cave: 'Cave Ridge', shots: [shot('A4', 'K1', { doc: 'sc', page: 1, h: 'x1' }), shot('K1', 'K2', { doc: 'sc', page: 1, h: 'x1' }), shot('K2', 'K3'), shot('K3', 'K4', { doc: 'gone', page: 0, h: 'y0' })] },
  { name: 'Elsewhere', cave: 'Other Cave', shots: [shot('A4', 'Q1', { doc: 'sc', page: 0, h: 'x0' })] }];
let ss = VD.scanSources(fs1, 'Cave Ridge', 'K1', Dscan);
ok('a station of scanned shots: one entry per page, with the shots and the survey', ss.length === 1 && ss[0].doc === 'sc' && ss[0].index === 1 && ss[0].title === 'Shot table (scan)' && ss[0].shots.join() === 'A4 → K1,K1 → K2' && ss[0].surveys.join() === 'Scan test', ss);
ok('…a typed shot has no page, a deleted document is not offered, another cave’s shots are not this cave’s', VD.scanSources(fs1, 'Cave Ridge', 'K3', Dscan).length === 0 && VD.scanSources(fs1, 'Cave Ridge', 'K4', Dscan).length === 0 && VD.scanSources(fs1, 'Cave Ridge', 'Q1', Dscan).length === 0 && VD.scanSources(fs1, 'Other Cave', 'Q1', Dscan)[0].index === 0);
ok('…a station that ends one shot and starts another on two pages has two entries', (() => { const f = [{ name: 'S', cave: 'Cave Ridge', shots: [shot('A4', 'K1', { doc: 'sc', page: 0, h: 'x0' }), shot('K1', 'K2', { doc: 'sc', page: 1, h: 'x1' })] }]; return VD.scanSources(f, 'Cave Ridge', 'K1', Dscan).map(x => x.index).join() === '0,1'; })());
ok('the page is found by its hash when the pages were reordered since', (() => { const f = [{ name: 'S', cave: 'Cave Ridge', shots: [shot('A4', 'K1', { doc: 'sc', page: 0, h: 'x1' })] }]; return VD.scanSources(f, 'Cave Ridge', 'K1', Dscan)[0].index === 1; })());
ok('…and by its number when the hash is no longer there', (() => { const f = [{ name: 'S', cave: 'Cave Ridge', shots: [shot('A4', 'K1', { doc: 'sc', page: 5, h: 'gone' })] }]; return VD.scanSources(f, 'Cave Ridge', 'K1', Dscan)[0].index === 1; })());
ok('no station name, no entries', VD.scanSources(fs1, 'Cave Ridge', '', Dscan).length === 0 && VD.scanSources(null, 'Cave Ridge', 'K1', Dscan).length === 0);
ok('a survey in no cave (started at the phone’s position) matches a station in no cave', VD.scanSources([{ name: 'S', cave: '', shots: [shot('P1', 'P2', { doc: 'sc', page: 0, h: 'x0' })] }], '', 'P2', Dscan).length === 1);

// ── the kind of a new document ───────────────────────────────────────────────────────────────────────────────────────────
const kind = (name, ext, camera) => VD.kindForPages([{ name, ext: ext || 'jpg', camera }]);
ok('a phone camera’s name is a photo', kind('IMG_20261108_101500.jpg') === 'photo' && kind('PXL_20261108_101500123.jpg') === 'photo' && kind('DSC01234.JPG') === 'photo');
ok('a picture the host knows came from a camera is a photo whatever its name', kind('page.jpg', 'jpg', true) === 'photo' && kind('Weekend', 'jpg', true) === 'photo');
ok('a scan (by name) is Survey notes, a sketch a sketch, a shot table a shot table', kind('Survey book scan 3.jpg') === 'notes' && kind('sketch of the entrance.jpg') === 'sketch-plan' && kind('shot table 4.jpg') === 'shot-table');
ok('a page of a PDF is Other unless its name says more; the “(2)” of a multi-page file is not part of the name', kind('Trip report.pdf (2)') === 'other' && kind('Survey notes.pdf (12)') === 'notes' && kind('Trip report (2).pdf (1)') === 'other');
ok('no page, no kind', VD.kindForPages([]) === '' && VD.kindForPages(null) === '');
ok('the kind a caller names wins (a scan’s “Shot table”)', VD.kindFor([{ name: 'IMG_1.jpg' }], { kind: 'shot-table' }) === 'shot-table' && VD.kindFor([{ name: 'IMG_1.jpg' }], {}) === 'photo' && VD.kindFor([{ name: 'IMG_1.jpg' }], { kind: '' }) === 'photo');
ok('each group has a kind to stand for it, and the kind lands in that group', FL.DOC_GROUPS.every(g => FL.docGroup(VD.GROUP_KIND[g.id]) === g.id));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
