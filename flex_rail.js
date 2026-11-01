// flex_rail.js — the icon strip down the left (#flex-rail in index.html).
//
// Each icon with data-target opens that panel in #toolbar, one at a time (the
// click handling is the accordion script in index.html, as for the old nav
// row). This file adds what the strip shows on its own:
//   - which panel is open (highlight),
//   - the open project's name under 📁, in green,
//   - the project-only icons (data-pj-only: Docs, Leads, Trips, Review)
//     greyed with no project open, and their panels closed when it closes;
//     Trips (data-rail-later) stays greyed until it is built,
//   - a dot on Review when suggestions are waiting.
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
      b.disabled = !open || b.hasAttribute('data-rail-later');
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
    (pj.projects || []).forEach(p => m.appendChild(item('📁 ' + (p.name || p.id), p.id === pj.pid ? 'open now' : '', () => { if (p.id !== pj.pid) (window._pjx ? window._pjx.open(p.id) : A.setProject(p.id)); }, p.id === pj.pid)));
    m.appendChild(item('No project', 'close it; 👤 My data stays', () => { if (pj.pid) A.setProject(null); }, !pj.pid));
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
  const busy = () => !!((window._pjfState && window._pjfState.draw) ||
    [...document.querySelectorAll('[id$="pick-banner"], .pjf-banner')].some(el => el.offsetParent !== null && getComputedStyle(el).display !== 'none'));
  let down = null;
  window.addEventListener('pointerdown', e => {
    down = e.button === 0 && e.target && e.target.tagName === 'CANVAS' && !e.target.closest('#toolbar, #flex-rail, #flex-inspector') ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
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

  // ⓘ Help → the guide (help.html) in a frame over the map; × / Esc / outside closes.
  function guide(section) {
    let ov = $('flex-guide');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'flex-guide';
      ov.innerHTML = '<div class="fg-box"><div class="fg-bar"><b>📘 FLEX guide</b><span><a href="help.html" target="_blank" rel="noopener">open in a tab ↗</a><button type="button" class="fg-x" title="Close (Esc)">×</button></span></div><iframe title="FLEX guide"></iframe></div>';
      document.body.appendChild(ov);
      const close = () => ov.classList.remove('on');
      ov.querySelector('.fg-x').addEventListener('click', close);
      ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
      const fr = ov.querySelector('iframe');
      fr.addEventListener('load', () => { try { fr.contentWindow.addEventListener('keydown', e => { if (e.key === 'Escape') close(); }); } catch (_) {} });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov.classList.contains('on')) { e.stopPropagation(); close(); } }, true);
    }
    const fr = ov.querySelector('iframe'), url = 'help.html' + (section ? '#' + section : '');
    if (!fr.getAttribute('src')) fr.setAttribute('src', url);
    else { try { const w = fr.contentWindow; if (section) { const t = w.document.getElementById(section); if (t) t.scrollIntoView({ block: 'start' }); } else w.scrollTo(0, 0); } catch (_) { fr.setAttribute('src', url); } }
    ov.classList.add('on');
  }
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('#help-guide-links [data-guide]'); if (b) guide(b.dataset.guide); });

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
  #flex-guide { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,.55); display: none; align-items: center; justify-content: center; }
  #flex-guide.on { display: flex; }
  #flex-guide .fg-box { width: min(1180px, 94vw); height: 90vh; background: #12161a; border: 1px solid rgba(255,255,255,.18); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
  #flex-guide .fg-bar { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px 6px 14px; border-bottom: 1px solid rgba(255,255,255,.12); color: #e6ebe8; font: 13px system-ui, sans-serif; }
  #flex-guide .fg-bar span { display: flex; gap: 12px; align-items: center; }
  #flex-guide .fg-bar a { color: #8ab4ec; font-size: 12px; }
  #flex-guide .fg-x { background: none; border: none; color: #e6ebe8; font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px; }
  #flex-guide iframe { flex: 1; border: 0; width: 100%; background: #12161a; }`;
  document.head.appendChild(st);
  setInterval(sync, 3000);                             // suggestions arriving, project data loading
  sync();
  window._rail = { open: sel => { const b = rail.querySelector(`[data-target="${sel}"]`); const t = document.querySelector(sel); if (b && t && !t.classList.contains('show')) b.click(); } };
})();
