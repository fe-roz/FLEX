// globe-watchdog.js — bring the globe back when a map layer stalls at startup.
//
// Cesium draws a level-0 globe tile only once at least one shown imagery layer
// has its picture for that tile (or every layer has finished, even by failing).
// If the only shown layers are waiting on a tile server that never answers,
// there is no globe at all, and nothing retries. Turning such a layer off and
// on fixes it, because Cesium never hides already-drawn level-0 tiles when a
// layer is shown again. This does the same thing automatically: when a
// level-0 tile has its terrain but is still not drawable after a while, the
// layers holding it up are switched off and on (they stay shown, and their
// tiles fill in whenever their server answers).
//
// Uses Cesium internals (globe._surface._levelZeroTiles, tile imagery states),
// checked against Cesium 1.122; on any surprise it does nothing.
(function () {
  'use strict';
  const CHECK_MS = 1000;       // how often to look
  const STUCK_MS = 6000;       // how long a tile may wait before we step in
  const MAX_NUDGES = 5;        // per page load

  let stuckSince = 0, nudges = 0, told = false, lastFrame = -1;

  // Imagery states (Cesium ImageryState): READY 3, FAILED 4, INVALID 5.
  const settled = im => !im || im.state === 3 || im.state === 4 || im.state === 5;

  function stalledLayers(tiles) {
    const out = new Set();
    for (const tile of tiles) {
      const imagery = (tile.data && tile.data.imagery) || [];
      for (const ti of imagery) {
        if (ti.readyImagery) continue;                 // already has a picture here
        const im = ti.loadingImagery;
        if (!im || settled(im)) continue;
        if (im.imageryLayer && im.imageryLayer.show) out.add(im.imageryLayer);
      }
    }
    return [...out];
  }

  function check() {
    const v = window.cesiumViewer;
    if (!v || v.isDestroyed()) return;
    const globe = v.scene.globe;
    if (!globe || !globe.show) { stuckSince = 0; return; }
    // Only while frames are being drawn (a background tab draws none: nothing to judge).
    const frame = v.scene.frameState && v.scene.frameState.frameNumber;
    if (frame === lastFrame) return;
    lastFrame = frame;
    const roots = globe._surface && globe._surface._levelZeroTiles;
    const rootsOk = Array.isArray(roots) && roots.length;
    // No globe at all: no root tile drawable (or none made yet).
    const notDrawn = rootsOk ? roots.filter(t => t && !t.renderable) : [];
    if (rootsOk && notDrawn.length < roots.length) { stuckSince = 0; return; }
    const now = Date.now();
    if (!stuckSince) { stuckSince = now; return; }
    if (now - stuckSince < STUCK_MS || nudges >= MAX_NUDGES) return;
    // Terrain is in (it has a mesh) but a shown layer has no picture yet.
    let layers = stalledLayers(notDrawn.filter(t => t.data && t.data.vertexArray));
    if (!layers.length) {
      // Something else: say what, once, for the bug report; then the by-hand
      // fix (a shown layer off and on), which has always brought it back.
      if (!told) {
        told = true;
        const lz = v.imageryLayers, names = [];
        for (let i = 0; i < lz.length; i++) { const l = lz.get(i); names.push((l.name || 'layer ' + i) + (l.show ? '' : ' (hidden)') + (l.ready === false ? ' (not ready)' : '')); }
        console.warn('[globe] no globe after ' + Math.round((now - stuckSince) / 1000) + ' s: ' +
          (!rootsOk ? 'no root tiles yet' : notDrawn.length + ' root tile(s) not drawable, terrain ' + notDrawn.filter(t => t.data && t.data.vertexArray).length + '/' + notDrawn.length + ' in') +
          '; terrain provider ' + (globe.terrainProvider ? globe.terrainProvider.constructor.name : 'none') + '; layers: ' + names.join(', '));
      }
      layers = [];
      for (let i = 0; i < v.imageryLayers.length; i++) { const l = v.imageryLayers.get(i); if (l.show) layers.push(l); }
      if (!layers.length) return;
    }
    nudges++; stuckSince = now;
    console.warn('[globe] no globe yet: waiting on ' + layers.map(l => '"' + (l.name || 'a layer') + '"').join(', ') +
      ' - showing the globe without ' + (layers.length > 1 ? 'them' : 'it') + ' until ' + (layers.length > 1 ? 'they load' : 'it loads'));
    // Cesium notices show changes once per frame, so the off and the on must
    // land in different frames.
    for (const l of layers) l.show = false;
    setTimeout(() => { for (const l of layers) l.show = true; }, 250);
  }

  setInterval(() => { try { check(); } catch (e) { /* Cesium changed: stay out of the way */ } }, CHECK_MS);
})();
