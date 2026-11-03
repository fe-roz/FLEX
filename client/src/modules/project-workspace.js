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
//   - something loaded that isn't in the project is added on its own row:
//     ← in 🕳 Caves and 📍 Surface (the CalTopo map too), 📁 on a point cloud
//     in ☁ LiDAR, ＋ in 🗺 Layers; or by starting a new project with what is
//     loaded.
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
   * 📍 Surface (surface-columns.js): a sitting's points ('pgroup'), one point
   * ('point') or a data file ('file') to the project ('in') or My data ('out').
   * m = { kind, id, name, dir, url? }. The same again cancels it.
   */
  const readOnly = () => { if (!pj.readonly) return false; toast(pj.mode === 'snapshot' ? 'A snapshot is read-only: leave it to change the project' : 'This project is archived (read-only): unarchive it first'); return true; };
  async function moveItem(m) {
    if (!pj.pid || readOnly()) return;
    const k = W.moves.findIndex(x => x.kind === m.kind && x.id === m.id);
    if (k >= 0) W.moves.splice(k, 1); else W.moves.push(m);
    saveMoves();
    await badge();
  }
  const movingItem = (kind, id) => (W.moves.find(x => x.kind === kind && x.id === id) || {}).dir || null;
  /** ← / →: a cave to the project ('in') or to My data ('out'); the same again cancels it. */
  async function moveCave(name, dir) {
    if (!pj.pid || readOnly()) return;
    const other = W.moves.findIndex(m => m.kind === 'cave' && m.name === name);
    if (other >= 0) W.moves.splice(other, 1);
    const saved = inProject.cave(name);
    if ((dir === 'in' && !saved) || (dir === 'out' && saved)) W.moves.push({ kind: 'cave', name, dir });
    saveMoves();
    await badge();
  }

  // ── Area labels of the project's caves (flexlib arealabel.set) ───────────
  // A cave saved in the project keeps its area labels there, like its points:
  // adding, moving, renaming and deleting one goes straight into the project
  // (undo in History) and travels with it (sync files, other computers). A
  // cave in My data keeps them in its look (displayOptions.areaLabels), as
  // before. Labels a project cave still has in its look (My data's, or an
  // older view) move in once, under ids made from what they are: no
  // duplicates, and one deleted in the project doesn't come back from an old
  // copy. Moving a cave in or out takes its labels along (commit below).
  const impOf = name => (window._caveImports || []).find(i => i && i.parsed && i.name === name) || null;
  const lbState = a => FL.areaLabelState(a);
  const round = x => +(+x).toFixed(3);
  const LBL = {
    /** Are this cave's labels the project's? (saved in it; a move waiting for 💾 Save changes it then) */
    owns: name => !!(pj.pid && pj.P && inProject.cave(name)),
    /** The project's labels of a cave, then any still in its look and not moved in yet. [{ id, text, n, e, v }] */
    list(name) {
      const out = FL.areaLabelsOf(pj.P, name).map(a => ({ id: a.id, text: a.text, n: a.n, e: a.e, v: a.v }));
      const imp = impOf(name);
      ((imp && imp.displayOptions && imp.displayOptions.areaLabels) || []).forEach(lb => {
        if (lb && lb.text && !pj.P.arealabels[lb.id || FL.areaLabelId(name, lb)] && !match(name, lb, true)) out.push({ id: lb.id || FL.areaLabelId(name, lb), text: String(lb.text), n: +lb.n, e: +lb.e, v: +lb.v, local: true });
      });
      return out;
    },
    async add(name, lb) {
      if (!(await LBL.migrate(name))) return null;
      const label = FL.uid(12);
      return record('arealabel.set', { label, file: name, text: lb.text, n: round(lb.n), e: round(lb.e), v: round(lb.v), prev: null });
    },
    /** patch: { text } or { n, e, v } */
    async set(name, id, patch) {
      if (!(await LBL.migrate(name))) return null;
      const a = pj.P.arealabels[id];
      if (!a) return null;
      const d = {};
      if (patch.text != null) d.text = String(patch.text);
      ['n', 'e', 'v'].forEach(k => { if (patch[k] != null) d[k] = round(patch[k]); });
      return record('arealabel.set', Object.assign({ label: id, file: name, prev: lbState(a), base: a.history.slice(-1) }, d));
    },
    async remove(name, id) {
      if (!(await LBL.migrate(name))) return null;
      const a = pj.P.arealabels[id];
      if (!a || a.removed) return null;
      return record('arealabel.set', { label: id, file: name, removed: true, prev: lbState(a), base: a.history.slice(-1) });
    },
    /**
     * Labels in a project cave's look into the project (once). given: labels
     * from elsewhere (My data's copy of a cave moving in); revive: those the
     * project had removed come back (a cave moved out and in again). Returns
     * false only when it couldn't (no author given).
     */
    async migrate(name, given, { revive = false, ask = true } = {}) {
      if (!LBL.owns(name)) return true;
      const imp = impOf(name);
      const own = (imp && imp.displayOptions && imp.displayOptions.areaLabels) || [];
      const src = (given || []).concat(own).filter(lb => lb && lb.text);
      if (!src.length) return true;
      if (!(A.who && A.who()) && !(ask && (await A.ensureAuthor()))) return false;
      let n = 0;
      for (const lb of src) {
        const id = lb.id || FL.areaLabelId(name, lb), cur = pj.P.arealabels[id] || match(name, lb, true);
        if (cur && !(revive && cur.removed)) continue;
        const e = await record('arealabel.set', { label: cur ? cur.id : id, file: name, text: String(lb.text), n: round(lb.n), e: round(lb.e), v: round(lb.v),
          removed: false, prev: cur ? lbState(cur) : null, base: cur ? cur.history.slice(-1) : undefined }, null, { quiet: true });
        if (!e) return false;
        A.refresh && A.refresh('arealabel.set');       // the next label sees this one (no duplicates in one go)
        n++;
      }
      if (imp && imp.displayOptions) { delete imp.displayOptions.areaLabels; if (window._sessionSave && !W.entering) window._sessionSave(); }
      if (n) console.log(`[workspace] ${n} area label(s) of “${name}” moved into the project`);
      return true;
    },
    /** A cave just loaded (flex.js): a project cave's old labels move in, if its author is known. */
    loaded(name) { if (LBL.owns(name)) setTimeout(() => LBL.migrate(name, null, { ask: false }).catch(e => console.warn('[workspace] area labels', e)), 0); },
  };
  // A project label of this cave with the same name at the same spot (within 0.5 m); any: removed ones too.
  function match(name, lb, any) {
    return Object.values(pj.P.arealabels || {}).find(a => a.file === name && (any || !a.removed) && a.text === String(lb.text) &&
      Math.hypot(a.n - lb.n, a.e - lb.e, a.v - lb.v) < 0.5) || null;
  }
  window._pjLabels = LBL;

  // ── Changes waiting for 💾 Save, and what is loaded but not in the project ─
  async function scan() {
    const w = ws(), out = { pending: [], extra: { caves: [], layers: [] } };
    if (!pj.pid || !w) return out;
    const S = pj.P;
    W.moves.forEach(m => out.pending.push({ kind: 'move', move: m, name: m.name, dir: m.dir, what: m.kind === 'cavemove' ? 'to ' + (m.toName || 'another project') : m.dir === 'in' ? 'into the project' : 'out to My data' }));
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
    if (p.kind === 'move' && p.move && p.move.kind === 'cavemove') return commitCaveMove(p.move);
    if (p.kind === 'move' && p.move && p.move.kind === 'feats') return commitFeats(p.move);
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
        A.refresh && A.refresh('cavefile.set');
        await LBL.migrate(p.name, (!c && r && r.displayOptions && r.displayOptions.areaLabels) || [], { revive: true });   // its area labels come along
        w.forgetRecent(p.name);
      } else {
        // To My data first, then out of the project: never in neither.
        const f = pj.P.cavefiles[p.name];
        let text = c && c.text;
        if (!text && f && f.h) { const r = await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt')); if (r.ok) text = await r.text(); }
        if (!text) throw new Error(`the survey file of “${p.name}” isn’t on this computer`);
        // Its area labels go along (into its look in My data), then leave the project.
        const labels = FL.areaLabelsOf(pj.P, p.name);
        const imp = impOf(p.name), look = imp && imp.displayOptions ? imp.displayOptions : (c && c.displayOptions ? JSON.parse(JSON.stringify(c.displayOptions)) : null);
        if (labels.length && look) look.areaLabels = labels.map(a => ({ id: a.id, text: a.text, n: a.n, e: a.e, v: a.v })).concat((look.areaLabels || []).filter(lb => !labels.some(a => a.id === lb.id)));
        w.keepRecent(p.name, text, c ? c.georef : (f && f.place), look || (labels.length ? { areaLabels: labels.map(a => ({ id: a.id, text: a.text, n: a.n, e: a.e, v: a.v })) } : null));
        await record('cavefile.set', { file: p.name, removed: true }, null, { quiet: true });
        for (const a of labels) await record('arealabel.set', { label: a.id, file: p.name, removed: true, prev: lbState(a), base: a.history.slice(-1) }, null, { quiet: true });
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


  // ── A cave to another project (doc 14, rule 9) ───────────────────────────
  // Queued here like any move; 💾 Save asks the server (library.js moveCave) to copy the cave with its files, notes,
  // leads, segments, area labels and documents into the other project, then lets it go from this one, each keeping a
  // record ("moved to … / moved in from …", in History). Files are copied, never deleted. Repeating it adds nothing.
  const cavesOfFile = name => FL.liveCaves(pj.P).filter(c => (c.sources || []).some(s => s.file === name) || pj.P.aliases[name] === c.id);
  const queuedCaveMove = cid => W.moves.find(m => m.kind === 'cavemove' && m.id === cid) || null;
  async function otherProjects() {
    const list = (pj.projects || []).filter(p => p.id !== pj.pid && !p.archived);
    const X = (window._pjx && window._pjx.state) || {};
    return list.filter(p => !(X.info && X.info[p.id] && X.info[p.id].archived));
  }
  /**
   * Split a cave of a multi-cave file into a survey file of its own: a PLT holding only that cave's surveys (written by
   * survey-export.js, read back by FLEX's parser to check it), stored as a new project survey file with the parent's
   * placement (so nothing moves), the cave pointed at it, its surveys no longer the parent's. The parent file itself is
   * never changed. Returns the new file's name, or null.
   */
  async function splitCave(fileName, cid, opts) {
    opts = opts || {};
    if (!pj.pid || readOnly()) return null;
    const c = pj.P.caves[cid], f = pj.P.cavefiles[fileName], SE = window._surveyExport, w = ws();
    const src = c && (c.sources || []).find(x => x.file === fileName);
    if (!c || c.removed || !f || f.removed || !src || !SE || !w || !w.parse) return null;
    if (!src.surveys || !src.surveys.length) { toast('This cave holds the whole file already: nothing to split'); return null; }
    if (!opts.yes) {
      const ok = await choose(`Split “${c.name}” into its own file?`, `A new survey file with only its ${src.surveys.length} survey${src.surveys.length === 1 ? '' : 's'} is made, placed where the big file is placed, so nothing moves. “${fileName}” itself is not changed. History can undo it.`,
        [{ label: 'Split it', value: 'yes', primary: true }]);
      if (ok !== 'yes') return null;
    }
    let parsed = (impOf(fileName) || {}).parsed;
    if (!parsed) { const r = f.h && await fetch('/api/lib/blob/' + f.h + '.' + (f.ext || 'plt')); if (r && r.ok) parsed = w.parse(await r.text()); }
    if (!parsed) { toast(`The survey file “${fileName}” isn’t on this computer yet`); return null; }
    const sub = SE.subset(parsed, src.surveys);
    const text = SE.plt(SE.model(sub, { name: c.name }));
    const back = w.parse(text), nodes = x => x.segments.reduce((n, g) => n + g.points.length, 0);
    if (!back || !nodes(back) || nodes(back) !== nodes(sub)) { toast('Could not write this cave’s surveys as a file of its own (nothing was changed)'); return null; }
    const base = (c.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'Cave').slice(0, 60);
    let name = base + '.plt', k = 2;
    while (pj.P.cavefiles[name] || pj.P.aliases[name]) name = base + ' ' + (k++) + '.plt';
    const h = await sha(text);
    await fetch('/api/lib/blob?ext=plt&h=' + h + '&project=' + encodeURIComponent(pj.pid), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes(text) });
    await record('cavefile.set', { file: name, h, ext: 'plt', place: f.place || null, removed: false, split: fileName }, null, { quiet: true });
    await record('cave.set', { cave: cid, sources: (c.sources || []).filter(x => x.file !== fileName).concat([{ file: name }]), prevSources: JSON.parse(JSON.stringify(c.sources || [])) }, null, { quiet: true });
    await refreshAfter('cavefile.set');
    if (w.caveIndex(fileName) >= 0) await loadProjectCave(name);
    toast(`“${c.name}” is now its own file, “${name}”`);
    return name;
  }
  async function askCaveMove(fileName, cid) {
    if (!pj.pid || readOnly()) return;
    let cs = cavesOfFile(fileName);
    if (!cs.length) { toast('This file isn’t a cave of the project yet (⋯ → Caves in this file…)'); return; }
    if (cs.length > 1 || (pj.P.cavefiles[fileName] && pj.P.cavefiles[fileName].multi)) {
      // Caves sharing one file move one at a time, after the cave is split out into a file of its own.
      const part = cs.filter(c => (c.sources || []).some(s => s.file === fileName && s.surveys && s.surveys.length));
      let pick = cid ? part.find(c => c.id === cid) : null;
      if (!pick) {
        if (!part.length) { toast('No cave of this multi-cave survey file has its own surveys yet (⋯ → Multi-cave file…)'); return; }
        const v = await choose('Move which cave?', 'This is a multi-cave survey file: its caves share one file. A cave is split into a file of its own first, then moves.',
          part.map(c => ({ label: ['cave', 'Split “' + c.name + '” into its own file, then move'], value: c.id })));
        pick = part.find(c => c.id === v);
        if (!pick) return;
      } else {
        const v = await choose(`Move “${pick.name}” to another project?`, 'This is a multi-cave survey file: its caves share one file, so a cave can’t move on its own. It can be split into a file of its own first, then moved.',
          [{ label: 'Split into its own file, then move', value: 'split', primary: true }]);
        if (v !== 'split') return;
      }
      const nf = await splitCave(fileName, pick.id, { yes: true });
      if (nf) await askCaveMove(nf);
      return;
    }
    const c = cs[0], q = queuedCaveMove(c.id);
    if (q) { W.moves = W.moves.filter(x => x !== q); saveMoves(); toast(`The move of “${c.name}” is cancelled`); await badge(); return; }
    const dests = await otherProjects();
    if (!dests.length) { toast('There is no other project to move it to (archived projects are read-only)'); return; }
    let pv = null;
    try { pv = await (await fetch(`/api/lib/move-preview?from=${encodeURIComponent(pj.pid)}&cave=${encodeURIComponent(c.id)}`)).json(); } catch (_) {}
    if (pv && pv.shared && pv.shared.length) { toast(`“${pv.shared[0]}” is a survey file shared with another cave, so “${c.name}” can’t move on its own. Moving a cave out into its own file comes later.`); return; }
    const to = await choose(`Move “${c.name}” to…`, 'The cave goes with its survey files, notes, leads, segments, area labels, sketches and documents.',
      dests.map(p => ({ label: ['folder', p.name || p.id], value: p.id })));
    if (!to) return;
    const dest = dests.find(p => p.id === to), n = pv && pv.counts ? pv.counts : null;
    const what = n ? [n.files + ' survey file' + (n.files === 1 ? '' : 's'), n.notes + ' note' + (n.notes === 1 ? '' : 's'), n.leads + ' lead' + (n.leads === 1 ? '' : 's'), n.segments + ' segment' + (n.segments === 1 ? '' : 's'), n.docs + ' document' + (n.docs === 1 ? '' : 's')].join(', ') : 'its data';
    const ok = await choose(`Move “${c.name}” to “${dest.name || dest.id}”?`, `Goes along: ${what}. “${projName()}” keeps a record (“moved to ${dest.name || dest.id}”) and so does the other project. Nothing is deleted: the files are copied. It moves when you press 💾 Save.`,
      [{ label: 'Move it (on Save)', value: 'yes', primary: true }]);
    if (ok !== 'yes') return;
    W.moves.push({ kind: 'cavemove', id: c.id, name: c.name, files: cs.length ? (c.sources || []).map(s => s.file) : [fileName], to, toName: dest.name || dest.id, move: FL.uid(12), dir: 'project' });
    saveMoves();
    await badge();
    toast(`“${c.name}” will move to “${dest.name || dest.id}” when you Save`);
  }
  async function commitCaveMove(m) {
    const r = await fetch(`/api/lib/move-cave?from=${encodeURIComponent(pj.pid)}&to=${encodeURIComponent(m.to)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cave: m.id, move: m.move, who: A.who && A.who() }) });
    const o = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(o.error || ('move failed (' + r.status + ')'));
    const w = ws(), names = new Set(m.files || []);
    Object.keys(pj.P.aliases).filter(a => pj.P.aliases[a] === m.id && pj.P.cavefiles[a]).forEach(f => names.add(f));
    w.switching = true;
    try { [...names].forEach(f => { if (w.caveIndex(f) >= 0) w.removeCave(f); }); } finally { w.switching = false; }
    W.moves = W.moves.filter(x => x !== m && !(x.kind === 'cavemove' && x.id === m.id));
    saveMoves();
    await A.reload();
    if (window._pjx && window._pjx.forget) { window._pjx.forget(pj.pid); window._pjx.forget(m.to); }
    toast(`“${m.name}” moved to “${m.toName}”`);
  }

  // ── Surface features back to My data ───────────────────────────────────────
  // A folder (with the folders in it), the features not in a folder, or single ones. Waits for 💾 Save; then they are
  // made in My data (kept across projects, one home) and removed from the project (History can bring them back).
  const featsOf = m => {
    const all = FL.liveFeatures(pj.P);
    if (m.id === 'loose') return all.filter(f => !f.group);
    if (m.id.startsWith('g:')) return all.filter(f => FL.groupPath(pj.P, f.group).some(g => g.id === m.id.slice(2)));
    if (m.id.startsWith('f:')) return all.filter(f => f.id === m.id.slice(2));
    return [];
  };
  async function queueFeatures(items) {
    if (!pj.pid || readOnly()) return 0;
    let n = 0;
    for (const it of items) { if (!W.moves.some(x => x.kind === 'feats' && x.id === it.id)) { W.moves.push(Object.assign({ kind: 'feats', dir: 'out' }, it)); n++; } }
    saveMoves(); await badge();
    return n;
  }
  async function commitFeats(m) {
    const MD = window._myData;
    if (!MD || !MD.adopt) throw new Error('My data is not available');
    const feats = featsOf(m);
    const pname = projName();
    const groupName = f => { const path = FL.groupPath(pj.P, f.group); return path.length ? path.map(g => g.name || 'Folder').join(' / ') : 'From ' + pname; };
    const color = f => (f.style && f.style.color) || ((FL.groupPath(pj.P, f.group).reverse().find(g => g.color) || {}).color) || null;
    const items = feats.map(f => ({ id: f.id, kind: f.kind, coords: f.coords, name: f.name || '', desc: f.desc || '', group: groupName(f), color: color(f), style: f.style || null }));
    await MD.adopt(items);                                      // made in My data first: never in neither
    for (const f of feats) await record('feature.set', { feature: f.id, removed: true, movedTo: 'mydata' }, null, { quiet: true });
    if (m.id.startsWith('g:')) {
      const gone = new Set([m.id.slice(2)]);
      FL.liveGroups(pj.P).forEach(g => { if (FL.groupPath(pj.P, g.id).some(x => x.id === m.id.slice(2))) gone.add(g.id); });
      for (const g of gone) await record('group.set', { group: g, removed: true }, null, { quiet: true });
    }
    W.moves = W.moves.filter(x => !(x.kind === m.kind && x.id === m.id));
    saveMoves();
    A.refresh && A.refresh('feature.set');
    if (window._pjf) window._pjf.draw();
    toast(`${feats.length} feature${feats.length === 1 ? '' : 's'} moved to My data`);
  }

  // ── 💾 Save ──────────────────────────────────────────────────────────────
  /** The Save button: your view, and the waiting project changes. */
  async function save() {
    if (window._sessionSave) window._sessionSave();
    if (!pj.pid || W.busy) return 0;
    if (readOnly()) return 0;
    if (!(A.who && A.who()) && !(await A.ensureAuthor())) return 0;
    W.busy = true;
    let n = 0;
    try {
      const { pending } = await scan();
      const late = p => (p.move && p.move.kind === 'cavemove' ? 1 : 0);     // a cave goes to the other project last, with its placement and file already saved
      pending.sort((a, b) => late(a) - late(b));
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
          if (cur && p.l.kind === 'caltopo') w.setCaltopo(cur.url, cur.interval ?? 60);
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
    let style = (st && st.displayOptions) || mineStyle(name);
    if (f.surface && f.surface.length) {           // surveys the project marked as surface traverses (multi-cave files)
      style = Object.assign({}, style || {}); style.surfaceSurveys = Object.assign({}, style.surfaceSurveys);
      f.surface.forEach(c => { style.surfaceSurveys[c] = true; });
    }
    try { w.loadCave(name, await r.text(), f.place || null, style); } finally { w.switching = false; }
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
    row.appendChild(btn(['save', 'Save into the project'], async () => { m.remove(); await save(); A.render && A.render(); }, 'small primary'));
    row.appendChild(btn('Discard', async () => { m.remove(); await discardAsk(); }, 'small'));
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
    (b.querySelector('.tb-l') || b).textContent = n ? `Save · ${n}` : 'Save';   // the label beside the icon (icons.js)
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
    if (isIn) toast('Unloaded; it stays in the project (Caves: → moves it to My data)');
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
      // Precise terrain first, so what is loaded after it (caves, features) stands on it.
      if (layers.some(l => l.kind === 'terrain') && window._customLayers) { await L.step('Terrain'); await withTimeout(window._customLayers.sync(true), 60000); }
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
      if (ct.length && !(w.caltopo() && w.caltopo().url === ct[0].url)) await withTimeout(w.setCaltopo(ct[0].url, ct[0].interval ?? 60), 15000);
      if (ct.length > 1) toast(`This project has ${ct.length} CalTopo maps; FLEX shows one at a time (the first)`);
      for (const l of layers.filter(l => l.kind === 'file')) { await L.step('Data file: ' + (l.name || '')); if (!files.has(l.url)) await w.addDataFile(l.url, l.name, { noKeep: true }); }
      for (const l of layers.filter(l => !['pointcloud', 'caltopo', 'file'].includes(l.kind))) await L.step(l.name || 'Layer');
      if (layers.some(l => l.kind === 'imagery' || l.kind === 'tiles' || l.kind === 'terrain') && window._customLayers) await withTimeout(window._customLayers.sync(true), 10000);   // map layers: custom-layers.js
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
        if (!shown && (total > 1 || box.classList.contains('on') || Date.now() - t0 > 300)) { shown = true; box.classList.add('on'); }
        bar.style.width = Math.min(100, Math.round(100 * n / Math.max(1, total))) + '%';
        sub.textContent = text || '';
        await tick();
      },
      done() { bar.style.width = '100%'; box.classList.remove('on'); },
    };
  }
  /** The loading screen at once when a project is chosen (reading its library
   *  comes before enter()); null hides it. */
  function opening(pid) {
    if (!pid) { const b = document.getElementById('pj-loading'); if (b) b.classList.remove('on'); return; }
    const p = ((window._pj || {}).projects || []).find(x => x.id === pid);
    const L = loading((p && p.name) || 'Project', 1);
    document.getElementById('pj-loading').classList.add('on');
    L.step('Reading the project…');
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
    for (const c of extra.caves) await LBL.migrate(c.name);            // their area labels come along
    window._sessionSave && window._sessionSave(); label();
  }

  // ── The project button (top left, next to Save) ──────────────────────────
  function label() {
    const b = document.getElementById('pj-top-btn');
    if (!b) return;
    const name = pj.pid ? projName() : 'No project';
    window.iconLabel(b, ['folder', name], 16);
    b.title = pj.pid ? `Project “${name}”: caves, layers, CalTopo, notes, leads, documents. Save puts changes into it.` : 'No project open: your own caves and points (My data). Open or create a project here.';
    b.classList.toggle('pj-top-on', !!pj.pid);
    if (window._renderPcList) window._renderPcList();     // ☁ LiDAR rows: their 📁
    placeCaltopo();
  }

  // ── The CalTopo map's link-and-key section ──────────────────────────────
  // It lives in 📍 Surface ("CalTopo map: link and key"). With no project it
  // shows only while a map is still loaded (so it can be cleared); otherwise
  // it is put away. With a project open it is always there (📁 Project's
  // Connected block points to it to add a map).
  let ctNode = null, ctSlot = null, ctHold = null;
  function placeCaltopo() {
    if (!ctNode) {
      const body = document.getElementById('lp-caltopo-body');
      ctNode = body && body.closest('.lp-section');
      if (!ctNode) return;
      ctSlot = document.createComment('caltopo');
      ctNode.parentNode.insertBefore(ctSlot, ctNode);
      ctHold = document.createElement('div'); ctHold.style.display = 'none'; document.body.appendChild(ctHold);
    }
    const loaded = !!(window._ws && window._ws.caltopo());
    if (pj.pid || loaded) { if (ctNode.previousSibling !== ctSlot) ctSlot.parentNode.insertBefore(ctNode, ctSlot.nextSibling); }
    else ctHold.appendChild(ctNode);
  }

  // ── What used to be "What this project loads", now on each thing's row ───
  /** Discard, asked first (📁 Project's Unsaved changes, the Save menu). */
  async function discardAsk() {
    const { pending } = pj.pid ? await scan() : { pending: [] };
    if (!pending.length) return 0;
    const ok = await choose(`Discard ${pending.length} change${pending.length > 1 ? 's' : ''}?`, '“' + projName() + '” stays as it was saved; moved caves stay where they were.', [{ label: 'Discard them', value: 'yes', primary: true }, { label: 'Keep them', value: 'no' }]);
    if (ok !== 'yes') return 0;
    const n = await discard(); A.render && A.render();
    return n;
  }
  /** A project cave file out of the project (not to My data: → does that). */
  async function removeCaveFile(name) {
    const ok = await choose(`Remove “${name}” from “${projName()}”?`, 'It leaves the project (its history keeps it). To keep it as your own, use → (to My data) instead.', [{ label: 'Remove from project', value: 'yes', primary: true }]);
    if (ok !== 'yes') return false;
    await record('cavefile.set', { file: name, removed: true });
    await badge();
    return true;
  }
  /**
   * 🕳 Caves → a row's ⋯ (cave-columns.js): the project's actions for a cave
   * file. [[label, fn, title]].
   */
  function caveMenu(name, loaded) {
    if (!pj.pid || !pj.P) return [];
    const out = [], saved = inProject.cave(name) && !moving(name, 'out');
    if (saved && window._pjf) out.push(['Copy CalTopo tag', () => window._pjf.copyTag(name), 'A line for the entrance marker’s description in CalTopo: FLEX places the cave there']);
    const imp = loaded && (window._caveImports || []).find(i => i && i.parsed && i.name === name);
    if (saved && window._pjMulti && FL.liveCaves(pj.P).some(c => (c.sources || []).some(s => s.file === name)) && imp)
      out.push([(pj.P.cavefiles[name] || {}).multi ? 'Multi-cave file…' : 'Mark as multi-cave file…', () => window._pjMulti.multiCave(imp), 'Several caves in one survey file: name them, sort the file’s surveys into them, mark surface traverses']);
    if (imp && owns(name) && A.linkFile) out.push(['Caves in this file…', () => A.linkFile(imp), 'Which project cave this file is, or split it into the caves FLEX finds inside it']);
    // The project caves made of this file (name, what they are made of, remove).
    FL.liveCaves(pj.P).filter(c => (c.sources || []).some(s => s.file === name)).slice(0, 4)
      .forEach(c => A.editCave && out.push([`Cave “${c.name}”…`, () => A.editCave(c.id), 'Rename it, see what it is made of, put it in a system']));
    if (saved && FL.liveCaves(pj.P).some(c => (c.sources || []).some(s => s.file === name) || pj.P.aliases[name] === c.id)) {
      const q = cavesOfFile(name).map(c => queuedCaveMove(c.id)).find(Boolean);
      out.push([q ? `Cancel the move to ${q.toName}` : 'Move to another project…', () => askCaveMove(name), 'The cave with its files, notes, leads, segments, labels, sketches and documents; it moves on Save, each project keeping a record']);
    }
    if (saved) out.push(['Remove from project', () => removeCaveFile(name), 'Out of the project (→ moves it to My data instead)']);
    return out;
  }
  /**
   * ☁ LiDAR's point cloud rows (flex.js renderPcList): 📁 on each, lit when
   * the cloud is in the open project. Click: add it / remove it.
   */
  function pcRow(row, url) {
    if (!pj.pid || !pj.P || !url || !row) return;
    const id = layerId('pointcloud', url), cur = pj.P.layers[id], isIn = !!(cur && !cur.removed);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'lp-pj-btn' + (isIn ? ' on' : ''); b.innerHTML = window.icon('folder', 14);
    b.title = isIn ? `In “${projName()}” (click to remove it from the project)` : `Add to “${projName()}”`;
    b.addEventListener('click', async e => {
      e.stopPropagation();
      if (isIn) {
        const ok = await choose(`Remove this point cloud from “${projName()}”?`, 'It stays loaded; opening the project won’t load it any more.', [{ label: 'Remove from project', value: 'yes', primary: true }]);
        if (ok !== 'yes') return;
        await record('layer.set', { layer: id, removed: true });
      } else {
        const name = url.replace(/\/ept\.json.*$/i, '').split('/').filter(Boolean).pop() || url;
        await addLayer({ kind: 'pointcloud', url, name });
        await refreshAfter('layer.set');
        toast(`Added “${name}” to “${projName()}”`);
      }
      if (window._renderPcList) window._renderPcList();
    });
    const rm = row.querySelector('.lp-remove-btn');
    row.insertBefore(b, rm || null);
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
    '.lp-pj-btn { background: none; border: none; padding: 0 3px; cursor: pointer; opacity: .3; filter: grayscale(1); font-size: 12px; } .lp-pj-btn:hover { opacity: .8; } .lp-pj-btn.on { opacity: 1; filter: none; }' +
    '#pj-save-menu .pj-save-menu-t { font-weight: 700; margin-bottom: 4px; } #pj-save-menu .pj-save-menu-i { opacity: .85; padding: 1px 0; } #pj-save-menu .pj-row { margin-top: 8px; }';
  document.head.appendChild(st);
  setInterval(() => { if (pj.pid && !W.busy && !W.entering) badge(); }, 5000);

  window._saveAll = saveClick;
  window._pjWs = { opening, placeCaltopo, autosave, save, saveClick, discard, discardAsk, badge, scan, removed, leave, enter, adopt, label, unloadProject,
                   owns, moveCave, moving, loadProjectCave, projName, moveItem, movingItem, layerId, addLayer, caveMenu, pcRow, removeCaveFile,
                   askCaveMove, splitCave, queueFeatures, featsOf, addCave, mineStyle, labels: LBL, readOnly };
})();
