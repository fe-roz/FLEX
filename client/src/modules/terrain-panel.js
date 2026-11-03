// terrain-panel.js — the ⛰ Terrain panel (its own icon in the strip; #terrainCollapsible in index.html).
//
//   - the terrain patches there are (project 📁 and My data 👤), each with its hillshade, an eye, fly to, ←/→ move, remove;
//   - ＋ Add DEM GeoTIFF… (custom-layers.js addTerrain: bakes it in the browser);
//   - ⛰ Generate… : terrain + hillshade made from the LiDAR by the server (terrain_generate.js, the FLEX Field
//     export's pipeline) for an AREA from the area picker (area-picker.js: drawn here, the project footprint + a margin,
//     a polygon already on the map, or the Export box).
//
// Where results go: the open project; with no project, 👤 My data (user_files/mine/, the private project "mine":
// patch blobs in its .flex/blobs, hillshade tiles in FLEX maps/<name>/). Generate with no project offers the
// point clouds that are loaded.
//
// Moving: a patch and its hillshade between the project and My data, or to another project, waits for 💾 Save like the
// other moves (project-workspace.js moveItem; its commit calls commitMove here). Files are copied by the server
// (POST /api/terrain/move) into the destination, which gets the layers; the source lets go only then.
//
// window._terrainPanel = { render, generate(on), generateOpen, busy, items, moveItem, commitMove, picker, keep }
// The data and drawing of terrain patches stay in custom-layers.js (window._customLayers).
(function () {
  'use strict';
  const PJ = () => window._pj || {}, A = () => window._pjApi, MD = () => window._myData, FL = () => window.FlexLib, CL = () => window._customLayers, V = () => window.cesiumViewer;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = m => (A() && A().toast ? A().toast(m) : console.log('[terrain]', m));
  const $ = id => document.getElementById(id);
  const root = $('terrain-panel');
  if (!root) return;
  const MINE = 'mine';

  // ── What there is ────────────────────────────────────────────────────────
  const isGenTiles = l => l.kind === 'tiles' && /^\/api\/terrain\/tiles\//.test(l.url || '');
  const demOf = l => ((/[?&]dem=([^&]*)/.exec(l.url || '') || [])[1] || '').split(',').filter(Boolean);
  /** The patches, each with the hillshade made with it: [{ key, owner, name, terrains: [layer], tiles: layer|null }]. */
  function group(all) {
    const items = [], used = new Set();
    for (const owner of ['p', 'm']) {
      const mine = all.filter(l => l.owner === owner);
      mine.filter(isGenTiles).forEach(t => {
        const dem = demOf(t), ters = mine.filter(l => l.kind === 'terrain' && dem.includes(l.blob));
        ters.forEach(l => used.add(owner + ':' + l.id)); used.add(owner + ':' + t.id);
        const name = (t.name || '').replace(/ hillshade$/, '') || (ters[0] && ters[0].name) || 'Terrain';
        items.push({ key: t.id, owner, name, terrains: ters, tiles: t });
      });
      mine.filter(l => l.kind === 'terrain' && !used.has(owner + ':' + l.id)).forEach(l => items.push({ key: l.id, owner, name: l.name || 'Terrain', terrains: [l], tiles: null }));
    }
    return items;
  }
  const layersOf = it => it.terrains.concat(it.tiles ? [it.tiles] : []);
  let ITEMS = [];
  async function items(force) { const all = await CL().entries(force); return (ITEMS = group(all)); }

  // ── The panel ────────────────────────────────────────────────────────────
  root.innerHTML = `<div class="lp-section">
      <div class="lp-section-header" onclick="window._lpToggle(this)"><span class="lp-section-arrow">▾</span> Terrain</div>
      <div class="lp-section-body open">
        <div class="tp-where" id="tp-where"></div>
        <div id="tp-list"></div>
        <div class="tp-bar"><button type="button" data-t="dem" title="A DEM GeoTIFF baked into precise terrain for its area">＋ Add DEM GeoTIFF…</button>
          <button type="button" data-t="gen" id="tp-gen-btn" title="Terrain and a hillshade made from LiDAR for an area, once">⛰ Generate…</button></div>
        <div class="tp-gen" id="tp-gen" hidden>
          <div class="tp-t">⛰ Terrain + hillshade from the LiDAR</div>
          <div id="tp-picker"></div>
          <div class="tp-r">LiDAR <select id="tp-ept"></select></div>
          <div class="tp-r">Cell <select id="tp-cell"><option value="0.5" selected>0.5 m</option><option value="1">1 m</option><option value="2">2 m</option></select>
            Name <input type="text" id="tp-name" maxlength="60" placeholder="LiDAR terrain"></div>
          <div class="tp-r"><button type="button" class="tp-go" data-t="run">Generate</button><button type="button" data-t="close">Close</button></div>
          <div class="tp-prog" hidden><div></div></div><div class="tp-note" id="tp-msg"></div>
        </div>
      </div></div>`;

  const pjName = () => CL().api.projectName();
  const destNow = () => PJ().pid || MINE;

  let last = '';
  async function render(force) {
    if (!CL()) return;
    const its = await items(force), pw = window._pjWs, pj = PJ();
    const where = pj.pid ? `Results are kept in 📁 <b>${esc(pjName())}</b>.` : 'No project open: results are kept in 👤 <b>My data</b>.';
    const rows = its.map(it => {
      const first = it.terrains[0] || it.tiles, id = it.key, show = it.terrains.length ? CL().api.viewOf(it.terrains[0].id).show : false;
      const mv = pj.pid && pw && pw.movingItem ? pw.movingItem('terrain', id) : null;
      const km2 = it.terrains.reduce((a, l) => a + (l.bounds ? window._areaPicker.ringKm2([[l.bounds[0], l.bounds[1]], [l.bounds[2], l.bounds[1]], [l.bounds[2], l.bounds[3]], [l.bounds[0], l.bounds[3]]]) : 0), 0);
      const tag = mv ? `<b class="tp-pend">${mv === 'out' ? '→ My data' : mv === 'in' ? '← the project' : '⇢ ' + esc((((window._pjWsState || {}).moves || []).find(x => x.kind === 'terrain' && x.id === id) || {}).toName || 'another project')} on Save</b>` : '';
      const moves = !pj.pid ? '' : it.owner === 'p'
        ? `<button type="button" data-t="out" title="${mv === 'out' ? 'Cancel: stay in the project' : 'Move to My data (when you Save)'}"${mv === 'out' ? ' class="on"' : ''}>→</button><button type="button" data-t="proj" title="${mv === 'project' ? 'Cancel the move' : 'Move to another project (when you Save)'}"${mv === 'project' ? ' class="on"' : ''}>⇢</button>`
        : `<button type="button" data-t="in" title="${mv === 'in' ? 'Cancel: stay in My data' : 'Move into the open project (when you Save)'}"${mv === 'in' ? ' class="on"' : ''}>←</button>`;
      const hs = it.tiles ? `<div class="tp-hs"><button type="button" class="tp-eye ui-eye ui-eye-sm${CL().api.viewOf(it.tiles.id).show ? ' on' : ' half'}" data-t="hseye" title="Hillshade on the map"></button><span>hillshade</span></div>` : '';
      return `<div class="tp-item" data-key="${esc(id)}" data-owner="${it.owner}"><div class="tp-row">
          <button type="button" class="tp-eye ui-eye ui-eye-sm${show ? ' on' : ' half'}" data-t="eye" title="${show ? 'Hide' : 'Show'}"></button>
          <span class="tp-nm" title="${esc(it.name)}">${it.owner === 'p' ? '📁 ' : '👤 '}${esc(it.name)}${it.terrains.length > 1 ? ` <small>(${it.terrains.length} parts)</small>` : ''} <small>${first && first.bounds ? esc(window._areaPicker.fmtArea(km2)) : ''}</small></span>
          <span class="tp-tools"><button type="button" data-t="fly" title="Fly there">⌖</button>${moves}<button type="button" data-t="rm" title="${it.owner === 'p' ? 'Remove from the project' : 'Forget (out of My data)'}">✕</button></span></div>${tag ? `<div class="tp-tagrow">${tag}</div>` : ''}${hs}</div>`;
    }).join('');
    const html = where + '\u0001' + `<div class="tp-row tp-base"><span></span><span class="tp-nm">🌍 World terrain <small>everywhere</small></span><span></span></div>${rows}`
      + (!its.length ? '<div class="tp-empty">No terrain patches yet. Add a DEM GeoTIFF or generate one from LiDAR.</div>' : '');
    if (html !== last) { last = html; $('tp-where').innerHTML = where; $('tp-list').innerHTML = html.split('\u0001')[1]; }
    $('tp-gen-btn').title = 'Terrain and a hillshade made from LiDAR for an area, once; kept ' + (pj.pid ? 'in 📁 ' + pjName() : 'in 👤 My data');
    if (genOpen) { if (!busy) fillDatasets(); refresh(); }
  }
  const find = key => ITEMS.find(i => i.key === key);

  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    const t = b.dataset.t, row = b.closest('.tp-item'), it = row && find(row.dataset.key);
    try {
      if (t === 'dem') return CL().pickFile(true);
      if (t === 'gen') return generate();
      if (t === 'run') return run();
      if (t === 'close') return generate(false);
      if (!it) return;
      const api = CL().api;
      if (t === 'eye') { const on = !api.viewOf(it.terrains[0].id).show; it.terrains.forEach(l => api.setView(l.id, { show: on })); await CL().sync(); render(true); }
      else if (t === 'hseye') { api.setView(it.tiles.id, { show: !api.viewOf(it.tiles.id).show }); await CL().sync(); render(true); }
      else if (t === 'fly') api.flyTo(it.terrains[0] || it.tiles);
      else if (t === 'rm') remove(it);
      else if (t === 'out' || t === 'in') moveItem(it, t);
      else if (t === 'proj') moveToProject(it);
    } catch (err) { toast(err.message || String(err)); console.warn('[terrain]', err); }
  });

  async function remove(it) {
    const what = it.owner === 'p' ? `Remove “${it.name}” (terrain${it.tiles ? ' and hillshade' : ''}) from the project? (It stays in the project's history.)` : `Forget “${it.name}” (terrain${it.tiles ? ' and hillshade' : ''})?`;
    if (!window.confirm(what)) return;
    for (const l of layersOf(it)) await CL().remove(l);
    render(true);
  }

  // ── Moving (waits for 💾 Save) ───────────────────────────────────────────
  /** ← / → : between the project and My data; the same again cancels it. */
  async function moveItem(it, dir, extra) {
    const pw = window._pjWs; if (!pw || !pw.moveItem || !PJ().pid) return;
    await pw.moveItem(Object.assign({ kind: 'terrain', id: it.key, name: it.name, dir, layers: layersOf(it).map(l => l.id) }, extra || {}));
    const dirNow = pw.movingItem('terrain', it.key);
    if (dirNow) toast(`“${it.name}” will move ${dirNow === 'out' ? 'to My data' : dirNow === 'in' ? 'into the project' : 'to “' + ((extra && extra.toName) || 'the other project') + '”'} when you Save`);
    render(true);
  }
  async function moveToProject(it) {
    const pw = window._pjWs, pj = PJ();
    if (pw.movingItem('terrain', it.key) === 'project') return moveItem(it, 'project');            // again = cancel
    const dests = (pj.projects || []).filter(p => p.id !== pj.pid && !p.archived && !((window._pjx && window._pjx.state && window._pjx.state.info && window._pjx.state.info[p.id]) || {}).archived);
    if (!dests.length) { toast('There is no other project to move it to (archived projects are read-only)'); return; }
    const to = await A().choose(`Move “${it.name}” to…`, 'The terrain and its hillshade are copied into the other project (its files too); this project lets go of them when you press 💾 Save.',
      dests.map(p => ({ label: ['folder', p.name || p.id], value: p.id })));
    if (!to) return;
    const dest = dests.find(p => p.id === to);
    await moveItem(it, 'project', { to, toName: dest.name || dest.id });
  }
  /** 💾 Save: the server copies the files and writes the layers at the destination; then the source lets go. */
  async function commitMove(m) {
    const pj = PJ(), api = CL().api, from = m.dir === 'in' ? MINE : pj.pid, to = m.dir === 'out' ? MINE : m.dir === 'in' ? pj.pid : m.to;
    const all = await CL().entries(true), owner = m.dir === 'in' ? 'm' : 'p';
    const ls = all.filter(l => l.owner === owner && (m.layers || []).includes(l.id));
    if (!ls.length) throw new Error(`“${m.name}” is no longer there`);
    const r = await fetch('/api/terrain/move', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, who: A().who && A().who(), layers: ls.map((l, k) => ({ id: l.id, kind: l.kind, blob: l.blob, url: l.url, bounds: l.bounds, minZoom: l.minZoom, maxZoom: l.maxZoom, name: l.name, order: k })) }) });
    const o = await r.json().catch(() => ({}));
    if (!r.ok || !o.ok) throw new Error(o.error || ('move failed (' + r.status + ')'));
    // The destination has it (files and layers). The source lets go: History can bring it back.
    for (const l of ls) {
      if (owner === 'p') await A().record('layer.set', { layer: l.id, removed: true }, null, { quiet: true });
      else if (MD() && MD().record) await MD().record('layer.set', { layer: l.id, removed: true });
    }
    if (m.dir === 'in' && A().reload) await A().reload();                    // the project's log got the layers from the server
    if (m.dir === 'project' && window._pjx && window._pjx.forget) { window._pjx.forget(pj.pid); window._pjx.forget(m.to); }
    await CL().entries(true); await CL().sync(true); render(true);
    toast(`“${m.name}” moved ${m.dir === 'out' ? 'to My data' : m.dir === 'in' ? 'into the project' : 'to “' + (m.toName || 'the other project') + '”'}`);
  }

  // ── ⛰ Generate ───────────────────────────────────────────────────────────
  const JK = 'flex.cl.genjob';                      // a job still running (survives a reload)
  let genOpen = false, busy = false, poll = null, picker = null;
  const say = (msg, pct, bad) => {
    const m = $('tp-msg'), bar = root.querySelector('.tp-prog');
    if (m) { m.textContent = msg || ''; m.classList.toggle('tp-bad', !!bad); }
    if (bar) { bar.hidden = pct == null; bar.firstElementChild.style.width = (pct || 0) + '%'; }
  };
  /** The LiDAR there is: point clouds loaded now (Export's list), and the open project's own point cloud layers. */
  function datasets() {
    const out = [], seen = new Set(), add = (url, name) => { if (!url) return; if (!/ept\.json$/i.test(url)) url = url.replace(/\/$/, '') + '/ept.json'; if (!seen.has(url)) { seen.add(url); out.push({ url, name: name || url }); } };
    try { if (window._refreshEptDatasets) window._refreshEptDatasets(); } catch (_) {}
    const sel = $('export_ept_select');
    if (sel) [...sel.options].forEach(o => o.value && add(o.value, o.textContent));
    const pj = PJ();
    if (pj.pid && pj.P && FL()) FL().liveLayers(pj.P).filter(l => l.kind === 'pointcloud' && l.url).forEach(l => add(l.url, '📁 ' + (l.name || l.url)));
    return out;
  }
  function fillDatasets() {
    const sel = $('tp-ept'); if (!sel) return [];
    const ds = datasets(), was = sel.value;
    sel.innerHTML = ds.length ? ds.map(d => `<option value="${esc(d.url)}">${esc(d.name)}</option>`).join('') + (ds.length > 1 ? `<option value="*">All ${ds.length} together</option>` : '')
      : `<option value="">— load a point cloud first (LiDAR) —</option>`;
    if (was && [...sel.options].some(o => o.value === was)) sel.value = was;
    return ds;
  }
  function ensurePicker() {
    if (picker) return picker;
    if (!window._areaPicker) return null;
    picker = window._areaPicker.create({
      host: $('tp-picker'),
      hasFootprint: () => !!PJ().pid,
      footprint: async () => { const pj = PJ(); if (!pj.pid || !window._pjx || !window._pjx.info) return []; return (await window._pjx.info({ id: pj.pid, name: pjName() })).footprint || []; },
      onChange: () => refresh(),
    });
    return picker;
  }
  function generate(on) {
    genOpen = on == null ? !genOpen : !!on;
    $('tp-gen').hidden = !genOpen;
    if (!genOpen) { if (picker) picker.outline(false); return; }
    ensurePicker();
    fillDatasets();
    if (picker) picker.refresh().then(async () => {
      // A first choice: the project's footprint + margin; else the Export panel's area if it has one.
      if (!picker.area() && !picker.isDrawing()) {
        const key = PJ().pid ? 'fp' : (window._exportArea && window._exportArea() ? 'export' : '');
        if (key) await picker.choose(key, true);
      } else if (picker.area()) picker.outline();
      refresh();
    });
    refresh();
  }
  function refresh() {
    const go = root.querySelector('.tp-go'); if (!go) return;
    go.disabled = !($('tp-ept') && $('tp-ept').value) || busy || !picker || !picker.area();
  }
  async function run() {
    if (busy) return;
    const pj = PJ(), a = picker && picker.area();
    if (!a) return say('Choose or draw the area first.', null, true);
    if (a.crossing) return say('The area’s edges cross: draw it again so they don’t.', null, true);
    const pick = $('tp-ept').value, ds = datasets(), ept = pick === '*' ? ds.map(d => d.url) : pick ? [pick] : [];
    if (!ept.length) return say('Load a point cloud first (LiDAR).', null, true);
    const lat = (a.bbox[1] + a.bbox[3]) / 2, lon = (a.bbox[0] + a.bbox[2]) / 2;
    const dz = typeof window._pcDatumDz === 'function' ? window._pcDatumDz(lat, lon) : null;
    const name = ($('tp-name').value || '').trim() || 'LiDAR terrain';
    send(Object.assign({ bbox: a.bbox, polygon: a.polygon, ept, resolution: +$('tp-cell').value || 0.5, z_offset: dz, name }, pj.pid ? { project: pj.pid } : { dest: MINE }));
  }
  async function send(body) {
    busy = true; refresh(); say('Starting…', 2);
    const dest = body.project || MINE;
    try {
      const r = await fetch('/api/terrain/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) throw new Error(j.error || 'the server did not take the job');
      try { localStorage.setItem(JK, JSON.stringify({ jobId: j.jobId, pid: dest, name: body.name })); } catch (_) {}
      // The Jobs panel (jobs-panel.js): Cancel and Log go to the server; Retry sends the same request again
      if (window._jobs) window._jobs.add({ id: 'terrain.' + j.jobId, kind: 'terrain', name: 'Terrain and hillshade: ' + body.name, server: true, retry: () => { if (!busy) send(body); } });
      watch(j.jobId, dest, body.name);
    } catch (e) { busy = false; refresh(); say('❌ ' + e.message, null, true); }
  }
  function watch(jobId, dest, name) {
    busy = true; clearTimeout(poll);
    const tick = async () => {
      let j;
      try { const r = await fetch('/api/terrain/status/' + jobId); j = await r.json(); if (r.status === 404) j = { status: 'error', error: 'the job is gone (was FLEX restarted?)' }; }
      catch (_) { poll = setTimeout(tick, 2500); return; }
      if (j.status === 'running') { say(String(j.message || 'Working…').replace(/^\[\d\/4\]\s*/, ''), j.progress || 5); poll = setTimeout(tick, 1500); return; }
      try { localStorage.removeItem(JK); } catch (_) {}
      busy = false;
      if (j.status === 'done' && j.result) {
        try { await keep(j.result, dest, name); say(`✅ Done: “${name}” terrain and hillshade are in ${dest === MINE ? 'My data' : 'the project'}.`, 100); }
        catch (e) { say('❌ ' + e.message, null, true); }
      } else say('❌ ' + (j.error || 'it did not work'), null, true);
      refresh();
    };
    tick();
  }
  /** The finished job → two kinds of layers: the terrain patch(es) and the hillshade tiles, in the project or in My data. */
  async function keep(R, dest, name) {
    if (dest !== MINE && PJ().pid !== dest) throw new Error('the project was closed: the files are in its folder, but the layers were not added');
    const rec = (e, v) => CL().api.record(e, v, dest === MINE ? 'mine' : undefined);
    const T = R.terrain, H = R.tiles, nm = R.name || name;
    const parts = Array.isArray(R.terrains) && R.terrains.length ? R.terrains : [T];       // a big area is several patches, later ones over earlier ones
    for (const [k, P] of parts.entries()) await rec({ layer: 'ter-' + P.blob.slice(0, 12), kind: 'terrain', blob: P.blob, bounds: P.bounds.map(n => +(+n).toFixed(8)), name: parts.length > 1 ? `${nm} (part ${k + 1})` : nm });
    await rec({ layer: 'hs-' + T.blob.slice(0, 12), kind: 'tiles', url: H.url, bounds: H.bounds.map(n => +(+n).toFixed(8)), minZoom: H.minzoom, maxZoom: H.maxzoom, name: nm + ' hillshade' }, { alpha: 0.75 });
    toast(`⛰ “${nm}”: terrain ${parts.length > 1 ? parts.length + ' patches of up to ' : ''}${T.nx}×${T.ny} posts of ${T.cell_m} m, hillshade ${H.count} tiles (${dest === MINE ? 'My data: ' : ''}${R.folder})`);
    const v = V(); if (v && T.bounds) v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(...T.bounds), duration: 1.5 });
    render(true);
  }
  // A job that was running when the page went away: pick it up again.
  setTimeout(function resume() {
    let j = null; try { j = JSON.parse(localStorage.getItem(JK) || 'null'); } catch (_) {}
    if (!j || !j.jobId) return;
    if (j.pid !== MINE && PJ().pid !== j.pid) { if (!PJ().ready) setTimeout(resume, 2000); return; }
    generate(true); watch(j.jobId, j.pid, j.name);
  }, 3000);

  // ── Wiring ───────────────────────────────────────────────────────────────
  const isOpen = () => $('terrainCollapsible') && $('terrainCollapsible').classList.contains('show');
  window.addEventListener('flex-custom-layers', () => { if (isOpen()) render(); });
  document.querySelector('[data-target="#terrainCollapsible"]')?.addEventListener('click', () => setTimeout(() => { render(true); if (genOpen && picker) picker.refresh(); }, 0));
  setInterval(() => { if (isOpen()) render(); }, 1500);
  new MutationObserver(() => { if (!isOpen() && picker && picker.isDrawing()) picker.cancel(); }).observe($('terrainCollapsible'), { attributes: true, attributeFilter: ['class'] });

  const st = document.createElement('style');
  st.textContent = `
  #terrain-panel { font-size: 11px; }
  #terrain-panel .tp-where { color: rgba(255,255,255,.65); margin: 0 0 4px; }
  #terrain-panel .tp-row { display: grid; grid-template-columns: 24px 1fr auto; gap: 5px; align-items: center; padding: 2px 3px; border-radius: 5px; }
  #terrain-panel .tp-row:hover { background: rgba(255,255,255,.07); }
  #terrain-panel .tp-base small, #terrain-panel .tp-nm small { color: rgba(255,255,255,.4); margin-left: 3px; }
  #terrain-panel .tp-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,.88); }
  #terrain-panel .tp-tools { display: inline-flex; gap: 1px; opacity: .55; } #terrain-panel .tp-row:hover .tp-tools { opacity: 1; }
  #terrain-panel .tp-tools button { background: none; border: none; color: rgba(255,255,255,.75); padding: 0 4px; cursor: pointer; font-size: 12px; }
  #terrain-panel .tp-tools button.on { color: #ffcf6b; }
  #terrain-panel .tp-pend { color: #ffcf6b; font-weight: 600; font-size: 10px; } #terrain-panel .tp-tagrow { padding: 0 3px 2px 32px; }
  #terrain-panel .tp-hs { display: flex; align-items: center; gap: 6px; padding: 0 3px 2px 12px; color: rgba(255,255,255,.55); font-size: 10.5px; }
  #terrain-panel .tp-empty { color: rgba(255,255,255,.45); font-style: italic; font-size: 10.5px; padding: 4px; }
  #terrain-panel .tp-bar { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
  #terrain-panel button { font: inherit; }
  #terrain-panel .tp-bar button, #terrain-panel .tp-gen button { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #e8ece9; border-radius: 5px; padding: 2px 8px; font-size: 10.5px; cursor: pointer; }
  #terrain-panel .tp-bar button:hover { background: rgba(255,255,255,.12); }
  #terrain-panel .tp-gen { margin: 6px 0 2px; padding: 6px 7px; border: 1px solid rgba(255,255,255,.14); border-radius: 6px; background: rgba(255,255,255,.04); display: flex; flex-direction: column; gap: 4px; }
  #terrain-panel .tp-gen[hidden] { display: none; }
  #terrain-panel .tp-t { font-weight: 600; color: #e8ece9; }
  #terrain-panel .tp-r { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; color: rgba(255,255,255,.8); }
  #terrain-panel .tp-gen input, #terrain-panel .tp-gen select { background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; padding: 1px 4px; font-size: 11px; min-width: 0; }
  #terrain-panel #tp-ept, #terrain-panel #tp-name { flex: 1; }
  #terrain-panel button.tp-go { background: #2d6a4f; border-color: #3f8f6b; font-weight: 600; } #terrain-panel button:disabled { opacity: .45; cursor: default; }
  #terrain-panel .tp-note { color: rgba(255,255,255,.55); font-size: 10.5px; line-height: 1.35; } #terrain-panel .tp-bad { color: #ff7a7a; }
  #terrain-panel .tp-prog { height: 4px; background: rgba(255,255,255,.1); border-radius: 2px; overflow: hidden; } #terrain-panel .tp-prog > div { height: 100%; width: 0; background: #00e5ff; transition: width .4s; }
  #terrain-panel .tp-prog[hidden] { display: none; }`;
  document.head.appendChild(st);

  window._terrainPanel = { render, generate, generateOpen: () => genOpen, busy: () => busy, items, moveItem, commitMove, keep, group, picker: () => picker, datasets };
  render(true);
})();
