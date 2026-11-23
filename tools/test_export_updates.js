// test_export_updates.js — the PC's side of map updates (export_updates.js over export_update.py; phone_api.js lists
// and sends the package). Small made-up zips, no export pipeline, no phone.   node tools/test_export_updates.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 600) : '')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xupd-'));
const ROOT = path.join(__dirname, '..');
const X = require('../export_updates.js');
const U = X({ exportsDir: tmp, python: 'python3', script: path.join(ROOT, 'export_update.py') });
// a made-up export: a zip of small files with its manifest, as the exporter leaves it (--manifest-out)
function make(id, name, mapId, files, exported) {
  const py = `
import json, sys, zipfile
sys.path.insert(0, ${JSON.stringify(ROOT)})
import export_update as xu
files = json.loads(${JSON.stringify(JSON.stringify(files))})
z = ${JSON.stringify(path.join(tmp, `export_${id}.zip`))}
with zipfile.ZipFile(z, 'w') as zf:
    for n, t in files.items(): zf.writestr(n, t)
    zf.writestr('viewer.html', 'x' * 5000); zf.writestr('libs/a.js', 'y')
m = xu.add_manifest(z, ${JSON.stringify(name)}, ${JSON.stringify(mapId)}, ${JSON.stringify(exported)})
open(${JSON.stringify(U.manifestOut(id))}, 'w').write(json.dumps(m))`;
  const pf = path.join(tmp, 'make.py'); fs.writeFileSync(pf, py); execFileSync('python3', [pf]); fs.unlinkSync(pf);
  return U.record(id, { name, filename: 'FLEX-' + name.replace(/ /g, '-') + '.zip' });
}
const big = 'T'.repeat(200000), caves = t => JSON.stringify({ meta: { name: 'Cave Ridge', about: { exported: t } }, surveys: [] });
const res = () => { const r = { h: {}, writeHead(s, h) { this.s = s; this.h = h; }, end(b) { this.b = b; this.done && this.done(JSON.parse(b)); } }; return r; };

