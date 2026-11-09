/* FLEX Field / portable viewer: pick a route's start or end by name.
 *
 * While 🚩 is waiting for a station ("Route · tap the start station" in the bar at the top), a small search box
 * sits under that bar: type part of a station's name and pick one from the list, without finding it in 3D
 * first. The words typed are looked for in the station's name, its cave and its survey ("t6 ridge" finds T6 in
 * Cave Ridge), the stations of the cave you are in come first, and two stations with one name say how they differ.
 * Picking one does what tapping it does (routePicked in viewer.html): the first is the start, the second the end.
 *
 * Loaded by viewer.html before its own script; updateModeBar calls RouteSearch.sync() as the bar changes. What it
 * uses from the page (routePick, routePicked, routeStationHits, fpRow, …) is looked up when it runs.
 */
(function () {
  'use strict';

  const css = document.createElement('style');
  css.textContent = `
    #route-search { display: none; position: fixed; left: 50%; transform: translateX(-50%); z-index: 39; width: min(340px, calc(100vw - 24px));
      background: rgba(10,10,20,.94); border: 1px solid rgba(255,255,255,.16); border-radius: 12px; padding: 6px; pointer-events: all; }
    #route-search.show { display: block; }
    #rs-q { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18);
      background: rgba(0,0,0,.35); color: #eee; font-size: 15px; font-family: inherit; }
    #rs-list { max-height: min(40vh, 280px); overflow-y: auto; margin-top: 4px; }
    #rs-list:empty { display: none; }
    #rs-list .fp-item { padding: 7px 6px; }
  `;
  document.head.appendChild(css);

  let box = null, inp = null, list = null, timer = 0, lastTop = -1;

  function build() {
    if (box) return;
    box = document.createElement('div'); box.id = 'route-search';
    inp = document.createElement('input'); inp.id = 'rs-q'; inp.type = 'search';
    inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'off');
    list = document.createElement('div'); list.id = 'rs-list';
    box.appendChild(inp); box.appendChild(list);
    document.body.appendChild(box);
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 100); });
    inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = routeStationHits(inp.value, 1)[0];
      if (first) pick(first);
    });
  }

  function pick(e) {
    inp.value = ''; list.textContent = '';
    inp.blur();
    const st = e.st, from = routePick === 'from';
    routePicked(st);
    // The start is fixed: take the view to it if it is off screen, so the choice can be seen.
    if (from && st && st.pos) {
      const v = st.pos.clone().project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) flyToPoint(st.pos, Math.max(40, camera.position.distanceTo(controls.target)));
    }
  }

  function render() {
    list.textContent = '';
    const q = inp.value;
    if (!q.trim()) return;
    const hits = routeStationHits(q, 8);
    if (!hits.length) { const n = document.createElement('div'); n.className = 'fp-note'; n.style.padding = '6px'; n.textContent = 'No station of that name.'; list.appendChild(n); return; }
    hits.forEach(e => list.appendChild(fpRow('◎', e.text, e.sub, () => pick(e))));
  }

  // The box shows under the flag while the start or end is being picked, and only then.
  function sync() {
    let pickNow = null;
    try { pickNow = routePick; } catch (_) { /* the page has not set it up yet */ }
    build();
    if (!pickNow) {
      if (box.classList.contains('show')) { box.classList.remove('show'); inp.value = ''; list.textContent = ''; inp.blur(); }
      return;
    }
    box.classList.add('show');
    const ph = pickNow === 'from' ? 'Search the start station' : 'Search the end station';
    if (inp.placeholder !== ph) { inp.placeholder = ph; inp.value = ''; list.textContent = ''; }
    const bar = document.getElementById('mode-bar'), r = bar.getBoundingClientRect();
    const top = Math.round((r.height ? r.bottom : 92) + 6);
    if (top !== lastTop) { box.style.top = top + 'px'; lastTop = top; }
  }

  window.RouteSearch = { sync, render, pick };
})();
