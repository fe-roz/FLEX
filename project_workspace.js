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
//   - unloading a project's cave or layer only unloads it; "Remove from
//     project" takes it out.
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
  const W = { busy: false, entering: false, pending: [] };
  window._pjWsState = W;                          // tests

  // ── Hashing and ids ──────────────────────────────────────────────────────
  const bytes = t => new TextEncoder().encode(t);
  async function sha(t) {
    const b = bytes(t);
    if (window.crypto && crypto.subtle) { const d = await crypto.subtle.digest('SHA-256', b); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); }
    return FL.sha256(b);
  }
  function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
  const layerId = (kind, url) => 'l' + fnv(kind + '|' + url);
  const placeKey = g => (g ? JSON.stringify(sortDeep(g)) : '');
  function sortDeep(x) { if (Array.isArray(x)) return x.map(sortDeep); if (x && typeof x === 'object') { const o = {}; Object.keys(x).sort().forEach(k => { if (x[k] !== undefined) o[k] = sortDeep(x[k]); }); return o; } return x; }

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

  // ── Changes waiting for 💾 Save, and what is loaded but not in the project ─
  async function scan() {
    const w = ws(), out = { pending: [], extra: { caves: [], layers: [] } };
    if (!pj.pid || !w) return out;
    const S = pj.P;
    for (const c of w.caves()) {
      if (!c.text) continue;
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
  /** Autosave (session.js): the view is saved there; here only the count of waiting changes. */
  async function autosave() { await badge(); }
  async function badge() {
    const b = document.getElementById('session_save_btn');
    if (!b) return;
    W.pending = pj.pid && ws() && !W.entering ? (await scan()).pending : [];
    const n = W.pending.length;
    b.textContent = n ? `💾 Save · ${n}` : '💾 Save';
    b.classList.toggle('pj-save-waiting', !!n);
    b.title = n ? `Save your view, and put ${n} change${n > 1 ? 's' : ''} into “${projName()}”: ${W.pending.map(p => p.name + ' (' + p.what + ')').join(', ')}`
                : (pj.pid ? `Save your view. Nothing waiting for “${projName()}”.` : 'Save your view (camera, layers, what is loaded).');
  }
  /** Unloaded while the project is open: only unloaded; it stays in the project. */
  async function removed(kind, key) {
    if (!pj.pid || W.entering) return;
    const isIn = kind === 'cave' ? inProject.cave(key) : (() => { const l = pj.P.layers[layerId(kind, key)]; return !!(l && !l.removed); })();
    if (isIn) toast('Unloaded; it stays in the project (📁 → What this project loads → Remove from project takes it out)');
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
    if (!pid) { await badge(); return; }      // No project: what is loaded stays as it is
    const snap = await readSnap(pid);
    W.entering = true; w.switching = true;
    try {
      const style = {};
      ((snap && snap.caves) || []).forEach(c => { style[c.name] = c.displayOptions; });
      const missing = [], loaded = new Set(w.caves().map(c => c.name));
      for (const f of FL.liveCavefiles(pj.P)) {
        const r = await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt'));
        if (!r.ok) { missing.push(f.file); continue; }
        if (loaded.has(f.file)) w.removeCave(f.file);                 // the project's version and placement win
        w.loadCave(f.file, await r.text(), f.place || null, style[f.file] || null);
      }
      const layers = FL.liveLayers(pj.P), pcs = new Set(w.pointClouds()), files = new Set(w.dataFiles().map(f => f.url));
      layers.filter(l => l.kind === 'pointcloud' && !pcs.has(l.url)).forEach(l => w.addPointCloud(l.url));
      const ct = layers.filter(l => l.kind === 'caltopo');
      if (ct.length && !(w.caltopo() && w.caltopo().url === ct[0].url)) w.setCaltopo(ct[0].url, ct[0].interval ?? 30);
      if (ct.length > 1) toast(`This project has ${ct.length} CalTopo maps; FLEX shows one at a time (the first)`);
      for (const l of layers.filter(l => l.kind === 'file' && !files.has(l.url))) await w.addDataFile(l.url, l.name, { noKeep: true });
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
      if (snap && snap.camera) w.restoreView(snap);
      else if (!startup && (window._caveImports || []).length) setTimeout(() => window._flyToCave && window._flyToCave(0), 300);
    } finally { w.switching = false; W.entering = false; label(); await badge(); }
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
      b.appendChild(el('div', 'pj-note', 'Opening the project loads all of these. Changes to them (a cave moved, a new survey file) wait for 💾 Save. Unloading one only unloads it; Remove from project takes it out. Placement is shared; colours and styles are yours.'));
      const files = FL.liveCavefiles(pj.P), layers = FL.liveLayers(pj.P);
      if (!files.length && !layers.length) b.appendChild(el('div', 'pj-note', 'Nothing in the project yet: load caves, point clouds, a CalTopo map, then ＋ Add them below.'));
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
        if (!extra.caves.length && !extra.layers.length) return;
        box.appendChild(el('div', 'lp-group-label', 'Loaded, not in this project'));
        const add = async (fn, x) => { await fn(x); await refreshAfter('cavefile.set'); A.render && A.render(); toast(`Added “${x.name}” to “${projName()}”`); };
        extra.caves.forEach(c => { const r = el('div', 'pj-item'); r.appendChild(el('div', 'pj-item-t', '🕳 ' + c.name)); const row = el('div', 'pj-row'); row.appendChild(btn('＋ Add to project', () => add(addCave, c), 'small')); r.appendChild(row); box.appendChild(r); });
        extra.layers.forEach(l => { const r = el('div', 'pj-item'); r.appendChild(el('div', 'pj-item-t', `${icon[l.kind] || '•'} ${l.name || l.url}`)); r.appendChild(el('div', 'pj-sub', kindName(l.kind))); const row = el('div', 'pj-row'); row.appendChild(btn('＋ Add to project', () => add(addLayer, l), 'small')); r.appendChild(row); box.appendChild(r); });
      });
    });
    const head = document.createElement('div'); head.className = 'lp-group-label'; head.textContent = 'CalTopo map'; head.style.marginTop = '6px';
    root.appendChild(head);
    placeCaltopo(root);
  }

  const st = document.createElement('style');
  st.textContent = '#pj-top-btn.pj-top-on { background: rgba(33,150,243,.55); border-color: #2196F3; color: #fff; }' +
    '#session_save_btn.pj-save-waiting { background: rgba(242,194,78,.85); border-color: #f2c24e; color: #1b1b1b; font-weight: 600; }';
  document.head.appendChild(st);
  setInterval(() => { if (pj.pid && !W.busy && !W.entering) badge(); }, 5000);

  window._saveAll = save;
  window._pjWs = { placeCaltopo, autosave, save, badge, scan, removed, leave, enter, adopt, label, section, unloadProject };
})();
