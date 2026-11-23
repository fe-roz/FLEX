// test_lidar_quality.js — the LiDAR quality card's rows (client/src/modules/lidar-quality.js, pure half) and the
// export's few numbers (export_about.lidar_quality), from the report ridgewalk.py makes on its made-up scene.
//   node tools/test_lidar_quality.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const Q = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'lidar-quality.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i) : '')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-'));
const env = Object.assign({}, process.env), extra = path.join(os.homedir(), 'opt/pylibs'); if (fs.existsSync(extra)) env.PYTHONPATH = extra + (env.PYTHONPATH ? ':' + env.PYTHONPATH : '');
execFileSync('python3', [path.join(__dirname, '..', 'ridgewalk.py'), '--demo', tmp, '--no-shapes', '--tile', '48', '--blank-tile', '0', '0'], { stdio: 'ignore', env });
const q = JSON.parse(fs.readFileSync(path.join(tmp, 'quality.json')));
const R = Q.rows(q), get = (list, k) => (list.find(r => r[0] === k) || [])[1];

ok('the verdicts are the report\'s sentences, in order', R.verdicts.length === q.verdicts.length && /^5 flight passes cover the area\.$/.test(R.verdicts[0]) && R.verdicts.some(t => /Flight pass 9 shows patterned noise/.test(t)), R.verdicts);
ok('the blank tile is said, with the share no pass covers', R.verdicts.some(t => /^1 of 12 tiles could not be read and are blank\.$/.test(t)) && R.verdicts.some(t => /covered by no pass/.test(t)), R.verdicts);
ok('passes: one row each, the flagged one with its blocks and what it lost', R.passes.length === 5 && R.passes.filter(p => p.flagged).length === 1 && R.passes[4].id === 9 && /^\d+ \/ \d+$/.test(R.passes[4].blocks) && +R.passes[4].setAside.replace(/,/g, '') > 0 && R.passes[0].blocks === '' && R.passes[0].setAside === '', R.passes);
ok('no scan angles in this cloud: no column', R.angles === false && R.passes.every(p => p.angle === ''));
ok('the cloud: no name and no date are said as such, never made up', get(R.cloud, 'Dataset') === 'not named' && /^unknown \(the time of the returns was not read\)$/.test(get(R.cloud, 'Flown')), R.cloud);
ok('returns with their density; classes with shares', /^[\d,]+ · \d+\.\d per m²$/.test(get(R.cloud, 'Returns')) && /ground \d+(\.\d)? %/.test(get(R.cloud, 'Classes')), R.cloud);
ok('coverage rows: by 3 or more, 2, 1, none; ground within 1 m and 3 m; the largest patch', ['Seen by 3 or more passes', 'Seen by 2 passes', 'Seen by 1 pass only', 'Seen by no pass', 'No ground return within 1 m', 'No ground return within 3 m'].every(k => / %$/.test(get(R.coverage, k)))
  && / m²$/.test(get(R.coverage, 'Largest patch with no ground return')) && /^typically \d+ \(least 0, most 5\)$/.test(get(R.coverage, 'Passes over a spot')), R.coverage);
ok('reading: tiles, blank ones with their box', get(R.reading, 'Tiles') === '12' && get(R.reading, 'Left blank') === '1' && R.blank.length === 1 && /^tile 0 \/ 0: /.test(R.blank[0]), [R.reading, R.blank]);
ok('a blank tile with a place is given as two corners (lat, lon)', /^45\.12340, -100\.56780 to 45\.12420, -100\.56680: no answer$/.test(Q.rows({ reading: { blank: [{ lonlat: [-100.5678, 45.1234, -100.5668, 45.1242], why: 'no answer' }] } }).blank[0]));
ok('tiles not read in this run: blank ones are "not known", not 0', /^not known/.test(get(Q.rows({ reading: { tiles: 4, read_in_this_run: false, left_blank: 0 } }).reading, 'Left blank')));
ok('shares: one decimal; a small one is not rounded to nothing', Q.pct(0.0312) === '3.1 %' && Q.pct(0) === '0 %' && Q.pct(0.0002) === 'under 0.1 %' && Q.pct(1) === '100 %' && Q.pct(undefined) === '?');
ok('big numbers and areas read plainly', Q.big(219633332) === '219.6 million' && Q.big(1200) === '1,200' && Q.area(3512833) === '3.51 km²' && Q.area(881.3) === '881 m²');
let threw = null; try { Q.rows(null); Q.rows({ passes: [{}], coverage: 'x', reading: 5 }); } catch (e) { threw = e; }
ok('no report, or junk: no error', !threw, threw && threw.stack);

// the export's few numbers
const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..'))})
import export_about
q = json.load(open(${JSON.stringify(path.join(tmp, 'quality.json'))}))
a = export_about.about('.', 100, 100, 10000, False, 'ridge', 0.3, quality=q, now=0)
q2 = dict(q, reading=dict(q['reading'], read_in_this_run=False)); q2['cloud'] = dict(q['cloud'], dates=['2019-10-22', '2019-10-26'])
print(json.dumps([export_about.lidar_quality(q), export_about.lidar_quality(None), export_about.lidar_quality({'coverage': 3}), a.get('quality'), export_about.lidar_quality(q2),
                  'quality' in export_about.about('.', 100, 100, 10000, False, 'ridge', 0.3, now=0)]))`;
const [e1, e2, e3, e4, e5, e6] = JSON.parse(execFileSync('python3', ['-c', py], { env }).toString());
ok('export: passes, the flagged pass, shares, tiles blank', e1.passes === 5 && e1.flagged.join() === '9' && e1.set_aside > 0 && e1.single_pass === q.coverage.passes_1 && e1.ground_not_seen === q.coverage.no_ground_within_3m && e1.tiles === 12 && e1.tiles_blank === 1 && !('dates' in e1), e1);
ok('export: no report or junk = nothing', Object.keys(e2).length === 0 && Object.keys(e3).length === 0 && e6 === false);
ok('export: it is in meta.about', JSON.stringify(e4) === JSON.stringify(e1));
ok('export: tiles not read in this run = blank not known; dates carried when the report has them', e5.tiles_blank === null && e5.dates.join() === '2019-10-22,2019-10-26', e5);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`test_lidar_quality: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
