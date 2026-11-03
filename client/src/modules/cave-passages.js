// Passage volumes drawn from the survey's LRUDs (left / right / up / down), and the
// section frames they are built in. Moved out of flex.js unchanged (the flex.js
// split, wave 1; see client/src/README.md for the pattern).
//
// Pure exports (no browser, no Cesium), node-testable. They work in survey
// space (e / n / v metres) and push every vertex through a convertFn(n, e, v):
// a Cartesian3 in the browser, any object in a test.
//   segmentLruds(pts)               four dimensions for every station of a segment
//   effectiveLrud / stationEffectiveLrud / lrudAtTo   "LRUD at From / To" (displayOptions.passageLrudAt)
//   frameVertical / frameShot / framePoint            cross-section frames
//   buildBlocky / buildSmooth(g, pts, lr, convertFn, perp)   fill g = { pos, idx } with triangles
// Setup (Cesium and the viewer are passed in, never imported):
//   setupCavePassages({ ... }) -> { buildCavePassages, removeCavePassages, setCavePassageVisible }
//
// Reads the colour mode through state.colourMode (flex.js keeps the variable).
// window._caveStationLrud is defined here (the export collector, index.html).

// ── Passage volumes from LRUDs ───────────────────────────────────────────────
// The PLT parser keeps L/U/D/R per station (feet → metres). Compass writes a
// negative number, or a 999-style sentinel, for a dimension nobody measured.
//
// Geometry is built in survey space (e/n/v metres) and pushed through the same
// convertFn as the survey lines, so anchoring, declination and control-point
// warps apply to the walls exactly as they do to the centreline. One Cesium
// Primitive per cave, one GeometryInstance per survey colour.
//
// Modes:  none   — lines only
//         blocky — one box per shot, flat-shaded (each shot's own direction)
//         smooth — curved elliptical tube: spline centreline through the
//                  stations, sizes eased between them, rounded dead ends
export const PASSAGE_SMOOTH_SIDES = 16;

export function lrudValid(x) { return Number.isFinite(x) && x >= 0 && x < 300; }

// A station's LRUD, or null. All four at zero is a placeholder, not a
// measurement (a real passage is never 0x0): it never feeds the blending of
// other stations, and is itself drawn as the plain 2 ft tube (see
// segmentLruds) rather than guessed from its neighbours.
export function isLrudPlaceholder(p) {
  const w = p.lrud;
  return !!w && ['l', 'r', 'u', 'd'].every(k => Math.abs(w[k]) < 1e-6);
}
export function stationLrud(p) {
  const w = p.lrud;
  if (!w || isLrudPlaceholder(p)) return null;
  return w;
}

export function countLrudStations(parsed) {
  let n = 0;
  for (const seg of parsed.segments)
    for (const p of seg.points)
      if (stationLrud(p) && ['l', 'r', 'u', 'd'].some(k => lrudValid(p.lrud[k]))) n++;
  return n;
}

// Every station of a segment gets all four dimensions:
//   * measured value                → as measured (floored at 5 cm)
//   * 0/0/0/0 placeholder station   → 1 ft each side, a plain 2 ft x 2 ft tube.
//     No guessing: blending a neighbour's size in used to copy one tall
//     canyon's U/D down a whole run of placeholder stations (drawn as big
//     cylinders over steep pitches).
//   * a missing value (blank, Compass -9.9 / 999 sentinel, or a station with
//     no LRUD at all) → interpolated by station count between the nearest
//     measured stations either side, held flat past the ends; 1 ft if that
//     dimension is never measured in the segment.
// Between two stations the tube then eases from one size to the other along
// the shot (smoothstep, lerpLrud).
export const PASSAGE_DEFAULT_LRUD = 0.3048;   // 1 ft each side

export function segmentLruds(pts) {
  const keys = ['l', 'r', 'u', 'd'];
  const out = pts.map(() => ({}));
  for (const k of keys) {
    const idx = [];
    pts.forEach((p, i) => { if (stationLrud(p) && lrudValid(p.lrud[k])) idx.push(i); });
    if (!idx.length) { out.forEach(o => { o[k] = null; }); continue; }
    let j = 0;
    for (let i = 0; i < pts.length; i++) {
      while (j + 1 < idx.length && idx[j + 1] <= i) j++;
      const lo = idx[j] <= i ? idx[j] : -1;
      const hi = idx.find(x => x >= i) ?? -1;
      const val = x => pts[x].lrud[k];
      if (lo < 0) out[i][k] = val(hi);
      else if (hi < 0 || hi === lo) out[i][k] = val(lo);
      else out[i][k] = val(lo) + (val(hi) - val(lo)) * (i - lo) / (hi - lo);
    }
  }
  out.forEach((o, i) => {
    const ph = isLrudPlaceholder(pts[i]);
    // Floor, so a wall measured at zero reads as a thin sheet, not nothing.
    for (const k of keys) o[k] = ph ? PASSAGE_DEFAULT_LRUD : Math.max(o[k] ?? PASSAGE_DEFAULT_LRUD, 0.05);
  });
  return out;
}

