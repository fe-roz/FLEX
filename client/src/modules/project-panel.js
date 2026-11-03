// FLEX project (the Project panel, new / rename project, leads CSV).
// Part of project.js, split into classic scripts that load in order (index.html);
// they share their functions through window._pjParts until project.js has loaded.
// Behaviour unchanged. See client/src/README.md.
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js
  const { el, $, esc, pj, review, choose, setProject, btn, who, ensureAuthor, importSync, FL, archive, history, acceptAbove, allLeads, targetLabel, caveName, leadSummary, flyTo, editLead, addPages, docEl, makeSync, describe, when, dialog, post, api, record } = X;

  // ── The panel ──────────────────────────────────────────────────────────────
  function section(parent, title, open, build) {
    const s = el('div', 'lp-section');
    const h = el('div', 'lp-section-header');
    h.innerHTML = `<span class="lp-section-arrow">${open ? '▾' : '▸'}</span> ${esc(title)}`;
    const b = el('div', 'lp-section-body' + (open ? ' open' : ''));
    const key = 'flex.pj.' + title.split(' ')[0];
    h.addEventListener('click', () => { const o = !b.classList.contains('open'); b.classList.toggle('open', o); h.querySelector('.lp-section-arrow').textContent = o ? '▾' : '▸'; try { localStorage.setItem(key, o ? '1' : '0'); } catch (_) {} });
    try { const v = localStorage.getItem(key); if (v != null) { const o = v === '1'; b.classList.toggle('open', o); h.querySelector('.lp-section-arrow').textContent = o ? '▾' : '▸'; } } catch (_) {}
    s.append(h, b); parent.appendChild(s);
    build(b);
    return s;
  }
  /** Docs sorted by trip: off unless switched on (remembered on this computer). */
  function groupByTrip() { try { return localStorage.getItem('flex.docsGroupByTrip') === '1'; } catch (_) { return false; } }
  function render() {
    const root = $('pj-panel');
    if (!root) return;
    root.textContent = '';
    // 📄 Docs, ❓ Leads, ✓ Review have panels of their own (strip icons); the
    // 📁 panel keeps the rest. Without them (older page), all in one.
    const docsRoot = $('pj-docs-panel') || root, leadsRoot = $('pj-leads-panel') || root, revRoot = $('pj-review-panel') || root;
    [docsRoot, leadsRoot, revRoot].forEach(r => { if (r && r !== root) r.textContent = ''; });
    // The Projects list / the open project's overview (projects-panel.js).
    if (window._pjx) window._pjx.top(root, section);
    else section(root, 'Project', true, b => {
      const row = el('div', 'pj-row');
      const sel = el('select', 'pj-input');
      sel.appendChild(new Option('— choose a project —', ''));
      pj.projects.forEach(p => sel.appendChild(new Option(p.name || p.id, p.id, false, p.id === pj.pid)));
      sel.addEventListener('change', () => setProject(sel.value));
      row.appendChild(sel);
      row.appendChild(btn(['plus', 'New'], newProject, 'small'));
      if (pj.pid) row.appendChild(Object.assign(btn(['pencil'], renameProject, 'small'), { title: 'Rename the project' }));
      b.appendChild(row);
      if (pj.pid) {
        const dr = el('div', 'pj-row pj-sub');
        dr.append(pj.P.desc ? pj.P.desc + ' ' : '', btn(pj.P.desc ? 'edit' : ['plus', 'description'], editDescription, 'link'));
        b.appendChild(dr);
      }
      const r2 = el('div', 'pj-row pj-sub');
      r2.append(`Entering as: ${who() || '(not set)'} `, btn('change', async () => { try { localStorage.removeItem('flex.author'); } catch (_) {} await ensureAuthor(); render(); }, 'link'));
      b.appendChild(r2);
      if (!pj.pid) b.appendChild(el('div', 'pj-note', 'A project is an area: its caves (survey files and where they are placed), point clouds, CalTopo map, documents, notes, leads and field survey — opened together, saved together, shared with friends and FLEX Field by sync files. Without one, FLEX works as usual.'));
    });
    if (!pj.pid) { if (!window._pjx) section(root, 'Sync files', true, b => b.appendChild(btn(['download', 'Import a sync file…'], () => importSync()))); return; }
    const q = FL.reviewQueue(pj.P, pj.D);
    section(revRoot, `Suggestions (${q.length})`, true, b => {
      if (!q.length) { b.appendChild(el('div', 'pj-note', 'Nothing waiting. Suggestions come from the archive processor or a helper, in sync files; they change nothing until accepted.')); return; }
      b.appendChild(el('div', 'pj-note', `${q.length} suggestion(s) waiting — from ${[...new Set(q.map(p => p.by))].join(', ')}. They change nothing until accepted.`));
      const by = {};
      q.forEach(p => { const k = p.op === 'lead.set' ? 'Leads' : p.op === 'note.set' ? 'Notes' : /^doc\./.test(p.op) ? 'Document links' : p.op === 'survey.version' ? 'Missing surveys' : 'Other'; by[k] = (by[k] || 0) + 1; });
      const kinds = el('div', 'pj-sub');
      kinds.textContent = Object.entries(by).map(([k, n]) => `${k} ${n}`).join(' · ');
      b.appendChild(kinds);
      const sure = q.filter(p => (p.confidence || 0) >= 0.8);
      const row = el('div', 'pj-row');
      row.appendChild(btn('Review…', () => (window._pjSeg ? window._pjSeg.review() : review()), 'primary'));
      if (sure.length) row.appendChild(btn(`Accept all ≥ 80% (${sure.length})`, async () => {
        const ok = await choose(`Accept ${sure.length} suggestion${sure.length > 1 ? 's' : ''} at 80% or more?`, 'Each is logged under your name; the history can undo any of them.', [{ label: 'Accept them', value: 'yes', primary: true }, { label: 'Not now', value: 'no' }]);
        if (ok === 'yes') await acceptAbove(0.8);
      }, 'small'));
      b.appendChild(row);
    });
    if (window._pjSeg) window._pjSeg.section(revRoot, section);
    section(leadsRoot, 'Leads', true, b => {
      const all = allLeads();
      const tabs = el('div', 'pj-tabs');
      [['active', `Active (${all.filter(x => x.active).length})`], ['closed', `Closed (${all.filter(x => !x.active).length})`], ['all', `All (${all.length})`]].forEach(([k, l]) => {
        tabs.appendChild(btn(l, () => { pj.leadShow = k; render(); }, pj.leadShow === k ? 'on' : ''));
      });
      b.appendChild(tabs);
      const shown = all.filter(x => pj.leadShow === 'all' || (pj.leadShow === 'active') === x.active)
        .sort((a, b2) => (Number(a.fields.priority) || 9) - (Number(b2.fields.priority) || 9));
      if (!shown.length) b.appendChild(el('div', 'pj-note', 'None.'));
      shown.slice(0, 200).forEach(x => {
        const t = FL.parseTarget(x.target);
        const r = el('div', 'pj-item' + (x.active ? '' : ' closed'));
        r.appendChild(el('div', 'pj-item-t', t.kind === 'feature' ? targetLabel(x.target) : `${t.name || '?'} · ${caveName(t.cave)}`));
        r.appendChild(el('div', 'pj-sub', leadSummary(x.fields) + (x.fields.desc ? ' — ' + x.fields.desc : '')));
        r.addEventListener('click', () => {
          if (t.kind !== 'feature') return flyTo(t.cave, t.name);
          const f = pj.P.features[t.feature];
          if (f && window._pjf) window._pjf.highlight({ kind: f.kind, coords: f.coords }, true);
          if (x.rec) editLead(null, targetLabel(x.target), x);
        });
        b.appendChild(r);
      });
      b.appendChild(btn(['download', 'CSV'], leadsCsv, 'small'));
    });
    if (window._pjDocs && docsRoot !== root) window._pjDocs.tree(docsRoot, section);
    section(docsRoot, 'Documents', true, b => {
      const all = FL.docsOf(pj.D, pj.P);
      const inbox = all.filter(d => FL.docInbox(d, pj.P));
      // Photos and videos apart from the papers (both are media).
      const photos = all.filter(d => FL.docMedia(d) === 'photo'), videos = all.filter(d => FL.docMedia(d) === 'video');
      const tabs = el('div', 'pj-tabs');
      [['inbox', `Inbox (${inbox.length})`], ['all', `All (${all.length})`], ['photos', ['image', `Photos (${photos.length})`]], ['videos', ['video', `Videos (${videos.length})`]]]
        .forEach(([k, l]) => tabs.appendChild(btn(l, () => { pj.docTab = k; render(); }, pj.docTab === k ? 'on' : '')));
      b.appendChild(tabs);
      const gl = el('label', 'pj-row pj-sub'), gcb = el('input');
      gcb.type = 'checkbox'; gcb.checked = groupByTrip(); gcb.dataset.f = 'groupByTrip';
      gcb.addEventListener('change', () => { try { localStorage.setItem('flex.docsGroupByTrip', gcb.checked ? '1' : '0'); } catch (_) {} render(); });
      gl.append(gcb, ' Group by trip');
      gl.title = 'Put the documents of one trip together (trips come from survey dates; correct one with Trip… in a document\'s ⋯ menu)';
      b.appendChild(gl);
      const add = btn(['plus', 'Add files (photos, scans, TIFF, PDF)…'], () => addPages({}), 'primary');
      b.appendChild(add);
      const drop = el('div', 'pj-drop', 'or drop files here');
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('on'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('on'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('on'); addPages({ files: Array.from(e.dataTransfer.files || []) }); });
      b.appendChild(drop);
      const byDate = l => l.slice().sort((x, y) => (FL.dateKey(y.date) || '').localeCompare(FL.dateKey(x.date) || ''));
      const list = pj.docTab === 'inbox' ? inbox : pj.docTab === 'photos' ? byDate(photos) : pj.docTab === 'videos' ? byDate(videos) : byDate(all);
      if (!list.length) b.appendChild(el('div', 'pj-note', pj.docTab === 'inbox' ? 'Inbox empty: every document is tagged to a cave, survey, station, surface point or lead.'
        : pj.docTab === 'photos' ? 'No photos yet.' : pj.docTab === 'videos' ? 'No videos yet.' : 'No documents yet.'));
      if (groupByTrip() && FL.tripGroups && window._pjTrips) {
        const G = FL.tripGroups(pj.P, pj.D), rows = new Map(), none = [];
        list.slice(0, 300).forEach(d => { const g = G.by.get('doc:' + d.id); if (g) (rows.get(g) || rows.set(g, []).get(g)).push(d); else none.push(d); });
        const head = (t, n) => { const h = el('div', 'pj-h', t + ` (${n})`); h.dataset.tripHead = '1'; b.appendChild(h); };
        [...rows.keys()].sort((x, y) => String(y.start).localeCompare(String(x.start))).forEach(g => {
          head([window._pjTrips.range(g), g.name].filter(Boolean).join(' · '), rows.get(g).length);
          rows.get(g).forEach(d => b.appendChild(docEl(d)));
        });
        if (none.length) { head('Not in a trip', none.length); none.forEach(d => b.appendChild(docEl(d))); }
      } else list.slice(0, 300).forEach(d => b.appendChild(docEl(d)));
    });
    section(root, 'Field survey', false, b => {
      const svs = pj.P.order.map(id => pj.P.surveys[id]).filter(Boolean);
      if (!svs.length) b.appendChild(el('div', 'pj-note', 'Shots taken in FLEX Field arrive with sync files and are drawn here (orange), view only. Into survey data: Compass DAT export (later).'));
      svs.forEach(sv => {
        const inf = (pj.fieldInfo || {})[sv.id];
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', `${sv.name} · ${caveName(sv.cave)}`));
        r.appendChild(el('div', 'pj-sub', `${sv.shots.length} shot(s)${sv.date ? ' · ' + sv.date : ''}${sv.team ? ' · ' + sv.team : ''}` +
          (inf ? ` · decl ${inf.decl.v.toFixed(2)}° (${inf.decl.src})${inf.loose ? ` · ${inf.loose} not tied in` : ''}${inf.closures.length ? ' · closure ' + inf.closures.map(x => x.err.toFixed(2) + ' m').join(', ') : ''}` : ' · tie-in station not loaded')));
        if (sv.tie) r.addEventListener('click', () => flyTo(sv.cave, sv.tie));
        b.appendChild(r);
      });
    });
    section(root, 'Sync files', false, b => {
      b.appendChild(el('div', 'pj-note', 'Share changes with FLEX Field and teammates: make a file, send it (email, cloud, cable); they import it. The first file has everything.'));
      const r = el('div', 'pj-row');
      r.append(btn(['upload', 'Make: changes since last'], () => makeSync('since'), 'primary small'), btn(['upload', 'Everything'], () => makeSync('all'), 'small'), btn(['download', 'Import…'], () => importSync(), 'small'));
      b.appendChild(r);
    });
    // History: the last 5 changes right under its header; the rest (with undo) in its window.
    const hs = section(root, 'History', true, b => {
      const all = FL.sortEntries(pj.proj), list = all.slice(-5).reverse();
      if (!list.length) b.appendChild(el('div', 'pj-note', 'No changes yet.'));
      list.forEach(e => { const r = el('div', 'pj-item pj-hist'); r.appendChild(el('div', 'pj-item-t', describe(e))); r.appendChild(el('div', 'pj-sub', `${e.who || '?'} · ${when(e.t)}`)); r.addEventListener('click', () => history(null)); b.appendChild(r); });
      b.appendChild(btn(all.length > 5 ? `All history (${all.length})…` : 'All history…', () => history(null), 'small'));
    });
    hs.id = 'pj-history';
    if (window._pjx && window._pjx.footer) window._pjx.footer(root);
  }
  async function newProject() {
    const r = await dialog({ title: 'New project', text: 'Usually the name of the area.', input: { value: '', placeholder: 'Project name' },
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
    if (!r || !r.value.trim()) return;
    const id = FL.uid(10), name = r.value.trim().slice(0, 60);
    const dr = await dialog({ title: `“${name}”: description`, text: 'Optional: what the project is about, who works on it.', input: { value: '', placeholder: 'Description (optional)' },
      buttons: [{ label: 'Skip', value: 'skip' }, { label: 'Save', value: 'ok', primary: true }] });
    const descText = dr && dr.button === 'ok' ? String(dr.value || '').trim().slice(0, 500) : '';
    const w = window._ws, loaded = w ? w.caves().length + w.pointClouds().length + (w.caltopo() ? 1 : 0) + w.dataFiles().length : 0;
    let keep = false;
    if (loaded && window._pjWs) {
      const c = await choose(`New project “${name}”`, `${loaded} thing(s) are loaded now (caves, point clouds, CalTopo, files).`, [
        { label: 'Start it with what is loaded now', sub: 'they become the project’s', value: 'keep', primary: true },
        { label: 'Start it empty', sub: 'what is loaded now stays loaded; add things later (← in Caves and Surface, the folder button in LiDAR)', value: 'empty' }]);
      if (!c) return;
      keep = c === 'keep';
    }
    await post('projects', { id, name });
    pj.projects = await api('projects');
    await setProject(id, { keep });
    await record('project.set', descText ? { name, desc: descText } : { name });
    if (window._pjWs) window._pjWs.label();
  }
  async function editDescription() {
    const r = await dialog({ title: 'Project description', text: 'What the project is about, who works on it. Empty removes it.', input: { value: pj.P.desc || '', placeholder: 'Description' },
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    const v = String(r.value || '').trim().slice(0, 500);
    if (v !== (pj.P.desc || '')) { await record('project.set', { desc: v }); render(); }
  }
  async function renameProject() {
    const r = await dialog({ title: 'Project name', input: { value: pj.P.name || '' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r || !r.value.trim() || r.value.trim() === pj.P.name) return;
    await post('projects', { id: pj.pid, name: r.value.trim().slice(0, 60) });
    pj.projects = await api('projects');
    await record('project.set', { name: r.value.trim().slice(0, 60) });
  }
  function leadsCsv() {
    const cols = ['cave', 'station'].concat(FL.LEAD_FIELDS.map(f => f.k), ['confidence', 'source', 'updated_by', 'updated']);
    const q = v => { const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = allLeads().map(x => { const t = FL.parseTarget(x.target); return [caveName(t.cave), t.name].concat(FL.LEAD_FIELDS.map(f => x.fields[f.k]),
      [x.fields.confidence, x.rec ? x.rec.source || '' : 'export', x.rec ? x.rec.updated.who : '', x.rec ? x.rec.updated.t : '']).map(q).join(','); });
    const a = el('a'); a.href = URL.createObjectURL(new Blob([cols.join(',') + '\n' + rows.join('\n') + '\n'], { type: 'text/csv' }));
    a.download = `leads-${(pj.P.name || 'project').replace(/[^A-Za-z0-9]+/g, '-')}.csv`; document.body.appendChild(a); a.click(); a.remove();
  }


  Object.assign(X, {
    render, newProject, editDescription, renameProject,
  });
})();
