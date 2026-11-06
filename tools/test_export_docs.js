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
console.log(`export docs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
