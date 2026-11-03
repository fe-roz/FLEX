// Tests of the Jobs panel's pure helpers (jobs-panel.js) and of jobs_api.js (the server's job list, log and Cancel),
// with made-up jobs and a throw-away sleeping process.
//
//   node tools/test_jobs_panel.js
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const M = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'jobs-panel.js'));
const makeApi = require('../jobs_api');

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info) : '')); } };

ok('elapsed: m:ss', M.fmtElapsed(0) === '0:00' && M.fmtElapsed(65000) === '1:05' && M.fmtElapsed(599999) === '9:59');
ok('elapsed: h:mm:ss', M.fmtElapsed(3725000) === '1:02:05');
ok('elapsed: bad input is 0:00', M.fmtElapsed(-5) === '0:00' && M.fmtElapsed(undefined) === '0:00');
ok('step: "[2/4] CSF cloth DEM" → "2/4 CSF cloth DEM"', M.stepOfMessage('[2/4] CSF cloth DEM') === '2/4 CSF cloth DEM');
ok('step: 4b markers and the warning mark', M.stepOfMessage('[4b/7] Textures') === '4b/7 Textures' && M.stepOfMessage('⚠ something odd') === 'something odd');
ok('step: a long line is cut', M.stepOfMessage('x'.repeat(300)).length <= 140);
ok('pill: counts', M.pillText([{ state: 'running' }, { state: 'running' }]) === 'Jobs: 2 running'
  && M.pillText([{ state: 'running' }, { state: 'waiting' }, { state: 'failed' }]) === 'Jobs: 1 running · 1 waiting · 1 failed'
  && M.pillText([{ state: 'done' }]) === 'Jobs: done ✓');

(async () => {
  const proc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
  const t = Date.now();
  const A = { jobs: {
    a1: { status: 'running', progress: ['[1/4] Reading'], name: 'Offline map: Cave Ridge', started: t - 5000, ended: null, proc },
    a2: { status: 'done', progress: ['x', 'y'], name: 'Old one', started: t - 9e6, ended: t - 8e6, proc: null },        // finished over an hour ago: not listed
    a3: { status: 'error', progress: ['⚠ no'], label: 'Terrain', error: 'boom', started: t - 60000, ended: t - 1000, proc: null },
  }, pct: j => (j.status === 'done' ? 100 : 25), download: id => '/api/export/download/' + id };
  const api = makeApi({ sources: { export: A } });
  const list = api.list();
  ok('list: running and recent, not older than an hour, newest first', list.length === 2 && list[0].id === 'export.a1' && list[1].id === 'export.a3', list.map(j => j.id));
  ok('list: fields', list[0].status === 'running' && list[0].progress === 25 && list[0].cancellable === true && list[0].name === 'Offline map: Cave Ridge' && list[1].status === 'error' && list[1].error === 'boom' && list[1].name === 'Terrain' && !('proc' in list[0]), list);
  const res = () => { const o = { code: 0, head: null, body: '' }; return Object.assign(o, { writeHead(c, h) { o.code = c; o.head = h; }, end(b) { o.body = b; } }); };
  let r = res();
  ok('GET log: the lines', api.handle({ method: 'GET' }, r, 'export.a3/log') && r.code === 200 && r.body === '⚠ no\n');
  for (const bad of ['../x', 'export.a1/../../x', 'foo.bar', 'export.', 'export.' + 'a'.repeat(50), 'export.nope', '%00']) {
    r = res(); const handled = api.handle({ method: 'POST' }, r, encodeURIComponent(bad) + '/cancel');
    ok('bad id "' + bad.slice(0, 20) + '": not stopped', !handled || r.code === 404, { handled, code: r.code });
  }
  r = res(); api.handle({ method: 'POST' }, r, 'export.a3/cancel');
  ok('cancel of a finished job: 409', r.code === 409, r.code);
  r = res(); api.handle({ method: 'POST' }, r, 'export.a1/cancel');
  ok('cancel: 200 and the job is marked', r.code === 200 && A.jobs.a1.cancelled === true);
  await new Promise(res => proc.on('close', res));
  ok('cancel: the process is gone', proc.killed || proc.signalCode === 'SIGTERM' || proc.exitCode !== null, [proc.signalCode, proc.exitCode]);
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
