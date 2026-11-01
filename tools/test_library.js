// Tests of library.js — the project library files on the PC (the server side
// of project.js): numbering, merging sync-file entries, pages by hash,
// projects, settings, and the HTTP routes. Synthetic data, a temp folder.
//
//   node tools/test_library.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexlib-'));
process.env.FLEX_LIBRARY_DIR = path.join(dir, "library");
process.env.FLEX_PROJECTS_DIR = path.join(dir, "projects");
const L = process.env.FLEX_LIBRARY_DIR, PD = process.env.FLEX_PROJECTS_DIR;
const lib = require(path.join(__dirname, '..', 'library.js'));
const FL = require(path.join(__dirname, '..', 'viewer_build', 'libs', 'flexlib.js'));

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };
const lines = t => t.split('\n').filter(Boolean).map(JSON.parse);

(async () => {
  const dev = lib.device();
  ok('device id made once', /^pc[0-9a-f]{12}$/.test(dev) && lib.device() === dev);
  const sc = 'p-proj1';
  const e1 = lib.append(sc, { op: 'project.set', name: 'Cave Ridge area', who: 'Tester' });
  const e2 = lib.append(sc, { op: 'note.set', note: 'n1', target: 'station:c1:A4', text: 'hi', who: 'Tester', id: 'forged', seq: 99 });
  ok('numbered here: dev.seq from 1', e1.id === dev + '.1' && e2.id === dev + '.2' && e2.seq === 2 && e2.dev === dev, [e1.id, e2.id]);
  ok('own file only', fs.readdirSync(path.join(L, sc)).join() === `log-${dev}.jsonl`);
  let threw = false; try { lib.append('../x', { op: 'a' }); } catch (_) { threw = true; }
  ok('bad scope refused', threw);
  threw = false; try { lib.append(sc, { nope: 1 }); } catch (_) { threw = true; }
  ok('entry without op refused', threw);

  // Merge: a phone's entries, once; malformed ones skipped
  const ph = (seq, op, x) => Object.assign({ id: 'phoneA.' + seq, dev: 'phoneA', seq, t: '2026-10-25T10:00:0' + seq + 'Z', who: 'Ana', op }, x);
  const inc = [ph(1, 'note.set', { note: 'n2', target: 'station:c1:A5', text: 'drip' }), ph(2, 'lead.set', { lead: 'L1', target: 'station:c1:A5', fields: { status: 'open' } }),
               { id: 'bad.1', dev: 'other', seq: 1, op: 'x' }, ph(3, 'x', { id: 'phoneA.9' })];
  ok('merge adds 2 (two malformed skipped)', lib.merge(sc, inc) === 2);
  ok('merge again adds 0', lib.merge(sc, inc) === 0);
  ok('phone entries in the phone’s file', lines(fs.readFileSync(path.join(L, sc, 'log-phoneA.jsonl'), 'utf8')).length === 2);
  const all = lines(lib.read(sc));
  ok('read: every device', all.length === 4);
  const S = FL.replayProject(all, 'proj1');
  ok('replays', S.name === 'Cave Ridge area' && Object.keys(S.notes).length === 2 && S.leads.L1);
  // Our own entries coming back (restored from someone's sync file) don't break numbering
  ok('own entry again: known, skipped', lib.merge(sc, [e2]) === 0);
  const e3 = lib.append(sc, { op: 'note.set', note: 'n1', text: 'x' });
  ok('numbering continues', e3.seq === 3, e3.id);

  // Pages
  const png = crypto.randomBytes(5000);
  const b = lib.putBlob(png, 'png');
  ok('page by hash', b.h === crypto.createHash('sha256').update(png).digest('hex') && fs.existsSync(path.join(L, 'blobs', b.h + '.png')));
  ok('same page again: same file', lib.putBlob(png, 'png').h === b.h && fs.readdirSync(path.join(L, 'blobs')).length === 1);
  threw = false; try { lib.putBlob(png, 'png', '0'.repeat(64)); } catch (_) { threw = true; }
  ok('wrong hash refused', threw);
  threw = false; try { lib.putBlob(png, 'exe'); } catch (_) { threw = true; }
  ok('unknown type refused', threw);

  // Projects and settings
  lib.setProject('proj1', 'Cave Ridge area'); lib.setProject('proj1', '  '); lib.setProject('proj2', 'Other');
  ok('projects: rename keeps a blank name out; an old-library project keeps no folder, a new one gets one',
    JSON.stringify(lib.projects()) === JSON.stringify([{ id: 'proj1', name: 'Cave Ridge area' }, { id: 'proj2', name: 'Other', dir: 'projects/Other' }]), lib.projects());
  threw = false; try { lib.setProject('../p', 'x'); } catch (_) { threw = true; }
  ok('bad project id refused', threw);
  lib.kvSet('sync-sent|proj1', '{"a":1}');
  ok('settings', lib.kv()['sync-sent|proj1'] === '{"a":1}');

  // HTTP
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/lib/')) lib.handle(req, res, u.pathname.slice(9), Object.fromEntries(u.searchParams));
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/lib/`;
  const get = async (p, o) => { const r = await fetch(base + p, o); return { s: r.status, ct: r.headers.get('content-type'), body: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() }; };
  ok('GET device', (await get('device')).body.id === dev);
  ok('GET read', lines((await get('read?scope=' + sc)).body).length === 5);
  ok('GET read bad scope → 400', (await get('read?scope=..%2Fx')).s === 400);
  const ap = await get('append?scope=docs', { method: 'POST', body: JSON.stringify({ op: 'doc.add', doc: 'd1', pages: [{ h: b.h, ext: 'png' }], tags: ['project:proj1'] }) });
  ok('POST append → numbered entry', ap.body.id === dev + '.1' && ap.body.dev === dev, ap.body);
  ok('POST merge', (await get('merge?scope=docs', { method: 'POST', body: JSON.stringify([ph(1, 'doc.tag', { doc: 'd1', target: 'cave:c1' })]) })).body.added === 1);
  // Project numbers kept for the Projects list: in the project's .flex/ (a folder project), else in the settings.
  ok('GET stats: none yet', (await get('stats?project=proj2')).body === null);
  await get('stats?project=proj2', { method: 'POST', body: JSON.stringify({ v: 1, caves: { A: { length: 12 } }, footprint: [[1, 2]] }) });
  ok('POST stats → the project folder', (await get('stats?project=proj2')).body.caves.A.length === 12 && fs.existsSync(path.join(lib.projDir('proj2'), '.flex', 'stats.json')));
  await get('stats?project=proj1', { method: 'POST', body: JSON.stringify({ v: 1, caves: {} }) });
  ok('stats of a project with no folder → settings', (await get('stats?project=proj1')).body.v === 1 && !!lib.kv()['stats:proj1']);
  ok('stats: bad project id → not found', (await get('stats?project=..%2Fx')).s === 404);
  const bl = await get('blob?ext=jpg', { method: 'POST', body: Buffer.from('not really a jpeg') });
  ok('POST blob', HASH(bl.body.h) && bl.body.ext === 'jpg');
  const rb = await fetch(base + 'blob/' + bl.body.h + '.jpg');
  ok('GET blob: bytes and type', rb.status === 200 && rb.headers.get('content-type') === 'image/jpeg' && (await rb.text()) === 'not really a jpeg');
  ok('GET blob bad name → 404', (await get('blob/..%2Fdevice.json')).s === 404);
  const miss = await get('blobs-missing', { method: 'POST', body: JSON.stringify({ names: [bl.body.h + '.jpg', 'f'.repeat(64) + '.jpg', 'bad'] }) });
  ok('blobs-missing', JSON.stringify(miss.body.missing) === JSON.stringify(['f'.repeat(64) + '.jpg']), miss.body);
  ok('POST/GET kv', (await get('kv', { method: 'POST', body: JSON.stringify({ k: 'x', v: 'y' }) })).body.ok && (await get('kv?k=x')).body.v === 'y');
  ok('POST projects', (await get('projects', { method: 'POST', body: JSON.stringify({ id: 'proj3', name: 'Third' }) })).body.length === 3);
  ok('unknown route → 404', (await get('nope')).s === 404);
  // A sync file made from what the PC has selects the PC's and the phone's entries
  const P = FL.replayProject(lines(lib.read(sc)), 'proj1'), D = FL.replayDocs(lines(lib.read('docs')));
  const sel = FL.selectForSync(lines(lib.read(sc)), lines(lib.read('docs')), P, D, null, 'since');
  ok('sync selection: project + docs entries, the page', sel.entries[sc].length === 5 && sel.entries.docs.length === 2 && sel.blobs.join() === b.h + '.png', sel);

  // ── Project folders ───────────────────────────────────────────────────────
  lib.setProject('pf', 'Ridge: Area/1');
  const pf = path.join(PD, 'Ridge- Area-1');
  ok('folder: safe name, skeleton', fs.existsSync(path.join(pf, '.flex', 'project.json')) && fs.existsSync(path.join(pf, 'To sort')) && lib.projDir('pf') === pf, fs.readdirSync(PD));
  lib.setProject('pf2', 'Ridge: Area/1');
  ok('folder: same name → “(2)”', lib.projDir('pf2') === pf + ' (2)');
  const fe = lib.append('p-pf', { op: 'project.set', name: 'Ridge' });
  ok('folder: project entries in .flex/logs/project', fs.existsSync(path.join(pf, '.flex', 'logs', 'project', `log-${dev}.jsonl`)) && lines(lib.read('p-pf')).length === 1 && fe.seq === 1);
  const docSeqBefore = Math.max(...lines(lib.read('docs')).filter(e => e.dev === dev).map(e => e.seq));
  const de = lib.append('docs', { op: 'doc.add', doc: 'dF', pages: [], tags: ['project:pf'] }, 'pf');
  ok('folder: doc entries in its .flex/logs/docs; numbering continues across folders', fs.existsSync(path.join(pf, '.flex', 'logs', 'docs', `log-${dev}.jsonl`)) && de.seq === docSeqBefore + 1, [de.seq, docSeqBefore]);
  ok('docs read: every folder', lines(lib.read('docs')).some(e => e.id === de.id) && lines(lib.read('docs')).some(e => e.op === 'doc.tag'));
  ok('merge: an id known in another folder is not added again', lib.merge('docs', [ph(1, 'doc.tag', { doc: 'd1', target: 'cave:c1' })], 'pf') === 0);
  const jp = Buffer.from('page image'), pl = Buffer.from('survey file text');
  const r1 = lib.putBlob(jp, 'jpg', null, 'pf'), r2 = lib.putBlob(pl, 'plt', null, 'pf');
  ok('folder: page images → .flex/renders, others → .flex/blobs', fs.existsSync(path.join(pf, '.flex', 'renders', r1.h + '.jpg')) && fs.existsSync(path.join(pf, '.flex', 'blobs', r2.h + '.plt')));
  ok('blob found in its folder', lib.blobPath(r1.h + '.jpg') === path.join(pf, '.flex', 'renders', r1.h + '.jpg'));
  // A readable original, known by fingerprint in files.json
  const orig = Buffer.from('%PDF original'), oh = crypto.createHash('sha256').update(orig).digest('hex');
  fs.mkdirSync(path.join(pf, 'Caves', 'Ridge Cave'), { recursive: true }); fs.writeFileSync(path.join(pf, 'Caves', 'Ridge Cave', 'notes.pdf'), orig);
  const evil = 'e'.repeat(64) + '.pdf';
  fs.writeFileSync(path.join(pf, '.flex', 'files.json'), JSON.stringify({ [oh + '.pdf']: 'Caves/Ridge Cave/notes.pdf', [evil]: '../../library/device.json' }));
  lib.adoptFolder('pf', pf);                                    // (re-reads the index)
  ok('original by fingerprint', lib.blobPath(oh + '.pdf') === path.join(pf, 'Caves', 'Ridge Cave', 'notes.pdf'));
  ok('files.json can’t point outside its project', lib.blobPath(evil) === null);
  const ro = await fetch(base + 'blob/' + oh + '.pdf');
  ok('GET original: bytes and type', ro.status === 200 && ro.headers.get('content-type') === 'application/pdf' && (await ro.text()) === '%PDF original');
  const bm = await get('blobs-missing?project=pf2', { method: 'POST', body: JSON.stringify({ names: [r1.h + '.jpg'] }) });
  ok('blobs-missing for a project: pages of another project still count as missing there', JSON.stringify(bm.body.missing) === JSON.stringify([r1.h + '.jpg']), bm.body);
  await get('blob?ext=jpg&project=pf2', { method: 'POST', body: jp });
  ok('…and POST blob with ?project= puts a copy in that project', fs.existsSync(path.join(pf + ' (2)', '.flex', 'renders', r1.h + '.jpg')));
  const gp = await get('projects');
  ok('GET projects: folder shown', gp.body.find(p => p.id === 'pf').folder === pf && gp.body.find(p => p.id === 'proj1').folder === null, gp.body);
  const mr = await get('merge?scope=docs&project=pf', { method: 'POST', body: JSON.stringify([ph(5, 'doc.tag', { doc: 'dF', target: 'cave:x' })]) });
  ok('POST merge ?project= → into that folder', mr.body.added === 1 && fs.existsSync(path.join(pf, '.flex', 'logs', 'docs', 'log-phoneA.jsonl')));
  srv.close();

  // ── Migration: old library → folders; copies, checks, switches; old library untouched ──
  const M = fs.mkdtempSync(path.join(os.tmpdir(), 'flexmig-'));
  const ML = path.join(M, 'user_files', 'library'), MP = path.join(M, 'user_files', 'projects'), AR = path.join(M, 'archive');
  fs.mkdirSync(path.join(ML, 'p-mm'), { recursive: true }); fs.mkdirSync(path.join(ML, 'docs')); fs.mkdirSync(path.join(ML, 'blobs')); fs.mkdirSync(path.join(ML, 'p-vv'));
  const H = b => crypto.createHash('sha256').update(b).digest('hex');
  const pg1 = Buffer.from('page one'), pg2 = Buffer.from('page two'), plt = Buffer.from('Z 0 0\n'), og = Buffer.from('original scan');
  [[pg1, 'jpg'], [pg2, 'jpg'], [plt, 'plt']].forEach(([b, x]) => fs.writeFileSync(path.join(ML, 'blobs', H(b) + '.' + x), b));
  fs.mkdirSync(path.join(AR, 'Caves', 'Big Cave', 'Big Cave - A Entrance'), { recursive: true });
  fs.writeFileSync(path.join(AR, 'Caves', 'Big Cave', 'Big Cave - A Entrance', 'A notes.pdf'), og);
  const E = (dev, seq, op, x) => JSON.stringify(Object.assign({ id: dev + '.' + seq, dev, seq, t: '2026-10-2' + seq + 'T00:00:00Z', who: 't', op }, x));
  fs.writeFileSync(path.join(ML, 'projects.json'), JSON.stringify([{ id: 'mm', name: 'Marble Mountains (KMCTF)' }, { id: 'vv', name: 'Volcano' }]));
  fs.writeFileSync(path.join(ML, 'device.json'), JSON.stringify({ id: 'pcTEST' }));
  fs.writeFileSync(path.join(ML, 'p-mm', 'log-ai.jsonl'), [E('ai', 1, 'project.set', { name: 'Marble Mountains (KMCTF)' }), E('ai', 2, 'cave.set', { cave: 'big', name: 'Big Cave' }), E('ai', 3, 'note.set', { note: 'n1', target: 'station:big:A1', text: 'x' })].join('\n') + '\n');
  fs.writeFileSync(path.join(ML, 'p-mm', 'log-pcTEST.jsonl'), E('pcTEST', 2, 'cavefile.set', { file: 'VALLEY', h: H(plt), ext: 'plt', removed: false }) + '\n');
  fs.writeFileSync(path.join(ML, 'p-vv', 'log-pcTEST.jsonl'), E('pcTEST', 1, 'layer.set', { layer: 'L', kind: 'caltopo', url: 'x' }) + '\n');
  fs.writeFileSync(path.join(ML, 'docs', 'log-ai.jsonl'), [E('ai', 1, 'doc.add', { doc: 'D1', title: 'A notes', desc: 'From the KMCTF archive: Caves/Big Cave/Big Cave - A Entrance/A notes.pdf', pages: [{ h: H(pg1), ext: 'jpg' }, { h: H(pg2), ext: 'jpg' }], tags: ['cave:big'] }),
    E('ai', 2, 'doc.add', { doc: 'D2', title: 'loose', pages: [], tags: ['cave:nowhere'] })].join('\n') + '\n');
  fs.writeFileSync(path.join(ML, 'docs', 'log-pcTEST.jsonl'), E('pcTEST', 5, 'doc.rotate', { doc: 'D1', h: H(pg1), rot: 90, prev: 0 }) + '\n');
  const snap = d => fs.readdirSync(d, { recursive: true }).sort().map(n => { const f = path.join(d, n); return fs.statSync(f).isFile() ? n + ':' + H(fs.readFileSync(f)) : n; }).join('|');
  const before = snap(ML);
  const { execFileSync } = require('child_process');
  const run = a => { try { return { out: execFileSync(process.execPath, [path.join(__dirname, 'migrate_to_project_folders.js'), ...a], { env: Object.assign({}, process.env, { FLEX_LIBRARY_DIR: ML, FLEX_PROJECTS_DIR: MP }), encoding: 'utf8', stdio: 'pipe' }), code: 0 }; } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; } };
  const dry = run([]);
  ok('migration dry run: writes nothing', dry.code === 0 && !fs.existsSync(MP) && snap(ML) === before, dry.out);
  const go = run(['--go', '--originals', AR]);
  const mmDir = path.join(MP, 'Marble Mountains (KMCTF)');
  const reg = JSON.parse(fs.readFileSync(path.join(ML, 'projects.json'), 'utf8'));
  ok('migration: both projects switched to folders', go.code === 0 && reg.every(p => p.dir), go.out);
  const MIG = JSON.parse(fs.readFileSync(path.join(mmDir, '.flex', fs.readdirSync(path.join(mmDir, '.flex')).find(n => n.startsWith('migration-'))), 'utf8'));
  ok('migration: checked ok, counts', MIG.ok && MIG.entries === 4 && MIG.docEntries === 2 && MIG.renders === 2 && MIG.blobs === 1 && MIG.originals === 1, MIG);
  ok('migration: survey file readable in Survey data/', fs.readFileSync(path.join(mmDir, 'Survey data', 'VALLEY.plt')).equals(plt));
  ok('migration: original copied at its archive path, unchanged', fs.readFileSync(path.join(mmDir, 'Caves', 'Big Cave', 'Big Cave - A Entrance', 'A notes.pdf')).equals(og));
  ok('migration: page images in .flex/renders', fs.readFileSync(path.join(mmDir, '.flex', 'renders', H(pg1) + '.jpg')).equals(pg1));
  const dl = fs.readFileSync(path.join(mmDir, '.flex', 'logs', 'docs', 'log-pcTEST.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok('migration: doc.file recorded by this PC, numbered after its old entries', dl.length === 2 && dl[1].op === 'doc.file' && dl[1].seq === 6 && dl[1].file.h === H(og) && dl[1].file.path === 'Caves/Big Cave/Big Cave - A Entrance/A notes.pdf', dl);
  ok('migration: a document in no project → docs-unassigned', fs.readFileSync(path.join(ML, 'docs-unassigned', 'log-ai.jsonl'), 'utf8').includes('"D2"'));
  ok('migration: the old library is untouched (except the projects list and its dated copy)', snap(ML).split('|').filter(x => !/^(projects|docs-unassigned)/.test(x)).join('|') === before.split('|').filter(x => !/^projects/.test(x)).join('|'));
  ok('migration: run again → nothing to do', /Nothing to migrate/.test(run(['--go']).out));
  fs.rmSync(M, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
function HASH(h) { return /^[0-9a-f]{64}$/.test(h || ''); }
