import * as THREE from "./PotreeCopied/libs/three.js/build/three.module.js";

import "../Tokens.js";
  
window.cesiumViewer = new Cesium.Viewer('cesiumContainer', {
useDefaultRenderLoop: false,
terrainProvider: await Cesium.createWorldTerrainAsync(), 
animation: false,
baseLayerPicker: false,
timeline: false,
navigationHelpButton: false,
terrainShadows: Cesium.ShadowMode.DISABLED,
// clampToGround : true,

});
cesiumViewer.camera.frustum.fov = (90*Cesium.Math.PI)/180;

// Add a floating action button that appears when an entity is selected
let floatingButton = null;

// Create the floating button once
function createFloatingButton() {
  if (floatingButton) return;
  
  floatingButton = document.createElement('div');
  floatingButton.innerHTML = `
    <button id="floating-action-btn" style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: #0078d4; 
      color: white; 
      border: none; 
      padding: 12px 20px; 
      border-radius: 8px; 
      cursor: pointer;
      font-size: 16px;
      z-index: 9999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: none;
      transition: all 0.3s ease;
    ">📊 Add Point Cloud</button>
  `;
  
  // Add click handler
  const btn = floatingButton.querySelector('#floating-action-btn');
  if (btn) {
          btn.onclick = function() {
        if (cesiumViewer.selectedEntity) {

          const properties = cesiumViewer.selectedEntity.properties;
          if (properties && properties._url && properties._url._value) {
            const url = properties._url._value;
            // console.log('Found URL in properties:', url);
            window.addPC(url);
          } else {
            console.log('No URL found in properties');
            console.log('Properties object:', properties);
          }
        }
      };
  }
  
  // Add to body
  document.body.appendChild(floatingButton);
  console.log('Floating button created');
}

// Monitor entity selection
let lastSelectedEntity = null;

setInterval(() => {
  const currentEntity = cesiumViewer.selectedEntity;
  
  // Entity selection changed
  if (currentEntity !== lastSelectedEntity) {
    if (currentEntity && !lastSelectedEntity) {
      // Entity was selected
      console.log('Entity selected:', currentEntity.id);
      showFloatingButton();
    } else if (!currentEntity && lastSelectedEntity) {
      // Entity was deselected
      console.log('Entity deselected');
      hideFloatingButton();
    }
    lastSelectedEntity = currentEntity;
  }
}, 100);

function showFloatingButton() {
  if (!floatingButton) {
    createFloatingButton();
  }
  
  const btn = floatingButton.querySelector('#floating-action-btn');
  if (btn) {
    btn.style.display = 'block';
    btn.style.transform = 'scale(1)';
    console.log('Floating button shown');
  }
}

function hideFloatingButton() {
  if (floatingButton) {
    const btn = floatingButton.querySelector('#floating-action-btn');
    if (btn) {
      btn.style.display = 'none';
      btn.style.transform = 'scale(0.8)';
      console.log('Floating button hidden');
    }
  }
}

// Add fog at the distance so we don't see the other side of the world?
// Make a way to toggle this map.

try {
  const tileset = await Cesium.createGooglePhotorealistic3DTileset();
  cesiumViewer.scene.primitives.add(tileset);
  cesiumViewer.scene.primitives._primitives[0].show = false;
} catch (error) {
  console.log(`Error creating tileset: ${error}`);
}


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

var pointCounter = 0;
var creatingRoute = "";
var routePoints = [];
var currentEntity = new Cesium.Entity();

var ClassificationScheme = {
  0:       { visible: flags.toggleOther, name: 'never classified'  , color: [0.5,  0.5,  0.5,  1.0] },
  1:       { visible: flags.toggleOther, name: 'unclassified'      , color: [0.5,  0.5,  0.5,  1.0] },
  2:       { visible: flags.toggleGround, name: 'ground'            , color: [0.63, 0.32, 0.18, 1.0] },
  3:       { visible: flags.toggleVegetation, name: 'low vegetation'    , color: [0.0,  1.0,  0.0,  1.0] },
  4:       { visible: flags.toggleVegetation, name: 'medium vegetation' , color: [0.0,  0.8,  0.0,  1.0] },
  5:       { visible: flags.toggleVegetation, name: 'high vegetation'   , color: [0.0,  0.6,  0.0,  1.0] },
  6:       { visible: flags.toggleVegetation, name: 'building'          , color: [1.0,  0.66, 0.0,  1.0] },
  7:       { visible: flags.toggleLowNoise, name: 'low point(noise)'  , color: [1.0,  1.0,  1.0,  1.0] },
  8:       { visible: flags.toggleOther, name: 'key-point'         , color: [1.0,  0.0,  0.0,  1.0] },
  9:       { visible: flags.toggleOther, name: 'water'             , color: [0.0,  0.0,  1.0,  1.0] },
  12:      { visible: flags.toggleOther, name: 'overlap'           , color: [1.0,  1.0,  0.0,  1.0] },
  DEFAULT: { visible: flags.toggleOther, name: 'default'           , color: [0.4,  0.4,  0.4,  0.5] },
};
// console.log(ClassificationScheme);

window.potreeViewer = new Potree.Viewer(document.getElementById("potree_render_area"), {
  useDefaultRenderLoop: false
});
potreeViewer.setEDLEnabled(true);
potreeViewer.setEDLRadius(3.5); //2.0
potreeViewer.setEDLStrength(0.4);
potreeViewer.setFOV(60);
potreeViewer.setPointBudget(10_000_000);
potreeViewer.classifications = ClassificationScheme;
// potreeViewer.setMinNodeSize(50);
potreeViewer.loadSettingsFromURL();
potreeViewer.setBackground(null);
potreeViewer.useHQ = false;
// potreeViewer.setLengthUnit('m');
potreeViewer.setDescription("");


if (flags.displayCave){
  const promise2 = Cesium.GeoJsonDataSource.load(
    "./user_files/.geojson"
    );
    promise2
      .then(function (dataSource) {
        cesiumViewer.dataSources.add(dataSource);


      })
      .catch(function (error) {
        //Display any errrors encountered while loading.
        window.alert(error);
      });

};


Cesium.Math.setRandomNumberSeed(0);
const promise = Cesium.GeoJsonDataSource.load(
  ProxyUrlGenerator.generateProxyUrl("https://usgs.entwine.io/boundaries/resources.geojson")
);
promise
  .then(function (dataSource) {
    cesiumViewer.dataSources.add(dataSource);

    //Get the array of entities
    const entities = dataSource.entities.values;

    const colorHash = {};
    for (let i = 0; i < entities.length; i++) {
      //For each entity, create a random color based on the state name.
      //Some states have multiple entities, so we store the color in a
      //hash so that we use the same color for the entire state.
      const entity = entities[i];
      const name = entity.name;
      let color = colorHash[name];
      if (!color) {
        color = Cesium.Color.fromRandom({
          alpha: 0.5,
        });
        colorHash[name] = color;
      }

      //Set the polygon material to our random color.
      entity.polygon.material = color;
      //Remove the outlines.
      entity.polygon.outline = false;
      entity.polygon.extrudedHeight = 1000;
      dataSource.show = false;
    }
  })
  .catch(function (error) {
    //Display any errrors encountered while loading.
    window.alert(error);
  });



