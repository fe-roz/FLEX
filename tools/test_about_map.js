// "About this map" (viewer_build/libs/about-map.js): the rows of the card from what an export says about itself.
// A ridgewalking export with everything, a plain cave export, and an older export that has no `about` at all.
//   node tools/test_about_map.js
'use strict';
const A = require('../viewer_build/libs/about-map.js');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + (typeof i === 'string' ? i : JSON.stringify(i)).slice(0, 700) : '')); } };
const get = (rows, k) => (rows.find(r => r.k === k) || {}).v;
const heads = rows => rows.filter(r => r.h).map(r => r.h);
const TZ = new Date('2026-11-23T10:30:00Z');
const p2 = v => String(v).padStart(2, '0'), local = `${TZ.getFullYear()}-${p2(TZ.getMonth() + 1)}-${p2(TZ.getDate())} ${p2(TZ.getHours())}:${p2(TZ.getMinutes())}`;

// ── a ridgewalking export with everything ───────────────────────────────────
const about = { v: 1, exported: '2026-11-23T10:30:00Z', area_km2: 1.0432, size_m: [1020, 1023], polygon: true, terrain: 'ridge', cell_m: 0.3, flex: { commit: '0123456789ab' },
  lidar: ['Cave_Ridge_2021', 'Sink Valley 2019'], layers: { aerial: 'bing', hillshade: 'lidar', hsb: true, slope: true },
  ridge: { counts: { features: 212, true_cells: 3400, guessed_cells: 1250, below: 48210, groups: 380, lone: 95, likely_noise: 12, pattern_noise: 6021, returns: 9000000 }, passes: 14, flagged: ['1207', '1211'],
           params: { min_behind: 1, max_link: 12, link: 1.5, cell: 0.3 }, shapes: true },
  brush: { opacity: 0.7 }, slope: { opacity: 0.7 }, trees: { count: 81234, cone: 60000, round: 15000, mound: 6234 }, features: { points: 241, lines: 31, areas: 30, folders: 9 }, marks: 4, docs: { entries: 12, pages: 30 } };
const meta = { name: 'Cave Ridge', ridgewalk: 1, terrain: 'lidar', terrain_cell_m: 0.3, hillshade: 'lidar', hillshade_cell_m: 0.3, satellite: 'bing', extent_utm: [0, 0, 1020, 1023], about, project: { id: 'p', name: 'Cave Ridge project' } };
const caves = { surveys: [{ cave: 'Cave Ridge Cave', name: 'A', stations: [{ name: 'A1' }, { name: 'A2', leads: [{}, {}] }] }, { cave: 'Cave Ridge Cave', name: 'B', stations: [{ name: 'B1' }] }, { cave: 'Sink Pot', name: 'S', stations: [{}, {}, {}] }] };
let r = A.facts({ meta, caves, ridge: { counts: about.ridge.counts }, trees: { count: 81234 }, features: null, has: { sat: true, hs: true, hsb: true, slope: true } });
ok('name and export date (shown in the phone\'s own time)', get(r, 'Map') === 'Cave Ridge' && get(r, 'Exported') === local, [get(r, 'Exported'), local]);
ok('area in km² with its size, and that it was cut to a polygon', get(r, 'Area') === '1.04 km², 1.02 km × 1.02 km (cut to a polygon)', get(r, 'Area'));
ok('terrain and the LiDAR datasets by name', get(r, 'Terrain') === 'the ridgewalking ground (LiDAR), 0.3 m cells' && get(r, 'LiDAR') === 'Cave_Ridge_2021, Sink Valley 2019', [get(r, 'Terrain'), get(r, 'LiDAR')]);
ok('the four maps, with brush and slope strength', get(r, 'Aerial') === 'Bing imagery' && /from the LiDAR ground, 0\.3 m/.test(get(r, 'Hillshade')) && get(r, 'Hillshade + brush') === 'brush at 70 %' && get(r, 'Slope') === 'slope colours at 70 %, from 27°', r.filter(x => x.k));
ok('ridgewalking: features, openings, returns', get(r, 'Features') === '212' && get(r, 'Openings') === '3,400 cells of true entrances (holes in the ground), 1,250 guessed (dark patches)' && get(r, 'Returns below ground') === '48,210 in 380 groups, 95 lone, 12 likely noise', [get(r, 'Openings'), get(r, 'Returns below ground')]);
ok('…patterned noise with the flagged passes', get(r, 'Set aside') === '6,021 returns as patterned noise, from 2 flight passes of 14 (1207, 1211)', get(r, 'Set aside'));
ok('…shapes and the settings that matter', r.filter(x => x.k === 'Shapes')[0].v === 'carried' && get(r, 'Settings') === 'below ground = more than 1 m behind the face; longest guessed link 12 m; returns within 1.5 m are one group', get(r, 'Settings'));
ok('trees, surface features, marks', r.some(x => x.v === '81,234 (60,000 cones, 15,000 round crowns, 6,234 low mounds)') && get(r, 'Items') === '241 points, 31 lines, 30 areas in 9 folders (view only)' && get(r, 'On ridgewalking features') === '4 marks came with the map', r.filter(x => x.k === 'Items'));
ok('caves counted here: caves, surveys, stations, leads; the project; documents', get(r, 'Caves') === '2 caves, 3 surveys, 6 stations, 2 leads' && get(r, 'Project') === 'Cave Ridge project' && get(r, 'Documents') === '12 entries, 30 page images', [get(r, 'Caves'), get(r, 'Documents')]);
ok('the FLEX commit', get(r, 'FLEX') === 'commit 0123456789ab');
ok('sections in order', heads(r).join() === 'Maps,Ridgewalking,Trees and brush,Surface features,Marks,Caves,Made by', heads(r));
ok('every value is a plain string', r.every(x => x.h || (typeof x.k === 'string' && typeof x.v === 'string' && x.v.length)));
// no patterned noise pass flagged
const a2 = JSON.parse(JSON.stringify(about)); a2.ridge.flagged = []; a2.ridge.counts.pattern_noise = 0; a2.ridge.shapes = false;
r = A.facts({ meta: Object.assign({}, meta, { about: a2 }), caves, ridge: {}, has: { sat: true, hs: true, hsb: true, slope: false } });
ok('no flagged pass: says so; shapes left out; a map that was not loaded is not listed', get(r, 'Set aside') === '0 returns as patterned noise; no flight pass was flagged (of 14)' && r.find(x => x.k === 'Shapes').v === 'left out' && get(r, 'Slope') === undefined, [get(r, 'Set aside')]);

