// projects-panel.js — the top of 📁 Project.
//
// No project open: Projects, a card per project (its numbers, its folder, an
// Open button), ＋ New, and the projects' footprints on the map (click one,
// or a card, for its numbers in the details panel).
// A project open: name (✏️, Switch…), description, folder path; Unsaved
// changes (Save / Discard) when any wait; the numbers as tiles that open
// where they come from (🕳 Caves, ❓ Leads, 📄 Docs, 📍 Surface, ✓ Review,
// History); Connected: the CalTopo map (Open in CalTopo ↗, the surface
// features it lacks as a KML; matching in caltopo-match.js), terrain and
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
  const prefKey = 'flex.pjx.footprints', archKey = 'flex.pjx.archived';
  const showArchived = () => { try { return localStorage.getItem(archKey) === '1'; } catch (_) { return false; } };
  const isArch = p => (X.info[p.id] ? X.info[p.id].archived : !!p.archived);
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
    // (Not while a snapshot is open: its numbers are those of a past day and must not be kept as the project's.)
    if (changed && !(p.id === pj.pid && pj.at)) { st.at = new Date().toISOString(); api('stats?project=' + encodeURIComponent(p.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) }).catch(() => {}); }
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
      people: people.size, last, footprint: P.footprint ? P.footprint.ring : (st.footprint || []), handDrawn: !!P.footprint,
      archived: !!P.archived, moves: FL.movesOf(P).length,
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
      s.title = { caves: 'Open Caves', leads: 'Open Leads', docs: 'Open Docs', surface: 'Open Surface', history: 'Show the History below', review: 'Open Review' }[to] || '';
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
      if (!fp.length || (I.archived && !showArchived())) return;
      const ring = fp.length >= 3 ? fp.concat([fp[0]]) : fp;
      const lon = fp.reduce((s, q) => s + q[0], 0) / fp.length, lat = Math.max(...fp.map(q => q[1]));
      d.entities.add({
        id: 'pjx-fp-' + I.id, name: I.name, description: descHtml(I),
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        polyline: fp.length >= 2 ? { positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()), width: 2.5, clampToGround: true,
          material: I.handDrawn ? Cesium.Color.fromCssColorString('#6fd39a')              // drawn by hand: a solid line
            : new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString('#6fd39a'), dashLength: 14 }) } : undefined,
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
    const opts = (pj.projects || []).filter(p => p.id !== pj.pid && (!isArch(p) || showArchived())).map(p => ({ label: ['folder', p.name || p.id], sub: X.info[p.id] ? short(X.info[p.id]) : '', value: p.id }));
    opts.push({ label: 'No project', sub: 'close this one: its things are put away, My data stays', value: '__none' }, { label: ['plus', 'New project…'], value: '__new' });
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
        bar.appendChild(btn(['plus', 'New project'], () => A.newProject(), 'small primary'));
        bar.appendChild(btn(['download', 'From a sync file…'], () => A.importSync(), 'small'));
        if (ws() && ws().sets && ws().sets().length) { const cs = btn(['folder', 'From a cave set…'], () => fromCaveSet(), 'small'); cs.title = 'Turn a set of caves in My data into a new project'; bar.appendChild(cs); }
        b.appendChild(bar);
        const everyone = sorted(pj.projects || []), nArch = everyone.filter(isArch).length;
        const list = showArchived() ? everyone : everyone.filter(p => !isArch(p));
        if (!list.length && nArch) b.appendChild(el('div', 'pj-note', `All ${nArch} project${nArch === 1 ? ' is' : 's are'} archived. Show them below.`));
        else if (!list.length) b.appendChild(el('div', 'pj-note', 'No projects yet. A project is an area: its caves, surface points, documents, notes and leads, opened and saved together, shared with friends and FLEX Field by sync files.'));
        // Order (most recent first, or A–Z) and a search over names, descriptions and folders.
        if (list.length > 1) {
          const tools = el('div', 'pjx-tools');
          const q = el('input', 'pj-input pjx-q'); q.type = 'search'; q.placeholder = 'Search projects'; q.value = X.q || '';
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
          h.appendChild(el('b', '', ['folder', p.name || p.id]));
          if (isArch(p)) { c.classList.add('pjx-archived'); h.appendChild(el('span', 'pjx-tag', 'archived')); }
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
        // A switch (ui-kit.js): it takes effect at once.
        const tog = window.uiSwitch(showFootprints(), on => { try { localStorage.setItem(prefKey, on ? '1' : '0'); } catch (_) {} drawFootprints(); },
          'Show project footprints on the map', { className: 'pj-sub pjx-tog' });
        b.appendChild(tog);
        if (nArch) b.appendChild(window.uiSwitch(showArchived(), on => { try { localStorage.setItem(archKey, on ? '1' : '0'); } catch (_) {} drawFootprints(); A.render(); },
          `Show archived projects (${nArch})`, { className: 'pj-sub pjx-tog pjx-arch-tog' }));
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
    const ren = btn(['pencil'], () => A.renameProject(), 'small'); ren.title = 'Rename the project';
    acts.append(ren, btn('Switch…', switchMenu, 'small'));
    head.appendChild(acts);
    pane.appendChild(head);
    const dr = el('div', 'pj-row pj-sub pjx-desc-row');
    dr.append(pj.P.desc ? pj.P.desc + ' ' : '', btn(pj.P.desc ? 'edit' : ['plus', 'description'], () => A.editDescription(), 'link'));
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
    pane.append(block('Connected', live.conn), block('Folder', live.folder), block('Manage', manage(p)));
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
  // A small button that opens a panel: → and the panel's strip icon.
  const goBtn = (to, ico, title) => { const b = btn('', () => go(to), 'small pjx-go'); b.innerHTML = '→ ' + window.icon(ico, '1.15em'); b.title = title || ''; return b; };

  // ── The parts that follow what is loaded (redrawn when they change) ──────
  const ws_ = () => window._ws;
  const mapId = u => (String(u || '').match(/\/m\/([A-Za-z0-9]+)/) || [])[1] || null;
  const VK = 'flex.cl.view';                             // custom-layers.js keeps each map layer's shown / hidden here
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
      when: loaded && tm ? (ok ? 'refreshed ' : 'tried ') + tm : '', interval: lay ? (lay.interval ?? 60) : null, warn: st && /⚠/.test(st.textContent) ? st.textContent : '' };
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
    r.append(btn(['save', 'Save into the project'], async () => { await pw.save(); A.render(); }, 'small primary'), btn('Discard', () => pw.discardAsk(), 'small'));
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
      r.appendChild(rowText(['map', 'CalTopo map ' + (ct.id || '')], ct.loaded ? [ct.n + ' feature' + (ct.n === 1 ? '' : 's'), ct.when, ct.interval ? 'every ' + ct.interval + ' s' : 'manual refresh'].filter(Boolean).join(' · ') : (ct.warn || 'not loaded')));
      const t = el('span', 'pjx-tools');
      if (ct.id) { const a = el('a', 'pjx-ext', 'Open in CalTopo ↗'); a.href = 'https://caltopo.com/m/' + ct.id; a.target = '_blank'; a.rel = 'noopener'; a.title = 'The map on caltopo.com, in a new tab'; t.appendChild(a); }
      if (!ct.loaded) t.appendChild(btn('Load', async () => { await w.setCaltopo(ct.lay.url, ct.interval ?? 60); paintLive(); }, 'small'));
      t.appendChild(goBtn('surface', 'pin', 'Open Surface (the map’s folders, its link and key)'));
      r.appendChild(t);
      box.appendChild(r);
      if (un && nFeat) {
        const r2 = row('pjx-sub pjx-unm');
        r2.appendChild(gap());
        r2.appendChild(rowText(['pin', un.length ? `${un.length} of ${nFeat} surface feature${nFeat === 1 ? '' : 's'} not in CalTopo` : `All ${nFeat} surface feature${nFeat === 1 ? ' is' : 's are'} in CalTopo ✓`],
          un.length ? 'by name and place' : ''));
        r2.title = 'A feature counts as in CalTopo when one there has the same kind and name (any case) and is within 15 m';
        if (un.length) { const t2 = el('span', 'pjx-tools'); t2.appendChild(btn(['download', 'Download them for CalTopo (KML)'], () => downloadUnmatched(un), 'small')); r2.appendChild(t2); }
        box.appendChild(r2);
      }
    } else {
      const r = row('pjx-none');
      r.appendChild(gap());
      r.appendChild(rowText(['map', 'No CalTopo map'], ct && ct.other ? `CalTopo map ${ct.other} is loaded in My data: ← it in Surface to make it this project’s.`
        : 'Add one in Surface → CalTopo map: link and key, or ← a loaded map in Surface’s My data column.'));
      const t = el('span', 'pjx-tools'); t.appendChild(goBtn('surface', 'pin', 'Open Surface')); r.appendChild(t);
      box.appendChild(r);
    }
    // Terrain and hillshade (map layers)
    const icon = { terrain: 'mountain', tiles: 'layers', imagery: 'image' }, kname = { terrain: 'terrain patch', tiles: 'tile layer', imagery: 'map image' };
    if (!maps.length) {
      const r = row('pjx-none'); r.appendChild(gap());
      r.appendChild(rowText(['mountain', 'No terrain or hillshade'], 'Layers → Terrain → Generate terrain + hillshade…, or add a GeoTIFF or a tile link.'));
      const t = el('span', 'pjx-tools'); t.appendChild(goBtn('layers', 'map', 'Open Layers')); r.appendChild(t);
      box.appendChild(r);
    }
    maps.forEach(l => {
      const r = row(); const on = layerShown(l.id);
      r.appendChild(sw(on, v => { setLayerShown(l.id, v); setTimeout(paintLive, 50); }, on ? 'Hide it' : 'Show it'));
      r.appendChild(rowText([icon[l.kind] || 'map', l.name || kname[l.kind]], kname[l.kind]));
      const t = el('span', 'pjx-tools'); t.appendChild(goBtn('layers', 'map', 'Open Layers')); r.appendChild(t);
      box.appendChild(r);
    });
    // Point clouds
    if (!pcs.length) {
      const r = row('pjx-none'); r.appendChild(gap());
      r.appendChild(rowText(['cloud', 'No point clouds'], 'Load one in LiDAR, then the folder button on its row puts it in the project.'));
      const t = el('span', 'pjx-tools'); t.appendChild(goBtn('lidar', 'cloud', 'Open LiDAR')); r.appendChild(t);
      box.appendChild(r);
    }
    pcs.forEach(l => {
      const r = row(), isLoaded = loadedPcs.has(l.url), c = isLoaded ? pcOf(l.url) : null;
      r.appendChild(c ? sw(c.visible !== false, v => { const x = pcOf(l.url); if (x) x.visible = v; if (window._renderPcList) window._renderPcList(); paintLive(); }, 'Show / hide') : gap());
      r.appendChild(rowText(['cloud', l.name || pcName(l.url)], isLoaded ? 'point cloud' : 'point cloud · not loaded'));
      const t = el('span', 'pjx-tools');
      if (!isLoaded) t.appendChild(btn('Load', () => { w.addPointCloud(l.url); setTimeout(paintLive, 500); }, 'small'));
      t.appendChild(goBtn('lidar', 'cloud', 'Open LiDAR')); r.appendChild(t);
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
    if (!sorting) r.appendChild(rowText(['download', 'To sort'], T && !T.busy && !T.folder ? 'This project has no folder of its own yet.' : 'reading the folder…'));
    else if (!sorting.length) r.appendChild(rowText(['download', 'To sort: nothing new'], 'Files dropped in the project’s To sort folder show here until they are filed.'));
    else {
      const t = rowText(['download', `To sort: ${sorting.length} new file${sorting.length === 1 ? '' : 's'}`]);
      const ul = el('div', 'pjx-sort-list');
      sorting.slice(0, 6).forEach(f => ul.appendChild(el('div', '', f.p.replace(/^To sort\//, ''))));
      if (sorting.length > 6) ul.appendChild(el('div', 'pj-sub', `+ ${sorting.length - 6} more`));
      t.appendChild(ul);
      r.appendChild(t);
    }
    const tl = el('span', 'pjx-tools'); tl.appendChild(goBtn('docs', 'doc', 'Open Docs (the folder, the documents)')); r.appendChild(tl);
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
  // A project opened or closed is noticed within 250 ms (it was 1.5 s: the
  // footprints were missing for up to that long after closing a project); the
  // recounting below stays on its 1.5 s beat.
  let lastPid, lastLen = -1, beat = 0;
  setInterval(() => {
    if (pj.pid !== lastPid) {
      // The project just closed may have changed since its last count (a cave
      // added, then closed before the next beat): count it again in the
      // background, or its card and footprint stay as they were. The old
      // numbers show until the new ones are in.
      const prev = lastPid;
      if (prev && X.info[prev] && !X.busy.has(prev)) {
        const p = (pj.projects || []).find(x => x.id === prev) || { id: prev };
        X.busy.add(prev);
        info(p).catch(e => console.warn('[projects]', e)).finally(() => { X.busy.delete(prev); drawFootprints(); if (!pj.pid) A.render(); });
      }
      lastPid = pj.pid; lastLen = (pj.proj || []).length; beat = 0; drawFootprints(); if (!pj.pid) ensureInfos(); return;
    }
    if (++beat < 6) return;
    beat = 0;
    if (!pj.pid) { ensureInfos(); return; }            // any not counted yet (a load that was skipped while busy)
    const n = (pj.proj || []).length;
    if (pj.pid && n !== lastLen && !X.busy.has(pj.pid)) {
      // Counted again in the background: the old numbers stay until the new ones are ready.
      lastLen = n;
      const pid = pj.pid, p = (pj.projects || []).find(x => x.id === pid) || { id: pid };
      X.busy.add(pid);
      info(p).catch(e => console.warn('[projects]', e)).finally(() => { X.busy.delete(pid); if (pj.pid === pid) A.render(); });
    }
  }, 250);

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
  .pjx-tag { font-size: 10px; padding: 0 6px; border-radius: 99px; background: rgba(242,194,78,.2); color: #f2c24e; margin-left: 6px; }
  .pjx-card.pjx-archived { opacity: .7; }
  #pjx-fp-bar { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 9600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; max-width: calc(100vw - 24px);
    padding: 6px 12px; border-radius: 10px; background: rgba(18,22,30,.96); border: 1px solid #6fd39a; color: #e8ece9; font: 12px system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
  #pjx-fp-bar b { color: #6fd39a; } #pjx-fp-bar small { color: rgba(255,255,255,.6); } #pjx-fp-bar .pj-btn { margin: 0; }
  .pjx-flash > .lp-section-header { background: rgba(111,211,154,.25); transition: background .3s; }`;
  document.head.appendChild(st);


  // ── Managing a project: archive, snapshot, own footprint, features back, a record of moves ──
  const dayText = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
  function manage(p) {
    const box = el('div', 'pjx-manage');
    const line = (icon, title, sub, ...btns) => {
      const r = row(); r.appendChild(gap());
      r.appendChild(rowText([icon, title], sub));
      const t = el('span', 'pjx-tools'); btns.forEach(b => b && t.appendChild(b)); r.appendChild(t);
      box.appendChild(r);
    };
    if (pj.mode === 'snapshot') {
      line('history', `Snapshot of ${dayText(window.FlexLib.snapshotTime(pj.at))}`, 'The project as it was that day: nothing can be changed.', btn('Leave the snapshot', () => A.setProject(pj.pid), 'small primary'));
      return box;
    }
    if (P_().archived) {
      line('folder', 'Archived', `since ${dayText(P_().archived.t)}${P_().archived.who ? ' by ' + P_().archived.who : ''} · read-only, hidden from the project list`, btn('Unarchive', () => A.archive(false), 'small primary'));
    } else {
      line('folder', 'Archive this project', 'Hidden from the list and read-only; still openable. Nothing is deleted.', btn('Archive…', () => archiveAsk(p), 'small'));
    }
    line('history', 'Snapshot', 'Open the project as it was on a past day (read-only).', btn('Open a snapshot…', () => snapshotAsk(), 'small'));
    const hd = !!P_().footprint;
    line('polygon', 'Footprint', hd ? `drawn by hand (${P_().footprint.ring.length} corners): it replaces the computed one` : 'computed from the caves, entrances and features',
      btn(hd ? 'Edit' : 'Draw…', () => footprintStart(hd ? 'edit' : 'draw'), 'small'), hd ? btn('Clear', () => footprintClear(), 'small') : null);
    const nf = FL.liveFeatures(P_()).length;
    line('pin', 'Surface features', nf ? `${nf} in the project` : 'none in the project', nf ? btn('Move to My data…', () => featuresAsk(), 'small') : null);
    const mv = FL.movesOf(P_());
    if (mv.length) {
      const r = row('pjx-sub'); r.appendChild(gap());
      const t = el('span', 'pjx-rt'); t.appendChild(el('span', 'pjx-rn', 'Moved caves'));
      mv.slice(0, 6).forEach(m => t.appendChild(el('small', '', m.dir === 'in' ? `“${m.name}” moved in from ${m.peer.name || 'another project'} on ${dayText(m.t)}` : `“${m.name}” moved to ${m.peer.name || 'another project'} on ${dayText(m.t)}`)));
      r.appendChild(t); box.appendChild(r);
    }
    return box;
  }
  const P_ = () => pj.P;
  async function archiveAsk(p) {
    const r = await A.dialog({ title: `Archive “${p.name || pj.P.name || 'this project'}”?`, text: 'It disappears from the project list (a switch shows archived ones) and becomes read-only. Other devices see it too once they have the change. Nothing is deleted, and you can unarchive it any time.',
      buttons: [{ label: 'Cancel', value: null }, { label: 'Archive', value: 'ok', primary: true }] });
    if (r) await A.archive(true);
  }
  async function snapshotAsk() {
    const days = FL.changeDays(pj.proj), today = new Date().toISOString().slice(0, 10);
    const body = el('div', 'pj-form');
    const inp = el('input', 'pj-input'); inp.type = 'date'; inp.max = today; if (days.length) inp.min = days[days.length - 1]; inp.value = days.find(d => d < today) || days[0] || today;
    body.append(el('div', 'pj-f-l', 'Show the project as it was at the end of…'), inp);
    if (days.length > 1) {
      const sel = el('select', 'pjx-sort'); sel.appendChild(new Option('…or a day something changed', ''));
      days.slice(0, 40).forEach(d => sel.appendChild(new Option(dayText(d + 'T12:00:00') + '', d)));
      sel.addEventListener('change', () => { if (sel.value) inp.value = sel.value; });
      body.appendChild(sel);
    }
    const r = await A.dialog({ title: 'Open a snapshot', text: 'Read-only: nothing can be changed until you leave it. Your saved project is not touched.', body,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Open', value: 'ok', primary: true }] });
    if (r && inp.value) await openSnapshot(pj.pid, inp.value);
  }
  /** The project as it was at the end of a day (YYYY-MM-DD) or at an ISO time; read-only until left. */
  function openSnapshot(id, at) { return A.setProject(id, { at }); }
  // Surface features back to My data: pick folders; they move on 💾 Save.
  async function featuresAsk() {
    const PW = window._pjWs; if (!PW) return;
    const groups = FL.liveGroups(pj.P), feats = FL.liveFeatures(pj.P);
    const n = g => feats.filter(f => FL.groupPath(pj.P, f.group).some(x => x.id === g.id)).length;
    const items = groups.filter(g => n(g)).map(g => ({ id: 'g:' + g.id, name: FL.groupPath(pj.P, g.id).map(x => x.name || 'Folder').join(' / '), n: n(g) }));
    const loose = feats.filter(f => !f.group).length;
    if (loose) items.unshift({ id: 'loose', name: 'Not in a folder', n: loose });
    if (!items.length) { toast('No surface features in the project'); return; }
    const body = el('div', 'pj-list pj-taglist');
    const boxes = items.map(it => {
      const lab = el('label', 'pj-check'), cb = el('input', 'keep-box'); cb.type = 'checkbox';
      lab.append(cb, `${it.name} `, el('small', 'pj-sub', `${it.n} feature${it.n === 1 ? '' : 's'}`)); body.appendChild(lab);
      return [cb, it];
    });
    const r = await A.dialog({ title: 'Move surface features to My data', text: 'A folder goes with the folders inside it. They move when you press 💾 Save, and are made in My data first; History can bring them back.', body, wide: true,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Move on Save', value: 'ok', primary: true }] });
    if (!r) return;
    const picked = boxes.filter(([cb]) => cb.checked).map(([, it]) => it);
    if (!picked.length) return;
    const k = await PW.queueFeatures(picked.map(it => ({ id: it.id, name: it.name, n: it.n })));
    toast(k ? `${picked.length} folder${picked.length === 1 ? '' : 's'} will move to My data when you Save` : 'Already waiting for Save');
    A.render();
  }

  // ── A cave set into a project ─────────────────────────────────────────────
  async function fromCaveSet() {
    const w = ws(), PW = window._pjWs;
    if (!w || !PW) return;
    const sets = w.sets();
    if (!sets.length) { toast('No cave sets in My data yet (save loaded caves as a set in 🕳 Caves)'); return; }
    const i = await choose('Turn a cave set into a project', 'The set’s caves move into a new project with their placement and area labels, and leave My data (one home). The set itself is removed.',
      sets.map((st, k) => ({ label: ['folder', st.name], sub: `${st.caves.length} cave${st.caves.length === 1 ? '' : 's'}`, value: k })));
    if (i === null || i === undefined) return;
    const st = sets[i];
    const nm = await A.dialog({ title: 'New project', text: `From the set “${st.name}”.`, input: { value: st.name, placeholder: 'Project name' },
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
    if (!nm || !nm.value.trim()) return;
    return projectFromSet(st, nm.value.trim().slice(0, 60), i);
  }
  /** st: { name, caves: [names] } from ws().sets(); i: its index. → { id, added, skipped }. */
  async function projectFromSet(st, name, i) {
    const w = ws(), PW = window._pjWs;
    if (!(await A.ensureAuthor())) return null;
    const id = FL.uid(10);
    await A.post('projects', { id, name });
    if ((await A.setProject(id)) === false) return null;
    let added = 0; const skipped = [];
    for (const n of st.caves) {
      const rec = w.recents().find(r => r.name === n), loaded = (window._caveImports || []).find(c => c && c.name === n);
      const text = loaded && loaded.parsed && loaded.parsed._rawText ? loaded.parsed._rawText : await w.recentText(n);
      const georef = (loaded && loaded.georef) || (rec && rec.georef) || null;
      if (!text) { skipped.push(n); continue; }
      await PW.addCave({ name: n, text, georef });
      A.refresh('cavefile.set');
      const look = (rec && rec.displayOptions) || (loaded && loaded.displayOptions) || null;
      if (w.caveIndex(n) < 0) await PW.loadProjectCave(n);
      await PW.labels.migrate(n, (look && look.areaLabels) || [], { revive: true });
      w.forgetRecent(n);                                             // one home: out of My data
      added++;
    }
    const oc = window.confirm; window.confirm = () => true;          // (the set's delete asks; the question was asked above)
    try { const k = w.sets().findIndex(x => x.name === st.name); if (k >= 0) w.deleteSet(k); } finally { window.confirm = oc; }
    if (window._pjWs.badge) await window._pjWs.badge();
    toast(`Project “${name}” made from the set: ${added} cave${added === 1 ? '' : 's'}${skipped.length ? ', not readable: ' + skipped.join(', ') : ''}`);
    return { id, added, skipped };
  }

  // ── Your own footprint ─────────────────────────────────────────────────────
  // Drawn on the map: click the corners (Enter or Done to finish, Backspace takes the last back, Esc cancels). Editing:
  // drag a corner, click on the outline to add one, right-click a corner to delete it. Stored in the project
  // (`project.footprint`), so it syncs; it replaces the computed footprint in the list's map layer and the numbers.
  const FP = { on: false, mode: null, ring: [], ds: null, h: null, drag: -1, moved: false, bar: null };
  window._pjxFp = FP;                                     // tests
  function fpPick(pos) {
    const v = V(); if (!v) return null;
    const ray = v.camera.getPickRay(pos);
    let c = ray && v.scene.globe.pick(ray, v.scene);
    if (!c) c = v.camera.pickEllipsoid(pos, v.scene.globe.ellipsoid);
    if (!c) return null;
    const g = Cesium.Cartographic.fromCartesian(c);
    return [+Cesium.Math.toDegrees(g.longitude).toFixed(6), +Cesium.Math.toDegrees(g.latitude).toFixed(6)];
  }
  function fpDraw() {
    const v = V(); if (!v) return;
    if (!FP.ds) { FP.ds = new Cesium.CustomDataSource('pj-fp-edit'); v.dataSources.add(FP.ds); }
    FP.ds.entities.removeAll();
    const r = FP.ring;
    if (r.length >= 2) FP.ds.entities.add({ id: 'fp-line', polyline: { positions: Cesium.Cartesian3.fromDegreesArray((r.length >= 3 ? r.concat([r[0]]) : r).flat()), width: 3, clampToGround: true, material: Cesium.Color.fromCssColorString('#6fd39a') } });
    if (r.length >= 3) FP.ds.entities.add({ id: 'fp-area', polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(r.flat()), material: Cesium.Color.fromCssColorString('#6fd39a').withAlpha(0.15), classificationType: Cesium.ClassificationType.TERRAIN } });
    r.forEach((c, i) => FP.ds.entities.add({ id: 'fpv-' + i, position: Cesium.Cartesian3.fromDegrees(c[0], c[1]),
      point: { pixelSize: 11, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.fromCssColorString('#2f8f5b'), outlineWidth: 3, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
    v.scene.requestRender && v.scene.requestRender();
    if (FP.bar) { const n = FP.bar.querySelector('.pjx-fp-n'); if (n) n.textContent = r.length + ' corner' + (r.length === 1 ? '' : 's'); const d = FP.bar.querySelector('[data-done]'); if (d) d.disabled = r.length < 3; }
  }
  const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0; return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); };
  function fpAdd(c) {
    if (!c) return;
    if (FP.mode === 'edit' && FP.ring.length >= 3) {                 // between the two corners the click is nearest to
      let best = 0, bd = Infinity;
      FP.ring.forEach((a, i) => { const d = segDist(c, a, FP.ring[(i + 1) % FP.ring.length]); if (d < bd) { bd = d; best = i; } });
      FP.ring.splice(best + 1, 0, c);
    } else FP.ring.push(c);
    fpDraw();
  }
  function footprintStart(mode, ring) {
    const v = V(); if (!v || FP.on || pj.readonly) return false;
    FP.on = true; FP.mode = mode; FP.ring = (ring || (mode === 'edit' && pj.P.footprint ? pj.P.footprint.ring : [])).map(c => c.slice(0, 2)); FP.drag = -1;
    const bar = FP.bar = el('div'); bar.id = 'pjx-fp-bar';
    bar.append(el('b', '', mode === 'edit' ? 'Editing the footprint' : 'Drawing the footprint'), el('span', 'pjx-fp-n', ''),
      el('small', '', mode === 'edit' ? 'drag a corner · click the outline to add one · right-click a corner to delete' : 'click the corners of the area'));
    const done = btn('Done', () => footprintFinish(), 'small primary'); done.dataset.done = '1';
    bar.append(btn('Undo last', () => { FP.ring.pop(); fpDraw(); }, 'small'), done, btn('Cancel', () => footprintCancel(), 'small'));
    document.body.appendChild(bar);
    const h = FP.h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    const vertexAt = pos => { const o = v.scene.pick(pos); const id = o && o.id && o.id.id; const m = /^fpv-(\d+)$/.exec(id || ''); return m ? +m[1] : -1; };
    h.setInputAction(e => { const i = vertexAt(e.position); if (i >= 0) { FP.drag = i; FP.moved = false; v.scene.screenSpaceCameraController.enableInputs = false; } }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    h.setInputAction(e => { if (FP.drag < 0) return; const c = fpPick(e.endPosition); if (c) { FP.ring[FP.drag] = c; FP.moved = true; fpDraw(); } }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    h.setInputAction(() => { if (FP.drag >= 0) { v.scene.screenSpaceCameraController.enableInputs = true; setTimeout(() => { FP.drag = -1; }, 0); } }, Cesium.ScreenSpaceEventType.LEFT_UP);
    h.setInputAction(e => { if (FP.drag >= 0 || FP.moved) { FP.moved = false; return; } if (vertexAt(e.position) >= 0) return; fpAdd(fpPick(e.position)); }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction(e => { const i = vertexAt(e.position); if (i >= 0 && FP.ring.length > 3) { FP.ring.splice(i, 1); fpDraw(); } }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    FP.key = e => { if (e.key === 'Enter') { e.preventDefault(); footprintFinish(); } else if (e.key === 'Escape') { e.stopPropagation(); footprintCancel(); } else if (e.key === 'Backspace' && !/input|textarea/i.test((e.target || {}).tagName || '')) { e.preventDefault(); FP.ring.pop(); fpDraw(); } };
    document.addEventListener('keydown', FP.key, true);
    fpDraw();
    return true;
  }
  function fpEnd() {
    const v = V();
    if (FP.h) { FP.h.destroy(); FP.h = null; }
    if (v) v.scene.screenSpaceCameraController.enableInputs = true;
    if (FP.ds) FP.ds.entities.removeAll();
    if (FP.bar) { FP.bar.remove(); FP.bar = null; }
    if (FP.key) document.removeEventListener('keydown', FP.key, true);
    FP.on = false; FP.mode = null; FP.ring = [];
  }
  function footprintCancel() { fpEnd(); }
  async function footprintFinish() {
    if (!FP.on) return false;
    if (FP.ring.length < 3) { toast('A footprint needs at least three corners'); return false; }
    const ring = FP.ring.map(c => c.slice());
    fpEnd();
    return footprintSet(ring);
  }
  /** Store a hand-drawn footprint ([[lon, lat], …], three or more) for the open project, or null to clear it. */
  async function footprintSet(ring) {
    if (!pj.pid) return false;
    if (ring && ring.length < 3) return false;
    const e = await A.record('project.footprint', { ring: ring ? ring.map(c => [+c[0], +c[1]]) : null });
    if (!e) return false;
    const p = (pj.projects || []).find(x => x.id === pj.pid) || { id: pj.pid };
    await info(p).catch(() => {});
    A.render();
    toast(ring ? 'Footprint saved in the project' : 'Back to the computed footprint');
    return true;
  }
  async function footprintClear() {
    const ok = await choose('Clear the footprint you drew?', 'The computed one (around the caves, entrances and features) is used again.', [{ label: 'Clear it', value: 'yes', primary: true }]);
    if (ok === 'yes') await footprintSet(null);
  }
  function forget(id) { delete X.info[id]; if (!pj.pid) ensureInfos(); }

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
  window._pjx = { state: X, forget, manage, openSnapshot, archiveAsk, fromCaveSet, projectFromSet, footprintStart, footprintFinish, footprintCancel, footprintSet, footprintClear, featuresAsk, top, info, hull, drawFootprints, select, ensureInfos, open, flyToProject, footer, go, paintLive, unmatchedKML };
})();
