// Adding point clouds: window.addPC (loads an EPT cloud into Potree and places
// it with applyPcMatrix), the interceptor that wraps it to track loaded URLs for
// the session / project workspace and to poll for the result, the "restore
// point clouds from last session" banner, and the Point Cloud list (eye / remove
// rows). Moved out of flex.js unchanged (the flex.js split, wave 2; see
// client/src/README.md for the pattern).
//
// Pure exports (no browser), node-testable:
//   pcNameFromUrl(url)  the readable cloud name (path segment before /ept.json)
//   pcUrlKey(url)       the key _pcUrlByName uses for a cloud's URL
// Setup:
//   setupPotreePointcloud({ THREE, Potree, proj4, potreeViewer, viewModel,
//                           applyPcMatrix, notifyPcLoaded, saveSession })
//     -> { renderPcList, removePc, showPcRestorePrompt, pcUrlByName }
// window.addPC is defined here, then wrapped by the interceptor, in that order.
// window.toMap / window.toScene are set by addPC when a cloud loads.
// window._renderPcList stays assigned in flex.js, at the old place.

/** Readable cloud name from its URL: the path segment before /ept.json (else the URL). */
export function pcNameFromUrl(url) {
  try {
    const parts = url.replace(/\/ept\.json.*$/i, '').split('/');
    return parts[parts.length - 1] || url;
  } catch(_) { return url; }
}

/** Key of a cloud in _pcUrlByName: the last non-empty path segment before /ept.json (else the URL). */
export function pcUrlKey(url) {
  return url.replace(/\/ept\.json.*$/i, '').split('/').filter(Boolean).pop() || url;
}