// "LRUD at" (Style → Passage, per cave). 'from' (default) draws every reading
// at the station it was imported on. 'to' moves each reading one shot along
// the survey, onto the far end of the shot leaving its station — for data
// whose LRUDs describe the shot's to-station (Compass's "LRUD at To station")
// but landed on the from-station. A station no shot arrives at (the start of
// a survey) is then left without a reading and filled like any other gap.
// The export sends the same shifted readings, so the portable viewer agrees.
const _lrudToCache = new WeakMap();      // parsed → Map(station name → reading)
export function lrudAtTo(imp) { return !!imp && (imp.displayOptions || {}).passageLrudAt === 'to'; }
// Station name → the reading of the from-station of a shot arriving at it.
// Tie-ins can arrive from several shots: the first with a measurement wins.
function lrudToMap(parsed) {
  let m = _lrudToCache.get(parsed);
  if (m) return m;
  m = new Map();
  const measured = lr => !!lr && stationLrud({ lrud: lr }) && ['l', 'r', 'u', 'd'].some(k => lrudValid(lr[k]));
  for (const seg of parsed.segments || []) {
    const P = seg.points;
    for (let i = 1; i < P.length; i++) {
      const to = P[i].name;
      if (!to) continue;
      const lr = P[i - 1].lrud || null;
      if (!m.has(to) || (!measured(m.get(to)) && measured(lr))) m.set(to, lr);
    }
  }
  _lrudToCache.set(parsed, m);
  return m;
}
// The reading drawn at point p (prev: the point before it on its chain).
export function effectiveLrud(imp, p, prev) {
  if (!lrudAtTo(imp)) return p.lrud;
  const m = lrudToMap(imp.parsed);
  if (p.name && m.has(p.name)) return m.get(p.name) || undefined;
  return p.name ? undefined : (prev ? prev.lrud : undefined);   // unnamed: its own shot's from-station
}
// For a station record (parsed.stations): what the walls use at it.
export function stationEffectiveLrud(imp, s) {
  if (!lrudAtTo(imp)) return s.lrud;
  const m = lrudToMap(imp.parsed);
  return (s.name && m.get(s.name)) || undefined;
}

// Unit horizontal direction a→b in survey space, or null for a vertical shot.
export function hdir(a, b) {
  const dx = b.e - a.e, dy = b.n - a.n, h = Math.hypot(dx, dy);
  return h > 1e-3 ? { x: dx / h, y: dy / h } : null;
}

// ── Section frames ───────────────────────────────────────────────────────────
// A cross-section is laid out in a frame of three survey-space unit vectors:
//   L  towards the left wall      U  towards the ceiling
//   F  along the passage (only used to push rounded caps past a dead end)
// Two conventions for U/D, chosen in the Style panel:
//   vertical — U is straight up and L is horizontal: the usual Compass reading,
//              where L/R are taken level and U/D with a plumb line.
//   shot     — U is perpendicular to the shot, tilted with its inclination, so
//              the section stays square to the survey line on slopes and a
//              vertical shot becomes a tube along the shaft instead of needing
//              the shaft special case. L stays horizontal in both.
export function frameVertical(d) {
  return { L: { e: -d.y, n: d.x, v: 0 }, U: { e: 0, n: 0, v: 1 }, F: { e: d.x, n: d.y, v: 0 } };
}

// t: unit 3D direction of the passage; d: horizontal heading to fall back on
// when t is vertical.
export function frameShot(t, d) {
  const h = Math.hypot(t.e, t.n);
  const dh = h > 1e-3 ? { x: t.e / h, y: t.n / h } : d;
  const L = { e: -dh.y, n: dh.x, v: 0 };
  // U = t x L (already unit: t and L are perpendicular unit vectors)
  const U = { e: -t.v * L.n, n: t.v * L.e, v: t.e * L.n - t.n * L.e };
  return { L, U, F: t };
}

