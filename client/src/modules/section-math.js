// section-math.js — the arithmetic of the LiDAR Section tool (lidar-section.js), with no page and no Potree in it.
// window._sectionMath in the page; module.exports under Node (tools/test_section_math.js).
//
// A section is a vertical slice through the point cloud along a line A → B on the map. Every return gets
//   d    metres along the line from A          off  metres to the left (+) or right (−) of it          z  its height
// in real metres: a cloud stored in web-mercator metres is stretched (1 / cos latitude), so the line's length is
// measured on the globe and the cloud's own units are scaled to it (`k` metres per cloud unit).
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root._sectionMath = M;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const FT = 3.280839895;
  const R_EARTH = 6371008.8;

  /** Metres between two { lon, lat } on the globe (haversine: a section is short, this is exact enough to the cm). */
  function groundDistance(a, b) {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /** The line in the cloud's own coordinates: A, B = [x, y]; `metres` = its true length on the globe (default: the
   *  cloud's units are metres). → { ax, ay, ux, uy (unit direction), len (cloud units), k (metres per unit), L (metres) } */
  function frame(A, B, metres) {
    const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy);
    if (!(len > 0)) return null;
    const L = metres > 0 ? metres : len;
    return { ax: A[0], ay: A[1], ux: dx / len, uy: dy / len, len, k: L / len, L };
  }
  /** One place → [d, off] in metres. */
  function project(fr, x, y) {
    const px = x - fr.ax, py = y - fr.ay;
    return [(px * fr.ux + py * fr.uy) * fr.k, (py * fr.ux - px * fr.uy) * fr.k];
  }
  /** Back: metres along (and across) the line → the cloud's [x, y]. */
  function unproject(fr, d, off) {
    const a = d / fr.k, o = (off || 0) / fr.k;
    return [fr.ax + fr.ux * a - fr.uy * o, fr.ay + fr.uy * a + fr.ux * o];
  }
  /** The width to ask the cloud for, in its own units, for a slice `thickness` metres thick. */
  function widthInUnits(fr, thickness) { return thickness / fr.k; }

  /** Take xyz triples (already in the cloud's world frame) into a section's arrays, keeping what lies between the
   *  ends and within `maxThick / 2` of the line. `out` = { d, z, off, n } (typed arrays with room), `extra(i, j)` is
   *  called for every kept return (source index i, slot j) to copy its other attributes. Returns how many were added. */
  function collect(fr, xyz, count, add, maxThick, out, room, extra) {
    const half = maxThick / 2, ox = add ? add[0] : 0, oy = add ? add[1] : 0, oz = add ? add[2] : 0;
    let n = out.n, took = 0;
    for (let i = 0; i < count && n < room; i++) {
      const px = xyz[i * 3] + ox - fr.ax, py = xyz[i * 3 + 1] + oy - fr.ay;
      const d = (px * fr.ux + py * fr.uy) * fr.k;
      if (d < 0 || d > fr.L) continue;
      const off = (py * fr.ux - px * fr.uy) * fr.k;
      if (off > half || off < -half) continue;
      out.d[n] = d; out.off[n] = off; out.z[n] = xyz[i * 3 + 2] + oz;
      if (extra) extra(i, n);
      n++; took++;
    }
    out.n = n;
    return took;
  }
  /** How many of a section's returns lie in a slice `thickness` metres thick. */
  function countWithin(off, n, thickness) {
    const h = thickness / 2; let c = 0;
    for (let i = 0; i < n; i++) if (off[i] <= h && off[i] >= -h) c++;
    return c;
  }
  /** [zmin, zmax] of the returns in the slice (null when none). */
  function heightRange(z, off, n, thickness) {
    const h = thickness / 2; let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) if (off[i] <= h && off[i] >= -h) { if (z[i] < lo) lo = z[i]; if (z[i] > hi) hi = z[i]; }
    return lo <= hi ? [lo, hi] : null;
  }

  // ── The view: metres → pixels. sx pixels per metre along, sy = sx * exag pixels per metre of height. ──
  /** A view that shows the whole section [0, L] x [zmin, zmax] in a w x h picture with a margin, 1:1 times `exag`. */
  function fit(L, zmin, zmax, w, h, exag, margin) {
    const m = margin == null ? 28 : margin, e = exag > 0 ? exag : 1;
    const zs = Math.max(0.5, zmax - zmin), ls = Math.max(0.5, L);
    const sx = Math.max(1e-6, Math.min((w - 2 * m) / ls, (h - 2 * m) / (zs * e)));
    // centred
    return { sx, exag: e, x0: (w - ls * sx) / 2, y0: h - (h - zs * e * sx) / 2 + zmin * sx * e };
  }
  const toX = (v, d) => v.x0 + d * v.sx;
  const toY = (v, z) => v.y0 - z * v.sx * v.exag;
  const fromX = (v, px) => (px - v.x0) / v.sx;
  const fromY = (v, py) => (v.y0 - py) / (v.sx * v.exag);
  /** Zoom by `factor` keeping what is under (px, py) where it is. */
  function zoomAt(v, px, py, factor) {
    const d = fromX(v, px), z = fromY(v, py), sx = Math.max(0.01, Math.min(2000, v.sx * factor));
    return { sx, exag: v.exag, x0: px - d * sx, y0: py + z * sx * v.exag };
  }
  const pan = (v, dx, dy) => ({ sx: v.sx, exag: v.exag, x0: v.x0 + dx, y0: v.y0 + dy });
  /** Another exaggeration, keeping the middle of the picture where it is. */
  function setExag(v, exag, w, h) {
    const z = fromY(v, h / 2);
    return { sx: v.sx, exag, x0: v.x0, y0: h / 2 + z * v.sx * exag };
  }
  /** The return nearest to a pixel, among those in the slice, within `radius` pixels: its index or -1. */
  function nearest(v, d, z, off, n, thickness, px, py, radius) {
    const h = thickness / 2, r2 = radius * radius, sy = v.sx * v.exag;
    let best = -1, bd = r2;
    for (let i = 0; i < n; i++) {
      if (off[i] > h || off[i] < -h) continue;
      const dx = v.x0 + d[i] * v.sx - px; if (dx > radius || dx < -radius) continue;
      const dy = v.y0 - z[i] * sy - py, q = dx * dx + dy * dy;
      if (q <= bd) { bd = q; best = i; }
    }
    return best;
  }

  // ── The ground along the section, from its own ground returns (class 2) ──
  /** Per `bin` metres along the line: the median height of the ground returns in the slice, gaps filled from the
   *  neighbours; null when the slice has no ground return at all. → { bin, g: Float32Array } */
  function groundLine(d, z, off, cls, n, thickness, L, bin) {
    const b = bin > 0 ? bin : 1, nb = Math.max(1, Math.ceil(L / b)), h = thickness / 2, lists = new Array(nb);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (cls[i] !== 2 || off[i] > h || off[i] < -h) continue;
      const k = Math.min(nb - 1, Math.max(0, Math.floor(d[i] / b)));
      (lists[k] || (lists[k] = [])).push(z[i]); any = true;
    }
    if (!any) return null;
    const g = new Float32Array(nb).fill(NaN);
    for (let k = 0; k < nb; k++) if (lists[k]) { const a = lists[k].sort((p, q) => p - q); g[k] = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; }
    // fill the gaps: straight between the bins that have ground, flat past the ends
    let last = -1;
    for (let k = 0; k < nb; k++) {
      if (g[k] !== g[k]) continue;
      if (last < 0) for (let j = 0; j < k; j++) g[j] = g[k];
      else for (let j = last + 1; j < k; j++) g[j] = g[last] + (g[k] - g[last]) * (j - last) / (k - last);
      last = k;
    }
    for (let j = last + 1; j < nb; j++) g[j] = g[last];
    return { bin: b, g };
  }
  /** The ground's height at `d` metres along (straight between bin middles). */
  function groundAt(gl, d) {
    if (!gl) return NaN;
    const g = gl.g, f = d / gl.bin - 0.5, i = Math.floor(f);
    if (i < 0) return g[0];
    if (i >= g.length - 1) return g[g.length - 1];
    return g[i] + (g[i + 1] - g[i]) * (f - i);
  }

  // ── Colours ──
  const CLASS_NAMES = { 0: 'never classified', 1: 'unclassified', 2: 'ground', 3: 'low vegetation', 4: 'medium vegetation', 5: 'high vegetation', 6: 'building', 7: 'low noise', 9: 'water', 17: 'bridge deck', 18: 'high noise' };
  const className = c => CLASS_NAMES[c] || 'class ' + c;
  const GROUND_RGB = [0xc0, 0x8f, 0x5a], OTHER_RGB = [0x5c, 0xc0, 0x6c], NOISE_RGB = [0xff, 0x4d, 0xd2], BUILT_RGB = [0xb9, 0xbf, 0xc8], WATER_RGB = [0x4a, 0x9c, 0xff];
  /** By class: the ground brown, everything else green (the look of the side views), noise pink, built grey, water blue. */
  function classColour(c) { return c === 2 ? GROUND_RGB : c === 7 || c === 18 ? NOISE_RGB : c === 6 || c === 17 ? BUILT_RGB : c === 9 ? WATER_RGB : OTHER_RGB; }
  const HAG_STOPS = [[-2, [0xff, 0x4d, 0xd2]], [0, [0xc0, 0x8f, 0x5a]], [0.3, [0xd9, 0xd0, 0x6a]], [2, [0x8f, 0xd1, 0x5a]], [10, [0x2f, 0xa8, 0x5a]], [30, [0x2a, 0x7f, 0xd6]]];
  /** By height above the ground (metres): below the ground pink, on it brown, brush yellow-green, trees green to blue. */
  function hagColour(hm) {
    if (!(hm === hm)) return OTHER_RGB;
    if (hm <= HAG_STOPS[0][0]) return HAG_STOPS[0][1];
    for (let i = 1; i < HAG_STOPS.length; i++) if (hm <= HAG_STOPS[i][0]) {
      const a = HAG_STOPS[i - 1], b = HAG_STOPS[i], u = (hm - a[0]) / (b[0] - a[0]);
      return [Math.round(a[1][0] + (b[1][0] - a[1][0]) * u), Math.round(a[1][1] + (b[1][1] - a[1][1]) * u), Math.round(a[1][2] + (b[1][2] - a[1][2]) * u)];
    }
    return HAG_STOPS[HAG_STOPS.length - 1][1];
  }

  // ── The ruler, the scale bar, words ──
  /** Between two returns { d, z }: horizontal, vertical (+ = up from the first), straight; and the slope in degrees. */
  function ruler(p, q) {
    const h = Math.abs(q.d - p.d), v = q.z - p.z;
    return { horizontal: h, vertical: v, straight: Math.hypot(h, v), slope: h > 0 ? Math.atan2(Math.abs(v), h) * 180 / Math.PI : 90 };
  }
  /** A length in the units FLEX is set to, with the other in brackets: "3.0 m (9.8 ft)". */
  function both(m, imperial, digits) {
    const dg = digits == null ? 1 : digits, a = m.toFixed(dg) + ' m', b = (m * FT).toFixed(dg) + ' ft';
    return imperial ? b + ' (' + a + ')' : a + ' (' + b + ')';
  }
  function rulerText(r, imperial) {
    return 'across ' + both(r.horizontal, imperial) + ' · ' + (r.vertical >= 0 ? 'up ' : 'down ') + both(Math.abs(r.vertical), imperial) + ' · straight ' + both(r.straight, imperial) + ' · ' + r.slope.toFixed(0) + '°';
  }
  /** A round length (1, 2, 5 x 10^n metres, or feet) about `target` metres long: { metres, label }. */
  function scaleBar(target, imperial) {
    const t = Math.max(1e-6, imperial ? target * FT : target), p = Math.pow(10, Math.floor(Math.log10(t))), m = t / p;
    const v = (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
    return { metres: imperial ? v / FT : v, label: (v >= 1 ? String(Math.round(v)) : String(+v.toPrecision(1))) + (imperial ? ' ft' : ' m') };
  }
  /** Ticks for an axis between lo and hi (metres) at about `count` round steps. */
  function ticks(lo, hi, count) {
    const span = Math.max(1e-9, hi - lo), raw = span / Math.max(1, count), p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p, step = (m >= 5 ? 10 : m >= 2 ? 5 : m >= 1 ? 2 : 1) * p;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(6));
    return { step, values: out };
  }
  /** The two ends as FLEX's coordinate copy writes a place ("lat, lon", five decimals), one a line. */
  function endsText(a, b) { const f = p => p.lat.toFixed(5) + ', ' + p.lon.toFixed(5); return f(a) + '\n' + f(b); }
  /** Where along the line (metres) a place on the map is, and how far to the side; null off the ends by more than `slack`. */
  function alongOf(a, b, p) {
    const L = groundDistance(a, b); if (!(L > 0)) return null;
    const r = Math.PI / 180, mx = R_EARTH * r * Math.cos((a.lat + b.lat) / 2 * r), my = R_EARTH * r;
    const ex = (b.lon - a.lon) * mx, ey = (b.lat - a.lat) * my, px = (p.lon - a.lon) * mx, py = (p.lat - a.lat) * my, l = Math.hypot(ex, ey);
    return { d: (px * ex + py * ey) / l * (L / l), off: (py * ex - px * ey) / l * (L / l), L };
  }
  /** The place on the map `d` metres along the line. */
  function placeAt(a, b, d) { const L = groundDistance(a, b), u = L > 0 ? d / L : 0; return { lon: a.lon + (b.lon - a.lon) * u, lat: a.lat + (b.lat - a.lat) * u }; }

  return { FT, groundDistance, frame, project, unproject, widthInUnits, collect, countWithin, heightRange, fit, toX, toY, fromX, fromY, zoomAt, pan, setExag, nearest,
    groundLine, groundAt, className, classColour, hagColour, ruler, both, rulerText, scaleBar, ticks, endsText, alongOf, placeAt, GROUND_RGB, OTHER_RGB };
});
