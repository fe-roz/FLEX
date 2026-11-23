// ridge-draw.js — a processed area's RIDGEWALKING result on the Cesium globe (window._ridgeDraw).
// The result is what 🔬 Analyze → Analyze by area → Ridgewalking made (areas_api.js runs ridgewalk.py, then ridge_area.py),
// read through /api/areas/file/<area>/ridge/: draw.json (where the area is, its ground on a coarse lattice, the list
// of features), shapes.bin (RWS1), points.bin (RWP1), patches.bin (RWQ1: the true-entrance and guessed-opening cells).
// The same things the phone shows (viewer_build/libs/ridgewalk.js), with FLEX's own map and controls:
//
//   shapes    the walls of the features, coloured by depth with the phone's colours (yellow at the surface, orange
//             10 ft, red 20 ft, blue 30 ft and deeper: FlexRidge.rampColour, one table for both); ON at first
//   returns   dots by kind: grouped (by depth), lone white, likely noise pink, patterned noise light blue; OFF at first
//   openings  Cesium's terrain cannot have holes, so a true entrance is a BLACK patch on the ground and a guessed
//             opening the dark grey patch (#141312 at 0.72), one small square a cell
//   marks     the open project's marks (ridge-marks.js) are tied to the features here (FlexLib.rmarkMatch); a feature
//             marked "nothing" is greyed, and left out with Hide "nothing"
//
// How it is drawn: one primitive in scene.primitives with three kinds of DrawCommand in Cesium's OVERLAY pass, blended
// over the finished picture with NO depth test, so everything is seen through the ground (as on the phone, which draws
// the same things without a depth test) from above and from the side alike; nothing is hidden behind a hill. Typed
// arrays are built once a result (and again only when a "nothing" mark changes the colours); a frame is at most
// 1 + 1 + 4 draw calls an area and no work on the CPU; the scene is asked to render only when something changes.
// Positions are local east-north-up metres round the middle of the area (float32); the area's own metres (UTM from
// its origin) become places through draw.json's lattice of exact lon / lat, turned into ENU at two heights with
// Cesium, so there is no map projection here and no drift over a few km.
// Heights: with On terrain (default) the terrain the globe shows is sampled once on draw.json's coarse ground lattice
// and every vertex is moved by the difference to the area's own ground there, so features sit in the ground you see;
// off: the file's heights plus FLEX's point-cloud datum shift.
// A click on a feature (its anchor, middle or deepest point within 28 px, or anywhere over a large one: the phone's
// rule, RidgeMarks.nearestTap) selects it: the details panel shows what the phone's card shows and the four marks.
//
// window._ridgeDraw = { sync(want, areas), mount(box), loadData(id, { draw, shapes, points, patches }, name), load(id, base, name),
//   clear(id?), set(opts), get(), stats(id?), loaded(id?), flyTo(id), pick(x, y), subject(areaId, featureId), select(areaId, featureId), pure }
// Settings in localStorage flex.ridge.settings. Event 'flex-ridge-changed' after load / clear.
// Node (tools/test_ridge_draw.js): module.exports = the pure helpers.
(function () {
  'use strict';

  // ── Pure helpers ──────────────────────────────────────────────────────────
  const DEFAULTS = { shapes: true, ret: false, lone: false, noise: false, pattern: false, openings: true, marks: true, hideNothing: false, size: 3, opacity: 0.45, onTerrain: true };
  const KINDS = ['ret', 'lone', 'noise', 'pattern'];                 // by points.bin's kind number
  const KIND_RGB = [null, [255, 255, 255], [0xff, 0x4d, 0xd2], [0x7f, 0xd4, 0xff]];
  const TRUE_RGBA = [0, 0, 0, 235], GUESS_RGBA = [0x14, 0x13, 0x12, Math.round(0.72 * 255)];
  const DIM_RGB = [92, 94, 102];
  const PATCH_LIFT = 0.08, H_STEP = 1000;                            // patches lie this far above the ground; the second frame height
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && isFinite(n) ? n : d; };
  /** Settings made safe: o's fields over base (or DEFAULTS); unknown fields dropped, numbers clamped. */
  function clampSettings(o, base) {
    const b = Object.assign({}, DEFAULTS, base || {}), s = Object.assign({}, b);
    o = o || {};
    for (const k of ['shapes', 'ret', 'lone', 'noise', 'pattern', 'openings', 'marks', 'hideNothing', 'onTerrain']) if (k in o && o[k] != null) s[k] = !!o[k];
    if ('size' in o) s.size = Math.round(clamp(num(o.size, b.size), 1, 12));
    if ('opacity' in o) s.opacity = clamp(num(o.opacity, b.opacity), 0.05, 1);
    return s;
  }
  /** patches.bin → { nTrue, nGuess, cell, xyz } (views, nothing copied). */
  function parsePatchCells(buf) {
    if (!buf || buf.byteLength < 16) throw new Error('ridge: patches file too short');
    const b = new Uint8Array(buf, 0, 4);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'RWQ1') throw new Error('ridge: not a RWQ1 file');
    const dv = new DataView(buf), nTrue = dv.getUint32(4, true), nGuess = dv.getUint32(8, true), cell = dv.getFloat32(12, true);
    if (buf.byteLength < 16 + (nTrue + nGuess) * 12) throw new Error('ridge: patches file cut short');
    return { nTrue, nGuess, cell, xyz: new Float32Array(buf, 16, (nTrue + nGuess) * 3) };
  }
  /**
   * Where the area's own metres are on the globe. nodes0 / nodes1: the local east-north-up places (x, y, z triples) of an
   * n x n lattice over the rectangle w x h (row 0 south, x first) at height 0 and at height H_STEP. → place(x, y, z, out, o):
   * writes the ENU place of the point x east, y north of the origin at height z into out[o..o+2].
   */
  function placer(nodes0, nodes1, n, w, h) {
    const sx = (n - 1) / Math.max(1e-9, w), sy = (n - 1) / Math.max(1e-9, h);
    return function place(x, y, z, out, o) {
      let fx = x * sx, fy = y * sy;
      let i = Math.floor(fx), j = Math.floor(fy);
      if (i < 0) i = 0; else if (i > n - 2) i = n - 2;
      if (j < 0) j = 0; else if (j > n - 2) j = n - 2;
      fx -= i; fy -= j;
      const a = (j * n + i) * 3, b = a + 3, c = a + n * 3, d = c + 3, t = z / H_STEP;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      for (let k = 0; k < 3; k++) {
        const p0 = nodes0[a + k] * w00 + nodes0[b + k] * w10 + nodes0[c + k] * w01 + nodes0[d + k] * w11;
        const p1 = nodes1[a + k] * w00 + nodes1[b + k] * w10 + nodes1[c + k] * w01 + nodes1[d + k] * w11;
        out[o + k] = p0 + (p1 - p0) * t;
      }
    };
  }
  /** Bilinear value of a lattice g (nx x ny, row 0 south, over w x h) at x, y; NaN nodes are skipped (their weight goes to the others). */
  function lattice(g, nx, ny, w, h, x, y) {
    let fx = clamp(x / Math.max(1e-9, w), 0, 1) * (nx - 1), fy = clamp(y / Math.max(1e-9, h), 0, 1) * (ny - 1);
    const i = Math.min(Math.max(nx - 2, 0), Math.floor(fx)), j = Math.min(Math.max(ny - 2, 0), Math.floor(fy));
    fx -= i; fy -= j;
    const i1 = Math.min(nx - 1, i + 1), j1 = Math.min(ny - 1, j + 1);
    const v = [g[j * nx + i], g[j * nx + i1], g[j1 * nx + i], g[j1 * nx + i1]], wt = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    let s = 0, ws = 0;
    for (let k = 0; k < 4; k++) if (v[k] === v[k] && v[k] != null) { s += v[k] * wt[k]; ws += wt[k]; }
    return ws > 1e-9 ? s / ws : NaN;
  }
  /**
   * How far to move things up so they sit in the terrain shown: shown - ground on the coarse lattice, NaN where either is
   * unknown, those filled with the mean of the known ones (0 when none). → { at(x, y), mean, known }
   */
  function makeShift(ground, shown, nx, ny, w, h) {
    const d = new Float32Array(nx * ny); let s = 0, c = 0;
    for (let k = 0; k < d.length; k++) { const g = ground[k], t = shown ? shown[k] : NaN; if (g != null && g === g && t === t && t != null) { d[k] = t - g; s += d[k]; c++; } else d[k] = NaN; }
    const mean = c ? s / c : 0;
    for (let k = 0; k < d.length; k++) if (d[k] !== d[k]) d[k] = mean;
    return { at: (x, y) => lattice(d, nx, ny, w, h, x, y), mean, known: c };
  }
  const constShift = dz => ({ at: () => dz, mean: dz, known: 0 });
  /** The shapes' vertices: ENU positions (float32 x 3) and colours by depth (uint8 x 4). ramp(depth) -> [r, g, b] 0..1. */
  function buildShapes(H, place, shift, ramp) {
    const n = H.nv, pos = new Float32Array(n * 3), col = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = H.xyz[i * 3], y = H.xyz[i * 3 + 1];
      place(x, y, H.xyz[i * 3 + 2] + shift.at(x, y), pos, i * 3);
      const c = ramp(H.depth[i]);
      col[i * 4] = Math.round(c[0] * 255); col[i * 4 + 1] = Math.round(c[1] * 255); col[i * 4 + 2] = Math.round(c[2] * 255); col[i * 4 + 3] = 255;
    }
    return { pos, col, n };
  }
  /** The returns, sorted by kind so each kind is one range: { pos, col, ranges: [[first, count] x 4], order (new index -> file index) }. */
  function buildDots(P, place, shift, ramp) {
    const cnt = [0, 0, 0, 0];
    for (let i = 0; i < P.n; i++) if (P.kind[i] < 4) cnt[P.kind[i]]++;
    const first = [0, cnt[0], cnt[0] + cnt[1], cnt[0] + cnt[1] + cnt[2]], at = first.slice(), total = first[3] + cnt[3];
    const pos = new Float32Array(total * 3), col = new Uint8Array(total * 4), order = new Uint32Array(total);
    for (let i = 0; i < P.n; i++) {
      const k = P.kind[i]; if (k > 3) continue;
      const j = at[k]++, x = P.xyz[i * 3], y = P.xyz[i * 3 + 1];
      place(x, y, P.xyz[i * 3 + 2] + shift.at(x, y), pos, j * 3);
      const c = k === 0 ? ramp(P.depth[i]).map(v => Math.round(v * 255)) : KIND_RGB[k];
      col[j * 4] = c[0]; col[j * 4 + 1] = c[1]; col[j * 4 + 2] = c[2]; col[j * 4 + 3] = 255;
      order[j] = i;
    }
    return { pos, col, n: total, order, ranges: first.map((f, k) => [f, cnt[k]]) };
  }
  /** The openings: a small square a cell (two triangles), true entrances first (black), then guessed (dark grey). */
  function buildPatches(Q, place, shift) {
    const n = Q.nTrue + Q.nGuess, pos = new Float32Array(n * 18), col = new Uint8Array(n * 24), hc = Q.cell / 2;
    const C = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < n; i++) {
      const x = Q.xyz[i * 3], y = Q.xyz[i * 3 + 1], z = Q.xyz[i * 3 + 2] + PATCH_LIFT + shift.at(x, y), rgba = i < Q.nTrue ? TRUE_RGBA : GUESS_RGBA;
      for (let k = 0; k < 6; k++) {
        place(x + C[k][0] * hc, y + C[k][1] * hc, z, pos, i * 18 + k * 3);
        const o = i * 24 + k * 4; col[o] = rgba[0]; col[o + 1] = rgba[1]; col[o + 2] = rgba[2]; col[o + 3] = rgba[3];
      }
    }
    return { pos, col, n: n * 6, ranges: { true: [0, Q.nTrue * 6], guessed: [Q.nTrue * 6, Q.nGuess * 6] } };
  }
  /** Colours with the flagged vertices greyed: a copy of col0 (uint8 x 4) → { col, dimmed }. */
  function dimColours(col0, flag) {
    const col = new Uint8Array(col0); let dimmed = 0;
    for (let i = 0; i < flag.length; i++) if (flag[i]) { col[i * 4] = DIM_RGB[0]; col[i * 4 + 1] = DIM_RGB[1]; col[i * 4 + 2] = DIM_RGB[2]; dimmed++; }
    return { col, dimmed };
  }
  /** The triangles to draw when the flagged features are hidden: those not wholly inside. */
  function keptIndex(tri, flag) {
    const out = new Uint32Array(tri.length); let m = 0;
    for (let i = 0; i < tri.length; i += 3) if (!(flag[tri[i]] && flag[tri[i + 1]] && flag[tri[i + 2]])) { out[m++] = tri[i]; out[m++] = tri[i + 1]; out[m++] = tri[i + 2]; }
    return out.subarray(0, m);
  }
  const pure = { DEFAULTS, KINDS, KIND_RGB, TRUE_RGBA, GUESS_RGBA, DIM_RGB, PATCH_LIFT, H_STEP, clampSettings, parsePatchCells, placer, lattice, makeShift, constShift, buildShapes, buildDots, buildPatches, dimColours, keptIndex };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ── The page ──────────────────────────────────────────────────────────────
  const w = window, KEY = 'flex.ridge.settings';
  const V = () => w.cesiumViewer, Ces = () => w.Cesium;
  const FR = () => w.FlexRidge, RM = () => w.RidgeMarks, FL = () => w.FlexLib;
  const lget = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  let S = clampSettings((() => { try { return JSON.parse(lget(KEY) || '{}'); } catch (_) { return {}; } })());
  const sets = new Map();               // area id → the loaded result
  let prim = null, gen = 0, handler = null, proxy = null, proxySrc = null;
  const redraw = () => { const v = V(); if (v && v.scene && v.scene.requestRender) v.scene.requestRender(); };
  const fire = () => { try { w.dispatchEvent(new CustomEvent('flex-ridge-changed', { detail: { loaded: [...sets.keys()] } })); } catch (_) {} };
  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const VS = `in vec3 position;\nin vec4 color;\nuniform float u_size;\nout vec4 v_color;\nvoid main() {\n  gl_Position = czm_modelViewProjection * vec4(position, 1.0);\n  gl_PointSize = u_size;\n  v_color = color;\n}\n`;
  const FS = `in vec4 v_color;\nuniform float u_alpha;\nuniform float u_round;\nvoid main() {\n  if (u_round > 0.5 && length(gl_PointCoord - vec2(0.5)) > 0.5) discard;\n  out_FragColor = vec4(v_color.rgb, v_color.a * u_alpha);\n}\n`;

  // One object in scene.primitives: per area up to 1 (openings) + 1 (shapes) + 4 (kinds of returns) commands, OVERLAY pass.
  function makePrimitive() {
    const C = Ces();
    let prog = null, rs = null, destroyed = false;
    const ATTR = { position: 0, color: 1 };
    const pixel = () => (w.devicePixelRatio || 1);
    function ensure(context) {
      if (prog) return;
      prog = C.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: FS, attributeLocations: ATTR });
      rs = C.RenderState.fromCache({ cull: { enabled: false }, depthTest: { enabled: false }, depthMask: false, blending: C.BlendingState.ALPHA_BLEND });
    }
    function upload(context, mesh, index) {
      const attributes = [
        { index: 0, vertexBuffer: C.Buffer.createVertexBuffer({ context, typedArray: mesh.pos, usage: C.BufferUsage.STATIC_DRAW }), componentsPerAttribute: 3, componentDatatype: C.ComponentDatatype.FLOAT },
        { index: 1, vertexBuffer: C.Buffer.createVertexBuffer({ context, typedArray: mesh.col, usage: C.BufferUsage.STATIC_DRAW }), componentsPerAttribute: 4, componentDatatype: C.ComponentDatatype.UNSIGNED_BYTE, normalize: true },
      ];
      const indexBuffer = index ? C.Buffer.createIndexBuffer({ context, typedArray: index, usage: C.BufferUsage.STATIC_DRAW, indexDatatype: C.IndexDatatype.UNSIGNED_INT }) : undefined;
      return { va: new C.VertexArray({ context, attributes, indexBuffer }), count: index ? index.length : mesh.n };
    }
    const free = g => { if (g && g.va && !g.va.isDestroyed()) g.va.destroy(); };
    const cmd = (D, key, g, type, uniforms) => {
      const c = D.cmds[key] || (D.cmds[key] = new C.DrawCommand({ owner: api, pass: C.Pass.OVERLAY, cull: false }));
      c.vertexArray = g.va; c.primitiveType = type; c.shaderProgram = prog; c.renderState = rs; c.uniformMap = uniforms; c.modelMatrix = D.modelMatrix; c.boundingVolume = D.sphere;
      return c;
    };
    const U = { shapes: { u_size: () => 1, u_alpha: () => S.opacity, u_round: () => 0 }, patches: { u_size: () => 1, u_alpha: () => 1, u_round: () => 0 },
      dots: { u_size: () => S.size * pixel(), u_alpha: () => 1, u_round: () => 1 } };
    const api = {
      show: true, frames: 0, drawn: 0, calls: 0,
      update(frameState) {
        if (destroyed || !this.show || !frameState.passes.render) return;       // never in a pick pass: clicks are answered by pick()
        const context = frameState.context; ensure(context);
        const list = frameState.commandList, cv = frameState.cullingVolume;
        this.drawn = 0; this.calls = 0;
        sets.forEach(D => {
          if (D.pending) {
            const p = D.pending; D.pending = null;
            if (p.shapes !== undefined) { free(D.gpu.shapes); D.gpu.shapes = p.shapes ? upload(context, p.shapes, p.shapes.index) : null; }
            if (p.dots !== undefined) { free(D.gpu.dots); D.gpu.dots = p.dots ? upload(context, p.dots) : null; }
            if (p.patches !== undefined) { free(D.gpu.patches); D.gpu.patches = p.patches ? upload(context, p.patches) : null; }
          }
          if (!D.sphere || (cv && cv.computeVisibility(D.sphere) === C.Intersect.OUTSIDE)) return;
          const push = (c, offset, count) => { if (count > 0) { c.offset = offset; c.count = count; list.push(c); this.drawn += count; this.calls++; } };
          if (S.openings && D.gpu.patches) push(cmd(D, 'patches', D.gpu.patches, C.PrimitiveType.TRIANGLES, U.patches), 0, D.gpu.patches.count);
          if (S.shapes && D.gpu.shapes) push(cmd(D, 'shapes', D.gpu.shapes, C.PrimitiveType.TRIANGLES, U.shapes), 0, D.gpu.shapes.count);
          if (D.gpu.dots) KINDS.forEach((k, i) => { if (S[k]) push(cmd(D, 'dots' + i, D.gpu.dots, C.PrimitiveType.POINTS, U.dots), D.dots.ranges[i][0], D.dots.ranges[i][1]); });
        });
        this.frames++;
      },
      release(D) { if (D) { free(D.gpu.shapes); free(D.gpu.dots); free(D.gpu.patches); D.gpu = {}; D.cmds = {}; } },
      isDestroyed: () => destroyed,
      destroy() { sets.forEach(D => api.release(D)); if (prog) prog.destroy(); destroyed = true; return undefined; },
    };
    return api;
  }

  // ── Where and how high ────────────────────────────────────────────────────
  function frameOf(draw) {
    const C = Ces(), F = draw.frame, n = F.n, mid = F.lonlat[((n - 1) >> 1) * n + ((n - 1) >> 1)];
    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(mid[0], mid[1], 0));
    const inv = C.Matrix4.inverseTransformation(modelMatrix, new C.Matrix4());
    const nodes = hgt => { const a = new Float64Array(n * n * 3), p = new C.Cartesian3(), q = new C.Cartesian3();
      F.lonlat.forEach((ll, k) => { C.Cartesian3.fromDegrees(ll[0], ll[1], hgt, undefined, p); C.Matrix4.multiplyByPoint(inv, p, q); a[k * 3] = q.x; a[k * 3 + 1] = q.y; a[k * 3 + 2] = q.z; }); return a; };
    return { modelMatrix, place: placer(nodes(0), nodes(H_STEP), n, draw.size[0], draw.size[1]), origin: mid };
  }
  const lonLatAt = (draw, x, y) => { const F = draw.frame, n = F.n, lo = F.lonlat.map(p => p[0]), la = F.lonlat.map(p => p[1]); return [lattice(lo, n, n, draw.size[0], draw.size[1], x, y), lattice(la, n, n, draw.size[0], draw.size[1], x, y)]; };
  async function sampleShown(draw) {
    const C = Ces(), v = V(), G = draw.ground, pts = [], F = draw.frame, n = F.n, lo = F.lonlat.map(p => p[0]), la = F.lonlat.map(p => p[1]);
    for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) { const x = G.nx > 1 ? i / (G.nx - 1) * draw.size[0] : 0, y = G.ny > 1 ? j / (G.ny - 1) * draw.size[1] : 0; pts.push([lattice(lo, n, n, draw.size[0], draw.size[1], x, y), lattice(la, n, n, draw.size[0], draw.size[1], x, y)]); }
    let hs = null;
    const GH = w._groundH;
    if (GH && typeof GH.measureMany === 'function') { try { hs = (await GH.measureMany(pts)).map(r => r.h); } catch (_) { hs = null; } }
    if (!hs) {
      const prov = v && v.terrainProvider;
      try { hs = !prov || prov instanceof C.EllipsoidTerrainProvider ? pts.map(() => 0) : (await C.sampleTerrainMostDetailed(prov, pts.map(p => C.Cartographic.fromDegrees(p[0], p[1])))).map(c => c.height); }
      catch (_) { hs = pts.map(() => NaN); }
    }
    return Float32Array.from(hs, h => (Number.isFinite(h) ? h : NaN));
  }
  // FLEX's point-cloud datum shift at the area (what an export adds to every height); its usual value when FLEX cannot say.
  const DATUM_DEFAULT = -32 * 0.766;
  function datumDz(draw, origin) {
    try { const f = w._pcDatumDz; if (typeof f === 'function') { const d = f(origin[1], origin[0]); if (Number.isFinite(d)) return d; } } catch (_) {}
    return DATUM_DEFAULT;
  }

  // ── Marks and dimming ─────────────────────────────────────────────────────
  // The features as RidgeMarks keeps them (anchor, box, lon / lat), in the area's own metres.
  // (A mark's height is the phone's: the cloud's height plus the datum shift, so the features are matched at that height.)
  const matchOf = D => { try { return RM().match(w._ridgeMarks ? w._ridgeMarks.all() : [], D.features.map(f => Object.assign({}, f, { z: f.z + (D.dz || 0) }))); } catch (_) { return { byFeature: {}, alone: [], ofMark: {} }; } };
  function applyDim(D) {
    if (!D.shapes && !D.dots) return;
    D.M = matchOf(D);
    const boxes = S.marks ? RM().nothingBoxes(D.features, D.M) : [], key = JSON.stringify(boxes) + '|' + (S.marks && S.hideNothing);
    if (key === D.dimKey) return;
    D.dimKey = key;
    const p = D.pending || (D.pending = {});
    if (D.shapes) {
      const flag = FR().insideBoxes(D.raw.shapes.xyz, boxes), c = dimColours(D.shapes.col0, flag);
      D.shapes.col = c.col; D.dimmed = c.dimmed;
      D.shapes.index = S.marks && S.hideNothing && c.dimmed ? keptIndex(D.raw.shapes.tri, flag) : D.raw.shapes.tri;
      p.shapes = D.shapes;
    }
    if (D.dots) {
      const src = D.raw.points, xyz = new Float32Array(D.dots.n * 3);
      for (let j = 0; j < D.dots.n; j++) { const i = D.dots.order[j]; xyz[j * 3] = src.xyz[i * 3]; xyz[j * 3 + 1] = src.xyz[i * 3 + 1]; xyz[j * 3 + 2] = src.xyz[i * 3 + 2]; }
      const flag = FR().insideBoxes(xyz, boxes); for (let j = D.dots.ranges[0][1]; j < flag.length; j++) flag[j] = 0;      // (only the grouped returns)
      D.dots.col = dimColours(D.dots.col0, flag).col;
      p.dots = D.dots;
    }
  }
  function refreshMarks() {
    sets.forEach(D => applyDim(D));
    if (w._ridgeMarks && w._ridgeMarks.setVisible) w._ridgeMarks.setVisible(S.marks);
    paintMounts(); redraw();
  }

  // ── Build ─────────────────────────────────────────────────────────────────
  async function rebuild(D) {
    const my = ++gen, C = Ces(), draw = D.draw;
    const fr = frameOf(draw);
    let shift;
    if (S.onTerrain && draw.ground && draw.ground.z) {
      const shown = await sampleShown(draw);
      if (my !== gen || !sets.has(D.id)) return;
      const g = Float32Array.from(draw.ground.z, v => (v == null ? NaN : v));
      shift = makeShift(g, shown, draw.ground.nx, draw.ground.ny, draw.size[0], draw.size[1]);
      D.mode = 'terrain'; D.terrainProv = V() && V().terrainProvider;
    } else { shift = constShift(datumDz(draw, fr.origin)); D.mode = 'datum'; D.terrainProv = null; }
    D.dz = datumDz(draw, fr.origin);
    const t0 = performance.now(), ramp = d => FR().rampColour(d);
    D.modelMatrix = fr.modelMatrix; D.place = fr.place; D.shift = shift;
    D.shapes = D.raw.shapes ? buildShapes(D.raw.shapes, fr.place, shift, ramp) : null;
    if (D.shapes) { D.shapes.col0 = D.shapes.col; D.shapes.index = D.raw.shapes.tri; }
    D.dots = D.raw.points ? buildDots(D.raw.points, fr.place, shift, ramp) : null;
    if (D.dots) D.dots.col0 = D.dots.col;
    D.patches = D.raw.patches ? buildPatches(D.raw.patches, fr.place, shift) : null;
    // the features' places in the world, for clicks: anchor, middle, deepest point
    const P = new Float32Array(3), world = new Float64Array(D.features.length * 9), q = new C.Cartesian3(), r = new C.Cartesian3();
    D.features.forEach((f, i) => {
      const b = f.box, pts = [[f.x, f.y, f.z], [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, b[2]]];
      pts.forEach((t, k) => { fr.place(t[0], t[1], t[2] + shift.at(t[0], t[1]), P, 0); q.x = P[0]; q.y = P[1]; q.z = P[2]; C.Matrix4.multiplyByPoint(fr.modelMatrix, q, r); world[i * 9 + k * 3] = r.x; world[i * 9 + k * 3 + 1] = r.y; world[i * 9 + k * 3 + 2] = r.z; });
    });
    D.world = world;
    const half = 0.5 * Math.hypot(draw.size[0], draw.size[1]) + 60;
    D.sphere = new C.BoundingSphere(C.Matrix4.multiplyByPoint(fr.modelMatrix, (() => { fr.place(draw.size[0] / 2, draw.size[1] / 2, (shift.mean || 0) + (D.zMid || 0), P, 0); return new C.Cartesian3(P[0], P[1], P[2]); })(), new C.Cartesian3()), half + (D.zSpan || 0));
    D.buildMs = performance.now() - t0;
    D.dimKey = null; D.pending = { shapes: D.shapes, dots: D.dots, patches: D.patches };
    applyDim(D);
    if (!prim || prim.isDestroyed()) { prim = makePrimitive(); V().scene.primitives.add(prim); }
    ensureHandler();
    redraw();
  }
  async function loadData(id, o, name) {
    try {
      if (!V() || !Ces()) throw new Error('the globe is not ready');
      if (!FR() || !RM()) throw new Error('the ridgewalking modules are not loaded');
      const draw = o && o.draw;
      if (!draw || !draw.frame || !Array.isArray(draw.frame.lonlat) || !draw.size) throw new Error('draw.json has no frame');
      const raw = { shapes: o.shapes ? FR().parseShapes(o.shapes) : null, points: o.points ? FR().parsePoints(o.points) : null, patches: o.patches ? parsePatchCells(o.patches) : null };
      clear(id, true);
      let zLo = Infinity, zHi = -Infinity; (draw.ground && draw.ground.z || []).forEach(v => { if (v != null) { if (v < zLo) zLo = v; if (v > zHi) zHi = v; } });
      const features = RM().cleanFeatures(draw.features);
      const D = { id, name: name || '', draw, raw, features, byId: new Map(features.map((f, i) => [f.id, i])), gpu: {}, cmds: {}, pending: null, M: { byFeature: {}, alone: [], ofMark: {} },
        zMid: isFinite(zLo) ? (zLo + zHi) / 2 : 0, zSpan: isFinite(zLo) ? (zHi - zLo) / 2 + 40 : 100,
        bytes: ['shapes', 'points', 'patches'].reduce((a, k) => a + ((o[k] && o[k].byteLength) || 0), 0) };
      sets.set(id, D);
      await rebuild(D);
      fire(); paintMounts();
      return { ok: true, stats: stats(id) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  async function load(id, base, name) {
    try {
      let b = String(base || ''); if (b && !b.endsWith('/')) b += '/';
      const get = async (n, json) => { const r = await fetch(b + n); if (!r.ok) throw new Error(n + ': ' + r.status); return json ? r.json() : r.arrayBuffer(); };
      const draw = await get('draw.json', true);
      const [shapes, points, patches] = await Promise.all([get('shapes.bin').catch(() => null), get('points.bin').catch(() => null), get('patches.bin').catch(() => null)]);
      return await loadData(id, { draw, shapes, points, patches }, name);
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  function clear(id, quiet) {
    const ids = id == null ? [...sets.keys()] : [id]; let had = false;
    ids.forEach(k => { const D = sets.get(k); if (!D) return; had = true; gen++; if (prim) prim.release(D); sets.delete(k); if (proxy && proxy.properties && proxy.properties.areaId && proxy.properties.areaId.getValue() === k) deselect(); });
    redraw();
    if (had && !quiet) { fire(); paintMounts(); }
  }
  function set(o) {
    const before = S;
    S = clampSettings(o, S);
    lset(KEY, JSON.stringify(S));
    if (before.onTerrain !== S.onTerrain) sets.forEach(D => rebuild(D));
    else if (before.marks !== S.marks || before.hideNothing !== S.hideNothing) refreshMarks();
    else paintMounts();
    if (before.marks !== S.marks && w._ridgeMarks && w._ridgeMarks.setVisible) w._ridgeMarks.setVisible(S.marks);
    redraw();
    return get();
  }
  const get = () => Object.assign({}, S);
  const loaded = id => (id == null ? sets.size > 0 : sets.has(id));
  function stats(id) {
    const D = id == null ? sets.values().next().value : sets.get(id);
    if (!D) return { loaded: false };
    return { loaded: true, id: D.id, features: D.features.length, triangles: D.raw.shapes ? D.raw.shapes.nt : 0, vertices: D.raw.shapes ? D.raw.shapes.nv : 0,
      returns: D.dots ? D.dots.ranges.map(r => r[1]) : [0, 0, 0, 0], trueCells: D.raw.patches ? D.raw.patches.nTrue : 0, guessedCells: D.raw.patches ? D.raw.patches.nGuess : 0,
      heights: D.mode, shift: D.shift ? D.shift.mean : 0, buildMs: D.buildMs != null ? Math.round(D.buildMs) : null, bytes: D.bytes, dimmed: D.dimmed || 0,
      drawnTriangles: D.shapes && D.shapes.index ? D.shapes.index.length / 3 : 0, marks: Object.keys(D.M.byFeature).length,
      uploaded: !!(D.gpu.shapes || D.gpu.dots || D.gpu.patches), frames: prim ? prim.frames : 0, calls: prim ? prim.calls : 0 };
  }
  function flyTo(id) {
    const v = V(), D = id == null ? sets.values().next().value : sets.get(id);
    if (!v || !D || !D.sphere) return false;
    v.camera.flyToBoundingSphere(D.sphere, { duration: 1.2 });
    return true;
  }

  // ── Clicks: which feature ─────────────────────────────────────────────────
  /** The feature under a place on the canvas (CSS pixels): { areaId, featureId, d } or null (the phone's rule). */
  function pick(x, y) {
    const v = V(), C = Ces(); if (!v || !sets.size || !(S.shapes || S.openings || S.ret)) return null;
    const scene = v.scene, c3 = new C.Cartesian3(), c2 = new C.Cartesian2();
    let best = null;
    sets.forEach(D => {
      if (!D.world) return;
      const hidden = f => S.marks && S.hideNothing && D.M.byFeature[f.id] && D.M.byFeature[f.id].mark.kind === 'nothing';
      const shown = D.features.map((f, i) => {
        if (hidden(f)) return null;
        const pts = [0, 1, 2].map(k => { c3.x = D.world[i * 9 + k * 3]; c3.y = D.world[i * 9 + k * 3 + 1]; c3.z = D.world[i * 9 + k * 3 + 2]; const q = scene.cartesianToCanvasCoordinates(c3, c2); return q ? [q.x, q.y] : null; });
        return pts[0] || pts[1] ? { pts, rect: null } : null;
      });
      const hit = RM().nearestTap(x, y, shown);
      if (hit && (!best || hit.d < best.d)) best = { areaId: D.id, featureId: D.features[hit.i].id, d: hit.d };
    });
    return best;
  }
  function deselect() { const v = V(); if (v && proxy && v.selectedEntity === proxy) v.selectedEntity = undefined; if (proxy) proxy.show = false; }
  /** Select a feature: an unseen entity at its anchor carries the selection, so FLEX's details panel shows it. */
  function select(areaId, featureId) {
    const v = V(), C = Ces(), D = sets.get(areaId); if (!v || !D) return false;
    const i = D.byId.get(featureId); if (i == null) return false;
    if (!proxySrc) { proxySrc = new C.CustomDataSource('flex-ridge-feature'); v.dataSources.add(proxySrc); }
    const pos = new C.Cartesian3(D.world[i * 9], D.world[i * 9 + 1], D.world[i * 9 + 2]);
    if (!proxy) proxy = proxySrc.entities.add({ id: 'ridge-feature', position: pos, name: 'Ridgewalking feature', point: { pixelSize: 9, color: C.Color.WHITE.withAlpha(0.01), outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      properties: { isRidgeFeature: true, areaId, featureId } });
    else { proxy.position = pos; proxy.properties.areaId = areaId; proxy.properties.featureId = featureId; }
    proxy.show = true;
    if (v.selectedEntity === proxy) { v.selectedEntity = undefined; }
    v.selectedEntity = proxy;
    redraw();
    return true;
  }
  function ensureHandler() {
    const v = V(), C = Ces(); if (handler || !v) return;
    handler = new C.ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction(e => {
      // after FLEX's own click handling: only when nothing else was under the click, and nothing is being drawn
      setTimeout(() => {
        try {
          if (!sets.size || (w._pjfState && w._pjfState.draw)) return;
          const cur = v.selectedEntity;
          if (cur && cur !== proxy) return;
          const hit = pick(e.position.x, e.position.y);
          if (hit) select(hit.areaId, hit.featureId); else if (cur === proxy) deselect();
        } catch (err) { console.warn('[ridge] click', err); }
      }, 0);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  }

  // ── The details panel (info-panel.js) ─────────────────────────────────────
  function card(areaId, featureId) {
    const D = sets.get(areaId), box = document.createElement('div'); box.className = 'rm-card rd-card';
    const f = D && D.features[D.byId.get(featureId)]; if (!f) return box;
    const A = w._pjApi, RMd = w._ridgeMarks, has = !!(A && A.pj && A.pj.pid && RMd);
    const m = has ? (D.M = matchOf(D)).byFeature[f.id] : null, cur = m ? m.mark : null;
    const line = t => { const d = document.createElement('div'); d.className = 'pj-sub rm-fact'; d.textContent = t; box.appendChild(d); return d; };
    if (cur) {
      const by = [cur.updated && cur.updated.who, cur.updated && cur.updated.t ? new Date(cur.updated.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''].filter(Boolean).join(' · ');
      line('Marked ' + FL().RMARK_LABELS[cur.kind] + (by ? ' · ' + by : ''));
      if (m.also.length) line('Also marked: ' + m.also.map(x => FL().RMARK_LABELS[x.kind] + (x.updated && x.updated.who ? ' (' + x.updated.who + ')' : '')).join(', '));
    } else line(has ? 'Not marked yet.' : 'Open a project to mark this feature.');
    const row = document.createElement('div'); row.className = 'pj-row rm-kinds';
    const ta = document.createElement('textarea'); ta.className = 'pj-input rm-note'; ta.rows = 2; ta.placeholder = 'Note'; ta.value = cur ? cur.note || '' : ''; ta.style.width = '100%'; ta.disabled = !has;
    const mark = async next => {
      if (!has) return;
      if (cur) await RMd.set(cur.id, next);
      else if (next.kind) await RMd.create({ kind: next.kind, note: ta.value, lon: f.lon, lat: f.lat, h: +(f.z + (D.dz || 0)).toFixed(2), feat: RM().featHint(f) });
      refreshMarks();
      if (w._info && w._info.changed) w._info.changed({ op: 'rmark.set' });
    };
    FL().RMARK_KINDS.forEach(k => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pj-btn small' + (cur && cur.kind === k ? ' active' : ''); b.dataset.kind = k; b.textContent = FL().RMARK_LABELS[k]; b.disabled = !has;
      b.style.borderLeft = '6px solid ' + FL().RMARK_COLOURS[k];
      if (cur && cur.kind === k) { b.style.fontWeight = '700'; b.style.background = FL().RMARK_COLOURS[k] + '44'; }
      b.addEventListener('click', e => { e.stopPropagation(); mark({ kind: k }); });
      row.appendChild(b);
    });
    box.appendChild(row); box.appendChild(ta);
    if (cur) {
      const r2 = document.createElement('div'); r2.className = 'pj-row';
      [['Save note', () => mark({ note: ta.value })], ['Remove mark', () => mark({ removed: true })]].forEach(([t, fn]) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pj-btn small'; b.textContent = t; b.addEventListener('click', e => { e.stopPropagation(); fn(); }); r2.appendChild(b); });
      box.appendChild(r2);
    }
    return box;
  }
  function subject(areaId, featureId) {
    const D = sets.get(areaId); if (!D) return null;
    const i = D.byId.get(featureId); if (i == null) return null;
    const f = D.features[i], C = Ces();
    const facts = RM().featureRows(f).map(r => [r[0], r[1]]);
    let pos = null;
    try { const k = C.Cartographic.fromCartesian(new C.Cartesian3(D.world[i * 9], D.world[i * 9 + 1], D.world[i * 9 + 2])); pos = [C.Math.toDegrees(k.longitude), C.Math.toDegrees(k.latitude), k.height]; } catch (_) {}
    if (pos) facts.push(['Position', `${pos[1].toFixed(6)}, ${pos[0].toFixed(6)}`], ['Height', w._units ? w._units.height(pos[2]) : pos[2].toFixed(1) + ' m']);
    const desc = facts.slice(0, 3).map(r => r[0] + ' ' + r[1]).join(' · ');
    return { key: 'ridgefeat:' + areaId + ':' + featureId, kind: 'ridgefeat', icon: '🕳', title: 'Ridgewalking feature', line: RM().ENTRANCE[f.entrance] + (D.name ? ' · ' + D.name : ''), facts, desc,
      target: null, pos, self: {}, ref: null, notes: [], leads: [], docs: [], hideInfo: true, canAdd: false, card: () => card(areaId, featureId), refresh: () => subject(areaId, featureId) };
  }

  // ── The switches, in the processed area's Ridgewalking row (analyze-area.js) ─
  const ROWS = [['shapes', 'Shapes'], ['ret', 'Returns'], ['lone', 'Lone'], ['noise', 'Likely noise'], ['pattern', 'Patterned noise'], ['openings', 'Openings'], ['marks', 'Marks'], ['hideNothing', 'Hide “nothing”'], ['onTerrain', 'On terrain']];
  function paintMount(box) {
    const id = box.dataset.area, D = sets.get(id);
    if (!D) { box.innerHTML = ''; box.dataset.key = ''; return; }
    const st = stats(id), key = JSON.stringify([S, st.features, st.triangles, st.returns, st.marks, st.dimmed]);
    if (box.dataset.key === key) return;
    box.dataset.key = key; box.innerHTML = '';
    const info = document.createElement('div'); info.className = 'ar-dim ar-small rd-info';
    info.textContent = `${st.features.toLocaleString()} features · ${st.triangles.toLocaleString()} shape triangles · ${st.returns.reduce((a, b) => a + b, 0).toLocaleString()} returns` + (st.marks ? ` · ${st.marks} marked` : '');
    box.appendChild(info);
    const grid = document.createElement('div'); grid.className = 'rd-sw'; grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin:4px 0';
    ROWS.forEach(([k, label]) => {
      const sw = w.uiSwitch ? w.uiSwitch(!!S[k], on => set({ [k]: on }), label, { small: true, className: 'rd-' + k }) : null;
      if (sw) { sw.dataset.k = k; grid.appendChild(sw); }
    });
    box.appendChild(grid);
    const slider = (label, k, min, max, step, fmt) => {
      const r = document.createElement('label'); r.className = 'rd-sl'; r.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11px;margin:2px 0';
      const t = document.createElement('span'); t.textContent = label; t.style.width = '86px';
      const i = document.createElement('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = S[k]; i.dataset.k = k; i.style.flex = '1';
      const val = document.createElement('span'); val.textContent = fmt(S[k]); val.style.width = '40px';
      i.addEventListener('input', () => { S = clampSettings({ [k]: +i.value }, S); lset(KEY, JSON.stringify(S)); val.textContent = fmt(S[k]); box.dataset.key = ''; redraw(); });
      r.appendChild(t); r.appendChild(i); r.appendChild(val); box.appendChild(r);
    };
    slider('Dot size', 'size', 1, 12, 1, v => v + ' px');
    slider('Shape opacity', 'opacity', 0.05, 1, 0.05, v => Math.round(v * 100) + ' %');
    const fly = document.createElement('button'); fly.type = 'button'; fly.className = 'ar-btn rd-fly'; fly.textContent = 'Fly to'; fly.addEventListener('click', e => { e.stopPropagation(); flyTo(id); });
    box.appendChild(fly);
  }
  let mounts = null;
  function paintMounts() { if (mounts) mounts.querySelectorAll('.ar-ridge[data-area]').forEach(paintMount); }
  function mount(box) { mounts = box; paintMounts(); }
  /** What analyze-area.js wants drawn now: [{ id, result }] (only result 'ridge' counts), areas: the list (for names). */
  const loading = new Set();
  async function sync(want, areas) {
    const ids = new Set((want || []).filter(x => x.result === 'ridge').map(x => x.id));
    [...sets.keys()].forEach(id => { if (!ids.has(id)) clear(id); });
    for (const id of ids) {
      if (sets.has(id) || loading.has(id)) continue;
      loading.add(id);
      const a = (areas || []).find(x => x.id === id);
      const r = await load(id, '/api/areas/file/' + encodeURIComponent(id) + '/ridge/', a ? a.name : '');
      loading.delete(id);
      if (r && r.ok === false) console.warn('[ridge] not drawn:', r.error);
    }
  }

  w.addEventListener('flex-rmarks-changed', () => { if (sets.size) refreshMarks(); });
  const onTerrain = () => { sets.forEach(D => { if (S.onTerrain && D.terrainProv !== (V() && V().terrainProvider)) rebuild(D); }); };
  w.addEventListener('flex-terrain-changed', () => { sets.forEach(D => { if (S.onTerrain) rebuild(D); }); });
  setTimeout(() => { try { const v = V(); if (v && v.scene && v.scene.terrainProviderChanged) v.scene.terrainProviderChanged.addEventListener(onTerrain); } catch (_) {} }, 3000);

  w._ridgeDraw = { sync, mount, loadData, load, clear, set, get, stats, loaded, flyTo, pick, subject, select, pure };
})();
