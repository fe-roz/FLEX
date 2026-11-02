// Depth / distance measurement mode (V): origin at the camera, a live readout of
// vertical / horizontal / total distance, azimuth and inclination.
// Moved out of flex.js unchanged (flex.js split, wave 2; see client/src/README.md).
//
// Setup: setupMeasureMode({ Cesium, cesiumViewer, ic }) -> { toggleMeasureMode, updateMeasureDisplay, measureState }

export function setupMeasureMode({ Cesium, cesiumViewer, ic: _ic }) {

  const measureState = {
    active:     false,
    origin:     null,  // Cesium.Cartesian3
    originCart: null,  // Cesium.Cartographic
    panel:      null,  // readout DOM element
    originDiv:  null,  // HTML marker at origin
    readoutEl:  null,  // child div updated each frame
    unit:       'm',   // 'm' or 'ft'
    _last:      null,  // { total, horizontal, vertical, azimuth, inclination }
  };

  function toggleMeasureMode() {
    if (measureState.active) {
      // --- Turn off ---
      measureState.active     = false;
      measureState.origin     = null;
      measureState.originCart = null;
      if (measureState.panel) measureState.panel.style.display = 'none';
      if (measureState.originDiv) { measureState.originDiv.style.display = 'none'; }
    } else {
      // --- Turn on: snapshot current camera position as origin ---
      const pos  = cesiumViewer.camera.position.clone();
      const cart = Cesium.Cartographic.fromCartesian(pos);
      measureState.active     = true;
      measureState.origin     = pos;
      measureState.originCart = cart;
      if (measureState.panel) measureState.panel.style.display = 'block';
    }
  }

  function _copySurveyShot() {
    const s = measureState._last;
    if (!s) return;
    const factor = measureState.unit === 'ft' ? 3.28084 : 1;
    const dist = (s.total * factor).toFixed(2);
    const az   = s.azimuth.toFixed(1);
    const inc  = s.inclination.toFixed(1);
    const unit = measureState.unit;
    const text = `${dist}\t${az}\t${inc}\t(${unit})`;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('measure_copy_btn');
      if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.innerHTML = _ic('clipboard') + 'Copy'; }, 1500); }
    }).catch(() => {
      console.warn('[measure] clipboard write failed');
    });
  }

  function updateMeasureDisplay() {
    if (!measureState.active || !measureState.origin) return;

    // Lazy-create the panel (static structure — only built once)
    if (!measureState.panel) {
      const panel = document.createElement('div');
      panel.id = 'measure_panel';
      panel.style.cssText = [
        'position:fixed', 'bottom:24px', 'left:50%',
        'transform:translateX(-50%)',
        'background:rgba(10,12,18,0.88)',
        'border:1px solid rgba(255,255,255,0.25)',
        'border-radius:8px', 'padding:8px 16px',
        'color:#fff', 'font-size:13px', 'font-family:monospace',
        'z-index:25', 'pointer-events:auto',
        'white-space:nowrap', 'text-align:center',
        'box-shadow:0 4px 14px rgba(0,0,0,0.5)',
        'min-width:420px',
      ].join(';');

      // Static header row with unit toggle + copy button
      const btnStyle = [
        'font-size:11px', 'padding:1px 7px', 'margin-left:6px',
        'background:rgba(255,255,255,0.12)', 'color:#fff',
        'border:1px solid rgba(255,255,255,0.3)', 'border-radius:4px',
        'cursor:pointer',
      ].join(';');

      const header = document.createElement('div');
      header.style.cssText = 'margin-bottom:5px; display:flex; justify-content:space-between; align-items:center;';
      header.innerHTML =
        `<span style="opacity:0.6;font-size:11px;">${_ic('ruler')}Measuring from origin &nbsp;|&nbsp; press V to clear</span>` +
        `<span>` +
          `<button id="measure_unit_btn" style="${btnStyle}">[m]</button>` +
          `<button id="measure_copy_btn" style="${btnStyle}">${_ic('clipboard')}Copy</button>` +
        `</span>`;
      panel.appendChild(header);

      // Dynamic readout updated each frame
      const readout = document.createElement('div');
      readout.id = 'measure_readout';
      panel.appendChild(readout);

      document.body.appendChild(panel);
      measureState.panel    = panel;
      measureState.readoutEl = readout;

      // Unit toggle
      document.getElementById('measure_unit_btn').addEventListener('click', () => {
        measureState.unit = measureState.unit === 'm' ? 'ft' : 'm';
        document.getElementById('measure_unit_btn').textContent =
          measureState.unit === 'm' ? '[m]' : '[ft]';
      });

      // Copy button
      document.getElementById('measure_copy_btn').addEventListener('click', _copySurveyShot);

    }

    if (!measureState.originDiv) {
      const d = document.createElement('div');
      d.id = 'measure_origin_marker';
      d.style.cssText = [
        'position:fixed', 'pointer-events:none', 'z-index:24',
        'width:14px', 'height:14px',
        'border:2px solid #ff6600',
        'border-radius:50%',
        'background:rgba(255,102,0,0.35)',
        'transform:translate(-50%,-50%)',
        'box-shadow:0 0 6px rgba(255,102,0,0.8)',
      ].join(';');
      document.getElementById('html_label_container').appendChild(d);
      measureState.originDiv = d;
    }

    // Update origin marker screen position
    const originScreen = cesiumViewer.scene.cartesianToCanvasCoordinates(measureState.origin);
    if (originScreen) {
      measureState.originDiv.style.display = 'block';
      measureState.originDiv.style.left    = Math.round(originScreen.x) + 'px';
      measureState.originDiv.style.top     = Math.round(originScreen.y) + 'px';
    } else {
      measureState.originDiv.style.display = 'none';
    }

    // Compute distances
    const curPos  = cesiumViewer.camera.position;
    const curCart = Cesium.Cartographic.fromCartesian(curPos);

    const total      = Cesium.Cartesian3.distance(curPos, measureState.origin);
    const vertical   = curCart.height - measureState.originCart.height;
    const horizontal = Math.sqrt(Math.max(0, total * total - vertical * vertical));

    // Compute azimuth + inclination in ENU frame at origin
    const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(measureState.origin);
    const inv   = Cesium.Matrix4.inverseTransformation(enuTransform, new Cesium.Matrix4());
    const delta = Cesium.Cartesian3.subtract(curPos, measureState.origin, new Cesium.Cartesian3());
    const local = Cesium.Matrix4.multiplyByPointAsVector(inv, delta, new Cesium.Cartesian3());
    // local.x = East, local.y = North, local.z = Up
    const azimuth     = (Math.atan2(local.x, local.y) * 180 / Math.PI + 360) % 360;
    const inclination = Math.atan2(local.z, horizontal) * 180 / Math.PI;

    // Store for copy button
    measureState._last = { total, horizontal, vertical, azimuth, inclination };

    // Apply unit conversion for display
    const factor   = measureState.unit === 'ft' ? 3.28084 : 1;
    const unitSfx  = measureState.unit;
    const fmt      = n => (n * factor).toFixed(1) + ' ' + unitSfx;
    const vDir     = vertical < 0 ? '▼' : '▲';
    const vCol     = vertical < 0 ? '#6af' : '#fa6';

    measureState.readoutEl.innerHTML =
      `<span style="color:${vCol}">${vDir} Vert: <b>${fmt(Math.abs(vertical))}</b></span>` +
      `&nbsp;&nbsp;` +
      `<span style="color:#8f8">→ Horiz: <b>${fmt(horizontal)}</b></span>` +
      `&nbsp;&nbsp;` +
      `<span style="color:#fff">⤢ Total: <b>${fmt(total)}</b></span>` +
      `<br>` +
      `<span style="color:#fc9; font-size:12px;">` +
        `Az: <b>${azimuth.toFixed(1)}°</b>` +
        `&nbsp;&nbsp;Inc: <b>${inclination.toFixed(1)}°</b>` +
      `</span>`;
  }

  return { toggleMeasureMode, updateMeasureDisplay, measureState };
}
