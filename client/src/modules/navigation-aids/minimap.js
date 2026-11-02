// The minimap (OpenLayers): base-layer list, the attention heat-map store, the
// CalTopo overlay, hover label, the draggable / resizable window and the map
// itself. Moved out of flex.js unchanged (the flex.js split, wave 1; see
// client/src/README.md). The per-frame sync is in minimap-sync.js.
//
// Pure exports (no browser; `ol` is passed in, ProxyUrlGenerator is the page
// global), node-testable:
//   createMiniMapLayerDefs(ol) -> [{ name, createSource() }]
//   proxifyOlSource(source), getAttentionKey(lon, lat), unpackAttentionKey(key)
//   ATTENTION_STORAGE_KEY, ATTENTION_CELL_METERS
// Setup:
//   setupMinimap({ Cesium, ol, cesiumViewer, state })
//     state (flex.js owns these three, they are used outside the minimap):
//       miniMapMap, miniMapUserHidden, miniMapCaltopoSource  (get/set)
//     -> { initMiniMap, loadAttentionGrid, saveAttentionGrid, addAttentionAt,
//          renderMiniMapAttention, syncMinimapCaltopoFeatures, shared }
//     `shared` is the live state minimap-sync.js reads / writes (view, centre
//     feature, label source, zoom offset, current radius, and the three attention
//     functions the sync calls).
// window._miniMapOl is still assigned by initMiniMap().

export const ATTENTION_STORAGE_KEY = "flex_minimap_attention_v1";
export const ATTENTION_CELL_METERS = 15;

export function proxifyOlSource(source) {
  if (!source || typeof source.getTileLoadFunction !== "function") {
    return source;
  }
  const defaultTileLoad = source.getTileLoadFunction();
  source.setTileLoadFunction((tile, src) => {
    const proxySrc = ProxyUrlGenerator.generateProxyUrl(src);
    defaultTileLoad(tile, proxySrc || src);
  });
  return source;
}


export function createMiniMapLayerDefs(ol) {
  return [
  {
    name: "Bing Maps Aerial",
    createSource: () =>
      proxifyOlSource(new ol.source.XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        crossOrigin: "anonymous",
        maxZoom: 19
      }))
  },
  {
    name: "OpenStreetMaps",
    createSource: () => proxifyOlSource(new ol.source.OSM())
  },
  {
    name: "Slope Angle",
    createSource: () =>
      proxifyOlSource(new ol.source.XYZ({
        url: "https://caltopo.com/tile/sg/{z}/{x}/{y}.png",
        crossOrigin: "anonymous",
        maxZoom: 18
      }))
  },
  {
    name: "US Karst Map",
    createSource: () =>
      proxifyOlSource(new ol.source.XYZ({
        url: "https://tiles.arcgis.com/tiles/hoKRg7d6zCP8hwp2/arcgis/rest/services/Carbonate_Karst/MapServer/tile/{z}/{y}/{x}?blankTile=false",
        crossOrigin: "anonymous",
        maxZoom: 18
      }))
  },
  {
    name: "NGMDB Mosaic",
    createSource: () =>
      proxifyOlSource(
        new ol.source.TileArcGISRest({
          url: "https://ngmdb.usgs.gov/imagery/rest/services/mapview/ngmdbMosaic/ImageServer",
          params: {
            FORMAT: "jpgpng",
            F: "image",
            mosaicRule: '{"ascending":true}'
          },
          crossOrigin: "anonymous"
        })
      )
  }
];
}

export function getAttentionKey(lonDeg, latDeg) {
  const cellDeg = ATTENTION_CELL_METERS / 111320;
  const lonKey = Math.round(lonDeg / cellDeg);
  const latKey = Math.round(latDeg / cellDeg);
  return `${lonKey},${latKey}`;
}

export function unpackAttentionKey(key) {
  const parts = key.split(",");
  const cellDeg = ATTENTION_CELL_METERS / 111320;
  const lon = Number(parts[0]) * cellDeg;
  const lat = Number(parts[1]) * cellDeg;
  return { lon, lat };
}

