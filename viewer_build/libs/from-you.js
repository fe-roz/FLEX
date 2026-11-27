// "From you": how far and which way a selected thing is from the GPS position (window.FromYou).
//
// A card (a ridgewalking feature, a surface feature of the project, a cave station) carries one row "From you" with the
// horizontal distance in the map's units and the compass bearing to the thing, e.g. "410 ft · NE 52°". The bearing is
// from true north: the scene is a UTM grid, so the grid bearing is turned by the map's grid convergence.
// Distance is measured in the scene (map metres) between the fix and the thing's place; heights play no part.
//
// The row is there only while the GPS has a fix. Nothing here runs on a timer or per frame: the viewer calls
// FromYou.update() when a fix arrives, when the GPS is switched off and when the units change, and every row on the
// page (any element with data-fy="x,y") is written again or hidden.
//
// Two halves: the sums without a DOM (Node-tested by tools/test_from_you.js) and the page.
(function (root) {
  'use strict';
  var POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var HERE_M = 0.5;                  // nearer than this there is no direction to speak of

  function norm(deg) { deg = deg % 360; return deg < 0 ? deg + 360 : deg; }
  // Bearing in degrees (0 = north, 90 = east) of a step dx east, dy north on the grid; `conv` is the grid convergence
  // (true bearing = grid bearing + conv), 0 when not given.
  function bearing(dx, dy, conv) { return norm(Math.atan2(dx, dy) * 180 / Math.PI + (isFinite(conv) ? +conv : 0)); }
  // "NE" for 52: the nearest of eight points.
  function point(deg) { return POINTS[Math.round(norm(deg) / 45) % 8]; }
  function ok(p) { return !!p && isFinite(p.x) && isFinite(p.y) && p.x !== null && p.y !== null; }
  // { d (m, horizontal), deg (0..360, whole), point } from `from` to `to` ({ x, y } in scene metres), or null.
  function measure(from, to, conv) {
    if (!ok(from) || !ok(to)) return null;
    var dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy);
    var deg = Math.round(bearing(dx, dy, conv)) % 360;
    return { d: d, deg: deg, point: point(deg) };
  }
  // "410 ft · NE 52°" (fmtLen: the viewer's own length formatter; metres when absent), or null with no fix / no place.
  function text(from, to, fmtLen, conv) {
    var m = measure(from, to, conv);
    if (!m) return null;
    var len = typeof fmtLen === 'function' ? fmtLen(m.d) : (m.d < 10 ? m.d.toFixed(1) : String(Math.round(m.d))) + ' m';
    return m.d < HERE_M ? len : len + ' · ' + m.point + ' ' + m.deg + '°';
  }

  /* ── the page ── */
  var S = null;      // { fix() -> { x, y } | null, fmtLen(m), conv() -> degrees }
  function now(x, y) {
    if (!S) return null;
    var f = null, c = 0;
    try { f = S.fix ? S.fix() : null; c = S.conv ? S.conv() : 0; } catch (_) { f = null; }
    return text(f, { x: +x, y: +y }, S.fmtLen, c);
  }
  function fill(el) {
    var p = String(el.getAttribute('data-fy') || '').split(','), t = p.length === 2 ? now(p[0], p[1]) : null;
    var val = el.querySelector ? el.querySelector('.fy-val') || el : el;
    val.textContent = t || '';
    el.style.display = t ? el.getAttribute('data-fy-show') || '' : 'none';
    return t;
  }

  var R = {
    POINTS: POINTS, HERE_M: HERE_M, bearing: bearing, point: point, measure: measure, text: text,

    // o: { fix() -> { x, y } | null (the GPS position in the scene, null with no fix or the GPS off), fmtLen(m),
    //      conv() -> the grid convergence in degrees }.
    init: function (o) { S = o && typeof o.fix === 'function' ? { fix: o.fix, fmtLen: o.fmtLen, conv: o.conv } : null; },
    active: function () { return !!S; },
    // The text for a place now, or null (no fix).
    now: now,
    // Make `el` a "From you" row for the place (x, y): written now, and again at every update(). The text goes into
    // its child with the class fy-val (or into el itself); `show` is the CSS display it takes while there is a fix.
    mark: function (el, x, y, show) {
      if (!el || !isFinite(x) || !isFinite(y)) return null;
      el.setAttribute('data-fy', (+x) + ',' + (+y));
      if (show) el.setAttribute('data-fy-show', show);
      return fill(el);
    },
    // The same as a piece of HTML for the info card's rows (viewer.html's .fx-row).
    rowHtml: function (x, y) {
      if (!isFinite(x) || !isFinite(y)) return '';
      var t = now(x, y);
      return '<div class="fx-row fy-row" data-fy="' + (+x) + ',' + (+y) + '"' + (t ? '' : ' style="display:none"') + '><span class="lbl">From you:</span> <span class="val fy-val">' +
        (t || '').replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) + '</span></div>';
    },
    // A new fix, the GPS off, or other units: every row on the page is written again (or hidden). Returns how many rows show.
    update: function (doc) {
      doc = doc || (typeof document !== 'undefined' ? document : null);
      if (!doc || !doc.querySelectorAll) return 0;
      var n = 0;
      Array.prototype.forEach.call(doc.querySelectorAll('[data-fy]'), function (el) { if (fill(el)) n++; });
      return n;
    },
  };
  root.FromYou = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
