// How the map is moved in the portable viewer / FLEX Field (window.GroundDrag): a choice of three in ⋯ More → Touch.
//
//   'orbit'  (the default) nothing here runs and OrbitControls behaves as always.
//   'ground' "Orbit on the ground": OrbitControls' own gestures, but the orbit centre always sits on the ground. The
//            viewer calls snap() once per drawn frame, right after controls.update() and its orbit clamp: the centre's
//            height becomes the ground's at its x, y (the height grid, never a ray cast) and the camera moves up or
//            down by the same amount, so distance, tilt and bearing stay. Off the map (no ground) the height is kept.
//            A camera that was above the ground is not carried into it by a move of the centre (CAM_MARGIN above
//            it); one the user orbited under the ground is left there. Two fingers pan along the ground
//            (OrbitControls' screenSpacePanning off while this is chosen; put back after). Orbiting and zooming do
//            not move the centre's x, y, so the snap changes nothing then. Fly-to and focus moves are snapped at
//            every step, so they end over their place with no jump; following keeps the centre on the ground at the
//            fix. Leaving fly mode, aim() puts the centre where the view meets the ground, the camera untouched.
//   'drag'   "Drag the ground", touch that works as in a map app:
//
// In 'drag', OrbitControls' own rotate / pan /
// zoom are switched off (its flags, nothing in the vendored file) and this file moves the camera AND the orbit
// centre together, so everything that reads controls.target (focus, follow, the orbit clamp) keeps working:
//   one finger            the spot of ground under the finger stays under it
//   pinch                 zooms toward the spot of ground between the fingers
//   twist                 turns the map about that spot (after a small dead zone, so a pinch does not turn it)
//   two fingers up / down tilts about that spot
//   mouse                 left drag = drag the ground, wheel = zoom to the cursor, right drag (or Ctrl / Shift +
//                         left drag) = orbit about the spot under the cursor
// The grabbed spot is found ONCE per gesture by marching the touch ray over the height grid (never a ray cast of
// the mesh); the drag then happens on the horizontal plane through it. Where the ray meets no ground (sky, off
// the map) the plane goes through the orbit centre instead. While following the GPS fix the fix stays in the
// middle: a one-finger drag does nothing, and pinch / twist / tilt go about the fix.
// No inertia and nothing animated: a gesture moves the view only while the fingers move.
//
//   GroundDrag.init({ camera, controls, dom, groundZ(x, y), bounds() -> {minX, minY, maxX, maxY, cell} | null,
//                     saved (the mode), savedOld (the switch of before: true = 'drag'), save(mode), wake(),
//                     following() -> bool, headingLocked() -> bool })
//   GroundDrag.mode() / setMode('orbit' | 'ground' | 'drag')    the choice; on() / setOn(bool) = 'drag' or not
//   GroundDrag.sheet({ head, seg, sheet, rerender })            the choice in ⋯ More
//   GroundDrag.snap() / aim()                                   'ground' only: see above (both return true if they moved)
//   GroundDrag.math                                             the pure half (tools/test_ground_drag.js)
(function (root) {
  'use strict';

  // ── Pure maths: points are [x, y, z], z up; a pose is { p: camera, t: orbit centre } ─────────────────────────
  var sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
  var add = function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; };
  var mul = function (a, k) { return [a[0] * k, a[1] * k, a[2] * k]; };
  var dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
  var cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
  var len = function (a) { return Math.sqrt(dot(a, a)); };
  var norm = function (a) { var l = len(a); return l > 0 ? mul(a, 1 / l) : [0, 0, 0]; };

  // The camera's axes when it looks from p at t with z up (the same rule as three.js lookAt).
  function basis(pose) {
    var f = norm(sub(pose.t, pose.p));
    var r = cross(f, [0, 0, 1]);
    if (len(r) < 1e-12) r = [1, 0, 0];          // straight down: any horizontal axis
    r = norm(r);
    return { f: f, r: r, u: cross(r, f) };
  }
  // The view ray through a point of the screen: nx, ny in -1..1 (y up), fov = vertical field of view in degrees.
  function rayDir(pose, fov, aspect, nx, ny) {
    var b = basis(pose), h = Math.tan(fov * Math.PI / 360);
    return norm(add(b.f, add(mul(b.r, nx * h * aspect), mul(b.u, ny * h))));
  }
  // Where a ray meets a plane (a point and a normal): the distance along it, or null (parallel, behind, past maxT).
  function planeHit(o, d, point, normal, maxT) {
    var dn = dot(d, normal);
    if (Math.abs(dn) < 1e-6) return null;
    var t = dot(sub(point, o), normal) / dn;
    if (!(t > 0) || (maxT && t > maxT)) return null;
    return t;
  }
  // Where a ray first meets the ground: zAt(x, y) is the height grid's sampler (null off the map), box its extent
  // and cell size. One walk along the ray in steps of about a cell, then a bisection. Returns the distance or null.
  function marchRay(o, d, zAt, box, maxT, maxSteps) {
    var t0 = 0, t1 = maxT || 1e5, i;
    var lo = [box.minX, box.minY], hi = [box.maxX, box.maxY];
    for (i = 0; i < 2; i++) {                                    // the stretch of the ray over the map
      if (Math.abs(d[i]) < 1e-12) { if (o[i] < lo[i] || o[i] > hi[i]) return null; continue; }
      var a = (lo[i] - o[i]) / d[i], b = (hi[i] - o[i]) / d[i];
      if (a > b) { var s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    }
    if (!(t1 > t0)) return null;
    var n = Math.min(maxSteps || 1500, Math.max(8, Math.ceil((t1 - t0) / Math.max(box.cell || 1, 1e-3))));
    var step = (t1 - t0) / n;
    var f = function (t) { var z = zAt(o[0] + d[0] * t, o[1] + d[1] * t); return z === null || z === undefined || isNaN(z) ? null : o[2] + d[2] * t - z; };
    var pt = t0, pf = f(t0);
    for (i = 1; i <= n; i++) {
      var t = t0 + step * i, ft = f(t);
      if (ft !== null && pf !== null && (ft === 0 || (pf > 0) !== (ft > 0))) {
        var ta = pt, tb = t, fa = pf;
        for (var k = 0; k < 24; k++) {
          var tm = (ta + tb) / 2, fm = f(tm);
          if (fm === null) break;
          if ((fm > 0) === (fa > 0)) { ta = tm; fa = fm; } else tb = tm;
        }
        return (ta + tb) / 2;
      }
      pt = t; pf = ft;
    }
    return null;
  }

  function translate(pose, d) { return { p: add(pose.p, d), t: add(pose.t, d) }; }
  function rotPoint(q, pivot, axis, ang) {                        // Rodrigues, axis of length 1
    var v = sub(q, pivot), c = Math.cos(ang), s = Math.sin(ang);
    return add(pivot, add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v) * (1 - c))));
  }
  // Turn the view about the vertical line through pivot (positive = anticlockwise seen from above).
  function turn(pose, pivot, ang) {
    return { p: rotPoint(pose.p, pivot, [0, 0, 1], ang), t: rotPoint(pose.t, pivot, [0, 0, 1], ang) };
  }
  var polar = function (pose) { var o = sub(pose.p, pose.t), l = len(o); return l > 0 ? Math.acos(Math.max(-1, Math.min(1, o[2] / l))) : 0; };
  // Tilt about the horizontal line through pivot that lies across the view: ang > 0 lowers the camera (more
  // oblique). The angle from straight down is held inside [lo, hi].
  function tilt(pose, pivot, ang, lo, hi) {
    var ph = polar(pose), want = Math.max(lo, Math.min(hi, ph + ang)), da = want - ph;
    if (ph < lo || ph > hi) da = ang * (ph < lo ? 1 : -1) > 0 ? ang : 0;      // already outside: only back toward the range
    if (!da) return pose;
    var r = basis(pose).r;
    return { p: rotPoint(pose.p, pivot, r, da), t: rotPoint(pose.t, pivot, r, da) };
  }
  // Scale the view about pivot (k < 1 = closer); the camera-to-centre distance is held inside [minD, maxD].
  function zoom(pose, pivot, k, minD, maxD) {
    var d = len(sub(pose.p, pose.t));
    if (d > 0) {
      if (d * k < minD) k = Math.min(1, minD / d);
      if (d * k > maxD) k = Math.max(1, maxD / d);
    }
    return { p: add(pivot, mul(sub(pose.p, pivot), k)), t: add(pivot, mul(sub(pose.t, pivot), k)) };
  }
  // The move that puts the grabbed point g back under a screen point: the ray through that point is met with the
  // plane through g, and the view shifts by the difference. null = that ray does not reach the plane.
  function panTo(pose, dir, g, normal, maxT) {
    var t = planeHit(pose.p, dir, g, normal, maxT);
    return t === null ? null : sub(g, add(pose.p, mul(dir, t)));
  }

  // Two fingers. start(a, b) with screen points [x, y] (pixels, y down); step(state, a, b) returns what to do since
  // the last step: { mode: null | 'tilt' | 'zoom', k (distance factor, < 1 = closer), twist (radians, clockwise on
  // screen positive), dy (pixels the pair moved down), mid }. The gesture is one or the other for its whole life:
  // both fingers moving up or down together, the gap between them steady = tilt; anything else = zoom / turn / move.
  var DECIDE_PX = 10, TWIST_DEAD = 0.12, TWIST_MIN_SEP = 30;
  var sep2 = function (a, b) { return Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])); };
  var ang2 = function (a, b) { return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  var wrap = function (x) { while (x > Math.PI) x -= 2 * Math.PI; while (x < -Math.PI) x += 2 * Math.PI; return x; };
  function twoStart(a, b) {
    return { a0: a.slice(), b0: b.slice(), pa: a.slice(), pb: b.slice(), mode: null, twistAcc: 0, turning: false };
  }
  function twoStep(st, a, b) {
    var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!st.mode) {
      var da = [a[0] - st.a0[0], a[1] - st.a0[1]], db = [b[0] - st.b0[0], b[1] - st.b0[1]];
      if (Math.max(sep2([0, 0], da), sep2([0, 0], db)) < DECIDE_PX) return { mode: null, k: 1, twist: 0, dy: 0, mid: mid };
      var together = da[1] * db[1] > 0 && Math.abs(da[1]) >= 6 && Math.abs(db[1]) >= 6 &&
        Math.abs(da[0]) <= 0.7 * Math.abs(da[1]) && Math.abs(db[0]) <= 0.7 * Math.abs(db[1]) &&
        Math.abs(sep2(a, b) - sep2(st.a0, st.b0)) < 0.5 * Math.min(Math.abs(da[1]), Math.abs(db[1])) + 4;
      st.mode = together ? 'tilt' : 'zoom';
    }
    var out = { mode: st.mode, k: 1, twist: 0, dy: 0, mid: mid };
    if (st.mode === 'tilt') {
      out.dy = mid[1] - (st.pa[1] + st.pb[1]) / 2;
    } else {
      var s0 = sep2(st.pa, st.pb), s1 = sep2(a, b);
      if (s0 > 1 && s1 > 1) out.k = s0 / s1;
      if (s0 >= TWIST_MIN_SEP && s1 >= TWIST_MIN_SEP) {
        var dth = wrap(ang2(a, b) - ang2(st.pa, st.pb));
        if (st.turning) out.twist = dth;
        else { st.twistAcc += dth; if (Math.abs(st.twistAcc) > TWIST_DEAD) st.turning = true; }
      }
    }
    st.pa = a.slice(); st.pb = b.slice();
    return out;
  }

  // The choice. What was saved wins; a viewer of before saved only a switch (true = drag the ground).
  var MODES = ['orbit', 'ground', 'drag'];
  function modeFrom(saved, savedOld) {
    if (MODES.indexOf(saved) >= 0) return saved;
    return savedOld === true ? 'drag' : 'orbit';
  }
  // "Orbit on the ground", one drawn frame. The orbit centre goes to the ground's height at its x, y and the camera
  // with it by the same amount (a rigid move: the camera-to-centre offset is untouched). No ground there (off the
  // map): nothing moves. st remembers between frames { x, y: where the centre was, above: the camera was at least
  // `margin` above the ground under it }. When the centre moved and the camera was above the ground, it stays above
  // (lifted to ground + margin); a camera already under the ground is left alone. Returns the same pose object when
  // nothing changes, so a still or orbiting view costs two reads of the height grid and no writes.
  var zOr = function (zAt, x, y) { var z = zAt(x, y); return z === null || z === undefined || isNaN(z) ? null : z; };
  function groundSnap(pose, zAt, st, margin) {
    var t = pose.t, p = pose.p, out = pose;
    var gz = zOr(zAt, t[0], t[1]);
    var dz = gz === null ? 0 : gz - t[2];
    if (Math.abs(dz) < 1e-7) dz = 0;
    var moved = dz !== 0 || st.x !== t[0] || st.y !== t[1];
    var pz = p[2] + dz;
    if (dz) out = { p: [p[0], p[1], pz], t: [t[0], t[1], gz], dz: dz };
    var gc = zOr(zAt, p[0], p[1]);
    if (gc !== null) {
      if (moved && st.above && pz < gc + margin) {
        pz = gc + margin;
        out = { p: [p[0], p[1], pz], t: out.t, dz: dz, lifted: true };
      }
      st.above = pz >= gc + margin - 1e-7;
    }
    st.x = t[0]; st.y = t[1];
    return out;
  }

  var math = { modeFrom: modeFrom, MODES: MODES, groundSnap: groundSnap, basis: basis, rayDir: rayDir, planeHit: planeHit, marchRay: marchRay, translate: translate, turn: turn, tilt: tilt,
    polar: polar, zoom: zoom, panTo: panTo, twoStart: twoStart, twoStep: twoStep, TWIST_DEAD: TWIST_DEAD, DECIDE_PX: DECIDE_PX };

  // ── The viewer side ──────────────────────────────────────────────────────────────────────────────────────────
  var O = null, mode = 'orbit', kept = null, keptSSP = null, snapSt = {};
  var CAM_MARGIN = 2;                            // metres a camera carried by the centre stays above the ground
  var g = null;            // the gesture: { kind: 'drag' | 'two' | 'orbit', pivot, normal, maxT, two, last }
  var TILT_PER_SCREEN = Math.PI / 2 / 0.6;       // two fingers over 60 % of the screen's height = a right angle
  var WHEEL_K = 0.95;                            // one wheel notch, as OrbitControls

  var getPose = function () {
    var c = O.camera.position, t = O.controls.target;
    return { p: [c.x, c.y, c.z], t: [t.x, t.y, t.z] };
  };
  function setPose(q) {
    O.camera.position.set(q.p[0], q.p[1], q.p[2]);
    O.controls.target.set(q.t[0], q.t[1], q.t[2]);
    O.controls.update();                         // looks at the centre, applies its limits, fires 'change'
    if (O.wake) O.wake();
  }
  function dirAt(pose, x, y) {
    var r = O.dom.getBoundingClientRect();
    return rayDir(pose, O.camera.fov, r.width / Math.max(1, r.height), (x - r.left) / r.width * 2 - 1, 1 - (y - r.top) / r.height * 2);
  }
  var active = function () { return mode === 'drag' && O && O.controls.enabled !== false; };
  var following = function () { return !!(O.following && O.following()); };
  var limits = function () {
    var c = O.controls;
    return { lo: Math.max(c.minPolarAngle || 0, 1e-4), hi: Math.min(c.maxPolarAngle, Math.PI - 1e-4), minD: c.minDistance, maxD: c.maxDistance };
  };
  // What is under a screen point: the ground from the height grid; else the horizontal plane through the orbit
  // centre; else (a level view of nothing) the plane facing the camera at the orbit centre's distance.
  function grab(x, y) {
    var pose = getPose(), d = dirAt(pose, x, y), dist = len(sub(pose.p, pose.t)), t = null, box = null;
    try { box = O.bounds && O.bounds(); } catch (_) {}
    if (box && O.groundZ) t = marchRay(pose.p, d, O.groundZ, box, O.camera.far || 60000);
    if (t !== null) return { pivot: add(pose.p, mul(d, t)), normal: [0, 0, 1], maxT: Math.max(8 * t, 200) };
    if (Math.abs(d[2]) > 0.1) {
      t = planeHit(pose.p, d, pose.t, [0, 0, 1], 6 * dist + 100);
      if (t !== null) return { pivot: add(pose.p, mul(d, t)), normal: [0, 0, 1], maxT: Math.max(8 * t, 200) };
    }
    var f = basis(pose).f;
    return { pivot: add(pose.p, mul(d, dist / Math.max(0.2, dot(d, f)))), normal: f, maxT: 0 };
  }
  function pivotFor(x, y) {
    if (following()) { var p = getPose(); return { pivot: p.t, normal: [0, 0, 1], maxT: 0, fixed: true }; }
    return grab(x, y);
  }
  // Put the gesture's spot back under a screen point (no move while following: the fix stays in the middle).
  function panUnder(pose, x, y) {
    if (g.fixed) return pose;
    var d = panTo(pose, dirAt(pose, x, y), g.pivot, g.normal, g.maxT);
    return d ? translate(pose, d) : pose;
  }

  // Touch
  function pts(e) {
    var out = [], l = e.targetTouches || e.touches || [];
    for (var i = 0; i < l.length; i++) out.push([l[i].clientX, l[i].clientY]);
    return out;
  }
  function touchBegin(e) {                       // on every finger down or up: the gesture starts again from here
    if (!active()) { g = null; return; }
    var p = pts(e);
    if (p.length === 1) {
      g = pivotFor(p[0][0], p[0][1]); g.kind = 'drag';
    } else if (p.length === 2) {
      g = pivotFor((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2); g.kind = 'two'; g.two = twoStart(p[0], p[1]);
    } else g = null;
  }
  function touchMove(e) {
    if (!active() || !g) return;
    var p = pts(e), pose = getPose();
    if (g.kind === 'drag' && p.length === 1) {
      setPose(panUnder(pose, p[0][0], p[0][1]));
    } else if (g.kind === 'two' && p.length === 2) {
      var s = twoStep(g.two, p[0], p[1]), L = limits();
      if (s.mode === 'tilt') {
        var h = Math.max(1, O.dom.getBoundingClientRect().height);
        setPose(tilt(pose, g.pivot, -s.dy / h * TILT_PER_SCREEN, L.lo, L.hi));
      } else if (s.mode === 'zoom') {
        pose = zoom(pose, g.pivot, s.k, L.minD, L.maxD);
        if (s.twist && !(O.headingLocked && O.headingLocked())) pose = turn(pose, g.pivot, s.twist);
        setPose(panUnder(pose, s.mid[0], s.mid[1]));
      }
    }
  }

  // Mouse and pen
  var isMouse = function (e) { return e.pointerType === 'mouse' || e.pointerType === 'pen'; };
  var fire = function (type) { try { O.controls.dispatchEvent({ type: type }); } catch (_) {} };
  function mouseDown(e) {
    if (!active() || !isMouse(e) || g) return;
    var orbit = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey));
    if (!orbit && e.button !== 0) return;
    g = orbit ? pivotFor(e.clientX, e.clientY) : (following() ? null : grab(e.clientX, e.clientY));
    if (!g) return;
    g.kind = orbit ? 'orbit' : 'drag'; g.mouse = true; g.last = [e.clientX, e.clientY];
    fire('start');
  }
  function mouseMove(e) {
    if (!g || !g.mouse || !isMouse(e)) return;
    if (!active()) { g = null; return; }
    var pose = getPose();
    if (g.kind === 'drag') setPose(panUnder(pose, e.clientX, e.clientY));
    else {
      var h = Math.max(1, O.dom.getBoundingClientRect().height), L = limits();
      var dx = e.clientX - g.last[0], dy = e.clientY - g.last[1];
      if (!(O.headingLocked && O.headingLocked())) pose = turn(pose, g.pivot, -2 * Math.PI * dx / h);
      setPose(tilt(pose, g.pivot, -2 * Math.PI * dy / h, L.lo, L.hi));
    }
    g.last = [e.clientX, e.clientY];
  }
  function mouseUp(e) {
    if (!g || !g.mouse || !isMouse(e)) return;
    g = null; fire('end');
  }
  function wheel(e) {
    if (!active()) return;
    e.preventDefault();
    if (!e.deltaY) return;
    var w = pivotFor(e.clientX, e.clientY), L = limits();
    fire('start');
    setPose(zoom(getPose(), w.pivot, e.deltaY < 0 ? WHEEL_K : 1 / WHEEL_K, L.minD, L.maxD));
    fire('end');
  }

  function apply() {
    var c = O.controls, drag = mode === 'drag', ground = mode === 'ground';
    if (drag && !kept) {
      kept = { r: c.enableRotate, p: c.enablePan, z: c.enableZoom };
      c.enableRotate = c.enablePan = c.enableZoom = false;
    } else if (!drag && kept) {
      c.enableRotate = kept.r; c.enablePan = kept.p; c.enableZoom = kept.z; kept = null;
    }
    if (ground && keptSSP === null) { keptSSP = c.screenSpacePanning; c.screenSpacePanning = false; }
    else if (!ground && keptSSP !== null) { c.screenSpacePanning = keptSSP; keptSSP = null; }
    g = null; snapSt = {};
  }
  function init(o) {
    O = o;
    var d = o.dom, doc = d.ownerDocument;
    d.addEventListener('touchstart', touchBegin, { passive: true });
    d.addEventListener('touchmove', touchMove, { passive: true });
    d.addEventListener('touchend', touchBegin, { passive: true });
    d.addEventListener('touchcancel', touchBegin, { passive: true });
    d.addEventListener('pointerdown', mouseDown);
    doc.addEventListener('pointermove', mouseMove);
    doc.addEventListener('pointerup', mouseUp);
    doc.addEventListener('pointercancel', mouseUp);
    d.addEventListener('wheel', wheel, { passive: false });
    mode = modeFrom(o.saved, o.savedOld);
    apply();
  }
  function setMode(m) {
    if (MODES.indexOf(m) < 0 || m === mode) return;
    mode = m;
    if (O) { apply(); if (O.save) O.save(mode); if (O.wake) O.wake(); }
  }
  function setOn(v) {
    v = !!v;
    if (v === (mode === 'drag')) return;
    setMode(v ? 'drag' : 'orbit');
  }

  // 'ground': once per drawn frame, after controls.update() (the viewer's render loop). Nothing here calls update():
  // a rigid move leaves the camera's aim as it is; after a lift the camera is aimed at the centre again here.
  function snap() {
    if (mode !== 'ground' || !O || !O.groundZ) return false;
    var pose = getPose(), q = groundSnap(pose, O.groundZ, snapSt, CAM_MARGIN);
    if (q === pose) return false;
    O.camera.position.z = q.p[2];
    O.controls.target.z = q.t[2];
    if (q.lifted) O.camera.lookAt(O.controls.target);
    return true;
  }
  // 'ground', leaving fly mode: the orbit centre goes where the middle of the view meets the ground, so the camera
  // stays where it was flown to and the view does not change. No ground in view: left to snap().
  function aim() {
    if (mode !== 'ground' || !O || !O.groundZ) return false;
    var pose = getPose(), d = norm(sub(pose.t, pose.p)), box = null, L = limits();
    try { box = O.bounds && O.bounds(); } catch (_) {}
    if (!box || !len(d)) return false;
    var t = marchRay(pose.p, d, O.groundZ, box, Math.min(O.camera.far || 60000, L.maxD));
    if (t === null || t < L.minD) return false;
    var q = add(pose.p, mul(d, t));
    O.controls.target.set(q[0], q[1], q[2]);
    snapSt = {};
    return true;
  }

  // The choice, in ⋯ More: three in a row, and a line that says what the chosen one does.
  var NAMES = { orbit: 'Orbit', ground: 'Orbit on the ground', drag: 'Drag the ground' };
  var HINTS = {
    orbit: 'One finger orbits about the centre of the view, two fingers move it, pinch zooms.',
    ground: 'The same gestures, but the centre you orbit about stays on the ground: two fingers slide the view over the terrain.',
    drag: 'As in a map app: one finger moves the map, pinch zooms to the spot between the fingers, a twist turns it, two fingers up or down tilt it.',
  };
  function sheet(ui) {
    ui.head('Touch');
    var seg = ui.seg(MODES.map(function (m) { return NAMES[m]; }), MODES.indexOf(mode), function (i) { setMode(MODES[i]); if (ui.rerender) ui.rerender(); });
    if (seg) {
      seg.id = 'touch-mode';
      for (var i = 0; i < seg.children.length; i++) { seg.children[i].title = HINTS[MODES[i]]; seg.children[i].style.lineHeight = '1.15'; }
      var doc = seg.ownerDocument, note = doc.createElement('div');
      note.id = 'touch-mode-hint'; note.textContent = HINTS[mode];
      note.style.cssText = 'font-size:11px;opacity:.55;margin:5px 2px 0;line-height:1.3';
      seg.parentNode.insertBefore(note, seg.nextSibling);
    }
  }

  var api = { init: init, on: function () { return mode === 'drag'; }, setOn: setOn, mode: function () { return mode; }, setMode: setMode,
    snap: snap, aim: aim, sheet: sheet, math: math,
    busy: function () { return g ? g.kind : null; } };
  root.GroundDrag = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
