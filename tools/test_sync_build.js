// sync_build.js: a server's results as project entries and a sync file for a computer that already has the project.
// Two libraries in temp folders (library.js loaded twice with its own FLEX_LIBRARY_DIR): "server" and "pc". The sync
// file is read back and merged into the pc the way project-history.js importSync does it. Made-up names and numbers.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const JSZip = require('../viewer_build/libs/jszip.min.js');
const FL = require('../viewer_build/libs/flexlib.js');
const SB = require('./sync_build.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 400) : '')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syncb-'));
function lib(name) {
  process.env.FLEX_LIBRARY_DIR = path.join(tmp, name, 'library');
  process.env.FLEX_PROJECTS_DIR = path.join(tmp, name, 'projects');
  delete require.cache[require.resolve('../library.js')];
  return require('../library.js');
}
const PID = 'crproj01';
const ring = [[-100.57, 45.12], [-100.56, 45.12], [-100.56, 45.13], [-100.57, 45.13]];
const blobBytes = Buffer.from('terrain patch bytes for Cave Ridge');
const sha = require('crypto').createHash('sha256').update(blobBytes).digest('hex');
const ref = { ref: { name: 'Cave Ridge', folder: 'FLEX maps/Cave Ridge', terrain: { blob: sha + '.bin', bounds: [-100.57, 45.12, -100.56, 45.13], nx: 10, ny: 10, cell_m: 1 },
  terrains: [{ blob: sha + '.bin', bounds: [-100.57, 45.12, -100.56, 45.13], nx: 10, ny: 10, cell_m: 1 }],
  tiles: { url: `/api/terrain/tiles/${PID}/Cave%20Ridge/{z}/{x}/{y}.png?dem=${sha}.bin`, bounds: [-100.57, 45.12, -100.56, 45.13], minzoom: 12, maxzoom: 17, count: 40 } } };
const pt = (id, kind, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-100.5678, 45.1234] }, properties: Object.assign({ id, kind, title: kind + ' ' + id }, props) });
const geo = { type: 'FeatureCollection', features: [
  pt('A1', 'A', { measured: 0.8, depth_m: 2 }), pt('A2', 'A', { measured: 0.2 }),
  pt('B1', 'B', { points: 12, depth_median_m: 2.1 }), pt('B2', 'B', { points: 5, depth_median_m: 3 }), pt('B3', 'B', { points: 20, depth_median_m: 1.0 }),
  pt('B4', 'B', { points: 20, depth_median_m: 2, wide: true }), pt('C1', 'C', { points: 9, depth_median_m: 1.6 }), pt('C2', 'C', { points: 30, depth_median_m: 4, isolated: true })] };