// Minimal-rotation ("parallel transport") step: carry side vector L from a
// tangent to the next one without spinning about it.
function transportL(L, tb) {
  const k = L.e * tb.e + L.n * tb.n + L.v * tb.v;
  const x = L.e - tb.e * k, y = L.n - tb.n * k, z = L.v - tb.v * k, m = Math.hypot(x, y, z);
  return m > 1e-9 ? { e: x / m, n: y / m, v: z / m } : L;
}
function rotAbout(L, t, ang) {            // Rodrigues, L perpendicular to t
  const c = Math.cos(ang), s = Math.sin(ang);
  const cx = t.n * L.v - t.v * L.n, cy = t.v * L.e - t.e * L.v, cz = t.e * L.n - t.n * L.e;
  return { e: L.e * c + cx * s, n: L.n * c + cy * s, v: L.v * c + cz * s };
}
export const PASSAGE_STEEP = 0.85;        // |t.v| above this: the horizontal-L frame is ill-conditioned

// Frames for a sampled 3D path in perpendicular-U mode. Away from vertical
// the frame is frameShot (L horizontal). Through a steep stretch the frame is
// carried along by parallel transport from the last non-steep sample, and the
// twist that built up is spread evenly over the stretch, so the tube never
// spins where the heading turns through vertical. ts[j]: unit tangents (null
// = unknown), ds[j]: horizontal heading fallbacks.
export function transportFrames(ts, ds) {
  const n = ts.length, fr = new Array(n);
  const steep = j => Math.abs(ts[j].v) > PASSAGE_STEEP;
  for (let j = 0; j < n; j++) if (!steep(j)) fr[j] = frameShot(ts[j], ds[j]);
  for (let s = 0; s < n; ) {
    if (fr[s]) { s++; continue; }
    let e = s; while (e + 1 < n && !fr[e + 1]) e++;
    const before = s > 0 ? fr[s - 1] : null, after = e + 1 < n ? fr[e + 1] : null;
    if (!before && !after) { for (let j = s; j <= e; j++) fr[j] = frameShot(ts[j], ds[j]); s = e + 1; continue; }
    const fwdPass = !!before;                    // carry from `before` (else backwards from `after`)
    const idx = []; for (let j = s; j <= e; j++) idx.push(j);
    if (!fwdPass) idx.reverse();
    let L = (fwdPass ? before : after).L;
    const Ls = {};
    for (const j of idx) { L = transportL(L, ts[j]); Ls[j] = L; }
    if (before && after) {                       // spread the leftover twist
      const tb = ts[e + 1], Lt = transportL(Ls[e], tb), H = after.L;
      const cr = Lt.n * H.v - Lt.v * H.n, cn = Lt.v * H.e - Lt.e * H.v, cv = Lt.e * H.n - Lt.n * H.e;
      const ang = Math.atan2(cr * tb.e + cn * tb.n + cv * tb.v, Lt.e * H.e + Lt.n * H.n + Lt.v * H.v);
      for (let j = s; j <= e; j++) Ls[j] = rotAbout(Ls[j], ts[j], ang * (j - s + 1) / (e - s + 2));
    }
    for (let j = s; j <= e; j++) {
      const t = ts[j], l = Ls[j];
      fr[j] = { L: l, U: { e: t.n * l.v - t.v * l.n, n: t.v * l.e - t.e * l.v, v: t.e * l.n - t.n * l.e }, F: t };
    }
    s = e + 1;
  }
  return fr;
}

export function unit3(a, b) {
  const x = b.e - a.e, y = b.n - a.n, z = b.v - a.v, m = Math.hypot(x, y, z);
  return m > 1e-6 ? { e: x / m, n: y / m, v: z / m } : null;
}

// World point at P + (-side)·L + up·U + fwd·F. `side` is positive to the right.
export function framePoint(convertFn, P, fr, side, up, fwd = 0) {
  const e = P.e - fr.L.e * side + fr.U.e * up + fr.F.e * fwd;
  const n = P.n - fr.L.n * side + fr.U.n * up + fr.F.n * fwd;
  const v = P.v - fr.L.v * side + fr.U.v * up + fr.F.v * fwd;
  return convertFn(n, e, v);
}

