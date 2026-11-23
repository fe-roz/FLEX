// phone_api.js — "Send to phone": an export zip from this PC to FLEX Field on the phone plugged in by USB.
//
// Everything goes through adb (Android's own USB tool, part of the SDK's platform-tools): no network, and FLEX Field
// keeps having no INTERNET permission. adb is run with an argument array, never a shell string; the browser names an
// export by its id, never by a path, and only zips of the exports folder can be sent.
//
//   GET  /api/phone/status[?serial=S]   { ok, state, ... }   state:
//          'no-adb'        adb was not found (where it was looked for is in `looked`)
//          'no-device'     adb runs, nothing is plugged in (or USB debugging is off)
//          'unauthorized'  a phone is there but has not accepted this PC: accept the prompt on the phone
//          'choose'        more than one phone is ready: `devices` lists them, ask again with ?serial=
//          'ready'         { serial, model, android, app: { installed, version } }
//   GET  /api/phone/exports             the zips that can be sent, newest first: [{ id, name, file, bytes, time }]
//   POST /api/phone/send { export, serial? }   → { ok, jobId }; the job is in the Jobs list as phone.<jobId>
//   GET  /api/phone/job/<jobId>         { status, pct, message, how, result, error }
//
// How a zip reaches the app, tried in this order; each step is confirmed by the other side or the next is taken:
//   1 'direct'    FLEX Field is started and listens on a local socket of its own (no permission needed: it is not a
//                 network socket); `adb forward` connects this PC to it and the zip is streamed in. The app answers
//                 when it has the whole file: certain.
//   2 'inbox'     `adb push` into the app's own folder on the shared storage (Android/data/<app>/files/inbox). The
//                 app says in a small file there whether it could read what arrived; if it does not say so in time
//                 (an older build of the app, or a phone that keeps the pushed file from the app) the zip is moved to
//   3 'download'  the phone's Download folder, where adb can always write: open it there with FLEX Field.
// With FLEX Field not installed only 3 is done. Afterwards FLEX Field is brought to the front.
//
// Env: FLEX_ADB (the adb to use), ANDROID_HOME / ANDROID_SDK_ROOT. Tests: tools/test_phone_api.js (a fake adb).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');

const PKG = 'com.feroz.flexfield';
const ACTIVITY = PKG + '/com.feroz.flexviewer.MainActivity';
const SOCKET = 'flexfield_inbox';                     // MainActivity's LocalServerSocket
const INBOX = '/sdcard/Android/data/' + PKG + '/files/inbox';
const STATUS_FILE = '/sdcard/Android/data/' + PKG + '/files/inbox_status.json';
const DOWNLOAD = '/sdcard/Download';
const EXPORT_ID = /^[A-Za-z0-9]{4,24}$/;
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;

/** Where adb is: FLEX_ADB, the SDK the environment names, the SDK's usual place on this system, then PATH.
 *  → { adb: path|null, looked: [places] }. `exists` and `platform` are parameters for the tests. */
function findAdb(env = process.env, platform = process.platform, exists = fs.existsSync, home = os.homedir()) {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb', P = platform === 'win32' ? path.win32 : path.posix;
  const looked = [];
  const tryOne = p => { if (!p) return null; looked.push(p); return exists(p) ? p : null; };
  if (env.FLEX_ADB) { const p = tryOne(env.FLEX_ADB); if (p) return { adb: p, looked }; }
  for (const k of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) if (env[k]) { const p = tryOne(P.join(env[k], 'platform-tools', exe)); if (p) return { adb: p, looked }; }
  const usual = platform === 'win32' ? [env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, 'Android', 'Sdk'), P.join(home, 'AppData', 'Local', 'Android', 'Sdk')]
    : platform === 'darwin' ? [P.join(home, 'Library', 'Android', 'sdk')]
    : [P.join(home, 'Android', 'Sdk'), P.join(home, 'opt', 'android-sdk'), '/opt/android-sdk', '/usr/lib/android-sdk'];
  for (const sdk of usual) { const p = tryOne(sdk && P.join(sdk, 'platform-tools', exe)); if (p) return { adb: p, looked }; }
  for (const dir of String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) { if (!dir) continue; const p = P.join(dir, exe); if (exists(p)) { looked.push(p); return { adb: p, looked }; } }
  looked.push('PATH');
  return { adb: null, looked };
}

