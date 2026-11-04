// Start-up restore from the saved session (point-cloud prompt, CalTopo, data files, My data points,
// cave / POI visibility, panel sections). Runs in a setTimeout(0) so the whole of flex.js has
// been evaluated first; with a project open (flex.project) project-workspace.js does the loading.
// Moved out of flex.js unchanged (flex.js split, wave 3; see client/src/README.md).
//
// Setup: setupSessionRestore({ Cesium, cesiumViewer, savedSession, showPcRestorePrompt, showCaltopoLoggedIn,
//   getCaltopoState, fetchCaltopoKml, loadCaltopoKml, addDataFile, renderPoiList, setCaveSurveyVisible })
// The functions are called when the timer fires, never at setup, so flex.js passes lazy wrappers for
// those it sets up later.

export function setupSessionRestore({
  Cesium, cesiumViewer, savedSession: _savedSession, showPcRestorePrompt, showCaltopoLoggedIn: _showCaltopoLoggedIn,
  getCaltopoState, fetchCaltopoKml: _fetchCaltopoKml, loadCaltopoKml, addDataFile, renderPoiList, setCaveSurveyVisible,
}) {
const _projectAtStart = (() => { try { return localStorage.getItem('flex.project') || ''; } catch (_) { return ''; } })();
setTimeout(() => {
  // With a project open, project-workspace.js loads its point clouds, CalTopo
  // maps and data files; the prompts below are for FLEX without a project.
  if (_savedSession?.pointClouds?.length && !_projectAtStart) {
    showPcRestorePrompt(_savedSession.pointClouds);
  }
  // Check if server still has an active CalTopo session
  fetch('/caltopo/status').then(r => r.json()).then(data => {
    if (data.loggedIn) _showCaltopoLoggedIn();
  }).catch(() => {});

  // Poll for bookmarklet login (updates UI within 3s of clicking bookmark)
  setInterval(() => {
    const loginSection = document.getElementById('caltopo_login_section');
    if (!loginSection || loginSection.style.display === 'none') return;
    fetch('/caltopo/status').then(r => r.json()).then(data => {
      if (data.loggedIn) {
        _showCaltopoLoggedIn();
        if (getCaltopoState().url) _fetchCaltopoKml();
      }
    }).catch(() => {});
  }, 3000);

  // Auto-restore CalTopo KML (no prompt — it's a live feed, should just resume)
  if (_savedSession?.caltopoUrl && !_projectAtStart) {
    const input = document.getElementById('caltopo_url_input');
    const sel   = document.getElementById('caltopo_interval_select');
    if (input) input.value = _savedSession.caltopoUrl;
    if (sel && _savedSession.caltopoInterval != null) {
      sel.value = String(_savedSession.caltopoInterval);
    }
    loadCaltopoKml(_savedSession.caltopoUrl, _savedSession.caltopoInterval ?? 60);
  }

  // Data files: My data's (it takes in URL files the old saved view still lists)
  if (!_projectAtStart && window._myData) {
    window._myData.filesToRestore(_savedSession?.dataFiles || []).then(list => list.forEach(f =>
      addDataFile(f.url, f.label, { myId: f.id }).catch(e => console.warn('[my data] data file restore failed:', e))))
      .catch(e => console.warn('[my data] data files:', e));
  } else if (_savedSession?.dataFiles?.length && !_projectAtStart) {
    for (const f of _savedSession.dataFiles) {
      addDataFile(f.url, f.label).catch(e => console.warn('[session] data file restore failed:', e));
    }
  }
  // Points of interest kept in My data
  if (window._myData) window._myData.points().then(ps => {
    ps.forEach(p => window._myData.placePoint(cesiumViewer.entities.add({ name: p.name, label: { scale: p.scale, text: p.name, show: p.label !== false }, position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h),
      properties: { isUserLabel: true, myFeature: p.id }, point: p.color ? { color: Cesium.Color.fromCssColorString(p.color) } : {} }), p));      // at its own height (my-data.js)
    if (ps.length) renderPoiList();
  }).catch(e => console.warn('[my data] points:', e));

  // Restore cave visibility
  if (_savedSession?.caveVisible) {
    const caveToggle = document.getElementById('lp-cave-toggle');
    if (caveToggle) caveToggle.checked = true;
    setCaveSurveyVisible(true);
  }

  // Restore POI visibility
  if (_savedSession?.poiVisible === false) {
    const poiToggle = document.getElementById('html_labels_toggle');
    if (poiToggle) { poiToggle.checked = false; poiToggle.dispatchEvent(new Event('change')); }
  }

  // Restore panel section open/closed state
  if (_savedSession?.panelSections) {
    for (const [id, open] of Object.entries(_savedSession.panelSections)) {
      const body = document.getElementById(id);
      if (!body) continue;
      body.classList.toggle('open', open);
      const arrow = body.previousElementSibling?.querySelector('.lp-section-arrow');
      if (arrow) arrow.style.transform = open ? '' : 'rotate(-90deg)';
    }
  }
}, 0);
}
