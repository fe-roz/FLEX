// A project as the workspace (project doc 13).
//
// With a project open, what FLEX loads belongs to the project: its survey
// files (stored in the library by hash, so a sync file carries them) and where
// each is placed, its point clouds, CalTopo map and URL data files. Opening a
// project unloads what was on screen and loads the project's things; closing
// it (No project) brings back the free scene as it was. Save and autosave
// write what changed into the project; removing something while the project
// is open removes it from the project. Camera, layers, styles are personal:
// a session per project (session.js).
//
// "No project" is FLEX as it always was: nothing here runs then.
//
// Uses project.js (window._pjApi) and flex.js (window._ws).
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) { console.warn('[workspace] project.js missing'); return; }
  const { pj, FL, el, btn, esc, toast, dialog, record } = A;
  const ws = () => window._ws;
  const wait = async (cond, ms = 30000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 150)); } return true; };
  const W = { busy: false, entering: false, last: '' };
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
  const stable = o => JSON.stringify(o, Object.keys(o || {}).sort());
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

  // ── Save: record what changed (adds and changes; removing is explicit) ───
  async function autosave() {
    const w = ws();
    if (!pj.pid || !w || w.switching || W.busy || W.entering) return;
    if (!(window._pjApi.who && window._pjApi.who())) return;     // no name yet: saved once one is set
    W.busy = true;
    try {
      const S = pj.P;
      for (const c of w.caves()) {
        if (!c.text) continue;
        const h = await sha(c.text);
        const cur = S.cavefiles[c.name];
        if (!cur || cur.removed || cur.h !== h) {
          await fetch('/api/lib/blob?ext=plt&h=' + h, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes(c.text) });
          await record('cavefile.set', { file: c.name, h, ext: 'plt', place: c.georef || null, removed: false });
        } else if (placeKey(cur.place) !== placeKey(c.georef)) {
          await record('cavefile.set', { file: c.name, place: c.georef || null });
        }
        // Notes, leads and documents hang on caves: a file nobody's cave covers becomes one.
        const covered = FL.liveCaves(pj.P).some(cv => (cv.sources || []).some(s => s.file === c.name)) || pj.P.aliases[c.name];
        if (!covered) {
          const cid = FL.uid(10);
          await record('cave.set', { cave: cid, name: c.name.replace(/\.(plt|json)$/i, '').slice(0, 60), sources: [{ file: c.name }] });
          await record('cave.alias', { cave: cid, alias: c.name });
        }
      }
      let order = FL.liveLayers(pj.P).length;
      for (const l of loadedLayers()) {
        const id = layerId(l.kind, l.url), cur = pj.P.layers[id];
        if (!cur || cur.removed) await record('layer.set', Object.assign({ layer: id, order: order++, removed: false }, l));
        else if (l.interval != null && cur.interval !== l.interval) await record('layer.set', { layer: id, interval: l.interval });
      }
    } catch (e) { console.warn('[workspace] save failed', e); }
    finally { W.busy = false; }
  }
  // Something removed while the project is open: gone from the project too.
  async function removed(kind, key) {
    if (!pj.pid || W.entering) return;
    if (kind === 'cave') {
      const f = pj.P.cavefiles[key];
      if (f && !f.removed) { await record('cavefile.set', { file: key, removed: true }); toast(`Removed “${key}” from the project (undo in 📁 History)`); }
      return;
    }
    const id = layerId(kind, key), l = pj.P.layers[id];
    if (l && !l.removed) { await record('layer.set', { layer: id, removed: true }); toast(`Removed ${l.name || 'it'} from the project (undo in 📁 History)`); }
  }

  // ── Open / close ─────────────────────────────────────────────────────────
  async function unloadAll() {
    const w = ws();
    w.switching = true;
    try {
      w.caves().map(c => c.name).forEach(n => w.removeCave(n));
      w.pointClouds().forEach(u => w.removePointCloud(u));
      if (w.caltopo()) w.clearCaltopo();
      w.dataFiles().forEach(f => w.removeDataFile(f.url));
    } finally { w.switching = false; }
  }
  // Leaving a project (or the free scene): save it as it is, then clear the screen.
  async function leave(pid) {
    if (!(await wait(() => ws() && window._sessionSave))) return;
    if (pid) await autosave();
    window._sessionSave();                   // session of what we leave (key still the old project)
    await unloadAll();
  }
  async function readSnap(pid) { try { return JSON.parse(localStorage.getItem('flex_session_v1' + (pid ? '@' + pid : '')) || 'null'); } catch (_) { return null; } }
  async function enter(pid, { startup = false } = {}) {
    if (!(await wait(() => ws() && window.cesiumViewer && window._sessionSave))) return;
    const w = ws(), snap = await readSnap(pid);
    W.entering = true; w.switching = true;
    try {
      if (!pid) {                            // back to the free scene, as it was
        if (startup) return;                 // flex.js restores it at start, as always
        w.restoreView(snap);
        if (snap) {
          for (const c of snap.caves || []) w.recentCave(c.name);
          (snap.pointClouds || []).forEach(u => w.addPointCloud(u));
          if (snap.caltopoUrl) w.setCaltopo(snap.caltopoUrl, snap.caltopoInterval ?? 30);
          for (const f of snap.dataFiles || []) await w.addDataFile(f.url, f.label);
        }
        return;
      }
      const style = {};
      ((snap && snap.caves) || []).forEach(c => { style[c.name] = c.displayOptions; });
      const missing = [];
      for (const f of FL.liveCavefiles(pj.P)) {
        const r = await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt'));
        if (!r.ok) { missing.push(f.file); continue; }
        w.loadCave(f.file, await r.text(), f.place || null, style[f.file] || null);
      }
      const layers = FL.liveLayers(pj.P);
      layers.filter(l => l.kind === 'pointcloud').forEach(l => w.addPointCloud(l.url));
      const ct = layers.filter(l => l.kind === 'caltopo');
      if (ct.length) w.setCaltopo(ct[0].url, ct[0].interval ?? 30);
      if (ct.length > 1) toast(`This project has ${ct.length} CalTopo maps; FLEX shows one at a time (the first)`);
      for (const l of layers.filter(l => l.kind === 'file')) await w.addDataFile(l.url, l.name);
      if (missing.length) toast(`Survey file(s) not on this computer yet: ${missing.join(', ')} — import the sync file that has them`);
      if (snap && snap.camera) w.restoreView(snap);
      else if (!startup && (window._caveImports || []).length) setTimeout(() => window._flyToCave && window._flyToCave(0), 300);
    } finally { w.switching = false; W.entering = false; label(); }
  }
  // A new project that takes what is on screen now (nothing is unloaded).
  async function adopt() { await autosave(); window._sessionSave && window._sessionSave(); label(); }

  // ── The project button (top left, next to Save) ──────────────────────────
  function label() {
    const b = document.getElementById('pj-top-btn');
    if (!b) return;
    const name = pj.pid ? ((pj.projects.find(p => p.id === pj.pid) || {}).name || pj.P.name || 'Project') : 'No project';
    b.textContent = '📁 ' + name;
    b.title = pj.pid ? `Project “${name}”: caves, layers, CalTopo, notes, leads, documents. Save and autosave keep it up to date.` : 'No project open: FLEX as usual. Open or create a project here.';
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
  function section(root, mk) {
    if (!pj.pid) { placeCaltopo(null); return; }
    mk(root, 'What this project loads', true, b => {
      b.appendChild(el('div', 'pj-note', 'Opening the project loads these; anything you load while it is open is added when you save (💾 or autosave). Removing it here, or from its own panel, removes it from the project. Placement is shared; colours and styles are yours.'));
      const files = FL.liveCavefiles(pj.P), layers = FL.liveLayers(pj.P);
      if (!files.length && !layers.length) {
        const legacy = FL.liveCaves(pj.P).flatMap(c => (c.sources || []).map(s => s.file)).filter(Boolean);
        b.appendChild(el('div', 'pj-note', legacy.length ? `Nothing stored yet. Load ${[...new Set(legacy)].join(', ')} (🕳 Cave → Recent) and save: the survey file and its placement go into the project.` : 'Nothing yet: import or load caves, point clouds, a CalTopo map — they are added when you save.'));
      }
      const loaded = new Set(ws() ? ws().caves().map(c => c.name) : []);
      files.forEach(f => {
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', '🕳 ' + f.file));
        r.appendChild(el('div', 'pj-sub', [f.place ? (f.place.mode === 'anchor' ? `placed at station ${f.place.station}` : `UTM zone ${f.place.zone || '?'}`) : 'not placed yet',
          f.placed ? `by ${f.placed.who || '?'}` : '', loaded.has(f.file) ? 'loaded' : 'not loaded'].filter(Boolean).join(' · ')));
        const row = el('div', 'pj-row');
        if (window._pjf) row.appendChild(btn('Copy CalTopo tag', () => window._pjf.copyTag(f.file), 'small'));
        row.appendChild(btn('Remove from project', async () => { await record('cavefile.set', { file: f.file, removed: true }); ws().switching = true; ws().removeCave(f.file); ws().switching = false; }, 'small'));
        r.appendChild(row);
        b.appendChild(r);
      });
      const icon = { pointcloud: '☁', caltopo: '🗺', file: '📄' };
      layers.forEach(l => {
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', `${icon[l.kind] || '•'} ${l.name || l.url}`));
        r.appendChild(el('div', 'pj-sub', `${l.kind === 'caltopo' ? 'CalTopo map' : l.kind === 'pointcloud' ? 'point cloud' : 'data file'} · ${l.url}`));
        const row = el('div', 'pj-row');
        row.appendChild(btn('Remove from project', async () => {
          await record('layer.set', { layer: l.id, removed: true });
          const w = ws(); w.switching = true;
          try { if (l.kind === 'pointcloud') w.removePointCloud(l.url); else if (l.kind === 'caltopo') w.clearCaltopo(); else w.removeDataFile(l.url); } finally { w.switching = false; }
        }, 'small'));
        r.appendChild(row);
        b.appendChild(r);
      });
      b.appendChild(btn('💾 Save into the project now', () => window._sessionSave && window._sessionSave(), 'small primary'));
    });
    const head = document.createElement('div'); head.className = 'lp-group-label'; head.textContent = 'CalTopo map'; head.style.marginTop = '6px';
    root.appendChild(head);
    placeCaltopo(root);
  }

  const st = document.createElement('style');
  st.textContent = '#pj-top-btn.pj-top-on { background: rgba(33,150,243,.55); border-color: #2196F3; color: #fff; }';
  document.head.appendChild(st);

  window._pjWs = { placeCaltopo,autosave, removed, leave, enter, adopt, label, section, unloadAll };
})();
