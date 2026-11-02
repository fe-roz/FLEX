// Editing the CalTopo map from FLEX: the browser side of caltopo_api.js.
//
// The FLEX server does the signed writes, keeps the copy of the map (offline
// display, the base of edits), the queue of edits that wait for CalTopo, the
// conflicts, the pull-to-pull changes and the log. This module is what the
// info panel and the row menus call:
//
//   window._ctWrite.available()          a private map is loaded through a key (edits possible; offline they wait)
//   .mapId()                             that map's id or null
//   .feature(fid)                        the last pulled CalTopo feature JSON, or null
//   .folders()                           [{id, title, folderId}] for "move to folder"
//   .update(fid, patch, {dialog})        patch: CalTopo property names (title, description, folderId, marker-color,
//                                        marker-symbol, stroke, stroke-width, fill, fill-opacity) and/or geometry
//   .remove(fid, {dialog})               (ask first: this deletes in CalTopo)
//   .create(feature)                     a new Marker / Shape ({geometry, properties})
//        → { ok:true, feature } | { queued:true } | { conflict:true, mine, theirs } | { ok:false, error, readOnly? }
//        A short message is shown either way; a conflict opens the side-by-side dialog
//        unless {dialog:false}. create(feature, {quiet:true}) says nothing and doesn't re-read the map (bulk send);
//        the caller calls refresh() once at the end.
//   .status(fid)                         null | 'waiting' | 'conflict' | 'failed' | 'changed' (in CalTopo, since last looked)
//   .pending()                           [{fid, title, what, at, state, error?}] waiting, conflicting, failed edits
//   .resolve(fid, 'mine'|'theirs')       keep my edit (sent now) or CalTopo's (my edit dropped)
//   .showConflict(fid)                   the side-by-side dialog → the pick, or null (decide later)
//   .changes()                           [{fid, title, what:'added'|'changed'|'removed', at}], newest first
//   .seen()  .markSeen()                 when the person last looked at the changes / they have now
//   .offline()                           the map shown is FLEX's copy (CalTopo not reachable)
//   .retry()                             send waiting edits now
// Events on window: 'flex-caltopo-changed' {changes, seen} after a pull that brought changes (and after markSeen),
//                   'flex-caltopo-queue' {pending} when the queue or the conflicts change.
// flex.js hands every pull of a private map to _pulled(mapId, json) (null when none is loaded).
(function () {
  'use strict';
  const S = { map: null, json: null, idx: new Map(), offline: false, pending: [], pendKey: '', changes: [], seen: 0, newest: 0, poll: null, seq: 0, shown: new Set() };
  const toast = m => { if (window._pjApi && window._pjApi.toast) window._pjApi.toast(m); else console.log('[caltopo]', m); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function api(p, opts) {
    try {
      const r = await fetch('/api/caltopo/' + p, opts);
      let j = {}; try { j = await r.json(); } catch (_) {}
      if (!r.ok && j.ok === undefined) j.ok = false;
      if (!r.ok && !j.error) j.error = r.statusText || 'FLEX server error';
      return j;
    } catch (e) { return { ok: false, error: 'The FLEX server did not answer' }; }
  }
  const post = (p, o) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
  const fire = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} };
  const titleOf = (f, fid) => (f && f.properties && f.properties.title) || fid || 'the feature';
  const refreshMap = async () => { if (window._ctRefresh) { try { await window._ctRefresh(); } catch (_) {} } else await state(); };

  // ── From flex.js: every pull ──────────────────────────────────────────────
  function _pulled(map, j) {
    if (!map) {
      const had = S.map || S.pending.length;
      Object.assign(S, { map: null, json: null, idx: new Map(), offline: false, pending: [], pendKey: '', changes: [], seen: 0, newest: 0 });
      clearTimeout(S.poll);
      if (had) fire('flex-caltopo-queue', { pending: [] });
      return;
    }
    if (map !== S.map) Object.assign(S, { pending: [], pendKey: '', changes: [], seen: 0, newest: 0 });
    S.map = map; S.json = j || {}; S.offline = !!(j && j.flexOffline);
    S.idx = new Map();
    ((S.json.state && S.json.state.features) || []).forEach(f => { if (f && f.id != null) S.idx.set(String(f.id), f); });
    return state();
  }
  /** The queue and the changes, from the server. */
  async function state() {
    const map = S.map, n = ++S.seq;
    if (!map) return;
    const [q, c] = await Promise.all([api('queue?map=' + map), api('changes?map=' + map)]);
    if (map !== S.map || n !== S.seq) return;
    if (Array.isArray(c.changes)) {
      const newest = c.changes.reduce((m, x) => Math.max(m, x.at || 0), 0);
      const seenMoved = (c.seen || 0) !== S.seen;
      S.changes = c.changes; S.seen = c.seen || 0;
      if (newest > S.newest || seenMoved) { S.newest = Math.max(S.newest, newest); fire('flex-caltopo-changed', { changes: S.changes.slice(), seen: S.seen }); }
    }
    if (Array.isArray(q.pending)) setPending(q.pending);
  }
  function setPending(list) {
    const key = JSON.stringify(list.map(p => [p.fid, p.state, p.at]));
    if (key === S.pendKey) return schedule();
    const before = S.pending;
    S.pending = list; S.pendKey = key;
    const now = new Set(list.map(p => p.fid));
    const sent = before.filter(p => p.state === 'waiting' && !now.has(p.fid) && !S.shown.has('drop:' + p.fid));
    S.shown.forEach(k => { if (k.startsWith('drop:')) S.shown.delete(k); });
    if (sent.length) { toast(sent.length === 1 ? `Sent to CalTopo: “${sent[0].title}”` : `Sent ${sent.length} waiting changes to CalTopo`); refreshMap(); }
    const fresh = list.filter(p => p.state === 'conflict' && !before.some(b => b.fid === p.fid && b.state === 'conflict'));
    S.shown.forEach(k => { if (k.startsWith('c:') && !list.some(p => p.state === 'conflict' && 'c:' + p.fid === k)) S.shown.delete(k); });
    fresh.forEach(p => {                     // a waiting edit met a change made in CalTopo meanwhile
      if (S.shown.has('c:' + p.fid)) return;
      S.shown.add('c:' + p.fid);
      toast(`“${p.title}” was changed in CalTopo while your edit waited: pick a version`);
      if (!document.querySelector('.pj-modal')) showConflict(p.fid);
    });
    list.filter(p => p.state === 'failed' && !before.some(b => b.fid === p.fid && b.state === 'failed')).forEach(p => toast(p.error || `CalTopo refused the change to “${p.title}”`));
    fire('flex-caltopo-queue', { pending: pending() });
    schedule();
  }
  function schedule() {                      // waiting edits: only the server retries them (caltopo_api.js, backing off);
    clearTimeout(S.poll);                    // here we just look at its queue (a local answer, no CalTopo request)
    if (!S.map || !S.pending.some(p => p.state === 'waiting')) return;
    S.poll = setTimeout(state, 20000);
  }
  async function retry() {
    if (!S.map) return;
    const r = await post('retry', { map: S.map });
    if (Array.isArray(r.pending)) setPending(r.pending);
    return r;
  }

  // ── Edits ─────────────────────────────────────────────────────────────────
  async function answered(r, fid, title, opts) {
    opts = opts || {};
    if (opts.quiet) { if (r.conflict) S.shown.add('c:' + fid); return r; }   // a bulk send: it tells once at the end and refreshes once
    if (r.ok) toast(r.dropped ? `Kept CalTopo’s version of “${title}”` : opts.done || `Saved to CalTopo: “${title}”`);
    else if (r.queued) toast(`CalTopo can’t be reached: “${title}” will be sent when it is back`);
    else if (r.conflict) toast(`“${title}” was changed in CalTopo meanwhile: pick a version`);
    else toast(r.error || 'CalTopo didn’t take the change');
    if (r.conflict) S.shown.add('c:' + fid);           // answered here: not again as a "new" conflict
    if (r.ok) await refreshMap(); else await state();
    if (r.conflict && opts.dialog !== false) showConflict(fid);
    return r;
  }
  const notLoaded = { ok: false, error: 'No private CalTopo map is loaded (it needs a CalTopo key).' };
  async function update(fid, patch, opts) {
    if (!S.map) return notLoaded;
    fid = String(fid || '').replace(/^ct-/, '');
    const f = feature(fid);
    const r = await post('feature', { map: S.map, fid, cls: f && f.properties && f.properties.class, base: f && f.properties ? f.properties.updated : undefined, patch: patch || {} });
    return answered(r, fid, (patch && patch.title) || titleOf(f, fid), opts);
  }
  async function remove(fid, opts) {
    if (!S.map) return notLoaded;
    fid = String(fid || '').replace(/^ct-/, '');
    const f = feature(fid), p = f && f.properties || {};
    const q = new URLSearchParams({ map: S.map, fid });
    if (p.class) q.set('cls', p.class);
    if (p.updated != null) q.set('base', String(p.updated));
    const r = await api('feature?' + q, { method: 'DELETE' });
    return answered(r, fid, titleOf(f, fid), Object.assign({ done: `Deleted in CalTopo: “${titleOf(f, fid)}”` }, opts));
  }
  async function create(feat, opts) {
    if (!S.map) return notLoaded;
    const r = await post('feature', { map: S.map, cls: feat && feat.properties && feat.properties.class, feature: feat });
    return answered(r, r.fid || '', titleOf(feat, 'the new feature'), Object.assign({ done: `Added to CalTopo: “${titleOf(feat, 'the new feature')}”` }, opts));
  }
  async function resolve(fid, pick) {
    if (!S.map) return notLoaded;
    const p = S.pending.find(x => x.fid === fid);
    if (pick === 'theirs') S.shown.add('drop:' + fid);
    const r = await post('resolve', { map: S.map, fid, pick });
    if (r.ok && pick === 'mine') S.shown.add('drop:' + fid);
    return answered(r, fid, (p && p.title) || titleOf(feature(fid), fid), { dialog: false });
  }

  // ── The conflict dialog: both versions side by side ───────────────────────
  function rows(mine, theirs) {
    const fold = id => { if (!id) return '(top level)'; const f = S.idx.get(String(id)); return (f && f.properties && f.properties.title) || id; };
    const where = f => {
      const g = f && f.geometry; if (!g || !g.coordinates) return '';
      if (g.type === 'Point') return g.coordinates.slice(0, 2).map(v => (+v).toFixed(6)).join(', ');
      const n = g.type === 'Polygon' ? (g.coordinates[0] || []).length : g.coordinates.length;
      return (g.type === 'Polygon' ? 'area, ' : 'line, ') + n + ' points (' + JSON.stringify(g.coordinates).length + ' chars)';
    };
    const sw = c => c ? `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:4px;background:#${esc(String(c).replace(/^#/, ''))}"></span>${esc(c)}` : '';
    const F = [['Name', f => esc(f.properties.title)], ['Description', f => esc(f.properties.description)], ['Folder', f => esc(fold(f.properties.folderId))],
      ['Colour', f => sw(f.properties['marker-color'] || f.properties.stroke)], ['Symbol', f => esc(f.properties['marker-symbol'])],
      ['Line width', f => esc(f.properties['stroke-width'])], ['Fill', f => sw(f.properties.fill) + (f.properties['fill-opacity'] != null ? ' ' + esc(f.properties['fill-opacity']) : '')],
      ['Position', f => esc(where(f))]];
    const cell = (f, fn) => f ? (fn(Object.assign({ properties: {} }, f, { properties: f.properties || {} })) || '<span style="opacity:.5">—</span>') : '<i>deleted</i>';
    return F.map(([label, fn]) => {
      const a = cell(mine, fn), b = cell(theirs, fn);
      if (a === b && /—/.test(a)) return '';
      const diff = a !== b;
      return `<tr${diff ? ' class="ctw-diff"' : ''}><th>${label}</th><td>${a}</td><td>${b}</td></tr>`;
    }).join('');
  }
  async function showConflict(fid) {
    const p = S.pending.find(x => x.fid === fid && x.state === 'conflict');
    if (!p || !window._pjApi || !window._pjApi.dialog) return null;
    const when = t => t ? new Date(t).toLocaleString() : '';
    const tu = p.theirs && p.theirs.properties && p.theirs.properties.updated;
    const html = `<style>.ctw-t{border-collapse:collapse;width:100%;font-size:12px}.ctw-t th,.ctw-t td{padding:3px 6px;border-bottom:1px solid rgba(255,255,255,.12);text-align:left;vertical-align:top;word-break:break-word}
      .ctw-t thead th{font-weight:600;opacity:.85}.ctw-t tbody th{font-weight:400;opacity:.7;white-space:nowrap}.ctw-t tr.ctw-diff td{background:rgba(255,200,60,.14)}</style>
      <div style="margin-bottom:6px">“${esc(p.title)}” was changed in CalTopo after you edited it in FLEX. Which one should CalTopo keep? Differences are highlighted.</div>
      <table class="ctw-t ctw-conflict"><thead><tr><th></th><th>Yours (FLEX, ${esc(when(p.at))})</th><th>CalTopo’s${tu ? ' (' + esc(when(tu)) + ')' : ''}</th></tr></thead>
      <tbody>${p.what === 'delete' ? `<tr class="ctw-diff"><th>Your edit</th><td><i>delete it</i></td><td>${p.theirs ? 'keep it, as changed' : '<i>deleted</i>'}</td></tr>` : ''}${rows(p.what === 'delete' ? null : p.mine, p.theirs)}</tbody></table>`;
    const r = await window._pjApi.dialog({ title: 'CalTopo changed meanwhile', html, wide: true,
      buttons: [{ label: 'Decide later', value: null }, { label: 'Keep CalTopo’s', value: 'theirs' }, { label: 'Keep mine', value: 'mine', primary: true }] });
    if (!r || !r.button) return null;
    await resolve(fid, r.button);
    return r.button;
  }

  // ── Reading ───────────────────────────────────────────────────────────────
  function feature(fid) { const f = S.idx.get(String(fid || '').replace(/^ct-/, '')); return f ? JSON.parse(JSON.stringify(f)) : null; }
  function folders() {
    return [...S.idx.values()].filter(f => f.properties && f.properties.class === 'Folder')
      .map(f => ({ id: String(f.id), title: f.properties.title || 'Folder', folderId: f.properties.folderId || null }));
  }
  function status(fid) {
    fid = String(fid || '').replace(/^ct-/, '');
    const p = S.pending.find(x => x.fid === fid);
    if (p) return p.state;
    return S.changes.some(c => c.fid === fid && c.at > S.seen) ? 'changed' : null;
  }
  const pending = () => S.pending.map(p => Object.assign({}, p));
  async function markSeen() {
    if (!S.map) return;
    const r = await post('seen', { map: S.map, at: Math.max(Date.now(), S.newest) });
    if (r.seen) { S.seen = r.seen; fire('flex-caltopo-changed', { changes: S.changes.slice(), seen: S.seen }); }
    return r;
  }

  /** Refresh seconds as FLEX reads them: 0 = off, nothing below 30 s (old projects and sessions had 10 s). */
  const interval = s => { s = +s; return s > 0 ? Math.max(30, s) : 0; };
  window._ctInterval = interval;
  window._ctWrite = {
    available: () => !!S.map, refresh: refreshMap, interval, has: fid => S.idx.has(String(fid || '').replace(/^ct-/, '')), mapId: () => S.map, feature, folders, update, remove, create, status, pending, resolve, showConflict,
    changes: () => S.changes.slice(), seen: () => S.seen, markSeen, offline: () => S.offline, retry, _pulled, _state: state,
  };
})();
