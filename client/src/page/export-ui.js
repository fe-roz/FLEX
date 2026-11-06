// FLEX Export UI (bbox/polygon draw, export dialog, LiDAR analysis, progress polling).
// Classic script (not an ES module): it ran as an inline script at parse time and
// talks to flex.js through window.* hooks, so it keeps that timing.
// ── FLEX Export UI ──────────────────────────────────────────────────────────
(function() {
  'use strict';
  let _bboxCorner1 = null, _bboxCorner2 = null;
  let _drawHandler = null, _drawEntity = null;
  let _exportJobId = null, _pollTimer = null;

  // ── EPT dataset loader — reads directly from loaded Potree point clouds ───
  window._refreshEptDatasets = function _refreshEptDatasets() {
    const sel  = document.getElementById('export_ept_select');
    const hint = document.getElementById('export_ept_hint');
    if (!sel) return;
    try {
      const pcs = window.potreeViewer && window.potreeViewer.scene && window.potreeViewer.scene.pointclouds;
      if (!pcs || !pcs.length) {
        sel.innerHTML = '<option value="">— no point clouds loaded —</option>';
        hint.textContent = 'Load a point cloud in the LiDAR panel first.';
        return;
      }
      sel.innerHTML = '';
      pcs.forEach(pc => {
        const name = pc.name || '';
        // Prefer the original URL we captured in the addPC hook (has scheme + ept.json)
        // Fall back to pcoGeometry.url and ensure it ends with ept.json
        let url = _eptOriginalUrls[name] || (pc.pcoGeometry && pc.pcoGeometry.url) || '';
        if (url && !url.endsWith('ept.json')) url = url.replace(/\/$/, '') + '/ept.json';
        const opt = document.createElement('option');
        opt.value       = url;
        opt.textContent = name || url;
        sel.appendChild(opt);
      });
      hint.textContent = pcs.length === 1 ? 'Auto-selected.' : pcs.length + ' datasets loaded.';
    } catch(e) {
      sel.innerHTML = '<option value="">— error reading viewer —</option>';
      hint.textContent = e.message;
    }
  }

  // Refresh whenever the export panel is opened
  const _exportCollapsible = document.getElementById('exportCollapsible');
  if (_exportCollapsible) {
    new MutationObserver(() => {
      if (_exportCollapsible.classList.contains('show')) _refreshEptDatasets();
    }).observe(_exportCollapsible, { attributes: true, attributeFilter: ['class'] });
  }

  // Track original URLs passed to addPC (pcoGeometry.url strips the scheme)
  const _eptOriginalUrls = {}; // pcName -> original full URL with ept.json

  // Also refresh when a PC is added — wrap window.addPC once it exists
  function _hookAddPC() {
    if (window.addPC && !window.addPC._eptRefreshHooked) {
      const _orig = window.addPC;
      window.addPC = function(url) {
        // Capture original URL, keyed by the same name flex.js derives
        if (url) {
          try {
            const name = url.replace(/\/ept\.json.*$/i, '').split('/').filter(Boolean).pop() || url;
            _eptOriginalUrls[name] = url.endsWith('ept.json') ? url : url.replace(/\/$/, '') + '/ept.json';
          } catch(_) {}
        }
        const result = _orig.apply(this, arguments);
        setTimeout(_refreshEptDatasets, 1500);
        return result;
      };
      window.addPC._eptRefreshHooked = true;
    }
  }
  // Try immediately, then keep trying until addPC exists
  _hookAddPC();
  const _hookInterval = setInterval(() => { _hookAddPC(); if (window.addPC && window.addPC._eptRefreshHooked) clearInterval(_hookInterval); }, 500);

  // ── Draw bbox ────────────────────────────────────────────────────────────
  window._exportStartDraw = function() {
    if (_drawHandler) return;
    _exportClearBbox();
    const banner = document.getElementById('export-draw-banner');
    banner.style.display = 'block';
    banner.innerHTML = '' + window.icon('pencil', '1.15em', 'ico-l') + 'Click first corner  ·  Esc to cancel';

    // Esc handler
    const onKey = (e) => { if (e.key === 'Escape') { _stopDraw(); } };
    document.addEventListener('keydown', onKey);

    let step = 0;
    _drawHandler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.canvas);

    _drawHandler.setInputAction((mv) => {
      const pos = _pickPos(mv.position);
      if (!pos) return;
      const carto = Cesium.Cartographic.fromCartesian(pos);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);

      if (step === 0) {
        _bboxCorner1 = [lon, lat];
        step = 1;
        banner.innerHTML = '' + window.icon('pencil', '1.15em', 'ico-l') + 'Click opposite corner  ·  Esc to cancel';
      } else {
        _bboxCorner2 = [lon, lat];
        _drawRectEntity();
        _stopDraw();
        document.removeEventListener('keydown', onKey);
        _updateBboxDisplay();
        document.getElementById('export_run_btn').disabled = false;
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    _drawHandler.setInputAction(() => {
      _stopDraw();
      document.removeEventListener('keydown', onKey);
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  };

  function _pickPos(windowPos) {
    try {
      const ray = cesiumViewer.camera.getPickRay(windowPos);
      const pos = cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene);
      return pos || null;
    } catch (e) { return null; }
  }

  function _stopDraw() {
    if (_drawHandler) { _drawHandler.destroy(); _drawHandler = null; }
    document.getElementById('export-draw-banner').style.display = 'none';
  }

  function _drawRectEntity() {
    if (_drawEntity) { try { cesiumViewer.entities.remove(_drawEntity); } catch(e){} }
    if (!_bboxCorner1 || !_bboxCorner2) return;
    const [w, s] = [Math.min(_bboxCorner1[0], _bboxCorner2[0]), Math.min(_bboxCorner1[1], _bboxCorner2[1])];
    const [e, n] = [Math.max(_bboxCorner1[0], _bboxCorner2[0]), Math.max(_bboxCorner1[1], _bboxCorner2[1])];
    _drawEntity = cesiumViewer.entities.add({
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(w, s, e, n),
        material: Cesium.Color.fromCssColorString('#0099ff').withAlpha(0.18),
        outline: true, outlineColor: Cesium.Color.fromCssColorString('#00aaff'), outlineWidth: 2
      }
    });
  }

  window._exportClearBbox = function() {
    _bboxCorner1 = _bboxCorner2 = null;
    _polyClear();
    _polyNote('');
    if (_drawEntity) { try { cesiumViewer.entities.remove(_drawEntity); } catch(e){} _drawEntity = null; }
    document.getElementById('export_bbox_display').style.display = 'none';
    document.getElementById('export_run_btn').disabled = true;
    document.getElementById('export_download_wrap').style.display = 'none';
  };

  function _updateBboxDisplay() {
    if (!_bboxCorner1 || !_bboxCorner2) return;
    const [w, s] = [Math.min(_bboxCorner1[0], _bboxCorner2[0]), Math.min(_bboxCorner1[1], _bboxCorner2[1])];
    const [e, n] = [Math.max(_bboxCorner1[0], _bboxCorner2[0]), Math.max(_bboxCorner1[1], _bboxCorner2[1])];
    const txt = document.getElementById('export_bbox_text');
    txt.style.color = '';
    if (_exportPoly) {
      const crossing = _polySelfCrossing(_exportPoly);
      txt.innerHTML = `${window.icon('polygon', '1.15em', 'ico-l')}Polygon${_exportPolyLabel ? ' ' + _exportPolyLabel.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) : ''}: ` +
        `${_exportPoly.length} points, ${_polyAreaKm2(_exportPoly).toFixed(3)} km²` +
        (_exportPoly.length <= POLY_EDIT_MAX ? '<br><span style="opacity:.75">Drag a dot to move it, a small dot to add one; right-click removes one.</span>'
                                            : '<br><span style="opacity:.75">Too many points to edit here.</span>') +
        (crossing ? '<br><b style="color:#ff7a7a">Its edges cross — fix that before exporting.</b>' : '');
      document.getElementById('export_run_btn').disabled = crossing;
    } else {
      txt.textContent = `${s.toFixed(4)}°N, ${w.toFixed(4)}°W → ${n.toFixed(4)}°N, ${e.toFixed(4)}°W`;
    }
    document.getElementById('export_bbox_display').style.display = 'block';
  }

  // ── Polygon export area ──────────────────────────────────────────────────
  // Drawn here (click points; close on the first point, a double-click or
  // Enter) or loaded from a KML/KMZ. A hard cut: the exporter ends the
  // terrain exactly at the line, blanks the textures outside it and keeps
  // only the caves inside. The export frame is still the box around it, so
  // the bbox corners are set to the polygon's bounds and everything that
  // reads them (LiDAR analysis too) keeps working.
  let _exportPoly = null, _exportPolyLabel = '';     // [[lon, lat], ...], open ring
  let _polyDraft = null, _polyHover = null;          // while drawing
  let _polyFill = null, _polyLine = null, _polyHandles = [], _polyEditHandler = null, _polyDrag = null;
  const POLY_EDIT_MAX = 400;                         // more points than this: no drag handles

  const _polyRing = () => (_polyDraft || _exportPoly || []);
  const _c3 = p => Cesium.Cartesian3.fromDegrees(p[0], p[1]);
  function _polyMetres(pts) {
    const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 111320;
    return pts.map(p => [p[0] * mx, p[1] * my]);
  }
  function _polyAreaKm2(pts) {
    const m = _polyMetres(pts);
    let a = 0;
    for (let i = 0; i < m.length; i++) { const p = m[i], q = m[(i + 1) % m.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2e6;
  }
  // Two edges that are not neighbours cross (the exporter takes such a
  // shape by the even-odd rule, which is rarely what was meant).
  function _polySelfCrossing(pts) {
    const n = pts.length;
    if (n < 4 || n > 3000) return false;
    const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = pts[j], d = pts[(j + 1) % n];
        if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true;
      }
    }
    return false;
  }
  // Even-odd, in degrees (fine over an export's few kilometres).
  function _pointInPoly(lon, lat, pts) {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((xi <= lon) !== (xj <= lon) && lat >= yi + (lon - xi) * (yj - yi) / (xj - xi)) c = !c;
    }
    return c;
  }
  window._exportPointInArea = (lon, lat) => !_exportPoly || _pointInPoly(lon, lat, _exportPoly);

  function _polyEntities() {
    if (!_polyFill) {
      _polyFill = cesiumViewer.entities.add({
        polygon: {
          hierarchy: new Cesium.CallbackProperty(() => {
            const r = _polyRing();
            return r.length >= 3 ? new Cesium.PolygonHierarchy(r.map(_c3)) : new Cesium.PolygonHierarchy([]);
          }, false),
          material: Cesium.Color.fromCssColorString('#0099ff').withAlpha(0.18),
        },
      });
    }
    if (!_polyLine) {
      _polyLine = cesiumViewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            const r = _polyRing().slice();
            if (_polyDraft && _polyHover) r.push(_polyHover);
            if (r.length >= 2 && (!_polyDraft || r.length >= 3)) r.push(r[0]);
            return r.map(_c3);
          }, false),
          clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN, width: 2,
          material: Cesium.Color.fromCssColorString('#00aaff'),
        },
      });
    }
  }
  function _polyRemoveEntities() {
    for (const e of [_polyFill, _polyLine, ..._polyHandles]) if (e) { try { cesiumViewer.entities.remove(e); } catch (_) {} }
    _polyFill = _polyLine = null; _polyHandles = [];
  }
  // Drag handles: a dot per point, a small dot mid-edge to add one. The
  // entities are kept and moved, not re-created: re-created point
  // entities stopped being pickable after a drag.
  function _polyBuildHandles() {
    const r = _polyRing();
    const want = (!r.length || r.length > POLY_EDIT_MAX) ? [] :
      r.map((p, k) => ({ kind: 'v', k, p })).concat(_polyDraft ? [] :
        r.map((p, k) => { const q = r[(k + 1) % r.length]; return { kind: 'm', k, p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] }; }));
    while (_polyHandles.length > want.length) { try { cesiumViewer.entities.remove(_polyHandles.pop()); } catch (_) {} }
    while (_polyHandles.length < want.length) {
      const e = cesiumViewer.entities.add({
        position: Cesium.Cartesian3.ZERO,
        point: { pixelSize: 10, color: Cesium.Color.WHITE,
                 outlineColor: Cesium.Color.fromCssColorString('#0077dd'), outlineWidth: 2,
                 heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      _polyHandles.push(e);
    }
    // Opaque colours: translucent points don't pick reliably.
    const midColor = Cesium.Color.fromCssColorString('#a8d8ff');
    want.forEach((w, i) => {
      const e = _polyHandles[i];
      e._flexPoly = { kind: w.kind, k: w.k };
      e.position = _c3(w.p);
      e.point.pixelSize = w.kind === 'v' ? 10 : 7;
      e.point.color = w.kind === 'v' ? Cesium.Color.WHITE : midColor;
    });
  }
  function _screenOf(p) {
    const st = Cesium.SceneTransforms;
    const f = st.worldToWindowCoordinates || st.wgs84ToWindowCoordinates;
    return f ? f(cesiumViewer.scene, _c3(p)) : null;
  }
  function _lonLatAt(windowPos) {
    const pos = _pickPos(windowPos);
    if (!pos) return null;
    const c = Cesium.Cartographic.fromCartesian(pos);
    return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
  }

  window._exportStartPolygon = function() {
    if (_drawHandler) return;
    _exportClearBbox();
    _polyDraft = []; _polyHover = null;
    _polyEntities();
    const banner = document.getElementById('export-draw-banner');
    const say = () => {
      banner.style.display = 'block';
      banner.innerHTML = window.icon('polygon', '1.15em', 'ico-l') + (_polyDraft.length < 3
        ? `Click points of the polygon (${_polyDraft.length})  ·  Backspace undoes  ·  Esc cancels`
        : `${_polyDraft.length} points  ·  click the first point, double-click or Enter to close  ·  Backspace undoes  ·  Esc cancels`);
    };
    say();
    const finish = () => {
      const pts = _polyDraft;
      _polyDraft = null; _polyHover = null;
      _stopDraw();
      document.removeEventListener('keydown', onKey);
      if (pts.length >= 3) _exportSetPolygon(pts, 'drawn');
      else _exportClearBbox();
    };
    const cancel = () => { _polyDraft = null; _stopDraw(); document.removeEventListener('keydown', onKey); _exportClearBbox(); };
    const undo = () => { if (_polyDraft && _polyDraft.length) { _polyDraft.pop(); _polyBuildHandles(); say(); } };
    const onKey = (e) => {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter' && _polyDraft && _polyDraft.length >= 3) finish();
      else if (e.key === 'Backspace' && !/^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) { e.preventDefault(); undo(); }
    };
    document.addEventListener('keydown', onKey);
    _drawHandler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.canvas);
    _drawHandler.setInputAction((mv) => {
      const p = _lonLatAt(mv.position);
      if (!p || !_polyDraft) return;
      if (_polyDraft.length >= 3) {
        const s0 = _screenOf(_polyDraft[0]);
        if (s0 && Math.hypot(s0.x - mv.position.x, s0.y - mv.position.y) < 12) { finish(); return; }
      }
      _polyDraft.push(p);
      _polyBuildHandles(); say();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _drawHandler.setInputAction((mv) => {
      // The double-click's clicks already added a point (twice): keep one.
      if (!_polyDraft) return;
      while (_polyDraft.length >= 2) {
        const a = _screenOf(_polyDraft[_polyDraft.length - 1]), b = _screenOf(_polyDraft[_polyDraft.length - 2]);
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < 4) _polyDraft.pop(); else break;
      }
      if (_polyDraft.length >= 3) finish();
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    _drawHandler.setInputAction((mv) => {
      if (!_polyDraft) return;
      _polyHover = _lonLatAt(mv.endPosition);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    _drawHandler.setInputAction(undo, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  };

  // Use a polygon: from drawing, a KML, or a test. pts: [[lon, lat], ...].
  window._exportSetPolygon = function _exportSetPolygon(pts, label) {
    pts = (pts || []).map(p => [+p[0], +p[1]]).filter(p => isFinite(p[0]) && isFinite(p[1]));
    pts = pts.filter((p, k) => !k || p[0] !== pts[k - 1][0] || p[1] !== pts[k - 1][1]);
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < 3) return false;
    if (_drawEntity) { try { cesiumViewer.entities.remove(_drawEntity); } catch (_) {} _drawEntity = null; }
    _exportPoly = pts; _exportPolyLabel = label || '';
    _polyEntities();
    _polyBuildHandles();
    _polySyncBox();
    _polyStartEditing();
    return true;
  };
  window._exportGetPolygon = () => (_exportPoly ? _exportPoly.map(p => p.slice()) : null);
  // The area as it is now (box, polygon or nothing), for others that use it (⛰ project terrain, custom-layers.js).
  window._exportArea = () => (!_bboxCorner1 || !_bboxCorner2) ? null : { bbox: [Math.min(_bboxCorner1[0], _bboxCorner2[0]), Math.min(_bboxCorner1[1], _bboxCorner2[1]), Math.max(_bboxCorner1[0], _bboxCorner2[0]), Math.max(_bboxCorner1[1], _bboxCorner2[1])], polygon: window._exportGetPolygon(), crossing: !!(_exportPoly && _polySelfCrossing(_exportPoly)), label: _exportPolyLabel };
  function _polySyncBox() {
    if (!_exportPoly) return;
    const lons = _exportPoly.map(p => p[0]), lats = _exportPoly.map(p => p[1]);
    _bboxCorner1 = [Math.min(...lons), Math.min(...lats)];
    _bboxCorner2 = [Math.max(...lons), Math.max(...lats)];
    _updateBboxDisplay();
  }
  function _polyStartEditing() {
    if (_polyEditHandler) { _polyEditHandler.destroy(); _polyEditHandler = null; }
    if (!_exportPoly || _exportPoly.length > POLY_EDIT_MAX) return;
    const ctl = cesiumViewer.scene.screenSpaceCameraController;
    const handleAt = (pos) => {
      const hits = cesiumViewer.scene.drillPick(pos, 5);
      const h = hits.map(x => x && x.id).find(e => e && e._flexPoly);
      return h ? h._flexPoly : null;
    };
    _polyEditHandler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.canvas);
    _polyEditHandler.setInputAction((ev) => {
      if (_drawHandler) return;
      const h = handleAt(ev.position);
      if (!h) return;
      if (h.kind === 'm') { _exportPoly.splice(h.k + 1, 0, _lonLatAt(ev.position) || _exportPoly[h.k].slice()); _polyDrag = h.k + 1; }
      else _polyDrag = h.k;
      ctl.enableInputs = false;
      _polyBuildHandles();
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    _polyEditHandler.setInputAction((mv) => {
      if (_polyDrag == null) return;
      const p = _lonLatAt(mv.endPosition);
      if (!p) return;
      _exportPoly[_polyDrag] = p;
      const e = _polyHandles.find(x => x._flexPoly.kind === 'v' && x._flexPoly.k === _polyDrag);
      if (e) e.position = _c3(p);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    _polyEditHandler.setInputAction(() => {
      if (_polyDrag == null) return;
      _polyDrag = null;
      ctl.enableInputs = true;
      _exportPolyLabel = _exportPolyLabel.replace(/( \(edited\))?$/, ' (edited)');
      _polyBuildHandles();
      _polySyncBox();
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
    _polyEditHandler.setInputAction((ev) => {
      const h = handleAt(ev.position);
      if (!h || h.kind !== 'v' || _exportPoly.length <= 3) return;
      _exportPoly.splice(h.k, 1);
      _polyBuildHandles();
      _polySyncBox();
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }
  function _polyClear() {
    _exportPoly = null; _exportPolyLabel = ''; _polyDraft = null; _polyDrag = null;
    if (_polyEditHandler) { _polyEditHandler.destroy(); _polyEditHandler = null; }
    try { cesiumViewer.scene.screenSpaceCameraController.enableInputs = true; } catch (_) {}
    _polyRemoveEntities();
  }

  // ── Polygon from a KML / KMZ ─────────────────────────────────────────────
  // The first <Polygon>'s outer ring (the largest, if the file has several);
  // failing that, a closed path. KMZ is a zip: its doc.kml (or first .kml).
  window._exportLoadKml = function() {
    let inp = document.getElementById('export-kml-input');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file'; inp.id = 'export-kml-input'; inp.accept = '.kml,.kmz'; inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', async () => {
        const f = inp.files[0]; inp.value = '';
        if (!f) return;
        try {
          const text = /\.kmz$/i.test(f.name) ? await _kmzText(f) : await f.text();
          const r = _kmlPolygon(text);
          _exportClearBbox();
          _exportSetPolygon(r.points, `from ${f.name}${r.name ? ' — ' + r.name : ''}`);
          if (r.note) _polyNote(r.note);
          _polyFlyTo();
        } catch (e) {
          _polyNote('⚠ ' + (e.message || e), true);
        }
      });
    }
    inp.click();
  };
  function _polyNote(msg, bad) {
    const el = document.getElementById('export_poly_note');
    if (!el) return;
    el.textContent = msg; el.style.color = bad ? '#ff7a7a' : 'rgba(255,255,255,0.55)';
    el.style.display = msg ? 'block' : 'none';
    if (bad) document.getElementById('export_bbox_display').style.display = 'block';
  }
  function _polyFlyTo() {
    if (!_exportPoly) return;
    const lons = _exportPoly.map(p => p[0]), lats = _exportPoly.map(p => p[1]);
    const pad = 0.15 * Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats));
    try {
      cesiumViewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(Math.min(...lons) - pad, Math.min(...lats) - pad,
                                                                           Math.max(...lons) + pad, Math.max(...lats) + pad), duration: 1.2 });
    } catch (_) {}
  }
  function _kmlPolygon(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('that file is not readable KML');
    const all = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];
    const coords = el => (el && el.textContent || '').trim().split(/\s+/).map(t => t.split(',').map(Number))
                           .filter(a => a.length >= 2 && isFinite(a[0]) && isFinite(a[1])).map(a => [a[0], a[1]]);
    const nameOf = el => { for (let p = el; p; p = p.parentElement) if (p.localName === 'Placemark') { const n = all(p, 'name')[0]; return n ? n.textContent.trim() : ''; } return ''; };
    const rings = all(doc, 'Polygon').map(pg => {
      const outer = all(pg, 'outerBoundaryIs')[0] || pg;
      return { points: coords(all(outer, 'coordinates')[0]), name: nameOf(pg), holes: all(pg, 'innerBoundaryIs').length };
    }).filter(r => r.points.length >= 3);
    let note = '';
    if (!rings.length) {
      const paths = all(doc, 'LineString').concat(all(doc, 'LinearRing')).map(l => ({ points: coords(all(l, 'coordinates')[0]), name: nameOf(l) }))
        .filter(r => r.points.length >= 3);
      if (!paths.length) throw new Error('no polygon in that file (looked for a Polygon, then a path of 3+ points)');
      rings.push(...paths);
      note = 'No polygon in the file: its path was closed into one.';
    }
    rings.sort((a, b) => _polyAreaKm2(b.points) - _polyAreaKm2(a.points));
    const r = rings[0];
    if (rings.length > 1) note = `${rings.length} shapes in the file: using the largest${r.name ? ' (' + r.name + ')' : ''}.`;
    if (r.holes) note = (note ? note + ' ' : '') + 'Its holes are ignored (only the outer line cuts).';
    return { points: r.points, name: r.name, note };
  }
  // Just enough zip to get the KML out of a KMZ (stored or deflated entries).
  async function _kmzText(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('that KMZ is not a readable zip');
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
      entries.push({ name, method, csize, off });
      p += 46 + nl + xl + cl;
    }
    const kmls = entries.filter(e => /\.kml$/i.test(e.name));
    const e = kmls.find(x => /(^|\/)doc\.kml$/i.test(x.name)) || kmls[0];
    if (!e) throw new Error('no .kml inside that KMZ');
    const lh = e.off, data0 = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
    const raw = buf.subarray(data0, data0 + e.csize);
    if (e.method === 0) return new TextDecoder().decode(raw);
    if (e.method !== 8) throw new Error('unsupported compression in that KMZ');
    const out = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return new TextDecoder().decode(out);
  }

  // ── Collect cave shots within bbox ───────────────────────────────────────
  // walls: false sends the survey lines without the passage walls.
  function _collectCavesInBbox(minLon, minLat, maxLon, maxLat, { walls = true, poly = null } = {}) {
    // Access the global cave import state from flex.js
    let surveys = [];
    // The open project (project.js): surveys named by their project cave, with ids in meta.
    const pjx = window._pjExport ? window._pjExport() : null;
    const pjCaves = new Map();               // export cave name → project cave id
    const surveyMap = {};
    const handledIds = new Set();
    const areaLabels = [];
    // In the box, and inside the export polygon when there is one.
    const inBox = (lon, lat) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat &&
                                (!poly || _pointInPoly(lon, lat, poly));

    // First: caves rendered by _rerenderCave keep their coordinate converter,
    // so shots and stations are rebuilt from the parsed survey itself. Every
    // shot carries its from/to station names and every station its name,
    // LRUD and distance, whether or not station dots are switched on and
    // whatever the cave size (big caves draw one polyline per segment, which
    // carries no station names). Stations are grouped per cave so the viewer
    // never merges two caves' identically named stations.
    try {
      (window._caveImports || []).forEach((imp, ci) => {
        if (!imp || !imp.parsed || typeof imp._convertFn !== 'function') return;
        (imp.cesiumIds || []).forEach(id => handledIds.add(id));
        if (imp.visible === false) return;
        const dopt = imp.displayOptions || {};
        const colors = dopt.surveyColors || {};
        const conv = imp._convertFn;
        const memo = new Map();
        const ll = p => {
          if (memo.has(p)) return memo.get(p);
          let r = null;
          const cart = conv(p.n, p.e, p.v);
          if (cart) {
            const c = Cesium.Cartographic.fromCartesian(cart);
            if (c) r = [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude), c.height];
          }
          memo.set(p, r);
          return r;
        };
        const descOf = {};
        (imp.parsed.surveys || []).forEach(sv => { if (sv.code && !(sv.code in descOf)) descOf[sv.code] = sv.desc || ''; });
        const entryFor = code => {
          const key = `cave${ci}|${code}`;
          if (!surveyMap[key]) {
            const d = descOf[code];
            const pc = pjx ? pjx.caveFor(imp, code) : null;
            let caveName = imp.name || `cave${ci}`;
            if (pc) {                        // two project caves with one name stay two caves
              caveName = pc.name;
              for (let k = 2; pjCaves.has(caveName) && pjCaves.get(caveName) !== pc.id; k++) caveName = `${pc.name} (${k})`;
              pjCaves.set(caveName, pc.id);
            }
            surveyMap[key] = {
              name:  code ? (d ? `${code} — ${d}` : code) : (imp.name || 'Survey'),
              code:  code,
              cave:  caveName,
              color: colors[code] || colors[''] || '#00e5ff',
              shots: [], stations: [],
            };
            surveys.push(surveyMap[key]);
          }
          return surveyMap[key];
        };
        const hidden  = code => !!(dopt.hiddenSurveys && dopt.hiddenSurveys[code]);
        const surface = code => !!(dopt.surfaceSurveys && dopt.surfaceSurveys[code]);

        for (const seg of imp.parsed.segments || []) {
          const code = seg.survey || '';
          if (hidden(code)) continue;
          if ((seg.isSurface || surface(code)) && !dopt.showSurface) continue;
          const pts = seg.points.filter(p => !p.excluded);
          for (let k = 0; k + 1 < pts.length; k++) {
            const A = pts[k], B = pts[k + 1];
            const a = ll(A), b = ll(B);
            if (!a || !b || !inBox((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue;
            const shot = { from: a, to: b,
              length: +Math.hypot(B.e - A.e, B.n - A.n, B.v - A.v).toFixed(3) };
            if (A.name) shot.from_name = A.name;
            if (B.name) shot.to_name = B.name;
            entryFor(code).shots.push(shot);
          }
        }
        const withShots = new Set((imp.parsed.segments || []).map(sg => sg.survey || ''));
        for (const s of imp.parsed.stations || []) {
          const code = s.survey || '';
          if (hidden(code)) continue;
          if ((s.isSurface || surface(code) || !withShots.has(code)) && !dopt.showSurface) continue;
          const p = ll(s);
          if (!p || !inBox(p[0], p[1])) continue;
          const st = { name: s.name || '', lon: p[0], lat: p[1], elev: p[2] };
          // The reading the walls use here (Style → Passage → LRUD at From/To).
          const lr = window._caveStationLrud ? window._caveStationLrud(imp, s) : s.lrud;
          if (lr) st.lrud = [lr.l, lr.r, lr.u, lr.d];
          if (s.dist != null && isFinite(s.dist)) st.dist = s.dist;
          if (s.comment) st.comment = s.comment;
          entryFor(code).stations.push(st);
        }
        // Area labels (🏷 Labels): named spots, same conversion as stations
        // (a project cave's from the project, flex.js _caveAreaLabels).
        for (const lb of (window._caveAreaLabels ? window._caveAreaLabels(imp) : dopt.areaLabels) || []) {
          if (!lb || !lb.text) continue;
          const p = ll(lb);
          if (!p || !inBox(p[0], p[1])) continue;
          areaLabels.push({ text: String(lb.text), cave: imp.name || '', lon: p[0], lat: p[1], elev: p[2] });
        }
        // Open leads ride with the survey of the station they hang off: the file's own, and FLEX's
        // (the open project's and My data's, flex-leads.js). A file lead that was adopted into either is
        // exported once, from its record (closed or removed: not at all).
        const stnByName = new Map();
        for (const s of imp.parsed.stations || []) if (!stnByName.has(s.name)) stnByName.set(s.name, s);
        const FX = window._flexLeads ? window._flexLeads.exportFor(imp, stnByName) : null;
        const addLead = (s, station, f) => {
          if (!s || hidden(s.survey || '')) return;
          const p = ll(s);
          if (!p || !inBox(p[0], p[1])) return;
          const lead = { station, lon: p[0], lat: p[1], elev: p[2] };
          if (f.desc) lead.description = String(f.desc);
          if (f.w != null && isFinite(f.w)) lead.width = Number(f.w);
          if (f.h != null && isFinite(f.h)) lead.height = Number(f.h);
          if (f.date) lead.date = String(f.date);
          if (f.status) lead.status = String(f.status);
          if (f.source) lead.source = String(f.source);
          if (f.id) lead.id = String(f.id);
          if (f.priority) lead.priority = String(f.priority);
          const sv = entryFor(s.survey || '');
          (sv.leads || (sv.leads = [])).push(lead);
        };
        for (const ld of imp.parsed.leads || []) {
          if (ld.done) continue;
          const s = stnByName.get(ld.station);
          if (FX && FX.adopted(ld, s)) continue;
          addLead(s, ld.station, { desc: ld.d, w: ld.w, h: ld.h, date: ld.t, status: 'open', source: 'file' });
        }
        if (FX) for (const fl of FX.leads) addLead(fl.s, fl.station, { desc: fl.fields.desc, w: fl.fields.w, h: fl.fields.h, date: fl.fields.found, status: fl.status, source: 'flex', id: fl.id, priority: fl.fields.priority });
      });
    } catch(e) { console.warn('Cave export (parsed) error:', e); }

    try {
      // Anything else: read back Cesium entities with the isCaveSurvey property
      cesiumViewer.entities.values.forEach(entity => {
        if (handledIds.has(entity.id)) return;
        if (!entity.properties || !entity.properties.isCaveSurvey || !entity.properties.isCaveSurvey.getValue()) return;
        if (!entity.polyline) return;
        const positions = entity.polyline.positions.getValue(Cesium.JulianDate.now());
        if (!positions || positions.length < 2) return;

        const pts = positions.map(p => {
          const c = Cesium.Cartographic.fromCartesian(p);
          return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude), c.height];
        });

        // A polyline is one shot (anchored caves) or a whole chain of shots
        // (UTM and large caves): take every consecutive pair, keeping shots
        // whose midpoint falls in the bbox. Taking only the first pair used
        // to drop all but one shot of every chain from the export.
        const shotsIn = [];
        for (let k = 0; k + 1 < pts.length; k++) {
          const midLon = (pts[k][0] + pts[k + 1][0]) / 2;
          const midLat = (pts[k][1] + pts[k + 1][1]) / 2;
          if (!inBox(midLon, midLat)) continue;
          shotsIn.push({ from: pts[k], to: pts[k + 1] });
        }
        if (!shotsIn.length) return;

        const code  = entity.properties.surveyCode ? entity.properties.surveyCode.getValue() : '';
        // Initial name is just the code — 3rd pass enriches it with the real per-survey description
        const name  = code || 'Unknown';
        const color = entity.polyline.material ?
          (entity.polyline.material.color ? entity.polyline.material.color.getValue(Cesium.JulianDate.now()).toCssHexString() : '#00e5ff') : '#00e5ff';
        const key   = code || name;

        if (!surveyMap[key]) {
          surveyMap[key] = { name, color, shots: [] };
          surveys.push(surveyMap[key]);
        }
        surveyMap[key].shots.push(...shotsIn);
      });
    } catch(e) { console.warn('Cave export collection error:', e); }

    // Second pass: collect station point-entities (name + lon/lat/elev)
    try {
      cesiumViewer.entities.values.forEach(entity => {
        if (!entity.properties || !entity.properties.isCaveSurvey || !entity.properties.isCaveSurvey.getValue()) return;
        if (handledIds.has(entity.id)) return;
        if (!entity.point || !entity.position) return;
        const cart = entity.position.getValue(Cesium.JulianDate.now());
        if (!cart) return;
        const c = Cesium.Cartographic.fromCartesian(cart);
        const lon = Cesium.Math.toDegrees(c.longitude);
        const lat = Cesium.Math.toDegrees(c.latitude);
        if (!inBox(lon, lat)) return;
        const code  = entity.properties.surveyCode ? entity.properties.surveyCode.getValue() : '';
        const sname = entity.properties.surveyName ? entity.properties.surveyName.getValue() : '';
        const key   = code || sname;
        if (!surveyMap[key]) return; // only attach to surveys already collected via shots
        if (!surveyMap[key].stations) surveyMap[key].stations = [];
        surveyMap[key].stations.push({ name: entity.name || '', lon, lat, elev: c.height });
      });
    } catch(e) { console.warn('Cave station export error:', e); }

    // Third pass: enrich stations with lrud/dist AND survey names from _caveImports (flex.js global)
    try {
      const imports = window._caveImports || [];
      imports.forEach(imp => {
        if (!imp || !imp.parsed) return;
        // Build surveyCode → description map.
        // Try imp.parsed.surveys[] first (most PLT parsers put descriptions there),
        // then fall back to station-level surveyDesc.
        const descMap = {};
        if (imp.parsed.surveys) {
          imp.parsed.surveys.forEach(sv => {
            const c = sv.code || sv.survey || sv.name;
            const d = sv.description || sv.desc || sv.surveyName || sv.title;
            if (c && d && !descMap[c]) descMap[c] = d;
          });
        }
        if (imp.parsed.stations) {
          imp.parsed.stations.forEach(s => {
            if (s.survey && s.surveyDesc && !descMap[s.survey]) descMap[s.survey] = s.surveyDesc;
          });
        }
        // Apply full survey name (code — description)
        Object.entries(descMap).forEach(([code, desc]) => {
          if (surveyMap[code] && desc) surveyMap[code].name = `${code} — ${desc}`;
        });
        // Enrich station lrud/dist by name match
        (imp.parsed.stations || []).forEach(s => {
          const key = s.survey || '';
          if (!surveyMap[key] || !surveyMap[key].stations) return;
          const match = surveyMap[key].stations.find(st => st.name === s.name);
          if (!match) return;
          const lr = window._caveStationLrud ? window._caveStationLrud(imp, s) : s.lrud;
          if (lr) match.lrud = [lr.l, lr.r, lr.u, lr.d];
          if (s.dist !== undefined) match.dist = s.dist;
        });
      });
    } catch(e) { console.warn('Cave LRUD/dist enrichment error:', e); }

    // Fourth pass: passage walls, exactly as drawn (Style panel → Passage).
    // Each visible cave keeps its wall mesh in world coordinates; send it as
    // lon/lat/height like the shots, keeping triangles whose centre falls in
    // the export box, re-indexed compactly. The exporter converts it to the
    // viewer's frame with the same UTM code as the survey lines.
    const passages = [];
    try {
      const imports = window._caveImports || [];
      imports.forEach(imp => {
        const mesh = walls && imp && imp._passageMesh;
        if (!mesh || imp.visible === false) return;
        mesh.groups.forEach(g => {
          const nv = g.pos.length / 3;
          const lon = new Float64Array(nv), lat = new Float64Array(nv), h = new Float64Array(nv);
          const scratch = new Cesium.Cartesian3();
          for (let i = 0; i < nv; i++) {
            scratch.x = g.pos[3 * i]; scratch.y = g.pos[3 * i + 1]; scratch.z = g.pos[3 * i + 2];
            const c = Cesium.Cartographic.fromCartesian(scratch);
            if (!c) { lon[i] = NaN; continue; }
            lon[i] = Cesium.Math.toDegrees(c.longitude);
            lat[i] = Cesium.Math.toDegrees(c.latitude);
            h[i]   = c.height;
          }
          const remap = new Int32Array(nv).fill(-1);
          const lonlat = [], indices = [];
          for (let t = 0; t + 2 < g.idx.length; t += 3) {
            const a0 = g.idx[t], a1 = g.idx[t + 1], a2 = g.idx[t + 2];
            const cl = (lon[a0] + lon[a1] + lon[a2]) / 3, ca = (lat[a0] + lat[a1] + lat[a2]) / 3;
            if (!inBox(cl, ca)) continue;
            for (const v of [a0, a1, a2]) {
              if (remap[v] < 0) {
                remap[v] = lonlat.length / 3;
                lonlat.push(+lon[v].toFixed(8), +lat[v].toFixed(8), +h[v].toFixed(3));
              }
              indices.push(remap[v]);
            }
          }
          if (indices.length) passages.push({ color: g.hex, opacity: mesh.alpha, lonlat, indices });
        });
      });
    } catch(e) { console.warn('Cave passage export error:', e); }

    surveys = surveys.filter(sv => sv.shots.length || (sv.stations && sv.stations.length) || (sv.leads && sv.leads.length));
    const out = { surveys };
    if (passages.length) out.passages = passages;
    if (areaLabels.length) out.labels = areaLabels;
    if (pjx) {                               // FLEX Field links these without asking
      out.project = pjx.project;
      const used = new Set(surveys.map(sv => sv.cave));
      out.cave_ids = [...pjCaves].filter(([name]) => used.has(name)).map(([name, id]) => ({ id, name }));
    }
    return out;
  }

  // ── Run export ───────────────────────────────────────────────────────────
  // ── Live HAG filter controls ─────────────────────────────────────────────

  // ── LiDAR analysis ───────────────────────────────────────────────────────
  // Vegetation density and void rasters for the drawn area. Shares the bbox
  // and the dataset picker with Export; everything else is its own.
  const _lidarLayers = { veg: null, void: null };
  let   _lidarJobId  = null;

  function _lidarSyncBbox() {
    const el = document.getElementById('lidar_bbox_text');
    if (!el) return;
    if (!_bboxCorner1 || !_bboxCorner2) { el.textContent = '— no area drawn —'; return; }
    const w = Math.min(_bboxCorner1[0], _bboxCorner2[0]).toFixed(5);
    const e = Math.max(_bboxCorner1[0], _bboxCorner2[0]).toFixed(5);
    const s2 = Math.min(_bboxCorner1[1], _bboxCorner2[1]).toFixed(5);
    const n = Math.max(_bboxCorner1[1], _bboxCorner2[1]).toFixed(5);
    el.textContent = `${w}, ${s2}  →  ${e}, ${n}`;
  }
  setInterval(_lidarSyncBbox, 1000);

  // Mirror the Export dataset list rather than duplicating the discovery
  // logic, so both panels always agree on what is loaded.
  function _lidarMirrorDatasets() {
    const src = document.getElementById('export_ept_select');
    const dst = document.getElementById('lidar_ept_select');
    if (!src || !dst) return;
    const keep = dst.value;
    dst.innerHTML = src.innerHTML;
    if (keep) dst.value = keep;
  }
  setInterval(_lidarMirrorDatasets, 1500);

  window._lidarSetOpacity = function(a) {
    Object.values(_lidarLayers).forEach(l => { if (l) l.alpha = a; });
  };
  window._lidarToggleLayer = function(which, on) {
    const l = _lidarLayers[which];
    if (l) l.show = on;
  };

  function _lidarClearLayers() {
    Object.keys(_lidarLayers).forEach(k => {
      if (_lidarLayers[k]) {
        try { cesiumViewer.imageryLayers.remove(_lidarLayers[k], true); } catch(_) {}
        _lidarLayers[k] = null;
      }
    });
  }

  async function _lidarAddOverlay(which, url, rectDeg, alpha) {
    const rect = Cesium.Rectangle.fromDegrees(rectDeg[0], rectDeg[1], rectDeg[2], rectDeg[3]);
    let provider;
    // Cesium deprecated the SingleTileImageryProvider constructor in favour of
    // an async fromUrl; support both so this does not break on either side of
    // a Cesium bump.
    if (Cesium.SingleTileImageryProvider.fromUrl) {
      provider = await Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle: rect });
    } else {
      provider = new Cesium.SingleTileImageryProvider({ url, rectangle: rect });
    }
    const layer = cesiumViewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = alpha;
    _lidarLayers[which] = layer;
    return layer;
  }

  window._lidarRun = function() {
    if (!_bboxCorner1 || !_bboxCorner2) { alert('Draw an area first.'); return; }
    const w = Math.min(_bboxCorner1[0], _bboxCorner2[0]);
    const e = Math.max(_bboxCorner1[0], _bboxCorner2[0]);
    const s2 = Math.min(_bboxCorner1[1], _bboxCorner2[1]);
    const n = Math.max(_bboxCorner1[1], _bboxCorner2[1]);

    const eptPath = document.getElementById('lidar_ept_select').value;
    if (!eptPath) { alert('Select a point cloud dataset first.'); return; }

    const cellVal = document.getElementById('lidar_cell').value;
    const body = {
      bbox: [w, s2, e, n],
      eptPath,
      cell: cellVal ? parseFloat(cellVal) : null,
      veg_band: [parseFloat(document.getElementById('lidar_veg_lo').value),
                 parseFloat(document.getElementById('lidar_veg_hi').value)],
      void_depth: parseFloat(document.getElementById('lidar_void_depth').value),
      void_min_points: parseInt(document.getElementById('lidar_void_min').value),
      low_cut: parseFloat(document.getElementById('lidar_low_cut').value),
      stat: document.getElementById('lidar_stat').value,
    };

    const btn  = document.getElementById('lidar_run_btn');
    const wrap = document.getElementById('lidar_progress_wrap');
    const bar  = document.getElementById('lidar_progress_bar');
    const txt  = document.getElementById('lidar_status_text');
    btn.disabled = true;
    wrap.style.display = 'block';
    document.getElementById('lidar_results').style.display = 'none';
    bar.style.width = '5%';
    txt.textContent = 'Starting…';

    const startDerive = () => fetch('/api/lidar/derive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).then(j => {
      if (!j.ok) throw new Error(j.error || 'failed to start');
      _lidarJobId = j.jobId;
      // The Jobs panel (jobs-panel.js): Cancel and Log go to the server; Retry sends the same request again
      if (window._jobs) window._jobs.add({ id: 'analyze.' + j.jobId, kind: 'analyze', name: 'Analyze: vegetation and voids', server: true,
        retry: () => { btn.disabled = true; wrap.style.display = 'block'; bar.style.width = '5%'; txt.textContent = 'Starting…'; startDerive(); } });
      const poll = setInterval(() => {
        fetch('/api/lidar/status/' + _lidarJobId).then(r => r.json()).then(st => {
          bar.style.width = (st.progress || 5) + '%';
          txt.textContent = st.message || st.status;
          if (st.status === 'done') {
            clearInterval(poll);
            btn.disabled = false;
            _lidarShowResults(_lidarJobId, st.meta);
          } else if (st.status === 'error') {
            clearInterval(poll);
            btn.disabled = false;
            txt.textContent = 'Error: ' + (st.error || 'see server log');
          }
        }).catch(err => {
          clearInterval(poll); btn.disabled = false;
          txt.textContent = 'Error: ' + err.message;
        });
      }, 1200);
    }).catch(err => {
      btn.disabled = false;
      txt.textContent = 'Error: ' + err.message;
    });
    startDerive();
  };

  async function _lidarShowResults(jobId, meta) {
    document.getElementById('lidar_results').style.display = 'block';
    const base = '/api/lidar/result/' + jobId + '/';
    ['veg','void','ground'].forEach(k => {
      const a = document.getElementById('lidar_dl_' + k);
      if (a) a.href = base + (k === 'veg' ? 'vegetation.tif'
                            : k === 'void' ? 'voids.tif' : 'ground.tif');
    });

    // Place the overlays on the raster's OWN lon/lat footprint, not the
    // requested bbox: the grid is UTM-aligned and snapped out to whole cells,
    // so its real extent differs slightly from what was asked for.
    const rect = (meta && meta.raster_bounds_lonlat) || null;
    const alpha = (parseInt(document.getElementById('lidar_opacity').value) || 75) / 100;
    _lidarClearLayers();
    if (rect) {
      try {
        await _lidarAddOverlay('veg',  base + 'vegetation.png', rect, alpha);
        await _lidarAddOverlay('void', base + 'voids.png',      rect, alpha);
        _lidarToggleLayer('veg',  document.getElementById('lidar_show_veg').checked);
        _lidarToggleLayer('void', document.getElementById('lidar_show_void').checked);
      } catch (e) {
        console.warn('[lidar] overlay failed', e);
      }
    }

    if (meta) {
      const pc = meta.ground_returns_per_cell;
      const warn = (pc > 0 && pc < 4)
        ? ` <span style="color:#e8a33d;">(thin — consider a larger cell)</span>` : '';
      document.getElementById('lidar_stats').innerHTML =
        `cell ${meta.cell} m · ${meta.grid[0]}×${meta.grid[1]}<br>` +
        `ground returns/cell ${pc.toFixed(1)}${warn}<br>` +
        `cells with direct ground ${(meta.cells_direct_fraction*100).toFixed(0)}%<br>` +
        `points ${meta.points_total.toLocaleString()} · kept ${meta.points_kept.toLocaleString()}<br>` +
        `<b>void cells ${meta.void_cells.toLocaleString()}</b>`;
    }
    document.getElementById('lidar_status_text').textContent = 'Done.';
  }

  // ── Terrain from the map (Cesium) instead of the LiDAR ──────────────────
  // Show the rows for the chosen source. LiDAR hillshade needs the LiDAR, so
  // with map terrain it becomes "From the terrain".
  window._exportSyncTerrainSource = function() {
    const map = document.getElementById('export_terrain_source').value === 'map';
    document.getElementById('export_map_rows').style.display = map ? 'block' : 'none';
    document.getElementById('export_lidar_rows').style.display = map ? 'none' : 'block';
    const res = document.getElementById('export_resolution');
    if (res && res.closest('label')) res.closest('label').style.display = map ? 'none' : 'block';
    const hs = document.getElementById('export_hillshade_mode');
    const opt = hs && hs.querySelector('option[value="lidar"]');
    if (opt) opt.disabled = map;
    if (map && hs.value === 'lidar') hs.value = 'dem';
  };

  // Heights of the map's 3D terrain on a regular lon/lat grid over the box
  // (plus a margin: the export's UTM rectangle reaches past a lat/lon box),
  // read in chunks with progress. Tiles are read at about the level the cell
  // needs, not the finest there is, so a big box stays quick; anything that
  // level lacks is retried at the most detailed. → { lon0, lat0, dlon, dlat,
  // nx, ny, cell, heights: Float32Array (row 0 = lat0, NaN = nothing) }.
  const MAP_DEM_AUTO_SAMPLES = 2.5e6, MAP_DEM_MAX_SAMPLES = 5e6;
  async function _sampleMapTerrain(w, s, e, n, cellPref, onProgress) {
    const tp = cesiumViewer.terrainProvider;
    if (!tp || tp instanceof Cesium.EllipsoidTerrainProvider)
      throw new Error('The map has no 3D terrain to take heights from.');
    const mLat = 111320, mLon = 111320 * Math.cos((s + n) / 2 * Math.PI / 180);
    const W = (e - w) * mLon, H = (n - s) * mLat;
    const span = Math.max(W, H);
    const layout = cell => {
      const pad = 0.06 * span + 3 * cell;
      return { cell, pad, nx: Math.ceil((W + 2 * pad) / cell) + 1, ny: Math.ceil((H + 2 * pad) / cell) + 1 };
    };
    let L = layout(cellPref === 'auto' ? Math.max(5, Math.sqrt(W * H / MAP_DEM_AUTO_SAMPLES)) : +cellPref);
    const cap = cellPref === 'auto' ? MAP_DEM_AUTO_SAMPLES * 1.4 : MAP_DEM_MAX_SAMPLES;
    while (L.nx * L.ny > cap) L = layout(L.cell * Math.sqrt(L.nx * L.ny / cap) * 1.01);
    const cell = Math.ceil(L.cell * 2) / 2;                       // to 0.5 m
    L = layout(cell);
    const { nx, ny, pad } = L;
    const lon0 = w - pad / mLon, lat0 = s - pad / mLat, dlon = cell / mLon, dlat = cell / mLat;
    // Geographic tiles of about 64 posts: the level whose posts are ~ one cell apart.
    const want = Math.max(8, Math.min(20, Math.ceil(Math.log2(20037508 / (64 * cell)))));
    const heights = new Float32Array(nx * ny).fill(NaN);
    const rowsPer = Math.max(1, Math.floor(150000 / nx));
    let missing = 0;
    for (let j0 = 0; j0 < ny; j0 += rowsPer) {
      const j1 = Math.min(ny, j0 + rowsPer), cartos = [];
      for (let j = j0; j < j1; j++) for (let i = 0; i < nx; i++)
        cartos.push(Cesium.Cartographic.fromDegrees(lon0 + i * dlon, lat0 + j * dlat));
      let level = want;
      if (tp.availability) {
        const mid = cartos[cartos.length >> 1];
        level = Math.min(want, tp.availability.computeMaximumLevelAtPosition(mid));
      }
      await Cesium.sampleTerrain(tp, level, cartos);
      const retry = cartos.filter(c => !Number.isFinite(c.height));
      if (retry.length && tp.availability) await Cesium.sampleTerrainMostDetailed(tp, retry);
      for (let k = 0; k < cartos.length; k++) {
        const h = cartos[k].height;
        if (Number.isFinite(h)) heights[j0 * nx + k] = h; else missing++;
      }
      onProgress && onProgress(j1 / ny, cell, nx * ny);
    }
    if (missing > 0.5 * nx * ny) throw new Error('The map terrain could not be read for most of the box.');
    return { lon0, lat0, dlon, dlat, nx, ny, cell, heights };
  }
  function _floatsToBase64(arr) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(new Blob([arr.buffer]));
    });
  }

  // Export choices stick between sessions (not the hillshade tile URL).
  (function _rememberExportChoices() {
    const ids = ['export_terrain_source', 'export_map_cell', 'export_resolution', 'export_max_tri',
                 'export_tex_size', 'export_caves_mode', 'export_satellite_source', 'export_hillshade_mode'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      let v = null;
      try { v = localStorage.getItem('flex.export.' + id); } catch (_) {}
      if (v != null && [...el.options].some(o => o.value === v)) {
        el.value = v;
        if (el.onchange) el.onchange();      // the hillshade URL field follows its mode
      }
      el.addEventListener('change', () => { try { localStorage.setItem('flex.export.' + id, el.value); } catch (_) {} });
    }
    window._exportSyncTerrainSource();
  })();

  window._exportRun = function() {
    const nameEl  = document.getElementById('export_map_name');
    const mapName = nameEl.value.trim();
    if (!mapName) {
      nameEl.style.borderColor = '#ff5a5a';
      document.getElementById('export_map_name_hint').style.display = 'block';
      const body = document.getElementById('lp-export-name-body');
      if (body && !body.classList.contains('open') && window._lpToggle)
        window._lpToggle(body.previousElementSibling);
      nameEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      nameEl.focus();
      return;
    }
    if (!_bboxCorner1 || !_bboxCorner2) { alert('Draw a bbox first.'); return; }
    if (_exportPoly && _polySelfCrossing(_exportPoly)) { _polyNote('The polygon\'s edges cross: drag its points so they don\'t, then export.', true); return; }
    const poly = _exportPoly ? _exportPoly.map(p => [+p[0].toFixed(8), +p[1].toFixed(8)]) : null;

    const [w, s] = [Math.min(_bboxCorner1[0], _bboxCorner2[0]), Math.min(_bboxCorner1[1], _bboxCorner2[1])];
    const [e, n] = [Math.max(_bboxCorner1[0], _bboxCorner2[0]), Math.max(_bboxCorner1[1], _bboxCorner2[1])];

    const mapTerrain       = document.getElementById('export_terrain_source').value === 'map';
    const mapCell          = document.getElementById('export_map_cell').value;
    const eptPath          = mapTerrain ? '' : document.getElementById('export_ept_select').value;
    const resolution       = parseFloat(document.getElementById('export_resolution').value);
    const maxTri           = parseInt(document.getElementById('export_max_tri').value);
    const texSize          = parseInt(document.getElementById('export_tex_size').value);
    const cavesMode        = document.getElementById('export_caves_mode').value;   // walls | lines | none
    const satelliteSource  = document.getElementById('export_satellite_source').value;
    let   hillshadeMode    = document.getElementById('export_hillshade_mode').value;
    if (mapTerrain && hillshadeMode === 'lidar') hillshadeMode = 'dem';
    const hillshadeUrl     = document.getElementById('export_hillshade_url').value.trim();
    if (hillshadeMode === 'url' && !hillshadeUrl) {
      document.getElementById('export_hillshade_url').style.borderColor = '#ff5a5a';
      document.getElementById('export_hillshade_url').focus();
      return;
    }
    if (!mapTerrain && !eptPath) { alert('No point cloud selected: load one in the LiDAR panel, or set Terrain to "Map terrain".'); document.getElementById('export_run_btn').disabled = false; return; }

    const caves = cavesMode === 'none' ? { surveys: [] }
                : _collectCavesInBbox(w, s, e, n, { walls: cavesMode === 'walls', poly });

    const body = {
      bbox: [w, s, e, n],
      polygon: poly,                 // null: the whole box
      eptPath,
      resolution,
      max_triangles: maxTri,
      tex_size: texSize,
      satellite_source: satelliteSource,
      hillshade_mode: hillshadeMode,
      hillshade_url: hillshadeMode === 'url' ? hillshadeUrl : '',
      name: mapName,
      caves,
      // The terrain takes the point clouds' vertical shift, as the caves do.
      z_offset: window._pcDatumDz ? window._pcDatumDz((s + n) / 2, (w + e) / 2) : null,
    };

    document.getElementById('export_run_btn').disabled = true;
    document.getElementById('export_progress_wrap').style.display = 'block';
    document.getElementById('export_download_wrap').style.display = 'none';
    _setProgress(0, mapTerrain ? 'Reading the map terrain…' : 'Submitting…');

    // Map terrain: read the heights here first, then send them with the job.
    const ready0 = !mapTerrain ? Promise.resolve(body)
      : _sampleMapTerrain(w, s, e, n, mapCell, (f, cell, count) =>
          _setProgress(Math.round(f * 10), `Reading the map terrain: ${Math.round(f * 100)}% of ${count.toLocaleString()} heights (${cell} m)…`))
        .then(async g => {
          body.dem_grid = { lon0: g.lon0, lat0: g.lat0, dlon: g.dlon, dlat: g.dlat, nx: g.nx, ny: g.ny, cell: g.cell,
                            heights: await _floatsToBase64(g.heights) };
          body.resolution = g.cell;
          _setProgress(10, 'Submitting…');
          return body;
        });

    // The project's terrain patches over the box, and a map layer chosen as satellite / hillshade (custom-layers.js)
    const ready = ready0.then(b => window._customLayers && window._customLayers.exportExtras
      ? window._customLayers.exportExtras(b, { w, s, e, n, mapTerrain, satelliteSource, hillshadeMode: document.getElementById('export_hillshade_mode').value }) : b);

    const submit = b => fetch('/api/export/terrain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b)
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      _exportJobId = data.jobId;
      _pollProgress();
      // The Jobs panel (jobs-panel.js): Cancel and Log go to the server; Retry sends the same request again
      if (window._jobs) window._jobs.add({ id: 'export.' + data.jobId, kind: 'export', name: 'Offline map: ' + mapName, server: true,
        retry: () => { document.getElementById('export_run_btn').disabled = true; document.getElementById('export_progress_wrap').style.display = 'block';
                       document.getElementById('export_download_wrap').style.display = 'none'; _setProgress(0, 'Submitting…'); submit(b).catch(failed); } });
    });
    const failed = err => {
      _setProgress(0, '✗ ' + err.message);
      document.getElementById('export_run_btn').disabled = false;
    };
    ready.then(submit).catch(failed);
  };

  function _setProgress(pct, msg) {
    document.getElementById('export_progress_bar').style.width = pct + '%';
    document.getElementById('export_status_text').textContent = msg;
  }

  function _pollProgress() {
    if (!_exportJobId) return;
    clearTimeout(_pollTimer);
    fetch('/api/export/status/' + _exportJobId)
    .then(r => r.json())
    .then(data => {
      _setProgress(data.progress || 0, data.message || data.status || '…');
      if (data.status === 'done') {
        _setProgress(100, '✓ Done!');
        const dl = document.getElementById('export_download_link');
        dl.href = '/api/export/download/' + _exportJobId;
        dl.download = data.filename || 'flex_export.zip';
        document.getElementById('export_download_wrap').style.display = 'block';
        document.getElementById('export_run_btn').disabled = false;
      } else if (data.status === 'error') {
        _setProgress(0, '✗ ' + (data.error || 'Export failed'));
        document.getElementById('export_run_btn').disabled = false;
      } else {
        _pollTimer = setTimeout(_pollProgress, 1500);
      }
    })
    .catch(() => {
      _pollTimer = setTimeout(_pollProgress, 2000);
    });
  }

})(); // end export UI
