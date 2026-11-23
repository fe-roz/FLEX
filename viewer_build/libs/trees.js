// Trees and brush in the portable viewer / FLEX Field (window.FlexTrees).
//
// An export made with "Trees and brush" carries TREES = { version, count, file, detail }; `file` is
// trees.bin by name or as inline base64 (the viewer's own dual mode). A normal export has TREES = null
// and this file does nothing at all.
//
//   trees.bin  "FTR1", uint32 n, then 20 bytes a tree, little-endian: float32 x, y, z (the foot, in the
//              viewer's own frame), float32 height, uint16 radius in cm, uint8 kind (0 cone, 1 round
//              crown, 2 low mound), uint8 tint (0..255)
//
// Every tree and bush is ONE of three stock solids stretched to its radius and height: instanced meshes
// (THREE.InstancedMesh, r128), a few triangles a shape, fewer when the export says the area is large
// (detail 0 / 1 / 2). The whole area is drawn, with no distance limit; the instances are filed in ground
// tiles so the ones out of view are skipped. See-through is a screen door (every other pixel dropped in
// the fragment shader): no blending, no sorting, no second pass, depth test and depth write stay on.
// Nothing animates and nothing runs per frame: a switch asks the viewer for one redraw. Trees are not
// part of the terrain: the height grid and taps do not see them.   Test: tools/test_viewer_trees.js
(function (root) {
  'use strict';

  var KINDS = ['cone', 'round', 'mound'];                       // by the file's kind number
  var COLOUR = [[0x2c, 0x5a, 0x33], [0x4a, 0x86, 0x3c], [0x7c, 0x96, 0x4c]];     // conifer, broadleaf, brush
  var TINT_LO = 0.78, TINT_HI = 1.16;                          // the tint byte scales the colour between these
  var SINK = 0.06;                                             // the solids start this share of their height under the foot (slopes)
  var DEFAULTS = { trees: true, brush: true, see: true };
  var STATE_V = 1;
  var TILE_TARGET = 6000, TILE_MAX = 8;                        // about this many shapes a ground tile, at most 8 x 8 tiles
  // The stock solids, as a profile turned round the vertical: [sides, [radius, height] rings from the
  // bottom up], closed by a point at the top (height 1).
  var SOLIDS = [
    // cone
    [{ sides: 12, rings: [[1, -SINK]] }, { sides: 6, rings: [[1, -SINK]] }, { sides: 4, rings: [[1, -SINK]] }],
    // round crown: wide from the ground up, a blunt top
    [{ sides: 5, rings: [[0.92, -SINK], [0.92, 0.55]] }, { sides: 4, rings: [[0.95, -SINK], [0.85, 0.6]] }, { sides: 3, rings: [[1, -SINK], [0.85, 0.6]] }],
    // low mound
    [{ sides: 4, rings: [[1, -SINK], [0.66, 0.68]] }, { sides: 6, rings: [[1, -SINK]] }, { sides: 4, rings: [[1, -SINK]] }],
  ];

  // Triangle soup (flat shaded: every triangle its own three vertices and normal) of one solid.
  function solid(def) {
    var S = def.sides, rings = def.rings, pos = [], k, i;
    var at = function (ring, s) { var a = 2 * Math.PI * (s % S) / S; return [ring[0] * Math.cos(a), ring[0] * Math.sin(a), ring[1]]; };
    var tri = function (a, b, c) { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
    for (k = 0; k + 1 < rings.length; k++) for (i = 0; i < S; i++) {
      tri(at(rings[k], i), at(rings[k], i + 1), at(rings[k + 1], i + 1));
      tri(at(rings[k], i), at(rings[k + 1], i + 1), at(rings[k + 1], i));
    }
    var top = rings[rings.length - 1];
    for (i = 0; i < S; i++) tri(at(top, i), at(top, i + 1), [0, 0, 1]);
    return new Float32Array(pos);
  }
  function solidFor(kind, detail) { return solid(SOLIDS[kind][detail]); }
  function triangles(kind, detail) { return solidFor(kind, detail).length / 9; }

  // { n, f32, u16, u8 }: views over the bytes, nothing copied. Tree i: x, y, z, height = f32[i*5 .. +3],
  // radius cm = u16[i*10 + 8], kind = u8[i*20 + 18], tint = u8[i*20 + 19].
  function parse(buf) {
    if (!buf || buf.byteLength < 8) throw new Error('trees: file too short');
    var m = new Uint8Array(buf, 0, 4);
    if (String.fromCharCode(m[0], m[1], m[2], m[3]) !== 'FTR1') throw new Error('trees: not an FTR1 file');
    var n = new DataView(buf).getUint32(4, true);
    if (buf.byteLength < 8 + n * 20) throw new Error('trees: file cut short');
    return { n: n, f32: new Float32Array(buf, 8, n * 5), u16: new Uint16Array(buf, 8, n * 10), u8: new Uint8Array(buf, 8, n * 20) };
  }
  function restore(saved) {
    var st = {}, k;
    for (k in DEFAULTS) st[k] = DEFAULTS[k];
    if (saved && typeof saved === 'object' && saved.v === STATE_V) for (k in DEFAULTS) if (typeof saved[k] === 'boolean') st[k] = saved[k];
    return st;
  }
  // How the instances are filed: tiles x tiles over the trees' own extent, [kind][tile] -> count.
  function plan(T) {
    var n = T.n, f = T.f32, i, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (i = 0; i < n; i++) { var x = f[i * 5], y = f[i * 5 + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    var G = Math.max(1, Math.min(TILE_MAX, Math.ceil(Math.sqrt(n / TILE_TARGET))));
    var sx = G / Math.max(1e-6, maxX - minX), sy = G / Math.max(1e-6, maxY - minY);
    var tileOf = new Uint16Array(n), counts = [new Uint32Array(G * G), new Uint32Array(G * G), new Uint32Array(G * G)];
    for (i = 0; i < n; i++) {
      var tx = Math.min(G - 1, Math.floor((f[i * 5] - minX) * sx)), ty = Math.min(G - 1, Math.floor((f[i * 5 + 1] - minY) * sy));
      var kind = T.u8[i * 20 + 18]; if (kind > 2) kind = 2;
      tileOf[i] = ty * G + tx; counts[kind][ty * G + tx]++;
    }
    return { G: G, tileOf: tileOf, counts: counts };
  }

  var S = null;      // everything of the running viewer; null = no trees (the normal export)

  // The screen door: with uSee on, every other pixel (a checkerboard) is dropped.
  function screenDoor(mat, uSee) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uSee = uSee;
      sh.fragmentShader = 'uniform float uSee;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n\tif (uSee > 0.5 && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 0.5) discard;');
    };
    return mat;
  }

  function build(T) {
    var THREE = S.THREE, detail = S.detail, P = plan(T), G = P.G, n = T.n, f = T.f32, k, t, i;
    S.group = new THREE.Group(); S.group.name = 'trees'; S.group.matrixAutoUpdate = false;
    S.meshes = [[], [], []];
    S.count = [0, 0, 0];
    var mats = [], geos = [], slot = [[], [], []];
    for (k = 0; k < 3; k++) {
      mats[k] = screenDoor(new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0c160c }), S.uSee);
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(solidFor(k, detail), 3));
      g.computeVertexNormals();
      geos[k] = g;
      for (t = 0; t < G * G; t++) {
        var c = P.counts[k][t];
        slot[k][t] = null;
        if (!c) continue;
        // (each tile has its own copy of the few vertices, so it can carry its own bounds for culling)
        var tg = new THREE.BufferGeometry();
        tg.setAttribute('position', g.attributes.position); tg.setAttribute('normal', g.attributes.normal);
        var mesh = new THREE.InstancedMesh(tg, mats[k], c);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(c * 3), 3);
        mesh.name = 'trees-' + KINDS[k]; mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = true;                               // (three switches it off for instanced meshes; each tile has real bounds)
        mesh.userData = { kind: k, tile: t };
        mesh.visible = k === 2 ? S.st.brush : S.st.trees;
        slot[k][t] = { mesh: mesh, at: 0, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
        S.meshes[k].push(mesh); S.group.add(mesh);
        S.count[k] += c;
      }
    }
    for (i = 0; i < n; i++) {
      var kind = T.u8[i * 20 + 18]; if (kind > 2) kind = 2;
      var s = slot[kind][P.tileOf[i]], m = s.mesh.instanceMatrix.array, o = s.at * 16;
      var x = f[i * 5], y = f[i * 5 + 1], z = f[i * 5 + 2], h = f[i * 5 + 3], r = T.u16[i * 10 + 8] / 100;
      // column-major: scale (r, r, h), then the foot's place
      m[o] = r; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = r; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = h; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
      var tint = TINT_LO + (TINT_HI - TINT_LO) * T.u8[i * 20 + 19] / 255, col = s.mesh.instanceColor.array, c3 = COLOUR[kind];
      col[s.at * 3] = c3[0] / 255 * tint; col[s.at * 3 + 1] = c3[1] / 255 * tint; col[s.at * 3 + 2] = c3[2] / 255 * tint;
      var b = s.box;
      if (x - r < b[0]) b[0] = x - r; if (y - r < b[1]) b[1] = y - r; if (z - h * SINK < b[2]) b[2] = z - h * SINK;
      if (x + r > b[3]) b[3] = x + r; if (y + r > b[4]) b[4] = y + r; if (z + h > b[5]) b[5] = z + h;
      s.at++;
    }
    for (k = 0; k < 3; k++) for (t = 0; t < G * G; t++) {
      var q = slot[k][t]; if (!q) continue;
      var bb = q.box, cx = (bb[0] + bb[3]) / 2, cy = (bb[1] + bb[4]) / 2, cz = (bb[2] + bb[5]) / 2;
      q.mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), Math.sqrt(Math.pow(bb[3] - bb[0], 2) + Math.pow(bb[4] - bb[1], 2) + Math.pow(bb[5] - bb[2], 2)) / 2);
      q.mesh.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(bb[0], bb[1], bb[2]), new THREE.Vector3(bb[3], bb[4], bb[5]));
      q.mesh.instanceMatrix.needsUpdate = true; q.mesh.instanceColor.needsUpdate = true;
      q.mesh.raycast = function () {};                           // taps go through the trees
    }
    S.tiles = G;
    S.scene.add(S.group);
  }

  function redraw() { if (S && S.redraw) S.redraw(); }

  var R = {
    DEFAULTS: DEFAULTS, STATE_V: STATE_V, KINDS: KINDS, parse: parse, restore: restore, plan: plan, solidFor: solidFor, triangles: triangles,

    // o: { THREE, scene, trees, saved, isAssetRef, b64ToArrayBuffer, redraw }.
    // Returns a promise that settles when the trees are in the scene (null trees: at once, false).
    init: function (o) {
      S = null;
      var tr = o && o.trees;
      if (!tr || typeof tr !== 'object' || !tr.file) return Promise.resolve(false);
      var d = tr.detail === 1 || tr.detail === 2 ? tr.detail : 0;
      S = { THREE: o.THREE, scene: o.scene, trees: tr, detail: d, st: restore(o.saved), redraw: o.redraw, uSee: { value: 0 },
            group: null, meshes: [[], [], []], count: [0, 0, 0], tiles: 0, loaded: false };
      S.uSee.value = S.st.see ? 1 : 0;
      var load;
      try {
        load = o.isAssetRef(tr.file)
          ? fetch(tr.file).then(function (r) { if (!r.ok) throw new Error('trees fetch: HTTP ' + r.status); return r.arrayBuffer(); })
          : Promise.resolve(o.b64ToArrayBuffer(tr.file));
      } catch (e) { load = Promise.reject(e); }
      return load.then(function (buf) {
        if (!S) return false;
        build(parse(buf)); S.loaded = true; redraw();
        return true;
      }).catch(function (e) { console.warn('Trees and brush not loaded:', e); return false; });
    },
    active: function () { return !!S; },
    loaded: function () { return !!(S && S.loaded); },
    state: function () { return S ? Object.assign({}, S.st) : null; },
    serialize: function () { return S ? Object.assign({ v: STATE_V }, S.st) : undefined; },
    // { group, meshes: [cones, rounds, mounds], count: [..], tiles, detail, see }
    objects: function () { return S ? { group: S.group, meshes: S.meshes, count: S.count.slice(), tiles: S.tiles, detail: S.detail, see: S.uSee.value } : null; },

    // One switch: trees (cones and round crowns), brush (mounds), see (see-through).
    set: function (key, v) {
      if (!S || !(key in DEFAULTS)) return;
      S.st[key] = !!v;
      if (key === 'see') S.uSee.value = v ? 1 : 0;
      else if (key === 'brush') S.meshes[2].forEach(function (m) { m.visible = !!v; });
      else { S.meshes[0].forEach(function (m) { m.visible = !!v; }); S.meshes[1].forEach(function (m) { m.visible = !!v; }); }
      redraw();
    },

    // The rows in Display. ui: { head, chips } (the viewer's own builders).
    sheet: function (ui) {
      if (!S) return;
      ui.head('Trees and brush');
      var st = S.st, chip = function (icon, label, key) { return [icon, label, !!st[key], function (on) { R.set(key, on); }]; };
      ui.chips([chip('🌲', 'Trees', 'trees'), chip('🌿', 'Brush', 'brush'), chip('👁', 'See-through', 'see')]);
    },
  };

  root.FlexTrees = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
