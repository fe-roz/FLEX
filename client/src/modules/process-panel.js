// process-panel.js — the Process pane: Analyze and Export as one flow. window._process.
//
//   1 Area · 2 LiDAR · 3 What to make   what was the Analyze pane (analyze-area.js builds it in #areas-host; the tools
//                                        that work on an area and are not products sit under it: Surface route, the look
//                                        of the trees, Weather, the LAN server row)
//   4 Send to phone                     what was the Export pane (export-ui.js): What to include, Maps, Advanced, the
//                                        estimate, Make the map, the download and Send to phone (USB)
//
// What this file does, and no more:
//   * the two parts keep their old ids; they get the class "show" with the pane, so code that asks whether Analyze or
//     Export is open is answered as before (and "show" put on a part opens the pane: older callers);
//   * the area and the LiDAR chosen in 1 and 2 are what the map in 4 is made of: the area's outline becomes the export
//     polygon, its name the map's name when that is empty, the request names the area (so the server reuses what was
//     already made for it: areas_api.js reuse) and the point cloud; what will be reused is asked once per choice and
//     told to the estimate. Drawing another area in 4, or choosing map terrain, still works: caves-only maps too;
//   * every explanation of part 4 waits behind a small "?" beside its option (the text is the one printed before);
//   * presets: named sets of the ticks and settings of 3 and 4 (kept in the project, or on this computer without one).
(function () {
  'use strict';
  const w = window, doc = document, $ = id => doc.getElementById(id);
  const PANE = 'processCollapsible', PARTS = ['lidarDeriveCollapsible', 'exportCollapsible'];
  const S = { applied: '', reuse: null, reuseKey: '', folded: false };
  const lget = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  // ── one pane, two parts ───────────────────────────────────────────────────
  function mirror() {
    const pane = $(PANE); if (!pane) return;
    let busy = false;
    const sync = from => { if (busy) return; busy = true;
      try {
        if (from === pane) PARTS.forEach(id => { const e = $(id); if (e) e.classList.toggle('show', pane.classList.contains('show')); });
        else if (from.classList.contains('show') && !pane.classList.contains('show')) {            // an older caller opened "Export" or "Analyze"
          doc.querySelectorAll('#toolbar > .collapse.show, #toolbar .collapse.show').forEach(c => { if (c !== pane && !pane.contains(c)) c.classList.remove('show'); });
          pane.classList.add('show'); PARTS.forEach(id => { const e = $(id); if (e) e.classList.add('show'); });
        }
      } finally { busy = false; } if (pane.classList.contains('show')) opened(); };
    new MutationObserver(() => sync(pane)).observe(pane, { attributes: true, attributeFilter: ['class'] });
    PARTS.forEach(id => { const e = $(id); if (e) new MutationObserver(() => sync(e)).observe(e, { attributes: true, attributeFilter: ['class'] }); });
  }

  // ── "?" beside an option: its explanation, hidden until asked for ─────────
  function questionMarks() {
    doc.querySelectorAll('#exportCollapsible .exp-row').forEach(row => {
      const hints = [...row.querySelectorAll(':scope > div, :scope > div > div')].filter(d => !d.id.match(/_why$|_count$|layers_note|ridge_opts|url_wrap|features-body|docs-body/) && !d.classList.contains('exp-why') && /font-size:\s*10px/.test(d.getAttribute('style') || '') && d.textContent.trim().length > 20 && !d.querySelector('input, select, button'));
      const label = row.querySelector('label'); if (!hints.length || !label || label.querySelector('.exp-q')) return;
      const q = doc.createElement('button'); q.type = 'button'; q.className = 'exp-q'; q.textContent = '?'; q.title = hints.map(h => h.textContent.trim().replace(/\s+/g, ' ')).join(' '); q.setAttribute('aria-label', 'What is this?'); q.setAttribute('aria-expanded', 'false');
      hints.forEach(h => h.classList.add('exp-hint', 'exp-hint-off'));
      q.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const on = !q.classList.contains('on'); q.classList.toggle('on', on); q.setAttribute('aria-expanded', String(on)); hints.forEach(h => h.classList.toggle('exp-hint-off', !on)); });
      label.insertAdjacentElement('afterend', q); if (getComputedStyle(label).display === 'block') label.style.display = 'inline-block';
    });
  }

  // ── the area and the LiDAR of 1 and 2 are what the map of 4 is made of ────
  const cur = () => { try { return w._areas && w._areas.current ? w._areas.current() : null; } catch (_) { return null; } };
  const lidar = () => { try { return (w._areas && w._areas.lidarPicked && w._areas.lidarPicked()) || []; } catch (_) { return []; } };
  /** What the export request takes from the choice above: { area, lidar } (either may be missing). */
  function pick() {
    const c = cur(), l = lidar();
    return { area: c && c.id ? c.id : null, name: c ? c.name : '', lidar: l.length ? l[0] : '', ring: c ? c.ring : null };
  }
  function applyArea() {
    const c = cur(), line = $('process-map-of'); if (!line) return;
    $('exportCollapsible').classList.toggle('process-has-lidar', lidar().length > 0);       // one chooser: the Dataset list gives way to 2 · LiDAR
    if (!c || !c.ring || c.ring.length < 4) { line.textContent = 'No area is chosen above: draw the map’s area here (a box, a polygon, a KML file).'; S.applied = ''; return; }
    const key = (c.id || '') + '|' + c.ring.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';');
    line.textContent = 'A map of “' + c.name + '”, the area chosen in 1' + (lidar().length ? ', from the point cloud chosen in 2.' : '.') + ' To map something else, draw it under Area to export.';
    if (key === S.applied) { askReuse(); return; }
    S.applied = key;
    try { if (w._exportSetPolygon) w._exportSetPolygon(c.ring.slice(0, -1), c.name); } catch (e) { console.warn('[process] area', e); }
    const nm = $('export_map_name'); if (nm && !nm.value.trim() && c.name && c.id) nm.value = c.name.slice(0, 60);
    if (!S.folded) { S.folded = true; ['lp-export-bbox-body'].forEach(id => { const b = $(id); if (b && b.classList.contains('open') && w._lpToggle) w._lpToggle(b.previousElementSibling); }); }
    askReuse();
  }
  async function askReuse() {
    const p = pick(), key = (p.area || '') + '|' + p.lidar;
    if (key === S.reuseKey) return S.reuse;
    S.reuseKey = key; S.reuse = null;
    if (p.area && p.lidar) {
      try { const j = await (await fetch('/api/areas/reuse?id=' + encodeURIComponent(p.area) + '&lidar=' + encodeURIComponent(p.lidar))).json(); if (key === S.reuseKey && j && j.ok) S.reuse = { ground: !!j.ground, ridge: !!j.ridge, trees: !!j.trees, shapes: !!j.shapes, why: j.why || {} }; } catch (_) {}
    }
    if (w._exportSyncModes) try { w._exportSyncModes(); } catch (_) {}
    return S.reuse;
  }
  function opened() { applyArea(); }

  function start() {
    if (!$(PANE)) return;
    mirror();
    questionMarks();
    // the line that says what the map is of, at the top of part 4
    const part = $('exportCollapsible'), wrap = part && part.querySelector('.lp-panel-wrap');
    if (wrap && !$('process-map-of')) { const d = doc.createElement('div'); d.id = 'process-map-of'; d.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.75); padding:4px 6px 6px;'; wrap.insertBefore(d, wrap.firstChild); }
    w.addEventListener('flex-areas-changed', () => { S.reuseKey = ''; if ($(PANE).classList.contains('show')) applyArea(); });
    applyArea();
  }
  w._process = { pick, reuse: () => S.reuse, askReuse, applyArea, open: () => { const b = doc.querySelector('[data-target="#' + PANE + '"]'); if (b && !$(PANE).classList.contains('show')) b.click(); } };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})();
