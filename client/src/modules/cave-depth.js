// Where a cave sits relative to the ground: its drawn stations and level frame,
// the terrain grid under it (depth below ground), and the on-demand refinement
// from the loaded LiDAR. Moved out of flex.js unchanged (the flex.js split,
// wave 1; see client/src/README.md for the pattern).
//
// Pure exports (no browser, no Cesium), node-testable:
//   caveElevAt(imp, F, x, y, z)                 elevation of a drawn point (datum shift undone)
//   lidarGroundAt(clouds, lon, lat, r = 3)      mean class-2 height near a spot -> { h, n } | null
// Setup:
//   setupCaveDepth({ ... }) -> { caveStationPts, caveFrame, caveGroundValid, caveGround,
//                              loadedClouds, lidar: { busy, note } (live getters) }
//
// Reads the colour mode through state.colourMode (flex.js keeps the variable).
// caveColourChanged / renderCaveColourUI belong to cave-display.js, which is set
// up after this module: flex.js passes lazy wrappers.
// window._lidarGroundAt and window._caveDepthFromLidar are defined here.

// Elevation of a drawn point: its height on the globe less the cave's datum
// shift (_heightDz), i.e. back to heights above sea level as in the file.
// F: a level frame (cave_ground.js levelFrame) whose at(x, y, z) gives { h }.
export function caveElevAt(imp, F, x, y, z) { return F.at(x, y, z).h - (imp._heightDz || 0); }

// The LiDAR ground under one spot (info_panel.js): the mean height of the
// ground returns (class 2) of the given clouds (lidarClouds() below) within r
// metres, as drawn. → { h, n } or null (no cloud there, or none of its ground loaded).
export function lidarGroundAt(clouds, lon, lat, r = 3) {
  let sum = 0, n = 0;
  for (const cl of clouds) {
    const [cx, cy] = cl.toScene(lon, lat);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const r2 = r * r;
    for (const { pos, cls, m } of cl.nodes) {
      const N = Math.min(pos.length / 3, cls.length);
      for (let i = 0, o = 0; i < N; i++, o += 3) {
        if (Math.round(cls[i]) !== 2) continue;
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        const dx = m[0] * x + m[4] * y + m[8] * z + m[12] - cx, dy = m[1] * x + m[5] * y + m[9] * z + m[13] - cy;
        if (dx * dx + dy * dy > r2) continue;
        sum += (m[2] * x + m[6] * y + m[10] * z + m[14]) / cl.zScale; n++;
      }
    }
  }
  return n ? { h: sum / n, n } : null;
}