(async () => {
  ok('the map id: the Process area when the export names one, else made from the name (case and outer spaces do not count)', X.mapIdOf({ area: 'ab12', name: 'x' }) === 'a-ab12' && X.mapIdOf({ name: ' Cave Ridge ' }) === X.mapIdOf({ name: 'cave ridge' })
    && X.mapIdOf({ name: 'Cave Ridge' }) !== X.mapIdOf({ name: 'Other' }) && X.mapIdOf({ area: '../x', name: 'Cave Ridge' }) === X.mapIdOf({ name: 'Cave Ridge' }), X.mapIdOf({ name: 'Cave Ridge' }));
  const idPy = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import export_update as xu; print(xu.map_id_of('Cave Ridge'))`]).toString().trim();
  ok('…the same id the exporter makes from a name', idPy === X.mapIdOf({ name: 'Cave Ridge' }), idPy);
  const MID = 'a-ab12';
  const a = make('aaaa1', 'Cave Ridge', MID, { 'terrain.glb': big, 'caves.json': caves('2026-11-20T10:00:00Z'), 'features.json': '{"items":[1]}' }, '2026-11-20T10:00:00Z');
  ok('a finished export keeps its manifest beside the zip; the exporter\'s own manifest file is taken away', a.kind === 'map' && a.map_id === MID && a.files_hash && a.manifest.files['terrain.glb'].size === 200000 && !fs.existsSync(U.manifestOut('aaaa1'))
    && JSON.parse(fs.readFileSync(path.join(tmp, 'export_aaaa1.json'))).name === 'Cave Ridge', Object.keys(a));
  ok('no earlier map of this area yet: nothing to update from', U.bases(MID, 'aaaa1').length === 0 && U.bases(MID).length === 1);
  await new Promise(r => setTimeout(r, 15));
  const b = make('bbbb2', 'Cave Ridge', MID, { 'terrain.glb': big, 'caves.json': caves('2026-11-21T10:00:00Z'), 'features.json': '{"items":[1,2]}', 'ridge_marks.json': '{"marks":[1]}' }, '2026-11-21T10:00:00Z');
  make('cccc3', 'Other map', 'a-zz99', { 'terrain.glb': 'q', 'caves.json': caves('2026-11-21T11:00:00Z') }, '2026-11-21T11:00:00Z');
  let bs = U.bases(MID, 'bbbb2');
  ok('an earlier map of the same area is offered as the base; another area\'s map is not', bs.length === 1 && bs[0].id === 'aaaa1' && bs[0].exported === '2026-11-20T10:00:00Z' && bs[0].zip > 0, bs);
  let u = await U.makeUpdate('bbbb2', 'aaaa1');
  ok('the update: what is added and replaced, its size against the full map', u.same === false && u.add.join() === 'ridge_marks.json' && u.replace.join() === 'caves.json,features.json' && u.remove.length === 0 && u.package_bytes > 0
    && u.package_bytes < u.full_bytes && u.from === '2026-11-20T10:00:00Z' && u.to === '2026-11-21T10:00:00Z' && u.mostly === false && /^[a-z0-9]{6,}$/.test(u.id), u);
  const side = U.readSide(u.id);
  ok('the package is an export of its own: named "Update for …", …-update.zip, pointing at its map and its base', side.kind === 'update' && side.name === 'Update for Cave Ridge' && side.filename === 'FLEX-Cave-Ridge-update.zip' && side.of === 'bbbb2' && side.base === 'aaaa1'
    && fs.statSync(path.join(tmp, `export_${u.id}.zip`)).size === u.package_bytes, side);
  ok('the map remembers the update made for it', U.readSide('bbbb2').update.id === u.id);
  // Send to phone lists it and tells it from a map
  const sent = [];
  const P = require('../phone_api.js')({ exportsDir: tmp, env: { FLEX_ADB: 'off' }, onSent: id => sent.push(id) });
  const L = P.listExports();
  const lu = L.find(e => e.id === u.id), lb = L.find(e => e.id === 'bbbb2');
  ok('Send to phone lists the update beside the maps, marked as one, with the full map\'s size', lu && lu.kind === 'update' && lu.name === 'Update for Cave Ridge' && lu.file === 'FLEX-Cave-Ridge-update.zip' && lu.full_bytes === u.full_bytes && lb.kind === 'map' && lb.full_bytes === 0, lu);
  // what was sent is the next base
  await new Promise(r => setTimeout(r, 15));
  make('dddd4', 'Cave Ridge', MID, { 'terrain.glb': big + 'x', 'caves.json': caves('2026-11-22T10:00:00Z') }, '2026-11-22T10:00:00Z');
  ok('by default the newest earlier map is the base', U.bases(MID, 'dddd4').map(x => x.id).join() === 'bbbb2,aaaa1');
  U.markSent('aaaa1');
  ok('…unless another was the last one sent to a phone: that one comes first', U.bases(MID, 'dddd4').map(x => x.id).join() === 'aaaa1,bbbb2' && U.bases(MID, 'dddd4')[0].sent > 0);
  await new Promise(r => setTimeout(r, 15));
  U.markSent(u.id);
  ok('an update that was sent makes the map it stands for the phone\'s map', U.bases(MID, 'dddd4')[0].id === 'bbbb2' && U.readSide(u.id).sent > 0);
  u = await U.makeUpdate('dddd4', 'bbbb2');
  ok('an update with a big file changed and files removed: mostly changed, says so', u.mostly === true && u.replace.includes('terrain.glb') && u.remove.join() === 'features.json,ridge_marks.json' && u.share > 0.8, u);
  // nothing changed but the export time
  make('eeee5', 'Cave Ridge', MID, { 'terrain.glb': big + 'x', 'caves.json': caves('2026-11-23T10:00:00Z') }, '2026-11-23T10:00:00Z');
  u = await U.makeUpdate('eeee5', 'dddd4');
  ok('nothing changed but the time it was made: said so, no package, nothing more to send', u.same === true && !u.id && u.package_bytes === 0 && !P.listExports().some(e => e.kind === 'update' && e.time > Date.now() + 1e9) && P.listExports().filter(e => e.kind === 'update').length === 2, u);
  // refusals
  let e1 = null; try { await U.makeUpdate('eeee5', 'cccc3'); } catch (e) { e1 = e.message; }
  ok('a base that is another map is refused', e1 === 'That is another map.', e1);
  fs.writeFileSync(path.join(tmp, 'export_ffff6.json'), JSON.stringify({ name: 'Cave Ridge', filename: 'x.zip' }));          // an export from before manifests
  e1 = null; try { await U.makeUpdate('eeee5', 'ffff6'); } catch (e) { e1 = e.message; }
  ok('an export from before manifests cannot be a base, and is not offered as one', /no manifest/.test(e1) && !U.bases(MID).some(x => x.id === 'ffff6'), e1);
  e1 = null; try { await U.makeUpdate('nope1', 'aaaa1'); } catch (e) { e1 = e.message; }
  ok('an unknown export', e1 === 'No such map.');
  // the routes
  let r = res(); U.handle({ method: 'GET' }, r, 'bases', { area: 'ab12', name: 'Anything' });
  let j = JSON.parse(r.b);
  ok('GET bases?area=: the area\'s maps, newest first after the last one sent', j.ok && j.map_id === MID && j.bases.length === 4 && j.bases[0].id === 'bbbb2' && !('manifest' in j.bases[0]), j.bases.map(x => x.id));
  r = res(); U.handle({ method: 'GET' }, r, 'bases', { name: 'Other map' });
  ok('GET bases?name= finds by name only maps that were made without an area', JSON.parse(r.b).bases.length === 0);
  r = res(); U.handle({ method: 'GET' }, r, 'bases', {});
  ok('no name and no area: nothing', JSON.parse(r.b).bases.length === 0);
  j = await new Promise(done => { const rr = res(); rr.done = done; const req = new (require('events'))(); req.method = 'POST'; U.handle(req, rr, 'update', {}); req.emit('data', JSON.stringify({ export: 'bbbb2', base: 'aaaa1' })); req.emit('end'); });
  ok('POST update makes the package for a finished export', j.ok && j.update.add.join() === 'ridge_marks.json' && j.update.id, j);
  j = await new Promise(done => { const rr = res(); rr.done = done; const req = new (require('events'))(); req.method = 'POST'; U.handle(req, rr, 'update', {}); req.emit('data', JSON.stringify({ export: '../x', base: 'aaaa1' })); req.emit('end'); });
  ok('…and refuses anything that is not an export id', j.ok === false);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`test_export_updates: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
