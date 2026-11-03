// label-cull.js — only the labels that can be read (window._labelCull).
//
// A few thousand names on the map are unreadable (they overlap) and cost the frame (every label is a row of glyph
// billboards that Cesium updates and draws). So:
//   - distance: a label is shown only within far() metres, which shrinks as there are more of them
//     (8 km up to 150 labels, 8 km * sqrt(150 / n) beyond, never under 1.5 km);
//   - the nearest `cap` (300) labels that are on the screen, and of those only the ones that do not cover a nearer
//     one (screen-space declutter on a 64 px grid); the rest are hidden;
//   - recomputed when the camera stops (moveEnd), at most every 600 ms while it moves (camera.changed), and when
//     features or ground heights change. Never per frame (see CLAUDE.md on per-frame work).
// The selected entity's label is always shown. label.show is NOT used for this (the Labels switch in 📍 Surface,
// a folder's "names off" and the LiDAR HTML names own it): a culled label gets a 0.5 m distance display condition
// instead, and `e._lcHide = true`, which the LiDAR HTML names also respect.
//
// window._labelCull = { far(n), update(), soon(), stats(), cap, applyShow(e) }
(function () {
  'use strict';
  const V = () => window.cesiumViewer;
  const C = { cap: 300, farMax: 8000, farMin: 1500, full: 150, cell: 64 };
  const S = { n: 0, shown: 0, far: C.farMax, ms: 0, runs: 0 };
  const farFor = n => (n <= C.full ? C.farMax : Math.max(C.farMin, Math.round(C.farMax * Math.sqrt(C.full / n))));
  const textOf = (e, now) => { const t = e.label && e.label.text; const v = t && t.getValue ? t.getValue(now) : t; return String(v == null ? e.name || '' : v); };
  const keyOf = e => { if (e._lcKey === undefined) { const f = e.properties && e.properties.featureId; e._lcKey = String(f && f.getValue ? f.getValue() : e.id); } return e._lcKey; };
  let HIDE = null, SHOW = null;
  function applyShow(e) {
    if (!e.label) return;
    const want = e._lcHide ? HIDE : SHOW;
    if (e._lcDdc !== want) { e.label.distanceDisplayCondition = want; e._lcDdc = want; }
  }
  let lastFar = -1, scratchP = null, scratchS = null;
  function update() {
    const v = V(), P = window._pjf;
    if (!v || !P || !P.labelled || !window.Cesium) return;
    const t0 = performance.now(), Cs = window.Cesium, now = Cs.JulianDate.now();
    const ents = P.labelled().filter(e => e.label);
    const n = ents.length, far = farFor(n);
    S.n = n; S.far = far;
    if (far !== lastFar || !SHOW) { lastFar = far; SHOW = new Cs.DistanceDisplayCondition(0, far); HIDE = HIDE || new Cs.DistanceDisplayCondition(0, 0.5); }
    const cam = v.camera.positionWC, W = v.canvas.clientWidth || window.innerWidth, H = v.canvas.clientHeight || window.innerHeight, M = 150;
    scratchP = scratchP || new Cs.Cartesian3(); scratchS = scratchS || new Cs.Cartesian2();
    const sel = v.selectedEntity, cand = [];
    for (const e of ents) {
      const p = e.position && e.position.getValue(now, scratchP);
      if (!p) { e._lcHide = false; continue; }
      const d = Cs.Cartesian3.distance(cam, p);
      const sp = d <= far ? v.scene.cartesianToCanvasCoordinates(p, scratchS) : null;
      if (!sp || sp.x < -M || sp.y < -M || sp.x > W + M || sp.y > H + M) { e._lcHide = true; continue; }
      cand.push({ e, d, k: keyOf(e), x: sp.x, y: sp.y, w: textOf(e, now).length * 8 + 8 });
    }
    cand.sort((a, b) => (a.e === sel ? -1 : b.e === sel ? 1 : (a.d - b.d) || (a.k < b.k ? -1 : 1)));      // ties (a regular grid) by the feature's own id (an entity's id is new at every redraw), so the same ones stay
    const grid = new Map(), HGT = 20, G = C.cell;
    let shown = 0;
    for (const c of cand) {
      const x0 = c.x - c.w / 2, y0 = c.y - 10 - HGT, x1 = x0 + c.w, y1 = y0 + HGT;
      let hit = false;
      const gx0 = Math.floor(x0 / G), gx1 = Math.floor(x1 / G), gy0 = Math.floor(y0 / G), gy1 = Math.floor(y1 / G);
      for (let gx = gx0; gx <= gx1 && !hit; gx++) for (let gy = gy0; gy <= gy1 && !hit; gy++) {
        const l = grid.get(gx * 100003 + gy);
        if (l) for (const r of l) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) { hit = true; break; }
      }
      const keep = c.e === sel || (!hit && shown < C.cap);
      if (keep) {
        shown++;
        const r = [x0, y0, x1, y1];
        for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) { const k = gx * 100003 + gy; (grid.get(k) || grid.set(k, []).get(k)).push(r); }
      }
      c.e._lcHide = !keep;
    }
    ents.forEach(applyShow);
    S.shown = shown; S.runs++; S.ms = performance.now() - t0;
    if (v.scene.requestRender) v.scene.requestRender();
  }
  let timer = null;
  const soon = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; update(); }, ms == null ? 150 : ms); };
  let lastRun = 0, sig = '';
  const hook = setInterval(() => {
    const v = V(); if (!v || !v.camera || !window._pjf) return;
    clearInterval(hook);
    v.camera.moveEnd.addEventListener(() => soon(50));
    v.camera.percentageChanged = 0.25;
    v.camera.changed.addEventListener(() => { const t = performance.now(); if (t - lastRun > 600) { lastRun = t; soon(0); } });
    window.addEventListener('flex-ground-heights', () => soon(300));
    window.addEventListener('flex-labels-changed', () => soon(100));
    // features or sources came and went: a cheap count of the entities, twice a second
    setInterval(() => {
      const P = window._pjf, w = window._ws; let k = 0;
      if (P && P.labelled) { const last = c => { const a = c.values; return a.length ? a.length + a[a.length - 1].id : '0'; }; k = (window._pjfState && window._pjfState.src ? last(window._pjfState.src.entities) : '0'); if (w && w.vectorSources) w.vectorSources().forEach(s => { k += '/' + last(s.ds.entities); }); }
      const s = k + '|' + !!window._surfLabelsOff;
      if (s !== sig) { sig = s; soon(200); }
    }, 500);
    soon(0);
  }, 400);
  window._labelCull = { far: farFor, update, soon, stats: () => Object.assign({ cap: C.cap }, S), cfg: C, applyShow };
})();
