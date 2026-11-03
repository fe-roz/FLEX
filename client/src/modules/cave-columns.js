// cave-columns.js — 🕳 Caves as two columns: the open project's caves on the
// left, 👤 My data's on the right (the old Imported / Recent lists).
//
// Each row: a box that loads it (or shows / hides it once loaded), its name,
// ⌖ fly to, ⋯ for the rest (Rectify, Style, Labels, Replace survey file,
// Export survey…, Unload, Forget), and ← / → to move it across, or drag it. Moves wait for
// 💾 Save like every project change (project-workspace.js); until then the
// row shows where it is going, with a dot. Cave sets show as folders in My
// data. With no project open, the left column invites to open or start one.
//
// window._caveCols.reveal(key, { open }) → true when the row is shown: opens
// the pane first with open: true, scrolls the cave's row into view and
// flashes it (class row-flash, 1.8 s; a cave set holding it opens). The rows
// are survey files, so a survey or a station reveals its file's row. key:
//   '<survey file name>'  'file:<survey file name>'   (selection.js's key for a cave not in the project)
//   'cave:<project cave id>'                          (its first survey file)
//   'survey:<file>|<survey code>'  'station:<file>|<station name>'
//   { source: 'cave', cave: <project cave id>, file, survey, station }   (the info panel's form; file wins)
//   { caveIndex: i }                                  (window._caveImports[i])
(function () {
  'use strict';
  const host = document.getElementById('cave-cols');
  if (!host) return;
  const ws = () => window._ws, PW = () => window._pjWs, PJ = () => window._pj || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const openSets = new Set();
  let waiting = new Map();                           // name → what (from the Save count)
  let last = '';

  function rows() {
    const w = ws(), pj = PJ(), pw = PW();
    if (!w) return null;
    const loaded = new Map(w.caves().map(c => [c.name, c]));
    const project = [], mine = [];
    const open = !!(pj.pid && pj.P && pw);
    const moves = open ? (window._pjWsState.moves || []) : [];
    const movingTo = name => (moves.find(m => m.kind === 'cave' && m.name === name) || {}).dir || null;
    if (open) {
      Object.values(pj.P.cavefiles || {}).filter(f => !f.removed).forEach(f => {
        const dir = movingTo(f.file);
        (dir === 'out' ? mine : project).push({ name: f.file, place: f.place, inProject: true, dir, loaded: loaded.has(f.file) });
      });
    }
    const taken = new Set(project.map(x => x.name).concat(mine.map(x => x.name)));
    w.recents().forEach(r => {
      if (taken.has(r.name)) return;
      taken.add(r.name);
      const dir = movingTo(r.name);
      (dir === 'in' ? project : mine).push({ name: r.name, place: r.georef, inProject: false, dir, loaded: loaded.has(r.name), lastUsed: r.lastUsed });
    });
    // Loaded but in neither list (just imported, not placed in My data yet).
    loaded.forEach((c, name) => { if (taken.has(name)) return; const dir = movingTo(name); (dir === 'in' ? project : mine).push({ name, place: c.georef, inProject: false, dir, loaded: true }); });
    project.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { open, project, mine };
  }

  function placeText(g) {
    if (!g) return 'not placed';
    return g.mode === 'anchor' ? 'at station ' + (g.station || '?') : g.mode === 'utm' ? 'UTM ' + (g.zone || '?') + (g.south ? 'S' : 'N') : '';
  }
  function item(x, side, open) {
    const w = ws(), vis = x.loaded && w.caveVisible(x.name);
    const cm = (((window._pjWsState || {}).moves) || []).find(m => m.kind === 'cavemove' && (m.files || []).includes(x.name));
    const what = x.dir ? (x.dir === 'in' ? 'moving into the project' : 'moving to My data') : cm ? 'moving to ' + (cm.toName || 'another project') : waiting.get(x.name) || '';
    const arrow = !open ? '' : side === 'p'
      ? `<button type="button" class="cc-mv" data-mv="out" title="${x.dir === 'in' ? 'Back to My data (cancel the move)' : 'Move to My data'}">→</button>`
      : `<button type="button" class="cc-mv" data-mv="in" title="${x.dir === 'out' ? 'Back into the project (cancel the move)' : 'Move into the project'}">←</button>`;
    return `<div class="cc-it${x.dir || cm ? ' cc-moving' : ''}" data-name="${esc(x.name)}" draggable="${open ? 'true' : 'false'}">
      <button type="button" class="cc-eye ui-eye${vis ? ' on' : x.loaded ? ' half' : ''}" data-eye title="${!x.loaded ? 'Load' : vis ? 'Hide' : 'Show'}" aria-label="${!x.loaded ? 'Load' : vis ? 'Hide' : 'Show'} ${esc(x.name)}"></button>
      <span class="cc-nm" title="${esc(x.name)} — double-click to fly there">${esc(x.name.replace(/\.(plt|json)$/i, ''))}${what ? '<b class="cc-dot" title="' + esc(what) + ' — 💾 Save puts it in">•</b>' : ''}<small>${esc(what || (x.loaded ? '' : placeText(x.place)))}</small></span>
      <span class="cc-tools"><button type="button" data-more title="More">⋯</button>${arrow}</span>
    </div>`;
  }

  // ── Multi-cave files and systems (doc 14, rule 3) ─────────────────────────
  // Under a multi-cave file's row: its caves, then "Surface / not yet sorted". After the files: the systems.
  const openSys = new Set();
  const ic = n => (window.icon ? window.icon(n, 13) : '');
  function subRows(x) {
    const pj = PJ(), P = pj.P, MC = window._pjMulti;
    const cf = P && P.cavefiles && P.cavefiles[x.name];
    if (!x.inProject || !cf || !cf.multi || !MC) return '';
    const imp = (window._caveImports || []).find(i => i && i.parsed && i.name === x.name);
    const FL = window.FlexLib;
    const codes = imp ? MC.codesOf(imp).map(c => c.code) : null;
    let g;
    if (codes && FL) g = FL.fileGroups(P, x.name, codes);
    else g = { caves: FL.liveCaves(P).filter(c => (c.sources || []).some(s => s.file === x.name)).map(c => ({ id: c.id, name: c.name, surveys: ((c.sources.find(s => s.file === x.name) || {}).surveys) || [] })), surface: cf.surface || [], unsorted: null };
    const n = (a, w) => a.length + ' ' + w + (a.length === 1 ? '' : 's');
    return `<div class="cc-sub">${g.caves.map(c => `<div class="cc-sr" data-cave="${esc(c.id)}" data-file="${esc(x.name)}" title="Rename it, put it in a system">${ic('cave')} ${esc(c.name)} <small>${n(c.surveys, 'survey')}</small></div>`).join('')}` +
      (g.unsorted && g.unsorted.length ? `<div class="cc-sr cc-un" data-sort="${esc(x.name)}" title="These surveys belong to no cave yet — click to sort them">Surface / not yet sorted <small>${n(g.unsorted, 'survey')}</small></div>` : '') +
      (g.surface.length ? `<div class="cc-sr cc-un" data-sort="${esc(x.name)}" title="Marked as surface traverses">Surface traverses <small>${n(g.surface, 'survey')}</small></div>` : '') + '</div>';
  }
  function systemsHtml() {
    const pj = PJ(), P = pj.P, FL = window.FlexLib, MC = window._pjMulti;
    if (!P || !FL || !MC) return '';
    const sys = FL.liveSystems(P);
    return `<div class="cc-systems"><div class="cc-sys-h">Systems<span class="cc-tools"><button type="button" data-sysnew title="A system groups caves; their survey files stay separate">＋ New</button></span></div>` +
      sys.map(g => `<div class="cc-sys" data-sys="${esc(g.id)}"><button type="button" class="cc-set-h" data-sysopen="${esc(g.id)}" title="${esc(MC.systemLine(g))}"><span>${openSys.has(g.id) ? '▾' : '▸'}</span> ${ic('folder')} ${esc(g.name)} <small>${esc(MC.systemLine(g))}</small></button>` +
        `<span class="cc-tools"><button type="button" data-sysedit="${esc(g.id)}" title="Rename, change its caves, delete">⋯</button></span>` +
        (openSys.has(g.id) ? `<div class="cc-set-kids">${g.caves.map(c => `<div class="cc-sk" data-skcave="${esc(c)}" title="Show its row">${ic('cave')} ${esc((P.caves[c] || {}).name)}</div>`).join('') || '<div>No caves in it yet</div>'}</div>` : '') + '</div>').join('') +
      (sys.length ? '' : '<div class="cc-empty">None yet.</div>') + '</div>';
  }

  function render() {
    if (!host.isConnected) return;
    const R = rows();
    if (!R) return;
    try { waiting = new Map(((window._pjWsState && window._pjWsState.pending) || []).filter(p => p.kind === 'cave').map(p => [p.name, p.what])); } catch (_) { waiting = new Map(); }
    const pjName = R.open ? (PW().projName ? PW().projName() : 'Project') : 'No project';
    const left = !R.open
      ? `<div class="cc-col cc-p cc-invite"><span class="cc-note">No project open.</span>
           <button type="button" class="cc-btn" data-openpj>📁 Open a project…</button>
           <span class="cc-note">Your 👤 My data stays as it is.</span></div>`
      : `<div class="cc-col cc-p" data-col="p">${R.project.map(x => item(x, 'p', true) + subRows(x)).join('') || '<span class="cc-empty">No caves yet: drag one here from My data, or ← it.</span>'}${systemsHtml()}</div>`;
    const sets = ws().sets();
    const setsHtml = sets.length ? `<div class="cc-sets">${sets.map((st, i) => `<div class="cc-set">
        <button type="button" class="cc-set-h" data-set="${i}" title="${esc(st.caves.join(', '))}"><span>${openSets.has(st.name) ? '▾' : '▸'}</span> 📁 ${esc(st.name)} <small>${st.caves.length}</small></button>
        <span class="cc-tools"><button type="button" data-setload="${i}" title="Load every cave in the set">Load</button><button type="button" data-setdel="${i}" title="Delete the set (its caves stay in My data)">✕</button></span>
        ${openSets.has(st.name) ? `<div class="cc-set-kids">${st.caves.map(n => `<div>${esc(n)}</div>`).join('')}</div>` : ''}</div>`).join('')}</div>` : '';
    const right = `<div class="cc-col cc-m" data-col="m">${R.mine.map(x => item(x, 'm', R.open)).join('') || '<span class="cc-empty">Nothing here: caves you import or load outside a project are kept here.</span>'}${setsHtml}</div>`;
    const nLoaded = ws().caves().length;
    const html = `<div class="cc-bar"><button type="button" class="cc-btn" data-allstyle ${nLoaded ? '' : 'disabled'} title="One style for every loaded cave">🎨 All caves ▾</button>` +
      `<span class="cc-hint">double-click a cave to fly there</span></div><div class="cc-head"><span class="cc-hp" title="${esc(pjName)}">📁 ${esc(pjName)}</span><span class="cc-hm">👤 My data</span></div>
      <div class="cc-cols">${left}${right}</div>`;
    if (html === last) return;                       // unchanged: keep hover, focus and drags alive
    last = html;
    const scroll = host.querySelector('.cc-cols') ? host.querySelector('.cc-cols').scrollTop : 0;
    host.innerHTML = html;
    host.querySelector('.cc-cols').scrollTop = scroll;
    if (FLASH && Date.now() < FLASH.until) { const r = rowOf(FLASH.name); if (r) r.classList.add('row-flash'); } else FLASH = null;
  }

  // ── Reveal ───────────────────────────────────────────────────────────────
  let FLASH = null;                                  // { name, until }: survives a re-render
  const rowOf = name => [...host.querySelectorAll('.cc-it[data-name]')].find(r => r.dataset.name === name) || null;
  function fileOf(key) {
    const pj = PJ(), P = pj.P;
    const ofCave = cid => { const c = P && P.caves && P.caves[cid]; return c && !c.removed && (c.sources || [])[0] ? c.sources[0].file : null; };
    if (key == null) return null;
    if (typeof key === 'object') {
      if (key.file) return String(key.file);
      if (key.cave) return ofCave(key.cave);
      if (key.caveIndex != null) { const imp = (window._caveImports || [])[key.caveIndex]; return imp ? imp.name : null; }
      return null;
    }
    key = String(key);
    let m;
    if ((m = key.match(/^(?:survey|station):(.*)\|[^|]*$/))) return m[1];
    if ((m = key.match(/^file:(.*)$/))) return m[1];
    if ((m = key.match(/^cave:(.*)$/))) return ofCave(m[1]);
    return key;
  }
  async function reveal(key, opts) {
    opts = opts || {};
    const pane = document.getElementById('caveCollapsible');
    if (opts.open && pane && !pane.classList.contains('show')) {
      if (window._rail && window._rail.open) window._rail.open('#caveCollapsible');
      else { const b = document.querySelector('#flex-rail [data-target="#caveCollapsible"]'); if (b) b.click(); }
      for (let i = 0; i < 20 && !pane.classList.contains('show'); i++) await new Promise(r => setTimeout(r, 50));
    }
    const name = fileOf(key);
    if (!name) return false;
    last = ''; render();
    let row = rowOf(name);
    if (!row) {                                      // in a cave set only: open the set
      const sets = ws() ? ws().sets() : [], i = sets.findIndex(x => x.caves.includes(name));
      if (i >= 0) { openSets.add(sets[i].name); last = ''; render(); const h = host.querySelector(`[data-set="${i}"]`); row = h ? h.closest('.cc-set') : null; }
    }
    if (!row) return false;
    host.querySelectorAll('.row-flash').forEach(r => r.classList.remove('row-flash'));
    FLASH = { name, until: Date.now() + 1800 };
    void row.offsetWidth; row.classList.add('row-flash');
    try { row.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    setTimeout(() => { const r = rowOf(name); if (r) r.classList.remove('row-flash'); }, 1850);
    return !!(pane && pane.classList.contains('show'));
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  async function load(name) {
    const pw = PW(), w = ws();
    if (pw && pw.owns(name) && !pw.moving(name, 'in')) return pw.loadProjectCave(name);
    return w.recentCave(name);
  }
  async function move(name, dir) {
    const pw = PW();
    if (!pw || !PJ().pid) return;
    await pw.moveCave(name, dir);
    render();
  }
  function more(name, anchor) {
    const w = ws(), i = w.caveIndex(name), pw = PW();
    const inP = !!(pw && pw.owns(name)), loaded = i >= 0;
    const acts = [];
    if (!loaded) acts.push(['Load', () => load(name)]);
    if (loaded) {
      acts.push(['⌖ Fly to', () => window._flyToCave(i)], ['🎯 Rectify', () => window._openRectifyPanel(i)], ['🎨 Style', () => window._openStylePanel(i)],
                ['🏷 Labels', () => window._openLabelsPanel(i)], ['⟳ Replace survey file…', () => window._replaceCaveSurvey(i)], ['Unload', () => w.removeCave(name)]);
    }
    acts.push(['⇩ Export survey…', () => exportSurvey(name), inP ? 'Survex, CSV and PLT files into the cave’s Survey folder in the project' : 'Survex, CSV and PLT files, downloaded']);
    acts.push(['Add sketch…', () => window._sketches && window._sketches.addForFile(name), 'A scan of a sketch (image or PDF), kept in the project with this cave']);
    if (pw && pw.caveMenu) acts.push(...pw.caveMenu(name, loaded));   // project: Copy CalTopo tag, Caves in this file…, Remove from project
    if (!inP) acts.push(['Forget', () => { if (loaded) w.removeCave(name); w.forgetRecent(name); }, 'Takes it out of My data (its file and history stay)']);
    const m = document.createElement('div'); m.className = 'cc-pop';
    m.innerHTML = `<div class="cc-pop-t">${esc(name)}</div>` + acts.map(([l, , t], k) => `<button type="button" data-k="${k}" ${t ? 'title="' + esc(t) + '"' : ''}>${esc(l)}</button>`).join('');
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.right + 6, window.innerWidth - 200) + 'px';
    m.style.top = Math.max(8, Math.min(r.top - 6, window.innerHeight - m.offsetHeight - 10)) + 'px';
    const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true), 0);
    m.addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; m.remove(); document.removeEventListener('mousedown', off, true); acts[+b.dataset.k][1](); setTimeout(render, 50); });
  }
  // ── ⇩ Export survey… (survey-export.js) ─────────────────────────────────
  // A cave in the open project: written into <project folder>/Caves/<cave>/Survey/
  // (POST /api/lib/survey-export). Otherwise (no project, My data): downloads.
  async function surveyOf(name) {
    const w = ws(), imp = (window._caveImports || []).find(i => i && i.parsed && i.name === name);
    if (imp) return { parsed: imp.parsed, georef: imp.georef || null };
    const P = PJ().P, f = P && P.cavefiles && P.cavefiles[name];
    let text = null, georef = null;
    if (f && !f.removed && f.h) { const r = await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt')); if (r.ok) { text = await r.text(); georef = f.place || null; } }
    if (text == null) { text = await w.recentText(name); const r = w.recents().find(x => x.name === name); georef = r ? r.georef : null; }
    return text && w.parse ? { parsed: w.parse(text), georef } : null;
  }
  async function exportSurvey(name) {
    const SE = window._surveyExport, A = window._pjApi, pj = PJ(), pw = PW();
    if (!SE || !A) return;
    const inP = !!(pw && pj.pid && pw.owns(name));
    const caves = inP && pj.P ? Object.values(pj.P.caves || {}).filter(c => !c.removed && (c.sources || []).some(x => x.file === name)) : [];
    const cave = caves.length === 1 ? caves[0].name : name.replace(/\.(plt|json)$/i, '');
    const proj = inP ? (pj.projects || []).find(p => p.id === pj.pid) : null;
    const folder = proj && proj.folder;
    const ids = new Set(caves.map(c => c.id));
    const segments = inP && pj.P ? Object.values(pj.P.segments || {}).filter(g => !g.removed && ids.has(g.cave)) : [];
    const body = document.createElement('div'); body.className = 'cc-exp';
    body.innerHTML = [['svx', 'Survex (.svx)', 'shots, passage sizes, dates, team, the fixed station'], ['csv', 'CSV (.csv)', 'one row per shot, for a spreadsheet'], ['plt', 'Compass plot (.plt)', 'station positions, as FLEX reads them']]
      .map(([k, l, t]) => `<label class="cc-exp-r"><input type="checkbox" class="keep-box" data-fmt="${k}" checked> <b>${l}</b> <small>${t}</small></label>`).join('') +
      `<div class="cc-exp-w">${inP && folder ? 'Into the project folder: <code>' + esc('Caves/' + cave + '/Survey/') + '</code> (files there are replaced).'
        : inP ? 'This project has no folder yet, so the files are downloaded.' : pj.pid ? 'This cave is in 👤 My data, not the project: the files are downloaded.' : 'No project open: the files are downloaded.'}</div>
      <div class="cc-exp-w">Metres and degrees. Shots are worked out from the station positions FLEX keeps; each file says what it can't carry.</div>`;
    const r = await A.dialog({ title: 'Export survey: ' + cave, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Export', value: 'ok', primary: true }] });
    if (!r) return;
    const fmts = [...r.box.querySelectorAll('[data-fmt]')].filter(x => x.checked).map(x => x.dataset.fmt);
    if (!fmts.length) { A.toast('Nothing ticked: no files written'); return; }
    const S = await surveyOf(name);
    if (!S) { A.toast(`The survey file of “${name}” isn’t on this computer`); return; }
    const files = SE.files(S.parsed, { name: cave, georef: S.georef, segments }, fmts);
    if (inP && folder) {
      try {
        const res = await fetch('/api/lib/survey-export?project=' + encodeURIComponent(pj.pid), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cave, files: files.map(f => ({ name: f.name, text: f.text })) }) });
        const o = await res.json();
        if (!res.ok || !o.ok) throw new Error(o.error || res.statusText);
        await A.dialog({ title: 'Survey exported', html: `Written to <code>${esc(o.path)}</code>:<br>${o.files.map(esc).join('<br>')}` });
      } catch (e) { A.toast('Export failed: ' + (e.message || e)); }
      return;
    }
    for (const f of files) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([f.text], { type: f.type + ';charset=utf-8' })); a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      await new Promise(res => setTimeout(res, 150));
    }
    A.toast('Downloaded ' + files.map(f => f.name).join(', '));
  }
  host.addEventListener('click', async e => {
    if (e.target.closest('[data-allstyle]')) { allStyle(e.target.closest('[data-allstyle]')); return; }
    const it = e.target.closest('.cc-it'), name = it && it.dataset.name;
    const MC = window._pjMulti, A0 = window._pjApi;
    const so = e.target.closest('[data-sysopen]'); if (so) { const id = so.dataset.sysopen; if (openSys.has(id)) openSys.delete(id); else openSys.add(id); render(); return; }
    if (e.target.closest('[data-sysnew]')) { if (MC) { await MC.editSystem(null); render(); } return; }
    const se = e.target.closest('[data-sysedit]'); if (se) { if (MC) { await MC.editSystem(se.dataset.sysedit); render(); } return; }
    const sk = e.target.closest('[data-skcave]'); if (sk) { reveal({ cave: sk.dataset.skcave }); return; }
    const sr = e.target.closest('[data-cave]'); if (sr && A0 && A0.editCave) { await A0.editCave(sr.dataset.cave); render(); return; }
    const sx = e.target.closest('[data-sort]');
    if (sx && MC) { const imp = (window._caveImports || []).find(i => i && i.parsed && i.name === sx.dataset.sort); if (imp) { await MC.multiCave(imp); render(); } else if (A0) A0.toast('Load the file first'); return; }
    if (e.target.closest('[data-openpj]')) { const b = document.getElementById('rail-pj') || document.getElementById('pj-top-btn'); if (b) b.click(); return; }
    const sh = e.target.closest('[data-set]'); if (sh) { const st = ws().sets()[+sh.dataset.set]; if (st) { if (openSets.has(st.name)) openSets.delete(st.name); else openSets.add(st.name); } render(); return; }
    const sl = e.target.closest('[data-setload]'); if (sl) { ws().loadSet(+sl.dataset.setload); return; }
    const sd = e.target.closest('[data-setdel]'); if (sd) { ws().deleteSet(+sd.dataset.setdel); setTimeout(render, 50); return; }
    if (!it) return;
    if (e.target.closest('[data-eye]')) {
      const i = ws().caveIndex(name);
      if (i < 0) await load(name); else window._toggleCaveImport(i, !ws().caveVisible(name));
      setTimeout(render, 50); return;
    }

    if (e.target.closest('[data-more]')) { more(name, e.target.closest('[data-more]')); return; }
    const mv = e.target.closest('[data-mv]'); if (mv) { move(name, mv.dataset.mv); return; }
  });
  // ── 🎨 All caves: one style setting for every loaded cave (flex.js _styleAll) ─
  function allStyle(anchor) {
    const old = document.getElementById('cc-allstyle'); if (old) { old.remove(); return; }
    const st = k => (window._styleAllState ? window._styleAllState(k) : null);
    const m = document.createElement('div'); m.id = 'cc-allstyle'; m.className = 'cc-pop cc-all';
    const tog = (k, label, def) => { const v = st(k); const val = v === 'mixed' ? 'mixed' : (v == null ? def : v);
      return `<label class="cc-row"><span>${label}</span><span class="cc-seg">` + [[true, 'On'], [false, 'Off']].map(([x, l]) => `<button type="button" data-k="${k}" data-v="${x}" class="${val === x ? 'on' : ''}">${l}</button>`).join('') + `${val === 'mixed' ? '<small>mixed</small>' : ''}</span></label>`; };
    const seg = (k, label, opts, def) => { const v = st(k); const val = v == null ? def : v;
      return `<label class="cc-row"><span>${label}</span><span class="cc-seg">` + opts.map(([x, l]) => `<button type="button" data-k="${k}" data-v='${JSON.stringify(x)}' class="${val === x ? 'on' : ''}">${l}</button>`).join('') + `${val === 'mixed' ? '<small>mixed</small>' : ''}</span></label>`; };
    const col = st('stationColor'), size = st('stationSize'), op = st('passageOpacity');
    m.innerHTML = `<div class="cc-pop-t">🎨 All ${ws().caves().length} loaded caves</div>
      ${tog('visible', 'Caves shown', true)}
      <div class="cc-sec">Stations</div>
      ${tog('showStations', 'Dots', false)}${tog('showLabels', 'Names', false)}
      <label class="cc-row"><span>Colour</span><input type="color" data-k="stationColor" value="${col && col !== 'mixed' ? col : '#ffeb3b'}"></label>
      <label class="cc-row"><span>Size</span><input type="range" min="1" max="15" data-k="stationSize" value="${size && size !== 'mixed' ? size : 5}"></label>
      <div class="cc-sec">Survey</div>
      ${tog('showSurface', 'Surface shots', false)}
      ${tog('showAreaLabels', 'Area names', true)}
      <button type="button" class="cc-link" data-k="resetColours">Reset survey colours</button>
      <div class="cc-sec">Walls</div>
      ${seg('passageMode', 'Walls', [['none', 'None'], ['blocky', 'Blocky'], ['smooth', 'Smooth']], 'none')}
      ${seg('passageUpAxis', 'Up', [['vertical', 'Vertical'], ['shot', '⟂ Shot']], 'vertical')}
      ${seg('passageLrudAt', 'LRUD at', [['from', 'From'], ['to', 'To']], 'from')}
      <label class="cc-row"><span>Opacity</span><input type="range" min="5" max="100" data-k="passageOpacity" value="${op && op !== 'mixed' ? Math.round(op * 100) : 55}"></label>
      <div class="cc-note2">Sets it on every loaded cave; each cave's own Style (⋯) still changes just that one.</div>`;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
    m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 10)) + 'px';
    const apply = (k, v) => { window._styleAll(k, v); const keep = m.style.left + '|' + m.style.top; m.remove(); allStyle(anchor); const n = document.getElementById('cc-allstyle'); if (n) { const [l, t] = keep.split('|'); n.style.left = l; n.style.top = t; } };
    m.addEventListener('click', e => {
      const b = e.target.closest('button[data-k]'); if (!b) return;
      if (b.dataset.k === 'resetColours') { window._styleAll('resetColours'); return; }
      apply(b.dataset.k, JSON.parse(b.dataset.v));
    });
    m.addEventListener('change', e => {
      const i = e.target.closest('input[data-k]'); if (!i) return;
      const k = i.dataset.k;
      apply(k, k === 'stationSize' ? parseInt(i.value, 10) : k === 'passageOpacity' ? parseInt(i.value, 10) / 100 : i.value);
    });
    const off = e => { if (!m.isConnected) { document.removeEventListener('mousedown', off, true); return; } if (!m.contains(e.target) && !e.target.closest('[data-allstyle]')) { m.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  }
  // Double-click a cave's name: fly to it (loading it first if needed).
  host.addEventListener('dblclick', async e => {
    const it = e.target.closest('.cc-it');
    if (!it || e.target.closest('button')) return;
    const name = it.dataset.name;
    let i = ws().caveIndex(name);
    if (i < 0) { await load(name); for (let k = 0; k < 50 && (i = ws().caveIndex(name)) < 0; k++) await new Promise(r => setTimeout(r, 100)); }
    if (i >= 0) setTimeout(() => window._flyToCave(i), 50);
  });
  // Drag across the columns.
  let drag = null;
  host.addEventListener('dragstart', e => { const it = e.target.closest('.cc-it'); if (!it) return; drag = { name: it.dataset.name, from: it.closest('[data-col]').dataset.col }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', drag.name); } catch (_) {} });
  host.addEventListener('dragover', e => { const c = e.target.closest('[data-col]'); if (!c || !drag || c.dataset.col === drag.from) return; e.preventDefault(); c.classList.add('cc-drop'); });
  host.addEventListener('dragleave', e => { const c = e.target.closest('[data-col]'); if (c && !c.contains(e.relatedTarget)) c.classList.remove('cc-drop'); });
  host.addEventListener('drop', e => { const c = e.target.closest('[data-col]'); if (!c || !drag) return; e.preventDefault(); c.classList.remove('cc-drop'); if (c.dataset.col !== drag.from) move(drag.name, c.dataset.col === 'p' ? 'in' : 'out'); drag = null; });
  host.addEventListener('dragend', () => { drag = null; host.querySelectorAll('.cc-drop').forEach(c => c.classList.remove('cc-drop')); });

  const style = document.createElement('style');
  style.textContent = `
  #cave-cols { width: 470px; max-width: 100%; margin-bottom: 6px; font-size: 11px; }
  #cave-cols .cc-head { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 2px 0 4px; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  #cave-cols .cc-hp { color: #6fd39a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; } #cave-cols .cc-hm { color: #8ab4ec; padding: 0 4px; }
  #cave-cols .cc-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 46vh; overflow-y: auto; }
  #cave-cols .cc-col { min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 3px; border-radius: 6px; min-height: 34px; }
  #cave-cols .cc-p { background: rgba(111,211,154,.08); } #cave-cols .cc-m { background: rgba(138,180,236,.07); }
  #cave-cols .cc-drop { outline: 2px dashed #ff9a62; outline-offset: -2px; }
  #cave-cols .cc-invite { gap: 6px; background: rgba(255,255,255,.03); border: 1px dashed rgba(255,255,255,.15); }
  #cave-cols .cc-note, #cave-cols .cc-empty { color: rgba(255,255,255,.45); font-size: 10.5px; padding: 3px 5px; font-style: italic; }
  #cave-cols .cc-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #e8ece9; border-radius: 5px; padding: 3px 8px; text-align: left; font-size: 11px; cursor: pointer; }
  #cave-cols .cc-it { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 5px; padding: 2px 3px; border-radius: 5px; }
  #cave-cols .cc-it:hover { background: rgba(255,255,255,.07); }
  #cave-cols .cc-it[draggable="true"] { cursor: grab; }
  #cave-cols .cc-moving { background: rgba(242,194,78,.08); }
  /* the row eye (.cc-eye) is the compact switch of every row: .ui-eye in ui_kit.css (24 px, the first column) */
  #cave-cols .cc-nm { cursor: default; user-select: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,.88); }
  #cave-cols .cc-nm small { display: block; font-size: 9px; color: rgba(255,255,255,.4); overflow: hidden; text-overflow: ellipsis; }
  #cave-cols .cc-moving .cc-nm small { color: #f2c24e; }
  #cave-cols .cc-dot { color: #f2c24e; margin-left: 3px; }
  #cave-cols .cc-tools { display: inline-flex; gap: 1px; opacity: .35; }
  #cave-cols .cc-it:hover .cc-tools, #cave-cols .cc-set:hover .cc-tools, #cave-cols .cc-it:focus-within .cc-tools { opacity: 1; }
  #cave-cols .cc-tools button { background: none; border: none; color: rgba(255,255,255,.7); padding: 0 3px; font-size: 12px; line-height: 16px; border-radius: 3px; cursor: pointer; }
  #cave-cols .cc-tools button:hover { color: #fff; background: rgba(255,255,255,.1); }
  #cave-cols .cc-tools .cc-mv { color: #ff9a62; font-weight: 700; }
  #cave-cols .cc-sets { margin-top: 4px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 3px; }
  #cave-cols .cc-set { display: grid; grid-template-columns: 1fr auto; align-items: center; }
  #cave-cols .cc-set-h { background: none; border: none; color: rgba(255,255,255,.8); text-align: left; padding: 2px 3px; font-size: 11px; cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #cave-cols .cc-set-h small { color: rgba(255,255,255,.4); }
  #cave-cols .cc-set .cc-tools button { font-size: 10px; }
  #cave-cols .cc-set-kids { grid-column: 1 / -1; padding: 0 0 3px 20px; font-size: 10px; color: rgba(255,255,255,.5); }
  #cave-cols .cc-sub { margin: 0 0 2px 28px; font-size: 10.5px; color: rgba(255,255,255,.7); }
  #cave-cols .cc-sr { padding: 1px 4px; border-radius: 4px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #cave-cols .cc-sr:hover, #cave-cols .cc-sk:hover { background: rgba(255,255,255,.08); }
  #cave-cols .cc-sr small, #cave-cols .cc-sys small { color: rgba(255,255,255,.4); }
  #cave-cols .cc-un { color: #f2c24e; }
  #cave-cols .cc-sk { cursor: pointer; padding: 1px 4px; border-radius: 4px; }
  #cave-cols .cc-systems { margin-top: 6px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 3px; }
  #cave-cols .cc-sys-h { display: flex; justify-content: space-between; align-items: center; font-size: 9.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: rgba(255,255,255,.5); padding: 0 3px; }
  #cave-cols .cc-sys { display: grid; grid-template-columns: 1fr auto; align-items: center; }
  #cave-cols .cc-sys:hover .cc-tools { opacity: 1; }
  #cave-cols .cc-sys .cc-set-h { white-space: normal; }
  #cave-cols .cc-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  #cave-cols .cc-hint { font-size: 10px; color: rgba(255,255,255,.4); }
  #cave-cols .cc-btn:disabled { opacity: .4; cursor: default; }
  .cc-all { width: 280px; gap: 2px; }
  .cc-all .cc-sec { font-size: 9.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.45); padding: 7px 6px 2px; }
  .cc-all .cc-row { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 6px; padding: 2px 6px; margin: 0; font-size: 12px; color: #e8ece9; }
  .cc-all .cc-seg { display: inline-flex; align-items: center; gap: 0; }
  .cc-all .cc-seg button { padding: 2px 9px; font-size: 11.5px; border: 1px solid rgba(255,255,255,.18); border-radius: 0; background: rgba(255,255,255,.04); color: rgba(255,255,255,.7); }
  .cc-all .cc-seg button:first-child { border-radius: 4px 0 0 4px; } .cc-all .cc-seg button + button { border-left: none; }
  .cc-all .cc-seg button:last-of-type { border-radius: 0 4px 4px 0; }
  .cc-all .cc-seg button.on { background: rgba(0,229,255,.22); color: #fff; }
  .cc-all .cc-seg small { margin-left: 6px; color: #f2c24e; font-size: 10px; }
  .cc-all input[type=range] { width: 100%; }
  .cc-all input[type=color] { width: 40px; height: 20px; padding: 0; border: none; background: none; }
  .cc-all .cc-link { color: #7bbfff; font-size: 11.5px; padding: 3px 6px; }
  .cc-all .cc-note2 { font-size: 10.5px; color: rgba(255,255,255,.45); padding: 8px 6px 2px; line-height: 1.35; }
  @keyframes row-flash { 0%, 40% { background: rgba(255,230,0,.35); box-shadow: inset 0 0 0 1px #ffe600; } 100% { background: transparent; box-shadow: none; } }
  #cave-cols .row-flash { animation: row-flash 1.8s ease-out; }
  .cc-pop { position: fixed; z-index: 9900; background: rgba(20,22,30,.98); border: 1px solid rgba(255,255,255,.15); border-radius: 7px; padding: 6px; display: flex; flex-direction: column; min-width: 170px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font: 12px system-ui, sans-serif; }
  .cc-pop-t { color: rgba(255,255,255,.55); font-size: 11px; padding: 2px 6px 4px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cc-pop button { background: none; border: none; color: #e8ece9; text-align: left; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .cc-pop button:hover { background: rgba(255,255,255,.08); }
  .cc-exp { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 8px; }
  .cc-exp-r { display: flex; align-items: baseline; gap: 6px; margin: 0; font-size: 12.5px; cursor: pointer; }
  .cc-exp-r small { opacity: .6; font-size: 11px; }
  .cc-exp-w { font-size: 11.5px; opacity: .75; margin-top: 4px; line-height: 1.4; }`;
  document.head.appendChild(style);

  window._caveCols = { render, reveal };
  // Draw once flex.js and the project are there; then on every change (flex.js and project-workspace.js call render).
  const t = setInterval(() => { if (ws() && ws().recents) { clearInterval(t); render(); } }, 300);
  // Systems and the caves of a multi-cave file change through project records (also another device's, History's undo):
  // draw again while the pane is open (an unchanged list keeps hover, focus and drags alive).
  setInterval(() => { const pane = document.getElementById('caveCollapsible'); if (pane && pane.classList.contains('show') && ws() && ws().recents) render(); }, 1500);
})();
