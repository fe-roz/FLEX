// Cave georectification: control points that pull a placed cave onto the map
// (the rectify panel), plus the warp that moves every station by them.
// Moved out of flex.js (sections "Georectification" and "Warp algorithm").
// Behaviour unchanged.

// ── Warp algorithm (pure) ────────────────────────────────────────────────────
export function computeWarpedOffset(dE, dN, dV, controlPairsENU) {
  const N = controlPairsENU.length;
  if (N === 0) return { e: dE, n: dN, v: dV };

  if (N === 1) {
    const t = { e: controlPairsENU[0].dst.e - controlPairsENU[0].src.e,
                n: controlPairsENU[0].dst.n - controlPairsENU[0].src.n,
                v: controlPairsENU[0].dst.v - controlPairsENU[0].src.v };
    return { e: dE + t.e, n: dN + t.n, v: dV + t.v };
  }

  const srcs = controlPairsENU.map(p => p.src);
  const dsts = controlPairsENU.map(p => p.dst);
  let cx_s = 0, cy_s = 0, cx_d = 0, cy_d = 0;
  srcs.forEach(p => { cx_s += p.e; cy_s += p.n; });
  dsts.forEach(p => { cx_d += p.e; cy_d += p.n; });
  cx_s /= N; cy_s /= N; cx_d /= N; cy_d /= N;
  let ss = 0, dot = 0, cross = 0;
  for (let i = 0; i < N; i++) {
    const ax = srcs[i].e - cx_s, ay = srcs[i].n - cy_s;
    const bx = dsts[i].e - cx_d, by = dsts[i].n - cy_d;
    ss += ax*ax + ay*ay;
    dot   += ax*bx + ay*by;
    cross += ax*by - ay*bx;
  }
  const mag = Math.sqrt(dot*dot + cross*cross);
  const scale = ss > 1e-6 ? mag / ss : 1;
  const cos_t = mag > 1e-10 ? dot / mag : 1;
  const sin_t = mag > 1e-10 ? cross / mag : 0;
  const tx = cx_d - scale * (cos_t * cx_s - sin_t * cy_s);
  const ty = cy_d - scale * (sin_t * cx_s + cos_t * cy_s);

  const re = scale * (cos_t * dE - sin_t * dN) + tx;
  const rn = scale * (sin_t * dE + cos_t * dN) + ty;

  let sumWv = 0, dvv = 0;
  for (let i = 0; i < N; i++) {
    const de = dE - srcs[i].e, dn = dN - srcs[i].n;
    const d2 = de*de + dn*dn;
    if (d2 < 1e-6) { dvv = dsts[i].v - srcs[i].v; sumWv = 1; break; }
    const w = 1 / d2;
    sumWv += w;
    dvv += w * (dsts[i].v - srcs[i].v);
  }
  const rv = dV + (sumWv > 0 ? dvv / sumWv : 0);

  if (N < 3) return { e: re, n: rn, v: rv };

  const rigidSrcs = srcs.map(p => ({
    e: scale * (cos_t * p.e - sin_t * p.n) + tx,
    n: scale * (sin_t * p.e + cos_t * p.n) + ty,
  }));
  const residuals = dsts.map((d, i) => ({ e: d.e - rigidSrcs[i].e, n: d.n - rigidSrcs[i].n }));
  let sumW = 0, corrE = 0, corrN = 0;
  for (let i = 0; i < N; i++) {
    const de = re - rigidSrcs[i].e, dn = rn - rigidSrcs[i].n;
    const d2 = de*de + dn*dn;
    if (d2 < 1e-6) { corrE = residuals[i].e; corrN = residuals[i].n; sumW = 1; break; }
    const w = 1 / d2;
    sumW += w;
    corrE += w * residuals[i].e;
    corrN += w * residuals[i].n;
  }
  return { e: re + (sumW > 0 ? corrE/sumW : 0), n: rn + (sumW > 0 ? corrN/sumW : 0), v: rv };
}

// ── Setup ────────────────────────────────────────────────────────────────────

/**
 * Called by flex.js where the "Georectification" section used to be.
 */
