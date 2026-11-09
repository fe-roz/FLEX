// Photos of inventories in an export (export_inventory.js): which page images the caves payload names, that they join
// the exporter's docs input (a file of their own, or the project's documents' file) as pages without entries, that what
// is not an image or not in the library stays out, and that the exporter reads what this wrote.
// Made-up hashes and files. node tools/test_export_inventory.js
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const X = require('../export_inventory.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 300) : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exinv-'));
const H = n => String(n).repeat(64).slice(0, 64);
const files = {};
for (const [n, ext, size] of [[1, 'jpg', 100], [2, 'png', 300], [3, 'jpg', 50], [4, 'webp', 80]]) { const f = path.join(tmp, H(n) + '.' + ext); fs.writeFileSync(f, Buffer.alloc(size, n)); files[H(n) + '.' + ext] = f; }
const lib = { blobPath: n => files[n] || null };
const log = (...photos) => ({ id: 'e' + Math.random(), date: '2026-03-02', action: 'note', items: [], photos });
const caves = { surveys: [], inventories: [
  { id: 'a', log: [log({ h: H(1), ext: 'jpg' }, { h: H(2), ext: 'png' }), log({ h: H(1), ext: 'jpg' })] },
  { id: 'b', log: [log({ h: H(3), ext: 'JPG' }, { h: H(9), ext: 'jpg' }, { h: 'zz', ext: 'jpg' }, { h: H(4), ext: 'tif' }, { h: H(1), ext: '../x' }, null)] },
  { id: 'c' }, null, { id: 'd', log: [{ photos: [{ h: H(4), ext: 'webp' }] }] },
] };

ok('names: each photo once, images only, tidy hashes and types', JSON.stringify(X.photoNames(caves).sort()) === JSON.stringify([H(1) + '.jpg', H(2) + '.png', H(3) + '.jpg', H(4) + '.webp', H(9) + '.jpg'].sort()), X.photoNames(caves));
ok('names: no inventories, no names', X.photoNames({ surveys: [] }).length === 0 && X.photoNames(null).length === 0 && X.photoNames({ inventories: 'x' }).length === 0);

let c = X.collect(lib, caves, []);
ok('collect: the files that exist, with sizes (one is not in the library)', c.pages.map(p => p.h + '.' + p.ext).sort().join() === [H(1) + '.jpg', H(2) + '.png', H(3) + '.jpg', H(4) + '.webp'].sort().join() && c.missing === 1 && c.bytes === 100 + 300 + 50 + 80, c);
ok('collect: pages the docs input already has are not added twice', X.collect(lib, caves, [H(1), H(2)]).pages.map(p => p.h).sort().join() === [H(3), H(4)].sort().join());

// no docs input yet: a file of its own, --docs pushed, and the file to clean up
const dir1 = fs.mkdtempSync(path.join(tmp, 'a-'));
let args = ['export_terrain.py', '--out', 'x.zip'];
const said = [];
let made = X.addToDocsInput(lib, caves, args, dir1, 'job1', m => said.push(m));
ok('no documents: its own docs input, --docs added to the arguments, the file named for clean-up', made === path.join(dir1, 'docs_job1.json') && args.slice(-2).join(' ') === '--docs ' + made && fs.existsSync(made), { made, args });
const input = JSON.parse(fs.readFileSync(made, 'utf8'));
ok('…pages only: no entries, the page files with their paths', input.entries.length === 0 && input.pages.length === 4 && input.pages.every(p => fs.existsSync(p.path)), input);
ok('…and it says what it did, including the photo that is missing', said.some(m => /1 photo\(s\) are not in the library/.test(m)) && said.some(m => /4 photos/.test(m)), said);

// the project's documents are already there: the photos join that file
const dir2 = fs.mkdtempSync(path.join(tmp, 'b-'));
const docsFile = path.join(dir2, 'docs_job2.json');
fs.writeFileSync(docsFile, JSON.stringify({ project: { id: 'p1', name: 'Test Project' }, caves: [{ id: 'c1', name: 'Cave Ridge' }], entries: [{ id: 'd.1', op: 'doc.add', doc: 'x' }], docs: 1, skipped: {}, bytes: 100,
  pages: [{ h: H(1), ext: 'jpg', path: files[H(1) + '.jpg'], size: 100 }] }));
args = ['export_terrain.py', '--docs', docsFile, '--out', 'x.zip'];
made = X.addToDocsInput(lib, caves, args, dir2, 'job2', null);
const merged = JSON.parse(fs.readFileSync(docsFile, 'utf8'));
ok('with documents: the photos join their file (a page both use is there once), nothing new to clean up', made === null && args.filter(a => a === '--docs').length === 1 && merged.entries.length === 1 && merged.pages.map(p => p.h).sort().join() === [H(1), H(2), H(3), H(4)].sort().join() && merged.project.id === 'p1', merged);
ok('…the documents\' own details are kept', merged.caves.length === 1 && merged.docs === 1 && merged.bytes === 100 + 300 + 50 + 80);

// nothing to add: nothing written
const dir3 = fs.mkdtempSync(path.join(tmp, 'c-'));
args = ['export_terrain.py'];
ok('no photos: nothing is added or written', X.addToDocsInput(lib, { surveys: [], inventories: [{ id: 'a', log: [] }] }, args, dir3, 'job3', null) === null && args.length === 1 && fs.readdirSync(dir3).length === 0);
ok('photos that are all missing: nothing is added', X.addToDocsInput({ blobPath: () => null }, caves, args, dir3, 'job4', null) === null && args.length === 1);

// the exporter reads what this wrote
const py = `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..'))})
from viewer_inline import load_docs, docs_inline_json
side, files = load_docs(sys.argv[1], progress=lambda m: None)
j = json.loads(docs_inline_json(side, lambda n: dict(files)[n].read_bytes()))
print(json.dumps({'entries': len(side['entries']), 'pages': sorted(p['h'][:1] for p in side['pages']), 'files': sorted(f[0][:6] + f[0][-4:] for f in files), 'inline': sorted(k[:1] for k in j.get('inline', {}))}))`;
let out;
try { out = JSON.parse(execFileSync('python3', ['-I', '-c', py, JSON.parse(JSON.stringify(made || path.join(dir1, 'docs_job1.json')))].map(String), { encoding: 'utf8' })); } catch (e) { out = { err: String(e.stderr || e).slice(0, 300) }; }
ok('exporter: pages alone are read, one file per image, all inline', out.entries === 0 && out.pages.join('') === '1234' && out.files.length === 4 && out.files.every(f => /^docs_[0-9]/.test(f)) && out.inline.join('') === '1234', out);
console.log(`export inventory: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
