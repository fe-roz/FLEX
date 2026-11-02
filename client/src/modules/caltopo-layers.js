// caltopo-layers.js — the CalTopo map's own custom layers, offered as map layers
// in 🗺 Layers (read-only: FLEX never writes a layer back to CalTopo).
//
// How CalTopo keeps them (worked out on 2026-11-01 from CalTopo's own web app,
// caltopo.com/static/js/main.js — its "Custom Source" and "WFS Source" dialogs
// and the CustomLayer controller — and CalTopo's help page "Custom Source
// Layers", training.caltopo.com/all_users/base-layers/custom-source; the
// caltopo-python library (github.com/ncssar/caltopo_python) only shows the
// map's mapConfig.activeLayers, not this class):
//
//   A custom layer saved to a map is a map feature like a marker, so it comes
//   with every pull of the map (GET /api/v1/map/<id>/since/0 → result.state.features):
//     { id, type: 'Feature', geometry: null,
//       properties: { class: 'CustomLayer', title,
//                     type: 'TILE' | 'TMS' | 'WMS' | 'WFS',
//                     template,          // the URL template
//                     maxzoom,           // TILE / TMS: '12'…'21' (a string from a list); WMS: null
//                     alphaOverlay,      // true = "transparent overlay", false = a base layer
//                     minzoom, interval, label } }   // WFS only
//   Templates: TILE / TMS use {Z} {X} {Y} (CalTopo upper-cases {z} {x} {y} when
//   saved; TMS counts rows from the bottom), optionally {2x} (hi-dpi) and {V};
//   WMS uses {left},{bottom},{right},{top} and {tilesize}, in the SRS / CRS the
//   link names (CalTopo's auto-configure picks EPSG:3857; ArcGIS exports use
//   bboxSR / imageSR). WFS is vector features (GeoJSON), not pictures.
//   CalTopo turns each one into an alias for its layer stack,
//   (alphaOverlay ? 'clo_' : 'cl_') + encodeURIComponent(JSON.stringify({template, type, maxzoom})),
//   and the map's saved view (mapConfig: {activeLayers: [[alias, opacity], …]})
//   lists the ones switched on. Map sheets (MapGeoImage), georeferenced images
//   (GeoRef) and CalTopo's own configured layers (ConfiguredLayer, e.g. its
//   terrain shading) are other classes, drawn by CalTopo's servers: not read here.
//
// What FLEX does with them: TILE, TMS and WMS (in EPSG:3857 or lon/lat) are
// drawn like a tile link (custom-layers.js), one row each in 🗺 Layers marked
// as from the CalTopo map. Shown / hidden and see-through are kept per
// computer, like other layers; the first time, an overlay is shown and a base
// layer hidden (a base layer covers everything below it), unless the map's
// saved view says otherwise. WFS and other projections are listed in the
// console and skipped. The tiles are fetched by the browser straight from the
// link: a key in the link works as in CalTopo; a server that needs a CalTopo
// sign-in or does not allow other sites (CORS) gives no tiles, and the row
// shows a plain warning.
(function (root) {
  'use strict';

  /** What a CalTopo map JSON (the /api/caltopo/map answer) has as custom layers. */
  function parse(json) {
    const res = (json && json.result) || json || {};
    const feats = (res.state && res.state.features) || res.features || [];
    const active = activeLayers(res, feats);
    const out = [], skipped = [];
    for (const f of feats) {
      const p = f && f.properties;
      if (!p || p.class !== 'CustomLayer') continue;
      const name = String(p.title || '').trim() || 'CalTopo layer';
      const conv = convert(p);
      if (!conv.url) { skipped.push({ id: f.id, name, why: conv.why }); continue; }
      const overlay = !!p.alphaOverlay, alias = aliasOf(p), on = active ? active.get(alias) : undefined;
      out.push({
        id: 'ct-' + f.id, fid: f.id, name, kind: conv.kind, url: conv.url, maxZoom: conv.maxZoom, overlay, type: conv.type,
        // The first look (before the person has switched it): CalTopo's saved view, else overlays on, base layers off.
        defShow: on !== undefined ? true : (active && active.size ? false : overlay),
        defAlpha: on !== undefined && isFinite(+on) ? Math.max(0, Math.min(1, +on)) : 1,
      });
    }
    return { layers: out, skipped };
  }

  // CalTopo's own alias for a custom layer (same key order as CalTopo builds it).
  function aliasOf(p) {
    if (String(p.type).toUpperCase() === 'WFS') return 'wfs_' + encodeURIComponent(JSON.stringify({ template: p.template, type: p.type, minzoom: p.minzoom, interval: p.interval, label: p.label }));
    return (p.alphaOverlay ? 'clo_' : 'cl_') + encodeURIComponent(JSON.stringify({ template: p.template, type: p.type, maxzoom: p.maxzoom }));
  }
  // The map's saved layer view, if the pull carries it: alias → opacity.
  function activeLayers(res, feats) {
    const cands = [res.config, res.mapConfig, res.properties && res.properties.mapConfig, res.state && res.state.mapConfig];
    (feats || []).forEach(f => { if (f && f.properties && f.properties.class === 'MapConfig') cands.push(f.properties, f.properties.mapConfig, f.properties.config); });
    for (let c of cands) {
      if (typeof c === 'string') { try { c = JSON.parse(c); } catch (_) { continue; } }
      const list = c && (Array.isArray(c) ? c : c.activeLayers);
      if (Array.isArray(list)) { const m = new Map(); list.forEach(a => { if (Array.isArray(a) && typeof a[0] === 'string') m.set(a[0], a[1]); }); return m; }
    }
    return null;
  }

  /** A CalTopo template → a Cesium UrlTemplateImageryProvider url, or { why } it can't be drawn. */
  function convert(p) {
    let t = String(p.template || '').trim(), type = String(p.type || '').toUpperCase();
    if (!t) return { why: 'no link' };
    if (t.startsWith('//')) t = 'https:' + t;
    if (!/^https?:\/\//i.test(t)) return { why: 'not a web link' };
    if (type === 'WFS') return { why: 'a WFS source (map features, not pictures): not shown in FLEX' };
    const mz = parseInt(p.maxzoom, 10);
    if (type === 'WMS' || (!type && /\{left\}/i.test(t))) {
      if (!/\{left\}|\{bottom\}|\{right\}|\{top\}/i.test(t)) return { why: 'a WMS link without {left},{bottom},{right},{top}' };
      const srs = (t.match(/[?&](?:srs|crs|bboxsr)=([^&]*)/i) || [])[1] || '';
      const s = decodeURIComponent(srs).toUpperCase();
      let deg;
      if (!s || /(^|:)(3857|900913|102100|102113)$/.test(s)) deg = false;
      else if (/(^|:)4326$|CRS:?84$/.test(s)) deg = true;
      else return { why: 'its map projection (' + decodeURIComponent(srs) + ') is not one FLEX draws (EPSG:3857 or lon/lat)' };
      const P = deg ? ['{west}', '{south}', '{east}', '{north}'] : ['{westProjected}', '{southProjected}', '{eastProjected}', '{northProjected}'];
      const url = t.replace(/\{left\}/gi, P[0]).replace(/\{bottom\}/gi, P[1]).replace(/\{right\}/gi, P[2]).replace(/\{top\}/gi, P[3]).replace(/\{tilesize\}/gi, '256');
      return { kind: 'tiles', type: 'WMS', url, maxZoom: 20 };
    }
    if (type && type !== 'TILE' && type !== 'TMS') return { why: 'a ' + type + ' source: not shown in FLEX' };
    if (!/\{z\}/i.test(t) || !/\{x\}/i.test(t) || !/\{y\}/i.test(t)) return { why: 'a tile link without {Z}, {X} and {Y}' };
    const url = t.replace(/\{z\}/gi, '{z}').replace(/\{x\}/gi, '{x}').replace(/\{y\}/gi, type === 'TMS' ? '{reverseY}' : '{y}').replace(/\{2x\}/gi, '').replace(/\{v\}/gi, '');
    return { kind: 'tiles', type: type || 'TILE', url, maxZoom: isFinite(mz) ? Math.max(0, Math.min(22, mz)) : 18 };
  }

  // ── The layers of the CalTopo map loaded now ─────────────────────────────
  let cur = { map: null, layers: [], sig: '' };
  /** A private-map pull (flex.js): the layers it has; null map = no CalTopo map (cleared, a public one). */
  function apply(mapId, json) {
    const P = mapId && json ? parse(json) : { layers: [], skipped: [] };
    const sig = (mapId || '') + '|' + JSON.stringify(P.layers);
    if (P.skipped.length && sig !== cur.sig) P.skipped.forEach(s => console.warn('[caltopo] layer “' + s.name + '” not shown: ' + s.why));
    if (sig === cur.sig) return Promise.resolve(false);
    cur = { map: mapId || null, layers: P.layers, sig, skipped: P.skipped };
    const CL = root._customLayers;
    return CL ? CL.sync().then(() => true) : Promise.resolve(true);
  }
  const api = { parse, convert, aliasOf, apply, list: () => cur.layers.slice(), skipped: () => (cur.skipped || []).slice(), mapId: () => cur.map };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root._ctLayers = api;
})(typeof window !== 'undefined' ? window : globalThis);
