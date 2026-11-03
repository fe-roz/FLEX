// The minimap's view overlay: a compass, the camera's view on the ground, and outlines of what is
// drawn in detail (terrain patches, point clouds).
//
// Cheap on purpose: flex.js calls update() from its minimap sync (only while the minimap is shown);
// it returns at once unless ~120 ms have passed AND the camera moved. The view footprint is worked out
// on a flat plane at the camera's height above ground (the height flex.js already has), no terrain
// sampling, no allocations: one OpenLayers feature whose coordinate arrays are reused.
//
//   window._minimapView.attach(olMap)                       — once, from initMiniMap
//   window._minimapView.update(tMs, heightAboveGround, heading) — from syncMiniMapFrame
//   window._minimapView.state()                             — for tests
(function () {
  'use strict';
  const FOV_INTERVAL_MS = 120;      // footprint at most this often
  const OUTLINE_INTERVAL_MS = 1000; // patch / cloud outlines at most this often
  const R = 6378137;                // Web Mercator sphere (and good enough for metres → degrees here)
  const MAX_DIST_M = 25000, MIN_DIST_M = 150;
  const D2R = Math.PI / 180;

  let map = null, layer = null, source = null, fovFeature = null;
  let compassEl = null, compassNeedle = null, legendEl = null;
  let lastFovAt = -1e9, lastOutlineAt = -1e9, lastHeading = NaN;
  const last = new Float64Array(8).fill(NaN);   // pos xyz, dir xyz, height, aspect
  let costLast = 0, costMax = 0, fovUpdates = 0, fovMode = '';
  // Reused rings: a quad looking down, a wedge with the camera at its tip looking ahead.
  const pts = []; for (let i = 0; i < 6; i++) pts.push([0, 0]);
  const quadRing = [pts[0], pts[1], pts[2], pts[3], pts[0]];
  const wedgeRing = [pts[4], pts[0], pts[3], pts[2], pts[1], pts[4]];   // camera, near-left, far-left, far-right, near-right
  const quadCoords = [quadRing], wedgeCoords = [wedgeRing];
  const corner = new Float64Array(12);           // ground (east, north) of the 4 corner rays, then spare

  const merc = (out, lonDeg, latDeg) => {
    const la = Math.max(-85, Math.min(85, latDeg)) * D2R;
    out[0] = R * lonDeg * D2R; out[1] = R * Math.log(Math.tan(Math.PI / 4 + la / 2)); return out;
  };

  // ── styles ────────────────────────────────────────────────────────────────
  function styles() {
    const S = ol.style;
    return {
      fov: new S.Style({ fill: new S.Fill({ color: 'rgba(255,214,90,0.16)' }), stroke: new S.Stroke({ color: 'rgba(255,214,90,0.95)', width: 1.5 }) }),
      patch: new S.Style({ fill: new S.Fill({ color: 'rgba(80,200,255,0.06)' }), stroke: new S.Stroke({ color: 'rgba(80,200,255,0.95)', width: 1.5 }) }),
      cloud: new S.Style({ stroke: new S.Stroke({ color: 'rgba(230,120,255,0.9)', width: 1.5, lineDash: [6, 3] }) })
    };
  }
  let ST = null;

  function rectRing(w, s, e, n) {
    const a = merc([0, 0], w, s), b = merc([0, 0], e, s), c = merc([0, 0], e, n), d = merc([0, 0], w, n);
    return [[a, b, c, d, a.slice()]];
  }

  // ── attach ────────────────────────────────────────────────────────────────
  function attach(olMap) {
    if (map || !olMap || !window.ol) return;
    map = olMap; ST = styles();
    source = new ol.source.Vector();
    fovFeature = new ol.Feature({ geometry: new ol.geom.Polygon(quadCoords) });
    fovFeature.setStyle(ST.fov); fovFeature.set('mmKind', 'fov');
    source.addFeature(fovFeature);
    layer = new ol.layer.Vector({ source });
    // under the labels and the camera dot (the last two layers)
    const L = map.getLayers(); L.insertAt(Math.max(0, L.getLength() - 2), layer);
    buildDom();
    window.addEventListener('flex-terrain-changed', () => { lastOutlineAt = -1e9; });
  }

  function buildDom() {
    const box = document.getElementById('mini_map_container'); if (!box) return;
    compassEl = document.createElement('div');
    compassEl.id = 'mini_map_compass';
    compassEl.title = 'North (the minimap turns with the camera: up is where you look)';
    compassEl.innerHTML = '<svg viewBox="-16 -16 32 32" width="30" height="30" aria-hidden="true">' +
      '<circle r="14.5" fill="rgba(22,25,35,0.8)" stroke="rgba(255,255,255,0.4)" stroke-width="1"/>' +
      '<path d="M0,-14 L4,-6 L-4,-6 Z" fill="#ff5a4e"/><path d="M0,14 L3,8 L-3,8 Z" fill="rgba(255,255,255,0.45)"/>' +
      '<text x="0" y="4" text-anchor="middle" font-size="10" font-weight="700" font-family="sans-serif" fill="#fff">N</text></svg>';
    compassNeedle = compassEl.firstChild;
    box.appendChild(compassEl);
    legendEl = document.createElement('div');
    legendEl.id = 'mini_map_legend';
    box.appendChild(legendEl);
    renderLegend(0, 0);
  }

  let legendSig = '';
  function renderLegend(nPatch, nCloud) {
    const sig = nPatch + '|' + nCloud; if (sig === legendSig || !legendEl) return; legendSig = sig;
    const row = (cls, text) => '<div><i class="' + cls + '"></i>' + text + '</div>';
    legendEl.innerHTML = row('mm-fov', 'What the camera sees') +
      (nPatch ? row('mm-patch', 'Terrain patch' + (nPatch > 1 ? 'es (' + nPatch + ')' : '')) : '') +
      (nCloud ? row('mm-cloud', 'Point cloud' + (nCloud > 1 ? 's (' + nCloud + ')' : '')) : '');
  }

  // ── the view footprint ──────────────────────────────────────────────────────
  function updateFov(cam, hAg) {
    const fr = cam.frustum; if (!fr || !(fr.fovy > 0)) return false;
    const P = cam.positionWC, D = cam.directionWC, U = cam.upWC, Rt = cam.rightWC;
    const aspect = fr.aspectRatio || 1;
    // unchanged camera → nothing to do (the common case while idle)
    if (Math.abs(P.x - last[0]) < 0.3 && Math.abs(P.y - last[1]) < 0.3 && Math.abs(P.z - last[2]) < 0.3 &&
        Math.abs(D.x - last[3]) < 1e-4 && Math.abs(D.y - last[4]) < 1e-4 && Math.abs(D.z - last[5]) < 1e-4 &&
        Math.abs(hAg - last[6]) < Math.max(0.5, 0.01 * hAg) && aspect === last[7]) return false;
    last[0] = P.x; last[1] = P.y; last[2] = P.z; last[3] = D.x; last[4] = D.y; last[5] = D.z; last[6] = hAg; last[7] = aspect;

    // camera lon/lat (geodetic: Cesium keeps it cached on the camera) and its east/north/up
    const cg = cam.positionCartographic; if (!cg) return false;
    const lon = cg.longitude, lat = cg.latitude;
    const sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat);
    const ex = -sl, ey = cl, nx = -sp * cl, ny = -sp * sl, nz = cp, ux = cp * cl, uy = cp * sl, uz = sp;

    const h = Math.max(hAg, 0);
    const horizon = Math.sqrt(2 * R * h + h * h);
    const maxD = Math.min(MAX_DIST_M, Math.max(MIN_DIST_M, horizon));
    const ty = Math.tan(fr.fovy / 2), tx = ty * aspect;
    const low = h < 2;   // at (or under) the ground: a wedge along the ground, no ray to intersect
    let anyMiss = false;
    // corners: 0 bottom-left, 1 bottom-right, 2 top-right, 3 top-left
    for (let k = 0; k < 4; k++) {
      const sx = (k === 0 || k === 3) ? -tx : tx, sy = (k < 2) ? -ty : ty;
      const dx = D.x + sx * Rt.x + sy * U.x, dy = D.y + sx * Rt.y + sy * U.y, dz = D.z + sx * Rt.z + sy * U.z;
      const de = dx * ex + dy * ey, dn = dx * nx + dy * ny + dz * nz, du = dx * ux + dy * uy + dz * uz;
      const dh = Math.sqrt(de * de + dn * dn);
      let dist;
      if (low) dist = maxD * 0.25;                            // underground: just show the direction
      else if (du < -1e-6) dist = Math.min(maxD, h * dh / -du);
      else { dist = maxD; anyMiss = true; }                    // above the horizon
      if (low || dist >= maxD) anyMiss = true;
      const f = dh > 1e-9 ? dist / dh : 0;
      corner[k * 2] = de * f; corner[k * 2 + 1] = dn * f;
    }
    const lat0 = lat / D2R, lon0 = lon / D2R, mPerLon = Math.max(1, R * D2R * cp), mPerLat = R * D2R;
    for (let k = 0; k < 4; k++) merc(pts[k], lon0 + corner[k * 2] / mPerLon, lat0 + corner[k * 2 + 1] / mPerLat);
    merc(pts[4], lon0, lat0);
    // looking ahead (some ray reaches the horizon or we're on the ground): wedge from the camera;
    // looking down: the quad alone (the camera dot is inside it)
    const geom = fovFeature.getGeometry();
    if (anyMiss) { geom.setCoordinates(wedgeCoords); fovMode = low ? 'ground' : 'wedge'; }
    else { geom.setCoordinates(quadCoords); fovMode = 'quad'; }
    fovUpdates++;
    return true;
  }

  // ── outlines: terrain patches, point clouds ────────────────────
  const patchFeatures = new Map();   // patch object → feature
  const cloudFeatures = new Map();   // point cloud → feature
  function updateOutlines(viewer) {
    // terrain patches: the chain of PatchTerrainProviders over the globe's terrain
    const TP = window._terrainPatch, seen = new Set();
    let tp = viewer.terrainProvider;
    while (TP && tp instanceof TP.PatchTerrainProvider) {
      const p = tp._p; seen.add(p);
      if (!patchFeatures.has(p)) {
        const f = new ol.Feature({ geometry: new ol.geom.Polygon(rectRing(p.west, p.south, p.east, p.north)) });
        f.setStyle(ST.patch); f.set('mmKind', 'patch'); f.set('labelText', 'Terrain patch' + (p.name ? ': ' + p.name : ''));
        source.addFeature(f); patchFeatures.set(p, f);
      }
      tp = tp._base;
    }
    for (const [p, f] of patchFeatures) if (!seen.has(p)) { source.removeFeature(f); patchFeatures.delete(p); }

    // point clouds: their bounding boxes, projected once per cloud
    const pcs = (window.potreeViewer && window.potreeViewer.scene && window.potreeViewer.scene.pointclouds) || [];
    const live = new Set();
    for (const pc of pcs) {
      if (!pc || pc.visible === false) continue;
      live.add(pc);
      if (cloudFeatures.has(pc)) continue;
      try {
        const bb = typeof pc.getBoundingBoxWorld === 'function' ? pc.getBoundingBoxWorld() : pc.boundingBox;
        const conv = proj4(pc.projection || 'EPSG:3857', 'WGS84');
        const c = [[bb.min.x, bb.min.y], [bb.max.x, bb.min.y], [bb.max.x, bb.max.y], [bb.min.x, bb.max.y]].map(q => merc([0, 0], ...conv.forward(q)));
        c.push(c[0].slice());
        const f = new ol.Feature({ geometry: new ol.geom.Polygon([c]) });
        f.setStyle(ST.cloud); f.set('mmKind', 'cloud'); f.set('labelText', 'Point cloud' + (pc.name ? ': ' + pc.name : ''));
        source.addFeature(f); cloudFeatures.set(pc, f);
      } catch (_) { cloudFeatures.set(pc, null); }   // no projection: don't try again every second
    }
    for (const [pc, f] of cloudFeatures) if (!live.has(pc)) { if (f) source.removeFeature(f); cloudFeatures.delete(pc); }

    renderLegend(patchFeatures.size, [...cloudFeatures.values()].filter(Boolean).length);
  }

  // ── per sync ──────────────────────────────────────────────────────────────
  function update(tMs, heightAboveGround, heading) {
    if (!map) return;
    // compass: the map is drawn heading-up (rotation −heading), so north is at −heading on screen
    if (compassNeedle && !(Math.abs(heading - lastHeading) <= 0.002)) {   // (NaN at first: set it)
      lastHeading = heading;
      let deg = -heading / D2R; deg -= 360 * Math.round(deg / 360);
      compassNeedle.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)';
    }
    // (a clock that went backwards counts as due)
    const doFov = !(tMs - lastFovAt < FOV_INTERVAL_MS && tMs >= lastFovAt), doOut = !(tMs - lastOutlineAt < OUTLINE_INTERVAL_MS && tMs >= lastOutlineAt);
    if (!doFov && !doOut) return;
    const viewer = window.cesiumViewer; if (!viewer) return;
    const t0 = performance.now();
    let moved = false;
    if (doFov) { lastFovAt = tMs; moved = updateFov(viewer.camera, heightAboveGround); }
    if (doOut) { lastOutlineAt = tMs; updateOutlines(viewer); }
    if (moved || doOut) { costLast = performance.now() - t0; if (costLast > costMax) costMax = costLast; }
  }

  function state() {
    return {
      attached: !!map, fovFeature, fovMode, fovUpdates, costLast, costMax,
      fovCoords: fovFeature ? fovFeature.getGeometry().getCoordinates() : null,
      patches: [...patchFeatures.values()].map(f => f.get('labelText')),
      clouds: [...cloudFeatures.values()].filter(Boolean).map(f => f.get('labelText')),
      compassTransform: compassNeedle ? compassNeedle.style.transform : '',
      legend: legendEl ? legendEl.textContent : ''
    };
  }
  /** Force the next update to redo everything (tests, or after a big change). */
  function refresh() { lastFovAt = lastOutlineAt = -1e9; last.fill(NaN); }

  window._minimapView = { attach, update, state, refresh };
  if (window._miniMapOl) attach(window._miniMapOl);
})();