export function passageGroup(groups, hex) {
  if (!groups.has(hex)) groups.set(hex, { pos: [], idx: [] });
  return groups.get(hex);
}
// Colour by difficulty also notes, per vertex, which shot it was built for and
// how far along it (g.sh / g.tt; the builders set g.cur, or tag a point's _t).
export function pushVert(g, c) {
  g.pos.push(c.x, c.y, c.z);
  if (g.sh) { g.sh.push(g.cur.s < 0 ? -1 : g.base + g.cur.s); g.tt.push(c._t ?? g.cur.t); }
  return g.pos.length / 3 - 1;
}
export function pushQuad(g, a, b, c, d) {
  const i = pushVert(g, a), j = pushVert(g, b), k = pushVert(g, c), l = pushVert(g, d);
  g.idx.push(i, j, k, i, k, l);
}

// Vertical-U mode only: a vertical shot has no heading to hang a level section
// on, so sections built like the others would all lie in one plane and draw a
// sheet with no thickness. Draw it as a shaft instead: a horizontal footprint
// L+R wide (across the last horizontal heading) and (L+R)/2 deep, running from
// the lower station's floor to the upper station's ceiling.
export function buildShaft(g, A, B, wA, wB, d, smooth) {
  const lo = A.v <= B.v ? [A, wA] : [B, wB], hi = A.v <= B.v ? [B, wB] : [A, wA];
  const zBot = lo[0].v - lo[1].d, zTop = hi[0].v + hi[1].u;
  // The narrower end: a pit is rarely as wide as the room at its lip.
  const l = Math.min(wA.l, wB.l), r = Math.min(wA.r, wB.r);
  const depth = Math.max((l + r) / 2, 0.3);
  const cx = (A.e + B.e) / 2, cy = (A.n + B.n) / 2;
  // footprint points as (side, fwd): side to the right of d, fwd along d
  const prof = smooth
    ? Array.from({ length: PASSAGE_SMOOTH_SIDES }, (_, k) => {
        const t = 2 * Math.PI * k / PASSAGE_SMOOTH_SIDES, c = Math.cos(t);
        return [(c >= 0 ? r : l) * c, depth * Math.sin(t)];
      })
    : [[r, depth], [-l, depth], [-l, -depth], [r, -depth]];
  const at = ([side, fwd], z, cf) =>
    cf(cy - d.x * side + d.y * fwd, cx + d.y * side + d.x * fwd, z);
  return { prof, at, cx, cy, zBot, zTop, tBot: A.v <= B.v ? 0 : 1 };   // tBot: the bottom's end of the shot
}

export function emitShaft(g, sh, convertFn, smooth) {
  const { prof, at, zBot, zTop } = sh, N = prof.length;
  const bot = prof.map(q => at(q, zBot, convertFn)), top = prof.map(q => at(q, zTop, convertFn));
  if (bot.some(x => !x) || top.some(x => !x)) return;
  for (const c of bot) c._t = sh.tBot;
  for (const c of top) c._t = 1 - sh.tBot;
  if (!smooth) {
    for (let k = 0; k < N; k++) { const k1 = (k + 1) % N; pushQuad(g, bot[k], bot[k1], top[k1], top[k]); }
    pushQuad(g, top[0], top[1], top[2], top[3]);
    pushQuad(g, bot[3], bot[2], bot[1], bot[0]);
    return;
  }
  // Rounded ends: rings shrink along a quarter ellipse so the shaft closes on a
  // dome inside its own extent (not past the floor or ceiling).
  const { cx, cy } = sh;
  const H = zTop - zBot, len = Math.min(Math.max(Math.min(...prof.map(q => Math.hypot(q[0], q[1]))) * 0.7, 0.1), H / 2);
  const ringAt = (z, scale, tt) => prof.map(q => {
    const c = at([q[0] * scale, q[1] * scale], z, convertFn);
    if (c) c._t = tt;
    return c && pushVert(g, c);
  });
  const rings = [];
  for (let m = 0; m < PASSAGE_CAP_RINGS; m++) {                       // bottom dome, apex excluded
    const phi = (m / PASSAGE_CAP_RINGS) * Math.PI / 2;
    rings.push(ringAt(zBot + len * (1 - Math.sin(phi)), Math.cos(phi), sh.tBot));
  }
  for (let m = PASSAGE_CAP_RINGS - 1; m >= 0; m--) {                  // top dome
    const phi = (m / PASSAGE_CAP_RINGS) * Math.PI / 2;
    rings.push(ringAt(zTop - len * (1 - Math.sin(phi)), Math.cos(phi), 1 - sh.tBot));
  }
  if (rings.some(r => r.some(v => v == null))) return;
  for (let j = 0; j + 1 < rings.length; j++) stitchRings(g, rings[j], rings[j + 1]);
  for (const [ring, z, tt, up] of [[rings[0], zBot, sh.tBot, false], [rings[rings.length - 1], zTop, 1 - sh.tBot, true]]) {
    const c = at([0, 0], z, convertFn);
    if (!c) continue;
    c._t = tt;
    const ci = pushVert(g, c);
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      if (up) g.idx.push(ring[k1], ring[k], ci); else g.idx.push(ring[k], ring[k1], ci);
    }
  }
}

