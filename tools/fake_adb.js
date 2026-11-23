#!/usr/bin/env node
// A stand-in for adb, for tools/test_phone_api.js and the kit: it records its arguments and answers the way the
// real adb does (the lines of `adb devices -l`, push's percent lines and its "Permission denied", a forward port),
// with a folder standing in for the phone. What the "phone" is like comes from the JSON file FAKE_ADB_STATE names:
//   { root, log, devices: [{ serial, state, model }], android, app: { installed, version, socket, socketRefuse,
//     reads: true | false | 'never' }, inboxRefuse, downloadRefuse, pushMs, adbBroken }
// app.socket: FLEX Field listens on its local socket; app.reads: what it says about a zip pushed into its inbox
// folder (true: readable, false: it sees it but cannot read it, 'never': an old build that does not look).
'use strict';
const fs = require('fs'), path = require('path'), net = require('net'), { spawn } = require('child_process');
const S = JSON.parse(fs.readFileSync(process.env.FAKE_ADB_STATE, 'utf8'));
const PKG = 'com.feroz.flexfield', INBOX = '/sdcard/Android/data/' + PKG + '/files/inbox', STATUS = '/sdcard/Android/data/' + PKG + '/files/inbox_status.json';
const local = remote => path.join(S.root, remote.replace(/^\/+/, ''));
const app = S.app || {};
const log = o => { try { fs.appendFileSync(S.log, JSON.stringify(o) + '\n'); } catch (_) {} };
const out = s => process.stdout.write(s), die = (s, code = 1) => { process.stderr.write(s); process.exit(code); };

// ── the app's side of the local socket (a detached child of `forward`) ──
if (process.argv[2] === '--app-socket') {
  const srv = net.createServer(sock => {
    if (!app.installed || !app.socket) return sock.destroy();
    let buf = Buffer.alloc(0), want = 0, name = '', fd = null, got = 0, tmp = '';
    const abort = () => { if (fd != null) { try { fs.closeSync(fd); fs.unlinkSync(tmp); } catch (_) {} fd = null; } };
    sock.on('close', abort); sock.on('error', abort);
    sock.on('data', d => {
      if (fd != null) { fs.writeSync(fd, d); got += d.length; if (got >= want) { fs.closeSync(fd); fd = null; fs.renameSync(tmp, tmp.replace(/\.part$/, '')); log({ app: 'received', name, bytes: got }); sock.write('OK\n'); } return; }
      buf = Buffer.concat([buf, d]);
      let i;
      while (fd == null && (i = buf.indexOf(10)) >= 0) {
        const line = buf.slice(0, i).toString().trim(); buf = buf.slice(i + 1);
        if (line === 'PING') sock.write('FLEXFIELD 21\n');
        else if (/^SEND \d+ [A-Za-z0-9._-]+\.zip$/.test(line)) {
          if (app.socketRefuse) { sock.write('ERR not enough room on the phone\n'); continue; }
          want = +line.split(' ')[1]; name = line.split(' ')[2];
          const dir = path.join(S.root, 'app_private', 'inbox'); fs.mkdirSync(dir, { recursive: true });
          tmp = path.join(dir, name + '.part'); fd = fs.openSync(tmp, 'w'); got = 0; sock.write('READY\n');
          if (buf.length) { fs.writeSync(fd, buf); got += buf.length; buf = Buffer.alloc(0); }
        } else sock.write('ERR what\n');
      }
    });
  });
  srv.listen(0, '127.0.0.1', () => { out(srv.address().port + '\n'); });
  return;
}

const args = process.argv.slice(2);
log({ args });
if (S.adbBroken) die('adb: cannot start\n', 126);
let serial = null, a = args.slice();
if (a[0] === '-s') { serial = a[1]; a = a.slice(2); }
const devs = S.devices || [];
if (a[0] === 'devices') { out('List of devices attached\n' + devs.map(d => `${d.serial}\t${d.state}${d.state === 'device' ? ` usb:1-1 product:x model:${(d.model || 'Phone').replace(/ /g, '_')} device:x transport_id:1` : ''}\n`).join('') + '\n'); process.exit(0); }
const dev = devs.find(d => d.serial === serial);
if (!dev) die(`adb: device '${serial}' not found\n`);
if (dev.state !== 'device') die(`adb: device ${dev.state}.\n`);

