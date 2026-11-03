// Point labels performance (project-features.js, label-place.js, perf-probe.js) in headless Chromium on the GPU, synthetic data only.
//   NODE_PATH=~/flex-tests/node_modules node tools/perf_labels.js [options]
//   --n 2000          points (each with a name) in a 4 km square, as project features (the real draw path)
//   --labels on|off   the 📍 Surface "Labels" switch while measuring (default on)
//   --secs 20         seconds flown; the camera flies east at 60 m/s, 600 m up, pitch -35, over the points
//   --uncap           no vsync cap: fps is then the real throughput (default on; --uncap false for vsync)
//   --base real|ellipsoid   world terrain: a provider with 40 ms tile latency to level 13 (default), or flat
//   --profile         CDP CPU profile: the top self-time functions are printed
//   --patch           install a 3 km synthetic terrain patch (2 m posts) under the points first, as in tools/perf_terrain_patch.js
//   --area 4000       side of the square the points are spread over, metres
//   --throttle 1      CPU throttle factor (CDP); --kit ~/flex-tests; --port 8392
//   --git REF         measure the page of another checkout instead (default: the checkout this file is in)
// Prints one JSON line: fps, frame percentiles, long frames, the probe's category averages, clamp callbacks.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const KIT = String(arg('kit', path.join(os.homedir(), 'flex-tests'))).replace(/^~/, os.homedir());
const { chromium } = require(path.join(KIT, 'node_modules/playwright'));
const REPO = path.resolve(String(arg('repo', path.join(__dirname, '..'))).replace(/^~/, os.homedir())), CES = path.join(KIT, 'node_modules/cesium/Build/' + (arg('unmin', false) ? 'CesiumUnminified' : 'Cesium'));
const N = +arg('n', 2000), LABELS = arg('labels', 'on') !== 'off', SECS = +arg('secs', 20), THR = +arg('throttle', 1), PORT = +arg('port', 8392), BASE = arg('base', 'real');
const PATCH = !!arg('patch', false), AREA = +arg('area', 4000);
const UNCAP = arg('uncap', 'true') !== 'false';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'perf_lb_')), APP = path.join(WORK, 'app');
fs.mkdirSync(APP);
cp.execSync(`tar -C "${REPO}" --exclude=./.git --exclude=./node_modules --exclude=./user_files --exclude=./PotreeCopied --exclude=./Tokens.js -cf - . | tar -C "${APP}" -xf -`);
fs.symlinkSync(path.join(REPO, 'PotreeCopied'), path.join(APP, 'PotreeCopied'));
fs.symlinkSync(fs.realpathSync(path.join(REPO, 'node_modules')), path.join(APP, 'node_modules'));
fs.copyFileSync(path.join(REPO, 'Tokens.js.example'), path.join(APP, 'Tokens.js'));
fs.mkdirSync(path.join(APP, 'user_files'));
if (fs.existsSync(path.join(KIT, 'baseline/user_files'))) cp.execSync(`cp -r "${KIT}/baseline/user_files/." "${APP}/user_files/"`);
cp.execSync(`sed -i "s/port: 8081/port: ${PORT}/" "${APP}/settings.js"`);
const server = cp.spawn('node', ['server.js', 'perflabels'], { cwd: APP, stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch (_) {} });

