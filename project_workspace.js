// A project as the workspace (project docs 13, 14).
//
// Opening a project loads all of it, next to whatever else is loaded (your
// My data); nothing else is cleared. Only one project is open at a time:
// switching puts the open project's things away.
//
// The project changes only when you say so:
//   - a project cave moved or given a new survey file here, a CalTopo refresh
//     interval changed… are waiting changes: 💾 Save puts them in (the Save
//     button shows how many wait). Autosave keeps your view and My data only.
//   - something loaded that isn't in the project is added with "＋ Add to
//     project" (📁 → What this project loads), or by starting a new project
//     with what is loaded.
//   - unloading a project's cave or layer only unloads it.
//   - moving a cave between the project and 👤 My data (🕳 Caves, the two
//     columns) is a waiting change too; until 💾 Save it shows where it is
//     going, and Discard undoes it. Moved in, it leaves My data; moved out,
//     it goes back there (one home each).
// Notes, leads, documents and reviews go straight into the project (project.js).
// Camera, layers, styles are personal: a session per project (session.js).
//
// Uses project.js (window._pjApi) and flex.js (window._ws).
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) { console.warn('[workspace] project.js missing'); return; }
  const { pj, FL, el, btn, esc, toast, dialog, choose, record } = A;
  const ws = () => window._ws;
  const wait = async (cond, ms = 30000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 150)); } return true; };
  const W = { busy: false, entering: false, pending: [], moves: [] };
  window._pjWsState = W;                          // tests

  // ── Hashing and ids ──────────────────────────────────────────────────────
  const bytes = t => new TextEncoder().encode(t);
  async function sha(t) {
    const b = typeof t === 'string' ? bytes(t) : t;
    if (window.crypto && crypto.subtle) { const d = await crypto.subtle.digest('SHA-256', b); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); }
    return FL.sha256(b);
  }
  function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
  const layerId = (kind, url) => 'l' + fnv(kind + '|' + url);
  const placeKey = g => (g ? JSON.stringify(sortDeep(g)) : '');
  // Empty fields don't count (a placement stored without "survey": "" is the same placement).
  function sortDeep(x) { if (Array.isArray(x)) return x.map(sortDeep); if (x && typeof x === 'object') { const o = {}; Object.keys(x).sort().forEach(k => { if (x[k] !== undefined && x[k] !== null && x[k] !== '') o[k] = sortDeep(x[k]); }); return o; } return x; }

  // ── What is loaded now, as the project would store it ────────────────────
  function loadedLayers() {
    const w = ws(), out = [];
    w.pointClouds().forEach(url => out.push({ kind: 'pointcloud', url, name: url.replace(/\/ept\.json.*$/i, '').split('/').filter(Boolean).pop() || url }));
    const ct = w.caltopo(); if (ct) out.push({ kind: 'caltopo', url: ct.url, name: 'CalTopo map', interval: ct.interval });
    w.dataFiles().forEach(f => out.push({ kind: 'file', url: f.url, name: f.label || f.url }));
    return out;
  }
  const inProject = {
    cave: name => { const f = pj.P.cavefiles[name]; return !!(f && !f.removed); },
    layer: l => { const c = pj.P.layers[layerId(l.kind, l.url)]; return !!(c && !c.removed); },
  };

  // ── Caves moved between the project and My data, waiting for 💾 Save ─────
  // [{ kind: 'cave', name, dir: 'in' | 'out' }], kept per project in this browser.
  const movesKey = () => 'flex.pj.moves@' + pj.pid;
  function loadMoves() { try { W.moves = pj.pid ? JSON.parse(localStorage.getItem(movesKey()) || '[]') : []; } catch (_) { W.moves = []; } }
  function saveMoves() { try { if (pj.pid) localStorage.setItem(movesKey(), JSON.stringify(W.moves)); } catch (_) {} }
  const moving = (name, dir) => W.moves.some(m => m.kind === 'cave' && m.name === name && (!dir || m.dir === dir));
  /** Is this cave the open project's (saved there and not leaving, or coming in)? */
  function owns(name) {
    if (!pj.pid || !pj.P) return false;
    if (moving(name, 'in')) return true;
    return inProject.cave(name) && !moving(name, 'out');
  }
  /**
   * 📍 Surface (surface_columns.js): a sitting's points ('pgroup'), one point
   * ('point') or a data file ('file') to the project ('in') or My data ('out').
   * m = { kind, id, name, dir, url? }. The same again cancels it.
   */
  async function moveItem(m) {
    if (!pj.pid) return;
    const k = W.moves.findIndex(x => x.kind === m.kind && x.id === m.id);
    if (k >= 0) W.moves.splice(k, 1); else W.moves.push(m);
    saveMoves();
    await badge();
  }
  const movingItem = (kind, id) => (W.moves.find(x => x.kind === kind && x.id === id) || {}).dir || null;
  /** ← / →: a cave to the project ('in') or to My data ('out'); the same again cancels it. */
  async function moveCave(name, dir) {
    if (!pj.pid) return;
    const other = W.moves.findIndex(m => m.kind === 'cave' && m.name === name);
    if (other >= 0) W.moves.splice(other, 1);
    const saved = inProject.cave(name);
    if ((dir === 'in' && !saved) || (dir === 'out' && saved)) W.moves.push({ kind: 'cave', name, dir });
    saveMoves();
    await badge();
  }

  // ── Changes waiting for 💾 Save, and what is loaded but not in the project ─
  async function scan() {
    const w = ws(), out = { pending: [], extra: { caves: [], layers: [] } };
    if (!pj.pid || !w) return out;
    const S = pj.P;
    W.moves.forEach(m => out.pending.push({ kind: 'move', move: m, name: m.name, dir: m.dir, what: m.dir === 'in' ? 'into the project' : 'out to My data' }));
    for (const c of w.caves()) {
      if (!c.text) continue;
      if (moving(c.name)) continue;
      const cur = S.cavefiles[c.name];
      if (!cur || cur.removed) { out.extra.caves.push(c); continue; }
      const h = await sha(c.text);
      if (cur.h !== h) out.pending.push({ kind: 'cave', name: c.name, what: 'new survey file', c, h });
      else if (placeKey(cur.place) !== placeKey(c.georef)) out.pending.push({ kind: 'cave', name: c.name, what: 'moved', c });
    }
    for (const l of loadedLayers()) {
      const cur = S.layers[layerId(l.kind, l.url)];
      if (!cur || cur.removed) { out.extra.layers.push(l); continue; }
      if (l.interval != null && cur.interval !== l.interval) out.pending.push({ kind: 'layer', name: l.name, what: 'refresh every ' + l.interval + ' s', l });
    }
    return out;
  }
  async function commit(p) {
    if (p.kind === 'move') {
      const w = ws(), c = w.caves().find(x => x.name === p.name);
      if (p.move && p.move.kind !== 'cave') {
        await commitSurface(p.move);
        W.moves = W.moves.filter(m => !(m.kind === p.move.kind && m.id === p.move.id));
        saveMoves();
        return;
      }
      if (p.dir === 'in') {
        // From My data: its text and placement (loaded, or as My data keeps them).
        const r = w.recents().find(x => x.name === p.name);
        const text = c ? c.text : await w.recentText(p.name);
        if (!text) throw new Error(`the survey file of “${p.name}” isn’t in My data`);
        await addCave({ name: p.name, text, georef: c ? c.georef : (r && r.georef) });
        w.forgetRecent(p.name);
      } else {
        // To My data first, then out of the project: never in neither.
        const f = pj.P.cavefiles[p.name];
        let text = c && c.text;
        if (!text && f && f.h) { const r = await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt')); if (r.ok) text = await r.text(); }
        if (!text) throw new Error(`the survey file of “${p.name}” isn’t on this computer`);
        w.keepRecent(p.name, text, c ? c.georef : (f && f.place), c ? c.displayOptions : null);
        await record('cavefile.set', { file: p.name, removed: true }, null, { quiet: true });
      }
      W.moves = W.moves.filter(m => !(m.kind === 'cave' && m.name === p.name));
      saveMoves();
      return;
    }
    if (p.kind === 'cave') {
      if (p.what === 'new survey file') {
        await fetch('/api/lib/blob?ext=plt&h=' + p.h + '&project=' + encodeURIComponent(pj.pid), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes(p.c.text) });
        await record('cavefile.set', { file: p.c.name, h: p.h, ext: 'plt', place: p.c.georef || null, removed: false }, null, { quiet: true });
      } else await record('cavefile.set', { file: p.c.name, place: p.c.georef || null }, null, { quiet: true });
    } else if (p.kind === 'layer') await record('layer.set', { layer: layerId(p.l.kind, p.l.url), interval: p.l.interval }, null, { quiet: true });
  }
  async function addCave(c) {
    const h = await sha(c.text);
    await fetch('/api/lib/blob?ext=plt&h=' + h + '&project=' + encodeURIComponent(pj.pid), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes(c.text) });
    await record('cavefile.set', { file: c.name, h, ext: 'plt', place: c.georef || null, removed: false }, null, { quiet: true });
    // Notes, leads and documents hang on caves: a file nobody's cave covers becomes one.
    const covered = FL.liveCaves(pj.P).some(cv => (cv.sources || []).some(s => s.file === c.name)) || pj.P.aliases[c.name];
    if (!covered) {
      const cid = FL.uid(10);
      await record('cave.set', { cave: cid, name: c.name.replace(/\.(plt|json)$/i, '').slice(0, 60), sources: [{ file: c.name }] }, null, { quiet: true });
      await record('cave.alias', { cave: cid, alias: c.name }, null, { quiet: true });
    }
  }
  async function addLayer(l) {
    await record('layer.set', Object.assign({ layer: layerId(l.kind, l.url), order: FL.liveLayers(pj.P).length, removed: false }, l), null, { quiet: true });
  }
  async function refreshAfter(op) { A.refresh && A.refresh(op); await badge(); }

  // ── 💾 Save ──────────────────────────────────────────────────────────────
  /** The Save button: your view, and the waiting project changes. */
  async function save() {
    if (window._sessionSave) window._sessionSave();
    if (!pj.pid || W.busy) return 0;
    if (!(A.who && A.who()) && !(await A.ensureAuthor())) return 0;
    W.busy = true;
    let n = 0;
    try {
      const { pending } = await scan();
      for (const p of pending) { await commit(p); n++; }
      if (n) { await refreshAfter('cavefile.set'); toast(`Saved ${n} change${n > 1 ? 's' : ''} into “${projName()}”`); }
    } catch (e) { console.warn('[workspace] save failed', e); toast('Could not save into the project: ' + e.message); }
    finally { W.busy = false; await badge(); }
    return n;
  }
  // A surface move, when saved. Points: My data → project features (a
  // sitting becomes a project folder of the same name). Data files: their
  // bytes are copied into the destination's folder first, then taken out of
  // the other side, and the loaded copy is swapped for the new one.
  async function commitSurface(m) {
    const w = ws(), MD = window._myData;
    if (!MD) throw new Error('My data is not available');
    if (m.kind === 'pgroup' || m.kind === 'point') {
      if (m.dir !== 'in') return;
      const S = await MD.state(true);
      const pts = Object.values(S.features || {}).filter(f => !f.removed && f.kind === 'point' && f.coords && (m.kind === 'point' ? f.id === m.id : f.group === m.id));
      let group = '';
      if (m.kind === 'pgroup') { group = FL.uid(10); await record('group.set', { group, name: (S.groups[m.id] || {}).name || m.name || 'Points', parent: '' }, null, { quiet: true }); }
      for (const f of pts) {
        await record('feature.set', { feature: FL.uid(12), kind: 'point', coords: f.coords, name: f.name || 'Point', group }, null, { quiet: true });
        await MD.forgetPoint({ properties: { myFeature: { getValue: () => f.id } } }, 'moved');
        const V = window.cesiumViewer, e = V && V.entities.values.find(x => x.properties && x.properties.myFeature && x.properties.myFeature.getValue() === f.id);
        if (e) V.entities.remove(e);
      }
      if (window._pjf) window._pjf.draw();
      return;
    }
    if (m.kind === 'file') {
      const r = await fetch(m.url);
      if (!r.ok) throw new Error(`“${m.name}” could not be read (${r.status})`);
      const buf = await r.arrayBuffer();
      let ext = (m.url.split('?')[0].split('.').pop() || '').toLowerCase(); if (ext === 'geojson') ext = 'json';
      const wasLoaded = w.dataFiles().find(f => f.url === m.url);
      let url;
      if (m.dir === 'in') {
        const h = await sha(new Uint8Array(buf));
        const b = await fetch('/api/lib/blob?ext=' + ext + '&h=' + h + '&project=' + encodeURIComponent(pj.pid), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
        if (!b.ok) throw new Error(`“${m.name}” could not be stored in the project`);
        url = '/api/lib/blob/' + h + '.' + ext;
        await addLayer({ kind: 'file', url, name: m.name });
        await MD.forgetFile(m.id);
      } else {
        const myId = await MD.keepFile(new File([buf], (m.name || 'file').replace(/\.(kml|kmz|json|geojson)$/i, '') + '.' + ext), m.name);
        if (!myId) throw new Error(`“${m.name}” could not be kept in My data`);
        await record('layer.set', { layer: m.id, removed: true }, null, { quiet: true });
        const S = await MD.state(true); const L = S.layers[myId]; url = L && L.blob ? '/api/lib/blob/' + L.blob : null;
        m.myId = myId;
      }
      if (wasLoaded && url) {
        w.switching = true;
        try { w.removeDataFile(m.url); } finally { w.switching = false; }
        await w.addDataFile(url, m.name, m.dir === 'in' ? { noKeep: true } : { myId: m.myId });
      }
    }
  }
  /** Discard: the project's saved version comes back; waiting moves are dropped. */
  async function discard() {
    if (!pj.pid) return 0;
    const { pending } = await scan();
    const w = ws();
    W.moves = []; saveMoves();
    w.switching = true;
    try {
      for (const p of pending) {
        if (p.kind === 'cave') {
          const f = pj.P.cavefiles[p.name], disp = (w.caves().find(x => x.name === p.name) || {}).displayOptions || null;
          const r = f && f.h ? await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt')) : null;
          if (!r || !r.ok) continue;
          w.removeCave(p.name);
          w.loadCave(p.name, await r.text(), f.place || null, disp);
        } else if (p.kind === 'layer') {
          const cur = pj.P.layers[layerId(p.l.kind, p.l.url)];
          if (cur && p.l.kind === 'caltopo') w.setCaltopo(cur.url, cur.interval ?? 30);
        }
      }
    } finally { w.switching = false; }
    if (pending.length) toast(`Discarded ${pending.length} change${pending.length > 1 ? 's' : ''}: “${projName()}” as saved`);
    await badge();
    return pending.length;
  }
  /**
   * A project cave's look (colours, labels…) is yours, kept with the project's
   * view in this browser. None kept yet (a new project, another browser): the
   * look My data has for a cave of that name, area labels included.
   */
  function mineStyle(name) {
    const w = ws(), r = w && w.recents ? w.recents().find(x => x.name === name) : null;
    return (r && r.displayOptions) ? JSON.parse(JSON.stringify(r.displayOptions)) : null;
  }
  /** Load one of the project's caves (its saved file and placement). */
  async function loadProjectCave(name) {
    const f = pj.P && pj.P.cavefiles[name], w = ws();
    if (!f || f.removed || !w) return false;
    const r = await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt'));
    if (!r.ok) { toast(`The survey file of “${name}” isn’t on this computer yet`); return false; }
    const snap = await readSnap(pj.pid);
    const st = ((snap && snap.caves) || []).find(c => c.name === name);
    w.switching = true;
    try { w.loadCave(name, await r.text(), f.place || null, (st && st.displayOptions) || mineStyle(name)); } finally { w.switching = false; }
    return true;
  }
  /** The Save button: with changes waiting, a menu (save them / discard them); else saves the view. */
  async function saveClick(ev) {
    const { pending } = pj.pid ? await scan() : { pending: [] };
    if (!pending.length) return save();
    const b = document.getElementById('session_save_btn');
    let m = document.getElementById('pj-save-menu');
    if (m) { m.remove(); return; }
    m = el('div'); m.id = 'pj-save-menu';
    m.appendChild(el('div', 'pj-save-menu-t', `${pending.length} change${pending.length > 1 ? 's' : ''} waiting for “${projName()}”`));
    pending.forEach(p => m.appendChild(el('div', 'pj-save-menu-i', `• ${p.name} — ${p.what}`)));
    const row = el('div', 'pj-row');
    row.appendChild(btn('💾 Save into the project', async () => { m.remove(); await save(); A.render && A.render(); }, 'small primary'));
    row.appendChild(btn('Discard', async () => {
      m.remove();
      const ok = await choose(`Discard ${pending.length} change${pending.length > 1 ? 's' : ''}?`, '“' + projName() + '” stays as it was saved; moved caves stay where they were.', [{ label: 'Discard them', value: 'yes', primary: true }, { label: 'Keep them', value: 'no' }]);
      if (ok === 'yes') { await discard(); A.render && A.render(); }
    }, 'small'));
    row.appendChild(btn('Cancel', () => m.remove(), 'small'));
    m.appendChild(row);
    document.body.appendChild(m);
    const r = b.getBoundingClientRect();
    m.style.left = r.left + 'px'; m.style.top = (r.bottom + 6) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target) && e.target !== b) { m.remove(); document.removeEventListener('mousedown', off); } }), 0);
  }
  /** Autosave (session.js): the view is saved there; here only the count of waiting changes. */
  async function autosave() { await badge(); }
  async function badge() {
    const b = document.getElementById('session_save_btn');
    if (!b) return;
    W.pending = pj.pid && ws() && !W.entering ? (await scan()).pending : [];
    const n = W.pending.length;
    b.textContent = n ? `💾 Save · ${n}` : '💾 Save';
    b.classList.toggle('pj-save-waiting', !!n);
    if (window._caveCols) window._caveCols.render();
    if (window._surfCols) window._surfCols.refresh();
    b.title = n ? `Save your view, and put ${n} change${n > 1 ? 's' : ''} into “${projName()}”: ${W.pending.map(p => p.name + ' (' + p.what + ')').join(', ')}`
                : (pj.pid ? `Save your view. Nothing waiting for “${projName()}”.` : 'Save your view (camera, layers, what is loaded).');
  }
  /** Unloaded while the project is open: only unloaded; it stays in the project. */
  async function removed(kind, key) {
    if (!pj.pid || W.entering) return;
    const isIn = kind === 'cave' ? inProject.cave(key) : (() => { const l = pj.P.layers[layerId(kind, key)]; return !!(l && !l.removed); })();
    if (isIn) toast('Unloaded; it stays in the project (🕳 Caves: → moves it to My data)');
    setTimeout(badge, 50);
  }

  // ── Open / close ─────────────────────────────────────────────────────────
  const projName = () => ((pj.projects.find(p => p.id === pj.pid) || {}).name || pj.P.name || 'Project');
  /** Put the open project's things away (not what else is loaded). */
  function unloadProject() {
    const w = ws();
    w.switching = true;
    try {
      const files = new Set(FL.liveCavefiles(pj.P).map(f => f.file));
      w.caves().map(c => c.name).filter(n => files.has(n)).forEach(n => w.removeCave(n));
      const ls = FL.liveLayers(pj.P);
      const urls = k => new Set(ls.filter(l => l.kind === k).map(l => l.url));
      const pcs = urls('pointcloud'), cts = urls('caltopo'), fs = urls('file');
      w.pointClouds().filter(u => pcs.has(u)).forEach(u => w.removePointCloud(u));
      const ct = w.caltopo(); if (ct && cts.has(ct.url)) w.clearCaltopo();
      w.dataFiles().filter(f => fs.has(f.url)).forEach(f => w.removeDataFile(f.url));
    } finally { w.switching = false; }
  }
  /**
   * Leaving a project: save the view; waiting project changes → ask; put its
   * things away. Returns false when the person cancels (stay).
   */
  async function leave(pid) {
    if (!(await wait(() => ws() && window._sessionSave))) return true;
    if (!pid) { window._sessionSave(); return true; }
    const { pending } = await scan();
    if (pending.length) {
      const r = await choose(`“${projName()}” has ${pending.length} change${pending.length > 1 ? 's' : ''} not saved into it`,
        pending.map(p => `${p.name}: ${p.what}`).join(' · '), [
          { label: 'Save them, then switch', value: 'save', primary: true },
          { label: 'Switch without them', sub: 'the project keeps its saved version', value: 'drop' },
          { label: 'Cancel', value: 'cancel' }]);
      if (!r || r === 'cancel') return false;
      if (r === 'save') await save();
      else { W.moves = []; saveMoves(); }
    }
    window._sessionSave();                   // the view of what we leave (key still the old project)
    unloadProject();
    return true;
  }
  async function readSnap(pid) { try { return JSON.parse(localStorage.getItem('flex_session_v1' + (pid ? '@' + pid : '')) || 'null'); } catch (_) { return null; } }
  /** Open: load all of the project, next to what is loaded. */
  async function enter(pid, { startup = false } = {}) {
    if (!(await wait(() => ws() && window.cesiumViewer && window._sessionSave))) return;
    const w = ws();
    if (!pid) { W.moves = []; await badge(); return; }      // No project: what is loaded stays as it is
    const snap = await readSnap(pid);
    loadMoves();
    W.entering = true; w.switching = true;
    const cavefiles = FL.liveCavefiles(pj.P), layers = FL.liveLayers(pj.P);
    const L = loading(projName(), cavefiles.length + layers.length + 1);
    try {
      const style = {};
      ((snap && snap.caves) || []).forEach(c => { style[c.name] = c.displayOptions; });
      const missing = [], loaded = new Set(w.caves().map(c => c.name));
      let k = 0;
      for (const f of cavefiles) {
        await L.step(`Cave ${++k} of ${cavefiles.length}: ${f.file}`);
        const r = await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt'));
        if (!r.ok) { missing.push(f.file); continue; }
        if (loaded.has(f.file)) w.removeCave(f.file);                 // the project's version and placement win
        w.loadCave(f.file, await r.text(), f.place || null, style[f.file] || mineStyle(f.file));
      }
      const pcs = new Set(w.pointClouds()), files = new Set(w.dataFiles().map(f => f.url));
      for (const l of layers.filter(l => l.kind === 'pointcloud')) { await L.step('Point cloud: ' + (l.name || l.url)); if (!pcs.has(l.url)) w.addPointCloud(l.url); }
      const ct = layers.filter(l => l.kind === 'caltopo');
      for (const l of ct) await L.step('CalTopo map');
      if (ct.length && !(w.caltopo() && w.caltopo().url === ct[0].url)) await withTimeout(w.setCaltopo(ct[0].url, ct[0].interval ?? 30), 15000);
      if (ct.length > 1) toast(`This project has ${ct.length} CalTopo maps; FLEX shows one at a time (the first)`);
      for (const l of layers.filter(l => l.kind === 'file')) { await L.step('Data file: ' + (l.name || '')); if (!files.has(l.url)) await w.addDataFile(l.url, l.name, { noKeep: true }); }
      for (const l of layers.filter(l => !['pointcloud', 'caltopo', 'file'].includes(l.kind))) await L.step(l.name || 'Layer');
      if (startup) {
        // At start, what else was loaded with this project open comes back too (from My data).
        const inP = new Set(FL.liveCavefiles(pj.P).map(f => f.file));
        for (const c of (snap && snap.caves) || []) if (!inP.has(c.name) && !w.caves().some(x => x.name === c.name)) await w.recentCave(c.name);
        const pls = new Set(layers.map(l => l.url));
        ((snap && snap.pointClouds) || []).filter(u => !pls.has(u) && !w.pointClouds().includes(u)).forEach(u => w.addPointCloud(u));
        if (window._myData) {
          const have = new Set(w.dataFiles().map(f => f.url));
          for (const f of await window._myData.filesToRestore([])) if (!have.has(f.url)) await w.addDataFile(f.url, f.label, { myId: f.id });
        }
      }
      if (missing.length) toast(`Survey file(s) not on this computer yet: ${missing.join(', ')} — import the sync file that has them`);
      // Let the drawing catch up before moving the camera: a flight while caves
      // are still being built is jerky.
      await L.step('Drawing…');
      await settle();
      L.done();
      if (snap && snap.camera) w.restoreView(snap, { fly: !startup });          // opening: fly there; at start: just be there
      else if (!startup) setTimeout(() => {                                   // no view kept yet: over the project's area
        if (window._pjx && window._pjx.flyToProject(pid)) return;
        const files = new Set(FL.liveCavefiles(pj.P).map(f => f.file));
        const i = (window._caveImports || []).findIndex(x => x && files.has(x.name));
        if (i >= 0 && window._flyToCave) window._flyToCave(i);
      }, 300);
    } finally { L.done(); w.switching = false; W.entering = false; label(); await badge(); }
  }

  // ── "Loading <project>" with a progress bar, while a project opens ────────
  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, ms))]);
  const tick = () => new Promise(r => setTimeout(r, 30));          // lets the bar paint between steps
  function loading(name, total) {
    let box = document.getElementById('pj-loading');
    if (!box) {
      box = el('div'); box.id = 'pj-loading';
      box.innerHTML = '<div class="pjl-card"><div class="pjl-k">Loading project</div><div class="pjl-t"></div><div class="pjl-bar"><div></div></div><div class="pjl-s"></div></div>';
      document.body.appendChild(box);
    }
    box.querySelector('.pjl-t').textContent = name;
    const bar = box.querySelector('.pjl-bar div'), sub = box.querySelector('.pjl-s');
    let n = 0, shown = false;
    bar.style.width = '0%'; sub.textContent = '';
    const t0 = Date.now();
    return {
      async step(text) {
        n++;
        if (!shown && (total > 1 || Date.now() - t0 > 300)) { shown = true; box.classList.add('on'); }
        bar.style.width = Math.min(100, Math.round(100 * n / Math.max(1, total))) + '%';
        sub.textContent = text || '';
        await tick();
      },
      done() { bar.style.width = '100%'; box.classList.remove('on'); },
    };
  }
  /** Until the caves are drawn and the map has caught up (or a few seconds pass). */
  async function settle(ms = 5000) {
    const V = window.cesiumViewer, t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const prims = (window._caveImports || []).map(i => i && i._linePrim).filter(Boolean);
      const drawn = prims.every(p => p.ready !== false);
      const tiles = !V || V.scene.globe.tilesLoaded;
      if (drawn && tiles) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 200));
  }
  /** A new project that starts with what is loaded now: all of it goes in. */
  async function adopt() {
    const { extra } = await scan();
    for (const c of extra.caves) await addCave(c);
    for (const l of extra.layers) await addLayer(l);
    await refreshAfter('cavefile.set');
    window._sessionSave && window._sessionSave(); label();
  }

  // ── The project button (top left, next to Save) ──────────────────────────
  function label() {
    const b = document.getElementById('pj-top-btn');
    if (!b) return;
    const name = pj.pid ? projName() : 'No project';
    b.textContent = '📁 ' + name;
    b.title = pj.pid ? `Project “${name}”: caves, layers, CalTopo, notes, leads, documents. 💾 Save puts changes into it.` : 'No project open: your own caves and points (My data). Open or create a project here.';
    b.classList.toggle('pj-top-on', !!pj.pid);
  }

  // ── 📁 Project → What this project loads ────────────────────────────────
  // The CalTopo map (key, map picker, link) is a project thing: its panel
  // section lives in 📁 Project while a project is open. With no project it
  // shows in 📍 Features only while a map is still loaded (so it can be
  // cleared); otherwise it is put away.
  let ctNode = null, ctSlot = null, ctHold = null;
  function placeCaltopo(root) {
    if (!ctNode) {
      const body = document.getElementById('lp-caltopo-body');
      ctNode = body && body.closest('.lp-section');
      if (!ctNode) return;
      ctSlot = document.createComment('caltopo');
      ctNode.parentNode.insertBefore(ctSlot, ctNode);
      ctHold = document.createElement('div'); ctHold.style.display = 'none'; document.body.appendChild(ctHold);
    }
    if (pj.pid && root) { root.appendChild(ctNode); return; }
    const loaded = !!(window._ws && window._ws.caltopo());
    if (loaded) ctSlot.parentNode.insertBefore(ctNode, ctSlot.nextSibling);
    else ctHold.appendChild(ctNode);
  }
  const icon = { pointcloud: '☁', caltopo: '🗺', file: '📄' };
  const kindName = k => (k === 'caltopo' ? 'CalTopo map' : k === 'pointcloud' ? 'point cloud' : 'data file');
  function section(root, mk) {
    if (!pj.pid) { placeCaltopo(null); return; }
    mk(root, 'What this project loads', true, b => {
      b.appendChild(el('div', 'pj-note', 'Opening the project loads all of these. Changes to them wait for 💾 Save. Unloading one only unloads it; Remove from project takes it out. Caves are in 🕳 Caves (project | My data). Placement is shared; colours and styles are yours.'));
      const files = [], layers = FL.liveLayers(pj.P);
      if (!layers.length) b.appendChild(el('div', 'pj-note', 'No layers in the project yet: load point clouds, a CalTopo map, data files, then ＋ Add them below.'));
      const loaded = new Set(ws() ? ws().caves().map(c => c.name) : []);
      const wait = new Map(W.pending.filter(p => p.kind === 'cave').map(p => [p.name, p.what]));
      files.forEach(f => {
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', '🕳 ' + f.file + (wait.has(f.file) ? ' •' : '')));
        r.appendChild(el('div', 'pj-sub', [f.place ? (f.place.mode === 'anchor' ? `placed at station ${f.place.station}` : `UTM zone ${f.place.zone || '?'}`) : 'not placed yet',
          f.placed ? `by ${f.placed.who || '?'}` : '', loaded.has(f.file) ? 'loaded' : 'not loaded', wait.has(f.file) ? `${wait.get(f.file)} here — 💾 Save puts it in` : ''].filter(Boolean).join(' · ')));
        const row = el('div', 'pj-row');
        if (window._pjf) row.appendChild(btn('Copy CalTopo tag', () => window._pjf.copyTag(f.file), 'small'));
        row.appendChild(btn('Remove from project', async () => { await record('cavefile.set', { file: f.file, removed: true }); await badge(); }, 'small'));
        r.appendChild(row);
        b.appendChild(r);
      });
      layers.forEach(l => {
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', `${icon[l.kind] || '•'} ${l.name || l.url}`));
        r.appendChild(el('div', 'pj-sub', `${kindName(l.kind)} · ${l.url}`));
        const row = el('div', 'pj-row');
        row.appendChild(btn('Remove from project', async () => { await record('layer.set', { layer: l.id, removed: true }); await badge(); }, 'small'));
        r.appendChild(row);
        b.appendChild(r);
      });
      if (W.pending.length) b.appendChild(btn(`💾 Save ${W.pending.length} change${W.pending.length > 1 ? 's' : ''} into the project`, () => save().then(() => A.render && A.render()), 'small primary'));
      // Loaded, not in the project
      const box = el('div'); b.appendChild(box);
      scan().then(({ extra }) => {
        extra.layers = extra.layers.filter(l => l.kind !== 'file');      // data files: 📍 Surface, ← into the project
        if (!extra.layers.length) return;
        box.appendChild(el('div', 'lp-group-label', 'Loaded, not in this project'));
        const add = async (fn, x) => { await fn(x); await refreshAfter('cavefile.set'); A.render && A.render(); toast(`Added “${x.name}” to “${projName()}”`); };
        extra.layers.forEach(l => { const r = el('div', 'pj-item'); r.appendChild(el('div', 'pj-item-t', `${icon[l.kind] || '•'} ${l.name || l.url}`)); r.appendChild(el('div', 'pj-sub', kindName(l.kind))); const row = el('div', 'pj-row'); row.appendChild(btn('＋ Add to project', () => add(addLayer, l), 'small')); r.appendChild(row); box.appendChild(r); });
      });
    });
    const head = document.createElement('div'); head.className = 'lp-group-label'; head.textContent = 'CalTopo map'; head.style.marginTop = '6px';
    root.appendChild(head);
    placeCaltopo(root);
  }

  const st = document.createElement('style');
  st.textContent = '#pj-top-btn.pj-top-on { background: rgba(33,150,243,.55); border-color: #2196F3; color: #fff; }' +
    '#session_save_btn.pj-save-waiting { background: rgba(242,194,78,.85); border-color: #f2c24e; color: #1b1b1b; font-weight: 600; }' +
    '#pj-save-menu { position: fixed; z-index: 9800; width: 300px; background: rgba(20,22,30,.98); color: #e8e8ee; border: 1px solid #f2c24e; border-radius: 8px; padding: 10px 12px; font: 12px system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.5); }' +
    '#pj-loading { position: fixed; inset: 0; z-index: 9990; display: flex; align-items: center; justify-content: center; background: rgba(6,8,12,.55); backdrop-filter: blur(2px); opacity: 0; pointer-events: none; transition: opacity .35s ease; }' +
    '#pj-loading.on { opacity: 1; pointer-events: auto; }' +
    '#pj-loading .pjl-card { width: 340px; background: rgba(18,22,30,.96); border: 1px solid rgba(255,255,255,.12); border-radius: 10px; padding: 18px 20px; color: #e8ece9; font: 13px system-ui, sans-serif; box-shadow: 0 20px 50px rgba(0,0,0,.5); }' +
    '#pj-loading .pjl-k { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: #6fd39a; font-weight: 700; }' +
    '#pj-loading .pjl-t { font-size: 18px; font-weight: 700; margin: 2px 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
    '#pj-loading .pjl-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.1); overflow: hidden; }' +
    '#pj-loading .pjl-bar div { height: 100%; width: 0; border-radius: 3px; background: linear-gradient(90deg, #6fd39a, #9fe3bd); transition: width .25s ease; background-size: 200% 100%; animation: pjl-shine 1.2s linear infinite; }' +
    '@keyframes pjl-shine { from { background-position: 200% 0; } to { background-position: 0 0; } }' +
    '#pj-loading .pjl-s { margin-top: 8px; font-size: 11.5px; color: rgba(255,255,255,.6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 1.2em; }' +
    '#pj-save-menu .pj-save-menu-t { font-weight: 700; margin-bottom: 4px; } #pj-save-menu .pj-save-menu-i { opacity: .85; padding: 1px 0; } #pj-save-menu .pj-row { margin-top: 8px; }';
  document.head.appendChild(st);
  setInterval(() => { if (pj.pid && !W.busy && !W.entering) badge(); }, 5000);

  window._saveAll = saveClick;
  window._pjWs = { placeCaltopo, autosave, save, saveClick, discard, badge, scan, removed, leave, enter, adopt, label, section, unloadProject,
                   owns, moveCave, moving, loadProjectCave, projName, moveItem, movingItem, layerId };
})();
