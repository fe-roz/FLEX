// Tests of survey-export.js — a cave's survey as Survex, CSV and Compass plot
// files — and the server route that writes them into the project folder
// (library.js surveyExport). Made-up survey: stations A1…, made-up numbers.
// The PLT goes back through FLEX's own parsePLT (client/src/modules/compass-plt.js).
//
//   node tools/test_survey_export.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexsx-'));
process.env.FLEX_LIBRARY_DIR = path.join(dir, 'library');
process.env.FLEX_PROJECTS_DIR = path.join(dir, 'projects');
const { parsePLT } = require(path.join(__dirname, '..', 'client', 'src', 'modules', 'compass-plt.js'));
const SE = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'survey-export.js'));
const lib = require(path.join(__dirname, '..', 'library.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const near = (a, b, t) => Math.abs(a - b) <= t;

// A made-up cave, positions in feet: a main line with LRUDs, a side survey
// tying in at A3, a plumbed shot, a surface shot, a "not drawn" shot, a
// comment with a comma, a station Survex can't take as it is, a FLEX lead.
const PLT = [
  'Z 0 0 0 0 0 0', 'SCAVE RIDGE', 'G14',
  'NA D 5 14 2024 C Main line',
  'M 0.00 0.00 0.00 SA1 P 2.00 3.00 1.00 2.50 I 0.00',
  'D 30.00 0.00 0.00 SA2 P 1.00 1.00 1.00 1.00 I 30.00',
  'D 60.00 0.00 -5.00 SA3 P 1.50 2.00 0.50 1.00 I 60.41',
  'D 60.00 0.00 -25.00 SA4 P 1.00 1.00 1.00 1.00 I 80.41',
  'D 90.00 10.00 -28.00 SA5 P 1.00 1.00 1.00 1.00 I 112.18 "wet, low"',
  'X 0 0 0 0 0 0',
  'NB D 6 2 2024 C Side passage',
  'M 60.00 0.00 -5.00 SA3',
  'D 60.00 30.00 -6.00 SB1 P 1.00 2.00 3.00 4.00 FL',
  'd 70.00 40.00 -6.00 SB1.x',
  'X 0 0 0 0 0 0',
  'NS D 6 2 2024 C Surface',
  'M 0.00 0.00 0.00 SA1',
  'D -20.00 -20.00 10.00 SS1 FS',
  'X 0 0 0 0 0 0',
  ';LEAD\tA5\t{"d":"Too tight","done":false}',
].join('\r\n');
const P = parsePLT(PLT);
const georef = { mode: 'anchor', station: 'A1', lat: 45.1234, lon: -100.5678, elev: 312.5, declination: 3.25 };
const segments = [{ date: '2024-05-14', team: 'Ann Example, Bob Example', shots: [['A1', 'A2'], ['A2', 'A3']] }, { team: 'Cy Example', shots: [['A3', 'B1']] }];
const files = SE.files(P, { name: 'Cave Ridge', georef, segments });
const by = Object.fromEntries(files.map(f => [f.name.split('.').pop(), f]));
ok('three files, named after the cave', files.map(f => f.name).join('|') === 'Cave Ridge.svx|Cave Ridge.csv|Cave Ridge.plt', files.map(f => f.name));
ok('one format only when asked', SE.files(P, { name: 'Cave Ridge' }, ['csv']).map(f => f.name).join() === 'Cave Ridge.csv');

// ── The model: shots from positions ─────────────────────────────────────────
const M = SE.model(P, { name: 'Cave Ridge', georef, segments });
const A = M.surveys.find(s => s.code === 'A'), B = M.surveys.find(s => s.code === 'B');
ok('surveys A, B, S in order', M.surveys.map(s => s.code).join() === 'A,B,S');
ok('A has 4 shots, B 2, S 1', A.shots.length === 4 && B.shots.length === 2 && M.surveys[2].shots.length === 1);
const s12 = A.shots[0];
ok('A1→A2: 30 ft north, level', s12.from === 'A1' && s12.to === 'A2' && near(s12.len, 30 * 0.3048, 1e-9) && near(s12.az, 0, 1e-9) && near(s12.inc, 0, 1e-9), s12);
const s45 = A.shots[3];
ok('A4→A5: azimuth and inclination worked out', near(s45.az, Math.atan2(10, 30) * 180 / Math.PI, 1e-9) && near(s45.inc, Math.atan2(-3, Math.hypot(30, 10)) * 180 / Math.PI, 1e-9), s45);
ok('plumbed shot A3→A4: no azimuth, straight down', A.shots[2].az == null && near(A.shots[2].inc, -90, 1e-9));
ok('date from the file, team from segments', A.date === '2024-05-14' && A.team.join('|') === 'Ann Example|Bob Example' && B.team.join() === 'Cy Example', [A.date, A.team, B.team]);

// ── Survex ─────────────────────────────────────────────────────────────────
const svx = by.svx.text, sl = svx.split('\n');
const cmd = l => l.replace(/;.*$/, '').trim();
let depth = 0, minDepth = 0;
sl.forEach(l => { const c = cmd(l).toLowerCase(); if (/^\*begin\b/.test(c)) depth++; if (/^\*end\b/.test(c)) { depth--; minDepth = Math.min(minDepth, depth); } });
ok('svx: *begin / *end balance', depth === 0 && minDepth === 0, depth);
ok('svx: a *begin per survey inside the cave', sl.filter(l => /^\*begin\b/.test(cmd(l))).length === 1 + 3);
ok('svx: units in the header and as *units', /Units: metres and degrees/.test(svx) && sl.includes('*units tape metres') && sl.includes('*units compass clino degrees'));
ok('svx: anchored station fixed by longitude, latitude, height', sl.includes('*cs long-lat') && sl.includes('*cs out UTM14N') && sl.includes('*fix A1 -100.5678000 45.1234000 312.500'), sl.filter(l => /^\*(cs|fix)/.test(l)));
ok('svx: declination stated', sl.includes('*declination 3.25 degrees'));
ok('svx: *date and *team', sl.includes('*date 2024.05.14') && sl.includes('*team "Ann Example"') && sl.includes('*team "Cy Example"'));
// Data lines: after "*data normal from to tape compass clino", 5 fields until the next command.
let mode = null; const legs = [], passages = [];
sl.forEach(l => {
  const c = cmd(l); if (!c) return;
  if (c[0] === '*') { mode = /^\*data normal from to tape compass clino$/i.test(c) ? 'normal' : /^\*data passage station left right up down$/i.test(c) ? 'passage' : /^\*data/i.test(c) ? 'other' : mode; return; }
  (mode === 'normal' ? legs : passages).push(c.split(/\s+/));
});
ok('svx: every leg has from to tape compass clino', legs.length === 7 && legs.every(f => f.length === 5 && /^\d+\.\d{3}$/.test(f[2]) && /^(-|\d+\.\d\d)$/.test(f[3]) && /^(up|down|-?\d+\.\d\d)$/.test(f[4])), legs);
ok('svx: plumbed leg written "-" and down', legs.some(f => f[0] === 'A3' && f[1] === 'A4' && f[3] === '-' && f[4] === 'down'));
ok('svx: station names Survex takes (B1.x → B1_x)', legs.every(f => /^[A-Za-z0-9_-]+$/.test(f[0]) && /^[A-Za-z0-9_-]+$/.test(f[1])) && legs.some(f => f[1] === 'B1_x') && /B1\.x → B1_x/.test(svx));
ok('svx: passage data has station + 4 sizes', passages.length >= 6 && passages.every(f => f.length === 5 && f.slice(1).every(x => /^\d+\.\d{3}$/.test(x))), passages);
ok('svx: LRUD in metres (A1 left 2 ft)', passages.some(f => f[0] === 'A1' && f[1] === '0.610' && f[2] === '0.762' && f[3] === '0.914' && f[4] === '0.305'), passages.find(f => f[0] === 'A1'));
ok('svx: surface and duplicate flags set and reset', /\*flags surface\nA1 S1[^\n]*\n\*flags not surface/.test(svx) && /\*flags duplicate\n[^\n]*B1 [^\n]*\n\*flags not duplicate/.test(svx), svx);
ok('svx: what is lost is said', /reduced shots/.test(svx) && /No splays/.test(svx) && /lead\(s\)/.test(svx) && /not drawn/.test(svx));
// Reduce the Survex legs again: the stations land where the file has them (relative to A1), within rounding.
{
  const pos = { A1: [0, 0, 0] }, file = {};
  P.stations.forEach(s => { if (!file[s.name]) file[s.name] = [s.e - P.stations[0].e, s.n - P.stations[0].n, s.v - P.stations[0].v]; });
  for (let k = 0; k < 3; k++) legs.forEach(([a, b, t, c, cl]) => {
    if (!pos[a] || pos[b]) return;
    const L = +t, inc = cl === 'up' ? 90 : cl === 'down' ? -90 : +cl, az = c === '-' ? 0 : +c;
    const h = L * Math.cos(inc * Math.PI / 180);
    pos[b] = [pos[a][0] + h * Math.sin(az * Math.PI / 180), pos[a][1] + h * Math.cos(az * Math.PI / 180), pos[a][2] + L * Math.sin(inc * Math.PI / 180)];
  });
  const worst = Object.keys(file).filter(n => pos[n] || pos[n.replace('.', '_')]).reduce((w, n) => { const p = pos[n] || pos[n.replace('.', '_')]; return Math.max(w, Math.hypot(p[0] - file[n][0], p[1] - file[n][1], p[2] - file[n][2])); }, 0);
  ok('svx: legs reduce back to the file\'s stations (within 5 mm)', Object.keys(pos).length === 8 && worst < 0.005, { worst, n: Object.keys(pos).length });
}

// ── CSV ────────────────────────────────────────────────────────────────────
const csvL = by.csv.text.split('\n').filter(Boolean);
const head = csvL.find(l => !l.startsWith('#'));
ok('csv: notes first (#), units stated', csvL[0].startsWith('# Cave Ridge') && /Units: metres and degrees/.test(by.csv.text));
ok('csv: header columns', head === 'survey,from,to,length_m,azimuth_deg,inclination_deg,left_m,right_m,up_m,down_m,date,flags,comment', head);
const parseCsv = l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const rows = csvL.slice(csvL.indexOf(head) + 1).map(parseCsv);
ok('csv: one row per shot, 13 columns each', rows.length === 7 && rows.every(r => r.length === 13), rows.map(r => r.length));
const r1 = rows[0];
ok('csv: first shot A1→A2 with A1\'s LRUD', r1.slice(0, 10).join() === 'A,A1,A2,9.144,0.00,0.00,0.610,0.762,0.914,0.305' && r1[10] === '2024-05-14', r1);
ok('csv: comment with a comma kept (quoted)', rows.some(r => r[2] === 'A5' && r[12] === 'wet, low'));
ok('csv: flags (L, d for not drawn, S)', rows.some(r => r[2] === 'B1' && r[11] === 'L') && rows.some(r => r[2] === 'B1.x' && r[11] === 'd') && rows.some(r => r[2] === 'S1' && r[11] === 'S'));
ok('csv: plumbed shot has no azimuth', rows.some(r => r[2] === 'A4' && r[4] === '' && r[5] === '-90.00'));

// ── PLT: back through FLEX's own parser ────────────────────────────────────
const Q = parsePLT(by.plt.text);
ok('plt: units stated in the header', /Units: positions and passage sizes \(LRUD\) in feet/.test(by.plt.text));
ok('plt: same surveys (code, description, date)', JSON.stringify(Q.surveys) === JSON.stringify(P.surveys), [Q.surveys, P.surveys]);
ok('plt: same UTM zone', Q.utmZone === P.utmZone && Q.utmSouth === P.utmSouth);
const flat = X => X.segments.map(g => g.points.map(p => [p.name, p.n, p.e, p.v, p.excluded, p.flags || '', p.comment || '', p.lrud ? [p.lrud.l, p.lrud.u, p.lrud.d, p.lrud.r] : null, p.dist == null ? null : p.dist]));
const fa = flat(P), fb = flat(Q);
let same = fa.length === fb.length;
fa.forEach((g, i) => g.forEach((p, j) => { const q = fb[i] && fb[i][j]; if (!q || q[0] !== p[0] || q[4] !== p[4] || q[5] !== p[5] || q[6] !== p[6] || !near(q[1], p[1], 0.002) || !near(q[2], p[2], 0.002) || !near(q[3], p[3], 0.002)
  || JSON.stringify(!!q[7]) !== JSON.stringify(!!p[7]) || (p[7] && p[7].some((x, k) => !near(x, q[7][k], 0.002))) || (p[8] != null && !near(p[8], q[8], 0.002))) same = false; }));
ok('plt: every point back (name, position, LRUD, distance, flags, comment, not drawn)', same, { fa, fb });
ok('plt: stations back', JSON.stringify(Q.stations.map(s => [s.name, s.survey, !!s.isSurface])) === JSON.stringify(P.stations.map(s => [s.name, s.survey, !!s.isSurface])));
ok('plt: the lead back', JSON.stringify(Q.leads) === JSON.stringify(P.leads), Q.leads);
ok('plt: and again: written twice, same text', SE.plt(SE.model(Q, { name: 'Cave Ridge', georef })) === by.plt.text);

// ── Not placed / placed by UTM ─────────────────────────────────────────────
{
  const t = SE.svx(SE.model(P, { name: 'Cave Ridge', georef: { mode: 'utm', zone: 14, south: false } })).split('\n');
  ok('svx (UTM): *cs UTM14N and the first station fixed at its file position', t.includes('*cs UTM14N') && t.includes('*fix A1 0.000 0.000 0.000') && !t.includes('*cs long-lat'));
  const u = SE.svx(SE.model(parsePLT(PLT.replace('G14\r\n', '')), { name: 'Cave Ridge', georef: null })).split('\n');
  ok('svx (not placed): no *cs, the first station fixed, said so', !u.some(l => /^\*cs/.test(l)) && u.includes('*fix A1 0.000 0.000 0.000') && u.some(l => /Not placed/.test(l)));
}

// ── The route: into <project folder>/Caves/<cave>/Survey/ ────────────────────
{
  lib.setProject('sx1', 'Ridge test');
  const pd = lib.projDir('sx1');
  const out = lib.surveyExport('sx1', 'Cave Ridge', files.map(f => ({ name: f.name, text: f.text })));
  const d = path.join(pd, 'Caves', 'Cave Ridge', 'Survey');
  ok('route: files written in Caves/<cave>/Survey/', out.ok && out.folder === 'Caves/Cave Ridge/Survey' && out.files.length === 3 && files.every(f => fs.readFileSync(path.join(d, f.name), 'utf8') === f.text), out);
  lib.surveyExport('sx1', 'Cave Ridge', [{ name: 'Cave Ridge.csv', text: 'again\n' }]);
  ok('route: written again replaces the file', fs.readFileSync(path.join(d, 'Cave Ridge.csv'), 'utf8') === 'again\n');
  const bad = (label, cave, fl, pid = 'sx1') => { let threw = false; try { lib.surveyExport(pid, cave, fl); } catch (_) { threw = true; } ok('route refuses ' + label, threw); };
  bad('.. in the cave', '../x', [{ name: 'a.svx', text: '' }]);
  bad('a / in the cave', 'a/b', [{ name: 'a.svx', text: '' }]);
  bad('.. in a file name', 'Cave Ridge', [{ name: '../a.svx', text: '' }]);
  bad('a \\ in a file name', 'Cave Ridge', [{ name: 'x\\a.svx', text: '' }]);
  bad('another kind of file', 'Cave Ridge', [{ name: 'a.js', text: '' }]);
  bad('no files', 'Cave Ridge', []);
  // A Caves folder that is a link out of the project.
  const out2 = path.join(dir, 'outside'); fs.mkdirSync(out2);
  lib.setProject('sx2', 'Linked');
  const pd2 = lib.projDir('sx2'); fs.symlinkSync(out2, path.join(pd2, 'Caves'));
  bad('a folder that leads out of the project', 'Cave Ridge', [{ name: 'a.svx', text: 'x' }], 'sx2');
  ok('…and wrote nothing there', fs.readdirSync(out2).length === 0, fs.readdirSync(out2));
  let threw = false; try { lib.surveyExport('nope', 'Cave Ridge', [{ name: 'a.svx', text: '' }]); } catch (_) { threw = true; }
  ok('route refuses a project with no folder', threw);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
