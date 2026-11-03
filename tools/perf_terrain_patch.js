// Terrain patch performance (terrain-patch.js) in headless Chromium on the GPU, synthetic data only.
//   NODE_PATH=~/flex-tests/node_modules node tools/perf_terrain_patch.js [options]
//   --scen none,rect,ragged,multi   scenarios (default all): no patch / 6 km (5.99) full rectangle at 2 m /
//                                   same with NaN corners (diamond) / 1.5x bigger DEM, split in 4 patches (9 km at 2 m)
//   --base ellipsoid|real           the world terrain: the kit's flat stub, or a provider with availability to
//                                   level 13 and 40 ms latency per tile (default real)
//   --entities                      add 200 CLAMP_TO_TERRAIN points + 4 draped lines
//   --secs 30   --throttle 4   --pitch -15   --profile           seconds flown; CDP CPU profile (top self-time functions)
//   --cell 2 --speed 80   DEM post spacing (m; 0.5 for a USGS 0.5 m DEM) and flight speed (m/s)
//   --uncap  --pitch -15   no vsync cap (fps then shows the real throughput); camera pitch (deg)
//   --kit ~/flex-tests              where playwright, cesium and baseline user_files live
// The camera flies east at 80 m/s, 150 m above the DEM, from 800 m outside the west edge across it.
// Prints per scenario: install ms, fps, frame-time percentiles, long frames, tiles rendered, tile requests,
// time in PatchTerrainProvider.requestTileGeometry (wall, includes awaiting world tiles), JSON line at the end.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const KIT = (arg('kit', path.join(os.homedir(), 'flex-tests'))).replace(/^~/, os.homedir());
const { chromium } = require(path.join(KIT, 'node_modules/playwright'));
const REPO = path.join(__dirname, '..'), CES = path.join(KIT, 'node_modules/cesium/Build/Cesium');
const SCEN = String(arg('scen', 'none,rect,ragged,multi')).split(','), BASE = arg('base', 'real'), ENT = !!arg('entities', false);
const SECS = +arg('secs', 30), PROFILE = !!arg('profile', false), THR = +arg('throttle', 1), PITCH = +arg('pitch', -15), CELL = +arg('cell', 2), SPEED = +arg('speed', 80), PORT = +arg('port', 8391);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'perf_tp_')), APP = path.join(WORK, 'app');
fs.mkdirSync(APP);
cp.execSync(`tar -C "${REPO}" --exclude=./.git --exclude=./node_modules --exclude=./user_files --exclude=./PotreeCopied --exclude=./Tokens.js -cf - . | tar -C "${APP}" -xf -`);
fs.symlinkSync(path.join(REPO, 'PotreeCopied'), path.join(APP, 'PotreeCopied'));
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(APP, 'node_modules'));
fs.copyFileSync(path.join(REPO, 'Tokens.js.example'), path.join(APP, 'Tokens.js'));
fs.mkdirSync(path.join(APP, 'user_files'));
if (fs.existsSync(path.join(KIT, 'baseline/user_files'))) cp.execSync(`cp -r "${KIT}/baseline/user_files/." "${APP}/user_files/"`);
cp.execSync(`sed -i "s/port: 8081/port: ${PORT}/" "${APP}/settings.js"`);
const server = cp.spawn('node', ['server.js', 'perfterrain'], { cwd: APP, stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch (_) {} });

