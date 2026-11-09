// flex-leads.js — leads on cave stations, wherever they are kept: the open project's records,
// My data's, and the survey file's own (Breakout / Walls). One place for
//   - adding / editing / closing / removing a lead at a station of a loaded cave (the same dialog
//     as the project's: project-caves.js editLead, given the store it writes to),
//   - drawing them: the same "?" marker at the station's own 3D position (cave data keeps its
//     own height, no ground clamping) with a short label; closed leads only when asked,
//   - what the terrain export takes: window._flexLeads.exportFor(imp, ...),
//   - the ❓ Leads list without a project.
//
// Where a lead is kept (decided here, see CLAUDE.md "Leads"):
//   project open and the cave is one of its caves  →  the project's log (p-<project>), as ever
//   otherwise                                      →  My data's log (user_files/mine, /api/mine/append):
//                                                      the same lead.set / lead.del records, replayed by
//                                                      flexlib.replayProject(…, 'mine'), the target is
//                                                      station:<cave key>:<station>, the cave key being
//                                                      f.<file name, URL-escaped> (no ':' in it).
// A file lead adopted into either keeps source 'export' and the id x<hash> (project-caves.js
// exportLeadId), so it never shows twice.
//
// window._flexLeads = { mineCid, mineStore, add, look, spec, redraw, syncFile, setClosed, closed,
//   visibility, exportFor, panel, card, fileLeadFor, lookup, labelOf, stationPos, all }
(function () {
  'use strict';
  const A = window._pjApi, FL = window.FlexLib;
  if (!A || !FL) return;
  const { pj } = A;
  const V = () => window.cesiumViewer;
  const imps = () => (window._caveImports || []).filter(i => i && i.parsed);
  const niceName = imp => String(imp.name || '').replace(/\.(plt|json)$/i, '');
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  let showClosed = lsGet('flex.leads.closed') === '1';
  const closed = () => showClosed;

  // ── My data's leads ────────────────────────────────────────────────────────
  let mineS = null;                                       // replayed My data (window._myData.state)
  const mineCid = imp => 'f.' + encodeURIComponent(imp.name);
  const impOfCid = cid => imps().find(i => mineCid(i) === cid) || null;
  async function mineLoad(force) {
    if (!window._myData) return null;
    try { mineS = await window._myData.state(!!force); } catch (e) { console.warn('[leads] My data:', e); }
    return mineS;
  }
  const mineLeadsMap = () => (mineS && mineS.leads) || {};
  const mineStore = {
    mine: true,
    get P() { return mineS || FL.replayProject([], 'mine'); },
    caveName: cid => { const i = impOfCid(cid); return i ? niceName(i) : 'a cave'; },
    async record(op, data) {
      if (!window._myData) return null;
      let e = null;
      try { e = await window._myData.record(op, data); } catch (err) { A.toast('Could not save: ' + err.message); return null; }
      await mineLoad(true);
      changed();
      return e;
    },
  };
  const isMineCid = cid => String(cid || '').startsWith('f.');

  // ── Positions ──────────────────────────────────────────────────────────────
  // A station's own place: the cave data's n / e / v through the cave's converter (its height).
  function stationPos(cid, name) {
    if (isMineCid(cid)) {
      const imp = impOfCid(cid);
      if (!imp || typeof imp._convertFn !== 'function') return null;
      const s = A.stationsOf(imp, name)[0];
      return s ? imp._convertFn(s.n, s.e, s.v) || null : null;
    }
    return A.stationPos(cid, name);
  }
  function labelOf(target) {
    const p = FL.parseTarget(target);
    if (p.kind === 'station' && isMineCid(p.cave)) return `${p.name} · ${mineStore.caveName(p.cave)}`;
    return A.targetLabel(target);
  }

  // ── All leads kept as records ──────────────────────────────────────────────
  const rowOf = (L, store) => ({ id: L.id, rec: L, fields: L.fields, active: FL.leadActive(L), target: L.target, store });
  /** My data's lead records (not removed). */
  function mineRows() { return Object.values(mineLeadsMap()).filter(L => !L.deleted).map(L => rowOf(L, mineStore)); }
  /** A file's own leads that are not records yet, for caves not in the open project (their store is My data). */
  function fileRows() {
    const out = [];
    imps().forEach(imp => (imp.parsed.leads || []).forEach(ld => {
      if (ld.done) return;
      const s = A.stationsOf(imp, ld.station)[0];
      if (pj.pid && A.caveFor(imp, s ? s.survey || '' : '')) return;          // the project lists those
      const cid = mineCid(imp), id = A.exportLeadId(cid, ld);
      if (mineLeadsMap()[id]) return;
      out.push({ id, rec: null, ld, fields: A.exportLeadFields(ld), active: true, target: FL.T.station(cid, ld.station), store: mineStore });
    }));
    return out;
  }
  const all = () => mineRows().concat(fileRows());

  // ── Add / edit ─────────────────────────────────────────────────────────────
  /** Where a lead at a station of this loaded cave is kept: { cid, store } (store undefined = the project). */
  function whereFor(imp, code) {
    const cid = pj.pid && !pj.readonly ? A.caveFor(imp, code || '') : null;
    return cid ? { cid, store: undefined, project: true } : { cid: mineCid(imp), store: mineStore, project: false };
  }
  /** "Add lead…" at a station of a loaded cave: opens the dialog. */
  async function add(imp, code, station) {
    if (!imp || !station) return;
    await mineLoad();
    const w = whereFor(imp, code);
    return A.editLead(w.cid, station, null, w.store);
  }
  /** The leads at a station (records + the file's own), as the station card lists them. */
  function at(imp, code, station) {
    const w = whereFor(imp, code);
    if (w.project) return A.leadsAt(w.cid, station);
    const target = FL.T.station(w.cid, station), out = [], seen = new Set();
    (imp.parsed.leads || []).forEach(ld => {
      if (ld.station !== station || ld.done) return;
      const id = A.exportLeadId(w.cid, ld), rec = mineLeadsMap()[id];
      if (seen.has(id)) return;
      seen.add(id);
      if (rec && rec.deleted) return;
      out.push({ id, rec: rec || null, ld, fields: rec ? rec.fields : A.exportLeadFields(ld), active: rec ? FL.leadActive(rec) : true, target, store: mineStore });
    });
    Object.values(mineLeadsMap()).forEach(L => { if (L.target === target && !seen.has(L.id) && !L.deleted) out.push(rowOf(L, mineStore)); });
    return out;
  }

  // ── What a lead looks like on the map ──────────────────────────────────────
  const shortText = (fields, station) => { const t = String((fields && fields.desc) || '').replace(/\s+/g, ' ').trim() || String(station || ''); return t.length > 26 ? t.slice(0, 25) + '…' : t; };
  function look({ fields, station, faded, ground }) {
    const icon = typeof window._leadBillboardProps === 'function' ? window._leadBillboardProps() : null;
    const out = {};
    if (icon) out.billboard = Object.assign({}, icon, { color: faded ? Cesium.Color.WHITE.withAlpha(0.45) : Cesium.Color.WHITE, scale: faded ? 0.75 : 1, disableDepthTestDistance: 5000 },
      ground ? { pixelOffset: new Cesium.Cartesian2(0, -12) } : {});
    else out.label = { text: '?', font: 'bold 18px sans-serif', fillColor: Cesium.Color.fromCssColorString('#ffeb3b').withAlpha(faded ? 0.5 : 1), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: 5000 };
    const text = shortText(fields, station);
    if (text && icon) out.label = { text, font: '12px sans-serif', fillColor: Cesium.Color.WHITE.withAlpha(faded ? 0.6 : 1), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, ground ? -40 : -28),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 300), disableDepthTestDistance: 5000 };
    return out;
  }
  const esc = A.esc;
  function descHtml(fields, extra) {
    return (extra ? esc(extra) + '<br>' : '') + esc(A.leadSummary(fields)) + (fields.desc ? '<br>' + esc(fields.desc) : '');
  }

  // ── Drawing My data's leads ────────────────────────────────────────────────
  let src = null;
  function visibleNow() { return typeof window._caveLeadsOn === 'function' ? window._caveLeadsOn() : true; }
  function redraw() {
    const v = V();
    if (!v || !window.Cesium) return;
    if (!src) { src = new Cesium.CustomDataSource('flex-leads'); v.dataSources.add(src); }
    src.entities.removeAll();
    src.show = visibleNow();
    mineRows().forEach(x => {
      const act = x.active;
      if (!act && !showClosed) return;
      // an adopted file lead is drawn from its record (its edits); syncFile() hides the file's own marker
      const t = FL.parseTarget(x.target);
      if (t.kind !== 'station') return;
      const pos = stationPos(t.cave, t.name);
      if (!pos) return;
      src.entities.add(Object.assign({
        position: pos, name: 'Lead at ' + t.name,
        description: descHtml(x.fields, 'Cave: ' + mineStore.caveName(t.cave)),
        properties: { isFeatureLead: true, leadId: x.id, isMineLead: true },
      }, look({ fields: x.fields, station: t.name, faded: !act })));
    });
    syncFile();
    v.scene.requestRender && v.scene.requestRender();
  }
  /** The file's own markers: hidden once their lead was adopted and then closed or removed. */
  function syncFile() {
    const v = V();
    if (!v) return;
    const on = visibleNow();
    imps().forEach(imp => {
      (imp.cesiumIds || []).forEach(id => {
        const e = v.entities.getById(id);
        if (!e || !e.properties || !e.properties.isCaveLead) return;
        const st = e.properties.leadStation && e.properties.leadStation.getValue();
        const d = e.properties.leadD ? e.properties.leadD.getValue() : '';
        const ld = (imp.parsed.leads || []).find(l => l.station === st && String(l.d == null ? '' : l.d) === d);
        let gone = false;
        if (ld) {
          const s = A.stationsOf(imp, st)[0];
          const ids = [A.exportLeadId(mineCid(imp), ld)];
          const cid = pj.pid ? A.caveFor(imp, s ? s.survey || '' : '') : null;
          if (cid) ids.push(A.exportLeadId(cid, ld));
          gone = ids.some(i => !!(pj.P.leads[i] || mineLeadsMap()[i]));   // adopted: its record is drawn instead (open, with edits) or it was closed or removed
        }
        e._flexHidden = gone;
        e.show = imp.visible !== false && on && !gone;
      });
    });
  }
  function visibility() {
    if (src) src.show = visibleNow();
    const v = V(), ds = v && v.dataSources.getByName('pj-leads')[0];
    if (ds) ds.show = visibleNow();
    syncFile();
    v && v.scene.requestRender && v.scene.requestRender();
  }
  function setClosed(on) {
    showClosed = !!on;
    lsSet('flex.leads.closed', showClosed ? '1' : '0');
    redraw();
    if (A.drawLeads) A.drawLeads();
  }
  /** After any change to a My data lead. */
  function changed() {
    redraw();
    if (A.refreshCard) A.refreshCard();
    if (A.render) A.render();
    if (window._info && window._info.changed) window._info.changed({ op: 'lead.set' });
    if (window._inspector && window._inspector.refresh) window._inspector.refresh();
  }

  // ── Finding one lead (info panel card, tests) ──────────────────────────────
  /** A file lead by its id (under the project's cave or My data's key). */
  function fileLeadFor(id) {
    for (const imp of imps()) for (const ld of imp.parsed.leads || []) {
      if (ld.done) continue;
      const s = A.stationsOf(imp, ld.station)[0];
      const cids = [mineCid(imp)];
      const pc = pj.pid ? A.caveFor(imp, s ? s.survey || '' : '') : null;
      if (pc) cids.unshift(pc);
      for (const cid of cids) if (A.exportLeadId(cid, ld) === id) {
        const target = FL.T.station(cid, ld.station);
        return { imp, ld, cid, target, project: cid === pc, row: { id, rec: null, ld, fields: A.exportLeadFields(ld), active: true, target, store: cid === pc ? undefined : mineStore } };
      }
    }
    return null;
  }
  /** The id of a file lead's marker (entity), as its card needs. */
  function fileLeadIdOf(ent) {
    const pr = k => (ent.properties && ent.properties[k] ? ent.properties[k].getValue() : null);
    const imp = imps().find(i => i.name === pr('surveyName'));
    if (!imp) return null;
    const st = pr('leadStation'), d = pr('leadD') || '';
    const ld = (imp.parsed.leads || []).find(l => l.station === st && String(l.d == null ? '' : l.d) === d);
    if (!ld) return null;
    const s = A.stationsOf(imp, st)[0];
    const pc = pj.pid ? A.caveFor(imp, s ? s.survey || '' : '') : null;
    const own = A.exportLeadId(pc || mineCid(imp), ld);
    return own;
  }
  /** { L, row, store } for a lead id: the project's, My data's, or a file's. */
  function lookup(id) {
    const P = pj.P && pj.P.leads[id];
    if (P && !P.deleted) return { L: P, row: rowOf(P, undefined), store: undefined };
    const M = mineLeadsMap()[id];
    if (M && !M.deleted) return { L: M, row: rowOf(M, mineStore), store: mineStore };
    const f = fileLeadFor(id);
    if (f) return { L: { id, target: f.target, fields: f.row.fields, file: true }, row: f.row, store: f.row.store, file: f };
    return null;
  }

  // ── The export ─────────────────────────────────────────────────────────────
  /**
   * What the terrain export adds for one loaded cave file: FLEX leads (project + My data) at its stations and
   * which of the file's own leads they replace (adopted ones: the record wins, closed or removed ones go).
   * stnByName: station name → station object (n/e/v, survey). Returns { leads: [{ s, station, fields, id, status, source }], adopted(ld, s) }.
   */
  function exportFor(imp, stnByName) {
    const out = [];
    const mc = mineCid(imp);
    const mine = mineLeadsMap();
    const caveOf = s => (pj.pid ? A.caveFor(imp, s.survey || '') : null);
    const take = (L, source) => {
      if (L.deleted || !FL.leadActive(L)) return;
      const t = FL.parseTarget(L.target);
      if (t.kind !== 'station') return;
      const s = stnByName.get(t.name);
      if (!s) return;
      if (source === 'mine' ? t.cave !== mc : caveOf(s) !== t.cave) return;
      out.push({ s, station: t.name, fields: L.fields, id: L.id, status: (L.fields && L.fields.status) || 'open', source: 'flex', where: source });
    };
    if (pj.pid) Object.values(pj.P.leads).forEach(L => take(L, 'project'));
    Object.values(mine).forEach(L => take(L, 'mine'));
    return {
      leads: out,
      adopted: (ld, s) => {
        const ids = [A.exportLeadId(mc, ld)];
        const pc = s ? caveOf(s) : null;
        if (pc) ids.push(A.exportLeadId(pc, ld));
        return ids.some(i => pj.P.leads[i] || mine[i]);
      },
    };
  }

  // ── Station card (no project, or a cave the project doesn't have) ──────────
  function card(box, c) {
    if (!c || !c.imp || c.survey || c.level === 'cave' || !c.name) return;
    const el = A.el, btn = A.btn;
    const items = at(c.imp, c.code || '', c.name);
    if (items.length) {
      box.appendChild(el('div', 'pj-h', 'Leads'));
      items.forEach(x => box.appendChild(A.leadEl(mineCid(c.imp), c.name, x)));
    }
    const row = el('div', 'pj-row pj-card-btns');
    row.appendChild(btn(['help', 'Lead'], () => add(c.imp, c.code || '', c.name)));
    box.appendChild(row);
  }

  // ── ❓ Leads: My data's, and a list without a project ──────────────────────
  function panel(b, standalone) {
    const el = A.el, btn = A.btn;
    const rows = all();
    const tabs = el('div', 'pj-tabs');
    const mode = pj.leadShow || 'active';
    [['active', `Active (${rows.filter(x => x.active).length})`], ['closed', `Closed (${rows.filter(x => !x.active).length})`], ['all', `All (${rows.length})`]].forEach(([k, l]) =>
      tabs.appendChild(btn(l, () => { pj.leadShow = k; A.render(); }, mode === k ? 'on' : '')));
    if (standalone) b.appendChild(tabs);
    else b.appendChild(el('div', 'pj-h', 'My data'));
    const shown = rows.filter(x => !standalone || mode === 'all' || (mode === 'active') === x.active)
      .filter(x => standalone || x.active)
      .sort((a, c) => (Number(a.fields.priority) || 9) - (Number(c.fields.priority) || 9));
    if (!shown.length) b.appendChild(el('div', 'pj-note', standalone
      ? 'None yet. Load a cave, click one of its stations and press Lead (or right-click the station: Add lead). Without a project the lead is kept in My data.'
      : 'None.'));
    shown.slice(0, 200).forEach(x => {
      const t = FL.parseTarget(x.target);
      const r = el('div', 'pj-item' + (x.active ? '' : ' closed'));
      r.appendChild(el('div', 'pj-item-t', `${t.name || '?'} · ${mineStore.caveName(t.cave)}`));
      r.appendChild(el('div', 'pj-sub', A.leadSummary(x.fields) + (x.fields.desc ? ' — ' + x.fields.desc : '') + (x.ld ? ' · from the survey file' : '')));
      r.addEventListener('click', () => {
        const pos = stationPos(t.cave, t.name), v = V();
        if (pos && v) v.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 25), { duration: 1.2 });
        else A.toast('That cave isn’t loaded');
      });
      r.appendChild(btn(['pencil'], ev => { ev.stopPropagation(); A.editLead(t.cave, t.name, x, mineStore); }, 'small'));
      b.appendChild(r);
    });
  }

  // ── Starting ───────────────────────────────────────────────────────────────
  const wait = setInterval(() => {
    if (!window._myData || !V() || !window.Cesium) return;
    clearInterval(wait);
    const cb = document.getElementById('lp-cave-leads-closed-toggle'); if (cb) cb.checked = showClosed;
    mineLoad(true).then(() => { redraw(); if (A.render) A.render(); });
  }, 400);

  window._flexLeads = { mineCid, mineStore, add, at, look, redraw, syncFile, setClosed, closed, visibility, exportFor, panel, card, fileLeadFor, fileLeadIdOf, lookup, labelOf, stationPos, all, load: mineLoad, descHtml };
})();
