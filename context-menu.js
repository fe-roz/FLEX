/**
 * context-menu.js — Right-click / long-press context menu for the Cesium globe.
 *
 * Adapted from Matt's FLEX implementation (git.code.taxi/matt/FLEX).
 * Extra services added: Windy, PeakFinder.
 * All constants are inlined — no external module dependencies.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const LONG_PRESS_MS     = 500;
const TOAST_DURATION_MS = 2000;
// Web Mercator: metres per pixel at zoom 0 at the equator
const WEB_MERCATOR_C    = 156543;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Convert camera altitude to an approximate web-map zoom level (1–20).
 */
export function altitudeToZoom(altitude, lat = 0) {
  const latRad = (lat * Math.PI) / 180;
  const metersPerPixel = altitude / 512;
  const zoom = Math.log2((WEB_MERCATOR_C * Math.cos(latRad)) / metersPerPixel);
  return Math.round(Math.max(1, Math.min(20, zoom)));
}

/**
 * Format lat/lng for display.
 */
export function formatCoords(lat, lng, decimals = 6) {
  return `${lat.toFixed(decimals)}, ${lng.toFixed(decimals)}`;
}

/**
 * Build external-map URLs for a given position.
 * Returns an ordered object: { key: { name, url } }.
 */
export function generateExternalMapUrls(lat, lng, zoom) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';
  const absLat  = Math.abs(lat).toFixed(4);
  const absLng  = Math.abs(lng).toFixed(4);

  return {
    calTopo:       { name: 'CalTopo',       url: `https://caltopo.com/map.html#ll=${lat},${lng}&z=${zoom}&b=mbt` },
    googleMaps:    { name: 'Google Maps',   url: `https://www.google.com/maps/@${lat},${lng},${zoom}z` },
    gaiaGPS:       { name: 'Gaia GPS',      url: `https://www.gaiagps.com/map/?loc=${zoom}/${lng}/${lat}` },
    windy:         { name: 'Windy',         url: `https://www.windy.com/?${lat.toFixed(4)},${lng.toFixed(4)},${zoom}` },
    weatherGov:    { name: 'Weather.gov',   url: `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lng}` },
    peakFinder:    { name: 'PeakFinder',    url: `https://www.peakfinder.org/?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}` },
    openStreetMap: { name: 'OpenStreetMap', url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${zoom}/${lat.toFixed(4)}/${lng.toFixed(4)}` },
    bingMaps:      { name: 'Bing Maps',     url: `https://www.bing.com/maps?cp=${lat}~${lng}&lvl=${zoom}` },
    ngmdb:         { name: 'NGMDB Mapview', url: `https://ngmdb.usgs.gov/mapview/?center=${lng},${lat}&zoom=${zoom}` },
    geoHack:       { name: 'GeoHack',       url: `https://geohack.toolforge.org/geohack.php?params=${absLat}_${latDir}_${absLng}_${lngDir}` },
  };
}

// ── DOM factory ───────────────────────────────────────────────────────────────

export function createContextMenuElement({ document: doc = document } = {}) {
  const menu = doc.createElement('div');
  menu.id        = 'mapContextMenu';
  menu.className = 'map-context-menu';
  menu.innerHTML = `
    <div class="context-menu-coords" id="contextMenuCoords"
         data-action="copyCoords" title="Click to copy coordinates">--</div>
    <div class="context-menu-divider"></div>
    <div id="contextMenuLinks"></div>
  `;
  return menu;
}

// ── Controller ────────────────────────────────────────────────────────────────

export class ContextMenuController {
  constructor({ Cesium, cesiumViewer, document: doc = document, window: win = window } = {}) {
    this.Cesium        = Cesium;
    this.cesiumViewer  = cesiumViewer;
    this.document      = doc;
    this.window        = win;
    this.menuElement   = null;
    this.currentCoords = null;
    this.currentAltitude = null;
    this._boundHandlers  = {};
  }

