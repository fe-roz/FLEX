// The caves in the left panel and on the globe: the list, show / hide, drawing a
// cave (lines, station dots, leads, area labels, passage walls) in its
// placement, and "colour by" (survey / elevation / depth / difficulty / review).
// Moved out of flex.js unchanged (the flex.js split, wave 1; see
// client/src/README.md for the pattern).
//
// Pure exports (no browser, no Cesium), node-testable:
//   SURVEY_PALETTE, defaultDisplayOptions(parsed)   a new cave's display options
//   CAVE_COLOUR_MODES                              the "colour by" modes
//   fitColourRange(vals, mode, percentileRange)    the shared colour range of a set of values
//   CAVE_STATION_NEAR_LIMIT / CAVE_STATION_NEAR_M  big-cave limits for station dots
// Setup:
//   setupCaveDisplay({ ... }) -> { setCaveSurveyVisible, renderCaveList, buildCaveStations,
//        caveColourChanged, caveColourRgb, renderCaveColourUI, setCaveLayersVisible }
//
// The colour mode lives in flex.js (_caveColourMode) and is read / written
// through state.colourMode. The passage walls (cave-passages.js), the ground and
// depth grids (cave-depth.js), the leads and area labels (cave-leads-labels.js)
// and the UTM placement (cave-utm.js) come in through the setup argument.
// Hooks defined here, as before: window._rerenderCave, _flyToCave,
// _toggleCaveImport, _removeCaveImport, _toggleCaveInfo, _editCaveAnchor,
// _fetchCaveDecl, _reanchorCave, _setCaveColourMode, _caveColourModeNow.
import { lrudAtTo, effectiveLrud, stationEffectiveLrud } from './cave-passages.js';
import { caveElevAt } from './cave-depth.js';

// ── Cave display options ─────────────────────────────────────────────────────
export const SURVEY_PALETTE = [
  '#00e5ff','#ff6b6b','#ffd93d','#6bcb77','#ff922b',
  '#cc5de8','#74c0fc','#f783ac','#a9e34b','#ffa94d',
  '#66d9e8','#d9480f','#e64980','#2f9e44','#1971c2',
];

export function defaultDisplayOptions(parsed) {
  // Stations start off: thousands of dots cost frame rate, and the lines show the survey.
  const opts = { surveyColors: {}, hiddenSurveys: {}, surfaceSurveys: {}, showSurface: false, showLabels: false, showStations: false, stationColor: '#ffeb3b', stationSize: 5 };
  (parsed.surveys || []).forEach((sv, i) => {
    opts.surveyColors[sv.code] = SURVEY_PALETTE[i % SURVEY_PALETTE.length];
  });
  // Default: no surveys parsed → single color
  if (!parsed.surveys || !parsed.surveys.length) opts.surveyColors[''] = '#00e5ff';
  return opts;
}

export const CAVE_STATION_NEAR_LIMIT = 3000;   // above this many stations: dots only near the camera
export const CAVE_STATION_NEAR_M     = 1500;   // ... within this distance (m)

// Colour by: 'survey' (each survey's colour), 'elev' (elevation), 'depth'
// (depth below ground) or 'hard' (passage difficulty from the LRUDs, scored as
// in the portable viewer: cave-layers.js). Every loaded cave at once; elevation
// and depth over one shared range (2nd–98th percentile of all their stations)
// so caves compare directly. Lines, dots and walls, each vertex from its own
// drawn position, so it is right however the cave was placed.
// 'review' / 'segment': by the open project's segments — their review state,
// or a colour each (project-segments.js sets window._caveShotColour; without
// it, survey colours).
export const CAVE_COLOUR_MODES = ['survey', 'elev', 'depth', 'hard', 'review', 'segment'];

// The range the colour ramp spans for a set of values: the 2nd–98th percentile
// (percentileRange, cave-layers.js); depth always starts at the surface.
export function fitColourRange(vals, mode, percentileRange) {
  const R = percentileRange(vals);
  if (R && mode === 'depth' && R.lo < 0) R.lo = Math.min(0, R.hi - 1);   // starts at the surface
  return R;
}

