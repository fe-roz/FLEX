// Node test for the pure parts of client/src/modules/workflow-panel.js (synthetic data only).
const path = require('path');
const { isAoiGeometry, escapeHtml, formatDownloadStatus, formatIntegrityStatus, formatEptStatus } =
  require(path.join(__dirname, '..', 'client', 'src', 'modules', 'workflow-panel.js'));
let pass = 0, fail = 0;
function ok(label, cond, info) {
  if (cond) pass++; else { fail++; console.log('FAIL', label, info === undefined ? '' : JSON.stringify(info)); }
}
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

{ // isAoiGeometry
  ok('polygon', isAoiGeometry({ type: 'Polygon' }));
  ok('multipolygon', isAoiGeometry({ type: 'MultiPolygon' }));
  ok('point', !isAoiGeometry({ type: 'Point' }));
  ok('null / string', !isAoiGeometry(null) && !isAoiGeometry('Polygon'));
}
{ // escapeHtml
  eq('escapes', escapeHtml('<a href="x">Cave Ridge & co</a>'), '&lt;a href="x"&gt;Cave Ridge &amp; co&lt;/a&gt;');
  eq('null', escapeHtml(null), '');
  eq('number', escapeHtml(45.1234), '45.1234');
}
{ // formatDownloadStatus
  const n = formatDownloadStatus(null);
  ok('n/a', n.badgeLabel === 'N/A' && n.badgeClass === 'wf_status_default');
  const d = formatDownloadStatus({ status: 'Downloaded', files_completed: 3, files_total: 3, files_failed: 0,
    download_speed_mbps: 1.5, downloaded_mb: 10, estimated_total_mb: 10, estimated_eta_seconds: 3725 });
  ok('complete', d.badgeLabel === 'Complete' && d.badgeClass === 'wf_status_complete', d);
  ok('eta h/m/s', d.text.includes('ETA: 1h 2m 5s') && d.text.includes('Speed: 1.50 MB/s'), d.text);
  const q = formatDownloadStatus({ status: 'Downloading', files_completed: 1, files_total: 4, files_failed: 1,
    active_file_downloads: 2, estimated_eta_seconds: 75 });
  ok('downloading', q.badgeClass === 'wf_status_downloading' && q.text.includes('(2)') && q.text.includes('ETA: 1m 15s') &&
     q.text.includes('Speed: n/a'), q);
  ok('error / paused', formatDownloadStatus({ status: 'Error' }).badgeClass === 'wf_status_error' &&
     formatDownloadStatus({ status: 'Paused' }).badgeClass === 'wf_status_paused');
}
{ // integrity / ept
  eq('integrity n/a', formatIntegrityStatus(null), 'Integrity: n/a');
  eq('integrity', formatIntegrityStatus({ latest_job: { status: 'done', stage: 'check' }, report_exists: true }),
     'Integrity latest: done\nStage: check\nReport: present');
  eq('ept n/a', formatEptStatus(null), 'EPT: n/a');
  const e = formatEptStatus({ latest_job: { status: 'running', progress_pct: 12.34 }, elapsed_seconds: 125, ept_ready: false,
    log_tail: ['a', 'b', 'c', 'd'] });
  ok('ept', e.includes('Progress: 12.3%') && e.includes('Elapsed: 2m 5s') && e.includes('Ready: no') &&
     e.endsWith('- b\n- c\n- d') && !e.includes('- a'), e);
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