//   const promise2 = Cesium.GeoJsonDataSource.load(
//     ProxyUrlGenerator.generateProxyUrl(
//       "https://feroz.us/RWUTS.geojson"
//     )
//   );
// promise2
//   .then(function (dataSource) {
//     cesiumViewer.dataSources.add(dataSource);

//     //Get the array of entities
    
//     dataSource.show = true;
    
//   })
//   .catch(function (error) {
//     //Display any errrors encountered while loading.
//     window.alert(error);
//   });
const scene = cesiumViewer.scene;
scene.screenSpaceCameraController.enableCollisionDetection = false;
const canvas = cesiumViewer.canvas;
canvas.setAttribute("tabindex", "0"); // needed to put focus on the canvas
canvas.onclick = function () {
canvas.focus();
};


const ellipsoid = scene.globe.ellipsoid;
scene.globe.translucency.enabled = true 
scene.globe.translucency.frontFaceAlphaByDistance = new Cesium.NearFarScalar(
400.0,
0.0,
1000.0,
1.0
);
scene.globe.translucency.frontFaceAlphaByDistance.nearValue = 0.7;
scene.globe.translucency.frontFaceAlphaByDistance.farValue = 1;
let compassRenderer = null;
let compassOverlayElement = null;
let compassLabelElement = null;
let compassScene = null;
let compassCamera = null;
let compassGroup = null;
const compassStyleGroups = {};
let compassStyleIndex = 2;
const compassStyles = [
  "needle-rose",
  "triad-gizmo",
  "orbital-rings",
  "north-beacon"
];
const enuFrameScratch = new Cesium.Matrix4();
const eastWorldScratch = new Cesium.Cartesian3();
const northWorldScratch = new Cesium.Cartesian3();
const upWorldScratch = new Cesium.Cartesian3();
const localNorthScratch = new Cesium.Cartesian3();
const localUpScratch = new Cesium.Cartesian3();
const compassNorthAxis = new THREE.Vector3();
const compassUpAxis = new THREE.Vector3();
const compassEastAxis = new THREE.Vector3();
const compassMatrix = new THREE.Matrix4();
const cardinalPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compassSizeByStyle = {
  "needle-rose": { width: 150, height: 150 },
  "triad-gizmo": { width: 140, height: 140 },
  "orbital-rings": { width: 150, height: 150 },
  "north-beacon": { width: 130, height: 130 }
};

function normalizeDegrees(value) {
  let wrapped = value % 360;
  if (wrapped < 0) {
    wrapped += 360;
  }
  return wrapped;
}

function getCardinalLabel(angleDegrees) {
  const index = Math.round(normalizeDegrees(angleDegrees) / 45) % 8;
  return cardinalPoints[index];
}

function createNeedleRoseGroup() {
  const group = new THREE.Group();

  const ringGeometry = new THREE.TorusGeometry(1.5, 0.04, 12, 48);
  const ringMaterial = new THREE.MeshStandardMaterial({
    color: 0xdddddd,
    transparent: true,
    opacity: 0.85
  });
  group.add(new THREE.Mesh(ringGeometry, ringMaterial));

  const shaftGeometry = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 12);
  const northShaft = new THREE.Mesh(
    shaftGeometry,
    new THREE.MeshStandardMaterial({ color: 0xff2b2b })
  );
  northShaft.position.y = 0.8;
  group.add(northShaft);

  const southShaft = new THREE.Mesh(
    shaftGeometry,
    new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  southShaft.position.y = -0.8;
  group.add(southShaft);

  const tipGeometry = new THREE.ConeGeometry(0.14, 0.38, 16);
  const northTip = new THREE.Mesh(
    tipGeometry,
    new THREE.MeshStandardMaterial({ color: 0xff2b2b })
  );
  northTip.position.y = 1.74;
  group.add(northTip);

  const southTip = new THREE.Mesh(
    tipGeometry,
    new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  southTip.position.y = -1.74;
  southTip.rotation.x = Math.PI;
  group.add(southTip);

  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  group.add(hub);

  return group;
}

function createTriadGizmoGroup() {
  const group = new THREE.Group();
  const origin = new THREE.Vector3(0, 0, 0);
  group.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), origin, 2.0, 0xff2b2b, 0.45, 0.24));
  group.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), origin, 1.6, 0x4aa3ff, 0.35, 0.2));
  group.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), origin, 1.6, 0x44dd88, 0.35, 0.2));

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.45, 0.025, 10, 40),
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
  );
  group.add(ring);

  return group;
}

function createOrbitalRingsGroup() {
  const group = new THREE.Group();

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 14),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  group.add(sphere);

  const ringMain = new THREE.Mesh(
    new THREE.TorusGeometry(1.35, 0.04, 14, 64),
    new THREE.MeshStandardMaterial({ color: 0xe5e5e5, transparent: true, opacity: 0.8 })
  );
  group.add(ringMain);

  const ringTilt = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.03, 12, 48),
    new THREE.MeshStandardMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.8 })
  );
  ringTilt.rotation.x = Math.PI / 2;
  group.add(ringTilt);

  const northArrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.48, 18),
    new THREE.MeshStandardMaterial({ color: 0xff2b2b })
  );
  northArrow.position.y = 1.72;
  group.add(northArrow);

  return group;
}

function createNorthBeaconGroup() {
  const group = new THREE.Group();
  const materialRed = new THREE.MeshStandardMaterial({ color: 0xff3a3a });
  const materialWhite = new THREE.MeshStandardMaterial({ color: 0xffffff });

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.09, 2.3, 16),
    materialWhite
  );
  group.add(shaft);

  const northHead = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.7, 20),
    materialRed
  );
  northHead.position.y = 1.5;
  group.add(northHead);

  return group;
}

function applyCompassStyleLayout() {
  if (!compassOverlayElement || !compassRenderer) {
    return;
  }

  const styleName = compassStyles[compassStyleIndex];
  const size = compassSizeByStyle[styleName] || compassSizeByStyle["needle-rose"];
  compassOverlayElement.style.width = `${size.width}px`;
  compassOverlayElement.style.height = `${size.height}px`;
  compassRenderer.setSize(size.width, size.height, false);

  if (compassCamera) {
    compassCamera.aspect = size.width / size.height;
    compassCamera.updateProjectionMatrix();
  }
}

