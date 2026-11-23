// "About this map" in the portable viewer / FLEX Field (window.AboutMap): what the map is and what it carries.
//
// The exporter writes the facts it has into caves.json meta `about` (export_about.py): when it was exported, the
// area, the LiDAR it came from (the dataset's name, never its link), the maps, the ridgewalking step's counts and
// settings, the LiDAR quality report's few numbers, trees, surface features, marks, the FLEX commit. The viewer adds what it can count itself (caves,
// stations, leads) and what it actually loaded. An older export has no `about`: the card then shows what the rest
// of its meta says and leaves the rest out. Nothing here changes anything.
//
//   AboutMap.facts({ meta, caves, ridge, trees, features, has: { sat, hs, hsb, slope }, units, version })
//       version: FLEX Field's map_version.json after an update package { exported, updated_from, updates, first }
//       → [{ h: 'Section' } | { k: 'Label', v: 'value' }]          (pure: tools/test_about_map.js)
//   AboutMap.open({ el, dialog, ...the same })                    the card, in the viewer's own dialog
(function (root) {
  'use strict';
  var n = function (x) { return (+x).toLocaleString('en-US'); };
  var plural = function (c, one, many) { return n(c) + ' ' + (c === 1 ? one : (many || one + 's')); };
  var pct = function (x) { return Math.round(+x * 100) + ' %'; };
  var num = function (x) { return typeof x === 'number' && isFinite(x); };
  var pct1 = function (x) { var p = +x * 100; return p > 0 && p < 0.05 ? 'under 0.1 %' : (Math.round(p * 10) / 10) + ' %'; };

  function when(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    var p = function (v) { return (v < 10 ? '0' : '') + v; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function sizeText(w, h) {
    var f = function (m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + ' km' : Math.round(m) + ' m'; };
    return f(w) + ' × ' + f(h);
  }
  function areaText(km2) { return km2 >= 1 ? km2.toFixed(km2 >= 10 ? 1 : 2) + ' km²' : km2 >= 0.01 ? (km2 * 100).toFixed(1) + ' ha' : Math.round(km2 * 1e6) + ' m²'; }
  function ringArea(r) { var a = 0; for (var i = 0; i < r.length; i++) { var p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }

  function facts(o) {
    var meta = (o && o.meta) || {}, A = meta.about && typeof meta.about === 'object' ? meta.about : null, has = (o && o.has) || {};
    var out = [], row = function (k, v) { if (v != null && v !== '') out.push({ k: k, v: String(v) }); }, head = function (t) { out.push({ h: t }); };
    row('Map', meta.name || 'No name');
    row('Exported', A && when(A.exported) ? when(A.exported) : 'not recorded (an older export)');
    // the map's version is its export time; a map brought up to date by update packages says from what (map_version.json, FLEX Field)
    var V = o && o.version && typeof o.version === 'object' ? o.version : null;
    if (V && when(V.updated_from) && when(V.exported)) row('Updated', 'from ' + when(V.updated_from) + ' to ' + when(V.exported) + (num(V.updates) && V.updates > 1 ? ' (' + V.updates + ' updates since the full map of ' + when(V.first) + ')' : ''));
    // the area: the exporter's numbers, else the terrain's rectangle (and the polygon when it was cut to one)
    var ex = meta.extent_utm, w = A && A.size_m ? +A.size_m[0] : ex ? ex[2] - ex[0] : null, h = A && A.size_m ? +A.size_m[1] : ex ? ex[3] - ex[1] : null;
    var km2 = A && num(A.area_km2) ? A.area_km2 : Array.isArray(meta.area_polygon) && meta.area_polygon.length > 2 ? ringArea(meta.area_polygon) / 1e6 : (num(w) && num(h) ? w * h / 1e6 : null);
    if (num(km2)) row('Area', areaText(km2) + (num(w) && num(h) ? ', ' + sizeText(w, h) + ((A ? A.polygon : meta.area_polygon) ? ' (cut to a polygon)' : '') : ''));
    var kind = A ? A.terrain : meta.ridgewalk ? 'ridge' : meta.ground === 'area' ? 'area' : meta.terrain;
    var cell = A && num(A.cell_m) ? A.cell_m : meta.terrain_cell_m;
    var tname = { ridge: 'the ridgewalking ground (LiDAR)', lidar: 'LiDAR ground', area: 'the area’s LiDAR ground', map: 'the map’s terrain (no LiDAR)' }[kind];
    if (tname) row('Terrain', tname + (num(cell) ? ', ' + (+cell) + ' m cells' : ''));
    if (A && A.lidar && A.lidar.length) row('LiDAR', A.lidar.join(', '));

    head('Maps');
    var L = (A && A.layers) || {};
    var sat = L.aerial || meta.satellite;
    if (has.sat !== false) row('Aerial', sat ? ({ bing: 'Bing imagery', esri: 'Esri imagery', xyz: 'a map layer of the project', image: 'a map layer of the project' }[sat] || sat) : 'yes');
    var hsKind = L.hillshade !== undefined ? L.hillshade : meta.hillshade;
    if (has.hs || (has.hs === undefined && hsKind)) row('Hillshade', ({ lidar: 'from the LiDAR ground', dem: 'from the terrain', url: 'map tiles', image: 'a map layer of the project' }[hsKind] || 'yes') + (num(meta.hillshade_cell_m) ? ', ' + (+meta.hillshade_cell_m).toFixed(2).replace(/0$/, '') + ' m' : ''));
    var brushOp = A && A.brush ? A.brush.opacity : meta.hillshade_brush ? meta.hillshade_brush.opacity : null;
    if (has.hsb || (has.hsb === undefined && L.hsb)) row('Hillshade + brush', num(brushOp) ? 'brush at ' + pct(brushOp) : 'yes');
    var slopeOp = A && A.slope ? A.slope.opacity : meta.slope_map ? meta.slope_map.opacity : null;
    if (has.slope || (has.slope === undefined && L.slope)) row('Slope', num(slopeOp) ? 'slope colours at ' + pct(slopeOp) + ', from 27°' : 'yes');
    var tt = meta.texture_tiles;
    if (tt && tt.cols * tt.rows > 1) row('Pictures', 'in ' + tt.cols + ' × ' + tt.rows + ' tiles (a large area)');

    // ridgewalking
    var R = (A && A.ridge) || null, rc = (R && R.counts) || (o && o.ridge && o.ridge.counts) || null;
    if (rc && (o.ridge || R)) {
      head('Ridgewalking');
      if (num(rc.features)) row('Features', n(rc.features));
      if (num(rc.true_cells) || num(rc.guessed_cells)) row('Openings', (num(rc.true_cells) ? n(rc.true_cells) + ' cells of true entrances (holes in the ground)' : '') + (num(rc.true_cells) && num(rc.guessed_cells) ? ', ' : '') + (num(rc.guessed_cells) ? n(rc.guessed_cells) + ' guessed (dark patches)' : ''));
      if (num(rc.below)) row('Returns below ground', n(rc.below) + (num(rc.groups) ? ' in ' + plural(rc.groups, 'group') : '') + (num(rc.lone) ? ', ' + n(rc.lone) + ' lone' : '') + (num(rc.likely_noise) ? ', ' + n(rc.likely_noise) + ' likely noise' : ''));
      if (num(rc.pattern_noise)) row('Set aside', n(rc.pattern_noise) + ' returns as patterned noise' + (R && R.flagged ? (R.flagged.length ? ', from ' + plural(R.flagged.length, 'flight pass', 'flight passes') + ' of ' + n(R.passes) + ' (' + R.flagged.slice(0, 8).join(', ') + (R.flagged.length > 8 ? ', …' : '') + ')' : '; no flight pass was flagged' + (R.passes ? ' (of ' + n(R.passes) + ')' : '')) : ''));
      if (R && R.shapes !== undefined) row('Shapes', R.shapes ? 'carried' : 'left out');
      var P = (R && R.params) || {};
      var set = [];
      if (num(P.min_behind)) set.push('below ground = more than ' + (+P.min_behind) + ' m behind the face');
      if (num(P.max_link)) set.push('longest guessed link ' + (+P.max_link) + ' m');
      if (num(P.link)) set.push('returns within ' + (+P.link) + ' m are one group');
      if (set.length) row('Settings', set.join('; '));
    }
    // the LiDAR quality report's few numbers (ridgewalk.py; the full report and its maps are on the desktop)
    var Q = (A && A.quality) || null;
    if (Q && num(Q.passes)) {
      head('LiDAR');
      var fl = Q.flagged || [];
      row('Flight passes', n(Q.passes) + (fl.length ? ', ' + n(fl.length) + ' flagged for patterned noise (' + fl.slice(0, 6).join(', ') + (fl.length > 6 ? ', …' : '') + ')' : ', none flagged'));
      if (Q.dates && Q.dates.length === 2) row('Flown', Q.dates[0] === Q.dates[1] ? Q.dates[0] : Q.dates[0] + ' to ' + Q.dates[1]);
      if (num(Q.single_pass)) row('Seen by one pass only', pct1(Q.single_pass) + ' of the area' + (num(Q.no_pass) && Q.no_pass > 0 ? '; by none ' + pct1(Q.no_pass) : ''));
      if (num(Q.ground_not_seen)) row('Ground not seen', pct1(Q.ground_not_seen) + ' (no ground return within 3 m: filled in from around)');
      row('Tiles left blank', num(Q.tiles_blank) ? n(Q.tiles_blank) + (num(Q.tiles) ? ' of ' + n(Q.tiles) : '') : 'not known');
    }
    // trees and brush
    var T = (A && A.trees) || (o && o.trees && num(o.trees.count) ? { count: o.trees.count } : null);
    if (T && num(T.count)) { head('Trees and brush'); row('Shapes', n(T.count) + (num(T.cone) ? ' (' + n(T.cone) + ' cones, ' + n(T.round) + ' round crowns, ' + n(T.mound) + ' low mounds)' : '')); }
    // surface features
    var F = (A && A.features) || null;
    if (!F && o && o.features && Array.isArray(o.features.items)) {
      var c = { points: 0, lines: 0, areas: 0 }; o.features.items.forEach(function (it) { if (it && c[it.kind + 's'] !== undefined) c[it.kind + 's']++; });
      F = { points: c.points, lines: c.lines, areas: c.areas, folders: (o.features.folders || []).length };
    }
    if (F && (F.points || F.lines || F.areas)) { head('Surface features'); row('Items', plural(F.points || 0, 'point') + ', ' + plural(F.lines || 0, 'line') + ', ' + plural(F.areas || 0, 'area') + (F.folders ? ' in ' + plural(F.folders, 'folder') : '') + ' (view only)'); }
    if (A && num(A.marks) && A.marks > 0) { head('Marks'); row('On ridgewalking features', plural(A.marks, 'mark') + ' came with the map'); }
    // caves: counted here
    var S = (o && o.caves && o.caves.surveys) || [];
    head('Caves');
    if (!S.length) row('Caves', 'none on this map');
    else {
      var st = 0, leads = 0, names = {};
      S.forEach(function (s) { var pts = (s && (s.stations || s.shots)) || []; st += pts.length; names[(s && (s.cave || s.name)) || '?'] = 1;
        pts.forEach(function (p) { if (p && p.leads && p.leads.length) leads += p.leads.length; }); });
      var nc = Object.keys(names).length;
      row('Caves', plural(nc, 'cave') + ', ' + plural(S.length, 'survey') + (st ? ', ' + plural(st, 'station') : '') + (leads ? ', ' + plural(leads, 'lead') : ''));
      if (meta.project && meta.project.name) row('Project', meta.project.name);
    }
    if (A && A.docs && (A.docs.entries || A.docs.pages)) row('Documents', plural(A.docs.entries || 0, 'entry', 'entries') + ', ' + plural(A.docs.pages || 0, 'page image'));
    if (A && A.flex && A.flex.commit) { head('Made by'); row('FLEX', 'commit ' + String(A.flex.commit).slice(0, 12)); }
    return out;
  }

  function open(o) {
    var el = o.el, body = el('div', 'am-card');
    body.id = 'about-map';
    facts(o).forEach(function (f) {
      if (f.h) { body.appendChild(el('div', 'am-h', f.h)); return; }
      var r = el('div', 'am-r'); r.appendChild(el('span', 'am-k', f.k)); r.appendChild(el('span', 'am-v', f.v)); body.appendChild(r);
    });
    return o.dialog({ title: 'About this map', body: body, wide: true, buttons: [{ label: 'Close', value: 'ok', primary: true }] });
  }

  var api = { facts: facts, open: open, when: when, areaText: areaText, sizeText: sizeText };
  root.AboutMap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
