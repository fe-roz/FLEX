import * as THREE from "./PotreeCopied/libs/three.js/build/three.module.js";
import { meanSeaLevel } from 'https://esm.sh/egm96-universal@1.1.1';

import "../Tokens.js";

import {
  getBackendBaseUrl,
  toAbsoluteUrl,
  workflowState,
  backendApi,
  setText,
  appendWorkflowLog,
  setWorkflowActionStatus,
  setWorkflowBusy,
  registerUpdateWorkflowButtons
} from "./client/src/modules/api.js";

import { viewModel, loadLayers, updateLayerList, LAYER_CATALOG, addCatalogLayer, removeCatalogLayer } from "./client/src/modules/layers.js";
import { initializeContextMenu } from "./client/src/modules/context-menu.js";
import {
  initSession, notifyPcLoaded, notifyCaltopoChanged, saveSession, loadSession,
  restoreCamera, restoreLayerState, onCameraFrame,
  notifyDataFilesChanged, notifyCaveVisibilityChanged, notifyPoiVisibilityChanged,
  notifyPanelSectionToggled, notifyPointBudgetChanged,
  notifySearchPinsChanged,
} from "./client/src/modules/session.js";
import { initSpaceMouse } from "./client/src/modules/spacemouse.js";
import { breakoutToPlt, isBreakoutFile } from "./client/src/modules/breakout.js";
import { readWallsShapefileSets, wallsToPlt, isWallsSelection } from "./client/src/modules/walls.js";
import { parsePLT, utmToLatLon, setupCompassPlt } from "./client/src/modules/compass-plt.js";
import { rampColor, rampRgb, rampCss, percentileRange, lazyPick, materialize, installLazyPick,
         addLinePrimitive, addStationLayer, removePrimitive,
         lrudWH, steepScore, whRgb, wallHardRgb, hardLegendRows, HARD_UNKNOWN } from "./client/src/modules/cave-layers.js";
import { levelFrame, planGroundGrid, pushFootLine, sampleGroundGrid, gridCovers, depthBelowGround,
         binLidarGround, mergeLidarGround, gridFromLidar } from "./client/src/modules/cave-ground.js";

// A line icon (icons.js) in front of a label in HTML built here: `${_ic('pin')}Label`.
const _ic = name => (window.icon ? window.icon(name, '1.15em', 'ico-l') : '');

import { setupWorkflowPanel } from "./client/src/modules/workflow-panel.js";

// Moved to client/src/modules/cesium-viewer.js: creates window.cesiumViewer (options, 90 degree FOV). The world
// terrain call stays here as text: the browser tests rewrite it to a flat terrain.
setupCesiumViewer({ Cesium, terrainProvider: await Cesium.createWorldTerrainAsync() });

// Restore camera from last session immediately (before anything else moves the camera)
const _savedSession = loadSession();
if (_savedSession) restoreCamera(_savedSession, cesiumViewer);

setupInfoBox({ cesiumViewer });   // cesium-viewer.js: drops the InfoBox iframe sandbox

// Moved to client/src/modules/workflow-panel.js (wave 4): AOI drawing, server connection, queue, workflow panel.
// Set up as soon as cesiumViewer exists (selection-monitor below and the Escape key reach into it);
// loadBackendCatalog is set up later, hence the lazy wrapper.
const { initWorkflowPanel, updateWorkflowButtons, stopAoiDrawMode, stopWorkflowPolling, refreshServerMonitor,
        onWorkflowEntitySelected, hideProcessAreaLayer, updateWorkflowSelectionLabels, updateWorkflowPanelVisibility,
        updateStatusCards } = setupWorkflowPanel({
  Cesium, cesiumViewer, workflowState, backendApi, setText, appendWorkflowLog, setWorkflowActionStatus,
  setWorkflowBusy, registerUpdateWorkflowButtons, loadBackendCatalog: (...a) => loadBackendCatalog(...a),
});

import { setupCesiumViewer, setupInfoBox, setupCesiumScene, setupCameraController, addPhotorealisticTileset,
         setupLayerActivation } from "./client/src/modules/cesium-viewer.js";
