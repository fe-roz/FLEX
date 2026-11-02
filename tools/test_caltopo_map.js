// Node test for the pure parts of client/src/modules/caltopo-map.js (synthetic data only).
const path = require('path');
const { normalizeCaltopoUrl, caltopoMapId, caltopoFeatureSig } =
  require(path.join(__dirname, '..', 'client', 'src', 'modules', 'caltopo-map.js'));

let pass = 0, fail = 0;
function ok(label, cond, info) {
  if (cond) pass++; else { fail++; console.log('FAIL', label, info === undefined ? '' : JSON.stringify(info)); }
}
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

{ // normalizeCaltopoUrl
  const K = 'https://caltopo.com/m/AB12CD?format=kml';
  eq('bare id', normalizeCaltopoUrl('AB12CD'), K);
  eq('plain url', normalizeCaltopoUrl('https://caltopo.com/m/AB12CD'), K);
  eq('already kml', normalizeCaltopoUrl('https://caltopo.com/m/AB12CD?format=kml'), K);
  eq('http, upper host, spaces', normalizeCaltopoUrl('  http://CalTopo.com/m/AB12CD  '), K);
  eq('empty', normalizeCaltopoUrl(''), null);
  eq('null', normalizeCaltopoUrl(null), null);
  eq('other site', normalizeCaltopoUrl('https://example.org/maps/1'), null);
  eq('id too short', normalizeCaltopoUrl('AB'), null);
  eq('id too long, no url', normalizeCaltopoUrl('ABCDEFGHIJK'), null);
}
{ // caltopoMapId
  eq('id from url', caltopoMapId('https://caltopo.com/m/AB12CD?format=kml'), 'AB12CD');
  eq('no id', caltopoMapId('https://caltopo.com/'), null);
  eq('null', caltopoMapId(null), null);
}
{ // caltopoFeatureSig: same drawn data -> same signature; any drawn property -> different
  const g = { type: 'Point', coordinates: [-100.5678, 45.1234] };
  const p = { title: 'Cave Ridge', description: 'd', stroke: '#ff0000', 'stroke-width': 2, 'marker-color': 'ff8800', fill: '#00ff00', 'fill-opacity': 0.3, folderId: 'f1' };
  const s = caltopoFeatureSig(g, p);
  eq('stable', caltopoFeatureSig(JSON.parse(JSON.stringify(g)), { ...p }), s);
  eq('ignores other props', caltopoFeatureSig(g, { ...p, updated: 123, class: 'Marker' }), s);
  for (const k of ['title', 'description', 'stroke', 'stroke-width', 'marker-color', 'fill', 'fill-opacity', 'folderId'])
    ok('changes with ' + k, caltopoFeatureSig(g, { ...p, [k]: 'x' + String(p[k]) }) !== s);
  ok('changes with geometry', caltopoFeatureSig({ ...g, coordinates: [-100.5679, 45.1234] }, p) !== s);
  eq('shape', JSON.parse(s)[0], g);
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
