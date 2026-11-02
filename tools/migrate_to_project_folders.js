// Move FLEX projects from the old shared library (user_files/library/) into
// project folders (doc 14): user_files/projects/<name>/ with .flex/ inside.
//
// Copies, never moves or deletes: the old library stays as it is (the
// backup). A project is switched to its folder only after every entry and
// every stored file has been checked in the copy (same ids, same fingerprints).
//
//   node tools/migrate_to_project_folders.js                 dry run: what would happen
//   node tools/migrate_to_project_folders.js --go            do it
//   node tools/migrate_to_project_folders.js --go --originals "<archive folder>"
//        also copy each document's original file (named in its description as
//        "From the <name> archive: <path>") into the project folder at the same
//        path, and record it on the document (op doc.file)
//   --only <project id>    just that project
//
// Env FLEX_LIBRARY_DIR / FLEX_PROJECTS_DIR as for the server (tests).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const GO = args.includes('--go');
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ARCHIVE = opt('--originals');
const ONLY = opt('--only');

const lib = require(path.join(__dirname, '..', 'library.js'));
const FL = require(path.join(__dirname, '..', 'viewer_build', 'libs', 'flexlib.js'));
const ROOT = lib.ROOT;

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const shaFile = f => sha256(fs.readFileSync(f));
const lines = t => String(t || '').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const logFiles = d => { try { return fs.readdirSync(d).filter(n => /^log-[A-Za-z0-9_-]+\.jsonl$/.test(n)).sort(); } catch (_) { return []; } };
const readDir = d => logFiles(d).flatMap(n => lines(fs.readFileSync(path.join(d, n), 'utf8')).map(e => ({ e, file: n })));
const log = (...a) => console.log(...a);
const problems = [];
const fail = m => { problems.push(m); console.error('PROBLEM: ' + m); };

function copyVerified(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const want = shaFile(src);
  if (fs.existsSync(dst)) {
    if (shaFile(dst) === want) return want;
    throw new Error('a different file is already at ' + dst);
  }
  fs.copyFileSync(src, dst + '.part');
  if (shaFile(dst + '.part') !== want) { fs.unlinkSync(dst + '.part'); throw new Error('copy differs: ' + src); }
  fs.renameSync(dst + '.part', dst);
  const st = fs.statSync(src); try { fs.utimesSync(dst, st.atime, st.mtime); } catch (_) {}
  return want;
}
/** A free readable path: "name.ext", or "name (2).ext" if another file holds it. */
function freePath(dir, rel, want) {
  let p = path.join(dir, rel), n = 2;
  const ext = path.extname(rel), base = rel.slice(0, rel.length - ext.length);
  while (fs.existsSync(p) && shaFile(p) !== want) p = path.join(dir, `${base} (${n++})${ext}`);
  return p;
}