// Blocky: a box per shot, both end sections in that shot's own frame, so every
// shot is a separate flat-shaded prism. Unshared vertices per face give flat
// normals.
export function buildBlocky(g, pts, lr, convertFn, perp) {
  let prev = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const A = pts[i], B = pts[i + 1];
    const hd = hdir(A, B);
    const d = hd || prev || { x: 0, y: 1 };
    prev = d;
    if (g.cur) g.cur.s = i;
    let fr;
    if (perp) {
      const t = unit3(A, B);
      if (!t) continue;                                   // zero-length shot
      fr = frameShot(t, d);
    } else {
      if (!hd) { emitShaft(g, buildShaft(g, A, B, lr[i], lr[i + 1], d, false), convertFn, false); continue; }
      fr = frameVertical(d);
    }
    const sec = (P, w) => [
      framePoint(convertFn, P, fr, -w.l,  w.u),   // top-left
      framePoint(convertFn, P, fr,  w.r,  w.u),   // top-right
      framePoint(convertFn, P, fr,  w.r, -w.d),   // bottom-right
      framePoint(convertFn, P, fr, -w.l, -w.d),   // bottom-left
    ];
    const a = sec(A, lr[i]), b = sec(B, lr[i + 1]);
    if (a.some(x => !x) || b.some(x => !x)) continue;
    for (const c of a) c._t = 0;
    for (const c of b) c._t = 1;
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      pushQuad(g, a[k], a[k1], b[k1], b[k]);
    }
    pushQuad(g, a[3], a[2], a[1], a[0]);
    pushQuad(g, b[0], b[1], b[2], b[3]);
  }
}

// Smooth: one curved tube per run of shots.
//   * The centreline is a centripetal Catmull-Rom spline through the stations —
//     a cubic Bézier per shot whose control points come from the neighbouring
//     stations. It passes exactly through every station, and the centripetal
//     knots stop it overshooting or looping at tight turns.
//   * Each shot is cut into a few rings (more for longer shots). A ring faces
//     the curve's tangent — horizontally in vertical-U mode, fully in 3D in
//     perpendicular mode — so bends turn gradually instead of kinking.
//   * Passage size eases between stations (smoothstep), so a room opening off
//     a crawl flares instead of stepping.
//   * Each quadrant of a ring is an ellipse quarter with its own radius
//     (R/U/L/D), so an asymmetric passage stays asymmetric.
//   * Dead ends get a rounded cap instead of a flat disc.
//   * In vertical-U mode, vertical shots break the run and are drawn as shafts
//     (see buildShaft); in perpendicular mode the tube simply follows them.
export const PASSAGE_RING_SPACING = 1.5;   // metres of shot per ring, roughly
export const PASSAGE_MAX_RINGS    = 10;    // per shot
export const PASSAGE_CAP_RINGS    = 4;

export function crPoint(p0, p1, p2, p3, t) {
  const knot = (a, b) => Math.max(Math.sqrt(Math.hypot(b.e - a.e, b.n - a.n, b.v - a.v)), 1e-4);
  const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a, b, ta, tb) => {
    const wa = (tb - u) / (tb - ta), wb = (u - ta) / (tb - ta);
    return { e: a.e * wa + b.e * wb, n: a.n * wa + b.n * wb, v: a.v * wa + b.v * wb };
  };
  const A1 = mix(p0, p1, t0, t1), A2 = mix(p1, p2, t1, t2), A3 = mix(p2, p3, t2, t3);
  const B1 = mix(A1, A2, t0, t2), B2 = mix(A2, A3, t1, t3);
  return mix(B1, B2, t1, t2);
}

export function lerpLrud(a, b, t) {
  const s = t * t * (3 - 2 * t);
  return { l: a.l + (b.l - a.l) * s, r: a.r + (b.r - a.r) * s,
           u: a.u + (b.u - a.u) * s, d: a.d + (b.d - a.d) * s };
}

