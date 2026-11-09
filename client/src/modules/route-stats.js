// route-stats.js — the numbers behind a line's and a point's detail in the info panel
// (info-panel.js): a height graph along a line, stats and walking times, the points on
// the way, what the ends connect to; the nearest points and lines to a point.
//
// Two halves in one file:
//   pure   no window, no Cesium: resample a line, climb and descent, the steepest stretch,
//          Tobler's and Naismith's walking times, distance from a point to a line (not its
//          vertices), points along a line, nearest things, bearings. module.exports under
//          Node (tools/test_route_stats.js).
//   browser  window._routeStats.routeNode(opts): the graph (SVG), the stats table, the
//          points on the way, the ends. Heights come from the globe's terrain
//          (sampleTerrainMostDetailed, or level 14 where the provider has no availability,
//          as cave-ground.js does), the LiDAR ground from window._lidarGroundAt. Cached per
//          line; the terrain cache is dropped on 'flex-terrain-changed'. The caller
//          (info-panel.js) says what points and lines exist; nothing here reads a project.
//
// Distances are metres; a spot is [lon, lat]; a line is [[lon, lat, h?, time?]…].
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root._routeStats = M.browser(root, M);
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const R = 6371008.8, RAD = Math.PI / 180;
  const PTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  // ── Geometry ─────────────────────────────────────────────────────────────
  function segLen(a, b) {
    const dl = (b[0] - a[0]) * RAD, dn = (b[1] - a[1]) * RAD, m = (a[1] + b[1]) / 2 * RAD;
    return R * Math.hypot(dl * Math.cos(m), dn);
  }
  /** Distance along the line at each vertex: [0, …, length]. */
  function cumulative(coords) {
    const c = [0];
    for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + segLen(coords[i - 1], coords[i]));
    return c;
  }
  function lengthOf(coords) { const c = cumulative(coords); return c.length ? c[c.length - 1] : 0; }
  /** The spacing the height graph uses: about every 5 m, or length / 400 on long lines. */
  const sampleSpacing = length => Math.max(5, length / 400);
  /** Spots at equal steps along the line, ends included: { length, samples: [{ d, lon, lat }] }. */
  function resample(coords, spacing) {
    if (!coords || !coords.length) return { length: 0, samples: [] };
    const cum = cumulative(coords), L = cum[cum.length - 1];
    if (coords.length === 1 || !(L > 0)) return { length: 0, samples: [{ d: 0, lon: coords[0][0], lat: coords[0][1] }] };
    const n = Math.max(1, Math.ceil(L / Math.max(spacing || 5, 1e-6))), samples = [];
    let j = 1;
    for (let i = 0; i <= n; i++) {
      const d = i * L / n;
      while (j < cum.length - 1 && cum[j] < d) j++;
      const a = coords[j - 1], b = coords[j], sl = cum[j] - cum[j - 1];
      const t = sl > 0 ? Math.min(1, Math.max(0, (d - cum[j - 1]) / sl)) : 0;
      samples.push({ d, lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t });
    }
    return { length: L, samples };
  }
  /** Distance (m) and initial bearing (° from north) from a to b. */
  function distBrg(a, b) {
    const p1 = a[1] * RAD, p2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
    const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return { d: 2 * R * Math.asin(Math.min(1, Math.sqrt(h))), brg: (Math.atan2(y, x) / RAD + 360) % 360 };
  }
  /** "SE (128°)" */
  const compassText = b => `${PTS[Math.round(b / 45) % 8]} (${Math.round(b) % 360}°)`;
  /**
   * The nearest spot of a line to a point (the line itself, not its vertices):
   * { d: metres, along: metres from the line's start, at: [lon, lat], seg, t }.
   */
  function distToPolyline(p, coords, cum) {
    if (!coords || !coords.length) return null;
    const k = Math.cos(p[1] * RAD) * R * RAD, kk = R * RAD;
    const xy = c => [(c[0] - p[0]) * k, (c[1] - p[1]) * kk];
    if (coords.length === 1) { const a = xy(coords[0]); return { d: Math.hypot(a[0], a[1]), along: 0, at: [coords[0][0], coords[0][1]], seg: 0, t: 0 }; }
    cum = cum || cumulative(coords);
    let best = null, a = xy(coords[0]);
    for (let i = 1; i < coords.length; i++) {
      const b = xy(coords[i]), dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.min(1, Math.max(0, -(a[0] * dx + a[1] * dy) / l2)) : 0;
      const d = Math.hypot(a[0] + dx * t, a[1] + dy * t);
      if (!best || d < best.d) best = { d, seg: i - 1, t };
      a = b;
    }
    const s = best.seg, c0 = coords[s], c1 = coords[s + 1];
    best.at = [c0[0] + (c1[0] - c0[0]) * best.t, c0[1] + (c1[1] - c0[1]) * best.t];
    best.along = cum[s] + (cum[s + 1] - cum[s]) * best.t;
    return best;
  }
  /** Points (each with .at = [lon, lat, …]) within maxM of the line, by distance along it: [{ pt, d, along, at }]. */
  function pointsAlong(pts, coords, maxM) {
    const cum = cumulative(coords), out = [];
    pts.forEach(pt => {
      const r = distToPolyline(pt.at, coords, cum);
      if (r && r.d <= maxM) out.push({ pt, d: r.d, along: r.along, at: r.at });
    });
    return out.sort((a, b) => a.along - b.along || a.d - b.d);
  }
  /** The n nearest points to p: [{ pt, d, brg }]. skip(pt) → true leaves one out. */
  function nearestPoints(p, pts, n, skip) {
    const out = [];
    pts.forEach(pt => { if (skip && skip(pt)) return; const db = distBrg(p, pt.at); out.push({ pt, d: db.d, brg: db.brg }); });
    return out.sort((a, b) => a.d - b.d).slice(0, n);
  }
  /** The n nearest lines to p, by the distance to the line itself; brg points at its nearest spot: [{ line, d, brg, along, at }]. */
  function nearestLines(p, lines, n, skip) {
    const out = [];
    lines.forEach(line => {
      if (skip && skip(line)) return;
      const r = distToPolyline(p, line.coords); if (!r) return;
      out.push({ line, d: r.d, brg: r.d > 0.01 ? distBrg(p, r.at).brg : 0, along: r.along, at: r.at });
    });
    return out.sort((a, b) => a.d - b.d).slice(0, n);
  }
  /** What is within maxM of a spot: points and lines, nearest first: [{ kind: 'point' | 'line', item, d }]. */
  function connections(p, pts, lines, maxM, skipLine) {
    const out = [];
    nearestPoints(p, pts, 5, null).forEach(x => { if (x.d <= maxM) out.push({ kind: 'point', item: x.pt, d: x.d }); });
    nearestLines(p, lines, 5, skipLine).forEach(x => { if (x.d <= maxM) out.push({ kind: 'line', item: x.line, d: x.d }); });
    return out.sort((a, b) => a.d - b.d);
  }

  // ── Profiles ─────────────────────────────────────────────────────────────
  /** Fill holes (null / NaN) by straight lines between the known heights; null if none is known. */
  function fillGaps(hs) {
    const ok = hs.map(h => Number.isFinite(h));
    if (!ok.some(Boolean)) return null;
    const out = hs.slice();
    let last = -1;
    for (let i = 0; i < hs.length; i++) {
      if (!ok[i]) continue;
      if (last < 0) for (let j = 0; j < i; j++) out[j] = hs[i];
      else for (let j = last + 1; j < i; j++) out[j] = hs[last] + (hs[i] - hs[last]) * (j - last) / (i - last);
      last = i;
    }
    for (let j = last + 1; j < hs.length; j++) out[j] = hs[last];
    return out;
  }
  /** Moving average over 2 * k + 1 samples (ends use what is there). */
  function smooth(hs, k) {
    if (!k) return hs.slice();
    return hs.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - k); j <= Math.min(hs.length - 1, i + k); j++) { s += hs[j]; n++; } return s / n; });
  }
  /** Climb and descent (m) along heights hs; opts.smooth: averaging radius in samples (default 0). */
  function climbDescent(hs, opts) {
    const h = smooth(hs, (opts && opts.smooth) || 0);
    let climb = 0, descent = 0;
    for (let i = 1; i < h.length; i++) { const dh = h[i] - h[i - 1]; if (dh > 0) climb += dh; else descent -= dh; }
    return { climb, descent, min: h.length ? Math.min(...h) : null, max: h.length ? Math.max(...h) : null };
  }
  /**
   * The steepest stretch at least win metres long (the whole line if shorter):
   * { grade (rise / run, signed), pct, deg, d0, d1, at } or null.
   */
  function steepest(ds, hs, win) {
    const n = ds.length;
    if (n < 2) return null;
    const total = ds[n - 1] - ds[0];
    if (!(total > 0)) return null;
    win = Math.min(win || 30, total);
    let best = null, j = 0;
    for (let i = 0; i < n - 1; i++) {
      if (j < i) j = i;
      while (j < n - 1 && ds[j] - ds[i] < win - 1e-9) j++;
      const run = ds[j] - ds[i];
      if (run < win - 1e-6) break;                       // the rest is shorter than the window
      const g = (hs[j] - hs[i]) / run;
      if (!best || Math.abs(g) > Math.abs(best.grade)) best = { grade: g, d0: ds[i], d1: ds[j] };
    }
    if (!best) return null;
    best.pct = best.grade * 100; best.deg = Math.atan(best.grade) / RAD; best.at = (best.d0 + best.d1) / 2;
    return best;
  }
  /**
   * Tobler's hiking function, seconds: speed = 6 · exp(−3.5 · |slope + 0.05|) km/h along the
   * ground (5.04 km/h on the flat, fastest on a gentle downhill), summed over the steps.
   */
  function tobler(ds, hs) {
    let t = 0;
    for (let i = 1; i < ds.length; i++) {
      const dd = ds[i] - ds[i - 1], dh = hs[i] - hs[i - 1];
      if (!(dd > 0)) continue;
      const v = 6 * Math.exp(-3.5 * Math.abs(dh / dd + 0.05)) / 3.6;      // m/s
      t += Math.hypot(dd, dh) / v;
    }
    return t;
  }
  /** Naismith's rule, seconds: 5 km/h on the flat plus 10 minutes for each 100 m climbed. */
  const naismith = (length, climb) => length / 5000 * 3600 + climb / 100 * 600;
  /** Times of a track: from coords[i][3] (ms, or seconds since 1970) or a list; → ms[] | null if fewer than two. */
  function timesOf(coords, extra) {
    const ms = t => {
      if (t == null || t === '') return null;
      if (typeof t === 'number') return !Number.isFinite(t) ? null : t > 1e11 ? t : t > 1e8 ? t * 1000 : null;
      const d = Date.parse(t); return Number.isNaN(d) ? null : d;
    };
    let ts = Array.isArray(extra) && extra.length ? extra.map(ms) : (coords || []).map(c => ms(c && c[3]));
    return ts.filter(t => t != null).length >= 2 ? ts : null;
  }
  /** { seconds, start (ms) } between the first and last time, or null. */
  function recorded(ts) {
    const v = (ts || []).filter(t => Number.isFinite(t));
    if (v.length < 2) return null;
    const a = Math.min(...v), b = Math.max(...v);
    return b > a ? { seconds: (b - a) / 1000, start: a } : null;
  }

  const pure = { segLen, cumulative, lengthOf, sampleSpacing, resample, distBrg, compassText, distToPolyline, pointsAlong,
    nearestPoints, nearestLines, connections, fillGaps, smooth, climbDescent, steepest, tobler, naismith, timesOf, recorded };

  // ── Browser: the route section ───────────────────────────────────────────
  function browser(w, P) {
    const Cs = () => w.Cesium, V = () => w.cesiumViewer;
    const U = () => w._units || { len: m => Math.round(m) + ' m', dist: m => Math.round(m) + ' m', height: m => m.toFixed(1) + ' m', climb: m => Math.round(m) + ' m', duration: s => Math.round(s / 60) + ' min' };
    const RADII = [10, 25, 50], RKEY = 'flex.route.radius';
    const getRadius = () => { try { const r = +w.localStorage.getItem(RKEY); return RADII.includes(r) ? r : 10; } catch (_) { return 10; } };
    const setRadius = r => { try { w.localStorage.setItem(RKEY, String(r)); } catch (_) {} };
    const mk = (tag, cls, text) => { const e = w.document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const sv = (tag, at) => { const e = w.document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in at || {}) e.setAttribute(k, at[k]); return e; };

    // Terrain: sampled in one go per line, kept until the terrain changes.
    const tCache = new Map();
    w.addEventListener('flex-terrain-changed', () => tCache.clear());
    const sig = (coords, step) => {
      let s = 0; coords.forEach((c, i) => { s = (s * 31 + Math.round(c[0] * 1e6) * 7 + Math.round(c[1] * 1e6) * 13 + i) % 2147483647; });
      return coords.length + '|' + s + '|' + step.toFixed(2);
    };
    function sampleTerrain(samples) {
      const v = V(), C = Cs();
      if (!v || !C) return Promise.resolve(samples.map(() => null));
      const done = r => samples.map((_, i) => { const h = r && r[i] && r[i].height; return Number.isFinite(h) ? h : null; });
      let p;
      try {
        const tp = v.terrainProvider, ks = samples.map(s => C.Cartographic.fromDegrees(s.lon, s.lat));
        p = Promise.resolve(tp.availability ? C.sampleTerrainMostDetailed(tp, ks) : C.sampleTerrain(tp, 14, ks)).then(done, () => null);
      } catch (_) { p = Promise.resolve(null); }
      return Promise.race([p, new Promise(r => setTimeout(() => r(null), 20000))]).then(r => r || samples.map(() => null));
    }
    function profileOf(coords) {
      const len = P.lengthOf(coords), step = sampleSpacing(len), k = sig(coords, step);
      if (tCache.has(k)) return tCache.get(k);
      const rs = P.resample(coords, step);
      const p = sampleTerrain(rs.samples).then(h => ({ length: rs.length, step, samples: rs.samples, terrain: h }));
      tCache.set(k, p);
      p.then(x => { if (x.terrain.every(h => h == null)) tCache.delete(k); });
      return p;
    }
    /** The LiDAR ground at about every tenth of the way (a few at a time: each look scans the loaded clouds). */
    function lidarOf(samples) {
      const f = w._lidarGroundAt;
      if (typeof f !== 'function') return Promise.resolve(null);
      const out = samples.map(() => null), stride = Math.max(1, Math.ceil(samples.length / 120));
      const idx = []; for (let i = 0; i < samples.length; i += stride) idx.push(i);
      if ((samples.length - 1) % stride) idx.push(samples.length - 1);
      return new Promise(res => {
        let at = 0;
        const next = () => {
          const t0 = Date.now();
          while (at < idx.length && Date.now() - t0 < 25) {
            const i = idx[at++];
            try { const g = f(samples[i].lon, samples[i].lat); if (g && Number.isFinite(g.h)) out[i] = g.h; } catch (_) {}
          }
          if (at < idx.length) setTimeout(next, 0);
          else res(out.some(h => h != null) ? { h: out, stride } : null);
        };
        next();
      });
    }

    // The yellow dot on the map that follows the pointer over the graph.
    let hov = null;
    function setHover(lon, lat) {
      const v = V(), C = Cs(); if (!v || !C) return;
      const pos = window._groundH ? window._groundH.pos(lon, lat).pos : C.Cartesian3.fromDegrees(lon, lat, 0);       // on the ground (ground-height.js), no Cesium clamping
      if (!hov || !v.entities.contains(hov)) {
        hov = v.entities.add({ id: 'route-hover', position: pos, properties: { isRouteHover: true },
          point: { pixelSize: 10, color: C.Color.fromCssColorString('#ffe600'), outlineColor: C.Color.BLACK, outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      } else hov.position = pos;
    }
    function clearHover() { const v = V(); if (hov && v && v.entities.contains(hov)) v.entities.remove(hov); hov = null; }

    /**
     * The section for a line. o: { coords, times?, points: [{ name, at, … }], lines: [{ name, coords }] (not this one),
     * open(point), entrance(point) → text | null }.
     */
    function routeNode(o) {
      const root = mk('div', 'rs'), coords = o.coords;
      root.appendChild(mk('div', 'inf-h', 'Route'));
      const graph = mk('div', 'rs-graph', 'Reading heights…'); root.appendChild(graph);
      const tip = mk('div', 'rs-tip', ''); root.appendChild(tip);
      const stats = mk('table', 'inf-facts rs-stats'); root.appendChild(stats);
      const rad = mk('div', 'rs-rad'); root.appendChild(rad);
      const way = mk('div', 'rs-way'); root.appendChild(way);
      const note = mk('div', 'rs-note', ''); root.appendChild(note);
      let prof = null, lid = null, radius = getRadius(), hs = null, source = 'terrain';
      const row = (k, v, title) => { const r = mk('tr'), td = mk('td'); if (v instanceof w.Node) td.appendChild(v); else td.textContent = v; const th = mk('th', null, k); if (title) th.title = title; r.append(th, td); stats.appendChild(r); return r; };

      // Start and end, and what they touch.
      const ends = () => {
        const rows = [['Start', coords[0]], ['End', coords[coords.length - 1]]];
        const self = rows.map(([k, p]) => {
          const near = P.connections([p[0], p[1]], o.points || [], o.lines || [], 30);
          const txt = near.slice(0, 4).map(c => {
            const ent = c.kind === 'point' && o.entrance ? o.entrance(c.item) : null;
            return `${c.item.name || (c.kind === 'line' ? 'Line' : 'Point')}${c.kind === 'line' ? ' (line)' : ent ? ' (' + ent + ')' : ''} ${U().dist(c.d)}`;
          });
          return [k, txt.length ? txt.join(' · ') : 'nothing within ' + U().len(30)];
        });
        return self;
      };

      // On the way: the markers on the graph and the list.
      function wayList() { return P.pointsAlong(o.points || [], coords, radius); }
      function paintWay() {
        rad.textContent = '';
        rad.appendChild(mk('span', 'rs-rad-l', 'Points within'));
        RADII.forEach(r => {
          const b = mk('button', 'rs-rad-b' + (r === radius ? ' on' : ''), U().len(r)); b.type = 'button'; b.dataset.radius = r;
          b.addEventListener('click', () => { radius = r; setRadius(r); paintWay(); drawGraph(); });
          rad.appendChild(b);
        });
        way.textContent = '';
        const list = wayList();
        way.appendChild(w.document.createTextNode('On the way: '));
        if (!list.length) way.appendChild(w.document.createTextNode('nothing within ' + U().len(radius)));
        list.forEach((x, i) => {
          if (i) way.appendChild(w.document.createTextNode(' · '));
          const b = mk('button', 'rs-way-b', x.pt.name || 'Point'); b.type = 'button';
          b.title = `${U().len(x.along)} along, ${U().dist(x.d)} from the line`;
          b.addEventListener('click', () => o.open && o.open(x.pt));
          way.appendChild(b);
        });
      }

      // The graph.
      const W = 420, H = 150, L = 40, Rr = 8, T = 10, B = 18;
      function drawGraph() {
        graph.textContent = '';
        if (!prof || !hs) return;
        const ds = prof.samples.map(s => s.d), total = prof.length || 1;
        const lh = lid ? lid.h : null;
        const all = hs.concat(lh ? lh.filter(h => h != null) : []);
        let lo = Math.min(...all), hi = Math.max(...all);
        if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
        const X = d => L + (d / total) * (W - L - Rr), Y = h => T + (1 - (h - lo) / (hi - lo)) * (H - T - B);
        const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rs-svg', role: 'img', 'aria-label': 'Height along the line' });
        const txt = (x, y, s, anchor) => { const t = sv('text', { x, y, class: 'rs-ax', 'text-anchor': anchor || 'start' }); t.textContent = s; svg.appendChild(t); };
        svg.appendChild(sv('line', { x1: L, y1: H - B, x2: W - Rr, y2: H - B, class: 'rs-axis' }));
        svg.appendChild(sv('line', { x1: L, y1: T, x2: L, y2: H - B, class: 'rs-axis' }));
        txt(L - 4, T + 6, U().height(hi).replace(/\.\d/, ''), 'end'); txt(L - 4, H - B, U().height(lo).replace(/\.\d/, ''), 'end');
        txt(L, H - 4, '0'); txt(W - Rr, H - 4, U().len(total), 'end');
        // The steepest stretch, behind the lines.
        if (prof.steep) svg.appendChild(sv('rect', { x: X(prof.steep.d0), y: T, width: Math.max(2, X(prof.steep.d1) - X(prof.steep.d0)), height: H - T - B, class: 'rs-steep-band' }));
        const path = (vals, ds2, cls) => {
          let d = '', pen = false;
          vals.forEach((h, i) => { if (h == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(ds2[i]).toFixed(1) + ' ' + Y(h).toFixed(1); pen = true; });
          if (d) svg.appendChild(sv('path', { d, class: cls }));
        };
        path(hs, ds, 'rs-terrain');
        if (lh) {                                            // LiDAR is read at some samples only: join those
          const ix = lh.map((h, i) => (h != null ? i : -1)).filter(i => i >= 0);
          path(ix.map(i => lh[i]), ix.map(i => ds[i]), 'rs-lidar');
        }
        if (prof.steep) {
          const i0 = ds.findIndex(d => d >= prof.steep.d0), i1 = ds.findIndex(d => d >= prof.steep.d1);
          path(hs.map((h, i) => (i >= i0 && i <= (i1 < 0 ? ds.length - 1 : i1) ? h : null)), ds, 'rs-steep');
        }
        // Hover.
        const cross = sv('line', { y1: T, y2: H - B, class: 'rs-cross', visibility: 'hidden' }); svg.appendChild(cross);
        const dot = sv('circle', { r: 3.5, class: 'rs-dot', visibility: 'hidden' }); svg.appendChild(dot);
        const over = sv('rect', { x: L, y: T, width: W - L - Rr, height: H - T - B, class: 'rs-over' }); svg.appendChild(over);
        const at = ev => {
          const r = svg.getBoundingClientRect();
          const px = (ev.clientX - r.left) / r.width * W;
          const d = Math.min(total, Math.max(0, (px - L) / (W - L - Rr) * total));
          let i = Math.round(d / total * (ds.length - 1)); i = Math.max(0, Math.min(ds.length - 1, i));
          return i;
        };
        over.addEventListener('pointermove', ev => {
          const i = at(ev), s = prof.samples[i], h = hs[i];
          let l = null;                                      // the LiDAR value nearest this sample (it is read at some only)
          if (lh) for (let k = 0; k <= lid.stride && l == null; k++) { const a = lh[i - k], b = lh[i + k]; l = a != null ? a : b != null ? b : null; }
          cross.setAttribute('x1', X(s.d)); cross.setAttribute('x2', X(s.d)); cross.setAttribute('visibility', 'visible');
          dot.setAttribute('cx', X(s.d)); dot.setAttribute('cy', Y(h)); dot.setAttribute('visibility', 'visible');
          const j0 = Math.max(0, i - 1), j1 = Math.min(ds.length - 1, i + 1), g = ds[j1] > ds[j0] ? (hs[j1] - hs[j0]) / (ds[j1] - ds[j0]) * 100 : 0;
          tip.textContent = `${U().len(s.d)} along · ${U().height(h)}${source === 'terrain' ? ' terrain' : ''}${l != null ? ' · LiDAR ground ' + U().height(l) : ''} · ${g >= 0 ? '+' : ''}${g.toFixed(0)}%`;
          setHover(s.lon, s.lat);
        });
        over.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.textContent = HINT; clearHover(); });
        // The points on the way, on top so they can be clicked.
        wayList().forEach(x => {
          const g = sv('g', { class: 'rs-pt', 'data-name': x.pt.name || '' });
          const cx = X(x.along);
          g.appendChild(sv('line', { x1: cx, x2: cx, y1: T, y2: H - B, class: 'rs-pt-l' }));
          const c = sv('circle', { cx, cy: H - B, r: 5, class: 'rs-pt-c' }); g.appendChild(c);
          const t = sv('title'); t.textContent = `${x.pt.name || 'Point'} · ${U().len(x.along)} along, ${U().dist(x.d)} from the line`; g.appendChild(t);
          g.addEventListener('click', () => o.open && o.open(x.pt));
          svg.appendChild(g);
        });
        graph.appendChild(svg);
        const lg = mk('div', 'rs-legend');
        lg.innerHTML = '<span class="rs-k t"></span> ' + (source === 'terrain' ? 'Terrain' : 'Heights recorded in the track') + (lh ? ' <span class="rs-k l"></span> LiDAR ground' : '') + (prof.steep ? ' <span class="rs-k s"></span> Steepest stretch' : '') + (wayList().length ? ' <span class="rs-k p"></span> Point on the way' : '');
        graph.appendChild(lg);
        tip.textContent = HINT;
      }
      const HINT = 'Hover the graph for distance and height; click a dot to open the point.';

      paintWay();
      ends().forEach(([k, v]) => row(k, v));
      profileOf(coords).then(p => {
        prof = p;
        let t = P.fillGaps(p.terrain);
        if (!t) {                                            // no terrain: the track's own heights, if it has them
          const own = p.samples.map((s, i) => null);
          const cum = P.cumulative(coords), z = coords.map(c => (Number.isFinite(c[2]) && c[2] !== 0 ? c[2] : null));
          if (z.filter(v => v != null).length >= coords.length / 2) {
            p.samples.forEach((s, i) => { let j = 1; while (j < cum.length - 1 && cum[j] < s.d) j++; const a = z[j - 1], b = z[j]; own[i] = a != null && b != null ? a + (b - a) * (cum[j] > cum[j - 1] ? Math.min(1, Math.max(0, (s.d - cum[j - 1]) / (cum[j] - cum[j - 1]))) : 0) : (a != null ? a : b); });
            t = P.fillGaps(own); source = 'track';
          }
        }
        if (!t) { graph.textContent = 'Heights aren’t available here (the terrain isn’t loaded).'; tip.textContent = ''; return; }
        hs = t;
        const ds = p.samples.map(s => s.d), cd = P.climbDescent(hs, { smooth: 1 });
        p.steep = P.steepest(ds, P.smooth(hs, 1), Math.max(30, 3 * p.step));
        drawGraph();
        const r0 = stats.firstChild;                          // new rows go above Start / End
        const add = (k, v, title) => stats.insertBefore(row(k, v, title), r0);
        add('Climb', U().climb(cd.climb));
        add('Descent', U().climb(cd.descent));
        if (p.steep) add('Steepest', `${Math.abs(p.steep.pct).toFixed(0)}% ${p.steep.grade >= 0 ? 'uphill' : 'downhill'} (${Math.abs(p.steep.deg).toFixed(0)}°), ${U().len(p.steep.d1 - p.steep.d0)} long, at ${U().len(p.steep.at)}`, 'The steepest stretch of at least 30 m');
        const rec = P.recorded(o.times);
        if (rec) add('Recorded time', U().duration(rec.seconds) + ' (' + new Date(rec.start).toISOString().slice(0, 16).replace('T', ' ') + ' UTC)');
        add('Walking time, Tobler', '≈ ' + U().duration(P.tobler(ds, P.smooth(hs, 1))), 'Tobler’s hiking function: about 5 km/h on the flat, slower up and down');
        add('Walking time, Naismith', '≈ ' + U().duration(P.naismith(p.length, cd.climb)), 'Naismith’s rule: 5 km/h plus 10 minutes for every 100 m climbed');
        note.textContent = 'Walking times are for one person on foot with no pack; they do not know about brush, rock or water.';
        lidarOf(p.samples).then(l => { lid = l; if (l) { drawGraph(); } });
      });
      return root;
    }

    const css = w.document && w.document.createElement ? w.document.createElement('style') : null;
    if (css) {
      css.textContent = `
      :is(#info-x, .rs-host) .rs-graph { margin: 4px 0 2px; } :is(#info-x, .rs-host) .rs-svg { width: 100%; height: auto; display: block; touch-action: none; }
      :is(#info-x, .rs-host) .rs-axis { stroke: rgba(255,255,255,.25); stroke-width: 1; } :is(#info-x, .rs-host) .rs-ax { fill: rgba(255,255,255,.55); font-size: 9px; }
      :is(#info-x, .rs-host) .rs-terrain { fill: none; stroke: #8ab4ec; stroke-width: 1.6; } :is(#info-x, .rs-host) .rs-lidar { fill: none; stroke: #f2a65a; stroke-width: 1.4; }
      :is(#info-x, .rs-host) .rs-steep { fill: none; stroke: #ff7b7b; stroke-width: 2.6; } :is(#info-x, .rs-host) .rs-steep-band { fill: rgba(255,123,123,.14); }
      :is(#info-x, .rs-host) .rs-over { fill: transparent; cursor: crosshair; } :is(#info-x, .rs-host) .rs-cross { stroke: rgba(255,255,255,.5); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
      :is(#info-x, .rs-host) .rs-dot { fill: #ffe600; stroke: #000; stroke-width: 1; pointer-events: none; }
      :is(#info-x, .rs-host) .rs-pt { cursor: pointer; } :is(#info-x, .rs-host) .rs-pt-l { stroke: rgba(242,194,78,.45); stroke-width: 1; } :is(#info-x, .rs-host) .rs-pt-c { fill: #f2c24e; stroke: #000; stroke-width: 1; }
      :is(#info-x, .rs-host) .rs-pt:hover .rs-pt-c { fill: #fff; }
      :is(#info-x, .rs-host) .rs-tip { min-height: 15px; color: rgba(255,255,255,.7); font-size: 11.5px; margin-bottom: 4px; }
      :is(#info-x, .rs-host) .rs-legend { color: rgba(255,255,255,.6); font-size: 11px; display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: center; }
      :is(#info-x, .rs-host) .rs-k { display: inline-block; width: 12px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 3px; }
      :is(#info-x, .rs-host) .rs-k.t { background: #8ab4ec; } :is(#info-x, .rs-host) .rs-k.l { background: #f2a65a; } :is(#info-x, .rs-host) .rs-k.s { background: #ff7b7b; } :is(#info-x, .rs-host) .rs-k.p { background: #f2c24e; height: 9px; width: 9px; border-radius: 50%; }
      :is(#info-x, .rs-host) .rs-rad { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11.5px; color: rgba(255,255,255,.6); }
      :is(#info-x, .rs-host) .rs-rad-b, :is(#info-x, .rs-host) .rs-way-b { font: inherit; border-radius: 10px; border: 1px solid rgba(255,255,255,.25); background: none; color: #e8e8ee; padding: 0 8px; cursor: pointer; }
      :is(#info-x, .rs-host) .rs-rad-b.on { border-color: #f2c24e; color: #f2c24e; }
      :is(#info-x, .rs-host) .rs-way { margin-top: 5px; line-height: 1.7; } :is(#info-x, .rs-host) .rs-way-b { border: none; padding: 0; color: #8ab4ec; border-radius: 0; } :is(#info-x, .rs-host) .rs-way-b:hover { text-decoration: underline; }
      :is(#info-x, .rs-host) .rs-note { margin-top: 6px; font-size: 11px; color: rgba(255,255,255,.4); }`;
      w.document.head.appendChild(css);
    }
    return Object.assign({ routeNode, clearHover, setHover, profileOf, RADII, radius: getRadius }, P);
  }
  return Object.assign({ browser }, pure);
});
