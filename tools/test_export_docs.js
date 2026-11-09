// Documents in an export (export_docs.js): which of a project's documents travel with the exported
// caves, which pages (images only), and that the exporter's input is what viewer_inline.load_docs reads.
// Made-up project, caves and pages. node tools/test_export_docs.js
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const FL = require('../viewer_build/libs/flexlib.js');
const { collect } = require('../export_docs.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 300) : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exdocs-'));
const H = n => String(n).repeat(64).slice(0, 64);
const files = {};
for (const [n, ext] of [[1, 'jpg'], [2, 'png'], [3, 'jpg']]) { const f = path.join(tmp, H(n) + '.' + ext); fs.writeFileSync(f, Buffer.alloc(100 * n)); files[H(n) + '.' + ext] = f; }
const PID = 'pjtest0001';
const proj = [
  { id: 'a.1', dev: 'a', seq: 1, t: '2026-01-01T00:00:00Z', who: 'T', op: 'project.set', name: 'Test Project' },
  { id: 'a.2', dev: 'a', seq: 2, t: '2026-01-01T00:00:01Z', who: 'T', op: 'cave.set', cave: 'c1', name: 'Cave Ridge' },
  { id: 'a.3', dev: 'a', seq: 3, t: '2026-01-01T00:00:02Z', who: 'T', op: 'cave.set', cave: 'c2', name: 'Other Cave' },
];
const add = (seq, doc, tags, pages) => ({ id: 'd.' + seq, dev: 'd', seq, t: '2026-02-01T00:00:0' + seq + 'Z', who: 'T', op: 'doc.add', doc, title: doc, pages, tags });
const docs = [
  add(1, 'at-station', [`project:${PID}`, 'station:c1:A3'], [{ h: H(1), ext: 'jpg' }, { h: H(9), ext: 'pdf' }]),
  add(2, 'at-other', [`project:${PID}`, 'cave:c2'], [{ h: H(2), ext: 'png' }]),
  add(3, 'inbox', [`project:${PID}`], [{ h: H(3), ext: 'jpg' }, { h: H(4), ext: 'jpg' }]),   // page 4 is not on disk
  add(4, 'gone', [`project:${PID}`], [{ h: H(1), ext: 'jpg' }]),
  { id: 'd.5', dev: 'd', seq: 5, t: '2026-02-02T00:00:00Z', who: 'T', op: 'doc.del', doc: 'gone' },
];
const lib = { read: scope => (scope === FL.projScope(PID) ? proj : scope === FL.DOCS ? docs : []).map(e => JSON.stringify(e)).join('\n'), blobPath: n => files[n] || null };

let c = collect(lib, PID, ['c1']);
ok('only documents of the exported caves (and project-wide ones)', c.docs === 2 && c.entries.every(e => ['at-station', 'inbox'].includes(e.doc)), c.entries.map(e => e.doc));
ok('deleted documents stay out', !c.entries.some(e => e.doc === 'gone'));
ok('pages: images that exist, once each', c.pages.map(p => p.h).sort().join() === [H(1), H(3)].sort().join(), c.pages);
ok('skipped counted: a PDF, a missing file', c.skipped.pdf === 1 && c.skipped.missing === 1, c.skipped);
ok('bytes add up', c.bytes === 100 + 300, c.bytes);
ok('cave names travel for tag labels', c.caves.length === 1 && c.caves[0].name === 'Cave Ridge', c.caves);
c = collect(lib, PID, null);
ok('no cave filter: every live document of the project', c.docs === 3, c.docs);

// the exporter reads what this wrote
const inp = path.join(tmp, 'docs_input.json'); fs.writeFileSync(inp, JSON.stringify(collect(lib, PID, ['c1'])));
const py = `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..'))})
from viewer_inline import load_docs, docs_inline_json
side, files = load_docs(sys.argv[1], progress=lambda m: None)
j = json.loads(docs_inline_json(side, lambda n: dict(files)[n].read_bytes(), 150))
j0 = json.loads(docs_inline_json(side, lambda n: dict(files)[n].read_bytes(), 0))
print(json.dumps({'entries': len(side['entries']), 'pages': [p['h'][:2] for p in side['pages']], 'files': [f[0][:7] for f in files], 'inline': sorted(k[:2] for k in j.get('inline', {})), 'none': 'inline' in j0}))`;
let out;
try { out = JSON.parse(execFileSync('python3', ['-I', '-c', py, inp], { encoding: 'utf8' })); } catch (e) { out = { err: String(e.stderr || e).slice(0, 200) }; }
ok('exporter: entries and page files', out.entries === 2 && out.files.length === 2, out);
ok('exporter: inline cap keeps the small page, leaves the big one to its file', out.inline && out.inline.length === 1 && out.inline[0] === '11', out);
ok('exporter: cap 0 inlines nothing', out.none === false, out);

