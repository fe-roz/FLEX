// Open-lead markers ("?") and the names of cave areas: the entities drawn at
// leads and area labels, and the panel that adds, renames and moves the labels.
// Moved out of flex.js unchanged (the flex.js split, wave 1; see
// client/src/README.md for the pattern).
//
// Setup only (it is all Cesium and DOM; the pure parts of this section are the
// numbers below):
//   setupCaveLeadsLabels({ ... }) -> { addCaveLeads, addCaveAreaLabels, caveAreaLabelList,
//        isLeadEntity, isAreaLabelEntity, areaLabelsShown, leadsVisible(), areaLabelsVisible() }
//
// renderCaveList / setCaveLayersVisible belong to cave-display.js, which is set up
// after this module: flex.js passes lazy wrappers. displayUpdateRecent stays in flex.js.
//
// Hooks defined here, as before: window._caveAreaLabels, _refreshAllAreaLabels
// (project.js / project_workspace.js, the terrain export, test_labels),
// _leadBillboardProps (project.js), _setCaveLeadsVisible, _setCaveAreaLabelsVisible,
// _openLabelsPanel and the _labels* panel handlers.
import { defaultDisplayOptions } from './cave-display.js';

export function setupCaveLeadsLabels({
  Cesium, cesiumViewer,
  caveImports: _caveImports,
  ic: _ic, escapeHtml: _escapeHtml,
  renderCaveList: _renderCaveList,
  setCaveLayersVisible: _setCaveLayersVisible,
  displayUpdateRecent: _displayUpdateRecent,
} = {}) {
  if (!Cesium) throw new Error('cave-leads-labels: Cesium missing');

  // ── Leads ────────────────────────────────────────────────────────────────────

  const CAVE_LEAD_NEAR_M        = 3000;   // lead markers within this distance (m)
  let _caveLeadsVisible = true;
  // ── Lead marker ──────────────────────────────────────────────────────────────
  // Just a question mark, outlined and glowing so it reads over terrain, walls and dark cave
  // alike. Drawn on a canvas at 2x; the same code is in flex.js and viewer.html.
  const LEAD_PX = 26;                       // on-screen height, CSS pixels (the export's viewer uses 40)
  const LEAD_Q  = { font: '900 {s}px system-ui, -apple-system, "Segoe UI", sans-serif',
                    fill: '#ff9f1c', stroke: 'rgba(0,0,0,.85)', sw: 0.10, glow: '#ff8f00' };
  function drawLeadIcon(px) {
    const W = Math.max(8, Math.round(px * 2));
    const c = document.createElement('canvas');
    c.width = W; c.height = W;
    const g = c.getContext('2d');
    const size = W * 0.92;
    g.font = LEAD_Q.font.replace('{s}', size);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    const x = W / 2, y = W / 2 + W * 0.04;
    g.shadowColor = LEAD_Q.glow; g.shadowBlur = W * 0.18;      // soft orange glow
    g.lineWidth = size * LEAD_Q.sw; g.strokeStyle = LEAD_Q.stroke; g.strokeText('?', x, y);
    g.shadowBlur = 0;
    g.fillStyle = LEAD_Q.fill; g.fillText('?', x, y);
    return c;
  }

  let _leadIconCanvas = null;
  function _leadBillboardProps() {
    if (!_leadIconCanvas) _leadIconCanvas = drawLeadIcon(LEAD_PX);
    return { image: _leadIconCanvas, width: LEAD_PX, height: LEAD_PX,
             verticalOrigin: Cesium.VerticalOrigin.BOTTOM };
  }

  window._leadBillboardProps = () => _leadBillboardProps();   // project.js: the same "?" as file leads and FLEX Field

  function _isLeadEntity(e) {
    return !!(e && e.properties && e.properties.isCaveLead && e.properties.isCaveLead.getValue());
  }

  // Open leads (from a Breakout file) as markers at their stations. Done leads
  // stay in the data but are not drawn.
  function _addCaveLeads(imp, convertFn) {
    const leads = (imp.parsed.leads || []).filter(l => !l.done);
    if (!leads.length) return;
    const byName = new Map();
    for (const st of imp.parsed.stations) if (!byName.has(st.name)) byName.set(st.name, st);
    const ddc = new Cesium.DistanceDisplayCondition(0, CAVE_LEAD_NEAR_M);
    const size = (w, h) => {
      const one = v => `${v.toFixed(1)} m (${(v / 0.3048).toFixed(0)} ft)`;
      if (w != null && h != null) return `${one(h)} high × ${one(w)} wide`;
      if (w != null) return `${one(w)} wide`;
      if (h != null) return `${one(h)} high`;
      return null;
    };
    for (const ld of leads) {
      const st = byName.get(ld.station);
      if (!st) continue;
      const pos = convertFn(st.n, st.e, st.v);
      if (!pos) continue;
      const e = cesiumViewer.entities.add({
        name: `Lead at ${ld.station}`,
        position: pos,
        show: imp.visible && _caveLeadsVisible,
        billboard: { ..._leadBillboardProps(), disableDepthTestDistance: 5000, distanceDisplayCondition: ddc },
        // Lead text comes from the data file and the InfoBox runs unsandboxed: escape it.
        description: [
          `<b>Lead at ${_escapeHtml(ld.station)}</b>`,
          ld.d ? _escapeHtml(ld.d) : null,
          size(ld.w ?? null, ld.h ?? null),
          ld.t ? `Noted ${_escapeHtml(ld.t)}` : null,
          `Cave: ${_escapeHtml(imp.name)}`,
        ].filter(Boolean).join('<br>'),
        properties: { isCaveSurvey: true, isCaveLead: true, surveyName: imp.name },
      });
      imp.cesiumIds.push(e.id);
    }
  }

  // ── Area labels ──────────────────────────────────────────────────────────────
  // Names for parts of a cave ("Big Room", "Test hall"), placed by flying the
  // camera to the spot and pressing Add. Each is stored in the cave's own survey
  // coordinates (n/e/v metres, like its stations), so it follows rectify and
  // restyles. A cave of the open project keeps them in the project
  // (project_workspace.js `window._pjLabels`: straight in, undo in History,
  // they travel with it); any other cave in its displayOptions, so My data keeps
  // them. The terrain export carries them to the portable viewer.
  const AREA_LABEL_COLOR = '#7fe7ff';
  let _labelsIdx = null;
  const _labelsStore = imp => (imp && window._pjLabels && window._pjLabels.owns(imp.name) ? window._pjLabels : null);
  /** A cave's area labels, wherever they are kept: [{ text, n, e, v, id? }]. */
  function _caveAreaLabelList(imp) {
    const st = _labelsStore(imp);
    return st ? st.list(imp.name) : (imp && imp.displayOptions && imp.displayOptions.areaLabels) || [];
  }
  window._caveAreaLabels = _caveAreaLabelList;      // the terrain export (index.html), tests
  window._refreshAllAreaLabels = () => {
    _caveImports.forEach(imp => { if (imp && imp.parsed) _refreshCaveAreaLabels(imp); });
    if (_labelsIdx != null) _labelsRenderList();
    _renderCaveList();
  };

  function _addCaveAreaLabels(imp, convertFn) {
    imp._areaLabelIds = [];
    const labels = _caveAreaLabelList(imp);
    for (const lb of labels) {
      const pos = convertFn(lb.n, lb.e, lb.v);
      if (!pos) continue;
      const e = cesiumViewer.entities.add({
        name: lb.text, position: pos, show: _areaLabelsShown(imp),
        label: { text: lb.text, font: '600 15px sans-serif',
          fillColor: Cesium.Color.fromCssColorString(AREA_LABEL_COLOR),
          outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY },
        description: `<b>${_escapeHtml(lb.text)}</b><br>Cave: ${_escapeHtml(imp.name)}`,
        properties: { isCaveSurvey: true, isCaveAreaLabel: true, surveyName: imp.name },
      });
      imp.cesiumIds.push(e.id);
      imp._areaLabelIds.push(e.id);
    }
  }

  // Redraw only the labels: re-rendering a big cave for one label is slow.
  function _refreshCaveAreaLabels(imp) {
    const ids = new Set(imp._areaLabelIds || []);
    for (const id of ids) {
      const e = cesiumViewer.entities.getById(id);
      if (e) cesiumViewer.entities.remove(e);
    }
    imp.cesiumIds = imp.cesiumIds.filter(id => !ids.has(id));
    if (typeof imp._convertFn === 'function') _addCaveAreaLabels(imp, imp._convertFn);
  }

  // Survey coordinates (n, e, v) of a world point: start at the nearest station
  // and solve convertFn(x) = target with a few Newton steps (finite-difference
  // Jacobian), so anchors, declination, UTM and rectify warps are all inverted
  // exactly without each needing its own inverse.
  function _caveSurveyCoordsAt(imp, target) {
    const conv = imp._convertFn;
    if (typeof conv !== 'function') return null;
    let best = null, bestD = Infinity;
    for (const s of imp.parsed.stations) {
      const p = conv(s.n, s.e, s.v);
      if (!p) continue;
      const d = Cesium.Cartesian3.distanceSquared(p, target);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best) return null;
    let x = [best.n, best.e, best.v];
    for (let it = 0; it < 6; it++) {
      const p0 = conv(x[0], x[1], x[2]);
      if (!p0) return null;
      const r = Cesium.Cartesian3.subtract(target, p0, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitude(r) < 0.005) break;
      const col = (dn, de, dv) => Cesium.Cartesian3.subtract(conv(x[0] + dn, x[1] + de, x[2] + dv), p0, new Cesium.Cartesian3());
      const cn = col(1, 0, 0), ce = col(0, 1, 0), cv = col(0, 0, 1);
      const J = new Cesium.Matrix3(cn.x, ce.x, cv.x, cn.y, ce.y, cv.y, cn.z, ce.z, cv.z);
      const Ji = Cesium.Matrix3.inverse(J, new Cesium.Matrix3());
      const dx = Cesium.Matrix3.multiplyByVector(Ji, r, new Cesium.Cartesian3());
      x = [x[0] + dx.x, x[1] + dx.y, x[2] + dx.z];
    }
    return { n: x[0], e: x[1], v: x[2], nearest: best.name, distM: Math.sqrt(bestD) };
  }

  function _labelsPanelEl() {
    let el = document.getElementById('cave-inline-labels');
    if (el) return el;
    const host = document.getElementById('cave-inline-panel');
    if (!host) return null;
    el = document.createElement('div');
    el.id = 'cave-inline-labels';
    el.style.cssText = 'background:#16212a;border:1px solid rgba(80,220,255,0.25);border-radius:6px;padding:12px;font-size:13px;color:#ddd;';
    el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <div style="font-weight:600;font-size:13px;">${_ic('tag')}Area Labels</div>
      <button onclick="window._labelsClose()" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0 2px;">✕</button>
    </div>
    <div id="labels-cave-name" style="font-size:11px;opacity:0.5;margin-bottom:2px;"></div>
    <div id="labels-where" style="font-size:10px;color:#9fd8a8;margin-bottom:6px;"></div>
    <label class="sw-row" style="margin-bottom:8px;" title="The switch in the cave list hides every cave's area names">
      <input type="checkbox" class="ui-sw" role="switch" id="labels-show-cave" onchange="window._labelsShowCave(this.checked)"> Show this cave's area names
    </label>
    <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:8px;">Fly the camera to the spot, type a name and press Add: the label goes where the camera is.</div>
    <div style="display:flex;gap:6px;margin-bottom:6px;">
      <input id="labels-new-text" type="text" maxlength="60" placeholder="Area name"
        onkeydown="if(event.key==='Enter')window._labelsAddAtCamera()"
        style="flex:1;min-width:0;padding:4px 6px;background:#0d1418;border:1px solid rgba(255,255,255,0.18);border-radius:4px;color:#eee;font-size:12px;">
      <button onclick="window._labelsAddAtCamera()" style="padding:4px 10px;background:rgba(80,220,255,0.15);border:1px solid rgba(80,220,255,0.45);color:#8ee8ff;border-radius:4px;cursor:pointer;font-size:12px;">Add at camera</button>
    </div>
    <div id="labels-msg" style="font-size:10px;color:#fd8;min-height:12px;margin-bottom:6px;"></div>
    <div id="labels-list" style="max-height:220px;overflow-y:auto;"></div>`;
    host.appendChild(el);
    return el;
  }

  function _labelsRenderList() {
    const imp = _caveImports[_labelsIdx];
    const list = document.getElementById('labels-list');
    if (!imp || !list) return;
    const labels = _caveAreaLabelList(imp);
    { const w = document.getElementById('labels-where'); if (w) w.textContent = _labelsStore(imp) ? 'Kept in the project: changes go straight in (undo in History).' : ''; }
    list.innerHTML = labels.length ? labels.map((lb, li) => `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
      <input type="text" value="${_escapeHtml(lb.text)}" maxlength="60" onchange="window._labelsRename(${li}, this.value)"
        style="flex:1;min-width:0;padding:3px 5px;background:transparent;border:1px solid rgba(255,255,255,0.1);border-radius:3px;color:${AREA_LABEL_COLOR};font-size:12px;">
      <button onclick="window._labelsFlyTo(${li})" title="Fly to this label" style="background:none;border:none;cursor:pointer;font-size:13px;padding:0;color:inherit;">${window.icon('target', 14)}</button>
      <button onclick="window._labelsMoveHere(${li})" title="Move this label to the camera" style="background:none;border:none;cursor:pointer;font-size:12px;padding:0;color:#8ee8ff;">⤓</button>
      <button onclick="window._labelsDelete(${li})" title="Delete" style="background:none;border:none;cursor:pointer;font-size:13px;padding:0;color:#f88;">✕</button>
    </div>`).join('')
      : '<div style="font-size:11px;opacity:0.4;">No labels yet.</div>';
  }

  function _labelsChanged(imp) {
    _refreshCaveAreaLabels(imp);
    if (!_labelsStore(imp)) _displayUpdateRecent(imp);
    _labelsRenderList();
    _renderCaveList();
  }

  function _labelsMsg(t) { const m = document.getElementById('labels-msg'); if (m) m.textContent = t || ''; }

  // Where the camera is, in this cave's survey coordinates.
  function _labelsCameraCoords(imp) {
    const c = _caveSurveyCoordsAt(imp, cesiumViewer.camera.positionWC);
    if (!c) { _labelsMsg('This cave has no placed stations to measure from.'); return null; }
    _labelsMsg(c.distM > 1000
      ? `Placed ${(c.distM / 1000).toFixed(1)} km from the nearest station (${c.nearest}) — fly closer if that is not intended.`
      : `Placed ${c.distM.toFixed(0)} m from station ${c.nearest}.`);
    return c;
  }

  window._openLabelsPanel = function(i) {
    const imp = _caveImports[i];
    if (!imp) return;
    _labelsIdx = i;
    if (!imp.displayOptions) imp.displayOptions = defaultDisplayOptions(imp.parsed);
    const host = document.getElementById('cave-inline-panel');
    const el = _labelsPanelEl();
    if (!host || !el) return;
    document.getElementById('labels-cave-name').textContent = imp.name;
    { const chk = document.getElementById('labels-show-cave'); if (chk) chk.checked = imp.displayOptions.showAreaLabels !== false; }
    _labelsMsg('');
    _labelsRenderList();
    for (const id of ['cave-inline-style', 'cave-inline-rectify']) {
      const o = document.getElementById(id); if (o) o.style.display = 'none';
    }
    host.style.display = 'block';
    el.style.display = 'block';
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const inp = document.getElementById('labels-new-text'); if (inp) inp.focus();
  };

  window._labelsShowCave = function(on) {
    const imp = _caveImports[_labelsIdx];
    if (!imp) return;
    imp.displayOptions.showAreaLabels = !!on;
    _setCaveLayersVisible(imp);
    _displayUpdateRecent(imp);
  };

  window._labelsClose = function() {
    const el = document.getElementById('cave-inline-labels');
    if (el) el.style.display = 'none';
    const vis = id => { const o = document.getElementById(id); return o && o.style.display !== 'none'; };
    if (!vis('cave-inline-style') && !vis('cave-inline-rectify')) {
      const host = document.getElementById('cave-inline-panel'); if (host) host.style.display = 'none';
    }
    _labelsIdx = null;
  };

  window._labelsAddAtCamera = function() {
    const imp = _caveImports[_labelsIdx];
    const inp = document.getElementById('labels-new-text');
    if (!imp || !inp) return;
    const text = inp.value.trim().slice(0, 60);
    if (!text) { _labelsMsg('Type a name first.'); inp.focus(); return; }
    const c = _labelsCameraCoords(imp);
    if (!c) return;
    const st = _labelsStore(imp);
    inp.value = '';
    if (st) { st.add(imp.name, { text, n: c.n, e: c.e, v: c.v }).then(() => _labelsChanged(imp)); return; }
    const dopt = imp.displayOptions;
    (dopt.areaLabels || (dopt.areaLabels = [])).push({ text, n: +c.n.toFixed(3), e: +c.e.toFixed(3), v: +c.v.toFixed(3) });
    _labelsChanged(imp);
  };

  window._labelsMoveHere = function(li) {
    const imp = _caveImports[_labelsIdx];
    const lb = imp && _caveAreaLabelList(imp)[li];
    if (!lb) return;
    const c = _labelsCameraCoords(imp);
    if (!c) return;
    const st = _labelsStore(imp);
    if (st) { st.set(imp.name, lb.id, { n: c.n, e: c.e, v: c.v }).then(() => _labelsChanged(imp)); return; }
    lb.n = +c.n.toFixed(3); lb.e = +c.e.toFixed(3); lb.v = +c.v.toFixed(3);
    _labelsChanged(imp);
  };

  window._labelsRename = function(li, text) {
    const imp = _caveImports[_labelsIdx];
    const lb = imp && _caveAreaLabelList(imp)[li];
    if (!lb) return;
    text = String(text || '').trim().slice(0, 60);
    if (!text || text === lb.text) { _labelsRenderList(); return; }
    const st = _labelsStore(imp);
    if (st) { st.set(imp.name, lb.id, { text }).then(() => _labelsChanged(imp)); return; }
    lb.text = text;
    _labelsChanged(imp);
  };

  window._labelsDelete = function(li) {
    const imp = _caveImports[_labelsIdx];
    const st = _labelsStore(imp), lb = imp && _caveAreaLabelList(imp)[li];
    if (st && lb) { st.remove(imp.name, lb.id).then(() => _labelsChanged(imp)); return; }
    if (!imp || !imp.displayOptions.areaLabels) return;
    imp.displayOptions.areaLabels.splice(li, 1);
    _labelsChanged(imp);
  };

  window._labelsFlyTo = function(li) {
    const imp = _caveImports[_labelsIdx];
    const lb = imp && _caveAreaLabelList(imp)[li];
    if (!lb || typeof imp._convertFn !== 'function') return;
    const pos = imp._convertFn(lb.n, lb.e, lb.v);
    if (pos) cesiumViewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 25), { duration: 1.2 });
  };

  window._setCaveLeadsVisible = function(on) {
    _caveLeadsVisible = !!on;
    for (const imp of _caveImports) {
      for (const id of imp.cesiumIds) {
        const e = cesiumViewer.entities.getById(id);
        if (_isLeadEntity(e)) e.show = imp.visible && _caveLeadsVisible;
      }
    }
  };

  function _isAreaLabelEntity(e) {
    return !!(e && e.properties && e.properties.isCaveAreaLabel && e.properties.isCaveAreaLabel.getValue());
  }
  // Area names: the cave visible, the global switch on, and the cave's own switch on.
  let _caveAreaLabelsVisible = (() => { try { return localStorage.getItem('flex.caveAreaLabels') !== '0'; } catch (_) { return true; } })();
  function _areaLabelsShown(imp) {
    return imp.visible !== false && _caveAreaLabelsVisible && !(imp.displayOptions && imp.displayOptions.showAreaLabels === false);
  }

  window._setCaveAreaLabelsVisible = function(on) {
    _caveAreaLabelsVisible = !!on;
    try { localStorage.setItem('flex.caveAreaLabels', on ? '1' : '0'); } catch (_) {}
    _caveImports.forEach(_setCaveLayersVisible);
  };

  return {
    addCaveLeads: _addCaveLeads, addCaveAreaLabels: _addCaveAreaLabels, caveAreaLabelList: _caveAreaLabelList,
    isLeadEntity: _isLeadEntity, isAreaLabelEntity: _isAreaLabelEntity, areaLabelsShown: _areaLabelsShown,
    leadsVisible: () => _caveLeadsVisible, areaLabelsVisible: () => _caveAreaLabelsVisible,
  };
}