export function setupCaveDepth({
  Cesium, cesiumViewer, viewModel, state,
  caveImports: _caveImports,
  caveColourChanged: _caveColourChanged,        // (imp?) -> void
  renderCaveColourUI: _renderCaveColourUI,      // () -> void
  levelFrame, planGroundGrid, pushFootLine, sampleGroundGrid, gridCovers,
  binLidarGround, mergeLidarGround, gridFromLidar,
} = {}) {
  if (!Cesium) throw new Error('cave-depth: Cesium missing');

  // Each drawn station once, with its world position, for one placement of the
  // cave (cached until the cave is re-placed).
  function _caveStationPts(imp) {
    const conv = imp._convertFn;
    if (typeof conv !== 'function') return [];
    if (imp._stPtsFor === conv) return imp._stPts;
    const dopt = imp.displayOptions || {};
    const withShots = new Set(imp.parsed.segments.map(sg => sg.survey));
    const pts = [], seen = new Set();
    for (const s of imp.parsed.stations) {
      const key = s.name + '|' + Math.round(s.n * 100) + '|' + Math.round(s.e * 100) + '|' + Math.round(s.v * 100);
      if (seen.has(key)) continue;
      seen.add(key);
      const c = conv(s.n, s.e, s.v);
      if (!c) continue;
      const surface = s.isSurface || !!(dopt.surfaceSurveys && dopt.surfaceSurveys[s.survey]) || !withShots.has(s.survey);
      pts.push({ c, surface });
    }
    imp._stPts = pts; imp._stPtsFor = conv;
    return pts;
  }

  // A level frame at the cave's middle (cave_ground.js), for elevations.
  function _caveFrame(imp) {
    if (imp._frameFor === imp._convertFn && imp._frame) return imp._frame;
    const pts = _caveStationPts(imp);
    if (!pts.length) return null;
    const o = new Cesium.Cartesian3();
    for (const p of pts) Cesium.Cartesian3.add(o, p.c, o);
    Cesium.Cartesian3.divideByScalar(o, pts.length, o);
    imp._frame = levelFrame(o); imp._frameFor = imp._convertFn;
    return imp._frame;
  }

  // ── Ground grids (depth below ground) ──
  // Sampled from the globe's terrain over each cave's footprint (cave_ground.js),
  // once per placement that leaves the sampled area. Kept on the cave as
  // imp._ground: a grid, or { none: true } when there is no terrain to read.
  const GROUND_STEP_M = 20;               // footprint points along shots this far apart
  function _caveGroundValid(imp) {
    const G = imp._ground;
    return !!G && G.tp === cesiumViewer.terrainProvider;
  }
  // Share of the cave's stations inside the sampled area (cached per placement).
  function _caveGroundCover(imp) {
    const G = imp._ground;
    if (!G || G.none) return 0;
    if (G._coverFor === imp._convertFn) return G._cover;
    const pts = _caveStationPts(imp);
    let inside = 0;
    for (const p of pts) { const q = G.frame.at(p.c.x, p.c.y, p.c.z); if (gridCovers(G, q.e, q.n)) inside++; }
    G._cover = pts.length ? inside / pts.length : 0;
    G._coverFor = imp._convertFn;
    return G._cover;
  }
  // The grid to colour with now (possibly one sampled for an older placement),
  // asking for a new one when there is none or the cave has moved off it.
  function _caveGround(imp) {
    const valid = _caveGroundValid(imp);
    if (valid && imp._ground.none) return null;
    if (!valid || _caveGroundCover(imp) < 0.98) _requestCaveGround(imp);
    return valid ? imp._ground : null;
  }
  function _requestCaveGround(imp) {
    if (imp._groundPending || imp._groundTriedFor === imp._convertFn) return;
    imp._groundTriedFor = imp._convertFn;
    const tp = cesiumViewer.terrainProvider;
    imp._groundPending = _sampleCaveGround(imp, tp).then(G => {
      imp._ground = G || { none: true, failed: true, tp };
      imp._groundTerrain = null;                 // any LiDAR refinement was for the old placement
    }).catch(err => {
      console.warn('[cave] terrain sampling failed', err);
      imp._ground = { none: true, failed: true, tp };
    }).finally(() => {
      imp._groundPending = null;
      if (_caveImports.includes(imp) && state.colourMode === 'depth') _caveColourChanged(imp);
    });
    _renderCaveColourUI();
  }
  async function _sampleCaveGround(imp, tp) {
    if (!tp || tp instanceof Cesium.EllipsoidTerrainProvider) return { none: true, tp };
    const plan = _caveGroundPlan(imp);
    if (!plan) return null;
    const { G, F } = plan;
    const t0 = performance.now();
    const done = await sampleGroundGrid(G, F, tp);
    if (!done) return null;
    done.tp = tp;
    console.log(`[cave] Ground for "${imp.name}": ${G.nodes} terrain samples, ${G.cell.toFixed(1)} m cells, ${Math.round(performance.now() - t0)} ms`);
    return done;
  }
  // The grid layout for a cave's footprint (stations and shots, in a level frame
  // at its middle); heights not read yet.
  function _caveGroundPlan(imp) {
    const conv = imp._convertFn, pts = _caveStationPts(imp);
    if (!pts.length || typeof conv !== 'function') return null;
    const o = new Cesium.Cartesian3();
    for (const p of pts) Cesium.Cartesian3.add(o, p.c, o);
    Cesium.Cartesian3.divideByScalar(o, pts.length, o);
    const F = levelFrame(o), foot = [];
    for (const p of pts) { const q = F.at(p.c.x, p.c.y, p.c.z); foot.push(q.e, q.n); }
    for (const seg of imp.parsed.segments) {            // shots, so long ones are covered between stations
      const line = [];
      for (const p of seg.points) {
        if (p.excluded) continue;
        const c = conv(p.n, p.e, p.v);
        if (!c) continue;
        const q = F.at(c.x, c.y, c.z);
        line.push({ e: q.e, n: q.n });
      }
      pushFootLine(foot, line, GROUND_STEP_M);
    }
    const G = planGroundGrid(foot);
    return G ? { G, F } : null;
  }

  // ── Depth from loaded LiDAR (on demand) ──
  // The ground-classified returns of the point clouds in memory replace the
  // terrain on each cave's ground grid where they reach (cave_ground.js), the
  // terrain stays elsewhere. Heights as the clouds are drawn (pc.matrix, i.e.
  // the _pcDatumDz shift), the frame the caves are drawn in. Only what Potree
  // has loaded counts, so it is best done with the clouds streamed in over the
  // caves. Kept until the cave moves off its grid or "Terrain only".
  let _caveLidarBusy = false, _caveLidarNote = '';
  function _loadedClouds() {
    return ((typeof potreeViewer !== 'undefined' && potreeViewer?.scene?.pointclouds) || []).filter(pc => pc.visible);
  }
  function _lidarClouds() {
    const scaled = viewModel.egm96 || viewModel.usgsRef;     // applyPcMatrix scales z in these modes
    return _loadedClouds().map(pc => {
      let conv;
      try { conv = proj4(pc.projection || 'EPSG:3857', 'WGS84'); } catch (_) { return null; }
      const nodes = [];
      for (const node of pc.visibleNodes || []) {
        if (!node.sceneNode) continue;
        const geom = node.geometryNode?.geometry || node.geometry;
        const pos = geom?.attributes?.position?.array, cls = geom?.attributes?.classification?.array;
        if (pos && cls) nodes.push({ pos, cls, m: node.sceneNode.matrixWorld.elements.slice() });
      }
      return nodes.length ? { nodes, zScale: scaled ? (pc._pcZscale || 1) : 1,
        toLonLat: (x, y) => conv.forward([x, y]), toScene: (lon, lat) => conv.inverse([lon, lat]) } : null;
    }).filter(Boolean);
  }
  window._lidarGroundAt = function(lon, lat, r = 3) { return lidarGroundAt(_lidarClouds(), lon, lat, r); };
  window._caveDepthFromLidar = async function(on = true) {
    if (!on) {                                   // back to the terrain only
      for (const imp of _caveImports) {
        if (imp._ground && imp._ground.source === 'lidar') {
          imp._ground = imp._groundTerrain || null;
          imp._groundTerrain = null;
          if (!imp._ground) imp._groundTriedFor = null;
          _caveColourChanged(imp);
        }
      }
      _caveLidarNote = '';
      _renderCaveColourUI();
      return;
    }
    if (_caveLidarBusy) return;
    const clouds = _lidarClouds();             // collected now: Potree may unload nodes while we work
    if (!clouds.length) { _caveLidarNote = 'No classified point cloud loaded.'; _renderCaveColourUI(); return; }
    _caveLidarBusy = true; _caveLidarNote = '';
    _renderCaveColourUI();
    let stations = 0, underLidar = 0, points = 0;
    try {
      await Promise.all(_caveImports.map(imp => imp._groundPending).filter(Boolean));
      for (const imp of _caveImports) {
        // Start from the terrain grid (again, if this cave was refined before).
        let base = _caveGroundValid(imp) && !imp._ground.none ? imp._ground : null;
        if (base && base.source === 'lidar') base = imp._groundTerrain;
        let G = base;
        if (!G) {
          const plan = _caveGroundPlan(imp);
          if (!plan) continue;
          G = plan.G; G.frame = plan.F; G.tp = cesiumViewer.terrainProvider;
        }
        const bin = await binLidarGround(G, G.frame, clouds);
        points += bin.points;
        const { grid } = mergeLidarGround(G, bin.sum, bin.cnt);
        for (const p of _caveStationPts(imp)) {
          if (p.surface) continue;
          const q = grid.frame.at(p.c.x, p.c.y, p.c.z);
          stations++;
          if (gridFromLidar(grid, q.e, q.n)) underLidar++;
        }
        if (!grid.lidarNodes || !_caveImports.includes(imp)) continue;
        imp._groundTerrain = base || null;
        imp._ground = grid;
        _caveColourChanged(imp);
      }
      _caveLidarNote = points
        ? `Ground from loaded LiDAR over ${underLidar.toLocaleString()} of ${stations.toLocaleString()} stations (${points.toLocaleString()} ground returns); the 3D terrain over the rest.`
        : 'No ground returns (class 2) over the caves in the LiDAR loaded now: zoom the point cloud in over them and try again.';
      console.log('[cave] LiDAR ground:', _caveLidarNote);
    } finally {
      _caveLidarBusy = false;
      _renderCaveColourUI();
    }
  };

  return {
    caveStationPts: _caveStationPts, caveFrame: _caveFrame, caveGroundValid: _caveGroundValid,
    caveGround: _caveGround, loadedClouds: _loadedClouds,
    lidar: { get busy() { return _caveLidarBusy; }, get note() { return _caveLidarNote; } },
  };
}
