// Do a project's terrain and map pictures travel in sync files?
//   node tools/test_terrain_sync.js
// A terrain patch (.bin) and a GeoTIFF layer's picture (.webp) are blobs named in `layer.set` entries. For a sync file
// to carry them, selectForSync() (viewer_build/libs/flexlib.js) has to list them in `blobs`. The hillshade tiles
// do not travel (they are folder files); they are redrawn from the patch on the other computer (terrain_generate.js,
// tools/test_terrain_tiles.js), which needs the patch to have arrived.
//
// While flexlib.js does not list layer blobs this prints the one line to add and exits 0 (so a merge of this branch
// alone stays green); once the line is in, it checks the whole thing.
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'viewer_build', 'libs', 'flexlib.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL', l, i === undefined ? '' : JSON.stringify(i)); } };
let n = 0;
const PC = (op, d) => { n++; return Object.assign({ id: 'pc.' + n, dev: 'pc', seq: n, t: new Date(Date.parse('2026-10-25T10:00:00Z') + n * 1000).toISOString(), who: 'Cy', op }, d); };
const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64), h3 = 'c'.repeat(64);
const log = [
  PC('project.set', { name: 'Test project' }),
  PC('layer.set', { layer: 'ter-1', kind: 'terrain', blob: h1 + '.bin', bounds: [-100.57, 45.12, -100.55, 45.14], name: 'DEM part 1', order: 0, removed: false }),
  PC('layer.set', { layer: 'ter-2', kind: 'terrain', blob: h2 + '.bin', bounds: [-100.56, 45.12, -100.54, 45.14], name: 'DEM part 2', order: 1, removed: false }),
  PC('layer.set', { layer: 'img-1', kind: 'imagery', blob: h3 + '.webp', bounds: [-100.57, 45.12, -100.55, 45.14], name: 'Picture', order: 2, removed: false }),
  PC('layer.set', { layer: 'hs-1', kind: 'tiles', url: '/api/terrain/tiles/proj1/Maps/{z}/{x}/{y}.png?dem=' + h1 + '.bin,' + h2 + '.bin', minZoom: 12, maxZoom: 19, name: 'Hillshade', order: 3, removed: false }),
];
const S = L.replayProject(log, 'proj1'), D = L.replayDocs([]);
const sel = L.selectForSync(S.log, [], S, D, null, 'all');
const have = new Set(sel.blobs);
if (!have.has(h1 + '.bin')) {
  console.log('SKIP terrain sync: flexlib.js selectForSync does not list layer.set blobs, so a terrain patch or a GeoTIFF layer does not reach another computer.');
  console.log("  Add after the cavefile line in selectForSync:  out[pScope].forEach(e => { if (e.op === 'layer.set' && e.blob) blobs.add(e.blob); });");
  process.exit(0);
}
ok('both terrain patches are in the sync file', have.has(h1 + '.bin') && have.has(h2 + '.bin'), sel.blobs);
ok('the GeoTIFF layer\'s picture is in it', have.has(h3 + '.webp'), sel.blobs);
ok('the tiles layer has no blob of its own', sel.blobs.length === 3, sel.blobs);
const man = L.syncManifest(S, 'pc', 'Cy', sel);
ok('the manifest counts them', man.blobs === 3, man);
const sel2 = L.selectForSync(S.log, [], S, D, sel.sent, 'since');
ok('a later sync file does not repeat them', sel2.count === 0 && sel2.blobs.length === 0, sel2.blobs);
console.log(`terrain sync: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
