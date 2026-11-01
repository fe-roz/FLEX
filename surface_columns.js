// surface_columns.js — 📍 Surface as two columns, like 🕳 Caves: the open
// project's surface things on the left, 👤 My data's on the right.
//
//   project:  the CalTopo map, the project's feature folders, its data files
//   My data:  your points, one group per sitting ("Points <date time>"),
//             and the data files you loaded
// Box = show / hide (or load), ← / → moves across (a sitting's points, a
// data file), waiting for 💾 Save like every project change
// (project_workspace.js). The folder editor (draw, import, download, cave
// entrance tags, overlay folders) stays below, as before.
(function () {
  'use strict';
  const host = document.getElementById('surf-cols');
  if (!host) return;
  const ws = () => window._ws, PW = () => window._pjWs, PJ = () => window._pj || {}, MD = () => window._myData;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const V = () => window.cesiumViewer;
  const open = new Set();                      // expanded point groups
  let my = null, last = '', busy = false, again = false;

  async function myState(force) {
    if (!MD()) return { features: {}, groups: {}, layers: {} };
    if (!my || force) my = await MD().state(true);
    return my;
  }
  const blobUrl = l => (l.blob ? '/api/lib/blob/' + l.blob : l.url);
  const pointEntities = ids => (V() ? V().entities.values.filter(e => e.properties && e.properties.myFeature && ids.has(e.properties.myFeature.getValue())) : []);

  async function model() {
    const w = ws(), pj = PJ(), pw = PW();
    if (!w) return null;
    const S = await myState();
    const isOpen = !!(pj.pid && pj.P && pw);
    const moving = (kind, id) => (isOpen ? pw.movingItem(kind, id) : null);
    const loaded = new Map(w.dataFiles().map(f => [f.url, f]));
    const L = [], R = [];
    // My data: point groups and files.
    const pts = Object.values(S.features || {}).filter(f => !f.removed && f.kind === 'point');
    const byGroup = new Map();
    pts.forEach(f => { const g = f.group || ''; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(f); });
    [...byGroup.entries()].sort((a, b) => String((S.groups[b[0]] || {}).name || '').localeCompare(String((S.groups[a[0]] || {}).name || '')))
      .forEach(([gid, list]) => {
        const name = (S.groups[gid] || {}).name || 'Points';
        const ents = pointEntities(new Set(list.map(f => f.id)));
        const x = { kind: 'pgroup', id: gid, name, n: list.length, shown: ents.some(e => e.show !== false), points: list, dir: moving('pgroup', gid) };
        (x.dir === 'in' ? L : R).push(x);
      });
    Object.values(S.layers || {}).filter(l => l.kind === 'file' && !l.removed && (l.url || l.blob)).forEach(l => {
      const url = blobUrl(l), f = loaded.get(url);
      const x = { kind: 'file', id: l.id, name: l.name || url, url, loaded: !!f, shown: !!(f && f.show), items: f ? f.items : 0, dir: moving('file', l.id) };
      (x.dir === 'in' ? L : R).push(x);
    });
    if (isOpen) {
      const FL = window.FlexLib;
      const ct = (FL.liveLayers(pj.P) || []).filter(l => l.kind === 'caltopo');
      const now = w.caltopo(), src = w.vectorSources().find(s => s.kind === 'caltopo');
      ct.forEach(l => L.unshift({ kind: 'caltopo', id: l.id, name: 'CalTopo map', url: l.url, interval: l.interval, loaded: !!(now && now.url === l.url),
        shown: !!(src && src.ds.show !== false && now && now.url === l.url), items: src ? src.ds.entities.values.length : 0 }));
      const h = window._pjf ? window._pjf.hidden() : {};
      const feats = FL.liveFeatures(pj.P), groups = FL.liveGroups(pj.P);
      groups.filter(g => !g.parent).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })).forEach(g => {
        const n = feats.filter(f => FL.groupPath(pj.P, f.group).some(x => x.id === g.id)).length;
        L.push({ kind: 'folder', id: g.id, name: g.name || 'Folder', n, shown: !h['root'] && !h['g:' + g.id] });
      });
      const loose = feats.filter(f => !f.group).length;
      if (loose) L.push({ kind: 'loose', id: '', name: 'Not in a folder', n: loose, shown: !h['root'] });
      (FL.liveLayers(pj.P) || []).filter(l => l.kind === 'file').forEach(l => {
        const f = loaded.get(l.url);
        const x = { kind: 'file', id: l.id, name: l.name || l.url, url: l.url, loaded: !!f, shown: !!(f && f.show), items: f ? f.items : 0, inProject: true, dir: moving('file', l.id) };
        (x.dir === 'out' ? R : L).push(x);
      });
    }
    return { isOpen, L, R };
  }

  const icon = { caltopo: '🗺', folder: '📁', loose: '•', pgroup: '📍', file: '📄' };
  function row(x, side, isOpen) {
    const sub = x.dir ? (x.dir === 'in' ? 'moving into the project' : 'moving to My data')
      : x.kind === 'file' ? (x.loaded ? (x.items ? x.items + ' items' : 'loaded') : 'not loaded')
      : x.kind === 'caltopo' ? (x.loaded ? x.items + ' items' : 'not loaded')
      : (x.n != null ? x.n + (x.kind === 'pgroup' ? ' point' + (x.n === 1 ? '' : 's') : '') : '');
    const canMove = isOpen && (x.kind === 'pgroup' || x.kind === 'file');
    const arrow = !canMove ? '' : side === 'p'
      ? (x.kind === 'pgroup' && x.dir !== 'in' ? '' : `<button type="button" class="cc-mv" data-mv="out" title="${x.dir === 'in' ? 'Back to My data (cancel the move)' : 'Move to My data'}">→</button>`)
      : `<button type="button" class="cc-mv" data-mv="in" title="${x.dir === 'out' ? 'Back into the project (cancel the move)' : 'Move into the project'}">←</button>`;
    const eyeOn = x.kind === 'file' || x.kind === 'caltopo' ? x.loaded && x.shown : x.shown;
    const eyeHalf = (x.kind === 'file' || x.kind === 'caltopo') && x.loaded && !x.shown;
    const expand = x.kind === 'pgroup' && x.n ? `<span class="sc-arrow" data-expand>${open.has(x.id) ? '▾' : '▸'}</span>` : '';
    const forget = side === 'm' && !x.dir && (x.kind === 'file') ? '<button type="button" data-forget title="Forget: out of My data (unloads it)">✕</button>' : '';
    let html = `<div class="cc-it${x.dir ? ' cc-moving' : ''}" data-kind="${x.kind}" data-id="${esc(x.id)}" draggable="${canMove ? 'true' : 'false'}">
      <button type="button" class="cc-eye${eyeOn ? ' on' : eyeHalf ? ' half' : ''}" data-eye title="${(x.kind === 'file' || x.kind === 'caltopo') && !x.loaded ? 'Load' : eyeOn ? 'Hide' : 'Show'}"></button>
      <span class="cc-nm" title="${esc(x.name)}">${expand}${icon[x.kind] || ''} ${esc(x.name)}${x.dir ? '<b class="cc-dot">•</b>' : ''}<small>${esc(sub)}</small></span>
      <span class="cc-tools">${forget}${arrow}</span></div>`;
    if (x.kind === 'pgroup' && open.has(x.id) && !x.dir) {
      html += `<div class="sc-kids">${x.points.map(f => `<div class="sc-pt" data-pt="${esc(f.id)}"><span title="${esc(f.name)}">${esc(f.name || 'Point')}</span>
        <span class="cc-tools"><button type="button" data-ptfly title="Fly to">⌖</button>${isOpen ? '<button type="button" class="cc-mv" data-ptin title="Move this point into the project">←</button>' : ''}<button type="button" data-ptdel title="Delete the point">✕</button></span></div>`).join('')}</div>`;
    }
    return html;
  }

  async function render() {
    if (!host.isConnected) return;
    if (busy) { again = true; return; }              // asked again while drawing: once more after
    busy = true;
    try {
      const M = await model();
      if (!M) return;
      const pjName = M.isOpen ? (PW().projName ? PW().projName() : 'Project') : 'No project';
      const left = !M.isOpen
        ? `<div class="cc-col cc-p cc-invite"><span class="cc-note">No project open.</span>
             <button type="button" class="cc-btn" data-openpj>📁 Open a project…</button>
             <span class="cc-note">Your 👤 My data stays as it is.</span></div>`
        : `<div class="cc-col cc-p" data-col="p">${M.L.map(x => row(x, 'p', true)).join('') || '<span class="cc-empty">Nothing yet: draw or import below, or ← your points and files.</span>'}</div>`;
      const right = `<div class="cc-col cc-m" data-col="m">${M.R.map(x => row(x, 'm', M.isOpen)).join('') || '<span class="cc-empty">Points you make (right-click the map) and files you load are kept here.</span>'}</div>`;
      const html = `<div class="cc-head"><span class="cc-hp" title="${esc(pjName)}">📁 ${esc(pjName)}</span><span class="cc-hm">👤 My data</span></div><div class="cc-cols">${left}${right}</div>`;
      if (html === last) return;
      last = html;
      const sc = host.querySelector('.cc-cols') ? host.querySelector('.cc-cols').scrollTop : 0;
      host.innerHTML = html;
      host.querySelector('.cc-cols').scrollTop = sc;
    } catch (e) { console.warn('[surface] render', e); }
    finally { busy = false; if (again) { again = false; setTimeout(render, 0); } }
  }
  const soon = (force) => { if (force) my = null; setTimeout(render, 30); };

  // ── Actions ──────────────────────────────────────────────────────────────
  async function find(kind, id) { const M = await model(); return M && M.L.concat(M.R).find(x => x.kind === kind && x.id === id); }
  async function eye(kind, id) {
    const x = await find(kind, id), w = ws();
    if (!x) return;
    if (kind === 'pgroup') { const ents = pointEntities(new Set(x.points.map(f => f.id))); ents.forEach(e => { e.show = !x.shown; }); if (window._updateHtmlLabels) window._updateHtmlLabels(); }
    else if (kind === 'folder' || kind === 'loose') { if (window._pjf) { window._pjf.setHidden(kind === 'loose' ? 'root' : 'g:' + id, x.shown); window._pjf.draw(); window._pjf.render(); } }
    else if (kind === 'caltopo') {
      if (!x.loaded) await w.setCaltopo(x.url, x.interval ?? 30);
      else { const src = w.vectorSources().find(s => s.kind === 'caltopo'); if (src) src.ds.show = !x.shown; }
    } else if (kind === 'file') {
      if (!x.loaded) await w.addDataFile(x.url, x.name, x.inProject ? { noKeep: true } : { myId: x.id });
      else w.setDataFileShown(x.url, !x.shown);
    }
    soon();
  }
  async function move(kind, id, dir) {
    const pw = PW(), x = await find(kind, id);
    if (!pw || !x || !PJ().pid) return;
    if (kind === 'pgroup' && dir === 'out' && x.dir !== 'in') return;   // project features don't go back to My data (yet)
    await pw.moveItem({ kind, id, name: x.name, dir: x.dir ? x.dir : dir, url: x.url });
    soon();
  }
  host.addEventListener('click', async e => {
    if (e.target.closest('[data-openpj]')) { const b = document.getElementById('rail-pj') || document.getElementById('pj-top-btn'); if (b) b.click(); return; }
    const pt = e.target.closest('[data-pt]');
    if (pt) {
      const id = pt.dataset.pt, ent = pointEntities(new Set([id]))[0];
      if (e.target.closest('[data-ptfly]') && ent && V()) V().flyTo(ent, { duration: 1.2, offset: new Cesium.HeadingPitchRange(0, -0.6, 400) });
      if (e.target.closest('[data-ptin]')) { const S = await myState(); const f = S.features[id]; if (f && PW()) { await PW().moveItem({ kind: 'point', id, name: f.name || 'Point', dir: 'in' }); soon(); } }
      if (e.target.closest('[data-ptdel]')) { if (ent) { MD().forgetPoint(ent); V().entities.remove(ent); } else await MD().forgetPoint({ properties: { myFeature: { getValue: () => id } } }); soon(true); }
      return;
    }
    const it = e.target.closest('.cc-it'); if (!it) return;
    const kind = it.dataset.kind, id = it.dataset.id;
    if (e.target.closest('[data-expand]') || (kind === 'pgroup' && e.target.closest('.cc-nm'))) { if (open.has(id)) open.delete(id); else open.add(id); last = ''; render(); return; }
    if (e.target.closest('[data-eye]')) { eye(kind, id); return; }
    if (e.target.closest('[data-forget]')) { const x = await find(kind, id); if (x && x.loaded) ws().removeDataFile(x.url); else await MD().forgetFile(id); soon(true); return; }
    const mv = e.target.closest('[data-mv]'); if (mv) { move(kind, id, mv.dataset.mv); return; }
  });
  let drag = null;
  host.addEventListener('dragstart', e => { const it = e.target.closest('.cc-it'); if (!it) return; drag = { kind: it.dataset.kind, id: it.dataset.id, from: it.closest('[data-col]').dataset.col }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', drag.id); } catch (_) {} });
  host.addEventListener('dragover', e => { const c = e.target.closest('[data-col]'); if (!c || !drag || c.dataset.col === drag.from) return; e.preventDefault(); c.classList.add('cc-drop'); });
  host.addEventListener('dragleave', e => { const c = e.target.closest('[data-col]'); if (c && !c.contains(e.relatedTarget)) c.classList.remove('cc-drop'); });
  host.addEventListener('drop', e => { const c = e.target.closest('[data-col]'); if (!c || !drag) return; e.preventDefault(); c.classList.remove('cc-drop'); if (c.dataset.col !== drag.from) move(drag.kind, drag.id, c.dataset.col === 'p' ? 'in' : 'out'); drag = null; });
  host.addEventListener('dragend', () => { drag = null; host.querySelectorAll('.cc-drop').forEach(c => c.classList.remove('cc-drop')); });

  // My data changes (a point made or deleted, a file loaded or forgotten).
  const hook = setInterval(() => {
    const m = MD();
    if (!m || !ws()) return;
    clearInterval(hook);
    ['keepPoint', 'forgetPoint', 'keepFile', 'forgetFile'].forEach(k => { const f = m[k]; m[k] = async (...a) => { const r = await f(...a); soon(true); return r; }; });
    render();
  }, 300);
  setInterval(() => { const p = document.getElementById('featuresCollapsible'); if (p && p.classList.contains('show')) render(); }, 3000);

  const style = document.createElement('style');
  style.textContent = `
  #surf-cols { width: 470px; max-width: 100%; margin: 2px 0 8px; font-size: 11px; }
  #surf-cols .sc-arrow { display: inline-block; width: 10px; color: rgba(255,255,255,.5); cursor: pointer; }
  #surf-cols .cc-nm { cursor: default; }
  #surf-cols [data-kind="pgroup"] .cc-nm { cursor: pointer; }
  #surf-cols .sc-kids { padding: 0 0 3px 22px; }
  #surf-cols .sc-pt { display: grid; grid-template-columns: 1fr auto; gap: 4px; align-items: center; font-size: 10.5px; color: rgba(255,255,255,.75); padding: 1px 2px; border-radius: 4px; }
  #surf-cols .sc-pt:hover { background: rgba(255,255,255,.06); }
  #surf-cols .sc-pt span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #surf-cols .sc-pt:hover .cc-tools { opacity: 1; }
  /* rows share the look of 🕳 Caves (cave_columns.js) */
  #surf-cols .cc-head { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 2px 0 4px; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  #surf-cols .cc-hp { color: #6fd39a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; } #surf-cols .cc-hm { color: #8ab4ec; padding: 0 4px; }
  #surf-cols .cc-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 40vh; overflow-y: auto; }
  #surf-cols .cc-col { min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 3px; border-radius: 6px; min-height: 34px; }
  #surf-cols .cc-p { background: rgba(111,211,154,.08); } #surf-cols .cc-m { background: rgba(138,180,236,.07); }
  #surf-cols .cc-drop { outline: 2px dashed #ff9a62; outline-offset: -2px; }
  #surf-cols .cc-invite { gap: 6px; background: rgba(255,255,255,.03); border: 1px dashed rgba(255,255,255,.15); }
  #surf-cols .cc-note, #surf-cols .cc-empty { color: rgba(255,255,255,.45); font-size: 10.5px; padding: 3px 5px; font-style: italic; }
  #surf-cols .cc-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #e8ece9; border-radius: 5px; padding: 3px 8px; text-align: left; font-size: 11px; cursor: pointer; }
  #surf-cols .cc-it { display: grid; grid-template-columns: 14px 1fr auto; align-items: center; gap: 5px; padding: 2px 3px; border-radius: 5px; }
  #surf-cols .cc-it:hover { background: rgba(255,255,255,.07); }
  #surf-cols .cc-it[draggable="true"] { cursor: grab; }
  #surf-cols .cc-moving { background: rgba(242,194,78,.08); }
  #surf-cols .cc-eye { width: 13px; height: 13px; border: 1.5px solid rgba(255,255,255,.45); border-radius: 3px; background: none; padding: 0; cursor: pointer; }
  #surf-cols .cc-eye.on { background: #e8ece9; border-color: #e8ece9; box-shadow: inset 0 0 0 2px #1d232e; }
  #surf-cols .cc-eye.half { border-color: #e8ece9; }
  #surf-cols .cc-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,.88); }
  #surf-cols .cc-nm small { display: block; font-size: 9px; color: rgba(255,255,255,.4); overflow: hidden; text-overflow: ellipsis; padding-left: 12px; }
  #surf-cols .cc-moving .cc-nm small { color: #f2c24e; }
  #surf-cols .cc-dot { color: #f2c24e; margin-left: 3px; }
  #surf-cols .cc-tools { display: inline-flex; gap: 1px; opacity: .35; }
  #surf-cols .cc-it:hover .cc-tools, #surf-cols .cc-it:focus-within .cc-tools { opacity: 1; }
  #surf-cols .cc-tools button { background: none; border: none; color: rgba(255,255,255,.7); padding: 0 3px; font-size: 12px; line-height: 16px; border-radius: 3px; cursor: pointer; }
  #surf-cols .cc-tools button:hover { color: #fff; background: rgba(255,255,255,.1); }
  #surf-cols .cc-tools .cc-mv { color: #ff9a62; font-weight: 700; }
  /* The old lists: the columns show these now. */
  #lp-poi-list, #lp-data-list { display: none !important; }`;
  document.head.appendChild(style);

  window._surfCols = { render: () => { last = ''; return render(); }, refresh: () => soon(true) };
})();
