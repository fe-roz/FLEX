// units.js — metric or imperial, a setting (Settings → Units), kept per computer.
//
// window._units (and module.exports under Node, for tools/test_route_stats.js):
//   system()          'metric' (default) | 'imperial'
//   set(system)       change it: saved in localStorage 'flex.units', fires 'flex-units-changed'
//   len(m)            a length: "850 m", "1.23 km"  |  "430 ft", "0.76 mi"
//   dist(m)           a distance between things (one decimal under 10 m / 30 ft)
//   height(m)         a height or depth, one decimal: "812.5 m"  |  "2665.4 ft"
//   climb(m)          metres climbed, whole: "120 m"  |  "394 ft"
//   area(m2)          "250 m²", "1.20 ha", "3.40 km²"  |  "2690 ft²", "2.97 ac", "1.31 mi²"
//   duration(s)       "2 h 15 min", "45 min", "40 s" (the same in both)
//   fmtLen, fmtDist, fmtHeight, fmtClimb, fmtArea, fmtDuration   the same, long names
// The Settings row (index.html #units-body, two radios) is wired here.
(function (root, factory) {
  const M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root._units = M.browser(root);
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const FT = 3.280839895, MI = 1609.344, MI2 = MI * MI, ACRE = 4046.8564224;
  /** The formatters for a system: sys() → 'metric' | 'imperial', read on every call. */
  function make(sys) {
    const imp = () => sys() === 'imperial';
    const len = m => {
      if (!Number.isFinite(m)) return '';
      if (imp()) return m >= MI / 2 ? (m / MI).toFixed(2) + ' mi' : Math.round(m * FT) + ' ft';
      return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
    };
    const dist = m => {
      if (!Number.isFinite(m)) return '';
      if (imp()) return m >= MI / 2 ? (m / MI).toFixed(2) + ' mi' : m * FT >= 30 ? Math.round(m * FT) + ' ft' : (m * FT).toFixed(1) + ' ft';
      return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m >= 10 ? Math.round(m) + ' m' : m.toFixed(1) + ' m';
    };
    const height = m => (Number.isFinite(m) ? (imp() ? (m * FT).toFixed(1) + ' ft' : m.toFixed(1) + ' m') : '');
    const climb = m => (Number.isFinite(m) ? (imp() ? Math.round(m * FT) + ' ft' : Math.round(m) + ' m') : '');
    const area = a => {
      if (!Number.isFinite(a)) return '';
      if (imp()) return a >= MI2 / 4 ? (a / MI2).toFixed(2) + ' mi²' : a >= ACRE ? (a / ACRE).toFixed(2) + ' ac' : Math.round(a * FT * FT) + ' ft²';
      return a >= 1e6 ? (a / 1e6).toFixed(2) + ' km²' : a >= 1e4 ? (a / 1e4).toFixed(2) + ' ha' : Math.round(a) + ' m²';
    };
    const duration = s => {
      if (!Number.isFinite(s) || s < 0) return '';
      if (s < 90) return Math.round(s) + ' s';
      const mins = Math.round(s / 60);
      if (mins < 60) return mins + ' min';
      const h = Math.floor(mins / 60), m = mins % 60;
      return h + ' h' + (m ? ' ' + m + ' min' : '');
    };
    return { system: () => (imp() ? 'imperial' : 'metric'), len, dist, height, climb, area, duration,
      fmtLen: len, fmtDist: dist, fmtHeight: height, fmtClimb: climb, fmtArea: area, fmtDuration: duration };
  }
  function browser(w) {
    const KEY = 'flex.units';
    let cur = null;
    const read = () => { try { return w.localStorage.getItem(KEY) === 'imperial' ? 'imperial' : 'metric'; } catch (_) { return 'metric'; } };
    const U = make(() => { if (cur == null) cur = read(); return cur; });
    U.set = function (s) {
      s = s === 'imperial' ? 'imperial' : 'metric';
      if (s === U.system()) { paint(); return s; }
      cur = s;
      try { w.localStorage.setItem(KEY, s); } catch (_) {}
      paint();
      try { w.dispatchEvent(new w.CustomEvent('flex-units-changed', { detail: { system: s } })); } catch (_) {}
      return s;
    };
    function paint() {
      const d = w.document; if (!d) return;
      const m = d.getElementById('units-metric'), i = d.getElementById('units-imperial');
      if (m) m.checked = U.system() === 'metric';
      if (i) i.checked = U.system() === 'imperial';
    }
    function wire() {
      const d = w.document;
      [['units-metric', 'metric'], ['units-imperial', 'imperial']].forEach(([id, s]) => {
        const r = d.getElementById(id);
        if (r && !r.dataset.wired) { r.dataset.wired = '1'; r.addEventListener('change', () => { if (r.checked) U.set(s); }); }
      });
      paint();
    }
    if (w.document) { if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', wire); else wire(); }
    return U;
  }
  return { make, browser };
});
