// V2 - Ridgewalking in the portable viewer / FLEX Field / FLEX Ridgewalk (window.FlexRidge).
//
// An export made with "V2 - Ridgewalking" carries RIDGE = { version, counts, points, patches, shapes,
// brush, depthCap }; each of points / patches / shapes / brush is a sidecar file name or inline base64
// (the viewer's own dual mode). A normal export has RIDGE = null and this file does nothing at all.
//
//   points   "RWP1", uint32 n, float32 xyz[n*3], float32 depth[n], uint8 kind[n]
//            kind: 0 in a group, 1 lone, 2 likely noise, 3 patterned noise
//   shapes   "RWS1", uint32 nv, uint32 nt, float32 xyz[nv*3], float32 depth[nv], uint32 tri[nt*3]
//   patches  "RWT1", uint32 nv, float32 xyz[nv*3]     (triangle soup of the guessed openings)
//   all little-endian and in the viewer's own frame (terrain.glb's).
//
// What it draws: the returns below ground as dots THROUGH the ground (no depth test), coloured by
// depth; lone returns white, likely noise pink, patterned noise light blue (off); the guessed openings
// as dark patches lying on the ground; the shapes (walls of the features, off, loaded on first use);
// and the brush map on top of the hillshade. Nothing animates: every change asks the viewer for one
// redraw. three.js r128.   Test: tools/test_viewer_ridge.js
(function (root) {
  'use strict';

  // Depth ramp over 0..cap metres below the lid; deeper = the last colour.
  var RAMP = [[0xff, 0xe8, 0x5c], [0xff, 0x9a, 0x2e], [0xe8, 0x32, 0x2a], [0xb0, 0x1f, 0xd0], [0x4a, 0x2c, 0xff]];
  var KINDS = ['ret', 'lone', 'noise', 'pattern'];                    // by the file's kind number
  var KIND_COLOUR = [null, 0xffffff, 0xff4dd2, 0x7fd4ff];             // kind 0 is coloured by depth
  var PATCH_COLOUR = 0x141312, PATCH_OPACITY = 0.72;
  var DEFAULTS = { ret: true, lone: true, noise: true, pattern: false, patches: true, shapes: false, brush: true, size: 4 };
  var SIZE_MIN = 1, SIZE_MAX = 12;

  // [r, g, b] 0..1 of a depth in metres.
  function rampColour(depth, cap) {
    cap = cap > 0 ? cap : 20;
    var t = depth > 0 ? (depth >= cap ? 1 : depth / cap) : 0;         // NaN -> 0
    var f = t * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(f)), u = f - i;
    var a = RAMP[i], b = RAMP[i + 1];
    return [(a[0] + (b[0] - a[0]) * u) / 255, (a[1] + (b[1] - a[1]) * u) / 255, (a[2] + (b[2] - a[2]) * u) / 255];
  }

  function magic(buf, want) {
    if (!buf || buf.byteLength < 8) throw new Error('ridge: ' + want + ' file too short');
    var b = new Uint8Array(buf, 0, 4), s = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (s !== want) throw new Error('ridge: expected ' + want + ', got ' + s);
    return new DataView(buf);
  }
  // { n, xyz, depth, kind }: views over the bytes, nothing copied.
  function parsePoints(buf) {
    var dv = magic(buf, 'RWP1'), n = dv.getUint32(4, true);
    if (buf.byteLength < 8 + n * 17) throw new Error('ridge: points file cut short');
    return { n: n, xyz: new Float32Array(buf, 8, n * 3), depth: new Float32Array(buf, 8 + n * 12, n), kind: new Uint8Array(buf, 8 + n * 16, n) };
  }
  function parseShapes(buf) {
    var dv = magic(buf, 'RWS1'), nv = dv.getUint32(4, true), nt = dv.getUint32(8, true);
    if (buf.byteLength < 12 + nv * 16 + nt * 12) throw new Error('ridge: shapes file cut short');
    return { nv: nv, nt: nt, xyz: new Float32Array(buf, 12, nv * 3), depth: new Float32Array(buf, 12 + nv * 12, nv), tri: new Uint32Array(buf, 12 + nv * 16, nt * 3) };
  }
  function parsePatches(buf) {
    var dv = magic(buf, 'RWT1'), nv = dv.getUint32(4, true);
    if (buf.byteLength < 8 + nv * 12) throw new Error('ridge: patches file cut short');
    return { nv: nv, xyz: new Float32Array(buf, 8, nv * 3) };
  }
  // The points of each kind: [{ n, pos, col|null }] by kind number (colours only for kind 0).
  function splitKinds(P, cap) {
    var cnt = [0, 0, 0, 0], i, k;
    for (i = 0; i < P.n; i++) { k = P.kind[i]; if (k < 4) cnt[k]++; }
    var out = cnt.map(function (c, kk) { return { n: c, pos: new Float32Array(c * 3), col: kk === 0 ? new Float32Array(c * 3) : null }; });
    var at = [0, 0, 0, 0];
    for (i = 0; i < P.n; i++) {
      k = P.kind[i]; if (k > 3) continue;
      var o = out[k], j = at[k]++ * 3, s = i * 3;
      o.pos[j] = P.xyz[s]; o.pos[j + 1] = P.xyz[s + 1]; o.pos[j + 2] = P.xyz[s + 2];
      if (o.col) { var c3 = rampColour(P.depth[i], cap); o.col[j] = c3[0]; o.col[j + 1] = c3[1]; o.col[j + 2] = c3[2]; }
    }
    return out;
  }
  function depthColours(depth, cap) {
    var col = new Float32Array(depth.length * 3);
    for (var i = 0; i < depth.length; i++) { var c = rampColour(depth[i], cap); col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
    return col;
  }
  // Saved choices -> a full state; anything odd falls back to the default.
  function restore(saved) {
    var st = {}, k;
    for (k in DEFAULTS) st[k] = DEFAULTS[k];
    if (saved && typeof saved === 'object') {
      for (k in DEFAULTS) {
        if (k === 'size') { if (isFinite(saved.size) && saved.size >= SIZE_MIN && saved.size <= SIZE_MAX) st.size = +saved.size; }
        else if (typeof saved[k] === 'boolean') st[k] = saved[k];
      }
    }
    return st;
  }

  var S = null;      // everything of the running viewer; null = no ridge data (the normal export)

  // Round dots: r128's points are squares.
  function roundDots(mat) {
    mat.onBeforeCompile = function (sh) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n\tif (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;');
    };
    return mat;
  }
  function pointsOf(part, kind) {
    var T = S.THREE, g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(part.pos, 3));
    if (part.col) g.setAttribute('color', new T.BufferAttribute(part.col, 3));
    g.computeBoundingSphere();
    var m = roundDots(new T.PointsMaterial({ size: S.st.size, sizeAttenuation: false, vertexColors: !!part.col,
      color: part.col ? 0xffffff : KIND_COLOUR[kind], depthTest: false, depthWrite: false, transparent: true, fog: false }));
    var p = new T.Points(g, m);
    p.renderOrder = 1.6 + kind * 0.01;       // after the terrain (0.5) and the patches; lone / noise over the groups
    p.name = 'ridge-' + KINDS[kind];
    p.visible = !!S.st[KINDS[kind]];
    p.matrixAutoUpdate = false;
    return p;
  }
  function patchesOf(Q) {
    var T = S.THREE, g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(Q.xyz, 3));
    g.computeBoundingSphere();
    var m = new T.MeshBasicMaterial({ color: PATCH_COLOUR, opacity: PATCH_OPACITY, transparent: true, depthWrite: false, side: T.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    var mesh = new T.Mesh(g, m);
    mesh.renderOrder = 1.5; mesh.name = 'ridge-patches'; mesh.visible = !!S.st.patches; mesh.matrixAutoUpdate = false;
    return mesh;
  }
  function shapesOf(H) {
    var T = S.THREE, g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(H.xyz, 3));
    g.setAttribute('color', new T.BufferAttribute(depthColours(H.depth, S.cap), 3));
    g.setIndex(new T.BufferAttribute(H.tri, 1));
    g.computeBoundingSphere();
    // Seen through the ground like the dots; one unsorted see-through mesh, so no depth write.
    var m = new T.MeshBasicMaterial({ vertexColors: true, opacity: 0.45, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide, fog: false });
    var mesh = new T.Mesh(g, m);
    mesh.renderOrder = 1.55; mesh.name = 'ridge-shapes'; mesh.visible = !!S.st.shapes; mesh.matrixAutoUpdate = false;
    return mesh;
  }

  function loadBin(ref) {
    try {
      if (S.isAssetRef(ref)) return fetch(ref).then(function (r) { if (!r.ok) throw new Error('ridge fetch ' + ref + ': HTTP ' + r.status); return r.arrayBuffer(); });
      return Promise.resolve(S.b64ToArrayBuffer(ref));
    } catch (e) { return Promise.reject(e); }
  }
  function redraw() { if (S && S.redraw) S.redraw(); }

  function loadShapes() {
    if (!S || !S.ridge.shapes || S.shapesLoading) return S && S.shapesLoading || Promise.resolve();
    S.shapesLoading = loadBin(S.ridge.shapes).then(function (buf) {
      S.shapes = shapesOf(parseShapes(buf));
      S.scene.add(S.shapes); redraw();
    }).catch(function (e) { console.warn('Ridgewalk shapes not loaded:', e); });
    return S.shapesLoading;
  }
  function loadBrush() {
    if (!S.ridge.brush || typeof Image === 'undefined') return;
    var img = new Image();
    img.onload = function () { S.brushImg = img; if (S.retexture) S.retexture(); };
    img.onerror = function () { console.warn('Ridgewalk brush map not loaded'); };
    img.src = S.textureSrc ? S.textureSrc(S.ridge.brush) : S.ridge.brush;
  }

  var R = {
    RAMP: RAMP, DEFAULTS: DEFAULTS, rampColour: rampColour, parsePoints: parsePoints, parseShapes: parseShapes, parsePatches: parsePatches,
    splitKinds: splitKinds, restore: restore,

    // o: { THREE, scene, ridge, saved, isAssetRef, b64ToArrayBuffer, textureSrc, redraw, retexture }.
    // Returns a promise that settles when the dots and patches are in the scene (null ridge: at once).
    init: function (o) {
      S = null;
      var ridge = o && o.ridge;
      if (!ridge || typeof ridge !== 'object' || !ridge.points) return Promise.resolve(false);
      S = { THREE: o.THREE, scene: o.scene, ridge: ridge, cap: ridge.depthCap > 0 ? +ridge.depthCap : 20, st: restore(o.saved),
            isAssetRef: o.isAssetRef, b64ToArrayBuffer: o.b64ToArrayBuffer, textureSrc: o.textureSrc, redraw: o.redraw, retexture: o.retexture,
            points: [null, null, null, null], patches: null, shapes: null, shapesLoading: null, brushImg: null, comp: null, compOf: null };
      var jobs = [loadBin(ridge.points).then(function (buf) {
        splitKinds(parsePoints(buf), S.cap).forEach(function (part, k) {
          if (!part.n) return;
          S.points[k] = pointsOf(part, k); S.scene.add(S.points[k]);
        });
      }).catch(function (e) { console.warn('Ridgewalk returns not loaded:', e); })];
      if (ridge.patches) jobs.push(loadBin(ridge.patches).then(function (buf) {
        var Q = parsePatches(buf);
        if (Q.nv) { S.patches = patchesOf(Q); S.scene.add(S.patches); }
      }).catch(function (e) { console.warn('Ridgewalk openings not loaded:', e); }));
      if (S.st.shapes) jobs.push(loadShapes());            // shapes only when they were left on
      loadBrush();
      return Promise.all(jobs).then(function () { redraw(); return true; });
    },
    active: function () { return !!S; },
    state: function () { return S ? Object.assign({}, S.st) : null; },
    serialize: function () { return S ? Object.assign({}, S.st) : undefined; },
    objects: function () { return S ? { points: S.points.slice(), patches: S.patches, shapes: S.shapes } : null; },
    counts: function () { return S && S.ridge.counts || {}; },

    // One switch (ret, lone, noise, pattern, patches, shapes, brush) or the dot size.
    set: function (key, v) {
      if (!S || !(key in DEFAULTS)) return;
      if (key === 'size') {
        v = Math.max(SIZE_MIN, Math.min(SIZE_MAX, +v || DEFAULTS.size));
        S.st.size = v;
        S.points.forEach(function (p) { if (p) p.material.size = v; });
        return redraw();
      }
      S.st[key] = !!v;
      var k = KINDS.indexOf(key);
      if (k >= 0) { if (S.points[k]) S.points[k].visible = !!v; }
      else if (key === 'patches') { if (S.patches) S.patches.visible = !!v; }
      else if (key === 'shapes') { if (S.shapes) S.shapes.visible = !!v; else if (v) loadShapes(); }
      else if (key === 'brush') { if (S.retexture) S.retexture(); }
      redraw();
    },

    // The texture to put on the terrain: the hillshade with the brush map over it while the brush
    // switch is on and the hillshade is the shown map; anything else comes back as it is. The two
    // are drawn onto one canvas once. A tiled hillshade (exports over 5 km) is left alone.
    mapTexture: function (tex, mode) {
      if (!S || mode !== 'hs' || !tex || tex._tiled || !S.st.brush || !S.brushImg || !tex.image) return tex;
      if (S.comp && S.compOf === tex) return S.comp;
      try {
        var img = tex.image, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!(w > 0 && h > 0)) return tex;
        var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        var c2 = cv.getContext('2d');
        c2.drawImage(img, 0, 0, w, h);
        c2.drawImage(S.brushImg, 0, 0, w, h);
        var t = new S.THREE.Texture(cv);
        t.flipY = tex.flipY; t.encoding = tex.encoding; if (tex.colorSpace !== undefined) t.colorSpace = tex.colorSpace;
        t.needsUpdate = true;
        if (S.comp) S.comp.dispose();
        S.comp = t; S.compOf = tex;
        return t;
      } catch (e) { console.warn('Ridgewalk brush overlay failed:', e); return tex; }
    },

    // The rows in Display. ui: { el, sheet, head, chips } (the viewer's own builders).
    sheet: function (ui) {
      if (!S) return;
      ui.head('Below ground (V2)');
      var st = S.st, chip = function (icon, label, key) { return [icon, label, !!st[key], function (on) { R.set(key, on); }]; };
      var chips = [chip('🟡', 'Returns', 'ret'), chip('⚪', 'Lone', 'lone'), chip('🟣', 'Likely noise', 'noise'), chip('🔵', 'Patterned noise', 'pattern')];
      if (S.ridge.patches) chips.push(chip('⬛', 'Guessed openings', 'patches'));
      if (S.ridge.shapes) chips.push(chip('🧱', 'Shapes', 'shapes'));
      if (S.ridge.brush) chips.push(chip('🌿', 'Brush', 'brush'));
      ui.chips(chips);
      var row = ui.el('div', 'sh-sl'), lab = ui.el('label', '', 'Dot size'), val = ui.el('div', '', st.size + ' px'), inp = ui.el('input');
      inp.type = 'range'; inp.min = String(SIZE_MIN); inp.max = String(SIZE_MAX); inp.step = '1'; inp.value = String(st.size); inp.id = 'ridge-size-slider';
      inp.style.accentColor = '#00e5ff';
      inp.addEventListener('input', function () { R.set('size', +inp.value); val.textContent = inp.value + ' px'; });
      row.appendChild(lab); row.appendChild(inp); row.appendChild(val);
      ui.sheet.appendChild(row);
    },
  };

  root.FlexRidge = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
