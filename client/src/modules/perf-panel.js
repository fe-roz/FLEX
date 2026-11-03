// perf-panel.js — the Performance panel (strip button "Speed" above Settings; it opens in the bottom-left dock, #flex-dock in index.html, flex-rail.js).
//
//   - Always on, in perf-probe.js: frame times (fps, percentiles) and the CPU time of each stage of the frame,
//     measured inside render-loop.js. This file only reads it (once a second, and only while the panel is open).
//   - A stacked bar of one frame by category: Point clouds, Terrain & globe, Map layers, Features & lines,
//     Labels & points (the cost of drawing many names and point markers, measured in perf-probe.js), FLEX's own work, GPU. GPU is the frame time minus the measured work, unless the browser has the GPU timer
//     (EXT_disjoint_timer_query_webgl2): then it is measured, and the panel says which.
//   - Counts beside it: points on screen against the budget, terrain tiles, features by source, map layers, Google 3D, shading.
//   - "Run tests" (only on a click: the view flickers): switches one thing off for about a second, measures the
//     frame time, puts it back exactly (the state is read again afterwards), one bar of impact per test.
//   - Suggestions, best gain first, from the tests (measured) or from the stage timings (estimated), each with
//     Apply and Undo. Nothing is applied without a click.
//   - "Running slowly — see why": a small pill when fps stays under 20 for 10 s (once a session; not while the tab is
//     hidden, in the first 15 s, or while a project loads). It only opens the panel.
//
// window._perfPanel = { counts, acts, runTests, stop, results, suggestions, apply, undo, refresh, open, pill, fpsSource, state }
// Under automation (navigator.webdriver) the pill stays off unless localStorage['flex.perf.force'] === '1'.
(function () {
  'use strict';
  const root = document.getElementById('perf-panel');
  const PR = window._perfProbe, PU = window._perfPure;
  if (!root || !PR || !PU) return;
  const $ = id => document.getElementById(id);
  const V = () => window.cesiumViewer, PO = () => window.potreeViewer;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const T = { minItems: 25, maxItemTests: 6, baseMs: 600, offMs: 1000, settleMs: 350, minGainFps: 0.5, minGainShare: 0.04 };   // tests may shorten these

  // The look of each category (colour + words; the legend has both)
  const CATS = {
    cloud: '#5aa9ff', terrain: '#6fd39a', layers: '#e0b84e', features: '#e88fb4', pts: '#f08a4b', own: '#b79cf0', gpu: '#8f9aa3',
  };

  // ── Hooking into the page ───────────────────────────────────────────────
  let attached = false;
  const attach = setInterval(() => {
    const v = V(), po = PO();
    if (attached || !v || !po || !window.Cesium) return;
    attached = true; clearInterval(attach);
    PR.attachCesium(v, window.Cesium);
    let glC = null, glP = null;
    try { glC = v.scene.context._gl; } catch (_) {}
    try { glP = po.renderer && po.renderer.getContext && po.renderer.getContext(); } catch (_) {}
    PR.attachGpu(glC, glP);
  }, 250);

  // ── What there is: counts ──────────────────────────────────────────────
  function counts() {
    const out = { cloud: null, terrain: null, ents: [], layers: null, google: null, edl: null, caves: 0 };
    const po = PO(), v = V();
    try {
      const pcs = (po && po.scene && po.scene.pointclouds) || [];
      let pts = 0, nodes = 0, n = 0;
      pcs.forEach(pc => { if (pc.visible !== false) { n++; pts += pc.numVisiblePoints || 0; nodes += pc.numVisibleNodes || 0; } });
      out.cloud = { clouds: n, points: pts, nodes, budget: po && po.getPointBudget ? po.getPointBudget() : null };
      out.edl = po && po.getEDLEnabled ? !!po.getEDLEnabled() : null;
      if (P.fake && P.fake.cloud) out.cloud = Object.assign({ clouds: 1, points: 0, nodes: 0, budget: po && po.getPointBudget ? po.getPointBudget() : null }, out.cloud, P.fake.cloud);   // tests: the kit has no real cloud
    } catch (_) {}
    try {
      const s = v.scene.globe._surface, q = s._tileLoadQueueHigh.length + s._tileLoadQueueMedium.length + s._tileLoadQueueLow.length;
      out.terrain = { rendered: s._tilesToRender.length, loading: q };
    } catch (_) {}
    try {
      const L = v.imageryLayers, all = [];
      for (let i = 0; i < L.length; i++) all.push(L.get(i));
      out.layers = { shown: all.filter(l => l.show && l.alpha > 0).length, total: all.length };
    } catch (_) {}
    try {
      const chk = $('lp-googlemaps-chk'), prim = v.scene.primitives._primitives[0];
      out.google = prim && prim.constructor && /3DTileset/.test(prim.constructor.name) ? !!(chk && chk.checked && prim.show) : null;
    } catch (_) {}
    try {
      const ws = window._ws, F = window._pjfState, ents = [];
      let proj = 0, ct = 0, files = 0, mine = 0, labels = 0, other = 0;
      const pjSrc = F && F.src;
      if (pjSrc) proj = pjSrc.entities.values.length;
      if (ws && ws.vectorSources) ws.vectorSources().forEach(s => { const n = s.ds._ctCount != null ? s.ds._ctCount : s.ds.entities.values.length; if (s.kind === 'caltopo') ct += n; else files += n; });
      const vals = v.entities.values;
      for (let i = 0; i < vals.length; i++) {
        const p = vals[i].properties;
        if (p && p.isUserLabel) labels++; else if (p && p.myFeature) mine++; else other++;
      }
      [['Project features', proj], ['CalTopo', ct], ['Data files', files], ['My data', mine], ['Names', labels], ['Other', other]].forEach(([k, n]) => ents.push({ label: k, n }));
      out.ents = ents;
      out.caves = (window._caveImports || []).length;
    } catch (_) {}
    return out;
  }

  // ── What can be turned off: each act has get() (the setting now), set(v), off (the value that is "off") ──
  let terrainCache = [];
  async function refreshTerrain() {
    try { const CL = window._customLayers; terrainCache = (await CL.entries()).filter(l => l.kind === 'terrain' && l.blob && CL.api.viewOf(l.id).show); } catch (_) { terrainCache = []; }
  }
  const press = code => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, which: code, key: String.fromCharCode(code), bubbles: true }));
  const chkAct = (id, label, text, group, elId, extra) => {
    const el = $(elId);
    if (!el) return null;
    return Object.assign({
      id, group, label, text, off: false,
      get: () => !!el.checked,
      set: on => { if (el.checked !== !!on) { el.checked = !!on; el.dispatchEvent(new Event('change', { bubbles: true })); } },
    }, extra || {});
  };
  // "Points off": show = false on each point / billboard / label that is on, remembered per entity, restored exactly.
  let ptsOff = false; const ptsSaved = new Map();
  function pointEntities() {
    const out = [], F = window._pjfState, w = window._ws, v = V();
    if (F && F.src) F.src.entities.values.forEach(e => { if (e.point || e.billboard || e.label) out.push(e); });
    if (w && w.vectorSources) w.vectorSources().forEach(s => s.ds.entities.values.forEach(e => { if (e.point || e.billboard || e.label) out.push(e); }));
    if (v) v.entities.values.forEach(e => { if (e.point || e.billboard || e.label) out.push(e); });
    return out;
  }
  const flagOf = g => { const x = g && g.show; return x == null ? true : x.getValue ? x.getValue() : x; };
  function setPointsOff(off) {
    if (off === ptsOff) return;
    ptsOff = off;
    if (off) pointEntities().forEach(e => {
      const o = { p: e.point && flagOf(e.point), b: e.billboard && flagOf(e.billboard), l: e.label && flagOf(e.label) };
      ptsSaved.set(e, o);
      if (e.point) e.point.show = false; if (e.billboard) e.billboard.show = false; if (e.label) e.label.show = false;
    });
    else { ptsSaved.forEach((o, e) => { if (e.point && o.p != null) e.point.show = o.p; if (e.billboard && o.b != null) e.billboard.show = o.b; if (e.label && o.l != null) e.label.show = o.l; }); ptsSaved.clear(); }
    const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
  }
  function acts(c) {
    const out = [], po = PO(), v = V();
    c = c || counts();
    const SC = window._surfCols;
    if (SC && SC.labels) out.push({ id: 'labels', group: 'names', label: 'Names (labels)', text: 'Hide names', off: false, get: () => !!SC.labels(), set: on => SC.labels(!!on) });
    // Points off: every point marker and its name hidden (a what-if for the cost of many points); put back exactly
    try {
      const ents = pointEntities();
      if (ents.length >= T.minItems) out.push({ id: 'points', group: 'points', label: 'Points and names', text: 'Hide the points and names on the map', off: false,
        get: () => !ptsOff, set: on => setPointsOff(!on) });
    } catch (_) {}
    // Project feature folders (top level), CalTopo map, data files
    try {
      const pj = window._pj || {}, F = window._pjf, FL = window.FlexLib;
      if (pj.pid && pj.P && F && FL) {
        const feats = FL.liveFeatures(pj.P), size = {};
        feats.forEach(f => {
          const top = FL.groupPath(pj.P, f.group)[0];
          const k = top ? top.id : 'root';
          size[k] = (size[k] || 0) + 1 + (f.kind === 'point' ? 0 : (f.coords.length || 0) / 20);
        });
        Object.keys(size).filter(k => k !== 'root' && size[k] >= T.minItems).forEach(k => {
          const g = pj.P.groups[k], key = 'g:' + k, name = (g && g.name) || 'folder';
          out.push({ id: 'folder:' + k, group: 'item', size: size[k], label: 'Folder “' + name + '”', text: 'Hide the folder “' + name + '”', off: false,
            get: () => !F.hidden()[key], set: async on => { F.setHidden(key, !on); F.draw(); if (SC && SC.render) SC.render(); } });
        });
      }
    } catch (_) {}
    try {
      const ws = window._ws;
      if (ws && ws.vectorSources) ws.vectorSources().forEach(s => {
        const n = s.ds._ctCount != null ? s.ds._ctCount : s.ds.entities.values.length;
        if (n < T.minItems) return;
        if (s.kind === 'caltopo') out.push({ id: 'caltopo', group: 'item', size: n, label: 'CalTopo map', text: 'Hide the CalTopo map', off: false, get: () => s.ds.show !== false, set: on => { s.ds.show = !!on; if (SC && SC.render) SC.render(); } });
        else out.push({ id: 'file:' + s.url, group: 'item', size: n, label: 'Data file “' + (s.name || 'file') + '”', text: 'Hide the data file “' + (s.name || 'file') + '”', off: false,
          get: () => { const f = ws.dataFiles().find(x => x.url === s.url); return !f || f.show !== false; }, set: on => { ws.setDataFileShown(s.url, !!on); if (SC && SC.render) SC.render(); } });
      });
    } catch (_) {}
    // Point budget: halved, only if it is the limit
    try {
      const b = c.cloud && c.cloud.budget, slider = $('lp-point-budget');
      if (po && b && c.cloud.points > 0.55 * b) {
        const min = slider ? +slider.min : 500000, target = Math.max(min, Math.round(b / 2 / 500000) * 500000);
        out.push({ id: 'budget', group: 'budget', label: 'Point budget halved', text: 'Lower the point budget to ' + PU.fmtCount(target), off: target,
          get: () => po.getPointBudget(), same: (a, b2) => a === b2,
          set: val => { if (slider) { slider.value = val; slider.dispatchEvent(new Event('input', { bubbles: true })); } if (po.getPointBudget() !== val) po.setPointBudget(val); } });
      }
    } catch (_) {}
    if (po && po.getEDLEnabled && po.getEDLEnabled()) {
      const a = chkAct('edl', 'Shading (EDL)', 'Turn shading (EDL) off', 'edl', 'lp-opt-edl');
      if (a) { a.get = () => !!po.getEDLEnabled(); out.push(a); }
    }
    try {
      const prim = v.scene.primitives._primitives[0];
      if (prim && /3DTileset/.test(prim.constructor.name) && c.google) out.push(chkAct('google', 'Google 3D model', 'Turn the Google 3D model off', 'google', 'lp-googlemaps-chk'));
    } catch (_) {}
    if (terrainCache.length) {
      const CL = window._customLayers, ids = terrainCache.map(l => l.id), names = terrainCache.map(l => l.name || 'terrain').join(', ');
      out.push({ id: 'terrain', group: 'terrain', label: 'Terrain patches', text: 'Hide the terrain patches (' + names + ')', off: false, slow: true,
        get: () => ids.every(id => CL.api.viewOf(id).show),
        set: async on => { ids.forEach(id => CL.api.setView(id, { show: !!on })); await CL.sync(); if (window._terrainPanel && window._terrainPanel.render) try { window._terrainPanel.render(); } catch (_) {} } });
    }
    const mm = $('mini_map_container');
    if (mm && mm.style.display !== 'none') out.push({ id: 'minimap', group: 'minimap', label: 'Minimap', text: 'Hide the minimap (M brings it back)', off: false,
      get: () => mm.style.display !== 'none', set: on => { if ((mm.style.display !== 'none') !== !!on) press(77); } });
    if ($('incidence_toggle') && $('incidence_toggle').checked) out.push(chkAct('incidence', 'Incidence lines', 'Turn incidence lines off', 'incidence', 'incidence_toggle'));
    if ($('lp-hag-enable') && $('lp-hag-enable').checked) out.push(chkAct('hag', 'Height filter', 'Turn the height filter off', 'hag', 'lp-hag-enable'));
    return out.filter(Boolean);
  }
  const sameState = (a, b) => (typeof a === 'number' || typeof b === 'number') ? a === b : !!a === !!b;
  /** Switch it off; the returned function puts the earlier setting back. */
  async function turnOff(a) {
    const prev = a.get();
    await a.set(a.off);
    return async () => { await a.set(prev); };
  }

  // ── Measuring ──────────────────────────────────────────────────────────
  /** Mean frame time (ms) over about `ms` of real time, slowest tenth dropped; waits for a few frames if the view is slow. */
  async function sampleMs(ms) {
    const c0 = PR.count, t0 = performance.now();
    for (;;) {
      await wait(50);
      const dt = performance.now() - t0, n = PR.count - c0;
      if ((dt >= ms && n >= 6) || dt >= ms * 5 || stopFlag) break;
    }
    return PU.trimmedMean(PR.dtsSince(c0), 0.1);
  }
  let running = false, stopFlag = false, progress = '', results = null;
  async function runTests() {
    if (running) return results;
    running = true; stopFlag = false;
    const rows = [];
    try {
      await refreshTerrain();
      const c = counts();
      let list = acts(c).filter(a => !sameState(a.get(), a.off));
      const extra = list.filter(a => a.group === 'item').sort((a, b) => b.size - a.size).slice(T.maxItemTests);   // only the biggest few folders / files
      list = list.filter(a => !extra.includes(a));
      renderAll();
      let i = 0;
      for (const a of list) {
        if (stopFlag || document.hidden) break;
        i++; progress = 'Test ' + i + ' of ' + list.length + ': ' + a.label + ' off'; paintProgress();
        const before = a.get();
        const base = await sampleMs(T.baseMs);
        let off = NaN, err = '', undo = null;
        try {
          undo = await turnOff(a);
          await wait(a.slow ? T.settleMs + 1500 : T.settleMs);
          off = await sampleMs(T.offMs);
        } catch (e) { err = String(e && e.message || e); }
        finally {
          try { if (undo) await undo(); } catch (e) { err = err || String(e && e.message || e); }
          await wait(a.slow ? 800 : 200);
        }
        let restored = sameState(a.get(), before);
        if (!restored) { try { await a.set(before); await wait(300); restored = sameState(a.get(), before); } catch (_) {} }
        const r = { id: a.id, label: a.label, text: a.text, baseMs: base, offMs: off, gainMs: base - off, gainFps: isFinite(base - off) ? PU.fpsGain(base, off) : 0, restored, error: err, act: a };
        rows.push(r);
        results = { at: Date.now(), rows: rows.slice(), done: false }; paintTests();
      }
    } finally {
      running = false; progress = '';
      results = { at: Date.now(), rows, done: !stopFlag, stopped: stopFlag };
      buildSuggestions(true);
      renderAll();
    }
    return results;
  }
  function stop() { stopFlag = true; }

  // ── Suggestions ────────────────────────────────────────────────────────
  let S = [];           // cards: { id, text, gainFps, measured, act, applied, undo }
  function candidates() {
    const c = counts(), st = PR.stats(120), cats = PU.categories(st.avg, st.frameMs, { gpuMs: PR.gpu.mode === 'measured' ? PR.gpu.ms : null }), A = acts(c), out = [];
    const byId = {};
    if (results && results.rows) results.rows.forEach(r => { byId[r.id] = r; });
    A.forEach(a => {
      const r = byId[a.id];
      if (r && isFinite(r.gainMs) && r.gainMs > T.minGainShare * r.baseMs) out.push({ id: a.id, text: a.text, act: a, gainFps: r.gainFps, measured: true });
      else if (!r) {
        // an estimate from the stage timings, only for things the probe times directly
        let ms = 0;
        if (a.id === 'labels' || a.id === 'points') ms = (a.id === 'labels' ? st.avg.labels : 0) + st.avg.ptsEnt + st.avg.ptsPrim + st.avg.ptsGlobe; else if (a.id === 'minimap') ms = st.avg.minimap; else if (a.id === 'incidence') ms = st.avg.incidence;
        else if (a.id === 'budget') ms = 0.4 * (st.avg.potreeUpdate + st.avg.potreeRender);
        const g = PU.estGainFps(st.frameMs, ms);
        if (g > 0) out.push({ id: a.id, text: a.text, act: a, gainFps: g, measured: false });
      }
    });
    return { list: PU.rank(out, T.minGainFps), cats };
  }
  function buildSuggestions(force) {
    if (!force && S.some(x => x.applied)) return;             // do not move things under a click
    const { list } = candidates();
    S = list.map(x => Object.assign({ applied: false, undo: null, busy: false }, x));
  }
  const sugOf = id => S.find(x => x.id === id);
  async function apply(id) {
    const x = sugOf(id); if (!x || x.applied || x.busy) return;
    x.busy = true;
    try { x.undo = await turnOff(x.act); x.applied = true; } catch (e) { x.error = String(e && e.message || e); }
    x.busy = false; paintSuggestions();
  }
  async function undo(id) {
    const x = sugOf(id); if (!x || !x.applied || x.busy) return;
    x.busy = true;
    try { await x.undo(); x.applied = false; x.undo = null; } catch (e) { x.error = String(e && e.message || e); }
    x.busy = false; paintSuggestions();
  }

  // ── The panel ──────────────────────────────────────────────────────────
  root.innerHTML = `<div class="lp-section">
      <div class="lp-section-header" onclick="window._lpToggle(this)"><span class="lp-section-arrow">▾</span> Performance</div>
      <div class="lp-section-body open">
        <div class="pf-top"><span class="pf-fps"><b id="pf-fps">–</b> fps</span><span class="pf-pct" id="pf-pct"></span></div>
        <div class="pf-verdict" id="pf-verdict"></div>
        <div class="pf-bar" id="pf-bar" role="img" aria-label="One frame, in milliseconds, by kind of work"></div>
        <div class="pf-scale"><span>0</span><span id="pf-scale-end"></span></div>
        <div id="pf-legend" class="pf-legend"></div>
        <div class="pf-sub" id="pf-own"></div>
        <canvas id="pf-hist" width="320" height="46" title="The last minute, one column a second (the same colours); a red mark on top = a second with hitches (jerky frames)"></canvas>
        <div class="pf-note" id="pf-gpu"></div>
        <div class="pf-h">On screen now</div>
        <div id="pf-counts" class="pf-counts"></div>
      </div>
    </div>
    <div class="lp-section">
      <div class="lp-section-header" onclick="window._lpToggle(this)"><span class="lp-section-arrow">▾</span> What would help</div>
      <div class="lp-section-body open">
        <div class="pf-run"><button type="button" id="pf-run" class="btn btn-sm btn-secondary" title="Turns one thing off at a time for about a second and measures the difference. The view flickers meanwhile.">Run tests</button>
          <button type="button" id="pf-stop" class="btn btn-sm btn-secondary" hidden>Stop</button>
          <span class="pf-prog" id="pf-prog"></span></div>
        <div class="pf-note">Each test switches one thing off for about a second, measures, and puts it back. The view flickers while it runs.</div>
        <div id="pf-tests"></div>
        <div class="pf-h">Suggestions</div>
        <div id="pf-sug"></div>
      </div>
    </div>`;
  const q = id => $(id);

  function fmtFps(x) { return isFinite(x) ? (x >= 100 ? Math.round(x) : x.toFixed(1)) : '–'; }
  function paintLive() {
    const st = PR.stats(300), s = st.summary;
    q('pf-fps').textContent = fmtFps(s.fps);
    q('pf-pct').textContent = s.n ? `median ${PU.fmtMs(s.p50)} · 95% under ${PU.fmtMs(s.p95)} · worst ${PU.fmtMs(s.max)}` : 'waiting for frames';
    const hits = PR.hitchCount(10000), vd = PU.verdict(hits, s.n ? s.fps : NaN);
    const vEl = q('pf-verdict'); vEl.textContent = s.n ? vd.text + (isFinite(s.low1) ? ` · 1% low ${fmtFps(s.low1)} fps` : '') : ''; vEl.dataset.v = vd.id;
    const st2 = PR.stats(120), frameMs = st2.frameMs;
    const gpuMs = PR.gpu.mode === 'measured' ? PR.gpu.ms : null;
    const cats = PU.categories(st2.avg, frameMs, { gpuMs });
    const total = cats.rows.reduce((a, r) => a + r.ms, 0) + cats.idle, scale = Math.max(33.4, Math.ceil(total / 16.7) * 16.7);
    q('pf-bar').innerHTML = cats.rows.concat(cats.idle > 0.05 ? [{ id: 'idle', label: 'Waiting for the screen', ms: cats.idle }] : [])
      .map(r => `<i data-cat="${r.id}" style="width:${(100 * r.ms / scale).toFixed(2)}%;background:${CATS[r.id] || 'transparent'}" title="${esc(r.label)}: ${PU.fmtMs(r.ms)}"></i>`).join('') + `<u style="left:${(100 * 16.7 / scale).toFixed(2)}%" title="60 frames a second"></u>`;
    q('pf-scale-end').textContent = Math.round(scale) + ' ms  (line = 16.7 ms, 60 fps)';
    q('pf-legend').innerHTML = cats.rows.map(r => `<div class="pf-row" data-cat="${r.id}"><span class="sw" style="background:${CATS[r.id]}"></span><span class="nm">${esc(r.label)}</span><span class="ms">${PU.fmtMs(r.ms)}</span></div>`).join('') +
      (cats.idle > 0.05 ? `<div class="pf-row dim" data-cat="idle"><span class="sw"></span><span class="nm">Waiting for the screen</span><span class="ms">${PU.fmtMs(cats.idle)}</span></div>` : '');
    const o = cats.own, bits = [['minimap', o.minimap], ['incidence', o.incidence], ['compass', o.compass], ['measuring', o.measure], ['readouts and camera', o.own]].filter(b => b[1] >= 0.05);
    q('pf-own').textContent = bits.length ? "FLEX's own work: " + bits.map(b => b[0] + ' ' + PU.fmtMs(b[1])).join(' · ') : '';
    q('pf-gpu').textContent = PR.gpu.mode === 'measured' ? 'GPU time: measured with a GPU timer query.' :
      'GPU time: estimated (frame time minus the measured work; frames held to the screen\'s refresh show as waiting). This browser has no GPU timer (' + PR.gpu.why + ').';
    paintHist(cats);
    paintCounts();
  }
  const hist = [];
  function pushHist() {
    const st = PR.stats(60); if (!st.n) return;
    const cats = PU.categories(st.avg, st.frameMs, { gpuMs: PR.gpu.mode === 'measured' ? PR.gpu.ms : null });
    const h = cats.rows.map(r => ({ id: r.id, ms: r.ms })); h.hits = PR.hitchCount(1000);
    hist.push(h);
    if (hist.length > 60) hist.shift();
  }
  function paintHist() {
    const cv = q('pf-hist'); if (!cv || !cv.getContext) return;
    const g = cv.getContext('2d'), w = cv.width, h = cv.height, bw = w / 60;
    g.clearRect(0, 0, w, h);
    const max = Math.max(33.4, ...hist.map(c => c.reduce((a, r) => a + r.ms, 0)));
    hist.forEach((c, i) => { let y = h; c.forEach(r => { const hh = h * r.ms / max; g.fillStyle = CATS[r.id]; g.fillRect((60 - hist.length + i) * bw, y - hh, bw - 0.5, hh); y -= hh; }); });
    g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(0, h - h * 16.7 / max, w, 1);
    g.fillStyle = '#ff4d4d'; hist.forEach((c, i) => { if (c.hits) g.fillRect((60 - hist.length + i) * bw, 0, bw - 0.5, 3); });      // a second with hitches
  }
  function paintCounts() {
    const c = counts(), rows = [];
    if (c.cloud) rows.push(['Point clouds', c.cloud.clouds ? `${PU.fmtCount(c.cloud.points)} points of a ${PU.fmtCount(c.cloud.budget)} budget · ${PU.fmtCount(c.cloud.nodes)} nodes` : 'none loaded']);
    if (c.terrain) rows.push(['Terrain tiles', `${c.terrain.rendered} drawn · ${c.terrain.loading} loading`]);
    if (c.ents.length) rows.push(['Features', c.ents.filter(e => e.n).map(e => `${e.label} ${PU.fmtCount(e.n)}`).join(' · ') || 'none']);
    rows.push(['Caves', c.caves ? c.caves + ' loaded' : 'none loaded']);
    if (c.layers) rows.push(['Map layers shown', `${c.layers.shown} of ${c.layers.total}`]);
    rows.push(['Google 3D model', c.google == null ? 'not available' : c.google ? 'on' : 'off']);
    rows.push(['Shading (EDL)', c.edl == null ? '–' : c.edl ? 'on' : 'off']);
    q('pf-counts').innerHTML = rows.map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  }
  function paintProgress() {
    q('pf-prog').textContent = progress;
    q('pf-run').disabled = running; q('pf-stop').hidden = !running;
  }
  function paintTests() {
    paintProgress();
    const rows = (results && results.rows) || [];
    if (!rows.length) { q('pf-tests').innerHTML = running ? '' : '<div class="pf-none">No tests run yet.</div>'; return; }
    const max = Math.max(1, ...rows.map(r => (isFinite(r.gainMs) ? r.gainMs : 0)));
    q('pf-tests').innerHTML = rows.slice().sort((a, b) => b.gainMs - a.gainMs).map(r => {
      const w = isFinite(r.gainMs) && r.gainMs > 0 ? Math.max(2, 100 * r.gainMs / max) : 0;
      const txt = r.error ? 'failed' : !isFinite(r.gainMs) ? 'no frames' : r.gainFps >= T.minGainFps ? '+' + r.gainFps.toFixed(1) + ' fps' : 'no change';
      return `<div class="pf-t" data-test="${esc(r.id)}"><span class="nm">${esc(r.label)} off</span><span class="imp" title="${isFinite(r.baseMs) ? PU.fmtMs(r.baseMs) + ' → ' + PU.fmtMs(r.offMs) : ''}"><i style="width:${w}%"></i></span><span class="g">${txt}</span>${r.restored ? '' : '<span class="bad" title="Could not put this back; check it by hand">!</span>'}</div>`;
    }).join('') + (results && results.stopped ? '<div class="pf-none">Stopped.</div>' : '');
  }
  let sugSig = '';
  function paintSuggestions() {
    if (!q('pf-sug')) return;
    if (!S.length) {
      sugSig = '';
      const c = candidates().cats, top = c.rows.slice(0, 5).sort((a, b) => b.ms - a.ms)[0];
      q('pf-sug').innerHTML = `<div class="pf-none">${results ? 'Nothing found that is worth turning off.' : 'Nothing stands out yet. Run the tests to measure.'}${top && top.ms > 1 ? ' Most of the time goes to ' + esc(top.label.toLowerCase()) + ' (' + PU.fmtMs(top.ms) + ').' : ''}</div>`;
      return;
    }
    const sig = S.map(x => x.id + ':' + x.gainFps.toFixed(1) + x.applied + x.busy + (x.error || '')).join('|') + results;
    if (sig === sugSig && q('pf-sug').children.length) return;
    sugSig = sig;
    q('pf-sug').innerHTML = S.map(x => `<div class="pf-s" data-sug="${esc(x.id)}"><span class="tx">${esc(x.text)}</span><span class="gn">${x.measured ? '' : 'about '}+${x.gainFps.toFixed(1)} fps${x.measured ? '' : ' (estimate)'}</span>` +
      (x.applied ? `<button type="button" class="btn btn-sm btn-secondary" data-undo="${esc(x.id)}">Undo</button>` : `<button type="button" class="btn btn-sm btn-primary" data-apply="${esc(x.id)}"${x.busy ? ' disabled' : ''}>Apply</button>`) +
      (x.error ? `<span class="bad" title="${esc(x.error)}">!</span>` : '') + '</div>').join('');
  }
  function renderAll() { paintLive(); paintTests(); paintSuggestions(); }
  function refresh() { if (!root.isConnected) return; paintLive(); if (!running) { buildSuggestions(false); paintSuggestions(); } }

  q('pf-run').addEventListener('click', () => { runTests(); });
  q('pf-stop').addEventListener('click', stop);
  q('pf-sug').addEventListener('click', e => {
    const a = e.target.closest('[data-apply]'), u = e.target.closest('[data-undo]');
    if (a) apply(a.dataset.apply); else if (u) undo(u.dataset.undo);
  });

  // While open: once a second. Closed: nothing but the probe.
  const isOpen = () => { const p = $('perfCollapsible'); return !!(p && p.classList.contains('show')) && !document.hidden; };
  let tick = 0;
  setInterval(() => {
    if (!isOpen()) return;
    if (tick++ % 5 === 0) refreshTerrain();
    pushHist(); refresh();
  }, 1000);
  const po = document.getElementById('perfCollapsible');
  if (po) new MutationObserver(() => { if (isOpen()) { refreshTerrain(); renderAll(); } }).observe(po, { attributes: true, attributeFilter: ['class'] });

  // ── "Running slowly — see why" ─────────────────────────────────────────
  const pst = { lowSince: null, fired: false };
  try { if (sessionStorage.getItem('flex.perf.pill') === '1') pst.fired = true; } catch (_) {}
  const auto = !(navigator.webdriver && (() => { try { return localStorage.getItem('flex.perf.force') !== '1'; } catch (_) { return true; } })());
  const P = { fpsSource: null, fake: null, force: false };
  let sinceShow = null;
  function showPill() {
    try { sessionStorage.setItem('flex.perf.pill', '1'); } catch (_) {}
    const b = document.createElement('div'); b.id = 'perf-pill'; b.setAttribute('role', 'status');
    const fps = P.fpsSource ? P.fpsSource() : PR.recentFps(1000), jerky = !(fps < PR.cfg.lowFps), hs = PR.hitchCount(10000);
    b.innerHTML = '<button type="button" class="pp-go">' + (jerky ? 'Running jerkily — see why (' + hs + ' hitches in 10 s)' : 'Running slowly — see why (' + (fps < 10 ? fps.toFixed(1) : Math.round(fps)) + ' fps)') + '</button><button type="button" class="pp-x" title="Dismiss" aria-label="Dismiss">×</button>';
    b.querySelector('.pp-go').addEventListener('click', () => { b.remove(); open(); });
    b.querySelector('.pp-x').addEventListener('click', () => b.remove());
    document.body.appendChild(b);
  }
  function open() { if (window._rail && window._rail.open) window._rail.open('#perfCollapsible'); }
  setInterval(() => {
    if (!auto && !P.force) return;
    const loading = !!document.querySelector('#pj-loading.on');
    const fps = P.fpsSource ? P.fpsSource() : PR.recentFps(1000);
    if (pillStep(fps, loading)) showPill();
  }, 1000);
  function pillStep(fps, loading) {
    if (document.hidden) { sinceShow = performance.now(); pst.lowSince = null; return false; }
    if (sinceShow != null && performance.now() - sinceShow < 3000) { pst.lowSince = null; return false; }   // just back from a hidden tab
    // Jerky counts too: many hitches in the last 10 s stand in for a low frame rate
    const eff = PR.hitchCount(10000) >= PR.cfg.jerkyHits ? Math.min(isFinite(fps) ? fps : 0, PR.cfg.lowFps - 1) : fps;
    return PU.pillStep(pst, performance.now(), eff, { hidden: false, loading, sinceLoadMs: performance.now() }, PR.cfg);
  }

  const style = document.createElement('style');
  style.textContent = `
  #perf-panel { width: 360px; max-width: 100%; font-size: 11.5px; }
  #perf-panel .pf-top { display: flex; align-items: baseline; gap: 10px; margin: 2px 0 6px; flex-wrap: wrap; }
  #perf-panel .pf-fps { font-size: 12px; color: rgba(255,255,255,.7); } #perf-panel .pf-fps b { font-size: 26px; color: #e8ece9; font-variant-numeric: tabular-nums; }
  #perf-panel .pf-pct { color: rgba(255,255,255,.6); font-size: 11px; }
  #perf-panel .pf-bar { position: relative; display: flex; height: 18px; background: rgba(255,255,255,.07); border-radius: 4px; overflow: hidden; }
  #perf-panel .pf-bar i { display: block; height: 100%; min-width: 0; }
  #perf-panel .pf-bar u { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,.8); text-decoration: none; }
  #perf-panel .pf-scale { display: flex; justify-content: space-between; font-size: 9.5px; color: rgba(255,255,255,.45); margin: 2px 0 6px; }
  #perf-panel .pf-legend .pf-row { display: grid; grid-template-columns: 12px 1fr auto; gap: 7px; align-items: center; padding: 1.5px 0; }
  #perf-panel .pf-row .sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; border: 1px solid rgba(255,255,255,.25); }
  #perf-panel .pf-row .ms { font-variant-numeric: tabular-nums; color: #e8ece9; } #perf-panel .pf-row.dim { color: rgba(255,255,255,.5); }
  #perf-panel .pf-verdict { font-size: 11.5px; margin: -2px 0 6px; color: #6fd39a; } #perf-panel .pf-verdict[data-v=jerky] { color: #f2c24e; } #perf-panel .pf-verdict[data-v=slow] { color: #ff7b6b; }
  #perf-panel .pf-sub, #perf-panel .pf-note { color: rgba(255,255,255,.5); font-size: 10.5px; margin: 4px 0; }
  #perf-panel canvas { width: 100%; height: 46px; margin-top: 6px; background: rgba(255,255,255,.04); border-radius: 4px; }
  #perf-panel .pf-h { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.5); font-weight: 700; margin: 10px 0 4px; }
  #perf-panel .pf-counts > div { display: grid; grid-template-columns: 110px 1fr; gap: 6px; padding: 1.5px 0; }
  #perf-panel .pf-counts .k { color: rgba(255,255,255,.55); } #perf-panel .pf-counts .v { color: #e8ece9; }
  #perf-panel .pf-run { display: flex; align-items: center; gap: 8px; margin: 2px 0 4px; } #perf-panel .pf-prog { color: #f2c24e; font-size: 11px; }
  #perf-panel .pf-t { display: grid; grid-template-columns: 1fr 90px 62px 12px; gap: 7px; align-items: center; padding: 2px 0; }
  #perf-panel .pf-t .imp { height: 8px; background: rgba(255,255,255,.08); border-radius: 4px; overflow: hidden; } #perf-panel .pf-t .imp i { display: block; height: 100%; background: #6fd39a; }
  #perf-panel .pf-t .g { text-align: right; font-variant-numeric: tabular-nums; color: #e8ece9; }
  #perf-panel .bad { color: #f2c24e; font-weight: 700; }
  #perf-panel .pf-s { display: grid; grid-template-columns: 1fr auto auto 12px; gap: 8px; align-items: center; padding: 4px 0; border-top: 1px solid rgba(255,255,255,.08); }
  #perf-panel .pf-s .gn { color: #6fd39a; font-variant-numeric: tabular-nums; font-size: 10.5px; }
  #perf-panel .pf-none { color: rgba(255,255,255,.55); padding: 3px 0; }
  #perf-pill { position: fixed; z-index: 9940; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; background: rgba(20,22,30,.97); border: 1px solid #f2c24e; border-radius: 16px; font: 12.5px system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
  #perf-pill button { background: none; border: none; color: #f2c24e; cursor: pointer; padding: 6px 10px; font: inherit; }
  #perf-pill .pp-x { color: rgba(255,255,255,.6); padding: 6px 10px 6px 2px; font-size: 16px; line-height: 1; }`;
  document.head.appendChild(style);

  Object.assign(P, {
    counts, acts: () => acts(), runTests, stop, apply, undo, refresh, open, tune: o => Object.assign(T, o),
    buildSuggestions: () => { buildSuggestions(true); paintSuggestions(); }, refreshTerrain, setPointsOff, pill: pst, sampleMs,
  });
  Object.defineProperties(P, { results: { get: () => results }, suggestions: { get: () => S }, running: { get: () => running } });
  window._perfPanel = P;
})();
