// The cave Style panel (survey colours, stations, passage walls) and the one
// style setting applied to every loaded cave (cave_columns.js: All caves).
// Moved out of flex.js unchanged (the flex.js split, wave 1; see
// client/src/README.md for the pattern).
//
// Setup only:
//   setupCaveStylePanel({ caveImports, buildCaveStations, setCaveLayersVisible, displayUpdateRecent })
//
// Hooks defined here, as before: window._openStylePanel, _stylePassageMode,
// _stylePassageAxis, _stylePassageLrudAt, _stylePassageOpacity, _styleColorChange,
// _styleToggleSurface, _styleToggleLabels, _styleToggleStations, _styleStationColor,
// _styleStationSize, _styleSurveyToggle, _styleSurveyMarkSurface, _styleResetColors,
// _styleAll, _styleAllState, _styleClose. Redraws go through window._rerenderCave
// (cave-display.js), looked up when called.
import { SURVEY_PALETTE, defaultDisplayOptions } from './cave-display.js';
import { countLrudStations } from './cave-passages.js';

export function setupCaveStylePanel({
  caveImports: _caveImports,
  buildCaveStations: _buildCaveStations,
  setCaveLayersVisible: _setCaveLayersVisible,
  displayUpdateRecent: _displayUpdateRecent,
} = {}) {
  // ── Cave style panel ─────────────────────────────────────────────────────────
  let _styleIdx = null;

  window._openStylePanel = function(i) {
    const imp = _caveImports[i];
    if (!imp) return;
    _styleIdx = i;
    if (!imp.displayOptions) imp.displayOptions = defaultDisplayOptions(imp.parsed);
    const dopt = imp.displayOptions;
    // Ensure inline panel content is in the DOM
    const _ip = document.getElementById('cave-inline-panel');
    if (_ip && !document.getElementById('cave-inline-style')) {
      const t1 = document.getElementById('tmpl-style-panel');
      if (t1) _ip.appendChild(t1.content.cloneNode(true));
      const t2 = document.getElementById('tmpl-rectify-panel');
      if (t2) _ip.appendChild(t2.content.cloneNode(true));
    }

    document.getElementById('style-survey-name').textContent = imp.name;

    // Surface toggle
    document.getElementById('style-surface-toggle').checked = dopt.showSurface;

    // Labels toggle
    document.getElementById('style-labels-toggle').checked = dopt.showLabels;

    // Station controls
    document.getElementById('style-stations-toggle').checked = dopt.showStations !== false;
    document.getElementById('style-station-color').value = dopt.stationColor || '#ffeb3b';
    document.getElementById('style-station-size').value = dopt.stationSize || 5;
    document.getElementById('style-station-size-val').textContent = (dopt.stationSize || 5) + 'px';

    // Passage walls
    _syncPassageControls(imp);

    // Survey color list
    const list = document.getElementById('style-survey-list');
    const surveys = imp.parsed.surveys && imp.parsed.surveys.length
      ? imp.parsed.surveys
      : [{ code: '', desc: 'All segments' }];

    list.innerHTML = surveys.map((sv, si) => {
      const col = dopt.surveyColors[sv.code] || SURVEY_PALETTE[si % SURVEY_PALETTE.length];
      const label = sv.code && sv.desc ? `${sv.code} — ${sv.desc}` : sv.code || '(default)';
      const hasSurface = imp.parsed.segments.some(s => s.survey === sv.code && s.isSurface);
      const isHidden = !!(dopt.hiddenSurveys && dopt.hiddenSurveys[sv.code]);
      const isMarkedSurface = !!(dopt.surfaceSurveys && dopt.surfaceSurveys[sv.code]);
      const rowStyle = isHidden ? 'opacity:0.4;' : '';
      return `<div data-survey-code="${sv.code}" style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);${rowStyle}">
      <button class="ui-eye ui-eye-sm${isHidden ? ' half' : ' on'}" onclick="window._styleSurveyToggle('${sv.code}')" title="${isHidden ? 'Show' : 'Hide'} this survey"></button>
      <button onclick="window._styleSurveyMarkSurface('${sv.code}')" title="${isMarkedSurface ? 'Unmark as surface' : 'Mark as surface (hides with surface toggle)'}"
        style="background:none;border:none;cursor:pointer;font-size:12px;padding:0;flex-shrink:0;line-height:1;color:inherit;opacity:${isMarkedSurface ? '1' : '0.3'};">${window.icon('sun', 14)}</button>
      <input type="color" value="${col}" data-survey="${sv.code}"
        onchange="window._styleColorChange(this)"
        style="width:26px;height:20px;border:none;background:none;cursor:pointer;padding:0;border-radius:3px;flex-shrink:0;">
      <span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${isMarkedSurface ? '#ffd93d' : '#ccc'};" title="${label}">${label}</span>
      ${hasSurface ? '<span style="font-size:9px;color:rgba(255,200,80,0.6);padding:1px 4px;border:1px solid rgba(255,200,80,0.3);border-radius:2px;flex-shrink:0;">FS</span>' : ''}
    </div>`;
    }).join('');

    const _sip = document.getElementById('cave-inline-panel');
    const _sis = document.getElementById('cave-inline-style');
    const _sir = document.getElementById('cave-inline-rectify');
    if (_sip) _sip.style.display = 'block';
    if (_sis) _sis.style.display = 'block';
    if (_sir) _sir.style.display = 'none';
    { const _sil = document.getElementById('cave-inline-labels'); if (_sil) _sil.style.display = 'none'; }
    if (_sip) _sip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  function _syncPassageControls(imp) {
    const dopt = imp.displayOptions;
    const mode = dopt.passageMode || 'none';
    const nLrud = countLrudStations(imp.parsed);
    document.querySelectorAll('#style-passage-modes button').forEach(btn => {
      const on = btn.dataset.mode === mode;
      btn.style.background = on ? 'rgba(0,229,255,0.22)' : 'rgba(255,255,255,0.04)';
      btn.style.color = on ? '#fff' : 'rgba(255,255,255,0.6)';
    });
    const axis = dopt.passageUpAxis || 'vertical';
    document.querySelectorAll('#style-passage-axis button').forEach(btn => {
      const on = btn.dataset.axis === axis;
      btn.style.background = on ? 'rgba(0,229,255,0.22)' : 'rgba(255,255,255,0.04)';
      btn.style.color = on ? '#fff' : 'rgba(255,255,255,0.6)';
    });
    const at = dopt.passageLrudAt === 'to' ? 'to' : 'from';
    document.querySelectorAll('#style-passage-lrudat button').forEach(btn => {
      const on = btn.dataset.at === at;
      btn.style.background = on ? 'rgba(0,229,255,0.22)' : 'rgba(255,255,255,0.04)';
      btn.style.color = on ? '#fff' : 'rgba(255,255,255,0.6)';
    });
    const op = Math.round((dopt.passageOpacity ?? 0.55) * 100);
    const slider = document.getElementById('style-passage-opacity');
    if (slider) slider.value = op;
    const opv = document.getElementById('style-passage-opacity-val');
    if (opv) opv.textContent = op + '%';
    const note = document.getElementById('style-passage-note');
    if (note) {
      const total = imp.parsed.segments.reduce((s, sg) => s + sg.points.length, 0);
      note.textContent = nLrud
        ? `LRUD at ${nLrud} of ${total} stations${at === 'to' ? ', each drawn one shot further on (To)' : ''}. ` +
          '0/0/0/0 draws a plain 2 ft tube; other gaps blend between measured stations along each leg; legs with none get 1 ft each side.'
        : 'No LRUD data in this file; passages drawn at 1 ft each side.';
    }
  }

  window._stylePassageMode = function(mode) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.passageMode = mode;
    window._rerenderCave(_styleIdx);
    _syncPassageControls(imp);
    _displayUpdateRecent(imp);
  };

  window._stylePassageAxis = function(axis) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.passageUpAxis = axis;
    if ((imp.displayOptions.passageMode || 'none') !== 'none') window._rerenderCave(_styleIdx);
    _syncPassageControls(imp);
    _displayUpdateRecent(imp);
  };

  window._stylePassageLrudAt = function(at) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.passageLrudAt = at === 'to' ? 'to' : 'from';
    window._rerenderCave(_styleIdx);                 // walls, and the LRUD lines in the popups
    _syncPassageControls(imp);
    _displayUpdateRecent(imp);
  };

  window._stylePassageOpacity = function(input) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.passageOpacity = parseInt(input.value) / 100;
    if ((imp.displayOptions.passageMode || 'none') !== 'none') window._rerenderCave(_styleIdx);
    _displayUpdateRecent(imp);
  };

  window._styleColorChange = function(input) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.surveyColors[input.dataset.survey] = input.value;
    window._rerenderCave(_styleIdx);
    _displayUpdateRecent(imp);
  };

  window._styleToggleSurface = function(chk) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.showSurface = chk.checked;
    window._rerenderCave(_styleIdx);
    _displayUpdateRecent(imp);
  };

  window._styleToggleLabels = function(chk) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.showLabels = chk.checked;
    _buildCaveStations(imp);                 // names are created only while shown
    _displayUpdateRecent(imp);
  };

  window._styleToggleStations = function(chk) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.showStations = chk.checked;
    _buildCaveStations(imp);
    _displayUpdateRecent(imp);
  };

  window._styleStationColor = function(input) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.stationColor = input.value;
    _buildCaveStations(imp);
    _displayUpdateRecent(imp);
  };

  window._styleStationSize = function(input) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    imp.displayOptions.stationSize = parseInt(input.value);
    document.getElementById('style-station-size-val').textContent = input.value + 'px';
    _buildCaveStations(imp);
    _displayUpdateRecent(imp);
  };

  window._styleSurveyToggle = function(code) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    if (!imp.displayOptions.hiddenSurveys) imp.displayOptions.hiddenSurveys = {};
    imp.displayOptions.hiddenSurveys[code] = !imp.displayOptions.hiddenSurveys[code];
    window._rerenderCave(_styleIdx);
    _displayUpdateRecent(imp);
    window._openStylePanel(_styleIdx);  // refresh eye icons
  };

  window._styleSurveyMarkSurface = function(code) {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    if (!imp.displayOptions.surfaceSurveys) imp.displayOptions.surfaceSurveys = {};
    imp.displayOptions.surfaceSurveys[code] = !imp.displayOptions.surfaceSurveys[code];
    window._rerenderCave(_styleIdx);
    _displayUpdateRecent(imp);
    window._openStylePanel(_styleIdx);
  };

  window._styleResetColors = function() {
    const imp = _caveImports[_styleIdx];
    if (!imp) return;
    const _keepLabels = imp.displayOptions && imp.displayOptions.areaLabels;
    imp.displayOptions = defaultDisplayOptions(imp.parsed);
    if (_keepLabels) imp.displayOptions.areaLabels = _keepLabels;   // colours only
    window._rerenderCave(_styleIdx);
    _displayUpdateRecent(imp);
    window._openStylePanel(_styleIdx);  // refresh panel
  };

  // ── One style setting for every loaded cave (cave_columns.js: 🎨 All caves) ─
  // key: showStations, showLabels, stationColor, stationSize, showSurface,
  // passageMode, passageUpAxis, passageLrudAt, passageOpacity, showAreaLabels,
  // visible, resetColours. What each cave has otherwise stays its own.
  const _STYLE_STATIONS = new Set(['showStations', 'showLabels', 'stationColor', 'stationSize']);
  window._styleAll = function(key, value) {
    _caveImports.forEach((imp, i) => {
      if (!imp || !imp.parsed) return;
      const d = imp.displayOptions || (imp.displayOptions = defaultDisplayOptions(imp.parsed));
      if (key === 'visible') { window._toggleCaveImport(i, !!value); return; }
      if (key === 'resetColours') {
        const keep = d.areaLabels, show = d.showAreaLabels;
        imp.displayOptions = Object.assign(d, { surveyColors: defaultDisplayOptions(imp.parsed).surveyColors });
        if (keep) imp.displayOptions.areaLabels = keep; if (show != null) imp.displayOptions.showAreaLabels = show;
        window._rerenderCave(i);
      } else if (key === 'showAreaLabels') {
        d.showAreaLabels = !!value;
        _setCaveLayersVisible(imp);
      } else {
        d[key] = value;
        if (_STYLE_STATIONS.has(key)) _buildCaveStations(imp);
        else if (!(key === 'passageOpacity' || key === 'passageUpAxis') || (d.passageMode || 'none') !== 'none') window._rerenderCave(i);
      }
      _displayUpdateRecent(imp);
    });
    if (typeof _styleIdx === 'number' && _caveImports[_styleIdx] && document.getElementById('cave-inline-style')) window._openStylePanel(_styleIdx);
    if (window._caveCols) window._caveCols.render();
  };
  /** What the loaded caves have for a setting: the value if all agree, else 'mixed'. */
  window._styleAllState = function(key) {
    const vals = _caveImports.filter(i => i && i.parsed).map(imp => key === 'visible' ? imp.visible !== false : (imp.displayOptions || {})[key]);
    if (!vals.length) return null;
    const norm = v => (v === undefined ? null : v);
    return vals.every(v => JSON.stringify(norm(v)) === JSON.stringify(norm(vals[0]))) ? norm(vals[0]) : 'mixed';
  };

  window._styleClose = function() {
    const _sc = document.getElementById('cave-inline-style');
    if (_sc) _sc.style.display = 'none';
    const _sr = document.getElementById('cave-inline-rectify');
    if (!_sr || _sr.style.display === 'none') { const _sp = document.getElementById('cave-inline-panel'); if (_sp) _sp.style.display = 'none'; }
    _styleIdx = null;
  };
}
