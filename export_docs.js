'use strict';
// Documents for an export: the project's documents that belong to the exported
// caves (or to the project as a whole, or to its leads / features), as the log
// entries that make them plus their page images. Server side of "Include
// documents" in the export dialog; export_terrain.py --docs writes them into
// the zip (docs.json + docs_<sha256>.<ext>), see viewer_inline.py.
//
// Only page images (jpg, png, webp) travel: PDFs, video and original files
// stay in the project. Rules come from flexlib.js (the same file the page runs).
const fs = require('fs');
const path = require('path');
const FL = require('./viewer_build/libs/flexlib.js');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);

/**
 * lib: the library module (read(scope) -> jsonl text, blobPath(name) -> file or null).
 * pid: the project id; caveIds: ids of the caves in the export (null = every cave).
 * Returns { project, caves, entries, pages: [{h, ext, path, size}], docs, skipped: {pdf, other, missing}, bytes }.
 */
function collect(lib, pid, caveIds, caveNames) {
  const lines = t => String(t || '').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const projEntries = lines(lib.read(FL.projScope(pid)));
  const docEntries = lines(lib.read(FL.DOCS));
  const S = FL.replayProject(projEntries, pid);
  const D = FL.replayDocs(docEntries);
  const want = caveIds ? new Set(caveIds) : null;
  // A document goes if it is in the project and is not only about caves that are not in the export.
  const keep = d => {
    if (d.deleted || !FL.docInProject(d, S)) return false;
    if (!want) return true;
    const caveTags = d.tagList.map(FL.parseTarget).filter(p => p.cave);
    return !caveTags.length || caveTags.some(p => want.has(p.cave));   // about no cave in particular, or about one of these
  };
  const docs = Object.values(D.docs).filter(keep);
  const ids = new Set(docs.map(d => d.id));
  const sel = FL.selectForSync([], docEntries, S, D, null, 'all');
  const entries = sel.entries[FL.DOCS].filter(e => (e.doc ? ids.has(e.doc) : true))
    .filter(e => e.doc || [].concat(e.ref != null ? [e.ref] : [], e.refs || []).some(r => { const x = D.byId.get(r); return x && x.doc && ids.has(x.doc); }));
  const pages = [], seen = new Set(), skipped = { pdf: 0, other: 0, missing: 0 };
  let bytes = 0;
  docs.forEach(d => d.pages.forEach(pg => {
    const ext = String(pg.ext || 'jpg').toLowerCase();
    if (ext === 'pdf') { skipped.pdf++; return; }
    if (!IMAGE_EXT.has(ext)) { skipped.other++; return; }
    if (seen.has(pg.h)) return;
    seen.add(pg.h);
    const f = lib.blobPath(pg.h + '.' + ext);
    if (!f) { skipped.missing++; return; }
    let size = 0; try { size = fs.statSync(f).size; } catch (_) { skipped.missing++; return; }
    bytes += size;
    pages.push({ h: pg.h, ext, path: f, size });
  }));
  const caves = Object.values(S.caves).filter(c => !want || want.has(c.id)).map(c => ({ id: c.id, name: c.name || (caveNames && caveNames[c.id]) || '' }));
  return { project: { id: pid, name: S.name || '' }, caves, entries, pages, docs: docs.length, skipped, bytes };
}

module.exports = { collect };
