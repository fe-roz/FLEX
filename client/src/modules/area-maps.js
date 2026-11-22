// area-maps.js — a processed area's maps as normal layers in 🗺 Layers (with the user's own map layers), coloured in
// the browser's choice: Brush density, Slope, LiDAR hillshade, Below ground (voids) (beta).
//
// The maps are the area's saved value rasters (area_maps.py), drawn as tiles by the server (area_tiles.js:
// GET /api/areas/maps/<id>, /api/areas/tiles/<id>/<map>/{z}/{x}/{y}.png?ramp=&lo=&hi=). Only colours change here.
//
// Where they live: NOWHERE in the project or My data. They are listed while their area is switched on in
// 🔬 Analyze → Processed areas (analyze-area.js) and exist only on this computer (the area does); custom-layers.js
// takes them from list() as owner 'a', so they get the same row (switch, transparency, order). Shown / transparency
// / order are kept like every map layer's (custom-layers flex.cl.view); the colours per layer in localStorage
// `flex.am.colours` { <layer id>: { preset, lo, hi } }.
// The Analyze result switches (Bushwhack: brush + voids; Ground: slope + hillshade) are the same state: on = any of
// its maps shown.
// An area made before the value rasters: its bushwhack pngs as plain image layers (no Colours).
//
// window._areaMaps = { list, refresh, presets, colours, setColours, urlOf, dialog, resultState, setResult, pure }
(function (root) {
  'use strict';
  const MAPS = [
    { id: 'brush', result: 'bush', name: 'Brush density', show: true, alpha: 1, scale: 100, unit: '%', step: 1 },
    { id: 'slope', result: 'ground', name: 'Slope', show: false, alpha: 0.8, scale: 1, unit: '°', step: 1 },
    { id: 'hillshade', result: 'ground', name: 'LiDAR hillshade', show: false, alpha: 0.7, scale: 1, unit: '', step: 0.01 },
    { id: 'voids', result: 'bush', name: 'Below ground (voids) (beta)', show: false, alpha: 1, scale: 1, unit: 'm', step: 0.1 },
  ];
  // Presets: stops [pos, 'RRGGBB', alpha 0..1]; the first is each map's default.
  const PRESETS = {
    brush: [
      { id: 'green', name: 'Clear to dark green', stops: [[0, '0b3d0b', 0], [1, '0b3d0b', 1]] },
      { id: 'yr', name: 'Yellow to red', stops: [[0, 'ffe45c', 0], [0.15, 'ffd23f', 0.55], [0.6, 'f07c22', 0.85], [1, 'b3170f', 1]] },
      { id: 'viridis', name: 'Viridis', stops: [[0, '440154', 0], [0.1, '440154', 0.7], [0.4, '31688e', 0.85], [0.7, '35b779', 0.95], [1, 'fde725', 1]] },
      { id: 'greys', name: 'Greys', stops: [[0, 'ffffff', 0], [1, '111111', 1]] },
    ],
    slope: [
      { id: 'gyr', name: 'Green, yellow, red; cliffs purple', stops: [[0, '2e9b4a', 0.15], [0.3, 'f2e14c', 0.6], [0.6, 'e0402a', 0.85], [0.64, '8a2be2', 1], [1, '5a0f8a', 1]] },
      { id: 'greys', name: 'Greys', stops: [[0, 'ffffff', 0], [1, '000000', 1]] },
    ],
    hillshade: [
      { id: 'grey', name: 'Classic grey', stops: [[0, '000000', 1], [1, 'ffffff', 1]] },
      { id: 'warm', name: 'Warm', stops: [[0, '2b1a0e', 1], [0.6, 'b88a5a', 1], [1, 'fff1d6', 1]] },
      { id: 'contrast', name: 'High contrast', stops: [[0, '000000', 1], [0.45, '3a3a3a', 1], [0.7, 'c8c8c8', 1], [1, 'ffffff', 1]] },
    ],
    voids: [
      { id: 'blues', name: 'Blues', stops: [[0, '9ecae1', 0.6], [0.5, '3182bd', 0.9], [1, '08306b', 1]] },
      { id: 'magenta', name: 'Magenta', stops: [[0, 'f7a1d8', 0.6], [1, '7a0177', 1]] },
    ],
  };
  // Slope's default range 0-70 deg puts 45 deg at 0.64 of the ramp: the purple cliffs start there.
  const DEF_RANGE = { slope: [0, 70] };

  // ── Pure ──
  const hx2 = a => Math.max(0, Math.min(255, Math.round(a * 255))).toString(16).padStart(2, '0');
  /** Preset stops → the server's ramp string "<pos>:<RRGGBBAA>_…". */
  function rampOf(stops) { return stops.map(s => String(+(+s[0]).toFixed(3)) + ':' + s[1] + hx2(s[2])).join('_'); }
  function presetOf(map, id) { const P = PRESETS[map] || []; return P.find(p => p.id === id) || P[0]; }
  /** The default colours of a map (from its info: suggest). */
  function defaults(map, info) {
    const r = DEF_RANGE[map] || (info && Array.isArray(info.suggest) ? info.suggest : [0, 1]);
    return { preset: (PRESETS[map] || [{}])[0].id, lo: +r[0], hi: +r[1] };
  }
  /** Tile URL template for an area's map with colours c. */
  function urlOf(areaId, map, c) {
    const p = presetOf(map, c.preset);
    const num = v => String(+(+v).toFixed(4));
    return '/api/areas/tiles/' + encodeURIComponent(areaId) + '/' + map + '/{z}/{x}/{y}.png?ramp=' + rampOf(p.stops) + '&lo=' + num(c.lo) + '&hi=' + num(c.hi);
  }
  const layerId = (areaId, map) => 'am-' + areaId + '-' + map;
  const pure = { MAPS, PRESETS, rampOf, presetOf, defaults, urlOf, layerId };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document) return;

  const w = root, doc = w.document;
  const CK = 'flex.am.colours';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const allColours = () => { try { return JSON.parse(localStorage.getItem(CK) || '{}') || {}; } catch (_) { return {}; } };
  const info = {};          // areaId → GET /api/areas/maps/<id> answer (or a pending promise)
  let cur = [];             // the layer descriptors listed now

  function colours(id) {
    const L = cur.find(l => l.id === id); if (!L) return null;
    return Object.assign(defaults(L.map, L.info), allColours()[id] || {});
  }
  function setColours(id, c) {
    const all = allColours();
    if (c) all[id] = { preset: c.preset, lo: +c.lo, hi: +c.hi }; else delete all[id];
    try { localStorage.setItem(CK, JSON.stringify(all)); } catch (_) {}
    build(); push();
  }

  const loadedAreas = () => {
    const A = w._areas; if (!A || !A.available || !A.available()) return [];
    return A.list().filter(a => A.eyeOf(a.id) === 'on' && a.results && (a.results.bush || a.results.ground));
  };
  /** The descriptors for custom-layers.js (owner 'a'). */
  function build() {
    const out = [];
    for (const a of loadedAreas()) {
      const I = info[a.id]; if (!I || I.then || !I.ok) continue;
      for (const M of MAPS) {
        const id = layerId(a.id, M.id), mi = (I.maps || []).find(m => m.id === M.id);
        const base = { id, name: M.name + ': ' + a.name, map: M.id, result: M.result, areaId: a.id, defShow: M.show, defAlpha: M.alpha };
        if (mi && I.bounds) {
          const c = Object.assign(defaults(M.id, mi), allColours()[id] || {});
          out.push(Object.assign(base, { kind: 'tiles', url: urlOf(a.id, M.id, c), bounds: I.bounds, minZoom: I.minZoom, maxZoom: I.maxZoom, colours: true, info: mi }));
        } else {
          const lg = (I.legacy || []).find(x => x.id === M.id);
          if (lg) out.push(Object.assign(base, { kind: 'imagery', src: '/api/areas/file/' + encodeURIComponent(a.id) + '/bush/' + lg.file, bounds: lg.bounds, note: 're-import the area to change colours', defAlpha: 0.75 }));
        }
      }
    }
    cur = out; return out;
  }
  function list() { return cur.slice(); }
  /** Fetch the maps of the loaded areas (once each), then list them. */
  async function refresh(force) {
    const want = loadedAreas();
    await Promise.all(want.map(async a => {
      if (info[a.id] && !force) { if (info[a.id].then) await info[a.id]; return; }
      info[a.id] = (async () => { try { const r = await fetch('/api/areas/maps/' + encodeURIComponent(a.id)); return r.ok ? await r.json() : { ok: false }; } catch (_) { return { ok: false }; } })();
      info[a.id] = await info[a.id];
    }));
    build(); await push();
  }
  async function push() {
    const CL = w._customLayers; if (!CL) return;
    try { await CL.sync(true); if (CL.render) CL.render(true); } catch (e) { console.warn('[area-maps]', e); }
    if (w._renderLayerList) w._renderLayerList();
  }

  // ── The Analyze result switches: one state with the layers' own ──
  /** 'on' | 'half' | '' (area off / no maps) for an area's bush or ground result. */
  function resultState(areaId, result) {
    const ls = cur.filter(l => l.areaId === areaId && l.result === result); if (!ls.length) return '';
    const CL = w._customLayers;
    return ls.some(l => CL && CL.api.viewOf(l.id).show) ? 'on' : 'half';
  }
  function hasMaps(areaId, result) { return cur.some(l => l.areaId === areaId && l.result === result); }
  async function setResult(areaId, result, on) {
    const ls = cur.filter(l => l.areaId === areaId && l.result === result), CL = w._customLayers; if (!CL) return;
    if (on) { const first = ls.find(l => l.defShow) || ls[0]; if (first) CL.api.setView(first.id, { show: true }); }
    else ls.forEach(l => CL.api.setView(l.id, { show: false }));
    await push(); fire();
  }
  const fire = () => w.dispatchEvent(new CustomEvent('flex-area-maps', {}));

  // ── Colours… ──
  let dlg = null;
  function dialog(id) {
    const L = cur.find(l => l.id === id); if (!L || !L.colours) return;
    close();
    const M = MAPS.find(m => m.id === L.map), mi = L.info, c0 = colours(id);
    let c = Object.assign({}, c0);
    const vmin = mi.min * M.scale, vmax = mi.max * M.scale, step = M.step;
    const fmt = v => (Math.round(v * M.scale / step) * step).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0);
    dlg = doc.createElement('div'); dlg.className = 'pj-modal am-modal'; dlg.id = 'am-colours';
    dlg.innerHTML = `<div class="am-box" role="dialog" aria-label="Colours of ${esc(L.name)}">
      <div class="am-h"><b>Colours</b> <span class="am-dim">${esc(L.name)}</span><button type="button" class="am-x" data-a="close" aria-label="Close">×</button></div>
      <div class="am-presets" role="radiogroup">${(PRESETS[L.map] || []).map(p => `<button type="button" class="am-pre" data-p="${p.id}" role="radio"><span class="am-strip" style="background:${grad(p.stops)}"></span><span>${esc(p.name)}</span></button>`).join('')}</div>
      <div class="am-range"><div class="am-dim">Values shown from … to … (${esc(mi.units)})</div>
        <label>From <input type="range" id="am-lo" min="${vmin}" max="${vmax}" step="${step}"> <input type="number" id="am-lon" min="${vmin}" max="${vmax}" step="${step}"> ${esc(M.unit)}</label>
        <label>To <input type="range" id="am-hi" min="${vmin}" max="${vmax}" step="${step}"> <input type="number" id="am-hin" min="${vmin}" max="${vmax}" step="${step}"> ${esc(M.unit)}</label>
        <div class="am-legend"><span class="am-strip am-big"></span><div class="am-ends"><span id="am-l0"></span><span id="am-l1"></span></div></div>
      </div>
      <div class="am-btns"><button type="button" class="am-btn" data-a="reset">Reset to default</button><button type="button" class="am-btn am-ok" data-a="close">Done</button></div></div>`;
    doc.body.appendChild(dlg);
    const $ = s => dlg.querySelector(s);
    let t = null;
    const paint = () => {
      dlg.querySelectorAll('.am-pre').forEach(b => { const on = b.dataset.p === presetOf(L.map, c.preset).id; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
      $('#am-lo').value = $('#am-lon').value = fmt(c.lo); $('#am-hi').value = $('#am-hin').value = fmt(c.hi);
      $('.am-big').style.background = grad(presetOf(L.map, c.preset).stops);
      $('#am-l0').textContent = fmt(c.lo) + ' ' + M.unit; $('#am-l1').textContent = fmt(c.hi) + ' ' + M.unit;
    };
    const apply = () => { clearTimeout(t); t = setTimeout(() => setColours(id, c), 250); };
    const setV = (k, v) => {
      v = +v / M.scale; if (!Number.isFinite(v)) return;
      const gap = step / M.scale;
      if (k === 'lo') c.lo = Math.min(v, c.hi - gap); else c.hi = Math.max(v, c.lo + gap);
      paint(); apply();
    };
    dlg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (e.target === dlg) return close(); if (!b) return;
      if (b.dataset.p) { c.preset = b.dataset.p; paint(); apply(); }
      else if (b.dataset.a === 'reset') { c = defaults(L.map, mi); paint(); clearTimeout(t); setColours(id, null); }
      else if (b.dataset.a === 'close') close();
    });
    $('#am-lo').addEventListener('input', e => setV('lo', e.target.value)); $('#am-hi').addEventListener('input', e => setV('hi', e.target.value));
    $('#am-lon').addEventListener('change', e => setV('lo', e.target.value)); $('#am-hin').addEventListener('change', e => setV('hi', e.target.value));
    dlg.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    paint();
  }
  function close() { if (dlg) { dlg.remove(); dlg = null; } }
  /** CSS gradient of stops over a checker (so transparency shows). */
  function grad(stops) {
    const rgba = s => `rgba(${parseInt(s[1].slice(0, 2), 16)},${parseInt(s[1].slice(2, 4), 16)},${parseInt(s[1].slice(4, 6), 16)},${s[2]})`;
    return `linear-gradient(90deg, ${stops.map(s => rgba(s) + ' ' + Math.round(s[0] * 100) + '%').join(', ')}), repeating-conic-gradient(#bbb 0% 25%, #eee 0% 50%) 0 0 / 8px 8px`;
  }

  const css = doc.createElement('style');
  css.textContent = `
  .am-modal { position: fixed; inset: 0; z-index: 10050; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; }
  .am-box { background: rgba(24,27,32,.98); color: #e8ece9; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; padding: 12px 14px; width: min(340px, calc(100vw - 32px)); font-size: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  .am-h { display: flex; gap: 6px; align-items: baseline; margin-bottom: 8px; } .am-h .am-dim { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-dim { color: rgba(255,255,255,.6); font-size: 11px; }
  .am-x { background: none; border: 0; color: rgba(255,255,255,.6); font-size: 16px; cursor: pointer; }
  .am-presets { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .am-pre { display: flex; gap: 8px; align-items: center; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.14); border-radius: 5px; color: inherit; padding: 4px 6px; cursor: pointer; text-align: left; font: inherit; }
  .am-pre.on { border-color: #3fae6e; background: rgba(63,174,110,.15); }
  .am-strip { display: inline-block; width: 70px; height: 12px; border-radius: 3px; flex-shrink: 0; border: 1px solid rgba(255,255,255,.2); }
  .am-strip.am-big { width: 100%; height: 14px; display: block; }
  .am-range label { display: flex; gap: 6px; align-items: center; margin: 5px 0; } .am-range input[type=range] { flex: 1; } .am-range input[type=number] { width: 62px; background: rgba(255,255,255,.07); color: inherit; border: 1px solid rgba(255,255,255,.2); border-radius: 4px; padding: 1px 4px; }
  .am-legend { margin-top: 6px; } .am-ends { display: flex; justify-content: space-between; color: rgba(255,255,255,.6); font-size: 10.5px; }
  .am-btns { display: flex; justify-content: space-between; margin-top: 12px; }
  .am-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.18); color: #e8ece9; border-radius: 5px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
  .am-ok { background: #2f8f57; border-color: #3fae6e; color: #fff; }
  .lp-am-col { background: none; border: 0; cursor: pointer; padding: 0 2px; font-size: 12px; flex-shrink: 0; }`;
  doc.head.appendChild(css);

  w._areaMaps = { list, refresh, presets: PRESETS, colours, setColours, urlOf, dialog, close, resultState, setResult, hasMaps, pure };
  // the area switches changed (Analyze), or the list of areas: list again
  w.addEventListener('flex-areas-changed', e => { const why = e.detail && e.detail.why; if (why === 'list') Object.keys(info).forEach(k => delete info[k]); if (why === 'list' || why === 'shown' || why === 'run') refresh(); });
})(typeof window !== 'undefined' ? window : null);
