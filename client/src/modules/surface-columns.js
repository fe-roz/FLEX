// surface-columns.js — 📍 Surface as two columns, like 🕳 Caves: the open
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
// (project-workspace.js). ▸ opens a row in place: a project folder shows its
// folders and features (click: highlight, double-click: fly there, ✏️ edit),
// the CalTopo map and data files show their own folders.
//
// CalTopo features in no folder are listed under Markers / Lines / Polygons,
// as CalTopo lists them (flex.js hangs them under 'ctf-_markers' …; nothing is
// written to CalTopo). Every folder row has a display button (names, colour,
// line width, symbol, opacity for everything inside: folder-style.js).
// Marks: CalTopo rows show their edit state (waiting, conflict, changed,
// failed: _ctWrite.status); project points, lines and areas the loaded
// CalTopo map doesn't have say "not in CalTopo" (caltopo-match.js). The CalTopo
// map row has the "changed since you last looked" button (also a dot on the
// 📍 rail button): the list of what was added, changed or removed in CalTopo,
// and the edits waiting for CalTopo, with their conflicts.
//
// Every item and folder row has a ⋯ menu (row-menu.js: info, edit, rename,
// colour, label, move, fly to, delete; a folder's display, names, rename, new
// subfolder, move, delete); a feature's ✏️ opens the shared editor
// (feature-editor.js), as ⋯ → Edit and the info panel do.
// Row attributes (for a row's ⋯ menu): an item row has data-rkey, a folder row
// data-fkey, and each has a .cc-tools span to put buttons in.
//   data-rkey   f:<project feature id> · my:<My data point id> · ct-<CalTopo feature id>
//               · e:<data file url>#<entity id>
//   data-fkey   a folder-style.js key: project:<group id> · project: (not in a folder)
//               · mydata:<group id> · caltopo:<folder id> · caltopo: (the map)
//               · file:<url>|<path> · file:<url>| (the file)
//
// window._surfCols.reveal(key, { open }) → true when the row is shown: opens
// the pane first with open: true, opens the folders above the item (and the
// folder itself when the key is a folder), scrolls the row into view and
// flashes it (class row-flash, 1.8 s). key is any of:
//   'ct-<fid>'  'ctf-<fid>'                 a CalTopo feature / folder (also _markers, _lines, _polygons)
//   'f:<id>'  'g:<group id>'  'my:<id>'     a project feature / project folder / My data point
//   '<project feature id>' '<My data point id>'   bare ids also work
//   'e:<data file url>#<entity id>'         a data file's feature or folder
//   'project:…' 'mydata:…' 'caltopo:…' 'file:…'   a folder key, as above
//   a Cesium entity (drawn by any of these)
//   { source: 'project'|'mydata'|'caltopo'|'file', id, folder, entityId, url }   (the info
//     panel's form: id null with a folder reveals the folder; file folders by entity id)
(function () {
  'use strict';
  const host = document.getElementById('surf-cols');
  if (!host) return;
  const ws = () => window._ws, PW = () => window._pjWs, PJ = () => window._pj || {}, MD = () => window._myData, PF = () => window._pjf;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const V = () => window.cesiumViewer;
  const open = new Set();                      // expanded rows: point groups, 'o:<source url>' and its folders
  const fOpen = () => ((window._pjfState || {}).open || {});   // project folders: shared with project-features.js
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
    if (MD() && MD().shapeDs && MD().shapeDs()) MD().shapeDs().entities.values.forEach(e => out.push(e));
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
  setInterval(() => { if (MS.off) applyMaster(); try { applyMyHidden(); } catch (_) {} }, 1000);

  // ── Labels on/off: names of project features, CalTopo and data-file
  // features (project-features.js draws those) and your points (flex.js,
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
  const shapeEnts = ids => { const M = MD(); return M && M.shapeEntity ? [...ids].map(i => M.shapeEntity(i)).filter(Boolean) : []; };
  const pointEntities = ids => (V() ? V().entities.values.filter(e => e.properties && e.properties.myFeature && ids.has(e.properties.myFeature.getValue())) : []);
  const srcOf = url => (ws() ? ws().vectorSources().find(s => (s.url || s.name) === url) : null);

  // A CalTopo map's id (…/m/<id>), so two spellings of the same link match.
  const mapId = u => (String(u || '').match(/\/m\/([A-Za-z0-9]+)/) || [])[1] || null;
  const nItems = ds => (ds._ctCount != null ? ds._ctCount : ds.entities.values.length);
  const sameMap = (a, b) => { const x = mapId(a), y = mapId(b); return x && y ? x === y : String(a || '') === String(b || ''); };
  // CalTopo maps by their names: the project's record (renamed or first known), a rename kept on this computer
  // (My data), the key's map list (/api/caltopo/maps), the title the pulled map carries, else the map id.
  const CTN = { list: null, at: 0, busy: false, ok: false, tried: new Set() };
  function ctMaps() {
    if (!CTN.busy && Date.now() - CTN.at > (CTN.ok ? 600000 : 60000)) {
      CTN.busy = true; CTN.at = Date.now();
      fetch('/api/caltopo/maps').then(r => (r.ok ? r.json() : null)).then(j => { CTN.ok = !!(j && Array.isArray(j.maps)); if (CTN.ok) { CTN.list = j.maps; last = ''; soon(); } })
        .catch(() => {}).finally(() => { CTN.busy = false; });
    }
    return CTN.list;
  }
  const ctLocal = () => { try { return JSON.parse(localStorage.getItem('flex.ct.names') || '{}'); } catch (_) { return {}; } };
  const GENERIC = 'CalTopo map';
  /** The name known from CalTopo (list, then the pulled map's title), or ''. */
  function ctKnown(url, src) {
    const id = mapId(url), m = id && (ctMaps() || []).find(x => x.id === id);
    return (m && m.title) || (src && src.ds && src.ds._ctTitle) || '';
  }
  function ctName(url, rec, src, local) {
    if (rec && rec.name && rec.name !== GENERIC) return rec.name;
    const id = mapId(url);
    return (local && id && ctLocal()[id]) || ctKnown(url, src) || id || GENERIC;
  }
  let MODEL = null;
  async function model() {
    const M = await model0(); MODEL = M; return M;
  }
  async function model0() {
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
    const pts = Object.values(S.features || {}).filter(f => !f.removed && (f.kind === 'point' || f.kind === 'line' || f.kind === 'area') && (f.kind === 'point' || (f.coords && f.coords.length >= 2)));
    const byGroup = new Map();
    pts.forEach(f => { const g = f.group || ''; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(f); });
    [...byGroup.entries()].sort((a, b) => String((S.groups[b[0]] || {}).name || '').localeCompare(String((S.groups[a[0]] || {}).name || '')))
      .forEach(([gid, list]) => {
        const name = (S.groups[gid] || {}).name || 'Points';
        const ids = new Set(list.map(f => f.id)), ents = pointEntities(ids).concat(shapeEnts(ids));
        const nPt = list.filter(f => f.kind === 'point').length;
        const x = { kind: 'pgroup', id: gid, name, n: list.length, nPt, shown: ents.some(own), points: list, dir: moving('pgroup', gid) };
        (x.dir === 'in' ? L : R).push(x);
      });
    Object.values(S.layers || {}).filter(l => l.kind === 'file' && !l.removed && (l.url || l.blob)).forEach(l => {
      const url = blobUrl(l), f = loaded.get(url);
      const x = { kind: 'file', id: l.id, name: l.name || url, url, loaded: !!f, shown: !!(f && f.show), items: f ? f.items : 0, dir: moving('file', l.id) };
      (x.dir === 'in' ? L : R).push(x);
    });
    NICT = null;
    if (isOpen) {
      const FL = window.FlexLib;
      const ct = (FL.liveLayers(pj.P) || []).filter(l => l.kind === 'caltopo');
      const now = w.caltopo(), src = w.vectorSources().find(s => s.kind === 'caltopo');
      const isNow = l => !!(now && sameMap(now.url, l.url));        // the same map, however its link is written
      ct.forEach(l => {
        const sr = src && isNow(l) ? src : null, known = ctKnown(l.url, sr), dir = moving('caltopo', l.id);
        // First known name: kept on the project's layer record, so it travels with the project.
        if (known && (!l.name || l.name === GENERIC) && !CTN.tried.has(l.id) && !pj.readonly && window._pjApi) { CTN.tried.add(l.id); Promise.resolve(window._pjApi.record('layer.set', { layer: l.id, name: known })).catch(e => console.warn('[surface] name', e)); }
        const x = { kind: 'caltopo', id: l.id, name: ctName(l.url, l, sr), url: l.url, interval: l.interval, loaded: isNow(l), inProject: true, dir,
          shown: !!(src && own(src.ds) && isNow(l)), items: src ? nItems(src.ds) : 0, src: sr };
        (dir === 'out' ? R : L).unshift(x);
      });
      // A CalTopo map loaded that the project doesn't have: yours (My data), ← puts it in the project.
      if (src && now && !ct.some(isNow)) R.unshift({ kind: 'caltopo', id: 'ct', name: ctName(now.url, null, src, true), url: now.url, interval: now.interval, loaded: true, shown: own(src.ds), items: nItems(src.ds), src, mine: true });
      const h = PF() ? PF().hidden() : {};
      const feats = FL.liveFeatures(pj.P), groups = FL.liveGroups(pj.P);
      NICT = notInCt(pj.P);
      groups.filter(g => !g.parent).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })).forEach(g => {
        const n = feats.filter(f => FL.groupPath(pj.P, f.group).some(x => x.id === g.id)).length;
        const nict = NICT ? feats.filter(f => NICT.has(f.id) && FL.groupPath(pj.P, f.group).some(x => x.id === g.id)).length : 0;
        L.push({ kind: 'folder', id: g.id, name: g.name || 'Folder', n, nict, shown: !h['root'] && !h['g:' + g.id] });
      });
      const loose = feats.filter(f => !f.group).length;
      if (loose) L.push({ kind: 'loose', id: '', name: 'Not in a folder', n: loose, nict: NICT ? feats.filter(f => !f.group && NICT.has(f.id)).length : 0, shown: !h['root'] });
      (FL.liveLayers(pj.P) || []).filter(l => l.kind === 'file').forEach(l => {
        const f = loaded.get(l.url);
        const x = { kind: 'file', id: l.id, name: l.name || l.url, url: l.url, loaded: !!f, shown: !!(f && f.show), items: f ? f.items : 0, inProject: true, dir: moving('file', l.id) };
        (x.dir === 'out' ? R : L).push(x);
      });
    } else {
      // No project: a CalTopo map loaded on its own is still listed (in My data).
      const src = w.vectorSources().find(s => s.kind === 'caltopo');
      if (src) R.unshift({ kind: 'caltopo', id: 'ct', name: ctName(src.url, null, src, true), url: src.url, loaded: true, shown: own(src.ds), items: nItems(src.ds), src });
    }
    [...L, ...R].forEach(x => { if (x.kind === 'file' && x.loaded) x.src = srcOf(x.url); });
    return { isOpen, L, R };
  }

  // ── Marks ────────────────────────────────────────────────────────────────
  // Project features with no match in the loaded CalTopo map (ids), or null
  // with no CalTopo map loaded.
  let NICT = null;
  function notInCt(P) {
    const src = ctSrc(), M = window._ctMatch;
    if (!src || !M || !P) return null;
    try { return window._ctSend ? window._ctSend.notInIds(P, src) : new Set(M.unmatched(P, src).map(f => f.id)); } catch (e) { console.warn('[surface] match', e); return null; }
  }
  const NICT_TIP = 'Not in the CalTopo map: it has no point, line or area of the same kind and name within 15 m';
  const nictMark = () => `<b class="sc-st sc-nict" title="${NICT_TIP}">not in CalTopo</b>`;
  // A CalTopo feature's edit state (caltopo-write.js).
  const CW = () => window._ctWrite;
  const ctStatus = id => { const W = CW(); if (!W || !W.status || !/^ct-/.test(String(id || ''))) return null; try { return W.status(id); } catch (_) { return null; } };
  const ST = { waiting: ['waiting', 'Your edit is waiting to go to CalTopo'], conflict: ['conflict', 'Changed in CalTopo while your edit waited: open the list (CalTopo map row) to choose'],
    changed: ['changed', 'Changed in CalTopo since you last looked'], failed: ['failed', 'Your edit could not be sent to CalTopo'] };
  const stMark = st => (st && ST[st] ? `<b class="sc-st sc-st-${st}" title="${ST[st][1]}">${ST[st][0]}</b>` : '');
  /** The folder-style.js key of a top row. */
  function fkeyOf(x) {
    if (x.kind === 'folder') return 'project:' + x.id;
    if (x.kind === 'loose') return 'project:';
    if (x.kind === 'pgroup') return 'mydata:' + x.id;
    if (x.kind === 'caltopo' && x.src) return 'caltopo:';
    if (x.kind === 'file' && x.src) return 'file:' + x.url + '|';
    return null;
  }
  const fsSet = k => { try { return Object.keys(window._folderStyle.get(k) || {}).filter(f => !(f === 'color' && /^project:./.test(k))).length > 0; } catch (_) { return false; } };
  const fsBtn = k => (k && window._folderStyle ? `<button type="button" class="sc-fs${fsSet(k) ? ' sc-fs-on' : ''}" data-fstyle="${esc(k)}" title="Display: names, colour, line width, symbol, opacity for everything inside">${window.icon ? window.icon('palette', 13) : '🎨'}</button>` : '');
  // A row's ⋯ menu (row-menu.js): the row's data-rkey / data-fkey says what for.
  const moreBtn = () => `<button type="button" class="sc-more" data-rmenu aria-haspopup="menu" title="More: info, edit, rename, move, delete…">${window.icon ? window.icon('more', 13) : '⋯'}</button>`;
  // CalTopo: what changed since you last looked, and edits waiting.
  function ctNews() {
    const W = CW();
    if (!W || !W.available || !W.available()) return null;
    let ch = [], pend = [], seen = 0;
    try { ch = W.changes() || []; pend = W.pending() || []; seen = W.seen() || 0; } catch (_) {}
    const fresh = ch.filter(c => (c.at || 0) > seen).length;
    const conflicts = pend.filter(p => p.state === 'conflict').length;
    return { ch, pend, seen, fresh, conflicts };
  }
  function ctNewsBtn() {
    const N = ctNews();
    if (!N || (!N.ch.length && !N.pend.length)) return '';
    const bits = [];
    if (N.fresh) bits.push(N.fresh + ' new');
    if (N.pend.length) bits.push(N.pend.length + ' waiting');
    const hot = N.fresh || N.conflicts;
    return `<button type="button" class="sc-news${hot ? ' sc-hot' : ''}" data-ctnews title="What changed in CalTopo since you last looked, and your edits waiting for CalTopo">${window.icon ? window.icon('refresh', 13) : '⟳'}${bits.length ? '<span>' + esc(bits.join(' · ')) + '</span>' : ''}</button>`;
  }
  function railMark() {
    const b = document.querySelector('#flex-rail [data-target="#featuresCollapsible"]'); if (!b) return;
    const N = ctNews(), hot = !!(N && (N.fresh || N.conflicts));
    let d = b.querySelector('.sc-rail-dot');
    if (hot && !d) { d = document.createElement('b'); d.className = 'sc-rail-dot'; b.appendChild(d); }
    if (!hot && d) { d.remove(); d = null; }       // (N is null once the map is cleared)
    if (d) d.title = N.fresh ? `${N.fresh} change${N.fresh === 1 ? '' : 's'} in CalTopo since you last looked` : `${N.conflicts} edit${N.conflicts === 1 ? '' : 's'} in conflict with CalTopo`;
    b.classList.toggle('sc-has-news', hot);
  }

  // Features / folders waiting to move to My data (queued until 💾 Save, project-workspace.js): 'moving to My data'.
  const WAIT = 'moving to My data';
  const queued = () => ((window._pjWsState && window._pjWsState.moves) || []).filter(m => m.kind === 'feats').map(m => m.id);
  function featWaits(f) {
    const q = queued(); if (!q.length) return false;
    if (q.includes('f:' + f.id)) return true;
    if (!f.group) return q.includes('loose');
    const P = PJ().P, FL = window.FlexLib;
    return !!P && FL.groupPath(P, f.group).some(g => q.includes('g:' + g.id));
  }
  function folderWaits(gid) {
    const q = queued(); if (!q.length) return false;
    const P = PJ().P, FL = window.FlexLib;
    return !!P && FL.groupPath(P, gid).some(g => q.includes('g:' + g.id));
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
    if (!x.dir && (x.kind === 'folder' ? folderWaits(x.id) : x.kind === 'loose' && queued().includes('loose'))) x.wait = true;
    const sub = x.wait ? WAIT : x.dir ? (x.dir === 'in' ? 'moving into the project' : x.dir === 'remove' ? 'leaving the project' : 'moving to My data')
      : x.kind === 'file' ? (x.loaded ? (x.items ? x.items + ' items' : 'loaded') : 'not loaded')
      : x.kind === 'caltopo' ? (x.loaded ? x.items + ' items' : 'not loaded')
      : (x.n != null ? x.n + (x.kind === 'pgroup' ? (x.nPt === x.n ? ' point' : ' item') + (x.n === 1 ? '' : 's') : '') : '');
    const canMove = isOpen && (x.kind === 'pgroup' || x.kind === 'file' || (x.kind === 'caltopo' && (x.mine || x.dir)));
    const arrow = !canMove ? '' : side === 'p'
      ? (x.kind === 'pgroup' && x.dir !== 'in' ? '' : `<button type="button" class="cc-mv" data-mv="out" title="${x.dir === 'in' ? 'Back to My data (cancel the move)' : 'Move to My data'}">→</button>`)
      : `<button type="button" class="cc-mv" data-mv="in" title="${x.dir === 'out' ? 'Back into the project (cancel the move)' : 'Move into the project'}">←</button>`;
    const eyeOn = x.kind === 'file' || x.kind === 'caltopo' ? x.loaded && x.shown : x.shown;
    const eyeHalf = x.kind === 'file' || x.kind === 'caltopo' ? x.loaded && !x.shown : !x.shown;   // points and folders are always loaded
    const k = !x.dir && expKey(x), exp = k && isExp(k);
    const forget = side === 'm' && !x.dir && (x.kind === 'file') ? '<button type="button" data-forget title="Forget: out of My data (unloads it)">✕</button>' : '';
    const ftools = x.kind === 'folder' ? `<button type="button" data-gadd="${esc(x.id)}" title="Add to this folder">＋</button><button type="button" data-gdl="${esc(x.id)}" title="Download for CalTopo">⇩</button><button type="button" data-gedit="${esc(x.id)}" title="Rename, colour, move">✏️</button>` : '';
    const fk = !x.dir && fkeyOf(x);
    const marks = (x.nict ? `<b class="sc-st sc-nict" title="${NICT_TIP}">${x.nict} not in CalTopo</b>` : '') + (x.kind === 'caltopo' && x.src ? ctNewsBtn() : '');
    let html = `<div class="cc-it${x.dir || x.wait ? ' cc-moving' : ''}" data-kind="${x.kind}" data-id="${esc(x.id)}"${fk ? ` data-fkey="${esc(fk)}"` : ''} draggable="${canMove ? 'true' : 'false'}">
      <button type="button" class="cc-eye ui-eye${eyeOn ? ' on' : eyeHalf ? ' half' : ''}" data-eye title="${(x.kind === 'file' || x.kind === 'caltopo') && !x.loaded ? 'Load' : eyeOn ? 'Hide' : 'Show'}"></button>
      <span class="cc-nm" title="${esc(x.name)}"${k ? ` data-expand="${esc(k)}"` : ''}>${k ? arrowOf(k, exp) : '<span class="sc-arrow"></span>'}${icon[x.kind] || ''} ${esc(x.name)}${x.dir || x.wait ? '<b class="cc-dot" title="Waiting: 💾 Save puts it in">•</b>' : ''}<small>${esc(sub)}${marks}</small></span>
      <span class="cc-tools">${ftools}${fsBtn(fk)}${forget}${arrow}${fk ? moreBtn() : ''}</span></div>`;
    if (exp) html += `<div class="sc-kids">${kids(x, isOpen)}</div>`;
    return html;
  }
  // My data items hidden one by one: 'm:<id>' in the same store as folders and project features (_pjf.hidden).
  const setOwn = (o, v) => { if (MS.saved.has(o)) MS.saved.set(o, v); else o.show = v; };
  function applyMyHidden() {
    const P = PF(); if (!P) return;
    const ids = new Set(Object.keys(P.hidden()).filter(k => k.startsWith('m:')).map(k => k.slice(2)));
    if (!ids.size) return;
    pointEntities(ids).concat(shapeEnts(ids)).forEach(e => { if (own(e)) setOwn(e, false); });
  }
  function toggleMy(id, to) {
    const P = PF(); if (!P) return;
    const hide = to === undefined ? !P.hidden()['m:' + id] : to;
    P.setHidden('m:' + id, hide);
    pointEntities(new Set([id])).concat(shapeEnts([id])).forEach(e => setOwn(e, !hide));
    const v = V(); if (v && v.scene.requestRender) v.scene.requestRender();
    last = ''; soon();
  }
  const shapeShown = id => { const e = shapeEnts([id])[0]; return !!e && own(e); };
  function kids(x, isOpen) {
    const mh = (PF() ? PF().hidden() : {}), myEye = (f, a) => `<button type="button" class="cc-eye ui-eye ui-eye-sm${mh['m:' + f.id] ? ' half' : ' on'}" ${a} title="${mh['m:' + f.id] ? 'Show' : 'Hide'}"></button>`;
    if (x.kind === 'pgroup') return x.points.map(f => f.kind !== 'point' ? `<div class="sc-pt sc-wide sc-shape" data-pt="${esc(f.id)}" data-shape="1" data-rkey="my:${esc(f.id)}">${myEye(f, 'data-shpeye')}<span title="${esc(f.name)}">${fIcon[f.kind]} ${esc(f.name || (f.kind === 'area' ? 'Area' : 'Line'))}</span>
        <span class="cc-tools">${moreBtn()}</span></div>` : `<div class="sc-pt sc-wide" data-pt="${esc(f.id)}" data-rkey="my:${esc(f.id)}">${myEye(f, 'data-pteye')}<span title="${esc(f.name)}">${esc(f.name || 'Point')}</span>
        <span class="cc-tools"><button type="button" data-ptfly title="Fly to">⌖</button>${isOpen ? '<button type="button" class="cc-mv" data-ptin title="Move this point into the project">←</button>' : ''}<button type="button" data-ptdel title="Delete the point">✕</button>${moreBtn()}</span></div>`).join('');
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
      const nict = NICT ? FL.liveFeatures(pj.P).filter(f => NICT.has(f.id) && FL.groupPath(pj.P, f.group).some(y => y.id === g.id)).length : 0;
      const fw = folderWaits(g.id);
      out += `<div class="sc-sub sc-fold${fw ? ' cc-moving' : ''}" data-fkey="project:${esc(g.id)}" ${pad(depth)}${fw ? ` title="${WAIT}: 💾 Save puts it in"` : ''}><button type="button" class="cc-eye ui-eye ui-eye-sm${h[k] ? ' half' : ' on'}" data-geye="${esc(g.id)}" title="${h[k] ? 'Show' : 'Hide'}"></button>
        <span class="sc-nm" data-expand="${esc(k)}">${arrowOf(k, exp)}<span class="pjs-sw" style="background:${esc(P.groupColor(g.id))}"></span>📁 ${esc(g.name)} <small>${fw ? WAIT : n}</small>${nict ? ` <b class="sc-st sc-nict" title="${NICT_TIP}">${nict} not in CalTopo</b>` : ''}</span>
        <span class="cc-tools"><button type="button" data-gadd="${esc(g.id)}" title="Add to this folder">＋</button><button type="button" data-gdl="${esc(g.id)}" title="Download for CalTopo">⇩</button><button type="button" data-gedit="${esc(g.id)}" title="Rename, colour, move">✏️</button>${fsBtn('project:' + g.id)}${moreBtn()}</span></div>`;
      if (exp) out += projectTree(g.id, depth + 1);
    });
    FL.liveFeatures(pj.P).filter(f => (f.group || null) === (gid || null)).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })).forEach(f => {
      const fm = featWaits(f);
      out += `<div class="sc-sub sc-feat${NICT && NICT.has(f.id) ? ' sc-is-nict' + (window._ctSend && window._ctSend.hlOn() ? ' sc-hl' : '') : ''}${fm ? ' cc-moving' : ''}" data-feat="${esc(f.id)}" data-rkey="f:${esc(f.id)}" ${pad(depth)} title="Click: highlight · double-click: fly there"><button type="button" class="cc-eye ui-eye ui-eye-sm${h['f:' + f.id] ? ' half' : ' on'}" data-feye="${esc(f.id)}" title="${h['f:' + f.id] ? 'Show' : 'Hide'}"></button>
        <span class="sc-nm"><span class="sc-ic" style="color:${esc(P.colorOf(f))}">${fIcon[f.kind] || '•'}</span> ${esc(f.name || '(no name)')}${FL.flexTag(f.desc) ? ' <small>🕳</small>' : ''}${fm ? ` <small class="sc-wait">${WAIT}</small>` : ''}${NICT && NICT.has(f.id) ? ' ' + nictMark() : ''}</span>
        <span class="cc-tools"><button type="button" data-fedit="${esc(f.id)}" title="Edit">✏️</button>${moreBtn()}</span></div>`;
    });
    return out || '<div class="sc-sub sc-none">empty</div>';
  }
  /** A CalTopo map's or a data file's own folders and items. */
  const FORCE = new Set();                     // entity ids revealed: listed even past the first 200
  function overlayTree(src) {
    const P = PF(); if (!P) return '';
    const tree = P.overlayTree(src), h = P.hidden();
    const base = 'o:' + (src.url || src.name), isCt = src.kind === 'caltopo';
    // CalTopo states inside each folder (a closed folder still shows there is something).
    const stIn = new Map();
    if (isCt && CW()) src.ds.entities.values.forEach(e => {
      const st = ctStatus(e.id); if (!st) return;
      for (let a = e.parent, n = 0; a && n < 50; a = a.parent, n++) stIn.set(a, (stIn.get(a) || 0) + 1);
    });
    let out = '';
    const visit = (parent, path, depth) => {
      const list = tree.get(parent) || [];
      const folders = list.filter(e => tree.has(e)), leaves = list.filter(e => !tree.has(e));
      folders.forEach(e => {
        const p = path + '/' + (e.name || e.id), key = base + '|' + p, hk = P.srcKey(src, p), exp = open.has(key);
        const fk = isCt ? 'caltopo:' + (/^ctf-/.test(e.id) ? e.id.slice(4) : e.id) : 'file:' + src.url + '|' + p;
        const nst = stIn.get(e) || 0;
        ov.set(hk, e);
        out += `<div class="sc-sub sc-fold${e._ctLoose ? ' sc-loose' : ''}" data-hk="${esc(hk)}" data-fkey="${esc(fk)}" style="padding-left:${4 + depth * 12}px"><button type="button" class="cc-eye ui-eye ui-eye-sm${h[hk] ? ' half' : ' on'}" data-oeye="${esc(hk)}" title="${h[hk] ? 'Show' : 'Hide'}"></button>
          <span class="sc-nm" data-expand="${esc(key)}"${e._ctLoose ? ' title="Not in a CalTopo folder (listed as CalTopo lists them)"' : ''}>${arrowOf(key, exp)}📁 ${esc(e.name || '(folder)')} <small>${(tree.get(e) || []).length}</small>${nst ? ` <b class="sc-st sc-st-in" title="${nst} inside waiting, in conflict, changed or not sent">${nst}</b>` : ''}</span>
          <span class="cc-tools">${fsBtn(fk)}${moreBtn()}</span></div>`;
        if (exp) visit(e, p, depth + 1);
      });
      const shown = leaves.length > 200 ? leaves.filter((e, i) => i < 200 || FORCE.has(e.id)) : leaves;
      shown.forEach(e => {
        const p = path + '/' + (e.name || e.id), hk = P.srcKey(src, p);
        ov.set(hk, e);
        const rk = isCt && /^ct-/.test(e.id) ? e.id : 'e:' + (src.url || src.name) + '#' + e.id;
        out += `<div class="sc-sub sc-feat" data-ov="${esc(hk)}" data-hk="${esc(hk)}" data-rkey="${esc(rk)}" style="padding-left:${4 + depth * 12}px" title="Click: highlight · double-click: fly there"><button type="button" class="cc-eye ui-eye ui-eye-sm${h[hk] ? ' half' : ' on'}" data-oeye="${esc(hk)}" title="${h[hk] ? 'Show' : 'Hide'}"></button>
          <span class="sc-nm">${esc(e.name || '(no name)')}${isCt ? stMark(ctStatus(e.id)) : ''}</span><span class="cc-tools">${moreBtn()}</span></div>`;
      });
      if (leaves.length > shown.length) out += `<div class="sc-sub sc-none" style="padding-left:${4 + depth * 12}px">… and ${leaves.length - shown.length} more</div>`;
    };
    visit(null, '', 0);
    return out || '<div class="sc-sub sc-none">no folders</div>';
  }

  // The CalTopo map loaded now (it is the source of truth when connected).
  const ctSrc = () => { const w = ws(); return (w && w.vectorSources && w.vectorSources().find(s => s.kind === 'caltopo')) || null; };
  // ⧉ Duplicates of CalTopo: the project's features that the loaded CalTopo
  // map already has (caltopo-match.js: same kind and name, within 15 m), ticked
  // to remove from the project. Removing is a feature.set with removed: true,
  // so 📁 History can undo it.
  async function dupsDialog() {
    const A = window._pjApi, pj = PJ(), M = window._ctMatch, src = ctSrc();
    if (!A || !pj.P || !M) return;
    if (!src) { A.toast('Load the project’s CalTopo map first'); return; }
    const list = M.duplicates(pj.P, src);
    if (!list.length) { await A.dialog({ title: 'Duplicates of CalTopo', text: 'None of the project’s features is also in the CalTopo map.' }); return; }
    const groups = pj.P.groups || {};
    const kindName = { point: 'Point', line: 'Line', area: 'Area' };
    const body = A.el('div', 'sc-dups');
    body.innerHTML = '<label class="sc-dup sc-dup-all"><input type="checkbox" class="keep-box" data-all checked> All</label>' + list.map((d, i) => {
      const f = d.feature, g = f.group && groups[f.group];
      return `<label class="sc-dup"><input type="checkbox" class="keep-box" data-i="${i}" checked> <b>${esc(f.name || kindName[f.kind] || 'Feature')}</b> <span class="sc-dup-k">${kindName[f.kind] || f.kind}${g ? ' · ' + esc(g.name || '') : ''}</span> <button type="button" data-fly="${i}" title="Fly to it">⌖</button></label>`;
    }).join('');
    body.addEventListener('change', e => { if (e.target.matches('[data-all]')) body.querySelectorAll('[data-i]').forEach(c => { c.checked = e.target.checked; }); });
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-fly]'); if (!b) return; e.preventDefault();
      const d = list[+b.dataset.fly], P = PF(); if (d && P && P.highlight) P.highlight(d.feature, true);
    });
    const r = await A.dialog({ title: `Duplicates of CalTopo (${list.length})`, text: 'These project features are also in the CalTopo map (same name, within 15 m). CalTopo is the source of truth: remove the ticked ones from the project. Undo in 📁 History.',
      body, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Remove ticked from the project', value: 'rm', danger: true }] });
    if (!r || r.button !== 'rm') return;
    const pick = [...body.querySelectorAll('[data-i]')].filter(c => c.checked).map(c => list[+c.dataset.i].feature);
    let n = 0;
    for (const f of pick) { if (await A.record('feature.set', { feature: f.id, removed: true }, undefined, { quiet: true })) n++; }
    if (n && A.refresh) A.refresh('feature.set');          // quiet records skip the replay: once for all
    A.toast(n ? `Removed ${n} duplicate${n > 1 ? 's' : ''} from the project (undo in 📁 History)` : 'Nothing removed');
    last = ''; render();
  }

  function bar(isOpen) {
    const on = !MS.off;
    const tools = isOpen
      ? `<button type="button" data-draw="point" title="Draw a point in the project">＋ Point</button><button type="button" data-draw="line" title="Draw a line">＋ Line</button><button type="button" data-draw="area" title="Draw an area">＋ Area</button><button type="button" data-tool="folder" title="A new folder">＋ Folder</button><button type="button" data-tool="import" title="GPX / KML / KMZ / GeoJSON into the project's features">⇪ Import</button><button type="button" data-tool="download" title="All the project's features, for CalTopo">⇩ Download</button><button type="button" data-tool="file" title="Show a KMZ / GeoJSON / GPX file as it is (a data file)">📄 Add file</button>${NICT && NICT.size && window._ctSend ? `<button type="button" data-tool="ctsend" title="Add the items that are not in the CalTopo map to it (you see the list first)">⇪ Send ${NICT.size} to CalTopo</button>` : ''}${ctSrc() && window._ctMatch ? '<button type="button" data-tool="dups" title="The project’s features that the loaded CalTopo map already has (same name, within 15 m)">⧉ Duplicates of CalTopo</button>' : ''}`
      : `<button type="button" data-tool="file" title="Show a KMZ / GeoJSON / GPX file">📄 Add KMZ / GeoJSON / GPX</button>`;
    const lab = labelsOn();
    return `<div class="sc-bar"><button type="button" class="sc-master${on ? ' on' : ''}" data-master role="switch" aria-checked="${!!on}" title="${on ? 'Hide every feature on the surface (each keeps its own setting)' : 'Show the features again, as each was set'}"><span class="ui-sw ui-sw-sm"></span>Show features</button><button type="button" class="sc-master sc-lab${lab ? ' on' : ''}" data-labels role="switch" aria-checked="${!!lab}" title="${lab ? 'Hide the names on the map' : 'Show the names on the map'}"><span class="ui-sw ui-sw-sm"></span>Labels</button><span class="sc-tools">${tools}</span></div>${isOpen && window._ctSend && (window._ctSend.hlSync(), window._ctSend.reminder()) ? window._ctSend.reminder().html : ''}`;
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
      flashNow(); syncSel();
      railMark();
    } catch (e) { console.warn('[surface] render', e); }
    finally { busy = false; if (again) { again = false; setTimeout(render, 0); } }
  }
  const soon = (force) => { if (force) my = null; setTimeout(render, 30); };

  // ── CalTopo: changed since you last looked, edits waiting ────────────────
  const WHAT = { added: 'added', changed: 'changed', removed: 'removed' };
  const ago = t => { if (!t) return ''; const d = (Date.now() - t) / 1000; return d < 60 ? 'just now' : d < 3600 ? Math.round(d / 60) + ' min ago' : d < 86400 ? Math.round(d / 3600) + ' h ago' : new Date(t).toLocaleString(); };
  async function newsPop(anchor) {
    const old = document.getElementById('sc-news-pop'); if (old) { old.remove(); return; }
    const W = CW(), N = ctNews(); if (!W || !N) return;
    const seenAt = N.seen;
    const m = document.createElement('div'); m.id = 'sc-news-pop'; m.className = 'cc-pop sc-news-pop';
    const list = N.ch.slice(0, 200);
    const chHtml = list.length ? list.map((c, i) => `<button type="button" class="sc-ch${(c.at || 0) > seenAt ? ' sc-ch-new' : ''}" data-chg="${i}" ${c.what === 'removed' ? 'disabled title="Removed from CalTopo"' : 'title="Show it in the list and on the map"'}>
        <b class="sc-ch-w sc-ch-${esc(c.what)}">${esc(WHAT[c.what] || c.what)}</b><span class="sc-ch-t">${esc(c.title || c.fid)}</span><small>${esc(ago(c.at))}</small></button>`).join('')
      : '<div class="sc-ch-none">Nothing changed in CalTopo yet.</div>';
    const ST_WORD = { waiting: 'waiting', conflict: 'conflict', failed: 'not sent' };
    const pHtml = N.pend.map((q, i) => `<div class="sc-pq sc-pq-${esc(q.state)}"><b>${esc(ST_WORD[q.state] || q.state)}</b><span class="sc-ch-t" title="${esc(q.error || '')}">${esc(q.title || q.fid)}${q.what ? ' <small>' + esc(q.what) + '</small>' : ''}</span>
        ${q.state === 'conflict' ? `<button type="button" data-pconf="${i}" title="See both versions and choose">Open</button>` : `<button type="button" data-pretry title="Send the waiting edits now">Send now</button>`}</div>`).join('');
    m.innerHTML = `<div class="cc-pop-t">CalTopo map: changes${N.fresh ? ` (${N.fresh} new)` : ''}</div><div class="sc-ch-list">${chHtml}</div>`
      + (N.pend.length ? `<div class="cc-pop-t sc-pq-h">Your edits waiting for CalTopo</div>${pHtml}` : '');
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 10)) + 'px';
    m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 10)) + 'px';
    const close = () => { m.remove(); document.removeEventListener('mousedown', off, true); };
    const off = e => { if (!m.isConnected) { document.removeEventListener('mousedown', off, true); return; } if (!m.contains(e.target) && !e.target.closest('[data-ctnews]')) close(); };
    setTimeout(() => document.addEventListener('mousedown', off, true), 0);
    m.addEventListener('click', async e => {
      const c = e.target.closest('[data-chg]');
      if (c) { const x = list[+c.dataset.chg]; if (x && x.what !== 'removed') { await reveal('ct-' + x.fid); const ent = entityOfKey('ct-' + x.fid); const P = PF(); if (ent && P) { const g = P.entCoords(ent.e); if (g) P.highlight(Object.assign(g, { key: 'e:' + ent.e.id }), true); } } return; }
      const pc = e.target.closest('[data-pconf]'); if (pc) { const q = N.pend[+pc.dataset.pconf]; close(); if (q) await W.showConflict(q.fid); soonNews(); return; }
      if (e.target.closest('[data-pretry]')) { close(); if (W.retry) await W.retry(); soonNews(); }
    });
    // Looked at: the new marks go (the list keeps them highlighted while open).
    if (N.fresh) { try { await W.markSeen(); } catch (_) {} }
    soonNews();
  }
  const soonNews = () => { railMark(); last = ''; soon(); };

  // ── Reveal: open the folders above an item, scroll to it, flash it ───────
  const cssq = x => (window.CSS && CSS.escape ? CSS.escape(String(x)) : String(x).replace(/["\\]/g, '\\$&'));
  /** An overlay entity by a key: { e, src } or null. */
  function entityOfKey(key) {
    const w = ws(); if (!w) return null;
    const srcs = w.vectorSources();
    if (window.Cesium && key instanceof Cesium.Entity) { const src = srcs.find(s => s.ds.entities.getById(key.id) === key); return src ? { e: key, src } : null; }
    key = String(key);
    let m = key.match(/^e:(.*)#([^#]*)$/);
    if (m) { const src = srcs.find(s => (s.url || s.name) === m[1]); const e = src && src.ds.entities.getById(m[2]); return e ? { e, src } : null; }
    if (/^ctf?-/.test(key)) { const src = srcs.find(s => s.kind === 'caltopo'); const e = src && src.ds.entities.getById(key); return e ? { e, src } : null; }
    return null;
  }
  /** What to open and which row to look for. */
  function target(key) {
    const pj = PJ(), FL = window.FlexLib, P = pj.P, w = ws();
    if (key == null) return null;
    if (window.Cesium && key instanceof Cesium.Entity) {
      const p = n => { const v = key.properties && key.properties[n]; return v && v.getValue ? v.getValue() : v; };
      if (p('isProjectFeature')) return target('f:' + p('featureId'));
      if (p('myFeature')) return target('my:' + p('myFeature'));
      if (p('myShape')) return target('my:' + p('myShape'));
      const o = entityOfKey(key); return o ? ovTarget(o) : null;
    }
    if (typeof key === 'object') {
      const k = key, id = k.id != null && k.id !== '' ? String(k.id) : null;
      if (k.source === 'project') return id ? target('f:' + id) : k.folder ? target('g:' + k.folder) : null;
      if (k.source === 'mydata') return id ? target('my:' + id) : k.folder ? target('mydata:' + k.folder) : null;
      if (k.source === 'caltopo') {
        if (k.entityId && entityOfKey(k.entityId)) return target(k.entityId);
        if (id) return target(/^ct-/.test(id) ? id : 'ct-' + id);
        if (k.folder != null) return target(k.folder ? 'ctf-' + String(k.folder).replace(/^ctf-/, '') : 'caltopo:');
        return null;
      }
      if (k.source === 'file') {
        const url = k.url || ((w && w.vectorSources().find(s => s.kind === 'file' && (k.entityId || id) && s.ds.entities.getById(k.entityId || id))) || {}).url;
        const eid = k.entityId || id || k.folder;
        return url && eid ? target('e:' + url + '#' + eid) : url ? target('file:' + url + '|') : null;
      }
      return null;
    }
    key = String(key);
    if (/^ctf?-|^e:/.test(key)) { const o = entityOfKey(key); return o ? ovTarget(o) : null; }
    if (/^caltopo:$/.test(key)) { const src = ctSrc(); return src ? { exp: [], sel: '[data-fkey="caltopo:"]' } : null; }
    if (/^caltopo:/.test(key)) return target('ctf-' + key.slice(8));
    if (/^file:/.test(key)) {
      const i = key.lastIndexOf('|'), url = key.slice(5, i), path = key.slice(i + 1);
      if (!path) return { exp: [], sel: `[data-fkey="${cssq(key)}"]` };
      const src = w && w.vectorSources().find(s => s.url === url);
      if (!src) return null;
      const T = PF().overlayTree(src); let found = null;
      const walk = (par, p) => (T.get(par) || []).forEach(e => { const q = p + '/' + (e.name || e.id); if (q === path && T.has(e)) found = e; else if (T.has(e) && !found) walk(e, q); });
      walk(null, '');
      return found ? ovTarget({ e: found, src }) : null;
    }
    if (/^project:/.test(key)) { const g = key.slice(8); return g ? target('g:' + g) : { exp: [], sel: '.cc-it[data-kind="loose"]' }; }
    if (/^mydata:/.test(key)) return { exp: [], sel: `[data-fkey="${cssq(key)}"]` };
    let m;
    if ((m = key.match(/^g:(.+)$/)) && P) {
      const g = P.groups[m[1]]; if (!g || g.removed) return null;
      const path = FL.groupPath(P, g.id);
      return { exp: path.map(x => 'g:' + x.id), sel: `[data-fkey="project:${cssq(g.id)}"]` };
    }
    if ((m = key.match(/^f:(.+)$/)) || (P && P.features && P.features[key] && (m = [0, key]))) {
      const f = P && P.features[m[1]]; if (!f || f.removed) return null;
      const exp = f.group ? FL.groupPath(P, f.group).map(x => 'g:' + x.id) : ['loose'];
      return { exp, sel: `[data-rkey="f:${cssq(f.id)}"]` };
    }
    if ((m = key.match(/^my:(.+)$/)) || (m = [0, key])) {
      const S = my, f = S && S.features && S.features[m[1]];
      if (f && !f.removed) return { exp: ['p:' + (f.group || '')], sel: `[data-rkey="my:${cssq(f.id)}"]` };
    }
    return null;
  }
  function ovTarget({ e, src }) {
    const base = 'o:' + (src.url || src.name), anc = [];
    for (let a = e.parent, n = 0; a && n < 50; a = a.parent, n++) anc.unshift(a);
    const T = PF() ? PF().overlayTree(src) : new Map(), isFolder = T.has(e);
    let p = ''; const exp = [base];
    anc.forEach(a => { p += '/' + (a.name || a.id); exp.push(base + '|' + p); });
    if (isFolder) exp.push(base + '|' + p + '/' + (e.name || e.id));
    FORCE.add(e.id);
    const fk = src.kind === 'caltopo' ? 'caltopo:' + (/^ctf-/.test(e.id) ? e.id.slice(4) : e.id) : 'file:' + src.url + '|' + p + '/' + (e.name || e.id);
    return { exp, sel: isFolder ? `[data-fkey="${cssq(fk)}"]` : `[data-rkey="${cssq(src.kind === 'caltopo' && /^ct-/.test(e.id) ? e.id : 'e:' + (src.url || src.name) + '#' + e.id)}"]` };
  }
  let FLASH = null;                            // { sel, until }: survives a re-render
  function flashNow() {
    if (!FLASH || Date.now() > FLASH.until) { FLASH = null; return null; }
    const row = host.querySelector(FLASH.sel);
    if (row && !row.classList.contains('row-flash')) row.classList.add('row-flash');
    return row;
  }
  async function reveal(key, opts) {
    opts = opts || {};
    const pane = document.getElementById('featuresCollapsible');
    if (opts.open && pane && !pane.classList.contains('show')) {
      if (window._rail && window._rail.open) window._rail.open('#featuresCollapsible');
      else { const b = document.querySelector('#flex-rail [data-target="#featuresCollapsible"]'); if (b) b.click(); }
      for (let i = 0; i < 20 && !pane.classList.contains('show'); i++) await new Promise(r => setTimeout(r, 50));
    }
    await myState();
    const T = target(key);
    if (!T) return false;
    T.exp.forEach(k => { if (k.startsWith('g:') || k === 'loose') fOpen()[k] = true; else open.add(k); });
    while (busy) await new Promise(r => setTimeout(r, 20));
    last = ''; await render();
    const row = host.querySelector(T.sel);
    if (!row) return false;
    host.querySelectorAll('.row-flash').forEach(r => r.classList.remove('row-flash'));
    FLASH = { sel: T.sel, until: Date.now() + 1800 };
    void row.offsetWidth; row.classList.add('row-flash');
    try { row.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    setTimeout(() => { const r = host.querySelector(T.sel); if (r) r.classList.remove('row-flash'); }, 1850);
    return !!(pane && pane.classList.contains('show'));
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  async function find(kind, id) { const M = await model(); return M && M.L.concat(M.R).find(x => x.kind === kind && x.id === id); }
  async function eye(kind, id) {
    masterOnFirst();
    const x = await find(kind, id), w = ws();
    if (!x) return;
    if (kind === 'pgroup') { x.points.forEach(f => PF() && PF().setHidden('m:' + f.id, x.shown)); const ids = new Set(x.points.map(f => f.id)); const ents = pointEntities(ids).concat(shapeEnts(ids)); ents.forEach(e => { e.show = !x.shown; }); }
    else if (kind === 'folder' || kind === 'loose') { if (PF()) { PF().setHidden(kind === 'loose' ? 'root' : 'g:' + id, x.shown); PF().draw(); } }
    else if (kind === 'caltopo') {
      if (!x.loaded) await w.setCaltopo(x.url, x.interval ?? 60);
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
    if (kind === 'caltopo' && (x.dir || (dir === 'out' && x.inProject))) {    // a project map leaves: waits for 💾 Save; the same again cancels
      await pw.moveItem({ kind: 'caltopo', id: x.id, name: x.name, dir: x.dir ? x.dir : 'out', url: x.url });
      soon(); return;
    }
    if (kind === 'caltopo') {                                           // the loaded CalTopo map becomes the project's
      if (dir !== 'in' || !window._pjApi) return;
      await window._pjApi.record('layer.set', { layer: pw.layerId('caltopo', x.url), kind: 'caltopo', url: x.url, interval: x.interval ?? 60, order: (window.FlexLib.liveLayers(PJ().P) || []).length, removed: false });
      if (pw.badge) await pw.badge();
      soon(); return;
    }
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
  // A row click selects the item and opens its full info (the same as ⋯ → Info); the map highlight and the row mark
  // stay while it is the selection (info-panel.js drops them on deselect; closing the pane does too).
  const SEL = { sel: null, key: null };
  function myGeom(row) {
    const id = row.dataset.pt, e = row.dataset.shape ? shapeEnts([id])[0] : pointEntities(new Set([id]))[0], g = e && PF() && PF().entCoords(e);
    return g ? Object.assign(g, { key: 'e:' + e.id }) : null;
  }
  function syncSel() {
    host.querySelectorAll('.sc-sel').forEach(r => r.classList.remove('sc-sel'));
    const k = (window._pjfState || {}).hlKey;
    if (SEL.sel && k && k === SEL.key) { const r = host.querySelector(SEL.sel); if (r) r.classList.add('sc-sel'); } else SEL.sel = SEL.key = null;
  }
  window.addEventListener('flex-highlight', syncSel);
  // Closing the pane leaves nothing highlighted on the map or marked in the list.
  (function () {
    const pane = document.getElementById('featuresCollapsible'); if (!pane || !window.MutationObserver) return;
    let was = pane.classList.contains('show');
    new MutationObserver(() => { const now = pane.classList.contains('show'); if (was && !now && window._pjf) { const k = (window._pjfState || {}).hlKey; if (k && SEL.key === k) window._pjf.clearHighlight(); } was = now; }).observe(pane, { attributes: true, attributeFilter: ['class'] });
  })();
  async function pick(row, g, fly) {
    const rk = row.dataset.rkey;
    if (rk && window._rowMenu && window._rowMenu.info) window._rowMenu.info(rk);          // first: a new selection drops the old highlight
    if (g && PF()) { SEL.sel = `[data-rkey="${cssq(rk)}"]`; SEL.key = g.key; await PF().highlight(g, fly); }
    syncSel();
  }
  host.addEventListener('dblclick', e => {
    const r = e.target.closest('.sc-feat, .sc-pt[data-rkey]'); if (!r || e.target.closest('button')) return;
    clearTimeout(clickT); pick(r, r.dataset.feat || r.dataset.ov ? featureOf(r) : myGeom(r), true);
  });
  host.addEventListener('click', async e => {
    const P = PF();
    const rm = e.target.closest('[data-rmenu]');
    if (rm) { const row = rm.closest('[data-rkey],[data-fkey]'); if (row && window._rowMenu) window._rowMenu.open(row.dataset.rkey ? { rkey: row.dataset.rkey } : { fkey: row.dataset.fkey }, rm); return; }
    if (e.target.closest('[data-master]')) { setMaster(MS.off); return; }
    if (e.target.closest('[data-labels]')) { setLabels(!LB); return; }
    const fsb = e.target.closest('[data-fstyle]'); if (fsb) { if (window._folderStyle) { await window._folderStyle.dialog(fsb.dataset.fstyle); last = ''; render(); } return; }
    const nb = e.target.closest('[data-ctnews]'); if (nb) { newsPop(nb); return; }
    if (e.target.closest('[data-openpj]')) { const b = document.getElementById('rail-pj') || document.getElementById('pj-top-btn'); if (b) b.click(); return; }
    const dr = e.target.closest('[data-draw]'); if (dr && P) { masterOnFirst(); P.startDraw(dr.dataset.draw, ''); return; }
    const tl = e.target.closest('[data-tool]');
    if (tl) {
      const t = tl.dataset.tool;
      if (t === 'file') { if (window._addDataFile) window._addDataFile(); }
      else if (t === 'folder' && P) P.editGroup(null, '');
      else if (t === 'import' && P) { masterOnFirst(); P.importFile(''); }
      else if (t === 'download' && P) P.downloadMenu('');
      else if (t === 'dups') dupsDialog();
      else if (t === 'ctsend') window._ctSend.send({ all: true });
      else if (t === 'ctretry') { if (window._ctWrite) window._ctWrite.retry(); }
      else if (t === 'cthl') {
        const on = window._ctSend.highlight();
        if (on && PJ().P) {                     // the folders holding them open, so the marked rows show
          const FL = window.FlexLib, o = fOpen(), ids = window._ctSend.notInIds(PJ().P);
          FL.liveFeatures(PJ().P).filter(f => ids && ids.has(f.id)).forEach(f => { if (!f.group) o.loose = true; else FL.groupPath(PJ().P, f.group).forEach(g => { o['g:' + g.id] = true; }); });
        }
        last = ''; render();
      }
      return;
    }
    const ex = e.target.closest('[data-expand]');
    if (ex && !e.target.closest('.cc-eye, .cc-tools')) { toggle(ex.dataset.expand); return; }
    const gb = e.target.closest('[data-gadd],[data-gdl],[data-gedit],[data-geye],[data-fedit],[data-oeye],[data-feye]');
    if (gb && P) {
      const d = gb.dataset, A = window._pjApi;
      if (d.feye) { masterOnFirst(); const h = P.hidden(); P.setHidden('f:' + d.feye, !h['f:' + d.feye]); P.draw(); last = ''; render(); }
      else if (d.geye) { masterOnFirst(); const h = P.hidden(); P.setHidden('g:' + d.geye, !h['g:' + d.geye]); P.draw(); last = ''; render(); }
      else if (d.oeye) { masterOnFirst(); const h = P.hidden(); P.setHidden(d.oeye, !h[d.oeye]); P.applyOverlayHidden(); last = ''; render(); }
      else if (d.fedit) { if (window._featEdit) window._featEdit.open({ source: 'project', id: d.fedit }); else P.editFeature(d.fedit); }   // the shared editor, as from ⋯ and the info panel
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
    if (ft) { clearTimeout(clickT); clickT = setTimeout(() => pick(ft, featureOf(ft), false), 220); return; }
    const pt = e.target.closest('[data-pt]');
    if (pt && !e.target.closest('button') && !e.target.closest('.cc-tools')) { clearTimeout(clickT); clickT = setTimeout(() => pick(pt, myGeom(pt), false), 220); return; }
    if (pt && pt.dataset.shape) {
      if (e.target.closest('[data-shpeye]')) { masterOnFirst(); toggleMy(pt.dataset.pt); }
      return;
    }
    if (pt) {
      const id = pt.dataset.pt, ent = pointEntities(new Set([id]))[0];
      if (e.target.closest('[data-pteye]')) { masterOnFirst(); toggleMy(id); return; }
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
  /* the switch in Show features / Labels: span.ui-sw (ui_kit.css) */
  #surf-cols .sc-master:not(.on) { border-color: #f2c24e; color: #f2c24e; }
  #surf-cols .sc-lab:not(.on) { border-color: rgba(255,255,255,.15); color: rgba(255,255,255,.6); }
  #surf-cols .sc-tools { display: contents; }
  #surf-cols .sc-dim { opacity: .5; }
  #flex-rail .sc-off { opacity: .5; text-decoration: line-through; }
  #surf-cols .sc-arrow { display: inline-block; width: 10px; color: rgba(255,255,255,.5); cursor: pointer; }
  #surf-cols .cc-nm[data-expand] { cursor: pointer; }
  #surf-cols .sc-kids { padding: 0 0 3px 14px; }
  #surf-cols .sc-pt, #surf-cols .sc-sub { display: grid; grid-template-columns: 1fr auto; gap: 4px; align-items: center; font-size: 10.5px; color: rgba(255,255,255,.75); padding: 1px 2px; border-radius: 4px; }
  #surf-cols .sc-sub, #surf-cols .sc-pt.sc-wide { grid-template-columns: 20px 1fr auto; }
  #surf-cols .sc-sub.sc-none { display: block; font-style: italic; color: rgba(255,255,255,.4); padding-left: 20px; }
  #surf-cols .sc-feat { cursor: pointer; user-select: none; }
  #surf-cols .sc-pt:hover, #surf-cols .sc-sub:hover { background: rgba(255,255,255,.06); }
  #surf-cols .sc-pt span:first-child, #surf-cols .sc-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  #surf-cols .sc-nm[data-expand] { cursor: pointer; }
  #surf-cols .sc-nm small { color: rgba(255,255,255,.4); }
  #surf-cols .sc-ic { text-align: center; }
  #surf-cols .pjs-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 3px; vertical-align: 0; }
  #surf-cols .sc-pt:hover .cc-tools, #surf-cols .sc-sub:hover .cc-tools { opacity: 1; }
  /* rows share the look of 🕳 Caves (cave-columns.js) */
  #surf-cols .cc-head { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 2px 0 4px; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  #surf-cols .cc-hp { color: #6fd39a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; } #surf-cols .cc-hm { color: #8ab4ec; padding: 0 4px; }
  #surf-cols .cc-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 52vh; overflow-y: auto; }
  #surf-cols .cc-col { min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 3px; border-radius: 6px; min-height: 34px; }
  #surf-cols .cc-p { background: rgba(111,211,154,.08); } #surf-cols .cc-m { background: rgba(138,180,236,.07); }
  #surf-cols .cc-drop { outline: 2px dashed #ff9a62; outline-offset: -2px; }
  #surf-cols .cc-invite { gap: 6px; background: rgba(255,255,255,.03); border: 1px dashed rgba(255,255,255,.15); }
  #surf-cols .cc-note, #surf-cols .cc-empty { color: rgba(255,255,255,.45); font-size: 10.5px; padding: 3px 5px; font-style: italic; }
  #surf-cols .cc-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #e8ece9; border-radius: 5px; padding: 3px 8px; text-align: left; font-size: 11px; cursor: pointer; }
  #surf-cols .cc-it { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 5px; padding: 2px 3px; border-radius: 5px; }
  #surf-cols .cc-it:hover { background: rgba(255,255,255,.07); }
  #surf-cols .cc-it[draggable="true"] { cursor: grab; }
  #surf-cols .cc-moving { background: rgba(242,194,78,.08); }
  /* row eyes: the compact switch, .ui-eye (ui_kit.css); hidden folders/features are .half (loaded, hidden) */
  #surf-cols .cc-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,.88); }
  #surf-cols .cc-nm small { display: block; font-size: 9px; color: rgba(255,255,255,.4); overflow: hidden; text-overflow: ellipsis; padding-left: 12px; }
  #surf-cols .cc-moving .cc-nm small, #surf-cols .sc-wait { color: #f2c24e; }
  #surf-cols .cc-dot { color: #f2c24e; margin-left: 3px; }
  #surf-cols .cc-tools { display: inline-flex; gap: 1px; opacity: .35; }
  #surf-cols .cc-it:hover .cc-tools, #surf-cols .cc-it:focus-within .cc-tools { opacity: 1; }
  #surf-cols .cc-tools button { background: none; border: none; color: rgba(255,255,255,.7); padding: 0 3px; font-size: 12px; line-height: 16px; border-radius: 3px; cursor: pointer; }
  .sc-remind { display: flex; align-items: center; gap: 6px; margin: 4px 0; padding: 3px 8px; font-size: 11px; color: #f2c24e; background: rgba(242,194,78,.08); border: 1px solid rgba(242,194,78,.25); border-radius: 6px; }
  #surf-cols .sc-sel { background: rgba(255,230,0,.16) !important; box-shadow: inset 2px 0 0 #ffe600; }
  #surf-cols .sc-feat.sc-hl { background: rgba(255,106,0,.18); box-shadow: inset 2px 0 0 #ff6a00; }
  .sc-remind > span { flex: 1; } .sc-remind .sc-link { background: none; border: none; padding: 0; color: #8ab4ec; text-decoration: underline; cursor: pointer; font-size: inherit; }
  .sc-dups { max-height: 50vh; overflow: auto; margin: 6px 0; }
  .sc-dup { display: flex; align-items: center; gap: 6px; padding: 3px 2px; font-size: 12px; }
  .sc-dup-all { border-bottom: 1px solid rgba(255,255,255,.12); margin-bottom: 3px; }
  .sc-dup-k { opacity: .65; font-size: 11px; }
  .sc-dup button { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; }
  #surf-cols .cc-tools button:hover { color: #fff; background: rgba(255,255,255,.1); }
  #surf-cols .cc-tools .cc-mv { color: #ff9a62; font-weight: 700; }
  .sc-extra { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 10.5px; color: rgba(255,255,255,.65); margin: 0 0 8px; }
  .sc-extra label { display: inline-flex; gap: 4px; align-items: center; margin: 0; cursor: pointer; }
  .sc-extra input { margin: 0; }
  .sc-extra a { color: #8ab4ec; }
  .sc-extra .sc-sep { opacity: .4; }
  /* marks: not in CalTopo, CalTopo edit states, the changes button */
  #surf-cols .sc-st { display: inline-block; font-weight: 600; font-size: 8.5px; line-height: 12px; padding: 0 4px; margin-left: 5px; border-radius: 6px; vertical-align: 1px; letter-spacing: .02em; }
  #surf-cols .cc-nm small .sc-st { margin-left: 6px; }
  #surf-cols .sc-nict { color: #f2c24e; background: rgba(242,194,78,.12); border: 1px solid rgba(242,194,78,.35); }
  #surf-cols .sc-st-waiting { color: #8ab4ec; background: rgba(138,180,236,.12); border: 1px solid rgba(138,180,236,.4); }
  #surf-cols .sc-st-conflict, #surf-cols .sc-st-failed { color: #ff8a7a; background: rgba(255,120,100,.12); border: 1px solid rgba(255,120,100,.45); }
  #surf-cols .sc-st-changed { color: #6fd39a; background: rgba(111,211,154,.12); border: 1px solid rgba(111,211,154,.4); }
  #surf-cols .sc-st-in { color: #8ab4ec; border: 1px solid rgba(138,180,236,.4); }
  #surf-cols .sc-news { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.18); color: rgba(255,255,255,.75); border-radius: 8px; padding: 0 5px; font-size: 9px; line-height: 13px; cursor: pointer; vertical-align: 0; }
  #surf-cols .sc-news.sc-hot { color: #ffb020; border-color: rgba(255,176,32,.6); background: rgba(255,176,32,.12); }
  #surf-cols .sc-fs-on { color: #6fd39a !important; }
  #surf-cols .cc-tools button.sc-fs, #surf-cols .cc-tools button.sc-more { display: inline-flex; align-items: center; }
  #flex-rail [data-target="#featuresCollapsible"] { position: relative; }
  #flex-rail .sc-rail-dot { position: absolute; top: 4px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: #ffb020; box-shadow: 0 0 0 2px rgba(20,22,30,.9); pointer-events: none; }
  .sc-news-pop { width: 330px; max-height: 70vh; overflow: auto; }
  .sc-news-pop .sc-ch-list { display: flex; flex-direction: column; }
  .sc-news-pop .sc-ch { display: grid !important; grid-template-columns: 58px 1fr auto; gap: 6px; align-items: center; }
  .sc-news-pop .sc-ch:disabled { opacity: .55; cursor: default; }
  .sc-news-pop .sc-ch-new { background: rgba(255,176,32,.08); }
  .sc-news-pop .sc-ch-w { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .sc-news-pop .sc-ch-added { color: #6fd39a; } .sc-news-pop .sc-ch-changed { color: #8ab4ec; } .sc-news-pop .sc-ch-removed { color: #ff8a7a; }
  .sc-news-pop .sc-ch-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .sc-news-pop small { opacity: .55; font-size: 10.5px; }
  .sc-news-pop .sc-ch-none { opacity: .55; padding: 4px 8px; font-style: italic; }
  .sc-news-pop .sc-pq-h { margin-top: 6px; border-top: 1px solid rgba(255,255,255,.1); padding-top: 6px; }
  .sc-news-pop .sc-pq { display: grid; grid-template-columns: 58px 1fr auto; gap: 6px; align-items: center; padding: 3px 8px; font-size: 12px; color: #e8ece9; }
  .sc-news-pop .sc-pq b { font-size: 10px; text-transform: uppercase; color: #8ab4ec; } .sc-news-pop .sc-pq-conflict b, .sc-news-pop .sc-pq-failed b { color: #ff8a7a; }
  .sc-news-pop .sc-pq button { border: 1px solid rgba(255,255,255,.2); padding: 1px 8px; }
  /* reveal: the row flashes */
  @keyframes row-flash { 0%, 40% { background: rgba(255,230,0,.35); box-shadow: inset 0 0 0 1px #ffe600; } 100% { background: transparent; box-shadow: none; } }
  #surf-cols .row-flash { animation: row-flash 1.8s ease-out; }
  /* The old lists: the columns show these now. */
  #lp-poi-list, #lp-data-list { display: none !important; }`;
  document.head.appendChild(style);

  window.addEventListener('flex-caltopo-changed', soonNews);
  window.addEventListener('flex-caltopo-queue', soonNews);
  window.addEventListener('flex-folder-style', () => { last = ''; soon(); });
  window.addEventListener('flex-feature-edited', () => { last = ''; soon(true); });
  // The CalTopo map row, for its ⋯ menu (row-menu.js): what it is and what can be done with it.
  const ctMap = () => { const M = MODEL; const x = M && M.L.concat(M.R).find(r => r.kind === 'caltopo'); return x ? { id: x.id, url: x.url, name: x.name, inProject: !!x.inProject, mine: !x.inProject, dir: x.dir || null, loaded: !!x.loaded } : null; };
  async function ctRename(name) {      // display only: never written to CalTopo
    const x = ctMap(); name = String(name || '').trim().slice(0, 120); if (!x || !name) return;
    if (x.inProject && window._pjApi) await window._pjApi.record('layer.set', { layer: x.id, name });
    else { const id = mapId(x.url); if (id) { const l = ctLocal(); l[id] = name; try { localStorage.setItem('flex.ct.names', JSON.stringify(l)); } catch (_) {} } }
    last = ''; soon();
  }
  async function ctLeave(how) {        // 'out' = Move to My data, 'remove' = Remove from project (both wait for 💾 Save); 'cancel'
    const x = ctMap(), pw = PW(); if (!x || !x.inProject || !pw) return;
    if (how === 'cancel') { if (x.dir) await pw.moveItem({ kind: 'caltopo', id: x.id, name: x.name, dir: x.dir, url: x.url }); }
    else if (x.dir !== how) { if (x.dir) await pw.moveItem({ kind: 'caltopo', id: x.id, name: x.name, dir: x.dir, url: x.url }); await pw.moveItem({ kind: 'caltopo', id: x.id, name: x.name, dir: how, url: x.url }); }
    last = ''; soon();
  }
  function ctUnload() { const w = ws(); if (w && w.clearCaltopo) w.clearCaltopo(); last = ''; soon(true); }   // a map in My data: Remove
  window._surfCols = { ctMap, ctRename, ctLeave, ctUnload, reveal, news: a => newsPop(a || host.querySelector('[data-ctnews]') || host), labels: on => (on === undefined ? LB : setLabels(on)), render: async () => { while (busy) await new Promise(r => setTimeout(r, 20)); last = ''; return render(); }, refresh: () => soon(true), master: on => (on === undefined ? !MS.off : setMaster(on)) };
})();
