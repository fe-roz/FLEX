// The per-frame loop: SpaceMouse, session camera save, Cesium render, readouts, minimap frame,
// Cesium -> Potree camera sync, Potree update + render, incidence lines, compass, labels, measure.
// Moved out of flex.js unchanged (flex.js split, wave 3; see client/src/README.md).
//
// Pure:  potreeCameraHeight(height, latRad, viewModel), potreeFovDegrees(fov, fovy, aspect),
//        incidenceRefreshDue(state, distSq, elapsed)
// Setup: setupRenderLoop({ Cesium, cesiumViewer, potreeViewer, viewModel, flags, ellipsoid, spaceMouse,
//          onCameraFrame, getFlyMultiplier, syncMiniMapFrame, incidenceState, updateIncidenceLines,
//          updateNorthCompass, updateHtmlLabels, updateMeasureDisplay }) -> { loop }
// flex.js starts it with requestAnimationFrame(loop) where it always did.

// Camera Z correction mirrors the point cloud matrix: pcZscale is needed whenever
// the cloud matrix uses it (usgsRef or egm96 ON). Original OFF mode uses scale=1 on
// the cloud, so the camera height is also left uncorrected for consistency.
export function potreeCameraHeight(height, latRad, viewModel) {
  if (viewModel.usgsRef || viewModel.egm96) return height / Math.cos(latRad);
  return height;
}

// Potree's vertical FOV in degrees from Cesium's frustum: portrait uses fov, landscape fovy.
export function potreeFovDegrees(fov, fovy, aspect) {
  return aspect < 1 ? (180 * fov) / Math.PI : (180 * fovy) / Math.PI;
}

// Incidence lines refresh when asked, or when the camera moved past the distance and the minimum interval passed.
export function incidenceRefreshDue(st, distSq, elapsed) {
  return !!(st.needsRefresh || (distSq > st.refreshDistSq && elapsed > st.minRefreshInterval));
}

export function setupRenderLoop({
  Cesium, cesiumViewer, potreeViewer, viewModel, flags, ellipsoid, spaceMouse: _spaceMouse,
  onCameraFrame, getFlyMultiplier, syncMiniMapFrame, incidenceState, updateIncidenceLines,
  updateNorthCompass, updateHtmlLabels, updateMeasureDisplay,
}) {
// perf-probe.js (the Performance panel's frame timing): frame() at the top, lap(stage) after each stage, end() at the bottom.
const NOP = () => {};
const PR = window._perfProbe || { frame: NOP, lap: NOP, end: NOP, wrapBegin: NOP, wrapEnd: NOP };
function loop(timestamp){
  requestAnimationFrame(loop);
  PR.frame(timestamp);
  if (_spaceMouse) _spaceMouse.update(timestamp);
  onCameraFrame();
  PR.lap('own');

  // (LOD update + render happen at the end of this function, after the
  //  camera sync - see potreeViewer.update below.)

  cesiumViewer.resize();
  // potreeViewer.resize();

  PR.wrapBegin(0);
  if (viewModel.cesiumRender) {
    cesiumViewer.render();
  }
  PR.wrapEnd(0);
  PR.lap('cesium');

  // World frame: camera.position / .direction are relative to the camera's reference frame,
  // which is not the world while Cesium tracks an entity (double-click on a point) - the
  // minimap, the coordinates and the Potree sync then pointed somewhere else entirely.
  let cCamPosCart = ellipsoid.cartesianToCartographic(cesiumViewer.camera.positionWC);

  let cCamLong = cCamPosCart.longitude * (180 / Math.PI);
  let cCamLat = cCamPosCart.latitude * (180 / Math.PI);
  let cCamHeight = cCamPosCart.height;
  let coords = cCamLat.toFixed(5) + ", " + cCamLong.toFixed(5);
  document.getElementById("coord_display").innerText = coords;
  document.getElementById("elev_display").innerText = "Height: " + cCamHeight.toFixed(0) + "m" +
    (flags.Fly ? "  ·  fly ×" + +getFlyMultiplier().toPrecision(2) : "");
  PR.lap('own');
  syncMiniMapFrame(timestamp, cCamPosCart);
  PR.lap('minimap');

  if(window.toScene !== undefined){
    // do fun proj4 stuff with camera settings
    let cCamCenterObject = new Cesium.Cartesian3;
    // A copy: scaling camera.direction itself stretched the camera's own vector every frame.
    let cCamDir = Cesium.Cartesian3.multiplyByScalar(cesiumViewer.camera.directionWC, 1000, new Cesium.Cartesian3());
    Cesium.Cartesian3.add(cesiumViewer.camera.positionWC, cCamDir, cCamCenterObject);

    let cCamCenterObjectPosCart = ellipsoid.cartesianToCartographic(cCamCenterObject);

    let cCamCenterObjectLong = cCamCenterObjectPosCart.longitude * (180 / Math.PI);
    let cCamCenterObjectLat = cCamCenterObjectPosCart.latitude * (180 / Math.PI);
    let cCamCenterObjectHeight = cCamCenterObjectPosCart.height;

    let cCamHeightCorrected = potreeCameraHeight(cCamHeight, cCamPosCart.latitude, viewModel);
    let pCamPos = toScene.forward([cCamLong, cCamLat, cCamHeightCorrected]);

    let pCamCenterObjectPos = toScene.forward([cCamCenterObjectLong, cCamCenterObjectLat, cCamCenterObjectHeight]);

    potreeViewer.scene.view.setView(
      [pCamPos[0],pCamPos[1],pCamPos[2]],
      [pCamCenterObjectPos[0],pCamCenterObjectPos[1],pCamCenterObjectPos[2]],
    );
    potreeViewer.scene.view.pitch = cesiumViewer.camera.pitch;

    let fov = cesiumViewer.camera.frustum.fov;
    let fovy = cesiumViewer.camera.frustum.fovy;
    let aspect = cesiumViewer.camera.frustum.aspectRatio;

    potreeViewer.setFOV(potreeFovDegrees(fov, fovy, aspect));
  }

  // Now that the Cesium camera has been synced onto the Potree camera, decide
  // LOD and draw. Order matters: update() is what runs updateVisibility, so it
  // has to see the camera we are about to render from.
  PR.lap('own');
  potreeViewer.update(potreeViewer.clock.getDelta(), timestamp);
  PR.lap('potreeUpdate');
  PR.wrapBegin(1);
  potreeViewer.render();
  PR.wrapEnd(1);
  PR.lap('potreeRender');

  // Update incidence angle lines when camera moves 50m+ (with 2s minimum interval)
  if (incidenceState.enabled) {
    const cam = potreeViewer.scene.getActiveCamera();
    const dSq = cam.position.distanceToSquared(incidenceState.lastCamPos);
    const elapsed = performance.now() - incidenceState.lastRefreshTime;
    if (incidenceRefreshDue(incidenceState, dSq, elapsed)) {
      incidenceState.needsRefresh = false;
      incidenceState.lastCamPos.copy(cam.position);
      updateIncidenceLines();
    }
  }
  PR.lap('incidence');

  updateNorthCompass();
  PR.lap('compass');
  updateHtmlLabels();
  PR.lap('labels');
  updateMeasureDisplay();
  PR.lap('measure');
  PR.end();
}
return { loop };
}