function setCompassStyle(styleName) {
  const nextIndex = compassStyles.indexOf(styleName);
  if (nextIndex === -1) {
    console.warn(`Unknown compass style: ${styleName}`);
    return;
  }
  compassStyleIndex = nextIndex;
  applyCompassStyleLayout();
  Object.keys(compassStyleGroups).forEach((key) => {
    compassStyleGroups[key].visible = key === styleName;
  });
  if (compassLabelElement) {
    compassLabelElement.innerText = `Style: ${styleName}`;
  }
  console.log(`Compass style: ${styleName}`);
}

function cycleCompassStyle() {
  compassStyleIndex = (compassStyleIndex + 1) % compassStyles.length;
  setCompassStyle(compassStyles[compassStyleIndex]);
}

function initNorthCompass() {
  compassOverlayElement = document.getElementById("north_compass_overlay");
  if (!compassOverlayElement) {
    console.warn("North compass overlay element was not found.");
    return;
  }
  compassOverlayElement.innerHTML = "";

  compassRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  compassRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  compassRenderer.setClearColor(0x000000, 0);
  compassOverlayElement.appendChild(compassRenderer.domElement);

  compassLabelElement = document.createElement("div");
  compassLabelElement.style.position = "absolute";
  compassLabelElement.style.left = "0";
  compassLabelElement.style.top = "-8px";
  compassLabelElement.style.width = "100%";
  compassLabelElement.style.textAlign = "center";
  compassLabelElement.style.font = "11px sans-serif";
  compassLabelElement.style.lineHeight = "1.15";
  compassLabelElement.style.color = "#d8d8d8";
  compassLabelElement.style.textShadow = "0 0 4px rgba(0,0,0,0.85)";
  compassOverlayElement.appendChild(compassLabelElement);

  compassScene = new THREE.Scene();
  compassCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  compassCamera.position.set(0, 0, 6.5);
  compassCamera.lookAt(0, 0, 0);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
  keyLight.position.set(4, 5, 6);
  compassScene.add(ambientLight);
  compassScene.add(keyLight);

  compassGroup = new THREE.Group();
  compassStyleGroups["needle-rose"] = createNeedleRoseGroup();
  compassStyleGroups["triad-gizmo"] = createTriadGizmoGroup();
  compassStyleGroups["orbital-rings"] = createOrbitalRingsGroup();
  compassStyleGroups["north-beacon"] = createNorthBeaconGroup();
  Object.keys(compassStyleGroups).forEach((key) => {
    compassStyleGroups[key].visible = false;
    compassGroup.add(compassStyleGroups[key]);
  });
  compassScene.add(compassGroup);

  setCompassStyle(compassStyles[compassStyleIndex]);
  window.setCompassStyle = setCompassStyle;
  window.cycleCompassStyle = cycleCompassStyle;
  console.log("Press N to cycle compass styles.");
}

function updateNorthCompass() {
  if (!compassRenderer || !compassScene || !compassCamera || !compassGroup) {
    return;
  }

  const camera = cesiumViewer.camera;
  const cameraPosition = camera.positionWC;
  const cameraDirection = camera.directionWC;
  const cameraRight = camera.rightWC;
  const cameraUp = camera.upWC;

  Cesium.Transforms.eastNorthUpToFixedFrame(
    cameraPosition,
    ellipsoid,
    enuFrameScratch
  );

  northWorldScratch.x = enuFrameScratch[4];
  northWorldScratch.y = enuFrameScratch[5];
  northWorldScratch.z = enuFrameScratch[6];
  Cesium.Cartesian3.normalize(northWorldScratch, northWorldScratch);
  eastWorldScratch.x = enuFrameScratch[0];
  eastWorldScratch.y = enuFrameScratch[1];
  eastWorldScratch.z = enuFrameScratch[2];
  Cesium.Cartesian3.normalize(eastWorldScratch, eastWorldScratch);
  upWorldScratch.x = enuFrameScratch[8];
  upWorldScratch.y = enuFrameScratch[9];
  upWorldScratch.z = enuFrameScratch[10];
  Cesium.Cartesian3.normalize(upWorldScratch, upWorldScratch);

  localNorthScratch.x = Cesium.Cartesian3.dot(northWorldScratch, cameraRight);
  localNorthScratch.y = Cesium.Cartesian3.dot(northWorldScratch, cameraUp);
  localNorthScratch.z = -Cesium.Cartesian3.dot(northWorldScratch, cameraDirection);
  localUpScratch.x = Cesium.Cartesian3.dot(upWorldScratch, cameraRight);
  localUpScratch.y = Cesium.Cartesian3.dot(upWorldScratch, cameraUp);
  localUpScratch.z = -Cesium.Cartesian3.dot(upWorldScratch, cameraDirection);

  if (
    Cesium.Cartesian3.magnitudeSquared(localNorthScratch) < 1e-8 ||
    Cesium.Cartesian3.magnitudeSquared(localUpScratch) < 1e-8
  ) {
    return;
  }

  Cesium.Cartesian3.normalize(localNorthScratch, localNorthScratch);
  Cesium.Cartesian3.normalize(localUpScratch, localUpScratch);

  compassNorthAxis.set(
    localNorthScratch.x,
    localNorthScratch.y,
    localNorthScratch.z
  );
  compassUpAxis.set(
    localUpScratch.x,
    localUpScratch.y,
    localUpScratch.z
  );
  compassEastAxis.crossVectors(compassNorthAxis, compassUpAxis);
  if (compassEastAxis.lengthSq() < 1e-8) {
    return;
  }
  compassEastAxis.normalize();
  compassNorthAxis.crossVectors(compassUpAxis, compassEastAxis).normalize();

  const styleName = compassStyles[compassStyleIndex];
  const headingRadians = Math.atan2(
    Cesium.Cartesian3.dot(cameraDirection, eastWorldScratch),
    Cesium.Cartesian3.dot(cameraDirection, northWorldScratch)
  );
  const headingDegrees = normalizeDegrees((headingRadians * 180) / Math.PI);
  const upDotDirection = Cesium.Cartesian3.dot(cameraDirection, upWorldScratch);
  const clampedUpDot = Math.max(-1, Math.min(1, upDotDirection));
  const inclinationDegrees = (Math.asin(clampedUpDot) * 180) / Math.PI;
  compassMatrix.makeBasis(compassEastAxis, compassNorthAxis, compassUpAxis);
  compassGroup.setRotationFromMatrix(compassMatrix);
  compassRenderer.render(compassScene, compassCamera);
  compassLabelElement.innerHTML =
    `${Math.round(headingDegrees)}° ${getCardinalLabel(headingDegrees)}<br>` +
    `${inclinationDegrees >= 0 ? "+" : ""}${inclinationDegrees.toFixed(1)}°`;
}

const imageryLayers = cesiumViewer.imageryLayers;

