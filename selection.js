// selection.js — what a click on a cave selects (project doc 14, item 8).
//
//   - The first click on a cave selects the cave.
//   - A click inside the current selection goes one level deeper:
//     cave → survey → segment → station (segments skipped when the project
//     has none, they are switched off, or the shot is in none).
//   - A click outside it selects the same level there (a shot in no segment
//     falls back to its survey).
//   - Clicking the selected station again goes back to the cave.
//   - Empty space or Esc clears it (inspector.js, project.js).
// The details panel shows the path (Cave › Survey › Segment › Station), each
// part clickable. The cave or survey is outlined on the map; a segment is
// drawn by project_segments.js. Right-click on a cave object puts a "Select"
// section on top of the map menu (context-menu.js asks window._selMenu).
(function () {
  'use strict';
  const A = window._pjApi;
  const V = () => window.cesiumViewer;
  const pjOf = () => window._pj || {};
  let S = null;                 // { level, hit, cid, sid }
  let hl = null;                // outline of the cave / survey

  const imps = () => (window._caveImports || []).filter(i => i && i.parsed);
  const prop = (e, k) => (e && e.properties && e.properties[k] ? e.properties[k].getValue() : null);
  /** What a click landed on: { imp, code, station?, ends?, near? }. */
  function hitOf(ent) {
    if (!prop(ent, 'isCaveSurvey')) return null;
    const imp = imps().find(i => i.name === prop(ent, 'surveyName'));
    if (!imp) return null;
    const station = prop(ent, 'stationName') || null;
    const from = prop(ent, 'fromStation'), to = prop(ent, 'toStation');
    return { imp, code: prop(ent, 'surveyCode') || '', station, ends: from && to ? [from, to] : null, near: station || prop(ent, 'nearStation') || null, ent };
  }
  const cidOf = h => (pjOf().pid && A ? A.caveFor(h.imp, h.code) : null);
  const caveKey = h => cidOf(h) || 'file:' + h.imp.name;
  /** Segments the clicked shot or station is in (none without segments). */
  function segsOf(h) {
    const seg = window._pjSeg, cid = cidOf(h);
    if (!seg || !cid || !seg.on()) return [];
    const I = seg.info(cid), P = pjOf().P;
    let ids = [];
    if (h.ends) ids = I.idx.shot.get(h.ends[0] + '|' + h.ends[1]) || I.idx.shot.get(h.ends[1] + '|' + h.ends[0]) || [];
    else if (h.station) ids = I.idx.station.get(h.station) || [];
    return ids.filter(id => P.segments[id] && !P.segments[id].removed);
  }
  function inside(h) {
    if (!S || caveKey(h) !== caveKey(S.hit)) return false;
    if (S.level === 'cave') return true;
    if (S.level === 'survey') return h.code === S.hit.code;
    if (S.level === 'segment') return segsOf(h).includes(S.sid);
    if (S.level === 'station') return (h.station || (h.ends && h.near)) === S.station;
    return false;
  }
  /** The selection at a level, for this hit. */
  function at(level, h, prefer) {
    const sel = { level, hit: h, cid: cidOf(h) };
    if (level === 'segment') {
      const ids = segsOf(h);
      if (!ids.length) return at('survey', h);
      sel.sid = prefer && ids.includes(prefer) ? prefer : ids[0];
    }
    if (level === 'station') sel.station = h.station || h.near;
    if (level === 'station' && !sel.station) return at('survey', h);
    return sel;
  }
  const deeper = { cave: 'survey', survey: 'segment', segment: 'station' };

  // ── Showing it ───────────────────────────────────────────────────────────
  function outline(sel) {
    const v = V();
    if (!v) return;
    if (!hl) { hl = new Cesium.CustomDataSource('sel-outline'); v.dataSources.add(hl); }
    hl.entities.removeAll();
    if (!sel || (sel.level !== 'cave' && sel.level !== 'survey')) { v.scene.requestRender && v.scene.requestRender(); return; }
    const parts = sel.cid && A ? A.partsOf(sel.cid).map(p => ({ imp: p.imp, codes: p.codes })) : [{ imp: sel.hit.imp, codes: null }];
    const white = Cesium.Color.WHITE;
    let n = 0;
    parts.forEach(({ imp, codes }) => {
      const f = imp._convertFn;
      if (typeof f !== 'function') return;
      (imp.parsed.segments || []).forEach(sg => {
        const code = sg.survey || '';
        if (codes && !codes.has(code)) return;
        if (sel.level === 'survey' && code !== sel.hit.code) return;
        const pos = sg.points.filter(q => Number.isFinite(q.n)).map(q => f(q.n, q.e, q.v)).filter(Boolean);
        if (pos.length < 2 || n > 4000) return;
        n++;
        hl.entities.add({ polyline: { positions: pos, width: 4, material: white.withAlpha(0.75), depthFailMaterial: white.withAlpha(0.3) } });
      });
    });
    v.scene.requestRender && v.scene.requestRender();
  }
  function show(sel) {
    S = sel;
    const h = sel.hit, seg = window._pjSeg, v = V();
    if (sel.level !== 'segment' && seg && seg.dockOpen && seg.dockOpen()) { seg.closeDock(); }
    // The map's own selection (green corners, Cesium's info) for the clicked
    // shot or station; its description shows only for a station.
    if (v && h.ent && v.selectedEntity !== h.ent) v.selectedEntity = h.ent;
    if (A) {
      if (sel.level === 'cave') A.openCard({ imp: h.imp, code: h.code, cid: sel.cid, level: 'cave' });
      else if (sel.level === 'survey') A.openCard({ imp: h.imp, code: h.code, cid: sel.cid, survey: true, ends: [], level: 'survey' });
      else if (sel.level === 'station') A.openCard({ imp: h.imp, code: h.code, cid: sel.cid, name: sel.station, level: 'station' });
      else if (sel.level === 'segment') { A.closeCard(); seg.showSegment(sel.cid, sel.sid); }
    }
    outline(sel);
    if (window._inspector) window._inspector.refresh();
  }

  // ── The API ──────────────────────────────────────────────────────────────
  /** A left click on a cave object (cave_layers.js). True: handled here. */
  function click(ent) {
    const h = hitOf(ent);
    if (!h) return false;
    let sel;
    if (!S) sel = at('cave', h);
    else if (inside(h)) {
      let next = S.level === 'station' ? 'cave' : deeper[S.level];
      if (next === 'segment' && !segsOf(h).length) next = 'station';     // no segment there: skipped
      sel = at(next, h, S.sid);
    }
    else sel = at(S.level, h, S.sid);
    show(sel);
    return true;
  }
  function clear() {
    if (!S) return;
    S = null;
    outline(null);
    if (window._inspector) window._inspector.refresh();
  }
  /** The path for the details panel: [{ label, level, on }]. */
  function crumbs() {
    if (!S) return [];
    const h = S.hit, out = [];
    out.push({ level: 'cave', label: '🕳 ' + (S.cid && A ? A.caveName(S.cid) : h.imp.name.replace(/\.(plt|json)$/i, '')) });
    if (S.level === 'cave') return out;
    out.push({ level: 'survey', label: 'Survey ' + (h.code || '(none)') });
    if (S.level === 'survey') return out;
    const seg = window._pjSeg;
    const sid = S.sid || (S.level === 'station' ? segsOf(h)[0] : null);
    if (sid) out.push({ level: 'segment', label: 'Segment ' + (seg ? seg.segName(sid) : sid), sid });
    if (S.level === 'station') out.push({ level: 'station', label: S.station });
    return out;
  }
  function toLevel(level, sid) { if (!S) return; show(at(level, S.hit, sid || S.sid)); }
  /** A segment chip on a card (project_segments.js). */
  function toSegment(cid, sid) {
    if (S && S.cid === cid) { show(Object.assign(at('segment', S.hit, sid), { sid })); return; }
    if (window._pjSeg) window._pjSeg.showSegment(cid, sid);
  }

  // ── Right-click: "Select" on top of the map menu (context-menu.js) ───────
  window._selMenu = canvasPos => {
    const v = V();
    if (!v || !window._caveMaterialize) return [];
    const picked = v.scene.pick(canvasPos), id = picked && picked.id;
    if (!id || !id._caveLazy) return [];
    const ent = window._caveMaterialize(id, canvasPos), h = hitOf(ent);
    if (!h) return [];
    const items = [];
    const name = (h.cid = cidOf(h)) && A ? A.caveName(h.cid) : h.imp.name.replace(/\.(plt|json)$/i, '');
    items.push({ label: '🕳 Cave ' + name, run: () => show(at('cave', h)) });
    items.push({ label: 'Survey ' + (h.code || '(none)'), run: () => show(at('survey', h)) });
    segsOf(h).forEach(sid => items.push({ label: 'Segment ' + (window._pjSeg ? window._pjSeg.segName(sid) : sid), run: () => show(Object.assign(at('segment', h, sid), { sid })) }));
    const st = h.station ? [h.station] : (h.ends || []);
    st.forEach(n => items.push({ label: '📍 Station ' + n, run: () => show(Object.assign(at('station', Object.assign({}, h, { near: n })), { station: n })) }));
    return items;
  };

  window._sel = { click, clear, crumbs, toLevel, toSegment, active: () => !!S, level: () => (S ? S.level : null), state: () => S };
})();
