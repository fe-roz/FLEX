/* terrain-under.js -- the underside of the ground, for the portable viewer / FLEX Field.
 *
 * Loaded by viewer.html with one script tag (viewer_inline.py inlines it, the app serves it from
 * libs/). Exposes window.FlexUnder. three.js r128.
 *
 * WHAT IT DOES
 *   The terrain is drawn see-through and only from outside, so anything behind a ridge showed through
 *   it and from underground the ground was not there at all. With "Underside" above 0 % the INSIDE
 *   of the ground (the terrain's back faces) is drawn in one plain colour at that opacity:
 *     - behind a ridge: covered by the far slope's inside, then the near slope blends over as before;
 *     - inside the ridge (in front of that far slope): exactly as before;
 *     - from underground looking up: the ground above is that solid and covers what is beyond it.
 *   At 0 % nothing is drawn and nothing is computed: the picture is the old one.
 *
 * HOW
 *   0. The exported terrain is double-sided: its back faces used to be drawn with the map picture at the
 *      terrain's own opacity. With Underside on, the terrain's material drops them (a discard on
 *      gl_FrontFacing, so taps and height queries still see a double-sided mesh) and this file draws them.
 *   1. Before each drawn frame (scene.onBeforeRender, so every renderer.render gets it) the back
 *      faces of the terrain are drawn once into an off-screen target: colour (plain, a little
 *      headlight shading, the haze, the focus cut) and depth. The meshes there SHARE the terrain's
 *      geometry; no vertex data is copied.
 *   2. One screen-wide triangle (renderOrder -2: after the opaque things, before the survey lines and
 *      the outside of the ground) puts that picture in at the chosen opacity, with the depth of the
 *      back face written through gl_FragDepth. So trees and bushes (opaque, drawn before) are covered
 *      when they are behind it and hide it when they are in front, and ground beyond it is not drawn
 *      through it.
 *   3. Most cave layers are drawn WITHOUT a depth test (lines, dots, names, leads, markers) or after
 *      the walls cleared the depth buffer. Each of their materials reads the back-face depth of step 1
 *      (FlexUnder.patch / FlexUnder.shader) and thins itself by the same share where it lies behind
 *      it. That is what makes every layer obey the one slider, whatever its draw order.
 *   Without WebGL 2 (depth textures, gl_FragDepth, a highp gl_FragCoord) it falls back to plain back-face
 *   meshes in the scene: the ground gets its inside, the depth-test-less layers are not thinned.
 *
 *   Cost: the terrain's triangles once more per drawn frame (not twice), one screen-wide triangle,
 *   and one texture read in the patched materials. A still scene draws nothing, as before.
 */
