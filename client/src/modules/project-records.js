// FLEX project (server calls, author, load / record / replay, switching project, read-only (snapshot, archived)).
// Part of project.js, split into classic scripts that load in order (index.html);
// they share their functions through window._pjParts until project.js has loaded.
// Behaviour unchanged. See client/src/README.md.
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js
  const { API, dialog, pj, FL, toast, $, el, btn } = X;
  // defined in a later part: called only after every part has loaded
  const render = (...a) => X.render(...a);
  const refreshCard = (...a) => X.refreshCard(...a);
  const galleryShow = (...a) => X.galleryShow(...a);
  const drawField = (...a) => X.drawField(...a);
  const drawLeads = (...a) => X.drawLeads(...a);

  // ── Server ─────────────────────────────────────────────────────────────────
  async function api(path, opts) {
    const r = await fetch(API + path, opts);
    const ct = r.headers.get('Content-Type') || '';
    const out = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((out && out.error) || r.statusText);
    return out;
  }
  const post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const parseLines = t => String(t || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const blobUrl = p => API + 'blob/' + p.h + '.' + (p.ext || 'jpg');

  // ── Author ─────────────────────────────────────────────────────────────────
  const who = () => { try { return localStorage.getItem('flex.author') || ''; } catch (_) { return ''; } };
  async function ensureAuthor() {
    if (who()) return who();
    const r = await dialog({ title: 'Who is entering data?', text: 'Everything you add is logged under this name (in FLEX and in the sync files).',
      input: { value: '', placeholder: 'Your name' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Use this name', value: 'ok', primary: true }] });
    if (r && r.value.trim()) { try { localStorage.setItem('flex.author', r.value.trim().slice(0, 40)); } catch (_) {} render(); }
    return who();
  }


  // ── Load, record, replay ───────────────────────────────────────────────────
  // Reading the logs again keeps entries this page recorded meanwhile (a save
  // can land between the read and its answer — e.g. focus coming back from a
  // file picker during an import).
  async function loadAll() {
    const pid = pj.pid;
    pj.projects = await api('projects');
    const at = pj.at, q = at ? '&at=' + encodeURIComponent(at) : '';        // a snapshot: the entries up to then
    const proj = pid ? parseLines(await api('read?scope=' + FL.projScope(pid) + q)) : [];
    const docs = parseLines(await api('read?scope=docs' + q));
    const keep = (fresh, mine) => { const ids = new Set(fresh.map(e => e.id)); return fresh.concat(mine.filter(e => !ids.has(e.id))); };
    if (pid !== pj.pid) return;                                   // switched meanwhile: that load wins
    pj.proj = pid && pj.projPid === pid && !at ? keep(proj, pj.proj) : proj;
    pj.projPid = pid;
    pj.docs = at ? docs : keep(docs, pj.docs);
    replay();
  }
  function replay() {
    pj.P = FL.replayProject(pj.proj, pj.pid || '');
    pj.D = FL.replayDocs(pj.docs);
    pj.mode = pj.pid && pj.at ? 'snapshot' : pj.pid && pj.P.archived ? 'archived' : null;
    pj.readonly = !!pj.mode;
    banner();
    // The project's area labels changed (an edit, undo, a sync file, another
    // project): the caves draw them again (flex.js).
    const al = JSON.stringify(FL.areaLabelsOf(pj.P).map(a => [a.id, a.file, a.text, a.n, a.e, a.v]));
    if (al !== pj._al) { pj._al = al; setTimeout(() => window._refreshAllAreaLabels && window._refreshAllAreaLabels(), 0); }
  }
  /** A change: numbered by the server, then replayed here. */
  // quiet: many in a row (an import) — saved and kept, the screen refreshed once
  // afterwards with refresh().
  async function record(op, data, where, { quiet = false } = {}) {
    if (!pj.pid && where !== 'docs') { toast('Choose or create a project first (Project panel)'); return null; }
    if (pj.readonly) { toast(pj.mode === 'snapshot' ? 'A snapshot is read-only: leave it to change the project' : 'This project is archived (read-only): unarchive it to change it'); return null; }
    if (!(await ensureAuthor())) return null;
    const scope = where === 'docs' ? FL.DOCS : FL.projScope(pj.pid);
    let e;
    try { e = await post('append?scope=' + scope + (where === 'docs' && pj.pid ? '&project=' + encodeURIComponent(pj.pid) : ''), Object.assign({ t: new Date().toISOString(), who: who(), op }, data)); }
    catch (err) { toast('Could not save: ' + err.message); return null; }
    (where === 'docs' ? pj.docs : pj.proj).push(e);
    if (quiet) return e;
    replay();
    afterChange(e);
    return e;
  }
  function refresh(op) { replay(); afterChange({ op: op || 'feature.set' }); }
  function afterChange(e) {
    render();
    refreshCard();
    if (pj.gallery) galleryShow(pj.gallery.i);
    if (/^(survey|shot|cave)\.|^accept$/.test(e.op)) drawField();
    if (/^lead\.|^accept$|^reject$|^feature\./.test(e.op) || /^cave\./.test(e.op)) drawLeads();
    if (window._pjSeg) window._pjSeg.changed(e);
    if (window._pjf) window._pjf.changed(e);
    if (window._info) window._info.changed(e);
  }
  // Switching project: what was on screen is saved and unloaded, the project's
  // things load (project_workspace.js). keep: a new project takes what is on
  // screen now instead.
  async function setProject(pid, { keep = false, at = null } = {}) {
    const prev = pj.pid, snap = pid && at ? String(at) : null, change = (pid || null) !== prev || snap !== (pj.at || null);
    if (change && window._pjWs && !keep && (await window._pjWs.leave(prev)) === false) { render(); return false; }   // stayed (unsaved changes, Cancel)
    pj.pid = pid || null;
    pj.at = snap;
    const shown = change && pid && !keep && window._pjWs && window._pjWs.opening;
    if (shown) window._pjWs.opening(pid);            // the loading screen at once; reading the library comes first
    try {
      try { pid ? localStorage.setItem('flex.project', pid) : localStorage.removeItem('flex.project'); } catch (_) {}
      await loadAll();
      render(); refreshCard(); drawField(); drawLeads();
      if (window._pjSeg) window._pjSeg.changed(null);
      if (window._pjf) window._pjf.changed(null);
      if (change && window._pjWs) { if (keep) await window._pjWs.adopt(); else await window._pjWs.enter(pj.pid); }
    } finally { if (shown) window._pjWs.opening(null); }
    if (window._pjWs) window._pjWs.label();
    if (window._pjf) window._pjf.changed(null);
  }

  // ── Read-only: a snapshot of a past day, or an archived project ───────────
  // The banner says so and offers the way out; record() refuses every change meanwhile.
  function banner() {
    let b = $('pj-banner');
    if (!pj.readonly) { if (b) b.remove(); return; }
    const day = pj.at ? new Date(FL.snapshotTime(pj.at) || pj.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const text = pj.mode === 'snapshot' ? `Snapshot of ${day} — read-only` : 'Archived — read-only';
    if (b && b.dataset.k === text) return;
    if (b) b.remove();
    b = el('div'); b.id = 'pj-banner'; b.dataset.k = text; b.setAttribute('role', 'status');
    b.appendChild(el('span', '', text));
    b.appendChild(btn(pj.mode === 'snapshot' ? 'Leave the snapshot' : 'Unarchive', () => (pj.mode === 'snapshot' ? setProject(pj.pid) : unarchive()), 'small'));
    document.body.appendChild(b);
  }
  async function unarchive() { return archive(false); }
  /** Archive (hidden from the list, read-only, still openable) or unarchive: recorded in the project's own log. */
  async function archive(on) {
    if (!pj.pid) return false;
    if (!(await ensureAuthor())) return false;
    try { await post('archive?project=' + encodeURIComponent(pj.pid), { archived: !!on, who: who() }); }
    catch (err) { toast('Could not ' + (on ? 'archive' : 'unarchive') + ': ' + err.message); return false; }
    await loadAll(); render(); refreshCard();
    toast(on ? 'Archived: read-only, hidden from the project list' : 'Unarchived');
    return true;
  }
  /** Read the logs again (after the server changed them — a cave moved to another project). */
  async function reload() { await loadAll(); render(); refreshCard(); drawField(); drawLeads(); if (window._pjSeg) window._pjSeg.changed(null); if (window._pjf) window._pjf.changed(null); }


  Object.assign(X, {
    api, post, blobUrl, who, ensureAuthor, loadAll, record, refresh, setProject, banner, archive, reload,
  });
})();
