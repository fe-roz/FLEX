// Layers-panel wiring that runs after Knockout owns the toolbar: the cave-survey toggle, the Scene
// section checkboxes (LiDAR / Google Maps / OpenTopo), the Point Budget and Detail / Load range / Far
// cutoff controls, and the footprint / Google tiles visibility subscribers.
// Moved out of flex.js unchanged (flex.js split, wave 3; see client/src/README.md).
//
// Pure:  formatPointBudget(v), formatFarDistance(metres)
// Setup: setupSceneControls({ Cesium, cesiumViewer, viewModel, flags, Potree, potreeViewer, savedSession,
//   setCaveSurveyVisible, setLidarFootprintsVisible, setOtFootprintsVisible, notifyPointBudgetChanged })

export function formatPointBudget(v) {
  return v >= 1_000_000 ? (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' M'
                        : (v / 1_000).toFixed(0) + ' K';
}

export function formatFarDistance(metres) {
  return metres > 0
    ? (metres / 1609.344).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' mi'
    : 'off';
}

export function setupSceneControls({
  Cesium, cesiumViewer, viewModel, flags, Potree, potreeViewer, savedSession: _savedSession,
  setCaveSurveyVisible, setLidarFootprintsVisible, setOtFootprintsVisible, notifyPointBudgetChanged,
}) {
// Cave survey toggle
{
  const caveToggle = document.getElementById('lp-cave-toggle');
  if (caveToggle) {
    if (flags.displayCave) {
      caveToggle.checked = true;
      setCaveSurveyVisible(true);
    }
    caveToggle.addEventListener('change', () => setCaveSurveyVisible(caveToggle.checked));
  }
}

// Scene section checkboxes + Point Budget slider — wire directly
{
  const lidarChk = document.getElementById('lp-showlidar-chk');
  const mapsChk  = document.getElementById('lp-googlemaps-chk');
  if (lidarChk) {
    lidarChk.checked = !!viewModel.showlidar;
    lidarChk.addEventListener('change', () => { viewModel.showlidar = lidarChk.checked; });
    // Keep in sync when [L] key toggles it
    Cesium.knockout.getObservable(viewModel, 'showlidar').subscribe(v => { lidarChk.checked = !!v; });
  }
  if (mapsChk) {
    mapsChk.checked = !!viewModel.googleMapsOn;
    mapsChk.addEventListener('change', () => { viewModel.googleMapsOn = mapsChk.checked; });
    Cesium.knockout.getObservable(viewModel, 'googleMapsOn').subscribe(v => { mapsChk.checked = !!v; });
  }
  const otChk = document.getElementById('lp-showopentopo-chk');
  if (otChk) {
    otChk.checked = !!viewModel.showOpenTopo;
    otChk.addEventListener('change', () => { viewModel.showOpenTopo = otChk.checked; });
    Cesium.knockout.getObservable(viewModel, 'showOpenTopo').subscribe(v => { otChk.checked = !!v; });
  }

  // Point Budget slider
  const budgetSlider = document.getElementById('lp-point-budget');
  const budgetLabel  = document.getElementById('lp-point-budget-label');

  function _applyPointBudget(v) {
    potreeViewer.setPointBudget(v);
    if (budgetSlider) budgetSlider.value = v;
    if (budgetLabel)  budgetLabel.textContent = formatPointBudget(v);
  }

  // Detail: minimumNodePixelSize, the smallest a node may appear before Potree
  // refuses to refine it. viewer.update() pushes this onto every point cloud
  // each frame, so it has to be set on the viewer - writing
  // pointcloud.minimumNodePixelSize directly is overwritten next frame.
  const detailSlider = document.getElementById('lp-lod-detail');
  const detailLabel  = document.getElementById('lp-lod-detail-label');
  function _applyDetail(px) {
    potreeViewer.setMinNodeSize(px);
    if (detailSlider) detailSlider.value = px;
    if (detailLabel)  detailLabel.textContent = px + ' px';
  }
  if (detailSlider) {
    _applyDetail(parseInt(detailSlider.value, 10));
    detailSlider.addEventListener('input',
      () => _applyDetail(parseInt(detailSlider.value, 10)));
  }

  // Load priority range: the knee of the loading-order falloff. Inside it a
  // node keeps its full weight; beyond it weight falls as 1/(1+(d/near)^2).
  const nearSlider = document.getElementById('lp-lod-near');
  const nearLabel  = document.getElementById('lp-lod-near-label');
  function _applyNear(metres) {
    Potree.lodNearDistance = metres;
    if (nearLabel) nearLabel.textContent = metres > 0 ? metres + ' m' : 'off';
  }
  if (nearSlider) {
    _applyNear(parseInt(nearSlider.value, 10));
    nearSlider.addEventListener('input',
      () => _applyNear(parseInt(nearSlider.value, 10)));
  }

  // Far cutoff: past this distance a node must be lodFarPenalty times larger
  // on screen before it refines, so the horizon stops eating the budget.
  const farSelect = document.getElementById('lp-lod-far');
  const farLabel  = document.getElementById('lp-lod-far-label');
  function _applyFar(metres) {
    Potree.lodFarDistance = metres;
    if (farLabel) farLabel.textContent = formatFarDistance(metres);
  }
  if (farSelect) {
    _applyFar(parseFloat(farSelect.value));
    farSelect.addEventListener('change',
      () => _applyFar(parseFloat(farSelect.value)));
  }

  if (budgetSlider) {
    // Restore saved value, or keep the hardcoded default
    const savedBudget = _savedSession?.pointBudget;
    if (savedBudget) _applyPointBudget(savedBudget);

    budgetSlider.addEventListener('input', () => {
      const v = parseInt(budgetSlider.value, 10);
      _applyPointBudget(v);
      notifyPointBudgetChanged(v);
    });
  }

}

Cesium.knockout.getObservable(viewModel, "showlidar").subscribe(
function (newValue) {
  setLidarFootprintsVisible(newValue);
}
);
Cesium.knockout.getObservable(viewModel, "showOpenTopo").subscribe(
function (newValue) {
  setOtFootprintsVisible(newValue);
}
);
Cesium.knockout.getObservable(viewModel, "googleMapsOn").subscribe(
function (newValue) {
  cesiumViewer.scene.primitives._primitives[0].show = newValue;
  // cesiumViewer.scene.fog.enabled = newValue;
}
);
}