const PAGE_FN = {
  // runs in the page: build a DEM + install; returns install ms and the patch rectangle
  install: async ({ kind, base }) => {
    const TP = window._terrainPatch, v = window.cesiumViewer, C = Cesium;
    const lat0 = 45.1234, lon0 = -100.5678, cell = window.__cell, mLat = 110540, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    const km = (kind === 'multi' ? 4.5 : 2.995) * cell, n = Math.round(km * 1000 / cell) + 1;
    const W = lon0 - km * 500 / mLon, E = lon0 + km * 500 / mLon, S = lat0 - km * 500 / mLat, N = lat0 + km * 500 / mLat;
    const wob = (x, y) => 3 * Math.sin(x * 0.05) * Math.cos(y * 0.07) + 8 * Math.sin(x * 0.004 + y * 0.003);
    const t0 = performance.now(), res = { rect: { W, S, E, N } };
    const plan = TP.plan(W, S, E, N, cell), dlon = (E - W) / (plan.nx - 1), dlat = (N - S) / (plan.ny - 1);
    const heightAt = (lon, lat) => (window.__world ? window.__world(lon, lat) : 0);
    const patches = [];
    for (const t of plan.tiles) {
      const west = W + t.i0 * dlon, north = N - t.j0 * dlat, east = west + (t.nx - 1) * dlon, south = north - (t.ny - 1) * dlat;
      const g = new Float32Array(t.nx * t.ny), R = km * 500;
      for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
        const gi = t.i0 + i, gj = t.j0 + j, x = gi * cell, y = gj * cell, lon = W + gi * dlon, lat = N - gj * dlat;
        const ex = (gi - (plan.nx - 1) / 2) * cell, ey = (gj - (plan.ny - 1) / 2) * cell;
        g[j * t.nx + i] = kind === 'ragged' && Math.abs(ex) + Math.abs(ey) > R * 1.25 ? NaN : heightAt(lon, lat) + 4 + wob(x, y);
      }
      patches.push({ meta: { west, south, east, north, nx: t.nx, ny: t.ny, name: 'perf', cell_m: cell }, grid: g });
    }
    res.parts = patches.length; res.gen = performance.now() - t0;
    const t1 = performance.now(), inst = [];
    for (const p of patches) {
      const blob = new Blob([TP.pack(p.meta, p.grid)]), url = URL.createObjectURL(blob), ti = performance.now();
      await TP.install(v, url); inst.push(performance.now() - ti);
    }
    res.install = performance.now() - t1; res.installEach = inst.map(x => Math.round(x));
    return res;
  },
  entities: ({ W, S, E, N }) => {
    const v = window.cesiumViewer, C = Cesium, cx = (W + E) / 2 + (E - W) * 0.0, cy = (S + N) / 2;
    for (let i = 0; i < 200; i++) v.entities.add({ position: C.Cartesian3.fromDegrees(W + (E - W) * (0.13 + 0.003 * i), cy + (i % 7 - 3) * 0.0004), point: { pixelSize: 6, color: C.Color.YELLOW, heightReference: C.HeightReference.CLAMP_TO_TERRAIN, disableDepthTestDistance: 1e9 } });
    for (let k = 0; k < 4; k++) { const pos = []; for (let i = 0; i < 40; i++) pos.push(W + (E - W) * (0.12 + 0.02 * i / 4), cy + (k - 2) * 0.002 + 0.0003 * Math.sin(i)); v.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray(pos), width: 3, clampToGround: true, material: C.Color.RED } }); }
  },
};