import { setupPotreeViewer, createApplyPcMatrix } from "./client/src/modules/potree-viewer.js";
import { setupRenderLoop } from "./client/src/modules/render-loop.js";
import { setupSessionRestore } from "./client/src/modules/session-restore.js";
import { setupSceneControls } from "./client/src/modules/scene-controls.js";
import { setupSearchPins } from "./client/src/modules/search-pins.js";
import { setupSelectionMonitor } from "./client/src/modules/selection-monitor.js";
import { setupUpdateChecker } from "./client/src/modules/update-checker.js";
import { setupPoiList } from "./client/src/modules/poi-list.js";
import { setupWorkspaceHooks } from "./client/src/modules/workspace-hooks.js";
import { setupMeasureMode } from "./client/src/modules/measure-mode.js";
import { setupHtmlLabels } from "./client/src/modules/html-labels.js";
// Moved to client/src/modules/search-pins.js: search pins (geocoder result -> pin + fly-in), window._clearSearchPins.
const { escapeHtml: _escapeHtml } = setupSearchPins({ Cesium, cesiumViewer, savedSession: _savedSession, notifySearchPinsChanged });
// Moved to client/src/modules/poi-list.js (called here, earlier than its old line: renderPoiList is reached from
// callbacks that can run before it).
const { renderPoiList } = setupPoiList({ Cesium, cesiumViewer, downloadBlob });

// Moved to client/src/modules/selection-monitor.js: the floating "Add Point Cloud" button and the
// 100 ms watcher of the selected entity.
setupSelectionMonitor({
  cesiumViewer, workflowState, ic: _ic, onWorkflowEntitySelected, hideProcessAreaLayer, stopWorkflowPolling,
  updateWorkflowSelectionLabels, updateWorkflowPanelVisibility, updateStatusCards, updateWorkflowButtons,
  refreshServerMonitor,
});

// Add fog at the distance so we don't see the other side of the world?
// Make a way to toggle this map.

await addPhotorealisticTileset({ Cesium, cesiumViewer });   // cesium-viewer.js (hidden until the Google Maps switch)


// CODE THAT WILL HELP ADD WAYPOINTS

//   cesiumViewer.infoBox.frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-forms allow-scripts allow-top-navigation');

//   cesiumViewer.selectedEntity = entity;

//   var entity = cesiumViewer.entities.add({
//     name : 'Point',
//     position : Cesium.Cartesian3.fromDegrees(-100, 50),
//     point : {
//           pixelSize : 10,
//           color : Cesium.Color.RED
//       }
//   });

//   cesiumViewer.infoBox.frame.addEventListener('load', function() {
//       cesiumViewer.infoBox.frame.contentDocument.body.addEventListener('click', function(e) {
//       if (e.target && e.target.className === 'click-test-button') {
//           var LatValue = cesiumViewer.infoBox.frame.contentDocument.getElementsByName("Latitude")[0].value;
//           var LongValue = cesiumViewer.infoBox.frame.contentDocument.getElementsByName("Longitude")[0].value;
//           alert(LatValue + "\n" + LongValue);
//           }
//       }, false);
//   }, false);

//   function getValues(event) {
//       var LatValue = document.getElementsByName('Latitude')[0].value;
//       var LongValue = document.getElementsByName('Longitude')[0].value;
//       alert(LatValue + "\n" + LongValue);
    
//   }

// entity.description = '\
//     Name: <input type="text" name="Name" id="Name" value="Name"><br>\
//     Latitude: <input type="text" name="Latitude" id="Latitude" value="50"><br>\
//     Longitude: <input type="text" name="Longitude" id="Longitude" value="50"><br>\
//     <div style="padding:15px"><button class="click-test-button">\
//     Click here</button></div>';

const flags = {
looking: false,
moveForward: false,
moveBackward: false,
moveUp: false,
moveDown: false,
moveLeft: false,
moveRight: false,
Fly: false,
Speed: false,
faster: false,
toggleOther: true,
toggleGround: true,
toggleVegetation: true,
toggleLowNoise: true,
toggleAll: true,
point: false,
downloadPoints: false,
hideCesium: false,
displayCave: false,
displayPC: false,

};

