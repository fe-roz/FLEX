// Camera and keyboard interaction: mouse-button mapping, SpaceMouse init, the
// ScreenSpaceEventHandler inputs, fly speed, key flags, touch fly and the per-frame
// fly tick. Moved out of flex.js unchanged (the flex.js split, wave 1; see
// client/src/README.md for the pattern).
//
// Pure exports (no browser, no Cesium), node-testable:
//   getFlagForKeyCode(keyCode) -> flag name | undefined
//   isLatchedFlag(name)        -> true if key-up does NOT clear the flag (toggles)
//   clampFlyMult(m), FLY_MULT_MIN, FLY_MULT_MAX   (wheel speed multiplier, 0.1..64)
//   flySpeedMps(hag)           -> fly speed in m/s from height above ground
//   downloadBlob(filename, blob)   (browser helper; uses document only when called)
// Setup (Cesium passed in, never imported):
//   setupCesiumInteractions({ Cesium, cesiumViewer, scene, canvas, flags, viewModel, potreeViewer,
//     workflowState, state, initSpaceMouse, sampleHeightAboveGround, otHandleClick, globeGroundNow,
//     stopAoiDrawMode, renderPcList, renderPoiList, cycleCompassStyle, toggleMeasureMode })
//     -> { handler, spaceMouse, getFlyMultiplier, setCameraButtons }
//   state (accessor object, variables stay in flex.js): miniMapUserHidden (get/set); miniMapMap (get).
//   pointCounter, creatingRoute, routePoints and currentEntity are only used here, so they live in
//   this module (the `route` object below) since flex.js split wave 3.

export function getFlagForKeyCode(keyCode) {
switch (keyCode) {
  case "0".charCodeAt(0):
    return "removePC";
  case "L".charCodeAt(0):
    return "showlidar";
  case "W".charCodeAt(0):
    return "moveForward";
  case "S".charCodeAt(0):
    return "moveBackward";
  case "E".charCodeAt(0):
    return "moveUp";
  case "Q".charCodeAt(0):
    return "moveDown";
  case "D".charCodeAt(0):
    return "moveRight";
  case "A".charCodeAt(0):
    return "moveLeft";
  case "F".charCodeAt(0):
    return "Fly";
  case "T".charCodeAt(0):
    return "TouchFly";
  case "1".charCodeAt(0):
    return "toggleOther";
  case "2".charCodeAt(0):
    return "toggleGround";
  case "3".charCodeAt(0):
    return "toggleVeg";
  case "4".charCodeAt(0):
    return "toggleLowNoise";
  case "5".charCodeAt(0):
    return "toggleAll";
  case "Z".charCodeAt(0):
    return "pointS";
  case "X".charCodeAt(0):
    return "pointM";
  case "C".charCodeAt(0):
    return "pointL";
  case "V".charCodeAt(0):
    return "measureDepth";
  case "R".charCodeAt(0):
    return "route";
  case "B".charCodeAt(0):
    return "routePoint";
  case "K".charCodeAt(0):
    return "downloadPoints";
  case "H".charCodeAt(0):
    return "hideCesium";
  case "P".charCodeAt(0):
    return "displayPC";
  case "I".charCodeAt(0):
    return "displayCave";
  case "O".charCodeAt(0):
    return "showOpenTopo";
  case "N".charCodeAt(0):
    return "cycleCompassStyle";
  case "M".charCodeAt(0):
    return "toggleMiniMap";
  default:
    return undefined;
}
}


// Keys that toggle on key-down: key-up leaves their flag alone.
const LATCHED_FLAGS = new Set(["Fly", "TouchFly", "hideCesium", "showlidar", "removePC", "toggleOther",
  "toggleGround", "toggleVeg", "toggleLowNoise", "toggleAll", "displayPC", "displayCave", "showOpenTopo",
  "cycleCompassStyle", "measureDepth", "toggleMiniMap"]);
export const isLatchedFlag = name => LATCHED_FLAGS.has(name);

export const FLY_MULT_MIN = 0.1, FLY_MULT_MAX = 64;
export const clampFlyMult = m => (Number.isFinite(m) ? Math.min(FLY_MULT_MAX, Math.max(FLY_MULT_MIN, m)) : 1);

// Fly speed (m/s) from the height above ground (m): 20 m/s at 20 m, floor 2, cap 20000.
export const flySpeedMps = hag => Math.min(20000, Math.max(2, 0.5 * (hag + 20)));

