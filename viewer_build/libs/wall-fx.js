/* wall-fx.js -- see-through cave walls and focus mode for the portable viewer / FLEX Field.
 *
 * Loaded by viewer.html with one <script src="libs/wall-fx.js"> (viewer_inline.py inlines it, the
 * app serves it). Exposes window.FlexFx. three.js r128: no multiple render targets, so everything
 * here is plain materials patched with onBeforeCompile and a few shared uniforms.
 *
 * WHY THE OLD WALLS LOOKED WRONG
 *   - One big mesh: its triangles are drawn in index order, never sorted. "On" wrote depth while
 *     blending, so whichever triangle happened to come first hid the ones behind it (patchy holes,
 *     stripes that moved with the view) and a faint nearest layer blocked a strong one behind it.
 *   - Two passes (back faces, front faces) doubled every layer: "60%" was ~84% on one tube, "20%"
 *     ghost ~36%, and the more tubes lined up the denser and muddier it got.
 *   - The survey lines and station dots are drawn without a depth test, first, so every wall
 *     layer drawn over them dimmed them, whether they were behind that wall or in front of it.
 *   - Ghost was a flat 20% everywhere: no rim, no depth, so shapes did not read.
 *
 * HOW IT WORKS NOW
 *   On    One translucent layer per pixel, whatever the triangle order: a depth pre-pass (colour
 *         off, depth on) then the colour pass with the depth test, so only the nearest wall layer
 *         is blended, at exactly the opacity on the slider. A layer that is nearly invisible (route
 *         dimming, reach, focus fade, depth fade) does not take part in the pre-pass, so it can
 *         never hide a strong wall behind it.
 *   Ghost One pass, both faces, no depth: every layer adds a little (an x-ray), which is order
 *         independent for low alpha. Alpha rises towards the silhouette (the edge slider, a
 *         fresnel-style rim) and falls with distance behind the orbit point (depth fade).
 *   Focus Shader uniforms shared by the walls, the survey lines, station dots and names, leads
 *         and area names: (a) things farther than R from the orbit target fade out, (b) things in
 *         a cone from the camera to the target (a hole as wide as the cut radius at the target)
 *         are cut away, except a small sphere round the target. Uniforms are written when a frame
 *         is drawn (scene.onBeforeRender) and only if the camera or a setting moved, so a static
 *         scene still does no work.
 */