  initialize() {
    // Create and mount the menu element
    this.menuElement = this.document.getElementById('mapContextMenu');
    if (!this.menuElement) {
      this.menuElement = createContextMenuElement({ document: this.document });
      this.document.body.appendChild(this.menuElement);
    }

    this._setupEventListeners();

    // Suppress Cesium's built-in right-click handler (camera tilt reset) so it
    // doesn't fight with our context menu.
    try {
      this.cesiumViewer.screenSpaceEventHandler.setInputAction(
        () => {},
        this.Cesium.ScreenSpaceEventType.RIGHT_CLICK
      );
    } catch (_) { /* viewer may not expose this in all builds */ }
  }

  _setupEventListeners() {
    const canvas = this.cesiumViewer.canvas;

    this._boundHandlers.contextMenu  = (e) => this._handleContextMenu(e);
    this._boundHandlers.clickOutside = (e) => this._handleClickOutside(e);
    this._boundHandlers.keydown      = (e) => this._handleKeydown(e);
    this._boundHandlers.menuClick    = (e) => this._handleMenuClick(e);

    canvas.addEventListener('contextmenu', this._boundHandlers.contextMenu);
    this.document.addEventListener('click',   this._boundHandlers.clickOutside);
    this.document.addEventListener('keydown', this._boundHandlers.keydown);
    this.menuElement.addEventListener('click', this._boundHandlers.menuClick);

    this._setupLongPress(canvas);
  }

  _setupLongPress(canvas) {
    let longPressTimer = null;
    let touchStartPos  = null;
    const MOVE_THRESHOLD = 10; // px

    this._boundHandlers.touchStart = (e) => {
      if (e.touches.length !== 1) return;
      touchStartPos  = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      longPressTimer = setTimeout(() => {
        this._showMenuAtPosition(touchStartPos.x, touchStartPos.y);
      }, LONG_PRESS_MS);
    };

    this._boundHandlers.touchMove = (e) => {
      if (!touchStartPos || !longPressTimer) return;
      const dx = e.touches[0].clientX - touchStartPos.x;
      const dy = e.touches[0].clientY - touchStartPos.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    this._boundHandlers.touchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      touchStartPos = null;
    };

    canvas.addEventListener('touchstart',  this._boundHandlers.touchStart,  { passive: true });
    canvas.addEventListener('touchmove',   this._boundHandlers.touchMove,   { passive: true });
    canvas.addEventListener('touchend',    this._boundHandlers.touchEnd,    { passive: true });
    canvas.addEventListener('touchcancel', this._boundHandlers.touchEnd,    { passive: true });
  }

  _handleContextMenu(e) {
    e.preventDefault();
    this._showMenuAtPosition(e.clientX, e.clientY);
  }

  _showMenuAtPosition(screenX, screenY) {
    const { Cesium, cesiumViewer: viewer } = this;

    // Convert viewport (clientX/clientY) coordinates to canvas-relative coordinates.
    // Cesium pick APIs expect coordinates relative to the canvas element, NOT the
    // browser viewport — the canvas may be offset from the viewport origin.
    const canvas  = viewer.canvas;
    const rect    = canvas.getBoundingClientRect();
    const canvasX = screenX - rect.left;
    const canvasY = screenY - rect.top;
    const canvasPos = new Cesium.Cartesian2(canvasX, canvasY);

    let lat, lng;

    // Primary: ray-cast against loaded terrain tiles (most accurate)
    try {
      const ray       = viewer.camera.getPickRay(canvasPos);
      const cartesian = ray && viewer.scene.globe.pick(ray, viewer.scene);
      if (cartesian && Cesium.defined(cartesian)) {
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        lat = Cesium.Math.toDegrees(carto.latitude);
        lng = Cesium.Math.toDegrees(carto.longitude);
      }
    } catch (_) { /* terrain tile may not yet be loaded */ }

    // Secondary: depth-buffer pick — works for 3D models / point clouds
    if (lat === undefined) {
      try {
        const cartesian = viewer.scene.pickPosition(canvasPos);
        if (cartesian && Cesium.defined(cartesian)) {
          const carto = Cesium.Cartographic.fromCartesian(cartesian);
          lat = Cesium.Math.toDegrees(carto.latitude);
          lng = Cesium.Math.toDegrees(carto.longitude);
        }
      } catch (_) { /* depth-testing may be unavailable */ }
    }

    // Final fallback: project camera straight down to the ellipsoid
    if (lat === undefined || lng === undefined) {
      const carto = viewer.scene.globe.ellipsoid.cartesianToCartographic(viewer.camera.position);
      lat = Cesium.Math.toDegrees(carto.latitude);
      lng = Cesium.Math.toDegrees(carto.longitude);
    }

    const camCarto = viewer.scene.globe.ellipsoid.cartesianToCartographic(viewer.camera.position);
    this.currentAltitude = camCarto.height;
    this.currentCoords   = { lat, lng };

    this._updateMenuContent();
    this._positionMenu(screenX, screenY);
    this.menuElement.classList.add('visible');
  }

