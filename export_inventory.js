'use strict';
// Photos of inventories for an export. The caves payload the page sends (caves.inventories[].log[].photos) names the
// photos by content hash; this finds those page images in the library and hands them to the exporter the way the
// documents' pages go: as pages in the --docs input (export_terrain.py writes docs.json "pages" and one file per image,
// docs_<sha256>.<ext>, inline in the single-file viewer up to its cap). They need no document entries, so the input may
// carry pages only. Only images travel (jpg, png, webp); a photo missing from the library is left out.
const fs = require('fs');
const path = require('path');

const NAME = /^([0-9a-f]{64})\.(jpg|jpeg|png|webp)$/;

/** The photo files named in a caves payload: ['<sha256>.<ext>', …], each once. */
function photoNames(caves) {
  const out = new Set();
  ((caves && caves.inventories) || []).forEach(iv => ((iv && iv.log) || []).forEach(e => ((e && e.photos) || []).forEach(p => {
    const n = p && typeof p.h === 'string' ? p.h + '.' + String(p.ext || 'jpg').toLowerCase() : '';
    if (NAME.test(n)) out.add(n);
  })));
  return [...out];
}

/**
 * lib: the library module (blobPath(name) → file or null). have: pages the docs input already carries (hashes to skip).
 * → { pages: [{ h, ext, path, size }], missing, bytes }
 */
function collect(lib, caves, have) {
  const seen = new Set(have || []), pages = [];
  let missing = 0, bytes = 0;
  photoNames(caves).forEach(n => {
    const m = NAME.exec(n);
    if (seen.has(m[1])) return;
    const f = lib.blobPath(n);
    let size = 0;
    try { size = f ? fs.statSync(f).size : 0; } catch (_) { size = 0; }
    if (!f || !size) { missing++; return; }
    seen.add(m[1]);
    bytes += size;
    pages.push({ h: m[1], ext: m[2], path: f, size });
  });
  return { pages, missing, bytes };
}

/**
 * Add the inventories' photos to the exporter's args. If args already has `--docs <file>` (the project's documents) the
 * pages are added to that file; otherwise a file of its own is written into `dir` and `--docs` pushed.
 * → the path of a file it made (for the caller to delete when the job ends), or null.
 */
function addToDocsInput(lib, caves, args, dir, jobId, say) {
  const i = args.indexOf('--docs');
  let input = null, file = null, made = null;
  if (i >= 0 && args[i + 1]) {
    file = args[i + 1];
    try { input = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { input = null; }
  }
  const c = collect(lib, caves, input && input.pages ? input.pages.map(p => p.h) : []);
  if (c.missing && say) say(`Inventories: ${c.missing} photo(s) are not in the library and stay out`);
  if (!c.pages.length) return null;
  if (!input) {
    input = { project: null, caves: [], entries: [], pages: [], docs: 0, skipped: { pdf: 0, other: 0, missing: 0 }, bytes: 0 };
    file = path.join(dir, `docs_${jobId}.json`);
    made = file;
    args.push('--docs', file);
  }
  input.pages = (input.pages || []).concat(c.pages);
  input.bytes = (input.bytes || 0) + c.bytes;
  fs.writeFileSync(file, JSON.stringify(input));
  if (say) say(`Inventories: ${c.pages.length} photo${c.pages.length === 1 ? '' : 's'} (${(c.bytes / 1048576).toFixed(1)} MB)`);
  return made;
}

module.exports = { photoNames, collect, addToDocsInput };
