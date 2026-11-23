// lidar-section.js — 📊 LiDAR → Section: click two points on the map, see the side view through the point cloud.
// window._lidarSection. The arithmetic is in section-math.js (window._sectionMath).
//
// The line: two clicks on the ground (a rubber line while picking, Esc cancels). It stays on the map, drawn over the
// point cloud; its two ends can be dragged; a new section replaces it.
// The returns: Potree only holds the nodes of the current view, so a section through a far or coarse part would be
// thin. Potree's own profile request (PointCloudOctree.getPointsInProfile: PotreeCopied, unchanged) is used instead: it
// loads every node the line crosses, coarse levels first, and hands back the returns in the cloud's WORLD frame, i.e.
// through pointcloud.matrixWorld — the same matrix the map draws with (the datum shift and the height scale of the
// LiDAR panel's Height correction are in it; where that correction stretches the heights, they are brought back the
// way the map's own ground reader does), so a height here is the height the map reads. Every visible cloud is asked.
// The request is always SLICE_MAX metres wide; the Thickness slider only chooses which of those returns are drawn, so
// it answers at once. At most CAP returns are kept (the request is stopped there, and the window says so). Potree
// moves a request on by one node per drawn frame; while a section is being read it is moved on here too (pump).
// The window: its own floating, resizable panel. Distance along the line across, height up, 1:1 or 2x / 4x taller.
// Wheel zooms at the cursor, drag pans, double-click fits. Hover: the return under the cursor (distance along, height,
// class, return number), ringed on the map too. Click two returns: the ruler (across, up / down, straight; metres and
// feet, FLEX's units first). The map's cursor is marked along the section while the window is open.
// A processed area with Ridgewalking shown on the map (window._ridgeDraw): its returns below ground that fall in the
// slice are ringed in the depth colours, over the raw cloud.
// Nothing runs per frame: the picture is drawn again only when its returns, view or settings change.
(function () {
  'use strict';
  const w = window, doc = document, M = () => w._sectionMath;
  const SLICE_MAX = 10, SLICE_MIN = 0.5, SLICE_DEFAULT = 2, CAP = 1500000;
  const LS = 'flex.section';
  const V = () => w.cesiumViewer, PV = () => w.potreeViewer;
  const S = {
    a: null, b: null,            // the ends: { lon, lat }
    picking: null, ents: null, drag: null, handler: null,
    win: null, canvas: null, view: null, fitted: false,
    thickness: SLICE_DEFAULT, exag: 1, colour: 'class',
    data: null,                  // { d, z, off, cls, ret, nret, rgb, n, hasRet, hasRgb, capped }
    ground: null, requests: [], loading: false, gen: 0, status: '',
    hover: -1, ruler: [], cursorD: null, ridge: null, drawTimer: null, drawn: 0,
  };
  try { const o = JSON.parse(localStorage.getItem(LS) || '{}'); if (o.thickness >= SLICE_MIN && o.thickness <= SLICE_MAX) S.thickness = +o.thickness; if ([1, 2, 4].includes(o.exag)) S.exag = o.exag; if (['class', 'hag', 'cloud'].includes(o.colour)) S.colour = o.colour; } catch (_) {}
  const save = () => { try { localStorage.setItem(LS, JSON.stringify({ thickness: S.thickness, exag: S.exag, colour: S.colour })); } catch (_) {} };
  const imperial = () => !!(w._units && w._units.system && w._units.system() === 'imperial');
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  // ── Picking on the map ────────────────────────────────────────────────────
  function placeAt(screen) {
    const v = V(), C = w.Cesium; if (!v || !screen) return null;
    let c = null; try { const ray = v.camera.getPickRay(screen); c = ray && v.scene.globe.pick(ray, v.scene); } catch (_) {}
    if (c && C.Cartographic.fromCartesian(c).height < -1000) c = null;
    if (!c) { try { c = v.camera.pickEllipsoid(screen, v.scene.globe.ellipsoid); } catch (_) {} }
    if (!c) return null;
    const k = C.Cartographic.fromCartesian(c);
    return { lon: +C.Math.toDegrees(k.longitude).toFixed(7), lat: +C.Math.toDegrees(k.latitude).toFixed(7), h: k.height || 0 };
  }
  // The line and its two ends on the map. They are drawn in an overlay ABOVE the point cloud's own picture: the cloud
  // is painted over Cesium's canvas, so anything Cesium draws there is covered wherever there are points. The overlay
  // is placed again only when the camera has moved or the line has changed (Cesium's own camera events): no frame loop.
  const SVGNS = 'http://www.w3.org/2000/svg';
  function ensureEntities() {
    if (S.ents) return S.ents;
    const v = V(), svg = doc.createElementNS(SVGNS, 'svg'); svg.id = 'lidar-section-map';
    svg.style.cssText = 'position:fixed; left:0; top:0; width:100vw; height:100vh; pointer-events:none; z-index:25; overflow:visible;';
    const mk = (tag, id, attrs) => { const e = doc.createElementNS(SVGNS, tag); e.id = id; Object.keys(attrs).forEach(k => e.setAttribute(k, attrs[k])); e.style.display = 'none'; svg.appendChild(e); return e; };
    const E = { svg, shownA: null, shownB: null, ringAt: null,
      casing: mk('line', 'ls-map-casing', { stroke: 'rgba(0,0,0,.75)', 'stroke-width': 6, 'stroke-linecap': 'round' }),
      line: mk('line', 'ls-map-line', { stroke: '#00e5ff', 'stroke-width': 3, 'stroke-linecap': 'round' }),
      a: mk('circle', 'ls-map-a', { r: 6.5, fill: '#00e5ff', stroke: '#000', 'stroke-width': 2 }), b: mk('circle', 'ls-map-b', { r: 6.5, fill: '#00e5ff', stroke: '#000', 'stroke-width': 2 }),
      ta: mk('text', 'ls-map-ta', { fill: '#fff', stroke: '#000', 'stroke-width': 3, 'paint-order': 'stroke', 'font-size': 13, 'font-weight': 700, 'font-family': 'system-ui, sans-serif', 'text-anchor': 'middle' }),
      tb: mk('text', 'ls-map-tb', { fill: '#fff', stroke: '#000', 'stroke-width': 3, 'paint-order': 'stroke', 'font-size': 13, 'font-weight': 700, 'font-family': 'system-ui, sans-serif', 'text-anchor': 'middle' }),
      ring: mk('circle', 'ls-map-ring', { r: 8, fill: 'none', stroke: '#ffe45c', 'stroke-width': 3 }) };
    E.ta.textContent = 'A'; E.tb.textContent = 'B';
    doc.body.appendChild(svg);
    try { v.camera.percentageChanged = Math.min(v.camera.percentageChanged || 0.5, 0.002); v.camera.changed.addEventListener(placeOverlay); v.camera.moveEnd.addEventListener(placeOverlay); } catch (_) {}
    w.addEventListener('resize', placeOverlay);
    return (S.ents = E);
  }
  function screenOf(p) {
    const v = V(), C = w.Cesium; if (!p) return null;
    let s = null; try { s = C.SceneTransforms.worldToWindowCoordinates(v.scene, C.Cartesian3.fromDegrees(p.lon, p.lat, p.h || 0)); } catch (_) {}
    if (!s || !isFinite(s.x) || !isFinite(s.y)) return null;
    const r = v.scene.canvas.getBoundingClientRect();
    return [r.left + s.x, r.top + s.y];
  }
  function placeOverlay() {
    const E = S.ents; if (!E) return;
    const a = screenOf(E.shownA), b = screenOf(E.shownB), q = screenOf(E.ringAt), show = (e, on) => { e.style.display = on ? '' : 'none'; };
    show(E.a, !!a); show(E.ta, !!a); show(E.b, !!b); show(E.tb, !!b); show(E.line, !!(a && b)); show(E.casing, !!(a && b)); show(E.ring, !!q);
    if (a) { E.a.setAttribute('cx', a[0]); E.a.setAttribute('cy', a[1]); E.ta.setAttribute('x', a[0]); E.ta.setAttribute('y', a[1] - 11); }
    if (b) { E.b.setAttribute('cx', b[0]); E.b.setAttribute('cy', b[1]); E.tb.setAttribute('x', b[0]); E.tb.setAttribute('y', b[1] - 11); }
    if (a && b) for (const l of [E.line, E.casing]) { l.setAttribute('x1', a[0]); l.setAttribute('y1', a[1]); l.setAttribute('x2', b[0]); l.setAttribute('y2', b[1]); }
    if (q) { E.ring.setAttribute('cx', q[0]); E.ring.setAttribute('cy', q[1]); }
  }
  function drawLine(a, b) {
    const E = ensureEntities();
    E.shownA = a || null; E.shownB = b || null;
    placeOverlay();
  }
  function stopPick() { if (S.picking) { const p = S.picking; S.picking = null; p.stop(); paintPanel(); } }
  /** Start picking the two ends. A second call while picking cancels. */
  function start() {
    const v = V(), C = w.Cesium; if (!v || !C) return false;
    if (S.picking) { stopPick(); drawLine(S.a, S.b); return false; }
    const banner = el('div', 'pjf-banner'); banner.id = 'lidar-section-banner';
    banner.textContent = 'Section: click the first end on the map · Esc to cancel';
    doc.body.appendChild(banner);
    const h = new C.ScreenSpaceEventHandler(v.scene.canvas), def = v.screenSpaceEventHandler;
    const saved = [C.ScreenSpaceEventType.LEFT_CLICK, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK].map(t => [t, def.getInputAction(t)]);
    saved.forEach(([t]) => def.removeInputAction(t));
    let first = null;
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); stopPick(); drawLine(S.a, S.b); } };
    doc.addEventListener('keydown', key, true);
    h.setInputAction(ev => {
      const p = placeAt(ev.position); if (!p) return;
      if (!first) { first = p; banner.textContent = 'Section: click the other end · Esc to cancel'; drawLine(first, null); return; }
      if (M().groundDistance(first, p) < 0.5) return;
      stopPick(); set(first, p);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction(ev => { if (!first) return; const p = placeAt(ev.endPosition); if (p) drawLine(first, p); }, C.ScreenSpaceEventType.MOUSE_MOVE);   // the rubber line
    h.setInputAction(() => { stopPick(); drawLine(S.a, S.b); }, C.ScreenSpaceEventType.RIGHT_CLICK);
    S.picking = { stop() { h.destroy(); banner.remove(); doc.removeEventListener('keydown', key, true); saved.forEach(([t, fn]) => { if (fn) def.setInputAction(fn, t); }); } };
    paintPanel();
    return true;
  }
  // Dragging an end, and the map's cursor along the section: one handler, there only while a section exists.
  function ensureMapHandler() {
    if (S.handler) return;
    const v = V(), C = w.Cesium, h = S.handler = new C.ScreenSpaceEventHandler(v.scene.canvas);
    const near = pos => { if (!S.a || !S.b || S.picking) return null; let best = null, bd = 13;
      for (const k of ['a', 'b']) { const p = S[k]; let s = null; try { s = C.SceneTransforms.worldToWindowCoordinates(v.scene, C.Cartesian3.fromDegrees(p.lon, p.lat, p.h || 0)); } catch (_) {} if (!s) continue; const d = Math.hypot(s.x - pos.x, s.y - pos.y); if (d < bd) { bd = d; best = k; } }
      return best; };
    const ctl = on => { v.scene.screenSpaceCameraController.enableInputs = on; };            // the map holds still while an end is dragged
    h.setInputAction(ev => { const k = near(ev.position); if (k) { S.drag = { k, moved: false }; ctl(false); } }, C.ScreenSpaceEventType.LEFT_DOWN);
    let lastCursor = 0;
    h.setInputAction(ev => {
      if (S.drag) { const p = placeAt(ev.endPosition); if (!p) return; S.drag.moved = true; S[S.drag.k] = p; drawLine(S.a, S.b); return; }
      if (!S.win || !S.a || !S.b || S.picking) return;
      const t = Date.now(); if (t - lastCursor < 60) return; lastCursor = t;
      const p = placeAt(ev.endPosition), al = p && M().alongOf(S.a, S.b, p), d = al && Math.abs(al.off) < 40 && al.d >= 0 && al.d <= al.L ? al.d : null;
      if (d !== S.cursorD) { S.cursorD = d; drawSoon(); }
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    h.setInputAction(ev => { if (!S.drag) return; const k = S.drag.k, p = placeAt(ev.position); if (p && S.drag.moved) { S[k] = p; drawLine(S.a, S.b); }
      const moved = S.drag.moved; S.drag = null; ctl(true); if (moved) { S.fitted = false; load(); } }, C.ScreenSpaceEventType.LEFT_UP);
  }

  // ── The returns ───────────────────────────────────────────────────────────
  function cancelRequests() {
    S.gen++;
    S.requests.forEach(r => { try { r.cancel(); } catch (_) {} });
    S.requests = []; S.loading = false;
  }
  function clouds() { const pv = PV(); return ((pv && pv.scene && pv.scene.pointclouds) || []).filter(pc => pc.visible !== false); }
  /** Set the two ends ({ lon, lat }) and load the section. */
  function set(a, b) {
    if (!a || !b || !(M().groundDistance(a, b) > 0.5)) return false;
    S.a = { lon: +a.lon, lat: +a.lat, h: a.h || 0 }; S.b = { lon: +b.lon, lat: +b.lat, h: b.h || 0 };
    S.ruler = []; S.hover = -1; S.fitted = false;
    drawLine(S.a, S.b); ensureMapHandler(); openWindow(); load();
    return true;
  }
  function load() {
    cancelRequests();
    const gen = S.gen, m = M(), L = m.groundDistance(S.a, S.b), T = w.THREE;
    const D = S.data = { d: new Float32Array(65536), z: new Float32Array(65536), off: new Float32Array(65536), cls: new Uint8Array(65536), ret: new Uint8Array(65536), nret: new Uint8Array(65536), rgb: new Uint8Array(65536 * 3), n: 0, hasRet: false, hasRgb: false, hasCls: false, capped: false, L };
    S.ground = null; S.hover = -1; S.ruler = []; S.ridge = null;
    const grow = need => { if (need <= D.d.length) return; let cap = D.d.length; while (cap < need) cap *= 2; cap = Math.min(cap, CAP);
      for (const k of ['d', 'z', 'off']) { const a = new Float32Array(cap); a.set(D[k].subarray(0, D.n)); D[k] = a; }
      for (const k of ['cls', 'ret', 'nret']) { const a = new Uint8Array(cap); a.set(D[k].subarray(0, D.n)); D[k] = a; }
      const c = new Uint8Array(cap * 3); c.set(D.rgb.subarray(0, D.n * 3)); D.rgb = c; };
    const pcs = clouds();
    if (!pcs.length) { S.status = 'No point cloud is loaded: load one in the LiDAR panel, then pick the section again.'; paintWindow(); draw(); return; }
    let pending = 0;
    const done = () => { if (gen !== S.gen) return; if (--pending <= 0) { S.loading = false; finish(); } };
    S.loading = true; S.status = 'Reading the point cloud…';
    for (const pc of pcs) {
      let conv; try { conv = w.proj4(pc.projection || 'EPSG:3857', 'WGS84'); } catch (_) { continue; }
      const A = conv.inverse([S.a.lon, S.a.lat]), B = conv.inverse([S.b.lon, S.b.lat]), fr = m.frame(A, B, L);
      if (!fr || typeof pc.getPointsInProfile !== 'function') continue;
      const vec = (x, y) => (T && T.Vector3 ? new T.Vector3(x, y, 0) : { x, y, z: 0 });
      const profile = { points: [vec(A[0], A[1]), vec(B[0], B[1])], width: m.widthInUnits(fr, SLICE_MAX) };
      pending++;
      let req = null;
      const cb = {
        onProgress: ev => {
          if (gen !== S.gen) return;
          for (const seg of ev.points.segments) {
            const P = seg.points, n = P.numPoints, pos = P.data.position; if (!n || !pos) continue;
            grow(Math.min(CAP, D.n + n));
            const keys = Object.keys(P.data), find = re => keys.find(k => re.test(k));
            const cls = P.data.classification, rn = P.data[find(/^return.?number$/i)], nr = P.data[find(/^number.?of.?returns$/i)], col = P.data.rgba || P.data.color || P.data.rgb, cn = col ? col.length / n : 0;
            if (rn) D.hasRet = true; if (cls) D.hasCls = true; if (col) D.hasRgb = true;
            const cmax = col && col.BYTES_PER_ELEMENT > 1 ? 257 : 1, cf = col && !(col instanceof Uint8Array) && !(col instanceof Uint16Array) ? 255 : 1;
            const n0 = D.n;
            m.collect(fr, pos, n, [pc.position.x, pc.position.y, pc.position.z], SLICE_MAX, D, D.d.length, (i, j) => {
              D.cls[j] = cls ? cls[i] : 0; D.ret[j] = rn ? rn[i] : 0; D.nret[j] = nr ? nr[i] : 0;
              if (col) { D.rgb[j * 3] = col[i * cn] * cf / cmax; D.rgb[j * 3 + 1] = col[i * cn + 1] * cf / cmax; D.rgb[j * 3 + 2] = col[i * cn + 2] * cf / cmax; }
            });
            // With the EGM96 / USGS height correction on, FLEX draws the cloud stretched in height (its matrix scales z by
            // 1 / cos latitude, to match a web-mercator cloud's stretched ground): the real height is the drawn one over
            // that scale, as the map's own ground reader takes it (cave-depth.js lidarGroundAt).
            const zs = pc.matrixWorld && pc.matrixWorld.elements ? pc.matrixWorld.elements[10] : 1;
            if (zs && zs !== 1) for (let j = n0; j < D.n; j++) D.z[j] /= zs;
          }
          if (D.n >= CAP) { D.capped = true; try { req && req.cancel(); } catch (_) {} return; }
          S.status = 'Reading the point cloud… ' + D.n.toLocaleString('en-US') + ' returns'; paintWindow(); drawSoon(250);
        },
        onFinish: () => done(),
        onCancel: () => done(),
      };
      try { req = pc.getPointsInProfile(profile, null, cb); S.requests.push(req); } catch (e) { console.warn('[section] profile request failed', e); pending--; }
    }
    if (!pending) { S.loading = false; S.status = 'The loaded point cloud cannot be read for a section.'; }
    paintWindow(); draw();
    pump(gen);
  }
  // Potree moves a profile request on by one node a drawn frame, which makes a long section take as many frames as it
  // crosses nodes. While a section is being read (and only then) its requests are moved on here as well, a few
  // milliseconds at a time, so the reading is bound by the loading of the nodes, not by the frame rate.
  function pump(gen) {
    if (gen !== S.gen || !S.loading) return;
    const t0 = performance.now();
    try { for (let k = 0; k < 40 && performance.now() - t0 < 8 && S.loading && gen === S.gen; k++) for (const r of S.requests.slice()) { if (r && r.update && r.pointcloud && r.pointcloud.profileRequests.indexOf(r) >= 0) r.update(); } } catch (e) { console.warn('[section] reading', e); }
    setTimeout(() => pump(gen), 16);
  }
  function finish() {
    const D = S.data, m = M();
    S.requests = [];
    S.ground = D.hasCls ? m.groundLine(D.d, D.z, D.off, D.cls, D.n, Math.max(S.thickness, 2), D.L, 1) : null;
    ridgeOverlay();
    S.status = '';
    if (!S.fitted) fitView();
    paintWindow(); draw();
    w.dispatchEvent(new CustomEvent('flex-section-loaded', { detail: { returns: D.n } }));
  }

  // ── Ridgewalking of a processed area, when it is shown on the map: its returns below ground inside the slice ──
  // Only with what ridge-draw.js already exposes: the ids it has loaded and where their files are. Its points.bin and
  // draw.json are read here once a section; nothing in that module is changed.
  async function ridgeOverlay() {
    const RD = w._ridgeDraw, gen = S.gen, had = !!S.ridge;
    S.ridge = null;
    if (had) drawSoon();
    if (!RD || typeof RD.loaded !== 'function' || !w.FlexRidge || !w.FlexRidge.parsePoints) return;
    // (the module says whether something is shown and names one area: the first shown; with several on, only that one)
    let ids = []; try { if (RD.loaded()) { const st = RD.stats(); if (st && st.loaded && st.id) ids = [st.id]; } } catch (_) { return; }
    if (!ids.length || !RD.pure || !RD.pure.lattice) return;
    const m = M(), out = { d: [], z: [], off: [], depth: [] };
    for (const id of ids) {
      try {
        const base = '/api/areas/file/' + encodeURIComponent(id) + '/ridge/';
        const [dj, buf] = await Promise.all([fetch(base + 'draw.json').then(r => r.ok ? r.json() : null), fetch(base + 'points.bin').then(r => r.ok ? r.arrayBuffer() : null)]);
        if (gen !== S.gen || !dj || !buf) continue;
        if (!dj.frame || !dj.frame.lonlat || !dj.size) continue;
        const F = dj.frame, lo = F.lonlat.map(p => p[0]), la = F.lonlat.map(p => p[1]), lat = RD.pure.lattice;     // the area's metres → a place, as ridge-draw.js does it
        const P = w.FlexRidge.parsePoints(buf), toLL = (x, y) => [lat(lo, F.n, F.n, dj.size[0], dj.size[1], x, y), lat(la, F.n, F.n, dj.size[0], dj.size[1], x, y)];
        const dz = w._pcDatumDz ? (w._pcDatumDz(S.a.lat, S.a.lon) || 0) : 0;
        for (let i = 0; i < P.n; i++) {
          if (P.kind[i] !== 0 && P.kind[i] !== 1) continue;
          const ll = toLL(P.xyz[i * 3], P.xyz[i * 3 + 1]); if (!ll) continue;
          const al = m.alongOf(S.a, S.b, { lon: ll[0], lat: ll[1] });
          if (!al || al.d < 0 || al.d > al.L || Math.abs(al.off) > SLICE_MAX / 2) continue;
          out.d.push(al.d); out.off.push(al.off); out.z.push(P.xyz[i * 3 + 2] + dz); out.depth.push(P.depth[i]);
        }
      } catch (e) { console.warn('[section] ridgewalking overlay', e); }
    }
    if (gen !== S.gen || !out.d.length) return;
    S.ridge = out; draw();
  }

  // ── The window ────────────────────────────────────────────────────────────
  function css() {
    if (doc.getElementById('lidar-section-css')) return;
    const st = el('style'); st.id = 'lidar-section-css';
    st.textContent = `
#lidar-section-win { position: fixed; left: 84px; bottom: 54px; width: min(780px, calc(100vw - 110px)); height: 380px; min-width: 360px; min-height: 220px; max-width: calc(100vw - 20px); max-height: calc(100vh - 20px);
  z-index: 60; display: flex; flex-direction: column; background: rgba(14,16,22,.96); border: 1px solid rgba(255,255,255,.22); border-radius: 8px; color: #e8eaf0; font: 12px system-ui, sans-serif; resize: both; overflow: hidden; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
#lidar-section-win .ls-head { display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: rgba(255,255,255,.06); cursor: move; user-select: none; flex: 0 0 auto; }
#lidar-section-win .ls-title { font-weight: 700; white-space: nowrap; }
#lidar-section-win .ls-sub { opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
#lidar-section-win .ls-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,.08); flex: 0 0 auto; }
#lidar-section-win .ls-bar label { display: inline-flex; align-items: center; gap: 5px; margin: 0; white-space: nowrap; }
#lidar-section-win select, #lidar-section-win button { background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; padding: 2px 6px; font: inherit; cursor: pointer; }
#lidar-section-win button:hover { border-color: #888; }
#lidar-section-win .ls-x { margin-left: auto; padding: 0 7px; font-size: 15px; line-height: 20px; }
#lidar-section-win .ls-body { position: relative; flex: 1 1 auto; min-height: 0; }
#lidar-section-win canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; display: block; }
#lidar-section-win .ls-foot { padding: 4px 8px; min-height: 22px; border-top: 1px solid rgba(255,255,255,.08); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 0 auto; }
#lidar-section-win .ls-note { color: #e8a33d; }`;
    doc.head.appendChild(st);
  }
  function openWindow() {
    if (S.win) { S.win.hidden = false; return; }
    css();
    const win = S.win = el('div'); win.id = 'lidar-section-win'; win.setAttribute('role', 'dialog'); win.setAttribute('aria-label', 'Section through the point cloud');
    const head = el('div', 'ls-head'); head.appendChild(el('span', 'ls-title', 'Section'));
    const sub = el('span', 'ls-sub'); sub.id = 'ls-sub'; head.appendChild(sub);
    const x = el('button', 'ls-x', '×'); x.id = 'ls-close'; x.title = 'Close the section (the line leaves the map)'; x.addEventListener('click', close); head.appendChild(x);
    const bar = el('div', 'ls-bar');
    const th = el('label'); th.appendChild(doc.createTextNode('Thickness'));
    const thI = el('input'); thI.type = 'range'; thI.id = 'ls-thick'; thI.min = String(SLICE_MIN); thI.max = String(SLICE_MAX); thI.step = '0.5'; thI.value = String(S.thickness); thI.style.width = '110px';
    const thV = el('span', '', S.thickness + ' m'); thV.id = 'ls-thick-val'; th.appendChild(thI); th.appendChild(thV);
    thI.addEventListener('input', () => setThickness(+thI.value));
    const ex = el('label'); ex.appendChild(doc.createTextNode('Height'));
    const exS = el('select'); exS.id = 'ls-exag'; [[1, '1x (true)'], [2, '2x'], [4, '4x']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; exS.appendChild(o); }); exS.value = String(S.exag);
    exS.addEventListener('change', () => setExag(+exS.value)); ex.appendChild(exS);
    const co = el('label'); co.appendChild(doc.createTextNode('Colour by'));
    const coS = el('select'); coS.id = 'ls-colour'; [['class', 'Class (ground brown)'], ['hag', 'Height above ground'], ['cloud', 'The cloud’s own colours']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; coS.appendChild(o); }); coS.value = S.colour;
    coS.addEventListener('change', () => setColour(coS.value)); co.appendChild(coS);
    const mk = (id, text, title, fn) => { const b = el('button', '', text); b.id = id; b.title = title; b.addEventListener('click', fn); return b; };
    bar.append(th, ex, co, mk('ls-fit', 'Fit', 'Show the whole section (or double-click the picture)', () => { fitView(); draw(); }),
      mk('ls-ruler-clear', 'Clear ruler', 'Forget the two returns of the ruler', () => { S.ruler = []; paintWindow(); draw(); }),
      mk('ls-save', 'Save picture', 'A PNG of this section with a scale bar and the two ends', savePicture), mk('ls-copy', 'Copy ends', 'The two ends as latitude, longitude', copyEnds));
    const body = el('div', 'ls-body'), cv = S.canvas = el('canvas'); cv.id = 'ls-canvas'; body.appendChild(cv);
    const foot = el('div', 'ls-foot'); foot.id = 'ls-foot';
    win.append(head, bar, body, foot);
    doc.body.appendChild(win);
    // moving the window by its head
    head.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; const r = win.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      win.style.right = 'auto'; win.style.bottom = 'auto';
      const mv = ev => { win.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - ox)) + 'px'; win.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - oy)) + 'px'; };
      const up = () => { doc.removeEventListener('pointermove', mv); doc.removeEventListener('pointerup', up); };
      win.style.left = r.left + 'px'; win.style.top = r.top + 'px'; doc.addEventListener('pointermove', mv); doc.addEventListener('pointerup', up); });
    try { new ResizeObserver(() => { if (!S.fitted || !S.data || !S.data.n) { S.fitted = false; } else if (S.view) { /* keep the view, the picture just gets bigger */ } drawSoon(); }).observe(body); } catch (_) {}
    // the picture: zoom, pan, hover, ruler
    let down = null;
    const at = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('wheel', e => { e.preventDefault(); if (!S.view) return; const [px, py] = at(e); S.view = M().zoomAt(S.view, px, py, e.deltaY < 0 ? 1.25 : 0.8); draw(); }, { passive: false });
    cv.addEventListener('pointerdown', e => { const [px, py] = at(e); down = { px, py, view: S.view, moved: false }; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
    cv.addEventListener('pointermove', e => {
      const [px, py] = at(e);
      if (down && S.view) { if (Math.hypot(px - down.px, py - down.py) > 4) down.moved = true; if (down.moved) { S.view = M().pan(down.view, px - down.px, py - down.py); draw(); } return; }
      hoverAt(px, py);
    });
    cv.addEventListener('pointerup', e => { const d = down; down = null; if (!d || d.moved) return; const [px, py] = at(e); clickAt(px, py); });
    cv.addEventListener('pointerleave', () => { if (S.hover >= 0) { S.hover = -1; ringOnMap(-1); paintWindow(); draw(); } });
    cv.addEventListener('dblclick', () => { fitView(); draw(); });
  }
  function close() {
    cancelRequests(); stopPick();
    if (S.win) S.win.hidden = true;
    S.a = S.b = null; S.data = null; S.ruler = []; S.hover = -1; S.ridge = null;
    if (S.ents) { S.ents.shownA = S.ents.shownB = S.ents.ringAt = null; placeOverlay(); }
    paintPanel();
  }
  function fitView() {
    const D = S.data, cv = S.canvas; if (!D || !cv) return;
    const r = cv.getBoundingClientRect(), hr = M().heightRange(D.z, D.off, D.n, S.thickness) || [0, 10];
    S.view = M().fit(D.L, hr[0], hr[1], Math.max(50, r.width), Math.max(50, r.height), S.exag, 34);
    S.fitted = D.n > 0;
  }
  function setThickness(t) { S.thickness = Math.max(SLICE_MIN, Math.min(SLICE_MAX, +t || SLICE_DEFAULT)); S.hover = -1; save();
    const i = doc.getElementById('ls-thick'), v = doc.getElementById('ls-thick-val'); if (i) i.value = String(S.thickness); if (v) v.textContent = S.thickness + ' m';
    if (S.data && S.data.hasCls && !S.loading) S.ground = M().groundLine(S.data.d, S.data.z, S.data.off, S.data.cls, S.data.n, Math.max(S.thickness, 2), S.data.L, 1);
    paintWindow(); draw(); }
  function setExag(e) { e = [1, 2, 4].includes(+e) ? +e : 1; const cv = S.canvas, r = cv && cv.getBoundingClientRect();
    if (S.view && r) S.view = M().setExag(S.view, e, r.width, r.height); S.exag = e; save(); const s = doc.getElementById('ls-exag'); if (s) s.value = String(e); draw(); }
  function setColour(c) { S.colour = ['class', 'hag', 'cloud'].includes(c) ? c : 'class'; save(); const s = doc.getElementById('ls-colour'); if (s) s.value = S.colour; draw(); }

  // What a return is, in words.
  function describe(i) {
    const D = S.data, m = M(), imp = imperial();
    const parts = [m.both(D.d[i], imp) + ' along', 'height ' + m.both(D.z[i], imp)];
    if (D.hasCls) parts.push(m.className(D.cls[i]));
    if (D.hasRet && D.ret[i]) parts.push('return ' + D.ret[i] + (D.nret[i] ? ' of ' + D.nret[i] : ''));
    const g = m.groundAt(S.ground, D.d[i]); if (g === g) parts.push((D.z[i] >= g ? '' : '−') + m.both(Math.abs(D.z[i] - g), imp) + (D.z[i] >= g ? ' above the ground' : ' below the ground'));
    return parts.join(' · ');
  }
  function hoverAt(px, py) {
    const D = S.data; if (!D || !S.view) return;
    const i = M().nearest(S.view, D.d, D.z, D.off, D.n, S.thickness, px, py, 9);
    if (i === S.hover) return;
    S.hover = i; ringOnMap(i); paintWindow(); draw();
  }
  function clickAt(px, py) {
    const D = S.data; if (!D || !S.view) return;
    const i = M().nearest(S.view, D.d, D.z, D.off, D.n, S.thickness, px, py, 9);
    if (i < 0) return;
    if (S.ruler.length >= 2) S.ruler = [];
    S.ruler.push(i); paintWindow(); draw();
  }
  function ringOnMap(i) {
    const E = S.ents, D = S.data; if (!E) return;
    if (i < 0 || !D) { if (E.ringAt) { E.ringAt = null; placeOverlay(); } return; }
    // the place along the line, then D.off metres to its side, at the return's own height
    const m = M(), base = m.placeAt(S.a, S.b, D.d[i]), r = Math.PI / 180, mx = 6371008.8 * r * Math.cos(base.lat * r), my = 6371008.8 * r;
    const ex = (S.b.lon - S.a.lon) * mx, ey = (S.b.lat - S.a.lat) * my, l = Math.hypot(ex, ey) || 1, nx = -ey / l, ny = ex / l;
    E.ringAt = { lon: base.lon + nx * D.off[i] / mx, lat: base.lat + ny * D.off[i] / my, h: D.z[i] };
    placeOverlay();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  function drawSoon(ms) { if (S.drawTimer) return; S.drawTimer = setTimeout(() => { S.drawTimer = null; draw(); }, ms || 30); }
  /** Paint the section into a canvas (the window's, or one for "Save picture"). */
  function paint(cv, wCss, hCss, dpr, extras) {
    const D = S.data, m = M(), W = Math.max(1, Math.round(wCss * dpr)), H = Math.max(1, Math.round(hCss * dpr));
    if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0d1016'; g.fillRect(0, 0, W, H);
    let shown = 0;
    if (D && D.n && S.view) {
      const v = S.view, img = g.getImageData(0, 0, W, H), px = img.data, half = S.thickness / 2, sx = v.sx * dpr, sy = v.sx * v.exag * dpr, x0 = v.x0 * dpr, y0 = v.y0 * dpr;
      const dot = Math.round((sx > 14 * dpr ? 3 : 2) * (dpr > 1.4 ? 1.5 : 1)), mode = S.colour === 'cloud' && !D.hasRgb ? 'class' : S.colour === 'hag' && !S.ground ? 'class' : S.colour, gl = S.ground;
      for (let i = 0; i < D.n; i++) {
        const o = D.off[i]; if (o > half || o < -half) continue;
        const X = Math.round(x0 + D.d[i] * sx), Y = Math.round(y0 - D.z[i] * sy);
        shown++;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        let c;
        if (mode === 'cloud') c = [D.rgb[i * 3], D.rgb[i * 3 + 1], D.rgb[i * 3 + 2]];
        else if (mode === 'hag') c = m.hagColour(D.z[i] - m.groundAt(gl, D.d[i]));
        else c = m.classColour(D.cls[i]);
        for (let yy = 0; yy < dot; yy++) { const Yp = Y + yy; if (Yp >= H) break;
          for (let xx = 0; xx < dot; xx++) { const Xp = X + xx; if (Xp >= W) break; const k = (Yp * W + Xp) * 4; px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = 255; } }
      }
      g.putImageData(img, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // axes: heights on the left, distance along the bottom
      g.font = '11px system-ui, sans-serif'; g.lineWidth = 1;
      const imp = imperial(), f = imp ? m.FT : 1, unit = imp ? ' ft' : ' m';
      const zt = m.ticks(m.fromY(v, hCss) * f, m.fromY(v, 0) * f, Math.max(2, Math.round(hCss / 60)));
      g.fillStyle = 'rgba(255,255,255,.75)'; g.strokeStyle = 'rgba(255,255,255,.10)';
      zt.values.forEach(val => { const y = m.toY(v, val / f); g.beginPath(); g.moveTo(0, y + .5); g.lineTo(wCss, y + .5); g.stroke(); g.fillText(Math.round(val) + unit, 4, y - 3); });
      const dt = m.ticks(Math.max(0, m.fromX(v, 0)) * f, Math.min(D.L, m.fromX(v, wCss)) * f, Math.max(2, Math.round(wCss / 110)));
      dt.values.forEach(val => { const x = m.toX(v, val / f); g.beginPath(); g.moveTo(x + .5, hCss - 14); g.lineTo(x + .5, hCss); g.strokeStyle = 'rgba(255,255,255,.35)'; g.stroke(); g.fillText(Math.round(val) + unit, x + 3, hCss - 3); });
      // the two ends
      g.strokeStyle = 'rgba(0,229,255,.55)'; g.fillStyle = '#00e5ff'; g.font = '700 12px system-ui, sans-serif';
      [[0, 'A'], [D.L, 'B']].forEach(([d, t]) => { const x = m.toX(v, d); g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, hCss); g.stroke(); g.fillText(t, x + (t === 'A' ? 4 : -13), 13); });
      // ridgewalking returns of a processed area in the slice: ringed, in the depth colours
      if (S.ridge && w.FlexRidge && w.FlexRidge.rampColour) {
        g.lineWidth = 1.6;
        for (let i = 0; i < S.ridge.d.length; i++) { if (Math.abs(S.ridge.off[i]) > half) continue; const c = w.FlexRidge.rampColour(S.ridge.depth[i]);
          g.strokeStyle = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`; g.beginPath(); g.arc(m.toX(v, S.ridge.d[i]), m.toY(v, S.ridge.z[i]), 4, 0, 6.2832); g.stroke(); }
      }
      // the map's cursor along the section
      if (S.cursorD != null && !extras) { const x = m.toX(v, S.cursorD); g.strokeStyle = 'rgba(255,228,92,.8)'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, hCss); g.stroke(); g.setLineDash([]); }
      // the ruler
      if (S.ruler.length) {
        const P = S.ruler.map(i => [m.toX(v, D.d[i]), m.toY(v, D.z[i])]);
        g.strokeStyle = '#ffe45c'; g.fillStyle = '#ffe45c'; g.lineWidth = 1.5;
        P.forEach(p => { g.beginPath(); g.arc(p[0], p[1], 5, 0, 6.2832); g.stroke(); });
        if (P.length === 2) { g.beginPath(); g.moveTo(P[0][0], P[0][1]); g.lineTo(P[1][0], P[1][1]); g.stroke();
          g.setLineDash([3, 3]); g.beginPath(); g.moveTo(P[0][0], P[0][1]); g.lineTo(P[1][0], P[0][1]); g.lineTo(P[1][0], P[1][1]); g.stroke(); g.setLineDash([]); }
      }
      // the return under the cursor
      if (S.hover >= 0 && !extras) { g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath(); g.arc(m.toX(v, D.d[S.hover]), m.toY(v, D.z[S.hover]), 6, 0, 6.2832); g.stroke(); }
      if (extras) extras(g, v, wCss, hCss);
    } else {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '13px system-ui, sans-serif';
      g.fillText(S.status || (D ? 'No returns of the loaded point cloud lie on this line.' : ''), 14, 26);
    }
    return shown;
  }
  function draw() {
    const cv = S.canvas; if (!cv || !S.win || S.win.hidden) return;
    const r = cv.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return;
    if (!S.view || (!S.fitted && S.data && S.data.n)) fitView();
    S.drawn = paint(cv, r.width, r.height, Math.min(2, w.devicePixelRatio || 1));
    paintWindow();
  }
  function paintWindow() {
    const sub = doc.getElementById('ls-sub'), foot = doc.getElementById('ls-foot'); if (!sub || !foot) return;
    const D = S.data, m = M(), imp = imperial();
    sub.textContent = D ? m.both(D.L, imp) + ' long · ' + S.thickness + ' m thick' + (D.n ? ' · ' + m.countWithin(D.off, D.n, S.thickness).toLocaleString('en-US') + ' returns' : '') : '';
    let t = '', note = false;
    if (S.loading || (S.status && !(D && D.n))) t = S.status;
    else if (D && S.ruler.length === 2) t = 'Ruler: ' + m.rulerText(m.ruler({ d: D.d[S.ruler[0]], z: D.z[S.ruler[0]] }, { d: D.d[S.ruler[1]], z: D.z[S.ruler[1]] }), imp);
    else if (D && S.hover >= 0) t = describe(S.hover);
    else if (D && S.ruler.length === 1) t = 'Ruler: click a second return.';
    else if (D && D.capped) { t = 'Showing the first ' + D.n.toLocaleString('en-US') + ' returns the cloud gave (coarser levels first): a shorter line shows them all.'; note = true; }
    else if (D && D.n) t = 'Hover a return for its height · click two for the ruler · wheel zooms, drag pans, double-click fits.';
    foot.textContent = t; foot.classList.toggle('ls-note', note);
  }

  // ── Save picture, Copy ────────────────────────────────────────────────────
  function savePicture() {
    const D = S.data; if (!D || !S.view) return null;
    const r = S.canvas.getBoundingClientRect(), cv = doc.createElement('canvas'), m = M(), imp = imperial();
    paint(cv, r.width, r.height, 2, (g, v, W, H) => {
      const sb = m.scaleBar(Math.max(1, (W * 0.22) / v.sx), imp), len = sb.metres * v.sx, x = W - len - 16, y = H - 30;
      g.fillStyle = 'rgba(13,16,22,.78)'; g.fillRect(x - 8, y - 20, len + 16, 30);
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x, y); g.lineTo(x + len, y); g.lineTo(x + len, y - 5); g.stroke();
      g.fillStyle = '#fff'; g.font = '600 12px system-ui, sans-serif'; g.fillText(sb.label + (v.exag !== 1 ? '  (height ' + v.exag + 'x)' : ''), x, y - 8);
      const ends = m.endsText(S.a, S.b).split('\n'), txt = ['A  ' + ends[0], 'B  ' + ends[1], m.both(D.L, imp) + ' long, ' + S.thickness + ' m thick'];
      g.font = '12px system-ui, sans-serif'; const tw = Math.max(...txt.map(t => g.measureText(t).width));
      g.fillStyle = 'rgba(13,16,22,.78)'; g.fillRect(40, 6, tw + 14, txt.length * 15 + 8);
      g.fillStyle = '#fff'; txt.forEach((t, i) => g.fillText(t, 47, 21 + i * 15));
    });
    const url = cv.toDataURL('image/png'), a = doc.createElement('a');
    a.href = url; a.download = 'section-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.png';
    doc.body.appendChild(a); a.click(); a.remove();
    return { width: cv.width, height: cv.height, name: a.download };
  }
  function copyEnds() {
    if (!S.a || !S.b) return '';
    const t = M().endsText(S.a, S.b);
    try { navigator.clipboard.writeText(t).then(() => { const b = doc.getElementById('ls-copy'); if (b) { b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = 'Copy ends'; }, 1400); } }, () => {}); } catch (_) {}
    return t;
  }

  // ── The LiDAR panel's section ─────────────────────────────────────────────
  function paintPanel() {
    const b = doc.getElementById('lp-section-btn'), n = doc.getElementById('lp-section-note'); if (!b) return;
    b.textContent = S.picking ? 'Cancel (Esc)' : S.a ? 'New section' : 'Section: pick two points';
    b.classList.toggle('btn-warning', !!S.picking); b.classList.toggle('btn-primary', !S.picking);
    if (n) n.textContent = S.picking ? 'Click the two ends on the map.' : S.a ? 'Drag an end on the map to move the section; × on its window closes it.' : 'A side view through the loaded point cloud along a line: every return in a thin slice.';
  }
  function mount() {
    const body = doc.getElementById('lp-section-body'); if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    const b = el('button', 'btn btn-sm btn-primary'); b.id = 'lp-section-btn'; b.type = 'button'; b.style.width = '100%';
    b.addEventListener('click', () => start());
    const n = el('div'); n.id = 'lp-section-note'; n.style.cssText = 'font-size:10px; color:rgba(255,255,255,0.4); margin-top:4px;';
    body.append(b, n);
    paintPanel();
  }
  w.addEventListener('flex-units-changed', () => { paintWindow(); draw(); });
  w.addEventListener('flex-ridge-changed', () => { if (S.data && !S.loading) ridgeOverlay(); });

  w._lidarSection = { start, cancel: () => { stopPick(); drawLine(S.a, S.b); }, set, close, reload: () => { if (S.a && S.b) load(); }, setThickness, setExag, setColour, fit: () => { fitView(); draw(); },
    savePicture, copyEnds, hoverAt, clickAt, describe,
    state: () => ({ a: S.a, b: S.b, picking: !!S.picking, open: !!(S.win && !S.win.hidden), loading: S.loading, thickness: S.thickness, exag: S.exag, colour: S.colour, returns: S.data ? S.data.n : 0,
      inSlice: S.data ? M().countWithin(S.data.off, S.data.n, S.thickness) : 0, drawn: S.drawn, length: S.data ? S.data.L : 0, capped: !!(S.data && S.data.capped), hover: S.hover, ruler: S.ruler.slice(), view: S.view,
      hasGround: !!S.ground, ridge: S.ridge ? S.ridge.d.length : 0, status: S.status, ring: S.ents ? S.ents.ringAt : null }),
    data: () => S.data, SLICE_MAX, CAP };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();
})();
