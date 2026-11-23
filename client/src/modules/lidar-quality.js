// lidar-quality.js — the LiDAR quality report of a processed area, as a card (🔬 Analyze → Processed areas →
// Ridgewalking → "LiDAR quality").
//
// The report is ridge/quality.json, measured by the ridgewalking step (ridgewalk.py write_quality): how many flight
// passes cover the area and where coverage is thin, which passes were flagged and what they lost, how much of the
// ground the LiDAR saw, whether part of the read failed. Numbers and what they mean; nothing here scores or judges.
// Its three rasters are normal map layers (area-maps.js: LiDAR passes, Ground seen, Return density), switched from
// the card or from 🗺 Layers.
//
// window._lidarQuality = { open(areaId, name), show(q, name, areaId), close, pure }
(function (root) {
  'use strict';
  const n0 = v => (Number.isFinite(+v) ? Math.round(+v).toLocaleString('en-US') : '?');
  /** A share 0..1 as per cent with one decimal ("0.1 %"; "under 0.1 %" for a share that is not nothing). */
  function pct(v) {
    if (!Number.isFinite(+v)) return '?';
    const p = +v * 100; if (p > 0 && p < 0.05) return 'under 0.1 %';
    return (Math.round(p * 10) / 10).toString() + ' %';
  }
  const big = v => { v = +v; if (!Number.isFinite(v)) return '?'; return v >= 1e9 ? (v / 1e9).toFixed(2) + ' billion' : v >= 1e6 ? (v / 1e6).toFixed(1) + ' million' : n0(v); };
  const area = m2 => (!Number.isFinite(+m2) ? '?' : +m2 >= 1e5 ? (+m2 / 1e6).toFixed(2) + ' km²' : n0(m2) + ' m²');
  /** The report as plain rows: { verdicts: [text], cloud / coverage / reading: [[label, value]], passes: [{…}], blank: [text] }. */
  function rows(q) {
    q = q || {}; const c = q.cloud || {}, v = q.coverage || {}, r = q.reading || {};
    const dates = Array.isArray(c.dates) && c.dates.length === 2 ? (c.dates[0] === c.dates[1] ? c.dates[0] : c.dates[0] + ' to ' + c.dates[1]) : 'unknown' + (c.dates_how ? ' (' + c.dates_how + ')' : '');
    const cloud = [
      ['Dataset' + ((c.datasets || []).length > 1 ? 's' : ''), (c.datasets || []).join(', ') || 'not named'],
      ['Flown', dates],
      ['Returns', big(c.returns) + ' · ' + (Number.isFinite(+c.returns_per_m2) ? (+c.returns_per_m2).toFixed(1) : '?') + ' per m²'],
      ['Ground returns (class 2)', big(c.ground_returns) + ' · ' + (Number.isFinite(+c.ground_returns_per_m2) ? (+c.ground_returns_per_m2).toFixed(1) : '?') + ' per m²'],
      ['Classes', (c.classes || []).map(k => k.name + ' ' + pct(k.share)).join(', ') || '?'],
    ];
    const pp = v.passes_per_cell || {};
    const coverage = [
      ['Area measured', area(v.area_m2)],
      ['Passes over a spot', pp.median == null ? '?' : 'typically ' + pp.median + ' (least ' + pp.least + ', most ' + pp.most + ')'],
      ['Seen by 3 or more passes', pct(v.passes_3_or_more)], ['Seen by 2 passes', pct(v.passes_2)], ['Seen by 1 pass only', pct(v.passes_1)], ['Seen by no pass', pct(v.passes_0)],
      ['No ground return within 1 m', pct(v.no_ground_within_1m)], ['No ground return within 3 m', pct(v.no_ground_within_3m)],
      ['Largest patch with no ground return', area(v.largest_patch_without_ground_m2)],
    ];
    const reading = [['Tiles', n0(r.tiles)]];
    if (r.read_in_this_run) { reading.push(['Read again after a failed try', r.retried == null ? 'not known' : n0(r.retried)]); reading.push(['Left blank', n0(r.left_blank)]); }
    else reading.push(['Left blank', 'not known (the tiles were not read in this run)']);
    if (r.without_returns) reading.push(['With no returns', n0(r.without_returns)]);
    const passes = (q.passes || []).map(p => ({ id: p.id, cloud: p.cloud || 0, returns: big(p.returns), share: pct(p.share), angle: p.median_scan_angle == null ? '' : p.median_scan_angle + '°', flagged: !!p.flagged,
      blocks: p.flagged ? p.blocks_flagged + ' / ' + p.blocks_reached : '', setAside: p.flagged ? n0(p.set_aside) : '', kept: p.flagged ? n0(p.kept_confirmed) : '' }));
    const blank = (r.blank || []).map(b => (Array.isArray(b.lonlat) ? b.lonlat.slice(0, 2).reverse().map(x => (+x).toFixed(5)).join(', ') + ' to ' + b.lonlat.slice(2, 4).reverse().map(x => (+x).toFixed(5)).join(', ') : 'tile ' + (b.tile || []).join(' / ')) + (b.why ? ': ' + b.why : ''));
    return { verdicts: (q.verdicts || []).map(x => String(x.text || '')).filter(Boolean), cloud, coverage, reading, passes, blank, angles: passes.some(p => p.angle) };
  }
  const pure = { rows, pct, big, area };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document) return;

  const w = root, doc = w.document;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let card = null, cur = null;
  // what the three layers' default colours mean (area-maps.js DEF)
  const LAYERS = [
    { map: 'passes', name: 'LiDAR passes', key: [['#c2185b', 'none'], ['#e0402a', '1'], ['#f2e14c', '2'], ['rgba(46,155,74,.45)', '3 or more']] },
    { map: 'groundseen', name: 'Ground seen', key: [['#b3170f', 'none'], ['#f07c22', 'little'], ['#ffd23f', 'some'], ['transparent', 'plenty: clear']] },
    { map: 'density', name: 'Return density', key: [['#440154', 'few'], ['#21918c', '75 per m²'], ['#fde725', '150 per m² or more']] },
  ];
  function css() {
    if (doc.getElementById('lq-css')) return;
    const st = doc.createElement('style'); st.id = 'lq-css';
    st.textContent = `
  #lq-card { position: fixed; top: 64px; right: 16px; z-index: 9000; width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 96px); overflow: auto; background: rgb(24,27,32); color: #e8ece9;
    border: 1px solid rgba(255,255,255,.18); border-radius: 8px; padding: 12px 14px; font-size: 12px; line-height: 1.45; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
  #lq-card h3 { margin: 0 0 2px; font-size: 14px; font-weight: 600; display: flex; gap: 8px; align-items: baseline; } #lq-card h3 span { flex: 1; }
  #lq-card h4 { margin: 12px 0 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: rgba(255,255,255,.6); }
  #lq-card .lq-x { background: none; border: 0; color: rgba(255,255,255,.6); font-size: 16px; cursor: pointer; }
  #lq-card .lq-dim { color: rgba(255,255,255,.58); font-size: 11px; }
  #lq-card ul { margin: 6px 0 0; padding-left: 16px; } #lq-card li { margin: 2px 0; }
  #lq-card table { border-collapse: collapse; width: 100%; } #lq-card td, #lq-card th { padding: 2px 6px 2px 0; text-align: left; vertical-align: top; font-weight: 400; }
  #lq-card th { color: rgba(255,255,255,.58); font-size: 10.5px; } #lq-card td.lq-k { color: rgba(255,255,255,.7); width: 46%; } #lq-card .lq-n { text-align: right; font-variant-numeric: tabular-nums; }
  #lq-card tr.lq-flag td { color: #ffb020; }
  #lq-card .lq-lay { display: flex; gap: 8px; align-items: center; margin: 4px 0; flex-wrap: wrap; } #lq-card .lq-lay .sw-row { min-width: 128px; }
  #lq-card .lq-key { display: inline-flex; gap: 3px; align-items: center; color: rgba(255,255,255,.7); font-size: 10.5px; margin-right: 6px; }
  #lq-card .lq-key i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(255,255,255,.3); }`;
    doc.head.appendChild(st);
  }
  function close() { if (card) { card.remove(); card = null; cur = null; } }
  const kv = list => '<table>' + list.map(r => `<tr><td class="lq-k">${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('') + '</table>';
  function paintLayers() {
    if (!card || !cur) return;
    const box = card.querySelector('.lq-layers'); if (!box) return;
    const AM = w._areaMaps; box.textContent = '';
    const have = AM && cur.areaId && LAYERS.some(L => AM.list().some(l => l.id === AM.layerId(cur.areaId, L.map)));
    if (!have) { const d = doc.createElement('div'); d.className = 'lq-dim'; d.textContent = cur.areaId ? 'Switch the area on (Processed areas) to draw these on the map.' : ''; box.appendChild(d); return; }
    LAYERS.forEach(L => {
      const id = AM.layerId(cur.areaId, L.map), row = doc.createElement('div'); row.className = 'lq-lay';
      const sw = w.uiSwitch ? w.uiSwitch(AM.isShown(id), on => AM.setShown(id, on), L.name, { small: true, id: 'lq-sw-' + L.map }) : doc.createTextNode(L.name);
      row.appendChild(sw);
      const k = doc.createElement('span'); k.innerHTML = L.key.map(q => `<span class="lq-key"><i style="background:${q[0]}"></i>${esc(q[1])}</span>`).join(''); row.appendChild(k);
      box.appendChild(row);
    });
  }
  /** The card for report q. */
  function show(q, name, areaId) {
    css(); close();
    const R = rows(q); cur = { areaId: areaId || '', q };
    card = doc.createElement('div'); card.id = 'lq-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'LiDAR quality');
    const cols = R.angles ? '<th class="lq-n">Scan angle</th>' : '';
    card.innerHTML = `<h3><span>LiDAR quality</span><button type="button" class="lq-x" aria-label="Close">×</button></h3>
      <div class="lq-dim">${esc(name || '')}${name ? ' · ' : ''}what the LiDAR measured here, before you trust a feature</div>
      <ul class="lq-verdicts">${R.verdicts.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <h4>On the map</h4><div class="lq-layers"></div><div class="lq-dim">Also in Layers, with Colours.</div>
      <h4>Flight passes</h4>
      <table class="lq-passes"><tr><th>Pass</th><th class="lq-n">Returns</th><th class="lq-n">Share</th>${cols}<th class="lq-n">Blocks flagged / reached</th><th class="lq-n">Set aside</th><th class="lq-n">Kept</th></tr>
      ${R.passes.map(p => `<tr class="${p.flagged ? 'lq-flag' : ''}"><td>${esc(p.id)}${p.cloud ? ' <span class="lq-dim">cloud ' + (p.cloud + 1) + '</span>' : ''}${p.flagged ? ' · flagged' : ''}</td><td class="lq-n">${esc(p.returns)}</td><td class="lq-n">${esc(p.share)}</td>${R.angles ? `<td class="lq-n">${esc(p.angle)}</td>` : ''}<td class="lq-n">${esc(p.blocks)}</td><td class="lq-n">${esc(p.setAside)}</td><td class="lq-n">${esc(p.kept)}</td></tr>`).join('')}</table>
      <div class="lq-dim">Flagged = patterned noise: returns far below ground along the pass's own track. Set aside = taken out of the features; kept = another pass confirms them.${R.angles ? ' Scan angle: the median, from straight down.' : ''}</div>
      <h4>Coverage</h4>${kv(R.coverage)}
      <div class="lq-dim">A pass counts over a spot from ${esc((q.coverage || {}).pass_counts_from_returns || 5)} of its returns in a ${esc((q.coverage || {}).cell_m || 7.2)} m cell. Where the ground was not seen it is filled in from around: a hole there may be missed or made up.</div>
      <h4>The cloud</h4>${kv(R.cloud)}
      <h4>Reading</h4>${kv(R.reading)}${R.blank.length ? '<ul class="lq-blank">' + R.blank.slice(0, 12).map(t => `<li>${esc(t)}</li>`).join('') + '</ul>' : ''}`;
    doc.body.appendChild(card);
    card.querySelector('.lq-x').addEventListener('click', close);
    paintLayers();
    return card;
  }
  async function open(areaId, name) {
    let q = null;
    try { const r = await fetch('/api/areas/file/' + encodeURIComponent(areaId) + '/ridge/quality.json'); if (r.ok) q = await r.json(); } catch (_) {}
    if (!q || !q.coverage) q = { verdicts: [{ text: 'This result has no LiDAR quality report: run Ridgewalking again to get one.' }] };
    if (w._areaMaps) { try { await w._areaMaps.refresh(); } catch (_) {} }
    return show(q, name, areaId);
  }
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && card) close(); });
  w.addEventListener('flex-area-maps', paintLayers);
  w.addEventListener('flex-areas-changed', () => setTimeout(paintLayers, 300));
  w._lidarQuality = { open, show, close, pure };
})(typeof window !== 'undefined' ? window : null);