(function (root) {
  'use strict';

  var DEFAULT = 90;                 // per cent
  var COLOUR = 0x6f675c;            // quiet grey earth: reads as "inside the hill" on the aerial and the hillshade
  var SHADE = 0.42;                 // how much the headlight shading darkens faces seen edge-on
  var FADE_BELOW = 0.3;             // terrain opacity under this: the inside fades with it (0 = no ground at all)
  var BIAS = 3e-7;                  // window-depth units

  var clampPct = function (v) { v = +v; if (!isFinite(v)) return DEFAULT; return Math.max(0, Math.min(100, Math.round(v))); };
  // What is drawn: the slider's share, faded out with a nearly invisible terrain.
  var strength = function (pct, terrainOpacity) {
    var u = clampPct(pct) / 100, o = +terrainOpacity;
    if (!isFinite(o)) o = 1;
    if (o <= 0) return 0;
    return u * Math.min(1, o / FADE_BELOW);
  };

  // ── Shader text ─────────────────────────────────────────────────────────────
  // highp on the samplers: a sampler is lowp unless told, and a depth read at low precision is useless a kilometre out
  // (SwiftShader and phone GPUs honour it; desktop GPUs hide the mistake).
  var DIM_DECL = '\nuniform highp sampler2D uUnderDepth;\nuniform vec4 uUnder;   // x: share hidden behind the inside of the ground (0 = off), yz: 1 / target size, w: bias\n';
  var DIM_BODY = '\n  if (uUnder.x > 0.0) { if (gl_FragCoord.z > texture2D(uUnderDepth, gl_FragCoord.xy * uUnder.yz).x + uUnder.w) gl_FragColor.a *= 1.0 - uUnder.x; }\n';
  // Adds the thinning to a fragment shader: declarations on top, the test as the last statement of main().
  function dimText(frag) {
    var i = frag.lastIndexOf('}');
    if (i < 0 || frag.indexOf('uUnderDepth') >= 0) return frag;
    return DIM_DECL + frag.slice(0, i) + DIM_BODY + frag.slice(i);
  }

  var QUAD_VS = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
  var QUAD_FS = [
    'uniform sampler2D tColour;', 'uniform highp sampler2D tDepth;', 'uniform vec2 uInv;', 'uniform float uShare;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uInv;',
    '  float d = texture2D(tDepth, uv).x;',
    '  if (d >= 1.0) discard;',
    '  vec4 c = texture2D(tColour, uv);',
    '  gl_FragColor = vec4(c.rgb, c.a * uShare);',
    '  gl_FragDepth = d;',
    '}'].join('\n');

  // ── State ───────────────────────────────────────────────────────────────────
  var S = null;        // set by init
  var U = { depth: { value: null }, p: { value: { x: 0, y: 1, z: 1, w: BIAS } }, on: { value: 0 } };     // shared by every patched material (x 0: off)

  function shader(sh) {            // a three.js shader object in onBeforeCompile, or a ShaderMaterial before its first use
    if (!sh || !sh.fragmentShader) return sh;
    if (!sh.uniforms) sh.uniforms = {};
    sh.uniforms.uUnderDepth = U.depth; sh.uniforms.uUnder = U.p;
    sh.fragmentShader = dimText(sh.fragmentShader);
    return sh;
  }
  // The terrain's own material: no back faces while the inside is drawn here.
  function frontOnly(sh) {
    if (!sh || !sh.fragmentShader || sh.fragmentShader.indexOf('uUnderOn') >= 0) return sh;
    sh.uniforms.uUnderOn = U.on;
    sh.fragmentShader = 'uniform float uUnderOn;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n\tif (uUnderOn > 0.5 && !gl_FrontFacing) discard;');
    return sh;
  }
  function onlyUnder(sh) { shader(sh); }          // one function: its text is the program cache key of every material patched alone
  // A material drawn without a depth test (or after the walls' depth clear): thin it behind the inside of the ground.
  // Materials that have their own onBeforeCompile call FlexUnder.shader(sh) at its end instead (wall-fx.js, ridgewalk.js).
  function patch(m) {
    if (!m || (m.userData && (m.userData.underPatched || m.userData.fxPatched))) return m;
    if (m.isShaderMaterial) { shader(m); m.userData.underPatched = true; m.needsUpdate = true; return m; }
    var T = S && S.THREE || root.THREE, plain = T && T.Material ? T.Material.prototype.onBeforeCompile : null;
    if (plain && m.onBeforeCompile !== plain) { if (root.console) console.warn('FlexUnder.patch: the material has its own onBeforeCompile; call FlexUnder.shader(shader) in it'); return m; }
    m.userData.underPatched = true;
    m.onBeforeCompile = onlyUnder;
    m.needsUpdate = true;
    return m;
  }

  // The inside's own material: plain colour, the focus cut (wall-fx.js), headlight shading from the face's slope to the view.
  function underCompile(sh) {
    if (root.FlexFx && root.FlexFx.terrainShader) root.FlexFx.terrainShader(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUnderV;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvUnderV = mvPosition.xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUnderV;')
      .replace('#include <tonemapping_fragment>',
        '{ vec3 uN = cross(dFdx(vUnderV), dFdy(vUnderV)); float uL = length(uN);\n' +
        '  float uF = uL > 0.0 ? abs(dot(uN / uL, normalize(vUnderV))) : 1.0;\n' +
        '  gl_FragColor.rgb *= 1.0 - ' + SHADE.toFixed(3) + ' * (1.0 - uF) * (1.0 - uF); }\n#include <tonemapping_fragment>');
  }
  function underMaterial(composite) {
    var T = S.THREE;
    var m = new T.MeshBasicMaterial({ color: COLOUR, side: T.BackSide });
    if (!composite) { m.transparent = true; m.depthWrite = true; }       // the fall-back: blended straight into the scene
    m.extensions = { derivatives: true };
    m.onBeforeCompile = underCompile;
    m.userData.underSide = true;
    return m;
  }

  function supported(renderer) {
    try {
      return !!(renderer.capabilities && renderer.capabilities.isWebGL2);     // depth textures, gl_FragDepth, a highp gl_FragCoord
    } catch (_) { return false; }
  }

  // The terrain's meshes as they are now (one, or one per texture tile), with the group's opacity.
  function terrainNow() {
    var g = S.terrain && S.terrain(), list = [], op = 0, shown = !!g;
    for (var p = g; p; p = p.parent) if (p.visible === false) shown = false;
    if (shown) g.traverse(function (o) {
      if (!o.isMesh || !o.geometry || o.visible === false) return;
      var m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.userData && m.userData.underSide) return;
      list.push(o); if (m && m.opacity > op) op = m.opacity;
    });
    return { list: list, opacity: op };
  }
  // One back-face mesh per terrain mesh, sharing its geometry. Rebuilt only when the terrain's meshes changed.
  function sync(list) {
    var T = S.THREE, same = list.length === S.meshes.length, i;
    for (i = 0; same && i < list.length; i++) if (S.meshes[i].userData.of !== list[i] || S.meshes[i].geometry !== list[i].geometry) same = false;
    if (!same) {
      S.meshes.forEach(function (m) { S.holder.remove(m); });
      S.meshes = list.map(function (src) {
        var m = new T.Mesh(src.geometry, S.mat);
        m.matrixAutoUpdate = false; m.userData.of = src; m.name = 'terrain-under';
        S.holder.add(m);
        return m;
      });
    }
    for (i = 0; i < list.length; i++) { S.meshes[i].matrix.copy(list[i].matrixWorld); S.meshes[i].matrixWorld.copy(list[i].matrixWorld); }
  }
  function drop() {                 // nothing left on the GPU or in the scene
    if (!S) return;
    S.meshes.forEach(function (m) { S.holder.remove(m); });
    S.meshes = [];
    if (S.quad) S.quad.visible = false;
    if (S.target) { S.target.dispose(); if (S.target.depthTexture) S.target.depthTexture.dispose(); S.target = null; U.depth.value = null; }
    U.p.value.x = 0; U.on.value = 0;
    S.drawn = { on: false, triangles: 0, calls: 0, share: 0 };
  }

  function ensureTarget(w, h) {
    var T = S.THREE;
    if (S.target && S.target.width === w && S.target.height === h) return;
    if (S.target) { S.target.dispose(); if (S.target.depthTexture) S.target.depthTexture.dispose(); }
    var dt = new T.DepthTexture(w, h);
    dt.type = T.UnsignedIntType; dt.minFilter = dt.magFilter = T.NearestFilter;
    S.target = new T.WebGLRenderTarget(w, h, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, format: T.RGBAFormat, depthBuffer: true, stencilBuffer: false, depthTexture: dt });
    S.target.texture.generateMipmaps = false;
    U.depth.value = dt;
    S.quad.material.uniforms.tColour.value = S.target.texture;
    S.quad.material.uniforms.tDepth.value = dt;
  }

  var _size = null, _clear = null;
  // Called by three at the start of every render of the viewer's scene.
  function before(renderer, scene, camera, toTarget) {
    if (!S || S.busy || scene !== S.scene) return;
    if (toTarget) { if (S.quad) S.quad.visible = false; U.p.value.x = 0; U.on.value = 0; if (!S.composite) S.holder.visible = false; return; }   // a render into someone's target: no inside (the depth picture is the screen's)
    var now = S.pct > 0 ? terrainNow() : null, share = now ? strength(S.pct, now.opacity) : 0;
    if (!(share > 0) || !now.list.length) { if (S.drawn.on || S.meshes.length) drop(); return; }
    sync(now.list);
    S.drawn.on = true; S.drawn.share = share; U.on.value = 1; S.holder.visible = true;
    if (!S.composite) {             // fall-back: the back faces are ordinary see-through meshes of the scene
      S.mat.opacity = share; U.p.value.x = 0;
      S.drawn.triangles = S.drawn.calls = 0;
      return;
    }
    var T = S.THREE;
    if (!_size) { _size = new T.Vector2(); _clear = new T.Color(); }
    renderer.getDrawingBufferSize(_size);
    var w = Math.max(1, Math.floor(_size.x)), h = Math.max(1, Math.floor(_size.y));
    ensureTarget(w, h);
    S.under.fog = scene.fog;
    var prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_clear);
    S.busy = true;
    try {
      renderer.setRenderTarget(S.target);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.render(S.under, camera);
      S.drawn.triangles = renderer.info.render.triangles; S.drawn.calls = renderer.info.render.calls;
    } finally {
      S.busy = false;
      renderer.setClearColor(_clear, prevAlpha);
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget || null);
    }
    S.quad.visible = true;
    S.quad.material.uniforms.uInv.value.set(1 / w, 1 / h);
    S.quad.material.uniforms.uShare.value = share;
    U.p.value.x = share; U.p.value.y = 1 / w; U.p.value.z = 1 / h;
  }

  // o: { THREE, renderer, scene, camera, terrain() -> the terrain group or null, value (saved per cent), redraw(), simple (force the fall-back) }
  function init(o) {
    var T = o.THREE || root.THREE;
    S = { THREE: T, renderer: o.renderer, scene: o.scene, terrain: o.terrain, redraw: o.redraw, pct: o.value == null ? DEFAULT : clampPct(o.value),
          meshes: [], target: null, busy: false, drawn: { on: false, triangles: 0, calls: 0, share: 0 } };
    S.composite = !o.simple && supported(o.renderer);
    S.mat = underMaterial(S.composite);
    if (S.composite) {
      S.under = new T.Scene(); S.under.autoUpdate = false; S.holder = S.under;
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      var qm = new T.ShaderMaterial({ uniforms: { tColour: { value: null }, tDepth: { value: null }, uInv: { value: new T.Vector2(1, 1) }, uShare: { value: 0 } },
        vertexShader: QUAD_VS, fragmentShader: QUAD_FS, transparent: true, depthTest: true, depthWrite: true, fog: false });
        S.quad = new T.Mesh(g, qm);
      S.quad.frustumCulled = false; S.quad.renderOrder = -2; S.quad.visible = false; S.quad.name = 'terrain-under-quad'; S.quad.matrixAutoUpdate = false;
      S.quad.raycast = function () {};
      o.scene.add(S.quad);
    } else {
      S.holder = new T.Group(); S.holder.name = 'terrain-under-group'; S.holder.renderOrder = -2; S.holder.matrixAutoUpdate = false;
      S.holder.raycast = function () {};
      o.scene.add(S.holder);
    }
    // Chain after whatever the scene already does before a render (wall-fx.js brings the focus uniforms up to date there).
    var prev = o.scene.onBeforeRender;
    o.scene.onBeforeRender = function (r, sc, cam, target) {
      if (typeof prev === 'function') prev.apply(this, arguments);
      before(r, sc, cam, target);
    };
    return R;
  }

  function set(pct) {
    if (!S) return DEFAULT;
    S.pct = clampPct(pct);
    if (S.redraw) S.redraw();
    return S.pct;
  }
  var get = function () { return S ? S.pct : DEFAULT; };
  // What the last drawn frame used: { on, share, triangles, calls } of the extra pass, and how many extra objects exist.
  function stats() {
    if (!S) return { on: false, share: 0, triangles: 0, calls: 0, meshes: 0, mode: 'none' };
    return { on: S.drawn.on, share: S.drawn.share, triangles: S.drawn.triangles, calls: S.drawn.calls, meshes: S.meshes.length,
             target: S.target ? [S.target.width, S.target.height] : null, mode: S.composite ? 'composite' : 'simple' };
  }

  // For tests: the back-face meshes (they share the terrain's geometry), the screen triangle, the target.
  var objects = function () { return S ? { meshes: S.meshes.slice(), quad: S.quad || null, holder: S.holder, target: S.target, material: S.mat } : null; };

  var R = { init: init, set: set, get: get, objects: objects, patch: patch, shader: shader, frontOnly: frontOnly, stats: stats, uniforms: U,
            DEFAULT: DEFAULT, COLOUR: COLOUR, strength: strength, clampPct: clampPct, dimText: dimText };
  root.FlexUnder = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
