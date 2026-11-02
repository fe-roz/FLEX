// icons.js — FLEX's line icons: one inline SVG sprite, offline (index.html and
// help.html load it in <head>).
//
// The style follows Lucide (https://lucide.dev, ISC licence): 24-unit grid,
// stroke 1.5, round caps and joins, one colour (currentColor, so an icon takes
// its button's state colour). The shapes are drawn for FLEX, not copied.
//
//   window.icon(name, size = 20, cls) → '<svg …><use href="#i-name"/></svg>'
//   window.ICONS                      → the names
// In HTML: <svg class="ico" width="20" height="20"><use href="#i-folder"/></svg>
// (the stroke settings come from the .ico rule below; window.icon sets them as
// attributes too, so its markup also works where that rule is not loaded).
(function () {
  'use strict';
  const P = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-open': '<path d="M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1"/><path d="M3 17l2.4-5.9A1.7 1.7 0 0 1 7 10h13a1 1 0 0 1 .9 1.4l-2.5 6.4a1.8 1.8 0 0 1-1.7 1.2H5a2 2 0 0 1-2-2z"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    // LiDAR: a small point cloud (dots, filled)
    cloud: '<g fill="currentColor" stroke="none"><circle cx="5" cy="17" r="1.2"/><circle cx="9" cy="13" r="1.2"/><circle cx="13" cy="16" r="1.2"/><circle cx="17" cy="11" r="1.2"/><circle cx="19" cy="17" r="1.2"/><circle cx="12" cy="8" r="1.2"/><circle cx="8" cy="19" r="1.2"/><circle cx="15" cy="19.5" r="1.2"/><circle cx="6" cy="9" r="1.2"/><circle cx="18" cy="6" r="1.2"/></g>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    // Caves: an arch over a floor line
    cave: '<path d="M3 20h18"/><path d="M5 20v-6a7 7 0 0 1 14 0v6"/><path d="M9 20v-3.5a3 3 0 0 1 6 0V20"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><path d="M12 17h.01"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
    check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    // Export: a phone lying flat (isometric), the offline map going to FLEX Field
    pack: '<path d="M9.5 15.5 19 10 13.8 7 4.3 12.5z"/><path d="M4.3 12.5v1.8l5.2 3L19 11.8V10"/><path d="M9.5 15.5v1.8"/><path d="m16.8 9.8-2.6-1.5"/>',
    leaf: '<path d="M5 19C5 10 10 5 20 5c0 10-5 15-13 15"/><path d="M5 19c3-5 6-8 10-10"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><path d="M7 21v-7h10v7"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-1 1.4-2l-.4-1c-.5-1.3.5-2.7 1.9-2.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  };
  const NS = 'http://www.w3.org/2000/svg';
  const ATTR = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

  window.ICONS = Object.keys(P);
  window.icon = function (name, size, cls) {
    const s = size || 20;
    return `<svg class="ico${cls ? ' ' + cls : ''}" width="${s}" height="${s}" viewBox="0 0 24 24" ${ATTR}><use href="#i-${name}"/></svg>`;
  };

  function inject() {
    if (document.getElementById('flex-icons')) return;
    const div = document.createElement('div');
    div.innerHTML = `<svg xmlns="${NS}" id="flex-icons" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">` +
      Object.entries(P).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('') + '</svg>';
    document.body.insertBefore(div.firstChild, document.body.firstChild);
  }
  // The look of an icon in markup: lines, not fills; size from width/height.
  const st = document.createElement('style');
  st.textContent = 'svg.ico { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex: none; vertical-align: -0.2em; overflow: visible; }';
  document.head.appendChild(st);
  if (document.body) inject(); else document.addEventListener('DOMContentLoaded', inject);
})();