export function setupCaveGeoref({
  Cesium, cesiumViewer, viewModel, caveImports: _caveImports,
  materialize, addPltRecent, displayUpdateRecent,
  rerenderCave, renderCaveList, caveColourChanged, buildCaveStations,
}) {
  const _addPltRecent = (...a) => addPltRecent(...a);
  const _displayUpdateRecent = (...a) => displayUpdateRecent(...a);
  const _rerenderCave = (...a) => rerenderCave(...a);
  const _renderCaveList = (...a) => renderCaveList(...a);
  const _caveColourChanged = (...a) => caveColourChanged(...a);
  const _buildCaveStations = (...a) => buildCaveStations(...a);

  // State
  let _rectifyIdx      = null;   // which _caveImports entry we're editing
  let _rectifyPending  = null;   // {station, lat, lon, elev} being positioned
  let _rectifyMarker   = null;   // temporary Cesium entity
  let _rectifyPickMode = false;  // waiting for globe click
  let _rectifyStationPickMode = false;  // waiting for station entity click

  // Open the rectify panel for survey i
  window._openRectifyPanel = function(i) {
    const imp = _caveImports[i];
    if (!imp) return;
    if (!imp.georef) { alert('This survey has no anchor set yet. Set an anchor first.'); return; }
    _rectifyIdx = i;
    // Ensure inline panel content is in the DOM
    const _ip = document.getElementById('cave-inline-panel');
    if (_ip && !document.getElementById('cave-inline-style')) {
      const t1 = document.getElementById('tmpl-style-panel');
      if (t1) _ip.appendChild(t1.content.cloneNode(true));
      const t2 = document.getElementById('tmpl-rectify-panel');
      if (t2) _ip.appendChild(t2.content.cloneNode(true));
    }

    document.getElementById('rectify-survey-name').textContent = imp.name;
    // Populate station dropdown
    const sel = document.getElementById('rectify-station-select');
    sel.innerHTML = '<option value="">-- Select station --</option>';
    (imp.parsed.stations || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name + (imp.georef.station === s.name ? ' (anchor)' : '');
      sel.appendChild(opt);
    });
    _rectifyRenderCPList();
    const _rip = document.getElementById('cave-inline-panel');
    const _rir = document.getElementById('cave-inline-rectify');
    const _ris = document.getElementById('cave-inline-style');
    if (_rip) _rip.style.display = 'block';
    if (_rir) _rir.style.display = 'block';
    if (_ris) _ris.style.display = 'none';
    { const _ril = document.getElementById('cave-inline-labels'); if (_ril) _ril.style.display = 'none'; }
    if (_rip) _rip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window._rectifyClose = function() {
    const _rc = document.getElementById('cave-inline-rectify');
    if (_rc) _rc.style.display = 'none';
    const _rs = document.getElementById('cave-inline-style');
    if (!_rs || _rs.style.display === 'none') { const _rp = document.getElementById('cave-inline-panel'); if (_rp) _rp.style.display = 'none'; }
    _rectifyIdx = null;
  };

  // Heights row (UTM caves only): shift with the point clouds, or as in the file.
  function _rectifyRenderHeights() {
    const imp = _caveImports[_rectifyIdx];
    const box = document.getElementById('rectify-heights');
    if (!box || !imp || !imp.georef) return;
    const utm = imp.georef.mode !== 'anchor';
    box.style.display = utm ? 'block' : 'none';
    if (!utm) return;
    const mode = imp.georef.heights === 'file' ? 'file' : 'pc';
    document.querySelectorAll('#rectify-heights-modes button').forEach(b => {
      const on = b.dataset.h === mode;
      b.style.background = on ? 'rgba(0,229,255,0.22)' : 'rgba(255,255,255,0.04)';
      b.style.color = on ? '#fff' : 'rgba(255,255,255,0.6)';
    });
    const note = document.getElementById('rectify-heights-note');
    if (!note) return;
    const dz = imp._heightDz || 0;
    const which = viewModel.egm96 ? 'EGM96 geoid' : viewModel.usgsRef ? 'USGS' : 'default';
    let t = mode === 'pc'
      ? `${dz <= 0 ? 'Lowered' : 'Raised'} ${Math.abs(dz).toFixed(1)} m, the same shift as the point clouds (${which}), so the cave sits with the LiDAR and the terrain.`
      : "The file's heights, unchanged.";
    if ((imp.georef.controlPoints || []).length) t += ' Control points keep their stations where you put them either way.';
    note.textContent = t;
  }
  window._rectifyHeights = function(h) {
    const imp = _caveImports[_rectifyIdx];
    if (!imp || !imp.georef) return;
    if (h === 'file') imp.georef.heights = 'file'; else delete imp.georef.heights;
    _rerenderCave(_rectifyIdx);
    _caveColourChanged();
    _rectifyRenderHeights();
    _displayUpdateRecent(imp);
    _sessionSave && _sessionSave();
  };

  // Render the control point list inside the panel
  function _rectifyRenderCPList() {
    _rectifyRenderHeights();
    const imp = _caveImports[_rectifyIdx];
    const list = document.getElementById('rectify-cp-list');
    if (!list || !imp) return;
    const cps = imp.georef.controlPoints || [];
    if (!cps.length) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:11px;padding:8px 0;">No control points yet. Select a station and click + Add.</div>';
      return;
    }
    list.innerHTML = cps.map((cp, ci) => `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <span style="font-size:11px;color:#8ecfa8;min-width:50px;font-weight:600;">${cp.station}</span>
        <span style="font-size:10px;color:#aaa;flex:1;font-family:monospace;">${cp.lat.toFixed(6)}, ${cp.lon.toFixed(6)}, ${cp.elev.toFixed(1)}m</span>
        <button onclick="window._rectifyEditCP(${ci})" style="font-size:10px;padding:1px 7px;background:rgba(80,150,255,0.15);border:1px solid rgba(80,150,255,0.3);border-radius:3px;color:#8af;cursor:pointer;">Move</button>
        <button onclick="window._rectifyRemoveCP(${ci})" style="font-size:10px;padding:1px 7px;background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.25);border-radius:3px;color:#f88;cursor:pointer;">✕</button>
      </div>`).join('');
  }

  // Start picking — hide panel, show banner, wait for globe click
  window._rectifyStartPick = function() {
    const sel = document.getElementById('rectify-station-select');
    const station = sel.value;
    if (!station) {
      const err = document.getElementById('rectify-panel-error');
      if (err) { err.textContent = 'Select a station first.'; err.style.display = 'block'; }
      return;
    }
    document.getElementById('rectify-panel-error').style.display = 'none';
    _rectifyPending = { station };
    { const _xr=document.getElementById('cave-inline-rectify'); if(_xr)_xr.style.display='none'; const _xs=document.getElementById('cave-inline-style'); if(!_xs||_xs.style.display==='none'){const _xp=document.getElementById('cave-inline-panel');if(_xp)_xp.style.display='none';} }
    _rectifyEnterPickMode();
  };

  window._rectifyEditCP = function(ci) {
    const imp = _caveImports[_rectifyIdx];
    const cp = (imp.georef.controlPoints || [])[ci];
    if (!cp) return;
    imp.georef.controlPoints.splice(ci, 1);
    _rectifyPending = { station: cp.station };
    { const _xr=document.getElementById('cave-inline-rectify'); if(_xr)_xr.style.display='none'; const _xs=document.getElementById('cave-inline-style'); if(!_xs||_xs.style.display==='none'){const _xp=document.getElementById('cave-inline-panel');if(_xp)_xp.style.display='none';} }
    _rectifyEnterPickMode();
  };

  window._rectifyRemoveCP = function(ci) {
    const imp = _caveImports[_rectifyIdx];
    if (!imp.georef.controlPoints) return;
    imp.georef.controlPoints.splice(ci, 1);
    _rectifyRenderCPList();
    _rerenderCave(_rectifyIdx);
    _sessionSave && _sessionSave();
    _rectifyUpdateRecent(_rectifyIdx);
  };

  window._rectifyPickStationOnMap = function() {
    { const _xr=document.getElementById('cave-inline-rectify'); if(_xr)_xr.style.display='none'; const _xs=document.getElementById('cave-inline-style'); if(!_xs||_xs.style.display==='none'){const _xp=document.getElementById('cave-inline-panel');if(_xp)_xp.style.display='none';} }
    _rectifyStationPickMode = true;
    // Stations switched off: show this cave's dots while picking.
    const imp = _caveImports[_rectifyIdx];
    if (imp && !imp._stationLayer) { _buildCaveStations(imp, true); imp._tempStations = true; }
    const banner = document.getElementById('rectify-station-pick-banner');
    if (banner) banner.style.display = 'block';
    cesiumViewer.canvas.style.cursor = 'pointer';
  };

  function _rectifyExitStationPickMode() {
    _rectifyStationPickMode = false;
    const imp = _caveImports[_rectifyIdx];
    if (imp && imp._tempStations) { imp._tempStations = false; _buildCaveStations(imp); }
    const banner = document.getElementById('rectify-station-pick-banner');
    if (banner) banner.style.display = 'none';
    cesiumViewer.canvas.style.cursor = '';
  }

  function _rectifyEnterPickMode() {
    _rectifyPickMode = true;
    const banner = document.getElementById('rectify-pick-banner');
    const nameEl = document.getElementById('rectify-pick-station-name');
    if (nameEl) nameEl.textContent = _rectifyPending.station;
    if (banner) banner.style.display = 'block';
    cesiumViewer.canvas.style.cursor = 'crosshair';
  }

  function _rectifyExitPickMode() {
    _rectifyPickMode = false;
    const banner = document.getElementById('rectify-pick-banner');
    if (banner) banner.style.display = 'none';
    cesiumViewer.canvas.style.cursor = '';
  }

  window._rectifyCancelAdjust = function() {
    const adj = document.getElementById('rectify-adjust-overlay');
    if (adj) adj.style.display = 'none';
    _rectifyExitPickMode();
    _rectifyExitStationPickMode();
    _rectifyRemoveMarker();
    _rectifyPending = null;
    if (_rectifyIdx !== null) {
      { const _yr=document.getElementById('cave-inline-panel'); const _yrr=document.getElementById('cave-inline-rectify'); if(_yr)_yr.style.display='block'; if(_yrr)_yrr.style.display='block'; }
    }
  };

  // Called by the globe click handler (see below)
  function _rectifyHandleGlobeClick(lon, lat, elev) {
    _rectifyExitPickMode();
    _rectifyPending.lat  = lat;
    _rectifyPending.lon  = lon;
    _rectifyPending.elev = elev;
    _rectifyPlaceMarker(lat, lon, elev);
    _rectifyShowAdjust();
  }

  function _rectifyShowAdjust() {
    const p = _rectifyPending;
    document.getElementById('rectify-adj-station').textContent = p.station;
    document.getElementById('rectify-adj-lat').textContent  = p.lat.toFixed(7);
    document.getElementById('rectify-adj-lon').textContent  = p.lon.toFixed(7);
    document.getElementById('rectify-adj-elev').textContent = p.elev.toFixed(2) + ' m';
    document.getElementById('rectify-adjust-overlay').style.display = 'block';
  }

  function _rectifyPlaceMarker(lat, lon, elev) {
    _rectifyRemoveMarker();
    _rectifyMarker = cesiumViewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, elev),
      point: { pixelSize: 14, color: Cesium.Color.fromCssColorString('#ff6e00'),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Infinity },
      label: {
        text: _rectifyPending.station,
        font: 'bold 12px sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#ff6e00'),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -20),
        disableDepthTestDistance: Infinity,
      }
    });
  }

  function _rectifyRemoveMarker() {
    if (_rectifyMarker) { cesiumViewer.entities.remove(_rectifyMarker); _rectifyMarker = null; }
  }

  // dE/dN/dV in metres, applied in ENU at current position
  window._rectifyNudge = function(dE, dN, dV) {
    if (!_rectifyPending) return;
    const step = parseFloat(document.getElementById('rectify-step-select')?.value || 1);
    const p = _rectifyPending;
    const cart = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.elev);
    const enu  = Cesium.Transforms.eastNorthUpToFixedFrame(cart);
    const nudgeECEF = Cesium.Matrix4.multiplyByPoint(enu,
      new Cesium.Cartesian3(dE * step, dN * step, dV * step), new Cesium.Cartesian3());
    const carto = Cesium.Cartographic.fromCartesian(nudgeECEF);
    p.lat  = Cesium.Math.toDegrees(carto.latitude);
    p.lon  = Cesium.Math.toDegrees(carto.longitude);
    p.elev += dV * step;
    _rectifyPlaceMarker(p.lat, p.lon, p.elev);
    _rectifyShowAdjust();
  };

  function _rectifyUpdateRecent(idx) {
    const imp = _caveImports[idx != null ? idx : _rectifyIdx];
    if (imp && imp.parsed && imp.parsed._rawText && imp.georef) {
      _addPltRecent(imp.name, imp.parsed._rawText, imp.georef, imp.displayOptions);
    }
  }

  window._rectifySaveToRecent = function() {
    _rectifyUpdateRecent(_rectifyIdx);
    const err = document.getElementById('rectify-panel-error');
    if (err) { err.style.color = '#8fa'; err.textContent = '✓ Rectification saved to recent files.'; err.style.display = 'block'; setTimeout(() => { err.style.display = 'none'; err.style.color = '#f88'; }, 2500); }
  };

  window._rectifyConfirmCP = function() {
    const p = _rectifyPending;
    if (!p || p.lat == null) return;
    const imp = _caveImports[_rectifyIdx];
    if (!imp.georef.controlPoints) imp.georef.controlPoints = [];
    imp.georef.controlPoints = imp.georef.controlPoints.filter(c => c.station !== p.station);
    imp.georef.controlPoints.push({ station: p.station, lat: p.lat, lon: p.lon, elev: p.elev });
    _rectifyRemoveMarker();
    _rectifyPending = null;
    document.getElementById('rectify-adjust-overlay').style.display = 'none';
    _rerenderCave(_rectifyIdx);
    _renderCaveList();
    _sessionSave && _sessionSave();
    _rectifyUpdateRecent(_rectifyIdx);
    { const _yr=document.getElementById('cave-inline-panel'); const _yrr=document.getElementById('cave-inline-rectify'); if(_yr)_yr.style.display='block'; if(_yrr)_yrr.style.display='block'; }
    _rectifyRenderCPList();
  };

  window._rectifyReset = function() {
    const imp = _caveImports[_rectifyIdx];
    if (!imp) return;
    if (!confirm('Remove all control points for this survey?')) return;
    imp.georef.controlPoints = [];
    _rectifyRenderCPList();
    _rerenderCave(_rectifyIdx);
    _renderCaveList();
    _sessionSave && _sessionSave();
    _rectifyUpdateRecent(_rectifyIdx);
  };

  // Wire globe click for pick mode
  (function() {
    const handler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.canvas);
    handler.setInputAction(function(click) {
      // Station-pick mode: user clicks a station entity to select it
      if (_rectifyStationPickMode) {
        const picked = cesiumViewer.scene.pick(click.position);
        if (picked && picked.id) {
          const entity = materialize(picked.id, click.position);
          const imp = _caveImports[_rectifyIdx];
          if (imp && entity.properties && entity.properties.surveyName &&
              entity.properties.surveyName.getValue() === imp.name) {
            const stName = entity.name;
            if (imp.parsed.stations.find(s => s.name === stName)) {
              _rectifyExitStationPickMode();
              // Also pre-select in dropdown for reference
              const sel = document.getElementById('rectify-station-select');
              if (sel) sel.value = stName;
              _rectifyPending = { station: stName };
              _rectifyEnterPickMode();
              return;
            }
          }
        }
        // Clicked terrain or wrong survey — ignore (user can click again or Esc)
        return;
      }
      if (!_rectifyPickMode) return;
      const ray = cesiumViewer.camera.getPickRay(click.position);
      if (!ray) return;
      const cart = cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene);
      if (!cart) return;
      const carto = Cesium.Cartographic.fromCartesian(cart);
      const lat  = Cesium.Math.toDegrees(carto.latitude);
      const lon  = Cesium.Math.toDegrees(carto.longitude);
      const elev = carto.height;
      _rectifyHandleGlobeClick(lon, lat, elev);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && (_rectifyPickMode || _rectifyStationPickMode)) { window._rectifyCancelAdjust(); }
    });
  })();
}