const viewModel = {
showlidar  : false,
googleMapsOn  : false,
usgsRef : false,
layers: [],
baseLayers: [],
upLayer: null,
downLayer: null,
selectedLayer: null,
isSelectableLayer: function (layer) {
  return this.baseLayers.indexOf(layer) >= 0;
},
raise: function (layer, index) {
  imageryLayers.raise(layer);
  viewModel.upLayer = layer;
  var v = (index - 1);
  if (v < 0){
    v = 0;
  }
  viewModel.downLayer = viewModel.layers[v];
  updateLayerList();
  window.setTimeout(function () {
    viewModel.upLayer = viewModel.downLayer = null;
  }, 10);
},
lower: function (layer, index) {
  imageryLayers.lower(layer);
  var v = (viewModel.layers.length - 1);
  if ((viewModel.layers.length - 1) > (index + 1)){
    v = (index + 1);
  }
  viewModel.upLayer =
    viewModel.layers[v];
  viewModel.downLayer = layer;
  updateLayerList();
  window.setTimeout(function () {
    viewModel.upLayer = viewModel.downLayer = null;
  }, 10);
},
canRaise: function (layerIndex) {
  return layerIndex > 0;
},
canLower: function (layerIndex) {
  return layerIndex >= 0 && layerIndex < imageryLayers.length - 1;
},
};
const baseLayers = viewModel.baseLayers;
const layerCatalog = [];
let miniMapMap = null;
let miniMapView = null;
let miniMapBaseLayer = null;
let miniMapAttentionLayer = null;
let miniMapAttentionSource = null;
let miniMapLabelLayer = null;
let miniMapLabelSource = null;
let miniMapCenterLayer = null;
let miniMapCenterFeature = null;
let miniMapAttentionEnabled = true;
let miniMapHoverLabelElement = null;
let miniMapVisibilityHeight = 15000;
let miniMapLastSyncTimestamp = 0;
let miniMapLastCameraPosition = null;
let miniMapLastHeading = 0;
let miniMapLastSavedAt = 0;
let miniMapLastRenderAt = 0;
let miniMapLastAttentionRenderAt = 0;
let miniMapLastLabelSyncAt = 0;
const miniMapLabelEntities = new Map();
const ATTENTION_STORAGE_KEY = "flex_minimap_attention_v1";
const ATTENTION_CELL_METERS = 15;
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

function proxifyOlSource(source) {
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

const miniMapLayerDefs = [
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
          url: "https://ngmdb-tiles.usgs.gov/arcgis/rest/services/mapview/ngmdbMosaic/ImageServer",
          params: {
            FORMAT: "jpgpng",
            F: "image"
          },
          crossOrigin: "anonymous"
        })
      )
  }
];

Cesium.knockout.track(viewModel);
function buildLayerCatalog() {
  layerCatalog.splice(0, layerCatalog.length);
  layerCatalog.push(
    {
      name: "Bing Maps Aerial",
      kind: "base",
      createProvider: () => Cesium.createWorldImageryAsync()
    },
    {
      name: "Bing Maps Road",
      kind: "base",
      createProvider: () =>
        Cesium.createWorldImageryAsync({
          style: Cesium.IonWorldImageryStyle.ROAD
        })
    },
    {
      name: "ArcGIS World Street Maps",
      kind: "base",
      createProvider: () =>
        Cesium.ArcGisMapServerImageryProvider.fromUrl(
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer"
        )
    },
    {
      name: "OpenStreetMaps",
      kind: "base",
      createProvider: () => new Cesium.OpenStreetMapImageryProvider()
    },
    {
      name: "Stamen Maps",
      kind: "base",
      createProvider: () =>
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://stamen-tiles.a.ssl.fastly.net/watercolor/",
          fileExtension: "jpg",
          credit:
            "Map tiles by Stamen Design, under CC BY 3.0. Data by OpenStreetMap, under CC BY SA."
        })
    },
    {
      name: "Natural Earth II (local)",
      kind: "base",
      createProvider: () =>
        Cesium.TileMapServiceImageryProvider.fromUrl(
          Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
        )
    },
    {
      name: "USGS Shaded Relief (via WMTS)",
      kind: "base",
      createProvider: () =>
        new Cesium.WebMapTileServiceImageryProvider({
          url:
            "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/WMTS",
          layer: "USGSShadedReliefOnly",
          style: "default",
          format: "image/jpeg",
          tileMatrixSetID: "default028mm",
          maximumLevel: 19,
          credit: "U. S. Geological Survey"
        })
    },
    {
      name: "Slope Angle",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: ProxyUrlGenerator.generateProxyUrl(Cesium.buildModuleUrl("https://caltopo.com/tile/sg") + "/{z}/{x}/{y}.png"),
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18
        })
    },
    {
      name: "US Karst Map",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: Cesium.buildModuleUrl("https://tiles.arcgis.com/tiles/hoKRg7d6zCP8hwp2/arcgis/rest/services/Carbonate_Karst/MapServer/tile") + "/{z}/{y}/{x}?blankTile=false",
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18
        })
    },
    {
      name: "OpenTopo datasets",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://portal.opentopography.org/geoserver/OPENTOPO/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image%2Fpng&TRANSPARENT=true&STYLES&LAYERS=OPENTOPO%3Adatasets_view&CQL_FILTER=is_global%20%3D%20false&SRS=EPSG%3A4326&WIDTH=256&HEIGHT=256&BBOX={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}",
          tilingScheme: new Cesium.GeographicTilingScheme(),
          enablePickFeatures: false,
          pickFeaturesUrl: "https://portal.opentopography.org/geoserver/OPENTOPO/wms?0=C&1=Q&2=L&3=_&4=F&5=I&6=L&7=T&8=E&9=R&10=%20&11=%3D&12=%20&13=i&14=s&15=_&16=g&17=l&18=o&19=b&20=a&21=l&22=%20&23=%3D&24=%20&25=f&26=a&27=l&28=s&29=e&service=WMS&version=1.1.1&request=GetFeatureInfo&layers=OPENTOPO%3Adatasets_view&BBOX={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&width=256&height=256&srs=EPSG%3A4326&query_layers=OPENTOPO%3Adatasets_view&info_format=application%2Fjson&x={i}&y={j}",
          maximumLevel: 18
        })
    },
    {
      name: "NGMDB Mosaic",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: ProxyUrlGenerator.generateProxyUrl("https://ngmdb-tiles.usgs.gov/arcgis/rest/services/mapview/ngmdbMosaic/ImageServer/exportImage?f=image&bbox={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&format=jpgpng&mosaicRule=%7Bascending%3Atrue%7D"),
          maximumLevel: 15
        })
    },
    {
      name: "Snow Depth",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/export?bbox={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&bboxSR=102100&imageSR=102100&format=png32&transparent=true&layers=show%3A3&f=image",
          maximumLevel: 15
        })
    },
    {
      name: "Tile Coordinates",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () => new Cesium.TileCoordinatesImageryProvider()
    }
  );
}