// ── a plain cave export (map terrain, no extras) ────────────────────────────
const plain = { name: 'Sink Valley', terrain: 'map', terrain_cell_m: 10, hillshade: 'dem', satellite: 'esri', extent_utm: [500000, 4990000, 506500, 4995200],
  about: { v: 1, exported: '2026-11-23T10:30:00Z', area_km2: 33.8, size_m: [6500, 5200], polygon: false, terrain: 'map', cell_m: 10, layers: { aerial: 'esri', hillshade: 'dem', hsb: false, slope: false, tiles: [2, 2] } }, texture_tiles: { cols: 2, rows: 2, sat: true, hs: true } };
r = A.facts({ meta: plain, caves: { surveys: [{ cave: 'Sink Pot', stations: [{}, {}] }] }, ridge: null, trees: null, features: null, has: { sat: true, hs: true, hsb: false, slope: false } });
ok('plain export: area, map terrain, two maps in tiles; no ridgewalking, trees, features, marks or commit', get(r, 'Area') === '33.8 km², 6.50 km × 5.20 km' && get(r, 'Terrain') === 'the map’s terrain (no LiDAR), 10 m cells' && get(r, 'LiDAR') === undefined
   && get(r, 'Aerial') === 'Esri imagery' && get(r, 'Hillshade') === 'from the terrain' && get(r, 'Pictures') === 'in 2 × 2 tiles (a large area)' && heads(r).join() === 'Maps,Caves' && get(r, 'Caves') === '1 cave, 1 survey, 2 stations', r);
r = A.facts({ meta: plain, caves: { surveys: [] }, has: {} });
ok('a map with no caves says so', get(r, 'Caves') === 'none on this map');

// ── an older export: no `about` ─────────────────────────────────────────────
const old = { name: 'Old map', terrain: 'lidar', terrain_cell_m: 0.5, hillshade: 'lidar', hillshade_cell_m: 0.5, satellite: 'bing', extent_utm: [500000, 4990000, 500800, 4990600],
  area_polygon: [[-300, -200], [300, -200], [300, 200], [-300, 200]] };
r = A.facts({ meta: old, caves, ridge: null, trees: null, features: { folders: [{ id: 'a' }], items: [{ kind: 'point' }, { kind: 'point' }, { kind: 'line' }] }, has: { sat: true, hs: true, hsb: false, slope: false } });
ok('older export: the date is not known and it says so', get(r, 'Exported') === 'not recorded (an older export)');
ok('…the area from its polygon, the size from its terrain', get(r, 'Area') === '24.0 ha, 800 m × 600 m (cut to a polygon)', get(r, 'Area'));
ok('…terrain, maps and caves from what the map itself says; features counted from the file', get(r, 'Terrain') === 'LiDAR ground, 0.5 m cells' && get(r, 'Aerial') === 'Bing imagery' && /from the LiDAR ground, 0\.5 m/.test(get(r, 'Hillshade')) && get(r, 'Caves') === '2 caves, 3 surveys, 6 stations, 2 leads'
   && get(r, 'Items') === '2 points, 1 line, 0 areas in 1 folder (view only)' && heads(r).join() === 'Maps,Surface features,Caves', r);
// an old ridgewalking export: counts from RIDGE, strength from the old meta
r = A.facts({ meta: { name: 'Old ridge', ridgewalk: 1, terrain: 'lidar', terrain_cell_m: 0.3, hillshade: 'lidar', hillshade_brush: { opacity: 0.3 }, extent_utm: [0, 0, 300, 300] }, caves: { surveys: [] },
  ridge: { counts: { features: 7, true_cells: 20, guessed_cells: 5, below: 100, pattern_noise: 3 } }, trees: { count: 500 }, has: { sat: true, hs: true, hsb: true, slope: false } });
ok('older ridgewalking export: counts from the ridge data, brush strength from the old meta, no settings', get(r, 'Terrain') === 'the ridgewalking ground (LiDAR), 0.3 m cells' && get(r, 'Features') === '7' && get(r, 'Hillshade + brush') === 'brush at 30 %'
   && get(r, 'Set aside') === '3 returns as patterned noise' && get(r, 'Settings') === undefined && r.some(x => x.v === '500') && get(r, 'Area') === '9.0 ha, 300 m × 300 m', r);
// nothing at all
let threw = null; try { r = A.facts({}); A.facts(null); A.facts({ meta: { about: 'junk', extent_utm: 'x' }, caves: { surveys: [null, {}] }, ridge: 5, trees: 'x', features: 7 }); } catch (e) { threw = e; }
ok('no data, or junk: no error', !threw && get(r, 'Map') === 'No name', threw && threw.stack);
ok('helpers', A.areaText(0.005) === '5000 m²' && A.areaText(12.34) === '12.3 km²' && A.sizeText(12500, 300) === '12.5 km × 300 m' && A.when('nonsense') === '');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
