// Node test of client/src/modules/waypoint-sessions.js (the pure core). Made-up data near 45.1234, -100.5678.
const W = require('./load_classic')(require('path').join(__dirname, '..', 'client', 'src', 'modules', 'waypoint-sessions.js'));
let ok = 0, bad = 0;
const t = (c, m) => { if (c) ok++; else { bad++; console.log('FAIL', m); } };
const H = 3600e3, T0 = Date.UTC(2019, 5, 14, 9, 0, 0);
const iso = ms => new Date(ms).toISOString();

const gpx = `<?xml version="1.0"?><gpx version="1.1"><wpt lat="45.1234" lon="-100.5678"><ele>812.5</ele><time>${iso(T0)}</time><name>pit?</name><desc>small &amp; cold</desc><cmt>check later</cmt><sym>Cave</sym><type>lead</type><extensions><x:a>1</x:a></extensions></wpt>
<wpt lat="45.1240" lon="-100.5670"><time>${iso(T0 + 20 * 60e3)}</time><name>blowing hole</name></wpt>
<wpt lat="45.1250" lon="-100.5660"/>
<wpt lat="45.2" lon="-100.1"><time>${iso(T0 + 5 * H)}</time><name>dig 2</name><desc>dig</desc></wpt>
<wpt lat="45.2000" lon="-100.1000"><time>${iso(T0 + 5 * H + 3600e3 * 0.01)}</time><name>Dig  2</name><desc>other note</desc></wpt>
<wpt lat="45.30" lon="-100.0"><name>car</name></wpt>
<rte><rtept lat="1" lon="1"/></rte><trk><trkseg><trkpt lat="45.1" lon="-100.5"/></trkseg></trk></gpx>`;
let r = W.parse(gpx, 'a.gpx');
t(r.stats.format === 'gpx' && r.points.length === 6, 'gpx count ' + r.points.length);
const p0 = r.points[0];
t(p0.name === 'pit?' && p0.note === 'small & cold\ncheck later' && p0.ele === 812.5 && p0.sym === 'Cave' && p0.type === 'lead' && p0.ext === '<x:a>1</x:a>' && p0.time === T0, 'gpx fields');
t(r.points[2].time === null && r.points[2].name === '', 'gpx bare wpt');
t(r.stats.tracks === 1 && r.stats.routes === 1, 'tracks/routes counted');

const gj = JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'g1', geometry: { type: 'Point', coordinates: [-100.5678, 45.1234, 800] }, properties: { title: 'pit?', notes: 'cold air', time_created: iso(T0), icon: 'cave', extra: 5 } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-100.567, 45.124] }, properties: { name: 'car', time_created: Math.floor(T0 / 1000) + 60 } },
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} },
  { type: 'Feature', geometry: null, properties: {} }] });
r = W.parse(gj, 'a.geojson');
t(r.stats.format === 'geojson' && r.points.length === 2 && r.stats.tracks === 1 && r.stats.skipped === 1, 'geojson counts');
t(r.points[0].name === 'pit?' && r.points[0].note === 'cold air' && r.points[0].time === T0 && r.points[0].ele === 800 && r.points[0].sym === 'cave' && r.points[0].props.extra === 5 && r.points[0].src.id === 'g1', 'geojson fields');
t(r.points[1].time === Math.floor(T0 / 1000) * 1000 + 60000 && r.points[1].ele === null, 'geojson epoch seconds');

const kml = `<kml><Document><Placemark id="k1"><name>blowing hole</name><description><![CDATA[strong <b>draft</b>]]></description><TimeStamp><when>${iso(T0)}</when></TimeStamp>
<ExtendedData><Data name="icon"><value>cave</value></Data></ExtendedData><Point><coordinates>-100.5678,45.1234,810</coordinates></Point></Placemark>
<Placemark><name>trail</name><LineString><coordinates>1,1 2,2</coordinates></LineString></Placemark><Placemark><name>nothing</name></Placemark></Document></kml>`;
r = W.parse(kml, 'a.kml');
t(r.stats.format === 'kml' && r.points.length === 1 && r.points[0].note === 'strong <b>draft</b>' && r.points[0].ele === 810 && r.points[0].props.icon === 'cave' && r.points[0].time === T0 && r.points[0].src.id === 'k1', 'kml');
t(r.stats.tracks === 1 && r.stats.skipped === 1, 'kml counts');