function setupLayers() {
  for (const layerDef of layerCatalog) {
    if (layerDef.kind === "base") {
      addBaseLayerOption(layerDef.name, layerDef.createProvider());
    } else {
      addLayerOption(
        layerDef.name,
        layerDef.createProvider(),
        layerDef.alpha,
        layerDef.show
      );
    }
  }
}
async function addBaseLayerOption(name, imageryProviderPromise) {
try {
  const imageryProvider = await Promise.resolve(
    imageryProviderPromise
  );

  const layer = new Cesium.ImageryLayer(imageryProvider);
  layer.name = name;
  baseLayers.push(layer);
  updateLayerList();
} catch (error) {
  console.error(
    `There was an error while creating ${name}. ${error}`
  );
}
}
async function addLayerOption(
name,
imageryProviderPromise,
alpha,
show
) {
try {
  const imageryProvider = await Promise.resolve(
    imageryProviderPromise
  );
  // var imageryLayer = viewer.scene.imageryLayers.addImageryProvider(imageryProvider).alpha = 0.9;
  const layer = imageryLayers.addImageryProvider(imageryProvider);
  layer.alpha = Cesium.defaultValue(alpha, 0.5);
  layer.show = Cesium.defaultValue(show, true);
  layer.name = name;
  Cesium.knockout.track(layer, ["alpha", "show", "name"]);
  updateLayerList();
} catch (error) {
  console.error(
    `There was an error while creating ${name}. ${error}`
  );
}
}


function updateLayerList() {
const numLayers = imageryLayers.length;
viewModel.layers.splice(0, viewModel.layers.length);
for (let i = numLayers - 1; i >= 0; --i) {
  viewModel.layers.push(imageryLayers.get(i));
}
// viewModel.showlidar.push();  
// console.log(cesiumViewer.dataSources);
}

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

function getAttentionKey(lonDeg, latDeg) {
  const cellDeg = ATTENTION_CELL_METERS / 111320;
  const lonKey = Math.round(lonDeg / cellDeg);
  const latKey = Math.round(latDeg / cellDeg);
  return `${lonKey},${latKey}`;
}

