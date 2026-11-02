// caltopo-send.js, the part that runs without a browser: entrance tags (old and new forms), what a project
// item becomes in CalTopo, which folders are found or created. Made-up names only.
const S = require('./load_classic')(require('path').join(__dirname, '..', 'client', 'src', 'modules', 'caltopo-send.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i) : '')); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Tags
ok('old tag reads', eq(S.parseTag('flex: cave=Cave Ridge; station=A1'), { cave: 'Cave Ridge', station: 'A1' }));
ok('new tag reads z and id', eq(S.parseTag('Big entrance\nflex: cave=Cave Ridge; station=A1; z=1234.5; id=c7'), { cave: 'Cave Ridge', station: 'A1', z: 1234.5, id: 'c7' }));
ok('keys in any case and order, spaces', eq(S.parseTag('<div>FLEX: ID = c7 ; Z = -12 ; Cave = Cave Ridge ; Station = 0</div>'), { cave: 'Cave Ridge', station: '0', z: -12, id: 'c7' }));
ok('z that is not a number is left out', eq(S.parseTag('flex: cave=X; station=1; z=high'), { cave: 'X', station: '1' }));
ok('empty z, empty id', eq(S.parseTag('flex: cave=X; station=1; z=; id='), { cave: 'X', station: '1' }));
ok('no cave, no tag', S.parseTag('flex: station=1') === null && S.parseTag('just a pit') === null && S.parseTag('') === null && S.parseTag(null) === null);
ok('makeTag: old form with two arguments', S.makeTag('Cave Ridge', 'A1') === 'flex: cave=Cave Ridge; station=A1');
ok('makeTag: z rounded to 0.1, id', S.makeTag('Cave Ridge', 'A1', { z: 1234.56, id: 'c7' }) === 'flex: cave=Cave Ridge; station=A1; z=1234.6; id=c7');
ok('makeTag: z of 0 is kept, undefined is not', S.makeTag('X', '1', { z: 0 }).endsWith('; z=0') && S.makeTag('X', '1', { z: undefined }) === 'flex: cave=X; station=1');
ok('round trip', eq(S.parseTag(S.makeTag('Cave Ridge', 'A1', { z: 99.5, id: 'abc' })), { cave: 'Cave Ridge', station: 'A1', z: 99.5, id: 'abc' }));
ok('the old reader still finds cave and station in a new tag', (() => { const FL = require('../viewer_build/libs/flexlib.js'); const t = FL.flexTag(S.makeTag('Cave Ridge', 'A1', { z: 5, id: 'c7' })); return t && t.cave === 'Cave Ridge' && t.station === 'A1'; })());

// What CalTopo gets
const pt = { id: 'p1', kind: 'point', name: 'Pit', desc: 'deep', coords: [[-100.5678, 45.1234, 880]], style: { symbol: 'cave' } };
let c = S.toCalTopo(pt, 'F9', '#00ff88');
ok('point → Marker with name, description, colour, symbol, folder', c.properties.class === 'Marker' && c.properties.title === 'Pit' && c.properties.description === 'deep' && c.properties['marker-color'] === '00FF88' && c.properties['marker-symbol'] === 'cave' && c.properties.folderId === 'F9', c);
ok('point geometry is lon, lat only', eq(c.geometry, { type: 'Point', coordinates: [-100.5678, 45.1234] }), c.geometry);
ok('point without symbol → "point", no folder → no folderId', (() => { const x = S.toCalTopo(Object.assign({}, pt, { style: {} }), null, '#fff'); return x.properties['marker-symbol'] === 'point' && !('folderId' in x.properties) && x.properties['marker-color'] === 'FFB020'; })());
const ln = { id: 'l1', kind: 'line', name: '', desc: '', coords: [[-100.5, 45.1], [-100.4, 45.2], [-100.3, 45.1, 5]] };
c = S.toCalTopo(ln, null, '#ff0000');
ok('line → Shape LineString with stroke; unnamed gets a plain name', c.properties.class === 'Shape' && c.geometry.type === 'LineString' && c.geometry.coordinates.length === 3 && c.geometry.coordinates[2].length === 2 && c.properties.stroke === 'FF0000' && c.properties.title === 'Line', c);
c = S.toCalTopo({ id: 'a1', kind: 'area', name: 'Sink', coords: [[0, 0], [0, 1], [1, 1]] }, null, '#0000ff');
ok('area → Shape Polygon, ring closed, fill', c.geometry.type === 'Polygon' && eq(c.geometry.coordinates[0][0], c.geometry.coordinates[0][3]) && c.geometry.coordinates[0].length === 4 && c.properties.fill === '0000FF' && c.properties['fill-opacity'] === 0.25, c);

// Folders
const groups = { a: { name: 'Pits', parent: '' }, b: { name: 'Checked', parent: 'a' }, c: { name: 'Springs', parent: '' } };
const pathOf = g => { const o = []; for (let x = g; x; x = groups[x].parent) o.unshift(groups[x].name); return o; };
const feats = [{ id: '1', kind: 'point', group: 'b' }, { id: '2', kind: 'point', group: 'a' }, { id: '3', kind: 'point', group: '' }, { id: '4', kind: 'point', group: 'c' }, { id: '5', kind: 'point', group: 'b' }];
let pl = S.plan(feats, [{ id: 'F1', title: 'pits', folderId: null }, { id: 'F2', title: 'Other', folderId: null }], pathOf);
const byName = n => pl.folders.find(x => x.name === n);
ok('a folder CalTopo has (any case) is found, not created', byName('Pits').id === 'F1');
ok('a missing child and a missing top folder are to be created, parent first', byName('Checked').id === null && byName('Checked').parent === byName('Pits').key && byName('Springs').id === null && pl.folders.indexOf(byName('Pits')) < pl.folders.indexOf(byName('Checked')));
ok('each folder once; items point at their folder; loose items at none', pl.folders.length === 3 && pl.items.find(i => i.f.id === '3').folder === null && pl.items.find(i => i.f.id === '1').folder === byName('Checked').key && pl.items.find(i => i.f.id === '5').folder === byName('Checked').key);
pl = S.plan(feats, [{ id: 'F1', title: 'Pits', folderId: null }, { id: 'F3', title: 'Checked', folderId: 'F1' }], pathOf);
ok('nested match by path', pl.folders.find(x => x.name === 'Checked').id === 'F3');
pl = S.plan(feats, [{ id: 'F3', title: 'Checked', folderId: 'F9' }], pathOf);
ok('a folder of the same name under another parent is not a match', pl.folders.find(x => x.name === 'Checked').id === null);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