export function setupCaveDisplay({
  Cesium, cesiumViewer, state,
  caveImports: _caveImports,
  ic: _ic, startGlobePick: _startGlobePick, notifyCaveVisibilityChanged,
  installLazyPick, lazyPick, addLinePrimitive, addStationLayer, removePrimitive,
  rampRgb, rampCss, percentileRange, lrudWH, steepScore, whRgb, hardLegendRows, depthBelowGround,
  pcDatumDz: _pcDatumDz, caveUtmConvertFn: _caveUtmConvertFn, computeWarpedOffset: _computeWarpedOffset,
  buildCavePassages: _buildCavePassages, removeCavePassages: _removeCavePassages, setCavePassageVisible: _setCavePassageVisible,
  caveStationPts: _caveStationPts, caveFrame: _caveFrame, caveGroundValid: _caveGroundValid, caveGround: _caveGround,
  loadedClouds: _loadedClouds, lidar: _lidar,
  isLeadEntity: _isLeadEntity, isAreaLabelEntity: _isAreaLabelEntity, areaLabelsShown: _areaLabelsShown,
  leadsVisible: _leadsVisible, areaLabelsVisible: _areaLabelsVisible, caveAreaLabelList: _caveAreaLabelList,
  addCaveLeads: _addCaveLeads, addCaveAreaLabels: _addCaveAreaLabels,
} = {}) {
  if (!Cesium) throw new Error('cave-display: Cesium missing');

  // ── Show / hide all cave survey entities ─────────────────────────────────────
  function setCaveSurveyVisible(visible) {
    for (const imp of _caveImports) {
      imp.visible = visible;
      _setCaveLayersVisible(imp);
    }
    notifyCaveVisibilityChanged(visible);
  }

  // ── Render the cave import list in the panel ──────────────────────────────────
  function _renderCaveList() {
    if (window._caveCols) window._caveCols.render();
    const list = document.getElementById('lp-cave-list');
    if (!list) return;
    if (!_caveImports.length) { list.innerHTML = ''; return; }

    list.innerHTML = _caveImports.map((imp, i) => {
      const g = imp.georef;
      let infoHtml = '';
      if (g) {
        if (g.mode === 'anchor') {
          const cpCount = (g.controlPoints && g.controlPoints.length) || 0;
          infoHtml = `
          <div style="font-size:10px; color:rgba(255,255,255,0.55); padding:5px 0 3px; border-top:1px solid rgba(255,255,255,0.08); margin-top:3px;">
            <div style="opacity:0.45; font-size:9px; margin-bottom:6px;">
              ${imp.parsed.segments.length} segs · ${imp.parsed.stations.length} stations${cpCount ? ' · <b style="color:#fd8;">' + cpCount + ' CPs</b>' : ''}
            </div>
            <div style="display:flex; gap:5px;">
              <button onclick="window._openRectifyPanel(${i})" style="font-size:11px;padding:4px 10px;background:rgba(255,200,50,0.15);border:1px solid rgba(255,200,50,0.4);color:#fd8;border-radius:4px;cursor:pointer;flex:1;" title="Georeference by pinning stations to known positions">
                ${_ic('target')}Rectify${cpCount ? ' (' + cpCount + ')' : ''}
              </button>
              <button onclick="window._openStylePanel(${i})" style="font-size:11px;padding:4px 10px;background:rgba(180,100,255,0.15);border:1px solid rgba(180,100,255,0.4);color:#c8a0ff;border-radius:4px;cursor:pointer;flex:1;" title="Survey display options">
                ${_ic('palette')}Style
              </button>
              <button onclick="window._openLabelsPanel(${i})" style="font-size:11px;padding:4px 10px;background:rgba(80,220,255,0.12);border:1px solid rgba(80,220,255,0.4);color:#8ee8ff;border-radius:4px;cursor:pointer;flex:1;" title="Name areas of the cave, placed where the camera is">
                ${_ic('tag')}Labels${_caveAreaLabelList(imp).length ? ' (' + _caveAreaLabelList(imp).length + ')' : ''}
              </button>
            </div>
            <button onclick="window._replaceCaveSurvey(${i})" style="margin-top:5px;width:100%;font-size:11px;padding:4px 10px;background:rgba(120,220,120,0.10);border:1px solid rgba(120,220,120,0.35);color:#b8f0b8;border-radius:4px;cursor:pointer;" title="Load a newer survey file (PLT, Breakout or Walls) in place of this one, keeping where it is placed, its control points and its style">
              ⟳ Replace survey file…
            </button>
          </div>`;
        } else if (g.mode === 'utm') {
          const cpCount = (g.controlPoints && g.controlPoints.length) || 0;
          const zoneShown = g.zone ?? imp.parsed.utmZone;
          infoHtml = `
          <div style="font-size:10px; color:rgba(255,255,255,0.55); padding:5px 0 3px; border-top:1px solid rgba(255,255,255,0.08); margin-top:3px;">
            <div style="opacity:0.45; font-size:9px; margin-bottom:6px;">
              UTM zone ${zoneShown}${g.south ? 'S' : 'N'} · ${imp.parsed.segments.length} segs · ${imp.parsed.stations.length} stations${cpCount ? ' · <b style="color:#fd8;">' + cpCount + ' CPs</b>' : ''}
            </div>
            <div style="display:flex; gap:5px;">
              <button onclick="window._openRectifyPanel(${i})" style="font-size:11px;padding:4px 10px;background:rgba(255,200,50,0.15);border:1px solid rgba(255,200,50,0.4);color:#fd8;border-radius:4px;cursor:pointer;flex:1;" title="Correct the placement by pinning stations to known positions">
                ${_ic('target')}Rectify${cpCount ? ' (' + cpCount + ')' : ''}
              </button>
              <button onclick="window._openStylePanel(${i})" style="font-size:11px;padding:4px 10px;background:rgba(180,100,255,0.15);border:1px solid rgba(180,100,255,0.4);color:#c8a0ff;border-radius:4px;cursor:pointer;flex:1;" title="Survey display options">
                ${_ic('palette')}Style
              </button>
              <button onclick="window._openLabelsPanel(${i})" style="font-size:11px;padding:4px 10px;background:rgba(80,220,255,0.12);border:1px solid rgba(80,220,255,0.4);color:#8ee8ff;border-radius:4px;cursor:pointer;flex:1;" title="Name areas of the cave, placed where the camera is">
                ${_ic('tag')}Labels${_caveAreaLabelList(imp).length ? ' (' + _caveAreaLabelList(imp).length + ')' : ''}
              </button>
            </div>
            <button onclick="window._replaceCaveSurvey(${i})" style="margin-top:5px;width:100%;font-size:11px;padding:4px 10px;background:rgba(120,220,120,0.10);border:1px solid rgba(120,220,120,0.35);color:#b8f0b8;border-radius:4px;cursor:pointer;" title="Load a newer survey file (PLT, Breakout or Walls) in place of this one, keeping where it is placed, its control points and its style">
              ⟳ Replace survey file…
            </button>
          </div>`;
        }
      } else {
        infoHtml = `<div style="font-size:9px; color:rgba(255,255,255,0.3); padding:3px 0; border-top:1px solid rgba(255,255,255,0.08); margin-top:3px;">No georef info stored</div>`;
      }

      return `
      <div style="padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
        <div class="lp-row" style="gap:4px;">
          <input type="checkbox" class="ui-sw ui-sw-sm" role="switch" ${imp.visible ? 'checked' : ''} onchange="window._toggleCaveImport(${i}, this.checked)" style="margin:0; flex-shrink:0;" aria-label="Show ${imp.name}">
          <span class="lp-row-name" style="font-size:10px; cursor:pointer;" title="${imp.name}" onclick="window._toggleCaveInfo(${i})">${imp.name}</span>
          <button onclick="window._flyToCave(${i})" style="background:none;border:none;color:rgba(255,255,255,0.5);cursor:pointer;font-size:12px;padding:0 2px;flex-shrink:0;" title="Fly to this cave">⌖</button>
          <button onclick="window._toggleCaveInfo(${i})" style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:11px;padding:0 2px;flex-shrink:0;" title="Info / Edit">${window.icon('info', 12)}</button>
          <button onclick="window._removeCaveImport(${i})" style="background:none;border:none;color:#f88;cursor:pointer;font-size:11px;padding:0 2px;flex-shrink:0;" title="Remove">✕</button>
        </div>
        <div id="cave-info-${i}" style="display:none; padding-left:14px;">${infoHtml}</div>
      </div>`;
    }).join('');
  }

  window._toggleCaveInfo = function(i) {
    const panel = document.getElementById(`cave-info-${i}`);
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  };

  // Cave lines and station dots are primitives with lazy pick ids: route the
  // viewer's click through cave-layers.js so they still select like entities.
  installLazyPick(cesiumViewer);

  // When a cave entity is selected on the globe, expand and highlight its survey in the list
  cesiumViewer.selectedEntityChanged.addEventListener(function(entity) {
    if (!entity) return;
    const props = entity.properties;
    if (!props) return;
    const isCave = props.isCaveSurvey && props.isCaveSurvey.getValue();
    if (!isCave) return;
    const surveyName = props.surveyName && props.surveyName.getValue();
    if (!surveyName) return;

    const idx = _caveImports.findIndex(imp => imp.name === surveyName);
    if (idx < 0) return;

    const surveyCode = props.surveyCode ? props.surveyCode.getValue() : '';

    // Open style panel for this import (or refresh if already open for it)
    window._openStylePanel(idx);

    // After the panel renders, find and highlight the matching survey color row
    requestAnimationFrame(() => {
      const list = document.getElementById('style-survey-list');
      if (!list) return;
      const rows = list.querySelectorAll('[data-survey-code]');
      rows.forEach(r => r.style.background = '');
      const target = list.querySelector(`[data-survey-code="${CSS.escape(surveyCode)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        target.style.transition = 'background 0.15s';
        target.style.background = 'rgba(255,220,80,0.25)';
        setTimeout(() => { target.style.background = ''; }, 1400);
      }
    });
  });

  window._editCaveAnchor = function(i, field, val) {
    const imp = _caveImports[i];
    if (!imp || !imp.georef) return;
    imp.georef[field] = val;
  };

  window._fetchCaveDecl = async function(i) {
    const imp = _caveImports[i];
    if (!imp || !imp.georef) return;
    const g = imp.georef;
    const inp = document.getElementById('cave-decl-input-' + i);
    if (!inp) return;
    const origColor = inp.style.color;
    inp.disabled = true;
    inp.style.color = '#aaa';
    try {
      const year = new Date().getFullYear();
      const r = await fetch('/api/declination?lat=' + g.lat + '&lon=' + g.lon + '&year=' + year);
      const data = await r.json();
      if (data.declination != null) {
        g.declination = data.declination;
        inp.value = data.declination.toFixed(2);
        inp.style.color = '#8fa';
        setTimeout(() => { inp.style.color = origColor; inp.disabled = false; }, 2000);
      } else {
        inp.style.color = '#f88';
        setTimeout(() => { inp.style.color = origColor; inp.disabled = false; }, 2000);
      }
    } catch(e) {
      inp.style.color = '#f88';
      setTimeout(() => { inp.style.color = origColor; inp.disabled = false; }, 2000);
    }
  };

  window._reanchorCave = async function(i) {
    const imp = _caveImports[i];
    if (!imp || !imp.georef || imp.georef.mode !== 'anchor') return;
    const result = await _startGlobePick('cesium');
    if (!result) return;
    imp.georef.lat  = result.lat;
    imp.georef.lon  = result.lon;
    imp.georef.elev = result.elev;
    window._rerenderCave(i);
  };
  function _removeCaveStations(imp) {
    const L = imp._stationLayer;
    if (L) { removePrimitive(cesiumViewer.scene, L.points); removePrimitive(cesiumViewer.scene, L.labels); }
    imp._stationLayer = null;
  }
  function _removeCaveLayers(imp) {
    for (const id of imp.cesiumIds) {
      const e = cesiumViewer.entities.getById(id);
      if (e) cesiumViewer.entities.remove(e);
    }
    imp.cesiumIds = [];
    removePrimitive(cesiumViewer.scene, imp._linePrim);
    imp._linePrim = null;
    _removeCaveStations(imp);
    _removeCavePassages(imp);
  }
  function _setCaveLayersVisible(imp) {
    const vis = imp.visible !== false;
    for (const id of imp.cesiumIds) {
      const e = cesiumViewer.entities.getById(id);
      if (!e) continue;
      e.show = _isLeadEntity(e) ? vis && _leadsVisible() && !e._flexHidden : _isAreaLabelEntity(e) ? _areaLabelsShown(imp) : vis;
    }
    if (imp._linePrim) imp._linePrim.show = vis;
    if (imp._stationLayer) {
      imp._stationLayer.points.show = vis;
      if (imp._stationLayer.labels) imp._stationLayer.labels.show = vis;
    }
    _setCavePassageVisible(imp, vis);
  }
  function _stationDescHtml(imp, s) {
    return [
      `<b>${s.name}</b>`,
      s.isSurface ? `<span style='color:#ffd93d'>&#9650; Surface shot</span>` : null,
      s.dist != null ? `Distance from entrance: ${s.dist.toFixed(1)} m` : null,
      s.comment ? `<i>${s.comment}</i>` : null,
      _stationHeightHtml(imp, s),
      (() => { const lr = stationEffectiveLrud(imp, s); return lr ? `Passage L/R/U/D: ${[lr.l, lr.r, lr.u, lr.d].map(v=>v.toFixed(1)).join(' / ')} m${lrudAtTo(imp) ? ' (LRUD at To)' : ''}` : null; })(),
      s.survey ? `Survey: ${s.survey}${s.surveyDesc ? ' — ' + s.surveyDesc : ''}` : null,
    ].filter(Boolean).join('<br>');
  }
  // Elevation (above sea level, as in the file) and, once the terrain above the
  // cave has been read, depth below ground.
  function _stationHeightHtml(imp, s) {
    const c = typeof imp._convertFn === 'function' ? imp._convertFn(s.n, s.e, s.v) : null;
    if (!c) return null;
    const fmt = m => `${Math.round(m).toLocaleString()} m · ${Math.round(m / 0.3048).toLocaleString()} ft`;
    const F = _caveFrame(imp), el = F ? caveElevAt(imp, F, c.x, c.y, c.z) : NaN;
    const G = _caveGroundValid(imp) && !imp._ground.none ? imp._ground : null;
    const d = G ? depthBelowGround(G, c.x, c.y, c.z) : NaN;
    return [Number.isFinite(el) ? `Elevation: ${fmt(el)}` : null,
            Number.isFinite(d) ? `Depth below ground: ${fmt(d)}` : null].filter(Boolean).join('<br>') || null;
  }
  function _shotDescHtml(imp, A, B, segLabel, surface) {
    const len = Math.hypot(B.e - A.e, B.n - A.n, B.v - A.v);
    return [
      (A.name || B.name) ? `<b>${A.name || '?'} → ${B.name || '?'}</b>` : null,
      `<b>Survey: ${segLabel}</b>`,
      surface ? `<span style='color:#ffd93d'>▲ Surface shot</span>` : null,
      `Length: ${len.toFixed(2)} m`,
      B.dist != null ? `Distance from entrance: ${B.dist.toFixed(1)} m` : null,
      (() => { const lr = effectiveLrud(imp, B, A); return lr ? `Passage L/R/U/D: ${[lr.l, lr.r, lr.u, lr.d].map(v => v.toFixed(1)).join(' / ')} m${lrudAtTo(imp) ? ' (LRUD at To)' : ''}` : null; })(),
      B.comment ? `<i>${B.comment}</i>` : null,
      `File: ${imp.name}`,
    ].filter(Boolean).join('<br>');
  }
  // Pick id for one chain of shots: a click opens the shot nearest the click.
  function _caveShotPickId(imp, seg, pts, positions, segLabel, surface) {
    return lazyPick(screenPos => {
      let k = 0, kt = 0;
      if (screenPos) {
        const toWin = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
        const scr = positions.map(p => toWin(cesiumViewer.scene, p));
        let best = Infinity;
        for (let j = 0; j + 1 < scr.length; j++) {
          const a = scr[j], b = scr[j + 1];
          if (!a || !b) continue;
          const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
          let t = L2 ? ((screenPos.x - a.x) * dx + (screenPos.y - a.y) * dy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(a.x + t * dx - screenPos.x, a.y + t * dy - screenPos.y);
          if (d < best) { best = d; k = j; kt = t; }
        }
      }
      const A = pts[k], B = pts[k + 1];
      return {
        name: (A.name && B.name) ? `${A.name} → ${B.name}` : segLabel,
        position: Cesium.Cartesian3.midpoint(positions[k], positions[k + 1], new Cesium.Cartesian3()),
        description: _shotDescHtml(imp, A, B, segLabel, surface),
        properties: { isCaveSurvey: true, surveyName: imp.name, surveyCode: seg.survey || '', isSurface: !!surface,
                      fromStation: A.name || '', toStation: B.name || '', nearStation: (kt < 0.5 ? A.name : B.name) || A.name || B.name || '' },
      };
    }, true);
  }

  // Station dots (and names, only while shown) for one cave, rebuilt on their
  // own when only they change. force: draw even with stations switched off
  // (rectify's "click a station" needs something to click).
  function _buildCaveStations(imp, force = false) {
    _removeCaveStations(imp);
    const convertFn = imp._convertFn;
    const dopt = imp.displayOptions || defaultDisplayOptions(imp.parsed);
    if (typeof convertFn !== 'function' || (!force && dopt.showStations === false)) return;
    const colourAt = _caveColourAt(imp, convertFn), hard = state.colourMode === 'hard';
    const base = Cesium.Color.fromCssColorString(dopt.stationColor || '#ffeb3b');
    const hardColour = st => { const c = whRgb(lrudWH(stationEffectiveLrud(imp, st))); return new Cesium.Color(c[0], c[1], c[2], 1); };
    const withShots = new Set(imp.parsed.segments.map(sg => sg.survey));
    const ddc = imp.parsed.stations.length > CAVE_STATION_NEAR_LIMIT
      ? new Cesium.DistanceDisplayCondition(0, CAVE_STATION_NEAR_M) : undefined;
    const seen = new Set(), dots = [];
    for (const s of imp.parsed.stations) {
      if (dopt.hiddenSurveys && dopt.hiddenSurveys[s.survey]) continue;
      const surface = s.isSurface || !!(dopt.surfaceSurveys && dopt.surfaceSurveys[s.survey])
        || !withShots.has(s.survey);               // survey has no shots → surface landmark
      if (surface && !dopt.showSurface) continue;
      const key = s.name + '|' + Math.round(s.n * 100) + '|' + Math.round(s.e * 100) + '|' + Math.round(s.v * 100);
      if (seen.has(key)) continue;                 // a station listed again where a new chain starts
      seen.add(key);
      const pos = convertFn(s.n, s.e, s.v);
      if (!pos) continue;
      dots.push({
        position: pos, color: hard ? hardColour(s) : colourAt ? colourAt(pos, 1) : base, label: s.name || '',
        id: lazyPick(() => ({ name: s.name || imp.name, position: pos, description: _stationDescHtml(imp, s),
                              properties: { isCaveSurvey: true, surveyName: imp.name, surveyCode: s.survey || '', stationName: s.name || '' } })),
      });
    }
    imp._stationLayer = addStationLayer(cesiumViewer.scene, dots, {
      pixelSize: dopt.stationSize || 5, labels: !!dopt.showLabels, ddc, show: imp.visible !== false,
    });
  }

  const _caveHookMode = () => state.colourMode === 'review' || state.colourMode === 'segment';
  let _caveColourRange = null;            // { lo, hi } metres: elevation, or depth below ground

  // Every loaded cave's stations in the current mode → the shared range.
  function _caveComputeColourRange() {
    const vals = [];
    for (const imp of _caveImports) {
      if (typeof imp._convertFn !== 'function') continue;
      if (state.colourMode === 'elev') {
        const F = _caveFrame(imp);
        if (!F) continue;
        for (const p of _caveStationPts(imp)) vals.push(caveElevAt(imp, F, p.c.x, p.c.y, p.c.z));
      } else if (state.colourMode === 'depth') {
        const G = _caveGround(imp);
        if (!G) continue;
        for (const p of _caveStationPts(imp)) if (!p.surface) vals.push(depthBelowGround(G, p.c.x, p.c.y, p.c.z));
      }
    }
    return fitColourRange(vals, state.colourMode, percentileRange);
  }

  // The colour of a drawn point for one cave: (x, y, z) → [r, g, b] (0..1), or
  // null in survey colours. Grey where it is unknown (no ground yet, off it).
  function _caveColourRgb(imp, convertFn) {
    if (state.colourMode === 'survey' || state.colourMode === 'hard' || _caveHookMode() || typeof convertFn !== 'function') return null;
    if (!_caveColourRange) _caveColourRange = _caveComputeColourRange();
    const R = _caveColourRange;
    const grey = () => rampRgb(NaN);
    if (!R) return grey;
    const lo = R.lo, span = Math.max(1e-6, R.hi - R.lo);
    if (state.colourMode === 'elev') {
      const F = _caveFrame(imp);
      if (!F) return grey;
      return (x, y, z) => rampRgb((caveElevAt(imp, F, x, y, z) - lo) / span);
    }
    const G = _caveGround(imp);
    if (!G) return grey;
    return (x, y, z) => rampRgb(1 - (depthBelowGround(G, x, y, z) - lo) / span);   // deep = cool
  }
  // The same as a Cesium colour for a world position.
  function _caveColourAt(imp, convertFn) {
    const f = _caveColourRgb(imp, convertFn);
    return f && ((c, alpha) => { const [r, g, b] = f(c.x, c.y, c.z); return new Cesium.Color(r, g, b, alpha); });
  }

  function _renderCaveColourUI() {
    document.querySelectorAll('#lp-cave-colour-modes button').forEach(b => {
      const on = b.dataset.mode === state.colourMode;
      b.style.background = on ? 'rgba(0,229,255,0.22)' : 'rgba(255,255,255,0.04)';
      b.style.color = on ? '#fff' : 'rgba(255,255,255,0.6)';
    });
    const lg = document.getElementById('lp-cave-colour-legend');
    if (!lg) return;
    if (state.colourMode === 'survey' || !_caveImports.length) { lg.style.display = 'none'; return; }
    if (_caveHookMode()) {
      const h = typeof window._caveReviewLegendHtml === 'function' ? window._caveReviewLegendHtml(state.colourMode) : '';
      lg.innerHTML = h || `<div style="font-size:9px;opacity:0.6;margin-top:2px;">Open a project to colour by its review state.</div>`;
      lg.style.display = 'block';
      return;
    }
    if (state.colourMode === 'hard') {
      lg.innerHTML = hardLegendRows().map(([bg, label]) =>
        `<div style="display:flex;align-items:center;gap:6px;font-size:9px;opacity:0.8;margin-top:2px;">
         <span style="flex:0 0 34px;height:7px;border-radius:3px;background:${bg};"></span><span>${label}</span></div>`).join('')
        + `<div style="font-size:9px;opacity:0.5;margin-top:3px;">Measured LRUDs only; walls ease between stations.</div>`;
      lg.style.display = 'block';
      return;
    }
    const R = _caveColourRange;
    const fmt = m => `${Math.round(m).toLocaleString()} m · ${Math.round(m / 0.3048).toLocaleString()} ft`;
    const note = t => `<div style="font-size:9px;opacity:0.6;margin-top:2px;">${t}</div>`;
    let html = '';
    if (state.colourMode === 'elev') {
      if (R) html = `<div style="height:7px;border-radius:3px;background:${rampCss()};"></div>
      <div style="display:flex;justify-content:space-between;font-size:9px;opacity:0.65;margin-top:2px;">
        <span>${fmt(R.lo)}</span><span>${fmt(R.hi)}</span></div>`;
    } else {
      const pending = _caveImports.some(imp => imp._groundPending);
      const noTerrain = _caveImports.some(imp => imp._ground && imp._ground.none && imp._ground.tp === cesiumViewer.terrainProvider);
      if (R) html = `<div style="height:7px;border-radius:3px;background:${rampCss(true)};"></div>
      <div style="display:flex;justify-content:space-between;font-size:9px;opacity:0.65;margin-top:2px;">
        <span>${R.lo <= 0.5 ? 'surface' : fmt(R.lo)}</span><span>${fmt(R.hi)} deep</span></div>`;
      const lidar = _caveImports.some(imp => imp._ground && imp._ground.source === 'lidar');
      const btn = (label, js, title) => `<button type="button" onclick="${js}" title="${title}" style="margin-top:4px;font-size:10px;padding:2px 7px;background:rgba(80,220,255,0.10);border:1px solid rgba(80,220,255,0.35);color:#8ee8ff;border-radius:3px;cursor:pointer;">${label}</button>`;
      if (pending) html += note('Reading the terrain above the caves…');
      else if (_lidar.busy) html += note('Reading the ground from the loaded LiDAR…');
      else if (lidar) html += note(_lidar.note || 'Ground from loaded LiDAR where it reaches, 3D terrain elsewhere.')
        + btn('Terrain only', 'window._caveDepthFromLidar(false)', 'Measure depth from the 3D terrain alone again');
      else {
        if (noTerrain) html += note(cesiumViewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider
          ? 'No 3D terrain loaded: depth below ground needs it, or the LiDAR ground (grey caves).'
          : 'Could not read the terrain for some caves (grey).');
        else if (R) html += note('Below the 3D terrain (Cesium), straight above each point.');
        if (_lidar.note) html += note(_lidar.note);
        if (_loadedClouds().length) html += btn(_ic('mountain') + 'Use the loaded LiDAR ground', 'window._caveDepthFromLidar(true)',
          'Measure depth from the ground returns (class 2) of the point clouds loaded now, where they cover the caves');
      }
    }
    lg.innerHTML = html;
    lg.style.display = html ? 'block' : 'none';
  }
  window._caveColourModeNow = () => state.colourMode;
  window._setCaveColourMode = function(mode) {
    state.colourMode = CAVE_COLOUR_MODES.includes(mode) ? mode : 'survey';
    // Depth again: try caves whose terrain read failed once more.
    if (state.colourMode === 'depth') _caveImports.forEach(imp => {
      if (imp._ground && imp._ground.failed) { imp._ground = null; imp._groundTriedFor = null; }
    });
    try { localStorage.setItem('flex.caveColour', state.colourMode); } catch (_) {}
    _caveColourRange = state.colourMode === 'survey' || _caveHookMode() ? null : _caveComputeColourRange();
    _caveImports.forEach((_, i) => window._rerenderCave(i));
    _renderCaveColourUI();
  };
  // The globe's terrain changed (a terrain patch on or off, 🗺 Layers): depth
  // grids sampled from the old terrain no longer count (_caveGroundValid checks
  // the provider), so let every cave ask again and redraw in Depth mode.
  window.addEventListener('flex-terrain-changed', () => {
    _caveImports.forEach(imp => { imp._groundTriedFor = null; });
    if (state.colourMode === 'depth') _caveImports.forEach(imp => _caveColourChanged(imp));
    _renderCaveColourUI();
  });
  // Starting state of the cave-list controls (index.html).
  _renderCaveColourUI();
  { const chk = document.getElementById('lp-cave-areas-toggle'); if (chk) chk.checked = _areaLabelsVisible(); }

  // Caves added, removed or re-placed, or a cave's ground arrived (imp): refit
  // the shared range; redraw every cave if it moved, else just `imp`.
  let _caveColourTimer = null, _caveColourDirty = new Set();
  function _caveColourChanged(imp = null) {
    if (imp) _caveColourDirty.add(imp);
    clearTimeout(_caveColourTimer);
    _caveColourTimer = setTimeout(() => {
      const dirty = _caveColourDirty;
      _caveColourDirty = new Set();
      if (state.colourMode !== 'survey' && !_caveHookMode()) {
        const R = _caveComputeColourRange(), old = _caveColourRange;
        const moved = !R !== !old || (R && (Math.abs(R.lo - old.lo) > 0.5 || Math.abs(R.hi - old.hi) > 0.5));
        if (moved) {
          _caveColourRange = R;
          _caveImports.forEach((_, i) => window._rerenderCave(i));
        } else {
          dirty.forEach(d => { const i = _caveImports.indexOf(d); if (i >= 0) window._rerenderCave(i); });
        }
      }
      _renderCaveColourUI();
    }, 200);
  }

  window._rerenderCave = function(i) {
    const imp = _caveImports[i];
    if (!imp || !imp.georef) return;
    _removeCaveLayers(imp);
    // Re-render with updated georef
    const g = imp.georef;
    let convertFn = null;
    if (g.mode === 'anchor') {
      const anchorLocal = g.station === '__first__'
        ? imp.parsed.segments[0]?.points[0]
        : imp.parsed.stations.find(s => s.name === g.station) || imp.parsed.segments[0]?.points[0];
      if (!anchorLocal) return;
      // The anchor was picked on the globe (heights above the ellipsoid); the
      // point clouds' datum shift there turns them back into elevations.
      imp._heightDz = _pcDatumDz(g.lat, g.lon);
      const anchorCart = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.elev);
      let enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(anchorCart);
      const decl = g.declination;
      if (decl != null && decl !== 0) {
        const declRad = Cesium.Math.toRadians(decl);
        const rotZ = Cesium.Matrix4.fromRotationTranslation(
          Cesium.Matrix3.fromRotationZ(declRad), Cesium.Cartesian3.ZERO);
        enuMatrix = Cesium.Matrix4.multiply(enuMatrix, rotZ, new Cesium.Matrix4());
      }
      // Build control-point pairs in survey-ENU space (for warp)
      const controlPairsENU = [];
      if (g.controlPoints && g.controlPoints.length) {
        const invENU = Cesium.Matrix4.inverseTransformation(enuMatrix, new Cesium.Matrix4());
        for (const cp of g.controlPoints) {
          const stn = imp.parsed.stations.find(s => s.name === cp.station);
          if (!stn) continue;
          const src = { e: stn.e - anchorLocal.e, n: stn.n - anchorLocal.n, v: stn.v - anchorLocal.v };
          const cpCart = Cesium.Cartesian3.fromDegrees(cp.lon, cp.lat, cp.elev);
          const cpOff  = Cesium.Cartesian3.subtract(cpCart, anchorCart, new Cesium.Cartesian3());
          const cpENU  = Cesium.Matrix4.multiplyByPointAsVector(invENU, cpOff, new Cesium.Cartesian3());
          const dst = { e: cpENU.x, n: cpENU.y, v: cpENU.z };
          controlPairsENU.push({ src, dst });
        }
      }
      convertFn = (n, e, v) => {
        let dE = e - anchorLocal.e, dN = n - anchorLocal.n, dV = v - anchorLocal.v;
        if (controlPairsENU.length) {
          const warped = _computeWarpedOffset(dE, dN, dV, controlPairsENU);
          dE = warped.e; dN = warped.n; dV = warped.v;
        }
        const off = new Cesium.Cartesian4(dE, dN, dV, 0);
        const w   = Cesium.Matrix4.multiplyByVector(enuMatrix, off, new Cesium.Cartesian4());
        return new Cesium.Cartesian3(anchorCart.x + w.x, anchorCart.y + w.y, anchorCart.z + w.z);
      };
    } else {
      convertFn = _caveUtmConvertFn(imp);   // UTM caves: file coordinates as they are
    }
    // Kept for the terrain export, which rebuilds shots and stations (with their
    // names) from the parsed survey instead of reading them back off entities.
    imp._convertFn = convertFn;
    if (convertFn) {
      // Lines: one primitive per cave, a polyline per chain of shots with a
      // colour per vertex (survey colour, or elevation). Each chain's pick id
      // turns into the clicked shot's info (see cave-layers.js).
      const dopt = imp.displayOptions || defaultDisplayOptions(imp.parsed);
      const colourAt = _caveColourAt(imp, convertFn), hard = state.colourMode === 'hard';
      const review = _caveHookMode() && typeof window._caveShotColour === 'function' ? window._caveShotColour(imp, state.colourMode) : null;
      const chains = [], allPos = [];
      for (const seg of imp.parsed.segments) {
        if (dopt.hiddenSurveys && dopt.hiddenSurveys[seg.survey]) continue;
        const _segSurface = seg.isSurface || !!(dopt.surfaceSurveys && dopt.surfaceSurveys[seg.survey]);
        if (_segSurface && !dopt.showSurface) continue;
        const _activePts = seg.points.filter(p => !p.excluded);
        if (_activePts.length < 2) continue;
        const hexColor = dopt.surveyColors[seg.survey] || dopt.surveyColors[''] || '#00e5ff';
        const alpha = _segSurface ? 0.45 : 0.9;
        const segColor = Cesium.Color.fromCssColorString(hexColor).withAlpha(alpha);
        const _segLabel = seg.survey ? (seg.survey + (seg.surveyDesc ? ' — ' + seg.surveyDesc : '')) : imp.name;
        let run = [], runPos = [];
        const width = _segSurface ? 1 : 1.5;
        const eff = hard ? new Map(seg.points.map((p, i) => [p, effectiveLrud(imp, p, seg.points[i - 1])])) : null;
        const flush = () => {
          if (runPos.length >= 2 && review) {
            // Review: a line per shot, coloured by the state of what it belongs to.
            for (let k = 0; k + 1 < run.length; k++) {
              const A = run[k], B = run[k + 1], pos = [runPos[k], runPos[k + 1]];
              const c = review(A.name, B.name, seg.survey || '') || [0.4, 0.42, 0.45];
              const col = new Cesium.Color(c[0], c[1], c[2], alpha);
              chains.push({ positions: pos, width: c[3] || width, colors: [col, col], id: _caveShotPickId(imp, seg, [A, B], pos, _segLabel, _segSurface) });
            }
          } else if (runPos.length >= 2 && hard) {
            // Difficulty: a line per shot, so each end shows its station's size
            // and the whole shot its own steepness.
            for (let k = 0; k + 1 < run.length; k++) {
              const A = run[k], B = run[k + 1], pos = [runPos[k], runPos[k + 1]];
              const st = steepScore(Math.hypot(B.e - A.e, B.n - A.n), B.v - A.v);
              chains.push({
                positions: pos, width,
                colors: [A, B].map(p => { const c = whRgb(lrudWH(eff.get(p)), st); return new Cesium.Color(c[0], c[1], c[2], alpha); }),
                id: _caveShotPickId(imp, seg, [A, B], pos, _segLabel, _segSurface),
              });
            }
          } else if (runPos.length >= 2) chains.push({
            positions: runPos, width,
            colors: colourAt ? runPos.map(c => colourAt(c, alpha)) : run.map(() => segColor),
            id: _caveShotPickId(imp, seg, run, runPos, _segLabel, _segSurface),
          });
          run = []; runPos = [];
        };
        for (const p of _activePts) {
          const c = convertFn(p.n, p.e, p.v);
          if (!c) { flush(); continue; }
          run.push(p); runPos.push(c); allPos.push(c);
        }
        flush();
      }
      imp._linePrim = addLinePrimitive(cesiumViewer.scene, chains, { show: imp.visible !== false });
      imp._bounds = allPos.length ? Cesium.BoundingSphere.fromPoints(allPos) : null;
      _buildCaveStations(imp);
      _addCaveLeads(imp, convertFn);
      if (window._flexLeads) setTimeout(() => window._flexLeads.redraw(), 0);   // FLEX leads sit at the stations as they are now
      _addCaveAreaLabels(imp, convertFn);
      _buildCavePassages(imp, convertFn);
    }
    _renderCaveList();
    console.log(g.mode === 'anchor'
      ? `[cave] Re-rendered "${imp.name}" at (${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}, ${g.elev.toFixed(0)}m)`
      : `[cave] Rendered "${imp.name}" (UTM zone ${g.zone ?? imp.parsed.utmZone})`);
  };

  window._flyToCave = function(i) {
    const imp = _caveImports[i];
    if (!imp || !imp._bounds) return;
    cesiumViewer.camera.flyToBoundingSphere(imp._bounds,
      { duration: 2.5, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), 0) });
  };

  window._toggleCaveImport = function(i, visible) {
    const imp = _caveImports[i];
    if (!imp) return;
    imp.visible = visible;
    _setCaveLayersVisible(imp);
  };

  window._removeCaveImport = function(i) {
    const imp = _caveImports[i];
    if (!imp) return;
    if (window._pjWs && !window._ws.switching) window._pjWs.removed('cave', imp.name);
    _removeCaveLayers(imp);
    _caveImports.splice(i, 1);
    _renderCaveList();
    _caveColourChanged();
    if (window._flexLeads) window._flexLeads.redraw();
    if (_caveImports.length === 0) {
      const chk = document.getElementById('lp-cave-toggle');
      if (chk) chk.checked = false;
      notifyCaveVisibilityChanged(false);
    }
  };


  return {
    setCaveSurveyVisible, renderCaveList: _renderCaveList, buildCaveStations: _buildCaveStations,
    caveColourChanged: _caveColourChanged, caveColourRgb: _caveColourRgb,
    renderCaveColourUI: _renderCaveColourUI, setCaveLayersVisible: _setCaveLayersVisible,
  };
}
