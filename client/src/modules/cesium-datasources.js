// Map data sources of FLEX: the LiDAR footprint layers (USGS boundaries GeoJSON,
// the backend EPT catalog, the OpenTopography WMS layer with its click-to-query
// popup) and the Data Files list (KML / KMZ / GeoJSON overlays). Moved out of
// flex.js unchanged (the flex.js split, wave 2; see client/src/README.md).
//
// Setup:
//   setupCesiumDatasources({ Cesium, cesiumViewer, viewModel, ProxyUrlGenerator,
//                            getBackendBaseUrl, toAbsoluteUrl, notifyDataFilesChanged })
//     -> { setLidarFootprintsVisible, setOtFootprintsVisible, loadBackendCatalog,
//          _otHandleClick, loadedDataFiles, renderDataFileList, addDataFile, removeDataFile }
//
// Hooks defined here: window._addDataFile, window.addKMZ.
// Starts loading the USGS boundaries when set up (as the flex.js code did at that line).

export function setupCesiumDatasources({
  Cesium, cesiumViewer, viewModel, ProxyUrlGenerator,
  getBackendBaseUrl, toAbsoluteUrl, notifyDataFilesChanged,
} = {}) {
  if (!Cesium) throw new Error('cesium-datasources: Cesium missing');

const lidarFootprintSources = {
  usgs: null,
  backend: null,
  noaa: null
};

function setLidarFootprintsVisible(visible) {
  if (lidarFootprintSources.usgs) {
    lidarFootprintSources.usgs.show = !!visible;
  }
  if (lidarFootprintSources.backend) {
    lidarFootprintSources.backend.show = !!visible;
  }
  if (lidarFootprintSources.noaa) {
    lidarFootprintSources.noaa.show = !!visible;
  }
}

const promise = Cesium.GeoJsonDataSource.load(
  ProxyUrlGenerator.generateProxyUrl("https://usgs.entwine.io/boundaries/resources.geojson")
);
promise
  .then(function (dataSource) {
    cesiumViewer.dataSources.add(dataSource);
    lidarFootprintSources.usgs = dataSource;
    dataSource.name = "USGS Entwine Boundaries";
    dataSource.show = !!viewModel.showlidar;

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

      if (!entity.polygon) {
        continue;
      }
      //Set the polygon material to our random color.
      entity.polygon.material = color;
      //Remove the outlines.
      entity.polygon.outline = false;
      entity.polygon.extrudedHeight = 3000;
    }
  })
  .catch(function (error) {
    //Display any errrors encountered while loading.
    window.alert(error);
  });

function loadBackendCatalog() {
  const backendCatalogUrl = `${getBackendBaseUrl()}/api/v1/catalog/ept_datasets.geojson`;
  const backendCatalogPromise = Cesium.GeoJsonDataSource.load(backendCatalogUrl);
  backendCatalogPromise
    .then(function (dataSource) {
      dataSource.name = "Backend EPT Catalog";
      cesiumViewer.dataSources.add(dataSource);
      lidarFootprintSources.backend = dataSource;
      dataSource.show = !!viewModel.showlidar;
      const entities = dataSource.entities.values;
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        const properties = entity.properties;
        if (properties && properties.ept_url && properties.ept_url._value) {
          const absoluteEptUrl = toAbsoluteUrl(properties.ept_url._value);
          if (absoluteEptUrl) {
            entity.properties.addProperty("_url");
            entity.properties._url = absoluteEptUrl;
          }
        }
        if (entity.polygon) {
          entity.polygon.material = Cesium.Color.CYAN.withAlpha(0.35);
          entity.polygon.outline = false;
          entity.polygon.extrudedHeight = undefined;
        }
      }
      console.log(`Loaded backend EPT catalog with ${entities.length} feature(s).`);

    })
    .catch(function (error) {
      console.warn("Failed to load backend EPT catalog:", error);
    });
}

// ── OpenTopography WMS imagery layer ─────────────────────────────────────────

