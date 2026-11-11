// veg-panel.js — 🔬 Analyze → "Vegetation shapes": light 3D shapes of the trees and brush, made from the LiDAR of an area and
// drawn on the globe (green, mostly see-through). A FIRST VERSION that builds TWO looks so they can be compared for weight and
// for how they read: "Tree shapes" (one simple crown per tree, mounds for brush) and "Canopy cloud" (a blobby skin round the
// vegetation points).
//
//   The job     veg_shapes.py on the server (veg_api.js, /api/veg/*): POST /api/veg/build → a job in the Jobs panel → result.
//   The panel   Area (the area picker Generate terrain uses), LiDAR (Surface route's list, window._surfRoute.datasets(); a small
//               copy when that is missing), Detail, Build. After a build: the counts and file sizes of both looks, the look
//               (Tree shapes / Canopy cloud / Both / Off), sliders (Transparency, Edges, Fill, Hide lower than), switches
//               (Trees, Brush, Follow the terrain shown, Colour by height), Keep (a name) and the Saved list (Show / Delete).
//   The drawing is window._vegDraw (veg-draw.js) and is used only through load(baseUrl) and set({...}); without it the
//   controls are disabled with a short note.
//
// window._vegPanel = { refresh, build, show(id), state, datasets, keep(name), saved(), remove(id), settings(), pure }
// Node (tools/test_veg_panel.js): module.exports = pure helpers.
(function (root) {
  'use strict';

  // ── Pure helpers ──────────────────────────────────────────────────────────
  /** 12340 → "12 340". */
  const fmtN = n => String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  /** Bytes → "0.5 MB" / "12 KB". */
  function fmtBytes(b) {
    b = +b || 0;
    if (b >= 1e5) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return Math.round(b / 1e3) + ' KB';
    return b + ' B';
  }
  const plural = (n, one, many) => fmtN(n) + ' ' + (Math.round(n) === 1 ? one : many);
  /** The two lines under a build: "12 340 trees, 5 120 brush patches, 0.5 MB" and "cloud 210 000 triangles, 3.1 MB" (what was built). */
  function countLines(veg, sizes) {
    veg = veg || {}; sizes = sizes || {};
    const out = [];
    if (veg.shapes) out.push(`Tree shapes: ${plural(veg.shapes.trees || 0, 'tree', 'trees')}, ${plural(veg.shapes.brush || 0, 'brush patch', 'brush patches')}, ${fmtBytes(sizes['shapes.bin'])}`);
    if (veg.shell) out.push(`Canopy cloud: ${plural(veg.shell.triangles || 0, 'triangle', 'triangles')}, ${fmtBytes(sizes['shell.bin'])}`);
    return out;
  }
  /** One line for a Saved row. */
  function savedLine(m) {
    const v = (m && m.veg) || {}, p = [];
    if (v.shapes) p.push(`${fmtN(v.shapes.trees)} trees, ${fmtN(v.shapes.brush)} brush, ${fmtBytes(v.shapes.bytes)}`);
    if (v.shell) p.push(`cloud ${fmtN(v.shell.triangles)} triangles, ${fmtBytes(v.shell.bytes)}`);
    return p.join('; ');
  }
  /** The /api/veg/build params from the panel's state (area: a lon/lat ring). */
  function buildParams(st) {
    const eps = (st.epts || []).filter(Boolean);
    return { source: Object.assign({ ept: eps[0] || '' }, eps.length > 1 ? { ept_also: eps.slice(1) } : {}),
      area: st.area, looks: ['shapes', 'shell'], detail: ['low', 'medium', 'high'].includes(st.detail) ? st.detail : 'medium',
      min_height: 0.5, brush_top: 2.0, max_triangles: 300000 };
  }
  /** The rectangle ring of a [w, s, e, n] box. */
  const boxRing = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
  const pure = { fmtN, fmtBytes, countLines, savedLine, buildParams, boxRing };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document) return;

  // ── The panel ─────────────────────────────────────────────────────────────
  const w = root, doc = root.document;
  const PJ = () => w._pj || {}, V = () => w.cesiumViewer, D = () => w._vegDraw;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const $ = id => doc.getElementById(id);
  const lget = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const SKEY = 'flex.vegpanel';
  const LOOKS = [['shapes', 'Tree shapes'], ['shell', 'Canopy cloud'], ['both', 'Both'], ['off', 'Off']];
  const DETAIL = [['low', 'Rough (quick)'], ['medium', 'Medium'], ['high', 'Fine (slow)']];

  const S = { epts: [], detail: 'medium', running: false, jobId: null, result: null, msg: '', msgBad: false, saved: [], note: '', delArm: null };
  try { const o = JSON.parse(lget(SKEY) || '{}'); if (['low', 'medium', 'high'].includes(o.detail)) S.detail = o.detail; } catch (_) {}
  const save = () => lset(SKEY, JSON.stringify({ detail: S.detail }));
  let picker = null, host = null, poll = null;

  /** The LiDAR there is: Surface route's list when it is there (a call, not a copy), else the clouds the export list holds. */
  function datasets() {
    try { if (w._surfRoute && w._surfRoute.datasets) return w._surfRoute.datasets(); } catch (_) {}
    const out = [], seen = new Set(), sel = $('export_ept_select');
    try { if (w._refreshEptDatasets) w._refreshEptDatasets(); } catch (_) {}
    if (sel) [...sel.options].forEach(o => { if (/^https?:\/\//i.test(o.value) && !seen.has(o.value)) { seen.add(o.value); out.push({ url: o.value, name: o.textContent }); } });
    return out;
  }
  const settings = () => { try { return D() && D().get ? D().get() : {}; } catch (_) { return {}; } };
  const setDraw = o => { try { if (D() && D().set) D().set(o); } catch (e) { console.warn('[veg] set', e); } };
  const redraw = () => { const v = V(); if (v && v.scene && v.scene.requestRender) v.scene.requestRender(); };

  function say(msg, bad) { S.msg = msg || ''; S.msgBad = !!bad; const m = $('vg-msg'); if (m) { m.textContent = S.msg; m.classList.toggle('bad', S.msgBad); } }
  function bar(pct) { const b = $('vg-bar'); if (!b) return; b.hidden = pct == null; if (pct != null) b.firstChild.style.width = Math.max(0, Math.min(100, pct)) + '%'; }

  // ── Area picker ──
  function ensurePicker() {
    if (picker) return picker;
    if (!w._areaPicker || !$('vg-picker')) return null;
    picker = w._areaPicker.create({
      host: $('vg-picker'),
      hasFootprint: () => !!PJ().pid,
      footprint: async () => { const pj = PJ(); if (!pj.pid || !w._pjx || !w._pjx.info) return []; let nm = ''; try { nm = w._customLayers.api.projectName(); } catch (_) {} return (await w._pjx.info({ id: pj.pid, name: nm })).footprint || []; },
      onChange: () => paintRun(),
    });
    return picker;
  }

  // ── LiDAR ──
  function paintDatasets() {
    const box = $('vg-lidar'); if (!box) return;
    const ds = datasets(); box.textContent = '';
    S.epts = S.epts.filter(u => ds.some(d => d.url === u));
    if (!S.epts.length && ds.length) S.epts = [ds[0].url];
    if (!ds.length) box.appendChild(el('div', 'vg-none', 'Load a point cloud (LiDAR panel) or open a project that has one.'));
    ds.forEach(d => {
      const row = el('label', 'vg-ck'), c = el('input'); c.type = 'checkbox'; c.className = 'keep-box'; c.checked = S.epts.includes(d.url); c.dataset.url = d.url;
      c.addEventListener('change', () => { S.epts = [...box.querySelectorAll('input:checked')].map(x => x.dataset.url); paintRun(); });
      const t = el('span', 'vg-ck-t', d.name); t.title = d.url; row.append(c, t); box.appendChild(row);
    });
  }

  // ── Build ──
  function paintRun() {
    const go = $('vg-run'); if (!go) return;
    const a = picker && picker.area();
    go.disabled = S.running || !S.epts.length || !a;
    go.textContent = S.running ? 'Building…' : 'Build';
  }
  async function build() {
    if (S.running) return { ok: false, error: 'busy' };
    const a = picker && picker.area();
    if (!S.epts.length) { say('Tick the LiDAR to use (a point cloud loaded or in the project).', true); return { ok: false, error: 'no lidar' }; }
    if (!a) { say('Choose or draw the area first.', true); return { ok: false, error: 'no area' }; }
    if (a.crossing) { say('The area’s edges cross: draw it again so they don’t.', true); return { ok: false, error: 'crossing' }; }
    if (a.km2 > 25) { say(`The area is ${a.km2.toFixed(1)} km²: choose one of 25 km² or less.`, true); return { ok: false, error: 'too big' }; }
    const params = buildParams({ epts: S.epts, detail: S.detail, area: a.polygon && a.polygon.length >= 3 ? a.polygon : boxRing(a.bbox) });
    S.running = true; paintRun(); say('Starting…'); bar(3);
    let j;
    try {
      const r = await fetch('/api/veg/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: PJ().pid || '', params }) });
      j = await r.json();
      if (!j.ok) throw new Error(j.error || 'could not start');
    } catch (e) { S.running = false; paintRun(); bar(null); say(String(e.message || e), true); return { ok: false, error: String(e.message || e) }; }
    S.jobId = j.jobId;
    if (w._jobs) w._jobs.add({ id: 'veg.' + j.jobId, kind: 'veg', name: 'Vegetation shapes', server: true, retry: () => build() });
    return new Promise(resolve => {
      const tick = async () => {
        let st;
        try { st = await (await fetch('/api/veg/status/' + j.jobId)).json(); } catch (_) { poll = setTimeout(tick, 1500); return; }
        if (st.status === 'running') { say(st.message || 'Working…'); bar(st.progress || 5); poll = setTimeout(tick, 600); return; }
        S.running = false; bar(null);
        if (st.status === 'done') {
          try { await show(j.jobId); } catch (e) { say('The result could not be read: ' + (e.message || e), true); }
        } else say(st.error || 'The vegetation job failed.', true);
        paintRun();
        resolve({ ok: st.status === 'done', jobId: j.jobId, error: st.error || null });
      };
      tick();
    });
  }

  // ── Show a result (a job or a saved set) ──
  async function show(id) {
    const r = await (await fetch('/api/veg/result?id=' + encodeURIComponent(id))).json();
    if (!r.ok) throw new Error(r.error || 'not found');
    S.result = { id, veg: r.veg, sizes: r.sizes || {}, base: r.base, kept: /^v/.test(id) && S.saved.some(s => s.id === id) };
    let note = '';
    if (D() && D().load) {
      let L; try { L = await D().load(r.base); } catch (e) { L = { ok: false, error: e.message || String(e) }; }
      if (!L || L.ok === false) { note = 'The shapes could not be drawn: ' + ((L && L.error) || 'unknown error'); say(note, true); }
      else {
        say('');
        const cur = settings().look, built = (r.veg.shapes ? 1 : 0) + (r.veg.shell ? 2 : 0);
        const okLook = cur === 'both' ? built === 3 : cur === 'shapes' ? !!r.veg.shapes : cur === 'shell' ? !!r.veg.shell : false;
        if (!okLook) setDraw({ look: built === 3 || built === 1 ? 'shapes' : 'shell' });
      }
    }
    paintResult(); redraw();
    return S.result;
  }

  // ── Keep / Saved ──
  async function loadSaved() {
    try { const r = await (await fetch('/api/veg/saved?project=' + encodeURIComponent(PJ().pid || ''))).json(); S.saved = r.ok ? r.saved : []; } catch (_) { S.saved = []; }
    paintSaved(); return S.saved;
  }
  async function keep(name) {
    if (!S.result) return { ok: false, error: 'nothing to keep' };
    const r = await (await fetch('/api/veg/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: S.result.id, name: name || '', project: PJ().pid || '' }) })).json();
    if (!r.ok) { say(r.error || 'could not keep it', true); return r; }
    await loadSaved(); say(`Kept as “${r.name}”.`);
    return r;
  }
  async function remove(id) {
    const r = await (await fetch('/api/veg/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })).json();
    if (S.result && S.result.id === id) { S.result = null; try { if (D() && D().clear) D().clear(); } catch (_) {} paintResult(); redraw(); }
    await loadSaved(); return r;
  }

  // ── Painting ──
  function paintResult() {
    const box = $('vg-result'); if (!box) return;
    const r = S.result;
    box.hidden = !r;
    if (!r) return;
    const lines = countLines(r.veg, r.sizes);
    $('vg-counts').innerHTML = '';
    lines.forEach(l => $('vg-counts').appendChild(el('div', 'vg-count', l)));
    const pv = $('vg-preview');
    if (r.sizes['preview.png']) { pv.src = r.base + 'preview.png'; pv.hidden = false; } else pv.hidden = true;
    paintControls();
  }
  function paintControls() {
    const on = !!(D() && D().set), s = settings(), r = S.result || {}, veg = r.veg || {};
    $('vg-nodraw').hidden = on;
    const ctl = $('vg-controls'); if (!ctl) return;
    ctl.classList.toggle('off', !on);
    ctl.querySelectorAll('input,button').forEach(x => { x.disabled = !on; });
    ctl.querySelectorAll('[data-look]').forEach(b => {
      const k = b.dataset.look; b.classList.toggle('on', (s.look || 'shapes') === k);
      b.disabled = !on || (k === 'shapes' && !veg.shapes) || (k === 'shell' && !veg.shell) || (k === 'both' && !(veg.shapes && veg.shell));
    });
    const val = (id, v, txt) => { const i = $(id); if (i && v != null) { i.value = v; const t = $(id + '-v'); if (t) t.textContent = txt; } };
    val('vg-s-transp', Math.round((1 - (s.opacity != null ? s.opacity : 0.35)) * 100), Math.round((1 - (s.opacity != null ? s.opacity : 0.35)) * 100) + '%');
    val('vg-s-edge', s.edge != null ? s.edge : 0.5, Math.round((s.edge != null ? s.edge : 0.5) * 100) + '%');
    val('vg-s-fill', s.fill != null ? s.fill : 0.5, Math.round((s.fill != null ? s.fill : 0.5) * 100) + '%');
    val('vg-s-minh', s.minHeight != null ? s.minHeight : 0.5, (s.minHeight != null ? s.minHeight : 0.5).toFixed(1) + ' m');
    [['vg-sw-trees', s.trees !== false], ['vg-sw-brush', s.brush !== false], ['vg-sw-terrain', s.onTerrain !== false], ['vg-sw-tint', s.tint !== 'plain']].forEach(([id, v]) => { const i = $(id); if (i) i.checked = v; });
  }
  function paintSaved() {
    const box = $('vg-saved'); if (!box) return;
    box.textContent = '';
    $('vg-saved-h').hidden = !S.saved.length;
    S.saved.forEach(m => {
      const row = el('div', 'vg-sv'); row.dataset.id = m.id;
      const t = el('div', 'vg-sv-t'); t.append(el('b', null, m.name), el('span', 'vg-sv-d', ' ' + String(m.date || '').slice(0, 10)), el('div', 'vg-sv-c', savedLine(m)));
      const sh = el('button', 'vg-btn', 'Show'); sh.type = 'button'; sh.dataset.act = 'show';
      sh.addEventListener('click', () => { show(m.id).catch(e => say(e.message || String(e), true)); });
      const dl = el('button', 'vg-btn', S.delArm === m.id ? 'Really delete?' : 'Delete'); dl.type = 'button'; dl.dataset.act = 'del';
      dl.addEventListener('click', () => {
        if (S.delArm !== m.id) { S.delArm = m.id; paintSaved(); setTimeout(() => { if (S.delArm === m.id) { S.delArm = null; paintSaved(); } }, 3500); return; }
        S.delArm = null; remove(m.id);
      });
      row.append(t, sh, dl); box.appendChild(row);
    });
  }
  function refresh() { paintDatasets(); paintRun(); paintControls(); if (picker) picker.refresh(); loadSaved(); }

  // ── Building the section ──
  function mk() {
    host = $('vegshapes-host'); if (!host) return;
    host.textContent = '';
    const sec = el('div', 'lp-section'), head = el('div', 'lp-section-header'); head.id = 'vg-head';
    head.innerHTML = '<span class="lp-section-arrow" style="transform: rotate(-90deg)">▾</span> Vegetation shapes';
    const b = el('div', 'lp-section-body'); b.id = 'vg-body';
    head.addEventListener('click', () => {
      if (w._lpToggle) w._lpToggle(head);
      if (b.classList.contains('open')) { ensurePicker(); refresh(); if (picker && picker.area()) picker.outline(); } else if (picker) picker.outline(false);
    });
    sec.append(head, b); host.appendChild(sec);
    const h = (t, tip) => { const e = el('div', 'vg-h', t); if (tip) e.title = tip; return e; };
    b.appendChild(el('div', 'vg-note', 'Light green shapes for the trees and brush, made from the LiDAR: much lighter than the points. A first version that builds two looks so you can compare them.'));

    b.appendChild(h('Area'));
    const pk = el('div'); pk.id = 'vg-picker'; b.appendChild(pk);
    b.appendChild(h('LiDAR', 'The point clouds the trees and brush are read from'));
    const lb = el('div'); lb.id = 'vg-lidar'; b.appendChild(lb);
    const dr = el('div', 'vg-row');
    const ds = el('select', 'vg-in'); ds.id = 'vg-detail'; ds.title = 'More detail makes more, smaller shapes and takes longer';
    DETAIL.forEach(([k, t]) => ds.appendChild(new Option(t, k))); ds.value = S.detail;
    ds.addEventListener('change', () => { S.detail = ds.value; save(); });
    dr.append(el('span', 'vg-l', 'Detail'), ds); b.appendChild(dr);
    const go = el('button', 'vg-btn vg-run', 'Build'); go.type = 'button'; go.id = 'vg-run'; go.addEventListener('click', () => { build(); });
    b.appendChild(go);
    const pb = el('div', 'vg-bar'); pb.id = 'vg-bar'; pb.hidden = true; pb.appendChild(el('div')); b.appendChild(pb);
    const msg = el('div', 'vg-msg'); msg.id = 'vg-msg'; b.appendChild(msg);

    // The result
    const res = el('div'); res.id = 'vg-result'; res.hidden = true;
    res.appendChild(h('Built'));
    const cn = el('div'); cn.id = 'vg-counts'; res.appendChild(cn);
    const pv = el('img', 'vg-preview'); pv.id = 'vg-preview'; pv.alt = 'Top-down picture of the vegetation'; pv.hidden = true; res.appendChild(pv);
    const nd = el('div', 'vg-note', 'The drawing part is not loaded, so the controls are off.'); nd.id = 'vg-nodraw'; nd.hidden = true; res.appendChild(nd);
    const ctl = el('div'); ctl.id = 'vg-controls'; res.appendChild(ctl);
    ctl.appendChild(h('Show'));
    const lk = el('div', 'vg-looks');
    LOOKS.forEach(([k, t]) => { const x = el('button', 'vg-pre', t); x.type = 'button'; x.dataset.look = k; x.addEventListener('click', () => { setDraw({ look: k }); paintControls(); redraw(); }); lk.appendChild(x); });
    ctl.appendChild(lk);
    const slider = (id, label, min, max, step, tip, onv) => {
      const r = el('div', 'vg-sl'); r.title = tip;
      const i = el('input'); i.type = 'range'; i.id = id; i.min = min; i.max = max; i.step = step;
      const v = el('span', 'vg-sl-v'); v.id = id + '-v';
      i.addEventListener('input', () => { onv(+i.value); paintControls(); redraw(); });
      r.append(el('span', null, label), i, v); ctl.appendChild(r);
    };
    slider('vg-s-transp', 'Transparency', 0, 95, 5, 'How see-through the shapes are', v => setDraw({ opacity: +(1 - v / 100).toFixed(2) }));
    slider('vg-s-edge', 'Edges', 0, 1, 0.05, 'How strongly the rims of the shapes are lit', v => setDraw({ edge: v }));
    slider('vg-s-fill', 'Fill', 0, 1, 0.05, 'How solid the faces are', v => setDraw({ fill: v }));
    slider('vg-s-minh', 'Hide lower than', 0, 10, 0.1, 'Vegetation lower than this above the ground is hidden (metres)', v => setDraw({ minHeight: v }));
    const sw = (id, label, tip, fn) => ctl.appendChild(w.uiSwitch(true, on => { fn(on); redraw(); }, label, { small: true, id, title: tip }));
    sw('vg-sw-trees', 'Trees', 'Show the trees', on => setDraw({ trees: on }));
    sw('vg-sw-brush', 'Brush', 'Show the low vegetation', on => setDraw({ brush: on }));
    sw('vg-sw-terrain', 'Follow the terrain shown', 'Move the shapes onto the terrain you are looking at (instead of the ground the LiDAR found)', on => setDraw({ onTerrain: on }));
    sw('vg-sw-tint', 'Colour by height', 'Darker green low, lighter high; off = one green', on => setDraw({ tint: on ? 'height' : 'plain' }));
    const fl = el('div', 'vg-row'); const fb = el('button', 'vg-btn', 'Fly there'); fb.type = 'button'; fb.id = 'vg-fly'; fb.addEventListener('click', () => { try { if (D() && D().flyTo) D().flyTo(); } catch (_) {} });
    fl.appendChild(fb); ctl.appendChild(fl);
    res.appendChild(h('Keep this one', 'Keeps these files on this computer so a new build does not replace them'));
    const kr = el('div', 'vg-row'); const kn = el('input', 'vg-in'); kn.id = 'vg-keep-name'; kn.placeholder = 'a name, e.g. Cave Ridge, medium';
    const kb = el('button', 'vg-btn', 'Keep'); kb.type = 'button'; kb.id = 'vg-keep'; kb.addEventListener('click', async () => { const r = await keep(kn.value.trim()); if (r && r.ok) kn.value = ''; });
    kr.append(kn, kb); res.appendChild(kr);
    b.appendChild(res);

    const sh = h('Saved'); sh.id = 'vg-saved-h'; sh.hidden = true; b.appendChild(sh);
    const sv = el('div'); sv.id = 'vg-saved'; b.appendChild(sv);
    paintDatasets(); paintRun(); paintControls();
  }

  const css = doc.createElement('style');
  css.textContent = `
  #vegshapes-host .vg-note { font-size: 10.5px; color: rgba(255,255,255,.55); margin: 2px 0 4px; }
  #vegshapes-host .vg-h { font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: rgba(255,255,255,.5); margin: 9px 0 3px; }
  #vegshapes-host .vg-row { display: flex; gap: 5px; align-items: center; margin: 3px 0; }
  #vegshapes-host .vg-in { background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; padding: 3px 5px; font-size: 11px; min-width: 0; flex: 1; }
  #vegshapes-host .vg-l { font-size: 11px; color: rgba(255,255,255,.7); }
  #vegshapes-host .vg-btn { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; padding: 3px 8px; font-size: 11px; cursor: pointer; white-space: nowrap; }
  #vegshapes-host .vg-btn:hover:not(:disabled) { border-color: #999; } #vegshapes-host .vg-btn:disabled { opacity: .45; cursor: default; }
  #vegshapes-host .vg-run { width: 100%; margin-top: 8px; }
  #vegshapes-host .vg-ck { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 1px 0; } #vegshapes-host .vg-ck-t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #vegshapes-host .vg-none { font-size: 10.5px; color: rgba(255,255,255,.35); }
  #vegshapes-host .vg-bar { height: 4px; background: rgba(255,255,255,.12); border-radius: 2px; margin: 5px 0 0; overflow: hidden; } #vegshapes-host .vg-bar > div { height: 100%; width: 0; background: #7bd88f; transition: width .3s; }
  #vegshapes-host .vg-msg { font-size: 11px; color: rgba(255,255,255,.65); margin: 5px 0; min-height: 4px; } #vegshapes-host .vg-msg.bad { color: #ff9a8a; }
  #vegshapes-host .vg-count { font-size: 11px; color: #e8e8ee; margin: 1px 0; }
  #vegshapes-host .vg-preview { width: 100%; max-height: 160px; object-fit: contain; margin: 5px 0; border-radius: 3px; background: rgba(255,255,255,.05); }
  #vegshapes-host .vg-looks { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; }
  #vegshapes-host .vg-pre { background: none; color: #ddd; border: 1px solid #555; border-radius: 10px; padding: 1px 9px; font-size: 11px; cursor: pointer; }
  #vegshapes-host .vg-pre.on { border-color: #7bd88f; color: #7bd88f; } #vegshapes-host .vg-pre:disabled { opacity: .35; cursor: default; }
  #vegshapes-host .vg-sl { display: grid; grid-template-columns: 98px 1fr 46px; gap: 6px; align-items: center; font-size: 11px; margin-top: 3px; }
  #vegshapes-host .vg-sl input { width: 100%; margin: 0; } #vegshapes-host .vg-sl-v { text-align: right; color: rgba(255,255,255,.7); font-size: 10.5px; }
  #vegshapes-host #vg-controls.off { opacity: .5; }
  #vegshapes-host .vg-sv { display: flex; gap: 5px; align-items: center; border: 1px solid rgba(255,255,255,.15); border-radius: 4px; padding: 4px 6px; margin: 4px 0; font-size: 11px; }
  #vegshapes-host .vg-sv-t { flex: 1; min-width: 0; } #vegshapes-host .vg-sv-d { color: rgba(255,255,255,.45); font-size: 10px; } #vegshapes-host .vg-sv-c { color: rgba(255,255,255,.6); font-size: 10.5px; }`;
  doc.head.appendChild(css);

  w._vegPanel = { refresh, build, show, state: () => S, datasets, keep, saved: () => S.saved.slice(), remove, settings, pure };
  w.addEventListener('flex-veg-changed', () => { paintControls(); });
  const start = () => {
    mk();
    const pane = $('lidarDeriveCollapsible');
    if (pane) new MutationObserver(() => { if (pane.classList.contains('show')) { paintDatasets(); paintRun(); paintControls(); } }).observe(pane, { attributes: true, attributeFilter: ['class'] });
    w.addEventListener('flex-project-changed', () => { if (picker) picker.refresh(); paintDatasets(); loadSaved(); });
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : this);
