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
  setInterval(sync, 3000);                             // suggestions arriving, project data loading
  sync();
  window._rail = { open: sel => { const b = rail.querySelector(`[data-target="${sel}"]`); const t = document.querySelector(sel); if (b && t && !t.classList.contains('show')) b.click(); } };
})();
