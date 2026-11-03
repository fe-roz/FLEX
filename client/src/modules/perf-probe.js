// perf-probe.js — the always-on, cheap frame measurement behind the Performance panel (perf-panel.js).
//
// Two halves in one file (a classic script; Node can require() it for the pure half):
//   - PURE (module.exports in Node, window._perfPure in the page): percentiles / summaries of frame times,
//     trimmed means, fps gain of a what-if, ranking of suggestions, the "running slowly" pill's state
//     machine, the split of a frame into the panel's categories. Node-tested by tools/test_perf_pure.js.
//   - PROBE (window._perfProbe): what render-loop.js calls every frame. Per frame about a dozen
//     performance.now() reads and a few array writes (well under 0.1 ms; the panel measures it).
//
// render-loop.js calls:  frame(ts) at the top, lap(name) after each stage (the time since the previous
// lap is added to that stage), wrapBegin(0|1) / wrapEnd(0|1) around Cesium's and Potree's render
// (GPU timer queries when the browser has EXT_disjoint_timer_query_webgl2), end() at the bottom.
// Stages: own, cesium, minimap, potreeUpdate, potreeRender, incidence, compass, labels, measure.
// Inside the Cesium stage three sub-timers (not laps) add up: entities (the clock tick, where Cesium
// updates every entity), globe (terrain tile selection and drawing set-up) and imagery (map layers:
// the part of the globe's work spent on imagery layers). attachCesium() installs them; every wrapper is
// guarded, so a different Cesium version just leaves them at 0.
//
// Labels & points (stage 'pts'): the cost of drawing many labels / point billboards used to be filed under Terrain &
// globe (Cesium registers a height callback per clamped point, run inside the globe's endFrame) and Cesium (the
// primitive collections' update). attachCesium() now times, by wrapping the functions (each is guarded and skipped
// when Cesium lacks it), the work that belongs to labels and points, and files it where it ran so nothing is counted
// twice:  ptsEnt   LabelVisualizer / BillboardVisualizer / PointVisualizer .update (inside the clock tick, i.e. inside
//                  the 'entities' timer),
//         ptsPrim  LabelCollection / BillboardCollection / PointPrimitiveCollection .update (building the draw commands,
//                  inside Cesium's scene render) and the page's own per-frame label code (timed(), e.g. the LiDAR
//                  HTML names), via the nesting depth so a LabelCollection's inner BillboardCollection counts once,
//         ptsGlobe the callbacks Cesium runs when a clamped point's height arrives (Scene.updateHeight's callback),
//                  inside the globe's endFrame (the 'globe' timer).
// categories() subtracts each from the timer it ran inside. Not measured: the terrain search that finds a clamped
// point's height (time-sliced to 2 ms a frame inside the globe's endFrame) and the draw calls themselves (GPU); the
// panel's what-if tests (labels off, points off) show the whole cost.
//
// Long frames are real: a frame is the gap between two animation frames. A hidden tab (visibilitychange, or a
// document that is hidden) does not run frames, so the first frame after it is not a frame at all (its gap is
// dropped); every other gap counts, however long, up to 30 s (a suspended laptop). FLEX renders on every animation
// frame (render-loop.js calls viewer.render() itself), so a long gap on a visible page is a slow frame, never idle.
// P.renders counts Cesium postRender events (a render that really finished).
// Jerkiness: hitchStep() keeps a slow running average of the frame time and counts a frame as a hitch when it is
// over twice that average and over 33 ms (the eye sees it); hitchCount(ms) = hitches in the last ms.
//
// window._perfProbe = { enabled, count, frame, lap, end, wrapBegin, wrapEnd, attachCesium, attachGpu, gpu,
//                       stats(n), dtsSince(count), recentFps(ms), hitchCount(ms), hitchTimes, timed(fn), renders, cfg }
(function (root, factory) {
  'use strict';
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m.pure;
  else { root._perfPure = m.pure; root._perfProbe = m.makeProbe(); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // ── Pure ────────────────────────────────────────────────────────────────
  /** p in 0..1 of an ascending array, linear between neighbours. */
  function percentile(sorted, p) {
    const n = sorted.length;
    if (!n) return NaN;
    if (n === 1) return sorted[0];
    const x = Math.min(1, Math.max(0, p)) * (n - 1), i = Math.floor(x), f = x - i;
    return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
  }
  /** Frame times in ms. Every real frame counts, long ones too (the probe already dropped hidden-tab gaps); `cap` (30 s) only drops a suspended machine's gap. */
  function summarize(dts, cap) {
    const lim = cap || 30000, a = [];
    for (let i = 0; i < dts.length; i++) { const v = dts[i]; if (v > 0 && v <= lim) a.push(v); }
    if (!a.length) return { n: 0, mean: NaN, fps: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN };
    a.sort((x, y) => x - y);
    let s = 0; for (const v of a) s += v;
    const mean = s / a.length;
    // 1% low: the frame rate of the slowest hundredth of the frames (at least one frame)
    const k = Math.max(1, Math.round(a.length * 0.01)); let w = 0; for (let i = a.length - k; i < a.length; i++) w += a[i];
    const p50 = percentile(a, 0.5), p95 = percentile(a, 0.95);
    return { n: a.length, mean, fps: 1000 / mean, p50, p95, p99: percentile(a, 0.99), max: a[a.length - 1], low1: 1000 / (w / k), jitter: p50 > 0 ? p95 / p50 : NaN };
  }
  /** One frame into the hitch counter. st = { ema, hits: [times] }; a hitch is a frame over 2 x the running average and over `minMs`. Returns true on a hitch. */
  function hitchStep(st, dt, now, minMs) {
    if (!(dt > 0)) return false;
    const lim = minMs == null ? 33.4 : minMs;
    const hit = st.ema > 0 && dt > 2 * st.ema && dt > lim;
    if (hit) { st.hits.push(now); if (st.hits.length > 400) st.hits.shift(); }
    else st.ema = st.ema > 0 ? st.ema * 0.97 + dt * 0.03 : dt;      // hitches do not drag the average up
    return hit;
  }
  const hitchesIn = (st, now, ms) => { let n = 0; for (let i = st.hits.length - 1; i >= 0 && now - st.hits[i] <= ms; i--) n++; return n; };
  /** Plain words for the jerkiness. hits = hitches in the last 10 s. */
  function verdict(hits, fps) {
    if (isFinite(fps) && fps < 20) return { id: 'slow', text: 'slow: ' + (fps < 10 ? fps.toFixed(1) : Math.round(fps)) + ' fps' + (hits >= 3 ? ', and jerky' : '') };
    if (hits >= 3) return { id: 'jerky', text: 'jerky: ' + hits + ' hitches in 10 s' };
    return { id: 'smooth', text: hits ? 'smooth (' + hits + ' hitch' + (hits > 1 ? 'es' : '') + ' in 10 s)' : 'smooth' };
  }
  /** Mean after dropping the slowest `drop` share (one long hiccup should not decide a what-if test). */
  function trimmedMean(arr, drop) {
    const a = Array.from(arr).filter(v => v > 0 && v <= 30000).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const keep = Math.max(1, Math.round(a.length * (1 - (drop == null ? 0.1 : drop))));
    let s = 0; for (let i = 0; i < keep; i++) s += a[i];
    return s / keep;
  }
  /** fps gained when a frame goes from baseMs to offMs. */
  function fpsGain(baseMs, offMs) { return 1000 / offMs - 1000 / baseMs; }
  /** The gain if `savedMs` of a `frameMs` frame disappeared (an estimate, not a test). */
  function estGainFps(frameMs, savedMs) { return savedMs > 0 && frameMs > 0 ? fpsGain(frameMs, Math.max(1, frameMs - savedMs)) : 0; }
  /** Suggestions best first: measured before estimated at the same gain; below `minFps` they are left out. */
  function rank(cands, minFps) {
    const lim = minFps == null ? 0.5 : minFps;
    return cands.filter(c => c && c.gainFps >= lim)
      .sort((a, b) => (b.gainFps - a.gainFps) || ((b.measured ? 1 : 0) - (a.measured ? 1 : 0)) || String(a.id).localeCompare(String(b.id)));
  }
  /**
   * The "Running slowly" pill. st = { lowSince, fired }; call about once a second.
   * ctx = { hidden, loading, sinceLoadMs }; cfg = { lowFps, lowMs, warmupMs }. Returns true once, when fps has
   * stayed under lowFps for lowMs outside the quiet times (hidden tab, project loading, the first warmupMs).
   */
  function pillStep(st, nowMs, fps, ctx, cfg) {
    if (st.fired) return false;
    if (ctx.hidden || ctx.loading || ctx.sinceLoadMs < cfg.warmupMs || !(fps >= 0)) { st.lowSince = null; return false; }
    if (fps >= cfg.lowFps) { st.lowSince = null; return false; }
    if (st.lowSince == null) st.lowSince = nowMs;
    if (nowMs - st.lowSince >= cfg.lowMs) { st.fired = true; return true; }
    return false;
  }
  /**
   * A frame's average stages (ms, by probe stage name, plus entities/globe/imagery sub-timers) and its length
   * → the panel's categories, in stacking order. `idleBelowMs`: a frame shorter than this is held to the
   * screen's refresh, so the gap is "waiting", not GPU work. gpuMs (measured) replaces the estimate.
   */
  function categories(avg, frameMs, opts) {
    const o = opts || {}, g = k => Math.max(0, avg[k] || 0);
    const imagery = Math.min(g('imagery'), g('cesium'));
    const globeNet = Math.max(0, Math.min(g('globe'), g('cesium')) - imagery);
    const entities0 = Math.min(g('entities'), g('cesium'));
    // labels & points: each piece is taken out of the timer it ran inside (see the header)
    const pE = Math.min(g('ptsEnt'), entities0), pG = Math.min(g('ptsGlobe'), globeNet);
    const entities = entities0 - pE, globeNet2 = globeNet - pG;
    const scene0 = Math.max(0, g('cesium') - entities0 - globeNet - imagery), pP = Math.min(g('ptsPrim'), scene0);
    const scene = scene0 - pP;
    const rows = [
      { id: 'cloud', label: 'Point clouds', ms: g('potreeUpdate') + g('potreeRender') },
      { id: 'terrain', label: 'Terrain & globe', ms: globeNet2 + scene },
      { id: 'layers', label: 'Map layers', ms: imagery },
      { id: 'features', label: 'Features & lines', ms: entities + g('labels') },
      { id: 'pts', label: 'Labels & points', ms: pE + pG + pP },
      { id: 'own', label: "FLEX's own work", ms: g('own') + g('minimap') + g('incidence') + g('compass') + g('measure') },
    ];
    const cpu = rows.reduce((s, r) => s + r.ms, 0);
    let gpu = 0, idle = 0, gpuMeasured = false;
    if (o.gpuMs != null && o.gpuMs >= 0) { gpu = o.gpuMs; gpuMeasured = true; idle = Math.max(0, frameMs - Math.max(cpu, gpu)); }
    else if (frameMs > (o.idleBelowMs == null ? 17.5 : o.idleBelowMs)) gpu = Math.max(0, frameMs - cpu);
    else idle = Math.max(0, frameMs - cpu);
    rows.push({ id: 'gpu', label: gpuMeasured ? 'GPU (measured)' : 'GPU (estimated)', ms: gpu });
    return { rows, cpu, idle, gpuMeasured, own: { own: g('own'), minimap: g('minimap'), incidence: g('incidence'), compass: g('compass'), measure: g('measure') } };
  }
  const fmtMs = v => (v == null || !isFinite(v) ? '–' : (v < 10 ? v.toFixed(1) : v >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v))) + ' ms');
  const fmtCount = v => (v == null || !isFinite(v) ? '–' : v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + ' M' : v >= 1e4 ? Math.round(v / 1e3) + ' k' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' k' : String(Math.round(v)));
  const pure = { hitchStep, hitchesIn, verdict, percentile, summarize, trimmedMean, fpsGain, estGainFps, rank, pillStep, categories, fmtMs, fmtCount };

  // ── Probe (the page) ────────────────────────────────────────────────────
  function makeProbe() {
    if (typeof performance === 'undefined') return null;
    const NAMES = ['own', 'cesium', 'minimap', 'potreeUpdate', 'potreeRender', 'incidence', 'compass', 'labels', 'measure', 'entities', 'globe', 'imagery', 'ptsEnt', 'ptsPrim', 'ptsGlobe'];
    const IDX = {}; NAMES.forEach((n, i) => { IDX[n] = i; });
    const N = NAMES.length, W = 300;                       // ring of the last 300 frames
    const dts = new Float64Array(W), cpu = new Float64Array(W), buf = new Float64Array(W * N), cur = new Float64Array(N);
    const now = () => performance.now();
    const gpuCtx = [null, null];                           // 0 Cesium, 1 Potree
    const P = {
      enabled: true, count: 0, W, NAMES, IDX, last: 0, lastTs: 0, t0: 0, inC: false, inEnt: false, renders: 0,
      cfg: { warmupMs: 15000, lowFps: 20, lowMs: 10000, jerkyHits: 5 },
      hitch: { ema: 0, hits: [] }, hitchTimes: null,
      gpu: { mode: 'estimated', ms: null, why: 'no timer query in this browser' },
    };
    P.hitchTimes = P.hitch.hits;
    // A hidden tab runs no frames: the gap around it is not a frame (the first frame after it reads 0 and is skipped).
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { P.lastTs = 0; P.hitch.ema = 0; });
    P.frame = function (ts) {
      if (!P.enabled) { P.lastTs = 0; return; }
      const hid = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const dt = P.lastTs && !hid ? ts - P.lastTs : 0;
      dts[P.count % W] = dt;
      if (dt > 0) hitchStep(P.hitch, dt, now());
      P.lastTs = hid ? 0 : ts; P.t0 = P.last = now();
    };
    /** Hitches (jerky frames) in the last `ms` of real time. */
    P.hitchCount = function (ms) { return hitchesIn(P.hitch, now(), ms || 10000); };
    P.lap = function (name) {
      if (!P.enabled) return;
      const t = now(); cur[IDX[name]] += t - P.last; P.last = t;
    };
    P.end = function () {
      if (!P.enabled) return;
      const i = P.count % W, o = i * N;
      cpu[i] = now() - P.t0;
      for (let k = 0; k < N; k++) buf[o + k] = cur[k];
      cur.fill(0);
      P.count++;
      if (gpuCtx[0] || gpuCtx[1]) pollGpu();
    };
    P.wrapBegin = function (i) {
      if (i === 0) { P.inC = true; P.inEnt = true; }
      const g = gpuCtx[i]; if (!g || !P.enabled) return;
      try { if (g.pending.length > 6) return; g.q = g.gl.createQuery(); g.gl.beginQuery(g.ext.TIME_ELAPSED_EXT, g.q); g.open = true; } catch (_) { dropGpu(); }
    };
    P.wrapEnd = function (i) {
      if (i === 0) { P.inC = false; P.inEnt = false; }
      const g = gpuCtx[i]; if (!g || !g.open) return;
      try { g.gl.endQuery(g.ext.TIME_ELAPSED_EXT); g.pending.push(g.q); } catch (_) { dropGpu(); }
      g.open = false; g.q = null;
    };

    // Averages over the last n frames: { n, frameMs (mean interval), cpuMs, avg: {stage: ms}, summary }
    P.stats = function (n) {
      const m = Math.min(P.count, W, n || 120), a = {}, iv = [];
      NAMES.forEach(k => { a[k] = 0; });
      let c = 0;
      for (let j = 1; j <= m; j++) {
        const i = ((P.count - j) % W + W) % W;
        for (let k = 0; k < N; k++) a[NAMES[k]] += buf[i * N + k];
        c += cpu[i]; iv.push(dts[i]);
      }
      if (m) { NAMES.forEach(k => { a[k] /= m; }); c /= m; }
      const s = summarize(iv);
      return { n: m, frameMs: s.mean, cpuMs: c, avg: a, summary: s };
    };
    /** Frame intervals since `count0` (the count when you started waiting). */
    P.dtsSince = function (count0) {
      const m = Math.min(P.count - count0, W - 1), out = [];
      for (let j = 1; j <= m; j++) out.push(dts[((P.count - j) % W + W) % W]);
      return out;
    };
    /** Frames per second over about the last `ms`; a page whose frames stopped reads as a very low number. */
    P.recentFps = function (ms) {
      const lim = ms || 1000; let sum = 0, n = 0;
      for (let j = 1; j <= Math.min(P.count, W); j++) {
        const d = dts[((P.count - j) % W + W) % W];
        if (!(d > 0)) break;
        sum += d; n++; if (sum >= lim) break;
      }
      const idle = P.t0 ? now() - P.t0 : 0;
      if (idle > lim * 1.5) return 1000 / idle;
      return n && sum ? n / (sum / 1000) : NaN;
    };

    // GPU timer queries, when the browser offers them (Chrome often does not; then GPU time is frame time minus CPU).
    function dropGpu() { gpuCtx[0] = gpuCtx[1] = null; P.gpu = { mode: 'estimated', ms: null, why: 'the timer query failed' }; }
    P.attachGpu = function (glCesium, glPotree) {
      try {
        [glCesium, glPotree].forEach((gl, i) => {
          if (!gl || gl.constructor.name !== 'WebGL2RenderingContext') return;
          const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
          if (ext) gpuCtx[i] = { gl, ext, pending: [], q: null, open: false, ms: null };
        });
        if (gpuCtx[0] || gpuCtx[1]) P.gpu = { mode: 'timer', ms: null, why: '' };
      } catch (_) { dropGpu(); }
    };
    function pollGpu() {
      try {
        for (const g of gpuCtx) {
          if (!g) continue;
          const gl = g.gl;
          while (g.pending.length) {
            const q = g.pending[0];
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
            g.pending.shift();
            const bad = gl.getParameter(g.ext.GPU_DISJOINT_EXT);
            if (!bad) { const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; g.ms = g.ms == null ? ms : g.ms * 0.8 + ms * 0.2; }
            gl.deleteQuery(q);
          }
        }
        const a = gpuCtx[0] && gpuCtx[0].ms, b = gpuCtx[1] && gpuCtx[1].ms;
        if (a != null || b != null) { P.gpu.ms = (a || 0) + (b || 0); P.gpu.mode = 'measured'; }
      } catch (_) { dropGpu(); }
    }

    // Sub-timers inside Cesium's render: the clock tick (entities) and the globe / imagery methods.
    let depthG = 0, depthI = 0;
    function wrap(obj, name, idx, isImagery) {
      const f = obj && obj[name];
      if (typeof f !== 'function' || f.__perf) return false;
      const w = function () {
        if (!P.enabled || !P.inC) return f.apply(this, arguments);
        const first = isImagery ? depthI++ === 0 : depthG++ === 0, t = now();
        try { return f.apply(this, arguments); }
        finally { if (isImagery) depthI--; else depthG--; if (first) cur[idx] += now() - t; }
      };
      w.__perf = true; w.__orig = f; obj[name] = w;
      return true;
    }
    // Labels & points: time `f` (called with the nesting depth guard) into the bucket for where it ran.
    let depthP = 0;
    function ptsBucket() { return P.inEnt ? IDX.ptsEnt : depthG > 0 ? IDX.ptsGlobe : IDX.ptsPrim; }
    function timedFn(f, forceBucket) {
      return function () {
        if (!P.enabled || !P.inC) return f.apply(this, arguments);
        const first = depthP++ === 0, t = now();
        try { return f.apply(this, arguments); }
        finally { depthP--; if (first) cur[forceBucket != null ? forceBucket : ptsBucket()] += now() - t; }
      };
    }
    function wrapPts(obj, name) {
      const f = obj && obj[name];
      if (typeof f !== 'function' || f.__perf) return false;
      const w = timedFn(f); w.__perf = true; w.__orig = f; obj[name] = w;
      return true;
    }
    /** For the page's own per-frame label code: P.timed(fn) returns fn, timed into Labels & points. */
    P.timed = function (fn) { return timedFn(fn, IDX.ptsPrim); };
    P.attachCesium = function (viewer, Cesium) {
      const done = { tick: false, globe: 0, imagery: 0, pts: 0 };
      try {
        viewer.clock.onTick.addEventListener(() => { if (P.enabled && P.inC) { cur[IDX.entities] += now() - P.last; P.inEnt = false; } });
        done.tick = true;
      } catch (_) {}
      try { viewer.scene.postRender.addEventListener(() => { P.renders++; }); } catch (_) {}
      try {
        ['LabelVisualizer', 'BillboardVisualizer', 'PointVisualizer', 'LabelCollection', 'BillboardCollection', 'PointPrimitiveCollection']
          .forEach(n => { if (Cesium && Cesium[n] && wrapPts(Cesium[n].prototype, 'update')) done.pts++; });
        const SP = Cesium && Cesium.Scene && Cesium.Scene.prototype;      // the callbacks that put a clamped point at its height
        if (SP && typeof SP.updateHeight === 'function' && !SP.updateHeight.__perf) {
          const orig = SP.updateHeight;
          SP.updateHeight = function (c, cb, hr) { return orig.call(this, c, typeof cb === 'function' ? timedFn(cb) : cb, hr); };
          SP.updateHeight.__perf = true; done.pts++;
        }
      } catch (_) {}
      try { ['update', 'beginFrame', 'render', 'endFrame'].forEach(n => { if (wrap(viewer.scene.globe, n, IDX.globe, false)) done.globe++; }); } catch (_) {}
      try {
        const proto = Cesium && Cesium.ImageryLayer && Cesium.ImageryLayer.prototype;
        ['_createTileImagerySkeletons', '_requestImagery', '_createTexture', '_finalizeReprojectTexture', '_reprojectTexture', 'queueReprojectionCommands']
          .forEach(n => { if (wrap(proto, n, IDX.imagery, true)) done.imagery++; });
      } catch (_) {}
      P.attached = done;
      return done;
    };
    return P;
  }
  return { pure, makeProbe };
});
