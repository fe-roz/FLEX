// The 3D north compass: a small three.js scene drawn over the globe, turned by the
// Cesium camera (heading + inclination read-out). Moved out of flex.js unchanged
// (the flex.js split, wave 1; see client/src/README.md for the pattern).
//
// Pure exports (no browser, no three.js, no Cesium), node-testable:
//   normalizeDegrees(deg) -> 0..360          getCardinalLabel(deg) -> "N" | "NE" | ...
//   cardinalPoints, compassStyles, compassSizeByStyle
// Setup (libraries are passed in, never imported):
//   setupCompass({ Cesium, THREE, cesiumViewer, ellipsoid })
//     -> { cycleCompassStyle, initNorthCompass, updateNorthCompass }
//
// window.setCompassStyle / window.cycleCompassStyle are still assigned by
// initNorthCompass(), exactly as before. Uses its own THREE (the page's one, not
// Potree's bundled copy; see docs 04-constraints).

export const cardinalPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compassStyles = [
  "needle-rose",
  "triad-gizmo",
  "orbital-rings",
  "north-beacon"
];
export const compassSizeByStyle = {
  "needle-rose": { width: 150, height: 150 },
  "triad-gizmo": { width: 140, height: 140 },
  "orbital-rings": { width: 150, height: 150 },
  "north-beacon": { width: 130, height: 130 }
};

export function normalizeDegrees(value) {
  let wrapped = value % 360;
  if (wrapped < 0) {
    wrapped += 360;
  }
  return wrapped;
}

export function getCardinalLabel(angleDegrees) {
  const index = Math.round(normalizeDegrees(angleDegrees) / 45) % 8;
  return cardinalPoints[index];
}

export function setupCompass({ Cesium, THREE, cesiumViewer, ellipsoid }) {
  let compassRenderer = null;
  let compassOverlayElement = null;
  let compassLabelElement = null;
  let compassScene = null;
  let compassCamera = null;
  let compassGroup = null;
  const compassStyleGroups = {};
  let compassStyleIndex = 2;
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

  return { cycleCompassStyle, initNorthCompass, updateNorthCompass };
}