(function main() {
  const list = lib.projects();
  const todo = list.filter(p => !p.dir && (!ONLY || p.id === ONLY));
  if (!todo.length) { log('Nothing to migrate: every project already has its folder.'); return; }
  log(GO ? 'Migrating' : 'Dry run (nothing is written; add --go to do it)');
  log('Old library: ' + ROOT + '\nProject folders: ' + lib.PROJECTS_DIR + (ARCHIVE ? '\nOriginals from: ' + ARCHIVE : ''));

  // Everything as it is now, replayed with FLEX's own rules.
  const docsOld = readDir(path.join(ROOT, 'docs'));
  const D = FL.replayDocs(docsOld.map(x => x.e));
  const projState = {};
  for (const p of list) projState[p.id] = FL.replayProject(readDir(path.join(ROOT, 'p-' + p.id)).map(x => x.e), p.id);
  // Which projects each document belongs to (the same test FLEX uses).
  const docProjects = {};
  for (const d of Object.values(D.docs)) docProjects[d.id] = list.filter(p => FL.docInProject(d, projState[p.id])).map(p => p.id);
  const unassigned = Object.keys(docProjects).filter(id => !docProjects[id].length);
  if (unassigned.length) log(`${unassigned.length} document(s) belong to no project: they go to library/docs-unassigned/.`);

  const report = {};
  for (const p of todo) {
    const R = report[p.id] = { name: p.name, entries: 0, docEntries: 0, renders: 0, blobs: 0, surveyFiles: [], originals: 0, originalsMissing: [] };
    const dir = path.join(lib.PROJECTS_DIR, lib.safeName(p.name || p.id));
    log(`\n── ${p.name || p.id} (${p.id}) → ${dir}`);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length && !fs.existsSync(path.join(dir, '.flex', 'project.json'))) { fail(`${dir} exists and isn't a FLEX project folder; skipped`); continue; }
    const S = projState[p.id];
    const projOld = readDir(path.join(ROOT, 'p-' + p.id));
    const docEntries = docsOld.filter(x => !x.e.doc || (docProjects[x.e.doc] || []).includes(p.id));
    R.entries = projOld.length; R.docEntries = docEntries.length;
    // Stored files the project uses: page images of its documents, its survey files.
    const myDocs = Object.values(D.docs).filter(d => (docProjects[d.id] || []).includes(p.id));
    const need = new Set();
    docEntries.forEach(x => (x.e.pages || x.e.add || (x.e.page ? [x.e.page] : [])).forEach(pg => pg && pg.h && need.add(pg.h + '.' + (pg.ext || 'jpg'))));
    projOld.forEach(x => { if (x.e.op === 'cavefile.set' && x.e.h) need.add(x.e.h + '.' + (x.e.ext || 'plt')); });
    const missing = [...need].filter(n => !fs.existsSync(path.join(ROOT, 'blobs', n)));
    if (missing.length) fail(`${p.id}: ${missing.length} stored file(s) referenced but not in the old library (they stay referenced): ${missing.slice(0, 3).join(', ')}`);
    const live = Object.values(S.cavefiles || {}).filter(c => c && !c.removed && c.h);
    const originals = [];
    if (ARCHIVE) for (const d of myDocs) {
      const m = /^From the .+? archive: (.+)$/.exec(d.desc || '');   // any archive's name
      if (!m) continue;
      const rel = m[1].replace(/\\/g, '/');
      if (rel.split('/').includes('..')) { fail(`${d.id}: odd path ${rel}`); continue; }
      const src = path.join(ARCHIVE, rel);
      if (!fs.existsSync(src)) { R.originalsMissing.push(rel); continue; }
      originals.push({ doc: d.id, rel, src });
    }
    log(`  ${projOld.length} project entries, ${docEntries.length} document entries (${myDocs.length} documents), ${need.size} stored files, ${live.length} survey file(s)` + (ARCHIVE ? `, ${originals.length} originals to copy` + (R.originalsMissing.length ? `, ${R.originalsMissing.length} not found` : '') : ''));
    if (!GO) continue;

    // 1. Folder and copies.
    lib.makeFolder(dir, p.id, p.name || '');
    const logDir = path.join(dir, '.flex', 'logs', 'project'), docDir = path.join(dir, '.flex', 'logs', 'docs');
    for (const n of logFiles(path.join(ROOT, 'p-' + p.id))) copyVerified(path.join(ROOT, 'p-' + p.id, n), path.join(logDir, n));
    // Document entries: whole files when every entry belongs here, else just this project's lines.
    const byFile = {};
    docEntries.forEach(x => (byFile[x.file] || (byFile[x.file] = [])).push(x.e));
    for (const [n, es] of Object.entries(byFile)) {
      const all = docsOld.filter(x => x.file === n).length;
      if (es.length === all) copyVerified(path.join(ROOT, 'docs', n), path.join(docDir, n));
      else fs.writeFileSync(path.join(docDir, n), es.map(e => JSON.stringify(e)).join('\n') + '\n');
    }
    for (const n of need) {
      const src = path.join(ROOT, 'blobs', n);
      if (!fs.existsSync(src)) continue;
      const img = /\.(jpg|png|webp)$/.test(n);
      const h = copyVerified(src, path.join(dir, '.flex', img ? 'renders' : 'blobs', n));
      if (h + n.slice(64) !== n) fail(`${n}: fingerprint doesn't match its name`);
      img ? R.renders++ : R.blobs++;
    }
    const files = JSON.parse(fs.readFileSync(path.join(dir, '.flex', 'files.json'), 'utf8') || '{}');
    // Readable copies of the survey files.
    for (const c of live) {
      const src = path.join(ROOT, 'blobs', c.h + '.' + (c.ext || 'plt'));
      if (!fs.existsSync(src)) continue;
      const nm = lib.safeName(String(c.file || c.id || 'survey').replace(/\.plt$/i, '')) + '.' + (c.ext || 'plt');
      const dst = freePath(dir, path.join('Survey data', nm), c.h);
      copyVerified(src, dst);
      files[c.h + '.' + (c.ext || 'plt')] = path.relative(dir, dst).split(path.sep).join('/');
      R.surveyFiles.push(path.relative(dir, dst));
    }
    // Originals.
    const docFile = [];
    for (const o of originals) {
      const dst = freePath(dir, o.rel, shaFile(o.src));
      const h = copyVerified(o.src, dst);
      const ext = path.extname(dst).slice(1).toLowerCase().replace('tiff', 'tif').replace('jpeg', 'jpg');
      const rel = path.relative(dir, dst).split(path.sep).join('/');
      files[h + '.' + ext] = rel;
      docFile.push({ doc: o.doc, file: { h, ext, name: path.basename(dst), path: rel, size: fs.statSync(dst).size } });
      R.originals++;
    }
    fs.writeFileSync(path.join(dir, '.flex', 'files.json'), JSON.stringify(files, null, 1));

    // 2. Check the copy before switching: same entries (by id), every stored file present and right.
    const ids = a => a.map(x => x.e.id).sort().join('\n');
    const projNew = readDir(logDir), docsNew = readDir(docDir);
    if (ids(projNew) !== ids(projOld)) { fail(`${p.id}: project entries differ after copying; not switched`); continue; }
    if (ids(docsNew) !== docEntries.map(x => x.e.id).sort().join('\n')) { fail(`${p.id}: document entries differ after copying; not switched`); continue; }
    let bad = 0;
    for (const n of need) {
      if (!fs.existsSync(path.join(ROOT, 'blobs', n))) continue;
      const f = path.join(dir, '.flex', /\.(jpg|png|webp)$/.test(n) ? 'renders' : 'blobs', n);
      if (!fs.existsSync(f) || shaFile(f) !== n.slice(0, 64)) bad++;
    }
    if (bad) { fail(`${p.id}: ${bad} stored file(s) wrong after copying; not switched`); continue; }

    // 3. Switch the project to its folder (the old library stays as the backup).
    const bak = path.join(ROOT, `projects.before-folders-${new Date().toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(bak)) fs.copyFileSync(path.join(ROOT, 'projects.json'), bak);      // the setup before the first switch
    lib.adoptFolder(p.id, dir);
    // 4. Record each document's original (new entries, by this PC).
    for (const x of docFile) lib.append('docs', Object.assign({ t: new Date().toISOString(), who: 'FLEX (moving to project folders)', op: 'doc.file' }, x), p.id);
    // 5. Read back through the server's own code.
    const back = FL.replayProject(lines(lib.read('p-' + p.id)), p.id);
    const backDocs = FL.replayDocs(lines(lib.read('docs')));
    const same = JSON.stringify(Object.keys(back.caves).sort()) === JSON.stringify(Object.keys(S.caves).sort())
      && Object.keys(back.notes).length === Object.keys(S.notes).length && Object.keys(back.leads).length === Object.keys(S.leads).length
      && Object.keys(back.segments || {}).length === Object.keys(S.segments || {}).length
      && myDocs.every(d => backDocs.docs[d.id] && backDocs.docs[d.id].pages.length === d.pages.length && backDocs.docs[d.id].pages.every(pg => lib.blobPath(pg.h + '.' + (pg.ext || 'jpg'))));
    if (!same) fail(`${p.id}: reading back from the folder doesn't match (the old library is untouched; projects.before-folders-*.json restores the old setup)`);
    else log('  ✓ copied, checked, switched' + (docFile.length ? `, ${docFile.length} originals recorded` : ''));
    fs.writeFileSync(path.join(dir, '.flex', `migration-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(Object.assign({ from: ROOT, at: new Date().toISOString(), ok: same }, R), null, 1));
  }

  // Documents in no project.
  if (GO && unassigned.length) {
    const ud = path.join(ROOT, 'docs-unassigned'); fs.mkdirSync(ud, { recursive: true });
    const es = docsOld.filter(x => x.e.doc && unassigned.includes(x.e.doc)).map(x => x.e);
    const byDev = {}; es.forEach(e => (byDev[e.dev] || (byDev[e.dev] = [])).push(JSON.stringify(e)));
    for (const [dev, ls] of Object.entries(byDev)) {
      const f = path.join(ud, `log-${dev}.jsonl`);
      const have = new Set(fs.existsSync(f) ? lines(fs.readFileSync(f, 'utf8')).map(e => e.id) : []);
      const add = ls.filter(l => !have.has(JSON.parse(l).id));
      if (add.length) fs.appendFileSync(f, add.join('\n') + '\n');
    }
  }
  log('\n' + JSON.stringify(report, null, 1));
  if (problems.length) { console.error(`\n${problems.length} problem(s); see above.`); process.exitCode = 1; }
  else log(GO ? '\nDone. The old library is untouched in ' + ROOT + ' (the backup).' : '\nDry run OK.');
})();
