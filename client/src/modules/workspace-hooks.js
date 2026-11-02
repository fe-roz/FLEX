// Workspace hooks for projects (project-workspace.js): window._ws, and
// _caveGeometry (a cave's size and footprint without drawing it).
// Moved out of flex.js unchanged (flex.js split, wave 2; see client/src/README.md).
// Members and their order are those of the old window._ws; what stays in
// flex.js comes in through the setup argument (`state` is flex.js's
// caveImportState: recents, cwizParsed).
//
// Setup: setupWorkspaceHooks({ Cesium, cesiumViewer, viewModel, parsePLT, restoreCamera, restoreLayerState, state,
//   _caveImports, _pcUrlByName, caltopoState, loadedDataFiles, _placeCave, _finishCaveLoad, removePc,
//   loadCaltopoKml, clearCaltopo, renderDataFileList, addDataFile, removeDataFile, _fetchPltCache,
//   _addPltRecent, _removePltRecent, _caveUtmConvertFn }) -> { ws }

export function setupWorkspaceHooks({ Cesium, cesiumViewer, viewModel, parsePLT, restoreCamera, restoreLayerState, state,
    _caveImports, _pcUrlByName, caltopoState, loadedDataFiles, _placeCave, _finishCaveLoad, removePc,
    loadCaltopoKml, clearCaltopo, renderDataFileList, addDataFile, removeDataFile, _fetchPltCache,
    _addPltRecent, _removePltRecent, _caveUtmConvertFn }) {
  // ── Workspace hooks for projects (project-workspace.js) ──────────────────────
  // What is loaded (caves with their survey text and placement, point clouds,
  // CalTopo, URL data files), and loading / unloading them. "switching" is set
  // while a project opens or closes, so unloading isn't taken as removing.
  const ws = window._ws = {
    switching: false,
    caves: () => _caveImports.filter(i => i && i.parsed).map(imp => ({
      name: imp.name, text: imp.parsed._rawText || '', georef: imp.georef ? JSON.parse(JSON.stringify(imp.georef)) : null,
      displayOptions: imp.displayOptions || null })),
    caveState: () => _caveImports.filter(i => i && i.parsed).map(imp => ({ name: imp.name, displayOptions: imp.displayOptions || null, visible: imp.visible !== false })),
    loadCave(name, text, georef, displayOptions) {
      let parsed;
      try { parsed = parsePLT(text); } catch (e) { console.error('[ws] PLT parse failed:', name, e); return null; }
      parsed._fileName = name; parsed._rawText = text;
      if (!georef) { state.cwizParsed = parsed; window._importCavePLT(); return null; }   // not placed yet: the wizard
      const entry = _placeCave(name, parsed, georef, displayOptions || null);
      _finishCaveLoad(entry, { recent: false });
      return entry;
    },
    removeCave(name) { const i = _caveImports.findIndex(x => x && x.name === name); if (i >= 0) window._removeCaveImport(i); },
    pointClouds: () => (window.potreeViewer?.scene?.pointclouds || []).map(pc => _pcUrlByName[pc.name]).filter(Boolean),
    addPointCloud: url => window.addPC(url),
    removePointCloud(url) { const pc = (window.potreeViewer.scene.pointclouds || []).find(p => _pcUrlByName[p.name] === url); if (pc) removePc(pc); },
    caltopo: () => caltopoState.url ? { url: caltopoState.url, interval: caltopoState.interval } : null,
    setCaltopo(url, interval) {
      const input = document.getElementById('caltopo_url_input'), sel = document.getElementById('caltopo_interval_select');
      if (input) input.value = url;
      if (sel && interval != null) sel.value = String(interval);
      return loadCaltopoKml(url, interval ?? 60);
    },
    clearCaltopo: () => clearCaltopo(),
    dataFiles: () => loadedDataFiles.filter(f => f.url).map(f => ({ url: f.url, label: f.label, myId: f.myId || null, show: f.show !== false,
      items: f.dataSource ? f.dataSource.entities.values.length : 0 })),
    setDataFileShown(url, on) { const f = loadedDataFiles.find(x => x.url === url); if (!f) return; f.show = on; if (f.dataSource) f.dataSource.show = on; renderDataFileList(); },
    addDataFile: (url, label, opts) => addDataFile(url, label, opts),
    removeDataFile(url) { const f = loadedDataFiles.find(x => x.url === url); if (f) removeDataFile(f.id); },
    // Map overlays with their folders (CalTopo map, KML / GeoJSON data files).
    vectorSources: () => [].concat(caltopoState.dataSource ? [{ kind: 'caltopo', name: 'CalTopo map', url: caltopoState.url, ds: caltopoState.dataSource }] : [],
      loadedDataFiles.filter(f => f.dataSource).map(f => ({ kind: 'file', name: f.label, url: f.url, ds: f.dataSource }))),
      restoreView(snap, opts) { if (!snap) return; if (snap.camera) restoreCamera(snap, cesiumViewer, opts || {}); if (snap.layers) restoreLayerState(snap, viewModel); },
    recentCave(name) { const i = (state.recents.plt || []).findIndex(r => r.name === name); return i >= 0 ? window._loadPltRecent(i) : null; },
    // My data's caves (the old Recent list) and cave sets, for cave-columns.js.
    recents: () => (state.recents.plt || []).map(r => ({ name: r.name, georef: r.georef || null, displayOptions: r.displayOptions || null, lastUsed: r.lastUsed || null })),
    sets: () => (state.recents.pltSets || []).map(st => ({ name: st.name, savedAt: st.savedAt || null, caves: (st.caves || []).map(c => c.name) })),
    recentText: name => _fetchPltCache(name),
    /** Into My data (a cave moved out of a project). */
    keepRecent(name, text, georef, displayOptions) { _addPltRecent(name, text, georef || null, displayOptions || null, { force: true }); },
    /** Out of My data (moved into a project, or forgotten). Its file and history stay. */
    forgetRecent(name) { _removePltRecent(name); },
    loadSet: i => window._caveSetLoad(i),
    deleteSet: i => window._caveSetDelete(i),
    caveIndex: name => _caveImports.findIndex(x => x && x.name === name),
    caveVisible: name => { const x = _caveImports.find(c => c && c.name === name); return !!(x && x.visible !== false); },
    caveGeometry: (text, georef) => _caveGeometry(text, georef),
    parse: text => parsePLT(text),                     // a survey file read as FLEX reads it (survey-export.js)
  };

  // A cave's size and where it lies, from its survey file and placement,
  // without drawing it (project cards and footprints, projects-panel.js).
  // → { length, depth (m), stations, pts: [[lon, lat], …] (at most ~1500) } or null.
  function _caveGeometry(text, georef) {
    if (!text || !georef) return null;
    let parsed;
    try { parsed = parsePLT(text); } catch (_) { return null; }
    const imp = { parsed, georef: JSON.parse(JSON.stringify(georef)) };
    let fn = null;
    if (georef.mode === 'anchor') {
      const a = georef.station === '__first__' ? parsed.segments[0]?.points[0]
        : parsed.stations.find(s => s.name === georef.station) || parsed.segments[0]?.points[0];
      if (!a) return null;
      const cart = Cesium.Cartesian3.fromDegrees(georef.lon, georef.lat, georef.elev || 0);
      let enu = Cesium.Transforms.eastNorthUpToFixedFrame(cart);
      if (georef.declination) enu = Cesium.Matrix4.multiply(enu, Cesium.Matrix4.fromRotationTranslation(Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(georef.declination)), Cesium.Cartesian3.ZERO), new Cesium.Matrix4());
      fn = (n, e, v) => Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(e - a.e, n - a.n, v - a.v), new Cesium.Cartesian3());
    } else {
      try { fn = _caveUtmConvertFn(imp); } catch (_) { fn = null; }
    }
    if (!fn) return null;
    let length = 0, lo = Infinity, hi = -Infinity, all = [];
    for (const sg of parsed.segments) {
      let prev = null;
      for (const q of sg.points) {
        if (!Number.isFinite(q.n) || !Number.isFinite(q.e) || !Number.isFinite(q.v)) { prev = null; continue; }
        if (prev && !q.excluded) length += Math.hypot(q.n - prev.n, q.e - prev.e, q.v - prev.v);
        lo = Math.min(lo, q.v); hi = Math.max(hi, q.v);
        all.push(q); prev = q;
      }
    }
    const step = Math.max(1, Math.ceil(all.length / 1500)), pts = [];
    for (let i = 0; i < all.length; i += step) {
      const c = Cesium.Cartographic.fromCartesian(fn(all[i].n, all[i].e, all[i].v));
      if (c) pts.push([+Cesium.Math.toDegrees(c.longitude).toFixed(6), +Cesium.Math.toDegrees(c.latitude).toFixed(6)]);
    }
    return { length: Math.round(length), depth: Number.isFinite(hi - lo) ? Math.round(hi - lo) : 0, stations: parsed.stations.length, pts };
  }

  return { ws };
}