  _updateMenuContent() {
    const { lat, lng } = this.currentCoords;
    const zoom = altitudeToZoom(this.currentAltitude, lat);

    const coordsEl = this.menuElement.querySelector('#contextMenuCoords');
    if (coordsEl) coordsEl.textContent = formatCoords(lat, lng);

    const linksEl = this.menuElement.querySelector('#contextMenuLinks');
    if (linksEl) {
      const urls = generateExternalMapUrls(lat, lng, zoom);
      linksEl.innerHTML = Object.values(urls)
        .map(({ name, url }) =>
          `<a href="${url}" target="_blank" rel="noopener noreferrer"
              class="context-menu-item context-menu-link">
            <span class="context-menu-text">${name}</span>
            <span class="context-menu-external">↗</span>
          </a>`
        )
        .join('');
    }
  }

  _positionMenu(x, y) {
    const menu = this.menuElement;
    // Measure off-screen first
    menu.style.left = '0';
    menu.style.top  = '0';
    const { width, height } = menu.getBoundingClientRect();

    let left = x + 2;
    let top  = y + 2;
    if (left + width  > this.window.innerWidth  - 10) left = x - width  - 2;
    if (top  + height > this.window.innerHeight - 10) top  = y - height - 2;

    menu.style.left = `${Math.max(10, left)}px`;
    menu.style.top  = `${Math.max(10, top)}px`;
  }

  hide() {
    this.menuElement?.classList.remove('visible');
  }

  _handleClickOutside(e) {
    if (this.menuElement && !this.menuElement.contains(e.target)) this.hide();
  }

  _handleKeydown(e) {
    if (e.key === 'Escape') this.hide();
  }

  _handleMenuClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'copyCoords') this._copyCoordinates();
    this.hide();
  }

  async _copyCoordinates() {
    if (!this.currentCoords) return;
    const text = formatCoords(this.currentCoords.lat, this.currentCoords.lng);
    try {
      await this.window.navigator.clipboard.writeText(text);
      this._showToast('Coordinates copied');
    } catch (e) {
      console.error('[context-menu] clipboard write failed:', e);
    }
  }

  _showToast(message) {
    let toast = this.document.getElementById('contextMenuToast');
    if (!toast) {
      toast = this.document.createElement('div');
      toast.id        = 'contextMenuToast';
      toast.className = 'context-menu-toast';
      this.document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), TOAST_DURATION_MS);
  }

  dispose() {
    const canvas = this.cesiumViewer?.canvas;
    if (canvas) {
      canvas.removeEventListener('contextmenu',  this._boundHandlers.contextMenu);
      canvas.removeEventListener('touchstart',   this._boundHandlers.touchStart);
      canvas.removeEventListener('touchmove',    this._boundHandlers.touchMove);
      canvas.removeEventListener('touchend',     this._boundHandlers.touchEnd);
      canvas.removeEventListener('touchcancel',  this._boundHandlers.touchEnd);
    }
    this.document.removeEventListener('click',   this._boundHandlers.clickOutside);
    this.document.removeEventListener('keydown', this._boundHandlers.keydown);
    if (this.menuElement) {
      this.menuElement.removeEventListener('click', this._boundHandlers.menuClick);
      this.menuElement.remove();
    }
    this.document.getElementById('contextMenuToast')?.remove();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function initializeContextMenu(options) {
  const controller = new ContextMenuController(options);
  controller.initialize();
  return controller;
}