// One ring of N points: centre c in frame fr, dimensions w scaled by `scale`,
// pushed `fwd` metres along fr.F (used by the rounded caps).
export function smoothRing(g, convertFn, c, fr, w, scale, fwd) {
  const N = PASSAGE_SMOOTH_SIDES, ring = [];
  for (let k = 0; k < N; k++) {
    const t = 2 * Math.PI * k / N, co = Math.cos(t), si = Math.sin(t);
    const side = (co >= 0 ? w.r : w.l) * co * scale;
    const up   = (si >= 0 ? w.u : w.d) * si * scale;
    const x = framePoint(convertFn, c, fr, side, up, fwd);
    if (!x) return null;
    ring.push(pushVert(g, x));
  }
  return ring;
}

export function stitchRings(g, a, b) {
  const N = a.length;
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    g.idx.push(a[k], b[k1], a[k1], a[k], b[k], b[k1]);   // outward-facing
  }
}

// Rounded end: rings shrink along a quarter circle and close on an apex that
// sits a little past the station, so a dead end reads as rock, not a cut.
export function roundCap(g, convertFn, c, fr, w, rim, outward, flush) {
  if (flush) {                       // station shared with another leg: close on the station itself, no dome past it
    const ax = framePoint(convertFn, c, fr, 0, 0, 0);
    if (!ax) return;
    const ai = pushVert(g, ax), N = rim.length;
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      if (outward) g.idx.push(rim[k1], rim[k], ai); else g.idx.push(rim[k], rim[k1], ai);
    }
    return;
  }
  const len = Math.max(Math.min(w.l + w.r, w.u + w.d) / 2, 0.1);
  const sgn = outward ? 1 : -1;
  let prev = rim;
  for (let m = 1; m < PASSAGE_CAP_RINGS; m++) {
    const phi = (m / PASSAGE_CAP_RINGS) * Math.PI / 2;
    const ring = smoothRing(g, convertFn, c, fr, w, Math.cos(phi), sgn * len * Math.sin(phi));
    if (!ring) return;
    if (outward) stitchRings(g, prev, ring); else stitchRings(g, ring, prev);
    prev = ring;
  }
  // apex on the centreline (the rings scale about it), pushed out by len
  const ax = framePoint(convertFn, c, fr, 0, 0, sgn * len);
  if (!ax) return;
  const ai = pushVert(g, ax), N = prev.length;
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    if (outward) g.idx.push(prev[k1], prev[k], ai); else g.idx.push(prev[k], prev[k1], ai);
  }
}

// Key of a station position (1 mm), for finding stations several legs share.
export function stationKey(p) { return Math.round(p.e * 1000) + ',' + Math.round(p.n * 1000) + ',' + Math.round(p.v * 1000); }