export function downloadBlob(filename, blob) {
if (window.navigator.msSaveOrOpenBlob) {
  window.navigator.msSaveBlob(blob, filename);
} else {
  const elem = window.document.createElement("a");
  elem.href = window.URL.createObjectURL(blob);
  elem.download = filename;
  document.body.appendChild(elem);
  elem.click();
  document.body.removeChild(elem);
}
}


export function setupCesiumInteractions({
  Cesium, cesiumViewer, scene, canvas, flags, viewModel, potreeViewer, workflowState, state,
  initSpaceMouse, sampleHeightAboveGround, otHandleClick, globeGroundNow,
  stopAoiDrawMode, renderPcList, renderPoiList, cycleCompassStyle, toggleMeasureMode,
}) {
const route = { pointCounter: 0, creatingRoute: "", routePoints: [], currentEntity: new Cesium.Entity() };
const _clampFlyMult = clampFlyMult;
const _otHandleClick = otHandleClick;
const _globeGroundNow = globeGroundNow;
// Mouse buttons outside fly mode: right-drag orbits, middle-drag zooms (Cesium's
// default is the other way round). Fly mode keeps Cesium's defaults. Ctrl+drag
// and the wheel/pinch behave as before in both.
const _CamEv = Cesium.CameraEventType;
const _sscc  = scene.screenSpaceCameraController;
const _CAM_DEFAULT = {
  zoom: _sscc.zoomEventTypes,
  tilt: _sscc.tiltEventTypes,
};
const _CAM_SWAPPED = {
  zoom: [_CamEv.MIDDLE_DRAG, _CamEv.WHEEL, _CamEv.PINCH],
  tilt: [_CamEv.RIGHT_DRAG, _CamEv.PINCH,
         { eventType: _CamEv.LEFT_DRAG,   modifier: Cesium.KeyboardEventModifier.CTRL },
         { eventType: _CamEv.RIGHT_DRAG,  modifier: Cesium.KeyboardEventModifier.CTRL }],
};
let _camButtonsSwapped = null;
function _setCameraButtons(swapped) {
  if (_camButtonsSwapped === swapped) return;
  const m = swapped ? _CAM_SWAPPED : _CAM_DEFAULT;
  _sscc.zoomEventTypes = m.zoom;
  _sscc.tiltEventTypes = m.tilt;
  _camButtonsSwapped = swapped;
}
_setCameraButtons(true);

// 3Dconnexion SpaceMouse (WebHID). Drives the Cesium camera every frame from
// loop(); Potree follows Cesium's camera as usual. Panel: Tools → SpaceMouse.
let _spaceMouse = null;
try {
  _spaceMouse = initSpaceMouse({ viewer: cesiumViewer, heightAboveGround: sampleHeightAboveGround });
} catch (err) {
  console.warn('[spacemouse] init failed', err);
}

let startMousePosition;
let moveRate = 100;
let moverRateMultiplyer = 1;
let mousePosition;
let lastMousePosition;


const handler = new Cesium.ScreenSpaceEventHandler(canvas);

handler.setInputAction(function (movement) {
flags.looking = true;
mousePosition = startMousePosition = Cesium.Cartesian3.clone(
  movement.position
);
}, Cesium.ScreenSpaceEventType.LEFT_DOWN);

handler.setInputAction(function (movement) {
mousePosition = movement.endPosition;
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

handler.setInputAction(function (position) {
flags.looking = false;
}, Cesium.ScreenSpaceEventType.LEFT_UP);

handler.setInputAction(function (click) {
  _otHandleClick(click.position);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// handler.setInputAction(function (movement) {
//   if (flags.looking != true){
//     console.log(event);
//   } else {
//     console.log(event);
//     if (event.deltaY < 0)
//    {
//     moverRateMultiplyer*=1.15;
//    }
//    else if (event.deltaY > 0)
//    {
//     moverRateMultiplyer/=1.15;
//    }
//   }
//   }, Cesium.ScreenSpaceEventType.PINCH_MOVE);

// Allow for speed adjustment when flying: the wheel over the 3D view (not
// over panels and lists, which scroll as usual).
let _flyLastTick = null;
window.addEventListener('wheel', function(event)
{
if (!flags.Fly) return;
const t = event.target;
if (!(t instanceof HTMLCanvasElement) || (t.closest && t.closest('#mini_map_container'))) return;
if (event.deltaY < 0)
{
moverRateMultiplyer = _clampFlyMult(moverRateMultiplyer*1.15);
}
else if (event.deltaY > 0)
{
moverRateMultiplyer = _clampFlyMult(moverRateMultiplyer/1.15);
}
}, { passive: true });

// Height above (or below) the ground for fly speed. With the globe hidden or
// its tiles not in yet, the last ground height seen nearby stands in.
let _flyGround = null;   // { lon, lat, h }
// globe.getHeight samples whatever tile is loaded. A coarse tile is a few big
// flat triangles that sag below the real surface (136 m on the plain ellipsoid
// at the level loaded a few seconds after a jump), and that passed as ground:
// flying at 20 m felt like 156 m, about 4x too fast. So while flying, the
// terrain's most detailed height under the camera is fetched in the background
// (at most once a second, and only after moving 30 m) and used while it is
// fresh and close; getHeight is the stand-in until it arrives. It works with
// the globe hidden too (H), since it asks the terrain, not the drawn tiles.
let _flyGroundFine = null, _flyGroundBusy = false;   // { lon, lat, h, t }
const _flyGroundDist = (a, carto) => Math.hypot(a.lat - carto.latitude, (a.lon - carto.longitude) * Math.cos(carto.latitude)) * 6371000;
function _flyRefineGround(carto) {
  const f = _flyGroundFine, now = performance.now();
  if (_flyGroundBusy || (f && (now - f.t < 1000 || _flyGroundDist(f, carto) < 30))) return;
  const tp = scene.terrainProvider;
  if (!tp) return;
  _flyGroundBusy = true;
  const at = new Cesium.Cartographic(carto.longitude, carto.latitude);
  (tp.availability ? Cesium.sampleTerrainMostDetailed(tp, [at]) : Cesium.sampleTerrain(tp, 14, [at]))
    .then(r => { const h = r && r[0] && r[0].height; if (Number.isFinite(h)) _flyGroundFine = { lon: at.longitude, lat: at.latitude, h, t: performance.now() }; })
    .catch(() => {})
    .finally(() => { _flyGroundBusy = false; });
}
function _flyHeightAboveGround(carto) {
  _flyRefineGround(carto);
  const f = _flyGroundFine;
  if (f && _flyGroundDist(f, carto) < 200) {
    _flyGround = { lon: f.lon, lat: f.lat, h: f.h };
    return carto.height - f.h;
  }
  const g = scene.globe.show ? _globeGroundNow(carto) : undefined;
  if (g !== undefined) {
    _flyGround = { lon: carto.longitude, lat: carto.latitude, h: g };
    return carto.height - g;
  }
  if (_flyGround && Math.abs(_flyGround.lon - carto.longitude) < 0.001 && Math.abs(_flyGround.lat - carto.latitude) < 0.001) {   // ~5 km (radians)
    return carto.height - _flyGround.h;
  }
  return Math.max(carto.height, 0);
}


// const entity = cesiumViewer.entities.add({
//   label: {
//     show: false,
//     showBackground: false,
//     font: "14px monospace",
//     horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
//     verticalOrigin: Cesium.VerticalOrigin.TOP,
//     pixelOffset: new Cesium.Cartesian2(15, 0),
//     disableDepthTestDistance: 1.2742018*10**7, // Diameter of Earth
//   },
// });
// const cart = new Cesium.Cartesian3(1,1,1);
// // Mouse over the globe to see the cartographic position
// handler.setInputAction(function (movement) {
//   mousePosition = movement.endPosition;
//   if (flags.selecting){
//     scene.pickTranslucentDepth = true;
//     scene.pickPosition(
//       movement.endPosition, cart
//     );
//     if (cart) {
//       const cartographic = Cesium.Cartographic.fromCartesian(
//         cart
//       );
//       const longitudeString = Cesium.Math.toDegrees(
//         cartographic.longitude
//       ).toFixed(5);
//       const latitudeString = Cesium.Math.toDegrees(
//         cartographic.latitude
//       ).toFixed(5);

//       entity.position = cart;
//       entity.label.show = true;
//       entity.label.text =
//         `Lon: ${`   ${longitudeString}`.slice(-7)}\u00B0` +
//         `\nLat: ${`   ${latitudeString}`.slice(-7)}\u00B0`;
//     } else {
//       entity.label.show = false;
//     }
//   }
//   else {
//       entity.label.show = false;
//   }

// }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
// array to store left side pointers
var pointersLeft = [];

// array to store right side pointers
var pointersRight = [];

var touchFlyDirection = Cesium.Cartesian3.clone(cesiumViewer.camera.direction);

function addPointer(e) { 
// console.log(e);
const width = canvas.clientWidth;
let pointer = {
  ID: e.pointerId,
  startX: e.clientX,
  currentX: e.clientX,
  startY: e.clientY,
  currentY: e.clientY
};
if (e.clientX >= (width*0.5)){
  pointersRight.push(pointer);
} else {
  pointersLeft.push(pointer);
}
} 

// Change below to work with nested arrays from above
// function removePointer(e) { 
//   const index = pointersRight.indexOf(e.pointerId);
//   if (index > -1) { // only splice array when item is found
//     pointersRight.splice(index, 1);
//   } else {
//     const indexL = pointersLeft.indexOf(e.pointerId);
//     if (index > -1) { // only splice array when item is found
//       pointersLeft.splice(index, 1);
//     } else {
//       // console.log("did not find pointer to remove");
//     }
//   } 
// }

function runTouchFly (e) {
const width = canvas.clientWidth;
if (e.clientX >= (width*0.5)){
  let index = pointersRight.findIndex((element) => element.ID == e.pointerId);
  pointersRight[index].currentX = e.clientX;
  pointersRight[index].currentY = e.clientY;
  console.log(pointersRight[index]);
} else {
  let index = pointersLeft.findIndex((element) => element.ID == e.pointerId);
  pointersLeft[index].currentX = e.clientX;
  pointersLeft[index].currentY = e.clientY;
}
//Check if moved point is on left or right 
// 
// if right: 
//   if one: look around
//     if two: look around + use some attribute to change speed



// if left:
//   count how many points we have:
//   if one: 
//     translate camera by distance along moving plane
//   if two: tilt moving plane relative to frustum

}

function initializeTouchFlyPointers() {

document.addEventListener("pointerdown", function (e) {addPointer(e)}, true); 
document.addEventListener("pointerup", function (e) {removePointer(e)}, true); 
document.addEventListener("pointercancel", function (e) {removePointer(e)}, true);
document.addEventListener("pointermove", function (e) {runTouchFly(e)}, false);

// disable usual cesium navigation
// cesiumViewer.scene.screenSpaceCameraController.enableRotate = false;
// cesiumViewer.scene.screenSpaceCameraController.enableTranslate = false;
// cesiumViewer.scene.screenSpaceCameraController.enableZoom = false;
// cesiumViewer.scene.screenSpaceCameraController.enableTilt = false;
// cesiumViewer.scene.screenSpaceCameraController.enableLook = false;

// update the camera direction (unsure if needed)
touchFlyDirection = Cesium.Cartesian3.clone(cesiumViewer.camera.direction);


}
// function removeTouchFlyPointers() {
//   document.removeEventListener("pointerdown", addPointer, true); 
//   document.removeEventListener("pointerup", removePointer, true); 
//   document.removeEventListener("pointercancel", removePointer, true);
//   document.removeEventListener("pointermove", function (e) {runTouchFly(e)}, false);
// }


document.addEventListener(
"keydown",
function (e) {
  const tag = document.activeElement && document.activeElement.tagName;
  const isTyping = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement.isContentEditable;
  if (isTyping) {
    return;
  }
  if (workflowState.drawModeActive && e.key === "Escape") {
    stopAoiDrawMode("AOI draw canceled.");
    return;
  }
  const flagName = getFlagForKeyCode(e.keyCode);
  if (typeof flagName !== "undefined") {
    if (flagName == "Fly" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
      moverRateMultiplyer=1;
    }else if (flagName == "TouchFly" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
      if (flags[flagName]){
        initializeTouchFlyPointers();
        console.log("initialized TouchFly");
      }else {
        // removeTouchFlyPointers();
        // console.log("removed TouchFly");
      }
      moverRateMultiplyer=1;
    }else if (flagName == "hideCesium" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
      cesiumViewer.scene.globe.show = !flags[flagName];
      cesiumViewer.scene.skyAtmosphere.show = !flags[flagName];
      // cesiumViewer.scene.skyBox.show = !flags[flagName];
    }else if (flagName == "displayPC" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
    }else if (flagName == "displayCave" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
    }else if (flagName == "showOpenTopo" ){ // Toggle Flags
      flags[flagName] = !flags[flagName];
    }else if (flagName == "cycleCompassStyle"){
      cycleCompassStyle();
    }else if (flagName == "toggleMiniMap"){
      state.miniMapUserHidden = !state.miniMapUserHidden;
      const container = document.getElementById("mini_map_container");
      if (container) {
        container.style.display = state.miniMapUserHidden ? "none" : "block";
        if (!state.miniMapUserHidden && state.miniMapMap) state.miniMapMap.updateSize();
      }
    }else if (flagName == "measureDepth"){
      toggleMeasureMode();
    }else if (flagName == "toggleOther"){
      flags[flagName] = !flags[flagName];
      potreeViewer.setClassificationVisibility(0,flags[flagName]);
      potreeViewer.setClassificationVisibility(1,flags[flagName]);
      potreeViewer.setClassificationVisibility(8,flags[flagName]);
      potreeViewer.setClassificationVisibility(9,flags[flagName]);
      potreeViewer.setClassificationVisibility(12,flags[flagName]);
      potreeViewer.setClassificationVisibility("DEFAULT",flags[flagName]);
    }else if (flagName == "toggleGround"){
      flags[flagName] = !flags[flagName];
      potreeViewer.setClassificationVisibility(2,flags[flagName]);
    }else if (flagName == "toggleVeg"){
      flags[flagName] = !flags[flagName];
      potreeViewer.setClassificationVisibility(3,flags[flagName]);
      potreeViewer.setClassificationVisibility(4,flags[flagName]);
      potreeViewer.setClassificationVisibility(5,flags[flagName]);
      potreeViewer.setClassificationVisibility(6,flags[flagName]);
    }else if (flagName == "toggleLowNoise"){ 
      flags[flagName] = !flags[flagName];
      potreeViewer.setClassificationVisibility(7,flags[flagName]);
    }else if (flagName == "toggleAll"){
      flags[flagName] = !flags[flagName];
      // if toggleall is turning off: turn off all toggles that are on
      potreeViewer.setClassificationVisibility(0,flags[flagName]);
      potreeViewer.setClassificationVisibility(1,flags[flagName]);
      potreeViewer.setClassificationVisibility(8,flags[flagName]);
      potreeViewer.setClassificationVisibility(9,flags[flagName]);
      potreeViewer.setClassificationVisibility(12,flags[flagName]);
      potreeViewer.setClassificationVisibility("DEFAULT",flags[flagName]);
      potreeViewer.setClassificationVisibility(2,flags[flagName]);
      potreeViewer.setClassificationVisibility(3,flags[flagName]);
      potreeViewer.setClassificationVisibility(4,flags[flagName]);
      potreeViewer.setClassificationVisibility(5,flags[flagName]);
      potreeViewer.setClassificationVisibility(6,flags[flagName]);
      potreeViewer.setClassificationVisibility(7,flags[flagName]);
    }else if (flagName == "pointS"){ // add entity point where camera is currently located
      route.pointCounter +=1;
      let preview = "Point of Small interest ".concat(route.pointCounter.toString());
      let labelName = preview;
      console.log("Added point of Small interest: S".concat(route.pointCounter.toString()));
      const _poi = cesiumViewer.entities.add({
        label: { scale: 0.75, text: "S: ".concat(labelName) },
        position: cesiumViewer.camera.position.clone(),
        properties: { isUserLabel: true },
        point: {},
      });
      if (window._myData) window._myData.keepPoint(_poi, 'S');    // kept in My data (this sitting's "Points …" group)
      renderPoiList();
    }else if (flagName == "pointM"){ // add entity point where camera is currently located
      route.pointCounter +=1;
      let preview = "Point of Medium interest ".concat(route.pointCounter.toString());
      let labelName = prompt("Name", preview);
      console.log("Added point of Medium interest: M".concat(route.pointCounter.toString()));
      const _poi = cesiumViewer.entities.add({
        label: { scale: 1, text: "M: ".concat(labelName) },
        position: cesiumViewer.camera.position.clone(),
        properties: { isUserLabel: true },
        point: {},
      });
      if (window._myData) window._myData.keepPoint(_poi, 'M');    // kept in My data (this sitting's "Points …" group)
      renderPoiList();
    }else if (flagName == "pointL"){ // add entity point where camera is currently located
      route.pointCounter +=1;
      let preview = "Point of Large interest ".concat(route.pointCounter.toString());
      let labelName = prompt("Name", preview);
      console.log("Added point of Large interest: L".concat(route.pointCounter.toString()));
      const _poi = cesiumViewer.entities.add({
        label: { scale: 1.5, text: "L: ".concat(labelName) },
        position: cesiumViewer.camera.position.clone(),
        properties: { isUserLabel: true },
        point: {},
      });
      if (window._myData) window._myData.keepPoint(_poi, 'L');    // kept in My data (this sitting's "Points …" group)
      renderPoiList();
    }else if (flagName == "route"){ // startor stop recording route. If starting, add route point where camera is currently located.
      if (route.creatingRoute == ""){
        let preview = "Route ";
        let labelName = prompt("Press B to add route points, press V again to finish route. Name:", preview);
        console.log("Started creating Route");
        route.routePoints.push(cesiumViewer.camera.position.clone());
        route.creatingRoute = labelName;
      }else{
        route.routePoints = [];
        console.log("Finished creating route");
        route.creatingRoute = "";
      }
      
    }else if (flagName == "routePoint"){ // Adds point to route
      if (route.creatingRoute == ""){
        console.log("Start route to add points");
      }else{
        route.routePoints.push(cesiumViewer.camera.position.clone());
        console.log("Added point to route");
        cesiumViewer.entities.remove(route.currentEntity);
        route.currentEntity = cesiumViewer.entities.add({
          label: {
            scale: 1.5,
            text: route.creatingRoute,
            show: true,
          },
          name: route.creatingRoute,
          polyline: {
            positions: route.routePoints,
            width: 2,
            arcType: Cesium.ArcType.NONE,
            material: Cesium.Color.RED,
            clampToGround: false,
          },
        });
        console.log(cesiumViewer.entities);
      }
    }else if (flagName == "downloadPoints"){ // download all points added
      Cesium.exportKml({
        entities: cesiumViewer.entities,
        kmz: true,
        // modelCallback: modelCallback,
      }).then(function (result) {
          downloadBlob("TestExport.kmz", result.kmz);
        })
        .catch(console.error);
      // flags[flagName] = !flags[flagName];
    }else{
      flags[flagName] = true;
    }
    
  }
},
false
);

document.addEventListener(
"keyup",
function (e) {
  const flagName = getFlagForKeyCode(e.keyCode);
  if (typeof flagName !== "undefined" && !isLatchedFlag(flagName)) {
    flags[flagName] = false;
  }
},
false
);

cesiumViewer.clock.onTick.addEventListener(function (clock) {
const camera = cesiumViewer.camera;
// camera.frustum.fov = (Math.PI/2);

if (flags.removePC){
  while (potreeViewer.scene.pointclouds.length > 0) {
    potreeViewer.scene.scenePointCloud.children.splice(potreeViewer.scene.scenePointCloud.children.indexOf(potreeViewer.scene.pointclouds[0]), 1,);
    potreeViewer.scene.pointclouds.splice(0, 1); }
  console.log("Removed Point Clouds");
  flags.removePC = false;
  renderPcList();
}
if (flags.showlidar){
  viewModel.showlidar = !viewModel.showlidar;
  flags.showlidar = false;
}
if (flags.showOpenTopo){
  viewModel.showOpenTopo = !viewModel.showOpenTopo;
  flags.showOpenTopo = false;
}

if ((flags.looking) && (flags.Fly)) {
  // const width = canvas.clientWidth;
  // const height = canvas.clientHeight;

  const lookFactor = 0.0018;

  // Coordinate (0.0, 0.0) will be where the mouse was clicked.

  
  const y = -(mousePosition.y - startMousePosition.y);
  if (mousePosition.x != startMousePosition.x){
    const x = (mousePosition.x - startMousePosition.x);
    startMousePosition.x = mousePosition.x;
    // console.log(startMousePosition.x, mousePosition.x);
    camera.lookRight(x * lookFactor);
  }
  if (mousePosition.y != startMousePosition.y){
    const y = (mousePosition.y - startMousePosition.y);
    startMousePosition.y = mousePosition.y;
    camera.lookUp(-y * lookFactor);
  }
  
  camera.setView({
    orientation:{
      heading: camera.heading,
      pitch: camera.pitch,
      roll: 0.0,
    },
  });
}

if ((flags.looking) && (flags.TouchFly)) {
  // figure out which pointer is controlling the tilt
  // always right array [0]? lets start with that

  if (pointersRight.length > 0){
    const lookFactor = 0.0018;
    let controlPointer = pointersRight[0];
  // Coordinate (0.0, 0.0) will be where the mouse was clicked.

  
  const y = -(controlPointer.startY - controlPointer.currentY);
  if (controlPointer.currentX != controlPointer.startX){
    const x = (controlPointer.currentX - controlPointer.startX);
    pointersRight[0].startX = controlPointer.currentX;
    camera.lookRight(x * lookFactor);
  }
  if (controlPointer.currentY != controlPointer.startY){
    const y = (controlPointer.currentY != controlPointer.startY);
    pointersRight[0].startY = controlPointer.currentY;
    camera.lookUp(-y * lookFactor);

  }
  
  camera.setView({
    orientation:{
      heading: camera.heading,
      pitch: camera.pitch,
      roll: 0.0,
    },
  }); 
  }

  
}

// if (flags.TouchFly) {
//   // Change movement speed based on the distance of the camera to the surface of the ellipsoid.
//   const cameraHeight = ellipsoid.cartesianToCartographic(
//     camera.position
//   ).height;
//   // console.log(cameraHeight);
//   // sampleTerrain(viewer.terrainProvider, 5, [camera.positionCartographic])
//   // .then(function(samples) {
//   //   moveRate = ((cameraHeight-samples[0].height)/200.0);
//     moveRate = ((cameraHeight+1000)/200.0);
//     if (moveRate <0){
//       moveRate = -moveRate;
//     }
//     if (moveRate <0.5){ // make sure we can go underground
//       moveRate = 0.5;
//     }

//     if (moveRate > 6000){ // setting some limits
//         moveRate = 6000;
//     }

//     if (moverRateMultiplyer > 16){
//       moverRateMultiplyer = 16;
//     }
//     if (moverRateMultiplyer < 0.01){
//       moverRateMultiplyer = 0.01;
//     }

//     moveRate = moveRate*moverRateMultiplyer;

//   scene.screenSpaceCameraController.enableZoom = false;
//   scene.screenSpaceCameraController.enableRotate = false;
//   if (flags.touchFlying) {
//     camera.move(touchFlyDirection, moveRate);
//   }else{
//   scene.screenSpaceCameraController.enableZoom = true;
//   scene.screenSpaceCameraController.enableRotate = true;
// }


const _flyNow = performance.now();
// Time-based: a slow frame moves further, so the speed holds at low frame
// rates; a frame longer than 0.25 s (a stall, a hidden tab) counts as 0.25 s,
// so the camera never leaps after a pause.
const _flyDt = _flyLastTick === null ? 0 : Math.min(0.25, Math.max(0, (_flyNow - _flyLastTick) / 1000));
_flyLastTick = _flyNow;
if (flags.Fly) {
    // Speed follows the height above the ground, in metres per second so it
    // doesn't depend on the frame rate; the scroll wheel scales it
    // (FLY_MULT_MIN..FLY_MULT_MAX). Below the ground (in a cave) it stays at
    // the ground-level speed however deep you go. It used to follow height
    // above sea level, which made even the slowest setting fast over high
    // ground.
    const hag = Math.max(0, _flyHeightAboveGround(camera.positionCartographic));
    const mps = flySpeedMps(hag);
    moverRateMultiplyer = _clampFlyMult(moverRateMultiplyer);
    moveRate = mps * moverRateMultiplyer * _flyDt;

  _setCameraButtons(false);
  scene.screenSpaceCameraController.enableZoom = false;
  scene.screenSpaceCameraController.enableRotate = false;
  if (flags.moveForward) {
    camera.moveForward(moveRate);
  }
  if (flags.moveBackward) {
    camera.moveBackward(moveRate);
  }
  if (flags.moveUp) {
    camera.moveUp(moveRate*0.75);
  }
  if (flags.moveDown) {
    camera.moveDown(moveRate*0.75);
  }
  if (flags.moveLeft) {
    camera.moveLeft(moveRate*0.75);
  }
  if (flags.moveRight) {
    camera.moveRight(moveRate*0.75);
  }
}else{
  _setCameraButtons(true);
  scene.screenSpaceCameraController.enableZoom = true;
  scene.screenSpaceCameraController.enableRotate = true;
}
});

return {
  handler,
  spaceMouse: _spaceMouse,
  getFlyMultiplier: () => moverRateMultiplyer,
  setCameraButtons: _setCameraButtons,
};
}