(async () => {
  for (let i = 0; i < 80; i++) { try { await fetch(`http://localhost:${PORT}/index.html`); break; } catch (_) { await new Promise(r => setTimeout(r, 250)); } }
  const b = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'].concat(arg('uncap', false) ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []) });
  const results = [];
  for (const kind of SCEN) {
    const p = await b.newPage({ viewport: { width: 1400, height: 860 } });
    p.on('pageerror', e => console.log('PAGE', String(e.stack || e).slice(0, 300)));
    await p.route('**/*', async r => {
      const u = r.request().url();
      if (u.startsWith(`http://localhost:${PORT}/flex.js`)) { const res = await r.fetch(); let body = await res.text(); body = body.replace(/await Cesium\.createWorldTerrainAsync\(\)/g, 'window.__mkBase()'); return r.fulfill({ response: res, body }); }
      if (u.startsWith(`http://localhost:${PORT}`)) return r.continue();
      if (/bootstrap@4\.0\.0\/dist\/css/.test(u)) return r.fulfill({ path: path.join(KIT, 'node_modules/bootstrap/dist/css/bootstrap.min.css'), contentType: 'text/css' });
      if (/bootstrap@4\.0\.0\/dist\/js/.test(u)) return r.fulfill({ path: path.join(KIT, 'node_modules/bootstrap/dist/js/bootstrap.min.js'), contentType: 'application/javascript' });
      if (/bucket\.css/.test(u)) return r.fulfill({ path: path.join(KIT, 'tests/fixtures/bucket.css'), contentType: 'text/css' });
      const m = u.match(/cesiumjs\/releases\/1\.122\/Build\/Cesium\/(.*)$/);
      if (m) { const f = path.join(CES, m[1].split('?')[0]); return fs.existsSync(f) ? r.fulfill({ path: f }) : r.fulfill({ status: 404, body: '' }); }
      if (/code\.jquery\.com/.test(u)) return r.fulfill({ path: path.join(REPO, 'PotreeCopied/libs/jquery/jquery-3.1.1.min.js') });
      if (/esm\.sh\/egm96/.test(u)) return r.fulfill({ contentType: 'application/javascript', body: 'export const meanSeaLevel = () => 0;' });
      if (/\.js(\?|$)/.test(u)) return r.fulfill({ contentType: 'application/javascript', body: '' });
      if (/\.css(\?|$)/.test(u)) return r.fulfill({ contentType: 'text/css', body: '' });
      return r.abort();
    });
    await p.addInitScript(({ base }) => {
      try { localStorage.setItem('flex.author', 'T'); } catch (_) {}
      // a gentle, hilly "world" surface (ellipsoid heights), the same for the stub and the realistic provider
      window.__world = (lon, lat) => 300 + 60 * Math.sin(lat * 900) * Math.cos(lon * 700) + 25 * Math.sin(lon * 3000 + lat * 2000);
      window.__baseCalls = 0;
      window.__mkBase = () => {
        const C = Cesium;
        if (base !== 'real') return new C.EllipsoidTerrainProvider();
        const ts = new C.GeographicTilingScheme(), MAXL = 13, ev = new C.Event();
        const prov = {
          tilingScheme: ts, errorEvent: ev, credit: undefined, hasWaterMask: false, hasVertexNormals: false, ready: true, readyPromise: Promise.resolve(true),
          availability: { computeMaximumLevelAtPosition: () => MAXL },
          getLevelMaximumGeometricError: l => C.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(C.Ellipsoid.WGS84, 65, 2) / (1 << l),
          getTileDataAvailable: (x, y, l) => l <= MAXL,
          loadTileDataAvailability: () => undefined,
          requestTileGeometry(x, y, l) {
            window.__baseCalls++;
            const key = x + '/' + y + '/' + l; (window.__baseKeys = window.__baseKeys || {})[key] = (window.__baseKeys[key] || 0) + 1;
            // a quantized-mesh tile like the real world terrain (33 x 33 vertices, u/v/height 15-bit), after 40 ms
            return new Promise(res => setTimeout(() => {
              const r = ts.tileXYToRectangle(x, y, l), M = 33, hs = new Float32Array(M * M);
              let lo = Infinity, hi = -Infinity;
              for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) { const h = window.__world((r.west + (r.east - r.west) * i / (M - 1)) * 180 / Math.PI, (r.north - (r.north - r.south) * j / (M - 1)) * 180 / Math.PI); hs[j * M + i] = h; lo = Math.min(lo, h); hi = Math.max(hi, h); }
              if (hi - lo < 1) hi = lo + 1;
              const q = new Uint16Array(3 * M * M), idx = new Uint16Array(6 * (M - 1) * (M - 1));
              for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) { const k = j * M + i; q[k] = Math.round(i / (M - 1) * 32767); q[M * M + k] = Math.round((1 - j / (M - 1)) * 32767); q[2 * M * M + k] = Math.round((hs[k] - lo) / (hi - lo) * 32767); }
              let t = 0; for (let j = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) { const a = j * M + i; idx[t++] = a; idx[t++] = a + M; idx[t++] = a + 1; idx[t++] = a + 1; idx[t++] = a + M; idx[t++] = a + M + 1; }
              const bs = C.BoundingSphere.fromRectangle3D(r, C.Ellipsoid.WGS84, (lo + hi) / 2);
              res(new C.QuantizedMeshTerrainData({ minimumHeight: lo, maximumHeight: hi, quantizedVertices: q, indices: idx, boundingSphere: bs, horizonOcclusionPoint: new C.Cartesian3(0, 0, 0), westIndices: [], southIndices: [], eastIndices: [], northIndices: [], westSkirtHeight: 0, southSkirtHeight: 0, eastSkirtHeight: 0, northSkirtHeight: 0, childTileMask: l < MAXL ? 15 : 0, createdByUpsampling: false }));
            }, 40));
          }
        };
        return prov;
      };
    }, { base: BASE });
    await p.goto(`http://localhost:${PORT}/index.html`);
    await p.waitForFunction(() => window.cesiumViewer && window._terrainPatch, null, { timeout: 90000 });
    await p.waitForTimeout(2500);
    await p.evaluate(pt => { window.__pitch = pt[0]; window.__cell = pt[1]; window.__speed = pt[2]; }, [PITCH, CELL, SPEED]);
    // world function takes degrees; keep it the one the DEM is built from
    const rect = await p.evaluate(() => { window.__world0 = window.__world; window.__world = (lon, lat) => window.__world0(lon, lat); return null; });
    let inst = { install: 0, parts: 0, rect: null };
    if (kind !== 'none') inst = await p.evaluate(PAGE_FN.install, { kind, base: BASE });
    else { const lat0 = 45.1234, lon0 = -100.5678, mLat = 110540, mLon = 111320 * Math.cos(lat0 * Math.PI / 180); inst.rect = { W: lon0 - 3000 / mLon, E: lon0 + 3000 / mLon, S: lat0 - 3000 / mLat, N: lat0 + 3000 / mLat }; }
    await p.evaluate(r => { window.__rect = r; }, inst.rect);
    if (ENT) await p.evaluate(PAGE_FN.entities, inst.rect);
    // instrument: counts and time in the patch's tile request; frame times; tiles rendered
    await p.evaluate(({ rect, secs }) => {
      const v = window.cesiumViewer, C = Cesium, PT = window._terrainPatch.PatchTerrainProvider;
      const S = window.__S = { calls: 0, ms: 0, frames: [], tiles: [], reqLevels: {}, long: 0 };
      const orig = PT.prototype.requestTileGeometry;
      PT.prototype.requestTileGeometry = async function (x, y, l, rq) { S.calls++; S.reqLevels[l] = (S.reqLevels[l] || 0) + 1; const t = performance.now(); try { return await orig.call(this, x, y, l, rq); } finally { S.ms += performance.now() - t; } };
      const GH = C.Globe.prototype.getHeight; S.gh = { n: 0, ms: 0, who: {} };   // who calls globe.getHeight, and what it costs
      C.Globe.prototype.getHeight = function (c) { const t = performance.now(); const r = GH.call(this, c); const d = performance.now() - t; S.gh.n++; S.gh.ms += d; const m = (new Error().stack.split('\n')[2] || '').replace(/^.*\/([^/]*)\)?$/, '$1').slice(0, 70); const w = S.gh.who[m] || (S.gh.who[m] = { n: 0, ms: 0 }); w.n++; w.ms += d; return r; };
      new PerformanceObserver(l => { for (const e of l.getEntries()) S.long++; }).observe({ entryTypes: ['longtask'] });
      const mLat = 110540, mLon = 111320 * Math.cos((rect.S + rect.N) / 2 * Math.PI / 180), cy = (rect.S + rect.N) / 2;
      const lon0 = rect.W - 800 / mLon;
      let t0 = null, last = null;
      const tick = now => {
        if (t0 === null) t0 = now;
        const t = (now - t0) / 1000;
        if (last !== null) S.frames.push(now - last); last = now;
        if (t < secs) {
          const lon = lon0 + window.__speed * t / mLon;
          v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, cy, 480), orientation: { heading: C.Math.toRadians(90), pitch: C.Math.toRadians(window.__pitch), roll: 0 } });
          try { S.tiles.push(v.scene.globe._surface._tilesToRender.length); } catch (_) {}
          requestAnimationFrame(tick);
        } else S.done = true;
      };
      v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon0, cy, 480), orientation: { heading: C.Math.toRadians(90), pitch: C.Math.toRadians(window.__pitch), roll: 0 } });
      window.__baseCalls = 0; window.__start = () => requestAnimationFrame(tick);
    }, { rect: inst.rect, secs: SECS });
    await p.waitForTimeout(1500);
    let cdp, prof; if (THR > 1) { const c2 = await p.context().newCDPSession(p); await c2.send('Emulation.setCPUThrottlingRate', { rate: THR }); }
    if (PROFILE) { cdp = await p.context().newCDPSession(p); await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
    await p.evaluate(() => { window.__baseCalls = 0; window.__S.calls = 0; window.__S.ms = 0; window.__start(); });
    await p.waitForFunction(() => window.__S.done, null, { timeout: (SECS + 120) * 1000, polling: 500 });
    if (PROFILE) prof = (await cdp.send('Profiler.stop')).profile;
    const st = await p.evaluate(() => { const S = window.__S, f = S.frames.slice().sort((a, b) => a - b), q = x => f[Math.min(f.length - 1, Math.floor(f.length * x))];
      const sum = f.reduce((a, b) => a + b, 0), avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
      return { frames: f.length, fps: f.length / (sum / 1000), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: f[f.length - 1], over50: f.filter(x => x > 50).length, over100: f.filter(x => x > 100).length,
        tilesAvg: avg(S.tiles), tilesMax: Math.max(0, ...S.tiles), patchCalls: S.calls, patchMs: S.ms, gh: S.gh, pick: JSON.stringify(window._terrainPatch.pickStats), baseCalls: window.__baseCalls, baseKeys: Object.keys(window.__baseKeys || {}).length, lv: S.reqLevels, long: S.long, drawn: window.cesiumViewer.scene.globe._surface._tilesToRender.length }; });
    // micro: ms per globe.getHeight at the camera (what the minimap/ground-height code calls each frame); ms to bake one tile
    await p.waitForTimeout(3000);
    const micro = await p.evaluate(() => {
      const v = window.cesiumViewer, g = v.scene.globe, c = v.camera.positionCartographic, out = {};
      let t = performance.now(), h; for (let i = 0; i < 200; i++) h = g.getHeight(c); out.getHeightMs = +((performance.now() - t) / 200).toFixed(3); out.h = h;
      try {   // the bucketed pick (if hooked) against Cesium's full scan, at points all over the rendered tiles near the camera
        const tiles = g._surface._tilesToRender.filter(t => t.data && t.data.terrainData && t.data.terrainData._flexPatchTile), proto = tiles.length && Object.getPrototypeOf(tiles[0].data);
        if (proto && proto.pick._flexOrig) {
          const fast = proto.pick, slow = proto.pick._flexOrig, pts = [], R = Cesium.Rectangle;
          for (let i = 0; i < 400; i++) { const r = tiles[i % tiles.length].rectangle; pts.push(new Cesium.Cartographic(r.west + (r.east - r.west) * Math.random(), r.south + (r.north - r.south) * Math.random())); }
          const run = () => pts.map(c => g.getHeight(c));
          let t = performance.now(); const a = run(); out.fastPickMs = +((performance.now() - t) / pts.length).toFixed(3);
          proto.pick = slow; t = performance.now(); const b = run(); out.slowPickMs = +((performance.now() - t) / pts.length).toFixed(3); proto.pick = fast;
          let md = 0, bad = 0; a.forEach((h, i) => { if (h === undefined || b[i] === undefined) { if (h !== b[i]) bad++; } else md = Math.max(md, Math.abs(h - b[i])); });
          out.pickCheck = { n: pts.length, maxDiffM: md, undefinedMismatch: bad };
        } else out.pickCheck = proto ? 'not hooked' : 'no patch tiles';
      } catch (e) { out.pickCheck = 'ERR ' + e.message; }
      const tp = v.terrainProvider; out.stack = 0; for (let q = tp; q && q._base; q = q._base) out.stack++;
      if (tp._base) {   // bake one tile fully inside the patch (no world data) and one on its west edge, 40 each
        const ts = tp.tilingScheme, D = Math.PI / 180, L = tp._max, mid = (a, b) => (a + b) / 2;
        const tileAt = (lon, lat) => ts.positionToTileXY(new Cesium.Cartographic(lon * D, lat * D), L);
        const r = window.__rect, cy = mid(r.S, r.N), res = {};
        return (async () => { for (const [nm, lon] of [['inner', mid(r.W, r.E)], ['edge', r.W + 5 / 111320]]) {
          const xy = tileAt(lon, cy), t0 = performance.now(); for (let i = 0; i < 40; i++) await tp.requestTileGeometry(xy.x, xy.y, L); res[nm + 'BakeMs'] = +((performance.now() - t0) / 40).toFixed(2); }
          return Object.assign(out, res); })(); }
      return out; });
    const row = Object.assign(micro, { scen: kind, base: BASE, ent: ENT, install: Math.round(inst.install || 0), parts: inst.parts || 0, instEach: inst.installEach }, st);
    if (prof) {   // self time per function
      const byId = new Map(prof.nodes.map(n => [n.id, n])), self = {};
      prof.samples.forEach((id, i) => { const n = byId.get(id), k = (n.callFrame.functionName || '(anon)') + ' ' + path.basename(n.callFrame.url) + ':' + n.callFrame.lineNumber; self[k] = (self[k] || 0) + (prof.timeDeltas[i] || 0) / 1000; });
      const idle = self['(idle) :-1'] || 0, tot = Object.values(self).reduce((a, b) => a + b, 0); row.busyMs = Math.round(tot - idle); row.busyPerFrame = +((tot - idle) / st.frames).toFixed(2);
      if (arg('callers', false)) {   // --callers name: where the self time of a function comes from (callers chain)
        const par = new Map(); prof.nodes.forEach(n => (n.children || []).forEach(c => par.set(c, n.id))); const ch = {};
        prof.samples.forEach((id, i) => { const n = byId.get(id); if (n.callFrame.functionName !== arg('callers')) return; const a = []; let q = id; for (let d = 0; d < 9 && q; d++) { const c = byId.get(q).callFrame; a.push((c.functionName || '(anon)') + ':' + c.lineNumber); q = par.get(q); } const k = a.join(' < '); ch[k] = (ch[k] || 0) + (prof.timeDeltas[i] || 0) / 1000; });
        row.callers = Object.entries(ch).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => Math.round(v) + 'ms ' + k);
      }
      row.patchSelf = Object.entries(self).filter(([k]) => /terrain-patch/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' ' + Math.round(v) + 'ms');
      row.top = Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => k + ' ' + Math.round(v) + 'ms');
    }
    results.push(row);
    console.log(JSON.stringify(row));
    await p.close();
  }
  console.log('\nscen     base  ent  install  fps   p50   p95   p99   max  >50ms >100ms  tiles(avg/max)  patchReq  patchMs  baseReq');
  for (const r of results) console.log([r.scen.padEnd(7), r.base.padEnd(9), r.ent ? 'y' : 'n', String(r.install).padStart(7), r.fps.toFixed(1).padStart(5), r.p50.toFixed(0).padStart(5), r.p95.toFixed(0).padStart(5), r.p99.toFixed(0).padStart(5), r.max.toFixed(0).padStart(5), String(r.over50).padStart(5), String(r.over100).padStart(6), (r.tilesAvg.toFixed(0) + '/' + r.tilesMax).padStart(14), String(r.patchCalls).padStart(9), r.patchMs.toFixed(0).padStart(8), String(r.baseCalls).padStart(8)].join(' '));
  await b.close(); server.kill(); process.exit(0);
})().catch(e => { console.error(e); try { server.kill(); } catch (_) {} process.exit(1); });
