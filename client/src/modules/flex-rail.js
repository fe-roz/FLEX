// flex-rail.js — the icon strip down the left (#flex-rail in index.html).
// The icons are line icons from icons.js (<svg class="ico"><use href="#i-…">),
// drawn in currentColor, so the states below are colours on the button.
//
// Each icon with data-target opens that panel in #toolbar, one at a time (the
// click handling is the accordion script in index.html, as for the old nav
// row). This file adds what the strip shows on its own:
//   - which panel is open (highlight),
//   - the open project's name under the folder icon, in green,
//   - the ⛰ Terrain panel (terrain-panel.js; its own icon, no project needed);
//   - the project-only icons (data-pj-only: Docs, Leads, Review)
//     greyed with no project open, and their panels closed when it closes;
//     (data-rail-later would grey one that is not built yet),
//   - a dot on Review when suggestions are waiting,
//   - the dock (bottom of the strip: Speed, Settings, Help): floating panels beside the strip, independent of the
//     menu pane (see "The dock" below).
(function () {
  'use strict';
  const rail = document.getElementById('flex-rail');
  if (!rail) return;
  const $ = id => document.getElementById(id);
  const panels = () => [...rail.querySelectorAll('[data-target]')].map(b => document.querySelector(b.dataset.target)).filter(Boolean);

  function sync() {
    const pj = window._pj || {};
    const open = !!pj.pid;
    rail.querySelectorAll('[data-pj-only]').forEach(b => {
      b.disabled = !open || b.hasAttribute('data-rail-later');   // data-rail-later: an icon not built yet (none now)
      const t = b.dataset.target && document.querySelector(b.dataset.target);
      if (!open && t && t.classList.contains('show')) t.classList.remove('show');   // the project closed under it
    });
    rail.querySelectorAll('[data-target]').forEach(b => {
      const t = document.querySelector(b.dataset.target);
      b.classList.toggle('on', !!(t && t.classList.contains('show')));
    });
    const label = (($('pj-top-btn') || {}).textContent || '').replace(/^📁\s*/, '').trim();
    const name = open ? ((pj.P && pj.P.name) || (label !== 'No project' && label) || 'Project') : 'Project';
    const nm = $('rail-pj-name'), pb = $('rail-pj');
    if (nm && nm.textContent !== name) nm.textContent = name;
    if (pb) {
      pb.classList.toggle('pj-open', open);
      pb.title = open ? `Project “${name}”` : 'Projects: open or create one';
    }
    let waiting = 0;
    try { if (open && window._pjApi && pj.P) waiting = window._pjApi.FL.reviewQueue(pj.P, pj.D).length; } catch (_) {}
    const dot = $('rail-review-dot');
    if (dot) { dot.hidden = !waiting; dot.title = waiting ? waiting + ' waiting' : ''; }
  }

  // 📁 while its panel is open: a project picker (instead of closing it).
  rail.addEventListener('click', e => {
    const b = e.target.closest('#rail-pj');
    const panel = $('projectCollapsible');
    if (!b || !panel || !panel.classList.contains('show')) return;
    e.stopPropagation();
    pickProject(b);
  }, true);
  function pickProject(anchor) {
    const old = $('rail-pick'); if (old) { old.remove(); return; }
    const pj = window._pj || {}, A = window._pjApi;
    const m = document.createElement('div'); m.id = 'rail-pick';
    const item = (label, sub, fn, on) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'rp-i' + (on ? ' on' : ''); x.innerHTML = `<span></span><small></small>`; x.firstChild.textContent = label; x.lastChild.textContent = sub || ''; x.addEventListener('click', () => { m.remove(); fn(); }); return x; };
    const t = document.createElement('div'); t.className = 'rp-t'; t.textContent = 'Switch project'; m.appendChild(t);
    m.appendChild(item('No project', 'close it; 👤 My data stays', () => { if (pj.pid) A.setProject(null); }, !pj.pid));      // first: the way out of a project
    const X = (window._pjx && window._pjx.state) || {};
    const isArch = p => (X.info && X.info[p.id] ? X.info[p.id].archived : !!p.archived);
    let showArch = false; try { showArch = localStorage.getItem('flex.pjx.archived') === '1'; } catch (_) {}
    const all = pj.projects || [], nArch = all.filter(p => isArch(p) && p.id !== pj.pid).length;
    all.filter(p => p.id === pj.pid || showArch || !isArch(p)).forEach(p => m.appendChild(item('📁 ' + (p.name || p.id), p.id === pj.pid ? 'open now' : '', () => { if (p.id !== pj.pid) (window._pjx ? window._pjx.open(p.id) : A.setProject(p.id)); }, p.id === pj.pid)));
    if (nArch) m.appendChild(item((showArch ? 'Hide archived' : 'Show archived') + ` (${nArch})`, '', () => { try { localStorage.setItem('flex.pjx.archived', showArch ? '0' : '1'); } catch (_) {} if (window._pjx && window._pjx.paintLive) try { window._pjx.paintLive(); } catch (_) {} pickProject(anchor); }));
    m.appendChild(item('＋ New project…', '', () => A.newProject()));
    m.appendChild(item('Close this panel', '', () => $('projectCollapsible').classList.remove('show')));
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = (r.right + 8) + 'px'; m.style.top = Math.max(8, r.top) + 'px';
    const off = ev => { if (!m.isConnected) { document.removeEventListener('mousedown', off, true); return; } if (!m.contains(ev.target) && !anchor.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  }

  // A click on the map (not a drag) closes the open menu panel, except while
  // a panel is in the middle of something on the map (picking an area or a
  // station, drawing) or is one whose work is on the map (Export, Analyze).
  const KEEP_OPEN = new Set(['#exportCollapsible', '#lidarDeriveCollapsible']);
  const busy = () => !!((window._pjfState && window._pjfState.draw) || window._apDrawing ||
    [...document.querySelectorAll('[id$="pick-banner"], .pjf-banner')].some(el => el.offsetParent !== null && getComputedStyle(el).display !== 'none'));
  let down = null;
  window.addEventListener('pointerdown', e => {
    down = e.button === 0 && e.target && e.target.tagName === 'CANVAS' && !e.target.closest('#toolbar, #flex-dock, #flex-rail, #flex-inspector') ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
  }, true);
  window.addEventListener('pointerup', e => {
    const d = down; down = null;
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || Date.now() - d.t > 400) return;   // a drag or a hold
    if (busy()) return;
    rail.querySelectorAll('[data-target]').forEach(b => {
      const t = document.querySelector(b.dataset.target);
      if (t && t.classList.contains('show') && !KEEP_OPEN.has(b.dataset.target)) t.classList.remove('show');
    });
  }, true);

  // ── The dock: Speed, Settings and Help (the three buttons at the bottom of the strip) ──
  // Each opens in #flex-dock, a floating panel at the bottom left beside the strip, over the map. It does not
  // belong to the menu panes (#toolbar): a menu pane and a dock panel can be open together, and a click on the
  // map leaves it open. One dock panel at a time; its button is lit (.on, aria-pressed) while it is open; the
  // button again, the panel's ×, or Esc closes it. Speed and Settings are the panes that used to sit in #toolbar
  // (same ids: #perfCollapsible, #settingsCollapsible; .show = open); Help is the guide (help.html) in a frame.
  const dock = $('flex-dock'), toolbar = $('toolbar');
  const dockPanels = () => (dock ? [...dock.querySelectorAll(':scope > .dock-panel')] : []);
  const dockBtn = name => rail.querySelector(`[data-dock="${name}"]`);
  const dockOpenName = () => { const p = dockPanels().find(x => x.classList.contains('show')); return p ? p.dataset.dock : null; };
  /** Beside the menu pane when one is open (not on top of it); else just right of the strip. */
  function dockPlace() {
    if (!dock) return;
    const pane = toolbar && toolbar.querySelector(':scope > .collapse.show');
    const left = pane ? Math.round(toolbar.getBoundingClientRect().right) + 8 : 73;
    dock.style.left = left + 'px';
  }
  function dockSync() {
    const cur = dockOpenName();
    dockPanels().forEach(p => { const b = dockBtn(p.dataset.dock), on = p.dataset.dock === cur; if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } });
    if (dock) { dock.classList.toggle('open', !!cur); if (cur) dock.dataset.open = cur; else delete dock.dataset.open; }
    dockPlace();
  }
  function dockClose() { dockPanels().forEach(p => p.classList.remove('show')); dockSync(); }
  function dockBar(p) {
    const bar = document.createElement('div'); bar.className = 'dock-bar';
    const t = document.createElement('b'); t.innerHTML = (window.icon && p.dataset.icon ? window.icon(p.dataset.icon, 15) + ' ' : '') + p.dataset.title;
    const r = document.createElement('span');
    if (p.dataset.dock === 'help') r.innerHTML = '<a href="help.html" target="_blank" rel="noopener">open in a tab ↗</a>';
    const x = document.createElement('button'); x.type = 'button'; x.className = 'dock-x fg-x'; x.title = 'Close (Esc)'; x.setAttribute('aria-label', 'Close'); x.textContent = '×';
    x.addEventListener('click', dockClose);
    r.appendChild(x); bar.append(t, r); p.insertBefore(bar, p.firstChild);
  }
  dockPanels().forEach(dockBar);
  function guideFrame(section) {
    const ov = $('flex-guide'); if (!ov) return;
    let fr = ov.querySelector('iframe');
    const url = 'help.html' + (section ? '#' + section : '');
    if (!fr) {
      fr = document.createElement('iframe'); fr.title = 'FLEX guide';
      fr.addEventListener('load', () => { try { fr.contentWindow.addEventListener('keydown', e => { if (e.key === 'Escape') dockClose(); }); } catch (_) {} });
      fr.setAttribute('src', url); ov.appendChild(fr);
    } else {
      try { const w = fr.contentWindow; if (section) { const t = w.document.getElementById(section); if (t) t.scrollIntoView({ block: 'start' }); } else w.scrollTo(0, 0); } catch (_) { fr.setAttribute('src', url); }
    }
  }
  /** Open a dock panel ('perf' | 'settings' | 'help'); help takes a section id of help.html. */
  function dockOpen(name, section) {
    const p = dockPanels().find(x => x.dataset.dock === name); if (!p) return;
    dockPanels().forEach(x => { if (x !== p) x.classList.remove('show'); });
    p.classList.add('show');                                     // shown first: a hidden frame has no layout to scroll
    if (name === 'help') guideFrame(section);
    dockSync();
  }
  rail.addEventListener('click', e => {
    const b = e.target.closest('[data-dock]'); if (!b || b.disabled) return;
    if (dockOpenName() === b.dataset.dock) dockClose(); else dockOpen(b.dataset.dock);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || !dockOpenName()) return;
    if (document.querySelector('.pj-modal, #row-menu, #rail-pick')) return;     // a dialog or menu on top takes Esc first
    dockClose();
  });
  // Old names of the help overlay, kept for callers: guide(section) opens the guide, guideClose() closes it.
  const guide = section => dockOpen('help', section);
  const guideClose = () => { if (dockOpenName() === 'help') dockClose(); };
  if (dock) {
    const mo2 = new MutationObserver(dockSync);
    dockPanels().forEach(p => mo2.observe(p, { attributes: true, attributeFilter: ['class'] }));
    if (toolbar) { mo2.observe(toolbar, { subtree: true, attributes: true, attributeFilter: ['class'] }); if (window.ResizeObserver) new ResizeObserver(dockPlace).observe(toolbar); }
    window.addEventListener('resize', dockPlace);
  }

  rail.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    // The project panels are drawn by project.js; draw them as they open.
    if (b.hasAttribute('data-pj-only') && window._pjApi) setTimeout(() => window._pjApi.render(), 0);
    setTimeout(sync, 0);                               // after the accordion handler
  });

  // Panels opened or closed by anything else; project switches (the hidden
  // old project button is relabelled on every switch).
  const mo = new MutationObserver(() => sync());
  panels().forEach(p => mo.observe(p, { attributes: true, attributeFilter: ['class'] }));
  const old = $('pj-top-btn');
  if (old) mo.observe(old, { childList: true, characterData: true, subtree: true });
  const st = document.createElement('style');
  st.textContent = `
  #rail-pick { position: fixed; z-index: 9950; min-width: 230px; max-height: 70vh; overflow: auto; background: rgba(20,22,30,.98); border: 1px solid rgba(255,255,255,.15); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; box-shadow: 0 10px 30px rgba(0,0,0,.5); font: 12.5px system-ui, sans-serif; }
  #rail-pick .rp-t { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.5); font-weight: 700; padding: 3px 8px 5px; }
  #rail-pick .rp-i { display: flex; justify-content: space-between; gap: 10px; background: none; border: none; color: #e8ece9; text-align: left; padding: 5px 8px; border-radius: 5px; cursor: pointer; }
  #rail-pick .rp-i:hover { background: rgba(255,255,255,.08); }
  #rail-pick .rp-i.on { color: #6fd39a; font-weight: 600; }
  #rail-pick .rp-i small { color: rgba(255,255,255,.45); }
  /* The dock: one style for Speed, Settings and Help. Switches inside come from ui_kit.css (its scope includes #flex-dock). */
  #flex-dock { position: absolute; left: 73px; bottom: 13px; z-index: 12; display: none; max-width: calc(100% - 86px); }
  #flex-dock.open { display: block; }
  #flex-dock .dock-panel { display: none; box-sizing: border-box; flex-direction: column; background: rgba(32,34,38,.96); color: var(--ui-text, rgba(255,255,255,.85)); border: 1px solid rgba(255,255,255,.16); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); overflow: hidden; font-size: 11px; }
  #flex-dock .dock-panel.show { display: flex; }
  #flex-dock #perfCollapsible, #flex-dock #settingsCollapsible { width: 392px; max-width: 100%; max-height: 70vh; overflow-y: auto; display: none; }
  #flex-dock #perfCollapsible.show, #flex-dock #settingsCollapsible.show { display: block; }
  #flex-dock #flex-guide { width: 560px; max-width: 100%; height: 85vh; }
  #flex-dock .dock-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 5px 8px 5px 12px; border-bottom: 1px solid rgba(255,255,255,.12); background: rgba(32,34,38,.99); position: sticky; top: 0; z-index: 3; flex: none; font: 13px system-ui, sans-serif; }
  #flex-dock .dock-bar b { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  #flex-dock .dock-bar span { display: flex; gap: 12px; align-items: center; }
  #flex-dock .dock-bar a { color: var(--ui-focus, #8ab4ec); font-size: 12px; }
  #flex-dock .dock-x { background: none; border: none; color: inherit; font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px; }
  #flex-dock .dock-x:hover { color: #fff; }
  #flex-dock .lp-panel-wrap { padding: 4px 10px 10px; }
  #flex-dock #perf-panel { width: auto; }
  #flex-dock iframe { flex: 1; min-height: 0; border: 0; width: 100%; background: #12161a; }`;
  document.head.appendChild(st);
  setInterval(sync, 3000);                             // suggestions arriving, project data loading
  sync();
  const DOCK_OF = { '#perfCollapsible': 'perf', '#settingsCollapsible': 'settings', '#flex-guide': 'help' };
  window._rail = { guide, guideClose, dock: dockOpen, dockClose, dockOpenName, open: sel => { if (DOCK_OF[sel]) { if (dockOpenName() !== DOCK_OF[sel]) dockOpen(DOCK_OF[sel]); return; } const b = rail.querySelector(`[data-target="${sel}"]`); const t = document.querySelector(sel); if (b && t && !t.classList.contains('show')) b.click(); } };
})();
