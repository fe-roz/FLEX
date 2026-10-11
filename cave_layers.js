// cave_layers.js — fast drawing for cave survey lines and station dots, and
// the colour ramp shared with the portable viewer.
//
// Lines and stations used to be one Cesium Entity per shot and per station.
// Entities are re-checked by Cesium's visualizers every frame whether or not
// anything changed, so a few thousand of them dragged the whole map down, even
// with their labels hidden. Here each cave gets:
//   • one Primitive for all its lines — a polyline per chain of shots, with a
//     colour per vertex (so elevation can be a gradient along a shot);
//   • one PointPrimitiveCollection for its station dots, and a LabelCollection
//     only while station names are switched on.
// Clicks still open the info box: every line and dot carries a small "lazy"
// pick id, turned into a detached Entity (name, description, position,
// properties) only when it is actually clicked — see installLazyPick.

const C = () => window.Cesium;

// Cool (low) → warm (high); the portable viewer's ramp, same stops.
export const RAMP = ['#3b1c8c', '#2a5fd6', '#1fb3d6', '#35c46a', '#c6dc2f', '#ffc61a'];
const RAMP_RGB = RAMP.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
export const RAMP_UNKNOWN = '#8a8f98';

// t in 0..1 → [r, g, b] (0..1); NaN → the "unknown" grey.
export function rampRgb(t) {
  if (!Number.isFinite(t)) return [0x8a / 255, 0x8f / 255, 0x98 / 255];
  const f = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(f)), u = f - i, a = RAMP_RGB[i], b = RAMP_RGB[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
export function rampColor(t, alpha = 1) {
  const [r, g, b] = rampRgb(t);
  return new (C().Color)(r, g, b, alpha);
}
// reverse: warm on the left (depth below ground reads shallow → deep).
export function rampCss(reverse = false) {
  return `linear-gradient(90deg, ${(reverse ? RAMP.slice().reverse() : RAMP).join(', ')})`;
}

// 2nd–98th percentile of a list of numbers, so one odd station can't flatten
// the ramp. Null when there is nothing to measure.
export function percentileRange(values, lo = 0.02, hi = 0.98) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = q => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
  let a = at(lo), b = at(hi);
  if (b - a < 1) { const m = (a + b) / 2; a = m - 0.5; b = m + 0.5; }
  return { lo: a, hi: b };
}

// ── Passage difficulty ───────────────────────────────────────────────────────
// The portable viewer's scoring (viewer.html, "Passage difficulty"), so both
// colour a cave the same. From measured LRUDs only: width = L+R, height = U+D.
// Three scores, 0 (fine) to 1 (worst), mixed additively so combinations show:
//   narrow — starts at 3 ft wide, worst at 1 ft                → blue
//   low    — 6 ft stooping, 4 ft crawl, 2 ft flat-out           → red
//            (narrow *and* low, a tube                          → magenta)
//   steep  — shots of 50° or more that also rise or fall 10 ft
//            or more; brighter toward vertical                   → green
// No measured LRUD (missing, sentinels, 0/0/0/0) is "unknown" (dark grey),
// never read as tight.
export const FT = 0.3048;
const HARD_EASY = [0x9a / 255, 0xa0 / 255, 0xaa / 255];
export const HARD_UNKNOWN = [0x3c / 255, 0x3f / 255, 0x46 / 255];
const HARD_NARROW = [0.10, 0.38, 1.0], HARD_LOW = [1.0, 0.08, 0.05], HARD_STEEP = [0.15, 0.95, 0.20];
const STEEP_MIN_DEG = 50, STEEP_MIN_DZ = 10 * FT;

