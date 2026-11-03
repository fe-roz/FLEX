// jobs-panel.js — the Jobs panel: a small strip along the bottom of the map that is there only while
// something is running, waiting or failed (doc 23 §1.1). One row per job: state, name, a bar or the step
// ("2/4 CSF cloth DEM"), time, and the buttons that make sense (Cancel, Log, Retry, Send now, Dismiss).
// It folds to a pill ("Jobs: 2 running ▴"); the map stays visible.
//
// Jobs come from:
//   - the server's long jobs (terrain + hillshade, offline-map export, analyze): the page that starts one calls
//     _jobs.add({ id: '<kind>.<jobId>', server: true, … }); the panel follows it through GET /api/jobs
//     (jobs_api.js), and picks up jobs the server still runs after a reload by itself. Cancel = POST
//     /api/jobs/<id>/cancel (kills the process), Log = GET /api/jobs/<id>/log;
//   - sync-file imports (project-history.js importSync) and anything else, through the handle below;
//   - CalTopo edits waiting for the network: read from window._ctWrite.pending() on 'flex-caltopo-queue';
//     that row has only "Send now" (_ctWrite.retry()).
//
// window._jobs = {
//   add({ id, kind, name, cancel?, retry?, log?, server? })  → handle
//        cancel(): called by Cancel (the job should then call handle.cancelled() / done() / fail());
//        retry():  runs the job again with the same parameters (shown on a failed job only);
//        log:      a string, or a function returning text (or a promise of it); default the lines of handle.log();
//        server:   true = id is "<kind>.<jobId>" of a server job: progress, Cancel and Log come from the server
//   handle: { id, progress(frac 0..1, step?), done(note?), fail(reason), cancelled(), log(line), waiting(text) }
//   list()  recent()  dismiss(id)  showLog(id)  toggle(open)  config({ doneMs })  notifyAsk()
// }
// A finished job: "Done ✓" stays doneMs (30 s; localStorage flex.jobs.doneMs or config() to change), a failed one
// until dismissed; the last 10 finished jobs stay behind the "Recent jobs" link. Browser notification when a job
// ends while the tab is in the background (asked politely once, in the panel).
//
// Node (tests): module.exports = { fmtElapsed, stepOfMessage, pillText }.
(function (root) {
  'use strict';

  // ── Pure helpers ──────────────────────────────────────────────────────────
  /** 65000 → "1:05", 3725000 → "1:02:05" */
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor((+ms || 0) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    const p = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
  }
  /** A server progress line → the step shown on the row: "[2/4] CSF cloth DEM" → "2/4 CSF cloth DEM". */
  function stepOfMessage(msg) {
    let t = String(msg || '').replace(/^[⚠!]\s*/, '').trim();
    const m = /^\[(\d+b?)\/(\d+)\]\s*(.*)$/.exec(t);
    if (m) t = `${m[1]}/${m[2]} ${m[3]}`.trim();
    return t.length > 140 ? t.slice(0, 139) + '…' : t;
  }
  /** The pill: "Jobs: 2 running · 1 failed" (jobs = the visible ones). */
  function pillText(jobs) {
    const n = st => jobs.filter(j => j.state === st).length;
    const parts = [];
    if (n('running')) parts.push(n('running') + ' running');
    if (n('waiting')) parts.push(n('waiting') + ' waiting');
    if (n('failed')) parts.push(n('failed') + ' failed');
    if (!parts.length) parts.push(jobs.some(j => j.state === 'done') ? 'done ✓' : 'none');
    return 'Jobs: ' + parts.join(' · ');
  }
  const api = { fmtElapsed, stepOfMessage, pillText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;

  // ── The panel ─────────────────────────────────────────────────────────────
  const doc = root.document;
  const LS = { done: 'flex.jobs.doneMs', fold: 'flex.jobs.folded', asked: 'flex.jobs.asked' };
  const lget = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const cfg = { doneMs: +lget(LS.done) > 0 ? +lget(LS.done) : 30000, recentMax: 10, pollMs: 1500 };
  const J = new Map();            // id → job (active and finished)
  let recent = [];                // finished jobs, newest first (at most 10)
  let folded = lget(LS.fold) === '1', recentOpen = false, logId = null, logTimer = null, seq = 0;
  let pollTimer = null, ui = null, askWanted = false;
  const rowEls = new Map();       // id → { el, refs }
  const FINISHED = { done: 1, failed: 1, cancelled: 1 };

  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (act, label, title) => { const b = el('button', 'jp-btn', label); b.type = 'button'; b.dataset.act = act; if (title) b.title = title; return b; };

  function build() {
    if (ui) return ui;
    let host = doc.getElementById('jobs-panel');
    if (!host) { host = el('div'); host.id = 'jobs-panel'; doc.body.appendChild(host); }
    host.className = 'jobs-panel'; host.hidden = true; host.textContent = '';
    host.setAttribute('role', 'region'); host.setAttribute('aria-label', 'Jobs');
    const head = btn('fold', '', 'Fold or open the list'); head.className = 'jp-pill';
    const pillLabel = el('span', 'jp-pill-t'), caret = el('span', 'jp-caret');
    head.append(pillLabel, caret);
    const ask = el('div', 'jp-ask');
    ask.append(el('span', null, 'Tell you when a job finishes while this tab is in the background?'), btn('ask-yes', 'Yes, notify me'), btn('ask-no', 'Not now'));
    ask.hidden = true;
    const rows = el('div', 'jp-rows');
    const logbox = el('div', 'jp-log'); logbox.hidden = true;
    const logHead = el('div', 'jp-log-h'), logTitle = el('span', 'jp-log-t');
    logHead.append(logTitle, btn('log-close', 'Close'));
    const logPre = el('pre', 'jp-log-pre');
    logbox.append(logHead, logPre);
    const recentBox = el('div', 'jp-recent'); recentBox.hidden = true;
    const foot = el('div', 'jp-foot');
    const recentLink = btn('recent', 'Recent jobs'); recentLink.className = 'jp-link';
    foot.append(recentLink);
    host.append(head, ask, logbox, rows, recentBox, foot);
    host.addEventListener('click', onClick);
    ui = { host, head, pillLabel, caret, ask, rows, logbox, logTitle, logPre, recentBox, foot, recentLink };
    return ui;
  }

  // ── State changes ─────────────────────────────────────────────────────────
  const visible = (j, now) => !j.dismissed && j.state !== 'cancelled' && (j.state === 'done' ? now - j.ended < cfg.doneMs : true);

  function add(o) {
    o = o || {};
    const id = String(o.id || ('job.' + Date.now().toString(36) + (++seq)));
    let j = J.get(id);
    if (j && FINISHED[j.state]) { J.delete(id); j = null; dropRow(id); }
    const isNew = !j;
    if (!j) { j = { id, kind: o.kind || id.split('.')[0], name: id, state: 'running', frac: null, step: '', started: Date.now(), ended: 0, error: '', lines: [], link: null, server: false, seen: true }; J.set(id, j); }
    if (o.name) { j.name = String(o.name); j.nameSet = true; }
    if (o.kind) j.kind = o.kind;
    if (typeof o.cancel === 'function') j.cancel = o.cancel;
    if (typeof o.retry === 'function') j.retry = o.retry;
    if (o.log != null) j.logSrc = o.log;
    if (o.server) { j.server = true; if (!j.cancel) j.cancel = () => serverCancel(j); }
    if (o.state && !FINISHED[o.state]) j.state = o.state;
    if (isNew) { askMaybe(j); }
    if (j.server) pollSoon();
    render();
    return handleOf(j);
  }
  function handleOf(j) {
    const live = () => J.get(j.id) === j && !FINISHED[j.state];
    return {
      id: j.id,
      progress(frac, step) { if (!live()) return; if (j.state === 'waiting') j.state = 'running'; if (typeof frac === 'number' && isFinite(frac)) j.frac = Math.max(0, Math.min(1, frac)); if (step != null) j.step = String(step); render(); },
      waiting(text) { if (!live()) return; j.state = 'waiting'; if (text != null) j.step = String(text); render(); },
      log(line) { j.lines.push(String(line)); if (j.lines.length > 2000) j.lines.shift(); if (logId === j.id) fillLog(); },
      done(note) { finish(j, 'done', note); },
      fail(reason) { finish(j, 'failed', reason); },
      cancelled() { finish(j, 'cancelled', 'Cancelled'); },
    };
  }
  function finish(j, state, note) {
    if (FINISHED[j.state]) return;
    j.state = state; j.ended = Date.now(); j.frac = state === 'done' ? 1 : j.frac;
    if (state === 'failed') j.error = String(note || 'It did not work'); else if (state === 'done' && note) j.step = String(note);
    recent = [j].concat(recent.filter(r => r.id !== j.id)).slice(0, cfg.recentMax);
    notify(j);
    render();
    if (logId === j.id) fillLog();
  }
  function dismiss(id) { const j = J.get(id); if (j) { j.dismissed = true; render(); } }

  // ── Notifications (a browser notice when the tab is in the background) ────
  const canNotify = () => typeof root.Notification !== 'undefined';
  function askMaybe(j) {
    if (j.state === 'waiting' || !canNotify()) return;
    if (root.Notification.permission === 'default' && lget(LS.asked) !== '1') askWanted = true;
  }
  function notify(j) {
    if (j.state === 'cancelled' || !canNotify() || root.Notification.permission !== 'granted' || !doc.hidden) return;
    try { new root.Notification(j.state === 'done' ? `Done: ${j.name}` : `Failed: ${j.name}`, { body: j.state === 'done' ? (j.step || 'Finished.') : j.error, tag: j.id }); } catch (_) {}
  }

  // ── Server jobs: follow /api/jobs; pick up what the server still runs after a reload ──
  const sOf = j => j.id;      // a server job's id is its server id ("export.k3x9a1")
  async function serverCancel(j) {
    j.cancelling = true; render();
    try { await fetch('/api/jobs/' + encodeURIComponent(sOf(j)) + '/cancel', { method: 'POST' }); } catch (_) {}
    pollSoon(0);
  }
  function pollSoon(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms == null ? 200 : ms); }
  async function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    let list = null;
    try { const r = await fetch('/api/jobs', { cache: 'no-store' }); if (r.ok) list = (await r.json()).jobs; } catch (_) {}
    if (Array.isArray(list)) absorb(list);
    if ([...J.values()].some(j => j.server && !FINISHED[j.state])) pollTimer = setTimeout(poll, cfg.pollMs);
  }
  function absorb(list) {
    const byId = new Map(list.map(e => [e.id, e]));
    for (const e of list) {
      let j = J.get(e.id);
      if (!j) {
        if (e.status !== 'running') {            // finished before this page looked: only in "Recent jobs"
          j = { id: e.id, kind: e.kind, name: e.name, state: 'running', frac: 1, step: '', started: 0, ended: 0, error: '', lines: [], link: null, server: true, seen: false, dismissed: true };
          J.set(e.id, j); fromServer(j, e);
          if (!FINISHED[j.state]) J.delete(e.id); else recent = recent.concat([j]).sort((a, b) => b.ended - a.ended).slice(0, cfg.recentMax);
          continue;
        }
        j = { id: e.id, kind: e.kind, name: e.name, state: 'running', frac: null, step: '', started: Date.now(), ended: 0, error: '', lines: [], link: null, server: true, seen: true };
        j.cancel = () => serverCancel(j);
        J.set(e.id, j);
      }
      if (j.server && !FINISHED[j.state]) fromServer(j, e);
    }
    for (const j of J.values()) if (j.server && !FINISHED[j.state] && !byId.has(j.id)) finish(j, 'failed', 'The server no longer has this job (was FLEX restarted?)');
    render();
  }
  function fromServer(j, e) {
    const skew = (e.now || Date.now()) - Date.now();
    if (e.started) j.started = e.started - skew;
    if (e.name && !j.nameSet) j.name = e.name;
    j.cancellable = !!e.cancellable;
    if (e.status === 'running') {
      j.frac = Math.max(0, Math.min(1, (e.progress || 0) / 100));
      j.step = stepOfMessage(e.message);
      if (j.state === 'waiting') j.state = 'running';
    } else {
      const ended = e.ended ? e.ended - skew : Date.now();
      if (e.download) j.link = { href: e.download, text: 'Download' };
      if (e.status === 'done') { j.state = 'done'; j.frac = 1; j.ended = ended; }
      else if (e.status === 'cancelled') { j.state = 'cancelled'; j.ended = ended; j.error = 'Cancelled'; }
      else { j.state = 'failed'; j.ended = ended; j.error = e.error || 'It did not work'; }
      if (j.seen !== false) { recent = [j].concat(recent.filter(r => r.id !== j.id)).slice(0, cfg.recentMax); notify(j); }
      if (logId === j.id) fillLog();
    }
  }

  // ── CalTopo edits waiting for the network ─────────────────────────────────
  const CT = 'caltopo.queue';
  function syncCalTopo() {
    const w = root._ctWrite; let waiting = [];
    try { waiting = w && w.pending ? w.pending().filter(p => p.state === 'waiting') : []; } catch (_) {}
    const j = J.get(CT), live = j && !FINISHED[j.state];
    if (waiting.length) {
      const name = `CalTopo: ${waiting.length} edit${waiting.length === 1 ? '' : 's'} waiting for the network`;
      const titles = waiting.slice(0, 3).map(p => p.title || p.what || 'edit').join(', ') + (waiting.length > 3 ? ', …' : '');
      const h = live ? handleOf(j) : add({ id: CT, kind: 'caltopo', name, state: 'waiting' });
      const jj = J.get(CT); jj.name = name; jj.sendNow = () => { try { return w.retry(); } catch (_) {} };
      h.waiting(titles);
    } else if (live) {
      let mapOn = false; try { mapOn = !!(w && w.mapId && w.mapId()); } catch (_) {}
      if (mapOn) handleOf(j).done('Sent to CalTopo'); else { J.delete(CT); dropRow(CT); render(); }
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  function rowFor(j) {
    let r = rowEls.get(j.id);
    if (r) return r;
    const e = el('div', 'jp-row'); e.dataset.job = j.id;
    const top = el('div', 'jp-top'), state = el('span', 'jp-state'), name = el('span', 'jp-name'), time = el('span', 'jp-time');
    const btns = el('span', 'jp-btns');
    btns.append(btn('cancel', 'Cancel', 'Stop this job'), btn('send', 'Send now', 'Send the waiting edits to CalTopo now'), btn('retry', 'Retry', 'Run it again with the same settings'),
                btn('log', 'Log', 'The job’s full output'), btn('dismiss', '×', 'Dismiss'));
    const link = el('a', 'jp-btn jp-dl'); link.hidden = true;
    btns.insertBefore(link, btns.firstChild);
    top.append(state, name, time, btns);
    const mid = el('div', 'jp-mid'), bar = el('span', 'jp-bar'), fill = el('span', 'jp-fill'), step = el('span', 'jp-step');
    bar.append(fill); mid.append(bar, step);
    e.append(top, mid);
    r = { e, state, name, time, bar, fill, step, link, btn: a => btns.querySelector(`[data-act="${a}"]`) };
    rowEls.set(j.id, r);
    return r;
  }
  function dropRow(id) { const r = rowEls.get(id); if (r) { r.e.remove(); rowEls.delete(id); } }
  const STATE_T = { running: 'Running', waiting: 'Waiting', done: 'Done ✓', failed: 'Failed', cancelled: 'Cancelled' };
  const elapsed = (j, now) => fmtElapsed((FINISHED[j.state] ? j.ended : now) - j.started);

  function paintRow(j, r, now) {
    r.e.dataset.state = j.state;
    r.state.textContent = STATE_T[j.state];
    r.name.textContent = j.name; r.name.title = j.name;
    r.time.textContent = j.kind === 'caltopo' && j.state === 'waiting' ? 'waiting ' + elapsed(j, now) : elapsed(j, now);
    const indet = j.frac == null && j.state === 'running';
    r.bar.hidden = j.state === 'failed' || j.state === 'waiting';
    r.bar.classList.toggle('indet', indet);
    r.fill.style.width = indet ? '' : Math.round((j.frac || 0) * 100) + '%';
    const txt = j.state === 'failed' ? j.error : j.cancelling ? 'Cancelling…' : j.step;
    r.step.textContent = txt || ''; r.step.title = txt || '';
    r.step.classList.toggle('jp-err', j.state === 'failed');
    const show = (a, on) => { r.btn(a).hidden = !on; };
    show('cancel', j.state === 'running' && !!j.cancel && j.cancellable !== false);
    r.btn('cancel').disabled = !!j.cancelling;
    show('send', j.kind === 'caltopo' && j.state === 'waiting');
    show('retry', j.state === 'failed' && !!j.retry);
    show('log', j.kind !== 'caltopo');
    show('dismiss', j.state === 'failed');
    if (j.link && j.state === 'done') { r.link.hidden = false; r.link.href = j.link.href; r.link.textContent = j.link.text; r.link.setAttribute('download', ''); } else r.link.hidden = true;
  }
  function render() {
    if (!doc.body) return;
    const u = build(), now = Date.now();
    const vis = [...J.values()].filter(j => visible(j, now)).sort((a, b) => a.started - b.started);
    for (const [id, r] of rowEls) if (!vis.some(j => j.id === id)) { r.e.remove(); rowEls.delete(id); }
    vis.forEach((j, i) => { const r = rowFor(j); paintRow(j, r, now); if (u.rows.children[i] !== r.e) u.rows.insertBefore(r.e, u.rows.children[i] || null); });
    u.pillLabel.textContent = vis.length ? pillText(vis) : 'Jobs';
    u.head.classList.toggle('bad', vis.some(j => j.state === 'failed'));
    u.caret.textContent = folded ? '▴' : '▾';
    u.head.hidden = !vis.length;
    u.rows.hidden = folded || !vis.length;
    u.ask.hidden = !(askWanted && vis.length && !folded);
    u.recentLink.hidden = !recent.length;
    u.foot.hidden = !recent.length || (folded && !!vis.length);
    u.host.classList.toggle('idle', !vis.length);
    u.host.hidden = !vis.length && !recent.length;
    u.recentBox.hidden = !recentOpen || !recent.length;
    if (recentOpen && recent.length) paintRecent();
    if (logId && !J.has(logId)) closeLog();
    u.recentLink.textContent = recentOpen ? 'Hide recent jobs' : 'Recent jobs';
  }
  function paintRecent() {
    const box = ui.recentBox, now = Date.now();
    box.textContent = '';
    for (const j of recent) {
      const r = el('div', 'jp-rrow'); r.dataset.job = j.id; r.dataset.state = j.state;
      r.append(el('span', 'jp-state', STATE_T[j.state]), el('span', 'jp-name', j.name), el('span', 'jp-time', fmtElapsed(j.ended - j.started) + ' · ' + ago(now - j.ended)));
      const b = el('span', 'jp-btns'); b.append(btn('log', 'Log'));
      b.lastChild.dataset.id = j.id;
      if (j.state === 'failed' && j.retry) { const rb = btn('retry', 'Retry'); rb.dataset.id = j.id; b.insertBefore(rb, b.firstChild); }
      r.append(b); box.append(r);
    }
  }
  function ago(ms) { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; }

  // ── Log ───────────────────────────────────────────────────────────────────
  async function textOf(j) {
    if (j.logSrc != null) { try { return String(typeof j.logSrc === 'function' ? await j.logSrc() : j.logSrc); } catch (e) { return 'Could not read the log: ' + e.message; } }
    if (j.server) {
      try { const r = await fetch('/api/jobs/' + encodeURIComponent(j.id) + '/log', { cache: 'no-store' }); if (r.ok) { const t = await r.text(); return t.trim() ? t : 'Nothing has been written yet.'; } } catch (_) {}
      return 'The server has no log for this job any more.';
    }
    return j.lines.length ? j.lines.join('\n') : 'Nothing was written to the log.';
  }
  async function fillLog() {
    const j = J.get(logId) || recent.find(r => r.id === logId); if (!j) return;
    const t = await textOf(j);
    if (logId !== j.id) return;
    const atEnd = ui.logPre.scrollTop + ui.logPre.clientHeight >= ui.logPre.scrollHeight - 8;
    ui.logPre.textContent = t;
    if (atEnd) ui.logPre.scrollTop = ui.logPre.scrollHeight;
  }
  function showLog(id) {
    const j = J.get(id) || recent.find(r => r.id === id); if (!j) return;
    build(); logId = id; ui.logTitle.textContent = 'Log: ' + j.name; ui.logbox.hidden = false; ui.logPre.textContent = '…';
    fillLog();
    clearInterval(logTimer); logTimer = setInterval(() => { const q = J.get(logId); if (q && !FINISHED[q.state]) fillLog(); }, 2000);
  }
  function closeLog() { logId = null; clearInterval(logTimer); if (ui) ui.logbox.hidden = true; }

  // ── Clicks ────────────────────────────────────────────────────────────────
  function onClick(ev) {
    const b = ev.target.closest && ev.target.closest('button[data-act]'); if (!b) return;
    const row = b.closest('[data-job]'), id = b.dataset.id || (row && row.dataset.job), j = id && (J.get(id) || recent.find(r => r.id === id));
    switch (b.dataset.act) {
      case 'fold': folded = !folded; lset(LS.fold, folded ? '1' : '0'); render(); break;
      case 'recent': recentOpen = !recentOpen; render(); break;
      case 'log': if (id) showLog(id); break;
      case 'log-close': closeLog(); break;
      case 'cancel': if (j && j.cancel) { try { const r = j.cancel(); if (r && r.catch) r.catch(() => {}); } catch (_) {} } break;
      case 'send': if (j && j.sendNow) { b.disabled = true; Promise.resolve(j.sendNow()).finally(() => { b.disabled = false; syncCalTopo(); }); } break;
      case 'retry': if (j && j.retry) { j.dismissed = true; render(); try { const r = j.retry(); if (r && r.catch) r.catch(() => {}); } catch (_) {} } break;
      case 'dismiss': if (j) dismiss(j.id); break;
      case 'ask-yes': lset(LS.asked, '1'); askWanted = false; render(); try { const p = root.Notification.requestPermission(); if (p && p.catch) p.catch(() => {}); } catch (_) {} break;
      case 'ask-no': lset(LS.asked, '1'); askWanted = false; render(); break;
    }
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  setInterval(() => {                       // time on the rows; "Done ✓" rows leave after doneMs
    if (!ui) return;
    const now = Date.now();
    let changed = false;
    for (const j of J.values()) { const r = rowEls.get(j.id); if (r) { if (!visible(j, now)) changed = true; else r.time.textContent = (j.kind === 'caltopo' && j.state === 'waiting' ? 'waiting ' : '') + elapsed(j, now); } }
    if (changed) render();
    if (recentOpen) paintRecent();
  }, 1000);
  root.addEventListener('flex-caltopo-queue', syncCalTopo);
  const start = () => { build(); render(); setTimeout(() => { syncCalTopo(); poll(); }, 1500); };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();

  root._jobs = {
    add, dismiss, showLog,
    list: () => [...J.values()].map(j => ({ id: j.id, kind: j.kind, name: j.name, state: j.state, frac: j.frac, step: j.step, error: j.error })),
    recent: () => recent.map(j => ({ id: j.id, name: j.name, state: j.state })),
    toggle: open => { folded = open == null ? !folded : !open; lset(LS.fold, folded ? '1' : '0'); render(); },
    config: o => { if (o && +o.doneMs >= 0) cfg.doneMs = +o.doneMs; render(); return Object.assign({}, cfg); },
    notifyAsk: () => { lset(LS.asked, ''); },
  };
})(typeof window !== 'undefined' ? window : null);