(async () => {
  for (let i = 0; i < 80; i++) { try { await fetch(`http://localhost:${PORT}/index.html`); break; } catch (_) { await new Promise(r => setTimeout(r, 250)); } }
  const b = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'].concat(UNCAP ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []) });
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
    }, { base: BASE });  await p.addInitScript(() => { try { localStorage.setItem('flex.author', 'T'); } catch (_) {} });
  await p.goto(`http://localhost:${PORT}/index.html`);
  await p.waitForFunction(() => window.cesiumViewer && window._pj && window._pj.ready && window._surfCols, null, { timeout: 90000 });
  await p.waitForTimeout(2500);
  if (PATCH) {
    const res = await p.evaluate(async () => {
      const TP = window._terrainPatch, lat0 = 45.1234, lon0 = -100.5678, cell = 2, mLat = 110540, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
      const km = 2.995, n = Math.round(km * 1000 / cell) + 1;
      const W = lon0 - km * 500 / mLon, E = lon0 + km * 500 / mLon, S = lat0 - km * 500 / mLat, N = lat0 + km * 500 / mLat;
      const wob = (x, y) => 3 * Math.sin(x * 0.05) * Math.cos(y * 0.07) + 8 * Math.sin(x * 0.004 + y * 0.003);
      const plan = TP.plan(W, S, E, N, cell), dlon = (E - W) / (plan.nx - 1), dlat = (N - S) / (plan.ny - 1), t0 = performance.now();
      for (const t of plan.tiles) {
        const west = W + t.i0 * dlon, north = N - t.j0 * dlat, east = west + (t.nx - 1) * dlon, south = north - (t.ny - 1) * dlat, g = new Float32Array(t.nx * t.ny);
        for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) { const gi = t.i0 + i, gj = t.j0 + j; g[j * t.nx + i] = window.__world(W + gi * dlon, N - gj * dlat) + 4 + wob(gi * cell, gj * cell); }
        const url = URL.createObjectURL(new Blob([TP.pack({ west, south, east, north, nx: t.nx, ny: t.ny, name: 'perf', cell_m: cell }, g)]));
        await TP.install(window.cesiumViewer, url);
      }
      window.dispatchEvent(new CustomEvent('flex-terrain-changed', { detail: { ids: ['perf'] } }));
      return { ms: Math.round(performance.now() - t0), parts: plan.tiles.length };
    });
    console.log('patch', JSON.stringify(res));
  }
  // N points with names, as project features, in a 4 km square (45.1234, -100.5678 is the example centre)
  const t0 = Date.now();
  await p.evaluate(async ({ n, lat0, lon0, AREA }) => {
    await fetch('/api/lib/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'perf', name: 'Perf test' }) });
    window._pj.projects = await (await fetch('/api/lib/projects')).json();
    await window._pj._setProject('perf', { keep: true });
    const R = window._pjApi.record, mLat = 110540, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    await R('project.set', { name: 'Perf test' });
    await R('group.set', { group: 'gP', name: 'Pits', color: '#00ff00' });
    const side = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const gx = i % side, gy = Math.floor(i / side), jx = (Math.sin(i * 12.9898) * 43758.5453) % 1, jy = (Math.sin(i * 78.233) * 12345.678) % 1;
      await R('feature.set', { feature: 'pt' + i, kind: 'point', name: 'Pit ' + i, coords: [[lon0 + ((gx + 0.4 * jx) / side - 0.5) * AREA / mLon, lat0 + ((gy + 0.4 * jy) / side - 0.5) * AREA / mLat, 0]], group: 'gP' });
    }
  }, { n: N, lat0: 45.1234, lon0: -100.5678, AREA });
  console.log('records', N, 'in', Date.now() - t0, 'ms');
  await p.evaluate(on => window._surfCols.labels(on), LABELS);
  await p.waitForFunction(n => window._pjfState && window._pjfState.src && window._pjfState.src.entities.values.length >= n, N, { timeout: 120000 });
  await p.evaluate(({ secs, lat0, lon0 }) => {
    const v = window.cesiumViewer, C = Cesium, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    const S = window.__S = { frames: [], done: false, cb: 0 };
    const lonA = lon0 - 1500 / mLon;
    let t0 = null, last = null;
    const tick = now => {
      if (t0 === null) t0 = now;
      const t = (now - t0) / 1000;
      if (last !== null) S.frames.push(now - last); last = now;
      if (t < secs) { v.camera.setView({ destination: C.Cartesian3.fromDegrees(lonA + 60 * t / mLon, lat0 - 1100 / 110540, 600), orientation: { heading: C.Math.toRadians(0), pitch: C.Math.toRadians(-35), roll: 0 } }); requestAnimationFrame(tick); }
      else S.done = true;
    };
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(lonA, lat0 - 1100 / 110540, 600), orientation: { heading: 0, pitch: C.Math.toRadians(-35), roll: 0 } });
    window.__start = () => requestAnimationFrame(tick);
  }, { secs: SECS, lat0: 45.1234, lon0: -100.5678 });
  await p.waitForTimeout(6000);   // terrain tiles and the first sampling settle
  if (THR > 1) { const c2 = await p.context().newCDPSession(p); await c2.send('Emulation.setCPUThrottlingRate', { rate: THR }); }
  if (arg('dbg', false)) await p.evaluate(() => {
    const SP = Cesium.Scene.prototype, o = SP.updateHeight; window.__uh = { n: 0, who: {} };
    SP.updateHeight = function () { window.__uh.n++; const w = (new Error().stack.split('\n').slice(2, 9).map(l => l.trim().replace(/\(?https?:.*\/([^/]*)$/, '$1')).join(' < ')) + ' @' + (arguments[0] ? Cesium.Math.toDegrees(arguments[0].latitude).toFixed(4) + ',' + Cesium.Math.toDegrees(arguments[0].longitude).toFixed(4) : '') + ' hr' + arguments[2]; window.__uh.who[w] = (window.__uh.who[w] || 0) + 1; return o.apply(this, arguments); };
  });
  let cdp; if (arg('profile', false)) { cdp = await p.context().newCDPSession(p); await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
  await p.evaluate(() => { window.__start(); });
  await p.waitForFunction(() => window.__S.done, null, { timeout: (SECS + 120) * 1000, polling: 500 });
  if (cdp) {
    const prof = (await cdp.send('Profiler.stop')).profile, byId = new Map(prof.nodes.map(n => [n.id, n])), self = {};
    prof.samples.forEach((id, i) => { const n = byId.get(id), k = (n.callFrame.functionName || '(anon)') + ' ' + path.basename(n.callFrame.url) + ':' + n.callFrame.lineNumber; self[k] = (self[k] || 0) + (prof.timeDeltas[i] || 0) / 1000; });
    console.log(Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 22).map(([k, v]) => Math.round(v) + 'ms ' + k).join('\n'));
  }
  if (arg('dbg', false)) console.log(JSON.stringify(await p.evaluate(() => window.__uh), null, 1));
  const st = await p.evaluate(() => {
    const S = window.__S, f = S.frames.slice().sort((a, b) => a - b), q = x => f[Math.min(f.length - 1, Math.floor(f.length * x))], sum = f.reduce((a, b) => a + b, 0);
    const pr = window._perfProbe, s = pr.stats(120), ents = window._pjfState.src.entities.values;
    return { frames: f.length, fps: +(f.length / (sum / 1000)).toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +f[f.length - 1].toFixed(0),
      over100: f.filter(x => x > 100).length, hitches: f.filter(x => x > 2 * q(0.5) && x > 33.4).length, low1: +(1000 / (f.slice(-Math.max(1, Math.round(f.length * 0.01))).reduce((a, b) => a + b, 0) / Math.max(1, Math.round(f.length * 0.01)))).toFixed(1), ents: ents.length, labelsShown: ents.filter(e => e.label && e.label.show && e.label.show.getValue ? e.label.show.getValue() : false).length,
      avgMs: Object.fromEntries(Object.entries(s.avg).map(([k, v]) => [k, +v.toFixed(2)])), cpuMs: +s.cpuMs.toFixed(1) };
  });
  console.log(JSON.stringify(Object.assign({ n: N, labels: LABELS, base: BASE, uncap: UNCAP, repo: REPO }, st)));
  await b.close(); server.kill(); process.exit(0);
})().catch(e => { console.error(e); try { server.kill(); } catch (_) {} process.exit(1); });
