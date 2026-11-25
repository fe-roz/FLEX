// Trees and brush in the portable viewer / FLEX Field (window.FlexTrees).
//
// An export made with "Trees and brush" carries TREES = { version, count, file, detail }; `file` is
// trees.bin by name or as inline base64 (the viewer's own dual mode). A normal export has TREES = null
// and this file does nothing at all.
//
//   trees.bin  "FTR2", uint32 n, then 24 bytes a tree, little-endian: float32 x, y, z (the foot, in the
//              viewer's own frame), float32 height, uint16 radius in cm, uint8 kind (0 cone, 1 round
//              crown, 2 low mound), uint8 tint (0..255); uint16 the crown's base above the foot in cm, uint16 spare.
//              Version 1 ("FTR1", 20 bytes a tree, no crown base) is read too.
//
// Every tree and bush is ONE of three stock solids stretched to its radius and height: instanced meshes
// (THREE.InstancedMesh, r128), a few triangles a shape, fewer when the export says the area is large
// (detail 0 / 1 / 2). The whole area is drawn, with no distance limit; the instances are filed in ground
// tiles so the ones out of view are skipped. Opacity is an ordered dither (a 4 x 4 Bayer pattern, 16
// steps: at level k / 16 the fragment shader keeps k pixels of every 16 and drops the rest): no blending,
// no sorting, no second pass, depth test and depth write stay on. One level for the trees (cones, round
// crowns, trunks), one for the brush (the mounds, or the brush blocks of libs/brush-blocks.js when the
// map has them: then the mounds are hidden and the Brush chip and its level drive the blocks, or whichever
// other look of the grid FlexBrush.look(name) put on; that name is kept in this state as `look`).
// Nothing animates and nothing runs per frame: a switch or a level asks the viewer for one redraw. Trees
// are not part of the terrain: the height grid and taps do not see them.   Test: tools/test_viewer_trees.js
(function (root) {
  'use strict';

  var KINDS = ['cone', 'round', 'mound'];                       // by the file's kind number
  var COLOUR = [[0x2c, 0x5a, 0x33], [0x4a, 0x86, 0x3c], [0x7c, 0x96, 0x4c]];     // conifer, broadleaf, brush
  var TINT_LO = 0.78, TINT_HI = 1.16;                          // the tint byte scales the colour between these
  var SINK = 0.06;                                             // the solids start this share of their height under the foot (slopes)
  // `crown` is a look to compare, not in Display yet: off = a conifer is a spike from the ground up (as ever);
  // on = its cone starts at the crown's base, on a thin trunk (FlexTrees.set('crown', true)).
  // treesOp / brushOp: the opacity levels, 1/16 .. 1 in steps of 1/16.
  var DEFAULTS = { trees: true, brush: true, treesOp: 0.5, brushOp: 0.5, crown: false };
  var STEPS = 16, HOLD_MS = 450;                               // dither steps; how long a chip is held for its slider
  var TRUNK_COLOUR = [0x4c, 0x3b, 0x2a], TRUNK_SHARE = 0.06, TRUNK_MIN = 0.15;      // trunk radius: a share of the crown's, at least 15 cm
  var CROWN_MIN = 0.25;                                        // a crown is at least this share of the tree's height
  var STATE_V = 2;                                             // 1 had `see` (true = the 50 % screen door) in place of the two levels
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
    if (!def.open) for (i = 0; i < S; i++) tri(at(top, i), at(top, i + 1), [0, 0, 1]);
    return new Float32Array(pos);
  }
  function solidFor(kind, detail) { return solid(SOLIDS[kind][detail]); }
  function triangles(kind, detail) { return solidFor(kind, detail).length / 9; }

  // { n, version, B, F, U, f32, u16, u8 }: views over the bytes, nothing copied; B bytes a tree (24, or 20 in
  // version 1), F = B / 4, U = B / 2. Tree i: x, y, z, height = f32[i*F .. +3], radius cm = u16[i*U + 8],
  // kind = u8[i*B + 18], tint = u8[i*B + 19], and in version 2 the crown's base in cm = u16[i*U + 10].
  function parse(buf) {
    if (!buf || buf.byteLength < 8) throw new Error('trees: file too short');
    var m = new Uint8Array(buf, 0, 4);
    var tag = String.fromCharCode(m[0], m[1], m[2], m[3]);
    if (tag !== 'FTR1' && tag !== 'FTR2') throw new Error('trees: not an FTR1 / FTR2 file');
    var B = tag === 'FTR2' ? 24 : 20, n = new DataView(buf).getUint32(4, true);
    if (buf.byteLength < 8 + n * B) throw new Error('trees: file cut short');
    return { n: n, version: B === 24 ? 2 : 1, B: B, F: B / 4, U: B / 2,
             f32: new Float32Array(buf, 8, n * B / 4), u16: new Uint16Array(buf, 8, n * B / 2), u8: new Uint8Array(buf, 8, n * B) };
  }
  // A level as the dither can show it: a whole number of sixteenths, never under one.
  function quant(v) { v = Math.round(Number(v) * STEPS); return (v >= 1 ? (v > STEPS ? STEPS : v) : 1) / STEPS; }
  function restore(saved) {
    var st = {}, k;
    for (k in DEFAULTS) st[k] = DEFAULTS[k];
    if (!saved || typeof saved !== 'object') return st;
    if (saved.v === STATE_V) {
      for (k in DEFAULTS) {
        if (typeof DEFAULTS[k] === 'boolean') { if (typeof saved[k] === 'boolean') st[k] = saved[k]; }
        else if (typeof saved[k] === 'number' && isFinite(saved[k])) st[k] = quant(saved[k]);
      }
    } else if (saved.v === 1) {                                 // the See-through switch: on was every other pixel (50 %), off solid
      ['trees', 'brush', 'crown'].forEach(function (q) { if (typeof saved[q] === 'boolean') st[q] = saved[q]; });
      if (typeof saved.see === 'boolean') st.treesOp = st.brushOp = saved.see ? 0.5 : 1;
    }
    // the brush's look (libs/brush-blocks.js); 'blocks' and 'blanket' are from before the bushes were the look: forgotten, the map's own default applies
    if (typeof saved.look === 'string' && saved.look.length < 40 && saved.look !== 'blocks' && saved.look !== 'blanket') st.look = saved.look;
    if (Array.isArray(saved.classesOn) && saved.classesOn.length <= 16 && saved.classesOn.every(function (b) { return typeof b === 'boolean'; })) st.classesOn = saved.classesOn.slice();   // the brush classes shown
    return st;
  }
  // The 4 x 4 Bayer pattern: pixel (x, y) has rank 0..15, and is kept at level k / 16 when its rank is under k.
  // (Rank < 8 is the checkerboard, so 50 % is the screen door this replaced.) The shader computes the same.
  function bayer2(x, y) { x &= 1; y &= 1; return ((x * 2 + y * y * 3) & 3); }            // 0 2 / 3 1, in quarters
  function bayer4(x, y) { return bayer2(x >> 1, y >> 1) + 4 * bayer2(x, y); }
  function kept(level) { var n = 0, x, y; for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) if ((bayer4(x, y) + 0.5) / STEPS <= level) n++; return n; }
  var DITHER_HEAD = 'uniform float uOpacityDither;\n' +
    'float flexBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }\n' +
    'float flexBayer4(vec2 a) { return flexBayer2(0.5 * a) * 0.25 + flexBayer2(a); }\n';
  var DITHER_BODY = '\n\tif (flexBayer4(gl_FragCoord.xy) + 0.03125 > uOpacityDither) discard;';
  // Patches a three.js material so it is drawn at `uniform.value` (0..1) by the ordered dither. Shared with the brush blocks.
  function dither(mat, uniform) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uOpacityDither = uniform;
      sh.fragmentShader = DITHER_HEAD + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + DITHER_BODY);
      if (root.FlexUnder) root.FlexUnder.sunk(sh);          // seen from underground: no sunk parts hanging from the ceiling (libs/terrain-under.js)
    };
    return mat;
  }
  // How the instances are filed: tiles x tiles over the trees' own extent, [kind][tile] -> count.
  function plan(T) {
    var n = T.n, f = T.f32, F = T.F, i, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (i = 0; i < n; i++) { var x = f[i * F], y = f[i * F + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    var G = Math.max(1, Math.min(TILE_MAX, Math.ceil(Math.sqrt(n / TILE_TARGET))));
    var sx = G / Math.max(1e-6, maxX - minX), sy = G / Math.max(1e-6, maxY - minY);
    var tileOf = new Uint16Array(n), counts = [new Uint32Array(G * G), new Uint32Array(G * G), new Uint32Array(G * G)];
    for (i = 0; i < n; i++) {
      var tx = Math.min(G - 1, Math.floor((f[i * F] - minX) * sx)), ty = Math.min(G - 1, Math.floor((f[i * F + 1] - minY) * sy));
      var kind = T.u8[i * T.B + 18]; if (kind > 2) kind = 2;
      tileOf[i] = ty * G + tx; counts[kind][ty * G + tx]++;
    }
    return { G: G, tileOf: tileOf, counts: counts };
  }

  var S = null;      // everything of the running viewer; null = no trees (the normal export)

  // Are the brush blocks drawing the brush (libs/brush-blocks.js)? Then the mounds stay hidden.
  function blocksOn() { return !!(S && S.blocks); }
  function applyBrush() {
    var on = S.st.brush;
    S.meshes[2].forEach(function (m) { m.visible = on && !S.blocks; });
    if (S.blocks) S.blocks.set({ on: on, opacity: S.st.brushOp });
  }

  function build(T) {
    var THREE = S.THREE, detail = S.detail, P = plan(T), G = P.G, n = T.n, f = T.f32, F = T.F, k, t, i;
    S.group = new THREE.Group(); S.group.name = 'trees'; S.group.matrixAutoUpdate = false;
    S.meshes = [[], [], []];
    S.count = [0, 0, 0];
    var mats = [], geos = [], slot = [[], [], []];
    for (k = 0; k < 3; k++) {
      mats[k] = dither(new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0c160c }), k === 2 ? S.uBrush : S.uTrees);
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
        mesh.userData = { kind: k, tile: t, zhb: k === 0 ? new Float32Array(c * 3) : null };      // cones: foot z, height, crown base
        mesh.visible = k === 2 ? S.st.brush && !S.blocks : S.st.trees;
        slot[k][t] = { mesh: mesh, at: 0, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
        S.meshes[k].push(mesh); S.group.add(mesh);
        S.count[k] += c;
      }
    }
    for (i = 0; i < n; i++) {
      var kind = T.u8[i * T.B + 18]; if (kind > 2) kind = 2;
      var s = slot[kind][P.tileOf[i]], m = s.mesh.instanceMatrix.array, o = s.at * 16;
      var x = f[i * F], y = f[i * F + 1], z = f[i * F + 2], h = f[i * F + 3], r = T.u16[i * T.U + 8] / 100;
      if (kind === 0) { var zhb = s.mesh.userData.zhb; zhb[s.at * 3] = z; zhb[s.at * 3 + 1] = h; zhb[s.at * 3 + 2] = T.version === 2 ? T.u16[i * T.U + 10] / 100 : 0; }
      // column-major: scale (r, r, h), then the foot's place
      m[o] = r; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = r; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = h; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
      var tint = TINT_LO + (TINT_HI - TINT_LO) * T.u8[i * T.B + 19] / 255, col = s.mesh.instanceColor.array, c3 = COLOUR[kind];
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
    if (S.st.crown) crownLook(true);
  }

  // The other look of the conifers: each cone from its crown's base to its top (never under CROWN_MIN of the
  // height), on a thin trunk from the ground (the trunks are made the first time, a 3-sided post a tree; none
  // at the lowest detail). Off puts the spikes back. Only the cones' matrices change; bounds stay.
  function crownLook(on) {
    var THREE = S.THREE;
    S.meshes[0].forEach(function (mesh) {
      var a = mesh.instanceMatrix.array, q = mesh.userData.zhb, n = mesh.count, i;
      for (i = 0; i < n; i++) {
        var z = q[i * 3], h = q[i * 3 + 1], b = on ? Math.min(q[i * 3 + 2], h * (1 - CROWN_MIN)) : 0;
        a[i * 16 + 10] = h - b; a[i * 16 + 14] = z + b;
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (on && !mesh.userData.trunks && S.detail < 2) {
        if (!S.trunkGeo) {
          S.trunkGeo = new THREE.BufferGeometry();
          S.trunkGeo.setAttribute('position', new THREE.BufferAttribute(solid({ sides: 3, rings: [[1, -SINK], [1, 1]], open: true }), 3));
          S.trunkGeo.computeVertexNormals();
          S.trunkMat = dither(new THREE.MeshLambertMaterial({ color: (TRUNK_COLOUR[0] << 16) | (TRUNK_COLOUR[1] << 8) | TRUNK_COLOUR[2] }), S.uTrees);
        }
        var tg = new THREE.BufferGeometry();
        tg.setAttribute('position', S.trunkGeo.attributes.position); tg.setAttribute('normal', S.trunkGeo.attributes.normal);
        tg.boundingSphere = mesh.geometry.boundingSphere; tg.boundingBox = mesh.geometry.boundingBox;
        var tm = new THREE.InstancedMesh(tg, S.trunkMat, n), m = tm.instanceMatrix.array;
        for (i = 0; i < n; i++) {
          var bb = Math.min(q[i * 3 + 2], q[i * 3 + 1] * (1 - CROWN_MIN)), tr = Math.max(TRUNK_MIN, a[i * 16] * TRUNK_SHARE), o = i * 16;
          m[o] = tr; m[o + 5] = tr; m[o + 10] = Math.max(bb, 0.01); m[o + 12] = a[o + 12]; m[o + 13] = a[o + 13]; m[o + 14] = q[i * 3]; m[o + 15] = 1;
        }
        tm.name = 'trees-trunk'; tm.matrixAutoUpdate = false; tm.frustumCulled = true; tm.raycast = function () {};
        tm.instanceMatrix.needsUpdate = true;
        mesh.userData.trunks = tm; S.trunks.push(tm); S.group.add(tm);
      }
    });
    S.trunks.forEach(function (tm) { tm.visible = !!on && S.st.trees; });
  }

  function redraw() { if (S && S.redraw) S.redraw(); }

  // ── A chip that also carries a level ────────────────────────────────────────
  // The chip's background fills from the left to its level (blue when on, grey when off). Held for HOLD_MS, a
  // slider opens ABOVE the chip (fixed to the page, so the sheet's scrolling cannot cut it); a tap is still the
  // switch. Moving the slider on a chip that is off switches it on. Nothing here runs unless a finger is down.
  var pop = null;                                               // the open slider: { el, close }
  function closePop() { if (pop) pop.close(); }
  function levelChip(c, setOn, o) {
    var doc = c.ownerDocument, win = doc.defaultView, timer = null, held = false, x0 = 0, y0 = 0;
    var paint = function () {
      var pc = Math.round(o.level() * 100), on = c.classList.contains('a');
      c.style.background = 'linear-gradient(90deg, ' + (on ? 'rgba(33,150,243,.55)' : 'rgba(255,255,255,.16)') + ' ' + pc + '%, ' + (on ? 'rgba(33,150,243,.14)' : 'transparent') + ' ' + pc + '%)';
      c.setAttribute('data-level', String(pc));
      c.title = o.label + ' ' + pc + ' % (hold for the slider)';
    };
    var open = function () {
      closePop();
      var box = doc.createElement('div'), txt = doc.createElement('span'), sl = doc.createElement('input'), r = c.getBoundingClientRect();
      box.className = 'sh-level-pop';
      box.style.cssText = 'position:fixed;z-index:9000;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(24,28,34,.97);' +
        'border:1px solid rgba(255,255,255,.25);border-radius:10px;color:#eee;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.5);touch-action:none;';
      var w = Math.max(r.width, 200), vw = win.innerWidth || 9999, left = Math.max(6, r.left + w > vw - 6 ? Math.min(r.right, vw - 6) - w : r.left);   // over the chip; a chip at the right edge has it end with the chip
      box.style.width = w + 'px'; box.style.left = left + 'px'; box.style.bottom = Math.max(6, (win.innerHeight || 0) - r.top + 6) + 'px';
      sl.type = 'range'; sl.min = '1'; sl.max = String(STEPS); sl.step = '1'; sl.value = String(Math.round(o.level() * STEPS));
      sl.style.cssText = 'flex:1;min-width:0;height:26px;margin:0;';
      sl.setAttribute('aria-label', o.label + ' opacity');
      txt.style.cssText = 'width:38px;text-align:right;font-variant-numeric:tabular-nums;';
      var say = function () { txt.textContent = Math.round(o.level() * 100) + ' %'; };
      sl.addEventListener('input', function () {
        o.setLevel(Number(sl.value) / STEPS);
        if (!c.classList.contains('a')) { setOn(true); o.setOn(true); }
        say(); paint();
      });
      box.appendChild(sl); box.appendChild(txt); say();
      doc.body.appendChild(box);
      var away = function (e) { if (!box.contains(e.target)) me.close(); };
      // (the slider is outside the sheet, whose own "tap outside closes" must not take a touch on it for one)
      var mine = function (e) { if (box.contains(e.target)) e.stopPropagation(); };
      win.addEventListener('pointerdown', mine, true);
      var gone = win.MutationObserver ? new win.MutationObserver(function () { if (!c.isConnected) me.close(); }) : null;
      if (gone && c.parentNode && c.parentNode.parentNode) gone.observe(c.parentNode.parentNode, { childList: true });
      var me = { el: box, chip: c, close: function () {
        if (pop === me) pop = null;
        doc.removeEventListener('pointerdown', away, true); win.removeEventListener('pointerdown', mine, true); if (gone) gone.disconnect();
        if (box.parentNode) box.parentNode.removeChild(box);
      } };
      setTimeout(function () { if (pop === me) doc.addEventListener('pointerdown', away, true); }, 0);
      pop = me;
    };
    var stop = function () { if (timer) { clearTimeout(timer); timer = null; } };
    c.style.touchAction = 'manipulation'; c.style.userSelect = 'none'; c.style.webkitUserSelect = 'none'; c.style.webkitTouchCallout = 'none';
    c.addEventListener('pointerdown', function (e) {
      held = false; x0 = e.clientX; y0 = e.clientY; stop();
      timer = setTimeout(function () { timer = null; held = true; open(); }, HOLD_MS);
    });
    c.addEventListener('pointermove', function (e) { if (timer && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) > 12) stop(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { c.addEventListener(t, stop); });
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // (registered before the host's own click handler: a hold must not also switch the chip)
    c.addEventListener('click', function (e) { if (held) { held = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    c._paintLevel = paint;
    paint();
  }

  var R = {
    DEFAULTS: DEFAULTS, STATE_V: STATE_V, STEPS: STEPS, HOLD_MS: HOLD_MS, KINDS: KINDS, parse: parse, restore: restore, plan: plan, solidFor: solidFor, triangles: triangles,
    quant: quant, bayer4: bayer4, kept: kept, dither: dither,

    // o: { THREE, scene, trees, saved, isAssetRef, b64ToArrayBuffer, redraw, blocks }.
    // blocks: window.FlexBrush when the map has brush blocks (its active() is true): the Brush chip then drives
    // them and the mounds are hidden; a map with blocks and no trees has the Brush chip alone.
    // Returns a promise that settles when the trees are in the scene (no trees: at once, false).
    init: function (o) {
      S = null; closePop();
      var tr = o && o.trees, bl = o && o.blocks && o.blocks.active && o.blocks.active() ? o.blocks : null;
      if (!tr || typeof tr !== 'object' || !tr.file) tr = null;
      if (!tr && !bl) return Promise.resolve(false);
      var d = tr && (tr.detail === 1 || tr.detail === 2) ? tr.detail : 0;
      S = { THREE: o.THREE, scene: o.scene, trees: tr, detail: d, st: restore(o.saved), redraw: o.redraw, uTrees: { value: 1 }, uBrush: { value: 1 }, blocks: bl,
            group: null, meshes: [[], [], []], trunks: [], trunkGeo: null, trunkMat: null, count: [0, 0, 0], tiles: 0, loaded: false, classRow: null };
      S.uTrees.value = S.st.treesOp; S.uBrush.value = S.st.brushOp;
      var mine = S;
      if (bl) {
        if (bl.classesOn && S.st.classesOn) bl.classesOn(S.st.classesOn);
        if (bl.look && S.st.look) bl.look(S.st.look);            // the look chosen before (a name nobody registered: the blocks)
        applyBrush();
        // blocks that did not load: the mounds are the brush again
        if (bl.whenReady) bl.whenReady().then(function (ok) { if (S !== mine) return; if (!ok) { S.blocks = null; applyBrush(); redraw(); } });
      }
      if (!tr) return Promise.resolve(false);
      var load;
      try {
        load = o.isAssetRef(tr.file)
          ? fetch(tr.file).then(function (r) { if (!r.ok) throw new Error('trees fetch: HTTP ' + r.status); return r.arrayBuffer(); })
          : Promise.resolve(o.b64ToArrayBuffer(tr.file));
      } catch (e) { load = Promise.reject(e); }
      return load.then(function (buf) {
        if (S !== mine) return false;
        build(parse(buf)); S.loaded = true; redraw();
        return true;
      }).catch(function (e) { console.warn('Trees and brush not loaded:', e); return false; });
    },
    active: function () { return !!S; },
    loaded: function () { return !!(S && S.loaded); },
    state: function () { return S ? Object.assign({}, S.st) : null; },
    // (the brush's look is asked where it lives: FlexBrush.look(name) switches it, and it is saved from here)
    serialize: function () { return S ? Object.assign({ v: STATE_V }, S.st, S.blocks && S.blocks.look ? { look: S.blocks.look() } : null, S.blocks && S.blocks.classesOn && S.blocks.classesOn() ? { classesOn: S.blocks.classesOn() } : null) : undefined; },
    // { group, meshes: [cones, rounds, mounds], trunks, count: [..], tiles, detail, op: [trees, brush] levels, blocks }
    objects: function () { return S ? { group: S.group, meshes: S.meshes, trunks: S.trunks, count: S.count.slice(), tiles: S.tiles, detail: S.detail, op: [S.uTrees.value, S.uBrush.value], blocks: blocksOn() } : null; },

    // One switch: trees (cones and round crowns), brush (mounds, or the brush blocks), crown (the conifers' other look).
    set: function (key, v) {
      if (!S || typeof DEFAULTS[key] !== 'boolean') return;
      S.st[key] = !!v;
      if (key === 'crown') { if (S.loaded) crownLook(!!v); }
      else if (key === 'brush') { applyBrush(); if (S.classRow) S.classRow(); }
      else { S.meshes[0].forEach(function (m) { m.visible = !!v; }); S.meshes[1].forEach(function (m) { m.visible = !!v; }); S.trunks.forEach(function (m) { m.visible = !!v && S.st.crown; }); }
      redraw();
    },
    // One opacity level, 0..1 (drawn in sixteenths, at least one): key 'trees' or 'brush'. No rebuild: a uniform.
    level: function (key, v) {
      if (!S || (key !== 'trees' && key !== 'brush') || !isFinite(Number(v))) return;
      v = quant(v);
      S.st[key + 'Op'] = v;
      if (key === 'trees') S.uTrees.value = v; else { S.uBrush.value = v; if (S.blocks) S.blocks.set({ on: S.st.brush, opacity: v }); }
      redraw();
    },

    // The rows in Display. ui: { head, chips } (the viewer's own builders). A chip is [icon, label, on, onChange,
    // more]; `more.attach(chipElement, setOn)` is called by the host before it adds its own click handler.
    sheet: function (ui) {
      if (!S) return;
      ui.head(S.trees ? 'Trees and brush' : 'Brush');
      var st = S.st, chip = function (icon, label, key) {
        var el = null;
        return [icon, label, !!st[key], function (on) { R.set(key, on); if (el && el._paintLevel) el._paintLevel(); },
          { level: st[key + 'Op'], attach: function (c, setOn) {
            el = c;
            if (c && c.addEventListener && c.ownerDocument) levelChip(c, setOn, { label: label, level: function () { return S ? S.st[key + 'Op'] : 1; },
              setLevel: function (v) { R.level(key, v); }, setOn: function (on) { R.set(key, on); } });
          } }];
      };
      ui.chips((S.trees ? [chip('🌲', 'Trees', 'trees')] : []).concat([chip('🌿', 'Brush', 'brush')]));
      // A map with a brush grid: one small chip a class (Light, Medium, Dense), each on / off at once in whichever
      // look draws the brush; the row is there only while Brush is on. (The baked brush picture is not changed.)
      var info = S.blocks && S.blocks.classInfo ? S.blocks.classInfo() : [];
      S.classRow = null;
      if (info.length > 1) {
        var els = [];
        var paint = function () {
          var inf = S && S.blocks ? S.blocks.classInfo() : [], show = !!(S && S.st.brush);
          els.forEach(function (c, k) {
            if (!c || !c.style) return;
            if (c.parentNode && c.parentNode.style) { c.parentNode.style.display = show ? '' : 'none'; c.parentNode.style.gridTemplateColumns = 'repeat(' + els.length + ', 1fr)'; c.parentNode.style.marginTop = '6px'; }
            if (c.firstChild && c.firstChild.style && inf[k]) c.firstChild.style.background = inf[k].colour;
          });
        };
        S.classRow = paint;
        ui.chips(info.map(function (ci, k) {
          var label = ci.name ? ci.name.charAt(0).toUpperCase() + ci.name.slice(1) : 'Class ' + (k + 1);
          return ['', label, ci.on, function (on) { var v = S.blocks.classesOn(); v[k] = !!on; S.blocks.classesOn(v); redraw(); },
            { brushClass: k, attach: function (c) {
              els[k] = c;
              if (!c || !c.style) return;
              c.className += ' sh-chip-class'; c.style.padding = '4px 6px'; c.style.fontSize = '11px'; c.style.justifyContent = 'center'; c.style.minWidth = '0';
              var sw = c.firstChild;
              if (sw && sw.style) { sw.style.width = '11px'; sw.style.height = '11px'; sw.style.borderRadius = '3px'; sw.style.flex = '0 0 11px'; sw.style.border = '1px solid rgba(255,255,255,.35)'; sw.style.background = ci.colour; }
              if (typeof Promise !== 'undefined') Promise.resolve().then(paint);
            } }];
        }));
      }
    },
    closeSlider: closePop,
  };

  root.FlexTrees = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