function _showToast(msg, durationMs) {
  var existing = document.getElementById('lp-ot-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.id = 'lp-ot-toast';
  Object.assign(toast.style, {
    position: 'fixed', bottom: '36px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(12,18,28,0.92)', color: '#ccc',
    border: '1px solid rgba(100,170,255,0.25)', borderRadius: '6px',
    padding: '6px 16px', fontSize: '12px', zIndex: '9997',
    boxShadow: '0 2px 12px rgba(0,0,0,0.5)', pointerEvents: 'none'
  });
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, durationMs || 4000);
}

function _otSetStatus(msg) {
  var el = document.getElementById('lp-ot-status');
  if (el) el.textContent = msg;
}

var otWmsLayer = null;

function setOtFootprintsVisible(visible) {
  if (otWmsLayer) {
    otWmsLayer.show = !!visible;
  } else if (visible) {
    loadOtWms();
  }
}

function loadOtWms() {
  _otSetStatus('WMS');
  try {
    var provider = new Cesium.WebMapServiceImageryProvider({
      url: '/ot-wms',
      layers: 'OPENTOPO:datasets_view',
      parameters: {
        transparent: 'true',
        format: 'image/png',
        CQL_FILTER: "is_global=false AND host<>'USGS'"
      },
      tileWidth: 256,
      tileHeight: 256
    });
    otWmsLayer = cesiumViewer.imageryLayers.addImageryProvider(provider);
    otWmsLayer.show = !!viewModel.showOpenTopo;
    otWmsLayer.alpha = 0.75;
    console.log('OpenTopography WMS layer added.');
  } catch(err) {
    _otSetStatus('Error');
    console.error('OpenTopography WMS error:', err);
  }
}
// ── end OpenTopography ────────────────────────────────────────────────────────
// ── OpenTopography click-to-query ─────────────────────────────────────────────

function _otShowPopup(props, screenPos) {
  var name      = props.projectname || props.name || 'Dataset';
  var host      = props.host || '';
  var urlPath   = props.url || '';
  var platform  = props.collection_platform || '';
  var startDate = (props.start_date || '').slice(0, 10);
  var isRestr   = props.is_restricted || false;
  var portalUrl = urlPath ? 'https://portal.opentopography.org' + urlPath : '';
  var noaaId = null;
  if (urlPath.indexOf('noaaID=') !== -1) {
    noaaId = urlPath.split('noaaID=')[1].split('&')[0];
  }
  var eptUrl = noaaId
    ? 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine/geoid18/' + noaaId + '/ept.json'
    : null;
  var html =
    '<div style="font-family:sans-serif;font-size:13px;">' +
    '<b style="font-size:14px;">' + name + '</b><br>' +
    (host      ? '<span style="color:#aaa;font-size:11px;">Source: ' + host + '</span><br>' : '') +
    (platform  ? '<span style="color:#aaa;font-size:11px;">' + platform + '</span><br>' : '') +
    (startDate ? '<span style="color:#aaa;font-size:11px;">Collected: ' + startDate + '</span><br>' : '') +
    (isRestr   ? '<span style="color:#f88;font-size:11px;">&#9888; Restricted</span><br>' : '') +
    '<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">';
  if (portalUrl) {
    html += '<a href="' + portalUrl + '" target="_blank" ' +
      'style="color:#6af;text-decoration:none;font-size:12px;">&#8599; View on OpenTopography</a>';
  }
  if (eptUrl) {
    html += '<button id="ot-load-ept-btn" ' +
      'style="background:#0d2a44;color:#6af;border:1px solid rgba(100,170,255,0.5);' +
      'border-radius:4px;padding:5px 10px;cursor:pointer;font-size:12px;text-align:left;">' +
      '&#8853; Load EPT in FLEX</button>';
  }
  html += '</div></div>';
  var popup = document.getElementById('ot-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'ot-popup';
    Object.assign(popup.style, {
      position: 'fixed', background: 'rgba(12,18,28,0.94)', color: '#ccc',
      border: '1px solid rgba(100,170,255,0.28)', borderRadius: '8px',
      padding: '12px 32px 12px 14px', maxWidth: '290px',
      zIndex: '9998', boxShadow: '0 4px 22px rgba(0,0,0,0.65)',
      pointerEvents: 'auto', lineHeight: '1.5'
    });
    var closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      position: 'absolute', top: '6px', right: '10px',
      cursor: 'pointer', color: '#888', fontSize: '14px', lineHeight: '1'
    });
    closeBtn.onclick = function() { popup.style.display = 'none'; };
    popup.appendChild(closeBtn);
    var content = document.createElement('div');
    content.id = 'ot-popup-content';
    popup.appendChild(content);
    document.body.appendChild(popup);
  }
  document.getElementById('ot-popup-content').innerHTML = html;
  var px = Math.min(screenPos.x + 18, window.innerWidth - 320);
  var py = Math.max(10, Math.min(screenPos.y - 20, window.innerHeight - 260));
  popup.style.left = px + 'px';
  popup.style.top  = py + 'px';
  popup.style.display = 'block';
  if (eptUrl) {
    var btn = document.getElementById('ot-load-ept-btn');
    if (btn) btn.onclick = function() {
      popup.style.display = 'none';
      window.addPC(eptUrl);
      _showToast('⏳ Loading: ' + name, 6000);
    };
  }
}