// what FLEX Field would write about its inbox, each time it looks
function appLooks() {
  if (!app.installed || app.reads === 'never' || app.reads === undefined) return;
  let names = []; try { names = fs.readdirSync(local(INBOX)).filter(n => /\.zip$/.test(n)); } catch (_) {}
  fs.mkdirSync(path.dirname(local(STATUS)), { recursive: true });
  fs.writeFileSync(local(STATUS), JSON.stringify({ t: 1, files: names.map(name => ({ name, readable: app.reads === true })), imported: [] }));
}
if (a[0] === 'shell') {
  const c = a.slice(1);
  if (c[0] === 'getprop') { out((S.android || '15') + '\n'); process.exit(0); }
  if (c[0] === 'dumpsys' && c[1] === 'package') { out(app.installed && c[2] === PKG ? `Packages:\n  Package [${PKG}] (abc123):\n    versionCode=3 minSdk=26\n    versionName=${app.version || '2.0'}\n` : `Unable to find package: ${c[2]}\n`); process.exit(0); }
  if (c[0] === 'am' && c[1] === 'start') { if (!app.installed) die('Error: Activity class does not exist.\n'); appLooks(); out('Starting: Intent { cmp=' + c[c.length - 1] + ' }\n'); process.exit(0); }
  if (c[0] === 'mkdir') { if (c[c.length - 1].startsWith(INBOX) && S.inboxRefuse) die('mkdir: Permission denied\n'); fs.mkdirSync(local(c[c.length - 1]), { recursive: true }); process.exit(0); }
  if (c[0] === 'rm') { try { fs.unlinkSync(local(c[c.length - 1])); } catch (_) {} process.exit(0); }
  if (c[0] === 'mv') { try { fs.mkdirSync(path.dirname(local(c[2])), { recursive: true }); fs.renameSync(local(c[1]), local(c[2])); process.exit(0); } catch (e) { die('mv: ' + e.code + '\n'); } }
  if (c[0] === 'cat') { appLooks(); try { out(fs.readFileSync(local(c[1]), 'utf8')); process.exit(0); } catch (_) { die(`cat: ${c[1]}: No such file or directory\n`); } }
  die('fake adb: unknown shell command ' + c.join(' ') + '\n');
}
if (a[0] === 'push') {
  const [, from, to] = a;
  if ((to.startsWith(INBOX) && S.inboxRefuse) || (to.startsWith('/sdcard/Download') && S.downloadRefuse))
    die(`adb: error: failed to copy '${from}' to '${to}': remote couldn't create file: Permission denied\n${from}: 0 files pushed, 0 skipped.\n`);
  const data = fs.readFileSync(from), dst = local(to); fs.mkdirSync(path.dirname(dst), { recursive: true });
  const fd = fs.openSync(dst, 'w'), steps = 10; let k = 0;
  const step = () => {
    if (k >= steps) { fs.closeSync(fd); out(`${from}: 1 file pushed, 0 skipped. 30.1 MB/s (${data.length} bytes in 0.100s)\n`); return process.exit(0); }
    const s = Math.floor(data.length * k / steps), e = Math.floor(data.length * (k + 1) / steps); fs.writeSync(fd, data.slice(s, e)); k++;
    out(`[${String(Math.round(100 * k / steps)).padStart(3)}%] ${to}\r`);
    setTimeout(step, (S.pushMs || 0) / steps);
  };
  return step();
}
if (a[0] === 'forward') {
  if (a[1] === '--remove') { const f = path.join(S.root, 'fw_' + a[2].replace(/\D/g, '') + '.pid'); try { process.kill(+fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); } catch (_) {} process.exit(0); }
  const child = spawn(process.execPath, [__filename, '--app-socket'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
  child.stdout.once('data', d => { const port = String(d).trim(); fs.writeFileSync(path.join(S.root, 'fw_' + port + '.pid'), String(child.pid)); child.stdout.destroy(); child.unref(); out(port + '\n'); process.exit(0); });
  return;
}
die('fake adb: unknown command ' + a.join(' ') + '\n');
