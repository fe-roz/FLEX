// map-update.js — "Make an update": a phone map sent again as only what changed (Process, step 4, beside Make the map).
// window._mapUpdate. The server side is export_updates.js / export_update.py; the phone applies it (MapUpdate.kt).
//
// Offered when an earlier map of this area (or, without an area, of this name) was made on this computer and its
// manifest is still here: GET /api/export/bases. The button makes the map as usual (what the area already has is
// reused) and then the update package against the chosen earlier map: by default the last one sent to a phone, a
// small list picks another. Afterwards the card says what the update holds and its size against the full map, that
// nothing changed, or that nearly everything did; the package is first in Send to phone's list.
//
//   _mapUpdate.refresh()            ask again which earlier maps there are (the name or the area changed)
//   _mapUpdate.stamp(body)          export-ui.js: the request about to be sent; adds update_base when the button was used
//   _mapUpdate.done(jobId, status)  export-ui.js: the export finished; shows the card
//   _mapUpdate.state()              tests
(function (root) {
  'use strict';
  const mb = n => { n = +n || 0; return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; };
  const when = iso => { const d = new Date(iso); if (!iso || isNaN(d)) return 'an earlier time'; const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  /** A base in the list: "the map of 2026-11-23 10:30 (sent to a phone)". */
  const baseLabel = b => 'the map of ' + when(b.exported || b.time) + (b.sent ? ' (sent to a phone)' : '');
  /** What the card says after an export made with "Make an update": { kind: 'same'|'update'|'mostly'|'error', lines: [..] }. */
  function describe(u) {
    if (!u) return null;
    if (u.error) return { kind: 'error', lines: ['No update was made: ' + u.error + '. The full map is ready below.'] };
    if (u.same) return { kind: 'same', lines: ['Nothing changed since the map of ' + when(u.from) + ': no update is needed.'] };
    const n = (u.add || []).length + (u.replace || []).length, pct = u.full_bytes ? Math.max(1, Math.round(100 * u.package_bytes / u.full_bytes)) : 0;
    const names = (u.add || []).concat(u.replace || []), shown = names.slice(0, 8).join(', ') + (names.length > 8 ? ' and ' + (names.length - 8) + ' more' : '');
    const lines = ['Update: ' + mb(u.package_bytes) + ' · the full map is ' + mb(u.full_bytes) + (pct ? ' (' + pct + ' % of it)' : ''),
      n + (n === 1 ? ' file' : ' files') + ' changed since the map of ' + when(u.from) + ': ' + shown + ((u.remove || []).length ? '; removed: ' + u.remove.join(', ') : ''),
      'For FLEX Field: it brings that map up to date and keeps everything added on the phone. It has no viewer.html for a desktop browser (the full map below has).'];
    if (u.mostly) lines.splice(1, 0, 'More than 80 % of the map changed: sending the full map is as good.');
    return { kind: u.mostly ? 'mostly' : 'update', lines };
  }
  const pure = { mb, when, baseLabel, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document) return;

  const w = root, doc = w.document, $ = id => doc.getElementById(id);
  const S = { bases: [], mapId: '', key: '', want: false, last: null, timer: null };
  const pick = () => { try { return w._process && w._process.pick ? w._process.pick() : {}; } catch (_) { return {}; } };
  function query() {
    const name = (($('export_map_name') || {}).value || '').trim(), mapTerrain = ($('export_terrain_source') || {}).value === 'map';
    const area = !mapTerrain && pick().area || '';
    return { name, area };
  }
  function paint() {
    const row = $('export_update_row'); if (!row) return;
    row.style.display = S.bases.length ? 'block' : 'none';
    const sel = $('export_update_base'), keep = sel.value;
    sel.textContent = '';
    S.bases.forEach(b => sel.add(new Option('Since ' + baseLabel(b), b.id)));
    if (keep && S.bases.some(b => b.id === keep)) sel.value = keep;
    sel.style.display = S.bases.length > 1 ? '' : 'none';
    const one = $('export_update_one'); if (one) { one.textContent = S.bases.length === 1 ? 'Since ' + baseLabel(S.bases[0]) + '.' : ''; one.style.display = S.bases.length === 1 ? '' : 'none'; }
    const btn = $('export_update_btn'), run = $('export_run_btn');
    if (btn && run) btn.disabled = run.disabled;
    const card = $('export_update_card'), d = describe(S.last);
    if (card) {
      card.style.display = d ? 'block' : 'none'; card.dataset.kind = d ? d.kind : '';
      card.textContent = '';
      if (d) d.lines.forEach((t, i) => { const e = doc.createElement('div'); e.textContent = t; if (i === 0) e.style.fontWeight = '600'; else e.style.color = 'rgba(255,255,255,0.65)'; card.appendChild(e); });
    }
  }
  async function refresh() {
    const q = query(), key = q.area + '|' + q.name;
    if (!q.name && !q.area) { S.bases = []; S.key = key; paint(); return S.bases; }
    S.key = key;
    try {
      const r = await (await fetch('/api/export/bases?name=' + encodeURIComponent(q.name) + (q.area ? '&area=' + encodeURIComponent(q.area) : ''))).json();
      if (S.key !== key) return S.bases;
      S.bases = (r && r.ok && r.bases) || []; S.mapId = (r && r.map_id) || '';
    } catch (_) { S.bases = []; }
    paint();
    return S.bases;
  }
  const soon = () => { clearTimeout(S.timer); S.timer = setTimeout(refresh, 400); };
  /** The button: the map is made as usual, then the update against the chosen earlier map. */
  function run() {
    if (!S.bases.length || typeof w._exportRun !== 'function') return;
    S.want = ($('export_update_base') || {}).value || S.bases[0].id;
    S.last = null; paint();
    w._exportRun();           // (the request is put together and sent a moment later: stamp() below adds the base to it)
  }
  function stamp(body) {
    if (S.want && body && typeof body === 'object') body.update_base = S.want;
    S.want = false; S.asked = !!(body && body.update_base);          // (a retry from the Jobs strip sends the same request again: still an update)
    S.last = null; paint();
    return body;
  }
  function done(jobId, status) {
    S.last = S.asked ? ((status && status.update) || { error: 'the server did not say' }) : null;
    S.asked = false;
    paint();
    refresh();
    return S.last && S.last.id ? S.last.id : jobId;       // what Send to phone should offer first
  }
  function start() {
    if (!$('export_update_row')) return;
    $('export_update_btn').addEventListener('click', run);
    const plain = $('export_run_btn'); if (plain) plain.addEventListener('click', () => { S.want = false; }, true);      // "Make the map" is a plain map, also after an update run that stopped early
    const nm = $('export_map_name'); if (nm) nm.addEventListener('input', soon);
    const ts = $('export_terrain_source'); if (ts) ts.addEventListener('change', soon);
    w.addEventListener('flex-areas-changed', soon);
    const runBtn = $('export_run_btn'); if (runBtn) new MutationObserver(paint).observe(runBtn, { attributes: true, attributeFilter: ['disabled'] });
    const panel = $('exportCollapsible'); if (panel) new MutationObserver(() => { if (panel.classList.contains('show')) refresh(); }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    refresh();
  }
  w._mapUpdate = { refresh, stamp, done, run, state: () => ({ bases: S.bases.slice(), mapId: S.mapId, last: S.last }), pure };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : null);
