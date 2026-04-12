// session.js — Session persistence for FLEX
// Saves camera position, layer state, loaded point cloud URLs, and misc settings to localStorage.

const SESSION_KEY          = 'flex_session_v1';
const SCHEMA_VERSION       = 1;
const AUTOSAVE_INTERVAL_MS = 15_000;  // periodic save every 15s
const CAMERA_SETTLE_MS     = 2_000;   // debounce after camera stops moving

// ── Internal state ────────────────────────────────────────────────────────────
let _cesiumViewer    = null;
let _viewModel       = null;
let _loadedPcUrls    = new Set();
let _cameraSettleTimer  = null;
let _indicator       = null;
let _indicatorTimer  = null;
let _caltopoUrl      = null;
let _caltopoInterval = 30;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once after cesiumViewer, potreeViewer, and viewModel all exist.
 * Wires up auto-save triggers and exposes window._sessionSave for the toolbar button.
 */
export function initSession(cesiumViewer, viewModel) {
  _cesiumViewer = cesiumViewer;
  _viewModel    = viewModel;
  _indicator    = document.getElementById('session_save_indicator');

  // Expose to toolbar Save button (can't import ES modules from inline onclick)
  window._sessionSave = saveSession;

  // Auto-save when base layer changes
  if (viewModel) {
    Cesium.knockout
      .getObservable(viewModel, 'selectedLayer')
      .subscribe(() => saveSession());
  }

  // Periodic save
  setInterval(saveSession, AUTOSAVE_INTERVAL_MS);
}

/**
 * Called by the addPC interceptor in flex.js each time a URL is loaded.
 * Tracks the URL and triggers a save.
 */
export function notifyPcLoaded(url) {
  _loadedPcUrls.add(url);
  saveSession();
}

/**
 * Called by CalTopo load/clear to persist the active KML URL and refresh interval.
 * Pass null url to clear.
 */
export function notifyCaltopoChanged(url, intervalSecs) {
  _caltopoUrl      = url || null;
  _caltopoInterval = (intervalSecs != null) ? intervalSecs : 30;
  saveSession();
}

/**
 * Serialize current state to localStorage.
 */
export function saveSession() {
  if (!_cesiumViewer) return;
  try {
    const snapshot = {
      schemaVersion:   SCHEMA_VERSION,
      savedAt:         Date.now(),
      camera:          _collectCamera(),
      layers:          _collectLayers(),
      pointClouds:     Array.from(_loadedPcUrls),
      caltopoUrl:      _caltopoUrl,
      caltopoInterval: _caltopoInterval,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
    _flashIndicator(true);
  } catch (e) {
    console.warn('[session] save failed:', e);
    _flashIndicator(false);
  }
}

/**
 * Read and parse the saved session from localStorage.
 * Returns the parsed object or null. Pure / stateless.
 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * Restore camera from a saved session object.
 * Safe to call immediately after cesiumViewer is created (before initSession).
 */
export function restoreCamera(session, cesiumViewer) {
  if (!session?.camera) return;
  const c = session.camera;
  try {
    cesiumViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.height),
      orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll },
    });
  } catch (e) {
    console.warn('[session] camera restore failed:', e);
  }
}

/**
 * Restore layer state from a saved session object.
 * Must be called AFTER loadLayers() resolves so baseLayers[] is populated.
 */
export function restoreLayerState(session, viewModel) {
  if (!session?.layers) return;
  const { baseLayerName, overlays } = session.layers;

  // Restore base layer — the existing Knockout subscriber in flex.js handles the swap
  if (baseLayerName && viewModel.baseLayers) {
    const target = viewModel.baseLayers.find(l => l.name === baseLayerName);
    if (target) viewModel.selectedLayer = target;
  }

  // Restore overlay show/alpha
  if (overlays && viewModel.layers) {
    for (const saved of overlays) {
      const live = viewModel.layers.find(l => l.name === saved.name);
      if (live && !viewModel.isSelectableLayer(live)) {
        live.show  = saved.show;
        live.alpha = saved.alpha;
      }
    }
  }

  // Restore misc viewModel settings
  if (session.layers.usgsRef !== undefined) {
    viewModel.usgsRef = session.layers.usgsRef;
  }
}

/**
 * Called every frame from the render loop.
 * Debounces a save 2s after the camera stops moving.
 */
export function onCameraFrame() {
  if (_cameraSettleTimer !== null) {
    clearTimeout(_cameraSettleTimer);
  }
  _cameraSettleTimer = setTimeout(() => {
    _cameraSettleTimer = null;
    saveSession();
  }, CAMERA_SETTLE_MS);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _collectCamera() {
  const cam = _cesiumViewer.camera;
  const carto = _cesiumViewer.scene.globe.ellipsoid.cartesianToCartographic(cam.position);
  return {
    lon:     Cesium.Math.toDegrees(carto.longitude),
    lat:     Cesium.Math.toDegrees(carto.latitude),
    height:  carto.height,
    heading: cam.heading,
    pitch:   cam.pitch,
    roll:    cam.roll,
  };
}

function _collectLayers() {
  if (!_viewModel) return null;
  const overlays = (_viewModel.layers || [])
    .filter(l => !_viewModel.isSelectableLayer(l))
    .map(l => ({ name: l.name, show: l.show, alpha: l.alpha }));
  return {
    baseLayerName: _viewModel.selectedLayer ? _viewModel.selectedLayer.name : null,
    overlays,
    usgsRef: !!_viewModel.usgsRef,
  };
}

function _flashIndicator(success) {
  if (!_indicator) return;
  if (_indicatorTimer) clearTimeout(_indicatorTimer);
  _indicator.textContent = success ? 'Saved ✓' : 'Save failed';
  _indicator.style.color = success ? '#aaffaa' : '#ff8888';
  _indicator.style.display = 'inline';
  _indicatorTimer = setTimeout(() => {
    _indicator.style.display = 'none';
    _indicatorTimer = null;
  }, 1500);
}
