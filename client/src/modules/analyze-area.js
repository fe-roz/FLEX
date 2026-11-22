// analyze-area.js — 🔬 Analyze by AREA: choose an area and the LiDAR once, tick the tools to run in it, one "Run ticked".
// A finished run keeps the area as a PROCESSED AREA with its results (server: areas_api.js, /api/areas/*), listed here
// with one switch per area and per result; the same switches appear in ⛰ Terrain; bushwhack and ground
// maps are normal layers in 🗺 Layers (area-maps.js), vegetation shapes stay here.
//
//   1 Area     processed / saved areas (a pick list, "processed" tag), the area picker's ways to choose a new one
//              (window._areaPicker: drawn polygon, project footprint + margin, a polygon on the map, the Export box),
//              the current area card (name, km², width × height, a name field for a new one)
//   2 LiDAR    one chooser (keep-box checkboxes): the clouds loaded now + the project's (window._surfRoute.datasets())
//   3 Tools    Ground (locked, first), Terrain + hillshade, Vegetation shapes, Bushwhack / voids: tick, status chip from
//              POST /api/areas/check with its reason, offers when too big; sticky bar "N ticked · about X min" + Run ticked
//   4 Processed areas   GET /api/areas: switch, name, tag, km², date, result chips; opens to one row per result
//
// When /api/areas does not answer (an older server) the pane is left exactly as it was (old sections untouched).
// Shown state is restored LAZILY: the first time Analyze, Layers or Terrain is opened (no fetch at startup).
//
// window._areas = { available(), list(), refresh(), current(), setCurrent(area), lidar(), setLidar(urls), check(),
//   run(tools, options), show(areaId, on), showResult(areaId, result, on), shown(), eyeOf(areaId, result?),
//   remove(areaId), removeResult(areaId, result), runMore(areaId), pure }
// Event: "flex-areas-changed" (detail: { why }).   Node (tools/test_analyze_area.js): module.exports = pure.
(function (root) {
  'use strict';

  // ── Pure ─────────────────────────────────────────────────────────────────
  const TOOLS = [
    { id: 'terrain', name: 'Terrain + hillshade', icon: '⛰' },
    { id: 'veg', name: 'Vegetation shapes', icon: '🌲' },
    { id: 'bush', name: 'Bushwhack / voids', icon: '∴' },
    { id: 'prospect', name: 'Prospects (beta)', icon: '◎', desc: 'Possible entrances: hollows, points below the ground, cliff openings. A list to look at, not a ranking.' },
  ];
  const RNAME = { ground: 'Ground', terrain: 'Terrain', veg: 'Vegetation', bush: 'Bushwhack', prospect: 'Prospects (beta)' };
  const RKEYS = ['ground', 'terrain', 'veg', 'bush', 'prospect'];
  const SHOWABLE = ['terrain', 'veg', 'bush', 'prospect'];
  const MAPRES = ['bush', 'ground'];      // results drawn as map layers in 🗺 Layers (area-maps.js), not here
  const CHIP = { fits: ['ok', 'Fits'], partly: ['warn', 'Partly covered'], toobig: ['bad', 'Too big'], needslidar: ['bad', 'Needs LiDAR'] };

  /** An offer → the options patch for its tool. { options } wins; else "name=value" / "name:value"; else { [key]: true }. */
  function offerOptions(o) {
    if (!o) return {};
    if (o.options && typeof o.options === 'object') return Object.assign({}, o.options);
    const k = String(o.key || ''), m = k.match(/^([\w-]+)\s*[=:]\s*(.+)$/);
    if (m) { const v = m[2].trim(); return { [m[1]]: /^-?\d+(\.\d+)?$/.test(v) ? +v : v }; }
    return k ? { [k]: true } : {};
  }
  /** The check / run `options` from the applied offers: { tool: offer } → { tool: {…} }. */
  function optionsOf(fix) {
    const out = {};
    Object.keys(fix || {}).forEach(t => { if (fix[t]) out[t] = offerOptions(fix[t]); });
    return out;
  }
  /** The rows of the tools list from a check answer. st.ticks { tool: bool }, st.fix { tool: offer }, st.area (area.json or null). */
  function toolRows(check, st) {
    st = st || {};
    const ticks = st.ticks || {}, fix = st.fix || {}, res = (st.area && st.area.results) || {};
    return TOOLS.map(t => {
      const c = (check && check.tools && check.tools[t.id]) || null;
      const k = c ? (CHIP[c.status] ? c.status : 'fits') : null;
      const chip = k ? CHIP[k] : ['wait', 'Checking…'];
      const bad = chip[0] === 'bad', offers = bad && c && Array.isArray(c.offers) && c.offers.length ? c.offers : null;
      let why = c ? String(c.why || '') : '';
      const used = fix[t.id] && !bad ? fix[t.id] : null;
      if (used) why = (why ? why + ' ' : '') + 'Using: ' + (used.label || used.key) + '.';
      if (res[t.id] && !bad) why = 'Already made ' + shortDate(res[t.id].date) + '; running again replaces it. ' + why;
      return { id: t.id, name: t.name, icon: t.icon, desc: t.desc || '', status: k, st: chip[0], chip: chip[1], why: why.trim(), offers, used,
        minutes: c && +c.minutes || 0, ticked: !!ticks[t.id] && !bad, disabled: !c || (bad && !offers) };
    });
  }
  /** The locked Ground row. */
  function groundRow(check, area) {
    const g = area && area.results && area.results.ground, cg = (check && check.ground) || {};
    if (g) return { st: 'ok', chip: 'Made', why: 'Made ' + shortDate(g.date) + ' for this area. Every tool below reuses it.' };
    if (cg.status === 'needslidar') return { st: 'bad', chip: 'Needs LiDAR', why: cg.why || 'Ground comes from LiDAR, and no ticked cloud covers this area.' };
    const m = +cg.minutes || 0;
    return { st: 'ok', chip: 'First step', why: 'Made once, first, when a ticked tool needs it' + (m ? ' (' + minTxt(m) + ')' : '') + '. Every later run reuses it.' };
  }
  const minTxt = m => m < 1.5 ? 'about 1 min' : 'about ' + Math.round(m) + ' min';
  /** The run bar: { tools, minutes, text }. Ground's minutes count when it is not made yet. */
  function plan(rows, check, area) {
    const tools = rows.filter(r => r.ticked).map(r => r.id);
    let min = rows.filter(r => r.ticked).reduce((a, r) => a + (r.minutes || 0), 0);
    const hasG = !!(area && area.results && area.results.ground);
    if (tools.length && !hasG && check && check.ground && +check.ground.minutes) min += +check.ground.minutes;
    return { tools, minutes: min, text: tools.length ? tools.length + ' ticked · ' + minTxt(min) : 'Tick at least one tool.' };
  }
  /** The switch state: { areas: { id: { on, res: { tool: bool } } } }. One vegetation set drawn at a time. */
  function reduce(state, a) {
    const s = { areas: {} };
    Object.keys((state && state.areas) || {}).forEach(id => { const x = state.areas[id]; s.areas[id] = { on: !!x.on, res: Object.assign({}, x.res) }; });
    const ent = id => (s.areas[id] = s.areas[id] || { on: false, res: {} });
    const vegOff = keep => Object.keys(s.areas).forEach(id => { if (id !== keep && s.areas[id].on && s.areas[id].res.veg !== false) s.areas[id].res.veg = false; });
    if (a.type === 'show') {
      const e = ent(a.id); e.on = !!a.on;
      if (e.on && e.res.veg !== false && (!a.has || a.has.includes('veg'))) vegOff(a.id);
    } else if (a.type === 'showResult') {
      const e = ent(a.id); e.res[a.result] = !!a.on;
      if (a.on) { e.on = true; if (a.result === 'veg') vegOff(a.id); }
    } else if (a.type === 'forget') delete s.areas[a.id];
    else if (a.type === 'forgetResult') { if (s.areas[a.id]) delete s.areas[a.id].res[a.result]; }
    return s;
  }
  /** 'on' | 'half' | '' for an area's switch (no result) or one result's. */
  function eyeOf(state, id, result) {
    const e = state && state.areas && state.areas[id];
    if (!result) return e && e.on ? 'on' : '';
    if (!e || !e.on) return '';
    return e.res[result] === false ? 'half' : 'on';
  }
  /** What should be drawn: [{ id, result }] for areas that exist and have that result. */
  function drawnOf(state, areas) {
    const out = [];
    (areas || []).forEach(a => SHOWABLE.forEach(r => { if (a.results && a.results[r] && eyeOf(state, a.id, r) === 'on') out.push({ id: a.id, result: r }); }));
    return out;
  }
  /** Width × height in km of a [[lon, lat]…] ring. */
  function sizeKm(ring) {
    if (!ring || ring.length < 2) return [0, 0];
    const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]), lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
    return [(Math.max(...lons) - Math.min(...lons)) * 111.32 * Math.cos(lat0 * Math.PI / 180), (Math.max(...lats) - Math.min(...lats)) * 110.54];
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(d) { const t = new Date(d); return isNaN(t) ? String(d || '') : t.getUTCDate() + ' ' + MON[t.getUTCMonth()]; }
  function fmtMB(b) { b = +b || 0; return b >= 1e8 ? Math.round(b / 1e6) + ' MB' : b >= 1e5 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' B'; }
  /** Tools an area has not got yet (Run more tools here ticks these). */
  const missing = area => TOOLS.map(t => t.id).filter(k => !(area && area.results && area.results[k]));

  const pure = { TOOLS, CHIP, offerOptions, optionsOf, toolRows, groundRow, plan, reduce, eyeOf, drawnOf, sizeKm, shortDate, fmtMB, missing, minTxt };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document) return;

  // ── Browser ──────────────────────────────────────────────────────────────
  const w = root, doc = root.document;
  const $ = id => doc.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PJ = () => w._pj || {}, V = () => w.cesiumViewer, CL = () => w._customLayers;
  const SKEY = 'flex.areas.shown';
  const lget = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const fire = why => w.dispatchEvent(new CustomEvent('flex-areas-changed', { detail: { why } }));
  const post = async (u, body) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); };

  let SHOW = { areas: {} };
  try { const o = JSON.parse(lget(SKEY) || 'null'); if (o && o.areas) SHOW = o; } catch (_) {}
  const S = { avail: null, areas: [], cur: null, lidar: null, ticks: {}, fix: {}, check: null, checkErr: '', running: null,
    open: null, delAsk: null, delRes: null, lastRun: null, restored: false, picking: false };
  let picker = null, host = null, checkT = null, checkSeq = 0;

  // ── Toasts: FLEX's one toast (project-ui-kit.js), queued so several notes are each read ──
  const tq = [];
  function toast(msg) {
    tq.push(msg); if (tq.length > 1) return;
    const next = () => { const m = tq[0]; if (m == null) return; try { if (w._pjApi && w._pjApi.toast) w._pjApi.toast(m); else console.log('[areas]', m); } catch (_) {} setTimeout(() => { tq.shift(); next(); }, 2900); };
    next();
  }

  // ── Server ──
  async function refresh() {
    let r;
    try { r = await fetch('/api/areas?project=' + encodeURIComponent(PJ().pid || '')); }
    catch (_) { r = null; }
    if (!r || !r.ok) { if (S.avail !== true) setAvail(false); return S.areas; }
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!j || !j.ok) { if (S.avail !== true) setAvail(false); return S.areas; }
    S.areas = Array.isArray(j.areas) ? j.areas : [];
    if (S.cur && S.cur.id) { const a = S.areas.find(x => x.id === S.cur.id); if (a) S.cur = curOf(a); }
    setAvail(true);
    paint(); fire('list');
    return S.areas;
  }
  const curOf = a => ({ id: a.id, name: a.name, ring: a.ring, src: a.results && Object.keys(a.results).length ? 'Processed area' : 'Saved area' });
  const areaById = id => S.areas.find(a => a.id === id) || null;
  const curArea = () => (S.cur && S.cur.id ? areaById(S.cur.id) : null);

  // ── The old pickers go when this is here ──
  function setAvail(on) {
    S.avail = on;
    const pane = $('lidarDeriveCollapsible');
    if (pane) pane.classList.toggle('areas-on', !!on);
    if (host) host.hidden = !on;
    if (on) hideOld();
  }
  /** veg-panel's own Area / LiDAR / Detail / Build and Keep rows; lidar-derive's Area and Point cloud sections and its button. */
  function hideOld() {
    const pk = $('vg-picker');
    if (pk) {
      let e = pk.previousElementSibling;                                           // the "Area" heading
      while (e && e.id !== 'vg-bar') { e.classList.add('areas-old'); e = e.nextElementSibling; }
      const note = $('vg-body') && $('vg-body').querySelector('.vg-note');
      if (note && !note.dataset.areas) { note.dataset.areas = '1'; note.textContent = 'The look of the vegetation shown on the map (made in Tools to run in this area, above).'; }
      const kb = $('vg-keep'); if (kb && kb.parentElement) { kb.parentElement.classList.add('areas-old'); if (kb.parentElement.previousElementSibling) kb.parentElement.previousElementSibling.classList.add('areas-old'); }
    }
    doc.querySelectorAll('[data-areas-old]').forEach(e => e.classList.add('areas-old'));
  }

  // ── The current area ──
  function current() { return S.cur ? { id: S.cur.id, name: S.cur.name, ring: S.cur.ring } : null; }
  function setCurrent(a) {
    if (!a) { S.cur = null; S.fix = {}; S.check = null; paint(); outline(null); return null; }
    if (a.id && areaById(a.id)) S.cur = curOf(areaById(a.id));
    else S.cur = { id: a.id, name: a.name || 'New area', ring: a.ring, src: a.src || 'Drawn' };
    S.fix = {}; S.check = null;
    if (S.cur.id) { S.picking = true; try { if (picker) picker.clear(); } finally { S.picking = false; } outline(S.cur.ring); }
    paint(); scheduleCheck(); fire('current');
    return current();
  }
  let ods = null;
  function outline(ring) {
    const v = V(); if (!v || !w.Cesium) return;
    try {
      if (!ods || !v.dataSources.contains(ods)) { ods = new Cesium.CustomDataSource('analyze-area'); v.dataSources.add(ods); }
      ods.entities.removeAll();
      if (ring && ring.length >= 3) {
        const pos = ring.map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1])), col = Cesium.Color.fromCssColorString('#ff9a62');
        ods.entities.add({ polyline: { positions: pos.concat([pos[0]]), width: 3, material: col, clampToGround: true } });
      }
      if (v.scene.requestRender) v.scene.requestRender();
    } catch (e) { console.warn('[areas] outline', e); }
  }
  function ensurePicker() {
    if (picker || !w._areaPicker || !$('ar-picker')) return picker;
    picker = w._areaPicker.create({
      host: $('ar-picker'),
      hasFootprint: () => !!PJ().pid,
      footprint: async () => { const pj = PJ(); if (!pj.pid || !w._pjx || !w._pjx.info) return []; let nm = ''; try { nm = w._customLayers.api.projectName(); } catch (_) {} return (await w._pjx.info({ id: pj.pid, name: nm })).footprint || []; },
      onChange: a => {
        if (S.picking) return;
        if (!a) { if (S.cur && !S.cur.id) setCurrent(null); return; }
        outline(null);
        const ring = a.polygon && a.polygon.length >= 3 ? a.polygon : [[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[1]], [a.bbox[2], a.bbox[3]], [a.bbox[0], a.bbox[3]]];
        S.cur = { name: (S.draftName || '').trim() || 'New area', ring, src: a.label ? a.label.charAt(0).toUpperCase() + a.label.slice(1) : 'Drawn', crossing: a.crossing };
        S.fix = {}; S.check = null; paint(); scheduleCheck(); fire('current');
      },
    });
    // The picker's drawing banner shares the Surface route banner's class; hidden, it must not look like a live "picking" banner
    // to other tools (they ask "is any .pjf-banner in the page?").
    const bn = $('ar-picker') && $('ar-picker').querySelector('[id$="pick-banner"]');
    if (bn) { const sync = () => bn.classList.toggle('pjf-banner', !bn.hidden); sync(); new MutationObserver(sync).observe(bn, { attributes: true, attributeFilter: ['hidden'] }); }
    return picker;
  }

  // ── LiDAR ──
  function datasets() {
    try { if (w._surfRoute && w._surfRoute.datasets) return w._surfRoute.datasets(); } catch (_) {}
    try { if (w._vegPanel && w._vegPanel.datasets) return w._vegPanel.datasets(); } catch (_) {}
    return [];
  }
  function lidar() {
    const ds = datasets();
    if (S.lidar == null) S.lidar = ds.length ? [ds[0].url] : [];
    S.lidar = S.lidar.filter(u => ds.some(d => d.url === u) || (curArea() && (curArea().lidar || []).includes(u)));
    return S.lidar.slice();
  }
  function setLidar(urls) { S.lidar = (urls || []).slice(); paint(); scheduleCheck(); fire('lidar'); }

  // ── Check ──
  function scheduleCheck() { clearTimeout(checkT); checkT = setTimeout(check, 250); }
  async function check() {
    if (!S.cur || !S.cur.ring || !S.avail) return null;
    const seq = ++checkSeq;
    let j;
    try { j = await post('/api/areas/check', { ring: S.cur.ring, lidar: lidar(), tools: TOOLS.map(t => t.id), options: optionsOf(S.fix), id: S.cur.id }); }
    catch (e) { j = { ok: false, error: e.message || String(e) }; }
    if (seq !== checkSeq) return S.check;
    S.check = j && j.ok ? j : null; S.checkErr = j && j.ok ? '' : ((j && j.error) || 'The check did not answer.');
    paint();
    return S.check;
  }

  // ── Run ──
  async function run(tools, options) {
    if (S.running) return { ok: false, error: 'busy' };
    if (!S.cur || !S.cur.ring) return { ok: false, error: 'no area' };
    const rows = toolRows(S.check, { ticks: S.ticks, fix: S.fix, area: curArea() });
    tools = tools || plan(rows, S.check, curArea()).tools;
    if (!tools.length) return { ok: false, error: 'nothing ticked' };
    const name = S.cur.id ? S.cur.name : ((S.draftName || '').trim() || S.cur.name || 'New area');
    const body = Object.assign(S.cur.id ? { id: S.cur.id } : { name, ring: S.cur.ring }, { project: PJ().pid || '', lidar: lidar(), tools, options: options || optionsOf(S.fix) });
    if (tools.includes('prospect') && w._areaProspects) { body.options.prospect = Object.assign({ known: await w._areaProspects.known() }, body.options.prospect || {}); }
    if (tools.includes('bush')) body.options.bush = Object.assign(bushParams(), body.options.bush || {});
    let j;
    try { j = await post('/api/areas/run', body); } catch (e) { j = { ok: false, error: e.message || String(e) }; }
    if (!j || !j.ok) { toast('Could not start: ' + ((j && j.error) || 'no answer')); return j || { ok: false }; }
    S.running = { runId: j.runId, areaId: j.areaId, name, pct: 0, step: '', notes: [], seen: 0 };
    try { if (w._jobs) w._jobs.add({ id: 'area.' + j.runId, kind: 'area', name: 'Analyze: ' + name, server: true }); } catch (_) {}
    paint(); fire('run');
    return new Promise(resolve => {
      const tick = async () => {
        let st;
        try { st = await (await fetch('/api/areas/status/' + encodeURIComponent(j.runId))).json(); } catch (_) { setTimeout(tick, 1500); return; }
        const R = S.running; if (!R) return resolve({ ok: false });
        R.pct = +st.progress || R.pct; R.step = st.step || R.step; R.message = st.message || '';
        (st.notes || []).slice(R.seen).forEach(n => toast(n)); R.seen = Math.max(R.seen, (st.notes || []).length); R.notes = st.notes || [];
        if (st.status === 'running' || !st.status) { paintRun(); setTimeout(tick, 700); return; }
        S.running = null;
        const aid = st.areaId || j.areaId;
        if (st.status === 'done') {
          const isNew = !(S.cur && S.cur.id);
          await refresh();
          const a = areaById(aid);
          if (a) {
            S.cur = curOf(a); S.ticks = {}; S.fix = {}; S.open = a.id;
            const made = tools.map(t => RNAME[t]);
            S.lastRun = { text: (made.join(', ') + ' made for ' + a.name + '.') + (R.notes.length ? ' ' + R.notes.join(' ') : '') };
            toast((isNew ? 'Saved "' + a.name + '" as a processed area' : 'Updated processed area "' + a.name + '"') + ': ' + made.join(', '));
            dispatch({ type: 'show', id: a.id, on: true, has: Object.keys(a.results || {}) });
            tools.forEach(t => { if (SHOWABLE.includes(t)) dispatch({ type: 'showResult', id: a.id, result: t, on: true }); });
          }
          scheduleCheck();
        } else toast('The run stopped: ' + (st.error || st.message || 'see the Jobs panel'));
        paint();
        resolve({ ok: st.status === 'done', areaId: aid, notes: R.notes, error: st.error || null });
      };
      tick();
    });
  }
  /** The bushwhack band / void settings from the lidar-derive section (still there under the list). */
  function bushParams() {
    const n = id => { const e = $(id); return e && e.value !== '' ? +e.value : undefined; };
    const o = { veg_band: [n('lidar_veg_lo'), n('lidar_veg_hi')], void_depth: n('lidar_void_depth'), void_min_points: n('lidar_void_min'), low_cut: n('lidar_low_cut') };
    if (o.veg_band[0] == null) delete o.veg_band;
    Object.keys(o).forEach(k => o[k] === undefined && delete o[k]);
    return o;
  }

  // ── What is shown: one state ──
  function dispatch(a) {
    SHOW = reduce(SHOW, a); lset(SKEY, JSON.stringify(SHOW));
    apply(); paint(); fire('shown');
  }
  function show(id, on) { const a = areaById(id); dispatch({ type: 'show', id, on: on !== false, has: a ? Object.keys(a.results || {}) : null }); }
  function showResult(id, result, on) { dispatch({ type: 'showResult', id, result, on: on !== false }); }

  // Drawing what the state says (only what changed).
  const drawn = { veg: null, terrain: {} };
  const fileBase = (id, r) => '/api/areas/file/' + encodeURIComponent(id) + '/' + r + '/';
  async function apply() {
    if (!S.avail) return;
    const want = drawnOf(SHOW, S.areas), on = (id, r) => want.some(x => x.id === id && x.result === r);
    // vegetation: one set at a time (veg-draw.js draws one)
    const vegWant = want.find(x => x.result === 'veg');
    const D = w._vegDraw;
    if (vegWant && drawn.veg !== vegWant.id && D && D.load) {
      drawn.veg = vegWant.id; const base = fileBase(vegWant.id, 'veg');
      try { const L = await D.load(base); if (L && L.ok === false) toast('The vegetation could not be drawn: ' + (L.error || '')); } catch (e) { console.warn('[areas] veg', e); }
      try { if (w._vegPanel && w._vegPanel.adopt) { let veg = {}; try { veg = await (await fetch(base + 'veg.json')).json(); } catch (_) {} w._vegPanel.adopt({ id: 'area:' + vegWant.id, base, veg, sizes: {} }); } } catch (_) {}
    } else if (!vegWant && drawn.veg && D) {
      drawn.veg = null; try { if (D.clear) D.clear(); } catch (_) {}
      try { if (w._vegPanel && w._vegPanel.adopt) w._vegPanel.adopt(null); } catch (_) {}
    }
    const v = V();
    // bushwhack and ground: map layers in 🗺 Layers (area-maps.js lists them while the area is on)
    // terrain: the Terrain panel's layers (custom-layers.js views), ids recorded by the server in results.terrain
    for (const a of S.areas) {
      const t = a.results && a.results.terrain; if (!t || !CL() || !CL().api) continue;
      const ids = terrainIds(t), want1 = on(a.id, 'terrain');
      if (!ids.length || drawn.terrain[a.id] === want1) continue;
      if (drawn.terrain[a.id] === undefined && !want1) { drawn.terrain[a.id] = false; continue; }
      if (want1 && !(await ensureTerrain(a, t))) { drawn.terrain[a.id] = undefined; dispatch({ type: 'showResult', id: a.id, result: 'terrain', on: false }); continue; }
      drawn.terrain[a.id] = want1;
      try { ids.forEach(id => CL().api.setView(id, { show: want1 })); await CL().sync(); if (w._terrainPanel && w._terrainPanel.render) w._terrainPanel.render(true); } catch (e) { console.warn('[areas] terrain', e); }
    }
    try { if (w._areaProspects) w._areaProspects.sync(want, S.areas); } catch (e) { console.warn('[areas] prospect', e); }
    if (v && v.scene && v.scene.requestRender) v.scene.requestRender();
  }
  // The Terrain panel's keep(): the job's patch(es) and hillshade become layer records (project or My data), once.
  async function ensureTerrain(a, t) {
    const J = t.job; if (!J || !J.terrain || !CL() || !CL().api) return true;   // older record: the layers are expected to exist
    const parts = Array.isArray(J.terrains) && J.terrains.length ? J.terrains : [J.terrain];
    const all = await CL().entries(), has = id => all.some(x => x.id === id);
    const tid = 'ter-' + String(J.terrain.blob).slice(0, 12), hid = 'hs-' + String(J.terrain.blob).slice(0, 12);
    if (has(tid) && (!J.tiles || has(hid))) return true;
    const toMine = !a.project || PJ().pid !== a.project;
    if (a.project && PJ().pid !== a.project) { toast('Open the project of this area to show its terrain.'); return false; }
    const rec = (e, v) => CL().api.record(e, Object.assign({ show: false }, v || {}), toMine ? 'mine' : undefined), nm = J.name || a.name;
    const r4 = b => b.map(n => +(+n).toFixed(8));
    try {
      for (const [k, P] of parts.entries()) if (!has('ter-' + P.blob.slice(0, 12))) await rec({ layer: 'ter-' + P.blob.slice(0, 12), kind: 'terrain', blob: P.blob, bounds: r4(P.bounds), name: parts.length > 1 ? nm + ' (part ' + (k + 1) + ')' : nm });
      if (J.tiles && !has(hid)) await rec({ layer: hid, kind: 'tiles', url: J.tiles.url, bounds: r4(J.tiles.bounds), minZoom: J.tiles.minzoom, maxZoom: J.tiles.maxzoom, name: nm + ' hillshade' }, { alpha: 0.75 });
    } catch (e) { toast('The terrain could not be added: ' + e.message); return false; }
    return true;
  }
  function terrainIds(t) {
    if (Array.isArray(t.layers)) return t.layers.slice();
    const ids = []; if (t.blob) { ids.push('ter-' + String(t.blob).slice(0, 12), 'hs-' + String(t.blob).slice(0, 12)); }
    return ids;
  }
  async function restore() {
    if (S.restored) return; S.restored = true;
    if (S.avail == null) await refresh();
    // forget switches of areas that are gone
    let gone = false; Object.keys(SHOW.areas).forEach(id => { if (!areaById(id) && S.avail) { delete SHOW.areas[id]; gone = true; } });
    if (gone) lset(SKEY, JSON.stringify(SHOW));
    apply(); paint();
  }

  // ── Delete ──
  async function remove(id) {
    const j = await post('/api/areas/delete', { id });
    if (j && j.ok) { dispatch({ type: 'show', id, on: false }); await apply(); if (w._areaProspects) w._areaProspects.forget(id); SHOW = reduce(SHOW, { type: 'forget', id }); lset(SKEY, JSON.stringify(SHOW)); if (S.cur && S.cur.id === id) setCurrent(null); }
    S.delAsk = null; await refresh(); return j;
  }
  async function removeResult(id, result) {
    if (SHOWABLE.includes(result)) { dispatch({ type: 'showResult', id, result, on: false }); await apply(); }
    const j = await post('/api/areas/delete-result', { id, result });
    SHOW = reduce(SHOW, { type: 'forgetResult', id, result }); lset(SKEY, JSON.stringify(SHOW));
    if (result === 'terrain') delete drawn.terrain[id];
    if (result === 'prospect' && w._areaProspects) w._areaProspects.forget(id);
    S.delRes = null; await refresh(); return j;
  }
  function runMore(id) {
    const a = areaById(id); if (!a) return;
    setCurrent(a); S.ticks = {}; missing(a).forEach(k => { S.ticks[k] = true; });
    paint();
    const top = $('ar-sec-area'); if (top && top.scrollIntoView) top.scrollIntoView({ block: 'start' });
  }

  // ── Painting ──
  const tagOf = a => a.project ? (((PJ().projects || []).find(p => p.id === a.project) || {}).name || 'Project') : 'My data';
  /** An area's bushwhack / ground switch: on when any of its maps is shown in 🗺 Layers. */
  function mapEye(id, r) { return eyeOf(SHOW, id) === 'on' && w._areaMaps ? (w._areaMaps.resultState(id, r) || 'half') : ''; }
  function eyeBtn(state, act, id, res, label, small) {
    return `<button type="button" class="ui-eye${small ? ' ui-eye-sm' : ''}${state ? ' ' + state : ''}" data-act="${act}" data-id="${esc(id)}"${res ? ` data-res="${res}"` : ''} title="${esc(label)}" aria-label="${esc(label)}"></button>`;
  }
  function paintArea() {
    const box = $('ar-list'); if (!box) return;
    box.innerHTML = S.areas.length ? S.areas.map(a => {
      const sel = S.cur && S.cur.id === a.id, proc = a.results && Object.keys(a.results).length;
      return `<button type="button" class="ar-row${sel ? ' sel' : ''}" data-act="pick" data-id="${esc(a.id)}" role="radio" aria-checked="${!!sel}"><span class="ar-radio"></span><span class="ar-grow"><span class="ar-nm">${esc(a.name)}</span>${proc ? ' <span class="ar-tag">processed</span>' : ''}</span><span class="ar-dim">${(+a.km2 || 0).toFixed(1)} km²</span></button>`;
    }).join('') : '<div class="ar-none">No saved areas yet. Choose a new one below.</div>';
    const card = $('ar-card'); if (!card) return;
    if (!S.cur) { card.innerHTML = '<div class="ar-dim">No area chosen. Pick a saved one above, or draw one.</div>'; return; }
    const km2 = w._areaPicker ? w._areaPicker.ringKm2(S.cur.ring) : 0, d = sizeKm(S.cur.ring);
    let h = `<div class="ar-dim">Current area</div><b class="ar-cn">${esc(S.cur.id ? S.cur.name : ((S.draftName || '').trim() || S.cur.name))}</b> <span class="ar-dim">· ${esc(S.cur.src || '')}</span>
      <div class="ar-facts"><span><b>${km2.toFixed(1)}</b> km²</span><span><b>${d[0].toFixed(1)} × ${d[1].toFixed(1)}</b> km (width × height)</span></div>`;
    if (w._weather) h += '<button type="button" class="ar-btn" data-act="wx" data-id="' + esc(S.cur.id || '') + '">Weather</button>';
    if (S.cur.crossing) h += '<div class="ar-bad">Its edges cross: draw it again so they don’t.</div>';
    if (!S.cur.id) h += `<input type="text" id="ar-name" class="ar-in" maxlength="60" placeholder="Name it (optional)" value="${esc(S.draftName || '')}" aria-label="Area name"><div class="ar-dim">Saved automatically as a processed area when a tool finishes.</div>`;
    else h += `<div class="ar-dim">${curArea() && Object.keys(curArea().results || {}).length ? 'Processed area: its results are listed below.' : 'Saved area. Not a map feature, never sent to CalTopo.'}</div>`;
    if (card.dataset.h !== h) { const f = doc.activeElement && doc.activeElement.id === 'ar-name'; card.dataset.h = h; card.innerHTML = h; if (f) { const i = $('ar-name'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }
  function paintLidar() {
    const box = $('ar-lidar'); if (!box) return;
    const ds = datasets(), sel = lidar();
    const html = ds.length ? ds.map(d => `<label class="ar-ck"><input type="checkbox" class="keep-box" data-url="${esc(d.url)}"${sel.includes(d.url) ? ' checked' : ''}><span class="ar-grow" title="${esc(d.url)}">${esc(d.name)}</span></label>`).join('')
      : '<div class="ar-none">Load a point cloud (LiDAR panel) or open a project that has one.</div>';
    if (box.dataset.h !== html) { box.dataset.h = html; box.innerHTML = html; }
    const cov = S.check && S.check.ground && S.check.ground.coverage;
    $('ar-cov').textContent = cov != null && S.cur ? 'Ticked clouds cover ' + Math.round(cov * 100) + ' % of the current area.' : '';
  }
  function paintTools() {
    const box = $('ar-tools'); if (!box) return;
    const area = curArea(), g = groundRow(S.check, area), rows = toolRows(S.check, { ticks: S.ticks, fix: S.fix, area });
    if (!S.cur) { box.innerHTML = '<div class="ar-none">Choose an area first.</div>'; paintRun(); return; }
    let h = `<div class="ar-item ${g.st}" data-tool="ground"><div class="ar-hd"><span class="ar-lock" title="Always first">🔒</span><span class="ar-nm">Ground</span><span class="ar-chip ${g.st}">${g.chip}</span></div><div class="ar-why">${esc(g.why)}</div></div>`;
    rows.forEach(r => {
      h += `<div class="ar-item ${r.st}" data-tool="${r.id}"><div class="ar-hd"><input type="checkbox" class="keep-box" data-act="tick" data-id="${r.id}"${r.ticked ? ' checked' : ''}${r.disabled ? ' disabled' : ''} aria-label="${esc(r.name)}"><span class="ar-ic">${r.icon}</span><span class="ar-nm">${esc(r.name)}</span><span class="ar-chip ${r.st}">${esc(r.chip)}</span></div>`;
      if (r.desc) h += `<div class="ar-why ar-desc">${esc(r.desc)}</div>`;
      if (r.why) h += `<div class="ar-why">${esc(r.why)}</div>`;
      if (r.offers) h += `<div class="ar-offers">${r.offers.map((o, i) => `<button type="button" class="ar-btn" data-act="fix" data-id="${r.id}" data-i="${i}">${esc(o.label || o.key)}</button>`).join('')}</div>`;
      if (r.used) h += `<div class="ar-offers"><button type="button" class="ar-btn" data-act="unfix" data-id="${r.id}">Back to the normal setting</button></div>`;
      h += '</div>';
    });
    if (S.checkErr) h += `<div class="ar-bad">${esc(S.checkErr)}</div>`;
    box.innerHTML = h;
    paintRun();
  }
  function paintRun() {
    const t = $('ar-runtxt'), b = $('ar-run'); if (!t || !b) return;
    const R = S.running, bar = $('ar-runbar');
    if (R) { t.textContent = (R.step ? (RNAME[R.step] || R.step) + ': ' : '') + Math.round(R.pct || 0) + ' %'; b.disabled = true; b.textContent = 'Running…'; bar.style.setProperty('--ar-pct', (R.pct || 0) + '%'); bar.classList.add('running'); return; }
    bar.classList.remove('running');
    const p = plan(toolRows(S.check, { ticks: S.ticks, fix: S.fix, area: curArea() }), S.check, curArea());
    t.textContent = S.cur ? p.text : 'Choose an area.'; b.textContent = 'Run ticked';
    const ca = curArea(), noLidarOk = p.tools.every(t => t === 'prospect') && !!(ca && ca.results && ca.results.ground);   // Prospects reads only the area's ground and points
    b.disabled = !S.cur || !p.tools.length || !!(S.cur && S.cur.crossing) || (!lidar().length && !noLidarOk);
    const lr = $('ar-last'); if (lr) { lr.hidden = !S.lastRun; lr.textContent = S.lastRun ? 'Run finished: ' + S.lastRun.text : ''; }
  }
  function resultRows(a) {
    return RKEYS.filter(k => a.results && a.results[k]).map(k => {
      const r = a.results[k], maps = MAPRES.includes(k) && w._areaMaps && (w._areaMaps.hasMaps(a.id, k) || eyeOf(SHOW, a.id) !== 'on'), showable = SHOWABLE.includes(k) || maps, st = maps ? mapEye(a.id, k) : eyeOf(SHOW, a.id, k);
      const extra = k === 'ground' ? ' · used by the others' + (r.pits ? ' · ' + r.pits + ' possible pits' : '') : '';
      const vegNote = k === 'veg' ? '<div class="ar-dim ar-small">One vegetation set is drawn at a time: showing this one hides another area’s.</div>' : '';
      const notes = (r.notes || []).map(n => `<div class="ar-note">${esc(n)}</div>`).join('');
      const del = S.delRes === a.id + ':' + k
        ? `<button type="button" class="ar-btn ar-danger" data-act="delresyes" data-id="${esc(a.id)}" data-res="${k}">Yes, delete</button><button type="button" class="ar-btn" data-act="delresno">No</button>`
        : `<button type="button" class="ar-x" data-act="delres" data-id="${esc(a.id)}" data-res="${k}" title="Delete this result">✕</button>`;
      const pros = k === 'prospect' ? `<div class="ar-prospect" data-area="${esc(a.id)}"></div>` : '';
      return `<div class="ar-rr" data-res="${k}"><span class="ar-grow">${RNAME[k]}${r.coarse ? ' <span class="ar-coarse" title="Made with a coarser setting">coarse</span>' : ''}<br><span class="ar-dim">${fmtMB(r.bytes)} · ${shortDate(r.date)}${extra}</span>${vegNote}${notes}${pros}</span>${showable ? eyeBtn(st, 'ressw', a.id, k, 'Show ' + RNAME[k] + ' of ' + a.name, true) : '<span class="ar-dim">kept</span>'}${del}</div>`;
    }).join('');
  }
  function paintProcs() {
    const box = $('ar-procs'); if (!box) return;
    const list = S.areas.filter(a => a.results && Object.keys(a.results).length);
    if (!list.length) { box.innerHTML = '<div class="ar-none">Nothing yet. Run a tool and its area is kept here.</div>'; return; }
    const done = () => { try { if (w._areaProspects) w._areaProspects.mount(box); } catch (e) { console.warn('[areas] prospect mount', e); } };
    box.innerHTML = list.map(a => {
      const open = S.open === a.id, ks = RKEYS.filter(k => a.results[k]);
      let h = `<div class="ar-proc" data-id="${esc(a.id)}"><div class="ar-ph">${eyeBtn(eyeOf(SHOW, a.id), 'procsw', a.id, null, 'Show ' + a.name + ' on the map')}
        <button type="button" class="ar-pm" data-act="procopen" data-id="${esc(a.id)}" aria-expanded="${open}"><span class="ar-pt"><span class="ar-nm">${esc(a.name)}</span><span class="ar-tag">${esc(tagOf(a))}</span><span class="ar-chev${open ? ' open' : ''}">›</span></span>
        <span class="ar-dim">${(+a.km2 || 0).toFixed(1)} km² · ${shortDate(a.updated || a.created)}</span>
        <span class="ar-chips">${ks.map(k => `<span class="ar-mini">${RNAME[k]}${k === 'prospect' && a.results[k].counts ? ' ' + ['A', 'B', 'C'].map(c => c + ' ' + (a.results[k].counts[c] || 0)).join(' · ') : ''}${a.results[k].coarse ? ' <i title="coarse">◦</i>' : ''}</span>`).join('')}</span></button></div>`;
      if (open) {
        h += `<div class="ar-pb">${resultRows(a)}<div class="ar-btns"><button type="button" class="ar-btn" data-act="more" data-id="${esc(a.id)}">Run more tools here</button>`
          + (w._weather ? `<button type="button" class="ar-btn" data-act="wx" data-id="${esc(a.id)}">Weather</button>` : '')
          + (S.delAsk === a.id ? `<span class="ar-dim">Delete all results?</span><button type="button" class="ar-btn ar-danger" data-act="delyes" data-id="${esc(a.id)}">Yes, delete</button><button type="button" class="ar-btn" data-act="delno">No</button>`
            : `<button type="button" class="ar-btn" data-act="del" data-id="${esc(a.id)}">Delete</button>`) + '</div></div>';
      }
      return h + '</div>';
    }).join('');
    done();
  }
  /** Layers / Terrain groups: rows of loaded (switched on) areas, the same switches. */
  function paintGroups() {
    const row = (a, k, label) => `<div class="ar-grow-row" data-id="${esc(a.id)}" data-res="${k}">${eyeBtn(eyeOf(SHOW, a.id, k), 'ressw', a.id, k, 'Show ' + label + ' of ' + a.name, true)}<span class="ar-grow"><span class="ar-nm">${esc(label)}</span><br><span class="ar-dim">${esc(a.name)} · ${fmtMB(a.results[k].bytes)} · ${shortDate(a.results[k].date)}</span></span></div>`;
    const loaded = S.areas.filter(a => eyeOf(SHOW, a.id) === 'on');
    const T = $('areas-terrain-host');
    if (T) {
      const rows = loaded.filter(a => a.results.terrain).map(a => row(a, 'terrain', 'Terrain + hillshade'));
      T.hidden = !S.avail;
      T.innerHTML = `<div class="lp-section"><div class="lp-section-header"><span class="lp-section-arrow">▾</span> Terrain of loaded areas</div><div class="lp-section-body open ar-box">${rows.join('') || '<div class="ar-none">No loaded area has terrain yet. In 🔬 Analyze, switch a processed area on, or run Terrain + hillshade.</div>'}</div></div>`;
    }
  }
  function paint() {
    if (!host || !S.avail) { paintGroups(); return; }
    paintArea(); paintLidar(); paintTools(); paintProcs(); paintGroups();
  }

  // ── Building ──
  function mk() {
    host = $('areas-host'); if (!host) return;
    host.hidden = true;
    host.innerHTML = `<div class="ar-box">
      <h3 class="ar-h" id="ar-sec-area">1 · Area <small>saved areas, or choose a new one</small></h3>
      <div class="ar-list" id="ar-list" role="radiogroup" aria-label="Saved areas"></div>
      <div id="ar-picker" class="ar-picker"></div>
      <div class="ar-card" id="ar-card"></div>
      <h3 class="ar-h">2 · LiDAR <small>loaded now + project clouds</small></h3>
      <div class="ar-list" id="ar-lidar"></div><div class="ar-dim" id="ar-cov"></div>
      <h3 class="ar-h">3 · Tools to run in this area <small>tick, then run once</small></h3>
      <div class="ar-list" id="ar-tools"></div>
      <div class="ar-runbar" id="ar-runbar"><span class="ar-dim" id="ar-runtxt"></span><button type="button" class="ar-btn ar-go" id="ar-run">Run ticked</button></div>
      <div class="ar-last" id="ar-last" hidden></div>
      <h3 class="ar-h">Processed areas <small>kept after a run, with or without a project</small></h3>
      <div class="ar-list" id="ar-procs"></div>
      <div class="ar-runbar"><span class="ar-dim" id="ar-imptxt"></span><button type="button" class="ar-btn" data-act="import" id="ar-import" title="An area package (FLEX-area-….zip) made on another FLEX: its ground, vegetation, bushwhack and prospects">Import a processed area…</button></div></div>`;
    host.addEventListener('click', onClick);
    host.addEventListener('change', e => {
      const t = e.target;
      if (t.closest('#ar-lidar')) setLidar([...host.querySelectorAll('#ar-lidar input:checked')].map(x => x.dataset.url));
      else if (t.dataset.act === 'tick') { S.ticks[t.dataset.id] = t.checked; paintRun(); }
    });
    host.addEventListener('input', e => { if (e.target.id === 'ar-name') { S.draftName = e.target.value; paintRun(); } });
    ['areas-terrain-host'].forEach(id => { const e = $(id); if (e) e.addEventListener('click', onClick); });
  }
  async function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'pick') { const a = areaById(id); if (a) { setCurrent(a); try { const v = V(), bb = w._areaPicker.bboxOf(a.ring); v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(bb[0], bb[1], bb[2], bb[3]), duration: 1.2 }); } catch (_) {} } }
    else if (act === 'fix') { const c = S.check && S.check.tools && S.check.tools[id], o = c && c.offers && c.offers[+b.dataset.i]; if (o) { S.fix[id] = o; S.ticks[id] = true; paint(); await check(); } }
    else if (act === 'unfix') { delete S.fix[id]; paint(); await check(); }
    else if (act === 'procsw') show(id, eyeOf(SHOW, id) !== 'on');
    else if (act === 'ressw' && MAPRES.includes(b.dataset.res) && w._areaMaps) {      // bushwhack / ground: their map layers in 🗺 Layers (area-maps.js)
      const r = b.dataset.res, on = mapEye(id, r) !== 'on';
      if (on && eyeOf(SHOW, id) !== 'on') { show(id, true); await w._areaMaps.refresh(); }
      await w._areaMaps.setResult(id, r, on);
    }
    else if (act === 'ressw') { const r = b.dataset.res; showResult(id, r, eyeOf(SHOW, id, r) !== 'on'); }
    else if (act === 'procopen') { S.open = S.open === id ? null : id; paintProcs(); }
    else if (act === 'more') runMore(id);
    else if (act === 'wx') { const a = (id && areaById(id)) || S.cur; if (a && w._weather) w._weather.open({ name: a.name, ring: a.ring }); }
    else if (act === 'del') { S.delAsk = id; paintProcs(); }
    else if (act === 'delno') { S.delAsk = null; paintProcs(); }
    else if (act === 'delyes') remove(id);
    else if (act === 'delres') { S.delRes = id + ':' + b.dataset.res; paintProcs(); }
    else if (act === 'delresno') { S.delRes = null; paintProcs(); }
    else if (act === 'delresyes') removeResult(id, b.dataset.res);
    else if (act === 'import') importArea();
  }
  /** An area package (tools/area_pack.js) from another FLEX → POST /api/areas/import; an id already here asks before replacing. */
  function importArea() {
    const inp = doc.createElement('input'); inp.type = 'file'; inp.accept = '.zip,application/zip';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      const say = t => { const e = $('ar-imptxt'); if (e) e.textContent = t; };
      const send = over => fetch('/api/areas/import' + (over ? '?overwrite=1' : ''), { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: f }).then(r => r.json().then(j => ({ st: r.status, j })));
      say('Importing ' + f.name + '…');
      try {
        let r = await send(false);
        if (r.st === 409 && w.confirm('This area is already here. Replace it with the one in ' + f.name + '? (The old one is kept in its folder, renamed.)')) r = await send(true);
        if (!r.j.ok) { say(''); toast('Not imported: ' + (r.j.error || 'error')); return; }
        say(''); toast('Imported “' + r.j.area.name + '” (' + r.j.written.length + ' files). Switch it on in Processed areas.');
        await refresh();
      } catch (err) { say(''); toast('Not imported: ' + (err.message || err)); }
    };
    inp.click();
  }
  doc.addEventListener('click', e => { if (e.target && e.target.id === 'ar-run') run(); });

  const css = doc.createElement('style');
  css.textContent = `
  #lidarDeriveCollapsible.areas-on .areas-old { display: none !important; }
  #areas-host[hidden], #areas-terrain-host[hidden] { display: none; }
  .ar-box { color: #e8ece9; font-size: 12px; padding: 2px 2px 6px; }
  .ar-h { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: rgba(255,255,255,.72); margin: 12px 0 5px; }
  .ar-h small { text-transform: none; letter-spacing: 0; font-weight: 400; color: rgba(255,255,255,.5); margin-left: 4px; }
  .ar-list { border: 1px solid rgba(255,255,255,.12); border-radius: 6px; overflow: hidden; }
  .ar-row, .ar-ck { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: 0; border-top: 1px solid rgba(255,255,255,.12); color: inherit; padding: 6px 9px; text-align: left; cursor: pointer; font: inherit; }
  .ar-list > :first-child { border-top: 0; }
  .ar-row.sel { background: rgba(255,154,98,.12); }
  .ar-radio { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,.5); flex: none; }
  .ar-row.sel .ar-radio { border-color: #ff9a62; box-shadow: inset 0 0 0 3px #1b1d22, inset 0 0 0 6px #ff9a62; }
  .ar-grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .ar-nm { font-weight: 600; }
  .ar-dim { color: rgba(255,255,255,.58); font-size: 11px; } .ar-small { font-size: 10.5px; }
  .ar-none { color: rgba(255,255,255,.45); font-size: 11px; padding: 6px 9px; }
  .ar-tag { font-size: 10px; color: rgba(255,255,255,.6); border: 1px solid rgba(255,255,255,.15); border-radius: 9px; padding: 0 6px; white-space: nowrap; }
  .ar-picker { margin-top: 7px; }
  .ar-card { border: 1px solid rgba(255,255,255,.12); border-radius: 6px; padding: 8px 9px; background: rgba(255,255,255,.04); margin-top: 7px; }
  .ar-cn { font-size: 13.5px; } .ar-facts { display: flex; flex-wrap: wrap; gap: 3px 14px; margin: 3px 0; } .ar-facts b { font-size: 14px; font-variant-numeric: tabular-nums; }
  .ar-in { width: 100%; background: #1a1a2e; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; font-size: 11.5px; margin: 5px 0 3px; box-sizing: border-box; }
  .ar-item { border-top: 1px solid rgba(255,255,255,.12); padding: 7px 9px; display: flex; flex-direction: column; gap: 4px; }
  .ar-hd { display: flex; align-items: center; gap: 7px; } .ar-hd .ar-nm { flex: 1; min-width: 0; }
  .ar-lock { width: 13px; font-size: 9px; text-align: center; opacity: .7; } .ar-ic { width: 14px; text-align: center; opacity: .8; }
  .ar-why { color: rgba(255,255,255,.58); font-size: 11px; padding-left: 21px; }
  .ar-item.bad .ar-why { color: #ef7b6e; } .ar-item.warn .ar-why { color: #f2c24e; }
  .ar-chip { font-size: 10px; font-weight: 650; border-radius: 10px; padding: 1px 7px; white-space: nowrap; }
  .ar-chip.ok { background: rgba(63,174,110,.2); color: #6fd49b; } .ar-chip.warn { background: rgba(242,194,78,.2); color: #f2c24e; }
  .ar-chip.bad { background: rgba(239,123,110,.2); color: #ef7b6e; } .ar-chip.wait { background: rgba(255,255,255,.08); color: rgba(255,255,255,.6); }
  .ar-offers, .ar-btns { display: flex; flex-wrap: wrap; gap: 5px; padding-left: 21px; align-items: center; } .ar-btns { padding: 6px 0 2px; }
  .ar-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.18); color: #e8ece9; border-radius: 5px; padding: 3px 9px; font-size: 11px; cursor: pointer; }
  .ar-offers .ar-btn { border-color: rgba(242,194,78,.5); }
  .ar-btn:disabled { opacity: .45; cursor: default; } .ar-danger { border-color: #ef7b6e; color: #ef7b6e; }
  .ar-go { background: #2f8f57; border-color: #3fae6e; color: #fff; font-weight: 600; padding: 5px 12px; }
  .ar-runbar { position: sticky; bottom: 0; z-index: 2; display: flex; gap: 10px; align-items: center; padding: 9px 2px 6px; margin-top: 6px; background: linear-gradient(transparent, rgba(20,22,26,.97) 22%); }
  .ar-runbar .ar-dim { flex: 1; }
  .ar-runbar.running { background: linear-gradient(90deg, rgba(63,174,110,.25) var(--ar-pct, 0%), rgba(20,22,26,.97) var(--ar-pct, 0%)); border-radius: 5px; }
  .ar-last { border-left: 3px solid #3fae6e; padding: 3px 8px; font-size: 11px; color: rgba(255,255,255,.75); margin-top: 6px; }
  .ar-bad { color: #ef7b6e; font-size: 11px; padding: 4px 9px; }
  .ar-proc { border-top: 1px solid rgba(255,255,255,.12); } .ar-proc:first-child { border-top: 0; }
  .ar-ph { display: flex; gap: 8px; align-items: flex-start; padding: 7px 9px; } .ar-ph .ui-eye { margin-top: 2px; }
  .ar-pm { flex: 1; min-width: 0; background: none; border: 0; color: inherit; text-align: left; padding: 0; cursor: pointer; font: inherit; display: flex; flex-direction: column; gap: 3px; }
  .ar-pt { display: flex; gap: 6px; align-items: center; } .ar-pt .ar-nm { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .ar-chev { display: inline-block; transition: transform .15s; color: rgba(255,255,255,.6); } .ar-chev.open { transform: rotate(90deg); }
  .ar-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .ar-mini { background: rgba(255,255,255,.09); border-radius: 9px; padding: 0 7px; font-size: 10px; } .ar-mini i { font-style: normal; color: #f2c24e; }
  .ar-pb { padding: 0 9px 7px 41px; }
  .ar-rr, .ar-grow-row { display: flex; gap: 8px; align-items: center; padding: 5px 0; border-top: 1px solid rgba(255,255,255,.07); }
  .ar-grow-row { padding: 5px 4px; }
  .ar-desc { padding-left: 21px; }
  .ar-note { color: #f2c24e; font-size: 10.5px; }
  .ar-coarse { font-size: 9.5px; color: #f2c24e; border: 1px solid rgba(242,194,78,.5); border-radius: 8px; padding: 0 5px; }
  .ar-x { background: none; border: 0; color: rgba(255,255,255,.45); cursor: pointer; font-size: 11px; padding: 0 2px; } .ar-x:hover { color: #ef7b6e; }`;
  doc.head.appendChild(css);

  w._areas = { available: () => !!S.avail, list: () => S.areas.slice(), refresh, current, setCurrent, lidar, setLidar, check, run, show, showResult,
    shown: () => JSON.parse(JSON.stringify(SHOW)), eyeOf: (id, r) => eyeOf(SHOW, id, r), remove, removeResult, runMore, restore, pure,
    state: () => S };

  const start = () => {
    mk();
    const watch = (id, fn) => { const p = $(id); if (p) new MutationObserver(() => { if (p.classList.contains('show')) fn(); }).observe(p, { attributes: true, attributeFilter: ['class'] }); };
    const opened = async () => { await restore(); if (S.avail) { ensurePicker(); hideOld(); await refresh(); if (picker) picker.refresh(); paint(); if (S.cur && !S.check) scheduleCheck(); } };
    watch('lidarDeriveCollapsible', opened);
    watch('mapLayersCollapsible', () => restore());
    watch('terrainCollapsible', () => restore());
    ['flex-layer-view', 'flex-area-maps'].forEach(ev => w.addEventListener(ev, () => { if (S.avail) paint(); }));
    w.addEventListener('flex-project-changed', () => { if (S.avail != null) { refresh().then(apply); if (picker) picker.refresh(); } });
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : null);
