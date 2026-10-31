// Tests of mine.js — My data (the old Recent list moved into a private
// project folder). Synthetic data in a temp folder.
//
//   node tools/test_mine.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'flexmine-'));
const UF = path.join(T, 'user_files');
process.env.FLEX_LIBRARY_DIR = path.join(UF, 'library');
process.env.FLEX_PROJECTS_DIR = path.join(UF, 'projects');
let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };

// The old files: three recent caves (one without a cached text), a set, and a cached survey not in the list.
fs.mkdirSync(path.join(UF, 'plt_cache'), { recursive: true });
const plt = n => `Z 0 0 0 0 0 0\r\nSCAVE ${n}\r\nNA D 1 1 2000 C\r\nM 0 0 0 SA1 P 1 1 1 1\r\nD 1 0 0 SA2 P 1 1 1 1\r\nX 0 0 0 0 0 0\r\n`;
fs.writeFileSync(path.join(UF, 'plt_cache', 'Ridge Cave.plt'), plt('Ridge'));
fs.writeFileSync(path.join(UF, 'plt_cache', "Gillock's Cave.plt"), plt('Gillock'));
fs.writeFileSync(path.join(UF, 'plt_cache', 'Old One.plt'), plt('Old'));
fs.utimesSync(path.join(UF, 'plt_cache', 'Old One.plt'), new Date('2025-05-01'), new Date('2025-05-01'));   // an older file
const recentsOld = {
  ept: [{ url: 'https://example.org/ept.json', name: 'Cloud A', lastUsed: '2026-10-01T00:00:00.000Z' }],
  plt: [{ name: 'Ridge Cave', georef: { mode: 'anchor', station: 'A1', lat: 45.1, lon: -100.5, elev: 1400 }, displayOptions: { surveyColors: { A: '#ff0000' } }, lastUsed: '2026-10-30T00:00:00.000Z' },
        { name: "Gillock's Cave", georef: { mode: 'utm', zone: 16, south: false }, displayOptions: null, lastUsed: '2026-10-20T00:00:00.000Z' },
        { name: 'Lost Text', georef: null, displayOptions: null, lastUsed: '2026-10-10T00:00:00.000Z' }],
  pltSets: [{ name: 'KY', savedAt: '2026-10-11T07:37:21.117Z', caves: [{ name: "Gillock's Cave", georef: { mode: 'utm', zone: 16, south: false } }] }],
};
fs.writeFileSync(path.join(UF, 'recents.json'), JSON.stringify(recentsOld));
const snapOld = () => fs.readFileSync(path.join(UF, 'recents.json'), 'utf8') + fs.readdirSync(path.join(UF, 'plt_cache')).join('|');
const before = snapOld();

const lib = require(path.join(__dirname, '..', 'library.js'));
const mine = require(path.join(__dirname, '..', 'mine.js'));