// {W, H} in metres (either may be null) from an {l, r, u, d} reading, or null
// when nothing in it was measured.
export function lrudWH(lr) {
  if (!lr) return null;
  const a = [lr.l, lr.r, lr.u, lr.d];
  if (a.every(v => Number.isFinite(v) && Math.abs(v) < 1e-6)) return null;     // placeholder
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 90;
  const W = ok(a[0]) && ok(a[1]) ? a[0] + a[1] : null;
  const H = ok(a[2]) && ok(a[3]) ? a[2] + a[3] : null;
  return (W === null && H === null) ? null : { W, H };
}
const lerpScore = (x, pts) => {            // piecewise-linear [[value, score], …] by falling value
  if (x >= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x >= pts[i][0]) { const [x0, s0] = pts[i - 1], [x1, s1] = pts[i]; return s0 + (s1 - s0) * (x0 - x) / (x0 - x1); }
  }
  return pts[pts.length - 1][1];
};
export const narrowScore = W => W == null ? 0 : lerpScore(W, [[3 * FT, 0], [1 * FT, 1]]);
export const lowScore    = H => H == null ? 0 : lerpScore(H, [[6 * FT, 0], [4 * FT, 0.35], [2 * FT, 0.75], [1 * FT, 1]]);
// A shot's steepness from its horizontal length and rise (either sign).
export function steepScore(hz, dz) {
  const deg = Math.atan2(Math.abs(dz), hz) * 180 / Math.PI;
  if (!(deg >= STEEP_MIN_DEG && Math.abs(dz) >= STEEP_MIN_DZ)) return 0;
  return 0.3 + 0.7 * Math.pow((Math.min(90, deg) - STEEP_MIN_DEG) / (90 - STEEP_MIN_DEG), 0.7);
}
// Scores → [r, g, b] (0..1); known false → the unknown grey.
export function hardRgb(w, h, s, known) {
  const base = known ? HARD_EASY : HARD_UNKNOWN;
  const m = Math.min(1, Math.max(w, h, s));
  let r = base[0] * (1 - m) + HARD_NARROW[0] * w + HARD_LOW[0] * h + HARD_STEEP[0] * s;
  let g = base[1] * (1 - m) + HARD_NARROW[1] * w + HARD_LOW[1] * h + HARD_STEEP[1] * s;
  let b = base[2] * (1 - m) + HARD_NARROW[2] * w + HARD_LOW[2] * h + HARD_STEEP[2] * s;
  g *= 1 - 0.8 * Math.min(w, h);                            // narrow and low: a stark magenta
  const mx = Math.max(1, r, g, b);                           // keep the hue when channels add past 1
  return [r / mx, g / mx, b / mx];
}
// One reading's colour (a station dot, or a line end); steep: its shot's score.
export function whRgb(wh, steep = 0) {
  return hardRgb(wh ? narrowScore(wh.W) : 0, wh ? lowScore(wh.H) : 0, steep, !!wh || steep > 0);
}
// A wall point a fraction t along a shot: the size eased between the two ends
// (smoothstep, as the walls are drawn), then scored, so a roomy shot ending in
// a squeeze stays grey until its walls close in. WA/HA/WB/HB: NaN = not
// measured; it fades to unknown toward an unmeasured end.
export function wallHardRgb(WA, HA, WB, HB, steep, t) {
  const u = t * t * (3 - 2 * t);
  const ease = (a, b) => a !== a ? (b !== b ? null : b) : b !== b ? a : a + (b - a) * u;
  const W = ease(WA, WB), H = ease(HA, HB);
  const kA = (WA === WA || HA === HA) ? 1 : 0, kB = (WB === WB || HB === HB) ? 1 : 0;
  const kw = steep > 0 ? 1 : kA + (kB - kA) * u;
  const c = hardRgb(W == null ? 0 : narrowScore(W), H == null ? 0 : lowScore(H), steep, kw > 0);
  if (kw > 0 && kw < 1) for (let i = 0; i < 3; i++) c[i] = c[i] + (HARD_UNKNOWN[i] - c[i]) * (1 - kw);
  return c;
}
// Legend rows: [css background, label].
export function hardLegendRows() {
  const css = c => `rgb(${c.map(x => Math.round(x * 255)).join(',')})`;
  const grad = f => `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map(t => css(f(t))).join(', ')})`;
  return [
    [grad(t => hardRgb(t, 0, 0, true)), 'Narrow: 3 ft → 1 ft wide'],
    [grad(t => hardRgb(0, t, 0, true)), 'Low: 6 → 4 → 2 ft high'],
    [grad(t => hardRgb(t, t, 0, true)), 'Narrow and low (tube)'],
    [grad(t => hardRgb(0, 0, t ? 0.3 + 0.7 * t : 0, true)), 'Steep: ≥50° and ≥10 ft up/down'],
    [css(HARD_UNKNOWN), 'No LRUD measured'],
  ];
}

