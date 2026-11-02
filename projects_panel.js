// projects_panel.js — the top of 📁 Project.
//
// No project open: Projects, a card per project (its numbers, its folder, an
// Open button), ＋ New, and the projects' footprints on the map (click one,
// or a card, for its numbers in the details panel).
// A project open: name (✏️, Switch…), description, folder path; Unsaved
// changes (Save / Discard) when any wait; the numbers as tiles that open
// where they come from (🕳 Caves, ❓ Leads, 📄 Docs, 📍 Surface, ✓ Review,
// History); Connected: the CalTopo map (Open in CalTopo ↗, the surface
// features it lacks as a KML; matching in caltopo_match.js), terrain and
// hillshade layers, point clouds, each with a switch and a link to its panel;
// Folder: what waits in To sort. Field survey, Sync files and History follow
// (project.js); "Entering as" at the bottom.
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
      docs: FL.docsOf(D, P).length, photos: FL.docsOf(D, P).filter(d => FL.docMedia(d) === 'photo').length, videos: FL.docsOf(D, P).filter(d => FL.docMedia(d) === 'video').length, points: FL.liveFeatures(P).length, folders: FL.liveGroups(P).length,
      layers: FL.liveLayers(P).length, review: FL.reviewQueue(P, D).length,
      people: people.size, last, footprint: st.footprint || [],
    };
    X.info[p.id] = I;
    return I;
  }

  const km = m => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : m + ' m');
  const when = iso => { if (!iso) return '—'; const d = new Date(iso), days = (Date.now() - d) / 864e5; return days < 1 ? 'today' : days < 2 ? 'yesterday' : days < 30 ? Math.floor(days) + ' days ago' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); };
  // [value, label, where a click goes (the pane's go()), 📄 Docs tab]
  const statsOf = I => [[I.caves, 'caves', 'caves'], [I.length ? km(I.length) : (I.pending ? '…' : '—'), 'surveyed', 'caves'], [I.stations || '—', 'stations', 'caves'],
    [I.deepest ? I.deepest + ' m' : '—', 'deepest', 'caves'], [I.open, 'open leads', 'leads'], [I.docs, 'documents', 'docs', 'all'],
    [I.photos || 0, 'photos', 'docs', 'photos'], [I.videos || 0, 'videos', 'docs', 'videos'], [I.points, 'points', 'surface'],
    [I.people, I.people === 1 ? 'person' : 'people', 'history'], [when(I.last), 'last change', 'history']].concat(I.review ? [[I.review, 'to review', 'review']] : []);
  /** The numbers as tiles; each opens where they come from. */
  function statGrid(I) {
    const g = el('div', 'pjx-stats');
    statsOf(I).forEach(([v, l, to, tab]) => {
      const s = el('button', 'pjx-stat' + (to === 'review' ? ' pjx-stat-rev' : ''));
      s.type = 'button'; s.dataset.go = to; if (tab) s.dataset.tab = tab;
      s.title = { caves: 'Open 🕳 Caves', leads: 'Open ❓ Leads', docs: 'Open 📄 Docs', surface: 'Open 📍 Surface', history: 'Show the History below', review: 'Open ✓ Review' }[to] || '';
      s.append(el('b', '', String(v)), el('span', '', l));
      s.addEventListener('click', () => go(to, tab));
      g.appendChild(s);
    });
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
      (I.folder ? `<tr><th>folder</th><td>${esc(I.folder)}</td></tr>` : '') + '</tbody></table>' +
      // The details panel shows this in a frame of the page (same origin): its button reaches the page.
      `<p><button type="button" data-pid="${esc(I.id)}" onclick="parent._pjx && parent._pjx.open(this.dataset.pid)" ` +
      `style="font:600 13px system-ui,sans-serif;padding:5px 16px;border-radius:6px;border:1px solid #ff9a62;background:#ff9a62;color:#1d1206;cursor:pointer">Open ${esc(I.name)}</button></p>`;
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
    if (v && e) { v.selectedEntity = e; if (fly) v.flyTo(e, { duration: 2.5, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-50), 0) }); }
    A.render();
  }

  // ── The 📁 panel's top ───────────────────────────────────────────────────
  async function loadInfos() {
    const list = (pj.projects || []).filter(p => !X.info[p.id]);       // only the ones not counted yet
    if (!list.length) return;
    X.docs = null;
    let n = 0;
    for (const p of list) { if (X.busy.has(p.id)) continue; X.busy.add(p.id); try { await info(p); n++; } catch (e) { console.warn('[projects]', p.id, e); } finally { X.busy.delete(p.id); } }
    if (!n) return;                                    // all being counted elsewhere: they redraw when done
    drawFootprints();
    if (!pj.pid) A.render();
  }
  let loading = null;
  function ensureInfos() {
    if (loading || !(pj.projects || []).some(p => !X.info[p.id] && !X.busy.has(p.id))) return;
    loading = true;                                    // before the call: its first part runs now and may draw
    loading = loadInfos().finally(() => { loading = null; if (!pj.pid) setTimeout(ensureInfos, 0); });   // any dropped meanwhile
  }
  function switchMenu() {
    const opts = (pj.projects || []).filter(p => p.id !== pj.pid).map(p => ({ label: '📁 ' + (p.name || p.id), sub: X.info[p.id] ? short(X.info[p.id]) : '', value: p.id }));
    opts.push({ label: 'No project', sub: 'close this one: its things are put away, 👤 My data stays', value: '__none' }, { label: '＋ New project…', value: '__new' });
    choose('Switch project', '', opts).then(v => { if (!v) return; if (v === '__new') A.newProject(); else A.setProject(v === '__none' ? null : v); });
  }
  function author(root) {
    const r = el('div', 'pj-row pj-sub pjx-author');
    r.append(`Entering as: ${A.who() || '(not set)'} `, btn('change', async () => { try { localStorage.removeItem('flex.author'); } catch (_) {} await A.ensureAuthor(); A.render(); }, 'link'));
    root.appendChild(r);
  }
  // ── Order of the list ────────────────────────────────────────────────────
  // Most recent: opened on this computer or changed (anyone, any device),
  // whichever is later; projects never opened or counted yet go last, A–Z.
  const opened = () => { try { return JSON.parse(localStorage.getItem('flex.pjx.opened') || '{}'); } catch (_) { return {}; } };
  function markOpened(id) { if (!id) return; const o = opened(); o[id] = new Date().toISOString(); try { localStorage.setItem('flex.pjx.opened', JSON.stringify(o)); } catch (_) {} }
  const sortMode = () => { try { return localStorage.getItem('flex.pjx.sort') === 'name' ? 'name' : 'recent'; } catch (_) { return 'recent'; } };
  const recency = p => { const a = opened()[p.id] || '', I = X.info[p.id], b = (I && I.last) || ''; return a > b ? a : b; };
  const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true, sensitivity: 'base' });
  function sorted(list) {
    const l = list.slice();
    if (sortMode() === 'name') return l.sort(byName);
    return l.sort((a, b) => { const ra = recency(a), rb = recency(b); return ra === rb ? byName(a, b) : ra > rb ? -1 : 1; });
  }
  let openedPid = null;
  setInterval(() => { if (pj.pid !== openedPid) { openedPid = pj.pid; markOpened(pj.pid); } }, 1000);
  function top(root, section) {
    if (!pj.pid) {
      section(root, 'Projects', true, b => {
        const bar = el('div', 'pj-row');
        bar.appendChild(btn('＋ New project', () => A.newProject(), 'small primary'));
        bar.appendChild(btn('⇩ From a sync file…', () => A.importSync(), 'small'));
        b.appendChild(bar);
        const list = sorted(pj.projects || []);
        if (!list.length) b.appendChild(el('div', 'pj-note', 'No projects yet. A project is an area: its caves, surface points, documents, notes and leads, opened and saved together, shared with friends and FLEX Field by sync files.'));
        // Order (most recent first, or A–Z) and a search over names, descriptions and folders.
        if (list.length > 1) {
          const tools = el('div', 'pjx-tools');
          const q = el('input', 'pj-input pjx-q'); q.type = 'search'; q.placeholder = '🔍 Search projects'; q.value = X.q || '';
          q.addEventListener('input', () => { X.q = q.value; filter(); });
          q.addEventListener('focus', () => { X.qFocus = true; });
          q.addEventListener('blur', () => { setTimeout(() => { if (q.isConnected) X.qFocus = false; }, 0); });   // not when a redraw replaced it
          q.addEventListener('keydown', e => { if (e.key === 'Escape' && q.value) { e.stopPropagation(); q.value = X.q = ''; filter(); } if (e.key === 'Enter') { const one = [...b.querySelectorAll('.pjx-card')].filter(c => c.style.display !== 'none'); if (one.length === 1) open(one[0].dataset.id); } });
          const sel = el('select', 'pjx-sort'); sel.title = 'Order';
          [['recent', 'Most recent'], ['name', 'A–Z']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; sel.appendChild(o); });
          sel.value = sortMode();
          sel.addEventListener('change', () => { try { localStorage.setItem('flex.pjx.sort', sel.value); } catch (_) {} A.render(); });
          tools.append(q, sel);
          b.appendChild(tools);
          if (X.qFocus) setTimeout(() => { q.focus(); const n = q.value.length; try { q.setSelectionRange(n, n); } catch (_) {} }, 0);
        }
        const none = el('div', 'pj-note pjx-none', 'No project matches.'); none.style.display = 'none';
        const cards = el('div', 'pjx-cards');
        const filter = () => {
          const t = (X.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
          let n = 0;
          cards.querySelectorAll('.pjx-card').forEach(c => { const hit = t.every(w => c.dataset.k.includes(w)); c.style.display = hit ? '' : 'none'; if (hit) n++; });
          none.style.display = n || !list.length ? 'none' : '';
        };
        list.forEach(p => {
          const I = X.info[p.id];
          const c = el('div', 'pjx-card' + (X.sel === p.id ? ' on' : ''));
          c.dataset.id = p.id;
          c.dataset.k = [p.name, p.id, I && I.desc, p.folder].filter(Boolean).join(' ').toLowerCase();
          const h = el('div', 'pjx-card-h');
          h.appendChild(el('b', '', '📁 ' + (p.name || p.id)));
          h.appendChild(btn('Open', () => open(p.id), 'small primary'));
          c.appendChild(h);
          c.appendChild(el('div', 'pj-sub', I ? short(I) : 'counting…'));
          if (I && I.desc) c.appendChild(el('div', 'pjx-desc', I.desc));
          if (p.folder) c.appendChild(el('div', 'pjx-path', p.folder));
          if (sortMode() === 'recent' && recency(p)) c.appendChild(el('div', 'pjx-when', (opened()[p.id] && opened()[p.id] >= ((I && I.last) || '') ? 'opened ' : 'changed ') + when(recency(p))));
          c.addEventListener('click', e => { if (e.target.closest('button')) return; select(p.id, true); });
          cards.appendChild(c);
        });
        b.append(none, cards);
        filter();
        // A switch (ui_kit.js): it takes effect at once.
        const tog = window.uiSwitch(showFootprints(), on => { try { localStorage.setItem(prefKey, on ? '1' : '0'); } catch (_) {} drawFootprints(); },
          'Show project footprints on the map', { className: 'pj-sub pjx-tog' });
        b.appendChild(tog);
        author(b);
      });
      ensureInfos();
      return;
    }
    // A project open: header, unsaved changes, numbers, what is connected,
    // the folder. Field survey, Sync files and History follow (project.js).
    const p = (pj.projects || []).find(x => x.id === pj.pid) || { id: pj.pid, name: pj.P.name };
    const pane = el('div', 'pjx-pane');
    const head = el('div', 'pjx-head');
    head.appendChild(el('div', 'pjx-title', p.name || pj.P.name || 'Project'));
    const acts = el('span', 'pjx-acts');
    const ren = btn('✏️', () => A.renameProject(), 'small'); ren.title = 'Rename the project';
    acts.append(ren, btn('Switch…', switchMenu, 'small'));
    head.appendChild(acts);
    pane.appendChild(head);
    const dr = el('div', 'pj-row pj-sub pjx-desc-row');
    dr.append(pj.P.desc ? pj.P.desc + ' ' : '', btn(pj.P.desc ? 'edit' : '＋ description', () => A.editDescription(), 'link'));
    pane.appendChild(dr);
    if (p.folder) {
      const fr = el('div', 'pjx-pathrow');
      const path = el('span', 'pjx-path', p.folder); path.title = p.folder;
      const cp = btn('⧉', () => copy(p.folder, 'Folder path copied'), 'small pjx-copy'); cp.title = 'Copy the folder path';
      fr.append(path, cp);
      pane.appendChild(fr);
    }
    const live = { unsaved: el('div', 'pjx-live'), conn: el('div', 'pjx-live'), folder: el('div', 'pjx-live'), sig: {} };
    pane.appendChild(live.unsaved);
    const I = X.info[pj.pid];
    pane.appendChild(I ? statGrid(I) : el('div', 'pj-sub', 'counting…'));
    pane.append(block('Connected', live.conn), block('Folder', live.folder));
    root.appendChild(pane);
    X.live = live;
    paintLive();
    if (!X.info[pj.pid] && !X.busy.has(pj.pid)) {
      X.busy.add(pj.pid);
      info(p).catch(e => console.warn('[projects]', e)).finally(() => { X.busy.delete(p.id); A.render(); });
    }
  }
  function block(title, body) { const b = el('div', 'pjx-block'); b.append(el('div', 'pjx-block-t', title), body); return b; }
  function copy(text, msg) {
    const done = () => A.toast(msg);
    try { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(done, () => A.dialog({ title: 'Copy', input: { value: text } })); } catch (_) { A.dialog({ title: 'Copy', input: { value: text } }); }
  }
  /** The bottom of the pane: who is entering changes. */
  function footer(root) { if (pj.pid) author(root); }

  // ── Where a number or a row leads ────────────────────────────────────────
  const PANEL = { caves: '#caveCollapsible', leads: '#leadsCollapsible', docs: '#docsCollapsible', surface: '#featuresCollapsible', review: '#reviewCollapsible', layers: '#mapLayersCollapsible', lidar: '#lidarCollapsible' };
  function go(to, tab) {
    if (to === 'history') {
      const h = document.getElementById('pj-history'); if (!h) return;
      const hd = h.querySelector('.lp-section-header'), bd = h.querySelector('.lp-section-body');
      if (bd && !bd.classList.contains('open')) hd.click();
      h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      h.classList.add('pjx-flash'); setTimeout(() => h.classList.remove('pjx-flash'), 900);
      return;
    }
    if (tab) pj.docTab = tab;                            // 📄 Docs: the matching tab
    const sel = PANEL[to]; if (!sel) return;
    if (window._rail) window._rail.open(sel);
    else { const b = document.querySelector(`#flex-rail [data-target="${sel}"]`); if (b) b.click(); }
    if (tab) setTimeout(() => A.render(), 0);
  }
  const goBtn = (to, label, title) => { const b = btn(label, () => go(to), 'small pjx-go'); b.title = title || ''; return b; };

  // ── The parts that follow what is loaded (redrawn when they change) ──────
  const ws_ = () => window._ws;
  const mapId = u => (String(u || '').match(/\/m\/([A-Za-z0-9]+)/) || [])[1] || null;
  const VK = 'flex.cl.view';                             // custom_layers.js keeps each map layer's shown / hidden here
  const layerShown = id => { try { const v = JSON.parse(localStorage.getItem(VK) || '{}')[id]; return !v || v.show !== false; } catch (_) { return true; } };
  function setLayerShown(id, on) {
    try { const all = JSON.parse(localStorage.getItem(VK) || '{}'); all[id] = Object.assign({ show: true, alpha: 1 }, all[id] || {}, { show: !!on }); localStorage.setItem(VK, JSON.stringify(all)); } catch (_) {}
    const CL = window._customLayers;
    if (CL) { CL.sync().then(() => CL.render(true)); }
  }
  const pcName = url => url.replace(/\/ept\.json.*$/i, '').split('/').filter(Boolean).pop() || url;
  const pcOf = url => ((window.potreeViewer && potreeViewer.scene && potreeViewer.scene.pointclouds) || []).find(c => c.name === pcName(url));
  function ctState() {
    const w = ws_(); if (!w || !pj.P) return null;
    const lay = FL.liveLayers(pj.P).find(l => l.kind === 'caltopo') || null;
    const now = w.caltopo(), src = w.vectorSources().find(s => s.kind === 'caltopo') || null;
    const loaded = !!(lay && now && src && now.url === lay.url);
    const st = document.getElementById('caltopo_status'), tm = st && (st.textContent.match(/\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?/i) || [])[0];
    const ok = st && /✓/.test(st.textContent);
    return { lay, now, src: loaded ? src : null, loaded, id: lay && mapId(lay.url), other: !lay && now ? mapId(now.url) || 'a map' : null,
      n: loaded && window._ctMatch ? window._ctMatch.countShapes(src) : 0, shown: loaded ? src.ds.show !== false : false,
      when: loaded && tm ? (ok ? 'refreshed ' : 'tried ') + tm : '', interval: lay ? (lay.interval ?? 30) : null, warn: st && /⚠/.test(st.textContent) ? st.textContent : '' };
  }
  function row(cls) { return el('div', 'pjx-row' + (cls ? ' ' + cls : '')); }
  function rowText(main, sub) { const t = el('span', 'pjx-rt'); t.appendChild(el('span', 'pjx-rn', main)); if (sub) t.appendChild(el('small', '', sub)); return t; }
  function sw(on, fn, title) { const x = window.uiSwitch(on, fn, null, { small: true }); x.title = title || ''; return x; }
  const gap = () => el('span', 'pjx-sw-gap');

  function paintUnsaved(box) {
    const W = window._pjWsState || {}, pw = window._pjWs, pend = (W.pending || []);
    const sig = pend.map(x => x.name + '|' + x.what).join(';');
    if (X.live.sig.unsaved === sig) return;
    X.live.sig.unsaved = sig;
    box.textContent = '';
    if (!pend.length || !pw) return;
    const u = el('div', 'pjx-unsaved');
    u.appendChild(el('div', 'pjx-u-t', `Unsaved changes · ${pend.length}`));
    // Grouped by what: “moved (2): Ridge, Upper”.
    const by = new Map(); pend.forEach(x => { const k = x.what || 'changed'; if (!by.has(k)) by.set(k, []); by.get(k).push(x.name); });
    const ul = el('div', 'pjx-u-list');
    by.forEach((names, what) => ul.appendChild(el('div', 'pjx-u-i', `${what}${names.length > 1 ? ' (' + names.length + ')' : ''}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' +' + (names.length - 5) : ''}`)));
    u.appendChild(ul);
    const r = el('div', 'pj-row');
    r.append(btn('💾 Save into the project', async () => { await pw.save(); A.render(); }, 'small primary'), btn('Discard', () => pw.discardAsk(), 'small'));
    u.appendChild(r);
    box.appendChild(u);
  }
  function paintConn(box) {
    const w = ws_(); if (!w) return;
    const ct = ctState();
    const un = ct && ct.loaded && window._ctMatch ? window._ctMatch.unmatched(pj.P, ct.src) : null;
    const nFeat = FL.liveFeatures(pj.P).length;
    const lays = FL.liveLayers(pj.P);
    const maps = lays.filter(l => l.kind === 'terrain' || l.kind === 'tiles' || l.kind === 'imagery');
    const pcs = lays.filter(l => l.kind === 'pointcloud'), loadedPcs = new Set(w.pointClouds());
    const sig = JSON.stringify([ct && [ct.id, ct.loaded, ct.n, ct.shown, ct.when, ct.other, ct.warn, ct.interval], un && un.map(f => f.id), nFeat,
      maps.map(l => [l.id, l.name, layerShown(l.id)]), pcs.map(l => { const c = pcOf(l.url); return [l.id, loadedPcs.has(l.url), c ? c.visible !== false : null]; })]);
    if (X.live.sig.conn === sig) return;
    X.live.sig.conn = sig;
    box.textContent = '';
    // CalTopo map
    if (ct && ct.lay) {
      const r = row('pjx-ct');
      r.appendChild(ct.loaded ? sw(ct.shown, on => { const s = ctState(); if (s && s.src) { s.src.ds.show = on; if (window.cesiumViewer) cesiumViewer.scene.requestRender(); } paintLive(); }, ct.shown ? 'Hide the CalTopo map' : 'Show the CalTopo map') : gap());
      r.appendChild(rowText('🗺 CalTopo map ' + (ct.id || ''), ct.loaded ? [ct.n + ' feature' + (ct.n === 1 ? '' : 's'), ct.when, ct.interval ? 'every ' + ct.interval + ' s' : 'manual refresh'].filter(Boolean).join(' · ') : (ct.warn || 'not loaded')));
      const t = el('span', 'pjx-tools');
      if (ct.id) { const a = el('a', 'pjx-ext', 'Open in CalTopo ↗'); a.href = 'https://caltopo.com/m/' + ct.id; a.target = '_blank'; a.rel = 'noopener'; a.title = 'The map on caltopo.com, in a new tab'; t.appendChild(a); }
      if (!ct.loaded) t.appendChild(btn('Load', async () => { await w.setCaltopo(ct.lay.url, ct.interval ?? 30); paintLive(); }, 'small'));
      t.appendChild(goBtn('surface', '→ 📍', 'Open 📍 Surface (the map’s folders, its link and key)'));
      r.appendChild(t);
      box.appendChild(r);
      if (un && nFeat) {
        const r2 = row('pjx-sub pjx-unm');
        r2.appendChild(gap());
        r2.appendChild(rowText(un.length ? `📍 ${un.length} of ${nFeat} surface feature${nFeat === 1 ? '' : 's'} not in CalTopo` : `📍 All ${nFeat} surface feature${nFeat === 1 ? ' is' : 's are'} in CalTopo ✓`,
          un.length ? 'by name and place' : ''));
        r2.title = 'A feature counts as in CalTopo when one there has the same kind and name (any case) and is within 15 m';
        if (un.length) { const t2 = el('span', 'pjx-tools'); t2.appendChild(btn('⇩ Download them for CalTopo (KML)', () => downloadUnmatched(un), 'small')); r2.appendChild(t2); }
        box.appendChild(r2);
      }
    } else {
      const r = row('pjx-none');
      r.appendChild(gap());
      r.appendChild(rowText('🗺 No CalTopo map', ct && ct.other ? `CalTopo map ${ct.other} is loaded in 👤 My data: ← it in 📍 Surface to make it this project’s.`
        : 'Add one in 📍 Surface → CalTopo map: link and key, or ← a loaded map in Surface’s My data column.'));
      const t = el('span', 'pjx-tools'); t.appendChild(goBtn('surface', '→ 📍', 'Open 📍 Surface')); r.appendChild(t);
      box.appendChild(r);
    }
    // Terrain and hillshade (map layers)
    const icon = { terrain: '⛰', tiles: '🧩', imagery: '🖼' }, kname = { terrain: 'terrain patch', tiles: 'tile layer', imagery: 'map image' };
    if (!maps.length) {
      const r = row('pjx-none'); r.appendChild(gap());
      r.appendChild(rowText('⛰ No terrain or hillshade', '🗺 Layers → Terrain → ⛰ Generate terrain + hillshade…, or add a GeoTIFF or a tile link.'));
      const t = el('span', 'pjx-tools'); t.appendChild(goBtn('layers', '→ 🗺', 'Open 🗺 Layers')); r.appendChild(t);
      box.appendChild(r);
    }
    maps.forEach(l => {
      const r = row(); const on = layerShown(l.id);
      r.appendChild(sw(on, v => { setLayerShown(l.id, v); setTimeout(paintLive, 50); }, on ? 'Hide it' : 'Show it'));
      r.appendChild(rowText(`${icon[l.kind] || '•'} ${l.name || kname[l.kind]}`, kname[l.kind]));
      const t = el('span', 'pjx-tools'); t.appendChild(goBtn('layers', '→ 🗺', 'Open 🗺 Layers')); r.appendChild(t);
      box.appendChild(r);
    });
    // Point clouds
    if (!pcs.length) {
      const r = row('pjx-none'); r.appendChild(gap());
      r.appendChild(rowText('☁ No point clouds', 'Load one in ☁ LiDAR, then 📁 on its row puts it in the project.'));
      const t = el('span', 'pjx-tools'); t.appendChild(goBtn('lidar', '→ ☁', 'Open ☁ LiDAR')); r.appendChild(t);
      box.appendChild(r);
    }
    pcs.forEach(l => {
      const r = row(), isLoaded = loadedPcs.has(l.url), c = isLoaded ? pcOf(l.url) : null;
      r.appendChild(c ? sw(c.visible !== false, v => { const x = pcOf(l.url); if (x) x.visible = v; if (window._renderPcList) window._renderPcList(); paintLive(); }, 'Show / hide') : gap());
      r.appendChild(rowText('☁ ' + (l.name || pcName(l.url)), isLoaded ? 'point cloud' : 'point cloud · not loaded'));
      const t = el('span', 'pjx-tools');
      if (!isLoaded) t.appendChild(btn('Load', () => { w.addPointCloud(l.url); setTimeout(paintLive, 500); }, 'small'));
      t.appendChild(goBtn('lidar', '→ ☁', 'Open ☁ LiDAR')); r.appendChild(t);
      box.appendChild(r);
    });
  }
  /** The project's features CalTopo doesn't have, as a KML with their folders (for CalTopo's Import). */
  function unmatchedKML(list) {
    const groups = {};
    list.forEach(f => { let g = f.group; while (g && pj.P.groups[g] && !groups[g]) { groups[g] = pj.P.groups[g]; g = pj.P.groups[g].parent; } });
    const S = { features: Object.fromEntries(list.map(f => [f.id, f])), groups };
    return FL.featuresKML(S, '', (pj.P.name || 'FLEX') + ' — not in CalTopo');
  }
  function downloadUnmatched(list) {
    const text = unmatchedKML(list);
    X.lastKml = { n: list.length, text };                // tests
    const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/vnd.google-earth.kml+xml' }));
    a.download = ((pj.P.name || 'project') + ' not in CalTopo').replace(/[^\w.-]+/g, '-') + '.kml';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    A.toast(`${list.length} feature${list.length === 1 ? '' : 's'} as KML: in CalTopo, Import… it into the map`);
  }
  // The project folder's To sort/ (what came in and wasn't filed yet).
  async function loadTree() {
    const pid = pj.pid; if (!pid) return;
    const T = X.tree;
    if (T && T.busy) return;
    if (T && T.pid === pid && Date.now() - T.at < 30000) return;
    X.tree = { pid, at: Date.now(), busy: true, folder: T && T.pid === pid ? T.folder : null, files: T && T.pid === pid ? T.files : null };
    try { const r = await fetch('/api/lib/tree?project=' + encodeURIComponent(pid)); const o = r.ok ? await r.json() : {}; if (pj.pid === pid) Object.assign(X.tree, { folder: o.folder || null, files: o.files || [] }); }
    catch (e) { console.warn('[projects] tree', e); }
    finally { if (X.tree) { X.tree.busy = false; X.tree.at = Date.now(); } }
    paintLive();
  }
  function paintFolder(box) {
    const T = X.tree && X.tree.pid === pj.pid ? X.tree : null;
    if (!T || !T.files) loadTree();
    const sorting = T && T.files ? T.files.filter(f => /^To sort\//.test(f.p)) : null;
    const sig = JSON.stringify([!!T, T && T.folder, sorting && sorting.map(f => f.p)]);
    if (X.live.sig.folder === sig) return;
    X.live.sig.folder = sig;
    box.textContent = '';
    const r = row('pjx-tosort');
    r.appendChild(gap());
    if (!sorting) r.appendChild(rowText('📥 To sort', T && !T.busy && !T.folder ? 'This project has no folder of its own yet.' : 'reading the folder…'));
    else if (!sorting.length) r.appendChild(rowText('📥 To sort: nothing new', 'Files dropped in the project’s To sort folder show here until they are filed.'));
    else {
      const t = rowText(`📥 To sort: ${sorting.length} new file${sorting.length === 1 ? '' : 's'}`);
      const ul = el('div', 'pjx-sort-list');
      sorting.slice(0, 6).forEach(f => ul.appendChild(el('div', '', f.p.replace(/^To sort\//, ''))));
      if (sorting.length > 6) ul.appendChild(el('div', 'pj-sub', `+ ${sorting.length - 6} more`));
      t.appendChild(ul);
      r.appendChild(t);
    }
    const tl = el('span', 'pjx-tools'); tl.appendChild(goBtn('docs', '→ 📄', 'Open 📄 Docs (the folder, the documents)')); r.appendChild(tl);
    box.appendChild(r);
  }
  /** Redraw the live parts that changed (cheap when nothing did). */
  function paintLive() {
    const L = X.live;
    if (!L || !pj.pid || !L.conn.isConnected) return;
    try { paintUnsaved(L.unsaved); } catch (e) { console.warn('[projects] unsaved', e); }
    try { paintConn(L.conn); } catch (e) { console.warn('[projects] connected', e); }
    try { paintFolder(L.folder); } catch (e) { console.warn('[projects] folder', e); }
  }
  setInterval(() => { const c = document.getElementById('projectCollapsible'); if (pj.pid && (!c || c.classList.contains('show'))) { paintLive(); if (X.tree && Date.now() - X.tree.at > 30000) loadTree(); } }, 2000);

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
    if (pj.pid && n !== lastLen && !X.busy.has(pj.pid)) {
      // Counted again in the background: the old numbers stay until the new ones are ready.
      lastLen = n;
      const pid = pj.pid, p = (pj.projects || []).find(x => x.id === pid) || { id: pid };
      X.busy.add(pid);
      info(p).catch(e => console.warn('[projects]', e)).finally(() => { X.busy.delete(pid); if (pj.pid === pid) A.render(); });
    }
  }, 1500);

  const st = document.createElement('style');
  st.textContent = `
  .pjx-tools { display: flex; gap: 5px; align-items: center; margin: 6px 0 2px; }
  .pjx-tools .pjx-q { flex: 1; min-width: 0; margin: 0; }
  .pjx-sort { background: #1a1a2e; color: #e8ece9; border: 1px solid rgba(255,255,255,.2); border-radius: 4px; font-size: 11px; padding: 2px 4px; }
  .pjx-when { font-size: 10px; color: rgba(255,255,255,.4); }
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
  .pjx-pane .pjx-stats { grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .pjx-pane .pjx-stat { padding: 3px 6px; }
  .pjx-pane .pjx-stat b { font-size: 13px; }
  .pjx-stat { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); border-radius: 6px; padding: 4px 7px; display: flex; flex-direction: column; min-width: 0; text-align: left; font: inherit; color: inherit; }
  button.pjx-stat { cursor: pointer; } button.pjx-stat:hover { border-color: #6fd39a; background: rgba(111,211,154,.08); }
  .pjx-stat-rev { border-color: rgba(242,194,78,.5); }
  .pjx-stat b { font-size: 14px; font-variant-numeric: tabular-nums; color: #f2f4f3; opacity: 1; }
  .pjx-stat span { font-size: 10px; color: rgba(255,255,255,.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pjx-pane { padding: 2px 2px 6px; }
  .pjx-desc-row { margin: 2px 0; }
  .pjx-pathrow { display: flex; align-items: center; gap: 4px; }
  .pjx-pathrow .pjx-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; word-break: normal; line-height: 1.6; }
  .pjx-copy { padding: 0 5px !important; margin: 0 !important; }
  .pjx-unsaved { margin: 8px 0 4px; padding: 6px 8px; border: 1px solid #f2c24e; border-radius: 7px; background: rgba(242,194,78,.08); }
  .pjx-u-t { font-weight: 700; color: #f2c24e; font-size: 12px; }
  .pjx-u-i { font-size: 11px; color: rgba(255,255,255,.75); padding: 1px 0; overflow-wrap: anywhere; }
  .pjx-unsaved .pj-row { margin: 4px 0 0; }
  .pjx-block { margin-top: 8px; }
  .pjx-block-t { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.45); padding: 0 2px 3px; border-bottom: 1px solid rgba(255,255,255,.08); margin-bottom: 2px; }
  .pjx-row { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 6px; padding: 3px 2px; border-radius: 5px; font-size: 12px; }
  .pjx-row:hover { background: rgba(255,255,255,.04); }
  .pjx-row.pjx-sub { padding-top: 0; }
  .pjx-sw-gap { display: inline-block; width: 24px; }
  .pjx-rt { min-width: 0; display: flex; flex-direction: column; }
  .pjx-rn { color: #e8ece9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pjx-none .pjx-rn { color: rgba(255,255,255,.55); }
  .pjx-rt small { font-size: 10.5px; color: rgba(255,255,255,.45); overflow-wrap: anywhere; line-height: 1.3; }
  .pjx-tools { display: inline-flex; align-items: center; gap: 2px; flex-wrap: wrap; justify-content: flex-end; }
  .pjx-tools .pj-btn { margin: 0; }
  .pjx-go { background: none !important; border-color: transparent !important; color: #8ab4ec !important; padding: 1px 4px !important; }
  .pjx-go:hover { border-color: rgba(138,180,236,.5) !important; }
  .pjx-ext { color: #ff9a62; font-size: 11px; text-decoration: none; white-space: nowrap; padding: 0 3px; }
  .pjx-ext:hover { text-decoration: underline; }
  .pjx-sort-list { font-size: 11px; color: #f2c24e; margin-top: 2px; } .pjx-sort-list div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pjx-author { margin-top: 10px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,.08); font-size: 10.5px; }
  .pjx-flash > .lp-section-header { background: rgba(111,211,154,.25); transition: background .3s; }`;
  document.head.appendChild(st);

  /** Fly smoothly over a project's area (its footprint); false if it has none yet. */
  function flyToProject(id) {
    const v = V(), I = X.info[id], fp = I && I.footprint;
    if (!v || !fp || !fp.length) return false;
    const pts = fp.map(q => Cesium.Cartesian3.fromDegrees(q[0], q[1]));
    const bs = Cesium.BoundingSphere.fromPoints(pts);
    bs.radius = Math.max(bs.radius, 150);
    v.camera.flyToBoundingSphere(bs, { duration: 3, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-50), bs.radius * 2.6), easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT });
    return true;
  }
  /** Open a project (its card's Open, or the Open in its popup on the map). */
  function open(id) { const v = V(); if (v) v.selectedEntity = undefined; return A.setProject(id); }
  window._pjx = { top, info, hull, drawFootprints, select, ensureInfos, open, flyToProject, footer, go, paintLive, unmatchedKML };
})();
