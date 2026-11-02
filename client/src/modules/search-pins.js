// Search pins: a geocoder result is reduced to its centre, a pin is dropped on
// the ground there and the camera flies in; pins are saved with the session.
// Moved out of flex.js unchanged (flex.js split, wave 2; see client/src/README.md).
//
// Pure export (node-testable):  escapeHtml(s)
// Setup: setupSearchPins({ Cesium, cesiumViewer, savedSession, notifySearchPinsChanged }) -> { escapeHtml }
// window._clearSearchPins is defined here.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function setupSearchPins({ Cesium, cesiumViewer, savedSession: _savedSession, notifySearchPinsChanged }) {
  // ── Search pins ──────────────────────────────────────────────────────────────
  // Cesium's search box frames the whole result: a town, a park or a peak comes
  // back as a bounding rectangle and the camera stops kilometres up. Instead take
  // the result's centre, find the ground there, drop a pin on it and fly in close.
  // Pins accumulate (a toolbar button clears them) and are saved with the session.
  const SEARCH_PIN_RANGE_M   = 300;                          // camera distance from the pin
  const SEARCH_PIN_PITCH     = Cesium.Math.toRadians(-40);   // looking down at it
  const SEARCH_TERRAIN_WAIT_MS = 4000;                       // give up on full-detail terrain after this
  const _searchPins = [];                                    // {name, lon, lat, elev, entity}
  const _searchPinImage = new Cesium.PinBuilder()
    .fromColor(Cesium.Color.fromCssColorString('#ff3b30'), 40).toDataURL();

  function _searchPinEntity(p) {
    // The InfoBox iframe runs unsandboxed (above), so anything typed into the
    // search box must be escaped before it goes into the description.
    const name = escapeHtml(p.name);
    return cesiumViewer.entities.add({
      name: p.name,
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.elev),
      billboard: {
        image: _searchPinImage,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: p.name,
        font: 'bold 13px sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -44),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      description:
        `<table class="cesium-infoBox-defaultTable"><tbody>` +
        `<tr><th>Search</th><td>${name}</td></tr>` +
        `<tr><th>Lat, Lon</th><td>${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</td></tr>` +
        `<tr><th>Ground</th><td>${p.elev.toFixed(1)} m (${(p.elev / 0.3048).toFixed(0)} ft)</td></tr>` +
        `</tbody></table>`,
    });
  }

  function _addSearchPin(p) {
    _searchPins.push({ ...p, entity: _searchPinEntity(p) });
    _updateSearchPinButton();
  }

  function _saveSearchPins() {
    notifySearchPinsChanged(_searchPins);
  }

  window._clearSearchPins = function () {
    for (const p of _searchPins) cesiumViewer.entities.remove(p.entity);
    _searchPins.length = 0;
    _updateSearchPinButton();
    _saveSearchPins();
  };

  // A button in Cesium's own toolbar, next to the search box; hidden with no pins.
  let _searchPinButton = null;
  function _updateSearchPinButton() {
    if (!_searchPinButton) {
      const bar = cesiumViewer.container.querySelector('.cesium-viewer-toolbar');
      if (!bar) return;
      _searchPinButton = document.createElement('button');
      _searchPinButton.type = 'button';
      _searchPinButton.className = 'cesium-button cesium-toolbar-button';
      _searchPinButton.style.cssText = 'padding:0; display:inline-flex; align-items:center; justify-content:center;';
      _searchPinButton.innerHTML = window.icon('pin', 16) + window.icon('x', 10);   // pin + cross: clears, not adds
      _searchPinButton.addEventListener('click', () => window._clearSearchPins());
      const geocoder = bar.querySelector('.cesium-viewer-geocoderContainer');
      bar.insertBefore(_searchPinButton, geocoder ? geocoder.nextSibling : bar.firstChild);
    }
    const n = _searchPins.length;
    _searchPinButton.style.display = n ? '' : 'none';
    _searchPinButton.title = `Clear search pins (${n})`;
  }

  async function _groundHeightAt(carto) {
    const fallback = cesiumViewer.scene.globe.getHeight(carto) ?? 0;
    try {
      const sample = Cesium.sampleTerrainMostDetailed(cesiumViewer.terrainProvider,
        [Cesium.Cartographic.clone(carto)]);
      const timeout = new Promise(res => setTimeout(() => res(null), SEARCH_TERRAIN_WAIT_MS));
      const r = await Promise.race([sample, timeout]);
      const h = r && r[0] && r[0].height;
      return Number.isFinite(h) ? h : fallback;
    } catch (e) {
      console.warn('[search] terrain sample failed; using the loaded terrain', e);
      return fallback;
    }
  }

  async function _dropSearchPin(name, carto) {
    const elev = await _groundHeightAt(carto);
    const p = {
      name,
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      elev,
    };
    _addSearchPin(p);
    _saveSearchPins();
    const target = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.elev);
    cesiumViewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 0), {
      offset: new Cesium.HeadingPitchRange(cesiumViewer.camera.heading, SEARCH_PIN_PITCH,
                                           SEARCH_PIN_RANGE_M),
      duration: 2.5,
    });
  }

  {
    const gvm = cesiumViewer.geocoder?.viewModel;
    if (gvm) {
      // Cesium's documented hook: called with the chosen result instead of its
      // default fly-to-fit. A rectangle (most place results) is reduced to its
      // centre; typed coordinates arrive as a point.
      gvm.destinationFound = function (viewModel, destination) {
        // Cesium sets _searchText to the result's display name just before this
        // call; the public searchText getter can still return the stale value.
        const name = String(viewModel._searchText || viewModel.searchText || '').trim()
                     || 'Search result';
        const carto = destination instanceof Cesium.Rectangle
          ? Cesium.Rectangle.center(destination)
          : Cesium.Cartographic.fromCartesian(destination);
        _dropSearchPin(name, carto);
      };
    }
    // Restore before anything can save, so a save cannot wipe them first.
    for (const p of (_savedSession?.searchPins || [])) {
      if (Number.isFinite(p?.lon) && Number.isFinite(p?.lat) && Number.isFinite(p?.elev)) {
        _addSearchPin({ name: String(p.name || 'Search result'), lon: p.lon, lat: p.lat, elev: p.elev });
      }
    }
    _saveSearchPins();
  }


  return { escapeHtml };
}
