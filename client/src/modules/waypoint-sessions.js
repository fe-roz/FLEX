// waypoint-sessions.js — old waypoints from a GPS app (Gaia GPS and similar) into FLEX, only the ones inside an area,
// grouped into SESSIONS (points dropped within a short window: one field day's walk).
//
// Pure core (browser: window._wptSessions, Node: module.exports; tools/test_waypoint_sessions.js):
//   parse(text, fileName)         → { points, stats }   format sniffed: GPX (<wpt>), GeoJSON (Point features), KML (Placemark/Point)
//   parseAsync(text, name, onProgress)   same, in slices so the page stays alive (progress 0..1)
//   (dialog: the area is window._areas.current().ring when there is one, else the area picker's, else all points)
//   inRing(lon, lat, ring)        point in polygon; filterRing(points, ring)
//   dedupe(points)                same place (≤ 3 m) and same name → one, with a count; earliest time, every distinct note
//   sessionsByGap(points, gapMs, tz?)  sorted by time; a gap longer than gapMs starts a session; no time → "No time"
//   sessionsByDay(points)         one group per local day
// A point: { id, name, note, desc, cmt, time (ms | null), timeRaw, ele, sym, type, lon, lat, ext (raw extensions text),
//            props (the file's own properties, every one), n (how many were merged), src: { file, id } }.
// Nothing is dropped: `props` / `ext` carry every field of the original, and the import stores them with the point.
//
// What the formats are assumed to look like (Gaia's exports could only be guessed at):
//   GPX      <wpt lat lon><name><desc><cmt><time><ele><sym><type><extensions>…
//   GeoJSON  FeatureCollection; Point features; properties: title | name, notes | description | desc, time_created | time |
//            created | updated_date (ISO text or epoch seconds/ms), icon | sym, elevation | ele (else coordinates[2]), id.
//   KML      Placemark: name, description, TimeStamp/when or TimeSpan/begin, ExtendedData/Data/value, Point/coordinates lon,lat,alt.
(function (root) {
  'use strict';
  const M_LAT = 110540, mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

  const unesc = s => String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
  const tag = (body, name) => { const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(body); return m ? unesc(m[1]).trim() : ''; };
  const attr = (s, name) => { const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"|\\b' + name + "\\s*=\\s*'([^']*)'", 'i').exec(s); return m ? unesc(m[1] != null ? m[1] : m[2]) : ''; };
  /** A time as ms: ISO text, or a number (epoch seconds when below 1e11, else ms). null when none / unreadable. */
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) { const n = +v; return Number.isFinite(n) && n > 0 ? (n < 1e11 ? Math.round(n * 1000) : Math.round(n)) : null; }
    const t = Date.parse(String(v)); return Number.isFinite(t) ? t : null;
  }
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const okLL = (lon, lat) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  // ── Generators: one point at a time, so a caller can slice the work ──────
  function* gpxIter(text, file, stats) {
    stats.tracks = (text.match(/<trk[\s>]/gi) || []).length; stats.routes = (text.match(/<rte[\s>]/gi) || []).length;
    const re = /<wpt\b([^>]*?)(\/>|>([\s\S]*?)<\/wpt>)/gi; let m, i = 0;
    while ((m = re.exec(text))) {
      i++;
      const lat = num(attr(m[1], 'lat')), lon = num(attr(m[1], 'lon')); if (!okLL(lon, lat)) { stats.skipped++; continue; }
      const b = m[3] || '', ex = /<extensions\b[^>]*>([\s\S]*?)<\/extensions>/i.exec(b);
      const timeRaw = tag(b, 'time');
      yield mk({ id: 'wpt' + i, name: tag(b, 'name'), desc: tag(b, 'desc'), cmt: tag(b, 'cmt'), timeRaw, ele: num(tag(b, 'ele')), sym: tag(b, 'sym'), type: tag(b, 'type'),
        lon, lat, ext: ex ? ex[1].trim() : '', props: {}, link: (/<link\b[^>]*href\s*=\s*"([^"]*)"/i.exec(b) || [])[1] || '' }, file);
    }
  }
  function* geoIter(text, file, stats) {
    let j; try { j = JSON.parse(text); } catch (e) { throw new Error('not valid GeoJSON: ' + e.message); }
    const feats = j.type === 'FeatureCollection' ? j.features || [] : j.type === 'Feature' ? [j] : Array.isArray(j) ? j : [];
    let i = 0;
    for (const f of feats) {
      i++;
      const g = f && f.geometry; if (!g) { stats.skipped++; continue; }
      if (g.type !== 'Point') { if (/Line|Polygon/.test(g.type)) stats.tracks++; else stats.skipped++; continue; }
      const p = f.properties || {}, c = g.coordinates || [], lon = num(c[0]), lat = num(c[1]); if (!okLL(lon, lat)) { stats.skipped++; continue; }
      const pick = (...ks) => { for (const k of ks) if (p[k] != null && p[k] !== '') return p[k]; return ''; };
      const timeRaw = pick('time_created', 'time', 'created', 'created_date', 'timestamp', 'updated_date');
      const note = pick('notes', 'description', 'desc', 'note', 'comment');
      yield mk({ id: String(f.id != null ? f.id : pick('id', 'uuid') || 'wpt' + i), name: String(pick('title', 'name', 'label')), desc: String(note), cmt: '', timeRaw: String(timeRaw),
        _t: timeRaw, ele: num(pick('elevation', 'ele', 'altitude')) != null ? num(pick('elevation', 'ele', 'altitude')) : num(c[2]), sym: String(pick('icon', 'sym', 'symbol')), type: String(pick('type', 'category')),
        lon, lat, ext: '', props: p }, file);
    }
  }
  function* kmlIter(text, file, stats) {
    stats.tracks = (text.match(/<LineString\b|<LinearRing\b/gi) || []).length;
    const re = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi; let m, i = 0;
    while ((m = re.exec(text))) {
      i++; const b = m[1];
      const pt = /<Point\b[^>]*>([\s\S]*?)<\/Point>/i.exec(b); if (!pt) { if (!/<LineString|<Polygon|<LinearRing|<MultiGeometry/i.test(b)) stats.skipped++; continue; }
      const c = tag(pt[1], 'coordinates').split(/[,\s]+/).map(num), lon = c[0], lat = c[1]; if (!okLL(lon, lat)) { stats.skipped++; continue; }
      const props = {}; let d; const dre = /<Data\s+name\s*=\s*"([^"]*)"[^>]*>\s*(?:<displayName>[\s\S]*?<\/displayName>)?\s*<value>([\s\S]*?)<\/value>/gi;
      while ((d = dre.exec(b))) props[unesc(d[1])] = unesc(d[2]).trim();
      const timeRaw = tag(b, 'when') || tag(b, 'begin') || props.time || props.time_created || '';
      yield mk({ id: attr(m[0].slice(0, m[0].indexOf('>') + 1), 'id') || 'wpt' + i, name: tag(b, 'name'), desc: tag(b, 'description'), cmt: '', timeRaw, ele: c[2] != null && c[2] !== 0 ? c[2] : null,
        sym: tag(b, 'styleUrl'), type: '', lon, lat, ext: '', props }, file);
    }
  }
  function mk(o, file) {
    const t = toMs(o._t != null && o._t !== '' ? o._t : o.timeRaw);
    const note = [o.desc, o.cmt].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('\n');
    return Object.assign({ n: 1, notes: note ? [note] : [] }, o, { _t: undefined, time: t, note, src: { file: file || '', id: o.id } });
  }
  function sniff(text, name) {
    const h = text.slice(0, 2000).trimStart();
    if (/\.(geo)?json$/i.test(name || '') || /^[\[{]/.test(h)) return 'geojson';
    if (/<gpx\b/i.test(text.slice(0, 5000)) || /\.gpx$/i.test(name || '')) return 'gpx';
    if (/<kml\b|<Placemark/i.test(text.slice(0, 5000)) || /\.kml$/i.test(name || '')) return 'kml';
    return /<wpt\b/i.test(text) ? 'gpx' : /<Placemark/i.test(text) ? 'kml' : 'gpx';
  }
  function begin(text, name) {
    const fmt = sniff(text, name), stats = { format: fmt, tracks: 0, routes: 0, skipped: 0, points: 0, file: name || '' };
    const it = (fmt === 'geojson' ? geoIter : fmt === 'kml' ? kmlIter : gpxIter)(text, name || '', stats);
    return { it, stats, size: text.length };
  }
  function parse(text, name) { const { it, stats } = begin(text, name); const points = []; for (const p of it) points.push(p); stats.points = points.length; return { points, stats }; }
  async function parseAsync(text, name, onProgress) {
    const { it, stats } = begin(text, name); const points = []; let n = 0, t0 = Date.now();
    for (const p of it) {
      points.push(p);
      if (++n % 2000 === 0 && Date.now() - t0 > 30) { if (onProgress) onProgress(Math.min(0.99, n / Math.max(n, text.length / 400)), n); await new Promise(r => setTimeout(r, 0)); t0 = Date.now(); }
    }
    stats.points = points.length; if (onProgress) onProgress(1, n);
    return { points, stats };
  }

  // ── Area ────────────────────────────────────────────────────────────────
  function inRing(lon, lat, ring) {
    let in_ = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) in_ = !in_;
    }
    return in_;
  }
  function filterRing(points, ring) {
    if (!ring || ring.length < 3) return points.slice();
    let w = 1e9, s = 1e9, e = -1e9, n = -1e9; ring.forEach(p => { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); });
    return points.filter(p => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n && inRing(p.lon, p.lat, ring));
  }

  // ── Duplicates ──────────────────────────────────────────────────────────
  /** Same place (≤ metres, default 3) and same name (case, spaces ignored) → one: earliest time, all distinct notes, n = how many. */
  function dedupe(points, metres) {
    const r = metres == null ? 3 : metres, cell = 0.00005, grid = new Map(), out = [];
    const key = (a, b) => a + ':' + b;
    for (const p of points) {
      const nm = String(p.name || '').trim().toLowerCase().replace(/\s+/g, ' '), cx = Math.floor(p.lon / cell), cy = Math.floor(p.lat / cell);
      let hit = null;
      for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (const q of grid.get(key(cx + dx, cy + dy)) || []) {
          if (q._nm !== nm) continue;
          if (Math.hypot((p.lon - q.lon) * mLon(p.lat), (p.lat - q.lat) * M_LAT) <= r) { hit = q; break; }
        }
      }
      if (!hit) { const q = Object.assign({}, p, { _nm: nm, notes: (p.notes || []).slice(), dups: [] }); out.push(q); const k = key(cx, cy); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(q); continue; }
      hit.n += p.n || 1; hit.dups.push({ id: p.src.id, time: p.time, timeRaw: p.timeRaw });
      (p.notes || []).forEach(x => { if (!hit.notes.includes(x)) hit.notes.push(x); });
      if (p.time != null && (hit.time == null || p.time < hit.time)) { hit.time = p.time; hit.timeRaw = p.timeRaw; }
    }
    out.forEach(q => { delete q._nm; q.note = q.notes.join('\n---\n'); if (q.n > 1) q.note += (q.note ? '\n' : '') + `(${q.n} waypoints with this name at this spot were merged)`; });
    return out;
  }

  // ── Sessions ────────────────────────────────────────────────────────────
  const p2 = n => String(n).padStart(2, '0');
  const dateOf = t => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
  const clock = t => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  function describe(pts) {
    let w = 1e9, s = 1e9, e = -1e9, n = -1e9; pts.forEach(p => { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); });
    const lat = (s + n) / 2; return { w, s, e, n, spreadM: Math.round(Math.max((e - w) * mLon(lat), (n - s) * M_LAT)) };
  }
  function mkSession(pts, kind) {
    const timed = pts.filter(p => p.time != null), a = timed.length ? timed[0].time : null, b = timed.length ? timed[timed.length - 1].time : null;
    const s = { points: pts, start: a, end: b, count: pts.length, long: a != null && b - a > 12 * 3600e3, box: describe(pts), kind };
    if (a == null) s.name = `No time, ${pts.length} point${pts.length === 1 ? '' : 's'}`;
    else if (kind === 'day') s.name = `${dateOf(a)}, ${pts.length} point${pts.length === 1 ? '' : 's'}${dateOf(a) !== dateOf(b) ? ' (to ' + dateOf(b) + ')' : ''}`;
    else s.name = `${dateOf(a)} ${clock(a)}${dateOf(a) !== dateOf(b) ? '-' + dateOf(b) + ' ' + clock(b) : '-' + clock(b)}, ${pts.length} point${pts.length === 1 ? '' : 's'}`;
    s.id = a == null ? 'notime' : String(a);
    return s;
  }
  const byTime = (a, b) => a.time - b.time;
  /** gapMs: a new session when the next point is more than this after the previous one. */
  function sessionsByGap(points, gapMs) {
    const timed = points.filter(p => p.time != null).sort(byTime), none = points.filter(p => p.time == null), out = [];
    let cur = null, last = 0;
    for (const p of timed) { if (!cur || p.time - last > gapMs) { cur = []; out.push(cur); } cur.push(p); last = p.time; }
    const res = out.map(x => mkSession(x, 'gap')); if (none.length) res.push(mkSession(none, 'gap'));
    return res;
  }
  function sessionsByDay(points) {
    const timed = points.filter(p => p.time != null).sort(byTime), none = points.filter(p => p.time == null), by = new Map();
    timed.forEach(p => { const k = dateOf(p.time); if (!by.has(k)) by.set(k, []); by.get(k).push(p); });
    const res = [...by.values()].map(x => mkSession(x, 'day')); if (none.length) res.push(mkSession(none, 'day'));
    return res;
  }

  const api = { parse, parseAsync, inRing, filterRing, dedupe, sessionsByGap, sessionsByDay, toMs, sniff, dateOf, clock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root._wptSessions = api;

  // ═════════════════════════════ The dialog (browser only) ═════════════════════════════
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const D = { el: null, files: [], pts: [], stats: [], picker: null, sessions: [], sel: new Set(), gapH: 2, mode: 'gap', dest: 'mine', area: false, busy: false };
  const hash = t => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
  const toast = m => { const A = root._pjApi; if (A && A.toast) A.toast(m); else console.log('[waypoints]', m); };
  const projectOpen = () => !!(root._pj && root._pj.pid);
  const $ = s => D.el && D.el.querySelector(s);

  function open() {
    if (D.el) { D.el.hidden = false; return D.el; }
    const el = D.el = document.createElement('div');
    el.id = 'wpt-dlg'; el.className = 'wpt-dlg';
    el.innerHTML = `<div class="wpt-h"><b>Import waypoints by session</b><button type="button" class="wpt-x" title="Close">✕</button></div>
      <div class="wpt-b">
        <div class="wpt-r"><button type="button" class="wpt-pick">Choose file(s)…</button> <span class="wpt-files">GPX, KML or GeoJSON (Gaia GPS and others)</span></div>
        <div class="wpt-prog" hidden><div></div></div>
        <div class="wpt-note wpt-stat"></div>
        <div class="wpt-r"><label><input type="radio" name="wpt-area" value="all" checked class="keep-box"> All points</label>
          <label><input type="radio" name="wpt-area" value="area" class="keep-box"> Only inside the area: <span class="wpt-an">the current Analyze area, or the one chosen below</span></label></div>
        <div class="wpt-picker"></div>
        <div class="wpt-r"><label><input type="radio" name="wpt-mode" value="gap" checked class="keep-box"> Sessions: new one after a gap of</label>
          <input type="range" class="wpt-gap" min="0.5" max="6" step="0.5" value="2"> <b class="wpt-gapv">2 h</b>
          <label><input type="radio" name="wpt-mode" value="day" class="keep-box"> One per day</label></div>
        <div class="wpt-r"><label><input type="checkbox" class="wpt-dd keep-box" checked> Merge doubles (same name within 3 m)</label></div>
        <div class="wpt-sum wpt-note"></div>
        <div class="wpt-r"><button type="button" class="wpt-all">All</button><button type="button" class="wpt-none">None</button></div>
        <div class="wpt-list"></div>
        <div class="wpt-r"><label>Into <select class="wpt-dest"><option value="mine">My data</option><option value="project">the open project</option></select></label>
          <button type="button" class="wpt-go" disabled>Import</button></div>
        <div class="wpt-note wpt-msg"></div>
      </div>`;
    document.body.appendChild(el);
    $('.wpt-x').onclick = () => { el.hidden = true; if (D.picker && D.picker.clear) try { D.picker.clear(); } catch (_) {} };
    $('.wpt-pick').onclick = pickFiles;
    el.querySelectorAll('[name=wpt-area]').forEach(r => r.onchange = () => { D.area = el.querySelector('[name=wpt-area]:checked').value === 'area'; recompute(); });
    el.querySelectorAll('[name=wpt-mode]').forEach(r => r.onchange = () => { D.mode = el.querySelector('[name=wpt-mode]:checked').value; recompute(); });
    $('.wpt-gap').oninput = e => { D.gapH = +e.target.value; $('.wpt-gapv').textContent = D.gapH + ' h'; recompute(); };
    $('.wpt-dd').onchange = recompute;
    $('.wpt-all').onclick = () => { D.sel = new Set(D.sessions.map(s => s.id)); drawList(); };
    $('.wpt-none').onclick = () => { D.sel = new Set(); drawList(); };
    $('.wpt-dest').onchange = e => { D.dest = e.target.value; };
    $('.wpt-go').onclick = doImport;
    if (root._areaPicker) D.picker = root._areaPicker.create({ host: $('.wpt-picker'), hasFootprint: projectOpen, onChange: () => { if (D.area) recompute(); } });
    const c0 = root._areas && root._areas.current && root._areas.current();
    if (c0 && c0.ring) { D.area = true; el.querySelector('[name=wpt-area][value=area]').checked = true; $('.wpt-an').textContent = '“' + (c0.name || 'current area') + '” (Analyze by area)'; }
    syncDest();
    return el;
  }
  function syncDest() { const s = $('.wpt-dest'); if (!s) return; s.querySelector('[value=project]').disabled = !projectOpen(); if (!projectOpen() && s.value === 'project') s.value = 'mine'; D.dest = s.value; }
  function pickFiles() {
    const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = '.gpx,.kml,.json,.geojson,application/gpx+xml,application/json';
    i.onchange = () => loadFiles([...i.files]); i.click();
  }
  async function loadFiles(files, text) {
    open(); D.files = []; D.pts = []; D.stats = [];
    const bar = $('.wpt-prog'), fill = bar.firstElementChild; bar.hidden = false; $('.wpt-go').disabled = true;
    try {
      for (let k = 0; k < files.length; k++) {
        const f = files[k]; $('.wpt-msg').textContent = 'Reading ' + f.name + '…';
        const txt = text != null ? text : await f.text();
        const r = await parseAsync(txt, f.name, p => { fill.style.width = Math.round(((k + p) / files.length) * 100) + '%'; });
        D.files.push(f.name); D.stats.push(r.stats); for (const p of r.points) D.pts.push(p);
      }
      $('.wpt-msg').textContent = '';
    } catch (e) { $('.wpt-msg').textContent = 'Could not read it: ' + (e.message || e); }
    bar.hidden = true;
    $('.wpt-files').textContent = D.files.join(', ') || 'none';
    $('.wpt-stat').textContent = D.stats.map(s => `${s.file}: ${s.points} waypoints (${s.format.toUpperCase()})` + (s.tracks || s.routes ? `; ${s.tracks} tracks and ${s.routes} routes ignored` : '') + (s.skipped ? `; ${s.skipped} skipped (no usable point)` : '')).join('  |  ');
    recompute();
  }
  /** The ring to keep points in: the current area of Analyze by area (window._areas), else the area picker's. */
  function areaRing() {
    const c = root._areas && root._areas.current && root._areas.current();
    if (c && c.ring && c.ring.length >= 3) return c.ring;
    const a = D.picker && D.picker.area && D.picker.area(); return a && a.polygon ? a.polygon : null;
  }
  function recompute() {
    if (!D.el) return;
    const ring = D.area ? areaRing() : null;
    if (D.area && !ring) $('.wpt-msg').textContent = 'No area chosen yet: draw or pick one above, or switch to All points.'; else if ($('.wpt-msg').textContent.startsWith('No area')) $('.wpt-msg').textContent = '';
    let pts = D.area ? (ring ? filterRing(D.pts, ring) : []) : D.pts;
    const before = pts.length; if ($('.wpt-dd').checked) pts = dedupe(pts);
    D.sessions = D.mode === 'day' ? sessionsByDay(pts) : sessionsByGap(pts, D.gapH * 3600e3);
    const keep = new Set(D.sessions.map(s => s.id)); D.sel = new Set([...D.sel].filter(x => keep.has(x)));
    $('.wpt-sum').textContent = `${D.pts.length} read, ${before} in the choice` + (before !== pts.length ? `, ${pts.length} after merging doubles` : '') + `; ${D.sessions.length} session${D.sessions.length === 1 ? '' : 's'}.`;
    drawList();
  }
  function drawList() {
    const list = $('.wpt-list'), shown = D.sessions.slice(0, 400);
    list.innerHTML = shown.map(s => `<label class="wpt-s${s.long ? ' wpt-long' : ''}"><input type="checkbox" class="keep-box" data-sid="${esc(s.id)}"${D.sel.has(s.id) ? ' checked' : ''}>
      <span><b>${esc(s.name)}</b>${s.long ? ' <em title="Longer than 12 hours: probably more than one trip">over 12 h</em>' : ''}<br><small>${s.box.spreadM >= 1000 ? (s.box.spreadM / 1000).toFixed(1) + ' km' : s.box.spreadM + ' m'} across; ${esc(s.points.slice(0, 4).map(p => p.name || '(no name)').join(', '))}${s.points.length > 4 ? ', …' : ''}</small></span></label>`).join('')
      + (D.sessions.length > shown.length ? `<div class="wpt-note">…and ${D.sessions.length - shown.length} more (tighten the area).</div>` : '');
    list.querySelectorAll('input[data-sid]').forEach(i => i.onchange = () => { if (i.checked) D.sel.add(i.dataset.sid); else D.sel.delete(i.dataset.sid); upd(); });
    upd();
  }
  function upd() { const n = D.sessions.filter(s => D.sel.has(s.id)).reduce((a, s) => a + s.count, 0); const b = $('.wpt-go'); b.disabled = !n || D.busy; b.textContent = n ? `Import ${n} point${n === 1 ? '' : 's'}` : 'Import'; }

  /** The height rule of height-model.js / project-features.js: ground measured once and kept as the height, the file's own beside it. */
  async function heights(items) {
    const HM = root._heightModel, withFile = it => (it.fileH != null ? { fileH: +it.fileH.toFixed(2) } : {});
    const ms = HM && HM.stampMany ? await HM.stampMany(items.map(it => [it.lon, it.lat])) : [];
    items.forEach((it, i) => { const m = ms[i]; if (m && HM) { it.coords = [[it.lon, it.lat, +m.h.toFixed(2)]]; it.hsrc = Object.assign(HM.ground(m.t), withFile(it)); } else it.coords = [[it.lon, it.lat, it.fileH != null ? it.fileH : 0]]; });
  }
  const SYM = [[/car|park|trailhead|trail head/i, 'parking'], [/cave|pit|hole|sink|entrance|dig/i, 'cave'], [/camp/i, 'camp'], [/water|spring/i, 'water'], [/summit|peak/i, 'summit']];
  const symOf = s => { const x = SYM.find(r => r[0].test(s || '')); return x ? x[1] : ''; };
  function describeText(p) {
    const L = []; if (p.note) L.push(p.note);
    if (p.time != null) L.push('Time: ' + dateOf(p.time) + ' ' + clock(p.time) + (p.timeRaw ? ' (' + p.timeRaw + ')' : '')); else if (p.timeRaw) L.push('Time: ' + p.timeRaw);
    if (p.ele != null) L.push('Elevation in the file: ' + p.ele + ' m');
    if (p.sym) L.push('Symbol: ' + p.sym); if (p.type) L.push('Type: ' + p.type);
    L.push('From: ' + p.src.file + ' #' + p.src.id);
    return L.join('\n');
  }
  async function doImport() {
    const sess = D.sessions.filter(s => D.sel.has(s.id)); if (!sess.length) return;
    syncDest(); D.busy = true; upd();
    const msg = $('.wpt-msg'), file = (D.files.length === 1 ? D.files[0] : D.files.length + ' files').replace(/\.[^.]+$/, '');
    const top = 'Waypoints ' + file;
    try {
      const items = [];
      sess.forEach(s => s.points.forEach(p => items.push({ p, s, lon: p.lon, lat: p.lat, fileH: p.ele })));
      msg.textContent = `Measuring the ground under ${items.length} points…`;
      await heights(items);
      const mk1 = it => {
        const p = it.p, sym = symOf(p.sym + ' ' + p.name);
        const orig = { src: p.src, name: p.name, desc: p.desc, cmt: p.cmt, time: p.timeRaw, ele: p.ele, sym: p.sym, type: p.type, ext: p.ext, props: p.props, merged: p.dups || [], n: p.n, lon: p.lon, lat: p.lat };
        return { id: hash(p.src.file + '|' + p.src.id + '|' + p.lon + '|' + p.lat), kind: 'point', coords: it.coords, hsrc: it.hsrc, name: String(p.name || 'Waypoint').slice(0, 120), desc: describeText(p).slice(0, 4000),
          style: Object.assign({ wpt: { file: p.src.file, id: p.src.id, time: p.time, timeRaw: p.timeRaw } }, sym ? { symbol: sym } : {}), orig, path: it.s.name };
      };
      const built = items.map(mk1);
      if (D.dest === 'project' && projectOpen()) {
        const A = root._pjApi, FL = A.FL, q = { quiet: true }, gTop = FL.uid(10), gs = new Map();
        await A.record('group.set', { group: gTop, name: top.slice(0, 80), parent: '' }, null, q);
        for (const b of built) {
          if (!gs.has(b.path)) { const g = FL.uid(10); await A.record('group.set', { group: g, name: b.path.slice(0, 80), parent: gTop }, null, q); gs.set(b.path, g); }
          await A.record('feature.set', { feature: FL.uid(12), kind: 'point', coords: b.coords, name: b.name, desc: b.desc, group: gs.get(b.path), style: b.style, orig: b.orig, hsrc: b.hsrc || undefined }, null, q);
        }
        A.refresh('feature.set');
      } else {
        await root._myData.adopt(built.map(b => Object.assign({}, b, { group: top + ' / ' + b.path })));
        if (root._surfCols && root._surfCols.refresh) try { root._surfCols.refresh(); } catch (_) {}
      }
      msg.textContent = `Imported ${built.length} points in ${sess.length} session${sess.length === 1 ? '' : 's'} into “${top}”.`;
      toast(msg.textContent); root.dispatchEvent(new CustomEvent('flex-waypoints-imported', { detail: { count: built.length, sessions: sess.length, dest: D.dest } }));
    } catch (e) { console.warn('[waypoints]', e); msg.textContent = 'Import failed: ' + (e.message || e); }
    D.busy = false; upd();
  }
  root._wptDialog = { open, loadFiles, state: D, recompute };

  const css = document.createElement('style');
  css.textContent = `
  .wpt-dlg { position: fixed; right: 12px; top: 56px; bottom: 12px; width: 400px; max-width: calc(100vw - 24px); z-index: 9500; background: rgba(20,24,22,.97); color: #e8ece9; border: 1px solid #3a4440; border-radius: 8px; display: flex; flex-direction: column; font-size: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  .wpt-dlg[hidden] { display: none; }
  .wpt-h { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid #333; }
  .wpt-x { background: none; border: 0; color: inherit; cursor: pointer; font-size: 14px; }
  .wpt-b { padding: 8px 10px; overflow: auto; display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .wpt-r { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .wpt-dlg button { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.18); color: #e8ece9; border-radius: 5px; padding: 3px 9px; cursor: pointer; font-size: 11.5px; }
  .wpt-dlg button:disabled { opacity: .45; cursor: default; }
  .wpt-dlg select { background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; }
  .wpt-note { color: rgba(255,255,255,.62); font-size: 11px; line-height: 1.35; }
  .wpt-prog { height: 5px; background: #333; border-radius: 3px; } .wpt-prog[hidden] { display: none; } .wpt-prog div { height: 100%; width: 0; background: #6fd39a; border-radius: 3px; }
  .wpt-list { flex: 1; min-height: 120px; overflow: auto; border: 1px solid #333; border-radius: 5px; }
  .wpt-s { display: flex; gap: 7px; padding: 4px 6px; border-bottom: 1px solid #2a2f2c; cursor: pointer; align-items: flex-start; }
  .wpt-s small { color: rgba(255,255,255,.55); } .wpt-long em { color: #ffb020; font-style: normal; font-size: 10.5px; }`;
  document.head.appendChild(css);
})(typeof window !== 'undefined' ? window : null);
