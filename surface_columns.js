// surface_columns.js — 📍 Surface as two columns, like 🕳 Caves: the open
// project's surface things on the left, 👤 My data's on the right.
//
//   bar:      📍 Surface on/off — hides or shows everything on the surface
//             (project features, the CalTopo map, data files, your points)
//             without changing what each one is set to; the tools to draw,
//             import and download
//   project:  the CalTopo map, the project's feature folders, its data files
//   My data:  your points, one group per sitting ("Points <date time>"),
//             and the data files you loaded
// Box = show / hide (or load), ← / → moves across (a sitting's points, a
// data file), waiting for 💾 Save like every project change
// (project_workspace.js). ▸ opens a row in place: a project folder shows its
// folders and features (click: highlight, double-click: fly there, ✏️ edit),
// the CalTopo map and data files show their own folders.
(function () {
  'use strict';
  const host = document.getElementById('surf-cols');
  if (!host) return;
  const ws = () => window._ws, PW = () => window._pjWs, PJ = () => window._pj || {}, MD = () => window._myData, PF = () => window._pjf;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const V = () => window.cesiumViewer;
  const open = new Set();                      // expanded rows: point groups, 'o:<source url>' and its folders
  const fOpen = () => ((window._pjfState || {}).open || {});   // project folders: shared with project_features.js
  let my = null, last = '', busy = false, again = false;
  const ov = new Map();                        // overlay row key → entity (rebuilt each render)

  // ── 📍 Surface on/off ────────────────────────────────────────────────────
  // Off: everything on the surface is hidden; what each thing was set to is
  // kept and comes back with on. Things that turn up while it is off (a
  // CalTopo refresh, a file loaded) are hidden too.
  const MS = { off: false, saved: new Map() };
  try { MS.off = localStorage.getItem('flex.surface.off') === '1'; } catch (_) {}
  function targets() {
    const out = [], v = V(), w = ws(), F = window._pjfState;
    if (F && F.src) out.push(F.src);
    if (w) w.vectorSources().forEach(s => s.ds && out.push(s.ds));
    if (v) v.entities.values.forEach(e => { const p = e.properties; if (p && (p.isUserLabel || p.myFeature)) out.push(e); });
    return out;
  }
  const own = o => (MS.saved.has(o) ? MS.saved.get(o) : o.show !== false);
  function applyMaster() {
    if (MS.off) targets().forEach(o => { if (!MS.saved.has(o)) { MS.saved.set(o, o.show !== false); o.show = false; } else if (o.show !== false) { MS.saved.set(o, true); o.show = false; } });
    else { MS.saved.forEach((was, o) => { o.show = was; }); MS.saved.clear(); }
    const b = document.querySelector('#flex-rail [data-target="#featuresCollapsible"]');
    if (b) { b.classList.toggle('sc-off', MS.off); b.title = MS.off ? 'Surface — hidden (📍 Surface on/off)' : 'Surface'; }
    const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
  }
  function setMaster(on) {
    MS.off = !on;
    try { localStorage.setItem('flex.surface.off', MS.off ? '1' : '0'); } catch (_) {}
    applyMaster(); last = ''; render();
  }
  setInterval(() => { if (MS.off) applyMaster(); }, 1000);

  // ── Labels on/off: names of project features, CalTopo and data-file
  // features (project_features.js draws those) and your points (flex.js,
  // through its old "Show labels" box, kept hidden).
  let LB = true;
  try { LB = localStorage.getItem('flex.surface.labels') !== '0'; } catch (_) {}
  const labelsOn = () => LB;
  function applyLabels() {
    window._surfLabelsOff = !LB;
    const cb = document.getElementById('html_labels_toggle');
    if (cb && cb.checked !== LB) { cb.checked = LB; cb.dispatchEvent(new Event('change')); }
    const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
  }
  function setLabels(on) {
    LB = !!on;
    try { localStorage.setItem('flex.surface.labels', LB ? '1' : '0'); } catch (_) {}
    applyLabels(); last = ''; render();
  }
  const masterOnFirst = () => { if (MS.off) setMaster(true); };   // using a row's box turns the surface back on

  async function myState(force) {
    if (!MD()) return { features: {}, groups: {}, layers: {} };
    if (!my || force) my = await MD().state(true);
    return my;
  }
  const blobUrl = l => (l.blob ? '/api/lib/blob/' + l.blob : l.url);
  const pointEntities = ids => (V() ? V().entities.values.filter(e => e.properties && e.properties.myFeature && ids.has(e.properties.myFeature.getValue())) : []);
  const srcOf = url => (ws() ? ws().vectorSources().find(s => (s.url || s.name) === url) : null);

  async function model() {
    const w = ws(), pj = PJ(), pw = PW();
    if (!w) return null;
    let S = await myState();
    const isOpen = !!(pj.pid && pj.P && pw);
    // A file loaded since My data was last read (kept by flex.js): read it again.
    const known = new Set(Object.values(S.layers || {}).filter(l => !l.removed).map(blobUrl).concat(isOpen ? (window.FlexLib.liveLayers(pj.P) || []).map(l => l.url) : []));
    if (w.dataFiles().some(f => !known.has(f.url))) S = await myState(true);
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
        const x = { kind: 'pgroup', id: gid, name, n: list.length, shown: ents.some(own), points: list, dir: moving('pgroup', gid) };
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
        shown: !!(src && own(src.ds) && now && now.url === l.url), items: src ? src.ds.entities.values.length : 0, src: src && now && now.url === l.url ? src : null }));
      const h = PF() ? PF().hidden() : {};
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
    } else {
      // No project: a CalTopo map loaded on its own is still listed (in My data).
      const src = w.vectorSources().find(s => s.kind === 'caltopo');
      if (src) R.unshift({ kind: 'caltopo', id: 'ct', name: 'CalTopo map', url: src.url, loaded: true, shown: own(src.ds), items: src.ds.entities.values.length, src });
    }
    [...L, ...R].forEach(x => { if (x.kind === 'file' && x.loaded) x.src = srcOf(x.url); });
    return { isOpen, L, R };
  }

  // ── Rows ─────────────────────────────────────────────────────────────────
  const icon = { caltopo: '🗺', folder: '📁', loose: '•', pgroup: '📍', file: '📄' };
  const fIcon = { point: '•', line: '〰', area: '▱' };
  const arrowOf = (key, isOpen) => `<span class="sc-arrow" data-expand="${esc(key)}">${isOpen ? '▾' : '▸'}</span>`;
  function expKey(x) {
    if (x.kind === 'pgroup') return x.n ? 'p:' + x.id : null;
    if (x.kind === 'folder') return 'g:' + x.id;
    if (x.kind === 'loose') return 'loose';
    if ((x.kind === 'caltopo' || x.kind === 'file') && x.src && x.src.ds.entities.values.length) return 'o:' + (x.src.url || x.src.name);
    return null;
  }
  const isExp = k => (k.startsWith('g:') || k === 'loose' ? !!fOpen()[k] : open.has(k));
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
    const k = !x.dir && expKey(x), exp = k && isExp(k);
    const forget = side === 'm' && !x.dir && (x.kind === 'file') ? '<button type="button" data-forget title="Forget: out of My data (unloads it)">✕</button>' : '';
    const ftools = x.kind === 'folder' ? `<button type="button" data-gadd="${esc(x.id)}" title="Add to this folder">＋</button><button type="button" data-gdl="${esc(x.id)}" title="Download for CalTopo">⇩</button><button type="button" data-gedit="${esc(x.id)}" title="Rename, colour, move">✏️</button>` : '';
    let html = `<div class="cc-it${x.dir ? ' cc-moving' : ''}" data-kind="${x.kind}" data-id="${esc(x.id)}" draggable="${canMove ? 'true' : 'false'}">
      <button type="button" class="cc-eye${eyeOn ? ' on' : eyeHalf ? ' half' : ''}" data-eye title="${(x.kind === 'file' || x.kind === 'caltopo') && !x.loaded ? 'Load' : eyeOn ? 'Hide' : 'Show'}"></button>
      <span class="cc-nm" title="${esc(x.name)}"${k ? ` data-expand="${esc(k)}"` : ''}>${k ? arrowOf(k, exp) : '<span class="sc-arrow"></span>'}${icon[x.kind] || ''} ${esc(x.name)}${x.dir ? '<b class="cc-dot">•</b>' : ''}<small>${esc(sub)}</small></span>
      <span class="cc-tools">${ftools}${forget}${arrow}</span></div>`;
    if (exp) html += `<div class="sc-kids">${kids(x, isOpen)}</div>`;
    return html;
  }
  function kids(x, isOpen) {
    if (x.kind === 'pgroup') return x.points.map(f => `<div class="sc-pt" data-pt="${esc(f.id)}"><span title="${esc(f.name)}">${esc(f.name || 'Point')}</span>
        <span class="cc-tools"><button type="button" data-ptfly title="Fly to">⌖</button>${isOpen ? '<button type="button" class="cc-mv" data-ptin title="Move this point into the project">←</button>' : ''}<button type="button" data-ptdel title="Delete the point">✕</button></span></div>`).join('');
    if (x.kind === 'folder' || x.kind === 'loose') return projectTree(x.kind === 'loose' ? null : x.id, 0);
    if (x.src) return overlayTree(x.src);
    return '';
  }
  /** A project folder's folders and features (features only for null: not in a folder). */
  function projectTree(gid, depth) {
    const pj = PJ(), FL = window.FlexLib, P = PF(), h = P.hidden(), pad = d => `style="padding-left:${4 + d * 12}px"`;
    let out = '';
    if (gid) FL.liveGroups(pj.P).filter(g => (g.parent || '') === gid).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })).forEach(g => {
      const k = 'g:' + g.id, exp = !!fOpen()[k];
      const n = FL.liveFeatures(pj.P).filter(f => FL.groupPath(pj.P, f.group).some(y => y.id === g.id)).length;
      out += `<div class="sc-sub sc-fold" ${pad(depth)}><button type="button" class="cc-eye${h[k] ? '' : ' on'}" data-geye="${esc(g.id)}" title="${h[k] ? 'Show' : 'Hide'}"></button>
        <span class="sc-nm" data-expand="${esc(k)}">${arrowOf(k, exp)}<span class="pjs-sw" style="background:${esc(P.groupColor(g.id))}"></span>📁 ${esc(g.name)} <small>${n}</small></span>
        <span class="cc-tools"><button type="button" data-gadd="${esc(g.id)}" title="Add to this folder">＋</button><button type="button" data-gdl="${esc(g.id)}" title="Download for CalTopo">⇩</button><button type="button" data-gedit="${esc(g.id)}" title="Rename, colour, move">✏️</button></span></div>`;
      if (exp) out += projectTree(g.id, depth + 1);
    });
    FL.liveFeatures(pj.P).filter(f => (f.group || null) === (gid || null)).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })).forEach(f => {
      out += `<div class="sc-sub sc-feat" data-feat="${esc(f.id)}" ${pad(depth)} title="Click: highlight · double-click: fly there"><span class="sc-ic" style="color:${esc(P.colorOf(f))}">${fIcon[f.kind] || '•'}</span>
        <span class="sc-nm">${esc(f.name || '(no name)')}${FL.flexTag(f.desc) ? ' <small>🕳</small>' : ''}</span>
        <span class="cc-tools"><button type="button" data-fedit="${esc(f.id)}" title="Edit">✏️</button></span></div>`;
    });
    return out || '<div class="sc-sub sc-none">empty</div>';
  }
  /** A CalTopo map's or a data file's own folders and items. */
  function overlayTree(src) {
    const P = PF(); if (!P) return '';
    const tree = P.overlayTree(src), h = P.hidden();
    const base = 'o:' + (src.url || src.name);
    let out = '';
    const visit = (parent, path, depth) => {
      const list = tree.get(parent) || [];
      const folders = list.filter(e => tree.has(e)), leaves = list.filter(e => !tree.has(e));
      folders.forEach(e => {
        const p = path + '/' + (e.name || e.id), key = base + '|' + p, hk = P.srcKey(src, p), exp = open.has(key);
        ov.set(hk, e);
        out += `<div class="sc-sub sc-fold" style="padding-left:${4 + depth * 12}px"><button type="button" class="cc-eye${h[hk] ? '' : ' on'}" data-oeye="${esc(hk)}" title="${h[hk] ? 'Show' : 'Hide'}"></button>
          <span class="sc-nm" data-expand="${esc(key)}">${arrowOf(key, exp)}📁 ${esc(e.name || '(folder)')} <small>${(tree.get(e) || []).length}</small></span></div>`;
        if (exp) visit(e, p, depth + 1);
      });
      leaves.slice(0, 200).forEach(e => {
        const p = path + '/' + (e.name || e.id), hk = P.srcKey(src, p);
        ov.set(hk, e);
        out += `<div class="sc-sub sc-feat" data-ov="${esc(hk)}" style="padding-left:${4 + depth * 12}px" title="Click: highlight · double-click: fly there"><button type="button" class="cc-eye${h[hk] ? '' : ' on'}" data-oeye="${esc(hk)}" title="${h[hk] ? 'Show' : 'Hide'}"></button>
          <span class="sc-nm">${esc(e.name || '(no name)')}</span></div>`;
      });
      if (leaves.length > 200) out += `<div class="sc-sub sc-none" style="padding-left:${4 + depth * 12}px">… and ${leaves.length - 200} more</div>`;
    };
    visit(null, '', 0);
    return out || '<div class="sc-sub sc-none">no folders</div>';
  }

  function bar(isOpen) {
    const on = !MS.off;
    const tools = isOpen
      ? `<button type="button" data-draw="point" title="Draw a point in the project">＋ Point</button><button type="button" data-draw="line" title="Draw a line">＋ Line</button><button type="button" data-draw="area" title="Draw an area">＋ Area</button><button type="button" data-tool="folder" title="A new folder">＋ Folder</button><button type="button" data-tool="import" title="GPX / KML / KMZ / GeoJSON into the project's features">⇪ Import</button><button type="button" data-tool="download" title="All the project's features, for CalTopo">⇩ Download</button><button type="button" data-tool="file" title="Show a KMZ / GeoJSON / GPX file as it is (a data file)">📄 Add file</button>`
      : `<button type="button" data-tool="file" title="Show a KMZ / GeoJSON / GPX file">📄 Add KMZ / GeoJSON / GPX</button>`;
    const lab = labelsOn();
    return `<div class="sc-bar"><button type="button" class="sc-master${on ? ' on' : ''}" data-master title="${on ? 'Hide every feature on the surface (each keeps its own setting)' : 'Show the features again, as each was set'}"><span class="sc-sw"></span>Show features</button><button type="button" class="sc-master sc-lab${lab ? ' on' : ''}" data-labels title="${lab ? 'Hide the names on the map' : 'Show the names on the map'}"><span class="sc-sw"></span>Labels</button><span class="sc-tools">${tools}</span></div>`;
  }

  async function render() {
    if (!host.isConnected) return;
    if (busy) { again = true; return; }              // asked again while drawing: once more after
    busy = true;
    try {
      const M = await model();
      if (!M) return;
      ov.clear();
      const pjName = M.isOpen ? (PW().projName ? PW().projName() : 'Project') : 'No project';
      const left = !M.isOpen
        ? `<div class="cc-col cc-p cc-invite"><span class="cc-note">No project open.</span>
             <button type="button" class="cc-btn" data-openpj>📁 Open a project…</button>
             <span class="cc-note">Your 👤 My data stays as it is.</span></div>`
        : `<div class="cc-col cc-p" data-col="p">${M.L.map(x => row(x, 'p', true)).join('') || '<span class="cc-empty">Nothing yet: draw or import above, or ← your points and files.</span>'}</div>`;
      const right = `<div class="cc-col cc-m" data-col="m">${M.R.map(x => row(x, 'm', M.isOpen)).join('') || '<span class="cc-empty">Points you make (right-click the map) and files you load are kept here.</span>'}</div>`;
      const html = `${bar(M.isOpen)}<div class="cc-head"><span class="cc-hp" title="${esc(pjName)}">📁 ${esc(pjName)}</span><span class="cc-hm">👤 My data</span></div><div class="cc-cols${MS.off ? ' sc-dim' : ''}">${left}${right}</div>`;
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
    masterOnFirst();
    const x = await find(kind, id), w = ws();
    if (!x) return;
    if (kind === 'pgroup') { const ents = pointEntities(new Set(x.points.map(f => f.id))); ents.forEach(e => { e.show = !x.shown; }); }
    else if (kind === 'folder' || kind === 'loose') { if (PF()) { PF().setHidden(kind === 'loose' ? 'root' : 'g:' + id, x.shown); PF().draw(); } }
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
  function toggle(k) {
    if (k.startsWith('g:') || k === 'loose') { const o = fOpen(); o[k] = !o[k]; }
    else if (open.has(k)) open.delete(k); else open.add(k);
    last = ''; render();
  }
  // Click highlights a feature (after a moment, so a double-click can fly instead).
  let clickT = null;
  function featureOf(el) {
    const P = PF(), pj = PJ();
    if (el.dataset.feat) { const f = pj.P && pj.P.features[el.dataset.feat]; return f ? { kind: f.kind, coords: f.coords, key: 'f:' + f.id } : null; }
    const e = ov.get(el.dataset.ov); if (!e || !P) return null;
    const g = P.entCoords(e); return g ? Object.assign(g, { key: 'e:' + e.id }) : null;
  }
  host.addEventListener('dblclick', e => {
    const r = e.target.closest('.sc-feat'); if (!r || e.target.closest('button')) return;
    clearTimeout(clickT); const g = featureOf(r); if (g && PF()) PF().highlight(g, true);
  });
  host.addEventListener('click', async e => {
    const P = PF();
    if (e.target.closest('[data-master]')) { setMaster(MS.off); return; }
    if (e.target.closest('[data-labels]')) { setLabels(!LB); return; }
    if (e.target.closest('[data-openpj]')) { const b = document.getElementById('rail-pj') || document.getElementById('pj-top-btn'); if (b) b.click(); return; }
    const dr = e.target.closest('[data-draw]'); if (dr && P) { masterOnFirst(); P.startDraw(dr.dataset.draw, ''); return; }
    const tl = e.target.closest('[data-tool]');
    if (tl) {
      const t = tl.dataset.tool;
      if (t === 'file') { if (window._addDataFile) window._addDataFile(); }
      else if (t === 'folder' && P) P.editGroup(null, '');
      else if (t === 'import' && P) { masterOnFirst(); P.importFile(''); }
      else if (t === 'download' && P) P.downloadMenu('');
      return;
    }
    const ex = e.target.closest('[data-expand]');
    if (ex && !e.target.closest('.cc-eye, .cc-tools')) { toggle(ex.dataset.expand); return; }
    const gb = e.target.closest('[data-gadd],[data-gdl],[data-gedit],[data-geye],[data-fedit],[data-oeye]');
    if (gb && P) {
      const d = gb.dataset, A = window._pjApi;
      if (d.geye) { masterOnFirst(); const h = P.hidden(); P.setHidden('g:' + d.geye, !h['g:' + d.geye]); P.draw(); last = ''; render(); }
      else if (d.oeye) { masterOnFirst(); const h = P.hidden(); P.setHidden(d.oeye, !h[d.oeye]); P.applyOverlayHidden(); last = ''; render(); }
      else if (d.fedit) P.editFeature(d.fedit);
      else if (d.gdl) P.downloadMenu(d.gdl);
      else if (d.gedit) P.editGroup(d.gedit);
      else if (d.gadd && A) {
        const g = PJ().P.groups[d.gadd] || {};
        const k = await A.choose(`Add to “${g.name || 'folder'}”`, '', [{ label: '• Point', value: 'point' }, { label: '〰 Line', value: 'line' }, { label: '▱ Area', value: 'area' }, { label: '📁 Folder', value: 'folder' }, { label: '⇪ Import a file', value: 'import' }]);
        if (k === 'folder') P.editGroup(null, d.gadd); else if (k === 'import') P.importFile(d.gadd); else if (k) { masterOnFirst(); P.startDraw(k, d.gadd); }
      }
      return;
    }
    const ft = e.target.closest('.sc-feat');
    if (ft) { clearTimeout(clickT); clickT = setTimeout(() => { const g = featureOf(ft); if (g && P) P.highlight(g, false); }, 220); return; }
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
    // New CalTopo / data-file sources: hidden at once while the surface is off; listed.
    const prev = window._onVectorSourcesChanged;
    window._onVectorSourcesChanged = (...a) => { if (prev) prev(...a); if (MS.off) applyMaster(); soon(); };
    if (MS.off) applyMaster();
    applyLabels();
    render();
  }, 300);
  setInterval(() => { const p = document.getElementById('featuresCollapsible'); if (p && p.classList.contains('show')) render(); }, 3000);

  const style = document.createElement('style');
  style.textContent = `
  #surf-cols { width: 470px; max-width: 100%; margin: 2px 0 8px; font-size: 11px; }
  #surf-cols .sc-bar { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; margin: 0 0 6px; }
  #surf-cols .sc-bar button { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #e8ece9; border-radius: 5px; padding: 2px 7px; font-size: 10.5px; cursor: pointer; }
  #surf-cols .sc-bar button:hover { background: rgba(255,255,255,.12); }
  #surf-cols .sc-master { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; margin-right: 4px; }
  #surf-cols .sc-master .sc-sw { width: 24px; height: 13px; border-radius: 7px; background: rgba(255,255,255,.2); position: relative; flex: none; transition: background .15s; }
  #surf-cols .sc-master .sc-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; border-radius: 50%; background: #fff; transition: left .15s; }
  #surf-cols .sc-master.on .sc-sw { background: #3fae6e; }
  #surf-cols .sc-master.on .sc-sw::after { left: 13px; }
  #surf-cols .sc-master:not(.on) { border-color: #f2c24e; color: #f2c24e; }
  #surf-cols .sc-lab:not(.on) { border-color: rgba(255,255,255,.15); color: rgba(255,255,255,.6); }
  #surf-cols .sc-tools { display: contents; }
  #surf-cols .sc-dim { opacity: .5; }
  #flex-rail .sc-off { opacity: .5; text-decoration: line-through; }
  #surf-cols .sc-arrow { display: inline-block; width: 10px; color: rgba(255,255,255,.5); cursor: pointer; }
  #surf-cols .cc-nm[data-expand] { cursor: pointer; }
  #surf-cols .sc-kids { padding: 0 0 3px 14px; }
  #surf-cols .sc-pt, #surf-cols .sc-sub { display: grid; grid-template-columns: 1fr auto; gap: 4px; align-items: center; font-size: 10.5px; color: rgba(255,255,255,.75); padding: 1px 2px; border-radius: 4px; }
  #surf-cols .sc-sub { grid-template-columns: 14px 1fr auto; }
  #surf-cols .sc-sub.sc-none { display: block; font-style: italic; color: rgba(255,255,255,.4); padding-left: 20px; }
  #surf-cols .sc-feat { cursor: pointer; user-select: none; }
  #surf-cols .sc-pt:hover, #surf-cols .sc-sub:hover { background: rgba(255,255,255,.06); }
  #surf-cols .sc-pt span:first-child, #surf-cols .sc-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  #surf-cols .sc-nm[data-expand] { cursor: pointer; }
  #surf-cols .sc-nm small { color: rgba(255,255,255,.4); }
  #surf-cols .sc-ic { text-align: center; }
  #surf-cols .pjs-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 3px; vertical-align: 0; }
  #surf-cols .sc-pt:hover .cc-tools, #surf-cols .sc-sub:hover .cc-tools { opacity: 1; }
  #surf-cols .sc-sub .cc-eye { width: 11px; height: 11px; }
  /* rows share the look of 🕳 Caves (cave_columns.js) */
  #surf-cols .cc-head { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 2px 0 4px; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  #surf-cols .cc-hp { color: #6fd39a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; } #surf-cols .cc-hm { color: #8ab4ec; padding: 0 4px; }
  #surf-cols .cc-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 52vh; overflow-y: auto; }
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
  .sc-extra { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 10.5px; color: rgba(255,255,255,.65); margin: 0 0 8px; }
  .sc-extra label { display: inline-flex; gap: 4px; align-items: center; margin: 0; cursor: pointer; }
  .sc-extra input { margin: 0; }
  .sc-extra a { color: #8ab4ec; }
  .sc-extra .sc-sep { opacity: .4; }
  /* The old lists: the columns show these now. */
  #lp-poi-list, #lp-data-list { display: none !important; }`;
  document.head.appendChild(style);

  window._surfCols = { labels: on => (on === undefined ? LB : setLabels(on)), render: async () => { while (busy) await new Promise(r => setTimeout(r, 20)); last = ''; return render(); }, refresh: () => soon(true), master: on => (on === undefined ? !MS.off : setMaster(on)) };
})();
