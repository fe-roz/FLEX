// Surface features in the portable viewer / FLEX Field (window.ViewerFeatures): view only.
//
// An export made with "Include surface features" carries FEATURES = { version: 1,
//   folders: [{ id, name, parent }],
//   items:   [{ id, kind: point|line|area, name, folder, colour, symbol, width, opacity, label?, note?, lonlat: [[lon, lat], ...] }] }
// (the open project's points, lines and areas inside the export area, as the desktop draws them), inline, or the
// name of a JSON file beside the viewer. Any other export has FEATURES = null and this file does nothing at all.
//
// How they are drawn, following what the viewer already does for saved points, tracks and imported KML:
//   points   a sprite of a fixed size on screen, never hidden by the terrain (like the saved-point pins), in the
//            item's colour and symbol (dot, square, triangle, diamond, star, cross: folder-style.js on the desktop);
//   names    the viewer's own text sprites (makeTextSprite, handed in), only the nearest that do not overlap,
//            worked out when the view comes to rest: never per frame;
//   lines    draped on the terrain (the ground's height under every few metres of the line), in the item's colour
//            and at its width in screen pixels: three.js lines are one pixel wide whatever is asked, so each
//            segment is a thin quad widened in the vertex shader. One mesh per folder;
//   areas    their outline the same way, and a light fill.
// Each folder is one group, so a folder's switch is one flag. Nothing animates. three.js r128.
// "Show through hills" (on by default): everything is drawn whatever is in front of it. Off: the depth test is on,
// so terrain in front hides points, lines and fills; each is drawn a little nearer than it is (PULL: a metre or so
// plus a share of its distance) so the ground it lies on never cuts it; a point's symbol has one depth all over. A
// name is shown whole or not at all: its line of sight is checked against the terrain's heights when the view comes
// to rest, with the same allowance, and so is a tap.
// Never mixed into the user's own saved points; nothing here can be edited or deleted.
// Test: tools/test_viewer_features.js
(function (root) {
  'use strict';

  var SYMBOLS = ['dot', 'square', 'triangle', 'diamond', 'star', 'cross'];
  var POINT_PX = 18, LABEL_PX = 14, LABEL_CAP = 140, NAME_MAX = 30;
  var LIFT = 0.6;                       // metres above the ground (the terrain mesh is coarser than the ground)
  var DRAPE_STEP = 4, DRAPE_MAX = 6000; // a ground height every 4 m of line, at most this many per item
  var FILL_ALPHA = 0.18, FILL_MAX_RING = 2000;
  var HIT_POINT_PX = 26, HIT_LINE_PX = 13;
  // With "Show through hills" off, how much nearer than it is each thing is tested: [metres, share of its distance].
  // A symbol's lower half hangs in front of ground that is nearer than its foot (more so at a low angle): 5 % clears
  // it down to a view about 12 degrees above the ground. Lines are thin: they only have to clear the terrain mesh,
  // which is coarser than the ground they were laid on.
  var PULL_POINT = [1.0, 0.05], PULL_LINE = [1.5, 0.01];
  var FOLDERS_OPEN_MAX = 12;            // more folders than this: the list in Display starts folded
  var DEFAULT_COLOUR = '#ffb020';
  var S = null;

  function hex(c) { return /^#[0-9a-f]{6}$/i.test(c || '') ? c.toLowerCase() : DEFAULT_COLOUR; }
  function rgb(c) { c = hex(c); return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255]; }
  // The colour of a name: the item's, lifted toward white so it reads over dark ground.
  function labelColour(c) {
    var v = rgb(c).map(function (x) { return Math.round((x + (1 - x) * 0.55) * 255); });
    return '#' + v.map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
  }
  function shortName(n) { n = String(n || ''); return n.length > NAME_MAX ? n.slice(0, NAME_MAX - 1) + '…' : n; }

  // ── The folders: a tree, with the items that sit directly in each ───────────
  // → { list: [{ id, name, parent, depth, path, items: [item], total }] in tree order (parents first) , byId }
  // Items in no folder (or in one the file does not name) sit in the folder '' ("No folder"), listed last.
  function tree(F) {
    var byId = {}, kids = {}, list = [];
    (F.folders || []).forEach(function (g) { if (g && g.id && !byId[g.id]) byId[g.id] = { id: String(g.id), name: String(g.name || 'Folder'), parent: String(g.parent || ''), items: [], total: 0 }; });
    Object.keys(byId).forEach(function (id) {
      var g = byId[id], seen = {}, p = g.parent;
      while (p && byId[p] && !seen[p] && p !== id) { seen[p] = 1; p = byId[p].parent; }
      if (!byId[g.parent] || p === id) g.parent = '';                 // unknown parent, or a loop: a top folder
      (kids[g.parent] = kids[g.parent] || []).push(g);
    });
    var none = { id: '', name: 'No folder', parent: '', depth: 0, path: '', items: [], total: 0 };
    (F.items || []).forEach(function (it) {
      if (!it || !it.lonlat || !it.lonlat.length) return;
      (byId[it.folder] || none).items.push(it);
    });
    (function walk(parent, depth, path) {
      (kids[parent] || []).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (g) {
        g.depth = depth; g.path = path ? path + ' / ' + g.name : g.name;
        list.push(g);
        walk(g.id, depth + 1, g.path);
      });
    })('', 0, '');
    for (var i = list.length - 1; i >= 0; i--) {                      // totals: children come after their parent
      var g = list[i]; g.total += g.items.length;
      if (g.parent && byId[g.parent]) byId[g.parent].total += g.total;
    }
    if (none.items.length) { none.total = none.items.length; list.push(none); byId[''] = none; }
    list.forEach(function (g) { g.items.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }); });
    return { list: list, byId: byId };
  }

  // ── Saved choices ───────────────────────────────────────────────────────────
  function restore(saved) {
    var st = { all: true, labels: true, through: true, off: {} };
    if (saved && typeof saved === 'object') {
      if (saved.through === false) st.through = false;
      if (saved.all === false) st.all = false;
      if (saved.labels === false) st.labels = false;
      (Array.isArray(saved.off) ? saved.off : []).forEach(function (id) { st.off[String(id)] = true; });
    }
    return st;
  }

  // ── Symbols: one small picture per symbol and colour ────────────────────────
  function symbolPath(g, sym, c, r) {
    g.beginPath();
    if (sym === 'square') g.rect(c - r * 0.82, c - r * 0.82, r * 1.64, r * 1.64);
    else if (sym === 'triangle') { g.moveTo(c, c - r); g.lineTo(c + r * 0.95, c + r * 0.78); g.lineTo(c - r * 0.95, c + r * 0.78); g.closePath(); }
    else if (sym === 'diamond') { g.moveTo(c, c - r); g.lineTo(c + r * 0.8, c); g.lineTo(c, c + r); g.lineTo(c - r * 0.8, c); g.closePath(); }
    else if (sym === 'star') {
      for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r * 1.05; g[i ? 'lineTo' : 'moveTo'](c + rr * Math.cos(a), c + rr * Math.sin(a)); }
      g.closePath();
    } else if (sym === 'cross') {
      var t = r * 0.34;
      g.moveTo(c - t, c - r); g.lineTo(c + t, c - r); g.lineTo(c + t, c - t); g.lineTo(c + r, c - t); g.lineTo(c + r, c + t); g.lineTo(c + t, c + t);
      g.lineTo(c + t, c + r); g.lineTo(c - t, c + r); g.lineTo(c - t, c + t); g.lineTo(c - r, c + t); g.lineTo(c - r, c - t); g.lineTo(c - t, c - t); g.closePath();
    } else g.arc(c, c, r * 0.86, 0, Math.PI * 2);
  }
  function symbolCanvas(sym, colour, size) {
    var c = root.document.createElement('canvas'); c.width = c.height = size;
    var g = c.getContext('2d'), m = size / 2, r = size * 0.36;
    g.lineJoin = 'round';
    symbolPath(g, sym, m, r); g.lineWidth = size * 0.17; g.strokeStyle = 'rgba(0,0,0,.85)'; g.stroke();     // dark edge, then a white one, then the colour
    symbolPath(g, sym, m, r); g.lineWidth = size * 0.08; g.strokeStyle = '#fff'; g.stroke();
    symbolPath(g, sym, m, r); g.fillStyle = colour; g.fill();
    return c;
  }
  function symbolTexture(sym, colour) {
    var k = sym + colour, t = S.tex[k];
    if (!t) { t = S.tex[k] = new S.THREE.CanvasTexture(symbolCanvas(sym, colour, 64)); }
    return t;
  }

  // ── Positions ───────────────────────────────────────────────────────────────
  // The item's line in the scene, with the ground's height every DRAPE_STEP metres. Where the terrain has no
  // height (a line that leaves the map, a hole) the last height known carries on.
  function drape(it, closed) {
    var pts = it.lonlat.map(function (c) { return S.toScene(c[1], c[0]); });
    if (closed && pts.length > 2) pts = pts.concat([pts[0]]);
    var len = 0, i;
    for (i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    var step = Math.max(DRAPE_STEP, len / DRAPE_MAX), out = [], zs = [];
    function push(x, y) { out.push(x, y, 0); zs.push(S.groundZ(x, y)); }
    for (i = 0; i < pts.length; i++) {
      if (i) {
        var a = pts[i - 1], b = pts[i], d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.min(4000, Math.floor(d / step));
        for (var k = 1; k <= n; k++) { var u = k / (n + 1); push(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u); }
      }
      push(pts[i].x, pts[i].y);
    }
    var last = null, j;
    for (j = 0; j < zs.length; j++) if (zs[j] != null && isFinite(zs[j])) { last = zs[j]; break; }
    if (last == null) last = 0;
    for (j = 0; j < zs.length; j++) { if (zs[j] != null && isFinite(zs[j])) last = zs[j]; out[j * 3 + 2] = last + LIFT; }
    return { xyz: out, length: len, corners: pts };
  }
  function pointPos(it) {
    var p = S.toScene(it.lonlat[0][1], it.lonlat[0][0]), z = S.groundZ(p.x, p.y);
    return new S.THREE.Vector3(p.x, p.y, (z != null && isFinite(z) ? z : 0) + LIFT);
  }

  // ── Wide lines: every segment a quad, widened on screen in the vertex shader ─
  // GLSL: the depth of a vertex as if it were `pull` nearer (mv = its position in view space); x, y stay.
  function pullGlsl(mv, p) {
    return '{ float vfD = -' + mv + '.z; float vfP = min(' + p[0].toFixed(3) + ' + ' + p[1].toFixed(4) + ' * vfD, vfD * 0.5);' +
           ' vec4 vfQ = projectionMatrix * vec4(' + mv + '.xy, ' + mv + '.z + vfP, 1.0); gl_Position.z = vfQ.z / vfQ.w * gl_Position.w; }';
  }
  // For three's own materials (sprites, the fills): the same, added where they set gl_Position.
  function pulled(mat, p) {
    mat.onBeforeCompile = function (sh) {
      sh.vertexShader = sh.vertexShader.replace('gl_Position = projectionMatrix * mvPosition;', 'gl_Position = projectionMatrix * mvPosition; ' + pullGlsl('mvPosition', p))
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + pullGlsl('mvPosition', p));
    };
    mat.customProgramCacheKey = function () { return 'vf-pull' + p.join(); };
    return mat;
  }
  var LINE_VS = [
    'uniform vec2 res;',
    'attribute vec3 other; attribute float side; attribute float wpx; attribute vec4 col;',
    'varying vec4 vCol;',
    'void main() {',
    '  vec4 mvA = modelViewMatrix * vec4(position, 1.0);',
    '  vec4 a = projectionMatrix * mvA;',
    '  vec4 b = projectionMatrix * modelViewMatrix * vec4(other, 1.0);',
    '  vec2 sa = a.xy / max(abs(a.w), 1e-4) * res, sb = b.xy / max(abs(b.w), 1e-4) * res;',
    '  vec2 d = sb - sa; float l = length(d); d = l > 1e-4 ? d / l : vec2(1.0, 0.0);',
    '  a.xy += vec2(-d.y, d.x) * side * wpx / res * a.w;',
    '  vCol = col; gl_Position = a;',
    '  ' + pullGlsl('mvA', PULL_LINE),
    '}'].join('\n');
  var LINE_FS = 'varying vec4 vCol; void main() { gl_FragColor = vCol; }';
  function lineMaterial() {
    var T = S.THREE;
    return new T.ShaderMaterial({ uniforms: { res: S.res }, vertexShader: LINE_VS, fragmentShader: LINE_FS,
      transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide, fog: false });
  }
  // acc: { pos, other, side, wpx, col, idx, n }; one quad per segment of xyz.
  function addLine(acc, xyz, colour, alpha, width) {
    var c = rgb(colour), w = Math.max(1, Math.min(10, +width || 2));
    for (var i = 0; i + 5 < xyz.length; i += 3) {
      var ax = xyz[i], ay = xyz[i + 1], az = xyz[i + 2], bx = xyz[i + 3], by = xyz[i + 4], bz = xyz[i + 5], v = acc.n;
      acc.pos.push(ax, ay, az, ax, ay, az, bx, by, bz, bx, by, bz);
      acc.other.push(bx, by, bz, bx, by, bz, ax, ay, az, ax, ay, az);
      acc.side.push(1, -1, -1, 1);
      for (var k = 0; k < 4; k++) { acc.wpx.push(w); acc.col.push(c[0], c[1], c[2], alpha); }
      acc.idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      acc.n += 4;
    }
  }
  function lineMesh(acc) {
    var T = S.THREE, g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(acc.pos, 3));
    g.setAttribute('other', new T.Float32BufferAttribute(acc.other, 3));
    g.setAttribute('side', new T.Float32BufferAttribute(acc.side, 1));
    g.setAttribute('wpx', new T.Float32BufferAttribute(acc.wpx, 1));
    g.setAttribute('col', new T.Float32BufferAttribute(acc.col, 4));
    g.setIndex(acc.idx);
    g.computeBoundingSphere();
    var m = new T.Mesh(g, S.lineMat);
    m.renderOrder = 3.2; m.name = 'features-lines'; m.frustumCulled = false; m.matrixAutoUpdate = false;
    return m;
  }
  function fillMesh(pos, col, idx) {
    var T = S.THREE, g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeBoundingSphere();
    var m = new T.Mesh(g, pulled(new T.MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide, fog: false }), PULL_LINE));
    m.renderOrder = 3.1; m.name = 'features-fill'; m.matrixAutoUpdate = false;
    return m;
  }

  function fixedScale(px) {
    var h = (S.renderer && S.renderer.domElement && S.renderer.domElement.clientHeight) || (root.innerHeight || 800);
    return 2 * Math.tan(S.camera.fov * Math.PI / 360) * px / h;
  }
  function resize() {
    if (!S) return;
    var el = S.renderer && S.renderer.domElement;
    S.res.value.set((el && el.clientWidth) || root.innerWidth || 1200, (el && el.clientHeight) || root.innerHeight || 800);
    var u = fixedScale(POINT_PX), l = fixedScale(LABEL_PX);
    S.recs.forEach(function (r) {
      if (r.sprite) r.sprite.scale.set(u, u, 1);
      if (r.label) r.label.scale.set(l * r.labelAspect, l, 1);
    });
  }

  // ── Building ────────────────────────────────────────────────────────────────
  function build() {
    var T = S.THREE;
    S.tree.list.forEach(function (f) {
      var grp = new T.Group(); grp.name = 'features-folder:' + f.id; grp.renderOrder = 3;
      var acc = { pos: [], other: [], side: [], wpx: [], col: [], idx: [], n: 0 }, fp = [], fc = [], fi = [];
      f.items.forEach(function (it) {
        var op = Math.max(0.1, Math.min(1, it.opacity == null ? 1 : +it.opacity)), colour = hex(it.colour);
        var rec = { item: it, folder: f, sprite: null, label: null, labelAspect: 1, at: null, xyz: null, length: 0, area: 0 };
        if (it.kind === 'point') {
          rec.at = pointPos(it);
          var sp = new T.Sprite(new T.SpriteMaterial({ map: symbolTexture(SYMBOLS.indexOf(it.symbol) >= 0 ? it.symbol : 'dot', colour),
            depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, opacity: op, fog: false }));
          pulled(sp.material, PULL_POINT);
          sp.position.copy(rec.at); sp.renderOrder = 3.4; sp.userData.featureId = it.id;
          grp.add(sp); rec.sprite = sp;
        } else {
          var closed = it.kind === 'area', d = drape(it, closed);
          rec.xyz = d.xyz; rec.length = d.length;
          addLine(acc, d.xyz, colour, op, it.width);
          var mid = Math.floor(d.xyz.length / 6) * 3;
          rec.at = new T.Vector3(d.xyz[mid], d.xyz[mid + 1], d.xyz[mid + 2]);
          if (closed) {
            var ring = d.corners.slice(0, -1), a2 = 0, cx = 0, cy = 0;
            for (var i = 0; i < ring.length; i++) { var p = ring[i], q = ring[(i + 1) % ring.length], w = p.x * q.y - q.x * p.y; a2 += w; cx += (p.x + q.x) * w; cy += (p.y + q.y) * w; }
            rec.area = Math.abs(a2) / 2;
            if (ring.length >= 3 && ring.length <= FILL_MAX_RING && Math.abs(a2) > 1e-6) {
              var tris = [];
              try { tris = T.ShapeUtils.triangulateShape(ring.map(function (p) { return new T.Vector2(p.x, p.y); }), []); } catch (e) { tris = []; }
              var base = fp.length / 3, c3 = rgb(colour);
              ring.forEach(function (p) { var z = S.groundZ(p.x, p.y); fp.push(p.x, p.y, (z != null && isFinite(z) ? z : rec.at.z - LIFT) + LIFT * 0.6); fc.push(c3[0], c3[1], c3[2], FILL_ALPHA * op); });
              tris.forEach(function (t) { fi.push(base + t[0], base + t[1], base + t[2]); });
              var gx = cx / (3 * a2), gy = cy / (3 * a2), gz = S.groundZ(gx, gy);
              if (isFinite(gx) && isFinite(gy)) rec.at = new T.Vector3(gx, gy, (gz != null && isFinite(gz) ? gz : rec.at.z - LIFT) + LIFT);
            }
          }
        }
        S.recs.push(rec); S.byId[it.id] = rec;
      });
      if (fi.length) grp.add(fillMesh(fp, fc, fi));
      if (acc.n) grp.add(lineMesh(acc));
      S.groups[f.id] = grp;
      S.scene.add(grp);
    });
    S.labelGroup = new T.Group(); S.labelGroup.name = 'features-labels'; S.labelGroup.renderOrder = 3.5;
    S.scene.add(S.labelGroup);
    apply();
  }

  function folderShown(id) {
    if (!S.st.all) return false;
    var g = S.tree.byId[id], seen = 0;
    while (g && seen++ < 64) { if (S.st.off[g.id]) return false; if (!g.parent) break; g = S.tree.byId[g.parent]; }
    return true;
  }
  // Is the terrain in front of this place, seen from the camera? Only asked with "Show through hills" off. The
  // heights of the ground along the line of sight (the viewer's height grid: no ray against the mesh), up to the
  // place taken `pull` nearer, as it is drawn.
  function behindHill(at, pull) {
    if (!S || S.st.through) return false;
    var c = S.camera.position, dx = at.x - c.x, dy = at.y - c.y, dz = at.z - c.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(d > 1)) return false;
    var reach = 1 - Math.min(pull[0] + pull[1] * d, d * 0.5) / d, n = Math.max(8, Math.min(96, Math.ceil(d * reach / 6)));
    for (var i = 1; i < n; i++) {
      var u = reach * i / n, g = S.groundZ(c.x + dx * u, c.y + dy * u);
      if (g != null && isFinite(g) && g > c.z + dz * u + 0.3) return true;
    }
    return false;
  }
  function applyThrough() {
    var test = !S.st.through;
    S.lineMat.depthTest = test;
    S.recs.forEach(function (r) { if (r.sprite) r.sprite.material.depthTest = test; });
    Object.keys(S.groups).forEach(function (k) { S.groups[k].children.forEach(function (c) { if (c.name === 'features-fill') c.material.depthTest = test; }); });
  }
  function apply() {
    applyThrough();
    S.tree.list.forEach(function (f) { if (S.groups[f.id]) S.groups[f.id].visible = folderShown(f.id); });
    labels();
    redraw();
  }
  function redraw() { if (S && S.redraw) S.redraw(); }

  // ── Names: the nearest that fit, worked out when the view rests ─────────────
  function labels() {
    if (!S || !S.labelGroup) return;
    var T = S.THREE, cam = S.camera, el = S.renderer && S.renderer.domElement;
    var W = (el && el.clientWidth) || root.innerWidth || 1200, H = (el && el.clientHeight) || root.innerHeight || 800;
    S.recs.forEach(function (r) { if (r.label) r.label.visible = false; });
    S.labelGroup.visible = S.st.all && S.st.labels;
    if (!S.labelGroup.visible) return;
    if (cam.updateMatrixWorld) cam.updateMatrixWorld();
    var v = new T.Vector3(), cands = [];
    S.recs.forEach(function (r) {
      if (!r.item.name || r.item.label === false || !folderShown(r.folder.id)) return;
      v.copy(r.at).project(cam);
      if (!(v.z > -1 && v.z < 1) || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return;
      if (behindHill(r.at, r.item.kind === 'point' ? PULL_POINT : PULL_LINE)) return;      // a name is whole or not there
      cands.push({ r: r, x: (v.x + 1) * W / 2, y: (1 - v.y) * H / 2, z: v.z + (r.item.kind === 'point' ? 0 : 0.0005) });   // points before lines at the same distance
    });
    cands.sort(function (a, b) { return a.z - b.z; });
    var boxes = [], shown = 0, lh = LABEL_PX, l = fixedScale(LABEL_PX);
    for (var i = 0; i < cands.length && shown < LABEL_CAP; i++) {
      var c = cands[i], r = c.r;
      if (!r.label) {
        var made = S.textSprite(shortName(r.item.name), labelColour(r.item.colour));
        r.label = made.sprite; r.labelAspect = made.aspect;
        r.label.material.sizeAttenuation = false; r.label.material.depthTest = false;
        r.label.center.set(0.5, r.item.kind === 'point' ? 1.75 : 0.5);      // under a point's symbol; on a line
        r.label.position.copy(r.at); r.label.renderOrder = 3.5; r.label.userData.featureId = r.item.id;
        r.label.scale.set(l * r.labelAspect, l, 1);
        S.labelGroup.add(r.label);
      }
      var w = lh * r.labelAspect, top = c.y + (r.item.kind === 'point' ? lh * 0.75 : -lh / 2);
      var box = [c.x - w / 2 - 2, top - 2, c.x + w / 2 + 2, top + lh + 2], hit = false;
      for (var k = 0; k < boxes.length; k++) { var o = boxes[k]; if (box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1]) { hit = true; break; } }
      if (hit) continue;
      boxes.push(box); r.label.visible = true; shown++;
    }
    S.labelsShown = shown;
  }
  var _lt = null;
  function labelsSoon() { if (!S) return; clearTimeout(_lt); _lt = setTimeout(function () { if (S) { labels(); redraw(); } }, 180); }

  // ── A tap: the nearest shown item, in screen pixels ─────────────────────────
  function pick(px, py, rect) {
    if (!S || !S.st.all) return null;
    var T = S.THREE, cam = S.camera, W = rect.width, H = rect.height, v = new T.Vector3(), best = null, bd = HIT_POINT_PX;
    function scr(x, y, z) { v.set(x, y, z).project(cam); return v.z > 1 || v.z < -1 ? null : [(v.x + 1) * W / 2, (1 - v.y) * H / 2]; }
    S.recs.forEach(function (r) {
      if (!r.sprite || !folderShown(r.folder.id)) return;
      var s = scr(r.at.x, r.at.y, r.at.z); if (!s) return;
      var d = Math.hypot(s[0] - px, s[1] - py);
      if (d < bd && !behindHill(r.at, PULL_POINT)) { bd = d; best = r; }
    });
    if (best) return { id: best.item.id, d: bd, item: best.item };
    bd = HIT_LINE_PX;
    S.recs.forEach(function (r) {
      if (!r.xyz || !folderShown(r.folder.id)) return;
      var a = scr(r.xyz[0], r.xyz[1], r.xyz[2]);
      for (var i = 3; i + 2 < r.xyz.length; i += 3) {
        var b = scr(r.xyz[i], r.xyz[i + 1], r.xyz[i + 2]);
        if (a && b) {
          var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2)) : 0;
          var d = Math.hypot(a[0] + dx * t - px, a[1] + dy * t - py);
          if (d < bd && !behindHill({ x: r.xyz[i - 3], y: r.xyz[i - 2], z: r.xyz[i - 1] }, PULL_LINE)) { bd = d; best = r; }
        }
        a = b;
      }
    });
    return best ? { id: best.item.id, d: bd, item: best.item } : null;
  }
  function escHtml(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // What the card says: [title, subtitle, rows]; values are HTML-safe.
  function info(id) {
    var r = S && S.byId[id]; if (!r) return null;
    var it = r.item, rows = [['Folder', escHtml(r.folder.id ? r.folder.path : 'No folder')]];
    if (it.note) rows.push(['Note', escHtml(it.note).replace(/\n/g, '<br>')]);
    if (it.kind === 'point') rows.push(['Position', (+it.lonlat[0][1]).toFixed(5) + ', ' + (+it.lonlat[0][0]).toFixed(5)]);
    else if (it.kind === 'line') rows.push(['Length', S.fmtLen ? S.fmtLen(r.length) : Math.round(r.length) + ' m']);
    else { rows.push(['Outline', S.fmtLen ? S.fmtLen(r.length) : Math.round(r.length) + ' m']); rows.push(['Area', r.area >= 10000 ? (r.area / 10000).toFixed(2) + ' ha' : Math.round(r.area) + ' m²']); }
    var kind = it.kind === 'point' ? 'Point' : it.kind === 'line' ? 'Line' : 'Area';
    return [it.name || kind, kind + ' · from the project (view only)', rows];
  }
  function open(id, fly) {
    var c = info(id); if (!c) return false;
    if (S.showInfo) S.showInfo(c[0], c[1], c[2], S.byId[id].at);        // its place: the card's "From you" row (libs/from-you.js)
    if (fly && S.flyTo) S.flyTo(S.byId[id].at.clone());
    return true;
  }

  var V = {
    SYMBOLS: SYMBOLS, tree: tree, restore: restore, labelColour: labelColour, shortName: shortName, symbolCanvas: symbolCanvas,

    // o: { THREE, scene, camera, renderer, controls, features, saved, toScene(lat, lon) -> {x, y}, groundZ(x, y) -> z|null,
    //      textSprite(text, colour) -> { sprite, aspect }, showInfo(title, subtitle, rows, at), flyTo(Vector3), fmtLen(m), redraw() }
    // Returns a promise: true when there are features and they are in the scene.
    init: function (o) {
      S = null;
      var F = o && o.features;
      if (!F) return Promise.resolve(false);
      var got = typeof F === 'string' ? fetch(F).then(function (r) { if (!r.ok) throw new Error('features: HTTP ' + r.status); return r.json(); }) : Promise.resolve(F);
      return got.then(function (data) {
        if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !data.items.length) return false;
        var T = o.THREE;
        S = { THREE: T, scene: o.scene, camera: o.camera, renderer: o.renderer, toScene: o.toScene, groundZ: o.groundZ, textSprite: o.textSprite,
              showInfo: o.showInfo, flyTo: o.flyTo, fmtLen: o.fmtLen, redraw: o.redraw, st: restore(o.saved), data: data, tree: tree(data),
              groups: {}, recs: [], byId: {}, tex: {}, res: { value: new T.Vector2(1200, 800) }, labelGroup: null, labelsShown: 0, open: {}, listOpen: false };
        S.lineMat = lineMaterial();
        var t0 = Date.now();
        build(); resize();
        S.buildMs = Date.now() - t0;
        if (o.controls && o.controls.addEventListener) { o.controls.addEventListener('end', labelsSoon); o.controls.addEventListener('change', labelsSoon); }
        if (root.addEventListener) root.addEventListener('resize', function () { resize(); labelsSoon(); });
        labels(); redraw();
        return true;
      }).catch(function (e) { console.warn('Surface features not loaded:', e); S = null; return false; });
    },
    active: function () { return !!S; },
    count: function () { return S ? S.recs.length : 0; },
    folders: function () { return S ? S.tree.list.map(function (f) { return { id: f.id, name: f.name, parent: f.parent, depth: f.depth, path: f.path, items: f.items.length, total: f.total, on: !S.st.off[f.id], shown: folderShown(f.id) }; }) : []; },
    state: function () { return S ? { all: S.st.all, labels: S.st.labels, through: S.st.through, off: Object.keys(S.st.off) } : null; },
    serialize: function () { return S ? { all: S.st.all, labels: S.st.labels, through: S.st.through, off: Object.keys(S.st.off) } : undefined; },
    // "Show through hills": on = drawn whatever is in front (as saved pins are); off = hidden where terrain is in front.
    setThrough: function (on) { if (S) { S.st.through = !!on; apply(); } },
    hiddenByHill: function (id) { var r = S && S.byId[id]; return !!r && behindHill(r.at, r.item.kind === 'point' ? PULL_POINT : PULL_LINE); },
    objects: function () { return S ? { groups: S.groups, labels: S.labelGroup, recs: S.recs, lineMat: S.lineMat, labelsShown: S.labelsShown, buildMs: S.buildMs } : null; },
    setAll: function (on) { if (S) { S.st.all = !!on; apply(); } },
    setLabels: function (on) { if (S) { S.st.labels = !!on; apply(); } },
    setFolder: function (id, on) { if (S && S.tree.byId[id]) { if (on) delete S.st.off[id]; else S.st.off[id] = true; apply(); } },
    relabel: function () { if (S) { labels(); redraw(); } },
    resize: resize,
    pick: pick, info: info, open: open,

    // The rows in Display. ui: { el, sheet, head, chips, close } (the viewer's own builders).
    // Folders, each with its switch and its number of items; tap a folder's name to list its items, an item to go to it.
    sheet: function (ui) {
      if (!S) return;
      ui.head('Surface features');
      ui.chips([['📌', 'All (' + S.recs.length + ')', S.st.all, function (on) { V.setAll(on); paint(); }],
                ['🏷', 'Names', S.st.labels, function (on) { V.setLabels(on); }],
                ['\u26F0', 'Show through hills', S.st.through, function (on) { V.setThrough(on); }]]);
      var box = ui.el('div', 'vf-list'); box.id = 'vf-list';
      ui.sheet.appendChild(box);
      function paint() {
        box.textContent = '';
        if (S.tree.list.length > FOLDERS_OPEN_MAX) {          // many folders: the list waits behind one row
          var top = ui.el('div', 'sh-row vf-folders'); top.appendChild(ui.el('span', 'sh-i', S.listOpen ? '\u25BE' : '\u25B8'));
          top.appendChild(ui.el('span', 'sh-t', 'Folders (' + S.tree.list.length + ')'));
          top.addEventListener('click', function () { S.listOpen = !S.listOpen; paint(); });
          box.appendChild(top);
          if (!S.listOpen) return;
        }
        S.tree.list.forEach(function (f) {
          var row = ui.el('div', 'sh-row vf-folder'); row.style.paddingLeft = (10 + f.depth * 16) + 'px'; row.dataset.folder = f.id;
          row.style.opacity = folderShown(f.id) ? '1' : '0.45';
          row.appendChild(ui.el('span', 'sh-i', S.open[f.id] ? '▾' : '▸'));
          var t = ui.el('span', 'sh-t', f.name);
          t.appendChild(ui.el('div', 'sh-s', f.total + (f.total === 1 ? ' item' : ' items') + (f.total !== f.items.length ? ' · ' + f.items.length + ' here' : '')));
          row.appendChild(t);
          var sw = ui.el('button', 'sh-chip vf-sw' + (!S.st.off[f.id] ? ' a' : ''), !S.st.off[f.id] ? 'On' : 'Off');
          sw.style.cssText = 'flex:0 0 auto;min-width:52px;justify-content:center;margin-left:8px;';
          sw.title = 'Show or hide this folder';
          sw.addEventListener('click', function (e) { e.stopPropagation(); V.setFolder(f.id, !!S.st.off[f.id]); paint(); });
          row.appendChild(sw);
          row.addEventListener('click', function () { S.open[f.id] = !S.open[f.id]; paint(); });
          box.appendChild(row);
          if (!S.open[f.id]) return;
          f.items.forEach(function (it) {
            var ir = ui.el('div', 'sh-row vf-item'); ir.style.paddingLeft = (30 + f.depth * 16) + 'px'; ir.dataset.item = it.id;
            var ic = ui.el('span', 'sh-i', it.kind === 'point' ? '●' : it.kind === 'line' ? '╱' : '▰'); ic.style.color = hex(it.colour);
            ir.appendChild(ic);
            var tt = ui.el('span', 'sh-t', it.name || (it.kind === 'point' ? 'Point' : it.kind === 'line' ? 'Line' : 'Area'));
            tt.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            ir.appendChild(tt);
            ir.addEventListener('click', function () { if (ui.close) ui.close(); open(it.id, true); });
            box.appendChild(ir);
          });
        });
      }
      paint();
    },
  };

  root.ViewerFeatures = V;
  if (typeof module !== 'undefined' && module.exports) module.exports = V;
})(typeof window !== 'undefined' ? window : globalThis);
