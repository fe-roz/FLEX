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
  function opened() { applyArea(); paintPresets(); }

  // ── Presets ───────────────────────────────────────────────────────────────
  // A preset is a named set of the ticks of 3 and the settings of 3 and 4 (flexlib.js presetClean says what may be in
  // one). FLEX comes with two; yours are kept in the open project (op preset.set, so they sync) or, with no project,
  // on this computer (localStorage flex.process.presets).
  const PKEY = 'flex.process.presets', FL = () => w.FlexLib, PJ = () => w._pj || {};
  const SET_IDS = ['export_terrain_source', 'export_map_cell', 'export_caves_mode', 'export_docs_on', 'export_features_on', 'export_ridgewalk', 'export_ridge_shapes', 'export_trees', 'export_slope_map',
    'export_satellite_source', 'export_hillshade_mode', 'export_brush_strength', 'export_resolution', 'export_max_tri', 'export_tex_size', 'lidar_veg_lo', 'lidar_veg_hi', 'lidar_void_depth', 'lidar_void_min', 'lidar_low_cut'];
  const inProject = () => !!(PJ().pid && PJ().P && w._pjApi && !PJ().readonly);
  const localList = () => { try { const a = JSON.parse(lget(PKEY) || '[]'); return Array.isArray(a) ? a.filter(q => q && q.id && q.name).map(q => ({ id: String(q.id), name: String(q.name).slice(0, 60), values: FL().presetClean(q.values) })) : []; } catch (_) { return []; } };
  /** Shipped ones first, then the project's (or this computer's, with no project). */
  function presets() {
    if (!FL() || !FL().PROCESS_PRESETS) return [];
    const own = inProject() ? FL().livePresets(PJ().P).map(q => ({ id: q.id, name: q.name, values: q.values, where: 'project' })) : localList().map(q => Object.assign(q, { where: 'computer' }));
    return FL().PROCESS_PRESETS.map(q => Object.assign({}, q)).concat(own);
  }
  /** The ticks and settings as they stand → a preset's values. */
  function capture() {
    const v = { make: {}, mapsCell: '', set: {} }, t = (w._areas && w._areas.ticks) ? w._areas.ticks() : {};
    ['bush', 'veg', 'ridge', 'prospect', 'terrain'].forEach(k => { v.make[k] = !!t[k]; });
    if (w._areas && w._areas.mapsCell) v.mapsCell = w._areas.mapsCell() || '';
    SET_IDS.forEach(id => { const e = $(id); if (!e) return; v.set[id] = e.type === 'checkbox' ? !!e.checked : String(e.value); });
    return FL().presetClean(v);
  }
  /** Put a preset's ticks and settings in the pane. What this computer cannot do (a map layer it has not, a greyed option) is left as it is → { applied, skipped: [ids] }. */
  function applyPreset(id) {
    const q = presets().find(x => x.id === id); if (!q) return null;
    const v = q.values || {}, skipped = [];
    if (w._areas && w._areas.setTicks) w._areas.setTicks(Object.assign(w._areas.ticks(), v.make || {}));
    if (w._areas && w._areas.setMapsCell && (v.mapsCell || '') !== (w._areas.mapsCell() || '')) w._areas.setMapsCell(v.mapsCell || '');
    // the terrain source first: it decides which of the others can be had
    Object.keys(v.set || {}).sort((a, b) => (a === 'export_terrain_source' ? -1 : b === 'export_terrain_source' ? 1 : 0)).forEach(k => {
      const e = $(k), x = v.set[k]; if (!e) return void skipped.push(k);
      if (e.type === 'checkbox') { if (e.checked === !!x) return; if (e.disabled) return void skipped.push(k); e.click(); return; }
      if (String(e.value) === String(x)) return;
      if (e.tagName === 'SELECT' && ![...e.options].some(o => o.value === String(x))) return void skipped.push(k);
      e.value = String(x); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    });
    try { if (w._exportSyncModes) w._exportSyncModes(); } catch (_) {}
    S.preset = id; paintPresets();
    return { applied: q.name, skipped };
  }
  async function savePreset(name, id) {
    name = String(name || '').trim().slice(0, 60); if (!name) return null;
    const values = capture(); id = id || ('q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    if (inProject()) { const e = await w._pjApi.record('preset.set', { preset: id, name, values }); if (!e) return null; }
    else { const l = localList().filter(q => q.id !== id); l.push({ id, name, values }); lset(PKEY, JSON.stringify(l)); }
    S.preset = id; paintPresets(); return id;
  }
  async function renamePreset(id, name) {
    const q = presets().find(x => x.id === id); name = String(name || '').trim().slice(0, 60);
    if (!q || q.shipped || !name) return false;
    if (q.where === 'project') { if (!(await w._pjApi.record('preset.set', { preset: id, name }))) return false; }
    else lset(PKEY, JSON.stringify(localList().map(x => x.id === id ? Object.assign(x, { name }) : x)));
    paintPresets(); return true;
  }
  async function removePreset(id) {
    const q = presets().find(x => x.id === id); if (!q || q.shipped) return false;
    if (q.where === 'project') { if (!(await w._pjApi.record('preset.set', { preset: id, removed: true }))) return false; }
    else lset(PKEY, JSON.stringify(localList().filter(x => x.id !== id)));
    if (S.preset === id) S.preset = ''; paintPresets(); return true;
  }
  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function paintPresets() {
    const host = $('process-presets'); if (!host || !FL() || !FL().PROCESS_PRESETS) return;
    const list = presets(), cur = list.find(q => q.id === S.preset), own = cur && !cur.shipped;
    const h = `<div class="pp-row"><label for="process-preset">Preset</label><select id="process-preset" aria-label="Preset"><option value="">— choose —</option>${list.map(q => `<option value="${esc(q.id)}"${q.id === S.preset ? ' selected' : ''}>${esc(q.name)}${q.shipped ? '' : q.where === 'project' ? ' (project)' : ' (this computer)'}</option>`).join('')}</select>
      <button type="button" class="pp-btn" data-pp="apply"${cur ? '' : ' disabled'} title="Set the ticks and settings below to this preset">Apply</button></div>
      <div class="pp-row"><button type="button" class="pp-btn" data-pp="save" title="Keep the ticks and settings as they are now under a name${inProject() ? ', in the project' : ', on this computer (open a project to keep them in it)'}">Save current as…</button>
      <button type="button" class="pp-btn" data-pp="rename"${own ? '' : ' disabled'}>Rename</button><button type="button" class="pp-btn" data-pp="delete"${own ? '' : ' disabled'}>Delete</button><span class="pp-note" id="process-preset-note">${esc(S.presetNote || '')}</span></div>`;
    if (host.dataset.h !== h) { host.dataset.h = h; host.innerHTML = h; }
  }
  async function askName(title, value) {
    const dlg = w._pjApi && w._pjApi.dialog;
    if (!dlg) { const r = w.prompt(title, value || ''); return r && r.trim(); }
    const r = await dlg({ title, input: { value: value || '' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    return r && r.button === 'ok' ? String(r.value || '').trim() : null;
  }
  function presetEvents() {
    const host = $('process-presets'); if (!host) return;
    host.addEventListener('change', e => { if (e.target.id === 'process-preset') { S.preset = e.target.value; S.presetNote = ''; paintPresets(); } });
    host.addEventListener('click', async e => {
      const b = e.target.closest('[data-pp]'); if (!b || b.disabled) return;
      const act = b.dataset.pp, q = presets().find(x => x.id === S.preset);
      if (act === 'apply' && q) { const r = applyPreset(q.id); S.presetNote = r ? 'Applied.' + (r.skipped.length ? ' ' + r.skipped.length + ' setting' + (r.skipped.length > 1 ? 's' : '') + ' not available here left as they were.' : '') : ''; paintPresets(); }
      else if (act === 'save') { const n = await askName('Save the current ticks and settings as a preset', q && !q.shipped ? q.name : ''); if (n) { const same = presets().find(x => !x.shipped && x.name === n); await savePreset(n, same && same.id); S.presetNote = 'Saved' + (inProject() ? ' in the project.' : ' on this computer.'); paintPresets(); } }
      else if (act === 'rename' && q) { const n = await askName('Rename the preset', q.name); if (n) await renamePreset(q.id, n); }
      else if (act === 'delete' && q) {
        const dlg = w._pjApi && w._pjApi.dialog;
        const yes = dlg ? ((await dlg({ title: 'Delete the preset “' + q.name + '”?', text: 'The ticks and settings in the pane stay as they are.', buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'ok', primary: true }] })) || {}).button === 'ok' || false : w.confirm('Delete the preset “' + q.name + '”?');
        if (yes) await removePreset(q.id);
      }
    });
    w.addEventListener('flex-project-changed', paintPresets);
  }

  function start() {
    if (!$(PANE)) return;
    mirror();
    questionMarks();
    presetEvents(); paintPresets();
    // the line that says what the map is of, at the top of part 4
    const part = $('exportCollapsible'), wrap = part && part.querySelector('.lp-panel-wrap');
    if (wrap && !$('process-map-of')) { const d = doc.createElement('div'); d.id = 'process-map-of'; d.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.75); padding:4px 6px 6px;'; wrap.insertBefore(d, wrap.firstChild); }
    w.addEventListener('flex-areas-changed', () => { S.reuseKey = ''; paintPresets(); if ($(PANE).classList.contains('show')) applyArea(); });
    applyArea();
  }
  w._process = { pick, reuse: () => S.reuse, askReuse, applyArea, presets: { list: presets, capture, apply: applyPreset, save: savePreset, rename: renamePreset, remove: removePreset }, open: () => { const b = doc.querySelector('[data-target="#' + PANE + '"]'); if (b && !$(PANE).classList.contains('show')) b.click(); } };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})();