function _otHandleClick(screenPos) {
  if (!otWmsLayer || !otWmsLayer.show) return;
  var picked = cesiumViewer.scene.pick(screenPos);
  if (picked && picked.id) return;
  var ray = cesiumViewer.camera.getPickRay(screenPos);
  if (!ray) return;
  var cartesian = cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene);
  if (!cartesian) return;
  var carto = Cesium.Cartographic.fromCartesian(cartesian);
  var lon = Cesium.Math.toDegrees(carto.longitude);
  var lat = Cesium.Math.toDegrees(carto.latitude);
  var d = 0.3;
  var bbox = (lon-d) + ',' + (lat-d) + ',' + (lon+d) + ',' + (lat+d);
  var qs = '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo' +
    '&LAYERS=OPENTOPO%3Adatasets_view' +
    '&QUERY_LAYERS=OPENTOPO%3Adatasets_view' +
    '&CQL_FILTER=is_global%3Dfalse%20AND%20host%3C%3E%27USGS%27' +
    '&INFO_FORMAT=application%2Fjson' +
    '&FEATURE_COUNT=1' +
    '&X=128&Y=128&WIDTH=256&HEIGHT=256' +
    '&SRS=EPSG%3A4326' +
    '&BBOX=' + encodeURIComponent(bbox);
  fetch('/ot-wms' + qs)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.features || !data.features.length) return;
      _otShowPopup(data.features[0].properties, screenPos);
    })
    .catch(function(e) { console.warn('OT feature info error:', e); });
}
// ── end OpenTopography click-to-query ─────────────────────────────────────────

// ── Data Files list ───────────────────────────────────────────────────────────

const loadedDataFiles = [];
let _dataFileIdCounter = 0;

function renderDataFileList() {
  const container = document.getElementById('lp-data-list');
  if (!container) return;
  if (loadedDataFiles.length === 0) {
    container.innerHTML = '<div class="lp-empty">No data files loaded</div>';
    return;
  }
  container.innerHTML = '';
  loadedDataFiles.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'lp-row';
    row.innerHTML =
      `<button class="lp-eye-btn ui-eye${entry.show ? ' on' : ' half'}" title="${entry.show ? 'Hide' : 'Show'}"></button>` +
      `<span class="lp-row-name" title="${entry.label}">${entry.label}</span>` +
      `<span class="lp-badge">${entry.type}</span>` +
      `<button class="lp-remove-btn" title="Remove">✕</button>`;
    row.querySelector('.lp-eye-btn').addEventListener('click', () => {
      entry.show = !entry.show;
      if (entry.dataSource) entry.dataSource.show = entry.show;
      renderDataFileList();
    });
    row.querySelector('.lp-remove-btn').addEventListener('click', () => removeDataFile(entry.id));
    container.appendChild(row);
  });
}