// ── Groups and tags on one page: what the phone needs to follow the same order ───────────────────────────
// A made-up library with kinds and a tagged page, exported the way the server does (collect), written into a synthetic export
// (tools/make_synthetic_export.py --docs --docs-input), then read back the way the viewer does: the entries of docs.json and of the
// copy inside viewer.html, replayed by flexlib, give the same documents in the same order (docsFor) as the library.
{
  const PJ = 'pjtest0001', C1 = 'cavetest01', C2 = 'caveother9', pad = n => String(n).padStart(2, '0');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exdocs2-'));
  // real little JPEGs (Pillow), stored by their hash like the library does
  const mk = execFileSync('python3', ['-I', '-c', `import sys, io, json, hashlib
from PIL import Image
out = []
for i, col in enumerate([(180, 60, 60), (60, 180, 60), (60, 60, 180), (180, 180, 60), (180, 60, 180), (60, 180, 180)]):
    b = io.BytesIO(); Image.new('RGB', (64 + i, 48), col).save(b, 'JPEG', quality=80); d = b.getvalue()
    h = hashlib.sha256(d).hexdigest(); open(sys.argv[1] + '/' + h + '.jpg', 'wb').write(d); out.append(h)
print(json.dumps(out))`, dir], { encoding: 'utf8' });
  const hs = JSON.parse(mk), pg = (i, extra) => Object.assign({ h: hs[i], ext: 'jpg', w: 64 + i, ht: 48, name: 'p' + i + '.jpg' }, extra || {});
  const blobs = {}; hs.forEach(h => { blobs[h + '.jpg'] = path.join(dir, h + '.jpg'); });
  const E = (seq, op, d) => Object.assign({ id: 'x.' + seq, dev: 'x', seq, t: `2026-03-01T10:00:${pad(seq)}Z`, who: 'T', op }, d);
  const projLog = [E(1, 'project.set', { name: 'Test Project' }), E(2, 'cave.set', { cave: C1, name: 'Cave Ridge' }), E(3, 'cave.set', { cave: C2, name: 'Other Cave' })];
  const SV = 'Main line';
  const docLog = [
    E(10, 'doc.add', { doc: 'book', title: 'Sketchbook 3', kind: 'sketch-plan', pages: [pg(0), pg(1), pg(2)], tags: [`project:${PJ}`, `survey:${C1}:${SV}`] }),
    E(11, 'doc.pagetag', { doc: 'book', h: hs[1], target: `area:${C1}:A2~A4` }),
    E(12, 'doc.add', { doc: 'photo', title: 'Passage photo', kind: 'photo', pages: [pg(3)], tags: [`project:${PJ}`, `station:${C1}:A3`] }),
    E(13, 'doc.add', { doc: 'shots', title: 'Shot table', kind: 'shot-table', pages: [pg(4)], tags: [`project:${PJ}`, `survey:${C1}:${SV}`] }),
    E(14, 'doc.add', { doc: 'loose', title: 'Loose page', kind: 'notes', pages: [pg(5)], tags: ['project:elsewhere'] }),
    E(15, 'doc.pagetag', { doc: 'loose', h: hs[5], target: `station:${C1}:A5` }),                       // in this project only through a tagged page
    E(16, 'doc.add', { doc: 'othercave', title: 'Other cave book', kind: 'sketch-plan', pages: [pg(0)], tags: [`project:elsewhere`] }),
    E(17, 'doc.pagetag', { doc: 'othercave', h: hs[0], target: `station:${C2}:Z1` }),                    // only about a cave that is not exported
  ];
  const lib2 = { read: scope => (scope === FL.projScope(PJ) ? projLog : scope === FL.DOCS ? docLog : []).map(e => JSON.stringify(e)).join('\n'), blobPath: n => blobs[n] || null };
  const c2 = collect(lib2, PJ, [C1]);
  ok('page-tagged documents: the one in the project through a tagged page goes; the one only about another cave does not', c2.docs === 4 && !c2.entries.some(e => e.doc === 'othercave') && c2.entries.some(e => e.doc === 'loose' && e.op === 'doc.pagetag'), c2.entries.map(e => e.id + ':' + e.doc));
  ok('the page-tag entries travel with their documents', c2.entries.filter(e => e.op === 'doc.pagetag').map(e => e.doc).sort().join() === 'book,loose', c2.entries.map(e => e.op));
  ok('groups travel: four, in order, with their kinds', c2.groups.map(g => g.id).join() === 'notes,sketches,media,other' && c2.groups[1].kinds.includes('cross-sections') && c2.groups[0].kinds.includes('topodroid'), c2.groups);
  ok('summary: each document’s kind and group, and which pages carry a tag', (() => { const m = Object.fromEntries(c2.summary.map(x => [x.id, x]));
    return m.book.group === 'sketches' && m.photo.group === 'media' && m.shots.group === 'notes' && m.loose.group === 'notes' && m.book.tagged.length === 1 && m.book.tagged[0].i === 1 && m.book.tagged[0].h === hs[1] && m.book.tagged[0].targets.join() === `area:${C1}:A2~A4` && m.photo.tagged.length === 0; })(), c2.summary);
  const input2 = path.join(dir, 'docs_input.json'); fs.writeFileSync(input2, JSON.stringify(c2));
  const exp = path.join(dir, 'export');
  const env = Object.assign({}, process.env), extra = path.join(os.homedir(), 'opt/pylibs'); if (fs.existsSync(extra)) env.PYTHONPATH = extra + (env.PYTHONPATH ? ':' + env.PYTHONPATH : '');
  let built = true;
  try { execFileSync('python3', [path.join(__dirname, 'make_synthetic_export.py'), exp, '--docs', '--docs-input', input2, '--docs-inline-cap', '1000000'], { env, stdio: 'pipe' }); } catch (e) { built = false; console.log(String(e.stderr || e).slice(0, 400)); }
  ok('a synthetic export is built with those documents (export_terrain.py’s own docs.json / inline writers)', built && fs.existsSync(path.join(exp, 'docs.json')) && fs.existsSync(path.join(exp, 'viewer.html')));
  if (built) {
    const side = JSON.parse(fs.readFileSync(path.join(exp, 'docs.json'), 'utf8'));
    ok('docs.json carries the entries (with the page tag), groups and the summary', side.entries.some(e => e.op === 'doc.pagetag' && e.target === `area:${C1}:A2~A4`) && side.groups.length === 4 && side.summary.length === 4 && side.project.id === PJ, Object.keys(side));
    ok('an image document end to end: every page image is a file of the export, byte for byte', side.pages.length === 6 && side.pages.every(p => fs.readFileSync(path.join(exp, 'docs_' + p.h + '.jpg')).equals(fs.readFileSync(blobs[p.h + '.jpg']))), side.pages.map(p => p.h.slice(0, 6)));
    const html = fs.readFileSync(path.join(exp, 'viewer.html'), 'utf8');
    const at = html.indexOf('window.DOCS_EXPORT = ') + 'window.DOCS_EXPORT = '.length;
    let depth = 0, inStr = false, i = at, end = -1;
    for (; i < html.length; i++) { const ch = html[i]; if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; } else if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { end = i + 1; break; } }
    const inl = at > 20 && end > 0 ? JSON.parse(html.slice(at, end)) : null;
    ok('viewer.html (the single file) carries the same, with the page images inline', inl && inl.entries.length === side.entries.length && inl.groups.length === 4 && Object.keys(inl.inline || {}).length === 6
       && Buffer.from(inl.inline[side.pages[0].h + '.jpg'], 'base64').equals(fs.readFileSync(blobs[side.pages[0].h + '.jpg'])), inl && Object.keys(inl));
    // read back the way the phone does: replay the export's entries with flexlib, ask the same question the desktop asks
    const S0 = FL.replayProject(projLog, PJ), Dlib = FL.replayDocs(docLog), Dexp = FL.replayDocs(inl.entries), Dfile = FL.replayDocs(side.entries);
    const ask = D => FL.docsFor(D, S0, FL.T.station(C1, 'A3'), { codes: [SV] }).items.map(x => [x.id, x.level, x.page, x.group, x.from].join('/')).join(' ');
    const want = 'photo/station/0/media/this station book/area/1/sketches/stations A2–A4 shots/survey/0/notes/survey Main line';
    ok('A3 on the phone’s side: the same documents in the same order as the desktop (station, then the page of A2~A4, then the survey’s notes)', ask(Dlib) === want && ask(Dexp) === want && ask(Dfile) === want, [ask(Dlib), ask(Dexp)]);
    const askSv = D => FL.docsFor(D, S0, FL.T.survey(C1, SV), {}).items.map(x => x.id).sort().join();
    ok('a survey: its own documents, the same from the export', askSv(Dexp) === 'book,shots' && askSv(Dlib) === askSv(Dexp), askSv(Dexp));
    ok('the page tag came across by hash (still on the same page after replay)', Dexp.docs.book.pages[1].h === hs[1] && Dexp.docs.book.pages[1].targets.join() === `area:${C1}:A2~A4`);
  }
}

console.log(`export docs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