export function setupMinimap({ Cesium, ol, cesiumViewer, state }) {
  let miniMapView = null;
  let miniMapBaseLayer = null;
  let miniMapAttentionLayer = null;
  let miniMapAttentionSource = null;
  let miniMapLabelLayer = null;
  let miniMapLabelSource = null;
  let miniMapCaltopoLayer = null;
  let miniMapCenterLayer = null;
  let miniMapCenterFeature = null;
  let miniMapAttentionEnabled = true;
  let miniMapHoverLabelElement = null;
  let miniMapZoomOffset = 0;  // scroll-wheel baseline adjustment (integer zoom steps)
  let miniMapLastSavedAt = 0;
  const ATTENTION_SAVE_INTERVAL_MS = 10000;
  const ATTENTION_MAX_POINTS_RENDER = 320;
  const MINIMAP_RENDER_INTERVAL_MOVING_MS = 120;
  const MINIMAP_RENDER_INTERVAL_IDLE_MS = 420;
  const MINIMAP_ATTENTION_RENDER_INTERVAL_MS = 900;
  const MINIMAP_LABEL_SYNC_INTERVAL_MS = 1400;
  const attentionGrid = {};
  let attentionDirty = false;
  let miniMapCurrentRadiusMeters = 500;
  const ENABLE_MINIMAP_HEATMAP = false;

  const miniMapLayerDefs = createMiniMapLayerDefs(ol);

  function loadAttentionGrid() {
    if (!ENABLE_MINIMAP_HEATMAP) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(ATTENTION_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.grid) {
        return;
      }
      Object.assign(attentionGrid, parsed.grid);
    } catch (error) {
      console.warn("Unable to load minimap attention data.", error);
    }
  }

  function saveAttentionGrid(force) {
    if (!ENABLE_MINIMAP_HEATMAP) {
      return;
    }
    const now = Date.now();
    if (!force && (!attentionDirty || now - miniMapLastSavedAt < ATTENTION_SAVE_INTERVAL_MS)) {
      return;
    }
    try {
      window.localStorage.setItem(
        ATTENTION_STORAGE_KEY,
        JSON.stringify({
          savedAt: now,
          grid: attentionGrid
        })
      );
      attentionDirty = false;
      miniMapLastSavedAt = now;
    } catch (error) {
      console.warn("Unable to persist minimap attention data.", error);
    }
  }

  function addAttentionAt(lonDeg, latDeg, radiusMeters, amount) {
    if (!ENABLE_MINIMAP_HEATMAP) {
      return;
    }
    const radiusCells = Math.max(1, Math.ceil(radiusMeters / ATTENTION_CELL_METERS));
    for (let ix = -radiusCells; ix <= radiusCells; ix++) {
      for (let iy = -radiusCells; iy <= radiusCells; iy++) {
        const distanceMeters = Math.hypot(ix * ATTENTION_CELL_METERS, iy * ATTENTION_CELL_METERS);
        if (distanceMeters > radiusMeters) {
          continue;
        }
        const lon = lonDeg + (ix * ATTENTION_CELL_METERS) / 111320;
        const lat = latDeg + (iy * ATTENTION_CELL_METERS) / 111320;
        const key = getAttentionKey(lon, lat);
        const radialWeight = 1 - distanceMeters / Math.max(radiusMeters, 1);
        const previous = attentionGrid[key] || 0;
        attentionGrid[key] = previous + amount * radialWeight;
      }
    }
    attentionDirty = true;
  }

  function renderMiniMapAttention(centerLonDeg, centerLatDeg) {
    if (!ENABLE_MINIMAP_HEATMAP) {
      return;
    }
    if (!state.miniMapMap || !miniMapAttentionSource) {
      return;
    }
    miniMapAttentionSource.clear();
    if (!miniMapAttentionEnabled) {
      return;
    }

    const maxDistance = Math.max(350, miniMapCurrentRadiusMeters * 1.4);
    const maxLonDelta = maxDistance / (111320 * Math.max(0.2, Math.cos((centerLatDeg * Math.PI) / 180)));
    const maxLatDelta = maxDistance / 111320;
    const entries = [];
    for (const [key, score] of Object.entries(attentionGrid)) {
      if (score <= 0) {
        continue;
      }
      const unpacked = unpackAttentionKey(key);
      if (Math.abs(unpacked.lon - centerLonDeg) > maxLonDelta || Math.abs(unpacked.lat - centerLatDeg) > maxLatDelta) {
        continue;
      }
      entries.push({ ...unpacked, score });
    }
    entries.sort((a, b) => b.score - a.score);
    const visible = entries.slice(0, ATTENTION_MAX_POINTS_RENDER);
    const peak = visible.length ? visible[0].score : 1;
    for (const item of visible) {
      const normalized = Math.min(1, item.score / peak);
      const feature = new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([item.lon, item.lat]))
      });
      feature.setStyle(
        new ol.style.Style({
          image: new ol.style.Circle({
            radius: 1.8 + normalized * 4.2,
            fill: new ol.style.Fill({
              color: `rgba(255, ${Math.round(220 - normalized * 120)}, 50, ${0.25 + normalized * 0.7})`
            }),
            stroke: new ol.style.Stroke({
              color: "rgba(255,255,255,0.3)",
              width: 0.5
            })
          })
        })
      );
      miniMapAttentionSource.addFeature(feature);
    }
  }


  function initMiniMapLayerControls() {
    const layerSelect = document.getElementById("mini_map_layer_select");
    const heatToggle = document.getElementById("mini_map_attention_toggle");
    const heatToggleLabel = heatToggle ? heatToggle.parentElement : null;
    miniMapHoverLabelElement = document.getElementById("mini_map_hover_label");
    if (!layerSelect || !heatToggle) {
      return;
    }
    layerSelect.innerHTML = "";
    for (const layerDef of miniMapLayerDefs) {
      const option = document.createElement("option");
      option.value = layerDef.name;
      option.innerText = layerDef.name;
      layerSelect.appendChild(option);
    }
    layerSelect.value = "Bing Maps Aerial";
    layerSelect.addEventListener("change", () => {
      applyMiniMapLayer(layerSelect.value);
    });
    if (!ENABLE_MINIMAP_HEATMAP) {
      miniMapAttentionEnabled = false;
      heatToggle.checked = false;
      if (heatToggleLabel) {
        heatToggleLabel.style.display = "none";
      }
    } else {
      heatToggle.checked = miniMapAttentionEnabled;
      heatToggle.addEventListener("change", () => {
        miniMapAttentionEnabled = heatToggle.checked;
      });
    }
  }

  async function applyMiniMapLayer(layerName) {
    if (!miniMapBaseLayer) {
      return;
    }
    const layerDef = miniMapLayerDefs.find((entry) => entry.name === layerName);
    if (!layerDef) {
      return;
    }
    try {
      const source = await Promise.resolve(layerDef.createSource());
      miniMapBaseLayer.setSource(source);
    } catch (error) {
      console.error(`Unable to set minimap layer ${layerName}.`, error);
    }
  }


  /**
   * Populate the CalTopo minimap layer from a freshly-loaded Cesium KmlDataSource.
   * Called after every successful KML fetch.  Handles Points, Polylines, and Polygons.
   */
  function syncMinimapCaltopoFeatures(ds) {
    if (!state.miniMapCaltopoSource || !ds) return;
    state.miniMapCaltopoSource.clear();

    const now = Cesium.JulianDate.now();

    // Shared styles
    const pointStyle = new ol.style.Style({
      image: new ol.style.Circle({
        radius: 5,
        fill:   new ol.style.Fill({ color: 'rgba(255,160,0,0.9)' }),
        stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }),
      }),
      text: new ol.style.Text({
        offsetY: -12,
        font:    'bold 11px sans-serif',
        fill:    new ol.style.Fill({ color: '#fff' }),
        stroke:  new ol.style.Stroke({ color: 'rgba(0,0,0,0.7)', width: 3 }),
      }),
    });

    const lineStyle = new ol.style.Style({
      stroke: new ol.style.Stroke({ color: 'rgba(255,160,0,0.9)', width: 2 }),
    });

    const polyStyle = new ol.style.Style({
      stroke: new ol.style.Stroke({ color: 'rgba(255,160,0,0.9)', width: 2 }),
      fill:   new ol.style.Fill({ color: 'rgba(255,160,0,0.15)' }),
    });

    function cartToLonLat(c3) {
      const c = Cesium.Cartographic.fromCartesian(c3);
      return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
    }

    for (const entity of ds.entities.values) {
      try {
        // ── Point / Billboard ──────────────────────────────────────────────────
        if (entity.position) {
          const pos = entity.position.getValue(now);
          if (!pos) continue;
          const ll = cartToLonLat(pos);
          if (!isFinite(ll[0]) || !isFinite(ll[1])) continue;
          const feat = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat(ll)) });
          const name = entity.name || '';
          // Clone style so we can set per-feature text
          const st = pointStyle.clone();
          if (name) st.getText().setText(name);
          feat.setStyle(st);
          feat.set('caltopoName', name);
          state.miniMapCaltopoSource.addFeature(feat);
        }
        // ── Polyline ───────────────────────────────────────────────────────────
        else if (entity.polyline) {
          const positions = entity.polyline.positions?.getValue(now);
          if (!positions || positions.length < 2) continue;
          const coords = positions.map(cartToLonLat).filter(ll => isFinite(ll[0]));
          if (coords.length < 2) continue;
          const feat = new ol.Feature({
            geometry: new ol.geom.LineString(coords.map(ll => ol.proj.fromLonLat(ll)))
          });
          feat.setStyle(lineStyle);
          if (entity.name) feat.set('caltopoName', entity.name);
          state.miniMapCaltopoSource.addFeature(feat);
        }
        // ── Polygon ────────────────────────────────────────────────────────────
        else if (entity.polygon) {
          const hierarchy = entity.polygon.hierarchy?.getValue(now);
          if (!hierarchy?.positions) continue;
          const ring = hierarchy.positions.map(cartToLonLat).filter(ll => isFinite(ll[0]));
          if (ring.length < 3) continue;
          const feat = new ol.Feature({
            geometry: new ol.geom.Polygon([ring.map(ll => ol.proj.fromLonLat(ll))])
          });
          feat.setStyle(polyStyle);
          if (entity.name) feat.set('caltopoName', entity.name);
          state.miniMapCaltopoSource.addFeature(feat);
        }
      } catch (err) {
        // Skip malformed entities silently
      }
    }
  }

  function initMiniMapHover() {
    if (!state.miniMapMap || !miniMapHoverLabelElement) {
      return;
    }
    state.miniMapMap.on("pointermove", (event) => {
      // the first feature that has a label (the view footprint drawn over an outline has none)
      const feature = state.miniMapMap.forEachFeatureAtPixel(event.pixel, (hitFeature) => (hitFeature.get("labelText") ? hitFeature : undefined));
      const foundText = feature ? feature.get("labelText") : "";
      if (foundText && typeof foundText === "string") {
        miniMapHoverLabelElement.style.display = "block";
        miniMapHoverLabelElement.innerText = foundText;
      } else {
        miniMapHoverLabelElement.style.display = "none";
        miniMapHoverLabelElement.innerText = "";
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }

  function initMiniMap() {
    const miniMapContainer = document.getElementById("mini_map_canvas");
    if (!miniMapContainer) {
      return;
    }

    miniMapBaseLayer = new ol.layer.Tile({
      source: new ol.source.OSM()
    });
    miniMapAttentionSource = new ol.source.Vector();
    miniMapAttentionLayer = new ol.layer.Vector({
      source: miniMapAttentionSource
    });
    miniMapLabelSource = new ol.source.Vector();
    miniMapLabelLayer = new ol.layer.Vector({
      source: miniMapLabelSource
    });
    state.miniMapCaltopoSource = new ol.source.Vector();
    miniMapCaltopoLayer = new ol.layer.Vector({
      source: state.miniMapCaltopoSource
    });
    miniMapCenterFeature = new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([0, 0]))
    });
    miniMapCenterFeature.setStyle(
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 4,
          fill: new ol.style.Fill({ color: "rgba(0,220,80,1)" }),
          stroke: new ol.style.Stroke({ color: "rgba(0,0,0,0.85)", width: 2 })
        })
      })
    );
    miniMapCenterLayer = new ol.layer.Vector({
      source: new ol.source.Vector({
        features: [miniMapCenterFeature]
      })
    });
    miniMapView = new ol.View({
      center: ol.proj.fromLonLat([0, 0]),
      zoom: 13,
      rotation: 0,
      constrainRotation: false
    });
    state.miniMapMap = new ol.Map({
      target: "mini_map_canvas",
      layers: [miniMapBaseLayer, miniMapAttentionLayer, miniMapCaltopoLayer, miniMapLabelLayer, miniMapCenterLayer],
      view: miniMapView,
      controls: [],
      interactions: ol.interaction.defaults({
        dragPan: false,
        mouseWheelZoom: false,
        doubleClickZoom: false,
        pinchZoom: false,
        keyboard: false,
        altShiftDragRotate: false,
        pinchRotate: false
      })
    });
    // compass, view footprint, terrain / point-cloud outlines (minimap_view.js)
    window._miniMapOl = state.miniMapMap;
    if (window._minimapView) window._minimapView.attach(state.miniMapMap);
    initMiniMapLayerControls();
    initMiniMapHover();
    applyMiniMapLayer("Bing Maps Aerial");
    initMiniMapWindow();
  }

  function initMiniMapWindow() {
    const STORAGE_KEY = 'flex_minimap_window_v2';
    const container = document.getElementById('mini_map_container');
    const titlebar  = document.getElementById('mini_map_titlebar');
    const closeBtn  = document.getElementById('mini_map_close_btn');
    if (!container || !titlebar) return;

    const MIN_W = 160, MIN_H = 135;

    // Default position: bottom-right corner
    function defaultGeometry() {
      return {
        left:   window.innerWidth  - 18 - 260,
        top:    window.innerHeight - 18 - 285,
        width:  260,
        height: 285,
      };
    }

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch(_) {}
    let geo = Object.assign(defaultGeometry(), saved || {});

    function applyGeometry(g) {
      const vw = window.innerWidth, vh = window.innerHeight;
      g.width  = Math.max(MIN_W, Math.min(g.width,  vw - 10));
      g.height = Math.max(MIN_H, Math.min(g.height, vh - 10));
      g.left   = Math.max(0, Math.min(g.left, vw - g.width));
      g.top    = Math.max(0, Math.min(g.top,  vh - g.height));
      container.style.left   = g.left   + 'px';
      container.style.top    = g.top    + 'px';
      container.style.width  = g.width  + 'px';
      container.style.height = g.height + 'px';
      container.style.right  = '';
      container.style.bottom = '';
      geo = { left: g.left, top: g.top, width: g.width, height: g.height };
      if (state.miniMapMap) state.miniMapMap.updateSize();
    }

    function saveGeometry() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(geo)); } catch(_) {}
    }

    applyGeometry(geo);

    // --- Drag (titlebar) ---
    titlebar.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = geo.left, startTop = geo.top;
      function onMove(e) {
        applyGeometry({ ...geo, left: startLeft + (e.clientX - startX), top: startTop + (e.clientY - startY) });
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveGeometry();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // --- Resize (4 corners) ---
    // Each corner encodes which edges move via data-corner: nw / ne / sw / se
    container.querySelectorAll('.mini_map_resize').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const corner   = handle.dataset.corner; // 'nw','ne','sw','se'
        const startX   = e.clientX, startY = e.clientY;
        const startGeo = { ...geo };

        function onMove(e) {
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          const g = { ...startGeo };

          // Horizontal: 'w' side moves left edge, 'e' side moves right edge
          if (corner.includes('w')) {
            g.left  = startGeo.left  + dx;
            g.width = startGeo.width - dx;
          } else {
            g.width = startGeo.width + dx;
          }

          // Vertical: 'n' side moves top edge, 's' side moves bottom edge
          if (corner.includes('n')) {
            g.top    = startGeo.top    + dy;
            g.height = startGeo.height - dy;
          } else {
            g.height = startGeo.height + dy;
          }

          applyGeometry(g);
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          saveGeometry();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });

    // --- Scroll wheel: adjust baseline zoom offset ---
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Each detent zooms in or out by 1 step (clamp to ±6 so it can't go crazy)
      miniMapZoomOffset = Cesium.Math.clamp(
        miniMapZoomOffset + (e.deltaY < 0 ? 1 : -1),
        -6, 6
      );
    }, { passive: false });

    // --- Close button ---
    closeBtn.addEventListener('click', () => {
      state.miniMapUserHidden = true;
      container.style.display = 'none';
    });

    // Re-clamp if browser window resizes
    window.addEventListener('resize', () => applyGeometry({ ...geo }));
  }

  const shared = {
    get miniMapView() { return miniMapView; },
    get miniMapCenterFeature() { return miniMapCenterFeature; },
    get miniMapLabelSource() { return miniMapLabelSource; },
    get miniMapZoomOffset() { return miniMapZoomOffset; },
    get miniMapCurrentRadiusMeters() { return miniMapCurrentRadiusMeters; },
    set miniMapCurrentRadiusMeters(v) { miniMapCurrentRadiusMeters = v; },
    addAttentionAt, renderMiniMapAttention, saveAttentionGrid,
  };
  return { initMiniMap, loadAttentionGrid, saveAttentionGrid, addAttentionAt, renderMiniMapAttention, syncMinimapCaltopoFeatures, shared };
}