/** `adb devices -l` → [{ serial, state, model }] */
function parseDevices(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const m = /^(\S+)\s+(device|unauthorized|offline|no permissions|authorizing|recovery|sideload|bootloader)\b(.*)$/.exec(line.trim());
    if (!m || /^List of devices/.test(line)) return;
    const model = (/\bmodel:(\S+)/.exec(m[3]) || [])[1];
    out.push({ serial: m[1], state: m[2], model: model ? model.replace(/_/g, ' ') : '' });
  });
  return out;
}
/** The name the zip gets on the phone: letters, digits, dot, dash and underscore only, always .zip. */
function phoneName(name) {
  const base = String(name || '').replace(/\.zip$/i, '').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return (base || 'FLEX-map') + '.zip';
}

module.exports = function phoneApi({ exportsDir, exportJobs = {}, env = process.env, waits = {} }) {
  const W = Object.assign({ cmd: 15000, appSeen: 12000, appPoll: 1000, start: 1200, direct: 4000 }, waits);
  const jobs = {};
  const json = (res, d, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(d)); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // adb with an argument array; → { code, out } (stdout + stderr). Never rejects.
  const run = (adb, args, ms = W.cmd) => new Promise(resolve => {
    execFile(adb, args, { timeout: ms, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') + String(stderr || ''), failed: err && typeof err.code !== 'number' ? String(err.code || err.message) : null });
    });
  });
  const on = (serial, ...a) => ['-s', serial, ...a];

  async function status(want) {
    const f = findAdb(env);
    if (!f.adb) return { ok: true, state: 'no-adb', looked: f.looked, hint: 'adb was not found. It comes with the Android SDK (platform-tools); set FLEX_ADB to its path if it is somewhere else.' };
    const d = await run(f.adb, ['devices', '-l']);
    if (d.failed === 'ENOENT' || d.failed === 'EACCES') return { ok: true, state: 'no-adb', looked: f.looked, hint: 'adb could not be started (' + d.failed + ').' };
    const all = parseDevices(d.out), ready = all.filter(x => x.state === 'device');
    const base = { ok: true, adb: f.adb, devices: all };
    if (!all.length) return Object.assign(base, { state: 'no-device', hint: 'No phone found. Plug it in by USB, unlock it, and switch USB debugging on (Settings, Developer options).' });
    if (!ready.length) {
      const un = all.some(x => x.state === 'unauthorized' || x.state === 'authorizing');
      return Object.assign(base, { state: un ? 'unauthorized' : 'no-device', hint: un ? 'The phone is asking "Allow USB debugging?": unlock it and tap Allow (tick "Always allow from this computer").'
        : 'The phone is there but not ready (' + all.map(x => x.state).join(', ') + '). Unplug it and plug it in again.' });
    }
    let dev = want ? ready.find(x => x.serial === want) : null;
    if (want && !dev) return Object.assign(base, { state: ready.length > 1 ? 'choose' : 'no-device', hint: 'That phone is not plugged in any more.' });
    if (!dev && ready.length > 1) return Object.assign(base, { state: 'choose', hint: 'More than one phone is plugged in: choose one.' });
    dev = dev || ready[0];
    const [rel, pk] = await Promise.all([run(f.adb, on(dev.serial, 'shell', 'getprop', 'ro.build.version.release')), run(f.adb, on(dev.serial, 'shell', 'dumpsys', 'package', PKG))]);
    const version = (/versionName=(\S+)/.exec(pk.out) || [])[1] || '';
    const installed = pk.code === 0 && new RegExp('Package \\[' + PKG.replace(/\./g, '\\.') + '\\]').test(pk.out);
    return Object.assign(base, { state: 'ready', serial: dev.serial, model: dev.model || dev.serial, android: rel.code === 0 ? rel.out.trim().split(/\s/)[0] : '',
      app: { installed, version: installed ? version : '' },
      hint: installed ? '' : 'FLEX Field is not installed on this phone: the zip will go to its Download folder.' });
  }

  // ── The exports that can be sent ────────────────────────────────────────────
  function exportInfo(id) {
    if (!EXPORT_ID.test(String(id || ''))) return null;
    const file = path.join(exportsDir, `export_${id}.zip`);
    if (path.dirname(path.resolve(file)) !== path.resolve(exportsDir)) return null;
    let st; try { st = fs.statSync(file); } catch (_) { return null; }
    if (!st.isFile()) return null;
    const job = Object.prototype.hasOwnProperty.call(exportJobs, id) ? exportJobs[id] : null;
    let side = null; try { side = JSON.parse(fs.readFileSync(path.join(exportsDir, `export_${id}.json`), 'utf8')); } catch (_) {}
    const name = (job && job.name) || (side && side.name) || '';
    return { id, path: file, bytes: st.size, time: Math.round(st.mtimeMs), name: name || 'Export of ' + new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
      file: phoneName((job && job.filename) || (side && side.filename) || 'FLEX-map-' + id), running: !!(job && job.status === 'running'), failed: !!(job && job.status === 'error') };
  }
  function listExports() {
    let names = []; try { names = fs.readdirSync(exportsDir); } catch (_) {}
    return names.map(n => (/^export_([A-Za-z0-9]{4,24})\.zip$/.exec(n) || [])[1]).filter(Boolean).map(exportInfo)
      .filter(e => e && !e.running && !e.failed && e.bytes > 0).sort((a, b) => b.time - a.time)
      .map(e => ({ id: e.id, name: e.name, file: e.file, bytes: e.bytes, time: e.time }));
  }

  // ── Sending ─────────────────────────────────────────────────────────────────
  const say = (job, line) => { job.progress.push(line); };
  const cancelled = job => { if (job.cancelled) { const e = new Error('Cancelled'); e.cancel = true; throw e; } };

  // 1. straight into the app through its local socket
  async function sendDirect(adb, serial, exp, job) {
    const fw = await run(adb, on(serial, 'forward', 'tcp:0', 'localabstract:' + SOCKET));
    const port = +(/(\d{2,5})/.exec(fw.out) || [])[1];
    if (fw.code !== 0 || !port) return { ok: false, why: 'no connection to the app (' + (fw.out.trim().split('\n')[0] || 'adb forward failed') + ')' };
    const unforward = () => run(adb, on(serial, 'forward', '--remove', 'tcp:' + port));
    try {
      return await new Promise(resolve => {
        const sock = net.connect({ host: '127.0.0.1', port });
        let stage = 'hello', buf = '', sent = 0, done = false, rs = null;
        const finish = r => { if (done) return; done = true; clearTimeout(timer); try { if (rs) rs.destroy(); } catch (_) {} try { sock.destroy(); } catch (_) {} job.proc = null; resolve(r); };
        let timer = setTimeout(() => finish({ ok: false, why: 'the app did not answer' }), W.direct);
        job.proc = { kill() { finish({ ok: false, cancelled: true }); } };
        sock.on('error', e => finish({ ok: false, why: stage === 'hello' ? 'the app is not listening' : 'the connection broke (' + e.code + ')', partial: stage !== 'hello' }));
        sock.on('close', () => finish({ ok: false, why: stage === 'hello' ? 'the app is not listening' : 'the connection closed before the app had the file', partial: stage !== 'hello' }));
        sock.on('connect', () => sock.write('PING\n'));
        sock.on('data', d => {
          buf += d.toString('latin1');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (stage === 'hello') {
              if (!/^FLEXFIELD \d+/.test(line)) return finish({ ok: false, why: 'something else answered' });
              stage = 'offer'; sock.write(`SEND ${exp.bytes} ${exp.file}\n`);
            } else if (stage === 'offer') {
              if (line !== 'READY') return finish({ ok: false, why: 'the app refused the file: ' + line.replace(/^ERR\s*/, ''), refused: true });
              stage = 'data'; clearTimeout(timer);
              say(job, 'Sending straight into FLEX Field…');
              rs = fs.createReadStream(exp.path, { highWaterMark: 256 * 1024 });
              rs.on('data', chunk => { sent += chunk.length; job.pct = 5 + Math.round(90 * sent / Math.max(1, exp.bytes)); if (!sock.write(chunk)) { rs.pause(); sock.once('drain', () => rs.resume()); } });
              rs.on('error', e => finish({ ok: false, why: 'the zip could not be read (' + e.code + ')', fatal: true }));
              rs.on('end', () => { stage = 'ack'; timer = setTimeout(() => finish({ ok: false, why: 'the app did not confirm the file', partial: true }), Math.max(W.direct, 20000)); });
            } else if (stage === 'ack' || stage === 'data') {
              if (line === 'OK') return finish({ ok: true });
              return finish({ ok: false, why: 'the app could not keep the file: ' + line.replace(/^ERR\s*/, ''), partial: true });
            }
          }
        });
      });
    } finally { unforward(); }
  }

  // adb push with its percent lines → { ok, out }
  function push(adb, serial, local, remote, job, lo, hi) {
    return new Promise(resolve => {
      const p = spawn(adb, on(serial, 'push', local, remote), { windowsHide: true });
      let out = '';
      const take = d => { const s = d.toString(); out = (out + s).slice(-4000); const m = s.match(/\[\s*(\d{1,3})%\]/g); if (m) { const pc = +/(\d+)/.exec(m[m.length - 1])[1]; job.pct = lo + Math.round((hi - lo) * Math.min(100, pc) / 100); } };
      p.stdout.on('data', take); p.stderr.on('data', take);
      job.proc = p;
      p.on('error', e => { job.proc = null; resolve({ ok: false, out: String(e.code || e.message) }); });
      p.on('close', code => { job.proc = null; resolve({ ok: code === 0 && !/Permission denied|couldn't create|failed to copy|No such file|Read-only/i.test(out), out: out.trim().split(/[\r\n]+/).filter(l => !/^\[\s*\d+%\]/.test(l.trim())).slice(-2).join(' ') }); });
    });
  }
  // What the app wrote about its inbox: { files: [{ name, readable }], imported: [name] } or null.
  async function appStatus(adb, serial) {
    const r = await run(adb, on(serial, 'shell', 'cat', STATUS_FILE));
    if (r.code !== 0) return null;
    try { return JSON.parse(r.out); } catch (_) { return null; }
  }

  async function send(job, exp, st) {
    const adb = st.adb, serial = st.serial, front = () => run(adb, on(serial, 'shell', 'am', 'start', '-n', ACTIVITY));
    const result = (how, message, extra) => { job.how = how; job.result = Object.assign({ how, message, file: exp.file }, extra || {}); say(job, message); };
    if (st.app.installed) {
      say(job, 'Starting FLEX Field on the phone…');
      await front(); await sleep(W.start); cancelled(job);
      // 1. direct
      let d = await sendDirect(adb, serial, exp, job);
      if (!d.ok && !d.cancelled && !d.partial && !d.refused && !d.fatal && /not listening|did not answer/.test(d.why || '')) { await sleep(W.start); cancelled(job); d = await sendDirect(adb, serial, exp, job); }   // the app may still be starting
      cancelled(job);
      if (d.ok) { await front(); return result('direct', `"${exp.name}" is in FLEX Field on the ${st.model}: tap Import there.`); }
      if (d.fatal) throw new Error(d.why);
      say(job, 'Not straight into the app (' + d.why + '); copying it to the app\'s folder instead…');
      // 2. the app's inbox folder
      job.pct = 5;
      await run(adb, on(serial, 'shell', 'mkdir', '-p', INBOX));
      const remote = INBOX + '/' + exp.file;
      const p = await push(adb, serial, exp.path, remote, job, 5, 85);
      if (job.cancelled) { await run(adb, on(serial, 'shell', 'rm', '-f', remote)); cancelled(job); }
      if (p.ok) {
        say(job, 'Copied. Waiting for FLEX Field to see it…');
        await front();
        const t0 = Date.now(); let seen = null;
        while (Date.now() - t0 < W.appSeen && !seen) {
          await sleep(W.appPoll); cancelled(job);
          const s = await appStatus(adb, serial);
          seen = s && ((s.files || []).find(f => f.name === exp.file) || ((s.imported || []).includes(exp.file) ? { name: exp.file, readable: true } : null));
        }
        if (seen && seen.readable) return result('inbox', `"${exp.name}" is waiting in FLEX Field on the ${st.model}: tap Import there.`);
        say(job, seen ? 'FLEX Field cannot read the copy in its folder on this phone; moving it to Download…' : 'FLEX Field did not pick it up (an older build of the app?); moving it to Download…');
        const mv = await run(adb, on(serial, 'shell', 'mv', remote, DOWNLOAD + '/' + exp.file), 60000);
        if (mv.code === 0) { job.pct = 96; return result('download', `"${exp.name}" is in the phone's Download folder as ${exp.file}: open it there and choose FLEX Field.` + (seen ? '' : ' Rebuild FLEX Field once and it will arrive in the app by itself.'), { rebuild: !seen }); }
        await run(adb, on(serial, 'shell', 'rm', '-f', remote));
      } else say(job, 'The app\'s folder could not be written (' + (p.out || 'refused') + '); copying to Download…');
    } else say(job, 'FLEX Field is not installed on this phone; copying to its Download folder…');
    // 3. Download
    cancelled(job);
    const remote = DOWNLOAD + '/' + exp.file;
    const p = await push(adb, serial, exp.path, remote, job, 5, 95);
    if (job.cancelled) { await run(adb, on(serial, 'shell', 'rm', '-f', remote)); cancelled(job); }
    if (!p.ok) throw new Error('The phone refused the file (' + (p.out || 'adb push failed') + ').');
    if (st.app.installed) await front();
    return result('download', st.app.installed ? `"${exp.name}" is in the phone's Download folder as ${exp.file}: open it there and choose FLEX Field.`
      : `"${exp.name}" is in the phone's Download folder as ${exp.file}. Install FLEX Field, then open the file with it.`);
  }

  async function start(body) {
    const exp = exportInfo(body && body.export);
    if (!exp) return { code: 404, body: { ok: false, error: 'No such export.' } };
    if (exp.running) return { code: 409, body: { ok: false, error: 'That export is still running.' } };
    if (exp.failed || !exp.bytes) return { code: 409, body: { ok: false, error: 'That export did not finish.' } };
    if (body.serial != null && !SERIAL.test(String(body.serial))) return { code: 400, body: { ok: false, error: 'Bad serial.' } };
    if (Object.values(jobs).some(j => j.status === 'running')) return { code: 409, body: { ok: false, error: 'A map is already being sent.' } };
    const st = await status(body.serial ? String(body.serial) : null);
    if (st.state !== 'ready') return { code: 409, body: { ok: false, error: st.hint || 'No phone is ready.', state: st.state, devices: st.devices } };
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = jobs[jobId] = { status: 'running', progress: [], pct: 2, error: null, name: 'To phone: ' + exp.name, started: Date.now(), ended: null, cancelled: false, proc: { kill() {} }, how: null, result: null, export: exp.id };
    say(job, `Sending ${exp.file} (${(exp.bytes / 1048576).toFixed(1)} MB) to the ${st.model}…`);
    send(job, exp, st).then(() => { job.status = 'done'; job.pct = 100; }, e => {
      job.status = 'error'; job.error = e && e.cancel ? 'Cancelled' : String((e && e.message) || e);
      if (!(e && e.cancel)) say(job, '⚠ ' + job.error);
    }).then(() => { job.ended = Date.now(); job.proc = null; });
    return { code: 200, body: { ok: true, jobId } };
  }

  /** /api/phone/<rest> */
  function handle(req, res, rest, query) {
    const fail = e => json(res, { ok: false, error: String((e && e.message) || e) }, 500);
    if (rest === 'status' && req.method === 'GET') {
      const want = query && query.serial && SERIAL.test(String(query.serial)) ? String(query.serial) : null;
      return void status(want).then(s => json(res, s), fail);
    }
    if (rest === 'exports' && req.method === 'GET') return json(res, { ok: true, exports: listExports() });
    if (rest === 'send' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => { let b; try { b = JSON.parse(body || '{}'); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); } start(b).then(r => json(res, r.body, r.code), fail); });
      return;
    }
    const m = /^job\/([A-Za-z0-9]{1,40})$/.exec(rest);
    if (m && req.method === 'GET') {
      const j = Object.prototype.hasOwnProperty.call(jobs, m[1]) ? jobs[m[1]] : null;
      if (!j) return json(res, { ok: false, error: 'Unknown job' }, 404);
      return json(res, { ok: true, status: j.status, pct: j.pct, message: j.progress[j.progress.length - 1] || '', how: j.how, result: j.result, error: j.error });
    }
    json(res, { ok: false, error: 'not found' }, 404);
  }
  return { handle, jobs, pctOf: j => (j.status === 'done' ? 100 : j.pct || 0), status, listExports, exportInfo, start };
};
module.exports.findAdb = findAdb;
module.exports.parseDevices = parseDevices;
module.exports.phoneName = phoneName;
module.exports.PKG = PKG;
module.exports.SOCKET = SOCKET;
module.exports.INBOX = INBOX;
module.exports.STATUS_FILE = STATUS_FILE;