// pointCounter / creatingRoute / routePoints / currentEntity moved into cesium-interactions.js (its only user).

// Moved to client/src/modules/potree-viewer.js: ClassificationScheme, new Potree.Viewer and its settings;
// it sets window.potreeViewer (the bare name `potreeViewer` below and in earlier functions is that global).
setupPotreeViewer({ Potree, flags });


// Cave survey loaded on demand via #lp-cave-toggle in the Layers panel


Cesium.Math.setRandomNumberSeed(0);
// ── LiDAR footprints, backend catalog, OpenTopography, Data Files ─────────────
// Moved to client/src/modules/cesium-datasources.js (setupCesiumDatasources).
import { setupCesiumDatasources } from "./client/src/modules/cesium-datasources.js";
const { setLidarFootprintsVisible, setOtFootprintsVisible, loadBackendCatalog, _otHandleClick,
        loadedDataFiles, renderDataFileList, addDataFile, removeDataFile } = setupCesiumDatasources({
  Cesium, cesiumViewer, viewModel, ProxyUrlGenerator, getBackendBaseUrl, toAbsoluteUrl, notifyDataFilesChanged,
});



// cesium-viewer.js: collision off, canvas focus, globe translucency.
const { scene, canvas, ellipsoid } = setupCesiumScene({ Cesium, cesiumViewer });