// sessions
const mkp = (min, name) => ({ name: name || 'p', lon: -100.5678, lat: 45.1234, time: min == null ? null : T0 + min * 60e3, n: 1, notes: [], src: { id: 'x' + min, file: 'f' } });
const pts = [mkp(0), mkp(20), mkp(100), mkp(110), mkp(400), mkp(null), mkp(405), mkp(1500)];
const c = g => JSON.stringify(W.sessionsByGap(pts, g * H).map(x => x.count));
t(c(0.5) === '[2,2,2,1,1]', '0.5h ' + c(0.5));
t(c(2) === '[4,2,1,1]', '2h ' + c(2));
t(c(6) === '[6,1,1]', '6h ' + c(6));
const ss = W.sessionsByGap(pts, 2 * H);
t(ss[ss.length - 1].name.startsWith('No time') && ss[ss.length - 1].count === 1, 'no-time group last');
t(/^\d{4}-\d\d-\d\d \d\d:\d\d-\d\d:\d\d, 4 points$/.test(ss[0].name), 'name ' + ss[0].name);
t(W.sessionsByGap([mkp(0), mkp(13 * 60)], 24 * H)[0].long === true, '12 h flagged');
t(W.sessionsByGap([mkp(0), mkp(60)], 2 * H)[0].long === false, 'short not flagged');
t(W.sessionsByDay(pts).length >= 2, 'by day');

// area
const ring = [[-100.57, 45.12], [-100.56, 45.12], [-100.56, 45.13], [-100.57, 45.13]];
r = W.parse(gpx, 'a.gpx');
const inside = W.filterRing(r.points, ring);
t(inside.length === 3 && inside.every(p => p.lat < 45.13), 'area filter ' + inside.length);
t(W.filterRing(r.points, null).length === 6, 'no ring = all');

// duplicates
const dd = W.dedupe(r.points);
t(dd.length === 5, 'dedupe count ' + dd.length);
const dg = dd.find(p => /dig/i.test(p.name));
t(dg.n === 2 && dg.time === T0 + 5 * H && dg.notes.length === 2 && /2 waypoints/.test(dg.note), 'dedupe merged');
t(W.dedupe([mkp(0, 'a'), Object.assign(mkp(1, 'a'), { lat: 45.1235 })]).length === 2, 'far apart not merged');
t(W.dedupe([mkp(0, 'a'), mkp(1, 'b')]).length === 2, 'different names kept');

// 20 000 points
const parts = []; for (let i = 0; i < 20000; i++) parts.push(`<wpt lat="${(45 + (i % 200) * 0.0005).toFixed(5)}" lon="${(-100.6 + Math.floor(i / 200) * 0.0005).toFixed(5)}"><ele>${800 + i % 50}</ele><time>${iso(T0 + i * 7 * 60e3 + Math.floor(i / 50) * 3 * H)}</time><name>pt ${i}</name><desc>made up note ${i}</desc></wpt>`);
const big = '<gpx>' + parts.join('\n') + '</gpx>';
let t0 = Date.now(); r = W.parse(big, 'big.gpx'); const ms1 = Date.now() - t0;
t0 = Date.now(); const s2 = W.sessionsByGap(W.dedupe(W.filterRing(r.points, [[-100.6, 45], [-100.5, 45], [-100.5, 45.1], [-100.6, 45.1]])), 2 * H); const ms2 = Date.now() - t0;
t(r.points.length === 20000 && ms1 < 3000 && ms2 < 3000 && s2.length > 100, `20k: parse ${ms1} ms, rest ${ms2} ms, ${s2.length} sessions`);
W.parseAsync(big, 'big.gpx', () => {}).then(a => { t(a.points.length === 20000, 'async parse'); console.log(`waypoint-sessions: ${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0); });