(async () => {
  // pure parts
  const T = SB.terrainEntries(ref);
  ok('terrain: one patch + the hillshade, keep() ids', T.length === 2 && T[0].layer === 'ter-' + sha.slice(0, 12) && T[0].kind === 'terrain' && T[0].blob === sha + '.bin' && T[1].layer === 'hs-' + sha.slice(0, 12) && T[1].kind === 'tiles' && T[1].minZoom === 12 && /\?dem=/.test(T[1].url), T);
  const Pr = SB.prospectEntries(geo, 'acr1', 'Cave Ridge', '2026-01-02');
  const fids = Pr.filter(e => e.op === 'feature.set').map(e => e.feature);
  ok('prospects: default filter (A measured, B/C >= 8 points and 1.5 m, not wide, not isolated)', JSON.stringify(fids) === JSON.stringify(['prospect-acr1-A1', 'prospect-acr1-B1', 'prospect-acr1-C1']), fids);
  ok('prospects: one folder, points in it, candidate kept', Pr[0].op === 'group.set' && Pr[0].name === 'Prospects Cave Ridge 2026-01-02' && Pr.slice(1).every(e => e.group === Pr[0].group && e.kind === 'point' && e.style.prospect.id && /Candidate/.test(e.desc)));
  ok('prospects: none pass → nothing', SB.prospectEntries({ features: [geo.features[1]] }, 'a', 'x', 'd').length === 0);

  // the server: a project made with no log entry, its own footprint, then the results
  const S1 = lib('server');
  S1.setProject(PID, 'Cave Ridge (server)');
  const sdev = S1.device();
  S1.putBlob(blobBytes, 'bin', null, PID);
  S1.append('p-' + PID, { op: 'project.footprint', ring, who: 'FLEX server' }, PID);
  const before = FL.replayProject(S1.read('p-' + PID).split('\n').filter(Boolean).map(JSON.parse), PID);
  const todo = SB.missing(before, T.concat(Pr));
  todo.forEach(b => S1.append('p-' + PID, Object.assign({ who: 'FLEX server' }, b), PID));
  const sEntries = S1.read('p-' + PID).split('\n').filter(Boolean).map(JSON.parse);
  const after = FL.replayProject(sEntries, PID);
  ok('missing(): a second pass writes nothing', SB.missing(after, T.concat(Pr)).length === 0, SB.missing(after, T.concat(Pr)));
  const out = SB.outgoing(sEntries, sdev);
  ok('outgoing: the server device only, no footprint', out.length === todo.length && out.every(e => e.dev === sdev && e.op !== 'project.footprint'));
  ok('blobsOf: the terrain patch', JSON.stringify(SB.blobsOf(out)) === JSON.stringify([sha + '.bin']));
  const zbuf = await SB.makeZip({ pid: PID, dev: sdev, who: 'FLEX server', entries: out, blobs: { [sha + '.bin']: fs.readFileSync(S1.blobPath(sha + '.bin')) } });

  // the pc: the project already there, its own name, footprint and a layer
  const S2 = lib('pc');
  S2.setProject(PID, 'Cave Ridge');
  const pdev = S2.device();
  ok('two devices', pdev !== sdev);
  S2.append('p-' + PID, { op: 'project.set', name: 'Cave Ridge', desc: 'mine', who: 'Felix' }, PID);
  const pcRing = ring.concat([[-100.565, 45.135]]);
  S2.append('p-' + PID, { op: 'project.footprint', ring: pcRing, who: 'Felix' }, PID);
  S2.append('p-' + PID, { op: 'feature.set', feature: 'area1', kind: 'area', coords: ring, name: 'Cave Ridge area', who: 'Felix' }, PID);

  // import as importSync does: manifest → projects (name from the manifest), missing blobs, merge per scope
  const z = await JSZip.loadAsync(zbuf);
  const man = JSON.parse(await z.file('manifest.json').async('string'));
  ok('manifest: flex-sync, the project id, an empty name, from the server device', man.format === 'flex-sync' && man.project.id === PID && man.project.name === '' && man.from.dev === sdev);
  const logNames = Object.keys(z.files).filter(n => /^logs\/.*\.jsonl$/.test(n));
  ok('zip: one log, the server device', logNames.length === 1 && logNames[0] === `logs/p-${PID}/log-${sdev}.jsonl`, logNames);
  S2.setProject(man.project.id, man.project.name);
  ok('pc: project name unchanged by the import', S2.projects().find(p => p.id === PID).name === 'Cave Ridge');
  for (const n of Object.keys(z.files).filter(n => /^blobs\/./.test(n))) { const [h, ext] = n.slice(6).split('.'); S2.putBlob(await z.file(n).async('nodebuffer'), ext, h, PID); }
  ok('pc: the terrain blob arrived', !!S2.blobPath(sha + '.bin'));
  const inc = (await z.file(logNames[0]).async('string')).split('\n').filter(Boolean).map(JSON.parse);
  const added = S2.merge('p-' + PID, inc, PID);
  ok('pc: all server entries added', added === out.length, { added, n: out.length });
  ok('pc: merging again adds nothing', S2.merge('p-' + PID, inc, PID) === 0);
  const P = FL.replayProject(S2.read('p-' + PID).split('\n').filter(Boolean).map(JSON.parse), PID);
  ok('pc: name and description kept', P.name === 'Cave Ridge' && P.desc === 'mine');
  ok('pc: its own footprint kept', JSON.stringify(P.footprint.ring) === JSON.stringify(pcRing));
  ok('pc: its area polygon once, no copy', FL.liveFeatures(P).filter(f => f.kind === 'area').length === 1);
  ok('pc: terrain + hillshade layers', P.layers['ter-' + sha.slice(0, 12)] && P.layers['hs-' + sha.slice(0, 12)] && FL.liveLayers(P).length === 2);
  ok('pc: prospects folder and 3 points', Object.values(P.groups).filter(g => !g.removed).length === 1 && FL.liveFeatures(P).filter(f => f.kind === 'point').length === 3);
  ok('pc: pc entries still its own device only', S2.read('p-' + PID).split('\n').filter(Boolean).map(JSON.parse).filter(e => e.dev === pdev).length === 3);
  ok('LOCAL_OPS: footprint and project fields stay home', ['project.footprint', 'project.set'].every(o => SB.LOCAL_OPS.includes(o)));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