// Cave survey globe-pick: intercept LEFT_CLICK when pick mode is active
{
  const cavePickHandler = new Cesium.ScreenSpaceEventHandler(canvas);
  cavePickHandler.setInputAction(function(click) {
    if (!_cavePickMode) return;
    _cavePickMode = false;
    const banner = document.getElementById('cave-pick-banner');
    if (banner) banner.style.display = 'none';
    document.getElementById('cave-wizard-overlay').style.display = 'flex';
    const resolve = _cavePickResolve;
    _cavePickResolve = null;
    if (!resolve) return;

    // scene.pickPosition fails when globe translucency is on — use ray/globe instead.
    // globe.pick returns the position on the actual rendered terrain surface.
    const ray = cesiumViewer.camera.getPickRay(click.position);
    let pos = ray ? cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene) : null;
    if (!pos || !Cesium.defined(pos)) {
      // Fallback: project onto smooth ellipsoid (no terrain elevation)
      pos = cesiumViewer.camera.pickEllipsoid(click.position, cesiumViewer.scene.globe.ellipsoid);
    }
    if (pos && Cesium.defined(pos)) {
      const carto = Cesium.Cartographic.fromCartesian(pos);
      resolve({
        lat:  Cesium.Math.toDegrees(carto.latitude),
        lon:  Cesium.Math.toDegrees(carto.longitude),
        elev: carto.height,
      });
    } else {
      resolve(null);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}


import { setupCompass } from "./client/src/modules/navigation-aids/compass.js";
import { setupMinimap } from "./client/src/modules/navigation-aids/minimap.js";
import { setupMinimapSync } from "./client/src/modules/navigation-aids/minimap-sync.js";

// The 3D north compass, the minimap and its per-frame sync live in
// client/src/modules/navigation-aids/ (compass.js, minimap.js, minimap-sync.js).
// miniMapMap / miniMapUserHidden / miniMapCaltopoSource are used further down
// (the CalTopo code, the toggle flag), so they stay here behind a get/set object.
let miniMapMap = null;
let miniMapUserHidden = false;
let miniMapCaltopoSource = null;
const miniMapState = {
  get miniMapMap() { return miniMapMap; },
  set miniMapMap(v) { miniMapMap = v; },
  get miniMapUserHidden() { return miniMapUserHidden; },
  set miniMapUserHidden(v) { miniMapUserHidden = v; },
  get miniMapCaltopoSource() { return miniMapCaltopoSource; },
  set miniMapCaltopoSource(v) { miniMapCaltopoSource = v; },
};
const { cycleCompassStyle, initNorthCompass, updateNorthCompass } = setupCompass({ Cesium, THREE, cesiumViewer, ellipsoid });
const miniMapApi = setupMinimap({ Cesium, ol, cesiumViewer, state: miniMapState });
const { initMiniMap, loadAttentionGrid, saveAttentionGrid, syncMinimapCaltopoFeatures } = miniMapApi;
const { syncMiniMapFrame, sampleHeightAboveGround, _globeGroundNow } = setupMinimapSync({ Cesium, ol, cesiumViewer, scene, state: miniMapState, mm: miniMapApi.shared });

Cesium.knockout.track(viewModel);
const _layersReady = loadLayers().catch((error) => console.error("Layer loading error:", error));
loadAttentionGrid();
initMiniMap();
initializeContextMenu({ Cesium, cesiumViewer });

// Init session system (wires auto-save triggers, exposes window._sessionSave)
initSession(cesiumViewer, viewModel);

// Moved to client/src/modules/potree-viewer.js (the Z matrix for the egm96 / usgsRef toggles).
const applyPcMatrix = createApplyPcMatrix({ viewModel, meanSeaLevel });

// Moved to client/src/modules/cesium-viewer.js: activate layers from the saved session or the first-run defaults.
// subscribeLayerToSession / renderLayerList are set up later (layer-list.js); the callback runs after layers load.
setupLayerActivation({
  Cesium, viewModel, layersReady: _layersReady, savedSession: _savedSession, addCatalogLayer,
  subscribeLayerToSession: (...a) => subscribeLayerToSession(...a), renderLayerList: (...a) => renderLayerList(...a),
  saveSession, potreeViewer, applyPcMatrix, getCaveImports: () => _caveImports, caveColourChanged: (...a) => _caveColourChanged(...a),
});

// Moved to client/src/modules/session-restore.js: the setTimeout(0) restore of point clouds, CalTopo, data files,
// My data points, cave / POI visibility and panel sections. It stays at this position so the timer is queued at the
// same point; the functions it calls are defined further down, hence the lazy wrappers.
setupSessionRestore({
  Cesium, cesiumViewer, savedSession: _savedSession,
  showPcRestorePrompt: (...a) => showPcRestorePrompt(...a), showCaltopoLoggedIn: (...a) => _showCaltopoLoggedIn(...a),
  getCaltopoState: () => caltopoState, fetchCaltopoKml: (...a) => _fetchCaltopoKml(...a),
  loadCaltopoKml: (...a) => loadCaltopoKml(...a), addDataFile: (...a) => addDataFile(...a),
  renderPoiList: (...a) => renderPoiList(...a), setCaveSurveyVisible: (...a) => setCaveSurveyVisible(...a),
});
window.addEventListener("beforeunload", () => {
  saveSession();
  saveAttentionGrid(true);
  stopWorkflowPolling();
  if (workflowState.serverMonitorTimer) {
    clearInterval(workflowState.serverMonitorTimer);
    workflowState.serverMonitorTimer = null;
  }
  stopAoiDrawMode("AOI draw mode ended.");
});
initWorkflowPanel();

// Moved to client/src/modules/update-checker.js (window._checkForUpdates).
setupUpdateChecker();
import { setupPotreePointcloud } from "./client/src/modules/potree-pointcloud.js";
import { setupPointcloudIncidence } from "./client/src/modules/pointcloud-incidence.js";
import { setupPointcloudHag } from "./client/src/modules/pointcloud-hag.js";
import { setupEntwineLocal } from "./client/src/modules/entwine-local.js";

// addPC, the addPC interceptor (tracks loaded URLs), the restore banner and the
// Point Cloud list moved to client/src/modules/potree-pointcloud.js (flex.js split, wave 2).
const { renderPcList, removePc, showPcRestorePrompt, pcUrlByName: _pcUrlByName } = setupPotreePointcloud({
  THREE, Potree, proj4, potreeViewer, viewModel, applyPcMatrix, notifyPcLoaded, saveSession,
});

// ── CalTopo KML Network Link ──────────────────────────────────────────────────
// Moved to client/src/modules/caltopo-map.js (the map link, its JSON -> entities,
// status row, key and bookmarklet login). The Layers panel header (_lpToggle) is in layer-list.js.
import { setupCaltopoMap } from "./client/src/modules/caltopo-map.js";
const { caltopoState, loadCaltopoKml, clearCaltopo, renderCaltopoStatus, _fetchCaltopoKml, _showCaltopoLoggedIn } = setupCaltopoMap({
  Cesium, cesiumViewer, ProxyUrlGenerator, ic: _ic, notifyCaltopoChanged,
  miniMapState, syncMinimapCaltopoFeatures,
});

// ── Point Cloud list ──────────────────────────────────────────────────────────
// renderPcList / removePc moved to client/src/modules/potree-pointcloud.js (flex.js split, wave 2).
window._renderPcList = renderPcList;

// ── Data Files list ───────────────────────────────────────────────────────────
// Moved to client/src/modules/cesium-datasources.js (set up at "LiDAR footprints" above).

// Moved to client/src/modules/poi-list.js (renderPoiList, window._exportPoi); set up early, at "Search pins" above,
// because renderPoiList is reached from callbacks that can run before this line.
// ── CalTopo status row ────────────────────────────────────────────────────────
// Moved to client/src/modules/caltopo-map.js (renderCaltopoStatus).

import { setupCaveImport } from "./client/src/modules/cave-import.js";
import { setupCaveGeoref, computeWarpedOffset as _computeWarpedOffset } from "./client/src/modules/cave-georef.js";
// ── Cave Survey ───────────────────────────────────────────────────────────────
// Moved to client/src/modules/cave-import.js: recents (EPT + PLT), cave sets,
// loading a survey (wizard, Walls, Breakout), replace survey, globe pick,
// anchored / UTM render. This file keeps the shared state and the wiring.
//
// Each imported survey is stored as:
//   { name, parsed, entities: Cesium.EntityCollection-like[], visible: true }
// Entities are added directly to cesiumViewer.entities (not a DataSource)
// so we have fine-grained control over each polyline / point.

let _caveImports = [];       // Array of { name, parsed, cesiumIds, visible }
// flex.js is an ES module, so its top-level names are invisible to the inline
// scripts in index.html — the export collector reads the cave list (LRUDs,
// survey names, passage walls) through this window reference. The array is
// only ever mutated in place, never reassigned, so the reference stays valid.
window._caveImports = _caveImports;
let _cwizParsed  = null;     // Holds last-parsed PLT data while wizard is open
let _recents = { ept: [], plt: [], pltSets: [] };   // pltSets: saved selections of caves
let _cavePickMode = false;   // globe pick (cave-import.js; the canvas click handler near the top reads these)
let _cavePickResolve = null;
const caveImportState = {
  get recents() { return _recents; },               set recents(v) { _recents = v; },
  get cwizParsed() { return _cwizParsed; },         set cwizParsed(v) { _cwizParsed = v; },
  get cavePickMode() { return _cavePickMode; },     set cavePickMode(v) { _cavePickMode = v; },
  get cavePickResolve() { return _cavePickResolve; }, set cavePickResolve(v) { _cavePickResolve = v; },
};
const {
  addPltRecent: _addPltRecent, fetchPltCache: _fetchPltCache, finishCaveLoad: _finishCaveLoad,
  placeCave: _placeCave, initPltRestoreInput: _initPltRestoreInput, loadRecents: _loadRecents,
  removePltRecent: _removePltRecent, startGlobePick: _startGlobePick, displayUpdateRecent: _displayUpdateRecent,
} = setupCaveImport({
  Cesium, cesiumViewer, viewModel, caveImports: _caveImports, state: caveImportState,
  isWallsSelection, readWallsShapefileSets, wallsToPlt, isBreakoutFile, breakoutToPlt,
  caveColourChanged: (...a) => _caveColourChanged(...a), notifyCaveVisibilityChanged,
  rerenderCave: (...a) => window._rerenderCave(...a), renderCaveList: () => _renderCaveList(),
  defaultDisplayOptions: (...a) => _defaultDisplayOptions(...a), escapeHtml: (...a) => _escapeHtml(...a), icon: (...a) => _ic(...a),
});


// Moved to client/src/modules/workspace-hooks.js: window._ws (workspace hooks for projects) and _caveGeometry.
setupWorkspaceHooks({
  Cesium, cesiumViewer, viewModel, parsePLT, restoreCamera, restoreLayerState, state: caveImportState,
  _caveImports, _pcUrlByName, caltopoState, loadedDataFiles, _placeCave, _finishCaveLoad, removePc,
  loadCaltopoKml, clearCaltopo, renderDataFileList, addDataFile, removeDataFile, _fetchPltCache,
  _addPltRecent, _removePltRecent, _caveUtmConvertFn,
});
// ── Compass PLT: parser, UTM → WGS84, PLT → Cartesian3 ───────────────────────
// Moved to client/src/modules/compass-plt.js (parsePLT and utmToLatLon are imported
// at the top). _pltToCartesian has no callers today; the binding is kept as before.
const { pltToCartesian: _pltToCartesian } = setupCompassPlt({ Cesium });

import { setupCaveUtm } from "./client/src/modules/cave-utm.js";
import { setupCaveDepth } from "./client/src/modules/cave-depth.js";
import { setupCavePassages } from "./client/src/modules/cave-passages.js";
import { setupCaveLeadsLabels } from "./client/src/modules/cave-leads-labels.js";
import { setupCaveDisplay, defaultDisplayOptions as _defaultDisplayOptions, CAVE_COLOUR_MODES } from "./client/src/modules/cave-display.js";
import { setupCaveStylePanel } from "./client/src/modules/cave-style-panel.js";

// ── Cave list, drawing, passage walls, leads, area labels, colour by, depth ──
// Moved to client/src/modules/cave-{display,passages,leads-labels,depth,utm}.js
// (flex.js split, wave 1). Set up in this order; the lazy wrappers reach the
// modules set up after them.

// The "colour by" mode stays here: cave-display, cave-passages and cave-depth read
// and write it through caveColourState.
let _caveColourMode = (() => {
  try { const m = localStorage.getItem('flex.caveColour'); return CAVE_COLOUR_MODES.includes(m) ? m : 'survey'; }
  catch (_) { return 'survey'; }
})();
const caveColourState = {
  get colourMode() { return _caveColourMode; },
  set colourMode(v) { _caveColourMode = v; },
};

const caveUtm = setupCaveUtm({
  Cesium, viewModel, meanSeaLevel, utmToLatLon,
  computeWarpedOffset: (...a) => _computeWarpedOffset(...a),     // georectification (later in this file)
});
const caveDepth = setupCaveDepth({
  Cesium, cesiumViewer, viewModel, state: caveColourState, caveImports: _caveImports,
  caveColourChanged: (...a) => caveDisplay.caveColourChanged(...a),
  renderCaveColourUI: (...a) => caveDisplay.renderCaveColourUI(...a),
  levelFrame, planGroundGrid, pushFootLine, sampleGroundGrid, gridCovers,
  binLidarGround, mergeLidarGround, gridFromLidar,
});
const cavePassages = setupCavePassages({
  Cesium, cesiumViewer, state: caveColourState, defaultDisplayOptions: _defaultDisplayOptions,
  caveColourRgb: (...a) => caveDisplay.caveColourRgb(...a),
  lrudWH, steepScore, wallHardRgb, HARD_UNKNOWN,
});
const caveLeadsLabels = setupCaveLeadsLabels({
  Cesium, cesiumViewer, caveImports: _caveImports, ic: _ic, escapeHtml: _escapeHtml,
  renderCaveList: (...a) => caveDisplay.renderCaveList(...a),
  setCaveLayersVisible: (...a) => caveDisplay.setCaveLayersVisible(...a),
  displayUpdateRecent: (...a) => _displayUpdateRecent(...a),     // cave import (later in this file)
});
const caveDisplay = setupCaveDisplay({
  Cesium, cesiumViewer, state: caveColourState, caveImports: _caveImports,
  ic: _ic, startGlobePick: (...a) => _startGlobePick(...a), notifyCaveVisibilityChanged,
  installLazyPick, lazyPick, addLinePrimitive, addStationLayer, removePrimitive,
  rampRgb, rampCss, percentileRange, lrudWH, steepScore, whRgb, hardLegendRows, depthBelowGround,
  pcDatumDz: caveUtm.pcDatumDz, caveUtmConvertFn: caveUtm.caveUtmConvertFn,
  computeWarpedOffset: (...a) => _computeWarpedOffset(...a),
  buildCavePassages: cavePassages.buildCavePassages, removeCavePassages: cavePassages.removeCavePassages,
  setCavePassageVisible: cavePassages.setCavePassageVisible,
  caveStationPts: caveDepth.caveStationPts, caveFrame: caveDepth.caveFrame,
  caveGroundValid: caveDepth.caveGroundValid, caveGround: caveDepth.caveGround,
  loadedClouds: caveDepth.loadedClouds, lidar: caveDepth.lidar,
  isLeadEntity: caveLeadsLabels.isLeadEntity, isAreaLabelEntity: caveLeadsLabels.isAreaLabelEntity,
  areaLabelsShown: caveLeadsLabels.areaLabelsShown, leadsVisible: caveLeadsLabels.leadsVisible,
  areaLabelsVisible: caveLeadsLabels.areaLabelsVisible, caveAreaLabelList: caveLeadsLabels.caveAreaLabelList,
  addCaveLeads: caveLeadsLabels.addCaveLeads, addCaveAreaLabels: caveLeadsLabels.addCaveAreaLabels,
});

// Hoisted forwarders for the five functions the rest of this file calls (they used
// to be function declarations; code that runs before this point, or passes them
// into a setup call earlier in the file, still finds them).
function setCaveSurveyVisible(...a) { return caveDisplay.setCaveSurveyVisible(...a); }
function _renderCaveList(...a) { return caveDisplay.renderCaveList(...a); }
function _buildCaveStations(...a) { return caveDisplay.buildCaveStations(...a); }
function _caveColourChanged(...a) { return caveDisplay.caveColourChanged(...a); }
function _caveUtmConvertFn(...a) { return caveUtm.caveUtmConvertFn(...a); }

// ── Globe pick mode, cave render (anchor / UTM), Wizard UI ───────────────────
// Moved to client/src/modules/cave-import.js (setupCaveImport, called at "Cave Survey" above).


// ── Overlay drag-and-drop, Layer list, CalTopo login ─────────────────────────
// The layer list moved to client/src/modules/layer-list.js; the CalTopo key and
// bookmarklet login to client/src/modules/caltopo-map.js (set up at "CalTopo KML Network Link").
import { setupLayerList } from "./client/src/modules/layer-list.js";
const { subscribeLayerToSession, renderLayerList } = setupLayerList({
  Cesium, viewModel, LAYER_CATALOG, addCatalogLayer, removeCatalogLayer,
  updateLayerList, saveSession, notifyPanelSectionToggled,
});

const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

// Init layers panel interactivity (after Knockout owns the DOM)
renderPcList();
renderDataFileList();
renderCaltopoStatus();
renderPoiList();

// Moved to client/src/modules/scene-controls.js: cave toggle, Scene checkboxes, Point Budget / Detail / Load range / Far
// cutoff, and the footprint / Google tiles visibility subscribers.
setupSceneControls({
  Cesium, cesiumViewer, viewModel, flags, Potree, potreeViewer, savedSession: _savedSession,
  setCaveSurveyVisible, setLidarFootprintsVisible, setOtFootprintsVisible, notifyPointBudgetChanged,
});

// disable the default event handlers
setupCameraController({ cesiumViewer });   // cesium-viewer.js: built-in rotate off, translate / zoom / tilt / look on

import { setupCesiumInteractions, downloadBlob } from "./client/src/modules/cesium-interactions.js";
// Moved to client/src/modules/cesium-interactions.js: camera mouse buttons, SpaceMouse init, input handler,
// fly speed, key flags (keydown/keyup), touch fly and the fly tick. The minimap variables stay here.
const interactionState = {
  get miniMapUserHidden() { return miniMapUserHidden; }, set miniMapUserHidden(v) { miniMapUserHidden = v; },
  get miniMapMap() { return miniMapMap; },
};
const { handler, spaceMouse: _spaceMouse, getFlyMultiplier } = setupCesiumInteractions({
  Cesium, cesiumViewer, scene, canvas, flags, viewModel, potreeViewer, workflowState,
  state: interactionState,
  initSpaceMouse, sampleHeightAboveGround: (...a) => sampleHeightAboveGround(...a),
  otHandleClick: (...a) => _otHandleClick(...a),
  globeGroundNow: (...a) => _globeGroundNow(...a),
  stopAoiDrawMode: (...a) => stopAoiDrawMode(...a),
  renderPcList: (...a) => renderPcList(...a),
  renderPoiList: (...a) => renderPoiList(...a),
  cycleCompassStyle: (...a) => cycleCompassStyle(...a),
  toggleMeasureMode: (...a) => toggleMeasureMode(...a),
});

// ── Angle of Incidence Visualization ────────────────────────────────
// Moved to client/src/modules/pointcloud-incidence.js (flex.js split, wave 2); the
// render loop below reads incidenceState and calls updateIncidenceLines.
const { incidenceState, updateIncidenceLines } = setupPointcloudIncidence({ THREE, potreeViewer });

// Moved to client/src/modules/measure-mode.js (depth / distance measurement, V) and
// html-labels.js (screen-space label overlay); loop() calls the two update functions.
const { toggleMeasureMode, updateMeasureDisplay } = setupMeasureMode({ Cesium, cesiumViewer, ic: _ic });
const { updateHtmlLabels } = setupHtmlLabels({ Cesium, cesiumViewer, notifyPoiVisibilityChanged });
// Moved to client/src/modules/render-loop.js: the per-frame loop (Cesium render, Cesium -> Potree camera sync,
// Potree update + render, incidence / compass / labels / measure updates).
const { loop } = setupRenderLoop({
  Cesium, cesiumViewer, potreeViewer, viewModel, flags, ellipsoid, spaceMouse: _spaceMouse,
  onCameraFrame, getFlyMultiplier, syncMiniMapFrame, incidenceState, updateIncidenceLines,
  updateNorthCompass, updateHtmlLabels, updateMeasureDisplay,
});
initNorthCompass();

// ── Local Entwine server integration ─────────────────────────────────────────
// Moved to client/src/modules/entwine-local.js (flex.js split, wave 2); the
// window._entwine* hooks are defined there.
const { loadEntwineConfig: _loadEntwineConfig } = setupEntwineLocal({ ic: _ic });

_loadRecents();        // populate EPT + PLT recent lists
_initPltRestoreInput(); // wire the hidden PLT cache-miss file picker
_loadEntwineConfig();   // restore local Entwine server state

// ── Cave style panel, and one style setting for every loaded cave ────────────
// Moved to client/src/modules/cave-style-panel.js (flex.js split, wave 1).
setupCaveStylePanel({
  caveImports: _caveImports,
  buildCaveStations: (...a) => _buildCaveStations(...a),
  setCaveLayersVisible: (...a) => caveDisplay.setCaveLayersVisible(...a),
  displayUpdateRecent: (...a) => _displayUpdateRecent(...a),     // cave import (later in this file)
});

// ── Georectification and warp algorithm ──────────────────────────────────────
// Moved to client/src/modules/cave-georef.js (rectify panel, control points,
// warp maths); computeWarpedOffset is imported at the top of the cave-import section.
setupCaveGeoref({
  Cesium, cesiumViewer, viewModel, caveImports: _caveImports, materialize,
  addPltRecent: _addPltRecent, displayUpdateRecent: _displayUpdateRecent,
  rerenderCave: (...a) => window._rerenderCave(...a), renderCaveList: () => _renderCaveList(),
  caveColourChanged: (...a) => _caveColourChanged(...a), buildCaveStations: (...a) => _buildCaveStations(...a),
});

requestAnimationFrame(loop);


// ── Height-Above-Ground live filter ──────────────────────────────────────────
// Moved to client/src/modules/pointcloud-hag.js (flex.js split, wave 2); window._hag
// and the window._hag* hooks are defined there.
setupPointcloudHag({ potreeViewer });