async function addDataFile(fileOrUrl, label, opts = {}) {
  let ds, type, entryLabel;
  try {
    if (typeof fileOrUrl === 'string') {
      const url = fileOrUrl;
      const ext = url.split('?')[0].split('.').pop().toLowerCase();
      type = (ext === 'geojson' || ext === 'json') ? 'geojson' : (ext === 'kmz' ? 'kmz' : 'kml');
      entryLabel = label || url.split('/').pop().split('?')[0] || url;
      const proxied = url.startsWith('http') ? ProxyUrlGenerator.generateProxyUrl(url) : url;
      if (type === 'geojson' || type === 'json') {
        ds = await Cesium.GeoJsonDataSource.load(proxied);
      } else {
        ds = await Cesium.KmlDataSource.load(proxied, {
          camera: cesiumViewer.scene.camera,
          canvas: cesiumViewer.scene.canvas,
          clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN,
        });
      }
    } else {
      // File object
      const file = fileOrUrl;
      const ext = file.name.split('.').pop().toLowerCase();
      type = (ext === 'geojson' || ext === 'json') ? 'geojson' : (ext === 'kmz' ? 'kmz' : 'kml');
      entryLabel = label || file.name;
      const objectUrl = URL.createObjectURL(file);
      if (type === 'geojson' || type === 'json') {
        ds = await Cesium.GeoJsonDataSource.load(objectUrl);
      } else {
        ds = await Cesium.KmlDataSource.load(objectUrl, {
          camera: cesiumViewer.scene.camera,
          canvas: cesiumViewer.scene.canvas,
          clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN,
        });
      }
    }
    cesiumViewer.dataSources.add(ds);
    const entry = {
      id: ++_dataFileIdCounter,
      label: entryLabel,
      type,
      url: typeof fileOrUrl === 'string' ? fileOrUrl : null,
      dataSource: ds,
      show: true,
      myId: opts.myId || null,
    };
    loadedDataFiles.push(entry);
    // Outside a project, a data file is kept in My data (local files too), so it comes back.
    // Kept in My data (also with a project open: ← in 📍 Surface moves it into the project).
    if (!entry.myId && window._myData && !opts.noKeep) entry.myId = await window._myData.keepFile(fileOrUrl, entryLabel);
    renderDataFileList();
    if (window._onVectorSourcesChanged) window._onVectorSourcesChanged();
    notifyDataFilesChanged(loadedDataFiles);
  } catch (err) {
    console.error('[layers] addDataFile failed:', err);
    alert('Failed to load file: ' + err.message);
  }
}

function removeDataFile(id) {
  const idx = loadedDataFiles.findIndex(e => e.id === id);
  if (idx === -1) return;
  const entry = loadedDataFiles[idx];
  if (entry.url && window._pjWs && !window._ws.switching) window._pjWs.removed('file', entry.url);
  if (entry.myId && window._myData && !window._ws.switching) window._myData.forgetFile(entry.myId);
  if (entry.dataSource) cesiumViewer.dataSources.remove(entry.dataSource, true);
  loadedDataFiles.splice(idx, 1);
  renderDataFileList();
  if (window._onVectorSourcesChanged) window._onVectorSourcesChanged();
  notifyDataFilesChanged(loadedDataFiles);
}

window._addDataFile = function() {
  // Try file picker first, fall back to URL prompt
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.kml,.kmz,.geojson,.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (file) addDataFile(file);
  };
  input.click();
};

window.addKMZ = function() { window._addDataFile(); };


  return {
    setLidarFootprintsVisible, setOtFootprintsVisible, loadBackendCatalog, _otHandleClick,
    loadedDataFiles, renderDataFileList, addDataFile, removeDataFile,
  };
}