export function buildSmooth(g, pts, lr, convertFn, perp, joints) {
  const isJoint = p => !!joints && joints.has(stationKey(p));
  const n = pts.length;
  // Runs of shots to spline. Vertical-U mode splits at vertical shots and
  // draws those as shafts; perpendicular mode keeps the whole leg as one run.
  const runs = [];
  if (perp) runs.push(pts.map((_, i) => i));
  else {
    let run = [0], lastDir = null;
    for (let i = 0; i + 1 < n; i++) {
      const hd = hdir(pts[i], pts[i + 1]);
      if (hd) { lastDir = hd; run.push(i + 1); continue; }
      if (run.length >= 2) runs.push(run);
      const nextDir = (() => { for (let j = i + 1; j + 1 < n; j++) { const h = hdir(pts[j], pts[j + 1]); if (h) return h; } return null; })();
      if (g.cur) g.cur.s = i;
      emitShaft(g, buildShaft(g, pts[i], pts[i + 1], lr[i], lr[i + 1], lastDir || nextDir || { x: 0, y: 1 }, true), convertFn, true);
      run = [i + 1];
    }
    if (run.length >= 2) runs.push(run);
  }

  for (const ids of runs) {
    // Sample the spline: centre + dimensions at each ring.
    const S = [];
    const P = k => pts[ids[k]];
    for (let k = 0; k + 1 < ids.length; k++) {
      const p1 = P(k), p2 = P(k + 1);
      const p0 = k > 0 ? P(k - 1) : { e: 2 * p1.e - p2.e, n: 2 * p1.n - p2.n, v: 2 * p1.v - p2.v };
      const p3 = k + 2 < ids.length ? P(k + 2) : { e: 2 * p2.e - p1.e, n: 2 * p2.n - p1.n, v: 2 * p2.v - p1.v };
      const len = Math.hypot(p2.e - p1.e, p2.n - p1.n, p2.v - p1.v);
      if (len < 1e-6) continue;                           // duplicate station
      const K = Math.min(PASSAGE_MAX_RINGS, Math.max(2, Math.ceil(len / PASSAGE_RING_SPACING)));
      for (let s = 0; s < K; s++) {
        const t = s / K;
        S.push({ c: s === 0 ? p1 : crPoint(p0, p1, p2, p3, t), w: lerpLrud(lr[ids[k]], lr[ids[k + 1]], t), si: ids[k], t });
      }
    }
    if (!S.length) continue;
    S.push({ c: P(ids.length - 1), w: lr[ids[ids.length - 1]], si: S[S.length - 1].si, t: 1 });
    const along = smp => { if (g.cur) { g.cur.s = smp.si; g.cur.t = smp.t; } };

    // Frame at each sample from the tangent through its neighbours.
    let prevD = null;
    const ts = [], ds = [];
    for (let j = 0; j < S.length; j++) {
      const a = S[Math.max(0, j - 1)].c, b = S[Math.min(S.length - 1, j + 1)].c;
      const d = hdir(a, b) || prevD || { x: 0, y: 1 };
      prevD = d;
      ts.push(perp ? (unit3(a, b) || (ts[j - 1]) || { e: d.x, n: d.y, v: 0 }) : null);
      ds.push(d);
    }
    if (perp) { const fs = transportFrames(ts, ds); for (let j = 0; j < S.length; j++) S[j].fr = fs[j]; }
    else for (let j = 0; j < S.length; j++) S[j].fr = frameVertical(ds[j]);

    const rings = [];
    for (const s of S) {
      along(s);
      const r = smoothRing(g, convertFn, s.c, s.fr, s.w, 1, 0);
      if (!r) return;
      rings.push(r);
    }
    for (let j = 0; j + 1 < rings.length; j++) stitchRings(g, rings[j], rings[j + 1]);
    const first = S[0], last = S[S.length - 1];
    along(first);
    roundCap(g, convertFn, first.c, first.fr, first.w, rings[0], false, isJoint(P(0)));
    along(last);
    roundCap(g, convertFn, last.c, last.fr, last.w, rings[rings.length - 1], true, isJoint(P(ids.length - 1)));
  }
}

