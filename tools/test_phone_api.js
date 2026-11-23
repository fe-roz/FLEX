// "Send to phone" (phone_api.js) against a fake adb (tools/fake_adb.js: it records its arguments and answers like the
// real one, a folder standing in for the phone). No phone, no network.
//   * where adb is looked for, on Windows, macOS and Linux;
//   * every status: no adb, no device, unauthorized, two phones (choose), ready with model / Android / app version,
//     app not installed;
//   * the exports that can be sent: only zips of the exports folder, by id; a running export is refused; no paths;
//   * sending: straight into the app (its socket), into its inbox folder (the app says it can read it), an app that
//     cannot read its inbox or an old build (moved to Download), a refused push (Download), no app (Download),
//     everything refused (an error that says so); progress; cancel; one at a time; the Jobs list.
//
//   node tools/test_phone_api.js
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const phoneApi = require('../phone_api');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + (typeof i === 'string' ? i : JSON.stringify(i)).slice(0, 700) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
const FAKE = path.join(__dirname, 'fake_adb.js');

// ── 1. finding adb ──────────────────────────────────────────────────────────
{
  const F = phoneApi.findAdb, has = set => p => set.includes(p);
  let r = F({ FLEX_ADB: 'D:\\tools\\adb.exe', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', has(['D:\\tools\\adb.exe', 'C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe']), 'C:\\Users\\me');
  ok('FLEX_ADB wins', r.adb === 'D:\\tools\\adb.exe', r);
  r = F({ FLEX_ADB: 'D:\\gone\\adb.exe', ANDROID_HOME: 'E:\\sdk', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', has(['E:\\sdk\\platform-tools\\adb.exe']), 'C:\\Users\\me');
  ok('a FLEX_ADB that is not there is passed over; then ANDROID_HOME', r.adb === 'E:\\sdk\\platform-tools\\adb.exe' && r.looked[0] === 'D:\\gone\\adb.exe', r);
  r = F({ ANDROID_SDK_ROOT: '/sdk' }, 'linux', has(['/sdk/platform-tools/adb']), '/home/me');
  ok('ANDROID_SDK_ROOT', r.adb === '/sdk/platform-tools/adb');
  r = F({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', has(['C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe']), 'C:\\Users\\me');
  ok('Windows: the usual place under %LOCALAPPDATA%', r.adb === 'C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe', r);
  r = F({}, 'darwin', has(['/Users/me/Library/Android/sdk/platform-tools/adb']), '/Users/me');
  ok('macOS: ~/Library/Android/sdk', r.adb === '/Users/me/Library/Android/sdk/platform-tools/adb', r);
  r = F({}, 'linux', has(['/home/me/Android/Sdk/platform-tools/adb']), '/home/me');
  ok('Linux: ~/Android/Sdk', r.adb === '/home/me/Android/Sdk/platform-tools/adb', r);
  r = F({ PATH: '/usr/bin:/opt/pt' }, 'linux', has(['/opt/pt/adb']), '/home/me');
  ok('then PATH', r.adb === '/opt/pt/adb', r);
  r = F({ Path: 'C:\\a;C:\\pt' }, 'win32', has(['C:\\pt\\adb.exe']), 'C:\\Users\\me');
  ok('PATH on Windows (adb.exe, ; between folders)', r.adb === 'C:\\pt\\adb.exe', r);
  r = F({ FLEX_ADB: 'off', ANDROID_HOME: '/sdk' }, 'linux', () => true, '/home/me');
  ok('FLEX_ADB=off: no adb is looked for at all', r.adb === null && r.looked.join() === 'FLEX_ADB=off', r);
  r = F({ PATH: '/usr/bin' }, 'linux', () => false, '/home/me');
  ok('nowhere: null, and the places looked in', r.adb === null && r.looked.length >= 3 && r.looked.includes('PATH'), r);
  const D = phoneApi.parseDevices('List of devices attached\nABC123\tdevice usb:1-1 product:shiba model:Pixel_8 device:shiba transport_id:3\nXYZ\tunauthorized usb:1-2 transport_id:4\nemulator-5554\toffline\n\n');
  ok('adb devices -l is read: serial, state, model', D.length === 3 && D[0].serial === 'ABC123' && D[0].state === 'device' && D[0].model === 'Pixel 8' && D[1].state === 'unauthorized' && D[2].state === 'offline', D);
  ok('the name on the phone: safe characters only, always .zip', phoneApi.phoneName('FLEX-Cave Ridge (2).zip') === 'FLEX-Cave-Ridge-2.zip' && phoneApi.phoneName('../../etc/passwd') === 'etc-passwd.zip' && phoneApi.phoneName('; rm -rf /') === 'rm-rf.zip' && phoneApi.phoneName('') === 'FLEX-map.zip',
     [phoneApi.phoneName('../../etc/passwd'), phoneApi.phoneName('; rm -rf /')]);
}

// ── a "phone", an exports folder, an api ────────────────────────────────────
let n = 0;
function world(state, jobsIn) {
  const dir = path.join(tmp, 'w' + (++n)), root = path.join(dir, 'phone'), exportsDir = path.join(dir, 'exports');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(exportsDir, { recursive: true });
  const st = Object.assign({ root, log: path.join(dir, 'adb.log'), devices: [{ serial: 'ABC123', state: 'device', model: 'Pixel 8' }], android: '15', app: { installed: true, version: '2.1', socket: true, reads: true } }, state);
  const sf = path.join(dir, 'state.json'); fs.writeFileSync(sf, JSON.stringify(st));
  process.env.FAKE_ADB_STATE = sf;                     // read by the fake adb, which inherits this process's environment
  const zip = Buffer.alloc(300000, 7); zip.write('PK\u0003\u0004', 0, 'latin1');
  fs.writeFileSync(path.join(exportsDir, 'export_abc123.zip'), zip);
  fs.writeFileSync(path.join(exportsDir, 'export_abc123.json'), JSON.stringify({ name: 'Cave Ridge', filename: 'FLEX-Cave-Ridge.zip' }));
  const exportJobs = jobsIn || {};
  const api = phoneApi({ exportsDir, exportJobs, env: { FLEX_ADB: FAKE }, waits: { cmd: 8000, appSeen: 1500, appPoll: 150, start: 50, direct: 1500 } });
  const calls = () => { try { return fs.readFileSync(st.log, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch (_) { return []; } };
  const set = patch => fs.writeFileSync(sf, JSON.stringify(Object.assign(st, patch)));
  const at = remote => path.join(root, remote.replace(/^\/+/, ''));
  const wait = async id => { for (let k = 0; k < 400 && api.jobs[id].status === 'running'; k++) await sleep(25); return api.jobs[id]; };
  const send = async (body = { export: 'abc123' }) => { const r = await api.start(body); return r.code === 200 ? wait(r.body.jobId) : r; };
  return { api, st, set, calls, at, zip, exportsDir, exportJobs, send, wait, dir };
}
const DL = '/sdcard/Download/FLEX-Cave-Ridge.zip', IN = phoneApi.INBOX + '/FLEX-Cave-Ridge.zip';

(async () => {
  // ── 2. status ─────────────────────────────────────────────────────────────
  let w = world({});
  let s = await w.api.status();
  ok('ready: serial, model, Android, FLEX Field and its version', s.state === 'ready' && s.serial === 'ABC123' && s.model === 'Pixel 8' && s.android === '15' && s.app.installed && s.app.version === '2.1', s);
  ok('adb is called with an argument array, the serial as its own argument', w.calls().some(c => c.args && c.args.join(' ') === '-s ABC123 shell dumpsys package com.feroz.flexfield'), w.calls());
  s = await world({ devices: [] }).api.status();
  ok('no device: says to plug it in and switch USB debugging on', s.state === 'no-device' && /USB debugging/.test(s.hint), s);
  s = await world({ devices: [{ serial: 'ABC123', state: 'unauthorized' }] }).api.status();
  ok('unauthorized: says to accept the prompt on the phone', s.state === 'unauthorized' && /Allow/.test(s.hint), s);
  s = await world({ devices: [{ serial: 'ABC123', state: 'offline' }] }).api.status();
  ok('offline: not ready, says to plug it in again', s.state === 'no-device' && /offline/.test(s.hint), s);
  w = world({ devices: [{ serial: 'ABC123', state: 'device', model: 'Pixel 8' }, { serial: 'DEF456', state: 'device', model: 'Pixel 6a' }, { serial: 'GHI', state: 'unauthorized' }] });
  s = await w.api.status();
  ok('two phones ready: choose, with the list', s.state === 'choose' && s.devices.length === 3 && s.devices[1].model === 'Pixel 6a', s);
  s = await w.api.status('DEF456');
  ok('…and the chosen one', s.state === 'ready' && s.serial === 'DEF456' && s.model === 'Pixel 6a', s);
  s = await w.api.status('NOPE');
  ok('a serial that is not plugged in', s.state === 'choose' && /not plugged in/.test(s.hint), s);
  s = await world({ app: { installed: false } }).api.status();
  ok('FLEX Field not installed: ready, and says where the zip will go', s.state === 'ready' && s.app.installed === false && s.app.version === '' && /Download/.test(s.hint), s);
  s = await phoneApi({ exportsDir: w.exportsDir, env: { PATH: '/nowhere' }, waits: {} }).status();
  const real = phoneApi.findAdb({ PATH: '/nowhere' });
  ok('no adb anywhere: says so and where it looked (unless this machine has an SDK in a usual place)', real.adb ? s.state !== 'no-adb' : s.state === 'no-adb' && s.looked.length > 0 && /Android SDK/.test(s.hint), s);
  s = await phoneApi({ exportsDir: w.exportsDir, env: { FLEX_ADB: path.join(tmp, 'not-there'), PATH: '' }, waits: {} }).status();
  ok('a FLEX_ADB that does not exist does not stop the search', s.state === 'no-adb' || !!real.adb, s.state);
  s = await world({ adbBroken: true }).api.status();
  ok('an adb that fails: no device, not a crash', s.state === 'no-device', s);

  // ── 3. the exports that can be sent ───────────────────────────────────────
  w = world({}, { run1: { status: 'running', name: 'Still going', filename: 'FLEX-Still.zip' }, bad1: { status: 'error', name: 'Broke' }, done1: { status: 'done', name: 'Sink Valley', filename: 'FLEX-Sink-Valley.zip' } });
  for (const id of ['run1', 'bad1', 'done1']) fs.writeFileSync(path.join(w.exportsDir, `export_${id}.zip`), 'PK..');
  fs.writeFileSync(path.join(w.exportsDir, 'export_old9.zip'), 'PK..'); fs.writeFileSync(path.join(w.exportsDir, 'notes.zip'), 'PK..'); fs.writeFileSync(path.join(w.exportsDir, 'export_empty1.zip'), '');
  fs.utimesSync(path.join(w.exportsDir, 'export_old9.zip'), new Date('2026-01-02T03:04:00Z'), new Date('2026-01-02T03:04:00Z'));
  const L = w.api.listExports();
  ok('listed: finished exports of the folder, newest first; not the running, failed or empty one, not other zips', L.map(e => e.id).sort().join() === 'abc123,done1,old9' && L[L.length - 1].id === 'old9', L);
  ok('names: the job\'s, the one kept beside the zip, else the date', L.find(e => e.id === 'done1').name === 'Sink Valley' && L.find(e => e.id === 'abc123').name === 'Cave Ridge' && L.find(e => e.id === 'abc123').file === 'FLEX-Cave-Ridge.zip' && L.find(e => e.id === 'old9').name === 'Export of 2026-01-02 03:04', L);
  ok('no path leaves the server', !JSON.stringify(L).includes(w.exportsDir));
  let r = await w.api.start({ export: 'run1' });
  ok('an export that is still running cannot be sent', r.code === 409 && /still running/.test(r.body.error), r);
  r = await w.api.start({ export: 'bad1' });
  ok('nor one that failed', r.code === 409, r);
  for (const bad of ['../abc123', 'abc123/../../x', '..', '/etc/passwd', 'abc123.zip', 'abc 123', '', null, 'nope1', { a: 1 }]) {
    r = await w.api.start({ export: bad });
    ok('refused: ' + JSON.stringify(bad), r.code === 404 && !w.calls().some(c => c.args && c.args.includes('push')), r);
  }
  fs.symlinkSync('/etc', path.join(w.exportsDir, 'export_link1.zip'));
  ok('a folder (or a link to one) named like an export is not an export', w.api.exportInfo('link1') === null);
  r = await w.api.start({ export: 'abc123', serial: 'x; rm -rf /' });
  ok('a serial with anything odd in it is refused', r.code === 400, r);
  r = await world({ devices: [] }).api.start({ export: 'abc123' });
  ok('no phone: not started, the hint comes back', r.code === 409 && r.body.state === 'no-device' && /USB debugging/.test(r.body.error), r);

  // ── 4. sending ────────────────────────────────────────────────────────────
  // straight into the app
  w = world({});
  let j = await w.send();
  ok('direct: done, and it says the map is in FLEX Field', j.status === 'done' && j.how === 'direct' && /is in FLEX Field on the Pixel 8: tap Import/.test(j.result.message) && j.result.file === 'FLEX-Cave-Ridge.zip', j);
  const got = path.join(w.st.root, 'app_private/inbox/FLEX-Cave-Ridge.zip');
  ok('the app has the whole file, byte for byte', fs.existsSync(got) && fs.readFileSync(got).equals(w.zip));
  let c = w.calls().filter(x => x.args).map(x => x.args.join(' '));
  ok('adb: the app is started, a forward to its socket is made and removed, nothing is pushed', c.some(x => /shell am start -n com\.feroz\.flexfield\/com\.feroz\.flexviewer\.MainActivity$/.test(x)) && c.some(x => /^-s ABC123 forward tcp:0 localabstract:flexfield_inbox$/.test(x))
     && c.some(x => /forward --remove tcp:\d+/.test(x)) && !c.some(x => / push /.test(x)), c);
  ok('progress reached the end; the job has left its process', w.api.pctOf(j) === 100 && j.proc === null && j.ended >= j.started);
  // the app refuses (no room)
  w = world({ app: { installed: true, version: '2.1', socket: true, socketRefuse: true, reads: true } });
  j = await w.send();
  ok('the app refuses the stream: the inbox folder is used, the app reads it', j.status === 'done' && j.how === 'inbox' && /waiting in FLEX Field/.test(j.result.message) && fs.readFileSync(w.at(IN)).equals(w.zip) && j.progress.some(l => /refused the file: not enough room/.test(l)), j.progress);
  // an app without the socket (or a phone that does not let adb reach it), inbox readable
  w = world({ app: { installed: true, version: '2.1', socket: false, reads: true } });
  j = await w.send();
  ok('no socket: pushed into the app\'s inbox, the app says it can read it', j.status === 'done' && j.how === 'inbox' && fs.readFileSync(w.at(IN)).equals(w.zip) && !fs.existsSync(w.at(DL)), [j.how, j.progress]);
  c = w.calls().filter(x => x.args).map(x => x.args.join(' '));
  ok('adb push with local and remote as separate arguments; the app is brought to the front after', c.some(x => x === `-s ABC123 push ${path.join(w.exportsDir, 'export_abc123.zip')} ${IN}`) && c.lastIndexOf(c.find(x => / am start /.test(x))) >= 0 && c.slice(c.findIndex(x => / push /.test(x))).some(x => / am start /.test(x)), c);
  // the app sees the file but cannot read it
  w = world({ app: { installed: true, version: '2.1', socket: false, reads: false } });
  j = await w.send();
  ok('the app cannot read its inbox on this phone: moved to Download, and it says to open it there', j.status === 'done' && j.how === 'download' && fs.existsSync(w.at(DL)) && !fs.existsSync(w.at(IN)) && /Download folder as FLEX-Cave-Ridge\.zip: open it there and choose FLEX Field/.test(j.result.message) && !j.result.rebuild, j.result);
  // an old build that does not look at its inbox
  w = world({ app: { installed: true, version: '2.0', socket: false, reads: 'never' } });
  j = await w.send();
  ok('an old build of the app: moved to Download, and it says to rebuild once', j.status === 'done' && j.how === 'download' && fs.existsSync(w.at(DL)) && !fs.existsSync(w.at(IN)) && j.result.rebuild === true && /Rebuild FLEX Field once/.test(j.result.message), j.result);
  // the push into the app's folder is refused
  w = world({ app: { installed: true, version: '2.1', socket: false, reads: true }, inboxRefuse: true });
  j = await w.send();
  ok('a refused push falls back to Download', j.status === 'done' && j.how === 'download' && fs.readFileSync(w.at(DL)).equals(w.zip) && j.progress.some(l => /could not be written \(.*Permission denied/.test(l)), j.progress);
  // no app
  w = world({ app: { installed: false } });
  j = await w.send();
  c = w.calls().filter(x => x.args).map(x => x.args.join(' '));
  ok('FLEX Field not installed: straight to Download, no start of the app, and it says to install it', j.status === 'done' && j.how === 'download' && fs.existsSync(w.at(DL)) && /Install FLEX Field/.test(j.result.message) && !c.some(x => / am start /.test(x)) && !c.some(x => /forward/.test(x)), [j.result, c]);
  // nothing works
  w = world({ app: { installed: true, version: '2.1', socket: false, reads: true }, inboxRefuse: true, downloadRefuse: true });
  j = await w.send();
  ok('everything refused: an error that says the phone refused the file', j.status === 'error' && /refused the file \(.*Permission denied/.test(j.error) && j.how === null, j);
  // the chosen phone of two
  w = world({ devices: [{ serial: 'ABC123', state: 'device', model: 'Pixel 8' }, { serial: 'DEF456', state: 'device', model: 'Pixel 6a' }] });
  r = await w.api.start({ export: 'abc123' });
  ok('two phones and none chosen: not started, the list comes back', r.code === 409 && r.body.state === 'choose' && r.body.devices.length === 2, r);
  j = await w.send({ export: 'abc123', serial: 'DEF456' });
  ok('…chosen: sent to that one only', j.status === 'done' && /Pixel 6a/.test(j.result.message) && w.calls().filter(x => x.args && x.args[0] === '-s').every(x => x.args[1] === 'DEF456'));

  // progress and cancel during a push
  w = world({ app: { installed: false }, pushMs: 3000 });
  r = await w.api.start({ export: 'abc123' });
  await sleep(900);
  j = w.api.jobs[r.body.jobId];
  const mid = w.api.pctOf(j);
  ok('progress follows adb push\'s percent lines', j.status === 'running' && mid > 10 && mid < 95, mid);
  const r2 = await w.api.start({ export: 'abc123' });
  ok('one at a time', r2.code === 409 && /already being sent/.test(r2.body.error), r2);
  j.cancelled = true; j.proc.kill();                    // what /api/jobs/<id>/cancel does
  j = await w.wait(r.body.jobId);
  ok('cancel: the job ends as cancelled, the half file is removed from the phone', j.status === 'error' && j.error === 'Cancelled' && !fs.existsSync(w.at(DL)) && w.calls().some(x => x.args && x.args.join(' ') === `-s ABC123 shell rm -f ${DL}`), [j.error, fs.existsSync(w.at(DL))]);
  // cancel during a direct stream
  w = world({});
  fs.writeFileSync(path.join(w.exportsDir, 'export_big1.zip'), Buffer.alloc(60 * 1024 * 1024, 1));
  r = await w.api.start({ export: 'big1' });
  for (let k = 0; k < 200 && !(w.api.jobs[r.body.jobId].pct > 6); k++) await sleep(10);
  j = w.api.jobs[r.body.jobId]; j.cancelled = true; if (j.proc) j.proc.kill();
  j = await w.wait(r.body.jobId);
  await sleep(200);
  ok('cancel while streaming into the app: cancelled, nothing pushed anywhere else, no half file kept by the app', j.error === 'Cancelled' && !w.calls().some(x => x.args && x.args.includes('push'))
     && !(fs.existsSync(path.join(w.st.root, 'app_private/inbox')) && fs.readdirSync(path.join(w.st.root, 'app_private/inbox')).length), [j.status, j.error]);

  // ── 5. over HTTP, and in the Jobs list ────────────────────────────────────
  w = world({});
  const jobs = require('../jobs_api')({ sources: { phone: { jobs: w.api.jobs, pct: w.api.pctOf } } });
  const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/phone/')) return w.api.handle(req, res, u.pathname.slice('/api/phone/'.length), Object.fromEntries(u.searchParams));
    if (!jobs.handle(req, res, u.pathname.slice('/api/jobs'.length).replace(/^\//, ''))) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const get = async p => (await fetch(base + p)).json(), post = async (p, b) => { const x = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof b === 'string' ? b : JSON.stringify(b) }); return { code: x.status, body: await x.json() }; };
  s = await get('/api/phone/status');
  ok('GET /api/phone/status', s.ok && s.state === 'ready' && s.model === 'Pixel 8', s);
  s = await get('/api/phone/status?serial=' + encodeURIComponent('a b;c'));
  ok('…an odd serial in the query is ignored', s.state === 'ready' && s.serial === 'ABC123', s);
  s = await get('/api/phone/exports');
  ok('GET /api/phone/exports', s.ok && s.exports.length === 1 && s.exports[0].id === 'abc123' && s.exports[0].bytes === 300000, s);
  r = await post('/api/phone/send', '{ not json');
  ok('POST /api/phone/send with junk: 400', r.code === 400, r);
  r = await post('/api/phone/send', { export: '../../etc/passwd' });
  ok('…with a path: 404', r.code === 404, r);
  r = await post('/api/phone/send', { export: 'abc123' });
  ok('…with an export: a job id', r.code === 200 && r.body.ok && /^[a-z0-9]+$/.test(r.body.jobId), r);
  await w.wait(r.body.jobId);
  s = await get('/api/phone/job/' + r.body.jobId);
  ok('GET /api/phone/job/<id>: done, how, the message', s.status === 'done' && s.how === 'direct' && s.pct === 100 && /tap Import/.test(s.result.message), s);
  s = await get('/api/jobs');
  const row = s.jobs.find(x => x.id === 'phone.' + r.body.jobId);
  ok('the Jobs list has it: "To phone: Cave Ridge", done, 100 %', row && row.kind === 'phone' && row.name === 'To phone: Cave Ridge' && row.status === 'done' && row.progress === 100 && /tap Import/.test(row.message), row);
  r = await post('/api/jobs/phone.' + r.body.jobId + '/cancel', {});
  ok('a finished send cannot be cancelled', r.code === 409, r);
  ok('unknown routes: 404', (await fetch(base + '/api/phone/nope')).status === 404 && (await fetch(base + '/api/phone/job/zz')).status === 404);
  srv.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
