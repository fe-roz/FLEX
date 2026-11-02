// The minimap's per-frame sync: follows the camera (centre, zoom, rotation),
// throttles the redraws, mirrors the user labels onto the map, and the
// height-above-ground helpers it needs. Moved out of flex.js unchanged (the
// flex.js split, wave 1; see client/src/README.md).
//
// Setup: setupMinimapSync({ Cesium, ol, cesiumViewer, scene, state, mm })
//   state: flex.js's miniMapMap / miniMapUserHidden (get/set)
//   mm:    setupMinimap()'s `shared` object (view, centre feature, label source,
//          zoom offset, current radius, addAttentionAt /
//          renderMiniMapAttention / saveAttentionGrid)
//   -> { syncMiniMapFrame, sampleHeightAboveGround, _globeGroundNow }
// (sampleHeightAboveGround and _globeGroundNow are also used by the fly code.)

export function setupMinimapSync({ Cesium, ol, cesiumViewer, scene, state, mm }) {
  let miniMapVisibilityHeight = 15000;
  let miniMapLastSyncTimestamp = 0;
  let miniMapLastCameraPosition = null;
  let miniMapLastHeading = 0;
  let miniMapLastRenderAt = 0;
  let miniMapLastAttentionRenderAt = 0;
  let miniMapLastLabelSyncAt = 0;
  const miniMapLabelEntities = new Map();
  const MINIMAP_RENDER_INTERVAL_MOVING_MS = 120;
  const MINIMAP_RENDER_INTERVAL_IDLE_MS = 420;
  const MINIMAP_ATTENTION_RENDER_INTERVAL_MS = 900;
  const MINIMAP_LABEL_SYNC_INTERVAL_MS = 1400;

  function syncMiniMapLabels() {
    if (!mm.miniMapLabelSource) {
      return;
    }
    const mainEntities = cesiumViewer.entities.values;
    const aliveIds = new Set();
    for (const entity of mainEntities) {
      if (!entity || !entity.position || !entity.label || !entity.properties || !entity.properties.isUserLabel) {
        continue;
      }
      aliveIds.add(entity.id);
      const positionNow = entity.position.getValue(Cesium.JulianDate.now());
      if (!positionNow) {
        continue;
      }
      const cart = Cesium.Cartographic.fromCartesian(positionNow);
      const lon = Cesium.Math.toDegrees(cart.longitude);
      const lat = Cesium.Math.toDegrees(cart.latitude);
      const labelText = entity.label.text.getValue ? entity.label.text.getValue(Cesium.JulianDate.now()) : entity.label.text;
      if (!miniMapLabelEntities.has(entity.id)) {
        const feature = new ol.Feature({
          geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat]))
        });
        feature.set("labelText", labelText);
        feature.setStyle(
          new ol.style.Style({
            image: new ol.style.Circle({
              radius: 3.5,
              fill: new ol.style.Fill({ color: "rgba(80,220,255,0.95)" }),
              stroke: new ol.style.Stroke({ color: "rgba(0,0,0,0.9)", width: 1 })
            })
          })
        );
        mm.miniMapLabelSource.addFeature(feature);
        miniMapLabelEntities.set(entity.id, feature);
      } else {
        const feature = miniMapLabelEntities.get(entity.id);
        feature.getGeometry().setCoordinates(ol.proj.fromLonLat([lon, lat]));
        feature.set("labelText", labelText);
      }
    }
    for (const [mainId, feature] of miniMapLabelEntities.entries()) {
      if (!aliveIds.has(mainId)) {
        mm.miniMapLabelSource.removeFeature(feature);
        miniMapLabelEntities.delete(mainId);
      }
    }
  }


  // globe.getHeight on a coarse tile (just after a jump, or before the detail
  // has loaded) can hit the tile's skirt and come back tens of kilometres below
  // the ellipsoid. No ground is that low, so treat it as "not known yet".
  const GROUND_MIN_PLAUSIBLE_M = -1000;
  function _globeGroundNow(carto) {
    const g = scene.globe.getHeight(carto);
    return (g === undefined || Number.isNaN(g) || g < GROUND_MIN_PLAUSIBLE_M) ? undefined : g;
  }

  function sampleHeightAboveGround(positionCartographic) {
    const groundHeight = _globeGroundNow(positionCartographic);
    if (groundHeight === undefined) {
      return Math.max(positionCartographic.height, 0);
    }
    return positionCartographic.height - groundHeight;
  }

  function syncMiniMapFrame(timestampMs, cameraCartographic) {
    if (!state.miniMapMap || !mm.miniMapView || !cameraCartographic) {
      return;
    }

    const lonDeg = Cesium.Math.toDegrees(cameraCartographic.longitude);
    const latDeg = Cesium.Math.toDegrees(cameraCartographic.latitude);
    const heightAboveGround = Math.max(sampleHeightAboveGround(cameraCartographic), 0);
    const container = document.getElementById("mini_map_container");
    const showMiniMap = !state.miniMapUserHidden && heightAboveGround <= miniMapVisibilityHeight;
    if (container) {
      container.style.display = showMiniMap ? "block" : "none";
    }
    if (!showMiniMap) {
      return;
    }

    const heading = cesiumViewer.camera.heading;
    const minimapHeight = Cesium.Math.clamp(heightAboveGround * 4.0 + 600, 800, 30000);
    mm.miniMapCurrentRadiusMeters = minimapHeight * 0.55;

    let isMoving = false;
    let headingDelta = 0;
    if (miniMapLastCameraPosition !== null) {
      const distanceMoved = Cesium.Cartesian3.distance(cesiumViewer.camera.positionWC, miniMapLastCameraPosition);
      headingDelta = Math.abs(Cesium.Math.negativePiToPi(heading - miniMapLastHeading));
      const deltaSeconds = Math.max((timestampMs - miniMapLastSyncTimestamp) / 1000, 0.001);
      isMoving = distanceMoved > 2 || headingDelta > Cesium.Math.toRadians(1.5);
      if (isMoving) {
        const speed = distanceMoved / deltaSeconds;
        const proximityWeight = 1 / (1 + heightAboveGround / 350);
        const movementWeight = Math.min(3.5, 0.3 + speed / 18);
        const attentionAmount = proximityWeight * movementWeight * deltaSeconds;
        const radiusMeters = Cesium.Math.clamp(heightAboveGround * 0.85 + 20, 20, 900);
        mm.addAttentionAt(lonDeg, latDeg, radiusMeters, attentionAmount);
      }
    }

    const renderIntervalMs = isMoving ? MINIMAP_RENDER_INTERVAL_MOVING_MS : MINIMAP_RENDER_INTERVAL_IDLE_MS;
    const shouldRenderFrame =
      timestampMs - miniMapLastRenderAt >= renderIntervalMs ||
      headingDelta > Cesium.Math.toRadians(0.25);
    const attentionIntervalMs = isMoving
      ? MINIMAP_ATTENTION_RENDER_INTERVAL_MS
      : MINIMAP_ATTENTION_RENDER_INTERVAL_MS * 2;
    const shouldRenderAttention = timestampMs - miniMapLastAttentionRenderAt >= attentionIntervalMs;
    const shouldSyncLabels = timestampMs - miniMapLastLabelSyncAt >= MINIMAP_LABEL_SYNC_INTERVAL_MS;

    if (shouldRenderAttention) {
      mm.renderMiniMapAttention(lonDeg, latDeg);
      miniMapLastAttentionRenderAt = timestampMs;
    }

    if (shouldSyncLabels) {
      syncMiniMapLabels();
      miniMapLastLabelSyncAt = timestampMs;
    }

    if (shouldRenderFrame) {
      const center = ol.proj.fromLonLat([lonDeg, latDeg]);
      const zoom = Cesium.Math.clamp(17 - Math.log2(Math.max(200, minimapHeight) / 75) + mm.miniMapZoomOffset, 3, 18);
      mm.miniMapView.setCenter(center);
      mm.miniMapView.setRotation(-heading);
      mm.miniMapView.setZoom(zoom);
      mm.miniMapCenterFeature.getGeometry().setCoordinates(center);
      miniMapLastRenderAt = timestampMs;
    }
    // throttled inside: returns at once unless ~120 ms passed and the camera moved
    if (window._minimapView) window._minimapView.update(timestampMs, heightAboveGround, heading);

    mm.saveAttentionGrid(false);
    miniMapLastCameraPosition = Cesium.Cartesian3.clone(cesiumViewer.camera.positionWC, miniMapLastCameraPosition || new Cesium.Cartesian3());
    miniMapLastHeading = heading;
    miniMapLastSyncTimestamp = timestampMs;
  }

  return { syncMiniMapFrame, sampleHeightAboveGround, _globeGroundNow };
}
