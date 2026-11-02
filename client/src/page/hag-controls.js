// Live HAG filter controls (Potree panel, #lp-hag-*): classic script, wires the DOM at parse
// time and calls the window._hag* hooks flex.js defines. Moved out of index.html's export IIFE.
(function _wireHag() {
  const en  = document.getElementById('lp-hag-enable');
  const box = document.getElementById('lp-hag-controls');
  const lo  = document.getElementById('lp-hag-min');
  const hi  = document.getElementById('lp-hag-max');
  const loL = document.getElementById('lp-hag-min-label');
  const hiL = document.getElementById('lp-hag-max-label');
  const sum = document.getElementById('lp-hag-label');
  if (!en || !lo || !hi) return;

  const keepBox = document.getElementById('lp-hag-keep');
  const bush    = document.getElementById('lp-hag-bush');
  const bushBox = document.getElementById('lp-hag-bush-controls');
  const bLo = document.getElementById('lp-hag-bush-lo');
  const bHi = document.getElementById('lp-hag-bush-hi');
  const bLoL = document.getElementById('lp-hag-bush-lo-label');
  const bHiL = document.getElementById('lp-hag-bush-hi-label');
  const bSum = document.getElementById('lp-hag-bush-label');

  const fmt = v => (v < 0 ? '\u2212' : '') + Math.abs(v).toFixed(1) + ' m';
  // Field judgement is in feet even when the data is metric, so show both.
  const fmtBoth = v => String(+v.toFixed(2)) + ' m (' + (v * 3.28084).toFixed(1) + ' ft)';

  // The panel is visible when anything that needs the grid is on.
  function syncVisibility() {
    const any = en.checked || bush.checked ||
                (document.getElementById('lp-hag-debug') || {}).checked;
    box.style.display = any ? 'block' : 'none';
    keepBox.style.display = en.checked ? 'block' : 'none';
    bushBox.style.display = bush.checked ? 'block' : 'none';
  }

  function applyBush() {
    let a = parseFloat(bLo.value), b = parseFloat(bHi.value);
    if (b < a + 0.05) { b = a + 0.05; bHi.value = b; }
    bLoL.textContent = fmtBoth(a);
    bHiL.textContent = fmtBoth(b);
    bSum.textContent = fmtBoth(a) + ' \u2013 ' + fmtBoth(b);
    if (window._hagSetBushRange) window._hagSetBushRange(a, b);
  }

  function apply() {
    let a = parseFloat(lo.value), b = parseFloat(hi.value);
    if (b < a + 0.25) b = a + 0.25, hi.value = b;
    loL.textContent = fmt(a);
    hiL.textContent = fmt(b);
    if (sum) sum.textContent = fmt(a) + ' \u2013 ' + fmt(b);
    if (window._hagSetRange) window._hagSetRange(a, b);
  }
  en.addEventListener('change', () => {
    syncVisibility();
    if (window._hagEnable) window._hagEnable(en.checked);
    if (en.checked) apply();
  });
  lo.addEventListener('input', apply);
  hi.addEventListener('input', apply);

  bush.addEventListener('change', () => {
    syncVisibility();
    if (window._hagSetBush) window._hagSetBush(bush.checked);
    if (bush.checked) applyBush();
  });
  bLo.addEventListener('input', applyBush);
  bHi.addEventListener('input', applyBush);
  applyBush();

  const cell = document.getElementById('lp-hag-cell');
  if (cell) cell.addEventListener('change', () => {
    if (window._hagSetCellSize) window._hagSetCellSize(parseFloat(cell.value));
  });

  const env = document.getElementById('lp-hag-env');
  if (env) env.addEventListener('change', () => {
    if (window._hagSetEnvRadius) window._hagSetEnvRadius(parseInt(env.value, 10));
  });

  const fbk = document.getElementById('lp-hag-fallback');
  if (fbk) fbk.addEventListener('change', () => {
    if (window._hagSetFallback) window._hagSetFallback(fbk.checked);
  });

  const dbg = document.getElementById('lp-hag-debug');
  if (dbg) dbg.addEventListener('change', () => {
    if (window._hagSetDebugColor) window._hagSetDebugColor(dbg.checked);
    syncVisibility();
  });
})();
