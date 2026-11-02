// inspector.js — one panel on the right for whatever was clicked.
//
// It holds, in one place with one × and one resizable edge:
//   - the station / shot card (#pj-card, project.js),
//   - the segment panel (#pjs-dock, project_segments.js), which keeps the
//     card at its own top while it is open,
//   - Cesium's info box for anything else on the map (points, data files,
//     CalTopo features), its own title bar replaced by the panel's,
//   - the brief info of a clicked map feature, lead or point (info_panel.js,
//     setBrief); it can hide Cesium's info box when it says the same.
// Nothing here knows what those show: the elements are moved in as they
// appear, and the panel shows while any of them is open.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) window.iconLabel(e, txt); return e; };   // txt: text or ['icon', 'text']

  const box = mk('aside'); box.id = 'flex-inspector'; box.setAttribute('aria-label', 'Details');
  const grip = mk('div', 'ins-grip'); grip.title = 'Drag to resize';
  const head = mk('div', 'ins-head');
  const title = mk('div', 'ins-title');
  const close = mk('button', 'ins-x', '×'); close.type = 'button'; close.title = 'Close (Esc)'; close.setAttribute('aria-label', 'Close');
  head.append(title, close);
  const crumbSlot = mk('nav', 'ins-crumbs'); crumbSlot.setAttribute('aria-label', 'Selected');
  const cardSlot = mk('div', 'ins-card'), infoSlot = mk('div', 'ins-info'), briefSlot = mk('div', 'ins-brief'), actSlot = mk('div', 'ins-acts'), mainSlot = mk('div', 'ins-main');
  box.append(grip, head, crumbSlot, cardSlot, infoSlot, briefSlot, actSlot, mainSlot);
  let brief = null;                                   // { node, title, hideInfo } (info_panel.js)
  document.body.appendChild(box);

  // ── Width ──────────────────────────────────────────────────────────────
  function setWidth(w) {
    w = Math.max(300, Math.min(window.innerWidth * 0.7, w || 400));
    box.style.width = w + 'px';
    document.documentElement.style.setProperty('--ins-w', w + 'px');
  }
  let w0 = 400; try { w0 = Number(localStorage.getItem('flex.ins.w')) || Number(localStorage.getItem('flex.pjs.dockW')) || 400; } catch (_) {}
  setWidth(w0);
  grip.addEventListener('mousedown', e => {
    e.preventDefault();
    const mv = ev => setWidth(window.innerWidth - 8 - ev.clientX);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); try { localStorage.setItem('flex.ins.w', String(parseInt(box.style.width, 10))); } catch (_) {} };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });

  // ── What is open ───────────────────────────────────────────────────────
  const V = () => window.cesiumViewer;
  const card = () => $('pj-card');
  const dock = () => $('pjs-dock');
  const cardOpen = () => !!(card() && card().classList.contains('open'));
  const dockOpen = () => !!(dock() && dock().classList.contains('open'));
  const infoBox = () => { const v = V(); return v && v.infoBox; };
  // Cesium's own description: not for a whole cave, survey or segment (selection.js) — only the clicked station's.
  const selLevel = () => (window._sel ? window._sel.level() : null);
  const infoOpen = () => { const ib = infoBox(); const l = selLevel(); return !!(ib && ib.viewModel.showInfo && V().selectedEntity) && !dockOpen() && (!l || l === 'station') && !(brief && brief.hideInfo); };
  const briefOpen = () => !!brief && !cardOpen() && !dockOpen();
  /** The brief info of what was clicked (info_panel.js); null takes it away. */
  function setBrief(b) {
    brief = b || null;
    briefSlot.textContent = '';
    if (brief && brief.node) briefSlot.appendChild(brief.node);
    refresh();
  }

  // Elements made elsewhere are put into their slot as they appear.
  function adopt() {
    const d = dock();
    if (d && d.parentNode !== mainSlot) mainSlot.appendChild(d);
    const c = card();
    if (c && c.parentNode === document.body) cardSlot.appendChild(c);   // in the segment panel it stays there
    const ib = infoBox();
    if (ib && ib.container.parentNode !== infoSlot) infoSlot.appendChild(ib.container);
    const pc = $('floating-action-btn');                               // flex.js: "Add Point Cloud" for a LiDAR dataset outline
    if (pc && pc.parentNode && pc.parentNode.parentNode === document.body) actSlot.appendChild(pc.parentNode);
  }
  function refresh() {
    adopt();
    const c = cardOpen(), d = dockOpen(), i = infoOpen(), br = briefOpen();
    const any = c || d || i || br;
    box.classList.toggle('open', any);
    document.body.classList.toggle('ins-open', any);
    box.classList.toggle('with-dock', d);
    box.classList.toggle('no-info', !i);
    box.classList.toggle('no-brief', !br);
    // The title: the card and the segment panel have their own; Cesium's
    // info box gets the panel's (its own title bar is hidden).
    let t = '';
    if (!c && !d && br && brief.title) t = brief.title;
    else if (!c && !d && i) { const e = V().selectedEntity; t = (e && e.name) || infoBox().viewModel.titleText || ''; }
    if (title.textContent !== t) title.textContent = t;
    box.classList.toggle('titled', !!t);
    crumbs(any);
    if (i) fitInfo();
    // Everything closed some other way (a card's or the segment panel's own ✕): nothing is selected.
    if (!any && window._sel && window._sel.active()) setTimeout(() => { if (!cardOpen() && !dockOpen() && !infoOpen()) window._sel.clear(); }, 50);
    if (!any && window._info) window._info.panelClosed();
  }
  // Cave › Survey › Segment › Station, each part clickable (selection.js).
  let lastCrumbs = '';
  function crumbs(any) {
    const cs = any && window._sel ? window._sel.crumbs() : [];
    const key = JSON.stringify(cs);
    if (key === lastCrumbs) return;
    lastCrumbs = key;
    crumbSlot.textContent = '';
    box.classList.toggle('with-crumbs', cs.length > 0);
    cs.forEach((c, k) => {
      if (k) crumbSlot.appendChild(mk('span', 'ins-sep', '›'));
      const b = mk('button', 'ins-crumb' + (k === cs.length - 1 ? ' cur' : ''), c.label);
      b.type = 'button';
      b.addEventListener('click', () => window._sel.toLevel(c.level, c.sid));
      crumbSlot.appendChild(b);
    });
  }
  // Cesium sizes the description frame when the text changes, which can be
  // while the panel is still hidden (height 0): measure again once shown.
  function fitInfo() {
    const ib = infoBox(), f = ib && ib.frame, doc = f && f.contentDocument;
    const d = doc && doc.querySelector('.cesium-infoBox-description');
    if (!d) return;
    requestAnimationFrame(() => { const h = Math.ceil(d.getBoundingClientRect().height); if (h && f.style.height !== h + 'px') f.style.height = h + 'px'; });
  }
  function closeAll() {
    if (dockOpen() && window._pjSeg) window._pjSeg.closeDock();
    const x = card() && card().querySelector('.pj-card-h button');
    if (cardOpen() && x) x.click();
    const v = V(); if (v && v.selectedEntity) v.selectedEntity = undefined;
    if (window._sel) window._sel.clear();
    if (window._info) window._info.clear();
    setTimeout(refresh, 0);
  }
  close.addEventListener('click', closeAll);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !box.classList.contains('open')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.pj-modal')) return;                  // a dialog takes Esc first
    closeAll();
  });

  // Watch: things appearing in <body>, the card / dock opening and closing,
  // Cesium's selection.
  const watched = new WeakSet();
  const mo = new MutationObserver(() => { watch(); refresh(); });
  function watch() {
    [card(), dock()].forEach(e => { if (e && !watched.has(e)) { watched.add(e); mo.observe(e, { attributes: true, attributeFilter: ['class'] }); } });
  }
  mo.observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
  const hook = setInterval(() => {
    const v = V();
    if (!v || !v.infoBox || !v.selectedEntityChanged) return;
    clearInterval(hook);
    v.selectedEntityChanged.addEventListener(() => { setTimeout(refresh, 0); setTimeout(fitInfo, 300); });
    v.infoBox.viewModel.closeClicked.addEventListener(() => setTimeout(refresh, 0));
    const ibEl = v.infoBox.container.querySelector('.cesium-infoBox');
    if (ibEl) mo.observe(ibEl, { attributes: true, attributeFilter: ['class'] });
    refresh();
  }, 300);
  watch(); refresh();

  const style = mk('style');
  style.textContent = `
  #flex-inspector { position: fixed; top: 52px; right: 8px; max-height: calc(100% - 60px); width: 400px; z-index: 9500; display: none; flex-direction: column;
    background: rgba(16,18,26,.96); color: #e8e8ee; font: 12px system-ui, sans-serif; border: 1px solid rgba(255,255,255,.12); border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,.45); }
  #flex-inspector.open { display: flex; }
  #flex-inspector.with-dock { bottom: 8px; max-height: none; }
  #flex-inspector.with-dock .ins-head { display: none; }   /* the segment panel has its own ✕ */
  #flex-inspector .ins-grip { position: absolute; left: -5px; top: 0; bottom: 0; width: 9px; cursor: ew-resize; z-index: 2; }
  #flex-inspector .ins-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px 0 12px; min-height: 26px; flex: none; }
  #flex-inspector.titled .ins-head { padding: 8px 6px 6px 12px; border-bottom: 1px solid rgba(255,255,255,.08); }
  #flex-inspector .ins-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #flex-inspector .ins-x { background: none; border: none; color: #98a3a0; font-size: 20px; line-height: 1; padding: 0 6px 2px; border-radius: 4px; cursor: pointer; }
  #flex-inspector .ins-x:hover { color: #fff; background: rgba(255,255,255,.08); }
  #flex-inspector.titled .ins-x { margin-top: -2px; }
  #flex-inspector:not(.titled) .ins-head { position: absolute; top: 2px; right: 2px; padding: 0; z-index: 3; }
  #flex-inspector .ins-crumbs { display: none; flex-wrap: wrap; align-items: center; gap: 2px; padding: 7px 34px 5px 10px; border-bottom: 1px solid rgba(255,255,255,.08); flex: none; font-size: 12px; }
  #flex-inspector.with-crumbs .ins-crumbs { display: flex; }
  #flex-inspector .ins-crumb { background: none; border: none; color: #98a3a0; padding: 1px 4px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  #flex-inspector .ins-crumb:hover { color: #fff; background: rgba(255,255,255,.08); }
  #flex-inspector .ins-crumb.cur { color: #f2f4f3; font-weight: 600; }
  #flex-inspector .ins-sep { color: rgba(255,255,255,.35); }
  #flex-inspector.with-crumbs.with-dock .ins-head { display: flex; position: absolute; top: 2px; right: 2px; padding: 0; z-index: 3; }
  #flex-inspector .ins-card { flex: none; max-height: 60%; overflow: auto; }
  #flex-inspector.with-dock .ins-card { display: none; }
  #flex-inspector .ins-info { flex: 0 1 auto; min-height: 0; overflow: auto; }
  #flex-inspector .ins-brief { flex: 0 1 auto; min-height: 0; overflow: auto; }
  #flex-inspector.no-brief .ins-brief { display: none; }
  #flex-inspector .ins-acts { flex: none; padding: 0 12px; }
  #flex-inspector .ins-acts:has(#floating-action-btn[style*="display: block"]) { padding: 4px 12px 10px; }
  #flex-inspector.with-dock .ins-acts { display: none; }
  #flex-inspector #floating-action-btn { position: static !important; font-size: 12px !important; padding: 5px 12px !important; border-radius: 6px !important; box-shadow: none !important; }
  #flex-inspector .ins-main { display: none; flex: 1; min-height: 0; flex-direction: column; }
  #flex-inspector.with-dock .ins-main { display: flex; }
  #flex-inspector.with-dock .ins-info, #flex-inspector.no-info .ins-info { display: none; }
  /* The card: its own ✕ gives way to the panel's ×. */
  #flex-inspector #pj-card { position: static; width: auto; max-height: none; box-shadow: none; border: none; border-radius: 0; background: transparent; margin: 0; padding: 10px 34px 10px 12px; }
  #flex-inspector #pj-card:not(.open) { display: none; }
  #flex-inspector .pj-card-h > .pj-btn { display: none; }
  #flex-inspector .ins-card:has(#pj-card.open) + .ins-info .cesium-infoBox-visible { border-top: 1px solid rgba(255,255,255,.08); }
  /* The segment panel fills the rest. */
  #flex-inspector #pjs-dock { position: static; width: auto !important; flex: 1; min-height: 0; box-shadow: none; border: none; background: transparent; }
  #flex-inspector #pjs-dock .pjs-grip { display: none; }
  #flex-inspector #pjs-dock .pjs-head { padding-right: 34px; }
  /* Cesium's info box, laid flat in the panel. */
  #flex-inspector .cesium-viewer-infoBoxContainer { position: static; }
  #flex-inspector .cesium-infoBox { position: static; width: auto; max-width: none; transform: none; transition: none; background: transparent;
    border: none; border-radius: 0; box-shadow: none; display: none; }
  #flex-inspector .cesium-infoBox-visible { display: block; }
  #flex-inspector .cesium-infoBox-title, #flex-inspector .cesium-infoBox-camera, #flex-inspector .cesium-infoBox-close { display: none; }
  #flex-inspector .cesium-infoBox-iframe { width: 100%; }`;
  document.head.appendChild(style);

  window._inspector = { refresh, close: closeAll, el: box, setBrief, brief: () => brief };
})();