export function setupPotreePointcloud({
  THREE, Potree, proj4, potreeViewer, viewModel,
  applyPcMatrix,                 // stays in flex.js
  notifyPcLoaded, saveSession,   // session.js
} = {}) {
  window.addPC = function(url){

  // Derive a readable name from the URL: use the path segment before /ept.json
  const _pcName = pcNameFromUrl(url);

  const _loadPC = () => Potree.loadPointCloud(url, _pcName, function(e){
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
    e.pointcloud._pcZscale = pcZscale;       // stash for live toggle updates
    e.pointcloud._pcLat   = pcCenterC[1];   // stash for EGM96 reactive re-apply
    e.pointcloud._pcLon   = pcCenterC[0];
    // console.log(pcZscale);
    applyPcMatrix(e.pointcloud);
  

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

  // Potree's EptLoader fetches ept.json inside a promise nobody can catch, so an
  // unreachable cloud was an uncaught page error and nothing on screen. Fetch it
  // here first (the browser caches it for Potree) and say so if it fails.
  if (/ept\.json/i.test(url)) {
    fetch(url)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(() => _loadPC(), err => {
        console.warn(`[pointcloud] couldn't load "${_pcName}" (${url}): ${err && err.message || err}`);
        if (window._pjApi && window._pjApi.toast) window._pjApi.toast(`Couldn't load the point cloud "${_pcName}" — its server didn't answer`);
      });
  } else {
    _loadPC();
  }

  }

  // Intercept addPC to track loaded URLs for session persistence and update panel
  const _origAddPC = window.addPC;
  const _pcUrlByName = {};       // cloud name → the URL it was loaded from (project workspace)
  window.addPC = function(url) {
    try { _pcUrlByName[pcUrlKey(url)] = url; } catch (_) {}
    notifyPcLoaded(url);
    const pcsBefore = (potreeViewer?.scene?.pointclouds || []).length;
    const statusEl = document.getElementById('lp-pc-status');
    const result = _origAddPC(url);
    // Potree loads async; poll until the new cloud appears (success) or give up (failure)
    let tries = 0;
    const poll = setInterval(() => {
      const pcs = potreeViewer?.scene?.pointclouds || [];
      renderPcList();
      if (pcs.length > pcsBefore) {
        clearInterval(poll);
        if (statusEl) {
          const loaded = pcs[pcs.length - 1];
          statusEl.textContent = '✓ Loaded: ' + (loaded?.name || 'point cloud');
          statusEl.style.color = '#5d5';
        }
        // Auto-hide the LiDAR dataset footprints — no longer needed once a cloud is loaded
        if (viewModel.showlidar) viewModel.showlidar = false;
      } else if (++tries >= 30) {
        // ~9 seconds with no new cloud — likely a bad URL or CORS/proxy error
        clearInterval(poll);
        if (statusEl) {
          statusEl.textContent = '✗ Failed to load — check URL and server';
          statusEl.style.color = '#f77';
        }
      }
    }, 300);
    return result;
  };

  // Show a dismissible banner prompting to restore saved point clouds
  function showPcRestorePrompt(urls) {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;
    const n = urls.length;
    const banner = document.createElement('div');
    banner.id = 'session_pc_prompt';
    banner.className = 'alert alert-info alert-dismissible';
    banner.style.cssText = 'font-size:12px; padding:6px 12px; margin:4px 0 0; display:flex; align-items:center; gap:8px;';
    banner.innerHTML = `
      <span>Restore ${n} point cloud${n > 1 ? 's' : ''} from last session?</span>
      <button id="session_pc_yes" class="btn btn-sm btn-primary" style="padding:1px 8px; font-size:11px;">Yes</button>
      <button id="session_pc_no"  class="btn btn-sm btn-secondary" style="padding:1px 8px; font-size:11px;">No</button>
    `;
    toolbar.prepend(banner);
    document.getElementById('session_pc_yes').addEventListener('click', () => {
      urls.forEach(url => window.addPC(url));
      banner.remove();
    });
    document.getElementById('session_pc_no').addEventListener('click', () => banner.remove());
  }


  // ── Point Cloud list ──────────────────────────────────────────────────────────

  function renderPcList() {
    const container = document.getElementById('lp-pc-list');
    if (!container) return;
    const pcs = potreeViewer?.scene?.pointclouds || [];
    if (pcs.length === 0) {
      container.innerHTML = '<div class="lp-empty">No point clouds loaded</div>';
      return;
    }
    container.innerHTML = '';
    pcs.forEach((pc, i) => {
      const row = document.createElement('div');
      row.className = 'lp-row';
      const name = pc.name || pc.pcoGeometry?.url?.split('/').slice(-2, -1)[0] || `PC ${i + 1}`;
      row.innerHTML =
        `<button class="lp-eye-btn ui-eye${pc.visible !== false ? ' on' : ' half'}" title="${pc.visible !== false ? 'Hide' : 'Show'}"></button>` +
        `<span class="lp-row-name" title="${name}">${name}</span>` +
        `<button class="lp-remove-btn" title="Remove">✕</button>`;
      row.querySelector('.lp-eye-btn').addEventListener('click', () => {
        pc.visible = pc.visible === false ? true : false;
        renderPcList();
      });
      row.querySelector('.lp-remove-btn').addEventListener('click', () => removePc(pc));
      if (window._pjWs && window._pjWs.pcRow) window._pjWs.pcRow(row, _pcUrlByName[pc.name]);   // 📁 in / add to the open project
      container.appendChild(row);
    });
  }

  function removePc(pc) {
    if (window._pjWs && !window._ws.switching && _pcUrlByName[pc.name]) window._pjWs.removed('pointcloud', _pcUrlByName[pc.name]);
    const pcs = potreeViewer.scene.pointclouds;
    const children = potreeViewer.scene.scenePointCloud.children;
    const ci = children.indexOf(pc);
    if (ci !== -1) children.splice(ci, 1);
    const pi = pcs.indexOf(pc);
    if (pi !== -1) pcs.splice(pi, 1);
    renderPcList();
    saveSession();
  }

  return { renderPcList, removePc, showPcRestorePrompt, pcUrlByName: _pcUrlByName };
}
