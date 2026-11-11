// jobs_api.js — the server side of the Jobs panel (client/src/modules/jobs-panel.js).
//
// One list over the server's long jobs (offline-map exports, terrain + hillshade generation,
// analyze runs, surface routes, vegetation shapes), whatever file keeps them. Each source is { jobs, pct(job), download?(id, job) }; a job
// record carries { status: 'running'|'done'|'error', progress: [lines], error, name|label, started, ended,
// cancelled, proc }. The records live in memory, so a job is listed as long as the server runs.
//
//   GET  /api/jobs                 running jobs and those finished within the last hour, newest first
//   GET  /api/jobs/<id>/log        the job's whole output (text)
//   POST /api/jobs/<id>/cancel     stop a running job (kills its process)
//
// <id> is "<kind>.<jobId>" (export.k3x9a1, terrain.…, analyze.…, route.…): the kind and a short [A-Za-z0-9_-] id,
// nothing else is looked up.
'use strict';
const ID_RE = /^(export|terrain|analyze|route|veg)\.([A-Za-z0-9_-]{1,40})$/;
const KEEP_MS = 3600 * 1000;

module.exports = function jobsApi({ sources }) {
  const text = (res, s, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s); };
  const json = (res, d, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(d)); };
  const find = id => {
    const m = ID_RE.exec(String(id || '')); if (!m) return null;
    const src = sources[m[1]], job = src && Object.prototype.hasOwnProperty.call(src.jobs, m[2]) ? src.jobs[m[2]] : null;
    return job ? { src, job, kind: m[1], jobId: m[2] } : null;
  };
  const view = (kind, jobId, src, job) => ({
    id: kind + '.' + jobId, kind, jobId, name: job.name || job.label || kind,
    status: job.status === 'running' ? 'running' : job.status === 'done' ? 'done' : job.cancelled ? 'cancelled' : 'error',
    progress: src.pct(job), message: job.progress[job.progress.length - 1] || '', error: job.error || null,
    started: job.started || null, ended: job.ended || null, now: Date.now(),
    cancellable: job.status === 'running' && !!job.proc,
    download: job.status === 'done' && src.download ? src.download(jobId, job) : null,
    lines: job.progress.length,
  });
  function list() {
    const out = [], t = Date.now();
    for (const [kind, src] of Object.entries(sources))
      for (const [jobId, job] of Object.entries(src.jobs))
        if (job.status === 'running' || !job.ended || t - job.ended < KEEP_MS) out.push(view(kind, jobId, src, job));
    return out.sort((a, b) => (b.started || 0) - (a.started || 0));
  }
  function cancel(id) {
    const f = find(id);
    if (!f) return { code: 404, body: { ok: false, error: 'Unknown job' } };
    if (f.job.status !== 'running' || !f.job.proc) return { code: 409, body: { ok: false, error: 'The job is not running' } };
    f.job.cancelled = true;
    try { f.job.proc.kill(); } catch (_) {}
    return { code: 200, body: { ok: true } };
  }
  /** /api/jobs[/<id>/log|cancel] → true when handled */
  function handle(req, res, rest) {
    if (rest === '' && req.method === 'GET') { json(res, { ok: true, jobs: list() }); return true; }
    const m = /^([^/]+)\/(log|cancel)$/.exec(rest);
    if (!m) return false;
    if (m[2] === 'log' && req.method === 'GET') {
      const f = find(decodeURIComponent(m[1]));
      if (!f) { json(res, { ok: false, error: 'Unknown job' }, 404); return true; }
      text(res, f.job.progress.join('\n') + '\n'); return true;
    }
    if (m[2] === 'cancel' && req.method === 'POST') { const r = cancel(decodeURIComponent(m[1])); json(res, r.body, r.code); return true; }
    return false;
  }
  return { handle, list, cancel, find };
};
