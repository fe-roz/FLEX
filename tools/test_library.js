// Tests of library.js — the project library files on the PC (the server side
// of project.js): numbering, merging sync-file entries, pages by hash,
// projects, settings, and the HTTP routes. Synthetic data, a temp folder.
//
//   node tools/test_library.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexlib-'));
process.env.FLEX_LIBRARY_DIR = dir;
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
  ok('own file only', fs.readdirSync(path.join(dir, sc)).join() === `log-${dev}.jsonl`);
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
  ok('phone entries in the phone’s file', lines(fs.readFileSync(path.join(dir, sc, 'log-phoneA.jsonl'), 'utf8')).length === 2);
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
  ok('page by hash', b.h === crypto.createHash('sha256').update(png).digest('hex') && fs.existsSync(path.join(dir, 'blobs', b.h + '.png')));
  ok('same page again: same file', lib.putBlob(png, 'png').h === b.h && fs.readdirSync(path.join(dir, 'blobs')).length === 1);
  threw = false; try { lib.putBlob(png, 'png', '0'.repeat(64)); } catch (_) { threw = true; }
  ok('wrong hash refused', threw);
  threw = false; try { lib.putBlob(png, 'exe'); } catch (_) { threw = true; }
  ok('unknown type refused', threw);

  // Projects and settings
  lib.setProject('proj1', 'Cave Ridge area'); lib.setProject('proj1', '  '); lib.setProject('proj2', 'Other');
  ok('projects: rename keeps a blank name out', JSON.stringify(lib.projects()) === JSON.stringify([{ id: 'proj1', name: 'Cave Ridge area' }, { id: 'proj2', name: 'Other' }]));
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
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
function HASH(h) { return /^[0-9a-f]{64}$/.test(h || ''); }
