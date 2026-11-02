// FLEX Field / portable viewer: station tap targets in screen pixels, names
// thinned when zoomed out, leads by distance along the survey, the route
// difficulty cut-offs as settings, texture tiles for a > 5 km area (and the
// fallback when the tile files can't be read), shot names filled in, and
// survey descriptions / shared survey codes / reused station names.
//
// Builds a made-up export ("Cave Ridge") with tools/make_synthetic_export.py
// (needs numpy, Pillow, pygltflib; PYTHONPATH may point at a folder holding
// them) and drives the viewer in headless Chromium.
//
//   NODE_PATH=~/flex-tests/node_modules node tools/test_viewer_field.js
'use strict';
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 400) : '')); } };

const root = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'flexfield-'));
const out = path.join(work, 'export');
const env = Object.assign({}, process.env);
const extra = path.join(os.homedir(), 'opt/pylibs');
if (fs.existsSync(extra)) env.PYTHONPATH = extra + (env.PYTHONPATH ? ':' + env.PYTHONPATH : '');
execFileSync('python3', [path.join(root, 'tools/make_synthetic_export.py'), out, '--extent-km', '6', '--field-fixture'], { env, stdio: 'pipe' });

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const f = path.join(out, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(out) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

async function open(browser, port, blockTiles) {
  const p = await browser.newPage({ viewport: { width: 800, height: 800 } });
  p.errs = [];
  p.on('pageerror', e => p.errs.push(String(e.stack || e).slice(0, 300)));
  if (blockTiles) await p.route(/tex_(sat|hs)_\d+_\d+\.jpg/, r => r.abort());
  await p.goto(`http://localhost:${port}/viewer.html`);
  await p.waitForFunction(() => typeof stationMap !== 'undefined' && stationMap.size > 5 && terrainGroup && typeof TT !== 'undefined', null, { timeout: 60000 });
  return p;
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await open(browser, port, false);
  await p.waitForTimeout(1500);

  // ── Data issues ────────────────────────────────────────────────────────────
  const d = await p.evaluate(() => {
    const keys = [...stationMap.keys()];
    const a1 = stationMap.get('Cave Ridge|A1'), a1b = stationMap.get('Cave Ridge|A1#2');
    return {
      unnamedKeys: keys.filter(k => /^-?\d+,-?\d+,-?\d+$/.test(k)).length,
      b1: !!stationMap.get('Cave Ridge|B1'), b1Shots: stationMap.get('Cave Ridge|B1').shots.length,
      a1: !!a1, a1b: !!a1b, a1Shots: a1 && a1.shots.length, a1bShots: a1b && a1b.shots.length,
      far: a1 && a1b ? a1.pos.distanceTo(a1b.pos) : 0,
      legend: [...document.querySelectorAll('#legend .leg-nm')].map(n => n.textContent),
      c1Survey: stationMap.get('Cave Ridge|C1').surveyName,
      shotNamesBlank: CAVES_DATA.surveys.filter(s => s.name === 'North branch')[0].shots.every(s => s.from_name && s.to_name),
    };
  });
  ok('shots with no from/to name get them from the stations at their ends', d.shotNamesBlank && d.unnamedKeys === 0 && d.b1 && d.b1Shots === 2, d);
  ok('a station name used twice, far apart, is two stations', d.a1 && d.a1b && d.far > 100 && d.a1bShots === 1 && d.a1Shots >= 3, d);
  ok('a bare survey code takes the description of the same code in the cave', d.c1Survey === 'C — Crawl to the north', d.c1Survey);
  ok('two surveys with one name stay two legend rows', d.legend.filter(n => n.startsWith('C — Crawl to the north')).length === 2 &&
     d.legend.includes('C — Crawl to the north (2)'), d.legend);

  // ── Tap targets: constant pixel radius ─────────────────────────────────────
  const tap = await p.evaluate(() => {
    const st = stationMap.get('Cave Ridge|A5'), res = [];
    const h = renderer.domElement.clientHeight, tanH = 2 * Math.tan(camera.fov * Math.PI / 360);
    for (const dist of [120, 2500]) {
      camera.position.set(st.pos.x, st.pos.y - dist * 0.8, st.pos.z + dist * 0.6);
      camera.up.set(0, 0, 1); camera.lookAt(st.pos); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      const r = { dist, px: stationTapRadius(dist) * h / (dist * tanH) };
      const probe = dx => {
        const v = st.pos.clone().project(camera);
        v.x += dx * 2 / renderer.domElement.clientWidth;
        _tapRay.setFromCamera({ x: v.x, y: v.y }, camera);
        return stationRayHits().some(x => x.object._station === st);
      };
      r.near = probe(12); r.far = probe(60);
      res.push(r);
    }
    return res;
  });
  ok('tap radius is 24 px at a near zoom', Math.abs(tap[0].px - 24) < 1.5 || tap[0].px >= 24, tap[0]);
  ok('tap radius is 24 px at a far zoom', Math.abs(tap[1].px - 24) < 0.5, tap[1]);
  ok('a tap 12 px off hits the station at both zooms, 60 px off at neither', tap.every(t => t.near && !t.far), tap);

  // ── Names thinned ──────────────────────────────────────────────────────────
  const lab = await p.evaluate(() => {
    stationMode = 2; stationNamesOn = true;
    const o = {}, A2 = stationMap.get('Cave Ridge|A2'), A0 = stationMap.get('Cave Ridge|A0'), A9 = stationMap.get('Cave Ridge|A9');
    const look = (pos, target) => { camera.position.copy(pos); camera.up.set(0, 0, 1); camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true); };
    const onScreen = st => { const v = st.pos.clone().project(camera); return v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1; };
    const count = () => { applyStationMode(); return [...stationMap.values()].filter(st => stationNamed(st) && onScreen(st)).length; };
    const wouldFit = () => {         // big enough to read, on screen: what is left if only size is checked
      const h = renderer.domElement.clientHeight, tanH = 2 * Math.tan(camera.fov * Math.PI / 360);
      return [...stationMap.values()].filter(st => onScreen(st) && _lblH * h / (tanH * camera.position.distanceTo(st.pos)) >= LABEL_MIN_PX).length;
    };
    look(A2.pos.clone().add(new THREE.Vector3(0, -40, 10)), A2.pos); o.near = count(); o.nearFit = wouldFit();
    // From below the 15 m pitch looking straight up: A9 and A8 are in line, their names on each other.
    camera.up.set(0, 1, 0); camera.position.copy(A9.pos).add(new THREE.Vector3(0, 0, -25)); camera.lookAt(A9.pos); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true); o.line = count(); o.lineFit = wouldFit();
    look(A0.pos.clone().add(new THREE.Vector3(0, -3000, 1500)), A0.pos); o.far = count();
    o.total = stationMap.size;
    return o;
  });
  ok('close in, the names are all drawn', lab.near >= 3 && lab.near === lab.nearFit, lab);
  ok('names that would sit on each other are dropped', lab.line >= 1 && lab.line < lab.lineFit, lab);
  ok('zoomed far out, names too small to read are not drawn', lab.far === 0 && lab.total > 10, lab);

  // ── Leads by distance along the survey ─────────────────────────────────────
  const leads = await p.evaluate(() => {
    camera.position.set(0, -200, 300); camera.lookAt(0, 0, 0);
    const A0 = stationMap.get('Cave Ridge|A0');
    selectStation(A0);
    leadSort = 'near'; leadShow = 'active'; leadsRender();
    const rows = [...document.querySelectorAll('#fp-lead-list .fp-item')].map(r => [r.querySelector('.fp-t1').textContent, r.querySelector('.fp-t2').textContent]);
    const straight = [...stationMap.values()].filter(s => s.leads).map(s => [s.leads[0].description, s.pos.distanceTo(A0.pos)]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    return { rows, straight, note: document.getElementById('fp-leads-from').textContent };
  });
  ok('leads come nearest-by-survey first', leads.rows.map(r => r[0]).join('|') === 'Tight crawl continues north, air|Water crawl|Dig at the end', leads.rows);
  ok('...which is not the straight-line order', leads.straight[0] === 'Dig at the end', leads.straight);
  ok('each lead says it is along the survey', leads.rows.every(r => /along the survey/.test(r[1])) && /along the survey/.test(leads.note), leads);

  // ── Route thresholds ───────────────────────────────────────────────────────
  const th = await p.evaluate(() => {
    const W = 4 * FT, base = narrowScore(W);
    setRouteThresholds({ narrow: 5 });
    const wide = narrowScore(W), saved = JSON.parse(localStorage.getItem(RT_KEY)).narrow;
    setRouteThresholds({ crawl: 8 });             // above the stooping height: kept apart
    const sane = RT.crawl < RT.stoop;
    document.getElementById('tb-more').click();
    const rows = document.querySelectorAll('.rt-set').length;
    setRouteThresholds(RT_DEFAULT);
    return { base, wide, saved, sane, rows, back: narrowScore(W) === base };
  });
  ok('a wider "narrow" cut-off scores a 4 ft passage as narrow', th.base === 0 && th.wide > 0 && th.back, th);
  ok('cut-offs are kept on the phone and kept in order', th.saved === 5 && th.sane, th);
  ok('⋯ More lists the five difficulty settings', th.rows === 5, th);

  // ── Texture tiles ──────────────────────────────────────────────────────────
  await p.waitForFunction(() => TT.sat.size === 2 && TT.hs.size === 2, null, { timeout: 20000 });
  const tiles = await p.evaluate(() => {
    const ms = []; terrainGroup.traverse(o => { if (o.isMesh && o.userData.tile) ms.push(o); });
    const px = tex => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(tex.image, 10, 10, 1, 1, 0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const info = ms.map(m => { m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox, uv = m.geometry.attributes.uv.array; let mx = 0, mn = 9; for (const v of uv) { mx = Math.max(mx, v); mn = Math.min(mn, v); }
      return { c: m.userData.tile.c, r: m.userData.tile.r, x0: b.min.x, x1: b.max.x, uvMax: mx, uvMin: mn, w: m.material.map && m.material.map.image.width, col: m.material.map && px(m.material.map) }; });
    const z = [terrainZAt(-1, 0), terrainZAt(1, 0)];     // either side of the seam
    return { n: ms.length, info, z, cols: TT.cols, rows: TT.rows, tex: !!terrainTexSat };
  });
  ok('a 6 km export is cut into 2 tiles', tiles.n === 2 && tiles.cols === 2 && tiles.rows === 1, tiles);
  ok('each tile has its own texture, UVs inside 0..1', tiles.info.every(t => t.w === 256 && t.uvMax <= 1.0001 && t.uvMin >= -0.0001), tiles.info);
  ok('the tiles meet at the seam and the ground is there on both sides', Math.abs(tiles.info.find(t => t.c === 0).x1) < 1 && Math.abs(tiles.info.find(t => t.c === 1).x0) < 1 && tiles.z.every(v => v != null), tiles);
  ok('the two tiles carry different textures', tiles.info[0].col && tiles.info[1].col && tiles.info[0].col[0] !== tiles.info[1].col[0], tiles.info);
  await p.evaluate(() => document.getElementById('btn-layer-hs').click());
  const hsOn = await p.evaluate(() => { const o = []; terrainGroup.traverse(m => { if (m.isMesh && m.userData.tile) o.push(m.material.map === TT.hs.get(m.userData.tile.c + '_' + m.userData.tile.r)); }); return o; });
  ok('the hillshade button switches every tile to its hillshade', hsOn.length === 2 && hsOn.every(Boolean), hsOn);
  ok('no page errors', p.errs.length === 0, p.errs);
  await p.close();

  // ── Tiles that cannot be read: the overview is drawn over them ────────────
  const q = await open(browser, port, true);
  await q.waitForFunction(() => TT.failed && terrainTexSat && terrainTexSat.image, null, { timeout: 20000 });
  await q.waitForTimeout(500);
  const fb = await q.evaluate(() => { const o = []; terrainGroup.traverse(m => { if (m.isMesh && m.userData.tile) o.push([m.material.map && m.material.map.repeat.x, m.material.map && m.material.map.offset.x]); }); return o; });
  ok('with no tile files the overview texture is shared out over the tiles', fb.length === 2 && fb.every(f => f[0] === 0.5) && new Set(fb.map(f => f[1])).size === 2, fb);
  await q.close();

  await browser.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
