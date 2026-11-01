// projects_panel.js — the top of 📁 Project.
//
// No project open: Projects, a card per project (its numbers, its folder, an
// Open button), ＋ New, and the projects' footprints on the map (click one,
// or a card, for its numbers in the details panel).
// A project open: its overview (name, description, folder, numbers, what is
// in it) with Switch…. The rest of the 📁 panel (project.js) follows below.
//
// Numbers that need the survey files (length surveyed, depth, the footprint
// around the cave lines and the project's points) are worked out once per
// survey file version and kept in the project's .flex/stats.json
// (/api/lib/stats); counts come from the project's log each time.
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) return;
  const { pj, FL, el, btn, esc, toast, choose } = A;
  const V = () => window.cesiumViewer, ws = () => window._ws;
  const X = { info: {}, busy: new Set(), sel: null, docs: null, ds: null };
  window._pjxState = X;                                // tests
  const prefKey = 'flex.pjx.footprints';
  const showFootprints = () => { try { return localStorage.getItem(prefKey) !== '0'; } catch (_) { return true; } };

  const api = async (p, opt) => { const r = await fetch('/api/lib/' + p, opt); if (!r.ok) throw new Error(p + ': ' + r.status); return r; };
  const lines = t => t.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const placeKey = g => JSON.stringify(g || null);

  // ── Numbers ──────────────────────────────────────────────────────────────
  function hull(pts) {                                   // monotone chain, [[lon, lat]]
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function featurePts(P) {
    const out = [];
    FL.liveFeatures(P).forEach(f => (f.coords || []).forEach(c => { if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) out.push([c[0], c[1]]); }));
    return out;
  }
  async function docsAll() {
    if (!X.docs) X.docs = FL.replayDocs(lines(await (await api('read?scope=docs')).text()));
    return X.docs;
  }
  /** A project's numbers; survey-file ones from the kept stats, worked out where missing. */
  async function info(p, { compute = true } = {}) {
    const es = p.id === pj.pid ? pj.proj : lines(await (await api('read?scope=' + FL.projScope(p.id))).text());
    const P = p.id === pj.pid ? pj.P : FL.replayProject(es, p.id);
    const D = p.id === pj.pid ? pj.D : await docsAll();
    const files = FL.liveCavefiles(P);
    let st = null;
    try { st = await (await api('stats?project=' + encodeURIComponent(p.id))).json(); } catch (_) {}
    st = st && st.v === 1 ? st : { v: 1, caves: {} };
    let changed = false;
    const keep = new Set();
    for (const f of files) {
      const key = (f.h || '') + '|' + placeKey(f.place);
      keep.add(f.file);
      if (st.caves[f.file] && st.caves[f.file].key === key) continue;
      if (!compute || !f.h || !f.place || !ws() || !ws().caveGeometry) continue;
      const r = await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt'));
      if (!r.ok) continue;
      const g = ws().caveGeometry(await r.text(), f.place);
      if (!g) continue;
      st.caves[f.file] = { key, length: g.length, depth: g.depth, stations: g.stations, hull: hull(g.pts) };
      changed = true;
    }
    Object.keys(st.caves).forEach(k => { if (!keep.has(k)) { delete st.caves[k]; changed = true; } });
    const cs = Object.values(st.caves);
    const around = hull(cs.flatMap(c => c.hull || []).concat(featurePts(P)));
    if (JSON.stringify(around) !== JSON.stringify(st.footprint || [])) { st.footprint = around; changed = true; }
    if (changed) { st.at = new Date().toISOString(); api('stats?project=' + encodeURIComponent(p.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) }).catch(() => {}); }
    const people = new Set(es.map(e => e.who).filter(Boolean));
    const last = es.reduce((m, e) => (e.t && e.t > m ? e.t : m), '');
    const leads = Object.values(P.leads || {}).filter(L => !L.deleted);
    const I = {
      id: p.id, name: p.name || P.name || p.id, desc: P.desc || '', folder: p.folder || null,
      caves: FL.liveCaves(P).length, files: files.length,
      length: cs.reduce((s, c) => s + (c.length || 0), 0), deepest: cs.reduce((m, c) => Math.max(m, c.depth || 0), 0),
      stations: cs.reduce((s, c) => s + (c.stations || 0), 0), measured: cs.length, pending: files.length - cs.length,
      open: leads.filter(L => FL.leadActive(L)).length, closed: leads.filter(L => !FL.leadActive(L)).length,
      docs: FL.docsOf(D, P).length, points: FL.liveFeatures(P).length, folders: FL.liveGroups(P).length,
      layers: FL.liveLayers(P).length, review: FL.reviewQueue(P, D).length,
      people: people.size, last, footprint: st.footprint || [],
    };
    X.info[p.id] = I;
    return I;
  }

  const km = m => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : m + ' m');
  const when = iso => { if (!iso) return '—'; const d = new Date(iso), days = (Date.now() - d) / 864e5; return days < 1 ? 'today' : days < 2 ? 'yesterday' : days < 30 ? Math.floor(days) + ' days ago' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); };
  const statsOf = I => [[I.caves, 'caves'], [I.length ? km(I.length) : (I.pending ? '…' : '—'), 'surveyed'], [I.stations || '—', 'stations'],
    [I.deepest ? I.deepest + ' m' : '—', 'deepest'], [I.open, 'open leads'], [I.docs, 'documents'], [I.points, 'points'], [I.people, I.people === 1 ? 'person' : 'people'], [when(I.last), 'last change']];
  function statGrid(I) {
    const g = el('div', 'pjx-stats');
    statsOf(I).forEach(([v, l]) => { const s = el('div', 'pjx-stat'); s.append(el('b', '', String(v)), el('span', '', l)); g.appendChild(s); });
    return g;
  }
  const short = I => [I.caves + ' cave' + (I.caves === 1 ? '' : 's'), I.length ? km(I.length) + ' surveyed' : null, I.open + ' open lead' + (I.open === 1 ? '' : 's')].filter(Boolean).join(' · ');

  // ── Footprints on the map (no project open) ─────────────────────────────
  function ds() {
    const v = V(); if (!v) return null;
    if (!X.ds) { X.ds = new Cesium.CustomDataSource('pj-footprints'); v.dataSources.add(X.ds); }
    return X.ds;
  }
  function descHtml(I) {
    return '<table class="cesium-infoBox-defaultTable"><tbody>' + statsOf(I).map(([v, l]) => `<tr><th>${esc(l)}</th><td>${esc(v)}</td></tr>`).join('') +
      (I.folder ? `<tr><th>folder</th><td>${esc(I.folder)}</td></tr>` : '') + '</tbody></table><p style="opacity:.7">Open it from its card in 📁 Projects.</p>';
  }
  function drawFootprints() {
    const d = ds(); if (!d) return;
    d.entities.removeAll();
    if (pj.pid || !showFootprints()) { d.show = false; return; }
    d.show = true;
    Object.values(X.info).forEach(I => {
      const fp = I.footprint || [];
      if (!fp.length) return;
      const ring = fp.length >= 3 ? fp.concat([fp[0]]) : fp;
      const lon = fp.reduce((s, q) => s + q[0], 0) / fp.length, lat = Math.max(...fp.map(q => q[1]));
      d.entities.add({
        id: 'pjx-fp-' + I.id, name: '📁 ' + I.name, description: descHtml(I),
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        polyline: fp.length >= 2 ? { positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()), width: 2.5, clampToGround: true,
          material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString('#6fd39a'), dashLength: 14 }) } : undefined,
        point: fp.length < 2 ? { pixelSize: 10, color: Cesium.Color.fromCssColorString('#6fd39a'), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND } : undefined,
        label: { text: I.name, font: 'bold 14px sans-serif', fillColor: Cesium.Color.fromCssColorString('#9fe3bd'), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -6),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        properties: { isProjectFootprint: true, projectId: I.id },
      });
    });
    V().scene.requestRender && V().scene.requestRender();
  }
  function select(id, fly) {
    X.sel = id;
    const v = V(), e = X.ds && X.ds.entities.getById('pjx-fp-' + id);
    if (v && e) { v.selectedEntity = e; if (fly) v.flyTo(e, { duration: 1.4 }); }
    A.render();
  }

  // ── The 📁 panel's top ───────────────────────────────────────────────────
  async function loadInfos() {
    const list = (pj.projects || []).filter(p => !X.info[p.id]);       // only the ones not counted yet
    if (!list.length) return;
    X.docs = null;
    for (const p of list) { if (X.busy.has(p.id)) continue; X.busy.add(p.id); try { await info(p); } catch (e) { console.warn('[projects]', p.id, e); } finally { X.busy.delete(p.id); } }
    drawFootprints();
    if (!pj.pid) A.render();
  }
  let loading = null;
  function ensureInfos() {
    if (loading || !(pj.projects || []).some(p => !X.info[p.id])) return;
    loading = loadInfos().finally(() => { loading = null; if (!pj.pid) setTimeout(ensureInfos, 0); });   // any dropped meanwhile
  }
  function switchMenu() {
    const opts = (pj.projects || []).filter(p => p.id !== pj.pid).map(p => ({ label: '📁 ' + (p.name || p.id), sub: X.info[p.id] ? short(X.info[p.id]) : '', value: p.id }));
    opts.push({ label: 'No project', sub: 'close this one: its things are put away, 👤 My data stays', value: '__none' }, { label: '＋ New project…', value: '__new' });
    choose('Switch project', '', opts).then(v => { if (!v) return; if (v === '__new') A.newProject(); else A.setProject(v === '__none' ? null : v); });
  }
  function author(root) {
    const r = el('div', 'pj-row pj-sub');
    r.append(`Entering as: ${A.who() || '(not set)'} `, btn('change', async () => { try { localStorage.removeItem('flex.author'); } catch (_) {} await A.ensureAuthor(); A.render(); }, 'link'));
    root.appendChild(r);
  }
  function top(root, section) {
    if (!pj.pid) {
      section(root, 'Projects', true, b => {
        const bar = el('div', 'pj-row');
        bar.appendChild(btn('＋ New project', () => A.newProject(), 'small primary'));
        bar.appendChild(btn('⇩ From a sync file…', () => A.importSync(), 'small'));
        b.appendChild(bar);
        const list = pj.projects || [];
        if (!list.length) b.appendChild(el('div', 'pj-note', 'No projects yet. A project is an area: its caves, surface points, documents, notes and leads, opened and saved together, shared with friends and FLEX Field by sync files.'));
        const cards = el('div', 'pjx-cards');
        list.forEach(p => {
          const I = X.info[p.id];
          const c = el('div', 'pjx-card' + (X.sel === p.id ? ' on' : ''));
          const h = el('div', 'pjx-card-h');
          h.appendChild(el('b', '', '📁 ' + (p.name || p.id)));
          h.appendChild(btn('Open', () => A.setProject(p.id), 'small primary'));
          c.appendChild(h);
          c.appendChild(el('div', 'pj-sub', I ? short(I) : 'counting…'));
          if (I && I.desc) c.appendChild(el('div', 'pjx-desc', I.desc));
          if (p.folder) c.appendChild(el('div', 'pjx-path', p.folder));
          c.addEventListener('click', e => { if (e.target.closest('button')) return; select(p.id, true); });
          cards.appendChild(c);
        });
        b.appendChild(cards);
        const tog = el('label', 'pj-row pj-sub pjx-tog');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = showFootprints();
        cb.addEventListener('change', () => { try { localStorage.setItem(prefKey, cb.checked ? '1' : '0'); } catch (_) {} drawFootprints(); });
        tog.append(cb, ' Show project footprints on the map');
        b.appendChild(tog);
        author(b);
      });
      ensureInfos();
      return;
    }
    // A project open: the overview.
    section(root, 'Project', true, b => {
      const p = (pj.projects || []).find(x => x.id === pj.pid) || { id: pj.pid, name: pj.P.name };
      const head = el('div', 'pjx-head');
      const t = el('div', 'pjx-title', p.name || pj.P.name || 'Project');
      head.appendChild(t);
      const acts = el('span', 'pjx-acts');
      acts.append(btn('✏️', () => A.renameProject(), 'small'), btn('Switch…', switchMenu, 'small'));
      head.appendChild(acts);
      b.appendChild(head);
      const dr = el('div', 'pj-row pj-sub');
      dr.append(pj.P.desc ? pj.P.desc + ' ' : '', btn(pj.P.desc ? 'edit' : '＋ description', () => A.editDescription(), 'link'));
      b.appendChild(dr);
      if (p.folder) b.appendChild(el('div', 'pjx-path', p.folder));
      const I = X.info[pj.pid];
      if (I) b.appendChild(statGrid(I)); else b.appendChild(el('div', 'pj-sub', 'counting…'));
      if (I) {
        const go = (label, n, fn) => { const r = el('button', 'pjx-kind'); r.type = 'button'; r.append(el('span', '', label), el('span', 'pj-sub', n)); r.addEventListener('click', fn); return r; };
        const rail = sel => () => { const x = document.querySelector('#flex-rail ' + sel); if (x) x.click(); };
        const box = el('div', 'pjx-contents');
        box.appendChild(el('div', 'lp-group-label', 'In this project'));
        box.append(
          go('🕳 Caves', `${I.caves} · ${I.length ? km(I.length) : '—'}`, rail('[data-target="#caveCollapsible"]')),
          go('📍 Surface', `${I.points} point${I.points === 1 ? '' : 's'}, lines, areas · ${I.folders} folder${I.folders === 1 ? '' : 's'}`, rail('[data-target="#featuresCollapsible"]')),
          go('❓ Leads', `${I.open} open · ${I.closed} closed`, rail('[data-rail-pj="Leads"]')),
          go('📄 Documents', String(I.docs), rail('[data-rail-pj="Documents"]')),
          go('🗺 Layers', String(I.layers), () => { const h = [...document.querySelectorAll('#pj-panel .lp-section-header')].find(x => /What this project loads/.test(x.textContent)); if (h) { if (!h.nextElementSibling.classList.contains('open')) h.click(); h.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }));
        if (I.review) box.appendChild(go('✓ To review', String(I.review), rail('[data-rail-pj="Suggestions"]')));
        b.appendChild(box);
      }
      author(b);
    });
    if (!X.info[pj.pid] && !X.busy.has(pj.pid)) {
      const p = (pj.projects || []).find(x => x.id === pj.pid) || { id: pj.pid };
      X.busy.add(pj.pid);
      info(p).catch(e => console.warn('[projects]', e)).finally(() => { X.busy.delete(pj.pid); A.render(); });
    }
  }

  // Clicking a footprint on the map: its card is marked, its numbers show in the details panel.
  const hook = setInterval(() => {
    const v = V(); if (!v || !v.selectedEntityChanged) return;
    clearInterval(hook);
    v.selectedEntityChanged.addEventListener(e => {
      const id = e && e.properties && e.properties.isProjectFootprint ? e.properties.projectId.getValue() : null;
      if (id !== X.sel && (id || X.sel)) { X.sel = id; if (!pj.pid) A.render(); }
    });
    drawFootprints();
  }, 300);
  // Saved changes, a project opened or closed: numbers again; footprints only with no project.
  let lastPid, lastLen = -1;
  setInterval(() => {
    if (pj.pid !== lastPid) {
      lastPid = pj.pid; lastLen = (pj.proj || []).length; drawFootprints(); if (!pj.pid) ensureInfos(); return;
    }
    if (!pj.pid) { ensureInfos(); return; }            // any not counted yet (a load that was skipped while busy)
    const n = (pj.proj || []).length;
    if (pj.pid && n !== lastLen && !X.busy.has(pj.pid)) { lastLen = n; delete X.info[pj.pid]; A.render(); }
  }, 1500);

  const st = document.createElement('style');
  st.textContent = `
  .pjx-cards { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
  .pjx-card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.12); border-radius: 7px; padding: 7px 9px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
  .pjx-card:hover, .pjx-card.on { border-color: #6fd39a; }
  .pjx-card-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pjx-card-h b { color: #6fd39a; font-size: 12.5px; }
  .pjx-desc { font-size: 11px; opacity: .8; }
  .pjx-path { font: 10px ui-monospace, Consolas, monospace; color: rgba(255,255,255,.45); word-break: break-all; }
  .pjx-tog { margin-top: 4px; }
  .pjx-head { display: flex; align-items: center; gap: 8px; }
  .pjx-title { font-size: 17px; font-weight: 700; color: #f2f4f3; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pjx-acts { display: inline-flex; gap: 4px; }
  .pjx-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 8px 0 4px; }
  .pjx-stat { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); border-radius: 6px; padding: 4px 7px; display: flex; flex-direction: column; min-width: 0; }
  .pjx-stat b { font-size: 14px; font-variant-numeric: tabular-nums; color: #f2f4f3; opacity: 1; }
  .pjx-stat span { font-size: 10px; color: rgba(255,255,255,.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pjx-contents { display: flex; flex-direction: column; margin: 4px 0; }
  .pjx-kind { display: flex; justify-content: space-between; gap: 8px; background: none; border: none; color: #e8ece9; padding: 4px 6px; border-radius: 5px; text-align: left; font-size: 12px; cursor: pointer; }
  .pjx-kind:hover { background: rgba(255,255,255,.07); }`;
  document.head.appendChild(st);

  window._pjx = { top, info, hull, drawFootprints, select, ensureInfos };
})();
