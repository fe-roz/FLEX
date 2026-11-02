// Projects in desktop FLEX: caves, notes, leads, documents and sync files —
// the same library and the same rules as FLEX Field (viewer_build/libs/
// flexlib.js; storage in library.js under user_files/library/). Spec:
// project doc 11.
//
//   📁 Project panel   project, its caves (and which loaded file / surveys
//                      each is made of, with caves suggested inside a file),
//                      suggestions to review, leads, documents, sync files,
//                      history
//   station card      a clicked station (or shot): its notes, leads and
//                      documents, and buttons to add them
//   gallery           a document's pages: turn, tag, details, remove
//   field survey      shots taken on the phone, drawn on their cave (view only)
//
// Classic script: waits for flex.js (a module) to make the viewer.
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js (it said so)
  const { pj, filesToPages, setProject, archive, FL, el, btn, esc, when, toast, dialog, choose, record, render, refreshCard, openCard, flyTo, caveFor, caveName, partsOf, stationPos, stationsOf, docEl, docOpen, docByPage, describe, headsFor, targetLabel, editNote, noteEl, declAt, yearOf, imps, who, ensureAuthor, linkFile, editCave, newProject, refresh, editLead, renameProject, editDescription, importSync, acceptAbove, reload, post, closeCard, stopVideos, videoEl, fileOpen, galleryClose, addPages, editTags, leadEl, leadsAt, leadSummary, blobUrl, docSub, storeBytes, pickFiles, cardTarget, $, api, loadAll, onSelect, drawField, drawLeads, banner } = X;
  delete window._pjParts;

  pj._filesToPages = filesToPages;               // tests
  pj._setProject = setProject;                   // tests
  pj._archive = archive;

  // ── For project_segments.js (segments and the review queue) ───────────────
  window._pjApi = { pj, FL, el, btn, esc, when, toast, dialog, choose, record, render, refreshCard, openCard, flyTo,
    caveFor, caveName, partsOf, stationPos, stationsOf, docEl, docOpen, docByPage, describe, headsFor, targetLabel,
    editNote, noteEl, declAt, yearOf, imps, who, ensureAuthor, linkFile, editCave, newProject, refresh, editLead, renameProject, editDescription, setProject, importSync, acceptAbove, reload, archive, post, closeCard,
    stopVideos, videoEl, fileOpen, galleryClose, addPages, editTags, leadEl, leadsAt, leadSummary, blobUrl, docSub,
    filesToPages, storeBytes, pickFiles, cardTarget };

  // ── What the export takes from the project (index.html _collectCavesInBbox) ─
  window._pjExport = () => pj.pid ? {
    project: { id: pj.pid, name: pj.P.name || '' },
    caveFor: (imp, code) => { const cid = caveFor(imp, code); return cid ? { id: cid, name: caveName(cid) } : null; },
  } : null;

  // ── Start ──────────────────────────────────────────────────────────────────
  async function start() {
    $('pj-panel') && $('pj-panel').closest('.collapse') && document.querySelector('[data-target="#projectCollapsible"]')
      ?.addEventListener('click', () => setTimeout(render, 0));
    try { pj.dev = (await api('device')).id; }
    catch (e) { console.warn('[project] library unavailable', e); const p = $('pj-panel'); if (p) p.textContent = 'The project library needs the FLEX server (node server.js).'; return; }
    try { pj.pid = localStorage.getItem('flex.project') || null; } catch (_) {}
    await loadAll();
    if (pj.pid && !pj.projects.some(p => p.id === pj.pid)) await setProject(null);
    pj.ready = true;
    render();
    if (window._pjWs) { window._pjWs.label(); if (pj.pid) window._pjWs.enter(pj.pid, { startup: true }); }
    const wait = setInterval(() => {
      const V = window.cesiumViewer;
      if (!V || !V.selectedEntityChanged) return;
      clearInterval(wait);
      V.selectedEntityChanged.addEventListener(onSelect);
      drawField(); drawLeads();
    }, 300);
    // Caves loaded or removed: refresh what depends on them.
    let lastSig = '';
    setInterval(() => {
      const sig = imps().map(i => i.name + ':' + (typeof i._convertFn === 'function')).join('|');
      if (sig !== lastSig) { lastSig = sig; render(); drawField(); drawLeads(); if (window._pjSeg) window._pjSeg.changed(null); }
    }, 1500);
    // Another tab may have written: reload when coming back.
    window.addEventListener('focus', async () => { if (pj.ready && !document.querySelector('.pj-modal')) { await loadAll(); render(); refreshCard(); if (window._pjSeg) window._pjSeg.changed(null); } });
  }

  const css = `
  #pj-banner { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 9600; display: flex; align-items: center; gap: 10px; padding: 5px 8px 5px 14px; border-radius: 99px;
               background: rgba(242,194,78,.96); color: #1b1b1b; font: 600 12.5px system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
  #pj-banner .pj-btn { margin: 0; background: rgba(0,0,0,.12); border-color: rgba(0,0,0,.35); color: #1b1b1b; }
  #pj-panel { font-size: 12px; }
  .pj-btn { font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 5px; cursor: pointer; color: #e8e8ee; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.2); margin: 2px 4px 2px 0; }
  .pj-btn:hover { background: rgba(255,255,255,.14); }
  .pj-btn.primary { background: rgba(33,150,243,.35); border-color: #2196F3; }
  .pj-btn.danger { color: #ffb0b0; border-color: rgba(255,107,107,.6); }
  .pj-btn.small { padding: 2px 7px; font-size: 11px; }
  .pj-btn.link { background: none; border: none; color: #8ec5ff; padding: 0 2px; text-decoration: underline; }
  .pj-btn.chip { border-radius: 12px; padding: 2px 9px; font-size: 11px; }
  .pj-btn.chip.on, .pj-tabs .pj-btn.on { background: rgba(33,150,243,.45); border-color: #2196F3; }
  .pj-btn.row { display: block; width: 100%; text-align: left; margin: 1px 0; }
  .pj-btn:disabled { opacity: .3; cursor: default; }
  .pj-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 4px 0; }
  .pj-row select { flex: 1; min-width: 0; }
  .pj-input { font: inherit; font-size: 12px; background: rgba(0,0,0,.35); color: #eee; border: 1px solid rgba(255,255,255,.25); border-radius: 5px; padding: 5px 7px; width: 100%; box-sizing: border-box; }
  .pj-num { width: 60px; }
  .pj-item { padding: 5px 6px; margin: 3px 0; border-radius: 6px; background: rgba(255,255,255,.05); cursor: pointer; }
  .pj-item:hover { background: rgba(255,255,255,.1); }
  .pj-item.closed { opacity: .6; }
  .pj-hist { padding: 3px 6px; margin: 2px 0; }
  .pj-item.conflict { border-left: 3px solid #ff9f1c; }
  .pj-item-t { color: #f0f0f4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pj-sub { font-size: 11px; color: rgba(255,255,255,.55); overflow-wrap: anywhere; }
  .pj-note { font-size: 11px; color: rgba(255,255,255,.55); margin: 4px 0; line-height: 1.4; }
  .pj-h { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: rgba(255,255,255,.5); margin: 8px 0 2px; }
  .pj-tabs { display: flex; gap: 2px; margin: 2px 0 4px; }
  .pj-doc { display: flex; gap: 8px; align-items: center; }
  .pj-thumb { width: 44px; height: 44px; object-fit: cover; border-radius: 4px; background: #fff; flex: none; }
  .pj-doc-video .pj-thumb { box-shadow: inset 0 0 0 2px #8ab4ec; outline: 2px solid #8ab4ec; outline-offset: -2px; }
  .pj-thumb-x { display: flex; align-items: center; justify-content: center; color: #333; font-size: 10px; }
  .pj-drop { border: 1px dashed rgba(255,255,255,.25); border-radius: 6px; padding: 6px; text-align: center; color: rgba(255,255,255,.4); font-size: 11px; margin: 4px 0; }
  .pj-drop.on { border-color: #2196F3; color: #8ec5ff; }
  .pj-conflict { color: #ffc070; font-size: 11px; margin-top: 4px; }
  .pj-modal { position: fixed; inset: 0; z-index: 100001; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; font: 12px system-ui, sans-serif; }
  .pj-modal-box { width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 40px); overflow: auto; background: rgba(18,18,30,.98); color: #e8e8ee; border: 1px solid rgba(255,255,255,.18); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 9px; }
  .pj-modal-box.wide { width: min(640px, calc(100vw - 32px)); }
  .pj-modal-title { font-size: 14px; font-weight: 700; }
  .pj-modal-text { line-height: 1.45; color: rgba(255,255,255,.8); }
  .pj-modal-btns { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
  .pj-choices { display: flex; flex-direction: column; gap: 4px; }
  .pj-choices .pj-btn { text-align: left; padding: 7px 10px; }
  .pj-form { display: flex; flex-direction: column; gap: 7px; }
  .pj-f-l { font-size: 11px; color: rgba(255,255,255,.6); margin-bottom: 2px; }
  .pj-chips { display: flex; flex-wrap: wrap; }
  .pj-check { display: flex; gap: 6px; align-items: center; }
  .pj-list { display: flex; flex-direction: column; }
  .pj-taglist { max-height: 240px; overflow: auto; }
  #pj-card { position: fixed; right: 12px; bottom: 34px; width: 330px; max-height: 55vh; overflow: auto; z-index: 9000; background: rgba(18,18,30,.95); color: #e8e8ee;
             border: 1px solid rgba(255,255,255,.18); border-radius: 10px; padding: 10px 12px; font: 12px system-ui, sans-serif; display: none; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  #pj-card.open { display: block; }
  .pj-card-h { display: flex; justify-content: space-between; align-items: center; }
  .pj-card-t { font-weight: 700; font-size: 14px; }
  .pj-card-btns { margin-top: 8px; border-top: 1px solid rgba(255,255,255,.1); padding-top: 6px; }
  #pj-gallery { position: fixed; inset: 0; z-index: 100000; background: rgba(8,8,12,.97); color: #eee; display: none; flex-direction: column; font: 12px system-ui, sans-serif; }
  #pj-gallery.open { display: flex; }
  .pjg-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; gap: 8px; flex-wrap: wrap; }
  .pjg-title span { color: rgba(255,255,255,.55); margin-left: 6px; }
  .pjg-title .pjg-render { font-size: 10.5px; padding: 1px 7px; border: 1px solid rgba(255,255,255,.25); border-radius: 99px; color: rgba(255,255,255,.7); white-space: nowrap; }
  .pjg-stage { flex: 1; display: flex; align-items: center; min-height: 0; }
  .pjg-view { flex: 1; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: safe center; overflow: auto; overscroll-behavior: contain; }
  .pj-video { display: flex; flex-direction: column; align-items: center; max-width: 100%; }
  .pj-video video { background: #000; max-width: calc(100vw - 120px); max-height: calc(100vh - 160px); }
  .pj-video-note { font-size: 11px; opacity: .75; margin-top: 4px; display: none; }
  .pjg-img { max-width: calc(100vw - 120px); max-height: calc(100vh - 140px); background: #fff; transition: transform .15s; }
  .pjg-pdf { width: calc(100vw - 120px); height: calc(100vh - 140px); border: 0; background: #fff; }
  .pjg-prev, .pjg-next { font-size: 40px; width: 50px; background: none; border: none; color: #fff; cursor: pointer; }
  .pjg-prev:disabled, .pjg-next:disabled { opacity: .15; }
  .pjg-tags { padding: 6px 14px 10px; color: rgba(255,255,255,.6); }
  #pj-toast { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); background: rgba(20,20,30,.95); color: #fff; padding: 7px 14px; border-radius: 6px; z-index: 100002; opacity: 0; transition: opacity .2s; pointer-events: none; font: 12px system-ui, sans-serif; }
  #pj-toast.on { opacity: 1; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
