// cave_columns.js — 🕳 Caves as two columns: the open project's caves on the
// left, 👤 My data's on the right (the old Imported / Recent lists).
//
// Each row: a box that loads it (or shows / hides it once loaded), its name,
// ⌖ fly to, ⋯ for the rest (Rectify, Style, Labels, Replace survey file,
// Unload, Forget), and ← / → to move it across, or drag it. Moves wait for
// 💾 Save like every project change (project_workspace.js); until then the
// row shows where it is going, with a dot. Cave sets show as folders in My
// data. With no project open, the left column invites to open or start one.
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
    const what = x.dir ? (x.dir === 'in' ? 'moving into the project' : 'moving to My data') : waiting.get(x.name) || '';
    const arrow = !open ? '' : side === 'p'
      ? `<button type="button" class="cc-mv" data-mv="out" title="${x.dir === 'in' ? 'Back to My data (cancel the move)' : 'Move to My data'}">→</button>`
      : `<button type="button" class="cc-mv" data-mv="in" title="${x.dir === 'out' ? 'Back into the project (cancel the move)' : 'Move into the project'}">←</button>`;
    return `<div class="cc-it${x.dir ? ' cc-moving' : ''}" data-name="${esc(x.name)}" draggable="${open ? 'true' : 'false'}">
      <button type="button" class="cc-eye${vis ? ' on' : x.loaded ? ' half' : ''}" data-eye title="${!x.loaded ? 'Load' : vis ? 'Hide' : 'Show'}" aria-label="${!x.loaded ? 'Load' : vis ? 'Hide' : 'Show'} ${esc(x.name)}"></button>
      <span class="cc-nm" title="${esc(x.name)} — double-click to fly there">${esc(x.name.replace(/\.(plt|json)$/i, ''))}${what ? '<b class="cc-dot" title="' + esc(what) + ' — 💾 Save puts it in">•</b>' : ''}<small>${esc(what || (x.loaded ? '' : placeText(x.place)))}</small></span>
      <span class="cc-tools"><button type="button" data-more title="More">⋯</button>${arrow}</span>
    </div>`;
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
      : `<div class="cc-col cc-p" data-col="p">${R.project.map(x => item(x, 'p', true)).join('') || '<span class="cc-empty">No caves yet: drag one here from My data, or ← it.</span>'}</div>`;
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
  host.addEventListener('click', async e => {
    if (e.target.closest('[data-allstyle]')) { allStyle(e.target.closest('[data-allstyle]')); return; }
    const it = e.target.closest('.cc-it'), name = it && it.dataset.name;
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
  #cave-cols .cc-it { display: grid; grid-template-columns: 14px 1fr auto; align-items: center; gap: 5px; padding: 2px 3px; border-radius: 5px; }
  #cave-cols .cc-it:hover { background: rgba(255,255,255,.07); }
  #cave-cols .cc-it[draggable="true"] { cursor: grab; }
  #cave-cols .cc-moving { background: rgba(242,194,78,.08); }
  #cave-cols .cc-eye { width: 13px; height: 13px; border: 1.5px solid rgba(255,255,255,.45); border-radius: 3px; background: none; padding: 0; cursor: pointer; }
  #cave-cols .cc-eye.on { background: #e8ece9; border-color: #e8ece9; box-shadow: inset 0 0 0 2px #1d232e; }
  #cave-cols .cc-eye.half { border-color: #e8ece9; }
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
  .cc-pop { position: fixed; z-index: 9900; background: rgba(20,22,30,.98); border: 1px solid rgba(255,255,255,.15); border-radius: 7px; padding: 6px; display: flex; flex-direction: column; min-width: 170px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font: 12px system-ui, sans-serif; }
  .cc-pop-t { color: rgba(255,255,255,.55); font-size: 11px; padding: 2px 6px 4px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cc-pop button { background: none; border: none; color: #e8ece9; text-align: left; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .cc-pop button:hover { background: rgba(255,255,255,.08); }`;
  document.head.appendChild(style);

  window._caveCols = { render };
  // Draw once flex.js and the project are there; then on every change (flex.js and project_workspace.js call render).
  const t = setInterval(() => { if (ws() && ws().recents) { clearInterval(t); render(); } }, 300);
})();