(async () => {
  // Before moving in, the old routes answer (handlers return false)
  const fakeRes = () => ({ h: null, b: '', writeHead(s) { this.s = s; }, end(b) { this.b = b || ''; } });
  ok('before: not handled (old files answer)', (await mine.handleRecents({ method: 'GET' }, fakeRes())) === false && !mine.exists());

  const dry = mine.migrate({ go: false });
  ok('dry run: plan, nothing written', dry.plan.caves.length === 4 && dry.plan.missingText.join() === 'Lost Text' && !fs.existsSync(path.join(UF, 'mine')), dry.plan);
  const m = mine.migrate({ go: true });
  ok('migration: no problems', m.done && m.problems.length === 0, m.problems);
  ok('My data folder', fs.existsSync(path.join(UF, 'mine', '.flex', 'project.json')) && fs.readFileSync(path.join(UF, 'mine', 'Survey data', 'Ridge Cave.plt'), 'utf8') === plt('Ridge'));
  ok('private: not in the project list', lib.projects().find(p => p.id === 'mine').private === true);
  const r = mine.recents();
  ok('Recent list from My data: 3 caves with text (incl. the cache-only one), newest first', r.plt.map(p => p.name).join('|') === "Ridge Cave|Gillock's Cave|Old One", r.plt.map(p => p.name));
  ok('placement and style kept', JSON.stringify(r.plt[0].georef) === JSON.stringify(recentsOld.plt[0].georef) && JSON.stringify(r.plt[0].displayOptions) === JSON.stringify(recentsOld.plt[0].displayOptions));
  ok('cave set kept as a group', r.pltSets.length === 1 && r.pltSets[0].name === 'KY' && JSON.stringify(r.pltSets[0].caves) === JSON.stringify(recentsOld.pltSets[0].caves));
  ok('point cloud link kept', r.ept.length === 1 && r.ept[0].url === recentsOld.ept[0].url);
  ok("survey text by the cave's own name (Gillock's)", mine.surveyText("Gillock's Cave") === plt('Gillock'));
  ok('old files untouched', snapOld() === before);
  ok('migrate again: refused', mine.migrate({ go: true }).done === false);

  // The page keeps using /api/recents and /api/plt-cache
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/recents') { if (!(await mine.handleRecents(req, res))) { res.writeHead(500); res.end('old'); } }
    else if (u.pathname === '/api/plt-cache') { if (!(await mine.handlePltCache(req, res, Object.fromEntries(u.searchParams)))) { res.writeHead(500); res.end('old'); } }
    else if (u.pathname.startsWith('/api/lib/')) lib.handle(req, res, u.pathname.slice(9), Object.fromEntries(u.searchParams));
  });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const J = async (p, o) => (await fetch(base + p, o)).json();
  const post = (p, b) => J(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const g = await J('/api/recents');
  ok('GET /api/recents', g.plt.length === 3 && g.pltSets.length === 1);
  // Load a new cave: text first, then the list (as flex.js does)
  ok('POST plt-cache: new cave', (await post('/api/plt-cache', { name: 'New Cave', text: plt('New') })).ok);
  const list = [{ name: 'New Cave', georef: { mode: 'anchor', station: 'A1', lat: 1, lon: 2, elev: 3 }, displayOptions: null, lastUsed: '2026-10-31T10:00:00.000Z' }].concat(g.plt);
  ok('POST /api/recents: one change recorded', (await post('/api/recents', Object.assign({}, g, { plt: list }))).recorded === 1);
  ok('same list again: nothing recorded', (await post('/api/recents', Object.assign({}, g, { plt: list }))).recorded === 0);
  ok('GET plt-cache: from My data', (await (await fetch(base + '/api/plt-cache?name=New%20Cave')).text()) === plt('New'));
  // Re-place a cave; forget one (× in the list)
  list[1] = Object.assign({}, list[1], { georef: Object.assign({}, list[1].georef, { lat: 45.2 }) });
  const without = list.filter(p => p.name !== 'Old One');
  await post('/api/recents', Object.assign({}, g, { plt: without }));
  const g2 = await J('/api/recents');
  ok('re-placed and forgotten', g2.plt.find(p => p.name === 'Ridge Cave').georef.lat === 45.2 && !g2.plt.some(p => p.name === 'Old One'), g2.plt.map(p => p.name));
  ok('forgotten cave: still in history, its file kept', fs.existsSync(path.join(UF, 'mine', 'Survey data', 'Old One.plt')));
  // No 12-cave limit any more (that was the page's; My data keeps them all)
  ok('more than 12 caves', (await post('/api/recents', Object.assign({}, g2, { plt: g2.plt.concat(Array.from({ length: 12 }, (_, i) => ({ name: 'C' + i, georef: null, displayOptions: null, lastUsed: '2026-01-01T00:00:00.000Z' }))) }))).recorded === 12);
  // A new version of a survey file: readable copy updated, old one to the attic
  await post('/api/plt-cache', { name: 'Ridge Cave', text: plt('Ridge v2') });
  ok('new version: readable copy updated, old version in .flex/attic', fs.readFileSync(path.join(UF, 'mine', 'Survey data', 'Ridge Cave.plt'), 'utf8') === plt('Ridge v2')
    && fs.readdirSync(path.join(UF, 'mine', '.flex', 'attic')).some(n => n.startsWith('Ridge Cave.')));
  ok('GET /api/lib/projects: My data not listed', !(await J('/api/lib/projects')).some(p => p.id === 'mine'));
  srv.close();
  fs.rmSync(T, { recursive: true, force: true });
  console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