function unpackAttentionKey(key) {
  const parts = key.split(",");
  const cellDeg = ATTENTION_CELL_METERS / 111320;
  const lon = Number(parts[0]) * cellDeg;
  const lat = Number(parts[1]) * cellDeg;
  return { lon, lat };
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
  if (!miniMapMap || !miniMapAttentionSource) {
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

function syncMiniMapLabels() {
  if (!miniMapLabelSource) {
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
      miniMapLabelSource.addFeature(feature);
      miniMapLabelEntities.set(entity.id, feature);
    } else {
      const feature = miniMapLabelEntities.get(entity.id);
      feature.getGeometry().setCoordinates(ol.proj.fromLonLat([lon, lat]));
      feature.set("labelText", labelText);
    }
  }
  for (const [mainId, feature] of miniMapLabelEntities.entries()) {
    if (!aliveIds.has(mainId)) {
      miniMapLabelSource.removeFeature(feature);
      miniMapLabelEntities.delete(mainId);
    }
  }
}

function initMiniMapHover() {
  if (!miniMapMap || !miniMapHoverLabelElement) {
    return;
  }
  miniMapMap.on("pointermove", (event) => {
    const feature = miniMapMap.forEachFeatureAtPixel(event.pixel, (hitFeature) => hitFeature);
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
  miniMapCenterFeature = new ol.Feature({
    geometry: new ol.geom.Point(ol.proj.fromLonLat([0, 0]))
  });
  miniMapCenterFeature.setStyle(
    new ol.style.Style({
      image: new ol.style.Circle({
        radius: 4,
        fill: new ol.style.Fill({ color: "rgba(255,255,255,1)" }),
        stroke: new ol.style.Stroke({ color: "rgba(0,0,0,0.95)", width: 2 })
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
  miniMapMap = new ol.Map({
    target: "mini_map_canvas",
    layers: [miniMapBaseLayer, miniMapAttentionLayer, miniMapLabelLayer, miniMapCenterLayer],
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
  initMiniMapLayerControls();
  initMiniMapHover();
  applyMiniMapLayer("Bing Maps Aerial");
}

function sampleHeightAboveGround(positionCartographic) {
  const groundHeight = scene.globe.getHeight(positionCartographic);
  if (groundHeight === undefined || Number.isNaN(groundHeight)) {
    return Math.max(positionCartographic.height, 0);
  }
  return positionCartographic.height - groundHeight;
}

function syncMiniMapFrame(timestampMs, cameraCartographic) {
  if (!miniMapMap || !miniMapView || !cameraCartographic) {
    return;
  }

  const lonDeg = Cesium.Math.toDegrees(cameraCartographic.longitude);
  const latDeg = Cesium.Math.toDegrees(cameraCartographic.latitude);
  const heightAboveGround = Math.max(sampleHeightAboveGround(cameraCartographic), 0);
  const container = document.getElementById("mini_map_container");
  if (container) {
    container.style.display = heightAboveGround <= miniMapVisibilityHeight ? "block" : "none";
  }
  if (heightAboveGround > miniMapVisibilityHeight) {
    return;
  }

  const heading = cesiumViewer.camera.heading;
  const minimapHeight = Cesium.Math.clamp(heightAboveGround * 4.0 + 600, 800, 30000);
  miniMapCurrentRadiusMeters = minimapHeight * 0.55;

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
      addAttentionAt(lonDeg, latDeg, radiusMeters, attentionAmount);
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
    renderMiniMapAttention(lonDeg, latDeg);
    miniMapLastAttentionRenderAt = timestampMs;
  }

  if (shouldSyncLabels) {
    syncMiniMapLabels();
    miniMapLastLabelSyncAt = timestampMs;
  }

  if (shouldRenderFrame) {
    const center = ol.proj.fromLonLat([lonDeg, latDeg]);
    const zoom = Cesium.Math.clamp(17 - Math.log2(Math.max(200, minimapHeight) / 75), 3, 18);
    miniMapView.setCenter(center);
    miniMapView.setRotation(-heading);
    miniMapView.setZoom(zoom);
    miniMapCenterFeature.getGeometry().setCoordinates(center);
    miniMapLastRenderAt = timestampMs;
  }

  saveAttentionGrid(false);
  miniMapLastCameraPosition = Cesium.Cartesian3.clone(cesiumViewer.camera.positionWC, miniMapLastCameraPosition || new Cesium.Cartesian3());
  miniMapLastHeading = heading;
  miniMapLastSyncTimestamp = timestampMs;
}

buildLayerCatalog();
setupLayers();
loadAttentionGrid();
initMiniMap();
window.addEventListener("beforeunload", () => saveAttentionGrid(true));

window.addPC = function(url){

Potree.loadPointCloud(url, "test", function(e){
  let potreeScene = potreeViewer.scene;
  let pointcloudProjection = proj4.defs("EPSG:3857");
  potreeScene.addPointCloud(e.pointcloud);
  console.log(e.pointcloud);
  if (e.pointcloud.projection !== null){
    pointcloudProjection = e.pointcloud.projection;
  } else{
    console.log("Assuming PC Projection is EPSG:3857");
  }
  
  let mapProjection = proj4.defs("WGS84");
  // console.log(e.pointcloud.projection);

  window.toMap = proj4(pointcloudProjection, mapProjection);
  window.toScene = proj4(mapProjection, pointcloudProjection);

  e.pointcloud.matrixAutoUpdate = false;
  // e.pointcloud.matrix.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, Zshift, 1);
  var pcx = ((e.pointcloud.boundingBox.max.x + e.pointcloud.boundingBox.min.x)/2);
  var pcy = ((e.pointcloud.boundingBox.max.y + e.pointcloud.boundingBox.min.y)/2);
  var pcz = ((e.pointcloud.boundingBox.max.z + e.pointcloud.boundingBox.min.z)/2);
  var pcCenterC = toMap.forward([pcx,pcy,pcz]);
  var pcZscale = 1/(Math.cos((pcCenterC[1]*Math.PI)/180));
  // console.log(pcZscale);
  if (viewModel.usgsRef){
    e.pointcloud.matrix.set(1, 0, 0, 0,
                          0, 1, 0, 0,
                          0, 0, pcZscale, -32*pcZscale, //0, 0, pcZscale, -32*pcZscale,
                          0, 0, 0, 1);
} else {
e.pointcloud.matrix.set(1, 0, 0, 0,
                          0, 1, 0, 0,
                          0, 0, 1, -32*0.766, //0, 0, pcZscale, -32*pcZscale,
                          0, 0, 0, 1);
}
  

  let material = e.pointcloud.material;
  
  material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
  material.size = 0.29;
  material.weightRGB = 0;
  material.weightIntensity = 1;
  material.weightClassification = 1;
  material.intensityRange = [0,65536];
  material.intensityGamma = 3.02;
  material.intensityContrast = 0.71;
  material.intensityBrightness = 0.45;

  material.shape = Potree.PointShape.CIRCLE;
  material.activeAttributeName = "composite"; // composite
  // console.dir(e.pointcloud.material.classification);
  
  // let pointcloudProjection = "+proj=utm +zone=33 +ellps=WGS84 +datum=WGS84 +units=m +no_defs";
  {
    // proj4.defs("pointcloud", e.pointcloud.projection);
    // proj4.defs("WGS84", "+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs");
    // let toScene2 = proj4("WGS84", "pointcloud");
    
    let featureToScene2Node = (feature, color) => {
      let geometry = feature.geometry;
      
      var color = color ? color : new THREE.Color(1, 1, 1);
      
      if(feature.geometry.type === "Point"){
        let sg = new THREE.SphereGeometry(1, 18, 18);
        let sm = new THREE.MeshNormalMaterial();
        let s = new THREE.Mesh(sg, sm);
        
        let [long, lat] = geometry.coordinates;
        let pos = toScene.forward([long, lat]);
        
        s.position.set(...pos, 20);
        
        s.scale.set(10, 10, 10);
        
        return s;
      }else if(geometry.type === "LineString"){
        let coordinates = [];
        
        let min = new THREE.Vector3(Infinity, Infinity, Infinity);
        for(let i = 0; i < geometry.coordinates.length; i++){
          let [long, lat] = geometry.coordinates[i];
          let pos = toScene.forward([long, lat]);
          
          min.x = Math.min(min.x, pos[0]);
          min.y = Math.min(min.y, pos[1]);
          min.z = Math.min(min.z, 20);
          
          coordinates.push(...pos, 20);
          if(i > 0 && i < geometry.coordinates.length - 1){
            coordinates.push(...pos, 20);
          }
        }
        
        for(let i = 0; i < coordinates.length; i += 3){
          coordinates[i+0] -= min.x;
          coordinates[i+1] -= min.y;
          coordinates[i+2] -= min.z;
        }
        
        let positions = new Float32Array(coordinates);
        
        let lineGeometry = new THREE.BufferGeometry();
        lineGeometry.addAttribute("position", new THREE.BufferAttribute(positions, 3));
        
        let material = new THREE.LineBasicMaterial( { color: color} );
        let line = new THREE.LineSegments(lineGeometry, material);
        line.position.copy(min);
        
        return line;
      }else if(geometry.type === "Polygon"){
        for(let pc of geometry.coordinates){
          let coordinates = [];
          
          let min = new THREE.Vector3(Infinity, Infinity, Infinity);
          for(let i = 0; i < pc.length; i++){
            let [long, lat] = pc[i];
            let pos = toScene.forward([long, lat]);
            
            min.x = Math.min(min.x, pos[0]);
            min.y = Math.min(min.y, pos[1]);
            min.z = Math.min(min.z, 20);
            
            coordinates.push(...pos, 20);
            if(i > 0 && i < pc.length - 1){
              coordinates.push(...pos, 20);
            }
          }
          
          for(let i = 0; i < coordinates.length; i += 3){
            coordinates[i+0] -= min.x;
            coordinates[i+1] -= min.y;
            coordinates[i+2] -= min.z;
          }
          
          let positions = new Float32Array(coordinates);
          
          let lineGeometry = new THREE.BufferGeometry();
          lineGeometry.addAttribute("position", new THREE.BufferAttribute(positions, 3));
          
          let material = new THREE.LineBasicMaterial( { color: color} );
          let line = new THREE.LineSegments(lineGeometry, material);
          line.position.copy(min);
          
          return line;
        }
      }else{
        console.log("unhandled feature: ", feature);
      }
    };

    let shapeNode = new THREE.Object3D();
    potreeViewer.scene.scene.add(shapeNode);
    
    // Potree.Utils.loadShapefileFeatures(ProxyUrlGenerator.generateProxyUrl("https://feroz.us/Marbles-attempt-1.shp"), features => {
    //   for(let feature of features){
    //     let node = featureToSceneNode(feature, 0x00ff00);
    //     shapeNode.add(node);
    //   }
    // });
    

    // viewer.onGUILoaded(() => {
    //   // Add entry to object list in sidebar
    //   let tree = $(`#jstree_scene`);
    //   let parentNode = "other";
    //   let nodeID = tree.jstree('create_node', parentNode, { 
    //       "text": "shapefile", 
    //       "icon": `${Potree.resourcePath}/icons/triangle.svg`,
    //       "object": shapeNode
    //     }, 
    //     "last", false, false);
    //   tree.jstree(shapeNode.visible ? "check_node" : "uncheck_node", nodeID);
    // });
    
  }
  }
);

}
if (flags.displayPC){
  // window.addPC("http://10.3.90.211:8083/MK/ept.json");
  // window.addPC("http://localhost:8083/marbles/ept.json");
  // window.addPC("http://localhost:8083/B22_10/D/ept.json");
// window.addPC("http://localhost:8083/EMK/ept.json");
// window.addPC("http://localhost:8083/KMFA/ept.json");
// window.addPC("http://localhost:8083/BC/ept.json");
// window.addPC("http://localhost:8083/H1/ept.json");
// window.addPC("http://localhost:8083/H2/ept.json");
// window.addPC("http://localhost:8083/H3/ept.json");
// window.addPC("http://localhost:8083/H4/ept.json");
// window.addPC("http://localhost:8083/H8/ept.json");
// window.addPC("http://localhost:8083/SFK0/ept.json");
// window.addPC("http://localhost:8083/SFK1/ept.json");
// window.addPC("http://localhost:8083/SFK2/ept.json");
// window.addPC("http://localhost:8083/SFK3/ept.json");
// window.addPC("http://localhost:8083/SFK4/ept.json");
// window.addPC("http://localhost:8083/LS/ept.json");
// window.addPC("http://localhost:8083/M4/ept.json");
// window.addPC("http://localhost:8083/2IFG/ept.json");
// window.addPC("http://localhost:8083/TIFG/ept.json");
// window.addPC("http://localhost:8083/YM/ept.json");
//https://ot-process2.sdsc.edu/appEntwineEPTService1710109846278868656237/pc1710109735500
// window.addPC("https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/9262/ept.json"); // NorCal Kangaroo Mtn, Skorp?
// window.addPC(ProxyUrlGenerator.generateProxyUrl("https://ot-process2.sdsc.edu/appEntwineEPTService1714692934285-1026035806/pc1714692403090/ept.json")); // LS Bluffs North of the Marbles
// window.addPC(ProxyUrlGenerator.generateProxyUrl("https://ot-process2.sdsc.edu/appEntwineEPTService1710112615372926451108/pc1710112504574/ept.json"));
// window.addPC(ProxyUrlGenerator.generateProxyUrl("https://ot-process2.sdsc.edu/appEntwineEPTService1710113099587-473228176/pc1710112958845/ept.json"));
// window.addPC(ProxyUrlGenerator.generateProxyUrl("https://ot-process2.sdsc.edu/appEntwineEPTService1710109846278868656237/pc1710109735500/ept.json"));
//https://ot-process2.sdsc.edu/appEntwineEPTService1710113099587-473228176/pc1710112958845
//https://ot-process2.sdsc.edu/appEntwineEPTService1710112615372926451108/pc1710112504574
// window.addPC("http://localhost:8083/PC/ept.json");
// window.addPC("https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/9782/ept.json");
// window.addPC("http://localhost:8083/T2/ept.json");
}




//Bind the viewModel to the DOM elements of the UI that call for it.
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

Cesium.knockout
.getObservable(viewModel, "selectedLayer")
.subscribe(function (baseLayer) {
  // Handle changes to the drop-down base layer selector.
  let activeLayerIndex = 0;
  const numLayers = viewModel.layers.length;
  for (let i = 0; i < numLayers; ++i) {
    if (viewModel.isSelectableLayer(viewModel.layers[i])) {
      activeLayerIndex = i;
      break;
    }
  }
  const activeLayer = viewModel.layers[activeLayerIndex];
  const show = activeLayer.show;
  const alpha = activeLayer.alpha;
  imageryLayers.remove(activeLayer, false);
  imageryLayers.add(baseLayer, numLayers - activeLayerIndex - 1);
  baseLayer.show = show;
  baseLayer.alpha = alpha;
  updateLayerList();
});

Cesium.knockout.getObservable(viewModel, "showlidar").subscribe(
function (newValue) {
  cesiumViewer.dataSources._dataSources[0].show = newValue;
  // console.log(cesiumViewer.dataSources);
}
);
Cesium.knockout.getObservable(viewModel, "googleMapsOn").subscribe(
function (newValue) {
  cesiumViewer.scene.primitives._primitives[0].show = newValue;
  // cesiumViewer.scene.fog.enabled = newValue;
}
);

// disable the default event handlers
scene.screenSpaceCameraController.enableRotate = false;
scene.screenSpaceCameraController.enableTranslate = true;
scene.screenSpaceCameraController.enableZoom = true;
scene.screenSpaceCameraController.enableTilt = true;
scene.screenSpaceCameraController.enableLook = true;

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

// Allow for speed adjustment when flying
window.addEventListener('wheel', function(event)
{
if (event.deltaY < 0)
{
moverRateMultiplyer*=1.15;
}
else if (event.deltaY > 0)
{
moverRateMultiplyer/=1.15;
}
});


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
function getFlagForKeyCode(keyCode) {
switch (keyCode) {
  case "R".charCodeAt(0):
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
    return "route";
  case "B".charCodeAt(0):
    return "routePoint";
  case "K".charCodeAt(0):
    return "downloadPoints";
  case "H".charCodeAt(0):
    return "hideCesium";
  case "P".charCodeAt(0):
    return "displayPC";
  case "O".charCodeAt(0):
    return "displayCave";
  case "N".charCodeAt(0):
    return "cycleCompassStyle";
  default:
    return undefined;
}
}

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
    }else if (flagName == "cycleCompassStyle"){
      cycleCompassStyle();
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
      pointCounter +=1;
      let preview = "Point of Small interest ".concat(pointCounter.toString());
      let labelName = preview;
      // let labelName = prompt("Name", preview);
      console.log("Added point of Small interest: S".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: {
          scale: 0.75,
          text: "S".concat(labelName),
        },
        position: cesiumViewer.camera.position,
        properties: {
          isUserLabel: true
        },
        point: {},
      });
    }else if (flagName == "pointM"){ // add entity point where camera is currently located
      pointCounter +=1;
      let preview = "Point of Medium interest ".concat(pointCounter.toString());
      let labelName = prompt("Name", preview);
      console.log("Added point of Medium interest: M".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: {
          scale: 1,
          text: "M".concat(labelName),
        },
        position: cesiumViewer.camera.position,
        properties: {
          isUserLabel: true
        },
        point: {},
      });
    }else if (flagName == "pointL"){ // add entity point where camera is currently located
      pointCounter +=1;
      let preview = "Point of Large interest ".concat(pointCounter.toString());
      let labelName = prompt("Name", preview);
      console.log("Added point of Large interest: L".concat(pointCounter.toString()));
      cesiumViewer.entities.add({
        label: {
          scale: 1.5,
          text: "L".concat(labelName),
        },
        position: cesiumViewer.camera.position,
        properties: {
          isUserLabel: true
        },
        point: {},
      });
    }else if (flagName == "route"){ // startor stop recording route. If starting, add route point where camera is currently located.
      if (creatingRoute == ""){
        let preview = "Route ";
        let labelName = prompt("Press B to add route points, press V again to finish route. Name:", preview);
        console.log("Started creating Route");
        routePoints.push(cesiumViewer.camera.position.clone());
        creatingRoute = labelName;
      }else{
        routePoints = [];
        console.log("Finished creating route");
        creatingRoute = "";
      }
      
    }else if (flagName == "routePoint"){ // Adds point to route
      if (creatingRoute == ""){
        console.log("Start route to add points");
      }else{
        routePoints.push(cesiumViewer.camera.position.clone());
        console.log("Added point to route");
        cesiumViewer.entities.remove(currentEntity);
        currentEntity = cesiumViewer.entities.add({
          label: {
            scale: 1.5,
            text: creatingRoute,
            show: true,
          },
          name: creatingRoute,
          polyline: {
            positions: routePoints,
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

function downloadBlob(filename, blob) {
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

document.addEventListener(
"keyup",
function (e) {
  const flagName = getFlagForKeyCode(e.keyCode);
  if ((typeof flagName !== "undefined")&&(flagName !== "Fly")&&(flagName !== "TouchFly")&&(flagName !== "hideCesium")&&(flagName !== "showlidar")&&(flagName !== "removePC")&&(flagName !== "toggleOther")&&(flagName !== "toggleGround")&&(flagName !== "toggleVeg")&&(flagName !== "toggleLowNoise")&&(flagName !== "toggleAll")&&(flagName !== "displayPC")&&(flagName !== "displayCave")&&(flagName !== "cycleCompassStyle")) {
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
}
if (flags.showlidar){
  viewModel.showlidar = !viewModel.showlidar;
  flags.showlidar = false;
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


if (flags.Fly) {
  // Change movement speed based on the distance of the camera to the surface of the ellipsoid.
  const cameraHeight = ellipsoid.cartesianToCartographic(
    camera.position
  ).height;
  // console.log(cameraHeight);
  // sampleTerrain(viewer.terrainProvider, 5, [camera.positionCartographic])
  // .then(function(samples) {
  //   moveRate = ((cameraHeight-samples[0].height)/200.0);
    moveRate = ((cameraHeight+1000)/200.0);
    if (moveRate <0){
      moveRate = -moveRate;
    }
    if (moveRate <0.2){ // make sure we can go underground
      moveRate = 0.2;
    }

    if (moveRate > 6000){ // setting some limits
        moveRate = 6000;
    }

    if (moverRateMultiplyer > 16){
      moverRateMultiplyer = 16;
    }
    if (moverRateMultiplyer < 0.01){
      moverRateMultiplyer = 0.01;
    }

    moveRate = moveRate*moverRateMultiplyer;

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
  scene.screenSpaceCameraController.enableZoom = true;
  scene.screenSpaceCameraController.enableRotate = true;
}
});

function loop(timestamp){
  requestAnimationFrame(loop);

  // console.log(timestamp);

  // potreeViewer.update(potreeViewer.clock.getDelta(), timestamp);

  cesiumViewer.resize();
  // potreeViewer.resize();

  cesiumViewer.render();

  let cCamPosCart = ellipsoid.cartesianToCartographic(cesiumViewer.camera.position);

  let cCamLong = cCamPosCart.longitude * (180 / Math.PI);
  let cCamLat = cCamPosCart.latitude * (180 / Math.PI);
  let cCamHeight = cCamPosCart.height;
  let coords = cCamLat.toFixed(5) + ", " + cCamLong.toFixed(5);
  document.getElementById("coord_display").innerText = coords;
  document.getElementById("elev_display").innerText = "Height: " + cCamHeight.toFixed(0) + "m";
  syncMiniMapFrame(timestamp, cCamPosCart);

  if(window.toScene !== undefined){
    // do fun proj4 stuff with camera settings
    // cesiumViewer.camera.up = new Cesium.Cartesian3(0,0,1);
    // cesiumViewer.camera.up = Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Y);

    // let cCamPos = cesiumViewer.camera.positionCartographic;

    let cCamCenterObject = new Cesium.Cartesian3;
    let cCamDir = cesiumViewer.camera.direction;
    Cesium.Cartesian3.multiplyByScalar(cCamDir, 1000, cCamDir);
    Cesium.Cartesian3.add(cesiumViewer.camera.position, cCamDir, cCamCenterObject);
    
    let cCamCenterObjectPosCart = ellipsoid.cartesianToCartographic(cCamCenterObject);

    let cCamCenterObjectLong = cCamCenterObjectPosCart.longitude * (180 / Math.PI);
    let cCamCenterObjectLat = cCamCenterObjectPosCart.latitude * (180 / Math.PI);
    let cCamCenterObjectHeight = cCamCenterObjectPosCart.height;

    // console.log(cCamPosCart.height);
    // console.log(cCamCenterObjectPosCart.height);
    
    let cCamHeightCorrected = cCamHeight;
    if (viewModel.usgsRef){
    cCamHeightCorrected = cCamHeight/Math.cos(cCamPosCart.latitude);
} 
    let pCamPos = toScene.forward([cCamLong, cCamLat, cCamHeightCorrected]);

    let pCamCenterObjectPos = toScene.forward([cCamCenterObjectLong, cCamCenterObjectLat, cCamCenterObjectHeight]);

    potreeViewer.scene.view.setView(
      [pCamPos[0],pCamPos[1],pCamPos[2]],
      [pCamCenterObjectPos[0],pCamCenterObjectPos[1],pCamCenterObjectPos[2]],
    );
    potreeViewer.scene.view.pitch = cesiumViewer.camera.pitch;
    // potreeViewer.scene.view.nearValue = 0.1;
    // potreeViewer.scene.view.farValue = 100;
    // console.log(potreeViewer.scene.view.position.z, cCamHeight);
    // potreeViewer.scene.view.position.set(pCamPos[0],pCamPos[1],pCamPos[2]);
    // potreeViewer.scene.view.lookAt(pCamCenterObjectPos[0],pCamCenterObjectPos[1],pCamCenterObjectPos[2]);

    let fov = cesiumViewer.camera.frustum.fov;
    let fovy = cesiumViewer.camera.frustum.fovy;
    
    let aspect = cesiumViewer.camera.frustum.aspectRatio;
    // potreeViewer.camera.frustum.aspect = aspect;

    // console.log(cesiumViewer.camera.up);
    
    if(aspect < 1){
      let pfovy =  (180 * fov)/Math.PI;
      potreeViewer.setFOV(pfovy);
      // let fovyp = Math.PI * (potreeViewer.scene.getActiveCamera().fov / 180);
      // cesiumViewer.camera.frustum.fov = fovyp;
    }else{
      let pfovy = (180 * fovy)/Math.PI;
      potreeViewer.setFOV(pfovy);
      // let fovyp = Math.PI * (potreeViewer.scene.getActiveCamera().fov / 180);
      // let fovxp = Math.atan(Math.tan(0.5 * fovyp) * aspect) * 2
      // cesiumViewer.camera.frustum.fov = fovxp;
    }
    // console.log(potreeViewer.scene.cameraP.fov);
      // console.log("Cesium FOV: ", fov, "|Potree FOV: ", fovy);

  }

  potreeViewer.render();
  updateNorthCompass();
}
initNorthCompass();
requestAnimationFrame(loop);
