// The Cesium viewer: creation and options, camera field of view, InfoBox sandbox,
// globe and scene settings (translucency, collision, camera controller), the optional
// photorealistic 3D tileset, and activation of the imagery layers (saved session or
// first-run defaults).
// Moved out of flex.js unchanged (flex.js split, wave 3; see client/src/README.md).
//
// Pure:  cesiumViewerOptions(Cesium, terrainProvider), DEFAULT_LAYERS, GLOBE_TRANSLUCENCY
// Setup (Cesium passed in, never imported):
//   setupCesiumViewer({ Cesium, terrainProvider })              -> viewer  (also window.cesiumViewer)
//   setupInfoBox({ cesiumViewer })
//   setupCesiumScene({ Cesium, cesiumViewer })                  -> { scene, canvas, ellipsoid }
//   setupCameraController({ cesiumViewer })                     (called just before cesium-interactions)
//   addPhotorealisticTileset({ Cesium, cesiumViewer })          (async; never throws)
//   setupLayerActivation({ Cesium, viewModel, layersReady, savedSession, addCatalogLayer,
//     subscribeLayerToSession, renderLayerList, saveSession, potreeViewer, applyPcMatrix,
//     getCaveImports, caveColourChanged })
// terrainProvider is made in flex.js (`await Cesium.createWorldTerrainAsync()` stays there:
// the browser tests rewrite that exact text to a flat terrain).

// Options for new Cesium.Viewer; the render loop is ours (render-loop.js).
export function cesiumViewerOptions(Cesium, terrainProvider) {
  return {
    useDefaultRenderLoop: false,
    terrainProvider,
    animation: false,
    baseLayerPicker: false,
    timeline: false,
    navigationHelpButton: false,
    terrainShadows: Cesium.ShadowMode.DISABLED,
  };
}

// Globe translucency: front faces fade in between 400 m and 1000 m (near 0.7, far 1).
export const GLOBE_TRANSLUCENCY = { nearDistance: 400.0, nearAlpha: 0.0, farDistance: 1000.0, farAlpha: 1.0, nearValue: 0.7, farValue: 1 };

// First-run layer stack (bottom -> top). Only OSM is visible; the others are in the list but off.
export const DEFAULT_LAYERS = [
  { name: 'Bing Maps Aerial', show: false, alpha: 1.0 },
  { name: 'NGMDB Mosaic',     show: false, alpha: 1.0 },
  { name: 'Slope Angle',      show: false, alpha: 1.0 },
  { name: 'OpenStreetMaps',   show: true,  alpha: 1.0 },
];

export function setupCesiumViewer({ Cesium, terrainProvider }) {
  window.cesiumViewer = new Cesium.Viewer('cesiumContainer', cesiumViewerOptions(Cesium, terrainProvider));
  window.cesiumViewer.camera.frustum.fov = (90*Cesium.Math.PI)/180;
  return window.cesiumViewer;
}

// Cesium's InfoBox uses a sandboxed iframe that blocks scripts by default.
// Remove the sandbox entirely so entity description HTML renders correctly.
export function setupInfoBox({ cesiumViewer }) {
  const infoBoxFrame = cesiumViewer.infoBox?.frame;
  if (infoBoxFrame) {
    infoBoxFrame.removeAttribute("sandbox");
  }
}

// Scene/globe settings and the canvas focus.
export function setupCesiumScene({ Cesium, cesiumViewer }) {
  const scene = cesiumViewer.scene;
  scene.screenSpaceCameraController.enableCollisionDetection = false;
  const canvas = cesiumViewer.canvas;
  canvas.setAttribute("tabindex", "0"); // needed to put focus on the canvas
  canvas.onclick = function () {
    canvas.focus();
  };
  const ellipsoid = scene.globe.ellipsoid;
  const T = GLOBE_TRANSLUCENCY;
  scene.globe.translucency.enabled = true;
  scene.globe.translucency.frontFaceAlphaByDistance = new Cesium.NearFarScalar(
    T.nearDistance, T.nearAlpha, T.farDistance, T.farAlpha);
  scene.globe.translucency.frontFaceAlphaByDistance.nearValue = T.nearValue;
  scene.globe.translucency.frontFaceAlphaByDistance.farValue = T.farValue;
  return { scene, canvas, ellipsoid };
}

// Disable the default event handlers except translate/zoom/tilt/look (rotate is ours).
export function setupCameraController({ cesiumViewer }) {
  const scene = cesiumViewer.scene;
  scene.screenSpaceCameraController.enableRotate = false;
  scene.screenSpaceCameraController.enableTranslate = true;
  scene.screenSpaceCameraController.enableZoom = true;
  scene.screenSpaceCameraController.enableTilt = true;
  scene.screenSpaceCameraController.enableLook = true;
}

// Google photorealistic 3D tiles, added hidden (primitives[0]); the "Google Maps" switch shows it.
export async function addPhotorealisticTileset({ Cesium, cesiumViewer }) {
  try {
    const tileset = await Cesium.createGooglePhotorealistic3DTileset();
    cesiumViewer.scene.primitives.add(tileset);
    cesiumViewer.scene.primitives._primitives[0].show = false;
  } catch (error) {
    console.log(`Error creating tileset: ${error}`);
  }
}

// Activate layers - either from the saved session or the first-run defaults.
// loadLayers() only strips Cesium's built-in layer and builds the catalog; it adds
// nothing to the scene. We add layers here so the session controls exactly which catalog
// entries are in the active stack.
export function setupLayerActivation({
  Cesium, viewModel, layersReady, savedSession, addCatalogLayer, subscribeLayerToSession, renderLayerList,
  saveSession, potreeViewer, applyPcMatrix, getCaveImports, caveColourChanged,
}) {
  layersReady.then(async () => {
    const savedLayers = savedSession?.layers?.layers;

    if (savedLayers?.length) {
      // Session exists: re-add saved layers.  They're stored top->bottom in
      // viewModel order, so add in reverse so index-0 ends up on top.
      for (let i = savedLayers.length - 1; i >= 0; i--) {
        const { name, show, alpha } = savedLayers[i];
        const layer = await addCatalogLayer(name, show, alpha);
        if (layer) subscribeLayerToSession(layer);
      }
      if (savedSession.layers.usgsRef !== undefined) {
        viewModel.usgsRef = savedSession.layers.usgsRef;
      }
    } else {
      // No session: add the default active layers (bottom -> top order).
      for (const d of DEFAULT_LAYERS) {
        const layer = await addCatalogLayer(d.name, d.show, d.alpha);
        if (layer) subscribeLayerToSession(layer);
      }
    }

    // Subscribe viewModel-level settings that should persist + live-update loaded clouds
    ['usgsRef', 'egm96'].forEach(key => {
      Cesium.knockout.getObservable(viewModel, key).subscribe(() => {
        saveSession();
        potreeViewer.scene.pointclouds.forEach(applyPcMatrix);
        // Caves follow the point clouds' datum shift (_pcDatumDz).
        getCaveImports().forEach((imp, i) => { if (imp.georef) window._rerenderCave(i); });
        caveColourChanged();
      });
    });

    renderLayerList();
  });
}