(function (root) {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  // ── Settings (saved per map by the viewer, under DISP.fx) ───────────────────
  const DEFAULTS = { ghost: 0.2, edge: 0.7, fade: 0.35, focus: false, around: true, cut: true, r: null, cutR: null };
  const S = Object.assign({}, DEFAULTS);
  const RANGE = { ghost: [0.03, 0.5], edge: [0, 1], fade: [0, 1], r: [3, 5000], cutR: [1, 500] };

  // ── Shader pieces ───────────────────────────────────────────────────────────
  const GLSL_VARS_VERT = 'varying vec3 vFxW;\n';
  const GLSL_VARS_FRAG = `
uniform vec3 uFxCam;
uniform vec3 uFxTgt;
uniform vec4 uFxAxis;   // xyz: unit vector camera -> target, w: its length
uniform vec4 uFxFoc;    // x: around on, y: radius, z: soft width, w: depth fade
uniform vec4 uFxCut;    // x: cut on, y: hole radius at the target, z: kept sphere round the target
varying vec3 vFxW;
float fxFocus(vec3 X) {            // 1: drawn as usual, 0: gone
  float f = 1.0;
  if (uFxFoc.x > 0.5) f *= 1.0 - smoothstep(uFxFoc.y, uFxFoc.y + uFxFoc.z, distance(X, uFxTgt));
  if (uFxCut.x > 0.5) {
    vec3 v = X - uFxCam;
    float D = max(uFxAxis.w, 1.0);
    float s = dot(v, uFxAxis.xyz);
    float r = length(v - uFxAxis.xyz * s);
    float hole = max(uFxCut.y * clamp(s / D, 0.0, 1.0), 0.001);
    float inHole = 1.0 - smoothstep(hole * 0.65, hole, r);
    float ahead = 1.0 - smoothstep(D - uFxCut.z, D - 0.25 * uFxCut.z, s);
    f *= 1.0 - inHole * ahead;
  }
  return f;
}
`;
  const WALL_VARS_VERT = 'varying vec3 vFxN;\nvarying vec3 vFxP;\n';
  const WALL_VARS_FRAG = 'varying vec3 vFxN;\nvarying vec3 vFxP;\nuniform float uFxEdge;\nuniform float uFxPass;\n';
  const WALL_FRAG = `
  {
    float fxF = fxFocus(vFxW);
    float fxQ = distance(vFxW, uFxCam) / max(uFxAxis.w, 1.0);
    float fxD = 1.0 - uFxFoc.w * smoothstep(1.0, 2.6, fxQ);
    float fxV = diffuseColor.a / max(opacity, 0.0001);
    float fxPart = fxV * fxF * fxD;
    if (uFxPass > 0.5) {
      if (fxPart < 0.5) discard;
    } else {
      float fxL = length(vFxN);
      float fxNV = fxL > 0.00001 ? abs(dot(vFxN / fxL, normalize(-vFxP))) : 1.0;
      float fxE = clamp(1.0 - fxNV, 0.0, 1.0);
      float fxRim = fxE * fxE;
      float fxA = mix(opacity * (1.0 - 0.55 * uFxEdge), min(0.95, opacity + 0.55 * uFxEdge), fxRim);
      diffuseColor.a = fxA * fxPart;
      if (diffuseColor.a < 0.004) discard;
    }
  }
`;
  const BASIC_FRAG = `
  { float fxF = fxFocus(vFxW); diffuseColor.a *= fxF; if (diffuseColor.a < 0.004) discard; }
`;

  let U = null;                    // the shared uniform objects, made in init
  const share = shader => {
    shader.uniforms.uFxCam = U.cam; shader.uniforms.uFxTgt = U.tgt; shader.uniforms.uFxAxis = U.axis;
    shader.uniforms.uFxFoc = U.foc; shader.uniforms.uFxCut = U.cut;
  };
  const inject = (shader, vertVars, vertTail, fragVars, fragBody) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + vertVars)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + vertTail);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + fragVars)
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\n' + fragBody);
  };
  // One function per kind of material (its text is the program cache key: all materials of a kind
  // share one program). `this` is the material.
  function patchWall(shader) {
    share(shader);
    shader.uniforms.uFxEdge = U.edge;
    shader.uniforms.uFxPass = { value: this.userData.fxPass || 0 };
    inject(shader, GLSL_VARS_VERT + WALL_VARS_VERT,
      'vFxW = (modelMatrix * vec4(transformed, 1.0)).xyz; vFxN = transformedNormal; vFxP = mvPosition.xyz;',
      GLSL_VARS_FRAG + WALL_VARS_FRAG, WALL_FRAG);
  }
  function patchBasic(shader) {            // lines and dots (MeshBasic / LineBasic share a shader)
    share(shader);
    inject(shader, GLSL_VARS_VERT, 'vFxW = (modelMatrix * vec4(transformed, 1.0)).xyz;', GLSL_VARS_FRAG, BASIC_FRAG);
  }
  function patchSprite(shader) {           // names, leads, area names: faded by the sprite's centre
    share(shader);
    inject(shader, GLSL_VARS_VERT, 'vFxW = modelMatrix[3].xyz;', GLSL_VARS_FRAG, BASIC_FRAG);
  }

  // ── State shared with the viewer ────────────────────────────────────────────
  let ctx = null, THREE = null;
  const sets = [];                         // wall layer sets: { col, pre }
  let lastClear = -1;

  function init(c) {
    ctx = c; THREE = c.THREE || root.THREE;
    U = {
      cam: { value: new THREE.Vector3() }, tgt: { value: new THREE.Vector3() },
      axis: { value: new THREE.Vector4(0, 1, 0, 100) },
      foc: { value: new THREE.Vector4(0, 50, 30, 0) }, cut: { value: new THREE.Vector4(0, 10, 4, 0) },
      edge: { value: S.edge },
    };
    FX.uniforms = U;
    restore(c.saved);
    // Every render call: bring the uniforms up to date (only if something moved).
    c.scene.onBeforeRender = () => update();
    return FX;
  }

  function restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    ['ghost', 'edge', 'fade'].forEach(k => { S[k] = clamp(num(saved[k], S[k]), RANGE[k][0], RANGE[k][1]); });
    ['focus', 'around', 'cut'].forEach(k => { if (typeof saved[k] === 'boolean') S[k] = saved[k]; });
    ['r', 'cutR'].forEach(k => { S[k] = saved[k] == null ? null : clamp(num(saved[k], DEFAULTS[k] == null ? 10 : DEFAULTS[k]), RANGE[k][0], RANGE[k][1]); });
    if (U) U.edge.value = S.edge;
  }
  const serialize = () => ({ ghost: S.ghost, edge: S.edge, fade: S.fade, focus: S.focus, around: S.around, cut: S.cut, r: S.r, cutR: S.cutR });

  // The cave's size sets the default focus radius (and the range of its slider).
  let _size = 0;
  function caveSize() {
    if (_size) return _size;
    const b = ctx && ctx.caveBox && ctx.caveBox();
    if (b && !b.isEmpty()) { const d = b.max.distanceTo(b.min); if (d > 1) _size = d; }
    return _size || 200;
  }
  const defaultR = () => clamp(0.18 * caveSize(), 12, 150);
  const getR = () => S.r == null ? defaultR() : S.r;
  const defaultCutR = () => clamp(0.4 * getR(), 5, 40);
  const getCutR = () => S.cutR == null ? defaultCutR() : S.cutR;

  // ── Uniforms: written when a frame is drawn, and only if something moved ────
  const prev = new Float64Array(16);
  const cur = new Float64Array(16);
  function update(force) {
    if (!U) return;
    const cam = ctx.camera.position, tgt = ctx.controls.target;
    const fly = !!(ctx.isFly && ctx.isFly());
    const on = S.focus && !fly;
    let dx = tgt.x - cam.x, dy = tgt.y - cam.y, dz = tgt.z - cam.z, D = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (D < 1e-6) { dx = 0; dy = 1; dz = 0; D = 1; } else { dx /= D; dy /= D; dz /= D; }
    const R = getR(), hole = clamp(getCutR(), 0.09 * D, 0.36 * D);   // a hole of at least ~5 degrees, at most ~20 degrees round the view axis
    cur[0] = cam.x; cur[1] = cam.y; cur[2] = cam.z; cur[3] = tgt.x; cur[4] = tgt.y; cur[5] = tgt.z;
    cur[6] = on && S.around ? 1 : 0; cur[7] = on && S.cut ? 1 : 0; cur[8] = R; cur[9] = hole; cur[10] = S.fade; cur[11] = S.edge;
    if (!force) { let same = true; for (let i = 0; i < 12; i++) if (cur[i] !== prev[i]) { same = false; break; } if (same) return; }
    prev.set(cur);
    U.cam.value.set(cam.x, cam.y, cam.z); U.tgt.value.set(tgt.x, tgt.y, tgt.z);
    U.axis.value.set(dx, dy, dz, D);
    U.foc.value.set(cur[6], R, Math.max(0.6 * R, 3), S.fade);
    U.cut.value.set(cur[7], hole, clamp(0.35 * hole, 2.5, 25), 0);
    U.edge.value = S.edge;
  }

  // The same maths as the shader, for taps: 1 = in focus, 0 = faded or cut away.
  function focusAt(x, y, z) {
    update();
    let f = 1;
    if (U.foc.value.x > 0.5) {
      const t = U.tgt.value, R = U.foc.value.y;
      f *= 1 - smooth(R, R + U.foc.value.z, Math.hypot(x - t.x, y - t.y, z - t.z));
    }
    if (U.cut.value.x > 0.5) {
      const c = U.cam.value, a = U.axis.value, D = Math.max(a.w, 1);
      const vx = x - c.x, vy = y - c.y, vz = z - c.z, s = vx * a.x + vy * a.y + vz * a.z;
      const r = Math.hypot(vx - a.x * s, vy - a.y * s, vz - a.z * s);
      const hole = Math.max(U.cut.value.y * clamp(s / D, 0, 1), 0.001), keep = U.cut.value.z;
      const inHole = 1 - smooth(hole * 0.65, hole, r), ahead = 1 - smooth(D - keep, D - 0.25 * keep, s);
      f *= 1 - inHole * ahead;
    }
    return f;
  }
  const focusActive = () => !!(S.focus && !(ctx.isFly && ctx.isFly()) && (S.around || S.cut));

  // ── Walls ───────────────────────────────────────────────────────────────────
  // One depth clear per drawn frame, before the first wall mesh: the walls show through the
  // ground, so they are drawn into a fresh depth buffer. gl.clear honours the depth write mask and
  // three's clearDepth() does not set it (a beam drawn just before can leave it off), so force it
  // on first.
  function clearOnce(r) {
    const f = r.info && r.info.render ? r.info.render.frame : -2;
    if (f === lastClear) return;
    lastClear = f;
    r.state.buffers.depth.setMask(true);
    r.clearDepth();
  }

  // The meshes of one wall set, sharing `geo`: [colour pass, depth pre-pass]. `order` is the
  // pre-pass's renderOrder (the colour pass is 0.1 later); several sets share one depth buffer when
  // their orders are close (the exported walls 0.50, field-survey walls 0.51).
  function makeWalls(geo, order) {
    const mk = pass => {
      const m = new THREE.MeshLambertMaterial({
        vertexColors: true, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
        depthWrite: pass === 1, colorWrite: pass === 0,
        polygonOffset: pass === 1, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      m.userData.fxPass = pass;
      m.onBeforeCompile = patchWall;
      return m;
    };
    const col = new THREE.Mesh(geo, mk(0)), pre = new THREE.Mesh(geo, mk(1));
    pre.renderOrder = order; col.renderOrder = order + 0.1;
    col.onBeforeRender = pre.onBeforeRender = clearOnce;
    sets.push({ col, pre });
    return [col, pre];
  }

  // mode: 0 on, 1 ghost, 2 off; opacity: the "On" slider.
  function applyWalls(mode, opacity) {
    for (let i = sets.length - 1; i >= 0; i--) if (!sets[i].col.parent) sets.splice(i, 1);   // rebuilt or removed
    const ghost = mode === 1;
    const a = ghost ? S.ghost : opacity;
    sets.forEach(({ col, pre }) => {
      col.material.opacity = pre.material.opacity = a;
      col.material.depthTest = !ghost;          // ghost: every layer; on: only the nearest (pre-pass)
      pre.visible = !ghost && mode !== 2;
    });
    update(true);
  }

  // ── Other materials ─────────────────────────────────────────────────────────
  // Lines, station dots, names, leads, area names: fade with the focus. Dots are made transparent
  // for good (reach and routes switch `transparent` off at full strength, which would stop alpha).
  function patch(m, opts) {
    if (!m || (m.userData && m.userData.fxPatched)) return m;
    m.userData.fxPatched = true;
    m.onBeforeCompile = m.isSpriteMaterial ? patchSprite : patchBasic;
    if (opts && opts.alwaysTransparent) Object.defineProperty(m, 'transparent', { get: () => true, set: () => {}, configurable: true });
    m.needsUpdate = true;
    return m;
  }

  // ── Setting changes ─────────────────────────────────────────────────────────
  function changed(wallsToo) {
    if (wallsToo && ctx.applyWallMode) ctx.applyWallMode(); else update(true);
    syncUi();
    if (ctx.redraw) ctx.redraw();
  }
  function setFocus(on) {
    on = !!on;
    if (on && !S.around && !S.cut) S.around = S.cut = true;
    S.focus = on;
    changed();
    if (on && ctx.toast) {
      const fmt = ctx.units && ctx.units.len ? ctx.units.len : m => Math.round(m) + ' m';
      const near = ctx.nearestStation ? ctx.nearestStation(ctx.controls.target) : null;
      ctx.toast(near != null && S.around && near > 1.6 * getR()
        ? 'Focus on, but nothing is within ' + fmt(getR()) + ' of the orbit point: pan to a passage or widen the radius'
        : 'Focus on' + (S.around ? ' · radius ' + fmt(getR()) : '') + (S.cut ? ' · cutting away what is in front' : ''));
    }
  }
  const toggleFocus = () => setFocus(!S.focus);
  function syncUi() {
    const b = root.document && root.document.getElementById('tb-focus');
    if (b) { b.classList.toggle('focus-on', focusActive()); b.setAttribute('aria-pressed', S.focus ? 'true' : 'false'); }
  }
  function bindButton(b) {
    if (!b) return;
    b.addEventListener('click', toggleFocus);
    syncUi();
  }

  // ── Display sheet pieces (the viewer passes its own builders in H) ──────────
  // H: { el, sheet, head, row, chips, rerender, units }
  function slider(H, id, label, min, max, value, fmt, onInput) {
    const row = H.el('div', 'sh-sl');
    const l = H.el('label', '', label), v = H.el('div', '', fmt(value));
    const i = H.el('input'); i.type = 'range'; i.min = String(min); i.max = String(max); i.step = '1'; i.value = String(Math.round(value)); i.id = id;
    i.style.accentColor = '#00e5ff';
    i.addEventListener('input', () => { const n = +i.value; v.textContent = fmt(n); onInput(n); });
    row.append(l, i, v);
    H.sheet.appendChild(row);
    return i;
  }
  const pct = n => Math.round(n) + '%';
  // Ghost strength (ghost mode only), edge emphasis and depth fade: after the Opacity slider.
  function sheetWalls(H, mode) {
    if (mode === 1) slider(H, 'wall-ghost-slider', 'Ghost', RANGE.ghost[0] * 100, RANGE.ghost[1] * 100, S.ghost * 100, pct, n => { S.ghost = n / 100; changed(true); });
    slider(H, 'wall-edge-slider', 'Edges', 0, 100, S.edge * 100, pct, n => { S.edge = n / 100; changed(); });
    slider(H, 'wall-fade-slider', 'Depth fade', 0, 100, S.fade * 100, pct, n => { S.fade = n / 100; changed(); });
  }
  // Radii are on a log scale: the sliders run 0..100.
  const rRange = () => [4, Math.max(120, caveSize() * 1.5)];
  const cRange = () => [2, 80];
  const toT = (r, [a, b]) => 100 * Math.log(clamp(r, a, b) / a) / Math.log(b / a);
  const fromT = (t, [a, b]) => a * Math.pow(b / a, t / 100);
  function sheetFocus(H) {
    const len = H.units && H.units.len ? m => H.units.len(m) : m => Math.round(m) + ' m';
    H.head('Focus');
    H.row('🎯', 'Focus mode', S.focus ? 'on' : 'solid near the orbit point, the rest fades', () => { toggleFocus(); H.rerender(); }, S.focus);
    H.chips([
      ['⭕', 'Around centre', S.around, on => { S.around = on; changed(); }],
      ['✂️', 'Cut in front', S.cut, on => { S.cut = on; changed(); }],
    ]);
    slider(H, 'focus-radius-slider', 'Radius', 0, 100, toT(getR(), rRange()), t => len(fromT(t, rRange())), t => { S.r = fromT(t, rRange()); changed(); });
    slider(H, 'focus-cut-slider', 'Cut radius', 0, 100, toT(getCutR(), cRange()), t => len(fromT(t, cRange())), t => { S.cutR = fromT(t, cRange()); changed(); });
  }

  // Taps: a station, name, lead or area name that the focus has faded or cut away cannot be tapped
  // (what you see is what you can tap); the rest are ranked by how far they are in focus.
  const tapFactor = p => (focusActive() ? focusAt(p.x, p.y, p.z) : 1);

  const FX = {
    init, restore, serialize, update, patch, makeWalls, applyWalls,
    state: S, defaults: DEFAULTS, uniforms: null, range: RANGE,
    setFocus, toggleFocus, focusActive, focusAt, tapFactor, bindButton, syncUi, sheetWalls, sheetFocus,
    radius: getR, cutRadius: getCutR, defaultRadius: defaultR, caveSize,
    wallSets: sets,
  };
  root.FlexFx = FX;
})(typeof window !== 'undefined' ? window : globalThis);
