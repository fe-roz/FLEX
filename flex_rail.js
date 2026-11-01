// flex_rail.js — the icon strip down the left (#flex-rail in index.html).
//
// Each icon with data-target opens that panel in #toolbar, one at a time (the
// click handling is the accordion script in index.html, as for the old nav
// row). This file adds what the strip shows on its own:
//   - which panel is open (highlight),
//   - the open project's name under 📁, in green,
//   - Docs / Leads / Trips / Review greyed with no project open; with one open
//     they open 📁 Project at that section (until they get panels of their own),
//   - a dot on Review when suggestions are waiting.
(function () {
  'use strict';
  const rail = document.getElementById('flex-rail');
  if (!rail) return;
  const $ = id => document.getElementById(id);
  const panels = () => [...rail.querySelectorAll('[data-target]')].map(b => document.querySelector(b.dataset.target)).filter(Boolean);
  let focus = null;                                    // the project-only icon last used, while 📁 Project is open

  function sync() {
    const pj = window._pj || {};
    const open = !!pj.pid;
    const pjPanel = $('projectCollapsible');
    const pjShown = !!(pjPanel && pjPanel.classList.contains('show'));
    if (!pjShown) focus = null;
    rail.querySelectorAll('[data-target]').forEach(b => {
      const t = document.querySelector(b.dataset.target);
      b.classList.toggle('on', !!(t && t.classList.contains('show')) && !(b.id === 'rail-pj' && focus));
    });
    rail.querySelectorAll('[data-rail-pj]').forEach(b => {
      b.disabled = !open || b.hasAttribute('data-rail-later');
      b.classList.toggle('on', pjShown && focus === b.dataset.railPj);
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

  // Docs / Leads / Review: 📁 Project, opened at that section.
  function openAt(title) {
    focus = title;
    const target = $('projectCollapsible');
    panels().forEach(p => { if (p !== target) p.classList.remove('show'); });
    target.classList.add('show');
    if (window._pjApi) window._pjApi.render();
    setTimeout(() => {
      const hs = [...document.querySelectorAll('#pj-panel .lp-section-header')];
      const h = hs.find(x => x.textContent.replace(/^[▸▾]\s*/, '').trim().startsWith(title));
      if (!h) {
        if (title === 'Suggestions' && window._pjApi) window._pjApi.toast('Nothing waiting for review');
        sync();
        return;
      }
      const body = h.nextElementSibling;
      if (body && !body.classList.contains('open')) h.click();
      h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      sync();
    }, 0);
    sync();
  }

  // 📁 while Docs/Leads/Review has 📁 Project open: back to its top, rather
  // than the accordion closing it (runs before the button's own handler).
  rail.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.id !== 'rail-pj' || !focus || !$('projectCollapsible').classList.contains('show')) return;
    e.stopPropagation();
    focus = null;
    const top = $('pj-panel');
    if (top) top.scrollIntoView({ block: 'start', behavior: 'smooth' });
    sync();
  }, true);
  rail.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.railPj) { openAt(b.dataset.railPj); return; }
    focus = null;
    setTimeout(sync, 0);                               // after the accordion handler
  });

  // Panels opened or closed by anything else; project switches (the hidden
  // old project button is relabelled on every switch).
  const mo = new MutationObserver(() => sync());
  panels().forEach(p => mo.observe(p, { attributes: true, attributeFilter: ['class'] }));
  const old = $('pj-top-btn');
  if (old) mo.observe(old, { childList: true, characterData: true, subtree: true });
  setInterval(sync, 3000);                             // suggestions arriving, project data loading
  sync();
})();
