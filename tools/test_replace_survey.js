// Tests the plan behind "⟳ Replace survey file…" (flex.js): which stations a
// newer survey file adds, drops and moves, which stations the cave's placement
// (anchor, control points) would lose, the suggested stand-ins, and the
// placement rewritten for the new file. Pulls the real functions out of
// flex.js (and parsePLT from client/src/modules/compass-plt.js). Synthetic surveys only.
//
//   node tools/test_replace_survey.js
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'flex.js'), 'utf8');
const grab = name => {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}\\n'));
  if (!m) throw new Error(name + ' not found in flex.js');
  return m[0];
};
const jsonCopy = src.match(/const _jsonCopy = [^\n]+\n/)[0];
const { parsePLT } = require(path.join(__dirname, '..', 'client', 'src', 'modules', 'compass-plt.js'));
const api = new Function('parsePLT', jsonCopy + ['_caveFindStation', '_replaceSurveyPlan', '_replaceGeoref'].map(grab).join('\n') +
  '\nreturn { parsePLT, _caveFindStation, _replaceSurveyPlan, _replaceGeoref };')(parsePLT);

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };

// PLT text: stations [name, north ft, east ft, up ft]
const plt = (sts, extra = []) => ['NMAIN D 1 1 2026 CMain', ...sts.map(([n, N, E, V], k) =>
  `${k ? 'D' : 'M'} ${N.toFixed(2)} ${E.toFixed(2)} ${V.toFixed(2)} S${n} P 2 3 1 2 I 0.0`), ...extra].join('\n');
const old = api.parsePLT(plt([['A0', 0, 0, 0], ['A1', 10, 0, -1], ['A2', 20, 5, -2], ['A3', 30, 5, -3], ['A4', 40, 8, -3]]));

// 1) Same stations, one moved 2 ft, two added: nothing missing.
{
  const nw = api.parsePLT(plt([['A0', 0, 0, 0], ['A1', 10, 0, -1], ['A2', 22, 5, -2], ['A3', 30, 5, -3], ['A4', 40, 8, -3], ['A5', 50, 9, -4], ['A6', 60, 9, -5]]));
  const g = { mode: 'anchor', station: 'A0', lat: 1, lon: 2, elev: 3, controlPoints: [{ station: 'A4', lat: 1, lon: 2, elev: 3 }] };
  const p = api._replaceSurveyPlan(old, nw, g);
  ok('added A5, A6', p.added.join() === 'A5,A6', p.added);
  ok('nothing gone', p.removed.length === 0, p.removed);
  ok('A2 moved 2 ft', p.moved.length === 1 && p.moved[0].name === 'A2' && Math.abs(p.moved[0].d - 2 * 0.3048) < 1e-6, p.moved);
  ok('nothing missing', p.missing.length === 0, p.missing);
  const g2 = api._replaceGeoref(g, nw, []);
  ok('placement unchanged', JSON.stringify(g2) === JSON.stringify(g), g2);
}

// 2) The whole file shifted (re-closed from another origin) — anchor mode lines it up.
{
  const nw = api.parsePLT(plt([['A0', 100, 50, 10], ['A1', 110, 50, 9], ['A2', 120, 55, 8], ['A3', 130, 55, 7], ['A4', 140, 58, 7]]));
  const p = api._replaceSurveyPlan(old, nw, { mode: 'anchor', station: 'A0' });
  ok('shift alone is not a move (anchor mode)', p.moved.length === 0, p.moved);
  const pu = api._replaceSurveyPlan(old, nw, { mode: 'utm', zone: 14 });
  ok('…but is in UTM mode (absolute coordinates)', pu.moved.length === 5, pu.moved.length);
}

// 3) Renumbered: A0 → E0 (anchor) and A4 → E4 (control point), A3 dropped.
{
  const nw = api.parsePLT(plt([['E0', 0, 0, 0], ['A1', 10, 0, -1], ['A2', 20, 5, -2], ['E4', 40.5, 8, -3]]));
  const g = { mode: 'anchor', station: 'A0', lat: 1, lon: 2, elev: 3,
              controlPoints: [{ station: 'A4', lat: 1, lon: 2, elev: 3 }, { station: 'A3', lat: 4, lon: 5, elev: 6 }] };
  const p = api._replaceSurveyPlan(old, nw, g);
  ok('three missing (anchor, two CPs)', p.missing.length === 3, p.missing);
  const an = p.missing.find(m => m.role === 'anchor');
  ok('anchor A0 suggested as E0', an && an.name === 'A0' && an.suggestion === 'E0', an);
  const c4 = p.missing.find(m => m.name === 'A4');
  ok('CP A4 suggested as E4', c4 && c4.suggestion === 'E4', c4);
  ok('no placement without the anchor', api._replaceGeoref(g, nw, []) === null);
  const g2 = api._replaceGeoref(g, nw, [{ role: 'anchor', to: 'E0' }, { role: 'cp', index: 0, to: 'E4' }, { role: 'cp', index: 1, to: '' }]);
  ok('anchor renamed', g2 && g2.station === 'E0', g2);
  ok('CP renamed, empty one dropped', g2 && g2.controlPoints.length === 1 && g2.controlPoints[0].station === 'E4' && g2.controlPoints[0].lat === 1, g2);
  ok('original placement untouched', g.station === 'A0' && g.controlPoints.length === 2);
  const g3 = api._replaceGeoref(g, nw, [{ role: 'anchor', to: 'E0' }]);
  ok('Proceed: missing CPs dropped, none left → no controlPoints', g3 && !g3.controlPoints, g3);
  ok('re-pick to a name the file lacks → refused', api._replaceGeoref(g, nw, [{ role: 'anchor', to: 'ZZ9' }]) === null);
}

// 4) Survey-prefixed anchor names (the renderCaveSurveyAnchored rule).
{
  const nw = api.parsePLT(plt([['A0', 0, 0, 0], ['A1', 10, 0, -1]]));
  ok('prefixed anchor name found', !!api._caveFindStation(nw, 'MAIN.A0'));
  ok('missing station not found', !api._caveFindStation(nw, 'A9'));
}

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