// A pick id that becomes a real Entity only when clicked. `make(screenPos)`
// returns the Entity options ({name, description, position, properties});
// byPos: the result depends on where it was clicked (a chain of shots).
export function lazyPick(make, byPos = false) {
  return { _caveLazy: true, _make: make, _byPos: !!byPos, _entity: null, _at: null };
}
export function materialize(id, screenPos) {
  const Cs = C();
  if (!id || !id._caveLazy) return id;
  // Lines pick by click position (which shot of the chain), so rebuild when
  // the click moved; dots are the same wherever they are clicked.
  const key = screenPos ? Math.round(screenPos.x) + ',' + Math.round(screenPos.y) : '';
  if (!id._entity || (id._byPos && id._at !== key)) {
    id._entity = new Cs.Entity(id._make(screenPos));
    id._at = key;
  }
  return id._entity;
}

// Route the viewer's own click (and double-click) through materialize, so the
// info box, the selection indicator and selectedEntityChanged all see an
// ordinary Entity. Call once.
export function installLazyPick(viewer) {
  const Cs = C(), h = viewer.screenSpaceEventHandler;
  for (const type of [Cs.ScreenSpaceEventType.LEFT_CLICK, Cs.ScreenSpaceEventType.LEFT_DOUBLE_CLICK]) {
    const orig = h.getInputAction(type);
    if (!orig) continue;
    h.setInputAction(e => {
      const picked = viewer.scene.pick(e.position);
      const id = picked && picked.id;
      if (id && id._caveLazy) {
        const ent = materialize(id, e.position);
        if (type === Cs.ScreenSpaceEventType.LEFT_CLICK) viewer.selectedEntity = ent;
        else viewer.trackedEntity = undefined;
        return;
      }
      orig(e);
    }, type);
  }
}

// chains: [{ positions: Cartesian3[], colors: Color[] (one per position),
//            width, id }] → one Primitive (added to scene.primitives).
export function addLinePrimitive(scene, chains, { show = true } = {}) {
  const Cs = C();
  const instances = [];
  let translucent = false;
  for (const ch of chains) {
    if (!ch.positions || ch.positions.length < 2) continue;
    if (ch.colors.some(c => c.alpha < 1)) translucent = true;
    instances.push(new Cs.GeometryInstance({
      id: ch.id,
      geometry: new Cs.PolylineGeometry({
        positions: ch.positions, colors: ch.colors, colorsPerVertex: true,
        width: ch.width || 1.5, arcType: Cs.ArcType.NONE,
      }),
    }));
  }
  if (!instances.length) return null;
  return scene.primitives.add(new Cs.Primitive({
    geometryInstances: instances,
    appearance: new Cs.PolylineColorAppearance({ translucent }),
    releaseGeometryInstances: true,
    show,
  }));
}

// dots: [{ position, color, id, label }] → { points, labels? } (both added).
export function addStationLayer(scene, dots, { pixelSize = 5, labels = false, ddc, show = true } = {}) {
  const Cs = C();
  const points = scene.primitives.add(new Cs.PointPrimitiveCollection());
  points.show = show;
  for (const d of dots) {
    points.add({ position: d.position, pixelSize, color: d.color, outlineColor: Cs.Color.BLACK, outlineWidth: 1,
                 disableDepthTestDistance: 5000, distanceDisplayCondition: ddc, id: d.id });
  }
  let lab = null;
  if (labels) {
    lab = scene.primitives.add(new Cs.LabelCollection());
    lab.show = show;
    for (const d of dots) {
      if (!d.label) continue;
      lab.add({ position: d.position, text: d.label, font: '10px sans-serif', fillColor: Cs.Color.WHITE,
                style: Cs.LabelStyle.FILL, pixelOffset: new Cs.Cartesian2(0, -14),
                disableDepthTestDistance: 5000, distanceDisplayCondition: ddc, id: d.id });
    }
  }
  return { points, labels: lab };
}

export function removePrimitive(scene, p) {
  if (p && !p.isDestroyed()) scene.primitives.remove(p);     // remove() destroys it
}
