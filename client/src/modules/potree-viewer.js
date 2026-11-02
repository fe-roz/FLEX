// The Potree viewer: the classification scheme, `new Potree.Viewer`, its settings (EDL, FOV,
// point budget, min node size, loading limits) and the point-cloud Z matrix.
// Moved out of flex.js unchanged (flex.js split, wave 3; see client/src/README.md).
//
// Pure:  createClassificationScheme(flags), pcMatrixElements(pc, viewModel, meanSeaLevel)
// Setup (Potree passed in, never imported):
//   setupPotreeViewer({ Potree, flags })         -> { potreeViewer, ClassificationScheme }  (also window.potreeViewer)
//   createApplyPcMatrix({ viewModel, meanSeaLevel }) -> applyPcMatrix(pc)

export function createClassificationScheme(flags) {
  return {
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
}

export function setupPotreeViewer({ Potree, flags }) {
  const ClassificationScheme = createClassificationScheme(flags);

  const potreeViewer = window.potreeViewer = new Potree.Viewer(document.getElementById("potree_render_area"), {
    useDefaultRenderLoop: false
  });
  potreeViewer.setEDLEnabled(true);
  potreeViewer.setEDLRadius(3.5); //2.0
  potreeViewer.setEDLStrength(0.4);
  potreeViewer.setFOV(60);
  potreeViewer.setPointBudget(10_000_000);
  potreeViewer.classifications = ClassificationScheme;

  // Potree starts its own animation loop in its constructor
  // (viewer.js:320, setAnimationLoop) regardless of useDefaultRenderLoop - the
  // check that was supposed to gate it is commented out upstream. That loop ran
  // update() and render() every frame while FLEX's own loop rendered a second
  // time, so the cloud was drawn twice, and worse, updateVisibility picked LOD
  // nodes BEFORE the Cesium camera had been synced to Potree. LOD was being
  // decided against a camera one frame stale. FLEX drives both itself now, in
  // the right order, at the end of loop() (render-loop.js).
  potreeViewer.renderer.setAnimationLoop(null);

  // Four requests in flight starves the near field when the falloff below makes
  // it the only thing worth loading.
  Potree.maxNodesLoading = 8;

  // A node smaller than this on screen is not refined. Potree's own default
  // is 30, which is permissive enough that an oblique view spends the budget
  // on the horizon. 90 was picked in the field. The Detail slider overrides
  // this once the UI wires up; this is the value if it never does.
  potreeViewer.setMinNodeSize(90);
  potreeViewer.loadSettingsFromURL();
  potreeViewer.setBackground(null);
  potreeViewer.useHQ = false;
  // potreeViewer.setLengthUnit('m');
  potreeViewer.setDescription("");

  return { potreeViewer, ClassificationScheme };
}

// The 4x4 (row-major) Z matrix of a loaded point cloud for the current toggles.
//   egm96 ON  -> precise EGM96 geoid lookup (pcZscale + meanSeaLevel offset; credits: THIRD_PARTY.md)
//   usgsRef ON -> fixed -32 m geoid lift (original USGS correction)
//   both OFF  -> original default: scale=1, fixed -32*0.766 offset
export function pcMatrixElements(pc, viewModel, meanSeaLevel) {
  const z = pc._pcZscale || 1;
  if (viewModel.egm96) {
    const h = meanSeaLevel(pc._pcLat || 0, pc._pcLon || 0);
    return [1,0,0,0, 0,1,0,0, 0,0,z, h*z, 0,0,0,1];
  } else if (viewModel.usgsRef) {
    return [1,0,0,0, 0,1,0,0, 0,0,z, -32*z, 0,0,0,1];
  }
  return [1,0,0,0, 0,1,0,0, 0,0,1, -32*0.766, 0,0,0,1];
}

// Shared helper: apply the correct Z matrix to a loaded point cloud based on
// current toggle state.  Called at load time and on every toggle change.
export function createApplyPcMatrix({ viewModel, meanSeaLevel }) {
  return function applyPcMatrix(pc) {
    pc.matrix.set(...pcMatrixElements(pc, viewModel, meanSeaLevel));
  };
}