export function setupCavePassages({
  Cesium, cesiumViewer, state,
  defaultDisplayOptions: _defaultDisplayOptions,
  caveColourRgb: _caveColourRgb,              // (imp, convertFn) -> (x, y, z) -> [r, g, b] | null
  lrudWH, steepScore, wallHardRgb, HARD_UNKNOWN,
} = {}) {
  if (!Cesium) throw new Error('cave-passages: Cesium missing');

  window._caveStationLrud = stationEffectiveLrud;     // export collector (index.html)

  function _removeCavePassages(imp) {
    if (imp && imp._passagePrimitive) {
      cesiumViewer.scene.primitives.remove(imp._passagePrimitive);   // destroys it
      imp._passagePrimitive = null;
    }
    if (imp) imp._passageMesh = null;
  }

  function _setCavePassageVisible(imp, visible) {
    if (imp && imp._passagePrimitive) imp._passagePrimitive.show = !!visible;
  }

  // (Re)build the walls for one cave. Honours the same hidden-survey and
  // surface rules as the survey lines.
  function _buildCavePassages(imp, convertFn) {
    _removeCavePassages(imp);
    const dopt = imp.displayOptions || _defaultDisplayOptions(imp.parsed);
    const mode = dopt.passageMode || 'none';
    if (mode === 'none') return;
    const alpha = dopt.passageOpacity ?? 0.55;
    // Colour by elevation or depth (null in survey colours), from each vertex's
    // world position.
    const colourRgb = _caveColourRgb(imp, convertFn);
    // Difficulty: each shot's measured width/height at both ends and its
    // steepness; wall vertices point into these (see _pushVert).
    const hard = state.colourMode === 'hard' ? { WA: [], HA: [], WB: [], HB: [], st: [] } : null;
    const groups = new Map();
    // Pass 1: the legs that get walls, and the stations more than one of them touches.
    const legs = [], seen = new Map(), joints = new Set();
    for (const seg of imp.parsed.segments) {
      if (dopt.hiddenSurveys && dopt.hiddenSurveys[seg.survey]) continue;
      const surface = seg.isSurface || !!(dopt.surfaceSurveys && dopt.surfaceSurveys[seg.survey]);
      if (surface) continue;                       // no walls on surface shots
      const raw = lrudAtTo(imp)
        ? seg.points.map((p, i) => ({ ...p, lrud: effectiveLrud(imp, p, seg.points[i - 1]) }))
        : seg.points;
      const pts = raw.filter(p => !p.excluded);
      if (pts.length < 2) continue;
      legs.push({ seg, pts });
      const mine = new Set(pts.map(stationKey));
      for (const k of mine) { if (seen.has(k)) joints.add(k); else seen.set(k, 1); }
    }
    for (const { seg, pts } of legs) {
      const lr = segmentLruds(pts);
      const hex = dopt.surveyColors[seg.survey] || dopt.surveyColors[''] || '#00e5ff';
      const g = passageGroup(groups, hex);
      if (hard) {
        if (!g.sh) { g.sh = []; g.tt = []; g.cur = { s: -1, t: 0 }; }
        g.base = hard.st.length; g.cur.s = -1;
        const num = x => (x == null ? NaN : x);
        for (let i = 0; i + 1 < pts.length; i++) {
          const A = pts[i], B = pts[i + 1], a = lrudWH(A.lrud), b = lrudWH(B.lrud);
          hard.WA.push(num(a && a.W)); hard.HA.push(num(a && a.H));
          hard.WB.push(num(b && b.W)); hard.HB.push(num(b && b.H));
          hard.st.push(steepScore(Math.hypot(B.e - A.e, B.n - A.n), B.v - A.v));
        }
      }
      const perp = dopt.passageUpAxis === 'shot';
      if (mode === 'smooth') buildSmooth(g, pts, lr, convertFn, perp, joints);
      else buildBlocky(g, pts, lr, convertFn, perp);
    }
    const instances = [];
    // Keep the world-space mesh exactly as drawn, so the portable export can carry
    // the same walls (index.html _collectCavesInBbox → export_terrain.py → viewer).
    imp._passageMesh = { alpha, groups: [] };
    for (const [hex, g] of groups) {
      if (!g.idx.length) continue;
      imp._passageMesh.groups.push({ hex, pos: g.pos, idx: g.idx });
      const geometry = new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(g.pos),
          }),
        },
        indices: Cesium.IndexDatatype.createTypedArray(g.pos.length / 3, g.idx),
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromVertices(g.pos),
      });
      Cesium.GeometryPipeline.computeNormal(geometry);
      if (colourRgb || hard) {
        // A colour per vertex: with no per-instance colour, PerInstanceColorAppearance
        // reads the geometry's own 'color' attribute.
        const P = g.pos, nv = P.length / 3, rgba = new Uint8Array(nv * 4), a8 = Math.round(alpha * 255);
        for (let k = 0; k < nv; k++) {
          const si = hard ? g.sh[k] : 0;
          const c = !hard ? colourRgb(P[3 * k], P[3 * k + 1], P[3 * k + 2])
            : si < 0 ? HARD_UNKNOWN
            : wallHardRgb(hard.WA[si], hard.HA[si], hard.WB[si], hard.HB[si], hard.st[si], g.tt[k]);
          rgba[4 * k] = c[0] * 255; rgba[4 * k + 1] = c[1] * 255; rgba[4 * k + 2] = c[2] * 255; rgba[4 * k + 3] = a8;
        }
        geometry.attributes.color = new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: rgba,
        });
        instances.push(new Cesium.GeometryInstance({ geometry }));
        continue;
      }
      instances.push(new Cesium.GeometryInstance({
        geometry,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString(hex).withAlpha(alpha)),
        },
      }));
    }
    if (!instances.length) return;
    imp._passagePrimitive = cesiumViewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({
        translucent: alpha < 1, closed: false, flat: false,
      }),
      asynchronous: false,          // custom Geometry cannot go to the workers
      allowPicking: false,          // clicks fall through to the survey shots
      releaseGeometryInstances: true,
      show: imp.visible !== false,
    }));
  }

  return { buildCavePassages: _buildCavePassages, removeCavePassages: _removeCavePassages, setCavePassageVisible: _setCavePassageVisible };
}
